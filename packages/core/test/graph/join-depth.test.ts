/**
 * A join's fan-out depth must be decidable, because the runtime bets on it.
 *
 * `#maybeFireJoin` truncates an arriving branch coordinate to the join's compiled depth to
 * name which INSTANCE of the barrier the branch belongs to, and `#foldJoin` reads the same
 * number to decide whether to hold its fold or apply it. Both were written against a rule
 * that did not exist: two comments cited `GRAPH008_JOIN_DEPTH` as refusing ambiguous
 * graphs, and nothing emitted it. When the depth is absent the runtime falls back to "one
 * level up from whoever arrived" — the expression the fan-out-depth change replaced — so
 * two arms at different depths mint two instances of one barrier and fold the same
 * contributions twice.
 *
 * The fallback is only safe if it is unreachable. This is what makes it unreachable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { indexGraph, validateGraph, type Diagnostic } from "../../src/graph/validate.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { resolver } from "../run/skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function codes(spec: GraphSpec): string[] {
  return validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }).map((d) => d.code);
}

const base = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "join-depth", project: "probe", version: 1 },
  policy: { expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 4, maxLoopIterations: 1 } },
  channels: {
    outers: { type: "array", reduce: "replace" },
    inners: { type: "array", reduce: "replace" },
    outerItem: { type: "object", reduce: "replace" },
    innerItem: { type: "object", reduce: "replace" },
    findings: { type: "array", reduce: "append_ordered" },
  },
  inputs: ["outers", "inners"],
  outputs: ["findings"],
};

const fn = (id: string, extra: Record<string, unknown> = {}): unknown => ({
  id: n(id),
  type: "function",
  function: { ref: `function/${id}@stable` },
  ...extra,
});

/** `outer` at depth 1 and `inner` at depth 2 both feed one join — depth undecidable. */
function armsAtTwoDepths(): GraphSpec {
  return {
    ...base,
    nodes: [
      fn("start", { reads: ["outers"] }),
      fn("outer", { reads: ["outerItem"], writes: ["findings"] }),
      fn("inner", { reads: ["innerItem"], writes: ["findings"] }),
      {
        id: n("j"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("outer"), n("inner")], mode: "all", onBranchError: "skip" },
      },
    ],
    edges: [
      { id: e("fo1"), from: n("start"), to: n("outer"), kind: "fanout", over: "outers", maxWidth: 2 },
      { id: e("fo2"), from: n("outer"), to: n("inner"), kind: "fanout", over: "inners", maxWidth: 2 },
      { id: e("j1"), from: n("outer"), to: n("j"), kind: "join" },
      { id: e("j2"), from: n("inner"), to: n("j"), kind: "join" },
    ],
  } as unknown as GraphSpec;
}

/** One fan-out, one arm, one join — the ordinary shape, which must keep compiling. */
function wellFormed(): GraphSpec {
  return {
    ...base,
    nodes: [
      fn("start", { reads: ["outers"] }),
      fn("outer", { reads: ["outerItem"], writes: ["findings"] }),
      {
        id: n("j"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("outer")], mode: "all", onBranchError: "skip" },
      },
    ],
    edges: [
      { id: e("fo1"), from: n("start"), to: n("outer"), kind: "fanout", over: "outers", maxWidth: 2 },
      { id: e("j1"), from: n("outer"), to: n("j"), kind: "join" },
    ],
  } as unknown as GraphSpec;
}

test("A JOIN WHOSE ARMS SIT AT DIFFERENT FAN-OUT DEPTHS IS REFUSED", () => {
  const spec = armsAtTwoDepths();

  // The precondition the runtime bets on, stated as the compiler sees it: with `inner`
  // one level deeper than `outer`, no single truncation names one barrier instance.
  const idx = indexGraph(spec);
  assert.notEqual(
    idx.fanoutDepth.get(n("outer")),
    idx.fanoutDepth.get(n("inner")),
    "precondition: the two arms really are at different depths",
  );

  assert.ok(
    codes(spec).includes("GRAPH008_JOIN_DEPTH"),
    "an undecidable barrier must not compile — the runtime's fallback silently mints two instances",
  );
});

test("…and the ordinary one-fan-out shape still compiles", () => {
  assert.equal(
    codes(wellFormed()).includes("GRAPH008_JOIN_DEPTH"),
    false,
    "a rule that refuses the normal shape is worse than no rule",
  );
});

/**
 * A held join's fold has to be collected by something.
 *
 * A join inside a fan-out does not apply its fold to shared channel state — that would make
 * the result depend on which sibling committed first — so it returns the fold as its own
 * Task's writes and relies on the ENCLOSING join to fold the siblings in branch order.
 *
 * The premise nothing checked: an enclosing join has to EXIST and has to NAME it. Without
 * that, the held fold is written to a task nobody reads, and the run reports success having
 * silently dropped everything the inner barrier collected — invisible from the journal,
 * because the inner join really did succeed and really did write.
 */
