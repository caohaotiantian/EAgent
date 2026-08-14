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
import { isEvent, type Actor, type ErrorRecord, type JournalEvent } from "../journal/events.ts";
import {
  channelValue,
  makeStateView,
  type ChannelSpec,
  type ChannelState,
  type StateView,
} from "../state/channels.ts";
import { ZERO_USAGE, addUsage, maxPosture, type Posture, type UsageRecord } from "../vocab.ts";
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
  /**
   * WHAT KIND OF PARTY decided, folded from `gate.decided`'s own actor.
   *
   * It is here because a reader has to be able to tell a decision a human made from one
   * a component made on their behalf, and `decision` cannot: `approve` reads identically
   * whether a person clicked it, the clock applied a pre-authorized default action, or
   * another gate's answer was inherited through dedup. D7.9 row 3 needs exactly that
   * distinction — see `#inheritable` in `run/gates.ts`, which may only inherit from a gate
   * a HUMAN decided, because inheriting anything else builds a chain whose far end is not
   * a person.
   *
   * THE KIND AND NOT THE ACTOR, for two independent reasons. A subject is a person's
   * identifier and this record reaches a browser (see `frame`/`summarise` in
   * `server/http.ts`), while the kind discloses nobody; and every object-valued field on
   * this type is one more thing `GateDispatcher` must copy rather than share, which its
   * own structural test holds it to. WHO decided is on the `gate.decided` event itself,
   * one hop away, where an audit reads it.
   *
   * Absent for an open gate, and for a `decided` one written before this field existed.
   * Every reader treats absent as "not a human's" — the fail-closed direction, and the
   * same reading `decisionOf` gives a decision in no vocabulary.
   */
  readonly decidedBy?: Actor["kind"];
  /** `edit` only: the channels the human wrote. */
  readonly writes?: Readonly<Record<string, unknown>>;
  /** `redirect` only: the edges the human selected. */
  readonly take?: readonly string[];
  readonly justification?: string;

  // ── authorization, folded from `gate.raised` ───────────────────────────────
  // These decide whether a decision is ALLOWED, so they are derived here rather than
  // remembered by the broker that raised the gate. A broker's memory is empty in every
  // process that did not raise it, and an authorization check against an empty memory
  // is not a check.
  /** Subject ids permitted to decide. Absent or empty = the gate named nobody. */
  readonly approvers?: readonly string[];
  /** Channels an `edit` may write. Absent = unconstrained; `[]` = none. */
  readonly allowEdit?: readonly string[] | undefined;
  readonly slaMs?: number | undefined;
  /** Absolute. Reset by `gate.escalated`, never by a restart. */
  readonly deadline?: number | undefined;
  readonly onTimeout?: "escalate" | "default_action" | "fail";
  /** Escalation tier, folded from `gate.escalated`. 0 is the original delivery. */
  readonly tier: number;
  /**
   * How many of this gate's declared reminders have been sent, folded from
   * `gate.reminded` — one per row, never from the row's own `nth`.
   *
   * A COUNT OF ROWS RATHER THAN A HIGH-WATER MARK, so a payload nobody can read cannot
   * corrupt it: `nth` is `number` in the vocabulary and a journal is authoritative rather
   * than well-formed, and a `remindersSent` of `NaN` would index the schedule at `NaN`,
   * which is `undefined`, which reads as "the schedule is spent". Counting rows makes the
   * field a non-negative integer by construction whatever the payloads say, and duplicate
   * rows for one `nth` cost a skipped nudge rather than an endless one — the fail-closed
   * direction for something whose failure mode is interrupting a person.
   *
   * Absent means none, which is what an older journal and a gate with no schedule both
   * honestly are. It is what makes the reminder due-instant a fact about the LOG rather
   * than about the process that raised the gate; a counter in a broker's memory would reset
   * the whole schedule on every deploy.
   */
  readonly remindersSent?: number;
  /**
   * WHEN SOMEBODY WAS FIRST TOLD, folded from `gate.delivered`.
   *
   * Delivery is still not a STATE — D7.3: `gate.delivered` is journaled beside an open gate
   * and changes nothing about it — and this field does not make it one. What it makes
   * possible is a question `state` alone cannot answer. `announcementOutstanding` in
   * `run/gates.ts` suppresses a batch joiner's page only when a sibling is open AND was
   * delivered, because an open member nobody was ever told about holds no announcement; the
   * predicate existed with nothing folding this half, so the conjunct read
   * `undefined !== undefined` for every gate and the suppression could never fire.
   *
   * FIRST WRITE WINS, and nothing overwrites it. It is the instant this question was first
   * announced, which is a fact that does not move. One raise writes one `gate.delivered` per
   * CHANNEL and every escalation writes more, so a last-write field would mean "when it was
   * last paged" — a different question, answerable from those rows, one hop away.
   */
  readonly deliveredAt?: number;
  /**
   * The soft lock: WHO says they are looking at this gate, and until when — D7.3's
   * `Claimed`, folded from `gate.claimed`.
   *
   * `claimedBy` is the claiming actor's `subject`, taken from the EVENT'S actor and not from
   * its payload, exactly as `decidedBy` is. `claimedUntil` is the absolute instant the claim
   * runs out.
   *
   * THEY GRANT NOTHING AND BLOCK NOTHING. No decision path reads either one: `resolve`,
   * `resolveBatch` and `#fireTimeout` never mention them, so a claim cannot delay or
   * authorize a decision and one credential claiming every gate in a queue stalls nothing.
   * The only readers are `liveClaim` and `claimHolder` in `run/gates.ts`, both serving
   * `HumanGateBroker.claim` itself.
   *
   * THE VALUES ARE A CLAIM ABOUT WHAT THE APPENDER WROTE, not about what a journal holds —
   * the same reading `batch` above gets, and for the same reason (invariant 2). The arm
   * passes `until` through verbatim, so a hand-written log can carry a `claimedUntil` of
   * `NaN` or a string; `liveClaim` re-validates both fields before believing either, and a
   * value that loses its comparison reads as UNCLAIMED, which costs a duplicated look rather
   * than a silence.
   *
   * NOTHING EVER CLEARS THEM, because expiry is not a write — see the fold arm and
   * `CLAIM_TTL_MS`. A spent pair on an old record is not state to reap; it is a number every
   * reader has already compared against its own clock and found over.
   */
  readonly claimedBy?: string;
  readonly claimedUntil?: number;
  /**
   * The gate in ANOTHER run this one mirrors — set only by a subgraph node.
   *
   * It decides two things, which is why it is folded here rather than remembered: which
   * child gate a forwarded decision may answer (exactly this one, or none), and that the
   * gate carries approve/reject only, since `edit` and `redirect` cannot cross into the
   * other run's namespace. See `gate.raised.mirrorOf`.
   */
  readonly mirrorOf?: GateId;
  /**
   * The batch this gate merged into, when its node declared `batching` (D7.9 row 2).
   *
   * Folded rather than remembered because it DECIDES something: one decision on a batch
   * closes every member, so which batch a gate is in is part of what a decision is
   * checked against. `id` is the first member's gateId — a batch has no identity of its
   * own, it is the gate the others joined.
   *
   * It is only ever a Map key here, never an object index, so an `id` of `__proto__` from
   * a hand-written journal groups a batch nobody can name rather than reaching a
   * prototype. See `gateBatchMembers` in `run/gates.ts`.
   *
   * `windowMs`, `maxBatch` and `deliveryDigest` are the BATCH'S OWN governance, carried by
   * every member — the cap on what one click closes, the window it accumulates in, and the
   * identity of the route it is announced on. They are journaled so that admitting a new
   * member is decided against the batch rather than against the applicant's own
   * `BatchingSpec`; see `gate.raised.batch` for what went wrong when it was not.
   *
   * THE TYPES HERE ARE A CLAIM ABOUT WHAT THE APPENDER WROTE, NOT ABOUT WHAT A JOURNAL
   * HOLDS. The fold passes this object through verbatim (invariant 2: the journal is
   * authoritative), so a hand-written one can carry a `windowMs` of `NaN` or a string.
   * `batchGovernance` re-validates every field before anything is admitted, for the reason
   * `usableBatching` re-validates the spec: a `NaN` loses every comparison, and losing a
   * comparison is how a cap silently becomes no cap.
   */
  readonly batch?: {
    readonly id: GateId;
    readonly key: string;
    readonly windowMs?: number;
    readonly maxBatch?: number;
    readonly deliveryDigest?: string;
  };
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
  /**
   * Scope → the posture oversight has been RAISED to, and scope → a human's CEILING.
   *
   * Both were process-local, so a restart rebuilt an empty `PolicyEngine` and every
   * escalation this run had earned silently vanished — a posture lowered with no human
   * `deescalate`, which is invariant 5 broken by the recovery path itself. They are
   * journaled, so they are foldable; folding them is what makes the journal the only
   * authoritative state rather than merely the longest-lived one.
   *
   * Folded in SEQ ORDER and not as two independent max-folds: `deescalate` deletes an
   * escalation AND sets a ceiling, so folding the `to` values alone can reconstruct a
   * posture lower than the process ever held.
   */
  readonly escalations: Readonly<Record<string, Posture>>;
  readonly ceilings: Readonly<Record<string, Posture>>;
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
  escalations: Record<string, Posture>;
  ceilings: Record<string, Posture>;
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
 * that were already folded, so what earlier events mean changes retroactively. The folder
 * detects that, goes `stale`, and the caller pays one full re-fold — through `restart()`,
 * which is the part that is easy to get wrong and was: see that method.
 */
