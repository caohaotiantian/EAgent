/**
 * `checkpoint: "before"` WAS A SILENT NO-OP.
 *
 * The arm that writes `checkpoint.created` tested `"after" || "both"` only, so a node declaring
 * `"before"` got nothing — including the `human_gate` node of BOTH shipped workflows
 * (`workflows/incident-triage.ts`, `builtin/authoring.ts`), which is the node an author most
 * wants a rewind target in FRONT of. The field is in `NodeSpec`, the compiler accepts it, and it
 * meant nothing.
 *
 * "Before" is expressible here because checkpoints are written at COMMIT time: a marker pushed
 * ahead of this node's `state.reduced` names the state as it was before its writes landed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { RunId } from "../../src/ids.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(checkpoint: "none" | "before" | "after" | "both"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "cp", project: "checkpoint", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { n: { type: "number", reduce: "replace" } },
    inputs: ["n"],
    outputs: ["n"],
    nodes: [{ id: "step", type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/bump@stable" }, checkpoint }],
    edges: [],
  } as unknown as GraphSpec;
}

async function checkpointsFor(checkpoint: "none" | "before" | "after" | "both"): Promise<string[]> {
  const functions = new FunctionRegistry();
  functions.register("function/bump@stable", (view) => ({ writes: { n: (view.get<number>("n") ?? 0) + 1 } }));
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], budget: { runUsd: 1 } },
  });
  const graph = compileOrThrow({ spec: spec(checkpoint), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { n: 0 } });
  await engine.advance(runId);

  const ids: string[] = [];
  for await (const ev of store.read(runId as RunId, 1)) {
    if (ev.type === "checkpoint.created") ids.push(String((ev.payload as { checkpointId: string }).checkpointId));
  }
  return ids;
}

test("`before` WRITES A CHECKPOINT — it used to write none", async () => {
  const ids = await checkpointsFor("before");
  assert.equal(ids.length, 1, `exactly one checkpoint: ${ids.join(", ")}`);
  assert.match(ids[0]!, /_before$/, "and it is named as the one in front of the node");
});

test("`both` WRITES TWO DISTINGUISHABLE ONES", async () => {
  // Distinct ids, or `both` would write one marker twice and a reader could not tell which side
  // of the node it names.
  const ids = await checkpointsFor("both");
  assert.equal(ids.length, 2, `two checkpoints: ${ids.join(", ")}`);
  assert.equal(new Set(ids).size, 2, `they must differ: ${ids.join(", ")}`);
});

test("`after` AND `none` ARE UNCHANGED", async () => {
  // The fix must not have moved the two arms that already worked.
  const after = await checkpointsFor("after");
  assert.equal(after.length, 1);
  assert.doesNotMatch(after[0]!, /_before$/);
  assert.deepEqual(await checkpointsFor("none"), []);
});
