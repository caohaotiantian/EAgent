/**
 * Phase 3 — the `SessionSource` abstraction (design D2, KDD3, AC5).
 *
 * One interface the TUI view consumes — an ordered, attribution-tagged lifecycle
 * event stream plus a control surface (run / answer / stop) — with two backends:
 *
 *   - T3.1 `InProcessSource` wraps a local `Agent`; subscribing yields the ordered
 *     lifecycle events tagged via the shared `src/attribution.ts` (so a fork/subagent
 *     de-interleaves by acting agent), and run/answer/stop drive the agent.
 *   - T3.2 `RemoteSource` is an HTTP+SSE client. Against an in-process stub server
 *     (Node `http`, ephemeral port) emitting scripted SSE frames, it yields an
 *     ordered stream matching the frames, reconnects after a dropped connection,
 *     and drives the session over POST /run, POST /answer, POST /sessions/:id/stop.
 *
 * Fully offline: MockProvider + the `test/helpers.ts` harness for the local agent,
 * and an in-process `http.createServer` on `listen(0)` for the remote stub — the
 * same pattern `test/server-monitor.test.ts` uses. No network, no Ink.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";

import { Agent } from "../src/kernel/agent.js";
import type { CompletionRequest, Provider, StreamEvent } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";
import { InProcessSource, RemoteSource, SseParser, type SourceEvent } from "../src/tui/source.js";

/** Wait until `pred()` is true (polling), or throw after `timeoutMs`. */
async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Reject after `ms` so a source that never delivers fails fast, never hangs. */
function withTimeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`withTimeout: no result within ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

/** The concatenated text of every event of `kind` a run emitted. */
function textOf(events: SourceEvent[], kind: "reasoning_delta" | "text_delta"): string {
  return events
    .filter((e): e is Extract<SourceEvent, { kind: "reasoning_delta" | "text_delta" }> => e.kind === kind)
    .map((e) => e.text)
    .join("");
}

// -- T3.1: InProcessSource ----------------------------------------------------

test("T3.1: InProcessSource yields the ordered, attribution-tagged lifecycle events of a run", async () => {
  const { agent, provider } = makeHarness();
  provider.script({ reasoning: "let me think about it", text: "the final answer" });

  let counter = 0;
  const source = new InProcessSource(agent, { now: () => counter++ });
  const events: SourceEvent[] = [];
  source.subscribe((e) => events.push(e));

  await source.run("hello");

  assert.equal(events[0]?.kind, "agent_start", "the stream opens with agent_start");
  assert.equal(events[events.length - 1]?.kind, "agent_end", "the stream closes with agent_end");
  assert.equal(textOf(events, "reasoning_delta"), "let me think about it", "reasoning deltas arrive in order");
  assert.equal(textOf(events, "text_delta"), "the final answer", "answer deltas arrive in order");

  // Every render event is tagged (actingId/rootId/at); a single-root run has no
  // fork, so acting === root throughout (the de-interleaving key is present but flat).
  const tagged = events.filter((e) => "actingId" in e);
  assert.ok(tagged.length > 0, "events carry attribution tags");
  for (const e of tagged) {
    assert.equal(typeof (e as { actingId: string }).actingId, "string");
    assert.equal((e as { actingId: string }).actingId, (e as { rootId: string }).rootId, "single-root run: acting === root");
    assert.equal(typeof (e as { at: number }).at, "number", "each event carries a monotonic timestamp");
  }

  source.close();
});

test("T3.1: InProcessSource de-interleaves concurrent fork streams by acting agent", async () => {
  const { agent, provider } = makeHarness();

  // A best_of_n-shaped tool forks two children on the parent's childScope bus; each
  // streams its own recognizable reasoning so their deltas interleave on the wire.
  const { ProviderRegistry } = await import("../src/kernel/registry.js");
  const { defineTool, ok } = await import("../src/kernel/define.js");
  const { MockProvider } = await import("../src/providers/mock.js");
  const mkChild = (tag: string): Agent =>
    new Agent({
      providers: (() => {
        const p = new ProviderRegistry();
        p.register(new MockProvider({ reasoning: tag.repeat(40) }), { default: true });
        return p;
      })(),
      hooks: agent.hooks.childScope(),
      capabilities: agent.capabilities,
      model: "mock",
      provider: "mock",
    });
  agent.tools.register(
    defineTool({
      name: "best_of_n",
      description: "fork two children",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        await Promise.allSettled([mkChild("A").run("go"), mkChild("B").run("go")]);
        return ok("forked");
      },
    }),
  );
  provider.script((_req, i) => (i === 0 ? { toolCalls: [{ name: "best_of_n" }] } : { text: "done" }));

  let counter = 0;
  const source = new InProcessSource(agent, { now: () => counter++ });
  const events: SourceEvent[] = [];
  source.subscribe((e) => events.push(e));

  await source.run("start");

  // The fork reasoning arrives tagged with a NON-root acting id (out-of-band ALS
  // attribution), so a downstream reducer can separate the two streams.
  const forkReasoning = events.filter(
    (e): e is Extract<SourceEvent, { kind: "reasoning_delta" }> =>
      e.kind === "reasoning_delta" && e.actingId !== e.rootId,
  );
  assert.ok(forkReasoning.length > 0, "fork reasoning is attributed to a non-root acting agent");
  const forkIds = new Set(forkReasoning.map((e) => e.actingId));
  assert.ok(forkIds.size >= 2, `two distinct fork identities are present (${forkIds.size})`);

  source.close();
});

test("T3.1: InProcessSource control surface — run drives the agent, stop aborts it", async () => {
  const { agent } = makeHarness();
  agent.providers.register(new ParkingProvider(), { default: true });

  const source = new InProcessSource(agent);
  const events: SourceEvent[] = [];
  source.subscribe((e) => events.push(e));

  const runP = source.run("go-long");
  await until(() => agent.running, 3000);
  assert.ok(agent.running, "the turn is genuinely in flight");

  await source.stop();
  await runP;

  assert.equal(agent.running, false, "stop() aborted the run (agent.running flipped)");
  const end = events.find((e) => e.kind === "agent_end");
  assert.ok(end, "an agent_end event was emitted for the aborted run");
  assert.equal((end as { reason: string }).reason, "stop", "the aborted run ends with reason 'stop'");

  source.close();
});

test("T3.1: InProcessSource control surface — answer resolves a surfaced elicitation", async () => {
  const { agent } = makeHarness();
  const source = new InProcessSource(agent);
  const events: SourceEvent[] = [];
  source.subscribe((e) => events.push(e));

  // `source.ask` is the UI.ask sink the host wires into the agent; calling it
  // surfaces an action_required event and blocks until `answer` settles it.
  const asked = source.ask("Proceed?", ["yes", "no"]);
  const req = events.find((e) => e.kind === "action_required") as
    | Extract<SourceEvent, { kind: "action_required" }>
    | undefined;
  assert.ok(req, "the elicitation surfaced as an action_required event");
  assert.equal(req.question, "Proceed?");
  assert.deepEqual(req.options, ["yes", "no"]);

  assert.equal(await source.answer(req.id, "yes"), true, "answering a live id resolves it");
  assert.equal(await asked, "yes", "the awaiting ask receives the answer");
  assert.equal(await source.answer(9999, "x"), false, "answering an unknown id is a clean false");

  source.close();
});

// -- T3.2: RemoteSource -------------------------------------------------------

test("T3.2: SseParser handles multi-line and chunk-split frames", () => {
  const p = new SseParser();
  // A single frame with an event name and two data lines, plus a comment line.
  const frames = p.push(": keep-alive\nevent: connected\ndata: line-1\ndata: line-2\n\n");
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.event, "connected");
  assert.equal(frames[0]?.data, "line-1\nline-2", "multiple data: lines join with newlines");

  // A frame split across two chunks is only emitted once complete.
  assert.deepEqual(p.push("data: {\"type\":\"text_delta\","), []);
  const more = p.push("\"text\":\"hi\"}\n\n");
  assert.equal(more.length, 1);
  assert.equal(more[0]?.data, "{\"type\":\"text_delta\",\"text\":\"hi\"}");
});

test("T3.2: RemoteSource parses scripted SSE frames in order and reconnects after a drop", async () => {
  const stub = new StubServer();
  const base = await stub.listen();
  try {
    const source = new RemoteSource({ base, session: "s1", backoffMs: 5 });
    const events: SourceEvent[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    source.subscribe((e) => {
      events.push(e);
      if (e.kind === "agent_end") resolveDone();
    });

    await withTimeout(done);

    const kinds = events.map((e) => e.kind);
    // First connection: connected → tool_start → text_delta, then the stub drops.
    // Reconnect: connected (relabeled) → agent_end.
    assert.deepEqual(kinds, ["connected", "tool_start", "text_delta", "reconnected", "agent_end"], "ordered stream mirrors the frames across a reconnect");

    const connected = events[0] as Extract<SourceEvent, { kind: "connected" }>;
    assert.equal(connected.session, "s1", "the connected frame carries the session id");

    const toolStart = events[1] as Extract<SourceEvent, { kind: "tool_start" }>;
    assert.equal(toolStart.call.name, "read", "the tool_start frame is mapped to a render event");
    assert.deepEqual(toolStart.call.arguments, { path: "/x" }, "tool arguments survive verbatim (no truncation)");
    assert.equal(toolStart.actingId, "s1", "the remote source tags acting id off the frame's session");

    const textDelta = events[2] as Extract<SourceEvent, { kind: "text_delta" }>;
    assert.equal(textDelta.text, "hello world");

    const end = events[4] as Extract<SourceEvent, { kind: "agent_end" }>;
    assert.equal(end.reason, "end_turn");

    assert.ok(stub.eventConnections >= 2, "the feed reconnected after the drop");

    source.close();
  } finally {
    await stub.close();
  }
});

test("T3.2: RemoteSource maps every eventToJsonl frame shape the server emits", async () => {
  // One connection emits one of each server frame type then a terminal agent_end.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sseFrame(res, "connected", { session: "s1" });
      sseFrame(res, undefined, { type: "reasoning_delta", text: "thinking", session: "s1" });
      sseFrame(res, undefined, { type: "text_delta", text: "answer", session: "s1" });
      sseFrame(res, undefined, { type: "message", role: "assistant", content: [], session: "s1" });
      sseFrame(res, undefined, { type: "tool_start", id: "t1", name: "bash", arguments: { cmd: "ls" }, session: "s1" });
      sseFrame(res, undefined, { type: "tool_end", id: "t1", name: "bash", isError: false, content: "file.txt", session: "s1" });
      sseFrame(res, undefined, { type: "usage", usage: { inputTokens: 5, outputTokens: 3 }, cumulative: { inputTokens: 10, outputTokens: 6 } });
      sseFrame(res, undefined, { type: "error", where: "provider", message: "boom", session: "s1" });
      sseFrame(res, undefined, { type: "action_required", id: 9, question: "OK?", options: ["y", "n"], session: "s1" });
      sseFrame(res, undefined, { type: "agent_end", reason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, session: "s1" });
      return; // keep open; the test closes the source
    }
    res.writeHead(404);
    res.end();
  });
  const base = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    });
  });
  try {
    const source = new RemoteSource({ base, session: "s1", backoffMs: 5 });
    const events: SourceEvent[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    source.subscribe((e) => {
      events.push(e);
      if (e.kind === "agent_end") resolveDone();
    });
    await withTimeout(done);

    const byKind = (k: SourceEvent["kind"]): SourceEvent | undefined => events.find((e) => e.kind === k);
    assert.equal((byKind("reasoning_delta") as { text: string }).text, "thinking");
    assert.equal((byKind("text_delta") as { text: string }).text, "answer");
    assert.equal((byKind("message") as { role: string }).role, "assistant");
    const start = byKind("tool_start") as Extract<SourceEvent, { kind: "tool_start" }>;
    assert.deepEqual(start.call.arguments, { cmd: "ls" });
    const end = byKind("tool_end") as Extract<SourceEvent, { kind: "tool_end" }>;
    assert.equal(end.result.content, "file.txt");
    assert.equal(end.result.isError, false);
    const usage = byKind("usage") as Extract<SourceEvent, { kind: "usage" }>;
    assert.equal(usage.usage.inputTokens, 5);
    assert.equal(usage.cumulative.inputTokens, 10);
    const err = byKind("error") as Extract<SourceEvent, { kind: "error" }>;
    assert.deepEqual({ where: err.where, message: err.message }, { where: "provider", message: "boom" });
    const ask = byKind("action_required") as Extract<SourceEvent, { kind: "action_required" }>;
    assert.deepEqual({ id: ask.id, question: ask.question, options: ask.options }, { id: 9, question: "OK?", options: ["y", "n"] });

    source.close();
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }
});

test("T3.2: RemoteSource control surface posts run/answer/stop", async () => {
  const stub = new StubServer();
  const base = await stub.listen();
  try {
    // No subscribe → no SSE feed; the control surface stands alone.
    const source = new RemoteSource({ base, session: "s7", backoffMs: 5 });

    await source.run("do the thing");
    assert.deepEqual(stub.runs, [{ input: "do the thing", session: "s7" }], "run() POSTs /run with input + session");

    assert.equal(await source.answer(42, "affirmative"), true, "answer() returns true on a 200");
    assert.deepEqual(stub.answers, [{ id: 42, answer: "affirmative" }], "answer() POSTs /answer with id + answer");

    await source.stop();
    assert.deepEqual(stub.stops, ["s7"], "stop() POSTs /sessions/:id/stop for the session");

    source.close();
  } finally {
    await stub.close();
  }
});

// -- Fixtures -----------------------------------------------------------------

/**
 * A provider whose turn parks in-flight (one delta, then awaits the run's abort
 * signal) and completes only once aborted — so a stop test can observe a truly
 * running turn and end it deterministically. Registered under "mock" to shadow
 * the harness default.
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

/** One SSE frame as the server writes it (`event:`? + `data:` + blank line). */
function sseFrame(res: ServerResponse, event: string | undefined, data: unknown): void {
  const head = event ? `event: ${event}\n` : "";
  res.write(`${head}data: ${JSON.stringify(data)}\n\n`);
}

/**
 * A scripted stub of the EAgent HTTP host's monitor surface. The per-session SSE
 * feed drops after the first batch (to exercise reconnect) then serves the
 * terminal frame; the control routes record their bodies for assertion.
 */
class StubServer {
  readonly #server: Server;
  eventConnections = 0;
  readonly runs: { input: string; session: string }[] = [];
  readonly answers: { id: number; answer: string }[] = [];
  readonly stops: string[] = [];

  constructor() {
    this.#server = createServer((req, res) => void this.#route(req, res));
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (req.method === "GET" && p.startsWith("/sessions/") && p.endsWith("/events")) {
      const id = decodeURIComponent(p.slice("/sessions/".length, -"/events".length));
      this.eventConnections++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sseFrame(res, "connected", { session: id });
      if (this.eventConnections === 1) {
        sseFrame(res, undefined, { type: "tool_start", id: "t1", name: "read", arguments: { path: "/x" }, session: id });
        sseFrame(res, undefined, { type: "text_delta", text: "hello world", session: id });
        res.end(); // drop the connection to force a reconnect
      } else {
        sseFrame(res, undefined, { type: "agent_end", reason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 }, session: id });
        // keep the connection open; the test closes the source when it's done
      }
      return;
    }

    if (req.method === "POST" && p === "/run") {
      const body = JSON.parse(await readBody(req)) as { input: string; session: string };
      this.runs.push({ input: body.input, session: body.session });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }

    if (req.method === "POST" && p === "/answer") {
      const body = JSON.parse(await readBody(req)) as { id: number; answer: string };
      this.answers.push({ id: body.id, answer: body.answer });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resolved: true, id: body.id }));
      return;
    }

    if (req.method === "POST" && p.startsWith("/sessions/") && p.endsWith("/stop")) {
      const id = decodeURIComponent(p.slice("/sessions/".length, -"/stop".length));
      this.stops.push(id);
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
