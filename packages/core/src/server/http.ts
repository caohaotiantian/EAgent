/**
 * The control plane: the only externally reachable surface.
 *
 * `node:http` only — no framework — so `@loom/core` stays zero-dependency and the
 * single binary keeps working.
 *
 * Two contracts matter more than the routes:
 *
 *   1. **What is durable at ACK.** A `202` means `run.submitted`, `run.compiled`, and
 *      the resolution manifest are in the journal. It does NOT mean anything ran. A
 *      client that reads 202 as "it happened" will be wrong exactly when it matters.
 *
 *   2. **Reconnect is gap-free.** `GET /runs/:id/events` honours `Last-Event-ID`, and
 *      because `seq` is gap-free per run and the journal is the truth, "did I miss
 *      anything?" is always answerable. The client never has to guess.
 *
 * See design/loom/01-INTERFACES.md D3.17–D3.18.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import type { EventBus } from "../bus.ts";
import { httpStatusFor, isLoomError, toLoomError, CODES, err } from "../errors.ts";
import type { GateId, RunId } from "../ids.ts";
import type { JournalEvent } from "../journal/events.ts";
import type { StateStore } from "../journal/store.ts";
import type { RunGraph } from "../graph/spec.ts";
import type { Engine } from "../run/engine.ts";
import type { GateDecision } from "../run/gates.ts";
import { redactPayload } from "../security/redact.ts";
import { CONSOLE_HTML } from "./console.ts";

export interface ControlPlaneOptions {
  readonly engine: Engine;
  readonly store: StateStore;
  readonly bus?: EventBus;
  /** Bearer token. When absent the server is OPEN — logged loudly at start. */
  readonly token?: string;
  /** Graphs the control plane will accept by name. Compiled ahead of time. */
  readonly graphs?: Readonly<Record<string, RunGraph>>;
  readonly now?: () => number;
  /** Request body cap. Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** How far back a reconnect may replay before getting a snapshot instead. */
  readonly hotWindow?: number;
}

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  handle(ctx: RequestContext): Promise<void>;
}

interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: readonly string[];
  readonly url: URL;
  body(): Promise<unknown>;
}

export class ControlPlane {
  readonly #opts: ControlPlaneOptions;
  readonly #routes: readonly Route[];
  readonly #idempotency = new Map<string, unknown>();
  #server: Server | undefined;

  constructor(opts: ControlPlaneOptions) {
    this.#opts = opts;
    this.#routes = this.#buildRoutes();
  }

