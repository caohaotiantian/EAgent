/**
 * The fold: journal → run state.
 *
 * This is the function that makes "the journal is the only authoritative durable
 * state" true rather than aspirational. `runs`, `tasks`, `human_gates`, and channel
 * values are all produced here, from events, in order — so a crash between an append
 * and a read-model update is self-healing, and a projection can always be rebuilt.
 *
 * It is deliberately PURE and synchronous over an event sequence. Anything that
 * needs I/O belongs in the executor, not here; anything that cannot be derived from
 * the journal is not durable state.
 *
 * ── Branch-scoped channels ──────────────────────────────────────────────────
 * A `fanout` edge's `as` channel holds one value per branch. Rather than a second
 * state container, bindings are stored keyed by branch path and resolved by walking
 * a Task's path prefixes (deepest wins). That way a Task at `root/e1[7]/e5[2]`
 * inherits its ancestors' bindings without anything copying them.
 */

import { canonicalize } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import {
  ROOT_BRANCH,
  compareBranch,
  decodeBranch,
  encodeBranch,
  parseTaskId,
  taskId as makeTaskId,
  type BranchCoordinate,
  type EdgeId,
  type GateId,
  type NodeId,
  type RunId,
  type Seq,
  type TaskId,
} from "../ids.ts";
import { isEvent, type ErrorRecord, type JournalEvent } from "../journal/events.ts";
import {
  channelValue,
  makeStateView,
  type ChannelSpec,
  type ChannelState,
  type StateView,
} from "../state/channels.ts";
import { ZERO_USAGE, addUsage, type Posture, type UsageRecord } from "../vocab.ts";
import type { GraphSpec } from "../graph/spec.ts";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_gate"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskState =
  | "pending"
  | "ready"
  | "leased"
  | "awaiting_gate"
  | "retrying"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface TaskRecord {
  readonly taskId: TaskId;
  readonly nodeId: NodeId;
  readonly branch: BranchCoordinate;
  readonly iteration: number;
  readonly state: TaskState;
  readonly attempt: number;
  readonly edgesIn: readonly EdgeId[];
  /** Edges the Task selected on commit. Empty means "no successor". */
  readonly take: readonly EdgeId[];
  /**
   * What the Task PROPOSED to write. Not state: a Task inside a fan-out holds its
   * proposal here until its join folds every sibling in branch order.
   */
  readonly writes: Readonly<Record<string, unknown>>;
  readonly error?: ErrorRecord;
  readonly retryAfter?: number;
  /**
   * Who holds this Task, and since when.
   *
   * The journal has always recorded it; the read model discarded it, because with one
   * worker there is nothing to ask. A second worker's first question is "is anyone on
   * this?" — so folding it in is what makes the scheduler seam usable at all.
   */
  readonly lease?: { readonly workerId: string; readonly at: number; readonly fencingToken: number };
  readonly usage: UsageRecord;
}

export interface GateRecord {
  readonly gateId: GateId;
  readonly taskId: TaskId;
  readonly nodeId: NodeId;
  readonly policyRef: string;
  readonly contentDigest: string;
  readonly raisedAtSeq: Seq;
  readonly raisedAtTs: number;
  readonly state: "open" | "decided" | "expired" | "cancelled";
  readonly decision?: "approve" | "reject" | "edit" | "redirect";
  /** `edit` only: the channels the human wrote. */
  readonly writes?: Readonly<Record<string, unknown>>;
  /** `redirect` only: the edges the human selected. */
  readonly take?: readonly string[];
  readonly justification?: string;
}

export interface RunProjection {
  readonly runId: RunId;
  readonly graphHash: string;
  readonly status: RunStatus;
  readonly seq: Seq;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly posture: Posture;

  readonly channels: ChannelState;
  /** branch path → the channels bound at exactly that branch. */
  readonly bindings: Readonly<Record<string, Readonly<Record<string, unknown>>>>;

  readonly tasks: Readonly<Record<TaskId, TaskRecord>>;
  readonly gates: Readonly<Record<GateId, GateRecord>>;

