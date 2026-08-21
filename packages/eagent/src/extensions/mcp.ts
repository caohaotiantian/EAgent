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

import { defineTool, fail, ok } from "../kernel/define.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import type { Config } from "../kernel/store.ts";
import type { JSONSchema } from "../kernel/types.ts";
import { getTraceparent, isTrustedHost, propagateAllowlist } from "./lib/otel-context.ts";
import { readCapped } from "./lib/read-capped.ts";

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

/** A resource as described by an MCP server's `resources/list`. */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** The textual shape of an MCP `resources/read` result. */
interface McpReadResult {
  contents?: Array<{ uri?: string; text?: string; blob?: string; mimeType?: string }>;
}

const PROTOCOL_VERSION = "2024-11-05";

/**
 * Defensive cap on the cached catalog: a server may publish an enormous
 * `resources/list`, and we only need enough for the model to discover what to
 * read. A single fixed bound (not a behavioral lever) on memory/context.
 */
const MAX_RESOURCES = 1000;

/**
 * Narrow a foreign `resources/list` payload to the resources we trust to act on:
 * objects with a non-empty string `uri`. MCP servers are foreign code we don't
 * vouch for, so — exactly like the tool-list filter in `start()` — we re-validate
 * the shape rather than trust it. A non-array payload (or a non-array
 * `resources`) yields `[]`. Capped at `MAX_RESOURCES`.
 */
export function parseResourceList(raw: unknown): McpResource[] {
  const list = (raw as { resources?: unknown } | null | undefined)?.resources;
  if (!Array.isArray(list)) return [];
  const out: McpResource[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Partial<McpResource>;
    if (typeof r.uri !== "string" || r.uri.length === 0) continue;
    const resource: McpResource = { uri: r.uri };
    if (typeof r.name === "string") resource.name = r.name;
    if (typeof r.description === "string") resource.description = r.description;
    if (typeof r.mimeType === "string") resource.mimeType = r.mimeType;
    out.push(resource);
    if (out.length >= MAX_RESOURCES) break;
  }
  return out;
}

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
/**
 * Per-request timeout for BOTH transports (`mcp.requestTimeoutMs`, default 60s).
 * A server that accepts a request but never answers — including a stdio server
 * that stalls the `initialize` handshake — must not block activation or a turn
 * indefinitely (invalid/≤0 → default).
 */
export function mcpRequestTimeoutMs(config: Config): number {
  const n = config.int("mcp.requestTimeoutMs", 60_000);
  return Number.isInteger(n) && n > 0 ? n : 60_000;
}

/**
 * Environment for a stdio MCP subprocess, built default-deny: a minimal base set
 * (so the server can find its interpreter and run), plus an operator opt-in
 * passthrough (`mcp.envPassthrough`, comma-separated var names), plus the server's
 * own `def.env` (which wins). The full host environment — including API keys and
 * `EAGENT_TOKEN` — is NOT handed to foreign server code.
 */
const BASE_ENV_KEYS = [
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
  "SHELL", "USER", "LOGNAME", "SystemRoot", "COMSPEC", "PATHEXT", "WINDIR", "APPDATA", "LOCALAPPDATA",
];

/** A variable name that reads as a secret. `mcp.envPassthrough` is a value key that
 *  resolves through the project config FILE layer, so an untrusted `./.eagent/config.json`
 *  could otherwise name `ANTHROPIC_API_KEY`/`EAGENT_TOKEN` here and exfiltrate the host's
 *  secrets into a foreign server subprocess. Deny secret-shaped names regardless of the
 *  passthrough source — honoring stdioEnv's default-deny contract. */
const SECRET_ENV_NAME = /API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(^|_)(KEY|AUTH|TOKEN)S?($|_)/i;

