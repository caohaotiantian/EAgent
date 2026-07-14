#!/usr/bin/env node
/**
 * The HTTP server front end.
 *
 * A second host (alongside the terminal CLI) that exposes the agent over HTTP
 * for programmatic embedding. It is intentionally tiny — `node:http` only, no
 * framework — and reuses `createAgentHost`, so it loads exactly the same
 * extensions as the CLI.
 *
 *   GET    /health          → { ok, model, extensions, sessions, auth }
 *   POST   /run             → streams lifecycle events as JSONL (one per line)
 *                             body: { input: string, session?: string }
 *   POST   /answer          → answer a pending elicitation mid-turn
 *                             body: { id: number, answer: string }
 *   GET    /sessions/:id     → a session's usage + cost summary
 *   DELETE /sessions/:id     → forget a conversation
 *
 * A `session` id makes `/run` calls accumulate into one conversation; without
 * it, each call is a fresh, stateless turn. The agent runs one turn at a time
 * (a second concurrent `/run` gets 409) — a deliberate simplicity for a minimal
 * server; front a pool of these for real concurrency.
 *
 * ELICITATION (the `ask` extension over HTTP). When the model calls
 * `ask_user_question` mid-turn it reaches a server-side `UI.ask`, which pauses
 * the turn and emits an `{ type: "action_required", id, question, options }`
 * line on the open `/run` stream. The client answers out-of-band with
 * `POST /answer { id, answer }` (same auth as `/run`, NOT blocked by the
 * single-flight lock), and the turn resumes with that answer fed back to the
 * model. An unanswered ask falls back (proceed-with-assumption) on a bounded
 * timeout (`askTimeoutMs`) or on client disconnect, so a turn never hangs.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Agent } from "./kernel/agent.js";
import type { Config } from "./kernel/store.js";
import type { Logger, UI } from "./kernel/types.js";
import { createAgentHost, loadEnvFile, type AgentHostOptions } from "./host.js";
import { COST_ACCESSOR_KEY } from "./extensions/cost.js";
import { eventToJsonl, wireJsonl } from "./jsonl.js";

export interface ServeOptions extends AgentHostOptions {
  port?: number;
  /** Bind address. Defaults to `EAGENT_HOST` or `127.0.0.1` (loopback). A
   *  non-loopback bind with an empty token is refused (fail-closed) — see the
   *  guard in `createHttpServer`. */
  host?: string;
  /** Require `Authorization: Bearer <token>` on mutating routes. Defaults to
   *  `EAGENT_TOKEN`; when unset, the server is open (suitable only for trusted
   *  local use — see SECURITY.md). */
  token?: string;
  /** Max request body size in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /** How long (ms) a mid-turn `ask_user_question` waits for `POST /answer`
   *  before falling back to proceed-with-assumption. Default 120 s; a tiny
   *  value keeps tests fast. */
  askTimeoutMs?: number;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_ASK_TIMEOUT = 120_000;

export interface HttpServer {
  server: ReturnType<typeof createServer>;
  agent: Agent;
  extensions: string[];
  model: string;
  /** The resolved bind host (`server.host` config / `EAGENT_HOST`, else loopback). */
  host: string;
  /** Tear down the extension host (call on shutdown). */
  close(): Promise<void>;
}

/**
 * The per-turn elicitation channel shared by `streamRun` (producer) and the
 * `/answer` route (consumer). At most one turn runs at a time (the single-flight
 * lock), so a single mutable holder is enough: `streamRun` installs an `ask`
 * implementation at turn start and clears it in `finally`; `serverUI.ask`
 * delegates to whatever is installed, or returns null (→ the ask tool's
 * proceed-with-assumption fallback) when no turn is streaming.
 *
 * A pending ask is keyed by a monotonic id (no clock/randomness); its resolver
 * lives in `pending` until `/answer`, a timeout, or a disconnect settles it.
 */
interface Elicitation {
  ask: ((question: string, options?: string[]) => Promise<string | null>) | null;
  pending: Map<number, (answer: string | null) => void>;
  nextId: number;
}

