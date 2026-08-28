/**
 * `hermetic: true` MEANT NOTHING ON A GRAPH OF `function` NODES, AND THIS IS THE TERM IT LACKED.
 *
 * `ReplayReport.hermetic` was `unknownOutcomes.length === 0 && derivedClocks.length === 0`. Both
 * terms are indexed by EFFECT KEY; a `function` or `evaluator{assertion}` body computes no effect
 * key. So no input could make the field false while those bodies RE-EXECUTED LIVE — a guard
 * answering its undecidable case with the passing value, inside the one field the replay thesis
 * is quoted by. "A body ran live" was not expressible over the vocabulary the report had.
 *
 * ## What this file pins, in three parts
 *
 * 1. THE BRAND. `resources/realm.ts` records in a module-private `WeakSet` the calls whose realm
 *    PASSED the three determinism checks `onlyGovernedCrossed`'s header names, and
 *    `isRealmBounded` asks whether a value is in it. Every case this file can construct that the
 *    runtime cannot vouch for answers `false` — a host closure, a realm whose embedder globals
 *    reached the namespace, a realm whose draw is still the platform's, a non-function — because
 *    absence of evidence must report as unvouched-for and never as bounded.
 *
 *    THE STAMP IS DERIVED FROM A CHECK ON THE REALM, NOT FROM THE CODE PATH THAT BUILT IT, and
 *    that is a correction measured rather than reasoned. The first spelling was
 *    `opts.globals === undefined || Object.keys(opts.globals).length === 0` — a test on the
 *    ARGUMENT — and `Object.keys` yields no symbols while `Object.assign` copies them, so a bag
 *    whose only key was `Symbol("MY_DATE")` holding the host `Date` was branded while the body
 *    read `D.now() > 1.7e12 → true` and escaped to the host realm. `A HOST VALUE SMUGGLED UNDER
 *    A SYMBOL KEY COSTS THE BRAND` below is that input.
 *
 *    IT IS A `WeakSet` AND NOT D.9'S `Symbol()` BECAUSE THE SYMBOL SPELLING WAS FORGEABLE, which
 *    is a correction to the decision made by running it rather than reading it. A symbol used as
 *    a property key is carried BY THE OBJECT, so `Object.getOwnPropertySymbols(brandedCall)`
 *    hands it to any holder, who copies it onto a host closure — and `in` also inherits it down
 *    a prototype chain. All three routes measured `true` against the symbol spelling, where
 *    `false` was the entire point of choosing a private symbol over `Symbol.for`. They are the
 *    `THE BRAND CANNOT BE COPIED OFF A BRANDED CALL` case below.
 * 2. THE ACCUMULATOR. `ReplayEffects.bodyEntered` records only the unvouched-for, dedupes, and
 *    sorts; `hermetic` takes `liveBodies.length === 0` as a third conjunct.
 * 3. THE GAP, AS A CENSUS. Nothing in `src/` calls `bodyEntered`, so the third conjunct is inert
 *    and `hermetic` still over-claims. That is a fact about this tree and it is asserted here
 *    rather than left in a docstring, because a docstring that says "not wired yet" survives the
 *    commit that wires it and a test does not.
 *
 * ## Why the gap exists rather than being closed here
 *
 * Two lines outside this change close it, and both are in files another change owns:
 *
 *   - `Engine.#functionBody` must call `bodyEntered(taskId, isRealmBounded(body))` at FETCH time.
 *     It has no `taskId` parameter today; its two callers (`#runFunction` and `#runEvaluator`'s
 *     assertion arm) have one. Fetch time and not after invocation, so a body that throws, is
 *     terminated at its deadline, or is aborted still counts — the count may be too high, never
 *     too low.
 *   - `resources/functions.ts` must carry the brand onto the `FunctionBody` it wraps around
 *     `compileRealm`'s `RealmCall`. MEASURED on this tree: `isRealmBounded` is `true` on the
 *     realm call and `false` on `createFunctionLoader(...).load(...)`, because the loader returns
 *     a closure OVER the branded call, not the branded call. Without that line every function
 *     body reads as unvouched-for and `hermetic` would be permanently false — fail-closed, and
 *     useless.
 *
 * THE PROVING TEST D.9 ASKS FOR IS THE PAIR — a hand-registered body giving `hermetic: false`
 * with its taskId in `liveBodies`, and the identical graph whose body is published through
 * `ResourceStore` giving `hermetic: true`, so the assertion cannot be satisfied by a field that
 * is now always false. It cannot be written until both lines above land, and it is named here so
 * that whoever lands them knows the shape it has to take.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type FunctionBody } from "../../src/run/registry.ts";
import { compileRealm, isRealmBounded, type RealmOptions } from "../../src/resources/realm.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { ReplayEffects, replayRun } from "../../src/run/replay.ts";
import { ResourceStore } from "../../src/resources/store.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

/**
 * `Math.random` REPLACED AHEAD OF THE BODY, exactly as `functions.ts`'s `seedingRandom` and
 * `hook-loader.ts`'s `denyingRandom` each splice it in — a body is an EXPRESSION and may run code
 * at definition time, so the assignment has to be the wrapper's first statement.
 *
 * Written out here rather than imported because it is what a realm must DO to be branded, and a
 * test that imports the production spelling cannot notice the day it stops happening. The third
 * check is that `Math.random` is no longer the function the context shipped; `NO STUB` below is
 * the same realm without this line, and it is refused.
 */
