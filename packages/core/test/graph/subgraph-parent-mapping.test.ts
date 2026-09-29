/**
 * The PARENT's half of a subgraph mapping is refused whether or not the child resolves (§A.98).
 *
 * `subgraph.inputs` maps child channel → PARENT channel and `subgraph.outputs` maps PARENT channel
 * → child channel. Whether each parent-side name is declared is a fact about the parent spec alone,
 * and `GRAPH016_BAD_MAPPING` has refused it since `51ce64f1` — but only after
 * `if (child === undefined) continue;`, so a ref the resolver could not expand skipped it. A
 * resolver with no `subgraph` hook at all (the test skeleton's, and any bare `ResourceResolver`) is
 * that case for EVERY subgraph node: `inputs: {k: "nope"}` with no channel `nope` compiled `ok`, and
 * the child was handed `undefined` at run time. A subgraph cycle and an exceeded depth skipped it too.
 *
 * §A.122 is the other half of the same rule: `requiredMapping`'s SHAPE refusal (an absent or
 * non-object `inputs`/`outputs`) sat below the same `continue`, so `subgraph: {ref}` alone compiled
 * `ok` under a hookless resolver and was refused `GRAPH003_MALFORMED` under a hooked one. The row
 * called the unresolved case a run-time crash. For a resolver that answers the same twice it is
 * not: an unresolved child is not frozen into `RunGraph.subgraphs` either, and the run fails TYPED,
 * `E_RESOURCE_NOT_FOUND`. For a resolver whose `subgraph()` answer changes between the validator's
 * call and `resolveSubgraphs`' it IS — the child is frozen, and `#runSubgraph` fails
 * `E_INTERNAL: TypeError` on `Object.entries(sub.inputs)`. The last test below is that resolver.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import { stubResolver } from "./fixtures.ts";

const CHILD = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "child", project: "test", version: 1 },
  policy: { posture: "out", budget: { costUsd: 1 } },
  channels: { k: { type: "string", reduce: "replace" }, o: { type: "string", reduce: "replace" } },
  inputs: ["k"],
  outputs: ["o"],
  nodes: [{ id: "c", type: "function", reads: ["k"], writes: ["o"], function: { ref: "function/c@stable" } }],
  edges: [],
} as unknown as GraphSpec;

function parent(mapping: { inputs: unknown; outputs: unknown }, ref = "graph/child@stable", maxDepth = 2): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, expansion: { maxNodes: 16, maxDepth, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { path: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["path"],
    outputs: ["out"],
    nodes: [{ id: "sub", type: "subgraph", reads: ["path"], writes: ["out"], subgraph: { ref, ...mapping } }],
    edges: [],
  } as unknown as GraphSpec;
}

/** A resolver with NO `subgraph` hook — `run/skeleton.ts`'s shape. Every ref resolves; no child expands. */
const bare = (): ResourceResolver => {
  const r = stubResolver();
  return { resolve: (ref) => r.resolve(ref), document: () => "Test instructions." };
};

/**
 * A child whose OWN `maxDepth` is 1, holding one subgraph node `deep` → `graph/child@stable`. The
 * depth branch is reachable only there: at the root, `maxDepth: 0` is refused by `expansionOf` and
 * FALLS BACK TO THE DEFAULT, so a root "over the budget" resolves its child and tests nothing.
 * Every assertion on this route also asserts `GRAPH016_DEPTH_EXCEEDED`, so it cannot go vacuous.
 */
