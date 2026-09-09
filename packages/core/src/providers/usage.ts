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

import type { ModelRequest } from "../run/registry.ts";

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
 * WHAT IT BUYS, IN TOKENS AND THEN IN DOLLARS, because those are two different numbers and the
 * sentence here used to give only the first. A wire aiming at the minimum reports exactly
 * `est / 8` on each dimension and is believed, so the residual under-charge is **8x in TOKENS**,
 * against the 570x it replaces.
 *
 * IN DOLLARS IT IS 80x ON THE ANTHROPIC INPUT DIMENSION, because the floor is checked against the
 * SUM of `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` — three
 * disjoint counts billed at three different rates — and a wire may declare its whole floored
 * amount as a cache READ. Measured on an 80,000-character prompt at $3/$15/$0.30:
 *
 *     honest, plain                       in 20000                       $0.060000 input
 *     "input_tokens": 1                   floored to in 2501             $0.007503   8x
 *     "cache_read_input_tokens": 2500     floored to nothing, cr 2500    $0.000750  80x
 *
 * 80 is `USAGE_TOLERANCE x (input rate / cacheRead rate)` — TWO FACTORS COMPOUNDING — and
 * `dearestRateFloor` CLOSES ONE OF THEM, NOT BOTH. `TODO.md` §A0.13 is still open; this is a
 * narrowing, and the honest bound on what remains is stated below, driven rather than assumed.
 *
 * WHAT `dearestRateFloor` CLOSES: the `USAGE_TOLERANCE` factor. Before it, a wire could
 * UNDER-REPORT the total down to the loose sum floor (`toleratedFloor`, `/USAGE_TOLERANCE`) AND
 * mislabel that already-shrunk number as cache, paying twice. `dearestRateFloor(20000, 2500) =
 * floor((20000-2500)/8) = 2187` charges the part of the ESTIMATE the wire's own cache claim does
 * not cover at the input rate, so that combination alone no longer works: the example below turns
 * $0.00075 into $0.007311.
 *
 * WHAT IT DOES NOT CLOSE: the raw rate-ratio factor. Driven by sweeping `cache_read_input_tokens`
 * from 0 to 20,000 against this same 20,000-token estimate (`input_tokens: 0` throughout — the
 * fixture in `usage-per-rate-floor.test.ts`), the adversary's OPTIMUM is not the sum-floor value
 * 2500 — it is `cacheCredit` as close to `estimated` as the tolerance's own rounding allows:
 *
 *     cache_read_input_tokens   inputTokens forced to   costUsd
 *     2500  (the sum floor)     2187                    $0.007311
 *     10000                     1250                     $0.006750
 *     19993 (estimated - 7)     0                        $0.005998   ← the minimum
 *     20000 (the full estimate) 0                        $0.006000
 *
 * $0.005998 against $0.06 honest is a ~10.0x discount — not the ~8x this tolerance permits
 * elsewhere, and LARGER than 8x, because `dearestRateFloor` cannot tell a wire that HONESTLY
 * cache-hit the whole prompt from one that only CLAIMS to: both report `cacheCredit` close to
 * `estimated`, and `dearestRateFloor(20002, 20000) = floor(2/8) = 0` is what makes the honest
 * shape (pinned as "ORDINARY 1"/"ORDINARY 2" in the same test file) cost nothing extra. Closing
 * this residual needs the OTHER evidence this paragraph used to name instead: `#body` puts
 * `cache_control` on the last system block only, so only the tools-plus-system PREFIX is
 * cacheable, and capping credited cache tokens at that prefix's size would tell the two apart.
 * It is still not taken here, for the reason it never was: the prefix is small on exactly the
 * request shape the existing tests call an honest full cache hit (8-character `system` fields
 * claiming a 20,000-token cache hit — see those tests' fixtures), and nobody here has real
 * cached-deployment data to re-parameterize that cap without breaking them. `TODO.md` §A0.13
 * still needs updating to say the residual is ~10x, not ~80x, and that it is bounded rather than
 * removed — see this lane's report.
 *
 * `dearestRateFloor` ALSO HAS A COST ON THE ORDINARY SIDE, and it is the price of not having the
 * prefix bound above: a GENUINE partial cache hit whose real uncached remainder is small is
 * over-charged, because subtracting the wire's (trusted) `cacheCredit` from this adapter's own
 * (estimated) `billableTokens` amplifies the estimator's ordinary error onto whatever is left.
 * Measured on a 100,000-character prompt (`estimated = 25000`, same prices): an honest
 * `input_tokens: 500, cache_read_input_tokens: 20000` (a real partial hit summing to less than
 * the estimate, which the pre-existing sum floor left untouched — `20500 >= toleratedFloor(25000)
 * = 3125`) is forced to `inputTokens = max(500, dearestRateFloor(25000, 20000)) =
 * max(500, floor(5000/8)) = 625`: $0.007875 against $0.007500 honest, a 5% over-charge on the
 * whole turn (25% on the uncached dimension alone). This shrinks as the honest remainder grows
 * relative to the estimator's error and vanishes once `inputTokens >= floor((estimated -
 * cacheCredit)/8)`, which is the ordinary case for anything but a short new turn on a very large
 * cached prefix — exactly the agent-loop shape this file's header names. Pinned, not silently
 * present: `usage-per-rate-floor.test.ts`'s "ORDINARY 5".
 *
 * AND THE SOUNDNESS CONDITION HAS A SECOND HALF the eleven fixtures do not measure: the endpoint
 * has to have BILLED the request this adapter composed. See `billableTokens` for the one term
 * where that routinely fails, and for the 85x honest over-charge it cost.
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

/**
 * The least an adapter will charge `inputTokens` ALONE for whatever `cacheCredit` does not cover
 * — the per-rate floor `USAGE_TOLERANCE`'s docstring names, and a PARTIAL closure of §A0.13, not
 * a full one. Read `USAGE_TOLERANCE`'s docstring first for the sweep that says exactly how much.
 *
 * `toleratedFloor` bounds the SUM of `inputTokens + cacheReadTokens + cacheWriteTokens`, and
 * nothing stops a wire from putting the WHOLE of that sum in whichever counter is billed
 * cheapest — `cache_read_input_tokens` on the Anthropic wire, at roughly a tenth of the input
 * rate. Measured on the 80,000-character / $3-$15-$0.30 fixture `USAGE_TOLERANCE` uses
 * (`estimated = 20000`): `cache_read_input_tokens: 2500` (exactly `toleratedFloor(20000)`,
 * `input_tokens: 0`) settled at $0.00075 against $0.06 honest — 80x, the two factors
 * `USAGE_TOLERANCE`'s docstring names (`/8` under-report, `x10` rate) compounding.
 * `dearestRateFloor(20000, 2500) = floor(17500 / 8) = 2187` closes the FIRST factor only:
 * whatever the wire's own cache claim does not cover is charged at the input rate regardless of
 * how the wire split the rest, settling that same turn at $0.007311.
 *
 * WHAT THIS DOES NOT CLOSE, because it CANNOT from inside this function: a wire that instead
 * claims `cacheCredit` close to `estimated` — a fake full cache hit rather than a minimal one —
 * pays close to the raw cache-rate discount regardless (`dearestRateFloor(20000, 19993) =
 * floor(7/8) = 0`, `costUsd = $0.005998`, a ~10x discount, driven in `USAGE_TOLERANCE`'s
 * docstring). That is not a bug in the rounding below; it is the same number an HONEST full
 * cache hit legitimately costs, and no function of `(estimated, cacheCredit)` alone can tell the
 * two apart — both report the same numbers. Telling them apart needs a THIRD input this function
 * does not take: an independent bound on how much of `req` could ever legitimately be cached
 * (the tools-plus-system prefix `#body` marks `cache_control`), which `USAGE_TOLERANCE`'s
 * docstring explains is not built here for lack of real cached-deployment data.
 *
 * `Math.floor`, DELIBERATELY NOT `toleratedFloor`'s `Math.ceil`/`Math.max(1, …)` — the more
 * permissive rounding, chosen because the strict one reopens the over-charge on an honest full
 * cache hit that two earlier rounds of this same floor already had to pay back (see
 * `USAGE_TOLERANCE`'s docstring). A wire reporting cache tokens within `USAGE_TOLERANCE` of
 * `estimated` — the shape a real full cache hit takes, `cacheCredit` close to `estimated` — leaves
 * a remainder too small for `Math.floor(.../8)` to round up to even one token, and pays nothing
 * extra here: `dearestRateFloor(20002, 20000) = floor(2 / 8) = 0`. `Math.ceil` would instead force
 * one extra `inputTokens` on that same honest turn, for no adversarial reason — a real but
 * avoidable regression this function does not make.
 *
 * Clamped at 0 rather than allowed to go negative: a wire whose `cacheCredit` already exceeds
 * `estimated` (a real over-estimate on the adapter's side, not a defect on the wire's) must not
 * CREDIT `inputTokens` — this is a floor, not an adjustment.
 *
 * ASSUMES `inputTokens` IS THE DEAREST RATE, WHICH IS THE OPERATOR'S PRICE TABLE TO BREAK: this
 * function takes no `PriceRow` and cannot know it. `AnthropicAdapter.priceOf` falls back
 * `cacheWrite ?? input` / `cacheRead ?? input`, so the DEFAULT table (cache always cheaper than
 * input) and any operator table that keeps that ordering are safe; an operator row that prices
 * `cacheWrite` BELOW `input` reopens this same compounding on the write dimension, because
 * `cacheCredit` sums both without weighting by which is actually dearest. Not driven here — no
 * default or existing test uses such a table — and named as a residue rather than fixed, since
 * fixing it means threading the price row through `usage.ts`, which today has none.
 */
export function dearestRateFloor(estimated: number, cacheCredit: number): number {
  return Math.max(0, Math.floor((estimated - cacheCredit) / USAGE_TOLERANCE));
}

/**
 * The INPUT floor's estimate, which is `roughTokens` MINUS the tool specs.
 *
 * `roughTokens` is what the adapter is about to SEND and is the right number to reserve against;
 * the floor is a claim about what the endpoint BILLED, and those differ on exactly one term. An
 * OpenAI-wire gateway in front of a model with no tool support drops `tools` silently — Ollama and
 * llama.cpp both do, and `openai.ts`'s own header names that tier — so the endpoint honestly
 * reports a prompt that never contained them. Measured with 20 tool specs and an 18-token prompt:
 * the floor charged 1,529 tokens against a truthful 18, an 85x OVER-charge on an honest turn,
 * which is the direction that makes a real run hit `E_BUDGET_EXHAUSTED` with budget left.
 *
 * The floor is a LOWER bound, so dropping a term it cannot vouch for costs only floor strength,
 * and only for a request whose tool schemas dominate its prompt. `USAGE_TOLERANCE`'s soundness
 * condition is stated over tokenization alone; this is its second half — the endpoint has to have
 * billed the request the adapter composed — and `tools` is the one term an endpoint routinely
 * does not receive.
 */
export function billableTokens(req: ModelRequest): number {
  let chars = req.system.length;
  for (const m of req.messages) chars += m.content.length;
  return estimateTokens(chars);
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
 *  2. The base name of a DATED variant — `claude-sonnet-5-20260101` -> `claude-sonnet-5`. That is
 *     the ordinary shape of a model that silently reads as priced: a provider ships `-20260101`
 *     suffixes and an operator's table is written against the base name.
 *
 *     A DATE AND NOT ANY PREFIX, which the first version of this got wrong. `gpt-5-nano` and
 *     `gpt-5-chat-latest` are DIFFERENT models that merely share a prefix, and matching them onto
 *     `gpt-5` billed one of them at 100x its real rate AND took it off `cli.ts`'s unpriced-route
 *     banner — a warning switched off in the name of a price nobody configured. A `-` followed by
 *     8 digits, or by `YYYY-MM-DD`, is the only suffix a provider uses to mean "the same model,
 *     dated", so it is the only one stripped. `acme-x` no longer inherits `acme`.
 *
 *     IT STILL COSTS THE BANNER FOR THE VARIANTS IT DOES COVER: a route on
 *     `claude-sonnet-5-20260101` used to be named as unpriced at boot and used to make
 *     `loom promote --against-cohort` refuse, and now passes both. That is the right trade only
 *     because the guards' premise — "every call on it is journaled as costing 0" — is no longer
 *     true for those routes, which is exactly what changed here.
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
const DATED_VARIANT = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

export function resolvePrice(tables: readonly Readonly<Record<string, PriceRow>>[], model: string): PriceRow | undefined {
  const names = [model];
  const dated = DATED_VARIANT.exec(model);
  if (dated !== null) names.push(model.slice(0, dated.index));

  // A LIST OF TABLES IN PRECEDENCE ORDER RATHER THAN ONE MERGED OBJECT, and an `undefined` row
  // falls THROUGH rather than answering. `{...defaults, ...operatorRows}` is not equivalent to
  // the `operatorRows?.[m] ?? defaults[m]` this replaced: a spread copies an own key whose value
  // is `undefined`, so an operator row explicitly set to `undefined` shadowed the default and
  // priced the model at $0 — measured, `{prices: {"claude-sonnet-5": undefined}}` went from
  // $0.018 to $0 on a 1,000/1,000-token turn.
  //
  // EXACT BEATS PREFIX ACROSS ALL TABLES, which is why the name loop is outside: an operator's
  // `m-pro` row must not outrank a default `m-pro-20260101` one.
  for (const name of names) {
    for (const table of tables) {
      // `Object.hasOwn`, because an operator's `prices` is ordinary JSON and `table["constructor"]`
      // answers with a function that has no `input` field — a price row out of `Object.prototype`,
      // which priced a turn at NaN and threw where an unknown model would simply be unpriced.
      if (!Object.hasOwn(table, name)) continue;
      // A row that is not an object is NO ROW, not a row of `undefined` rates. An own key holding
      // `null` reached `p.input` and threw an untyped `TypeError` where the whole point of the
      // check three lines below `priceOf`'s call is that an operator's own config gets a typed
      // refusal — and where base simply fell through to the default row.
      const row = table[name] as unknown;
      if (typeof row === "object" && row !== null && !Array.isArray(row)) return row as PriceRow;
    }
  }
  return undefined;
}
