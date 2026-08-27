/**
 * Loading `function` node bodies from digest-addressed resources.
 *
 * Until now a graph naming `function/merge@stable` only ran if someone had called
 * `functions.register("function/merge@stable", body)` by hand, in the same process. That
 * made `function` nodes the one node type whose resource reference was decorative: the
 * compiler pinned it, the manifest recorded its digest, and the executor ignored both.
 *
 * ## This is NOT a sandbox, and says so
 *
 * `node:vm` does not isolate untrusted code — a fresh context is a scoping mechanism, not
 * a security boundary, and everyone who has tried to use it as one has been wrong. What
 * it buys here is real but narrow: a body sees a small, explicit set of globals instead
 * of the host's — THAT CONTEXT'S OWN copies of them, which is the part that took a second
 * attempt. Seeding the context with the host's `Object` handed over the host's `Function` with
 * it, and `Object.constructor("return globalThis")()` walked straight back out to `process.env`
 * and `fetch`. See `safeGlobals`.
 *
 * **Untrusted code belongs in the subprocess sandbox** (`sandbox/subprocess.ts`), behind
 * a tool manifest and a capability. `function` resources are assumption A13 — trusted
 * code, authored by the same people who author the graph — and this loader is packaging
 * for that assumption, not a relaxation of it.
 *
 * ## The deadline, and what it can and cannot bound
 *
 * `vm`'s per-call `timeout` is the ONLY thing in this process that can interrupt a body, and it
 * interrupts SYNCHRONOUS execution only. That single fact decides the whole design here.
 *
 * WHAT IS BOUNDED NOW. A node's declared `NodeSpec.timeoutMs` reaches the realm: the engine
 * hands a loaded body to `REBIND_DEADLINE` and gets back the same source compiled under that
 * deadline, so a synchronous body is TERMINATED at the number the graph declared and the node
 * fails `E_TASK_TIMEOUT`. Measured through `Engine.advance` on a graph declaring
 * `timeoutMs: 200`, body `for (let i = 0; i < 4e9; i++)`: 2,332 ms and `succeeded` before,
 * 206 ms and `failed` after; the same graph with `while (true) {}` went 30,005 ms → 206 ms. Without a declared `timeoutMs` a body still gets
 * `FunctionLoaderOptions.callTimeoutMs`, default 30s.
 *
 * WHAT IS REFUSED, BECAUSE IT CANNOT BE BOUNDED. An `async` body satisfies the vm timeout by
 * returning at its first `await`, and its continuation resumes on the microtask queue where no
 * timer, no `AbortSignal` and no deadline can reach it. Measured: `(async (view) => { await 0;
 * while (true) {} })` under `timeoutMs: 200` produced no output at all and was still spinning
 * when the harness SIGKILLed the process at 25s — the engine's node deadline could not even
 * report, because a spinning microtask never hands the loop back. So an async body is refused
 * at LOAD — by `realm.ts`'s `ASYNC_RULE`, at the seam BOTH loaders call, because this rule used
 * to live in `ARGUMENT_BRIDGE` below and therefore did not exist for hook bodies at all — and a
 * synchronous body that RETURNS a thenable is refused when it returns, here.
 *
 * WHAT IS STILL UNBOUNDED, stated plainly because a half-guard that reads as a whole one is
 * worse than none:
 *
 *   - A body registered by hand through `FunctionRegistry.register` is host code. There is no
 *     realm and no timeout; `timeoutMs` bounds its TASK's outcome and not the body. A13.
 *   - THE THENABLE REFUSAL DOES NOT MAKE THE FAILURE TIMELY, and that is the honest half. It
 *     fires when the body RETURNS, and the continuation is already on the microtask queue by
 *     then. Measured on `(view) => Promise.resolve().then(() => …)` under `timeoutMs: 200`: with
 *     a continuation that spins ~2.3s the node fails `E_RESOURCE_INVALID` and `Engine.advance`
 *     still did not return for 2,350 ms; with `while (true) {}` it never returned at all — no
 *     output, SIGKILLed at 15s. What the refusal buys is a NAMED failure instead of the engine
 *     awaiting a promise that may never settle. It does not make the process stoppable.
 *   - Only the `function` and `evaluator{assertion}` node types run these bodies. A tool or a
 *     model adapter that blocks the thread is unbounded by anything here.
 *
 * The real answer to all three is a process boundary — `sandbox/subprocess.ts` exists and
 * `cpuBound` in the schema currently only warns. That is a change to how a body EXECUTES, not
 * to how it is loaded, and it is not this module's to make.
 *
 * AND ONE CAVEAT ABOUT REPLAY, because this deadline is the one thing here that is not a
 * function of the inputs: it is WALL CLOCK. A body that finishes just inside its deadline on the
 * recording machine can be terminated on a slower one, so a run and its replay would disagree —
 * that was already true of the 30s default, and it is easier to sit on now that the number is
 * graph-declared and small. It is a property of the deadline itself and no seam removes it; a
 * body whose runtime is anywhere near its declared `timeoutMs` is a body to shorten.
 *
 * ## The pinning rule, applied to code
 *
 * Bodies are compiled and cached per DIGEST, not per ref: a ref repointed to new bytes gets a
 * new body, and two SELECTORS on one version (`@stable` and `@v3`, same version) share one.
 *
 * NOT "two refs with the same bytes", which this said for a year and is false —
 * `resourceDigest` hashes `{kind, name, content}`, so two NAMES holding identical source are
 * two digests and compile twice. Found by a test written for the hook loader against the
 * stronger claim; the weaker one is the guarantee, and it is the one anything depends on.
 *
 * Caching per digest is not the same claim as *running* the pinned digest, and for a while
 * only the first was true here. `load(ref)` called `store.resolve` — the COMPILE-time half
 * of the rule — from inside a running node, so a promotion between compile and execute
 * swapped the body underneath the Run. Every other dependency is pinned into
 * `RunGraph.resolutionManifest` and read from that pin; code was the exception.
 * `FunctionLoaderOptions.pins` is the manifest seam that closes it, and the loader
 * refuses rather than falls back when a manifest is supplied and a ref is missing from it.
 *
 * WIRING IT IS THE CALLER'S JOB and is not done here: `FunctionRegistry`'s loader seam is
 * `(ref: string) => FunctionBody | undefined`, which carries no run identity, so nothing
 * in `run/` currently passes a manifest. Until it does, an embedder that constructs the
 * loader itself gets the guarantee and the default engine path does not.
 *
 * WHAT MAKES THAT SURVIVABLE IS MEASURED, NOT ASSUMED. A promotion between compile and execute
 * needs something able to MOVE a ref while a process runs, and in the shipped product nothing
 * is: `test/resources/store-is-sealed-after-boot.test.ts` pins the three sites that would have
 * to change — no `.publish(`/`.promote(` anywhere under `src/`, exactly one `readResources`
 * call (the boot seed), and no HTTP route addressing a resource at all. An EMBEDDER holding a
 * store can still move one, and then this seam is the fix. When a publish route or a hot-reload
 * path arrives, one of those three assertions goes red and sends its author here first.
 *
 * That seam is also why a manifest-bound loader belongs to ONE RUN. `FunctionRegistry`
 * caches a loaded body under the REF, not the digest, so a registry shared across runs
 * would hand run B whatever run A's manifest resolved that ref to — the same drift by
 * another road. Build the loader (and the registry that wraps it) per run, or key the
 * cache by digest.
 *
 */

