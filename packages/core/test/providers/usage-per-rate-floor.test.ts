/**
 * TODO.md §A0.13 — THE FLOOR TESTED A SUM BILLED AT THREE RATES, SO A WIRE COULD PUT THE WHOLE
 * OF IT IN THE CHEAPEST ONE.
 *
 * `anthropic-usage-floor.test.ts` and `leaf-lane-usage-floor-is-quantitative.test.ts` pin the
 * SUM floor (`toleratedFloor(billableTokens(req))` against `inputTokens + cacheReadTokens +
 * cacheWriteTokens`) and the zero rules beneath it. Both leave the exploit this file pins: the
 * sum floor is satisfiable entirely out of `cache_read_input_tokens`, at ~10x the input rate on
 * the Anthropic wire — an ~8x under-report (already tolerated) compounding into ~80x in dollars.
 *
 * This file pins `dearestRateFloor` (`providers/usage.ts`), the per-rate floor that closes it:
 * whatever part of the estimate the wire's own cache claim does not cover is charged at the
 * input rate, on top of whatever the sum floor already added — regardless of how the wire split
 * the rest.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AnthropicAdapter } from "../../src/providers/anthropic.ts";
import { dearestRateFloor } from "../../src/providers/usage.ts";
import type { ModelEvent, ModelRequest } from "../../src/run/registry.ts";

const ac = (): AbortSignal => new AbortController().signal;

function sseFetch(frames: readonly string[]) {
  return async (): Promise<Response> =>
    new Response(frames.map((f) => `${f}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function done(it: AsyncIterable<ModelEvent>): Promise<Extract<ModelEvent, { type: "done" }>> {
  let last: ModelEvent | undefined;
  for await (const ev of it) last = ev;
  assert.equal(last?.type, "done");
  return last as Extract<ModelEvent, { type: "done" }>;
}

const PRICES = { "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };

// A request whose `billableTokens` estimate is exactly 20,000: empty system, an 80,000-character
// user message, no tools. `toleratedFloor(20000) = ceil(20000/8) = 2500`.
const PROMPT = "x".repeat(80_000);
const REQ: ModelRequest = { model: "claude-sonnet-5", system: "", messages: [{ role: "user", content: PROMPT }], tools: [] };

const anth = (usageStart: string, usageDelta: string): readonly string[] => [
  `data: {"type":"message_start","message":{"usage":${usageStart}}}`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":${usageDelta}}`,
  `data: {"type":"message_stop"}`,
];

const anthropic = (frames: readonly string[]): Promise<Extract<ModelEvent, { type: "done" }>> =>
  done(new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(frames), prices: PRICES }).stream(REQ, ac()));

// ── the exploit half ─────────────────────────────────────────────────────────

test(
  "declaring cache_read_input_tokens:2500 (exactly toleratedFloor(20000)) with input_tokens:0 " +
    "must charge floor((20000-2500)/8)=2187 uncached input tokens, not 0",
  async () => {
    const d = await anthropic(anth(`{"input_tokens":0,"cache_read_input_tokens":2500}`, `{"output_tokens":0}`));
    // Sanity: the helper computes what the arithmetic in the test's name states.
    assert.equal(dearestRateFloor(20000, 2500), 2187);
    assert.equal(d.usage.cacheReadTokens, 2500, "the wire's own cache number is still reported as reported");
    assert.equal(
      d.usage.inputTokens,
      2187,
      `a wire putting the whole SUM floor in cache_read_input_tokens must not buy the turn at input=0, got ${d.usage.inputTokens}`,
    );
    // (2187 * $3 + 2500 * $0.30) / 1e6 = $0.007311 — against the $0.00075 this defeat priced at
    // 49624c0 (an 80x under-charge against the $0.06 honest turn) and the $0.06 honest charge
    // itself. Reproduced RED at 49624c0 below; this is the fixed, GREEN value.
    assert.equal(d.usage.costUsd, 0.007311, `expected the per-rate floor to settle at $0.007311, got ${d.usage.costUsd}`);
  },
);

/**
 * THIS FIX NARROWS THE EXPLOIT, IT DOES NOT CLOSE IT — flagged by a fresh reviewer (round 1), who
 * found the adversary's TRUE optimum is not the sum-floor value 2500 pinned above: it is claiming
 * `cacheCredit` close to `estimated`, which `dearestRateFloor` cannot distinguish from a genuine
 * full cache hit (both report the same two numbers). Driven by sweeping `cache_read_input_tokens`
 * against the same 20,000-token estimate — see `USAGE_TOLERANCE`'s docstring in `usage.ts` for the
 * full table this reproduces one row of.
 */
