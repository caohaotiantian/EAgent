/**
 * THE ARITHMETIC OF THE LIVE PROMOTION GATE, held down away from any store.
 *
 * `evolution/live.ts` is the half of `loom promote --against-cohort` that decides. The CLI half
 * — where the inputs come from, what gets run, what is journaled — is driven end to end in
 * `test/cli/promote-live.test.ts`; this file pins the numbers, because a decision rule nobody
 * can recompute is not one anybody can argue with.
 *
 * FOUR PROPERTIES, and each is a way the mode could quietly stop being a gate:
 *
 * 1. The bound is a BOUND, not a mean. A candidate that won by an average of 0.05 with wild
 *    per-input variance must not promote; the same mean with tight variance must. That is the
 *    whole reason the rule is not `mean > 0`, and it is the difference the replayed gate's
 *    `2-non-inferior` — "a bare point estimate", by its own docstring — cannot see.
 * 2. `8-determinism` is reported `ran: false, pass: false`. Never `pass: true`: nothing was
 *    compared. And the naive fold — `checks.every(c => c.pass)`, which is what a consumer
 *    writes without reading the file — must read a live verdict as NOT fully passing even when
 *    the mode promotes, so a live certificate cannot impersonate the replayed one.
 * 3. A missing measurement is refused rather than absorbed. A candidate whose run never reached
 *    a terminal state is not a zero and is not an absence.
 * 4. The t table rounds toward STRICTNESS. Between two tabulated degrees of freedom the larger
 *    quantile is used, so the bound is narrower than the true one and never wider — the only
 *    direction a promotion gate may round.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_PAIRED_RUNS,
  gateCandidateLive,
  pairedDifference,
  type LivePair,
  type LivePromotionInput,
} from "../../src/evolution/live.ts";
import type { RunId } from "../../src/ids.ts";

/** A pair with the two scores that matter and defensible money on both sides. */
function pair(i: number, base: number, cand: number, baseCost = 0.01, candCost = 0.01): LivePair {
  return {
    baselineRunId: `01BASE${String(i).padStart(20, "0")}` as RunId,
    candidateRunId: `01CAND${String(i).padStart(20, "0")}` as RunId,
    baselineScore: base,
    candidateScore: cand,
    baselineCostUsd: baseCost,
    candidateCostUsd: candCost,
  };
}

function input(pairs: readonly LivePair[], over: Partial<LivePromotionInput> = {}): LivePromotionInput {
  return {
    pairs,
    unmeasured: [],
    postureDiffNonNegative: true,
    promptGrowth: 0,
    gatingRegressions: [],
    ...over,
  };
}

// ── 1 · the bound is a bound ─────────────────────────────────────────────────

test("the paired statistic is a one-sided 95% LOWER BOUND, and every number is recomputable", () => {
  // Six differences, all positive, tight: mean 1/6, sd 0.0816497, se 0.0333333, t(df 5) 2.015.
  const d = pairedDifference([0.1, 0.2, 0.1, 0.3, 0.1, 0.2]);
  assert.equal(d.n, 6);
  assert.equal(d.mean, 0.166667);
  assert.equal(d.sd, 0.08165);
  // 0.1666667 − 2.015 × (0.0816497 / √6)
  assert.equal(d.lower95, 0.0995);
  assert.deepEqual([d.wins, d.losses, d.ties], [6, 0, 0]);
  // A clean 6–0 sweep is exactly 2⁻⁶ under the sign test, and that is the smallest p six
  // paired observations can produce.
  assert.equal(d.signTestP, 0.015625);
});

test("...so the SAME mean with wild variance does not promote, and with tight variance does", () => {
  // The property the replayed gate's point estimate cannot see. Both sets have mean 0.05.
  const noisy = [0.5, -0.4, 0.3, -0.2, 0.1, 0.0];
  const tight = [0.05, 0.06, 0.04, 0.05, 0.05, 0.05];
  assert.equal(
    Math.abs(noisy.reduce((a, b) => a + b, 0) / 6 - tight.reduce((a, b) => a + b, 0) / 6) < 1e-9,
    true,
    "the two sets must share a mean, or this test is about something else",
  );

  const noisyD = pairedDifference(noisy);
  const tightD = pairedDifference(tight);
  assert.equal(noisyD.lower95 < 0, true, `a mean carried by one lucky input must not clear 0: ${String(noisyD.lower95)}`);
  assert.equal(tightD.lower95 > 0, true, `a consistent gain must clear 0: ${String(tightD.lower95)}`);

  const noisyV = gateCandidateLive(input(noisy.map((x, i) => pair(i, 0.5, 0.5 + x))));
  const tightV = gateCandidateLive(input(tight.map((x, i) => pair(i, 0.5, 0.5 + x))));
  assert.equal(noisyV.promote, false);
  assert.equal(noisyV.checks.find((c) => c.id === "L1-paired-improvement")!.pass, false);
  assert.equal(tightV.promote, true, JSON.stringify(tightV.checks.filter((c) => c.ran && !c.pass)));
});

