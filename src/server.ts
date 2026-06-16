#!/usr/bin/env node
/**
 * The HTTP server front end.
 *
 * A second host (alongside the terminal CLI) that exposes the agent over HTTP
 * for programmatic embedding. It is intentionally tiny — `node:http` only, no
 * framework — and reuses `createAgentHost`, so it loads exactly the same
 * extensions as the CLI.
 *
 *   GET    /health          → { ok, model, extensions, sessions }
 *   POST   /run             → streams lifecycle events as JSONL (one per line)
 *                             body: { input: string, session?: string }
 *   DELETE /sessions/:id     → forget a conversation
 *
 * A `session` id makes `/run` calls accumulate into one conversation; without
 * it, each call is a fresh, stateless turn. The agent runs one turn at a time
 * (a second concurrent `/run` gets 409) — a deliberate simplicity for a minimal
 * server; front a pool of these for real concurrency.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Agent } from "./kernel/agent.js";
import type { Message, Logger } from "./kernel/types.js";
import { createAgentHost, loadEnvFile, type AgentHostOptions } from "./host.js";

export interface ServeOptions extends AgentHostOptions {
  port?: number;
  /** Require `Authorization: Bearer <token>` on mutating routes. Defaults to
   *  `EAGENT_TOKEN`; when unset, the server is open (suitable only for trusted
   *  local use — see SECURITY.md). */
  token?: string;
  /** Max request body size in bytes (default 1 MiB). */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

export interface HttpServer {
  server: ReturnType<typeof createServer>;
  agent: Agent;
  extensions: string[];
  model: string;
  /** Tear down the extension host (call on shutdown). */
  close(): Promise<void>;
}

/** Build the agent host and return a configured (but not yet listening) server. */
export async function createHttpServer(opts: ServeOptions = {}): Promise<HttpServer> {
  const logger: Logger = opts.logger ?? {
    debug: () => {},
    info: (...a) => console.error("·", ...a),
    warn: (...a) => console.error("!", ...a),
    error: (...a) => console.error("✗", ...a),
  };
  const built = await createAgentHost({ ...opts, logger, yolo: opts.yolo ?? true });
  await built.agent.hooks.emit("session_start", {});

  const token = opts.token ?? process.env.EAGENT_TOKEN ?? "";
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

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

  // Per-conversation transcripts, replayed into the shared agent on each turn.
  const sessions = new Map<string, Message[]>();
  let busy = false;

  const server = createServer((req, res) => {
    route(req, res, built.agent, built.host.list(), sessions, {
      get busy() {
        return busy;
      },
      set busy(v) {
        busy = v;
      },
    }, { token, maxBody }).catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
  });

  return {
    server,
    agent: built.agent,
    extensions: built.host.list(),
    model: built.model,
    close: () => built.host.dispose(),
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
  sessions: Map<string, Message[]>,
  lock: Lock,
  security: Security,
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
      await streamRun(res, agent, input, sessions, session);
    } finally {
      lock.busy = false;
    }
    return;
  }

  sendJson(res, 404, { error: "not found", routes: ["GET /health", "POST /run", "DELETE /sessions/:id"] });
}

/** Run one turn, streaming lifecycle events to the client as JSONL. */
async function streamRun(
  res: ServerResponse,
  agent: Agent,
  input: string,
  sessions: Map<string, Message[]>,
  session: string | undefined,
): Promise<void> {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  let closed = false;
  const write = (obj: unknown): void => {
    if (closed) return; // don't write to a destroyed socket
    res.write(JSON.stringify(obj) + "\n");
  };
  // If the client disconnects mid-turn, abort the agent so it stops streaming
  // to a dead socket (and frees the single-flight lock) instead of running the
  // whole turn to completion and wasting tokens/side effects.
  const onClose = (): void => {
    closed = true;
    if (agent.running) agent.stop();
  };
  res.on("close", onClose);

  // Replay this session's transcript so the turn has its conversation history.
  agent.clear();
  if (session) {
    const history = sessions.get(session);
    if (history && history.length) agent.load(history.map((m) => ({ ...m })));
  }

  const subs = [
    agent.hooks.on("text_delta", ({ text }) => write({ type: "text_delta", text })),
    agent.hooks.on("message", ({ message }) => write({ type: "message", role: message.role, content: message.content })),
    agent.hooks.on("tool_start", ({ call }) => write({ type: "tool_start", name: call.name, arguments: call.arguments })),
    agent.hooks.on("tool_end", ({ call, result }) =>
      write({ type: "tool_end", name: call.name, isError: result.isError ?? false, content: result.content }),
    ),
    agent.hooks.on("usage", ({ usage, cumulative }) => write({ type: "usage", usage, cumulative })),
  ];
  try {
    const { reason } = await agent.run(input);
    if (session) sessions.set(session, agent.messages.map((m) => ({ ...m })));
    write({ type: "done", reason, session, usage: agent.usage });
  } catch (err) {
    write({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    res.off("close", onClose);
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  loadEnvFile();
  const port = Number(process.env.PORT ?? 8787);
  // Bind loopback by default so an unauthenticated server is not reachable
  // off-box. Set EAGENT_HOST=0.0.0.0 to expose it deliberately (use a token).
  const host = process.env.EAGENT_HOST ?? "127.0.0.1";
  const http = await createHttpServer({ port });
  http.server.listen(port, host, () => {
    console.error(`eagent server on http://${host}:${port} (model=${http.model}, ${http.extensions.length} extensions)`);
  });

  // Graceful shutdown: stop accepting connections, tear down the host, exit.
  const shutdown = async (signal: string) => {
    console.error(`\n${signal} received, shutting down…`);
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    await http.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Run as a CLI only when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
