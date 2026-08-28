/**
 * F36 WAS ENFORCED IN ONE LOADER OF TWO.
 *
 * `resources/functions.ts` refuses an `async` body at load, and argues it at length: `vm`'s
 * per-call `timeout` interrupts SYNCHRONOUS execution only, so an async body satisfies it by
 * returning at its first `await` and its continuation resumes on the microtask queue where no
 * timer, no `AbortSignal` and no deadline reach it. `resources/hook-loader.ts` contained zero
 * occurrences of the word `async`, and both loaders reach the same `compileRealm`.
 *
 * ## Driven both ways before choosing a direction
 *
 * The refusal is only right if an async HOOK body is actually harmful — if one merely worked,
 * `functions.ts`'s refusal would have been the thing to question. It works, and it is harmful.
 *
 * IT WORKS. `runFilters` does `await h.body(value, ctx)`, and `HookBody` is typed
 * `=> Promise<unknown> | unknown`. Measured through the real dispatcher on
 * `async (input, ctx) => ({seen: input.tool, marked: true})`:
 *
 *     runFilters value: {"seen":"fs.read","marked":true}   changedBy: ["hook/memo@stable"]
 *
 * IT IS HARMFUL, TWICE. (1) `callTimeoutMs` stops binding. Measured with `callTimeoutMs: 100`
 * and a body that spins `for (let n = 0; n < 4e9; n++) {}` AFTER an `await 0`: it returned
 * `{"spun":true}` normally at 1,949 ms. The identical body written synchronously threw
 * `Script execution timed out after 100ms` at 103 ms. With `while (true) {}` in the
 * continuation the call never returns at all — the shape `functions.ts` measured and SIGKILLed
 * at 25 s. (2) The resolved value skips `intoHostRealm`. That function rebuilds a cross-realm
 * object with the host's intrinsics and passes anything else through untouched; a cross-realm
 * `Promise` is "anything else", so `await` unwraps it AFTER the rebuild step is behind it.
 * Measured on the same loader:
 *
 *     async body result   Object.getPrototypeOf(v) === Object.prototype → false
 *     sync  body result   Object.getPrototypeOf(v) === Object.prototype → true
 *
 * A vm-context object reaching the host is the exact class of leak `intoHostRealm` exists to
 * close.
 *
 * ## Why the rule moved to `realm.ts` instead of being copied
 *
 * `SHAPE_RULE` is already there, and its own docstring names this: "Two copies of this rule in
 * two loaders is exactly how those two files came to disagree about async bodies." So the fix
 * is the seam, and `ARGUMENT_BRIDGE`'s in-context copy is deleted rather than joined by a
 * second one.
 *
 * Moving it host-side also strictly widens what is caught. `ARGUMENT_BRIDGE` read
 * `__loomBody.constructor.name`; the seam reads that AND `Object.prototype.toString.call`,
 * and each catches a body the other misses. Measured across a `vm` boundary:
 *
 *     shadowed ctor      ctor: Nope           toString: [object AsyncFunction]
 *     shadowed toStringTag  ctor: AsyncFunction  toString: [object Function]
 *
 * Neither is a security check — a code resource is A13 trusted — and both are stated so the
 * next reader does not mistake the pair for one.
 *
 * ## THE RESIDUE THIS FILE USED TO PIN, AND NOW CLOSES
 *
 * The last test here asserted that "a synchronous hook body that RETURNS a promise is not
 * refused at load" and said so deliberately: `ASYNC_RULE` decides from the body's PROTOTYPE, and
 * `function () { return new Promise(…) }` has the ordinary Function prototype. `functions.ts`
 * caught that second shape host-side when the body returned; `hook-loader.ts` had no equivalent,
 * so the hole `ASYNC_RULE` closed for hook bodies stayed open one shape over. Measured through
 * the hook loader at `callTimeoutMs: 100`, before `THENABLE_RULE`:
 *
 *     (input) => new Promise(res => res({late: true}))
 *       returned [object Promise] in 0 ms; resolved {"late":true};
 *       Object.getPrototypeOf(resolved) === Object.prototype  →  false
 *     (input) => new Promise(res => res(0)).then(() => { for (var n=0;n<4e9;n++){} … })
 *       returned in 0 ms, resolved at 1,948 ms
 *     the same spin written synchronously
 *       threw `Script execution timed out after 100ms` at 102 ms
 *
 * Both harms `ASYNC_RULE` names, reached by the shape it does not name. It is refused at the
 * seam now, when the body RETURNS, and `functions.ts`'s copy is deleted rather than joined —
 * the move `ARGUMENT_BRIDGE`'s async check already made.
 *
 * AND THE TEST IS RUN INSIDE THE CONTEXT, which is a claim with its own test below. `typeof
 * v.then` is a property read, and `then` may be a getter; host-side, after `runInContext` has
 * returned, that getter is user code on the host thread with the vm's timeout already satisfied
 * — the hazard that moved `isAsyncBody` off `.constructor`. In-context it is terminated like any
 * other synchronous work, and the two placements do not merely differ in TIMING: host-side the
 * spin runs to completion and the call SUCCEEDS, in-context it raises the deadline's own error.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { makeStateView, type ChannelSpec } from "../../src/state/channels.ts";
import type { HookContext } from "../../src/run/hooks.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

function storeWith(source: string, kind: "hook" | "function") {
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind, name: "b", content: source, actor: ACTOR });
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
  return store;
}

const CTX: HookContext = { point: "preNode", runId: "run_1", signal: new AbortController().signal };

/** What a `function` body is called with. No channels: none of these bodies reads one. */
const SPECS: Record<string, ChannelSpec> = { out: { type: "number", reduce: "replace" } };
const VIEW = makeStateView(SPECS, {}, ["out"]);
const FCTX = { taskId: "t@root#0" as never, signal: new AbortController().signal, now: () => 1, seed: 7 };

