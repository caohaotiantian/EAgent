/**
 * The subgraph half of validation walks the tree once per distinct child, not once per reference.
 *
 * `rule016Subgraphs` recursed `validateGraph` inside `for (const n of spec.nodes)` with no cache,
 * so a child referenced by B nodes at each of N levels was validated B^N times. Measured on this
 * tree, a chain of two-way delegations at `--max-old-space-size=3072`: depth 16 took 773 ms,
 * depth 18 took 3,807 ms, and depth 20 ran the heap out — where the memoized walk does the same
 * three in 44 ms, 208 ms and 1,145 ms with byte-identical diagnostics. `compile.ts`'s
 * `resolveSubgraphs` already walks that identical tree in linear time with a `reachedAt` map, so
 * the two halves of one walk had different complexity. `compile`'s own docstring promises an editor can call it on
 * every keystroke, and `openWorkspace` puts it on `loom compile`, `loom run`, `loom gates` and
 * `loom approve`.
 *
 * TWO INSTRUMENTS, and the deterministic one is the load-bearing half. `subgraph()` resolver
 * calls count what the walk actually did, byte-identical on any machine; the clock is one
 * absolute bound with room on both sides, never a ratio of two timings.
 *
 * AND THE OUTPUT IS PINNED BESIDE THE COST. A cache that changed which diagnostics an author
 * sees would be a different change; every count below is the number the uncached walk produced.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import { stubResolver } from "./fixtures.ts";

const graph = (name: string, nodes: readonly NodeSpec[], maxDepth: number): GraphSpec =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name, project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 64, maxDepth, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { inp: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["inp"],
    outputs: ["out"],
    nodes: [...nodes],
    edges: [],
  }) as unknown as GraphSpec;

const delegate = (id: string, ref: string): NodeSpec =>
  ({
    id: id as NodeId,
    type: "subgraph",
    reads: ["inp"],
    writes: ["out"],
    subgraph: { ref, inputs: { inp: "inp" }, outputs: { out: "out" } },
    unhandled: true,
  }) as unknown as NodeSpec;

/**
 * A chain of `levels` files, each declaring `branching` nodes pointing at the next.
 *
 * The leaf carries ONE fault — a `function.ref` that is not a ref — so the duplicated-diagnostic
 * half is visible: without a cache the same single fault is reported branching^levels times.
 */
function chain(levels: number, branching: number): { root: GraphSpec; resolver: ResourceResolver; calls: () => number } {
  const subgraphs: Record<string, GraphSpec> = {};
  subgraphs[`subgraph/l${String(levels)}@stable`] = graph(
    `l${String(levels)}`,
    [{ id: "leaf" as NodeId, type: "function", reads: ["inp"], writes: ["out"], function: { ref: "NOT A REF" }, unhandled: true } as unknown as NodeSpec],
    64,
  );
  for (let i = levels - 1; i >= 1; i--) {
    subgraphs[`subgraph/l${String(i)}@stable`] = graph(
      `l${String(i)}`,
      Array.from({ length: branching }, (_, b) => delegate(`d${String(b)}`, `subgraph/l${String(i + 1)}@stable`)),
      64,
    );
  }
  const root = graph("root", Array.from({ length: branching }, (_, b) => delegate(`d${String(b)}`, "subgraph/l1@stable")), 64);

  const inner = stubResolver({ subgraphs });
  let calls = 0;
  const resolver: ResourceResolver = {
    ...inner,
    subgraph(ref: string) {
      calls++;
      return inner.subgraph?.(ref);
    },
  };
  return { root, resolver, calls: () => calls };
}

