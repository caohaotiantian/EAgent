/**
 * Provider adapters, entirely offline.
 *
 * `fetch` is injected, so these exercise real SSE bytes and real error bodies without
 * a network or an API key — the same discipline that makes the rest of the suite
 * runnable anywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, err, isLoomError } from "../../src/errors.ts";
import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { OpenAIAdapter } from "../../src/providers/openai.ts";
import {
  FallbackAdapter,
  RecordingAdapter,
  ReplayingAdapter,
  requestKey,
} from "../../src/providers/fallback.ts";
import { normalizeError, postJson, sse } from "../../src/providers/http.ts";
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

// ── the provider's own advice is UNTRUSTED INPUT ──────────────────────────────

/** Drive `postJson` against a fixed status, recording every delay it asks to sleep. */
async function backoffs(
  respond: () => Response | Promise<Response>,
  opts: { readonly maxAttempts?: number; readonly baseDelayMs?: number; readonly maxDelayMs?: number } = {},
  signal: AbortSignal = ac(),
): Promise<number[]> {
  const slept: number[] = [];
  await postJson(
    "https://provider.example.com/v1",
    { headers: {}, body: {}, signal },
    { fetch: async () => respond(), sleep: async (ms) => void slept.push(ms), maxAttempts: 3, ...opts },
  ).catch(() => undefined);
  return slept;
}

/**
 * A retryable failure carrying the provider's own `Retry-After`.
 *
 * IT IS A 529 RATHER THAN A 429, and that changed when the rate limit stopped being held
 * in-slot at all: `postJson` now throws a 429 on the first response, so it can no longer
 * exercise the clamp these tests exist for. `normalizeError` attaches `retryAfterMs` to the
 * overload arm (529/503/502/504) and the transport arm (408/425) from the same
 * `parseRetryAfter` call, and `retryDelay` is downstream of all three, so every number
 * asserted below is unchanged — only the status that reaches the clamp is.
 */
const advised = (retryAfter: string) => (): Response => new Response("{}", { status: 529, headers: { "retry-after": retryAfter } });

test("A HOSTILE `Retry-After` CANNOT PARK A WORKER OR SPIN ONE — the header is bounded at both ends", async () => {
  // `retryAfterMs` is the only number in this file that a REMOTE PARTY chooses, and it
  // used to reach `setTimeout` with no bound and no clamp at all
  // (`sleep(last.retryAfterMs ?? Math.min(base * 2 ** n, max))` — the `??` skipped the
  // `max` entirely). Measured against that expression, one row per header:
  //
  //     Retry-After: 86400     → slept 86_400_000 ms. One compromised or merely
  //                              conservative provider parks a worker for a DAY, legally,
  //                              under the ceiling, with no warning printed anywhere.
  //     Retry-After: 2147484   → slept 2_147_484_000, which `setTimeout` truncates to
  //                              ONE MILLISECOND: a hot retry loop aimed at the provider,
  //                              which is also how a budget is burned.
  //     Retry-After: ""        → `Number("")` is 0 → slept 0. Same hot loop, reached by a
  //     Retry-After: "  "        header that is not a duration at all.
  //     Retry-After: -5        → `Math.max(0, -5000)` = 0 → same.
  //     Retry-After: 1e12      → 1e15 ms → truncated to 1 ms → same.
  //     Retry-After: <far date> → ~3.07e12 ms → truncated to 1 ms → same.
  //
  // The rule now: the header may move the delay WITHIN `[own curve, maxDelayMs]` and
  // nowhere else. It can ask for more patience, never for less, and never for more than
  // the operator agreed to wait.
  const base = 250;
  const max = 8_000;

  // Advice that fits is still honoured — this is what the bound must not break.
  assert.deepEqual(await backoffs(advised("30"), { maxDelayMs: 60_000 }), [30_000, 30_000], "30s of advice, taken");

  // Advice ABOVE the operator's ceiling is capped at the ceiling, not obeyed.
  assert.deepEqual(await backoffs(advised("86400")), [max, max], "a day of advice is capped at maxDelayMs");

  // Advice BELOW our own curve is floored at our own curve, not obeyed — `Retry-After: 0`
  // is legal, means "retry now", and is the cheapest way to aim a hot loop at a provider.
  assert.deepEqual(await backoffs(advised("0")), [base, base * 2], "Retry-After: 0 must not undercut the local curve");
  assert.deepEqual(
    await backoffs(advised("1"), { baseDelayMs: 4_000 }),
    [4_000, 8_000],
    "one second of advice under a four-second curve is floored, not obeyed",
  );
  // …and one second of advice ABOVE the curve is simply taken, which is the ordinary case
  // the floor must not break.
  assert.deepEqual(await backoffs(advised("1"), { baseDelayMs: 100, maxDelayMs: 8_000 }), [1_000, 1_000], "advice above the curve wins");

  // A header that is not `delay-seconds` and not an HTTP-date is NO ADVICE — which is a
  // different thing from advice of zero, and `Number()` used to conflate them.
  //
  // `"-5"` is in this list for a second reason worth keeping: it survives the digit check
  // and `Date.parse("-5")` is **988646400000** — V8's lenient fallback reads it as
  // 2001-04-30 — so tightening the numeric parse alone moved the conflation into the date
  // parse instead of removing it. Legal HTTP-dates all begin with a weekday; this does not.
  for (const header of ["", "   ", "-5", "0x10", "1e12", "abc", "Sat, 01 Jan 2124 00:00:00 GMT", "2147484"]) {
    assert.equal(
      normalizeError(429, "{}", new Headers({ "retry-after": header })).retryAfterMs,
      undefined,
      `Retry-After: ${JSON.stringify(header)} is not usable advice, so it must not reach the error either`,
    );
    assert.deepEqual(await backoffs(advised(header)), [base, base * 2], `Retry-After: ${JSON.stringify(header)} falls back to the local curve`);
  }
});

