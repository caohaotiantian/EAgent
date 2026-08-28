/**
 * `intoHostRealm` IS WHERE AN EXTENSION'S VALUE ENTERS THE HOST, AND IT HAD NO GUARD.
 *
 * Property 2 says an extension can reach everywhere the kernel can. The price of that is that
 * every value a body returns is inspected on the HOST thread, by host code, and three of the
 * reads the rebuild makes are not total. Measured on the tree before this file existed, a hook
 * body and a function body each returning `Proxy.revocable({a:1},{}).proxy` after revoking it:
 *
 *     TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
 *
 * `Object.getPrototypeOf` and `Object.entries` throw on the same value one and two lines later,
 * and `redact.ts`, `run/delivery.ts` and `telemetry/spans.ts` each carry a private `isList`
 * because of it. A self-referential return is the same class through a different door: `o.self =
 * o` from a hook body gave `RangeError: Maximum call stack size exceeded`. Neither reached a
 * caller as anything that named the resource, the kind, or the boundary.
 *
 * ## The reachable set, stated because the sweep it rules out is 103 sites of churn
 *
 * A revoked `Proxy` cannot come out of `JSON.parse`. The values at risk are exactly the ones an
 * IN-PROCESS extension hands back: `function` bodies, `hook` bodies and MCP tool results. CLI
 * flag parsing and HTTP body parsing are not on that list and are left alone. This file covers
 * the two loaders; `run/hooks.ts`, `run/context.ts` and `mcp/tools.ts` are the rest of the set.
 *
 * ## Refusing, not degrading
 *
 * `run/delivery.ts` answers the same question the other way — a value it cannot read renders as
 * `(unrenderable)` — and it is right to, because it is printing for a channel. Here the value is
 * on its way to the canonicalizer and the journal, so passing it on means the same throw
 * further downstream with nothing left naming the resource that produced it. A guard that cannot
 * decide what a value IS refuses it.
 *
 * ## What is NOT closed, so the guard is not mistaken for a bigger one
 *
 * A trap or getter that SPINS rather than throwing. `Object.entries` on a `Proxy` whose `ownKeys`
 * never returns is user code on the host thread with the vm's deadline already satisfied, and no
 * `try` reaches it — the same limit `THENABLE_RULE` states about a continuation. It is untested
 * here because a test for it would not terminate, which is precisely the point. Code resources
 * are A13 trusted; what this catches is the value that arrives by mistake.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { createHookLoader } from "../../src/resources/hook-loader.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { intoHostRealm } from "../../src/resources/realm.ts";
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
const SPECS: Record<string, ChannelSpec> = { out: { type: "number", reduce: "replace" } };
const VIEW = makeStateView(SPECS, {}, ["out"]);
const FCTX = { taskId: "t@root#0" as never, signal: new AbortController().signal, now: () => 1, seed: 7 };

const hook = (source: string) => createHookLoader({ store: storeWith(source, "hook") }).load("hook/b@stable")!;
const fn = (source: string) =>
  createFunctionLoader({ store: storeWith(source, "function") }).load("function/b@stable")!;

/** The thrown value as `{code, message}`, or `undefined` if the call returned. */
function refusal(call: () => unknown): { code: string; message: string } | undefined {
  try {
    call();
    return undefined;
  } catch (e) {
    assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
    return { code: e.code, message: e.message };
  }
}

/** One revoked proxy, spelled the same way in every body below. */
const REVOKE = `var r = Proxy.revocable({ a: 1 }, {}); r.revoke();`;

// ── the value that throws when the host looks at it ──────────────────────────

test("A HOOK BODY RETURNING A REVOKED PROXY IS REFUSED, and the refusal names the resource", () => {
  // Before: `TypeError: Cannot perform 'get' on a proxy that has been revoked`, out of the
  // return guard's own `then` read, naming nothing.
  const r = refusal(() => hook(`(input, ctx) => { ${REVOKE} return r.proxy; }`)({}, CTX));
  assert.ok(r !== undefined, "a revoked proxy crossed the hook seam");
  assert.equal(r.code, CODES.E_RESOURCE_INVALID);
  assert.match(r.message, /hook resource "hook\/b@stable"/, r.message);
  assert.match(r.message, /returned a value the host cannot rebuild/, r.message);
});

test("A FUNCTION BODY RETURNING ONE NESTED IN ITS WRITES IS REFUSED TOO", () => {
  // The other entry: the top-level value is an ordinary object, so the seam's first read
  // succeeds and the REBUILD is what meets the proxy, one level down. Same sentence.
  const r = refusal(() => fn(`(view, ctx) => { ${REVOKE} return { writes: { out: r.proxy } }; }`)(VIEW, FCTX));
  assert.ok(r !== undefined, "a revoked proxy crossed the function seam");
  assert.equal(r.code, CODES.E_RESOURCE_INVALID);
  assert.match(r.message, /function resource "function\/b@stable"/, r.message);
  assert.match(r.message, /returned a value the host cannot rebuild/, r.message);
});

