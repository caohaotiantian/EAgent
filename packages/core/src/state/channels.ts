/**
 * Typed state channels and their reducers.
 *
 * All inter-node data flows through here. There is no ambient context, no implicit
 * "previous output", and no string interpolation between steps — EAgent passed data
 * by splicing `${stepId}` into strings, which is untyped, unmergeable, and
 * unverifiable (a downstream step cannot tell a summary from a stack trace).
 *
 * THE DETERMINISM RULE, stated exactly:
 *
 *   A join folds branch contributions sorted by BranchCoordinate, which is a total
 *   order fixed at fan-out time. A reducer must therefore be ASSOCIATIVE and TOTAL,
 *   but need NOT be commutative. Arrival order never affects the result.
 *
 * That is why `append_ordered` is safe and `replace` is not: both are associative,
 * but `replace` discards all but one input, so which one survives depends on a fold
 * order the author never intended to be meaningful. The compiler rejects it for
 * concurrent writers (GRAPH010) rather than making it silently arbitrary.
 *
 * See design/loom/02-EXECUTION-GRAPH.md D5.3.
 */

import { canonicalize, digest, type Digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import { compareBranch, type BranchCoordinate } from "../ids.ts";
import type { Classification } from "../vocab.ts";

export type ReducerName =
  | "replace"
  | "append_ordered"
  | "merge_object"
  | "sum"
  | "max"
  | "min"
  | "union_set"
  | "last_write_wins_by_ts";

export type ChannelType = "string" | "number" | "boolean" | "object" | "array";

/**
 * What a node's prompt actually sees of a channel.
 *
 * Declarative rather than a path expression: `fields` + `take` covers the real use
 * ("these three fields of the last twenty items") without a second parser, a second
 * error taxonomy, and a second determinism argument.
 */
export interface ContextProjection {
  /** Keep only these keys — of each element for an array, or of the object itself. */
  readonly fields?: readonly string[];
  /** Positive keeps the first N; negative keeps the last N. */
  readonly take?: number;
  readonly maxTokens: number;
  readonly overflow: "summarize" | "truncate_tail" | "error";
}

export interface ChannelSpec {
  readonly type: ChannelType;
  readonly reduce: ReducerName;
  readonly initial?: unknown;
  readonly classification?: Classification;
  readonly contextProjection?: ContextProjection;
  /** `union_set` only: the field identifying an element. Defaults to the whole value. */
  readonly identityKey?: string;
  /** `merge_object` only: what to do when two concurrent branches write the same key. */
  readonly onConflict?: "error" | "last_by_branch";
}

/**
 * Reducers that stay deterministic with more than one concurrent writer.
 * `replace` is absent on purpose — see the module docstring. `last_write_wins_by_ts`
 * is present but warned about at compile time (GRAPH013), because it makes replay
 * depend on recorded clocks.
 */
export const MULTI_WRITER_SAFE: ReadonlySet<ReducerName> = new Set<ReducerName>([
  "append_ordered",
  "merge_object",
  "sum",
  "max",
  "min",
  "union_set",
  "last_write_wins_by_ts",
]);

export const REDUCER_NAMES: readonly ReducerName[] = [
  "replace",
  "append_ordered",
  "merge_object",
  "sum",
  "max",
  "min",
  "union_set",
  "last_write_wins_by_ts",
];

/** One branch's proposed write to one channel. */
export interface Contribution {
  readonly branch: BranchCoordinate;
  readonly value: unknown;
  /** `last_write_wins_by_ts` only. Recorded effect time, never `Date.now()` at fold time. */
  readonly ts?: number;
}

export type ChannelState = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Apply contributions to one channel. Contributions are sorted by branch coordinate
 * FIRST, so this function's result is independent of the order the caller collected
 * them in — which is the property the whole parallel model rests on.
 */
export function reduceChannel(
  name: string,
  spec: ChannelSpec,
  current: unknown,
  contributions: readonly Contribution[],
): unknown {
  if (contributions.length === 0) return current;

  const ordered = [...contributions].sort((a, b) => compareBranch(a.branch, b.branch));
  let acc = current === undefined ? initialFor(spec) : current;

  for (const c of ordered) acc = step(name, spec, acc, c);
  return acc;
}

function initialFor(spec: ChannelSpec): unknown {
  if (spec.initial !== undefined) return spec.initial;
  switch (spec.reduce) {
    case "append_ordered":
    case "union_set":
      return [];
    case "merge_object":
      return {};
    case "sum":
      return 0;
    // `max`/`min` have no safe identity element (0 is wrong for negative inputs,
    // and Infinity is not representable in the canonical form), so the first
    // contribution seeds them.
    case "max":
    case "min":
    case "replace":
    case "last_write_wins_by_ts":
      return undefined;
  }
}

function step(name: string, spec: ChannelSpec, acc: unknown, c: Contribution): unknown {
  switch (spec.reduce) {
    case "replace":
      return c.value;

    case "append_ordered": {
      const base = asArray(name, acc, []);
      // A contribution may be one element or a batch; both are common and the
      // distinction is not worth a second reducer.
      return Array.isArray(c.value) ? [...base, ...c.value] : [...base, c.value];
    }

    case "merge_object": {
      const base = asObject(name, acc, {});
      const incoming = asObject(name, c.value, undefined);
      const out: Record<string, unknown> = { ...base };
      for (const [k, v] of Object.entries(incoming)) {
        if (k in out && spec.onConflict !== "last_by_branch" && !sameValue(out[k], v)) {
          throw err.validation(
            CODES.E_INTERNAL,
            `channel "${name}": merge_object conflict on key "${k}" from concurrent branches ` +
              `(declare onConflict: "last_by_branch" if later branches should win)`,
            { details: { channel: name, key: k } },
          );
        }
        out[k] = v;
      }
      return out;
    }

    case "sum":
      return asNumber(name, acc, 0) + asNumber(name, c.value, undefined);

    case "max": {
      const v = asNumber(name, c.value, undefined);
      return acc === undefined ? v : Math.max(asNumber(name, acc, undefined), v);
    }

    case "min": {
      const v = asNumber(name, c.value, undefined);
      return acc === undefined ? v : Math.min(asNumber(name, acc, undefined), v);
    }

    case "union_set": {
      const base = asArray(name, acc, []);
      const incoming = Array.isArray(c.value) ? c.value : [c.value];
      const seen = new Set(base.map((v) => identityOf(v, spec.identityKey)));
      const out = [...base];
      for (const v of incoming) {
        const id = identityOf(v, spec.identityKey);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(v);
      }
      return out;
    }

    case "last_write_wins_by_ts": {
      // Fold order is still branch order; `ts` only decides which value survives, and
      // a tie falls back to branch order (the later branch wins) so the result is
      // total even when two effects share a recorded millisecond.
      const prev = acc as { value: unknown; ts: number } | undefined;
      const ts = c.ts ?? 0;
      if (prev === undefined || ts >= prev.ts) return { value: c.value, ts };
      return prev;
    }
  }
}

/** `last_write_wins_by_ts` carries its timestamp internally; unwrap for readers. */
export function channelValue(spec: ChannelSpec, stored: unknown): unknown {
  if (spec.reduce !== "last_write_wins_by_ts") return stored;
  return (stored as { value: unknown } | undefined)?.value;
}

function identityOf(v: unknown, key: string | undefined): string {
  if (key !== undefined && v !== null && typeof v === "object" && key in (v as object)) {
    return canonicalize((v as Record<string, unknown>)[key]);
  }
  return canonicalize(v);
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function asArray(channel: string, v: unknown, fallback: unknown[] | undefined): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined && fallback !== undefined) return fallback;
  throw typeError(channel, "array", v);
}

