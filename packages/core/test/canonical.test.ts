import test from "node:test";
import assert from "node:assert/strict";

import { CanonicalizationError, canonicalize, digest, frozenClone, sameContent, shapeOf } from "../src/canonical.ts";
import { CODES, isLoomError } from "../src/errors.ts";

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

/**
 * The sibling of the test above, and the pair is the point: SHALLOW sharing works, EXPONENTIAL
 * sharing is refused. The suite already had the first — one shared reference, at depth one, the
 * happy path the author imagined. The second input of that same shape was never constructed, and
 * it is the one that mattered: `seen.delete` on the way out of every container is what makes a
 * shared acyclic value correct, and it is also what makes it walked once per PATH.
 *
 * 26 objects fit in a few hundred bytes and nest to a tenth of `MAX_DEPTH`. Before the bound they
 * produced 44 MB at 22 objects and then, at 25, a bare `RangeError: Invalid array length` with no
 * `code` — out of `journal/store.ts`'s `prepare`, on the durable write path, holding `Engine`'s
 * single commit chain for ~19 seconds while it did it.
 */
test("a value shared by MANY paths is refused with a typed error, not a RangeError", () => {
  let x: unknown = { leaf: 1 };
  for (let i = 0; i < 26; i++) x = { a: x, b: x };
  const started = Date.now();
  try {
    canonicalize(x);
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(isLoomError(e), `a bare ${(e as Error).name} is the failure this replaces`);
    assert.equal(e.code, CODES.E_PAYLOAD_TOO_LARGE);
    assert.equal(e.class, "validation", "the caller's value — never retried");
    assert.match(e.message, /walks over 1000001 containers/);
    assert.match(e.message, /shared reference is expanded once per path/, "the message says how to fix it");
  }
  // An ABSOLUTE bound with an order-of-magnitude margin, not a ratio: refusing must be CHEAP,
  // which is the half a byte bound could not deliver — it charged 1.7 s to 23 s before answering.
  assert.ok(Date.now() - started < 3000, "the refusal arrives after a million containers, not after 44 MB");
});

/**
 * THE CONTAINER BOUND IS NOT AN OUTPUT BOUND, and the reason is in its own docstring: "a
 * container count is independent of string length". A STRING IS NOT A CONTAINER, so the same
 * attack with a FAT leaf instead of a thin one stays comfortably under 1,000,000 containers while
 * the output grows without bound.
 *
 * Nineteen doublings is 524,287 containers — a twentieth of the container limit — and 524,288
 * copies of the leaf. Measured on the tree that had only the container bound: a 1.1 KB leaf gave
 * `RangeError: Invalid string length`, `code=undefined`, in 557 ms and 0.89 GB of RSS, driven
 * through `journal/store.ts`'s `prepare` — the same bare untyped failure on the same durable
 * write path the container bound was added to remove. One notch under, a 900-byte leaf did not
 * throw at all: it produced 478,674,933 characters and handed them to `boundedPayload` to refuse
 * after the fact.
 */
test("a THIN container graph with a FAT leaf is refused too — the container count is not the output", () => {
  let x: unknown = "A".repeat(1100);
  for (let i = 0; i < 19; i++) x = { a: x, b: x };
  const started = Date.now();
  try {
    canonicalize(x);
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(isLoomError(e), `a bare ${(e as Error).name} is the failure this replaces`);
    assert.equal(e.code, CODES.E_PAYLOAD_TOO_LARGE, "the same typed refusal the container bound gives");
    assert.equal(e.class, "validation", "the caller's value — never retried");
    assert.match(e.message, /emits over \d+ characters/);
    assert.ok(!/containers/.test(e.message), "this is the OTHER bound; 524,287 containers is well inside the first");
  }
  // Absolute, with an order-of-magnitude margin. The point of counting as it goes is that the
  // refusal costs a fraction of what producing the value did: 557 ms before, ~54 ms after.
  assert.ok(Date.now() - started < 3000, "the refusal arrives at 64 MiB, not at V8's string limit");
});

/**
 * THE ORDINARY LARGE VALUE STILL PASSES, which is the half a bound this shape can get wrong.
 *
 * 9,437,277 characters is the largest value the whole suite ever canonicalised — instrumented
 * over 464,430 calls — and it entered 256 containers to do it, because a genuinely large value is
 * a large LEAF. `MAX_OUTPUT_CHARS` sits 7.1x above it, so the measured worst case the system
 * actually journals is nowhere near the bound.
 */
test("...and the largest value this project has ever produced is nowhere near the bound", () => {
  const big = "x".repeat(9_437_277);
  const out = canonicalize(big);
  assert.equal(out.length, 9_437_279, "quoted, and otherwise untouched");
  assert.equal(canonicalize({ doc: big }).length, 9_437_287, "and inside a container, the same");
});

