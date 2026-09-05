/**
 * A body that calls `Math.random()` replays to the same answer.
 *
 * This file exists because the module docstring of `run/replay.ts` used to describe the
 * opposite, and described it accurately: `SAFE_GLOBALS` bound `Date` to `undefined` and passed
 * `Math` through whole, so a body drawing entropy produced a run replay could only REPORT as
 * divergent — measured through the binary as
 * `✗ state.reduced : expected {"out":"0.534…"}, got {"out":"0.108…"}`. That was invariant 4's
 * one admitted gap: `effect.started` has declared a `random` kind since the vocabulary was
 * written and nothing appended one.
 *
 * The seam is a SEED rather than a value per draw. A body runs synchronously inside
 * `vm.runInContext` under a per-call timeout, so it cannot await a journal append between two
 * `Math.random()` calls; one recorded number reproduces the whole stream.
 *
 * The negative control is the point of the file. Asserting "the replay matched" proves nothing
 * unless the body's output is *capable* of differing between two live runs — otherwise a PRNG
 * hard-wired to `0.5` passes every assertion here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

/** Three draws joined, so the assertion covers a SEQUENCE and not one lucky value. */
const DRAWS = `() => ({ writes: { out: [Math.random(), Math.random(), Math.random()].join(",") } })`;

const spec = (): GraphSpec => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "rnd", project: "t", version: 1 },
  channels: { out: { type: "string", reduce: "replace" } },
  inputs: [],
  nodes: [{ id: "draw" as NodeId, type: "function", writes: ["out"], function: { ref: "function/draws@stable" } }],
  edges: [],
  outputs: ["out"],
});

function harness() {
  const store = new MemoryStateStore();
  const bus = new InProcessEventBus();
  const resources = new ResourceStore({ now: () => 1 });
  const ref = resources.publish({ kind: "function", name: "draws", content: DRAWS, actor: ACTOR });
  void ref;
  resources.promote(ref, "canary", ACTOR);
  resources.promote(ref, "stable", ACTOR);
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (ref) => loader.load(ref) });
  const engine = new Engine({ store, bus, tools: new ToolRegistry(), functions, models: new ModelRegistry(), resolver: resources });
  const graph = compileOrThrow({ spec: spec(), resolver: resources, tools: {}, tenantCapabilities: [] });
  return { store, engine, graph, functions, resources };
}

test("A BODY THAT DRAWS RANDOM NUMBERS REPLAYS TO THE SAME NUMBERS", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.status, "succeeded");

  const drawn = String(recorded.channels["out"]);
  assert.equal(drawn.split(",").length, 3);
  assert.equal(new Set(drawn.split(",")).size, 3, "three DIFFERENT draws, or the PRNG is a constant and nothing below is a test");

  const report = await replayRun({
    store: h.store,
    runId,
    graph: h.graph,
    engine: { tools: new ToolRegistry(), functions: h.functions, models: new ModelRegistry() },
  });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(String(report.replayed.channels["out"]), drawn, "the replay must reproduce the stream, not draw a new one");
});

test("THE NEGATIVE CONTROL: two LIVE runs of the same graph draw DIFFERENT numbers", async () => {
  // Without this, a seed hard-wired to a constant would satisfy the test above perfectly while
  // making every run of every graph produce identical "random" numbers — a far worse defect
  // than the one being fixed, shipped under a green replay.
  const a = harness();
  const b = harness();
  const ra = await a.engine.submit({ graph: a.graph, inputs: {} });
  const rb = await b.engine.submit({ graph: b.graph, inputs: {} });
  const pa = await a.engine.advance(ra);
  const pb = await b.engine.advance(rb);
  assert.notEqual(String(pa.channels["out"]), String(pb.channels["out"]), "two runs must not share a stream");
});

test("THE SEED IS JOURNALED AS AN EFFECT, under a derived key", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  await h.engine.advance(runId);

  const events = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);

  const started = events.filter((e) => e.type === "effect.started" && (e.payload as { kind: string }).kind === "random");
  assert.equal(started.length, 1, "one seed per task");
  assert.equal((started[0]!.payload as { key: string }).key, "draw@root#0:random:0", "the key is derived from the TaskId, never random");

  const completed = events.filter((e) => e.type === "effect.completed" && (e.payload as { key: string }).key === "draw@root#0:random:0");
  assert.equal(completed.length, 1);
  assert.equal(typeof (completed[0]!.payload as { result: unknown }).result, "number", "the recorded result is the seed itself");
});

