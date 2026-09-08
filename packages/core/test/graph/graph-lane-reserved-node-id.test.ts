/**
 * A node may not be called something `Object.prototype` already carries.
 *
 * TODO.md §A0.19 and this file's own `PROTOTYPE_NAMES` docstring: at `294e713` a node id
 * `toString` compiled clean — `node id toString: ok=true diags=[]`. The rule that closes it
 * mirrors `3fd7ad5`'s channel rule exactly (same `PROTOTYPE_NAMES`/`RESERVED_LIST`, same
 * `checkStructure` loop shape), but the REACHABLE defect it closes is NOT the one the original
 * report and this rule's first draft named. `plans["toString"]` (the object `compile.ts` builds,
 * one own-property write per node) is read everywhere as `?.field ?? default`, which degrades a
 * prototype function to the same default an absent plan gives — `plans` alone was never
 * exploitable. The defect that IS reachable is `ctx.baselinePostures?.[n.id]`, read a few hundred
 * lines below in `validate.ts` itself and fed to `isLoosening`, which fails closed on a baseline
 * it cannot read as a `Posture`. A node named `toString` supplies
 * `Object.prototype.toString` there, `isLoosening` calls it a loosening, and `compile.ts`
 * escalates the whole result to a POLICY refusal (`E_OVERSIGHT_LOOSENED`) instead of a validation
 * one — for a graph that never reached policy. See the comment above `PROTOTYPE_NAMES` in
 * `validate.ts` for the full mechanism.
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

const run = (nodeId: string, extra?: { baselinePostures?: Record<string, string> }) =>
  compile({
    spec: spec(nodeId),
    resolver: stubResolver({}),
    tools: {},
    tenantCapabilities: ["*"],
    ...extra,
  } as Parameters<typeof compile>[0]);

test("A NODE ID `toString` IS REFUSED AT COMPILE, and the diagnostic names it — and it is the ONLY diagnostic", () => {
  const r = run("toString");
  assert.equal(r.ok, false);
  // Exactly one diagnostic, not merely "includes the reserved one" — pins that the refusal is
  // FATAL (checkStructure's `fatal = true`) and so `validateGraph` never reaches a later rule
  // for this node. Without `fatal = true` this would still pass a weaker "includes" assertion
  // while a second, fabricated diagnostic rode along (see the next test for the concrete one).
  assert.equal(r.diagnostics.length, 1);
  const reserved = r.diagnostics[0]!;
  assert.equal(reserved.code, "GRAPH003_RESERVED_NODE_ID");
  assert.equal(reserved.severity, "error");
  assert.equal(reserved.at?.nodeId, "toString");
  assert.match(reserved.message, /node id "toString"/);
  assert.match(reserved.fix ?? "", /`toString`/, "the fix lists the reserved set");
});

test("…AND SUPPRESSES A FABRICATED GRAPH014 — the reachable defect, pinned directly", () => {
  // `isLoosening` fails closed on anything it cannot read as a `Posture` (by its own docstring
  // in vocab.ts), so `ctx.baselinePostures?.["toString"]` answering `Object.prototype.toString`
  // — a function, not a `Posture` — gets called a loosening. Reproduced directly against this
  // tree's `compile.ts` at the base commit before this rule existed
  // (c54b0c272c53ab3d9d2c8260dd1cd65666e7e0c0): `ok=false codes=['GRAPH014_OVERSIGHT_LOOSENED']`
  // for the exact spec below — a POLICY-class error (`compile.ts` raises `err.policy` /
  // `E_OVERSIGHT_LOOSENED` whenever any `GRAPH014_OVERSIGHT_LOOSENED` diagnostic is present) for
  // a graph that loosened nothing. Both the promotion path (`cli.ts`) and the model-proposed
  // mutation path (`mutate.ts`) supply `baselinePostures`, so this is reachable from both doors.
  const r = run("toString", { baselinePostures: { unrelated_node: "in" } });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.diagnostics.map((d) => d.code),
    ["GRAPH003_RESERVED_NODE_ID"],
    "a baselinePostures block must not resurrect GRAPH014_OVERSIGHT_LOOSENED for a node the compiler already refused",
  );
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

test("A CHILD SPEC'S NODE ID IS COVERED TOO — `rule016Subgraphs` recurses `validateGraph`", () => {
  const child = spec("toString");
  const parent: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: DECLARED,
    inputs: ["inp"],
    outputs: ["out"],
    nodes: [
      {
        id: "work" as NodeId,
        type: "subgraph",
        reads: ["inp"],
        writes: ["out"],
        subgraph: { ref: "subgraph/child@stable", inputs: { inp: "inp" }, outputs: { out: "out" } },
        unhandled: true,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;

  const r = compile({
    spec: parent,
    resolver: stubResolver({ subgraphs: { "subgraph/child@stable": child } }),
    tools: {},
    tenantCapabilities: ["*"],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.diagnostics.some((d) => d.code === "GRAPH003_RESERVED_NODE_ID"),
    `expected a reserved-node-id diagnostic bubbled from the child, got ${r.diagnostics.map((d) => d.code).join(", ")}`,
  );
});
