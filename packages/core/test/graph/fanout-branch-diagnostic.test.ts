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
import { TENANT_CAPABILITIES, TOOLS, clone, stubResolver } from "./fixtures.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

/**
 * THE NODE NAMES A `fix:` LINE ENUMERATES, and every assertion below goes through this.
 *
 * Four rounds of `doesNotMatch(/join "X" must declare/)` passed VACUOUSLY once the wording
 * moved on — the rule stopped emitting "must declare" and the guard stopped guarding, silently.
 * That is how a defect this file was written to pin shipped anyway. A pattern that matches
 * PROSE decays with the prose; the NAME SET is what the rule is actually claiming, so that is
 * what these tests read. `namesIn` throwing on an unparseable fix line is deliberate: a fourth
 * sentence shape must break this file rather than quietly return `[]`.
 */
function namesIn(fix: string): readonly string[] {
  const m =
    /for each of (.+?),? (?:and|plus) a `kind: join`/.exec(fix) ??
    /as drawn that is (.+?), and a join placed/.exec(fix);
  assert.ok(m !== null, `fix line enumerates no names — has the sentence changed shape?\n  ${fix}`);
  return m[1]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** The join the fix line offers as the barrier: one name, several, or none ("add a join node"). */
function offeredJoins(fix: string): readonly string[] {
  const one = /give join "([^"]+)" an entry/.exec(fix);
  if (one !== null) return [one[1]!];
  const many = /pick one of the joins ((?:"[^"]+"(?: or )?)+)/.exec(fix);
  if (many !== null) return [...many[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  assert.match(fix, /add a join node downstream of/, `fix line offers no join and does not ask for one:\n  ${fix}`);
  return [];
}

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
  assert.deepEqual(
    offeredJoins(outer.fix ?? ""),
    [],
    "subJoin sits INSIDE this fan-out; it cannot be offered as its barrier, so none may be",
  );
  assert.match(outer.fix ?? "", /add a join node downstream of "read"/, "and one must be asked for");
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
  const fix = d.fix ?? "";
  // THE INVARIANT, stated over the two NAME SETS the sentence carries rather than over its
  // prose: nothing the author is told to wire INTO a barrier may also be offered AS one.
  const offered = offeredJoins(fix);
  const waited = namesIn(fix);
  assert.equal(offered.includes("gather"), false, `a join inside the branch cannot be its own barrier: ${fix}`);
  assert.equal(
    offered.some((j) => waited.includes(j)),
    false,
    `offered ${JSON.stringify(offered)} and waits for ${JSON.stringify(waited)} — an edge from a node to itself`,
  );
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
  const fix = d.fix ?? "";
  // Both candidates are OFFERED — the author chooses, and the set they choose from is named,
  // so they cannot reach for a join that is not one. It used to say "a join downstream of X"
  // and leave the set implicit, which is how `a53-pickone.json` below got a cycle.
  assert.deepEqual([...offeredJoins(fix)].sort(), ["gather", "gather2"]);
  assert.deepEqual(namesIn(fix), ["read", "classify"], "and it still names the branch, which it does know");
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
  // Asserted over the NAME SET, so it survives the sentence being reworded again: what the
  // author is told to add is EXACTLY the missing arm, never the whole final list.
  assert.deepEqual(namesIn(said), ["otherNode"]);
  assert.deepEqual(offeredJoins(said), ["gather"]);
  assert.match(said, /ADD to whatever "gather" already declares/, "the non-destructive instruction is the fix");

  // Applied ADDITIVELY — the only reading the sentence allows — the graph compiles.
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = {
    ...s.nodes[g]!,
    join: { branches: [n("read"), n("classify"), n("otherNode")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  assert.deepEqual(errorsOf(s).map((x) => x.code), [], "one step, and the first fan-out's arms survive");
});

test("A CANDIDATE IS NEVER ALSO A THING TO WAIT FOR — `a53-pickone`, the sixth defect", () => {
  // A refuting reviewer's graph, and it shipped through four rounds because the tests that
  // should have caught it were matching prose the rule had stopped emitting. The shape:
  //
  //     plan --fan--> read --seq--> classify --seq--> gather(join) --join--> gA(join)
  //                                                          \----join--> gB(join)
  //
  // `gather` is reached by a `seq` edge, so it never pops and sits INSIDE the branch; `gA` and
  // `gB` pop and are the two candidates. The ancestor filter added for the single-candidate
  // arm was never applied on the multi-candidate one, so the sentence said "a join downstream
  // of read" over a list containing `gather` — and picking `gather` is a `kind: join` edge
  // from a node to itself: GRAPH006_UNMARKED_CYCLE, plus a second, contradicting GRAPH021.
  //
  // Both halves are asserted, over NAME SETS: which joins are offered, and what they wait for.
  const s = shipped();
  // `raw` to `append_ordered`: rewiring `gather` behind a `seq` edge is one of the conditions
  // that switches GRAPH010's branch-local exemption off (§A.48's W6). That is a different rule,
  // and this test is about GRAPH021's fix line, so the fixture gives GRAPH010 nothing to say.
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = {
    ...s.nodes[g]!,
    join: { branches: [n("classify")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect-read")), 1);
  (s.edges as EdgeSpec[])[s.edges.findIndex((x) => x.id === e("collect"))] = {
    id: e("collect"),
    from: n("classify"),
    to: n("gather"),
    kind: "seq",
  } as EdgeSpec;
  for (const id of ["gA", "gB"]) {
    (s.nodes as NodeSpec[]).push({
      id: n(id),
      type: "join",
      reads: ["failures"],
      writes: ["failures"],
      join: { branches: [n("gather")], mode: "all", onBranchError: "fail" },
    } as NodeSpec);
    (s.edges as EdgeSpec[]).push({ id: e(`to${id}`), from: n("gather"), to: n(id), kind: "join" } as EdgeSpec);
  }
  (s.edges as EdgeSpec[])[s.edges.findIndex((x) => x.id === e("fold"))] = {
    id: e("fold"),
    from: n("gA"),
    to: n("collate"),
    kind: "seq",
  } as EdgeSpec;
  (s.edges as EdgeSpec[]).push({ id: e("foldB"), from: n("gB"), to: n("collate"), kind: "seq" } as EdgeSpec);

  const [d] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined);
  const fix = d.fix ?? "";
  const offered = offeredJoins(fix);
  const waited = namesIn(fix);

  assert.deepEqual([...offered].sort(), ["gA", "gB"], `only the two joins at the barrier's level: ${fix}`);
  assert.equal(offered.includes("gather"), false, "`gather` is inside the branch and must not be offered");
  assert.deepEqual(waited, ["read", "classify", "gather"], "and `gather` IS waited for — it holds a fold");
  // THE INVARIANT the four earlier rounds each broke, in one line.
  assert.equal(
    offered.some((j) => waited.includes(j)),
    false,
    `offered ${JSON.stringify(offered)} and waits for ${JSON.stringify(waited)} — that overlap is the cycle`,
  );

  // And the fix converges in ONE step, for either choice.
  for (const pick of offered) {
    const fixed = clone(s) as unknown as GraphSpec;
    const j = fixed.nodes.findIndex((x) => x.id === n(pick));
    (fixed.nodes as NodeSpec[])[j] = {
      ...fixed.nodes[j]!,
      join: { branches: waited.map((w) => n(w)), mode: "all", onBranchError: "fail" },
    } as NodeSpec;
    for (const w of waited) {
      if (!fixed.edges.some((x) => x.from === n(w) && x.to === n(pick) && x.kind === "join")) {
        (fixed.edges as EdgeSpec[]).push({ id: e(`add-${w}-${pick}`), from: n(w), to: n(pick), kind: "join" } as EdgeSpec);
      }
    }
    assert.deepEqual(
      errorsOf(fixed as GraphSpec).map((x) => x.code),
      [],
      `picking "${pick}" and doing what the line says must compile`,
    );
  }
});

test("WITH TWO CANDIDATES the list is what feeds BOTH — a node feeding only one is not dictated", () => {
  // The other half of the F1 fix, and it needed its own shape: `a53-pickone` is caught by
  // naming the candidates, so a mutation reverting the multi-arm ancestor filter left the whole
  // suite GREEN. An assertion nobody can make fail is the thing this file exists to stop.
  //
  //     plan --fan--> read --seq--> armX --join--> j1
  //                        \--seq--> armY --join--> j2
  //
  // `j1` and `j2` both pop to the barrier's level, so both are candidates. `armX` feeds only
  // `j1` and `armY` only `j2`, so whichever the author picks, one of them cannot take a
  // `kind: join` edge into it without rewiring the graph. Only `read` feeds both, so only
  // `read` may be dictated — and the sentence's list must be true for EITHER choice.
  const s: GraphSpec = JSON.parse(
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "two-candidates", project: "test", version: 1 },
      policy: { posture: "out", expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
      channels: {
        items: { type: "array", reduce: "replace" },
        shards: { type: "array", reduce: "replace" },
        shard: { type: "string", reduce: "replace" },
        raw: { type: "string", reduce: "append_ordered" },
        failures: { type: "array", reduce: "append_ordered" },
        report: { type: "object", reduce: "replace" },
      },
      inputs: ["items"],
      outputs: ["report"],
      nodes: [
        { id: "plan", type: "function", reads: ["items"], writes: ["shards"], function: { ref: "function/plan@stable" } },
        { id: "read", type: "function", reads: ["shard"], writes: ["raw"], function: { ref: "function/read@stable" } },
        { id: "armX", type: "function", reads: ["raw"], writes: ["failures"], function: { ref: "function/x@stable" } },
        { id: "armY", type: "function", reads: ["raw"], writes: ["failures"], function: { ref: "function/y@stable" } },
        { id: "j1", type: "join", reads: ["failures"], writes: ["failures"], join: { branches: ["armX"], mode: "all", onBranchError: "fail" } },
        { id: "j2", type: "join", reads: ["failures"], writes: ["failures"], join: { branches: ["armY"], mode: "all", onBranchError: "fail" } },
        { id: "collate", type: "function", reads: ["failures"], writes: ["report"], function: { ref: "function/collate@stable" } },
      ],
      edges: [
        { id: "fan", from: "plan", to: "read", kind: "fanout", over: "shards", as: "shard", maxWidth: 4 },
        { id: "sx", from: "read", to: "armX", kind: "seq" },
        { id: "sy", from: "read", to: "armY", kind: "seq" },
        { id: "cx", from: "armX", to: "j1", kind: "join" },
        { id: "cy", from: "armY", to: "j2", kind: "join" },
        { id: "o1", from: "j1", to: "collate", kind: "seq" },
        { id: "o2", from: "j2", to: "collate", kind: "seq" },
      ],
    }),
  ) as GraphSpec;

  const [d] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined);
  const fix = d.fix ?? "";
  assert.deepEqual([...offeredJoins(fix)].sort(), ["j1", "j2"]);
  // THE ASSERTION THE MUTATION PROVES LIVE: unfiltered this reads [read, armX, armY].
  assert.deepEqual(namesIn(fix), ["read"], `only what feeds both candidates: ${fix}`);
  // The message still reports the whole branch, which is a different question and stays true.
  assert.match(d.message, /holds 3 nodes \(read, armX, armY\)/);
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