test(
  "...but claiming a (fake) FULL cache hit beats claiming the sum floor — " +
    "cache_read_input_tokens:19993 costs $0.005998, a ~10.0x discount the per-rate floor cannot see",
  async () => {
    const d = await anthropic(anth(`{"input_tokens":0,"cache_read_input_tokens":19993}`, `{"output_tokens":0}`));
    assert.equal(dearestRateFloor(20000, 19993), 0, "the remainder (7 tokens) is too small to round up");
    assert.equal(d.usage.inputTokens, 0);
    assert.equal(
      d.usage.costUsd,
      0.005998,
      `this is the adversary's minimum over the whole 0..20000 range this lane swept, not $0.00075 — ` +
        `it is NOT further reducible by this fix, and it is honest ~10x (the raw cacheRead/input rate ` +
        `ratio for claude-sonnet-5), not the ~80x the sum-floor defeat achieved`,
    );
  },
);

test("...and the same shortfall put in cache_creation_input_tokens is charged the same way", async () => {
  const d = await anthropic(anth(`{"input_tokens":0,"cache_creation_input_tokens":2500}`, `{"output_tokens":0}`));
  assert.equal(d.usage.cacheWriteTokens, 2500);
  assert.equal(d.usage.inputTokens, 2187, `cache WRITE must not buy the turn either, got ${d.usage.inputTokens}`);
});

test("...and splitting the floor across both cache dimensions is still caught by the combined credit", async () => {
  // 1250 read + 1250 write = 2500, the same total the two tests above each declared alone.
  const d = await anthropic(anth(`{"input_tokens":0,"cache_read_input_tokens":1250,"cache_creation_input_tokens":1250}`, `{"output_tokens":0}`));
  assert.equal(d.usage.cacheReadTokens, 1250);
  assert.equal(d.usage.cacheWriteTokens, 1250);
  assert.equal(d.usage.inputTokens, 2187, `dearestRateFloor reads the SUM of both cache dimensions, got ${d.usage.inputTokens}`);
});

// ── the ordinary half — a wire whose split genuinely accounts for the estimate is unchanged ──

test("ORDINARY 1: a full cache hit (cacheCredit == the estimate) is charged exactly as before", async () => {
  // Same fixture `anthropic-usage-floor.test.ts:230-236` and
  // `leaf-lane-usage-floor-is-quantitative.test.ts:133-138` pin: system "be brief" (8 chars),
  // an 80,000-character prompt, billableTokens = 20,002. `cache_read_input_tokens: 20000` is
  // within 2 tokens of the full estimate — the shape a real full cache hit takes.
  const req: ModelRequest = { model: "claude-sonnet-5", system: "be brief", messages: [{ role: "user", content: PROMPT }], tools: [] };
  const d = await done(
    new AnthropicAdapter({ apiKey: "k", fetch: sseFetch(anth(`{"input_tokens":0,"cache_read_input_tokens":20000}`, `{"output_tokens":0}`)), prices: PRICES }).stream(
      req,
      ac(),
    ),
  );
  // dearestRateFloor(20002, 20000) = floor(2/8) = 0 — no top-up. BEFORE this fix: inputTokens=0,
  // costUsd=0.006. AFTER: identical.
  assert.equal(dearestRateFloor(20002, 20000), 0);
  assert.equal(d.usage.inputTokens, 0, "a genuine full cache hit is not re-charged at the uncached rate");
  assert.equal(d.usage.cacheReadTokens, 20_000);
  assert.equal(d.usage.costUsd, 0.006, "20000 * $0.30/M, unchanged before and after this fix");
});

test("ORDINARY 2: a full cache WRITE (cacheCredit == the estimate) is charged exactly as before", async () => {
  const req: ModelRequest = { model: "claude-sonnet-5", system: "be brief", messages: [{ role: "user", content: PROMPT }], tools: [] };
  const d = await done(
    new AnthropicAdapter({
      apiKey: "k",
      fetch: sseFetch(anth(`{"input_tokens":0,"cache_creation_input_tokens":20000}`, `{"output_tokens":0}`)),
      prices: PRICES,
    }).stream(req, ac()),
  );
  assert.equal(d.usage.inputTokens, 0, "a genuine full cache write is not re-charged at the uncached rate");
  assert.equal(d.usage.cacheWriteTokens, 20_000);
  assert.equal(d.usage.costUsd, 0.075, "20000 * $3.75/M, unchanged before and after this fix");
});

