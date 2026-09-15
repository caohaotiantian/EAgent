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

import { indexGraph, validateGraph } from "../../src/graph/validate.ts";
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
 * §A.64 — A DEPTH NUMBER DOES NOT SAY WHICH FAN-OUT.
 *
 * `GRAPH008_JOIN_DEPTH` compared `fanoutDepth` NUMBERS and never `fanoutEdgeStack`. Two fan-outs
 * off one node are two instance spaces at the same depth, so an arm one level up in the WRONG fan
 * satisfied `armDepth === joinDepth + 1`, and a fan-out could quietly acquire a second barrier.
 *
 * WHAT THAT COSTS, measured on a real `Engine` before the refusal existed — one fanned-out node
 * over an `append_ordered` channel, width 3, with a second root join declaring the same arm:
 *
 *     one barrier    found = ["f0","f1","f2"]
 *     two barriers   found = ["f0","f1","f2","f0","f1","f2"]     status = succeeded
 *
 * A node inside a fan-out HOLDS its writes for one enclosing join; every extra barrier folds them
 * again, and a non-idempotent reducer doubles in silence. So the arm check now reads the EDGE
 * stack, and a second pass refuses a fan-out with more than one barrier.
 *
 * THE SHAPE THIS DOES NOT REFUSE is the two-sided control below: one barrier over several sibling
 * fan-outs. `#maybeFireJoin` sums `expected` over every fan-out plan at the parent coordinate
 * whose target is a member, which is written for exactly that graph.
 */

const a64Base = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "a64", project: "probe", version: 1 },
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
  id: e(id),
  from: n(from),
  to: n(to),
  kind: "fanout",
  over,
  as,
  maxWidth: 2,
});

const joins = (id: string, from: string, to: string): unknown => ({ id: e(id), from: n(from), to: n(to), kind: "join" });

/**
 * Two sibling fan-outs off `plan`. Fan A holds an inner barrier `aJoin`; fan A's OWN barrier is
 * `aOuter`. `crossed` hands `aJoin` to fan B's barrier instead — the entry and the `kind: join`
 * edge, exactly the shape `GRAPH008_HELD_JOIN_UNCOLLECTED`'s `fix:` dictates, made into the wrong
 * fan. `fanA` then has two barriers.
 */
function siblingFans(crossed: boolean): GraphSpec {
  return {
    ...a64Base,
    nodes: [
      { id: n("plan"), type: "function", reads: ["outers"], function: { ref: "function/plan@stable" } },
      work("a0", "outerItem"),
      work("a1", "innerItem"),
      barrier("aJoin", ["a1"]),
      barrier("aOuter", crossed ? ["a0"] : ["a0", "aJoin"]),
      work("b0", "outerItem"),
      barrier("bJoin", crossed ? ["b0", "aJoin"] : ["b0"]),
    ],
    edges: [
      fanout("fanA", "plan", "a0", "outers", "outerItem"),
      fanout("fanB", "plan", "b0", "outers", "outerItem"),
      fanout("fanInner", "a0", "a1", "inners", "innerItem"),
      joins("jInner", "a1", "aJoin"),
      joins("jOuter", "a0", "aOuter"),
      joins("jB", "b0", "bJoin"),
      joins("jHeld", "aJoin", crossed ? "bJoin" : "aOuter"),
    ],
  } as unknown as GraphSpec;
}

test("§A.64 A HELD JOIN HANDED TO A SIBLING FAN'S BARRIER IS REFUSED", () => {
  const spec = siblingFans(true);

  // The precondition, stated as the compiler sees it: the numbers agree and the FAN-OUTS do not.
  // `aJoin` is one level deeper than `bJoin`, which is all the old arm check asked.
  const idx = indexGraph(spec);
  assert.equal(idx.fanoutDepth.get(n("aJoin")), (idx.fanoutDepth.get(n("bJoin")) ?? -1) + 1, "precondition: one level up");
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("aJoin")) ?? [])], [e("fanA")], "precondition: and it is in fan A");
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("bJoin")) ?? [])], [], "precondition: while the barrier is in neither");

  const got = codes(spec);
  assert.deepEqual(got, ["GRAPH008_JOIN_DEPTH"], got.join(", ") || "(no diagnostics)");

  const [d] = validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  assert.equal(d!.at?.edgeId, e("fanA"), "the refusal is about the fan-out that ended up with two barriers");
  // The NAME SET, not the prose: both barriers have to be named or the author cannot act.
  assert.deepEqual(
    [...d!.message.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((x) => x === "aOuter" || x === "bJoin").sort(),
    ["aOuter", "bJoin"],
    d!.message,
  );
});

