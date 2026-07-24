/**
 * The `SessionSource` abstraction (design D2, KDD3): one interface the TUI view
 * consumes — an ordered, attribution-tagged lifecycle event stream plus a control
 * surface (run a turn, answer an elicitation, stop) — with two backends.
 *
 *   - `InProcessSource` wraps a local `Agent`. It tags the agent's hook-bus events
 *     via the shared in-process attribution adapter (`wireEvents`), so concurrent
 *     fork/subagent streams de-interleave by acting agent exactly as the engine
 *     plain renderer does. run/stop drive the agent; `ask` is the UI.ask sink the
 *     host wires in so mid-turn elicitations surface as `action_required` events
 *     that `answer` settles.
 *   - `RemoteSource` is an HTTP+SSE client over the server's monitor endpoints. It
 *     attaches to a session's SSE feed (`GET /sessions/:id/events`), parses the
 *     server's `event: connected` + `data: {json}` frames, maps each to the same
 *     `SourceEvent` shape (reading the session id off the frame), and reconnects
 *     with backoff after a dropped connection. Control rides POST /run, POST
 *     /answer, POST /sessions/:id/stop.
 *
 * This module lives under `src/tui/` — it is a TUI concern the engine never
 * imports — but it depends only on the neutral shared cores (`../attribution.ts`,
 * `../view-model.ts` types) and Node `http`/`https`; no Ink/React here.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import type { Agent } from "../kernel/agent.js";
import type { Disposable, Role, StopReason, ToolCallBlock, ToolResult, Usage } from "../kernel/types.js";
import { wireEvents } from "../attribution.js";
import type { TaggedEvent } from "../view-model.js";

/**
 * The one event shape both backends yield. The reducer-foldable render events
 * (`TaggedEvent`, keyed by acting agent) drive a transcript; the connection +
 * accounting + elicitation meta events (which the reducer does not fold) let the
 * monitor track status and answer prompts. All discriminate on `kind`; the render
 * kinds (agent_start/reasoning_delta/text_delta/tool_start/tool_end/message/
 * agent_end) never collide with the meta kinds below.
 */
export type SourceEvent =
  | TaggedEvent
  | { kind: "connected"; session: string | null }
  | { kind: "reconnected"; session: string | null }
  | { kind: "usage"; usage: Usage; cumulative: Usage }
  | { kind: "error"; where: string; message: string }
  | { kind: "action_required"; id: number; question: string; options: string[] | null };

/** The interface the TUI view consumes: an event stream + a bounded control surface. */
export interface SessionSource {
  /** Subscribe to the ordered event stream; dispose to unsubscribe. */
  subscribe(listener: (event: SourceEvent) => void): Disposable;
  /** Drive one turn; the terminal `agent_end` arrives on the event stream. */
  run(input: string): Promise<void>;
  /** Answer a pending elicitation. Resolves true when a matching prompt was live. */
  answer(id: number, answer: string): Promise<boolean>;
  /** Abort an in-flight turn. */
  stop(): Promise<void>;
  /** Tear down subscriptions / connections. */
  close(): void;
}

// -- InProcessSource ----------------------------------------------------------

export class InProcessSource implements SessionSource {
  readonly #agent: Agent;
  readonly #listeners = new Set<(event: SourceEvent) => void>();
  #subs: Disposable[];
  readonly #pending = new Map<number, (answer: string | null) => void>();
  #nextAskId = 1;

  constructor(agent: Agent, opts: { now?: () => number } = {}) {
    this.#agent = agent;
    // Wire attribution once, on construction, and fan the tagged events out to the
    // current listener set — a fork's deltas fire these shared handlers inside the
    // fork's ALS context, so they carry the fork's acting id and de-interleave.
    this.#subs = wireEvents(agent, (event) => this.#emit(event), { now: opts.now });
  }

