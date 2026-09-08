/**
 * S1 from an exam the candidate did not write, and the exam as part of the ruler.
 *
 * Three claims, each against a control:
 *
 * 1. WITH an exam, `scoreTrajectory` takes S1 from the exam's verdict and reads none of the
 *    graph's own assertions; WITHOUT one, byte-identical to before — the same fixtures score the
 *    same numbers, which is what keeps every old journal folding.
 * 2. A run the exam could not read is not delivered: score exactly 0, whatever its own evaluator
 *    said and whatever efficiency credit a priced cohort would otherwise pay.
 * 3. The exam is in `weightsDigest`. A cohort measured under exam E refuses a score without it,
 *    and vice versa, through the `E_COHORT_INVALIDATED` refusal that already existed — and a
 *    pre-exam `evolution.scored` row's digest is not the exam ruler's, so a reader that compares
 *    digests excludes it rather than mixing it in.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "../../src/canonical.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { ExamOutcome } from "../../src/evolution/exam.ts";
import { DEFAULT_WEIGHTS, measureCohort, scoreTrajectory, type CohortStats } from "../../src/evolution/score.ts";
import type { OutcomeSignals, Trajectory, TrajectoryStep } from "../../src/evolution/trajectory.ts";
import type { NodeId, RunId, TaskId } from "../../src/ids.ts";

const n = (id: string): NodeId => id as NodeId;
const EXAM = "sha256:exam";

const signals = (over: Partial<OutcomeSignals> = {}): OutcomeSignals => ({
  assertions: [],
  humanDecisions: [],
  rubrics: [],
  selfReported: false,
  runStatus: "succeeded",
  ...over,
});

/** A step that committed a channel — the evidence of work a `function` node leaves. */
const wrote = (nodeId: string, channels: string[]): TrajectoryStep => ({
  taskId: `${nodeId}@root#0` as TaskId,
  nodeId: n(nodeId),
  nodeType: "function",
  branchPath: "root",
  attempts: 1,
  stateInHash: "",
  stateOutHash: "",
  actions: [],
  status: "succeeded",
  channelsWritten: channels,
  observationDigest: digest(channels),
});

function trajectory(over: Partial<Trajectory> = {}): Trajectory {
  return {
    runId: "run_1" as RunId,
    graphHash: "h",
    authoredGraphHash: "h",
    cohort: { workflow: "w", graphHash: "h", tenantTier: "default", inputBucket: "b" },
    steps: [wrote("pick", ["picked"])],
    outcome: signals({ assertions: [{ nodeId: n("check"), pass: true }] }),
    usage: { costUsd: 0.001, tokens: 150, wallMs: 250, modelCalls: 0, toolCalls: 0, subgraphRuns: 0 },
    policy: { escalations: [], violations: 0, gatesRaised: 0 },
    inputDigest: digest({}),
    fromUnpromotedCandidate: false,
    specResolved: true,
    verdictsResolved: true,
    ...over,
  };
}

const cohort = (over: Partial<CohortStats> = {}): CohortStats => ({
  key: "w|h|default|b",
  n: 50,
  p50Cost: 0.001,
  p50Wall: 250,
  p50Gates: 0,
  p90Score: 0.5,
  outcomeSpread: 0.5,
  weightsDigest: digest(DEFAULT_WEIGHTS),
  ...over,
});

const examCohort = (over: Partial<CohortStats> = {}): CohortStats =>
  cohort({ weightsDigest: digest({ weights: DEFAULT_WEIGHTS, examGraphHash: EXAM }), ...over });

const graded = (pass: boolean, score?: number): ExamOutcome => ({
  graphHash: EXAM,
  gradable: true,
  examRunId: "run_exam",
  verdict: score === undefined ? { pass } : { pass, score },
});

// ── 1 · S1 comes from the exam, and the in-graph assertion is not read ───────

test("WITH AN EXAM, S1 IS THE EXAM'S VERDICT AND THE GRAPH'S OWN ASSERTION IS NOT READ", () => {
  // The graph's own evaluator says pass; the exam says fail. The exam wins, and the row says why.
  const t = trajectory({ outcome: signals({ assertions: [{ nodeId: n("check"), pass: true }] }) });
  const s = scoreTrajectory(t, examCohort(), { exam: graded(false) });
  const s1 = s.signals.find((x) => x.id === "S1");
  assert.ok(s1 !== undefined);
  assert.equal(s1.value, 0);
  assert.match(s1.evidence, /exam run_exam graph sha256:exam: fail/);
  assert.equal(s.outcome, 0);
  assert.equal(s.components.delivered, true, "the run did work — a channel was committed — so it is delivered, and merely failed");

  // The control: no exam, and the graph's own assertion is what S1 reads.
  const own = scoreTrajectory(t, cohort());
  assert.equal(own.signals.find((x) => x.id === "S1")?.value, 1);
});

