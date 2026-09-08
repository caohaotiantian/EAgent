/**
 * The `GraphSpec` — the single source artifact.
 *
 * One artifact is authored once and consumed by all six layers: rendered by the UI,
 * compiled and executed by the scheduler, emitted as spans by observability,
 * versioned in the resource layer, and mutated by the evolution loop. No layer keeps
 * a private representation. That is enforced mechanically: the compiler emits
 * `graphHash = digest(spec)`, every span carries it, and a reconstruction test
 * asserts the folded journal reproduces the same hash.
 *
 * The canonical on-disk form is JSON. YAML is authoring sugar handled outside
 * `@loom/core` — the core never parses YAML, which is what keeps it zero-dependency
 * and keeps hashing unambiguous (canonical JSON has one representation; YAML has
 * several for the same document).
 *
 * ENTRY NODES are nodes with no inbound non-loop edge. There is no `entry:` field:
 * a second way to say where a graph starts is a second thing that can disagree with
 * the edges.
 *
 */

import type { Digest } from "../canonical.ts";
import type { EdgeId, NodeId } from "../ids.ts";
// TYPE-ONLY, and it has to stay that way. `run/projection.ts` already imports this file,
// so a VALUE import of anything under `run/` here would close a real module cycle;
// `verbatimModuleSyntax` erases this line entirely, so at run time `graph/` still depends
// on nothing under `run/`. The alternative — restating the delivery shape here — is worse:
// two declarations of one wire format, and the one that drifts is whichever the compiler
// checks and the broker does not.
import type { DeliverySpec } from "../run/delivery.ts";
import type { ChannelSpec } from "../state/channels.ts";
import { CLASSIFICATION_POSTURE_FLOOR, maxPosture, type Classification, type Posture } from "../vocab.ts";

export const GRAPH_API_VERSION = "loom.dev/v1";

/** `kind/name@selector` — e.g. `prompt/investigate-signal@stable`. */
export type ResourceRef = string;

export interface Budget {
  readonly costUsd?: number;
  readonly tokens?: number;
  readonly wallMs?: number;
}

export interface ExpansionBudget {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxFanout: number;
  readonly maxLoopIterations: number;
}

/**
 * THE `preAuthorization` ENVELOPE IS REFUSED PERMANENTLY, and this paragraph is the refusal.
 *
 * It has been proposed three times — a block declaring a cost ceiling, a blast radius, a tool
 * scope, a data classification, allowed side effects, audit completeness and demotion triggers,
 * so that a node "may run out-of-the-loop only if all of these are declared". It is not a field
 * of anything in this tree and it is not going to become one. Where each part already lives:
 *
 *   cost ceiling          `policy.budget.{costUsd,tokens,wallMs}` — all three bind, at the run
 *                         ceiling and the node ceiling, and survive a restart.
 *   blast radius          `IrreversibilityClass` + `CLASS_DEFAULT_POSTURE` (`vocab.ts`).
 *   tool scope            `policy.capabilities`, checked against `reachableToolNames`.
 *   data classification   `Classification` + `dataFloorOf`, over `observedChannels`.
 *   allowed side effects  `FunctionNode.effects`, folded into `reachableToolNames`.
 *   audit completeness    ABSENT. `journal/audit.ts` holds the rule set; no graph declares
 *                         which rules its run must satisfy, and nothing here proposes one.
 *   demotion triggers     FORBIDDEN, and that is different from absent.
 *
 * TWO REASONS, AND THE SECOND IS THE ONE THAT MAKES IT PERMANENT.
 *
 * REDUNDANCY. Six of the seven already bind through orthogonal mechanisms, so a bundle gives an
 * author a SECOND spelling for facts one place already states. This repository has the
 * reproduction on file for exactly that at one-fifth the scale: `dataFloorOf` exists because
 * `compile.ts` and `validate.ts` computed the same six lines one word apart and the validator
 * reasoned about a LOWER floor than the compiler enforces. An envelope is that failure across
 * five axes at once, and its fail-closed question has no good answer — when
 * `preAuthorization.costCeilingUsd` says 5 and `policy.budget.costUsd` says 50, one of them
 * loses, and whichever loses was a declaration an author believed.
 *
 * THE NAME IS A LOOSENING VERB. A graph author writing `preAuthorization` is the graph
 * pre-approving its own out-of-the-loop execution, and the seventh part makes that concrete
 * rather than rhetorical: a "demotion trigger" is an AUTOMATED rule that lowers a posture when
 * conditions are met. That is precisely what this system enforces against, at two levels —
 * `PolicyEngine.escalate` returns without firing when `maxPosture(from, to) === from`, and the
 * audit rule `policy.deescalation-is-human` flags any `policy.deescalated` whose actor kind is
 * not `human`. Declaring the field would put a name in the schema for the one thing the system
 * exists to make impossible. "Oversight only tightens" is not a property a graph may opt out of.
 *
 * A graph does not write its own grant.
 *
 * The scope is closed at both ends: `SPEC_FIELDS`, `NODE_FIELDS`, `POLICY_FIELDS`,
 * `ALLOWED_FIELDS` and `NESTED_FIELDS.metadata` between them refuse an unknown key at every
 * authoring scope the compiler has, so `preAuthorization` is `GRAPH020_UNKNOWN_FIELD` wherever
 * it is written — including inside `metadata`, which was the last silent one. Arbitrary
 * annotation has a sanctioned home: `GraphMetadata.labels`.
 */
export interface GraphPolicy {
  readonly posture?: Posture;
  readonly budget?: Budget;
  readonly expansion?: ExpansionBudget;
  readonly capabilities?: readonly string[];
  readonly onBudgetExhausted?: "degrade" | "gate" | "fail";
}

export interface NodePolicy {
  readonly posture?: Posture;
  readonly budget?: Budget;
  readonly capabilities?: readonly string[];
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff?: "exponential" | "fixed";
  readonly initialMs?: number;
  readonly maxMs?: number;
  readonly jitter?: boolean;
  /** Retry only for these normalized error codes. Absent ⇒ any retryable class. */
  readonly onlyIf?: readonly string[];
}

export type NodeType =
  | "function"
  | "agent"
  | "tool"
  | "router"
  | "join"
  | "evaluator"
  | "human_gate"
  | "subgraph";

/**
 * THERE IS NO `cpuBound` FIELD, and there is no worker pool.
 *
 * It was declared here, accepted into `ALLOWED_FIELDS.function`, and read at exactly one site:
 * the diagnostic whose whole job was to stop an author believing in it. `packages/core/src`
 * contains no `worker_threads` import — the only occurrence of the word was a comment saying so.
 * A body declaring it ran on the main thread and blocked the event loop, every other task in the
 * wave, the gate-SLA sweep, and any `loom serve` plane sharing the process. Measured: two
 * independent `cpuBound: true` nodes took 2,646 ms against 1,325 ms for one — 1.997x, exactly
 * serial — and four took 5.989x on a 16-core machine. "Looks parallel, serialises" is the
 * operational twin of "looks supervised, is not", and across a fan-out an author believed the
 * declaration was N-way when it was 1-way.
 *
 * Declaring one is now `GRAPH020_UNKNOWN_FIELD`. The pool was refused rather than deferred
 * because a `function` body is RE-EXECUTED on replay while a tool result is SERVED from the
 * journal: out-of-process work AS A TOOL (`proc.exec`, an MCP tool) needs no second copy of the
 * determinism vocabulary, and a worker pool needs one — Date/Intl/Math.random/`ctx.now` would
 * have to be re-established inside the worker, permanently doubling the surface on which
 * invariant 4 can silently break. Two deleted design documents once promised the thread; the
 * schema outlived them by keeping the field.
 *
 * WHAT DOES NOT CHANGE: a body that burns CPU still blocks the loop. It is bounded by the node's
 * declared `timeoutMs` or by `resources/functions.ts`'s `opts.callTimeoutMs ?? 30_000` through
 * `vm`'s per-call timeout, which can enforce it because it terminates synchronous execution.
 */
