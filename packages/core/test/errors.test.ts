import test from "node:test";
import assert from "node:assert/strict";

import { CODES, LoomError, err, httpStatusFor, isLoomError, toLoomError } from "../src/errors.ts";

test("retryable is derived from class, never set by hand", () => {
  assert.ok(err.unavailable(CODES.E_PROVIDER_OVERLOADED, "x").retryable);
  assert.ok(err.exhausted(CODES.E_PROVIDER_RATE_LIMIT, "x").retryable);
  assert.ok(err.timeout(CODES.E_TOOL_TIMEOUT, "x").retryable);

  assert.ok(!err.validation(CODES.E_GRAPH_INVALID, "x").retryable);
  assert.ok(!err.policy(CODES.E_CAP_DENIED, "x").retryable);
  assert.ok(!err.conflict(CODES.E_SEQ_CONFLICT, "x").retryable);
  assert.ok(!err.cancelled().retryable);
  assert.ok(!err.internal(CODES.E_INTERNAL, "x").retryable);
});

test("toJSON is safe to journal: no stack, no cause chain", () => {
  const e = err.exhausted(CODES.E_BUDGET_EXHAUSTED, "over budget", {
    retryAfterMs: 5000,
    details: { spent: 12.5 },
    cause: new Error("inner with a stack"),
  });
  const json = e.toJSON();
  assert.deepEqual(json, {
    class: "exhausted",
    code: "E_BUDGET_EXHAUSTED",
    message: "over budget",
    retryable: true,
    retryAfterMs: 5000,
    details: { spent: 12.5 },
  });
  assert.ok(!("stack" in json));
  assert.ok(!("cause" in json));
});

test("toLoomError passes LoomErrors through untouched", () => {
  const original = err.policy(CODES.E_CAP_DENIED, "nope");
  assert.equal(toLoomError(original), original);
});

test("toLoomError maps AbortError to the cancelled class", () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  const e = toLoomError(abort);
  assert.equal(e.class, "cancelled");
  assert.equal(e.code, CODES.E_CANCELLED);
});

test("toLoomError normalizes anything thrown", () => {
  assert.equal(toLoomError("a string").class, "internal");
  assert.equal(toLoomError(new TypeError("bad")).message, "TypeError: bad");
  assert.ok(isLoomError(toLoomError(null)));
});

test("http status is class-driven, not code-driven", () => {
  assert.equal(httpStatusFor(err.validation(CODES.E_GRAPH_INVALID, "")), 400);
  assert.equal(httpStatusFor(err.policy(CODES.E_CAP_DENIED, "")), 403);
  assert.equal(httpStatusFor(err.notFound(CODES.E_RUN_NOT_FOUND, "")), 404);
  assert.equal(httpStatusFor(err.conflict(CODES.E_IDEMPOTENCY_MISMATCH, "")), 409);
  assert.equal(httpStatusFor(err.exhausted(CODES.E_ADMISSION_REJECTED, "")), 429);
  assert.equal(httpStatusFor(err.unavailable(CODES.E_SECRET_UNAVAILABLE, "")), 503);
  assert.equal(httpStatusFor(err.timeout(CODES.E_TOOL_TIMEOUT, "")), 504);
  assert.equal(httpStatusFor(err.internal(CODES.E_INTERNAL, "")), 500);
});

test("every canonical code is unique", () => {
  const values = Object.values(CODES);
  assert.equal(new Set(values).size, values.length);
});

test("code keys and values match, so a typo cannot alias two codes", () => {
  for (const [key, value] of Object.entries(CODES)) assert.equal(key, value);
});

test("LoomError is an Error and keeps its cause for logging", () => {
  const cause = new Error("root");
  const e = new LoomError("internal", CODES.E_INTERNAL, "wrapped", { cause });
  assert.ok(e instanceof Error);
  assert.equal(e.cause, cause);
  assert.equal(e.name, "LoomError");
});
