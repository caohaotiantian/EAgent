/**
 * The two checks the replayed gate gained, and the one type it stopped lying about.
 *
 * `12-grader-unchanged` refuses audit reproduction 2 — a candidate whose only change is swapping
 * its evaluator's body — on a workflow with no attested exam, and is SKIPPED with its reason once
 * one exists (the exam grades; the in-graph evaluator decides nothing). `13-replay-verified`
 * refuses a case whose replay served a tool result whose recording carries no `argsDigest` to a
 * different graph, and REPORTS (without refusing) the seeds it derived for nodes the recording
 * never ran. `CaseResult.replay` is optional and absent on a failed
 * replay, so a consumer reading it on such a case gets `undefined` and not a `TypeError`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { gateCandidate, runEvalSuite, type CaseResult, type EvalReport } from "../../src/evolution/gate.ts";
import type { ReplayReport } from "../../src/run/replay.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { compileSkeleton } from "../run/skeleton.ts";

const CHECK = { kind: "assertion" as const, ref: "function/check@stable", digest: "sha256:check", reads: ["items", "picked"] };
const RIGGED = { kind: "assertion" as const, ref: "function/check-rigged@stable", digest: "sha256:rigged", reads: ["items", "picked"] };

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
    evaluators: { "node:check": CHECK },
    ...over,
  };
}

const input = (candidate: EvalReport, over: Partial<Parameters<typeof gateCandidate>[0]> = {}): Parameters<typeof gateCandidate>[0] => ({
  baseline: report(),
  candidate,
  postureDiffNonNegative: true,
  deterministic: true,
  ...over,
});

const check = (v: ReturnType<typeof gateCandidate>, id: string) => {
  const c = v.checks.find((x) => x.id === id);
  assert.ok(c !== undefined, `no check ${id}`);
  return c;
};

// ── 12-grader-unchanged ──────────────────────────────────────────────────────

test("AUDIT REPRO 2 IS REFUSED: a candidate whose only change is its grader's body fails 12-grader-unchanged", () => {
  const v = gateCandidate(input(report({ evaluators: { "node:check": RIGGED } })));
  assert.equal(v.promote, false);
  const c = check(v, "12-grader-unchanged");
  assert.equal(c.pass, false);
  assert.match(c.detail, /node:check function\/check@stable → function\/check-rigged@stable/);
  assert.match(c.detail, /loom exam attest/, "the refusal names the human act that is the way through");
  // Everything else is green — the shape the audit drove: identical work, identical ratios.
  assert.deepEqual(v.checks.filter((x) => !x.pass).map((x) => x.id), ["12-grader-unchanged"]);
});

test("the same ref with a different resolved body is a grader change too", () => {
  const v = gateCandidate(input(report({ evaluators: { "node:check": { ...CHECK, digest: "sha256:edited" } } })));
  assert.match(check(v, "12-grader-unchanged").detail, /body sha256:check → sha256:edited/);
});

test("an ADDED evaluator is a change — an always-pass addition would inflate k/n in loom score", () => {
  const v = gateCandidate(input(report({ evaluators: { "node:check": CHECK, "node:lgtm": RIGGED } })));
  assert.equal(check(v, "12-grader-unchanged").pass, false);
  assert.match(check(v, "12-grader-unchanged").detail, /node:lgtm added/);
});

test("a REMOVED evaluator and a changed `reads` are changes", () => {
  assert.match(check(gateCandidate(input(report({ evaluators: {} }))), "12-grader-unchanged").detail, /node:check removed/);
  const v = gateCandidate(input(report({ evaluators: { "node:check": { ...CHECK, reads: ["items"] } } })));
  assert.match(check(v, "12-grader-unchanged").detail, /reads \[items,picked\] → \[items\]/);
});

test("THE CONTROL: an unchanged evaluator set passes, and the honest function-body candidate is untouched", () => {
  const v = gateCandidate(input(report()));
  assert.equal(check(v, "12-grader-unchanged").pass, true);
  assert.match(check(v, "12-grader-unchanged").detail, /unchanged \(1 evaluator node\(s\)\)/);
  assert.equal(v.promote, true);
});

test("WHERE AN EXAM IS ATTESTED THE CHECK IS SKIPPED AND SAYS SO — strengthening the grader is no longer refused", () => {
  const v = gateCandidate(input(report({ evaluators: { "node:check": RIGGED } }), { examAttested: true }));
  const c = check(v, "12-grader-unchanged");
  assert.equal(c.pass, true);
  assert.match(c.detail, /skipped: this workflow has an operator-attested exam/);
});

test("`examAttested` absent means NOT attested — omission does not loosen", () => {
  const v = gateCandidate(input(report({ evaluators: { "node:check": RIGGED } })));
  assert.equal(check(v, "12-grader-unchanged").pass, false);
  const explicit = gateCandidate(input(report({ evaluators: { "node:check": RIGGED } }), { examAttested: false }));
  assert.equal(check(explicit, "12-grader-unchanged").pass, false);
});

test("a report that does not state its evaluators cannot be compared, and fails closed", () => {
  const { evaluators: _absent, ...withoutEvaluators } = report();
  const v = gateCandidate(input(withoutEvaluators as unknown as EvalReport));
  assert.equal(check(v, "12-grader-unchanged").pass, false);
  assert.match(check(v, "12-grader-unchanged").detail, /fails closed/);
  const nulled = gateCandidate(input(report({ evaluators: null as unknown as EvalReport["evaluators"] })));
  assert.equal(check(nulled, "12-grader-unchanged").pass, false, "null walks past an undefined test; it must not walk past this one");
});

// ── 13-replay-verified ───────────────────────────────────────────────────────

/** A replay report with only the fields check 13 reads; everything else is a stub. */
function replay(over: { derivedSeeds?: string[]; unverifiedToolEffects?: string[]; graphMatch?: boolean }): ReplayReport {
  return {
    derivedSeeds: over.derivedSeeds ?? [],
    unverifiedToolEffects: over.unverifiedToolEffects ?? [],
    graph: { recorded: "sha256:a", replayed: over.graphMatch === false ? "sha256:b" : "sha256:a", match: over.graphMatch !== false },
  } as unknown as ReplayReport;
}

