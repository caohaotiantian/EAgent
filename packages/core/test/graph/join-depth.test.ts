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
        join: { branches: [n("inner")], mode: "all", onBranchError: "skip", timeoutMs: 1000 },
      },
      {
        id: n("outerJoin"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        // `innerJoin` is NOT here. That is the defect under test.
        join: { branches: [n("outer")], mode: "all", onBranchError: "skip", timeoutMs: 1000 },
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
