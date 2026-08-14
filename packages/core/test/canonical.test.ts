import test from "node:test";
import assert from "node:assert/strict";

import { CanonicalizationError, canonicalize, digest, frozenClone, sameContent } from "../src/canonical.ts";

test("object key order does not affect the canonical form", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("nested key order does not affect the canonical form", () => {
  const x = { outer: { z: [{ b: 1, a: 2 }], y: 3 } };
  const y = { outer: { y: 3, z: [{ a: 2, b: 1 }] } };
  assert.equal(digest(x), digest(y));
});

test("array order DOES affect the canonical form", () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test("undefined object properties are omitted, matching JSON semantics", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(digest({ a: 1 }), digest({ a: 1, b: undefined }));
});

test("-0 normalizes to 0 so two equal numbers hash the same", () => {
  assert.equal(canonicalize(-0), "0");
  assert.equal(digest({ v: -0 }), digest({ v: 0 }));
});

test("ambiguous values are rejected, not coerced", () => {
  // JSON.stringify would turn each of these into null or drop it, which would make
  // two materially different values share a hash.
  assert.throws(() => canonicalize([1, undefined, 2]), CanonicalizationError);
  assert.throws(() => canonicalize(NaN), CanonicalizationError);
  assert.throws(() => canonicalize(Infinity), CanonicalizationError);
  assert.throws(() => canonicalize(new Date(0)), CanonicalizationError);
  assert.throws(() => canonicalize(new Map()), CanonicalizationError);
  assert.throws(() => canonicalize(new Set()), CanonicalizationError);
  assert.throws(() => canonicalize(10n), CanonicalizationError);
  assert.throws(() => canonicalize(() => 1), CanonicalizationError);
  assert.throws(() => canonicalize(undefined), CanonicalizationError);
});

test("cycles are rejected rather than hanging", () => {
  const a: Record<string, unknown> = { name: "a" };
  a["self"] = a;
  assert.throws(() => canonicalize(a), /cycle detected/);
});

test("a repeated (non-cyclic) reference is fine", () => {
  const shared = { v: 1 };
  assert.equal(canonicalize({ x: shared, y: shared }), '{"x":{"v":1},"y":{"v":1}}');
});

test("errors name the offending path", () => {
  try {
    canonicalize({ a: { b: [1, NaN] } });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof CanonicalizationError);
    assert.equal(e.path, "a.b[1]");
  }
});

test("digest is sha256-prefixed hex and stable", () => {
  const d = digest({ hello: "world" });
  assert.match(d, /^sha256:[0-9a-f]{64}$/);
  assert.equal(d, digest({ hello: "world" }));
});

test("unicode strings hash consistently", () => {
  assert.equal(digest({ s: "σ → ≥" }), digest({ s: "σ → ≥" }));
  assert.notEqual(digest({ s: "a" }), digest({ s: "á" }));
});

test("sameContent compares by canonical form", () => {
  assert.ok(sameContent({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert.ok(!sameContent({ a: 1 }, { a: 2 }));
});

test("frozenClone detaches from the source", () => {
  const src = { nested: { v: 1 } };
  const copy = frozenClone(src);
  src.nested.v = 99;
  assert.equal(copy.nested.v, 1);
});

// ── binary containers: three collisions in the one equality function ──────────

test("A TYPED ARRAY IS NOT A PLAIN OBJECT WITH NUMERIC KEYS", () => {
  // `Object.keys(new Uint8Array([1,2,3]))` is `["0","1","2"]`, so the fallthrough branch
  // wrote `{"0":1,"1":2,"2":3}` — the canonical form of a plain object nobody would call
  // equal to it. Same bytes, same digest, and `digest` is what replay compares.
  assert.throws(() => canonicalize(new Uint8Array([1, 2, 3])), CanonicalizationError);
  assert.throws(() => canonicalize({ v: new Uint8Array([1, 2, 3]) }), /Uint8Array/);
});

test("…nor is one typed array another of a different element width", () => {
  // `Float64Array([1,2,3])` is 24 bytes and `Uint8Array([1,2,3])` is 3. Both used to
  // canonicalize to `{"0":1,"1":2,"2":3}`.
  assert.throws(() => canonicalize(new Float64Array([1, 2, 3])), CanonicalizationError);
});

test("AN ArrayBuffer IS NOT THE EMPTY OBJECT", () => {
  // The worst of the three: an ArrayBuffer has no own enumerable keys at all, so EVERY
  // buffer — whatever it holds, however long — canonicalized to `{}` and shared a content
  // address with `{}` and with each other.
  assert.throws(() => canonicalize(new ArrayBuffer(8)), CanonicalizationError);
  assert.throws(() => canonicalize(new DataView(new ArrayBuffer(8))), /DataView/);
});

test("a RegExp is rejected for the same reason", () => {
  // `Object.keys(/abc/g)` is `[]`. Same `{}`, same collision, one constructor over.
  assert.throws(() => canonicalize(/abc/g), CanonicalizationError);
});

test("the binary rejections name the path, like every other one", () => {
  try {
    canonicalize({ a: { b: [Uint8Array.from([1])] } });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof CanonicalizationError);
    assert.equal(e.path, "a.b[0]");
  }
});

test("a Buffer is a typed array and is rejected too", () => {
  // Node's `Buffer` is a `Uint8Array` subclass, so it is the shape this collision is most
  // likely to arrive in: a tool result that read a file.
  assert.throws(() => canonicalize(Buffer.from("hi")), /Uint8Array|Buffer/);
});
