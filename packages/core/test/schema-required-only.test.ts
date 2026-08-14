/**
 * `required` without `properties` constrains presence, not shape.
 *
 * The object branch drops undeclared keys on purpose — a model adding a stray field
 * should not fail a tool call, but it must not reach the tool either. That rule assumes a
 * DECLARED shape. A schema carrying only `required` declares none, so treating it as a
 * declaration made every key undeclared and silently returned the empty object for an
 * input that satisfied the schema.
 *
 * This shape is legal JSON Schema and `validate` sits on both sides of the tool guard
 * chain, so the failure was: arguments satisfy the schema, validation reports no error,
 * and the tool receives nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { validate } from "../src/schema.ts";

test("a schema with `required` and no `properties` keeps the value it validated", () => {
  const r = validate({ type: "object", required: ["a"] }, { a: 1, b: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok ? r.value : undefined, { a: 1, b: 2 }, "presence is constrained; shape is not");
});

test("...and still enforces the requirement it does declare", () => {
  const r = validate({ type: "object", required: ["a"] }, { b: 2 });
  assert.equal(r.ok, false);
  assert.ok(
    !r.ok && r.errors.some((e) => e.includes("required")),
    `expected a "required" error, got ${JSON.stringify(r.ok ? [] : r.errors)}`,
  );
});

test("`additionalProperties: false` with only `required` still refuses strays", () => {
  const r = validate({ type: "object", required: ["a"], additionalProperties: false }, { a: 1, b: 2 });
  assert.equal(r.ok, false, "an explicitly closed schema stays closed");
});

test("a declared shape still drops undeclared keys — the old rule is intact", () => {
  const r = validate({ type: "object", properties: { a: { type: "number" } } }, { a: 1, b: 2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok ? r.value : undefined, { a: 1 }, "a stray field must not reach the tool");
});