import { CODES, err } from "../errors.ts";
import { compileRealm, sourceOf } from "./realm.ts";
import type { Digest } from "../canonical.ts";
import type { FunctionBody } from "../run/registry.ts";
import type { ResourceRef } from "../graph/spec.ts";
import type { ResourceStore } from "./store.ts";

export interface FunctionLoaderOptions {
  readonly store: ResourceStore;
  /**
   * The run's resolution manifest, as a lookup: ref → the digest the compiler pinned.
   *
   * WITHOUT IT, `load` resolves the ref through the store when the node RUNS. That is the
   * compile-time half of the pinning rule executed at run time, and it is exactly the
   * thing `store.ts` says must not happen: promote a new version between compile and
   * execute and the body that runs is not the body that was compiled, validated and
   * gated. `RunGraph`'s docstring — "a Run reads only what its manifest names" — held for
   * every dependency except the one that is CODE.
   *
   * Supplying it makes the manifest AUTHORITATIVE and EXHAUSTIVE: a pinned ref loads its
   * pinned digest whatever the selector now says, and a ref the manifest does not name
   * does not load at all. Exhaustive rather than best-effort because a fallback to the
   * selector is the hole itself, reachable again by one ref the compiler failed to pin.
   *
   * It is a function rather than a map so one loader can serve many runs: the caller
   * closes over whichever `RunGraph` is executing.
   */
  /**
   * NOT USABLE YET FOR A GRAPH WITH A `subgraph` NODE THAT CONTAINS `function` NODES.
   *
   * The lookup must cover every graph the run can REACH, and an embedder cannot build
   * that today: `resolveManifest` walks the top-level spec only, `Engine.#compileChild`
   * compiles each child into its own `RunGraph` with its own manifest, and
   * `FunctionRegistry` is a single Engine-wide dependency. A loader closed over the
   * parent's manifest is then asked for the child's ref, misses, and fails closed —
   * killing a run that is doing nothing wrong.
   *
   * Left strict rather than relaxed, because the relaxed version reopens the hole this
   * exists to close: a miss would have to fall through to the floating lookup, which is
   * the unpinned path. Nothing in `src/` passes `pins` today, so the strictness costs
   * nothing until the child manifests are reachable.
   *
   * Reversal: when child manifests are exposed (or the registry becomes per-graph), this
   * note goes and the contract becomes plainly exhaustive.
   */
  readonly pins?: (ref: ResourceRef) => Digest | undefined;
  /**
   * EXTRA globals, for the embedder's own use — a tenant id, a lookup table.
   *
   * NOT the set a body sees, which is `realm.ts`'s and is described there. The names that module
   * governs — the 16 in `SAFE_GLOBAL_NAMES`, plus the shadowed `Date` and `Intl` — are REFUSED
   * here rather than merged: passing `{JSON}` would hand the body a HOST object, and
   * `JSON.parse.constructor("return typeof process")()` walks straight back out through it.
   * Same rule, same seam, for hook bodies; see `realm.ts`'s `refuseGovernedGlobals`.
   *
   * NOT A SECURITY CONTROL either way — see the module docstring. It is replay integrity.
   */
  readonly globals?: Readonly<Record<string, unknown>>;
  /** Bound on COMPILING the body. */
  readonly compileTimeoutMs?: number;
  /**
   * The DEFAULT bound on running a body, in ms (default 30s). A node's declared `timeoutMs`
   * overrides it — see "The deadline, and what it can and cannot bound" in the module docstring.
   *
   * `Engine.#withNodeDeadline` is a `Promise.race` on the same thread, so it cannot interrupt a
   * body that never yields: `while (true) {}` in a `function` resource hung `loom run` with no
   * output until it was killed. `vm`'s own timeout CAN terminate synchronous execution, and it
   * only applies while the call is on the stack — so this bounds the sync part and the node
   * deadline bounds nothing that does not yield. Two mechanisms because there are two failure
   * modes, and only one of them has a mechanism that works.
   *
   * WHY A DEFAULT AND NOT THE ONLY VALUE. This number was the only real bound in the product
   * for as long as it existed, and no CLI flag and no graph field reached it: a `function` node
   * declaring `timeoutMs: 200` spun for 2,332 ms and reported `succeeded` — measured, through
   * `Engine.advance`, before this paragraph. The engine now asks a loaded body to recompile
   * itself at the node's declared deadline (`REBIND_DEADLINE`), and this is what a body with no
   * declared deadline still gets.
   */
  readonly callTimeoutMs?: number;
}

