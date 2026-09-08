/**
 * Talking to an MCP server over stdio, so a Loom graph can use tools it did not ship with.
 *
 * `builtin/tools.ts` is deliberately tiny and everything else is meant to be a plugin — but
 * until now "a plugin" meant writing TypeScript against `ToolDefinition` and rebuilding.
 * MCP is the ecosystem answer to that, and it costs nothing this repo cannot afford: the
 * wire format is newline-delimited JSON-RPC over a child process's stdio, so `node:child_process`
 * is the whole dependency and invariant 1 is untouched.
 *
 * SCOPE, stated so its absence is not mistaken for an oversight. Tools only — no
 * `resources/*`, no `prompts/*` — and stdio only, no Streamable HTTP. Both are additive and
 * neither is needed to answer the question this file exists for, which is whether a Loom
 * graph can call a tool a third party wrote. `DEFERRED: resources, prompts, HTTP transport`.
 *
 * FOREIGN CODE IS NOT TRUSTED TO DESCRIBE ITSELF. Everything a server sends is re-validated
 * here — a tool entry without a string name is dropped rather than registered as
 * `mcp__srv__undefined`, and a result whose `content` is not the documented shape becomes an
 * error result rather than a crash. The server is a different program written by somebody
 * else; the only thing its enumeration proves is what it *claims*.
 *
 * FORKED IN PART from `packages/eagent/src/extensions/mcp.ts` at tag `eagent-v1` (that package
 * was deleted from this tree on 2026-08-25, so the path resolves only at the tag) — the bounded line
 * reader below is its design, unchanged, because it gets the one property that matters right.
 *
 * A FORK RATHER THAN AN IMPORT, and it stays one. `@loom/core` has zero runtime dependencies
 * and may not import a sibling package (invariant 1), and `build:binary` bundles core's entry
 * alone — so an import here would put the capability outside the single binary that IS the
 * deployment. The original is now in this repo, so the two can be diffed rather than trusted.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { CODES, err } from "../errors.ts";
import { specProblem } from "./spec-shape.ts";

/** The MCP revision this client speaks. Sent on `initialize` and not negotiated. */
const PROTOCOL_VERSION = "2024-11-05";

/** A tool as an MCP server describes it. Every field is a claim, not a fact. */
export interface McpToolSpec {
  readonly name: string;
  readonly description?: string | null;
  readonly inputSchema?: unknown;
}

export interface McpClientOptions {
  /** Display name; prefixes every registered tool as `mcp__<name>__<tool>`. */
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * Environment variable NAMES to pass through, and nothing else.
   *
   * Default-deny for the same reason `proc.exec` defaults that way: this process holds
   * provider API keys, and an MCP server is somebody else's program.
   */
  readonly envAllow?: readonly string[];
  readonly cwd?: string;
  /** Per-request deadline. A server that never answers must not wedge a run. */
  readonly timeoutMs?: number;
}

/**
 * Split a byte stream into lines WITHOUT growing without bound.
 *
 * A server that writes a gigabyte with no newline is not a protocol error this client can
 * report — there is nothing to report it about yet — so the only choices are to buffer it
 * (and die of memory) or to drop it. Dropping is right, and it must drop *through* the next
 * newline so the following message starts clean rather than being parsed as the tail of the
 * garbage. That is the whole reason this is not a two-line `split("\n")`.
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

const LINE_CAP = 8 * 1024 * 1024;

/**
 * One MCP server, spoken to over its stdin/stdout.
 *
 * Deliberately not an EventEmitter and deliberately not reconnecting. A server that dies
 * takes its tools with it and every in-flight request rejects; deciding whether to restart
 * it is the embedder's, because restarting a stateful server silently is how a tool call
 * lands in a session that no longer exists.
 */
export class McpClient {
  readonly name: string;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly #opts: McpClientOptions;
  #tools: readonly McpToolSpec[] = [];
  #rejectedTools: readonly { readonly name: string; readonly reason: string }[] = [];
  #closed = false;

  constructor(opts: McpClientOptions) {
    this.#opts = opts;
    this.name = opts.name;
  }

  /** What the server said it has, after `start`. Empty before it, and after a failure. */
  get tools(): readonly McpToolSpec[] {
    return this.#tools;
  }

  /**
   * What `tools/list` offered and this client refused, with the reason.
   *
   * A dropped tool is a fact about a third party, and a drop nobody can see is the same silence
   * the unvalidated forward had. `start` records rather than throws; see the comment there.
   *
   * READ BY `mcpRejectionWarnings` in `cli.ts`, which writes one stderr line per entry right
   * after `startMcp` returns. Until it did, the fact was available to a library embedder and not
   * to the operator this paragraph invokes: under `loom serve` a legitimate server whose
   * description runs past `MAX_DESCRIPTION_CHARS` simply stopped offering that tool with no line
   * anywhere, and it was diagnosed as "the model did not call the tool".
   */
  get rejectedTools(): readonly { readonly name: string; readonly reason: string }[] {
    return this.#rejectedTools;
  }

