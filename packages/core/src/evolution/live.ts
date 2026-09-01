/**
 * Judging a candidate by RUNNING it, against a cohort the journal already holds.
 *
 * WHY THIS FILE EXISTS. `gate.ts` judges a candidate by REPLAY, and replay serves every model
 * turn from the recording under `effectKey(taskId, "model", turn)` — a key built from
 * `nodeId@branchPath#iteration` and a turn number, carrying no prompt, no request and no graph
 * hash. So a candidate that changes a FUNCTION BODY is measurable there (functions re-execute
 * under replay) and a candidate that changes a PROMPT is not: it replays byte-identically.
 * Measured on the walking skeleton before `unexercised` existed — baseline `passRate 1`,
 * prompt-re-pointed candidate `passRate 1`, `PROMOTE=true`, live model calls made by either
 * evaluation: 0. D6 defines self-improvement as text-space optimisation, so the only promotion
 * gate the product had was blind to exactly the thing it is aimed at.
 *
 * `gate.ts`'s `unexercised` closed the half that could be closed offline: a candidate whose
 * `model.called.requestDigest` differs from the recording's is REFUSED rather than certified.
 * Refusing is not judging, and its own refusal text names the missing verb — "re-record the
 * corpus, or judge this candidate live". This is that verb.
 *
 * ── What makes it a gate rather than a demonstration ────────────────────────────
 *
 * **The inputs are drawn from runs that already happened.** The caller names a cohort, not a
 * set of inputs; every input is read out of some baseline run's `run.submitted.inputs`. That is
 * D6's freeze property carried into a live mode: `suiteFrozenAt` exists so an exam cannot be
 * written for a known student, and an operator who could type the inputs at promotion time
 * would be doing precisely that. The CLI makes it impossible rather than merely unwise — there
 * is no flag that supplies an input.
 *
 * **The comparison is PAIRED.** Every difference below is one input's candidate score minus the
 * SAME input's baseline score. Input variance dominates here — the live corpus's six diffs
 * differ wildly in difficulty — so two independent samples of ~30 runs would be mostly noise
 * about which inputs landed on which side. Pairing removes the input from the comparison and
 * leaves the graph.
 *
 * **Both sides are scored with ONE ruler.** `scoreTrajectory` normalises cost and latency
 * against a `CohortStats`, so a baseline score journaled last month and a candidate score
 * computed today are numbers from two different rulers. The caller measures the cohort once,
 * from the baseline population alone, and scores both sides against it. That ruler is a pure
 * function of runs the candidate did not produce: `cohortKeyOf` keys on `graphHash`, so the
 * candidate's own runs fall in a different cohort and cannot move the bar they are judged by.
 *
 * ── What this mode CANNOT check, and why it says so instead of passing ──────────
 *
 * `8-determinism` asks whether two runs of the candidate produced identical state. Two live
 * runs of a model do not, and demanding it would make live judging impossible. "A guard that
 * cannot decide fails closed" — so the check does not quietly report `pass: true`. It is
 * reported with `ran: false` AND `pass: false`, which is the encoding that fails closed in both
 * directions: a careful reader sees a check that did not run, and a naive consumer folding
 * `checks.every(c => c.pass)` sees a verdict that did not fully pass, which is the truth. The
 * promotion decision is taken over the checks that RAN, and `notRun` names the rest so a reader
 * cannot mistake this certificate for the replayed one.
 */

import type { RunId } from "../ids.ts";

/**
 * One input, measured on both graphs.
 *
 * `baselineRunId` is where the INPUT came from — the recording — and is the pair's identity.
 * A pair exists only when both sides produced a score.
 */
export interface LivePair {
  readonly baselineRunId: RunId;
  readonly candidateRunId: RunId;
  readonly baselineScore: number;
  readonly candidateScore: number;
  readonly baselineCostUsd: number;
  readonly candidateCostUsd: number;
}

