/**
 * Loading `hook` bodies from digest-addressed resources — the half of the extension surface
 * that was missing.
 *
 * `run/hooks.ts` opens with a promise: "A hook is a pinned Resource, never ambient global code.
 * It is loaded by the same digest-pinned, vm-sandboxed loader that `function` nodes use."
 * Nothing loaded them. `HookRegistry` was constructed nowhere in `src/` outside its own module,
 * `Engine.#hooks` was therefore `undefined` in every shipped path, and `#hooksFor` answered `[]`
 * for all eight points. A graph declaring `hooks: {preTool: ["hook/audit@stable"]}` compiled
 * clean, validated clean, pinned the ref into its resolution manifest, and ran with the hook
 * never firing — which is the exact "declared-and-never-invoked extension point" failure that
 * module's own docstring says it exists to close, reopened one layer down.
 *
 * This is that loader. It is deliberately thin: `compileRealm` does the hardening, and the only
 * things here that are specific to hooks are `HOOK_BRIDGE` — the few lines that turn a JSON
 * payload into `(input, ctx)` inside the context — and `DENY_RANDOM`, which is what makes
 * `HookContext`'s "no randomness" a fact rather than a wish.
 *
 * ## Why a hook body sees so little
 *
 * A hook gets JSON and nothing else. Not the engine, not the journal, not the resource store,
 * not a fetch. That is not an oversight to be relaxed later: a filter that could reach the
 * engine could lower a posture, and invariant 5's asymmetry has to hold for extensions or it
 * does not hold at all. An extension that needs to reach the world does it as a TOOL, behind a
 * manifest and a capability, where the policy engine can see it.
 *
 * ## The deadline, and the shape that used to escape it here and not next door
 *
 * `callTimeoutMs` is `vm`'s per-call `timeout`, and `vm` interrupts SYNCHRONOUS execution only.
 * An ASYNC body satisfies it by returning at its first `await`; the continuation resumes on the
 * microtask queue where no timer, no `AbortSignal` and no deadline reach it. `functions.ts` has
 * argued that and refused the shape since F36 — and this file contained ZERO occurrences of the
 * word `async`, so a hook body could do what a function body could not. Measured here, with
 * `callTimeoutMs: 100` and a body spinning `for (let n = 0; n < 4e9; n++) {}` after an `await 0`:
 * it returned normally at 1,949 ms, where the identical body written synchronously was
 * terminated at 103 ms. A second harm was this loader's alone: `intoHostRealm` passes a
 * cross-realm `Promise` through untouched, so an async body's resolved object reached the host
 * with the vm context's prototypes — `Object.getPrototypeOf(v) === Object.prototype` was `false`
 * for an async body and `true` for a sync one.
 *
 * The refusal is now `realm.ts`'s `ASYNC_RULE`, at the seam both loaders call and next to
 * `SHAPE_RULE`, whose docstring had already named this exact divergence as the thing two copies
 * of one rule produce. Nothing in THIS file enforces it, deliberately: a third copy is how it
 * would drift again.
 *
 * ## What it does not do
 *
 * `pins` mirrors `FunctionLoaderOptions.pins` and, like it, is not wired by the default CLI
 * path: the registry is built once at boot from the workspace, not per run, so a promotion
 * between compile and execute would swap a hook body underneath a Run exactly as it once could
 * a function body. Stated rather than hidden — see `FunctionLoaderOptions.pins`, which carries
 * the full argument, and design/loom/08-PLAN.md (deleted at f975f9f) T2.
 */

import { CODES, err } from "../errors.ts";
import { compileRealm, sourceOf } from "./realm.ts";
import type { Digest } from "../canonical.ts";
import type { HookBody } from "../run/hooks.ts";
import type { ResourceRef } from "../graph/spec.ts";
import type { ResourceStore } from "./store.ts";

