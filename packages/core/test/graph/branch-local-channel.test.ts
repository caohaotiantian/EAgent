/**
 * GRAPH010 EXEMPTS A CHANNEL THAT NEVER LEAVES ONE FAN-OUT BRANCH — and refuses everything else.
 *
 * This file is the ledger for a LOOSENING, so the accept case is one test and the refusals are
 * fourteen. Each refusal names the condition of `branchLocalChannel` that catches it; if a change
 * to the analysis makes one of them compile, the loosening has moved and the test says which way.
 *
 * THE ACCEPT CASE IS ALSO THE DRIFT GUARD for `sitesAreClassified`. That predicate refuses the
 * whole exemption when a field appears in `NODE_FIELDS`/`EDGE_FIELDS`/`SPEC_FIELDS`/`ALLOWED_FIELDS`
 * that `CHANNEL_SITES` does not classify as channel-naming or channel-free — so adding a field to
 * the schema without saying which it is turns this test red rather than leaving a census with a
 * hole in it. Nothing here is exported from `src`, and nothing needs to be.
 *
 * The runtime facts the exemption rests on are measured in `run/lane-a-branch-local-write.test.ts`
 * (a branch sees its own writes and no sibling's) and in `Engine.#withBranchWrites`' own docstring
 * (it does NOT fold an ancestor's held write, which is why a nested fan-out refuses).
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { EdgeSpec, GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import { validateGraph, type Diagnostic } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { TENANT_CAPABILITIES, TOOLS, stubResolver } from "./fixtures.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

/**
 * `seed --fanout--> read --seq--> classify`, both joining at `gather`, then `collate`.
 *
 * The shipped `examples/graphs/triage-failures.json` in miniature: `raw` is written by the
 * fan-out's own target and read by one node behind it in the same branch, and by nothing else.
 * The join shape is what the compiler forces — dropping `read` from `gather.branches` raises
 * GRAPH021_FANOUT_WITHOUT_JOIN and dropping the `read -> gather` edge raises
 * GRAPH008_BRANCH_NOT_CONNECTED.
 */
function spec(): GraphSpec {
  return JSON.parse(
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "branch-local", project: "test", version: 1 },
      policy: { posture: "out", expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
      channels: {
        items: { type: "array", reduce: "replace" },
        shards: { type: "array", reduce: "replace" },
        shard: { type: "string", reduce: "replace" },
        raw: { type: "string", reduce: "replace" },
        failures: { type: "array", reduce: "append_ordered" },
        report: { type: "object", reduce: "replace" },
      },
      inputs: ["items"],
      outputs: ["report"],
      nodes: [
        { id: "seed", type: "function", reads: ["items"], writes: ["shards"], function: { ref: "function/plan@stable" } },
        { id: "read", type: "function", reads: ["shard"], writes: ["raw"], function: { ref: "function/read@stable" } },
        { id: "classify", type: "function", reads: ["shard", "raw"], writes: ["failures"], function: { ref: "function/classify@stable" } },
        {
          id: "gather",
          type: "join",
          reads: ["failures"],
          writes: ["failures"],
          join: { branches: ["read", "classify"], mode: "all", onBranchError: "fail" },
        },
        { id: "collate", type: "function", reads: ["failures"], writes: ["report"], function: { ref: "function/collate@stable" } },
      ],
      edges: [
        { id: "fan", from: "seed", to: "read", kind: "fanout", over: "shards", as: "shard", maxWidth: 4 },
        { id: "sort", from: "read", to: "classify", kind: "seq" },
        { id: "j1", from: "read", to: "gather", kind: "join", branches: ["read", "classify"] },
        { id: "j2", from: "classify", to: "gather", kind: "join", branches: ["read", "classify"] },
        { id: "fold", from: "gather", to: "collate", kind: "seq" },
      ],
    }),
  ) as GraphSpec;
}

const diagnose = (s: GraphSpec): readonly Diagnostic[] =>
  validateGraph({ spec: s, resolver: stubResolver(), tools: TOOLS, tenantCapabilities: TENANT_CAPABILITIES, depth: 0, expanding: [] });

const hasGraph010 = (s: GraphSpec): boolean =>
  diagnose(s).some((d) => d.severity === "error" && d.code === "GRAPH010_CONCURRENT_WRITE");