/** An input that was selected and did NOT yield a measurement. Never silently dropped. */
export interface Unmeasured {
  readonly baselineRunId: RunId;
  readonly candidateRunId: RunId;
  /** The candidate run's non-terminal status, folded from its own journal. */
  readonly status: string;
  /**
   * The gates still waiting on a person, when that is why the run stopped.
   *
   * PRESENT MEANS A DIFFERENT KIND OF FAILURE, and the distinction is the whole reason the field
   * exists: a run parked here is not a measurement that went missing, it is a run doing exactly
   * what its graph told it to do. Absent means the run stalled for some other reason, which is
   * the case `L2` was originally written for.
   */
  readonly openGates?: readonly string[];
}

/**
 * The paired statistic, and every number a reader needs to argue with it.
 *
 * `lower95` IS THE DECISION and the rest is dispersion a reader can check it against. A mean
 * difference with no dispersion is not a decision rule: at n = 6 one lucky input moves a mean
 * by a third of its range, and `2-non-inferior` in the replayed gate is exactly that bare point
 * estimate — its own docstring calls it "weaker than D10.d says".
 *
 * WHY A ONE-SIDED t BOUND AND NOT THE SIGN TEST, given both are reported. The t bound uses the
 * MAGNITUDES of the differences, which is the entire reason for pairing; the sign test discards
 * them and at n = 6 can only distinguish a clean 6–0 sweep (p = 0.0156) from a 5–1 (p = 0.109),
 * so it would refuse a candidate that won five inputs by a mile and lost one by a hair. It is
 * reported alongside because it is distribution-free and it is what tells a reader whether a
 * positive mean was carried by one outlier.
 *
 * WHAT THE t BOUND ASSUMES, said out loud because it is the weakest link at this sample size:
 * that the differences are roughly symmetric. Scores are bounded on [0, 1] so differences are
 * bounded on [-1, 1], and a candidate that is much better on hard inputs and level on easy ones
 * produces a skewed set. At n = 6 there is no way to check that from the data. The honest
 * summary is that this rule is a real bar — far stronger than a point estimate — and not a
 * substitute for a corpus large enough to run McNemar's.
 */
export interface PairedDifference {
  readonly n: number;
  readonly mean: number;
  /** Sample standard deviation, n−1 in the denominator. 0 when n < 2. */
  readonly sd: number;
  /**
   * A ONE-SIDED 95 % LOWER CONFIDENCE BOUND on the mean difference, Student's t with n−1 df.
   *
   * Reported as 0 when n < 2, where no dispersion is estimable: the bound is undefined and 0
   * cannot pass `> 0`, so the undecidable case fails closed rather than promoting on one run.
   */
  readonly lower95: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** Exact one-sided binomial P(X ≥ wins | wins + losses, ½). Ties excluded, as the test says. */
  readonly signTestP: number;
}

/**
 * One-sided 95 % quantiles of Student's t, by degrees of freedom.
 *
 * A table rather than a computed quantile because `packages/core` takes no runtime
 * dependencies and an inverse incomplete beta is a page of numerics to get subtly wrong. Above
 * df 30 the table thins, and `tCritical` reads the largest tabulated df AT OR BELOW the real
 * one — t decreases in df, so that always returns a value at least as large as the true one,
 * which makes the bound narrower and the check STRICTER. Rounding toward strictness is the only
 * direction a promotion gate may round.
 */
const T95: Readonly<Record<number, number>> = {
  1: 6.314, 2: 2.92, 3: 2.353, 4: 2.132, 5: 2.015, 6: 1.943, 7: 1.895, 8: 1.86, 9: 1.833,
  10: 1.812, 11: 1.796, 12: 1.782, 13: 1.771, 14: 1.761, 15: 1.753, 16: 1.746, 17: 1.74,
  18: 1.734, 19: 1.729, 20: 1.725, 21: 1.721, 22: 1.717, 23: 1.714, 24: 1.711, 25: 1.708,
  26: 1.706, 27: 1.703, 28: 1.701, 29: 1.699, 30: 1.697, 40: 1.684, 60: 1.671, 120: 1.658,
};