/**
 * `(input, ctx)`, rebuilt inside the context.
 *
 * `input` comes out of `JSON.parse` and so already carries the CONTEXT's intrinsics; `ctx` is
 * assembled here for the same reason. Handing either across from the host is the escape this
 * repo already found once — `view.constructor.constructor("return globalThis")().process` — and
 * the bridge exists so that no version of it is reachable from a hook.
 *
 * `ctx.signal` is a plain `{aborted}` rather than the real `AbortSignal`: a host `AbortSignal`
 * is a host object, and a hook that wants to react to cancellation only ever needed the boolean.
 */
const HOOK_BRIDGE = `
(function () {
  // The stub \`DENY_RANDOM\` installed, captured BEFORE any call. Re-installed per call for the
  // reason \`ARGUMENT_BRIDGE\` reseeds per call: bodies are cached per digest, so a body that
  // overwrote \`Math.random\` during one invocation would otherwise change what the NEXT one —
  // in another Run — sees.
  var denyRandom = Math.random;
  globalThis.__loomInvokeHook = function (payload) {
    Math.random = denyRandom;
    var p = JSON.parse(payload);
    var ctx = {
      point: p.point,
      runId: p.runId,
      taskId: p.taskId,
      signal: { aborted: p.aborted },
    };
    return globalThis.__loomBody(p.input, ctx);
  };
})();
`;

