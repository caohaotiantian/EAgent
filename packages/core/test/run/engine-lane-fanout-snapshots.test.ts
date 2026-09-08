/**
 * A wide fan-out takes ONE post-lease snapshot per wave, not one per task.
 *
 * `#executeTask` re-projected for every task it ran, so a 3,200-branch fan-out took 6,612
 * snapshots for 3,203 tasks — and each snapshot copies `{...p.tasks}`, every task the run has
 * ever created. That copy, twice per task, was the term that made the run quadratic: measured
 * at 294e713, 200 branches 48–80 ms and 3,200 branches 7.7–8.4 s (16× the width, ~100× the
 * time). `#runWaveInner` now leases the whole wave, projects once, and hands that projection to
 * every body; the only thing a body reads from the post-lease state is its OWN lease row (the
 * body clock), which the wave's snapshot holds for all of them.
 *
 * THE PIN IS A COUNT, NOT A CLOCK. Snapshots per task is a deterministic property of the
 * executor's structure; the wall time is not, and the one clock read here is an absolute
 * bound with room for an order of magnitude of noise. The fold-equivalence measurement — nine
 * fixtures at 294e713 and at head, every event and every prefix digest IDENTICAL once seed
 * values and minted gate ids are normalised — is the acceptance for this change and is
 * recorded in the lane report rather than pinned here, because it needs two trees.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { RunFolder } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function wideSpec(width: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "wide", project: "snap", version: 1 },
    policy: { expansion: { maxNodes: 1024, maxDepth: 1, maxFanout: width, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      results: { type: "array", reduce: "append_ordered" },
      summary: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["summary"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/noop@stable" } },
      { id: n("work"), type: "function", reads: ["item"], writes: ["results"], function: { ref: "function/work@stable" } },
      { id: n("collect"), type: "join", reads: ["results"], writes: ["results"], join: { branches: [n("work")], mode: "all", onBranchError: "fail" } },
      { id: n("done"), type: "function", reads: ["results"], writes: ["summary"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fan"), from: n("start"), to: n("work"), kind: "fanout", over: "items", as: "item", maxWidth: width },
      { id: e("join"), from: n("work"), to: n("collect"), kind: "join", branches: [n("work")] },
      { id: e("out"), from: n("collect"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** Run a fan-out of `width` at `maxParallelism`, counting every `RunFolder.projection()` call. */
async function fanout(width: number, maxParallelism: number) {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/work@stable", (view) => ({ writes: { results: [{ i: view.get<{ i: number }>("item")?.i ?? -1 }] } }));
  functions.register("function/done@stable", (view) => ({ writes: { summary: { count: (view.get<unknown[]>("results") ?? []).length } } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    maxParallelism,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: wideSpec(width), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });

  const original = RunFolder.prototype.projection;
  let snapshots = 0;
  RunFolder.prototype.projection = function (this: RunFolder) {
    snapshots++;
    return original.call(this);
  };
  const started = performance.now();
  try {
    const runId = await engine.submit({ graph, inputs: { items: Array.from({ length: width }, (_, i) => ({ i })) } });
    const p = await engine.advance(runId);
    return { p, snapshots, ms: performance.now() - started, waves: Math.ceil(width / maxParallelism) + 3 };
  } finally {
    RunFolder.prototype.projection = original;
  }
}

test("ONE SNAPSHOT PER WAVE FOR THE BODIES, ONE PER COMMIT — never two per task", async () => {
  const { p, snapshots, waves } = await fanout(200, 16);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["summary"], { count: 200 });
  const tasks = Object.keys(p.tasks).length;
  assert.equal(tasks, 203);
  // Per task: the commit's own snapshot. Per wave: the selection snapshot and the post-lease one.
  // At 294e713 this read 425 for 203 tasks — a snapshot per task for the body on top of the one
  // per commit — and the bound below is what that number fails.
  const ceiling = tasks + 3 * waves;
  assert.ok(snapshots <= ceiling, `${String(snapshots)} snapshots for ${String(tasks)} tasks in ~${String(waves)} waves (ceiling ${String(ceiling)})`);
});

test("…and the result is the same one the per-task snapshots produced (the ordinary half)", async () => {
  const { p } = await fanout(37, 4);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["summary"], { count: 37 });
  const results = p.channels["results"] as { i: number }[];
  assert.deepEqual(
    results.map((r) => r.i),
    Array.from({ length: 37 }, (_, i) => i),
    "branch order is coordinate order, whatever the wave boundaries were",
  );
});

test("a 200-branch fan-out stays under an absolute bound with an order of magnitude to spare", async () => {
  // 48–187 ms measured across quiet and heavily loaded machines; the bound is a defence against
  // the quadratic coming back (~7,700 ms at 3,200 would be ~300 ms at 200 on the old curve's
  // shape only if it were linear — it was not: 10,717 ms was measured at 3,200 in the audit).
  const { p, ms } = await fanout(200, 16);
  assert.equal(p.status, "succeeded");
  assert.ok(ms < 5_000, `200 branches took ${String(Math.round(ms))} ms`);
});