test("A JOIN INSIDE A FAN-OUT THAT NO OUTER JOIN COLLECTS IS REFUSED", () => {
  // Two fan-out levels, so `innerJoin` sits at depth 1 and HOLDS its fold. `outerJoin`
  // deliberately does not name it — which is the whole defect: the held fold is written to
  // a task nobody reads and the run reports success having dropped it.
  const spec = {
    ...base,
    metadata: { name: "held-uncollected", project: "probe", version: 1 },
    channels: {
      outerSeed: { type: "array", reduce: "replace" },
      outerItem: { type: "object", reduce: "replace" },
      innerSeed: { type: "array", reduce: "replace" },
      innerItem: { type: "object", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["outerSeed"],
    outputs: ["report"],
    nodes: [
      { id: n("start"), type: "function", reads: ["outerSeed"], function: { ref: "function/seed@stable" } },
      { id: n("outer"), type: "function", reads: ["outerItem"], function: { ref: "function/outer@stable" } },
      { id: n("inner"), type: "function", reads: ["innerItem"], writes: ["findings"], function: { ref: "function/inner@stable" } },
      {
        id: n("innerJoin"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("inner")], mode: "all", onBranchError: "skip" },
      },
      {
        id: n("outerJoin"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        // `innerJoin` is NOT here. That is the defect under test.
        join: { branches: [n("outer")], mode: "all", onBranchError: "skip" },
      },
      { id: n("finish"), type: "function", reads: ["findings"], writes: ["report"], function: { ref: "function/report@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("outer"), kind: "fanout", over: "outerSeed", as: "outerItem", maxWidth: 8 },
      { id: e("fi"), from: n("outer"), to: n("inner"), kind: "fanout", over: "innerSeed", as: "innerItem", maxWidth: 8 },
      { id: e("ji"), from: n("inner"), to: n("innerJoin"), kind: "join", branches: [n("inner")] },
      { id: e("jo1"), from: n("outer"), to: n("outerJoin"), kind: "join", branches: [n("outer")] },
      { id: e("done"), from: n("outerJoin"), to: n("finish"), kind: "seq" },
    ],
  };
  const got = codes(spec as unknown as GraphSpec);
  assert.ok(
    got.includes("GRAPH008_HELD_JOIN_UNCOLLECTED"),
    `expected the held join to be refused; got ${got.join(", ") || "(no diagnostics)"}`,
  );
});
/**
 * §A.64 — WHICH JOIN FOLDS A FAN-OUT'S NODE, AND HOW MANY OF THEM DO.
 *
 * `GRAPH008_JOIN_DEPTH` compared `fanoutDepth` NUMBERS and never `fanoutEdgeStack`, so an arm one
 * level up in the WRONG fan satisfied `armDepth === joinDepth + 1`. Two things came out of
 * chasing that, and only the second is about depth at all.
 *
 * THE FACT THE SECOND RESTS ON is `writesHeldForJoin(branch) = branch.segments.length > 0`
 * (`run/engine.ts`). Holding is a property of the TASK'S OWN DEPTH and of nothing else — not of
 * its relation to any join. `#immediateReduce` does not apply the writes of a Task inside a
 * fan-out, and `#foldJoin` applies the held writes of every declared member at or under the
 * join's coordinate. So ANY join naming a node with `fanoutDepth >= 1` folds that node's writes,
 * whatever its own depth and whichever fan-out either of them is in — and two such joins fold them
 * twice.
 *
 * MEASURED ON A REAL ENGINE, `append_ordered`, contributions counted against succeeded writer
 * tasks. Every one of these compiled with zero diagnostics before the rule existed:
 *
 *     one arm, two root joins                        n=4  expected 2
 *     ambiguous body, two joins                      n=8  expected 4
 *     ... through a router                           n=4  expected 2
 *     ... at two different depths                    n=8  expected 4
 *     one claimant's stack known, the other's not    n=6  expected 4
 *     a join at the arm's OWN depth, plus one above  n=4  expected 2
 *     GRAPH021's own dictated a53 convergence        n=6  expected 4
 *
 * and every shape below that this file asserts still compiles folds each contribution EXACTLY
 * ONCE on the same harness. That correspondence — refused iff it double-folds, over eighteen
 * shapes — is what says the rule is the right one rather than merely a rule.
 *
 * WHAT IS NOT REFUSED, on purpose: a fan-out's branch whose nodes go to two DISJOINT joins. It
 * folds every contribution once and only the ORDER differs, so refusing it would trade a working
 * graph for an ordering nobody declared. An earlier cut of this rule did refuse it.
 */

const a64Base = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "a64", project: "probe", version: 1 },
  policy: { expansion: { maxNodes: 40, maxDepth: 4, maxFanout: 4, maxLoopIterations: 2 } },
  channels: {
    request: { type: "string", reduce: "replace" },
    outers: { type: "array", reduce: "replace" },
    inners: { type: "array", reduce: "replace" },
    outerItem: { type: "object", reduce: "replace" },
    innerItem: { type: "object", reduce: "replace" },
    findings: { type: "array", reduce: "append_ordered" },
  },
  inputs: ["request", "outers", "inners"],
  outputs: ["findings"],
};

const plan = (id: string, writes: readonly string[] = []): unknown => ({
  id: n(id),
  type: "function",
  reads: ["request"],
  ...(writes.length > 0 ? { writes: [...writes] } : {}),
  function: { ref: `function/${id}@stable` },
});

const work = (id: string, reads: string): unknown => ({
  id: n(id),
  type: "function",
  reads: [reads],
  writes: ["findings"],
  function: { ref: `function/${id}@stable` },
});

const barrier = (id: string, branches: readonly string[]): unknown => ({
  id: n(id),
  type: "join",
  reads: ["findings"],
  writes: ["findings"],
  join: { branches: branches.map(n), mode: "all", onBranchError: "skip" },
});

const fanout = (id: string, from: string, to: string, over: string, as: string): unknown => ({
  id: e(id), from: n(from), to: n(to), kind: "fanout", over, as, maxWidth: 2,
});
const joins = (id: string, from: string, to: string): unknown => ({ id: e(id), from: n(from), to: n(to), kind: "join" });
const seq = (id: string, from: string, to: string): unknown => ({ id: e(id), from: n(from), to: n(to), kind: "seq" });
const g = (nodes: unknown[], edges: unknown[]): GraphSpec => ({ ...a64Base, nodes, edges }) as unknown as GraphSpec;

/** The one diagnostic this section is about, or `undefined`. */
function claimRefusal(spec: GraphSpec): Diagnostic | undefined {
  return validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }).find(
    (x) => x.code === "GRAPH008_JOIN_DEPTH" && /HOLDS its writes for ONE join/.test(x.message),
  );
}