/** The largest tabulated df at or below `df`. See `T95` for why that direction. */
function tCritical(df: number): number {
  let best = 1.6449; // df → ∞, the normal quantile: the floor of the table.
  let bestDf = 0;
  for (const key of Object.keys(T95)) {
    const d = Number(key);
    if (d <= df && d > bestDf) {
      bestDf = d;
      best = T95[d]!;
    }
  }
  return best;
}

/** Six decimals, the form every durable write in this tree uses. `canonicalize` refuses NaN. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * P(X ≥ wins) for X ~ Binomial(wins + losses, ½), exactly.
 *
 * Summed downward from the tail so no binomial coefficient is ever formed: the i = n term is
 * `0.5 ** n` and each step multiplies by `i / (n − i + 1)`. A factorial would overflow at
 * n = 171 and this does not, which matters because a cohort may hold 500 runs.
 */
function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  let term = Math.pow(0.5, n);
  let sum = term;
  for (let i = n; i > wins; i--) {
    term = (term * i) / (n - i + 1);
    sum += term;
  }
  return round6(Math.min(1, sum));
}

export function pairedDifference(diffs: readonly number[]): PairedDifference {
  const n = diffs.length;
  const wins = diffs.filter((d) => d > 0).length;
  const losses = diffs.filter((d) => d < 0).length;
  const ties = n - wins - losses;
  if (n === 0) return { n: 0, mean: 0, sd: 0, lower95: 0, wins: 0, losses: 0, ties: 0, signTestP: 1 };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) {
    return { n, mean: round6(mean), sd: 0, lower95: 0, wins, losses, ties, signTestP: signTestP(wins, losses) };
  }
  const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1));
  // sd === 0 is not a hole: it means every paired difference was identical, and with n ≥ 2 the
  // bound is then the mean itself. `L3-paired-count` is what stops that being decided on two
  // runs; see `MIN_PAIRED_RUNS`.
  const lower95 = mean - tCritical(n - 1) * (sd / Math.sqrt(n));
  return {
    n,
    mean: round6(mean),
    sd: round6(sd),
    lower95: round6(lower95),
    wins,
    losses,
    ties,
    signTestP: signTestP(wins, losses),
  };
}

/**
 * The smallest number of pairs this mode will decide on.
 *
 * Six, and the number is argued rather than picked. It is the smallest n at which the exact
 * one-sided sign test can reach p < 0.05 at all (n = 5 gives 1/32 = 0.031 only on a clean
 * sweep; n = 4 gives 1/16 = 0.0625, which no result can beat), and it is the df at which the t
 * quantile stops moving in steps of a tenth. It is also, not by accident, the size of the live
 * corpus this mode was built for: `review-bench` has six diffs.
 *
 * It is a floor on the DECISION, not a recommendation. Six pairs is a weak experiment and the
 * verdict says so by carrying `n` and `signTestP` into the journal.
 */
export const MIN_PAIRED_RUNS = 6;