/**
 * THE HOOK REALM HAS NO RANDOMNESS, and this is the line that makes that true.
 *
 * `run/hooks.ts`'s `HookContext` says "No clock and no randomness: see invariant 4." NEITHER half
 * was true, and they were closed in that order.
 *
 * The randomness half is this line. `safeGlobals` binds `Date` to `undefined`, but it puts `Math`
 * in — and `Math.random` with it. `functions.ts` replaces that `random` with a PRNG seeded from a
 * journaled draw; `HOOK_BRIDGE` did nothing of the kind, so a hook body reached the platform's.
 * Measured through `main()` on an identical graph: `n = 0.227…`, then `n = 0.544…`.
 *
 * The CLOCK half was believed closed by `Date`'s absence and was not — `Intl` was ambient, and
 * `new Intl.DateTimeFormat(…).format()` with no argument reads the wall clock. That one is
 * `realm.ts`'s, closed alongside `Date` and for the same reason; see `SAFE_GLOBAL_NAMES`. Both
 * halves of the sentence now hold, which is the only reason it is still quotable.
 *
 * A hook is NOT seeded the way a function body is, and that is the deliberate half of this fix.
 * The seed a body gets is `effectKey(taskId, "random", 0)`, drawn and journaled by the engine —
 * and a hook fires at eight points, one of which (`onComplete`) is run-scoped and has no Task to
 * key a draw under. Making hooks seedable is a new field on `HookContext`, a new key shape for
 * run-scoped effects, and eight engine call sites: capability bought by growing the kernel. So
 * randomness is REFUSED here instead, which is what a guard that cannot decide is supposed to do.
 *
 * A THROWING STUB, NOT AN OMISSION — the treatment `functions.ts` already settled for
 * `ctx.effects` in a sandboxed body. Deleting `Math` outright would take `floor`, `min` and
 * `abs` with it (deterministic, and a memo hook wants them) and would fail with `Cannot read
 * properties of undefined (reading 'random')`, which reads like the author's own typo.
 *
 * ## THE REFUSAL IS LOUD AT SEVEN POINTS AND SILENT AT `onComplete`, and that is not this file
 *
 * Measured through `main()` on a graph declaring `hooks: {onComplete: […]}` whose body draws:
 * exit `0`, `"status": "succeeded"`, stderr empty. The stub fires — the throw is identical to the
 * one the other seven produce — and nothing downstream looks at it.
 *
 * The swallow is at `engine.ts`'s `onComplete` dispatch, which `await`s `runObservers(...)` and
 * DISCARDS the array it returns. `run/hooks.ts` already decided this correctly and wrote it down:
 * `runObservers` "Returns the refs that threw, so the caller can surface them without failing the
 * run — a silently swallowed extension failure is indistinguishable from an extension that did
 * nothing." The promise is kept by the producer and dropped by the consumer, so the fix is one
 * expression in `engine.ts` — bind the result, and journal or warn a non-empty one. Not making
 * observers fatal: rule 3 is right, and the run is over by then anyway.
 *
 * WHAT WAS REJECTED, so the next reader does not re-propose it: letting `Math.random` through
 * when `ctx.point` is an observer point (`OBSERVER_POINTS` is `{onComplete}` and nothing else), on
 * the theory that an observer changes nothing so its draws cannot unbalance a replay.
 *
 * THE REJECTION STANDS, ON DIFFERENT GROUNDS THAN IT WAS FIRST WRITTEN DOWN WITH. Two of the three
 * counts it rested on were false, and both were "measured" claims nobody had run:
 *
 *   - It said `console` is ambient in the realm, so an `onComplete` body doing
 *     `console.log(Math.random())` writes nondeterministic bytes onto the stream `loom run` prints
 *     its JSON summary on. `console` IS ambient — `vm.createContext({})` binds it and
 *     `typeof console.log` is `"function"` — but it is INERT. Measured by running the CLI as a real
 *     subprocess, so this is fd 1 and fd 2 and not a monkey-patched `process.stdout.write`: a
 *     `preNode` hook body calling `console.log("HOOK-BYTES-MARKER-STDOUT")` and
 *     `console.error(…"-STDERR")` fired (the run's output was the hook's `41`, not the node's `1`)
 *     and produced `{"stdoutHasHookBytes":false,"stderrHasHookBytes":false,
 *     "stdoutParsesAsJson":true,"stderrLen":0}`. A hook body cannot write a byte anywhere.
 *   - It said the switch would be keyed on "a field the body cannot see". `ctx.point` IS on a
 *     hook's ctx — `HOOK_BRIDGE` puts it there, and a body asking for `Object.keys(ctx)` gets
 *     `point,runId,signal,taskId`. The body can read the field, and could branch on it itself.
 *
 * What is left is the count that was always the dispositive one, plus one the false pair was
 * standing in front of:
 *
 *   - It is LOOSENING A GUARD, which invariant 5's asymmetry forbids outright. Nothing raises its
 *     own permissions and no automated path may widen one; a hook declaring itself an observer is
 *     the subject asserting the thing the guard is supposed to decide.
 *   - It would make one built-in behave differently at one of eight points. A hook body is a
 *     pinned resource, and the SAME digest is loadable at any point a graph names it — so moving
 *     `hook/x@stable` from `onComplete` to `preTool` in a spec would start throwing with the body
 *     unchanged. `compile` caches per digest and knows nothing of points; the realm would have to
 *     become point-dependent, which is a second realm shape to reason about for one relaxation.
 *
 * The `console` sentence is worth keeping as a correction rather than deleting: "an extension can
 * print" is exactly the kind of thing a reader assumes, and it is false here.
 *
 * `test/resources/hook-loader.test.ts` pins the half that IS this file's: the refusal is
 * byte-identical at `onComplete` and at the other seven, so when `engine.ts` starts reading
 * `failed` there is something true for it to report.
 *
 * INSTALLED BEFORE THE BODY IS EVALUATED, which is why it is spliced into the source rather than
 * written in `HOOK_BRIDGE`. `compileRealm` evaluates the body FIRST and the bridge SECOND, so a
 * stub installed by the bridge can be captured out from under itself —
 * `(function () { var real = Math.random; return function () { return real(); }; })()` is a
 * valid hook resource. Spliced ahead of the body, the assignment is the first statement of the
 * wrapper and no hook text can precede it, so no body can observe the platform `random` THROUGH
 * THE REALM'S OWN `Math`. Not "at all", which is what this said: an EMBEDDER can still hand one
 * over, because `globals` is a value seam and `realm.ts`'s refusal reads names. Measured, with
 * `createHookLoader({store, globals: {MY_MATH: Math}})` — `MY_MATH` is not a governed name, so it
 * is accepted — a body got `MY_MATH.random() !== MY_MATH.random()` → `true`, and a body assigning
 * `MY_MATH.random = function () { return 42; }` left the HOST PROCESS's own `Math.random()`
 * returning 42 for every other caller in it. See `HookLoaderOptions.globals`.
 *
 * `functions.ts` HAS THE SAME SPLICE NOW, and did not when this paragraph was written. It reads
 * "`compileRealm` evaluates the body FIRST and the bridge SECOND", which is a fact about the
 * shared seam and was therefore true of `ARGUMENT_BRIDGE` too — the seeded PRNG went in after the
 * body, so a `function` body could capture the platform `Math.random` at definition time and did:
 * three `loom run`s of one pinned graph gave 0.1267…, 0.1351…, 0.6012…. See `seedingRandom`. A
 * fix argued in one file and applied in one of two is how the ordering hole got a second life.
 *
 * The prefix is ONE line on purpose: the body's own line numbers must not move, because
 * `compileRealm` passes the ref as the script's `filename` and a stack trace names them. The
 * concatenation below is across SOURCE lines; the string it builds carries no newline.
 *
 * ## The message names no field, because it used to name one that does not exist
 *
 * It said *"Draw it in a function node, where ctx.seed makes it reproducible"*. A hook body never
 * sees `ctx.seed` — `HOOK_BRIDGE` builds `{point, runId, taskId, signal}`. Neither does a FUNCTION
 * body, which is what made the advice worth measuring rather than assuming: `functions.ts` sends
 * `seed` in the payload and says of it, *"deliberately NOT put on the `ctx` the body sees — that
 * stays `{taskId, now, signal}`"*, because `ARGUMENT_BRIDGE` consumes it to reseed `Math.random`
 * and then drops it. So an author following the old advice went hunting for a field that is in
 * neither realm, having been told the thing they wanted was one field away.
 *
 * What replaced it is the ACTION, not a field: call `Math.random()` inside a `function` node and
 * the engine has already seeded it. Naming `effectKey(taskId, "random", 0)` gives them the term to
 * grep for when they want to know why that works, which is the same courtesy `functions.ts`'s own
 * unseeded-body message extends.
 */