function loadHook(source: string, callTimeoutMs?: number) {
  return createHookLoader({
    store: storeWith(source, "hook"),
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
  }).load("hook/b@stable");
}
function loadFunction(source: string) {
  return createFunctionLoader({ store: storeWith(source, "function") }).load("function/b@stable");
}

/** The thrown value as `{code, message}`, or `undefined` if the call returned. */
function refusal(load: () => unknown): { code: string; message: string } | undefined {
  try {
    load();
    return undefined;
  } catch (e) {
    assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
    return { code: e.code, message: e.message };
  }
}

const ASYNC_BODIES: readonly (readonly [string, string])[] = [
  ["async arrow", `async (a, b) => ({ ok: 1 })`],
  ["async function expression", `async function (a, b) { return { ok: 1 }; }`],
  // Not a promise but the same unbounded shape: the continuation between yields is off the
  // vm's clock, and the object it returns is a cross-realm iterator `intoHostRealm` passes
  // through untouched.
  ["async generator", `async function* (a, b) { yield { ok: 1 }; }`],
  // A13 trusted code that hides behind an own `constructor`. `ARGUMENT_BRIDGE`'s check answered
  // `Nope` for this and let it through; `Object.prototype.toString` still says AsyncFunction.
  [
    "async body with a shadowed constructor",
    `(function () { const f = async (a, b) => ({ ok: 1 }); Object.defineProperty(f, "constructor", { value: function Nope() {} }); return f; })()`,
  ],
];

for (const [name, source] of ASYNC_BODIES) {
  test(`a HOOK body that is an ${name} is refused at load`, () => {
    const r = refusal(() => loadHook(source));
    assert.ok(r !== undefined, `an ${name} hook body loaded — the deadline cannot bound it`);
    assert.equal(r.code, CODES.E_RESOURCE_INVALID);
    assert.match(r.message, /async function body cannot be bounded/, r.message);
    assert.match(r.message, /hook resource "hook\/b@stable"/, r.message);
  });

  test(`a FUNCTION body that is an ${name} is refused at load`, () => {
    const r = refusal(() => loadFunction(source));
    assert.ok(r !== undefined, `an ${name} function body loaded`);
    assert.equal(r.code, CODES.E_RESOURCE_INVALID);
    assert.match(r.message, /async function body cannot be bounded/, r.message);
    assert.match(r.message, /function resource "function\/b@stable"/, r.message);
  });
}

