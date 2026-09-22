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
 *   THE SIX DEFERRALS ARE REAL, FIVE OF THEM TOTAL AND THE SIXTH EXCLUDED BY NAME.
 *   `TYPE_CHECKED_ELSEWHERE` is a hand-written set and its failure mode is a hole somebody once
 *   believed was covered, so every member is driven against every wrong-typed value its tag has and
 *   must be refused by SOMETHING — with a THROW counted as a failure, because a crash is not a
 *   refusal. That distinction is what the first cut of this file got wrong: it drove eight of the
 *   twelve values and its `d.length > 0` could not see an exception, so five sites that threw on a
 *   `symbol` or a `bigint` passed. `kind` is the one exclusion; it is a CLASS and not two values —
 *   `KIND_STILL_THROWS` below names the class, measures its members and drives two of them — and the
 *   site is in `graph/compile.ts`, not this lane's file to fix.
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
  assert.deepEqual([...new Set(Object.values(EDGE_FIELDS).map((v) => v.type))].sort(), ["count", "string", "stringArray"]);
  // And every `readBy` is a real `EdgeKind`, so the not-declared-for-this-kind message cannot name
  // a kind no edge can have. Four fields have none — exactly the four with no `<kind> only` comment
  // in `EdgeSpec`, all of them in `TYPE_CHECKED_ELSEWHERE`.
  const KINDS = ["seq", "conditional", "fanout", "join", "error", "compensation", "loop"];
  for (const [field, decl] of Object.entries(EDGE_FIELDS)) {
    if (decl.readBy === undefined) {
      assert.ok(["id", "from", "to", "kind"].includes(field), `${field} has no readBy — is it really declared for every kind?`);
      continue;
    }
    assert.ok(KINDS.includes(decl.readBy), `${field}.readBy = ${decl.readBy} is not an EdgeKind`);
  }
});

test("THE TAG IS THE SCHEMA: every wrong-typed value of every checked field is refused, under its own code", () => {
  const seen: string[] = [];
  const perField = new Map<string, Set<string>>();
  for (const { field, code } of ARMS) {
    const tag = EDGE_FIELDS[field]!.type;
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
  const expected = ARMS.reduce((n, a) => n + WRONG[EDGE_FIELDS[a.field]!.type].length, 0);
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
    const tag = EDGE_FIELDS[field]!.type;
    assert.deepEqual(
      errorsOf(withEdge("e3", { [field]: RIGHT[tag] })).map((d) => d.code),
      [],
      `${field} = ${JSON.stringify(RIGHT[tag])} is well-typed and must compile`,
    );
  }
});

const compileOf = (s: GraphSpec) =>
  compile({ spec: s, resolver: stubResolver(), tools: TOOLS, tenantCapabilities: TENANT_CAPABILITIES });

/**
 * THE ONE EXCLUSION, AND IT IS A CLASS RATHER THAN TWO VALUES — say the set honestly.
 *
 * `graph/compile.ts`'s `unknownEdgeKinds` has TWO sites that coerce the value, and the class is the
 * union of what each cannot do — measured, one graph per row, in `.agent/spec-a62/probe-kind-class.ts`:
 *
 *     :325 `JSON.stringify(edge.kind)`   10n              TypeError: Do not know how to serialize a BigInt
 *                                        [10n], {a:10n}   the same, at any depth
 *                                        {toJSON throws}  Error: boom
 *                                        a circular object TypeError: Converting circular structure
 *                                        a Proxy whose get trap throws
 *     :317 `Object.hasOwn(…, edge.kind)` [Symbol()]       TypeError: Cannot convert a Symbol value
 *                                        (the KEY coercion, not the message)
 *
 * A BARE `Symbol()` DOES NOT THROW and is a diagnostic — `String(sym)` is legal where a template is
 * not, and `?? String(edge.kind)` is what catches it. So the set is "a `kind` that
 * `JSON.stringify` refuses, plus one that `Object.hasOwn`'s key coercion refuses", and the two
 * values driven below are MEMBERS OF IT, not the whole of it. Naming only those two here would be
 * the same mistake `TYPE_CHECKED_ELSEWHERE` made when it said "total".
 *
 * NOT THIS LANE'S FILE TO FIX — `compile.ts` is outside the owned set, and the repair is the one
 * `unknownEdgeKinds`' own docstring already proposes: move the rule beside GRAPH020, where
 * `describeValue` is. Listing these makes the exclusion a measured fact rather than a hope: if that
 * site ever learns to render safely, this test goes red and the rows come off.
 */
