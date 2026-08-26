/**
 * THE SECOND CLOCK. `Date`'s absence was believed to close the realm's access to the wall clock
 * for a year, and it did not.
 *
 * `run/hooks.ts:89` promises a hook body "No clock and no randomness: see invariant 4", and
 * `realm.ts`'s `SAFE_GLOBAL_NAMES` promised "Everything absent is absent on purpose". Both were
 * half true. `compileRealm` starts from `vm.createContext({})`, which V8 hands back with every
 * intrinsic already bound — `Intl` among them — and `safeGlobals` shadowed only `Date`. So:
 *
 *     new Intl.DateTimeFormat("en-US", {timeZone:"UTC", dateStyle:"full", timeStyle:"full"})
 *       .format()
 *     → "Tuesday, August 25, 2026 at 11:16:07 AM Coordinated Universal Time"
 *
 * measured in the hook realm, through `createHookLoader`, on the fixture below. `format` with NO
 * ARGUMENT defaults to the wall clock, which is the whole route: no `Date` object is ever needed
 * and none is ever built.
 *
 * These tests are the reason the sentence in `run/hooks.ts` is quotable again. They are written
 * against the REALM rather than against either loader, because `realm.ts` is the one compile path
 * both resource kinds go through and a fix that held for hooks alone would be the same
 * half-guarantee one file over.
 *
 * ## What this file does NOT claim
 *
 * Not "the realm is a sandbox" — `realm.ts` says at the top that `node:vm` is not one, and A13
 * makes code resources trusted. Not "these are the only globals" — they are not, and
 * `SAFE_GLOBAL_NAMES`'s docstring now names what else is ambient instead of implying a list.
 *
 * AND NOT "no ambient global in the realm returns a value that changes between two runs of the
 * same bytes", which is what this said. That sentence called itself member-naming and then gave
 * members — `Date`, `Intl`, `Math.random` — that are narrower than the absolute in front of them,
 * so it read as a total claim and was checked as three. The claim, stated so it can be checked:
 *
 *     **THE WALL CLOCK is unreachable from inside the realm by any ambient route.** The members
 *     are `Date` and `Intl`; `Math.random` is the third route to a non-reproducible value and is
 *     handled per-kind by each loader's bridge.
 *
 * TWO AMBIENT ROUTES TO A NON-REPRODUCIBLE VALUE REMAIN OPEN, and the last two tests in this file
 * pin them as measured facts rather than leaving them to be rediscovered as a broken promise:
 * the host's DEFAULT LOCALE, reachable through `toLocaleString()` and `localeCompare()` with no
 * locale argument (`realm.ts` measures one body giving `"1,234.5"`, `"1.234,5"` and `"1 234,5"`
 * under three values of `LC_ALL`), and GARBAGE COLLECTION, observable through the ambient
 * `WeakRef` and `FinalizationRegistry`. Neither is a clock, and neither is closed here; both are
 * the "narrow the ambient set" change `SAFE_GLOBAL_NAMES` records.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createFunctionLoader } from "../../src/resources/functions.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import type { HookContext } from "../../src/run/hooks.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

function storeWith(source: string, kind: "hook" | "function") {
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind, name: "probe", content: source, actor: ACTOR });
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
  return store;
}

const CTX: HookContext = { point: "preNode", runId: "run_1", signal: new AbortController().signal };

/** Every route to "now" reachable from inside a realm without `Date`, as one expression each. */
const CLOCK_PROBE = `{
  var out = {};
  var probe = function (label, get) { try { out[label] = String(get()); } catch (e) { out[label] = "REFUSED"; } };
  probe("Date", function () { return new Date(); });
  probe("Date.now", function () { return Date.now(); });
  probe("Intl.DateTimeFormat().format()", function () {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "full", timeStyle: "full" }).format();
  });
  probe("Intl.DateTimeFormat().formatToParts()", function () {
    return JSON.stringify(new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).formatToParts());
  });
  probe("Intl.DateTimeFormat().resolvedOptions()", function () {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone;
  });
  probe("globalThis.Intl", function () { return globalThis.Intl.DateTimeFormat; });
  probe("performance.now", function () { return performance.now(); });
  return out;
}`;

const REFUSED_EVERYWHERE = {
  "Date": "REFUSED",
  "Date.now": "REFUSED",
  "Intl.DateTimeFormat().format()": "REFUSED",
  "Intl.DateTimeFormat().formatToParts()": "REFUSED",
  "Intl.DateTimeFormat().resolvedOptions()": "REFUSED",
  "globalThis.Intl": "REFUSED",
  "performance.now": "REFUSED",
};

test("A HOOK BODY CANNOT READ THE WALL CLOCK — by any ambient route, `Intl` included", () => {
  const store = storeWith(`function () ${CLOCK_PROBE}`, "hook");
  const body = createHookLoader({ store }).load("hook/probe@stable")!;
  // Before `Intl` was shadowed, the third and fourth entries carried a live timestamp and the
  // fifth carried this machine's time zone. `deepEqual` on the whole map rather than a spot
  // check, so a route that opens later cannot hide behind the ones that are closed.
  assert.deepEqual(body({}, CTX), REFUSED_EVERYWHERE);
});

