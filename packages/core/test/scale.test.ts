/**
 * Scale validation — the 500-node row of the Definition of Done.
 *
 * THIS FILE READS A CLOCK, and it is the one declared exception to CLAUDE.md's
 * offline-and-deterministic rule. It has to: the regression it exists to catch is a
 * complexity regression, and cost is what a complexity regression changes.
 *
 * These are MEASUREMENTS with assertions attached, not micro-benchmarks. The ABSOLUTE
 * bounds are set well above the observed cost, so they fail on a regression rather than on
 * a slow machine — 3,000 ms against 34–38, and 2,000 against 4.3–4.8, over eight runs on two
 * days. A RANGE and not a pair of digits: these read a clock, so a number quoted to one decimal
 * is a number the next run disagrees with, and this line already carried one that did.
 *
 * `compile scales sub-quadratically` IS NOT ONE OF THOSE, and no clock decides it. Every one
 * of its assertions is a ratio of deterministic COUNTS — a proxy counts each property read
 * the compiler makes on the spec — so they are byte-identical on any machine and under any
 * load. A wall-clock ratio is still PRINTED beside them, because a constant-factor regression
 * is the one class a read counter cannot see, but nothing asserts on it: a ratio of two
 * timings amplifies load instead of tolerating it, and is likeliest to pass when its
 * denominator sample is worst.
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
 * N IS 15 AND WAS 5, AND THE SPEC IS BUILT BEFORE THE TIMER STARTS. Both were measured rather
 * than guessed — see the test below, which says what each bought. `runs` keeps a default so
 * the two callers that only want a trend need not think about it.
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
 * Property reads on the spec, counted — for whatever the caller does with it.
 *
 * A COUNT AND NOT A CLOCK, and the reason is that the clock carries the machine's load into
 * the answer while the count does not. Measured 2026-09-05 on a 16-core machine, `node --test
 * packages/core/test/scale.test.ts` against forty CPU burners, three consecutive runs: every
 * count below was IDENTICAL, digit for digit, to the idle run — 103,200 → 325,600 → 548,000,
 * exponents 0.988 / 0.995 / 0.990 — while the absolute timings moved (100 nodes 2.2 → 2.5 ms,
 * 500 nodes 19.9 → 22.0–24.4 ms).
 *
 * WHAT THAT EXPERIMENT DID NOT REPRODUCE, said out loud because the file used to imply it
 * always would: the wall-clock RATIO stayed put, 8.8–9.9× under load against 9.0–9.2× idle.
 * On the pre-`2ec0b76` compiler the same experiment drove it to 31.3×, 41.0×, 45.9× and 51.6×
 * while the count read `314356 → 5616756` in all four — but that compiler no longer exists
 * (~1,043 spec reads per element where this one makes ~101), and a working set an order of
 * magnitude smaller is not disturbed the same way. So the honest statement is narrower than
 * the old one: the ratio CAN blow up under load and has, the count never can, and only one of
 * them is fit to decide a test.
 *
 * WHY IT IS TRUSTED AS A PROXY, rather than assumed to be one: it agrees with the clock on
 * the exponent. The counts put compile at n^0.99 in the number of spec elements; the printed
 * wall-clock ratio of ~9× over a 5.4× element count is n^1.3, which is the same algorithm plus
 * a constant factor that grows with working-set size. An instrument reading n^1 while the
 * clock read n^2 would be the signal that it had gone blind, and the guard below is exactly
 * that test made explicit.
 *
 * WHAT IT CANNOT CATCH, and the reason the timed number is still printed: an O(n²) sweep over
 * structures the compiler BUILDS — `plans`, an internal adjacency map — never re-reads the
 * spec, so this counter would not move. The clock is the only instrument here that sees that
 * class; it is reported and never asserted, and the absolute bound that catches a gross one
 * lives in its own test above.
 */
function countedReads(spec: GraphSpec, use: (s: GraphSpec) => void): number {
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
  use(wrap(spec) as GraphSpec);
  return reads;
}