test("AN `assertion` EVALUATOR'S BODY IS SEEDED TOO — the second caller, again", async () => {
  // `functions.require` has TWO callers, and the evaluator arm is the one that kept the last
  // defect: a check written inline in `#runFunction` left an `assertion` body committing
  // nothing, one function away from a refusal that named the mistake. This test exists because
  // a mutation found the same hole in the same arm — removing the seed from `#runEvaluator`
  // left all 2001 tests green, so the arm was seeded and unproven.
  const store = new MemoryStateStore();
  const bus = new InProcessEventBus();
  const resources = new ResourceStore({ now: () => 1 });
  // Writes a confidence ABOVE the threshold, so the evaluator does not escalate and the run
  // succeeds — the draw is what is under test, not the verdict.
  const body = `() => ({ writes: { out: [Math.random(), Math.random()].join(","), confidence: 1 } })`;
  const ref = resources.publish({ kind: "function", name: "judge", content: body, actor: ACTOR });
  resources.promote(ref, "canary", ACTOR);
  resources.promote(ref, "stable", ACTOR);
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (r) => loader.load(r) });
  const engine = new Engine({ store, bus, tools: new ToolRegistry(), functions, models: new ModelRegistry(), resolver: resources });

  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "eval-rnd", project: "t", version: 1 },
    channels: { out: { type: "string", reduce: "replace" }, confidence: { type: "number", reduce: "replace" } },
    inputs: [],
    outputs: ["out"],
    nodes: [
      {
        id: "judge" as NodeId,
        type: "evaluator",
        writes: ["out", "confidence"],
        evaluator: { kind: "assertion", ref: "function/judge@stable", threshold: 0.5 },
      },
    ],
    edges: [],
  };
  const graph = compileOrThrow({ spec, resolver: resources, tools: {}, tenantCapabilities: [] });

  const runId = await engine.submit({ graph, inputs: {} });
  const recorded = await engine.advance(runId);
  assert.equal(recorded.status, "succeeded", JSON.stringify(recorded.error ?? {}));

  const drawn = String(recorded.channels["out"]);
  assert.equal(new Set(drawn.split(",")).size, 2, "two DIFFERENT draws, or the body never reached a working PRNG");

  const report = await replayRun({
    store,
    runId,
    graph,
    engine: { tools: new ToolRegistry(), functions, models: new ModelRegistry() },
  });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(String(report.replayed.channels["out"]), drawn, "an assertion evaluator replays its stream like any other body");
});

test("A CANDIDATE'S NEW NODES GET DISTINCT SEEDS — derived from the key, not a constant", async () => {
  // The eval-suite seam. `onGraphChange: "allow"` replays a CANDIDATE graph against a recording,
  // and a candidate's new `function` node has a taskId the recording never held — so no seed was
  // ever written for it. `require` would throw `E_REPLAY_DIVERGENCE`, which is right for a model
  // or tool result and wrong here: the mode exists precisely to run a graph the recording did
  // not have. `seedFromKey` derives one instead.
  //
  // WHY DERIVED AND NOT CONSTANT, which is what this test pins: a constant would give every new
  // node in every candidate the same stream, so two nodes drawing "independently" would agree
  // exactly. That survived a mutation with the rest of the suite green.
  const h = harness();
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  await h.engine.advance(runId);

  // Distinct bodies, because a shared one writes a channel these nodes do not declare. Same
  // SOURCE though — so if the two draws agree it is the seed and nothing else.
  for (const ch of ["a", "b"]) {
    const r = h.resources.publish({ kind: "function", name: `draws-${ch}`, content: `() => ({ writes: { ${ch}: [Math.random(), Math.random()].join(",") } })`, actor: ACTOR });
    h.resources.promote(r, "canary", ACTOR);
    h.resources.promote(r, "stable", ACTOR);
  }

  const candidate = compileOrThrow({
    spec: {
      ...spec(),
      channels: {
        out: { type: "string", reduce: "replace" },
        a: { type: "string", reduce: "replace" },
        b: { type: "string", reduce: "replace" },
      },
      outputs: ["out"],
      nodes: [
        ...spec().nodes,
        { id: "extraA" as NodeId, type: "function", writes: ["a"], function: { ref: "function/draws-a@stable" } },
        { id: "extraB" as NodeId, type: "function", writes: ["b"], function: { ref: "function/draws-b@stable" } },
      ],
    },
    resolver: h.resources,
    tools: {},
    tenantCapabilities: [],
  });

  const report = await replayRun({
    store: h.store,
    runId,
    graph: candidate,
    engine: { tools: new ToolRegistry(), functions: h.functions, models: new ModelRegistry() },
    onGraphChange: "allow",
  });

  const a = String(report.replayed.channels["a"] ?? "");
  const b = String(report.replayed.channels["b"] ?? "");
  assert.ok(a.length > 0 && b.length > 0, `both new nodes must have run: a=${a} b=${b}`);
  assert.notEqual(a, b, "two new nodes must draw different streams — a constant seed would make them identical");
  // …and the node the recording DID have still serves its recorded seed rather than deriving one.
  assert.equal(String(report.replayed.channels["out"]), String((await h.engine.projection(runId))!.channels["out"]));
  // The derivation is REPORTED: two seeds came from the key and not from the record, and a
  // replay that had to invent entropy is not hermetic, however reproducible the invention is.
  assert.deepEqual(report.derivedSeeds, ["extraA@root#0:random:0", "extraB@root#0:random:0"]);
  assert.equal(report.hermetic, false);
});
