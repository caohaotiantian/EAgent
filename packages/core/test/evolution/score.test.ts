/**
 * What the self-improvement metric must never reward.
 *
 * A number a system optimises against is a target, and this one had a dominant strategy that
 * had nothing to do with doing the work: **fail immediately.** A run that died on its first
 * turn paid no cost and no latency, so it banked the whole 0.4 of efficiency and human-effort
 * credit while an identical successful run — which actually spent the cohort median — banked
 * 0.1. CLAUDE.md asks for a measurement that cannot be gamed by the thing being measured, so
 * these are the claims that say it no longer is:
 *
 * | Claim | The gaming move it closes |
 * |---|---|
 * | A non-succeeded run scores 0 | Fail fast, collect the cheapness credit |
 * | Cheapness is credit for work DELIVERED | Reach the last node having produced nothing, look efficient |
 * | A cohort is measured over its successes THAT DID WORK | Pad the cohort to lower the p90 golden bar |
 *
 * AND THE CLAIM ON THE OTHER SIDE OF THAT LINE, which is why the last two rows say "work" and
 * not "signal". Gating the efficiency terms on a weighted SIGNAL made the score a constant 0.1
 * for every succeeded run in a workflow with no assertion, gate or rubric node — the shape
 * `agent()` builds — so the metric could not tell a $10 run from a $0.0001 one and `isGolden`
 * condition 2 was vacuous, every member tying the bar. A metric that has stopped discriminating
 * is not safe, it is just useless; "no ground truth was available" and "nothing was delivered"
 * are different facts. `A NO-SIGNAL COHORT STILL RANKS ITS MEMBERS` is that claim, and it is
 * checked in the same file as the one it trades against so neither can be restored alone.
 *
 * `trajectory.test.ts` holds the fold-side half — that the spend behind these numbers is
 * counted once and that wall time survives a failure. `run/projection-usage.test.ts` holds the
 * same fold for the projection, where the number is a BUDGET rather than a score.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "../../src/canonical.ts";
import {
  DEFAULT_WEIGHTS,
  isGolden,
  measureCohort,
  scoreTrajectory,
  type CohortStats,
} from "../../src/evolution/score.ts";
import type { OutcomeSignals, Trajectory } from "../../src/evolution/trajectory.ts";
import type { NodeId, RunId } from "../../src/ids.ts";

const n = (id: string): NodeId => id as NodeId;

const signals = (over: Partial<OutcomeSignals> = {}): OutcomeSignals => ({
  assertions: [],
  humanDecisions: [],
  rubrics: [],
  selfReported: false,
  runStatus: "succeeded",
  ...over,
});

function trajectory(over: Partial<Trajectory> = {}): Trajectory {
  return {
    runId: "run_1" as RunId,
    graphHash: "h",
    cohort: { workflow: "w", graphHash: "h", tenantTier: "default", inputBucket: "b" },
    steps: [],
    outcome: signals(),
    usage: { costUsd: 0.001, tokens: 150, wallMs: 250, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 },
    policy: { escalations: [], violations: 0, gatesRaised: 0 },
    inputDigest: digest({}),
    fromUnpromotedCandidate: false,
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
  weightsDigest: digest(DEFAULT_WEIGHTS),
  ...over,
});

// ── the floor ────────────────────────────────────────────────────────────────

test("A FAILED RUN SCORES STRICTLY BELOW AN OTHERWISE-IDENTICAL SUCCEEDED ONE", () => {
  // Identical in every field the scorer reads — same passing assertion, same spend, same
  // wall time, same gates. Only the terminal status differs, and that alone must decide.
  const evidence = { assertions: [{ nodeId: n("verify"), pass: true }] };
  const succeeded = trajectory({ outcome: signals({ ...evidence, runStatus: "succeeded" }) });
  const failed = trajectory({ outcome: signals({ ...evidence, runStatus: "failed" }) });

  const c = cohort();
  const s = scoreTrajectory(succeeded, c);
  const f = scoreTrajectory(failed, c);

  assert.ok(s.score > 0, `the control has to be positive, got ${s.score}`);
  assert.ok(f.score < s.score, `failed ${f.score} must be below succeeded ${s.score}`);
  assert.equal(f.score, 0, "a run that did not finish has no score to defend");
  assert.equal(f.outcome, 0, "…and no outcome either, so isGolden condition 1 rejects it");
});

test("FAILING FAST BUYS NO CHEAPNESS CREDIT — the audit's own fixture", () => {
  // The exact shape the audit measured at 0.400 vs 0.100: a run that dies before spending
  // anything used to out-earn one that spent the cohort median and finished.
  const c = cohort();
  const succeeded = scoreTrajectory(
    trajectory({ usage: { costUsd: 0.001, tokens: 150, wallMs: 250, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 } }),
    c,
  );
  const failed = scoreTrajectory(
    trajectory({
      outcome: signals({ runStatus: "failed" }),
      usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 0, toolCalls: 0 , subgraphRuns: 0 },
    }),
    c,
  );

  assert.equal(succeeded.score, 0.1);
  assert.equal(failed.score, 0, "spending nothing is not efficiency when nothing was delivered");
  assert.equal(failed.components.completed, false);
  assert.equal(succeeded.components.completed, true);
});

test("cancelled and incomplete are not success either, and an unterminated journal fails closed", () => {
  const c = cohort();
  for (const runStatus of ["failed", "cancelled", "incomplete"] as const) {
    const scored = scoreTrajectory(trajectory({ outcome: signals({ runStatus }) }), c);
    assert.equal(scored.score, 0, `${runStatus} must not score`);
  }
  assert.ok(scoreTrajectory(trajectory(), c).score > 0, "…and `succeeded` still does");
});

test("a failed run is never golden, whatever evidence it collected before it died", () => {
  // A run can pass an assertion and then die. Condition 1 reads the run's outcome, not the
  // signals' — so the corpus never learns from a strategy that did not survive.
  const t = trajectory({
    outcome: signals({ assertions: [{ nodeId: n("verify"), pass: true }], runStatus: "failed" }),
  });
  const c = cohort({ p90Score: 0 });
  const v = isGolden(t, scoreTrajectory(t, c), c);
  assert.equal(v.golden, false);
  assert.equal(v.conditions.find((x) => x.id === 1)?.pass, false);
});

// ── cheapness is credit for work DELIVERED ──────────────────────────────────

test("A NO-OP SUCCESS BUYS NO CHEAPNESS CREDIT EITHER — 0.400 was the second half of the move", () => {
  // The floor closed "fail fast"; this closes "finish having done nothing". Measured on the
  // tree that had the floor and not this: the no-op success banked 0.400 while a real success
  // spending the cohort median banked 0.100 — the same reward for not working, wearing
  // terminal success as a disguise.
  const c = cohort();
  const noop = scoreTrajectory(
    trajectory({ usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 0, toolCalls: 0 , subgraphRuns: 0 } }),
    c,
  );
  const real = scoreTrajectory(
    trajectory({ outcome: signals({ assertions: [{ nodeId: n("verify"), pass: true }] }) }),
    c,
  );

  assert.equal(noop.components.completed, true, "control: it did reach terminal success");
  assert.equal(noop.components.delivered, false, "…and did no work — no model call, no tool call, no verdict");
  assert.equal(noop.components.costNormalized, 0, "control: it really was free — the credit is refused, not unearned");
  // 0, not 0.1. The human-effort term goes with the rest, because "raised no gates" is
  // precisely the claim a run that did nothing can make most easily, and leaving it behind
  // gave the no-op a floor that a real run spending the median could only tie.
  assert.equal(noop.score, 0, "a run that did nothing is not a cheap instance of the work — it is its absence");
  assert.ok(real.score > noop.score, `real ${real.score} must beat the no-op ${noop.score}`);
});

test("A NO-SIGNAL COHORT STILL RANKS ITS MEMBERS — the over-correction, and the property it broke", () => {
  // Gating the efficiency terms on a weighted SIGNAL rather than on WORK made this whole
  // cohort score a constant. Measured on this tree with that gate in place: p90Score 0.100,
  // and every one of $0.0001, $0.015 and $10.00 scoring 0.100.
  //
  // 30 succeeded runs, one model call each, no evaluator/gate/rubric node anywhere — the shape
  // `agent()` produces. Cost $0.001…$0.030 (p50 $0.015), wall 100…3000 ms (p50 1500).
  const members = Array.from({ length: 30 }, (_, i) =>
    trajectory({
      runId: `run_${i}` as RunId,
      usage: { costUsd: (i + 1) / 1000, tokens: 100, wallMs: (i + 1) * 100, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 },
    }),
  );
  const c = measureCohort("w|h|default|b", members);
  assert.equal(c.n, 30, "control: they are all members");
  assert.equal(c.p50Cost, 0.015);
  assert.equal(c.p50Wall, 1500);

  const at = (costUsd: number, wallMs: number) =>
    scoreTrajectory(trajectory({ usage: { costUsd, tokens: 100, wallMs, modelCalls: 1, toolCalls: 0, subgraphRuns: 0 } }), c).score;
  const cheap = at(0.0001, 10);
  const dear = at(10, 100_000);

  assert.ok(cheap > dear, `a cheap real success ${cheap} must out-score an expensive one ${dear}`);
  assert.ok(c.p90Score > 0, `the golden bar must be clearable-or-not, not tied by everyone (p90 ${c.p90Score})`);
  assert.ok(
    dear < c.p90Score,
    `condition 2 must be able to REFUSE somebody: dear ${dear} vs p90 ${c.p90Score}`,
  );

  // …and the no-op is still below every one of them, in the same cohort, at the same time.
  const noop = scoreTrajectory(
    trajectory({ usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 0, toolCalls: 0 , subgraphRuns: 0 } }),
    c,
  );
  assert.equal(noop.score, 0);
  assert.ok(noop.score < dear, "the cheapest possible no-op still loses to the dearest real run");
});

test("A NO-OP SUCCESS CANNOT MOVE THE RULER EITHER — it is not a cohort member", () => {
  // The padding move, in its most effective form. A no-op costs $0 and scores 0, so leaving it
  // in the population drags BOTH the median an honest run is priced against and the p90 bar
  // `isGolden` condition 2 has to clear. Measured on this tree with the membership filter
  // reading `runStatus` alone: p50Cost $0.015 → $0.008 and p90Score 0.340 → 0.213.
  const members = Array.from({ length: 30 }, (_, i) =>
    trajectory({
      runId: `run_${i}` as RunId,
      usage: { costUsd: (i + 1) / 1000, tokens: 100, wallMs: (i + 1) * 100, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 },
    }),
  );
  const noops = Array.from({ length: 15 }, (_, i) =>
    trajectory({
      runId: `noop_${i}` as RunId,
      usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 0, toolCalls: 0 , subgraphRuns: 0 },
    }),
  );
  const clean = measureCohort("w|h|default|b", members);
  const padded = measureCohort("w|h|default|b", [...members, ...noops]);

  assert.equal(padded.n, clean.n, "the no-ops are not counted toward MIN_COHORT_SIZE either");
  assert.equal(padded.p50Cost, clean.p50Cost);
  assert.equal(padded.p50Wall, clean.p50Wall);
  assert.equal(padded.p90Score, clean.p90Score, "the promotion bar did not move");
});

test("delivering something CHEAP still earns the credit — this gates on evidence, not on thrift", () => {
  // The other side of the same line: the gate must not punish a run for being cheap, only for
  // having nothing to be cheap ABOUT.
  const c = cohort();
  const evidence = signals({ assertions: [{ nodeId: n("verify"), pass: true }] });
  const cheap = scoreTrajectory(
    trajectory({ outcome: evidence, usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 } }),
    c,
  );
  const median = scoreTrajectory(trajectory({ outcome: evidence }), c);

  assert.equal(cheap.components.delivered, true);
  assert.equal(cheap.score, 1, "outcome 0.6 + cost 0.2 + latency 0.1 + human effort 0.1");
  assert.ok(cheap.score > median.score, "cheaper is still better, given both delivered");
});

test("SELF-REPORT IS NOT DELIVERY — S5 weighs zero, so it cannot buy the credit back", () => {
  // "Task complete" is the classic reward-hacking surface, and a gate that read
  // `signals.length > 0` would have handed it the 0.3 the floor just took away.
  const c = cohort();
  const claimed = scoreTrajectory(
    trajectory({
      outcome: signals({ selfReported: true }),
      usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 0, toolCalls: 0 , subgraphRuns: 0 },
    }),
    c,
  );

  assert.equal(claimed.signals.some((x) => x.id === "S5"), true, "control: the claim IS recorded");
  assert.equal(claimed.components.delivered, false, "…and it is worth nothing");
  assert.equal(claimed.score, 0);

  // The other half, which the work gate makes checkable: a run that DID work and also said so
  // scores exactly what it would have scored in silence. S5 is recorded, and it is worth 0 —
  // it neither buys the efficiency credit nor moves the outcome.
  const worked = { costUsd: 0.0005, tokens: 10, wallMs: 100, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 };
  const boasted = scoreTrajectory(trajectory({ outcome: signals({ selfReported: true }), usage: worked }), c);
  const silent = scoreTrajectory(trajectory({ outcome: signals(), usage: worked }), c);
  assert.equal(boasted.components.delivered, true, "control: it really did work");
  assert.equal(boasted.score, silent.score, "saying 'done' changed nothing");
});

test("a RUBRIC verdict counts as delivery — there was output for a judge to read", () => {
  // Deliberately weaker than requiring ground truth: S4-only work is still work, and the
  // ground-truth requirement already lives in isGolden condition 1 and promotionCeiling.
  const c = cohort();
  const t = trajectory({
    outcome: signals({ rubrics: [{ nodeId: n("judge"), score: 0.9, pass: true }] }),
    usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 },
  });
  const judged = scoreTrajectory(t, c);

  assert.equal(judged.components.delivered, true);
  assert.ok(judged.score > 0.1, `rubric-graded work outscores a no-op, got ${judged.score}`);
  const v = isGolden(t, judged, cohort({ p90Score: 0 }));
  assert.equal(v.golden, false, "…and still never golden on S4 alone");
  assert.equal(v.conditions.find((x) => x.id === 1)?.pass, false);
});

// ── the cohort is a population of comparable runs ────────────────────────────

test("A COHORT IS MEASURED OVER ITS SUCCESSES — failures cannot lower the golden bar", () => {
  // The second gaming move: leave the score alone and move the ruler. Thirty cheap failures
  // next to thirty real runs drag p50Cost and p50Wall down (so honest runs read as
  // expensive) and drag p90Score down (so the promotion bar falls to meet a mediocre run).
  const succeeded = Array.from({ length: 30 }, (_, i) =>
    trajectory({
      runId: `ok_${i}` as RunId,
      usage: { costUsd: 0.001 * (i + 1), tokens: 100, wallMs: 100 * (i + 1), modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 },
      outcome: signals({ assertions: [{ nodeId: n("v"), pass: i % 2 === 0 }] }),
    }),
  );
  const failures = Array.from({ length: 30 }, (_, i) =>
    trajectory({
      runId: `bad_${i}` as RunId,
      usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 0, toolCalls: 0 , subgraphRuns: 0 },
      outcome: signals({ runStatus: "failed" }),
    }),
  );

  const clean = measureCohort("k", succeeded);
  const padded = measureCohort("k", [...succeeded, ...failures]);

  assert.deepEqual(padded, clean, "adding thirty failures must not move a single statistic");
  assert.equal(padded.n, 30, "n counts comparable runs, not journal rows");
  assert.ok(padded.p90Score > 0);
});

test("a cohort of nothing but failures measures nothing, and n = 0 blocks golden", () => {
  const c = measureCohort("k", Array.from({ length: 40 }, (_, i) =>
    trajectory({ runId: `bad_${i}` as RunId, outcome: signals({ runStatus: "failed" }) })));
  assert.equal(c.n, 0);
  assert.equal(c.p90Score, 0);
  const t = trajectory({ outcome: signals({ assertions: [{ nodeId: n("v"), pass: true }] }) });
  assert.equal(isGolden(t, scoreTrajectory(t, c), c).conditions.find((x) => x.id === 4)?.pass, false);
});