/** The claimants a refusal names, as a SET — prose may move, the name set is the claim. */
function claimants(d: Diagnostic): readonly string[] {
  const m = /joins \(((?:"[^"]+"(?:, )?)+)\) declare it/.exec(d.message);
  assert.ok(m !== null, `refusal names no claimants — has the sentence changed shape?\n  ${d.message}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

// ── the shapes that DOUBLE-FOLD, and are refused ────────────────────────────

test("§A.64 ONE ARM, TWO ROOT JOINS — measured n=4 against 2 contributions", () => {
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jB", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), joins("e2", "a0", "jB")],
  );
  const d = claimRefusal(spec);
  assert.ok(d !== undefined, "two joins over one fan-out arm fold it twice");
  assert.equal(d.at?.nodeId, n("a0"), "the refusal names the ARM, which is the thing folded twice");
  assert.deepEqual([...claimants(d)].sort(), ["jA", "jB"], d.message);
});

test("§A.64 …AND A JOIN AT THE ARM'S OWN DEPTH COUNTS — holding is the TASK's depth", () => {
  // The seam the `armDepth === joinDepth + 1` filter left open, and the reason this rule is about
  // nodes rather than about depths. `jSame` is reached by a `seq` edge so it sits INSIDE the
  // fan-out at `a0`'s own depth — and `writesHeldForJoin` does not care: `a0`'s writes are held,
  // `jSame` folds them, `jUp` folds them again. Measured n=4 against 2 contributions.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jSame", ["a0"]), barrier("jUp", ["a0", "jSame"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), seq("s", "a0", "jSame"), joins("e1", "jSame", "jUp"), joins("e2", "a0", "jUp")],
  );
  const idx = indexGraph(spec);
  assert.equal(idx.fanoutDepth.get(n("jSame")), idx.fanoutDepth.get(n("a0")), "precondition: the join is at the ARM's own depth");
  const d = claimRefusal(spec);
  assert.ok(d !== undefined, "a join at the arm's own depth folds its held writes too");
  assert.deepEqual([...claimants(d)].sort(), ["jSame", "jUp"], d.message);
});

test("§A.64 …AND THE SAME GRAPH WITH ONE CLAIMANT COMPILES", () => {
  // The two-sided control for the one above: `jUp` stops naming `a0` and takes `jSame`'s fold.
  // Measured n=2 against 2. One `branches` entry and one edge of difference.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jSame", ["a0"]), barrier("jUp", ["jSame"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), seq("s", "a0", "jSame"), joins("e1", "jSame", "jUp")],
  );
  assert.deepEqual(codes(spec), []);
});

/** Two same-width fan-out edges into one body: the body's edge stack is AMBIGUOUS. */
function ambiguousBody(second: boolean): GraphSpec {
  return g(
    [plan("p", ["outers"]), plan("p2", ["outers"]), work("body", "outerItem"), barrier("jA", ["body"]),
      ...(second ? [barrier("jB", ["body"])] : [])],
    [seq("s", "p", "p2"), fanout("f1", "p", "body", "outers", "outerItem"), fanout("f2", "p2", "body", "outers", "outerItem"),
      joins("e1", "body", "jA"), ...(second ? [joins("e2", "body", "jB")] : [])],
  );
}

test("§A.64 …AND AN AMBIGUOUS FAN-OUT IS COUNTED TOO — ambiguity propagates", () => {
  // Keying the count on the fan-out EDGE missed this entirely: the body is reachable through two
  // fan-out edges of the same width, so it has no edge stack — and neither does any join below
  // it, because ambiguity propagates. The node id is the one thing that is never missing.
  const spec = ambiguousBody(true);
  const idx = indexGraph(spec);
  assert.equal(idx.fanoutEdgeStack.get(n("body")), undefined, "precondition: the body's fan-out cannot be named");
  assert.equal(idx.fanoutEdgeStack.get(n("jA")), undefined, "precondition: and the ambiguity reaches the joins");
  const d = claimRefusal(spec);
  assert.ok(d !== undefined, "measured n=8 against 4 contributions");
  assert.deepEqual([...claimants(d)].sort(), ["jA", "jB"], d.message);
});

test("§A.64 …AND THE SAME AMBIGUOUS BODY WITH ONE JOIN COMPILES", () => {
  // `test/run/empty-fanout-oversight.test.ts`'s router steers between two list-builders that fan
  // out into one shared body; exactly one edge ever fires, and the fixture declares ONE join over
  // it. Measured n=4 against 4. Ambiguity is not the defect; a second claimant is.
  assert.deepEqual(codes(ambiguousBody(false)), []);
});

/** The router-steered spelling of the same thing — `empty-fanout-oversight`'s own shape. */
function steeredBody(second: boolean): GraphSpec {
  return g(
    [{ id: n("route"), type: "router", reads: ["request"],
       router: { mode: "expression", cases: [{ when: `contains(request, "NONE")`, take: ["toE"] }], fallbackEdge: "toF" } },
      plan("pe", ["outers"]), plan("pf", ["outers"]), work("hold", "outerItem"), barrier("jj", ["hold"]),
      ...(second ? [barrier("jj2", ["hold"])] : [])],
    [seq("toE", "route", "pe"), seq("toF", "route", "pf"),
      fanout("fanE", "pe", "hold", "outers", "outerItem"), fanout("fanF", "pf", "hold", "outers", "outerItem"),
      joins("e1", "hold", "jj"), ...(second ? [joins("e2", "hold", "jj2")] : [])],
  );
}

test("§A.64 …AND THROUGH A ROUTER, both ways", () => {
  assert.deepEqual(codes(steeredBody(false)), [], "this is `empty-fanout-oversight`'s own shape and must not move");
  const d = claimRefusal(steeredBody(true));
  assert.ok(d !== undefined, "measured n=4 against 2 contributions");
  assert.deepEqual([...claimants(d)].sort(), ["jj", "jj2"], d.message);
});

test("§A.64 …AND A PAIR OF CLAIMANTS ONE OF WHOSE STACKS IS KNOWN", () => {
  // The seam between the two maps the previous cut used: `kKnown` has a stack and `kAmb` does not,
  // so the pair landed in different maps and neither saw two. Measured n=6 against 4.
  const spec = g(
    [plan("p", ["outers"]), plan("p2", ["outers"]), work("p1", "outerItem"), work("q", "outerItem"),
      barrier("kKnown", ["p1"]), barrier("kAmb", ["p1", "q"])],
    [fanout("f1", "p", "p1", "outers", "outerItem"), seq("s", "p", "p2"), fanout("f2", "p2", "q", "outers", "outerItem"),
      joins("e1", "p1", "kKnown"), joins("e2", "p1", "kAmb"), joins("e3", "q", "kAmb")],
  );
  const d = claimRefusal(spec);
  assert.ok(d !== undefined, "one known stack and one ambiguous one are still two claimants");
  assert.deepEqual([...claimants(d)].sort(), ["kAmb", "kKnown"], d.message);
});

// ── the shapes that fold ONCE EACH, and compile ─────────────────────────────

/**
 * §A.64's own repro, and the reading of it the row got wrong.
 *
 * `plan` fans out twice; inside fan A, `a0 --fanInner--> a1 --join--> aJoin`, so `aJoin` is held.
 * `crossed` hands it to fan B's barrier, which is what the row calls the defect. Neither spelling
 * is: measured n=8 against 8 contributions both ways. With `a0` among `bJoin.branches` — which
 * `GRAPH008_BRANCH_NOT_CONNECTED` forces — `bJoin` IS fan A's barrier as well as fan B's, so the
 * author who followed the `fix:` line picked the right join.
 */
function siblingFans(crossed: boolean): GraphSpec {
  return g(
    [plan("p", ["outers", "inners"]), work("a0", "outerItem"), work("a1", "innerItem"), barrier("aJoin", ["a1"]),
      barrier("aOuter", crossed ? ["a0"] : ["a0", "aJoin"]), work("b0", "outerItem"),
      barrier("bJoin", crossed ? ["b0", "aJoin"] : ["b0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), fanout("fanB", "p", "b0", "outers", "outerItem"),
      fanout("fanInner", "a0", "a1", "inners", "innerItem"),
      joins("jInner", "a1", "aJoin"), joins("jOuter", "a0", "aOuter"), joins("jB", "b0", "bJoin"),
      joins("jHeld", "aJoin", crossed ? "bJoin" : "aOuter")],
  );
}

test("§A.64 A HELD JOIN IN A SIBLING FAN'S BARRIER COMPILES — it folds once each", () => {
  // The row's premise says this is the hole. It is not: every contribution lands exactly once
  // (n=8 against 8), and only the ORDER differs from the same-fan spelling. An earlier cut of
  // this rule refused it, by counting barriers per fan-out rather than claimants per node.
  const idx = indexGraph(siblingFans(true));
  assert.equal(idx.fanoutDepth.get(n("aJoin")), (idx.fanoutDepth.get(n("bJoin")) ?? -1) + 1, "precondition: one level up");
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("aJoin")) ?? [])], [e("fanA")], "precondition: and in fan A");
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("bJoin")) ?? [])], [], "precondition: while the barrier is in neither");
  assert.deepEqual(codes(siblingFans(true)), []);
});

test("…and so does the same graph with the held join in its OWN fan", () => {
  assert.deepEqual(codes(siblingFans(false)), []);
});

test("…and ONE barrier over SEVERAL sibling fan-outs still compiles", () => {
  // `#maybeFireJoin` sums `expected` over one plan per fan-out edge for exactly this graph.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), work("b0", "outerItem"), barrier("both", ["a0", "b0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), fanout("fanB", "p", "b0", "outers", "outerItem"),
      joins("jA", "a0", "both"), joins("jB", "b0", "both")],
  );
  assert.deepEqual(codes(spec), []);
});