const DENY_DRAW = `Math.random = function () { throw new Error('no seed'); };`;

/** A realm whose bridge just hands the parsed payload to the body. Enough to get a `RealmCall`. */
function realm(globals?: Record<string, unknown>, source = `(a, b) => ({ ok: 1 })`): ReturnType<typeof compileRealm> {
  const opts: RealmOptions = {
    source: `(function () { ${DENY_DRAW} return (${source}); })()`,
    label: "probe",
    what: "function",
    bridge: `globalThis.__e = function (p) { return globalThis.__loomBody(JSON.parse(p), {}); };`,
    entry: "__e",
    compileTimeoutMs: 1000,
    callTimeoutMs: 1000,
    ...(globals === undefined ? {} : { globals }),
  };
  return compileRealm(opts);
}

// ── 1 · the brand ────────────────────────────────────────────────────────────

test("A REALM-COMPILED CALL IS BRANDED, and the brand leaves no trace on the call", () => {
  const call = realm();
  assert.equal(isRealmBounded(call), true, "compileRealm did not brand what it returned");
  // The brand is membership in a module-private `WeakSet`, not a mark travelling on the value, so
  // the call carries no key of any kind that a reader could find — see the copying test below for
  // why that is the security property and not a tidiness one.
  assert.deepEqual(Object.keys(call), []);
  assert.deepEqual(Object.getOwnPropertyNames(call).filter((n) => n !== "length" && n !== "name"), []);
  assert.deepEqual(Object.getOwnPropertySymbols(call), []);
});

test("A REALM CARRYING EMBEDDER GLOBALS IS REFUSED THE BRAND, rather than inspected", () => {
  // `RealmOptions.globals` is a VALUE seam and `refuseGovernedGlobals` reads NAMES, so whatever
  // survives the name check arrives in the body as the very host object that was passed —
  // `realm.ts` measures `{MY_DATE: Date}` giving a live wall clock and `{LOOKUP: {a: 1}}` giving
  // `LOOKUP.constructor.constructor("return typeof process")()` → `"object"`. Deciding whether a
  // particular passed-in object is inert is the problem the design refuses to build, so the
  // answer is a refusal.
  assert.equal(isRealmBounded(realm({ TENANT: "t1" })), false, "a realm with globals was vouched for");
  // An EMPTY bag is not a door: nothing was passed, so nothing is unvetted.
  assert.equal(isRealmBounded(realm({})), true, "an empty globals bag cost the brand");
});

