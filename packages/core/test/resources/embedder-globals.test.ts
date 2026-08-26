/**
 * THE EMBEDDER `globals` SEAM BEAT EVERY SHADOW, and both loaders' docstrings said otherwise.
 *
 * `compileRealm` merged `Object.assign(context, safeGlobals(context), opts.globals)` — last writer
 * wins, and the caller's bag was last. So one option field undid `realm.ts`'s two clock shadows
 * AND handed a body a host object. Measured on the tree before this file existed, with
 * `createHookLoader({store, globals: {JSON, Date, Intl, Math}})` and a body probing each:
 *
 *     {"escape":"object","typeofDate":"function","typeofIntl":"object",
 *      "dateNowWorks":true,"intlRead":true}
 *
 * `escape` is `typeof process` evaluated through `JSON.parse.constructor("return typeof process")()`
 * — the HOST realm, reached through the embedder's own `JSON`, which is the same escape this repo
 * already found twice (`Object.constructor(…)` through the globals, then `view.constructor.constructor(…)`
 * through the arguments) arriving for a third time through the one door nobody had shut.
 *
 * ## WHAT THIS FILE CLAIMS, NARROWED TO WHAT IT CAN CARRY
 *
 * It used to say the tests assert "a body never holds a host object" and that "the determinism
 * guards (`Date`, `Intl`, `Math.random`) are not switchable off by a caller". BOTH ARE FALSE, and
 * the last three tests below are the measurements that disprove them. A caller who passes
 * `{MY_DATE: Date}` hands the body a live wall clock; a caller who passes any object at all hands
 * it the host realm on that object's constructor chain. `refuseGovernedGlobals` reads NAMES. A
 * name check cannot vet a value, and `globals` is a value seam.
 *
 * What IS asserted here, and it names its members:
 *
 *   1. The eighteen names `realm.ts` governs are REFUSED — for both resource kinds, WHEREVER the
 *      key sits in the bag, and whatever else is in it. That buys one thing: an embedder who
 *      clobbers a shadow finds out at compile instead of silently receiving a realm that ignored
 *      half their argument. Invariant 5 — oversight only tightens — holds for the NAMESPACE.
 *   2. An ungoverned key still works, so this is a refusal of a set and not of the feature.
 *   3. With no `globals` at all, the shadows and the escape are closed.
 *   4. What (1) does NOT buy, measured rather than asserted away, so that a reader who believes
 *      the old promise is contradicted by a test rather than by a comment.
 *
 * ONE RULE, BOTH RESOURCE KINDS. The asymmetry that made this worth its own file: `hook-loader.ts`
 * hardened the seam against `Math` alone (silently, by `delete`), `Date` and `Intl` went straight
 * through, and `functions.ts` hardened nothing at all.
 *
 * ## WHY THE BAGS BELOW HAVE MORE THAN ONE KEY
 *
 * Every assertion in this file used to pass `{ [name]: value }` — a bag of exactly ONE key. That
 * pins nothing about the loop in `refuseGovernedGlobals` past its first iteration, and a verifier
 * proved it: changing `continue` to `return` in that loop left all 70 tests green, and an
 * argument-order swap on top of it put the original host-realm escape back with 96 of 96 passing.
 * A single-key bag cannot tell "checks every key" from "checks the first key". So no refusal is
 * asserted with a one-key bag any more: `governedAt` puts the offending name FIRST, in the MIDDLE
 * and LAST among ungoverned neighbours, and every position has to refuse.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createFunctionLoader } from "../../src/resources/functions.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { makeStateView, type ChannelSpec } from "../../src/state/channels.ts";
import type { HookContext } from "../../src/run/hooks.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

function published(kind: "hook" | "function", name: string, source: string): ResourceStore {
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind, name, content: source, actor: ACTOR });
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
  return store;
}

const SPECS: Record<string, ChannelSpec> = { out: { type: "string", reduce: "replace" } };
const view = () => makeStateView(SPECS, {}, ["out"]);
const fnCtx = () => ({ taskId: "t@root#0" as never, signal: new AbortController().signal, now: () => 1, seed: 1 });
const hookCtx: HookContext = { point: "preNode", runId: "run_1", signal: new AbortController().signal };

/**
 * Every name the realm governs: the 16 in `SAFE_GLOBAL_NAMES` plus the two shadowed clocks.
 *
 * Written out rather than imported, deliberately. `refuseGovernedGlobals` derives its set from
 * `safeGlobals`, so importing the same source would make this test agree with the implementation
 * by construction and assert nothing. A literal list disagrees loudly when the sets drift.
 */
