/**
 * The hook bus — the extension surface, and the reason a graph can be extended without
 * editing the engine.
 *
 * `GraphSpec.hooks` has been in the schema since the first compiler, shape-validated, with its
 * refs pinned into the resolution manifest; `hook.applied` has been in `EVENT_TYPES` with no
 * appender; and `"hook"` has been a `ResourceKind`. Everything except the bus itself existed.
 * A declared-and-never-invoked extension point reads, from any single file, exactly like one
 * that works — which is the defect this module closes.
 *
 * THREE RULES CARRY THE DESIGN, and each exists because its opposite is a bypass.
 *
 * 1. **A hook is a pinned Resource, never ambient global code.** It is loaded by the same
 *    digest-pinned, vm-sandboxed loader that `function` nodes use. Ambient plugins would let a
 *    hook edit change what an in-flight run does, which is the pinning rule broken from the
 *    outside.
 * 2. **Filters may narrow, never widen.** `preTool` can block a call or rewrite its arguments;
 *    it cannot add a capability or lower a posture. Invariant 5's asymmetry applies to
 *    extensions or it is not an invariant — an extension that can lower oversight IS the
 *    bypass oversight exists to prevent.
 * 3. **A filter that throws fails its Task; an observer that throws is skipped.** Observers
 *    cannot change anything, so their failure is not the run's business. A filter's IS: it was
 *    asked for a decision and did not give one, and continuing would mean inventing an answer
 *    on its behalf.
 *
 * This module is deliberately journal-free. It reports WHAT changed and the caller appends —
 * `Engine` owns `#serialize` and the ordering of appends, and a second writer into the journal
 * is the shape invariant 2 exists to prevent.
 */

import { CODES, err } from "../errors.ts";
import type { TaskId } from "../ids.ts";

/**
 * The points a graph may name, and the ONLY ones.
 *
 * `GraphSpec.hooks` is a `Record<string, …>`, so before this list existed
 * `hooks: {preTolo: […]}` compiled clean and never fired — declared, pinned, resolved, and
 * silent. That is the "looks configured, is not" failure this repo refuses elsewhere by
 * making `mode: quorum` a compile error rather than a silent downgrade.
 */
export const HOOK_POINTS = [
  "prePlan",
  "preNode",
  "preModel",
  "postModel",
  "preTool",
  "postTool",
  "onError",
  "onGate",
  "onComplete",
] as const;

export type HookPoint = (typeof HOOK_POINTS)[number];

/**
 * The points the engine actually DISPATCHES.
 *
 * `HOOK_POINTS` is the design's full list; this is what is built. The compiler refuses a graph
 * naming a point outside this set, because "declared, pinned, and never invoked" is the exact
 * defect the bus was written to close — narrowing it from any string to one of nine did not
 * close it, it just made the silence better spelled. Wiring a point means adding it here, and
 * `test/run/hooks.test.ts` asserts the two lists explain their difference.
 */
export const WIRED_POINTS: ReadonlySet<HookPoint> = new Set<HookPoint>([
  "preModel",
  "postModel",
  "preTool",
  "postTool",
  "onError",
  "onGate",
  "onComplete",
]);

/**
 * Points that cannot change anything.
 *
 * Kept as data rather than as a convention, because "is this one allowed to mutate?" is asked
 * at every call site and a convention answered differently in one of them is exactly how an
 * observer becomes a filter nobody reviewed.
 */
export const OBSERVER_POINTS: ReadonlySet<HookPoint> = new Set<HookPoint>(["onComplete"]);

export function isHookPoint(s: string): s is HookPoint {
  return (HOOK_POINTS as readonly string[]).includes(s);
}

/** What a hook body is handed alongside its input. No clock and no randomness: see invariant 4. */
export interface HookContext {
  readonly point: HookPoint;
  readonly runId: string;
  readonly taskId?: TaskId;
  readonly signal: AbortSignal;
}

