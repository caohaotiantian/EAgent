import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTINS,
  type BuiltinName,
  checkExpr,
  evaluateSource,
  inferType,
  parseExpr,
  referencedChannels,
  type Ty,
  type TypeError as ExprTypeError,
} from "../../src/graph/expr.ts";

const CH: Record<string, Ty> = {
  verdict: "object",
  score: "number",
  name: "string",
  ready: "boolean",
  findings: "array",
  applied: "array",
};

const ev = (src: string, scope: Record<string, unknown> = {}): unknown => evaluateSource(src, scope);

// ── parsing and precedence ───────────────────────────────────────────────────

test("precedence: && binds tighter than ||", () => {
  assert.equal(ev("true || false && false"), true);
  assert.equal(ev("(true || false) && false"), false);
});

test("precedence: arithmetic before comparison before logic", () => {
  assert.equal(ev("1 + 2 * 3 == 7"), true);
  assert.equal(ev("2 * 3 > 5 && 1 < 2"), true);
});

test("unary minus and negation", () => {
  assert.equal(ev("-3 + 5"), 2);
  assert.equal(ev("!false"), true);
  assert.equal(ev("!!true"), true);
});

test("subtraction lexes as an operator, not as part of a number", () => {
  assert.equal(ev("5-2"), 3);
  assert.equal(ev("1e3 - 1"), 999, "but an exponent sign still belongs to the number");
});

test("member and index access chain", () => {
  const scope = { v: { a: { b: [10, 20, 30] } } };
  assert.equal(ev("v.a.b[1]", scope), 20);
  assert.equal(ev("v.a.b[-1]", scope), 30, "negative indices count from the end");
  assert.equal(ev('v["a"].b[0]', scope), 10);
});

test("string literals support both quote styles and escapes", () => {
  assert.equal(ev('"a\\nb"'), "a\nb");
  assert.equal(ev("'single'"), "single");
});

test("syntax errors name the offset and the source", () => {
  assert.throws(() => parseExpr("1 +"), /expected a value/);
  assert.throws(() => parseExpr("(1"), /expected "\)"/);
  assert.throws(() => parseExpr("1 2"), /unexpected trailing input/);
  assert.throws(() => parseExpr('"unterminated'), /unterminated string/);
  assert.throws(() => parseExpr("a @ b"), /unexpected character/);
});

test("unknown functions are rejected at parse time", () => {
  assert.throws(() => parseExpr("eval(1)"), /unknown function "eval"/);
  assert.throws(() => parseExpr("len(1, 2)"), /len\(\) takes 1 argument/);
});

test("there is no way to call user code", () => {
  // The grammar has no lambda, no method call, and a closed builtin list — so an
  // expression cannot reach anything the compiler has not already reasoned about.
  assert.throws(() => parseExpr("foo.bar()"), /expected/);
  assert.throws(() => parseExpr("(() => 1)()"), /unexpected character|expected/);
});

// ── evaluation is total ──────────────────────────────────────────────────────

test("missing channels evaluate to undefined, never a throw", () => {
  assert.equal(ev("missing"), undefined);
  assert.equal(ev("missing.deep.path"), undefined);
  assert.equal(ev("missing[3]"), undefined);
  assert.equal(ev("missing == null"), true);
});

test("routing on incomplete state yields false rather than crashing", () => {
  // The graph must be able to decide what happens next; it cannot do that from
  // inside an exception.
  assert.equal(ev("verdict.score < 0.7", {}), false);
  assert.equal(ev("len(findings) > 0", {}), false);
});

test("division and modulo by zero yield absence, not Infinity", () => {
  // Infinity is not representable in the canonical form, and propagating absence
  // is the same rule used everywhere else here.
  assert.equal(ev("1 / 0"), undefined);
  assert.equal(ev("1 % 0"), undefined);
});

test("arithmetic propagates absence", () => {
  assert.equal(ev("missing + 1"), undefined);
  assert.equal(ev("1 * missing"), undefined);
  assert.equal(ev("-missing"), undefined);
});