export interface FunctionLoader {
  /**
   * Compile the body a ref names, or `undefined` when it names no function.
   *
   * Which digest that is depends on `pins`: the manifest's, when one is supplied, and
   * otherwise whatever the selector points at right now. See `FunctionLoaderOptions.pins`
   * for why only the first of those is the pinning rule.
   */
  load(ref: ResourceRef): FunctionBody | undefined;
  /** Compile a specific digest. Replay uses this: the ref may have moved on. */
  loadDigest(digest: Digest): FunctionBody;
  readonly compiled: number;
}

/**
 * A loader over a `ResourceStore`.
 *
 * `Date` is bound to `undefined` in the global set on purpose. A `function` node is meant
 * to be a pure fold over channel state, and a body that reads the wall clock makes its
 * own replay non-deterministic — GRAPH013 already refuses clock-dependent expressions, so
 * leaving the constructor reachable here would be an inconsistent seam. A body that needs
 * the time takes it from `ctx.now`, which is injected and recorded.
 */
/**
 * THE UNSEEDED REFUSAL, in the one place both the splice-ahead prefix and the bridge read it.
 *
 * Single-quoted inside the generated source so the message can carry `"random"` without a second
 * layer of escaping — the shape `hook-loader.ts`'s `DENY_RANDOM` already settled on.
 */
