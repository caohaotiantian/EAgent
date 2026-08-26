/**
 * Durable human gates.
 *
 * The single largest departure from EAgent, where an approval was a `Promise` held
 * by a running turn (`UI.confirm`). That promise could not survive a restart, could
 * not be routed anywhere, could not time out with a default action, and pinned the
 * agent's memory for its whole lifetime.
 *
 * Here a gate is a row plus a journal event. `raise` returns as soon as the gate is
 * PERSISTED — it does not wait for the human — and the Run suspends, releasing its
 * worker slot. So "how many gates can be open at once" is a database question, not a
 * concurrency question: ten thousand open gates cost ten thousand rows.
 *
 * The second rule this file is arranged around, learned the hard way:
 *
 * > **AUTHORIZATION IS READ FROM THE JOURNAL, NEVER FROM THIS BROKER'S MEMORY.**
 *
 * Approvers and the `allowEdit` allow-list used to live in an in-process `Map`. That
 * made every authorization check a no-op in any process that had not itself raised the
 * gate: the list came back empty, and "empty" was read as "the gate named nobody", so
 * a restart turned a restricted gate into an open one. Everything a decision is CHECKED
 * against is now folded out of `gate.raised`; the `Map` keeps only the rendered payload
 * and the delivery route, neither of which can authorize anything.
 *
 */

import { digest } from "../canonical.ts";
import { CODES, err, toLoomError } from "../errors.ts";
import { gateDecisionOf, type GateDecision, type GateDecisionKind } from "../vocab.ts";
import type { BatchingSpec, DedupeSpec } from "../graph/spec.ts";
import { newGateId, type GateId, type NodeId, type RunId, type Seq, type TaskId } from "../ids.ts";
import { SYSTEM_ACTOR, type Actor, type JournalEvent, type NewEvent } from "../journal/events.ts";
import type { StateStore } from "../journal/store.ts";
import type { EventBus } from "../bus.ts";
import { GateDispatcher, formatRecipients, nextTier, tierRecipients, type DeliverySpec } from "./delivery.ts";
import { RunFolder, foldRun, gateOf, isTerminal, openGates, type GateRecord, type RunProjection } from "./projection.ts";
import { RunLog } from "./log.ts";

export type TimeoutAction = "escalate" | "default_action" | "fail";

export interface GateRequest {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly nodeId: NodeId;
  readonly policyRef: string;
  /** Rendered server-side, so `contentDigest` pins what the approver actually saw. */
  readonly payload: unknown;
  /**
   * The half of `payload` an approval BINDS — what `contentDigest` is taken over when it is
   * supplied, and what a re-derivation at dispatch time is compared against.
   *
   * IT EXISTS BECAUSE A PAYLOAD CAN CARRY TELEMETRY. The engine's gate payload includes
   * `costSoFarUsd`, which is the run's cumulative spend and moves whenever any sibling
   * commits: measured on a real Engine, a gate raised alongside one agent turn was shown
   * `costSoFarUsd: 0` while the projection a dispatch re-derives from had already reached
   * `0.000027`. `digest(payload)` therefore cannot be recomputed later, so a check built on
   * it would refuse legitimate approvals — and a fail-closed check that fires on noise is a
   * denial of service on the oversight path rather than a guard on it.
   *
   * So the caller says which part is the question and which part is the ticker. Whatever it
   * names must be a pure function of graph, node, Task and channel state, or the check it
   * enables cannot survive the restart invariant 1 requires it to survive.
   *
   * Omitted means the whole payload binds, which is right for any caller whose payload is
   * already re-derivable, and is what every embedder driving the broker by hand gets.
   */
  readonly binding?: unknown;
  readonly approvers?: readonly string[];
  /**
   * Subjects barred from deciding this gate whatever else admits them — `gate.raised`'s
   * `excludedApprovers`, already resolved. Authorization, so it is journaled.
   */
  readonly excludedApprovers?: readonly string[];
  readonly slaMs?: number;
  readonly onTimeout?: TimeoutAction;
  /** Only permissible when the action is read_only or reversible_write (GRAPH014). */
  readonly defaultAction?: GateDecision;
  /** Channels an `edit` decision may write. Anything else is rejected. */
  readonly allowEdit?: readonly string[];
  /** How this gate reaches a human, and who it escalates to when nobody answers. */
  readonly delivery?: DeliverySpec;
  /**
   * When to NUDGE the people who already have this gate — D7.2's `reminders`.
   *
   * Same tier, same recipients, same channels; only the instant is new, which is why it is
   * declared on `GateSlaSpec` (the clock) rather than on `DeliverySpec` (the route). Each
   * `afterMs` is measured from the journaled raise. Not authorization and not a deadline:
   * `gate.reminded` folds into a counter and moves no clock at all.
   */
  readonly reminders?: readonly { readonly afterMs: number }[];
  /**
   * The gate in another run this one stands in for — a subgraph's mirror, and nothing
   * else. Journaled, because the decision it binds is forwarded by whichever process
   * happens to pick the Task up next. See `gate.raised.mirrorOf`.
   */
  readonly mirrorOf?: GateId;
  /**
   * Whether this gate may MERGE with its siblings into one question — D7.9 row 2.
   *
   * Not authorization, and that is why it is here rather than in the journaled half's
   * mind: what it decides is which gates one click closes, and THAT is journaled, on
   * `gate.raised.batch`. This field only says whether the broker may look for a batch to
   * join when the gate is raised.
   */
  readonly batching?: BatchingSpec;
  /**
   * Whether an identical question already answered may answer this one — D7.9 row 3.
   *
   * Also not authorization: every fact the inheritance is checked against — the digest,
   * the node, the policy, the approvers, the allow-list — is read out of the FOLD of the
   * source gate's own `gate.raised`, never out of this request or this broker's memory.
   */
  readonly dedupe?: DedupeSpec;
}

/**
 * A set of gates that ONE decision closes — D7.9 row 2, as it is actually built.
 *
 * IT IS NOT A GATE. D7.9 says N gates "merge into one gate showing a manifest of N
 * items", and one durable gate covering N Tasks is the shape this deliberately does not
 * take, for three reasons that all point the same way:
 *
 *   - every authorization fact is folded PER GATE out of its own `gate.raised`, so a
 *     single merged record either loses the per-member facts or duplicates them, and the
 *     moment two members disagree it cannot represent them at all;
 *   - `gate.decided` returns exactly one Task to `ready`, so one merged decision would
 *     need a second fold rule for "a Task becomes runnable" — a second path to the thing
 *     invariant 6 exists to keep single;
 *   - the SLA sweep, replay, and the trace are all per gate, and none of them had to
 *     change for this.
 *
 * So the members stay N gates, each with its own record, clock and span, and the batch is
 * how they are PRESENTED and DECIDED: one manifest, one click, one append, N
 * `gate.decided` rows and one `gate.batch_decided` saying they were one decision. From
 * the approver's side that is the merged gate D7.9 asks for; from the journal's side
 * nothing was merged, which is the half that has to stay reconstructable.
 */
export interface GateBatch {
  /** The gateId of the batch's FIRST member. A batch has no identity of its own. */
  readonly batchId: GateId;
  readonly key: string;
  /** The OPEN members, in journal order. Exactly what one decision would close. */
  readonly members: readonly GateSummary[];
  /**
   * What the approver is being shown, pinned — D7.3's `contentDigest` question asked of a
   * batch. Echo it back through `ResolveBatchInput.expectManifest`: if a member has since
   * joined, been decided, expired or been cancelled, this digest has moved and the
   * decision is refused rather than applied to a list nobody read.
   */
  readonly manifestDigest: string;
  /**
   * The EARLIEST deadline among the members, or `undefined` if none has one.
   *
   * The earliest, because it is the instant at which this batch stops being answerable as
   * a whole: the first member to breach leaves the batch — it escalates on its own tier
   * or expires and fails the run — and every later reading of `manifestDigest` differs
   * from the one the approver was shown. Presenting the latest would be presenting a
   * deadline no member actually has, which is the same overreach as a merged record.
   * Each member keeps its own clock in the journal; `GateSweeper` is untouched by
   * batching and sweeps them one at a time exactly as it always did.
   */
  readonly deadline: number | undefined;
  /** Equal across every member by construction — membership is refused otherwise. */
  readonly approvers: readonly string[];
}

export interface ResolveBatchInput {
  readonly batchId: GateId;
  /**
   * `approve` or `reject`. `edit` and `redirect` are refused, for the reason a mirror
   * refuses them: their meaning is not the same for every member. An `edit` writes one
   * value set into every branch, silently replacing what each branch computed; a
   * `redirect` names edges that belong to a node, and a batch may span two. Both are
   * still available per gate through `resolve`.
   */
  readonly decision: GateDecision;
  readonly actor: Actor;
  readonly idempotencyKey: string;
  /** `GateBatch.manifestDigest`, as it was when the approver read it. */
  readonly expectManifest: string;
}

export interface GateSummary extends GateRecord {
  readonly runId: RunId;
  readonly payload: unknown;
  readonly slaMs: number | undefined;
  readonly deadline: number | undefined;
  readonly onTimeout: TimeoutAction;
  readonly approvers: readonly string[];
  readonly allowEdit: readonly string[] | undefined;
  /** Which escalation tier this gate is currently on. 0 is the original delivery. */
  readonly tier: number;
}

export interface ResolveInput {
  readonly gateId: GateId;
  readonly decision: GateDecision;
  readonly actor: Actor;
  readonly idempotencyKey: string;
}

export interface GateBrokerOptions {
  readonly now?: () => number;
  /**
   * Delivers gates and escalations.
   *
   * OPTIONAL, and its absence is a real configuration: a broker with no dispatcher
   * raises durable gates that only the console and the HTTP API surface. That is a
   * usable mode, not a broken one — but the SLA sweep still runs, so an unanswered gate
   * still escalates and still expires.
   */
  readonly dispatcher?: GateDispatcher;
}

/**
 * The half of a gate that is NOT authoritative and NOT authorization.
 *
 * A separate type rather than "the request, minus some fields", so that reading an
 * approvers list out of the broker's memory is a compile error rather than a habit
 * someone has to remember not to fall back into.
 *
 * `slaMs` sits closest to the line — a clock is not a permission, but it does decide
 * something — which is why it is fenced to a single case that the journal alone cannot
 * serve. Read its note before widening it.
 */
interface EphemeralGate {
  /**
   * What the human is shown. Re-derivable; `contentDigest` pins what they saw.
   *
   * OPTIONAL, because it is dropped when the gate closes while the rest of this record stays.
   * See `#releasePayload`: the bytes are here, the BEHAVIOUR is in the fields below it, and a
   * gate that reopens needs the second without the first.
   */
  readonly payload?: unknown;
  /** Where to send it. A notification route, never a permission. */
  readonly delivery?: DeliverySpec;
  /**
   * WHEN TO NUDGE, as validated offsets from the journaled raise, strictly ascending.
   *
   * Ephemeral for the same reason the route is — it decides nothing a decision is checked
   * against — and it has the same consequence: a process that did not raise the gate sends
   * no reminders until `rehydrate` gives it the schedule, exactly as it delivers nothing
   * until `rehydrate` gives it the route. What is NOT ephemeral is how many nudges have
   * already gone out; that is folded from `gate.reminded`, so a fresh process cannot resend
   * a reminder the log says was sent.
   */
  readonly reminders?: readonly number[];
  /**
   * The pre-authorized timeout decision.
   *
   * Not journaled: losing it fails a timing-out gate CLOSED (it expires and the run
   * fails) rather than open, so durability buys nothing an audit needs while the
   * payload would carry a full `edit` write-set into every gate that declares one.
   */
  readonly defaultAction?: GateDecision;
  /**
   * A LAST-RESORT clock, consulted only when the journal has neither a deadline nor an
   * SLA of its own.
   *
   * Which is to say: only for a gate raised before either was journaled. Those gates
   * hang open forever with their run suspended, and the sweep reads nothing but the
   * journal — so without a way in, the fail-closed direction is unreachable for them.
   *
   * It cannot extend anything, and that is deliberate. The deadline it produces is
   * `raisedAtTs + slaMs`, measured from the JOURNALED raise, so re-supplying it on every
   * deploy yields the same instant every time. Recomputing `now() + slaMs` is exactly the
   * defect this file was rewritten to remove.
   */
  readonly slaMs?: number;
}

/**
 * In-process gate broker over the journal.
 *
 * Its non-durable state is deliberately minimal — and, since the authorization defect,
 * deliberately typed so that it CANNOT hold anything a decision is checked AGAINST.
 * Everything that decides whether a run may proceed lives in the journal, so a restart
 * loses nothing a human cares about. The memory holds what a human READS, where to send
 * it, a pre-authorized default decision, and a last-resort SLA for gates written before
 * the deadline was journaled — no approvers, no allow-list, ever.
 */
export class HumanGateBroker {
  readonly #now: () => number;
  /** gateId → the non-durable half. Empty in a process that did not raise the gate. */
  readonly #ephemeral = new Map<GateId, EphemeralGate>();
  /** `(gateId, approverId)` → decision, so a double-click collapses to one decision. */
  readonly #idempotency = new Map<string, GateDecisionKind>();
  readonly #dispatcher: GateDispatcher | undefined;

  constructor(opts: GateBrokerOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#dispatcher = opts.dispatcher;
  }

  /**
   * Drop the PAYLOAD of a gate that has closed, and keep everything else.
   *
   * Measured before this existed: 6000 gates carrying a 4 KiB payload each retained ~24 MiB in
   * `#ephemeral` for the life of the process, and nothing ever removed anything. The journal is
   * correctly not where that lives — `gate.raised` carries `contentDigest`, not the payload — so
   * this map is the only holder and a long-lived `loom serve` grew without bound.
   *
   * THE PAYLOAD IS WHERE THE BYTES ARE AND THE OTHER FIELDS ARE WHERE THE BEHAVIOUR IS, which is
   * why the split is here and not at the entry. `delivery`, `defaultAction`, `slaMs` and
   * `reminders` are small config; the payload is whatever a node rendered for a human and can be
   * model-sized. Dropping the entry whole reclaims nothing extra worth having and costs the
   * gate's future.
   *
   * A CLOSED GATE IS NOT A PERMANENTLY CLOSED GATE — this is the correction, and it was a real
   * regression before it was a docstring. `Engine.rewind` reopens a decided gate BY DESIGN, and
   * the engine's own refusals tell operators to do it ("rewind to `atSeq - 1` to ask again").
   * The `gate.raised` event survives, so the gate folds back to `open` with no re-raise and
   * nothing to repopulate this map. Deleting the entry therefore stripped a LIVE gate's
   * `DeliverySpec`, and `#fireTimeout` then took its `spec === undefined` arm: reproduced end to
   * end, a rewound gate declaring `onTimeout: "escalate"` with a tier left went from one page and
   * `gate.escalated` to zero pages, `gate.timeout`, `run.failed` and a journaled reason —
   * "exhausted its escalation chain with no decision" — that was false.
   *
   * That is verbatim the failure this file already names as the reason a sweep must use the
   * broker that raised the gate: "EXPIRES gates that should have escalated. Silently, and
   * fail-closed, which is the kind of wrong that gets discovered a quarter later." It is also
   * the failure a size cap was rejected for. Keeping the behavioural fields makes a reopened
   * gate behave exactly as it did, and costs only the rendered payload — which `#summaryOf`
   * already takes as possibly-absent, because a process that did not raise the gate never had it.
   */
  /**
   * Drop the payloads of gates the ENGINE is closing, which it does without going through here.
   *
   * `gate.cancelled` is written by `Engine` — an operator cancel, and a run that fails or
   * completes with a question still standing — so those gates closed with nothing releasing
   * their half. Every cancelled run leaked one payload per open gate, permanently.
   *
   * Called as the events are BUILT rather than after they land, and the cost of that is stated:
   * an append that loses its compare-and-swap will have dropped a payload for a gate that is
   * still open. That degrades the gate to exactly the state a RESTARTED process leaves it in —
   * route, SLA and default action intact, rendered payload absent — which every reader already
   * handles, because a process that did not raise the gate never had one. The alternative,
   * threading a post-append call through five sites, trades that for five chances to miss one.
   */
  releaseClosed(gateIds: readonly GateId[]): void {
    for (const id of gateIds) this.#releasePayload(id);
  }

