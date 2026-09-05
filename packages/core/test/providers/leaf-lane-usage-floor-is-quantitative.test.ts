/**
 * THE ZERO RULES WERE DEFEATED BY ASSERTING 1, AND AN UNPRICED MODEL WAS FREE.
 *
 * `anthropic-usage-floor.test.ts` pins the rules that close a reported ZERO. Each of them has
 * exactly one disproof, so a wire that writes `1` instead of `0` bought the turn: measured at
 * 95a3dde on an 80,000-character prompt / 5,000-character answer priced $3/$15/$0.30 per million,
 * `{"input_tokens":1,"output_tokens":1}` cost $0.000018 against $0.078750 honest — 4,375x. And
 * two lines below, `priceOf` returned 0 for a model with no table row, so
 * `claude-sonnet-5-20260101` cost $0 where `claude-sonnet-5` cost $0.135 on the same turn.
 *
 * BOTH HALVES ARE HERE, and the ordinary half is the one that decides whether the guard is any
 * good. The tolerance is 8 because eleven honest fixtures put the worst `ceil(chars/4) / true
 * tokens` ratio at 2.40 under a rigorous lower bound and 1.30 under published averages —
 * `USAGE_TOLERANCE` carries the table. The four shapes below are the extremes of it: Chinese and
 * long whitespace runs are where `chars/4` is furthest from a tokenizer, in both directions.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { OpenAIAdapter } from "../../src/providers/openai.ts";
import { USAGE_TOLERANCE } from "../../src/providers/usage.ts";
import type { ModelEvent, ModelRequest } from "../../src/run/registry.ts";

const PRICES = { "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const ac = (): AbortSignal => new AbortController().signal;

const sse = (frames: readonly string[]) => async (): Promise<Response> =>
  new Response(frames.map((f) => `${f}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

async function done(it: AsyncIterable<ModelEvent>): Promise<Extract<ModelEvent, { type: "done" }>> {
  let last: ModelEvent | undefined;
  for await (const ev of it) last = ev;
  assert.equal(last?.type, "done");
  return last as Extract<ModelEvent, { type: "done" }>;
}

const PROMPT = "x".repeat(80_000);
const ANSWER = "y".repeat(5_000);
const REQ: ModelRequest = { model: "claude-sonnet-5", system: "be brief", messages: [{ role: "user", content: PROMPT }], tools: [] };

/** An Anthropic stream carrying `answer`, with whatever usage the two frames are given. */
const anth = (answer: string, start: string, delta: string): readonly string[] => [
  `data: {"type":"message_start","message":{${start}}}`,
  ...(answer === ""
    ? []
    : [`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(answer)}}}`]),
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}${delta}}`,
  `data: {"type":"message_stop"}`,
];

const oai = (answer: string, usage: string): readonly string[] => [
  `data: {"choices":[{"delta":{"content":${JSON.stringify(answer)}},"finish_reason":null}]}`,
  `data: {"choices":[{"delta":{},"finish_reason":"stop"}]${usage}}`,
  `data: [DONE]`,
];

const anthropic = (frames: readonly string[], model = "claude-sonnet-5"): Promise<Extract<ModelEvent, { type: "done" }>> =>
  done(new AnthropicAdapter({ apiKey: "k", fetch: sse(frames), prices: PRICES }).stream({ ...REQ, model }, ac()));

const openai = (frames: readonly string[]): Promise<Extract<ModelEvent, { type: "done" }>> =>
  done(new OpenAIAdapter({ apiKey: "k", fetch: sse(frames), prices: { "gpt-5": { input: 3, output: 15 } } }).stream({ ...REQ, model: "gpt-5" }, ac()));

// ── the exploit half ─────────────────────────────────────────────────────────

test("a wire cannot buy an 80,000-character prompt by asserting `input_tokens: 1`", async () => {
  const honest = await anthropic(anth(ANSWER, `"usage":{"input_tokens":20000}`, `,"usage":{"output_tokens":1250}`));
  const lying = await anthropic(anth(ANSWER, `"usage":{"input_tokens":1}`, `,"usage":{"output_tokens":1250}`));
  assert.equal(honest.usage.inputTokens, 20_000, "the honest report is believed unchanged");
  // 20,002 estimated / 8 = 2,501, and the shortfall is charged to uncached input.
  assert.equal(lying.usage.inputTokens, 2501, `asserting 1 must not buy the prompt, got ${lying.usage.inputTokens}`);
  assert.ok(lying.usage.inputTokens > 1000 * 1, "at 95a3dde this was 1");
});

test("...nor by putting the 1 in `cache_read_input_tokens`, which is the other input dimension", async () => {
  const d = await anthropic(anth(ANSWER, `"usage":{"input_tokens":0,"cache_read_input_tokens":1}`, `,"usage":{"output_tokens":1250}`));
  assert.equal(d.usage.cacheReadTokens, 1, "the wire's own number is still reported as reported");
  assert.equal(d.usage.inputTokens, 2500, "the shortfall against the estimate is charged at the UNCACHED rate");
});

test("...nor by asserting `output_tokens: 1` beside 5,000 characters of answer", async () => {
  const d = await anthropic(anth(ANSWER, `"usage":{"input_tokens":20000}`, `,"usage":{"output_tokens":1}`));
  assert.equal(d.usage.outputTokens, Math.ceil(Math.ceil(ANSWER.length / 4) / USAGE_TOLERANCE));
  assert.equal(d.usage.outputTokens, 157);
});

test("...nor by a fractional count the `=== 0` rule cannot see", async () => {
  const d = await anthropic(anth(ANSWER, `"usage":{"input_tokens":20000}`, `,"usage":{"output_tokens":1e-9}`));
  assert.equal(d.usage.outputTokens, 157, "1e-9 is neither 0 nor a plausible count for 5,000 characters");
});

test("BOTH ADAPTERS, one constant: the OpenAI wire is floored identically", async () => {
  const lyingIn = await openai(oai(ANSWER, `,"usage":{"prompt_tokens":1,"completion_tokens":1250}`));
  const lyingOut = await openai(oai(ANSWER, `,"usage":{"prompt_tokens":20000,"completion_tokens":1}`));
  assert.equal(lyingIn.usage.inputTokens, 2501);
  assert.equal(lyingOut.usage.outputTokens, 157);
  const honest = await openai(oai(ANSWER, `,"usage":{"prompt_tokens":20000,"completion_tokens":1250}`));
  assert.equal(honest.usage.inputTokens, 20_000);
  assert.equal(honest.usage.outputTokens, 1250);
});

// ── the ordinary half — an honest wire is charged what it reports ─────────────

/**
 * The shapes whose `ceil(chars/4)` is furthest from a real token count, in both directions.
 * `honestTokens` is the count a tokenizer would report, from the published chars-per-token for
 * the shape; the whitespace row deliberately assumes 8 characters per token, twice as generous as
 * anything measured, and is still believed.
 */
const SHAPES: readonly { readonly name: string; readonly prompt: string; readonly charsPerToken: number }[] = [
  { name: "prose", prompt: "The runtime records every nondeterministic call under a derived key. ".repeat(300), charsPerToken: 4.0 },
  { name: "chinese", prompt: "多智能体运行时的核心必须保持很小。".repeat(400), charsPerToken: 1.2 },
  { name: "whitespace-heavy", prompt: Array.from({ length: 400 }, () => "\t".repeat(6) + " ".repeat(40) + "x").join("\n"), charsPerToken: 8.0 },
  { name: "code", prompt: "export function f(a: number): number { return a * 2; }\n".repeat(200), charsPerToken: 3.3 },
];

for (const shape of SHAPES) {
  test(`ORDINARY: an honest ${shape.name} request is charged exactly what the wire reported`, async () => {
    const honest = Math.round(shape.prompt.length / shape.charsPerToken);
    const answer = "y".repeat(2000);
    const req: ModelRequest = { model: "claude-sonnet-5", system: "be brief", messages: [{ role: "user", content: shape.prompt }], tools: [] };
    const d = await done(
      new AnthropicAdapter({
        apiKey: "k",
        fetch: sse(anth(answer, `"usage":{"input_tokens":${String(honest)}}`, `,"usage":{"output_tokens":${String(Math.round(answer.length / 4))}}`)),
        prices: PRICES,
      }).stream(req, ac()),
    );
    assert.equal(d.usage.inputTokens, honest, `the floor must not fire on an honest ${shape.name} request`);
  });
}

test("ORDINARY: a full cache hit is still believed — an honest zero next to a cache count", async () => {
  const d = await anthropic(anth(ANSWER, `"usage":{"input_tokens":0,"cache_read_input_tokens":20000}`, `,"usage":{"output_tokens":1250}`));
  assert.equal(d.usage.inputTokens, 0, "zero UNCACHED input really was zero");
  assert.equal(d.usage.cacheReadTokens, 20_000);
  assert.equal(d.usage.costUsd, 0.02475);
});

test("ORDINARY: a turn that produced nothing and reported 0 output still costs 0 output", async () => {
  const d = await anthropic(anth("", `"usage":{"input_tokens":20000}`, `,"usage":{"output_tokens":0}`));
  assert.equal(d.usage.outputTokens, 0, "there is nothing here for the estimate to contradict");
});

test("ORDINARY: no usage frame at all still charges the WHOLE estimate, not the tolerance", async () => {
  const d = await anthropic(anth(ANSWER, ``, ``));
  assert.equal(d.usage.inputTokens, 20_002, "the zero rules run first and are unchanged");
  assert.equal(d.usage.outputTokens, 1250);
});

// ── the wire position the input counts were never read from ──────────────────

test("an input count reported on `message_delta` is read, not answered with the whole prompt", async () => {
  const onDelta = await anthropic(
    anth(ANSWER, `"usage":{"input_tokens":0}`, `,"usage":{"output_tokens":1250,"cache_read_input_tokens":20000}`),
  );
  const onStart = await anthropic(
    anth(ANSWER, `"usage":{"input_tokens":0,"cache_read_input_tokens":20000}`, `,"usage":{"output_tokens":1250}`),
  );
  assert.equal(onDelta.usage.cacheReadTokens, 20_000, "at 95a3dde this frame was invisible and the turn cost 10x");
  assert.equal(onDelta.usage.costUsd, onStart.usage.costUsd, "the same numbers in either position cost the same");
});

test("...and repeating a cumulative count in both frames does not double-charge it", async () => {
  const both = await anthropic(
    anth(ANSWER, `"usage":{"input_tokens":20000}`, `,"usage":{"output_tokens":1250,"input_tokens":20000}`),
  );
  assert.equal(both.usage.inputTokens, 20_000, "a MAX of the two positions, not a sum");
});

// ── the truncated tool turn ──────────────────────────────────────────────────

test("a `max_tokens`-truncated tool call is priced from the RAW argument text, not from `{}`", async () => {
  const cut = `{"path":"src/x.ts","content":"${"z".repeat(9000)}`;
  const d = await anthropic([
    `data: {"type":"message_start","message":{"usage":{"input_tokens":20000}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"fs.write"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(cut)}}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`,
    `data: {"type":"message_stop"}`,
  ]);
  assert.equal(d.finishReason, "max_tokens");
  // `safeJson` collapsed those 9,032 characters to `{}` before the floor counted them, so the
  // turn that spent its whole output allowance was charged 5 output tokens at 95a3dde.
  assert.ok(d.usage.outputTokens > 2000, `a 9,032-character argument must not be 5 tokens, got ${d.usage.outputTokens}`);
});

