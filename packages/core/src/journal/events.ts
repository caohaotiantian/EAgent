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
import type { EdgeSpec, NodeSpec } from "../graph/spec.ts";
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

/**
 * The human arm of `Actor`, named because several boundaries accept ONLY a human.
 *
 * `deescalate` and an inbound gate callback both refuse anything else: an oversight
 * record that says `system` answers "who decided?" with "the software did", which is
 * the one answer an audit trail exists to make impossible.
 */
export type HumanActor = Extract<Actor, { readonly kind: "human" }>;

/**
 * The system arm of `Actor`, named because several doors accept only a person or a component.
 *
 * `Extract` rather than a restatement, so it cannot drift from the union it names.
 */
export type SystemActor = Extract<Actor, { readonly kind: "system" }>;

// Returns the NARROW type, not `Actor`. It is assignable to `Actor` everywhere it was already
// used, and it is what lets a door accept "a person or a component" without accepting an
// `agent` or an `evolution` actor by construction.
export const SYSTEM_ACTOR = (component: string): SystemActor => ({ kind: "system", component });

/**
 * The principal a run was submitted ON BEHALF OF — not the component that appended the row.
 *
 * IT IS PAYLOAD RATHER THAN ENVELOPE, and the split is deliberate. `run.submitted` is written
 * BY the control plane, so `actor: SYSTEM_ACTOR("control-plane")` is the true answer to "who
 * appended this"; the submitter is a fact ABOUT the run, the same shape `gate.raised.approvers`
 * has for the same reason. A cancel is the other way round — the caller causes the event
 * directly — so that one is journaled on the envelope, and `projection.ts`'s `gate.decided`
 * arm is the precedent.
 *
 * IT IS NOT AN `Actor`. `Actor`'s human arm REQUIRES `via`, a channel a `service` principal
 * has none of, and `SYSTEM_ACTOR` is single-arg so it cannot carry `method` either. Recording
 * a service submitter on the envelope would mean widening `Actor` for one caller.
 *
 * The three fields are the ones that IDENTIFY. `AuthContext` also carries `via`, `mfa` and
 * `onBehalfOf`, which describe the request rather than name the principal.
 *
 * ABSENT IS A REAL ANSWER and means "nobody was recorded" — a journal written before this
 * field existed, or an embedder calling `Engine.submit` with no principal to name. It is NOT
 * a synthetic subject: `(unowned)` would be a name that matches nothing and reads like one
 * that does.
 */