const KIND_STILL_THROWS: readonly unknown[] = [10n, { toJSON: () => { throw new Error("boom"); } }];

test("THE SIX DEFERRALS, DRIVEN OVER THE WHOLE `WRONG` TABLE — five total, one excluded by name", () => {
  // The load-bearing pin for `TYPE_CHECKED_ELSEWHERE`. It is a hand-written set, and the reason it
  // is allowed to exist is that a refusal already covers each member; a set whose members are NOT
  // total is a list of holes somebody believed were covered.
  //
  // THE FIRST CUT DROVE EIGHT VALUES while this file's own `WRONG` table held twelve, and the four
  // it skipped were the ones that mattered: a reviewer found that `10n` and `Symbol()` made FIVE of
  // these six sites THROW rather than refuse. Measured on `19b183c4`, one graph per row —
  //
  //     id: Symbol()      TypeError: Cannot convert a Symbol value to a string  (the checkCodes site)
  //     id: 10n           TypeError: Do not know how to serialize a BigInt      (badId)
  //     id: {toJSON↯}     Error: boom                                          (badId)
  //     from/to: Symbol() TypeError: Cannot convert a Symbol value to a string  (dangling)
  //     when/until: Sym() TypeError: Cannot convert a Symbol value to a string  (rule004's `check`)
  //     kind: 10n         TypeError: Do not know how to serialize a BigInt      (compile.ts)
  //     kind: {toJSON↯}   Error: boom                                          (compile.ts)
  //
  // so the loop now drives EVERY value the table has, and asserts a DIAGNOSTIC rather than merely a
  // non-empty result — a throw is not a refusal, and the first cut's `d.length > 0` could not tell
  // the difference because an exception never reached it.
  //
  // THROUGH `compile`, NOT `validateGraph`: `kind` is refused by `unknownEdgeKinds`, which
  // `validateGraph` does not run (the next test pins that boundary).
  // `WRONG[the field's own tag]`, which for all six is `WRONG.string` — so `"24"` and `"banana"`
  // are NOT driven here, and that is correct rather than a gap: a string is the RIGHT type for
  // every one of these fields, `id: "24"` is a legal id (`isSafeId` accepts a leading digit) and
  // compiles clean. The claim being pinned is about wrong TYPES.
  for (const { field, by } of DEFERRED) {
    const every = WRONG[EDGE_FIELDS[field]!.type];
    assert.equal(every.length, 12, `the WRONG table for ${field}'s tag changed — re-measure this loop`);
    for (const bad of every) {
      const excluded = field === "kind" && KIND_STILL_THROWS.some((x) => Object.is(x, bad));
      let d: readonly Diagnostic[] | undefined;
      let threw: string | undefined;
      try {
        d = compileOf(withEdge("e10", { [field]: bad })).diagnostics.filter((x) => x.severity === "error");
      } catch (err) {
        threw = `${(err as Error).name}: ${(err as Error).message}`;
      }
      if (excluded) {
        assert.ok(
          threw !== undefined,
          `kind = ${label(bad)} no longer throws — take it off KIND_STILL_THROWS and out of the docstring`,
        );
        continue;
      }
      assert.equal(threw, undefined, `${field} = ${label(bad)} CRASHED the compiler instead of refusing: ${threw}`);
      assert.ok(
        (d ?? []).length > 0,
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

const one = (edgeId: string, patch: Record<string, unknown>): Diagnostic => {
  const d = errorsOf(withEdge(edgeId, patch));
  assert.equal(d.length, 1, d.map((x) => x.code).join(", "));
  return d[0]!;
};

test("THE BYTES · the edge IS the kind that declares the field — word for word what the RULE printed", () => {
  // The refusal an author most often meets, and it is byte-identical to `6fb2e618`'s, which is the
  // point: §A.62 moved the mechanism and must not have moved the diagnostic. Two things make that
  // true and both were missing from the first cut — the `fanout `/`loop ` subject, which the parse
  // can print because it has read the kind, and the graph's OWN `expansion.maxFanout` in the fix,
  // which `maxFanoutOf` reads with `expansionOf`'s own fallback. `incidentTriage` declares 25.
  const width = one("e1", { maxWidth: "24" });
  assert.equal(width.code, "GRAPH007_BAD_MAX_WIDTH");
  assert.equal(
    width.message,
    'fanout edge "e1" declares maxWidth "24", which is not a positive integer — the width is multiplied into every downstream node\'s parallel width and sliced off the fanned channel, and neither reader can use this value',
  );
  assert.equal(width.fix, 'set maxWidth on edge "e1" to a whole number between 1 and 25 (unquoted: 24, not "24")');

  const iterations = one("e9", { maxIterations: "3" });
  assert.equal(iterations.code, "GRAPH006_BAD_MAX_ITERATIONS");
  assert.equal(
    iterations.message,
    'loop edge "e9" declares maxIterations "3", which is not a positive integer — the bound is compared against the iteration counter and multiplied into the node\'s total multiplicity, and neither reader can use this value',
  );
  assert.equal(iterations.fix, 'set maxIterations on edge "e9" to a whole number ≥ 1 (unquoted: 3, not "3")');

  // NO ", or remove it" HERE, and that is the correction: removing `over` from a fanout is
  // `GRAPH007_FANOUT_INCOMPLETE` and removing `compensates` from a compensation edge is
  // `GRAPH012_NO_COMPENSATES`, so the first cut's fix walked an author into a second refusal.
  const over = one("e1", { over: 7 });
  assert.equal(over.code, "GRAPH003_MALFORMED");
  assert.equal(over.message, 'fanout edge "e1" declares over 7, which is not a string');
  assert.equal(over.fix, 'set over on edge "e1" to a string');

  const compensates = one("e12", { compensates: 7 });
  assert.equal(compensates.message, 'compensation edge "e12" declares compensates 7, which is not a string');
  assert.equal(compensates.fix, 'set compensates on edge "e12" to a string');

  const branches = one("e2", { branches: "investigate" });
  assert.equal(branches.message, 'join edge "e2" declares branches "investigate", which is not an array of strings');
  // ", or remove it" IS BACK for the two `stringArray` fields and only for them — a join with no
  // `branches` compiles clean, so removal is a valid edit and round 1 was wrong to withhold it.
  // `REMOVAL IS OFFERED ONLY WHERE THE COMPILER ACCEPTS IT` below measures all six fields.
  assert.equal(branches.fix, 'set branches on edge "e2" to an array of strings, or remove it');

  // `codes: null` ON THE KIND THAT DECLARES IT — the one previously-compiling shape reachable from
  // plain JSON where the field's own kind reads it. `checkCodes` returns early on a non-array
  // ("iterating a string would report every character"), so at base this was `ok: true`, zero
  // diagnostics, and the `codes` an author believed they had written restricted nothing.
  const codes = one("e11", { codes: null });
  assert.equal(codes.code, "GRAPH003_MALFORMED");
  assert.equal(codes.message, 'error edge "e11" declares codes null, which is not an array of strings');
  assert.equal(codes.fix, 'set codes on edge "e11" to an array of strings, or remove it');
});

test("THE BYTES · the edge is NOT that kind — the fix says REMOVE, and no reader is asserted", () => {
  // The first cut printed the rule's own because-clause here ("the width is multiplied into every
  // downstream node's parallel width") over a `seq` edge, where no such reader exists, and then
  // told the author to "set maxWidth to a whole number" — a number nothing would ever read. Both
  // halves are wrong for this branch and both are fixed: the tail names the kind the field is
  // declared FOR, and the fix is removal, which is unambiguously right because nothing requires it.
  const width = one("e3", { maxWidth: "24" });
  assert.equal(width.code, "GRAPH007_BAD_MAX_WIDTH", "the CODE does not change with the kind");
  assert.equal(
    width.message,
    'edge "e3" declares maxWidth "24", which is not a positive integer — and maxWidth is declared for fanout edges, not for kind "seq"',
  );
  assert.equal(width.fix, 'remove maxWidth from edge "e3"');

  const iterations = one("e3", { maxIterations: "3" });
  assert.equal(
    iterations.message,
    'edge "e3" declares maxIterations "3", which is not a positive integer — and maxIterations is declared for loop edges, not for kind "seq"',
  );
  assert.equal(iterations.fix, 'remove maxIterations from edge "e3"');

  const codes = one("e3", { codes: null });
  assert.equal(
    codes.message,
    'edge "e3" declares codes null, which is not an array of strings — and codes is declared for error edges, not for kind "seq"',
  );
  assert.equal(codes.fix, 'remove codes from edge "e3"');

  // THE KIND ITSELF IS UNTRUSTED in this sentence, so it is rendered too. A `kind` that is not a
  // string reaches here because `TYPE_CHECKED_ELSEWHERE` defers it — the message must not be able
  // to throw on it, and must not claim a subject it cannot name.
  const d = errorsOf(withEdge("e3", { kind: 42, maxWidth: "24" }));
  const hit = d.filter((x) => x.code === "GRAPH007_BAD_MAX_WIDTH");
  assert.equal(hit.length, 1);
  assert.equal(
    hit[0]!.message,
    'edge "e3" declares maxWidth "24", which is not a positive integer — and maxWidth is declared for fanout edges, not for kind 42',
  );
});

test("A HOSTILE VALUE IS RENDERED, NOT RUN — including the two `describeValue` exists for", () => {
  // `JSON.stringify` throws on a bigint and re-raises any `toJSON` the caller wrote; a guard that
  // throws while describing what it is refusing is worse than the thing it refuses.
  assert.equal(one("e3", { maxWidth: 10n }).message.includes("declares maxWidth 10n,"), true);
  assert.equal(
    one("e1", { over: Symbol("s") }).message,
    'fanout edge "e1" declares over a symbol, which is not a string',
  );
  assert.equal(
    one("e3", { maxWidth: { toJSON: () => { throw new Error("boom"); } } }).message.includes("declares maxWidth an object,"),
    true,
  );
});

test("A SPARSE ARRAY IS REFUSED — `Array.prototype.every` SKIPS HOLES and `digest` does not", () => {
  // The blocking finding of fix round 1. `stringArray` was `Array.isArray(v) && v.every(x => typeof
  // x === "string")`, and `every` visits OWN indices only, so a hole satisfied it vacuously — then
  // `canonical.ts` walked `0..length-1`, found the hole, and threw OUT of `compile`. Measured on
  // `19b183c4`, and the crash class this whole check exists to close:
  //
  //     branches: new Array(2)  ->  THREW CanonicalizationError: undefined array element
  //                                 at edges[2].branches[0]
  //
  // The predicate index-walks now, which asks about exactly the indices `digest` will ask about.
  for (const [what, edgeId, patch] of [
    ["branches on the join that declares it", "e2", { branches: new Array<string>(2) }],
    ["branches on a kind that does not", "e3", { branches: new Array<string>(2) }],
    ["a leading hole", "e2", { branches: [, "a"] as unknown as string[] }],
    ["a trailing hole", "e2", { branches: ["a", , "b"] as unknown as string[] }],
    ["codes on the error edge that declares it", "e11", { codes: new Array<string>(1) }],
    ["length longer than the indices", "e2", { branches: Object.assign(["a"], { length: 4 }) }],
  ] as const) {
    const r = compile({
      spec: withEdge(edgeId, patch as Record<string, unknown>),
      resolver: stubResolver(),
      tools: TOOLS,
      tenantCapabilities: TENANT_CAPABILITIES,
    });
    // `compile`, not `validateGraph`: the throw was from `digest(spec)`, which only `compile` runs.
    assert.equal(r.ok, false, what);
    assert.ok(
      r.diagnostics.some((x) => x.code === "GRAPH003_MALFORMED"),
      `${what}: ${r.diagnostics.map((x) => x.code).join(", ") || "nothing"}`,
    );
  }
  // AND A DENSE ARRAY OF STRINGS IS STILL FINE, so the walk did not refuse the ordinary case.
  assert.deepEqual(errorsOf(withEdge("e2", { branches: ["investigate"] })).map((x) => x.code), []);
  assert.deepEqual(errorsOf(withEdge("e2", { branches: [] })).map((x) => x.code), []);
});

test("OWN KEYS ONLY — a polluted `Object.prototype` used to put a `maxWidth` on every edge alive", () => {
  // `edgeFieldTypes` read `edge[field]`, which walks the prototype chain, while `unknownKeys` two
  // lines up reads `Object.keys` and this file's stated rule is `Object.hasOwn`. Measured on
  // `19b183c4`: with `Object.prototype.maxWidth = "24"` set, the UNMUTATED fixture drew FIFTEEN
  // `GRAPH007_BAD_MAX_WIDTH` refusals, one per edge, for a field no edge declares.
  const proto = Object.prototype as unknown as Record<string, unknown>;
  try {
    proto["maxWidth"] = "24";
    proto["branches"] = "nope";
    assert.deepEqual(errorsOf(incidentTriage()).map((x) => x.code), []);
  } finally {
    delete proto["maxWidth"];
    delete proto["branches"];
  }
  // And a field the edge really does declare is still read, so the own-key test did not switch the
  // check off.
  assert.deepEqual(errorsOf(withEdge("e1", { maxWidth: "24" })).map((x) => x.code), ["GRAPH007_BAD_MAX_WIDTH"]);
});

test("OWN KEYS FOR THE CEILING TOO — two numbers for one limit is worse than either", () => {
  // The same defect one scope over, and it produced a WRONG NUMBER rather than a spurious refusal.
  // `maxFanoutOf` read `expansion["maxFanout"]` bare while `expansionOf` uses `Object.hasOwn`, so on
  // a graph declaring no `maxFanout` of its own with `Object.prototype.maxFanout = 8` set, the two
  // disagreed — measured on one object:
  //
  //     declared["maxFanout"]                  -> 8
  //     Object.hasOwn(declared, "maxFanout")   -> false, so expansionOf answers DEFAULT 32
  //
  // The fix said "between 1 and 8" about a ceiling `rule007Fanout` enforced at 32.
  const noCeiling = (): GraphSpec => {
    const s = clone(incidentTriage()) as unknown as Record<string, unknown>;
    delete ((s["policy"] as Record<string, unknown>)["expansion"] as Record<string, unknown>)["maxFanout"];
    const edges = s["edges"] as Record<string, unknown>[];
    const i = edges.findIndex((x) => x["id"] === "e1");
    edges[i] = { ...edges[i]!, maxWidth: "24" };
    return s as unknown as GraphSpec;
  };
  const proto = Object.prototype as unknown as Record<string, unknown>;
  try {
    proto["maxFanout"] = 8;
    const d = errorsOf(noCeiling()).filter((x) => x.code === "GRAPH007_BAD_MAX_WIDTH");
    assert.equal(d.length, 1);
    assert.equal(d[0]!.fix, 'set maxWidth on edge "e1" to a whole number between 1 and 32 (unquoted: 24, not "24")');
  } finally {
    delete proto["maxFanout"];
  }
  // And a DECLARED ceiling still wins, so the own-key test did not turn the read into a constant.
  assert.equal(
    errorsOf(withEdge("e1", { maxWidth: "24" })).find((x) => x.code === "GRAPH007_BAD_MAX_WIDTH")!.fix,
    'set maxWidth on edge "e1" to a whole number between 1 and 25 (unquoted: 24, not "24")',
  );
});

test("ONE SPELLING · the parse's arm and `rule007Fanout`'s arm are the same producer", () => {
  // `GRAPH007_BAD_MAX_WIDTH` has two raisers — the parse for a wrong TYPE, `rule007Fanout` for a
  // value below 1 — and for one round they were two copies of one sentence. They had already
  // drifted: each fetched `maxFanout` its own way. `edgeFieldRefusal` is now the single producer and
  // this asserts the two paths agree on everything but the value, on ONE graph, so a copy cannot
  // come back without going red.
  const parse = errorsOf(withEdge("e1", { maxWidth: "24" })).find((x) => x.code === "GRAPH007_BAD_MAX_WIDTH")!;
  const rule = errorsOf(withEdge("e1", { maxWidth: 0 })).find((x) => x.code === "GRAPH007_BAD_MAX_WIDTH")!;
  assert.equal(parse.fix, rule.fix, "the two arms disagree about the fix");
  assert.deepEqual(parse.at, rule.at);
  assert.equal(parse.severity, rule.severity);
  // The messages differ in the VALUE and nowhere else.
  assert.equal(parse.message.replace('maxWidth "24"', "maxWidth <v>"), rule.message.replace("maxWidth 0", "maxWidth <v>"));
});

test("REMOVAL IS OFFERED ONLY WHERE THE COMPILER ACCEPTS IT — measured per field, not per taste", () => {
  // ", or remove it" was dropped from every tag in round 1. Right for `string` and `count`, WRONG
  // for the two `stringArray` fields: measured, one graph each, a join with no `branches` and an
  // error edge with no `codes` both compile with ZERO diagnostics, so removal is a valid fix and
  // withholding it made the refusal less useful than it could be.
  const dropped = (edgeId: string, field: string): GraphSpec => {
    const s = clone(incidentTriage()) as unknown as Record<string, unknown>;
    const edges = s["edges"] as Record<string, unknown>[];
    const i = edges.findIndex((x) => x["id"] === edgeId);
    const copy = { ...edges[i]! };
    delete copy[field];
    edges[i] = copy;
    return s as unknown as GraphSpec;
  };
  // THE PREMISE FIRST, so the advice below rests on a measurement and not on a belief.
  assert.deepEqual(errorsOf(dropped("e2", "branches")).map((x) => x.code), [], "a join with no branches must compile");
  assert.deepEqual(errorsOf(dropped("e11", "codes")).map((x) => x.code), [], "an error edge with no codes must compile");
  assert.deepEqual(
    errorsOf(dropped("e1", "over")).map((x) => x.code),
    ["GRAPH007_FANOUT_INCOMPLETE"],
    "and removing `over` from a fanout is refused, which is why `string` offers no such hint",
  );
  assert.deepEqual(errorsOf(dropped("e12", "compensates")).map((x) => x.code), ["GRAPH012_NO_COMPENSATES"]);
  assert.deepEqual(errorsOf(dropped("e1", "maxWidth")).map((x) => x.code), ["GRAPH007_NO_MAX_WIDTH"]);
  assert.deepEqual(errorsOf(dropped("e9", "maxIterations")).map((x) => x.code), ["GRAPH006_UNBOUNDED_LOOP"]);

  // THEN THE ADVICE, and it follows the measurement exactly.
  assert.equal(one("e2", { branches: 7 }).fix, 'set branches on edge "e2" to an array of strings, or remove it');
  assert.equal(one("e11", { codes: 7 }).fix, 'set codes on edge "e11" to an array of strings, or remove it');
  assert.equal(one("e1", { over: 7 }).fix, 'set over on edge "e1" to a string');
  assert.equal(one("e12", { compensates: 7 }).fix, 'set compensates on edge "e12" to a string');
  assert.equal(
    one("e1", { maxWidth: "24" }).fix,
    'set maxWidth on edge "e1" to a whole number between 1 and 25 (unquoted: 24, not "24")',
  );
});

test("AN EDGE ID CANNOT FORGE A LINE — every value the edge loop names goes through `describeValue`", () => {
  // §A.73's shape, found by a reviewer of this change: `GRAPH020_UNKNOWN_FIELD` interpolated
  // `edge "${e.id}"` raw while the new sibling escaped it, so ONE compile printed one forged line
  // and one escaped line about the same edge. Measured on `19b183c4`, the GRAPH020 message was
  // three lines, the second of which reads `   fix: nothing is wrong` and the third `✓ ok`.
  const forged = 'e3"\n   fix: nothing is wrong\n✓ ok';
  const d = errorsOf(withEdge("e3", { id: forged, maxWidthh: 4, maxWidth: "24" }));
  for (const x of d) {
    assert.ok(!x.message.includes("\n"), `${x.code} still carries a newline: ${JSON.stringify(x.message)}`);
    assert.ok(!(x.fix ?? "").includes("\n"), `${x.code}'s fix carries a newline`);
  }
  const g20 = d.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD");
  assert.ok(g20 !== undefined, d.map((x) => x.code).join(", "));
  assert.equal(g20.message, 'edge "e3\\"\\n   fix: nothing is wrong\\n✓ ok" has an unknown field `maxWidthh`');
  // AND AN ORDINARY ID IS UNCHANGED, which is why the quotes moved into the renderer rather than
  // disappearing: `describeValue("e3")` is `"e3"`.
  const plain = errorsOf(withEdge("e3", { maxWidthh: 4 }));
  assert.equal(plain[0]!.message, 'edge "e3" has an unknown field `maxWidthh`');
  assert.equal(plain[0]!.fix, "did you mean `maxWidth` or `maxIterations`?");
});

test("THE FIVE OTHER SITES THAT NAME AN UNCHECKED VALUE, and the bytes they print for a good graph", () => {
  // `TYPE_CHECKED_ELSEWHERE` claims a refusal already covers each of its six members. Five of those
  // refusals CRASHED on a value they were refusing, which is not a refusal at all — measured on
  // `19b183c4`, one graph per row:
  //
  //     id: Symbol()     THREW TypeError: Cannot convert a Symbol value to a string   (checkCodes site)
  //     id: 10n          THREW TypeError: Do not know how to serialize a BigInt       (badId)
  //     from: Symbol()   THREW TypeError: Cannot convert a Symbol value to a string   (dangling)
  //     when: Symbol()   THREW TypeError: Cannot convert a Symbol value to a string   (rule004)
  //
  // All four are diagnostics now. The bytes below are the ORDINARY half: what each site prints for
  // a plainly-wrong-but-harmless value, so the fix cannot have been paid for with a worse message.
  const bad = (patch: Record<string, unknown>, code: string): Diagnostic => {
    const hit = errorsOf(withEdge("e10", patch)).filter((x) => x.code === code);
    assert.ok(hit.length > 0, `${code} did not fire`);
    return hit[0]!;
  };
  assert.equal(bad({ id: "not a safe id" }, "GRAPH003_BAD_ID").message, 'edge id "not a safe id" is not a usable id');
  assert.equal(bad({ id: 0 }, "GRAPH003_BAD_ID").message, "edge id 0 is not a usable id");
  assert.equal(bad({ id: 10n }, "GRAPH003_BAD_ID").message, "edge id 10n is not a usable id");
  assert.equal(bad({ id: Symbol("s") }, "GRAPH003_BAD_ID").message, "edge id a symbol is not a usable id");
  // `JSON.stringify` called BOTH of these `null`, which read as a formatting bug rather than as the
  // value the author wrote. That is a message IMPROVEMENT and is pinned as one.
  assert.equal(bad({ id: Number.NaN }, "GRAPH003_BAD_ID").message, "edge id NaN is not a usable id");
  assert.equal(bad({ id: [] }, "GRAPH003_BAD_ID").message, "edge id an array is not a usable id");

  assert.equal(bad({ from: "nope" }, "GRAPH003_DANGLING_EDGE").message, 'edge "e10" starts at unknown node "nope"');
  assert.equal(bad({ from: Symbol("s") }, "GRAPH003_DANGLING_EDGE").message, 'edge "e10" starts at unknown node a symbol');
  assert.equal(bad({ to: 7 }, "GRAPH003_DANGLING_EDGE").message, 'edge "e10" ends at unknown node 7');

  assert.equal(bad({ when: "!!" }, "GRAPH004_EXPR").message.startsWith("`!!`: "), true, "a string expression is shown as written");
  assert.equal(bad({ when: Symbol("s") }, "GRAPH004_EXPR").message.startsWith("`a symbol`: "), true);

  assert.equal(
    bad({ codes: ["nope"] }, "GRAPH003_UNKNOWN_ERROR_CODE").message,
    'edge "e10" names error code "nope", which no error in this system carries — it would never match',
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