/** Build the agent host and return a configured (but not yet listening) server. */
export async function createHttpServer(opts: ServeOptions = {}): Promise<HttpServer> {
  const logger: Logger = opts.logger ?? {
    debug: () => {},
    info: (...a) => console.error("·", ...a),
    warn: (...a) => console.error("!", ...a),
    error: (...a) => console.error("✗", ...a),
  };

  // The mid-turn elicitation channel (see the `Elicitation` doc). `serverUI.ask`
  // delegates to the turn-installed sink so the `ask` extension's conditional
  // grant of `ui:ask` fires (its activation sees a function-valued `ask`) and
  // the model actually reaches a human over HTTP instead of the fallback.
  const elicit: Elicitation = { ask: null, pending: new Map(), nextId: 1 };
  const serverUI: UI = {
    // Preserve the headless fail-safe: a guard prompt the server can't surface
    // interactively (write-guard, secret-guard, flow-guard, risk-guard,
    // bash-policy, circuit-breaker, …) DENIES rather than auto-approves — exactly
    // what the prior `defaultUI` (agent.ts:412, `confirm: async () => false`) did
    // before this server set its own `ui`. Only `ask` is new; `confirm` must not
    // become fail-open just because we now supply a UI.
    confirm: async () => false,
    notify: () => {},
    ask: (question, options) => (elicit.ask ? elicit.ask(question, options) : Promise.resolve(null)),
  };

  const built = await createAgentHost({ ...opts, ui: serverUI, logger, yolo: opts.yolo ?? true });

  const host = opts.host ?? built.config.string("server.host") ?? "127.0.0.1";
  const token = opts.token ?? process.env.EAGENT_TOKEN ?? "";

  // Fail-closed on the dangerous combination: a non-loopback bind exposes the
  // server off-box, and with an empty token /run is unauthenticated AND runs
  // tools with full capabilities under yolo. Refuse to start rather than warn.
  // Guarded here (before any listen) so the check is pre-bind and unit-testable.
  if (!isLoopback(host) && !token) {
    // Tear down the just-built host so the refuse path leaks no activated
    // extensions (the host must be built first to resolve `server.host` from config).
    await built.host.dispose();
    throw new Error(
      `refusing to bind ${host} without EAGENT_TOKEN: a non-loopback bind with no token exposes an ` +
        "unauthenticated, full-capability agent. Set EAGENT_TOKEN, or bind a loopback address (127.0.0.1).",
    );
  }

  await built.agent.hooks.emit("session_start", {});

  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const askTimeoutMs = opts.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT;

  // No token means /run and DELETE /sessions are unauthenticated, and the agent
  // is built with yolo (every capability auto-granted, including shell:exec).
  // That is fine for trusted localhost use but a sharp edge if exposed, so warn
  // loudly. `main()` binds 127.0.0.1 by default to keep it off-box.
  if (!token) {
    logger.warn(
      "EAGENT_TOKEN not set — /run and DELETE /sessions are UNAUTHENTICATED and run tools with full capabilities. " +
        "Set EAGENT_TOKEN, and do not expose this server beyond localhost.",
    );
  }

  // One Agent per conversation (its own transcript/usage/model), all sharing the
  // host's registries/hooks/capabilities so every extension governs every session.
  const sessions = new Map<string, Agent>();
  let busy = false;

  // The cross-boundary cost read: the `cost` extension publishes a
  // `costOf(agent): number` accessor into its namespaced store at activation
  // (usage lives natively on the Agent; cost does not). Resolved live so a reload
  // republishes cleanly; falls back to 0 when cost is disabled/absent.
  const costUsdFor = (agent: Agent): number => {
    const fn = built.host.storeFor("cost").get<(a: Agent) => number>(COST_ACCESSOR_KEY);
    return typeof fn === "function" ? fn(agent) : 0;
  };

  const server = createServer((req, res) => {
    // Absorb an OutgoingMessage 'error' (a socket reset — ECONNRESET/EPIPE) on
    // any response, streaming or single-write. Without a listener it throws as an
    // uncaught exception and takes the whole process down; route(...).catch only
    // catches promise rejections, not EventEmitter errors.
    res.on("error", () => {});
    route(req, res, built.agent, built.host.list(), sessions, {
      get busy() {
        return busy;
      },
      set busy(v) {
        busy = v;
      },
    }, { token, maxBody }, elicit, askTimeoutMs, built.config, costUsdFor).catch((err) =>
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }),
    );
  });

  // Idempotent teardown: a second close (e.g. a second signal) must not re-emit
  // session_shutdown to handlers that already tore down.
  let closed = false;
  return {
    server,
    agent: built.agent,
    extensions: built.host.list(),
    model: built.model,
    host,
    close: async () => {
      if (closed) return;
      closed = true;
      await built.host.dispose();
    },
  };
}

interface Lock {
  busy: boolean;
}

