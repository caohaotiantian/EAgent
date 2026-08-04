/**
 * Provider adapters, entirely offline.
 *
 * `fetch` is injected, so these exercise real SSE bytes and real error bodies without
 * a network or an API key — the same discipline that makes the rest of the suite
 * runnable anywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, err } from "../../src/errors.ts";
import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { OpenAIAdapter } from "../../src/providers/openai.ts";
import {
  FallbackAdapter,
  RecordingAdapter,
  ReplayingAdapter,
  requestKey,
} from "../../src/providers/fallback.ts";
import { normalizeError, sse } from "../../src/providers/http.ts";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/run/registry.ts";

const REQ: ModelRequest = {
  model: "claude-sonnet-5",
  system: "be brief",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

/** Build a fetch that returns the given SSE frames, optionally split mid-frame. */
function sseFetch(frames: readonly string[], opts: { chunkSize?: number; status?: number; body?: string; headers?: Record<string, string> } = {}) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    if (opts.status !== undefined && opts.status >= 400) {
      return new Response(opts.body ?? "{}", opts.headers === undefined ? { status: opts.status } : { status: opts.status, headers: opts.headers });
    }
    const text = frames.map((f) => `${f}\n\n`).join("");
    const size = opts.chunkSize ?? text.length;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fn, calls };
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

const ac = (): AbortSignal => new AbortController().signal;

// ── SSE framing ──────────────────────────────────────────────────────────────

test("SSE frames are buffered by blank line, not by network chunk", async () => {
  // A chunk boundary mid-frame is the failure a naive per-chunk parser passes in
  // testing and drops in production.
  const text = `event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n`;
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
      c.close();
    },
  });
  const frames = [];
  for await (const f of sse(new Response(stream), ac())) frames.push(f);
  assert.deepEqual(frames, [
    { event: "a", data: '{"n":1}' },
    { event: "b", data: '{"n":2}' },
  ]);
});

test("SSE ignores comments and blank fields", async () => {
  const text = `: keepalive\n\ndata: {"x":1}\n\n`;
  const frames = [];
  for await (const f of sse(new Response(text), ac())) frames.push(f);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.data, '{"x":1}');
});

// ── the normalized taxonomy ──────────────────────────────────────────────────

test("provider failures map onto ONE taxonomy", () => {
  const cases: [number, string, string, string][] = [
    [429, "{}", CODES.E_PROVIDER_RATE_LIMIT, "exhausted"],
    [529, "{}", CODES.E_PROVIDER_OVERLOADED, "unavailable"],
    [503, "{}", CODES.E_PROVIDER_OVERLOADED, "unavailable"],
    [401, "{}", CODES.E_PROVIDER_AUTH, "policy"],
    [400, "context_length_exceeded: too many tokens", CODES.E_CONTEXT_OVERFLOW, "validation"],
    [400, "content policy violation", CODES.E_CONTENT_FILTERED, "policy"],
    [400, "bad schema", CODES.E_PROVIDER_BAD_REQUEST, "validation"],
    [500, "{}", CODES.E_PROVIDER_OVERLOADED, "unavailable"],
  ];
  for (const [status, body, code, klass] of cases) {
    const e = normalizeError(status, body);
    assert.equal(e.code, code, `${status} ${body}`);
    assert.equal(e.class, klass, `${status} ${body}`);
  }
});

test("a context overflow is validation, not transient — retrying cannot help", () => {
  const e = normalizeError(400, "maximum context length is 200000 tokens");
  assert.equal(e.retryable, false);
});

test("retry-after is honoured, in both formats", () => {
  const seconds = normalizeError(429, "{}", new Headers({ "retry-after": "30" }));
  assert.equal(seconds.retryAfterMs, 30_000);
  const dated = normalizeError(429, "{}", new Headers({ "retry-after": new Date(Date.now() + 5000).toUTCString() }));
  assert.ok((dated.retryAfterMs ?? 0) > 3000);
});

// ── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_TEXT = [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":8}}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`,
];

test("anthropic streams text deltas and reports usage including cache tokens", async () => {
  const f = sseFetch(ANTHROPIC_TEXT, { chunkSize: 7 });
  const a = new AnthropicAdapter({ apiKey: "k", fetch: f.fetch });
  const events = await collect(a.stream(REQ, ac()));

  assert.deepEqual(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text), ["Hel", "lo"]);
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.content, "Hello");
  assert.equal(done.usage.inputTokens, 12);
  assert.equal(done.usage.outputTokens, 5);
  assert.equal(done.usage.cacheReadTokens, 8);
  assert.ok(done.usage.costUsd > 0);
});

