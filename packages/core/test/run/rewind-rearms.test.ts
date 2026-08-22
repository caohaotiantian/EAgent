/**
 * A REWIND LEFT ITS TASK LEASED, SO THE RUN NEVER REDID THE WORK — and reported success.
 *
 * `rewind` appends a marker and the fold suppresses `(atSeq, marker)`. A node's declared
 * `checkpoint: "before"` lands BETWEEN that node's `task.leased` and its `task.committed` by
 * construction, so rewinding to it suppresses the commit and leaves the lease: the fold shows a
 * task held by a worker whose work no longer exists, and `#advanceSerially` leases only tasks in
 * state `ready`.
 *
 * Measured before the fix, on the graph below: after `rewind` the task read `leased`, `advance`
 * found nothing runnable, walked to `#finish`, and appended a second `run.completed` — status
 * `succeeded`, output channel back at its INPUT value. Not a wedge. A run that says it did the
 * work and did not, which is the worse of the two.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { auditRun } from "../../src/journal/audit.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const OPERATOR = { kind: "human", subject: "u:alice", via: "console" } as const;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "rw", project: "rewind", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { n: { type: "number", reduce: "replace" } },
    inputs: ["n"],
    outputs: ["n"],
    nodes: [{ id: "one", type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/bump@stable" }, checkpoint: "before" }],
    edges: [],
  } as unknown as GraphSpec;
}

function rig(): { engine: Engine; store: MemoryStateStore } {
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
    resolver: resolver(),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, store };
}

test("REWINDING TO A NODE'S OWN CHECKPOINT RE-RUNS IT, and the output is redone", async () => {
  const r = rig();
  const runId = await r.engine.submit({
    graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }),
    inputs: { n: 0 },
  });
  const first = await r.engine.advance(runId);
  assert.equal(first.status, "succeeded");
  assert.equal(first.channels["n"], 1, "the node ran once");

  // The checkpoint the NODE declared — the boundary an operator would naturally pick.
  let atSeq: number | undefined;
  for await (const ev of r.store.read(runId, 1)) {
    if (ev.type === "checkpoint.created") atSeq = (ev.payload as { atSeq: number }).atSeq;
  }
  assert.ok(atSeq !== undefined, "the node declared `checkpoint: \"before\"`");

  const rewound = await r.engine.rewind(runId, atSeq as Seq, "operator asked", OPERATOR);
  assert.deepEqual(
    Object.values(rewound.tasks).map((t) => t.state),
    ["ready"],
    "a lease the rewind UNDID is not a lease — the task must be runnable again",
  );

  const again = await r.engine.advance(runId);
  assert.equal(again.status, "succeeded");
  assert.equal(again.channels["n"], 1, "and the work was actually REDONE, not skipped");
});

test("...and the auditor now catches the shape that was shipping", async () => {
  // The rule that would have found it: a task left `leased` on a run that COMPLETED is work the
  // run reported as done and never did.
  const r = rig();
  const runId = await r.engine.submit({
    graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }),
    inputs: { n: 0 },
  });
  await r.engine.advance(runId);
  let atSeq: number | undefined;
  for await (const ev of r.store.read(runId, 1)) {
    if (ev.type === "checkpoint.created") atSeq = (ev.payload as { atSeq: number }).atSeq;
  }
  await r.engine.rewind(runId, atSeq as Seq, "operator asked", OPERATOR);
  await r.engine.advance(runId);

  const events = [];
  for await (const ev of r.store.read(runId as RunId, 1)) events.push(ev);
  const report = auditRun(events);
  assert.deepEqual(report.violations, [], "a healthy rewind audits clean");
  assert.ok(report.checked.includes("task.leased-is-resolved"), "and the rule that guards it actually ran");
});
