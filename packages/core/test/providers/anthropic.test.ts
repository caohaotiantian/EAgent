/**
 * How an Anthropic stream ENDS, and why the endings must not read alike.
 *
 * A model that finished, a connection that was cut, and a human who pressed stop are three
 * different facts about one turn. Two of them used to arrive at the caller as the third:
 * a cut body yielded `finishReason: "stop"` with half an answer, and a cancel arrived as a
 * retryable transport failure the retry ladder was entitled to re-run. Both are journaled,
 * and the journal is what replay serves forever.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import type { ModelEvent, ModelRequest } from "../../src/run/registry.ts";

const REQ: ModelRequest = {
  model: "claude-sonnet-5",
  system: "be brief",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

const ac = (): AbortSignal => new AbortController().signal;

/** A `fetch` that plays the given SSE frames back, optionally split mid-frame. */
function sseFetch(frames: readonly string[], chunkSize?: number) {
  return async (): Promise<Response> => {
    const text = frames.map((f) => `${f}\n\n`).join("");
    const bytes = new TextEncoder().encode(text);
    const size = chunkSize ?? Math.max(1, bytes.length);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const START = `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}`;
const delta = (text: string) =>
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(text)}}}`;
const STOP_DELTA = `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`;
const MESSAGE_STOP = `event: message_stop\ndata: {"type":"message_stop"}`;

// ── a cut stream is a cut stream ─────────────────────────────────────────────

test("A BODY THAT ENDS MID-ANSWER IS A TRANSPORT FAILURE, NOT A FINISHED MESSAGE", async () => {
  // The dangerous shape: the provider said `message_start`, sent text, and the connection
  // went away. Nothing in those bytes says the model stopped, so calling it `stop` records
  // half an answer as a whole one — and replay then serves the half forever.
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch([START, delta("The answer is 4"), delta("2, because")], 9) });

  const seen: ModelEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const ev of a.stream(REQ, ac())) seen.push(ev);
    },
    (e: unknown) =>
      isLoomError(e) && e.code === CODES.E_PROVIDER_TRANSPORT && e.class === "unavailable",
    "a truncated stream must be reported as the transport failure it is",
  );
  assert.equal(seen.some((e) => e.type === "done"), false, "no `done` may be yielded for a message that never ended");
  // The deltas ALREADY REACHED the caller — that is why this cannot be papered over by
  // retrying here, and why it has to be said out loud instead.
  assert.equal(seen.filter((e) => e.type === "text_delta").length, 2);
});

test("an empty body is a cut too, not an empty answer", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch([]) });
  await assert.rejects(
    () => collect(a.stream(REQ, ac())),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_PROVIDER_TRANSPORT,
  );
});

test("a message the provider CLOSED is complete — `message_stop` ends it", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch([START, delta("42"), STOP_DELTA, MESSAGE_STOP], 5) });
  const done = (await collect(a.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.content, "42");
  assert.equal(done.finishReason, "stop");
  assert.equal(done.usage.outputTokens, 4);
});

test("a `message_delta` carrying a stop reason closes the message on its own", async () => {
  // The two terminal frames are separate events and the second may be lost to a proxy that
  // trims the tail. A stop reason IS the model saying why it stopped, so it counts.
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch([START, delta("hi"), STOP_DELTA]) });
  const done = (await collect(a.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.finishReason, "stop");
});

test("a max_tokens ending is complete, and keeps its own reason", async () => {
  const capped = `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":99}}`;
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch([START, delta("long"), capped, MESSAGE_STOP]) });
  const done = (await collect(a.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.finishReason, "max_tokens", "a hard stop at the token ceiling is not a truncated stream");
});

// ── a cancel is a cancel ─────────────────────────────────────────────────────

test("A MID-STREAM CANCEL STAYS A CANCEL — the retry ladder must not re-run what a human stopped", async () => {
  const controller = new AbortController();
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch([START, delta("one"), delta("two"), STOP_DELTA], 8) });

  await assert.rejects(
    async () => {
      for await (const ev of a.stream(REQ, controller.signal)) {
        if (ev.type === "text_delta") controller.abort();
      }
    },
    (e: unknown) => isLoomError(e) && e.class === "cancelled" && e.code === CODES.E_CANCELLED && e.retryable === false,
    "a cancellation reported as `unavailable` is retryable, and retrying it re-runs work a person stopped",
  );
});