const DENY_UNSEEDED =
  "Math.random = function () { throw new Error('E_EFFECT_UNRECORDED: Math.random() needs a " +
  "journaled seed and this body was invoked without one. The engine draws it under " +
  "effectKey(taskId, \"random\", 0); a caller invoking a FunctionBody directly must pass " +
  "ctx.seed.'); };";

/**
 * `DENY_UNSEEDED`, THEN THE BODY — the ordering fix `hook-loader.ts` made for hooks, applied to
 * the resource kind that is actually on the product path.
 *
 * `compileRealm` evaluates the body FIRST and the bridge SECOND. `ARGUMENT_BRIDGE` is where the
 * seeded PRNG gets installed, so until this existed every `function` body had one window in which
 * the PLATFORM `Math.random` was reachable: its own definition. A body is an EXPRESSION, and
 *
 *     (function () { var real = Math.random; return function (view, ctx) {…real()…}; })()
 *
 * is a valid `function` resource. Measured through `loom run` on one pinned graph, three runs:
 * `n = 0.12671154683563246`, `n = 0.1351033722013243`, `n = 0.6012203360691692`. The engine had
 * journaled a seed, the manifest had pinned the digest, and the run was unreplayable anyway.
 *
 * Spliced ahead of the body, the assignment is the wrapper's first statement and no resource text
 * can precede it, so the platform `random` is not observable from a body at all. What the body
 * sees at definition time is the same refusal an unseeded CALL gets, which is the honest answer:
 * at definition time there is no seed yet, because the seed arrives per call in the payload.
 *
 * ONE LINE on purpose. `compileRealm` passes the ref as the script's `filename` and a stack trace
 * names the body's lines; a multi-line prefix would move every one of them. The concatenation
 * above is across SOURCE lines and the string it builds carries no newline.
 */
function seedingRandom(source: string): string {
  return `(function () { ${DENY_UNSEEDED} return (${source}); })()`;
}

/**
 * THE ARGUMENTS WERE THE HOLE, and the globals fix did not close them.
 *
 * `safeGlobals` rebuilds the body's globals out of the context's own intrinsics, so
 * `Object.constructor("return globalThis")()` inside a body reaches the CONTEXT's global and not
 * the host's — measured, `typeof globalThis.process` is `undefined` that way. But the body was
 * then CALLED with the host's `view` and `ctx`, and a host object hands over the host `Function`
 * exactly as a host `Object` does. Measured, all four paths reached the real `process`:
 *
 *     view.constructor.constructor("return globalThis")().process   → object
 *     ctx.constructor.constructor(…)                                → object
 *     view.get.constructor(…)                                       → object
 *     ctx.now.constructor(…)                                        → object
 *
 * So the module's own recorded finding — "a body printed a real ANTHROPIC_API_KEY" — was
 * reproducible again through the door nobody guarded. The globals were closed; the arguments
 * were the same escape one argument over.
 *
 * This bridge rebuilds `view` and `ctx` INSIDE the context from a JSON payload, so only strings
 * and numbers cross. `hasOwnProperty` is taken from the context's own `Object`, and the
 * allow-list plus own-property check mirror `makeStateView` exactly — including the reason the
 * second check is not redundant: `reads: ["constructor"]` compiles with a warning, so an
 * allow-list alone would answer with `Object`.
 *
 * Values coming BACK need no such care: an object built inside the context carries that
 * context's intrinsics, which is why `({}).constructor.constructor(…)` in a body reaches
 * nothing. `compileRealm` rebuilds them anyway, for the prototype reason `intoHostRealm` gives.
 */
