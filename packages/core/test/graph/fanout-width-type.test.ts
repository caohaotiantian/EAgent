/**
 * A FAN-OUT WIDTH THAT IS NOT A POSITIVE INTEGER RUNS ZERO BRANCHES AND SAYS NOTHING.
 *
 * `rule007Fanout` tested for PRESENCE — `if (e.maxWidth === undefined)` — and then compared the
 * value with a bare `>`. JSON carries whatever the author typed, and `graph/spec.ts`'s
 * `EDGE_FIELDS` is a NAME allowlist, so nothing between the file and the rule asked what type it
 * was. Coercion did the rest:
 *
 *     "24"        `"24" > 25` is false            -> compiles, GRAPH010 reads 24
 *     "banana"    `NaN > 25` is false             -> compiles, GRAPH010 reads NaN and switches OFF
 *     0           `0 > 25` is false               -> compiles, and the run takes zero branches
 *     2.5         `2.5 > 25` is false             -> compiles, width 2.5, `slice(0, 2.5)` takes 2
 *
 * The second column is the serious one. `computeFanoutStacks` does `[...parent, e.maxWidth ?? 1]`
 * and `parentWidth * (e.maxWidth ?? 1)`, so a NaN width makes every downstream `parallelWidth`
 * NaN, and GRAPH010's concurrent-writer refusal — which reads exactly that number — stops
 * firing. A graph that would be refused for racing writers compiles clean instead. Measured on
 * the shipped example before this rule existed (`examples/graphs/triage-failures.json`, three
 * copies differing only in that one field): `24` -> ok, `"24"` -> ok, `"banana"` -> ok.
 *
 * `maxIterations` on a `loop` edge is the same shape one rule along — `e.maxIterations < 1` is
 * false for `"banana"` too — so it is checked here with it.
 *
 * WHAT THIS DOES NOT CLOSE: `Executor.attach()` is public and `RunGraph` is exported, so a graph
 * can reach the executor without passing this build's compiler — the precedent `#assertBound`
 * states for `EdgeKind`. The compile refusal below closes the CLI door and every caller that
 * compiles; it does not close that one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { EdgeSpec, GraphSpec } from "../../src/graph/spec.ts";
import { validateGraph, type Diagnostic } from "../../src/graph/validate.ts";
import type { EdgeId } from "../../src/ids.ts";
import { TENANT_CAPABILITIES, TOOLS, clone, incidentTriage, stubResolver } from "./fixtures.ts";

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

/** `incidentTriage()` carries fan-out `e1` (maxWidth 25) and loop `e9` (maxIterations 3). */
function withEdge(id: string, patch: Record<string, unknown>): GraphSpec {
  const s = clone(incidentTriage());
  const i = s.edges.findIndex((x) => x.id === (id as EdgeId));
  assert.notEqual(i, -1, `fixture lost edge ${id}`);
  s.edges[i] = { ...s.edges[i]!, ...patch } as unknown as EdgeSpec;
  return s as GraphSpec;
}

test("the fixture this file mutates compiles clean, so every refusal below is the mutation", () => {
  assert.deepEqual(errorsOf(incidentTriage()).map((d) => d.code), []);
});

// ── maxWidth ─────────────────────────────────────────────────────────────────

test("A FAN-OUT maxWidth THAT IS NOT A POSITIVE INTEGER IS REFUSED", () => {
  // Each of these compiled clean before the rule. The two strings are the row's own probes.
  for (const bad of ["24", "banana", 0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, null, true, []]) {
    const d = errorsOf(withEdge("e1", { maxWidth: bad }));
    const hit = d.filter((x) => x.code === "GRAPH007_BAD_MAX_WIDTH");
    assert.equal(hit.length, 1, `maxWidth ${JSON.stringify(bad)} was not refused; got ${d.map((x) => x.code).join(", ") || "no errors"}`);
    assert.match(hit[0]!.message, /positive integer/, "the message must say what a width has to be");
    assert.ok((hit[0]!.fix ?? "").length > 0, "a refusal an author cannot act on is half a refusal");
    assert.equal(hit[0]!.at?.edgeId, "e1" as EdgeId);
  }
});

test("...and a valid width still compiles, including the ceiling itself", () => {
  for (const good of [1, 4, 25]) {
    assert.deepEqual(errorsOf(withEdge("e1", { maxWidth: good })).map((d) => d.code), [], `maxWidth ${good}`);
  }
});

