/**
 * The HTTP server's monitor endpoints (Phase 1 of the TUI rebuild), driven
 * against a real (offline, mock-backed) server on an ephemeral port.
 *
 *   GET  /sessions              → list live sessions {id, running, usage, costUsd}
 *   POST /sessions/:id/stop     → abort a running turn (agent.stop())
 *   GET  /sessions/:id/events   → per-session SSE feed, tenant-isolated
 *   GET  /events                → global SSE feed, each frame tagged with its session
 *
 * These are the additive routes the monitor client needs (design D6/KDD7,
 * AC6/AC6b). They reuse the existing bearer auth + session pool and re-emit the
 * shared hooks bus read-only; the per-session feed filters by run-tree root agent
 * (`currentRootAgent() === agent`) so a session's feed carries only its own events.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createHttpServer, type HttpServer } from "../src/server.js";
import type { MockProvider } from "../src/providers/mock.js";
import { unwrapProvider } from "../src/extensions/lib/provider-wrap.js";
import type { CompletionRequest, Provider, StreamEvent, Usage } from "../src/kernel/types.js";
import { silentLogger } from "./helpers.js";

/**
 * A provider whose turn parks in-flight (one delta, then awaits the run's abort
 * signal) and completes only once aborted — so the stop test can observe a truly
 * running turn and end it deterministically via `agent.stop()`, without a CPU
 * burst racing the poll. Registered under "mock" to shadow the default.
 */
class ParkingProvider implements Provider {
  readonly name = "mock";
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "parking" };
    await new Promise<void>((resolve) => {
      if (req.signal.aborted) return resolve();
      req.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    yield {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text: "parking" }] },
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

/** The most recent user-role text in a request (the mock branches on this). */
function latestUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}

/** Hand a test the whole `HttpServer` (to script the mock) plus the base URL. */
async function withServerHandle(
  fn: (base: string, http: HttpServer) => Promise<void>,
  opts: { token?: string } = {},
): Promise<void> {
  const http = await createHttpServer({ provider: "mock", logger: silentLogger, ...opts });
  await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, http);
  } finally {
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    await http.close();
  }
}

/** The server's scriptable mock provider (unwrap the watchdog's provider shim). */
function mockOf(http: HttpServer): MockProvider {
  return unwrapProvider(http.agent.providers.get("mock")!) as MockProvider;
}

/** Bearer auth headers when a token is set, plus the JSON content type. */
function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** POST /run and return the open (NDJSON) response. */
function postRun(base: string, session: string, input: string, token?: string): Promise<Response> {
  return fetch(`${base}/run`, { method: "POST", headers: headers(token), body: JSON.stringify({ input, session }) });
}

/** POST /run and read its NDJSON stream to completion (so the session is pooled). */
async function postAndDrain(base: string, session: string, input: string, token?: string): Promise<void> {
  const res = await postRun(base, session, input, token);
  await res.text();
}

interface SseFrame {
  event?: string;
  data: Record<string, unknown>;
}

function parseSseFrame(raw: string): SseFrame | undefined {
  let event: string | undefined;
  let dataLine: string | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLine = line.slice("data:".length).trim();
  }
  if (dataLine === undefined) return undefined;
  return { event, data: JSON.parse(dataLine) as Record<string, unknown> };
}

/**
 * Read SSE frames from an open response, collecting each until `stop` returns
 * true (or the stream ends). A safety timeout aborts a feed that never produces
 * the awaited frame so a broken route fails fast instead of hanging.
 */