test("one pair yields NO bound, and the undecidable case fails closed rather than promoting", () => {
  const d = pairedDifference([0.9]);
  assert.equal(d.mean, 0.9);
  assert.equal(d.sd, 0);
  assert.equal(d.lower95, 0, "no dispersion is estimable from one observation");

  const v = gateCandidateLive(input([pair(0, 0.0, 0.9)]));
  const l1 = v.checks.find((c) => c.id === "L1-paired-improvement")!;
  assert.equal(l1.ran, false, "a check with no data must report that it had none");
  assert.equal(l1.pass, false);
  assert.equal(v.promote, false);
  // …and the count floor refuses it independently, so removing either does not open the door.
  assert.equal(v.checks.find((c) => c.id === "L3-paired-count")!.pass, false);
  assert.equal(MIN_PAIRED_RUNS, 6);
});

// ── 2 · the check that cannot run ────────────────────────────────────────────

test("8-determinism is reported as NOT RUN — never as passed — even when the mode promotes", () => {
  const v = gateCandidateLive(input([0.05, 0.06, 0.04, 0.05, 0.05, 0.05].map((x, i) => pair(i, 0.5, 0.5 + x))));
  assert.equal(v.promote, true, JSON.stringify(v.checks.filter((c) => c.ran && !c.pass)));

  const det = v.checks.find((c) => c.id === "8-determinism")!;
  assert.equal(det.ran, false);
  assert.equal(det.pass, false, "nothing was compared, so `pass: true` would be a claim about work not done");
  assert.match(det.detail, /DID NOT RUN/);
  assert.deepEqual(v.notRun, ["8-determinism"], "the verdict names its own blind spots");

  // THE FOLD A CONSUMER WRITES WITHOUT READING live.ts. A live certificate must not be able to
  // impersonate the replayed gate's, and this is the line that makes that mechanical: the same
  // expression `test/cli/promote.test.ts` asserts is `true` for a replayed promotion is `false`
  // here, on a verdict that DID promote.
  assert.equal(
    v.checks.every((c) => c.pass),
    false,
    "the naive fold must read a live verdict conservatively",
  );
});

// ── 3 · a missing measurement is not a zero and not an absence ───────────────

test("a candidate run that never reached a terminal state refuses the promotion by count", () => {
  const winning = [0.05, 0.06, 0.04, 0.05, 0.05, 0.05].map((x, i) => pair(i, 0.5, 0.5 + x));
  const v = gateCandidateLive(
    input(winning, {
      unmeasured: [
        { baselineRunId: "01BASE99" as RunId, candidateRunId: "01CAND99" as RunId, status: "awaiting_gate" },
      ],
    }),
  );
  assert.equal(v.promote, false);
  const l2 = v.checks.find((c) => c.id === "L2-every-input-measured")!;
  assert.equal(l2.pass, false);
  assert.match(l2.detail, /awaiting_gate/, "the refusal names the run and what happened to it");
  // Every OTHER check that ran passed, so this really is the one that refused it.
  assert.deepEqual(v.checks.filter((c) => c.ran && !c.pass).map((c) => c.id), ["L2-every-input-measured"]);
});

test("a candidate that FAILED half its inputs is paired at 0 and loses on the arithmetic", () => {
  // The other half of the same decision: a terminal failure is a measurement, and the score
  // floor already prices it. It must not escape the comparison by being called "missing".
  const pairs = [
    pair(0, 0.6, 0),
    pair(1, 0.6, 0),
    pair(2, 0.6, 0),
    pair(3, 0.6, 0.9),
    pair(4, 0.6, 0.9),
    pair(5, 0.6, 0.9),
  ];
  const v = gateCandidateLive(input(pairs));
  assert.equal(v.promote, false);
  assert.equal(v.checks.find((c) => c.id === "L2-every-input-measured")!.pass, true, "nothing was missing — they ran and failed");
  assert.equal(v.checks.find((c) => c.id === "L1-paired-improvement")!.pass, false);
  assert.equal(v.paired.wins, 3);
  assert.equal(v.paired.losses, 3);
});

// ── 4 · the table rounds toward strictness ───────────────────────────────────