test("…and a branch whose two nodes go to two DISJOINT joins compiles", () => {
  // The trade this rule does NOT make. Measured n=4 against 4: each node has one claimant, every
  // contribution lands once, and only the fold ORDER differs from one barrier over both. The
  // previous cut refused this, and refusing a working graph to protect an undeclared ordering is
  // the thing that made it the wrong rule.
  const spec = g(
    [plan("p", ["outers"]), work("read", "outerItem"), work("classify", "outerItem"), barrier("jR", ["read"]), barrier("jC", ["classify"])],
    [fanout("fan", "p", "read", "outers", "outerItem"), seq("s1", "read", "classify"),
      joins("e1", "read", "jR"), joins("e2", "classify", "jC")],
  );
  assert.deepEqual(codes(spec), []);
});

test("…and the §A.56 double-nested shape, each held join in its innermost barrier", () => {
  const spec = g(
    [plan("p", ["outers", "inners"]), work("o", "outerItem"), work("i", "innerItem"), barrier("inner", ["i"]), barrier("outer", ["o", "inner"])],
    [fanout("f1", "p", "o", "outers", "outerItem"), fanout("f2", "o", "i", "inners", "innerItem"),
      joins("ji", "i", "inner"), joins("jo", "o", "outer"), joins("jx", "inner", "outer")],
  );
  assert.deepEqual(codes(spec), []);
});

