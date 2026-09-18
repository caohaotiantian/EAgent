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
  // FOUR SHAPES, and the PLURAL one is tried first on purpose: `/for ([^,]+), (?:and|plus) a/`
  // would otherwise match "for each of read, classify, and a …" and hand back "each of read".
  // The singular arrived with §A.65, which made a one-name list the common case for the
  // multi-candidate arm; it is a separate branch here rather than an optional group because an
  // optional group is a pattern that stops distinguishing them.
  const m =
    /for each of (.+?),? (?:and|plus) a `kind: join`/.exec(fix) ??
    /for ([^,]+), (?:and|plus) a `kind: join` edge from \1 into/.exec(fix) ??
    /as drawn that is (.+?), and a join placed/.exec(fix);
  assert.ok(m !== null, `fix line enumerates no names — has the sentence changed shape?\n  ${fix}`);
  const names = m[1]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  // AND THE SENTENCE'S NUMBER MUST AGREE WITH THE LIST. The two list clauses are pinned by the
  // patterns above; the multi-candidate arm's "not one of the nodes below, which are what it waits
  // FOR" is the one clause NOTHING else reads, and reverting it to the plural over a one-name list
  // left the whole file green. Checked here so that every call site enforces it.
  if (/not (?:the node|one of the nodes) below/.test(fix)) {
    assert.match(
      fix,
      names.length === 1
        ? /not the node below, which is what it waits FOR/
        : /not one of the nodes below, which are what it waits FOR/,
      `the "nodes below" clause disagrees with a list of ${names.length}:\n  ${fix}`,
    );
  }
  return names;
}

/**
 * THE JOINS A `fix:` LINE DISCLOSES AS ALREADY CLAIMING THE FAN-OUT'S TARGET — §A.69.
 *
 * `namesIn` reads what the line DICTATES; this reads what it WARNS about, and the two are
 * different sets that overlap in exactly one place. The fan-out's own target is in BOTH — dictated
 * because nothing else clears the error, warned about because dictating it collides — and that
 * single overlap is the whole of what §A.69 was.
 *
 * It reads the NAME SET for the same reason `namesIn` does, and it asserts the two halves of the
 * clause TOGETHER: a clause that names joins but not the refusal they cause tells the author a
 * fact without telling them what it costs, and a line that names the refusal without naming a join
 * is the vacuous pass this file exists to prevent. Returns `[]` only where neither is present.
 */
function claimedIn(fix: string): readonly string[] {
  const m = /NOTE "[^"]+" is this fan-out's own target.*? — but (.+?) already declares? it among/.exec(fix);
  if (m === null) {
    assert.doesNotMatch(
      fix,
      /GRAPH008_JOIN_DEPTH/,
      `the line predicts a GRAPH008_JOIN_DEPTH but names no join that causes it:\n  ${fix}`,
    );
    return [];
  }
  const names = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  assert.ok(names.length > 0, `the claim clause names no join — has the sentence changed shape?\n  ${fix}`);
  // TWO TENSES, AND THE CLAUSE MUST PICK THE TRUE ONE. With one existing claimer the refusal is
  // future ("with the barrier declaring it too … refuses"); with two it is already in this compile
  // ("ALREADY refuses"), because `claimedBy` counts them without the barrier. A pattern accepting
  // only one of the two would have made the other arm's sentence unpinned.
  assert.match(
    fix,
    names.length > 1
      ? /`GRAPH008_JOIN_DEPTH` ALREADY refuses/
      : /with the barrier declaring it too `GRAPH008_JOIN_DEPTH` refuses/,
    `the clause's tense disagrees with ${names.length} claimer(s):\n  ${fix}`,
  );
  return names;
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

  // AND BYTE FOR BYTE, because this is the sentence `examples/graphs/triage-failures.json` is one
  // node away from, and the one §A.53 quotes. §A.65 changed what the DICTATED LIST excludes; on
  // this shape nothing else folds `read` or `classify`, so nothing here may move — a single
  // character of drift is a message change the port would feel and a name-set assertion would not.
  assert.equal(
    g21.message,
    'fanout edge "fan" expands "read" but no downstream join waits on it; the branch it opens holds ' +
      "2 nodes (read, classify), and a join must wait on every one of them",
  );
  assert.equal(
    g21.fix,
    'give join "gather" an entry in its `branches` for each of read, classify, and a `kind: join` edge ' +
      'from each of them into "gather" — every node inside a fan-out branch needs both. ADD to whatever ' +
      '"gather" already declares: one join can be the barrier for more than one fan-out',
  );
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
  // AND `classify` IS NOT DICTATED, because BOTH candidates already declare it — dictating it to
  // whichever the author picks would be the third claimant on a node that already has two
  // (`GRAPH008_JOIN_DEPTH` is in this same compile). `read` is the fan-out's own target and is
  // dictated whatever folds it: `joined` is a CONJUNCTION about `read` — some join declares it in
  // `branches` AND is downstream of it — and naming it for a candidate satisfies both, so a list
  // without it dictates an edit that does not clear this error.
  assert.deepEqual(namesIn(fix), ["read"], `only what no join already folds: ${fix}`);
  assert.deepEqual(countedIn(d.message).absent.get("classify"), { reason: "folded", by: ["gather", "gather2"] });
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

/**
 * `a53-pickone` — a refuting reviewer's graph, and the fixture two tests below share.
 *
 *     plan --fan--> read --seq--> classify --seq--> gather(join) --join--> gA(join)
 *                                                          \----join--> gB(join)
 *
 * `gather` is reached by a `seq` edge, so it never pops and sits INSIDE the branch; `gA` and `gB`
 * pop and are the two candidates. It also already declares `classify`, which is §A.65's half.
 */
