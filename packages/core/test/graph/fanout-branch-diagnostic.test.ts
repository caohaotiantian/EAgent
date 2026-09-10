/**
 * A TWO-NODE FAN-OUT BRANCH TOOK TWO COMPILES TO DISCOVER, AND NEITHER MESSAGE STATED THE RULE.
 *
 * F1 of `docs/workflow-port-2026-09-09.md` — the one friction entry from the 2026-09-09 port
 * still open. The branch is `read` (a fan-out's target) -> `classify`, both joining at `gather`.
 * The obvious spelling, collecting the branch's LAST node, was refused twice in sequence:
 *
 *     join.branches: ["classify"]        GRAPH021_FANOUT_WITHOUT_JOIN
 *                                          fix: add a join node downstream of "read"
 *                                               with branches: [read]
 *     join.branches: ["read","classify"] GRAPH008_BRANCH_NOT_CONNECTED
 *                                          fix: add an edge read -> gather with kind: join
 *
 * Each message is individually correct, which is why the port lane logged it rather than
 * rewording one. The rule NEITHER states is the union of the two `fix:` lines: *every node in a
 * fan-out branch needs its own entry in `join.branches` AND its own `kind: join` edge into the
 * join*. A reader with two error messages and no rule has no reason to believe a two-node branch
 * is even legal — `README.md`, `examples/README.md` and the compiler all describe a one-node one.
 *
 * It has since acquired a second reader: §A.48's W6 clause keys GRAPH010's branch-local exemption
 * on exactly that inbound edge list, so the invariant a stranger cannot discover is also the one a
 * validator relies on. That is why the shipped example loses GRAPH010's exemption in step 1 below
 * and gets it back when the rule is followed — one edit, both diagnostics.
 *
 * WHAT DOES NOT CHANGE IS WHAT IS ACCEPTED. `rule021FanoutHasJoin` refuses exactly the graphs it
 * refused before; it now looks at what the branch CONTAINS before it suggests a `branches:` list,
 * so the first message is the right one rather than the first of two.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { EdgeSpec, GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import { validateGraph, type Diagnostic } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { TENANT_CAPABILITIES, TOOLS, stubResolver } from "./fixtures.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const diagnose = (s: GraphSpec): readonly Diagnostic[] =>
  validateGraph({
    spec: s,
    resolver: stubResolver(),
    tools: TOOLS,
    tenantCapabilities: TENANT_CAPABILITIES,
    depth: 0,
    expanding: [],
  });

const errorsOf = (s: GraphSpec): readonly Diagnostic[] => diagnose(s).filter((d) => d.severity === "error");

/** `examples/graphs/triage-failures.json` in miniature: a fan-out branch two nodes long. */
function shipped(): GraphSpec {
  return JSON.parse(
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "f1", project: "test", version: 1 },
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
        { id: "plan", type: "function", reads: ["items"], writes: ["shards"], function: { ref: "function/plan@stable" } },
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
        { id: "fan", from: "plan", to: "read", kind: "fanout", over: "shards", as: "shard", maxWidth: 4 },
        { id: "sort", from: "read", to: "classify", kind: "seq" },
        { id: "collect-read", from: "read", to: "gather", kind: "join" },
        { id: "collect", from: "classify", to: "gather", kind: "join" },
        { id: "fold", from: "gather", to: "collate", kind: "seq" },
      ],
    }),
  ) as GraphSpec;
}