  #releasePayload(gateId: GateId): void {
    const eph = this.#ephemeral.get(gateId);
    if (eph === undefined) return;
    const { payload: _dropped, ...keep } = eph;
    this.#ephemeral.set(gateId, keep);
  }

  /**
   * Persist the gate and suspend the run. Returns as soon as it is durable.
   *
   * The caller must NOT hold anything open waiting for this — that is the entire
   * point. The Task is re-leased later, by whichever worker picks it up after
   * `gate.decided`.
   */
  async raise(log: RunLog, req: GateRequest): Promise<GateId> {
    assertDefaultActionIsSatisfiable(req);

    // A RUN THAT HAS ENDED DOES NOT GET A NEW GATE.
    //
    // `resolve` learned to look at the run; this method never did. A cancel closes the
    // gates that are OPEN when it runs — it cannot close one that does not exist yet — so
    // a Task already in flight reached its gate after the run had ended, and the
    // `run.suspended` below carried the run back out of `cancelled` into `awaiting_gate`.
    // The same defect the cancel fix closed, reached from the other side of the same race:
    // a live question on a dead run, with the refused action reachable again by anyone who
    // answers it.
    //
    // `E_ILLEGAL_TRANSITION` rather than `E_GATE_ALREADY_RESOLVED`, because nothing here is
    // a repeat of a decision: it is a state machine refusing a move out of a final state.
    const p = await this.project(log);
    if (p !== undefined && isTerminal(p.status)) {
      throw err.conflict(
        CODES.E_ILLEGAL_TRANSITION,
        `run ${log.runId} is ${p.status}, so node "${req.nodeId}" cannot raise a gate on it`,
        { details: { runId: log.runId, nodeId: req.nodeId, runStatus: p.status } },
      );
    }

    const raisedAt = this.#now();
    const gateId = newGateId(raisedAt);
    const contentDigest = bindingDigestOf(req);
    // THE SAME `isPositiveWholeMs` `ephemeralOf` APPLIES, AND THIS IS THE SOURCE THAT
    // OUTRANKS IT. `#deadlineOf` reads the JOURNALED deadline first and an operator's
    // re-supplied SLA last, so guarding only the last one left the strongest source
    // unguarded: `raisedAt + NaN` is `NaN`, journaled as this gate's deadline forever, and
    // `now >= NaN` is false — a gate that can never expire, on a graph that declared a
    // clock. The compiler refuses every shape a GRAPH can declare, but `raise` is a public
    // method an embedder calls with no compiler behind it, exactly like `rehydrate`.
    //
    // Dropped rather than thrown, to match `ephemeralOf` and `usableReminders`: "this gate
    // has no clock" is a coherent state the rest of this file already handles, and a raise
    // that starts throwing is a behaviour change for every embedder rather than a fix.
    const usableSla = isPositiveWholeMs(req.slaMs) ? req.slaMs : undefined;
    const deadline = usableSla === undefined ? undefined : raisedAt + usableSla;

    // WHAT THE `gate.raised` BELOW WILL FOLD TO, built before it is written.
    //
    // Both saturation controls have to ask questions of this gate — "is it the same
    // question as that decided one?", "does it agree with that batch's authority?" —
    // and both must ask them of the RECORD, not of the request, because the gates they
    // are compared against are records. Deriving one shape from the other at each
    // comparison is how the two sides come to disagree about what `allowEdit: undefined`
    // means.
    const prospective = prospectiveRecord(req, gateId, contentDigest, raisedAt, deadline);

    // DEDUP IS ASKED FIRST, AND WINS, AND THE REASON IS `maxBatch`. A question that
    // already has an answer does not need a queue to be put in — and joining one COSTS
    // something, because `maxBatch` bounds how many questions ONE CLICK closes and counts
    // every member a batch has ever had. A gate decided in the same append that raises it
    // is a question nobody is ever asked, so spending a slot on it makes every later batch
    // smaller for nothing.
    //
    // MEASURED, because the reason written here before was not: it said batching such a
    // gate "would leave a decided member in an open batch's manifest", and no manifest can
    // ever show one — `listBatches` and `resolveBatch` both build theirs from
    // `gateBatchGroups(p, "open")`, which filters decided members out. The real cost is the
    // cap. Flipping this line with `maxBatch: 3` and one duplicate: the batch that holds
    // two open questions held ONE, and the two gates behind it were pushed into a second
    // batch — two clicks where there was one. Pinned by *A GATE ANSWERED IN THE APPEND THAT
    // RAISED IT DOES NOT SPEND A SLOT IN maxBatch*.
    //
    // Both take the projection as `RunProjection | undefined` rather than being skipped
    // when there is none, and that is not tidiness: an EMPTY journal has no projection,
    // and skipping meant the very first gate of a run started no batch — so the second
    // one found nothing to join and started one instead, and a five-gate fan-out came
    // back as one unbatched gate plus a batch of four. Reproduced before the fix; the
    // graph path never showed it, because `run.submitted` is always there first.
    const inherited = this.#inheritable(p, prospective, req, raisedAt);
    const batch = inherited !== undefined ? undefined : batchFor(p, prospective, req, raisedAt);

    this.#ephemeral.set(gateId, ephemeralOf(req));

    // ONE append: the gate and the suspension are a single durable fact. A crash
    // between them would otherwise leave a run that is neither running nor gated.
    //
    // The authorization fields ride ALONG with it, in the same append, for the same
    // reason: a gate whose approvers land a moment later is a gate with a window in
    // which it is unrestricted.
    //
    // AND IT IS A `commit`, NOT AN `append`. This was the one commit path in the system
    // still using the retrying `append`, and the answer to "why" is that nothing here used
    // to be conditional — it was appending a fact. The terminal check above makes it a
    // decision made AT `p.seq`, and `append` retries a conflict by re-reading the head,
    // which is exactly how a check passes and the write that follows it lands on a journal
    // that has since moved. `commit` refuses instead, and the caller re-reads. An empty
    // journal has no head, so `0` is the seq a first append expects.
    // AN EMPTY EXCLUSION IS REFUSED AT THE DOOR, because three docstrings say it cannot exist
    // and only the ENGINE makes that true. `raise` is a public embedder door with no compiler
    // behind it, and `[]` journals a rule that reads as declared and bars nobody — which
    // `shownGate` then renders to a human as "these people are barred: nobody". The same
    // argument `isPositiveWholeMs` makes for `slaMs` one field over.
    if (req.excludedApprovers !== undefined && req.excludedApprovers.length === 0) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `gate on node "${req.nodeId}" declares an EMPTY excludedApprovers, which reads as a rule and bars nobody. Omit the field instead.`,
      );
    }

    const raisedEvent: NewEvent = {
      type: "gate.raised",
      payload: {
        gateId,
        nodeId: req.nodeId,
        policyRef: req.policyRef,
        contentDigest,
        ...(req.approvers === undefined ? {} : { approvers: req.approvers }),
        ...(req.excludedApprovers === undefined ? {} : { excludedApprovers: req.excludedApprovers }),
        ...(req.allowEdit === undefined ? {} : { allowEdit: req.allowEdit }),
        // ONE usable value for both, so the journal cannot claim a clock the fold will not
        // read. Writing `req.slaMs` here and a guarded `deadline` beside it would put an
        // `slaMs` in the record that `#deadlineOf`'s SECOND source then honours — the guard
        // moved one field over. `NaN` also reached `canonicalize`, which refuses a non-finite
        // number, so a public method threw an untyped `CanonicalizationError`; and `"1000"`
        // was worse than either, because `raisedAt + "1000"` CONCATENATES — a deadline
        // roughly 10¹⁰ ms out, journaled, on a gate an operator believed had a 1 s SLA.
        ...(usableSla === undefined ? {} : { slaMs: usableSla }),
        ...(deadline === undefined ? {} : { deadline }),
        ...(req.onTimeout === undefined ? {} : { onTimeout: req.onTimeout }),
        ...(req.mirrorOf === undefined ? {} : { mirrorOf: req.mirrorOf }),
        ...(batch === undefined ? {} : { batch }),
      },
      actor: SYSTEM_ACTOR("gate-broker"),
      taskId: req.taskId,
    };

    await log.commit(
      p?.seq ?? (0 as Seq),
      inherited === undefined
        ? [
            raisedEvent,
            {
              type: "run.suspended",
              payload: { reason: "gate" },
              actor: SYSTEM_ACTOR("gate-broker"),
            },
          ]
        : // A DEDUPED GATE NEVER SUSPENDS ITS RUN, so it writes no `run.suspended` and no
          // `run.resumed` — the pair would be two contradictory status facts about a
          // suspension that did not happen, in a journal whose whole job is that a single
          // ordered read says what occurred. The Task still goes `awaiting_gate` and back
          // to `ready` inside this one append, because the gate really was raised and
          // really was answered; `advance` picks the Task straight back up.
          //
          // The order is load-bearing: `gate.decided` folds only from `open`, so the
          // raise has to precede it, and `gate.deduped` sits between them so a reader
          // meets the reason before the decision.
          //
          // AND THE MISSING PAIR IS WHAT MAKES THIS APPEND SAFE TO SPLIT, which is worth
          // recording because the batch append next door is NOT. `Engine.rewind` refuses a
          // boundary inside a decision's append because keeping the decision and dropping
          // the `run.resumed` beside it leaves a run suspended on a gate that is already
          // answered. There is no `run.resumed` here, so there is nothing to strand:
          // measured by folding every truncation of these three rows, each one comes back
          // `running` with the gate OPEN and its Task `awaiting_gate` — a question a human
          // can still answer, which is the state a rewind should land in.
          [
            raisedEvent,
            {
              type: "gate.deduped",
              payload: {
                gateId,
                ofGateId: inherited.source.gateId,
                contentDigest,
                decision: inherited.input.decision.kind,
              },
              actor: DEDUPE_ACTOR,
              taskId: req.taskId,
            },
            decidedEvent(prospective, inherited.input, raisedAt),
          ],
      { taskId: req.taskId },
    );

    // Delivery happens AFTER the gate is durable, and its result never changes whether
    // the gate exists. A crash here loses a notification, not a decision — and the SLA
    // sweep will re-deliver on the next tier.
    //
    // NOT FOR A GATE THAT SATURATION CONTROL ALREADY ANSWERED OR MERGED, which is where
    // D7.9's load reduction actually lands. A deduped gate is decided in the append above,
    // so paging anyone about it would be a notification for a question with an answer; a
    // gate that JOINED a LIVE batch is a line added to a manifest that has already been
    // sent, not a new question. A gate that STARTS a batch delivers normally — it is
    // the first ask — which is why the test is `batch.id !== gateId` rather than
    // `batch !== undefined`. The cost is that the notification names a manifest of one and
    // the manifest grows behind it; the manifest is read at decision time, from the
    // journal, and `expectManifest` is what makes that safe rather than merely current.
    //
    // AND "LIVE" IS THE THIRD CONJUNCT, WHICH WAS MISSING. `batchFor` groups over `"any"`
    // — decided members still count against `maxBatch`, deliberately, so a batch cannot be
    // refilled after it fills — so a gate could join a batch every one of whose members had
    // already been ANSWERED, and be silenced against a message that had been read, clicked
    // and closed. Reproduced: founder raised and paged, founder approved, second gate
    // raised 1 s later → it joined the founder's batch, `openGates` returned exactly that
    // one gate, and `pages` held only the founder. A run suspended on a question nobody was
    // ever told about. The justification for the suppression is that somebody is holding a
    // manifest this gate has been added to; once no member is open, nobody is.
    //
    // AND "OPEN" WAS ONLY HALF OF "HOLDING IT" — see `announcementOutstanding`. An open
    // member nobody was ever TOLD about holds nothing, so a batch whose founder's every
    // channel failed silenced every joiner behind it: `gate.delivery_failed` on the
    // founder, no `gate.delivered` anywhere, and N questions nobody had been sent. The
    // conjunct is now the sentence the suppression actually makes — a member that was
    // delivered (somebody was told) AND is still open (they have not answered) — and both
    // halves are read from the journal, so it holds in a process that raised none of them.
    //
    // NOT DELIVERING THE JOINER IS THE MECHANISM, AND IT IS WHY THE ROUTES HAVE TO MATCH.
    // Suppressing a page is the load reduction; suppressing it in favour of a DIFFERENT
    // gate's page is a substitution of one gate's delivery policy for another's, and this
    // line cannot tell the two apart on its own. `batchFor` is where they are told apart:
    // membership now requires the same `deliveryDigest`, so the page this gate is not
    // getting is one it would have sent to the same people, on the same channels, with the
    // same redact list. Before that a gate declaring `channels: ["pagerduty"],
    // recipients: ["u:security"], redact: ["ssn"]` merged into one founded on
    // `channels: ["slack-public"], recipients: ["role:oncall"]` and was never announced
    // anywhere it had asked to be.
    const merged =
      batch !== undefined && batch.id !== gateId && siblingCarries(p, batch.id, gateId, announcementOutstanding);
    if (this.#dispatcher !== undefined && req.delivery !== undefined && inherited === undefined && !merged) {
      const summary = this.#summarize(gateId, req, raisedAt, deadline);
      await this.#dispatcher.deliver(log, summary, req.delivery, { tier: 0 });
    }

    // A DEDUPED GATE IS ALREADY CLOSED, so its non-durable half is already dead: the append
    // above carried `decidedEvent` for it. `#ephemeral` is set before that append — it has to
    // be, because a gate that turns out to be answerable is only known to be so after
    // `#inheritable` has run — so this is the one path where the entry is born terminal.
    if (inherited !== undefined) this.#releasePayload(gateId);
    return gateId;
  }

  /**
   * The decision this gate INHERITS from an identical one, or `undefined` — D7.9 row 3.
   *
   * "Inherits the first decision" is a second path to a decision, and every second path
   * in this codebase has been a bug, so this one is built to be the SAME path: it
   * constructs the `ResolveInput` a caller would have constructed and runs it through
   * `#validate`, the one chain `resolve` and the timeout's default action both use. What
   * it adds on top is the equality that makes inheriting sound at all, and every term of
   * it is read out of the FOLD — never out of this request, never out of `#ephemeral`:
   *
   *   - the same journaled `contentDigest`. Journaled, not delivered: D7.8 splits the two
   *     and says which one dedup must read, because two gates differing only inside their
   *     redact list carry the same DELIVERED digest and are not the same question;
   *   - the same node and the same `policyRef`, so an inherited `redirect` names edges
   *     this node actually has and an inherited `edit` writes what this node may write;
   *   - the same approvers and the same `edit` allow-list, which is what makes the
   *     inheritance authorized rather than merely convenient — see `DEDUPE_ACTOR`;
   *   - neither gate a subgraph mirror, because a mirror's answer is forwarded into
   *     another run and inheriting one would forward a decision twice.
   *
   * ONLY FROM A `decided` GATE — D7.9 row 3 says the second occurrence "inherits the
   * first decision", which presumes one exists. Two identical OPEN questions are what
   * batching is for; making the second WAIT on the first would be a second suspension
   * mechanism with no deadline of its own.
   *
   * AND ONLY FROM ONE A HUMAN DECIDED (`humanDecided`), which is what makes the sentence
   * above it — "a decision a human made" — true rather than merely intended. `decision`
   * cannot say who decided: `approve` reads identically whether a person clicked it, the
   * clock applied a pre-authorized default action, or another duplicate inherited it. Both
   * of those were reachable and both were measured:
   *
   *   - a gate declaring `onTimeout: "default_action"` expired into an `approve` by
   *     `system:gate-broker:timeout`, and the next identical gate — declaring
   *     `onTimeout: "fail"` and NO default action of its own — inherited it and was decided
   *     in the append that raised it. The pre-authorization GRAPH014 proved safe was the
   *     SOURCE gate's; `sameQuestion` compares neither `onTimeout` nor `defaultAction`, so
   *     it was spent on a gate whose author granted none;
   *   - a chain: 20 duplicates, each raised 50 s after the last under a declared 60 s
   *     window, carried one human click **1000 s** past that window, because each duplicate
   *     became a fresh `decided` source with a fresh `raisedAtTs`. The window is measured
   *     from the SOURCE's raise, so a chain is a window with no end, and "the audit trail
   *     from this row to the human is one hop" was twenty.
   *
   * Requiring a human closes both by construction rather than by two more comparisons:
   * every duplicate now points at the one gate a person actually answered, so the window
   * means what it says and the hop count is one. It is also what `GATE_SYSTEM_ACTORS`
   * claims about `gate-broker:dedupe`, and a claim in that list is an authorization
   * argument, not a comment.
   *
   * THAT RULE IS STATED TWICE BELOW AND BOTH STAY, which is worth a sentence because a
   * reviewer reverting one conjunct at a time will find neither is held by a test. Over
   * any journal `foldRun` can produce they are the same condition: `decision` is written
   * in exactly one arm of `projection.ts` — `gate.decided` — which sets `state: "decided"`
   * in the same object, and every other gate transition folds only from `open`. They are
   * kept apart because they answer different questions for different readers: `state`
   * says which gates are ELIGIBLE, `decisionOf` says whether the record carries the DATA,
   * which a journal an older build wrote may not. *DEDUP INHERITS FROM A `decided` GATE
   * AND FROM NO OTHER STATE* holds the rule rather than either line, and goes red — with a
   * duplicate silently inheriting an approval from a CANCELLED gate — when both are gone.
   *
   * WHEN `#validate` REFUSES, THERE IS NO DEDUP AND THE GATE IS RAISED NORMALLY. The
   * silence is not a claim: nothing is approved, nobody is told anything, and a human is
   * asked the question. It is reachable — a source `reject` whose justification the
   * journal does not carry produces a decision `#validate` refuses for having no reason —
   * and asking the human is the right answer to it.
   */
  #inheritable(
    p: RunProjection | undefined,
    prospective: GateRecord,
    req: GateRequest,
    now: number,
  ): { readonly source: GateRecord; readonly input: ResolveInput } | undefined {
    const spec = usableDedupe(req.dedupe);
    if (spec === undefined || prospective.mirrorOf !== undefined || p === undefined) return undefined;

    // The MOST RECENT identical decision, by journal order — the same rule
    // `lastDecidedGate` uses one layer up, and for the same reason: if the question was
    // asked and answered twice, the later answer is the one that stands.
    let source: GateRecord | undefined;
    for (const g of Object.values(p.gates)) {
      if (g.state !== "decided" || !humanDecided(g) || !sameQuestion(g, prospective)) continue;
      // The window is the age of the QUESTION, measured from the source gate's journaled
      // raise — the one instant per gate the fold already carries. `now - raisedAtTs` with
      // a `windowMs` that is not a number loses this comparison and would dedup forever,
      // which is why `usableDedupe` refuses one before it gets here.
      if (now - g.raisedAtTs > spec.windowMs) continue;
      if (source === undefined || g.raisedAtSeq > source.raisedAtSeq) source = g;
    }
    if (source === undefined) return undefined;

    const decision = decisionOf(source);
    if (decision === undefined) return undefined;
    const input: ResolveInput = {
      gateId: prospective.gateId,
      decision,
      actor: DEDUPE_ACTOR,
      idempotencyKey: `dedupe:${source.gateId}`,
    };
    try {
      this.#validate(prospective, input);
    } catch {
      return undefined;
    }
    return { source, input };
  }

  /**
   * The open batches of one run, each with the manifest a human would be shown.
   *
   * A batch of ONE open member is still a batch and is still listed: its siblings may be
   * decided already, or still coming, and a caller that had to special-case the count
   * would be re-deriving membership from something other than the journal.
   */
  async listBatches(log: RunLog): Promise<readonly GateBatch[]> {
    const p = await this.project(log);
    if (p === undefined) return [];
    const out: GateBatch[] = [];
    for (const [batchId, members] of gateBatchGroups(p, "open")) {
      const key = members[0]?.batch?.key ?? "";
      let deadline: number | undefined;
      for (const g of members) {
        const d = this.#deadlineOf(g);
        if (d !== undefined && (deadline === undefined || d < deadline)) deadline = d;
      }
      out.push({
        batchId,
        key,
        members: members.map((g) => this.#summaryOf(log.runId, g, this.#ephemeral.get(g.gateId)?.payload)),
        manifestDigest: batchManifestDigest(batchId, key, members),
        deadline,
        approvers: members[0]?.approvers ?? [],
      });
    }
    return out;
  }

  /**
   * One decision, every open member of one batch, ONE append — D7.9 row 2.
   *
   * THE AUTHORIZATION IS NOT WEAKER BECAUSE IT IS BULK, and making that true is the whole
   * cost of this mechanism. Every member goes through `#validate` — the same chain a
   * single `resolve` uses — and ALL of them go through it before ANYTHING is written, so
   * a batch containing one gate this actor may not decide writes nothing at all rather
   * than closing the members it happened to reach first. There is no arm here that
   * decides a gate; the events are built by `decidedEvent`, exactly as `resolve` and the
   * timeout's default action build theirs.
   *
   * `expectManifest` is what pins WHAT THE APPROVER SAW onto WHAT THEY DECIDED. Between
   * rendering a manifest and clicking it, a member can join (the window is still open), be
   * decided singly, expire, or be cancelled — and a decision applied to a list nobody read
   * is exactly the careless bulk approve D7.9 names as this mechanism's risk. It is
   * REQUIRED rather than optional because a caller who omitted it would get the unsafe
   * behaviour by saying nothing, and `GateBatch.manifestDigest` hands it to them.
   *
   * AND IT IS A `commit`, NOT AN `append`, for the reason `raise` is: everything above is
   * a decision taken AT `p.seq`, and the retrying `append` would re-read a head that has
   * moved and land this decision on a batch that is no longer the one it was checked
   * against. A conflict here is `E_SEQ_CONFLICT` to the caller, who re-reads and shows the
   * manifest again.
   *
   * IT DOES NOT RE-CHECK THE BATCH'S GOVERNANCE, AND THAT IS A DECISION. `batchGovernance`
   * runs at MEMBERSHIP time — `maxBatch` bounds what one click may *come to* close, so the
   * place to enforce it is where a member is admitted. Asking it again here would mean
   * refusing to answer gates that are already grouped, which turns a hand-written or
   * legacy batch from "decidable in one click" into "decidable only one gate at a time"
   * while buying nothing an authorization check does not already buy: every member goes
   * through `#validate` below, so an oversized batch cannot close a gate this actor may not
   * decide. The cap is an ergonomics bound on carelessness, not an authorization fact.
   * **Reverses when** a batch can be assembled by something other than `batchFor` — a
   * repair tool, an import, a second broker — at which point "who built this grouping?" is a
   * question this method has to be able to answer for itself.
   *
   * `gateIds` IS ONLY MEANINGFUL WHEN `resolved` IS TRUE, and the empty array beside
   * `resolved: false` is not a claim that nothing was closed — it is the second click of a
   * double-click meeting the idempotency map, and what the FIRST click closed is on the
   * journal in the `gate.batch_decided` this method already wrote. The map holds a decision
   * kind and not a member list on purpose: re-deriving the list here would mean answering
   * from process memory a question the journal answers authoritatively, which is the habit
   * the whole class is arranged to make impossible.
   */
  async resolveBatch(log: RunLog, input: ResolveBatchInput): Promise<{ resolved: boolean; gateIds: readonly GateId[] }> {
    const p = await this.project(log);
    // Existence is asked of EVERY state, not only `open`, so that the second click of a
    // double-click meets the idempotency map below rather than a 404 about a batch it just
    // closed — the same ordering `resolve` documents at length for a single gate.
    const all = p === undefined ? [] : gateBatchGroups(p, "any").get(input.batchId);
    if (p === undefined || all === undefined || all.length === 0) {
      throw err.notFound(CODES.E_GATE_NOT_FOUND, `no gate batch "${input.batchId}" in run ${log.runId}`);
    }

    const idemKey = `batch:${input.batchId}:${actorId(input.actor)}:${input.idempotencyKey}`;
    if (this.#idempotency.has(idemKey)) return { resolved: false, gateIds: [] };

    if (isTerminal(p.status)) {
      throw err.conflict(
        CODES.E_GATE_ALREADY_RESOLVED,
        `gate batch "${input.batchId}" belongs to run ${log.runId}, which is ${p.status}`,
        { details: { batchId: input.batchId, runStatus: p.status } },
      );
    }

    const members = all.filter((g) => g.state === "open");
    if (members.length === 0) {
      throw err.conflict(
        CODES.E_GATE_ALREADY_RESOLVED,
        `every gate in batch "${input.batchId}" is already resolved`,
        { details: { batchId: input.batchId, members: all.length } },
      );
    }

    // ONE READ OF THE CALLER'S DECISION, CHECKED BEFORE IT IS DESCRIBED. Two things used
    // to go wrong here at once: a kind in no vocabulary satisfied the narrowing below by
    // not being either of the two names it tests, and `input.decision.kind` was read once
    // for the branch and again for the message, on a value from outside that need not
    // answer the same way twice. `gateDecisionOf` reads it once and totally.
    const decision = gateDecisionOf(input.decision);
    if (decision === undefined || (decision.kind !== "approve" && decision.kind !== "reject")) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        decision === undefined
          ? `gate batch "${input.batchId}" was answered with something that is not a decision`
          : `gate batch "${input.batchId}" can only be approved or rejected, not ${decision.kind}ed`,
        { details: { batchId: input.batchId, ...(decision === undefined ? {} : { decision: decision.kind }) } },
      );
    }

    const key = members[0]?.batch?.key ?? "";
    const manifestDigest = batchManifestDigest(input.batchId, key, members);
    if (manifestDigest !== input.expectManifest) {
      throw err.conflict(
        CODES.E_GATE_ALREADY_RESOLVED,
        `gate batch "${input.batchId}" has changed since it was shown: ${members.length} open member(s) now`,
        { details: { batchId: input.batchId, expected: input.expectManifest, actual: manifestDigest } },
      );
    }

    for (const g of members) {
      this.#validate(g, {
        gateId: g.gateId,
        decision,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
      });
    }

    const now = this.#now();
    const gateIds = members.map((g) => g.gateId);
    const events: NewEvent[] = members.map((g) =>
      decidedEvent(g, { gateId: g.gateId, decision, actor: input.actor, idempotencyKey: input.idempotencyKey }, now),
    );
    events.push({
      type: "gate.batch_decided",
      payload: { batchId: input.batchId, key, gateIds, manifestDigest, decision: decision.kind },
      actor: input.actor,
    });
    // ONE resume for one decision. The run suspended once per gate and it resumes once;
    // `advance` re-suspends it on the spot if some other gate is still open, which is the
    // arm that already handles several gates open at a time.
    events.push(resumedEvent(input.actor));

    const lead = members[0]!.taskId;
    await log.commit(p.seq, events, lead === ("" as TaskId) ? {} : { taskId: lead });

    // AFTER the commit, not before. `resolve` records the key first and gets away with it
    // because its retrying `append` almost never fails; this is a compare-and-swap that
    // legitimately loses to a concurrent writer, and recording a decision that did not
    // land would turn the caller's retry into a silent no-op.
    this.#idempotency.set(idemKey, decision.kind);
    for (const g of gateIds) this.#releasePayload(g);
    return { resolved: true, gateIds };
  }

  /** A GateSummary for a gate that has just been raised, before any projection exists. */
  #summarize(gateId: GateId, req: GateRequest, at: number, deadline: number | undefined): GateSummary {
    return {
      gateId,
      runId: req.runId,
      taskId: req.taskId,
      nodeId: req.nodeId,
      state: "open",
      policyRef: req.policyRef,
      raisedAtTs: at,
      // Not yet known — the append that made this gate durable has not been projected.
      // A channel does not need it; the projection is authoritative once it exists.
      raisedAtSeq: 0,
      contentDigest: bindingDigestOf(req),
      payload: req.payload,
      slaMs: req.slaMs,
      deadline,
      onTimeout: req.onTimeout ?? "fail",
      approvers: req.approvers ?? [],
      ...(req.excludedApprovers === undefined ? {} : { excludedApprovers: req.excludedApprovers }),
      allowEdit: req.allowEdit,
      tier: 0,
      ...(req.mirrorOf === undefined ? {} : { mirrorOf: req.mirrorOf }),
    };
  }

  /**
   * Join the durable gate to its rendered payload.
   *
   * Every field that decides anything comes from `g` — the projection — and the only
   * thing the broker's memory contributes is what the human READS. That split is the
   * fix: a process that never raised this gate renders a blank payload and still
   * enforces the same rules.
   */
  #summaryOf(runId: RunId, g: GateRecord, payload: unknown): GateSummary {
    return {
      ...g,
      runId,
      payload,
      slaMs: g.slaMs,
      deadline: this.#deadlineOf(g),
      onTimeout: g.onTimeout ?? "fail",
      approvers: g.approvers ?? [],
      allowEdit: g.allowEdit,
      tier: g.tier,
    };
  }

  /**
   * When this gate expires, or `undefined` if it never does.
   *
   * Three sources, in strict order of authority: the journaled absolute deadline; an SLA
   * the journal recorded, measured from the journaled raise; and — only when the journal
   * has neither, i.e. only for a gate written before either field existed — an SLA an
   * operator re-supplied through `rehydrate`, measured from the same journaled raise. The
   * last one can give a clock to a gate that had none; it can never move one that has.
   */
  #deadlineOf(g: GateRecord): number | undefined {
    if (g.deadline !== undefined) return g.deadline;
    if (g.slaMs !== undefined) return g.raisedAtTs + g.slaMs;
    const supplied = this.#ephemeral.get(g.gateId)?.slaMs;
    return supplied === undefined ? undefined : g.raisedAtTs + supplied;
  }

  /**
   * The next nudge this gate owes, or `undefined` — D7.2's `reminders`.
   *
   * TWO HALVES FROM TWO PLACES, and which comes from which is the whole design. WHEN comes
   * from the broker's memory (the schedule is a route-like declaration, not an
   * authorization), and HOW MANY HAVE GONE OUT comes from the JOURNAL. Putting the count in
   * memory would reset a schedule on every deploy — every restarted process would nudge
   * from the top — and putting the schedule in the journal would put a delivery policy in
   * the log for no benefit, since a process with no schedule has nowhere to send one
   * anyway.
   *
   * Anchored on `raisedAtTs`, like `#deadlineOf`'s last resort and for the same reason: the
   * instants are a property of when the gate was RAISED, so re-supplying the schedule on a
   * later deploy names the same instants rather than a fresh set.
   *
   * A SCHEDULE BELONGS TO THE WINDOW IT WAS DECLARED AGAINST, WHICH IS WHY A GATE PAST
   * TIER 0 OWES NOTHING. `usableReminders` puts every instant strictly inside the SLA — and
   * the SLA is the TIER-0 window, `[raisedAtTs, raisedAtTs + slaMs)`. The first escalation
   * happens at or after that window's end and starts a new one with a new deadline and new
   * recipients, so every entry still unsent names a moment BEHIND the start of the window
   * that is now running. `g.tier !== 0` is therefore not an extra rule, it is that
   * arithmetic written where the sweep can read it in one comparison; the general form —
   * "the declared instant is inside the running window" — differs only for entries
   * `usableReminders` has already refused.
   *
   * It is also what keeps `nextDeadline` honest. A spent-but-uncleared entry names an
   * instant in the past, and a run whose due-instant is in the past is a run the sweeper
   * folds on EVERY tick, forever, for a nudge it will not send.
   */
  #nextReminder(g: GateRecord): { readonly nth: number; readonly at: number } | undefined {
    if (g.tier !== 0) return undefined;
    const schedule = this.#ephemeral.get(g.gateId)?.reminders;
    if (schedule === undefined) return undefined;
    const nth = g.remindersSent ?? 0;
    const afterMs = schedule[nth];
    // The schedule is spent. A gate keeps waiting — a reminder is a nudge, never a
    // deadline, so running out of them ends nothing.
    if (afterMs === undefined) return undefined;
    return { nth, at: g.raisedAtTs + afterMs };
  }

  /**
   * Every entry due at `now`, as ONE range — the storm bound restated over the instant a
   * nudge is SENT rather than the instant it was declared for.
   *
   * `usableReminders` and `checkSla` bound the DECLARED instants, and that was read as
   * bounding the nudges. It does not: nothing runs this clock but the deployment, so a tick
   * can be late by any amount, and a schedule of three entries owed at once went out one
   * nudge per tick — three interruptions in three ticks, for three moments that had all
   * passed, the last two saying nothing the first had not. The bound has to be over what is
   * sent, and this is where sending is decided.
   *
   * So the whole backlog is DISCHARGED IN ONE APPEND and at most its LAST entry is
   * delivered (`#remind`). The last, not the first: they all say the same sentence — *this
   * question is still open* — and the one that has just come due is the one whose remaining
   * time is the truth now.
   *
   * `undefined` means nothing is owed. `{from, through}` is inclusive at both ends, and
   * `from === through` is the ordinary case: a tick that is not late owes exactly one.
   */
  #dueReminders(g: GateRecord, now: number): { readonly from: number; readonly through: number } | undefined {
    const next = this.#nextReminder(g);
    if (next === undefined || now < next.at) return undefined;
    const schedule = this.#ephemeral.get(g.gateId)?.reminders ?? [];
    let through = next.nth;
    while (through + 1 < schedule.length && g.raisedAtTs + schedule[through + 1]! <= now) through++;
    return { from: next.nth, through };
  }

  /**
   * Record a decision and resume the run. Idempotent per `(gateId, approver)`, so a
   * double-click, a webhook retry, and a channel retry all collapse to one decision.
   *
   * THIS is where authorization is enforced, and deliberately not one level up. The
   * previous arrangement checked approvers in the inbound-callback route only, so the
   * rule held exactly for the door that remembered to check it — and not for the HTTP
   * control plane, the CLI, or the console. Callers may keep their own checks as
   * defence in depth; none of them may be the only one.
   */
  async resolve(log: RunLog, input: ResolveInput): Promise<{ resolved: boolean }> {
    const p = await this.project(log);
    // `gateOf`, NEVER a bare index. `p.gates["__proto__"]` answers with `Object.prototype`,
    // so a gate nobody raised used to reach the state check below and come back
    // `409 E_GATE_ALREADY_RESOLVED` — an existence claim, made to whoever asked, about a
    // gate that does not exist. The lookup is the place to fix it; a guard at this door
    // would have been the third one on the same hazard.
    const gate = p === undefined ? undefined : gateOf(p, input.gateId);
    if (p === undefined || gate === undefined) {
      throw err.notFound(CODES.E_GATE_NOT_FOUND, `no gate "${input.gateId}" in run ${log.runId}`);
    }

    const idemKey = `${input.gateId}:${actorId(input.actor)}:${input.idempotencyKey}`;
    const already = this.#idempotency.get(idemKey);
    if (already !== undefined) return { resolved: false };

    // THE RUN, NOT ONLY THE GATE.
    //
    // This method used to validate the gate and have no opinion about the run it belongs
    // to. `Engine.cancel` left its gates `open`, so a gate row routinely outlived the run
    // it was raised in, and "the gate is still open" was read as evidence that the run was
    // still going. It is not: it is evidence that nobody closed the gate. Answering one
    // appended `gate.decided` with its unconditional `run.resumed`, the fold moved the
    // status back to `running`, and the executor carried out the very action the operator
    // had cancelled to prevent.
    //
    // Cancel now closes its gates, so on a journal this build wrote the check below
    // catches it first with `state: "cancelled"`. This one stays because the other
    // terminal transitions do NOT all close gates — a gate EXPIRY fails the run and leaves
    // every sibling gate open — and because a store written by an older build still
    // contains the old shape. A rule that holds only for logs this version produced is not
    // a rule.
    //
    // It reuses `E_GATE_ALREADY_RESOLVED` rather than adding a code: D3's boundary
    // taxonomy names four codes for this method, the class is the same conflict, and the
    // message carries the distinction an operator needs.
    //
    // It sits AFTER the idempotency check, and that order is load-bearing. A Slack retry
    // or a webhook redelivery routinely lands after the run it decided has already
    // finished; turning those into a 409 would break the "a double-click, a webhook retry,
    // and a channel retry all collapse to one decision" contract for the ordinary success
    // case. A repeat of a decision this broker already recorded is answered from the
    // idempotency map, as it always was. What this refuses is a NEW decision on a run that
    // has ended.
    if (isTerminal(p.status)) {
      throw err.conflict(
        CODES.E_GATE_ALREADY_RESOLVED,
        `gate "${input.gateId}" belongs to run ${log.runId}, which is ${p.status}`,
        { details: { gateId: input.gateId, runStatus: p.status } },
      );
    }

    if (gate.state !== "open") {
      throw err.conflict(
        CODES.E_GATE_ALREADY_RESOLVED,
        `gate "${input.gateId}" is ${gate.state}, not open`,
        { details: { gateId: input.gateId, state: gate.state } },
      );
    }

    // The CHECKED decision, and it is what gets journaled — not the object the caller
    // handed in, which need not answer the same way when `decidedEvent` reads it again.
    const checked = { ...input, decision: this.#validate(gate, input) };

    this.#idempotency.set(idemKey, checked.decision.kind);

    await log.append([decidedEvent(gate, checked, this.#now()), resumedEvent(input.actor)], { taskId: gate.taskId });

    await this.#announceRemainder(log, p, gate);
    this.#releasePayload(gate.gateId);
    return { resolved: true };
  }

  /**
   * Announce what is LEFT of a batch when the message that covered it has been answered.
   *
   * WHAT THE TIER-0 SUPPRESSION ASSERTS, RE-ASKED AT THE ONE INSTANT IT CAN STOP BEING
   * TRUE. A joiner is not paged because "a message this gate has been added to is sitting
   * unanswered in somebody's queue" (`raise`'s `merged`). That is a claim about the
   * present, checked once, at the raise — and answering the member that was delivered
   * falsifies it, in the same second, through the ordinary single-gate path. Reproduced:
   * founder raised and paged, joiner raised 1 s later and silenced, founder approved via
   * `resolve` — the joiner was left open, unannounced, and blocking its branch, with no
   * clock behind it unless the graph declared one. The previous wave fixed the case where
   * the batch was already dead AT the raise; this is the same outcome reached one event
   * later, and a check that can go stale needs a place that re-takes it, not a better
   * moment to take it once.
   *
   * SO IT IS DECIDED HERE, WHERE THE PREMISE CHANGES, and it sends AT MOST ONE page: the
   * oldest remaining open member's, on that member's own route. `remaining.some(...)` is
   * the same predicate `raise` uses — if any member still open was ever delivered, somebody
   * is still holding a message that lists this batch, and a second page would be the
   * N-pages-per-batch defect arriving through the back door.
   *
   * TWO CALLERS, AND THE SECOND ONE IS THE REASON THIS IS A METHOD. `resolve` is the door
   * every human, callback and subgraph forward comes through; `#fireTimeout`'s default
   * action deliberately does NOT go through it (it validates and writes in one append), so
   * a pre-authorized decision closes a member by a second path. Those are the only two ways
   * a batch loses ONE member while its run lives — a cancel closes every gate, and an
   * expiry fails the run — and `resolveBatch` closes every open member by construction, so
   * there is nothing left for it to announce.
   *
   * `at` is the projection the decision was taken at, MINUS the gate that decision closed:
   * the only member this call moved. Re-folding would cost a second read of the whole
   * journal on every decision to learn one fact this already knows.
   *
   * IT SWALLOWS ITS OWN FAILURE, and that is the one thing to be careful about. The
   * decision is already durable; turning a notification failure into a throw would make a
   * caller retry a decision that landed. `GateDispatcher.deliver` journals every channel's
   * outcome itself, so what is lost here is a store that would not accept the receipt rows
   * — in which case there was nowhere to record anything anyway.
   */
  async #announceRemainder(log: RunLog, at: RunProjection, closed: GateRecord): Promise<void> {
    if (this.#dispatcher === undefined) return;
    const batchId = batchIdOf(closed);
    if (batchId === undefined) return;
    const remaining = (gateBatchGroups(at, "open").get(batchId) ?? []).filter((m) => m.gateId !== closed.gateId);
    if (remaining.length === 0 || remaining.some(announcementOutstanding)) return;
    // Journal order, so the question that has waited longest is the one announced.
    const next = remaining[0]!;
    const eph = this.#ephemeral.get(next.gateId);
    if (eph?.delivery === undefined) return;
    try {
      await this.#dispatcher.deliver(log, this.#summaryOf(log.runId, next, eph.payload), eph.delivery, {
        tier: next.tier,
      });
    } catch {
      // See above: a landed decision is not undone by a channel that would not take a page.
    }
  }

  /**
   * Take the soft lock on a gate — D7.3's `Claimed`, as it is actually built.
   *
   * > **A CLAIM IS A COORDINATION HINT BETWEEN APPROVERS. IT GRANTS NOTHING AND IT BLOCKS
   * > NOTHING.**
   *
   * What it asserts is one sentence — *I am looking at this now, so you need not* — and
   * every rule below is that sentence and no more:
   *
   *   - **it is not authorization.** Claiming does not make the claimant an approver, and
   *     `resolve`, `resolveBatch` and `#fireTimeout` do not read a claim at all: a legitimate
   *     approver decides a gate somebody else has claimed exactly as fast as one nobody has.
   *     A soft lock that hardens is a way for one person to hold up an urgent approval, and
   *     the way to keep it soft is for the decision path to have no branch on it;
   *   - **only a person may make one**, whatever `#authorize` would admit. That check has an
   *     allow-list of SYSTEM components whose authority is journaled elsewhere
   *     (`GATE_SYSTEM_ACTORS`), and none of them LOOKS at anything — "the clock is reading
   *     this gate" is not a fact and would silence the humans who are. So this is
   *     deliberately NOT the authorization chain, it is narrower than it, and it may never
   *     become it: every divergence between the two can only make CLAIMING harder, never
   *     deciding easier;
   *   - **an approver of THIS gate, when it names any.** A gate that names nobody is
   *     answerable by anyone, so any person may claim it — "somebody is looking" is the
   *     whole content there. A gate that names people is claimable only by them, because a
   *     claim by anyone else tells the people who must look that they need not;
   *   - **a batch is one question, so it is claimed once** — the same rule that pages it
   *     once, escalates it once per tier and nudges it once per reminder. A live claim on
   *     any open member covers the manifest (`claimHolder`), so the second approver is told
   *     who has it rather than being handed a second lock on the same click.
   *
   * IT REFUSES RATHER THAN GOING QUIET, in every case where the claim did not happen. A
   * caller reads silence as "I hold it", so a gate that does not exist, a gate that is no
   * longer open, a run that has ended and an actor who may not claim all throw; contention
   * is not an error and comes back as `{claimed: false}` NAMING THE HOLDER, which is the
   * only answer that lets a console say something useful.
   *
   * THE ANSWER IS READ BACK OUT OF THE JOURNAL rather than assumed from the append,
   * because two people claiming in the same instant is exactly the case this exists for.
   * The FOLD is the arbiter — `projection.ts` keeps the first live claim and drops a
   * second one by another subject — so the later claimant is told the truth instead of
   * being told they hold a lock the log gives to somebody else. The claimant's own
   * re-claim refreshes it, which is how a person still typing keeps it.
   */
  async claim(
    log: RunLog,
    input: { readonly gateId: GateId; readonly actor: Actor },
  ): Promise<{ readonly claimed: boolean; readonly by: string; readonly until: number }> {
    const p = await this.project(log);
    const gate = p === undefined ? undefined : gateOf(p, input.gateId);
    if (p === undefined || gate === undefined) {
      throw err.notFound(CODES.E_GATE_NOT_FOUND, `no gate "${input.gateId}" in run ${log.runId}`);
    }
    // A claim on a question nobody can answer any more is not a hint, it is a mistake about
    // what the queue holds — so both closings refuse, with the code and the shape `resolve`
    // uses for the same two facts.
    if (isTerminal(p.status)) {
      throw err.conflict(
        CODES.E_GATE_ALREADY_RESOLVED,
        `gate "${input.gateId}" belongs to run ${log.runId}, which is ${p.status}`,
        { details: { gateId: input.gateId, runStatus: p.status } },
      );
    }
    if (gate.state !== "open") {
      throw err.conflict(CODES.E_GATE_ALREADY_RESOLVED, `gate "${input.gateId}" is ${gate.state}, not open`, {
        details: { gateId: input.gateId, state: gate.state },
      });
    }
    const actor = input.actor;
    if (actor.kind !== "human") {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `a claim on gate "${input.gateId}" says a PERSON is looking at it, which "${actorId(actor)}" is not`,
        { details: { gateId: input.gateId, actor: actorId(actor) } },
      );
    }
    const approvers = gate.approvers ?? [];
    if (approvers.length > 0 && !approvers.includes(actor.subject)) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `gate "${input.gateId}" does not name "${actor.subject}" as an approver`,
        { details: { gateId: input.gateId, actor: actor.subject } },
      );
    }
    // AND THE CLAIM DOOR STAYS NARROWER THAN THE DECISION DOOR, which is the rule this
    // method already follows for approvers and for actor kinds. A claim grants nothing, so
    // this is not about authorization — it is about what a claim SAYS: "somebody is looking
    // at this", told to the people who must look. Letting the one person who provably cannot
    // decide hold the claim tells the approvers they can stand down, which is the one thing
    // a soft lock must never do.
    if ((gate.excludedApprovers ?? []).includes(actor.subject)) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `gate "${input.gateId}" separates duties: "${actor.subject}" started this run, so they may not claim it either`,
        { details: { gateId: input.gateId, actor: actor.subject } },
      );
    }

    const now = this.#now();
    const held = claimHolder(p, gate, now);
    if (held !== undefined && held.by !== actor.subject) return { claimed: false, by: held.by, until: held.until };

    const until = now + CLAIM_TTL_MS;
    await log.append(
      [{ type: "gate.claimed", payload: { gateId: input.gateId, until }, actor }],
      gate.taskId === ("" as TaskId) ? {} : { taskId: gate.taskId },
    );

    const after = await this.project(log);
    const folded = after === undefined ? undefined : gateOf(after, input.gateId);
    const stands = folded === undefined || folded.state !== "open" ? undefined : liveClaim(folded, now);
    if (stands === undefined) {
      throw err.conflict(CODES.E_GATE_ALREADY_RESOLVED, `gate "${input.gateId}" is no longer open to be claimed`, {
        details: { gateId: input.gateId, state: folded?.state ?? "gone" },
      });
    }
    return { claimed: stands.by === actor.subject, by: stands.by, until: stands.until };
  }

  /**
   * Every rule a decision must satisfy, wherever the decision came from.
   *
   * ONE chain, called by `resolve` and by `#fireTimeout`'s default action — which is the
   * same rule invariant 6 states for tools, arrived at from the other direction. The
   * timeout path used to satisfy these by calling `resolve` itself, which is why it needed
   * two appends and had a window between them; validating here lets it write the clock's
   * row and the decision it licenses as ONE fact. A second guard chain for the same
   * question is how a gate ends up authorized differently depending on who asked.
   *
   * IT RETURNS THE CHECKED DECISION, and every caller must write THAT rather than the one
   * it was handed. `input.decision` is a value from outside — an embedder's object, a
   * vendor adapter's return, a `defaultAction` `rehydrate` attached from an unvalidated
   * source — so a second read of it can answer differently from the read this chain
   * judged. One read, checked, and every later use is of what that read produced.
   */
  #validate(gate: GateRecord, input: ResolveInput): GateDecision {
    // THE ACCEPTANCE SET IS ASSERTED BEFORE ANYTHING ELSE READS THE DECISION, because
    // `#authorize` below and `decidedEvent` after it both branch on `kind`, and a kind in
    // no vocabulary satisfied every one of those branches by not being the one they name.
    // `gateDecisionOf` answers `undefined` for it; the refusal is here because this is the
    // one chain, and a door that pre-refuses with a better message is an improvement on
    // top of this rather than a substitute for it.
    const decision = gateDecisionOf(input.decision);
    if (decision === undefined) {
      throw err.validation(
        CODES.E_HUMAN_APPROVAL_REQUIRED,
        `gate "${gate.gateId}" was answered with something that is not a decision — it must be one of ` +
          `{kind:"approve"}, {kind:"reject",reason}, {kind:"edit",writes} or {kind:"redirect",take}`,
        { details: { gateId: gate.gateId } },
      );
    }

    this.#authorize(gate, { ...input, decision });

    if (decision.kind === "reject" && decision.reason.trim() === "") {
      throw err.validation(CODES.E_HUMAN_APPROVAL_REQUIRED, "a rejection requires a reason");
    }

    return decision;
  }

  /**
   * Refuse a decision the gate itself did not authorize.
   *
   * Reads `gate`, the FOLD of `gate.raised`, and nothing else. There is no fallback to
   * the broker's memory and there must never be one: the memory is empty in every
   * process that did not raise the gate, and an authorization check whose input can be
   * silently empty is a check that passes by default.
   *
   * The two facts this keeps apart:
   *   - "this gate names nobody"  → permissive, and the common case
   *   - "I could not read who it names" → not reachable here, and that is the design:
   *     an unreadable `gate.raised` yields no `GateRecord`, so `resolve` has already
   *     refused with `E_GATE_NOT_FOUND` before arriving.
   */
  #authorize(gate: GateRecord, input: ResolveInput): void {
    const approvers = gate.approvers ?? [];
    if (approvers.length > 0 && !isAuthorizedActor(approvers, input.actor)) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `gate "${gate.gateId}" does not name "${actorId(input.actor)}" as an approver`,
        { details: { gateId: gate.gateId, actor: actorId(input.actor) } },
      );
    }

    // SEPARATION OF DUTIES — D7.2, and it is a refusal LAYERED ON TOP of the approvers list
    // rather than a replacement for it. A subject may be named and still barred; the two
    // rules answer different questions ("is this your question?" and "is this your own work
    // you are signing off?"), and a gate that asked for both gets both.
    //
    // READ OFF THE GATE, like everything else here. The exclusion was resolved once, at
    // raise, from the run's recorded initiator and journaled on `gate.raised` — so this stays
    // a function of the fold, a restart cannot lose it, and a replay reproduces the same
    // answer. Deriving it here from run state would be an authorization input that can be
    // silently empty in any process that did not raise the gate.
    //
    // HUMANS ONLY, and the carve-out is not a hole. A `system` actor reaching this line has
    // already passed `isAuthorizedActor`, which admits exactly `GATE_SYSTEM_ACTORS` — the
    // replayer, the timeout's default action, and the dedup inheritor — none of which is a
    // person who could be the initiator. Without it, every replay of every SoD gate would
    // fail here, because the replayer's subject is not in any exclusion and its KIND is what
    // makes it legitimate.
    if (input.actor.kind === "human" && (gate.excludedApprovers ?? []).includes(input.actor.subject)) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `gate "${gate.gateId}" separates duties: "${input.actor.subject}" started this run, so they may not approve it`,
        { details: { gateId: gate.gateId, actor: actorId(input.actor) } },
      );
    }

    // WHAT SEPARATION OF DUTIES DOES NOT COVER, recorded here rather than left to be
    // rediscovered — the same way `approvers`' own limits are recorded above it. Each is a
    // door this rule inherits rather than one it opens:
    //
    //   - **subject injectivity.** The exclusion is a set of subject STRINGS compared against
    //     `Actor.subject`. Nothing links two credentials held by one person, so submitting as
    //     `u:alice-contractor` and approving as `u:alice` satisfies it. That is inherent to
    //     subject-string identity and is the same limit `approvers` carries.
    //   - **the signed-callback route** is unauthenticated by design and takes its actor from
    //     an HMAC-verified body, so a leaked channel secret bypasses this exactly as it
    //     bypasses `approvers`. Its own pre-check reads only `approvers`, so an SoD refusal
    //     falls through to a journaled durable refusal rather than the cheap path — safe, and
    //     it spends the per-run refusal budget.
    //   - **`loom approve --as`** mints an actor with no authentication at all. Already a
    //     stated limit of the CLI; this rule does not narrow it.
    //   - **a pre-authorized `defaultAction`** would let the clock approve what the rule bars.
    //     Refused at the raise instead — see `assertDefaultActionIsSatisfiable`.
    //   - **graph mutation.** A caller who may mutate a running graph can add a gate naming
    //     whoever they like; `graph:mutate` was already a strong capability.
    //
    // A MIRROR CARRIES APPROVE OR REJECT, AND NOTHING ELSE.
    //
    // Its question lives in another run, and only those two decisions survive the trip:
    // an `edit` names channels in THIS graph's namespace, so applying it would hand the
    // parent a result the child never produced — with `allowEdit` set to the subgraph
    // node's own writes, that was literally the set needed to forge the delegated output,
    // while the child stayed suspended on a gate nobody would ever answer. A `redirect`
    // answers the parent's routing question and leaves the child's untouched, with the
    // same leak. `allowEdit: []` says the first half in the journal; this says both, for
    // every entry point, including a default action attached after the fact.
    if (gate.mirrorOf !== undefined && (input.decision.kind === "edit" || input.decision.kind === "redirect")) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `gate "${gate.gateId}" mirrors gate "${gate.mirrorOf}" in another run, so it can only be approved or rejected`,
        { details: { gateId: gate.gateId, mirrorOf: gate.mirrorOf, decision: input.decision.kind } },
      );
    }

    // `undefined` means the gate declared no restriction; `[]` means it declared one
    // that permits nothing. Conflating them is how a signed `edit` came to write a
    // channel the gate forbade — after a restart the list read as absent.
    if (input.decision.kind === "edit" && gate.allowEdit !== undefined) {
      for (const channel of Object.keys(input.decision.writes)) {
        if (!gate.allowEdit.includes(channel)) {
          throw err.policy(
            CODES.E_GATE_NOT_AUTHORIZED,
            `gate "${gate.gateId}" does not permit editing channel "${channel}"`,
            { details: { channel, allowed: gate.allowEdit } },
          );
        }
      }
    }
  }

  /**
   * The earliest instant at which one of this run's open gates NEEDS THIS CLASS AGAIN, or
   * `undefined`.
   *
   * Exists for `GateSweeper`, which needs to decide whether a run is worth folding without
   * folding it. It is on the BROKER and not a free function over the projection because
   * `#deadlineOf` has three sources in strict order of authority, and the last of them —
   * an SLA an operator re-supplied through `rehydrate` for a gate whose journal predates
   * the field — lives in this object's memory. A caller computing the answer from the
   * projection alone would silently disagree with the sweep about which gates have a clock.
   *
   * TWO KINDS OF DUE-INSTANT, NOT ONE, and that is why this is no longer named for the
   * deadline alone. A gate falls due when it EXPIRES and, before that, when it owes a
   * reminder; `GateSweeper` skips a whole run on `now < cursor.due`, so a reminder instant
   * that did not reach this answer would be a nudge the clock never wakes up for. That is
   * the entire wiring reminders needed — the same tick, one more due-instant, rather than a
   * second mechanism with a second timer.
   */
  nextDeadline(p: RunProjection): number | undefined {
    let earliest: number | undefined;
    const consider = (t: number | undefined): void => {
      if (t !== undefined && (earliest === undefined || t < earliest)) earliest = t;
    };
    for (const g of openGates(p)) {
      consider(this.#deadlineOf(g));
      consider(this.#nextReminder(g)?.at);
    }
    return earliest;
  }

  /**
   * Fire the due timeouts of ONE run. Nothing here schedules itself.
   *
   * WHAT DRIVES IT: an embedder, through `Engine.sweepGates` and the `GateSweeper` behind
   * it. This docstring used to open "driven by the scheduler tick locally, a delay queue
   * when distributed", and there was no scheduler tick and no delay queue — four design
   * documents were corrected to stop saying it and this was the last copy. `@loom/core`
   * starts no timer and reads no wall clock on its own: a library that schedules work on
   * import keeps its embedder's process alive and puts a clock inside the determinism
   * boundary. So `now` is a parameter, the interval belongs to the deployment, and a test
   * advances an injected clock and observes exactly one escalation.
   *
   * Deadlines are absolute timestamps derived from the log, not in-memory timers, so a
   * deploy neither resets nor skips an SLA — and a sweep that happens LATE is still
   * correct, which is what makes an externally-driven tick a sound design rather than a
   * concession. (That became true only once the deadline itself was journaled; `rehydrate`
   * used to recompute it as `now + slaMs`, quietly granting every gate a fresh SLA on every
   * deploy.)
   *
   * IT IS A SWEEP, so it is total over the run's due gates. Each one is fired in its own
   * try, because a run-wide loop that aborts on the first failure is a loop in which one
   * gate can switch off every other gate's SLA. A gate is reported as fired only if
   * something actually LANDED for it — see `#commitForOpenGate`.
   */
  async sweepTimeouts(log: RunLog, now = this.#now()): Promise<readonly GateId[]> {
    let p = await this.project(log);
    if (p === undefined) return [];
    const fired: GateId[] = [];

    // The gates to CONSIDER are fixed by the first fold; what each one is worth is not.
    // This loop writes, so a gate's state, its deadline and the run's own status are all
    // re-derived below rather than read once at the top.
    for (const gateId of openGates(p).map((g) => g.gateId)) {
      // A DEAD RUN HAS NO DEADLINES LEFT TO MISS — checked per gate, which is ONE guard
      // where there were two.
      //
      // The run can be dead on arrival: on the legacy shape `resolve`'s check is kept for —
      // a cancelled run whose gate an older build left `open` — the sweep found that gate
      // overdue and `#expire` appended `run.failed` to it, overwriting the operator's
      // cancellation with a timeout in every read model derived from the journal.
      //
      // Or THIS TICK can have killed it. An expiry fails the run; the gates behind it in
      // this same loop were selected against a run that was still alive, and firing them
      // anyway wrote a SECOND `run.failed` — two contradictory terminal records in the one
      // store invariant 2 makes authoritative — and, on the escalate arm, DELIVERED: a human
      // paged about a run this very tick had already killed. The fold refuses the second
      // status transition (see `RUN_STATUS_EVENTS`), so no read model was wrong; the page
      // was still sent, and a journal nobody can read straight is its own defect.
      //
      // There WAS a second copy of this, guarding the loop from outside. It could not fail
      // independently — the first iteration refuses everything it refused — so it was two
      // spellings of one rule, and the register's own lesson is that a rule with two homes
      // is a rule that drifts.
      if (p === undefined || isTerminal(p.status)) break;

      const gate = gateOf(p, gateId);
      if (gate === undefined || gate.state !== "open") continue;
      const deadline = this.#deadlineOf(gate);
      const due = deadline !== undefined && now >= deadline;

      // A NUDGE ONLY WHEN THE DEADLINE HAS NOT ALREADY PASSED, and only one APPEND per gate
      // per tick either way. When both are due the timeout wins: it is the stronger event —
      // it moves the tier or ends the run — and a "still waiting?" sent in the same instant
      // as an escalation is a message about a question that has just moved to somebody else.
      // The reminder is not lost, it is simply still due; if the gate is still open on the
      // next tick it goes out then, and if it is not, nobody wanted it.
      const reminder = due ? undefined : this.#dueReminders(gate, now);
      if (!due && reminder === undefined) continue;

      try {
        if (reminder !== undefined) {
          // NOT COUNTED AS `fired`. A reminder is not a deadline firing — it moves no
          // clock, ends nothing, and reporting it here would tell an operator reading
          // `SweepReport.fired` that an SLA had had a say in a gate that is still waiting
          // exactly as it was.
          await this.#remind(log, p, gate, reminder);
        } else if (await this.#fireTimeout(log, p, gate, now)) fired.push(gateId);
      } catch {
        // ONE GATE MUST NOT ABORT THE SWEEP. This is a RUN-WIDE loop, so a throw here
        // used to mean every gate behind the failing one stopped expiring too — one
        // misconfigured default action switching off the SLA for a whole run, forever,
        // because the same gate threw again on every later sweep.
        //
        // Nothing is swallowed that goes unrecorded elsewhere: a refused decision is
        // handled inside `#fireTimeout` and lands on the journal as an expiry, and a
        // channel that will not deliver journals `gate.delivery_failed` itself. What
        // reaches here is the store refusing an append — in which case there is nowhere
        // to record anything anyway, and the gate simply waits for the next sweep.
        //
        // AND A LOST RACE ARRIVES HERE TOO, as `E_SEQ_CONFLICT` out of
        // `#commitForOpenGate`. That is the correct outcome and not a failure: something
        // else got to this journal first, so this deadline writes nothing and the gate is
        // not reported as fired. It is retried on the next tick, which is the whole reason
        // losing a sweep write is affordable — see `#commitForOpenGate`.
      }

      // WHATEVER HAPPENED ABOVE, THE JOURNAL HAS MOVED — this iteration is what moved it,
      // or it threw because something else did. The next gate's decision has to be taken
      // at the seq it will be committed at, or it is the same stale-swap defect one
      // iteration later.
      p = await this.project(log);
    }
    return fired;
  }

  /**
   * Commit a timeout's write AT THE SEQ ITS DECISION WAS TAKEN — or write nothing.
   *
   * EVERY WRITE THE SWEEP CAN MAKE, AND WHETHER IT CHANGES THE CONDITION THAT TRIGGERED
   * IT. This table is the thing a future author needs and cannot derive cheaply, because
   * the answer lives in `projection.ts`'s fold rather than in the append. A row whose
   * answer is "no" is a row that licenses a SECOND sweep to take the same decision at the
   * seq the first one's write created — the swap succeeds, because the head it swaps
   * against is the one the first sweep just wrote. That is not a hypothetical: it is the
   * double-escalation defect, and it recurred once on the one path nobody had audited.
   *
   * | The append | What triggered it | Does the write change that? |
   * |---|---|---|
   * | `gate.escalated{tier, deadline}` | open gate, deadline reached, a next tier exists | **Yes** — the fold moves `deadline` and burns `tier`, so the gate is no longer due |
   * | `gate.timeout{default_action}` · `gate.decided` · `run.resumed` | open gate, deadline reached, a usable pre-authorized decision | **Yes, and only because all three are ONE append.** The timeout row alone is folded as a no-op by design (`default_action` is not an expiry), so a gate holding one is still `open` and still due |
   * | `gate.timeout{fail}` · `run.failed` | open gate, deadline reached, nothing left to try | **Yes** — the gate folds to `expired` and the run to `failed`, which every later tick refuses to write past |
   * | `gate.reminded{nth}` × every entry due now | open gate, its next unsent reminder is due | **Yes** — the fold counts the ROWS into `remindersSent`, so `#nextReminder` moves past every entry this append consumed and none of those instants is ever due again. That is what lets a nudge be ONE event with no companion; a reminder that folded to nothing would fire on every tick until the deadline. A LATE tick consumes the whole backlog here and sends ONE page (`#dueReminders`), so a row counts an entry CONSUMED rather than a message sent — which it never did anyway, since a batch's suppressed members write theirs too |
   * | `gate.delivered` / `gate.delivery_failed` | that an escalation was dispatched | **No — and it does not need to.** It is a receipt, not a decision: nothing in `sweepTimeouts` reads it, so a duplicate costs a duplicate row rather than a duplicate page. The page itself is bounded by the `gate.escalated` above it, which is protected |
   *
   * The rule the table encodes: **a sweep write that leaves its own trigger standing must
   * be in the same append as one that does not.** Adding a row here means answering this
   * column first — which is how the reminder row above got its shape: a `gate.reminded`
   * that moved no state would have been the `gate.timeout{default_action}` defect again,
   * one nudge per tick forever.
   *
   * WHICH SWEEP WRITES ARE SAFE TO LOSE, AND WHICH MUST BE EXACTLY-ONCE. There is more
   * than one writer on this journal now — a human, another sweeper, this process's own
   * next tick — so it is worth answering once, here, rather than per call site:
   *
   *   - **Losing a write is always safe.** The deadline that justified it is an absolute
   *     instant folded out of the journal, not a timer held in this process. A sweep that
   *     writes nothing leaves the gate exactly as it found it, and the next tick — in this
   *     process or in the one that replaces it — finds it due again and retries. Late is a
   *     property this design already accepts.
   *   - **Repeating one is not.** Every write here is a step in a chain that CANNOT be
   *     replayed idempotently. `gate.escalated` burns a tier and pages the next human up;
   *     two of them page two people about one question, and the second is the director
   *     being called about something the on-call has not seen — which is precisely what the
   *     per-tier clock reset exists to prevent. `gate.timeout · run.failed` ends a run, and
   *     a second one is a second terminal record in the store invariant 2 makes
   *     authoritative.
   *
   * So this method is built to fail towards silence: at-most-once, never at-least-once.
   *
   * THE SWAP IS ON `atSeq`, WHICH THE CALLER SUPPLIES, and that is the whole mechanism.
   * `atSeq` is the seq of the projection the decision was READ FROM — "this gate is open,
   * its deadline has passed, its next tier is 2". Committing at a seq this method read
   * ITSELF is not the same thing and does not work, which is how one gate came to escalate
   * twice: two sweeps folded the same seq, both decided to escalate, one wrote, and the
   * loser's own re-read then saw the journal the winner had just moved, found the gate
   * still `open` — an escalation does not close a gate — and swapped successfully against
   * its own fresh read. Both landed. Compare-and-swap is only a lock if you swap on the
   * value you decided on.
   *
   * THE RE-READ BELOW IS DEFENCE IN DEPTH, AND SAYING SO IS THE POINT OF THIS PARAGRAPH.
   * It has been described two contradictory ways in two waves — "decoration", which a probe
   * refuted, then "load-bearing on the one path whose `atSeq` was read after an earlier
   * write", which was true of that path and is no longer true of anything. **That path is
   * gone**: the default action's row and the decision it licenses are one append now, so
   * every `atSeq` reaching here is the seq of a fold nothing in this call has written past.
   * When `atSeq` is the sweep's own fold the store arbitrates completely — a gate a human
   * answered, or a run that has since ended, moved the head, so the swap fails on its own
   * and coming back `undefined` rather than throwing is only the difference between a quiet
   * tick and a noisy one.
   *
   * It stays because it is this method's CONTRACT rather than its mechanism — "commit only
   * while the gate is still open" — and the day a second caller supplies an `atSeq` it read
   * after a write of its own, the contract is what refuses `gate.timeout{fail}` and
   * `run.failed` landing on top of an approval a human gave inside the window. Read models
   * saying *this gate was approved and the run was killed for not answering it* are the
   * exact shape this method exists to prevent, and the guard that prevents it should not
   * have to be re-derived by whoever adds that caller.
   *
   * `undefined` means NOTHING WAS WRITTEN and the caller must not claim otherwise. A throw
   * means the store refused, `E_SEQ_CONFLICT` included; `sweepTimeouts` treats both as
   * "not fired". And it is a `commit` rather than the retrying `append` for the same
   * reason: retrying re-reads the head and lands a stale decision on a journal that has
   * moved underneath it, which is the defect written the long way round.
   */
  async #commitForOpenGate(
    log: RunLog,
    atSeq: Seq,
    gateId: GateId,
    events: readonly NewEvent[],
  ): Promise<GateRecord | undefined> {
    const p = await this.project(log);
    const gate = p === undefined ? undefined : gateOf(p, gateId);
    if (p === undefined || gate === undefined || gate.state !== "open") return undefined;
    // A TERMINAL RUN TAKES NO FURTHER WRITES FROM THE CLOCK, whichever gate asked. The
    // run-level check in `sweepTimeouts` is taken before the loop and again per iteration;
    // this is the one that holds for every path into the journal.
    if (isTerminal(p.status)) return undefined;
    // ATTRIBUTED TO THE GATE'S TASK — the one line that keeps the clock inside the trace.
    //
    // `telemetry/spans.ts` skips any event with no `taskId` before it reaches a single gate
    // arm, and none of the events built below carried one, so every timeout, escalation and
    // expiry this class has ever produced was invisible in a trace: the `loom.gate` span
    // stayed open, fell out of the end-of-journal sweep with `status: "unset"`, and read
    // exactly like a gate still waiting for a human. `raise` and `resolve` both stamp their
    // appends; the clock — the one writer a human is not watching — did not.
    //
    // Stamped on the APPEND rather than per event, which the store spreads over every event
    // that does not carry its own (`toRow`: `e.taskId ?? input.taskId`). That includes the
    // `run.failed` and `run.resumed` riding along, exactly as `raise` already stamps its
    // `run.suspended`.
    //
    // Conditionally, because a gate raised by an event carrying no `taskId` folds to `""`,
    // and attributing the clock's work to a Task that does not exist is worse than
    // attributing it to none — the same call `cancelOpenGates` makes.
    await log.commit(atSeq, events, gate.taskId === ("" as TaskId) ? {} : { taskId: gate.taskId });
    return gate;
  }

  /**
   * One nudge: the same tier, the same recipients, one journaled row — D7.2's `reminders`.
   *
   * WHAT IT DOES NOT DO IS THE SPECIFICATION. It does not move the deadline (that is
   * `gate.escalated`), it does not burn a tier, it does not touch the gate's state, and it
   * cannot decide anything. The only durable change is `remindersSent`, which is what makes
   * this reminder no longer the next one — the answer to `#commitForOpenGate`'s "does the
   * write change the condition that triggered it?", and the reason this is safe as a single
   * event rather than needing a companion in the same append.
   *
   * ONE NUDGE PER BATCH PER REMINDER, decided exactly as the escalation page is: from the
   * projection at `at.seq`, which is the seq the write below swaps on. A batch is one
   * question, so it is announced once, escalated once per tier, and nudged once per
   * reminder — three sites, one rule, and the rule is only sound because a batch's members
   * agree on their announcement policy (`deliveryDigest` covers the schedule as well as the
   * route, so a suppressed nudge is one that would have said the same thing to the same
   * people).
   *
   * AND THE SIBLING HAS TO STILL BE OPEN, which is where this was filed on the wrong side
   * of a split. It was built as a copy of `siblingReachedTier` — *has this already been
   * said?* — and inherited that rule's reading of a closed member: a sibling that sent the
   * nudge and was then answered still counted. But a reminder does not assert that
   * something was said, it asserts THAT THE QUESTION IS STILL OPEN, so the only sibling
   * whose nudge can stand in for this one is a sibling whose nudge is still outstanding.
   * Reproduced: a founder that ran its whole schedule and was approved, joined 1 s later by
   * a gate inside the window — the joiner was the batch's ONLY open member, its entire
   * declared schedule was suppressed against a message that had been read and closed, and
   * every entry was journaled as sent. That is the same shape as the tier-0 rule
   * (`announcementOutstanding`), and the opposite of the tier-N one, because *has this been
   * asked?* and *is this still being asked?* are different facts about the same batch.
   *
   * The ROWS stay per member, like `gate.escalated`'s: each member's own counter is what
   * the next tick reads, and a shared counter would be a second place to keep a fact the
   * journal already carries per gate. A LATE tick writes the whole backlog's rows in this
   * one append and sends at most one page — see `#dueReminders`.
   *
   * Returns whether the rows landed. `false` means something else moved the journal first —
   * a human answering, or another sweeper — and the nudge is simply still due.
   */
  async #remind(
    log: RunLog,
    at: RunProjection,
    gate: GateRecord,
    reminder: { readonly from: number; readonly through: number },
  ): Promise<boolean> {
    const nudged = siblingCarries(
      at,
      batchIdOf(gate),
      gate.gateId,
      (m) => m.state === "open" && (m.remindersSent ?? 0) >= reminder.through + 1,
    );
    const rows: NewEvent[] = [];
    for (let nth = reminder.from; nth <= reminder.through; nth++) {
      rows.push({
        type: "gate.reminded",
        payload: { gateId: gate.gateId, tier: gate.tier, nth },
        actor: SYSTEM_ACTOR("gate-broker"),
      });
    }
    const still = await this.#commitForOpenGate(log, at.seq, gate.gateId, rows);
    if (still === undefined) return false;

    const eph = this.#ephemeral.get(gate.gateId);
    if (this.#dispatcher !== undefined && eph?.delivery !== undefined && !nudged) {
      // `gate.tier`, and it is ALWAYS 0 here — `#nextReminder` owes nothing past tier 0,
      // because every declared instant falls strictly inside the tier-0 window and the first
      // escalation fires at or after that window's end. So this reads the tier rather than
      // writing `0` not because the two can differ today, but because the day they can, the
      // right answer is whoever holds the question NOW: reminding tier 0's recipients about
      // a gate that has moved to tier 1 is telling the wrong people, quietly.
      //
      // Do not read it as evidence that a late nudge follows an escalation. It does not, and
      // `A NUDGE THE SWEEPER SLEPT THROUGH IS DROPPED, NOT DELIVERED LATE` pins that — a
      // test asserting the opposite outlived the rule that made it impossible.
      await this.#dispatcher.deliver(log, this.#summaryOf(log.runId, still, eph.payload), eph.delivery, {
        tier: gate.tier,
      });
    }
    return true;
  }

  /**
   * One gate's timeout, in isolation. Throwing here costs this gate and no other.
   *
   * IT TAKES THE WHOLE PROJECTION, NOT JUST ITS SEQ, and that is not a convenience. `at`
   * is where every decision below was taken — the fold `gate` was read out of — and
   * `at.seq` is threaded to every write for the reason `#commitForOpenGate` gives at
   * length: a swap against a seq this method read itself arbitrates nothing. The
   * ESCALATION PAGE is a decision of exactly the same kind, taken about the same instant
   * ("has this batch already been paged at this tier?"), so it is read from this same
   * projection and not from a fresh one. Reading it back after the commit is what let two
   * overlapping sweeps each see the other's row and each conclude the page had gone out.
   *
   * Returns whether anything reached the journal, so `sweepTimeouts` reports as fired only
   * the gates it actually acted on.
   */
  async #fireTimeout(log: RunLog, at: RunProjection, gate: GateRecord, now: number): Promise<boolean> {
    const atSeq = at.seq;
    const eph = this.#ephemeral.get(gate.gateId);
    const declared = gate.onTimeout ?? "fail";
    // FAIL CLOSED when the pre-authorized decision did not survive the process that
    // raised it. Doing nothing here would leave the gate expired with a run suspended
    // behind it and no remaining path out — a hang dressed as a policy.
    const action = declared === "default_action" && eph?.defaultAction === undefined ? "fail" : declared;

    // THIS ARM IS REACHABLE ONLY FOR A CALLER-SUPPLIED `defaultAction`, and nothing has
    // proved it safe. `checkSla` refuses `onTimeout: "default_action"` for EVERY class
    // without inspecting any, and `assertDefaultActionIsSatisfiable` checks the decision's
    // SHAPE — kind, `mirrorOf`, `allowEdit` channels — never the irreversibility class;
    // `rehydrate` skips even that. A graph cannot reach here at all, because `scheduleOf`
    // forwards only `escalate|fail`. The claim that GRAPH014 rejects it per class was
    // copied into five places in the design corpus from this comment.
    if (action === "default_action" && eph?.defaultAction !== undefined) {
      // `idempotencyKey` is carried for the shape and is NOT what makes this once-only:
      // the broker's map is per process, so it never arbitrated between two of them. The
      // compare-and-swap below does, and it does it for a human, another sweeper and this
      // process's own next tick alike.
      const input: ResolveInput = {
        gateId: gate.gateId,
        decision: eph.defaultAction,
        actor: SYSTEM_ACTOR("gate-broker:timeout"),
        idempotencyKey: `timeout:${gate.gateId}`,
      };

      // REFUSED BEFORE ANYTHING IS WRITTEN, which is the whole reason this arm no longer
      // calls `resolve`. `rehydrate` can attach a default action the journal never
      // validated — `raise` would have refused it — so the sweep has to survive one that
      // turns out to be unusable, and the only expiry that is safe to write is one taken on
      // a journal this call has not already moved. Validating first makes the refusal a
      // decision at `atSeq` like every other decision here.
      //
      // A `rehydrate`d default action is also the one decision in this file that reaches
      // `#validate` having passed through NO compiler and NO door, so the acceptance-set
      // check there is what stands between an unreadable `defaultAction` and a gate the
      // clock silently approves. It is refused, and the gate expires instead.
      let checked: ResolveInput;
      try {
        checked = { ...input, decision: this.#validate(gate, input) };
      } catch (e) {
        return this.#expire(log, atSeq, gate, `expired: its default action was refused (${toLoomError(e).message})`);
      }

      // ONE APPEND: the clock's row, the decision it licenses, and the resume.
      //
      // THE ROW ALONE IS NOT A STATE CHANGE, and that is what made two appends unsafe.
      // `gate.timeout{default_action}` is folded as a deliberate no-op — the gate stays
      // `open` and its deadline does not move — so between the two appends there was a
      // journal on which the gate was still due, and any second sweeper folding at exactly
      // that seq compare-and-swapped successfully against the row this one had just
      // written. Same shape as the double escalation, on the one path that was not audited:
      // a write that does not change the condition it was decided on. Reproduced with a
      // second sweeper holding no pre-authorized decision of its own — it degraded to
      // `fail`, and wrote `gate.timeout{fail}` + `run.failed` on top of an approval that was
      // in flight. Merging the appends deletes the intermediate state rather than guarding
      // it; there is no window left to race, and a crash between them is now impossible
      // rather than merely unlikely.
      //
      // The decision is built by the same function `resolve` uses and validated by the same
      // chain, so "how does a gate get decided" still has one answer.
      const still = await this.#commitForOpenGate(log, atSeq, gate.gateId, [
        { type: "gate.timeout", payload: { gateId: gate.gateId, action }, actor: SYSTEM_ACTOR("gate-broker") },
        decidedEvent(gate, checked, now),
        resumedEvent(input.actor),
      ]);
      // A human answered inside the window. Their decision stands and the clock writes
      // nothing — not even the `gate.timeout{default_action}` row, which on a decided gate
      // would read as the SLA having had a say in an outcome it did not reach.
      if (still === undefined) return false;
      // THE SECOND CALLER, and the reason `#announceRemainder` is a method rather than a
      // line inside `resolve`: this arm closes a member of a batch WITHOUT going through
      // `resolve`, deliberately, so a batch whose only announced member was decided by the
      // clock is in exactly the state that method exists for.
      await this.#announceRemainder(log, at, gate);
      this.#releasePayload(gate.gateId);
      return true;
    }

    if (action === "escalate") {
      // THE CHAIN, and the clock reset that makes it a chain rather than a cascade.
      const spec = eph?.delivery;
      const next = spec === undefined ? undefined : nextTier(spec, gate.tier, now);

      if (spec === undefined || next === undefined) {
        // Exhausted. An escalation chain that runs out is an expiry, not a silent
        // return to waiting — otherwise the gate sits open forever with nobody left
        // to ask.
        return this.#expire(log, atSeq, gate, "exhausted its escalation chain with no decision");
      }

      // The new tier and the reset clock go into the JOURNAL, not into a `Map`.
      // The next sweep — in this process or in the one that replaces it — folds
      // them back out, so an escalation chain survives a deploy mid-chain.
      //
      // Conditional for the same reason the expiry is: escalating a gate a human has just
      // answered would move the tier and reset the deadline on a `decided` record, and the
      // `gate.escalated` fold has no open-only guard of its own to catch it.
      // ONE PAGE PER BATCH PER TIER — the same rule `raise` applies at tier 0, and the
      // reason D7.9 row 2 exists at all.
      //
      // Batching cut the tier-0 page from N to 1 and the escalation path had no notion of
      // a batch, so ONE merged question paged the escalation tier N TIMES. Measured on a
      // five-member batch with a 60 s SLA and one escalation tier: `1` page at tier 0 and
      // `5` at tier 1, all to `role:sre-manager`. The load reduction inverted exactly when
      // the queue is worst, which is when an SLA is breaching — and the second through
      // fifth pages are the director being called four more times about something the
      // on-call has not answered once.
      //
      // The `gate.escalated` ROWS stay per member and must: each burns that member's own
      // tier and resets that member's own clock, which is the state the next sweep folds.
      // What is bounded is the PAGE. The first member of a batch to reach a tier sends it;
      // a member arriving at a tier a sibling already reached does not, because the page
      // it would send says the same thing to the same people about the same manifest.
      //
      // TAKEN AT `atSeq`, BEFORE THE COMMIT, WHICH IS THE HALF THAT WAS WRONG. It used to be
      // read back from a FRESH projection after this member's own `gate.escalated` had
      // landed — so the window between the commit and the re-read was one in which a
      // sibling's row could arrive, and each of two overlapping sweeps saw the other's row
      // and concluded the page had already gone out. Reproduced with two brokers over one
      // store, interleaved at exactly that read: both members escalated to tier 1 and
      // **nobody was paged at all**. That is strictly worse than the N-times paging this
      // rule replaced — a silent non-page is the failure the whole delivery subsystem is
      // arranged to prevent. A READ IS NOT A LOCK; the swap is. Deciding it here makes the
      // page a decision at the same seq the write below swaps on, so the winner of the swap
      // is exactly the writer whose reading of "has a sibling been paged?" was true at the
      // instant it wrote. The first member to reach a tier is by definition the one that
      // saw no sibling there, and its swap succeeded, so exactly one page goes out.
      //
      // `gate`, not the post-commit record, and the predicate below asks NOTHING about the
      // sibling's state: a sibling that reached this tier and has since been decided WAS
      // paged, and forgetting that would page the tier again for a question it has already
      // seen. That is the one place this rule deliberately differs from the other two —
      // `raise`'s tier-0 test and `#remind`'s, both of which require a member that is still
      // OPEN, because both assert something about the present.
      //
      // WHAT THIS PAGE ASSERTS is *tier N now holds this question*, which stays true after
      // the member that triggered it is answered: the tier is responsible for the manifest,
      // and re-paging cannot make it more so. What that costs is stated rather than hidden —
      // a member whose siblings all reached this tier and were then answered is silent AT
      // THIS TIER, and is recovered by its own next escalation (it keeps its clock and its
      // chain) or by the expiry at the end of it, which fails the run loudly. **Reverses
      // when** a tier's page carries the manifest itself rather than pointing at a queue,
      // because then a page sent before this gate joined never mentioned it.
      //
      // `>= tier` rather than `=== tier`, because a member whose SLA is shorter can be two
      // tiers ahead: it has been paged at this tier and at the one above it, and paging this
      // tier again is a page about a question the tier has already been shown.
      const paged = siblingCarries(at, batchIdOf(gate), gate.gateId, (m) => m.tier >= next.tier);

      const to = tierRecipients(spec, next.tier);
      const still = await this.#commitForOpenGate(log, atSeq, gate.gateId, [
        {
          type: "gate.escalated",
          payload: { gateId: gate.gateId, tier: next.tier, to: formatRecipients(to), deadline: next.deadline },
          actor: SYSTEM_ACTOR("gate-broker"),
        },
      ]);
      if (still === undefined) return false;

      if (this.#dispatcher !== undefined && !paged) {
        // The record AS THE APPEND ABOVE LEAVES IT: `projection.ts`'s `gate.escalated` arm
        // sets exactly these two fields, so this is the fold, written out rather than
        // re-read. It was a second journal read per escalation, and the answer it gave was
        // the one this method must not use.
        const record: GateRecord = { ...still, tier: next.tier, deadline: next.deadline };
        await this.#dispatcher.deliver(log, this.#summaryOf(log.runId, record, eph?.payload), spec, {
          tier: next.tier,
        });
      }
      return true;
    }

    // Everything left is an expiry. `action` is `fail` by construction — a
    // `default_action` with no decision behind it was degraded above — and writing the
    // literal rather than the variable keeps that true if the degradation ever moves:
    // journaling `default_action` here would mark the gate NOT expired and re-open the
    // wedge from the other side.
    return this.#expire(log, atSeq, gate, "expired with no decision");
  }

  /**
   * End a gate the only way a timeout can end one it could not decide: expired, with the
   * run failed behind it.
   *
   * Both halves in ONE append. A `gate.timeout` without the `run.failed` leaves a run
   * suspended with no gate to answer, which is the hang this whole path exists to avoid.
   *
   * And CONDITIONAL, on `atSeq` — the seq the decision to expire was taken at — see
   * `#commitForOpenGate`. Returns whether the expiry landed; `false` means something got
   * there first and this deadline has nothing left to say.
   */
  async #expire(log: RunLog, atSeq: Seq, gate: GateRecord, reason: string): Promise<boolean> {
    const still = await this.#commitForOpenGate(log, atSeq, gate.gateId, [
      { type: "gate.timeout", payload: { gateId: gate.gateId, action: "fail" }, actor: SYSTEM_ACTOR("gate-broker") },
      {
        type: "run.failed",
        payload: {
          error: {
            class: "timeout",
            code: CODES.E_GATE_EXPIRED,
            message: `gate "${gate.gateId}" ${reason}`,
            retryable: false,
          },
        },
        actor: SYSTEM_ACTOR("gate-broker"),
      },
    ]);
    if (still !== undefined) this.#releasePayload(gate.gateId);
    return still !== undefined;
  }

  /**
   * Open gates for a run, MOST URGENT FIRST, joined with their (non-durable) payload where
   * available — D7.9 row 5.
   *
   * Everything except `payload` comes from the projection now. A caller that asks a
   * fresh process "who may approve this?" gets the same answer the process that raised
   * the gate would have given, which is the only version of that question worth
   * answering.
   *
   * THE ORDER IS PRESENTATION AND NOTHING ELSE. It changes which question a human reads
   * FIRST; it changes nothing about which gates exist, who may answer them, or what happens
   * if nobody does. `openGates` is untouched, and so are `nextDeadline`, `sweepTimeouts`
   * and every authorization path — all of which read the projection directly and would be
   * wrong to consult a queue's opinion. Do not confuse this with `Scheduler.select`'s
   * critical-path ordering either: that orders TASKS a worker will run, this orders
   * QUESTIONS a person will read, and the two have different inputs and different stakes.
   *
   * THE ORDER IS OVER THE DEADLINE THIS METHOD SHOWS, which is why `#deadlineOf` is handed
   * down rather than re-derived inside the rank. It has three sources and the ranking used
   * the first two, so a gate whose clock comes from the third — an SLA an operator
   * re-supplied through `rehydrate` for a journal that predates the field — was RENDERED
   * with the soonest deadline in a list whose docstring says MOST URGENT FIRST and PLACED
   * LAST, because the rank read it as having no clock at all. One response contradicting
   * itself is worse than either ordering: an operator reading the row believes the position.
   *
   * It costs the property the rank used to claim — that two processes agree on the order
   * for one journal — and that trade is the right way round. Two processes with different
   * rehydration already SHOW different deadlines, so they were never going to agree about
   * urgency; what they can be made to do is each agree with THEMSELVES. The pure-function
   * claim survives one level down: `gateQueueOrder` is a pure function of the projection and
   * of the deadline function it is given.
   *
   * See `gateQueueOrder` for the ranking itself and for the starvation argument.
   */
  async list(log: RunLog): Promise<readonly GateSummary[]> {
    const p = await this.project(log);
    if (p === undefined) return [];
    return gateQueueOrder(p, (g) => this.#deadlineOf(g)).map((g) =>
      this.#summaryOf(log.runId, g, this.#ephemeral.get(g.gateId)?.payload),
    );
  }

  /**
   * Re-attach payloads after a restart.
   *
   * The gate itself survives without this — the run stays suspended and the decision
   * still applies. What is lost is the rendered payload, which is a UI concern: the
   * console re-renders it from the pinned prompt and the projection.
   *
   * It takes a whole `GateRequest` for the caller's convenience and KEEPS ONLY the
   * ephemeral half. Approvers, `allowEdit` and any deadline passed here are ignored on
   * purpose: this method is reachable by anyone holding the broker, so letting it
   * re-declare authorization would reintroduce the defect it used to hide — a caller
   * could hand a restarted gate a new approvers list and the journal would never know.
   *
   * `slaMs` is the ONE exception, and a narrow one: it is consulted only for a gate whose
   * journal records neither a deadline nor an SLA, and it is measured from the journaled
   * raise. See `EphemeralGate.slaMs` for why that cannot extend anything.
   */
  rehydrate(gateId: GateId, req: GateRequest): void {
    const existing = this.#ephemeral.get(gateId);
    const next = ephemeralOf(req);
    // IT MAY ADD A PAYLOAD AND IT MAY NEVER TAKE ONE AWAY, which this replaced wholesale.
    //
    // `Engine.rehydrateGates` builds its request from the journal, and the journal does not
    // carry the rendered payload — it passes `payload: undefined` deliberately, "absent rather
    // than faked". Replacing meant calling this on a gate whose payload was in memory ERASED it.
    // Measured through the console API: a gate raised in-process answered with
    // `payload.state = {note: "timing probe"}` for the first two queries and `null` from the
    // third, one gate-clock tick later. What the approver lost is the thing they are approving —
    // `Engine.openGates`' own docstring calls that "a gate that gets approved on trust, which is
    // the failure mode the whole oversight layer exists to avoid".
    //
    // Fixed HERE rather than in the caller that exposed it, because the contract is this
    // method's: its name and its docstring both say re-ATTACH, and a caller cannot know whether
    // some other component holds a live payload for the gate it is arming.
    this.#ephemeral.set(
      gateId,
      existing?.payload !== undefined && next.payload === undefined ? { ...next, payload: existing.payload } : next,
    );
  }

  async project(log: RunLog): Promise<RunProjection | undefined> {
    const events = [];
    for await (const e of log.read(1)) events.push(e);
    return foldRun(events);
  }
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export interface GateSweeperOptions {
  readonly store: StateStore;
  /**
   * The broker that RAISED the gates, not a fresh one.
   *
   * A gate's non-durable half — its rendered payload, its pre-authorized default action,
   * and above all its `DeliverySpec` — lives in the broker that raised it. Sweeping with a
   * different broker finds no delivery spec for any gate, so `#fireTimeout` concludes every
   * escalation chain is exhausted and EXPIRES gates that should have escalated. Silently,
   * and fail-closed, which is the kind of wrong that gets discovered a quarter later.
   */
  readonly broker: HumanGateBroker;
  /** Publishes what the sweep appends, so a console tailing a run sees the expiry. */
  readonly bus?: EventBus;
  readonly now?: () => number;
  /**
   * How many runs ONE TICK considers, newest first. Default 500.
   *
   * It is a horizon and a memory bound at once — see the class docstring for what falls
   * outside it. Raise it for a deployment with more than this many runs in its store;
   * there is no value at which the horizon stops existing.
   */
  readonly limit?: number;
}