test("the two loaders' refusals are byte-identical apart from the kind", () => {
  // The defect this file closes is two loaders disagreeing. One rule at one seam is only
  // demonstrably one rule if both callers say the same sentence.
  const src = `async (a, b) => ({ ok: 1 })`;
  const h = refusal(() => loadHook(src));
  const f = refusal(() => loadFunction(src));
  assert.ok(h !== undefined && f !== undefined);
  assert.equal(
    h.message.replace(`hook resource "hook/b@stable"`, "X"),
    f.message.replace(`function resource "function/b@stable"`, "X"),
  );
});

test("a SYNCHRONOUS hook body still loads and still runs", () => {
  // The refusal must not widen past the shape it was measured on. A plain body is the
  // overwhelming majority of them and would be a far worse regression than the hole.
  const body = loadHook(`(input, ctx) => ({ seen: input.tool, at: ctx.point })`);
  assert.ok(body !== undefined);
  assert.deepEqual(body({ tool: "fs.read" }, CTX), { seen: "fs.read", at: "preNode" });
});

// ── the second shape: synchronous at the seam, thenable on the way back ──────

const THENABLE_BODIES: readonly (readonly [string, string])[] = [
  ["a constructed promise", `(a, b) => new Promise(function (res) { res({ ok: 1 }); })`],
  ["a resolved promise", `(a, b) => Promise.resolve({ ok: 1 })`],
  ["a promise with a continuation", `(a, b) => Promise.resolve(0).then(function () { return { ok: 1 }; })`],
  // No `Promise` involved at all. `await` unwraps any object with a callable `then`, so a
  // check that looked for a Promise would let the same failure through wearing a literal.
  ["a hand-rolled thenable", `(a, b) => ({ then: function (res) { res({ ok: 1 }); } })`],
  // And `await` unwraps a thenable FUNCTION too — the same mistake at a different `typeof`,
  // and the one a check written as `typeof v === "object"` misses.
  ["a thenable function", `(a, b) => { var f = function () {}; f.then = function (r) { r({ ok: 1 }); }; return f; }`],
];

for (const [name, source] of THENABLE_BODIES) {
  test(`a HOOK body returning ${name} is refused WHEN IT RETURNS`, () => {
    const body = loadHook(source);
    // Load still succeeds, and that is not a gap: the body is synchronous, so there is nothing
    // at load to decide on. The shape only exists once a value comes back.
    assert.ok(body !== undefined, "a thenable-returning hook body still LOADS");
    const r = refusal(() => body({ tool: "fs.read" }, CTX));
    assert.ok(r !== undefined, `${name} crossed the hook seam — no deadline bounds its continuation`);
    assert.equal(r.code, CODES.E_RESOURCE_INVALID);
    assert.match(r.message, /returned a promise, and no deadline can bound one/, r.message);
    assert.match(r.message, /hook resource "hook\/b@stable"/, r.message);
  });

  test(`a FUNCTION body returning ${name} is refused WHEN IT RETURNS`, () => {
    const body = loadFunction(source);
    assert.ok(body !== undefined);
    const r = refusal(() => body(VIEW, FCTX));
    assert.ok(r !== undefined, `${name} crossed the function seam`);
    assert.equal(r.code, CODES.E_RESOURCE_INVALID);
    assert.match(r.message, /returned a promise, and no deadline can bound one/, r.message);
    assert.match(r.message, /function resource "function\/b@stable"/, r.message);
  });
}

test("the two loaders' THENABLE refusals are byte-identical apart from the kind", () => {
  // The same property the async refusals are held to, for the same reason: this rule was one
  // file's private check for as long as the async one was, and the hook loader is where that
  // showed. One seam is only demonstrably one seam if both callers say the same sentence.
  const src = `(a, b) => Promise.resolve({ ok: 1 })`;
  const h = refusal(() => loadHook(src)!({}, CTX));
  const f = refusal(() => loadFunction(src)!(VIEW, FCTX));
  assert.ok(h !== undefined && f !== undefined);
  assert.equal(
    h.message.replace(`hook resource "hook/b@stable"`, "X"),
    f.message.replace(`function resource "function/b@stable"`, "X"),
  );
});

