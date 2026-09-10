/**
 * GRAPH010 EXEMPTS A CHANNEL THAT NEVER LEAVES ONE FAN-OUT BRANCH — and refuses everything else.
 *
 * This file is the ledger for a LOOSENING, so the accepts are three and the refusals twenty-five.
 * Each refusal names the condition of `branchLocalChannel` that catches it; if a change to the
 * analysis makes one of them compile, the loosening has moved and the test says which way.
 *
 * SEVEN OF THEM WERE FOUND BY REVIEWERS AFTER THE FIRST VERSION SHIPPED GREEN, and they are the
 * ones to read first — a `subgraph` naming the channel, a `humanGate` delivery scope the census
 * did not cover, a loop whose back-edge source is a SIBLING of the fan-out, a short-circuiting
 * join, a branch node the join does not DECLARE, a SECOND fan-out into the same join, and an
 * `agent` carrying a retry policy it never wrote. Each compiled with zero diagnostics against
 * a predicate whose own suite was green, which is why this file is written as a ledger.
 *
 * TWO OF THE ACCEPTS ARE HERE TO BE HONEST ABOUT WHAT IS ACCEPTED, not to celebrate it: an
 * `error`-edge handler reads the pre-fan-out value rather than the writer's, and the census
 * over-reports so freely that a graph DESCRIPTION mentioning the channel switches the exemption
 * off. Both are stated so the next reader knows they were seen.
 *
 * The runtime facts the exemption rests on are pinned by `run/branch-local-replace.test.ts`,
 * which drives a real Engine over a `replace` channel inside a three-branch fan-out. Nothing here
 * is exported from `src`, and nothing needs to be.
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

test("ACCEPT, and stated rather than hidden: an `error`-edge handler in the branch may read it", () => {
  // The handler runs only when the writer FAILED, and `#withBranchWrites` folds only tasks in
  // state `succeeded` — so it reads the channel's pre-fan-out value, deterministically and
  // identically under every reducer. Accepted, but it is NOT "sees the writer's own value".
  // TWO THINGS MAKE THAT TRUE AND BOTH ARE LOAD-BEARING — `mode: "all"`, and `recover` being a
  // DECLARED member of the join. Each has its own refusal below, and each was measured reading a
  // sibling branch's value when it was missing.
  const s = spec();
  (s.nodes as NodeSpec[]).push({ id: n("recover"), type: "function", reads: ["raw"], writes: ["failures"], function: { ref: "function/recover@stable" } } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("oops"), from: n("read"), to: n("recover"), kind: "error" } as EdgeSpec);
  node(s, "gather", { join: { branches: [n("read"), n("classify"), n("recover")], mode: "all", onBranchError: "fail" } });
  (s.edges as EdgeSpec[]).push({ id: e("j3"), from: n("recover"), to: n("gather"), kind: "join", branches: [n("read"), n("classify"), n("recover")] } as EdgeSpec);
  assert.equal(hasGraph010(s), false);
});

test("REFUSE: the same handler, one word different — the join does not DECLARE it", () => {
  // Quiescence is computed entirely from `join.branches` (`#maybeFireJoin`'s `members`,
  // `stillLive` and `continuesInBranch` all read it), so a node inside the fan-out that the join
  // does not declare never holds the barrier. `mode: "all"` does not save it. Driven on a real
  // Engine before this clause existed: branch `b`'s handler read branch `c`'s `raw`, the run
  // succeeded, and whether it happened at all depended on how many nodes sat between the failure
  // and the reader. `GRAPH008_BRANCH_NOT_CONNECTED` enforces only the other direction.
  const s = spec();
  (s.nodes as NodeSpec[]).push({ id: n("recover"), type: "function", reads: ["raw"], writes: ["failures"], function: { ref: "function/recover@stable" } } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("oops"), from: n("read"), to: n("recover"), kind: "error" } as EdgeSpec);
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: an `agent` in the branch, which the compiler gives a retry policy it never declared", () => {
  // `effectiveRetry` hands `DEFAULT_PROVIDER_RETRY` to any node that reaches a provider, so
  // reading `n.retry` alone refused an author who wrote `maxAttempts: 2` and accepted an `agent`
  // that retries three times.
  const s = spec();
  retype(s, "classify", {
    id: n("classify"),
    type: "agent",
    reads: ["shard", "raw"],
    writes: ["failures"],
    agent: { profile: "profile/x@stable", prompt: "prompt/y@stable", maxTurns: 1 },
  });
  assert.equal(hasGraph010(s), true);
});

test("ACCEPT is fragile on purpose: the DESCRIPTION mentioning the channel refuses", () => {
  // The census is inverted — it serialises everything but the allowed sites and looks for the
  // name — so it is total over any field the schema grows, at the cost of over-reporting. Over-
  // reporting refuses, which is the direction a loosening guard is allowed to be wrong in.
  const s = spec();
  (s.metadata as { description?: string }).description = "reads the raw shard";
  assert.equal(hasGraph010(s), true);
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

test("REFUSE: a loop whose back-edge source is a SIBLING of the fan-out", () => {
  // The shape `multiplicity !== parallelWidth` missed, and the reason W4 asks reachability
  // directly. `applyLoopFactors` calls a node "in the cycle" only when it is `loop.to`,
  // `loop.from`, or between them — `read`/`classify` hang off `seed` but are not on the path
  // back to `tick`, so both reported `multiplicity === parallelWidth === 4` while every pass
  // re-fired the fan onto the SAME branch coordinates. Driven on a real Engine before this
  // clause existed: the reader saw another pass's write, and which one depended on how many
  // nodes the branch had.
  const s = spec();
  (s.channels as Record<string, unknown>)["tickv"] = { type: "number", reduce: "replace" };
  (s.nodes as NodeSpec[]).push({ id: n("tick"), type: "function", reads: ["tickv"], writes: ["tickv"], function: { ref: "function/tick@stable" } } as NodeSpec);
  node(s, "collate", { reads: ["failures", "tickv"] });
  (s.edges as EdgeSpec[]).push({ id: e("t1"), from: n("seed"), to: n("tick"), kind: "seq" } as EdgeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("t2"), from: n("tick"), to: n("collate"), kind: "seq" } as EdgeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("back"), from: n("tick"), to: n("seed"), kind: "loop", maxIterations: 3, until: "tickv > 90" } as EdgeSpec);
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a SHORT-CIRCUITING join over the branch", () => {
  // `#withBranchWrites` returns the projection untouched when the asking branch held nothing, so
  // a reader whose writer failed or wrote nothing falls through to ROOT state. Under `any` the
  // barrier has already applied its CROSS-BRANCH fold there while siblings still run. Driven on
  // a real Engine before this clause existed: with `A` throwing on item 1, an error-path reader
  // in branch 1 read branch 0's value, on a graph that compiled with zero diagnostics.
  const s = spec();
  node(s, "gather", { join: { branches: [n("read"), n("classify")], mode: "any", onBranchError: "skip" } });
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: a SECOND fan-out into the same join, which can fire it with this branch pending", () => {
  // `Engine.#fireEmptyJoin` is a second entrance to the barrier and has NO quiescence test: for a
  // fan-out that materialised no branches it readies every join naming that fan-out's target.
  // Driven on a real Engine before this clause existed, with only the sibling's input changing:
  //   others = ["x"] → failures: ["null","raw-1","raw-2","other"]
  //   others = []    → failures: undefined   ← the join folded before any member committed,
  //                                            `collate` ran on pre-fan-out state, run succeeded
  // `maxWidth: 0` on the sibling edge does the same with no input data at all.
  const s = spec();
  (s.channels as Record<string, unknown>)["others"] = { type: "array", reduce: "replace" };
  (s.channels as Record<string, unknown>)["other"] = { type: "string", reduce: "replace" };
  node(s, "seed", { reads: ["items"], writes: ["shards", "others"] });
  (s.nodes as NodeSpec[]).push({ id: n("read2"), type: "function", reads: ["other"], writes: ["failures"], function: { ref: "function/r2@stable" } } as NodeSpec);
  const all = [n("read"), n("classify"), n("read2")];
  node(s, "gather", { join: { branches: all, mode: "all", onBranchError: "skip" } });
  (s.edges as EdgeSpec[]).push({ id: e("fan2"), from: n("seed"), to: n("read2"), kind: "fanout", over: "others", as: "other", maxWidth: 4 } as EdgeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("j3"), from: n("read2"), to: n("gather"), kind: "join", branches: all } as EdgeSpec);
  assert.equal(hasGraph010(s), true);
});

test("REFUSE: no join declares the branch at all", () => {
  // GRAPH021_FANOUT_WITHOUT_JOIN refuses such a graph anyway; this refuses the EXEMPTION rather
  // than resting on another rule having run.
  const s = spec();
  node(s, "gather", { join: { branches: [], mode: "all", onBranchError: "fail" } });
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