function a53PickOne(): GraphSpec {
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

  return s;
}

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
  const s = a53PickOne();
  const [d] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined);
  const fix = d.fix ?? "";
  const offered = offeredJoins(fix);
  const waited = namesIn(fix);

  assert.deepEqual([...offered].sort(), ["gA", "gB"], `only the two joins at the barrier's level: ${fix}`);
  assert.equal(offered.includes("gather"), false, "`gather` is inside the branch and must not be offered");
  // ONLY `read` IS DICTATED, and that is §A.65. `classify` is already folded by the branch's own
  // inner join `gather`; `gather` is already folded by BOTH candidates, so adding it to whichever
  // one the author picks would be a third claimant. A second folder is what §A.64 refuses. `read`
  // is the fan-out's target, the node `joined`'s two conjuncts are both about, and is dictated
  // whatever folds it.
  assert.deepEqual(waited, ["read"], `the barrier waits for what no join already folds: ${fix}`);

  // AND THE MESSAGE SAYS WHY EACH MISSING NAME IS MISSING, with its folders named. Read off the
  // sentence by a parser that throws on a shape it does not know, so a rewording cannot pass this.
  const { counted, absent } = countedIn(d.message);
  assert.deepEqual(counted, ["read", "classify", "gather"], "the count is still what the branch CONTAINS");
  assert.deepEqual([...absent.keys()].sort(), ["classify", "gather"]);
  assert.deepEqual(absent.get("classify"), { reason: "folded", by: ["gather"] });
  assert.deepEqual(absent.get("gather"), { reason: "folded", by: ["gA", "gB"] });
  // THE INVARIANT the four earlier rounds each broke, in one line.
  assert.equal(
    offered.some((j) => waited.includes(j)),
    false,
    `offered ${JSON.stringify(offered)} and waits for ${JSON.stringify(waited)} — that overlap is the cycle`,
  );

  // THE CLAIM, STATED THE WAY IT IS TRUE: following the dictated line introduces NO diagnostic the
  // first compile did not print, and both remedies are in that one output. It is NOT "converges in
  // one compile" — §A.65's own words — because the dictated edit alone still exits 1 here: this
  // fixture also carries a `GRAPH008_JOIN_DEPTH` on `gather`, which the first compile printed and
  // whose own `fix:` line closes it. Before §A.65,
  // the dictated list named `classify` as well, and applying it printed TWO `GRAPH008_JOIN_DEPTH`s:
  // one on `gather` (which the first compile had already printed, because `gA` and `gB` both claim
  // it) and one on `classify`, WHICH NO LINE IN THE FIRST COMPILE NAMED. Converging then took one
  // edit GRAPH008 dictates plus one nothing dictates.
  //
  // `writesHeldForJoin` is a property of the TASK'S OWN DEPTH (`run/engine.ts`), so every join
  // naming a node inside a fan-out folds that node's writes; `gather` sits inside the branch and
  // already declares `classify`, so dictating `classify` for the barrier gave it two folders.
  //
  // What is asserted below is the whole claim: the dictated edit introduces NO diagnostic the
  // first compile did not print, and the one it leaves is closed by that compile's OTHER `fix:`
  // line. No edit here is invented.
  const firstCompile = errorsOf(s);
  const rest = firstCompile.filter((x) => x.code !== "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.deepEqual(
    rest.map((x) => `${x.code}@${String(x.at?.nodeId)}`),
    ["GRAPH008_JOIN_DEPTH@gather"],
    `the first compile's other line, which the convergence below is allowed to follow: ${rest.map((x) => x.message).join(" | ")}`,
  );

  for (const pick of offered) {
    const other = offered.find((o) => o !== pick)!;
    const fixed = clone(s) as unknown as GraphSpec;
    const j = fixed.nodes.findIndex((x) => x.id === n(pick));
    // ADD to whatever it already declares — the fix line's own word, and `gather` is already there.
    const had = (fixed.nodes[j]! as NodeSpec).join!.branches;
    (fixed.nodes as NodeSpec[])[j] = {
      ...fixed.nodes[j]!,
      join: { branches: [...had, ...waited.filter((w) => !had.includes(n(w))).map((w) => n(w))], mode: "all", onBranchError: "fail" },
    } as NodeSpec;
    for (const w of waited) {
      if (!fixed.edges.some((x) => x.from === n(w) && x.to === n(pick) && x.kind === "join")) {
        (fixed.edges as EdgeSpec[]).push({ id: e(`add-${w}-${pick}`), from: n(w), to: n(pick), kind: "join" } as EdgeSpec);
      }
    }
    const afterPick = errorsOf(fixed as GraphSpec);
    assert.deepEqual(
      afterPick.map((x) => `${x.code}@${String(x.at?.nodeId)}`),
      ["GRAPH008_JOIN_DEPTH@gather"],
      `picking "${pick}" must leave only what the first compile already printed: ${afterPick.map((x) => x.message).join(" | ")}`,
    );
    assert.deepEqual(
      afterPick.map((x) => x.fix),
      rest.map((x) => x.fix),
      "and the same remedy, so the author has not been handed a new problem",
    );

    // THE ONE REMAINING EDIT, and GRAPH008's own line dictates it: `other` drops `gather` from
    // `branches`, drops its `kind: join` edge from `gather`, and takes the barrier's result as an
    // arm. (Its line names "gA" as the keeper both times — which join to keep is the author's
    // choice, and picking `gB` is the mirror of the same sentence.)
    const o = fixed.nodes.findIndex((x) => x.id === n(other));
    (fixed.nodes as NodeSpec[])[o] = {
      ...fixed.nodes[o]!,
      join: { branches: [n(pick)], mode: "all", onBranchError: "fail" },
    } as NodeSpec;
    const drop = fixed.edges.filter((x) => x.to === n(other) && x.from === n("gather") && x.kind === "join");
    assert.equal(drop.length, 1, "the `kind: join` edge GRAPH008's line says to drop");
    for (const x of drop) (fixed.edges as EdgeSpec[]).splice(fixed.edges.indexOf(x), 1);
    (fixed.edges as EdgeSpec[]).push({ id: e(`chain-${pick}-${other}`), from: n(pick), to: n(other), kind: "join" } as EdgeSpec);

    assert.deepEqual(
      errorsOf(fixed as GraphSpec).map((x) => x.code),
      [],
      `picking "${pick}" converges on the two lines of ONE compile, with no edit neither dictates`,
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
  // §A.57, and this graph is where the disclosure's PREDICATE is pinned: `armX` does run into a
  // join the fix offers (`j1`), so "runs into a join it offers" would be false of the sentence.
  // What drops it from the list is that it does not run into EVERY candidate, and the message
  // must say so — the whole point of the multi-candidate filter is a list true for either choice.
  assert.match(d.message, /run into every join it offers — "armX", "armY" do not, so they are in this count and not in that list/);
  // AND IT PROMISES NO REFUSAL. The first cut of this clause said a join "must wait on every one
  // of them — directly, or through another branch node that folds it", and a reviewer compiled
  // both halves false: nothing refuses a branch node left unfolded, and the escape cannot exist
  // for the nodes the clause names — ancestry being transitive, with ONE candidate. With two it
  // can exist for whichever join the author picks, which makes the promise uncheckable rather
  // than false; the removal stands on the first reason either way.
  assert.doesNotMatch(d.message, /must wait on every one of them/, "the naming form may not promise a refusal");
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

/**
 * THE HELD INNER JOIN — the same defect, in the rule next door (§A.56), and the pair of name sets
 * one diagnostic carries (§A.57).
 *
 * `GRAPH008_HELD_JOIN_UNCOLLECTED` said `add "X" to the enclosing join's \`branches\`` and stopped
 * there, which is the F1 shape exactly: the entry is one edit and the `kind: join` edge is the
 * other, so following the line literally produced `GRAPH008_BRANCH_NOT_CONNECTED` next. Measured
 * on `examples/graphs/triage-failures.json` plus an inner
 * `read --fanout(subs)--> sub --join--> subJoin`: two compiles to converge, and three when the
 * outer join is also incomplete so GRAPH021 refuses in the same run.
 *
 * The same graph is what §A.57 is about: GRAPH021's count is what the branch CONTAINS and its
 * dictated list is what a barrier can be told to WAIT ON, `subJoin` is in the first and not the
 * second, and the sentence disclosed neither.
 */

/** `shipped()` with an inner fan-out held inside the outer branch, and nothing collecting it. */
function heldInner(): GraphSpec {
  const s = shipped();
  (s.channels as Record<string, unknown>)["subs"] = { type: "array", reduce: "append_ordered" };
  (s.channels as Record<string, unknown>)["sub"] = { type: "string", reduce: "replace" };
  // `read` fanning out inside its own branch switches GRAPH010's branch-local exemption off
  // (§A.48's W6). That is a different rule; these tests are about the two messages, so the
  // fixture gives GRAPH010 nothing to say.
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  const r = s.nodes.findIndex((x) => x.id === n("read"));
  (s.nodes as NodeSpec[])[r] = { ...s.nodes[r]!, writes: ["raw", "subs"] } as NodeSpec;
  (s.nodes as NodeSpec[]).push(
    { id: n("sub"), type: "function", reads: ["sub"], writes: ["failures"], function: { ref: "function/sub@stable" } } as NodeSpec,
    { id: n("subJoin"), type: "join", reads: ["failures"], writes: ["failures"], join: { branches: [n("sub")], mode: "all", onBranchError: "fail" } } as NodeSpec,
  );
  (s.edges as EdgeSpec[]).push(
    { id: e("fanInner"), from: n("read"), to: n("sub"), kind: "fanout", over: "subs", as: "sub", maxWidth: 2 } as EdgeSpec,
    { id: e("subCollect"), from: n("sub"), to: n("subJoin"), kind: "join" } as EdgeSpec,
  );
  return s;
}

/**
 * THE TWO EDITS A HELD JOIN'S `fix:` DICTATES, read off the sentence rather than assumed.
 *
 * Same contract as `namesIn`: it THROWS on a line it does not recognise, so a reworded `fix:`
 * breaks this file instead of quietly asserting nothing. The old line matched only the first
 * half — no `kind: join` clause existed to find — which is what made following it two compiles.
 *
 * THE REFERENT IS PARSED TOO, and INNERMOST is part of the pattern rather than prose around it.
 * Under double nesting "the fan-out X is inside" names two fan-outs, and only the inner one's
 * barrier works: collecting a doubly-held join with the OUTER barrier makes that barrier reachable
 * at two depths and fails closed on `GRAPH008_JOIN_DEPTH`, while the inner one compiles. So the
 * adjective decides whether following the line converges, and dropping it must break this file.
 */
function heldFixEdits(fix: string): {
  readonly entry: string;
  readonly edgeFrom: string;
  readonly barrierOf: string;
} {
  const entry = /an entry in its `branches` for "([^"]+)"/.exec(fix);
  const edge = /`kind: join` edge from "([^"]+)" into that join/.exec(fix);
  const barrier = /the barrier of the INNERMOST fan-out "([^"]+)" is inside/.exec(fix);
  assert.ok(entry !== null, `fix line dictates no \`branches\` entry — has the sentence changed shape?\n  ${fix}`);
  assert.ok(edge !== null, `fix line dictates no \`kind: join\` edge — THAT IS THE DEFECT §A.56 closed:\n  ${fix}`);
  assert.ok(barrier !== null, `fix line names no INNERMOST enclosing fan-out — that adjective is load-bearing:\n  ${fix}`);
  return { entry: entry[1]!, edgeFrom: edge[1]!, barrierOf: barrier[1]! };
}

/**
 * THE NODES GRAPH021'S MESSAGE COUNTS, AND THE REASON IT GIVES FOR EACH ONE IT DOES NOT DICTATE.
 *
 * §A.57 put a disclosure clause on this message; §A.65 gave it a SECOND reason, because a branch
 * member an inner join already folds is now dropped from the dictated list too. Reading only the
 * count would let either reason be reworded into nothing, so this parser reads the whole clause
 * and THROWS on a fragment it does not recognise — the same contract as `namesIn` and
 * `heldFixEdits`. The three sentence shapes are exhaustive by construction: reason 1 alone (the
 * §A.57 wording, unchanged), reason 2 alone, and both.
 */
type Absent = { readonly reason: "unreached" | "folded"; readonly by: readonly string[] };

const QUOTED_LIST = /^(?:"[^"]+")(?:, "[^"]+")*$/;
const names = (list: string): readonly string[] => [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

function countedIn(message: string): {
  readonly counted: readonly string[];
  readonly absent: ReadonlyMap<string, Absent>;
} {
  const m = /holds \d+ nodes \(([^)]+)\)/.exec(message);
  assert.ok(m !== null, `message reports no branch count — has the sentence changed shape?\n  ${message}`);
  const counted = m[1]!.split(",").map((s) => s.trim()).filter((s) => s.length > 0);

  const disclosed = /, and the `fix:` line dictates (.+?), so (?:they are|it is) in this count and not in that list/.exec(message);
  if (disclosed === null) {
    // No clause is legal only in the AGREEING form, which must still say what it always said.
    // (The one-member branch prints no `holds N nodes` clause at all and never reaches here —
    // the count assertion above has already thrown.)
    assert.match(
      message,
      /, and a join must wait on every one of them$/,
      `message neither discloses a difference nor states the agreeing form — what is it saying?\n  ${message}`,
    );
    return { counted, absent: new Map() };
  }

  const [head, tail] = disclosed[1]!.split(" — ");
  assert.ok(tail !== undefined, `disclosure clause gives no reasons after an em dash:\n  ${message}`);
  const absent = new Map<string, Absent>();

  /** `"x" is already folded by "j"`, one per name, joined with `, and `. */
  const readFolded = (text: string): void => {
    for (const clause of text.split(", and ")) {
      const f = /^"([^"]+)" is already folded by ((?:"[^"]+")(?:, "[^"]+")*)$/.exec(clause);
      assert.ok(f !== null, `unrecognised reason fragment — has the sentence changed shape?\n  ${clause}\n  ${message}`);
      absent.set(f[1]!, { reason: "folded", by: names(f[2]!) });
    }
  };

  /** `"x", "y" do not` / `"x" does not` — §A.57's reason, byte-identical. */
  const readUnreached = (list: string): void => {
    assert.match(list, QUOTED_LIST, `unrecognised name list in the disclosure clause:\n  ${list}\n  ${message}`);
    for (const id of names(list)) absent.set(id, { reason: "unreached", by: [] });
  };

  if (head === "the ones that run into every join it offers") {
    const one = /^((?:"[^"]+")(?:, "[^"]+")*) (?:do|does) not$/.exec(tail);
    assert.ok(one !== null, `reason-1 clause is not a name list — changed shape?\n  ${tail}\n  ${message}`);
    readUnreached(one[1]!);
  } else if (head === "the ones no other join already folds") {
    readFolded(tail);
  } else if (head === "the ones that run into every join it offers and that no other join already folds") {
    const both = /^((?:"[^"]+")(?:, "[^"]+")*) (?:do|does) not, and (.+)$/.exec(tail);
    assert.ok(both !== null, `two-reason clause does not carry both reasons — changed shape?\n  ${tail}\n  ${message}`);
    readUnreached(both[1]!);
    readFolded(both[2]!);
  } else {
    assert.fail(`unrecognised disclosure criterion — a fourth reason must break this file:\n  ${head}\n  ${message}`);
  }
  return { counted, absent };
}

