#!/usr/bin/env node
/**
 * The HTTP server front end.
 *
 * A second host (alongside the terminal CLI) that exposes the agent over HTTP
 * for programmatic embedding. It is intentionally tiny — `node:http` only, no
 * framework — and reuses `createAgentHost`, so it loads exactly the same
 * extensions as the CLI.
 *
 *   GET  /health        → { ok, model, extensions }
 *   POST /run           → streams lifecycle events as JSONL (one per line)
 *                         body: { "input": "your message" }
 *
 * Each `/run` is one turn against a shared agent. Run with `eagent-serve`
 * (or `npm run serve`); set `PORT` to choose the port (default 8787).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Agent } from "./kernel/agent.js";
import type { Logger } from "./kernel/types.js";
import { createAgentHost, type AgentHostOptions } from "./host.js";

export interface ServeOptions extends AgentHostOptions {
  port?: number;
}

/** Build the agent host and return a configured (but not yet listening) server. */
export async function createHttpServer(opts: ServeOptions = {}) {
  const logger: Logger = opts.logger ?? {
    debug: () => {},
    info: (...a) => console.error("·", ...a),
    warn: (...a) => console.error("!", ...a),
    error: (...a) => console.error("✗", ...a),
  };
  const built = await createAgentHost({ ...opts, logger, yolo: opts.yolo ?? true });
  await built.agent.hooks.emit("session_start", {});

  const server = createServer((req, res) => {
    handle(req, res, built.agent, built.host.list()).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  return { server, agent: built.agent, extensions: built.host.list(), model: built.model };
}

async function handle(req: IncomingMessage, res: ServerResponse, agent: Agent, extensions: string[]): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, model: agent.model, extensions });
    return;
  }

  if (req.method === "POST" && url.pathname === "/run") {
    const body = await readBody(req);
    let input: string;
    try {
      input = String((JSON.parse(body) as { input?: unknown }).input ?? "");
    } catch {
      sendJson(res, 400, { error: "invalid JSON body; expected { input: string }" });
      return;
    }
    if (!input) {
      sendJson(res, 400, { error: "missing 'input'" });
      return;
    }
    if (agent.running) {
      sendJson(res, 409, { error: "agent is busy" });
      return;
    }
    await streamRun(res, agent, input);
    return;
  }

  sendJson(res, 404, { error: "not found", routes: ["GET /health", "POST /run"] });
}

/** Run one turn, streaming lifecycle events to the client as JSONL. */
async function streamRun(res: ServerResponse, agent: Agent, input: string): Promise<void> {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  const write = (obj: unknown): void => {
    res.write(JSON.stringify(obj) + "\n");
  };

  // Subscribe for the duration of this run, then dispose to avoid leaks.
  const subs = [
    agent.hooks.on("message", ({ message }) => write({ type: "message", role: message.role, content: message.content })),
    agent.hooks.on("tool_start", ({ call }) => write({ type: "tool_start", name: call.name, arguments: call.arguments })),
    agent.hooks.on("tool_end", ({ call, result }) =>
      write({ type: "tool_end", name: call.name, isError: result.isError ?? false, content: result.content }),
    ),
    agent.hooks.on("usage", ({ usage, cumulative }) => write({ type: "usage", usage, cumulative })),
  ];
  try {
    const { reason } = await agent.run(input);
    write({ type: "done", reason, usage: agent.usage });
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
  const { server, model, extensions } = await createHttpServer({ port });
  server.listen(port, () => {
    console.error(`eagent server listening on http://localhost:${port} (model=${model}, ${extensions.length} extensions)`);
  });
}

// Run as a CLI only when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