test("A CHILD IS VALIDATED ONCE PER DISTINCT (ref, depth, trail), not once per referencing node", () => {
  // The deterministic instrument. At depth 12 with two-way branching the uncached walk resolves
  // child specs 40,902 times; the memoized one 336, and 102 once the SECOND walk over the same
  // tree is memoized too. The number is a count of work, not of time, so it is identical on any
  // machine.
  //
  // WHAT THE RESIDUE WAS: `rule017Capabilities` and the GRAPH014 posture floor each call
  // `reachableToolNamesThrough` once per node, and that walk had no cache of its own, so the
  // subtree under every reference was re-walked from scratch. It shares
  // `ValidationContext.toolReachMemo` with the whole validation walk now, keyed
  // `(maxDepth, ref)`. Both numbers are asserted: the loose bound is what keeps the
  // exponential from coming back, and the tight one is what keeps the memo from being
  // silently dropped.
  const { root, resolver, calls } = chain(12, 2);
  const r = compile({ spec: root, resolver, tools: {}, tenantCapabilities: ["*"] });
  const resolved = calls();
  console.log(`    depth 12, branching 2: ${String(resolved)} subgraph() resolutions, ${String(r.diagnostics.length)} diagnostics`);
  assert.ok(resolved < 2000, `${String(resolved)} subgraph resolutions for a 12-level chain — the walk is exponential again`);
  assert.equal(resolved, 102, "one walk per (maxDepth, ref), not one per referencing node");

  // AND THE AUTHOR SEES EXACTLY WHAT THEY SAW. The leaf's single fault is still reported once
  // per node that reaches it, which is what makes the count exponential in the OUTPUT while the
  // walk is not. 12,286 is the number the uncached walk produced.
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics.length, 12_286, "every diagnostic the uncached walk produced, and no more");
  assert.deepEqual(
    [...new Set(r.diagnostics.map((d) => d.code))].sort(),
    ["GRAPH009_NO_BUDGET", "GRAPH010_CONCURRENT_WRITE", "GRAPH015_RESOURCE_NOT_FOUND"],
    "and the same three kinds of fault, re-tagged per referencing node",
  );
});

test("…and a 16-level chain compiles in bounded time instead of seconds", () => {
  // 52-75 ms here; 830-924 ms with the uncached walk, and at depth 20 the uncached walk runs a
  // 3 GB heap out where this finishes in 1,145 ms.
  //
  // ONE ABSOLUTE BOUND, NOT A RATIO, and its margin is stated rather than assumed: 500 ms is
  // about ten times the observed cost and about half the uncached one, which is the widest gap
  // this pair of numbers allows. The load-bearing instrument is still the COUNT in the test
  // above — it cannot flake at all — and this is the constant-factor half a count cannot see.
  const { root, resolver } = chain(16, 2);
  const t0 = process.hrtime.bigint();
  const r = compile({ spec: root, resolver, tools: {}, tenantCapabilities: ["*"] });
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`    depth 16, branching 2: ${elapsed.toFixed(0)} ms, ${String(r.diagnostics.length)} diagnostics`);
  assert.equal(r.diagnostics.length, 196_606, "the same diagnostics, at four levels deeper");
  assert.ok(elapsed < 500, `a 16-level chain took ${elapsed.toFixed(0)} ms`);
});

