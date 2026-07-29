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
 *   GET    /sessions         → list live sessions [{ id, running, usage, costUsd }]
 *   GET    /sessions/:id     → usage + cost + messages (transcript; loaded from disk if needed)
 *   GET    /sessions/:id/events → a per-session live SSE feed (tenant-isolated)
 *   POST   /sessions/:id/stop   → abort a running turn (agent.stop())
 *   GET    /events           → a global SSE feed; each frame tagged with its session
 *   DELETE /sessions/:id     → forget a conversation
 *
 * The monitor endpoints (`/sessions` list, the two SSE feeds, `/sessions/:id/stop`)
 * re-emit the shared hooks bus read-only; the per-session feed filters by run-tree
 * root agent (`currentRootAgent() === agent`) so a session's feed carries only its
 * own events (the same tenant-isolation guard `/run` uses).
 *
 * A `session` id makes `/run` calls accumulate into one conversation; without
 * it, each call is a fresh, stateless turn. Turns from DIFFERENT sessions run
 * concurrently, each on its own `Agent` with per-session extension state; two
 * `/run`s for the SAME session serialize — the second gets 409 while the first
 * is in flight — since they would otherwise alias one Agent.
 *
 * ELICITATION (the `ask` extension over HTTP). When the model calls
 * `ask_user_question` mid-turn it reaches a server-side `UI.ask`, which pauses
 * the turn and emits an `{ type: "action_required", id, question, options }`
 * line on the open `/run` stream. The client answers out-of-band with
 * `POST /answer { id, answer }` (same auth as `/run`, NOT blocked by the
 * per-session lock), and the turn resumes with that answer fed back to the
 * model. An unanswered ask falls back (proceed-with-assumption) on a bounded
 * timeout (`askTimeoutMs`) or on client disconnect, so a turn never hangs.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Agent, currentRootAgent } from "./kernel/agent.js";
import type { Config } from "./kernel/store.js";
import type { Logger, Message, UI, Usage } from "./kernel/types.js";
import { createAgentHost, loadEnvFile, type AgentHostOptions } from "./host.js";
import { COST_ACCESSOR_KEY } from "./extensions/cost.js";
import { JOBS_ACCESSOR_KEY } from "./extensions/subagent-jobs.js";
import { eventToJsonl, wireJsonl, type JsonlEvent } from "./jsonl.js";
import {
  deleteSessionFile,
  listDiskSessionSummaries,
  readSessionFile,
  resolveSessionsDir,
  writeSessionFile,
} from "./session-disk.js";

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
  /** Directory for durable HTTP session transcripts. Defaults to
   *  `EAGENT_SESSIONS_DIR` or `~/.eagent/http-sessions`. */
  sessionsDir?: string;
  /** When false, skip disk read/write (tests that only care about memory). Default true. */
  persistSessions?: boolean;
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

/** A turn's ask sink: emit `action_required` and resolve when the client answers
 *  (or on timeout/disconnect). One per in-flight turn, keyed by its session root. */
type AskSink = (question: string, options?: string[]) => Promise<string | null>;

/**
 * The elicitation channel shared by `streamRun` (producer) and the `/answer`
 * route (consumer). Turns from different sessions run concurrently, so the ask
 * sink is routed PER session ROOT: `streamRun` installs its sink under its root
 * Agent and clears it in `finally`; `serverUI.ask` resolves the sink for the
 * currently-executing turn via `currentRootAgent()` (a fork's ask reaches its
 * session's stream, and two sessions never overwrite each other's sink), or
 * returns null (→ the ask tool's proceed-with-assumption) when none is installed.
 *
 * A pending ask is keyed by a process-global monotonic id (no clock/randomness);
 * its resolver lives in `pending` until `/answer`, a timeout, or a disconnect
 * settles it. Each turn tracks its own ask ids so its `finally` drains only its
 * own — one session's turn end can't cancel another's pending ask.
 */
