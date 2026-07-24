/**
 * Phase 5 — the monitor/manager view (design D5, AC7).
 *
 * Offline component/frame tests via `ink-testing-library` (KDD8): `render()` +
 * `lastFrame()` + a fake `stdin` over one or more in-process stub HTTP servers
 * (Node `http` on `listen(0)`, the `test/session-source.test.ts` /
 * `test/server-monitor.test.ts` pattern) — no real network, no raw TTY. Each stub
 * serves exactly the monitor surface `RemoteSource`/the instance client attach to:
 * `GET /sessions`, `GET /events`, `GET /sessions/:id/events`, `POST /sessions/:id/stop`.
 *
 *   - AC7 (list): the frame lists sessions across configured instances with live
 *     status/usage/cost.
 *   - AC7 (detail): selecting a session attaches its per-session SSE feed and
 *     renders it through the P4 transcript component.
 *   - AC7 (stop): stopping a running session flips it to not-running.
 *   - the global `/events` demux: a session-tagged frame updates that session live.
 *
 * The instances are driven with periodic polling OFF (`pollMs={0}`) so every state
 * transition is triggered explicitly — the mount poll, a stop's re-poll, or a
 * scripted feed frame — making the assertions deterministic without real timers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import React from "react";
import { render } from "ink-testing-library";

import { Monitor } from "../../src/tui/monitor.js";
import type { Usage } from "../../src/kernel/types.js";

/** Poll `pred()` until true, or throw after `timeoutMs` (never hangs the suite). */
async function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Strip whitespace runs so a substring survives Ink's line wrap / column pad. */
const norm = (s: string): string => s.replace(/\s+/g, "");

interface SessionSeed {
  running: boolean;
  usage: Usage;
  costUsd: number;
}

/** One SSE frame as the server writes it (`event:`? + `data:` + blank line). */
function sseFrame(res: ServerResponse, event: string | undefined, data: unknown): void {
  const head = event ? `event: ${event}\n` : "";
  res.write(`${head}data: ${JSON.stringify(data)}\n\n`);
}

/** Read a request body to a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * A scripted stub of one EAgent HTTP host's monitor surface. Seeds a mutable
 * session map (the `GET /sessions` snapshot); `POST /sessions/:id/stop` flips a
 * session to not-running; `pushGlobal` writes a frame to every open `/events`
 * feed so a test can exercise the live demux; the per-session feed streams a fixed
 * transcript for the detail view.
 */
class StubInstance {
  readonly #server: Server;
  readonly sessions = new Map<string, SessionSeed>();
  readonly #globalFeeds = new Set<ServerResponse>();
  stopCalls: string[] = [];
  sessionsPolls = 0;

  constructor(seed: Record<string, SessionSeed>) {
    for (const [id, s] of Object.entries(seed)) this.sessions.set(id, { ...s });
    this.#server = createServer((req, res) => void this.#route(req, res));
  }

  /** How many `/events` feeds are currently open (a test waits on this). */
  get globalFeedCount(): number {
    return this.#globalFeeds.size;
  }

  /** Push a bus frame to every open global feed (session-tagged). */
  pushGlobal(data: Record<string, unknown>): void {
    for (const res of this.#globalFeeds) sseFrame(res, undefined, data);
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (req.method === "GET" && p === "/sessions") {
      this.sessionsPolls++;
      const list = [...this.sessions].map(([id, s]) => ({ id, running: s.running, usage: s.usage, costUsd: s.costUsd }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === "GET" && p === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sseFrame(res, "connected", {});
      this.#globalFeeds.add(res);
      res.on("close", () => this.#globalFeeds.delete(res));
      return; // stays open; the test drives it via pushGlobal / closes the source
    }

    if (req.method === "GET" && p.startsWith("/sessions/") && p.endsWith("/events")) {
      const id = decodeURIComponent(p.slice("/sessions/".length, -"/events".length));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sseFrame(res, "connected", { session: id });
      sseFrame(res, undefined, { type: "tool_start", id: "t1", name: "read", arguments: { path: "/x" }, session: id });
      sseFrame(res, undefined, { type: "text_delta", text: "hello world", session: id });
      sseFrame(res, undefined, { type: "agent_end", reason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, session: id });
      return; // keep open; the source is closed on unmount
    }

    if (req.method === "POST" && p.startsWith("/sessions/") && p.endsWith("/stop")) {
      const id = decodeURIComponent(p.slice("/sessions/".length, -"/stop".length));
      this.stopCalls.push(id);
      const s = this.sessions.get(id);
      if (s) s.running = false; // the aborted turn is no longer in flight
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stopped: true, session: id }));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.#server.listen(0, "127.0.0.1", () => {
        const addr = this.#server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.closeAllConnections?.();
      this.#server.close(() => resolve());
    });
  }
}

