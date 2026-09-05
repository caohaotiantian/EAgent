/**
 * What an adapter is allowed to believe about the numbers a remote party wrote.
 *
 * Every value in a provider's `usage` frame arrives through `JSON.parse` on bytes somebody else
 * chose, and each one is an input to `PolicyEngine`'s running total. This module holds the three
 * decisions that answer to that, in one place so two adapters cannot answer them differently.
 *
 * NOT RE-EXPORTED BY `index.ts`, WHICH IS THE WHOLE REASON IT CAN EXIST. `wireCount` used to be
 * written out twice, in `anthropic.ts` and again in `openai.ts`, and both copies carried a
 * comment saying sharing it would widen the pinned public surface. That was checkable and false:
 * `scripts/check-surface.mjs` pins the exports of `packages/core/dist/index.d.ts`, and `index.ts`
 * re-exports four provider modules BY NAME. A fifth it does not name adds nothing to the pin —
 * verified by running the guard against this file, which reports the surface unchanged.
 */

/**
 * A token count off the wire, or `undefined` if the remote party did not send one an adapter can
 * bill from.
 *
 * `UsageRecord` is typed `number`, but a type annotation stops nothing at runtime. An
 * `{"output_tokens":"abc"}` frame made `costUsd` NaN, and NaN is the value that DISABLES a budget
 * rather than tripping it: `PolicyEngine` accumulates it into `#spentUsd`, every later
 * `committed > limit` is `NaN > limit` = false, and the run's ceiling is gone for the rest of its
 * life. `-5` is the same defect with the sign flipped — it CREDITS the budget.
 *
 * So a value that is not a finite, non-negative number counts as NOT REPORTED, and the floor
 * charges the estimate instead. That is the conservative answer of the two available: failing the
 * whole turn would throw away a completed answer over an accounting field and hand the retry
 * ladder a licence to buy it a second time, while the estimate is a number that refuses
 * eventually. What this function guarantees is the part that matters — no arithmetic downstream
 * of it can produce a NaN out of a value the provider wrote.
 */
export function wireCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * How far below its own estimate an adapter will believe a reported count.
 *
 * THE RULES THAT ONLY CLOSED THE ZERO WERE DEFEATED BY ASSERTING `1`. Measured at 95a3dde on an
 * 80,000-character prompt priced $3/$15/$0.30 per million: `"cache_read_input_tokens": 1` bought
 * the whole turn for $0.000105 against $0.006105 honest, `"input_tokens": 1` for $0.000108
 * against $0.078750, and `"output_tokens": 1` charged $0.060015 against $0.078750 — a ~570x
 * under-charge on the input dimension, from adding one. Under-charging is the LOOSENING direction
 * for `budget.runUsd` and `budget.runTokens`, so the quantitative rule is the one that matters
 * and the tolerance is the whole of it.
 *
 * 8, AND IT IS MEASURED RATHER THAN PICKED. The estimator is `ceil(chars/4)`, so a floor at
 * `est / K` never fires on an honest turn as long as `K >= chars_per_token / 4` for every shape a
 * real request or answer takes. `chars_per_token` was bounded two ways over eleven fixtures
 * (prose, TypeScript, pretty JSON, Chinese, a YAML graph, markdown with rule lines, a base64
 * blob, 24-space-indented code, tab-and-space runs, and two one-line requests):
 *
 *   (A) A RIGOROUS UPPER BOUND. A GPT-2/cl100k-style BPE never merges across the pretokenizer's
 *       boundaries and no vocabulary entry exceeds MAXTOK characters, so the true token count is
 *       at least `sum over pretokens of ceil(len / MAXTOK)`. Worst `est / lower_bound` over the
 *       eleven: 2.40 at MAXTOK 16, 3.51 at MAXTOK 32.
 *   (B) PUBLISHED AVERAGE chars-per-token for the shape — prose 4.0, code 3.3, JSON 3.2, CJK 1.2,
 *       an assumption and named as one. Worst `est / that`: 1.30.
 *
 * The two rows that drive (A)'s worst — Chinese and long whitespace runs — are where the LOWER
 * BOUND is loosest, and (B) says the estimator under-counts both by 3x, which is the safe
 * direction. So 8 clears the rigorous worst by 2.3x and the realistic one by 6x. A maintainer who
 * wants a tighter guard can read 4 off the same table; `TODO.md` §A0.13 has it.
 *
 * WHAT IT BUYS AND WHAT IT DOES NOT. A wire that wants to pay the minimum reports exactly
 * `est / 8` and is believed, so the residual under-charge is 8x rather than 570x. That is the
 * bound, and it is a bound rather than a proof: no adapter without a tokenizer can do better than
 * its own estimate.
 */