test("THE ORDINARY HALF: a clean tree still compiles clean, and a real fault is still reported", () => {
  // The cache must not swallow a child's diagnostics, and must not invent one for a child that
  // has none. Two two-level trees, identical but for the leaf.
  // A multi-writer-safe reducer and a declared budget, so the ONLY thing this tree can report is
  // the leaf — the chain above deliberately keeps both faults, and here they would be noise.
  const tidy = (name: string, nodes: readonly NodeSpec[]): GraphSpec =>
    ({
      ...graph(name, nodes, 3),
      policy: { posture: "out", budget: { costUsd: 1 }, expansion: { maxNodes: 64, maxDepth: 3, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { inp: { type: "string", reduce: "replace" }, out: { type: "array", reduce: "append_ordered" } },
    }) as unknown as GraphSpec;

  const clean = (leafRef: string): { root: GraphSpec; resolver: ResourceResolver } => {
    const leaf = tidy("leaf", [
      { id: "leaf" as NodeId, type: "function", reads: ["inp"], writes: ["out"], function: { ref: leafRef }, unhandled: true } as unknown as NodeSpec,
    ]);
    const mid = tidy("mid", [delegate("d0", "subgraph/leaf@stable"), delegate("d1", "subgraph/leaf@stable")]);
    const root = tidy("root", [delegate("d0", "subgraph/mid@stable"), delegate("d1", "subgraph/mid@stable")]);
    return { root, resolver: stubResolver({ subgraphs: { "subgraph/mid@stable": mid, "subgraph/leaf@stable": leaf } }) };
  };

  const ok = clean("function/noop@stable");
  const good = compile({ spec: ok.root, resolver: ok.resolver, tools: {}, tenantCapabilities: ["*"] });
  assert.deepEqual(
    good.diagnostics.filter((d) => d.severity === "error"),
    [],
    "a tree with nothing wrong reports no error",
  );
  assert.equal(good.ok, true);

  const broken = clean("NOT A REF");
  const bad = compile({ spec: broken.root, resolver: broken.resolver, tools: {}, tenantCapabilities: ["*"] });
  assert.equal(bad.ok, false, "and the same tree with a broken leaf is still refused");
  const notFound = bad.diagnostics.filter((d) => d.code === "GRAPH015_RESOURCE_NOT_FOUND");
  assert.equal(notFound.length, 4, "once per node that reaches the leaf: two mids, two leaf references each");
  assert.ok(
    notFound.every((d) => d.message.includes('in subgraph "subgraph/mid@stable": in subgraph "subgraph/leaf@stable": resource "NOT A REF"')),
    "and each one still carries the full path it came down",
  );
  assert.equal(
    good.diagnostics.filter((d) => d.code === "GRAPH015_RESOURCE_NOT_FOUND").length,
    0,
    "while the identical tree with a good leaf reports none — the cache does not invent one either",
  );
});

test("A CYCLE IS STILL A CYCLE, on every route that reaches it", () => {
  // The memo key carries the expansion TRAIL for this reason: `expanding` is what decides
  // GRAPH016_SUBGRAPH_CYCLE, so two nodes at the same depth reaching one child by different
  // routes can genuinely get different answers. Keying on ref-and-depth alone would serve one
  // route's answer to the other.
  const a = graph("a", [delegate("toB", "subgraph/b@stable")], 8);
  const b = graph("b", [delegate("toA", "subgraph/a@stable")], 8);
  const root = graph("root", [delegate("toA", "subgraph/a@stable")], 8);
  const r = compile({
    spec: root,
    resolver: stubResolver({ subgraphs: { "subgraph/a@stable": a, "subgraph/b@stable": b } }),
    tools: {},
    tenantCapabilities: ["*"],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.diagnostics.some((d) => d.code === "GRAPH016_SUBGRAPH_CYCLE"),
    `expected a cycle diagnostic, got ${r.diagnostics.map((d) => d.code).join(", ")}`,
  );
});

test("A CHILD IS VALIDATED AGAINST ITS OWN INDEX, never against its parent's", () => {
  // `compile` now hands `validateGraph` the index it built, and the recursion into a child must
  // DROP it: the child is a different graph, so a parent's reachability, ancestors and fan-out
  // widths would answer the child's rules with another spec's structure.
  //
  // GRAPH001 IS THE VISIBLE ONE. `rule001Reachability` reports every node outside
  // `idx.reachable`, and the child's node ids are not in the PARENT's reachable set — so a
  // leaked index reports both of this child's nodes unreachable, on a tree where nothing is
  // wrong. The control is the assertion under it: the same shape with a genuinely unreachable
  // child node still reports one.
  const fn = (id: string): NodeSpec =>
    ({ id: id as NodeId, type: "function", reads: ["inp"], writes: ["out"], function: { ref: "function/noop@stable" }, unhandled: true }) as unknown as NodeSpec;
  const withEdge = (name: string, nodes: readonly NodeSpec[], edges: readonly unknown[]): GraphSpec =>
    ({ ...graph(name, nodes, 3), edges }) as unknown as GraphSpec;

  const child = withEdge("child", [fn("a"), fn("b")], [{ id: "ab", from: "a", to: "b", kind: "seq" }]);
  const root = graph("root", [delegate("d0", "subgraph/child@stable")], 3);
  const r = compile({
    spec: root,
    resolver: stubResolver({ subgraphs: { "subgraph/child@stable": child } }),
    tools: {},
    tenantCapabilities: ["*"],
  });
  assert.deepEqual(
    r.diagnostics.filter((d) => d.severity === "error"),
    [],
    "a well-formed child reports nothing — a leaked parent index makes both its nodes unreachable",
  );

  // THE CONTROL. Detach `b` and the child's own index is what notices.
  const brokenChild = withEdge("child", [fn("a"), fn("b"), fn("c")], [{ id: "ab", from: "a", to: "b", kind: "seq" }]);
  const broken = compile({
    spec: graph("root", [delegate("d0", "subgraph/child@stable")], 3),
    resolver: stubResolver({ subgraphs: { "subgraph/child@stable": brokenChild } }),
    tools: {},
    tenantCapabilities: ["*"],
  });
  assert.ok(
    broken.diagnostics.some((d) => d.message.includes('in subgraph "subgraph/child@stable"')),
    `the child's own structure is still checked: ${broken.diagnostics.map((d) => d.code).join(", ")}`,
  );
});