// ── and the depth rules the fan-out identity check still answers ────────────

test("…and an arm two levels up is still refused for the OLD reason", () => {
  // `a1` sits two fan-outs below the barrier and is DECLARED without an edge, which is the only
  // way to reach that arm: any edge from `a1` to `far` would put `far` itself at two depths, and
  // the join-level check answers first. So this graph is refused twice, and one of the two must
  // still be "never further".
  const spec = g(
    [plan("p", ["outers", "inners"]), work("a0", "outerItem"), work("a1", "innerItem"), barrier("far", ["a0", "a1"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), fanout("fanInner", "a0", "a1", "inners", "innerItem"),
      joins("jA", "a0", "far")],
  );
  const found = validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }).filter(
    (x) => x.code === "GRAPH008_JOIN_DEPTH",
  );
  assert.ok(found.some((x) => /never further/.test(x.message)), found.map((x) => x.message).join(" | ") || "(none)");
});

test("§A.64 AND AN ARM IN A DIFFERENT OUTER FAN IS REFUSED where the identity IS known", () => {
  // The arm-side stack comparison, on the one shape that reaches it: `b1` is declared as an arm of
  // `j` and wired by a LOOP edge, which the stack traversal excludes — so `j`'s own stack stays
  // `["F1"]` while its arm's is `["F2","fanB"]`. Depths agree and the fan-outs do not.
  const spec = g(
    [plan("p", ["outers", "inners"]), plan("x"), plan("y"), work("a0", "innerItem"), work("b1", "innerItem"), barrier("j", ["a0", "b1"])],
    [fanout("F1", "p", "x", "outers", "outerItem"), fanout("F2", "p", "y", "outers", "outerItem"),
      fanout("fanA", "x", "a0", "inners", "innerItem"), fanout("fanB", "y", "b1", "inners", "innerItem"),
      joins("jA", "a0", "j"), { id: e("lb"), from: n("b1"), to: n("j"), kind: "loop", maxIterations: 2 }],
  );
  const idx = indexGraph(spec);
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("j")) ?? [])], [e("F1")], "precondition: the join is in F1");
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("b1")) ?? [])], [e("F2"), e("fanB")], "precondition: the arm is in F2");
  const found = validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }).filter(
    (x) => x.code === "GRAPH008_JOIN_DEPTH" && /different fan-out is a different instance space/.test(x.message),
  );
  assert.equal(found.length, 1, found.map((x) => x.message).join(" | ") || "(none)");
});

// ── §A.73 · the `fix:` line names the edge that is THERE ─────────────────────
//
// The refusal above dictates dropping a `branches` entry AND a `kind: join` edge. `join.branches`
// is a NAME list and `GRAPH008_BRANCH_NOT_CONNECTED` accepts an inbound edge of ANY kind, so a
// claimer is wired one of three ways — by a `kind: join` edge, by an edge of some other kind
// carrying its own semantics, or by nothing at all — and the line used to dictate the same deletion
// in all three. Measured on the `eto` graph of `docs/handoff-2026-09-15b.md`: the only edge from
// "read" into "again" is `back`, a `loop`, and the line said to delete the `kind: join` edge.
//
// NOTHING PINNED THIS LINE BEFORE — the only copy in the repository was a quotation in that
// handoff — so all three arms are new here, plus the composition. The arm count is three and not
// seven because the clause is built PER DROPPER: no conditional reads more than one dropper, and
// the kinds are rendered by a list join that reads the same for one kind or several.

