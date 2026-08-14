/**
 * The tool guard chain validates arguments here before dispatch and again after
 * policy, so a hole in this file is a hole in every tool call. These tests are
 * written from the refusing side: the inputs that must not pass, the prototype
 * member names a hand-rolled validator mistakes for data, and the malformed
 * schemas that must yield an error rather than an exception or a shrug.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validate, type JSONSchema } from "../src/schema.ts";

/** A schema the type system would reject but a parsed manifest can carry. */
const raw = (s: unknown): JSONSchema => s as JSONSchema;

const why = (r: ReturnType<typeof validate>): string => (r.ok ? "" : r.errors.join("\n"));

// ── a schema with no `type` is still a schema ────────────────────────────────

test("properties and required are enforced when `type` is left off", () => {
  const schema: JSONSchema = { properties: { path: { type: "string" } }, required: ["path"] };

  const missing = validate(schema, { evil: 1 });
  assert.equal(missing.ok, false, "an object missing a required property must not pass");
  assert.match(why(missing), /value\.path is required/);

  const wrongType = validate(schema, { path: 3 });
  assert.equal(wrongType.ok, false, "a declared property type must be checked");
  assert.match(why(wrongType), /value\.path must be a string/);
});

test("a shape-declaring schema with no `type` refuses a non-object", () => {
  const schema: JSONSchema = { properties: { path: { type: "string" } }, required: ["path"] };
  const r = validate(schema, "not an object");
  assert.equal(r.ok, false);
  assert.match(why(r), /value must be an object/);
});

test("`required` alone, with no properties, is still enforced", () => {
  const r = validate({ type: "object", required: ["path"] }, {});
  assert.equal(r.ok, false);
  assert.match(why(r), /value\.path is required/);
});

test("items with no `type` still checks the elements", () => {
  const schema: JSONSchema = { items: { type: "number" } };

  const bad = validate(schema, ["a"]);
  assert.equal(bad.ok, false);
  assert.match(why(bad), /value\[0\] must be a number/);

  const notAnArray = validate(schema, { length: 1 });
  assert.equal(notAnArray.ok, false);
  assert.match(why(notAnArray), /value must be an array/);

  const good = validate(schema, [1, 2]);
  assert.equal(good.ok, true);
});

test("a schema that constrains nothing accepts anything", () => {
  for (const v of [42, "s", null, [1], { a: 1 }, true]) {
    const r = validate({ description: "free-form" }, v);
    assert.equal(r.ok, true, `${JSON.stringify(v)} should pass a constraint-free schema`);
    if (r.ok) assert.deepEqual(r.value, v);
  }
});

// ── the value that comes back is not the value that went in ──────────────────

test("a bare {type:'object'} schema returns a copy, not the caller's object", () => {
  const input: Record<string, unknown> = { a: 1, nested: { b: 2 } };
  const r = validate({ type: "object" }, input);
  assert.equal(r.ok, true);
  if (!r.ok) return;

  assert.deepEqual(r.value, { a: 1, nested: { b: 2 } }, "every key still passes through");
  assert.notEqual(r.value, input, "an aliased result lets a later mutation slip past re-validation");

  input["a"] = "rewritten";
  (input["nested"] as Record<string, unknown>)["b"] = "rewritten";
  assert.deepEqual(r.value, { a: 1, nested: { b: 2 } }, "the copy must be deep enough to survive a rewrite");
});

test("a declared shape also returns a fresh object", () => {
  const input = { a: "x" };
  const r = validate({ type: "object", properties: { a: { type: "string" } } }, input);
  assert.equal(r.ok, true);
  if (r.ok) assert.notEqual(r.value, input);
});

// ── __proto__ is never data ──────────────────────────────────────────────────

test("an own __proto__ key is refused by a bare object schema", () => {
  const input = JSON.parse('{"__proto__":{"admin":true},"a":1}') as unknown;
  const r = validate({ type: "object" }, input);
  assert.equal(r.ok, false, "__proto__ must not ride through a pass-through schema");
  assert.match(why(r), /__proto__/);
  assert.equal(({} as Record<string, unknown>)["admin"], undefined, "Object.prototype must be untouched");
});

test("an own __proto__ key is refused under a declared shape, not silently dropped", () => {
  const input = JSON.parse('{"a":"x","__proto__":{"admin":true}}') as unknown;
  const r = validate({ type: "object", properties: { a: { type: "string" } } }, input);
  assert.equal(r.ok, false);
  assert.match(why(r), /__proto__/);
});

