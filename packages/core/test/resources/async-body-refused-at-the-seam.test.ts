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
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { ResourceStore } from "../../src/resources/store.ts";
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

function loadHook(source: string) {
  return createHookLoader({ store: storeWith(source, "hook") }).load("hook/b@stable");
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

test("a synchronous hook body that RETURNS a promise is not refused at load", () => {
  // Stated so the boundary is not mistaken for a bigger one. `functions.ts` catches this
  // second shape when the body RETURNS, and its own docstring says why that does not make the
  // failure timely. The hook loader has no such check and this test does not add one — it
  // pins what IS true today so the next reader does not assume the load-time refusal covers
  // both shapes.
  const body = loadHook(`(input, ctx) => Promise.resolve({ late: true })`);
  assert.ok(body !== undefined, "a thenable-returning hook body loads");
});