test("the two OTHER maxWidth refusals still fire, and are not shadowed by the type check", () => {
  // Absent is still GRAPH007_NO_MAX_WIDTH — "there is none" and "that one is unreadable" are
  // different facts and an author fixes them differently.
  const absent = clone(incidentTriage());
  const i = absent.edges.findIndex((x) => x.id === ("e1" as EdgeId));
  delete (absent.edges[i] as unknown as Record<string, unknown>)["maxWidth"];
  assert.ok(errorsOf(absent as GraphSpec).some((d) => d.code === "GRAPH007_NO_MAX_WIDTH"));

  // Over the ceiling is still GRAPH007_MAX_WIDTH_EXCEEDED — and now the comparison runs on a
  // number, so `"99"` reaches it as a TYPE error rather than passing `"99" > 25` by coercion.
  assert.ok(errorsOf(withEdge("e1", { maxWidth: 99 })).some((d) => d.code === "GRAPH007_MAX_WIDTH_EXCEEDED"));
  const coerced = errorsOf(withEdge("e1", { maxWidth: "99" })).map((d) => d.code);
  assert.ok(coerced.includes("GRAPH007_BAD_MAX_WIDTH"), coerced.join(", "));
});

test("A NaN WIDTH NO LONGER SWITCHES GRAPH010 OFF — the half that made this a defect", () => {
  // `parallelWidth` is Π of the fan-out widths, and GRAPH010 reads it. With a NaN in the
  // product every comparison against it is false, so the concurrent-writer refusal went quiet
  // on a graph that races. The compile refusal has to come FIRST, i.e. the graph must not
  // reach a state where GRAPH010's silence is the only answer.
  const racy = clone(incidentTriage());
  // `findings` is `append_ordered` (multi-writer safe); make it `replace` so a real fan-out
  // over `investigate` is a genuine concurrent write.
  (racy.channels as Record<string, unknown>)["findings"] = { type: "array", reduce: "replace" };
  const numeric = errorsOf(racy as GraphSpec).map((d) => d.code);
  assert.ok(numeric.includes("GRAPH010_CONCURRENT_WRITE"), `expected the racy graph to be refused; got ${numeric.join(", ")}`);

  const nan = clone(racy);
  const i = nan.edges.findIndex((x) => x.id === ("e1" as EdgeId));
  nan.edges[i] = { ...nan.edges[i]!, maxWidth: "banana" } as unknown as EdgeSpec;
  const withNan = errorsOf(nan as GraphSpec).map((d) => d.code);
  // THE DEFECT: this list used to be empty — GRAPH010 gone, and nothing in its place.
  assert.ok(withNan.includes("GRAPH007_BAD_MAX_WIDTH"), `expected a type refusal; got ${withNan.join(", ") || "no errors"}`);
  assert.notDeepEqual(withNan, [], "a NaN width must never leave the compiler with nothing to say");
});

// ── maxIterations, the sibling one rule along ────────────────────────────────

test("A LOOP maxIterations THAT IS NOT A POSITIVE INTEGER IS REFUSED", () => {
  for (const bad of ["3", "banana", 2.5, Number.NaN, null, true]) {
    const d = errorsOf(withEdge("e9", { maxIterations: bad }));
    const hit = d.filter((x) => x.code === "GRAPH006_BAD_MAX_ITERATIONS");
    assert.equal(hit.length, 1, `maxIterations ${JSON.stringify(bad)} was not refused; got ${d.map((x) => x.code).join(", ") || "no errors"}`);
    assert.match(hit[0]!.message, /positive integer/);
    assert.equal(hit[0]!.at?.edgeId, "e9" as EdgeId);
  }
});

test("...absent or non-positive is still GRAPH006_UNBOUNDED_LOOP, which existing suites assert on", () => {
  const absent = clone(incidentTriage());
  const i = absent.edges.findIndex((x) => x.id === ("e9" as EdgeId));
  delete (absent.edges[i] as unknown as Record<string, unknown>)["maxIterations"];
  assert.ok(errorsOf(absent as GraphSpec).some((d) => d.code === "GRAPH006_UNBOUNDED_LOOP"));
  for (const n of [0, -1]) {
    assert.ok(
      errorsOf(withEdge("e9", { maxIterations: n })).some((d) => d.code === "GRAPH006_UNBOUNDED_LOOP"),
      `maxIterations ${n}`,
    );
  }
});

test("...and a valid maxIterations still compiles", () => {
  for (const good of [1, 3]) {
    assert.deepEqual(errorsOf(withEdge("e9", { maxIterations: good })).map((d) => d.code), [], `maxIterations ${good}`);
  }
});