/** `preTool`. `args` absent means "unchanged"; `block` is terminal. */
export interface ToolDecision {
  readonly block?: boolean;
  readonly reason?: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

/** `preNode`. `skip` is terminal. */
export interface NodeDecision {
  readonly skip?: boolean;
  readonly reason?: string;
}

/**
 * `onError`. What a hook may do to a retry the POLICY already allowed.
 *
 * Both fields narrow and neither widens, which is rule 2 applied to failure handling:
 * `retry: false` suppresses a retry the policy would have taken (a circuit breaker, a cost
 * guard); `retry: true` is IGNORED, because forcing one would let an extension re-run a
 * non-idempotent tool that already reached its sandbox — the case `#retryDecision` refuses on
 * purpose and the most dangerous thing a hook could ask for. `afterMs` may only LENGTHEN the
 * backoff; a shorter one is clamped to the policy's.
 *
 * The hook is not consulted at all when the policy already said no, so it cannot resurrect a
 * retry by any route.
 */
export interface ErrorDecision {
  readonly retry?: boolean;
  readonly afterMs?: number;
}

/** The merge for `onError`: suppression composes, resurrection does not, backoff only grows. */
export function narrowErrorDecision(prev: ErrorDecision, raw: unknown): ErrorDecision {
  if (raw === null || typeof raw !== "object") return prev;
  const r = raw as Record<string, unknown>;
  const retry = prev.retry === false || r["retry"] === false ? false : prev.retry;
  const proposed = typeof r["afterMs"] === "number" && Number.isFinite(r["afterMs"]) ? r["afterMs"] : undefined;
  const afterMs = proposed === undefined ? prev.afterMs : Math.max(prev.afterMs ?? 0, proposed);
  return { ...(retry === undefined ? {} : { retry }), ...(afterMs === undefined ? {} : { afterMs }) };
}

/**
 * The THREE fields of a gate a hook may touch, and the reason it is only three.
 *
 * A `GateRequest` carries authority: `approvers` says who may decide, `defaultAction` is a
 * pre-authorised decision, `onTimeout` says what happens when nobody answers. An extension that
 * could add an approver would be granting authority, which is invariant 5's asymmetry inverted —
 * so those fields are not reachable from here at all, rather than validated and refused.
 *
 * What is left is genuinely useful and cannot grant anything:
 *   - `payload` is what the human SEES. Enriching it is pure information gain, and
 *     `contentDigest` is computed after this runs, so the digest pins what they actually saw.
 *   - `excludedApprovers` only ever gains members: barring one more subject is a narrowing, and
 *     separation of duties is enforced against this list.
 *   - `allowEdit` only ever loses them: shrinking what an `edit` decision may write is a
 *     narrowing, and an empty result is a gate whose edits touch nothing.
 */
export interface GateView {
  readonly payload: unknown;
  readonly excludedApprovers?: readonly string[];
  readonly allowEdit?: readonly string[];
}

/** Union the exclusions, intersect the editable channels, take the payload as given. */
export function narrowGateRequest(prev: GateView, raw: unknown): GateView {
  if (raw === null || typeof raw !== "object") return prev;
  const r = raw as Record<string, unknown>;
  const strs = (v: unknown): readonly string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

  const added = strs(r["excludedApprovers"]);
  const excluded = added === undefined ? prev.excludedApprovers : [...new Set([...(prev.excludedApprovers ?? []), ...added])];
  const kept = strs(r["allowEdit"]);
  const allowEdit = kept === undefined ? prev.allowEdit : (prev.allowEdit ?? []).filter((c) => kept.includes(c));

  return {
    payload: "payload" in r ? r["payload"] : prev.payload,
    ...(excluded === undefined ? {} : { excludedApprovers: excluded }),
    ...(allowEdit === undefined ? {} : { allowEdit }),
  };
}

export type HookBody = (input: unknown, ctx: HookContext) => Promise<unknown> | unknown;

/** One resolved hook: the ref it came from (for the journal) and its compiled body. */
export interface RegisteredHook {
  readonly ref: string;
  readonly body: HookBody;
}

/**
 * What a dispatch produced: the threaded value, and the refs that CHANGED it.
 *
 * `changedBy` drives the journal, and it holds refs rather than a count on purpose — an
 * operator reading `hook.applied` needs to know WHICH extension rewrote the arguments of a
 * tool call, not that one of them did.
 */
export interface HookOutcome<T> {
  readonly value: T;
  readonly changedBy: readonly string[];
  /** Set when a filter returned a terminal decision — the chain stopped here. */
  readonly stoppedBy?: string;
}

/** Deep-ish equality good enough to answer "did this hook change the value?" for JSON data. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // A cyclic or non-serialisable value: treat it as changed rather than claim it is not.
    // Over-reporting a change costs a journal row; under-reporting hides a rewrite.
    return false;
  }
}

/**
 * Run a filter chain, threading the value through every hook in registration order.
 *
 * `terminal` decides when a returned value settles the question and the rest of the chain is
 * skipped — a blocked tool call must not be un-blocked by a later hook, which is rule 2 again:
 * narrowing composes, widening does not.
 */
export async function runFilters<T>(
  hooks: readonly RegisteredHook[],
  initial: T,
  ctx: HookContext,
  terminal: (v: T) => boolean = () => false,
  /**
   * How a hook's raw return is folded into the threaded value. The default REPLACES, which is
   * right for a value-threading point like `preModel`. A decision point supplies a merge that
   * keeps the narrowing monotonic — `narrowToolDecision` is the one that makes "once blocked,
   * stays blocked" true no matter what a later hook returns.
   */
  merge: (prev: T, raw: unknown) => T = (_prev, raw) => raw as T,
): Promise<HookOutcome<T>> {
  let value = initial;
  const changedBy: string[] = [];

  for (const h of hooks) {
    if (ctx.signal.aborted) break;
    let next: unknown;
    try {
      next = await h.body(value, ctx);
    } catch (cause) {
      // RULE 3. A filter was asked for a decision and did not give one. Continuing would mean
      // inventing an answer on its behalf, and the answers this bus carries are "may this tool
      // run" and "with what arguments".
      throw err.internal(
        CODES.E_INTERNAL,
        `hook "${h.ref}" failed at ${ctx.point}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { details: { ref: h.ref, point: ctx.point } },
      );
    }
    // `undefined` means "no opinion" — the common case for a hook that only inspects.
    if (next === undefined) continue;
    const merged = merge(value, next);
    if (!same(merged, value)) changedBy.push(h.ref);
    value = merged;
    if (terminal(value)) return { value, changedBy, stoppedBy: h.ref };
  }
  return { value, changedBy };
}

/**
 * Run observers. Nothing they return is read, and one that throws is skipped.
 *
 * Returns the refs that threw, so the caller can surface them without failing the run — a
 * silently swallowed extension failure is indistinguishable from an extension that did nothing.
 */
export async function runObservers(
  hooks: readonly RegisteredHook[],
  input: unknown,
  ctx: HookContext,
): Promise<readonly string[]> {
  const failed: string[] = [];
  for (const h of hooks) {
    if (ctx.signal.aborted) break;
    try {
      await h.body(input, ctx);
    } catch {
      failed.push(h.ref);
    }
  }
  return failed;
}

/**
 * What a `preTool` hook SEES and what the chain threads.
 *
 * It carries the tool name and the CURRENT arguments, because a hook that cannot see the argv
 * cannot do argument-level policy — which is the entire reason this point exists. The first
 * draft threaded a bare `ToolDecision` and a guard hook was blind: it could block, but only on
 * faith. `args` is the running value, so the second hook in a chain sees the first's rewrite.
 */
export interface PreToolState {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly block?: boolean;
  readonly reason?: string;
}

/**
 * THE NARROWING GUARD, and the reason this is a function rather than a comment.
 *
 * A hook may block a call or rewrite its arguments. It may not hand back anything that GRANTS:
 * no capability list, no posture, no tool substitution. This reads only `block`, `reason` and
 * `args` and drops the rest, so a hook returning `{block:false, posture:"out"}` is not refused —
 * it is IGNORED, which is the safer failure when the alternative is trusting a field nobody
 * validated. `block` is monotonic: once true it stays true, whatever a later hook says.
 */
export function narrowToolDecision(prev: PreToolState, raw: unknown): PreToolState {
  if (raw === null || typeof raw !== "object") return prev;
  const r = raw as Record<string, unknown>;
  const block = r["block"] === true || prev.block === true;
  const args =
    r["args"] !== null && typeof r["args"] === "object" && !Array.isArray(r["args"])
      ? (r["args"] as Record<string, unknown>)
      : prev.args;
  const reason = typeof r["reason"] === "string" ? r["reason"] : prev.reason;
  return {
    tool: prev.tool,
    args,
    ...(block ? { block: true } : {}),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Ref → body, with the same shadow-stack discipline `FunctionRegistry` has.
 *
 * A plain `Map` cannot honour `Disposable`'s contract — disposing a registration must restore
 * what it shadowed, and `delete(ref)` matches a KEY rather than the body that was registered,
 * so a stale handle disposed after a re-registration deletes the NEW body. That bug is already
 * written down one file over; this registry does not get to rediscover it.
 */
export class HookRegistry {
  readonly #stacks = new Map<string, HookBody[]>();

  register(ref: string, body: HookBody): { dispose: () => void } {
    const stack = this.#stacks.get(ref) ?? [];
    stack.push(body);
    this.#stacks.set(ref, stack);
    let disposed = false;
    return {
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        const s = this.#stacks.get(ref);
        if (s === undefined) return;
        const i = s.lastIndexOf(body);
        if (i >= 0) s.splice(i, 1);
        if (s.length === 0) this.#stacks.delete(ref);
      },
    };
  }

  get(ref: string): HookBody | undefined {
    const s = this.#stacks.get(ref);
    return s === undefined || s.length === 0 ? undefined : s[s.length - 1];
  }

  /**
   * Resolve the refs a graph declared at one point, in DECLARATION ORDER.
   *
   * A ref with no registered body is SKIPPED rather than throwing: the compiler already
   * refused unknown point names, and a deployment that simply does not install an optional
   * extension is not a broken graph. What it is not allowed to be is silent — the caller gets
   * the resolved list and can compare lengths.
   */
  resolve(refs: readonly string[]): readonly RegisteredHook[] {
    const out: RegisteredHook[] = [];
    for (const ref of refs) {
      const body = this.get(ref);
      if (body !== undefined) out.push({ ref, body });
    }
    return out;
  }
}
