/**
 * Canonical serialization and content addressing.
 *
 * `graph.hash`, `state.hash`, `ctx.hash`, resource digests, and effect result
 * digests all come from here, so this file decides whether replay verification and
 * "one artifact, no parallel representations" actually hold. Two values that a
 * reader would call equal MUST produce identical bytes; anything ambiguous is
 * rejected loudly rather than silently normalized.
 *
 */

import { createHash } from "node:crypto";
import { CODES, type LoomError, err } from "./errors.ts";

export type Digest = `sha256:${string}`;

/**
 * How many nested containers this file will walk. Chosen from a measurement, not a feeling.
 *
 * The recursion below had no floor, and `journal/store.ts`'s `prepare` calls it on EVERY
 * payload and EVERY actor — so a deep enough value threw a bare `RangeError: Maximum call
 * stack size exceeded` out of the durable write path. Measured on Node 24.16, macOS arm64,
 * default stack, by sweeping depth upward until it died (`canonicalize` alone, ascending
 * sweep in steps of 100):
 *
 *     flat call stack          died at depth 5700
 *     under 1000 caller frames died at depth 5100
 *     under 3000 caller frames died at depth 3800
 *
 * The number is therefore not a property of this file: it falls by roughly two depths for
 * every three frames the caller is already down (5700 → 3800 under 3000 frames), and
 * `Engine` → `#serialize` → `append` is a long way down. It also moves with `--stack-size`,
 * with the platform, and with whether V8 has tiered the frames up yet.
 *
 * The other end was measured too, rather than asserted. Instrumenting this function to
 * record the deepest container it entered, then running the suite's run, graph, state,
 * resource, telemetry, evolution, workflow, server, builtin, retention, CLI and scale
 * files — every real payload, graph spec, tool result, gate payload and channel map the
 * project has — the deepest value ever canonicalized was NINE containers. The
 * distribution: 29 processes peaked at 7, and only two reached 9.
 *
 * So 256 sits ~15x below the worst crash depth measured and ~28x above the deepest real
 * value measured. That two-sided gap is what makes the limit a property of this file
 * rather than of the machine, and it is why the refusal is not a tax on anything the
 * system actually does. (The suite is not production, and the numbers above are the
 * evidence available offline — not a proof that no payload will ever nest deeper.)
 *
 * REFUSE, NEVER TRUNCATE. A canonicalizer that clipped at depth would emit a digest over a
 * value that is not the value, and `digest` is what replay compares recorded effects
 * against — so truncation converts a loud crash into a silent divergence, which is worse.
 *
 * Raising it is safe up to the measured wall; lowering it is a compatibility break, because
 * a journal written under a higher limit can hold values this one would now refuse to
 * re-canonicalize.
 */
const MAX_DEPTH = 256;

/**
 * The one refusal in this file that is a typed `LoomError` rather than a
 * `CanonicalizationError`.
 *
 * Deliberate, and deliberately narrow: this is the refusal that replaced a `RangeError` on
 * the durable write path, where a caller needs to be told "your value, never retry" in the
 * vocabulary the retry policy and the HTTP mapping already branch on. The other refusals
 * here remain untyped and still surface as `E_INTERNAL`; `state/channels.ts` and
 * `run/gates.ts` each document a case where that was measured. Converting them is a
 * separate change with its own blast radius (every `assert.throws(…, CanonicalizationError)`
 * in the suite), and claiming it here would be a claim wider than this mechanism.
 *
 * The path is CLIPPED FROM THE HEAD, and BOTH copies of it are — the message and
 * `details.path`. At depth 20_000 the natural path is 40_000 characters, and
 * `journal/events.ts`'s `errorRecord` copies `message` and `details` verbatim into a
 * `task.failed` payload, so an unbounded string here would trade the stack overflow for a
 * durable write of the thing that caused it. The head is the half that says WHERE in the
 * payload the nest hangs; the tail is `[0][0][0]…` and says nothing.
 */
function tooDeep(depth: number, path: string): LoomError {
  const where = path.length > 96 ? `${path.slice(0, 96)}…` : path || "<root>";
  return err.validation(
    CODES.E_PAYLOAD_TOO_DEEP,
    `nesting is ${depth} levels deep, limit is ${MAX_DEPTH}, at ${where}`,
    { details: { depth, limit: MAX_DEPTH, path: where } },
  );
}

