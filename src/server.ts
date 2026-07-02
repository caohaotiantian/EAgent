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

import type { Agent } from "./kernel/agent.js";
import type { AgentState, Logger, UI } from "./kernel/types.js";
import { createAgentHost, loadEnvFile, type AgentHostOptions } from "./host.js";

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

  const host = opts.host ?? process.env.EAGENT_HOST ?? "127.0.0.1";
  const token = opts.token ?? process.env.EAGENT_TOKEN ?? "";

  // Fail-closed on the dangerous combination: a non-loopback bind exposes the
  // server off-box, and with an empty token /run is unauthenticated AND runs
  // tools with full capabilities under yolo. Refuse to start rather than warn.
  // Guarded here (before any listen) so the check is pre-bind and unit-testable.
  if (!isLoopback(host) && !token) {
    throw new Error(
      `refusing to bind ${host} without EAGENT_TOKEN: a non-loopback bind with no token exposes an ` +
        "unauthenticated, full-capability agent. Set EAGENT_TOKEN, or bind a loopback address (127.0.0.1).",
    );
  }

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
  await built.agent.hooks.emit("session_start", {});

  // The pristine state a brand-new session (or a sessionless /run) restores from:
  // empty transcript, zero usage, the configured model/prompt/thinking.
  const initial = built.agent.snapshot();

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

  // Per-conversation state snapshots, restored into the shared agent each turn.
  const sessions = new Map<string, AgentState>();
  let busy = false;

  const server = createServer((req, res) => {
    // Absorb an OutgoingMessage 'error' (a socket reset — ECONNRESET/EPIPE) on
    // any response, streaming or single-write. Without a listener it throws as an
    // uncaught exception and takes the whole process down; route(...).catch only
    // catches promise rejections, not EventEmitter errors.
    res.on("error", () => {});
    route(req, res, built.agent, built.host.list(), sessions, initial, {
      get busy() {
        return busy;
      },
      set busy(v) {
        busy = v;
      },
    }, { token, maxBody }, elicit, askTimeoutMs).catch((err) =>
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
  agent: Agent,
  extensions: string[],
  sessions: Map<string, AgentState>,
  initial: AgentState,
  lock: Lock,
  security: Security,
  elicit: Elicitation,
  askTimeoutMs: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // /health is always open (for liveness probes); everything else needs auth
  // when a token is configured.
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model: agent.model, extensions, sessions: sessions.size, auth: security.token ? "required" : "open" });
    return;
  }

  if (security.token && !authorized(req, security.token)) {
    sendJson(res, 401, { error: "unauthorized; provide Authorization: Bearer <token>" });
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
      await streamRun(res, agent, input, sessions, initial, session, elicit, askTimeoutMs);
    } finally {
      lock.busy = false;
    }
    return;
  }

  sendJson(res, 404, {
    error: "not found",
    routes: ["GET /health", "POST /run", "POST /answer", "DELETE /sessions/:id"],
  });
}

/** Run one turn, streaming lifecycle events to the client as JSONL. */
async function streamRun(
  res: ServerResponse,
  agent: Agent,
  input: string,
  sessions: Map<string, AgentState>,
  initial: AgentState,
  session: string | undefined,
  elicit: Elicitation,
  askTimeoutMs: number,
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
      write({ type: "action_required", id, question, options: options ?? null });
    });

  // Settle every outstanding ask for this turn with null (fallback) and drop the
  // sink. Called from disconnect and from the finally so no resolver leaks past
  // the turn and a later `/answer` for a stale id is a clean 404.
  const drainElicitations = (): void => {
    for (const settle of [...elicit.pending.values()]) settle(null);
    elicit.pending.clear();
    elicit.ask = null;
  };

  // If the client disconnects mid-turn, abort the agent so it stops streaming
  // to a dead socket (and frees the single-flight lock) instead of running the
  // whole turn to completion and wasting tokens/side effects. Also release any
  // ask the turn is blocked on, so the agent loop can unwind instead of hanging.
  const onClose = (): void => {
    closed = true;
    drainElicitations();
    if (agent.running) agent.stop();
  };
  res.on("close", onClose);
  res.on("error", onClose); // a mid-stream socket error runs the same teardown

  // Restore + subscribe inside the try so a setup-window throw (e.g. restore)
  // streams a {type:"error"} line and hits the finally, not a silent 200 with no
  // terminal line. `subs` is declared out here so the finally can dispose it.
  let subs: { dispose(): void }[] = [];
  try {
    // Restore this session's state (transcript, usage, model, prompt, thinking) so
    // the turn resumes from exactly where the session left off. A new session — or a
    // sessionless /run — restores the pristine `initial` snapshot.
    agent.restore((session ? sessions.get(session) : undefined) ?? initial);

    subs = [
      agent.hooks.on("text_delta", ({ text }) => write({ type: "text_delta", text })),
      agent.hooks.on("message", ({ message }) => write({ type: "message", role: message.role, content: message.content })),
      agent.hooks.on("tool_start", ({ call }) => write({ type: "tool_start", name: call.name, arguments: call.arguments })),
      agent.hooks.on("tool_end", ({ call, result }) =>
        write({ type: "tool_end", name: call.name, isError: result.isError ?? false, content: result.content }),
      ),
      agent.hooks.on("usage", ({ usage, cumulative }) => write({ type: "usage", usage, cumulative })),
    ];
    const { reason } = await agent.run(input);
    // Snapshot the post-turn state back into the session. `agent.usage` here is the
    // session's cumulative (restored session usage + this turn), not process-lifetime.
    // Skip a transcript left on a bare `user` turn (a turn aborted before any
    // assistant output): restoring it and appending the next input would form two
    // consecutive user messages. Keep the session's last valid state instead.
    const msgs = agent.messages;
    const danglingUser = msgs.length > 0 && msgs[msgs.length - 1]!.role === "user";
    if (session && !danglingUser) {
      // LRU touch: Map.set on an existing key keeps its position, so delete+set
      // moves the just-written session to newest, then evict the oldest keys past
      // the cap. cap===0 skips the loop entirely (unbounded).
      sessions.delete(session);
      sessions.set(session, agent.snapshot());
      const cap = maxSessions();
      while (cap > 0 && sessions.size > cap) sessions.delete(sessions.keys().next().value as string);
    }
    write({ type: "done", reason, session, usage: agent.usage });
  } catch (err) {
    write({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
export function maxSessions(): number {
  const raw = process.env.EAGENT_MAX_SESSIONS?.trim();
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
  // off-box. Set EAGENT_HOST=0.0.0.0 to expose it deliberately (use a token).
  const host = process.env.EAGENT_HOST ?? "127.0.0.1";
  const http = await createHttpServer({ port, host });
  try {
    http.server.listen(port, host, () => {
      console.error(`eagent server on http://${host}:${port} (model=${http.model}, ${http.extensions.length} extensions)`);
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
