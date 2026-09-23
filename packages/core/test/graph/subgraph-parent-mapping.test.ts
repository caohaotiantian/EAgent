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
  // Depth: maxDepth 0 means this node's child would be at depth 1, over the budget.
  assert.deepEqual(mapping(parent(BAD, "graph/child@stable", 0), stubResolver({ subgraphs: { "graph/child@stable": CHILD } })), PARENT_HALF);
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

test("A RESOLVED child still gets BOTH halves, each ONCE — the hoist did not duplicate the parent's", () => {
  const msgs = mapping(parent({ inputs: { nope: "gone" }, outputs: { gone: "nope" } }), stubResolver({ subgraphs: { "graph/child@stable": CHILD } }));
  assert.equal(msgs.length, 4, msgs.join("\n"));
  assert.equal(new Set(msgs).size, 4, "no message twice");
});
