/**
 * ONE HARDENED COMPILE PATH FOR EVERY RESOURCE THAT IS CODE.
 *
 * `function` bodies and `hook` bodies are both published source, both pinned by digest, and
 * both have to be handed arguments without handing over the host realm with them. They differ
 * only in what those arguments ARE — `(view, ctx)` for a function node, `(input, ctx)` for a
 * hook. Everything else is identical, and everything else is the part that is easy to get
 * wrong: this module's predecessor shipped a live escape,
 *
 *     view.constructor.constructor("return globalThis")().process   → object
 *
 * where the globals had been rebuilt out of the context's own intrinsics and the ARGUMENTS
 * had not. The fix — rebuild the arguments inside the context from a JSON payload — is one
 * pattern applied at one seam. Forking it per resource kind would mean the next such fix
 * lands in one copy of two, so the seam is factored here and each caller supplies only its
 * BRIDGE: the few lines that turn a JSON payload into that kind's argument list.
 *
 * ## This is NOT a security boundary, and says so
 *
 * `node:vm` does not isolate untrusted code. A fresh context is a scoping mechanism. What it
 * buys is real but narrow: a body sees a small explicit set of globals — THAT CONTEXT'S OWN
 * copies — instead of the host's, and no host object is ever in its reach. Untrusted code
 * belongs in `sandbox/subprocess.ts`, behind a tool manifest and a capability. Code resources
 * are assumption A13: trusted, authored by whoever authors the graph.
 */

import vm from "node:vm";

import { CODES, err } from "../errors.ts";

/**
 * The globals a body may see. Everything absent is absent on purpose.
 *
 * `Date` is bound to `undefined` rather than copied: a body that reads the wall clock makes
 * its own replay non-deterministic and the journal has no effect key for it. `Math` IS here and
 * stays here, because its `random` is now REPLACED rather than removed: `functions.ts`'s bridge
 * installs a PRNG seeded from a value the engine journals under `effectKey(taskId, "random", 0)`,
 * so a body's draws are served on replay instead of diverging. The asymmetry that used to be
 * invariant 4's known gap is closed.
 *
 * `Date` STAYS ABSENT, and the reason changed. It used to be "a clock read has no seed that would
 * make it reproducible"; that is no longer true — `ctx.now` is bound to the task's journaled lease
 * timestamp, so a body CAN read a reproducible time. What `Date` would add is a second clock with
 * different semantics: `Date.now()` inside a body would have to be frozen to the same instant to
 * stay replayable, and a frozen `Date` that silently never advances is more surprising than one
 * that is not there. Restoring it means binding the whole constructor to `ctx.now`, which is real
 * work and is recorded in TODO.md rather than half-done here.
 */
const SAFE_GLOBAL_NAMES = [
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Error",
  "TypeError",
  "RangeError",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
] as const;

function safeGlobals(context: object): Record<string, unknown> {
  const own = vm.runInContext(`({ ${SAFE_GLOBAL_NAMES.join(", ")} })`, context) as Record<string, unknown>;
  return { ...own, Date: undefined };
}

/** Invoke a compiled body through its bridge. The payload is serialized; the answer is host-realm. */
export type RealmCall = (payload: unknown) => unknown;

export interface RealmOptions {
  /** The resource's content: a function expression. */
  readonly source: string;
  /** What to call this in an error — a ref or a digest. */
  readonly label: string;
  /** What kind of resource this is, for error text: `function`, `hook`. */
  readonly what: string;
  /**
   * Code defining `globalThis[entry] = function (payloadJson) { … __loomBody(…) }`.
   *
   * It runs INSIDE the context, so everything it builds carries the context's intrinsics —
   * which is the whole mechanism. A bridge that closes over a host value defeats it.
   */
  readonly bridge: string;
  /** The name `bridge` defines. */
  readonly entry: string;
  readonly globals?: Readonly<Record<string, unknown>> | undefined;
  readonly compileTimeoutMs: number;
  readonly callTimeoutMs: number;
}