// ── the shape of the check itself ────────────────────────────────────────────

test("the check reads the EDGE KIND, so a stray field on another kind is not invented into an error", () => {
  // `EDGE_FIELDS` allows `maxWidth` on any edge and no rule reads it off a `seq` one. Refusing
  // it here would be this rule deciding what an unread field means, which is a different
  // change from the one this file is about. Stated so the next reader knows it was seen.
  const s = clone(incidentTriage());
  const i = s.edges.findIndex((x) => x.id === ("e3" as EdgeId)); // correlate -> hypothesise, kind seq
  s.edges[i] = { ...s.edges[i]!, maxWidth: "banana" } as unknown as EdgeSpec;
  assert.deepEqual(
    errorsOf(s as GraphSpec).filter((d) => d.code === "GRAPH007_BAD_MAX_WIDTH").map((d) => d.code),
    [],
  );
});

test("A HOSTILE VALUE REFUSES; IT DOES NOT THROW — the guard must survive what it is refusing", () => {
  // Found while reviewing the first cut of this rule, and four of these seven CRASHED the
  // compiler rather than refusing. Two ways, and neither was the new check itself:
  //
  //   `computeFanoutStacks` multiplies the widths INSIDE `indexGraph`, before any rule runs,
  //   so `10n` was `TypeError: Cannot mix BigInt and other types` and `Symbol()` was `Cannot
  //   convert a Symbol value to a number` — out of the middle of the compiler, with the
  //   refusal never printed.
  //
  //   The diagnostic's own `JSON.stringify` threw on a circular object and on any `toJSON`
  //   the caller wrote. A guard that throws while describing what it is refusing is worse
  //   than the thing it refuses.
  //
  // JSON cannot express a bigint, a symbol or a cycle — but `compile` and `validateGraph` are
  // EXPORTED and take a `GraphSpec`, which is the same door `#assertBound` re-checks
  // `EdgeKind` at. `countOr1` and `describeValue` are the two answers.
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const hostile: [string, unknown][] = [
    ["bigint", 10n],
    ["circular object", circular],
    ["symbol", Symbol("x")],
    ["an object with valueOf", { valueOf: () => 24 }],
    ["an object whose toJSON throws", { toJSON: () => { throw new Error("boom"); } }],
    ["1e21, past the safe integer range", 1e21],
    ["an array holding the number", [24]],
  ];
  for (const [name, bad] of hostile) {
    const s = clone(incidentTriage());
    const i = s.edges.findIndex((x) => x.id === ("e1" as EdgeId));
    s.edges[i] = { ...s.edges[i]!, maxWidth: bad } as unknown as EdgeSpec;
    const d = errorsOf(s as GraphSpec);
    assert.ok(
      d.some((x) => x.code === "GRAPH007_BAD_MAX_WIDTH"),
      `${name} must be refused, not crashed through; got ${d.map((x) => x.code).join(", ") || "no errors"}`,
    );
  }

  // The same two readers exist for the loop bound.
  for (const [name, bad] of hostile) {
    const s = clone(incidentTriage());
    const i = s.edges.findIndex((x) => x.id === ("e9" as EdgeId));
    s.edges[i] = { ...s.edges[i]!, maxIterations: bad } as unknown as EdgeSpec;
    const d = errorsOf(s as GraphSpec);
    assert.ok(
      d.some((x) => x.code === "GRAPH006_BAD_MAX_ITERATIONS"),
      `${name} on maxIterations must be refused; got ${d.map((x) => x.code).join(", ") || "no errors"}`,
    );
  }
});

test("one diagnostic per bad edge, not one per rule that reads the field", () => {
  const s = clone(incidentTriage());
  const i = s.edges.findIndex((x) => x.id === ("e1" as EdgeId));
  s.edges[i] = { ...s.edges[i]!, maxWidth: "banana" } as unknown as EdgeSpec;
  const j = s.edges.findIndex((x) => x.id === ("e9" as EdgeId));
  s.edges[j] = { ...s.edges[j]!, maxIterations: "banana" } as unknown as EdgeSpec;
  const d = errorsOf(s as GraphSpec);
  assert.equal(d.filter((x) => x.code === "GRAPH007_BAD_MAX_WIDTH").length, 1);
  assert.equal(d.filter((x) => x.code === "GRAPH006_BAD_MAX_ITERATIONS").length, 1);
});

