/**
 * Replay compares the TRAJECTORY of state hashes, not only the final channel map.
 *
 * `compare` graded `original.channels` against `replayed.channels` and nothing read
 * `state.reduced.stateHashAfter`, while the module docstring claimed verification "asserts every
 * `state.hash` matches". Measured at 95a3dde with the graph below — channel `out` with
 * `reduce: "sum"`, bodies `a` then `b` writing 1 then 2 — replayed against a candidate whose
 * bodies are SWAPPED: the journals disagree at the first step (`afb1ca2872` against `56f2fff5c7`
 * in the audit's run), the end state is 3 both ways, and the report said `match: true`. Function
 * bodies re-execute on replay precisely so a body regression is caught, and the only comparison
 * ran after the fold had collapsed the trajectory into one map.
 *
 * The control matters as much as the defect: an unchanged run walks the same sequence, so the
 * frame is green where it should be and a five-way fan-out (`replay.test.ts`) stays green too.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

const spec = (a: string, b: string): GraphSpec => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "sum", project: "t", version: 1 },
  channels: { out: { type: "number", reduce: "sum", initial: 0 } },
  inputs: [],
  nodes: [
    { id: "a" as NodeId, type: "function", writes: ["out"], function: { ref: a } },
    { id: "b" as NodeId, type: "function", writes: ["out"], function: { ref: b } },
  ],
  edges: [{ id: "e1" as never, from: "a" as NodeId, to: "b" as NodeId, kind: "seq" }],
  outputs: ["out"],
});

function rig() {
  const store = new MemoryStateStore();
  const bus = new InProcessEventBus();
  const resources = new ResourceStore({ now: () => 1 });
  for (const n of [1, 2]) {
    const ref = resources.publish({ kind: "function", name: `writes-${n}`, content: `() => ({ writes: { out: ${n} } })`, actor: ACTOR });
    resources.promote(ref, "canary", ACTOR);
    resources.promote(ref, "stable", ACTOR);
  }
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (ref) => loader.load(ref) });
  const engine = new Engine({ store, bus, tools: new ToolRegistry(), functions, models: new ModelRegistry(), resolver: resources });
  const compile = (s: GraphSpec): RunGraph => compileOrThrow({ spec: s, resolver: resources, tools: {}, tenantCapabilities: [] });
  const recordedGraph = compile(spec("function/writes-1@stable", "function/writes-2@stable"));
  const swapped = compile(spec("function/writes-2@stable", "function/writes-1@stable"));
  const replayEngine = { tools: new ToolRegistry(), functions, models: new ModelRegistry() };
  return { store, engine, recordedGraph, swapped, replayEngine };
}

test("SWAPPED BODIES THAT REACH THE SAME END STATE ARE A DIVERGENCE — the first differing step is named", async () => {
  const h = rig();
  const runId = await h.engine.submit({ graph: h.recordedGraph, inputs: {} });
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.status, "succeeded");
  assert.equal(recorded.channels["out"], 3);

  // `"allow"`: the graph hash would notice on its own, and this test is about the frame that
  // still notices when the hash has been told not to.
  const report = await replayRun({ store: h.store, runId, graph: h.swapped, engine: h.replayEngine, onGraphChange: "allow" });

  assert.equal(report.replayed.channels["out"], 3, "the premise: the end state coincides");
  assert.equal(report.frames.find((f) => f.kind === "state.reduced")?.match, true, "…so the final-map frame is blind to it");
  assert.equal(report.match, false, "a different trajectory to the same place is not a reproduction");

  const frame = report.frames.find((f) => f.kind === "state.hash");
  assert.ok(frame, "one frame carries the trajectory");
  assert.equal(frame.match, false);
  assert.equal(frame.taskId, "a@root#0", "the FIRST step that differs, so `loom replay` points at a node");
  assert.match(String(frame.expected), /^a@root#0 sha256:/);
  assert.match(String(frame.actual), /^a@root#0 sha256:/);
  assert.notEqual(frame.expected, frame.actual);
});

test("ORDINARY HALF — the unchanged run walks the same sequence and the frame is green", async () => {
  const h = rig();
  const runId = await h.engine.submit({ graph: h.recordedGraph, inputs: {} });
  assert.equal((await h.engine.advance(runId)).status, "succeeded");

  const report = await replayRun({ store: h.store, runId, graph: h.recordedGraph, engine: h.replayEngine });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(report.hermetic, true, "bodies from a ResourceStore are branded, and nothing was re-derived");
  const frame = report.frames.find((f) => f.kind === "state.hash");
  assert.ok(frame);
  assert.equal(frame.match, true);
  assert.equal(frame.expected, "2 steps");
  assert.equal(frame.actual, "2 steps");
});