test("…and the SAME shape with the held join in its OWN fan compiles", () => {
  // The two-sided control. One entry and one edge move — from `bJoin` to `aOuter` — and nothing
  // else. If this failed, the rule would be refusing the graph the `fix:` line asks for.
  assert.deepEqual(codes(siblingFans(false)), [], "a legitimate one-level-up arm in the same fan must compile");
});

test("…and ONE barrier over SEVERAL sibling fan-outs still compiles", () => {
  // The other side of the same control, and the reason the check is per FAN-OUT EDGE rather than
  // per join: a join may serve two fan-outs at once, and each of them still has exactly one
  // barrier. `#maybeFireJoin` sums `expected` over one plan per fan-out edge for this graph.
  const spec = {
    ...a64Base,
    nodes: [
      { id: n("plan"), type: "function", reads: ["outers"], function: { ref: "function/plan@stable" } },
      work("a0", "outerItem"),
      work("b0", "outerItem"),
      barrier("both", ["a0", "b0"]),
    ],
    edges: [
      fanout("fanA", "plan", "a0", "outers", "outerItem"),
      fanout("fanB", "plan", "b0", "outers", "outerItem"),
      joins("jA", "a0", "both"),
      joins("jB", "b0", "both"),
    ],
  } as unknown as GraphSpec;
  assert.deepEqual(codes(spec), [], "one barrier serving two fan-outs is not two barriers over one");
});

test("…and TWO barriers over ONE fan-out are refused, which is the fold that doubles", () => {
  // The minimal form of the same violation, and the one measured on the Engine in this file's
  // header: one arm, two root joins, each folding the same held writes.
  const spec = {
    ...a64Base,
    nodes: [
      { id: n("plan"), type: "function", reads: ["outers"], function: { ref: "function/plan@stable" } },
      work("a0", "outerItem"),
      barrier("jA", ["a0"]),
      barrier("jB", ["a0"]),
    ],
    edges: [
      fanout("fanA", "plan", "a0", "outers", "outerItem"),
      joins("j1", "a0", "jA"),
      joins("j2", "a0", "jB"),
    ],
  } as unknown as GraphSpec;
  assert.deepEqual(codes(spec), ["GRAPH008_JOIN_DEPTH"]);
});

test("…and an arm two levels up is still refused for the OLD reason", () => {
  // The control that the depth arm did not become dead code. `a1` sits two fan-outs below the
  // barrier and is DECLARED WITHOUT AN EDGE, which is the only way to reach that arm: any edge
  // from `a1` to `far` would put `far` itself at two depths, and the join-level check answers
  // first. So this graph is refused twice, and one of the two must still be "never further".
  const spec = {
    ...a64Base,
    nodes: [
      { id: n("plan"), type: "function", reads: ["outers"], function: { ref: "function/plan@stable" } },
      work("a0", "outerItem"),
      work("a1", "innerItem"),
      barrier("far", ["a0", "a1"]),
    ],
    edges: [
      fanout("fanA", "plan", "a0", "outers", "outerItem"),
      fanout("fanInner", "a0", "a1", "inners", "innerItem"),
      joins("jA", "a0", "far"),
    ],
  } as unknown as GraphSpec;
  const found = validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }).filter(
    (x) => x.code === "GRAPH008_JOIN_DEPTH",
  );
  assert.ok(found.length > 0, "an arm two levels deeper must still be refused");
  assert.ok(
    found.some((x) => /never further/.test(x.message)),
    `the depth arm must still be the one that answers: ${found.map((x) => x.message).join(" | ")}`,
  );
});

test("§A.64 AND AN AMBIGUOUS FAN-OUT WITH ONE OWNER IS TOLERATED, because people author it", () => {
  // The direction this rule deliberately does NOT take, pinned so the next reader does not
  // "fail closed" here and break a working graph. `x` is reachable through two fan-outs of the
  // SAME width, so its width stack agrees and its EDGE stack does not — and a refusal was tried
  // here and broke `test/run/empty-fanout-oversight.test.ts`, whose router steers between two
  // list-builders that each fan out into ONE shared body node. Exactly one of the two edges ever
  // fires; the ambiguity is the compiler's, not the graph's. ONE OWNER is the whole licence that
  // fixture grants, and the test below is the other side of it.
  const spec = {
    ...a64Base,
    nodes: [
      { id: n("plan"), type: "function", reads: ["outers"], function: { ref: "function/plan@stable" } },
      work("x", "outerItem"),
      barrier("j", ["x"]),
    ],
    edges: [
      fanout("fanA", "plan", "x", "outers", "outerItem"),
      fanout("fanB", "plan", "x", "outers", "outerItem"),
      joins("jx", "x", "j"),
    ],
  } as unknown as GraphSpec;

  const idx = indexGraph(spec);
  assert.equal(idx.fanoutDepth.get(n("j")), 0, "precondition: the NUMBER is decided");
  assert.equal(idx.fanoutEdgeStack.get(n("j")), undefined, "precondition: and the EDGES are not");

  assert.deepEqual(codes(spec), [], "an identity the compiler does not have is not an identity it refuses");
});