test("ORDINARY 3: a real PARTIAL cache hit that sums to the estimate is charged exactly as before", async () => {
  // inputTokens + cacheReadTokens = 20000 = the estimate exactly: the shape a genuine partial
  // cache hit takes (some of the prefix cached, the rest freshly billed as uncached input).
  const d = await anthropic(anth(`{"input_tokens":17500,"cache_read_input_tokens":2500}`, `{"output_tokens":0}`));
  // dearestRateFloor(20000, 2500) = 2187 < the 17500 already reported, so no top-up either way.
  assert.equal(dearestRateFloor(20000, 2500), 2187);
  assert.equal(d.usage.inputTokens, 17_500, "an honest split that already accounts for the estimate is untouched");
  assert.equal(d.usage.cacheReadTokens, 2500);
  assert.equal(d.usage.costUsd, 0.0532_5, "(17500*$3 + 2500*$0.30)/1e6, unchanged before and after this fix");
});

test("ORDINARY 4: no cache reported at all is untouched — dearestRateFloor degenerates to the sum floor", async () => {
  // cacheCredit = 0, so dearestRateFloor(estimate, 0) = floor(estimate/8) <= toleratedFloor's
  // ceil(estimate/8), and the sum floor above it already forces inputTokens there first.
  const d = await anthropic(anth(`{"input_tokens":1}`, `{"output_tokens":0}`));
  assert.equal(d.usage.inputTokens, 2500, "the pre-existing sum floor (toleratedFloor(20000)-1+1) is unaffected");
});

/**
 * ORDINARY 5 IS NOT UNCHANGED — flagged by a fresh reviewer (round 1) as a real, quantified
 * over-charge on a genuine partial cache hit, and pinned here rather than left silent. A GENUINE
 * partial cache hit whose real uncached remainder is small is over-charged, because subtracting
 * the wire's `cacheCredit` from this adapter's own ESTIMATE amplifies the estimator's ordinary
 * error onto whatever is left. See `dearestRateFloor`'s docstring in `usage.ts` for the general
 * statement; this pins the exact number on a 100,000-character prompt (`estimated = 25000`).
 */
test(
  "ORDINARY 5 (NOT unchanged, and pinned as such): a genuine small uncached remainder beside a " +
    "large honest cache hit is over-charged by dearestRateFloor(25000,20000)-500 = 125 tokens",
  async () => {
    const req: ModelRequest = { model: "claude-sonnet-5", system: "", messages: [{ role: "user", content: "x".repeat(100_000) }], tools: [] };
    const d = await done(
      new AnthropicAdapter({
        apiKey: "k",
        fetch: sseFetch(anth(`{"input_tokens":500,"cache_read_input_tokens":20000}`, `{"output_tokens":0}`)),
        prices: PRICES,
      }).stream(req, ac()),
    );
    // The pre-existing sum floor alone would leave this untouched: 20500 >= toleratedFloor(25000)
    // = 3125. `dearestRateFloor(25000, 20000) = floor(5000/8) = 625` forces it up regardless.
    assert.equal(dearestRateFloor(25000, 20000), 625);
    assert.equal(
      d.usage.inputTokens,
      625,
      `an honest input_tokens:500 next to a genuine 20,000-token cache hit is raised to 625, not left at 500`,
    );
    assert.equal(d.usage.cacheReadTokens, 20_000, "the wire's honest cache number is untouched");
    // (625*$3 + 20000*$0.30)/1e6 = $0.007875 against $0.007500 honest — a 5% over-charge on the
    // whole turn, the price of not having the cacheable-prefix bound `USAGE_TOLERANCE`'s docstring
    // names. It shrinks as the honest remainder grows and vanishes once inputTokens itself already
    // clears dearestRateFloor — see ORDINARY 3, where 17,500 already does.
    assert.equal(d.usage.costUsd, 0.007875, `expected the documented over-charge, got ${d.usage.costUsd}`);
  },
);
