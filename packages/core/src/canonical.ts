/**
 * Canonical serialization and content addressing.
 *
 * `graph.hash`, `state.hash`, `ctx.hash`, resource digests, and effect result
 * digests all come from here, so this file decides whether replay verification and
 * "one artifact, no parallel representations" actually hold. Two values that a
 * reader would call equal MUST produce identical bytes; anything ambiguous is
 * rejected loudly rather than silently normalized.
 *
 * See design/loom/09 (D9.2) and 01-INTERFACES.md D3.0.
 */

import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

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
 *
 * Numbers use JSON.stringify's shortest round-trip representation, which is
 * specified by ECMA-262 and therefore stable across V8 versions.
 */
export function canonicalize(value: unknown): string {
  const seen = new Set<object>();
  const out: string[] = [];
  write(value, "", seen, out);
  return out.join("");
}

function write(value: unknown, path: string, seen: Set<object>, out: string[]): void {
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
  if (seen.has(obj)) throw new CanonicalizationError("cycle detected", path);
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
      write(item, `${path}[${i}]`, seen, out);
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
    write(v, path ? `${path}.${key}` : key, seen, out);
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
 */
export function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // A union, so a heterogeneous array is described rather than misdescribed by
    // whatever happened to be first.
    const members = [...new Set(value.map(shapeOf))].sort();
    return `[${members.join("|")}]`;
  }
  switch (typeof value) {
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${k}:${shapeOf(v)}`)
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

