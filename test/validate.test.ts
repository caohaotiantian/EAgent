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