const DENY_RANDOM =
  "Math.random = function () { throw new Error('E_EFFECT_UNAVAILABLE: a hook body cannot call " +
  "Math.random(). A hook has no journaled seed to serve draws from on replay — it fires at eight " +
  "points and onComplete is run-scoped, so there is no Task to key one under — and an unrecorded " +
  "draw makes the Run unreplayable. There is no seed on a hook ctx to reach for either: ctx is " +
  "{point, runId, taskId, signal} and nothing more. Do the draw in a function node instead — call " +
  "Math.random() in the body and the engine serves it from a seed it journaled under " +
  "effectKey(taskId, \"random\", 0) — or compute the value before the run and pass it in through " +
  "the hook input.'); };";

/** `DENY_RANDOM`, then the body — see `DENY_RANDOM` for why that order is the whole guarantee. */
function denyingRandom(source: string): string {
  return `(function () { ${DENY_RANDOM} return (${source}); })()`;
}

/**
 * SAME SEAM AS `FunctionLoaderOptions.pins`, same reason it is unwired, and the same measured
 * exposure: `cli.ts` builds this loader with `{ store }` alone, so the manifest-digest branch is
 * unreachable through `bin/loom`. What keeps that from being a live hole is that a
 * `ResourceStore` in the shipped product is sealed after boot —
 * `test/resources/store-is-sealed-after-boot.test.ts` names the three sites that would have to
 * change for it not to be. Function bodies, hook bodies and subgraph specs (REGISTER A24) are ONE
 * seam wearing three entry numbers; fix them together or the claim rots the way it did last time.
 */