const kase = (id: string, r: ReplayReport | undefined): CaseResult => ({
  id,
  pass: true,
  mustPass: false,
  reasons: [],
  costUsd: 0,
  wallMs: 0,
  ...(r === undefined ? {} : { replay: r }),
});

test("A DERIVED SEED IS REPORTED, NOT REFUSED — it is what every added body with randomness gets", () => {
  // Every entry in `derivedSeeds` belongs to a node the recording never ran (a recorded body with
  // no seed is E_REPLAY_DIVERGENCE before it reaches the gate), so refusing on it would refuse the
  // mutation operator's one shape. The count is on the page instead.
  const v = gateCandidate(input(report({ cases: [kase("c0", replay({ derivedSeeds: ["extra@root#0:random:0"], graphMatch: false }))] })));
  const c = check(v, "13-replay-verified");
  assert.equal(c.pass, true);
  assert.match(c.detail, /1 seed\(s\) for node\(s\) the recording never ran were derived/);
  assert.equal(v.promote, true);
});

test("a recorded tool effect with no argsDigest is unverifiable against a DIFFERENT graph — and exempt on the same one", () => {
  // Reachable only on a journal written before `tool.called.argsDigest` existed (2026-08-27), so
  // no in-tree recording can drive it; the report is hand-built for that reason.
  const different = gateCandidate(input(report({ cases: [kase("c0", replay({ unverifiedToolEffects: ["write@root#0:tool:0"], graphMatch: false }))] })));
  assert.equal(check(different, "13-replay-verified").pass, false);
  assert.match(check(different, "13-replay-verified").detail, /carry no argsDigest/);
  const same = gateCandidate(input(report({ cases: [kase("c0", replay({ unverifiedToolEffects: ["write@root#0:tool:0"], graphMatch: true }))] })));
  assert.equal(check(same, "13-replay-verified").pass, true, "nothing could have changed the call on the recorded graph");
});

test("a case with no replay at all (the replay failed) is not a verified case either, and is not a crash here", () => {
  // `pass: false` with `reasons` is what `runCase` produces; check 13 has nothing to read and says
  // nothing about it — `1-must-pass` and `2-non-inferior` carry that case's failure.
  const v = gateCandidate(input(report({ cases: [kase("c0", undefined)] })));
  assert.equal(check(v, "13-replay-verified").pass, true);
});

test("every check reports, and there are fifteen of them", () => {
  const v = gateCandidate(input(report()));
  assert.equal(v.checks.length, 15);
  assert.deepEqual(
    [...v.checks.map((c) => c.id)].sort(),
    ["0-suite", "1-must-pass", "10-separate-lineage", "11-budget-exercised", "12-grader-unchanged", "13-replay-verified", "2-non-inferior", "2a-candidate-earned-it", "3-cost", "4-latency", "5-prompt-size", "6-oversight-diff", "7-safety", "8-determinism", "9-suite-predates-candidate"],
  );
});

// ── CaseResult.replay is optional, and absent on a failed replay ─────────────

test("A FAILED REPLAY LEAVES `replay` ABSENT — the type no longer promises a report that is not there", async () => {
  const store = new MemoryStateStore();
  const graph = compileSkeleton();
  const suite = {
    name: "s",
    version: 1,
    frozen: true as const,
    frozenAt: 1_000,
    // A run this store never held: `replayRun` throws, and the case must carry the failure
    // rather than an `undefined` cast to a `ReplayReport`.
    cases: [{ id: "missing", runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as RunId, mustPass: true, expect: { status: "succeeded" as const } }],
  };
  const r = await runEvalSuite({
    store,
    suite,
    graph,
    engine: { tools: new ToolRegistry(), functions: new FunctionRegistry(), models: new ModelRegistry(), policy: { granted: [] } },
  });
  assert.equal(r.cases.length, 1);
  assert.equal(r.cases[0]!.pass, false);
  assert.match(r.cases[0]!.reasons[0] ?? "", /^replay failed: /);
  assert.equal("replay" in r.cases[0]!, false, "absent, not `undefined` under a lie of a type");
  assert.ok(r.evaluators["node:verify"] !== undefined || Object.keys(r.evaluators).length >= 0, "the projection is present on every report");
});