test("the two loaders say the same sentence, byte-identical apart from the kind", () => {
  // The discipline `ASYNC_RULE` and `THENABLE_RULE` are held to: one rule at one seam is only
  // demonstrably one rule if both callers say it identically.
  const src = `(a, b) => { ${REVOKE} return { writes: { out: r.proxy } }; }`;
  const h = refusal(() => hook(src)({}, CTX));
  const f = refusal(() => fn(src)(VIEW, FCTX));
  assert.ok(h !== undefined && f !== undefined);
  assert.equal(
    h.message.replace(`hook resource "hook/b@stable"`, "X"),
    f.message.replace(`function resource "function/b@stable"`, "X"),
  );
});

test("THE FIRST READ AND THE REBUILD SAY THE SAME RULE — two doors, one sentence", () => {
  // A proxy returned directly is refused by the guard INSIDE the context, where `then` cannot be
  // read; nested one level down it is refused by the host-side rebuild. Different code, and a
  // reader must not have to learn that the two mean the same thing, so only the trailing reason
  // may differ.
  const direct = refusal(() => hook(`(input, ctx) => { ${REVOKE} return r.proxy; }`)({}, CTX));
  const nested = refusal(() => hook(`(input, ctx) => { ${REVOKE} return { bad: r.proxy }; }`)({}, CTX));
  assert.ok(direct !== undefined && nested !== undefined);
  const rule = (m: string) => m.slice(0, m.lastIndexOf(" — "));
  assert.equal(rule(direct.message), rule(nested.message));
});

test("A SELF-REFERENTIAL RETURN IS REFUSED, not a stack overflow", () => {
  // Same class, different door: measured before the guard, `RangeError: Maximum call stack size
  // exceeded` out of the rebuild's own recursion, naming nothing. One `try` around the whole
  // walk is why this is covered without a cycle check — any throw from any read is the refusal.
  const r = refusal(() => hook(`(input, ctx) => { var o = {}; o.self = o; return o; }`)({}, CTX));
  assert.ok(r !== undefined, "a cyclic return crossed the seam");
  assert.equal(r.code, CODES.E_RESOURCE_INVALID);
  assert.match(r.message, /returned a value the host cannot rebuild/, r.message);
});

test("a getter that throws during the rebuild is refused, and the reason survives", () => {
  // `Object.entries` runs the body's getters on the host thread. The refusal carries what the
  // read raised, because "cannot rebuild" without a cause sends its reader to the wrong file.
  const r = refusal(() =>
    hook(
      `(input, ctx) => { var o = {}; Object.defineProperty(o, "x", { get: function () { throw new Error("boom"); }, enumerable: true }); return o; }`,
    )({}, CTX),
  );
  assert.ok(r !== undefined);
  assert.match(r.message, /boom/, r.message);
});

// ── and what the guard must NOT change ───────────────────────────────────────

test("intoHostRealm still rebuilds what it always rebuilt", () => {
  // The refusal is on the THROW, not on the shape. Everything that crossed before still crosses,
  // and still comes back wearing the host's prototypes — the property this function exists for.
  const out = intoHostRealm({ a: 1, b: [{ c: "s" }], d: null }) as Record<string, unknown>;
  assert.deepEqual(out, { a: 1, b: [{ c: "s" }], d: null });
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.getPrototypeOf(out["b"] as object), Array.prototype);
  assert.equal(intoHostRealm(7), 7);
  assert.equal(intoHostRealm(undefined), undefined);
  assert.equal(intoHostRealm(null), null);
});

test("a non-plain value STILL PASSES THROUGH — the canonicalizer's message is the better one", () => {
  // Documented behaviour, and refusing here would have stolen a clearer error from downstream.
  const m = new Map([["a", 1]]);
  assert.equal(intoHostRealm(m), m);
  const f = () => 1;
  assert.equal(intoHostRealm(f), f);
});

test("A BODY'S OWN THROW IS NOT REPLACED BY A FAILURE ABOUT PROXIES", () => {
  // `functions.ts` reads `.code` off whatever a body threw, to tell a vm timeout from everything
  // else. Bare, that read raised `TypeError: Cannot perform 'get' on a proxy that has been
  // revoked` when the body threw a revoked proxy — the loader's own read failing, and the body's
  // failure lost. Guarded, "cannot decide" means "not a timeout" and the thrown value is
  // rethrown untouched, which is what this asserts: the value that comes out is still the proxy.
  let thrown: unknown = "nothing was thrown";
  try {
    fn(`(view, ctx) => { ${REVOKE} throw r.proxy; }`)(VIEW, FCTX);
  } catch (e) {
    thrown = e;
  }
  assert.throws(
    () => (thrown as { code?: unknown }).code,
    /revoked/,
    "the loader replaced the body's thrown value with one of its own",
  );
});