test("an exam score in [0, 1] is S1's value; pass alone maps to 1 / 0", () => {
  const t = trajectory();
  assert.equal(scoreTrajectory(t, examCohort(), { exam: graded(true, 0.5) }).signals.find((x) => x.id === "S1")?.value, 0.5);
  assert.equal(scoreTrajectory(t, examCohort(), { exam: graded(true) }).signals.find((x) => x.id === "S1")?.value, 1);
  assert.equal(scoreTrajectory(t, examCohort(), { exam: graded(false) }).signals.find((x) => x.id === "S1")?.value, 0);
});

test("WITHOUT AN EXAM, EVERY NUMBER IS WHAT IT WAS — the same fixture, the same digest, the same score", () => {
  const c = cohort();
  const t = trajectory();
  const s = scoreTrajectory(t, c);
  assert.equal(s.weightsDigest, digest(DEFAULT_WEIGHTS), "the pre-exam ruler digest is unchanged, so old rows still match");
  assert.equal(s.signals.find((x) => x.id === "S1")?.evidence, "1/1 assertions passed");
  // Cost 0.001 at the median → 0 credit; wall 250 at the median → 0; gates: p50 0 → 0. Score = 0.6.
  assert.equal(s.score, 0.6);
  const m = measureCohort("w|h|default|b", [t, trajectory({ runId: "run_2" as RunId })]);
  assert.equal(m.weightsDigest, digest(DEFAULT_WEIGHTS));
  assert.equal(m.n, 2);
});

// ── 2 · ungradable is undelivered ────────────────────────────────────────────

test("A RUN THE EXAM COULD NOT READ SCORES EXACTLY 0, in a priced cohort too — the work-deleting candidate", () => {
  // No `picked`: the exam's input is missing. The graph's own evaluator wrote `verdict` and
  // said pass — a committed channel AND an assertion — which is what bought this shape 0.600
  // against a free cohort and would buy 0.300 of cost and latency credit against a priced one.
  const noop = trajectory({
    steps: [wrote("check", ["verdict"])],
    outcome: signals({ assertions: [{ nodeId: n("check"), pass: true }] }),
    usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 0, toolCalls: 0, subgraphRuns: 0 },
  });
  const ungradable: ExamOutcome = { graphHash: EXAM, gradable: false, missing: ["picked"] };
  const s = scoreTrajectory(noop, examCohort({ p50Cost: 0.01, p50Wall: 1000 }), { exam: ungradable });
  assert.equal(s.score, 0);
  assert.equal(s.components.delivered, false);
  assert.equal(s.signals.some((x) => x.id === "S1"), false, "no S1 at all: nothing was graded");
  // The efficiency terms were measured — the record shows what it WOULD have earned — and paid nothing.
  assert.equal(s.components.costNormalized, 0);

  // The control: the same trajectory without an exam banks the whole efficiency credit.
  const before = scoreTrajectory(noop, cohort({ p50Cost: 0.01, p50Wall: 1000 }));
  assert.equal(before.score, 0.9, "0.6 outcome + 0.2 cost + 0.1 latency — what the audit measured, less the gate term");
});

test("gradable but UNGRADED — the exam run reached no verdict — is S1 = 0, not an absence", () => {
  const t = trajectory();
  const crashed: ExamOutcome = { graphHash: EXAM, gradable: true, examRunId: "run_exam" };
  const s = scoreTrajectory(t, examCohort(), { exam: crashed });
  const s1 = s.signals.find((x) => x.id === "S1");
  assert.equal(s1?.value, 0);
  assert.match(s1?.evidence ?? "", /reached no verdict/);
  assert.equal(s.components.delivered, true, "the run itself did work; it is the grade that is missing, and on the candidate side that is a fail");
});

test("under an exam an in-graph verdict is not work: a graph that only writes its own verdict and nothing else is undelivered", () => {
  // A step that wrote nothing plus an assertion: `didWork` used to say yes on the assertion alone.
  const opinionOnly = trajectory({
    steps: [],
    outcome: signals({ assertions: [{ nodeId: n("check"), pass: true }] }),
  });
  assert.equal(scoreTrajectory(opinionOnly, cohort()).components.delivered, true, "control: without an exam the assertion counts");
  assert.equal(scoreTrajectory(opinionOnly, examCohort(), { exam: graded(true) }).components.delivered, false);
});

// ── 3 · the exam is part of the ruler ────────────────────────────────────────

test("THE EXAM IS IN THE DIGEST: a cohort measured under it refuses a score without it, and vice versa", () => {
  const t = trajectory();
  const withExam = examCohort();
  const without = cohort();
  assert.notEqual(withExam.weightsDigest, without.weightsDigest);

  const refused = (fn: () => unknown): void => {
    let e: unknown;
    try {
      fn();
    } catch (x) {
      e = x;
    }
    assert.ok(isLoomError(e) && e.code === CODES.E_COHORT_INVALIDATED, `expected E_COHORT_INVALIDATED, got ${String(e)}`);
  };
  refused(() => scoreTrajectory(t, withExam));
  refused(() => scoreTrajectory(t, without, { exam: graded(true) }));
  // Two exams are two rulers.
  refused(() => scoreTrajectory(t, withExam, { exam: { ...graded(true), graphHash: "sha256:other-exam" } }));
  // And the matching pair is accepted.
  assert.equal(scoreTrajectory(t, withExam, { exam: graded(true) }).weightsDigest, withExam.weightsDigest);
});

