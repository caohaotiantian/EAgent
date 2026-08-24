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
 * See design/loom/02-EXECUTION-GRAPH.md D5.4.
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
import type { Posture } from "../vocab.ts";

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

export interface FunctionNode {
  readonly ref: ResourceRef;
  readonly cpuBound?: boolean;
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
 * `mode: "model"` IS DECLARED IN ORDER TO BE REFUSED — the same treatment `DelegationSpec`
 * gets, and for the same reason. Nothing dispatches on `mode`: the router evaluates
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
 * THERE IS NO `drain` FIELD, and its absence is the honest form of what the runtime does.
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
  /**
   * DECLARED AND UNENFORCED: THERE IS NO JOIN DEADLINE.
   *
   * `#maybeFireJoin` decides on `branches`, `mode` and `k`, and `#foldJoin` on
   * `onBranchError`. Neither reads a clock, nothing in `src/` reads this field at all, and
   * `E_JOIN_TIMEOUT` is declared in `errors.ts` with no call site — so a run whose branch
   * never arrives waits forever, however small a number is written here. It was REQUIRED
   * by this type, so every author had to write one that decides nothing, which is the
   * "looks supervised" shape one field over from the gates that refuse it.
   *
   * Optional rather than refused, and the difference is only who can act: refusing it is
   * the right answer and it belongs in the change that implements the deadline, because a
   * deadline needs lease reclaim to be worth anything — a branch held by a dead worker is
   * what actually strands a join under multi-process workers, and a timer would fire
   * against a task nobody is running. Until then the type says what is true and an author
   * who omits it loses nothing.
   *
   * Reversal: when the deadline lands, this becomes required again, `E_JOIN_TIMEOUT`
   * leaves `NEVER_RAISED`, and the note in `design/HANDOFF.md` goes with it.
   */
  readonly timeoutMs?: number;
}

export interface EvaluatorNode {
  readonly kind: "assertion" | "rubric";
  readonly ref: ResourceRef;
  readonly threshold: number;
}

/**
 * A delegation chain, declared but not yet implemented.
 *
 * Present so that a graph asking for delegation is REJECTED rather than run as if it
 * had asked for nothing (GRAPH014_APPROVAL_UNSUPPORTED). `separationOfDuties` has since left
 * that set by being built — support arrives by DELETING a check, which is the whole point of
 * refusing rather than ignoring.
 */
export interface DelegationSpec {
  readonly allowed: boolean;
  readonly maxDepth?: number;
  readonly mustStayInGroup?: boolean;
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
 * `approvers` and `separationOfDuties` are enforced. What is left — `mode` other than
 * `single`, `k`, and `delegation` — is declared here precisely so that it can be REFUSED at
 * compile time: a graph that says `mode: quorum` and silently gets one-approver behaviour is
 * the "looks supervised, is not" failure D7.9 calls the worst one available, and it would be
 * invisible in exactly the place oversight exists for.
 */
export interface ApprovalSpec {
  /** Only `single` is implemented. The others compile-error until a wave lands them. */
  readonly mode?: "single" | "quorum" | "all" | "tiered";
  /** `quorum` only. */
  readonly k?: number;
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
  readonly delegation?: DelegationSpec;
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
  readonly reminders?: readonly { readonly afterMs: number }[];
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
 * one that matters. `grep -arn 'CAN_SUSPEND' packages/core/src scripts/` returns FIVE lines and
 * not one is a reader: the declaration, the `scripts/surface.json` pin, and three sentences of
 * documentation — this one, and two in `CONTROL_TYPES` below. **A self-describing grep counts
 * itself**, which is why the number is written out here instead of "two hits".
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
 * reference. `design/loom/02-EXECUTION-GRAPH.md` D5.1 has been corrected to match.
 */
export const CAN_SUSPEND: ReadonlySet<NodeType> = new Set<NodeType>(["agent", "tool", "human_gate", "subgraph"]);

/**
 * Node types D5.1 says the scheduler may run inline on the committing worker.
 *
 * **`scheduler.ts` NEVER CONSULTS THIS.** Both this docstring and `CAN_SUSPEND`'s used to read
 * as invariants the scheduler enforces; it reads neither, and does not mention `node.type`
 * anywhere in the file. `grep -arn 'CONTROL_TYPES' packages/core/src scripts/` returns two
 * lines — the declaration and the surface pin — and unlike `CAN_SUSPEND`'s, that grep really
 * does return two, because this docstring does not name its own symbol.
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
  return names;
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
        const root = m[1]!.trim().split(".")[0];
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
