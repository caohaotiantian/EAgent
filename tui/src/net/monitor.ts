/**
 * The remote monitor client.
 *
 * Talks to `eagent-serve`'s read-mostly endpoints — `GET /sessions`,
 * `GET /events` — over plain `fetch`, with no dependency beyond what the runtime
 * already has. All the parsing lives in `wire.ts` and is tested there; this file
 * is only I/O and reconnection.
 */

import { parseSessions, parseSse, wireToEvent, type MonitorEvent, type SessionSummary } from "./wire.js";

export interface MonitorOptions {
  /** Base URL of the running host, e.g. `http://127.0.0.1:8787`. */
  base: string;
  /** Bearer token, when the server was started with one. */
  token?: string;
  onEvent: (session: string, ev: MonitorEvent) => void;
  onSessions: (sessions: SessionSummary[]) => void;
  onError: (message: string) => void;
  /** Injected in tests. */
  now?: () => number;
}

export interface Monitor {
  /** Refresh the session list once. */
  refresh: () => Promise<void>;
  close: () => void;
}

/** Attach to the global SSE feed and keep the session list current. */
export function connectMonitor(opts: MonitorOptions): Monitor {
  const now = opts.now ?? Date.now;
  const headers: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  const abort = new AbortController();
  let closed = false;

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(`${opts.base}/sessions`, { headers, signal: abort.signal });
      if (!res.ok) return opts.onError(`GET /sessions → ${res.status}`);
      opts.onSessions(parseSessions(await res.json()));
    } catch (err) {
      if (!closed) opts.onError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Read the global feed, reconnecting with a bounded backoff. */
  const stream = async (): Promise<void> => {
    let delay = 500;
    while (!closed) {
      try {
        const res = await fetch(`${opts.base}/events`, { headers, signal: abort.signal });
        if (!res.ok || res.body === null) throw new Error(`GET /events → ${res.status}`);
        delay = 500; // a successful connect resets the backoff

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseSse(buffer);
          buffer = rest;
          for (const frame of events) {
            // Each frame on the global feed is tagged with its own session.
            const session = typeof frame["session"] === "string" ? frame["session"] : "";
            const ev = wireToEvent(frame, { session, at: now() });
            if (ev) opts.onEvent(session, ev);
          }
        }
      } catch (err) {
        if (closed) return;
        opts.onError(err instanceof Error ? err.message : String(err));
      }
      if (closed) return;
      // Bounded backoff: a monitor left open overnight against a stopped server
      // must not spin.
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  };

  void stream();
  void refresh();

  return {
    refresh,
    close: () => {
      closed = true;
      abort.abort();
    },
  };
}
