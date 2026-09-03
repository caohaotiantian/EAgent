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

/**
 * One TASK's proposed write to one channel.
 *
 * Not one branch's: a branch is a path, and a path can hold several nodes, each of which
 * may write. Keying on the coordinate alone left those tied, and a tie in the sort key is
 * arrival order wearing a different hat — which is exactly what invariant 7 exists to
 * forbid. `nodeId` and `iteration` are the two remaining coordinates of a Task, so
 * carrying them makes the key total.
 */
export interface Contribution {
  readonly branch: BranchCoordinate;
  readonly nodeId: string;
  readonly iteration: number;
  readonly value: unknown;
  /** `last_write_wins_by_ts` only. Recorded effect time, never `Date.now()` at fold time. */
  readonly ts?: number;
}

/**
 * The total order contributions fold in: branch coordinate, then iteration, then node id.
 *
 * Node id breaks the last tie by code unit rather than by anything semantic, because the
 * only property required of it is that it is total and derived from the graph — two
 * contributions from one Task cannot exist, so no further key is needed.
 */
export function compareContribution(a: Contribution, b: Contribution): number {
  const byBranch = compareBranch(a.branch, b.branch);
  if (byBranch !== 0) return byBranch;
  if (a.iteration !== b.iteration) return a.iteration - b.iteration;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

export type ChannelState = Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/**
 * Apply contributions to one channel. Contributions are sorted by the TOTAL key
 * (`compareContribution`) FIRST, so this function's result is independent of the order the
 * caller collected them in — which is the property the whole parallel model rests on. A
 * partial key would leave ties to be broken by arrival, which is the same defect one level
 * down.
 */
export function reduceChannel(
  name: string,
  spec: ChannelSpec,
  current: unknown,
  contributions: readonly Contribution[],
): unknown {
  if (contributions.length === 0) return current;

  const ordered = [...contributions].sort(compareContribution);
  let acc = current === undefined ? initialFor(spec) : current;

  for (const c of ordered) acc = step(name, spec, acc, c);
  return acc;
}

/**
 * Fold a wave WITHOUT applying it to channel state — the partial fold a join inside a
 * fan-out returns as its own write.
 *
 * Seeded from the reducer's algebraic identity rather than from `spec.initial`, because
 * this result will be folded again by the enclosing join: seeding with `initial` would
 * apply it once per inner branch, so a `sum` with `initial: 10` over three branches would
 * arrive at the outer join already carrying 30.
 */
export function foldPartial(
  specs: Readonly<Record<string, ChannelSpec>>,
  wave: Readonly<Record<string, readonly Contribution[]>>,
): { readonly values: Record<string, unknown>; readonly channels: readonly string[] } {
  const values: Record<string, unknown> = {};
  const channels: string[] = [];
  for (const name of Object.keys(wave).sort()) {
    const spec = specs[name];
    const list = wave[name];
    if (spec === undefined || list === undefined || list.length === 0) continue;
    const folded = reduceChannel(name, spec, identityFor(spec), list);
    if (folded === undefined) continue;
    // A held `last_write_wins_by_ts` value is the `{value, ts}` envelope `step` builds.
    // The enclosing fold re-wraps, so hand it the bare value or the timestamp is lost.
    values[name] =
      spec.reduce === "last_write_wins_by_ts" && typeof folded === "object" && folded !== null && "value" in folded
        ? (folded as { value: unknown }).value
        : folded;
    channels.push(name);
  }
  return { values, channels };
}

/** `initialFor` without the `spec.initial` shortcut — the reducer's identity alone. */
function identityFor(spec: ChannelSpec): unknown {
  switch (spec.reduce) {
    case "append_ordered":
    case "union_set":
      return [];
    case "merge_object":
      return {};
    case "sum":
      return 0;
    case "max":
    case "min":
    case "replace":
    case "last_write_wins_by_ts":
      return undefined;
  }
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
        // OWN KEYS ON BOTH SIDES OF THE STEP, which is the rule `declared()` and `own()` in this
        // same file exist to state and this site did not remember. A node body writes JSON, and
        // `toString`, `constructor`, `valueOf`, `hasOwnProperty` and `__proto__` are all legal
        // JSON keys: `k in out` was true for every one of them on an accumulator that declared
        // none, so the conflict check compared the incoming value against an inherited FUNCTION
        // and `sameValue` threw an untyped `CanonicalizationError` — a crash where a merge was
        // the correct answer. The assignment is the worse half: `out["__proto__"] = v` goes
        // through `Object.prototype`'s setter, so under `onConflict: "last_by_branch"` the
        // author's key silently vanished and the channel's value came back with an
        // attacker-supplied prototype that `stateHash` — own keys only — could not see.
        // `defineProperty` is the shape `graph/yaml.ts`'s `put()` already settled on.
        if (Object.hasOwn(out, k) && spec.onConflict !== "last_by_branch" && !sameValue(out[k], v)) {
          throw err.validation(
            CODES.E_INTERNAL,
            `channel "${name}": merge_object conflict on key "${k}" from concurrent branches ` +
              `(declare onConflict: "last_by_branch" if later branches should win)`,
            { details: { channel: name, key: k } },
          );
        }
        Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
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
  // OWN, for the same reason the `merge_object` step above is: a declared `identity` of
  // `toString` found the inherited function on every element and `canonicalize` refused it, so
  // the dedup key was a throw rather than an identity.
  if (key !== undefined && v !== null && typeof v === "object" && Object.hasOwn(v as object, key)) {
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
    `channel "${channel}": expected ${want}, got ${describe(got)}`,
    { details: { channel, want, got: describe(got) } },
  );
}

/**
 * What the value IS, in words a reader can act on.
 *
 * `typeof` alone answered `expected number, got number` for `NaN` — the one refusal in this
 * file whose message cannot be diagnosed from itself, because `asNumber` refuses a non-finite
 * number (correctly: a channel folding NaN poisons every later `sum`, `max` and `min`) and
 * `typeof NaN` is "number". Arrays are the same shape at one remove: `typeof [1]` is "object",
 * so an array written to an `object` channel read `expected object, got object`.
 *
 * The three cases `typeof` gets wrong, and nothing more. The VALUE is deliberately not shown:
 * a channel holds model and tool output, and this string reaches a journal.
 */
function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && !Number.isFinite(v)) return String(v);
  return typeof v;
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

