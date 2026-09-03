/**
 * "THE PROVIDER DID NOT SAY WHAT THIS COST" WAS ANSWERED WITH "IT COST NOTHING".
 *
 * `inputTokens` and `outputTokens` are initialised to 0 and only a usage frame moves them, so a
 * stream that carries none — an Anthropic-wire-compatible gateway behind `baseUrl`, which is the
 * documented use for that option — produced a real answer with `usage: {0, 0, costUsd: 0}`.
 * That is the PASSING value for every budget guard downstream: `budget.runUsd`, the per-node
 * `budget.costUsd`, `budget.tokens` and the E2/E3 escalations all became unreachable, and an
 * agent loop ran to `maxTurns` with no ceiling.
 *
 * `OpenAIAdapter` floors both, twenty lines away in the sibling file, and imports `roughTokens`
 * from this one. The sweep covered one adapter of two.
 *
 * AND THE FLOOR ITSELF THEN COVERED ONE TURN SHAPE OF TWO. It read `text.length`, and `text` is
 * EMPTY on a `tool_use` turn — the shape an agent loop mostly takes, because the model's whole
 * answer is the call. So `Math.max(1, 0)` charged ONE output token for a complete tool call of
 * any size, which is the same $0-priced turn in the majority case, arrived at by a fix that only
 * ever measured a prose answer. The last four tests here are that second shape.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { OpenAIAdapter } from "../../src/providers/openai.ts";
import type { ModelEvent, ModelRequest } from "../../src/run/registry.ts";

const REQ: ModelRequest = {
  model: "claude-sonnet-5",
  system: "be brief",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

const ac = (): AbortSignal => new AbortController().signal;

function sseFetch(frames: readonly string[]) {
  return async (): Promise<Response> =>
    new Response(frames.map((f) => `${f}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
}

async function done(it: AsyncIterable<ModelEvent>): Promise<Extract<ModelEvent, { type: "done" }>> {
  let last: ModelEvent | undefined;
  for await (const ev of it) last = ev;
  assert.equal(last?.type, "done");
  return last as Extract<ModelEvent, { type: "done" }>;
}

const ANSWER = "The answer is forty-two, because the question was badly posed.";

// A well-formed, complete stream that simply never mentions usage: `message_start` with no
// `usage`, text deltas, a `message_delta` carrying only `stop_reason`, and `message_stop`.
const NO_USAGE = [
  `event: message_start\ndata: {"type":"message_start","message":{}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(ANSWER)}}}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
];

test("a completed turn whose stream carried no usage is never journaled as free", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(NO_USAGE), prices: { "claude-sonnet-5": { input: 3, output: 15 } } });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.finishReason, "stop", "the turn really did complete — this is not an error path");
  assert.ok(d.usage.outputTokens > 0, `output must be floored from the text actually produced, got ${d.usage.outputTokens}`);
  assert.ok(d.usage.inputTokens > 0, `input must be floored from the request, got ${d.usage.inputTokens}`);
  assert.ok(d.usage.costUsd > 0, `a turn that produced ${ANSWER.length} characters must not cost 0, got ${d.usage.costUsd}`);
});

test("...and it estimates the same way OpenAIAdapter does, which is where the floor already was", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(NO_USAGE) });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.usage.outputTokens, Math.max(1, Math.ceil(ANSWER.length / 4)), "ceil(chars/4), as openai.ts floors it");
  // The input floor is `roughTokens(req)`, the same function openai.ts imports FROM this file.
  const o = new OpenAIAdapter({
    apiKey: "k",
    fetch: async () =>
      new Response(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(ANSWER)}},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const od = await done(o.stream({ ...REQ, model: "gpt-5" }, ac()));
  assert.equal(d.usage.inputTokens, od.usage.inputTokens, "both adapters floor input from the same request");
  assert.equal(d.usage.outputTokens, od.usage.outputTokens, "and output from the same text");
});

test("a REPORTED usage still wins — the floor must never overwrite what the provider said", async () => {
  const reported = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(ANSWER)}}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(reported) });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.usage.inputTokens, 9, "9 reported, not the ~20 the estimate would produce");
  assert.equal(d.usage.outputTokens, 4, "4 reported, not the ~16 the estimate would produce");
});

test("an EMPTY completed turn is charged for its input, and one output token", async () => {
  // No text at all — a tool-only turn from a gateway that reports nothing. `Math.max(1, …)` is
  // the difference between "cheap" and "free", and only the second one unbinds a ceiling.
  const empty = [
    `event: message_start\ndata: {"type":"message_start","message":{}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(empty) });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.usage.outputTokens, 1);
  assert.ok(d.usage.inputTokens > 0);
});

// ── the shape an agent loop actually takes ───────────────────────────────────

/** A large tool call and no prose: `fs.write` with a body, which is what an agent turn is. */
const TOOL_ARGS = { path: "docs/report.md", body: "# Report\n\n".concat("finding ".repeat(120)) };
const TOOL_JSON = JSON.stringify(TOOL_ARGS);