  #emit(event: SourceEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  subscribe(listener: (event: SourceEvent) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => void this.#listeners.delete(listener) };
  }

  async run(input: string): Promise<void> {
    await this.#agent.run(input);
  }

  stop(): Promise<void> {
    this.#agent.stop();
    return Promise.resolve();
  }

  /**
   * The `UI.ask` sink the host installs on the wrapped agent: surface the question
   * as an `action_required` event and return a promise the `answer` control settles
   * (or `close` cancels with null → the ask tool proceeds-with-assumption).
   */
  readonly ask = (question: string, options?: string[]): Promise<string | null> => {
    const id = this.#nextAskId++;
    this.#emit({ kind: "action_required", id, question, options: options ?? null });
    return new Promise<string | null>((resolve) => this.#pending.set(id, resolve));
  };

  answer(id: number, answer: string): Promise<boolean> {
    const resolve = this.#pending.get(id);
    if (!resolve) return Promise.resolve(false);
    this.#pending.delete(id);
    resolve(answer);
    return Promise.resolve(true);
  }

  close(): void {
    for (const sub of this.#subs) sub.dispose();
    this.#subs = [];
    this.#listeners.clear();
    for (const resolve of this.#pending.values()) resolve(null);
    this.#pending.clear();
  }
}

// -- SSE line parser ----------------------------------------------------------

export interface RawSseFrame {
  event?: string;
  data: string;
}

/**
 * A minimal, spec-shaped SSE parser: fed arbitrary chunks, it emits one
 * `RawSseFrame` per blank-line-terminated block. Multiple `data:` lines join with
 * a newline; `event:` names the frame; `:`-lines are comments; a frame split
 * across chunks is buffered until complete. Enough to parse exactly the frames the
 * server writes (`event: connected` + `data: {json}`) plus multi-line payloads.
 */
export class SseParser {
  #buf = "";
  #event: string | undefined;
  #data: string[] = [];

  push(chunk: string): RawSseFrame[] {
    this.#buf += chunk;
    const frames: RawSseFrame[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      let line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1); // tolerate CRLF
      if (line === "") {
        if (this.#data.length > 0 || this.#event !== undefined) {
          frames.push({ event: this.#event, data: this.#data.join("\n") });
        }
        this.#event = undefined;
        this.#data = [];
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.#event = value;
      else if (field === "data") this.#data.push(value);
      // id/retry fields are ignored — the source manages its own reconnection.
    }
    return frames;
  }
}

// -- RemoteSource -------------------------------------------------------------

export interface RemoteSourceOptions {
  /** The server base URL, e.g. `http://127.0.0.1:8787`. */
  base: string;
  /** The session id to attach to. */
  session: string;
  /** Bearer token, when the server requires auth. */
  token?: string;
  /** Timestamp clock for tagged events (default `performance.now`). */
  now?: () => number;
  /** Reconnect backoff after a dropped feed (default 1000 ms). */
  backoffMs?: number;
}

export class RemoteSource implements SessionSource {
  readonly #base: string;
  readonly #session: string;
  readonly #token: string | undefined;
  readonly #now: () => number;
  readonly #backoffMs: number;
  readonly #listeners = new Set<(event: SourceEvent) => void>();

  #req: ClientRequest | undefined;
  #res: IncomingMessage | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #streaming = false;
  #everConnected = false;

  constructor(opts: RemoteSourceOptions) {
    this.#base = opts.base.replace(/\/$/, "");
    this.#session = opts.session;
    this.#token = opts.token;
    this.#now = opts.now ?? ((): number => performance.now());
    this.#backoffMs = opts.backoffMs ?? 1000;
  }

  subscribe(listener: (event: SourceEvent) => void): Disposable {
    this.#listeners.add(listener);
    // Lazily open the SSE feed on the first subscriber — a control-only client
    // (run/answer/stop) never subscribes, so it never opens a stream.
    if (!this.#streaming && !this.#closed) {
      this.#streaming = true;
      this.#connect();
    }
    return { dispose: () => void this.#listeners.delete(listener) };
  }

  #emit(event: SourceEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  /** Open the per-session SSE feed and stream frames until the connection drops. */
  #connect(): void {
    if (this.#closed) return;
    const parser = new SseParser();
    let settled = false; // one reconnect per connection, whichever end signal fires first
    const onDrop = (): void => {
      if (settled || this.#closed) return;
      settled = true;
      this.#req = undefined;
      this.#res = undefined;
      this.#timer = setTimeout(() => this.#connect(), this.#backoffMs);
      this.#timer.unref?.();
    };
    const req = this.#open("GET", `/sessions/${encodeURIComponent(this.#session)}/events`, undefined, (res) => {
      this.#res = res;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        for (const frame of parser.push(chunk)) this.#onFrame(frame);
      });
      res.on("end", onDrop);
      res.on("close", onDrop);
      res.on("error", onDrop);
    });
    req.on("error", onDrop);
    req.end();
    this.#req = req;
  }

  /** Map one SSE frame to a `SourceEvent` and emit it. */
  #onFrame(frame: RawSseFrame): void {
    let payload: Record<string, unknown>;
    try {
      payload = frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {};
    } catch {
      return; // ignore a malformed frame rather than tear the stream down
    }
    const session = typeof payload.session === "string" ? payload.session : this.#session;

    if (frame.event === "connected") {
      // The first `connected` opens the feed; a later one means the feed
      // reconnected after a drop — relabel it so the view can react.
      const kind = this.#everConnected ? "reconnected" : "connected";
      this.#everConnected = true;
      this.#emit({ kind, session });
      return;
    }

    const event = this.#frameToEvent(payload, session);
    if (event) this.#emit(event);
  }

  /** Map a `data:` frame (an `eventToJsonl` object) to a `SourceEvent`. */
  #frameToEvent(p: Record<string, unknown>, session: string): SourceEvent | undefined {
    // The remote feed has no per-agent id, so acting === root (the session): the
    // transcript stays flat, the documented remote limitation.
    const tag = { actingId: session, rootId: session, at: this.#now() };
    switch (p.type) {
      case "text_delta":
        return { kind: "text_delta", text: String(p.text ?? ""), ...tag };
      case "reasoning_delta":
        return { kind: "reasoning_delta", text: String(p.text ?? ""), ...tag };
      case "message":
        return { kind: "message", role: p.role as Role, ...tag };
      case "tool_start": {
        const call: ToolCallBlock = {
          type: "tool_call",
          id: String(p.id ?? ""),
          name: String(p.name ?? ""),
          arguments: (p.arguments as Record<string, unknown>) ?? {},
        };
        return { kind: "tool_start", call, ...tag };
      }
      case "tool_end": {
        const call: ToolCallBlock = { type: "tool_call", id: String(p.id ?? ""), name: String(p.name ?? ""), arguments: {} };
        const result: ToolResult = { content: String(p.content ?? ""), isError: Boolean(p.isError) };
        return { kind: "tool_end", call, result, ...tag };
      }
      case "agent_end":
        return { kind: "agent_end", reason: p.reason as StopReason, ...tag };
      case "usage":
        return { kind: "usage", usage: p.usage as Usage, cumulative: p.cumulative as Usage };
      case "error":
        return { kind: "error", where: String(p.where ?? ""), message: String(p.message ?? "") };
      case "action_required":
        return {
          kind: "action_required",
          id: Number(p.id),
          question: String(p.question ?? ""),
          options: Array.isArray(p.options) ? (p.options as string[]) : null,
        };
      default:
        return undefined;
    }
  }

  async run(input: string): Promise<void> {
    await this.#post("/run", { input, session: this.#session });
  }

  async answer(id: number, answer: string): Promise<boolean> {
    const { status } = await this.#post("/answer", { id, answer });
    return status >= 200 && status < 300;
  }

  async stop(): Promise<void> {
    await this.#post(`/sessions/${encodeURIComponent(this.#session)}/stop`, {});
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#res?.destroy();
    this.#req?.destroy();
    this.#listeners.clear();
  }

  // -- HTTP plumbing (Node http/https only; no fetch, no deps) ----------------

  /** POST a JSON body, drain the response, resolve its status. */
  #post(path: string, body: unknown): Promise<{ status: number }> {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = this.#open("POST", path, data, (res) => {
        res.on("data", () => {}); // drain so the socket frees
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  /** Build a request against the base URL, wiring auth + JSON headers. */
  #open(method: string, path: string, body: string | undefined, onRes: (res: IncomingMessage) => void): ClientRequest {
    const url = new URL(path, this.#base + "/");
    const isHttps = url.protocol === "https:";
    const headers: Record<string, string> = { accept: "text/event-stream, application/json" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
    };
    return (isHttps ? httpsRequest : httpRequest)(options, onRes);
  }
}
