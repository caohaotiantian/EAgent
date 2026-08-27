/**
 * THE WHOLE LOOP, OFFLINE: thirty runs of one workflow into one cohort, goldens picked out of
 * it by their own journaled verdicts, an exam frozen from those verdicts, and a candidate
 * promoted over the population because it measurably beat the baseline.
 *
 * D6's third property is the one CLAUDE.md calls the most easily faked: "capturing
 * trajectories is not improvement; scoring them is not improvement. Improvement is when a later
 * run is measurably better BECAUSE OF an earlier one." Every piece of that existed before this
 * file and none of them touched: `evolution/score.ts` assembles a cohort, `evolution/gate.ts`
 * judges a candidate, and no file in the tree imported both except the barrel. This is the
 * test that makes the sentence one mechanism.
 *
 * THE CAUSAL EDGE IS THE FREEZE, and it is mechanical rather than asserted. The suite's cases
 * are not chosen by the test: they are chosen by each member's own `isGolden` verdict, computed
 * from the cohort the earlier runs formed. A golden member becomes a MUST-PASS regression case;
 * a non-golden member becomes the room a candidate has to win. That rule is why the demonstration
 * cannot be gamed by picking cases — a suite of goldens only is one the baseline passes by
 * construction, and no candidate could ever show a positive delta against it.
 *
 * THE EXPECTATIONS COME FROM PLANTED GROUND TRUTH — every item in, every item kept — and never
 * from what the baseline produced. The baseline is wrong on half the corpus on purpose. A suite
 * written from a recording's output is an exam written by the student.
 *
 * WHY THE INEQUALITY IS STRICT. `gateCandidate` is a NON-INFERIORITY test by construction and
 * `2-non-inferior` passes at Δ 0.0pp, which is correct for a cost-reduction candidate and wrong
 * for the claim this file makes. Measured: a suite whose cases are all `mustPass: false` and
 * which both sides fail 6/6 returns `promote: true` at "0.0% vs 0.0%". So `promote === true` on
 * its own proves nothing was refused, not that anything was measured, and every assertion here
 * that matters is on the delta.
 *
 * Offline, deterministic and free: `function` and `evaluator{assertion}` nodes only, so there
 * is nothing for a provider to answer, no clock is read, and the whole file is milliseconds.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { isEvent, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { cohortKeyOf, isGolden, measureCohort, scoreTrajectory, type CohortStats } from "../../src/evolution/score.ts";
import { foldTrajectory, type Trajectory } from "../../src/evolution/trajectory.ts";
import { gateCandidate, runEvalSuite, type EvalCase, type EvalSuite } from "../../src/evolution/gate.ts";
import { resolver } from "../run/skeleton.ts";

// ---------------------------------------------------------------------------
// the workflow: keep every item, and assert mechanically that you did
// ---------------------------------------------------------------------------

function spec(pickRef: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "pick-bench", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: {
      items: { type: "array", reduce: "replace" },
      picked: { type: "array", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["verdict"],
    nodes: [
      { id: "pick" as NodeId, type: "function", reads: ["items"], writes: ["picked"], function: { ref: pickRef } },
      {
        id: "check" as NodeId,
        type: "evaluator",
        reads: ["items", "picked"],
        writes: ["verdict"],
        evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
      },
    ],
    edges: [{ id: "e" as EdgeId, from: "pick" as NodeId, to: "check" as NodeId, kind: "seq" }],
  };
}

const compileOf = (pickRef: string): RunGraph =>
  compileOrThrow({ spec: spec(pickRef), resolver: resolver(), tools: {}, tenantCapabilities: [] });

interface Bench {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly engineOpts: { tools: ToolRegistry; functions: FunctionRegistry; models: ModelRegistry; policy: { granted: string[] } };
}

function bench(): Bench {
  const store = new MemoryStateStore();
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();

  // THE DEFECT, and it is in a deterministic body on purpose. A candidate whose improvement
  // lives in a prompt is invisible to an offline gate — replay serves the recorded answer to a
  // question nobody asked — so the only improvement this loop can honestly measure is one that
  // RE-EXECUTES. Function bodies do.
  functions.register("function/pick@stable", (view) => {
    const items = view.get<string[]>("items") ?? [];
    // Wrong when the list is even-length: exactly half the corpus.
    return { writes: { picked: items.length % 2 === 0 ? items.slice(0, -1) : items.slice() } };
  });
  functions.register("function/pick-v2@stable", (view) => ({ writes: { picked: (view.get<string[]>("items") ?? []).slice() } }));
  functions.register("function/check@stable", (view) => {
    const items = view.get<string[]>("items") ?? [];
    const picked = view.get<string[]>("picked") ?? [];
    return { writes: { verdict: { pass: picked.length === items.length, confidence: 1, detail: `${String(picked.length)}/${String(items.length)}` } } };
  });

  const engine = new Engine({ store, bus: new InProcessEventBus(), tools, functions, models, now: () => 1_000 });
  return { engine, store, engineOpts: { tools, functions, models, policy: { granted: [] } } };
}

async function eventsOf(b: Bench, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of b.store.read(runId, 1)) out.push(e);
  return out;
}

/** One run of `graph` over `items`, to completion. */
async function run(b: Bench, graph: RunGraph, items: readonly string[]): Promise<RunId> {
  const runId = await b.engine.submit({ graph, inputs: { items: [...items] } });
  const p = await b.engine.advance(runId);
  assert.equal(p.status, "succeeded");
  return runId;
}

