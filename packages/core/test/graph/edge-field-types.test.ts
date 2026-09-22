/**
 * `EDGE_FIELDS` CARRIES A TYPE, AND THE PARSE CHECKS IT — TODO §A.62.
 *
 * The table was `readonly string[]`: it said which keys an edge may carry and nothing about their
 * values, so `maxWidth: "24"` parsed and every reader that needed a number tested for one by hand
 * — `rule006Cycles` on `maxIterations`, `rule007Fanout` on `maxWidth`, and `run/engine.ts`'s
 * `readableFanoutWidth` a third time. `edgeFieldTypes` in `checkStructure` is the one check now,
 * and the two rules kept the BOUND (`< 1`) and nothing else.
 *
 * THIS FILE IS THE CENSUS, NOT A SAMPLE, and that is deliberate: `docs/handoff-2026-09-19.md` §5
 * says a byte pin covers ONE arm, so the arms are enumerated BY CONSTRUCTION below and asserted
 * DISTINCT. Two claims need it most:
 *
 *   THE TABLE IS TOTAL. `allowed-fields.test.ts` already pins that every field of `EdgeSpec` has a
 *   row; `ARMS` + `DEFERRED` here pin that every row is accounted for as either checked at the
 *   parse or covered elsewhere, so a field cannot be added and silently left unchecked.
 *
 *   THE SIX DEFERRALS ARE REAL. `TYPE_CHECKED_ELSEWHERE` is a hand-written set, and its failure
 *   mode is a hole somebody once believed was covered. Every member is driven here against every
 *   wrong-typed value and must still be refused by SOMETHING. If `GRAPH004_EXPR` ever stops being
 *   total over `when`, this is what goes red.
 *
 * WHAT THIS DOES NOT CLOSE, unchanged from `fanout-width-type.test.ts`: `Executor.attach()` is
 * public and `RunGraph` is exported, so a graph reaches the executor without passing this build's
 * compiler. That is why `readableFanoutWidth` stays a third copy — §A.62 closes at two, on the
 * reason `engine.ts` states for `EDGE_KINDS`: "the compiler is the earlier answer and the executor
 * must not depend on having been the caller of it."
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { EDGE_FIELDS, type EdgeSpec, type GraphSpec, type NodeSpec } from "../../src/graph/spec.ts";
import { validateGraph, type Diagnostic } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { TENANT_CAPABILITIES, TOOLS, clone, incidentTriage, stubResolver } from "./fixtures.ts";

const errorsOf = (s: GraphSpec): readonly Diagnostic[] =>
  validateGraph({
    spec: s,
    resolver: stubResolver(),
    tools: TOOLS,
    tenantCapabilities: TENANT_CAPABILITIES,
    depth: 0,
    expanding: [],
  }).filter((d) => d.severity === "error");

/**
 * `e3` is `correlate -> hypothesise`, `kind: "seq"` — the edge NO rule reads any of these seven
 * fields off. Mutating it is what isolates the parse's own answer from a rule's: on a `fanout`
 * edge a bad `over` would also draw `GRAPH007_UNKNOWN_OVER`, and the arm census could not then say
 * which check produced which string.
 */
function withEdge(id: string, patch: Record<string, unknown>): GraphSpec {
  const s = clone(incidentTriage());
  const i = s.edges.findIndex((x) => x.id === (id as EdgeId));
  assert.notEqual(i, -1, `fixture lost edge ${id}`);
  s.edges[i] = { ...s.edges[i]!, ...patch } as unknown as EdgeSpec;
  return s as GraphSpec;
}

/**
 * A value in an assertion message, rendered without trusting it — `JSON.stringify` is
 * `TypeError: Do not know how to serialize a BigInt`, which this file hit on its first run and
 * which is the same reason `validate.ts` has `describeValue` at all.
 */
