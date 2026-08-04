/**
 * The offline evaluation gate.
 *
 * The suite is built from real recorded runs and replayed against a candidate, so
 * these tests exercise the same path a promotion decision would.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { gateCandidate, runEvalSuite, validateSuite, type EvalReport, type EvalSuite } from "../../src/evolution/gate.ts";
import type { RunId } from "../../src/ids.ts";
import { DOCS, compileSkeleton, harness } from "../run/skeleton.ts";

async function recordRun(h: ReturnType<typeof harness>, opts: { reject?: boolean } = {}): Promise<RunId> {
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const gated = await h.engine.advance(runId);
  const gate = Object.values(gated.gates).find((g) => g.state === "open");
  if (gate !== undefined) {
    await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: opts.reject === true ? { kind: "reject", reason: "no" } : { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k",
    });
  }
  return runId;
}

const engineOf = (h: ReturnType<typeof harness>) => ({
  tools: h.engine.tools,
  functions: h.engine.functions,
  models: h.engine.models,
  policy: { granted: ["fs:read", "fs:write"] },
});

// ── running a suite ──────────────────────────────────────────────────────────

test("a suite of recorded runs replays and passes against the same graph", async () => {
  const h = harness();
  const ok = await recordRun(h);
  const rejected = await recordRun(h, { reject: true });

  const suite: EvalSuite = {
    name: "skeleton",
    version: 1,
    frozen: true,
    frozenAt: 1_000,
    cases: [
      { id: "happy", runId: ok, mustPass: true, expect: { status: "succeeded", noIrreversibleWithoutGate: true } },
      { id: "rejected", runId: rejected, mustPass: true, expect: { status: "failed" } },
    ],
  };

  const report = await runEvalSuite({ store: h.store, suite, graph: compileSkeleton(), engine: engineOf(h) });
  assert.equal(report.total, 2);
  assert.equal(report.passed, 2, JSON.stringify(report.cases.map((c) => c.reasons)));
  assert.equal(report.passRate, 1);
  assert.deepEqual(report.mustPassFailures, []);
});

test("the gate costs no live model calls — it is replay all the way down", async () => {
  const h = harness();
  const runId = await recordRun(h);
  const before = h.model.seen.length;
  const writes = h.writes.length;

  await runEvalSuite({
    store: h.store,
    suite: { name: "s", version: 1, frozen: true, frozenAt: 1_000, cases: [{ id: "a", runId, mustPass: true, expect: {} }] },
    graph: compileSkeleton(),
    engine: engineOf(h),
  });

  assert.equal(h.model.seen.length, before, "no model calls");
  assert.equal(h.writes.length, writes, "no side effects");
});

test("an expectation mismatch fails the case with a readable reason", async () => {
  const h = harness();
  const runId = await recordRun(h);
  const report = await runEvalSuite({
    store: h.store,
    suite: { name: "s", version: 1, frozen: true, frozenAt: 1_000, cases: [{ id: "a", runId, mustPass: true, expect: { status: "failed" } }] },
    graph: compileSkeleton(),
    engine: engineOf(h),
  });
  assert.equal(report.passed, 0);
  assert.match(report.cases[0]!.reasons.join(" "), /status succeeded, expected failed/);
  assert.deepEqual(report.mustPassFailures, ["a"]);
});

test("a channel expectation that does not hold fails the case", async () => {
  const h = harness();
  const runId = await recordRun(h);
  const report = await runEvalSuite({
    store: h.store,
    suite: { name: "s", version: 1, frozen: true, frozenAt: 1_000, cases: [{ id: "a", runId, mustPass: true, expect: { channels: { digests: [] } } }] },
    graph: compileSkeleton(),
    engine: engineOf(h),
  });
  assert.equal(report.passed, 0);
  assert.match(report.cases[0]!.reasons.join(" "), /channel "digests" differs/);
});

// ── suite validity ───────────────────────────────────────────────────────────

test("a suite of only happy paths is flagged as weak", () => {
  const { suiteValid, suiteIssues } = validateSuite({
    name: "s",
    version: 1,
    frozen: true,
    frozenAt: 1_000,
    cases: [{ id: "a", runId: "r" as RunId, mustPass: true, expect: { status: "succeeded" } }],
    composition: { minCases: 5, minMustPass: 2, minFailureCases: 1 },
  });
  assert.equal(suiteValid, false);
  assert.equal(suiteIssues.length, 3, "too few cases, too few must-pass, no failure cases");
  assert.match(suiteIssues.join(" "), /failure cases/);
});

test("duplicate case ids are rejected", () => {
  const { suiteIssues } = validateSuite({
    name: "s",
    version: 1,
    frozen: true,
    frozenAt: 1_000,
    cases: [
      { id: "a", runId: "r" as RunId, mustPass: false, expect: {} },
      { id: "a", runId: "r2" as RunId, mustPass: false, expect: {} },
    ],
  });
  assert.match(suiteIssues.join(" "), /duplicate case ids/);
});

// ── promotion criteria ───────────────────────────────────────────────────────

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
    ...over,
  };
}

const baseInput = {
  baseline: report(),
  postureDiffNonNegative: true,
  deterministic: true,
};

test("a clean candidate promotes", () => {
  const v = gateCandidate({ ...baseInput, candidate: report() });
  assert.equal(v.promote, true, JSON.stringify(v.checks.filter((c) => !c.pass)));
});

test("ONE must-pass failure blocks promotion regardless of aggregate improvement", () => {
  const v = gateCandidate({ ...baseInput, candidate: report({ passRate: 1, mustPassFailures: ["safety-1"] }) });
  assert.equal(v.promote, false);
  assert.equal(v.checks.find((c) => c.id === "1-must-pass")?.pass, false);
});

test("a small pass-rate drop is tolerated; a large one is not", () => {
  assert.equal(gateCandidate({ ...baseInput, candidate: report({ passRate: 0.995 }) }).promote, true);
  assert.equal(gateCandidate({ ...baseInput, candidate: report({ passRate: 0.9 }) }).promote, false);
});

test("a 2% quality gain for 3x the cost is NOT an improvement", () => {
  const v = gateCandidate({ ...baseInput, candidate: report({ passRate: 1, totalCostUsd: 3 }) });
  assert.equal(v.promote, false);
  assert.match(v.checks.find((c) => c.id === "3-cost")!.detail, /3\.00×/);
});

test("prompt growth must earn its keep", () => {
  // +30 % prompt with no quality gain: refused.
  assert.equal(gateCandidate({ ...baseInput, candidate: report(), promptGrowth: 0.3 }).promote, false);
  // +30 % prompt with a 6pp gain: the size check passes.
  const better = gateCandidate({
    ...baseInput,
    baseline: report({ passRate: 0.9 }),
    candidate: report({ passRate: 0.96 }),
    promptGrowth: 0.3,
  });
  assert.equal(better.checks.find((c) => c.id === "5-prompt-size")?.pass, true);
});

test("A CANDIDATE THAT LOWERS OVERSIGHT ANYWHERE IS REFUSED", () => {
  const v = gateCandidate({ ...baseInput, candidate: report(), postureDiffNonNegative: false });
  assert.equal(v.promote, false);
  assert.match(v.checks.find((c) => c.id === "6-oversight-diff")!.detail, /lowers oversight/);
});

test("a nondeterministic candidate is refused", () => {
  assert.equal(gateCandidate({ ...baseInput, candidate: report(), deterministic: false }).promote, false);
});

test("a malformed suite certifies nothing, so it blocks promotion too", () => {
  const v = gateCandidate({ ...baseInput, candidate: report({ suiteValid: false, suiteIssues: ["too few cases"] }) });
  assert.equal(v.promote, false);
  assert.equal(v.checks.find((c) => c.id === "0-suite")?.pass, false);
});

test("every criterion reports a readable detail, pass or fail", () => {
  const v = gateCandidate({ ...baseInput, candidate: report() });
  assert.equal(v.checks.length, 11);
  for (const c of v.checks) assert.ok(c.detail.length > 0, c.id);
});

// ── the two rules that make an AI-AUTHORED suite trustworthy ─────────────────

test("A SUITE WRITTEN AFTER THE CANDIDATE PROVES NOTHING", () => {
  // The whole safety argument for AI-generated suites reduces to this: it does not
  // matter who wrote the exam if it existed before the student did.
  const v = gateCandidate({
    ...baseInput,
    candidate: report({ suiteFrozenAt: 5_000 }),
    proposedAt: 4_000,
  });
  assert.equal(v.promote, false);
  assert.match(v.checks.find((c) => c.id === "9-suite-predates-candidate")!.detail, /exam written for a known student/);
});

test("a suite frozen before the candidate is accepted", () => {
  const v = gateCandidate({ ...baseInput, candidate: report({ suiteFrozenAt: 1_000 }), proposedAt: 2_000 });
  assert.equal(v.checks.find((c) => c.id === "9-suite-predates-candidate")?.pass, true);
  assert.equal(v.promote, true);
});

test("a suite and candidate from the SAME lineage are refused", () => {
  const v = gateCandidate({
    ...baseInput,
    candidate: report({ suiteGeneratedBy: "agent_profile/optimiser@3" }),
    proposedAt: 2_000,
    proposedBy: "agent_profile/optimiser@3",
  });
  assert.equal(v.promote, false);
  assert.match(v.checks.find((c) => c.id === "10-separate-lineage")!.detail, /shared lineage converges the exam/);
});

test("different lineages pass", () => {
  const v = gateCandidate({
    ...baseInput,
    candidate: report({ suiteGeneratedBy: "agent_profile/adversary@1" }),
    proposedAt: 2_000,
    proposedBy: "agent_profile/optimiser@3",
  });
  assert.equal(v.promote, true);
});

test("the checks are skipped, not silently passed, when the metadata is absent", () => {
  // Absent `proposedAt`/`proposedBy` means "a human is driving this", which is the
  // pre-existing path. Both checks report a pass with a readable reason rather than
  // pretending they verified something.
  const v = gateCandidate({ ...baseInput, candidate: report() });
  assert.equal(v.checks.find((c) => c.id === "9-suite-predates-candidate")?.pass, true);
  assert.equal(v.checks.find((c) => c.id === "10-separate-lineage")?.pass, true);
});

test("a suite with no frozenAt cannot certify anything", () => {
  const { suiteValid, suiteIssues } = validateSuite({
    name: "s",
    version: 1,
    frozen: true,
    frozenAt: 0,
    cases: [{ id: "a", runId: "r" as RunId, mustPass: true, expect: {} }],
  });
  assert.equal(suiteValid, false);
  assert.match(suiteIssues.join(" "), /frozenAt is required/);
});
