/**
 * The closed vocabulary of durable facts.
 *
 * Every state change in Loom is one of these, appended to a per-Run append-only log.
 * `runs`, `tasks`, `human_gates`, and `checkpoints` are folds over this log, not
 * independent truths — so a crash between "append" and "update read model" is
 * self-healing on restart.
 *
 * The payload map is exhaustive on purpose. A new kind of durable fact requires a
 * new entry here, which is a reviewable act; a loosely-typed `payload: unknown`
 * would let subsystems invent private vocabularies and the log would stop being a
 * contract.
 *
 * See design/loom/01-INTERFACES.md D3.10.
 */

import type { LoomError } from "../errors.ts";
import type { NodeId, RunId, Seq, TaskId, GateId, CheckpointId } from "../ids.ts";
import type { Classification, Posture, UsageRecord } from "../vocab.ts";

export type { Classification, Posture, UsageRecord };

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** Who caused a fact. A single ordered read reconstructs "who did what, when, why". */
export type Actor =
  | { readonly kind: "system"; readonly component: string; readonly rule?: string }
  | { readonly kind: "agent"; readonly profile: string; readonly taskId: TaskId; readonly model: string }
  | {
      readonly kind: "human";
      readonly subject: string;
      readonly via: "console" | "slack" | "feishu" | "teams" | "email" | "api" | "cli";
      readonly onBehalfOf?: string;
      readonly mfa?: boolean;
    }
  | { readonly kind: "evolution"; readonly engineVersion: string; readonly candidate: string };

export const SYSTEM_ACTOR = (component: string): Actor => ({ kind: "system", component });

export type TaskStatus = "succeeded" | "failed" | "skipped" | "cancelled";

/** Recorded outcome of an effect. `unknown` is the honest third case (D6.1). */
export type EffectOutcome = "completed" | "failed" | "unknown";

/** A LoomError flattened for the log: no stack, no cause chain. */
export interface ErrorRecord {
  readonly class: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

export function errorRecord(e: LoomError): ErrorRecord {
  const out: { class: string; code: string; message: string; retryable: boolean; details?: unknown } = {
    class: e.class,
    code: e.code,
    message: e.message,
    retryable: e.retryable,
  };
  if (e.details !== undefined) out.details = e.details;
  return out;
}

// ---------------------------------------------------------------------------
// The payload map — this IS the event type list
// ---------------------------------------------------------------------------

export interface EventPayloads {
  // ── run lifecycle ────────────────────────────────────────────────────────
  "run.submitted": {
    readonly workflow: string;
    readonly graphHash: string;
    readonly inputs: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly configDigest: string;
  };
  "run.compiled": {
    readonly graphHash: string;
    readonly nodes: number;
    readonly edges: number;
    readonly resolutionManifest: readonly { ref: string; digest: string }[];
  };
  "run.started": { readonly posture: Posture };
  "run.suspended": { readonly reason: "gate" | "operator" | "budget" | "backoff" };
  "run.resumed": { readonly by: "gate" | "operator" | "timer" };
  "run.completed": { readonly outputs: Readonly<Record<string, unknown>>; readonly usage: UsageRecord };
  "run.failed": { readonly error: ErrorRecord };
  "run.cancelled": {
    readonly clean: boolean;
    /** Effects that started but whose outcome was never recorded. Never claim these did not happen. */
    readonly unknownEffects: readonly string[];
    readonly forced: boolean;
  };