/** The `fix:` of the one refusal this section is about. */
function claimFix(spec: GraphSpec): string {
  const d = claimRefusal(spec);
  assert.ok(d !== undefined, `no claim refusal: ${codes(spec).join(", ") || "(none)"}`);
  return d.fix ?? "";
}

const loop = (id: string, from: string, to: string): unknown => ({
  id: e(id), from: n(from), to: n(to), kind: "loop", maxIterations: 2,
});

test("§A.73 ARM 1 — a claimer wired `kind: join`: the deletion is dictated, as it always was", () => {
  // The bytes §A.64 shipped, unchanged: this is the arm where "drop the `kind: join` edge" is true.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jB", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), joins("e2", "a0", "jB")],
  );
  assert.equal(
    claimFix(spec),
    'keep one join over "a0": "jB" must drop it from `branches` and drop the `kind: join` edge from ' +
      '"a0", and take "jA"\'s result as an arm instead if it still needs those writes',
  );
});

test("§A.73 ARM 2 — a claimer wired some OTHER kind: the entry alone, and the kind is read", () => {
  // TWO FIXTURES FOR ONE ARM, because the kind is INTERPOLATED and a pin on one spelling cannot
  // tell a read from a constant. `seq` and `loop` differ in the spec and must differ in the line.
  const withSeq = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jSeq", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), seq("s", "a0", "jSeq")],
  );
  assert.equal(
    claimFix(withSeq),
    'keep one join over "a0": "jSeq" must drop it from `branches` — the ENTRY alone, no `kind: join` ' +
      'edge running from "a0" into it to drop; what runs there is `kind: "seq"`, which carries its own ' +
      'meaning, and take "jA"\'s result as an arm instead if it still needs those writes',
  );

  // The `eto` shape of §A.73, in miniature: a `loop` edge carrying its own `maxIterations`, which
  // the old line told the author to delete as though it were the barrier's own wiring.
  const withLoop = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jLoop", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), loop("lp", "a0", "jLoop")],
  );
  assert.equal(
    claimFix(withLoop),
    'keep one join over "a0": "jLoop" must drop it from `branches` — the ENTRY alone, no `kind: join` ' +
      'edge running from "a0" into it to drop; what runs there is `kind: "loop"`, which carries its own ' +
      'meaning, and take "jA"\'s result as an arm instead if it still needs those writes',
  );
});

test("§A.73 ARM 3 — a claimer wired by NOTHING: the sibling line is named, and contradicted no more", () => {
  // `GRAPH008_BRANCH_NOT_CONNECTED` makes exactly this test, so it is refusing the same entry in
  // this same compile — and its `fix:` says to ADD the edge. Following it removes no `branches`
  // entry, and `claimedBy` counts entries, so this refusal survives the edit. The line says so
  // rather than leaving two instructions on screen that point opposite ways.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jNone", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), seq("s2", "p", "jNone")],
  );
  assert.ok(
    codes(spec).includes("GRAPH008_BRANCH_NOT_CONNECTED"),
    `the sibling the line names must be in this compile: ${codes(spec).join(", ")}`,
  );
  assert.equal(
    claimFix(spec),
    'keep one join over "a0": "jNone" must drop it from `branches` — the ENTRY alone, no edge running ' +
      'from "a0" into it at all; that missing edge is what `GRAPH008_BRANCH_NOT_CONNECTED` is refusing ' +
      "in this same compile, and dropping every such entry answers that refusal too, and take " +
      '"jA"\'s result as an arm instead if it still needs those writes',
  );

  // AND THE ONE CLAIM IT MAKES IS RUN. `GRAPH008_BRANCH_NOT_CONNECTED` fires per `branches` ENTRY
  // with no edge, so the drop this line already dictates answers it — one edit, not one per line.
  const dropped = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jNone", [])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), seq("s2", "p", "jNone")],
  );
  assert.ok(!codes(dropped).includes("GRAPH008_BRANCH_NOT_CONNECTED"), codes(dropped).join(", "));
  assert.equal(claimRefusal(dropped), undefined, `and the collision with it: ${codes(dropped).join(", ")}`);

  // AND THE HONEST HALF, because `claimRefusal` and `codes` would both hide it otherwise: the drop
  // answers both ERRORS and leaves a WARNING. A join stripped of its last `branches` entry still
  // declares `writes`, and `GRAPH008_JOIN_WRITES_UNPRODUCED` says a barrier cannot produce what no
  // branch wrote. The claim these lines make is "no new ERROR", never "compiles clean" — asserted on
  // the WHOLE severity-tagged set so a new error cannot arrive unnoticed.
  assert.deepEqual(
    validateGraph({ spec: dropped, resolver: resolver(), tools: {}, tenantCapabilities: [] })
      .map((x) => `${x.severity}:${x.code}`),
    ["warning:GRAPH008_JOIN_WRITES_UNPRODUCED"],
    "the dictated drop introduces no ERROR, and the one warning it does leave is named",
  );

  // AND THE CLAIM IT NO LONGER MAKES, with the reason. An earlier cut said "adding the edge it asks
  // for cements this refusal rather than clearing it". That holds only while the edit leaves the
  // forward graph acyclic — true here, and FALSE in the two shapes below.
  const withEdge = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jNone", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), seq("s2", "p", "jNone"),
      joins("e3", "a0", "jNone")],
  );
  assert.ok(!codes(withEdge).includes("GRAPH008_BRANCH_NOT_CONNECTED"), codes(withEdge).join(", "));
  assert.ok(claimRefusal(withEdge) !== undefined, `the second claim survives the edit: ${codes(withEdge).join(", ")}`);
});