/** Every mutation below edits ONE node or ONE edge; the rest of the graph is the accept case. */
const node = (s: GraphSpec, id: string, patch: Partial<NodeSpec>): void => {
  const i = s.nodes.findIndex((x) => x.id === n(id));
  (s.nodes as NodeSpec[])[i] = { ...s.nodes[i]!, ...patch } as NodeSpec;
};
const edge = (s: GraphSpec, id: string, patch: Partial<EdgeSpec>): void => {
  const i = s.edges.findIndex((x) => x.id === e(id));
  (s.edges as EdgeSpec[])[i] = { ...s.edges[i]!, ...patch } as EdgeSpec;
};
/** Swap a node's TYPE, which means swapping the whole node — a stale type block is refused. */
const retype = (s: GraphSpec, id: string, next: unknown): void => {
  const i = s.nodes.findIndex((x) => x.id === n(id));
  (s.nodes as NodeSpec[])[i] = next as NodeSpec;
};

// ── the one shape that is accepted ───────────────────────────────────────────

test("ACCEPT: `replace` on a channel written by the fan-out's target and read only behind it", () => {
  const s = spec();
  const d = diagnose(s);
  assert.equal(
    d.some((x) => x.code === "GRAPH010_CONCURRENT_WRITE"),
    false,
    `expected no GRAPH010; got:\n${d.map((x) => `  ${x.severity} ${x.code}: ${x.message}`).join("\n")}`,
  );
  // …and no other error either, so the graph a stranger writes actually compiles.
  assert.deepEqual(d.filter((x) => x.severity === "error").map((x) => x.code), []);
});

test("the exemption is doing the work — the SAME graph with a reader one node later refuses", () => {
  const s = spec();
  node(s, "collate", { reads: ["failures", "raw"] });
  assert.equal(hasGraph010(s), true, "a reader after the join must still refuse");
});

// ── W5: the census — who else names the channel ──────────────────────────────

test("REFUSE: a reader after the join reads whichever branch sorted last", () => {
  // Measured: three branches writing `mid-0`/`mid-1`/`mid-2` leave `"mid-2"` at the root.
  // Deterministic, and meaningless — `#foldJoin` folds every channel a member wrote.
  const s = spec();
  node(s, "collate", { reads: ["failures", "raw"] });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: the JOIN node itself reading the channel", () => {
  const s = spec();
  node(s, "gather", { reads: ["failures", "raw"] });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a reader BEFORE the fan-out", () => {
  const s = spec();
  node(s, "seed", { reads: ["items", "raw"] });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a second writer, even one ordered behind the first", () => {
  // The two-writer arm does not fire — `read` is an ancestor of `classify`, so their writes are
  // sequential. The census is what catches it, and it must: `#withBranchWrites` folds both
  // contributions at the same branch path and `compareContribution` breaks their tie on node id.
  const s = spec();
  node(s, "classify", { writes: ["failures", "raw"] });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: the channel is a graph OUTPUT", () => {
  const s = spec();
  (s as unknown as { outputs: string[] }).outputs = ["report", "raw"];
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: the channel is a graph INPUT", () => {
  const s = spec();
  (s as unknown as { inputs: string[] }).inputs = ["items", "raw"];
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a `${…}` tool argument names it, outside the branch", () => {
  // `GRAPH004_UNDECLARED_ARG_READ` is a WARNING, so the node need not declare it in `reads` —
  // and `resolveArgs` resolves against `scopeFor`, the whole channel scope.
  const s = spec();
  retype(s, "collate", {
    id: n("collate"),
    type: "tool",
    reads: ["failures"],
    writes: ["report"],
    tool: { name: "fs.write", version: "1.0", args: { path: "out/x.md", body: "${raw}" } },
  });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: an edge expression names it", () => {
  const s = spec();
  edge(s, "sort", { kind: "conditional", when: 'raw != ""' });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a router case names it", () => {
  const s = spec();
  // `shards` moves onto a second node: a router cannot write state (GRAPH005_ROUTER_WRITES).
  retype(s, "seed", {
    id: n("seed"),
    type: "router",
    reads: ["items", "raw", "shards"],
    router: { mode: "expression", cases: [{ when: 'raw != ""', take: [e("fan")] }], fallbackEdge: e("fan") },
  });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a `subgraph` node maps it into a child", () => {
  const s = spec();
  retype(s, "collate", {
    id: n("collate"),
    type: "subgraph",
    reads: ["failures"],
    writes: ["report"],
    subgraph: { ref: "graph/child@stable", inputs: { seed: "raw" }, outputs: { report: "out" } },
  });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a fan-out edge's `over`/`as` names it", () => {
  const s = spec();
  edge(s, "fan", { as: "raw" });
  assert.equal(hasGraph010(s), true);
});