interface Security {
  token: string;
  maxBody: number;
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  template: Agent,
  extensions: string[],
  sessions: Map<string, Agent>,
  lock: Lock,
  security: Security,
  elicit: Elicitation,
  askTimeoutMs: number,
  config: Config,
  costUsdFor: (agent: Agent) => number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // /health is always open (for liveness probes); everything else needs auth
  // when a token is configured.
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model: template.model, extensions, sessions: sessions.size, auth: security.token ? "required" : "open" });
    return;
  }

  if (security.token && !authorized(req, security.token)) {
    sendJson(res, 401, { error: "unauthorized; provide Authorization: Bearer <token>" });
    return;
  }

  // Per-tenant observability: a session's own usage + cost summary. Usage lives
  // natively on the session Agent; cost is read through the extension-published
  // accessor (`costUsdFor`). An unknown session id is a clean 404.
  if (req.method === "GET" && url.pathname.startsWith("/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
    const agent = sessions.get(id);
    if (!agent) {
      sendJson(res, 404, { error: "unknown session", session: id });
      return;
    }
    sendJson(res, 200, { session: id, usage: agent.usage, costUsd: costUsdFor(agent) });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
    const existed = sessions.delete(id);
    sendJson(res, existed ? 200 : 404, { deleted: existed, session: id });
    return;
  }

  // Answer a mid-turn elicitation. Deliberately NOT behind the single-flight
  // lock: it must succeed *while* a `/run` turn is paused on `ask`. Resolving an
  // unknown id is a 404 (the ask already timed out, was answered, or the turn
  // ended) rather than an error — the client can simply re-read the stream.
  if (req.method === "POST" && url.pathname === "/answer") {
    let body: string;
    try {
      body = await readBody(req, security.maxBody);
    } catch {
      sendJson(res, 413, { error: `request body exceeds ${security.maxBody} bytes` });
      return;
    }
    let id: number;
    let answer: string;
    try {
      const parsed = JSON.parse(body) as { id?: unknown; answer?: unknown };
      id = Number(parsed.id);
      answer = String(parsed.answer ?? "");
    } catch {
      sendJson(res, 400, { error: "invalid JSON body; expected { id: number, answer: string }" });
      return;
    }
    const resolve = Number.isInteger(id) ? elicit.pending.get(id) : undefined;
    if (!resolve) {
      sendJson(res, 404, { resolved: false, error: "no pending elicitation with that id" });
      return;
    }
    resolve(answer); // unblocks the awaiting ask; it deletes itself from `pending`
    sendJson(res, 200, { resolved: true, id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    let body: string;
    try {
      body = await readBody(req, security.maxBody);
    } catch {
      sendJson(res, 413, { error: `request body exceeds ${security.maxBody} bytes` });
      return;
    }
    let input: string;
    let session: string | undefined;
    try {
      const parsed = JSON.parse(body) as { input?: unknown; session?: unknown };
      input = String(parsed.input ?? "");
      session = parsed.session === undefined ? undefined : String(parsed.session);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body; expected { input: string, session?: string }" });
      return;
    }
    if (!input) {
      sendJson(res, 400, { error: "missing 'input'" });
      return;
    }
    if (lock.busy) {
      sendJson(res, 409, { error: "agent is busy; retry shortly" });
      return;
    }
    lock.busy = true;
    try {
      await streamRun(res, template, input, sessions, session, elicit, askTimeoutMs, config);
    } finally {
      lock.busy = false;
    }
    return;
  }

  sendJson(res, 404, {
    error: "not found",
    routes: ["GET /health", "POST /run", "POST /answer", "GET /sessions/:id", "DELETE /sessions/:id"],
  });
}

/**
 * Build a fresh per-session Agent: it SHARES the host's registries/hooks/
 * capabilities/ui/logger (so every extension governs every session) but carries
 * its OWN transcript/usage and a fresh copy of the run config
 * (model/systemPrompt/thinking/maxTurns/provider/maxConcurrency).
 */
function makeSessionAgent(template: Agent): Agent {
  return new Agent({
    hooks: template.hooks,
    tools: template.tools,
    providers: template.providers,
    capabilities: template.capabilities,
    ui: template.ui,
    logger: template.logger,
    model: template.model,
    provider: template.providerName,
    systemPrompt: template.systemPrompt,
    thinking: template.thinking,
    maxTurns: template.maxTurns,
    maxConcurrency: template.maxConcurrency,
  });
}

/** Run one turn, streaming lifecycle events to the client as JSONL. */
async function streamRun(
  res: ServerResponse,
  template: Agent,
  input: string,
  sessions: Map<string, Agent>,
  session: string | undefined,
  elicit: Elicitation,
  askTimeoutMs: number,
  config: Config,
): Promise<void> {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  let closed = false;
  const write = (obj: unknown): void => {
    if (closed) return; // don't write to a destroyed socket
    res.write(JSON.stringify(obj) + "\n");
  };

  // Install this turn's elicitation sink. A model `ask_user_question` reaches
  // serverUI.ask → here: we emit an `action_required` line, register a resolver
  // under a fresh id, and return a Promise that the client settles via
  // `POST /answer` — or that a bounded timeout / disconnect settles with null
  // (→ the ask tool's proceed-with-assumption fallback), so the turn never hangs.
  elicit.ask = (question, options) =>
    new Promise<string | null>((resolve) => {
      const id = elicit.nextId++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (answer: string | null): void => {
        if (!elicit.pending.has(id)) return; // already settled (answer/timeout/close)
        elicit.pending.delete(id);
        if (timer) clearTimeout(timer);
        resolve(answer);
      };
      elicit.pending.set(id, settle);
      timer = setTimeout(() => settle(null), askTimeoutMs);
      if (typeof timer.unref === "function") timer.unref(); // don't keep the event loop alive
      write(eventToJsonl("action_required", { id, question, options }));
    });

  // Settle every outstanding ask for this turn with null (fallback) and drop the
  // sink. Called from disconnect and from the finally so no resolver leaks past
  // the turn and a later `/answer` for a stale id is a clean 404.
  const drainElicitations = (): void => {
    for (const settle of [...elicit.pending.values()]) settle(null);
    elicit.pending.clear();
    elicit.ask = null;
  };

  // The session's own Agent (own transcript/usage): reuse the pooled one, else
  // build a fresh one from the host template. A sessionless /run runs on a
  // throwaway that is never pooled. `existed` gates whether a brand-new session
  // whose only turn aborts is worth persisting (it is not — see the rollback below).
  const existed = session !== undefined && sessions.has(session);
  const agent = (session !== undefined ? sessions.get(session) : undefined) ?? makeSessionAgent(template);

  // If the client disconnects mid-turn, abort THIS session's agent so it stops
  // streaming to a dead socket (and frees the single-flight lock) instead of running
  // the whole turn to completion and wasting tokens/side effects. Also release any
  // ask the turn is blocked on, so the agent loop can unwind instead of hanging.
  const onClose = (): void => {
    closed = true;
    drainElicitations();
    if (agent.running) agent.stop();
  };
  res.on("close", onClose);
  res.on("error", onClose); // a mid-stream socket error runs the same teardown

  // Subscribe inside the try so a setup-window throw streams a {type:"error"} line
  // and hits the finally, not a silent 200 with no terminal line. `subs` is declared
  // out here so the finally can dispose it.
  let subs: { dispose(): void }[] = [];
  // The kernel emits the `error` hook on both the maxTurns exhaustion path (which
  // does NOT throw — reason stays "stop") and a real run failure (which then
  // throws). Subscribing here — as the CLI does — emits the JSONL `error` line for
  // the maxTurns case the server used to drop; `errorEmitted` then dedupes so a
  // throw already surfaced via the hook is not written twice by the catch.
  let errorEmitted = false;
  try {
    // A transient pre-turn snapshot for the danglingUser rollback ONLY (NOT the
    // removed per-session state pool): `agent.run` pushes the user message
    // unconditionally, and an abort during the first stream breaks with reason "stop"
    // before any assistant push — baking a trailing bare `user` message into the
    // persistent Agent. Agent has no pop, so capture here and restore below.
    const pre = agent.snapshot();

    subs = wireJsonl(write, agent);
    subs.push(
      agent.hooks.on("error", ({ error, where }) => {
        errorEmitted = true;
        write(eventToJsonl("error", { where, message: error instanceof Error ? error.message : String(error) }));
      }),
    );
    const { reason } = await agent.run(input);
    // Discard a trailing bare `user` turn left by an aborted run: restoring the
    // pre-turn snapshot rolls it back so the next /run does not append a second
    // consecutive user message on the persistent Agent. `agent.usage` is this
    // session's own cumulative (its turns), not process-lifetime.
    const msgs = agent.messages;
    const danglingUser = msgs.length > 0 && msgs[msgs.length - 1]!.role === "user";
    if (danglingUser) agent.restore(pre);
    // Persist the session Agent (LRU touch to newest), unless this is a brand-new
    // session whose only turn aborted to empty — that phantom carries no state, so
    // it is dropped (an existing session stays, rolled back to its prior state).
    if (session !== undefined && (!danglingUser || existed)) {
      // LRU touch: delete+set moves the just-run session to newest, then evict the
      // oldest keys past the cap. cap===0 skips the loop entirely (unbounded).
      sessions.delete(session);
      sessions.set(session, agent);
      const cap = maxSessions(config);
      while (cap > 0 && sessions.size > cap) sessions.delete(sessions.keys().next().value as string);
    }
    // Dual-emit during the deprecation window: the frozen legacy `done` first, then
    // the canonical `agent_end` last, so a consumer reading "last line = terminal"
    // gets `agent_end` while one scanning for `done` still finds it.
    write({ type: "done", reason, session, usage: agent.usage });
    write(eventToJsonl("agent_end", { reason, usage: agent.usage, session }));
  } catch (err) {
    // A setup-window throw (e.g. `agent.snapshot`) never reaches the kernel `error`
    // hook, so emit it here. A throw from `agent.run` already surfaced via the hook
    // above (errorEmitted), so skip the duplicate.
    if (!errorEmitted) {
      write(eventToJsonl("error", { where: "agent.run", message: err instanceof Error ? err.message : String(err) }));
    }
  } finally {
    drainElicitations(); // clear the sink + any leftover resolver before the next turn
    res.off("close", onClose);
    res.off("error", onClose);
    for (const s of subs) s.dispose();
    if (!closed) res.end();
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    let tooBig = false;
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (tooBig) return; // stop accumulating, but keep draining the socket
      size += Buffer.byteLength(c);
      if (size > maxBytes) {
        tooBig = true;
        reject(new Error("body too large"));
        return;
      }
      data += c;
    });
    req.on("end", () => {
      if (!tooBig) resolve(data);
    });
    req.on("error", reject);
  });
}