export interface HookLoaderOptions {
  readonly store: ResourceStore;
  /** ref → the digest the compiler pinned. See the module docstring for why this is optional. */
  readonly pins?: (ref: ResourceRef) => Digest | undefined;
  /**
   * Extra globals the body may see, for the embedder's own use — a tenant id, a lookup table.
   *
   * `Math`, `Date`, `Intl`, `JSON` AND THE REST OF `SAFE_GLOBAL_NAMES` ARE REFUSED, by
   * `realm.ts`'s `refuseGovernedGlobals` and not by anything here. This loader used to
   * `delete globals["Math"]` on its way past — silently, and only `Math`, so `Date` and `Intl`
   * went through and restored the two clocks `realm.ts` shadows. One rule at one seam, applied to
   * both resource kinds, replaced that.
   *
   * THAT REFUSAL READS NAMES AND CANNOT READ VALUES, AND WHAT YOU PASS IS NOT REBUILT. Whatever
   * survives the name check reaches the body as the very object you passed. Measured through this
   * loader: `{LOOKUP: {a: 1}}` gives a body `LOOKUP.constructor.constructor("return typeof
   * process")()` → `"object"`, the host realm; `{MY_DATE: Date}` gives it a live wall clock; and
   * `{MY_MATH: Math}` lets it rewrite `Math.random` for the whole host process. `DENY_RANDOM`
   * above and `realm.ts`'s two clock shadows are guards on the REALM's globals — they do not
   * follow an object you hand over yourself. Pass primitives: a tenant id, a flag, a string.
   */
  readonly globals?: Readonly<Record<string, unknown>> | undefined;
  readonly compileTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

export interface HookLoader {
  /** Compile the body a ref names, or `undefined` when it names no hook. */
  load(ref: ResourceRef): HookBody | undefined;
  readonly compiled: number;
}

export function createHookLoader(opts: HookLoaderOptions): HookLoader {
  const cache = new Map<Digest, HookBody>();
  const compileTimeoutMs = opts.compileTimeoutMs ?? 1000;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const compile = (digest: Digest, source: string, label: string): HookBody => {
    const hit = cache.get(digest);
    if (hit !== undefined) return hit;
    const call = compileRealm({
      source: denyingRandom(source),
      label,
      what: "hook",
      bridge: HOOK_BRIDGE,
      entry: "__loomInvokeHook",
      // Passed straight through. `compileRealm` REFUSES any name it governs — `Math` included,
      // which is what stops `DENY_RANDOM` from monkey-patching the host process's own
      // `Math.random` for every other caller in it.
      globals: opts.globals,
      compileTimeoutMs,
      callTimeoutMs,
    });
    // `input` is serialized on the way in, which also enforces at the cheapest seam what a hook
    // may be handed at all: JSON-shaped data. A point that one day wants to pass a live object
    // has to answer why an extension should hold one.
    const body: HookBody = (input, ctx) =>
      call({
        input,
        point: ctx.point,
        runId: ctx.runId,
        ...(ctx.taskId === undefined ? {} : { taskId: String(ctx.taskId) }),
        aborted: ctx.signal.aborted,
      });
    cache.set(digest, body);
    return body;
  };

  return {
    load(ref) {
      if (opts.pins !== undefined) {
        const pinned = opts.pins(ref);
        if (pinned === undefined) {
          throw err.internal(
            CODES.E_FLOATING_REF_AT_RUNTIME,
            `hook "${ref}" is not in this run's resolution manifest, so there is no pinned body to run`,
            { details: { ref } },
          );
        }
        const record = opts.store.fetch<unknown>(pinned);
        if (record.kind !== "hook") return undefined;
        return compile(pinned, sourceOf(record.content, ref, "hook"), ref);
      }
      const resolved = opts.store.resolve(ref);
      if (resolved === undefined) return undefined;
      const record = opts.store.fetch<unknown>(resolved.digest);
      if (record.kind !== "hook") return undefined;
      return compile(resolved.digest, sourceOf(record.content, ref, "hook"), ref);
    },
    get compiled() {
      return cache.size;
    },
  };
}