test("THE SAME CUT BODY IS A CANCEL OR A TRUNCATION, AND ONLY THE HUMAN DECIDES WHICH", async () => {
  // A body that stops mid-frame — no blank line after the last delta, which is what a
  // severed connection looks like on the wire. `sse` has already broken out of its read loop
  // by the time that partial frame is handed over, so its own abort check never runs again
  // and the verdict is the adapter's to make.
  const cut = `${START}\n\n${delta("partial")}`;
  const fetchFn = async (): Promise<Response> => new Response(cut, { status: 200 });

  const controller = new AbortController();
  await assert.rejects(
    async () => {
      for await (const ev of new AnthropicAdapter({ apiKey: "k", fetch: fetchFn }).stream(REQ, controller.signal)) {
        if (ev.type === "text_delta") controller.abort();
      }
    },
    (e: unknown) => isLoomError(e) && e.class === "cancelled" && /cancelled/.test(e.message),
    "a run that tore down its own socket did not suffer an outage",
  );

  // The identical bytes, with nobody cancelling, are the outage.
  await assert.rejects(
    () => collect(new AnthropicAdapter({ apiKey: "k", fetch: fetchFn }).stream(REQ, ac())),
    (e: unknown) => isLoomError(e) && e.class === "unavailable" && e.code === CODES.E_PROVIDER_TRANSPORT,
  );
});

// ── what a closed message may still contain ──────────────────────────────────

test("malformed tool arguments do not crash a stream that ended properly", async () => {
  // Truncation detection must not swallow this: a fragment that never parses is the TOOL's
  // schema to reject, and the message it arrived in was closed by the provider.
  const frames = [
    START,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"x"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not json"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}`,
    MESSAGE_STOP,
  ];
  const done = (await collect(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(frames) }).stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.deepEqual(done.message.toolCalls?.[0]?.arguments, {});
  assert.equal(done.finishReason, "tool_use");
});

/**
 * A TRUNCATED TURN IS NOT A TOOL CALL.
 *
 * `finishReason` was overridden to `tool_use` whenever any tool call was parsed, which erased
 * `max_tokens`. A call whose argument JSON was cut mid-stream is debris, not a request — and
 * the parser turns the unparseable remainder into `{}`, so the engine dispatched the tool with
 * EMPTY arguments and called it a clean `tool_use`. `fs.write` with `{}` is not a smaller
 * version of the intended write.
 *
 * The malformed-JSON case one screen up is deliberately NOT this: there the provider said
 * `tool_use` and meant it, and `{}` is the honest reading of a broken argument. Here the
 * provider said it ran out of room.
 */
test("a `max_tokens` turn keeps that reason and drops its partial tool calls", async () => {
  const frames = [
    START,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"fs.write"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}`,
    MESSAGE_STOP,
  ];
  const done = (await collect(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(frames) }).stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.finishReason, "max_tokens", "the truncation must survive");
  assert.equal(done.message.toolCalls, undefined, "a half-streamed call must NOT be dispatched");
});

/**
 * CACHED TOKENS WERE CAPTURED AND NEVER PRICED.
 *
 * The adapter has always read `cache_read_input_tokens`/`cache_creation_input_tokens` off the
 * wire and put them on the `UsageRecord`. `priceOf`'s parameter named two fields, so it could
 * not see them, and every cached turn settled at the plain input rate — wrong in the cheap
 * direction for a read and the expensive one for a write. A budget compares against that number.
 */
test("cache read and cache write are PRICED, not just counted", () => {
  const a = new AnthropicAdapter({ apiKey: "k", prices: { m: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 } } });

  assert.equal(a.priceOf("m", { inputTokens: 1e6, outputTokens: 0 }), 10, "the plain input rate is unchanged");
  assert.equal(a.priceOf("m", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6 }), 1, "a cache READ is priced at its own rate");
  assert.equal(a.priceOf("m", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1e6 }), 12.5, "a cache WRITE costs MORE than input");
});

test("a table row with no cache rates falls back to the input rate, which is the old behaviour", () => {
  // An operator who has not priced their cache is not silently handed a free one.
  const a = new AnthropicAdapter({ apiKey: "k", prices: { m: { input: 10, output: 20 } } });
  assert.equal(a.priceOf("m", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1e6 }), 10);
});