test("between two tabulated degrees of freedom the LARGER quantile is used", () => {
  // df 40 and df 41 must both read t = 1.684 (the df-40 row), not df 60's 1.671. The bound is
  // therefore narrower than the true one — the only direction a promotion gate may round.
  const make = (n: number): number[] => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.1 : 0.2));
  for (const [n, t] of [[41, 1.684], [42, 1.684], [61, 1.671], [7, 1.943]] as const) {
    const d = pairedDifference(make(n));
    // `d.sd` and `d.mean` are already rounded to six places, so the expectation is recomputed
    // from rounded inputs and compared within a hair rather than exactly — the assertion is
    // about WHICH t was used, and the two candidate quantiles are 0.013 apart.
    const se = d.sd / Math.sqrt(n);
    assert.ok(
      Math.abs(d.lower95 - (d.mean - t * se)) < 2e-6,
      `n=${String(n)} (df ${String(n - 1)}) must use t=${String(t)}: bound ${String(d.lower95)} vs ${String(d.mean - t * se)}`,
    );
  }
});

// ── the oversight and cost checks are real here ──────────────────────────────

test("oversight and cost still refuse, and each is the only thing wrong with its candidate", () => {
  const winning = [0.05, 0.06, 0.04, 0.05, 0.05, 0.05].map((x, i) => pair(i, 0.5, 0.5 + x));

  const lowered = gateCandidateLive(input(winning, { postureDiffNonNegative: false }));
  assert.deepEqual(lowered.checks.filter((c) => c.ran && !c.pass).map((c) => c.id), ["6-oversight-diff"]);

  const ungated = gateCandidateLive(input(winning, { gatingRegressions: ['the recording gated node "publish" and this candidate did not'] }));
  assert.deepEqual(ungated.checks.filter((c) => c.ran && !c.pass).map((c) => c.id), ["L4-gated-at-least-as-much"]);
  assert.match(ungated.checks.find((c) => c.id === "L4-gated-at-least-as-much")!.detail, /publish/);

  // Twice the money for the same six inputs.
  const dear = gateCandidateLive(input(winning.map((p, i) => ({ ...pair(i, p.baselineScore, p.candidateScore, 0.01, 0.02) }))));
  assert.deepEqual(dear.checks.filter((c) => c.ran && !c.pass).map((c) => c.id), ["3-cost"]);
  assert.match(dear.checks.find((c) => c.id === "3-cost")!.detail, /2\.00×/);

  // A prompt that grew 40% has to earn its keep. `winning`'s paired mean is exactly 0.05, which
  // IS the bloat offset and buys the growth — so the refusal needs a candidate that wins by a
  // little less. This set's mean is 0.04 and its bound is still comfortably above 0, so the
  // prompt-size rule is the only thing standing between it and a promotion.
  const slimmerWin = [0.04, 0.045, 0.035, 0.04, 0.04, 0.04].map((x, i) => pair(i, 0.5, 0.5 + x));
  assert.equal(gateCandidateLive(input(slimmerWin)).promote, true, "the control must promote, or this proves nothing");
  const fat = gateCandidateLive(input(slimmerWin, { promptGrowth: 0.4 }));
  assert.deepEqual(fat.checks.filter((c) => c.ran && !c.pass).map((c) => c.id), ["5-prompt-size"]);
  // …and the SAME growth is bought by a bigger win, which is the bargain the check encodes.
  assert.equal(gateCandidateLive(input(winning, { promptGrowth: 0.4 })).promote, true);
});

test("a cost ratio over a ZERO baseline is reported as not run, never as 1.00×", () => {
  // The first version answered the undecidable case with the PASSING value:
  // `baseCost === 0 ? 1 : …`. Driven by this lane's reviewer — six pairs at a $0 baseline and
  // a $100 candidate promoted, reporting "cost ratio 1.00×" over a division nobody performed.
  const zeroBase = Array.from({ length: 6 }, (_, i) => pair(i, 0.4, 0.5, 0, 100));
  const v = gateCandidateLive(input(zeroBase));
  const cost = v.checks.find((c) => c.id === "3-cost");
  assert.equal(cost?.ran, false, "an undecidable ratio did not run");
  assert.equal(cost?.pass, false, "and it is never reported as passed");
  assert.match(cost.detail, /DID NOT RUN/);

  // It must not, by itself, refuse a promotion the rest of the gate approves — the decision is
  // taken over the checks that RAN, exactly as it is for `8-determinism`.
  const priced = Array.from({ length: 6 }, (_, i) => pair(i, 0.4, 0.5, 0.01, 0.01));
  assert.equal(gateCandidateLive(input(priced)).promote, true, "control: a decidable ratio still promotes");
});