/** F1 step 1: the obvious spelling — collect the branch's LAST node, and only that one. */
function f1Step1(): GraphSpec {
  const s = shipped();
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = {
    ...s.nodes[g]!,
    join: { branches: [n("classify")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(
    s.edges.findIndex((x) => x.id === e("collect-read")),
    1,
  );
  return s;
}

test("the shipped shape compiles clean, so every refusal below is the mutation", () => {
  assert.deepEqual(errorsOf(shipped()).map((d) => d.code), []);
});

test("ONE DIAGNOSTIC NAMES THE WHOLE RULE: both branch members and the kind: join edges", () => {
  const d = errorsOf(f1Step1());
  const [g21] = d.filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(g21 !== undefined, `expected GRAPH021; got ${d.map((x) => x.code).join(", ") || "no errors"}`);

  const said = `${g21.message}\n${g21.fix ?? ""}`;
  // THE DEFECT: the fix said `branches: [read]` — the fan-out's target and nothing else — so
  // typing it produced a SECOND error about the missing edge.
  assert.match(said, /\bread\b/, "the fan-out's own target");
  assert.match(said, /\bclassify\b/, "and the node behind it in the SAME branch — this is the half that was missing");
  assert.match(said, /kind: join/, "the edges, which the old message left to GRAPH008 to say later");
  assert.match(said, /gather/, "and the join that already exists, rather than 'add a join node'");
});

test("FOLLOWING THAT FIX LITERALLY COMPILES — one step, not two", () => {
  // This is the acceptance test for the whole row: the author reads one message, does what it
  // says, and is finished. Before, doing what the first message said produced the second.
  const fixed = f1Step1();
  const g = fixed.nodes.findIndex((x) => x.id === n("gather"));
  (fixed.nodes as NodeSpec[])[g] = {
    ...fixed.nodes[g]!,
    join: { branches: [n("read"), n("classify")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  (fixed.edges as EdgeSpec[]).push({ id: e("collect-read"), from: n("read"), to: n("gather"), kind: "join" } as EdgeSpec);

  assert.deepEqual(errorsOf(fixed).map((d) => d.code), [], "the message's own instructions must produce a graph that compiles");
});

test("what is ACCEPTED does not move: a one-node branch is still fine and still says nothing", () => {
  // The cheapest way to get this wrong is to start demanding that every branch node be listed.
  // A branch of one is the common case and the compiler must stay silent on it.
  const s = shipped();
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("sort")), 1);
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect")), 1);
  (s.nodes as NodeSpec[]).splice(s.nodes.findIndex((x) => x.id === n("classify")), 1);
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = {
    ...s.nodes[g]!,
    reads: ["raw"],
    writes: ["failures"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  const codes = errorsOf(s).map((d) => d.code);
  assert.equal(codes.includes("GRAPH021_FANOUT_WITHOUT_JOIN"), false, codes.join(", "));
});

test("a fan-out with NO join anywhere still refuses, and names every node it fanned over", () => {
  // No `gather` at all: the branch runs to the end of the graph. The rule is the same rule, so
  // the list is every node the fan-out encloses — and the message cannot name a join that is
  // not there, so it asks for one.
  const s = shipped();
  (s.nodes as NodeSpec[]).splice(s.nodes.findIndex((x) => x.id === n("gather")), 1);
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect-read")), 1);
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect")), 1);
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("fold")), 1);
  (s.edges as EdgeSpec[]).push({ id: e("on"), from: n("classify"), to: n("collate"), kind: "seq" } as EdgeSpec);

  const [g21] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(g21 !== undefined);
  const said = `${g21.message}\n${g21.fix ?? ""}`;
  assert.match(said, /\bread\b/);
  assert.match(said, /\bclassify\b/);
  assert.match(said, /add a join node/, "there is none to name, so it must ask for one");
});

test("A NESTED FAN-OUT'S NODES ARE NOT THE OUTER JOIN'S BRANCHES — the stack's LAST element", () => {
  // Found by a reviewer of the first cut, and it was the worse half of the two: `includes(e.id)`
  // is a MEMBERSHIP test, and a node two fan-outs deep carries the outer edge id in its stack
  // too. So the outer message listed the inner fan's nodes, and typing that made the outer
  // barrier reachable at two depths — `GRAPH008_JOIN_DEPTH`, on a graph that otherwise
  // COMPILES. The message turned a working edit into a broken one, which is worse than saying
  // too little. The inner JOIN pops back to the outer level and is the node the outer join
  // really does wait on.
  const s = shipped();
  // Put a second fan-out inside the branch: read --fanInner--> sub --join--> subJoin, and let
  // `classify` sit after subJoin at the outer level.
  (s.channels as Record<string, unknown>)["subs"] = { type: "array", reduce: "append_ordered" };
  (s.channels as Record<string, unknown>)["sub"] = { type: "string", reduce: "replace" };
  (s.nodes as NodeSpec[]).push(
    { id: n("sub"), type: "function", reads: ["sub"], writes: ["failures"], function: { ref: "function/sub@stable" } } as NodeSpec,
    { id: n("subJoin"), type: "join", reads: ["failures"], writes: ["failures"], join: { branches: [n("sub")], mode: "all", onBranchError: "fail" } } as NodeSpec,
  );
  (s.nodes as NodeSpec[])[s.nodes.findIndex((x) => x.id === n("read"))] = {
    ...s.nodes[s.nodes.findIndex((x) => x.id === n("read"))]!,
    writes: ["raw", "subs"],
  } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("sort")), 1);
  (s.edges as EdgeSpec[]).push(
    { id: e("fanInner"), from: n("read"), to: n("sub"), kind: "fanout", over: "subs", as: "sub", maxWidth: 2 } as EdgeSpec,
    { id: e("subCollect"), from: n("sub"), to: n("subJoin"), kind: "join" } as EdgeSpec,
    { id: e("onward"), from: n("subJoin"), to: n("classify"), kind: "seq" } as EdgeSpec,
  );
  // Break the outer join so rule021 fires on the OUTER fan-out.
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = { ...s.nodes[g]!, join: { branches: [n("classify")], mode: "all", onBranchError: "fail" } } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect-read")), 1);

  const [outer] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(outer !== undefined, "the outer fan-out is unjoined and must be refused");
  const said = `${outer.message}\n${outer.fix ?? ""}`;
  assert.doesNotMatch(said, /\bsub\b/, "`sub` is one fan-out deeper — it belongs to `fanInner`, not to `fan`");
  assert.match(said, /subJoin/, "the inner JOIN pops back to this level and IS an outer branch member");
});

test("A JOIN ONE LEVEL DOWN IS NOT NAMED AS THIS FAN-OUT'S BARRIER", () => {
  // The third reviewer, on the second fix. `downstream` selected candidate joins by pure
  // REACHABILITY, and a nested fan-out's INNER join is reachable from the outer target — so
  // with no outer join yet drawn, the inner one was named and the author was told to make it
  // the outer barrier. Applied literally that is `GRAPH008_JOIN_DEPTH`: one join reachable at
  // two fan-out depths. Same root cause as the `seq`-wired case below — "reachable" and "is
  // the barrier for THIS level" are different questions, and only the second one is the rule.
  const s = shipped();
  (s.channels as Record<string, unknown>)["subs"] = { type: "array", reduce: "append_ordered" };
  (s.channels as Record<string, unknown>)["sub"] = { type: "string", reduce: "replace" };
  (s.nodes as NodeSpec[]).push(
    { id: n("sub"), type: "function", reads: ["sub"], writes: ["failures"], function: { ref: "function/sub@stable" } } as NodeSpec,
    { id: n("subJoin"), type: "join", reads: ["failures"], writes: ["failures"], join: { branches: [n("sub")], mode: "all", onBranchError: "fail" } } as NodeSpec,
  );
  const r = s.nodes.findIndex((x) => x.id === n("read"));
  (s.nodes as NodeSpec[])[r] = { ...s.nodes[r]!, writes: ["raw", "subs"] } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("sort")), 1);
  (s.edges as EdgeSpec[]).push(
    { id: e("fanInner"), from: n("read"), to: n("sub"), kind: "fanout", over: "subs", as: "sub", maxWidth: 2 } as EdgeSpec,
    { id: e("subCollect"), from: n("sub"), to: n("subJoin"), kind: "join" } as EdgeSpec,
    { id: e("onward"), from: n("subJoin"), to: n("classify"), kind: "seq" } as EdgeSpec,
  );
  // Delete the OUTER join entirely, so `subJoin` is the only join reachable from `read`.
  (s.nodes as NodeSpec[]).splice(s.nodes.findIndex((x) => x.id === n("gather")), 1);
  for (const id of ["collect-read", "collect", "fold"]) {
    const i = s.edges.findIndex((x) => x.id === e(id));
    if (i !== -1) (s.edges as EdgeSpec[]).splice(i, 1);
  }
  (s.edges as EdgeSpec[]).push({ id: e("on2"), from: n("classify"), to: n("collate"), kind: "seq" } as EdgeSpec);

  const [outer] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(outer !== undefined);
  const said = `${outer.message}\n${outer.fix ?? ""}`;
  assert.doesNotMatch(said, /join "subJoin" must declare/, "subJoin sits INSIDE this fan-out; it cannot be its barrier");
  assert.match(said, /add a join node downstream of "read"/, "there is no barrier at this level, so it must ask for one");
});

