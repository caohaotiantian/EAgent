/**
 * The per-instance monitor client (design D5): enumerates + tracks the live
 * sessions of ONE EAgent HTTP host so the monitor can observe many at once.
 *
 * It polls `GET /sessions` for the authoritative snapshot ({id, running, usage,
 * costUsd}) and subscribes to the global `GET /events` feed for sub-poll-interval
 * liveness, demuxing each frame by the `session` id it carries (the server tags
 * every global frame with its originating session). Per-session detail feeds and
 * the stop control are delegated to the P3 `RemoteSource` (reused, not
 * duplicated); this client owns only the instance-level list + the global demux.
 *
 * Neutral (no `ink`/`react`, AC9): Node `http`/`https` + the shared `SseParser`.
 * `monitor.tsx` folds one of these per configured instance into the list model.
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import type { Disposable, Usage } from "../kernel/types.js";
import { RemoteSource, SseParser, type RawSseFrame } from "./source.js";

/** One configured instance the monitor attaches to. */
export interface MonitorInstance {
  url: string;
  token?: string;
}

/** A session's live snapshot as the list renders it. */
export interface SessionInfo {
  id: string;
  running: boolean;
  usage: Usage;
  costUsd: number;
}

export interface InstanceClientOptions {
  /** Re-poll `GET /sessions` every `pollMs`; `<= 0` polls once on start only. */
  pollMs?: number;
  /** Backoff before reopening a dropped global feed (default 1000 ms). */
  backoffMs?: number;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

function isUsage(v: unknown): v is Usage {
  return typeof v === "object" && v !== null && typeof (v as Usage).inputTokens === "number" && typeof (v as Usage).outputTokens === "number";
}

export class InstanceClient {
  /** The normalized base URL (no trailing slash) — shown as the instance label. */
  readonly url: string;
  readonly #token: string | undefined;
  readonly #pollMs: number;
  readonly #backoffMs: number;
  readonly #sessions = new Map<string, SessionInfo>();
  /** Ids the user has forgotten; a persistent filter so polls + live frames never re-add them. */
  readonly #forgotten = new Set<string>();
  readonly #listeners = new Set<() => void>();

  #feedReq: ClientRequest | undefined;
  #feedRes: IncomingMessage | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  #started = false;

  constructor(instance: MonitorInstance, opts: InstanceClientOptions = {}) {
    this.url = instance.url.replace(/\/$/, "");
    this.#token = instance.token;
    this.#pollMs = opts.pollMs ?? 2000;
    this.#backoffMs = opts.backoffMs ?? 1000;
  }