test("§A.64 AND AN ARM IN A DIFFERENT OUTER FAN IS REFUSED where the identity IS known", () => {
  // The arm-side half, on the one shape that reaches it: `b1` is declared as an arm of `j` and
  // wired by a LOOP edge, which the stack traversal excludes — so `j`'s own stack stays `["F1"]`
  // while its arm's is `["F2","fanB"]`. Depths agree (1 and 2) and the fan-outs do not.
  const spec = {
    ...a64Base,
    nodes: [
      { id: n("plan"), type: "function", reads: ["outers"], function: { ref: "function/plan@stable" } },
      { id: n("x"), type: "function", reads: ["outerItem"], function: { ref: "function/x@stable" } },
      { id: n("y"), type: "function", reads: ["outerItem"], function: { ref: "function/y@stable" } },
      work("a0", "innerItem"),
      work("b1", "innerItem"),
      barrier("j", ["a0", "b1"]),
    ],
    edges: [
      fanout("F1", "plan", "x", "outers", "outerItem"),
      fanout("F2", "plan", "y", "outers", "outerItem"),
      fanout("fanA", "x", "a0", "inners", "innerItem"),
      fanout("fanB", "y", "b1", "inners", "innerItem"),
      joins("jA", "a0", "j"),
      { id: e("lb"), from: n("b1"), to: n("j"), kind: "loop", maxIterations: 2 },
    ],
  } as unknown as GraphSpec;

  const idx = indexGraph(spec);
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("j")) ?? [])], [e("F1")], "precondition: the join is in F1");
  assert.deepEqual([...(idx.fanoutEdgeStack.get(n("b1")) ?? [])], [e("F2"), e("fanB")], "precondition: the arm is in F2");
  assert.equal(idx.fanoutDepth.get(n("b1")), (idx.fanoutDepth.get(n("j")) ?? -1) + 1, "precondition: and the DEPTHS agree");

  const found = validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }).filter(
    (x) => x.code === "GRAPH008_JOIN_DEPTH",
  );
  assert.equal(found.length, 1, found.map((x) => x.message).join(" | ") || "(none)");
  assert.match(found[0]!.message, /inside fan-out "F2" where the join is inside "F1"/, found[0]!.message);
});

/**
 * …AND AMBIGUITY WITH TWO OWNERS IS REFUSED — a reviewer's finding on the first cut of §A.64.
 *
 * Ambiguity PROPAGATES. A body reachable through two fan-out edges of the same width has
 * `fanoutEdgeStack === undefined`, and so does every join below it — so the per-fan-out-EDGE pass
 * skipped the graph entirely, and "one fan-out, one barrier" was not true of the ambiguous case at
 * all. Measured on a real `Engine` before the refusal existed, two same-width fan-out edges into
 * one body over an `append_ordered` channel:
 *
 *     one barrier    parts n=6     ["f0","f1","f2"] twice, one per firing fan-out
 *     two barriers   parts n=12    the same six again           status = succeeded
 *
 * What cannot be named is WHICH fan-out opened the arm. What can still be counted is how many
 * joins claim it, and two claimants double the fold whichever fan-out it turns out to be. So the
 * ambiguity is the reason to refuse here, not the reason to allow.
 */

/** Two same-width fan-out edges into one body, and `second` gives it a second root barrier. */
function ambiguousBody(second: boolean): GraphSpec {
  return {
    ...a64Base,
    nodes: [
      { id: n("plan"), type: "function", reads: ["outers"], function: { ref: "function/plan@stable" } },
      { id: n("plan2"), type: "function", reads: ["outers"], function: { ref: "function/plan2@stable" } },
      work("body", "outerItem"),
      barrier("jA", ["body"]),
      ...(second ? [barrier("jB", ["body"])] : []),
    ],
    edges: [
      { id: e("seq2"), from: n("plan"), to: n("plan2"), kind: "seq" },
      fanout("f1", "plan", "body", "outers", "outerItem"),
      fanout("f2", "plan2", "body", "outers", "outerItem"),
      joins("j1", "body", "jA"),
      ...(second ? [joins("j2", "body", "jB")] : []),
    ],
  } as unknown as GraphSpec;
}

