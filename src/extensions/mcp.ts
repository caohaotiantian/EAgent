/**
 * MCP (Model Context Protocol) client — the process-isolated plugin boundary.
 *
 * The kernel keeps MCP deliberately out of core: an in-process extension is the
 * place for trusted, immediate power, but MCP servers are *foreign* code. They
 * are other people's programs, written in other languages, that we do not get
 * to vouch for. So we speak to them the way Emacs speaks to a subprocess — at
 * arm's length, over a pipe — rather than loading them into our address space.
 *
 * Two transports are supported, chosen per server config:
 *
 *   - stdio: we spawn the server and exchange MCP's newline-delimited JSON-RPC
 *     2.0 framing (one compact JSON object per line — NOT the LSP
 *     `Content-Length` framing) over its pipes.
 *   - Streamable HTTP (MCP 2025): we POST a single JSON-RPC message per request
 *     to a configured `url`, accepting either an `application/json` reply or an
 *     SSE (`text/event-stream`) stream from which we read the matching response.
 *     A `Mcp-Session-Id` handed back on initialize is echoed on later calls.
 *
 * Either way we perform the `initialize` / `initialized` handshake, enumerate
 * the server's tools, and surface each one into EAgent under a namespaced name
 * (`mcp__<server>__<tool>`). Calling such a tool is privileged: it reaches
 * outside the kernel, so it is gated behind the `mcp:call` capability. On unload
 * every connection is torn down, returning us to a clean slate — the same
 * precise teardown a hot reload depends on.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { JSONSchema } from "../kernel/types.js";

/** A stdio server entry as found in `EAGENT_MCP_SERVERS`. */
interface StdioServerDef {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** An HTTP (Streamable HTTP) server entry as found in `EAGENT_MCP_SERVERS`. */
interface HttpServerDef {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/** A server entry: stdio (has `command`) or HTTP (has `url`). */
type ServerDef = StdioServerDef | HttpServerDef;

function isHttpDef(def: ServerDef): def is HttpServerDef {
  return typeof (def as HttpServerDef).url === "string";
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
 * Heuristics for "tool poisoning": an MCP server's tool *description* is loaded
 * verbatim into the model's context, so a malicious server can hide instructions
 * there (the documented attack that exfiltrated SSH keys via a trivial `add`
 * tool). We can't stop the model from reading attacker text, but we can make it
 * visible — scan descriptions at registration and warn the operator. Returns the
 * names of any suspicious markers found (empty = clean). Non-blocking by design:
 * a verbose-but-legitimate description should warn, not break.
 */
const INJECTION_MARKERS: Array<[string, RegExp]> = [
  ["override-instruction", /\b(ignore|disregard|override|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all|instruction)/i],
  ["hidden-from-user", /\bdo not (tell|inform|mention|reveal|notify)\b|\bwithout (telling|informing|notifying)\b|\bdon'?t (tell|let|notify) the user\b/i],
  ["secret-access", /(\.ssh\b|id_rsa|id_ed25519|\.env\b|credentials\b|private key|api[_-]?key|access token|password)/i],
  ["hidden-tag", /<\/?(important|system|secret|instructions?)\b[^>]*>/i],
  ["exfil-verb", /\b(exfiltrat|send (it|them|this|the)|forward (it|them|the)|upload (it|them|the)|post (it|them|the))\b[^.]{0,30}\b(to|http)/i],
];

/** Return the suspicious markers found in a tool description (empty = clean). */
export function detectSuspiciousDescription(text: string): string[] {
  if (!text) return [];
  return INJECTION_MARKERS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * Per-request liveness bound for the HTTP transport. A misbehaving server that
 * accepts a POST but never answers (or holds an SSE stream open forever) must
 * not block activation or an agent turn indefinitely.
 */
const HTTP_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The narrow contract every transport satisfies. The connect/register logic
 * (handshake, tool enumeration, proxying) is written once against this and so is
 * identical whether we are talking to a subprocess or an HTTP endpoint.
 */
interface Transport {
  /**
   * Send a JSON-RPC request and await its correlated response result. An
   * optional `signal` lets a caller (e.g. an aborted agent turn) cancel it.
   */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): Promise<void>;
  /** Tear down the transport, rejecting anything still pending. */
  close(): void;
}

/**
 * stdio transport: owns the subprocess, the line reader, and the JSON-RPC
 * id→promise correlation table.
 */
class StdioTransport implements Transport {
  readonly #name: string;
  readonly #child: ChildProcess;
  readonly #rl: Interface;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #closed = false;

  constructor(def: StdioServerDef) {
    this.#name = def.name;
    this.#child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...def.env },
    });
    // A spawn failure (bad command) surfaces asynchronously; reject everything.
    this.#child.on("error", (err) => this.#failAll(err));
    this.#child.on("exit", () => this.#failAll(new Error(`MCP server "${this.#name}" exited`)));
    // Server logs/diagnostics go to stderr; we deliberately ignore them.
    this.#child.stderr?.resume();

    this.#rl = createInterface({ input: this.#child.stdout! });
    this.#rl.on("line", (line) => this.#onLine(line));
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`MCP server "${this.#name}" is closed`));
    if (signal?.aborted) return Promise.reject(new Error(`MCP request to "${this.#name}" aborted`));
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (this.#pending.delete(id)) reject(new Error(`MCP request to "${this.#name}" aborted`));
      };
      // Wrap so settling the request also detaches the abort listener — no leak
      // whether the response arrives, the server exits, or the caller aborts.
      this.#pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#write(payload);
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (!this.#closed) this.#write({ jsonrpc: "2.0", method, params: params ?? {} });
    return Promise.resolve();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rl.close();
    try {
      this.#child.kill();
    } catch {
      // already gone
    }
    this.#failAll(new Error(`MCP server "${this.#name}" disposed`));
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

/**
 * Streamable HTTP transport (MCP 2025). Each request is a self-contained POST:
 * we send one JSON-RPC message and read one JSON-RPC response back, accepting
 * either an `application/json` body or an SSE stream whose `data:` payloads
 * carry the response. The `Mcp-Session-Id` from initialize, if any, is echoed
 * on every subsequent request.
 */
class HttpTransport implements Transport {
  readonly #name: string;
  readonly #url: string;
  readonly #headers: Record<string, string>;
  #sessionId: string | undefined;
  #nextId = 1;
  #closed = false;

  constructor(def: HttpServerDef) {
    this.#name = def.name;
    this.#url = def.url;
    this.#headers = def.headers ?? {};
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error(`MCP server "${this.#name}" is closed`);
    const id = this.#nextId++;
    const res = await this.#post({ jsonrpc: "2.0", id, method, params }, signal);
    if (!res.ok) {
      throw new Error(`MCP HTTP ${method} failed: ${res.status} ${res.statusText}`);
    }
    // initialize hands back a session id we must carry on later requests.
    const session = res.headers.get("mcp-session-id");
    if (session) this.#sessionId = session;

    const msg = await this.#readResponse(res, id);
    if (msg.error) throw new Error(msg.error.message ?? "MCP error");
    return msg.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) return;
    // Notifications carry no id and expect a 202/empty acknowledgement.
    const res = await this.#post({ jsonrpc: "2.0", method, params: params ?? {} });
    // Drain any body so the socket can be reused; we ignore the content.
    await res.body?.cancel().catch(() => {});
  }

  close(): void {
    this.#closed = true;
  }

  #post(message: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.#headers,
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;

    // Bound every request with a timeout, and also honor a caller's abort, by
    // driving one AbortController from both. (Manual rather than
    // AbortSignal.timeout/any so it types cleanly under lib ES2023.)
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`MCP HTTP request to "${this.#name}" timed out after ${HTTP_REQUEST_TIMEOUT_MS}ms`)),
      HTTP_REQUEST_TIMEOUT_MS,
    );
    const onCallerAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    return fetch(this.#url, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal }).finally(
      () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onCallerAbort);
      },
    );
  }

  /** Read one JSON-RPC response from either a JSON body or an SSE stream. */
  async #readResponse(
    res: Response,
    id: number,
  ): Promise<{ id?: unknown; result?: unknown; error?: { message?: string } }> {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await res.text();
      return this.#parseSse(text, id);
    }
    // Default to JSON: one JSON-RPC response object in the body.
    return (await res.json()) as { id?: unknown; result?: unknown; error?: { message?: string } };
  }

  /** Pull the JSON-RPC response matching `id` out of an SSE stream body. */
  #parseSse(text: string, id: number): { id?: unknown; result?: unknown; error?: { message?: string } } {
    // SSE events are separated by blank lines; data may span multiple `data:` lines.
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(data);
      } catch {
        continue;
      }
      if (msg.id === id) return msg;
    }
    throw new Error(`MCP HTTP server "${this.#name}" returned no response for request ${id}`);
  }
}

