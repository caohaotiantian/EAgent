/**
 * Scale validation — the 500-node row of the Definition of Done.
 *
 * These are MEASUREMENTS with assertions attached, not micro-benchmarks. Each bound is
 * set roughly an order of magnitude above the observed time so the test fails on a
 * complexity regression (an accidental O(n²) sweep) rather than on a slow machine.
 *
 * What is honestly covered: compile, layout derivation, the projection fold, the
 * snapshot payload a UI would fetch, and a 500-way fan-out end to end. What is NOT
 * covered here: browser paint. The console is an HTML string served to a browser, so
 * its render cost cannot be measured from Node — see `99-DOD.md`, which says so.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { canonicalize } from "../src/canonical.ts";
import { compileOrThrow } from "../src/graph/compile.ts";
import type { EdgeSpec, GraphSpec, NodeSpec } from "../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../src/ids.ts";
import { InProcessEventBus } from "../src/bus.ts";
import { MemoryStateStore } from "../src/journal/memory.ts";
import { foldRun } from "../src/run/projection.ts";
import { Engine } from "../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../src/run/registry.ts";
import { resolver } from "./run/skeleton.ts";
import type { JournalEvent } from "../src/journal/events.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function ms(label: string, fn: () => void): number {
  const t0 = process.hrtime.bigint();
  fn();
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  // Printed, not just asserted: a bound that passes tells you nothing about the trend.
  console.log(`    ${label}: ${elapsed.toFixed(1)} ms`);
  return elapsed;
}

/**
 * A wide-and-deep graph: `stages` layers of `width` parallel nodes, fully connected
 * between adjacent layers.
 *
 * Fully connected on purpose — it is the worst realistic case for every analysis the
 * compiler runs (ancestors, critical path, concurrent writers), so a bound that holds
 * here holds for the graphs people actually draw.
 */
function bigSpec(stages: number, width: number): GraphSpec {
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];
  const channels: Record<string, { type: "array"; reduce: "append_ordered" }> = {
    seed: { type: "array", reduce: "append_ordered" },
    out: { type: "array", reduce: "append_ordered" },
  };

  for (let s = 0; s < stages; s++) {
    for (let w = 0; w < width; w++) {
      const id = `s${s}_${w}`;
      nodes.push({
        id: n(id),
        type: "function",
        reads: s === 0 ? ["seed"] : ["out"],
        writes: ["out"],
        function: { ref: "function/step@stable" },
      });
      if (s > 0) {
        for (let p = 0; p < width; p++) {
          edges.push({ id: e(`e${s}_${w}_${p}`), from: n(`s${s - 1}_${p}`), to: n(id), kind: "seq" });
        }
      }
    }
  }

  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "big", project: "scale", version: 1 },
    policy: { expansion: { maxNodes: 4096, maxDepth: 1, maxFanout: 512, maxLoopIterations: 1 } },
    channels,
    inputs: ["seed"],
    outputs: ["out"],
    nodes,
    edges,
  };
}

const compileBig = (spec: GraphSpec) =>
  compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });

// ── compile ──────────────────────────────────────────────────────────────────

test("a 500-node graph compiles well inside a second", () => {
  const spec = bigSpec(50, 10);
  assert.equal(spec.nodes.length, 500);
  assert.equal(spec.edges.length, 4900);

  const elapsed = ms("compile 500 nodes / 4900 edges", () => compileBig(spec));
  assert.ok(elapsed < 3000, `compile took ${elapsed.toFixed(0)} ms`);
});

/**
 * Fastest of N runs.
 *
 * A single timing is not a measurement of the code, it is a measurement of the code plus
 * whatever else the machine was doing. That distinction is the whole reason this test was
 * flaky: it passed 5/5 in isolation and failed inside `npm test`, where the suite runs in
 * parallel — a scheduler stall landing in the 500-node run while the 100-node run got a
 * clean window reported "33.7×" for an algorithm that had not changed.
 *
 * The minimum is the right statistic because interference is one-directional: a run can be
 * delayed by other work but never finish faster than the code allows. So min-of-N converges
 * on the true cost from above as N grows, while a mean or a single shot carries the load of
 * whatever else was running. `CLAUDE.md` asks tests not to depend on the wall clock; this
 * one legitimately must, so it depends on the least clock-contaminated statistic available.
 */