test("§A.73 ARM 3 CLAIMS NOTHING ABOUT ADDING THE EDGE — two shapes where that claim is false", () => {
  // `dropClause` has no cycle guard and needs none, BECAUSE it makes no counterfactual claim. These
  // are the two shapes that forced that: the dropper is the arm ITSELF, and the dropper is UPSTREAM
  // of the arm. In both, typing what `GRAPH008_BRANCH_NOT_CONNECTED` asks for closes a cycle,
  // `topoSort` returns `[]`, every `fanoutDepth` collapses to 0 and `claimedBy` counts nothing — so
  // the refusal is CLEARED, under a `GRAPH006_UNMARKED_CYCLE`. A line promising it would be cemented
  // is a line the compiler refutes.
  const shapes = {
    // `jUp` is upstream of the fan-out's source and still declares `a0`. It is listed AFTER `jA`
    // so that `owners[0]` is the wired join and `jUp` is the DROPPER — the clause under test is the
    // one written for `owners.slice(1)`.
    upstream: g(
      [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jUp", ["a0"])],
      [seq("s0", "p", "jUp"), fanout("fanA", "jUp", "a0", "outers", "outerItem"), joins("e1", "a0", "jA")],
    ),
    // `a0` is itself a join declaring `a0`, so the dictated edge is a self-edge.
    self: g(
      [plan("p", ["outers"]), barrier("jA", ["a0"]), barrier("a0", ["a0"])],
      [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA")],
    ),
  };
  for (const [name, spec] of Object.entries(shapes)) {
    const dropper = name === "upstream" ? "jUp" : "a0";
    const keeper = "jA";
    assert.ok(
      codes(spec).includes("GRAPH008_BRANCH_NOT_CONNECTED"),
      `${name}: the sibling must be in this compile: ${codes(spec).join(", ")}`,
    );
    assert.equal(
      claimFix(spec),
      `keep one join over "a0": "${dropper}" must drop it from \`branches\` — the ENTRY alone, no edge ` +
        'running from "a0" into it at all; that missing edge is what `GRAPH008_BRANCH_NOT_CONNECTED` is ' +
        "refusing in this same compile, and dropping every such entry answers that refusal too, and take " +
        `"${keeper}"'s result as an arm instead if it still needs those writes`,
      name,
    );
    assert.doesNotMatch(claimFix(spec), /cements/, `${name}: no counterfactual about adding the edge`);
  }

  // AND THE REFUTATION, RUN. Adding the edge the sibling asks for on the SELF shape clears this
  // refusal rather than cementing it.
  const withSelfEdge = g(
    [plan("p", ["outers"]), barrier("jA", ["a0"]), barrier("a0", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), joins("e2", "a0", "a0")],
  );
  const after = codes(withSelfEdge);
  assert.ok(after.includes("GRAPH006_UNMARKED_CYCLE"), after.join(", "));
  assert.equal(claimRefusal(withSelfEdge), undefined, `the refusal is CLEARED, not cemented: ${after.join(", ")}`);
});

test("§A.73 ARM 2 WITH SEVERAL KINDS — the list join is what makes the arm count three", () => {
  // The comment claims `kinds` "reads the same for one kind or several", which is the reason there
  // is no singular/plural fourth arm. Unpinned, that claim is a template nobody ran.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jTwo", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"),
      seq("s", "a0", "jTwo"), loop("lp", "a0", "jTwo")],
  );
  assert.equal(
    claimFix(spec),
    'keep one join over "a0": "jTwo" must drop it from `branches` — the ENTRY alone, no `kind: join` ' +
      'edge running from "a0" into it to drop; what runs there is `kind: "seq"`, `kind: "loop"`, which ' +
      'carries its own meaning, and take "jA"\'s result as an arm instead if it still needs those writes',
  );
});