// -- AC7: the list observes sessions across configured instances ----------------

test("AC7: the monitor lists sessions across configured instances with live status/usage/cost", async () => {
  const inst0 = new StubInstance({
    alpha: { running: true, usage: { inputTokens: 1000, outputTokens: 200 }, costUsd: 0.0042 },
    beta: { running: false, usage: { inputTokens: 250, outputTokens: 50 }, costUsd: 0.0011 },
  });
  const inst1 = new StubInstance({
    gamma: { running: false, usage: { inputTokens: 99, outputTokens: 1 }, costUsd: 0.0003 },
  });
  const base0 = await inst0.listen();
  const base1 = await inst1.listen();
  const { lastFrame, unmount } = render(
    <Monitor instances={[{ url: base0 }, { url: base1 }]} pollMs={0} />,
  );
  try {
    await until(() => {
      const f = lastFrame() ?? "";
      return f.includes("alpha") && f.includes("beta") && f.includes("gamma");
    });
    const frame = lastFrame() ?? "";
    const flat = norm(frame);

    assert.match(frame, /alpha/, "the running session from instance 0 is listed");
    assert.match(frame, /beta/, "the idle session from instance 0 is listed");
    assert.match(frame, /gamma/, "the session from instance 1 is listed (cross-instance aggregation)");
    assert.match(frame, /running/, "the running session's live status shows");
    assert.ok(flat.includes("1200"), "alpha's usage (1000+200 tok) is displayed");
    assert.ok(flat.includes("$0.0042"), "alpha's cost is displayed");
  } finally {
    unmount();
    await inst0.close();
    await inst1.close();
  }
});

// -- AC7: selecting a session attaches its per-session feed (detail view) --------

test("AC7: selecting a session opens a detail view over its per-session SSE feed", async () => {
  const inst = new StubInstance({
    alpha: { running: true, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001 },
  });
  const base = await inst.listen();
  const { lastFrame, stdin, unmount } = render(<Monitor instances={[{ url: base }]} pollMs={0} />);
  try {
    await until(() => (lastFrame() ?? "").includes("alpha"));

    // Cursor starts on the first (only) row; Enter drills into its detail feed.
    stdin.write("\r");

    await until(() => {
      const f = lastFrame() ?? "";
      return f.includes("read") && norm(f).includes("helloworld");
    });
    const frame = lastFrame() ?? "";
    assert.match(frame, /alpha/, "the detail view is headed with the selected session id");
    assert.match(frame, /read/, "the per-session feed's tool card renders (attached transcript)");
    assert.ok(norm(frame).includes("helloworld"), "the per-session feed's streamed answer renders");
  } finally {
    unmount();
    await inst.close();
  }
});

// -- AC7: a stop control flips a running session to not-running ------------------

test("AC7: stopping a running session posts /stop and reflects running -> false", async () => {
  const inst = new StubInstance({
    alpha: { running: true, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001 },
  });
  const base = await inst.listen();
  const { lastFrame, stdin, unmount } = render(<Monitor instances={[{ url: base }]} pollMs={0} />);
  try {
    await until(() => (lastFrame() ?? "").includes("running"));

    // Stop the highlighted (only) running session.
    stdin.write("s");

    await until(() => !(lastFrame() ?? "").includes("running"));
    assert.deepEqual(inst.stopCalls, ["alpha"], "stop posted /sessions/alpha/stop");
    assert.doesNotMatch(lastFrame() ?? "", /running/, "after the stop no session reports running");
  } finally {
    unmount();
    await inst.close();
  }
});