test("A HELD INNER JOIN'S fix: NAMES BOTH HALVES — the entry AND the `kind: join` edge", () => {
  const found = errorsOf(heldInner());
  assert.deepEqual(found.map((d) => d.code), ["GRAPH008_HELD_JOIN_UNCOLLECTED"], "one diagnostic, so its fix is the whole remedy");

  const fix = found[0]!.fix ?? "";
  const edits = heldFixEdits(fix);
  assert.equal(edits.entry, "subJoin");
  assert.equal(edits.edgeFrom, "subJoin");
  // The F1 lesson, in the words §A.53 settled on: the entry is added, never a replacement.
  assert.match(fix, /ADDED to whatever the join already declares/);
  // AND IT ADMITS THERE MAY BE NO SUCH JOIN. "the enclosing join" reads as a reference to
  // something that exists; on a fan-out with no barrier at all there is nothing to add an entry
  // to, and the author has to draw one first. Found by a reviewer, on a graph where GRAPH021 was
  // simultaneously saying "add a join node downstream of ...".
  assert.match(fix, /adding one if that fan-out has none/);
});

/** `heldInner()` with a THIRD level: `sub --fanout(deeps)--> deep --join--> deepJoin`. */
function doubleNested(): GraphSpec {
  const s = heldInner();
  (s.channels as Record<string, unknown>)["deeps"] = { type: "array", reduce: "append_ordered" };
  (s.channels as Record<string, unknown>)["deep"] = { type: "string", reduce: "replace" };
  const i = s.nodes.findIndex((x) => x.id === n("sub"));
  (s.nodes as NodeSpec[])[i] = { ...s.nodes[i]!, writes: ["failures", "deeps"] } as NodeSpec;
  (s.nodes as NodeSpec[]).push(
    { id: n("deep"), type: "function", reads: ["deep"], writes: ["failures"], function: { ref: "function/deep@stable" } } as NodeSpec,
    { id: n("deepJoin"), type: "join", reads: ["failures"], writes: ["failures"], join: { branches: [n("deep")], mode: "all", onBranchError: "fail" } } as NodeSpec,
  );
  (s.edges as EdgeSpec[]).push(
    { id: e("fanDeep"), from: n("sub"), to: n("deep"), kind: "fanout", over: "deeps", as: "deep", maxWidth: 2 } as EdgeSpec,
    { id: e("deepCollect"), from: n("deep"), to: n("deepJoin"), kind: "join" } as EdgeSpec,
  );
  return s;
}

test("the held join's fix: points at ITS OWN fan-out's barrier, and says INNERMOST", () => {
  // Two reviewer findings in one place. First: a sibling fan's barrier, wired with edits of the
  // SHAPE this line dictates, compiles clean — and §A.64 settled that this is CORRECT rather than
  // a gap: measured on a real `Engine`, the sibling-fan spelling folds every contribution exactly
  // once (n=8 against 8) and only the ORDER differs. What §A.64 did refuse is a node inside a
  // fan-out with TWO joins folding it, which is a different graph — see `join-depth.test.ts`.
  // What is pinned HERE is still only that the sentence names WHICH join it means rather than
  // papering over it: a reader who follows it converges, and a reader who does not still has a
  // referent to argue with.
  const [held] = errorsOf(heldInner()).filter((x) => x.code === "GRAPH008_HELD_JOIN_UNCOLLECTED");
  const edits = heldFixEdits(held!.fix ?? "");
  assert.equal(edits.barrierOf, "subJoin", "the referent is the fan-out the held join is inside");
  assert.doesNotMatch(held!.fix ?? "", /any join|whichever join/, "no suggestion that any join one level up will do");
});

test("INNERMOST IS LOAD-BEARING: a doubly-held join collected one level too far out is refused", () => {
  // Second finding. Under double nesting "the fan-out X is inside" names TWO fan-outs, and the
  // control below is why the adjective had to be added rather than left to the reader.
  const s = doubleNested();
  const codes = errorsOf(s).map((d) => d.code);
  assert.deepEqual(codes, ["GRAPH008_HELD_JOIN_UNCOLLECTED", "GRAPH008_HELD_JOIN_UNCOLLECTED"], codes.join(", "));

  const [deep] = errorsOf(s).filter((x) => x.code === "GRAPH008_HELD_JOIN_UNCOLLECTED" && x.at?.nodeId === n("deepJoin"));
  assert.equal(heldFixEdits(deep!.fix ?? "").barrierOf, "deepJoin");

  const collect = (g: GraphSpec, join: string, arm: string): GraphSpec => {
    const i = g.nodes.findIndex((x) => x.id === n(join));
    const j = g.nodes[i]!.join!;
    (g.nodes as NodeSpec[])[i] = { ...g.nodes[i]!, join: { ...j, branches: [...j.branches, n(arm)] } } as NodeSpec;
    (g.edges as EdgeSpec[]).push({ id: e(`x-${arm}-${join}`), from: n(arm), to: n(join), kind: "join" } as EdgeSpec);
    return g;
  };

  // INNERMOST — `deepJoin` into `subJoin`, `subJoin` into `gather`. Each held join goes to the
  // barrier of the fan-out it is directly inside, which is what the line says.
  const inner = collect(collect(clone(s) as unknown as GraphSpec, "subJoin", "deepJoin"), "gather", "subJoin");
  assert.deepEqual(errorsOf(inner).map((d) => d.code), [], "following the line as written converges");

  // ONE LEVEL TOO FAR OUT — `deepJoin` straight into `gather`, the reading the adjective rules
  // out. `gather` becomes reachable at two fan-out depths and fails closed.
  const outer = collect(collect(clone(s) as unknown as GraphSpec, "gather", "deepJoin"), "gather", "subJoin");
  assert.ok(
    errorsOf(outer).some((d) => d.code === "GRAPH008_JOIN_DEPTH"),
    `the outer reading must be refused; got ${errorsOf(outer).map((d) => d.code).join(", ") || "no errors"}`,
  );
});

test("FOLLOWING THE HELD JOIN'S SINGLE LINE COMPILES — one edit, where it used to take two", () => {
  // The acceptance test for §A.56. Do exactly what the sentence says — both halves, no more —
  // and recompile. Before, doing the half it named produced GRAPH008_BRANCH_NOT_CONNECTED.
  const s = heldInner();
  const [held] = errorsOf(s).filter((x) => x.code === "GRAPH008_HELD_JOIN_UNCOLLECTED");
  const edits = heldFixEdits(held!.fix ?? "");

  // "the enclosing join" — the one whose fan-out contains the held join. Here that is `gather`.
  const applyEntry = (g: GraphSpec): GraphSpec => {
    const i = g.nodes.findIndex((x) => x.id === n("gather"));
    const j = g.nodes[i]!.join!;
    (g.nodes as NodeSpec[])[i] = {
      ...g.nodes[i]!,
      join: { ...j, branches: [...j.branches, n(edits.entry)] },
    } as NodeSpec;
    return g;
  };

  const fixed = applyEntry(clone(s) as unknown as GraphSpec);
  (fixed.edges as EdgeSpec[]).push({ id: e("collect-held"), from: n(edits.edgeFrom), to: n("gather"), kind: "join" } as EdgeSpec);
  assert.deepEqual(errorsOf(fixed).map((d) => d.code), [], "the message's own instructions must produce a graph that compiles");

  // THE CONTROL: the half the old line named, on its own, is not enough — which is why the
  // omission cost a compile rather than being a wording preference.
  const halfDone = applyEntry(clone(s) as unknown as GraphSpec);
  assert.deepEqual(
    errorsOf(halfDone).map((d) => d.code),
    ["GRAPH008_BRANCH_NOT_CONNECTED"],
    "the `branches` entry alone lands on the sibling GRAPH008 — the second half is load-bearing",
  );
});

test("GRAPH021'S COUNT AND ITS DICTATED LIST ARE DIFFERENT SETS, and the message says which", () => {
  // §A.57. `subJoin` is IN the branch and runs into no candidate join, so it is counted and not
  // dictated. Both numbers were always right; the sentence disclosed neither.
  const s = heldInner();
  // Break the outer join so GRAPH021 fires on `fan` — the shape the row's graph is in.
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = { ...s.nodes[g]!, join: { branches: [n("classify")], mode: "all", onBranchError: "fail" } } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect-read")), 1);

  const [d] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined);
  const { counted, absent } = countedIn(d.message);
  const dictated = namesIn(d.fix ?? "");

  assert.deepEqual([...counted].sort(), ["classify", "read", "subJoin"], "the count is what the branch CONTAINS");
  assert.deepEqual([...dictated].sort(), ["classify", "read"], "the list is what the barrier can be told to WAIT ON");

  // §A.65 DID NOT MOVE THIS SENTENCE. Nothing collects `subJoin` here —
  // `GRAPH008_HELD_JOIN_UNCOLLECTED` is refusing it in the same run — so the reason is still the
  // §A.57 one, and the clause is asserted BYTE FOR BYTE: a second reason exists now, and a rule
  // that reached for it on this graph would be making the false claim §A.57 refused to make.
  assert.equal(
    d.message,
    'fanout edge "fan" expands "read" but no downstream join waits on it; the branch it opens holds ' +
      '3 nodes (read, classify, subJoin), and the `fix:` line dictates the ones that run into every ' +
      'join it offers — "subJoin" does not, so it is in this count and not in that list',
  );
  assert.deepEqual(absent.get("subJoin"), { reason: "unreached", by: [] });

  // The disclosure, asserted over the NAME SET rather than the prose: every node the two sets
  // disagree about is named in the message as counted-and-not-dictated.
  const difference = counted.filter((c) => !dictated.includes(c));
  assert.deepEqual(difference, ["subJoin"]);
  assert.deepEqual([...absent.keys()], difference, "and the parsed reasons cover exactly that difference");
  for (const name of difference) {
    assert.match(
      d.message,
      new RegExp(`"${name}"[^.]*in this count and not in that list`),
      `the message must disclose that ${name} is counted and not dictated: ${d.message}`,
    );
  }

  // AND NOTHING ABOUT WHICH JOINS ARE OFFERED MOVED — §A.53's four rounds were spent on that
  // set, and §A.57 is a prose row. A change that narrows it is the wrong change.
  assert.deepEqual(offeredJoins(d.fix ?? ""), ["gather"]);
});

/**
 * `a53-pickone` with a SECOND ARM off `read` that runs into neither candidate, so one counted
 * name is absent for §A.57's reason and another for §A.65's, in the same message.
 */