// ── W1–W4: the shape of the branch ───────────────────────────────────────────

test("REFUSE: a nested fan-out inside the branch", () => {
  // `#withBranchWrites` does not fold an ANCESTOR's held write: a node one level deeper reads
  // `null`. Measured on `outer --fanout--> inner`, `inner saw mid: null`.
  const s = spec();
  (s.nodes as NodeSpec[]).push({ id: n("deep"), type: "function", reads: ["raw"], writes: ["failures"], function: { ref: "function/deep@stable" } } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("fan2"), from: n("classify"), to: n("deep"), kind: "fanout", over: "shards", as: "shard", maxWidth: 2 } as EdgeSpec);
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a `router` inside the branch", () => {
  const s = spec();
  retype(s, "classify", {
    id: n("classify"),
    type: "router",
    reads: ["shard", "raw"],
    router: { mode: "expression", cases: [{ when: 'shard != ""', take: [e("j2")] }], fallbackEdge: e("j2") },
  });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a `retry` on a node in the branch", () => {
  const s = spec();
  node(s, "classify", { retry: { maxAttempts: 2 } });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a loop that re-enters the branch", () => {
  const s = spec();
  (s.edges as EdgeSpec[]).push({ id: e("again"), from: n("classify"), to: n("read"), kind: "loop", maxIterations: 2, until: 'shard == ""' } as EdgeSpec);
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: the writer is not the fan-out's target", () => {
  // W2 is what makes "every reader is downstream of the writer" provable from `ancestors` alone.
  // A writer partway down the branch can have siblings in the branch that are neither its
  // ancestors nor its descendants, and those race it.
  const s = spec();
  (s.nodes as NodeSpec[]).push({ id: n("br"), type: "function", reads: ["shard"], function: { ref: "function/br@stable" } } as NodeSpec);
  edge(s, "fan", { to: n("br") });
  (s.edges as EdgeSpec[]).push({ id: e("br-read"), from: n("br"), to: n("read"), kind: "seq" } as EdgeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("j0"), from: n("br"), to: n("gather"), kind: "join", branches: [n("br"), n("read"), n("classify")] } as EdgeSpec);
  node(s, "gather", { join: { branches: [n("br"), n("read"), n("classify")], mode: "all", onBranchError: "fail" } });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: the writer is two fan-outs deep", () => {
  // W1 requires a stack of exactly one. Two levels means the inner join re-emits the fold as its
  // own held write and the outer join folds it again — a second argument this does not make.
  const s = spec();
  (s.nodes as NodeSpec[]).push({ id: n("inner"), type: "function", reads: ["shard"], writes: ["raw"], function: { ref: "function/inner@stable" } } as NodeSpec);
  node(s, "read", { writes: [] });
  node(s, "classify", { reads: ["shard"] });
  (s.edges as EdgeSpec[]).push({ id: e("fan2"), from: n("read"), to: n("inner"), kind: "fanout", over: "shards", as: "shard", maxWidth: 2 } as EdgeSpec);
  (s.nodes as NodeSpec[]).push({ id: n("peek"), type: "function", reads: ["raw"], writes: ["failures"], function: { ref: "function/peek@stable" } } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("ip"), from: n("inner"), to: n("peek"), kind: "seq" } as EdgeSpec);
  assert.equal(hasGraph010(s), true);
});

// ── and the rule's other arm is untouched ────────────────────────────────────

test("the two-unrelated-writers arm still fires, branch-local or not", () => {
  const s = spec();
  (s.nodes as NodeSpec[]).push({ id: n("other"), type: "function", reads: ["shard"], writes: ["raw"], function: { ref: "function/other@stable" } } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("of"), from: n("seed"), to: n("other"), kind: "seq" } as EdgeSpec);
  const d = diagnose(s);
  assert.equal(
    d.some((x) => x.code === "GRAPH010_CONCURRENT_WRITE" && /can run concurrently/.test(x.message)),
    true,
  );
});
