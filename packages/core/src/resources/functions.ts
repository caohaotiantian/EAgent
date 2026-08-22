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
 * That seam is also why a manifest-bound loader belongs to ONE RUN. `FunctionRegistry`
 * caches a loaded body under the REF, not the digest, so a registry shared across runs
 * would hand run B whatever run A's manifest resolved that ref to — the same drift by
 * another road. Build the loader (and the registry that wraps it) per run, or key the
 * cache by digest.
 *
 * See design/loom/08-PLAN.md open thread T2, and A13.
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
   * Globals the body may see. Deliberately tiny, and NOT a security control — see the
   * module docstring. `JSON` and `Math` are here because a body that cannot parse or
   * round numbers is not useful; nothing that reaches the host is.
   */
  readonly globals?: Readonly<Record<string, unknown>>;
  /** Bound on COMPILING the body. */
  readonly compileTimeoutMs?: number;
  /**
   * Bound on RUNNING the synchronous part of a body, in ms (default 30s).
   *
   * `Engine.#withNodeDeadline` is a `Promise.race` on the same thread, so it cannot interrupt a
   * body that never yields: `while (true) {}` in a `function` resource hung `loom run` with no
   * output until it was killed. `vm`'s own timeout CAN terminate synchronous execution, and it
   * only applies while the call is on the stack — so this bounds the sync part and the node
   * deadline bounds the async part. Two mechanisms because there are two failure modes.
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
  var has = Object.prototype.hasOwnProperty;
  globalThis.__loomInvoke = function (payload) {
    var p = JSON.parse(payload);
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
    return globalThis.__loomBody(view, ctx);
  };
})();
`;

export function createFunctionLoader(opts: FunctionLoaderOptions): FunctionLoader {
  const cache = new Map<Digest, FunctionBody>();
  const compileTimeoutMs = opts.compileTimeoutMs ?? 1000;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;

  const compile = (digest: Digest, source: string, label: string): FunctionBody => {
    const hit = cache.get(digest);
    if (hit !== undefined) return hit;

    const call = compileRealm({
      source,
      label,
      what: "function",
      bridge: ARGUMENT_BRIDGE,
      entry: "__loomInvoke",
      globals: opts.globals,
      compileTimeoutMs,
      callTimeoutMs,
    });

    const body: FunctionBody = (view, callCtx) => {
      // ONLY JSON CROSSES. Everything the body sees is rebuilt from this payload INSIDE the
      // context by `ARGUMENT_BRIDGE`, so no host object is ever in its reach.
      const slice: Record<string, unknown> = {};
      for (const name of view.visible) {
        const v = view.get(name);
        if (v !== undefined) slice[name] = v;
      }
      return call({
        slice,
        visible: [...view.visible],
        hash: String(view.hash),
        taskId: String(callCtx.taskId),
        now: callCtx.now(),
        aborted: callCtx.signal.aborted,
      }) as ReturnType<FunctionBody>;
    };
    cache.set(digest, body);
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
