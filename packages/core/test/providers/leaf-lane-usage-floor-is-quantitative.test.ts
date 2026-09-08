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

// ── the turn shapes the floor did not see ────────────────────────────────────

test("THINKING is output and is counted — the $0 turn survived whole for an extended-thinking model", async () => {
  const think = "t".repeat(60_000);
  const frames = [
    `data: {"type":"message_start","message":{"usage":{"input_tokens":20000}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":${JSON.stringify(think)}}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
    `data: {"type":"message_stop"}`,
  ];
  // NO usage frame for output at all — the gateway case this whole floor exists for.
  const d = await anthropic(frames);
  assert.equal(d.usage.outputTokens, 15_001, `60,000 thinking characters is not one token, got ${d.usage.outputTokens}`);
  // …and a reported 1 beside them is floored, not believed.
  const lying = await anthropic([...frames.slice(0, 5), `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`, `data: {"type":"message_stop"}`]);
  assert.equal(lying.usage.outputTokens, Math.ceil(15_001 / USAGE_TOLERANCE));
});

test("...and a `redacted_thinking` block, which arrives whole rather than as deltas", async () => {
  const d = await anthropic([
    `data: {"type":"message_start","message":{"usage":{"input_tokens":20000}}}`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":${JSON.stringify("z".repeat(40_000))}}}`,
    `data: {"type":"content_block_stop","index":0}`,
    `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}`,
    `data: {"type":"message_stop"}`,
  ]);
  assert.equal(d.usage.outputTokens, 10_000);
});

