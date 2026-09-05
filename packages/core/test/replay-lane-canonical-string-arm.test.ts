/**
 * The string arm of `canonicalize` refuses an over-long leaf with the typed bound, and refuses it
 * BEFORE `JSON.stringify` has built the quoted copy.
 *
 * The container and output bounds were both in place and this one leaf still escaped them:
 * `spend` charges what it is handed, and it was handed the output of `JSON.stringify`, so the
 * allocation that overflowed came first and the refusal never ran. Measured at 95a3dde,
 * `canonicalize("\n".repeat(300_000_000))` → `RangeError: Invalid string length`, `code` undefined,
 * 702 ms. `fs.read` reads a whole file as UTF-8 before slicing to `maxBytes`, so the leaf is
 * reachable from a tool result on the durable write path.
 *
 * `\u0001` is the worst escape JSON has — six characters for one — so 90 M of them quote to
 * ~540 M characters, past V8's 536,870,888 limit: the input that distinguishes "refused before
 * quoting" from "refused after". A plain 64 MiB + 1 leaf does not; `spend` already refused that.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalize } from "../src/canonical.ts";
import { CODES, isLoomError } from "../src/errors.ts";

test("an escape-heavy leaf past the output bound is a typed refusal, not a RangeError out of JSON.stringify", () => {
  const leaf = "\u0001".repeat(90_000_000);
  const started = Date.now();
  try {
    canonicalize(leaf);
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(isLoomError(e), `a bare ${(e as Error).name} is the failure this replaces`);
    assert.equal(e.code, CODES.E_PAYLOAD_TOO_LARGE);
    assert.equal(e.class, "validation");
    assert.match(e.message, /emits over 90000000 characters/);
  }
  // Absolute, with an order-of-magnitude margin: the point is that nothing was quoted first.
  assert.ok(Date.now() - started < 3000);
});

test("the same leaf as an object KEY is refused the same way", () => {
  const record: Record<string, unknown> = {};
  record["\u0001".repeat(90_000_000)] = 1;
  try {
    canonicalize(record);
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(isLoomError(e), `a bare ${(e as Error).name} is the failure this replaces`);
    assert.equal(e.code, CODES.E_PAYLOAD_TOO_LARGE);
  }
});

test("ORDINARY HALF — an escape-heavy leaf inside the bound quotes as before", () => {
  // 1 M control characters quote to 6 M + 2, comfortably inside 64 MiB; the bytes must be the
  // bytes `JSON.stringify` produced, or every digest over such a value moves.
  const leaf = "\u0001".repeat(1_000_000);
  assert.equal(canonicalize(leaf), JSON.stringify(leaf));
  assert.equal(canonicalize({ k: leaf }), `{"k":${JSON.stringify(leaf)}}`);
});
