/**
 * A channel may not be called something `Object.prototype` already carries.
 *
 * `state/channels.ts` closed the RUNTIME half of this: every "is this a declared channel?"
 * site there asks `hasOwnProperty` rather than reading raw, so a channel named `toString` no
 * longer hands `reduceChannel` a function. What was left is that such a graph still COMPILED
 * clean — the compile stage exists so a run does not have to discover this — and at 294e713 a
 * spec declaring `toString`, `constructor`, `hasOwnProperty` and `valueOf` came back
 * `ok: true` with an empty diagnostic list.
 *
 * The set is read off `Object.prototype` rather than written down, so this pins the behaviour
 * on a sample of it and the completeness on the source.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { stubResolver } from "./fixtures.ts";

const spec = (channels: Record<string, unknown>): GraphSpec =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "g", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels,
    inputs: ["inp"],
    outputs: ["out"],
    nodes: [
      {
        id: "a" as NodeId,
        type: "function",
        reads: ["inp"],
        writes: ["out"],
        function: { ref: "function/noop@stable" },
        unhandled: true,
      },
    ],
    edges: [],
  }) as unknown as GraphSpec;

const DECLARED = {
  inp: { type: "string", reduce: "replace" },
  out: { type: "object", reduce: "replace" },
};

const run = (channels: Record<string, unknown>) =>
  compile({ spec: spec(channels), resolver: stubResolver({}), tools: {}, tenantCapabilities: ["*"] });

test("A CHANNEL NAMED `toString` IS REFUSED AT COMPILE, and the diagnostic names it", () => {
  const r = run({ ...DECLARED, toString: { type: "object", reduce: "replace" } });
  assert.equal(r.ok, false);
  const reserved = r.diagnostics.filter((d) => d.code === "GRAPH003_RESERVED_CHANNEL");
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0]?.severity, "error");
  assert.equal(reserved[0]?.at?.channel, "toString");
  assert.match(reserved[0]!.message, /channel "toString"/);
  assert.match(reserved[0]!.fix ?? "", /`toString`/, "the fix lists the reserved set");
});

test("…and so is every other name `Object.prototype` carries", () => {
  // The set is `Object.getOwnPropertyNames(Object.prototype)` and nothing else, so the test
  // asks the same source rather than repeating a list that could drift from it.
  //
  // WHICH RULE ANSWERS IS PART OF THE CLAIM. Five of the twelve begin with `_`, and the id
  // charset rule already refused those — `SAFE_ID` requires an alphanumeric first character.
  // Asserting only "refused" would pass on a tree where the new rule does nothing, so each
  // name is checked against the rule that is supposed to catch it, and the split is counted.
  const byCode = new Map<string, string[]>();
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const r = run({ ...DECLARED, [name]: { type: "object", reduce: "replace" } });
    assert.equal(r.ok, false, `channel "${name}" compiled clean`);
    const codes = r.diagnostics.filter((d) => d.at?.channel === name).map((d) => d.code);
    const expected = /^[A-Za-z0-9]/.test(name) ? "GRAPH003_RESERVED_CHANNEL" : "GRAPH003_BAD_ID";
    assert.ok(codes.includes(expected), `channel "${name}" reported ${codes.join(", ")}, wanted ${expected}`);
    byCode.set(expected, [...(byCode.get(expected) ?? []), name]);
  }
  assert.deepEqual(byCode.get("GRAPH003_RESERVED_CHANNEL")?.sort(), [
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

test("THE ORDINARY HALF: a graph whose channels are ordinary names still compiles clean", () => {
  const r = run({ ...DECLARED, notes: { type: "array", reduce: "append_ordered" } });
  assert.deepEqual(
    r.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
  assert.equal(r.ok, true);

  // And a name that merely CONTAINS a reserved one is not a collision — the check is
  // membership, not a substring match, and refusing `toStringify` would be a false refusal in
  // the direction this rule must not move.
  const near = run({ ...DECLARED, toStringify: { type: "object", reduce: "replace" }, valueOfRecord: { type: "object", reduce: "replace" } });
  assert.deepEqual(
    near.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
  assert.equal(near.ok, true);
});
