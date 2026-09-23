/**
 * A whole-count quorum `k` above a STATIC, unfanned branch list is refused at compile (§A.77, Q11).
 *
 * `#joinArrivals` counts the barrier's width as the fan-out PLAN when a member was fanned out, and
 * otherwise as the member Tasks at the join's coordinate. With every member at the join's own fan-out
 * stack and running once per branch, that is at most the number of distinct members — so `k: 4` over
 * three arms can be met by no input. It compiled clean and was refused only at the barrier, after all
 * three arms had run and applied their writes (`join-quorum-k-is-a-floor.test.ts` drives that run).
 *
 * The shapes whose width is NOT known before the run are left alone, and pinned here as such.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { stubResolver } from "./fixtures.ts";

const ARMS = ["a", "b", "c"];

function spec(k: number, opts: { conditional?: boolean } = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "quorum-static", project: "test", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 3 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      flag: { type: "string", reduce: "replace" },
      seen: { type: "array", reduce: "append_ordered" },
      note: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items", "flag"],
    outputs: [],
    nodes: [
      { id: "start", type: "function", reads: ["items", "flag"], function: { ref: "function/start@stable" } },
      ...ARMS.map((id) => ({ id, type: "function", reads: ["items"], writes: ["seen"], function: { ref: `function/${id}@stable` } })),
      { id: "J", type: "join", reads: ["seen"], writes: ["seen"], join: { branches: ARMS, mode: "quorum", k, onBranchError: "skip" } },
      { id: "done", type: "function", reads: ["seen"], writes: ["note"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      ...ARMS.map((id) =>
        opts.conditional === true && id === "c"
          ? { id: `s${id}`, from: "start", to: id, kind: "conditional", when: 'flag == "yes"' }
          : { id: `s${id}`, from: "start", to: id, kind: "seq" },
      ),
      ...ARMS.map((id) => ({ id: `j${id}`, from: id, to: "J", kind: "join", branches: ARMS })),
      { id: "jd", from: "J", to: "done", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

function aboveWidth(s: GraphSpec): string[] {
  return compile({ spec: s, resolver: stubResolver(), tools: {}, tenantCapabilities: [] })
    .diagnostics.filter((d) => d.code === "GRAPH008_QUORUM_K" && d.message.includes("exceeds its"))
    .map((d) => d.message);
}

test("THE ROW'S REPRO: k: 4 over three static arms is refused, naming k, the width and why", () => {
  const r = compile({ spec: spec(4), resolver: stubResolver(), tools: {}, tenantCapabilities: [] });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.message, d.at?.nodeId]),
    [
      [
        "GRAPH008_QUORUM_K",
        'join "J" quorum k=4 exceeds its 3 branch(es), and every one is static and unfanned — no run can materialise more, so every run would reach this barrier, run all 3, and be refused there',
        "J",
      ],
    ],
  );
});

test("THE ORDINARY HALF: k at the width, a fraction, and k: 1 all compile clean", () => {
  for (const k of [3, 2, 1, 0.5]) {
    const r = compile({ spec: spec(k), resolver: stubResolver(), tools: {}, tenantCapabilities: [] });
    assert.deepEqual(r.diagnostics.map((d) => d.code), [], `k=${k}`);
  }
});

test("A `conditional` member narrows the width, never widens it: k above the whole list is refused anyway", () => {
  assert.equal(aboveWidth(spec(4, { conditional: true })).length, 1);
  // …while k AT the list's length stays the runtime's question — satisfiable on one input only.
  assert.deepEqual(aboveWidth(spec(3, { conditional: true })), []);
});

test("LEFT ALONE: a fanned-out member — its width is the plan, which is data", () => {
  const fanned = {
    ...spec(5),
    nodes: [
      { id: "start", type: "function", reads: ["items"], function: { ref: "function/start@stable" } },
      { id: "b0", type: "function", reads: ["item"], writes: ["seen"], function: { ref: "function/b0@stable" } },
      { id: "J", type: "join", reads: ["seen"], writes: ["seen"], join: { branches: ["b0"], mode: "quorum", k: 5, onBranchError: "skip" } },
    ],
    channels: { ...spec(5).channels, item: { type: "string", reduce: "replace" } },
    edges: [
      { id: "fo", from: "start", to: "b0", kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "in", from: "b0", to: "J", kind: "join", branches: ["b0"] },
    ],
  } as unknown as GraphSpec;
  assert.deepEqual(aboveWidth(fanned), []);
});

test("LEFT ALONE: a member that can run on more than one pass — each pass is another Task the barrier counts", () => {
  const looped = {
    ...spec(2),
    channels: { ...spec(2).channels, stop: { type: "boolean", reduce: "replace" } },
    nodes: [
      { id: "start", type: "function", reads: ["items"], function: { ref: "function/start@stable" } },
      { id: "m", type: "function", reads: ["items"], writes: ["seen"], function: { ref: "function/m@stable" } },
      { id: "fix", type: "function", reads: ["stop"], writes: ["stop"], function: { ref: "function/fix@stable" } },
      { id: "J", type: "join", reads: ["seen"], writes: ["seen"], join: { branches: ["m"], mode: "quorum", k: 2, onBranchError: "skip" } },
    ],
    edges: [
      { id: "go", from: "start", to: "m", kind: "seq" },
      { id: "again", from: "m", to: "fix", kind: "seq" },
      { id: "loop", from: "fix", to: "m", kind: "loop", until: "stop == true", maxIterations: 3 },
      { id: "in", from: "m", to: "J", kind: "join", branches: ["m"] },
    ],
  } as unknown as GraphSpec;
  assert.deepEqual(aboveWidth(looped), []);
});