export interface SweepReport {
  /** The instant the tick was taken at, as supplied. */
  readonly at: number;
  /** Runs the listing returned. The horizon, measured. */
  readonly considered: number;
  /** Runs whose journal tail this tick actually read, because their head had moved. */
  readonly caughtUp: number;
  /** Runs whose gates were swept, i.e. that had a gate due at `at`. */
  readonly swept: number;
  readonly fired: readonly GateId[];
  /**
   * Runs whose sweep threw — a store that would not read or would not write.
   *
   * Counted rather than raised, for the reason `sweepTimeouts` gives one level down: a
   * loop over every run that aborts on the first failure is a loop in which one bad run
   * switches off every other run's SLA. They stay in the cursor set and are retried on the
   * next tick. A deployment whose tick reports a non-zero `failed` for long has a store
   * problem, and this number is how it finds out.
   */
  readonly failed: number;
}

/**
 * Per-run state carried BETWEEN ticks, so a tick is cheap.
 *
 * The fold is the expensive part and it is the part that does not need repeating: a
 * journal is append-only, so last tick's projection plus this tick's tail is this tick's
 * projection. `RunFolder` is the same incremental fold the executor uses; there is
 * deliberately no second, narrower one here, because a second fold of "is this run
 * terminal" would be a second definition of terminal.
 */