test("A HOST VALUE SMUGGLED UNDER A SYMBOL KEY COSTS THE BRAND — the input that made it a check", () => {
  // BLOCKING FINDING, REPRODUCED AS A TEST. The stamp used to read `Object.keys(opts.globals)`,
  // which yields no symbols, while `Object.assign` copies them — so this exact bag reported
  // length 0, KEPT THE BRAND, and put the host `Date` on the realm's `globalThis`. Measured
  // through `compileRealm` on the tree before the fix, one call:
  //
  //     Object.keys(globals).length                          → 0
  //     isRealmBounded(call)                                 → true        ← the brand
  //     body: Object.getOwnPropertySymbols(globalThis)        → ["Symbol(MY_DATE)"]
  //           D.now() > 1.7e12                                → true       (a live wall clock)
  //           D.constructor.constructor("return typeof process")()  → "object"  (the HOST realm)
  //
  // `hermetic: true` on a run that is not reproducible, which is the one direction this may not
  // be wrong in.
  const bag: Record<string, unknown> = {};
  Object.defineProperty(bag, Symbol("MY_DATE"), { value: Date, enumerable: true, writable: true, configurable: true });
  assert.equal(Object.keys(bag).length, 0, "the bag stopped being invisible to Object.keys — pick another spelling");
  assert.equal(isRealmBounded(realm(bag)), false, "a host Date under a symbol key was vouched for");

  // AND THE SPELLING A `Reflect.ownKeys` ARGUMENT TEST WOULD STILL HAVE MISSED. `Promise` is not
  // in `SAFE_GLOBAL_NAMES`, so `refuseGovernedGlobals` allows it and `Object.assign` overwrites
  // the context's own `Promise` with the HOST's — an existing name, no new key, and a host object
  // in the realm either way. Only a check on the NAMESPACE sees it.
  assert.equal(isRealmBounded(realm({ Promise })), false, "the host Promise was vouched for");
});

test("THE THREE CHECKS ARE READ OFF THE FINISHED REALM, not off the arguments it was built from", () => {
  // A body is an EXPRESSION and runs at definition time, so each of these is a legal `function`
  // resource that undoes one of the three properties AFTER `compileRealm` has set it up. The old
  // stamp — a branch on `opts.globals` — kept the brand through all four.
  const undoes = (statement: string): boolean =>
    isRealmBounded(
      compileRealm({
        source: `(function () { ${DENY_DRAW} ${statement} return ((a, b) => ({ ok: 1 })); })()`,
        label: "probe",
        what: "function",
        bridge: `globalThis.__e = function (p) { return globalThis.__loomBody(JSON.parse(p), {}); };`,
        entry: "__e",
        compileTimeoutMs: 1000,
        callTimeoutMs: 1000,
      }),
    );
  assert.equal(undoes(`globalThis.Date = { now: function () { return 7; } };`), false, "Date came back, branded");
  assert.equal(undoes(`globalThis.Intl = {};`), false, "Intl came back, branded");
  assert.equal(undoes(`globalThis.Math = { random: function () { return 0.5; } };`), false, "Math swapped, branded");
  // AN ACCESSOR, not a data property — the shape a plain `context.Date` read would have run on
  // the HOST THREAD, outside the `vm` timeout that bounds everything else. The check reads
  // descriptors for that reason, and a slot with no `value` is refused rather than inspected.
  assert.equal(
    undoes(`Object.defineProperty(globalThis, 'Date', { get: function () { return {}; }, configurable: true });`),
    false,
    "a Date getter was vouched for",
  );

  // NO STUB — the realm's `Math.random` is still the platform's, so the body's draws are not
  // reproducible and the brand is refused. Both in-tree loaders splice the replacement in; a
  // third-party bridge that forgets loses the brand rather than silently claiming determinism.
  assert.equal(
    isRealmBounded(
      compileRealm({
        source: `(a, b) => ({ ok: 1 })`,
        label: "probe",
        what: "function",
        bridge: `globalThis.__e = function (p) { return globalThis.__loomBody(JSON.parse(p), {}); };`,
        entry: "__e",
        compileTimeoutMs: 1000,
        callTimeoutMs: 1000,
      }),
    ),
    false,
    "a realm holding the platform's Math.random was vouched for",
  );
});

test("EVERYTHING THE RUNTIME DID NOT MAKE ANSWERS `false` — absence of evidence is not evidence", () => {
  // The fail-closed direction, over the whole set a caller can reach. Nothing here can make the
  // answer `true` by accident, which is the property that lets a report rest on it.
  assert.equal(isRealmBounded(() => ({})), false, "a hand-registered host closure was vouched for");
  assert.equal(isRealmBounded(function named() {}), false);
  assert.equal(isRealmBounded(class {}), false);
  assert.equal(isRealmBounded({}), false);
  assert.equal(isRealmBounded(undefined), false);
  assert.equal(isRealmBounded(null), false);
  assert.equal(isRealmBounded("compileRealm"), false);
  // A `Proxy` whose traps throw. `WeakSet.has` runs none of them — it reads no property and
  // consults no trap — so this is not a fail-closed catch, it is a stranger getting a stranger's
  // answer. Pinned anyway: the day someone rewrites the read as a property test, this goes red.
  const hostile = new Proxy(() => ({}), {
    has() {
      throw new TypeError("no");
    },
    get() {
      throw new TypeError("no");
    },
    getOwnPropertyDescriptor() {
      throw new TypeError("no");
    },
  });
  assert.equal(isRealmBounded(hostile), false, "a value the host cannot inspect was vouched for");
});