const label = (v: unknown): string => {
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol") return "a symbol";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};

/** Every wrong-typed value, by tag. `array-of-strings` is wrong for `string` and right for `stringArray`. */
const WRONG: Readonly<Record<"string" | "count" | "stringArray", readonly unknown[]>> = {
  string: [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, null, true, [], ["a"], { a: 1 }, 10n, Symbol("s")],
  count: ["24", "banana", 2.5, Number.NaN, Number.POSITIVE_INFINITY, null, true, [], ["a"], { a: 1 }, 10n, Symbol("s")],
  // `[1]` and not `["a", 1]`: a MIXED array is two faults at once — a wrong-typed element AND, for
  // `codes`, a string that is not a known error code — and it draws both diagnostics. That overlap
  // is right and is asserted on its own below; the census here isolates one fault per row.
  stringArray: ["x", 0, 2.5, Number.NaN, null, true, { a: 1 }, [1], [null], 10n, Symbol("s")],
};

/** And one RIGHT value each, so the check is not passing by refusing everything. */
const RIGHT: Readonly<Record<"string" | "count" | "stringArray", unknown>> = {
  string: "correlate",
  count: 4,
  stringArray: [],
};

/**
 * THE SEVEN ARMS THE PARSE OWNS, with the code each carries.
 *
 * `maxWidth` and `maxIterations` keep the codes they have always had — `test/examples-triage.test.ts`
 * and two suites here name them, so the mechanism moved and the vocabulary did not. The other five
 * get `GRAPH003_MALFORMED`, `validate.ts`'s existing answer for "a value is not the shape it must
 * be"; a third code for a refusal two codes already name is the thing not to add.
 */
const ARMS: readonly { readonly field: string; readonly code: string }[] = [
  { field: "over", code: "GRAPH003_MALFORMED" },
  { field: "as", code: "GRAPH003_MALFORMED" },
  { field: "maxWidth", code: "GRAPH007_BAD_MAX_WIDTH" },
  { field: "branches", code: "GRAPH003_MALFORMED" },
  { field: "maxIterations", code: "GRAPH006_BAD_MAX_ITERATIONS" },
  { field: "codes", code: "GRAPH003_MALFORMED" },
  { field: "compensates", code: "GRAPH003_MALFORMED" },
];

/** And the six the parse leaves alone, each with the check that already refuses every wrong type. */
const DEFERRED: readonly { readonly field: string; readonly by: string }[] = [
  { field: "id", by: "GRAPH003_BAD_ID" },
  { field: "from", by: "GRAPH003_DANGLING_EDGE" },
  { field: "to", by: "GRAPH003_DANGLING_EDGE" },
  { field: "kind", by: "GRAPH003_UNKNOWN_EDGE_KIND" },
  { field: "when", by: "GRAPH004_EXPR" },
  { field: "until", by: "GRAPH004_EXPR" },
];

test("EVERY FIELD OF THE TABLE IS ACCOUNTED FOR — seven checked here, six covered elsewhere", () => {
  // The census, so a fourteenth field cannot be added and silently left unchecked. `EDGE_FIELDS`
  // agreeing with `EdgeSpec` is `allowed-fields.test.ts`'s assertion; this one is that every row
  // of it is somebody's business.
  assert.deepEqual(
    [...ARMS.map((a) => a.field), ...DEFERRED.map((x) => x.field)].sort(),
    Object.keys(EDGE_FIELDS).sort(),
  );
  assert.equal(ARMS.length + DEFERRED.length, 13);
  // And every tag is one of the three the checker knows. A fourth would be a silent no-op.
  assert.deepEqual([...new Set(Object.values(EDGE_FIELDS))].sort(), ["count", "string", "stringArray"]);
});

test("THE TAG IS THE SCHEMA: every wrong-typed value of every checked field is refused, under its own code", () => {
  const seen: string[] = [];
  const perField = new Map<string, Set<string>>();
  for (const { field, code } of ARMS) {
    const tag = EDGE_FIELDS[field]!;
    perField.set(field, new Set());
    for (const bad of WRONG[tag]) {
      // `e3` is `seq`, so the parse is the only thing with an opinion: exactly one error, and it
      // is this arm's. Before §A.62 this list was EMPTY for all seven fields.
      const d = errorsOf(withEdge("e3", { [field]: bad }));
      assert.deepEqual(d.map((x) => x.code), [code], `${field} = ${label(bad)}`);
      assert.equal(d[0]!.at?.edgeId, "e3" as EdgeId);
      assert.ok((d[0]!.fix ?? "").length > 0, "a refusal an author cannot act on is half a refusal");
      seen.push(d[0]!.message);
      perField.get(field)!.add(d[0]!.message);
    }
  }
  // DISTINCT, by field AND by value: §5 of `docs/handoff-2026-09-19.md` — two arms that collapsed
  // to one string leave every pin green while the condition goes inert.
  //
  // THE TOTAL IS DERIVED FROM THE TABLES AND THEN PINNED, not written out in prose. The first cut
  // of this line said 82 from arithmetic done in a comment and the loop ran 75 — the same lesson
  // that handoff records one paragraph up ("a count in a comment must be re-measured after EVERY
  // round"). `expected` re-derives it, and the literal is what stops a table shrinking unnoticed.
  const expected = ARMS.reduce((n, a) => n + WRONG[EDGE_FIELDS[a.field]!].length, 0);
  assert.equal(expected, 82, "the census shrank or grew — say which table changed");
  assert.equal(seen.length, expected);

  // AND 82 ROWS ARE 75 SENTENCES, which is `describeValue`'s coarseness and not a merged arm. It
  // renders EVERY array as "an array" and every plain object as "an object" rather than echoing
  // untrusted contents into a diagnostic (§A.73), so within one field `[]` and `["a"]` produce one
  // sentence — three `string` fields and two `count` fields carry that pair — and `[1]` and
  // `[null]` do for the two `stringArray` fields. 3 + 2 + 2 = 7, measured, not argued.
  assert.equal(new Set(seen).size, 75);
  assert.equal(
    [...perField.values()].reduce((n, s) => n + s.size, 0),
    75,
    "a collision crossed two fields",
  );
  // The second line is the one that matters: the sum of the per-field distinct counts EQUALS the
  // global distinct count only if no two ARMS ever produced the same string. That is the check a
  // merged arm cannot hide from, and it is why the seven within-field collisions are safe to allow.
});

test("TWO FAULTS DRAW TWO DIAGNOSTICS — the type check does not shadow the rule that reads the same list", () => {
  // `codes: ["a", 1]` is wrong-typed AND names an error code that does not exist. `checkCodes`
  // skips non-strings (its own comment says why: iterating a string would report every character),
  // so the two checks see different elements of the same array and each reports what it sees. A
  // type check that swallowed the second would be this change quietly removing a refusal.
  assert.deepEqual(
    errorsOf(withEdge("e3", { codes: ["a", 1] })).map((d) => d.code),
    ["GRAPH003_UNKNOWN_ERROR_CODE", "GRAPH003_MALFORMED"],
  );
  // And a well-typed list still reaches that rule alone.
  assert.deepEqual(errorsOf(withEdge("e3", { codes: ["a"] })).map((d) => d.code), ["GRAPH003_UNKNOWN_ERROR_CODE"]);
});

test("...and a RIGHT value of each is accepted, so the check is not refusing on principle", () => {
  for (const { field } of ARMS) {
    const tag = EDGE_FIELDS[field]!;
    assert.deepEqual(
      errorsOf(withEdge("e3", { [field]: RIGHT[tag] })).map((d) => d.code),
      [],
      `${field} = ${JSON.stringify(RIGHT[tag])} is well-typed and must compile`,
    );
  }
});

const compileOf = (s: GraphSpec) =>
  compile({ spec: s, resolver: stubResolver(), tools: TOOLS, tenantCapabilities: TENANT_CAPABILITIES });

test("THE SIX DEFERRALS ARE TOTAL — every wrong-typed value of each is still refused by something", () => {
  // The load-bearing pin for `TYPE_CHECKED_ELSEWHERE`. It is a hand-written set, and the reason it
  // is allowed to exist is that a total refusal already covers each member; a set whose members are
  // NOT total is a list of holes. Driven on `e10` (`verify -> write_report`, `kind: "conditional"`,
  // which declares a `when`) so all six fields are live at once.
  //
  // THROUGH `compile`, NOT `validateGraph`, and the difference is the next test: `kind` is refused
  // by `unknownEdgeKinds`, which lives in `graph/compile.ts` and is not part of `validateGraph`.
  for (const { field, by } of DEFERRED) {
    for (const bad of [0, -1, 2.5, Number.NaN, null, true, [], { a: 1 }]) {
      const d = compileOf(withEdge("e10", { [field]: bad })).diagnostics.filter((x) => x.severity === "error");
      assert.ok(
        d.length > 0,
        `${field} = ${label(bad)} compiled clean — ${by} is no longer total and the parse must take the field back`,
      );
    }
  }
});

test("`kind` IS DEFERRED TO `compile`, AND THAT IS WHERE THE DEFERRAL ENDS — the boundary, pinned", () => {
  // `unknownEdgeKinds` refuses "ANY KIND THAT IS NOT AN OWN KEY OF `EDGE_KINDS`, WHATEVER ITS
  // TYPE", which is why a type check in `checkStructure` would be a second refusal for one mistake
  // rather than a first for a new one — one mistake, one refusal:
  assert.deepEqual(
    compileOf(withEdge("e3", { kind: 42 })).diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
    ["GRAPH003_UNKNOWN_EDGE_KIND"],
  );

  // AND THE EXACT LIMIT OF THAT, asserted so nobody reads `TYPE_CHECKED_ELSEWHERE` as a claim
  // about every path: `unknownEdgeKinds` is `compile`'s, so `validateGraph` ALONE says nothing
  // about `kind` — and `rule016Subgraphs` recurses `validateGraph`, not `compile`, into a subgraph
  // CHILD. A child edge's `kind` is therefore unchecked at compile and reaches the executor's own
  // `EDGE_KINDS` copy in `#assertBound`. That is a PRE-EXISTING hole, not one the parse opened; the
  // fix is the relocation `unknownEdgeKinds`' own docstring already proposes ("the rule belongs
  // beside GRAPH020 and moving it there is a pure relocation"), which is `compile.ts`'s to make.
  assert.deepEqual(errorsOf(withEdge("e3", { kind: 42 })).map((d) => d.code), []);

  // WHAT THE PARSE DID REACH, in the same breath: the child's wrong-typed `maxWidth` IS refused
  // now, because `edgeFieldTypes` lives in `checkStructure` and `checkStructure` is what the child
  // recursion runs. Before §A.62 a child's `maxWidth: "24"` on a `seq` edge compiled clean.
  const tool = (id: string): NodeSpec =>
    ({ id: id as NodeId, type: "tool", reads: ["inp"], writes: ["out"], tool: { name: "k8s.apply", version: "3.0", args: {} }, unhandled: true }) as NodeSpec;
  const graph = (name: string, nodes: readonly NodeSpec[], edges: readonly unknown[]): GraphSpec =>
    ({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name, project: "test", version: 1 },
      policy: { posture: "out", capabilities: ["k8s:write"], expansion: { maxNodes: 16, maxDepth: 3, maxFanout: 2, maxLoopIterations: 1 } },
      channels: { inp: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
      inputs: ["inp"],
      outputs: ["out"],
      nodes,
      edges,
    }) as unknown as GraphSpec;
  const child = graph("child", [tool("a"), tool("b")], [{ id: "c1", from: "a", to: "b", kind: "seq", maxWidth: "24" }]);
  const parent = graph(
    "parent",
    [
      {
        id: "delegate" as NodeId,
        type: "subgraph",
        reads: ["inp"],
        writes: ["out"],
        subgraph: { ref: "subgraph/child@stable", inputs: { inp: "inp" }, outputs: { out: "out" } },
        unhandled: true,
      } as NodeSpec,
    ],
    [],
  );
  const r = compile({
    spec: parent,
    resolver: stubResolver({ subgraphs: { "subgraph/child@stable": child } }),
    tools: TOOLS,
    tenantCapabilities: ["k8s:write"],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.diagnostics.some((d) => d.code === "GRAPH007_BAD_MAX_WIDTH"),
    `a child's wrong-typed width must reach the parent's compile; got ${r.diagnostics.map((d) => d.code).join(", ") || "nothing"}`,
  );
});

test("A NON-FINITE NUMBER IS A DIAGNOSTIC, NOT A THROW — 60 rows of the census used to crash `compile`", () => {
  // The finding the row did not know about. With no rule reading `maxWidth` off a `seq` edge,
  // nothing refused `Number.NaN` there, so `compile` reached `graphHash: digest(spec)` and threw
  // `CanonicalizationError: non-finite number NaN at edges[2].maxWidth` — out of the middle of the
  // compiler, with no diagnostic. Measured on `6fb2e618` for `over`, `as`, `maxWidth`, `branches`,
  // `maxIterations`, `codes` and `compensates`, on every edge kind that does not read them.
  for (const { field, code } of ARMS) {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
      const r = compile({
        spec: withEdge("e3", { [field]: bad }),
        resolver: stubResolver(),
        tools: TOOLS,
        tenantCapabilities: TENANT_CAPABILITIES,
      });
      assert.equal(r.ok, false, `${field} = ${String(bad)}`);
      assert.ok(
        r.diagnostics.some((d) => d.code === code),
        `${field} = ${String(bad)} must be refused, not crashed through; got ${r.diagnostics.map((d) => d.code).join(", ") || "nothing"}`,
      );
    }
  }
});

test("THE BYTES, one arm per code, message AND fix", () => {
  // Three codes reach an author from this check, and the exact strings are pinned because §A.62's
  // constraint was that a wrong-typed field's diagnostic may change and must then be nailed down.
  // `describeValue` renders both the value and the edge's own id (§A.73): neither is trusted here,
  // and `describeValue("e3")` is `"e3"`, so the text is what the lines around it interpolate raw.
  const one = (patch: Record<string, unknown>): Diagnostic => {
    const d = errorsOf(withEdge("e3", patch));
    assert.equal(d.length, 1, d.map((x) => x.code).join(", "));
    return d[0]!;
  };

  const width = one({ maxWidth: "24" });
  assert.equal(width.code, "GRAPH007_BAD_MAX_WIDTH");
  assert.equal(
    width.message,
    'edge "e3" declares maxWidth "24", which is not a positive integer — the width is multiplied into every downstream node\'s parallel width and sliced off the fanned channel, and neither reader can use this value',
  );
  assert.equal(width.fix, 'set maxWidth on edge "e3" to a whole number ≥ 1 (unquoted: 24, not "24")');

  const iterations = one({ maxIterations: "3" });
  assert.equal(iterations.code, "GRAPH006_BAD_MAX_ITERATIONS");
  assert.equal(
    iterations.message,
    'edge "e3" declares maxIterations "3", which is not a positive integer — the bound is compared against the iteration counter and multiplied into the node\'s total multiplicity, and neither reader can use this value',
  );
  assert.equal(iterations.fix, 'set maxIterations on edge "e3" to a whole number ≥ 1 (unquoted: 3, not "3")');

  const over = one({ over: 7 });
  assert.equal(over.code, "GRAPH003_MALFORMED");
  assert.equal(over.message, 'edge "e3" declares over 7, which is not a string');
  assert.equal(over.fix, 'set over on edge "e3" to a string, or remove it');

  const branches = one({ branches: "investigate" });
  assert.equal(branches.code, "GRAPH003_MALFORMED");
  assert.equal(branches.message, 'edge "e3" declares branches "investigate", which is not an array of strings');
  assert.equal(branches.fix, 'set branches on edge "e3" to an array of strings, or remove it');

  // A HOSTILE VALUE IS RENDERED, NOT RUN. `JSON.stringify` throws on a bigint and runs any
  // `toJSON` the caller wrote; a guard that throws while describing what it refuses is worse than
  // the thing it refuses.
  assert.equal(one({ maxWidth: 10n }).message.includes("declares maxWidth 10n,"), true);
  assert.equal(one({ over: Symbol("s") }).message, 'edge "e3" declares over a symbol, which is not a string');
  assert.equal(
    one({ maxWidth: { toJSON: () => { throw new Error("boom"); } } }).message.includes("declares maxWidth an object,"),
    true,
  );
});

test("THE BOUND STAYED WITH THE RULES: `0` and `-1` keep the codes and the bytes they had", () => {
  // The deliberate seam. `count` is `Number.isSafeInteger` alone, so `0` and `-1` are well-typed
  // and reach the rules that own the bound — which is what keeps `GRAPH006_UNBOUNDED_LOOP` for a
  // loop declaring `0` (three suites assert on it) and keeps `expansion.maxFanout` inside
  // GRAPH007's fix. Byte-identical to `6fb2e618`.
  const zeroWidth = errorsOf(withEdge("e1", { maxWidth: 0 }));
  assert.deepEqual(zeroWidth.map((d) => d.code), ["GRAPH007_BAD_MAX_WIDTH"]);
  assert.equal(
    zeroWidth[0]!.message,
    'fanout edge "e1" declares maxWidth 0, which is not a positive integer — the width is multiplied into every downstream node\'s parallel width and sliced off the fanned channel, and neither reader can use this value',
  );
  assert.equal(zeroWidth[0]!.fix, 'set maxWidth on edge "e1" to a whole number between 1 and 25 (unquoted: 24, not "24")');

  for (const bad of [0, -1]) {
    const d = errorsOf(withEdge("e9", { maxIterations: bad }));
    assert.deepEqual(d.map((x) => x.code), ["GRAPH006_UNBOUNDED_LOOP"], `maxIterations ${bad}`);
    assert.equal(d[0]!.message, 'loop edge "e9" has no maxIterations');
  }
});

test("AN UNKNOWN KEY IS STILL AN UNKNOWN KEY, and the list it quotes is in the table's order", () => {
  // `EDGE_FIELDS` went from an array to a keyed table, and `unknownKeys` now reads
  // `Object.keys(EDGE_FIELDS)`. Insertion order is preserved, so this sentence is byte-for-byte
  // what it was — the one place the table's shape is visible to an author.
  const d = errorsOf(withEdge("e3", { maxWidthh: 4 }));
  assert.deepEqual(d.map((x) => x.code), ["GRAPH020_UNKNOWN_FIELD"]);
  assert.equal(d[0]!.message, 'edge "e3" has an unknown field `maxWidthh`');
  assert.equal(d[0]!.fix, "did you mean `maxWidth` or `maxIterations`?");
});
