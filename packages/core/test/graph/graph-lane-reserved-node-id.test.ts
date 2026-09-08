/**
 * A node may not be called something `Object.prototype` already carries.
 *
 * `3fd7ad5` closed this for CHANNELS: `compile.ts` builds `plans` the same way it builds
 * `ChannelState` — a plain object literal, one own-property write per spec-declared id — and
 * `run/engine.ts` reads `ctx.graph.plans[nodeId]?.posture` (and `.outboundEdges`, `.timeoutMs`,
 * `.retry`) with raw bracket access, no `hasOwnProperty` guard anywhere. TODO.md §A0.19: at
 * `294e713` a node id `toString` compiled clean — `node id toString: ok=true diags=[]` — and
 * `plans["toString"]` then resolved to `Object.prototype.toString`, a function nobody declared.
 *
 * The set is read off `Object.prototype` rather than written down, so this pins the behaviour
 * on a sample of it and the completeness on the source — same shape as
 * `graph-lane-reserved-channel-names.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { stubResolver } from "./fixtures.ts";

const DECLARED = {
  inp: { type: "string", reduce: "replace" },
  out: { type: "object", reduce: "replace" },
};

const spec = (nodeId: string): GraphSpec =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "g", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: DECLARED,
    inputs: ["inp"],
    outputs: ["out"],
    nodes: [
      {
        id: nodeId as NodeId,
        type: "function",
        reads: ["inp"],
        writes: ["out"],
        function: { ref: "function/noop@stable" },
        unhandled: true,
      },
    ],
    edges: [],
  }) as unknown as GraphSpec;

const run = (nodeId: string) => compile({ spec: spec(nodeId), resolver: stubResolver({}), tools: {}, tenantCapabilities: ["*"] });

test("A NODE ID `toString` IS REFUSED AT COMPILE, and the diagnostic names it", () => {
  const r = run("toString");
  assert.equal(r.ok, false);
  const reserved = r.diagnostics.filter((d) => d.code === "GRAPH003_RESERVED_NODE_ID");
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0]?.severity, "error");
  assert.equal(reserved[0]?.at?.nodeId, "toString");
  assert.match(reserved[0]!.message, /node id "toString"/);
  assert.match(reserved[0]!.fix ?? "", /`toString`/, "the fix lists the reserved set");
});

test("…and so is every other name `Object.prototype` carries", () => {
  // Same split as the channel test: five of the twelve begin with `_` and are already refused
  // by the id charset rule (`SAFE_ID` requires an alphanumeric first character), so this checks
  // each name against the rule that is supposed to catch it rather than asserting only
  // "refused", which would pass on a tree where the new rule does nothing.
  const byCode = new Map<string, string[]>();
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const r = run(name);
    assert.equal(r.ok, false, `node id "${name}" compiled clean`);
    const codes = r.diagnostics.filter((d) => d.at?.nodeId === name).map((d) => d.code);
    const expected = /^[A-Za-z0-9]/.test(name) ? "GRAPH003_RESERVED_NODE_ID" : "GRAPH003_BAD_ID";
    assert.ok(codes.includes(expected), `node id "${name}" reported ${codes.join(", ")}, wanted ${expected}`);
    byCode.set(expected, [...(byCode.get(expected) ?? []), name]);
  }
  assert.deepEqual(byCode.get("GRAPH003_RESERVED_NODE_ID")?.sort(), [
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
  ]);
  assert.deepEqual(byCode.get("GRAPH003_BAD_ID")?.sort(), [
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
  ]);
});

test("THE ORDINARY HALF: a node named `to_string` or `plan` still compiles with the same diagnostics as before", () => {
  for (const ordinary of ["to_string", "plan"]) {
    const r = run(ordinary);
    assert.deepEqual(
      r.diagnostics.filter((d) => d.severity === "error"),
      [],
      `node id "${ordinary}" should compile clean`,
    );
    assert.equal(r.ok, true);
  }

  // And a name that merely CONTAINS a reserved one is not a collision — membership, not a
  // substring match.
  const near = run("toStringify");
  assert.deepEqual(
    near.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
  assert.equal(near.ok, true);
});