test("a nested __proto__ key is refused too", () => {
  const input = JSON.parse('{"outer":{"__proto__":{"admin":true}}}') as unknown;
  const r = validate({ type: "object" }, input);
  assert.equal(r.ok, false);
  assert.match(why(r), /outer\.__proto__/);
});

test("a __proto__ inside an array element is refused", () => {
  const input = JSON.parse('[{"__proto__":{"admin":true}}]') as unknown;
  const r = validate({ type: "array", items: { type: "object" } }, input);
  assert.equal(r.ok, false);
  assert.match(why(r), /__proto__/);
});

test("a schema declaring a __proto__ property cannot re-parent the result", () => {
  const schema = raw(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object"}}}'));
  const r = validate(schema, JSON.parse('{"__proto__":{"admin":true}}') as unknown);
  assert.equal(r.ok, false, "a declared property named __proto__ is a schema this file refuses");
  assert.match(why(r), /__proto__/);

  // A default is the other route to writing that key, with no input at all.
  const defaulted = raw(JSON.parse('{"type":"object","properties":{"__proto__":{"default":{"admin":true}}}}'));
  const d = validate(defaulted, {});
  assert.equal(d.ok, false, "a default cannot smuggle the key in either");
  assert.match(why(d), /__proto__/);
});

// ── prototype member names are properties, not membership ────────────────────

test("additionalProperties:false rejects a stray named after a prototype member", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  const r = validate(schema, { a: "x", constructor: 1 });
  assert.equal(r.ok, false, "a stray key must be reported, not quietly dropped");
  assert.match(why(r), /value\.constructor is not a permitted property/);
});

test("additionalProperties:true keeps an argument named after a prototype member", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: true,
  };
  const r = validate(schema, { a: "x", toString: "legit", valueOf: 2 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const out = r.value as Record<string, unknown>;
  assert.ok(Object.hasOwn(out, "toString"), "a legitimate argument must not be deleted");
  assert.equal(out["toString"], "legit");
  assert.equal(out["valueOf"], 2);
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "carrying a key through must not re-parent the result");
});

test("required is checked against own keys only", () => {
  const r = validate({ type: "object", properties: { a: { type: "string" } }, required: ["a", "constructor"] }, { a: "x" });
  assert.equal(r.ok, false, "an absent property is absent even when Object.prototype has that name");
  assert.match(why(r), /value\.constructor is required/);
});

test("a declared property absent from the input is not read off the prototype", () => {
  const stringy: JSONSchema = { type: "string" };
  const r = validate({ type: "object", properties: { toString: stringy } }, {});
  assert.equal(r.ok, true, why(r));
  if (r.ok) assert.deepEqual(r.value, {}, "an optional property that is not there is simply not there");
});

test("a null-prototype input validates like any other object", () => {
  const input = Object.create(null) as Record<string, unknown>;
  input["a"] = "x";
  input["stray"] = 1;

  const ok = validate({ type: "object", properties: { a: { type: "string" } } }, input);
  assert.equal(ok.ok, true, why(ok));
  if (ok.ok) assert.deepEqual(ok.value, { a: "x" });

  const strict = validate(
    { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
    input,
  );
  assert.equal(strict.ok, false);
  assert.match(why(strict), /value\.stray is not a permitted property/);
});

// ── the ordinary types ───────────────────────────────────────────────────────

test("scalars are checked and the sanctioned coercion is the only one", () => {
  assert.equal(validate({ type: "string" }, "s").ok, true);
  assert.equal(validate({ type: "string" }, 1).ok, false);
  assert.equal(validate({ type: "boolean" }, true).ok, true);
  assert.equal(validate({ type: "boolean" }, "true").ok, false);
  assert.equal(validate({ type: "null" }, null).ok, true);
  assert.equal(validate({ type: "null" }, 0).ok, false);

  const coerced = validate({ type: "number" }, "3");
  assert.equal(coerced.ok, true);
  if (coerced.ok) assert.equal(coerced.value, 3);

  assert.equal(validate({ type: "integer" }, "3.5").ok, false);
  assert.equal(validate({ type: "integer" }, 3.5).ok, false);
  assert.equal(validate({ type: "number" }, true).ok, false, "a boolean is not a number");
  assert.equal(validate({ type: "number" }, "  ").ok, false, "blank is not zero");
  assert.equal(validate({ type: "number" }, []).ok, false);
});

test("NaN and Infinity are not numbers", () => {
  assert.equal(validate({ type: "number" }, NaN).ok, false);
  assert.equal(validate({ type: "number" }, Infinity).ok, false);
  assert.equal(validate({ type: "number" }, -Infinity).ok, false);
  assert.equal(validate({ type: "number" }, "NaN").ok, false);
  assert.equal(validate({ type: "number" }, "Infinity").ok, false);
  assert.equal(validate({ type: "number" }, "1e999").ok, false, "a string that coerces to Infinity is not finite");
});

test("bounds are enforced on strings, numbers and arrays", () => {
  assert.equal(validate({ type: "string", minLength: 2 }, "a").ok, false);
  assert.equal(validate({ type: "string", maxLength: 2 }, "abc").ok, false);
  assert.equal(validate({ type: "number", minimum: 0 }, -1).ok, false);
  assert.equal(validate({ type: "number", maximum: 1 }, 2).ok, false);
  assert.equal(validate({ type: "array", minItems: 2 }, [1]).ok, false);
  assert.equal(validate({ type: "array", maxItems: 1 }, [1, 2]).ok, false);
});

test("enum admits its members and nothing else", () => {
  assert.equal(validate({ enum: ["a", "b"] }, "a").ok, true);
  const r = validate({ enum: ["a", "b"] }, "c");
  assert.equal(r.ok, false);
  assert.match(why(r), /must be one of "a", "b"/);
});

test("defaults are filled in, and satisfy required", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: { path: { type: "string" }, maxBytes: { type: "integer", default: 200 } },
    required: ["path", "maxBytes"],
  };
  const r = validate(schema, { path: "p" });
  assert.equal(r.ok, true, why(r));
  if (r.ok) assert.deepEqual(r.value, { path: "p", maxBytes: 200 });
});