const GOVERNED = [
  "JSON", "Math", "Number", "String", "Boolean", "Array", "Object", "Error", "TypeError",
  "RangeError", "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "Date", "Intl",
] as const;

const PROBE = `(a, b) => ({ out: "ran" })`;

/**
 * The offending key at position `at` of a FOUR-key bag whose other three are ungoverned.
 *
 * Insertion order is what `Object.keys` yields and therefore what the loop walks, so `at: 0`,
 * `at: 1` and `at: 3` are genuinely first, middle and last. The neighbours carry PRIMITIVES on
 * purpose — an ungoverned key holding a host object is a different subject, and it has its own
 * test at the bottom of this file.
 */
function governedAt(name: string, value: unknown, at: 0 | 1 | 3): Record<string, unknown> {
  const filler: [string, unknown][] = [["TENANT", 7], ["REGION", "eu"], ["DEBUG", false]];
  const entries: [string, unknown][] = [...filler];
  entries.splice(at, 0, [name, value]);
  return Object.fromEntries(entries);
}

const POSITIONS = [0, 1, 3] as const;
const WHERE = { 0: "first", 1: "in the middle of", 3: "last in" } as const;

test("EVERY GOVERNED NAME IS REFUSED, for a hook body — all eighteen, at every position in the bag", () => {
  const store = published("hook", "probe", PROBE);
  for (const name of GOVERNED) {
    for (const at of POSITIONS) {
      const globals = governedAt(name, globalThis[name as keyof typeof globalThis], at);
      assert.throws(
        () => createHookLoader({ store, globals }).load("hook/probe@stable"),
        (e: unknown) => new RegExp(`may not include "${name}"`).test(String(e)),
        `an embedder passing a host \`${name}\` ${WHERE[at]} a bag of four must be refused, not quietly ignored`,
      );
    }
  }
});

test("EVERY GOVERNED NAME IS REFUSED for a function body too — the asymmetry is gone", () => {
  // `functions.ts` hardened NOTHING before this: it passed `opts.globals` straight to
  // `compileRealm`, which merged it last. `function` bodies are the product path.
  const store = published("function", "probe", PROBE);
  for (const name of GOVERNED) {
    for (const at of POSITIONS) {
      const globals = governedAt(name, globalThis[name as keyof typeof globalThis], at);
      assert.throws(
        () => createFunctionLoader({ store, globals }).load("function/probe@stable"),
        (e: unknown) => new RegExp(`may not include "${name}"`).test(String(e)),
        `\`${name}\` ${WHERE[at]} the bag must be refused for a function body on the same terms as for a hook`,
      );
    }
  }
});

test("THE WHOLE BAG IS WALKED: eighteen ungoverned keys ahead of the offender do not exhaust it", () => {
  // The direct statement of the defect this file was blind to. `continue` → `return` in
  // `refuseGovernedGlobals` makes the loop give up at its first ungoverned key; every bag here
  // has eighteen of those before the one that matters.
  const store = published("hook", "probe", PROBE);
  const decoys = Object.fromEntries(GOVERNED.map((n, i) => [`DECOY_${n}`, i]));
  for (const name of GOVERNED) {
    assert.throws(
      () => createHookLoader({
        store,
        globals: { ...decoys, [name]: globalThis[name as keyof typeof globalThis] },
      }).load("hook/probe@stable"),
      (e: unknown) => new RegExp(`may not include "${name}"`).test(String(e)),
      `\`${name}\` behind eighteen ungoverned keys must still be reached by the check`,
    );
  }
});