test("ordering comparisons involving an absent value are FALSE, both ways", () => {
  // The bug this pins: coercing absence to 0 made `score < 0.7` true before
  // anything wrote `score`, so a run routed on a fabricated number.
  assert.equal(ev("missing < 0.7"), false);
  assert.equal(ev("missing > 0.7"), false);
  assert.equal(ev("missing <= 0.7"), false);
  assert.equal(ev("missing >= 0.7"), false);
  assert.equal(ev("0.7 < missing"), false);
  assert.equal(ev("0.7 > missing"), false);
});

test("the presence idiom works and short-circuits", () => {
  assert.equal(ev("has(v) && v.score < 0.7", {}), false);
  assert.equal(ev("has(v) && v.score < 0.7", { v: { score: 0.5 } }), true);
  assert.equal(ev("has(v) && v.score < 0.7", { v: { score: 0.9 } }), false);
});

test("truthiness is strict — only `true` is true", () => {
  // No "" / 0 / [] coercion: implicit truthiness is where routing bugs hide.
  assert.equal(ev("!x", { x: 1 }), true);
  assert.equal(ev("x && true", { x: 1 }), false);
  assert.equal(ev("x || false", { x: "non-empty" }), false);
});

test("&& and || short-circuit", () => {
  const scope = { v: null };
  assert.equal(ev("has(v) && v.field == 1", scope), false, "right side must not be reached");
  assert.equal(ev("true || missing.deep", scope), true);
});

test("builtins behave as documented", () => {
  assert.equal(ev("len(findings)", { findings: [1, 2, 3] }), 3);
  assert.equal(ev('len("abc")'), 3);
  assert.equal(ev("has(v)", { v: 0 }), true);
  assert.equal(ev("has(v)", { v: null }), false);
  assert.equal(ev("has(v)", {}), false);
  assert.equal(ev("all(flags)", { flags: [true, true] }), true);
  assert.equal(ev("all(flags)", { flags: [] }), true, "vacuously true");
  assert.equal(ev("any(flags)", { flags: [] }), false, "vacuously false");
  assert.equal(ev("any(flags)", { flags: [false, true] }), true);
  assert.equal(ev("contains(xs, 2)", { xs: [1, 2] }), true);
  assert.equal(ev('contains(s, "ell")', { s: "hello" }), true);
});

test("null and undefined compare equal to each other", () => {
  assert.equal(ev("a == b", { a: null }), true, "undefined == null");
  assert.equal(ev("a != b", { a: null, b: 1 }), true);
});

test("string comparison is lexicographic; mixed types coerce to 0", () => {
  assert.equal(ev('"a" < "b"'), true);
  assert.equal(ev('"b" < "a"'), false);
});

// ── static analysis ──────────────────────────────────────────────────────────

test("referencedChannels collects only root identifiers", () => {
  assert.deepEqual([...referencedChannels(parseExpr("verdict.score < 0.7"))].sort(), ["verdict"]);
  assert.deepEqual(
    [...referencedChannels(parseExpr("len(findings) > 0 && verdict.pass"))].sort(),
    ["findings", "verdict"],
  );
  assert.deepEqual([...referencedChannels(parseExpr("xs[i]"))].sort(), ["i", "xs"]);
});

test("checkExpr accepts well-typed boolean expressions", () => {
  const r = checkExpr("verdict.pass || len(applied) >= 3", CH);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([...r.refs].sort(), ["applied", "verdict"]);
});

test("checkExpr rejects an unknown channel — this is GRAPH004's teeth", () => {
  const r = checkExpr("nosuch > 1", CH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0]!, /unknown channel "nosuch"/);
});

test("checkExpr rejects a non-boolean result", () => {
  const r = checkExpr("score + 1", CH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors.join(" "), /must evaluate to a boolean, got number/);
});

