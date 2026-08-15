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
