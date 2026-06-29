import assert from "node:assert/strict";
import { test } from "node:test";

import { validate } from "../src/kernel/validate.js";
import type { JSONSchema } from "../src/kernel/types.js";

test("coerces numeric strings and reports missing required fields", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      name: { type: "string" },
    },
    required: ["count", "name"],
  };
  const r = validate(schema, { count: "3" });
  assert.equal((r.value as { count: number }).count, 3);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /name: required/);
});

test("accepts valid input and applies defaults", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      replaceAll: { type: "boolean", default: false },
      mode: { type: "string", enum: ["a", "b"] },
    },
    required: ["mode"],
  };
  const r = validate(schema, { mode: "a" });
  assert.ok(r.ok, r.errors.join());
  assert.equal((r.value as { replaceAll: boolean }).replaceAll, false);
});

test("rejects values outside an enum", () => {
  const schema: JSONSchema = { type: "string", enum: ["x", "y"] };
  const r = validate(schema, "z");
  assert.equal(r.ok, false);
});

test("validates arrays of items", () => {
  const schema: JSONSchema = { type: "array", items: { type: "integer" } };
  const r = validate(schema, ["1", 2, "3"]);
  assert.ok(r.ok, r.errors.join());
  assert.deepEqual(r.value, [1, 2, 3]);
});

test("preserves unknown object properties instead of dropping them", () => {
  const schema: JSONSchema = { type: "object", properties: { a: { type: "string" } } };
  const r = validate(schema, { a: "hi", extra: 42 });
  assert.deepEqual(r.value, { a: "hi", extra: 42 });
});

test("additionalProperties:false rejects extra keys; omitting it keeps preserving them", () => {
  const closed: JSONSchema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  const rejected = validate(closed, { a: "hi", b: 1 });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(), /\bb\b/);

  // The SAME schema without additionalProperties preserves the extra key.
  const open: JSONSchema = { type: "object", properties: { a: { type: "string" } } };
  const preserved = validate(open, { a: "hi", b: 1 });
  assert.ok(preserved.ok, preserved.errors.join());
  assert.deepEqual(preserved.value, { a: "hi", b: 1 });
});

test("enforces numeric minimum/maximum only when declared", () => {
  const max: JSONSchema = { type: "number", maximum: 10 };
  assert.equal(validate(max, 11).ok, false);
  assert.ok(validate(max, 9).ok);

  const min: JSONSchema = { type: "number", minimum: 0 };
  assert.equal(validate(min, -1).ok, false);
  assert.ok(validate(min, 0).ok);
});

test("enforces string minLength/maxLength/pattern only when declared", () => {
  assert.equal(validate({ type: "string", minLength: 2 }, "a").ok, false);
  assert.ok(validate({ type: "string", minLength: 2 }, "ab").ok);

  assert.equal(validate({ type: "string", maxLength: 3 }, "abcd").ok, false);
  assert.ok(validate({ type: "string", maxLength: 3 }, "abc").ok);

  const pat: JSONSchema = { type: "string", pattern: "^x" };
  assert.equal(validate(pat, "yz").ok, false);
  assert.ok(validate(pat, "xy").ok);
});

test("numeric enum coerces a wire string before the membership check", () => {
  const schema: JSONSchema = { type: "integer", enum: [1, 2, 3] };
  const r = validate(schema, "2");
  assert.ok(r.ok, r.errors.join());
  assert.equal(r.value, 2);
});
