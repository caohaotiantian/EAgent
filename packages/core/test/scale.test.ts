/**
 * Scale validation — the 500-node row of the Definition of Done.
 *
 * THIS FILE READS A CLOCK, and it is the one declared exception to CLAUDE.md's
 * offline-and-deterministic rule. It has to: the regression it exists to catch is a
 * complexity regression, and cost is what a complexity regression changes.
 *
 * These are MEASUREMENTS with assertions attached, not micro-benchmarks. The ABSOLUTE
 * bounds are set roughly an order of magnitude above the observed cost, so they fail on a
 * regression rather than on a slow machine — 3,000 ms against an observed 68, 2,000 against
 * an observed 25.
 *
 * `compile scales sub-quadratically` IS THE EXCEPTION TO THAT, and the header used to say
 * otherwise. It is a RATIO between two sizes, its margin is 1.4× and not 10×, and a ratio
 * amplifies load instead of tolerating it — a machine under load slows a 500-node compile
 * far more than a 100-node one. That is why it is the test that flakes, and it now carries
 * a deterministic non-clock half; its own comments hold the measurements.
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
 *
 * N IS 15 AND WAS 5, AND THE SPEC IS BUILT BEFORE THE TIMER STARTS. Both were measured, not
 * guessed — see the test below for the numbers. `runs` keeps a default so the two callers
 * that only want a trend need not think about it.
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

/**
 * Every property read the compiler performs on the spec, counted.
 *
 * A COUNT AND NOT A CLOCK. The timed half of the guard below cannot be made robust by any
 * statistic, and this is why: a machine under load does not slow the two sizes equally.
 * Measured against `node --test packages/core/test/scale.test.ts` with fourteen CPU burners
 * alongside, the failing run read `compile 100 nodes: 4.5 ms` — its ordinary figure — and
 * `compile 500 nodes: 213.3 ms` against an ordinary 55, for `46.9×`. The disturbance is
 * superlinear in working-set size, so a RATIO between two sizes amplifies it instead of
 * cancelling it, and min-of-N cannot dodge what lasts longer than the samples.
 *
 * A count has none of that: it is byte-identical run to run and machine to machine, because
 * it counts what the code does rather than how long the machine took to do it.
 *
 * WHY IT IS TRUSTED AS A PROXY, rather than assumed to be one: it agrees with the clock on
 * the exponent. Reads at 100/200/300/400/500 nodes give slopes of 1.729, 1.759, 1.779 and
 * 1.794 against the 100-node base, and the timed ratio of 17× over the same 5× node count is
 * n^1.75. Two independent instruments putting compile at n^1.8 is the evidence that the
 * counter sees the work.
 *
 * WHAT IT CANNOT CATCH, and the reason the timed half stays: an O(n²) sweep over structures
 * the compiler BUILDS — `plans`, an internal adjacency map — never re-reads the spec, so this
 * counter would not move. The clock is the only instrument here that sees that class, so it
 * is kept despite its noise, and this counter is what makes the pair decidable at all.
 */
function specReads(stages: number, width: number): number {
  let reads = 0;
  const seen = new WeakMap<object, unknown>();
  const wrap = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null) return v;
    const already = seen.get(v);
    if (already !== undefined) return already;
    const p = new Proxy(v, {
      get(t, k, r) {
        reads++;
        return wrap(Reflect.get(t, k, r));
      },
    });
    seen.set(v, p);
    return p;
  };
  compileBig(wrap(bigSpec(stages, width)) as GraphSpec);
  return reads;
}

test("compile scales sub-quadratically from 100 to 500 nodes", () => {
  // THE PROPERTY: 5× the nodes under an O(n²) analysis costs 25×. Both halves below assert
  // against that same 25, because 25 is what quadratic MEANS here and not a tuned threshold.
  //
  // The margin is NOT the order of magnitude this file's header claims for its other bounds,
  // and pretending otherwise is how the timed half got its reputation: on this graph family
  // compile is genuinely about n^1.8, so the true ratio is ~17× and the headroom to
  // quadratic is 1.4×, not 10×. That is a fact about the compiler, not about the test.
  const smallReads = specReads(10, 10);
  const bigReads = specReads(50, 10);
  console.log(`    spec reads: ${String(smallReads)} → ${String(bigReads)} (${(bigReads / smallReads).toFixed(2)}×)`);

  // THE COUNTER MUST NOT GO BLIND, and this is the arm that refuses when it cannot decide.
  // If compile ever clones the spec on entry and works on the copy, every read below
  // collapses to one pass — a few tens of thousands — and the ratio would then measure the
  // SPEC's own growth rather than the compiler's, which is 5.4× and passes anything. A
  // hundred reads per element is far under the ~1,000 observed and far over one pass, so
  // this fails rather than silently certifying.
  const elements = 500 + 4900;
  assert.ok(
    bigReads > elements * 100,
    `only ${String(bigReads)} spec reads for ${String(elements)} nodes+edges — the compiler is no longer reading the ` +
      `spec as it works, so this counter can no longer see its cost. Re-derive the instrument before trusting it.`,
  );
  assert.ok(bigReads < smallReads * 25, `100→500 nodes cost ${(bigReads / smallReads).toFixed(2)}× the spec reads`);

  // AND THE CLOCK, for the class the counter cannot see. Its noise is reduced by the two
  // things that were measured to help, and by nothing that was not: the spec is built OUTSIDE
  // the timed region (it was inside, so every sample timed 5,400 object allocations that are
  // not compile), and `runs` is 15 rather than 5. Under fourteen CPU burners the old form was
  // 14/15 with one 46.9× excursion; this form was 15/15 with the whole spread inside
  // 14.9×–18.9×. Idle, both are 30/30. Interleaving the two sizes was tried and measured to
  // change nothing.
  const smallSpec = bigSpec(10, 10);
  const bigSpecOnce = bigSpec(50, 10);
  const small = fastest("compile 100 nodes", () => compileBig(smallSpec), 15);
  const big = fastest("compile 500 nodes", () => compileBig(bigSpecOnce), 15);
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