test("anthropic accumulates streamed tool arguments across fragments", async () => {
  const frames = [
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"fs.read"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pa"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"th\\":\\"a.md\\"}"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}`,
  ];
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(frames, { chunkSize: 5 }).fetch });
  const done = (await collect(a.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.deepEqual(done.message.toolCalls, [{ id: "t1", name: "fs.read", arguments: { path: "a.md" } }]);
  assert.equal(done.finishReason, "tool_use");
});

test("anthropic marks the stable prefix for prompt caching", async () => {
  const f = sseFetch(ANTHROPIC_TEXT);
  await collect(new AnthropicAdapter({ apiKey: "k", fetch: f.fetch }).stream(REQ, ac()));
  const body = f.calls[0]?.body as { system: { cache_control?: unknown }[] };
  assert.ok(body.system[0]?.cache_control, "system prefix is cache-marked");
  assert.equal(f.calls[0]?.headers["x-api-key"], "k");
});

test("malformed tool JSON does not crash the stream", async () => {
  const frames = [
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"x"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not json"}}`,
    `data: {"type":"content_block_stop","index":0}`,
  ];
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(frames).fetch });
  const done = (await collect(a.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  // Empty args, so the TOOL'S SCHEMA rejects it — one place decides validity.
  assert.deepEqual(done.message.toolCalls?.[0]?.arguments, {});
});

// ── OpenAI ───────────────────────────────────────────────────────────────────

test("openai streams deltas, tool calls, and usage", async () => {
  const frames = [
    `data: {"choices":[{"delta":{"content":"Hi"}}]}`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs.read","arguments":"{\\"path\\":"}}]}}]}`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"b.md\\"}"}}]}}]}`,
    `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":7}}`,
    `data: [DONE]`,
  ];
  const a = new OpenAIAdapter({ apiKey: "k", fetch: sseFetch(frames, { chunkSize: 11 }).fetch, prices: { "gpt-5": { input: 1, output: 2 } } });
  const events = await collect(a.stream({ ...REQ, model: "gpt-5" }, ac()));
  const done = events.at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.content, "Hi");
  assert.deepEqual(done.message.toolCalls, [{ id: "c1", name: "fs.read", arguments: { path: "b.md" } }]);
  assert.equal(done.usage.inputTokens, 20);
  assert.equal(done.usage.costUsd, Number(((20 / 1e6) * 1 + (7 / 1e6) * 2).toFixed(6)));
});

test("openai asks for usage explicitly, or cost silently reports zero", async () => {
  const f = sseFetch([`data: {"choices":[{"delta":{"content":"x"}}]}`, "data: [DONE]"]);
  await collect(new OpenAIAdapter({ apiKey: "k", fetch: f.fetch }).stream({ ...REQ, model: "gpt-5" }, ac()));
  const body = f.calls[0]?.body as { stream_options?: { include_usage?: boolean } };
  assert.equal(body.stream_options?.include_usage, true);
});

test("an OpenAI-compatible endpoint needs no api key", () => {
  assert.doesNotThrow(() => new OpenAIAdapter({ apiKey: "", baseUrl: "http://localhost:8000/v1", provider: "vllm" }));
  assert.throws(() => new OpenAIAdapter({ apiKey: "" }), /apiKey or a baseUrl/);
});

test("a tool round-trip serialises back into provider shape", async () => {
  const f = sseFetch([`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`, "data: [DONE]"]);
  const a = new OpenAIAdapter({ apiKey: "k", fetch: f.fetch });
  await collect(
    a.stream(
      {
        ...REQ,
        model: "gpt-5",
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: { a: 1 } }] },
          { role: "tool", content: "result", toolCallId: "c1" },
        ],
      },
      ac(),
    ),
  );
  const body = f.calls[0]?.body as { messages: { role: string; tool_calls?: unknown[]; tool_call_id?: string }[] };
  assert.equal(body.messages[0]?.role, "system");
  assert.ok(body.messages[2]?.tool_calls);
  assert.equal(body.messages[3]?.tool_call_id, "c1");
});

// ── retry / transport ────────────────────────────────────────────────────────

test("a 429 is retried, then succeeds", async () => {
  let calls = 0;
  const fetchFn = async (): Promise<Response> => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    return new Response(`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`, { status: 200 });
  };
  const a = new AnthropicAdapter({ apiKey: "k", fetch: fetchFn, sleep: async () => undefined });
  const done = (await collect(a.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  assert.equal(calls, 2);
});

test("a 400 is NOT retried", async () => {
  let calls = 0;
  const fetchFn = async (): Promise<Response> => {
    calls++;
    return new Response("bad schema", { status: 400 });
  };
  const a = new AnthropicAdapter({ apiKey: "k", fetch: fetchFn, sleep: async () => undefined });
  await assert.rejects(() => collect(a.stream(REQ, ac())), /E_PROVIDER_BAD_REQUEST|rejected the request/);
  assert.equal(calls, 1);
});

// ── fallback chains ──────────────────────────────────────────────────────────

/** Uses the real error constructors — a hand-shaped lookalike would not be a LoomError. */
function failing(code: string, klass: "exhausted" | "unavailable" | "policy" = "unavailable"): ModelAdapter {
  return {
    provider: "failing",
    async *stream(): AsyncIterable<ModelEvent> {
      throw err[klass](code as never, `simulated ${code}`);
    },
    priceOf: () => 0,
    estimateOf: () => 0,
  };
}

function ok(text: string): ModelAdapter {
  return {
    provider: "ok",
    async *stream() {
      yield { type: "text_delta", text };
      yield {
        type: "done",
        message: { role: "assistant", content: text },
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, wallMs: 0 },
      };
    },
    priceOf: () => 0.001,
    estimateOf: () => 0.002,
  };
}

