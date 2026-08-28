/**
 * Graph layout, and the 500-node measurement.
 *
 * D8 claims "the browser never runs graph layout". Until this module existed the claim
 * lived inside a JavaScript string served to a browser, where nothing could check it and
 * nothing could measure it. These tests do both — everything except literal paint, which
 * is a browser property and is stated as unmeasured rather than guessed at.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { EdgeSpec, GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { DEFAULT_BOX, dominantState, layoutGraph, type TaskSummary } from "../../src/server/layout.ts";
import { DOCS, compileSkeleton, harness } from "../run/skeleton.ts";
import { resolver } from "../run/skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

// ── placement ────────────────────────────────────────────────────────────────

test("positions come from the COMPILER's layoutRank — one row per rank", () => {
  const g = compileSkeleton();
  const l = layoutGraph(g);
  const rows = new Map<number, number>();
  for (const node of l.nodes) rows.set(node.y, (rows.get(node.y) ?? 0) + 1);
  assert.equal(rows.size, new Set(l.nodes.map((x) => x.rank)).size, "y is a pure function of rank");
});

test("every node in the graph is placed — none silently vanishes", () => {
  const g = compileSkeleton();
  const l = layoutGraph(g);
  assert.deepEqual(
    l.nodes.map((x) => x.id).sort(),
    g.spec.nodes.map((x) => x.id).sort(),
  );
});

test("layout is DETERMINISTIC: the same graph lays out identically", () => {
  const g = compileSkeleton();
  assert.deepEqual(layoutGraph(g), layoutGraph(g));
});

test("the canvas grows to fit the widest row and the deepest rank", () => {
  const g = compileSkeleton();
  const l = layoutGraph(g);
  const rightmost = Math.max(...l.nodes.map((x) => x.x));
  assert.ok(l.width >= rightmost + DEFAULT_BOX.width);
  assert.ok(l.height >= Math.max(...l.nodes.map((x) => x.y)) + DEFAULT_BOX.height);
});

test("the box is a parameter, so a dense view is a caller's choice", () => {
  const g = compileSkeleton();
  const wide = layoutGraph(g, [], DEFAULT_BOX);
  const tight = layoutGraph(g, [], { ...DEFAULT_BOX, width: 90, gapX: 10 });
  assert.ok(tight.width < wide.width);
});

// ── fan-out collapsing ───────────────────────────────────────────────────────

test("N INSTANCES OF ONE NODE RENDER AS ONE SHAPE with a count", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);

  const l = layoutGraph(compileSkeleton(), Object.values(p.tasks));
  const summarize = l.nodes.find((x) => x.id === "summarize")!;
  assert.equal(summarize.count, 5, "five branches, one shape");
  assert.equal(l.nodes.filter((x) => x.id === "summarize").length, 1);
});

test("A COLLAPSED FAN-OUT SHOWS THE WORST STATE, not the commonest", () => {
  // 24 succeeded and one awaiting a gate is a fan-out waiting on a human. Rendering it
  // green would be a lie of omission — and the whole point of collapsing is that one
  // shape has to carry the truth about twenty-five.
  assert.equal(dominantState(["succeeded", "succeeded", "awaiting_gate"]), "awaiting_gate");
  assert.equal(dominantState(["succeeded", "failed"]), "failed");
  assert.equal(dominantState(["succeeded", "succeeded"]), "succeeded");
  assert.equal(dominantState([]), "");
});

test("a node with no tasks yet has no state and no badge", () => {
  const l = layoutGraph(compileSkeleton());
  assert.deepEqual([...new Set(l.nodes.map((x) => x.state))], [""]);
  assert.deepEqual([...new Set(l.nodes.map((x) => x.count))], [0]);
});

// ── edges ────────────────────────────────────────────────────────────────────

test("every edge is routed, with control points the client does not have to invent", () => {
  const g = compileSkeleton();
  const l = layoutGraph(g);
  assert.equal(l.edges.length, g.spec.edges.length);
  for (const edge of l.edges) {
    assert.ok(Number.isFinite(edge.x1) && Number.isFinite(edge.y2));
    assert.equal(edge.midY, (edge.y1 + edge.y2) / 2);
  }
});

test("an edge a run actually took is marked", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);

  const l = layoutGraph(compileSkeleton(), Object.values(p.tasks));
  assert.ok(l.edges.some((x) => x.taken), "a run that fanned out took its fan-out edge");
  assert.ok(l.edges.some((x) => !x.taken), "…and has not yet taken the ones past its gate");
});

// ── the 500-node measurement ─────────────────────────────────────────────────

function bigGraph(stages: number, width: number) {
  const nodes: NodeSpec[] = [];
  const edges: EdgeSpec[] = [];
  for (let s = 0; s < stages; s++) {
    for (let w = 0; w < width; w++) {
      nodes.push({
        id: n(`s${s}_${w}`),
        type: "function",
        reads: s === 0 ? ["seed"] : ["out"],
        writes: ["out"],
        function: { ref: "function/step@stable" },
      });
      if (s > 0) for (let pIdx = 0; pIdx < width; pIdx++) {
        edges.push({ id: e(`e${s}_${w}_${pIdx}`), from: n(`s${s - 1}_${pIdx}`), to: n(`s${s}_${w}`), kind: "seq" });
      }
    }
  }
  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "big", project: "layout", version: 1 },
    policy: { expansion: { maxNodes: 4096, maxDepth: 1, maxFanout: 512, maxLoopIterations: 1 } },
    channels: { seed: { type: "array", reduce: "append_ordered" }, out: { type: "array", reduce: "append_ordered" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes,
    edges,
  };
  return compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
}

test("LAYOUT OF 500 NODES / 4,900 EDGES IS A FEW MILLISECONDS", () => {
  const g = bigGraph(50, 10);
  const t0 = process.hrtime.bigint();
  const l = layoutGraph(g);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    layout 500 nodes / 4900 edges: ${ms.toFixed(2)} ms`);

  assert.equal(l.nodes.length, 500);
  assert.equal(l.edges.length, 4900);
  // An order of magnitude above the observed time: this fails on a complexity regression,
  // not on a slow machine.
  assert.ok(ms < 200, `layout took ${ms.toFixed(1)} ms`);
});

test("layout with 500 live tasks is still a few milliseconds", () => {
  const g = bigGraph(50, 10);
  const tasks: TaskSummary[] = g.spec.nodes.map((node) => ({ nodeId: node.id, state: "succeeded", take: [] }));
  const t0 = process.hrtime.bigint();
  const l = layoutGraph(g, tasks);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    layout + 500 tasks: ${ms.toFixed(2)} ms`);
  assert.equal(l.nodes.filter((x) => x.state === "succeeded").length, 500);
  assert.ok(ms < 200);
});

/**
 * How many property reads `layoutGraph` makes over the compiled graph, counted through a Proxy.
 *
 * The instrument, and the reason it replaced a stopwatch: `layoutGraph` reads the graph as it
 * works, so this number IS its cost, and it is byte-identical run to run. The timing ratio it
 * replaced could not be measured at this scale — re-measured 2026-08-29 over five runs, the
 * 100-node sample came back 1.4, 1.5, 1.7, 23.7 and 58.7 ms, and TWICE the 500-node sample was
 * faster than the 100-node one. A 30-iteration warm-up was tried and changed nothing, so it is
 * not JIT. Copied from `test/scale.test.ts`'s `specReads`, which is the same instrument for the
 * compiler and the precedent for this shape.
 */