  readonly usage: UsageRecord;
  /** Reserved-but-not-yet-settled spend. Non-zero mid-flight, zero at rest. */
  readonly reservedUsd: number;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly error?: ErrorRecord;
  /** Effects that started with no terminal record. Never claim these did not happen. */
  readonly unknownEffects: readonly string[];
  /**
   * Every effect key that ever STARTED, whatever its outcome.
   *
   * Distinct from `unknownEffects` on purpose: "did this reach the world?" and "do we
   * know what the world did?" are different questions, and the non-idempotent retry
   * refusal needs the first one.
   */
  readonly startedEffects: readonly string[];
  /**
   * A budget breach is a RUN-level condition, not a branch-level one — otherwise a
   * join with `onBranchError: skip` would silently absorb it and the run would carry
   * on spending. Durable, so it survives a restart.
   */
  readonly budgetExhausted: boolean;
  /**
   * `edgeId@parentBranch` → the fan-out's PLANNED width.
   *
   * A join reads this rather than counting sibling Tasks, which is what makes lazy
   * materialisation safe: with branches created in bounded waves, "how many siblings
   * exist" is a count of what has started, not of what will.
   */
  readonly fanouts: Readonly<Record<string, { readonly nodeId: NodeId; readonly width: number }>>;
  readonly suspendedReason?: "gate" | "operator" | "budget" | "backoff";
}

interface MutableProjection {
  runId: RunId;
  graphHash: string;
  status: RunStatus;
  seq: Seq;
  startedAt: number;
  endedAt?: number;
  posture: Posture;
  channels: Record<string, unknown>;
  bindings: Record<string, Record<string, unknown>>;
  tasks: Record<TaskId, TaskRecord>;
  gates: Record<GateId, GateRecord>;
  usage: UsageRecord;
  reservedUsd: number;
  outputs: Record<string, unknown>;
  error?: ErrorRecord;
  openEffects: Set<string>;
  everStarted: Set<string>;
  budgetExhausted: boolean;
  fanouts: Record<string, { nodeId: NodeId; width: number }>;
  suspendedReason?: "gate" | "operator" | "budget" | "backoff";
}

/**
 * Fold an ordered event sequence into run state.
 *
 * Tolerant by design: an event referring to a Task it has never seen creates a
 * minimal record rather than throwing. A projection that crashes on a slightly
 * unexpected log is a projection that cannot be used to diagnose the incident that
 * produced the log.
 */
/**
 * An INCREMENTAL fold.
 *
 * The naive `foldRun` re-reads the whole journal, which the executor called once per
 * task — quadratic in a run's own history, and the dominant cost of a 500-branch
 * fan-out. Holding the mutable state and applying only the new tail makes it linear.
 *
 * A REWIND breaks incrementality: `checkpoint.restored{mode:"rewind"}` suppresses events
 * that were already folded, so what earlier events mean changes retroactively. The
 * folder detects that and asks the caller to start over, which is correct and rare —
 * paying a full re-fold on a rewind is not a cost worth optimising.
 */
export class RunFolder {
  #p: MutableProjection | undefined;
  #lastSeq = 0;
  #stale = false;

  /** The highest seq folded so far. Read the journal from `lastSeq + 1`. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** True once a rewind marker arrived: discard this folder and fold from seq 1. */
  get stale(): boolean {
    return this.#stale;
  }