interface RunCursor {
  readonly log: RunLog;
  /**
   * `undefined` for a run this cursor has not folded, and for a run that has ENDED.
   *
   * Dropping a terminal run's projection is what keeps the memory bound proportional to
   * LIVE runs rather than to every run the listing has ever returned — and most runs in a
   * store are finished. A rewind moves a terminal run's head, which re-folds from seq 1;
   * that is rare and correct.
   */
  folder: RunFolder | undefined;
  /** The head this cursor's state describes. Compared against the listing's, per tick. */
  headSeq: Seq;
  terminal: boolean;
  /** The earliest deadline among the run's open gates, per `broker.nextDeadline`. */
  due: number | undefined;
}

/**
 * The gate clock: one externally-driven tick, across every run in view.
 *
 * `HumanGateBroker.sweepTimeouts` takes ONE run's log; a deployment has many, and until
 * this class existed nothing called it for any of them. So SLA deadlines never expired,
 * escalation tiers never fired, and a gate declaring `onTimeout: "fail"` waited forever in
 * `bin/loom`. This is the thing that walks the runs. It still starts no timer — see
 * `Engine.sweepGates`, which is where a deployment reaches it.
 *
 * WHAT A TICK COSTS, because the naive version is O(runs × events) and would be the first
 * thing to fall over:
 *
 *   - ONE `listRuns(limit)`. On SQLite that is an indexed scan of `run_head`, not of the
 *     journal.
 *   - For each listed run whose head has MOVED since the last tick, a read of the events
 *     since — O(Δ), not O(history). A run nobody has written to costs a number comparison
 *     and nothing else: no read, no fold, no allocation.
 *   - A full journal fold only for a run this process has never folded (once, ever), for a
 *     run whose gate is actually DUE, where `sweepTimeouts` folds on its own before
 *     appending, and once more per REWIND, which invalidates what is already folded. A due
 *     gate resolves itself — it escalates, resetting its deadline, or it expires, ending
 *     the run — so a run does not stay due tick after tick.
 *
 * Memory is one projection per LIVE listed run, and terminal runs drop theirs. Both are
 * bounded by `limit`.
 *
 * WHAT IT CAN SEE, and what it still cannot. This USED to read `listRuns(limit)` — ordered by
 * run id descending, and run ids are minted from a timestamp — so a tick saw the `limit` most
 * recently CREATED runs and nothing older. A gate raised on a run that newer runs had since
 * pushed out of that window lost its clock on the next PROCESS RESTART: no escalation, no
 * expiry, a question standing in front of a human with nothing behind it. That is REGISTER
 * **B7**, and it is closed: the listing is now `{ raisedAGate: true }`, which orders by the
 * most recent `gate.raised` instead, so only runs that have EVER gated compete for the slots.
 *
 * The bound is the same number and it still bounds something. `limit` now caps *gated* runs
 * rather than all runs, so the residual hole is a deployment with more than `limit` runs
 * holding gates at once — a far smaller set than "runs created", and one whose size an
 * operator can reason about from their own SLA policy. Size `limit` above the number of gates
 * a deployment expects to have open simultaneously.
 *
 * `raisedAGate` is a SUPERSET of "has an open gate", deliberately: openness is a property of
 * the fold and the listing is an index lookup. The sweeper folds anyway, so narrowing further
 * in the store would buy nothing and would need a read model to keep consistent.
 */
