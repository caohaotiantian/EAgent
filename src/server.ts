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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Agent } from "./kernel/agent.js";
import type { Message, Logger } from "./kernel/types.js";
import { createAgentHost, type AgentHostOptions } from "./host.js";

export interface ServeOptions extends AgentHostOptions {
  port?: number;
}

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
    }).catch((err) => sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }));
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

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  agent: Agent,
  extensions: string[],
  sessions: Map<string, Message[]>,
  lock: Lock,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model: agent.model, extensions, sessions: sessions.size });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/sessions/")) {
    const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
    const existed = sessions.delete(id);
    sendJson(res, existed ? 200 : 404, { deleted: existed, session: id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    const body = await readBody(req);
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
  const write = (obj: unknown): void => {
    res.write(JSON.stringify(obj) + "\n");
  };

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
    for (const s of subs) s.dispose();
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const http = await createHttpServer({ port });
  http.server.listen(port, () => {
    console.error(`eagent server on http://localhost:${port} (model=${http.model}, ${http.extensions.length} extensions)`);
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