function layoutReads(width: number, depth: number): number {
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
  layoutGraph(wrap(bigGraph(width, depth)) as ReturnType<typeof bigGraph>);
  return reads;
}

test("layout scales LINEARLY from 100 to 500 nodes", () => {
  // The real guard. Positions come from a precomputed rank, so this is arithmetic over
  // (nodes + edges) — anything super-linear means an accidental nested scan.
  const small = layoutReads(10, 10);
  const big = layoutReads(50, 10);
  const ratio = big / small;
  console.log(`    layout reads: ${String(small)} → ${String(big)} (${ratio.toFixed(2)}×)`);

  // THE COUNTER MUST NOT GO BLIND — the same refusal `specReads` carries. If layout ever copies
  // the graph on entry and works on the copy, every read collapses to one pass and the ratio
  // measures the GRAPH's growth rather than layout's. Ten reads per element is far under what a
  // real pass costs and far over one, so this fails rather than silently certifying.
  const elements = 500 + 499;
  assert.ok(
    big > elements * 10,
    `only ${String(big)} reads for ${String(elements)} nodes+edges — layout is no longer reading ` +
      `the graph as it works, so this counter can no longer see its cost. Re-derive it before trusting it.`,
  );
  // 5× the nodes. Linear means ~5×; the bound is 10× so a constant-factor wobble is not a
  // failure, while a quadratic sweep — which would be 25× — cannot hide under it.
  assert.ok(big < small * 10, `100→500 cost ${ratio.toFixed(2)}× the graph reads`);
});

test("the layout carries its graphHash, so a client caches structure and never recomputes", () => {
  // The property that makes streaming cheap: a run emitting a thousand task updates
  // changes states, never positions.
  const g = bigGraph(10, 10);
  const l = layoutGraph(g);
  assert.equal(l.graphHash, g.graphHash);

  const withTasks = layoutGraph(g, g.spec.nodes.map((node) => ({ nodeId: node.id, state: "leased" as const })));
  assert.equal(withTasks.graphHash, l.graphHash);
  assert.deepEqual(
    withTasks.nodes.map((x) => [x.id, x.x, x.y]),
    l.nodes.map((x) => [x.id, x.x, x.y]),
    "positions are identical — only state changed",
  );
});