const TOOL_ONLY = [
  `event: message_start\ndata: {"type":"message_start","message":{}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"fs.write"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(TOOL_JSON)}}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
];

test("a TOOL-ONLY turn is charged for the call it produced, not for its empty text", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(TOOL_ONLY), prices: { "claude-sonnet-5": { input: 3, output: 15 } } });
  const d = await done(a.stream(REQ, ac()));
  assert.equal(d.finishReason, "tool_use", "the turn completed with a call — this is not an error path");
  assert.equal(d.message.toolCalls?.length, 1);
  // The defect, stated as a number: `text` is "" here, so the text-only floor charged exactly 1.
  assert.ok(
    d.usage.outputTokens > 100,
    `a ${TOOL_JSON.length}-character tool call must not be one output token, got ${d.usage.outputTokens}`,
  );
  assert.ok(d.usage.costUsd > 0);
});

test("...and OpenAIAdapter charges the same turn the same way", async () => {
  const o = new OpenAIAdapter({
    apiKey: "k",
    fetch: async () =>
      new Response(
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_01ABC","function":{"name":"fs.write","arguments":${JSON.stringify(TOOL_JSON)}}}]},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const od = await done(o.stream({ ...REQ, model: "gpt-5" }, ac()));
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(TOOL_ONLY) });
  const ad = await done(a.stream(REQ, ac()));
  assert.equal(od.finishReason, "tool_use");
  assert.equal(
    od.usage.outputTokens,
    ad.usage.outputTokens,
    "the two adapters must not answer a missing usage frame differently — they share the estimator",
  );
});

test("a MIXED turn counts both the prose and the call", async () => {
  const mixed = [
    `event: message_start\ndata: {"type":"message_start","message":{}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(ANSWER)}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01ABC","name":"fs.write"}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(TOOL_JSON)}}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const textOnly = await done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(NO_USAGE) }).stream(REQ, ac()));
  const toolOnly = await done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(TOOL_ONLY) }).stream(REQ, ac()));
  const both = await done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(mixed) }).stream(REQ, ac()));
  assert.ok(
    both.usage.outputTokens > textOnly.usage.outputTokens && both.usage.outputTokens > toolOnly.usage.outputTokens,
    `${both.usage.outputTokens} must exceed both ${textOnly.usage.outputTokens} and ${toolOnly.usage.outputTokens}`,
  );
});

test("...and a REPORTED usage still wins on a tool turn too", async () => {
  const reported = [
    ...TOOL_ONLY.slice(0, 4),
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const d = await done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(reported) }).stream(REQ, ac()));
  assert.equal(d.usage.outputTokens, 7, "the estimate must only run when the counter is still at its initial 0");
});

// ── the floor's own undecidable case, answered with the passing value ─────────

/**
 * AND THE FLOOR THEN OVER-CHARGED THE ONE TURN SHAPE IT WAS WRITTEN FOR.
 *
 * It fired on `inputTokens === 0`, and 0 is both the counter's initial value and a number the
 * provider legitimately reports. A full cache hit sends `{"input_tokens":0,
 * "cache_read_input_tokens":20000}` — every one of those tokens WAS billed, at the ~10x cheaper
 * cache-read rate — so the floor overwrote an honest zero with the whole prompt at the full
 * uncached rate, breaking the docstring's own "reported numbers still win".
 *
 * Measured on a 20,000-token prompt at $3/$15/$0.30 per million: $0.006105 became $0.066111.
 * The two facts the counter cannot tell apart have to be tracked separately, which is what
 * `sawInputUsage`/`sawOutputUsage` are for.
 */
const BIG_PROMPT: ModelRequest = { ...REQ, messages: [{ role: "user", content: "x".repeat(80_000) }] };
const PRICES = { "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3 }, "gpt-5": { input: 3, output: 15 } };

const FULL_CACHE_HIT = [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"cache_read_input_tokens":20000}}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi there"}}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
];