test("THE CHECK READS THE EMBEDDER'S BAG, NOT THE REALM'S — an argument swap has to be visible", () => {
  // `refuseGovernedGlobals(governed, globals, label)` takes the realm's set first and the
  // caller's second. Swap them and the loop walks the EIGHTEEN GOVERNED NAMES asking whether the
  // caller supplied each — which refuses a bag that happens to name one and, paired with the
  // `return` above, stops refusing anything at all. Two bags pin the direction:
  const store = published("hook", "probe", PROBE);

  // (a) a bag of ungoverned keys ONLY must compile — under a swap the loop would still find
  //     nothing, so this alone proves nothing; it is the control for (b).
  assert.doesNotThrow(() =>
    createHookLoader({ store, globals: { TENANT: 7, REGION: "eu" } }).load("hook/probe@stable"));

  // (b) ONE governed key among many ungoverned ones must name THAT key. Under the swap the
  //     loop iterates the realm's 18 names in `SAFE_GLOBAL_NAMES` order, so the FIRST match it
  //     reports for a bag holding `Intl` is still `Intl` — but for a bag holding BOTH `Intl` and
  //     `Math` the swapped loop reports `Math` (it comes second in the realm's order) while the
  //     honest loop reports whichever the CALLER wrote first. Insertion order is the tell.
  assert.throws(
    () => createHookLoader({ store, globals: { TENANT: 7, Intl, Math, REGION: "eu" } }).load("hook/probe@stable"),
    (e: unknown) => {
      assert.match(String(e), /may not include "Intl"/, "must report the caller's first offending key, not the realm's");
      return true;
    },
  );

  // THE ORDER IS PINNED, by the test below. An earlier version of this comment argued the
  // `Object.assign(context, opts.globals, governed)` order was "provably" unpinnable, because
  // `refuseGovernedGlobals` walks `Object.keys(globals)` and `Object.assign` copies own
  // enumerable keys — "the same set, so no bag exists that the assignment sees and the check does
  // not". That is false, and a verifier built the counterexample: the two calls trigger `ownKeys`
  // TWICE, so a stateful Proxy can hide a governed name from the check and reveal it to the copy.
});

test("the refusal NAMES the key and does NOT advise the exploit", () => {
  // A refusal an embedder cannot act on is a refusal they work around — so it has to say which of
  // their keys. It used to say the way out was "inject it under a name of your own", which is
  // advice to do the exact thing the last three tests in this file measure. The message must not
  // carry it any more, and must not grow it back.
  const store = published("hook", "probe", PROBE);
  assert.throws(
    () => createHookLoader({ store, globals: { TENANT: 7, Date } }).load("hook/probe@stable"),
    (e: unknown) => {
      const m = String(e);
      assert.match(m, /"Date"/, "must name the offending key");
      assert.match(m, /hook\/probe@stable/, "must name the resource being compiled");
      assert.doesNotMatch(
        m,
        /under a name of your own/,
        "must NOT tell the reader to rename the key: that hands the body the host object the refusal just took away",
      );
      assert.match(m, /RENAMING IT IS NOT THE FIX/, "must say plainly that renaming does not work");
      assert.match(m, /PRIMITIVE/, "must name the remediation that does work");
      return true;
    },
  );
});

test("AN UNGOVERNED GLOBAL STILL WORKS — this refuses a set, not the feature", () => {
  // The control. `globals` exists so an embedder can inject a tenant id or a lookup table, and
  // `functions.test.ts` already depends on that. A guard that took the whole field with it would
  // pass every assertion above and be the wrong fix.
  const store = published("function", "tenant", `(v, c) => ({ writes: { out: "tenant=" + TENANT } })`);
  const body = createFunctionLoader({ store, globals: { TENANT: 7 } }).load("function/tenant@stable")!;
  assert.deepEqual(body(view(), fnCtx()), { writes: { out: "tenant=7" } });

  const hookStore = published("hook", "tenant", `(input, ctx) => ({ seen: TENANT })`);
  const hook = createHookLoader({ store: hookStore, globals: { TENANT: 7 } }).load("hook/tenant@stable")!;
  assert.deepEqual(hook({}, hookCtx), { seen: 7 });
});