  push(events: Iterable<JournalEvent>): void {
    for (const e of events) {
      if (e.seq <= this.#lastSeq) continue;
      if (isEvent(e, "checkpoint.restored") && e.payload.mode === "rewind") {
        this.#stale = true;
        return;
      }
      this.#p ??= emptyProjection(e);
      this.#p.seq = e.seq;
      this.#lastSeq = e.seq;
      apply(this.#p, e);
    }
  }

  /**
   * A snapshot.
   *
   * The top-level maps are COPIED. A caller that holds a projection across a commit —
   * the join fold does exactly that — must not watch its own inputs change underneath
   * it. Nested values are shared, as they already were: they come from event payloads,
   * which are never mutated.
   */
  projection(): RunProjection | undefined {
    return this.#p === undefined ? undefined : freeze(this.#p);
  }
}

function emptyProjection(e: JournalEvent): MutableProjection {
  return {
    runId: e.runId,
    graphHash: "",
    status: "queued",
    seq: 0,
    startedAt: e.ts,
    posture: "out",
    channels: {},
    bindings: {},
    tasks: {},
    gates: {},
    usage: { ...ZERO_USAGE },
    reservedUsd: 0,
    outputs: {},
    openEffects: new Set(),
    everStarted: new Set(),
    budgetExhausted: false,
    fanouts: {},
  };
}

function freeze(p: MutableProjection): RunProjection {
  return {
    runId: p.runId,
    graphHash: p.graphHash,
    status: p.status,
    seq: p.seq,
    startedAt: p.startedAt,
    posture: p.posture,
    channels: { ...p.channels },
    bindings: { ...p.bindings },
    tasks: { ...p.tasks },
    gates: { ...p.gates },
    usage: { ...p.usage },
    reservedUsd: p.reservedUsd,
    outputs: { ...p.outputs },
    unknownEffects: [...p.openEffects].sort(),
    startedEffects: [...p.everStarted].sort(),
    budgetExhausted: p.budgetExhausted,
    fanouts: { ...p.fanouts },
    ...(p.endedAt === undefined ? {} : { endedAt: p.endedAt }),
    ...(p.error === undefined ? {} : { error: p.error }),
    ...(p.suspendedReason === undefined ? {} : { suspendedReason: p.suspendedReason }),
  };
}

export function foldRun(events: Iterable<JournalEvent>): RunProjection | undefined {
  let p: MutableProjection | undefined;

  // A rewind never edits history — it appends a `checkpoint.restored` marker. The
  // fold honours it by SUPPRESSING the events between the checkpoint and the marker,
  // so the journal stays append-only and the rewind is itself auditable.
  const all = [...events];
  const suppressed = suppressedRanges(all);

  for (const e of all) {
    if (suppressed.some(([from, to]) => e.seq > from && e.seq < to)) continue;
    p ??= emptyProjection(e);
    p.seq = e.seq;
    apply(p, e);
  }

  return p === undefined ? undefined : freeze(p);
}

/** `(checkpointSeq, markerSeq)` exclusive ranges hidden by a rewind. */
function suppressedRanges(events: readonly JournalEvent[]): [number, number][] {
  const out: [number, number][] = [];
  for (const e of events) {
    if (!isEvent(e, "checkpoint.restored") || e.payload.mode !== "rewind") continue;
    const at = (e.payload as { atSeq?: number }).atSeq;
    if (typeof at === "number") out.push([at, e.seq]);
  }
  return out;
}

function upsertTask(p: MutableProjection, id: TaskId, patch: Partial<TaskRecord>): void {
  const existing = p.tasks[id];
  if (existing !== undefined) {
    p.tasks[id] = { ...existing, ...patch };
    return;
  }
  const parsed = parseTaskId(id);
  p.tasks[id] = {
    taskId: id,
    nodeId: parsed.nodeId,
    branch: parsed.branch,
    iteration: parsed.iteration,
    state: "pending",
    attempt: 0,
    edgesIn: [],
    take: [],
    writes: {},
    usage: { ...ZERO_USAGE },
    ...patch,
  };
}

function apply(p: MutableProjection, e: JournalEvent): void {
  // ── run lifecycle ─────────────────────────────────────────────────────────
  if (isEvent(e, "run.submitted")) {
    p.graphHash = e.payload.graphHash;
    p.channels = { ...p.channels, ...e.payload.inputs };
    return;
  }
  if (isEvent(e, "run.compiled")) {
    p.graphHash = e.payload.graphHash;
    return;
  }
  if (isEvent(e, "run.started")) {
    p.status = "running";
    p.posture = e.payload.posture;
    p.startedAt = e.ts;
    return;
  }
  if (isEvent(e, "run.suspended")) {
    p.status = e.payload.reason === "gate" ? "awaiting_gate" : "interrupted";
    p.suspendedReason = e.payload.reason;
    return;
  }
  if (isEvent(e, "run.resumed")) {
    p.status = "running";
    delete p.suspendedReason;
    return;
  }
  if (isEvent(e, "run.completed")) {
    p.status = "succeeded";
    p.outputs = { ...e.payload.outputs };
    p.usage = e.payload.usage;
    p.endedAt = e.ts;
    return;
  }
  if (isEvent(e, "run.failed")) {
    p.status = "failed";
    p.error = e.payload.error;
    p.endedAt = e.ts;
    return;
  }
  if (isEvent(e, "run.cancelled")) {
    p.status = "cancelled";
    p.endedAt = e.ts;
    // A cancel that raced an irreversible effect leaves the outcome unknown, and the
    // projection must keep saying so rather than presenting a clean stop.
    for (const key of e.payload.unknownEffects) p.openEffects.add(key);
    return;
  }

  // ── tasks ─────────────────────────────────────────────────────────────────
  if (isEvent(e, "task.ready")) {
    const branch = decodeBranch(e.payload.branchPath);
    const id = e.taskId ?? makeTaskId(e.payload.nodeId, branch, 0);
    upsertTask(p, id, { state: "ready", edgesIn: e.payload.edgesIn as readonly EdgeId[] });
    const binding = e.payload.binding;
    if (binding !== undefined) {
      const at = p.bindings[e.payload.branchPath] ?? {};
      p.bindings[e.payload.branchPath] = { ...at, [binding.channel]: binding.value };
    }
    return;
  }
  if (isEvent(e, "task.leased") && e.taskId) {
    upsertTask(p, e.taskId, {
      state: "leased",
      attempt: e.payload.attempt,
      lease: { workerId: e.payload.workerId, at: e.ts, fencingToken: e.payload.fencingToken },
    });
    return;
  }
  if (isEvent(e, "task.committed") && e.taskId) {
    // `writes` is a proposal, not state: it is folded by `state.reduced`, which may
    // be this Task's own immediate reduce or a later join's branch-ordered fold.
    upsertTask(p, e.taskId, {
      state: e.payload.status === "succeeded" ? "succeeded" : (e.payload.status as TaskState),
      take: e.payload.take as readonly EdgeId[],
      writes: e.payload.writes,
      attempt: e.payload.attempt,
      usage: e.payload.usage,
    });
    p.usage = addUsage(p.usage, e.payload.usage);
    return;
  }
  if (isEvent(e, "task.failed") && e.taskId) {
    upsertTask(p, e.taskId, { state: "failed", error: e.payload.error, attempt: e.payload.attempt });
    return;
  }
  if (isEvent(e, "task.skipped") && e.taskId) {
    upsertTask(p, e.taskId, { state: "skipped" });
    return;
  }
  if (isEvent(e, "task.cancelled") && e.taskId) {
    upsertTask(p, e.taskId, { state: "cancelled" });
    return;
  }
  if (isEvent(e, "task.retry_scheduled") && e.taskId) {
    upsertTask(p, e.taskId, { state: "retrying", attempt: e.payload.attempt, retryAfter: e.ts + e.payload.afterMs });
    return;
  }

  // ── state ─────────────────────────────────────────────────────────────────
  if (isEvent(e, "channel.written")) {
    // The authoritative value rides on task.committed's `writes`; this event is the
    // per-channel audit trail. Nothing to fold.
    return;
  }
  if (isEvent(e, "state.reduced")) {
    p.channels = { ...p.channels, ...e.payload.values };
    return;
  }

  // ── effects ───────────────────────────────────────────────────────────────
  if (isEvent(e, "effect.started")) {
    p.openEffects.add(e.payload.key);
    p.everStarted.add(e.payload.key);
    return;
  }
  if (isEvent(e, "effect.completed") || isEvent(e, "effect.failed")) {
    p.openEffects.delete(e.payload.key);
    return;
  }

  // ── gates ─────────────────────────────────────────────────────────────────
  if (isEvent(e, "gate.raised")) {
    const gid = e.payload.gateId;
    p.gates[gid] = {
      gateId: gid,
      taskId: e.taskId ?? ("" as TaskId),
      nodeId: e.payload.nodeId,
      policyRef: e.payload.policyRef,
      contentDigest: e.payload.contentDigest,
      raisedAtSeq: e.seq,
      raisedAtTs: e.ts,
      state: "open",
    };
    if (e.taskId) upsertTask(p, e.taskId, { state: "awaiting_gate" });
    return;
  }
  if (isEvent(e, "gate.decided")) {
    const g = p.gates[e.payload.gateId];
    if (g === undefined) return;
    p.gates[e.payload.gateId] = {
      ...g,
      state: "decided",
      decision: e.payload.decision,
      ...(e.payload.writes === undefined ? {} : { writes: e.payload.writes }),
      ...(e.payload.take === undefined ? {} : { take: e.payload.take }),
      ...(e.payload.justification === undefined ? {} : { justification: e.payload.justification }),
    };
    // The Task returns to `ready` so the scheduler re-leases it. The decision is
    // carried on the gate record, so the re-run applies it instead of re-gating.
    if (g.taskId !== ("" as TaskId)) upsertTask(p, g.taskId, { state: "ready" });
    return;
  }
  if (isEvent(e, "gate.timeout")) {
    const g = p.gates[e.payload.gateId];
    if (g) p.gates[e.payload.gateId] = { ...g, state: "expired" };
    return;
  }
  if (isEvent(e, "gate.cancelled")) {
    const g = p.gates[e.payload.gateId];
    if (g) p.gates[e.payload.gateId] = { ...g, state: "cancelled" };
    return;
  }

  // ── budget ────────────────────────────────────────────────────────────────
  if (isEvent(e, "graph.mutated")) {
    // The run is now executing a successor graph. Recording the new hash keeps
    // `assertGraphMatches` and trace reconstruction honest across the change.
    p.graphHash = e.payload.newHash;
    return;
  }
  if (isEvent(e, "fanout.planned")) {
    p.fanouts[`${e.payload.edgeId}@${e.payload.parentBranch}`] = {
      nodeId: e.payload.nodeId,
      width: e.payload.width,
    };
    return;
  }
  if (isEvent(e, "budget.exhausted")) {
    p.budgetExhausted = true;
    return;
  }
  if (isEvent(e, "budget.reserved")) {
    p.reservedUsd += e.payload.amountUsd;
    return;
  }
  if (isEvent(e, "budget.settled")) {
    // Release the reservation, then book the actual. Rounding to 6 decimals keeps
    // float drift from leaving a phantom cent reserved forever.
    p.reservedUsd = Math.max(0, round6(p.reservedUsd - e.payload.reservedUsd));
    return;
  }
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Values written by a committed Task, applied to the projection's channel state. */
export function applyWrites(channels: ChannelState, writes: Readonly<Record<string, unknown>>): ChannelState {
  return { ...channels, ...writes };
}

// ---------------------------------------------------------------------------
// Branch-scoped views
// ---------------------------------------------------------------------------

/**
 * Every branch path from the root down to `branch`, in order.
 * `root/e1[7]/e5[2]` → `["root", "root/e1[7]", "root/e1[7]/e5[2]"]`.
 */
export function branchChain(branch: BranchCoordinate): string[] {
  const out = [encodeBranch(ROOT_BRANCH)];
  for (let i = 1; i <= branch.segments.length; i++) {
    out.push(encodeBranch({ segments: branch.segments.slice(0, i) }));
  }
  return out;
}

/**
 * Channel state as a Task at `branch` sees it: shared channels overlaid with every
 * binding on its path, deepest last. A nested fan-out therefore shadows its parent's
 * item channel, which is what makes nested fan-outs composable.
 */
export function stateAtBranch(p: RunProjection, branch: BranchCoordinate): ChannelState {
  let out: Record<string, unknown> = { ...p.channels };
  for (const path of branchChain(branch)) {
    const bound = p.bindings[path];
    if (bound !== undefined) out = { ...out, ...bound };
  }
  return out;
}

/** The `StateView` handed to a node body: branch-resolved, then read-restricted. */
export function viewFor(
  p: RunProjection,
  specs: Readonly<Record<string, ChannelSpec>>,
  branch: BranchCoordinate,
  reads: readonly string[],
): StateView {
  return makeStateView(specs, stateAtBranch(p, branch), reads);
}

/**
 * The scope handed to an expression (`when`, `until`, router cases).
 *
 * Unlike `viewFor` this is NOT read-restricted — the compiler already proved every
 * reference is declared (GRAPH004), so re-checking at run time would only be able to
 * fail on a graph that could not have compiled.
 */
export function scopeFor(
  p: RunProjection,
  specs: Readonly<Record<string, ChannelSpec>>,
  branch: BranchCoordinate,
): Record<string, unknown> {
  const raw = stateAtBranch(p, branch);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    const spec = specs[name];
    out[name] = spec === undefined ? value : channelValue(spec, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Queries the scheduler and UI need
// ---------------------------------------------------------------------------

export function tasksInState(p: RunProjection, ...states: readonly TaskState[]): readonly TaskRecord[] {
  const want = new Set(states);
  return Object.values(p.tasks)
    .filter((t) => want.has(t.state))
    .sort((a, b) => compareBranch(a.branch, b.branch) || (a.taskId < b.taskId ? -1 : 1));
}

export function openGates(p: RunProjection): readonly GateRecord[] {
  return Object.values(p.gates).filter((g) => g.state === "open");
}

export function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Outputs as declared by the graph. Used when writing `run.completed`. */
export function collectOutputs(p: RunProjection, spec: GraphSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of spec.outputs) {
    const channelSpec = spec.channels[name];
    const v = channelSpec === undefined ? p.channels[name] : channelValue(channelSpec, p.channels[name]);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** Guard used by the executor before it trusts a projection it did not build. */
export function assertGraphMatches(p: RunProjection, graphHash: string): void {
  if (p.graphHash !== "" && p.graphHash !== graphHash) {
    throw err.internal(
      CODES.E_TRACE_INCONSISTENT,
      `projection is for graph ${p.graphHash}, not ${graphHash}`,
      { details: { expected: graphHash, actual: p.graphHash } },
    );
  }
}

/** Stable digest of a projection's observable state. Used by replay verification. */
export function projectionDigest(p: RunProjection): string {
  return canonicalize({ channels: p.channels, bindings: p.bindings, status: p.status });
}
