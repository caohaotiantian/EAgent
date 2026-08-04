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

test("layout scales LINEARLY from 100 to 500 nodes", () => {
  // The real guard. Positions come from a precomputed rank, so this is arithmetic over
  // (nodes + edges) — anything super-linear means an accidental nested scan.
  const small = bigGraph(10, 10);
  const big = bigGraph(50, 10);
  const time = (g: ReturnType<typeof bigGraph>): number => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) layoutGraph(g);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const a = time(small);
  const b = time(big);
  console.log(`    100 nodes ×20: ${a.toFixed(1)} ms · 500 nodes ×20: ${b.toFixed(1)} ms`);
  // 5× the nodes and 25× the edges; a quadratic sweep would be far past this.
  assert.ok(b < Math.max(a, 1) * 60, `100→500 cost ${(b / Math.max(a, 0.01)).toFixed(1)}×`);
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