test("A PRE-EXAM evolution.scored ROW IS UNDER ANOTHER RULER — a digest comparison excludes it", () => {
  // What `loom score` journaled before any attestation: `weightsDigest: digest(DEFAULT_WEIGHTS)`.
  // What it journals after: the exam ruler. `freezeSuite` and `loom cohort` compare the two
  // strings and count the row as `excludedForWeights`; this pins that the strings differ, which
  // is the whole mechanism — no new field, no new reader.
  const oldRow = { weightsDigest: digest(DEFAULT_WEIGHTS) };
  const grades = new Map<string, ExamOutcome>([["run_1", graded(true)], ["run_2", graded(false)]]);
  const m = measureCohort("w|h|default|b", [trajectory(), trajectory({ runId: "run_2" as RunId })], { exam: { graphHash: EXAM, grades } });
  assert.notEqual(oldRow.weightsDigest, m.weightsDigest);
  assert.equal(m.weightsDigest, digest({ weights: DEFAULT_WEIGHTS, examGraphHash: EXAM }));
});

test("measureCohort under an exam: members are the GRADED runs; ungradable and ungraded ones are not in the population", () => {
  const runs = [
    trajectory({ runId: "graded-pass" as RunId }),
    trajectory({ runId: "graded-fail" as RunId }),
    trajectory({ runId: "ungradable" as RunId }),
    trajectory({ runId: "crashed-exam" as RunId }),
    trajectory({ runId: "never-graded" as RunId }),
  ];
  const grades = new Map<string, ExamOutcome>([
    ["graded-pass", graded(true)],
    ["graded-fail", graded(false)],
    ["ungradable", { graphHash: EXAM, gradable: false, missing: ["picked"] }],
    ["crashed-exam", { graphHash: EXAM, gradable: true, examRunId: "x" }],
  ]);
  const m = measureCohort("w|h|default|b", runs, { exam: { graphHash: EXAM, grades } });
  assert.equal(m.n, 2);
  assert.equal(m.outcomeSpread, 1, "the two graded members disagree, so the ladder ranks");
  // Control: without an exam all five are members.
  assert.equal(measureCohort("w|h|default|b", runs).n, 5);
});

// ── the rung one over: S4 ────────────────────────────────────────────────────

/**
 * A CANDIDATE THAT CANNOT WRITE S1 ANY MORE CAN STILL ADD A SIGNAL BESIDE IT, and `outcomeOf`
 * averages over the signals PRESENT — so a `evaluator{kind:"rubric"}` node the candidate adds to
 * its own graph, grading a prompt the candidate wrote, does not dilute the exam's verdict, it
 * RAISES it. Measured at `0bd1be7` before this was closed: a run the operator's exam failed on
 * every input scored `outcome` 0.2308 instead of 0, which is +0.1385 of paired Δscore on every
 * pair — enough for `L1-paired-improvement` and `L5-candidate-earned-it` in any workflow whose
 * cost ratio a rubric's one model call does not move.
 *
 * This is CLAUDE.md §3's shape ("the candidate owns both sides of any channel the graph
 * produces") surviving inside the average after S1 was taken away from it, so under an exam S4 is
 * not read — the same clause the assertion branch and `didWork` already make.
 */
test("UNDER AN EXAM A RUBRIC THE CANDIDATE ADDED IS NOT A SIGNAL — it cannot raise the outcome of a run the exam failed", () => {
  const failed = trajectory({ outcome: signals({ rubrics: [{ nodeId: n("selfjudge"), score: 1, pass: true }] }) });
  const s = scoreTrajectory(failed, examCohort(), { exam: graded(false) });
  assert.deepEqual(s.signals.map((x) => x.id), ["S1"], "the exam's verdict, and nothing the candidate wrote beside it");
  assert.equal(s.outcome, 0, "a run the exam failed scores 0 outcome however it judged itself");

  // The control that makes it mean something: WITHOUT an exam every byte is what it was — S4 is
  // then one rung of the only ladder there is, capped at `canary` by `promotionCeiling`.
  const noExam = scoreTrajectory(failed, cohort(), {});
  assert.deepEqual(noExam.signals.map((x) => x.id), ["S4"], "the rubric is read, and is the whole ladder this run has");
  assert.equal(noExam.signals.find((x) => x.id === "S4")?.value, 1);
  assert.equal(noExam.outcome, 1, "which is exactly the S4-only run `promotionCeiling` caps at canary");

  // And the second control: an honest run the exam PASSED scores the same with the rubric and
  // without it, so this drops a lever rather than moving the ruler.
  const passedWith = scoreTrajectory(failed, examCohort(), { exam: graded(true) });
  const passedWithout = scoreTrajectory(trajectory({ outcome: signals({}) }), examCohort(), { exam: graded(true) });
  assert.equal(passedWith.outcome, passedWithout.outcome);
  assert.equal(passedWith.outcome, 1);
});