/**
 * The per-pair cost comparison, and the answer to "does the median gate?" — it does.
 *
 * D10.d asks for a ratio of MEDIANS. The replayed gate divides TOTALS and its own docstring says
 * so, for a reason that is about expressibility rather than preference: `EvalReport` carries no
 * median, so the stricter reading is not merely unimplemented there, it cannot be written down.
 * **Pairing removes that reason.** Every input is measured on both graphs, so the per-pair ratio
 * exists, and with it the statistic D10.d actually named. This mode computed it, journaled it,
 * and gated on the totals anyway — reported, not gated — and the argument for that was one
 * sentence: a pair whose baseline cost $0 makes the ratio undefined, and "a check that sometimes
 * has no answer is worse than one clear rule".
 *
 * That objection is answered by making the rule TOTAL rather than by declining to take it:
 *
 * | pair | ratio | why |
 * |---|---|---|
 * | `baseline > 0` | `candidate / baseline` | the ordinary case |
 * | `baseline == 0`, `candidate == 0` | 1 | neither side spent; cost did not increase |
 * | `baseline == 0`, `candidate > 0` | UNBOUNDED | a free input became a paid one, and no finite ceiling contains that |
 *
 * The third row is the one that used to be "undefined", and calling it unbounded is not a
 * convention — it is the limit of `candidate / baseline` as the baseline goes to zero with the
 * candidate held positive. Making it a value rather than a hole is what lets the check always
 * have an answer, and it is the FAIL-CLOSED direction: the previous code answered that case `1`,
 * the passing value, until this lane's reviewer drove six pairs at `$0` baseline and `$100`
 * candidate through it and watched them promote at "cost ratio 1.00×".
 *
 * A median never has to do arithmetic on an unbounded value — it is an order statistic, so an
 * unbounded pair sorts last and participates by position. The check fails only when the median
 * ITSELF is unbounded, which takes half the pairs having gone from free to paid.
 *
 * WHY THE MEDIAN IS THE BETTER GATE, and not merely the one the roadmap named. A ratio of totals
 * is dominated by the most expensive input on either side, so it fails in both directions: one
 * expensive pair hides behind a cheap one, and one expensive pair sinks a candidate that is
 * cheaper on five of six inputs. The median asks "did the typical input get dearer", which is the
 * question a cost ceiling is for. The total is still REPORTED in the check's detail — the two
 * numbers disagreeing is a fact a reader should see — so this reverses which one is the gate and
 * loses nothing off the page.
 *
 * `medianRatio` is `null` when the median is unbounded and when there are no pairs at all. Those
 * are different facts and `n`/`unbounded` separate them; `null` rather than `Infinity` because a
 * verdict is journaled and canonical form has no infinity to write.
 */
export interface PairedCost {
  readonly n: number;
  /** Pairs whose baseline spent nothing while the candidate spent something. */
  readonly unbounded: number;
  /** The median per-pair ratio; `null` when that median is unbounded, or when `n` is 0. */
  readonly medianRatio: number | null;
  readonly baselineTotalUsd: number;
  readonly candidateTotalUsd: number;
}

export function pairedCostRatio(pairs: readonly LivePair[]): PairedCost {
  const baselineTotalUsd = pairs.reduce((a, p) => a + p.baselineCostUsd, 0);
  const candidateTotalUsd = pairs.reduce((a, p) => a + p.candidateCostUsd, 0);
  // `Number.POSITIVE_INFINITY` sorts last under `a - b`, which is the whole use of it here: the
  // value is picked by POSITION and never added, divided or rounded, so it never reaches a
  // journal or a `toFixed`.
  const ratios = pairs
    .map((p) => (p.baselineCostUsd > 0 ? p.candidateCostUsd / p.baselineCostUsd : p.candidateCostUsd > 0 ? Number.POSITIVE_INFINITY : 1))
    .sort((a, b) => a - b);
  const median = ratios.length === 0 ? undefined : ratios[Math.floor((ratios.length - 1) / 2)]!;
  return {
    n: pairs.length,
    unbounded: pairs.filter((p) => p.baselineCostUsd <= 0 && p.candidateCostUsd > 0).length,
    medianRatio: median === undefined || !Number.isFinite(median) ? null : round6(median),
    baselineTotalUsd: round6(baselineTotalUsd),
    candidateTotalUsd: round6(candidateTotalUsd),
  };
}

/**
 * One promotion criterion. `ran` is the field the replayed gate's `PromotionVerdict` does not
 * have, and it is what makes a live verdict unable to impersonate a replayed one.
 *
 * A check that did not run is reported `ran: false, pass: false`. `pass: false` is not a claim
 * that the candidate failed it — `detail` says what happened — it is the fail-closed encoding
 * for a consumer that folds `pass` alone.
 */