/** Thirty runs of the baseline over thirty different inputs, and the corpus they form. */
async function corpus(b: Bench, graph: RunGraph): Promise<{
  ids: RunId[];
  trajectories: Trajectory[];
  key: string;
  cohort: CohortStats;
}> {
  const promotedGraphHashes = new Set([graph.graphHash]);
  const ids: RunId[] = [];
  const trajectories: Trajectory[] = [];
  for (let n = 1; n <= 30; n++) {
    // Thirty DIFFERENT inputs — lengths 2..4, distinct strings — because "promotion is
    // unreachable for any workflow whose inputs vary" was the claim the shape bucket answered,
    // and a corpus of one repeated input would not test it.
    const items = Array.from({ length: 2 + (n % 3) }, (_, i) => `doc-${String(n)}-${String(i)}`);
    const id = await run(b, graph, items);
    ids.push(id);
    trajectories.push(foldTrajectory(await eventsOf(b, id), { graph, promotedGraphHashes }));
  }
  const key = cohortKeyOf(trajectories[0]!);
  return { ids, trajectories, key, cohort: measureCohort(key, trajectories) };
}

// ---------------------------------------------------------------------------
// 1 · thirty runs, one cohort, and goldens in it
// ---------------------------------------------------------------------------

test("THIRTY RUNS OF ONE WORKFLOW OVER THIRTY DIFFERENT INPUTS ARE ONE COHORT OF THIRTY", async () => {
  const b = bench();
  const graph = compileOf("function/pick@stable");
  const c = await corpus(b, graph);

  assert.equal(new Set(c.ids).size, 30, "thirty runs");
  assert.equal(new Set(c.trajectories.map((t) => t.inputDigest)).size, 30, "…over thirty genuinely different inputs");
  assert.equal(new Set(c.trajectories.map(cohortKeyOf)).size, 1, "…and one cohort key");
  assert.equal(c.cohort.n, 30, "n counts comparable runs, and MIN_COHORT_SIZE means 30 of those");
  assert.match(c.key, /\|shape:[0-9a-f]{8}$/, "the key says which rule bucketed it");
});

test("…AND THE COHORT CONTAINS GOLDEN TRAJECTORIES, with nothing blocking them", async () => {
  const b = bench();
  const graph = compileOf("function/pick@stable");
  const c = await corpus(b, graph);

  const verdicts = c.trajectories.map((t) => isGolden(t, scoreTrajectory(t, c.cohort), c.cohort));
  const golden = verdicts.filter((v) => v.golden);
  assert.ok(golden.length > 0, `no golden trajectory; blockers ${JSON.stringify(verdicts[0]!.conditions.filter((x) => !x.pass))}`);
  assert.deepEqual(
    golden[0]!.conditions.filter((x) => !x.pass),
    [],
    "golden means every one of the five conditions held, not four of them",
  );

  // NOT ALL OF THEM, and that is the interesting number rather than a defect. The baseline is
  // wrong on the even-length half of the corpus, so those runs' assertion fails and condition 1
  // refuses them. A demonstration reporting 30/30 golden would be the finding that something
  // is measuring nothing.
  assert.ok(golden.length < 30, "a corpus with no failures is a corpus with no room to improve");
  assert.deepEqual(
    [...new Set(verdicts.filter((v) => !v.golden).flatMap((v) => v.conditions.filter((x) => !x.pass).map((x) => x.name)))].sort(),
    ["outcome and ground truth", "top decile of its cohort"],
    "and the reason they are not golden is that they got the answer wrong",
  );
});

// ---------------------------------------------------------------------------
// 2 · the freeze — the causal edge, decided by the earlier runs' own verdicts
// ---------------------------------------------------------------------------

