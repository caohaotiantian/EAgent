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
import { isEvent, type Actor, type ErrorRecord, type JournalEvent, type SubmittedBy } from "../journal/events.ts";
import { payloadHandle, type PayloadRef } from "../journal/payloads.ts";
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
   * How long this Task has been DEFERRED, summed, and how many times.
   *
   * A deferral is a reschedule that charged no attempt — today only a provider rate limit,
   * which is not the node's failure. `attempt` therefore cannot bound it, so something else
   * must, or a provider stuck at 429 requeues one Task forever. These two are that bound and
   * that curve, and they are FOLDED rather than counted in memory for the reason every other
   * decision input here is: a plane that restarts must not get a fresh budget.
   */
  readonly deferredMs?: number;
  readonly deferrals?: number;
  /**
   * Who holds this Task, and since when.
   *
   * The journal has always recorded it; the read model discarded it, because with one
   * worker there is nothing to ask. A second worker's first question is "is anyone on
   * this?" — so folding it in is what makes the scheduler seam usable at all.
   */
  readonly lease?: { readonly workerId: string; readonly at: number; readonly fencingToken: number };
  /**
   * WHAT THIS TASK HAS SPENT ACROSS ALL ITS ATTEMPTS, not what its last commit said.
   *
   * It used to be `task.committed.usage` assigned verbatim, which is a per-ATTEMPT summary
   * and therefore two different lies about a retried Task: the first attempt's spend was
   * overwritten by the second's, and an attempt that is retried appends no commit at all, so
   * its spend was never here in the first place. It is now accumulated by the same fold that
   * produces `RunProjection.usage` — see `chargeUsage` — so `Σ tasks[*].usage` and the run
   * total agree by construction.
   */
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
  /** Subjects barred from deciding, resolved at raise. See `gate.raised.excludedApprovers`. */
  readonly excludedApprovers?: readonly string[];
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
  /**
   * The principal this run was submitted for, folded from `run.submitted`.
   *
   * ABSENT MEANS NOBODY WAS RECORDED, which is a different statement from "a principal the
   * reader may not see" — there is no second value for that, because a projection nobody may
   * read is one nobody is handed. Readers that scope on it must treat absence as the
   * PERMISSIVE case, matching every journal written before the field existed.
   */
  readonly submittedBy?: SubmittedBy;
  readonly status: RunStatus;
  readonly seq: Seq;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly posture: Posture;

  readonly channels: ChannelState;
  /** branch path → the channels bound at exactly that branch. */
  readonly bindings: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Channels whose value in `channels` is a `PayloadHandle` rather than the value itself.
   *
   * THE AUTHORITATIVE ANSWER TO "IS THIS A HANDLE", and the reason it is a field rather than a
   * predicate over `channels`. A handle is an ordinary JSON object, so a node body can write
   * one; a reader that recognised handles by shape would let any node that can write a channel
   * name a payload it never produced, and would then hand that node the bytes. This map is
   * built only from the `external` declarations on `task.committed` and `state.reduced` — by
   * the executor that did the externalising — so it says what the RUN did, not what a value
   * looks like.
   *
   * Folded, therefore reconstructible across a restart, which is what invariant 1 requires of
   * any value a decision reads: the engine reads it to decide what to resolve before a body
   * runs, and a fresh process must reach the same answer.
   *
   * Empty for every run that externalised nothing, which is every run written before this
   * existed and every run under an engine with no payload store.
   */
  readonly external: Readonly<Record<string, PayloadRef>>;

  readonly tasks: Readonly<Record<TaskId, TaskRecord>>;
  readonly gates: Readonly<Record<GateId, GateRecord>>;

  /**
   * THE RUN'S SPEND, FOLDED FROM THE EFFECT RECORDS — see `chargeUsage`.
   *
   * `wallMs` here is PROVIDER time and deliberately excludes tool time; the trajectory's
   * `wallMs` deliberately includes it. See `chargeUsage` for why the two numbers differ.
   */
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
  /**
   * AN OPERATOR STOPPED THIS RUN, and only an operator starts it again.
   *
   * SEPARATE FROM `status` ON PURPOSE, and the separation is the whole guard. A pause
   * writes `run.suspended{reason:"operator"}`, which folds `status` to `interrupted` — and
   * `status` is not a durable record of that decision, because `gate.decided` ships an
   * unconditional `run.resumed`, so answering ANY open gate folds the run straight back to
   * `running`. A pause that lived in `status` alone would therefore be lifted by a human
   * answering an unrelated question, and the work the operator stopped would run. That is
   * "no automated path may loosen" broken by a path nobody would call a permission change.
   *
   * So this is its own fact, set by `run.suspended{reason:"operator"}` and cleared by
   * `run.resumed{by:"operator"}` and by nothing else: a `by:"gate"` or `by:"timer"` resume
   * moves `status` and leaves this standing. `Engine.#advanceSerially` reads THIS, not the
   * status, and a run whose gate has been answered while paused therefore sits at
   * `running` with `paused: true` until a human says otherwise.
   */
  readonly paused: boolean;
  /**
   * NODE → THE EDGES AN OPERATOR PUT IT ON, overriding what the node itself selects.
   *
   * Folded from `operator.command{kind:"steer"}` so the override is reconstructible across a
   * restart, and so the plane that APPLIES a steer need not be the plane that received it.
   *
   * WHAT IS NOT CHECKED HERE, on purpose: whether the edges exist or leave that node.
   * `Engine.steer` refuses an undeclared edge against the compiled graph, which this fold does
   * not have — and `Engine.#strayRoute` refuses it a second time at the moment it would be
   * taken, which is the check that cannot be skipped by writing the journal directly. What this
   * fold does enforce is SHAPE: a `nodeId` that is not an own name, or a `take` that is not a
   * non-empty array of strings, yields no steer at all rather than a malformed one. A journal is
   * an input, and the fail-closed reading of a command nobody can parse is that it was not given.
   */
  readonly steers: Readonly<Record<NodeId, readonly EdgeId[]>>;
}