test("a rate limit falls through to the next tier", async () => {
  const seen: string[] = [];
  const chain = new FallbackAdapter({
    primary: { adapter: failing(CODES.E_PROVIDER_RATE_LIMIT, "exhausted"), model: "big" },
    fallback: [{ adapter: ok("from fallback"), model: "small", when: [CODES.E_PROVIDER_RATE_LIMIT] }],
    onFallback: (from, to) => seen.push(`${from}->${to}`),
  });
  const done = (await collect(chain.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  if (done.type !== "done") return;
  assert.equal(done.message.content, "from fallback");
  assert.deepEqual(seen, ["big->small"]);
});

test("a tier whose `when` does not match is skipped", async () => {
  const chain = new FallbackAdapter({
    primary: { adapter: failing(CODES.E_PROVIDER_AUTH, "policy"), model: "big" },
    fallback: [{ adapter: ok("nope"), model: "small", when: [CODES.E_PROVIDER_RATE_LIMIT] }],
  });
  await assert.rejects(() => collect(chain.stream(REQ, ac())), /E_PROVIDER_AUTH/);
});

test("A CONTENT FILTER NEVER FALLS THROUGH — that would be evasion", async () => {
  const chain = new FallbackAdapter({
    primary: { adapter: failing(CODES.E_CONTENT_FILTERED, "policy"), model: "big" },
    fallback: [{ adapter: ok("should not be reached"), model: "small" }],
  });
  await assert.rejects(() => collect(chain.stream(REQ, ac())), /E_CONTENT_FILTERED/);
});

test("a chain that NAMES a forbidden code fails to build, not to run", () => {
  assert.throws(
    () =>
      new FallbackAdapter({
        primary: { adapter: ok("a"), model: "big" },
        fallback: [{ adapter: ok("b"), model: "small", when: [CODES.E_CONTENT_FILTERED] }],
      }),
    /may not trigger on "E_CONTENT_FILTERED"/,
    "a chain that would evade a safety refusal should fail at construction, not at 3am",
  );
});

test("a mid-stream failure does not fall through — the caller already saw deltas", async () => {
  const halfway: ModelAdapter = {
    provider: "halfway",
    async *stream() {
      yield { type: "text_delta", text: "partial" };
      throw err.unavailable(CODES.E_PROVIDER_TRANSPORT, "boom");
    },
    priceOf: () => 0,
    estimateOf: () => 0,
  };
  const chain = new FallbackAdapter({
    primary: { adapter: halfway, model: "big" },
    fallback: [{ adapter: ok("second"), model: "small" }],
  });
  const seen: ModelEvent[] = [];
  await assert.rejects(async () => {
    for await (const ev of chain.stream(REQ, ac())) seen.push(ev);
  });
  assert.equal(seen.length, 1, "no re-emission from the fallback tier");
});

test("estimate uses the PRIMARY tier, not the worst case", () => {
  const chain = new FallbackAdapter({
    primary: { adapter: ok("a"), model: "big" },
    fallback: [{ adapter: { ...ok("b"), estimateOf: () => 99 }, model: "small" }],
  });
  assert.equal(chain.estimateOf(REQ), 0.002, "reserving the worst tier would starve runs that never fall through");
});

// ── cassettes ────────────────────────────────────────────────────────────────

test("a cassette records and replays an adapter exactly", async () => {
  const rec = new RecordingAdapter(ok("recorded text"));
  const live = await collect(rec.stream(REQ, ac()));

  const replay = new ReplayingAdapter(rec.cassette);
  const replayed = await collect(replay.stream(REQ));
  assert.deepEqual(replayed, live);
});

test("a cassette miss is a loud divergence, not a live call", async () => {
  const replay = new ReplayingAdapter({ entries: {} });
  await assert.rejects(() => collect(replay.stream(REQ)), /E_REPLAY_DIVERGENCE|no cassette entry/);
});

test("a changed prompt is a cassette miss", async () => {
  const rec = new RecordingAdapter(ok("x"));
  await collect(rec.stream(REQ, ac()));
  const replay = new ReplayingAdapter(rec.cassette);
  await assert.rejects(() => collect(replay.stream({ ...REQ, system: "different" })));
  assert.notEqual(requestKey(REQ), requestKey({ ...REQ, system: "different" }));
});