test("§A.64 AND AN AMBIGUOUS FAN-OUT WITH TWO OWNERS IS REFUSED — ambiguity propagates", () => {
  const spec = ambiguousBody(true);

  // The precondition, and the reason the per-fan-out-EDGE pass could not see this: NEITHER the
  // body NOR the joins below it have an edge stack, so there is no edge to key the count on.
  const idx = indexGraph(spec);
  assert.equal(idx.fanoutDepth.get(n("body")), 1, "precondition: the body's depth IS decided");
  assert.equal(idx.fanoutEdgeStack.get(n("body")), undefined, "precondition: and its fan-out is not");
  assert.equal(idx.fanoutEdgeStack.get(n("jA")), undefined, "precondition: ambiguity reaches the joins too");

  const found = validateGraph({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] }).filter(
    (x) => x.code === "GRAPH008_JOIN_DEPTH",
  );
  assert.equal(found.length, 1, found.map((x) => x.message).join(" | ") || "(none)");
  assert.equal(found[0]!.at?.nodeId, n("body"), "the refusal names the arm, because no fan-out edge can be named");
  // The NAME SET, not the prose: both claimants have to be named or the author cannot act.
  assert.deepEqual(
    [...found[0]!.message.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((x) => x === "jA" || x === "jB"),
    ["jA", "jB"],
    found[0]!.message,
  );
});

test("…and the SAME ambiguous body with ONE owner still compiles", () => {
  // The two-sided control, and the shape `test/run/empty-fanout-oversight.test.ts` actually
  // declares: one join over the ambiguous body. One edge and one `branches` entry of difference.
  assert.deepEqual(codes(ambiguousBody(false)), [], "an ambiguous fan-out with one barrier is a working graph");
});

/**
 * …AND THE SAME THING THROUGH A ROUTER, which is the shape the tolerance was granted for.
 *
 * `test/run/empty-fanout-oversight.test.ts` steers between two list-builders that each fan out
 * into ONE shared body node, so exactly one of the two edges ever fires. That fixture declares
 * exactly ONE join over the ambiguous body, and that is the whole licence it grants: the same
 * graph with a second join is the double fold again, and a router cannot tell the compiler which
 * edge won.
 */
function steeredBody(second: boolean): GraphSpec {
  return {
    ...a64Base,
    channels: { ...a64Base.channels, request: { type: "string", reduce: "replace" } },
    inputs: ["request", "outers", "inners"],
    nodes: [
      {
        id: n("route"),
        type: "router",
        reads: ["request"],
        router: { mode: "expression", cases: [{ when: `contains(request, "NONE")`, take: ["toEmpty"] }], fallbackEdge: "toFull" },
      },
      { id: n("planEmpty"), type: "function", reads: ["request"], writes: ["outers"], function: { ref: "function/none@stable" } },
      { id: n("planFull"), type: "function", reads: ["request"], writes: ["outers"], function: { ref: "function/two@stable" } },
      work("hold", "outerItem"),
      barrier("j", ["hold"]),
      ...(second ? [barrier("j2", ["hold"])] : []),
    ],
    edges: [
      { id: e("toEmpty"), from: n("route"), to: n("planEmpty"), kind: "seq" },
      { id: e("toFull"), from: n("route"), to: n("planFull"), kind: "seq" },
      fanout("fanE", "planEmpty", "hold", "outers", "outerItem"),
      fanout("fanF", "planFull", "hold", "outers", "outerItem"),
      joins("jj", "hold", "j"),
      ...(second ? [joins("jj2", "hold", "j2")] : []),
    ],
  } as unknown as GraphSpec;
}

test("…and the ROUTER-STEERED body the tolerance was granted for keeps compiling with ONE join", () => {
  assert.deepEqual(codes(steeredBody(false)), [], "this is `empty-fanout-oversight`'s own shape and must not move");
});

test("…and the SAME steered body with TWO joins is refused", () => {
  const found = validateGraph({ spec: steeredBody(true), resolver: resolver(), tools: {}, tenantCapabilities: [] }).filter(
    (x) => x.code === "GRAPH008_JOIN_DEPTH",
  );
  assert.equal(found.length, 1, found.map((x) => x.message).join(" | ") || "(none)");
  assert.equal(found[0]!.at?.nodeId, n("hold"));
  assert.deepEqual(
    [...found[0]!.message.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((x) => x === "j" || x === "j2"),
    ["j", "j2"],
    found[0]!.message,
  );
});