test("NO GLOBALS AT ALL: the shadows and the escape are closed the way the docstrings promise", () => {
  // What the refusal is protecting, asserted directly rather than through the refusal — so this
  // still means something if the governed set is ever narrowed. `compileRealm` also assigns the
  // shadows LAST now, so even with `refuseGovernedGlobals` deleted these four stay true.
  const store = published(
    "hook",
    "reach",
    `(input, ctx) => ({
       hostReach: JSON.parse.constructor("return typeof process")(),
       typeofDate: typeof Date,
       typeofIntl: typeof Intl,
       literalReach: ({}).constructor.constructor("return typeof process")()
     })`,
  );
  const body = createHookLoader({ store }).load("hook/reach@stable")!;
  assert.deepEqual(body({}, hookCtx), {
    hostReach: "undefined",
    typeofDate: "undefined",
    typeofIntl: "undefined",
    literalReach: "undefined",
  });
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE REFUSAL DOES NOT BUY.
 *
 * Three measurements, kept as TESTS rather than as a comment, because a comment is what this
 * codebase keeps discovering was wrong. They pin the CURRENT boundary: if someone closes the
 * value seam later — `realm.ts` records how, and it is the JSON rebuild the call path already
 * does — these go red and send them here to delete them, which is the correct outcome and the
 * reason they are written to be easy to delete.
 *
 * They are not a hole being confessed. A13 makes a code resource trusted, `node:vm` is scoping
 * and not a sandbox, and `globals` is supplied by whoever CONSTRUCTED the loader — the same
 * party that chose the code. What they close is the gap between that and what the docstrings
 * were promising.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

test("AN UNGOVERNED KEY HANDS THE BODY THE HOST REALM — a name check cannot vet a value", () => {
  // The old docstring of this file promised "a body never holds a host object". It does, the
  // moment an embedder passes one, and `{a: 1}` is enough: every object carries its realm on
  // `constructor.constructor`. This is the SAME escape as `{JSON}` — the refusal above only
  // moved which key spells it.
  const store = published("hook", "reach", `(input, ctx) => ({
    escape: LOOKUP.constructor.constructor("return typeof process")(),
  })`);
  const body = createHookLoader({ store, globals: { LOOKUP: { a: 1 } } }).load("hook/reach@stable")!;
  assert.deepEqual(body({}, hookCtx), { escape: "object" }, "a plain host object is a door to the host realm");
});

test("AN UNGOVERNED KEY HANDS THE BODY A LIVE CLOCK — the shadow guards the NAME `Date`", () => {
  // The old docstring promised "the determinism guards are not switchable off by a caller".
  // `Date` the NAME stays shadowed — that much is true and the `NO GLOBALS AT ALL` test above
  // holds it — but the caller can put the same constructor one identifier over and the body
  // reads a wall clock replay will not reproduce. Asserted without reading the clock itself, so
  // this stays wall-clock independent: `typeof` and identity, not a timestamp.
  const store = published("hook", "clock", `(input, ctx) => ({
    shadowStillHolds: typeof Date,
    callable: typeof MY_DATE.now(),
    isTheHostsDate: MY_DATE.name,
  })`);
  const body = createHookLoader({ store, globals: { MY_DATE: Date } }).load("hook/clock@stable")!;
  assert.deepEqual(body({}, hookCtx), { shadowStillHolds: "undefined", callable: "number", isTheHostsDate: "Date" });
});

test("A SYMBOL KEY IS NOT SEEN BY THE CHECK AT ALL — it reads STRING names", () => {
  // The sharpest statement of the seam's shape, and the one that rules out "just harden the
  // check". `refuseGovernedGlobals` walks `Object.keys`, which yields no symbols; `Object.assign`
  // copies them anyway. So a bag whose ONLY key is `Symbol.for("SMUGGLED")` is refused nothing,
  // is reported by `Object.keys` as `[]`, and lands the host `Date` on the realm's `globalThis`
  // where a body reaches it by `globalThis[Symbol.for(...)]`.
  const bag: Record<PropertyKey, unknown> = {};
  bag[Symbol.for("SMUGGLED")] = Date;
  assert.deepEqual(Object.keys(bag), [], "the check's own input sees nothing to refuse");

  const store = published("hook", "smuggle", `(input, ctx) => ({
    reached: typeof globalThis[Symbol.for("SMUGGLED")],
    escape: globalThis[Symbol.for("SMUGGLED")].constructor.constructor("return typeof process")(),
  })`);
  const body = createHookLoader({ store, globals: bag }).load("hook/smuggle@stable")!;
  assert.deepEqual(body({}, hookCtx), { reached: "function", escape: "object" });
});

test("AN UNGOVERNED KEY LETS A BODY REWRITE THE HOST PROCESS'S `Math.random`", () => {
  // The sharpest of the three, and the one that shows the shape of the problem: the body did not
  // escape anything. It was handed a host object and used it — and the write lands on the
  // process every other caller in it shares. `DENY_RANDOM` and the realm's `Math` are untouched
  // and irrelevant; they guard the realm's own binding, not an object the embedder hands over.
  const store = published("hook", "patch", `(input, ctx) => {
    MY_MATH.random = function () { return 0.42; };
    return { patched: true };
  }`);
  const original = Math.random;
  try {
    createHookLoader({ store, globals: { MY_MATH: Math } }).load("hook/patch@stable")!({}, hookCtx);
    assert.equal(Math.random(), 0.42, "the HOST process's Math.random was replaced by a hook body");
    assert.notEqual(Math.random, original, "and it is not the function this process started with");
  } finally {
    // Restore before any other suite in this process draws. The damage being undoable here is
    // an artefact of the test knowing what to undo; an embedder gets no such notice.
    Math.random = original;
  }
});


// ── the assignment order, pinned by the bag that defeats the check ───────────
//
// ADDED 2026-08-25. `refuseGovernedGlobals` calls `Object.keys(globals)` and `Object.assign`
// calls `ownKeys` again — two separate enumerations of the same object. A Proxy that answers
// differently the second time is refused nothing and IS copied, so `governed` must be assigned
// AFTER `opts.globals`, not before. Without that ordering this exact bag reopens the original
// escape: a live host `Date` inside the body.

test("ORDER: a Proxy that hides a governed key from the CHECK cannot smuggle it past the ASSIGN", () => {
  const store = published(
    "hook",
    "order",
    `(input, ctx) => ({ typeofDate: typeof Date, tenant: typeof TENANT })`,
  );
  let enumerations = 0;
  const smuggler = new Proxy(
    { TENANT: 7, Date },
    {
      ownKeys(t) {
        enumerations += 1;
        // First enumeration is the refusal check — show it nothing to object to.
        // Second is `Object.assign` — hand over the host `Date`.
        return enumerations === 1 ? ["TENANT"] : Reflect.ownKeys(t);
      },
    },
  ) as Record<string, unknown>;

  const body = createHookLoader({ store, globals: smuggler }).load("hook/order@stable")!;
  const seen = body({}, hookCtx) as Record<string, string>;

  assert.ok(enumerations >= 2, `control: the bag must be enumerated twice, saw ${enumerations}`);
  assert.equal(seen["tenant"], "number", "control: the ungoverned key did reach the body");
  assert.equal(
    seen["typeofDate"],
    "undefined",
    "the shadows must be assigned AFTER the caller's bag — otherwise a Proxy that lies to the " +
      "refusal check hands the body a live host Date, which is the original escape",
  );
});