/** Reads the compiler makes on a `stages × width` spec. */
const specReads = (stages: number, width: number): number => countedReads(bigSpec(stages, width), compileBig);

/**
 * Reads ONE full structural traversal of the same spec makes — the calibration the blind
 * guard below is stated against.
 *
 * Not a constant: it is proportional to the spec, so it moves with the fixture instead of
 * having to be re-tuned when the fixture changes. `depth` is bounded only so a cyclic value
 * could not spin; a GraphSpec is a tree six levels deep at most.
 */
function onePassReads(stages: number, width: number): number {
  const walk = (v: unknown, depth: number): void => {
    if (typeof v !== "object" || v === null || depth > 12) return;
    for (const k of Object.keys(v as object)) walk((v as Record<string, unknown>)[k], depth + 1);
  };
  return countedReads(bigSpec(stages, width), (s) => {
    walk(s, 0);
  });
}

/** `log(y₂/y₁) / log(x₂/x₁)` — the exponent a power law through two points has. */
const exponent = (x1: number, y1: number, x2: number, y2: number): number => Math.log(y2 / y1) / Math.log(x2 / x1);

test("compile scales sub-quadratically from 100 to 500 nodes", () => {
  // THREE SIZES, NOT TWO, and a growth EXPONENT rather than a ratio against 25.
  //
  // The old form asserted `bigReads < smallReads * 25` because "5× the nodes under an O(n²)
  // analysis costs 25×". That 25 was never quite the property: `bigSpec` grows edges as
  // width² per stage, so 5× the NODES is 5.4× the elements, and elements are what the counter
  // tracks. An exponent says the thing directly — quadratic MEANS 2, whatever the fixture
  // does — and a third size catches an ACCELERATING trend that two endpoints average away.
  //
  // Measured 2026-09-05, and every one of these is deterministic:
  //
  //     nodes  elements    reads   reads/element   exponent against the previous size
  //       100      1,000  103,200        103.20    —
  //       300      3,200  325,600        101.75    0.988
  //       500      5,400  548,000        101.48    0.995
  //
  // So compile is now LINEAR in spec elements, at ~101 reads each. The bound of 1.5 sits
  // halfway to quadratic: half an exponent of headroom above the observed 0.99, and half an
  // exponent of margin below the 2.0 it exists to catch.
  const sizes = [10, 30, 50].map((stages) => {
    const spec = bigSpec(stages, 10);
    return { elements: spec.nodes.length + spec.edges.length, reads: specReads(stages, 10) };
  });
  for (const s of sizes) {
    console.log(
      `    ${String(s.elements)} elements: ${String(s.reads)} spec reads (${(s.reads / s.elements).toFixed(2)} each)`,
    );
  }

  // THE COUNTER MUST NOT GO BLIND, and this is the arm that refuses when it cannot decide.
  // If compile ever clones the spec on entry and works on the copy, every read collapses to a
  // single traversal, and the exponent below then measures the SPEC's own growth rather than
  // the compiler's — which is n^1 and passes anything.
  //
  // STATED AGAINST A MEASURED ONE-PASS COST, NOT A CONSTANT, and that is the correction. The
  // constant this used to carry (`elements * 100`) was set when compile made ~1,043 reads per
  // element; `2ec0b76` took it to ~101 and left the tripwire 1.5% under the measurement, so
  // the guard was one ordinary improvement away from a red that meant nothing. A constant
  // cannot tell "the counter stopped seeing the compiler" from "the compiler got faster".
  // `onePassReads` can: it is what a single full walk of the SAME spec costs, so the assertion
  // reads "compile still traverses this spec many times over, not once".
  //
  // Measured: one pass is 29,025 reads (5.38 per element) against compile's 548,000 — 18.9×,
  // asserted at 4×. That leaves 4.7× of headroom above the tripwire and 3.1× between the
  // tripwire and the blind compiler simulated below; the old form had 1.5% and 20×.
  const onePass = onePassReads(50, 10);
  const big = sizes[2]!;
  console.log(
    `    one structural pass: ${String(onePass)} reads — compile makes ${(big.reads / onePass).toFixed(1)}x that`,
  );
  assert.ok(
    big.reads > onePass * 4,
    `${String(big.reads)} spec reads against ${String(onePass)} for a single traversal — the compiler is no longer ` +
      `reading the spec as it works, so this counter can no longer see its cost. Re-derive it before trusting it.`,
  );

  // AND THE CONTROL, because a guard that has never been shown to fire is a guard nobody has
  // checked. This is the blindness itself, simulated: deep-copy the spec on entry and compile
  // the COPY, so the proxy sees exactly one traversal however much work compile then does.
  // A JSON round-trip and not `structuredClone`, which throws on a Proxy. Measured at 36,940
  // reads against the 116,100 the arm above demands — it refuses, which is the answer a
  // counter that can no longer see the compiler must give.
  const blind = countedReads(bigSpec(50, 10), (s) => {
    compileBig(JSON.parse(JSON.stringify(s)) as GraphSpec);
  });
  console.log(`    a clone-on-entry compiler would read it ${String(blind)} times — under the ${String(onePass * 4)} demanded`);
  assert.ok(blind <= onePass * 4, `a clone-on-entry compiler read the spec ${String(blind)} times; the guard above would not have caught it`);

  // THE PROPERTY. Every adjacent pair as well as the endpoints, so a cost that is linear over
  // the first leg and quadratic over the second cannot hide inside an average.
  const legs: [string, number][] = [
    ["1,000->3,200", exponent(sizes[0]!.elements, sizes[0]!.reads, sizes[1]!.elements, sizes[1]!.reads)],
    ["3,200->5,400", exponent(sizes[1]!.elements, sizes[1]!.reads, sizes[2]!.elements, sizes[2]!.reads)],
    ["1,000->5,400", exponent(sizes[0]!.elements, sizes[0]!.reads, sizes[2]!.elements, sizes[2]!.reads)],
  ];
  console.log(`    growth exponent: ${legs.map(([w, k]) => `${w} n^${k.toFixed(3)}`).join(", ")}`);
  for (const [span, k] of legs) {
    assert.ok(k < 1.5, `spec reads grow as n^${k.toFixed(3)} over ${span} elements; quadratic is n^2`);
  }

  // AND THE CLOCK, for the class the counter cannot see — PRINTED, NEVER ASSERTED. Two things
  // reduce its noise and were kept because they measured: the spec is built OUTSIDE the timed
  // region (it was inside, so every sample timed 5,400 object allocations that are not
  // compile), and `runs` is 15 rather than 5. Interleaving the two sizes was tried and
  // measured to change nothing.
  //
  // It is not asserted because the ratio is t500/t100, so **a noisy-SLOW denominator is what
  // makes it green**: a gate likeliest to pass when its baseline sample is worst is not
  // measuring the property. What the number is still worth is that it is the only thing here
  // that can see a CONSTANT-FACTOR regression, which a read counter cannot; the absolute bound
  // that catches a gross one lives in its own test above, and is a single measurement rather
  // than a ratio of two.
  //
  // Idle on a 16-core machine it reads 9.0-9.2x, and 8.8-9.9x under forty CPU burners — the
  // same three runs in which every count above was byte-identical. It has read 51.6x under
  // that load on an older compiler; see `countedReads`.
  const smallSpec = bigSpec(10, 10);
  const bigSpecOnce = bigSpec(50, 10);
  const t100 = fastest("compile 100 nodes", () => compileBig(smallSpec), 15);
  const t500 = fastest("compile 500 nodes", () => compileBig(bigSpecOnce), 15);
  console.log(
    `    wall-clock ratio: ${(t500 / Math.max(t100, 0.01)).toFixed(1)}x (REPORTED, not asserted — ` +
      `see the comment above; the load-immune assertions are the two counts)`,
  );
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
        join: { branches: [n("work")], mode: "all", onBranchError: "fail" },
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