/**
 * Select the suite's cases from a cohort using the members' OWN verdicts.
 *
 * Golden -> `mustPass: true`, a regression the candidate may not break. Non-golden ->
 * `mustPass: false`, the room it has to win. Both halves are required: a suite of goldens only
 * is one the baseline passes by construction, and one of failures only has no floor.
 *
 * `expect.channels` names the channel BEFORE the evaluator (`picked`), never the evaluator's
 * own output. A candidate that rewrites the grader passes any suite that reads the grader.
 */
function freeze(
  trajectories: readonly Trajectory[],
  ids: readonly RunId[],
  cohort: CohortStats,
  inputsOf: (i: number) => readonly string[],
  frozenAt: number,
): EvalSuite {
  const cases: EvalCase[] = trajectories.map((t, i) => ({
    id: `c${String(i)}`,
    runId: ids[i]!,
    mustPass: isGolden(t, scoreTrajectory(t, cohort), cohort).golden,
    expect: { status: "succeeded" as const, channels: { picked: [...inputsOf(i)] } },
  }));
  return {
    name: "pick-bench",
    version: 1,
    frozen: true,
    frozenAt,
    generatedBy: "the-cohort",
    cases,
    // `minFailureCases` counts cases expecting `status: "failed"` — RUNS that failed, not
    // assertions that did — and every run in this corpus succeeded. Claiming it here would
    // make `0-suite` refuse the exam for a property the corpus does not have.
    composition: { minCases: 6, minMustPass: 1 },
  };
}

const inputsFor = (n: number): readonly string[] => Array.from({ length: 2 + (n % 3) }, (_, i) => `doc-${String(n)}-${String(i)}`);

test("A CANDIDATE IS PROMOTED OVER THAT COHORT, BECAUSE IT MEASURABLY BEAT THE BASELINE", async () => {
  const b = bench();
  const baselineGraph = compileOf("function/pick@stable");
  const c = await corpus(b, baselineGraph);
  const suite = freeze(c.trajectories, c.ids, c.cohort, (i) => inputsFor(i + 1), 1_000);

  // The exam has both halves — this is the composition rule, checked rather than intended.
  assert.ok(suite.cases.some((x) => x.mustPass), "goldens became must-pass regression cases");
  assert.ok(suite.cases.some((x) => !x.mustPass), "and the runs the baseline got wrong are the room to win");

  const candidateGraph = compileOf("function/pick-v2@stable");
  assert.notEqual(candidateGraph.graphHash, baselineGraph.graphHash);

  const baseline = await runEvalSuite({ store: b.store, suite, graph: baselineGraph, engine: b.engineOpts });
  const candidate = await runEvalSuite({ store: b.store, suite, graph: candidateGraph, engine: b.engineOpts });

  // STRICTLY better, not merely non-inferior. `gateCandidate` returns `promote: true` at
  // 0.0% vs 0.0%, so this is the assertion that says something was measured.
  assert.ok(
    candidate.passRate > baseline.passRate,
    `candidate ${String(candidate.passRate)} must beat baseline ${String(baseline.passRate)}`,
  );
  assert.equal(candidate.passRate, 1, JSON.stringify(candidate.cases.filter((x) => !x.pass).map((x) => x.reasons)));
  assert.ok(baseline.passRate < 1, "the premise: the baseline really does get some of them wrong");
  assert.deepEqual(baseline.mustPassFailures, [], "…and never the ones its own goldens named");

  const verdict = gateCandidate({
    baseline,
    candidate,
    proposedAt: suite.frozenAt + 1,
    proposedBy: "a-human",
    // Measured the way `loom promote` measures them, not asserted: two suite runs, and a
    // recompile of the candidate against the baseline's postures.
    promptGrowth: 0,
    postureDiffNonNegative: true,
    deterministic: sameOutcome(candidate, await runEvalSuite({ store: b.store, suite, graph: candidateGraph, engine: b.engineOpts })),
  });
  assert.equal(verdict.promote, true, JSON.stringify(verdict.checks.filter((x) => !x.pass)));
  assert.equal(verdict.checks.length, 11);
  assert.equal(verdict.checks.every((x) => x.pass), true);
});

function sameOutcome(a: Awaited<ReturnType<typeof runEvalSuite>>, b: Awaited<ReturnType<typeof runEvalSuite>>): boolean {
  return (
    a.cases.length === b.cases.length &&
    a.cases.every((x, i) => {
      const y = b.cases[i];
      return y !== undefined && x.id === y.id && JSON.stringify(x.replay.replayed.channels) === JSON.stringify(y.replay.replayed.channels);
    })
  );
}

// ---------------------------------------------------------------------------
// 3 · the negative controls — what the loop refuses
// ---------------------------------------------------------------------------