export function stdioEnv(def: StdioServerDef, config: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  for (const k of (config.string("mcp.envPassthrough") ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (SECRET_ENV_NAME.test(k)) continue; // never hand a secret-shaped var to foreign server code
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return { ...out, ...(def.env ?? {}) };
}

/**
 * OOM-safety cap on a single MCP transport read (`EAGENT_MAX_MCP_READ_BYTES`,
 * default 16 MiB — far above any legitimate MCP response/line; invalid/≤0 → default).
 */
export function maxMcpReadBytes(config: Config): number {
  const n = config.int("mcp.maxReadBytes", 16 * 1024 * 1024);
  return Number.isInteger(n) && n > 0 ? n : 16 * 1024 * 1024;
}

/**
 * A byte-bounded, newline-delimited line reader for the stdio transport. It
 * buffers raw bytes (never a partial-UTF-8 string) and emits each complete
 * `\n`-terminated line decoded as one whole UTF-8 string — since `0x0A` cannot
 * occur inside a UTF-8 multibyte sequence, splitting on the byte never bisects a
 * character, so a multibyte char straddling two chunks is not corrupted. When
 * the un-terminated residual exceeds `cap` with no newline, the reader drops it
 * and discards further bytes up to (and including) the next `\n`, so a hostile
 * no-newline flood cannot grow the retained buffer past `cap`. `buffered()`
 * exposes the residual byte count and `discarding()` the drop state, for tests.
 */
export function createBoundedLineReader(
  cap: number,
  onLine: (line: string) => void,
): { push(chunk: Buffer): void; buffered(): number; discarding(): boolean } {
  let residual: Buffer = Buffer.alloc(0);
  let discarding = false;
  return {
    push(chunk: Buffer): void {
      residual = residual.length === 0 ? chunk : Buffer.concat([residual, chunk]);
      for (;;) {
        const nl = residual.indexOf(0x0a);
        if (discarding) {
          if (nl === -1) {
            residual = Buffer.alloc(0);
            return;
          }
          residual = residual.subarray(nl + 1);
          discarding = false;
          continue;
        }
        if (nl === -1) {
          if (residual.length > cap) {
            discarding = true;
            residual = Buffer.alloc(0);
          }
          return;
        }
        const line = residual.subarray(0, nl);
        residual = residual.subarray(nl + 1);
        onLine(line.toString("utf8"));
      }
    },
    buffered: () => residual.length,
    discarding: () => discarding,
  };
}

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
  request(method: string, params: unknown, signal?: AbortSignal, callId?: string): Promise<unknown>;
  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): Promise<void>;
  /** Tear down the transport, rejecting anything still pending. */
  close(): void;
}

/**
 * stdio transport: owns the subprocess, the line reader, and the JSON-RPC
 * id→promise correlation table.
 */
export class StdioTransport implements Transport {
  readonly #name: string;
  readonly #child: ChildProcess;
  readonly #config: Config;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #closed = false;