export interface FunctionNode {
  readonly ref: ResourceRef;
  /**
   * Tools this body may invoke — DECLARED here, never chosen at run time.
   *
   * Before this existed a `function` node was a pure transform: it could compute, and anything
   * with an effect had to be an `agent` node (model-driven, so the choice is the model's) or a
   * `tool` node (exactly one call). A body that wanted to make three calls in a fixed order had
   * nowhere to go, which is the gap every competing runtime fills with a durable-step primitive
   * — `step.run`, `ctx.run`, an Activity.
   *
   * DECLARED RATHER THAN CALLED, and that is the whole design. An anonymous `ctx.step(closure)`
   * is an unkeyed, unkinded, unauditable journal write; Temporal documents the same shape as
   * unable to fail or to modify state, because it does not re-execute on replay. A NAME in the
   * spec is visible to `reachableToolNames`, so it reaches the capability check, the
   * unknown-tool diagnostic and the oversight floor by the same route a tool node's name does.
   * **Declaring a capability and declaring a journaled effect become one act** — which is what
   * turns "every nondeterministic call is journaled" from a rule somebody must remember into a
   * property of the schema.
   *
   * The body invokes them through `ctx.effects`, one bound function per declared name, each
   * routed through the engine's single tool-dispatch path. A body cannot reach a tool it did
   * not declare, because there is no name for it to say.
   */
  readonly effects?: readonly string[];
}

export interface AgentNode {
  readonly profile: ResourceRef;
  readonly prompt: ResourceRef;
  readonly outputSchema?: unknown;
  readonly maxTurns: number;
  readonly tools?: readonly string[];
  /**
   * May this node propose new nodes at runtime (D5.7)?
   *
   * Declared on the NODE, not inferred from the model's output — otherwise a model
   * could grant itself the ability by emitting the right shape. Gated TWICE: the compiler
   * refuses a graph declaring `graph:mutate` that the tenant does not hold
   * (`GRAPH017_CAPABILITY_NOT_GRANTED`), and `#applyMutation` asks `PolicyEngine` again at
   * dispatch. `loom --grant graph:mutate` is how a deployment comes to hold it — before that
   * flag existed, declaring it was a compile error and omitting it was a run-time denial after
   * the model call had been paid for.
   */
  readonly canMutate?: boolean;
}