test("`retryAfterMs` RECORDS THE ADVICE; it does not bound it — and the docstring used to claim it did", async () => {
  // `parseRetryAfter`'s docstring stated an invariant one line wider than the code holds:
  // that a value is dropped rather than clamped "so that the absurd number never reaches
  // `LoomError.retryAfterMs` either". Only the platform half holds. Measured through
  // `toJSON`, which is the shape the journal and an HTTP 429 body actually carry:
  const parked = normalizeError(429, "{}", new Headers({ "retry-after": "86400" }));
  assert.equal(parked.retryAfterMs, 86_400_000, "a legal day of advice reaches the error intact");
  assert.equal((parked.toJSON() as Record<string, unknown>)["retryAfterMs"], 86_400_000, "…and is journaled intact");
  assert.equal(
    normalizeError(429, "{}", new Headers({ "retry-after": "2147484" })).retryAfterMs,
    undefined,
    "only what no timer can hold is dropped",
  );

  // Which is correct, and is the whole reason the bound lives one layer out: the FIELD is
  // a faithful record of what the provider asked for, and the DELAY is what this
  // deployment agreed to. The same header, the same call, two different numbers.
  assert.deepEqual(await backoffs(advised("86400"), { maxDelayMs: 8_000 }), [8_000, 8_000], "the delay obeys maxDelayMs, not the header");

  // The residual duty this pins, because it is the one a reader will get wrong: any OTHER
  // consumer of `retryAfterMs` — an HTTP 429 handler, a scheduler requeue — is holding a
  // number a remote party chose, bounded only by the platform, and owes it a ceiling of
  // its own. `normalizeError` cannot apply one: it never sees `HttpOptions`.
  assert.ok(parked.retryAfterMs !== undefined && parked.retryAfterMs > 8_000, "the record deliberately exceeds any one caller's ceiling");
});