  constructor(def: StdioServerDef, config: Config) {
    this.#name = def.name;
    this.#config = config;
    this.#child = spawn(def.command, def.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: stdioEnv(def, config),
    });
    // A spawn failure (bad command) surfaces asynchronously; reject everything.
    this.#child.on("error", (err) => this.#failAll(err));
    this.#child.on("exit", () => this.#failAll(new Error(`MCP server "${this.#name}" exited`)));
    // Server logs/diagnostics go to stderr; we deliberately ignore them.
    this.#child.stderr?.resume();

    const reader = createBoundedLineReader(maxMcpReadBytes(config), (line) => this.#onLine(line));
    this.#child.stdout!.on("data", (c: Buffer) => reader.push(c));
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`MCP server "${this.#name}" is closed`));
    if (signal?.aborted) return Promise.reject(new Error(`MCP request to "${this.#name}" aborted`));
    const id = this.#nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = mcpRequestTimeoutMs(this.#config);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const onAbort = (): void => {
        if (this.#pending.delete(id)) {
          clearTimeout(timer);
          reject(new Error(`MCP request to "${this.#name}" aborted`));
        }
      };
      // Wrap so settling the request also clears the timeout and detaches the
      // abort listener — no leak whether the response arrives, the server exits,
      // the request times out, or the caller aborts.
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      // A ref'd timer (unlike AbortSignal.timeout) so a hung server can't stall
      // the handshake/turn forever, and the deadline reliably fires.
      timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          signal?.removeEventListener("abort", onAbort);
          reject(new Error(`MCP request to "${this.#name}" (${method}) timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
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
  readonly #config: Config;
  #sessionId: string | undefined;
  #nextId = 1;
  #closed = false;

  constructor(def: HttpServerDef, config: Config) {
    this.#name = def.name;
    this.#url = def.url;
    this.#headers = def.headers ?? {};
    this.#config = config;
  }

  async request(method: string, params: unknown, signal?: AbortSignal, callId?: string): Promise<unknown> {
    if (this.#closed) throw new Error(`MCP server "${this.#name}" is closed`);
    const id = this.#nextId++;
    const { res, done } = await this.#post({ jsonrpc: "2.0", id, method, params }, signal, callId);
    try {
      if (!res.ok) {
        throw new Error(`MCP HTTP ${method} failed: ${res.status} ${res.statusText}`);
      }
      // initialize hands back a session id we must carry on later requests.
      const session = res.headers.get("mcp-session-id");
      if (session) this.#sessionId = session;

      const msg = await this.#readResponse(res, id);
      if (msg.error) throw new Error(msg.error.message ?? "MCP error");
      return msg.result;
    } finally {
      done(); // tear down the deadline only after the body read completes
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) return;
    // Notifications carry no id and expect a 202/empty acknowledgement.
    const { res, done } = await this.#post({ jsonrpc: "2.0", method, params: params ?? {} });
    try {
      // Drain any body so the socket can be reused; we ignore the content.
      await res.body?.cancel().catch(() => {});
    } finally {
      done();
    }
  }

  close(): void {
    this.#closed = true;
  }

  #post(message: unknown, signal?: AbortSignal, callId?: string): Promise<{ res: Response; done: () => void }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.#headers,
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    // Propagate the tool-call traceparent to an allowlisted MCP host (only
    // while otel traces are on — the map's sole writer). Notifications pass no callId.
    const tp = callId ? getTraceparent(callId) : undefined;
    if (tp && isTrustedHost(this.#url, propagateAllowlist(this.#config.string("otel.propagateHosts") ?? ""))) headers["traceparent"] = tp;

    // Bound every request with a timeout, and also honor a caller's abort, by
    // driving one AbortController from both. (Manual rather than
    // AbortSignal.timeout/any so it types cleanly under lib ES2023.)
    const controller = new AbortController();
    const timeoutMs = mcpRequestTimeoutMs(this.#config);
    const timer = setTimeout(
      () => controller.abort(new Error(`MCP HTTP request to "${this.#name}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onCallerAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    // The deadline must span the whole request→response, not just time-to-headers:
    // a server that flushes headers then stalls the body would otherwise hang the
    // body read (which runs after fetch() resolves) with the timer already cleared.
    // `done()` tears the timer down only once the caller has finished the body.
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    };
    return fetch(this.#url, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal }).then(
      (res) => ({ res, done }),
      (err) => {
        done();
        throw err;
      },
    );
  }

  /** Read one JSON-RPC response from either a JSON body or an SSE stream. */
  async #readResponse(
    res: Response,
    id: number,
  ): Promise<{ id?: unknown; result?: unknown; error?: { message?: string } }> {
    const contentType = res.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream");
    // No stream to cap (some runtimes may not expose `.body`): fall back to the
    // uncapped per-branch reads (mirrors web.ts's null-body fallback).
    if (!res.body) {
      if (isSse) return this.#parseSse(await res.text(), id);
      return (await res.json()) as { id?: unknown; result?: unknown; error?: { message?: string } };
    }
    // Bound the read so a hostile/broken server cannot OOM the host, then throw a
    // clear error on overflow — a truncated JSON/SSE slice is unparseable.
    const { text, truncated } = await readCapped(res.body, maxMcpReadBytes(this.#config));
    if (truncated) {
      throw new Error(`MCP HTTP response from "${this.#name}" exceeded ${maxMcpReadBytes(this.#config)} bytes`);
    }
    if (isSse) return this.#parseSse(text, id);
    // Default to JSON: one JSON-RPC response object in the body.
    return JSON.parse(text) as { id?: unknown; result?: unknown; error?: { message?: string } };
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
  readonly #warn: (msg: string) => void;
  readonly #config: Config;
  tools: McpTool[] = [];
  /** The read-only data half: cached `resources/list` catalog (bodies read live). */
  resources: McpResource[] = [];
  /** The server's advertised `initialize` capabilities, used as a skip hint. */
  #serverCapabilities: Record<string, unknown> = {};

  constructor(def: ServerDef, config: Config, warn: (msg: string) => void = () => {}) {
    this.name = def.name;
    this.#warn = warn;
    this.#config = config;
    this.#transport = isHttpDef(def) ? new HttpTransport(def, config) : new StdioTransport(def, config);
  }

  /** Run the handshake and load the tool list. Throws if the server misbehaves. */
  async start(): Promise<void> {
    const init = (await this.#transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "eagent", version: "0.1" },
    })) as { capabilities?: Record<string, unknown> } | undefined;
    // Capture the server's advertised capabilities; used below as a cheap skip
    // hint for the resources half (the controlling behavior is fail-soft).
    this.#serverCapabilities = init?.capabilities && typeof init.capabilities === "object" ? init.capabilities : {};
    await this.#transport.notify("notifications/initialized");
    const listed = (await this.#transport.request("tools/list", {})) as { tools?: McpTool[] } | undefined;
    // MCP servers are foreign code we don't vouch for; don't trust the shape of
    // their enumeration. Keep only entries with a non-empty string name (a bad
    // entry would otherwise register as `mcp__srv__undefined`).
    this.tools = (listed?.tools ?? []).filter(
      (t): t is McpTool => Boolean(t) && typeof (t as McpTool).name === "string" && (t as McpTool).name.length > 0,
    );
    // The read-only data half: enumerate resources, mirroring tools/list. Fully
    // additive — the tools path above is unchanged.
    await this.#loadResources();
  }

  /**
   * Enumerate `resources/list` into the cached catalog. Gated by the kill switch
   * and the advertised-capability skip hint; fail-soft on any error or garbage
   * payload (empty catalog, never throws) — the same tolerance `tools/list` has.
   */
  async #loadResources(): Promise<void> {
    if (!this.#config.enabled("mcp.resources", { default: true })) {
      this.resources = [];
      return;
    }
    // Skip hint: a server that clearly does not advertise `resources` is not
    // probed (saves a round-trip). Foreign servers aren't trusted to advertise
    // honestly, so this is an optimization, not the correctness boundary.
    if (!("resources" in this.#serverCapabilities)) {
      this.resources = [];
      return;
    }
    try {
      const raw = await this.#transport.request("resources/list", {});
      this.resources = parseResourceList(raw);
    } catch (err) {
      this.#warn(`MCP server "${this.name}" resources/list failed: ${(err as Error).message}`);
      this.resources = [];
    }
  }

  /** Re-run `resources/list` and refresh the cached catalog in place. */
  async refreshResources(): Promise<void> {
    await this.#loadResources();
  }

  /** Proxy a JSON-RPC request to the underlying transport. */
  request(method: string, params: unknown, signal?: AbortSignal, callId?: string): Promise<unknown> {
    return this.#transport.request(method, params, signal, callId);
  }

  dispose(): void {
    this.#transport.close();
  }
}

export default async function activate(e: ExtensionAPI): Promise<() => void> {
  e.grantCapability("mcp:call");
  // Reading a server's resources is a distinct, read-only privilege from calling
  // its (possibly mutating) tools, so it gets its own capability.
  e.grantCapability("mcp:read");

  const connections: McpConnection[] = [];

  for (const def of parseServers(e.log.warn, e.config.string("mcp.servers"))) {
    let conn: McpConnection | undefined;
    try {
      conn = new McpConnection(def, e.config, e.log.warn);
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
      // warn the operator about suspicious descriptions that may hide
      // instructions (advisory only — this never blocks registration or calls).
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
                ctx.toolCallId, // lets HttpTransport inject the traceparent
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

    // The read-only data half: register one `read_resource` tool per server that
    // actually has a catalog (a resource-less server gets none). The
    // catalog is cached; bodies are read live. Gated by `mcp:read`.
    if (conn.resources.length > 0) {
      const connection = conn;
      const fullName = `mcp__${def.name}__read_resource`;
      if (e.agent.tools.has(fullName)) {
        e.log.warn(`MCP tool "${fullName}" shadows an already-registered tool; the later registration wins.`);
      }
      const sample = connection.resources
        .slice(0, 5)
        .map((r) => r.uri)
        .join(", ");
      e.registerTool(
        defineTool({
          name: fullName,
          description:
            `Read a resource published by MCP server "${def.name}" by URI ` +
            `(${connection.resources.length} available, e.g. ${sample}).`,
          capabilities: ["mcp:read"],
          parameters: {
            type: "object",
            properties: { uri: { type: "string", description: "The resource URI to read." } },
            required: ["uri"],
          },
          execute: async (args, ctx) => {
            await ctx.require("mcp:read");
            const uri = (args as { uri?: unknown }).uri;
            if (typeof uri !== "string" || uri.length === 0) {
              return fail("MCP resource read failed: a non-empty string `uri` is required.");
            }
            try {
              const result = (await connection.request("resources/read", { uri }, ctx.signal)) as
                | McpReadResult
                | undefined;
              // Surface concatenated text parts; binary `blob` parts are ignored.
              const content = (result?.contents ?? [])
                .filter((c) => typeof c.text === "string")
                .map((c) => c.text)
                .join("");
              return ok(content, result);
            } catch (err) {
              // Fail-open per resource: one bad URI must not throw out of the tool.
              return fail(`MCP resource read failed: ${(err as Error).message}`);
            }
          },
        }),
      );
    }

    e.log.info(
      `MCP server "${def.name}" connected with ${conn.tools.length} tool(s) and ${conn.resources.length} resource(s).`,
    );
  }

  e.registerCommand({
    name: "mcp",
    description:
      "Inspect connected MCP servers. Usage: /mcp [resources [server]|refresh] " +
      "(bare: tool + resource counts; resources: the cached catalog; refresh: re-enumerate resources).",
    run: async (ctx) => {
      if (connections.length === 0) {
        ctx.print("(no MCP servers connected)");
        return;
      }
      const [sub, server] = ctx.args.trim().split(/\s+/);
      if (sub === "resources") {
        const shown = server ? connections.filter((c) => c.name === server) : connections;
        for (const conn of shown) {
          ctx.print(`  ${conn.name} (${conn.resources.length} resource(s)):`);
          for (const r of conn.resources) ctx.print(`    ${r.uri}`);
        }
        return;
      }
      if (sub === "refresh") {
        for (const conn of connections) await conn.refreshResources();
        ctx.print("(refreshed MCP resource catalogs)");
        for (const conn of connections) {
          ctx.print(`  ${conn.name.padEnd(20)} ${conn.resources.length} resource(s)`);
        }
        return;
      }
      for (const conn of connections) {
        ctx.print(`  ${conn.name.padEnd(20)} ${conn.tools.length} tool(s), ${conn.resources.length} resource(s)`);
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
    warn("mcp.servers (EAGENT_MCP_SERVERS) is not valid JSON; ignoring.");
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn("mcp.servers (EAGENT_MCP_SERVERS) must be a JSON array; ignoring.");
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