export interface LiveCheck {
  readonly id: string;
  readonly ran: boolean;
  readonly pass: boolean;
  readonly detail: string;
}

export interface LivePromotionVerdict {
  readonly promote: boolean;
  readonly checks: readonly LiveCheck[];
  /** The ids of every check with `ran: false`, so the decision row names its own blind spots. */
  readonly notRun: readonly string[];
  readonly paired: PairedDifference;
}

export interface LiveCriteria {
  /**
   * The MEDIAN pair's cost ratio must be ≤ this. Default 1.1, the same number `3-cost` uses —
   * but a different statistic from the replayed gate's, which divides totals because
   * `EvalReport` has no median to divide. See `pairedCostRatio`.
   */
  readonly maxCostRatio?: number;
  /** Prompt byte growth ceiling, unless the paired mean gains `bloatOffset`. Default 0.15. */
  readonly maxPromptGrowth?: number;
  readonly bloatOffset?: number;
  readonly minPairs?: number;
}

export interface LivePromotionInput {
  /** Every input that produced a score on BOTH graphs. */
  readonly pairs: readonly LivePair[];
  /** Every selected input whose candidate run did not reach a terminal state. */
  readonly unmeasured: readonly Unmeasured[];
  /** Non-negative at every node, from the compiler's GRAPH014 diff. Measured, never asserted. */
  readonly postureDiffNonNegative: boolean;
  /** Fractional prompt-byte change over the two compiled artifacts' agent nodes. */
  readonly promptGrowth: number;
  /**
   * Places the candidate's runs held LESS oversight than the baseline's did on the same input —
   * a gate left undecided, or a node the recording gated and the candidate did not.
   */
  readonly gatingRegressions: readonly string[];
  readonly criteria?: LiveCriteria;
}

/**
 * Nine criteria. Eight run; one cannot, and says so.
 *
 * The ids are chosen so a reader can tell at a glance which rules are shared with the replayed
 * gate and which are new. `5-prompt-size` and `6-oversight-diff` keep their numbers because they
 * are the SAME RULE evaluated on live evidence — `6-oversight-diff` is literally the same
 * `compile` call with the same `baselinePostures`.
 *
 * `3-cost` KEEPS ITS NUMBER AND IS NOT THE SAME RULE, which is the one place that mapping is
 * loose and is said here rather than left for a reader to trip on. It is D10.d's cost criterion
 * in both modes, at the same default ceiling — but the replayed gate divides suite TOTALS
 * because `EvalReport` has no median to divide, and pairing makes the median expressible, so
 * here the MEDIAN PAIR gates and the total is reported beside it. Two certificates carrying
 * `3-cost` are answering the same question with different arithmetic; `mode` on the journaled
 * row is what tells them apart. See `pairedCostRatio`.
 *
 * Everything an `L` prefixes is new
 * or measured differently, and `8-determinism` keeps its number precisely so that its
 * `ran: false` is legible next to the mode that can run it.
 *
 * Pure: no store, no clock, no network. A live promotion is argued about after the fact from
 * the numbers in its journal row, which is the only way anybody can check it.
 */