const ARGUMENT_BRIDGE = `
(function () {
  // THE ASYNC REFUSAL USED TO LIVE HERE, and being here is why it covered function bodies and
  // not hook bodies — \`hook-loader.ts\` had zero occurrences of the word. It is \`realm.ts\`'s
  // \`ASYNC_RULE\` now, at the seam both loaders call, next to \`SHAPE_RULE\`, which is there for
  // the identical reason and whose docstring already cited this exact divergence.
  //
  // The move also widened it. This check read \`__loomBody.constructor.name\`, which an own
  // \`constructor\` property defeats — measured, an async body carrying one answered \`Nope\` and
  // loaded clean. The seam reads that AND \`Object.prototype.toString\`, and each catches a body
  // the other misses.
  var has = Object.prototype.hasOwnProperty;
  // \`Math\` here is the CONTEXT'S own, so nothing host-side is in reach.
  //
  // NOT captured before the body runs, and the comment here said it was for as long as it was
  // wrong. \`compileRealm\` evaluates the body FIRST and this bridge SECOND, so a body of the form
  // \`(function () { Math.imul = function () { return 0; }; return function (v, c) {…}; })()\`
  // poisons it beforehand — measured, that body's two draws came back \`"0,0"\`.
  //
  // That is a body sabotaging its OWN stream, and it stays replayable: the source is pinned by
  // digest, so a replay re-evaluates the same poison and gets the same \`"0,0"\` — measured, twice.
  // The thing that would NOT be replayable is a body reading the PLATFORM \`Math.random\` at
  // definition time, and that is closed one layer up by \`seedingRandom\` rather than here, because
  // no code in this bridge can run before the body it is bridging to.
  var imul = Math.imul;
  globalThis.__loomInvoke = function (payload) {
    var p = JSON.parse(payload);
    // RESEEDED PER CALL, from a value the engine journaled as an effect. mulberry32: one
    // 32-bit word of state, no dependency, and identical output for identical seeds on
    // every platform — which is the whole requirement, since replay compares outputs.
    if (typeof p.seed === "number") {
      var s = p.seed | 0;
      Math.random = function () {
        s = (s + 0x6D2B79F5) | 0;
        var t = imul(s ^ (s >>> 15), 1 | s);
        t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    } else {
      // NOT a fallback to the real Math.random. An unseeded body is one whose output no
      // replay can reproduce, and \`Date\` two lines away is already \`undefined\` for exactly
      // that reason — the asymmetry between them was invariant 4's admitted gap. Both engine
      // callers pass a seed; reaching this means calling a FunctionBody by hand.
      ${DENY_UNSEEDED}
    }
    var allowed = {};
    for (var i = 0; i < p.visible.length; i++) allowed[p.visible[i]] = true;
    var slice = p.slice;
    var view = {
      get: function (c) {
        return has.call(allowed, c) && has.call(slice, c) ? slice[c] : undefined;
      },
      require: function (c) {
        if (!has.call(allowed, c)) throw new Error('E_CHANNEL_UNDECLARED: channel "' + c + '" is not in this node\\'s declared reads');
        if (!has.call(slice, c)) throw new Error('E_CHANNEL_UNDECLARED: channel "' + c + '" has no value yet');
        return slice[c];
      },
      hash: p.hash,
      visible: p.visible,
    };
    var ctx = {
      taskId: p.taskId,
      now: function () { return p.now; },
      signal: { aborted: p.aborted },
    };
    // DECLARED EFFECTS DO NOT CROSS THIS BOUNDARY, and the body is TOLD so rather than handed
    // undefined. A resource-loaded body runs synchronously inside vm.runInContext under a
    // per-call timeout -- the same constraint that made the random SEED a seed rather than a
    // recorded value per call -- so it cannot await a host round trip, and a bound invoker
    // cannot be serialized across the boundary in any case.
    //
    // A THROWING STUB, not an omission, for exactly the reason the unseeded Math.random above
    // throws. Reading a method off a missing object dies with 'Cannot read properties of
    // undefined', which sends an author hunting for a typo in their own code instead of telling
    // them the capability is real and lives somewhere else.
    if (p.declaredEffects && p.declaredEffects.length > 0) {
      var stub = {};
      for (var k = 0; k < p.declaredEffects.length; k++) {
        (function (name) {
          stub[name] = function () {
            throw new Error(
              'E_EFFECT_UNAVAILABLE: this node declares the effect ' + name + ', but a SANDBOXED body cannot invoke one. ' +
              'A resource-loaded body runs synchronously inside a vm and cannot await a host call. ' +
              'Register the body in-process with FunctionRegistry.register to use ctx.effects, or put the call on a tool node.'
            );
          };
        })(p.declaredEffects[k]);
      }
      ctx.effects = stub;
    }
    return globalThis.__loomBody(view, ctx);
  };
})();
`;