test("§A.73 `kind` IS RENDERED, NEVER ECHOED — it is the only unvalidated string this line reaches", () => {
  // `GRAPH003_UNKNOWN_EDGE_KIND` is an ERROR but NOT fatal, so `checkStructure` does not gate and
  // this rule runs on an edge whose `kind` is whatever the JSON said. Reproduced through the shipped
  // binary before the fix: a kind of `seq"\nok\n   fix: nothing to do here` printed a forged bare
  // `ok` line and a forged `fix:` line INSIDE the compiler's own output. Node ids cannot do this —
  // `GRAPH003_BAD_ID` is fatal and its charset is restricted — so `kind` is the whole exposure.
  const evil = 'seq"\nok\n   fix: nothing to do here';
  const withNewline = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jEvil", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"),
      { id: e("x"), from: n("a0"), to: n("jEvil"), kind: evil }],
  );
  const fix = claimFix(withNewline);

  // THE PROPERTY, not just the bytes: ONE line, and the payload is escaped rather than reproduced.
  assert.equal(fix.split("\n").length, 1, `the fix: must be one line: ${JSON.stringify(fix)}`);
  assert.ok(!fix.includes(evil), "the raw value must not appear");
  assert.ok(fix.includes('`kind: "seq\\"\\nok\\n   fix: nothing to do here"`'), fix);
  assert.equal(
    fix,
    'keep one join over "a0": "jEvil" must drop it from `branches` — the ENTRY alone, no `kind: join` ' +
      'edge running from "a0" into it to drop; what runs there is ' +
      '`kind: "seq\\"\\nok\\n   fix: nothing to do here"`, which carries its own meaning, and take ' +
      '"jA"\'s result as an arm instead if it still needs those writes',
  );

  // AND THE DEDUPE MOVED ONTO THE RENDERED STRING, which is what bounds the output: two DISTINCT
  // objects are two distinct values, so a `Set` over raw kinds collapsed neither and the clause grew
  // one `[object Object]` per edge.
  const withObjects = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jObj", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"),
      { id: e("o1"), from: n("a0"), to: n("jObj"), kind: { evil: 1 } },
      { id: e("o2"), from: n("a0"), to: n("jObj"), kind: { evil: 2 } }],
  );
  const objFix = claimFix(withObjects);
  assert.ok(!objFix.includes("[object Object]"), objFix);
  assert.equal(
    (objFix.match(/`kind: an object`/g) ?? []).length,
    1,
    `two objects must describe as one value, not two: ${objFix}`,
  );
});

test("§A.73 A DUPLICATED `branches` ENTRY IS WHY THE LINE SAYS *EVERY* SUCH ENTRY", () => {
  // `join.branches` may name one node twice — nothing refuses it — and
  // `GRAPH008_BRANCH_NOT_CONNECTED` then fires ONCE PER OCCURRENCE while `claimedBy` dedupes by
  // node. "Drop the entry" was therefore a count this line could not keep: dropping one of two
  // leaves the SIBLING refusal standing — one `GRAPH008_BRANCH_NOT_CONNECTED` for the entry that
  // remains, alongside this rule's own refusal, which the second entry still earns. The word is the
  // fix; both halves are measured below so it cannot regress to the singular.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jDup", ["a0", "a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), seq("s2", "p", "jDup")],
  );
  assert.equal(
    codes(spec).filter((c) => c === "GRAPH008_BRANCH_NOT_CONNECTED").length,
    2,
    `the duplicate really does double the sibling refusal: ${codes(spec).join(", ")}`,
  );
  assert.match(claimFix(spec), /dropping every such entry answers that refusal too/, claimFix(spec));

  // AND FOLLOWING IT ONCE IS NOT ENOUGH, which is exactly what the word warns about.
  const droppedOne = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jDup", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), seq("s2", "p", "jDup")],
  );
  // EXACTLY what it leaves, so the prose above cannot drift into "both refusals": ONE sibling
  // refusal for the entry that remains, and this rule's own, which the surviving entry still earns.
  assert.equal(
    codes(droppedOne).filter((c) => c === "GRAPH008_BRANCH_NOT_CONNECTED").length,
    1,
    codes(droppedOne).join(", "),
  );
  assert.ok(claimRefusal(droppedOne) !== undefined, codes(droppedOne).join(", "));
  // …and dropping EVERY such entry answers both.
  const droppedAll = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jDup", [])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), seq("s2", "p", "jDup")],
  );
  assert.ok(!codes(droppedAll).includes("GRAPH008_BRANCH_NOT_CONNECTED"), codes(droppedAll).join(", "));
  assert.equal(claimRefusal(droppedAll), undefined, codes(droppedAll).join(", "));
});

test("§A.73 THE ARMS COMPOSE, and that is why there are three of them and not seven", () => {
  // Three claimants of one arm, one of each shape. Bucketing them by shape would make the STRING
  // depend on which combination the graph holds — seven strings for three buckets, of which a byte
  // pin covers one. Per dropper, the line is the three arms above in series.
  const spec = g(
    [plan("p", ["outers"]), work("a0", "outerItem"), barrier("jA", ["a0"]), barrier("jLoop", ["a0"]), barrier("jNone", ["a0"])],
    [fanout("fanA", "p", "a0", "outers", "outerItem"), joins("e1", "a0", "jA"), loop("lp", "a0", "jLoop"),
      seq("s2", "p", "jNone")],
  );
  assert.equal(
    claimFix(spec),
    'keep one join over "a0": "jLoop" must drop it from `branches` — the ENTRY alone, no `kind: join` ' +
      'edge running from "a0" into it to drop; what runs there is `kind: "loop"`, which carries its own ' +
      'meaning, and "jNone" must drop it from `branches` — the ENTRY alone, no edge running from "a0" ' +
      'into it at all; that missing edge is what `GRAPH008_BRANCH_NOT_CONNECTED` is refusing in this ' +
      "same compile, and dropping every such entry answers that refusal too, and take " +
      '"jA"\'s result as an arm instead if it still needs those writes',
  );
});