test("A FUNCTION BODY CANNOT EITHER — same realm, same guarantee, and this is where `ctx.now` lives", () => {
  // `realm.ts` is the shared compile path, so a fix applied to one kind and not the other would
  // be exactly the asymmetry `HOOK_BRIDGE` had for `Math.random`. A function body has a
  // reproducible clock already — `ctx.now`, the task's journaled lease timestamp — so an ambient
  // one is not merely non-deterministic, it is a SECOND clock that disagrees with the first.
  const store = storeWith(`function (view, ctx) ${CLOCK_PROBE}`, "function");
  const body = createFunctionLoader({ store }).load("function/probe@stable")!;
  const view = { get: () => undefined, require: () => undefined, hash: "h", visible: [] as string[] };
  const out = body(view as never, {
    taskId: "task_1" as never,
    signal: new AbortController().signal,
    now: () => 1_700_000_000_000,
    seed: 7,
  } as never);
  assert.deepEqual(out, REFUSED_EVERYWHERE);
});

test("THE CONTROL: shadowing `Intl` costs a body nothing it needs, and `ctx.now` still answers", () => {
  // Without this, "no clock" is satisfied just as well by breaking the realm outright. The
  // intrinsics behind `localeCompare` and `toLocaleString` are NOT reached through the `Intl`
  // global binding, so they keep working — which is the difference between shadowing a namespace
  // and deleting a capability.
  const store = storeWith(
    `function (view, ctx) {
       return {
         now: ctx.now(),
         localeCompare: "a".localeCompare("b"),
         toLocaleString: (1234.5).toLocaleString("en-US"),
         floor: Math.floor(2.7),
         json: JSON.stringify({ ok: true }),
       };
     }`,
    "function",
  );
  const body = createFunctionLoader({ store }).load("function/probe@stable")!;
  const view = { get: () => undefined, require: () => undefined, hash: "h", visible: [] as string[] };
  assert.deepEqual(
    body(view as never, {
      taskId: "task_1" as never,
      signal: new AbortController().signal,
      now: () => 1_700_000_000_000,
      seed: 7,
    } as never),
    {
      now: 1_700_000_000_000,
      localeCompare: -1,
      toLocaleString: "1,234.5",
      floor: 2,
      json: `{"ok":true}`,
    },
  );
});

test("TWO CALLS, ONE ANSWER — the property a clock read would have broken", () => {
  // The randomness half of the same sentence is proved by two runs disagreeing before the fix.
  // This is that proof for the clock, at the cheapest seam: the probe is called twice with a
  // real elapsed gap between them (a busy wait, not a timer — the tests are wall-clock
  // independent and must stay so), and the two answers have to be identical.
  const store = storeWith(`function () ${CLOCK_PROBE}`, "hook");
  const body = createHookLoader({ store }).load("hook/probe@stable")!;
  const first = JSON.stringify(body({}, CTX));
  const started = Date.now();
  while (Date.now() - started < 2) {
    /* a real gap, so a live clock would have moved */
  }
  assert.equal(JSON.stringify(body({}, CTX)), first);
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO ROUTES THAT ARE STILL OPEN. These assert what IS, not what should be — they exist so
 * "no ambient global returns a value replay cannot reproduce" cannot be written down again
 * without something going red. Deleting them is the right move on the day the ambient set is
 * narrowed, and they are written to make that obvious.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

test("THE HOST'S DEFAULT LOCALE IS AMBIENT — `Intl` is shadowed, the intrinsics behind it are not", () => {
  // Shadowing the `Intl` BINDING does not reach `Number.prototype.toLocaleString` or
  // `String.prototype.localeCompare`, which is exactly why the control test above can still call
  // them — and with NO locale argument they read the process default. Compared against the HOST's
  // own answers rather than against a literal, so this is deterministic on any machine and under
  // any `LC_ALL`: the point is that the realm inherits whatever the host has, which is a value
  // the body's bytes do not determine. `realm.ts` carries the three-locale measurement.
  const store = storeWith(
    `function () { return {
       n: (1234.5).toLocaleString(),
       c: "ä".localeCompare("z"),
     }; }`,
    "hook",
  );
  const body = createHookLoader({ store }).load("hook/probe@stable")!;
  assert.deepEqual(body({}, CTX), { n: (1234.5).toLocaleString(), c: "ä".localeCompare("z") });
});

test("GARBAGE COLLECTION IS OBSERVABLE — `WeakRef` and `FinalizationRegistry` are ambient", () => {
  // Presence, not collection: forcing a GC needs `--expose-gc` and job boundaries, and a test
  // that waited for the collector would be exactly the nondeterminism this suite forbids. What
  // is asserted is that the two constructors are there, which is all a body needs — `deref()`
  // answers a question about the host's collector, and `realm.ts` records the measurement that
  // makes it concrete: 500 `WeakRef`s in one cached body read `{"dead":0,"total":500}` on an
  // immediate second call and `{"dead":500,"total":500}` after `--expose-gc` sweeps.
  const store = storeWith(
    `function () { return {
       weakRef: typeof WeakRef,
       finalizationRegistry: typeof FinalizationRegistry,
       derefOfALiveTarget: typeof new WeakRef({ a: 1 }).deref(),
     }; }`,
    "hook",
  );
  const body = createHookLoader({ store }).load("hook/probe@stable")!;
  assert.deepEqual(body({}, CTX), {
    weakRef: "function",
    finalizationRegistry: "function",
    derefOfALiveTarget: "object",
  });
});