test("A JOIN WIRED BY A `seq` EDGE IS NOT LISTED AS ONE OF ITS OWN BRANCHES", () => {
  // The other reviewer finding. A join reached by a plain `seq` edge does not pop its level, so
  // it — and everything after it — sat inside its own branch list, and the message asked the
  // author to add the join to its own `branches` and give it a `kind: join` edge to ITSELF.
  // Following that literally produced `GRAPH006_UNMARKED_CYCLE`, and a second GRAPH021 that
  // contradicted the first by saying "add a join node" beside the join it had just named.
  // A branch member is by definition something the barrier waits FOR, hence: an ancestor of it.
  const s = f1Step1(); // join.branches: ["classify"], no `read -> gather` edge
  const i = s.edges.findIndex((x) => x.id === e("collect"));
  (s.edges as EdgeSpec[])[i] = { ...s.edges[i]!, kind: "seq" } as EdgeSpec; // …and not even a join edge

  const [d] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(d !== undefined);
  const said = `${d.message}\n${d.fix ?? ""}`;
  assert.doesNotMatch(said, /join "gather" must declare/, "a join inside the branch cannot be its own barrier");
  assert.doesNotMatch(said, /branches: \[[^\]]*\bgather\b/, "and it can never be one of its own branches");
});

test("A SECOND JOIN AT THE SAME LEVEL MAKES THE FIX STOP DICTATING, rather than guess", () => {
  // The remaining half of the third reviewer's finding: the ancestor filter was skipped whenever
  // more than one join was a candidate, so the un-filtered list came back and could name a join
  // among its own branches. The rule now dictates a `branches:` list ONLY when exactly one
  // candidate sits at the barrier's level — that is the only case where the answer is
  // determined. Everything else gets the rule and the branch, and the author picks.
  const s = f1Step1();
  (s.nodes as NodeSpec[]).push({
    id: n("gather2"),
    type: "join",
    reads: ["failures"],
    writes: ["failures"],
    join: { branches: [n("classify")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("collect2"), from: n("classify"), to: n("gather2"), kind: "join" } as EdgeSpec);

  const [d] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(d !== undefined);
  const said = `${d.message}\n${d.fix ?? ""}`;
  assert.doesNotMatch(said, /join "gather\d?" must declare/, "with two candidates it must not pick one");
  assert.match(said, /one join downstream of "read"/);
  assert.match(said, /read, classify/, "and it still names the branch, which is the part it does know");
});

test("THE `holds N nodes` COUNT DESCRIBES THE BRANCH, not whichever join got named", () => {
  // It used to be taken after the ancestor filter, so adding an unrelated join elsewhere in the
  // graph changed the reported size of a branch that had not moved. A count that answers a
  // different question depending on the rest of the file is worse than no count.
  const withJoin = f1Step1();
  const before = errorsOf(withJoin).find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN")?.message ?? "";

  const plusUnrelated = f1Step1();
  (plusUnrelated.nodes as NodeSpec[]).push({
    id: n("aside"),
    type: "join",
    reads: ["failures"],
    writes: ["failures"],
    join: { branches: [n("collate")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (plusUnrelated.edges as EdgeSpec[]).push({ id: e("aside-in"), from: n("collate"), to: n("aside"), kind: "join" } as EdgeSpec);
  const after = errorsOf(plusUnrelated).find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN")?.message ?? "";

  assert.match(before, /holds 2 nodes \(read, classify\)/);
  assert.equal(after.includes("holds 2 nodes (read, classify)"), true, `the branch did not move; got: ${after}`);
});

test("ONE JOIN, TWO FAN-OUTS: the fix ADDS and never replaces, so two of them compose", () => {
  // The fifth defect and the last lesson. Every earlier cut said `must declare branches: [X]`,
  // where X was built from THIS fan-out's branch alone — so on a join that is the barrier for
  // two fan-outs, applying it literally DELETED the other one's entries. On a join collecting
  // a nested fan-out and a sibling fan-out it did not even converge: it oscillated between two
  // fixes, each re-breaking what the other repaired. And with both arms missing, one compile
  // printed two GRAPH021s about the same join with contradictory lists — no literal reading
  // satisfied both.
  //
  // Narrowing WHEN to dictate was tried three times and failed three times. What is dictated
  // is the thing that had to change: an entry per branch member, ADDED to what the join
  // already declares. That composes across fan-outs and across diagnostics, and cannot delete.
  const s = shipped();
  // `raw` to `append_ordered`: a SECOND fan-out into one join is one of the conditions that
  // switches GRAPH010's branch-local exemption off (§A.48's W6), and that is a different rule.
  // This test is about GRAPH021's fix line, so the fixture gives GRAPH010 nothing to say.
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  // A second, independent fan-out off `plan` into `other`, collected by the SAME `gather`.
  (s.channels as Record<string, unknown>)["others"] = { type: "array", reduce: "replace" };
  (s.channels as Record<string, unknown>)["other"] = { type: "string", reduce: "replace" };
  (s.nodes as NodeSpec[])[s.nodes.findIndex((x) => x.id === n("plan"))] = {
    ...s.nodes[s.nodes.findIndex((x) => x.id === n("plan"))]!,
    writes: ["shards", "others"],
  } as NodeSpec;
  (s.nodes as NodeSpec[]).push({
    id: n("otherNode"),
    type: "function",
    reads: ["other"],
    writes: ["failures"],
    function: { ref: "function/other@stable" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push(
    { id: e("fan2"), from: n("plan"), to: n("otherNode"), kind: "fanout", over: "others", as: "other", maxWidth: 4 } as EdgeSpec,
    { id: e("collect-other"), from: n("otherNode"), to: n("gather"), kind: "join" } as EdgeSpec,
  );
  // `gather` still declares only the FIRST fan-out's arms, so only `fan2` is unjoined.
  const d = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.equal(d.length, 1, d.map((x) => x.message).join(" | "));
  const said = d[0]!.fix ?? "";

  // THE DEFECT: this used to read `must declare branches: [otherNode]`, and typing it dropped
  // `read` and `classify` — turning one error into two on a graph that was one edit from ok.
  assert.doesNotMatch(said, /must declare branches:/, "a whole-list replacement can only delete");
  assert.match(said, /entry in its `branches` for each of otherNode/);
  assert.match(said, /ADD to whatever "gather" already declares/, "the non-destructive instruction is the fix");
  assert.doesNotMatch(said, /\bread\b/, "and it names only what is missing, not the whole final list");

  // Applied ADDITIVELY — the only reading the sentence allows — the graph compiles.
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = {
    ...s.nodes[g]!,
    join: { branches: [n("read"), n("classify"), n("otherNode")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  assert.deepEqual(errorsOf(s).map((x) => x.code), [], "one step, and the first fan-out's arms survive");
});

test("the branch list is the fan-out's OWN nodes, never a sibling fan-out's", () => {
  // Two fan-outs off one node. If the list were 'everything downstream' the message would tell
  // the author to join the other fan's nodes into this one's join, which is worse than saying
  // too little.
  const s = shipped();
  (s.nodes as NodeSpec[]).push({ id: n("other"), type: "function", reads: ["shard"], writes: ["raw"], function: { ref: "function/other@stable" } } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("fan2"), from: n("plan"), to: n("other"), kind: "fanout", over: "shards", as: "shard", maxWidth: 4 } as EdgeSpec);

  const [g21] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(g21 !== undefined, "the new fan-out has no join, so it must be refused");
  const said = `${g21.message}\n${g21.fix ?? ""}`;
  assert.match(said, /\bother\b/);
  assert.doesNotMatch(said, /\bclassify\b/, "classify is under `fan`, not under `fan2`");
});