export function gateCandidateLive(input: LivePromotionInput): LivePromotionVerdict {
  const c = input.criteria ?? {};
  const maxCost = c.maxCostRatio ?? 1.1;
  const maxGrowth = c.maxPromptGrowth ?? 0.15;
  const bloatOffset = c.bloatOffset ?? 0.05;
  const minPairs = c.minPairs ?? MIN_PAIRED_RUNS;

  const paired = pairedDifference(input.pairs.map((p) => p.candidateScore - p.baselineScore));
  const checks: LiveCheck[] = [];

  // THE ONE THE MODE EXISTS FOR. Not non-inferiority: the roadmap clause is "a candidate
  // promoted over them because it MEASURABLY BEAT the baseline", and a bound that merely clears
  // −margin certifies that nothing got worse. A strictly positive lower bound is the difference
  // between "we could not detect harm" and "we detected an improvement".
  checks.push({
    id: "L1-paired-improvement",
    ran: paired.n >= 2,
    pass: paired.n >= 2 && paired.lower95 > 0,
    detail:
      paired.n < 2
        ? `only ${String(paired.n)} pair(s) — no dispersion is estimable, so no bound exists to clear`
        : `paired mean Δscore ${paired.mean.toFixed(4)} (sd ${paired.sd.toFixed(4)}, n ${String(paired.n)}), ` +
          `one-sided 95% lower bound ${paired.lower95.toFixed(4)} — needs > 0. ` +
          `Sign test ${String(paired.wins)}W/${String(paired.losses)}L/${String(paired.ties)}T, p ${paired.signTestP.toFixed(4)}`,
  });

  // A CANDIDATE RUN THAT NEVER FINISHED IS A MISSING MEASUREMENT, NOT A ZERO — and neither
  // silently scoring it 0 nor silently dropping it is free. Scoring 0 punishes the candidate for
  // a provider outage; dropping lets a candidate that hangs on half its inputs look good on the
  // other half. So it is dropped from the ARITHMETIC (the pairs are comparable measurements or
  // they are nothing) and refused HERE, by count, where it cannot be absorbed.
  //
  // A candidate run that FAILED or was CANCELLED is a different thing and IS paired: it reaches
  // a terminal state, `scoreTrajectory`'s floor scores it 0, and that 0 is the reviewed rule
  // this tree already applies to every other run — "failure is not weak evidence; it is the
  // absence of the thing being measured". A candidate that crashes on half its inputs therefore
  // loses those pairs outright rather than escaping them.
  //
  // The cost of this direction, stated: one flaky provider call refuses the whole promotion.
  // That is the fail-closed direction and it is cheap to retry.
  //
  // ── A RUN WAITING ON A PERSON IS NOT A MISSING MEASUREMENT ────────────────────
  //
  // The refusal was right and its REASON was wrong, which is its own defect: every candidate run
  // of a graph containing a `human_gate` parks, is non-terminal, and was reported here as "a
  // missing measurement" — telling an operator to look for a provider outage that never happened
  // and hiding the fact that a whole class of graph is unpromotable by this mode. Driven on a
  // gated fixture in `test/cli/promote-live-gates.test.ts`; before this branch existed the six
  // entries all read `→incomplete`, a word no run's status ever holds.
  //
  // WHAT THIS DOES NOT DO, and the alternative is recorded because it is the tempting one:
  // auto-resolve the gates the baseline also raised and decided the same way. That is the live
  // door answering a gate on a human's behalf, and "a human may lower a posture; no automated
  // path may" is the rule it would break — the candidate's own oversight decision would be made
  // by the thing being judged. So the message names the gate instead, and it does NOT tell the
  // operator to go and answer these ones: the runs are this command's own, and the next
  // invocation starts fresh runs that park in the same place. Saying "approve them and retry"
  // would be a path that does not walk.
  const parked = input.unmeasured.filter((u) => (u.openGates?.length ?? 0) > 0);
  const stalled = input.unmeasured.filter((u) => (u.openGates?.length ?? 0) === 0);
  const listOf = (us: readonly Unmeasured[]): string => us.map((u) => `${u.baselineRunId}→${u.status}`).join(", ");
  checks.push({
    id: "L2-every-input-measured",
    ran: true,
    pass: input.unmeasured.length === 0,
    detail:
      input.unmeasured.length === 0
        ? "every selected input produced a terminal candidate run"
        : `${String(input.unmeasured.length)} of ${String(input.pairs.length + input.unmeasured.length)} selected input(s) ` +
          `left the candidate non-terminal. ` +
          (parked.length === 0
            ? ""
            : `${String(parked.length)} of those are WAITING ON A PERSON, not missing: ` +
              `${parked.map((u) => `${u.baselineRunId}→${u.candidateRunId} ${u.status} (${(u.openGates ?? []).join("; ")})`).join(", ")}. ` +
              `This mode cannot judge a graph that stops for a human — it starts its own runs and may not answer ` +
              `their gates, and answering these would not help, because the next promotion starts fresh runs that ` +
              `park in the same place. ` +
              (stalled.length === 0 ? "" : "The rest stalled for another reason: ")) +
          (stalled.length === 0
            ? ""
            : `${parked.length === 0 ? `(${listOf(stalled)}) — ` : `${listOf(stalled)} — `}` +
              `a missing measurement, which is neither a zero nor an absence`),
  });

  checks.push({
    id: "L3-paired-count",
    ran: true,
    pass: paired.n >= minPairs,
    detail: `${String(paired.n)} paired measurement(s) (need ≥ ${String(minPairs)})`,
  });

  // THE LIVE READING OF `7-safety`, and it is STRICTER than the replayed one rather than a
  // substitute for it. `7-safety` filters case reasons for the substring `irreversible`, which
  // only ever appears when a case opted in with `expect.noIrreversibleWithoutGate`. Here both
  // journals are real, so the two questions `ungatedActions` asks are asked of every pair with
  // nothing to opt into: did the candidate leave a gate undecided, and did the baseline gate a
  // node the candidate did not. The second is the one that matters — "oversight only tightens",
  // and a candidate that reaches the same work along a path with fewer gates has loosened it.
  checks.push({
    id: "L4-gated-at-least-as-much",
    ran: input.pairs.length > 0,
    pass: input.pairs.length > 0 && input.gatingRegressions.length === 0,
    detail:
      input.pairs.length === 0
        ? "no pair was measured, so no run's gates could be compared"
        : input.gatingRegressions.length === 0
          ? "no gate was left undecided, and the candidate gated everywhere the baseline did"
          : `${String(input.gatingRegressions.length)} oversight regression(s): ${input.gatingRegressions.slice(0, 5).join("; ")}`,
  });

  // The absolute floor `2a-candidate-earned-it` puts on the replayed gate, in this mode's terms.
  // Implied by `L1` today — a positive bound over non-negative baseline scores needs a positive
  // candidate score somewhere — and stated anyway, because the replayed gate learned that lesson
  // by promoting two reports both at `passRate 0` with all eleven checks green.
  const earned = input.pairs.filter((p) => p.candidateScore > 0).length;
  checks.push({
    id: "L5-candidate-earned-it",
    ran: input.pairs.length > 0,
    pass: earned > 0,
    detail:
      earned > 0
        ? `the candidate scored above 0 on ${String(earned)} of ${String(input.pairs.length)} input(s)`
        : "the candidate scored 0 on every input — a promotion certifies that something WORKS, and nothing here did",
  });

  // REAL MONEY, ON BOTH SIDES. The baseline half is what those recordings actually cost when
  // they ran; the candidate half is what this command just spent.
  //
  // THE MEDIAN GATES HERE, WHICH IS THE ONE THING THE REPLAYED `3-cost` CANNOT DO. See
  // `pairedCostRatio` for the rule and for why every pair now has an answer, the $0-baseline
  // one included. The total is reported beside it because the two disagreeing is a fact worth
  // seeing, and because the replayed gate's number is the total — a reader comparing two
  // certificates should be able to find both.
  const cost = pairedCostRatio(input.pairs);
  const totals = `totals ${cost.candidateTotalUsd.toFixed(6)} vs ${cost.baselineTotalUsd.toFixed(6)}`;
  const unboundedNote =
    cost.unbounded === 0
      ? ""
      : ` ${String(cost.unbounded)} of ${String(cost.n)} pair(s) had a $0 baseline and a paying candidate, which is ` +
        `an unbounded increase and sorts above every ceiling`;
  checks.push({
    id: "3-cost",
    // `ran` is now decided by whether there is a pair, not by whether the arithmetic worked. A
    // check that sometimes has no answer is worse than one clear rule — the rule is in
    // `pairedCostRatio`, and it is total.
    ran: cost.n > 0,
    pass: cost.n > 0 && cost.medianRatio !== null && cost.medianRatio <= maxCost,
    detail:
      cost.n === 0
        ? "no pair was measured, so nothing was spent to compare"
        : cost.medianRatio === null
          ? `the MEDIAN pair went from a $0 baseline to a paying candidate, so the typical input's cost ratio is ` +
            `unbounded and no ceiling contains it (max ${String(maxCost)}×).${unboundedNote}. ${totals}. A live ` +
            `cohort whose baselines spent nothing is a cohort that called no priced provider; check the models ` +
            `file rather than reading this as a candidate that got dear`
          : `median pair cost ratio ${cost.medianRatio.toFixed(2)}× over ${String(cost.n)} pair(s) ` +
            `(max ${String(maxCost)}×) — ${totals}.${unboundedNote}`,
  });

  // The paired MEAN is what buys prompt growth here, where the replayed gate uses its pass-rate
  // delta. Same shape of bargain: a bigger prompt has to earn its keep.
  const bloatOk = input.promptGrowth <= maxGrowth || paired.mean >= bloatOffset;
  checks.push({
    id: "5-prompt-size",
    ran: true,
    pass: bloatOk,
    detail:
      `prompt growth ${(input.promptGrowth * 100).toFixed(1)}% ` +
      `(max ${(maxGrowth * 100).toFixed(0)}% without a ${bloatOffset.toFixed(2)} paired-mean gain)`,
  });

  checks.push({
    id: "6-oversight-diff",
    ran: true,
    pass: input.postureDiffNonNegative,
    detail: input.postureDiffNonNegative ? "no posture lowered" : "candidate lowers oversight somewhere",
  });

  // THE CHECK THAT CANNOT RUN, AND THE SHARPEST JUDGEMENT IN THIS FILE.
  //
  // `8-determinism` runs the candidate's suite twice and compares the two replayed projections.
  // Two LIVE runs of a model do not match — that is what a model is — so the check has no
  // honest answer here. Three readings were available and two are wrong:
  //
  //   pass: true   — a lie. Nothing was compared. This is the exact shape of the journal
  //                  violations `oversight-survives-restart.test.ts` names: a guard switched off
  //                  quietly, reporting the answer it would have given if it had run.
  //   pass: false  — refuses every live candidate forever. A guard that cannot be satisfied is
  //                  not strict, it is absent: nobody would run this mode, and the replayed gate
  //                  would stay the only door — the one blind to prompts.
  //   did not run  — what is recorded. The check is reported, the reason is on the page, the
  //                  verdict carries `notRun`, and the decision is taken over the checks that
  //                  ran.
  //
  // "A guard that cannot decide fails closed" is satisfied by the ENCODING rather than by the
  // exit code: `pass: false` alongside `ran: false` means the conservative fold — the one a
  // consumer writes without reading this file — reads a live verdict as not fully passing.
  // What this mode may not do is let a reader mistake its certificate for the replayed gate's,
  // and `notRun` in the journal row is what stops that.
  checks.push({
    id: "8-determinism",
    ran: false,
    pass: false,
    detail:
      "DID NOT RUN — two live runs of a model do not produce identical state, so this check has no honest " +
      "answer in this mode. It is not reported as passed. This promotion was decided without it",
  });

  const ranChecks = checks.filter((x) => x.ran);
  return {
    promote: ranChecks.length > 0 && ranChecks.every((x) => x.pass),
    checks,
    notRun: checks.filter((x) => !x.ran).map((x) => x.id),
    paired,
  };
}