  // ── task lifecycle ───────────────────────────────────────────────────────
  "task.ready": {
    readonly nodeId: NodeId;
    readonly branchPath: string;
    readonly edgesIn: readonly string[];
    /**
     * The per-branch item bound by a `fanout` edge's `as`. Travels with the Task
     * that needs it rather than as a separate event, because there is exactly one
     * Task per branch anyway — and recording it makes the value durable instead of
     * something replay has to re-derive from a channel that may have moved on.
     */
    readonly binding?: { readonly channel: string; readonly value: unknown };
  };
  "task.leased": { readonly workerId: string; readonly attempt: number; readonly fencingToken: number };
  "task.started": { readonly nodeType: string; readonly attempt: number };
  "task.progress": { readonly chunk: string };
  "task.committed": {
    readonly status: TaskStatus;
    readonly writes: Readonly<Record<string, unknown>>;
    readonly take: readonly string[];
    readonly usage: UsageRecord;
    readonly attempt: number;
  };
  "task.failed": { readonly error: ErrorRecord; readonly attempt: number };
  "task.skipped": { readonly reason: string };
  "task.cancelled": { readonly clean: boolean; readonly reason: string };
  "task.retry_scheduled": { readonly attempt: number; readonly afterMs: number; readonly code: string };
  /**
   * A hard-to-undo action is about to run under posture `on`, and the executor is
   * holding for `windowMs` so a supervisor can intervene.
   *
   * Without this event, "the supervisor may interrupt" is a promise the system cannot
   * keep: by the time a human sees the action in a stream, it has already happened.
   */
  "action.pending": {
    readonly nodeId: NodeId;
    readonly irreversibility: string;
    readonly windowMs: number;
    readonly toolName?: string;
  };

  // ── state ────────────────────────────────────────────────────────────────
  /**
   * THE ONLY event that changes channel state.
   *
   * `task.committed.writes` is a *proposal* carrying the branch that made it; this
   * carries the *result* after the reducer folded every contribution in branch order.
   * Separating them is what lets a fan-out's writes wait for its join instead of
   * being applied in arrival order — and it keeps the fold trivially correct, since
   * a projection only ever has to copy `values` in.
   */
  "state.reduced": {
    readonly channels: readonly string[];
    readonly values: Readonly<Record<string, unknown>>;
    readonly branchCount: number;
    readonly skipped: number;
    readonly degraded: boolean;
    readonly stateHashBefore: string;
    readonly stateHashAfter: string;
  };
  "channel.written": { readonly channel: string; readonly reducer: string; readonly valueDigest: string };

  // ── effects ──────────────────────────────────────────────────────────────
  "effect.started": { readonly key: string; readonly kind: "model" | "tool" | "clock" | "random" | "mailbox"; readonly attempt: number };
  "effect.completed": { readonly key: string; readonly result: unknown; readonly resultDigest: string };
  "effect.failed": { readonly key: string; readonly error: ErrorRecord };
  "model.called": {
    readonly key: string;
    readonly provider: string;
    readonly model: string;
    readonly finishReason: string;
    readonly usage: UsageRecord;
  };
  "tool.called": {
    readonly key: string;
    readonly name: string;
    readonly version: string;
    readonly irreversibility: string;
    readonly idempotent: boolean;
    readonly ok: boolean;
    readonly ms: number;
  };

  // ── oversight ────────────────────────────────────────────────────────────
  "gate.raised": { readonly gateId: GateId; readonly nodeId: NodeId; readonly policyRef: string; readonly contentDigest: string };
  "gate.delivered": { readonly gateId: GateId; readonly channel: string; readonly receipt: string };
  "gate.decided": {
    readonly gateId: GateId;
    readonly decision: "approve" | "reject" | "edit" | "redirect";
    readonly writes?: Readonly<Record<string, unknown>>;
    readonly take?: readonly string[];
    readonly justification?: string;
    readonly latencyMs: number;
  };
  "gate.timeout": { readonly gateId: GateId; readonly action: "escalate" | "default_action" | "fail" };
  "gate.escalated": { readonly gateId: GateId; readonly tier: number; readonly to: string };
  "gate.cancelled": { readonly gateId: GateId; readonly reason: string };

  // ── policy ───────────────────────────────────────────────────────────────
  "policy.decided": {
    readonly effect: "allow" | "gate" | "deny";
    readonly posture: Posture;
    readonly irreversibility: string;
    /** The exact rules that fired. An audit that cannot say WHY is not an audit. */
    readonly reasons: readonly string[];
    readonly capability?: string;
  };
  "policy.escalated": { readonly rule: string; readonly from: Posture; readonly to: Posture; readonly scope: string };
  "policy.deescalated": { readonly from: Posture; readonly to: Posture; readonly scope: string; readonly justification: string };