test("the operator's half of the backoff is bounded by the same ceiling as every other duration", async () => {
  // `HttpOptions.baseDelayMs` and `.maxDelayMs` are pinned public knobs that reach the
  // same `setTimeout`. `baseDelayMs: 2 ** 31` used to mean a 24.8-day first retry and
  // installed a ONE MILLISECOND one, so a deliberately patient operator got the most
  // aggressive retry the code can emit.
  for (const bad of [{ baseDelayMs: 2 ** 31 }, { maxDelayMs: 2 ** 31 }, { baseDelayMs: 86_400_000_000 }, { baseDelayMs: -1 }, { maxDelayMs: 1.5 }]) {
    await assert.rejects(
      () => postJson("https://x", { headers: {}, body: {}, signal: ac() }, { fetch: async () => new Response("{}"), ...bad }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
      JSON.stringify(bad),
    );
  }
  // `maxAttempts: Infinity` is not a timer, it is a LOOP BOUND, and `attempt <= Infinity`
  // never ends. Same class, same refusal.
  await assert.rejects(
    () => postJson("https://x", { headers: {}, body: {}, signal: ac() }, { fetch: async () => new Response("{}", { status: 503 }), maxAttempts: Infinity, sleep: async () => undefined }),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
  );
  // The largest delay a timer CAN hold stays legal, so the refusal is a ceiling and not
  // an off-by-one that refuses a working configuration.
  assert.deepEqual(
    await backoffs(advised("1"), { baseDelayMs: 2 ** 31 - 1, maxDelayMs: 2 ** 31 - 1 }),
    [2 ** 31 - 1, 2 ** 31 - 1],
    "the ceiling itself is a legal delay",
  );
});

test("an abort ends the backoff hold instead of waiting the provider's delay out", async () => {
  // The run's own cancellation is the only deadline visible at this seam, and the hold
  // used to ignore it: `sleep` was awaited to completion and only THEN did the loop check
  // `signal.aborted`. So a cancelled run still sat out whatever delay the provider asked
  // for — up to `maxDelayMs`, which an operator may legitimately set to days.
  const controller = new AbortController();
  const p = postJson(
    "https://provider.example.com/v1",
    { headers: {}, body: {}, signal: controller.signal },
    {
      // A 529, not a 429: the rate limit is no longer held here at all, so it can no longer
      // reach the hold this test is about. The abort question is the same for every status
      // that still backs off.
      fetch: async () => new Response("{}", { status: 529, headers: { "retry-after": "30" } }),
      maxAttempts: 3,
      maxDelayMs: 60_000,
      // A sleep that NEVER resolves. Only the abort can end the hold.
      sleep: () => new Promise<void>(() => undefined),
    },
  );
  const settled = p.then(
    () => "resolved",
    (e: unknown) => (isLoomError(e) ? e.code : "other"),
  );
  // A FAILURE DEADLINE, not a timing assertion: without it the unfixed code makes this
  // test HANG rather than fail, which is the one shape a red test must not have.
  const deadline = new Promise<string>((resolve) => {
    setTimeout(() => resolve("still holding — the abort did not end the backoff"), 2_000).unref();
  });
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  assert.equal(await Promise.race([settled, deadline]), CODES.E_CANCELLED, "the hold must end on abort, not on the provider's schedule");
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
    // The subject here is malformed tool JSON, not truncation. This fixture used to omit
    // any terminal frame, which is indistinguishable from a cut connection — the stream
    // now says so, so the fixture has to be a complete message to keep asking its own
    // question.
    `data: {"type":"message_stop"}`,
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

test("a 529 is retried, then succeeds", async () => {
  // THIS TEST USED TO SAY 429, and the status is the whole point of the edit rather than a
  // fixture detail. Everything retryable that is not a rate limit is still absorbed here, on
  // the operator's own bounded curve; a rate limit is now reported instead — see the next test
  // and `postJson`'s docstring for why the two are no longer the same case.
  let calls = 0;
  const fetchFn = async (): Promise<Response> => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 529, headers: { "retry-after": "0" } });
    return new Response(`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n`, { status: 200 });
  };
  const a = new AnthropicAdapter({ apiKey: "k", fetch: fetchFn, sleep: async () => undefined });
  const done = (await collect(a.stream(REQ, ac()))).at(-1)!;
  assert.equal(done.type, "done");
  assert.equal(calls, 2);
});

test("A 429 IS REPORTED ON THE FIRST RESPONSE, with the provider's advice, and is never held", async () => {
  // The rate limit is the one retryable failure this loop does not wait out, because the wait
  // is paid inside the CALLER'S unit of concurrency and only the caller knows what that costs.
  // Measured before the change, through an engine: six 8-second holds inside one leased Task,
  // with nothing on the journal to reschedule against — see
  // `test/run/rate-limit-defers.test.ts`.
  let calls = 0;
  const slept: number[] = [];
  const a = new AnthropicAdapter({
    apiKey: "k",
    fetch: async () => {
      calls++;
      return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
    },
    sleep: async (ms) => void slept.push(ms),
  });
  await assert.rejects(
    () => collect(a.stream(REQ, ac())),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_PROVIDER_RATE_LIMIT && e.retryAfterMs === 30_000,
  );
  assert.equal(calls, 1, "one request, not three: the caller decides when to come back");
  assert.deepEqual(slept, [], "and nothing was held while it decided");
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
    outputCeilingOf: () => 1,
  };
}

function ok(text: string): ModelAdapter {
  return {
    provider: "ok",
    async *stream() {
      yield { type: "text_delta", text };
      yield {
        type: "done",
        provider: "ok",
        message: { role: "assistant", content: text },
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001, wallMs: 0 },
      };
    },
    priceOf: () => 0.001,
    estimateOf: () => 0.002,
    outputCeilingOf: () => 1,
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
    outputCeilingOf: () => 1,
  };
  const chain = new FallbackAdapter({
    primary: { adapter: halfway, model: "big" },
    fallback: [{ adapter: ok("second"), model: "small" }],
  });
  const seen: ModelEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const ev of chain.stream(REQ, ac())) seen.push(ev);
    },
    (e: unknown) => isLoomError(e),
  );
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
  await assert.rejects(
    () => collect(replay.stream({ ...REQ, system: "different" })),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_REPLAY_DIVERGENCE,
  );
  assert.notEqual(requestKey(REQ), requestKey({ ...REQ, system: "different" }));
});