test("THE BRAND CANNOT BE COPIED OFF A BRANDED CALL — the three routes, measured", () => {
  // THE ATTACK THAT KILLED THE FIRST SPELLING. D.9 specifies a module-private `Symbol()` stamped
  // with `Object.defineProperty`, on the argument that "nothing outside this file can name it, so
  // nothing outside this file can claim it". That is false: a symbol used as a PROPERTY KEY is
  // carried by the object, so any holder reads it back with `getOwnPropertySymbols` and copies it
  // anywhere. Measured against that spelling, all three of these answered `true`.
  //
  // A `WeakSet` writes nothing onto the object, so there is nothing to enumerate and nothing to
  // copy, and `has` walks no prototype chain. These three are the routes, not a sample: a symbol
  // can only be reached by enumerating the object's own keys (1 and 2) or inherited from an
  // object that has it (3).
  const branded = realm();
  assert.deepEqual(Object.getOwnPropertySymbols(branded), [], "the brand is a property again — it is copyable");

  const viaSymbols = () => ({ nondeterministic: Date.now() });
  for (const s of Object.getOwnPropertySymbols(branded)) {
    Object.defineProperty(viaSymbols, s, { value: true, enumerable: false, configurable: true });
  }
  assert.equal(isRealmBounded(viaSymbols), false, "getOwnPropertySymbols bought the brand");

  const viaReflect = () => ({});
  for (const k of Reflect.ownKeys(branded)) {
    if (typeof k === "symbol") Object.defineProperty(viaReflect, k, { value: true, configurable: true });
  }
  assert.equal(isRealmBounded(viaReflect), false, "Reflect.ownKeys bought the brand");

  // `in` walks the prototype chain; `WeakSet.has` does not. This is why the read is membership
  // and not a property test.
  const viaPrototype = Object.setPrototypeOf(() => ({}), branded);
  assert.equal(isRealmBounded(viaPrototype), false, "inheriting from a branded call bought the brand");
});

test("AND NO SYMBOL A CALLER CAN NAME BUYS IT EITHER — the `Symbol.for` route D.9 rejects", () => {
  // The discriminator D.9 turns on, kept as its own case because it is a different attacker:
  // `engine.ts`'s `REBIND_DEADLINE` is `Symbol.for("@loom/core:function.rebindDeadline")` —
  // globally reachable, spelled out in two files — so an embedder can stamp it on a host closure.
  const spoof = () => ({});
  for (const key of [
    "",
    "REALM_BOUND",
    "@loom/core:realm.bound",
    "@loom/core:realmBound",
    "@loom/core:function.realmBound",
    "@loom/core:function.rebindDeadline",
  ]) {
    Object.defineProperty(spoof, Symbol.for(key), { value: true, enumerable: false, configurable: true });
  }
  // And the well-known symbols, for completeness of the set a caller can reach without importing.
  for (const name of Object.getOwnPropertyNames(Symbol)) {
    const s = (Symbol as unknown as Record<string, unknown>)[name];
    if (typeof s === "symbol") {
      try {
        Object.defineProperty(spoof, s, { value: true, enumerable: false, configurable: true });
      } catch {
        // A non-configurable well-known slot. Not a route to the brand either.
      }
    }
  }
  assert.equal(isRealmBounded(spoof), false, "a symbol a caller can name bought the brand");
});

test("THE LOADER'S WRAPPER IS NOT BRANDED — measured, and it is why the wiring is unfinished", () => {
  // This is the second of the two missing lines, asserted rather than asserted-about. D.9's shape
  // says to stamp "the body it returns", but `compileRealm` returns a `RealmCall` and both loaders
  // return a CLOSURE OVER it — which is the object `Engine.#functionBody` holds. So the brand does
  // not reach the call site that would read it.
  //
  // When `functions.ts` carries the brand across, this assertion flips and its author is sent to
  // `ReplayReport.hermetic` to delete the paragraph that says the field is still inert.
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind: "function", name: "b", content: `(v, c) => ({})`, actor: ACTOR });
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
  const body = createFunctionLoader({ store }).load("function/b@stable");
  assert.ok(body !== undefined);
  assert.equal(
    isRealmBounded(body),
    false,
    "functions.ts now carries the brand onto its wrapper — rewrite ReplayReport.hermetic's docstring",
  );
});

