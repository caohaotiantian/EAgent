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
 * thing here that is specific to hooks is `HOOK_BRIDGE` — the few lines that turn a JSON payload
 * into `(input, ctx)` inside the context.
 *
 * ## Why a hook body sees so little
 *
 * A hook gets JSON and nothing else. Not the engine, not the journal, not the resource store,
 * not a fetch. That is not an oversight to be relaxed later: a filter that could reach the
 * engine could lower a posture, and invariant 5's asymmetry has to hold for extensions or it
 * does not hold at all. An extension that needs to reach the world does it as a TOOL, behind a
 * manifest and a capability, where the policy engine can see it.
 *
 * ## What it does not do
 *
 * `pins` mirrors `FunctionLoaderOptions.pins` and, like it, is not wired by the default CLI
 * path: the registry is built once at boot from the workspace, not per run, so a promotion
 * between compile and execute would swap a hook body underneath a Run exactly as it once could
 * a function body. Stated rather than hidden — see `FunctionLoaderOptions.pins`, which carries
 * the full argument, and 08-PLAN.md T2.
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
  globalThis.__loomInvokeHook = function (payload) {
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
      source,
      label,
      what: "hook",
      bridge: HOOK_BRIDGE,
      entry: "__loomInvokeHook",
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
