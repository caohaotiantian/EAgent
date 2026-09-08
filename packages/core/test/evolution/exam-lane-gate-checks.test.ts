/**
 * The two checks the replayed gate gained, and the one type it stopped lying about.
 *
 * `12-grader-unchanged` refuses audit reproduction 2 — a candidate whose only change is swapping
 * its evaluator's body — and refuses it whether or not the workflow has an attested exam, because
 * an evaluator's verdict decides a posture escalation at RUN time even where it decides no score
 * (see the test that names `#checkConfidence`). `13-replay-verified`
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
import { compileSkeleton, resolver } from "../run/skeleton.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";

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

/**
 * THE SKIP THAT WAS THERE AND IS NOT — and why, measured rather than argued.
 *
 * `12-grader-unchanged` used to pass with "skipped: this workflow has an operator-attested exam"
 * whenever the caller answered `examAttested: true`, on the design's premise (`docs/design-
 * property3-2026-09-05.md` §B′) that "once an exam exists the in-graph grader is not read by
 * anything that decides". THAT PREMISE IS FALSE AND THE ENGINE IS WHERE. `#checkConfidence`
 * (`run/engine.ts:5910`) reads every evaluator's write on every run and raises E1
 * `low_confidence` — a posture escalation — when the verdict is below the node's threshold. A
 * grader swapped for one that returns `{pass:true, confidence:1}` unconditionally therefore
 * silences an escalation that used to fire, on every future run of the published graph, and
 * nothing else in the gate can see it. Driven through the shipped binary before this test
 * existed: `loom promote candidates/rigged.json --baseline graphs/pick.json --suite s.json` on
 * an ATTESTED workflow printed `✓ 12-grader-unchanged  skipped: …`, `"promote": true`, exit 0 —
 * the audit's reproduction 2, promoting again.
 *
 * "Oversight only tightens — a human may lower a posture; no automated path may" is the rule
 * that settles it, so the check no longer takes an answer from its caller at all. The honest
 * strengthening B′ was protecting still has a door, and it is the one this check's own refusal
 * text already names: attest the stronger grader and judge live (`--against-cohort`), where
 * both sides are graded by the exam and no evaluator set is compared.
 */
test("AN ATTESTED EXAM DOES NOT EXCUSE A GRADER SWAP — the check takes no answer from its caller", () => {
  const v = gateCandidate(input(report({ evaluators: { "node:check": RIGGED } })));
  const c = check(v, "12-grader-unchanged");
  assert.equal(c.pass, false, "the audit's reproduction 2 is refused whether or not an exam exists");
  assert.doesNotMatch(c.detail, /skipped/, "there is no arm that reports this check as skipped");
  assert.match(c.detail, /function\/check@stable → function\/check-rigged@stable/);
});

test("no member of PromotionInput can turn 12 off — an unknown extra key changes nothing", () => {
  const rigged = report({ evaluators: { "node:check": RIGGED } });
  const plain = gateCandidate(input(rigged));
  const withExtra = gateCandidate({ ...input(rigged), examAttested: true } as Parameters<typeof gateCandidate>[0]);
  assert.equal(check(plain, "12-grader-unchanged").pass, false);
  assert.equal(check(withExtra, "12-grader-unchanged").pass, false, "the field the skip read is gone, so setting it loosens nothing");
  assert.deepEqual(
    withExtra.checks.map((x) => `${x.id}:${String(x.pass)}`),
    plain.checks.map((x) => `${x.id}:${String(x.pass)}`),
    "every check answers identically",
  );
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
  // A graph WITH an evaluator, so the projection has something to resolve; the skeleton has none.
  const graph = compileOrThrow({
    spec: {
      ...compileSkeleton().spec,
      policy: { posture: "out", capabilities: [] },
      channels: { items: { type: "array", reduce: "replace" }, picked: { type: "array", reduce: "replace" }, verdict: { type: "object", reduce: "replace" } },
      inputs: ["items"],
      outputs: ["verdict"],
      nodes: [
        { id: "pick" as NodeId, type: "function", reads: ["items"], writes: ["picked"], function: { ref: "function/pick@stable" } },
        { id: "verify" as NodeId, type: "evaluator", reads: ["items", "picked"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 } },
      ],
      edges: [{ id: "e" as EdgeId, from: "pick" as NodeId, to: "verify" as NodeId, kind: "seq" }],
    },
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });
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
  // The projection is filled from a REAL compile: every evaluator the skeleton declares carries
  // the digest its ref resolved to.
  assert.deepEqual(Object.keys(r.evaluators), ["node:verify"]);
  assert.match(r.evaluators["node:verify"]!.digest ?? "", /^sha256:/, "the ref resolved and its digest rode onto the report");
  assert.deepEqual(r.evaluators["node:verify"]!.reads, ["items", "picked"]);
});
