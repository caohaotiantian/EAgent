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
 * ## The floor, which is not a rung
 *
 * **A run that did not reach terminal success scores 0.** The ladder above measures how good
 * the work was; `runStatus` measures whether there was any. Those are different questions, and
 * for a long time this file only asked the first — so the 0.4 of the score that is cost +
 * latency + human-effort credit was paid to a run that died on turn one, and the dominant
 * strategy against this metric was *to fail*. Measured on identical fixtures: 0.400 for the
 * failure, 0.100 for the success.
 *
 * It is a MULTIPLIER rather than a sixth signal, and that is deliberate twice over:
 *
 * - Success is not evidence of quality. "The graph reached its last node" is the engine's own
 *   claim about itself, one rung above S5. As a weight-1.0 rung it would halve the
 *   discrimination of every real signal — an S1 failure would read 0.5 instead of 0.
 * - Failure is not weak evidence; it is the absence of the thing being measured. Cost and
 *   latency are *efficiency* terms, and efficiency is a ratio to work delivered. Crediting
 *   cheapness to a run that delivered nothing is precisely the reward for failing, so zeroing
 *   the outcome alone does not close it — the whole score has to go.
 *
 * `failed`, `cancelled` and `incomplete` are all treated alike; `incomplete` is a journal with
 * no terminal event at all, and a scorer that cannot tell what happened fails closed.
 *
 * `measureCohort` goes further and drops non-succeeded members from the POPULATION — see there.
 *
 * ## Terminal success is not delivered work — and neither is an unmeasured one
 *
 * The floor above was stated as a rule about `runStatus` and then applied only to that, which
 * left the same gaming move one step over: a run that reaches its last node having DONE NOTHING
 * is also a run that delivered nothing, and it was banking the whole cost and latency credit for
 * it — free money for the cheapest possible behaviour. The efficiency terms are therefore paid
 * only to a run that both finished AND did work: `components.delivered`.
 *
 * **WHAT "WORK" MEANS HERE IS THE PART THAT WAS GOT WRONG.** The first correction read it as
 * "left a weighted SIGNAL behind", and that is a statement about how good the work was, not
 * about whether there was any. A workflow with no assertion, gate or rubric node — which is
 * exactly the shape `agent()` builds — produces no signal ever, so every succeeded run in such a
 * cohort was undelivered, and the score collapsed to a constant.
 *
 * Measured over one fixture — 30 succeeded runs with one model call each, cost $0.001…$0.030
 * (p50 $0.015) and wall 100…3000 ms (p50 1500), no gates and no signal of any kind; scored
 * against a cheap outsider ($0.0001 / 10 ms), a dear one ($10.00 / 100 s), and a no-op success
 * (no calls, $0, 0 ms):
 *
 * ```
 *                p90Score   cheap    dear    no-op
 * ungated          0.340    0.398   0.100    0.400   ← the no-op wins outright
 * signal-gated     0.100    0.100   0.100    0.100   ← nothing can be told from anything
 * work-gated       0.340    0.398   0.100    0.000
 * ```
 *
 * A metric that returns the same number for a $10 run and a $0.0001 run has stopped measuring,
 * and `isGolden` condition 2 (`score >= cohort.p90Score`) is vacuous under it: every member ties
 * the bar. "No ground truth was available" and "nothing was delivered" are different facts, and
 * only the second is a verdict on the run.
 *
 * `didWork` is therefore the predicate — a model call, a tool call, a delegated child run, a
 * committed channel, or a verdict of any kind — and it reads only the journal, so it is
 * available in every cohort. The gaming move it closes is unchanged: a graph that reaches its
 * last node having called nothing AND written nothing earns nothing at all, and per the
 * floor's own argument its score is 0 rather than a discounted rung, because the absence of
 * the thing being measured is not a cheap instance of it.
 *
 * ## …AND DELIVERY HAS TO SURVIVE DELEGATION, which is the third correction
 *
 * The second correction stated the predicate over model calls, tool calls and verdicts, and
 * every one of those is a row a PARENT's journal does not contain. A `subgraph` node's calls
 * are in the CHILD's journal — that separation is the point of having subgraphs — and a
 * `function` node bills nothing at all. So the multi-agent shape, the thing this runtime
 * exists for, scored a constant 0 and was dropped from its own cohort, while the identical
 * work written INLINE scored 0.200. See `didWork` for the measurement and the full set.
 *
 * The same delegation boundary hid SPEND, and cheapness is 20% of the score: a subgraph that
 * FAILS appends no `subgraph.completed`, so a fold that reads only effect records lost the
 * child's whole bill. Measured on one real Engine — child burns $5.00, subgraph task fails,
 * parent routes to a $0.01 fallback, run succeeds — the trajectory read $0.01 against a
 * projection of $5.01. *Fail your subgraph and look cheap* is a strategy that beats doing the
 * work, which is exactly what this metric may not reward. `evolution/trajectory.ts` closes it
 * by charging a commit's restated usage as EXCESS; see the `spend` comment there.
 *
 * The human-effort term is not gated separately; it rides on the same `delivered`, because
 * "raised no gates" is precisely what a run that did nothing can claim most easily.
 *
 * ## …AND A SCORE THAT COULD NOT FIND WHAT IT WAS SCORING IS NOT A LOW SCORE
 *
 * Every rung above S2 is read out of the GRAPH: `extractSignals` keys assertions, rubrics and
 * self-report on node types, and node types come from `spec.nodes`. A trajectory folded without
 * its graph therefore arrives here with `assertions: []` and scores exactly what a run that
 * failed every assertion scores. Driven live on one `review-bench` run, same run and same
 * command twice (`docs/evolution-loop-2026-08-27.md` §4): graph absent from `<ws>/graphs/` →
 * `signals []`, outcome 0, **score 0.111**; graph present → `S1 "6/6 assertions passed"`,
 * outcome 1, **score 0.700**. A candidate graph is published in `candidates/`, so every
 * candidate cohort read as worthless and nothing on the page said why.
 *
 * `Trajectory.specResolved` is the fold's answer to "did I have the spec", and this file treats
 * a `false` as the guard-that-cannot-decide case CLAUDE.md names: the outcome is 0, the score is
 * 0, `components.specResolved` says which zero it is, and `isGolden` condition 6 refuses on it
 * by name. **The zero is not the point — the marker is.** A consumer that reads only the number
 * has to be able to find out it is not a measurement, and `measureCohort` drops such a member
 * from the POPULATION for the same reason it drops a non-run — see there for the measurement.
 *
 * `loom score` goes further and refuses to run at all, because the CLI can say the one thing
 * this file cannot: WHICH graph is missing and where to put it.
 */