interface Elicitation {
  sinks: Map<Agent, AskSink>;
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
  const elicit: Elicitation = { sinks: new Map(), pending: new Map(), nextId: 1 };
  const serverUI: UI = {
    // Preserve the headless fail-safe: a guard prompt the server can't surface
    // interactively (write-guard, secret-guard, flow-guard, risk-guard,
    // bash-policy, circuit-breaker, …) DENIES rather than auto-approves — exactly
    // what the prior `defaultUI` (agent.ts:412, `confirm: async () => false`) did
    // before this server set its own `ui`. Only `ask` is new; `confirm` must not
    // become fail-open just because we now supply a UI.
    confirm: async () => false,
    notify: () => {},
    ask: (question, options) => {
      const root = currentRootAgent();
      const sink = root ? elicit.sinks.get(root) : undefined;
      return sink ? sink(question, options) : Promise.resolve(null);
    },
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
  // Persist by default outside the node:test runner (NODE_TEST_CONTEXT). Unit
  // tests that want disk round-trips pass sessionsDir / persistSessions: true.
  const underTest = process.env.NODE_TEST_CONTEXT !== undefined;
  const persistSessions = opts.persistSessions ?? !underTest;
  const sessionsDir = persistSessions
    ? resolveSessionsDir(opts.sessionsDir ?? process.env.EAGENT_SESSIONS_DIR)
    : undefined;

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
  // The per-session lock: session ids with a turn currently in flight. A second
  // /run for a session already here gets 409; different sessions (and sessionless
  // runs) proceed concurrently. Removed in the request's `finally`.
  const running = new Set<string>();
  // Session-root Agents built for a sessionless /run (no id, never pooled): a
  // launch_job from one is refused, since there is no id to ever query its
  // detached background child against.
  const sessionlessRoots = new WeakSet<Agent>();

  // The cross-boundary cost read: the `cost` extension publishes a
  // `costOf(agent): number` accessor into its namespaced store at activation
  // (usage lives natively on the Agent; cost does not). Resolved live so a reload
  // republishes cleanly; falls back to 0 when cost is disabled/absent.
  const costUsdFor = (agent: Agent): number => {
    const fn = built.host.storeFor("cost").get<(a: Agent) => number>(COST_ACCESSOR_KEY);
    return typeof fn === "function" ? fn(agent) : 0;
  };

  // The cross-boundary live-job read: `subagent-jobs` publishes `hasLiveJob(agent)`
  // into its store; the server consults it so eviction / DELETE never drop a
  // session that still owns a running detached job. Falls back to false when absent.
  const hasLiveJob = (agent: Agent): boolean => {
    const fn = built.host.storeFor("subagent-jobs").get<(a: Agent) => boolean>(JOBS_ACCESSOR_KEY);
    return typeof fn === "function" ? fn(agent) : false;
  };

  // Refuse a launch_job from a sessionless run: its background child would outlive
  // the throwaway Agent with no session id to ever query/collect it. Session-backed
  // roots pass; a fork is already gated by the extension's own rootOnly guard.
  built.agent.hooks.filter("beforeToolCall", (decision, ctx) => {
    if (decision.block || ctx.call.name !== "launch_job") return decision;
    const root = currentRootAgent();
    return root && sessionlessRoots.has(root)
      ? { ...decision, block: true, reason: "launch_job needs a session id; a sessionless /run cannot later query the background job." }
      : decision;
  });

  const server = createServer((req, res) => {
    // Absorb an OutgoingMessage 'error' (a socket reset — ECONNRESET/EPIPE) on
    // any response, streaming or single-write. Without a listener it throws as an
    // uncaught exception and takes the whole process down; route(...).catch only
    // catches promise rejections, not EventEmitter errors.
    res.on("error", () => {});
    route(
      req,
      res,
      built.agent,
      built.host.list(),
      sessions,
      running,
      sessionlessRoots,
      { token, maxBody },
      elicit,
      askTimeoutMs,
      built.config,
      costUsdFor,
      hasLiveJob,
      sessionsDir,
    ).catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
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
  running: Set<string>,
  sessionlessRoots: WeakSet<Agent>,
  security: Security,
  elicit: Elicitation,
  askTimeoutMs: number,
  config: Config,
  costUsdFor: (agent: Agent) => number,
  hasLiveJob: (agent: Agent) => boolean,
  sessionsDir: string | undefined,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  // /health is always open (for liveness probes).
  if (method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model: template.model, extensions, sessions: sessions.size, auth: security.token ? "required" : "open" });
    return;
  }

  // A bare `/` is a liveness courtesy for a human hitting the host in a browser;
  // every other non-API path falls through to auth/404.
  const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
  if (method === "GET" && (rawPath === "/" || rawPath === "") && !isApiPath(url.pathname)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("EAgent HTTP API is up. See docs/TUI.md for the terminal client.\n");
    return;
  }

  // Everything else (API + unknown paths) requires Bearer when a token is set.
  if (security.token && !authorized(req, security.token)) {
    sendJson(res, 401, { error: "unauthorized; provide Authorization: Bearer <token>" });
    return;
  }

  // -- Monitor endpoints (list + live SSE feeds + stop) ----------------------
  // Additive, read-mostly routes the monitor client attaches to. Placed before
  // the generic `/sessions/:id` matcher so `/sessions` and `/sessions/:id/events`
  // resolve here first.

  // Enumerate live + on-disk sessions so the monitor survives restarts.
  if (req.method === "GET" && url.pathname === "/sessions") {
    const list = [...sessions].map(([id, agent]) => ({
      id,
      running: agent.running,
      usage: agent.usage,
      costUsd: costUsdFor(agent),
    }));
    if (sessionsDir) {
      const seen = new Set(list.map((s) => s.id));
      for (const disk of listDiskSessionSummaries(sessionsDir)) {
        if (seen.has(disk.id)) continue;
        list.push({
          id: disk.id,
          running: false,
          usage: disk.usage,
          costUsd: disk.costUsd,
        });
      }
    }
    sendJson(res, 200, list);
    return;
  }

  // A global live feed: re-emit every session's bus events, each frame tagged
  // with its originating session id (reverse-looked-up on the pool) so a
  // multi-session client can demux the one stream.
  if (req.method === "GET" && url.pathname === "/events") {
    streamSse(res, template, {}, (obj) => {
      const root = currentRootAgent();
      let sid: string | null = null;
      for (const [id, agent] of sessions) {
        if (agent === root) {
          sid = id;
          break;
        }
      }
      return { session: sid, ...obj };
    });
    return;
  }

  // A per-session live feed: only THIS session's run-tree events (the
  // `currentRootAgent() === agent` tenant filter `/run` already uses).
  if (req.method === "GET" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/events")) {
    const id = decodeURIComponent(url.pathname.slice("/sessions/".length, -"/events".length));
    const agent = getOrLoadSession(sessions, id, template, sessionsDir);
    if (!agent) {
      sendJson(res, 404, { error: "unknown session", session: id });
      return;
    }
    streamSse(res, agent, { session: id }, (obj) => (currentRootAgent() === agent ? obj : null));
    return;
  }

  // Abort a running turn on a session (the monitor's one write control).
  if (req.method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/stop")) {
    const id = decodeURIComponent(url.pathname.slice("/sessions/".length, -"/stop".length));
    const agent = getOrLoadSession(sessions, id, template, sessionsDir);
    if (!agent) {
      sendJson(res, 404, { error: "unknown session", session: id });
      return;
    }
    agent.stop();
    sendJson(res, 200, { stopped: true, session: id });
    return;
  }

  // Per-tenant observability + resume: usage/cost plus the session Agent's
  // transcript so a web client can hydrate Chat when switching sessions.
  // Usage lives natively on the session Agent; cost is read through the
  // extension-published accessor (`costUsdFor`). Unknown id → 404.
  if (req.method === "GET" && url.pathname.startsWith("/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
    // Reject subpaths that should have been handled above (events/stop).
    if (id.includes("/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const agent = getOrLoadSession(sessions, id, template, sessionsDir);
    if (!agent) {
      sendJson(res, 404, { error: "unknown session", session: id });
      return;
    }
    sendJson(res, 200, {
      session: id,
      running: agent.running,
      usage: agent.usage,
      costUsd: costUsdFor(agent),
      // Shallow-copy the frozen messages array so callers cannot mutate the Agent.
      messages: agent.messages.slice(),
    });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
    // Never forget a session mid-turn or while it still owns a running background
    // job: dropping its Agent would abort the live turn or strand the detached child.
    const agent = getOrLoadSession(sessions, id, template, sessionsDir);
    if (running.has(id) || (agent && hasLiveJob(agent))) {
      sendJson(res, 409, { error: "session is busy (a turn or background job is in flight); cannot delete", session: id });
      return;
    }
    const inMem = sessions.delete(id);
    const onDisk = sessionsDir ? deleteSessionFile(sessionsDir, id) : false;
    sendJson(res, inMem || onDisk ? 200 : 404, { deleted: inMem || onDisk, session: id });
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
    // Per-session lock: a same-session /run already in flight → 409; a different
    // session (or a sessionless run) proceeds concurrently. A sessionless run
    // takes no lock — it cannot alias another request (fresh throwaway Agent).
    if (session !== undefined && running.has(session)) {
      sendJson(res, 409, { error: "a turn is already in flight for this session; retry shortly" });
      return;
    }
    if (session !== undefined) running.add(session);
    try {
      await streamRun(
        res,
        template,
        input,
        sessions,
        session,
        elicit,
        askTimeoutMs,
        config,
        sessionlessRoots,
        running,
        hasLiveJob,
        sessionsDir,
        costUsdFor,
      );
    } finally {
      if (session !== undefined) running.delete(session);
    }
    return;
  }

  sendJson(res, 404, {
    error: "not found",
    routes: [
      "GET /health",
      "POST /run",
      "POST /answer",
      "GET /sessions",
      "GET /sessions/:id  (usage, costUsd, messages)",
      "GET /sessions/:id/events",
      "POST /sessions/:id/stop",
      "GET /events",
      "DELETE /sessions/:id",
    ],
  });
}

/**
 * Build a fresh per-session Agent: it SHARES the host's registries/hooks/
 * capabilities/ui/logger (so every extension governs every session) but carries
 * its OWN transcript/usage and a fresh copy of the run config
 * (model/systemPrompt/thinking/maxTurns/provider/maxConcurrency).
 */
/**
 * Return a pooled Agent for `id`, loading from disk into the map when needed.
 */
function getOrLoadSession(
  sessions: Map<string, Agent>,
  id: string,
  template: Agent,
  sessionsDir: string | undefined,
): Agent | undefined {
  const live = sessions.get(id);
  if (live) return live;
  if (!sessionsDir) return undefined;
  const file = readSessionFile(sessionsDir, id);
  if (!file) return undefined;
  const agent = makeSessionAgent(template);
  if (file.model) agent.model = file.model;
  agent.load(file.messages);
  sessions.set(id, agent);
  return agent;
}

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
  sessionlessRoots: WeakSet<Agent>,
  running: Set<string>,
  hasLiveJob: (agent: Agent) => boolean,
  sessionsDir: string | undefined,
  costUsdFor: (agent: Agent) => number,
): Promise<void> {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  let closed = false;
  const write = (obj: unknown): void => {
    if (closed) return; // don't write to a destroyed socket
    res.write(JSON.stringify(obj) + "\n");
  };

  // The session's own Agent (own transcript/usage): reuse the pooled one, else
  // build a fresh one from the host template. A sessionless /run runs on a
  // throwaway that is never pooled and cannot launch a background job. `existed`
  // gates whether a brand-new session whose only turn aborts is worth persisting
  // (it is not — see the rollback below).
  const existed =
    session !== undefined &&
    (sessions.has(session) || (sessionsDir !== undefined && readSessionFile(sessionsDir, session) !== undefined));
  const agent =
    session !== undefined
      ? (getOrLoadSession(sessions, session, template, sessionsDir) ?? makeSessionAgent(template))
      : makeSessionAgent(template);
  if (session === undefined) sessionlessRoots.add(agent);

  // This turn's own pending ask ids (the per-turn drain-set): the `finally`
  // settles ONLY these, so one session's turn end cannot cancel another's ask.
  const askIds = new Set<number>();
  // Install this turn's ask sink, keyed on the session ROOT Agent. A model
  // `ask_user_question` reaches serverUI.ask, which routes by `currentRootAgent()`
  // to THIS sink: emit an `action_required` line, register a resolver under a
  // fresh id, and return a Promise the client settles via `POST /answer` — or a
  // bounded timeout / disconnect settles with null (→ proceed-with-assumption).
  elicit.sinks.set(agent, (question, options) =>
    new Promise<string | null>((resolve) => {
      const id = elicit.nextId++;
      askIds.add(id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (answer: string | null): void => {
        if (!elicit.pending.has(id)) return; // already settled (answer/timeout/close)
        elicit.pending.delete(id);
        askIds.delete(id);
        if (timer) clearTimeout(timer);
        resolve(answer);
      };
      elicit.pending.set(id, settle);
      timer = setTimeout(() => settle(null), askTimeoutMs);
      if (typeof timer.unref === "function") timer.unref(); // don't keep the event loop alive
      write(eventToJsonl("action_required", { id, question, options }));
    }),
  );

  // Settle this turn's outstanding asks with null (fallback) and drop its sink.
  // Called from disconnect and from the finally so no resolver leaks past the turn
  // and a later `/answer` for a stale id is a clean 404.
  const drainElicitations = (): void => {
    for (const id of [...askIds]) elicit.pending.get(id)?.(null);
    askIds.clear();
    elicit.sinks.delete(agent);
  };

  // If the client disconnects mid-turn, abort THIS session's agent so it stops
  // streaming to a dead socket (and frees the per-session lock) instead of running
  // the whole turn to completion and wasting tokens/side effects. Also release any
  // ask the turn is blocked on, so the agent loop can unwind instead of hanging.
  const onClose = (): void => {
    closed = true;
    drainElicitations();
    if (agent.running) agent.stop();
  };
  res.on("close", onClose);
  res.on("error", onClose); // a mid-stream socket error runs the same teardown

  // Route a streaming frame to THIS session's response only when the currently-
  // executing turn's root IS this session's Agent. On the shared hook bus every
  // session's wireJsonl/error observers fire for every session's events (and its
  // forks', which inherit the root via `currentRootAgent()`); this guard keeps
  // each frame on its own stream with zero cross-talk. The terminal writes below
  // run outside any run's ALS context, so they use `write` directly.
  const emit = (obj: unknown): void => {
    if (currentRootAgent() === agent) write(obj);
  };

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

    subs = wireJsonl(emit, agent);
    subs.push(
      agent.hooks.on("error", ({ error, where }) => {
        if (currentRootAgent() !== agent) return; // another session's error, not ours
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
      // oldest evictable sessions past the cap (skipping in-flight / live-job ones).
      sessions.delete(session);
      sessions.set(session, agent);
      if (sessionsDir) {
        try {
          writeSessionFile(sessionsDir, {
            version: 1,
            savedAt: new Date().toISOString(),
            session,
            model: agent.model,
            messages: agent.messages.slice() as Message[],
            usage: { inputTokens: agent.usage.inputTokens, outputTokens: agent.usage.outputTokens },
            costUsd: costUsdFor(agent),
          });
        } catch {
          // Disk full / permissions: keep serving from memory; next turn retries.
        }
      }
      evictSessions(sessions, maxSessions(config), running, hasLiveJob);
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
    drainElicitations(); // settle this turn's asks + drop its sink
    res.off("close", onClose);
    res.off("error", onClose);
    for (const s of subs) s.dispose();
    if (!closed) res.end();
  }
}

/**
 * Evict least-recently-used sessions past `cap` (Map iteration is insertion
 * order, so the oldest key is the LRU). SKIP any session whose turn is in flight
 * (in `running`) or that still owns a running background job (`hasLiveJob`) —
 * dropping its Agent would abort a live turn or strand a detached child. If no
 * session is evictable the map stays briefly over cap; the next turn retries.
 * `cap <= 0` disables the bound (unbounded).
 */
function evictSessions(
  sessions: Map<string, Agent>,
  cap: number,
  running: Set<string>,
  hasLiveJob: (agent: Agent) => boolean,
): void {
  if (cap <= 0) return;
  while (sessions.size > cap) {
    let victim: string | undefined;
    for (const [id, agent] of sessions) {
      if (running.has(id) || hasLiveJob(agent)) continue;
      victim = id;
      break;
    }
    if (victim === undefined) break; // nothing evictable right now
    sessions.delete(victim);
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

/** SSE response headers (a long-lived `text/event-stream`, never buffered). */
function sseHead(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
}

/** Write one SSE frame: an optional `event:` name plus a JSON `data:` payload. */
function sseFrame(res: ServerResponse, event: string | undefined, data: unknown): void {
  const head = event ? `event: ${event}\n` : "";
  res.write(`${head}data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Wire a read-only SSE feed over `agent`'s (shared) hooks bus: write a
 * `connected` frame, then re-emit each hook-bus event through `eventToJsonl`,
 * passing it through `frame` — which returns the object to send, or `null` to
 * drop it (the per-session tenant filter). Subscriptions are disposed when the
 * client disconnects, so a monitor attach never leaks handlers or perturbs a run.
 */
function streamSse(res: ServerResponse, agent: Agent, connected: unknown, frame: (obj: JsonlEvent) => object | null): void {
  sseHead(res);
  let closed = false;
  const send = (obj: JsonlEvent): void => {
    if (closed) return;
    const out = frame(obj);
    if (out !== null) sseFrame(res, undefined, out);
  };
  sseFrame(res, "connected", connected);
  // agent_end/error carry no usage on the bus; read it live off the acting run's
  // root (which the frame filter has already confirmed is the intended session).
  const usageNow = (): Usage => currentRootAgent()?.usage ?? { inputTokens: 0, outputTokens: 0 };
  const subs = wireJsonl((o) => send(o as JsonlEvent), agent);
  subs.push(
    agent.hooks.on("agent_end", ({ reason }) => send(eventToJsonl("agent_end", { reason, usage: usageNow() }))),
    agent.hooks.on("error", ({ error, where }) => send(eventToJsonl("error", { where, message: error instanceof Error ? error.message : String(error) }))),
  );
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    for (const s of subs) s.dispose();
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return; // the stream already owns this response; never re-writeHead
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** API paths that must never be SPA-fallbacked or served as static files. */
export function isApiPath(pathname: string): boolean {
  if (pathname === "/health" || pathname === "/run" || pathname === "/answer" || pathname === "/events") return true;
  if (pathname === "/sessions" || pathname.startsWith("/sessions/")) return true;
  return false;
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
      console.error(`  sessions are isolated per session id, but authenticated by one shared token — run one process per tenant for per-tenant authorization (see SECURITY.md)`);
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