function asObject(channel: string, v: unknown, fallback: Record<string, unknown> | undefined): Record<string, unknown> {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (v === undefined && fallback !== undefined) return fallback;
  throw typeError(channel, "object", v);
}

function asNumber(channel: string, v: unknown, fallback: number | undefined): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v === undefined && fallback !== undefined) return fallback;
  throw typeError(channel, "number", v);
}

function typeError(channel: string, want: string, got: unknown): Error {
  return err.validation(
    CODES.E_INTERNAL,
    `channel "${channel}": expected ${want}, got ${got === null ? "null" : typeof got}`,
    { details: { channel, want } },
  );
}

// ---------------------------------------------------------------------------
// Whole-state operations
// ---------------------------------------------------------------------------

export interface ReduceResult {
  readonly state: ChannelState;
  readonly channels: readonly string[];
  readonly stateHashBefore: Digest;
  readonly stateHashAfter: Digest;
}

/** Apply a whole wave of contributions, grouped by channel. One `state.reduced` event. */
export function reduceState(
  specs: Readonly<Record<string, ChannelSpec>>,
  current: ChannelState,
  wave: Readonly<Record<string, readonly Contribution[]>>,
): ReduceResult {
  const before = stateHash(current);
  const next: Record<string, unknown> = { ...current };
  const touched: string[] = [];

  // Sorted so the emitted `channels` list and any downstream digest are stable.
  for (const channel of Object.keys(wave).sort()) {
    const spec = specs[channel];
    if (spec === undefined) {
      throw err.validation(CODES.E_CHANNEL_UNDECLARED, `write to undeclared channel "${channel}"`, {
        details: { channel },
      });
    }
    const contributions = wave[channel] ?? [];
    if (contributions.length === 0) continue;
    next[channel] = reduceChannel(channel, spec, current[channel], contributions);
    touched.push(channel);
  }

  return { state: next, channels: touched, stateHashBefore: before, stateHashAfter: stateHash(next) };
}