interface MutableProjection {
  runId: RunId;
  graphHash: string;
  submittedBy?: SubmittedBy;
  /**
   * Whether a `run.submitted` has been folded at all — NOT whether it named anybody.
   *
   * The distinction is the whole point. Guarding on `submittedBy === undefined` reads as
   * "first wins" and behaves as "first NON-EMPTY wins", so a run whose first submission
   * named nobody could be ADOPTED by a later one. The read-model column the next phase adds
   * is written on the row-creating INSERT and never on the update, so it would hold NULL for
   * that run while this fold answered with the second principal — the list route and the
   * detail route disagreeing about who owns a run, in the field that decides access.
   */
  sawSubmitted: boolean;
  status: RunStatus;
  seq: Seq;
  startedAt: number;
  endedAt?: number;
  posture: Posture;
  channels: Record<string, unknown>;
  bindings: Record<string, Record<string, unknown>>;
  external: Record<string, PayloadRef>;
  tasks: Record<TaskId, TaskRecord>;
  gates: Record<GateId, GateRecord>;
  usage: UsageRecord;
  /** Per Task, everything already added to `usage` on its behalf. `chargeUsage` reads it. */
  usageSeen: Record<TaskId, UsageRecord>;
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
  paused: boolean;
  steers: Record<NodeId, readonly EdgeId[]>;
  /**
   * The last snapshot `freeze` made, valid until the next `apply`.
   *
   * NOT AN OPTIMISATION OF THE FOLD — of the READS of it. `GateSweeper` keeps one `RunFolder`
   * per live run across ticks (see `#catchUp`) and asks for a projection every tick, whether or
   * not the journal moved; an idle run therefore paid a full copy of every container, per tick,
   * per run, for a value identical to the one it was handed last time. Measured on a run with
   * 1,600 tasks, 500 such snapshots: 106.7 ms to 0.0 ms.
   *
   * `apply` is the only thing that can change the state a snapshot describes, and it clears this
   * on entry — one line, in one place, so the cache cannot go stale by omission the way a
   * per-container dirty bit could.
   */
  snapshot: RunProjection | undefined;
  /** See `freeze`: the sorted forms, valid until the set behind each is written. */
  sortedOpenEffects: readonly string[] | undefined;
  sortedStartedEffects: readonly string[] | undefined;
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
    external: {},
    tasks: {},
    gates: {},
    usage: { ...ZERO_USAGE },
    usageSeen: {},
    reservedUsd: 0,
    outputs: {},
    openEffects: new Set(),
    everStarted: new Set(),
    escalations: {},
    ceilings: {},
    budgetExhausted: false,
    paused: false,
    steers: {},
    sawSubmitted: false,
    fanouts: {},
    snapshot: undefined,
    sortedOpenEffects: undefined,
    sortedStartedEffects: undefined,
  };
}

