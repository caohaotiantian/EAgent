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
 * asking for three items is shown all ten. `"3"` is the one non-number worth reading, and it now
 * reads as 3; `true` and `[3]` were shown all ten by that same arm and now refuse, because a
 * boolean and a one-element array are bounds nobody wrote.
 *
 * `take: null` was never the empty case that fix was written against: `null !== 0` is true so
 * the old arm ran, `null > 0` is FALSE so it took the negative side, and `slice(null)` is
 * `slice(0)` — the whole array, which is also what `null` should mean. What actually needed
 * closing was `take: 0`.
 *
 * AND THE FIX FOR THAT REACHED FOR `Number()`, WHICH IS A COERCION AND NOT A READER. `Number("")`,
 * `Number(" ")`, `Number([])` and `Number(false)` are all 0, and `take: 0` is a legitimate bound
 * meaning "show nothing" — so those four unreadable bounds emptied the channel SILENTLY, while
 * `"abc"`, an unreadable bound of exactly the same kind, refused loudly. Measured on `[1,2,3,4,5]`:
 * each of the four returned `[]` where the arm before them returned all five. Both answers are
 * wrong and the silent one is worse, because a node handed `[]` cannot tell it from a channel
 * with no rows.
 *
 * So the vocabulary is stated rather than coerced — a finite number, or a string that PARSES as
 * one — and the last four tests here are that boundary from both sides.
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

test("a take that is not an item count refuses; it never means `show everything`", () => {
  const p = (take: unknown): unknown => project([1, 2, 3], { take, maxTokens: 100, overflow: "error" } as never);

  // The two ways to declare no bound, and the only two.
  assert.deepEqual(p(undefined), [1, 2, 3], "the documented way to say `no slice` still says it");
  assert.deepEqual(p(null), [1, 2, 3], "take: null declares no slice; it does not declare an empty one");

  // Readable: the bound the author wrote, not the whole array. `"2"` is what YAML gives for a
  // quoted number and what `compile` lets through without a diagnostic.
  assert.deepEqual(p("2"), [1, 2], "a quoted number is the number the author wrote");
  assert.deepEqual(p("-2"), [2, 3], "and the negative arm reads a quoted number too");
  assert.deepEqual(p(" 2 "), [1, 2], "…surrounding whitespace is not part of the number");

  // Unreadable: refused. Showing all three would be the loosening; showing none would be the
  // same refusal made silent.
  for (const bad of [NaN, Infinity, -Infinity, "abc", {}, [1, 2]]) {
    assert.throws(
      () => p(bad),
      (e: unknown) => (e as { code?: string }).code === "E_GRAPH_INVALID",
      `take: ${JSON.stringify(bad) ?? String(bad)} must refuse, not widen`,
    );
  }
});

test("AN UNREADABLE BOUND THAT `Number()` MAPS TO 0 REFUSES TOO — it must not empty the channel", () => {
  // The four values the coercion swallowed. Each returned `[]` — a node shown nothing, with no
  // diagnostic anywhere, for a declaration exactly as broken as the `"abc"` above.
  const p = (take: unknown): unknown => project([1, 2, 3, 4, 5], { take, maxTokens: 100, overflow: "error" } as never);
  for (const bad of ["", " ", [], false, true, [3]]) {
    assert.throws(
      () => p(bad),
      (e: unknown) => (e as { code?: string }).code === "E_GRAPH_INVALID",
      `take: ${JSON.stringify(bad)} must refuse; Number() maps it to a bound the author never wrote`,
    );
  }
});

test("...and the refusal names WHICH value it refused, so `\"\"` and `\" \"` are told apart", () => {
  // `JSON.stringify` for everything but a number, because it quotes — an unquoted empty string in
  // a diagnostic is a diagnostic that names nothing. Numbers keep `String`, because NaN and
  // Infinity both render as `null` under `JSON.stringify` and `null` is the LEGAL way to say
  // "no slice": the message would then blame the one value that is correct.
  const msg = (take: unknown): string => {
    try {
      project([1, 2, 3], { take, maxTokens: 100, overflow: "error" } as never);
    } catch (e) {
      return (e as Error).message;
    }
    return "(did not refuse)";
  };
  assert.match(msg(""), /: ""$/);
  assert.match(msg(" "), /: " "$/);
  assert.match(msg(false), /: false$/);
  assert.match(msg([]), /: \[\]$/);
  assert.match(msg(NaN), /: NaN$/);
  assert.match(msg(Infinity), /: Infinity$/);
});

test("an unreadable take refuses on a NON-array value too — the declaration is what is broken", () => {
  // Deliberate, and it is a behaviour change: the slice itself only ever applied to an array, so
  // this used to be inert. Whether a `take` is readable is a fact about the DECLARATION, and
  // deferring the refusal to `Array.isArray` would let the same broken graph pass one run and
  // fail the next, depending only on whether the channel happened to hold rows.
  //
  // `"abc"` ALONE DOES NOT SHOW THAT, and an earlier version of this test drove only `"abc"`:
  // it refused on a non-array at the base sha too, because the old guard also sat above the
  // `Array.isArray` branch. The values that actually changed are the ones `Number()` reads —
  // `true`, `[3]` — and the four it maps to 0. Measured on a non-array channel, base leaves it
  // untouched (`{"k":1}`) and this build refuses.
  for (const take of ["abc", true, [3], "", " ", false]) {
    for (const value of [{ a: 1 }, "hello", 42]) {
      assert.throws(
        () => project(value, { take, maxTokens: 100, overflow: "error" } as never),
        (e: unknown) => (e as { code?: string }).code === "E_GRAPH_INVALID",
        `take: ${JSON.stringify(take)} on ${JSON.stringify(value)} must refuse`,
      );
    }
  }
  // A READABLE take on a non-array is still inert — there is nothing to slice, and that is not
  // an error. This is the half the refusal must not swallow.
  assert.deepEqual(project({ a: 1, b: 2 }, { take: 3, maxTokens: 100, overflow: "error" } as never), { a: 1, b: 2 });
  assert.equal(project("hello", { take: 2, maxTokens: 100, overflow: "error" } as never), "hello");
  assert.equal(project(null, { take: 2, maxTokens: 100, overflow: "error" } as never), null);
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
