/**
 * A FAILING VERDICT THAT LEFT THE JOURNAL SCORED BETTER THAN ONE THAT STAYED IN IT.
 *
 * `run/externalise.ts` moves any `replace` channel that is not an output and is named by no
 * expression into the payload store once its canonical form passes `EXTERNALISE_ABOVE_BYTES`.
 * An evaluator's verdict channel is usually all three. `firstVerdict` reads VALUES, so once
 * the verdict is a handle the fold finds no verdict at all — and `outcomeOf` averages over the
 * signals that are PRESENT, so the evaluator does not count against the run. It stops counting.
 *
 * `trajectory.ts` said, in as many words, that this was safe: "It stays invisible; it does not
 * become a false verdict." The second half is true. The conclusion is false, and the first test
 * below is the measurement that says so — one graph, two runs, differing only in the length of
 * a `why` string on a failing assertion.
 *
 * WHY IT IS A GAMING VECTOR AND NOT ONLY AN ACCURACY BUG. `VERDICT_SCHEMA` bounds neither the
 * number nor the length of a rubric's `reasons`, so a model judging a model controls the
 * canonical size of its own verdict channel. Padding it past the threshold deletes its own
 * failing verdict from the score. CLAUDE.md property 3: "the measurement has to be one that
 * cannot be gamed by the thing being measured."
 *
 * THE FIX IS A REFUSAL, NOT A RECOVERY. The fold cannot see inside a handle, so it cannot get
 * the verdict back; what it can do is decline to call the result a measurement.
 * `verdictsResolved` is false, `specResolved` follows it, and `score.ts`'s existing
 * unmeasurable path does the rest — outcome 0, score 0, dropped from the cohort population.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_WEIGHTS, isGolden, measureCohort, outcomeOf, readSignals, scoreTrajectory } from "../../src/evolution/score.ts";
import { foldTrajectory, type Trajectory } from "../../src/evolution/trajectory.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { memoryPayloads } from "../../src/journal/payloads.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "../run/skeleton.ts";

const NOW = 1_700_000_000_000;

/** Comfortably past `EXTERNALISE_ABOVE_BYTES`, with no shorter canonical form. */
const BIG = "x".repeat(300_000);