test("A REPORTED ZERO IS A REPORT — a fully-cached turn is not re-charged at the uncached rate", async () => {
  const a = new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(FULL_CACHE_HIT), prices: PRICES });
  const d = await done(a.stream(BIG_PROMPT, ac()));
  assert.equal(d.usage.inputTokens, 0, "the provider said 0 uncached input tokens, and it was telling the truth");
  assert.equal(d.usage.cacheReadTokens, 20_000, "…because all 20,000 of them were cache reads");
  assert.equal(d.usage.costUsd, 0.006105, "20000 × $0.30/M + 7 × $15/M — not the $0.066111 the floor charged");
});

test("...and an honestly-empty answer reporting `output_tokens: 0` is charged for none", async () => {
  const zeroOut = [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ];
  const d = await done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(zeroOut), prices: PRICES }).stream(REQ, ac()));
  assert.equal(d.usage.inputTokens, 11);
  assert.equal(d.usage.outputTokens, 0, "reported, not floored to the `Math.max(1, …)` estimate");
});

test("...and OpenAIAdapter answers a reported zero the same way", async () => {
  const o = new OpenAIAdapter({
    apiKey: "k",
    prices: PRICES,
    fetch: async () =>
      new Response(
        `data: {"choices":[{"delta":{"content":"hi there"},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":7}}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const d = await done(o.stream({ ...BIG_PROMPT, model: "gpt-5" }, ac()));
  assert.equal(d.usage.inputTokens, 0, "a gateway that reports a cached prompt as 0 is believed, not re-priced");
  assert.equal(d.usage.outputTokens, 7);
});

/**
 * A USAGE NUMBER THE REMOTE PARTY MADE UNREADABLE NEVER REACHES THE LEDGER.
 *
 * `UsageRecord` is typed `number`, and its values come out of `JSON.parse` on bytes somebody
 * else wrote. `{"output_tokens":"abc"}` made `costUsd` NaN, and NaN is the value that DISABLES a
 * budget instead of tripping it — `PolicyEngine.settle` folds it into `#spentUsd`, and every
 * later `committed + estimate > limit` is then `NaN > limit`, which is false. `-5` is the same
 * defect with its sign flipped: it CREDITS the budget.
 */
const GARBAGE_TAIL = (v: string): readonly string[] => [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi there"}}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${v}}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
];

test("an unreadable usage number is `not reported`, and the record it produces is still arithmetic", async () => {
  for (const v of [`"abc"`, `-5`, `null`, `{}`]) {
    const d = await done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(GARBAGE_TAIL(v)), prices: PRICES }).stream(REQ, ac()));
    assert.ok(Number.isFinite(d.usage.costUsd) && d.usage.costUsd >= 0, `output_tokens: ${v} produced costUsd ${String(d.usage.costUsd)}`);
    assert.ok(Number.isFinite(d.usage.outputTokens) && d.usage.outputTokens > 0, `output_tokens: ${v} produced ${String(d.usage.outputTokens)}`);
    assert.equal(d.usage.inputTokens, 11, "the READABLE half of the same frame is still believed");
  }
});

test("...and both adapters answer the same malformed frame with the same number", async () => {
  // The property the shared `producedTokens`/`roughTokens` import protects, held over the
  // validator too — which is duplicated rather than exported, because `index.ts` re-exports both
  // adapters with `export *` and every name there is on the pinned public surface.
  const a = await done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(GARBAGE_TAIL(`"abc"`)) }).stream(REQ, ac()));
  const o = new OpenAIAdapter({
    apiKey: "k",
    fetch: async () =>
      new Response(
        `data: {"choices":[{"delta":{"content":"hi there"},"finish_reason":null}]}\n\n` +
          `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":"abc"}}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
  });
  const od = await done(o.stream({ ...REQ, model: "gpt-5" }, ac()));
  assert.ok(Number.isFinite(a.usage.outputTokens), `anthropic answered ${String(a.usage.outputTokens)}`);
  assert.equal(od.usage.outputTokens, a.usage.outputTokens);
  assert.equal(od.usage.inputTokens, a.usage.inputTokens);
});

test("a price table that cannot produce a number refuses instead of returning one", async () => {
  // The other input to `costUsd`, and the one the operator owns. Returning 0 would be the same
  // loosening in a quieter form: 0 is the value every budget guard passes.
  const a = new AnthropicAdapter({
    apiKey: "k",
    fetch: sseFetch(NO_USAGE),
    prices: { "claude-sonnet-5": { input: Number("nope"), output: 15 } },
  });
  await assert.rejects(done(a.stream(REQ, ac())), (e: unknown) => (e as { code?: string }).code === "E_CONFIG_INVALID");
});