  /**
   * Spawn, handshake, and enumerate.
   *
   * Throws if any of the three fails. A half-started client is worse than none: it would
   * register no tools and report no reason, which is the shape of failure that gets
   * diagnosed as "the model did not call the tool".
   */
  async start(): Promise<void> {
    const env: Record<string, string> = {};
    for (const key of this.#opts.envAllow ?? []) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }

    const child = spawn(this.#opts.command, [...(this.#opts.args ?? [])], {
      // `shell: false` is the default and is load-bearing: a command line assembled as a
      // string is how argument injection happens, which `sandbox/subprocess.ts` says at
      // length about the same decision.
      stdio: ["pipe", "pipe", "pipe"],
      env,
      ...(this.#opts.cwd === undefined ? {} : { cwd: this.#opts.cwd }),
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;

    const reader = createBoundedLineReader(LINE_CAP, (line) => this.#onLine(line));
    child.stdout.on("data", (c: Buffer) => reader.push(c));
    // NO LISTENER MAY THROW. These are called from Node's event loop with no `try` above
    // the frame, so an exception here ends the process — the same rule `runSandboxed`
    // states about its four emitters, for the same reason.
    child.stdout.on("error", () => this.#failAll(new Error("mcp stdout errored")));
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => {});
    child.on("error", (e: Error) => this.#failAll(e));
    child.on("exit", (code) => this.#failAll(new Error(`mcp server "${this.name}" exited with code ${String(code)}`)));

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "loom", version: "0.0.0" },
    });
    this.notify("notifications/initialized");

    const listed = (await this.request("tools/list", {})) as { tools?: unknown } | undefined;
    const raw = Array.isArray(listed?.tools) ? listed.tools : [];
    // RE-VALIDATED, NOT TRUSTED — and this used to check the NAME and nothing else, in the file
    // whose headline claim is that foreign code is not trusted to describe itself. `description`
    // is typed `string` and `inputSchema` is typed as a schema, and a server answering
    // `{name:"search", description:{evil:"…"}, inputSchema:42}` had both forwarded into the
    // provider request the model reads, past `checkManifest`, with the type annotations stopping
    // nothing. A duplicate `name` was the third: two entries registered, the second silently
    // shadowing the first, so the manifest the compiler used to compute a posture floor need not
    // describe the definition that executes.
    //
    // DROPPED RATHER THAN THROWN, because one malformed entry must not cost an operator every
    // other tool the server offers — the goal is a runtime somebody can install and use. The
    // drops are recorded on `rejectedTools` so the fact is available rather than silent, and
    // `mcpTools` re-checks and THROWS, because a spec that fails there came from a caller who
    // built the client by hand, which is a programming error and not a third party.
    const rejected: { name: string; reason: string }[] = [];
    const kept = new Map<string, McpToolSpec>();
    for (const entry of raw) {
      const t = entry as Record<string, unknown> | null;
      const name = typeof t === "object" && t !== null ? t["name"] : undefined;
      if (typeof name !== "string" || name.length === 0) {
        rejected.push({ name: String(name), reason: "name is not a non-empty string" });
        continue;
      }
      const bad = specProblem(t as unknown as McpToolSpec);
      if (bad !== undefined) {
        rejected.push({ name, reason: bad });
        continue;
      }
      // FIRST WINS, so a server cannot shadow an entry after this enumeration has read it.
      if (kept.has(name)) {
        rejected.push({ name, reason: "a duplicate of an earlier entry from the same server" });
        continue;
      }
      kept.set(name, t as unknown as McpToolSpec);
    }
    this.#tools = [...kept.values()];
    this.#rejectedTools = rejected;
  }

  /** One JSON-RPC request, with a deadline. */
  async request(method: string, params: unknown): Promise<unknown> {
    const child = this.#child;
    if (child === undefined || this.#closed) {
      throw err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, `mcp server "${this.name}" is not running`);
    }
    const id = this.#nextId++;
    const body = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(err.timeout(CODES.E_TOOL_TIMEOUT, `mcp server "${this.name}" did not answer ${method} in time`));
      }, this.#opts.timeoutMs ?? 30_000);
      // Unref'd so a pending MCP call cannot by itself hold the process open — the run's
      // own lifecycle decides when to exit, not a third party's silence.
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(body, (e) => {
        if (e === null || e === undefined) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, `mcp server "${this.name}" stdin: ${e.message}`));
      });
    });
  }

  /** A notification has no id and no reply, so there is nothing to await. */
  notify(method: string): void {
    this.#child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  close(): void {
    this.#closed = true;
    this.#failAll(new Error(`mcp server "${this.name}" was closed`));
    this.#child?.kill();
    this.#child = undefined;
  }

  #onLine(line: string): void {
    if (line.trim() === "") return;
    let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      // A server that emits a non-JSON line is logging to the wrong stream. Ignoring it is
      // right: rejecting every in-flight request over one stray line would make a chatty
      // server unusable, and the request's own deadline still bounds the damage.
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = this.#pending.get(msg.id);
    if (waiter === undefined) return;
    this.#pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error !== undefined) {
      waiter.reject(err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, `mcp: ${msg.error.message ?? "error"}`));
      return;
    }
    waiter.resolve(msg.result);
  }

  /** Reject everything in flight. Called on every terminal condition, so none of them hang. */
  #failAll(e: Error): void {
    for (const [, w] of this.#pending) {
      clearTimeout(w.timer);
      w.reject(err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, e.message));
    }
    this.#pending.clear();
  }
}