export interface ToolNode {
  readonly name: string;
  readonly version: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface RouterCase {
  readonly when: string;
  readonly take: readonly EdgeId[];
}

/**
 * Which outgoing edges fire.
 *
 * `mode: "model"` IS DECLARED IN ORDER TO BE REFUSED, and it is now the LAST field in this file
 * of which that is true — `ApprovalSpec.mode`, `.k` and `DelegationSpec` used to be cited here as
 * the same treatment and were deleted instead. The distinction that keeps this one is checkable
 * rather than stylistic: those were OPTIONAL fields, so deleting them makes each key unknown and
 * `NESTED_FIELDS.approval` refuses it. `mode` here is REQUIRED and sits inside a block
 * `ALLOWED_FIELDS` already covers, so deleting `"model"` from the union would leave an unknown
 * VALUE that nothing checks — the refusal below is load-bearing and must stay.
 *
 * Nothing dispatches on `mode`: the router evaluates
 * `cases[].when` whichever mode is declared, so accepting `model` would run "a fixed
 * expression picks the branch" under a graph that reads "a model picks the branch", with
 * a model profile pinned in the resolution manifest and never called. The compiler refuses
 * it (`GRAPH005_ROUTER_MODE_UNSUPPORTED`); whoever builds the mode deletes that check in
 * the change that adds the recorded model effect, the closed-set validation of the
 * returned edge id, and the `E_ROUTE_INVALID` fallback.
 */
export interface RouterNode {
  readonly mode: "expression" | "model";
  readonly cases: readonly RouterCase[];
  /** Taken when no case matches. */
  readonly fallbackEdge: EdgeId;
  /** `model` mode only — see the note above; the compiler refuses that mode today. */
  readonly profile?: ResourceRef;
}

/**
 * The barrier: which branches, how many of them, and what a failed one means.
 *
 * THERE IS NO `timeoutMs` FIELD, and there is no barrier deadline. It was declared here,
 * shape-validated as a duration, warned about at compile, and read by no executor; declaring
 * one is now `GRAPH020_UNKNOWN_FIELD` and the graph is refused. Every branch of a join already
 * has an author-declarable, ENFORCED deadline at its own locus — a node branch through
 * `NodeSpec.timeoutMs` and `#withNodeDeadline`, a gate branch through `slaMs` + `onTimeout` and
 * `GateSweeper` — so the field bought a second spelling and no bound.
 *
 * The reason it is not coming back as a warning is that a barrier deadline's undecidable case
 * has no journaled answer: "is this branch stranded, or legitimately slow?" A join sees only
 * that a sibling has not committed, and `#deadlineOf` deliberately gives a gate with no `slaMs`
 * NO deadline at all — so a branch parked on a human gate is indistinguishable from a hung
 * socket, and a firing barrier would fail runs that are correctly waiting for a person. Firing
 * over whatever arrived is worse: `#foldJoin` has no transform, so a partial fold under
 * `mode: "all"` commits a value no reader can tell from a complete one. An author who wants
 * partial evidence has `mode: "any"` and `mode: "quorum"`, which are journaled as partial by
 * construction.
 *
 * DELETING IT DID NOT CLOSE THE "WAITS FOREVER" HOLE — a default node deadline did, and this
 * paragraph records the order because the argument for deleting the field depended on it. The
 * claim was "every branch of a join already has an enforceable deadline at its own locus", and
 * that was only true of a branch whose author had written a number: `#withNodeDeadline` returned
 * straight through when a node declared none, so an `agent` or `tool` node with none hung its
 * task forever and a join over it waited forever too. `NodePlan.timeoutMs` now carries an
 * effective deadline for the three node types `compile.ts` names, at the one enforcement point
 * that covers every node type, so the branch-locus argument is now true of every branch.
 *
 * THERE IS NO `drain` FIELD EITHER, and its absence is the honest form of what the runtime does.
 * It meant "keep non-arriving branches running after the join fires", and the runtime
 * keeps them running unconditionally — a short-circuiting `any` or `quorum` join fires and
 * the remaining branches run to completion, with no `task.cancelled` appended anywhere.
 * So the value that lied was `drain: false`, which is the default and therefore every
 * graph that never mentioned it; a field cannot be salvaged by refusing the value nobody
 * writes. It returns with straggler cancellation, in one change.
 */
export interface JoinNode {
  readonly branches: readonly NodeId[];
  readonly mode: "all" | "any" | "quorum" | "firstSuccess";
  /** `quorum` only: an integer count, or a fraction of the branch width. */
  readonly k?: number;
  readonly onBranchError: "fail" | "skip" | "compensate";
}

export interface EvaluatorNode {
  readonly kind: "assertion" | "rubric";
  readonly ref: ResourceRef;
  readonly threshold: number;
}

/**
 * WHO may answer this gate.
 *
 * D7.2 puts this block on the `oversight/<name>@<version>` Resource, and that is still
 * where it belongs. It is inline here because nothing in `src/` resolves a Resource's
 * CONTENT: `ResourceResolver.resolve` returns `{ref, digest, channel}` — a pin, not a
 * document — so `humanGate.ref` today proves a policy EXISTS and pins its bytes without
 * ever reading them. Building that seam is a larger change than the durability defect
 * this block was added to fix, so the field names are D7.2's verbatim and moving the
 * block into the Resource later is a relocation rather than a redesign.
 *
 * TWO FIELDS, AND BOTH ARE ENFORCED. `mode`, `k` and `delegation` used to sit here declared in
 * order to be refused, and they are deleted — because what they gestured at either already
 * exists or was never implementable from its own declaration.
 *
 * K-OF-N APPROVAL OVER NAMED PEOPLE ALREADY WORKS, in the shipped graph language, with no new
 * vocabulary: N `human_gate` nodes joined by `join{branches:[…], mode:"quorum", k}`. Measured
 * with three gates naming `u:alice`, `u:bob` and `u:carol` guarding an `fs.write` — all three
 * gates open, approving one leaves `writes=0`, approving the second fires the guarded write, and
 * the third stays open. Two-of-two is two gates in series. `examples/graphs/two-person-approval.json`
 * ships that composition and a test drives it, so it is an artifact rather than a claim.
 *
 * `tiered` went because NO FIELD ANYWHERE DEFINES A TIER, so unlike quorum it was not
 * implementable from its declaration — only refusable. `delegation` went because its own
 * refusal was defeatable: `delegation: {allowd: true}` compiled clean, and
 * `delegation: {maxDepth: 99, mustStayInGroup: true}` compiled clean with two fields no code
 * read; `mustStayInGroup` also presupposes a group vocabulary this system declines to add.
 *
 * WHAT REFUSES THEM NOW IS STRICTLY BETTER. They were OPTIONAL fields, so deleting them makes
 * each key unknown and `NESTED_FIELDS.approval` refuses it with `GRAPH020_UNKNOWN_FIELD`, naming
 * the two members `approval` may declare — along with `modee`, `quorumK`, `delegate` and every
 * other spelling, where three exact strings were caught before. That is the difference from
 * `RouterNode.mode: "model"`, which stays declared-in-order-to-be-refused: `mode` there is
 * REQUIRED, so deleting the value would leave an unknown VALUE nothing checks.
 *
 * The one honest loss is message quality: the refusal does not say "use a quorum join instead".
 * That recipe lives in the shipped example and in README, because putting it in the compiler
 * would reintroduce the vocabulary being deleted.
 */
export interface ApprovalSpec {
  /**
   * Subject identifiers, compared EXACTLY against a human actor's `subject`.
   *
   * Opaque strings, not D7.2's `{kind, id}` records, because roles and groups need an
   * identity resolver Loom does not have — and a role that expands to nobody is an
   * approvers list that authorizes everybody. When that resolver exists this widens to
   * a union, which is additive.
   */
  readonly approvers?: readonly string[];
  /**
   * An approver may not be the run's INITIATOR — the principal on `run.submitted.submittedBy`.
   *
   * Resolved once when the gate is raised and journaled on `gate.raised.excludedApprovers`,
   * so the rule is durable, survives a restart, and replays. It NARROWS `approvers` rather
   * than standing in for it: a gate declaring this and naming nobody is a compile error
   * (`GRAPH014_APPROVAL_INCOMPLETE`), because "everybody except one person" is not
   * supervision.
   *
   * A run whose initiator is unrecorded, synthetic, or not a person cannot satisfy it, and
   * such a run FAILS at the gate rather than raising one that bars nobody.
   */
  readonly separationOfDuties?: boolean;
}

/**
 * HOW LONG the gate waits, and what happens when nobody answers.
 *
 * D7.2 calls this block `sla` and puts it on the `oversight` Resource, next to `approval`.
 * It is inline here for the same reason `ApprovalSpec` is — nothing in `src/` reads a
 * Resource's content — and its two field names are D7.2's verbatim, so moving the block
 * later is a relocation.
 *
 * WITHOUT IT A GATE HAS NO CLOCK AT ALL. `HumanGateBroker.#deadlineOf` derives the
 * deadline from the journal, and the journal only carries one if `raise` was given an
 * `slaMs` — so before this field existed, every gate a *graph* raised waited forever and
 * the whole timeout path was reachable only by an embedder driving the broker by hand.
 * Absent still means exactly that, and it is a legitimate configuration: a gate that must
 * be answered by a person, with no deadline, is what most approvals are.
 *
 * AND ONE OF D7.2'S `delivery` FIELDS HAS MOVED HERE: `reminders`, BY THE SAME RULE THAT
 * MOVED `escalation` THE OTHER WAY. The rule is *what does this field decide?* Escalation
 * decides new recipients and new channels, so it belongs beside them; a reminder decides
 * neither — it is the same tier, the same recipients, the same channels, nudged again — so
 * all it carries is an INSTANT, and instants are what this block is. Putting it here also
 * buys a bound for free: a gate with no `sla` can declare no reminders, and a nudge before
 * a deadline that does not exist is not a nudge.
 *
 * TWO OF D7.2'S FOUR SLA FIELDS ARE DELIBERATELY MISSING.
 *
 *   - `escalation` lives on `delivery`, because escalating is choosing new RECIPIENTS and
 *     new CHANNELS; `DeliverySpec.escalation` is where the runtime reads it from and a
 *     second home for it here would be a second thing to keep in step.
 *   - `defaultAction` is absent BY CONSTRUCTION, not by omission. It is a decision the
 *     author pre-authorizes, so it is only safe once the compiler has proved the action's
 *     irreversibility class permits one (D7.2's `GRAPH014` note). That proof does not exist
 *     here, and a field that lets a graph say "approve it if nobody looks" without it is
 *     the exact failure the gate exists to prevent. `onTimeout` therefore cannot name
 *     `default_action` either — the type refuses it, and `checkSla` refuses it again for a
 *     graph that arrived as JSON.
 */
/**
 * One nudge before a gate's deadline.
 *
 * NAMED RATHER THAN INLINE, and the naming is the fix. It was
 * `readonly { readonly afterMs: number }[]`, and an anonymous type cannot be read by
 * `test/graph/allowed-fields.test.ts`, which checks every `NESTED_FIELDS` row against the
 * interface it claims to cover. So this was the one `humanGate` scope with no unknown-key check
 * while its six siblings had one: `{afterMs: 1000, evrey: true}` compiled clean, because the
 * sweep reads `afterMs` and ignores the rest. Giving the shape a name put it back inside the
 * drift guard, which is what makes the new row checkable rather than merely present.
 */
export interface GateReminderSpec {
  /** Milliseconds from the journaled raise. Strictly increasing, and inside `respondWithinMs`. */
  readonly afterMs: number;
}

export interface GateSlaSpec {
  /** How long the first tier has, in ms, measured from the journaled raise. */
  readonly respondWithinMs: number;
  /**
   * What the sweep does at the deadline. Default `fail`, matching `GateRequest.onTimeout`.
   *
   * `escalate` REQUIRES a `delivery.escalation` chain: with none, the broker treats the
   * chain as exhausted and expires the gate immediately, which reads as "someone else gets
   * paged" and behaves as `fail`. `checkSla` refuses that combination rather than shipping
   * it.
   */
  readonly onTimeout?: "escalate" | "fail";
  /**
   * NUDGES BEFORE THE DEADLINE — D7.2's `delivery.reminders`, on the clock block.
   *
   * Each `afterMs` is measured from the JOURNALED raise, like `respondWithinMs` and for the
   * same reason: a schedule re-supplied on a later deploy must produce the same instants,
   * and `now + afterMs` would hand every gate a fresh set of nudges every restart.
   *
   * A REMINDER IS NOT AN ESCALATION AND MUST NOT BECOME ONE. It resets nothing — not the
   * SLA, not the tier, not the tier's own clock — and it tells the people who already have
   * the question that it is still open. `gate.escalated` is the event that moves a
   * deadline; `gate.reminded` is folded into a COUNTER and nothing else.
   *
   * WHAT STOPS A NUDGE STORM, since the sweep runs on whatever interval a deployment
   * chooses and every tick re-asks the same question. Three bounds, and all three are
   * needed: the schedule is a finite list consumed IN ORDER, so a gate can be nudged at
   * most `reminders.length` times in its whole life; each nudge is journaled, and the fold
   * advances the counter, so the write changes the very condition that triggered it (the
   * rule `HumanGateBroker.#commitForOpenGate` states as a table); and every instant must
   * fall strictly inside `respondWithinMs`, so a schedule cannot outlive the tier it was
   * written for. `checkSla` refuses a list that breaks any of those, and
   * `usableReminders` in `run/gates.ts` refuses it again for a broker driven directly.
   */
  readonly reminders?: readonly GateReminderSpec[];
}

/**
 * MERGE SIBLING GATES INTO ONE QUESTION — D7.9 row 2.
 *
 * A fan-out over a `human_gate` node raises one gate per branch, and twenty gates asking
 * the same question of the same person is the queue saturation D7.9 exists to survive.
 * Gates declaring the same `key`, raised inside `windowMs` of the batch's first member,
 * are grouped; `HumanGateBroker.resolveBatch` closes every member with one decision.
 *
 * WHAT IT DOES NOT DO, because "pure UX, no oversight semantics change" is only true if
 * it is made true: a batch never merges two gates whose authorization differs. Membership
 * is refused — the newcomer starts its own batch — unless the two agree on `policyRef`,
 * on `approvers`, and on the `edit` allow-list, and neither is a subgraph mirror. See
 * `sameAuthority` in `run/gates.ts`, which is where that predicate lives and is checked
 * against the JOURNAL rather than against a broker's memory.
 *
 * AND NOR DOES IT MERGE TWO GATES WHOSE *GOVERNANCE* DIFFERS. Everything on this interface
 * is the policy of the batch a gate FOUNDS, not a request it makes of a batch it joins:
 * the founding spec governs the batch for its whole life, and a gate declaring a different
 * `key`, `windowMs`, `maxBatch` or delivery route starts its own batch instead. That is not
 * pedantry about equality — every one of those fields was read off the JOINING gate once,
 * so a batch founded under `maxBatch: 2` grew to ten the moment gates declaring
 * `maxBatch: 20` arrived. The batch's own policy is journaled on `gate.raised.batch` and
 * read back by `batchGovernance`; see D7.9 rows 2-3.
 *
 * `key` IS A LITERAL, NOT AN EXPRESSION. D7.2 writes `key: "node.id + plan.namespace"`,
 * which is an expression over the gate's payload; nothing here evaluates one, and giving
 * the payload a second reader is a larger change than this. A literal key plus the
 * `policyRef` equality above already groups exactly the case row 2 names — a wide fan-out
 * over one node — because every branch of one node carries the same key and the same
 * policy.
 */
export interface BatchingSpec {
  readonly enabled: boolean;
  /** The grouping label. Gates sharing it, and their authority, may merge. */
  readonly key: string;
  /**
   * Measured from the batch's FIRST member's journaled raise, never from `now` — and it is
   * the FOUNDER's window that is measured, never the applicant's.
   */
  readonly windowMs: number;
  /**
   * How many gates one click may ever close. `maxBatch` counts EVERY gate that has
   * joined the batch, not the open ones, so a batch cannot be refilled after its members
   * are decided one at a time — and it is the FOUNDER's cap, journaled on the batch, so a
   * newcomer declaring a larger one starts its own batch rather than raising this bound.
   */
  readonly maxBatch: number;
}

/**
 * COLLAPSE A REPEATED QUESTION ONTO THE ANSWER IT ALREADY HAS — D7.9 row 3.
 *
 * A retry storm re-raises byte-identical gates. When one of them has already been
 * DECIDED, a new gate with the same journaled `contentDigest` inherits that decision in
 * the same append that raises it, and journals `gate.deduped` naming the gate it
 * inherited from.
 *
 * ONLY FROM A DECIDED GATE. D7.9 says "the second occurrence inherits the first
 * decision", which presumes one exists; when the first is still open there is nothing to
 * inherit, and making the second WAIT on the first would be a second suspension mechanism
 * with no deadline of its own. Two identical open questions are what `batching` is for.
 *
 * D7.2 has no `dedupe` block — row 3 was specified with a window and nowhere to declare
 * it. This is that declaration; the window is its own, because the batching window
 * governs how long a queue may accumulate and this one governs how long an answer stays
 * current, and they are not the same duration.
 */
export interface DedupeSpec {
  readonly enabled: boolean;
  /** Measured from the SOURCE gate's journaled raise — the age of the question. */
  readonly windowMs: number;
}

export interface HumanGateNode {
  readonly ref: ResourceRef;
  readonly approval?: ApprovalSpec;
  readonly sla?: GateSlaSpec;
  /** D7.9 row 2. Absent means every gate is its own question. */
  readonly batching?: BatchingSpec;
  /** D7.9 row 3. Absent means an identical question is asked again. */
  readonly dedupe?: DedupeSpec;
  /**
   * WHERE this gate goes, and who it escalates to — D7.2's `delivery` block.
   *
   * Inline for the same reason as `approval`, and reusing `run/delivery.ts`'s own
   * `DeliverySpec` rather than restating it, so what the compiler checks and what
   * `GateDispatcher` reads are one type.
   *
   * Absent is the default and means the gate is durable and queued and nothing is SENT:
   * the console and the HTTP API surface it, and nobody is told. That is a usable mode —
   * it is what every gate in this codebase did before this field existed — but it is the
   * mode in which "an SLA fired and nobody knew" is possible, so declare a channel for any
   * gate whose deadline matters.
   *
   * A DECLARED CHANNEL NAME IS NOT COMPILE-CHECKABLE, and deliberately not faked: the
   * compiler cannot know which channels a deployment's dispatcher was built with. An
   * unknown name produces `gate.delivery_failed` plus the console fallback at run time, and
   * delivery failure never auto-approves — so the failure is loud, recorded, and safe.
   * `checkDelivery` therefore checks the SHAPE and says nothing about the names.
   */
  readonly delivery?: DeliverySpec;
}

export interface SubgraphNode {
  readonly ref: ResourceRef;
  /** child channel ← parent channel. */
  readonly inputs: Readonly<Record<string, string>>;
  /** parent channel ← child channel. */
  readonly outputs: Readonly<Record<string, string>>;
  readonly budgetShare?: number;
}

export interface NodeSpec {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly policy?: NodePolicy;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  /**
   * Rewind markers this node writes.
   *
   * `before` is appended AHEAD of the node's `state.reduced` — the state as it was — and `after`
   * once its writes have landed; `both` writes each, under distinct ids so a reader can tell
   * which side of the node a marker names. `before` was accepted and silently ignored until
   * 2026-08, including on the gate node of both shipped workflows.
   */
  readonly checkpoint?: "none" | "before" | "after" | "both";
  /** Suppresses GRAPH011 for a node whose failure is intentionally unhandled. */
  readonly unhandled?: boolean;