test("A PROVIDER THAT IGNORES `stream: true` FAILS LOUDLY — it used to answer with nothing", async () => {
  // Both adapters send `stream: true` unconditionally. A server that ignores it and answers with
  // an ordinary `chat.completion` body produced ZERO frames, so the adapter built a `done` event
  // with empty text and the RUN REPORTED SUCCEEDED with "" as the model's answer. Measured
  // through the binary against a stub gateway: `"outputs": {"a": ""}`, exit 0 — and the journaled
  // usage was the local ESTIMATE rather than the tokens the server reported, so the ledger
  // carried a plausible cost for a call that returned nothing.
  //
  // That is the path `baseUrl` exists for — LiteLLM, vLLM, a corporate gateway — while Anthropic
  // and OpenAI proper stream correctly, so it failed only for the deployments least able to
  // diagnose it.
  const json = JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "STUB-ANSWER" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 2000 },
  });
  const fetchFn = async (): Promise<Response> =>
    new Response(json, { status: 200, headers: { "content-type": "application/json" } });

  const a = new OpenAIAdapter({ apiKey: "k", fetch: fetchFn, sleep: async () => undefined });
  await assert.rejects(
    () => collect(a.stream(REQ, ac())),
    (e: unknown) => {
      assert.ok(isLoomError(e), String(e));
      assert.equal(e.code, CODES.E_PROVIDER_TRANSPORT);
      // The server's own content type, because it is the first thing an operator needs.
      assert.match(e.message, /application\/json/);
      return true;
    },
    "a non-streaming answer must not become an empty successful turn",
  );
});

test("AND `sse` ITSELF IS UNCHANGED — a general reader may legitimately yield nothing", async () => {
  // THE CHECKS LIVE IN `modelFrames`, NOT IN `sse`, and that split is the point. `sse` is a
  // published export and a general SSE reader: handed a stream of comments it correctly yields
  // nothing, and it is not its business what a caller wanted. Putting the model-call rules inside
  // it broke three existing tests whose fixtures read plain `Response`s — which is how the split
  // was found. A model call wants an ANSWER; SSE does not.
  const frames = [];
  for await (const f of sse(new Response(`: keepalive\n\n`), ac())) frames.push(f);
  assert.deepEqual(frames, [], "a comment-only stream is empty, not an error");
});

test("BOTH ADAPTERS REFUSE A NON-STREAM — the wrapper is the one place, so neither can miss it", async () => {
  // The OpenAI half was covered; the Anthropic path through `modelFrames` was not, and it is the
  // adapter that already carried a competing check of its own.
  const json = JSON.stringify({ id: "x", choices: [{ message: { content: "STUB" } }] });
  const fetchFn = async (): Promise<Response> =>
    new Response(json, { status: 200, headers: { "content-type": "application/json" } });

  for (const [name, adapter] of [
    ["openai", new OpenAIAdapter({ apiKey: "k", fetch: fetchFn, sleep: async () => undefined })],
    ["anthropic", new AnthropicAdapter({ apiKey: "k", fetch: fetchFn, sleep: async () => undefined })],
  ] as const) {
    await assert.rejects(
      () => collect(adapter.stream(REQ, ac())),
      (e: unknown) => {
        assert.ok(isLoomError(e), `${name}: ${String(e)}`);
        assert.equal(e.code, CODES.E_PROVIDER_TRANSPORT, name);
        return true;
      },
    );
  }
});

// ── a truncated turn is not a tool call ──────────────────────────────────────

/**
 * `finishReason` was overridden to `tool_use` whenever ANY tool call was parsed, which erased
 * `max_tokens` — and a tool call whose argument JSON was cut mid-stream is debris, not a
 * request. `safeJson` turns the unparseable remainder into `{}`, so the engine dispatched the
 * tool with EMPTY arguments and reported a clean `tool_use`. `fs.write` with `{}` is not a
 * smaller version of the intended write.
 */
test("OPENAI: a `max_tokens` turn keeps that reason and drops its partial tool calls", async () => {
  const f = sseFetch([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"fs.write","arguments":"{\\"path\\":\\"a"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
    "data: [DONE]",
  ]);
  const a = new OpenAIAdapter({ apiKey: "k", fetch: f.fetch });
  const events: ModelEvent[] = [];
  for await (const ev of a.stream(REQ, new AbortController().signal)) events.push(ev);

  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.finishReason, "max_tokens", "the truncation must survive");
  assert.equal(done.message.toolCalls, undefined, "a half-streamed call must NOT be dispatched");
});
