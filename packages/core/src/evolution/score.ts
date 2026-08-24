/**
 * Scoring, and what makes a trajectory "golden".
 *
 * The design constraint this file exists to satisfy: **no single signal is trusted.**
 * Signals are weighted by how hard they are to fake, and the two easiest to fake are
 * weighted so low that a candidate optimised against them alone cannot move.
 *
 * | # | Signal | Weight | Why that weight |
 * |---|---|---|---|
 * | S1 | Deterministic verifier (`evaluator{kind:"assertion"}`) | 1.00 | The only signal a model cannot argue with |
 * | S2 | Human gate decision | 0.90 | Sparse, expensive, the most informative label the system ever gets |
 * | S3 | Downstream acceptance (no rework in 72 h) | 0.60 | Delayed; needs a maturation window before it is real |
 * | S4 | LLM rubric judge | 0.30 | **Never sufficient alone** — a model grading a model |
 * | S5 | Agent self-report | 0.00 | Deliberately zero. "Task complete" is the classic reward-hacking surface |
 *
 * S5 is captured and weighted zero rather than dropped, because a system that never
 * recorded self-reports could not later measure how often they were wrong — which is
 * the evidence for keeping the weight at zero.
 *
 */

import { digest, type Digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { Trajectory } from "./trajectory.ts";

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export type SignalId = "S1" | "S2" | "S3" | "S4" | "S5";

export const SIGNAL_WEIGHTS: Readonly<Record<SignalId, number>> = {
  S1: 1.0,
  S2: 0.9,
  S3: 0.6,
  S4: 0.3,
  S5: 0.0,
};

/** Signals strong enough to justify promotion on their own. S4 and S5 are not here. */
export const GROUND_TRUTH_SIGNALS: ReadonlySet<SignalId> = new Set<SignalId>(["S1", "S2", "S3"]);

export interface SignalReading {
  readonly id: SignalId;
  /** Normalized to `[0, 1]`. A `reject` is 0, not −1: the outcome is a fraction. */
  readonly value: number;
  readonly weight: number;
  readonly evidence: string;
}

/**
 * Downstream acceptance (S3), which the journal cannot know on its own.
 *
 * Supplied by the caller because it is a fact about the 72 hours AFTER the run: no
 * rework on the same `inputDigest`, no linked incident reopened. Modelling it as an
 * input keeps the scorer a pure function; modelling it as a lookup would make every
 * score depend on when it was computed.
 */
export interface DownstreamOutcome {
  readonly matured: boolean;
  readonly reworked: boolean;
  readonly incidentReopened: boolean;
}

export interface ScoreWeights {
  readonly outcome: number;
  readonly cost: number;
  readonly latency: number;
  readonly humanEffort: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  outcome: 0.6,
  cost: 0.2,
  latency: 0.1,
  humanEffort: 0.1,
};

/** Cohort medians. Scores are only ever comparable within one cohort. */
export interface CohortStats {
  readonly key: string;
  readonly n: number;
  readonly p50Cost: number;
  readonly p50Wall: number;
  readonly p50Gates: number;
  /** The 90th-percentile SCORE. Condition 2 of the golden threshold reads it. */
  readonly p90Score: number;
  /** Hash of the weights the cohort was measured under. */
  readonly weightsDigest: Digest;
}

export interface ScoredTrajectory {
  readonly runId: string;
  readonly cohortKey: string;
  readonly signals: readonly SignalReading[];
  readonly outcome: number;
  readonly score: number;
  readonly components: {
    readonly outcome: number;
    readonly costNormalized: number;
    readonly latencyNormalized: number;
    readonly humanEffortSaved: number;
  };
  /**
   * Journaled with every score, because a score computed under different weights is a
   * different metric. Comparing across a weight change is the quiet way a
   * self-improving system convinces itself it improved.
   */
  readonly weightsDigest: Digest;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function cohortKeyOf(t: Trajectory): string {
  const c = t.cohort;
  return `${c.workflow}|${c.graphHash}|${c.tenantTier}|${c.inputBucket}`;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Human decisions, mapped to `[0, 1]`. `edit` is a half-win AND a correction label. */
const DECISION_VALUE: Readonly<Record<string, number>> = {
  approve: 1,
  edit: 0.5,
  redirect: 0.25,
  reject: 0,
};

export function readSignals(t: Trajectory, downstream?: DownstreamOutcome): SignalReading[] {
  const out: SignalReading[] = [];
  const o = t.outcome;

  if (o.assertions.length > 0) {
    const passed = o.assertions.filter((a) => a.pass).length;
    out.push({
      id: "S1",
      value: passed / o.assertions.length,
      weight: SIGNAL_WEIGHTS.S1,
      evidence: `${passed}/${o.assertions.length} assertions passed`,
    });
  }
  if (o.humanDecisions.length > 0) {
    const sum = o.humanDecisions.reduce((a, d) => a + (DECISION_VALUE[d.decision] ?? 0), 0);
    out.push({
      id: "S2",
      value: sum / o.humanDecisions.length,
      weight: SIGNAL_WEIGHTS.S2,
      evidence: o.humanDecisions.map((d) => `${d.nodeId}:${d.decision}`).join(", "),
    });
  }
  if (downstream?.matured === true) {
    // Only counted once the window has elapsed. Scoring an immature trajectory as
    // "accepted" would credit every run for the absence of complaints nobody has had
    // time to make.
    const accepted = !downstream.reworked && !downstream.incidentReopened;
    out.push({
      id: "S3",
      value: accepted ? 1 : 0,
      weight: SIGNAL_WEIGHTS.S3,
      evidence: accepted ? "no rework, no reopened incident" : "reworked or reopened",
    });
  }
  if (o.rubrics.length > 0) {
    const avg = o.rubrics.reduce((a, r) => a + r.score, 0) / o.rubrics.length;
    out.push({ id: "S4", value: clamp01(avg), weight: SIGNAL_WEIGHTS.S4, evidence: `${o.rubrics.length} rubric verdict(s)` });
  }
  if (o.selfReported) {
    out.push({ id: "S5", value: 1, weight: SIGNAL_WEIGHTS.S5, evidence: "the agent said it was done" });
  }
  return out;
}

/**
 * `outcome = Σ(wᵢ·sᵢ) / Σ(wᵢ)` over the signals actually PRESENT.
 *
 * Dividing by the present weights rather than by the total is what keeps a run with
 * only S1 from being penalised for the absence of a human — absence of a signal is not
 * evidence against the run. The protection against S4-only optimisation is not the
 * denominator; it is `isGolden` condition 1 and the promotion ceiling.
 */
export function outcomeOf(signals: readonly SignalReading[]): number {
  const present = signals.filter((s) => s.weight > 0);
  const total = present.reduce((a, s) => a + s.weight, 0);
  if (total === 0) return 0;
  return present.reduce((a, s) => a + s.weight * s.value, 0) / total;
}

export function scoreTrajectory(
  t: Trajectory,
  cohort: CohortStats,
  opts: { downstream?: DownstreamOutcome; weights?: ScoreWeights } = {},
): ScoredTrajectory {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const wd = digest(weights);
  if (wd !== cohort.weightsDigest) {
    // A weight change invalidates the cohort. Refusing here rather than warning is the
    // point: the failure mode is a system that quietly reports an improvement it
    // measured with a different ruler.
    throw err.validation(
      CODES.E_COHORT_INVALIDATED,
      `cohort "${cohort.key}" was measured under different score weights; re-measure it before comparing`,
      { details: { cohortWeights: cohort.weightsDigest, theseWeights: wd } },
    );
  }

  const signals = readSignals(t, opts.downstream);
  const outcome = outcomeOf(signals);

  const costNormalized = cohort.p50Cost > 0 ? clamp01(t.usage.costUsd / cohort.p50Cost) : 0;
  const latencyNormalized = cohort.p50Wall > 0 ? clamp01(t.usage.wallMs / cohort.p50Wall) : 0;
  const humanEffortSaved =
    cohort.p50Gates > 0 ? clamp01(1 - t.policy.gatesRaised / cohort.p50Gates) : 1;

  const score =
    weights.outcome * outcome +
    weights.cost * (1 - costNormalized) +
    weights.latency * (1 - latencyNormalized) +
    weights.humanEffort * humanEffortSaved;

  return {
    runId: t.runId,
    cohortKey: cohortKeyOf(t),
    signals,
    outcome,
    score,
    components: { outcome, costNormalized, latencyNormalized, humanEffortSaved },
    weightsDigest: wd,
  };
}

// ---------------------------------------------------------------------------
// The golden threshold
// ---------------------------------------------------------------------------

export interface GoldenVerdict {
  readonly golden: boolean;
  /** Every condition, pass or fail — a verdict that cannot say why is not a verdict. */
  readonly conditions: readonly { readonly id: number; readonly name: string; readonly pass: boolean; readonly detail: string }[];
}

export const MIN_COHORT_SIZE = 30;
export const MIN_OUTCOME = 0.8;

/**
 * All five conditions, and they are conjunctive.
 *
 * Each one blocks a specific way the corpus rots: 1 blocks a model grading itself into
 * the training set, 2 blocks "good enough" becoming the standard, 3 blocks learning from
 * a run that broke a rule, 4 blocks fitting to noise, 5 blocks self-training on the
 * output of an unpromoted candidate.
 */
export function isGolden(
  t: Trajectory,
  scored: ScoredTrajectory,
  cohort: CohortStats,
): GoldenVerdict {
  const hasGroundTruth = scored.signals.some((s) => GROUND_TRUTH_SIGNALS.has(s.id));
  const conditions = [
    {
      id: 1,
      name: "outcome and ground truth",
      pass: scored.outcome >= MIN_OUTCOME && hasGroundTruth,
      detail: `outcome ${scored.outcome.toFixed(3)} (need ≥ ${MIN_OUTCOME}); ground-truth signal ${hasGroundTruth ? "present" : "ABSENT — S4 alone never qualifies"}`,
    },
    {
      id: 2,
      name: "top decile of its cohort",
      pass: scored.score >= cohort.p90Score,
      detail: `score ${scored.score.toFixed(3)} vs p90 ${cohort.p90Score.toFixed(3)}`,
    },
    {
      id: 3,
      name: "no policy violations",
      pass: t.policy.violations === 0 && !t.policy.escalations.includes("violation"),
      detail: `${t.policy.violations} violation(s)`,
    },
    {
      id: 4,
      name: "cohort large enough",
      pass: cohort.n >= MIN_COHORT_SIZE,
      detail: `n = ${cohort.n} (need ≥ ${MIN_COHORT_SIZE})`,
    },
    {
      id: 5,
      name: "not self-training",
      pass: !t.fromUnpromotedCandidate,
      detail: t.fromUnpromotedCandidate ? "produced by an unpromoted candidate" : "produced by a promoted graph",
    },
  ];
  return { golden: conditions.every((c) => c.pass), conditions };
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

/**
 * Measure a cohort from its own scored members.
 *
 * Two-pass by necessity: `p90Score` is a statistic OF the scores, so the cohort is
 * first measured with a neutral baseline (medians only) and then the resulting scores
 * define the percentile. Circular only in appearance — the second pass reads the first
 * pass's output, never its own.
 */
export function measureCohort(
  key: string,
  members: readonly Trajectory[],
  opts: { weights?: ScoreWeights; downstream?: ReadonlyMap<string, DownstreamOutcome> } = {},
): CohortStats {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const weightsDigest = digest(weights);
  const p50 = (xs: readonly number[]): number => {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)]!;
  };

  const base: CohortStats = {
    key,
    n: members.length,
    p50Cost: p50(members.map((m) => m.usage.costUsd)),
    p50Wall: p50(members.map((m) => m.usage.wallMs)),
    p50Gates: p50(members.map((m) => m.policy.gatesRaised)),
    p90Score: 0,
    weightsDigest,
  };

  const scores = members
    .map((m) => {
      const d = opts.downstream?.get(m.runId);
      return scoreTrajectory(m, base, { weights, ...(d === undefined ? {} : { downstream: d }) }).score;
    })
    .sort((a, b) => a - b);

  return { ...base, p90Score: scores.length === 0 ? 0 : scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.9))]! };
}

/**
 * The promotion ceiling a trajectory's signals justify (D10.b).
 *
 * S4-only is capped at `canary` and never auto-promotes, whatever its score. This is
 * the second, independent barrier against rubric optimisation: even a candidate whose
 * rubric scores are perfect cannot reach `stable` without a signal a model cannot fake.
 */
export function promotionCeiling(signals: readonly SignalReading[]): {
  readonly channel: "draft" | "canary" | "stable";
  readonly requiresHumanSignOff: boolean;
  readonly reason: string;
} {
  const ids = new Set(signals.map((s) => s.id));
  if (ids.has("S1")) return { channel: "stable", requiresHumanSignOff: false, reason: "a deterministic verifier passed" };
  if (ids.has("S2")) return { channel: "stable", requiresHumanSignOff: false, reason: "a human decided on it" };
  if (ids.has("S3")) return { channel: "canary", requiresHumanSignOff: false, reason: "downstream acceptance only — stable needs 2× the normal canary volume" };
  if (ids.has("S4")) return { channel: "canary", requiresHumanSignOff: true, reason: "rubric only — capped at canary, and never automatically" };
  return { channel: "draft", requiresHumanSignOff: true, reason: "no signal above self-report" };
}