/**
 * TWO ASSERTION EVALUATORS, ONE FAILING AND ONE PASSING, so the run keeps a signal after the
 * failing verdict disappears — which is the whole mechanism. With only the failing evaluator
 * the run would have no signals at all and `outcomeOf` would return 0 either way; it is the
 * SURVIVING signal that carries the average up.
 *
 * `verdict` and `vgood` are `replace`, are not outputs, and are named by no expression, so
 * `externalisableChannels` keeps both. `out` is the output and is therefore ineligible — the
 * control that keeps this about verdicts rather than about externalisation in general.
 */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "judged", project: "evolution", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      claim: { type: "string", reduce: "replace" },
      out: { type: "string", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
      vgood: { type: "object", reduce: "replace" },
    },
    inputs: ["claim"],
    outputs: ["out"],
    nodes: [
      { id: "emit", type: "function", reads: ["claim"], writes: ["out"], function: { ref: "function/emit@stable" } },
      { id: "check", type: "evaluator", reads: ["claim"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 1 } },
      { id: "good", type: "evaluator", reads: ["claim"], writes: ["vgood"], evaluator: { kind: "assertion", ref: "function/good@stable", threshold: 1 } },
    ],
    edges: [
      { id: "e0", from: "emit", to: "check", kind: "seq" },
      { id: "e1", from: "check", to: "good", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** One run of the graph above. `why` is the only thing that varies, and it varies only in LENGTH. */
async function run(why: string): Promise<{ trajectory: Trajectory; external: readonly string[]; events: JournalEvent[] }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/emit@stable", () => ({ writes: { out: "done" } }));
  functions.register("function/check@stable", () => ({ writes: { verdict: { pass: false, score: 0, why } } }));
  functions.register("function/good@stable", () => ({ writes: { vgood: { pass: true, score: 1 } } }));

  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["*"], systemFloor: "out" },
    payloads: memoryPayloads(),
  });

  const runId = await engine.submit({ graph, inputs: { claim: "the sky is green" } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  const external = events.flatMap((e) => (e.type === "task.committed" ? Object.keys(e.payload.external ?? {}) : []));
  // `events` because one test below folds the SAME journal a second time with no graph, and
  // re-running the engine to get a second copy would be a different run.
  return { trajectory: foldTrajectory(events, { graph }), external, events };
}

test("THE DEFECT: padding a failing verdict past the payload threshold used to buy a perfect outcome", async () => {
  const small = await run("short");
  const padded = await run(BIG);

  // The premise, measured rather than assumed: the same graph, and the only difference the
  // engine made of a longer string is that one channel left the journal.
  assert.deepEqual([...small.external], [], "nothing externalised when the verdict was short");
  assert.deepEqual([...padded.external], ["verdict"], "the failing verdict is the channel that left");

  // …and the failing assertion is simply gone from the fold. This is not the bug; it is
  // unavoidable, because the value is not in the journal to read.
  assert.deepEqual(small.trajectory.outcome.assertions, [
    { nodeId: "check", pass: false },
    { nodeId: "good", pass: true },
  ]);
  assert.deepEqual(padded.trajectory.outcome.assertions, [{ nodeId: "good", pass: true }]);

  // THE BUG IS WHAT THAT WAS WORTH. Read as a bare average over surviving signals, losing the
  // failure is a PROMOTION — the number a flawless run earns.
  assert.equal(outcomeOf(readSignals(small.trajectory)), 0.5, "1 of 2 assertions passed");
  assert.equal(outcomeOf(readSignals(padded.trajectory)), 1, "1 of 1 — the failure was not counted, it was removed");

  // THE FIX: the fold refuses to certify a ladder it could not read.
  assert.equal(small.trajectory.verdictsResolved, true);
  assert.equal(padded.trajectory.verdictsResolved, false, "an evaluator's channel is in the payload store");
  assert.equal(padded.trajectory.specResolved, false, "so the run is not a measurement, whatever the graph was");
});

test("AND THE REFUSAL REACHES THE SCORE — 1.0000 becomes an unmeasured 0, not a perfect run", async () => {
  const small = (await run("short")).trajectory;
  const padded = (await run(BIG)).trajectory;

  // A cohort measured from the honest run, so both are scored against the same ruler.
  const cohort = measureCohort("k", [small], { weights: DEFAULT_WEIGHTS });
  const a = scoreTrajectory(small, cohort);
  const b = scoreTrajectory(padded, cohort);

  assert.equal(a.components.specResolved, true);
  assert.equal(a.outcome, 0.5, "the honest run still scores what it earned");

  assert.equal(b.components.specResolved, false, "the marker, which is the point — not the zero");
  assert.equal(b.outcome, 0, "not 1.0");
  assert.equal(b.score, 0);
  assert.ok(a.score > b.score, `padding must never pay: honest ${String(a.score)} vs padded ${String(b.score)}`);

  // …and it is dropped from the POPULATION rather than counted as a strong member, which is
  // what would otherwise drag every peer's p90 up behind it.
  assert.equal(measureCohort("k", [small, padded]).n, 1, "the unreadable run is not a cohort member");
});

test("THE REFUSAL IS NARROW: externalising a channel no evaluator wrote still scores normally", async () => {
  // The control. If this went red the fix would be a blanket refusal of every run large enough
  // to use the payload store, which is most of the runs worth measuring.
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/emit@stable", () => ({ writes: { out: "done", bulk: BIG } }));
  functions.register("function/check@stable", () => ({ writes: { verdict: { pass: false, score: 0 } } }));
  functions.register("function/good@stable", () => ({ writes: { vgood: { pass: true, score: 1 } } }));

  const s = spec() as unknown as { channels: Record<string, unknown>; nodes: { id: string; writes: string[] }[] };
  s.channels["bulk"] = { type: "string", reduce: "replace" };
  s.nodes[0]!.writes = ["out", "bulk"];

  const graph = compileOrThrow({ spec: s as unknown as GraphSpec, resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["*"], systemFloor: "out" },
    payloads: memoryPayloads(),
  });
  const runId = await engine.submit({ graph, inputs: { claim: "x" } });
  assert.equal((await engine.advance(runId)).status, "succeeded");
  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);

  const t = foldTrajectory(events, { graph });
  const external = events.flatMap((e) => (e.type === "task.committed" ? Object.keys(e.payload.external ?? {}) : []));
  assert.deepEqual([...external], ["bulk"], "the premise: something really did leave the journal");
  assert.equal(t.verdictsResolved, true, "…but no evaluator wrote it, so every verdict is still readable");
  assert.equal(t.specResolved, true);
  assert.equal(outcomeOf(readSignals(t)), 0.5, "and both verdicts are still counted");
});