  async listen(port: number, host = "127.0.0.1"): Promise<{ port: number }> {
    const server = createServer((req, res) => void this.#dispatch(req, res));
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    const address = server.address();
    return { port: typeof address === "object" && address !== null ? address.port : port };
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = undefined;
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    try {
      if (url.pathname !== "/health" && !this.#authorized(req)) {
        // 401 before routing, so an unauthenticated caller cannot even probe which
        // routes exist.
        send(res, 401, { error: { code: "E_NOT_AUTHORIZED", message: "missing or invalid bearer token" } });
        return;
      }

      for (const route of this.#routes) {
        if (req.method !== route.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (match === null) continue;
        await route.handle({
          req,
          res,
          url,
          params: match.slice(1),
          body: () => this.#readBody(req),
        });
        return;
      }
      send(res, 404, { error: { code: "E_RUN_NOT_FOUND", message: `no route for ${req.method} ${url.pathname}` } });
    } catch (e) {
      const le = toLoomError(e);
      if (!res.headersSent) {
        send(res, httpStatusFor(le), { error: le.toJSON() });
      } else {
        res.end();
      }
    }
  }

  /** Constant-time compare, so the token cannot be recovered by timing the 401. */
  #authorized(req: IncomingMessage): boolean {
    const expected = this.#opts.token;
    if (expected === undefined) return true;
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented.padEnd(expected.length, "\0").slice(0, expected.length));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) && presented.length === expected.length;
  }

  async #readBody(req: IncomingMessage): Promise<unknown> {
    const max = this.#opts.maxBodyBytes ?? 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `request body exceeds ${max} bytes`);
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, "request body is not valid JSON");
    }
  }

  // ── routes ────────────────────────────────────────────────────────────────

  #buildRoutes(): readonly Route[] {
    const { engine, store } = this.#opts;

    return [
      {
        method: "GET",
        pattern: /^\/$/,
        handle: async ({ res }) => {
          // The console ships inside the binary: one document, no bundler, no build
          // step. An approval queue nobody can reach is an oversight model that does
          // not exist.
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(CONSOLE_HTML);
        },
      },

      {
        method: "GET",
        pattern: /^\/graphs$/,
        handle: async ({ res }) => {
          send(res, 200, {
            graphs: Object.entries(this.#opts.graphs ?? {}).map(([name, g]) => ({
              name,
              graphHash: g.graphHash,
              nodes: g.spec.nodes.length,
              edges: g.spec.edges.length,
            })),
          });
        },
      },

      {
        method: "GET",
        pattern: /^\/graphs\/by-hash\/([^/]+)$/,
        handle: async ({ res, params }) => {
          const hash = decodeURIComponent(params[0]!);
          const graph = Object.values(this.#opts.graphs ?? {}).find((g) => g.graphHash === hash);
          if (graph === undefined) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no graph with hash ${hash}`);
          // Structure ONCE, keyed by hash: the client caches it and only deltas
          // stream afterwards. `plans` carries the compiler's layoutRank, so the
          // browser never runs a graph layout.
          send(res, 200, {
            graphHash: graph.graphHash,
            nodes: graph.spec.nodes.map((n) => ({ id: n.id, type: n.type })),
            edges: graph.spec.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind })),
            plans: Object.fromEntries(
              Object.entries(graph.plans).map(([id, p]) => [id, { layoutRank: p.layoutRank, maxInstances: p.maxInstances, posture: p.posture }]),
            ),
          });
        },
      },

      {
        method: "GET",
        pattern: /^\/health$/,
        handle: async ({ res }) => {
          send(res, 200, {
            ok: true,
            auth: this.#opts.token === undefined ? "open" : "required",
            graphs: Object.keys(this.#opts.graphs ?? {}),
          });
        },
      },

      {
        method: "POST",
        pattern: /^\/runs$/,
        handle: async ({ req, res, body }) => {
          const input = (await body()) as { workflow?: string; inputs?: Record<string, unknown> };
          const key = header(req, "idempotency-key");
          if (key !== undefined) {
            const seen = this.#idempotency.get(key);
            // A duplicate submit returns the ORIGINAL runId and creates nothing.
            if (seen !== undefined) {
              send(res, 202, seen);
              return;
            }
          }

          const name = input.workflow ?? "";
          const graph = this.#opts.graphs?.[name];
          if (graph === undefined) {
            throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no compiled graph named "${name}"`);
          }

          const runId = await engine.submit({
            graph,
            inputs: input.inputs ?? {},
            workflow: name,
            ...(key === undefined ? {} : { idempotencyKey: key }),
          });
          // 202, and the body says exactly what is durable — see the module docstring.
          const accepted = {
            runId,
            graphHash: graph.graphHash,
            durable: ["run.submitted", "run.compiled"],
            note: "accepted means this WILL run, not that it HAS run",
          };
          if (key !== undefined) this.#idempotency.set(key, accepted);
          send(res, 202, accepted);

          // Drive it after responding: the client is not made to wait on execution.
          void engine.advance(runId).catch(() => undefined);
        },
      },

      {
        method: "GET",
        pattern: /^\/runs$/,
        handle: async ({ res, url }) => {
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const runs = await store.listRuns(Number.isFinite(limit) ? limit : 50);
          send(res, 200, { runs });
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)$/,
        handle: async ({ res, params }) => {
          const p = await engine.projection(params[0] as RunId);
          if (p === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${params[0]} not found`);
          send(res, 200, summarise(p));
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/events$/,
        handle: async (ctx) => this.#streamEvents(ctx),
      },

      {
        method: "POST",
        pattern: /^\/runs\/([^/]+)\/commands$/,
        handle: async ({ res, params, body }) => {
          const runId = params[0] as RunId;
          const cmd = (await body()) as { kind?: string; reason?: string; atSeq?: number };
          switch (cmd.kind) {
            case "cancel":
              send(res, 200, summarise(await engine.cancel(runId, cmd.reason ?? "operator")));
              return;
            case "rewind": {
              if (typeof cmd.atSeq !== "number") {
                throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, "rewind requires atSeq");
              }
              send(res, 200, summarise(await engine.rewind(runId, cmd.atSeq, cmd.reason ?? "operator")));
              return;
            }
            case "advance":
              send(res, 200, summarise(await engine.advance(runId)));
              return;
            default:
              throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `unknown command "${String(cmd.kind)}"`);
          }
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/gates$/,
        handle: async ({ res, params }) => {
          const runId = params[0] as RunId;
          const p = await engine.projection(runId);
          if (p === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          // Joined with the rendered payload where the broker still has it. A queue that
          // lists gates without saying what each one asks is a queue people clear rather
          // than read — and for a `subgraph` gate the question is in another run entirely.
          const detailed = await engine.openGates(runId).catch(() => []);
          const byId = new Map(detailed.map((g) => [g.gateId, g]));
          send(res, 200, {
            gates: Object.values(p.gates)
              .filter((g) => g.state === "open")
              .map((g) => ({ ...g, payload: byId.get(g.gateId)?.payload, deadline: byId.get(g.gateId)?.deadline })),
          });
        },
      },

      {
        method: "POST",
        pattern: /^\/runs\/([^/]+)\/gates\/([^/]+)$/,
        handle: async ({ req, res, params, body }) => {
          const decision = (await body()) as { decision?: GateDecision; actor?: string };
          if (decision.decision === undefined) {
            throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, "a gate resolution requires a decision");
          }
          const p = await engine.resolveGate(params[0] as RunId, {
            gateId: params[1] as GateId,
            decision: decision.decision,
            actor: { kind: "human", subject: decision.actor ?? "unknown", via: "api" },
            idempotencyKey: header(req, "idempotency-key") ?? `${params[1]}:${decision.actor ?? "unknown"}`,
          });
          send(res, 200, summarise(p));
        },
      },
    ];
  }

  /**
   * SSE with gap-free reconnect.
   *
   * `Last-Event-ID` inside the hot window replays from `seq+1`; outside it, the client
   * gets one `snapshot` frame and then the live tail. Either way the client knows
   * whether it is looking at a continuation or a fresh baseline.
   */
  async #streamEvents(ctx: RequestContext): Promise<void> {
    const { res, req, params } = ctx;
    const runId = params[0] as RunId;
    const bus = this.#opts.bus;

    const lastHeader = header(req, "last-event-id") ?? ctx.url.searchParams.get("lastEventId") ?? undefined;
    const lastSeq = lastHeader === undefined ? 0 : Number(lastHeader);
    const head = await this.#opts.store.head(runId);
    const hot = this.#opts.hotWindow ?? 10_000;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const write = (event: string, id: number | undefined, data: unknown): void => {
      if (id !== undefined) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (!Number.isFinite(lastSeq) || head - lastSeq > hot) {
      const p = await this.#opts.engine.projection(runId);
      if (p !== undefined) write("snapshot", p.seq, summarise(p));
    } else {
      for await (const e of this.#opts.store.read(runId, lastSeq + 1)) write("event", e.seq, frame(e));
    }

    if (bus === undefined) {
      res.end();
      return;
    }

    const sub = bus.subscribe({ runId }, { queueSize: 1024, onOverflow: "drop_oldest" });
    const stop = (): void => sub.dispose();
    req.on("close", stop);

    try {
      for await (const e of sub) {
        if (e.seq <= lastSeq) continue;
        write("event", e.seq, frame(e));
        if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") break;
      }
    } finally {
      sub.dispose();
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * The wire shape of an event, redacted on the way out.
 *
 * The journal keeps real values — it is the source of truth, and redacting it would
 * corrupt channel state. Anything crossing the process boundary is redacted using the
 * event's own declared classification.
 */
function frame(e: JournalEvent): unknown {
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    taskId: e.taskId,
    actor: e.actor,
    payload: redactPayload(e.payload, e.classification),
  };
}

/**
 * A projection trimmed for the wire.
 *
 * Task and gate maps are sent as arrays because a 500-branch run's task map is the
 * bulk of the payload and the client renders it as a list anyway.
 */
function summarise(p: import("../run/projection.ts").RunProjection): unknown {
  return {
    runId: p.runId,
    status: p.status,
    seq: p.seq,
    graphHash: p.graphHash,
    posture: p.posture,
    // Channel values reach a browser here, so they are swept on the way out. The
    // per-channel classification lives in the GraphSpec; without it in hand the
    // conservative `internal` sweep still catches credential shapes in model output.
    channels: redactPayload(p.channels, "internal"),
    outputs: redactPayload(p.outputs, "internal"),
    usage: p.usage,
    reservedUsd: p.reservedUsd,
    budgetExhausted: p.budgetExhausted,
    unknownEffects: p.unknownEffects,
    error: p.error,
    tasks: Object.values(p.tasks).map((t) => ({
      taskId: t.taskId,
      nodeId: t.nodeId,
      state: t.state,
      attempt: t.attempt,
      branch: t.branch.segments.map((s) => `${s.edgeId}[${s.index}]`).join("/"),
      take: t.take,
      error: t.error,
    })),
    gates: Object.values(p.gates),
  };
}

/** Convenience for tests and the CLI. */
export async function startControlPlane(opts: ControlPlaneOptions, port = 0): Promise<{ plane: ControlPlane; port: number }> {
  const plane = new ControlPlane(opts);
  const { port: bound } = await plane.listen(port);
  if (opts.token === undefined) {
    // Loud, because an open control plane can start runs that spend money.
    console.error("[loom] control plane started with NO TOKEN — every caller is authorized");
  }
  return { plane, port: bound };
}