test("checkExpr catches type mismatches on known scalars", () => {
  const cases: [string, RegExp][] = [
    ["score && ready", /left operand of && must be boolean, got number/],
    ["name > 1", /must be number, got string/],
    ["-name", /operand of unary - must be number, got string/],
    ["!score", /operand of ! must be boolean, got number/],
    ["len(score) > 0", /len\(\) takes an array or string, got number/],
    ["score == name", /cannot compare number to string/],
    ["score.field == 1", /cannot read property "field" of a number/],
    ["findings[name]", /array index must be a number, got string/],
  ];
  for (const [src, re] of cases) {
    const r = checkExpr(src, CH);
    assert.equal(r.ok, false, `${src} should not typecheck`);
    if (!r.ok) assert.match(r.errors.join(" | "), re, src);
  }
});

test("checkExpr collects ALL type errors, not just the first", () => {
  const r = checkExpr("score && name", CH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errors.length, 2, "both operands reported");
});

test("member access on an object yields unknown and stays permissive", () => {
  // Channel schemas are JSON Schema; deep structural typing is deliberately
  // best-effort. The exact check that matters is "is this channel declared?".
  assert.equal(checkExpr("verdict.anything == 1", CH).ok, true);
  assert.equal(checkExpr("verdict.a.b.c", CH).ok, true);
});

test("comparing anything to null is always allowed", () => {
  assert.equal(checkExpr("name == null", CH).ok, true);
  assert.equal(checkExpr("score != null", CH).ok, true);
});

test("string concatenation typechecks, mixed +ary does not", () => {
  assert.equal(checkExpr('name + "x" == "ax"', CH).ok, true);
  const r = checkExpr('score + "x" == "1x"', CH);
  assert.equal(r.ok, false);
});

test("parse errors surface through checkExpr as diagnostics, not exceptions", () => {
  const r = checkExpr("1 +", CH);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0]!, /expected a value/);
});

/**
 * `BUILTINS[name].returns` is exported public data — `scripts/surface.json` pins `BUILTINS` —
 * and until this test it was read by NOTHING: `grep -a '\.returns' packages/core/src` came back
 * empty. The real answer lived twice over in code that never consults the table. `inferType`
 * hard-codes `return "number"` / `return "boolean"` per case, and `evalCall` produces the value.
 * So a consumer branching on `.returns` was right by luck, and editing the table alone would
 * have changed nothing, broken nothing, and made the published field a lie.
 *
 * The sample table is keyed by `BuiltinName` on purpose: a sixth builtin fails to COMPILE until
 * somebody supplies a call for it. That matters beyond this test, because the two switches are
 * not equally protected — `evalCall` has no `break` and `noImplicitReturns` fails the build when
 * it stops being exhaustive (verified by adding a probe builtin: `TS7030`), while `inferType`
 * falls through its `break` and would quietly widen the new builtin to `unknown`. This is what
 * would catch that.
 */
const CALLS: Record<BuiltinName, { readonly src: string; readonly scope: Record<string, unknown> }> = {
  len: { src: "len(findings)", scope: { findings: [1, 2, 3] } },
  has: { src: "has(verdict)", scope: { verdict: { pass: true } } },
  all: { src: "all(applied)", scope: { applied: [true, true] } },
  any: { src: "any(applied)", scope: { applied: [false, true] } },
  contains: { src: "contains(findings, 2)", scope: { findings: [1, 2, 3] } },
};

test("EVERY BUILTIN RETURNS WHAT `BUILTINS` SAYS IT RETURNS — statically and at run time", () => {
  const names = Object.keys(BUILTINS) as BuiltinName[];
  assert.equal(names.length, 5, "a builtin was added or removed — supply its call above, and check BOTH switches");

  for (const name of names) {
    const { src, scope } = CALLS[name];
    const declared = BUILTINS[name].returns;

    const errors: ExprTypeError[] = [];
    const inferred = inferType(parseExpr(src), CH, errors);
    assert.deepEqual(errors, [], `${src} should type-check cleanly against CH`);
    assert.equal(inferred, declared, `${name}(): inferType says ${inferred}, BUILTINS says ${declared}`);

    // And the value itself, because a consumer reading `.returns` is predicting THIS.
    assert.equal(typeof evaluateSource(src, scope), declared, `${name}(): the runtime value must match too`);
  }
});