  /** Subscribe to session-list changes (poll snapshots + live feed updates). */
  subscribe(onChange: () => void): Disposable {
    this.#listeners.add(onChange);
    return { dispose: () => void this.#listeners.delete(onChange) };
  }

  /** The current session snapshot (stable-sorted by the caller). */
  sessions(): SessionInfo[] {
    return [...this.#sessions.values()];
  }

  /** Begin: one immediate poll, the global feed, and (if `pollMs > 0`) periodic re-polls. */
  start(): void {
    if (this.#closed || this.#started) return;
    this.#started = true;
    void this.refresh();
    this.#openFeed();
    if (this.#pollMs > 0) {
      this.#interval = setInterval(() => void this.refresh(), this.#pollMs);
      this.#interval.unref?.();
    }
  }

  /** Poll `GET /sessions` and replace the snapshot (the authoritative source). */
  async refresh(): Promise<void> {
    if (this.#closed) return;
    let list: unknown;
    try {
      list = await this.#getJson("/sessions");
    } catch {
      return; // a transient poll failure leaves the last snapshot in place
    }
    if (!Array.isArray(list)) return;
    this.#sessions.clear();
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue;
      const s = item as Record<string, unknown>;
      if (typeof s.id !== "string") continue;
      if (this.#forgotten.has(s.id)) continue; // a forgotten session stays dropped across polls
      this.#sessions.set(s.id, {
        id: s.id,
        running: Boolean(s.running),
        usage: isUsage(s.usage) ? s.usage : ZERO_USAGE,
        costUsd: typeof s.costUsd === "number" ? s.costUsd : 0,
      });
    }
    this.#notify();
  }

  /** A per-session `RemoteSource` for the detail view (reuses P3, no duplication). */
  sourceFor(id: string): RemoteSource {
    return new RemoteSource({ base: this.url, session: id, token: this.#token });
  }

  /** Abort a running turn, then re-poll so the list reflects `running: false`. */
  async stop(id: string): Promise<void> {
    const source = this.sourceFor(id);
    try {
      await source.stop();
    } finally {
      source.close();
    }
    await this.refresh();
  }

  /**
   * Drop a session from the list client-side (the monitor's "forget" control).
   * Records the id in a persistent filter so neither the next `refresh()` poll nor
   * a session-tagged live frame re-adds it — a durable, non-destructive local
   * dismiss (unlike the server's destructive `DELETE /sessions/:id`).
   */
  forget(id: string): void {
    this.#forgotten.add(id);
    if (this.#sessions.delete(id)) this.#notify();
  }

  close(): void {
    this.#closed = true;
    if (this.#interval) clearInterval(this.#interval);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#feedRes?.destroy();
    this.#feedReq?.destroy();
    this.#listeners.clear();
  }

  // -- global feed demux ------------------------------------------------------

  #openFeed(): void {
    if (this.#closed) return;
    const parser = new SseParser();
    let settled = false; // one reopen per connection, whichever end signal fires first
    const reopen = (): void => {
      if (settled || this.#closed) return;
      settled = true;
      this.#feedReq = undefined;
      this.#feedRes = undefined;
      this.#reconnect = setTimeout(() => this.#openFeed(), this.#backoffMs);
      this.#reconnect.unref?.();
    };
    const req = this.#open("GET", "/events", (res) => {
      this.#feedRes = res;
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        for (const frame of parser.push(chunk)) this.#onFeedFrame(frame);
      });
      res.on("end", reopen);
      res.on("close", reopen);
      res.on("error", reopen);
    });
    req.on("error", reopen);
    req.end();
    this.#feedReq = req;
  }

  /** Update one session's liveness from a session-tagged global-feed frame. */
  #onFeedFrame(frame: RawSseFrame): void {
    if (frame.event === "connected") return; // the feed opener carries no session
    let p: Record<string, unknown>;
    try {
      p = frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {};
    } catch {
      return;
    }
    if (typeof p.session !== "string") return; // a demuxable frame carries its session
    const id = p.session;
    if (this.#forgotten.has(id)) return; // a forgotten session stays dropped, even if it emits
    const cur: SessionInfo = this.#sessions.get(id) ?? { id, running: true, usage: ZERO_USAGE, costUsd: 0 };
    if (p.type === "agent_end") {
      cur.running = false;
      if (isUsage(p.usage)) cur.usage = p.usage;
    } else if (p.type === "usage") {
      cur.running = true;
      if (isUsage(p.cumulative)) cur.usage = p.cumulative;
    } else {
      cur.running = true; // any other bus frame means a turn is in flight
    }
    this.#sessions.set(id, cur);
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  // -- HTTP plumbing (Node http/https only; no fetch, no deps) ----------------

  /** GET a path and parse its JSON body. */
  #getJson(path: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = this.#open("GET", path, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
  }

  /** Build a request against the base URL, wiring auth + accept headers. */
  #open(method: string, path: string, onRes: (res: IncomingMessage) => void): ClientRequest {
    const url = new URL(path, this.url + "/");
    const isHttps = url.protocol === "https:";
    const headers: Record<string, string> = { accept: "text/event-stream, application/json" };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    const options = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers };
    return (isHttps ? httpsRequest : httpRequest)(options, onRes);
  }
}