  // ── budget ───────────────────────────────────────────────────────────────
  "budget.reserved": { readonly scope: string; readonly amountUsd: number; readonly remainingUsd: number; readonly warn: boolean };
  "budget.settled": { readonly scope: string; readonly reservedUsd: number; readonly actualUsd: number };
  "budget.exhausted": { readonly scope: string; readonly limitUsd: number; readonly action: string };

  // ── graph + checkpoints ──────────────────────────────────────────────────
  "graph.mutated": {
    readonly parentHash: string;
    readonly newHash: string;
    readonly addedNodes: readonly NodeId[];
    readonly addedEdges: readonly string[];
    readonly proposedBy: TaskId;
    readonly budgetConsumed: number;
  };
  "checkpoint.created": { readonly checkpointId: CheckpointId; readonly atSeq: Seq; readonly kind: string; readonly openTasks: number };
  /**
   * A rewind is APPEND-ONLY: this marker hides events in `(atSeq, thisSeq)` from the
   * fold rather than deleting them. History is never edited, so the rewind itself is
   * auditable and a trace still shows what was undone.
   */
  "checkpoint.restored": {
    readonly checkpointId: CheckpointId;
    readonly mode: "rewind" | "fork";
    readonly atSeq: Seq;
    readonly reason: string;
    readonly newRunId?: RunId;
  };

  // ── operator + config ────────────────────────────────────────────────────
  "operator.command": { readonly kind: string; readonly args: Readonly<Record<string, unknown>> };
  "config.reloaded": { readonly before: string; readonly after: string };
  "hook.applied": { readonly ref: string; readonly point: string; readonly changed: boolean };
}

export type EventType = keyof EventPayloads;

/** Runtime list, kept in sync with `EventPayloads` by a test. */
export const EVENT_TYPES = [
  "run.submitted", "run.compiled", "run.started", "run.suspended", "run.resumed",
  "run.completed", "run.failed", "run.cancelled",
  "task.ready", "task.leased", "task.started", "task.progress", "task.committed",
  "task.failed", "task.skipped", "task.cancelled", "task.retry_scheduled", "action.pending",
  "state.reduced", "channel.written",
  "effect.started", "effect.completed", "effect.failed", "model.called", "tool.called",
  "gate.raised", "gate.delivered", "gate.decided", "gate.timeout", "gate.escalated", "gate.cancelled",
  "policy.decided", "policy.escalated", "policy.deescalated",
  "budget.reserved", "budget.settled", "budget.exhausted",
  "graph.mutated", "checkpoint.created", "checkpoint.restored",
  "operator.command", "config.reloaded", "hook.applied",
] as const satisfies readonly EventType[];

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

/** What a caller hands to `append`: no seq (assigned by the store), no runId (implied). */
export type NewEvent<T extends EventType = EventType> = {
  readonly [K in T]: {
    readonly type: K;
    readonly payload: EventPayloads[K];
    readonly actor: Actor;
    readonly taskId?: TaskId;
    readonly classification?: Classification;
    /** Recorded wall clock. Injected, never read from Date.now() inside a node body. */
    readonly ts?: number;
  };
}[T];

/** What comes back out: fully positioned and attributed. */
export type JournalEvent<T extends EventType = EventType> = {
  readonly [K in T]: {
    readonly runId: RunId;
    readonly seq: Seq;
    readonly ts: number;
    readonly type: K;
    readonly payload: EventPayloads[K];
    readonly actor: Actor;
    readonly taskId?: TaskId;
    readonly classification: Classification;
  };
}[T];

/** Narrow a heterogeneous event to one type — the fold's main tool. */
export function isEvent<K extends EventType>(e: JournalEvent, type: K): e is Extract<JournalEvent, { type: K }> {
  return e.type === type;
}