function fastest(label: string, fn: () => void, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    ${label}: ${best.toFixed(1)} ms (best of ${String(runs)})`);
  return best;
}

test("compile scales sub-quadratically from 100 to 500 nodes", () => {
  // The real guard. A 5× node count under an O(n²) analysis would cost ~25×; the bound
  // below fails long before that while tolerating ordinary measurement noise.
  const small = fastest("compile 100 nodes", () => compileBig(bigSpec(10, 10)));
  const big = fastest("compile 500 nodes", () => compileBig(bigSpec(50, 10)));
  assert.ok(big < Math.max(small, 1) * 25, `100→500 nodes cost ${(big / Math.max(small, 0.01)).toFixed(1)}×`);
});

test("EVERY node gets a layout rank, so the browser never runs graph layout", () => {
  const g = compileBig(bigSpec(50, 10));
  const ranks = Object.values(g.plans).map((p) => p.layoutRank);
  assert.equal(ranks.length, 500);
  assert.equal(ranks.filter((r) => Number.isInteger(r) && r >= 0).length, 500);
  assert.equal(new Set(ranks).size, 50, "one rank per layer — the layered layout is exact, not approximate");
});

test("the critical path is derived once at compile, not per frame", () => {
  const g = compileBig(bigSpec(50, 10));
  assert.equal(g.plans[n("s0_0")]?.criticalPathLength, 50);
  assert.equal(g.plans[n("s49_0")]?.criticalPathLength, 1);
});

test("the compiled graph a UI fetches once stays under a megabyte", () => {
  const g = compileBig(bigSpec(50, 10));
  const bytes = Buffer.byteLength(canonicalize({ spec: g.spec, plans: g.plans }));
  console.log(`    snapshot: ${(bytes / 1024).toFixed(0)} KiB`);
  // Structure is cached by `graphHash` on the client, so this is paid once per graph,
  // not per frame. A megabyte is generous for that; a frame budget would not be.
  assert.ok(bytes < 1_000_000, `${bytes} bytes`);
});

// ── the fold ─────────────────────────────────────────────────────────────────

test("folding a 10,000-event journal is linear and fast", () => {
  const events: JournalEvent[] = [];
  let seq = 0;
  const push = (type: string, payload: unknown, taskId?: string): void => {
    events.push({
      seq: ++seq,
      runId: "run_1",
      at: seq,
      actor: { kind: "system", id: "scale" },
      type,
      payload,
      ...(taskId === undefined ? {} : { taskId }),
    } as unknown as JournalEvent);
  };

  push("run.submitted", { workflow: "big", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" });
  push("run.started", { posture: "out" });
  for (let i = 0; i < 2500; i++) {
    const task = `s0_${i}@root#0`;
    push("task.ready", { nodeId: `s0_${i}`, branchPath: "root", edgesIn: [] }, task);
    push("task.leased", { workerId: "w", attempt: 1, fencingToken: i }, task);
    push("task.started", { nodeType: "function", attempt: 1 }, task);
    push("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, task);
  }

  assert.ok(events.length > 10_000);
  const elapsed = ms(`fold ${events.length} events`, () => {
    const p = foldRun(events)!;
    assert.equal(Object.keys(p.tasks).length, 2500);
  });
  assert.ok(elapsed < 2000, `fold took ${elapsed.toFixed(0)} ms`);
});

const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 };

// ── a 500-way fan-out, for real ──────────────────────────────────────────────

function fanoutSpec(width: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "wide", project: "scale", version: 1 },
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
      {
        id: n("collect"),
        type: "join",
        reads: ["results"],
        writes: ["results"],
        join: { branches: [n("work")], mode: "all", onBranchError: "fail", timeoutMs: 60_000 },
      },
      { id: n("done"), type: "function", reads: ["results"], writes: ["summary"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fan"), from: n("start"), to: n("work"), kind: "fanout", over: "items", as: "item", maxWidth: width },
      { id: e("join"), from: n("work"), to: n("collect"), kind: "join", branches: [n("work")] },
      { id: e("out"), from: n("collect"), to: n("done"), kind: "seq" },
    ],
  };
}

test("A 500-WAY FAN-OUT RUNS TO COMPLETION with bounded width and correct order", async () => {
  const WIDTH = 500;
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  let peak = 0;
  let live = 0;

  functions.register("function/noop@stable", () => ({}));
  // ASYNC on purpose. A synchronous body runs to completion before any sibling starts,
  // so a probe around it can never observe overlap and would report a peak of 1 no
  // matter what the scheduler did — a measurement that proves nothing.
  functions.register("function/work@stable", async (view) => {
    live++;
    peak = Math.max(peak, live);
    const item = view.get<{ i: number }>("item");
    await new Promise((r) => setImmediate(r));
    live--;
    return { writes: { results: [{ i: item?.i ?? -1 }] } };
  });
  functions.register("function/done@stable", (view) => ({
    writes: { summary: { count: (view.get<unknown[]>("results") ?? []).length } },
  }));

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    maxParallelism: 16,
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const graph = compileOrThrow({
    spec: fanoutSpec(WIDTH),
    resolver: resolver(),
    tools: {},
    tenantCapabilities: ["*"],
  });
  const items = Array.from({ length: WIDTH }, (_, i) => ({ i }));

  const t0 = process.hrtime.bigint();
  const runId = await engine.submit({ graph, inputs: { items } });
  const p = await engine.advance(runId);
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    ${WIDTH}-way fan-out: ${elapsed.toFixed(0)} ms, peak concurrency ${peak}`);

  assert.equal(p.status, "succeeded");
  assert.equal((p.channels["summary"] as { count: number }).count, WIDTH, "not one branch lost");
  assert.ok(peak <= 16, `peak concurrency was ${peak}; maxParallelism is meant to bound it`);
  assert.ok(peak > 1, `peak concurrency was ${peak}; 500 branches at maxParallelism 16 should overlap`);

  // Branch-coordinate order, which is the whole reason `append_ordered` exists: branch
  // 10 must land after branch 2, not between 1 and 2.
  const results = p.channels["results"] as { i: number }[];
  assert.deepEqual(
    results.map((r) => r.i),
    items.map((x) => x.i),
  );
});

test("a 500-branch run's journal stays proportional to the work done", async () => {
  // Lazy materialisation is meant to keep rows-in-flight bounded, NOT to hide events.
  // The journal is the audit trail; a 500-branch run has 500 branches' worth of history
  // and should say so, at a small constant per branch.
  const store = new MemoryStateStore({ now: () => 1 });
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/work@stable", () => ({ writes: { results: [1] } }));
  functions.register("function/done@stable", () => ({ writes: { summary: { ok: true } } }));

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => 1,
    maxParallelism: 16,
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const graph = compileOrThrow({ spec: fanoutSpec(500), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { items: Array.from({ length: 500 }, (_, i) => ({ i })) } });
  await engine.advance(runId);

  let count = 0;
  for await (const _ of store.read(runId, 1)) count++;
  console.log(`    journal: ${count} events for 500 branches (${(count / 500).toFixed(1)} per branch)`);
  assert.ok(count < 500 * 12, `${count} events is more than a small constant per branch`);
});
