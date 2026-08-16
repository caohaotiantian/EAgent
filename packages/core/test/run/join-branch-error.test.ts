/**
 * A branch that lost any member is a lost branch.
 *
 * `#foldJoin` counts per branch COORDINATE, which is right — D4 deviation 2 wants
 * `branchCount + skipped` to equal the planned width, and a branch holding two nodes is
 * one branch. But `skipped` was derived as `seen − contributing`, and a coordinate holding
 * both a succeeded task and a failed one landed in BOTH sets. It cancelled out: `skipped`
 * came to zero, and `onBranchError: "fail"` — the mode whose entire job is to stop the run
 * when a branch dies — never fired.
 *
 * A multi-node branch is exactly where that arises, and exactly where the failure matters
 * most: the first node succeeded, so there is real output sitting in the fold, and the
 * barrier reported a clean run over it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

/**
 * Each branch is TWO nodes: `first` always succeeds, `second` fails for one item. Both are
 * declared members of the join, so the failing branch's coordinate carries a succeeded
 * task and a failed one.
 */
function spec(onBranchError: "fail" | "skip"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "multi-node-branch", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 24, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      found: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    outputs: ["found"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("first"), type: "function", reads: ["item"], writes: ["found"], function: { ref: "function/first@stable" } },
      { id: n("second"), type: "function", reads: ["item"], writes: ["found"], function: { ref: "function/second@stable" }, unhandled: true },
      {
        id: n("gather"),
        type: "join",
        reads: ["found"],
        writes: ["found"],
        join: { branches: [n("first"), n("second")], mode: "all", onBranchError },
      },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("first"), kind: "fanout", over: "items", as: "item", maxWidth: 3 },
      { id: e("sq"), from: n("first"), to: n("second"), kind: "seq" },
      // BOTH declared branches need a join edge: GRAPH008 refuses a branch that cannot
      // reach its barrier, and `first` is a member precisely so the failing coordinate
      // carries a success alongside its failure.
      { id: e("jn1"), from: n("first"), to: n("gather"), kind: "join" },
      { id: e("jn2"), from: n("second"), to: n("gather"), kind: "join" },
    ],
  } as unknown as GraphSpec;
}

async function run(onBranchError: "fail" | "skip"): Promise<{ status: string; branchCount?: number; skipped?: number }> {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/first@stable", (view) => ({
    writes: { found: [`a${String(view.get<{ id: number }>("item")?.id ?? -1)}`] },
  }));
  functions.register("function/second@stable", (view) => {
    // One branch loses its SECOND node. Its first node already contributed, so the
    // coordinate carries a success and a failure at once.
    if (view.get<{ id: number }>("item")?.id === 1) throw new Error("second node failed");
    return { writes: { found: [`b${String(view.get<{ id: number }>("item")?.id ?? -1)}`] } };
  });

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => 1_700_000_000_000,
    maxParallelism: 4,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec: spec(onBranchError), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { items: [{ id: 0 }, { id: 1 }, { id: 2 }] } });
  const p = await engine.advance(runId).catch(() => engine.projection(runId));

  // `state.reduced` is a journal event, not a field on the Task — the fold's counts are a
  // durable fact rather than a projection convenience.
  let counts: { branchCount: number; skipped: number } | undefined;
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "state.reduced") {
      const q = ev.payload as { branchCount?: number; skipped?: number };
      if (q.branchCount !== undefined && q.skipped !== undefined) counts = { branchCount: q.branchCount, skipped: q.skipped };
    }
  }
  return { status: p?.status ?? "unknown", ...(counts ?? {}) };
}

test('CONTROL: `onBranchError: "fail"` does not report success when a branch died', async () => {
  // Passes on both sides of the fix, and is kept as a control rather than as proof: in
  // this shape the run also dies of the unhandled node failure, so it cannot distinguish a
  // working barrier from a disarmed one. The `skip` case below is what discriminates.
  const r = await run("fail");
  assert.notEqual(
    r.status,
    "succeeded",
    "a branch died and the join was told to fail on that — reporting success is the barrier lying about its own evidence",
  );
});

test('`onBranchError: "skip"` counts the dead branch as skipped, not as contributing', async () => {
  const r = await run("skip");
  assert.equal(r.status, "succeeded", "skip accepts partial evidence");
  assert.equal(r.skipped, 1, `one of three branches died; got skipped=${String(r.skipped)}`);
  assert.equal(
    r.branchCount,
    2,
    `a branch that lost a node is not a clean contribution; got branchCount=${String(r.branchCount)}`,
  );
});