/**
 * A snapshot, and the two things it does NOT redo.
 *
 * The top-level maps are COPIED — see `RunFolder.projection` for why. What is not copied twice
 * is a snapshot of state nothing has touched: `apply` clears `p.snapshot`, so a second
 * `projection()` with no event between them hands back the object the first one made. That is
 * the whole of the `GateSweeper` cost, and it is safe because every member of `RunProjection` is
 * `readonly` and this function never mutates one after building it.
 *
 * The two sorted arrays are the other half. `everStarted` grows to one entry per effect the run
 * has started, and sorting it cost 36 us per snapshot at 1,600 effects — 121 ms over a
 * 1,600-branch fan-out's 3,312 snapshots — while the set itself changed between only ~100 of
 * those snapshot pairs. So the sorted form is cached and invalidated where the sets are written,
 * four lines in `apply`, and SHARED between snapshots rather than copied: the arrays are
 * `readonly string[]`, are never written after they are built, and sharing them is the same
 * decision the nested payload values already carry.
 *
 * WHAT THIS DOES NOT FIX, measured rather than assumed: the `{ ...p.tasks }` copy, which is the
 * dominant term of a wide fan-out (594 ms of a 1,600-branch run's 715 ms in `freeze`). Per-
 * container dirty bits do not reach it — instrumented over that run, `tasks` was clean for 105 of
 * 3,312 snapshots, because the executor takes about two snapshots per task and a task changes
 * between nearly every pair. Making it cheaper needs either fewer snapshots (the executor's
 * call sites) or a persistent map, which would change `RunProjection.tasks`'s published type.
 */