/**
 * One connected MCP server: pairs a transport with the cached tool list. The
 * transport choice (stdio vs HTTP) is the only thing that varies; the handshake
 * and tool enumeration below are transport-agnostic.
 */
class McpConnection {
  readonly name: string;
  readonly #transport: Transport;
  tools: McpTool[] = [];

  constructor(def: ServerDef) {
    this.name = def.name;
    this.#transport = isHttpDef(def) ? new HttpTransport(def) : new StdioTransport(def);
  }

  /** Run the handshake and load the tool list. Throws if the server misbehaves. */
  async start(): Promise<void> {
    await this.#transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "eagent", version: "0.1" },
    });
    await this.#transport.notify("notifications/initialized");
    const listed = (await this.#transport.request("tools/list", {})) as { tools?: McpTool[] } | undefined;
    // MCP servers are foreign code we don't vouch for; don't trust the shape of
    // their enumeration. Keep only entries with a non-empty string name (a bad
    // entry would otherwise register as `mcp__srv__undefined`).
    this.tools = (listed?.tools ?? []).filter(
      (t): t is McpTool => Boolean(t) && typeof (t as McpTool).name === "string" && (t as McpTool).name.length > 0,
    );
  }

  /** Proxy a JSON-RPC request to the underlying transport. */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.#transport.request(method, params, signal);
  }

  dispose(): void {
    this.#transport.close();
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
      const fullName = `mcp__${def.name}__${toolName}`;
      // Surface a shadow rather than let "later wins" silently override a tool an
      // earlier registration (e.g. a server listing the same tool name twice) put
      // in place — the registry stacks it, but the operator should know.
      if (e.agent.tools.has(fullName)) {
        e.log.warn(`MCP tool "${fullName}" shadows an already-registered tool; the later registration wins.`);
      }
      // Tool-poisoning check: the description rides into the model's context, so
      // flag hidden instructions before they can steer the agent.
      const suspicious = detectSuspiciousDescription(tool.description ?? "");
      if (suspicious.length > 0) {
        e.log.warn(
          `MCP tool "${fullName}" has a suspicious description (possible tool-poisoning: ${suspicious.join(", ")}); ` +
            `review it before granting mcp:call.`,
        );
      }
      e.registerTool(
        defineTool({
          name: fullName,
          description: tool.description ?? `MCP tool "${toolName}" from server "${def.name}".`,
          capabilities: ["mcp:call"],
          parameters:
            tool.inputSchema && typeof tool.inputSchema === "object"
              ? tool.inputSchema
              : { type: "object", properties: {} },
          execute: async (args, ctx) => {
            await ctx.require("mcp:call");
            try {
              const result = (await connection.request(
                "tools/call",
                { name: toolName, arguments: args },
                ctx.signal,
              )) as McpCallResult | undefined;
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
export function parseServers(warn: (msg: string) => void, raw: string | undefined): ServerDef[] {
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
  const seen = new Set<string>();
  for (const entry of parsed) {
    const e = entry as Partial<StdioServerDef & HttpServerDef> | null;
    const isHttp = !!e && typeof e === "object" && typeof e.name === "string" && typeof e.url === "string";
    const isStdio = !!e && typeof e === "object" && typeof e.name === "string" && typeof e.command === "string";
    if (!isHttp && !isStdio) {
      warn("Skipping MCP server entry missing string name with command or url.");
      continue;
    }
    const name = (e as { name: string }).name;
    // Server names namespace every tool (mcp__<name>__<tool>); a duplicate name
    // would let a later server silently shadow an earlier one's tools — a
    // trust-boundary event, not a convenience. Skip it loudly.
    if (seen.has(name)) {
      warn(`Skipping duplicate MCP server name "${name}"; a later server must not shadow an earlier one's tools.`);
      continue;
    }
    seen.add(name);
    out.push(entry as ServerDef);
  }
  return out;
}