export const USAGE_TOLERANCE = 8;

/** The repo's tokenizer-free estimator: four characters to a token, and never zero. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * The least an adapter will charge for a dimension it estimated at `estimated` tokens.
 *
 * `ceil(estimated / USAGE_TOLERANCE)` AND NOT `estimated`, when the rule fires. The two have
 * identical adversarial strength — a wire aiming at the minimum reports the threshold and is
 * believed either way — so charging the full estimate buys nothing against a hostile report and
 * costs an 8x over-charge on an honest turn that trips a threshold measured wrong. It is the
 * smaller of the two claims the evidence supports, which is the one to make.
 *
 * This never lowers a charge the zero rules already make: those fire where the adapter holds
 * evidence against a reported zero, and they still charge the whole estimate.
 */
export function toleratedFloor(estimated: number): number {
  return Math.max(1, Math.ceil(estimated / USAGE_TOLERANCE));
}

/** USD per million tokens for one model, as a price table row. */
export interface PriceRow {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * The row to bill `model` at, or nothing if the table does not price it.
 *
 * `priceOf` returned 0 for a model with no table entry, so `claude-sonnet-5-20260101` cost $0 on
 * the turn `claude-sonnet-5` cost $0.135, measured at 95a3dde. Tokens still floored, so
 * `budget.runTokens` bound and `budget.runUsd` did not: the same "zero is the passing value" shape
 * the usage floor exists for, two lines below it.
 *
 * TWO RESOLUTIONS, AND THE ONE THAT IS MISSING IS THE POINT OF THIS PARAGRAPH:
 *
 *  1. The model's own row.
 *  2. The longest `-`-boundary PREFIX with a row. A dated variant is the ordinary shape of a
 *     model that silently reads as priced — a provider ships `-20260101` suffixes and an
 *     operator's table is written against the base name — and a variant bills at its base rate.
 *
 * WHAT IS NOT HERE: a fallback that prices a wholly unknown model at the dearest row in the
 * table, so that no model is ever free. It was built and then removed, because a zero here is
 * LOAD-BEARING TWO LEVELS UP. `cli.ts` decides which routes are unpriced by probing
 * `priceOf(model, {1e6, 1e6}) === 0` and banners them at boot, and a live promotion judgement is
 * REFUSED on an adapter that answers 0 — so a total `priceOf` silently switches off an operator
 * warning and an oversight refusal, which is a strictly worse trade than the hole it closes. What
 * that fallback needs first is a way for a caller to ask "is this model priced?" separately from
 * "what does it cost" — a predicate on `ModelAdapter`, in `run/registry.ts`, with `cli.ts`'s two
 * probes moved onto it. `TODO.md` §A0.14 and this lane's report carry the handoff.
 *
 * Refusing an unpriced model at submit or compile time is the third option and is louder still.
 * It is not available from here: the price table is adapter CONSTRUCTION config that the compiler
 * never sees.
 */
export function resolvePrice(table: Readonly<Record<string, PriceRow>>, model: string): PriceRow | undefined {
  // `Object.hasOwn`, because an operator's `prices` is ordinary JSON and `table["constructor"]`
  // answers with a function that has no `input` field — a price row out of `Object.prototype`,
  // which priced a turn at NaN and threw where an unknown model would simply have been unpriced.
  if (Object.hasOwn(table, model)) return table[model] as PriceRow;

  for (let cut = model.lastIndexOf("-"); cut > 0; cut = model.lastIndexOf("-", cut - 1)) {
    const base = model.slice(0, cut);
    if (Object.hasOwn(table, base)) return table[base] as PriceRow;
  }
  return undefined;
}