/** Channel state seeded from declared initials. */
export function initialState(specs: Readonly<Record<string, ChannelSpec>>): ChannelState {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.initial !== undefined) out[name] = spec.initial;
  }
  return out;
}

export function stateHash(state: ChannelState): Digest {
  return digest(state);
}

// ---------------------------------------------------------------------------
// StateView — what a Task is allowed to see
// ---------------------------------------------------------------------------

export interface StateView {
  get<T = unknown>(channel: string): T | undefined;
  /** Throws E_CHANNEL_UNDECLARED if the node did not declare `channel` in `reads`. */
  require<T = unknown>(channel: string): T;
  readonly hash: Digest;
  readonly visible: readonly string[];
}

/**
 * A read-only projection restricted to a node's declared `reads`.
 *
 * The restriction is not bureaucracy: it lets the compiler prove data dependencies
 * without executing anything, lets the scheduler know which Tasks conflict, and lets
 * the context assembler know exactly what may enter a prompt.
 */
export function makeStateView(
  specs: Readonly<Record<string, ChannelSpec>>,
  state: ChannelState,
  reads: readonly string[],
): StateView {
  const allowed = new Set(reads);
  const slice: Record<string, unknown> = {};
  for (const name of [...allowed].sort()) {
    const spec = specs[name];
    if (spec === undefined) continue;
    const v = channelValue(spec, state[name]);
    if (v !== undefined) slice[name] = v;
  }
  const hash = digest(slice);

  return {
    get<T>(channel: string): T | undefined {
      if (!allowed.has(channel)) return undefined;
      return slice[channel] as T | undefined;
    },
    require<T>(channel: string): T {
      if (!allowed.has(channel)) {
        throw err.validation(
          CODES.E_CHANNEL_UNDECLARED,
          `channel "${channel}" is not in this node's declared reads`,
          { details: { channel, reads: [...allowed] } },
        );
      }
      const v = slice[channel];
      if (v === undefined) {
        throw err.validation(CODES.E_CHANNEL_UNDECLARED, `channel "${channel}" has no value yet`, {
          details: { channel },
        });
      }
      return v as T;
    },
    hash,
    visible: Object.keys(slice),
  };
}