import { digest, type Digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
// The number condition 6 has to quote. Imported rather than restated, so the size named in the
// refusal and the size the engine decided by cannot drift apart.
import { EXTERNALISE_ABOVE_BYTES } from "../journal/payloads.ts";
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
    /**
     * `runStatus === "succeeded"`. Reported because a score of 0 has two very different
     * causes — the run was bad, or the run never happened — and a verdict that cannot say
     * which is not a verdict. The normalized terms above are still the measured ones, so the
     * record shows what the run WOULD have scored had it finished.
     */
    readonly completed: boolean;
    /**
     * The run finished AND `didWork` — so there is work for the efficiency terms to be a
     * ratio TO. Reported next to `completed` because those are the two different reasons a
     * score of 0 can happen, and "the run never got anywhere" is a different verdict from
     * "the run finished without doing anything".
     */
    readonly delivered: boolean;
    /**
     * `Trajectory.specResolved`, carried through — the THIRD reason a score of 0 can happen,
     * and the only one that is not a verdict on the run at all. `false` means the signal rungs
     * were unreadable, so this row is a failed measurement and not a measured failure. TWO
     * THINGS MAKE IT FALSE — the fold had no graph, or an evaluator's verdict had left the
     * journal for the payload store — and this flag deliberately does not say which, because
     * every consumer's decision is the same either way. `isGolden` condition 6 reads
     * `Trajectory.verdictsResolved` beside it to tell an operator WHICH, and that split exists
     * because condition 6 used to name the first cause for both.
     */
    readonly specResolved: boolean;
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

/**
 * DID THIS RUN DO ANYTHING? — the denominator the efficiency terms are a ratio to.
 *
 * Deliberately a question about EVIDENCE OF WORK and not about the quality of it, which is
 * the distinction the first correction lost (see the header). Every member is a row the
 * journal already holds for every workflow, so the answer exists in a cohort that has no
 * evaluator, gate or rubric node — the shape `agent()` builds — where the quality signals are
 * all absent by construction.
 *
 * The set it covers, exhaustively: a model turn (`usage.modelCalls`), a tool call
 * (`usage.toolCalls`), a delegated child run (`usage.subgraphRuns`), a step that SUCCEEDED
 * having committed at least one channel (`steps[].channelsWritten`), an assertion verdict, a
 * human gate decision, a rubric verdict.
 *
 * THE LAST TWO ARE THE THIRD CORRECTION, and they exist because the first three members are
 * all rows a PARENT's journal does not have. A `subgraph` node's model and tool calls are in
 * the CHILD's journal by design; a `function`, `tool` or `router` node bills nothing at all
 * (`run/engine.ts` `#runFunction` returns `ZERO_USAGE` and appends no `tool.called`). Measured
 * on real Engines, before they were members:
 *
 * ```
 *                                 modelCalls  toolCalls  delivered  score  cohort n
 * parent of one `subgraph` node        0          0        false    0.000     0
 * the same work INLINE                 1          0        true     0.200     1
 * one `function` node, output written  0          0        false    0.000     0
 * ```
 *
 * The multi-agent shape — the thing this runtime exists for — scored zero and was dropped
 * from its own cohort. A committed channel is the line, and it is a real one: a body that
 * returns `{}` writes nothing and is still worth nothing, which is exactly the no-op the
 * paragraph above refuses.
 *
 * "But then a trivial graph that writes one constant channel scores near 1" — it does, and it
 * beats nothing by doing so. `cohortKeyOf` keys on `graphHash`, so that graph is measured
 * against OTHER RUNS OF ITSELF and never against the workflow it would be gaming; the cross-
 * cohort comparison this predicate would have to corrupt does not exist. Within one cohort the
 * predicate is the same for every member, and what separates them is spend, latency and the
 * ladder.
 *
 * Two deliberate exclusions:
 *
 * - `selfReported` (S5) is NOT here. "Task complete" is the reward-hacking surface the ladder
 *   weights zero, and letting it buy the efficiency credit back would re-price it above zero
 *   through the side door.
 * - S3, downstream acceptance, is NOT here either. Nobody having complained within 72 hours
 *   is not evidence that anything happened; a run that did nothing gets it for free.
 *
 * Cost is NOT a member. A run that spent money is not thereby working, and making spend the
 * evidence of work would let a run buy its own efficiency credit.
 *
 * NOT EXPORTED. It is a term inside this metric, not a question anybody else has to ask —
 * `measureCohort` already applies it to the population, and `components.delivered` reports
 * its answer per run. Adding a public name is a reviewed act (`scripts/surface.json`), and
 * this one buys a caller nothing it cannot read off a `ScoredTrajectory`.
 */
function didWork(t: Trajectory): boolean {
  return (
    t.usage.modelCalls > 0 ||
    t.usage.toolCalls > 0 ||
    t.usage.subgraphRuns > 0 ||
    t.steps.some((s) => s.status === "succeeded" && s.channelsWritten.length > 0) ||
    t.outcome.assertions.length > 0 ||
    t.outcome.humanDecisions.length > 0 ||
    t.outcome.rubrics.length > 0
  );
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
  // THE FLOOR (see the header). The signals are still read and still reported as evidence —
  // a run can pass an assertion and then die, and the record should say so — but the run's
  // outcome is the outcome of the RUN, and a run that did not finish has none.
  const completed = t.outcome.runStatus === "succeeded";
  // AND THE MEASUREMENT ITSELF CAN BE MISSING. Without the spec the ladder is unreadable, and
  // what survives is whatever needs no node type — a gate decision (S2) comes off the journal
  // and would otherwise be reported as if it were the whole outcome. A partial ladder presented
  // as a complete one is the failure this closes; see the header for the two live readings.
  const measured = t.specResolved;
  const outcome = completed && measured ? outcomeOf(signals) : 0;

  const costNormalized = cohort.p50Cost > 0 ? clamp01(t.usage.costUsd / cohort.p50Cost) : 0;
  const latencyNormalized = cohort.p50Wall > 0 ? clamp01(t.usage.wallMs / cohort.p50Wall) : 0;
  const humanEffortSaved =
    cohort.p50Gates > 0 ? clamp01(1 - t.policy.gatesRaised / cohort.p50Gates) : 1;

  // EFFICIENCY IS A RATIO TO WORK DELIVERED — see the header — and `runStatus === "succeeded"`
  // is not that work. Measured on this tree before the gate existed: a no-op success banked the
  // whole cost + latency credit and scored 0.400. That is the same reward-for-failing the floor
  // was added to close, wearing terminal success as a disguise.
  const delivered = completed && didWork(t);

  const earned =
    weights.outcome * outcome +
    weights.cost * (1 - costNormalized) +
    weights.latency * (1 - latencyNormalized) +
    weights.humanEffort * humanEffortSaved;

  return {
    runId: t.runId,
    cohortKey: cohortKeyOf(t),
    signals,
    outcome,
    score: delivered && measured ? earned : 0,
    components: { outcome, costNormalized, latencyNormalized, humanEffortSaved, completed, delivered, specResolved: measured },
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
 * All six conditions, and they are conjunctive.
 *
 * Each one blocks a specific way the corpus rots: 1 blocks a model grading itself into
 * the training set, 2 blocks "good enough" becoming the standard, 3 blocks learning from
 * a run that broke a rule, 4 blocks fitting to noise, 5 blocks self-training on the
 * output of an unpromoted candidate, and 6 blocks learning from a run NOBODY MEASURED.
 *
 * 6 is not a rung and it is not redundant with 1. With the ladder unreadable, 1 fails too — but
 * it fails saying `outcome 0.000`, which reads as "this run was bad" and is the exact confusion
 * `goldenBlockers` exists to prevent. The condition names the cause instead — and it names the
 * cause that is actually true, which is the whole reason it branches: see there.
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
    {
      id: 6,
      name: "the signals were readable",
      pass: scored.components.specResolved,
      detail: scored.components.specResolved
        ? "the graph was available and every verdict was in the journal, so an absent signal is an absent signal"
        : // TWO CAUSES, AND THE MESSAGE HAS TO PICK THE RIGHT ONE. `specResolved` is the AND of
          // "the fold had the graph" and `verdictsResolved`; it used to be the first alone, and
          // when the second joined it this string went on naming the first — so a run folded WITH
          // its graph was told its graph was missing. They cannot both be the cause: with no
          // graph there are no node types, no step is known to be an `evaluator`, and
          // `verdictsResolved` comes back vacuously true. So a false `verdictsResolved` proves
          // the graph WAS there, and this branch is exhaustive rather than a preference.
          !t.verdictsResolved
          ? `UNREADABLE VERDICT — the graph was available, but an evaluator step's channel is a payload handle ` +
            `rather than a value: its canonical form passed ${String(EXTERNALISE_ABOVE_BYTES)} bytes, so the engine ` +
            `moved it out of the journal and the fold cannot read the verdict it held. The score is a failed ` +
            `measurement rather than a measured failure. Nothing recovers this run — the value is not in its ` +
            `journal. To make later runs of graph ${t.graphHash} measurable, keep the evaluator's verdict channel ` +
            `under that size, or make it ineligible for the payload store by declaring it in the graph's outputs ` +
            `or naming it in an edge or router expression.`
          : `NO SPEC — graph ${t.graphHash} was not available to the fold, so no assertion, rubric or ` +
            `self-report could be read and this score is a failed measurement rather than a measured failure`,
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
 *
 * ONLY RUNS THAT SUCCEEDED **AND DID WORK** ARE MEMBERS, which is the second half of the fix
 * the floor started. Zeroing a run's score stops it from winning; it does not stop it from
 * moving the ruler. A cohort padded with cheap non-runs reports a lower `p50Cost` and
 * `p50Wall` — so an honest run reads as expensive and scores lower — and, worse, a lower
 * `p90Score`, which is the bar `isGolden` condition 2 has to clear. A promotion bar that any
 * run can lower by standing next to it is exactly the measurement gamed by the thing being
 * measured.
 *
 * The `didWork` half is not hypothetical padding: a no-op success scores 0 and costs $0, so it
 * is the single most effective thing that can be added to a cohort to lower both the median
 * and the bar. Measured on the 30-member no-signal cohort in the header, and with this filter
 * reading `runStatus` alone, adding 15 no-op successes moved p50Cost $0.015 → $0.008 and
 * p90Score 0.340 → 0.213 — every honest member re-priced as expensive against a median it did
 * not spend, and the promotion bar cut by a third. With the filter as written both hold at
 * $0.015 and 0.340.
 *
 * AND A MEMBER NOBODY COULD MEASURE IS NOT A MEMBER EITHER — the third clause, and the same
 * argument a third time. `cohortPeers` (`cli.ts`) already fixed the case where every peer folded
 * without a spec; the residue its docstring recorded — "a peer whose authored graph is not
 * published in `graphs/` still folds without one … cohort `n` does not move either way" — got
 * the damage backwards. `n` not moving IS the damage: an unmeasured peer stayed a member, so
 * `MIN_COHORT_SIZE` counted it, and its score set a percentile nobody took.
 *
 * Measured on the header's own 30-member fixture — succeeded, one model call each, cost
 * $0.001…$0.030 (p50 $0.015), wall 100…3000 ms, no signal of any kind — folded three ways, with
 * `isGolden` conditions 2 and 4 read off the result (`test/evolution/score.test.ts`):
 *
 * ```
 *                                    n    p50Cost   p90Score   cond 2 passes   cond 4
 * all 30 with their spec            30    $0.0150      0.340         3 / 30      pass
 * all 30 with NO spec, dropped       0    $0.0000      0.000        30 / 30      FAIL
 * 15 and 15, dropped                15    $0.0080      0.325         2 / 30      FAIL
 * ```
 *
 * A THIRD ROW STOOD HERE AND HAS BEEN REMOVED RATHER THAN RENUMBERED. It claimed to be the
 * pre-fix behaviour — specless members KEPT, at `p90Score 0.000` and condition 2 passing 30/30 —
 * and two independent reconstructions of the code as it stood, one by this lane's reviewer and
 * one after it, both got `p90Score 0.340` and condition 2 passing 3/30 on this same fixture. A
 * number nobody can reproduce does not become true by being specific, and swapping in a second
 * guess would be the failure the working rules name: a correction that replaces a false claim
 * with a differently-false one is worse than the original.
 *
 * The argument the row was offered as evidence for does not rest on it. Keeping a member nobody
 * could measure inflates `n`, so `MIN_COHORT_SIZE` counts a run that carries no signal toward
 * "cohort large enough" — that is visible in the two rows above, where dropping thirty
 * unmeasurable members takes `n` from 30 to 0 and condition 4 from pass to FAIL. Whether their
 * scores also flattened the p90 is the part that did not reproduce, and it is not load-bearing:
 * a bar set by runs nobody measured is wrong at any height.
 *
 * `n` therefore counts comparable runs rather than journal rows, and `MIN_COHORT_SIZE` means
 * 30 of those.
 */
export function measureCohort(
  key: string,
  all: readonly Trajectory[],
  opts: { weights?: ScoreWeights; downstream?: ReadonlyMap<string, DownstreamOutcome> } = {},
): CohortStats {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const weightsDigest = digest(weights);
  const members = all.filter((m) => m.specResolved && m.outcome.runStatus === "succeeded" && didWork(m));
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