test("...and a block the stream never CLOSED is counted too", async () => {
  const d = await anthropic([
    `data: {"type":"message_start","message":{"usage":{"input_tokens":20000}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"fs.write"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify("q".repeat(8000))}}}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}`,
    `data: {"type":"message_stop"}`,
  ]);
  assert.ok(d.usage.outputTokens > 1900, `a never-closed 8,000-character block is still produced output, got ${d.usage.outputTokens}`);
});

// ── an unpriced model ────────────────────────────────────────────────────────

test("a dated model variant bills at its base row rather than at zero", async () => {
  const base = await anthropic(anth(ANSWER, `"usage":{"input_tokens":20000}`, `,"usage":{"output_tokens":1250}`), "claude-sonnet-5");
  const dated = await anthropic(anth(ANSWER, `"usage":{"input_tokens":20000}`, `,"usage":{"output_tokens":1250}`), "claude-sonnet-5-20260101");
  assert.ok(base.usage.costUsd > 0);
  assert.equal(dated.usage.costUsd, base.usage.costUsd, "at 95a3dde the dated variant cost $0");
});

test("the LONGEST priced prefix wins, so a variant of a variant does not fall back too far", () => {
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  const o = new OpenAIAdapter({ apiKey: "k", prices: { "m": { input: 1, output: 1 }, "m-pro": { input: 9, output: 9 } } });
  assert.equal(o.priceOf("m-pro-20260101", usage), o.priceOf("m-pro", usage));
  assert.equal(o.priceOf("m-lite-20260101", usage), o.priceOf("m", usage));
});

