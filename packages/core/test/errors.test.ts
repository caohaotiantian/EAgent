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

// ── the boundary is TOTAL, which is a property of this function ──────────────

test("toLoomError SURVIVES A VALUE THAT REFUSES TO BECOME A STRING", () => {
  // Every read here used to be bare, on a function whose whole job is to make a boundary
  // safe and whose arguments come from injected code — tool executors, model adapters,
  // delivery channels, `ControlPlane`'s own catch. `String(Object.create(null))` throws
  // `TypeError: Cannot convert object to primitive value`, and so does any value with a
  // throwing `toString` or `Symbol.toPrimitive`.
  const hostile: readonly unknown[] = [
    Object.create(null),
    { toString(): string { throw new Error("toString bomb"); } },
    { [Symbol.toPrimitive](): string { throw new Error("toPrimitive bomb"); } },
    Object.defineProperty(new Error("x"), "message", { get(): string { throw new Error("message getter"); } }),
    Object.defineProperty(new Error("x"), "name", { get(): string { throw new Error("name getter"); } }),
    Symbol("nope"),
    0n,
  ];
  for (const v of hostile) {
    const le = toLoomError(v);
    assert.ok(isLoomError(le), `${String(le)} is not a LoomError`);
    assert.equal(typeof le.message, "string");
    assert.equal(le.class, "internal");
    // …and the value it could not read is still reachable for a human reading a log.
    assert.equal(le.cause, v);
  }
});

test("`instanceof` PROVES A PROTOTYPE, NOT PROVENANCE — a forged LoomError is rebuilt, not passed on", () => {
  // `isLoomError` is an `instanceof`, so a value built on `LoomError.prototype` with
  // throwing accessors was a `LoomError` to every check in the codebase and was returned
  // UNCHANGED — traps intact — to detonate one layer out, inside `toJSON` on the HTTP path.
  const forged = (field: string): unknown =>
    Object.create(LoomError.prototype, {
      class: field === "class" ? { get(): string { throw new Error("class trap"); } } : { value: "policy" },
      code: field === "code" ? { get(): string { throw new Error("code trap"); } } : { value: CODES.E_CAP_DENIED },
      message: field === "message" ? { get(): string { throw new Error("message trap"); } } : { value: "denied" },
      details: field === "details" ? { get(): unknown { throw new Error("details trap"); } } : { value: { a: 1 } },
    });

  for (const field of ["class", "code", "message", "details"]) {
    const le = toLoomError(forged(field));
    assert.ok(isLoomError(le));
    // Reading it is now safe — this is the read that used to throw.
    const json = le.toJSON();
    assert.equal(typeof json["message"], "string");
    assert.equal(typeof httpStatusFor(le), "number");

    // …AND `toJSON` IS TOTAL IN ITS OWN RIGHT, asked of the forged value DIRECTLY. The loop
    // above only proves `toLoomError` hands back something safe; `toJSON` is a public method
    // on a prototype anyone can `Object.create`, and `JSON.stringify` finds it without going
    // through `toLoomError` at all — which is how the trapped value reached it in the first
    // place, on the HTTP path.
    const raw = forged(field) as LoomError;
    const direct = LoomError.prototype.toJSON.call(raw);
    assert.equal(typeof direct, "object", `toJSON threw on a forged ${field}`);
    assert.equal(JSON.stringify(direct) === undefined, false);
  }

  // A class in NO vocabulary is not carried forward, because `class` is the one field
  // generic machinery branches on — `httpStatusFor` returned `undefined` for it, and that
  // is what `#dispatch` writes into a response status.
  const wrongClass = Object.create(LoomError.prototype, {
    class: { value: "totally-made-up" },
    code: { value: "E_MADE_UP" },
    message: { value: "hi" },
  }) as LoomError;
  const fixed = toLoomError(wrongClass);
  assert.equal(fixed.class, "internal", "a class in no vocabulary was carried forward");
  assert.equal(fixed.code, "E_MADE_UP", "…while the code, which control flow branches on, survives");
  assert.equal(httpStatusFor(wrongClass), 500, "and the status map has a floor rather than a hole");
});

test("A GENUINE LoomError IS STILL PASSED THROUGH BY IDENTITY", () => {
  // Rebuilding every error would cost `cause` and `stack` on the ordinary path, and callers
  // compare `code` after re-throwing. The check above is what makes passing it on safe.
  for (const real of [
    err.policy(CODES.E_CAP_DENIED, "denied", { details: { capability: "fs:write" } }),
    err.cancelled(),
    err.exhausted(CODES.E_BUDGET_EXHAUSTED, "over", { retryAfterMs: 5000 }),
    err.internal(CODES.E_INTERNAL, "boom", { cause: new Error("root") }),
  ]) {
    assert.equal(toLoomError(real), real, `${real.code} was rebuilt instead of passed through`);
  }
});