test("nested objects and arrays are checked all the way down", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      pods: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    },
    required: ["pods"],
  };

  const ok = validate(schema, { pods: [{ name: "a" }, { name: "b", stray: 1 }] });
  assert.equal(ok.ok, true, why(ok));
  if (ok.ok) assert.deepEqual(ok.value, { pods: [{ name: "a" }, { name: "b" }] });

  const bad = validate(schema, { pods: [{ name: "a" }, { name: 2 }] });
  assert.equal(bad.ok, false);
  assert.match(why(bad), /value\.pods\[1\]\.name must be a string/);
});

test("an array where an object is asked for, and the reverse, are both refused", () => {
  const asObject = validate({ type: "object", properties: { a: { type: "string" } } }, ["a"]);
  assert.equal(asObject.ok, false);
  assert.match(why(asObject), /value must be an object/);

  const asArray = validate({ type: "array", items: { type: "string" } }, { 0: "a", length: 1 });
  assert.equal(asArray.ok, false);
  assert.match(why(asArray), /value must be an array/);

  assert.equal(validate({ type: "object" }, null).ok, false, "null is not an object here");
});

// ── a schema this file cannot understand must not become a shrug ─────────────

test("an unrecognised `type` is an error, not a pass", () => {
  const r = validate(raw({ type: "strig" }), { anything: true });
  assert.equal(r.ok, false, "a type this validator cannot check must not be treated as no constraint");
  assert.match(why(r), /unsupported/);

  const union = validate(raw({ type: ["string", "null"] }), 1);
  assert.equal(union.ok, false);
});

test("a schema that is not an object is refused, not thrown on", () => {
  for (const s of [null, undefined, "string", 42, ["a"], true]) {
    const r = validate(raw(s), { a: 1 });
    assert.equal(r.ok, false, `${JSON.stringify(s)} is not a schema`);
    assert.match(why(r), /schema/);
  }
});

test("a malformed sub-schema is refused where it sits", () => {
  const r = validate(raw({ type: "object", properties: { a: "nope" } }), { a: 1 });
  assert.equal(r.ok, false);
  assert.match(why(r), /value\.a/);
});

test("malformed keywords produce an error instead of an exception", () => {
  const badEnum = validate(raw({ enum: "a" }), "a");
  assert.equal(badEnum.ok, false);
  assert.match(why(badEnum), /enum/);

  const badRequired = validate(raw({ type: "object", required: "path" }), {});
  assert.equal(badRequired.ok, false);
  assert.match(why(badRequired), /required/);

  const badProperties = validate(raw({ type: "object", properties: "path" }), { a: 1 });
  assert.equal(badProperties.ok, false);
  assert.match(why(badProperties), /properties/);

  const badItems = validate(raw({ type: "array", items: 7 }), [1]);
  assert.equal(badItems.ok, false);
  assert.match(why(badItems), /value\[0\]/);
});