function midWith(deep: { inputs: unknown; outputs: unknown }): GraphSpec {
  return {
    ...CHILD,
    metadata: { name: "mid", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    nodes: [{ id: "deep", type: "subgraph", reads: ["k"], writes: ["o"], subgraph: { ref: "graph/child@stable", ...deep } }],
  } as unknown as GraphSpec;
}
/** `code: message` for every diagnostic of a parent → `graph/mid@stable` → `deep` compile. */
function depthRoute(deep: { inputs: unknown; outputs: unknown }): string[] {
  const r = compile({
    spec: parent({ inputs: { k: "path" }, outputs: { out: "o" } }, "graph/mid@stable"),
    resolver: stubResolver({ subgraphs: { "graph/mid@stable": midWith(deep), "graph/child@stable": CHILD } }),
    tools: {},
    tenantCapabilities: ["*"],
  });
  const all = r.diagnostics.map((x) => `${x.code}: ${x.message}`);
  assert.ok(
    all.includes('GRAPH016_DEPTH_EXCEEDED: in subgraph "graph/mid@stable": subgraph "deep" nests to depth 2, over expansion.maxDepth of 1'),
    `the route really is the depth branch: ${JSON.stringify(all)}`,
  );
  return all;
}

function mapping(spec: GraphSpec, resolver: ResourceResolver): string[] {
  const r = compile({ spec, resolver, tools: {}, tenantCapabilities: ["*"] });
  return r.diagnostics.filter((x) => x.code === "GRAPH016_BAD_MAPPING").map((x) => x.message);
}

const BAD = { inputs: { k: "nope" }, outputs: { gone: "o" } };
const PARENT_HALF = [
  'subgraph "sub" maps input "k" from undeclared parent channel "nope"',
  'subgraph "sub" maps output to undeclared parent channel "gone"',
];

test("THE ROW'S REPRO: a resolver with no `subgraph` hook — the parent's half is refused anyway", () => {
  const r = compile({ spec: parent(BAD), resolver: bare(), tools: {}, tenantCapabilities: ["*"] });
  assert.equal(r.ok, false, "an input naming no declared parent channel does not compile");
  assert.deepEqual(mapping(parent(BAD), bare()), PARENT_HALF);
});

test("…and behind every other `continue` in the rule: a missing ref, a subgraph cycle, the depth budget", () => {
  // GRAPH015 reports the missing ref; the parent's own mistake is a second fact beside it.
  assert.deepEqual(mapping(parent(BAD), stubResolver({ missing: ["graph/child@stable"] })), PARENT_HALF);
  // Depth: `deep`, inside a child whose own budget is one level, is over it. (This assertion used
  // `maxDepth: 0` at the root, which falls back to the default and resolved the child — the
  // depth branch was never taken, and a mutation silencing it there left this suite green.)
  const deep = depthRoute({ inputs: { k: "nope" }, outputs: { gone: "o" } }).filter((m) => m.startsWith("GRAPH016_BAD_MAPPING: "));
  assert.deepEqual(deep, [
    'GRAPH016_BAD_MAPPING: in subgraph "graph/mid@stable": subgraph "deep" maps input "k" from undeclared parent channel "nope"',
    'GRAPH016_BAD_MAPPING: in subgraph "graph/mid@stable": subgraph "deep" maps output to undeclared parent channel "gone"',
  ]);
  // Cycle: a child that references itself. The OUTER node resolves and is checked in full; the
  // INNER one is the cycle, and its own parent-side mapping names channels the child declares.
  const selfRef = { ...CHILD, nodes: [...CHILD.nodes, { id: "again", type: "subgraph", reads: ["k"], writes: ["o"], subgraph: { ref: "graph/loop@stable", inputs: { k: "nope" }, outputs: { o: "o" } } }] } as unknown as GraphSpec;
  const cyc = mapping(parent({ inputs: { k: "path" }, outputs: { out: "o" } }, "graph/loop@stable", 4), stubResolver({ subgraphs: { "graph/loop@stable": selfRef } }));
  assert.ok(
    cyc.some((m) => m.includes('subgraph "again" maps input "k" from undeclared parent channel "nope"')),
    `the cycle node's own parent-side mapping is still checked: ${JSON.stringify(cyc)}`,
  );
});

test("THE ORDINARY HALF: declared parent channels compile clean, resolved child or not", () => {
  const good = { inputs: { k: "path" }, outputs: { out: "o" } };
  assert.deepEqual(mapping(parent(good), bare()), []);
  assert.deepEqual(mapping(parent(good), stubResolver({ subgraphs: { "graph/child@stable": CHILD } })), []);
  const r = compile({ spec: parent(good), resolver: stubResolver({ subgraphs: { "graph/child@stable": CHILD } }), tools: {}, tenantCapabilities: ["*"] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
});

/** The GRAPH003 diagnostics about THIS spec's subgraph mapping (not a child's, re-tagged), in order. */
const aboutMapping = (x: { code: string; message: string }): boolean =>
  x.code === "GRAPH003_MALFORMED" && x.message.startsWith('subgraph "');
function malformed(spec: GraphSpec, resolver: ResourceResolver): string[] {
  const r = compile({ spec, resolver, tools: {}, tenantCapabilities: ["*"] });
  return r.diagnostics.filter(aboutMapping).map((x) => x.message);
}

const ABSENT_BOTH = [
  'subgraph "sub" does not declare `inputs` — `inputs` maps child channel to parent channel and is required',
  'subgraph "sub" does not declare `outputs` — `outputs` maps parent channel to child channel and is required',
];

test("§A.122 — an ABSENT mapping is refused whatever the child resolves to (the pin that was residue, flipped)", () => {
  const absent = parent({ inputs: undefined, outputs: undefined });
  // Three ways a child can go unexpanded, beside the one where it resolves (the cycle and the depth
  // budget are the next test's). Every one used to
  // compile an absent mapping clean except `resolved`; `ref resolves, hook answers nothing` is the
  // shipped binary's case, a `subgraph.ref` naming a resource of another kind.
  const routes: Record<string, [GraphSpec, ResourceResolver]> = {
    "resolved": [absent, stubResolver({ subgraphs: { "graph/child@stable": CHILD } })],
    "no `subgraph` hook": [absent, bare()],
    "ref resolves, hook answers nothing": [absent, stubResolver({ subgraphs: {} })],
    "ref missing (GRAPH015)": [absent, stubResolver({ missing: ["graph/child@stable"] })],
  };
  for (const [route, [spec, resolver]] of Object.entries(routes)) {
    assert.deepEqual(malformed(spec, resolver), ABSENT_BOTH, route);
    const r = compile({ spec, resolver, tools: {}, tenantCapabilities: ["*"] });
    assert.equal(r.ok, false, route);
    for (const x of r.diagnostics.filter(aboutMapping)) {
      assert.deepEqual(x.at, { nodeId: "sub" }, route);
      assert.ok(x.fix !== undefined && x.fix.startsWith(`write \``), `${route}: the fix names the literal to write`);
    }
  }
});

test("…each block on its own, and behind a subgraph CYCLE and the DEPTH budget too", () => {
  const deep = depthRoute({ inputs: undefined, outputs: undefined }).filter((m) => m.startsWith("GRAPH003_MALFORMED: "));
  assert.deepEqual(deep, [
    'GRAPH003_MALFORMED: in subgraph "graph/mid@stable": subgraph "deep" does not declare `inputs` — `inputs` maps child channel to parent channel and is required',
    'GRAPH003_MALFORMED: in subgraph "graph/mid@stable": subgraph "deep" does not declare `outputs` — `outputs` maps parent channel to child channel and is required',
  ]);

  assert.deepEqual(malformed(parent({ inputs: undefined, outputs: { out: "o" } }), bare()), [ABSENT_BOTH[0]]);
  assert.deepEqual(malformed(parent({ inputs: { k: "path" }, outputs: undefined }), bare()), [ABSENT_BOTH[1]]);
  // The cycle node `again` declares no `inputs`. The OUTER node resolves and recurses; `again` is
  // the cycle, which skipped the shape refusal as it skipped the names.
  const selfRef = { ...CHILD, nodes: [...CHILD.nodes, { id: "again", type: "subgraph", reads: ["k"], writes: ["o"], subgraph: { ref: "graph/loop@stable", outputs: { o: "o" } } }] } as unknown as GraphSpec;
  // Read unfiltered: the child's diagnostics arrive re-tagged `in subgraph "…": …`.
  const cyc = compile({
    spec: parent({ inputs: { k: "path" }, outputs: { out: "o" } }, "graph/loop@stable", 4),
    resolver: stubResolver({ subgraphs: { "graph/loop@stable": selfRef } }),
    tools: {},
    tenantCapabilities: ["*"],
  }).diagnostics.map((x) => `${x.code}: ${x.message}`);
  assert.ok(
    cyc.some((m) => m.startsWith("GRAPH003_MALFORMED: ") && m.includes('subgraph "again" does not declare `inputs`')),
    `the cycle node's own absent mapping is refused: ${JSON.stringify(cyc)}`,
  );
});

test("…and WRONG-SHAPED is refused unresolved as well — `inputs: 42` is no longer read as \"maps nothing\"", () => {
  // Before, the hoisted name check read a non-object as `{}` and the shape refusal never ran, so
  // this compiled with zero diagnostics on a hookless resolver.
  assert.deepEqual(malformed(parent({ inputs: 42, outputs: "o" }), bare()), [
    'subgraph "sub" declares `inputs` as 42, which is not a channel mapping — `inputs` maps child channel to parent channel and is required',
    'subgraph "sub" declares `outputs` as "o", which is not a channel mapping — `outputs` maps parent channel to child channel and is required',
  ]);
});

test("THE ORDINARY HALF: `{}` — the fix line's own advice — compiles, resolved child or not", () => {
  const empty = parent({ inputs: {}, outputs: {} });
  assert.deepEqual(malformed(empty, bare()), []);
  assert.equal(compile({ spec: empty, resolver: bare(), tools: {}, tenantCapabilities: ["*"] }).ok, true);
  const resolved = compile({ spec: empty, resolver: stubResolver({ subgraphs: { "graph/child@stable": CHILD } }), tools: {}, tenantCapabilities: ["*"] });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.diagnostics));
});

test("ONE REFUSAL PER BLOCK: a resolved child does not get the shape refusal twice", () => {
  const msgs = malformed(parent({ inputs: undefined, outputs: undefined }), stubResolver({ subgraphs: { "graph/child@stable": CHILD } }));
  assert.equal(new Set(msgs).size, msgs.length, msgs.join("\n"));
});

test("A RESOLVED child still gets BOTH halves, each ONCE — the hoist did not duplicate the parent's", () => {
  const msgs = mapping(parent({ inputs: { nope: "gone" }, outputs: { gone: "nope" } }), stubResolver({ subgraphs: { "graph/child@stable": CHILD } }));
  assert.equal(msgs.length, 4, msgs.join("\n"));
  assert.equal(new Set(msgs).size, 4, "no message twice");
});

test("THE CRASH THE ROW NAMED: a resolver whose `subgraph()` answer changes between two calls", () => {
  // The validator asks once, `compile.ts`'s `resolveSubgraphs` asks again. Answering `undefined`
  // to the first and the child to the second skipped the shape refusal AND froze the child, and
  // the run failed `E_INTERNAL: TypeError: Cannot convert undefined or null to object` on
  // `Object.entries(sub.inputs)` in `#runSubgraph` (measured on base, driving `Engine`). A lazy
  // cache-on-miss resolver an `--extension-module` supplies has this shape.
  for (const missFirst of [1, 2, 3]) {
    let calls = 0;
    const lazy: ResourceResolver = {
      ...bare(),
      subgraph: (ref) => (++calls > missFirst && ref === "graph/child@stable" ? CHILD : undefined),
    };
    const r = compile({ spec: parent({ inputs: undefined, outputs: undefined }), resolver: lazy, tools: {}, tenantCapabilities: ["*"] });
    assert.equal(r.ok, false, `missing the first ${String(missFirst)} answer(s)`);
    assert.deepEqual(r.diagnostics.filter(aboutMapping).map((x) => x.message), ABSENT_BOTH);
  }
});