export class RunFolder {
  #p: MutableProjection | undefined;
  #lastSeq = 0;
  #stale = false;
  /**
   * `(checkpointSeq, markerSeq)` ranges this folder has already been told to hide.
   *
   * Kept across `restart()`, which is the whole reason this field exists rather than the
   * range being re-derived: a folder that forgets what the marker said meets it again on
   * the way back and stops in the same place.
   */
  readonly #suppressed: [number, number][] = [];

  /** The highest seq folded so far. Read the journal from `lastSeq + 1`. */
  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** True once a NEW rewind marker arrived: call `restart()` and re-push from seq 1. */
  get stale(): boolean {
    return this.#stale;
  }

  /**
   * Drop the folded state, keep what the markers said, and accept a re-push from seq 1.
   *
   * **A FRESH `RunFolder` IS NOT A RESTART**, and reading it as one was a live defect with
   * two faces. A new folder knows nothing about the marker that made the old one stale, so
   * it meets that marker on the way back, goes stale at exactly the same seq, and hands
   * back a projection folded to *just before the rewind* — with none of the suppression the
   * marker exists to declare. So the incremental fold and `foldRun` disagreed about the
   * same journal, permanently, and every later pass repeated the same wasted double read.
   *
   * Keeping the ranges is what makes the re-push converge: on the way back the marker is
   * already known, the events it hides are skipped, and the fold reaches the head. A second
   * marker discovered during that pass goes stale again — each pass learns at least one new
   * range and a journal holds finitely many, so a `while (stale)` loop terminates.
   */
  restart(): void {
    this.#p = undefined;
    this.#lastSeq = 0;
    this.#stale = false;
  }

