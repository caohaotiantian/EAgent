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
 * And `take: 0` meant "no slice", so a projection asking for zero items got every item. The arm
 * that did that was `take !== undefined && take !== 0`, dispatching on `take > 0`.
 *
 * FIXING THAT WIDENED THE SLICE ITSELF, in the direction a bounding knob may never widen. The
 * arm became `typeof take === "number" && Number.isFinite(take)` — which is what a
 * `ContextProjection` typed `take?: number` suggests, but a projection is JSON a graph author
 * wrote and `graph/spec.ts` checks only the KEY NAMES, so `take: "3"` (a quoted number in
 * hand-written YAML) compiles clean, is "not a number", and is therefore NOT A SLICE: the node
 * asking for three items is shown all ten. The old arm coerced, so it showed three. `true` and
 * `[3]` are the same story.
 *
 * `take: null` was never the empty case that fix was written against: `null !== 0` is true so
 * the old arm ran, `null > 0` is FALSE so it took the negative side, and `slice(null)` is
 * `slice(0)` — the whole array, which is also what `null` should mean. What actually needed
 * closing was `take: 0`, and everything that is not a finite number after coercion, which now
 * refuses rather than widening.
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

test("a take that is not a finite number refuses; it never means `show everything`", () => {
  const p = (take: unknown): unknown => project([1, 2, 3], { take, maxTokens: 100, overflow: "error" } as never);

  // The two ways to declare no bound, and the only two.
  assert.deepEqual(p(undefined), [1, 2, 3], "the documented way to say `no slice` still says it");
  assert.deepEqual(p(null), [1, 2, 3], "take: null declares no slice; it does not declare an empty one");

  // Coercible: the bound the author wrote, not the whole array. `"2"` is what YAML gives for a
  // quoted number and what `graph/spec.ts` lets through without a diagnostic.
  assert.deepEqual(p("2"), [1, 2], "a quoted number is the number the author wrote");
  assert.deepEqual(p(true), [1], "Number(true) is 1");
  assert.deepEqual(p([2]), [1, 2], "a one-element array coerces to its element");
  assert.deepEqual(p("-2"), [2, 3], "and the negative arm coerces too");

  // Not coercible: refused. Showing all three would be the loosening.
  for (const bad of [NaN, Infinity, -Infinity, "abc", {}, [1, 2]]) {
    assert.throws(
      () => p(bad),
      (e: unknown) => (e as { code?: string }).code === "E_GRAPH_INVALID",
      `take: ${JSON.stringify(bad) ?? String(bad)} must refuse, not widen`,
    );
  }
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