// ── 2 · the accumulator ──────────────────────────────────────────────────────

test("`bodyEntered` RECORDS ONLY THE UNVOUCHED-FOR, and reports them sorted and deduped", () => {
  const e = new ReplayEffects();
  assert.deepEqual(e.liveBodies, [], "a replay that entered no body reported one");
  // A branded body re-executes too — that is deliberate, and it is the only thing that catches a
  // body regression. What `liveBodies` names is the narrower set.
  e.bodyEntered("score@root#0", true);
  assert.deepEqual(e.liveBodies, [], "a vouched-for body was reported as live");
  e.bodyEntered("b@root#0", false);
  e.bodyEntered("a@root#0", false);
  // The same task twice is one task: a retry re-enters the body and must not double-count.
  e.bodyEntered("a@root#0", false);
  assert.deepEqual(e.liveBodies, ["a@root#0", "b@root#0"]);
});

// ── 2b · the conjunct, through a real replay ─────────────────────────────────

/**
 * One `function` node whose body is HAND-REGISTERED — a host closure, which is precisely the
 * thing `isRealmBounded` answers `false` for.
 */
function oneFunctionNode(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "live", project: "t", version: 1 },
    channels: { out: { type: "string", reduce: "replace" } },
    inputs: [],
    nodes: [{ id: "fn" as NodeId, type: "function", writes: ["out"], function: { ref: "function/host@stable" } }],
    edges: [],
    outputs: ["out"],
  };
}

test("A REPLAY THAT RE-EXECUTED AN UNVOUCHED-FOR BODY REPORTS `hermetic: false` — driven, not composed", async () => {
  // THE REVIEW FINDING THIS REPLACES: the previous version of this case rebuilt
  // `unknownOutcomes.length === 0 && derivedClocks.length === 0 && liveBodies.length === 0` inside
  // the test and asserted on THAT. Deleting `&& effects.liveBodies.length === 0` from
  // `run/replay.ts` left all nine tests in this file green — a test built from the same mental
  // model as the fix certifies the model, not the mechanism. This one reads `hermetic` off a
  // report `replayRun` produced, so the mutation goes red.
  //
  // WHAT IS REAL AND WHAT IS A STAND-IN, stated because the difference is the remaining gap.
  // Real: the run, the journal, the graph, the `replayRun` call, the body (a host closure), its
  // `taskId` (taken from the recorded projection), the `isRealmBounded` answer, and the
  // `hermetic` expression under test. A stand-in: the CALL SITE. Nothing in `src/` calls
  // `bodyEntered` yet — the census below pins that — so the one thing this test supplies is the
  // invocation `Engine.#functionBody` will make, with both of its arguments computed for real.
  // When that line lands, delete the `fromStore` patch and this test keeps its assertions.
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const resources = new ResourceStore({ now: () => 1 });
  const body: FunctionBody = () => ({ writes: { out: "constant" } });
  assert.equal(isRealmBounded(body), false, "the host closure this test rests on was branded");
  const functions = new FunctionRegistry();
  functions.register("function/host@stable", body);
  // The REF has to resolve for the graph to compile, and a hand-registered body WINS over a
  // loaded one — `FunctionRegistry.get` says so, and `isRealmBounded` below is asserted on what
  // `require` actually returns rather than on which of the two this comment expects.
  const published = resources.publish({ kind: "function", name: "host", content: `(v, c) => ({})`, actor: ACTOR });
  resources.promote(published, "canary", ACTOR);
  resources.promote(published, "stable", ACTOR);
  const graph = compileOrThrow({ spec: oneFunctionNode(), resolver: resources, tools: {}, tenantCapabilities: [] });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus(),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    resolver: resources,
    now: () => 1_700_000_000_000,
  });
  const runId = await engine.submit({ graph, inputs: {} });
  const recorded = await engine.advance(runId);
  assert.equal(recorded.status, "succeeded", JSON.stringify(recorded.error ?? {}));
  const taskIds = Object.keys(recorded.tasks);
  assert.deepEqual(taskIds, ["fn@root#0"], "the graph stopped producing exactly one task");

  const opts = { store, runId, graph, engine: { tools: new ToolRegistry(), functions, models: new ModelRegistry() } };

  // THE CONTROL, FIRST AND FROM THE SAME JOURNAL. Without it "hermetic is false" is satisfiable
  // by a replay that diverged for some other reason, and the claim "because of the body" would
  // rest on nothing.
  const control = await replayRun(opts);
  assert.equal(control.match, true, JSON.stringify(control.frames.filter((f) => !f.match)));
  assert.deepEqual(control.liveBodies, []);
  assert.equal(control.hermetic, true, "the baseline replay was already non-hermetic");

  const original = ReplayEffects.fromStore;
  let entered: string | undefined;
  ReplayEffects.fromStore = async (s, r) => {
    const e = await original.call(ReplayEffects, s, r);
    // Both arguments computed, not asserted: the body is the one the replay's own registry will
    // hand the engine, and the taskId is the one the recording holds.
    entered = taskIds[0]!;
    e.bodyEntered(entered, isRealmBounded(functions.require("function/host@stable")));
    return e;
  };
  let report;
  try {
    report = await replayRun(opts);
  } finally {
    ReplayEffects.fromStore = original;
  }

  // EVERYTHING ELSE AGREED. Same journal, same graph, same registry as the control — so `match`
  // is still true and `hermetic` moved for exactly one reason, which is the reason it names.
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.deepEqual(report.unservedEffects, []);
  assert.deepEqual(report.liveBodies, [entered], "the report did not name the body it could not vouch for");
  assert.equal(report.hermetic, false, "a body the runtime could not vouch for did not falsify hermetic");
});