export class GateSweeper {
  readonly #store: StateStore;
  readonly #broker: HumanGateBroker;
  readonly #bus: EventBus | undefined;
  readonly #now: () => number;
  readonly #limit: number;
  /** runId → cursor, rebuilt each tick from the listing, so it is bounded by `limit`. */
  #cursors = new Map<RunId, RunCursor>();

  constructor(opts: GateSweeperOptions) {
    this.#store = opts.store;
    this.#broker = opts.broker;
    this.#bus = opts.bus;
    this.#now = opts.now ?? Date.now;
    this.#limit = boundedLimit(opts.limit);
  }

  /**
   * One tick. Total over the runs in view, and safe to call as often as you like.
   *
   * IDEMPOTENT IN THE ONLY SENSE THAT MATTERS: two sweeps at the same `now`, or two
   * sweepers racing on the same store, cannot double-expire or double-escalate a gate.
   * Not because this method coordinates — it does not — but because every write it
   * ultimately causes goes through `#commitForOpenGate`, which compare-and-swaps on the
   * seq THE DECISION WAS TAKEN AT. The loser writes nothing and reports nothing as fired.
   * The same mechanism is what makes a sweep racing a HUMAN safe.
   *
   * That sentence used to end "…on the journal's seq", and the code swapped on a seq it
   * re-read itself, which arbitrates between two sweeps only when they happen to re-read
   * at the same moment. Two sweeps that overlapped instead of alternating both escalated
   * the same gate. If this paragraph and `#commitForOpenGate` ever disagree again, the
   * paragraph is the one that is wrong.
   */
  async sweep(now = this.#now()): Promise<SweepReport> {
    // GATED RUNS, ORDERED BY THEIR MOST RECENT GATE — not the newest runs. This was
    // `listRuns(this.#limit)`, which orders by run id descending, so a tick saw the `limit`
    // most recently CREATED runs and nothing older: a gate raised on a run that newer runs
    // had since pushed out of that window never had its deadline checked again after a
    // restart, and its SLA never fired. REGISTER B7. The `limit` is unchanged; what changed
    // is what competes for the slots, so a deployment that creates a million runs and gates
    // ten of them now has all ten in view.
    const rows = await this.#store.listRuns(this.#limit, { raisedAGate: true });
    const live = new Map<RunId, RunCursor>();
    const fired: GateId[] = [];
    let caughtUp = 0;
    let swept = 0;
    let failed = 0;

    for (const row of rows) {
      const cursor = this.#cursors.get(row.runId) ?? this.#newCursor(row.runId);
      live.set(row.runId, cursor);

      try {
        if (row.headSeq !== cursor.headSeq) {
          await this.#catchUp(cursor, row.runId);
          caughtUp++;
        }
        // THE SKIP THAT MAKES THIS AFFORDABLE. A run that has ended, a run with no gate,
        // and a run whose earliest deadline is still in the future are all decided from
        // three fields on the cursor, with no I/O at all.
        if (cursor.terminal || cursor.due === undefined || now < cursor.due) continue;

        swept++;
        fired.push(...(await this.#broker.sweepTimeouts(cursor.log, now)));
        // The sweep appended. Fold what it wrote NOW, so the cursor never describes a
        // journal older than this tick's own writes.
        //
        // IT IS A COST GUARD AND NOT A CORRECTNESS ONE. This comment used to say the fold
        // stops a second sweep re-considering a gate this one just closed, and that is not
        // what it does: the next tick meets a head that has moved, folds it, and reaches the
        // same answer one journal read later. What this buys is that read — every tick, for
        // every run whose gate the clock has just touched. Reverting it turned NOTHING red
        // for a whole hardening wave, which is what a cost claim nobody measures is worth;
        // it is pinned now by a test that counts reads rather than outcomes.
        await this.#catchUp(cursor, row.runId);
      } catch {
        // ONE RUN MUST NOT ABORT THE TICK, for the reason one gate must not abort a run's
        // sweep: this is the outer loop of the same total operation, and a store that
        // refuses one run's read would otherwise switch off every other run's SLA for as
        // long as it kept refusing. The cursor stays, so the next tick tries again, and
        // the count reaches the caller.
        failed++;
      }
    }

    this.#cursors = live;
    return { at: now, considered: rows.length, caughtUp, swept, fired, failed };
  }

  #newCursor(runId: RunId): RunCursor {
    return {
      log: new RunLog(runId, {
        store: this.#store,
        now: this.#now,
        ...(this.#bus === undefined ? {} : { bus: this.#bus }),
      }),
      folder: undefined,
      headSeq: 0 as Seq,
      terminal: false,
      due: undefined,
    };
  }

  /** Fold the tail this cursor has not seen, and re-derive the three fields a tick reads. */
  async #catchUp(cursor: RunCursor, runId: RunId): Promise<void> {
    const folder = cursor.folder ?? new RunFolder();
    folder.push(await this.#tail(runId, (folder.lastSeq + 1) as Seq));
    // A rewind changed what events ALREADY FOLDED mean, so the incremental state is not
    // recoverable and the fold starts over — ONCE PER REWIND, not once per tick. This used
    // to build a FRESH folder, which is the one thing it must not do: a new folder has not
    // been told what the marker suppresses, so it stopped at the same marker and produced
    // the run as it stood BEFORE the rewind. The cursor then described a run that no longer
    // existed — its head never matched, so every later tick paid this same double read, and
    // a gate the rewind had re-opened was invisible to all of them. See `RunFolder.restart`.
    //
    // A loop rather than an `if`: a second rewind can arrive inside the re-fold. Each pass
    // stops at the first marker it has not been told about, so each pass gets strictly
    // further than the last, and a journal holds finitely many markers.
    //
    // `reached` MEASURES that argument instead of assuming it. A loop whose termination
    // rests on another object keeping its promise is a loop that livelocks the moment that
    // promise breaks — and a wedged tick is the worst failure available here, because it
    // stops every OTHER run's clock too, silently, in a background timer nobody is
    // watching. Refusing turns it into `SweepReport.failed`, which is retried and counted.
    let reached = -1;
    while (folder.stale) {
      if (folder.lastSeq <= reached) {
        throw err.internal(
          CODES.E_TRACE_INCONSISTENT,
          `run ${runId} did not fold past its rewind marker at seq ${folder.lastSeq + 1} on a second pass`,
          { details: { runId, lastSeq: folder.lastSeq } },
        );
      }
      reached = folder.lastSeq;
      folder.restart();
      folder.push(await this.#tail(runId, 1 as Seq));
    }

    const p = folder.projection();
    cursor.headSeq = (p?.seq ?? 0) as Seq;
    cursor.terminal = p !== undefined && isTerminal(p.status);
    cursor.due = p === undefined ? undefined : this.#broker.nextDeadline(p);
    cursor.folder = cursor.terminal ? undefined : folder;
  }

  async #tail(runId: RunId, fromSeq: Seq): Promise<readonly JournalEvent[]> {
    const out = [];
    for await (const e of this.#store.read(runId, fromSeq)) out.push(e);
    return out;
  }
}

/**
 * How many runs a tick looks at when nobody says.
 *
 * Sized so the default is right for a deployment small enough not to have thought about
 * it, and wrong loudly rather than quietly for one that is not: 500 rows of `run_head` per
 * tick is nothing, and 500 live projections is a bound an operator can reason about. See
 * `GateSweeper`'s docstring for what falls outside it.
 */
const DEFAULT_SWEEP_LIMIT = 500;

/**
 * `GateSweeperOptions.limit`, refused rather than clamped — the same family as
 * `PolicyEngineOptions.interventionWindowMs` and `ControlPlaneOptions.requestTimeoutMs`.
 *
 * `Math.max(1, …)` looks like a floor and is not one for the values that matter. Measured on
 * node v24.16.0: `Math.max(1, NaN)` is `NaN`, `Math.max(1, Infinity)` is `Infinity`, and
 * `Math.max(1, 1.5)` is `1.5`. All three go straight into `listRuns(this.#limit)`, and what a
 * store does with them is already on record one layer up: SQLite reads `LIMIT -1` as NO LIMIT
 * and throws `datatype mismatch` on a fraction, while the memory store's `slice(0, n)` answers
 * differently again. So the number that decides how much of a deployment the SLA sweep can SEE
 * became either everything, nothing, or a 500.
 *
 * A refusal rather than a clamp for the reason `positive` gives in `cli.ts`: a clamp silently
 * substitutes a number the operator did not choose, and this one decides whether gates expire
 * at all. An unstartable process beats a sweeper that quietly watches five runs.
 */
function boundedLimit(supplied: number | undefined): number {
  if (supplied === undefined) return DEFAULT_SWEEP_LIMIT;
  if (!Number.isInteger(supplied) || supplied < 1) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `GateSweeperOptions.limit is ${String(supplied)}, which is not a whole number of runs (1 or more). ` +
        `It bounds how many runs the SLA sweep can see, so a value a store reads as "no limit" or ` +
        `refuses outright decides whether gates expire at all`,
      { details: { limit: supplied } },
    );
  }
  return supplied;
}

// ---------------------------------------------------------------------------
// Saturation control — D7.9 rows 2 and 3
// ---------------------------------------------------------------------------

/**
 * The `GateRecord` a `gate.raised` about to be written will fold to.
 *
 * It exists because both saturation controls compare THIS gate against gates that are
 * already records, and comparing a request against a record means writing the comparison
 * twice — once per shape — which is how the two spellings come to disagree about whether
 * `allowEdit: undefined` and `allowEdit: []` are the same thing. Every field is built the
 * way `projection.ts`'s `gate.raised` arm builds it, and it is the same object `#validate`
 * is handed for the dedup path, so the check that authorizes an inherited decision runs
 * against the record the journal is about to hold.
 *
 * `raisedAtSeq` is `0` because the append has not happened; nothing here reads it, and
 * `#summarize` already carries the same placeholder for the same reason.
 */
/**
 * What `contentDigest` is taken over, in ONE place.
 *
 * Two sites compute it — `raise`, which journals it, and `#summarize`, which hands it to a
 * console before any projection exists — and they have to agree, because the console shows
 * the approver a digest and the journal is what a later dispatch checks against. Two
 * spellings of one rule is the defect this file's `prospectiveRecord` next door already
 * exists to prevent, arriving one field over.
 *
 * See `GateRequest.binding` for why the digest is not simply `digest(payload)`.
 */
function bindingDigestOf(req: GateRequest): string {
  return digest(req.binding === undefined ? req.payload : req.binding);
}

function prospectiveRecord(
  req: GateRequest,
  gateId: GateId,
  contentDigest: string,
  raisedAt: number,
  deadline: number | undefined,
): GateRecord {
  return {
    gateId,
    taskId: req.taskId,
    nodeId: req.nodeId,
    policyRef: req.policyRef,
    contentDigest,
    raisedAtSeq: 0 as Seq,
    raisedAtTs: raisedAt,
    state: "open",
    tier: 0,
    ...(req.approvers === undefined ? {} : { approvers: req.approvers }),
    // THE FIFTH BUILDER, and the one a reader forgets. This is the record `#validate` is
    // handed on the dedup path, so a missing exclusion here makes an SoD gate compare EQUAL
    // to a non-SoD one under `sameAuthority` — and inherit its decision in the append that
    // raises it, from a person the rule exists to bar.
    ...(req.excludedApprovers === undefined ? {} : { excludedApprovers: req.excludedApprovers }),
    ...(req.allowEdit === undefined ? {} : { allowEdit: req.allowEdit }),
    ...(req.slaMs === undefined ? {} : { slaMs: req.slaMs }),
    ...(deadline === undefined ? {} : { deadline }),
    ...(req.onTimeout === undefined ? {} : { onTimeout: req.onTimeout }),
    ...(req.mirrorOf === undefined ? {} : { mirrorOf: req.mirrorOf }),
  };
}

/**
 * The batch this gate joins, the batch it starts, or `undefined` for no batching.
 *
 * THE MERGE PREDICATE IS THE WHOLE SAFETY ARGUMENT, so it is stated here rather than
 * spread over the call site. One decision on a batch closes every member, so a member may
 * only join a batch whose authorization is identical to its own:
 *
 *   - the same `policyRef`. That is the D7.2 oversight policy the gate was raised under,
 *     and for a gate the POSTURE floor raised — a tool node with no `humanGate` block —
 *     it is `policy:<nodeId>`, so those batch only with siblings of their own node. It is
 *     therefore the one journaled field that stands in for "the same irreversibility
 *     class and the same posture decided that this had to be asked", which nothing on a
 *     `GateRecord` states directly;
 *   - the same approvers, so nobody's click closes a gate they were not named on;
 *   - the same `edit` allow-list, distinguishing absent from `[]`, because the members
 *     remain individually resolvable and a widened list would widen them;
 *   - neither a subgraph mirror. A mirror's decision is forwarded into another run; two
 *     of them in one click would be two forwards, and `resolveBatch` is not that.
 *
 * AND — the second half, which was missing and is the reason this function's shape
 * changed — the same GOVERNANCE: the same batching `key`, the same `maxBatch`, the same
 * `windowMs`, and the same delivery route. Those four are not properties of a gate's
 * authority but of the BATCH, and they are read out of the batch's own journaled rows
 * (`batchGovernance`) rather than off the applicant's `BatchingSpec`.
 *
 * > **THE FOUNDING SPEC GOVERNS THE BATCH FOR ITS WHOLE LIFE. A GATE THAT DISAGREES WITH
 * > IT DOES NOT JOIN IT.**
 *
 * Every one of those four used to be evaluated against the JOINING gate instead, and three
 * of them widened what one click could do:
 *
 *   - `maxBatch` — the cap on the blast radius of a single click, which is the entire
 *     safety argument of D7.9 row 2. Measured: a batch founded under `maxBatch: 2` and
 *     joined by nine gates declaring `maxBatch: 20` came back as ONE batch of TEN. One
 *     click, five times the authorised radius, and nothing in the journal said the cap had
 *     moved because nothing in the journal had ever carried it;
 *   - `windowMs` — a batch founded under a 1 s window took a joiner that arrived 100 s
 *     later, because the newcomer declared an hour. A window a newcomer can extend is not
 *     a window;
 *   - the delivery route — see `deliveryDigestOf`. Two gates whose channels, recipients and
 *     redact list differed entirely merged, and exactly one notification went out, on the
 *     founder's route. Merging is what suppresses the joiner's own page, so agreeing about
 *     where the page goes is a precondition for merging rather than a detail of it.
 *
 * `key` was already compared against the journal and stays exactly as it was; it is folded
 * into the governance so there is ONE predicate to read rather than four scattered ones.
 *
 * What is deliberately NOT compared, so the omissions are decisions rather than gaps:
 *
 *   - `contentDigest`. Batching merges DIFFERENT questions of one class — five hosts, five
 *     payloads — which is what makes it batching rather than dedup, and the manifest shows
 *     each member's own digest. (`sameQuestion` adds it, for dedup, where it is required.)
 *   - `slaMs` / `deadline` / `onTimeout`. Each member keeps its own clock in the journal and
 *     fires its own timeout; the batch never applies one member's clock to another, and
 *     `GateBatch.deadline` shows the earliest precisely because it is the instant the batch
 *     stops being answerable as a whole.
 *   - `defaultAction`. Pre-authorized per gate, never read for a sibling.
 *
 * A newcomer that fails any of these does NOT throw and does not silently merge: it
 * starts its own batch. That is the "split" reading of D7.9 rather than a compile error,
 * because the disagreement is between two RUNTIME gates — same node, different approvers
 * only if something upstream made them different — and refusing the graph could not see
 * it. The split is visible: two batches, each with its own manifest.
 *
 * The window is anchored on the batch's FIRST member and the cap counts EVERY member it
 * has ever had, decided ones included. Both are properties of the batch, not of what is
 * still open, so a batch cannot be kept alive by answering it or refilled after it fills.
 */
function batchFor(
  p: RunProjection | undefined,
  prospective: GateRecord,
  req: GateRequest,
  now: number,
): BatchMarker | undefined {
  const spec = usableBatching(req.batching);
  if (spec === undefined || prospective.mirrorOf !== undefined) return undefined;
  // The SCHEDULE as the broker would actually run it, not as the request declared it: an
  // unusable list is no list at all (`usableReminders`), and two gates whose declarations
  // differ only in a part neither will ever run announce the same way and should merge.
  const want = markerFor(prospective.gateId, spec, req.delivery, usableReminders(req.reminders, req.slaMs));

  let bestId: GateId | undefined;
  let bestAnchor = Number.POSITIVE_INFINITY;
  for (const [id, members] of p === undefined ? [] : gateBatchGroups(p, "any")) {
    // THE BATCH'S OWN POLICY, OR NO JOIN. `undefined` here means the members do not agree
    // among themselves about their governance, or the journal never recorded any — a batch
    // whose cap nobody can read is a batch nothing may be added to.
    const gov = batchGovernance(members);
    if (gov === undefined) continue;
    if (!sameGovernance(gov, want)) continue;
    // `gov`, never `spec` — and they are equal by the line above, which is exactly why it
    // has to be written this way round. Reading the cap off the applicant is the defect;
    // reading it off the batch after proving the applicant agrees is the fix, and the next
    // reader must be able to see which one this is without re-deriving the equality.
    if (members.length >= gov.maxBatch) continue;
    let anchor = Number.POSITIVE_INFINITY;
    for (const m of members) anchor = Math.min(anchor, m.raisedAtTs);
    if (now - anchor > gov.windowMs) continue;
    if (!members.every((m) => sameAuthority(m, prospective))) continue;
    // Deterministic and oldest-first, so a batch FILLS before a second one opens next to
    // it: the tie-break on id is there because two batches can share an anchor instant
    // and "whichever the map yielded first" is not a rule anything states.
    if (anchor < bestAnchor || (anchor === bestAnchor && (bestId === undefined || id < bestId))) {
      bestId = id;
      bestAnchor = anchor;
    }
  }
  return bestId === undefined ? want : { ...want, id: bestId };
}

/** What `gate.raised.batch` carries: the batch's identity AND the policy that governs it. */
interface BatchMarker {
  readonly id: GateId;
  readonly key: string;
  readonly windowMs: number;
  readonly maxBatch: number;
  readonly deliveryDigest?: string;
}

/** The marker a gate would write if it founded its own batch. */
function markerFor(id: GateId, spec: BatchingSpec, delivery: DeliverySpec | undefined, reminders: readonly number[] | undefined): BatchMarker {
  const deliveryDigest = deliveryDigestOf(delivery, reminders);
  return {
    id,
    key: spec.key,
    windowMs: spec.windowMs,
    maxBatch: spec.maxBatch,
    ...(deliveryDigest === undefined ? {} : { deliveryDigest }),
  };
}

/**
 * HOW THIS BATCH IS ANNOUNCED, as one number — the same trick `batchManifestDigest` uses.
 *
 * A batch is announced ONCE, by the member that founds it (`raise`'s `merged` test),
 * escalated ONCE per tier by the first member to reach it, and nudged ONCE per reminder by
 * the first member to owe it. Every other member's announcement is therefore never sent —
 * which is the load reduction, and is also a silent substitution of one gate's policy for
 * another's unless the two agree. So they must agree, and agreeing is the only question a
 * merge has to ask about it.
 *
 * IT COVERS THE SCHEDULE AS WELL AS THE ROUTE, and the field keeps the name it is journaled
 * under. `reminders` arrived after this digest did, and suppressing a member's nudge because
 * a sibling sent ITS nth is only honest if the two nth's are the same POLICY — otherwise it
 * is the `channels`/`recipients`/`redact` substitution again, one field over and quieter,
 * because a nudge that never goes out leaves no trace at the place it was owed. WHERE and
 * WHEN are one policy for this purpose; the name says `delivery` because that is what
 * `gate.raised.batch.deliveryDigest` says, and renaming a journaled field to improve a
 * comment is a trade nobody wants.
 *
 * THE SAME OFFSETS, NOT THE SAME INSTANTS, and this paragraph used to say the second one.
 * `#nextReminder` anchors every entry on the member's OWN `raisedAtTs`, and a batch admits
 * members up to `windowMs` apart — that is what a window is — so member B's nth is due up
 * to a window after member A's. The digest gives equality of the DECLARED SCHEDULE, which
 * is what makes a suppressed nudge one that would have said the same thing to the same
 * people on the same channels; it does not and cannot make the two due at one instant. What
 * carries the rest of the argument is `#remind`'s liveness conjunct: the sibling standing
 * in for this nudge has to be open, so the message being pointed at is one somebody is
 * still holding rather than one they read a window ago.
 *
 * A DIGEST RATHER THAN THE SPEC, because the spec must not go in the journal. `redact` names
 * the fields a channel may not see and `recipients` names people; a merge predicate needs
 * neither, it needs equality, and equality is all a digest discloses. It also keeps
 * `EphemeralGate`'s rule intact: the route still lives only in this broker's memory, and
 * what the journal gains is a fact ABOUT the route, not the route.
 *
 * `undefined` when a gate declared neither, which is a real configuration (a broker with no
 * dispatcher, a console-only deployment) and must compare equal to another gate that
 * declared neither — not to one that declared something.
 */
function deliveryDigestOf(spec: DeliverySpec | undefined, reminders: readonly number[] | undefined): string | undefined {
  if (spec === undefined && reminders === undefined) return undefined;
  return digest({ ...(spec === undefined ? {} : { spec }), ...(reminders === undefined ? {} : { reminders }) });
}

/**
 * The policy a batch is governed by, read from its own rows, or `undefined` for no join.
 *
 * REQUIRES EVERY MEMBER TO AGREE, not just the first. `members[0]` is the founder on any
 * journal `raise` produced — the group is sorted by `raisedAtSeq` — but a hand-written or
 * repaired one can hold members whose markers disagree, and "the first row wins" would let
 * whoever wrote that journal choose the cap. Unanimity is the fail-closed reading: a batch
 * that cannot state its own policy accepts no new members, and the newcomer starts its own.
 *
 * IT RE-VALIDATES THE NUMBERS, for the reason `usableBatching` does. These come out of a
 * journal, so `windowMs` can be `NaN` or `"60000"`, and `members.length >= NaN` is `false` —
 * a cap that silently is not one. Everything below is refused the same way an undeclared
 * batching block is: no governance, no join, no batch grows.
 */
function batchGovernance(members: readonly GateRecord[]): BatchMarker | undefined {
  const first = members[0]?.batch;
  if (first === undefined) return undefined;
  const { id, key, windowMs, maxBatch, deliveryDigest } = first;
  if (typeof key !== "string" || key.trim() === "") return undefined;
  if (!isPositiveWholeMs(windowMs)) return undefined;
  if (typeof maxBatch !== "number" || !Number.isSafeInteger(maxBatch) || maxBatch < 2) return undefined;
  if (deliveryDigest !== undefined && typeof deliveryDigest !== "string") return undefined;
  const gov: BatchMarker = {
    id,
    key,
    windowMs,
    maxBatch,
    ...(deliveryDigest === undefined ? {} : { deliveryDigest }),
  };
  for (const m of members) if (!sameGovernance(m.batch, gov)) return undefined;
  return gov;
}

/**
 * Whether two batch markers name the same policy. `id` is deliberately not compared —
 * it is the batch's identity, not its governance, and the applicant's marker still
 * carries its own gateId at the point this is asked.
 */
function sameGovernance(a: GateRecord["batch"] | undefined, b: BatchMarker): boolean {
  if (a === undefined) return false;
  return (
    a.key === b.key && a.windowMs === b.windowMs && a.maxBatch === b.maxBatch && a.deliveryDigest === b.deliveryDigest
  );
}

/**
 * Gates that carry a batch, grouped by batch id, every list in journal order.
 *
 * A `Map` rather than an object, and that is not a style choice: a batch id comes out of
 * a journal, `p.gates["__proto__"]` is the hazard `gateOf` exists for, and a `Map` keyed
 * by an arbitrary string has no prototype to reach. A hand-written journal naming a batch
 * `__proto__` therefore produces a batch nobody can look up rather than one that resolves
 * through `Object.prototype`.
 */
function gateBatchGroups(p: RunProjection, which: "open" | "any"): Map<GateId, readonly GateRecord[]> {
  const ordered = Object.values(p.gates)
    .filter((g) => (which === "any" || g.state === "open"))
    .sort((a, b) => a.raisedAtSeq - b.raisedAtSeq);
  const groups = new Map<GateId, GateRecord[]>();
  for (const g of ordered) {
    // `batchIdOf`, not `g.batch!.id`. The old test was `g.batch !== undefined`, which a
    // journaled `null` passes — and then the non-null assertion beside it threw a raw
    // `TypeError` out of whatever asked. That was survivable while only the saturation
    // paths grouped; `list` reads this now, so one corrupt marker took out an operator's
    // whole gate queue, on the read they would be making to find out what was wrong.
    const id = batchIdOf(g);
    if (id === undefined) continue;
    const bucket = groups.get(id);
    if (bucket === undefined) groups.set(id, [g]);
    else bucket.push(g);
  }
  return groups;
}

/**
 * The batch id this gate carries, or `undefined` — a TOTAL read of a journaled value.
 *
 * `GateRecord.batch`'s type is a claim about what the APPENDER wrote, not about what a
 * journal holds: the fold passes the marker through verbatim (invariant 2), so `null`, an
 * array, a string and a bag with no `id` are all reachable. Every one of them used to reach
 * a `.id` on a non-null assertion. A gate whose marker cannot be read is treated as a gate
 * in NO batch — it pages for itself, escalates for itself and is decided one at a time,
 * which is the degradation `batchGovernance` already chose for a batch that cannot state
 * its own policy.
 */
function batchIdOf(g: GateRecord): GateId | undefined {
  const b: unknown = g.batch;
  if (!isPlainBag(b)) return undefined;
  const id: unknown = b["id"];
  return typeof id === "string" && id !== "" ? (id as GateId) : undefined;
}

// ---------------------------------------------------------------------------
// Queue ordering — D7.9 row 5
// ---------------------------------------------------------------------------

/**
 * One run's open gates, MOST URGENT FIRST — D7.9 row 5's `(sla_remaining, blast_radius,
 * cost_at_risk)`, with the ageing term row 5 requires.
 *
 * A PURE FUNCTION OF THE PROJECTION AND OF THE DEADLINE FUNCTION IT IS GIVEN, and that is
 * the strongest property here, so it is stated first — with the second half of the sentence
 * that the first half used to be written without. Same journal, same clock function, same
 * order, at any time. `list` supplies `#deadlineOf`, so the order is over the number the
 * caller RENDERS; two processes that were rehydrated differently show different deadlines
 * and therefore order them differently, which is the honest reading of a queue whose input
 * differs. Two consequences follow that a queue is much better for having:
 *
 *   - it is TESTABLE without a clock, and it cannot disagree with itself between two reads
 *     — a list that reshuffled under a reader's cursor between rendering and clicking would
 *     be its own kind of careless-approve risk;
 *   - IT TAKES NO `now` AT ALL, which is a deviation from row 5's wording worth spelling
 *     out, because it looks like a missing input. Row 5 sorts by `sla_remaining`, and
 *     `remaining = deadline − now` is strictly increasing in `deadline` for whatever `now`
 *     both gates are measured at — so ordering by the ABSOLUTE deadline is the same order,
 *     every time, and the clock cancels. The ageing term below is likewise an absolute
 *     instant derived from the journaled raise. A `now` parameter would be an input nothing
 *     could read, and an unread parameter is a lie about what a function depends on.
 *
 * THE RANK IS A DEADLINE, PULLED EARLIER BY A BOUNDED CREDIT:
 *
 * ```
 *   rank(g) = min(deadline(g), raisedAtTs(g) + AGEING_MS) − radiusCredit(g)
 * ```
 *
 * and the list is sorted by `rank` ascending, ties broken by `raisedAtSeq` — journal order,
 * which is what this method returned before there was a rank at all, so a run whose gates
 * are indistinguishable reads exactly as it used to.
 *
 * NOT STRICT LEXICOGRAPHIC, AND THAT IS THE POINT OF THE CREDIT. Row 5 reads as a tuple,
 * and a tuple whose first key is a continuous quantity makes the rest DEAD: two gates
 * almost never have the same remaining time to the millisecond, so `blast_radius` would
 * decide nothing at all and row 5's own example — the cheap question that should wait —
 * would never once fire. A credit measured in milliseconds is the same idea with a working
 * spelling: a wider question is worth answering ahead of a narrower one that is somewhat
 * more urgent, and is never worth answering ahead of one that is much more urgent.
 *
 * WHY THESE TWO TERMS AND NOT D7.2'S OWN WORDS, since that is the thing to check before
 * trusting this. Neither `blast_radius` nor `cost_at_risk` is journaled anywhere, so both
 * are read off facts the projection already carries rather than invented as new fields:
 *
 *   - **blast radius** is `batchOpenCount` — how many open gates ONE DECISION on this gate
 *     would close. That is D7.9 row 2's own use of the phrase ("`maxBatch` caps the blast
 *     radius of a single click"), and it is per gate, which the alternative is not. The
 *     alternative is the ACTION's irreversibility class, which reads better and is not
 *     available: `GateRecord` does not carry one, `policy.decided` carries an
 *     `irreversibility` string that nothing folds, and inventing a field to sort by would
 *     be exactly the "check what the projection already carries" mistake. **Reverses when**
 *     the irreversibility class reaches the gate record — then it belongs here, ahead of
 *     the batch count.
 *   - **cost at risk** IS NOT IN THE RANK AT ALL, and that is the one thing in this
 *     function worth arguing with. The projection carries it — `p.usage.costUsd +
 *     p.reservedUsd`, spend plus the reservation that has not yet settled, which is the
 *     money committed and waiting on an answer — so the term was written, and then it was
 *     removed, because IT IS A RUN-LEVEL FACT AND THIS IS A RUN-LEVEL QUEUE. Every gate in
 *     one run carries the same number, the comparator is a difference, and a constant
 *     subtracted from every rank changes no order: it is a term that cannot move anything
 *     the shipped API can produce, and shipping one that reads as working is the
 *     "declared and not enforced" failure `checkApproval` refuses one file over. What it
 *     needs first is a queue that spans runs — `HumanGateBroker.list` takes ONE `RunLog`,
 *     `Engine.openGates` serves one run, and nothing in `src/` merges two. When that
 *     exists, the number is the sum above (both halves: reserve-worst-case means committed
 *     exposure PEAKS at the reservation and falls back when `settle` credits the real cost,
 *     so `usage.costUsd` alone reads the trough — the same mistake the budget floors made,
 *     see the Traps list) and it belongs here as a third credit.
 *
 * STARVATION IS BOUNDED, AND HERE IS THE ARGUMENT, because "bounded by an ageing term" is
 * the sort of claim that is written and not checked. Write `maxCredit` for
 * `(RADIUS_CAP − 1)·PER_MEMBER_MS` — a DERIVATION rather than a constant somebody would
 * have to keep in step with the two it is made of. Then for any gate `g`,
 * `rank(g) ≤ raisedAtTs(g) + AGEING_MS`, because the `min` caps the effective
 * deadline there and the credit is non-negative. And for a gate `h` whose deadline is no
 * earlier than its own ageing instant — no deadline at all, or one further out than
 * `AGEING_MS` — `rank(h) ≥ raisedAtTs(h) + AGEING_MS − maxCredit`. So `h` outranks `g` only
 * if
 *
 * ```
 *   raisedAtTs(h) < raisedAtTs(g) + maxCredit
 * ```
 *
 * — **nothing raised more than `maxCredit` after `g` can ever displace it, however wide its
 * batch.** The set of gates that can outrank `g` is therefore
 * CLOSED at a fixed instant and only shrinks as its members are answered or expire. That is
 * the bound, and *A QUEUE NOBODY CAN PUSH TO THE BACK FOREVER* drives it with a stream of
 * maximum-credit arrivals against one cheap, deadline-less gate.
 *
 * THE ONE GATE THAT CAN JUMP THAT QUEUE IS ONE WITH A REAL, SOON DEADLINE, and it should:
 * a question due in a minute is more urgent than one nobody put a clock on, whenever it
 * arrived. It is not a starvation hole because it is self-limiting — that deadline arrives,
 * and the gate escalates onto a LATER deadline or expires, and either way it leaves the
 * front of the queue. This is also why `maxCredit` is kept below `AGEING_MS` in the numbers
 * chosen below: a credit larger than the ageing horizon would let a wide batch with a long
 * deadline outrank a genuinely urgent singleton, which inverts the primary key.
 */
function gateQueueOrder(
  p: RunProjection,
  deadlineOf: (g: GateRecord) => number | undefined,
): readonly GateRecord[] {
  const open = openGates(p);
  const groups = gateBatchGroups(p, "open");
  const ranked = open.map((g) => ({ g, rank: rankOf(g, groups, deadlineOf) }));
  // A TOTAL ORDER, so the sort is deterministic whatever the engine's sort is: ties fall to
  // `raisedAtSeq`, which is unique per gate on any journal-folded projection and is the
  // order this method returned before it ranked anything.
  ranked.sort((a, b) => a.rank - b.rank || a.g.raisedAtSeq - b.g.raisedAtSeq);
  return ranked.map((x) => x.g);
}

function rankOf(
  g: GateRecord,
  groups: Map<GateId, readonly GateRecord[]>,
  deadlineOf: (g: GateRecord) => number | undefined,
): number {
  const ageing = g.raisedAtTs + AGEING_MS;
  // THE CLOCK THE CALLER SHOWS, not a second derivation of it. This used to read
  // `g.deadline ?? raisedAtTs + g.slaMs` — `#deadlineOf`'s first two sources — on the
  // argument that its third (an SLA an operator re-supplied through `rehydrate`) is process
  // state, so ordering by it would put two processes' queues in different orders. True, and
  // it produced a worse thing than disagreement between processes: disagreement inside ONE
  // RESPONSE. `list` renders `#deadlineOf`, so a rehydrated legacy gate came back showing
  // the soonest deadline of the lot, at the BOTTOM of a list documented MOST URGENT FIRST.
  // An order over a number the reader is not shown is not an order they can act on.
  const deadline = deadlineOf(g);
  const effective = deadline === undefined ? ageing : Math.min(deadline, ageing);
  return effective - radiusCredit(g, groups);
}

/**
 * How much urgency the size of one click buys, in ms.
 *
 * A decision that unblocks five branches is worth reading before one that unblocks one,
 * and `maxBatch` is already the cap on how many it can ever be — so this is bounded by
 * construction as well as by `RADIUS_CAP`. A gate in no batch has a radius of one and gets
 * nothing, which is the common case and the right baseline.
 *
 * It counts OPEN members only: a click closes what is still open, and a batch whose other
 * members have been answered one at a time is a batch of one however many rows it holds.
 */
function radiusCredit(g: GateRecord, groups: Map<GateId, readonly GateRecord[]>): number {
  const batchId = batchIdOf(g);
  const members = batchId === undefined ? undefined : groups.get(batchId);
  const radius = members === undefined ? 1 : members.length;
  return (Math.min(radius, RADIUS_CAP) - 1) * PER_MEMBER_MS;
}

/**
 * The ageing horizon: how long a gate may wait before its rank stops depending on its own
 * deadline at all.
 *
 * ONE HOUR, and the number is a judgement rather than a derivation: it is long enough that
 * a gate with a real SLA inside it is ordered by that SLA (which is what an SLA is for),
 * and short enough that a deadline-less question raised at 09:00 is ahead of a 30-day
 * deadline by mid-morning. **Reverses when** a deployment has SLAs routinely longer than an
 * hour AND cares about their relative order past it — at which point this is a
 * `GateBrokerOptions` field, and it acquires the bound every caller-supplied duration in
 * this codebase has (see A12).
 */
const AGEING_MS = 3_600_000;

/**
 * Per extra gate one click would close, and the cap that bounds it.
 *
 * TWO NUMBERS WITH ONE CONSTRAINT BETWEEN THEM, and the constraint is the part that is not
 * taste: `(RADIUS_CAP − 1)·PER_MEMBER_MS` — 19 minutes — must stay below `AGEING_MS`. Above
 * it, a twenty-wide batch with a distant deadline outranks a singleton due in one minute,
 * and the queue stops being an SLA queue. The same quantity is the starvation window: no
 * gate raised more than 19 minutes after another can displace it.
 *
 * The magnitude is a judgement — a minute of urgency per extra branch — chosen so the term
 * is material against SLAs measured in minutes and never decisive against one measured in
 * seconds. **Reverses when** a deployment's gates carry real irreversibility classes, at
 * which point the class belongs in the rank ahead of this and this becomes the tie-break.
 */
const PER_MEMBER_MS = 60_000;
const RADIUS_CAP = 20;

/**
 * Whether some OTHER member of this batch is ALREADY CARRYING the message this gate would
 * send — the one predicate under "a batch is one question".
 *
 * FOUR SITES, ONE MECHANISM, AND THE DIFFERENCE BETWEEN THEM IS WRITTEN AT THE CALL SITE
 * RATHER THAN CHOSEN FROM A MENU HERE. That shape is the fix for a defect this file has now
 * produced twice. There used to be three near-identical functions — `batchHasOpenMember`,
 * `siblingReachedTier`, `siblingReminded` — differing in whether a CLOSED member still
 * counted, and a fourth question arriving had to guess which of the two existing readings
 * it belonged with. The reminder rule guessed wrong: it was built on the tier-N shape, and
 * a batch's only open member had its whole declared schedule suppressed by a sibling that
 * had been answered before it was raised.
 *
 * So `carries` is a required argument and there is no default. To use this you have to
 * write down what your message asserts and what must be true of a sibling for its message
 * to say the same thing — which is the question that was being answered by resemblance:
 *
 *   - **tier 0** (`raise`): *here is a question for you*. A sibling covers it only while it
 *     is OPEN and was DELIVERED — `announcementOutstanding`;
 *   - **tier N** (`#fireTimeout`): *tier N now holds this*. True once said, so a decided
 *     sibling that reached the tier still counts — `m.tier >= next.tier`;
 *   - **a nudge** (`#remind`): *this question is still open*. Present tense, so the sibling
 *     must be open too — `m.state === "open" && (m.remindersSent ?? 0) >= n`;
 *   - **a claim** (`claim` → `claimHolder`): *somebody is looking at this now*. Present
 *     tense and time-bounded — open, and inside the TTL.
 *
 * `false` for a gate in no batch — an unbatched gate is its own question and always speaks
 * — and `false` when the batch cannot be found, which is the direction that ERRS TOWARDS
 * SENDING: the failure this whole path exists to prevent is a page nobody gets, so an
 * unreadable batch means "say it" rather than "assume somebody did".
 *
 * It takes the batch id and the excluded gate id rather than a record, because `raise` asks
 * it about a gate that IS NOT IN `p` YET: at tier 0 the applicant has not been appended, so
 * every member found is by construction a sibling and the exclusion is belt and braces.
 */
function siblingCarries(
  p: RunProjection | undefined,
  batchId: GateId | undefined,
  exceptGateId: GateId,
  carries: (m: GateRecord) => boolean,
): boolean {
  if (p === undefined || batchId === undefined) return false;
  const members = gateBatchGroups(p, "any").get(batchId);
  if (members === undefined) return false;
  return members.some((m) => m.gateId !== exceptGateId && carries(m));
}

/**
 * A member whose announcement is still outstanding: somebody was TOLD, and has not ANSWERED.
 *
 * The tier-0 suppression's whole sentence, in one predicate, so that `raise` (deciding not
 * to page a joiner) and `#announceRemainder` (deciding whether the remainder still has a
 * page standing) cannot drift apart — they are the same claim asked before and after.
 *
 * Both halves are journaled. `deliveredAt` is folded from `gate.delivered`, which is a
 * receipt from a channel that took the message; `state` is the fold of the decision. A
 * member that is open and was never delivered — every channel failed, or the process that
 * raised it had no dispatcher — holds nothing, and suppressing against it is how a batch
 * ends up with N questions and no notifications.
 */
function announcementOutstanding(m: GateRecord): boolean {
  return m.state === "open" && m.deliveredAt !== undefined;
}

/**
 * Who holds the live claim on this gate's QUESTION — it, or any open member of its batch.
 *
 * `siblingCarries`'s rule answering WHO rather than WHETHER, because a hint that cannot
 * name the person coordinates nobody: "somebody is looking at this" leaves the second
 * approver unable to tell a colleague from their own other tab.
 *
 * A batch is claimed ONCE, like it is paged once and nudged once — one click closes every
 * member, so two people holding "different" members of one manifest is the collision this
 * exists to prevent rather than an arrangement it should permit.
 *
 * `now` is the READER's clock and the claim's expiry is an absolute instant in the journal,
 * so a claim expires by being ignored rather than by anything writing anything. That is why
 * this needs no sweeper: there is no state to reap, and a `gate.claim_expired` row would be
 * a durable fact whose only content is that time passed.
 */
function claimHolder(
  p: RunProjection,
  gate: GateRecord,
  now: number,
): { readonly by: string; readonly until: number } | undefined {
  const own = liveClaim(gate, now);
  if (own !== undefined) return own;
  const batchId = batchIdOf(gate);
  if (batchId === undefined) return undefined;
  for (const m of gateBatchGroups(p, "open").get(batchId) ?? []) {
    if (m.gateId === gate.gateId) continue;
    const held = liveClaim(m, now);
    if (held !== undefined) return held;
  }
  return undefined;
}

/**
 * This gate's own claim, if it has one that has not run out — a TOTAL read.
 *
 * Both fields come out of a journal, so both are checked rather than trusted: a
 * `claimedUntil` that is not a number would lose every comparison, and losing a comparison
 * here means "unclaimed", which is the direction that costs a duplicated look rather than a
 * silence. `now < until` and not `<=`, so a claim whose instant has arrived is over.
 */
function liveClaim(g: GateRecord, now: number): { readonly by: string; readonly until: number } | undefined {
  const by: unknown = g.claimedBy;
  const until: unknown = g.claimedUntil;
  if (typeof by !== "string" || by === "") return undefined;
  if (typeof until !== "number" || !(now < until)) return undefined;
  return { by, until };
}

/**
 * How long a soft lock lasts. FIVE MINUTES, per D7.3.
 *
 * THE TWO FAILURES ARE NOT SYMMETRICAL, and the number is chosen for the worse one. A claim
 * that OUTLIVES its claimant is a queue in which an urgent question looks attended and is
 * not — the failure this whole layer exists to prevent, arriving through a comfort feature.
 * A claim that expires while its holder is still typing costs a second person opening the
 * same gate, and nothing else: the decision path never reads a claim, so both of them can
 * still answer. So the TTL is short, and a client that wants to keep it re-claims — which
 * is evidence the claimant is still there, and is exactly what the abandoned case cannot
 * produce.
 *
 * **Reverses when** a deployment reports approvers being interrupted mid-decision; the
 * answer then is a client that refreshes, not a longer default, because a longer default
 * lengthens the abandoned case by the same amount.
 */
const CLAIM_TTL_MS = 300_000;

/**
 * What the approver saw, as one number — D7.3's `contentDigest` asked of a batch.
 *
 * The manifest IS the thing shown, so this digests the manifest: the batch's identity and
 * the ordered `{gateId, nodeId, contentDigest}` of its open members. Three consequences
 * are deliberate:
 *
 *   - it is over JOURNALED fields only, so an auditor re-derives it months later from the
 *     log alone — the property D7.8 says the delivered digest gives up and this one must
 *     not;
 *   - it carries each member's own `contentDigest` rather than any payload, so a batch
 *     digest discloses nothing a gate digest does not;
 *   - it moves when membership moves and NOT when a member escalates. A tier change
 *     resets a deadline; it does not change what is being asked, and refusing a decision
 *     because the on-call was paged would be an SLA cancelling an approval.
 */
function batchManifestDigest(batchId: GateId, key: string, members: readonly GateRecord[]): string {
  return digest({
    batchId,
    key,
    items: members.map((g) => ({ gateId: g.gateId, nodeId: g.nodeId, contentDigest: g.contentDigest })),
  });
}

/** Whether one decision may close both: identical authority, and neither a mirror. */
function sameAuthority(a: GateRecord, b: GateRecord): boolean {
  return (
    a.policyRef === b.policyRef &&
    a.mirrorOf === undefined &&
    b.mirrorOf === undefined &&
    sameSubjects(a.approvers, b.approvers) &&
    // "IDENTICAL" HAS TO INCLUDE THE EXCLUSION, or inheriting is a bypass — D7.8's rule
    // about the authorization, applied to the half that says who may NOT decide. Without
    // this a gate declaring separation of duties inherits a decision made on one that did
    // not, and vice versa; both consumers of this predicate — dedup's `sameQuestion` and
    // batching's merge — are covered by the one change.
    sameSubjects(a.excludedApprovers, b.excludedApprovers) &&
    sameAllowEdit(a.allowEdit, b.allowEdit)
  );
}

/** Whether these are the SAME QUESTION, not merely two a human may answer alike. */
function sameQuestion(a: GateRecord, b: GateRecord): boolean {
  return a.contentDigest === b.contentDigest && a.nodeId === b.nodeId && sameAuthority(a, b);
}

/** Approvers as SETS: absent and `[]` both mean "named nobody", which is permissive. */
function sameSubjects(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = new Set(a ?? []);
  const y = new Set(b ?? []);
  if (x.size !== y.size) return false;
  for (const s of x) if (!y.has(s)) return false;
  return true;
}

/**
 * `allowEdit` as sets, EXCEPT that absent and `[]` are different here.
 *
 * Absent means unconstrained and `[]` means no channel at all — the distinction a signed
 * `edit` once wrote through after a restart read the list as absent. Merging a gate that
 * declared neither with one that declared nothing-permitted would recreate it at the
 * batch layer.
 */
function sameAllowEdit(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return sameSubjects(a, b);
}

/**
 * The declared batching, or `undefined` if it cannot be USED — the fail-closed direction.
 *
 * Every number here ends at a comparison, and `NaN` loses every comparison, so an
 * unchecked one does not disable a cap loudly, it disables it silently and in the
 * dangerous direction: `members.length >= NaN` is false, which is a batch with no bound,
 * and `now - anchor > NaN` is false, which is a window that never closes. The compiler
 * refuses these (`GRAPH014_BATCHING_INVALID`) so an author hears about it; this refuses
 * them again because a broker can be driven directly, and "no batching" is the outcome
 * that costs nothing.
 *
 * `maxBatch` must be at least 2: a cap of 1 can never merge two gates, so it declares a
 * mechanism and gets none. There is no ceiling, deliberately — the real bound on a batch
 * is how many gates a run raises inside the window, which the expansion budget's
 * `maxFanout` already caps at compile time.
 */
function usableBatching(spec: BatchingSpec | undefined): BatchingSpec | undefined {
  if (!isPlainBag(spec) || spec.enabled !== true) return undefined;
  if (typeof spec.key !== "string" || spec.key.trim() === "") return undefined;
  if (!isPositiveWholeMs(spec.windowMs)) return undefined;
  if (!Number.isSafeInteger(spec.maxBatch) || spec.maxBatch < 2) return undefined;
  return spec;
}

/** The same fail-closed reading for dedup. A window that is not a number is not a window. */
function usableDedupe(spec: DedupeSpec | undefined): DedupeSpec | undefined {
  if (!isPlainBag(spec) || spec.enabled !== true) return undefined;
  if (!isPositiveWholeMs(spec.windowMs)) return undefined;
  return spec;
}

/**
 * A plain record whose named fields mean what the schema says.
 *
 * `typeof v === "object"` is the reflex this programme keeps finding, and here is the
 * counterexample that made this the strict version: it admits `null` (reading `.enabled`
 * off which throws out of `raise`, on the path that suspends a run), and it admits an
 * ARRAY — so `Object.assign([], {enabled: true, key: "k", windowMs: 1000, maxBatch: 20})`
 * passed every field check below and batched gates for real. It reads as a mistake nobody
 * would make until you remember that an embedder builds this object in TypeScript and a
 * hand-written graph arrives as parsed JSON, and only the second of those is guaranteed
 * plain.
 *
 * `Object.prototype.toString` rather than a prototype comparison, because a cross-realm
 * object's prototype is not this realm's (see `intoHostRealm`). It admits an ordinary
 * class instance — `[object Object]` — and refuses `Array`, `Map`, `Date` and `RegExp`,
 * which is exactly the line wanted.
 *
 * `graph/validate.ts` has its own copy under the same name and for the same reason.
 * Sharing it would mean `graph/` importing a VALUE from `run/`, which is the module cycle
 * `graph/spec.ts`'s import comment exists to prevent.
 */
function isPlainBag(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === "[object Object]";
}

/** A duration a window can be built from. `NaN`, `Infinity`, `1.5` and `0` are not. */
function isPositiveWholeMs(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * The `GateDecision` a decided gate recorded, rebuilt from the fold.
 *
 * `undefined` for a gate whose `decision` the journal does not carry, which cannot happen
 * for a record this build wrote — the fold sets `decision` in the same object it sets
 * `state: "decided"` — and can for one an older build did. Answering "no decision to
 * inherit" is the safe reading of that.
 */
function decisionOf(g: GateRecord): GateDecision | undefined {
  switch (g.decision) {
    case "approve":
      return { kind: "approve" };
    case "reject":
      return { kind: "reject", reason: g.justification ?? "" };
    case "edit":
      return { kind: "edit", writes: g.writes ?? {}, ...(g.justification === undefined ? {} : { reason: g.justification }) };
    case "redirect":
      return { kind: "redirect", take: g.take ?? [], ...(g.justification === undefined ? {} : { reason: g.justification }) };
    default:
      return undefined;
  }
}

/**
 * Whether a PERSON decided this gate, read out of the fold.
 *
 * Absent `decidedBy` — an open gate, or a `decided` one a build older than the field
 * wrote — answers `false`, which is the same fail-closed reading `decisionOf` gives a
 * decision in no vocabulary: what cannot be shown to have come from a human is not
 * treated as having come from one.
 *
 * It does NOT re-check the approvers list. The source's own `#authorize` did that when the
 * decision was made, and `sameAuthority` proves this gate's list is the same one — which
 * is the argument `GATE_SYSTEM_ACTORS` makes for admitting `gate-broker:dedupe` at all.
 * Re-deriving it here would be a second authorization chain over the same facts.
 */
function humanDecided(g: GateRecord): boolean {
  return g.decidedBy === "human";
}

/**
 * Who the journal says decided a deduped gate.
 *
 * A SYSTEM actor, and not the human who decided the source gate, because they never saw
 * this one: writing their subject onto a `gate.decided` they did not make is the audit
 * corruption the whole layer exists to prevent, and the `gate.deduped` beside it points
 * at the row that does carry them. See `GATE_SYSTEM_ACTORS` for what entitles this name.
 */
const DEDUPE_ACTOR: Actor = SYSTEM_ACTOR("gate-broker:dedupe");

/** Keep the half that cannot authorize anything, and drop the half that can. */
function ephemeralOf(req: GateRequest): EphemeralGate {
  // A USABLE SLA OR NONE, for the reason `usableReminders` gives one line down and which
  // this line did not take: the SLA becomes `deadline = raisedAtTs + slaMs` and is then only
  // ever COMPARED against `now`, and `NaN` loses every comparison — so `now >= NaN` is false
  // forever and the gate can never expire. `rehydrate` is the door that matters: it takes
  // this same request shape from an operator re-supplying an SLA for a gate whose journal
  // predates it, with no compiler behind it, and `#deadlineOf` reads it as its third and
  // highest-authority source. "No deadline" and "a deadline that never arrives" look
  // identical to a sweeper and are opposite answers to the question an operator just asked.
  const slaMs = isPositiveWholeMs(req.slaMs) ? req.slaMs : undefined;
  const reminders = usableReminders(req.reminders, slaMs);
  return {
    payload: req.payload,
    ...(req.delivery === undefined ? {} : { delivery: req.delivery }),
    ...(req.defaultAction === undefined ? {} : { defaultAction: req.defaultAction }),
    ...(slaMs === undefined ? {} : { slaMs }),
    ...(reminders === undefined ? {} : { reminders }),
  };
}

/**
 * The nudge schedule, or `undefined` if it cannot be USED — the fail-closed direction, and
 * the same reading `usableBatching` gives a batching block.
 *
 * A broker can be driven directly, so every rule `checkSla` makes loud is re-made here
 * quietly, and "no reminders" is the outcome that costs nothing. All four are bounds on how
 * often a person is interrupted about one question, which is the only thing this feature
 * can get wrong:
 *
 *   - a positive whole `afterMs`, because the sweep COMPARES it (`raisedAtTs + afterMs`
 *     against `now`) and `NaN` loses every comparison — here that means a nudge that never
 *     fires rather than one that fires forever, but the guard is the same one and the
 *     habit is the point;
 *   - strictly ascending, so "the next unsent one" is a well-defined instant and the list
 *     cannot hold two nudges for the same moment;
 *   - strictly inside the gate's own SLA, so the schedule cannot outlive the tier it was
 *     written for. A gate with NO SLA gets no reminders at all: there is no deadline for a
 *     nudge to come before, and a schedule with no end is the storm this bounds;
 *   - at most `MAX_REMINDERS`, because the three rules above bound the INSTANTS and not
 *     the COUNT — an hour-long SLA has room for a great many of them.
 *
 * One bad entry refuses the WHOLE list rather than the entries after it: a schedule half
 * applied is a schedule nobody declared, and the author reads `checkSla`'s diagnostic
 * rather than guessing which half survived.
 */
function usableReminders(
  declared: readonly { readonly afterMs: number }[] | undefined,
  slaMs: number | undefined,
): readonly number[] | undefined {
  if (declared === undefined) return undefined;
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > MAX_REMINDERS) return undefined;
  if (!isPositiveWholeMs(slaMs)) return undefined;
  const out: number[] = [];
  let previous = 0;
  for (const entry of declared) {
    const afterMs: unknown = isPlainBag(entry) ? entry["afterMs"] : undefined;
    if (!isPositiveWholeMs(afterMs)) return undefined;
    if (afterMs <= previous || afterMs >= slaMs) return undefined;
    previous = afterMs;
    out.push(afterMs);
  }
  return out;
}

/**
 * How many nudges one gate may ever send. `graph/validate.ts` carries the same number for
 * the same reason its `isPlainBag` is a second copy: `graph/` may not import a VALUE from
 * `run/`. If they ever disagree, the compiler's is the loud one and this is the safe one.
 */
const MAX_REMINDERS = 8;

/**
 * Refuse a default action the gate's own `allowEdit` would reject.
 *
 * A gate that declares `allowEdit: ["plan"]` and a default action writing `costUsd` is a
 * configuration error, not a runtime condition — and every second it stays unnoticed is
 * a second in which the SLA has no reachable outcome. Checking it at `raise` means the
 * author sees it while authoring; the alternative is discovering it when the deadline
 * expires, mid-incident, with a run suspended behind it.
 *
 * `rehydrate` deliberately does NOT get this check: it takes the same request shape but
 * has no journal to check against, which is why the sweep must also survive a default
 * action that turns out to be unusable.
 */
function assertDefaultActionIsSatisfiable(req: GateRequest): void {
  if (req.defaultAction === undefined) return;
  // A CLOCK IS NOT A PERSON, so it cannot satisfy a rule about WHICH person.
  //
  // The exclusion is enforced for `human` actors only, and correctly: the system actors that
  // reach `#authorize` are the replayer, the dedup inheritor and this timeout, none of which
  // could be the initiator. But a pre-authorized `defaultAction` turns that carve-out into a
  // bypass of a different rule — the gate expires and `gate-broker:timeout` approves the
  // action the graph said one specific person may not sign off. The two declarations are
  // incompatible rather than merely awkward, so they are refused together at the raise, which
  // is where every other "this gate cannot mean what it says" lives.
  //
  // Engine-unreachable today (`checkSla` refuses `default_action` from a graph and
  // `scheduleOf` forwards no default), so this guards `raise` and `rehydrate` — the embedder
  // doors, which is exactly where `assertDefaultActionIsSatisfiable`'s other refusals live.
  if (req.excludedApprovers !== undefined) {
    throw err.policy(
      CODES.E_GATE_NOT_AUTHORIZED,
      `node "${req.nodeId}" declares both a default action and an approver exclusion: a clock cannot satisfy a rule about which ` +
        `person decides, so the timeout would approve exactly what the exclusion forbids`,
      { details: { nodeId: req.nodeId } },
    );
  }
  // The same acceptance set the decision itself is held to, asked at the RAISE. A
  // `defaultAction` in no vocabulary is the worst member of the class `gateDecisionOf`
  // exists for: nobody is present when the clock applies it, so a kind that fell through
  // to the permissive branch would approve at 3am with no operator to notice.
  const d = gateDecisionOf(req.defaultAction);
  if (d === undefined) {
    throw err.validation(
      CODES.E_HUMAN_APPROVAL_REQUIRED,
      `the default action for node "${req.nodeId}" is not a decision — it must be one of ` +
        `{kind:"approve"}, {kind:"reject",reason}, {kind:"edit",writes} or {kind:"redirect",take}`,
      { details: { nodeId: req.nodeId } },
    );
  }
  if (req.mirrorOf !== undefined && (d.kind === "edit" || d.kind === "redirect")) {
    throw err.policy(
      CODES.E_GATE_NOT_AUTHORIZED,
      `the default action for node "${req.nodeId}" is a ${d.kind}, which a mirror gate cannot carry into run of gate "${req.mirrorOf}"`,
      { details: { mirrorOf: req.mirrorOf, decision: d.kind } },
    );
  }
  if (d.kind !== "edit" || req.allowEdit === undefined) return;
  for (const channel of Object.keys(d.writes)) {
    if (!req.allowEdit.includes(channel)) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `the default action for node "${req.nodeId}" edits channel "${channel}", which the gate does not permit`,
        { details: { channel, allowed: req.allowEdit } },
      );
    }
  }
}

