/**
 * `project` IS A NARROWING KNOB, and both of its halves widened.
 *
 * `pickFields` read with a bare `in`, so a declared projection walked the prototype chain on the
 * read and went through `Object.prototype.__proto__`'s setter on the write — the exact pair
 * `resources/realm.ts`'s `rebuild` documents and closes with `Object.defineProperty`. The value
 * it produces flows into the prompt and into `state.reduced`/`stateHash`, so a host function
 * landing in one is a canonicalization failure three layers from its cause, and a re-parented
 * object is a value whose own keys — all `stateHash` can see — no longer describe it.
 *
 * And `take: 0` meant "no slice", so a projection asking for zero items got every item.
 *
 * FIXING THAT WIDENED THE SLICE ITSELF. The guard became `take !== undefined`, which is what a
 * `ContextProjection` typed `take?: number` suggests — but a projection is JSON a graph author
 * wrote, so `take: null` reaches it, `null >= 0` is TRUE, and `slice(0, null)` is `slice(0, 0)`:
 * a projection that declared no slice came back EMPTY. The zero case was measured and the
 * not-a-number cases were not.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { project } from "../../src/run/context.ts";

test("a projection naming an inherited key copies nothing — not a host function", () => {
  const out = project({ a: 1, b: 2 }, { fields: ["a", "toString", "constructor"], maxTokens: 100, overflow: "error" });
  assert.deepEqual(out, { a: 1 }, "only the key the value actually has");
  assert.deepEqual(Object.keys(out as object), ["a"]);
  assert.equal(typeof (out as { constructor?: unknown }).constructor, "function", "…inherited, not own");
  assert.equal(Object.hasOwn(out as object, "constructor"), false);
});

test("a projection naming __proto__ stores it as data instead of re-parenting", () => {
  // JSON.parse is the only construction that makes `__proto__` an OWN key, and it is exactly how
  // a channel value arrives from a tool result or a model answer.
  const src = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
  const out = project(src, { fields: ["a", "__proto__"], maxTokens: 100, overflow: "error" }) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "the projected value must not be re-parented");
  assert.equal((out as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(Object.keys(out).sort(), ["__proto__", "a"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, { polluted: true });
});

test("take: 0 keeps nothing, which is what it asked for", () => {
  assert.deepEqual(project([1, 2, 3], { take: 0, maxTokens: 100, overflow: "error" }), []);
});

test("...and a take that is not a NUMBER is not a slice of zero either", () => {
  // `null` is what JSON gives for an explicitly-absent value, and it is the one that used to
  // silently empty the array: `null >= 0` is true and `slice(0, null)` is `slice(0, 0)`. `NaN`
  // is the other side — it fails both comparisons, so it took the NEGATIVE arm.
  const p = (take: unknown): unknown => project([1, 2, 3], { take, maxTokens: 100, overflow: "error" } as never);
  assert.deepEqual(p(null), [1, 2, 3], "take: null declares no slice; it does not declare an empty one");
  assert.deepEqual(p(NaN), [1, 2, 3]);
  assert.deepEqual(p(Infinity), [1, 2, 3], "an infinite take is not a finite bound, so it is no bound");
  assert.deepEqual(p(-Infinity), [1, 2, 3]);
  assert.deepEqual(p("2"), [1, 2, 3], "a string is not a slice — the knob is typed `number`");
  assert.deepEqual(p(undefined), [1, 2, 3], "and the documented way to say `no slice` still says it");
});

test("the ORDINARY projection arms are unchanged", () => {
  const p = (o: object): object => ({ maxTokens: 100, overflow: "error", ...o }) as object;
  assert.deepEqual(project([1, 2, 3], p({ take: 2 }) as never), [1, 2]);
  assert.deepEqual(project([1, 2, 3], p({ take: -2 }) as never), [2, 3]);
  assert.deepEqual(project([1, 2, 3], p({}) as never), [1, 2, 3], "no take is still no slice");
  assert.deepEqual(project({ a: 1, b: 2 }, p({ fields: ["a"] }) as never), { a: 1 });
  assert.deepEqual(project({ a: 1 }, p({ fields: ["a", "missing"] }) as never), { a: 1 }, "an absent field is skipped");
  assert.deepEqual(
    project([{ a: 1, b: 2 }, { a: 3, b: 4 }], p({ fields: ["a"], take: 1 }) as never),
    [{ a: 1 }],
    "fields apply per element after the slice",
  );
  assert.deepEqual(project([1, 2, 3], undefined), [1, 2, 3], "no projection is identity");
  assert.equal(project("scalar", p({ fields: ["a"] }) as never), "scalar", "a non-object is returned as is");
});
