/**
 * Two guards in the score and the gate answered their undecidable case with the PASSING value.
 *
 * `scoreTrajectory` normalises cost, latency and gates against the cohort median. When that
 * median is 0 — every offline workflow, and any cohort where more than half the runs are free —
 * the three terms used to pay FULL credit: a $1,000 / 1-hour / 99-gate run scored 0.400, the
 * whole efficiency budget, identical to a $0 / 0 ms / 0-gate run. `gateCandidate`'s `3-cost` and
 * `4-latency` did the same one door up: a baseline that spent nothing made the ratio 1.00×
 * whatever the candidate spent.
 *
 * The rule both now follow is the one `pairedCostRatio` (live.ts) already took for a $0
 * baseline, because it is the limit of the ratio and not a convention: 0 / 0 is "at the median"
 * (no credit), and x / 0 for x > 0 is unbounded, which no ceiling contains. A run in a free
 * cohort is not CHEAPER than its median whatever it spent; a run in a gateless cohort SAVED no
 * human effort. Both are true statements, where "full credit" was a number nobody measured.
 *
 * The ORDINARY half is asserted beside each defect: a priced cohort still pays a cheap run and
 * not a dear one; two free runs in a free cohort are still told apart by the ladder; a baseline
 * and candidate that both spent nothing still tie at 1.00×.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "../../src/canonical.ts";
import { gateCandidate, type EvalReport } from "../../src/evolution/gate.ts";
import { DEFAULT_WEIGHTS, cohortKeyOf, measureCohort, scoreTrajectory } from "../../src/evolution/score.ts";
import type { Trajectory } from "../../src/evolution/trajectory.ts";
import type { NodeId, RunId, TaskId } from "../../src/ids.ts";

function trajectory(id: string, over: { costUsd?: number; wallMs?: number; gates?: number; graphHash?: string; pass?: boolean } = {}): Trajectory {
  const graphHash = over.graphHash ?? "h";
  return {
    runId: id as RunId,
    graphHash,
    authoredGraphHash: graphHash,
    cohort: { workflow: "w", graphHash, tenantTier: "default", inputBucket: "b" },
    steps: [
      {
        taskId: "f@root#0" as TaskId,
        nodeId: "f" as NodeId,
        nodeType: "function",
        branchPath: "root",
        attempts: 1,
        stateInHash: digest({ in: 1 }),
        stateOutHash: digest({ out: 1 }),
        actions: [],
        status: "succeeded",
        channelsWritten: ["out"],
        observationDigest: digest({ out: 1 }),
      },
    ],
    outcome: {
      assertions: over.pass === undefined ? [] : [{ nodeId: "check" as NodeId, pass: over.pass }],
      humanDecisions: [],
      rubrics: [],
      selfReported: false,
      runStatus: "succeeded",
    },
    usage: { costUsd: over.costUsd ?? 0, tokens: 0, wallMs: over.wallMs ?? 0, modelCalls: 0, toolCalls: 0, subgraphRuns: 0 },
    policy: { escalations: [], violations: 0, gatesRaised: over.gates ?? 0 },
    inputDigest: digest({}),
    fromUnpromotedCandidate: false,
    specResolved: true,
    verdictsResolved: true,
  };
}

const FREE = Array.from({ length: 30 }, (_, i) => trajectory(`free_${i}`));
const PRICED = Array.from({ length: 30 }, (_, i) => trajectory(`priced_${i}`, { costUsd: 0.001 * (i + 1), wallMs: 100 * (i + 1) }));

test("A FREE COHORT PAYS NO EFFICIENCY CREDIT TO A $1,000 / 1-HOUR / 99-GATE RUN", () => {
  const cohort = measureCohort("w|h|default|b", FREE);
  assert.deepEqual(
    { p50Cost: cohort.p50Cost, p50Wall: cohort.p50Wall, p50Gates: cohort.p50Gates },
    { p50Cost: 0, p50Wall: 0, p50Gates: 0 },
    "the premise: every median is 0",
  );

  const dear = scoreTrajectory(trajectory("dear", { costUsd: 1000, wallMs: 3_600_000, gates: 99 }), cohort);
  // Measured at 95a3dde: score 0.4, costNormalized 0, latencyNormalized 0, humanEffortSaved 1.
  assert.equal(dear.components.costNormalized, 1, "$1,000 against a $0 median is not below the median");
  assert.equal(dear.components.latencyNormalized, 1, "an hour against a 0 ms median is not below the median");
  assert.equal(dear.components.humanEffortSaved, 0, "99 gates against a gateless median saved nothing");
  assert.equal(dear.score, 0, "no outcome and no earned efficiency is 0, not 0.400");
  assert.equal(dear.components.delivered, true, "…and the zero is not `delivered` failing — the run did work");
});

test("a FREE run in a free cohort is not paid either — 0 / 0 is 'at the median', not 'cheapest'", () => {
  const cohort = measureCohort("w|h|default|b", FREE);
  const free = scoreTrajectory(trajectory("free"), cohort);
  assert.equal(free.components.costNormalized, 1);
  assert.equal(free.components.latencyNormalized, 1);
  assert.equal(free.components.humanEffortSaved, 0);
  assert.equal(free.score, 0);
});

test("ORDINARY: two free runs in a free cohort are still told apart — by the ladder, which is the only thing that should", () => {
  const cohort = measureCohort("w|h|default|b", FREE);
  const passed = scoreTrajectory(trajectory("p", { pass: true }), cohort);
  const failed = scoreTrajectory(trajectory("f", { pass: false }), cohort);
  assert.equal(passed.score, DEFAULT_WEIGHTS.outcome, "0.6 × outcome 1, and nothing else");
  assert.equal(failed.score, 0);
  assert.ok(passed.score > failed.score);
});

test("ORDINARY: a PRICED cohort still pays a cheap run and refuses a dear one", () => {
  const cohort = measureCohort("w|h|default|b", PRICED);
  assert.ok(cohort.p50Cost > 0 && cohort.p50Wall > 0, "the premise: the medians are real numbers");
  const cheap = scoreTrajectory(trajectory("cheap", { costUsd: 0.0001, wallMs: 10 }), cohort);
  const dear = scoreTrajectory(trajectory("dear", { costUsd: 10, wallMs: 100_000 }), cohort);
  assert.ok(cheap.components.costNormalized < 0.01, "well under the median earns nearly the whole cost credit");
  assert.equal(dear.components.costNormalized, 1, "over the median earns none — unchanged");
  assert.ok(cheap.score > dear.score, `${cheap.score} > ${dear.score}`);
  // The gates term is 0 for both: this cohort raised no gates, so neither saved any.
  assert.equal(cheap.components.humanEffortSaved, 0);
  // With the gates term gone, a cheap run's score is exactly cost credit + latency credit.
  assert.ok(Math.abs(cheap.score - (DEFAULT_WEIGHTS.cost * (1 - cheap.components.costNormalized) + DEFAULT_WEIGHTS.latency * (1 - cheap.components.latencyNormalized))) < 1e-9);
});

test("ORDINARY: a GATED cohort still pays a run that raised fewer gates than its median", () => {
  const gated = Array.from({ length: 30 }, (_, i) => trajectory(`gated_${i}`, { gates: 1 + (i % 3) }));
  const cohort = measureCohort("w|h|default|b", gated);
  assert.equal(cohort.p50Gates, 2);
  const lighter = scoreTrajectory(trajectory("light", { gates: 1 }), cohort);
  const heavier = scoreTrajectory(trajectory("heavy", { gates: 4 }), cohort);
  assert.equal(lighter.components.humanEffortSaved, 0.5);
  assert.equal(heavier.components.humanEffortSaved, 0);
});

test("the cohort's own members still rank under the new rule — p90Score is a real bar, not 0.4 for everyone", () => {
  // At 95a3dde the free cohort's p90Score was 0.4 with every member tied at 0.4: the efficiency
  // credit was a constant paid to all, so the bar was cleared by anybody. Now it is 0 for a
  // cohort with no ladder, which `isGolden` condition 2 already refuses via `outcomeSpread`.
  const cohort = measureCohort("w|h|default|b", FREE);
  assert.equal(cohort.p90Score, 0);
  assert.equal(cohort.outcomeSpread, 0);
  // …and a free cohort WITH a ladder ranks on the ladder alone.
  const laddered = Array.from({ length: 30 }, (_, i) => trajectory(`l_${i}`, { pass: i % 3 === 0 }));
  const c2 = measureCohort("w|h|default|b", laddered);
  assert.equal(c2.p90Score, DEFAULT_WEIGHTS.outcome);
  assert.equal(c2.outcomeSpread, 1);
});

// ── the same rule one door up: `3-cost` and `4-latency` in the replayed gate ─────────────────

function report(over: Partial<EvalReport> = {}): EvalReport {
  return {
    suite: "s",
    suiteVersion: 1,
    suiteFrozenAt: 1_000,
    cases: [],
    passed: 10,
    total: 10,
    passRate: 1,
    mustPassFailures: [],
    totalCostUsd: 1,
    p95WallMs: 100,
    suiteValid: true,
    suiteIssues: [],
    budgets: {},
    ...over,
  };
}

const check = (v: ReturnType<typeof gateCandidate>, id: string) => {
  const c = v.checks.find((x) => x.id === id);
  assert.ok(c !== undefined, `no check ${id}`);
  return c;
};

test("A BASELINE THAT SPENT NOTHING DOES NOT MAKE A PAYING CANDIDATE FREE — `3-cost` refuses the unbounded ratio", () => {
  // Measured at 95a3dde: `cost ratio 1.00× (max 1.1×)`, PASS, promote true.
  const v = gateCandidate({
    baseline: report({ totalCostUsd: 0 }),
    candidate: report({ totalCostUsd: 100 }),
    postureDiffNonNegative: true,
    deterministic: true,
  });
  const c = check(v, "3-cost");
  assert.equal(c.pass, false, c.detail);
  assert.match(c.detail, /unbounded/);
  assert.match(c.detail, /\$0/);
  assert.equal(v.promote, false);
});

test("…and `4-latency` refuses a baseline p95 of 0 ms against a candidate that took time", () => {
  const v = gateCandidate({
    baseline: report({ p95WallMs: 0 }),
    candidate: report({ p95WallMs: 100_000 }),
    postureDiffNonNegative: true,
    deterministic: true,
  });
  const c = check(v, "4-latency");
  assert.equal(c.pass, false, c.detail);
  assert.match(c.detail, /unbounded/);
  assert.equal(v.promote, false);
});

test("ORDINARY: two sides that both spent nothing tie at 1.00× and promote — a replayed function-only suite", () => {
  const v = gateCandidate({
    baseline: report({ totalCostUsd: 0, p95WallMs: 0 }),
    candidate: report({ totalCostUsd: 0, p95WallMs: 0 }),
    postureDiffNonNegative: true,
    deterministic: true,
  });
  assert.equal(check(v, "3-cost").pass, true);
  assert.match(check(v, "3-cost").detail, /1\.00×/);
  assert.equal(check(v, "4-latency").pass, true);
  assert.equal(v.promote, true);
});

test("ORDINARY: a priced baseline is divided as before", () => {
  const v = gateCandidate({
    baseline: report({ totalCostUsd: 1, p95WallMs: 100 }),
    candidate: report({ totalCostUsd: 1.05, p95WallMs: 110 }),
    postureDiffNonNegative: true,
    deterministic: true,
  });
  assert.match(check(v, "3-cost").detail, /1\.05×/);
  assert.match(check(v, "4-latency").detail, /1\.10×/);
  assert.equal(v.promote, true);
});

// ── the measurement behind `didWork`'s corrected docstring ──────────────────────────────────

test("`scoreTrajectory` DOES compare across cohorts — a trivial graph scored against another graph's cohort is not refused", () => {
  // `didWork`'s docstring used to say "the cross-cohort comparison this predicate would have to
  // corrupt does not exist". It exists twice: here, because `scoreTrajectory` checks only the
  // weights digest and never that `t` belongs to `cohort`; and in `promoteAgainstCohort`, which
  // is that call with the candidate's trajectory and the baseline's cohort.
  const baseline = Array.from({ length: 30 }, (_, i) => trajectory(`b_${i}`, { graphHash: "A", costUsd: 0.01, wallMs: 1000, pass: i % 2 === 0 }));
  const cohort = measureCohort("w|A|default|b", baseline);
  const trivial = trajectory("trivial", { graphHash: "B", pass: true });
  assert.notEqual(cohortKeyOf(trivial), cohort.key, "the premise: two different cohorts");
  const s = scoreTrajectory(trivial, cohort);
  assert.equal(s.components.delivered, true, "one committed channel is work, by the predicate's own rule");
  assert.ok(s.score > cohort.p90Score, `${s.score} beats the other graph's p90 ${cohort.p90Score}`);
});