function twoReasons(): GraphSpec {
  const s = a53PickOne();
  (s.nodes as NodeSpec[]).push({
    id: n("armY"),
    type: "function",
    reads: ["shard"],
    writes: ["failures"],
    function: { ref: "function/armY@stable" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("toY"), from: n("read"), to: n("armY"), kind: "seq" } as EdgeSpec);
  return s;
}

test("BOTH REASONS IN ONE SENTENCE: a name that reaches no candidate and a name something folds", () => {
  // §A.65's second half. The two reasons are different facts about different nodes, and a message
  // carrying one generic reason for both would recreate exactly the defect §A.57 closed: a reader
  // could not tell which applied to which, so could not tell a deliberate omission from a bug.
  //
  //     plan --fan--> read --seq--> classify --seq--> gather(join, branches:[classify])
  //                        \--seq--> armY                    \--join--> gA / gB
  //
  // `armY` runs into neither `gA` nor `gB`; `classify` runs into both but `gather` already folds it.
  const [d] = errorsOf(twoReasons()).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined);

  const { counted, absent } = countedIn(d.message);
  assert.deepEqual([...counted].sort(), ["armY", "classify", "gather", "read"]);
  assert.deepEqual(absent.get("armY"), { reason: "unreached", by: [] }, `§A.57's reason: ${d.message}`);
  assert.deepEqual(absent.get("classify"), { reason: "folded", by: ["gather"] }, `§A.65's reason: ${d.message}`);
  assert.deepEqual(absent.get("gather"), { reason: "folded", by: ["gA", "gB"] }, `and the same reason: ${d.message}`);
  assert.deepEqual(namesIn(d.fix ?? ""), ["read"], "and none of the three is dictated");
  // The two sets the message reports are the count and the dictated list, and nothing else:
  // every counted name is either dictated or carries a reason.
  for (const c of counted) {
    assert.equal(
      namesIn(d.fix ?? "").includes(c) !== absent.has(c),
      true,
      `"${c}" is neither dictated nor explained, or is both: ${d.message}`,
    );
  }
});