/**
 * THE SEAM THAT CARRIES A NODE'S DECLARED DEADLINE INTO THE REALM.
 *
 * `vm.runInContext` takes its `timeout` per call, but `compileRealm` closes over ONE number, and
 * neither the loader nor the registry can see the node: `FunctionRegistry`'s loader seam is
 * `(ref) => FunctionBody | undefined` and carries no node identity, `FunctionContext` carries no
 * deadline, and the CLI builds the loader at boot with no graph in hand. So the deadline travels
 * the only way left — on the compiled body itself, as a request to recompile at another number.
 *
 * `Engine.#functionBody` is the one caller. A body that does not carry this (a hand-registered
 * one — host code, no realm, nothing to bound) is used unchanged.
 *
 * A GLOBAL-REGISTRY SYMBOL rather than an export, because `src/index.ts` re-exports this module
 * wholesale and `scripts/surface.json` pins the public name set; a private seam between two core
 * modules has no business in it. NOT `loom.`-prefixed: `registries.test.ts` reserves every
 * `"loom.*"` string literal outside `telemetry/spans.ts` for the span vocabulary, and the first
 * spelling of this symbol broke that guard. Both sides compute the same symbol from the same
 * string, so a rename on one side silently disables the bound — which is why
 * `test/run/function-timeout-bounded.test.ts` measures the wall clock through `Engine.advance`
 * instead of asserting the property exists.
 */
const REBIND_DEADLINE = Symbol.for("@loom/core:function.rebindDeadline");

/** What `REBIND_DEADLINE` names on a loaded body. */
type Rebindable = { [REBIND_DEADLINE]?: (callTimeoutMs: number) => FunctionBody };