export function compileRealm(opts: RealmOptions): RealmCall {
  // Created EMPTY, then given its own intrinsics back plus whatever the embedder injected.
  // Seeding it with host objects is what opened the bridge the first time.
  const context = vm.createContext({});
  Object.assign(context, safeGlobals(context), opts.globals);
  let value: unknown;
  try {
    // The content IS a function expression — no `module.exports` ceremony, no wrapper to get
    // wrong. It is KEPT IN THE CONTEXT rather than handed back, because the call happens in
    // there too.
    vm.runInContext(`globalThis.__loomBody = (${opts.source});`, context, {
      timeout: opts.compileTimeoutMs,
      filename: opts.label,
    });
    vm.runInContext(opts.bridge, context, {
      timeout: opts.compileTimeoutMs,
      filename: `${opts.label} (bridge)`,
    });
    value = (context as Record<string, unknown>)["__loomBody"];
  } catch (e) {
    throw err.validation(
      CODES.E_RESOURCE_INVALID,
      `${opts.what} resource "${opts.label}" did not evaluate: ${(e as Error).message}`,
    );
  }
  if (typeof value !== "function") {
    throw err.validation(
      CODES.E_RESOURCE_INVALID,
      `${opts.what} resource "${opts.label}" evaluated to ${typeof value}, not a function`,
    );
  }
  if (typeof (context as Record<string, unknown>)[opts.entry] !== "function") {
    // A bridge that did not define its entry would fail later as `__loomInvoke is not
    // defined`, from inside a run, attributed to the body rather than to the bridge.
    throw err.internal(CODES.E_INTERNAL, `bridge for "${opts.label}" did not define ${opts.entry}`);
  }

  return (payload) => {
    // ONLY JSON CROSSES. Everything the body sees is rebuilt from this string INSIDE the
    // context, so no host object is ever in its reach.
    const out = vm.runInContext(`${opts.entry}(${JSON.stringify(JSON.stringify(payload))})`, context, {
      timeout: opts.callTimeoutMs,
      filename: opts.label,
    });
    return intoHostRealm(out);
  };
}

/**
 * Rebuild a value using the HOST's intrinsics.
 *
 * Recursive and structural: primitives pass through, arrays and plain objects are rebuilt, and
 * anything else (a function, a class instance, a cross-realm `Map`) is returned as-is so the
 * canonicalizer can reject it with its own clear message rather than this function silently
 * mangling it into `{}`.
 *
 * An object literal inside a `vm` context is built from THAT context's intrinsics, so
 * `{writes: {…}}` coming back has a different `Object.prototype` than anything in the host. It
 * looks identical, passes `typeof`, and fails `deepStrictEqual` — and any downstream prototype
 * check would quietly disagree with itself depending on whether a body was loaded or
 * hand-registered.
 */
export function intoHostRealm(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  // `Array.from`, NOT `.map`: `map` goes through ArraySpeciesCreate, which uses the ARRAY'S OWN
  // constructor — so mapping a cross-realm array produces another cross-realm array and the
  // rebuild silently does nothing.
  if (Array.isArray(value)) return Array.from(value, intoHostRealm);
  const proto = Object.getPrototypeOf(value) as unknown;
  // A plain object in ANY realm has either the null prototype or one whose own constructor is
  // named "Object" — which is what distinguishes it from a Map.
  const isPlain = proto === null || (proto as { constructor?: { name?: string } })?.constructor?.name === "Object";
  if (!isPlain) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = intoHostRealm(v);
  return out;
}

/**
 * A code resource's content is either the source string itself or `{source}`.
 *
 * Both because the store's content is canonical JSON: a bare string round-trips fine, and an
 * object leaves room for metadata later without a migration.
 */
export function sourceOf(content: unknown, label: string, what: string): string {
  if (typeof content === "string") return content;
  if (content !== null && typeof content === "object") {
    const s = (content as { source?: unknown }).source;
    if (typeof s === "string") return s;
  }
  throw err.validation(
    CODES.E_RESOURCE_INVALID,
    `${what} resource "${label}" has no source: expected a string or {source: string}`,
  );
}