export interface SubmittedBy {
  readonly kind: "human" | "service";
  /** Compared exactly against a human actor's `subject`, like an approvers entry. */
  readonly subject: string;
  /** How identity was established — an `IdentitySource` name, or `shared-token`. */
  readonly method: string;
}

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
    /**
     * WHO this run was submitted for. Absent means nobody was recorded — see `SubmittedBy`.
     *
     * Optional because every journal written before this field existed lacks it, and a
     * required field would make those journals unfoldable. The fold decides on the FIRST
     * `run.submitted` it sees — including deciding "nobody" — so a second one cannot rewrite
     * an owner a read model has already answered with. The read model that will depend on
     * that is the `run_head` owner column, which is NOT built yet.
     */
    readonly submittedBy?: SubmittedBy;
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
  /**
   * THE FENCING TOKEN IS THIS EVENT'S OWN `seq`, which is why the payload does not carry one.
   *
   * It used to, and the number was a per-process counter — so the journal recorded one value
   * while `task_fence.max_token` compared another, and `TaskRecord.lease.fencingToken` folded
   * the one nobody enforced. A counter cannot fence across processes anyway: a second worker
   * starts at 1 and loses to the first's 3. The store's seq is the only monotonic number every
   * process already shares, so the lease's own seq is the token, and the fold reads `e.seq`.
   */
  "task.leased": { readonly workerId: string; readonly attempt: number };
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
  /**
   * A fan-out's PLANNED width, recorded once when the edge activates.
   *
   * Branch Tasks are then materialised in bounded waves, so a 500-way fan-out costs
   * O(maxParallelism) rows in flight rather than O(maxWidth). The join needs this
   * because it can no longer infer the width from "how many sibling Tasks exist".
   */
  "fanout.planned": {
    readonly edgeId: string;
    readonly parentBranch: string;
    readonly nodeId: NodeId;
    readonly width: number;
  };
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
  /**
   * `kind` must agree with the kind inside `key`. Two of the four sites did not.
   *
   * `effectKey(task, kind, ordinal)` builds `${task}:${kind}:${ordinal}`, and this union is
   * what the event declares. They were separate lists that drifted: the subgraph effect
   * keyed `subgraph` and declared `mailbox`, and the summariser keyed `summarize` and
   * declared `model` — not by choice but because neither word was in this union, so the
   * honest value would not typecheck. The consequence is not cosmetic: an auditor filtering
   * `effect.started` by `kind` cannot find a single summarisation, and the telemetry span
   * for a subgraph is named after a mailbox.
   *
   * `clock` and `random` remain declared and unappended — see CLAUDE.md invariant 4, which
   * says so — and are kept here rather than removed because removing them would hide a gap
   * that is better left visible.
   */
  "effect.started": {
    readonly key: string;
    readonly kind: "model" | "tool" | "subgraph" | "summarize" | "clock" | "random" | "mailbox";
    readonly attempt: number;
  };
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
    /**
     * The argument TYPE SHAPE — `{pod:string,tail:number}`, never the values.
     *
     * Recorded at emit rather than derived later, because the arguments are not in the
     * journal anywhere else and adding them would make every journal a copy of the
     * production data the tools were called with.
     */
    readonly argsShape: string;
  };

  // ── oversight ────────────────────────────────────────────────────────────
  /**
   * A gate exists, and the run behind it is suspended.
   *
   * Carries the AUTHORIZATION metadata, not merely the gate's identity. Who may decide,
   * which channels an `edit` may write, and when the SLA runs out are the facts a
   * decision is checked against — so they have to outlive the process that raised the
   * gate. A broker that keeps its approvers in a `Map` enforces nothing after a
   * restart, and the failure is silent in the worst way: an empty list that was
   * FORGOTTEN is indistinguishable from a gate that deliberately named nobody, so the
   * check reads as "unrestricted" and waves the stranger through.
   *
   * The rendered `payload` deliberately stays out. It is large, it is re-derivable from
   * the pinned prompt and the projection, and `contentDigest` already pins what the
   * approver was shown — which is the part an audit needs.
   */
  "gate.raised": {
    readonly gateId: GateId;
    readonly nodeId: NodeId;
    readonly policyRef: string;
    readonly contentDigest: string;
    /**
     * WHO may decide, as opaque subject ids compared exactly against a human actor's
     * `subject`. ABSENT means the gate named nobody, which stays permissive; an empty
     * list means the same. The distinction that matters is absent-because-nobody-was
     * -named versus absent-because-the-record-could-not-be-read, and the second is not
     * expressible here: a gate whose `gate.raised` cannot be folded has no record at
     * all, so every reader refuses it as unknown rather than as unrestricted.
     */
    readonly approvers?: readonly string[];
    /**
     * WHO MAY NOT DECIDE THIS GATE, however else they qualify — D7.2's `separationOfDuties`,
     * RESOLVED at raise rather than evaluated at decide.
     *
     * It journals the DECISION, not its inputs, which is the same choice `approvers` makes
     * and for the same reason: `#authorize` reads the fold of this event and nothing else, so
     * an exclusion computed later from run state would be an authorization input that can be
     * silently empty. Resolved once, from the run's recorded initiator, and durable — a
     * restart cannot lose it and a replay reproduces it.
     *
     * ABSENT means the gate declared no such rule. It is never `[]`: a graph that asks for
     * separation of duties on a run whose initiator is unknown, synthetic, or not a person is
     * REFUSED at raise rather than raised with an exclusion nobody can match, because a gate
     * that reads as supervised and enforces nothing is the failure the whole block exists to
     * prevent.
     */
    readonly excludedApprovers?: readonly string[];
    /** Channels an `edit` may write. Absent = unconstrained; `[]` = none at all. */
    readonly allowEdit?: readonly string[];
    /**
     * An ABSOLUTE timestamp, not a duration from whenever a process happened to
     * restart. Recomputing `now() + slaMs` on rehydrate silently grants an extension
     * every deploy, which is how an SLA becomes decorative.
     */
    readonly deadline?: number;
    readonly slaMs?: number;
    readonly onTimeout?: "escalate" | "default_action" | "fail";
    /**
     * THE GATE IN ANOTHER RUN THIS ONE STANDS IN FOR, when it is a subgraph's mirror.
     *
     * A subgraph node asks the parent's approvers a question that belongs to the child,
     * so it inherits that child gate's approvers and later forwards the answer back. Both
     * halves used to re-derive their target as "the first open gate in the child", from
     * two independent lookups — so answering ANY unrestricted child gate in between moved
     * a restricted one under a mirror that had inherited nothing, and the executor
     * approved it as a system actor. Nothing in memory can bind them: the process that
     * raised the mirror is not necessarily the process that forwards it.
     *
     * Absent for every gate that is not a mirror, which is nearly all of them. The child
     * RUN is not repeated here — it is derived from the Task and journaled once by
     * `subgraph.started` on the same `taskId`; only WHICH GATE was ever ambiguous.
     */
    readonly mirrorOf?: GateId;
    /**
     * THE BATCH THIS GATE JOINED, when its node declared `batching` (D7.9 row 2).
     *
     * Journaled rather than remembered for the reason `approvers` is: one decision on a
     * batch closes every member, so "which gates would this click close?" is an
     * authorization question, and a grouping held in a broker's memory is empty in the
     * process that answers the gate. `id` is the gateId of the batch's FIRST member,
     * which is derived rather than minted — a batch is not a thing with its own identity,
     * it is the gate the others merged into.
     *
     * Absent for every gate that declared no batching, and for one that declared it and
     * could not merge: membership is refused unless the newcomer and every existing
     * member agree on `policyRef`, `approvers` and `allowEdit`, so a gate that disagrees
     * starts its own batch and carries `{id: itsOwnGateId}`.
     *
     * THE GOVERNANCE FIELDS BELOW ARE THE BATCH'S OWN POLICY, AND THEY ARE HERE FOR THE
     * SAME REASON `approvers` IS. `maxBatch` is the cap on how many questions one click
     * closes — D7.9 row 2's whole safety argument — and it used to be read off the
     * BatchingSpec of whichever gate was joining, which is a bound a newcomer could raise.
     * A batch founded under `maxBatch: 2` grew to ten members the moment a gate declaring
     * `maxBatch: 20` arrived; the same held for `windowMs`, where a joiner's longer window
     * kept a batch open a hundred times past the one it was founded under. Neither move was
     * recorded anywhere, because nothing but the joining request ever carried the numbers.
     * They are journaled per member so a batch's governance is a fact in the log, readable
     * by any process, and so that "may this gate join?" is answered against the BATCH
     * rather than against the applicant.
     *
     * `deliveryDigest` is the digest of the founder's `DeliverySpec`, absent when it
     * declared none. A digest rather than the route itself: what a merge needs is
     * EQUALITY, and equality is all a digest discloses — the recipients and the redact
     * list stay out of the log, as they always have.
     *
     * All three are optional because a journal written before they existed does not carry
     * them, and the fail-closed reading of a batch with no journaled governance is that
     * nothing may join it. See `batchGovernance` in `run/gates.ts`.
     */
    readonly batch?: {
      readonly id: GateId;
      readonly key: string;
      readonly windowMs?: number;
      readonly maxBatch?: number;
      readonly deliveryDigest?: string;
    };
  };
  "gate.delivered": { readonly gateId: GateId; readonly channel: string; readonly receipt: string };
  /**
   * A channel failed.
   *
   * Journaled per channel, and never fatal: delivery failure is a NOTIFICATION problem,
   * not an authorization one. The gate stays open either way — this exists so that
   * "why did nobody see this?" has an answer.
   */
  "gate.delivery_failed": {
    readonly gateId: GateId;
    readonly channel: string;
    readonly error: string;
    readonly tier: number;
    /** True when no channel succeeded and the console queue caught it. */
    readonly fellBack: boolean;
  };
  "gate.decided": {
    readonly gateId: GateId;
    readonly decision: "approve" | "reject" | "edit" | "redirect";
    readonly writes?: Readonly<Record<string, unknown>>;
    readonly take?: readonly string[];
    readonly justification?: string;
    readonly latencyMs: number;
  };
  /**
   * An inbound channel callback was REFUSED, and the gate stayed open.
   *
   * The endpoint that receives one is unauthenticated by construction — a Slack button
   * click carries no bearer token, so the signature is the whole of its authentication.
   * Without this event a forged approval attempt leaves no trace anywhere: the gate is
   * still open, which looks exactly like nobody having clicked yet.
   *
   * `reason` is a FIXED TOKEN, never bytes the caller sent. An audit row an attacker
   * can write prose into is a log-injection primitive, not evidence — and this row is
   * reachable without credentials, so it is the one payload in the vocabulary that an
   * unauthenticated stranger can cause. `gateId` is absent whenever the callback was
   * refused before its body was trusted enough to parse, which is most of the time.
   */
  "gate.callback_rejected": {
    readonly channel: string;
    readonly reason: string;
    readonly gateId?: GateId;
  };
  /**
   * ONE DECISION CLOSED THESE GATES — the audit record for D7.9 row 2.
   *
   * Written in the SAME append as the `gate.decided` rows it accounts for, and it exists
   * because those rows alone do not say what the approver was answering. "Approved"
   * without "approved WHAT" is the failure the oversight layer exists to prevent, and a
   * batch is exactly where it would appear: twenty identical-looking decisions, one
   * click, and nothing anywhere recording that they were one click.
   *
   * `gateIds` is the complete member list in journal order, so a reader reconstructs
   * precisely which gates one decision closed without inferring it from a seq range.
   * `manifestDigest` is the D7.3 `contentDigest` question asked of a batch — what did the
   * approver actually SEE? — and the answer is the manifest, so it digests the ordered
   * `{gateId, nodeId, contentDigest}` list rather than any one payload. It is over
   * JOURNALED fields only, so an auditor re-derives it months later from the log alone.
   *
   * It changes no state and is folded by nothing: the `gate.decided` rows beside it do
   * all of that, exactly as `gate.delivered` is a receipt rather than a transition.
   */
  "gate.batch_decided": {
    readonly batchId: GateId;
    readonly key: string;
    readonly gateIds: readonly GateId[];
    readonly manifestDigest: string;
    readonly decision: "approve" | "reject";
  };
  /**
   * A GATE INHERITED A DECISION ALREADY GIVEN TO AN IDENTICAL ONE — D7.9 row 3.
   *
   * Written in the same append as the `gate.raised` it explains and the `gate.decided` it
   * licenses. Without it the journal would show a gate raised and decided in one instant
   * by a system actor, with nothing saying WHERE the decision came from — which is the
   * shape of a bypass, whether or not it is one.
   *
   * `ofGateId` is the whole audit trail: follow it to that gate's own `gate.decided` and
   * the actor who made the decision is right there, checked at the time against an
   * approvers list this gate is required to match exactly. Repeating the human here would
   * be a second copy of a fact the journal already holds, and the copy is the one that
   * would drift.
   */
  "gate.deduped": {
    readonly gateId: GateId;
    readonly ofGateId: GateId;
    /** The journaled digest both gates carry. Equal by construction; recorded so a reader need not join two rows to see why. */
    readonly contentDigest: string;
    readonly decision: "approve" | "reject" | "edit" | "redirect";
  };
  "gate.timeout": { readonly gateId: GateId; readonly action: "escalate" | "default_action" | "fail" };
  /**
   * The SLA lapsed and the gate moved to the next tier.
   *
   * `deadline` is the RESET clock, absolute, for the same reason `gate.raised` carries
   * one: an escalation that only exists in memory means a restart mid-chain either
   * loses the tier or re-runs it from zero.
   */
  "gate.escalated": { readonly gateId: GateId; readonly tier: number; readonly to: string; readonly deadline?: number };
  /**
   * SOMEBODY WAS NUDGED, AND NOTHING ELSE HAPPENED — D7.2's `reminders`.
   *
   * It is durable for the reason `gate.delivered` is, plus one this event has to itself.
   * The receipt half is the same: "why did nobody answer?" is the question the delivery
   * journal exists for, and an un-journaled nudge means the answer stops at "they were
   * told once", which is a different story from "they were told three times".
   *
   * The half that is this event's own is that the FOLD READS IT. It is the only record of
   * how many of the declared reminders have gone out, and without it the sweep re-asks
   * "is the first reminder due?" on every tick forever — the schedule lives in a broker's
   * memory, which is empty in the process that restarts, so a counter held there would
   * reset a whole schedule on every deploy. `remindersSent` is folded from these rows, one
   * per row, so it is a COUNT of what the log says was sent rather than of what a process
   * remembers doing.
   *
   * IT MOVES NO CLOCK. `gate.escalated` resets a deadline and burns a tier; this resets
   * nothing, which is the whole difference between a reminder and an escalation. `tier` is
   * recorded because it says WHO was nudged — the recipients of the tier the gate was on —
   * not because anything folds it. `nth` is which entry of the declared schedule fired, so
   * an auditor can line the rows up against the graph without counting them.
   */
  "gate.reminded": { readonly gateId: GateId; readonly tier: number; readonly nth: number };
  /**
   * AN APPROVER IS LOOKING AT THIS GATE, AND NOTHING ELSE IS TRUE — D7.3's `Claimed`.
   *
   * A coordination hint between approvers, journaled so that it is a fact about the LOG
   * rather than about whichever process happens to be holding a console: two approvers on
   * two replicas read the same claim, and a broker that restarts has not forgotten it. A
   * lock held in memory is no lock at all in the process that did not take it, which is the
   * same argument `gate.reminded` makes about a counter.
   *
   * IT GRANTS NOTHING AND IT BLOCKS NOTHING. Nothing on the decision path reads it —
   * `resolve`, `resolveBatch` and `#fireTimeout` never mention a claim — so this row cannot
   * delay, block or authorize a decision. See `HumanGateBroker.claim`, which states the
   * whole contract; the fold keeps `GateRecord.claimedBy`/`claimedUntil` and the only
   * readers of those are `liveClaim` and `claimHolder`, both serving `claim` itself.
   *
   * `until` is ABSOLUTE, for the reason `gate.raised.deadline` and `gate.escalated.deadline`
   * are: a duration would be re-based on `now()` by every process that rehydrated it, which
   * silently extends the exact thing the TTL exists to bound.
   *
   * WHO IS THE EVENT'S ACTOR, and there is no subject in this payload. Attribution is a
   * property of the append, checked at the door that wrote it — the same rule
   * `GateRecord.decidedBy` states for `gate.decided` — and a second copy inside the payload
   * is a second thing to keep in step. The fold reads `actor.subject`, and only from a
   * `human` actor: `claim` admits no other kind, because "the clock is reading this gate" is
   * not a fact and would tell the people who must look that they need not.
   *
   * THERE IS NO `gate.claim_expired`, AND THERE MUST NOT BE. A claim expires by being
   * IGNORED — every reader compares its own clock against this absolute instant — so there
   * is no state to reap and no sweeper to run. A row whose only content is that time passed
   * would be a durable fact nobody could observe the absence of.
   */
  "gate.claimed": { readonly gateId: GateId; readonly until: number };
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
  /**
   * `rule` is the bare `EscalationRuleId`. `detail` is the evidence, SEPARATE.
   *
   * They used to be one string — `#escalate` did `` `${id} ${JSON.stringify(detail)}` `` — so the
   * journaled value of E6 was `violation {"capability":{...}}` and every consumer matching by
   * rule id compared against something that could never equal it. `evolution/trajectory.ts`'s
   * `e.payload.rule === "violation"` was dead for the whole life of the mechanism, and seven of
   * the eight firing sites pass a detail, so it was dead for seven of the eight rules.
   */
  "policy.escalated": {
    readonly rule: string;
    readonly detail?: Record<string, unknown>;
    readonly from: Posture;
    readonly to: Posture;
    readonly scope: string;
  };
  "policy.deescalated": { readonly from: Posture; readonly to: Posture; readonly scope: string; readonly justification: string };

  // ── budget ───────────────────────────────────────────────────────────────
  "budget.reserved": { readonly scope: string; readonly amountUsd: number; readonly remainingUsd: number; readonly warn: boolean };
  "budget.settled": { readonly scope: string; readonly reservedUsd: number; readonly actualUsd: number };
  "budget.exhausted": { readonly scope: string; readonly limitUsd: number; readonly action: string };

  // ── graph + checkpoints ──────────────────────────────────────────────────
  /**
   * A run adopted a successor graph.
   *
   * Carries the FULL added specs, not just their ids. The journal is the sole durable
   * truth, so a process that restarts and re-attaches the authored graph must be able
   * to rebuild the mutated one from events alone — ids would not be enough.
   */
  "graph.mutated": {
    readonly parentHash: string;
    readonly newHash: string;
    readonly addedNodes: readonly NodeId[];
    readonly addedEdges: readonly string[];
    readonly nodes: readonly NodeSpec[];
    readonly edges: readonly EdgeSpec[];
    readonly proposedBy: TaskId;
    readonly proposedByNode: NodeId;
    readonly budgetConsumed: number;
  };
  /**
   * A `subgraph` node started a CHILD RUN.
   *
   * The child has its own journal, its own gates, and its own replayable history. This
   * event is the only link between them, which is what keeps a parent's journal the size
   * of the parent rather than of its whole tree.
   */
  "subgraph.started": {
    readonly childRunId: RunId;
    readonly ref: string;
    readonly graphHash: string;
    /** The slice carved from the parent's REMAINING budget, or null when unbounded. */
    readonly budgetUsd: number | null;
  };
  "subgraph.completed": {
    readonly childRunId: RunId;
    readonly ref: string;
    readonly status: string;
    readonly usage: UsageRecord;
    readonly outputs: readonly string[];
  };
  /**
   * `atSeq` IS A REWIND TARGET, not this event's own seq. Measured: the event lands at seq
   * 9 and `atSeq` says 8.
   *
   * That is deliberate and it is the useful number, but nothing said so, which made it read
   * like an off-by-one. `rewind(runId, atSeq)` suppresses `(atSeq, marker)` EXCLUSIVE at
   * both ends, so passing this value recovers the state the checkpoint captured — the last
   * event before it. Passing the checkpoint's own seq would keep the checkpoint and
   * everything the same append wrote after it, which is not what a checkpoint is for.
   *
   * Pinned by a test rather than left to this comment, because the arithmetic
   * (`p.seq + events.length`, evaluated before the activation events are pushed) is the
   * kind that a later edit silently changes.
   */
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
  "task.failed", "task.skipped", "task.cancelled", "task.retry_scheduled", "action.pending", "fanout.planned",
  "state.reduced", "channel.written",
  "effect.started", "effect.completed", "effect.failed", "model.called", "tool.called",
  "gate.raised", "gate.delivered", "gate.delivery_failed", "gate.callback_rejected",
  "gate.decided", "gate.batch_decided", "gate.deduped", "gate.timeout", "gate.escalated", "gate.reminded",
  "gate.claimed", "gate.cancelled",
  "policy.decided", "policy.escalated", "policy.deescalated",
  "budget.reserved", "budget.settled", "budget.exhausted",
  "graph.mutated", "subgraph.started", "subgraph.completed", "checkpoint.created", "checkpoint.restored",
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
