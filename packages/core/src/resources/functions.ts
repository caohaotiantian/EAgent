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
 * of the host's, so a `function` resource cannot reach `process.env` or `fetch` by
 * accident.
 *
 * **Untrusted code belongs in the subprocess sandbox** (`sandbox/subprocess.ts`), behind
 * a tool manifest and a capability. `function` resources are assumption A13 — trusted
 * code, authored by the same people who author the graph — and this loader is packaging
 * for that assumption, not a relaxation of it.
 *
 * ## The pinning rule, applied to code
 *
 * Bodies are compiled and cached per DIGEST, not per ref. Two refs resolving to the same
 * bytes share one compiled body, and a ref repointed to new bytes gets a new one — which
 * is the same guarantee the resource layer already gives prompts and profiles.
 *
 * See design/loom/08-PLAN.md open thread T2, and A13.
 */

import vm from "node:vm";

import { CODES, err } from "../errors.ts";
import type { Digest } from "../canonical.ts";
import type { FunctionBody } from "../run/registry.ts";
import type { ResourceRef } from "../graph/spec.ts";
import type { ResourceStore } from "./store.ts";

export interface FunctionLoaderOptions {
  readonly store: ResourceStore;
  /**
   * Globals the body may see. Deliberately tiny, and NOT a security control — see the
   * module docstring. `JSON` and `Math` are here because a body that cannot parse or
   * round numbers is not useful; nothing that reaches the host is.
   */
  readonly globals?: Readonly<Record<string, unknown>>;
  /** Bound on COMPILING the body, not on running it. Node timeouts bound the run. */
  readonly compileTimeoutMs?: number;
}

const SAFE_GLOBALS: Readonly<Record<string, unknown>> = {
  JSON,
  Math,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Date: undefined,
  Error,
  TypeError,
  RangeError,
  isNaN,
  isFinite,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
};

export interface FunctionLoader {
  /** Compile the body a ref pins, or `undefined` when the ref names no function. */
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
export function createFunctionLoader(opts: FunctionLoaderOptions): FunctionLoader {
  const cache = new Map<Digest, FunctionBody>();
  const timeout = opts.compileTimeoutMs ?? 1000;

  const compile = (digest: Digest, source: string, label: string): FunctionBody => {
    const hit = cache.get(digest);
    if (hit !== undefined) return hit;

    const context = vm.createContext({ ...SAFE_GLOBALS, ...opts.globals });
    let value: unknown;
    try {
      // The resource's content IS a function expression. No `module.exports` ceremony,
      // no wrapper to get wrong — the completion value is the body.
      value = vm.runInContext(`(${source})`, context, { timeout, filename: label });
    } catch (e) {
      throw err.validation(
        CODES.E_RESOURCE_INVALID,
        `function resource "${label}" did not evaluate: ${(e as Error).message}`,
        { details: { digest } },
      );
    }
    if (typeof value !== "function") {
      throw err.validation(
        CODES.E_RESOURCE_INVALID,
        `function resource "${label}" evaluated to ${typeof value}, not a function`,
        { details: { digest } },
      );
    }

    // CROSS-REALM. An object literal inside a `vm` context is built from THAT context's
    // intrinsics, so `{writes: {...}}` coming back has a different `Object.prototype`
    // than anything in the host. It looks identical, passes `typeof`, and fails
    // `deepStrictEqual` — and any downstream prototype check would quietly disagree with
    // itself depending on whether a body was loaded or hand-registered.
    //
    // Rebuilding on the way out makes a loaded body indistinguishable from a registered
    // one, and it enforces at the cheapest possible seam what channel values must be
    // anyway: plain JSON-shaped data.
    const fn = value as FunctionBody;
    const body: FunctionBody = (view, callCtx) => intoHostRealm(fn(view, callCtx)) as ReturnType<FunctionBody>;
    cache.set(digest, body);
    return body;
  };

  return {
    load(ref) {
      const resolved = opts.store.resolve(ref);
      if (resolved === undefined) return undefined;
      const record = opts.store.fetch<unknown>(resolved.digest);
      if (record.kind !== "function") return undefined;
      return compile(resolved.digest, sourceOf(record.content, ref), ref);
    },
    loadDigest(digest) {
      const record = opts.store.fetch<unknown>(digest);
      if (record.kind !== "function") {
        throw err.validation(CODES.E_RESOURCE_INVALID, `${digest} is a ${record.kind}, not a function`);
      }
      return compile(digest, sourceOf(record.content, digest), digest);
    },
    get compiled() {
      return cache.size;
    },
  };
}

/**
 * Rebuild a value using the HOST's intrinsics.
 *
 * Recursive and structural: primitives pass through, arrays and plain objects are
 * rebuilt, and anything else (a function, a class instance, a cross-realm `Map`) is
 * returned as-is so the canonicalizer can reject it with its own clear message rather
 * than this function silently mangling it into `{}`.
 */
function intoHostRealm(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  // `Array.from`, NOT `.map`: `map` goes through ArraySpeciesCreate, which uses the
  // ARRAY'S OWN constructor — so mapping a cross-realm array produces another
  // cross-realm array and the rebuild silently does nothing.
  if (Array.isArray(value)) return Array.from(value, intoHostRealm);
  const proto = Object.getPrototypeOf(value) as unknown;
  // A plain object in ANY realm has either the null prototype or one whose own
  // constructor is named "Object" — which is what distinguishes it from a Map.
  const isPlain = proto === null || (proto as { constructor?: { name?: string } })?.constructor?.name === "Object";
  if (!isPlain) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = intoHostRealm(v);
  return out;
}

/**
 * A `function` resource's content is either the source string itself or `{source}`.
 *
 * Both because the store's content is canonical JSON: a bare string round-trips fine, and
 * an object leaves room for metadata later without a migration.
 */
function sourceOf(content: unknown, label: string): string {
  if (typeof content === "string") return content;
  if (content !== null && typeof content === "object") {
    const s = (content as { source?: unknown }).source;
    if (typeof s === "string") return s;
  }
  throw err.validation(
    CODES.E_RESOURCE_INVALID,
    `function resource "${label}" has no source: expected a string or {source: string}`,
  );
}