function freeze(p: MutableProjection): RunProjection {
  if (p.snapshot !== undefined) return p.snapshot;
  p.sortedOpenEffects ??= [...p.openEffects].sort();
  p.sortedStartedEffects ??= [...p.everStarted].sort();
  const out: RunProjection = {
    runId: p.runId,
    graphHash: p.graphHash,
    status: p.status,
    seq: p.seq,
    startedAt: p.startedAt,
    posture: p.posture,
    channels: { ...p.channels },
    bindings: { ...p.bindings },
    external: { ...p.external },
    tasks: { ...p.tasks },
    gates: { ...p.gates },
    usage: { ...p.usage },
    reservedUsd: p.reservedUsd,
    escalations: { ...p.escalations },
    ceilings: { ...p.ceilings },
    outputs: { ...p.outputs },
    unknownEffects: p.sortedOpenEffects,
    startedEffects: p.sortedStartedEffects,
    budgetExhausted: p.budgetExhausted,
    paused: p.paused,
    steers: { ...p.steers },
    fanouts: { ...p.fanouts },
    ...(p.submittedBy === undefined ? {} : { submittedBy: p.submittedBy }),
    ...(p.endedAt === undefined ? {} : { endedAt: p.endedAt }),
    ...(p.error === undefined ? {} : { error: p.error }),
    ...(p.suspendedReason === undefined ? {} : { suspendedReason: p.suspendedReason }),
  };
  p.snapshot = out;
  return out;
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

/**
 * `(checkpointSeq, markerSeq)` exclusive ranges hidden by a rewind.
 *
 * Exported because the JOURNAL AUDITOR needs the same answer. It read raw events and so saw
 * undone history as live — a run that was rewound past an approval and re-approved looked like
 * a double completion. Two copies of this would drift; one is the point.
 */
export function suppressedRanges(events: readonly JournalEvent[]): [number, number][] {
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
 * SPEND IS FOLDED FROM THE EFFECT RECORDS, AND A RESTATEMENT CAN ONLY RAISE THE TOTAL.
 *
 * This fold used to read `task.committed.usage` and nothing else, and that number is a
 * per-ATTEMPT summary the engine assembles. It under-states spend twice, both times in the
 * rewarding direction:
 *
 * - It is `ZERO_USAGE` whenever an exception leaves `#executeTask`: `run/engine.ts` 2459
 *   catches it and returns `{status:"failed", usage: ZERO_USAGE}`, discarding every turn the
 *   task had already paid for. MEASURED end to end on this tree, one agent node whose second
 *   turn is refused: `model.called $9` then `task.committed $0`, folding to `usage.costUsd 0`
 *   beside a journal that says $9 — a projection contradicting its own log.
 * - It is NOT APPENDED AT ALL for an attempt that is retried — `engine.ts` 4512 writes
 *   `task.retry_scheduled` and no commit — so a Task whose first attempt burned $0.003 and
 *   whose second succeeded for $0.003 folded to $0.003.
 *
 * THIS IS THE DANGEROUS HALF OF THAT DEFECT, not a reporting blemish. `engine.ts:1237`
 * re-seeds `PolicyEngine.spentUsd` from `p.usage.costUsd` on the first attach after a
 * restart, so every dollar missing here is a dollar REFUNDED to a resumed run's budget.
 * Measured on this tree, over two real Engines and one journal (the fixture is
 * `test/run/projection-usage.test.ts`): a $14-budget run whose first attempt burned $9 and
 * was retried folded to `usage.costUsd 0` — the $9 is on `model.called` and there is no
 * commit at all — so the second process restored $0, took two more turns, and the run
 * SUCCEEDED having actually paid the provider $27, 1.9x its declared cap. Folding the effect
 * records, the same second process is refused after one turn with `E_BUDGET_EXHAUSTED`.
 *
 * ── The three arms, and why there is a fourth ────────────────────────────────
 *
 * | Record | Contributes | Appended |
 * |---|---|---|
 * | `model.called` | the turn's whole bill | once per model turn |
 * | `subgraph.completed` | the CHILD run's whole `usage` | once, when a child run SUCCEEDS |
 * | `task.committed` / `run.completed` | only the EXCESS over what is already counted | a restatement |
 *
 * The excess arm is not the old defect returning. `chargeUsage` remembers, per Task,
 * everything already added on its behalf, and a restatement adds only `max(0, stated −
 * seen)` componentwise — so the ordinary paths, where the commit merely re-states the
 * `model.called` rows, contribute nothing. What it keeps is the one dollar the journal
 * states ONLY on a commit: `engine.ts` appends `subgraph.completed` on the SUCCESS path
 * alone (3905), so a FAILED subgraph's child spend reaches the parent through
 * `task.committed.usage` (3852) or not at all. Dropping the commit entirely would have
 * opened a fresh refund path while closing two.
 *
 * Because `seen` is cumulative per Task rather than per attempt, a retried subgraph whose
 * child cost grows from $1.00 to $1.50 across attempts charges $1.00 then $0.50 — the
 * child's cumulative total, counted once.
 *
 * ── TOOL TIME IS DELIBERATELY NOT HERE, and the trajectory's is ──────────────
 *
 * `tool.called` carries `ms` and no money, and it is NOT an arm. A `UsageRecord` is one
 * record about PROVIDER work, and this one is copied verbatim into `run.completed.usage`
 * and into `subgraph.completed.usage`, which a PARENT run then adds to its own — so folding
 * a child's local tool latency into `wallMs` would leave no field of a parent's `usage`
 * answering "what did the provider bill". `evolution/trajectory.ts` folds the same journal
 * and DOES add tool `ms`, because its `wallMs` feeds a latency term that is meant to measure
 * what the run burned, and thirty seconds in a tool is burned. **The two numbers therefore
 * differ on purpose, and a `wallMs` here that is smaller than the trajectory's is not a
 * disagreement.** A run's elapsed duration is `endedAt − startedAt`, which is neither.
 *
 * THE SUMMARISER USED TO BE THE HOLE HERE, and this paragraph said so: `#summarizeEffect`
 * called the provider and journaled `effect.started`/`effect.completed` with no `usage`, so its
 * tokens and dollars reached no total this fold could see. It now reserves, calls, settles and
 * returns its usage, which `#runAgent` adds to the TASK's own — carried by `task.committed` and
 * folded right here, as the excess over what the turn's `model.called` rows already charged.
 * There is deliberately no `model.called` row for it (`journal/audit.ts`'s
 * `call-pairs-with-its-effect` wants an effect of kind `model`, and the summary's is
 * `summarize`), which is why the spend arrives through the commit rather than through a call row.
 *
 * A FAILED SUBGRAPH'S CHILD SPEND IS THE ONE THAT IS STILL ONLY RECOVERABLE THROUGH THE COMMIT,
 * as above.
 */
function chargeUsage(p: MutableProjection, taskId: TaskId | undefined, u: UsageRecord): void {
  const amount = finiteUsage(u);
  p.usage = addUsage(p.usage, amount);
  if (taskId === undefined) return;
  p.usageSeen[taskId] = addUsage(p.usageSeen[taskId] ?? ZERO_USAGE, amount);
  upsertTask(p, taskId, { usage: addUsage(p.tasks[taskId]?.usage ?? ZERO_USAGE, amount) });
}

/**
 * A journal is written by an appender, and the types are a claim about that appender rather
 * than about the bytes — so a hand-written or corrupted row can carry `NaN` or a string.
 * One `NaN` dollar makes `p.usage.costUsd` `NaN` for the rest of the run, and every budget
 * comparison against `NaN` is FALSE, which turns a cap into no cap on the resume path this
 * fold feeds. A non-finite component is therefore dropped rather than propagated, and a
 * negative one is dropped too: a refund is the direction that loosens.
 */
function finiteUsage(u: UsageRecord | undefined): UsageRecord {
  if (u === null || typeof u !== "object") return { ...ZERO_USAGE };
  const ok = (x: number): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  return { inputTokens: ok(u.inputTokens), outputTokens: ok(u.outputTokens), costUsd: ok(u.costUsd), wallMs: ok(u.wallMs) };
}

/** Componentwise `max(0, stated − seen)`: the part of a restatement nothing has counted. */
function excessUsage(seen: UsageRecord, stated: UsageRecord | undefined): UsageRecord {
  const over = (a: number, b: number): number => (b > a ? b - a : 0);
  const s = finiteUsage(stated);
  return {
    inputTokens: over(seen.inputTokens, s.inputTokens),
    outputTokens: over(seen.outputTokens, s.outputTokens),
    costUsd: over(seen.costUsd, s.costUsd),
    wallMs: over(seen.wallMs, s.wallMs),
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
  // The one place a fold can change, so the one place the snapshot cache is dropped. Before the
  // guard below rather than after it: an event this function ignores has changed nothing and
  // would keep the cache valid, but "invalidate on entry" is a rule a later arm cannot forget.
  p.snapshot = undefined;

  // Silent rather than throwing, for the reason the whole fold is tolerant: a projection
  // that crashes on a strange log cannot be used to diagnose the incident that produced it.
  if (RUN_STATUS_EVENTS.has(e.type) && isTerminal(p.status)) return;

  // ── run lifecycle ─────────────────────────────────────────────────────────
  if (isEvent(e, "run.submitted")) {
    p.graphHash = e.payload.graphHash;
    // THE SAME MERGE `state.reduced` DOES, for the same reason: an input above the
    // externalisation threshold is seeded into the projection as a handle, and `#resolveReads`
    // fetches it for whichever node declares it exactly as it fetches a handle a node wrote.
    // No `delete` sibling here — this is the first event of a run, so `p.external` is empty and
    // there is no stale entry an input could be shadowing.
    p.channels = { ...p.channels, ...withHandles(e.payload.inputs, e.payload.external) };
    for (const [c, ref] of Object.entries(e.payload.external ?? {})) p.external[c] = ref;
    // FIRST WINS, INCLUDING WHEN THE FIRST ANSWER IS "NOBODY". The read-model column the
    // next phase adds is written on the row-creating INSERT and never on the update —
    // `first_ts`'s shape — so a second `run.submitted` leaves it alone whatever it says. If
    // this fold took the later value, the list route (the column) and the detail route (this
    // fold) would answer differently about who owns a run, in the field that decides access.
    //
    // AND THE GUARD IS ON `sawSubmitted`, NOT ON `submittedBy`. Guarding on the folded value
    // makes an UNOWNED first submission adoptable by a later one — the column would hold
    // NULL and this would name a principal, which is the same divergence in the direction
    // that matters, because "the first submission named nobody" is the common case: a
    // pre-upgrade journal, and every `loom run` without `--as`. Reachable from an embedder
    // re-submitting an explicit `runId`; `POST /runs` accepts no client-chosen id.
    if (!p.sawSubmitted) {
      p.sawSubmitted = true;
      if (e.payload.submittedBy !== undefined) p.submittedBy = e.payload.submittedBy;
    }
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
    // The operator's suspension is ALSO recorded off `status`, because `status` is about to
    // be moved by the first `run.resumed` any subsystem writes. See `RunProjection.paused`.
    if (e.payload.reason === "operator") p.paused = true;
    return;
  }
  if (isEvent(e, "operator.command")) {
    // ONLY `steer` FOLDS. The other three commands — cancel, pause, resume — are already
    // carried by the lifecycle event each of them ships in the same append, and folding them
    // twice would give the status two sources that could disagree. This one has no lifecycle
    // event of its own, because what it changes is a ROUTE and routes are not run status.
    if (e.payload.kind !== "steer") return;
    const nodeId = e.payload.args["nodeId"];
    const take = e.payload.args["take"];
    // SHAPE, CHECKED HERE; LEGALITY, CHECKED WHERE THE GRAPH IS. `args` is
    // `Record<string, unknown>` by declaration, and a journal is an input rather than
    // something this fold gets to assume well-formed. A command it cannot read yields NO
    // steer — the fail-closed reading, and the same one a run gets if nobody steered it.
    if (typeof nodeId !== "string" || !isOwnName(nodeId)) return;
    if (!Array.isArray(take) || take.length === 0 || !take.every((t) => typeof t === "string")) return;
    // LAST WINS. Two steers on one node are an operator changing their mind, not two routes.
    p.steers[nodeId as NodeId] = take as unknown as readonly EdgeId[];
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
    // ONLY AN OPERATOR CLEARS AN OPERATOR'S PAUSE. `by` is `"gate"` for every resume the
    // gate broker writes and `"timer"` for the sweeper's — both automated, both arriving
    // without anybody deciding the run should carry on. Taking the status back is right
    // (the gate really was answered); taking the pause back is the loosening this refuses.
    if (e.payload.by === "operator") p.paused = false;
    return;
  }
  if (isEvent(e, "run.completed")) {
    p.status = "succeeded";
    p.outputs = { ...e.payload.outputs };
    // A RESTATEMENT, NOT THE SOURCE. This was `p.usage = e.payload.usage` — an ASSIGNMENT,
    // and a no-op only because the engine copies `p.usage` straight back out (`engine.ts`
    // 5464). The moment the fold started counting the effect records the two could differ,
    // and an assignment would have let the run total OVERWRITE the per-call sum, restoring
    // the very under-count `chargeUsage` exists to close. It now adds only the excess, which
    // is nothing on every journal this engine writes and is money on one written by an
    // older build that had no `model.called` rows to fold.
    chargeUsage(p, undefined, excessUsage(p.usage, e.payload.usage));
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
    p.sortedOpenEffects = undefined;
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
      // `e.seq`, because the lease's seq IS the token the store enforces. Folding a payload
      // field here reported a per-process counter that `task_fence.max_token` never compared.
      lease: { workerId: e.payload.workerId, at: e.ts, fencingToken: e.seq },
    });
    return;
  }
  if (isEvent(e, "task.committed") && e.taskId) {
    // `writes` is a proposal, not state: it is folded by `state.reduced`, which may
    // be this Task's own immediate reduce or a later join's branch-ordered fold.
    upsertTask(p, e.taskId, {
      state: e.payload.status === "succeeded" ? "succeeded" : (e.payload.status as TaskState),
      take: e.payload.take as readonly EdgeId[],
      // A HANDLE IS PUT BACK WHERE THE VALUE WAS, so `TaskRecord.writes` still has one entry
      // per channel the Task wrote and every reader of it keeps counting the same things. The
      // engine only externalises a write it is reducing in the same commit, so a write a join
      // will later fold is never a handle — see `#externalise`.
      writes: withHandles(e.payload.writes, e.payload.external),
      attempt: e.payload.attempt,
    });
    // `usage` IS A PER-ATTEMPT RESTATEMENT — see `chargeUsage`. Assigning it to the Task and
    // adding it to the run was this fold's only source of spend, and it under-counted on
    // every failure path that had already paid and on every attempt that was retried.
    chargeUsage(p, e.taskId, excessUsage(p.usageSeen[e.taskId] ?? ZERO_USAGE, e.payload.usage));
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
    // A DEFERRAL ACCUMULATES; A RETRY DOES NOT. `attempt` is the retry budget and the writer
    // leaves it unchanged on a deferral, so without these two the only bound on "the provider
    // is still busy" would be the wall clock, and a restart would reset even that.
    const held = e.payload.deferred === true ? (p.tasks[e.taskId]?.deferredMs ?? 0) + e.payload.afterMs : undefined;
    upsertTask(p, e.taskId, {
      state: "retrying",
      attempt: e.payload.attempt,
      retryAfter: e.ts + e.payload.afterMs,
      ...(held === undefined ? {} : { deferredMs: held, deferrals: (p.tasks[e.taskId]?.deferrals ?? 0) + 1 }),
    });
    return;
  }

  // ── state ─────────────────────────────────────────────────────────────────
  if (isEvent(e, "channel.written")) {
    // The authoritative value rides on task.committed's `writes`; this event is the
    // per-channel audit trail. Nothing to fold.
    return;
  }
  if (isEvent(e, "state.reduced")) {
    p.channels = { ...p.channels, ...withHandles(e.payload.values, e.payload.external) };
    // The map tracks the CURRENT value of each channel, so a later inline write to a channel
    // that was once externalised has to clear it. Without the delete, `external` would still
    // name the channel, the engine would resolve a stale digest, and the node would be handed
    // a value the run had already replaced — a silent read of history.
    for (const c of e.payload.channels) delete p.external[c];
    for (const [c, ref] of Object.entries(e.payload.external ?? {})) p.external[c] = ref;
    return;
  }

  // ── effects ───────────────────────────────────────────────────────────────
  if (isEvent(e, "effect.started")) {
    p.openEffects.add(e.payload.key);
    p.everStarted.add(e.payload.key);
    p.sortedOpenEffects = undefined;
    p.sortedStartedEffects = undefined;
    return;
  }
  if (isEvent(e, "effect.completed") || isEvent(e, "effect.failed")) {
    p.openEffects.delete(e.payload.key);
    p.sortedOpenEffects = undefined;
    return;
  }
  if (isEvent(e, "model.called")) {
    // THE TURN'S WHOLE BILL, counted where the call is recorded rather than where a later
    // summary claims it. Appended once per model turn, and the only place the engine
    // accumulates provider spend (`engine.ts` 3599 is its sole `addUsage`), so this arm and
    // that accumulator see the same dollars.
    chargeUsage(p, e.taskId, e.payload.usage);
    return;
  }
  if (isEvent(e, "subgraph.completed")) {
    // The child's own `model.called` rows are in the CHILD's journal, which this fold never
    // reads, so this is the parent's only view of that spend — and the engine charges the
    // parent's live budget from the same number (`engine.ts` 3918).
    chargeUsage(p, e.taskId, e.payload.usage);
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
      ...(e.payload.excludedApprovers === undefined ? {} : { excludedApprovers: e.payload.excludedApprovers }),
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
    // first one. This arm used to fold over ANY state, and a journal that reached it was
    // reachable from `src/`: `resolve` checked the gate at `p.seq` and then appended
    // through the RETRYING `log.append`, so two people answering the same open gate in the
    // same instant both landed and the LAST one won. A rejection overwritten by an approval
    // made against the same question is the whole defect; a gate a cancel had just closed
    // reading back `decided` is the same event one door over.
    //
    // `resolve` now commits at `p.seq` — the door that never retries — so the second writer
    // is refused instead of appended, and this arm no longer has a producer inside this
    // build. It stays because it still has two: a cancel that closes the gate first (the
    // door one over), and a store written by an older build, whose rows are already on disk
    // and are not migrated by fixing the writer. A rule that holds only for logs this
    // version produced is not a rule.
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

/**
 * Put a handle back where the executor took a value out.
 *
 * Pure and synchronous, like everything else in this file: it constructs the marker, it never
 * fetches what the marker points at. The two maps are disjoint by construction — a key in
 * `external` is absent from `values` — so this is a merge and not an override, and it is written
 * as one so a payload that broke that rule would be visible rather than silently winning.
 */
function withHandles(
  values: Readonly<Record<string, unknown>>,
  external: Readonly<Record<string, PayloadRef>> | undefined,
): Record<string, unknown> {
  if (external === undefined) return { ...values };
  const out: Record<string, unknown> = { ...values };
  for (const [channel, ref] of Object.entries(external)) out[channel] = payloadHandle(ref);
  return out;
}

/**
 * The projection a Task sees once its externalised reads have been fetched.
 *
 * THE OVERLAY GOES IN AT THE TASK'S OWN BRANCH, which is the last layer `stateAtBranch` applies,
 * so a resolved value wins over the shared channel AND over every binding on the path — the same
 * precedence a fan-out's item binding already has. Putting it in `channels` instead would leave
 * a binding shadowing the resolved value, and the node would be handed the handle after all.
 *
 * The resolved names leave `external` in the copy, because the copy is handed to code that asks
 * "is this channel a handle" and the honest answer for it is now no. The stored projection is
 * untouched: this returns a new object and folds nothing.
 */
export function withResolved(
  p: RunProjection,
  branch: BranchCoordinate,
  resolved: Readonly<Record<string, unknown>>,
): RunProjection {
  const key = encodeBranch(branch);
  const external = { ...p.external };
  for (const name of Object.keys(resolved)) delete external[name];
  return {
    ...p,
    external,
    bindings: { ...p.bindings, [key]: { ...(p.bindings[key] ?? {}), ...resolved } },
  };
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
