/**
 * THE ARITHMETIC OF THE LIVE PROMOTION GATE, held down away from any store.
 *
 * `evolution/live.ts` is the half of `loom promote --against-cohort` that decides. The CLI half
 * — where the inputs come from, what gets run, what is journaled — is driven end to end in
 * `test/cli/promote-live.test.ts`; this file pins the numbers, because a decision rule nobody
 * can recompute is not one anybody can argue with.
 *
 * FIVE PROPERTIES, and each is a way the mode could quietly stop being a gate:
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
 * 5. COST IS GATED ON THE MEDIAN PAIR, which is the statistic D10.d names and the replayed gate
 *    cannot express. Two fixtures show the two are genuinely different rules — one where the
 *    totals pass and the median refuses, one the other way round — and the $0 baseline that
 *    once made this "reported, not gated" is now a stated rule rather than a hole.
 * 6. THE IMPROVEMENT BOUND DOES NOT REST ON THE SHAPE OF SIX NUMBERS. `L1` requires the t bound
 *    AND a Wilcoxon signed-rank bound, whose critical value is derived here rather than
 *    tabulated — so the derivation is checked against the published table at seventeen sample
 *    sizes, and the eighteenth disagreement is shown to be the table being loose. Two fixtures
 *    show each bound binding where the other does not, which is what makes the conjunction a
 *    rule rather than a decoration.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_PAIRED_RUNS,
  gateCandidateLive,
  pairedCostRatio,
  wilcoxonLowerBound,
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

test("THE MEDIAN PAIR GATES COST, AND A $0 BASELINE IS UNBOUNDED RATHER THAN UNDEFINED", () => {
  // D10.d asks for a ratio of MEDIANS. The replayed gate divides suite totals because
  // `EvalReport` has no median to divide; pairing makes the median expressible, and this mode
  // computed it, journaled it and gated on the totals anyway. The one argument for that was the
  // $0 baseline: "a check that sometimes has no answer is worse than one clear rule". The answer
  // is to make the rule total, not to decline to take it — see `pairedCostRatio`.
  //
  // THE REVIEWER'S OWN FIXTURE, which is where this started: six pairs at a $0 baseline and a
  // $100 candidate. The first version answered `baseCost === 0 ? 1 : …` and promoted them at
  // "cost ratio 1.00×"; the second reported `ran: false`, which does not refuse. Every one of
  // those pairs turned a free input into a $100 one, so the median pair's ratio is unbounded and
  // no ceiling contains it. It FAILS now, and that is the whole difference.
  const zeroBase = Array.from({ length: 6 }, (_, i) => pair(i, 0.4, 0.5, 0, 100));
  const zc = gateCandidateLive(input(zeroBase)).checks.find((c) => c.id === "3-cost");
  assert.equal(zc?.ran, true, "there were six pairs, so the check has evidence and runs");
  assert.equal(zc?.pass, false, "…and it refuses, where before it merely declined to answer");
  assert.match(zc.detail, /unbounded/);
  assert.equal(gateCandidateLive(input(zeroBase)).promote, false, "a candidate that made six free inputs cost $100 does not promote");

  // A $0 BASELINE WITH A $0 CANDIDATE IS 1, NOT UNBOUNDED, and the difference is the candidate.
  // Neither side spent, so cost did not increase; refusing here would refuse every unpriced
  // provider rather than every cost regression.
  const freeBoth = Array.from({ length: 6 }, (_, i) => pair(i, 0.4, 0.5, 0, 0));
  const fc = gateCandidateLive(input(freeBoth)).checks.find((c) => c.id === "3-cost");
  assert.equal(fc?.pass, true, `nothing was spent on either side; detail ${String(fc?.detail)}`);

  // THE MEDIAN IS NOT THE TOTAL, and this is the pair of fixtures that shows it. Five cheap
  // inputs and one expensive one, arranged so the two statistics disagree in each direction.
  //
  // (a) the candidate is dearer on five of six and the sixth carries the totals back under 1.1×.
  //     The total ratio is 1.05×, a pass; the median pair is 2.00×, a refusal.
  const hiddenRegression = [
    ...Array.from({ length: 5 }, (_, i) => pair(i, 0.4, 0.5, 0.01, 0.02)),
    pair(5, 0.4, 0.5, 10, 10.4),
  ];
  const hr = pairedCostRatio(hiddenRegression);
  assert.equal(hr.medianRatio, 2, "the typical input doubled in price");
  assert.ok(
    hr.candidateTotalUsd / hr.baselineTotalUsd <= 1.1,
    `and the totals hide it: ${hr.candidateTotalUsd} / ${hr.baselineTotalUsd}`,
  );
  assert.equal(gateCandidateLive(input(hiddenRegression)).checks.find((c) => c.id === "3-cost")?.pass, false);

  // (b) the mirror: the candidate is cheaper on five of six and one input got dearer by enough
  //     to carry the totals over the ceiling. The total ratio refuses; the median passes.
  const oneDearInput = [
    ...Array.from({ length: 5 }, (_, i) => pair(i, 0.4, 0.5, 0.02, 0.01)),
    pair(5, 0.4, 0.5, 1, 2),
  ];
  const od = pairedCostRatio(oneDearInput);
  assert.equal(od.medianRatio, 0.5, "the typical input halved in price");
  assert.ok(
    od.candidateTotalUsd / od.baselineTotalUsd > 1.1,
    `and the totals refuse it: ${od.candidateTotalUsd} / ${od.baselineTotalUsd}`,
  );
  assert.equal(gateCandidateLive(input(oneDearInput)).checks.find((c) => c.id === "3-cost")?.pass, true);

  // CONTROL — an ordinary priced cohort still promotes.
  const priced = Array.from({ length: 6 }, (_, i) => pair(i, 0.4, 0.5, 0.01, 0.01));
  assert.equal(gateCandidateLive(input(priced)).promote, true, "control: a decidable ratio still promotes");
});

// ── 6 · the bound does not rest on the shape of six numbers ──────────────────

test("THE SIGNED-RANK CRITICAL VALUE IS DERIVED, AND IT AGREES WITH THE PUBLISHED TABLE", () => {
  // `wilcoxonLowerBound` computes its own null distribution — a subset-sum count over the ranks
  // 1…n — rather than carrying a table, because a table is a page of numbers nobody can check
  // and this is a convolution anybody can. So the check is that the derivation reproduces the
  // published one.
  //
  // A signed-rank table is printed as "reject when T ≤ t"; the same region is `W⁺ ≥ M − t` with
  // `M = n(n+1)/2`. The bound is the `(M − c + 1)`-th smallest Walsh average, so recovering `c`
  // from the bound is a matter of finding which order statistic came back — which needs the
  // Walsh averages to be DISTINCT, or the index is ambiguous. Differences 1…n are not enough:
  // `(1+4)/2` and `(2+3)/2` are both 2.5, and reading the first index back gives the wrong `c`.
  // Powers of two are, because `2ⁱ + 2ʲ` for `i ≤ j` is distinct by its binary representation.
  const criticalOf = (n: number): number => {
    const diffs = Array.from({ length: n }, (_, i) => 2 ** i);
    const walsh: number[] = [];
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) walsh.push((diffs[i]! + diffs[j]!) / 2);
    walsh.sort((a, b) => a - b);
    const bound = wilcoxonLowerBound(diffs);
    const M = (n * (n + 1)) / 2;
    return M - walsh.indexOf(bound);
  };

  // One-sided α = 0.05, as "reject when T ≤ t".
  const published: Readonly<Record<number, number>> = {
    5: 0, 6: 2, 7: 3, 8: 5, 9: 8, 10: 10, 11: 13, 12: 17, 13: 21,
    14: 25, 15: 30, 16: 35, 17: 41, 18: 47, 19: 53, 20: 60, 25: 100,
  };
  for (const [key, t] of Object.entries(published)) {
    const n = Number(key);
    const M = (n * (n + 1)) / 2;
    assert.equal(criticalOf(n), M - t, `n = ${key}: derived critical W⁺ disagrees with the table`);
  }

  // THE ONE ROW LEFT OUT, and it is left out because the DERIVATION is right and the table is
  // loose. Tables commonly print t = 152 at n = 30; the exact tail is P(T ≤ 152) = 0.050199,
  // which is over α, while P(T ≤ 151) = 0.048051 is under it. The derivation returns the strict
  // value, and strictness is the only direction a promotion gate may round.
  assert.equal(criticalOf(30), 465 - 151);

  // AT n = 4 NO BOUND EXISTS AT ALL — the exact null tops out at 1/16 = 0.0625, the same wall
  // `MIN_PAIRED_RUNS` is argued from — and 0 is returned, which cannot pass `> 0`.
  assert.equal(wilcoxonLowerBound([0.1, 0.2, 0.3, 0.4]), 0, "four pairs cannot reach α");
  assert.ok(wilcoxonLowerBound([0.1, 0.2, 0.3, 0.4, 0.5]) > 0, "five can, on a clean sweep");
});

test("BOTH BOUNDS HAVE TO CLEAR 0, AND EACH BINDS WHERE THE OTHER DOES NOT", () => {
  // A.26's complaint: at n = 6 the t bound assumes roughly normal differences and six
  // observations cannot check that. The answer is to require the evidence to survive without the
  // assumption, not to argue the assumption is harmless — so these two fixtures are the point.
  // If either bound were dropped, one of them would promote.

  // ONE INPUT CARRIED IT. Six wins, but five of them by 0.01 and one by 0.9. The t bound is
  // wrecked by the variance and refuses; the distribution-free bound, which uses order rather
  // than magnitude of the deviation, says the pseudomedian is above 0.01.
  const carried = pairedDifference([0.01, 0.01, 0.01, 0.01, 0.01, 0.9]);
  assert.ok(carried.lower95 < 0, `t bound refuses: ${carried.lower95}`);
  assert.ok(carried.wilcoxonLower95 > 0, `Wilcoxon passes: ${carried.wilcoxonLower95}`);
  assert.equal(
    gateCandidateLive(input([0.01, 0.01, 0.01, 0.01, 0.01, 0.9].map((d, i) => pair(i, 0.4, 0.4 + d)))).promote,
    false,
    "the conjunction refuses it",
  );

  // AND THE MIRROR, which is the one that makes the Wilcoxon conjunct load-bearing rather than
  // decorative: two inputs barely improved, one got WORSE by more than either gained, three
  // improved a lot. The mean says yes and its bound clears 0 by 0.0016; the distribution-free
  // bound says the typical input's evidence is not there.
  const thin = pairedDifference([0.01, 0.02, 0.2, 0.2, 0.2, -0.05]);
  assert.ok(thin.lower95 > 0, `t bound passes: ${thin.lower95}`);
  assert.ok(thin.wilcoxonLower95 < 0, `Wilcoxon refuses: ${thin.wilcoxonLower95}`);
  assert.equal(
    gateCandidateLive(input([0.01, 0.02, 0.2, 0.2, 0.2, -0.05].map((d, i) => pair(i, 0.4, 0.4 + d)))).promote,
    false,
    "…and the conjunction refuses this one too, which the t bound alone would have promoted",
  );

  // CONTROL — a candidate that wins tightly on every input clears both, so the conjunction is a
  // bar and not a wall.
  const tight = [0.05, 0.06, 0.05, 0.07, 0.05, 0.06];
  const t = pairedDifference(tight);
  assert.ok(t.lower95 > 0 && t.wilcoxonLower95 > 0, JSON.stringify(t));
  assert.equal(gateCandidateLive(input(tight.map((d, i) => pair(i, 0.4, 0.4 + d)))).promote, true);
});