/**
 * A MODEL WITH NO ROW AND NO PRICED PREFIX STILL COSTS 0, AND THAT IS PINNED ON PURPOSE.
 *
 * A fallback that prices it at the dearest row in the table was built and removed: `cli.ts:2747`
 * decides which routes are unpriced by probing `priceOf(model, {1e6, 1e6}) === 0`, and
 * `test/cli/promote-live.test.ts:507` pins a live-judgement REFUSAL that rests on the same zero.
 * A total `priceOf` switches off an operator banner and an oversight refusal to close a hole an
 * embedder reaches, which is the worse trade. This test is here so that a later change which
 * makes `priceOf` total has to come past the two callers first — see `resolvePrice`.
 */
test("...but a wholly unknown model still prices 0, because two guards two levels up read that", () => {
  const usage = { inputTokens: 1e6, outputTokens: 1e6 };
  const o = new OpenAIAdapter({ apiKey: "k", prices: { known: { input: 1, output: 1 } } });
  assert.equal(o.priceOf("some-local-model", usage), 0);
  assert.ok(o.priceOf("known", usage) > 0);
});

test("`constructor` is not a price row — the table is operator JSON and is read as own keys", () => {
  const o = new OpenAIAdapter({ apiKey: "k", prices: { only: { input: 2, output: 4 } } });
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  // At 95a3dde this threw E_CONFIG_INVALID, because `prices["constructor"]` answered with the
  // `Object` function and `undefined` rates made the cost NaN. It is an unpriced model like any
  // other name the table does not hold.
  assert.equal(o.priceOf("constructor", usage), 0);
  assert.equal(o.priceOf("__proto__", usage), 0);
});