/**
 * Constant-time bearer check. Both sides are hashed to a fixed-length digest
 * and compared with `timingSafeEqual`, so neither the token's length nor its
 * contents leak through comparison timing.
 */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = createHash("sha256").update(header.slice(prefix.length)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(provided, expected);
}

/**
 * The sessions-map cap from `EAGENT_MAX_SESSIONS`. On by default at 1000; an
 * explicit `0` disables it (unbounded). Empty / whitespace / non-numeric /
 * negative / non-integer all fall back to 1000 — the empty-string guard is
 * load-bearing: `loadEnvFile` sets a bare `EAGENT_MAX_SESSIONS=` line to `""`
 * and `Number("") === 0`, so without it an unfilled placeholder would wrongly
 * disable the cap.
 */
export function maxSessions(config: Config): number {
  const raw = config.string("server.maxSessions")?.trim();
  if (!raw) return 1000;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1000;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return; // the stream already owns this response; never re-writeHead
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A loopback bind address (off-box unreachable): 127.0.0.1, ::1, or localhost. */
function isLoopback(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host.trim().toLowerCase());
}

async function main(): Promise<void> {
  loadEnvFile();
  const port = Number(process.env.PORT ?? 8787);
  // Bind loopback by default so an unauthenticated server is not reachable
  // off-box. Set `server.host` (env EAGENT_HOST=0.0.0.0) to expose it deliberately
  // (use a token). createHttpServer resolves the host from config; reuse it here.
  const http = await createHttpServer({ port });
  try {
    http.server.listen(port, http.host, () => {
      console.error(`eagent server on http://${http.host}:${port} (model=${http.model}, ${http.extensions.length} extensions)`);
      console.error(`  extension state is process-scoped; run one process per tenant/trust boundary for isolation (see SECURITY.md)`);
    });

    // Graceful shutdown: stop accepting connections, tear down the host, exit.
    // The shuttingDown guard makes a second signal a no-op so it can't re-enter
    // server.close() / race process.exit before the first dispose completes.
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`\n${signal} received, shutting down…`);
      await new Promise<void>((resolve) => http.server.close(() => resolve()));
      await http.close();
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (err) {
    // A throw after the host is built (e.g. listen setup) must still dispose it
    // so session_shutdown fires and stdio-MCP children don't orphan.
    await http.close();
    throw err;
  }
}

// Run as a CLI only when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