test("THE `then` READ HAPPENS INSIDE THE CONTEXT, where the deadline still applies", () => {
  // The placement, asserted by its OUTCOME rather than by a stopwatch. `then` may be a getter.
  // Read host-side — where `functions.ts` read it — the getter runs after `runInContext` has
  // returned and the vm's timeout has been satisfied, so this body would spin to completion on
  // the host thread and the call would then SUCCEED, the property being `undefined`. Read as
  // part of the call expression, the same spin is synchronous work inside the realm and the
  // deadline terminates it.
  //
  // Not a `refusal()`: what comes back is `vm`'s own `Error`, which the hook loader passes
  // through untranslated — `functions.ts` is the caller that turns it into `E_TASK_TIMEOUT`.
  const body = loadHook(`(input, ctx) => ({ get then() { for (var n = 0; n < 4e9; n++) {} return undefined; } })`, 100);
  let thrown: unknown;
  try {
    body!({}, CTX);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown !== undefined, "a spinning `then` getter ran to completion — the read is host-side again");
  assert.match(String((thrown as Error).message), /timed out/i, String((thrown as Error).message));
});

test("A `then` GETTER THAT ANSWERS DIFFERENTLY EACH READ IS STILL CAUGHT", () => {
  // Found by attacking the in-context read rather than by reading it. That read is ONE read, and
  // the value controls it: answering `undefined` first and a function second put a callable
  // `then` in host hands with `Object.getPrototypeOf(v) === Object.prototype` true — measured,
  // before the second check existed. The second check reads the value that ACTUALLY crosses,
  // which is safe precisely because `intoHostRealm` has already invoked every getter and copied
  // the results, so nothing of the body's runs on this read.
  const body = loadHook(
    `(function () { var n = 0; return function (i, c) { return { get then() { n++; return n > 1 ? function (r) { r(1); } : undefined; } }; }; })()`,
  );
  const r = refusal(() => body!({}, CTX));
  assert.ok(r !== undefined, "a two-faced `then` getter crossed the seam");
  assert.equal(r.code, CODES.E_RESOURCE_INVALID);
  assert.match(r.message, /returned a promise, and no deadline can bound one/, r.message);
});

test("a body that shadows `Error` cannot reduce the refusal to a bare marker", () => {
  // The refusal crosses the vm boundary as a thrown value, and the first version built it with
  // `new Error(…)` — a binding a body can replace. Measured: a body installing an `Error` whose
  // `name` is non-writable turned this into a bare `LoomThenableReturn` at the caller. It still
  // FAILED, which is the property that matters, but the sentence is the other half of the job.
  // The marker is an object literal now, which consults no binding a body can reach.
  const body = loadHook(
    `(function () { var E = globalThis.Error; globalThis.Error = function (m) { var e = new E(m); ` +
      `Object.defineProperty(e, "name", { value: "Nope", writable: false, configurable: false }); return e; }; ` +
      `return function (i, c) { return Promise.resolve({ late: 1 }); }; })()`,
  );
  const r = refusal(() => body!({}, CTX));
  assert.ok(r !== undefined);
  assert.match(r.message, /hook resource "hook\/b@stable" returned a promise/, r.message);
});

test("a return that is merely SHAPED like a thenable is untouched", () => {
  // The refusal reads `typeof v.then === "function"`, which is what `await` reads. A `then`
  // that is data is not a thenable, and refusing it would be a guard widening past its rule.
  const body = loadHook(`(input, ctx) => ({ then: 1, ok: true })`);
  assert.deepEqual(body!({}, CTX), { then: 1, ok: true });
});

test("the guard does not mangle an ordinary return", () => {
  // The wrapper is on the value path of every call there is, so the cheap regression is the
  // one worth pinning: primitives, `undefined`, `null` and arrays all still come back.
  const cases: readonly (readonly [string, unknown])[] = [
    [`(i, c) => undefined`, undefined],
    [`(i, c) => null`, null],
    [`(i, c) => 0`, 0],
    [`(i, c) => false`, false],
    [`(i, c) => "s"`, "s"],
    [`(i, c) => [1, {a: 2}]`, [1, { a: 2 }]],
    [`(i, c) => ({ nested: { deep: [1, 2] } })`, { nested: { deep: [1, 2] } }],
  ];
  for (const [source, expected] of cases) {
    assert.deepEqual(loadHook(source)!({}, CTX), expected, source);
  }
});