async function readSse(res: Response, stop: (frame: SseFrame) => boolean, timeoutMs = 5000): Promise<SseFrame[]> {
  assert.ok(res.body, "SSE response has a readable body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), timeoutMs);
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const frame = parseSseFrame(raw);
        if (!frame) continue;
        frames.push(frame);
        if (stop(frame)) return frames;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return frames;
}

// -- T1.1: GET /sessions list -------------------------------------------------

test("T1.1: GET /sessions lists live sessions with {id, running, usage, costUsd}", async () => {
  await withServerHandle(async (base) => {
    // Two live sessions the monitor never knew the ids of ahead of time.
    await postAndDrain(base, "alpha", "hello");
    await postAndDrain(base, "beta", "hi there");

    const res = await fetch(`${base}/sessions`);
    assert.equal(res.status, 200);
    const list = (await res.json()) as { id: string; running: boolean; usage: Usage; costUsd: number }[];
    assert.ok(Array.isArray(list), "the route returns an array");
    const byId = new Map(list.map((s) => [s.id, s]));
    assert.deepEqual(new Set(byId.keys()), new Set(["alpha", "beta"]), "both sessions are enumerated");
    for (const s of list) {
      assert.equal(s.running, false, "no turn is in flight after the run drained");
      assert.equal(typeof s.usage.inputTokens, "number", "usage is the session's own accounting");
      assert.ok(s.usage.inputTokens > 0, "a run happened, so tokens were counted");
      assert.equal(typeof s.costUsd, "number", "costUsd is present");
    }
  });
});

test("T1.1: GET /sessions is auth-gated when a token is configured, open when none", async () => {
  // Token configured: omitting the bearer is a 401; providing it is a 200.
  await withServerHandle(
    async (base) => {
      await postAndDrain(base, "s", "hi", "secret");
      const noauth = await fetch(`${base}/sessions`);
      assert.equal(noauth.status, 401, "no bearer → 401 when a token is set");
      await noauth.text();
      const authed = await fetch(`${base}/sessions`, { headers: { authorization: "Bearer secret" } });
      assert.equal(authed.status, 200, "the correct bearer → 200");
      await authed.text();
    },
    { token: "secret" },
  );
  // No token configured: the route is open.
  await withServerHandle(async (base) => {
    const res = await fetch(`${base}/sessions`);
    assert.equal(res.status, 200, "no token configured → the route is open");
    await res.text();
  });
});

// -- T1.2: POST /sessions/:id/stop --------------------------------------------

test("T1.2: POST /sessions/:id/stop aborts a running turn (agent.running → false)", async () => {
  await withServerHandle(async (base, http) => {
    // Pool the session with a normal quick turn, then swap in a provider whose
    // next turn parks in-flight until aborted — so the turn is genuinely running
    // when the poll observes it and `stop()` is what ends it.
    await postAndDrain(base, "long", "pool"); // pool the session (its own Agent)
    http.agent.providers.register(new ParkingProvider(), { default: true });

    // Start the parking turn but do NOT await it; read its stream in the
    // background so the socket drains and the turn tears down cleanly on stop.
    const running = postRun(base, "long", "go-long").then((r) => r.text());

    const isRunning = async (): Promise<boolean> => {
      const list = (await (await fetch(`${base}/sessions`)).json()) as { id: string; running: boolean }[];
      return list.find((s) => s.id === "long")?.running === true;
    };
    let sawRunning = false;
    for (let i = 0; i < 200 && !sawRunning; i++) {
      if (await isRunning()) sawRunning = true;
      else await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(sawRunning, "the session's turn is in flight (running:true) before the stop");

    const stop = await fetch(`${base}/sessions/long/stop`, { method: "POST" });
    assert.equal(stop.status, 200, "stopping a known running session → 200");
    await stop.text();

    await running; // the aborted turn unwinds

    let settled = false;
    for (let i = 0; i < 200 && !settled; i++) {
      if (!(await isRunning())) settled = true;
      else await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(settled, "after the stop the session reports running:false (agent.running flipped)");
  });
});

test("T1.2: POST /sessions/:id/stop is 404 for an unknown id and auth-gated", async () => {
  await withServerHandle(
    async (base) => {
      const noauth = await fetch(`${base}/sessions/whatever/stop`, { method: "POST" });
      assert.equal(noauth.status, 401, "no bearer → 401 when a token is set");
      await noauth.text();
      const unknown = await fetch(`${base}/sessions/nope/stop`, {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      });
      assert.equal(unknown.status, 404, "an unknown session id → 404 (auth passed)");
      await unknown.text();
    },
    { token: "secret" },
  );
});

// -- T1.3: per-session SSE feed + tenant isolation ----------------------------

test("T1.3: GET /sessions/:id/events is an SSE feed that emits connected then the session's bus events", async () => {
  await withServerHandle(async (base, http) => {
    mockOf(http).script((req) => ({ text: latestUserText(req) }));
    await postAndDrain(base, "sse", "pool"); // pool the session first

    const ac = new AbortController();
    try {
      const feed = await fetch(`${base}/sessions/sse/events`, { signal: ac.signal });
      assert.equal(feed.status, 200);
      assert.match(feed.headers.get("content-type") ?? "", /text\/event-stream/, "the feed is SSE");

      // Read until the session's turn ends; drive a fresh turn on it meanwhile.
      const framesP = readSse(feed, (f) => f.data.type === "agent_end");
      await postAndDrain(base, "sse", "sse-marker");
      const frames = await framesP;

      assert.equal(frames[0]?.event, "connected", "the first frame is the connected event");
      const text = frames
        .filter((f) => f.data.type === "text_delta")
        .map((f) => String(f.data.text))
        .join("");
      assert.match(text, /sse-marker/, "the feed streamed the session's own text");
      assert.ok(
        frames.some((f) => f.data.type === "agent_end"),
        "the feed carried the turn's terminal agent_end",
      );
    } finally {
      ac.abort();
    }
  });
});

test("T1.3/AC6b: a session's SSE feed carries ONLY its own events (no cross-session leakage)", async () => {
  await withServerHandle(async (base, http) => {
    mockOf(http).script((req) => ({ text: latestUserText(req) }));
    await postAndDrain(base, "A", "pool-A");
    await postAndDrain(base, "B", "pool-B");

    const ac = new AbortController();
    try {
      const feed = await fetch(`${base}/sessions/A/events`, { signal: ac.signal });
      assert.match(feed.headers.get("content-type") ?? "", /text\/event-stream/, "A's feed is SSE");

      // A's feed should ignore B's whole turn and only stream A's own turn.
      const framesP = readSse(feed, (f) => f.data.type === "agent_end");
      await postAndDrain(base, "B", "B-secret"); // B runs first — must NOT appear on A's feed
      await postAndDrain(base, "A", "A-visible"); // then A runs — appears, ends with agent_end
      const frames = await framesP;

      const allText = frames.map((f) => JSON.stringify(f.data)).join("\n");
      assert.match(allText, /A-visible/, "A's own turn is on A's feed");
      assert.doesNotMatch(allText, /B-secret/, "B's turn never leaks onto A's feed (tenant isolation)");
    } finally {
      ac.abort();
    }
  });
});

// -- T1.4: global GET /events with session-tagged frames ----------------------

test("T1.4: GET /events is an SSE stream whose frames are tagged with their session id", async () => {
  await withServerHandle(async (base, http) => {
    mockOf(http).script((req) => ({ text: latestUserText(req) }));
    await postAndDrain(base, "gsession", "pool"); // pool so the frame carries its id

    const ac = new AbortController();
    try {
      const feed = await fetch(`${base}/events`, { signal: ac.signal });
      assert.equal(feed.status, 200);
      assert.match(feed.headers.get("content-type") ?? "", /text\/event-stream/, "the global feed is SSE");

      const framesP = readSse(feed, (f) => f.data.type === "agent_end");
      await postAndDrain(base, "gsession", "global-marker");
      const frames = await framesP;

      assert.equal(frames[0]?.event, "connected", "the first frame is the connected event");
      const busFrames = frames.filter((f) => typeof f.data.type === "string");
      assert.ok(busFrames.length > 0, "the global feed carried bus events");
      assert.ok(
        busFrames.every((f) => f.data.session === "gsession"),
        "every global frame is tagged with its originating session id (demuxable)",
      );
    } finally {
      ac.abort();
    }
  });
});