test("...and sharing well under the bound still canonicalizes, identically to before", () => {
  // 15 levels is 32,767 containers — 30x the largest walk measured anywhere in this suite (8,413)
  // and 30x under the limit. Two structurally-equal values with DIFFERENT sharing must still
  // produce the same bytes, which is the property that forbids memoising the shared subtree.
  const shared = { v: 1 };
  const dag = { x: shared, y: { z: shared } };
  const copy = { x: { v: 1 }, y: { z: { v: 1 } } };
  assert.equal(canonicalize(dag), canonicalize(copy), "sharing is invisible in the canonical form, and must stay so");

  let deep: unknown = { leaf: 1 };
  for (let i = 0; i < 15; i++) deep = { a: deep, b: deep };
  assert.equal(canonicalize(deep).length, 688117, "unchanged from before the bound");
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

// ── depth: the recursion that had no floor ───────────────────────────────────

/**
 * Mirrors the private `MAX_DEPTH` in `canonical.ts`. Not imported: `check-surface.mjs`
 * pins the exported name set and `index.ts` re-exports all of `canonical.ts`, so adding
 * an export is a separate reviewed act. This literal disagreeing with the source is a
 * failure, by design.
 */
const MAX_DEPTH = 256;

/** `depth` nested containers around a leaf. A loop, so building it cannot itself overflow. */
function nest(depth: number, kind: "object" | "array" = "object"): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = kind === "object" ? { a: v } : [v];
  return v;
}

function assertTooDeep(fn: () => unknown, what: string): void {
  try {
    fn();
  } catch (e) {
    assert.ok(isLoomError(e), `${what}: expected a LoomError, got ${(e as Error)?.name}: ${(e as Error)?.message}`);
    assert.equal(e.code, CODES.E_PAYLOAD_TOO_DEEP, what);
    assert.equal(e.class, "validation", what);
    return;
  }
  assert.fail(`${what}: expected a refusal`);
}

test("EVERY ENTRY POINT REFUSES AN OVER-DEEP VALUE — the recursion had no floor", () => {
  // Measured on Node 24.16 with the default stack: the unbounded version died at nesting
  // depth 5700 flat, 5100 under 1000 caller frames, 3800 under 3000 — with a bare
  // `RangeError: Maximum call stack size exceeded`, which is a host error and not a member
  // of the taxonomy any caller branches on.
  const deep = nest(20_000);
  assertTooDeep(() => canonicalize(deep), "canonicalize");
  assertTooDeep(() => digest(deep), "digest");
  assertTooDeep(() => frozenClone(deep), "frozenClone");
  assertTooDeep(() => sameContent(deep, deep), "sameContent");
  assertTooDeep(() => shapeOf(deep), "shapeOf");
});

test("the boundary is exact and both container kinds count", () => {
  // Both sides of the boundary are depths the old code canonicalized without complaint,
  // so this pins the CHOSEN limit rather than the machine's stack.
  for (const kind of ["object", "array"] as const) {
    assert.doesNotThrow(() => canonicalize(nest(MAX_DEPTH, kind)), `${kind} at the limit`);
    assertTooDeep(() => canonicalize(nest(MAX_DEPTH + 1, kind)), `${kind} one past the limit`);
    assertTooDeep(() => shapeOf(nest(MAX_DEPTH + 1, kind)), `shapeOf ${kind} one past the limit`);
  }
});

test("the refusal names a path and does not carry a 20k-character one", () => {
  // The natural path string at depth 20_000 is 40_000 characters, and the refusal is
  // handed to `errorRecord` on its way into a journal payload — so an unbounded message
  // would trade a stack overflow for a durable write of the thing that caused it.
  try {
    canonicalize({ outer: nest(20_000, "array") });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(isLoomError(e));
    assert.ok(e.message.length < 400, `message was ${e.message.length} chars`);
    assert.match(e.message, /outer/, "the path still says where");
    const details = e.details as { depth?: unknown; limit?: unknown };
    assert.equal(details.limit, MAX_DEPTH);
    assert.equal(details.depth, MAX_DEPTH + 1);
  }
});

test("the limit is on depth, not on size", () => {
  // 200_000 sibling keys is far more data than the refused value above, and nests once.
  const wide: Record<string, number> = {};
  for (let i = 0; i < 200_000; i++) wide[`k${i}`] = i;
  assert.equal(typeof canonicalize(wide), "string");
  assert.equal(typeof shapeOf(wide), "string");
});

test("a cycle is still a CYCLE, not a depth overflow", () => {
  // The cycle check has to keep winning: it is the cheaper, more precise answer, and a
  // depth limit would otherwise silently reclassify every cyclic value.
  const a: Record<string, unknown> = {};
  a["self"] = a;
  assert.throws(() => canonicalize(a), CanonicalizationError);
  assert.throws(() => canonicalize(a), /cycle detected/);
});