/**
 * The channel a graph DECLARED, or nothing — never something `Object.prototype` supplied.
 *
 * `specs[channel]` is a bare index, and `specs["constructor"]` answers with the `Object`
 * FUNCTION rather than `undefined`, so the one check standing between a node body's write
 * vocabulary and the graph's declared channels did not run for four names. Reproduced
 * against `specs = {findings}`:
 *
 *     reduceState({constructor}) → ACCEPTED  channels=["constructor"]  state={}
 *     reduceState({toString})    → ACCEPTED  channels=["toString"]     state={}
 *     reduceState({nope})        → refused: E_CHANNEL_UNDECLARED
 *
 * Nothing landed in state, so that half was a fail-OPEN REFUSAL rather than a corruption —
 * but the `state.reduced` event it emitted named a channel no graph declares and no reducer
 * wrote. `makeStateView`'s slice loop is the worse half and is the same lookup: `graph/compile`
 * admits `reads: ["constructor"]` with only a WARNING, and the measured outcome there was the
 * whole run dying on `digest(slice)` with an untyped `E_INTERNAL` — *"function is not
 * representable at constructor"* — rather than the `E_CHANNEL_UNDECLARED` the check promises.
 *
 * ONE helper rather than a guard at each site: this is the same prototype-chain hazard
 * `gateOf` was written for in `run/projection.ts`, and that one's docstring makes the
 * argument — a rule that holds for the door that remembered it is not a rule. `initialState`
 * deliberately does NOT use it: it iterates `Object.entries(specs)`, which is own-enumerable
 * only and already total.
 */
function declared(
  specs: Readonly<Record<string, ChannelSpec>>,
  channel: string,
): ChannelSpec | undefined {
  return Object.prototype.hasOwnProperty.call(specs, channel) ? specs[channel] : undefined;
}

/**
 * The same rule for a channel's VALUE: `state["toString"]` is not a channel value.
 *
 * Used at THREE sites, which is the point — `makeStateView` builds a slice and then `get`
 * and `require` read it back, and fixing only the construction left the two readers bare.
 * That is the habit this codebase keeps relearning: making the reads total is a claim about
 * a SET of reads, so the job is to enumerate the set rather than to fix the one that was
 * noticed.
 */
function own(state: Readonly<Record<string, unknown>>, channel: string): unknown {
  return Object.prototype.hasOwnProperty.call(state, channel) ? state[channel] : undefined;
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
    const spec = declared(specs, channel);
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
    const spec = declared(specs, name);
    if (spec === undefined) continue;
    const v = channelValue(spec, own(state, name));
    if (v !== undefined) slice[name] = v;
  }
  const hash = digest(slice);

  return {
    get<T>(channel: string): T | undefined {
      // BOTH conditions, and the second is not redundant with the first. The allow-list
      // stops a channel the node did not declare; it does NOT stop one it DID — and
      // `graph/compile` admits `reads: ["constructor"]` with only a warning, so
      // `allowed.has("constructor")` is true and `slice["constructor"]` answers with the
      // `Object` function. That is a host function pulled through a state read and into the
      // determinism boundary, which is the thing this method's allow-list exists to prevent,
      // reached through the door it opens rather than the one it closes.
      if (!allowed.has(channel)) return undefined;
      return own(slice, channel) as T | undefined;
    },
    require<T>(channel: string): T {
      if (!allowed.has(channel)) {
        throw err.validation(
          CODES.E_CHANNEL_UNDECLARED,
          `channel "${channel}" is not in this node's declared reads`,
          { details: { channel, reads: [...allowed] } },
        );
      }
      const v = own(slice, channel);
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