/**
 * The system components whose authority to answer a gate came from somewhere else, and
 * is journaled there.
 *
 * Named individually, because "system" as a category is not an authority: it is every
 * component in the process, and `if (a.kind === "system") return true` made all of them
 * approvers for every gate in the system. Each entry here has to point at a recorded
 * human decision or a recorded policy:
 *
 *   - `gate-broker:timeout` carries the gate's own declared `defaultAction`, which the
 *     graph author pre-authorized and GRAPH014 already proved safe for the action class.
 *   - `executor:subgraph` forwards a decision a human made on the PARENT's mirror gate.
 *     The mirror inherits THIS gate's approvers and is journaled with `mirrorOf` pointing
 *     at it, and the forward resolves that one gate or none — so the human who answered
 *     was checked against this very list, and cannot have been checked against another.
 *     Both halves are required: the inheritance alone left a mirror raised for a
 *     permissive gate free to forward into a restricted one.
 *   - `replay` re-serves a decision already in the original run's journal. It never
 *     originates one, and it only ever writes to a shadow store.
 *   - `gate-broker:dedupe` carries a decision A HUMAN MADE on a gate IN THIS RUN whose
 *     journaled `contentDigest`, node, `policyRef`, approvers list and `edit` allow-list
 *     are each equal to this gate's — every term checked against the FOLD in
 *     `sameQuestion`, not against this broker's memory, and the source's own decision was
 *     checked against that identical approvers list when it was made. So the human who
 *     decided was checked against this very list and cannot have been checked against
 *     another, which is the same argument `executor:subgraph` makes and the same shape of
 *     evidence. `gate.deduped` names the source gate, so the audit trail from this row to
 *     the human is one hop.
 *
 *     THE WORDS "A HUMAN" AND "ONE HOP" ARE NOW ENFORCED RATHER THAN ASSERTED. This entry
 *     claimed both while `#inheritable` accepted ANY `decided` source, and two kinds of
 *     source made it false. A gate the CLOCK decided through a pre-authorized default
 *     action is a decision no human made, and the next identical gate inherited it even
 *     though it had pre-authorized nothing itself — one component's entitlement laundered
 *     into another gate's approval. A gate a previous DEDUP decided is a second hop, and a
 *     chain of them is an unbounded number: 20 duplicates 50 s apart carried one click
 *     1000 s past a declared 60 s window. `humanDecided` in `#inheritable` is the check.
 *     The other three names are unreachable as sources by construction, which is worth
 *     writing down because it is why this one needed a check and they did not:
 *     `executor:subgraph` only ever decides a MIRROR and `sameAuthority` refuses a mirror
 *     on either side; `replay` writes to a shadow store, which is a different journal from
 *     the one a duplicate is raised in.
 *
 * Adding a name here is granting a component the right to satisfy a human approval. It
 * should be about as comfortable as it sounds.
 *
 * THIS LIST IS THE SECOND LINE, not the first. `Engine.resolveGate` — the door every
 * external caller comes through — refuses a system actor outright; these names are only
 * reachable from inside the components themselves. A list of trusted names is exactly as
 * strong as the set of callers that can present one, and that set has to be structural.
 */