  push(events: Iterable<JournalEvent>): void {
    for (const e of events) {
      if (e.seq <= this.#lastSeq) continue;
      if (isEvent(e, "checkpoint.restored") && e.payload.mode === "rewind" && this.#learn(e.payload.atSeq, e.seq)) {
        this.#stale = true;
        return;
      }
      this.#lastSeq = e.seq;
      // A suppressed event still advances `lastSeq` — it has been read and must not be read
      // again — but it must not advance `seq` or reach `apply`, exactly as in `foldRun`.
      if (this.#suppressed.some(([from, to]) => e.seq > from && e.seq < to)) continue;
      this.#p ??= emptyProjection(e);
      this.#p.seq = e.seq;
      apply(this.#p, e);
    }
  }

  /**
   * Record a rewind's range. `true` when it is NEW, i.e. when it invalidates this fold.
   *
   * A marker with no numeric `atSeq` declares no range — `foldRun` suppresses nothing for
   * it — so it is not a reason to go stale either. The two folds must agree on that, or an
   * incremental reader and a full reader answer differently about the same journal.
   */
  #learn(at: number, markerSeq: number): boolean {
    if (typeof at !== "number") return false;
    if (this.#suppressed.some(([from, to]) => from === at && to === markerSeq)) return false;
    this.#suppressed.push([at, markerSeq]);
    return true;
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
    escalations: {},
    ceilings: {},
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
    escalations: { ...p.escalations },
    ceilings: { ...p.ceilings },
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

/**
 * The events that MOVE a run's status — and therefore the ones a terminal status refuses.
 *
 * WHICH TRANSITIONS ARE LEGAL FROM A TERMINAL STATE? None. `succeeded`, `failed` and
 * `cancelled` each carry an `endedAt`, and nothing appended afterwards can unmake that: a
 * cancel is not un-cancelled by a later timeout, and a run does not succeed after it
 * failed. Answering it once, over the set, is the point — the rule started life as a
 * special case on `run.resumed` alone, which made it a property of one event rather than of
 * the status, and the next event to violate it (`run.failed`, appended by the SLA sweep to a
 * run an operator had already cancelled) sailed straight through and erased the
 * cancellation from every derived read model.
 *
 * Every one of these has an append-side guard too, which per invariant 2 is the primary
 * fix — this is the half that keeps a journal written by an older build readable.
 */
const RUN_STATUS_EVENTS: ReadonlySet<string> = new Set([
  "run.started",
  "run.suspended",
  "run.resumed",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

function apply(p: MutableProjection, e: JournalEvent): void {
  // Silent rather than throwing, for the reason the whole fold is tolerant: a projection
  // that crashes on a strange log cannot be used to diagnose the incident that produced it.
  if (RUN_STATUS_EVENTS.has(e.type) && isTerminal(p.status)) return;

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
  if (isEvent(e, "policy.escalated")) {
    // `max`, never assignment: two rules may raise the same scope, and the journal
    // records each raise rather than the running total.
    p.escalations[e.payload.scope] = maxPosture(p.escalations[e.payload.scope] ?? "out", e.payload.to);
    return;
  }
  if (isEvent(e, "policy.deescalated")) {
    // A human lowered it. Order matters: this DELETES the escalation and installs a
    // ceiling, so a later escalation in the same scope raises from the floor again.
    delete p.escalations[e.payload.scope];
    p.ceilings[e.payload.scope] = e.payload.to;
    return;
  }
  if (isEvent(e, "run.suspended")) {
    p.status = e.payload.reason === "gate" ? "awaiting_gate" : "interrupted";
    p.suspendedReason = e.payload.reason;
    return;
  }
  if (isEvent(e, "run.resumed")) {
    // A RUN THAT HAS ENDED DOES NOT RESUME — and that check now lives in
    // `RUN_STATUS_EVENTS` above, with every other status transition, because it was never
    // a fact about this event.
    //
    // What made it visible first: `gate.decided` carries an unconditional `run.resumed`, so
    // a leftover gate answered on a cancelled run folded the status back to `running` and
    // the executor drove the action the cancel existed to prevent. The primary fix is on
    // the APPEND side — `HumanGateBroker.resolve` refuses on a terminal run, and it is the
    // only appender of this event — because invariant 2 makes the journal authoritative and
    // this read model derived: a projection that quietly repairs an impossible log is a
    // projection nobody can use to diagnose one.
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
    // `p.gates[gid] = record` with `gid === "__proto__"` does not add a gate — it REPLACES
    // the map's prototype, so every later lookup on that projection resolves through a
    // gate record. Nothing in `src/` can mint such an id (`newGateId` is derived from a
    // timestamp), so this is about a journal written by hand or by something else; the
    // tolerant reading is to drop the row rather than to corrupt the map it cannot join.
    if (!isOwnName(gid)) return;
    p.gates[gid] = {
      gateId: gid,
      taskId: e.taskId ?? ("" as TaskId),
      nodeId: e.payload.nodeId,
      policyRef: e.payload.policyRef,
      contentDigest: e.payload.contentDigest,
      raisedAtSeq: e.seq,
      raisedAtTs: e.ts,
      state: "open",
      tier: 0,
      ...(e.payload.approvers === undefined ? {} : { approvers: e.payload.approvers }),
      ...(e.payload.allowEdit === undefined ? {} : { allowEdit: e.payload.allowEdit }),
      ...(e.payload.slaMs === undefined ? {} : { slaMs: e.payload.slaMs }),
      ...(e.payload.deadline === undefined ? {} : { deadline: e.payload.deadline }),
      ...(e.payload.onTimeout === undefined ? {} : { onTimeout: e.payload.onTimeout }),
      ...(e.payload.mirrorOf === undefined ? {} : { mirrorOf: e.payload.mirrorOf }),
      ...(e.payload.batch === undefined ? {} : { batch: e.payload.batch }),
    };
    if (e.taskId) upsertTask(p, e.taskId, { state: "awaiting_gate" });
    return;
  }
  if (isEvent(e, "gate.delivered")) {
    // A RECEIPT, NOT A TRANSITION (D7.3), so this arm is one field wide and touches neither
    // `state` nor anything a decision is checked against.
    //
    // AND IT IS NOT GUARDED ON `open`, which every gate arm below it is. Those guard because
    // they write `state`, or — the nudge — a counter that means nothing once the question has
    // an answer. This one records that somebody WAS TOLD, and that stays true after they
    // answer: guarding it would make a gate delivered and decided in the same instant read as
    // never delivered, which is a false statement about what happened.
    //
    // FIRST WRITE WINS. See the field: one raise writes one row per CHANNEL and every
    // escalation writes more, so only the first of them is "when this was first announced".
    const g = gateIn(p.gates, e.payload.gateId);
    if (g === undefined || g.deliveredAt !== undefined) return;
    p.gates[e.payload.gateId] = { ...g, deliveredAt: e.ts };
    return;
  }
  if (isEvent(e, "gate.claimed")) {
    // THIS ARM IS THE ARBITER, and it is the only one. `HumanGateBroker.claim` checks the
    // holder before it appends and then reads the answer back OUT of this fold, because two
    // people claiming in the same instant is the case a claim exists for and a check made
    // before an append cannot see the row that has not landed yet. Whoever this arm keeps is
    // who holds it, and the loser is told BY WHOM rather than told they hold it.
    //
    // ONLY FROM `open`, the rule every gate arm follows: a claim on a question that has been
    // answered is not a hint about anything. `claim` refuses to write one, so a row like that
    // is hand-written.
    //
    // ONLY FROM A HUMAN. `claimedBy` is a `subject`, which only the human arm of `Actor` has
    // — and that is the rule rather than an accident of the type: `claim` admits no other
    // kind, because a component holding a gate would tell the people who must look that they
    // need not.
    //
    // THE FOLD HAS NO CLOCK OF ITS OWN, and giving it one would make the same journal fold
    // two ways at two instants — the property replay verification exists to refuse. So the
    // instant it arbitrates AT is the ARRIVING EVENT'S OWN `ts`: the question is "was the
    // incumbent's claim still live when this second one was made?", and the second claim's
    // own timestamp is when it was made. That also makes the answer STABLE — re-folding the
    // same log at any later wall clock names the same holder — which a reader's `now` could
    // not.
    //
    // A HOLDER WHOSE CLAIM HAS RUN OUT BY THEN LOSES IT, which is not a second rule but
    // `liveClaim`'s rule with the fold's clock substituted, and it is what makes a claim
    // expire by being IGNORED rather than by anything writing anything. `<` and not `<=`, so
    // a claim whose instant has arrived is over; and an incumbent `until` that is not a
    // number loses the comparison and therefore the lock, which is the same direction
    // `liveClaim` takes — unclaimed, costing a duplicated look rather than a silence.
    //
    // THE CLAIMANT'S OWN RE-CLAIM ALWAYS LANDS, live or lapsed, which is how a person still
    // typing keeps it. It REPLACES `claimedUntil` rather than raising it: a re-claim written
    // by a process whose clock is behind can only SHORTEN its own lock, and a short lock
    // costs a second person opening the same gate while a long one is a queue that looks
    // attended and is not — the asymmetry `CLAIM_TTL_MS` is chosen for.
    const g = gateIn(p.gates, e.payload.gateId);
    if (g?.state !== "open" || e.actor.kind !== "human") return;
    const heldBy: unknown = g.claimedBy;
    const heldUntil: unknown = g.claimedUntil;
    const stillHeld =
      typeof heldBy === "string" && heldBy !== "" && typeof heldUntil === "number" && e.ts < heldUntil;
    if (stillHeld && heldBy !== e.actor.subject) return;
    // `until` VERBATIM, per invariant 2. `liveClaim` is where a journal's numbers are checked.
    p.gates[e.payload.gateId] = { ...g, claimedBy: e.actor.subject, claimedUntil: e.payload.until };
    return;
  }
  if (isEvent(e, "gate.escalated")) {
    const g = gateIn(p.gates, e.payload.gateId);
    if (g === undefined) return;
    p.gates[e.payload.gateId] = {
      ...g,
      tier: e.payload.tier,
      ...(e.payload.deadline === undefined ? {} : { deadline: e.payload.deadline }),
    };
    return;
  }
  if (isEvent(e, "gate.reminded")) {
    // ONLY FROM `open`, the same rule as every arm around it: a nudge folded onto a gate
    // somebody has already answered would say the SLA had a say in an outcome it did not
    // reach — and `#commitForOpenGate` refuses to write one, so a row like that can only
    // come from a hand-written log.
    //
    // AND IT MOVES NOTHING ELSE. Not `deadline`, not `tier`, not `state`. That is the
    // difference between a reminder and an escalation stated where a reader can check it:
    // this arm is one field wide on purpose, and widening it is how a nudge would silently
    // become an extension.
    const g = gateIn(p.gates, e.payload.gateId);
    if (g?.state !== "open") return;
    p.gates[e.payload.gateId] = { ...g, remindersSent: (g.remindersSent ?? 0) + 1 };
    return;
  }
  if (isEvent(e, "gate.decided")) {
    // ONLY FROM `open`, for the reason spelled out on `gate.cancelled` below: D7.3's other
    // three states are terminal for the gate, and a second transition does not retract the
    // first one. This arm used to fold over ANY state, and it is reachable — `resolve`
    // checks the gate at `p.seq` and then appends through the RETRYING `log.append`, so two
    // people answering the same open gate in the same instant both land and the LAST one
    // won. A rejection overwritten by an approval made against the same question is the
    // whole defect; a gate a cancel had just closed reading back `decided` is the same
    // event one door over.
    const g = gateIn(p.gates, e.payload.gateId);
    if (g?.state !== "open") return;
    p.gates[e.payload.gateId] = {
      ...g,
      state: "decided",
      decision: e.payload.decision,
      // The EVENT's actor, not the payload's — there is no actor in the payload and there
      // must not be one. Attribution is a property of the append, checked at the door that
      // wrote it; a second copy inside the payload is a second thing to keep in step.
      decidedBy: e.actor.kind,
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
    // `default_action` is NOT an expiry. The clock ran out and the gate's declared
    // default is about to decide it, so the `gate.decided` immediately after is the
    // state that matters — expiring it here would make the broker's own follow-up
    // decision collide with `E_GATE_ALREADY_RESOLVED` and abort the sweep. Every other
    // action really is an expiry, including the `fail` the broker substitutes when a
    // default action did not survive a restart.
    //
    // AND ONLY FROM `open`, same rule as the two arms around it. `sweepTimeouts` reads the
    // run and its gates and then expires them one at a time, so a decision or a cancel that
    // lands mid-sweep used to be overwritten by a deadline it had already beaten — the
    // human answered and the read model said `expired`.
    const g = gateIn(p.gates, e.payload.gateId);
    if (g?.state === "open" && e.payload.action !== "default_action") {
      p.gates[e.payload.gateId] = { ...g, state: "expired" };
    }
    return;
  }
  if (isEvent(e, "gate.cancelled")) {
    // ONLY FROM `open`, because D7.3's other three states are terminal for the gate. A
    // decision a human actually gave, and an expiry a deadline actually reached, are facts
    // about what happened; a later run-wide cancel does not retract either one, and
    // overwriting them would erase the record of the decision from the read model while
    // leaving `gate.decided` in the journal saying otherwise.
    const g = gateIn(p.gates, e.payload.gateId);
    if (g?.state === "open") p.gates[e.payload.gateId] = { ...g, state: "cancelled" };
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

/**
 * A gate by id — THE lookup, so that no caller has to remember what a gate map is.
 *
 * `p.gates` is an ordinary object, so `p.gates["__proto__"]` answers with
 * `Object.prototype`: an object, therefore "found", whose `state` is `undefined`, therefore
 * "not open". A bearer-authenticated `POST /runs/:id/gates/__proto__` came back
 * `409 E_GATE_ALREADY_RESOLVED` — which tells its caller that a gate by that name exists and
 * has already been answered. Every inherited name does it: `constructor`, `toString`,
 * `valueOf`.
 *
 * The delivery layer had already closed this at ITS door with `safeGateId`, and that is
 * exactly the shape of fix this codebase has been burned by twice: a rule that holds for the
 * door that remembered it. So it is closed HERE, at the lookup, and every caller inherits it
 * by calling this instead of indexing.
 */
export function gateOf(p: RunProjection, gateId: GateId): GateRecord | undefined {
  return gateIn(p.gates, gateId);
}

/** The same lookup over the mutable half, for the fold's own arms. */
function gateIn(gates: Readonly<Record<GateId, GateRecord>>, gateId: GateId): GateRecord | undefined {
  return isOwnName(gateId) && Object.prototype.hasOwnProperty.call(gates, gateId) ? gates[gateId] : undefined;
}

/**
 * Whether a name can be an OWN property rather than a message to the prototype chain.
 *
 * Only `__proto__` has a setter on `Object.prototype`, so only `__proto__` corrupts on
 * write; every inherited name misleads on read, which `hasOwnProperty` handles. Both are
 * checked, because "which of these two hazards does this name have" is not a question any
 * call site should be asked to answer.
 */
function isOwnName(name: string): boolean {
  return name !== "__proto__";
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
