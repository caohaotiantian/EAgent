/**
 * MCP (Model Context Protocol) client — the process-isolated plugin boundary.
 *
 * The kernel keeps MCP deliberately out of core: an in-process extension is the
 * place for trusted, immediate power, but MCP servers are *foreign* code. They
 * are other people's programs, written in other languages, that we do not get
 * to vouch for. So we speak to them the way Emacs speaks to a subprocess — at
 * arm's length, over a pipe — rather than loading them into our address space.
 *
 * The transport is MCP's stdio framing: JSON-RPC 2.0 messages, one compact JSON
 * object per line, newline-terminated (NOT the LSP `Content-Length` framing).
 * We spawn each configured server, perform the `initialize` / `initialized`
 * handshake, enumerate its tools, and surface each one into EAgent under a
 * namespaced name (`mcp__<server>__<tool>`). Calling such a tool is privileged:
 * it reaches outside the kernel, so it is gated behind the `mcp:call`
 * capability. On unload every subprocess is killed, returning us to a clean
 * slate — the same precise teardown a hot reload depends on.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { JSONSchema } from "../kernel/types.js";

/** A server entry as found in `EAGENT_MCP_SERVERS`. */
interface ServerDef {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A tool as described by an MCP server's `tools/list`. */
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

/** The textual/`isError` shape of an MCP `tools/call` result. */
interface McpCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

const PROTOCOL_VERSION = "2024-11-05";

/**
 * One connected MCP server: owns the subprocess, the line reader, and the
 * JSON-RPC id→promise correlation table.
 */
class McpConnection {
  readonly name: string;
  readonly #child: ChildProcess;
  readonly #rl: Interface;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #closed = false;
  tools: McpTool[] = [];

  constructor(def: ServerDef) {
    this.name = def.name;
    this.#child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...def.env },
    });
    // A spawn failure (bad command) surfaces asynchronously; reject everything.
    this.#child.on("error", (err) => this.#failAll(err));
    this.#child.on("exit", () => this.#failAll(new Error(`MCP server "${this.name}" exited`)));
    // Server logs/diagnostics go to stderr; we deliberately ignore them.
    this.#child.stderr?.resume();

    this.#rl = createInterface({ input: this.#child.stdout! });
    this.#rl.on("line", (line) => this.#onLine(line));
  }

  /** Run the handshake and load the tool list. Throws if the server misbehaves. */
  async start(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "eagent", version: "0.1" },
    });
    this.notify("notifications/initialized");
    const listed = (await this.request("tools/list", {})) as { tools?: McpTool[] } | undefined;
    this.tools = listed?.tools ?? [];
  }

  /** Send a JSON-RPC request and await its correlated response. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`MCP server "${this.name}" is closed`));
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write(payload);
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rl.close();
    try {
      this.#child.kill();
    } catch {
      // already gone
    }
    this.#failAll(new Error(`MCP server "${this.name}" disposed`));
  }

  #write(message: unknown): void {
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Non-JSON line (a stray log on stdout); ignore per MCP framing rules.
      return;
    }
    if (typeof msg.id !== "number") return; // notification or unrelated; nothing to correlate
    const waiter = this.#pending.get(msg.id);
    if (!waiter) return;
    this.#pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message ?? "MCP error"));
    else waiter.resolve(msg.result);
  }

  #failAll(err: Error): void {
    if (this.#pending.size === 0) return;
    for (const waiter of this.#pending.values()) waiter.reject(err);
    this.#pending.clear();
  }
}

export default async function activate(e: ExtensionAPI): Promise<() => void> {
  e.grantCapability("mcp:call");

  const connections: McpConnection[] = [];

  for (const def of parseServers(e.log.warn, process.env.EAGENT_MCP_SERVERS)) {
    let conn: McpConnection | undefined;
    try {
      conn = new McpConnection(def);
      await conn.start();
    } catch (err) {
      // A server that won't start is skipped, never fatal to activation.
      e.log.warn(`MCP server "${def.name}" failed to start: ${(err as Error).message}`);
      conn?.dispose();
      continue;
    }
    connections.push(conn);

    for (const tool of conn.tools) {
      const connection = conn;
      const toolName = tool.name;
      e.registerTool(
        defineTool({
          name: `mcp__${def.name}__${toolName}`,
          description: tool.description ?? `MCP tool "${toolName}" from server "${def.name}".`,
          capabilities: ["mcp:call"],
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          execute: async (args, ctx) => {
            await ctx.require("mcp:call");
            try {
              const result = (await connection.request("tools/call", {
                name: toolName,
                arguments: args,
              })) as McpCallResult | undefined;
              const content = (result?.content ?? [])
                .filter((c) => typeof c.text === "string")
                .map((c) => c.text)
                .join("");
              return result?.isError ? fail(content) : ok(content, result);
            } catch (err) {
              return fail(`MCP call failed: ${(err as Error).message}`);
            }
          },
        }),
      );
    }
    e.log.info(`MCP server "${def.name}" connected with ${conn.tools.length} tool(s).`);
  }

  e.registerCommand({
    name: "mcp",
    description: "List connected MCP servers and their tool counts.",
    run: (ctx) => {
      if (connections.length === 0) {
        ctx.print("(no MCP servers connected)");
        return;
      }
      for (const conn of connections) {
        ctx.print(`  ${conn.name.padEnd(20)} ${conn.tools.length} tool(s)`);
      }
    },
  });

  return () => {
    for (const conn of connections) conn.dispose();
  };
}

/** Parse and validate `EAGENT_MCP_SERVERS`; tolerate absence and bad JSON. */
function parseServers(warn: (msg: string) => void, raw: string | undefined): ServerDef[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn("EAGENT_MCP_SERVERS is not valid JSON; ignoring.");
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn("EAGENT_MCP_SERVERS must be a JSON array; ignoring.");
    return [];
  }
  const out: ServerDef[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as ServerDef).name === "string" &&
      typeof (entry as ServerDef).command === "string"
    ) {
      out.push(entry as ServerDef);
    } else {
      warn("Skipping MCP server entry missing string name/command.");
    }
  }
  return out;
}