test("THE TWO CONDITIONS COMPOSE — an unreadable verdict cannot hide behind a fold that has no graph", async () => {
  // `allVerdictsResolved` keys on node types, and node types come from the graph. Fold the same
  // journal WITHOUT it and no step is known to be an evaluator, so `verdictsResolved` comes back
  // true — vacuously, because nothing was checked. That is only safe because `specResolved` is
  // the AND of the two. Asserted rather than argued: a later change making `specResolved` read
  // `verdictsResolved` alone would be silently permissive, and this is what would go red.
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/emit@stable", () => ({ writes: { out: "done" } }));
  functions.register("function/check@stable", () => ({ writes: { verdict: { pass: false, score: 0, why: BIG } } }));
  functions.register("function/good@stable", () => ({ writes: { vgood: { pass: true, score: 1 } } }));
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["*"], systemFloor: "out" },
    payloads: memoryPayloads(),
  });
  const runId = await engine.submit({ graph, inputs: { claim: "x" } });
  assert.equal((await engine.advance(runId)).status, "succeeded");
  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);

  const blind = foldTrajectory(events);
  assert.equal(blind.verdictsResolved, true, "vacuously — no node was known to be an evaluator");
  assert.equal(blind.specResolved, false, "…and the other arm is what refuses");
});

test("AND THE BLOCKER NAMES THE CAUSE THAT IS TRUE — a run that HAD its graph is not told the graph was missing", async () => {
  // THE DEFECT THIS ARM CLOSES. `specResolved` became the AND of two facts and `isGolden`
  // condition 6 kept the sentence written for the first: "NO SPEC — graph <hash> was not
  // available to the fold". Driven with the graph explicitly passed to `foldTrajectory`, that
  // string is a false statement about the fold, and it is what a human reads to decide a
  // promotion. CLAUDE.md: a correction that replaces a false claim with a differently-false one
  // is worse than the original, because it asserts verified accuracy and is believed harder.
  const padded = await run(BIG);
  const small = await run("short");

  const cohort = measureCohort("k", [small.trajectory], { weights: DEFAULT_WEIGHTS });
  const six = (t: Trajectory): { pass: boolean; detail: string } => {
    const c = isGolden(t, scoreTrajectory(t, cohort), cohort).conditions.find((x) => x.id === 6);
    assert.ok(c !== undefined, "condition 6 exists");
    return { pass: c.pass, detail: c.detail };
  };

  const bad = six(padded.trajectory);
  assert.equal(bad.pass, false, "the premise: it still refuses");
  assert.equal(
    /not available to the fold|NO SPEC/.test(bad.detail),
    false,
    `the graph WAS available, so the blocker must not say otherwise: ${bad.detail}`,
  );
  // THE BAR IS THAT AN OPERATOR WHO ACTS ON IT ENDS UP UNSTUCK: the true cause, the size that
  // decided, and a remedy that is not "republish a graph that is already published".
  assert.match(bad.detail, /payload handle/, bad.detail);
  assert.match(bad.detail, /65536 bytes/, "the number the engine actually decided by");
  assert.match(bad.detail, /outputs/, "…and the way to keep a verdict out of the payload store");

  // THE OTHER ARM IS UNCHANGED, which is what stops this from being the same mistake mirrored.
  // Same journal, folded a second time with no graph: that fold really did not have one, and is
  // still told so in those words.
  const blind = foldTrajectory(padded.events);
  assert.equal(blind.specResolved, false);
  assert.match(six(blind).detail, /NO SPEC — graph sha256:/, "the no-graph cause still names itself");

  assert.equal(six(small.trajectory).pass, true, "and a readable run passes");
});