test("CONTROL · a suite frozen AFTER the candidate was proposed is refused", async () => {
  const b = bench();
  const baselineGraph = compileOf("function/pick@stable");
  const c = await corpus(b, baselineGraph);
  const suite = freeze(c.trajectories, c.ids, c.cohort, (i) => inputsFor(i + 1), 5_000);
  const candidateGraph = compileOf("function/pick-v2@stable");

  const baseline = await runEvalSuite({ store: b.store, suite, graph: baselineGraph, engine: b.engineOpts });
  const candidate = await runEvalSuite({ store: b.store, suite, graph: candidateGraph, engine: b.engineOpts });
  const verdict = gateCandidate({
    baseline,
    candidate,
    proposedAt: suite.frozenAt - 1,
    proposedBy: "an-optimiser",
    promptGrowth: 0,
    postureDiffNonNegative: true,
    deterministic: true,
  });
  assert.equal(verdict.promote, false, "an exam written for a known student proves nothing");
  assert.deepEqual(verdict.checks.filter((x) => !x.pass).map((x) => x.id), ["9-suite-predates-candidate"]);
});

test("CONTROL · a suite of GOLDENS ONLY is one the baseline passes by construction", async () => {
  // The reason `freeze` takes both halves, stated as a measurement rather than an intention.
  // An exam drawn only from a workflow's best runs cannot show any candidate a positive delta,
  // so a loop that assembled its suite that way would report improvement forever and measure
  // none of it.
  const b = bench();
  const baselineGraph = compileOf("function/pick@stable");
  const c = await corpus(b, baselineGraph);
  const all = freeze(c.trajectories, c.ids, c.cohort, (i) => inputsFor(i + 1), 1_000);
  const goldensOnly: EvalSuite = { ...all, cases: all.cases.filter((x) => x.mustPass) };
  assert.ok(goldensOnly.cases.length > 0);

  const baseline = await runEvalSuite({ store: b.store, suite: goldensOnly, graph: baselineGraph, engine: b.engineOpts });
  const candidate = await runEvalSuite({ store: b.store, suite: goldensOnly, graph: compileOf("function/pick-v2@stable"), engine: b.engineOpts });
  assert.equal(baseline.passRate, 1, "the baseline is perfect on its own best runs");
  assert.equal(candidate.passRate - baseline.passRate, 0, "so the best any candidate can do is tie");
});

test("CONTROL · a candidate that BREAKS a golden regression is refused by 1-must-pass", async () => {
  const b = bench();
  const baselineGraph = compileOf("function/pick@stable");
  const c = await corpus(b, baselineGraph);
  const suite = freeze(c.trajectories, c.ids, c.cohort, (i) => inputsFor(i + 1), 1_000);

  // A "candidate" that drops the first item instead of the last: it fixes nothing and breaks
  // the odd-length runs the baseline got right.
  b.engineOpts.functions.register("function/pick-v3@stable", (view) => ({ writes: { picked: (view.get<string[]>("items") ?? []).slice(1) } }));
  const worse = compileOf("function/pick-v3@stable");

  const baseline = await runEvalSuite({ store: b.store, suite, graph: baselineGraph, engine: b.engineOpts });
  const candidate = await runEvalSuite({ store: b.store, suite, graph: worse, engine: b.engineOpts });
  assert.ok(candidate.mustPassFailures.length > 0, "it broke a regression its own cohort named");

  const verdict = gateCandidate({
    baseline,
    candidate,
    proposedAt: suite.frozenAt + 1,
    proposedBy: "an-optimiser",
    promptGrowth: 0,
    postureDiffNonNegative: true,
    deterministic: true,
  });
  assert.equal(verdict.promote, false);
  assert.equal(verdict.checks.find((x) => x.id === "1-must-pass")!.pass, false);
});

test("CONTROL · the graph a run came from is the graph its journal names", async () => {
  // The loop's own premise: a case IS a recording, and the recording says which graph made it.
  // If `run.submitted.graphHash` did not agree with the compiled artifact, every cohort key and
  // every promoted-set test above would be answering about some other graph.
  const b = bench();
  const graph = compileOf("function/pick@stable");
  const id = await run(b, graph, ["a", "b"]);
  const events = await eventsOf(b, id);
  const submitted = events.find((e): e is Extract<JournalEvent, { type: "run.submitted" }> => isEvent(e, "run.submitted"));
  assert.equal(submitted?.payload.graphHash, graph.graphHash);

  // …and a fold given no promoted set answers "unpromoted", which is condition 5 failing closed.
  const t = foldTrajectory(events, { graph });
  assert.equal(t.fromUnpromotedCandidate, true, "a caller that omits the promoted set certifies nothing");
});