  readonly function?: FunctionNode;
  readonly agent?: AgentNode;
  readonly tool?: ToolNode;
  readonly router?: RouterNode;
  readonly join?: JoinNode;
  readonly evaluator?: EvaluatorNode;
  readonly humanGate?: HumanGateNode;
  readonly subgraph?: SubgraphNode;
}

export type EdgeKind = "seq" | "conditional" | "fanout" | "join" | "error" | "compensation" | "loop";

export interface EdgeSpec {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly kind: EdgeKind;
  /** `conditional` only (absent when the source is a router — the router decides). */
  readonly when?: string;
  /** `fanout` only. */
  readonly over?: string;
  readonly as?: string;
  readonly maxWidth?: number;
  /** `join` only. */
  readonly branches?: readonly NodeId[];
  /** `loop` only. */
  readonly until?: string;
  readonly maxIterations?: number;
  /** `error` only: restrict to these normalized codes. */
  readonly codes?: readonly string[];
  /** `compensation` only. */
  readonly compensates?: NodeId;
}

export interface GraphMetadata {
  readonly name: string;
  readonly project: string;
  readonly version: number;
  readonly description?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface GraphSpec {
  readonly apiVersion: string;
  readonly kind: "GraphSpec";
  readonly metadata: GraphMetadata;
  readonly policy?: GraphPolicy;
  readonly channels: Readonly<Record<string, ChannelSpec>>;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly nodes: readonly NodeSpec[];
  readonly edges: readonly EdgeSpec[];
  readonly hooks?: Readonly<Record<string, readonly ResourceRef[]>>;
}

// ---------------------------------------------------------------------------
// Compiled form
// ---------------------------------------------------------------------------

export interface ResolvedRef {
  readonly ref: ResourceRef;
  readonly digest: Digest;
  readonly channel: "draft" | "canary" | "stable" | "deprecated";
}

/**
 * A node's derived schedule metadata. Computed once at compile so the scheduler and
 * the UI never recompute graph analysis at run time.
 */
export interface NodePlan {
  readonly id: NodeId;
  /** Worst-case number of Task instances: Π(fanout widths) × Π(loop iterations). */
  readonly maxInstances: number;
  /** Longest remaining path to a terminal, in nodes. Drives `criticalPathFirst`. */
  readonly criticalPathLength: number;
  readonly inboundEdges: readonly EdgeId[];
  readonly outboundEdges: readonly EdgeId[];
  /** Effective posture after the `max` fold over every declared level. */
  readonly posture: Posture;
  /**
   * The retry policy that will ACTUALLY be used, or absent when this node is not retried.
   *
   * The second effective-after-fold value on this record, and it is here for the same reason
   * `posture` is: the engine must not be the only thing that knows. `Engine.#retryDecision`
   * read `NodeSpec.retry` — an authored field that no shipped graph, and not `agent()`'s own
   * compiled spec, ever set — so the requeue path was unreachable in the product while a
   * hidden sleep inside the HTTP transport quietly stood in for it. An effective policy a
   * reader cannot see in the artifact is that same defect one layer up, so the compiler folds
   * `NodeSpec.retry ?? <default for the node's type>` to here and `loom compile` prints it.
   *
   * DERIVED, and therefore outside `graphHash` like every other field on this record: the
   * same authored spec keeps the identity it already had on every journal.
   */
  readonly retry?: RetryPolicy;
  /**
   * The node deadline that will ACTUALLY be enforced, or absent when this node has none.
   *
   * The third effective-after-fold value on this record, and it is here for exactly the reason
   * `retry` is one field up: before it, a node declaring no `timeoutMs` had NO deadline at all.
   * `Engine.#withNodeDeadline` read `NodeSpec.timeoutMs` and returned straight through when it
   * was `undefined`, so a hanging tool held its Task forever and a join over that branch waited
   * forever with it — measured, `Engine.advance` on a one-`tool`-node graph with no declaration
   * was still unsettled at 1,500 ms and would never have settled.
   *
   * A FLOOR FOR NODES THAT DECLARED NOTHING, never an override: `NodeSpec.timeoutMs` wins wherever
   * an author wrote one, at any value, including one far larger than the default. `compile.ts`'s
   * `effectiveTimeout` names the three node types that get one and says why the other five do not.
   *
   * DERIVED, and therefore outside `graphHash` like every other field on this record.
   */
  readonly timeoutMs?: number;
  /** Rank for the UI's layered layout, so the browser never runs graph layout. */
  readonly layoutRank: number;
}

/**
 * The compiled, validated plan for one Run.
 *
 * Immutable. Carries the resolution manifest, which is what makes the pinning rule
 * real: a Run reads only what its manifest names, so a Resource published, promoted,
 * or deprecated mid-run cannot affect it.
 */
export interface RunGraph {
  readonly graphHash: Digest;
  readonly spec: GraphSpec;
  readonly plans: Readonly<Record<NodeId, NodePlan>>;
  readonly entryNodes: readonly NodeId[];
  readonly terminalNodes: readonly NodeId[];
  readonly resolutionManifest: readonly ResolvedRef[];
  /**
   * The TEXT behind every ref that names one, frozen at compile, keyed by ref.
   *
   * RESOLVED HERE RATHER THAN AT RUN TIME, and that is a stronger reading of the pinning rule
   * than a runtime lookup, not a weaker one. `resources/functions.ts` records what a run-time
   * `resolve(ref)` costs: "a promotion between compile and execute swapped the body underneath
   * the Run". Freezing the bytes into the compiled artifact makes that unreachable rather than
   * merely guarded — the executor never asks a resolver anything about a prompt.
   *
   * It also matches how this system is actually assembled: every `compile` call site has a
   * resolver, and almost no `new Engine` call site does. A prompt that needed the engine's
   * resolver would have made every engine construction a resource deployment.
   *
   * Empty for a resolver with no `document` hook, which is every resolver that serves only
   * pins — and an agent node compiled against one is refused, because a graph that cannot say
   * what it asks the model is not a graph that runs.
   */
  readonly documents: Readonly<Record<string, string>>;
  /**
   * Every child `GraphSpec` this graph can delegate to, keyed by ref, frozen at compile.
   *
   * The whole TREE, not just the nodes this spec names: a child's own `subgraph` nodes are
   * collected too, so nothing consults a resolver once a Task is executing. Freezing only the
   * top level would move the read one level down rather than remove it — `#compileChild`
   * compiles the child, and a compile reads refs.
   *
   * Only the SPEC. The child is still compiled when it is delegated to, because compiling a
   * whole tree up front makes a parent pay for a branch it may never take.
   */
  readonly subgraphs: Readonly<Record<string, GraphSpec>>;
  readonly expansion: ExpansionBudget;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_EXPANSION: ExpansionBudget = {
  maxNodes: 256,
  maxDepth: 3,
  maxFanout: 32,
  maxLoopIterations: 8,
};

/** Which type-specific block each node type requires. Used by GRAPH020. */
/**
 * The fields inside a type block that MUST be present, by node type.
 *
 * `REQUIRED_BLOCK` proves a node HAS an `agent:`; nothing proved that `agent:` had a `profile`.
 * So `{"type":"agent","agent":{}}` — forgetting a field, the most ordinary authoring mistake
 * there is — reached `parseRef(undefined)` in the compiler and came back as
 * `E_INTERNAL: TypeError: Cannot read properties of undefined (reading 'lastIndexOf')`, which
 * tells an author nothing about their graph.
 *
 * Beside `REQUIRED_BLOCK` rather than in `validate.ts` for the reason that table is here: it is
 * the runtime enumeration of what a `NodeSpec` means, and two enumerations in two files is how
 * they come to disagree.
 */
/**
 * NOT `Partial`, deliberately. The first version was, and the omission it permitted is exactly
 * what shipped: `router` and `join` had no entry, so `join: {}` still crashed the compiler
 * (`join5.branches is not iterable`) and `router: {}` compiled `ok` and crashed the RUN. A total
 * `Record` forces every node type to be looked at, and the ones with nothing to require say so
 * with an empty list rather than by absence.
 */
export const REQUIRED_FIELDS: Readonly<Record<NodeType, readonly (readonly [string, keyof NodeSpec, "string" | "array"])[]>> = {
  agent: [
    ["profile", "agent", "string"],
    ["prompt", "agent", "string"],
  ],
  function: [["ref", "function", "string"]],
  // `kind` too, and its absence was not a crash but something worse: an `evaluator` with no
  // `kind` fell through to the `rubric` arm and made a PAID MODEL CALL where the author had
  // written an assertion. Measured: 24 input tokens billed for a graph that names no model.
  evaluator: [
    ["ref", "evaluator", "string"],
    ["kind", "evaluator", "string"],
  ],
  human_gate: [["ref", "humanGate", "string"]],
  subgraph: [["ref", "subgraph", "string"]],
  router: [
    ["mode", "router", "string"],
    ["cases", "router", "array"],
    ["fallbackEdge", "router", "string"],
  ],
  join: [
    ["branches", "join", "array"],
    ["mode", "join", "string"],
    ["onBranchError", "join", "string"],
  ],

  // `name` ONLY. `ToolNode.version` is declared required by the type and enforced by nothing —
  // the engine looks a tool up by NAME — and several in-tree graphs omit it. Requiring it here
  // would be a behaviour change for every such graph, dressed up as a crash fix. Recorded as its
  // own question rather than answered as a side effect.
  tool: [["name", "tool", "string"]],
};

/**
 * Every field each node block MAY carry. A key outside this list is refused.
 *
 * There was no unknown-field check anywhere in the compiler, for any node type, and the hole is
 * quiet in the dangerous direction: `evaluator: {kind, ref, threshold, effects: [...]}` compiled
 * clean, warned nothing, and decided nothing — so an author who had just read `FunctionNode.effects`
 * declared a capability ceiling and got none. That is the failure this repository has named four
 * times under other names (`drain`, `JoinNode.timeoutMs`, a router's `mode: "model"`,
 * `CAN_SUSPEND`), except worse, because those are declared-and-inert and this one is declared,
 * inert, and PERMISSIVE.
 *
 * TypeScript's excess-property check hides it from anyone authoring a spec in this repository.
 * The YAML path — which is how an operator writes a graph — has nothing.
 *
 * Beside `REQUIRED_FIELDS` and total for the same reasons that table gives: it is the runtime
 * enumeration of what a `NodeSpec` means, two enumerations in two files is how they come to
 * disagree, and a `Partial` would let a node type be forgotten rather than looked at.
 * `test/graph/allowed-fields.test.ts` reads the interfaces out of this file and checks the two
 * agree, because the failure mode of an allow-list is refusing a field somebody legitimately
 * added — a guard that cries wolf on correct code is worse than no guard.
 */
export const ALLOWED_FIELDS: Readonly<Record<NodeType, readonly string[]>> = {
  function: ["ref", "effects"],
  agent: ["profile", "prompt", "outputSchema", "maxTurns", "tools", "canMutate"],
  tool: ["name", "version", "args"],
  router: ["mode", "cases", "fallbackEdge", "profile"],
  join: ["branches", "mode", "k", "onBranchError"],
  evaluator: ["kind", "ref", "threshold"],
  human_gate: ["ref", "approval", "sla", "batching", "dedupe", "delivery"],
  subgraph: ["ref", "inputs", "outputs", "budgetShare"],
};

/**
 * The same check one level up: a node's OWN fields, the graph's, and an edge's.
 *
 * `ALLOWED_FIELDS` closed the hole inside a node's type block and left the three enclosing
 * scopes open, which is where the worst instance of it turned out to live. Measured:
 *
 *     policy:  { posture: "in" }   →  plan posture `in`
 *     policyy: { posture: "in" }   →  plan posture `out`, and ZERO diagnostics
 *
 * An author asking for the strongest oversight the system has, receiving the weakest, told
 * nothing. Every other member of this family costs a feature; this one costs the control that
 * decides whether a human sees the action at all. `retry`, `timeoutMs` and `checkpoint` fail the
 * same way and quietly — `checkpoint`'s own docstring records that a VALID value was ignored for
 * months, which is this defect's twin with the misspelling on the compiler's side.
 *
 * An edge is here for one reason worth naming: a misspelled `when` does not disable a condition,
 * it makes the edge UNCONDITIONAL, so a branch the author meant to guard always fires. `codes` on
 * an error edge is the same shape — the typo widens it to every code.
 *
 * These three are `NodeSpec`, `GraphSpec` and `EdgeSpec` verbatim, and the test reads all three
 * interfaces out of this file so the copies cannot drift apart.
 */
export const NODE_FIELDS: readonly string[] = [
  "id",
  "type",
  "reads",
  "writes",
  "policy",
  "retry",
  "timeoutMs",
  "checkpoint",
  "unhandled",
  "function",
  "agent",
  "tool",
  "router",
  "join",
  "evaluator",
  "humanGate",
  "subgraph",
];

export const SPEC_FIELDS: readonly string[] = [
  "apiVersion",
  "kind",
  "metadata",
  "policy",
  "channels",
  "inputs",
  "outputs",
  "nodes",
  "edges",
  "hooks",
];

/**
 * And INSIDE `policy`, which is where the check stopped and where the loss is worst.
 *
 * The three enclosing scopes above close a misspelled BLOCK — `policyy: {posture: "in"}` is
 * refused with a suggested fix. One level in, nothing was checked at all. Measured against
 * `compile`, one graph each:
 *
 *     policy: { posturr: "out" }        →  ok, zero diagnostics
 *     policy: { budget: {nonsense: 5} } →  ok, zero diagnostics
 *
 * A budget nobody enforces and an oversight declaration nobody reads, both compiling clean.
 * `expansion` is here for the same reason with a different consequence: a misspelled
 * `maxNodes` does not fail, it falls back to `DEFAULT_EXPANSION`'s 256 — an author writing
 * `8` and getting 256 is the one direction a limit must never move on its own.
 *
 * FOUR LISTS IN ONE TABLE rather than four exports, because each is one exported name on a
 * pinned public surface and they are read at exactly one call site together. Keyed, like
 * `ALLOWED_FIELDS`, and checked against `GraphPolicy`, `NodePolicy`, `Budget` and
 * `ExpansionBudget` by the same test that checks the other four lists — an allow-list's
 * failure mode is refusing a field somebody legitimately added.
 */
export const POLICY_FIELDS: Readonly<Record<"graphPolicy" | "nodePolicy" | "budget" | "expansion", readonly string[]>> = {
  graphPolicy: ["posture", "budget", "expansion", "capabilities", "onBudgetExhausted"],
  nodePolicy: ["posture", "budget", "capabilities"],
  budget: ["costUsd", "tokens", "wallMs"],
  expansion: ["maxNodes", "maxDepth", "maxFanout", "maxLoopIterations"],
};

export const EDGE_FIELDS: readonly string[] = [
  "id",
  "from",
  "to",
  "kind",
  "when",
  "over",
  "as",
  "maxWidth",
  "branches",
  "until",
  "maxIterations",
  "codes",
  "compensates",
];

/**
 * And one level in AGAIN — the four blocks the five lists above walk straight past.
 *
 * A census of the allow-lists found `ALLOWED_FIELDS`, `NODE_FIELDS`, `SPEC_FIELDS`, `EDGE_FIELDS`
 * and `POLICY_FIELDS`, read at eight `unknownKeys` call sites. Nothing checked inside `retry`,
 * inside a `channels.<name>` declaration, inside that declaration's `contextProjection`, or
 * inside `metadata`. Measured against `compile`, one graph each, every one `ok: true` with ZERO
 * diagnostics:
 *
 *     retry: { maxAttemptss: 3 }                     →  plan.retry = {"maxAttemptss":3}
 *     channels.a: { …, classificaton: "secret_ref" } →  channel `a` unclassified, floor `out`
 *     metadata: { …, nmae: "x" }                     →  nothing
 *
 * TWO OF THEM ARE LOAD-BEARING, AND THE FIRST IS THE WORST MEMBER OF THIS FAMILY FOUND SO FAR.
 * `#retryDecision` stops at `attempt >= policy.maxAttempts`, and `n >= undefined` is `false` for
 * every `n` — so a retry block whose `maxAttempts` was misspelled is not a lost bound, it is an
 * UNBOUNDED retry, and `effectiveRetry` also stops substituting `DEFAULT_PROVIDER_RETRY` the
 * moment a `retry` block exists. The second is `policyy: {posture: "in"}` exactly one scope over:
 * a channel meant to be `secret_ref` with the key misspelled is an unclassified channel, so every
 * reader's floor drops from `in` to `out` and no diagnostic says so.
 *
 * ONE TABLE for the reason `POLICY_FIELDS` gives — each would otherwise be a name on a pinned
 * public surface — with one difference worth stating, since that table's argument does not carry:
 * these are read at FOUR call sites, not one. What replaces it is the same reason `REQUIRED_FIELDS`
 * is total: `test/graph/allowed-fields.test.ts` iterates this table against the interfaces, so a
 * scope somebody adds here is a scope that gets cross-checked, and a scope left out of the table
 * is visibly absent rather than silently unchecked.
 *
 * `channel` and `contextProjection` are `ChannelSpec` and `ContextProjection` from
 * `state/channels.ts`, not from this file; the test reads that file too rather than restating them.
 */
export const NESTED_FIELDS: Readonly<
  Record<
    | "retry"
    | "channel"
    | "contextProjection"
    | "metadata"
    | "approval"
    | "sla"
    | "slaReminder"
    | "delivery"
    | "deliveryEscalation"
    | "batching"
    | "dedupe",
    readonly string[]
  >
> = {
  retry: ["maxAttempts", "backoff", "initialMs", "maxMs", "jitter", "onlyIf"],
  channel: ["type", "reduce", "initial", "classification", "contextProjection", "identityKey", "onConflict"],
  contextProjection: ["fields", "take", "maxTokens", "overflow"],
  metadata: ["name", "project", "version", "description", "labels"],
  // THE `humanGate` SCOPES, and they are the reason this table is worth its cost. A dropped key
  // elsewhere is a lost setting; here it is an unsupervised action. Measured on a structurally
  // valid graph before these six rows existed, every one of these compiled with ZERO gate
  // diagnostics: `approval:{approvres:[…]}`, `approval:{approvers:"u:alice"}`,
  // `approval:{approvers:[]}`, `approval:42`, `separationOfDutys:true`,
  // `delegation:{allowd:true}`, `sla:{…,onTimout:"escalate"}`,
  // `delivery:{channels:["console"],recipiants:[]}` — and `approval:null` crashed the compiler
  // with `E_INTERNAL: TypeError: Cannot read properties of null (reading 'mode')`.
  //
  // Driven through the engine with a restart between raise and resolve, the typo journals
  // `approvers: []`, `u:mallory` — named by nobody — approves, and the guarded `fs.write` lands.
  // `approvers: "u:alice"` journals as the STRING, so the audit record reads supervised while
  // `String.prototype.includes` lets subject `"u"` and subject `"alice"` each approve.
  approval: ["approvers", "separationOfDuties"],
  sla: ["respondWithinMs", "onTimeout", "reminders"],
  // EACH ENTRY OF `sla.reminders`, and it is here rather than inline in `validate.ts` for the
  // reason every other row is: `allowed-fields.test.ts` reads this table against the interfaces
  // and fails when they drift. `GateSlaSpec.reminders` is `readonly {afterMs: number}[]` — an
  // anonymous inline type, which is why this row could not simply be derived, and why the scope
  // sat unguarded while its six siblings were closed. A typo'd key here is silently dropped: the
  // sweep reads `afterMs` and nothing else, so `{afterMs: 1000, evrey: true}` compiles clean.
  slaReminder: ["afterMs"],
  // `DeliverySpec` and `EscalationTier` are `run/delivery.ts`'s, not this file's — the same
  // arrangement `channel` and `contextProjection` already have with `state/channels.ts`, and
  // `allowed-fields.test.ts` reads that file too rather than restating them here.
  delivery: ["channels", "recipients", "redact", "redactAs", "escalation"],
  deliveryEscalation: ["afterMs", "to", "channels", "action"],
  batching: ["enabled", "key", "windowMs", "maxBatch"],
  dedupe: ["enabled", "windowMs"],
};

export const REQUIRED_BLOCK: Readonly<Record<NodeType, keyof NodeSpec>> = {
  function: "function",
  agent: "agent",
  tool: "tool",
  router: "router",
  join: "join",
  evaluator: "evaluator",
  human_gate: "humanGate",
  subgraph: "subgraph",
};

/**
 * Node types D5.1 says can suspend a Run mid-execution.
 *
 * **NOTHING READS THIS, AND IT IS NOT TRUE.** Both halves were checked, and the second is the
 * one that matters. Run `grep -arn 'CAN_SUSPEND' packages/core/src scripts/`: **every hit is a
 * declaration, the `scripts/surface.json` pin, or documentation — none is a reader.**
 *
 * No COUNT is given here, and that is the point. A docstring that names its own symbol is a line
 * that grep returns, so stating "two hits" was wrong, and the correction to "five" was wrong the
 * moment it was written, because writing it added a sixth. **A self-describing count has no fixed
 * point; a self-describing PROPERTY does.** State what every hit is, not how many there are.
 *
 * **Every node type can suspend.** A gate reaches `#executeTask` from `decision.effect ===
 * "gate"` BEFORE `#dispatch` picks a per-type arm, and `PolicyRequest` carries
 * `kind: "node" | "tool"` and no node type at all — it decides on declared posture, data
 * classification, irreversibility and taint. So a `function` node with `policy: {posture:"in"}`,
 * or one writing a `secret_ref`-classified channel, gates like any other. That is not the ONLY
 * `status: "gate"` site — the `human_gate` arm and `#runSubgraph`'s mirror gate are two more and
 * both ARE per-type — but the type-agnostic one is what makes the claim total.
 *
 * Measured, not reasoned: **all four** types absent from this set — `function`, `evaluator`,
 * `router`, `join` — reach `awaiting_gate` at posture `in`, each in its own compiling graph. An
 * earlier version of this sentence said three of four and did not say which; a verifier ran the
 * fourth. **A count nobody can name the members of is a count nobody checked.**
 *
 * Kept and exported because it is pinned in `scripts/surface.json` — removing it is a
 * public-surface change and a separate decision — and left here as a WARNING rather than a
 * reference. `the design notes` D5.1 has been corrected to match.
 */
export const CAN_SUSPEND: ReadonlySet<NodeType> = new Set<NodeType>(["agent", "tool", "human_gate", "subgraph"]);

/**
 * Node types D5.1 says the scheduler may run inline on the committing worker.
 *
 * **`scheduler.ts` NEVER CONSULTS THIS.** Both this docstring and `CAN_SUSPEND`'s used to read
 * as invariants the scheduler enforces; it reads neither, and does not mention `node.type`
 * anywhere in the file. `grep -arn 'CONTROL_TYPES' packages/core/src scripts/` has the same
 * answer as the grep above: declarations, the surface pin, and prose. No reader.
 *
 * This set is the complement of `CAN_SUSPEND` and inherits its defect — the justification for
 * running these three inline is that they "terminate without external input", and a `function`
 * node that gates does not. Read the warning above before making any decision from either.
 */
export const CONTROL_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["router", "join", "function"]);

/**
 * Every tool this node can reach — not the one it names.
 *
 * A `tool` node names its tool in `node.tool`; an `agent` node never does, because the
 * model picks from `agent.tools` at run time. Asking `node.tool` alone therefore answers
 * `read_only` for every agent, and the `max` fold that computes a posture never sees the
 * term that would raise it. Oversight, capability accounting and the rewind refusal all
 * need the reachable set, so they all read it from here.
 */
export function reachableToolNames(node: NodeSpec): readonly string[] {
  const names: string[] = [];
  if (node.tool !== undefined) names.push(node.tool.name);
  for (const t of node.agent?.tools ?? []) if (!names.includes(t)) names.push(t);
  // A `function` node's DECLARED effects are reachable tools by every definition this function
  // serves — the capability ceiling, the unknown-tool diagnostic, and the oversight floor. Adding
  // them here rather than at each of those eight call sites is the point of the helper: a new way
  // to reach a tool should be one edit, not eight, and the last time this set was widened it was
  // widened for agents and the compile-time floor was missed.
  for (const t of node.function?.effects ?? []) if (!names.includes(t)) names.push(t);
  return names;
}

/**
 * The oversight floor this node's DATA imposes, from the classification of every channel it can
 * observe or write.
 *
 * ONE COPY, and it is here because there were two. `compile.ts` computed it from
 * `observedChannels(n)` and `validate.ts` from `n.reads` — the same six lines, one word apart —
 * so for a node that reaches a channel only through a `${template}` the validator computed a
 * LOWER floor than the compiler enforces. The diagnostics that read it (GRAPH014's
 * oversight-loosened refusal, GRAPH019's inert-declaration warning) were therefore reasoning about
 * a graph the executor does not run: an author declaring `posture: on` beside a templated
 * `secret_ref` read was told their declaration was meaningful, and it was being overridden.
 *
 * The bypass this closes is the one `observedChannels` exists for, arriving one function later —
 * which is the whole argument for a shared helper over two correct-looking copies. `reads` is not
 * the read set, and every place that treats it as one has to be found again each time.
 */
export function dataFloorOf(
  channels: Readonly<Record<string, { readonly classification?: Classification }>>,
  node: NodeSpec,
): Posture {
  return maxPosture(
    ...[...observedChannels(node), ...(node.writes ?? [])].map((c) => {
      const cls = channels[c]?.classification;
      return cls === undefined ? ("out" as Posture) : CLASSIFICATION_POSTURE_FLOOR[cls];
    }),
  );
}

/**
 * The channels this node would WRITE a secret into that do not say they hold one.
 *
 * THE LAUNDERING HOP, stated statically, and it is the same rule `applySecretFlow` applies at
 * run time: a node that observes a `pii` or `secret_ref` channel marks everything it writes as
 * carrying a secret, and `PolicyEngine.#floorFor` then holds a hard-to-undo action at `in` under
 * a human's de-escalation ceiling instead of letting it fall to `on`. Measured in
 * `test/run/secret-flow.test.ts` before that existed: one `function` node copying a `secret_ref`
 * channel into an `internal` one dropped the sink from `in` to `on`, no gate was raised, and the
 * tool received the plaintext.
 *
 * The RUN was fixed; the COMPILE said nothing, so an author discovered the posture change by
 * running. This is the half a compiler can answer — `reads`, `tool.args` and `writes` are all in
 * the spec — and `validate.ts` turns it into `GRAPH014_SECRET_LAUNDERED`.
 *
 * BESIDE `dataFloorOf` AND SHARING `observedChannels` ON PURPOSE. That function is here because
 * the same six lines lived in two files a single word apart and drifted; this one asks the same
 * question one hop later and would drift the same way. `test/graph/laundering.test.ts` pins the
 * remaining half of the coupling: engine.ts spells the `sensitive` predicate locally, and the
 * test reads that source and fails if the two ever name different classifications.
 *
 * SENSITIVE IS DERIVED, not listed: every classification whose posture floor is above `out`.
 * Writing `["pii", "secret_ref"]` here would be a fourth copy of a vocabulary that already has a
 * total table, and a fifth classification added to `vocab.ts` would silently miss this rule.
 * A classification in NO vocabulary looks up `undefined`, which is not `"out"`, so it counts as
 * sensitive at both ends — over-reporting on the source side, under-reporting on the written side.
 * Neither survives: `GRAPH003_UNKNOWN_CLASSIFICATION` is an error on that graph already.
 *
 * ONE HOP, NOT THE CLOSURE. A node writing into a laundered channel launders again at run time —
 * `carriesSecret` is monotone and never cleared — and this function does not chase that, because
 * the second hop's node is reported by its own first-hop check only if it observes a DECLARED
 * secret. Named as a residue rather than hidden: the diagnostic finds the source of a leak, not
 * every node downstream of it.
 */
export function launderedChannels(
  channels: Readonly<Record<string, { readonly classification?: Classification }>>,
  node: NodeSpec,
): readonly string[] {
  const sensitive = (c: string): boolean => {
    const cls = channels[c]?.classification;
    return cls !== undefined && CLASSIFICATION_POSTURE_FLOOR[cls] !== "out";
  };
  if (!observedChannels(node).some(sensitive)) return [];
  return (node.writes ?? []).filter((c) => !sensitive(c));
}

/**
 * The ONE parse of what is written between `${` and `}`, because there were two and they
 * disagreed about the syntax this product documents.
 *
 * A template expression is a dotted path with an optional `| json` suffix asking for text.
 * `run/engine.ts`'s `resolveArgs` strips that suffix BEFORE `lookup`, so `${secret | json}`
 * hands the tool the same plaintext `${secret}` does. `observedChannels` used to take
 * `expr.trim().split(".")[0]` with no knowledge of the suffix, so for the same channel it named
 * `"secret | json"` — a channel that does not exist — and MISSED `secret`. Measured on one graph
 * differing only in the template form:
 *
 *   observedChannels `${secret}`        ["plain","secret"]    plan.posture `in`, GRAPH014_SECRET_LAUNDERED
 *   observedChannels `${secret | json}` ["plain","secret | json"]  plan.posture `out`, no warning
 *
 * So every decision derived from the observed set — `dataFloorOf`'s classification floor,
 * `launderedChannels`, and `applyTaint`'s integrity check, all of which call `observedChannels`
 * — was defeated by adding four documented characters. The confidentiality axis dropped `in` to
 * `out`; the integrity axis lost the taint edge the same way. It also produced WRONG ADVICE on a
 * graph this repo ships: `examples/graphs/self-review.json` was told to declare a channel named
 * `"report | json"`, which `isSafeId` would reject.
 *
 * EXPORTED SO `resolveArgs` CAN IMPORT IT rather than keeping a second copy of the regex. Two
 * representations of one vocabulary is the drift this tree pays for repeatedly — `dataFloorOf`
 * exists for the same reason one function down — and the failure mode here is not a wrong
 * message but a guard that stops firing.
 *
 * ONE SUFFIX, NOT A PIPELINE. `${x | json | json}` strips the trailing `| json` and leaves the
 * path `x | json`, which `lookup` resolves to `undefined` and which this function reports as the
 * root `x | json`. Both ends agree and the tool receives nothing, so it is a bad graph the
 * compiler warns about, not a bypass. Stripping repeatedly would make that expression RESOLVE,
 * which is new syntax and not this function's business.
 */
export function parseTemplateExpr(expr: string): { readonly path: string; readonly asText: boolean } {
  // TRIMMED HERE, not by the caller. The suffix regex is anchored at `$`, so `${x | json  }`
  // matched for `resolveArgs` — which trimmed first — and not for `observedChannels`, which did
  // not. That is the same divergence one whitespace character down, and a function that depends
  // on its callers agreeing about normalisation is a function that will diverge again.
  const trimmed = expr.trim();
  const asText = TEMPLATE_JSON.test(trimmed);
  return { path: trimmed.replace(TEMPLATE_JSON, "").trim(), asText };
}

const TEMPLATE_JSON = /\s*\|\s*json$/;

/**
 * MAY THIS NODE HOLD OVERSIGHT THE GRAPH AROUND IT CANNOT ENUMERATE — the set, named by its
 * property rather than by listing types, because the property is what both callers ask about.
 *
 * `human_gate`, because of the eight `NodeType`s it is the only one whose whole purpose is that
 * the run STOPS until a person acts. A `tool` or an `agent` skipped or routed around did not
 * happen either, but nothing about the graph promised it would, and their own oversight is about
 * THEMSELVES — a tool at posture `in` raises a gate for its own call.
 *
 * `subgraph`, because ITS OWN BODY MAY HOLD ONE and no reader here can see it. A child is
 * compiled and cached, so a walk is possible; three reasons it is not done. (1) One caller is on
 * the SCHEDULING path, and `compileOrThrow` on a child spec that no longer compiles turns a
 * refusal into a throw — a guard that fails OPEN by crashing the wave meant to raise it. (2) A
 * child may itself hold a `subgraph`, so the honest walk is a recursive compile of a tree bounded
 * only by `expansion.maxDepth`. (3) The answer would be no better: a child re-decides every node
 * at full strictness under its own `PolicyEngine`, so a delegation is exactly where oversight the
 * parent cannot enumerate lives — "the child declares no `human_gate` today" is a claim about a
 * spec the parent froze, not about the run that would have happened.
 *
 * ## IT WAS WRITTEN FOR TWO CALLERS AND HAS ONE, WHICH IS A MERGE RESOLUTION AND NOT A REGRET
 *
 * `Engine.#fireEmptyJoin` asks it of a branch a zero-width fan passed over — and `#runSubgraph`
 * and `applyTaint` reach it through the same engine. `graph/mutate.ts` was the second caller on
 * `phase1-taint`, asking it of a dominator a proposed mutation would remove; the 2026-09-08 merge
 * kept `loom`'s mutation rule instead, which preserves EVERY dominator and therefore asks no such
 * question (`/usr/bin/grep -a -rn carriesOversight packages/core/src/` finds `spec.ts` and
 * `run/engine.ts` and nothing else). The MUTATION row below is kept because it is the measurement
 * that decided the predicate, not because `mutate.ts` still produces it: on the merged tree that
 * graft is refused by dominance alone, under the code `MUT003_NOT_DOMINATED`. Both halves were
 * measured before they were merged:
 *
 *   - THE FAN. One graph driven twice, a `subgraph` in the fan body holding the only gate and a
 *     `reversible_write` tool under the join:
 *         the page yields none -> succeeded,     gates=0, wrote=1   (before)
 *         the page yields none -> awaiting_gate, gates=1, wrote=0   (now)
 *   - THE MUTATION. The same graft that MUT003 refuses around an authored `human_gate`, with the
 *     gate replaced by a `subgraph` whose child holds it:
 *         base -> lookup -> rejoin below the delegation  -> ok      (before)
 *         the same mutation                              -> MUT003  (now)
 *
 * The cost is one escalation on an attacker-chosen empty fan whose branch delegates, and — on the
 * tree this predicate came from — one refused expansion past a delegation. Both are gates or refusals a person can answer, and both
 * are the direction that fails closed.
 */
export function carriesOversight(node: NodeSpec | undefined): boolean {
  return node !== undefined && (node.type === "human_gate" || node.type === "subgraph");
}

/**
 * Every channel this node can OBSERVE — not the ones it declares in `reads`.
 *
 * `#runToolNode` resolves `tool.args` against `scopeFor(...)`, the WHOLE channel scope, so a
 * template may name a channel `reads` never mentions and the node reads it anyway. That gap is
 * a one-token bypass wherever a decision is computed from the declared set: drop the channel
 * from `reads`, leave `${channel}` in the arguments, and whatever `reads` was protecting is
 * gone while the graph still compiles clean.
 *
 * It has been reproduced twice, on two different decisions, and the second is why this lives
 * here rather than in `run/`:
 *
 *   TAINT — untrusted bytes reach an irreversible tool's arguments with nothing raised.
 *   CLASSIFICATION — a channel declared `secret_ref` (floor `in`, a gate) interpolated into a
 *     `reversible_write` tool. Declared in `reads`: the run gates, the tool never runs.
 *     Omitted, same arguments: no gate, and the tool receives `sk-live-SUPER-SECRET`.
 *
 * Both are the posture `max` losing a term it should have had, and BOTH SITES ARE FED FROM
 * HERE now — the compiler's `dataFloor`, which becomes `plans[].posture`, and the engine's
 * runtime `dataClassification`. Beside `reachableToolNames` because it is the same kind of
 * thing one noun over: what this node actually reaches, derived statically, because invariant 5
 * depends on the answer.
 *
 * STATIC on purpose. The same function answers for a node running now and for a node whose
 * commit is being re-folded out of the journal at attach, where no scope exists — which is what
 * lets the live rule and the rebuild be one rule rather than two that can disagree.
 *
 * `${a.b}` names channel `a`; only the root segment is a channel.
 *
 * EXPRESSIONS ARE NOT PARSED HERE, AND DO NOT NEED TO BE — but only because of a coupling in
 * another file. A `router` case's `when` and an edge's `when`/`until` reach the scope through
 * the expression evaluator, so nothing below sees them. `GRAPH004_UNDECLARED_READ` refuses any
 * of them naming a channel outside the owning node's `reads ∪ writes` — it takes the free
 * variables from `checkExpr(...).refs` — so by the time anything runs, `reads` is already a
 * superset for exactly the channels an expression can reach.
 *
 * Neither half is sufficient alone and neither file said so, which is one relaxed compiler rule
 * away from taint going quiet with nothing failing. `test/graph/expression-reads.test.ts` is
 * that missing edge: it reads the ENGINE's source for every `evaluate(this.#expr(…))` site and
 * fails on one no GRAPH004 check is named for.
 */
export function observedChannels(node: NodeSpec): readonly string[] {
  const out = new Set<string>(node.reads ?? []);
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([^}]+)\}/g)) {
        const root = parseTemplateExpr(m[1]!).path.split(".")[0];
        if (root !== undefined && root !== "") out.add(root);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) scan(x);
      return;
    }
    if (v !== null && typeof v === "object") for (const x of Object.values(v)) scan(x);
  };
  scan(node.tool?.args ?? {});
  return [...out];
}