// -- AC7: forget drops a session from the list client-side -----------------------

test("AC7: forgetting a session drops it from the list (client-side, no re-fetch)", async () => {
  const inst = new StubInstance({
    alpha: { running: false, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001 },
    beta: { running: false, usage: { inputTokens: 20, outputTokens: 5 }, costUsd: 0.0002 },
  });
  const base = await inst.listen();
  const { lastFrame, stdin, unmount } = render(<Monitor instances={[{ url: base }]} pollMs={0} />);
  try {
    await until(() => {
      const f = lastFrame() ?? "";
      return f.includes("alpha") && f.includes("beta");
    });

    // Cursor starts on the first row (alpha); forget drops it.
    stdin.write("f");

    await until(() => !(lastFrame() ?? "").includes("alpha"));
    const frame = lastFrame() ?? "";
    assert.doesNotMatch(frame, /alpha/, "the forgotten session is gone from the list");
    assert.match(frame, /beta/, "the other session remains");
  } finally {
    unmount();
    await inst.close();
  }
});

// -- AC7: forget is durable — a forgotten session stays gone across default polls --

test("AC7: a forgotten session stays gone across polls (durable, not re-fetched back)", async () => {
  const inst = new StubInstance({
    alpha: { running: false, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001 },
    beta: { running: false, usage: { inputTokens: 20, outputTokens: 5 }, costUsd: 0.0002 },
  });
  const base = await inst.listen();
  // pollMs > 0 so refresh() re-fetches GET /sessions on an interval — the shipped
  // default path. A client-side-only forget with no persistent filter is undone by
  // the very next poll; this asserts the forgotten id is filtered durably.
  const { lastFrame, stdin, unmount } = render(<Monitor instances={[{ url: base }]} pollMs={20} />);
  try {
    await until(() => {
      const f = lastFrame() ?? "";
      return f.includes("alpha") && f.includes("beta");
    });

    // Cursor starts on the first row (alpha); forget drops it.
    stdin.write("f");
    await until(() => !(lastFrame() ?? "").includes("alpha"));

    // Hold across several poll cycles; the forgotten session must never reappear.
    const start = inst.sessionsPolls;
    let reappeared = false;
    await until(() => {
      if ((lastFrame() ?? "").includes("alpha")) reappeared = true;
      return inst.sessionsPolls >= start + 4;
    });
    assert.ok(!reappeared, "the forgotten session stays gone across polls (durable forget)");
    assert.match(lastFrame() ?? "", /beta/, "the other session remains");
  } finally {
    unmount();
    await inst.close();
  }
});

// -- the global /events demux updates a session live (keyed by frame session id) --

test("AC7: a session-tagged frame on the global /events feed updates that session live", async () => {
  const inst = new StubInstance({
    alpha: { running: true, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.0001 },
  });
  const base = await inst.listen();
  const { lastFrame, unmount } = render(<Monitor instances={[{ url: base }]} pollMs={0} />);
  try {
    await until(() => (lastFrame() ?? "").includes("running"));
    // Wait for the instance client to have opened its global feed before pushing.
    await until(() => inst.globalFeedCount >= 1);

    // A terminal agent_end on the global feed (not a poll, not a stop) must flip
    // alpha to not-running — the demux reads the session id off the frame.
    inst.pushGlobal({ type: "agent_end", reason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, session: "alpha" });

    await until(() => !(lastFrame() ?? "").includes("running"));
    assert.doesNotMatch(lastFrame() ?? "", /running/, "the global-feed agent_end frame flipped alpha to idle");
  } finally {
    unmount();
    await inst.close();
  }
});