export class CanonicalizationError extends Error {
  override readonly name = "CanonicalizationError";
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path || "<root>"}`);
    this.path = path;
  }
}

/**
 * Deterministic JSON:
 *   - object keys sorted by UTF-16 code unit
 *   - properties whose value is `undefined` are omitted
 *   - `-0` normalized to `0`
 *   - NaN, Infinity, undefined-in-array, bigint, symbol, function: REJECTED
 *   - Date, Map, Set: REJECTED
 *   - typed arrays, ArrayBuffer, DataView, RegExp: REJECTED — `Object.keys` describes
 *     something other than their content, so they collided with plain objects
 *   - cycles: REJECTED
 *   - more than `MAX_DEPTH` nested containers: REJECTED — and this one alone throws a
 *     typed `LoomError` (`E_PAYLOAD_TOO_DEEP`, class `validation`), not a
 *     `CanonicalizationError`. See `MAX_DEPTH` and `tooDeep` above for why.
 *
 * Numbers use JSON.stringify's shortest round-trip representation, which is
 * specified by ECMA-262 and therefore stable across V8 versions.
 */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();
  const out: string[] = [];
  write(value, "", seen, out, 0);
  return out.join("");
}

/** `depth` is the number of containers already entered; the root value is at 0. */
function write(value: unknown, path: string, seen: Set<object>, out: string[], depth: number): void {
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number": {
      if (!Number.isFinite(value)) throw new CanonicalizationError(`non-finite number ${String(value)}`, path);
      out.push(JSON.stringify(Object.is(value, -0) ? 0 : value));
      return;
    }
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "undefined":
      throw new CanonicalizationError("undefined is not representable here", path);
    case "bigint":
      throw new CanonicalizationError("bigint is not representable; use a string", path);
    case "symbol":
      throw new CanonicalizationError("symbol is not representable", path);
    case "function":
      throw new CanonicalizationError("function is not representable", path);
    case "object":
      break;
  }

  const obj = value as object;
  // THE CYCLE CHECK GOES FIRST, and that ordering is the point: a cyclic value would also
  // trip the depth limit, but "cycle detected" is the precise answer and this one is the
  // fallback. Reversing them would silently reclassify every cyclic value as too deep.
  if (seen.has(obj)) throw new CanonicalizationError("cycle detected", path);
  // Checked on ENTRY to a container, before `seen.add`, so there is no bookkeeping to undo
  // on the way out. `depth` counts containers, not values, so the reported number reads the
  // way a person counts nesting: `{a:{a:1}}` is two.
  if (depth >= MAX_DEPTH) throw tooDeep(depth + 1, path);
  seen.add(obj);

  if (Array.isArray(obj)) {
    out.push("[");
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) out.push(",");
      const item = obj[i];
      if (item === undefined) {
        // JSON.stringify would silently coerce this to null; that would make two
        // materially different arrays hash the same. Refuse instead.
        throw new CanonicalizationError("undefined array element", `${path}[${i}]`);
      }
      write(item, `${path}[${i}]`, seen, out, depth + 1);
    }
    out.push("]");
    seen.delete(obj);
    return;
  }

  if (obj instanceof Date) throw new CanonicalizationError("Date is not representable; use epoch millis", path);
  if (obj instanceof Map || obj instanceof Set) {
    throw new CanonicalizationError(`${obj.constructor.name} is not representable; use a plain object/array`, path);
  }

  // OBJECTS WHOSE CONTENT `Object.keys` CANNOT SEE. The fallthrough below is a fold over
  // own enumerable string keys, which for these types describes something other than the
  // value — so two values a reader would never call equal produced identical bytes, in the
  // one function `graph.hash`, `state.hash`, every resource digest and every recorded
  // effect digest are built on. Three collisions, all live before this guard:
  //
  //   `new Uint8Array([1,2,3])`      → {"0":1,"1":2,"2":3}   — a typed array's keys are its
  //   `{0:1, 1:2, 2:3}`              → {"0":1,"1":2,"2":3}     INDICES, so it is
  //   `new Float64Array([1,2,3])`    → {"0":1,"1":2,"2":3}     indistinguishable from a
  //                                                            plain index-keyed object,
  //                                                            and from a typed array of
  //                                                            eight times the width.
  //
  //   `new ArrayBuffer(8)`           → {}   — no own enumerable keys AT ALL, so every
  //   `new DataView(buf)`            → {}     buffer of every length and content shared
  //   `/abc/g`                       → {}     one content address with the empty object.
  //
  // Rejected rather than encoded, on the rule this file opens with: anything ambiguous is
  // refused loudly. Encoding them would also be a choice about representation (base64? an
  // array of byte values?) that the caller is better placed to make and that the journal
  // would then be stuck with. `ArrayBuffer.isView` and the string tag are used instead of
  // `instanceof` so a value from another realm — a `vm` context, a worker — is caught too.
  const tag = Object.prototype.toString.call(obj);
  if (ArrayBuffer.isView(obj) || tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
    throw new CanonicalizationError(
      `${tag.slice(8, -1)} is not representable; use an array of numbers or a base64 string`,
      path,
    );
  }
  if (tag === "[object RegExp]") {
    throw new CanonicalizationError("RegExp is not representable; use its source as a string", path);
  }

  const record = obj as Record<string, unknown>;
  // Own enumerable string keys only, sorted by code unit. `sort()` with no
  // comparator is exactly UTF-16 code-unit order, which is what we want: it is
  // locale-independent, unlike `localeCompare`.
  const keys = Object.keys(record).sort();
  out.push("{");
  let first = true;
  for (const key of keys) {
    const v = record[key];
    if (v === undefined) continue; // omit, matching JSON.stringify's object behaviour
    if (!first) out.push(",");
    first = false;
    out.push(JSON.stringify(key), ":");
    write(v, path ? `${path}.${key}` : key, seen, out, depth + 1);
  }
  out.push("}");
  seen.delete(obj);
}

/** `sha256:<hex>` of the canonical form. The system's only content-address function. */
export function digest(value: unknown): Digest {
  return digestOf(canonicalize(value));
}

/** Digest of an already-canonical string (or any raw text/bytes). */
export function digestOf(canonicalText: string): Digest {
  return `sha256:${createHash("sha256").update(canonicalText, "utf8").digest("hex")}`;
}

/** A short, human-quotable prefix for logs and UI. Never used for equality. */
export function shortDigest(d: Digest): string {
  return d.slice("sha256:".length, "sha256:".length + 12);
}

/** Structural equality by content address. Cheaper to reason about than deep-equal. */
export function sameContent(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * A deep clone that is guaranteed to round-trip through the canonical form.
 * Used wherever a value crosses a trust boundary (a hook rewriting args, a decision
 * payload handed to a UI) so a caller cannot retain a mutable reference into state.
 */
export function frozenClone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

/**
 * The TYPE SHAPE of a value, with every value erased.
 *
 * `{namespace: "prod-payments", replicas: 3}` becomes `{namespace:string,replicas:number}`.
 *
 * This is what a trajectory records instead of tool arguments. Structure generalises —
 * "this strategy calls k8s.describe with a pod name" is a fact about the strategy —
 * while values do not generalise and do leak: a trajectory store that keeps them is a
 * second copy of production data, subject to every rule the first copy is.
 *
 * Keys are kept and sorted, so two calls with the same argument structure render
 * identically regardless of key order.
 *
 * IT IS BOUNDED BY THE SAME `MAX_DEPTH`, because it is the same defect one function over.
 * `Engine.#invokeTool` calls `shapeOf(final.value)` on post-hook TOOL ARGUMENTS — a
 * model-authored value — while building a `tool.called` payload, and the argument is
 * evaluated EAGERLY, before `append` is entered. So bounding only `canonicalize` would have
 * left that call dying on the same bare `RangeError` a few frames earlier, with the new
 * guard never reached.
 *
 * Refusing rather than clipping, for `canonicalize`'s reason: `retention.ts` digests
 * `argsShape`, so a clipped shape is a content address over a shape that is not the shape.
 *
 * The refusal says `<shape>` where `canonicalize`'s says a path: this function does not
 * build one, and inventing a path here would be a claim about a location it never tracked.
 */
export function shapeOf(value: unknown): string {
  return shapeAt(value, 0);
}

/**
 * Private, and the recursion lives here rather than in `shapeOf` for a concrete reason:
 * `value.map(shapeOf)` passes `(item, index, array)`, so a second parameter on the PUBLIC
 * function would silently receive the array index as its depth.
 */
function shapeAt(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (depth >= MAX_DEPTH) throw tooDeep(depth + 1, "<shape>");
    // A union, so a heterogeneous array is described rather than misdescribed by
    // whatever happened to be first.
    const members = [...new Set(value.map((item) => shapeAt(item, depth + 1)))].sort();
    return `[${members.join("|")}]`;
  }
  switch (typeof value) {
    case "object": {
      if (depth >= MAX_DEPTH) throw tooDeep(depth + 1, "<shape>");
      const entries = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}:${shapeAt(v, depth + 1)}`)
        .sort();
      return `{${entries.join(",")}}`;
    }
    case "boolean":
    case "number":
    case "string":
      return typeof value;
    default:
      return "unknown";
  }
}