test("ONE UNVOUCHED-FOR BODY IS ENOUGH — the conjunct is an AND, not a majority", () => {
  // The narrow claim the driven test above cannot make on its own: it is the LENGTH that matters,
  // so a replay that entered one vouched-for body and one unvouched-for body is still non-
  // hermetic. Kept as an accumulator-level case because constructing a second, branded
  // `FunctionBody` is not possible from outside `realm.ts` — the brand has no exported adder,
  // which is the property `THE BRAND CANNOT BE COPIED OFF A BRANDED CALL` exists to keep.
  const e = new ReplayEffects();
  e.bodyEntered("vouched@root#0", true);
  assert.deepEqual(e.liveBodies, []);
  e.bodyEntered("live@root#0", false);
  assert.deepEqual(e.liveBodies, ["live@root#0"], "the unvouched-for body was hidden by the vouched-for one");
});

// ── 3 · the gap, as a census ─────────────────────────────────────────────────

const SRC = new URL("../../src/", import.meta.url).pathname;

/** Every `.ts` under `src/`, recursively, as `[relativePath, text]`. */
function sources(): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const en of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === "" ? en.name : `${prefix}/${en.name}`;
      if (en.isDirectory()) walk(join(dir, en.name), rel);
      else if (en.name.endsWith(".ts")) out.push([rel, readFileSync(join(dir, en.name), "utf8")]);
    }
  };
  walk(SRC, "");
  return out;
}

/** Strip block and line comments, so a docstring naming `bodyEntered` is not a call site. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

test("NOTHING IN `src/` CALLS `bodyEntered` YET — so `hermetic`'s third term is inert", () => {
  // Read this failing as GOOD NEWS and then finish the job: the term now has a producer, so
  // `ReplayReport.hermetic` and `ReplayEffects.liveBodies` both carry a paragraph saying it does
  // not, and both are now false. Delete them, and replace this census with D.9's pair — a
  // hand-registered body giving `hermetic: false` with its taskId in `liveBodies`, and the same
  // graph loaded from a `ResourceStore` giving `hermetic: true`.
  //
  // The declaration in `run/replay.ts` is not a call, so it is excluded by matching the call
  // shape `bodyEntered(` preceded by a `.` — which is how every caller must spell it.
  const callers = sources()
    .filter(([, text]) => /\.bodyEntered\s*\(/.test(code(text)))
    .map(([rel]) => rel);
  assert.deepEqual(
    callers,
    [],
    "bodyEntered now has a caller — rewrite ReplayReport.hermetic and ReplayEffects.liveBodies, " +
      "and replace this census with the paired proving test D.9 names",
  );
});