test("ORDINARY: an endpoint that DROPS the tool specs is not charged for them", async () => {
  // Ollama and llama.cpp drop `tools` for a model with no tool support, so the endpoint honestly
  // reports a prompt that never contained them. The floor charged 1,529 tokens against a truthful
  // 18 — an 85x over-charge on an honest turn, which is how a real run hits E_BUDGET_EXHAUSTED
  // with budget left.
  const tools = Array.from({ length: 20 }, (_, i) => ({
    name: `tool_${String(i)}`,
    description: "does a thing, at length, ".repeat(20),
    parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
  }));
  const req: ModelRequest = { model: "gpt-5", system: "be brief", messages: [{ role: "user", content: "hi" }], tools: tools as never };
  const d = await done(
    new OpenAIAdapter({ apiKey: "k", fetch: sse(oai("ok", `,"usage":{"prompt_tokens":18,"completion_tokens":2}`)), prices: { "gpt-5": { input: 3, output: 15 } } }).stream(req, ac()),
  );
  assert.equal(d.usage.inputTokens, 18, "the endpoint's honest count must survive a request full of tool specs");
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

test("only a DATE suffix is stripped — a sibling model is not billed as its prefix", () => {
  // The first version stripped any `-` suffix, so `gpt-5-nano` billed as `gpt-5` (100x its real
  // rate) AND vanished from `cli.ts`'s unpriced-route banner. A `-` followed by 8 digits or by
  // `YYYY-MM-DD` is the only suffix a provider uses to mean "the same model, dated".
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  const o = new OpenAIAdapter({ apiKey: "k" });
  assert.equal(o.priceOf("gpt-5-20260101", usage), o.priceOf("gpt-5", usage));
  assert.equal(o.priceOf("gpt-5-2026-01-01", usage), o.priceOf("gpt-5", usage));
  assert.equal(o.priceOf("gpt-5-nano", usage), 0, "a different model that shares a prefix stays unpriced");
  assert.equal(o.priceOf("gpt-5-chat-latest", usage), 0);
  const t = new OpenAIAdapter({ apiKey: "k", prices: { acme: { input: 0.01, output: 0.01 } } });
  assert.equal(t.priceOf("acme-x", usage), 0, "`acme-x` must not inherit `acme`");
});

test("a row that is present but not an object is NO row, not a row of undefined rates", () => {
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  // `null` reached `p.input` and threw an untyped TypeError; base fell through to the default.
  assert.equal(new OpenAIAdapter({ apiKey: "k", prices: { "gpt-5": null } as never }).priceOf("gpt-5", usage), 0.02);
  assert.equal(new OpenAIAdapter({ apiKey: "k", prices: { "gpt-5": 3 } as never }).priceOf("gpt-5", usage), 0.02);
});

/**
 * A MODEL WITH NO ROW AND NO PRICED PREFIX STILL COSTS 0, AND THAT IS PINNED ON PURPOSE.
 *
 * A fallback that prices it at the dearest row in the table was built and removed: `cli.ts`'s
 * `pricedFor` decides which routes are unpriced, and `test/cli/promote-live.test.ts:507` pins a
 * live-judgement REFUSAL that rests on the same zero. A total `priceOf` switches off an operator
 * banner and an oversight refusal to close a hole an embedder reaches, which is the worse trade.
 * This test is here so that a later change which makes `priceOf` total has to come past those
 * callers first — see `resolvePrice`.
 *
 * WHAT CHANGED AROUND IT, so this docstring does not read as "and therefore an unpriced model is
 * free". The zero is unchanged and still what the CLI probes; what the CLI does with it is not.
 * `pricedFor` asks `ModelAdapter.hasPrice` first (optional, and neither HTTP adapter implements
 * it yet — one line each in `providers/{anthropic,openai}.ts` would), then the operator's own
 * `prices` row through `resolvePrice`, and only then this zero. And `RoutingAdapter` REFUSES a
 * route it lands on, at `estimateOf`/`stream`/`priceOf`, so an unpriced model no longer runs
 * against a budget it cannot bind. An explicitly free endpoint says so with a `{input: 0,
 * output: 0}` row, which is the case the bare probe could never distinguish from this one.
 */
test("...but a wholly unknown model still prices 0, because two guards two levels up read that", () => {
  const usage = { inputTokens: 1e6, outputTokens: 1e6 };
  const o = new OpenAIAdapter({ apiKey: "k", prices: { known: { input: 1, output: 1 } } });
  assert.equal(o.priceOf("some-local-model", usage), 0);
  assert.ok(o.priceOf("known", usage) > 0);
});

test("an operator row is still preferred to the default, and an `undefined` one falls through", () => {
  // `{...DEFAULT_PRICES, ...opts.prices}` is NOT equivalent to `opts.prices?.[m] ?? DEFAULTS[m]`:
  // a spread copies an own key whose value is `undefined`, so an operator row set to `undefined`
  // shadowed the default and priced the model at $0. Measured, this turn went $0.018 -> $0.
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  const own = new OpenAIAdapter({ apiKey: "k", prices: { "gpt-5": { input: 1, output: 1 } } });
  assert.equal(own.priceOf("gpt-5", usage), 0.002, "the operator's own row wins over the default");
  const gap = new OpenAIAdapter({ apiKey: "k", prices: { "gpt-5": undefined } as never });
  assert.equal(gap.priceOf("gpt-5", usage), (1000 / 1e6) * 5 + (1000 / 1e6) * 15, "an undefined row is no row");
});

test("...and an EXACT row beats a prefix one, whichever table each lives in", () => {
  const usage = { inputTokens: 1000, outputTokens: 1000 };
  // The default table holds `claude-haiku-4-5-20251001`; an operator row for the shorter
  // `claude-haiku-4-5` must not outrank it for the exact dated name.
  const a = new AnthropicAdapter({ apiKey: "k", prices: { "claude-haiku-4-5": { input: 99, output: 99 } } });
  assert.equal(a.priceOf("claude-haiku-4-5-20251001", usage), 0.0048, "the default table's exact dated row");
  assert.equal(a.priceOf("claude-haiku-4-5-20260101", usage), 0.198, "no exact row, so the operator's prefix answers");
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