test("THE ZERO-CANDIDATE ARM FILTERS TOO — `add a join node` must not dictate a folded member", () => {
  // The same predicate in the arm that has no join to offer, which is the half a second copy of
  // the filter would have been written into and then forgotten (§A.53's own lesson). `inner` sits
  // INSIDE the branch behind a `seq` edge and already declares `classify`; the new join the
  // message asks for must collect `read` and `inner`, and leave `classify` where it is.
  //
  //     plan --fan--> read --seq--> classify --seq--> inner(join, branches:[classify]) --seq--> collate
  const s = shipped();
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = {
    ...s.nodes[g]!,
    id: n("inner"),
    join: { branches: [n("classify")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect-read")), 1);
  (s.edges as EdgeSpec[])[s.edges.findIndex((x) => x.id === e("collect"))] = {
    id: e("collect"), from: n("classify"), to: n("inner"), kind: "seq",
  } as EdgeSpec;
  (s.edges as EdgeSpec[])[s.edges.findIndex((x) => x.id === e("fold"))] = {
    id: e("fold"), from: n("inner"), to: n("collate"), kind: "seq",
  } as EdgeSpec;

  const [d] = errorsOf(s).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined);
  assert.deepEqual(offeredJoins(d.fix ?? ""), [], "there is no join at the barrier's level, so none is offered");
  // `collate` is in the branch too — with no barrier anywhere the fan-out runs to the end of the
  // graph — and nothing folds it, so it is dictated like `read`.
  assert.deepEqual(namesIn(d.fix ?? ""), ["read", "inner", "collate"], `and "classify" is left to "inner": ${d.fix}`);
  assert.deepEqual(countedIn(d.message).absent.get("classify"), { reason: "folded", by: ["inner"] });
});

test("THE DICTATED LIST CAN NEVER EMPTY: the fan-out's own target is dictated whatever folds it", () => {
  // `e.to` is an explicit guard in the code, and this is the reason it has to be one. `joined` —
  // the condition that makes GRAPH021 fire at all — is a CONJUNCTION: some join declares `e.to` in
  // `branches` AND is downstream of it. Naming `e.to` for a CANDIDATE satisfies both, so a list
  // that leaves `e.to` out dictates an edit that does not clear the error it is attached to — and
  // a claimer satisfying only the first half does not clear it either, which is (b) and (c).
  //
  // SO THE GUARD IS KEPT AND THE RESIDUE IS DISCLOSED — §A.69. (b) and (c) are the same residue
  // and differed only in whether a SIBLING code happened to name the claimer, so the disclosure
  // belongs in THIS rule's own `fix:` line, which fires for both. Tightening the sibling's
  // acceptance condition instead — the row's option (a) — would have named the bogus ENTRY in (c)
  // as it already does in (b), and in neither case the COLLISION: measured, the dictated edit still
  // produced the same `GRAPH008_JOIN_DEPTH` the first compile had not printed. `claimedIn` reads
  // the clause that does name it.
  //
  // AN EARLIER CUT LEANED ON AN IMPLICATION INSTEAD, and it was false. It required a folder to be
  // DOWNSTREAM of its member, arguing that a join collecting `read` would satisfy `joined` and so
  // never reach the filter. `rule008`'s `claimedBy` counts a folder from `branches` membership
  // alone, with no reachability, so a claim `idx.ancestors` cannot see is a claim GRAPH008 will
  // still refuse — (b) below is one such, and `A FOLDER THIS RULE CANNOT REACH` is the other.
  //
  // (a) A join that declares `read` AND is downstream of it: nothing is said.
  const collected = shipped();
  const gc = collected.nodes.findIndex((x) => x.id === n("gather"));
  (collected.nodes as NodeSpec[])[gc] = {
    ...collected.nodes[gc]!,
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec;
  assert.deepEqual(
    errorsOf(collected).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN").map((x) => x.at?.edgeId),
    [],
    "a join that folds the fan-out's target IS the barrier, so GRAPH021 says nothing",
  );

  // (b) A join that declares `read` with no path to it at all. `read` is still dictated — the
  //     guard, and the only way this rule could otherwise print an empty list.
  //
  //     AND THE RESIDUE IS PINNED, not described: following the line then DOES produce a
  //     `GRAPH008_JOIN_DEPTH` on `read`, because `off` is a claimant too. This rule cannot dictate
  //     around it — dropping `read` would dictate a non-fix — and the author has to decide which
  //     join is the barrier. Since §A.69 the line SAYS SO, naming `off` and the refusal, so the
  //     author reads it before making the edit; the edit's outcome is unchanged. Here the first
  //     compile was never silent either — `off` has no inbound edge from `read`, so
  //     `GRAPH008_BRANCH_NOT_CONNECTED` names the entry in the same output, and it still does.
  //     THAT SIBLING CODE IS A PROPERTY OF THIS SHAPE AND NOT OF THE RESIDUE, which is why it was
  //     never the disclosure: (c) is the same residue with that code absent.
  const off = f1Step1();
  (off.nodes as NodeSpec[]).push({
    id: n("off"),
    type: "join",
    reads: ["failures"],
    writes: ["failures"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (off.edges as EdgeSpec[]).push({ id: e("toOff"), from: n("plan"), to: n("off"), kind: "seq" } as EdgeSpec);
  const firstOff = errorsOf(off);
  const [d] = firstOff.filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined);
  assert.deepEqual(namesIn(d.fix ?? ""), ["read", "classify"], `the fan-out's target is dictated anyway: ${d.fix}`);
  assert.deepEqual(claimedIn(d.fix ?? ""), ["off"], `and the line names the join that already claims it: ${d.fix}`);
  assert.deepEqual(
    firstOff.map((x) => x.code).sort(),
    // GRAPH010 arrives with `f1Step1`: dropping `collect-read` switches the branch-local exemption
    // off (§A.48 W6). On `f1Step1` ALONE the dictated edit clears it (the test above compiles to
    // `[]`); with `off` in the graph it survives the same edit, which is measured below and is a
    // second consequence of the same bogus entry rather than anything this rule chose.
    ["GRAPH008_BRANCH_NOT_CONNECTED", "GRAPH010_CONCURRENT_WRITE", "GRAPH021_FANOUT_WITHOUT_JOIN"],
    "and the first compile does name `off`\'s entry, under the sibling code",
  );
  assert.deepEqual(
    applyDictated(off, d, "gather").map((x) => `${x.code}@${String(x.at?.nodeId)}`).sort(),
    ["GRAPH008_BRANCH_NOT_CONNECTED@off", "GRAPH008_JOIN_DEPTH@read", "GRAPH010_CONCURRENT_WRITE@read"],
    "THE RESIDUE: `read` now has two claimants, and this rule cannot dictate around it",
  );

  // (c) THE SAME RESIDUE WITH NO SIBLING CODE NAMING IT — the shape §A.69 closed, and the reason
  //     (b) alone would have been a misleading disclosure. `again` declares `read` and is wired to
  //     it by a `loop` edge: `GRAPH008_BRANCH_NOT_CONNECTED` accepts an inbound edge of ANY kind,
  //     so it is silent, while `idx.ancestors` walks no `loop` edge, so `joined` is false and
  //     GRAPH021 fires. The first compile prints exactly ONE diagnostic — and until §A.69 nothing
  //     in it named the claim on `read`, so the author learned of the collision only from the
  //     compile AFTER typing what they were told to type.
  //
  //     WHAT FLIPPED, AND WHAT DELIBERATELY DID NOT. The `fix:` line now names `again` and the
  //     `GRAPH008_JOIN_DEPTH` that follows. It still dictates `read` — dropping it would dictate an
  //     edit that does not clear the error — and the dictated edit still produces that
  //     `GRAPH008_JOIN_DEPTH`, asserted below exactly as before. The claim this closes on is
  //     therefore NOT "converges in one compile" and NOT "introduces no new diagnostic": it is that
  //     the collision is DISCLOSED BY THE FIRST COMPILE, in the diagnostic that dictates the edit.
  //     The graph is broken twice over and only the author can say which join is the barrier.
  //
  //     plan --fan--> read --seq--> classify --join--> gather(branches:["classify"])
  //                       \--loop--> again(join, branches:["read"])
  const looped = f1Step1();
  (looped.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  (looped.inputs as string[]).push("failures");
  const r = looped.nodes.findIndex((x) => x.id === n("read"));
  (looped.nodes as NodeSpec[])[r] = { ...looped.nodes[r]!, reads: ["shard", "failures"], writes: ["raw", "failures"] } as NodeSpec;
  (looped.nodes as NodeSpec[]).push({
    id: n("again"), type: "join", reads: ["failures"], writes: ["failures"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (looped.edges as EdgeSpec[]).push(
    { id: e("back"), from: n("read"), to: n("again"), kind: "loop", until: "len(failures) > 0", maxIterations: 2 } as unknown as EdgeSpec,
    { id: e("out"), from: n("again"), to: n("collate"), kind: "seq" } as EdgeSpec,
  );

  const firstLoop = errorsOf(looped);
  assert.deepEqual(
    firstLoop.map((x) => x.code),
    ["GRAPH021_FANOUT_WITHOUT_JOIN"],
    `still ONE diagnostic — no sibling code names the claim: ${firstLoop.map((x) => x.message).join(" | ")}`,
  );
  const dl = firstLoop[0]!;
  assert.deepEqual(namesIn(dl.fix ?? ""), ["read", "classify"], `"read" is dictated anyway: ${dl.fix}`);

  // THE PIN THAT FLIPPED. This used to assert that nothing in the one diagnostic named the claim.
  assert.deepEqual(
    claimedIn(dl.fix ?? ""),
    ["again"],
    `the one diagnostic names the join that already claims "read": ${dl.fix}`,
  );

  // AND WHAT IT COSTS IS UNCHANGED, which is the honest half. The dictated edit still produces the
  // same single `GRAPH008_JOIN_DEPTH`; what moved is that the author was told about it first.
  assert.deepEqual(
    applyDictated(looped, dl, "gather").map((x) => `${x.code}@${String(x.at?.nodeId)}`),
    ["GRAPH008_JOIN_DEPTH@read"],
    "the edit still produces the collision — this rule discloses it, it does not dictate around it",
  );

  // AND THE DISCLOSURE IS LOAD-BEARING, not decoration: the code it predicts is the code the edit
  // produces, and the join it names is one of the two that code reports. A clause naming some
  // other join, or some other code, would pass every assertion above.
  const after = applyDictated(looped, dl, "gather");
  assert.match(after[0]!.message, /2 joins \("gather", "again"\)/, after[0]!.message);
  assert.ok(
    claimedIn(dl.fix ?? "").every((j) => after[0]!.message.includes(`"${j}"`)),
    `the line named a join the refusal does not: ${dl.fix}`,
  );

  // AND IT DICTATES THE ENTRY ALONE, NEVER THE EDGE — the defect the first cut of §A.69 shipped.
  // The clause used to read "drop it — the `branches` entry AND the edge". When it fires there is
  // provably no `kind: join` edge from `e.to` INTO THE CLAIMER (one would put `e.to` in the
  // claimer's `idx.ancestors`, making `joined` true and this whole diagnostic silent), so "the
  // edge" could only ever mean the `loop` or `compensation` edge that carries the author's OWN
  // semantics — here `back`, with `until` and `maxIterations`. Following that literally deletes a
  // retry loop the refusal never objected to, which is the additive lesson this rule paid for once.
  //
  // PINNED BYTE-FOR-BYTE, like the F1 sentence above, and the first cut's pin was a
  // `doesNotMatch(/entry AND the edge/)`. A reviewer re-introduced the defect in different words —
  // "and also delete the edge that runs from \"read\" into it" — and the whole file stayed green
  // while the shipped line dictated deleting `back` again. That is this file's own documented
  // failure mode: a pattern that matches PROSE decays with the prose. There is no NAME SET to read
  // here, because what must not drift is an INSTRUCTION, so the bytes are the assertion.
  assert.equal(
    dl.fix,
    'give join "gather" an entry in its `branches` for each of read, classify, and a `kind: join` edge ' +
      'from each of them into "gather" — every node inside a fan-out branch needs both. ADD to whatever ' +
      '"gather" already declares: one join can be the barrier for more than one fan-out. NOTE "read" is ' +
      "this fan-out's own target, so it is dictated whatever already folds it — but \"again\" already " +
      "declares it among its `branches`, so with the barrier declaring it too `GRAPH008_JOIN_DEPTH` " +
      'refuses "read" as held by more than one join. Decide which join is the barrier for "read" and ' +
      "drop the `branches` ENTRY from the other — the entry alone, and NOT any edge: it is a " +
      '`kind: join` edge from "read" INTO "again" that would have made this diagnostic not fire, so ' +
      "whatever edge runs there now carries its own meaning and deleting it is a second change",
  );
  // The control is the WHOLE repair: the dictated edit, plus the one decision only the author can
  // make. Both spellings of that decision must compile, and the graph is clean with `back` intact —
  // so deleting it was never part of the fix.
  const repaired = (dropEdge: boolean): readonly string[] => {
    const s = clone(looped) as unknown as GraphSpec;
    const g = s.nodes.findIndex((x) => x.id === n("gather"));
    (s.nodes as NodeSpec[])[g] = {
      ...s.nodes[g]!,
      join: { ...(s.nodes[g]! as NodeSpec).join!, branches: [n("classify"), n("read")] },
    } as NodeSpec;
    (s.edges as EdgeSpec[]).push({ id: e("add-read-gather"), from: n("read"), to: n("gather"), kind: "join" } as EdgeSpec);
    const ag = s.nodes.findIndex((x) => x.id === n("again"));
    (s.nodes as NodeSpec[])[ag] = {
      ...s.nodes[ag]!,
      join: { ...(s.nodes[ag]! as NodeSpec).join!, branches: [] },
    } as NodeSpec;
    if (dropEdge) (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("back")), 1);
    assert.equal(
      s.edges.some((x) => x.id === e("back") && x.kind === "loop"),
      !dropEdge,
      "the fixture must differ in exactly the `loop` edge",
    );
    return errorsOf(s).map((x) => x.code);
  };
  assert.deepEqual(repaired(false), [], "the ENTRY alone clears it, with the `loop` edge left standing");
  assert.deepEqual(repaired(true), [], "and dropping the edge too is legal — which is why it must not be DICTATED");
});

test("`INTO <the claimer>` IS THE WHOLE SENTENCE: an outbound `kind: join` edge from the target exists", () => {
  // B1. The clause's justification is that a `kind: join` edge from `e.to` INTO THE CLAIMER would
  // have silenced this diagnostic. The first cut dropped the destination and said "a `kind: join`
  // edge from \"read\" would have made this diagnostic not fire" — which is false the moment ANY
  // such edge exists, and one always can: here `read --join--> gather`, a join that does NOT claim
  // `read`. The author reads the sentence while looking at exactly the edge it says cannot exist.
  //
  //     plan --fan--> read --seq--> classify --join--> gather(branches:["classify"])
  //                       |--join--> gather          <-- exists, and gather does NOT claim read
  //                       \--loop--> again(join, branches:["read"])
  const s = f1Step1();
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  (s.inputs as string[]).push("failures");
  const r = s.nodes.findIndex((x) => x.id === n("read"));
  (s.nodes as NodeSpec[])[r] = { ...s.nodes[r]!, reads: ["shard", "failures"], writes: ["raw", "failures"] } as NodeSpec;
  (s.nodes as NodeSpec[]).push({
    id: n("again"), type: "join", reads: ["failures"], writes: ["failures"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push(
    { id: e("back"), from: n("read"), to: n("again"), kind: "loop", until: "len(failures) > 0", maxIterations: 2 } as unknown as EdgeSpec,
    { id: e("out"), from: n("again"), to: n("collate"), kind: "seq" } as EdgeSpec,
    // THE EDGE THE OLD SENTENCE DENIED. `gather` does not declare `read`, so `joined` stays false
    // and GRAPH021 still fires — which is the point: the edge exists AND the diagnostic is here.
    { id: e("read-gather"), from: n("read"), to: n("gather"), kind: "join" } as EdgeSpec,
  );

  const first = errorsOf(s);
  const d = first.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined, `the diagnostic must still fire: ${first.map((x) => x.code).join(", ")}`);
  assert.ok(
    s.edges.some((x) => x.from === n("read") && x.kind === "join"),
    "the fixture's whole point is an outbound `kind: join` edge from the fan-out's target",
  );
  assert.deepEqual(claimedIn(d.fix ?? ""), ["again"], `only the claimer is named: ${d.fix}`);

  // THE SENTENCE NAMES THE DESTINATION, so it stays true with that edge on the page.
  assert.match(
    d.fix ?? "",
    /it is a `kind: join` edge from "read" INTO "again" that would have made this diagnostic not fire/,
    `the clause omits the destination and is false on this graph: ${d.fix}`,
  );
});

test("A `compensation`-WIRED CLAIMER OF THE TARGET IS NAMED TOO, and so is a SECOND claimer", () => {
  // §A.69's clause is pinned above on a `loop` edge. The rule's silence has two other spellings and
  // this covers both: a `compensation` edge, which `idx.ancestors` also refuses to walk, and TWO
  // claimers at once, which is the only thing that exercises the clause's plural wording. The
  // plural matters because the singular arm reads "already declares it among its `branches`" and
  // "from the other" — reverting the plural to it left the file green before this test existed.
  //
  // AND `sink` IS THE CONTROL: a join that claims something ELSE. Naming only the joins that
  // declare `e.to` was unpinned until this — mutating `alsoClaim` to every join in the graph left
  // the whole file green. `sink` claims `classify`, so it IS in this diagnostic, under the
  // count/list disclosure; what it must never be is in the NOTE clause, which is about `read`.
  //
  //     plan --fan--> read --seq--> classify --join--> gather(branches:["classify"])
  //                       |                    \--join--> sink(branches:["classify"])
  //                       |--compensation--> undo(join, branches:["read"])
  //     plan --seq------------------------>  spare(join, branches:["read"])
  //
  // AND `sink` MOVED THIS FIXTURE INTO THE MULTI-CANDIDATE ARM, which is worth saying because the
  // diagram above once drew a single barrier. `sink` sits at the barrier level and is downstream of
  // `read`, so `candidates` is now {gather, sink}, `named` is undefined, and the dictated half reads
  // "pick one of the joins" rather than "give join gather". That is why the byte pin below opens
  // with `pick one of the joins` — the control for §A.69's clause also became the only test that
  // pins the plural clause ON TOP OF the multi-candidate dictate.
  const s = f1Step1();
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  (s.inputs as string[]).push("failures");
  const r = s.nodes.findIndex((x) => x.id === n("read"));
  (s.nodes as NodeSpec[])[r] = { ...s.nodes[r]!, reads: ["shard", "failures"], writes: ["raw", "failures"] } as NodeSpec;
  for (const id of ["undo", "spare"]) {
    (s.nodes as NodeSpec[]).push({
      id: n(id), type: "join", reads: ["failures"], writes: ["failures"],
      join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
    } as NodeSpec);
  }
  (s.nodes as NodeSpec[]).push({
    id: n("sink"), type: "join", reads: ["failures"], writes: ["failures"],
    join: { branches: [n("classify")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push(
    { id: e("comp"), from: n("read"), to: n("undo"), kind: "compensation" } as EdgeSpec,
    { id: e("toSpare"), from: n("plan"), to: n("spare"), kind: "seq" } as EdgeSpec,
    { id: e("undoOut"), from: n("undo"), to: n("collate"), kind: "seq" } as EdgeSpec,
    { id: e("spareOut"), from: n("spare"), to: n("collate"), kind: "seq" } as EdgeSpec,
    { id: e("toSink"), from: n("classify"), to: n("sink"), kind: "join" } as EdgeSpec,
    { id: e("sinkOut"), from: n("sink"), to: n("collate"), kind: "seq" } as EdgeSpec,
  );

  const first = errorsOf(s);
  const d = first.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined, first.map((x) => x.code).join(", "));

  // THE PLURAL ARM IS PINNED BYTE-FOR-BYTE, exactly as the singular one is, and until it was the
  // round that fixed the singular arm had left BOTH its defects reachable here. The plural text is
  // a DIFFERENT STRING — four `many ?` ternaries plus the multi-candidate `dictate` arm — and the
  // name-set and `match` assertions below never reach its tail, so appending " — and delete the
  // edges from \"read\" into them too", or dropping the destination in the plural arm alone, each
  // left the whole file green at 426/426.
  //
  // THIS FIXTURE IS THE PLURAL *MIXED* ARM — §A.73 added the dimension, and this graph was already
  // on the wrong side of it. `undo` is wired by a `compensation` edge; `spare` is wired by NOTHING,
  // so the sentence's "whatever edge runs there now carries its own meaning" was false of half its
  // own subject. The appendix names the half it is false of, and only that half. The three other
  // arms are pinned in the three tests below; five in total, and there is no sixth.
  assert.equal(
    d.fix,
    'pick one of the joins "gather" or "sink" — not the node below, which is what it waits FOR — and ' +
      "give it an entry in its `branches` for read, plus a `kind: join` edge from read into it, added " +
      'to whatever it already declares. NOTE "read" is this fan-out\'s own target, so it is dictated ' +
      'whatever already folds it — but "undo", "spare" already declare it among their `branches`, so ' +
      '`GRAPH008_JOIN_DEPTH` ALREADY refuses "read" as held by more than one join. Decide which join ' +
      'is the barrier for "read" and drop the `branches` ENTRY from the others — the entry alone, and ' +
      'NOT any edge: it is a `kind: join` edge from "read" INTO one of them that would have made this ' +
      "diagnostic not fire, so whatever edge runs there now carries its own meaning and deleting it " +
      'is a second change. No edge runs from "read" into "spare" at all — that is what ' +
      "`GRAPH008_BRANCH_NOT_CONNECTED` is refusing in this same compile, and adding the edge it asks " +
      "for cements `GRAPH008_JOIN_DEPTH` rather than clearing it",
  );

  // AND THE APPENDIX IS TRUE OF THIS GRAPH, checked rather than asserted: `spare` really has no
  // inbound edge from `read`, `undo` really has one, and `GRAPH008_BRANCH_NOT_CONNECTED` really is
  // in this compile naming `spare`. A clause naming the wrong half would pass the byte pin above
  // only by being written wrong in both places, which these three lines make visible.
  assert.ok(!s.edges.some((x) => x.from === n("read") && x.to === n("spare")), "`spare` is the unwired half");
  assert.ok(s.edges.some((x) => x.from === n("read") && x.to === n("undo")), "`undo` is the wired half");
  assert.ok(
    first.some((x) => x.code === "GRAPH008_BRANCH_NOT_CONNECTED" && x.at?.nodeId === n("spare")),
    `the sibling the appendix names is in this compile: ${first.map((x) => `${x.code}@${String(x.at?.nodeId)}`).join(", ")}`,
  );

  // BOTH claimants of `read` are named — the `compensation`-wired `undo` and the `seq`-wired
  // `spare`. Neither is silent on THIS graph: two claimers mean `claimedBy` already counts two, so
  // `GRAPH008_JOIN_DEPTH` names them in this same compile, and `spare`'s bogus entry draws
  // `GRAPH008_BRANCH_NOT_CONNECTED` besides. The genuinely SILENT compensation shape — one claimer,
  // no sibling code — is the test below; this one is about the plural wording and the control.
  assert.deepEqual(
    [...claimedIn(d.fix ?? "")].sort(),
    ["spare", "undo"],
    `both claimants of "read" are named: ${d.fix}`,
  );
  assert.match(d.fix ?? "", /already declare it among their `branches`/, `plural form: ${d.fix}`);
  assert.match(d.fix ?? "", /from the others/, `plural form: ${d.fix}`);

  // THE CONTROL: `sink` claims `classify`, not `read`, so it is NOT in the clause — while being
  // very much in the diagnostic, under the disclosure about names the list drops. A clause naming
  // every join would satisfy every other assertion here and fail this one.
  assert.ok(!claimedIn(d.fix ?? "").includes("sink"), `"sink" claims classify, not read: ${d.fix}`);
  assert.match(d.message, /"classify" is already folded by .*"sink"/, `and it IS disclosed: ${d.message}`);

  // And the prediction holds for both: the dictated edit names all three joins in ONE refusal.
  const after = applyDictated(s, d, "gather");
  const depth = after.find((x) => x.code === "GRAPH008_JOIN_DEPTH" && x.at?.nodeId === n("read"));
  assert.ok(depth !== undefined, after.map((x) => `${x.code}@${String(x.at?.nodeId)}`).join(", "));
  for (const j of claimedIn(d.fix ?? "")) {
    assert.ok(depth.message.includes(`"${j}"`), `the clause named "${j}" but the refusal does not: ${depth.message}`);
  }
});

/**
 * The §A.69 clause with an UNWIRED claimer, three ways — §A.73.
 *
 * WHAT WAS WRONG. The tail said "whatever edge runs there now carries its own meaning and deleting
 * it is a second change". The paragraph it rests on proves only that the edge is not a `kind: join`
 * one; it does NOT prove that an edge is there. A claimer declared in `branches` with no inbound
 * edge at all is `GRAPH008_BRANCH_NOT_CONNECTED`'s own case, and on that graph the two `fix:` lines
 * in ONE compile said the opposite thing about the same absent edge — one "add an edge read -> again
 * with kind: join", the other "drop the `branches` ENTRY … NOT any edge".
 *
 * WHICH ONE MOVED WAS DECIDED BY RUNNING BOTH, and the control below runs them again: following the
 * sibling alone compiles CLEAN, following this clause leaves GRAPH021 still firing. So the sibling's
 * line is the cheaper correct edit and this clause now names it as the other way out — in the
 * SINGULAR arm only, because with two claimers `GRAPH008_JOIN_DEPTH` is already on screen and an
 * added edge removes no `branches` entry.
 *
 * FIVE ARMS, FIVE BYTE PINS, and that count is the point rather than a formality: a message
 * assembled from conditionals has one string per combination of conditions, a byte pin covers
 * exactly one of them, and an unpinned arm is where this file has twice shipped a defect while
 * staying green. Singular wired and plural mixed are pinned above; singular unwired, plural
 * all-wired and plural all-unwired are the three here.
 */

/** Case (c)'s graph with the `loop` edge optional: the §A.73 fixture, both spellings. */
function loopedClaimer(withBackEdge: boolean): GraphSpec {
  const s = f1Step1();
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  (s.inputs as string[]).push("failures");
  const r = s.nodes.findIndex((x) => x.id === n("read"));
  (s.nodes as NodeSpec[])[r] = { ...s.nodes[r]!, reads: ["shard", "failures"], writes: ["raw", "failures"] } as NodeSpec;
  (s.nodes as NodeSpec[]).push({
    id: n("again"), type: "join", reads: ["failures"], writes: ["failures"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  if (withBackEdge) {
    (s.edges as EdgeSpec[]).push(
      { id: e("back"), from: n("read"), to: n("again"), kind: "loop", until: "len(failures) > 0", maxIterations: 2 } as unknown as EdgeSpec,
    );
  }
  (s.edges as EdgeSpec[]).push({ id: e("out"), from: n("again"), to: n("collate"), kind: "seq" } as EdgeSpec);
  return s;
}

test("AN UNWIRED SINGLE CLAIMER: the clause names the sibling's edge as the OTHER way out", () => {
  //     plan --fan--> read --seq--> classify --join--> gather(branches:["classify"])
  //                   again(join, branches:["read"])  <-- NO edge from read into it
  const s = loopedClaimer(false);
  const first = errorsOf(s);
  assert.deepEqual(
    first.map((x) => `${x.code}@${String(x.at?.nodeId ?? x.at?.edgeId)}`).sort(),
    ["GRAPH008_BRANCH_NOT_CONNECTED@again", "GRAPH021_FANOUT_WITHOUT_JOIN@fan"],
    "the two sibling lines of §A.73 are in ONE compile, or this fixture is not the shape",
  );
  const d = first.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN")!;

  // THE ARM, BYTE-FOR-BYTE. The two halves that must not drift are "there being NO edge … to
  // delete" (the sentence that was false) and the naming of `GRAPH008_BRANCH_NOT_CONNECTED` (the
  // sibling whose line this one used to contradict). A `match` on either decays with the prose.
  assert.equal(
    d.fix,
    'give join "gather" an entry in its `branches` for each of read, classify, and a `kind: join` edge ' +
      'from each of them into "gather" — every node inside a fan-out branch needs both. ADD to whatever ' +
      '"gather" already declares: one join can be the barrier for more than one fan-out. NOTE "read" is ' +
      "this fan-out's own target, so it is dictated whatever already folds it — but \"again\" already " +
      "declares it among its `branches`, so with the barrier declaring it too `GRAPH008_JOIN_DEPTH` " +
      'refuses "read" as held by more than one join. Decide which join is the barrier for "read": drop ' +
      'the `branches` ENTRY from "again" — the entry alone, there being NO edge from "read" into it to ' +
      'delete — or add the `kind: join` edge from "read" INTO "again" that ' +
      "`GRAPH008_BRANCH_NOT_CONNECTED` asks for in this same compile, which makes \"again\" wait on " +
      '"read" and silences THIS diagnostic instead',
  );

  // AND BOTH WAYS OUT ARE RUN, which is the whole claim and the reason the sibling was left alone.
  // Adding the edge it asks for compiles CLEAN in one compile; dropping the entry leaves GRAPH021
  // still refusing, with the dictated half still owed. A clause that offered the worse of the two
  // would pass the byte pin above and fail here.
  const withEdge = clone(s) as unknown as GraphSpec;
  (withEdge.edges as EdgeSpec[]).push({ id: e("bnc"), from: n("read"), to: n("again"), kind: "join" } as EdgeSpec);
  assert.deepEqual(errorsOf(withEdge).map((x) => x.code), [], "the sibling's edge silences BOTH lines");

  const dropped = clone(s) as unknown as GraphSpec;
  const ag = dropped.nodes.findIndex((x) => x.id === n("again"));
  (dropped.nodes as NodeSpec[])[ag] = {
    ...dropped.nodes[ag]!, join: { ...(dropped.nodes[ag]! as NodeSpec).join!, branches: [] },
  } as NodeSpec;
  assert.deepEqual(
    errorsOf(dropped).map((x) => x.code),
    ["GRAPH021_FANOUT_WITHOUT_JOIN"],
    "dropping the entry alone does not: the dictated half is still owed",
  );
});

test("TWO CLAIMERS, BOTH WIRED: the tail §A.69 settled, unchanged, and no appendix", () => {
  // The plural arm's all-wired spelling, which the mixed fixture above does not reach. `loop` and
  // `compensation` are the ONLY kinds a claimer can be wired by while this diagnostic still fires —
  // `idx.ancestors` walks every other kind, which would make `joined` true and the rule silent — so
  // one of each is the whole of "both wired".
  //
  //     plan --fan--> read --seq--> classify --join--> gather(branches:["classify"])
  //                       |--loop---------> again(join, branches:["read"])
  //                       \--compensation-> undo(join, branches:["read"])
  const s = loopedClaimer(true);
  const r = s.nodes.findIndex((x) => x.id === n("read"));
  // A `compensation` edge must leave a tool node, so `read` becomes one; `unhandled` keeps
  // GRAPH011's warning off, and the posture carries the capability the tool needs.
  (s.nodes as NodeSpec[])[r] = {
    ...s.nodes[r]!, type: "tool", tool: { name: "k8s.apply", args: {} }, unhandled: true, function: undefined,
  } as unknown as NodeSpec;
  (s.policy as Record<string, unknown>)["posture"] = "in";
  (s.policy as Record<string, unknown>)["capabilities"] = ["k8s:write"];
  (s.nodes as NodeSpec[]).push({
    id: n("undo"), type: "join", reads: ["failures"], writes: ["failures"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push(
    { id: e("comp"), from: n("read"), to: n("undo"), kind: "compensation", compensates: n("read") } as unknown as EdgeSpec,
    { id: e("undoOut"), from: n("undo"), to: n("collate"), kind: "seq" } as EdgeSpec,
  );

  const first = errorsOf(s);
  const d = first.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN")!;
  assert.ok(d !== undefined, first.map((x) => x.code).join(", "));
  assert.ok(
    !first.some((x) => x.code === "GRAPH008_BRANCH_NOT_CONNECTED"),
    `both claimers are WIRED, so the sibling must be silent: ${first.map((x) => x.code).join(", ")}`,
  );
  assert.equal(
    d.fix,
    'give join "gather" an entry in its `branches` for each of read, classify, and a `kind: join` edge ' +
      'from each of them into "gather" — every node inside a fan-out branch needs both. ADD to whatever ' +
      '"gather" already declares: one join can be the barrier for more than one fan-out. NOTE "read" is ' +
      "this fan-out's own target, so it is dictated whatever already folds it — but \"again\", \"undo\" " +
      "already declare it among their `branches`, so `GRAPH008_JOIN_DEPTH` ALREADY refuses \"read\" as " +
      'held by more than one join. Decide which join is the barrier for "read" and drop the `branches` ' +
      "ENTRY from the others — the entry alone, and NOT any edge: it is a `kind: join` edge from " +
      '"read" INTO one of them that would have made this diagnostic not fire, so whatever edge runs ' +
      "there now carries its own meaning and deleting it is a second change",
  );
});

test("TWO CLAIMERS, NEITHER WIRED: the tail drops and the appendix names both", () => {
  // The plural arm's all-unwired spelling. The "carries its own meaning" half is about an edge, and
  // here there is none to carry anything, so it is not emitted at all — a clause that kept it and
  // merely appended would be half false on every graph of this shape.
  //
  //     plan --fan--> read --seq--> classify --join--> gather(branches:["classify"])
  //     plan --seq--> again(join, branches:["read"])   <-- no edge from read
  //     plan --seq--> undo (join, branches:["read"])   <-- no edge from read
  const s = loopedClaimer(false);
  (s.nodes as NodeSpec[]).push({
    id: n("undo"), type: "join", reads: ["failures"], writes: ["failures"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("undoOut"), from: n("undo"), to: n("collate"), kind: "seq" } as EdgeSpec);

  const first = errorsOf(s);
  const d = first.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN")!;
  assert.ok(d !== undefined, first.map((x) => x.code).join(", "));
  assert.deepEqual(
    first.filter((x) => x.code === "GRAPH008_BRANCH_NOT_CONNECTED").map((x) => String(x.at?.nodeId)).sort(),
    ["again", "undo"],
    "the appendix names both, and the sibling is refusing both in this same compile",
  );
  assert.equal(
    d.fix,
    'give join "gather" an entry in its `branches` for each of read, classify, and a `kind: join` edge ' +
      'from each of them into "gather" — every node inside a fan-out branch needs both. ADD to whatever ' +
      '"gather" already declares: one join can be the barrier for more than one fan-out. NOTE "read" is ' +
      "this fan-out's own target, so it is dictated whatever already folds it — but \"again\", \"undo\" " +
      "already declare it among their `branches`, so `GRAPH008_JOIN_DEPTH` ALREADY refuses \"read\" as " +
      'held by more than one join. Decide which join is the barrier for "read" and drop the `branches` ' +
      "ENTRY from the others — the entry alone, and NOT any edge: it is a `kind: join` edge from " +
      '"read" INTO one of them that would have made this diagnostic not fire. No edge runs from "read" ' +
      'into "again", "undo" at all — that is what `GRAPH008_BRANCH_NOT_CONNECTED` is refusing in this ' +
      "same compile, and adding the edge it asks for cements `GRAPH008_JOIN_DEPTH` rather than clearing it",
  );

  // AND THE APPENDIX'S CLAIM IS RUN: with two claimers, adding the sibling's edge does NOT clear the
  // collision — `claimedBy` counts `branches` entries, and the edit removes none.
  const withEdge = clone(s) as unknown as GraphSpec;
  (withEdge.edges as EdgeSpec[]).push({ id: e("bnc"), from: n("read"), to: n("again"), kind: "join" } as EdgeSpec);
  assert.deepEqual(
    errorsOf(withEdge).map((x) => `${x.code}@${String(x.at?.nodeId)}`).sort(),
    ["GRAPH008_BRANCH_NOT_CONNECTED@undo", "GRAPH008_JOIN_DEPTH@read"],
    "the edge cements the refusal rather than clearing it, exactly as the appendix says",
  );
});

test("THE SELF-CLAIMER TAKES NEITHER NEW SENTENCE — §A.73's NOTE, pinned rather than closed", () => {
  // The shape §A.73 records as a NOTE and deliberately leaves: the fan-out's target is a join
  // declaring ITSELF. Both sentences this change adds rest on premises it breaks, so both are
  // withheld — and the reason is RUN below rather than argued.
  //
  //     plan --fan--> read(join, branches:["read"]) --seq--> classify --join--> gather(["classify"])
  const s = f1Step1();
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  const r = s.nodes.findIndex((x) => x.id === n("read"));
  (s.nodes as NodeSpec[])[r] = {
    id: n("read"), type: "join", reads: ["shard"], writes: ["raw"],
    join: { branches: [n("read")], mode: "all", onBranchError: "fail" },
  } as unknown as NodeSpec;

  const first = errorsOf(s);
  const d = first.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN")!;
  assert.ok(d !== undefined, first.map((x) => x.code).join(", "));
  assert.deepEqual(claimedIn(d.fix ?? ""), ["read"], `the self-claimer is still NAMED: ${d.fix}`);

  // THE ARM, BYTE-FOR-BYTE. No offer, no appendix, and the "carries its own meaning" half is not
  // emitted either — `wired` is empty, and asserting an edge's meaning over a graph with no edge is
  // the falsehood this change removes. What is left is the counterfactual the NOTE is about, which
  // this change does NOT repair and which stays wrong for this one shape.
  assert.equal(
    d.fix,
    'give join "gather" an entry in its `branches` for each of read, classify, and a `kind: join` edge ' +
      'from each of them into "gather" — every node inside a fan-out branch needs both. ADD to whatever ' +
      '"gather" already declares: one join can be the barrier for more than one fan-out. NOTE "read" is ' +
      "this fan-out's own target, so it is dictated whatever already folds it — but \"read\" already " +
      "declares it among its `branches`, so with the barrier declaring it too `GRAPH008_JOIN_DEPTH` " +
      'refuses "read" as held by more than one join. Decide which join is the barrier for "read" and ' +
      "drop the `branches` ENTRY from the other — the entry alone, and NOT any edge: it is a " +
      '`kind: join` edge from "read" INTO "read" that would have made this diagnostic not fire',
  );

  // AND THE MEASUREMENT THAT DECIDED IT. Typing the self-edge does NOT silence this diagnostic and
  // produces no `GRAPH008_JOIN_DEPTH` — `topoSort` returns `[]` on a cycle, so `fanoutDepth`
  // collapses and `claimedBy` counts nothing. Offering that edge, or promising that refusal, would
  // have turned the NOTE's false description into a false instruction.
  const withSelfEdge = clone(s) as unknown as GraphSpec;
  (withSelfEdge.edges as EdgeSpec[]).push({ id: e("self"), from: n("read"), to: n("read"), kind: "join" } as EdgeSpec);
  const after = errorsOf(withSelfEdge).map((x) => x.code).sort();
  assert.ok(after.includes("GRAPH021_FANOUT_WITHOUT_JOIN"), `the self-edge silences nothing: ${after.join(", ")}`);
  assert.ok(after.includes("GRAPH006_UNMARKED_CYCLE"), after.join(", "));
  assert.ok(!after.includes("GRAPH008_JOIN_DEPTH"), `and no collision is refused: ${after.join(", ")}`);
});

test("THE SILENT `compensation` SHAPE: ONE diagnostic, and the clause is the only mention of it", () => {
  // The third spelling of the rule's silence, and the one that makes "all three are pinned" true.
  // The plural test above has TWO claimers, so `GRAPH008_JOIN_DEPTH` names them in that same
  // compile — it does not exercise silence at all. Here there is ONE claimer wired by a
  // `compensation` edge: `idx.ancestors` walks no such edge, so `joined` is false and GRAPH021
  // fires; `GRAPH008_BRANCH_NOT_CONNECTED` accepts an inbound edge of ANY kind, so it says nothing;
  // and `claimedBy` counts one, so `GRAPH008_JOIN_DEPTH` says nothing either. Without §A.69's
  // clause NOTHING in this output would name `again`.
  //
  // `read` is a `tool` node because a `compensation` edge must compensate one; `unhandled: true`
  // takes GRAPH011's warning off the list so the ENTIRE diagnostic set is the one line below.
  const spec = {
    apiVersion: "loom.dev/v1", kind: "GraphSpec",
    metadata: { name: "etoc", project: "probe", version: 1 },
    policy: {
      posture: "in", capabilities: ["k8s:write"],
      expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 2 },
    },
    channels: {
      items: { type: "array", reduce: "replace" },
      shards: { type: "array", reduce: "replace" },
      shard: { type: "string", reduce: "replace" },
      raw: { type: "string", reduce: "append_ordered" },
      failures: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["items", "failures"], outputs: ["report"],
    nodes: [
      { id: n("plan"), type: "function", reads: ["items"], writes: ["shards"], function: { ref: "function/plan@stable" } },
      { id: n("read"), type: "tool", reads: ["shard", "failures"], writes: ["raw", "failures"], tool: { name: "k8s.apply", args: {} }, unhandled: true },
      { id: n("classify"), type: "function", reads: ["shard", "raw"], writes: ["failures"], function: { ref: "function/classify@stable" } },
      { id: n("gather"), type: "join", reads: ["failures"], writes: ["failures"], join: { branches: [n("classify")], mode: "all", onBranchError: "fail" } },
      { id: n("collate"), type: "function", reads: ["failures"], writes: ["report"], function: { ref: "function/collate@stable" } },
      { id: n("again"), type: "join", reads: ["failures"], writes: ["failures"], join: { branches: [n("read")], mode: "all", onBranchError: "fail" } },
    ],
    edges: [
      { id: e("fan"), from: n("plan"), to: n("read"), kind: "fanout", over: "shards", as: "shard", maxWidth: 4 },
      { id: e("sort"), from: n("read"), to: n("classify"), kind: "seq" },
      { id: e("collect"), from: n("classify"), to: n("gather"), kind: "join" },
      { id: e("fold"), from: n("gather"), to: n("collate"), kind: "seq" },
      { id: e("back"), from: n("read"), to: n("again"), kind: "compensation", compensates: n("read") },
      { id: e("out"), from: n("again"), to: n("collate"), kind: "seq" },
    ],
  } as unknown as GraphSpec;

  // THE WHOLE SET, warnings included — a stray diagnostic must not be able to hide behind a filter
  // and quietly become the thing that names `again`.
  assert.deepEqual(
    diagnose(spec).map((x) => `${x.severity}:${x.code}`),
    ["error:GRAPH021_FANOUT_WITHOUT_JOIN"],
    "exactly one diagnostic, or this fixture no longer demonstrates silence",
  );
  const [d] = diagnose(spec);
  assert.deepEqual(claimedIn(d!.fix ?? ""), ["again"], `the clause is the only mention of it: ${d!.fix}`);
  assert.ok(!d!.message.includes("again"), `the MESSAGE does not name it — only the fix: does: ${d!.message}`);

  // And the prediction still holds: the dictated edit produces the collision, naming both joins.
  const after = applyDictated(spec, d!, "gather");
  assert.deepEqual(
    after.map((x) => `${x.code}@${String(x.at?.nodeId)}`),
    ["GRAPH008_JOIN_DEPTH@read"],
    "the edit produces exactly the refusal the clause named",
  );
  assert.match(after[0]!.message, /2 joins \("gather", "again"\)/, after[0]!.message);
});

test("A LINE WITH NO CLAIMER CARRIES NO CLAUSE — `claimedIn` is not vacuous", () => {
  // WHAT THIS ACTUALLY GUARDS, stated precisely, because the first cut over-claimed it. The
  // `deepEqual` call sites above compare against NON-EMPTY arrays, so a clause that never fired
  // turns those red on their own; it is the `.every(...)` in case (c) — vacuously true over `[]` —
  // that needs a control. And the thing neither kind of call site can see is the OTHER direction:
  // that a line with no claimer stays clean. The shipped F1 shape has no second claimer of `read`,
  // so it must carry no NOTE at all.
  const [d] = errorsOf(f1Step1()).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(d !== undefined);
  assert.deepEqual(claimedIn(d.fix ?? ""), [], `no claimer, so no clause: ${d.fix}`);
  assert.doesNotMatch(d.fix ?? "", /NOTE/, `${d.fix}`);
});

/** `heldInner`-style helper: type the `fix:` line's `branches` entries and `kind: join` edges. */
function applyDictated(spec: GraphSpec, d: Diagnostic, pick: string): readonly Diagnostic[] {
  const s = clone(spec) as unknown as GraphSpec;
  const names = namesIn(d.fix ?? "");
  const j = s.nodes.findIndex((x) => x.id === n(pick));
  const had = (s.nodes[j]! as NodeSpec).join!.branches;
  (s.nodes as NodeSpec[])[j] = {
    ...s.nodes[j]!,
    join: { ...(s.nodes[j]! as NodeSpec).join!, branches: [...had, ...names.filter((w) => !had.includes(n(w))).map(n)] },
  } as NodeSpec;
  for (const w of names) {
    if (!s.edges.some((x) => x.from === n(w) && x.to === n(pick) && x.kind === "join")) {
      (s.edges as EdgeSpec[]).push({ id: e(`add-${w}-${pick}`), from: n(w), to: n(pick), kind: "join" } as EdgeSpec);
    }
  }
  return errorsOf(s);
}

test("A CANDIDATE THAT ALREADY FOLDS A MEMBER: BOTH choices must compile, not one", () => {
  // The first fix round excluded EVERY candidate from the fold test, so a member one candidate
  // already declares was dictated to the OTHER — and the line then compiled for one of the two
  // names it offered and was refused for the other. `reachesEveryCandidate`'s own rationale, the
  // list has to be true whichever the author picks, is what that broke.
  //
  //     plan --fan--> read --seq--> classify --join--> gA(join, branches:["classify"])
  //                                                       --join--> gB(join, branches:["gA"])
  const s = shipped();
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = { ...s.nodes[g]!, id: n("gA"), join: { branches: [n("classify")], mode: "all", onBranchError: "fail" } } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect-read")), 1);
  (s.edges as EdgeSpec[])[s.edges.findIndex((x) => x.id === e("collect"))] = {
    id: e("collect"), from: n("classify"), to: n("gA"), kind: "join",
  } as EdgeSpec;
  (s.nodes as NodeSpec[]).push({
    id: n("gB"), type: "join", reads: ["failures"], writes: ["failures"],
    join: { branches: [n("gA")], mode: "all", onBranchError: "fail" },
  } as NodeSpec);
  (s.edges as EdgeSpec[]).push({ id: e("toB"), from: n("gA"), to: n("gB"), kind: "join" } as EdgeSpec);
  (s.edges as EdgeSpec[])[s.edges.findIndex((x) => x.id === e("fold"))] = {
    id: e("fold"), from: n("gB"), to: n("collate"), kind: "seq",
  } as EdgeSpec;

  const first = errorsOf(s);
  assert.deepEqual(first.map((x) => x.code), ["GRAPH021_FANOUT_WITHOUT_JOIN"], "one error, so the fix line is the whole remedy");
  const d = first[0]!;
  assert.deepEqual([...offeredJoins(d.fix ?? "")].sort(), ["gA", "gB"]);
  assert.deepEqual(namesIn(d.fix ?? ""), ["read"], `\`classify\` is already folded by a candidate: ${d.fix}`);
  assert.deepEqual(countedIn(d.message).absent.get("classify"), { reason: "folded", by: ["gA"] });

  // THE ASSERTION THE ROUND BEFORE THIS ONE COULD NOT MAKE: both names it offers, not one.
  for (const pick of offeredJoins(d.fix ?? "")) {
    assert.deepEqual(applyDictated(s, d, pick).map((x) => x.code), [], `picking "${pick}" must compile: ${d.fix}`);
  }
});

test("A CLAIM `idx.ancestors` CANNOT SEE IS ONE `GRAPH008` STILL COUNTS — a `compensation` edge", () => {
  // F3. `foldersOf` used to require the claiming join to be DOWNSTREAM of its member, which
  // `idx.ancestors` answers — and `idx.ancestors` walks neither `loop` nor `compensation` edges,
  // while `rule008`'s `claimedBy` needs no path at all. So a claim joined to its member by one of
  // those was invisible here and counted there, and following the line printed a
  // `GRAPH008_JOIN_DEPTH` the first compile had not. The predicate now makes `claimedBy`'s test —
  // what the COMPILER will count, which is the only thing a `fix:` line has to predict.
  //
  //     plan --fan--> read --seq--> classify --seq--> extra --join--> gather(branches:["extra"])
  //                                     \--compensation--> again(join, branches:["classify"])
  const s = shipped();
  (s.channels as Record<string, unknown>)["raw"] = { type: "string", reduce: "append_ordered" };
  (s.nodes as NodeSpec[]).push(
    { id: n("extra"), type: "function", reads: ["shard"], writes: ["failures"], function: { ref: "function/extra@stable" } } as NodeSpec,
    { id: n("again"), type: "join", reads: ["failures"], writes: ["failures"], join: { branches: [n("classify")], mode: "all", onBranchError: "fail" } } as NodeSpec,
  );
  const g = s.nodes.findIndex((x) => x.id === n("gather"));
  (s.nodes as NodeSpec[])[g] = { ...s.nodes[g]!, join: { branches: [n("extra")], mode: "all", onBranchError: "fail" } } as NodeSpec;
  (s.edges as EdgeSpec[]).splice(s.edges.findIndex((x) => x.id === e("collect-read")), 1);
  (s.edges as EdgeSpec[])[s.edges.findIndex((x) => x.id === e("collect"))] = {
    id: e("collect"), from: n("extra"), to: n("gather"), kind: "join",
  } as EdgeSpec;
  (s.edges as EdgeSpec[]).push(
    { id: e("more"), from: n("classify"), to: n("extra"), kind: "seq" } as EdgeSpec,
    { id: e("back"), from: n("classify"), to: n("again"), kind: "compensation" } as EdgeSpec,
  );

  const first = errorsOf(s);
  const d = first.find((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN" && x.at?.edgeId === e("fan"));
  assert.ok(d !== undefined, first.map((x) => x.code).join(", "));
  assert.deepEqual(namesIn(d.fix ?? ""), ["read", "extra"], `\`classify\` belongs to \`again\`: ${d.fix}`);
  assert.deepEqual(countedIn(d.message).absent.get("classify"), { reason: "folded", by: ["again"] });

  // And following the line introduces nothing the first compile did not print. (`again`\'s
  // compensation edge draws its own GRAPH012, which is there before and after and is not this
  // rule\'s business.)
  const before = first.map((x) => `${x.code}@${String(x.at?.nodeId ?? x.at?.edgeId)}`).sort();
  const after = applyDictated(s, d, "gather").map((x) => `${x.code}@${String(x.at?.nodeId ?? x.at?.edgeId)}`).sort();
  assert.deepEqual(after, before.filter((x) => !x.startsWith("GRAPH021")), `nothing new: ${after.join(", ")}`);
});

test("the count/list disclosure appears ONLY when the two sets disagree", () => {
  // On the F1 graph every branch member feeds `gather`, so the count and the list are the same
  // set and the sentence is exactly true without a qualifier. A clause that always fires would
  // teach a divergence that is not there.
  const [d] = errorsOf(f1Step1()).filter((x) => x.code === "GRAPH021_FANOUT_WITHOUT_JOIN");
  assert.ok(d !== undefined);
  const { counted, absent } = countedIn(d.message);
  assert.deepEqual([...counted].sort(), [...namesIn(d.fix ?? "")].sort());
  assert.equal(absent.size, 0);
  assert.doesNotMatch(d.message, /in this count and not in that list/);
});