const GATE_SYSTEM_ACTORS: ReadonlySet<string> = new Set([
  "gate-broker:timeout",
  "gate-broker:dedupe",
  "executor:subgraph",
  "replay",
]);

/**
 * Whether this actor may answer a gate that names approvers.
 *
 * An approvers list names HUMANS. An `agent` or `evolution` actor NEVER passes: a model
 * satisfying a human approval is precisely the thing the gate exists to prevent. A
 * `system` actor passes only if it is one of the three components above.
 */
function isAuthorizedActor(approvers: readonly string[], a: Actor): boolean {
  if (a.kind === "system") return GATE_SYSTEM_ACTORS.has(a.component);
  return a.kind === "human" && approvers.includes(a.subject);
}

function actorId(a: Actor): string {
  switch (a.kind) {
    case "human":
      return a.subject;
    case "agent":
      return a.profile;
    case "system":
      return a.component;
    case "evolution":
      return a.candidate;
  }
}

function justificationOf(d: GateDecision): string | undefined {
  if (d.kind === "reject") return d.reason;
  if (d.kind === "edit" || d.kind === "redirect") return d.reason;
  return undefined;
}

/**
 * The `gate.decided` row, wherever the decision came from.
 *
 * ONE builder, for the same reason there is one validation chain: a human's decision and
 * the clock's pre-authorized one must be the same kind of durable fact, or a replay, a
 * trace and an audit answer differently depending on who decided. `at` is the instant the
 * decision was taken — the caller's, so the sweep can pass the tick it swept at rather
 * than re-reading a clock that has since moved.
 */
function decidedEvent(gate: GateRecord, input: ResolveInput, at: number): NewEvent {
  const justification = justificationOf(input.decision);
  return {
    type: "gate.decided",
    payload: {
      gateId: input.gateId,
      decision: input.decision.kind,
      latencyMs: at - gate.raisedAtTs,
      ...(input.decision.kind === "edit" ? { writes: input.decision.writes } : {}),
      ...(input.decision.kind === "redirect" ? { take: input.decision.take } : {}),
      ...(justification === undefined ? {} : { justification }),
    },
    actor: input.actor,
    taskId: gate.taskId,
  };
}

/** The `run.resumed` that rides with every decision. A decided gate that does not resume its run is a hang. */
function resumedEvent(actor: Actor): NewEvent {
  return { type: "run.resumed", payload: { by: "gate" }, actor };
}