export function createFunctionLoader(opts: FunctionLoaderOptions): FunctionLoader {
  // KEYED BY (DIGEST, DEADLINE) rather than by digest alone. The deadline is baked into the
  // realm at compile time, so two nodes running one body under two declared `timeoutMs` hold two
  // realms. Bounded by the number of DISTINCT declared deadlines — a graph-authoring quantity,
  // not a per-call one — and the pinning rule is unaffected: every entry under one digest is the
  // same source.
  const cache = new Map<string, FunctionBody>();
  const compileTimeoutMs = opts.compileTimeoutMs ?? 1000;
  const defaultCallTimeoutMs = opts.callTimeoutMs ?? 30_000;

  const compile = (
    digest: Digest,
    source: string,
    label: string,
    callTimeoutMs: number = defaultCallTimeoutMs,
  ): FunctionBody => {
    const key = `${digest}@${callTimeoutMs}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    const call = compileRealm({
      source: seedingRandom(source),
      label,
      what: "function",
      bridge: ARGUMENT_BRIDGE,
      entry: "__loomInvoke",
      globals: opts.globals,
      compileTimeoutMs,
      callTimeoutMs,
    });

    /**
     * `call`, with the vm's termination translated into the vocabulary the graph declared.
     *
     * `vm` throws a plain `Error` with `code: "ERR_SCRIPT_EXECUTION_TIMEOUT"` and the message
     * "Script execution timed out after 200ms". Left alone it crosses `#dispatchBody` and is
     * normalized to `internal`/`E_INTERNAL` — measured before this existed: a node declaring
     * `timeoutMs: 200` failed `E_INTERNAL` with a message naming 30000ms, a number the graph
     * never asked for. `E_TASK_TIMEOUT` is the code `NodeSpec.timeoutMs` promises and the one
     * `Engine.#withNodeDeadline` raises for the same event, so both roads out of a deadline now
     * report it identically.
     *
     * A HOST `LoomError`, which is what makes the class survive: `toLoomError` preserves an
     * `instanceof` match and refuses to read a `class` off anything else, so a code thrown from
     * inside the realm could never have arrived as a `timeout`.
     */
    const invoke = (payload: unknown): unknown => {
      try {
        return call(payload);
      } catch (e) {
        if ((e as { code?: unknown } | null)?.code !== "ERR_SCRIPT_EXECUTION_TIMEOUT") throw e;
        throw err.timeout(
          CODES.E_TASK_TIMEOUT,
          // "timed out" is load-bearing wording, not decoration: `functions.test.ts` pins the
          // termination by matching /timed out|Script execution/i, and that test predates this
          // translation. Keep the phrase.
          `function "${label}" timed out: it ran for ${callTimeoutMs}ms without returning, and was terminated`,
          { details: { ref: label, timeoutMs: callTimeoutMs } },
        );
      }
    };

    const body: FunctionBody = (view, callCtx) => {
      // ONLY JSON CROSSES. Everything the body sees is rebuilt from this payload INSIDE the
      // context by `ARGUMENT_BRIDGE`, so no host object is ever in its reach.
      const slice: Record<string, unknown> = {};
      for (const name of view.visible) {
        const v = view.get(name);
        if (v !== undefined) slice[name] = v;
      }
      const out = invoke({
        slice,
        visible: [...view.visible],
        hash: String(view.hash),
        taskId: String(callCtx.taskId),
        now: callCtx.now(),
        aborted: callCtx.signal.aborted,
        // Consumed by the bridge to reseed `Math.random`, and deliberately NOT put on the
        // `ctx` the body sees — that stays `{taskId, now, signal}`. Omitted rather than sent
        // as `undefined` so the bridge's `typeof === "number"` test reads one thing.
        ...(callCtx.seed === undefined ? {} : { seed: callCtx.seed }),
        // The NAMES only. A bound invoker cannot cross the boundary — see the bridge — so what
        // travels is just enough to build a stub that names each one when it is called.
        ...(callCtx.effects === undefined ? {} : { declaredEffects: Object.keys(callCtx.effects) }),
      });
      // A THENABLE IS REFUSED, and the refusal is honest about what it does not fix.
      //
      // `realm.ts` refuses an `async` body at load; this is the other shape — a plain
      // function that RETURNS a promise. The vm timeout is satisfied the moment it returns, so
      // whatever the continuation does is beyond every deadline in this process. Refusing gives
      // the node a NAMED failure instead of the engine awaiting a promise that may never settle.
      //
      // IT DOES NOT STOP THE BODY, AND IT IS NOT EVEN TIMELY. The continuation is already on the
      // microtask queue when this throws: measured, a continuation spinning ~2.3s let the node
      // fail `E_RESOURCE_INVALID` but `Engine.advance` did not return for 2,350 ms, and
      // `while (true) {}` never returned at all. See the module docstring's "what is still
      // unbounded" — nothing short of a process boundary fixes it.
      if (typeof (out as { then?: unknown } | null)?.then === "function") {
        throw err.validation(
          CODES.E_RESOURCE_INVALID,
          `function "${label}" returned a promise, and no deadline can bound one: the vm timeout ` +
            `that enforces this node's timeoutMs covers synchronous execution only, so the rest of ` +
            `this body runs after its node has failed and cannot be stopped. Return the outcome ` +
            `directly; a body that must wait on something is describing an effect, and effects ` +
            `belong on a tool node.`,
          { details: { ref: label } },
        );
      }
      return out as ReturnType<FunctionBody>;
    };
    // See `REBIND_DEADLINE`: this is how a node's declared `timeoutMs` reaches `vm`'s `timeout`.
    // Non-enumerable so nothing that walks a body's own keys sees it.
    const rebind: Rebindable[typeof REBIND_DEADLINE] = (ms) =>
      ms === callTimeoutMs ? body : compile(digest, source, label, ms);
    Object.defineProperty(body, REBIND_DEADLINE, { value: rebind, enumerable: false });
    cache.set(key, body);
    return body;
  };

  return {
    load(ref) {
      if (opts.pins !== undefined) {
        const pinned = opts.pins(ref);
        if (pinned === undefined) {
          // `internal`, not `validation`: the compiler pins every ref it can see, so a
          // miss here means some path reached the executor without going through it and
          // the Run's view of the world is no longer frozen.
          throw err.internal(
            CODES.E_FLOATING_REF_AT_RUNTIME,
            `function "${ref}" is not in this run's resolution manifest, so there is no pinned body to run`,
            { details: { ref } },
          );
        }
        const record = opts.store.fetch<unknown>(pinned);
        if (record.kind !== "function") return undefined;
        return compile(pinned, sourceOf(record.content, ref, "function"), ref);
      }
      const resolved = opts.store.resolve(ref);
      if (resolved === undefined) return undefined;
      const record = opts.store.fetch<unknown>(resolved.digest);
      if (record.kind !== "function") return undefined;
      return compile(resolved.digest, sourceOf(record.content, ref, "function"), ref);
    },
    loadDigest(digest) {
      const record = opts.store.fetch<unknown>(digest);
      if (record.kind !== "function") {
        throw err.validation(CODES.E_RESOURCE_INVALID, `${digest} is a ${record.kind}, not a function`);
      }
      return compile(digest, sourceOf(record.content, digest, "function"), digest);
    },
    get compiled() {
      return cache.size;
    },
  };
}
