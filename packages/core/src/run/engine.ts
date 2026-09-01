/**
 * The graph executor and scheduler.
 *
 * This is the inversion the whole system exists for: the graph schedules the agent,
 * not the reverse. An agent's ReAct loop is the body of one node type among eight,
 * and its durable footprint is only what it writes to channels.
 *
 * Three structural rules are enforced here by construction rather than by review:
 *
 *   1. **One tool dispatch path.** `#invokeTool` is the only place a tool runs —
 *      for a `tool` node and for a tool called from inside an `agent` node alike.
 *      EAgent had two, and the second was a hand-maintained clone of the first.
 *
 *   2. **Work is parallel; commits are serialized.** Model and tool calls run
 *      concurrently, but every journal commit goes through one queue with an explicit
 *      `expectedSeq`. That is what makes at-least-once execution produce
 *      exactly-once state without a distributed lock.
 *
 *   3. **A fan-out's writes wait for its join.** A Task at the root branch reduces
 *      immediately; a Task inside a fan-out holds its proposal until the join folds
 *      every sibling in branch-coordinate order. Applying them on arrival would make
 *      the result depend on which branch finished first.
 *
 */

import { randomInt } from "node:crypto";

import { canonicalize, digest, shapeOf } from "../canonical.ts";
import { CODES, err, isLoomError, toLoomError, type LoomError } from "../errors.ts";
import {
  ROOT_BRANCH,
  childBranch,
  compareBranch,
  effectKey,
  encodeBranch,
  newRunId,
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
import {
  SYSTEM_ACTOR,
  errorRecord,
  isEvent,
  type Actor,
  type ErrorRecord,
  type HumanActor,
  type JournalEvent,
  type NewEvent,
  type SubmittedBy,
  type SystemActor,
} from "../journal/events.ts";
import { EXTERNALISE_ABOVE_BYTES, payloadHandle, refFor, type PayloadRef, type PayloadStore } from "../journal/payloads.ts";
import type { StateStore } from "../journal/store.ts";
import type { EventBus } from "../bus.ts";
import { evaluate, parseExpr, type Expr } from "../graph/expr.ts";
import { observedChannels, parseTemplateExpr, reachableToolNames } from "../graph/spec.ts";
import type { BatchingSpec, DedupeSpec, EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../graph/spec.ts";
import { indexGraph, type GraphIndex, type ResourceResolver } from "../graph/validate.ts";
import { compileMutation, type GraphMutation } from "../graph/mutate.ts";
import { InProcessScheduler, type Scheduler } from "./scheduler.ts";
import { compile, compileOrThrow } from "../graph/compile.ts";
import {
  ESCALATION_RULES,
  FailureStreaks,
  detectAnomaly,
  isLowConfidence,
  scopeOf,
  toolNGram,
  type CohortBaseline,
  type EscalationRuleId,
  type SequenceIndex,
} from "./escalation.ts";
import { validate, type JSONSchema } from "../schema.ts";
import { assembleContext, boundTurns, estimateTokens } from "./context.ts";
import {
  foldPartial,
  reduceState,
  stateHash,
  type ChannelSpec,
  type Contribution,
} from "../state/channels.ts";
import {
  ZERO_USAGE,
  addUsage,
  isSyntheticSubject,
  isLoosening,
  maxPosture,
  type GateDecision,
  type IrreversibilityClass,
  postureRank,
  CLASS_DEFAULT_POSTURE,
  type Posture,
  type UsageRecord,
  type Classification,
} from "../vocab.ts";
import type { DeliverySpec } from "./delivery.ts";
import {
  GateSweeper,
  HumanGateBroker,
  type GateBatch,
  type GateSummary,
  type GateSweeperOptions,
  type GateRequest,
  type ResolveBatchInput,
  type ResolveInput,
  type SweepReport,
  type TimeoutAction,
} from "./gates.ts";
import { externalisableChannels } from "./externalise.ts";
import { RunLog } from "./log.ts";
import {
  BLOCK_REASON,
  attemptable,
  planCompensation,
  type CompensationStep,
  type RewindAuthorization,
  type RewindPlan,
  type RewindPlanStep,
} from "./compensation.ts";
import { PolicyEngine, classificationOf, isHardToUndo, type BudgetLimits, type PolicyActor, type PolicyEngineOptions } from "./policy.ts";
import { HookRegistry, narrowErrorDecision, narrowGateRequest, narrowNodeDecision, narrowToolDecision, runFilters, runObservers, type ErrorDecision, type GateView, type HookPoint, type NodeDecision, type PreToolState, type RegisteredHook } from "./hooks.ts";
// Type-only: `replay.ts` constructs an Engine at runtime, so a value import here
// would be a real module cycle.
import type { ReplayEffects } from "./replay.ts";
import {
  branchChain,
  collectOutputs,
  RunFolder,
  foldRun,
  gateOf,
  isTerminal,
  openGates,
  scopeFor,
  tasksInState,
  viewFor,
  withResolved,
  type GateRecord,
  type RunProjection,
  type TaskRecord,
  type TaskState,
} from "./projection.ts";
import { isRealmBounded } from "../resources/realm.ts";
import {
  FunctionRegistry,
  ModelRegistry,
  ToolRegistry,
  type FunctionBody,
  type FunctionOutcome,
  type Message,
  type ModelAdapter,
  type ModelRequest,
  type ModelToolCall,
  type ToolDefinition,
  type ToolResult,
} from "./registry.ts";

export interface EngineOptions {
  readonly store: StateStore;
  readonly bus?: EventBus;
  readonly tools?: ToolRegistry;
  readonly functions?: FunctionRegistry;
  readonly models?: ModelRegistry;
  readonly gates?: HumanGateBroker;
  /**
   * The extension bus. Optional: a deployment with no hooks registered runs exactly as before,
   * and `GraphSpec.hooks` naming a ref this registry does not hold is skipped rather than
   * fatal — the compiler already refused an unknown POINT, which is the silent mistake.
   */
  readonly hooks?: HookRegistry;
  readonly now?: () => number;
  readonly workerId?: string;
  /** In-flight Tasks per run. Level 2 backpressure: the fan-out edge blocks (D6.3). */
  readonly maxParallelism?: number;
  readonly policy?: Omit<PolicyEngineOptions, "onEscalate">;
  /** Injected so an intervention hold never makes tests wait on a real clock. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Prompt token budget per agent turn, before the compaction ladder fires. */
  readonly contextTokens?: number;
  /** Used when validating a runtime graph mutation. */
  readonly resolver?: ResourceResolver;
  /** Which Tasks this worker takes. Default: one worker, every ready Task. */
  readonly scheduler?: Scheduler;
  /** E5's evidence. Absent ⇒ the rule never fires, which is right with no history. */
  readonly sequences?: SequenceIndex;
  /** E7's evidence. Absent ⇒ the rule never fires. */
  readonly baseline?: CohortBaseline;
  /**
   * Tuning for the gate clock that `sweepGates` drives — how many runs one tick sees.
   *
   * The engine never starts a timer of its own, whatever is set here. See `sweepGates`.
   */
  readonly sweep?: Omit<GateSweeperOptions, "store" | "broker" | "bus" | "now">;
  /**
   * Replay mode. When present, every effect is served from the journal and no tool
   * body or model adapter is ever reached. A missing key is E_REPLAY_DIVERGENCE —
   * a loud failure, never a silent live call.
   */
  readonly replay?: ReplayEffects;
  /**
   * Where a channel value larger than `EXTERNALISE_ABOVE_BYTES` goes instead of into the
   * journal. See `run/externalise.ts` for which channels are eligible.
   *
   * ABSENT MEANS OFF, and off is byte-for-byte the behaviour this engine had before the
   * option existed: every value is journaled inline, `state.reduced.external` is never
   * written, and `RunProjection.external` stays empty. That is the right default for an
   * embedder who has not decided where a second durable store lives, because the failure
   * mode of getting it wrong is a journal that cannot be replayed.
   *
   * IT MUST BE THE SAME STORE ACROSS A RESTART. A journal whose events name payloads is not
   * replayable on its own — that is the price of the indirection, and it is why an engine
   * asked to resolve a handle it cannot find raises `E_PAYLOAD_UNRESOLVED` rather than
   * carrying on. A memory store is therefore for tests and for a run that lives in one
   * process; `filePayloads(dir)` is the durable one.
   */
  readonly payloads?: PayloadStore;
}

export interface SubmitInput {
  readonly graph: RunGraph;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string;
  readonly workflow?: string;
  /**
   * Use this id instead of minting one.
   *
   * A subgraph's child run needs a DERIVED id for the same reason a TaskId does: replay
   * must find the same child, and a random id silently breaks it. Never set by an
   * external caller.
   */
  readonly runId?: RunId;
  /** Overrides the run budget — a subgraph carves its slice from its parent's. */
  readonly budgetUsd?: number;
  /**
   * WHO this run is submitted for, journaled on `run.submitted`.
   *
   * OPTIONAL, AND ITS ABSENCE IS THE PERMISSIVE ANSWER, which is worth stating because this
   * codebase normally refuses that shape. A run with no recorded principal is readable by
   * every authenticated caller — the deliberate grandfather rule for journals written before
   * the field existed. Required was the alternative and it breaks every embedder for a
   * feature they may not use, so the enumeration is held by a test instead:
   * `test/run/submit-callers.test.ts` pins every `submit(` call site under `src/`.
   *
   * The HTTP door always supplies it. `loom run` supplies it only with `--as`, because the
   * CLI authenticates nobody and inventing a subject is worse than recording none.
   */
  readonly submittedBy?: SubmittedBy;
}

/**
 * Who may be journaled as having cancelled or rewound a run.
 *
 * NARROWED, for the reason `resolveGate` narrows its own actor: a public door that accepts
 * the whole `Actor` union accepts `{kind:"agent"}`, `{kind:"evolution"}`, and — worse — any
 * `system` component name, including the ones this engine mints itself. An embedder could
 * then journal a cancel as `system:gate-broker:timeout`, which is the audit-trail forgery
 * `principal:` prefixing exists to prevent at the HTTP door, reached through the library
 * door instead. It grants nothing today, because nothing folds a cancel's actor into an
 * authorization decision, and "grants nothing today" is not a property to build on.
 *
 * A person, or a component. `agent` and `evolution` are excluded because neither cancels a
 * run: a model does not hold an opinion about whether an operator's work should stop.
 */
export type CommandActor = HumanActor | SystemActor;

/**
 * Failures a join must NEVER absorb.
 *
 * `onBranchError: skip` means "this branch's *work* failed"; it does not mean "the
 * run may continue past a breached budget or an invalid replay". Without this set,
 * fixing branch-failure containment silently defeats both.
 */
/**
 * Task states a cancel must not rewrite.
 *
 * Named as a SET rather than tested inline, because "which states are finished" is asked in
 * more than one place and a second inline copy is how the two drift. `TaskState` has nine
 * members; these four are the ones a Task cannot leave.
 */
const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["succeeded", "failed", "skipped", "cancelled"]);

/**
 * The longest a source's `retry-after` may park a Task.
 *
 * Five minutes. The header is a faithful record of what a provider ASKED FOR, not a promise the
 * ask was reasonable — `retry-after: 86400` is legal, and a task silently parked for a day is
 * indistinguishable from a hang. Beyond this the wait is capped and the run keeps its own
 * timeouts as the outer bound.
 */
const RETRY_AFTER_CEILING_MS = 300_000;

/**
 * The longest ONE TASK may spend deferred on provider rate limits, summed across every deferral.
 *
 * A deferral charges no attempt (see `#retryDecision`), so `maxAttempts` cannot bound it and
 * something has to: without this, a provider stuck at 429 requeues one Task forever and the run
 * never ends. Fifteen minutes is a judgement, and here is the argument for it. A rate-limit
 * window is measured in seconds to a minute — that is what `retry-after` says in practice — so
 * this is more than an order of magnitude of headroom over the case it exists to survive, and
 * still short enough that an operator watching a run notices. Past it the rate limit stops being
 * "the provider is busy" and starts being "this deployment cannot use this provider", which is a
 * failure worth reporting rather than waiting through.
 *
 * The sum is FOLDED from the journal (`TaskRecord.deferredMs`), so a restart does not refill it.
 * It is the scheduled time, not measured elapsed time: a decision that read a clock would not be
 * reproducible from the log.
 *
 * IT BOUNDS TWO THINGS AND THE ARGUMENT ABOVE COVERS ONE. `DEFERRABLE_CODES` has two members,
 * so this same 900 s also caps how long a parent will poll an unfinished CHILD. The reading
 * transfers — past it, "the child is still working" stops being a wait and starts being a run
 * that will not finish — but it is a second claim and it was not made. A deployment that wants
 * long-running children and short rate-limit patience cannot have both, and the shape of that
 * fix is a second constant rather than a knob on this one.
 *
 * A TRUE BOUND ON THE TOTAL. The check is `spent + afterMs <= BUDGET`, not `spent < BUDGET`.
 * The first version asked only whether the time already spent was under, then added up to
 * another `DEFERRAL_MAX_MS` on top — so the real ceiling was 960 s against a documented 900 s.
 * Three places call this a bound; the code now is one.
 */
const DEFERRAL_BUDGET_MS = 900_000;

/**
 * The deferral's own curve, used only when the provider named no `retry-after`.
 *
 * A deferral that always requeued after a fixed 1 s would be a hot loop pointed at a provider
 * that just said it was overloaded — `parseRetryAfter`'s "Retry-After: 0" defect, rebuilt one
 * layer up. So it doubles on the Task's DEFERRAL COUNT (folded, not remembered), which is a pure
 * function of the journal and therefore replayable. `retry-after`, when present, still wins: the
 * scheduled delay is `max(curve, honoured advice)`.
 */
const DEFERRAL_INITIAL_MS = 1_000;
const DEFERRAL_MAX_MS = 60_000;

/**
 * How many times `#intervene` re-decides against a moved head before it gives up.
 *
 * Eight, matching `gates.ts`' `MAX_DECISION_LAPS`, and for its reason: a bound rather than a
 * spin, because the loop's exit depends on other writers stopping. Exhausting it is a refusal
 * (`E_SEQ_CONFLICT`), never a write — the fail-closed answer for a guard that cannot decide.
 */
const MAX_INTERVENTION_LAPS = 8;

/**
 * The failures that are NOT this node's failure — the whole membership test for a deferral.
 *
 * Named as a set rather than checked inline because the claim "these and no others" is the
 * dangerous half: every member is a case where a Task is re-entered without being charged, and
 * a wrong member is an unbounded-in-attempts loop wearing a policy's clothes.
 *
 *   `E_PROVIDER_RATE_LIMIT` · the provider refused to serve us. The node's work never ran, and
 *      nothing about this run caused it. Charging it makes a `maxAttempts: 3` node die of
 *      somebody else's traffic. It is NOT enough to match the `exhausted` class:
 *      `E_BUDGET_EXHAUSTED` shares that class and is a verdict about this run — it is fatal,
 *      caught by `RUN_FATAL_CODES`, and the code test here is the second lock on that door.
 *
 *   `E_SUBGRAPH_FAILED` · **only its retryable arm**, and the two arms are what make this safe
 *      to key on the code alone. `#runSubgraph` raises this code twice: `err.unavailable` for a
 *      child that HAS NOT FINISHED ("not finished is not failed", as that site's own comment
 *      says) and `err.internal` for a child that ended failed. `internal` is not in `RETRYABLE`,
 *      so the `!error.retryable` refusal above has already returned by the time this set is
 *      consulted, and only the poll can reach it. **A third, retryable arm added at that site
 *      would silently join this set** — if one is ever added, split the code rather than
 *      widening this comment.
 *
 * Why the poll belongs here at all: measured. With only the rate limit deferring, a 429 in a
 * CHILD asking for two minutes killed the PARENT, because `DEFAULT_SUBGRAPH_RETRY` spends its
 * twenty charged polls on a 250 ms→5 s curve in about 82 seconds — the "> ~78 s" row of the
 * failure table in TODO §A, reproduced exactly by moving the wait into the child. The parent
 * node did not fail either; it asked whether the child was done and the answer was "not yet".
 */
const DEFERRABLE_CODES: ReadonlySet<string> = new Set([CODES.E_PROVIDER_RATE_LIMIT, CODES.E_SUBGRAPH_FAILED]);

/**
 * THE FAILURES THAT ARE NOT THIS NODE'S FAILURE, and therefore cannot be routed around.
 *
 * FIVE MEMBERS, and the criterion they share is one sentence: *no other node's answer is
 * worth anything, because what broke is the run's ability to say something true.* An
 * ordinary failed Task takes an `error` edge, and a join with `onBranchError: "skip"`
 * absorbs it — so a code that belongs here and is missing produces a run reporting
 * **succeeded** with a rescue arm's value in its output channel. That is the shape below,
 * and each of these five has been measured in it.
 *
 *   `E_BUDGET_EXHAUSTED` · a verdict about the RUN's resources, not about this node's work.
 *      Routing past it spends more of what has already run out. It is the floor of the D6.5
 *      ladder (warn → degrade → gate → fail).
 *
 *   `E_REPLAY_DIVERGENCE` · the fold and the record disagree, so every decision downstream
 *      would be reading a value the journal cannot be folded to. Invariant 2 is what makes
 *      this fatal rather than routable.
 *
 *   `E_GATE_REQUIRED` · A SUPERVISION REQUIREMENT THAT CANNOT BE MET. Leaving it out was a
 *      hole with a very quiet shape: a refused `separationOfDuties` gate is an ordinary
 *      failed task, so an `error` edge or a skipping join absorbs it — measured, both
 *      produce a run that reports **succeeded** with ZERO gates on the journal. The graph
 *      reads "each item is human-approved" and behaves as "nothing was approved and nobody
 *      was asked" — D7.9's worst available failure, reached through ordinary graph shapes,
 *      and worse than a rejection because a rejection at least leaves `gate.raised` and
 *      `gate.decided` behind for an auditor to find.
 *
 *   `E_PAYLOAD_UNRESOLVED` · A CHANNEL WHOSE BYTES CANNOT BE PRODUCED, for the reason the
 *      paragraph above gives about routing. The state this run is meant to be reading is not
 *      there, so no other node's answer is worth more than the one that could not be
 *      computed, and "continue without it" is precisely the silent-wrong answer
 *      externalisation must never introduce.
 *
 *   `E_EFFECT_UNRECORDED` · THE RUN NO LONGER KNOWS WHAT IT DID TO THE WORLD. `#servedToolEffect`
 *      raises it when a re-execution's call sequence has moved and the recorded call at that
 *      position is non-idempotent; declining to serve is necessary and not sufficient, and this
 *      is the sufficient half. Measured before it was added, on the fixture in
 *      `test/run/divergence-is-run-fatal.test.ts` — one `error` edge and a rescue node were
 *      enough to turn the fail-closed refusal into `status=succeeded out="rescued"`. The
 *      failure is not "this node's work did not work"; it is "the positional record and the
 *      body disagree", which is the same class as `E_REPLAY_DIVERGENCE` one door over — and
 *      it stayed out of this set for as long as it did because it is raised deep inside an
 *      effect serve rather than by a policy check.
 *
 * WHAT IS DELIBERATELY OUT, because a named set needs its boundary:
 *   - `E_LEASE_LOST` / `E_FENCING_STALE` — another worker owns this Task. The RUN is fine;
 *     THIS WORKER is not, and ending the run would be one process killing another's work.
 *   - `E_CAP_DENIED`, `E_TOOL_NOT_FOUND`, `E_TOOL_SOURCE_UNAVAILABLE` — "this node cannot do
 *     this". A rescue arm genuinely is an answer to that, which is what `error` edges are for.
 *   - `E_HUMAN_APPROVAL_REQUIRED` — out on purpose and stated so at its raise site: the run
 *     continues so the ASK can be made. A gate that cannot be asked at all is the member
 *     above, and the pair is the whole distinction.
 */
const RUN_FATAL_CODES: ReadonlySet<string> = new Set([
  CODES.E_BUDGET_EXHAUSTED,
  CODES.E_REPLAY_DIVERGENCE,
  CODES.E_GATE_REQUIRED,
  CODES.E_PAYLOAD_UNRESOLVED,
  CODES.E_EFFECT_UNRECORDED,
]);

/**
 * How far down a run tree the two journal-walking descents will go.
 *
 * A BACKSTOP, NOT A POLICY. `expansion.maxDepth` already bounds nesting at compile time, so
 * reaching this means the journal disagrees with the graph that produced it — and neither a
 * rewind's refusal nor a rollback may become the one path in the engine that can recurse
 * forever. Shared by `#uncompensatedIrreversible` and `#compensate` because they answer two
 * halves of one question ("must we refuse to undo this?" and "undo it") over the same tree:
 * two different constants would let the refusal see a call the rollback could not reach.
 */
const COMPENSATION_MAX_DEPTH = 16;

interface Wave {
  readonly task: TaskRecord;
  readonly node: NodeSpec;
}

/**
 * One decided step of a rollback, with everything the dispatcher needs and nothing it decides.
 *
 * NOT EXPORTED, and `RewindPlanStep` in `run/compensation.ts` is: this carries a live
 * `RunContext` and a raw recorded result, which are process state rather than facts an operator
 * can be shown or a hash can cover. `#rewindPlanOf` is the projection from this onto that, and
 * keeping them two types is what stops a `RunContext` leaking into a public preview.
 *
 * `ctx` absent means THIS ENGINE CANNOT DISPATCH IT, and `undispatchable` then says why — the
 * third of the three states, carried rather than inferred at the call site.
 */
interface RollbackWalkStep {
  readonly runId: RunId;
  readonly step: CompensationStep;
  readonly ctx?: RunContext;
  readonly p?: RunProjection;
  /**
   * The last live `effect.completed` result for `step.compensates`, whose `details` are the
   * undo's arguments. The key is ABSENT when no such record exists, which is what lets a
   * legitimately-`undefined` result be told apart from no result at all.
   */
  readonly result?: unknown;
  readonly undispatchable?: string;
}

/**
 * An undo's arguments, from the compensated call's recorded `ToolResult`.
 *
 * ONE READER, TWO CALLERS, which is the whole reason it is a function. `#compensateOne` builds
 * the arguments it dispatches with and `#rewindPlanOf` digests the arguments it shows the
 * operator; if those two disagreed by one coercion, the hash would bind the preview to something
 * other than what runs. `tool.called` carries `argsShape` and `argsDigest` and never the values,
 * so `details` is genuinely the only channel an undo's arguments can come from.
 */
function detailsOf(result: unknown): Record<string, unknown> {
  const details = (result as { readonly details?: unknown } | undefined)?.details;
  return details !== null && typeof details === "object" ? (details as Record<string, unknown>) : {};
}

/**
 * The `compensation.recorded` row for one decided step. ONE WRITER, AND NOW ONE CALLER.
 *
 * It was two: `#compensate` wrote the dispatched rows and `#compensateChild` wrote the rows for a
 * child whose graph could not be rebuilt, and the two had to be the same shape or an operator
 * reading for `not_attempted` would find one kind of silence and not the other. They drifted
 * anyway — only one of them wrote `retryable` — which is the argument for `#dispatchRollback`
 * being a single loop over a single planned walk rather than two methods that agree by review.
 */
function compensationRecord(
  step: CompensationStep,
  outcome: {
    readonly outcome: "compensated" | "failed" | "not_attempted";
    readonly reason?: string;
    readonly retryable?: boolean;
  },
  trigger: "run_failed" | "rewind",
): NewEvent {
  return {
    type: "compensation.recorded",
    payload: {
      compensates: step.compensates,
      compensatesSeq: step.seq,
      tool: step.tool,
      ...(step.undo === undefined ? {} : { undo: step.undo }),
      outcome: outcome.outcome,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
      trigger,
    },
    actor: SYSTEM_ACTOR("compensator"),
    ...(step.taskId === undefined ? {} : { taskId: step.taskId }),
  };
}

/**
 * One map split three ways: what the journal carries, what it points at, and what the fold
 * will end up holding. `values` and `external` are disjoint — a channel is in exactly one —
 * and `projected` is their union with each ref turned back into a handle.
 */
interface Externalised {
  readonly values: Record<string, unknown>;
  readonly external?: Record<string, PayloadRef>;
  readonly projected: Record<string, unknown>;
}

/**
 * What a gate is allowed to do, carried by the outcome that raises it.
 *
 * It exists as a REQUIRED field rather than something `#commit` derives, because
 * `#commit` used to derive it from `node.humanGate` — a block only a `human_gate` node
 * can have (GRAPH020 refuses a second type block). Every other gate-raising path — a
 * posture gate on a tool, a subgraph's mirror gate — therefore journaled no approvers
 * and no `edit` allow-list, and an absent allow-list reads as "anything". Making the
 * field required means a new gate-raising path cannot be written without answering the
 * question; forgetting is a type error rather than a silent widening.
 */
interface GateAuthorization {
  /** Subject ids permitted to decide. Empty = the gate named nobody, which is permissive. */
  readonly approvers: readonly string[];
  /**
   * Subjects barred whatever else admits them — separation of duties, RESOLVED.
   *
   * REQUIRED, like every other member here, on this type's own argument: forgetting an
   * authorization field must be a type error rather than a silent widening. `undefined` is a
   * real value and means "this gate declared no such rule"; it is never `[]`, because a rule
   * that excludes nobody is a rule the author did not write.
   */
  readonly excludedApprovers: readonly string[] | undefined;
  /** Channels an `edit` may write. Always concrete; `[]` means none. */
  readonly allowEdit: readonly string[];
}

/**
 * A resolver that answers CONTENT from what a run already froze, and everything else live.
 *
 * Every recompile that happens while a run is in flight uses this: the child's compile, a
 * mutation, and the rehydrate that replays a mutation after a restart. All three are compiles —
 * so they legitimately pin refs — and all three run inside or alongside an executing Task, so a
 * ref the run has ALREADY resolved must not answer differently the second time.
 *
 * ADDITIVE, which is the same rule graph mutation itself follows. A mutation may introduce a
 * node naming a ref nothing has seen, and that ref has to resolve from somewhere: the live
 * resolver is behind this one and answers it, once, at the compile that introduces it. What the
 * live resolver may not do is change an answer the run is already built on.
 *
 * `resolve` IS overridden, and leaving it live was a real defect rather than a nuance. A digest
 * is over CONTENT — `resourceDigest` is `digest({kind, name, content})` — so a promotion MOVES
 * it, and `@stable` is a mutable selector pointing at whichever digest is current. With `resolve`
 * live, a recompile re-pinned an existing ref to the NEW digest, the frozen map (keyed by the
 * old one) missed, and the fallback served the promoted bytes to a node that already existed.
 * The freeze held only when the content had not changed, which is the case that needed no
 * freeze. Reproduced through the engine before it was fixed.
 */
function frozenFirst(graph: RunGraph, live: ResourceResolver): ResourceResolver {
  // Built once, both directions. `documents` is keyed by REF and `document()` is asked by
  // DIGEST, so the manifest is the bridge — and walking it per lookup would be a scan per prompt.
  const byRef = new Map(graph.resolutionManifest.map((p) => [p.ref, p] as const));
  const byDigest = new Map<string, string>();
  for (const pinned of graph.resolutionManifest) {
    const text = graph.documents[pinned.ref];
    if (text !== undefined) byDigest.set(pinned.digest, text);
  }
  return {
    resolve: (ref) => byRef.get(ref) ?? live.resolve(ref),
    document: (pinned) => byDigest.get(pinned) ?? live.document?.(pinned),
    subgraph: (ref) => graph.subgraphs[ref] ?? live.subgraph?.(ref),
  };
}

/**
 * A refused SoD gate, as a failed OUTCOME rather than a throw.
 *
 * The distinction is the whole reason this is a function. `#commit` — where `raise` is called
 * — runs OUTSIDE the try/catch that turns an exception into `{status:"failed"}`; that catch
 * wraps `#executeTask` only. A throw from the raise path therefore escapes `advance()` with
 * the task still `leased`, and every later `advance` re-leases it, re-executes, and throws
 * again: the run never reaches a terminal state and the command answers 500 forever. A hang
 * dressed as a policy is the one shape a refusal must not take, so the refusal is decided
 * where the outcome is CONSTRUCTED and travels as an ordinary failure.
 */
/**
 * A RETURN NOBODY READS IS AN AUTHORING MISTAKE, NOT AN EMPTY RESULT.
 *
 * `FunctionOutcome` is `{ writes?, take? }`, and it is a TypeScript type — a
 * `resources/function/*.js` author writes plain JS and never sees it. Both ways of getting it
 * wrong were handled badly, and measured through `bin/loom`:
 *
 *   (view) => ({ seen: [x] })   the channel map returned DIRECTLY. `out.writes` is undefined,
 *                               the task commits `writes: {}`, and the run dies later with
 *                               `E_OUTPUT_MISSING` naming a channel the body believed it wrote.
 *   (view) => { ... }           no return at all — "TypeError: Cannot read properties of
 *                               undefined (reading 'writes')", an internal error shown to a
 *                               graph author.
 *
 * TWO CALLERS, because there are two places a function body runs: a `function` node and an
 * `assertion` evaluator, whose `ref` is also a function body. The first version of this check
 * lived inline in `#runFunction` and the evaluator kept the defect — the same too-small-a-set
 * mistake the register keeps recording. A helper is what stops the two drifting.
 *
 * The rule is not a heuristic: an object EVERY key of which is ignored cannot be what the author
 * meant. `{}` stays legal — a body that writes nothing is ordinary — and extra keys alongside
 * `writes`/`take` stay legal too, because then the return WAS read.
 */
/**
 * A seed for a `random` effect the journal does not hold, derived from the effect key.
 *
 * Reached only under replay of a CANDIDATE graph (`onGraphChange: "allow"`), where a node the
 * recording never had asks for a seed nobody ever wrote. Deriving beats drawing: two replays of
 * the same candidate get the same stream, so an eval comparison is measuring the candidate and
 * not the entropy it happened to receive.
 *
 * The first 8 hex characters of the key's digest — 32 bits, which is the whole state of the
 * PRNG the bridge builds from it, so a wider read would be discarded.
 *
 * AFTER THE `sha256:` PREFIX, and the first version forgot it: `digest` returns
 * `sha256:<hex>`, so slicing from 0 hands `parseInt` the string `"sha256:c"` and gets `NaN`.
 * That reached the bridge, made every draw `NaN`, and surfaced three layers away as
 * `CanonicalizationError: non-finite number NaN` when the body's output was journaled — a
 * message naming neither the seed nor the key. Hence the throw below rather than a silent
 * fallback: a seed that is not a finite number can only be a bug here.
 */
function seedFromKey(key: string): number {
  const hex = digest(key).slice(-64, -56);
  const seed = Number.parseInt(hex, 16);
  if (!Number.isFinite(seed)) throw err.internal(CODES.E_INTERNAL, `could not derive a replay seed from "${key}" (digest slice "${hex}")`);
  return seed;
}

/**
 * THE SEAM THAT MAKES `NodeSpec.timeoutMs` BOUND A SANDBOXED `function` BODY.
 *
 * `#withNodeDeadline` is a `Promise.race` on this thread. A body that never yields owns the
 * thread, the timer cannot fire, and the Task's own deadline is not merely late — it is
 * unreachable. Measured through `Engine.advance` on a graph declaring `timeoutMs: 200` with a
 * body of `for (let i = 0; i < 4e9; i++)`: **2,332 ms, status `succeeded`.** The only bound in
 * the product was a hardcoded 30s inside `resources/functions.ts` that no flag and no graph
 * field reached.
 *
 * `vm`'s per-call `timeout` DOES terminate synchronous execution, and it is the only thing in
 * this process that can. It is fixed when the realm is compiled, and nothing on the path from
 * here to the compiler carries a node: `FunctionRegistry`'s loader seam is `(ref) => body`, and
 * the CLI builds the loader at boot with no graph in hand. So a loaded body carries a request to
 * recompile itself at another deadline, under this symbol — defined by `REBIND_DEADLINE` in
 * `resources/functions.ts`, which is where the whole argument, and the list of what remains
 * unbounded, is written down. `Symbol.for` on both sides rather than an export because
 * `src/index.ts` re-exports that module wholesale into the pinned public surface.
 *
 * The two sides agree only by the string, so nothing here proves the bound is live.
 * `test/run/function-timeout-bounded.test.ts` measures the wall clock through `Engine.advance`
 * for exactly that reason: rename either side and it goes red.
 */
const REBIND_DEADLINE = Symbol.for("@loom/core:function.rebindDeadline");

type Rebindable = { [REBIND_DEADLINE]?: (callTimeoutMs: number) => FunctionBody };

const OUTCOME_KEYS = ["writes", "take", "retry"] as const;

function requireOutcome(out: unknown, ref: string, nodeId: NodeId): FunctionOutcome {
  const shape = `a function body returns { writes: { <channel>: value } } and optionally { take: [<edgeId>] }, or { retry: { reason } } to ask for another attempt`;
  if (out === null || typeof out !== "object") {
    throw err.validation(
      CODES.E_RESOURCE_INVALID,
      `function "${ref}" on node "${nodeId}" returned ${out === undefined ? "nothing" : String(out)} — ${shape}`,
    );
  }
  const keys = Object.keys(out);
  if (keys.length > 0 && !OUTCOME_KEYS.some((k) => k in out)) {
    throw err.validation(
      CODES.E_RESOURCE_INVALID,
      `function "${ref}" on node "${nodeId}" returned {${keys.join(", ")}}, every key of which is ignored — ${shape}. ` +
        `Did you mean { writes: { ${keys[0]!}: … } }?`,
    );
  }
  const retry = (out as { retry?: unknown }).retry;
  if (retry !== undefined) {
    // THE SHAPE IS REFUSED RATHER THAN COERCED, for the reason the whole of this function
    // exists: `retry: true` is the obvious thing to write, it is not the contract, and
    // accepting it would make `{retry: "maybe"}` and `{retry: 0}` mean different things by
    // accident. One shape, named in the message.
    if (retry === null || typeof retry !== "object" || Array.isArray(retry)) {
      throw err.validation(
        CODES.E_RESOURCE_INVALID,
        `function "${ref}" on node "${nodeId}" returned retry: ${String(retry)} — retry is an object, ${'{ retry: { reason: "…" } }'}`,
      );
    }
    // EXCLUSIVE. "Retry me, and also commit this" has no coherent reading — a retry re-runs
    // the body, so the writes would be proposed a second time. Refusing beats picking one,
    // which is the lesson from the return-value defect this function was written for.
    if ("writes" in out || "take" in out) {
      throw err.validation(
        CODES.E_RESOURCE_INVALID,
        `function "${ref}" on node "${nodeId}" returned retry alongside ${"writes" in out ? "writes" : "take"} — a retry re-runs the body, so anything it also asked to commit would be proposed twice. Return one or the other`,
      );
    }
  }
  return out as FunctionOutcome;
}

/**
 * Turn a body's `{ retry: … }` into the retryable failure `#retryDecision` can act on.
 *
 * ONE HELPER, TWO CALLERS, and that is deliberate rather than tidy. `functions.require` has
 * exactly two — `#runFunction` and `#runEvaluator`'s `assertion` arm — and the last two changes
 * to this contract were each written inline in the first and forgotten in the second. A shared
 * function cannot drift; a second copy is the same defect deferred.
 *
 * `unavailable` is what makes it retryable at all: `RETRYABLE` in `errors.ts` holds exactly
 * `exhausted`, `unavailable`, `timeout`, and a guest object can never be a host `LoomError`, so
 * the engine raises this on the body's behalf.
 */
function retryRequested(out: FunctionOutcome, ref: string, nodeId: NodeId): void {
  if (out.retry === undefined) return;
  const why = typeof out.retry.reason === "string" && out.retry.reason.length > 0 ? out.retry.reason : "no reason given";
  throw err.unavailable(CODES.E_FUNCTION_UNAVAILABLE, `function "${ref}" on node "${nodeId}" asked to be retried: ${why}`);
}

function sodOn(node: NodeSpec, p: RunProjection): NodeOutcome | undefined {
  if (node.humanGate?.approval?.separationOfDuties !== true) return undefined;
  const why = sodRefusal(p, node.humanGate.approval.approvers ?? []);
  if (why === undefined) return undefined;
  return {
    status: "failed",
    writes: {},
    usage: { ...ZERO_USAGE },
    // E_GATE_REQUIRED, not E_GATE_NOT_AUTHORIZED, and the difference is what makes this
    // RUN-fatal rather than task-fatal. The other code says "you may not decide this"; this
    // one says "this action requires a decision that cannot be obtained", which no error edge
    // should be able to route around.
    error: err.policy(
      CODES.E_GATE_REQUIRED,
      `node "${node.id}" declares separationOfDuties and cannot be supervised on this run: ${why}`,
      { details: { nodeId: node.id } },
    ),
  };
}

/**
 * Why a gate declaring separation of duties cannot be raised on this run.
 *
 * `undefined` when it can. The three refusals are one rule read three ways: the exclusion has
 * to name a PERSON, or the gate would be journaled as supervised and enforce nothing.
 */
function sodRefusal(p: RunProjection, approvers: readonly string[]): string | undefined {
  const by: unknown = p.submittedBy;
  // TOTAL, like `ownerOf` at the HTTP boundary and for the same reason: the type says
  // `SubmittedBy` and the value came out of a fold over a journal, which is an input. A bare
  // `by.kind` on `null`, or `isSyntheticSubject` on a number, exits as a raw `TypeError`
  // wearing `E_INTERNAL` — fail-closed, but untyped and silent about which node.
  if (typeof by !== "object" || by === null) {
    return (
      `no principal is recorded as having submitted this run, so there is nobody to exclude. ` +
      `Submit through the API with a credential, or with \`loom run --as <subject>\``
    );
  }
  // A SERVICE IS NOT A PERSON, and a marker is not even a service. `(shared-token)` and
  // `(unidentified)` describe what the perimeter concluded; excluding either bars a subject
  // no human actor can present, which is a gate that reads as supervised and is answerable by
  // everyone including whoever started the run. That is the exact failure this whole block
  // exists to prevent, so it is refused rather than resolved.
  const kind: unknown = (by as Record<string, unknown>)["kind"];
  const subject: unknown = (by as Record<string, unknown>)["subject"];
  // AN EMPTY OR UNREADABLE SUBJECT IS A FIFTH PATH TO A TOOTHLESS EXCLUSION, and it was
  // missing: `excludedApprovers: [""]` is present, journaled, reads as supervised, and bars
  // nobody. The bound matches the one the perimeter and `submitterOf` both apply — over it,
  // the read model already declines to derive an owner, so the exclusion would name a subject
  // no principal can present while the run listed as unowned.
  if (typeof subject !== "string" || subject.trim() === "" || subject.length > MAX_SUBJECT) {
    return `the principal recorded on this run does not name anybody readable, so there is nobody to exclude`;
  }
  if (kind !== "human" || isSyntheticSubject(subject)) {
    return (
      `this run was submitted by "${subject}" (${String(kind)}), which is not a person — excluding it would bar nobody ` +
      `while the gate read as supervised`
    );
  }
  // AND A GATE WHOSE APPROVERS ARE ONLY THE INITIATOR CAN NEVER BE ANSWERED. The compiler
  // cannot see this: `approvers` is static in the spec and the initiator is a runtime fact.
  // `raise` holds both, so it is caught here rather than parked until an SLA it may not have.
  if (approvers.length > 0 && approvers.every((a) => a === subject)) {
    return `the only approver it names is "${subject}", who submitted this run — so nobody could ever answer it`;
  }
  return undefined;
}

/** The same bound `submitterOf` and the HTTP perimeter apply; the journal is the same journal. */
const MAX_SUBJECT = 256;

/**
 * Distinct compiled child graphs one process keeps.
 *
 * The unit is (ref, child spec, parent freeze), so it is not "how many subgraphs does a graph
 * name" but "how many combinations does this deployment produce" — a new one appears whenever a
 * child is republished or a parent's frozen resources move. A deployment that promotes a
 * resource daily and runs two subgraph refs adds two entries a day.
 *
 * REVERSE IT if a deployment measures recompiles it cares about; the cost of being wrong is a
 * recompile, not an answer.
 */
const MAX_CACHED_CHILD_GRAPHS = 256;

/**
 * What a `human_gate` node declared about a gate's LIFECYCLE — when it expires, where it
 * is sent, and whether it may merge with its siblings or inherit their answer.
 *
 * Kept out of `GateAuthorization` because NOT ONE FIELD HERE DECIDES WHO MAY ANSWER, and
 * grouping them there would put a notification route inside the object whose whole purpose
 * is that everything in it is checked against. That split is what the saturation controls
 * had to be measured against before they could go anywhere: `batching` and `dedupe` change
 * how many questions a human is asked, never which of them a given human may answer —
 * whose gates may merge, and whose answer may be inherited, is decided in `run/gates.ts`
 * from the JOURNALED authorization of the gates involved and never from these fields.
 *
 * Every field is passed through to `GateRequest` unchanged; this type exists to carry them
 * from the node to `#commit`, not to reinterpret them.
 */
interface GateSchedule {
  readonly slaMs?: number;
  readonly onTimeout?: TimeoutAction;
  readonly delivery?: DeliverySpec;
  readonly batching?: BatchingSpec;
  readonly dedupe?: DedupeSpec;
  /** D7.2's reminders: nudges before the deadline, same tier, same recipients. */
  readonly reminders?: readonly { readonly afterMs: number }[];
}

interface NodeOutcome {
  readonly status: "succeeded" | "failed" | "gate";
  readonly writes: Record<string, unknown>;
  readonly take?: readonly EdgeId[];
  readonly usage: UsageRecord;
  readonly error?: LoomError;
  readonly gate?: {
    readonly payload: unknown;
    /**
     * What an approval of this gate BINDS — see `#gateBinding`.
     *
     * It rides on the outcome rather than being computed at `#commit`, and that is not
     * arrangement: `payload` is rendered in the BODY phase, against the projection as it stood
     * before this wave committed anything, and the binding has to be taken from the same
     * projection or the approval would cover a state the approver was never shown.
     *
     * Absent on a MIRROR, which is the only gate whose payload comes from another run.
     */
    readonly binding?: unknown;
    readonly policyRef: string;
    readonly auth: GateAuthorization;
    /**
     * The child-run gate this one stands in for. Set by `#runSubgraph` and by nothing
     * else; its presence is what makes a gate a mirror, for the broker and for
     * `#executeTask` alike.
     */
    readonly mirrorOf?: GateId;
    /**
     * The clock and the route the GRAPH declared, carried unchanged to `raise`.
     *
     * OPTIONAL, unlike `auth`, and the asymmetry is the point. An absent `auth` would
     * mean "this gate restricts nobody", which is a decision somebody has to make on
     * purpose; an absent schedule means "no deadline, no notification", which is what a
     * gate raised by the POSTURE floor — a tool node with no `humanGate` block to declare
     * anything on — honestly has.
     */
    readonly schedule?: GateSchedule;
  };
  /** An agent node's proposed graph mutation, if it declared `canMutate`. */
  readonly mutation?: GraphMutation;
  /** Set by a join: the already-folded values, to emit as `state.reduced`. */
  readonly reduced?: {
    readonly values: Record<string, unknown>;
    readonly channels: readonly string[];
    readonly branchCount: number;
    readonly skipped: number;
  };
}

interface RunContext {
  readonly runId: RunId;
  /** Mutable: an accepted mutation swaps in a successor graph mid-run (D5.7). */
  graph: RunGraph;
  index: GraphIndex;
  /** Nodes added by mutations so far, against `expansion.maxNodes`. */
  addedNodes: number;
  /** Incremental projection state, so a long run does not re-fold its own history. */
  folder: RunFolder;
  /** E4's counter: consecutive failures per node, reset by any success. */
  readonly streaks: FailureStreaks;
  /** Channels written by a tool, i.e. carrying untrusted output. E8's evidence. */
  readonly tainted: Set<string>;
  /**
   * Channels carrying secret-classified data they were NOT declared to hold.
   *
   * The confidentiality axis of what `tainted` does for integrity, and it exists because the
   * declared classification is a property of the CHANNEL rather than of the data in it. One
   * ordinary node — a normalizer, a summariser — reading a `secret_ref` channel and writing an
   * `internal` one moved the secret to a channel with a lower floor, and the downstream sink
   * dropped from `in` to `on` with no gate and no diagnostic. Measured: the tool received the
   * plaintext.
   *
   * WHY THIS IS NOT THE SAME AS RAISING THE FLOOR FOR A DECLARED SECRET. A human ceiling may
   * lower a node that reads a declared `secret_ref` channel, and that is correct — the
   * classification is written in the graph they were shown, so their "let this run on-the-loop"
   * covered it. A secret that arrived by LAUNDERING is different in exactly the way taint is:
   * it is information the human did not have when they decided, so the earlier judgement no
   * longer covers this action and they are asked again.
   *
   * Monotonic and never cleared, like taint, so folding forward from seq 1 reaches the state the
   * original process held. The cost is the same one taint accepts: a channel stays hot after the
   * secret has been overwritten, and there is deliberately no declassification operator.
   */
  readonly carriesSecret: Set<string>;
  /**
   * The capability ceiling in force for this run — this graph's allowlist, narrowed by whatever
   * a parent already narrowed. `undefined` means no graph in the chain declared one.
   *
   * Kept here rather than only inside `PolicyEngine` because a subgraph's child run gets its OWN
   * engine, and "never widened" has to survive delegation or it means nothing — which is the
   * shape T6 was: a guarantee that a child escaped.
   */
  readonly grantBound: readonly string[] | undefined;
  /**
   * Channels a node LATER IN THIS WAVE will taint — derived per wave, never durable.
   *
   * `#runWave` executes the whole wave with `Promise.all` and commits afterwards, so every
   * policy decision in a wave is made before any of that wave's writes land. `applyTaint` runs
   * in the commit loop. So a node decided in the SAME wave as its tainter saw a clean set, and
   * that is reachable by DELETING AN EDGE:
   *
   *     start → fetch (taints `untrusted`) ; start → charge (irreversible, reads `untrusted`)
   *
   * With `fetch → charge` the two are in different waves, `charge` is tainted, E8's hard floor
   * forces `in`, and a human ceiling of `on` cannot lower it — the run gates. With the edge
   * removed they share a wave, `charge` sees nothing, the ceiling applies, and the charge RUNS.
   * Measured: `succeeded, gates=0, charged=1` against `awaiting_gate, gates=1, charged=0` for
   * the same graph one edge apart. The compiler only WARNS about the missing edge
   * (`GRAPH005_UNPRODUCED_READ`).
   *
   * Keyed by TaskId and excluding the deciding task's own writes: an external node's own output
   * is untrusted, but its INPUT on the same channel came from somewhere else and tainting it
   * against itself would over-gate the ordinary read-modify-write shape for no gain.
   *
   * DERIVED, NOT DURABLE, and that is the whole reason it is a separate field rather than a
   * pre-fill of `ctx.tainted`. That set's docstring makes a promise this would break —
   * "monotonic and never cleared, so folding it forward from seq 1 gives the same answer as
   * running it live" — because a wave member that FAILS writes nothing, so no fold ever produces
   * its channels. This overlay is recomputed from the wave's composition, which is itself
   * derived, so a replay of the same wave reaches the same answer without anything being
   * journaled that a fold could not reproduce.
   */
  waveTaint: ReadonlyMap<TaskId, ReadonlySet<string>>;
  /** Tool names called by each in-flight Task, in order. E5's evidence. */
  readonly toolCalls: Map<TaskId, string[]>;
  /** E2 fires once per run, not once per reservation past the line. */
  warnedBudget: boolean;
  /**
   * In-flight `policy.escalated` appends, awaited after each wave.
   *
   * `PolicyEngine.escalate` is synchronous — the posture must tighten before the next
   * decision reads it — so its journal record cannot be awaited where it is produced.
   * It used to be fired with `void` and no catch: unordered, and a rejection nobody
   * observed, on the one append that justifies a posture change. Serializing it keeps the
   * order and parking the promise here keeps the failure.
   */
  readonly escalationWrites: Promise<unknown>[];
  /** Has the journal's oversight and spend been folded back into `policy` yet? */
  policySeeded: boolean;
  /**
   * TaskId → the seq of the lease this process holds.
   *
   * Presented on the commit so the store can refuse a worker whose lease another process
   * has since taken. Cleared on commit, so it does not grow with the run.
   */
  readonly leases: Map<TaskId, number>;
  readonly log: RunLog;
  readonly policy: PolicyEngine;
  readonly abort: AbortController;
  /** Compiled once per run; `when`/`until` are evaluated many times. */
  readonly exprCache: Map<string, Expr>;
}

export class Engine {
  readonly #store: StateStore;
  readonly #bus: EventBus | undefined;
  readonly tools: ToolRegistry;
  readonly functions: FunctionRegistry;
  readonly #hooks: HookRegistry | undefined;
  readonly models: ModelRegistry;
  /**
   * PRIVATE, and that narrowing is structural rather than a convention.
   *
   * `resolveGate` refuses a non-human actor precisely so that no caller can present
   * `executor:subgraph` and walk past an approvers list. While the broker itself was a
   * public field, that guarded ONE of two doors onto the same object: any in-process
   * caller — the exact threat the `resolveGate` docstring names — could reach
   * `engine.gates.resolve(...)` directly with a system actor and approve a gate that
   * declared approvers. A rule applied at one of two entry points is a convention, and
   * this codebase has already paid twice for the difference.
   *
   * Nothing outside this class ever read it: `src/` and `test/` use `engine.openGates`
   * and `engine.resolveGate`, which are the read surface and the guarded write. So the
   * narrowing costs no caller anything. `EngineOptions.gates` still lets one INJECT a
   * broker — a caller who constructs the object already holds it, which is a different
   * thing from the Engine handing it out.
   */
  readonly #gates: HumanGateBroker;
  readonly #now: () => number;
  readonly #workerId: string;
  readonly #maxParallelism: number;
  readonly #policyOpts: Omit<PolicyEngineOptions, "onEscalate">;
  readonly #replay: ReplayEffects | undefined;
  readonly #payloads: PayloadStore | undefined;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #contextTokens: number;
  readonly #resolver: ResourceResolver;
  readonly #childGraphs = new Map<string, RunGraph>();
  readonly #scheduler: Scheduler;
  readonly #sequences: SequenceIndex | undefined;
  readonly #baseline: CohortBaseline | undefined;
  readonly #sweepOpts: Omit<GateSweeperOptions, "store" | "broker" | "bus" | "now">;
  /** Built on first use and KEPT: its cursors are the whole point. See `sweepGates`. */
  #sweeper: GateSweeper | undefined;

  readonly #runs = new Map<RunId, RunContext>();
  /** Per-run advance chain. See `advance`. Self-evicting. */
  readonly #advancing = new Map<RunId, Promise<void>>();
  /**
   * The per-run rewind chain, `#advancing`'s sibling and for the identical reason.
   *
   * SEPARATE FROM `#advancing` rather than shared, and that is a choice with a cost. Sharing one
   * map would also serialize a rewind against a concurrent `advance`, which is a real hazard —
   * but `advance` is called from `rewind`'s own callers and from the HTTP route in the same
   * breath, and a rewind that waits on an advance that waits on a lease is a deadlock this change
   * has no evidence it needs. What IS measured is two rewinds racing each other, and that is what
   * this closes. Rewind-against-advance stays open and is named here rather than implied.
   */
  readonly #rewinding = new Map<RunId, Promise<void>>();
  /** Serializes journal commits. Work runs in parallel; the log has one writer. */
  #commitChain: Promise<unknown> = Promise.resolve();

  constructor(opts: EngineOptions) {
    this.#store = opts.store;
    this.#bus = opts.bus;
    this.tools = opts.tools ?? new ToolRegistry();
    this.functions = opts.functions ?? new FunctionRegistry();
    this.#hooks = opts.hooks;
    this.models = opts.models ?? new ModelRegistry();
    this.#now = opts.now ?? Date.now;
    this.#gates = opts.gates ?? new HumanGateBroker({ now: this.#now });
    this.#workerId = opts.workerId ?? "worker-0";
    this.#maxParallelism = Math.max(1, opts.maxParallelism ?? 16);
    this.#policyOpts = opts.policy ?? { granted: ["*"] };
    // AT ENGINE CONSTRUCTION, EVEN THOUGH THE ENGINE IS NOT WHAT VALIDATES IT. A
    // `PolicyEngine` is built lazily per run in `#contextFor`, so an out-of-range
    // `interventionWindowMs` would otherwise first surface from inside `submit` — an
    // unstartable RUN rather than an unstartable PROCESS, which is the wrong end of a
    // deployment's day to discover a config error. Discarding the instance is the point:
    // the constructor is the check.
    new PolicyEngine(this.#policyOpts);
    this.#replay = opts.replay;
    this.#payloads = opts.payloads;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#contextTokens = opts.contextTokens ?? 100_000;
    // Mutations must resolve the same refs the original compile did. Without a real
    // resolver a mutation can only add nodes that reference nothing.
    this.#resolver = opts.resolver ?? { resolve: () => undefined };
    this.#scheduler = opts.scheduler ?? new InProcessScheduler();
    this.#sequences = opts.sequences;
    this.#baseline = opts.baseline;
    this.#sweepOpts = opts.sweep ?? {};
    // SAME ARGUMENT AS `new PolicyEngine(...)` ABOVE, and it was missing ten lines below the
    // idiom that makes it true. `GateSweeper` is built lazily in `sweepGates`, so an
    // out-of-range `limit` first surfaced from inside a TICK — and the deployment snippet in
    // that method's own docstring wraps the tick in `.catch(() => {})`, which swallows it
    // forever: a sweeper that watches nothing, silently, on a process that started clean.
    // Measured before this line existed: `new Engine({sweep: {limit: NaN}})` succeeded and every
    // subsequent `sweepGates()` rejected. The instance is discarded; the constructor is the
    // check.
    new GateSweeper({
      ...this.#sweepOpts,
      store: this.#store,
      broker: this.#gates,
      ...(this.#bus === undefined ? {} : { bus: this.#bus }),
    });
  }

  /**
   * ADVANCE THE GATE CLOCK ONCE. The deployment decides how often; the engine never does.
   *
   * Nothing used to call `HumanGateBroker.sweepTimeouts` at all —
   * `grep -ran sweepTimeouts packages/core/src` found its own definition and nothing else
   * — so in `bin/loom` an SLA deadline never expired, an escalation tier never fired, and a
   * gate declaring `onTimeout: "fail"` waited forever. Four design documents were corrected
   * to stop drawing a scheduler tick that does not exist. This method is the tick's other
   * half: the thing that CAN be driven.
   *
   * IT IS A METHOD AND NOT A TIMER, and that is the whole design decision. A library that
   * schedules work on import is hostile to its embedder — it keeps a process alive, it runs
   * during a test that never asked for it, and it puts a wall clock inside the determinism
   * boundary the rest of this file is built to keep out. `now` is a parameter for the same
   * reason every other clock here is injected: a test advances it and observes exactly one
   * escalation, with no timer and no sleep. The INTERVAL belongs to the deployment
   * (`cli.ts`'s `serve`, or whatever owns the process), which is the layer that already
   * owns a lifetime to hang it off.
   *
   * IT SWEEPS THIS ENGINE'S BROKER, not a broker the caller builds, and that is not an
   * accident of encapsulation. The half of a gate that is not journaled — the rendered
   * payload, the pre-authorized default action, and above all the `DeliverySpec` — lives in
   * the broker that RAISED it. A sweeper over a freshly-constructed broker would find no
   * delivery spec for any gate, conclude every escalation chain was exhausted, and expire
   * gates that should have escalated. Silently. So the sweep is offered where the broker
   * is, and `EngineOptions.gates` remains the way to supply your own.
   *
   * WHAT IT COSTS, per call, is in `GateSweeper`'s docstring, and so is the one thing it
   * cannot see: runs outside the `limit` most recent.
   *
   * THE WHOLE DEPLOYMENT SIDE, so nobody has to guess at it:
   *
   * ```ts
   * const tick = setInterval(() => void engine.sweepGates().catch(() => {}), 1_000);
   * tick.unref();                       // a clock must not be why the process stays up
   * // …and clearInterval(tick) on shutdown, before the store closes.
   * ```
   *
   * The `catch` is not laziness: a tick that rejects on an unhandled promise takes the
   * process down, and every failure this method can have is already counted in
   * `SweepReport.failed` and retried on the next tick. One second is a guess — the sweep is
   * correct at any interval, and the cost of a longer one is that a deadline fires late by
   * up to that interval.
   */
  async sweepGates(now = this.#now()): Promise<SweepReport> {
    this.#sweeper ??= new GateSweeper({
      ...this.#sweepOpts,
      store: this.#store,
      broker: this.#gates,
      now: this.#now,
      ...(this.#bus === undefined ? {} : { bus: this.#bus }),
    });
    return this.#sweeper.sweep(now);
  }

  /**
   * Fire an escalation rule, by name.
   *
   * One funnel, so every rule is journaled the same way and none can quietly skip the
   * `policy.escalated` record that tells an operator why the run suddenly asked.
   */
  /**
   * THE RULE ID AND ITS EVIDENCE TRAVEL SEPARATELY.
   *
   * They used to be one string: `` `${id} ${JSON.stringify(detail)}` ``. Seven of these eight
   * rules pass a detail, so seven of eight journaled a `rule` no consumer could match — and one
   * consumer was already trying. `evolution/trajectory.ts` counted E6 with
   * `e.payload.rule === "violation"` against the value `violation {"capability":{…}}`.
   */
  #escalate(ctx: RunContext, id: EscalationRuleId, nodeId?: NodeId, detail?: Record<string, unknown>): void {
    const rule = ESCALATION_RULES[id];
    ctx.policy.escalate(scopeOf(rule, ctx.runId, nodeId), rule.to, id, detail);
  }


  /**
   * The first irreversible call with no compensation in this range — FOLLOWING child runs.
   *
   * `tool.called` is appended after the body returned, so it is the record that an action really
   * happened, and it carries the class the call ran under. Scanning declared tools instead
   * answers a different question: an `agent` node that merely lists an irreversible tool has not
   * necessarily invoked it.
   *
   * A `subgraph` node's calls are in ANOTHER journal. `subgraph.started` carries the
   * `childRunId` and the id is derived, so following it is exact rather than a guess — and it
   * has to be followed, or "the store must not offer a silently-unsafe undo" holds only for
   * work a graph did without delegating it. HANDOFF T6 recorded the sibling gap in
   * `reachableToolNames` and judged it "not currently a hole" on the POSTURE argument, which is
   * sound and is about a different consumer; this one is a hole and was reproduced.
   *
   * Depth-bounded and visited-checked, on `COMPENSATION_MAX_DEPTH` — shared with `#compensate`,
   * which walks the same tree to actually run the undos this refuses to skip.
   */
  async #uncompensatedIrreversible(
    events: AsyncIterable<JournalEvent>,
    runId: RunId,
    depth: number,
    seen: Set<RunId> = new Set([runId]),
  ): Promise<{ name: string; seq: number; irreversibility: string; runId: RunId } | undefined> {
    if (depth > COMPENSATION_MAX_DEPTH) return undefined;
    const children: RunId[] = [];
    for await (const ev of events) {
      if (ev.type === "subgraph.started") {
        const child = ev.payload.childRunId;
        if (!seen.has(child)) {
          seen.add(child);
          children.push(child);
        }
        continue;
      }
      if (ev.type !== "tool.called") continue;
      const called = ev.payload;
      if (called.irreversibility !== "irreversible" && called.irreversibility !== "externally_visible") continue;
      // Fail closed: a tool the registry no longer carries cannot be shown to compensate.
      if (this.tools.get(called.name)?.compensation === undefined) {
        return { name: called.name, seq: ev.seq, irreversibility: called.irreversibility, runId };
      }
    }
    // The child ran ENTIRELY inside the window the parent is suppressing — its `subgraph.started`
    // is in that range — so its own log is scanned from the beginning, not from `atSeq`.
    for (const child of children) {
      const hit = await this.#uncompensatedIrreversible(this.#store.read(child, 1 as Seq), child, depth + 1, seen);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  /**
   * RUN THE ROLLBACK. This is the half of compensation that was never built.
   *
   * `graph/validate.ts` has proved since GRAPH012 that a declared rollback exists, and the only
   * place compensation reached the runtime was `rewind`'s REFUSAL to cross an uncompensated
   * effect. So the shipped feature was "we refuse because you have no compensation", never "we
   * ran your compensation". `run/compensation.ts` decides what to undo and in what order; this
   * decides nothing and performs, which is the split that lets the plan be inspected without
   * letting anything act.
   *
   * THROUGH `#invokeTool`, WHICH IS THE WHOLE POINT. A compensation runs a tool, so it is
   * validated, filtered by `preTool`, judged by `PolicyEngine.decide` and held for the
   * intervention window exactly like any other call — and `nodeApproved` is FALSE, always. A
   * rollback is not a human's yes to anything: the human, if there was one, approved the action
   * being undone. So an undo that policy answers `gate` is REFUSED and journaled `failed`,
   * which is the answer that keeps this from being the back door that performs an irreversible
   * action a gate would have stopped. `GRAPH012_COMPENSATION_VISIBLE` warns about exactly that
   * tool at compile time; this is where the warning is enforced rather than repeated.
   *
   * THE UNDO'S ARGUMENTS ARE THE COMPENSATED CALL'S RECORDED `details`, and nothing else could
   * work. `tool.called` carries `argsShape` and `argsDigest` — a shape and a digest, never the
   * values, because "the arguments are not in the journal anywhere else and putting them here
   * would make every journal a copy of the production data" — so the original arguments are
   * genuinely unrecoverable. `details` is: it is on the recorded `ToolResult` in
   * `effect.completed`, and it is documented as "for renderers and telemetry, never sent to the
   * model", which makes it exactly the right channel for an undo record. `fs.write` already
   * writes one on purpose — it captures the prior content into `details.previous` "so
   * `fs.restore` has something to restore to" — and `fs.restore`'s parameters are `{path,
   * previous}`. That handshake existed and had no caller. This is the caller.
   *
   * A CALL WHOSE RESULT IS NOT IN THE JOURNAL IS `not_attempted`, not a guess. That covers the
   * honest gap `#unfinishedToolEffect` names: `effect.started` with no live `effect.completed`
   * means the tool threw, or the process died mid-call, and the journal cannot say what the
   * world did. Dispatching an undo on no record would be inventing the arguments.
   *
   * SEQUENTIAL, never `Promise.all`. The order is the feature — see `run/compensation.ts` — and
   * a rollback fired concurrently has no order at all. It also appends its record per step
   * rather than in one batch at the end, so a process that dies halfway leaves the steps it
   * finished settled: the resumed rollback re-plans from the journal and skips them.
   *
   * ── AND IT DESCENDS INTO CHILD RUNS ──────────────────────────────────────────
   * `planCompensation` is handed ONE journal, and `subgraph.started`'s docstring says why that
   * is not enough: it "is the only link between them, which is what keeps a parent's journal
   * the size of the parent rather than of its whole tree". So an effect performed inside a
   * delegated run was never undone, while `#uncompensatedIrreversible` — the REFUSAL half of
   * the same feature, and the sibling consumer of the same blindness — has followed
   * `subgraph.started` since T6. "We refuse to rewind past a child's charge" held and "we undo
   * a child's charge" did not.
   *
   * THE ORDER ACROSS TWO JOURNALS IS THE PARENT'S `subgraph.started` SEQ. `seq` is a total
   * order only WITHIN a journal, so a child's seqs and a parent's are not comparable at all —
   * but the parent's own record of starting the child IS in the parent's order, and it is
   * exactly where the whole child sat in the parent's sequence. So the child's plan is spliced
   * into the parent's reverse walk at that point rather than appended after it. Doing children
   * last would undo a call the parent made AFTER the delegation only once the delegation was
   * already unwound, which is forward order with extra steps.
   *
   * SCOPED LIKE THE REFUSAL IS: a child is descended into when its `subgraph.started` is inside
   * the range, and then its OWN journal is planned from seq 1 — the child ran entirely inside
   * the window the parent is suppressing, so there is no boundary to carry down. That is
   * verbatim what `#uncompensatedIrreversible` does, and the two answering differently about
   * the same journal is the defect neither of them should be able to have.
   *
   * `seen` IS OVER RunIds AND THAT IS LOAD-BEARING. A visited-set over REFS would be a cycle
   * guard that also skips descending — the shape that produced an order-dependent oversight
   * floor in `#deadlineFor` — because one ref is legitimately delegated to many times. A child
   * run id is `${parentRunId}~${taskId}`, derived and strictly nested, so two distinct
   * delegations can never collide on one and a repeat is a real cycle rather than a second
   * visit. The depth cap is the same backstop `#uncompensatedIrreversible` carries, for the
   * same reason: `expansion.maxDepth` bounds nesting at compile, so this guards a journal that
   * disagrees with the graph.
   */
  async #compensate(
    ctx: RunContext,
    p: RunProjection,
    trigger: "run_failed" | "rewind",
    sinceSeq = 0,
  ): Promise<{ readonly compensated: number; readonly failed: number; readonly notAttempted: number }> {
    return this.#dispatchRollback(await this.#planRollback({ runId: ctx.runId, log: ctx.log, ctx, p, sinceSeq }), trigger);
  }

  /**
   * THE WALK, DECIDED AND NOT PERFORMED — one function, two consumers.
   *
   * This is the split `run/compensation.ts` already makes for ONE journal, made a second time
   * for the TREE. That module decides what a single log implies and performs nothing; this
   * decides what a whole run tree implies — which journals, in which order, under which context —
   * and still performs nothing. `#dispatchRollback` is the only thing below that acts.
   *
   * WHY IT IS EXTRACTED RATHER THAN COPIED FOR THE PREVIEW. `Engine.planRewind` has to show an
   * operator the list `rewind` will dispatch, and the only version of that claim which is true by
   * CONSTRUCTION is the one where both read the same function. The alternative was measured
   * before this existed and it is why A.35 was written: `rewind` previewed
   * `planCompensation(parent's own events)` and dispatched this walk, so on
   * `rewind-through-subgraph`'s DELEGATED leg the preview had zero steps, its hash was the digest
   * of `[]`, and a `pay.refund` was dispatched in the child. A second copy of the descent is the
   * drift hazard, not the fix — the same sentence `rewind` already carried about its deleted
   * pre-check, applied to the preview it was about to grow.
   *
   * IT RESOLVES CONTEXTS, WHICH IS WHY IT IS ASYNC AND NOT PURE. "Can this engine dispatch this
   * step" is not a fact about the journal — it is a fact about what this process holds — and it
   * is exactly the fact the preview must not omit, because "nothing to undo" and "an effect
   * stands and nobody will try" are different answers. `#childContextFor` is asked here, once,
   * and its answer travels with the step.
   *
   * `log`, `ctx` AND `resolveFrom` ARE THREE PARAMETERS BECAUSE THEY ARE THREE CAPABILITIES, and
   * a run can hold any combination of them. READING a journal needs only a `RunLog`, which
   * `#logFor` builds for any run id. DISPATCHING in THIS run needs the graph, the policy engine
   * and the abort signal, which live on a `RunContext` this engine may not hold — `ctx` absent is
   * the detached case, and it makes this run's own steps `undispatchable` rather than absent,
   * which is the whole difference between "nothing to undo" and "an effect stands". RESOLVING A
   * CHILD needs a compiled graph carrying `subgraphs[ref]`, and that is a THIRD thing: a child
   * whose own context cannot be rebuilt still has grandchildren whose refs the PARENT's graph
   * resolves, so `resolveFrom` keeps travelling down after `ctx` has stopped. Collapsing any two
   * of these loses a case that is already tested: collapsing the first two made a detached rewind
   * of a fully-delegated run report an EMPTY plan; collapsing the last two would leave a
   * grandchild's effects standing with nothing in any journal saying so.
   */
  async #planRollback(input: {
    readonly runId: RunId;
    readonly log: RunLog;
    /** The context this run's OWN steps would dispatch under. Absent means this engine cannot. */
    readonly ctx?: RunContext;
    readonly p: RunProjection;
    readonly sinceSeq?: number;
    readonly depth?: number;
    readonly seen?: Set<RunId>;
    /** The context a child `ref` is rebuilt from. Defaults to `ctx`; see the docstring. */
    readonly resolveFrom?: RunContext;
    /** Why this run's own steps cannot be dispatched. Read only when `ctx` is absent. */
    readonly why?: string;
  }): Promise<readonly RollbackWalkStep[]> {
    const { runId, log, ctx, p } = input;
    const sinceSeq = input.sinceSeq ?? 0;
    const depth = input.depth ?? 0;
    const seen = input.seen ?? new Set([runId]);
    const resolveFrom = input.resolveFrom ?? ctx;

    const events: JournalEvent[] = [];
    for await (const ev of log.read(1 as Seq)) events.push(ev);
    const plan = planCompensation({ events, tools: this.tools, sinceSeq });

    const children: { readonly at: number; readonly runId: RunId; readonly ref: string }[] = [];
    if (depth < COMPENSATION_MAX_DEPTH) {
      for (const ev of events) {
        if (!isEvent(ev, "subgraph.started") || ev.seq <= sinceSeq) continue;
        if (seen.has(ev.payload.childRunId)) continue;
        seen.add(ev.payload.childRunId);
        children.push({ at: ev.seq, runId: ev.payload.childRunId, ref: ev.payload.ref });
      }
    }

    if (plan.steps.length === 0 && children.length === 0) return [];

    // ONE suppression-aware pass for every result the rollback needs, not one per step. This is
    // the same `last live wins` scan `#invokeTool` serves on, and it has to be: an undo built
    // from a result a rewind threw away would restore the state the operator rejected.
    const wanted = new Set(attemptable(plan).map((s) => s.compensates));
    const recorded =
      wanted.size === 0 ? new Map<string, unknown>() : await this.#completedEffects({ log }, (k) => wanted.has(k));

    // One descending walk over both — `plan.steps` is already reverse-seq and the children carry
    // the parent seq they sit at, so this is a merge rather than a re-sort of anything.
    const merged: { readonly at: number; readonly step?: CompensationStep; readonly child?: (typeof children)[number] }[] =
      [...plan.steps.map((step) => ({ at: step.seq, step })), ...children.map((child) => ({ at: child.at, child }))].sort(
        (a, b) => b.at - a.at,
      );

    // The reason a DETACHED run's own steps cannot be run, when the caller named none. Worded as
    // the refusal `rewind` raises for exactly this case, because they are the same fact and an
    // operator reading a plan and an operator reading a refusal must not have to work out that
    // the two match.
    const why =
      input.why ??
      `this engine holds no context for run ${runId}, so it cannot dispatch an undo in it — ` +
        `call \`attach(runId, graph)\` first, or the effect stands`;

    const out: RollbackWalkStep[] = [];
    for (const item of merged) {
      if (item.child !== undefined) {
        // WHEN THERE IS NO CONTEXT TO RESOLVE A CHILD FROM, THE CHILD'S REASON IS THIS RUN'S.
        // `#planRollbackChild`'s own message says the child's graph "cannot be rebuilt from
        // <ref>", which is true but sends the operator to attach the CHILD — and the fix for a
        // detached ancestor is to attach the ancestor. A reason that names the wrong run is
        // worse than a generic one, so the ancestor's travels down.
        out.push(...(await this.#planRollbackChild(resolveFrom, item.child, depth + 1, seen, resolveFrom === undefined ? why : undefined)));
        continue;
      }
      const step = item.step!;
      out.push({
        runId,
        step,
        ...(ctx === undefined ? { undispatchable: why } : { ctx, p }),
        ...(recorded.has(step.compensates) ? { result: recorded.get(step.compensates) } : {}),
      });
    }
    return out;
  }

  /**
   * One child run's share of the walk, planned in the CHILD's journal.
   *
   * DISPATCH IS THE HARD HALF, NOT PLANNING. Planning over the child's journal already yields
   * the right steps; running one is a tool call, and a tool call needs the graph — which is not
   * in the journal, only its hash. That is the same wall a detached `rewind` hits and answers
   * with `attach(runId, graph)`. Here there is a better answer than asking the operator: the
   * PARENT's compiled graph carries the frozen child spec at `subgraphs[ref]`, which is the
   * same value `#startSubgraph` compiled the child from in the first place, so the context can
   * be rebuilt from what this engine already holds — across a restart included, since the
   * parent's graph is what `attach` handed back.
   *
   * AND WHERE IT CANNOT BE, THE STEPS ARE CARRIED FORWARD `undispatchable` RATHER THAN DROPPED,
   * so `#dispatchRollback` journals `not_attempted` in the CHILD's journal and `planRewind` shows
   * the same three states to the operator BEFORE anything runs. Three states, not two, is the
   * rule this feature lives on, and "nobody even tried" is the fact a two-state design deletes.
   * The child's log is the right one to say it in: it is the journal an operator reads to find
   * out what happened to that run, and the parent's is deliberately not a copy of its tree.
   * `#logFor` writes without a context for exactly this.
   *
   * `sinceSeq` IS 0 FOR A CHILD, and that is `#uncompensatedIrreversible`'s rule verbatim: the
   * child ran entirely inside the window the parent is suppressing, so there is no boundary to
   * carry down. The two answering differently about the same journal is the defect neither of
   * them should be able to have.
   */
  async #planRollbackChild(
    parent: RunContext | undefined,
    child: { readonly runId: RunId; readonly ref: string },
    depth: number,
    seen: Set<RunId>,
    /** The ancestor's reason, when there was no context to resolve this child's ref from. */
    inherited?: string,
  ): Promise<readonly RollbackWalkStep[]> {
    // A reference written before `submit` — see `#startSubgraph`, where the order is deliberate.
    // No journal means the child never started, so it did nothing that needs undoing.
    const p = await this.projection(child.runId);
    if (p === undefined) return [];

    const ctx = parent === undefined ? undefined : this.#childContextFor(parent, child.runId, child.ref);
    if (ctx !== undefined) {
      return this.#planRollback({ runId: child.runId, log: ctx.log, ctx, p, depth, seen });
    }

    // EVERY step, not only the attemptable ones — `#dispatchRollback` journals all of them, which
    // is what keeps the three states three on this path as well as on the dispatching one.
    //
    // AND IT DESCENDS ANYWAY, with `resolveFrom: parent` rather than stopping here. Returning
    // after the child's own steps left a GRANDCHILD's effects standing with nothing in any
    // journal saying so — the exact silence this method claims to have closed, closed one level
    // deep only. Not being able to dispatch in the CHILD says nothing about the grandchild: it
    // has its own journal, and its ref is looked up in the PARENT's compiled graph either way, so
    // it may still be rebuildable. Measured before this, on a two-level fixture with the child's
    // context forced absent: the grandchild's `db.insert` stood and no `compensation.recorded`
    // existed anywhere for it. That is why `resolveFrom` outlives `ctx`.
    return this.#planRollback({
      runId: child.runId,
      log: this.#logFor(child.runId),
      p,
      depth,
      seen,
      ...(parent === undefined ? {} : { resolveFrom: parent }),
      why:
        inherited ??
        `the graph for child run ${child.runId} cannot be rebuilt from "${child.ref}", so this engine ` +
          `cannot dispatch an undo in it — attach it and rewind, or the effect stands`,
    });
  }

  /**
   * PERFORM THE WALK. The only thing in this neighbourhood that acts.
   *
   * ONE WRITER PER OUTCOME, and one loop rather than two: a step this engine can dispatch runs
   * through `#invokeTool` and is recorded in its own run's log; a step it cannot is recorded
   * `not_attempted` in that same log with the reason the planner attached. Those used to be two
   * loops in two methods and the shapes drifted — `#compensateChild` wrote a `retryable` row and
   * `#compensate` did not, and a caller reading for one kind of silence found the other.
   *
   * `retryable: true` FOR AN UNDISPATCHABLE STEP — the row is a fact about THIS PROCESS, not
   * about the step. The reason string tells the operator to attach and rewind, and
   * `planCompensation` settles the seq either way, so following that advice would otherwise
   * produce a zero-step plan and an effect that still stood.
   *
   * SEQUENTIAL, never `Promise.all`. The order is the feature — see `run/compensation.ts` — and a
   * rollback fired concurrently has no order at all. It appends its record per step rather than
   * in one batch at the end, so a process that dies halfway leaves the steps it finished settled:
   * the resumed rollback re-plans from the journal and skips them.
   */
  async #dispatchRollback(
    walk: readonly RollbackWalkStep[],
    trigger: "run_failed" | "rewind",
  ): Promise<{ readonly compensated: number; readonly failed: number; readonly notAttempted: number }> {
    const tally = { compensated: 0, failed: 0, notAttempted: 0 };
    // One writer per journal, so a run with several steps does not build a `RunLog` per append.
    const logs = new Map<RunId, RunLog>();
    const logFor = (runId: RunId, ctx?: RunContext): RunLog => {
      if (ctx !== undefined) return ctx.log;
      const held = logs.get(runId);
      if (held !== undefined) return held;
      const fresh = this.#logFor(runId);
      logs.set(runId, fresh);
      return fresh;
    };

    for (const item of walk) {
      const outcome =
        item.ctx === undefined || item.p === undefined
          ? // The `??` is a type obligation, not a live branch: `#planRollbackChild` is the only
            // producer of a context-less step and it always attaches a reason. A `not_attempted`
            // row with no reason would collapse the three states back to two for whoever reads
            // it, so the fallback says something true rather than leaving the field off.
            ({ outcome: "not_attempted", reason: item.undispatchable ?? "this engine cannot dispatch an undo in this run", retryable: true } as const)
          : await this.#compensateOne(item.ctx, item.p, item.step, item.result);
      if (outcome.outcome === "compensated") tally.compensated++;
      else if (outcome.outcome === "failed") tally.failed++;
      else tally.notAttempted++;
      const log = logFor(item.runId, item.ctx);
      await this.#serialize(() => log.append([compensationRecord(item.step, outcome, trigger)]));
    }
    return tally;
  }

  /**
   * The child's `RunContext`, from what this engine already holds, or `undefined`.
   *
   * `#runs` first, because a live child context carries the policy engine that has been
   * tightening all run and the abort signal the undo should honour. Rebuilding beside it would
   * hand the rollback a fresh `PolicyEngine` at the deployment floor, which is the loosening
   * direction — an escalation the child made would be gone.
   *
   * FAILS CLOSED. `#compileChild` can throw on a spec a newer binary no longer accepts, and a
   * throw here would abort the whole rollback — including the parent steps that were about to
   * run and the `not_attempted` rows the caller writes instead. So the answer is "no context",
   * which is a fact the caller journals, rather than an exception nobody records.
   */
  #childContextFor(parent: RunContext, childRunId: RunId, ref: string): RunContext | undefined {
    const live = this.#runs.get(childRunId);
    if (live !== undefined) return live;
    const spec = parent.graph.subgraphs?.[ref];
    if (spec === undefined) return undefined;
    try {
      return this.#contextFor(childRunId, this.#compileChild(ref, spec, parent.graph), undefined, parent.grantBound);
    } catch {
      return undefined;
    }
  }

  /**
   * One step, decided and performed. Split out so the record-append above has ONE writer.
   *
   * Every arm that returns without dispatching returns a REASON. The three states this feature
   * lives or dies on are only three if `not_attempted` says why it was not attempted — "no
   * compensation is declared" and "the tool that would undo it is gone from the registry" are
   * different problems for whoever reads the run, and collapsing them loses the one that is
   * fixable.
   */
  async #compensateOne(
    ctx: RunContext,
    p: RunProjection,
    step: CompensationStep,
    result: unknown,
  ): Promise<{ readonly outcome: "compensated" | "failed" | "not_attempted"; readonly reason?: string }> {
    if (step.undo === undefined) return { outcome: "not_attempted", reason: BLOCK_REASON[step.blocked ?? "no_compensation"](step) };

    const task = step.taskId === undefined ? undefined : p.tasks[step.taskId];
    if (task === undefined) {
      return {
        outcome: "not_attempted",
        reason: `the task that called "${step.tool}" is not in the projection, so the undo has no task to run under`,
      };
    }
    const undo = this.tools.get(step.undo);
    if (undo === undefined) {
      // Re-checked here and not merely in the planner: the registry is mutable and the plan was
      // built before the first step ran. Fail closed rather than `require`, which throws.
      return { outcome: "not_attempted", reason: `compensation tool "${step.undo}" is not registered` };
    }

    if (result === undefined) {
      return {
        outcome: "not_attempted",
        reason: `no live \`effect.completed\` is recorded for ${step.compensates}, so the undo record ("details") does not exist`,
      };
    }
    const args = detailsOf(result);

    // `step.seq` AS THE ORDINAL, which is what makes the key derived rather than merely stable.
    // The seq of the `tool.called` being undone is unique per append and recomputable from the
    // journal alone, so a replay and a resumed rollback both land on the same key — and a
    // rewind-then-redo produces a NEW seq, so its fresh write gets its own undo rather than
    // being served the old one's.
    const out = await this.#invokeTool(ctx, p, task, undo, args, step.seq, false, "compensate");
    if (out.isError === true) {
      return { outcome: "failed", reason: `"${step.undo}" did not undo "${step.tool}": ${out.content}` };
    }
    return { outcome: "compensated" };
  }

  /**
   * Re-derive everything `#recordEvidence` accumulates, from the journal.
   *
   * PAIRED WITH `#recordEvidence` BY NAME, because the hole this closes is structural rather
   * than local. That method is the only place a run's escalation evidence is updated, it holds
   * all of it on `RunContext`, and `#contextFor` builds a fresh context per attach — so every
   * field it touches needs an arm here or a restart silently switches its rule off. Taint had
   * one and E4's streak did not: reproduced as two failures, a restart, a third failure, and no
   * `repeated_failure` — the same graph escalates without the restart. That is invariant 2's
   * fifth instance, after escalations, ceilings, spend and taint. **A counter added to
   * `#recordEvidence` and not to this method has exactly the same hole.**
   *
   * ONE PASS in seq order, replaying the functions the live path calls, and appending nothing:
   * `record` and `applyTaint` are both pure folds, so restoring cannot re-fire the escalations
   * being replayed. The posture those already earned comes back through `PolicyEngine.restore`
   * above. Sound for taint because it is monotonic and never cleared; sound for the streak
   * because `record` depends only on the outcome sequence, which the journal carries in order.
   * A node missing from the index — the graph was mutated out from under a committed task — is
   * skipped for taint rather than guessed at.
   *
   * THE OUTCOME SEQUENCE IS TWO EVENT TYPES, NOT ONE, and folding commits alone under-counts
   * precisely the case E4 exists for. `#recordEvidence` runs once per OUTCOME, ahead of both
   * the retry exit and the mutation exit, so a failure that was RETRIED already counted toward
   * the streak while appending `task.retry_scheduled` and no `task.committed`. A node failing
   * over and over is mostly retries.
   *
   * ONE KNOWN DIVERGENCE, and it is the fail-safe one. A task that SUCCEEDED while proposing a
   * mutation the compiler then rejected reaches `#recordEvidence` with `status: "succeeded"`,
   * which RESETS the streak, and journals `task.committed{status:"failed"}`, which this fold
   * COUNTS. So a restart can make E4 fire earlier than the original process would have, never
   * later and never not at all. Escalating sooner is permitted; the bug above was escalating
   * never.
   */
  async #restoreEvidence(ctx: RunContext): Promise<void> {
    for await (const ev of this.#store.read(ctx.runId, 1 as Seq)) {
      if (ev.taskId === undefined) continue;
      if (isEvent(ev, "task.retry_scheduled")) {
        ctx.streaks.record(parseTaskId(ev.taskId).nodeId, false);
        continue;
      }
      if (!isEvent(ev, "task.committed")) continue;
      const nodeId = parseTaskId(ev.taskId).nodeId;
      ctx.streaks.record(nodeId, ev.payload.status !== "failed");
      const node = ctx.index.byId.get(nodeId);
      if (node === undefined) continue;
      // AN EXTERNALISED CHANNEL IS STILL A WRITE, and this fold is the only place that could
      // forget it. Payload externalisation moves a large value out of `writes` and leaves a
      // `PayloadRef` under the same channel name in `external` — so a fold reading `writes`
      // alone sees a node that wrote nothing, and the taint and secret-carry sets come back
      // from a restart SHORT. Reproduced by this lane's reviewer: an irreversible tool ran
      // under a human de-escalation with no gate and no escalation, because the channel that
      // should have been tainted was the one that had been externalised.
      //
      // The live path (`#recordEvidence`) is not affected and must not be "fixed" to match: it
      // folds `outcome.writes` BEFORE the journal write externalises anything, so it already
      // sees every channel. This is a restart-only gap, which is the class
      // `test/run/oversight-survives-restart.test.ts` exists to name.
      //
      // Both folds read `Object.keys` and never a value, so a `PayloadRef` standing in for the
      // bytes is exact rather than an approximation — the channel NAME is the whole input.
      const written =
        ev.payload.external === undefined ? ev.payload.writes : { ...ev.payload.writes, ...ev.payload.external };
      applyTaint(ctx.tainted, node, written);
      applySecretFlow(ctx.carriesSecret, node, written, ctx.graph.spec.channels);
    }
  }

  /**
   * The hooks a graph declared at one point, in declaration order.
   *
   * Empty when the deployment registered no `HookRegistry` — hooks are optional, and a graph
   * that names one an installation does not have is not a broken graph. The compiler already
   * refused an unknown POINT, which is the mistake that would otherwise be silent.
   */
  #hooksFor(ctx: RunContext, point: HookPoint): readonly RegisteredHook[] {
    if (this.#hooks === undefined) return [];
    const refs = ctx.graph.spec.hooks?.[point];
    return refs === undefined || refs.length === 0 ? [] : this.#hooks.resolve(refs);
  }

  /**
   * Let `onError` hooks NARROW a retry the policy allowed: suppress it, or lengthen its backoff.
   *
   * Returns `undefined` when a hook suppressed it, which is the same answer `#retryDecision`
   * gives for "no retry" — so the caller has one shape to handle and cannot forget the hook path.
   */
  async #narrowRetry(
    ctx: RunContext,
    w: Wave,
    policyRetry: { afterMs: number; code: string; deferred?: boolean },
  ): Promise<{ retry?: { afterMs: number; code: string; deferred?: boolean }; changedBy: readonly string[] }> {
    const hooks = this.#hooksFor(ctx, "onError");
    if (hooks.length === 0) return { retry: policyRetry, changedBy: [] };
    const out = await runFilters<ErrorDecision>(
      hooks,
      { retry: true, afterMs: policyRetry.afterMs },
      { point: "onError", runId: ctx.runId, taskId: w.task.taskId, signal: ctx.abort.signal },
      (v) => v.retry === false,
      narrowErrorDecision,
    );
    if (out.value.retry === false) return { changedBy: out.changedBy };
    // A HOOK MAY LENGTHEN A DEFERRAL BUT NOT RECLASSIFY IT. `deferred` is carried through
    // untouched: whether an attempt was charged is the engine's answer about what happened,
    // not a knob, and a hook that could clear the flag could hand a node an unlimited budget.
    return {
      retry: {
        afterMs: Math.max(policyRetry.afterMs, out.value.afterMs ?? 0),
        code: policyRetry.code,
        ...(policyRetry.deferred === true ? { deferred: true } : {}),
      },
      changedBy: out.changedBy,
    };
  }

  /**
   * `preNode`: let a hook skip this node and supply its answer, or return `undefined` to run it.
   *
   * TWO CONTAINMENTS, and both need the node, which is why they are here rather than in the
   * merge. A `human_gate` may NEVER be skipped — skipping the node whose entire job is to be a
   * human decision is the gate bypass reached from a new direction, and it is refused before the
   * decision is even read. And `overrideWrites` is confined to the channels the node DECLARED it
   * writes: a hook cannot write a channel the node was never going to touch, which is route
   * confinement's rule applied to state instead of edges.
   */
  async #preNode(ctx: RunContext, w: Wave): Promise<NodeOutcome | undefined> {
    const hooks = this.#hooksFor(ctx, "preNode");
    if (hooks.length === 0) return undefined;
    // Refused before the hooks run, not after: there is no decision a `human_gate` could return
    // that would be safe to honour, so asking is the wrong shape.
    if (w.node.type === "human_gate") return undefined;

    const out = await runFilters<NodeDecision>(
      hooks,
      {},
      { point: "preNode", runId: ctx.runId, taskId: w.task.taskId, signal: ctx.abort.signal },
      (v) => v.skip === true,
      narrowNodeDecision,
    );
    await this.#journalHooks(ctx, w.task, "preNode", out.changedBy);
    if (out.value.skip !== true) return undefined;

    const declared = new Set(w.node.writes ?? []);
    const writes: Record<string, unknown> = {};
    for (const [channel, value] of Object.entries(out.value.overrideWrites ?? {})) {
      if (declared.has(channel)) writes[channel] = value;
    }
    return { status: "succeeded", writes, usage: { ...ZERO_USAGE } };
  }

  /**
   * Run a value-threading filter point and journal whatever changed.
   *
   * The default merge REPLACES, which is what a value point wants: `preModel` hands back a
   * request, `postTool` a result. A DECISION point supplies its own merge instead — see
   * `narrowToolDecision`, which is what makes "once blocked, stays blocked" true regardless of
   * hook order. Returns the input untouched when no hook is registered, so a deployment with no
   * extensions runs exactly as it did before the bus existed.
   */
  async #filterHook<T>(ctx: RunContext, task: TaskRecord, point: HookPoint, value: T): Promise<T> {
    const hooks = this.#hooksFor(ctx, point);
    if (hooks.length === 0) return value;
    const out = await runFilters<T>(hooks, value, {
      point,
      runId: ctx.runId,
      taskId: task.taskId,
      signal: ctx.abort.signal,
    });
    await this.#journalHooks(ctx, task, point, out.changedBy);
    return out.value;
  }

  /**
   * Append one `hook.applied` per hook that CHANGED the value.
   *
   * Not one per invocation: a no-op filter on a hot path would flood the journal, and
   * invariant 8's rule is that telemetry may drop while the journal may not — so the journal
   * carries the decisions, not the traffic. `hook.applied` has been in `EVENT_TYPES` with no
   * appender since the vocabulary was written; this is it.
   */
  async #journalHooks(ctx: RunContext, task: TaskRecord, point: HookPoint, changedBy: readonly string[]): Promise<void> {
    if (changedBy.length === 0) return;
    await this.#serialize(() =>
      ctx.log.append(
        changedBy.map((ref) => ({
          type: "hook.applied" as const,
          payload: { ref, point, changed: true },
          actor: SYSTEM_ACTOR("executor"),
          taskId: task.taskId,
        })),
        { taskId: task.taskId },
      ),
    );
  }

  get replaying(): boolean {
    return this.#replay !== undefined;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async submit(input: SubmitInput): Promise<RunId> {
    const runId = input.runId ?? newRunId(this.#now());
    // THE GRAPH'S OWN BUDGET IS A CEILING, NOT A COMMENT. `spec.policy.budget.costUsd` was read
    // by `graph/validate.ts` alone — a compile-time FEASIBILITY check that the declared per-node
    // budgets fit inside it — and by nothing at run time. So a graph could declare
    // `budget.costUsd: 0.000001`, compile clean, and spend without limit: measured alongside the
    // unbounded-loop defect, a run with that exact declaration spent ~$0.11 of mock cost and
    // never stopped.
    //
    // A GRAPH MAY ONLY LOWER, NEVER RAISE, and getting that backwards is the first thing this
    // change did. The deployment's own `policy.budget.runUsd` is a ceiling an operator set; a
    // graph is a document the deployment ran, so letting its declaration REPLACE that ceiling
    // would let any graph vote itself more money. Three sources, and the smallest present one
    // wins: the deployment's cap, the caller's allotment (a subgraph carving a slice from its
    // parent), and the graph's own declaration.
    const budgetUsd = minDefined(
      input.budgetUsd,
      input.graph.spec.policy?.budget?.costUsd,
      // Included so `min` cannot silently raise the deployment's ceiling when the other two are
      // larger — `#contextFor` overwrites `runUsd` with whatever it is handed.
      this.#policyOpts.budget?.runUsd,
    );
    // AND THE OTHER TWO THIRDS OF THE SAME DECLARATION. `graph/spec.ts` lists
    // `["costUsd", "tokens", "wallMs"]`, and until now the loop above ran for the first
    // alone: `budget: {tokens: 200000}` compiled clean and bound nothing, which is the same
    // silence the comment above condemns one paragraph earlier for dollars.
    //
    // Same fold, deliberately, rather than a second shape: three sources and the SMALLEST
    // present one wins, so a graph may lower an operator's ceiling and never raise it. There
    // is no `input.budgetTokens`/`input.budgetWallMs` sibling for `budgetUsd` because the one
    // caller that passes it is `#runSubgraph`, carving a DOLLAR slice for a child — a run
    // ceiling in the other two dimensions is not sliced, and a child therefore inherits its
    // parent's tokens and time only through `subgraph.completed`, which folds the child's whole
    // usage into the parent AFTER it finishes. Stated because it is a real gap, not a design.
    const budgetTokens = minDefined(input.graph.spec.policy?.budget?.tokens, this.#policyOpts.budget?.runTokens);
    const budgetWallMs = minDefined(input.graph.spec.policy?.budget?.wallMs, this.#policyOpts.budget?.runWallMs);
    const ctx = this.#contextFor(runId, input.graph, {
      ...(budgetUsd === undefined ? {} : { runUsd: budgetUsd }),
      ...(budgetTokens === undefined ? {} : { runTokens: budgetTokens }),
      ...(budgetWallMs === undefined ? {} : { runWallMs: budgetWallMs }),
    });

    // THE LAST INLINE COPY OF A PAYLOAD, and the reason it was left behind was recorded as
    // "externalising it needs a store the SUBMIT path can reach, which `submit` does not have
    // today". Measured: that is false on both readings. ACCESS — `this.#payloads` is an engine
    // field, in scope here as it is in `#commit`. ORDER — `#externalise` needs a runId and a
    // compiled graph and nothing else; `store.put` is content-addressed, so there is no "point
    // at something a node produced" for inputs to be too early for. `ctx` is built above and
    // carries both. The real obligation was never the store: it was that `run.submitted` is
    // the event a REPLAY re-submits from, which is why `run.submitted.external` is declared in
    // `journal/events.ts` and resolved in `run/replay.ts` rather than fetched by the fold.
    //
    // Measured on the same three-node chain moving one 300 KB document that
    // `payload-externalisation.test.ts` uses: the externalised journal was 304,556 bytes, of
    // which seq 1 alone was 300,261 — the whole of the residual. It is now 4,556.
    const seeded = await this.#externalise(ctx, input.inputs);

    // Durable at ACK: run.submitted + the compiled graph + the manifest. NOT any
    // execution — a 202 means "this WILL run", never "this HAS run".
    await ctx.log.append([
      {
        type: "run.submitted",
        payload: {
          workflow: input.workflow ?? input.graph.spec.metadata.name,
          graphHash: input.graph.graphHash,
          inputs: seeded.values,
          ...(seeded.external === undefined ? {} : { external: seeded.external }),
          idempotencyKey: input.idempotencyKey ?? runId,
          configDigest: digest(this.#policyOpts),
          ...(input.submittedBy === undefined ? {} : { submittedBy: input.submittedBy }),
        },
        // The control plane IS what appended this row, so the envelope stays true and the
        // principal rides in the payload. See `SubmittedBy`.
        actor: SYSTEM_ACTOR("control-plane"),
      },
      {
        type: "run.compiled",
        payload: {
          graphHash: input.graph.graphHash,
          nodes: input.graph.spec.nodes.length,
          edges: input.graph.spec.edges.length,
          resolutionManifest: input.graph.resolutionManifest.map((r) => ({ ref: r.ref, digest: r.digest })),
        },
        actor: SYSTEM_ACTOR("compiler"),
      },
      {
        type: "run.started",
        payload: { posture: this.#runPosture(input.graph) },
        actor: SYSTEM_ACTOR("scheduler"),
      },
      ...input.graph.entryNodes.map(
        (nodeId): NewEvent => ({
          type: "task.ready",
          payload: { nodeId, branchPath: encodeBranch(ROOT_BRANCH), edgesIn: [] },
          actor: SYSTEM_ACTOR("scheduler"),
          taskId: makeTaskId(nodeId, ROOT_BRANCH, 0),
        }),
      ),
    ]);

    return runId;
  }

  /**
   * Drive a run until it suspends, completes, or has no runnable Task.
   *
   * Returns rather than blocking on a gate: a suspended run holds no worker slot, so
   * "advance" ending with `awaiting_gate` is a normal, cheap outcome.
   */
  async #advanceSerially(runId: RunId): Promise<RunProjection> {
    const ctx = this.#runs.get(runId);
    if (ctx === undefined) {
      // A RETIRED RUN IS NOT AN UNKNOWN RUN, and the journal is what tells them apart.
      //
      // Terminal runs are evicted from `#runs` (see `#retire`), so a caller that polls
      // `advance` until it sees `succeeded` would otherwise get `E_RUN_NOT_FOUND` on the
      // call after the one that finished — the eviction turning a completed run into a
      // missing one. Folding the log answers it without a second in-memory registry:
      // invariant 2 says the journal is authoritative, so "did this run finish?" is a
      // question the log can always answer, with or without a live context.
      const folded = await this.projection(runId);
      if (folded !== undefined && isTerminal(folded.status)) return folded;
      throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} is not attached to this engine`);
    }
    // BOUND BEFORE ANYTHING RUNS, and after the terminal fallback above so polling a finished
    // run still answers rather than 404ing.
    //
    // `advance` is a door onto execution in its own right and it was unguarded: `POST
    // /runs/:id/commands {"kind":"advance"}` reaches it — the code's own 202 message tells an
    // operator to use it to retry — as do a crash leaving a run non-terminal and `GateSweeper`
    // closing a gate by `defaultAction`, which appends `gate.decided` and defers execution to
    // exactly here. Guarding the gate doors and leaving this one open guards the room and not
    // the house.
    //
    // BEFORE `#rehydrateGraph`, deliberately: rehydration REPLACES `ctx.graph` with the journal's
    // successor, so checking after it would be checking the engine's own work rather than what
    // the caller attached.
    await this.#assertBound(ctx, `advancing run ${runId}`, { requireRecord: false });
    await this.#rehydrateGraph(ctx);

    for (;;) {
      const p = await this.#project(ctx);
      if (p === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} has no journal`);

      // RE-SEED OVERSIGHT AND SPEND FROM THE JOURNAL, once per attach.
      //
      // `PolicyEngine` held escalations, human ceilings and spend in memory only, and
      // `#contextFor` builds a fresh one — so a restart handed the run back its full
      // budget at a posture lowered with no human `deescalate`, which is invariant 5
      // broken by the recovery path. `attach` is synchronous and public, so the seeding
      // happens on the first path that holds a projection instead. `restore` only raises
      // a posture and only adds spend, so arriving here twice cannot loosen anything.
      if (!ctx.policySeeded) {
        ctx.policySeeded = true;
        // ALL THREE DIMENSIONS FROM ONE `UsageRecord`. `p.usage` is the fold `chargeUsage`
        // builds out of the effect records, so tokens and provider time are reconstructible
        // across a restart for exactly the reason dollars are — no new durable state, no new
        // event. Restoring dollars alone would have handed a resumed run its full TOKEN budget
        // back, which is this same invariant broken in a new dimension.
        ctx.policy.restore({
          escalations: p.escalations,
          ceilings: p.ceilings,
          spentUsd: p.usage.costUsd,
          spentTokens: p.usage.inputTokens + p.usage.outputTokens,
          spentWallMs: p.usage.wallMs,
        });
        // AND THE EVIDENCE `#recordEvidence` HOLDS — the taint set and E4's failure streak.
        // Both lived only on `RunContext`, so a crash, a deploy or a `loom serve` restart
        // deleted them: E8 between the tainting write and the hard-to-undo action — measured,
        // on two Engines over one journal with identical human decisions, the charge ran — and
        // E4 between the second consecutive failure and the third, measured the same way, the
        // escalation that fires without a restart firing not at all with one.
        //
        // The durable `policy.escalated` rows cannot stand in for either. `{rule:"taint"}`
        // enters the FLOOR, where `CLASS_DEFAULT_POSTURE` already pins both hard classes at
        // `in`, and the ceiling clamp is applied after — so restoring the event changes no
        // answer. `{rule:"repeated_failure"}` is only written once the streak has ALREADY
        // breached, so it says nothing about a run sitting at two. Only the sets and the
        // counter do, which is exactly what invariant 2 means by "rebuildable by folding".
        await this.#restoreEvidence(ctx);
      }
      // NOT RETIRED HERE, and the attempt is recorded because it looks obviously right.
      //
      // Evicting a terminal run's context on the call that finishes it fixes the leak
      // `forget` exists for, and breaks two public operations that legitimately act on
      // terminal runs: `openGates` renders a payload the projection does not carry, and
      // `rewind` forks from a completed run. Both read `#runs` and both raise
      // `E_RUN_NOT_FOUND` without it — measured, as three suite failures.
      //
      // Giving each of them the journal fallback `#advanceSerially` now has is the real
      // fix and is its own change: `openGates` in particular would have to rebuild a
      // rendered payload from the log rather than read it from the broker. Until then
      // retirement is the caller's call, which is why `forget` is public.
      // `p.paused` IS READ HERE AND NOT `p.status`. An operator pause folds the status to
      // `interrupted`, which the next clause already stops on — but a `gate.decided` landing
      // afterwards carries an unconditional `run.resumed` and folds it back to `running`, and
      // then this loop would dispatch the wave the operator stopped. The pause is a separate
      // durable fact for exactly that reason; see `RunProjection.paused`.
      if (p.paused || isTerminal(p.status) || p.status === "awaiting_gate" || p.status === "interrupted") {
        // Only TERMINAL. `awaiting_gate` and `interrupted` are runs that will be driven
        // again, and their context holds the taint set, the leases and the expression cache
        // that driving them needs.
        if (isTerminal(p.status)) this.#retire(runId);
        return p;
      }

      // A run-fatal failure stops the run even if Tasks remain runnable. The budget
      // ladder in D6.5 (warn → degrade → gate → fail) lives in policy; this is its
      // floor, shared with replay divergence.
      const fatal = Object.values(p.tasks).some((t) => t.state === "failed" && RUN_FATAL_CODES.has(t.error?.code ?? ""));
      if (p.budgetExhausted || fatal) {
        await this.#finish(ctx, p);
        return (await this.#project(ctx))!;
      }

      const ready = tasksInState(p, "ready").filter(
        (t) => t.retryAfter === undefined || t.retryAfter <= this.#now(),
      );
      if (ready.length === 0) {
        // A Task still in backoff is not "nothing left to do" — finishing here would
        // complete a run that has work pending. Return instead, so the caller can
        // advance again once the clock has moved.
        const backingOff = tasksInState(p, "ready").some((t) => (t.retryAfter ?? 0) > this.#now());
        if (backingOff) return p;

        // NEITHER IS A TASK WAITING ON A HUMAN. `gate.decided` carries an unconditional
        // `run.resumed`, so answering one of several open gates puts the whole run back to
        // `running`; the work behind that answer then ran, drained, and arrived here with
        // another gate still open. Finishing would report a terminal run while a human was
        // still being asked — and leave their queue holding a gate for a run that had
        // already ended, with the action behind it never taken. Re-suspending says what is
        // true, and the next decision resumes it again.
        if (openGates(p).length > 0) {
          await this.#serialize(() =>
            ctx.log.append([{ type: "run.suspended", payload: { reason: "gate" }, actor: SYSTEM_ACTOR("scheduler") }]),
          );
          return (await this.#project(ctx))!;
        }

        await this.#finish(ctx, p);
        const done = await this.#project(ctx);
        return done!;
      }

      // WHICH Tasks to run is the scheduler's question; HOW they run is not, and never
      // varies between deployments. Swapping in a partitioned scheduler is a constructor
      // argument, which is the whole content of "changes implementations, never call
      // sites" for this component.
      const wave = this.#scheduler.select({
        projection: p,
        graph: ctx.graph,
        nodes: ctx.index.byId,
        maxParallelism: this.#maxParallelism,
        now: this.#now(),
        workerId: this.#workerId,
      });

      // AN EMPTY WAVE OVER A NON-EMPTY READY SET IS NOT AN ERROR — it is a peer holding
      // the leases. `LeasedScheduler` returns exactly that, legitimately, whenever
      // another worker got there first. Looping would spin in pure microtasks and starve
      // the event loop with a perfectly valid integer, so hand control back and let the
      // caller advance again when the world has moved.
      const selected = [...wave];
      if (selected.length === 0) return p;

      await this.#runWave(ctx, selected);
      // A posture that tightened during the wave must be on disk before the next
      // projection is read as authoritative — and if the append failed, the caller of
      // `advance` is who should hear about it.
      const escalations = ctx.escalationWrites.splice(0);
      if (escalations.length > 0) await Promise.all(escalations);
    }
  }

  /**
   * Drive a run forward. Serialized per run.
   *
   * `#serialize` orders journal APPENDS; it is not an execution lock, so two concurrent
   * `advance` calls — both reachable from shipped HTTP routes — projected the same state,
   * saw the same ready Tasks and dispatched every one of them twice, paid model calls and
   * irreversible tools included. Nothing raised `E_SEQ_CONFLICT`, because both were
   * appending legal events in a legal order; they were simply doing the work twice.
   *
   * Callers are chained rather than coalesced: a second caller wants the run advanced
   * from where it is *after* the first finishes, not the first's answer.
   */
  async advance(runId: RunId): Promise<RunProjection> {
    const prev = this.#advancing.get(runId);
    const run = (async () => {
      if (prev !== undefined) await prev;
      return this.#advanceSerially(runId);
    })();

    // Store a never-rejecting handle: a predecessor that threw must not reject its
    // successor, and an unhandled rejection here would take the process down.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#advancing.set(runId, settled);
    // Self-evicting, so the map does not grow with every run the process ever saw.
    void settled.then(() => {
      if (this.#advancing.get(runId) === settled) this.#advancing.delete(runId);
    });
    return run;
  }

  /**
   * Lower a posture for this run. Human only, journaled, and clamped.
   *
   * A separate method from anything that tightens, on purpose: the signature alone
   * rejects an agent, the deny-list rejects the evolution engine, and the ceiling it
   * sets can never take a hard-to-undo action below `on` — someone stays watching. It
   * does not cover one that untrusted tool output is feeding: E8 holds that at `in`, so
   * lowering the ceiling is a judgement about what was visible when it was made. That holds
   * across a restart, a laundering hop, a `tool.args` template and a subgraph boundary; it
   * does NOT cover a `router` choosing a branch from tainted data, which is control-flow
   * taint and a different question.
   */
  async deescalate(
    runId: RunId,
    scope: string,
    to: Posture,
    justification: string,
    actor: PolicyActor,
    /**
     * WHICH DOOR THE HUMAN CAME THROUGH, and it used to be the constant `"api"`.
     *
     * `via` is a durable field on the actor envelope and `HumanActor["via"]` is a closed
     * vocabulary; writing `"api"` for every caller was true while the only caller was an
     * embedder and became a FALSE durable fact the moment `loom deescalate` existed — an
     * audit reading the journal back would say a de-escalation arrived over the network when
     * it was typed at the host's shell, which is the more serious of the two. Defaulted
     * rather than required so an embedder already calling this is unchanged.
     */
    via: HumanActor["via"] = "api",
  ): Promise<RunProjection> {
    const ctx = this.#require(runId);
    const before = ctx.policy.ceilingFor(scope) ?? "in";
    ctx.policy.deescalate(scope, to, justification, actor);
    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "policy.deescalated",
          payload: { from: before, to, scope, justification },
          actor: { kind: "human", subject: actor.id, via },
        },
      ]),
    );
    return (await this.#project(ctx))!;
  }

  /**
   * Open gates WITH their rendered payload.
   *
   * The projection carries the durable half of a gate — who, which node, what state. The
   * payload is the half a human actually reads, and it lived only inside the broker with
   * no way out. A gate surfaced without what it is asking about is a gate that gets
   * approved on trust, which is the failure mode the whole oversight layer exists to
   * avoid; it matters most for a `subgraph` gate, where the real question is in another
   * run entirely.
   */
  async openGates(runId: RunId): Promise<readonly GateSummary[]> {
    // A run this engine holds no context for is not an unknown run: a gate is a ROW, and
    // `#logFor` is already the writer for exactly this case. Refusing here made `forget`
    // unsafe to call automatically — retiring a completed run turned "list its gates" into
    // E_RUN_NOT_FOUND — and it also meant a restarted process could not read a gate until
    // something re-`attach`ed the run, for a question that never needed the graph.
    return this.#gates.list(this.#runs.get(runId)?.log ?? this.#logFor(runId));
  }

  /**
   * THE PUBLIC DOOR TO A GATE, AND IT TAKES A HUMAN.
   *
   * It used to take any `Actor`. Three system components are on the broker's allow-list —
   * `replay`, `executor:subgraph`, `gate-broker:timeout` — because each carries authority
   * journaled somewhere else, and any in-process caller or any route added later could
   * present one of those three names and walk past every approvers list. The narrowing in
   * `isAuthorizedActor` was only ever as strong as every caller remembering to construct a
   * human actor, which is the same shape of assumption that produced the subgraph bypass:
   * a rule enforced by convention at each call site is not a rule.
   *
   * So the constraint is structural, in both directions. The parameter type refuses a
   * non-human at compile time, and the check below refuses one at run time for the caller
   * who casts. The single exception is `system:replay` on an engine that is IN replay mode
   * — replay re-serves a decision already in the original journal and writes only to a
   * shadow store, and the mode, not the name, is what entitles it. `executor:subgraph` is
   * reachable through `#resolveGateAsSystem` and from nowhere outside this class;
   * `gate-broker:timeout` never leaves the broker.
   */
  async resolveGate(
    runId: RunId,
    input: Omit<ResolveInput, "actor"> & {
      readonly actor: HumanActor | { readonly kind: "system"; readonly component: "replay" };
    },
  ): Promise<RunProjection> {
    if (input.actor.kind !== "human" && this.#replay === undefined) {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `gate "${input.gateId}" can only be answered by a human through this entry point`,
        { details: { gateId: input.gateId, actor: input.actor } },
      );
    }
    return this.#resolveGateAsSystem(runId, input);
  }

  /**
   * The open gate BATCHES of a run, each with the manifest one decision would close.
   *
   * The console's half of D7.9 row 2 reads from here: `GateBatch.members` carries every
   * member's own `payload` and `contentDigest`, which is what per-item diffs are rendered
   * from, and `manifestDigest` is what a caller must echo back to decide the batch. A
   * gate that is in no batch does not appear here at all — `openGates` is still the
   * complete list — so a console can show batches above singletons without a second
   * notion of what an open gate is.
   */
  async openGateBatches(runId: RunId): Promise<readonly GateBatch[]> {
    // Same rule as `openGates`, for the same reason: a batch is derived from rows.
    return this.#gates.listBatches(this.#runs.get(runId)?.log ?? this.#logFor(runId));
  }

  /**
   * THE PUBLIC DOOR TO A BATCH, AND IT TAKES A HUMAN — for the same reasons `resolveGate`
   * does, restated in no weaker a form because one call now closes N gates.
   *
   * There is no `#resolveGateBatchAsSystem`, and there should not be: the three system
   * components on the broker's allow-list each carry authority for ONE gate — a mirror
   * bound by `mirrorOf`, a `defaultAction` the compiler proved safe, a decision already in
   * a replayed journal — and none of them has any notion of a batch to be entitled to.
   * `replay` is not admitted either: a replayed run re-serves each recorded `gate.decided`
   * per gate, which is the same set of decisions arrived at one at a time.
   */
  async resolveGateBatch(
    runId: RunId,
    input: Omit<ResolveBatchInput, "actor"> & { readonly actor: HumanActor },
  ): Promise<RunProjection> {
    if (input.actor.kind !== "human") {
      throw err.policy(
        CODES.E_GATE_NOT_AUTHORIZED,
        `gate batch "${input.batchId}" can only be answered by a human`,
        { details: { batchId: input.batchId, actor: input.actor } },
      );
    }
    const ctx = this.#require(runId);
    // The higher-consequence sibling of `resolveGate`: it closes N gates at once and then
    // advances. Guarding one and not the other is the shape invariant 6 exists to prevent.
    await this.#assertBound(ctx, `deciding gate batch "${input.batchId}"`);
    await this.#gates.resolveBatch(ctx.log, input);
    return this.advance(runId);
  }

  /**
   * The same resolution, for the components inside this class whose authority is
   * journaled elsewhere. Private on purpose: it is the only way to present a system actor,
   * and there is exactly one caller — the subgraph forward, bound to a mirror gate.
   */
  async #resolveGateAsSystem(runId: RunId, input: ResolveInput): Promise<RunProjection> {
    const ctx = this.#require(runId);
    // EVERY DECISION BINDS, INCLUDING `reject`, and exempting it was a hole the size of the one
    // this method exists to close. The exemption's stated reason — "reject fails the run, so it
    // runs no graph code" — is false twice over: `#applyGateDecision` fails the TASK with
    // `E_HUMAN_APPROVAL_REQUIRED`, which is not in `RUN_FATAL_CODES`, so the run continues and
    // the failed task activates that node's `error` edges READ FROM THE ATTACHED GRAPH, and then
    // `advance` runs. Reproduced through the CLI: `--reject "no thanks" --graph EVIL.json`
    // wrote `PWNED.txt` and reported `succeeded`.
    //
    // The operator's exit is `cancel`, which genuinely runs no graph code and genuinely does not
    // bind. The reject exemption bought nothing `cancel` did not already provide.
    await this.#assertBound(ctx, `deciding gate "${input.gateId}"`);
    await this.#gates.resolve(ctx.log, input);
    return this.advance(runId);
  }

  async projection(runId: RunId): Promise<RunProjection | undefined> {
    const ctx = this.#runs.get(runId) ?? undefined;
    if (ctx !== undefined) return this.#project(ctx);
    const events = [];
    for await (const e of this.#store.read(runId, 1)) events.push(e);
    return foldRun(events);
  }

  /**
   * Release everything this engine holds in memory for a run.
   *
   * `#runs` was written and never deleted, so a `loom serve` accumulated one `RunContext`
   * per run it had ever seen for as long as the process lived — the taint set, the leases,
   * the tool-call index, the expression cache, and a reference to the compiled graph.
   * Measured at roughly 613 KB for a modest run, which is ~60 MB per thousand: not a leak
   * that shows up in a test suite, and exactly the kind that ends a long-lived deployment.
   *
   * Safe because nothing durable lives here. Every field is derived — invariant 2 —- so a
   * forgotten run is re-derivable by folding its journal, which is what `projection` already
   * does when it finds no context. A run that is still going needs its graph re-bound with
   * `attach` first; a terminal one needs nothing.
   *
   * Public because a caller that keeps a run alive on purpose (a long poll, a subscription)
   * needs a way to say it is done, and because `forget` on a run this engine never saw is a
   * no-op rather than an error — asking twice is not a mistake.
   */
  forget(runId: RunId): void {
    this.#retire(runId);
  }

  /**
   * Drop a run's in-memory context. See `forget` for why this is safe.
   *
   * `#childGraphs` is deliberately NOT touched: it is keyed by resource ref, not by run, and
   * is a compile cache shared across every run that names the same subgraph. Evicting it per
   * run would key a shared cache by the wrong thing and recompile for every caller.
   */
  #retire(runId: RunId): void {
    this.#runs.delete(runId);
  }

  /**
   * The `graphHash` this run COMPILED, so a fresh process can find the graph again.
   *
   * `RunGraph` is not journaled — its hash is — so re-attaching means "find the graph whose hash
   * this is". A caller holds the candidates (files in a workspace, the graphs a server was
   * given); this answers which one it is looking for. `undefined` means no compile on record.
   *
   * NOT `RunProjection.graphHash`, which folds `graph.mutated` to the SUCCESSOR hash: a caller
   * matching an authored on-disk graph against that would find nothing for every run that ever
   * mutated. `#rehydrateGraph` replays the mutations on top of the authored graph.
   *
   * Answering this is not permission to run anything. Whatever the caller attaches is still
   * checked against all three recorded facts before a decision may continue the run — see
   * `#assertBound`. This method exists so an honest caller can succeed, not so a dishonest one
   * can be trusted.
   */
  async compiledGraphHash(runId: RunId): Promise<string | undefined> {
    return (await this.#compiledIdentity(runId))?.graphHash;
  }

  /**
   * Bind a RunGraph to a run — after a restart, or before driving one this process did not submit.
   *
   * THE DURABLE HALF NEEDS NOTHING: the projection is a fold, open gates are rows, and incomplete
   * Tasks are re-leased because their state is `ready` or `leased` in the log. What this binds is
   * the `RunGraph`, which is not itself journaled (its hash is).
   *
   * TWO EPHEMERAL HALVES ARE NOT COVERED HERE, and this docstring used to say there were none —
   * "there is deliberately nothing to restore", which stopped being true and then, worse, stopped
   * being ATTACHED to this method at all: a later edit inserted `compiledGraphHash` between the
   * comment and the declaration, so JSDoc bound it to the wrong symbol and `attach` had none.
   *
   *   - The gate broker's non-durable half — route, SLA, reminders, escalation chain. Call
   *     `rehydrateGates` immediately after this, as all three re-attach doors do; an unrehydrated
   *     gate is expired by the sweep with a journaled reason that is false.
   *   - Oversight and spend, re-seeded from the journal by `#advanceSerially` on the first path
   *     that holds a projection — this method is synchronous and has none.
   */
  attach(runId: RunId, graph: RunGraph): void {
    this.#contextFor(runId, graph);
  }

  /**
   * Re-arm the SLA clock of every gate this run has open. Called after `attach`.
   *
   * A gate's non-durable half — its `DeliverySpec`, its reminder schedule, its escalation
   * chain, its pre-authorized default action — lives in the broker that raised it, and a fresh
   * process has none of it. `GateSweeperOptions.broker` already says what that costs: a sweep
   * holding no delivery spec makes `#fireTimeout` "conclude every escalation chain is exhausted
   * and EXPIRE gates that should have escalated. Silently, and fail-closed." So a `loom serve`
   * restart disarmed every reminder and every tier, and the gates it then expired carried the
   * journaled reason "exhausted its escalation chain with no decision" — which was FALSE.
   *
   * `HumanGateBroker.rehydrate` exists for exactly this and had ZERO callers — the fifth
   * capability this repo shipped with none, after `runSandboxed`, `McpClient`, `ResourceStore`
   * and `createFunctionLoader`. It had none because until a run could be re-attached from its
   * journaled graph hash there was no reliable way for a fresh process to HAVE the node, and
   * the node is where the schedule comes from: `scheduleOf` is a pure function of it.
   *
   * WHAT COMES BACK AND WHAT DOES NOT. The route, the clock, the reminders and the default
   * action are all node declarations, so they are exactly what they were. The rendered PAYLOAD
   * is not — it was built by the Task that raised the gate and is not journaled — so a
   * rehydrated gate shows an approver its content digest and no body. `#summaryOf` already
   * takes it as absent, because a process that did not raise the gate never had one.
   */
  async rehydrateGates(runId: RunId): Promise<number> {
    const ctx = this.#require(runId);
    const p = await this.#project(ctx);
    if (p === undefined) return 0;
    let armed = 0;
    for (const gate of openGates(p)) {
      const node = ctx.index.byId.get(gate.nodeId);
      if (node?.humanGate === undefined) continue;
      const sched = scheduleOf(node);
      this.#gates.rehydrate(gate.gateId, {
        runId,
        taskId: gate.taskId,
        nodeId: gate.nodeId,
        policyRef: gate.policyRef,
        // NOT RECOVERABLE, and absent rather than faked. What a human was shown was rendered by
        // a Task in another process; `contentDigest` on the record is what pins it.
        payload: undefined,
        ...(sched.slaMs === undefined ? {} : { slaMs: sched.slaMs }),
        ...(sched.onTimeout === undefined ? {} : { onTimeout: sched.onTimeout }),
        ...(sched.delivery === undefined ? {} : { delivery: sched.delivery }),
        ...(sched.reminders === undefined ? {} : { reminders: sched.reminders }),
      } as GateRequest);
      armed += 1;
    }
    return armed;
  }

  /**
   * Cancel a run AND EVERY RUN IT DELEGATED TO.
   *
   * Reports `clean: false` and lists `unknownEffects` when cancellation raced an
   * effect that started and never recorded an outcome. A framework that reports every
   * cancel as clean is lying to its operator.
   *
   * THE CASCADE IS THE POINT, and it is the same defect as the original resurrection one
   * level of delegation down. This method used to close this run's gates and have no notion
   * of a child run at all, so cancelling a parent that had delegated closed the parent's
   * MIRROR — a copy of the question, raised so a human can be asked in one place — and left
   * the CHILD `awaiting_gate` with the original still open in its own queue, carrying the
   * child's own approvers. Every authorization check on it passed; answering it executed
   * the delegated irreversible action the operator had just cancelled. Closing the copy and
   * leaving the original is worse than closing neither, because the parent's console then
   * shows nothing outstanding.
   *
   * Three properties, stated because they are what makes this more than a loop:
   *
   *   - **Transitive.** A child that itself delegated is reached, by recursion over each
   *     run's own `subgraph.started` — which is the only link between two journals.
   *   - **Idempotent.** A run that has already ended is left exactly as it is, before any
   *     append: cancelling a cancelled tree writes nothing, at any level.
   *   - **Ordered, which is the most atomicity two journals can offer.** There is no
   *     transaction across runs, so the guarantee is the ORDER: every descendant is ended
   *     before this run's own `run.cancelled` lands. "The parent is cancelled" is therefore
   *     evidence that everything below it is. A crash mid-cascade leaves the parent
   *     non-terminal with its `operator.command` on the record and some children already
   *     closed — a state that re-running `cancel` finishes, rather than a half-cancelled
   *     tree that looks finished.
   */
  async cancel(runId: RunId, reason = "operator", by: CommandActor = SYSTEM_ACTOR("operator")): Promise<RunProjection> {
    // NO ATTACHMENT REQUIRED, and this used to demand one. `#cancelTree` already says why it does
    // not need a graph — "it is a projection and two appends" — but `#require` sat in front of it
    // and refused any run this process had not bound.
    //
    // That made a stranded run inescapable. Edit a graph by one byte while a run is parked on a
    // gate and the hash no longer matches, so `approve` refuses (correctly — the approver
    // approved THOSE bytes) and `reject` refuses too, because a rejected gate runs the graph's
    // error edges. Cancel was the one exit that needs no graph at all, and it was shut for the
    // same reason as the two that do. Measured: all three returned `E_RUN_NOT_FOUND`, and the
    // refusal text named `--reject` and `cancel` as the ways out.
    //
    // A run with no journal is still not found — that is a different answer from "not attached",
    // and the one a caller asking about a nonexistent run should get.
    const known = await this.projection(runId);
    if (known === undefined) {
      throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`, { details: { runId } });
    }
    await this.#cancelTree(runId, reason, new Set(), by);
    const ctx = this.#runs.get(runId);
    return ctx === undefined ? (await this.projection(runId))! : (await this.#project(ctx))!;
  }

  /**
   * One run's cancellation, then its children's, then its own terminal event.
   *
   * `seen` is a cycle guard rather than an optimisation. Child ids are derived
   * (`parent~taskId`), so a cycle cannot arise from anything this engine writes — but this
   * walks a journal, and a journal is an input.
   */
  async #cancelTree(runId: RunId, reason: string, seen: Set<RunId>, by: CommandActor): Promise<void> {
    if (seen.has(runId)) return;
    seen.add(runId);

    // A CHILD NEED NOT BE ATTACHED. After a restart the operator holds the parent's graph
    // and nothing else; the child's graph is resolved lazily by the node that delegated.
    // Cancelling needs no graph — it is a projection and two appends — so a detached run
    // gets a log and no context, and only the in-flight abort is skipped, because in a
    // process that never attached it there is nothing in flight to abort.
    const ctx = this.#runs.get(runId);
    const log = ctx?.log ?? this.#logFor(runId);

    // IDEMPOTENT, and the check comes before the first append rather than after it. A run
    // that has ended is not re-ended: a second `gate.cancelled` on a gate with one closure
    // is indistinguishable, to anyone reading the log, from a second decision.
    //
    // NO JOURNAL is not the same as ended, and it proceeds: that is a child whose reference
    // the parent journaled and whose `submit` never landed, and the honest close is a
    // tombstone saying it was cancelled before it began, rather than a gap the next restart
    // reads as "not started yet, run it".
    const before = await this.projection(runId);
    if (before !== undefined && isTerminal(before.status)) return;

    // Journal the command BEFORE dispatching it, so a crash here re-drives the cancel
    // on restart rather than losing it. The reason travels down the tree, so a child's own
    // log says why it stopped and names what stopped it.
    await this.#serialize(() =>
      log.append([
        { type: "operator.command", payload: { kind: "cancel", args: { reason } }, actor: by },
      ]),
    );
    ctx?.abort.abort();

    for (const child of await childRunsOf(log)) {
      // THE SAME actor down the tree. A child cancelled because its parent was is still that
      // person's act; minting a fresh system actor here would make the cascade anonymous at
      // exactly the depth where the irreversible work lives.
      await this.#cancelTree(child, `the run that delegated to it was cancelled: ${reason}`, seen, by);
    }

    // Re-projected AFTER the children, because ending them can end this run too: a child
    // that reaches a terminal state resolves the parent's Task, and an `advance` still in
    // flight may have finished the parent while the cascade ran.
    const p = await this.projection(runId);
    if (p !== undefined && isTerminal(p.status)) return;

    await this.#serialize(() =>
      log.append([
        // AND THE TASKS GO WITH IT — REGISTER E6, and C1's `task.cancelled` finally has an
        // appender. `#commit` returns early on a terminal run, so a Task that was `leased`
        // when the cancel landed stayed `leased` in the read model for ever: the run reads
        // `cancelled` while one of its Tasks reads as still running, which is a projection
        // that describes a state the system is not in. Three folds — `projection.ts`,
        // `evolution/trajectory.ts` and `telemetry/spans.ts` — were already written for this
        // event and had no writer, so the dead code was on the READING side, where it is
        // hardest to notice.
        //
        // NON-TERMINAL ONLY. A Task that already succeeded, failed, was skipped or was
        // cancelled is a finished fact, and re-ending it would rewrite history the cancel did
        // not touch. `clean` mirrors `run.cancelled`'s: nothing was left half-done that this
        // event is aware of, and the run-level `unknownEffects` is where a half-done effect
        // is actually recorded.
        ...(p === undefined
          ? []
          : Object.values(p.tasks)
              .filter((t) => !TERMINAL_TASK_STATES.has(t.state))
              .map((t) => ({
                type: "task.cancelled" as const,
                payload: { clean: true, reason: `the run was cancelled: ${reason}` },
                actor: by,
                taskId: t.taskId,
              }))),
        // THE GATES GO WITH IT. `ctx.abort` reaches every in-flight effect and reaches no
        // gate at all — an open gate has no work to interrupt; it is a row and a queue
        // entry — so cancelling the run used to stop the executor and leave the question
        // standing. Answering it afterwards resurrected the run and drove the action the
        // cancel existed to prevent. D6.4 rule 4 says it plainly: gates are cancelled by
        // command, not by signal.
        ...(p === undefined ? [] : cancelOpenGates(p, `the run was cancelled: ${reason}`, by, this.#gates)),
        {
          type: "run.cancelled",
          payload: {
            clean: (p?.unknownEffects ?? []).length === 0,
            unknownEffects: p?.unknownEffects ?? [],
          },
          actor: by,
        },
      ]),
    );
  }

  /**
   * STOP TAKING NEW WORK, AND LOSE NOTHING THAT IS ALREADY IN FLIGHT.
   *
   * The difference from `cancel` is what it does NOT do: no `ctx.abort.abort()`, no gate
   * closure, no cascade, no terminal event. A wave that is running when this lands runs to
   * completion and commits — `#advanceSerially` re-projects at the top of every iteration,
   * so the pause is observed between waves and never inside one. That is the only place a
   * pause can be honest: aborting mid-effect is `cancel`'s job and it already reports what it
   * could not account for.
   *
   * IT IS TWO APPENDS AND NO PROCESS STATE, which is what makes it survive a restart and
   * makes a run paused by one plane behave identically on another:
   *
   *   - `operator.command{kind:"pause"}` — WHO did it and why, so a reader can tell from the
   *     journal alone that a human stopped this rather than the scheduler running dry.
   *   - `run.suspended{reason:"operator"}` — the durable status fact. Both members were in
   *     the vocabulary already with every writer in `src/` passing `"gate"`.
   *
   * NO GRAPH REQUIRED, for `cancel`'s reason: this runs no node code, so a run whose graph
   * has drifted out from under the process is still stoppable. A run with no journal is
   * `E_RUN_NOT_FOUND`; a run that has ended is `E_ILLEGAL_TRANSITION` rather than a silent
   * no-op, because an operator who is told "paused" about a run that already wrote the file
   * has been told something false.
   *
   * IDEMPOTENT: a second pause on a paused run appends nothing. Two `run.suspended` rows
   * would read, to anyone folding the log, like two separate interventions.
   */
  async pause(runId: RunId, reason = "operator", by: CommandActor = SYSTEM_ACTOR("operator")): Promise<RunProjection> {
    return this.#intervene(runId, "pause", (p) =>
      p.paused
        ? undefined
        : [
            { type: "operator.command", payload: { kind: "pause", args: { reason } }, actor: by },
            { type: "run.suspended", payload: { reason: "operator" }, actor: by },
          ],
    );
  }

  /**
   * Hand a paused run back its work.
   *
   * REFUSES A RUN THAT IS NOT PAUSED, and that refusal is the interesting half. `run.resumed`
   * folds `status` to `running` unconditionally — it has to, because the gate broker writes it
   * to end a gate suspension — so calling this on a run sitting at `awaiting_gate` would take
   * it out of `awaiting_gate` with the gate still open and unanswered. Nothing about that is a
   * decision an operator made; it is a fold's side effect. `resume` is therefore defined only
   * as the inverse of `pause`, and "the run is stuck on something else" gets a refusal that
   * names what it is stuck on rather than an unblock nobody asked for.
   */
  async resume(runId: RunId, reason = "operator", by: CommandActor = SYSTEM_ACTOR("operator")): Promise<RunProjection> {
    return this.#intervene(runId, "resume", (p) => {
      if (!p.paused) {
        throw err.conflict(
          CODES.E_ILLEGAL_TRANSITION,
          `run ${runId} is not paused (it is ${p.status}${p.suspendedReason === undefined ? "" : `, suspended on ${p.suspendedReason}`}); resume undoes a pause and nothing else`,
          { details: { runId, status: p.status } },
        );
      }
      return [
        { type: "operator.command", payload: { kind: "resume", args: { reason } }, actor: by },
        { type: "run.resumed", payload: { by: "operator" }, actor: by },
      ];
    });
  }

  /**
   * ONE OPERATOR INTERVENTION, DECIDED AGAINST A HEAD AND WRITTEN CONDITIONAL ON IT.
   *
   * `pause` and `resume` used to write through `RunLog.append`, and `RunLog`'s own docstrings
   * say why that is the wrong door: `append` "retries on seq conflict because the events are
   * unconditional", `commit` "NEVER retries — the caller decided something was true at
   * `expectedSeq`… the primitive that turns at-least-once execution into exactly-once state".
   * Everything either verb does before its write is a decision conditional on the head — the
   * run is not terminal AT `p.seq`, and it is (or is not) paused AT `p.seq`. Writing through
   * the retrying door meant two writers who both read "not paused" both landed.
   *
   * MEASURED, two Engines over one store — a `loom serve` and a CLI, which is the ordinary
   * deployment — with `Promise.allSettled` over two pauses. Both calls returned FULFILLED and
   * the journal read `5 operator.command | 6 run.suspended | 7 operator.command | 8
   * run.suspended`. `pause`'s own docstring already claimed the opposite: "IDEMPOTENT: a
   * second pause on a paused run appends nothing. Two `run.suspended` rows would read, to
   * anyone folding the log, like two separate interventions."
   *
   * THIS IS `HumanGateBroker.resolve`'S DEFECT, ONE DOOR OVER, and it is fixed the same way —
   * so the shape is copied rather than reinvented. THE RETRY IS HERE AND IT IS NOT A
   * RE-COMMIT: `commit` never retries, so a conflict comes back to the top and re-decides
   * against the NEW head. A conflict raised by an unrelated append (a wave committing, a
   * sweeper) is served by the next lap; a conflict raised by the OTHER operator's pause meets
   * `p.paused` on the next lap and becomes the documented no-op, which is the right answer
   * and the one the concurrent case never used to give. A bare re-`commit` at a refreshed seq
   * would be the original defect with an extra step.
   *
   * `decide` returning `undefined` means "already true, append nothing"; throwing is a
   * refusal, and it is re-evaluated on every lap so a loser reaches the same refusal a
   * latecomer would.
   *
   * WHY THESE TWO AND NOT EVERY GUARDED APPEND IN THIS FILE. `#cancelTree` and `#finish` have
   * the same read-then-append shape and are NOT converted here: a duplicate from either is
   * caught by `journal/audit.ts`'s `run.terminal-is-last-and-once`, so it is a defect somebody
   * eventually finds. A duplicated operator intervention was invisible to every rule that file
   * had — which is why the fix for these two ships with the rule that makes them visible.
   *
   * THE READ, THE DECISION AND THE COMMIT ARE ONE `#serialize` SLOT, and that is load-bearing
   * rather than tidy. The first version of this loop read the projection and decided OUTSIDE
   * the chain and entered it only for the commit, so every append the engine's OWN running
   * graph made landed between the two — a busy run moved the head under all eight laps and
   * the operator's brake came back `E_SEQ_CONFLICT` with the run still going. Measured on one
   * Engine over a `MemoryStateStore`, a 20-node `seq` chain with `advance` in flight: pause
   * refused at 38, 40, 42, 52 and 56 microtask ticks, `run.suspended` rows 0, journal 144
   * events, run succeeded. That is `loom serve` exactly — the engine answering the HTTP pause
   * is the engine driving the run — so the in-process window was the common case, not the
   * exotic one. `RunLog.append`, the door this replaced, never lost it because its retry loop
   * ran entirely inside ONE slot. `pause-beats-a-busy-run.test.ts` holds the range.
   *
   * NO DEADLOCK, and the reason is a fact about one method: `#requireLive` reads through
   * `Engine.projection`, which folds the journal and does NOT go through `#serialize`. A lap
   * therefore never waits on the chain it is already holding. The lap loop stays, because the
   * conflict it was built for — another PROCESS over the same journal — is still real and
   * `#serialize` cannot order writers it cannot see.
   */
  async #intervene(
    runId: RunId,
    verb: string,
    decide: (p: RunProjection) => readonly NewEvent[] | undefined,
  ): Promise<RunProjection> {
    for (let attempt = 0; ; attempt++) {
      try {
        // `undefined` means "the decision was to append nothing"; a projection is that
        // already-true answer, returned as `pause`'s documented no-op.
        const settled = await this.#serialize(async (): Promise<RunProjection | undefined> => {
          const p = await this.#requireLive(runId, verb);
          const events = decide(p);
          if (events === undefined) return p;
          const log = this.#runs.get(runId)?.log ?? this.#logFor(runId);
          await log.commit(p.seq, events);
          return undefined;
        });
        if (settled !== undefined) return settled;
        return (await this.projection(runId))!;
      } catch (e) {
        if (!isLoomError(e) || e.code !== CODES.E_SEQ_CONFLICT) throw e;
        if (attempt + 1 >= MAX_INTERVENTION_LAPS) {
          throw err.conflict(
            CODES.E_SEQ_CONFLICT,
            `run ${runId} could not be ${verb}d in ${MAX_INTERVENTION_LAPS} attempts — the journal head moved under every one`,
            { details: { runId, verb } },
          );
        }
      }
    }
  }

  /**
   * PUT A RUNNING GRAPH ONTO A DIFFERENT EDGE ITS AUTHOR DECLARED.
   *
   * `TODO.md` §Z (D.4, answered 2026-08-28) fixes the shape: steer is "confined to the compiled edge set, exactly as a
   * `router` is", and it must not reach an edge the compiled graph does not contain — that is
   * `graph:mutate`, a capability a tenant either holds or does not, and reaching it from the
   * operator surface would be oversight routing around itself.
   *
   * FOUR REFUSALS, in the order they are checked and in the order of what each would break:
   *
   *   1. A NON-HUMAN CALLER — `E_HUMAN_APPROVAL_REQUIRED`, and there is deliberately no
   *      `SYSTEM_ACTOR` default the way `cancel` has one. Confinement to the declared set is
   *      what makes a steer legitimate, and it is not the whole story: an author may declare
   *      one arm carrying a `human_gate` and one without, and forcing the ungated arm lowers
   *      the oversight this run would otherwise have had. A HUMAN MAY DO THAT — "a human may
   *      lower a posture" — and no automated path may, which is why the actor is the first
   *      thing checked rather than a parameter with a convenient default.
   *   2. A RUN THIS PROCESS HOLDS NO GRAPH FOR — `E_RUN_NOT_FOUND`, via `#require`. This is
   *      where `steer` parts company with `cancel` and `pause`, which work detached on purpose
   *      because they are a projection and two appends. The declared edge set lives in the
   *      COMPILED graph; with no graph there is nothing to confine the operator to, and a
   *      guard that cannot decide fails closed rather than guessing.
   *   3. AN EDGE THAT DOES NOT LEAVE THAT NODE — `E_ROUTE_INVALID`, quoting the declared set.
   *      `#activate` looks an edge id up in the WHOLE graph's edge table, so a `take` naming
   *      another node's edge activates that node's target and jumps everything in between, a
   *      `human_gate` included. That hole was found on the body path (`#strayRoute`) and on
   *      the human path (`#applyGateDecision`); this is the third producer and it gets the
   *      same rule. It is checked TWICE — here, so the operator is told at the door, and again
   *      at the moment the edge would be taken, because that second check is the one a caller
   *      who wrote the journal directly cannot skip.
   *   4. AN EMPTY `take` — `E_ROUTE_INVALID`. "Go nowhere" is a run that stops with no
   *      terminal event; stopping a run is `cancel`, which reports what it left unaccounted
   *      for instead of leaving a reader to infer it.
   *
   * IT STANDS UNTIL IT IS REPLACED, and it is read when the node is DISPATCHED — so a node
   * already executing does not see it. The workflow is `pause` → `steer` → `resume`, which is
   * also the only version of it in which an operator is deciding against a state that is
   * holding still. A second steer on the same node replaces the first: that is somebody
   * changing their mind, not two routes.
   */
  async steer(
    runId: RunId,
    route: { readonly nodeId: NodeId; readonly take: readonly EdgeId[] },
    reason: string,
    by: HumanActor,
  ): Promise<RunProjection> {
    if (by.kind !== "human") {
      throw err.policy(
        CODES.E_HUMAN_APPROVAL_REQUIRED,
        `steering run ${runId} chooses a route the program would otherwise choose for itself, and may pick an arm carrying less oversight; only a human may do that`,
        { details: { runId, actor: by } },
      );
    }
    await this.#requireLive(runId, "steer");
    const ctx = this.#require(runId);
    const outbound = (ctx.index.outbound.get(route.nodeId) ?? []).map((e) => e.id);
    // A NODE THAT IS NOT IN THE GRAPH LANDS HERE TOO, with an empty declared set and the same
    // code. It is the same fact — this run has no such route — and answering it with a second
    // error class would only tell a caller which of two ways they were wrong.
    // A NODE WHOSE ROUTE THIS PATH NEVER DECIDES CANNOT BE STEERED, and accepting the steer
    // anyway is the loosening. The override is applied in `#dispatchNode`, on a body that
    // returned `succeeded`. A `human_gate` does not return through there — it SUSPENDS, and
    // resumes via `resolveGate` — so a steer aimed at one was accepted, journaled, folded into
    // `p.steers`, and then never read. Both doors reported success for an intervention with
    // zero effect, which is worse than a refusal: an operator who is told "done" stops looking.
    //
    // Named by NODE TYPE and only the one that was demonstrated. The honest bound on this
    // check is that it is a list of shapes somebody drove, not a proof about the other seven —
    // if a second type turns out never to consult `p.steers` either, it belongs here and the
    // way it will be found is somebody reporting a steer that did nothing.
    const target = ctx.index.byId.get(route.nodeId);
    if (target?.type === "human_gate") {
      throw err.policy(
        CODES.E_ROUTE_INVALID,
        `node "${route.nodeId}" is a human_gate, and a gate's route is decided by the DECISION, not by a steer — ` +
          `approve, reject or edit it with \`loom approve\`. A steer here would be recorded and never applied`,
        { details: { runId, nodeId: route.nodeId, nodeType: target.type } },
      );
    }
    const invented = route.take.filter((id) => !outbound.includes(id));
    if (route.take.length === 0 || invented.length > 0) {
      throw err.policy(
        CODES.E_ROUTE_INVALID,
        route.take.length === 0
          ? `a steer must name at least one edge; to stop run ${runId} use cancel, which reports what it left unaccounted for`
          : `node "${route.nodeId}" has no outgoing edge ${invented.map((i) => `"${i}"`).join(", ")} (declared: ${outbound.map((o) => `"${o}"`).join(", ") || "none"})`,
        { details: { runId, nodeId: route.nodeId, take: route.take, declared: outbound } },
      );
    }
    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "operator.command",
          payload: { kind: "steer", args: { nodeId: route.nodeId, take: [...route.take], reason } },
          actor: by,
        },
      ]),
    );
    return (await this.#project(ctx))!;
  }

  /**
   * The projection of a run an operator command may legally act on, or a refusal.
   *
   * Shared by `pause` and `resume` so the two cannot drift on which states they accept —
   * "a rule enforced by convention at each call site is not a rule". It deliberately does
   * NOT require attachment: see `cancel` for the measured case where demanding a graph made
   * a stranded run inescapable by every exit at once.
   */
  async #requireLive(runId: RunId, verb: string): Promise<RunProjection> {
    const p = await this.projection(runId);
    if (p === undefined) {
      throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`, { details: { runId } });
    }
    if (isTerminal(p.status)) {
      throw err.conflict(CODES.E_ILLEGAL_TRANSITION, `run ${runId} has already ${p.status}; it cannot be ${verb}d`, {
        details: { runId, status: p.status },
      });
    }
    return p;
  }

  /** A writer for a run this engine holds no context for. */
  #logFor(runId: RunId): RunLog {
    return new RunLog(runId, {
      store: this.#store,
      now: this.#now,
      ...(this.#bus === undefined ? {} : { bus: this.#bus }),
    });
  }

  /**
   * Rewind to a checkpoint by APPENDING a restore marker.
   *
   * The original journal is never edited; the fold hides `(atSeq, marker)` instead.
   * So a rewind is itself auditable, and a trace still shows what was undone.
   *
   * A NON-HUMAN CALLER IS REFUSED FIRST — `E_HUMAN_APPROVAL_REQUIRED`, and there is
   * deliberately no `SYSTEM_ACTOR` default the way `cancel` and `pause` have one. The decision
   * this implements is `b90b137`'s fifth: a compensation edge fires on rewind as well as on run
   * failure, so "an operator inspecting history can trigger real-world undo", and that must be
   * "loud, gated by the same oversight floor an irreversible action gets, and never silent".
   * An irreversible action at `in` requires a human. CITED BY COMMIT AND NOT AS "§D.5", which
   * is what `TODO.md` called it and what this comment said first: §D has been renumbered since,
   * and D.5 today is a different question entirely — a stale pointer into a renumbered
   * enumeration is the failure `CLAUDE.md` already records once.
   *
   * This parameter defaulted to `SYSTEM_ACTOR("operator")` and was then checked
   * nowhere, so the floor did not exist: measured before this check, a rewind with NO actor
   * argument at all was accepted and journaled as `system:operator`, and over HTTP a service
   * token's rewind was accepted 200 and journaled as `system:principal:svc:deployer`.
   *
   * WHAT A REWIND WOULD BREAK THAT MAKES A HUMAN NECESSARY, which is the question `steer`'s
   * docstring answers for itself and this one must answer for its own verb. A rewind
   * DISPATCHES real-world undos — `#compensate` runs `fs.restore`, `pay.refund` and whatever
   * else the crossed tools declare — so it is the one operator command that reaches out and
   * changes the world rather than only the record. And it does the opposite of what oversight
   * is for on the same pass: the range it suppresses may contain the very `gate.decided` a
   * person spent their judgement on, and the run then re-runs those nodes against whatever
   * their ceiling is now. The four refusals below exist because rewinding past someone's
   * decision overrules them; letting an automated caller drive the verb that does that would
   * make those refusals the only thing standing between a service token and a human's answer.
   *
   * UNCONDITIONALLY, NOT ONLY WHEN THERE IS SOMETHING TO UNDO — and this is the half worth
   * arguing rather than asserting. A rewind that dispatches nothing still suppresses events,
   * re-arms leases and changes what the run does next, so it is not the empty operation the
   * "no undos" reading suggests. But the decisive reason is that the dispatch list is computed
   * in `#rewindSerially`, AFTER four refusals and a full journal read of the whole run tree: a
   * caller cannot know whether their rewind has undos until it has already run. A rule
   * conditioned on that is a rule nobody can follow, and a guard that cannot decide fails closed.
   * THE SAME ARGUMENT CARRIES A.35's `planHash`, which is why it is required unconditionally too
   * — a stuck-lease recovery pays the handshake for an empty list, and paying it is cheaper than
   * a rule whose precondition nobody can evaluate.
   *
   * IT IS `steer`'S SHAPE AND NOT `cancel`'S, and the two are not near-misses of each other.
   * `cancel` accepts an anonymous caller because refusing is always allowed — it stops a run
   * and reports what it left unaccounted for. A rewind does not stop anything; it puts the run
   * back on a path the operator picked and erases the record in between, which is `steer`'s
   * kind of act with a larger blast radius.
   *
   * AND THE LOUD HALF IS `planRewind`, WHICH IS WHY THIS TAKES A FIFTH ARGUMENT. `TODO.md`
   * A.35: the operator has to see WHICH undos a rewind will dispatch BEFORE authorizing it.
   * `planRewind(runId, atSeq, by)` is that list and `auth.planHash` is the operator's answer to
   * it; a hash that no longer matches what this call would dispatch is REFUSED. See `planRewind`
   * for what the hash covers and why the preview could not be the old `plannedUndo`.
   */
  async rewind(runId: RunId, atSeq: Seq, reason: string, by: HumanActor, auth: RewindAuthorization): Promise<RunProjection> {
    // SERIALIZED PER RUN, and `#serialize` is not what does it. That queue orders journal
    // APPENDS; two concurrent rewinds are two `check the hash, then dispatch` sequences
    // interleaved between appends, which is the shape `advance` already carries a chain for
    // ("it is not an execution lock, so two concurrent `advance` calls ... dispatched every one
    // of them twice"). Measured on `rewind-through-subgraph`'s direct leg before this chain:
    // `Promise.allSettled([rewind(runId,1,..), rewind(runId,1,..)])` fulfilled BOTH and wrote two
    // `compensation.recorded` rows for one `compensatesSeq` — the same real-world undo dispatched
    // twice off one authorization.
    //
    // THE HASH ALONE DOES NOT CLOSE THIS, and that is worth stating because it looks like it
    // should. Both callers compute the same plan from the same journal, so both hashes match and
    // both proceed; a check at the top of a method that is not serialized end-to-end says nothing
    // about the second caller. With the chain, the second rewind re-plans AFTER the first has
    // journaled its `compensation.recorded` rows, `planCompensation` settles those seqs, the plan
    // is genuinely different, and the hash then refuses it — which is the correct answer and the
    // one the operator can act on. Chain and hash close it together; neither does alone.
    const prev = this.#rewinding.get(runId);
    const run = (async () => {
      if (prev !== undefined) await prev;
      return this.#rewindSerially(runId, atSeq, reason, by, auth);
    })();
    // A never-rejecting handle, `advance`'s shape: a predecessor that threw must not reject its
    // successor, and an unhandled rejection here would take the process down.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#rewinding.set(runId, settled);
    void settled.then(() => {
      if (this.#rewinding.get(runId) === settled) this.#rewinding.delete(runId);
    });
    return run;
  }

  /**
   * WHAT A REWIND WOULD UNDO, WITH THE HASH THAT BINDS IT. The LOUD half of `b90b137`'s fifth.
   *
   * A.34 gave `rewind` a human floor, so a person authorizes *a rewind*. They still could not
   * see *what it would undo*, and the decision this closes asked for "loud, gated by the same
   * oversight floor an irreversible action gets, and never silent".
   *
   * IT IS THE DISPATCHER'S OWN WALK, NOT A SECOND OPINION ABOUT IT. `rewind` used to compute a
   * preview as `planCompensation` over the rewound run's OWN events while dispatching
   * `#compensate`'s tree walk. Measured on `rewind-through-subgraph`'s DELEGATED leg: the
   * parent-only plan was empty, its hash was the digest of `[]`, and a `pay.refund` was
   * dispatched in the child. A preview that says "nothing to undo" over a charge about to be
   * reversed is worse than no preview, so both callers consume `#planRollback` and "the two
   * agree" is true by CONSTRUCTION rather than by a test that only ever exercises the
   * non-delegated case.
   *
   * ── WHAT `planHash` COVERS, AND WHY EACH FIELD IS IN IT ──────────────────────
   * `digest({runId, atSeq, attached, steps})`, each step
   * `{runId, seq, compensates, tool, irreversibility, ok, undo | blocked, argsDigest?,
   * undispatchable?}` in dispatch order.
   *
   *  - `seq` and `compensates`, because `run/compensation.ts` calls `seq` "the step's identity"
   *    and two effects sharing a `tool -> undo` pair differ in nothing else. A `tool -> undo`
   *    list is provably not enough.
   *  - `undo | blocked`, because a registry that changed under the run turns a dispatch into a
   *    block, and the operator authorized the first.
   *  - `argsDigest`, because the undo's ARGUMENTS are not in the step at all: they are the
   *    compensated call's recorded `details`, read through the suppression-aware
   *    `#completedEffects` the dispatcher itself uses. A rewind to a different `atSeq` changes
   *    what an unchanged step dispatches, and a hash over tool names calls those equal.
   *  - `undispatchable` per step and `attached` for the run, because "this engine can no longer
   *    run it" is a fact about the PROCESS rather than the journal, and a confirm after a restart
   *    has to be refused rather than silently becoming a no-op. No journal-derived hash can catch
   *    that, so it is in the hash's own header.
   *
   * IT RUNS EVERY REFUSAL `rewind` RUNS, through `#rewindRefusals`. A preview of a rewind that
   * will be refused anyway is a plan the operator can never use, and handing them one is a
   * different way of lying to them.
   *
   * A HUMAN ONLY, exactly as the rewind is. The plan enumerates a run's undoable real-world
   * effects; gating the act while publishing the reconnaissance is not a floor. This is the read
   * half of one verb, not a second verb.
   */
  async planRewind(runId: RunId, atSeq: Seq, by: HumanActor): Promise<RewindPlan> {
    this.#requireHumanRewind(runId, atSeq, by, "planning a rewind of");
    const { p, live, ctx } = await this.#rewindRefusals(runId, atSeq);
    const { plan } = await this.#rewindPlanOf(runId, atSeq, p, live, ctx);
    await this.#journalPlanShown(ctx, plan, by);
    return plan;
  }

  /** The human floor `rewind` and `planRewind` share, so the two cannot drift on who may ask. */
  #requireHumanRewind(runId: RunId, atSeq: Seq, by: HumanActor, verb: string): void {
    if (by.kind !== "human") {
      throw err.policy(
        CODES.E_HUMAN_APPROVAL_REQUIRED,
        `${verb} run ${runId} dispatches real-world undos and suppresses the record of what it undid, decisions a human already made included; only a human may do that. ` +
          // NAMES THE FLAG, because "authenticate as a person" is not actionable on a plane that
          // has no identity source at all — and the alternative below is deliberately NOT offered
          // as an equivalent. README sends an operator here to recover a STUCK LEASE, which a
          // rewind re-arms and `cancel` does not; saying "use cancel instead" for that case would
          // name a way out that is not one.
          `Give the plane an identity source (\`--identity-file\`, or an \`--extension-module\` that registers one) ` +
          `and send a person\u2019s credential. \`cancel\` stops a run but does NOT re-arm a lease, so it is not a substitute here`,
        { details: { runId, atSeq, actor: by } },
      );
    }
  }

  /**
   * The walk, as a thing an operator can be shown and a hash can cover.
   *
   * `RollbackWalkStep` carries a live `RunContext` and a raw recorded result; neither can be
   * serialized to an operator, and the second must not be — `details` is production data.
   * `argsDigest` is what survives that: it binds the plan to WHAT gets undone without putting a
   * value anywhere.
   *
   * A DETACHED RUN STILL GETS A PLAN, with no `ctx` handed to the walk. Every step of the run and
   * of every run below it comes back `undispatchable` — which is the honest answer, and is exactly
   * what `rewind`'s detached refusal reads.
   */
  async #rewindPlanOf(
    runId: RunId,
    atSeq: Seq,
    p: RunProjection,
    live: RunContext | undefined,
    ctx: { readonly log: RunLog },
  ): Promise<{ readonly plan: RewindPlan; readonly walk: readonly RollbackWalkStep[] }> {
    const walk = await this.#planRollback({ runId, log: ctx.log, ...(live === undefined ? {} : { ctx: live }), p, sinceSeq: atSeq });
    const steps: RewindPlanStep[] = walk.map((item) => ({
      runId: String(item.runId),
      seq: item.step.seq,
      compensates: item.step.compensates,
      tool: item.step.tool,
      irreversibility: item.step.irreversibility,
      ok: item.step.ok,
      ...(item.step.undo === undefined ? {} : { undo: item.step.undo }),
      ...(item.step.blocked === undefined ? {} : { blocked: item.step.blocked }),
      // Only where an undo would actually be built. A step nothing will attempt has no arguments
      // to bind, and `#compensateOne` reads `details` off the recorded result for the rest.
      ...(item.result === undefined || item.step.undo === undefined ? {} : { argsDigest: digest(detailsOf(item.result)) }),
      ...(item.undispatchable === undefined ? {} : { undispatchable: item.undispatchable }),
    }));
    const dispatch = steps.filter((s) => s.undo !== undefined && s.undispatchable === undefined).length;
    const header = { runId: String(runId), atSeq: atSeq as number, attached: live !== undefined, steps };
    return { plan: { ...header, dispatch, blocked: steps.length - dispatch, planHash: digest(header) }, walk };
  }

  /**
   * PUT THE SHOWN PLAN ON THE RECORD, so the authorization is a journal fact and not a memory.
   *
   * THIS IS WHY A.35 IS (a) AND NOT AN INLINE CONFIRM CALLBACK. A callback's answer exists only
   * in the process that held it, nothing folds behind it, and a restart between the question and
   * the dispatch loses what the operator was shown — the first non-negotiable, and the class this
   * repo has violated six times. Two calls with the plan on the log has none of that.
   *
   * ON `operator.command`, WHICH NEEDED NO NEW EVENT TYPE. Its payload is
   * `{kind: string, args: Record<string, unknown>}` — deliberately open, already the audit home
   * for what a person did to a run (`journal/audit.ts`), and already written by `cancel`,
   * `pause`, `resume` and `steer`. A rewind was the one operator verb with no `operator.command`
   * row of its own; it has two now, `rewind.plan` for what was shown and `rewind` for what was
   * authorized. `run/projection.ts` folds only `kind: "steer"` and returns early for everything
   * else, so an old binary folding a new journal is unaffected — which is what makes this
   * additive rather than a change to the closed vocabulary in `journal/events.ts`.
   *
   * THE PLAN TEXT AND NOT ONLY THE HASH. The plan is NOT recomputable from the journal later: it
   * depends on this process's `ToolRegistry` and on which child graphs could be rehydrated. A
   * bare hash would certify a list nobody can reproduce, which is not an audit trail.
   *
   * IDEMPOTENT ON THE HASH, so a console that re-reads the plan every few seconds writes one row
   * rather than one per poll. `planHash` already covers everything that could make two previews
   * different, so "the last `rewind.plan` on this log carries this hash" is the exact condition
   * under which a second row would say nothing new. Derived, never a nonce.
   */
  async #journalPlanShown(ctx: { readonly log: RunLog }, plan: RewindPlan, by: HumanActor): Promise<void> {
    // EVERY PRIOR HASH, NOT THE LAST ONE. Comparing against only the most recent row made this
    // idempotent for a console that previews ONE boundary and non-idempotent for anything else:
    // measured, 25 alternating previews of `atSeq` 1 and 2 wrote 25 rows and took the journal
    // from 18 to 43. `planRewind` re-reads the whole journal on every call, so the cost of the
    // previews compounded with the rows they wrote. A `Set` is the same loop and the same read.
    const seen = new Set<string>();
    for await (const e of ctx.log.read(1 as Seq)) {
      if (!isEvent(e, "operator.command") || e.payload.kind !== "rewind.plan") continue;
      const hash = e.payload.args["planHash"];
      if (typeof hash === "string") seen.add(hash);
    }
    if (seen.has(plan.planHash)) return;
    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "operator.command",
          payload: {
            kind: "rewind.plan",
            args: { atSeq: plan.atSeq, planHash: plan.planHash, attached: plan.attached, dispatch: plan.dispatch, blocked: plan.blocked, steps: plan.steps },
          },
          // THE PERSON WHO ASKED, not `SYSTEM_ACTOR`. This route requires a human precisely
          // because enumerating a run's undoable effects is sensitive; recording WHAT was shown
          // and not WHO asked to see it loses the half that makes the row an audit record. The
          // authorization row already carried `by`; this one did not.
          actor: by,
        },
      ]),
    );
  }

  /**
   * The plan a given hash was shown as, read back OUT OF THE JOURNAL, or `undefined`.
   *
   * What makes the stale-plan refusal able to name what CHANGED rather than only that something
   * did. It reads raw rather than suppression-aware on purpose: a `rewind.plan` row written
   * before a rewind lands inside the range `(atSeq, marker)` that rewind then suppresses, and a
   * fold that hid it would make the second rewind unable to explain itself.
   *
   * A JOURNAL IS AN INPUT, not something this may assume well-formed — the same rule
   * `run/projection.ts` states for `operator.command{steer}`. Every field is checked and a row it
   * cannot read yields NO plan, which degrades the refusal's message and never its verdict.
   */
  async #planShownAs(runId: RunId, planHash: string): Promise<readonly RewindPlanStep[] | undefined> {
    let found: readonly RewindPlanStep[] | undefined;
    for await (const e of this.#store.read(runId, 1 as Seq)) {
      if (!isEvent(e, "operator.command")) continue;
      if (e.payload.kind !== "rewind.plan" && e.payload.kind !== "rewind") continue;
      if (e.payload.args["planHash"] !== planHash) continue;
      const steps = e.payload.args["steps"];
      if (!Array.isArray(steps)) continue;
      const parsed: RewindPlanStep[] = [];
      for (const s of steps) {
        if (s === null || typeof s !== "object") continue;
        const row = s as Record<string, unknown>;
        if (typeof row["runId"] !== "string" || typeof row["seq"] !== "number" || typeof row["tool"] !== "string") continue;
        parsed.push(row as unknown as RewindPlanStep);
      }
      found = parsed;
    }
    return found;
  }

  /**
   * Everything `rewind` refuses BEFORE it would undo anything, and `planRewind` refuses too.
   *
   * Extracted so the preview and the confirm cannot answer differently about the same boundary —
   * "a rule enforced by convention at each call site is not a rule", the argument `#requireLive`
   * already makes for `pause` and `resume`.
   */
  async #rewindRefusals(
    runId: RunId,
    atSeq: Seq,
  ): Promise<{ readonly p: RunProjection; readonly live: RunContext | undefined; readonly ctx: { readonly log: RunLog } }> {
    // A rewind reads the log and appends a marker, and needs nothing else from a live
    // context — which matters because the runs most worth rewinding are the FINISHED ones,
    // and requiring a context meant a completed run could be rewound only for as long as
    // something held it. `#logFor` is the writer for exactly this case.
    // The live context, when this engine still holds one. Kept separately from `ctx` because a
    // rewind can DISPATCH now — see the compensation block below — and dispatching needs the
    // graph, the policy engine and the abort signal, none of which are in the journal.
    const live = this.#runs.get(runId);
    const ctx = { log: live?.log ?? this.#logFor(runId) };

    // A BOUNDARY BELOW THE RUN'S FIRST EVENT ERASES THE RUN, AND NOTHING BRINGS IT BACK.
    //
    // The three refusals below are all about what a rewind would UNDO. This one is about
    // what it would undo the run INTO. `suppressedRanges` hides `(atSeq, marker)` exclusive
    // at both ends, so `atSeq: 0` hides every event there has ever been — `run.submitted`
    // included. Measured on the skeleton graph, parked on its gate at seq 88:
    // `rewind(runId, 0)` was ACCEPTED and folded to `status: "queued"`, `graphHash: ""`,
    // **zero tasks, zero gates, and zero channels** — the run's own inputs gone with the
    // event that carried them. `advance()` then found no work, no open gate and nothing
    // terminal, walked straight to `#finish`, and appended
    // `run.failed{E_OUTPUT_MISSING}: run finished without writing any of its declared
    // outputs (written)`. A run that had done everything asked of it and was waiting on a
    // human reports as having produced nothing.
    //
    // AND IT IS THE ONE WEDGE WITH NO WAY OUT. Every other refusal here names a recovery
    // that suppresses MORE — the `gate.decided` arm's message says "rewind to `atSeq - 1`
    // to ask again", and that works because a lower boundary hides the half-append that
    // wedged it. There is no seq below 0. Measured: after `rewind(runId, 0)`, rewinding to
    // 1, 2, 50, 88 and 89 in turn each folded back to `queued` with zero tasks and zero
    // channels, because the first range still hides everything a later one would have kept.
    // Refusing is the whole fix; there is nothing to repair afterwards.
    //
    // It does NOT make every boundary safe, and saying otherwise would be the more
    // dangerous half-truth. Boundaries of 1, 2 and 3 leave a run with its graph hash and
    // inputs intact but no runnable Task, and one landing inside a Task's own append leaves
    // it `leased` with no holder; all of those fail with `E_OUTPUT_MISSING` too. What
    // separates 0 is that the run stops being ITSELF — no graph, no inputs, no identity to
    // rewind — and that no lower seq exists to answer it with.
    if (atSeq < 1) {
      throw err.conflict(
        CODES.E_RESTORE_ILLEGAL,
        `seq ${atSeq} is below run ${runId}'s first event, so rewinding there would suppress \`run.submitted\` itself — leaving a run with no graph, no inputs and no lower seq to recover through. Rewind to 1 or higher, or submit a new run`,
        { details: { runId, atSeq } },
      );
    }

    // Same reason as the return below: `projection` folds from seq 1 and needs no cursor, so
    // the pre-flight checks work on a run this engine holds no context for.
    const p = (await this.projection(runId))!;

    // A CANCEL IS NOT UNDOABLE, and this is the widest door back into a cancelled run.
    // Suppressing `run.cancelled` suppresses the `gate.cancelled` events appended beside
    // it, so the gates reopen with the run and every path the layers above just closed
    // opens again at once — one call, no approvers checked.
    //
    // Rewinding a `failed` or `succeeded` run undoes an OUTCOME, which is a retry. A cancel
    // is a person's refusal, and undoing it silently overrules them. The way back is a new
    // run — a new id, a new journal, and a decision somebody has to make on the record.
    if (p.status === "cancelled") {
      throw err.conflict(
        CODES.E_RESTORE_ILLEGAL,
        `run ${runId} was cancelled; a cancel is not undone by rewinding past it — submit a new run`,
        { details: { runId, atSeq } },
      );
    }

    // A REJECTION IS A REFUSAL TOO, so the same rule reaches it.
    //
    // The status check above is not enough: a run that a human REJECTED ends `failed`, and
    // "failed" was read as "an outcome, therefore a retry". It is not — the failure IS the
    // refusal, and suppressing the `gate.decided` that carries it returns the gate to `open`
    // and puts the refused action back on the table for whoever answers next. One call, and
    // the "no" is gone from every read model while the journal still records it.
    //
    // AND THE OPPOSITE SIGN RESOLVES THE OTHER WAY, deliberately: rewinding past an
    // `approve` is allowed, because suppressing the decision re-OPENS the gate rather than
    // carrying the approval forward — the same person is asked the same question again
    // before anything runs. Re-asking someone who said yes costs a click; re-asking someone
    // who said no is an appeal against a decision already made. `edit` and `redirect` go
    // with `approve`: they modify a request, they do not refuse it.
    //
    // Scoped to the range this rewind would SUPPRESS, PLUS THE BOUNDARY ITSELF.
    //
    // A rejection earlier in the run's history is not being undone, and refusing on it
    // would make a run unrewindable forever because a human once said no to something else.
    // But the scan started at `atSeq + 1`, and `atSeq` is precisely the seq this rewind
    // cannot afford not to look at: `suppressedRanges` is exclusive at both ends, so
    // rewinding to a `gate.decided{reject}`'s own seq KEEPS the decision and DROPS the
    // `run.resumed` that shipped in the same append. The fold then reports a run
    // `awaiting_gate` whose only gate is already decided — zero open gates, nothing a human
    // can answer, nothing the scheduler will pick up, and (the status is not `cancelled`)
    // no second rewind that would refuse to make it worse. A permanent wedge, reachable by
    // asking for a seq one lower than the one that is refused.
    for await (const ev of ctx.log.read(Math.max(1, atSeq) as Seq)) {
      // A BATCH DECISION'S RECEIPT IS THE SAME BOUNDARY, AND IT IS NOT A `gate.decided`.
      //
      // `HumanGateBroker.resolveBatch` writes N `gate.decided`, then `gate.batch_decided`,
      // then `run.resumed` — one append, N + 2 seqs. Every seq but one is refused by the
      // arm below; the receipt is neither a decision nor the resume, so the scan walked
      // past it. Reproduced on a three-branch fan-out before this line existed:
      // `24,25,26:gate.decided 27:gate.batch_decided 28:run.resumed`, `rewind(runId, 27)`
      // ACCEPTED, the run folded to `awaiting_gate` with ZERO open gates, and `advance()`
      // was a no-op with zero writes. Three approvals kept, the resume dropped, nothing
      // left for a human to answer and nothing for the scheduler to lease.
      //
      // THIS IS REGISTER ENTRY A10, REACHED THROUGH A NEW EVENT TYPE, and the narrowness
      // of the fix is the evidence for A10's own prescription: the property that matters is
      // "this boundary splits an append whose tail carries the run's status transition",
      // and it is written here as "this event is one of two named types". Every row a
      // future change adds to a decision's or a terminal's append has to be added here too,
      // or it reopens the hole — which is why A10 asks for the refusal to become a property
      // of the APPEND rather than of the type. It is not fixed here because doing it
      // properly needs an append boundary the journal does not currently record, and half
      // of that is worse than this.
      if (isEvent(ev, "gate.batch_decided") && ev.seq === atSeq) {
        throw err.conflict(
          CODES.E_RESTORE_ILLEGAL,
          `seq ${atSeq} is the receipt for the one decision that closed gate batch "${ev.payload.batchId}" (${ev.payload.gateIds.length} gates), and the \`run.resumed\` it was appended with is at seq ${atSeq + 1}; rewinding to it would keep every decision and drop the resume, leaving run ${runId} suspended on gates that are already answered — rewind to ${atSeq + 1} to keep the decision, or below seq ${ev.payload.gateIds.length === 0 ? atSeq : atSeq - ev.payload.gateIds.length} to ask again`,
          { details: { runId, atSeq, batchId: ev.payload.batchId, gateIds: ev.payload.gateIds } },
        );
      }
      // AN EXPIRY IS THE SAME BOUNDARY AND IS NOT A DECISION AT ALL — register entry A10.
      //
      // `HumanGateBroker.#expire` writes `gate.timeout{action:"fail"}` + `run.failed` in ONE
      // append, which is the identical two-seq shape the arm below refuses for
      // `gate.decided`, and the scan walked straight past it because it is a different event
      // type. Reproduced on the skeleton graph: `#expire` wrote `89:gate.timeout
      // 90:run.failed`; `rewind(runId, 89)` was ACCEPTED; the run folded to
      // `run=awaiting_gate gate=expired openGates=0`; `advance()` was a no-op with zero
      // writes; `sweepTimeouts` fired nothing (the gate is no longer open) and `resolveGate`
      // answered "is expired, not open". Neither the clock nor a human could move it —
      // the same permanent wedge, reached by asking for the seq the `gate.decided` refusal
      // was written to protect.
      //
      // ONLY the `fail` action, and that narrowness is the point rather than an oversight.
      // `gate.timeout{default_action}` heads a THREE-event append (timeout + decision +
      // resume) and rewinding to its first seq suppresses all three, leaving the gate OPEN —
      // recoverable, and exactly what an operator asking for that seq wants. Its middle seq
      // is the `gate.decided` the arm below already refuses. `gate.timeout{escalate}` writes
      // no terminal at all.
      //
      // This is the THIRD event type added to a scan that A10 asks to become a property of
      // the APPEND instead, and the argument for the narrow fix is unchanged: the journal
      // records no append boundary, so making the refusal structural means a new field on
      // `JournalEvent`, both stores writing it, and a defined reading for every journal that
      // predates it — a change to the durable format invariant 2 makes authoritative.
      if (isEvent(ev, "gate.timeout") && ev.payload.action === "fail" && ev.seq === atSeq) {
        throw err.conflict(
          CODES.E_RESTORE_ILLEGAL,
          `seq ${atSeq} is the expiry of gate "${ev.payload.gateId}", and the \`run.failed\` it was appended with is at seq ${atSeq + 1}; rewinding to it would keep the expiry and drop the failure, leaving run ${runId} suspended on a gate that can no longer be answered by anyone — rewind to ${atSeq + 1} to keep the expiry, or to ${atSeq - 1} to reopen the gate`,
          { details: { runId, atSeq, gateId: ev.payload.gateId } },
        );
      }
      if (!isEvent(ev, "gate.decided")) continue;
      if (ev.payload.decision === "reject") {
        throw err.conflict(
          CODES.E_RESTORE_ILLEGAL,
          `run ${runId} has a gate a human rejected at seq ${ev.seq}; rewinding past a refusal overrules the person who made it — submit a new run`,
          { details: { runId, atSeq, gateId: ev.payload.gateId, decidedAtSeq: ev.seq } },
        );
      }
      // AND THE SAME BOUNDARY SPLITS AN APPROVAL TOO — the wedge above with the sign
      // flipped, and the reason it is a SEPARATE refusal rather than a wider version of the
      // one above.
      //
      // `resolve` writes `gate.decided` and `run.resumed` in ONE append, which is two seqs.
      // A rewind boundary of exactly the decision's seq keeps the first and drops the second,
      // so the run folds back to `awaiting_gate` with its only gate already `decided`: zero
      // open gates, and `advance` returns immediately on `awaiting_gate` without looking for
      // work. Measured, not reasoned: status `awaiting_gate`, 0 open gates, `advance` a
      // no-op, no task ever re-leased.
      //
      // It differs from the rejection in ONE way, which is why the message differs rather
      // than the rule: this state is recoverable. A second rewind to `atSeq - 1` suppresses
      // the decision as well and the gate comes back open, because the run is not
      // `cancelled` and there is no refusal in range to refuse on. That makes it a wedge an
      // operator can get out of, and refusing here is what keeps them from having to — with
      // the two seqs that DO mean something named in the message, since "rewind to N" and
      // "rewind to N+1" are the two coherent readings of what they asked for.
      //
      // Refusing rather than repairing is deliberate, and it is the same call the arm above
      // makes: the fold cannot re-derive a run's status from its gates — `run.suspended` and
      // `run.resumed` are the only things that carry it — so a projection that healed this
      // would be inventing a transition nobody journaled.
      if (ev.seq === atSeq) {
        throw err.conflict(
          CODES.E_RESTORE_ILLEGAL,
          `seq ${atSeq} is the \`${ev.payload.decision}\` on gate "${ev.payload.gateId}", and the \`run.resumed\` it was appended with is at seq ${atSeq + 1}; rewinding to it would keep the decision and drop the resume, leaving run ${runId} suspended on a gate that is already answered — rewind to ${atSeq + 1} to keep the decision, or to ${atSeq - 1} to ask again`,
          { details: { runId, atSeq, gateId: ev.payload.gateId, decision: ev.payload.decision } },
        );
      }
    }

    // Refuse to rewind past a committed irreversible effect with no compensation —
    // the store must not offer a silently-unsafe undo.
    // WHAT WAS CALLED, in the range being suppressed — not what a node declared.
    //
    // `tool.called` is appended after the body returned, so it is the record that an
    // action really happened, and it carries the class the call ran under. Scanning
    // declared tools instead answers a different question: an `agent` node that merely
    // lists an irreversible tool has not necessarily invoked it, and refusing on the
    // declaration made such a run permanently un-rewindable at every boundary. Scoping to
    // `atSeq` matters for the same reason — only effects the rewind would actually
    // suppress can stand in its way.
    // AND THROUGH ANY CHILD RUN, because a subgraph's work is not in this journal.
    //
    // `subgraph.started` is "the only link between them, which is what keeps a parent's journal
    // the size of the parent rather than of its whole tree" — and that is exactly why a scan of
    // the parent's own log answers nothing about what a child did. Measured, on the same
    // irreversible uncompensated tool: run it in the parent and the rewind is refused; delegate
    // it to a subgraph and the rewind is ALLOWED, with the money already gone.
    const offending = await this.#uncompensatedIrreversible(ctx.log.read((atSeq + 1) as Seq), runId, 0);
    if (offending !== undefined) {
      const where = offending.runId === runId ? "" : ` in child run ${offending.runId}`;
      throw err.conflict(
        CODES.E_RESTORE_ILLEGAL,
        `cannot rewind to ${atSeq}: "${offending.name}" ran at seq ${offending.seq}${where}, is ` +
          `${offending.irreversibility}, and declares no compensation`,
        { details: { runId, atSeq, seq: offending.seq, tool: offending.name, ranIn: offending.runId } },
      );
    }

    return { p, live, ctx };
  }

  /**
   * The rewind itself, once the chain in `rewind` has this run to itself.
   *
   * Split from `rewind` for the same reason `#advanceSerially` is split from `advance`: the
   * public method owns the per-run chain and nothing else, so the body below may assume it is
   * alone on this run and a reader can see that assumption in one place.
   */
  async #rewindSerially(
    runId: RunId,
    atSeq: Seq,
    reason: string,
    by: HumanActor,
    auth: RewindAuthorization,
  ): Promise<RunProjection> {
    this.#requireHumanRewind(runId, atSeq, by, "rewinding");
    const { p, live, ctx } = await this.#rewindRefusals(runId, atSeq);

    // WHAT THE ROLLBACK WOULD DO, COMPUTED BEFORE ANYTHING IS DONE — and after the refusals
    // above, deliberately. A rewind that is going to be refused must undo NOTHING: unwinding
    // half a run and then declining to rewind it leaves the operator worse off than either
    // answer alone, and they never asked for the half.
    //
    // AND IT IS THE SAME CALL `planRewind` MAKES, which is the whole of A.35. The list the
    // operator authorized and the list about to be dispatched are one function's output read
    // twice, so "they agree" is not a property a test has to establish — the only way they can
    // differ is that the WORLD moved between the two reads, which is exactly what the hash below
    // is for.
    // DESTRUCTURED, AND THE WALK IS WHAT DISPATCHES. The comment above used to say the two
    // lists are "one function's output read twice"; they were one function CALLED twice, and
    // `#compensate` re-planned from a fresh read before dispatching. A reviewer drove the gap:
    // with the undo tool disposed between the hash check and that second plan, the rewind was
    // ACCEPTED and the journaled authorization asserted `pay.refundable->pay.refund` while
    // `compensation.recorded` said `not_attempted, names a compensation that is not a registered
    // tool`. The audit artifact this design exists for was describing a dispatch that did not
    // happen. Threading the hashed walk through makes the claim literal instead of nearly true.
    const { plan: current, walk } = await this.#rewindPlanOf(runId, atSeq, p, live, ctx);

    // THE PLAN THE OPERATOR SAW, OR NOTHING HAPPENS.
    //
    // A MISSING OR UNPARSEABLE HASH FAILS CLOSED — there is no "proceed anyway". `auth` is a
    // required parameter with no default for the reason A.34's `by` has none: a default is how
    // the last floor on this verb came to be checked nowhere, at 34 of 36 call sites.
    //
    // THE REFUSAL NAMES WHAT CHANGED, because "your plan is stale" is not something an operator
    // can act on. The two sets are diffed by the step identity `run/compensation.ts` defines —
    // `runId` plus `seq` — so the message says which effects appeared and which are gone, and a
    // step that merely changed its undo, its arguments or its dispatchability shows up in both
    // lists rather than in neither.
    if (typeof auth?.planHash !== "string" || auth.planHash.length === 0) {
      throw err.validation(
        CODES.E_RESTORE_ILLEGAL,
        `rewinding run ${runId} requires the \`planHash\` of a plan a person was shown: call \`planRewind(runId, ${atSeq}, by)\` and pass its \`planHash\`. ` +
          `Refusing rather than proceeding, because an authorization for a list nobody saw is not one`,
        { details: { runId, atSeq } },
      );
    }
    if (auth.planHash !== current.planHash) {
      const shown = (s: RewindPlanStep): string => `${s.runId}@${String(s.seq)} ${s.tool} -> ${s.undo ?? `(${s.blocked ?? "blocked"})`}`;
      const previous = await this.#planShownAs(runId, auth.planHash);
      const was = new Map((previous ?? []).map((s) => [`${s.runId}@${String(s.seq)}`, s]));
      const now = new Map(current.steps.map((s) => [`${s.runId}@${String(s.seq)}`, s]));
      const added = current.steps.filter((s) => !was.has(`${s.runId}@${String(s.seq)}`)).map(shown);
      const removed = (previous ?? []).filter((s) => !now.has(`${s.runId}@${String(s.seq)}`)).map(shown);
      const what =
        previous === undefined
          ? `this engine has no record of plan ${auth.planHash}, and what it would dispatch now is ${String(current.dispatch)} undo(s): ${current.steps.map(shown).join(", ") || "none"}`
          : [
              added.length === 0 ? undefined : `now also: ${added.join(", ")}`,
              removed.length === 0 ? undefined : `no longer: ${removed.join(", ")}`,
              added.length === 0 && removed.length === 0
                ? `the same steps, changed: ${current.steps.map(shown).join(", ") || "none"}`
                : undefined,
            ]
              .filter((x) => x !== undefined)
              .join("; ");
      throw err.conflict(
        CODES.E_RESTORE_ILLEGAL,
        `the plan authorized for run ${runId} is not what a rewind to ${atSeq} would dispatch now — ${what}. ` +
          `Call \`planRewind\` again and authorize what it returns`,
        { details: { runId, atSeq, authorized: auth.planHash, current: current.planHash } },
      );
    }

    // UNDO WHAT THE REWIND IS ABOUT TO HIDE.
    //
    // A rewind suppresses the RECORD of an effect; it has never touched the effect. That
    // asymmetry is the whole reason the refusal above exists — but the refusal only covers
    // `irreversible` and `externally_visible`, so a `reversible_write` was crossed silently and
    // the file stayed written. `fs.write` declares `fs.restore` for exactly this and nothing had
    // ever called it. Scoped to `atSeq` for the same reason the refusal is: only effects this
    // rewind would actually suppress are its business.
    //
    // BEFORE THE MARKER, NOT AFTER, and the ordering is load-bearing twice over.
    //
    // MEASURED FIRST. Moving this call below the append undoes NOTHING AT ALL — not "less", not
    // "in the wrong order": world `[1, 2]` afterwards, and every step recorded `not_attempted`.
    // The marker is what creates the suppressed range `(atSeq, marker)`, and the undo arguments
    // come from `#completedEffects`, which honours suppression. So the moment the marker exists,
    // every `effect.completed` the rollback needs is hidden and there is no `details` to build an
    // undo from. The rollback has to read the record before the record is taken away.
    //
    // AND THE CRASH CASES AGREE. Undo-then-mark that dies in between leaves a journal that is not
    // rewound and a world partly unwound — the operator's second rewind re-plans, sees the
    // `compensation.recorded` rows, skips them and finishes. Mark-then-undo that dies in between
    // leaves a journal claiming the rewind happened over a world that still holds every effect,
    // and nothing is coming back for it. One is recoverable; the other is a lie.
    //
    // The records therefore land INSIDE what becomes the suppressed range, which is why
    // `planCompensation` reads `compensation.recorded` WITHOUT suppression — a record of an undo
    // is not a thing to be undone, and suppressing it would make the next pass do it all again.
    //
    // A DETACHED RUN CANNOT DISPATCH, SO IT IS REFUSED RATHER THAN CROSSED. `rewind` deliberately
    // works with no `RunContext` — "the runs most worth rewinding are the FINISHED ones" — but a
    // tool call needs the graph, which is not in the journal, only its hash. Rewinding anyway
    // would be the loosening: suppressing effects nothing is going to undo. `attach` is the fix
    // and the message says so.
    //
    // AND THE QUESTION IS "IS THERE ANYTHING TO UNDO ANYWHERE UNDER THIS RUN", NOT "DOES THE
    // PARENT HAVE A STEP OF ITS OWN". This refusal read `planCompensation` over the parent's OWN
    // events, and a parent whose only work was DELEGATED has zero steps of its own — so a
    // detached rewind of a fully-delegated run walked straight past it. Measured on
    // `rewind-through-subgraph`'s delegated leg with `forget(runId)` first: the rewind was
    // ACCEPTED, `charges` stood at `[42]`, and there was no `compensation.recorded` in the
    // parent's journal or the child's saying so. "Nothing to undo" and "an effect stands and
    // nobody will try" were the same answer, which is exactly the silence `b90b137`'s fifth
    // decision forbids — and it is the same asymmetry `#uncompensatedIrreversible` closed for the
    // REFUSAL half one screen above, arriving a third time in the same feature.
    //
    // `current.steps` IS THE TREE, so the fix is to read the walk this method already computed
    // rather than to grow a second descent here. `#planRollback` resolves a context per run, so a
    // step it marks `undispatchable` under a detached parent is one no journal anywhere will
    // record — which is the precise condition for refusing.
    const unrunnable = current.steps.filter((s) => s.undo !== undefined && s.undispatchable !== undefined);
    if (unrunnable.length > 0 && live === undefined) {
      throw err.conflict(
        CODES.E_RESTORE_ILLEGAL,
        `cannot rewind to ${atSeq}: ${String(unrunnable.length)} recorded effect(s) after it declare a ` +
          `compensation (${[...new Set(unrunnable.map((s) => `${s.tool} -> ${String(s.undo)}`))].join(", ")}${
            unrunnable.some((s) => s.runId !== String(runId)) ? `, including in child run(s) ${[...new Set(unrunnable.filter((s) => s.runId !== String(runId)).map((s) => s.runId))].join(", ")}` : ""
          }), and ` +
          `this engine holds no context for run ${runId}, so it cannot run them. Call \`attach(runId, graph)\` first — ` +
          `rewinding without them would hide the record and leave the effects standing`,
        { details: { runId, atSeq, pending: unrunnable.length } },
      );
    }
    // EVERY STEP, NOT ONLY THE DISPATCHABLE ONES, once there is a context: a step nothing can
    // undo still has to be JOURNALED as `not_attempted`, or the three states collapse back to two
    // on this path while holding on the other. A rewind that crosses a `reversible_write` whose
    // tool declares no compensation is exactly the case an operator has to be told about, and it
    // is the case with no `attemptable` step in it.
    //
    // THE ONE REMAINING SILENCE, named rather than implied: a DETACHED run whose steps are ALL
    // BLOCKED journals nothing, because dispatch goes through `#invokeTool` and takes a
    // `RunContext` there is no way to build. The refusal above does not cover it — those steps
    // have no `undo` to be unable to run. It is no longer invisible, because `planRewind` shows
    // them to the operator before they authorize; it is still unwritten afterwards.
    if (live !== undefined) {
      // `walk`, NOT `#compensate` — the walk whose digest the operator authorized, rather than a
      // fresh plan computed after the check. See the destructure above.
      await this.#dispatchRollback(walk, "rewind");
    }

    // THE MARKER AND THE AUTHORIZATION, IN ONE APPEND, IN THAT ORDER.
    //
    // ONE APPEND because a marker without the authorization behind it is a rewind nobody can
    // account for, and `RunLog.append` is the compare-and-swap that makes "both or neither" true.
    //
    // THE MARKER FIRST, which reads backwards and is deliberate. `suppressedRanges` hides
    // `(atSeq, markerSeq)` exclusive at both ends, so anything appended BEFORE the marker and
    // after `atSeq` — the `rewind.plan` rows `planRewind` wrote included — is hidden from every
    // suppression-aware reader, `journal/audit.ts` among them. Putting the authorization above
    // the marker is what keeps the one row that says WHO approved WHAT out of the range it
    // authorized. The `rewind.plan` preview rows are inside it and that is the correct
    // asymmetry: what was merely SHOWN belongs to the history being undone, and what was
    // AUTHORIZED belongs to the run that comes after.
    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "checkpoint.restored",
          payload: { checkpointId: `cp_${atSeq}` as never, mode: "rewind", atSeq, reason },
          actor: by,
        },
        {
          type: "operator.command",
          payload: {
            kind: "rewind",
            args: { atSeq: atSeq as number, reason, planHash: current.planHash, attached: current.attached, dispatch: current.dispatch, blocked: current.blocked, steps: current.steps },
          },
          actor: by,
        },
      ]),
    );
    // A FULL fold, not the incremental one. `#project` advances a live context's cursor, and
    // a rewind has just invalidated everything that cursor knew; `projection` folds from
    // seq 1 and works with or without a context. Rewind is rare by construction, so paying
    // a whole fold here buys the ability to rewind a run this engine no longer holds.
    const rewound = (await this.projection(runId))!;

    // A LEASE THE REWIND UNDID IS NOT A LEASE. The `task.leased` that put a task into `leased`
    // can sit BELOW the checkpoint while the `task.committed` that ended it sits above — so the
    // fold shows a task held by a worker whose work no longer exists, and `#advanceSerially`
    // leases only tasks in state `ready`. The task was therefore never re-run.
    //
    // Measured on a one-node graph with `checkpoint: "before"`, rewinding to its own checkpoint:
    // the task stayed `leased`, `advance` found nothing runnable, walked to `#finish`, and
    // appended a SECOND `run.completed` — reporting `succeeded` with the output channel back at
    // its INPUT value. Not a wedge: a run that says it did the work and did not. Re-arming the
    // lease is what makes `checkpoint: "before"` mean anything, since the checkpoint a node
    // declares lands between its lease and its commit by construction.
    const stranded = Object.values(rewound.tasks).filter((task) => task.state === "leased");
    if (stranded.length === 0) return rewound;

    await this.#serialize(() =>
      ctx.log.append(
        stranded.map((task) => ({
          type: "task.ready" as const,
          payload: {
            nodeId: task.nodeId,
            branchPath: encodeBranch(task.branch),
            edgesIn: [...(task.edgesIn ?? [])],
          },
          actor: SYSTEM_ACTOR("scheduler"),
          taskId: task.taskId,
        })),
      ),
    );
    return (await this.projection(runId))!;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #require(runId: RunId): RunContext {
    const ctx = this.#runs.get(runId);
    if (ctx === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} is not attached`);
    return ctx;
  }

  /**
   * What the journal says this run compiled — the THREE things that identify it.
   *
   * Not one. `graphHash` is `digest(spec)` and `compile.ts` says so in as many words, adding the
   * sentence this method is built on: the manifest "is recorded separately in `run.compiled` so a
   * re-resolve is visible as its own fact rather than as a different graph." A spec is full of
   * POINTERS; the bytes behind them live in `documents`/`subgraphs` and are hashed by nothing. So
   * a run parked on a gate can have its child graph or its system prompt rewritten under it and
   * recompile to a byte-identical hash — reproduced end to end before this existed.
   *
   * The third is the compiled oversight FLOOR. `plans[n].posture` is derived from the registered
   * tools' `irreversibility`, and `graphHash` excludes plans by design, so the same spec compiled
   * in a process with no `--mcp-file` yields the same hash with a node's floor dropped from `in`
   * to `out`. `run.started.posture` is the `max` over `plans` and is journaled, so it is the
   * recorded floor to refuse going below — invariant 5 composes by `max`, never down.
   *
   * Read from the journal rather than the projection because `RunProjection.graphHash` folds
   * `graph.mutated` to the SUCCESSOR hash, so comparing an authored on-disk graph against it
   * refuses every run that ever mutated. `#rehydrateGraph` replays the mutations on top of the
   * authored graph, which is what it is for.
   */
  async #compiledIdentity(
    runId: RunId,
  ): Promise<{ readonly graphHash: string; readonly manifest: string; readonly posture: Posture } | undefined> {
    let graphHash: string | undefined;
    let manifest = "";
    let posture: Posture | undefined;
    for await (const ev of this.#store.read(runId, 1)) {
      if (isEvent(ev, "run.compiled")) {
        graphHash = ev.payload.graphHash;
        manifest = manifestKey(ev.payload.resolutionManifest);
      } else if (isEvent(ev, "run.started")) {
        posture = ev.payload.posture;
      }
      // Everything that identifies the compile is written in the submit append, so there is no
      // reason to fold the whole journal of a long run to find it.
      if (graphHash !== undefined && posture !== undefined) break;
    }
    if (graphHash === undefined) return undefined;
    return { graphHash, manifest, posture: posture ?? "out" };
  }

  /**
   * The attached graph IS the graph this run compiled, or nothing happens.
   *
   * Reproduced before this existed, through the shipped binary: run a graph to its gate, then
   * `loom approve <run> <gate> --graph OTHER.json`, and the other graph's node ran and wrote.
   * The gate authorized one graph and a different one executed. No collision and no race —
   * `--graph` was simply believed.
   *
   * REFUSED, NEVER REPAIRED, and the caller is told which of the three moved. Recompiling a
   * "corrected" graph here would be this engine deciding what a human meant to approve.
   */
  async #assertBound(ctx: RunContext, why: string, opts: { readonly requireRecord: boolean } = { requireRecord: true }): Promise<void> {
    const recorded = await this.#compiledIdentity(ctx.runId);
    // A run with no `run.compiled` cannot be checked, and what to do about that DIFFERS BY DOOR.
    //
    // On a decision door it is a refusal: `replay.ts` treats a missing record as "an older
    // journal, replay what you can", and inheriting that here would mean "unverifiable, so
    // allow". A gate is not the place for that default.
    //
    // On `advance` it is not, because a journal with no compile is a MALFORMED run rather than
    // an unverifiable one, and the executor already diagnoses it far better than this could — a
    // partially-written child log gets "awaiting a gate it does not have", which this refusal
    // preempted with a flat `E_RUN_NOT_FOUND`. Every real run carries `run.compiled` from
    // `submit`, so nothing that could execute reaches the lenient branch.
    if (recorded === undefined) {
      if (!opts.requireRecord) return;
      throw err.notFound(
        CODES.E_RUN_NOT_FOUND,
        `run ${ctx.runId} has no compile on record, so ${why} cannot be bound to a graph`,
        { details: { runId: ctx.runId } },
      );
    }
    // TWO HASHES ARE AUTHORIZED, and binding only the first was a regression that wedged every
    // run that mutates. Both `#applyMutation` and `#rehydrateGraph` REPLACE `ctx.graph` with the
    // successor, so after any mutation `ctx.graph.graphHash` can never equal
    // `run.compiled.graphHash` again — approve became impossible forever, on the designed flow
    // where a mutation introduces an irreversible node and gates it. Reproduced in one process
    // with no attack and no restart.
    //
    // The folded `p.graphHash` is authoritative for that case because only the ENGINE writes
    // `graph.mutated`: a caller cannot forge a successor into the journal. So "the graph the run
    // is currently on" is as recorded a fact as "the graph the run compiled".
    const current = (await this.#project(ctx))?.graphHash;
    const isCompiled = recorded.graphHash === ctx.graph.graphHash;
    const isCurrent = current !== undefined && current === ctx.graph.graphHash;
    const mismatch = !isCompiled && !isCurrent
      ? "spec"
      : // The manifest is journaled on `run.compiled` alone, so it can only be checked against
        // the compiled graph. A successor carries no recorded manifest to compare — an honest
        // gap, narrowed by mutation being unreachable from the shipped binary today.
        isCompiled && recorded.manifest !== manifestKey(ctx.graph.resolutionManifest)
        ? "resources"
        : undefined;
    if (mismatch !== undefined) {
      throw err.conflict(
        CODES.E_GRAPH_MISMATCH,
        mismatch === "spec"
          ? `the graph supplied for ${why} is not the graph run ${ctx.runId} compiled`
          : `the graph supplied for ${why} matches run ${ctx.runId}'s spec, but the resources behind its refs have changed since it was compiled`,
        {
          // REPORT THE PAIR THAT ACTUALLY DIFFERS. On the `resources` branch `isCompiled` is
          // true by construction, so printing the two SPEC hashes printed the same string twice
          // under a message saying they had changed — a diagnostic that reads as a broken check
          // and sends the operator to look at the graph file, which is the one thing that did
          // not change. Found by deleting a published hook body from a workspace with a live
          // gate: "the resources behind its refs have changed", expected == actual.
          details: {
            runId: ctx.runId,
            differs: mismatch,
            ...(mismatch === "resources"
              ? { expected: recorded.manifest, actual: manifestKey(ctx.graph.resolutionManifest) }
              : { expected: recorded.graphHash, actual: ctx.graph.graphHash }),
          },
        },
      );
    }
    // AND THE FLOOR MAY NOT FALL. Same spec, same resources, a process that registered fewer
    // tools: `plans` are excluded from the hash, so the oversight floor drops silently.
    const now = this.#runPosture(ctx.graph);
    if (isLoosening(recorded.posture, now)) {
      throw err.policy(
        CODES.E_GRAPH_MISMATCH,
        `run ${ctx.runId} was compiled under oversight "${recorded.posture}" and this process computes "${now}" for the same graph — ` +
          `usually a tool the original process had registered and this one does not`,
        { details: { runId: ctx.runId, recorded: recorded.posture, computed: now } },
      );
    }
  }

  /**
   * `inherited` is the ceiling a PARENT run already imposed. A child may narrow it further and
   * may never widen it — so the effective list is the child's own filtered by the parent's, and
   * a child that declares nothing simply keeps the parent's.
   *
   * Filtering rather than intersecting patterns: a pattern in the child that the parent does not
   * match is DROPPED, which under-permits rather than over-permits. That is the safe direction
   * and it is the only one available without pattern arithmetic nobody should have to reason
   * about at a security boundary.
   */
  #contextFor(runId: RunId, graph: RunGraph, limits?: BudgetLimits, inherited?: readonly string[]): RunContext {
    const existing = this.#runs.get(runId);
    if (existing !== undefined) return existing;
    const own = graph.spec.policy?.capabilities;
    const grantBound =
      own === undefined
        ? inherited
        : inherited === undefined
          ? own
          : own.filter((c) => inherited.some((p) => (p.endsWith("*") ? c.startsWith(p.slice(0, -1)) : p === c)));
    const ctx: RunContext = {
      runId,
      graph,
      grantBound,
      index: indexGraph(graph.spec),
      log: new RunLog(runId, {
        store: this.#store,
        now: this.#now,
        ...(this.#bus === undefined ? {} : { bus: this.#bus }),
      }),
      policy: new PolicyEngine({
        ...this.#policyOpts,
        ...(grantBound === undefined ? {} : { allowlist: grantBound }),
        // MERGED OVER the deployment's own limits, never replacing them: `submit` has already
        // min-folded each dimension against `#policyOpts.budget`, so a key present here is a
        // ceiling that is at most the operator's. A dimension the fold left undefined is absent
        // from `limits` entirely and the deployment's own number survives the spread.
        ...(limits === undefined ? {} : { budget: { ...this.#policyOpts.budget, ...limits } }),
        onEscalate: (rule, from, to, scope, detail) => {
          ctx.escalationWrites.push(
            this.#serialize(() =>
              ctx.log.append([
                {
                  type: "policy.escalated",
                  // Built conditionally: `exactOptionalPropertyTypes` is on, so an explicit
                  // `detail: undefined` is not the same shape as an absent one.
                  payload: { rule, from, to, scope, ...(detail === undefined ? {} : { detail }) },
                  actor: SYSTEM_ACTOR("policy"),
                },
              ]),
            ),
          );
        },
      }),
      abort: new AbortController(),
      exprCache: new Map(),
      addedNodes: 0,
      folder: new RunFolder(),
      streaks: new FailureStreaks(),
      tainted: new Set(),
      carriesSecret: new Set(),
      waveTaint: new Map(),
      toolCalls: new Map(),
      warnedBudget: false,
      escalationWrites: [],
      policySeeded: false,
      leases: new Map(),
    };
    this.#runs.set(runId, ctx);
    return ctx;
  }

  /**
   * Rebuild a mutated graph from the journal.
   *
   * A caller re-attaches the AUTHORED graph — it is what it has on disk. If this run
   * previously adopted mutations, the in-memory graph is behind the journal, and every
   * derived thing (plans, entry nodes, `maxInstances`) would be computed from the wrong
   * spec. Replaying the recorded specs through the same compiler restores it, and a
   * hash mismatch after replay is a genuine divergence rather than something to paper
   * over.
   */
  async #rehydrateGraph(ctx: RunContext): Promise<void> {
    const nodes: NodeSpec[] = [];
    const edges: EdgeSpec[] = [];
    let target: string | undefined;
    let consumed = 0;
    for await (const e of ctx.log.read(1)) {
      if (!isEvent(e, "graph.mutated")) continue;
      nodes.push(...e.payload.nodes);
      edges.push(...e.payload.edges);
      consumed += e.payload.nodes.length;
      target = e.payload.newHash;
    }
    if (target === undefined || target === ctx.graph.graphHash) return;

    const result = compile({
      spec: { ...ctx.graph.spec, nodes: [...ctx.graph.spec.nodes, ...nodes], edges: [...ctx.graph.spec.edges, ...edges] },
      // What this run already froze, then the live store for anything the mutation ADDED.
      //
      // ONCE PER ATTACH, not once per turn: the early return above skips this whenever the
      // in-memory graph already matches the journal's target, so within a process it recompiles
      // when a run is picked up behind its own history. That is the case that matters — a
      // second process replaying another's mutations against a store that has since moved.
      resolver: frozenFirst(ctx.graph, this.#resolver),
      tools: this.tools.manifests(),
      tenantCapabilities: this.#policyOpts.granted,
    });
    if (!result.ok || result.graph.graphHash !== target) {
      throw err.internal(
        CODES.E_REPLAY_DIVERGENCE,
        `run ${ctx.runId} recorded graph ${target} but replaying its mutations produced ${result.ok ? result.graph.graphHash : "a compile error"}`,
      );
    }
    ctx.graph = result.graph;
    ctx.index = indexGraph(result.graph.spec);
    ctx.addedNodes = consumed;
  }

  #runPosture(graph: RunGraph): Posture {
    return maxPosture(
      this.#policyOpts.systemFloor ?? "out",
      graph.spec.policy?.posture ?? "out",
      ...Object.values(graph.plans).map((p) => p.posture),
    );
  }

  /**
   * The run's projection, folded INCREMENTALLY.
   *
   * This is called once per task and again per commit, so re-reading the whole journal
   * each time made a run quadratic in its own history — the dominant cost of a wide
   * fan-out, where the journal is longest exactly when there is most left to do. The
   * folder keeps the mutable state and consumes only the tail.
   */
  async #project(ctx: RunContext): Promise<RunProjection | undefined> {
    const events = [];
    for await (const e of ctx.log.read(ctx.folder.lastSeq + 1)) events.push(e);
    ctx.folder.push(events);
    // A rewind invalidates everything already folded, so the fold starts over from seq 1 —
    // through `restart()`, which keeps what the marker declared. Replacing the folder
    // instead threw that away, so the next call met the same marker and re-read the whole
    // journal again: correct, because it fell back to `foldRun`, and permanent, because the
    // cursor never got past the marker. Rare by construction; now rare in cost too.
    //
    // `reached` is the same livelock refusal `GateSweeper.#catchUp` carries, for the same
    // reason: each pass stops at the first marker it has not been told about, so each pass
    // must get strictly further, and a loop that assumes that rather than checking it spins
    // forever the day it stops being true.
    let reached = -1;
    while (ctx.folder.stale) {
      if (ctx.folder.lastSeq <= reached) {
        throw err.internal(
          CODES.E_TRACE_INCONSISTENT,
          `run ${ctx.runId} did not fold past its rewind marker at seq ${ctx.folder.lastSeq + 1} on a second pass`,
          { details: { runId: ctx.runId, lastSeq: ctx.folder.lastSeq } },
        );
      }
      reached = ctx.folder.lastSeq;
      ctx.folder.restart();
      const all = [];
      for await (const e of ctx.log.read(1)) all.push(e);
      ctx.folder.push(all);
    }
    return ctx.folder.projection();
  }

  /** Every journal write goes through here, one at a time, in submission order. */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#commitChain.then(fn, fn);
    // Swallow on the chain so one failed commit does not poison every later one;
    // the caller still sees the rejection through `next`.
    this.#commitChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #runWave(ctx: RunContext, wave: readonly Wave[]): Promise<void> {
    // WHAT THIS WAVE IS ABOUT TO TAINT, before anything in it decides. Commits happen after
    // every task in the wave has run, so without this a node sharing a wave with its tainter
    // decides on a set that is one commit out of date — reachable by deleting an edge.
    ctx.waveTaint = waveTaintFor(wave);
    try {
      await this.#runWaveInner(ctx, wave);
    } finally {
      // Cleared rather than left, and DEFENSIVELY rather than load-bearingly: the map is keyed
      // by TaskId, so a stale overlay reaches only a task with the SAME id in a later wave —
      // which is a RETRY and nothing else. Said plainly because the first version of this
      // comment claimed it stopped the next wave being tainted "with channels nobody in it
      // writes", and a mutation showed no test could tell the difference. A guard whose reason
      // is overstated is one somebody deletes later on a correct-sounding argument.
      ctx.waveTaint = new Map();
    }
  }

  async #runWaveInner(ctx: RunContext, wave: readonly Wave[]): Promise<void> {
    // Work in parallel …
    const outcomes = await Promise.all(
      wave.map(async (w) => {
        // THE TOKEN IS THE SEQ OF THE LEASE ITSELF.
        //
        // `#fencing` was a per-process counter, which cannot fence anything across
        // processes: a second worker starts at 1 and loses to the first's `max_token`, so
        // arming it as-was would raise `E_FENCING_STALE` at the LEGITIMATE worker. The
        // journal's seq is the only monotonic source every process already shares — the
        // store's compare-and-set assigns it — so the lease's own seq is the token, and a
        // re-lease by another worker necessarily gets a higher one.
        const leasedAt = await this.#serialize(() =>
          ctx.log.append(
            [
              {
                type: "task.leased",
                payload: { workerId: this.#workerId, attempt: w.task.attempt + 1 },
                actor: SYSTEM_ACTOR("scheduler"),
                taskId: w.task.taskId,
              },
            ],
            { taskId: w.task.taskId },
          ),
        );
        ctx.leases.set(w.task.taskId, leasedAt);
        try {
          return { w, outcome: await this.#executeTask(ctx, w) };
        } catch (e) {
          const le = toLoomError(e);
          return {
            w,
            outcome: { status: "failed", writes: {}, usage: { ...ZERO_USAGE }, error: le } as NodeOutcome,
          };
        }
      }),
    );

    // … commits serialized, in a deterministic order.
    const ordered = [...outcomes].sort((a, b) => compareBranch(a.w.task.branch, b.w.task.branch));
    for (const { w, outcome } of ordered) {
      await this.#serialize(() => this.#commit(ctx, w, outcome));
    }
  }

  // ── node execution ────────────────────────────────────────────────────────

  /**
   * Fetch every externalised channel this node can observe, before anything looks at one.
   *
   * THIS IS THE HALF THAT LETS `foldRun` STAY PURE. The fold puts a handle in the projection
   * and does no I/O; the value only ever appears here, in an async method, and only for the
   * channels the graph says this node reaches. A body still calls `view.get(...)` and still
   * gets a plain value synchronously.
   *
   * `observedChannels`, NOT `node.reads`, and it is the same one-word correction `#gatePayload`
   * and `dataClassification` already carry: a `tool` node's arguments are resolved against the
   * whole scope, so a channel named only in `tool.args` reaches the tool while being absent
   * from `reads`. Resolving `reads` alone would have handed such a tool `{$payload: ...}` as its
   * argument. The two remaining ways a channel is read without appearing here — an expression's
   * free variables and a `subgraph` node's delegated inputs — are not resolved but CANNOT BE
   * HANDLES: `externalisableChannels` removes both from the eligible set at the other end.
   *
   * NO STORE PLUS A HANDLE IS A REFUSAL, never a fallback. It means this process is attached to
   * a journal written by one that had a payload store, so the values this run needs exist and
   * are simply not reachable from here. Handing the node the handle would let it succeed on the
   * wrong value; `E_PAYLOAD_UNRESOLVED` is run-fatal, so no error edge routes around it.
   */
  async #resolveReads(ctx: RunContext, p: RunProjection, w: Wave): Promise<RunProjection> {
    const need = observedChannels(w.node).filter((c) => p.external[c] !== undefined);
    if (need.length === 0) return p;
    const store = this.#payloads;
    if (store === undefined) {
      throw err.internal(
        CODES.E_PAYLOAD_UNRESOLVED,
        `node "${w.node.id}" reads ${need.map((c) => `"${c}"`).join(", ")}, whose ${
          need.length === 1 ? "value was" : "values were"
        } externalised by the process that wrote this journal — this engine was constructed with no \`payloads\` store`,
        { details: { nodeId: w.node.id, taskId: w.task.taskId, channels: need } },
      );
    }
    const resolved: Record<string, unknown> = {};
    for (const c of need) resolved[c] = await store.get(ctx.runId, p.external[c]!);
    return withResolved(p, w.task.branch, resolved);
  }

  /**
   * Move the values in `writes` that are too big and eligible out of the journal.
   *
   * THE THRESHOLD IS MEASURED ON THE CANONICAL TEXT, which is the same text `journal/store.ts`
   * weighs against its 8 MiB refusal and the same text the digest is taken over — so "the size
   * that decided" and "the size recorded in the ref" are one number, and a value cannot be
   * externalised under one measurement and refused under another.
   *
   * STRICTLY ABOVE the threshold: at exactly `EXTERNALISE_ABOVE_BYTES` the value stays inline,
   * because the handle that would replace it costs ~110 bytes plus a round trip on every read,
   * and swapping a 64 KiB value for that is a saving; swapping a 200-byte one for it is a loss
   * in both bytes and reads. `boundedPayload` draws its own boundary the same way (`<=` passes).
   *
   * A FAILED `put` IS NOT SWALLOWED. It propagates, the Task fails, and the journal records the
   * failure — which is the only honest outcome, because the alternative is to journal a handle
   * whose bytes were never stored and discover it at the next read.
   */
  async #externalise(ctx: RunContext, values: Readonly<Record<string, unknown>>): Promise<Externalised> {
    const store = this.#payloads;
    if (store === undefined) return { values: { ...values }, projected: { ...values } };
    const eligible = externalisableChannels(ctx.graph);
    const kept: Record<string, unknown> = {};
    const external: Record<string, PayloadRef> = {};
    for (const [channel, value] of Object.entries(values)) {
      if (!eligible.has(channel)) {
        kept[channel] = value;
        continue;
      }
      const canonical = canonicalize(value);
      if (refFor(canonical).bytes <= EXTERNALISE_ABOVE_BYTES) {
        kept[channel] = value;
        continue;
      }
      external[channel] = await store.put(ctx.runId, canonical);
    }
    // `projected` is what the FOLD will build from these two maps, computed here so the state
    // hashes this commit journals are hashes of the projection a reader will actually
    // reconstruct — see `state.reduced.external`. Built by the same `payloadHandle` the fold
    // uses, rather than by a second copy of the shape.
    const projected = { ...kept };
    for (const [channel, ref] of Object.entries(external)) projected[channel] = payloadHandle(ref);
    return Object.keys(external).length === 0
      ? { values: kept, projected }
      : { values: kept, external, projected };
  }

  async #executeTask(ctx: RunContext, w: Wave): Promise<NodeOutcome> {
    // HERE, AND ONLY HERE, is where a handle becomes a value. Everything downstream of this
    // line — the policy decision, the gate payload a human reads, the gate BINDING that
    // decision is compared against, `#dispatch` and every node body it reaches — takes `p`
    // from this variable, so all of them see one projection and cannot disagree about whether
    // a channel is a byte string or a reference to one. Resolving inside `#dispatch` instead
    // was the version that did not work: the gate raised at line ~2650 would have bound a
    // digest computed over handles and `#approvalStillCovers` would have re-derived it over
    // values, so every approved task would have failed as "no longer the one this task would
    // execute".
    const p = await this.#resolveReads(ctx, (await this.#project(ctx))!, w);
    const { node, task } = w;
    const spec = ctx.graph.spec;

    // A gate already decided for THIS Task short-circuits policy: re-gating an
    // approved Task would loop forever, and re-asking a human who already answered
    // is the fastest way to make in-the-loop unusable.
    const settled = lastDecidedGate(p, task.taskId);
    if (settled !== undefined) {
      // A MIRROR'S DECISION IS NOT THE PARENT'S TO APPLY ALONE — it answers a gate in
      // another run, and that run is still suspended waiting for it. Dispatching for
      // every decision, not only `approve`, is what makes the forward reachable; the
      // short-circuit below is why `#forwardGateDecision`'s rejection branch was dead
      // code and why every rejected delegation leaked a suspended child. `#runSubgraph`
      // forwards first and then produces the parent's outcome from what the child did.
      if (settled.mirrorOf !== undefined) return this.#dispatch(ctx, p, w);

      // APPROVE ON A WORK NODE MEANS "GO AHEAD", NOT "CONSIDER IT DONE". A `human_gate`
      // node is its own approval, so approving completes it; every other node type has
      // work behind the gate, and treating approval as completion would report success
      // for an action that never happened — silently, in exactly the place oversight
      // exists for. `reject`, `edit`, and `redirect` all resolve WITHOUT executing:
      // each is the human substituting their own outcome for the node's.
      if (node.type === "human_gate" || settled.decision !== "approve") {
        return this.#applyGateDecision(settled, node, ctx.graph.plans[node.id]?.outboundEdges ?? []);
      }
      const stale = this.#approvalStillCovers(ctx, p, node, task, settled);
      if (stale !== undefined) return stale;
      return this.#dispatch(ctx, p, w);
    }

    // E8. A channel a tool wrote carries output from outside the system, and feeding that
    // into a hard-to-undo action is the prompt-injection path. The bit was already being
    // computed and passed; what was missing is the FIRING SITE every other rule in D7.7's
    // table has. Raised before the decision it must bind, not at commit like E4/E5, because the
    // evidence is an upstream task's committed writes — durable, and re-folded into `ctx.tainted`
    // at attach, so a fresh process reaches the same answer.
    // `escalate` is idempotent on re-raise, so a node decided repeatedly journals one event.
    const irreversibility = this.#irreversibilityOf(node);
    const tainted = observedChannels(node).some((r) => taintedFor(ctx, w.task.taskId, r));
    if (tainted && isHardToUndo(irreversibility)) {
      this.#escalate(ctx, "taint", node.id, {
        reads: observedChannels(node).filter((r) => taintedFor(ctx, w.task.taskId, r)),
      });
    }

    const decision = ctx.policy.decide({
      runId: ctx.runId,
      nodeId: node.id,
      taskId: task.taskId,
      kind: node.tool === undefined ? "node" : "tool",
      irreversibility,
      capabilities: this.#capabilitiesOf(node),
      declaredPosture: ctx.graph.plans[node.id]?.posture ?? "out",
      // OBSERVED, NOT DECLARED. Reading the classification off `node.reads` was the taint
      // bypass one field over: a channel declared `secret_ref` (floor `in`) interpolated into
      // a tool's arguments but left out of `reads` lost its floor entirely. Measured — the
      // gate disappeared and the tool received the secret.
      dataClassification: [classificationOf(spec.channels, [...observedChannels(node), ...(node.writes ?? [])])],
      tainted,
      // The confidentiality half of the same question `tainted` asks: is this action reading
      // something sensitive that the graph does not say it reads?
      carriesSecret: observedChannels(node).some((c) => ctx.carriesSecret.has(c)),
    });

    await this.#serialize(() =>
      ctx.log.append(
        [
          {
            type: "policy.decided",
            payload: {
              effect: decision.effect,
              posture: decision.effect === "deny" ? "in" : decision.posture,
              irreversibility: irreversibility,
              reasons: decision.reasons,
            },
            actor: SYSTEM_ACTOR("policy"),
            taskId: task.taskId,
          },
        ],
        { taskId: task.taskId },
      ),
    );

    if (decision.effect === "deny") {
      // E6. A refused capability is not just this Task's problem: something in this run
      // tried to do what it was not allowed to, and the rest of the run deserves a human.
      this.#escalate(ctx, "violation", node.id, { capability: decision.error.details });
      return { status: "failed", writes: {}, usage: { ...ZERO_USAGE }, error: decision.error };
    }
    if (decision.effect === "allow" && decision.holdMs > 0) {
      // The pre-irreversible hold (D4 deviation 5). Without it, "the supervisor may
      // interrupt" is a promise the system cannot keep — by the time a human sees the
      // action in a stream it has already happened.
      await this.#serialize(() =>
        ctx.log.append(
          [
            {
              type: "action.pending",
              payload: {
                nodeId: node.id,
                irreversibility: irreversibility,
                windowMs: decision.holdMs,
                ...(node.tool === undefined ? {} : { toolName: node.tool.name }),
              },
              actor: SYSTEM_ACTOR("policy"),
              taskId: task.taskId,
            },
          ],
          { taskId: task.taskId },
        ),
      );
      await this.#sleep(decision.holdMs, ctx.abort.signal);
      // An interrupt during the window means the effect NEVER STARTS — which is the
      // entire difference between an interruption window and a notification.
      if (ctx.abort.signal.aborted) {
        // E9. The operator watched and stopped it — that judgement applies to whatever
        // this run does next, not only to the action they caught.
        this.#escalate(ctx, "operator", node.id);
        return { status: "failed", writes: {}, usage: { ...ZERO_USAGE }, error: err.cancelled("interrupted during the intervention window") };
      }
    }

    if (decision.effect === "gate") {
      const refused = sodOn(node, p);
      if (refused !== undefined) return refused;
      return {
        status: "gate",
        writes: {},
        usage: { ...ZERO_USAGE },
        gate: {
          policyRef: node.humanGate?.ref ?? `policy:${node.id}`,
          payload: this.#gatePayload(ctx, p, node, task),
          binding: this.#gateBinding(ctx, p, node, task),
          auth: gateAuthorizationOf(node, p),
          schedule: scheduleOf(node),
        },
      };
    }

    return this.#dispatch(ctx, p, w);
  }

  /** Run the node body. Reached once policy has allowed it — or a human has. */
  /**
   * THE single point every node outcome passes through, and therefore where writes are
   * confined to what the node declared.
   *
   * `node.writes` is not a hint. The compiler spends its analysis on it: GRAPH010 refuses
   * two concurrent writers to a non-commutative channel, the posture floor is a `max` over
   * what a node can reach, and `dataClassification` is derived from the union of reads and
   * writes. Every one of those verdicts is computed over the DECLARED set, so a runtime
   * that lets a node write outside it does not merely surprise the author — it makes each
   * of those verdicts unearned, because the analysis proved something about a set the
   * runtime was not enforcing.
   *
   * It was enforced in two of four places. The tool path filters through `mapToolWrites`
   * and the agent path never supplies explicit keys, so both were confined; `#runFunction`
   * and `#runEvaluator` each returned `{ ...(out.writes ?? {}) }` raw. Measured: a
   * `function` node declaring `writes: ["mine"]` returned `{mine, secret}` and `secret`
   * was committed.
   *
   * Confining HERE rather than at those two sites is the same argument invariant 6 makes
   * about `#invokeTool`: a check applied per-caller is a check that the next node type
   * forgets. A future body cannot opt out of this one without editing the wrapper.
   */
  /**
   * `NodeSpec.timeoutMs`, which was in the schema and enforced by nothing.
   *
   * `grep -an timeoutMs` over the executor and the scheduler returned NO MATCHES: a node could
   * declare a two-minute limit and a hanging tool held its Task forever. `builtin/authoring.ts`
   * sets `timeoutMs: 120_000` and got nothing for it, and `E_TASK_TIMEOUT` sat in the test
   * suite's `NEVER_RAISED` list — a declared code with no thrower.
   *
   * HERE, WRAPPING `#dispatchBody`, for the reason its sibling `#dispatch` already gives about
   * undeclared writes: "a check applied per-caller is a check that the next node type forgets."
   * One wrapper covers agent, tool, function, router, join, evaluator, subgraph and gate at once,
   * and a future node type cannot opt out without editing it.
   *
   * WHAT THIS DOES AND DOES NOT DO. The Task fails on time — that is the contract `timeoutMs`
   * offers and the one "a hanging tool hangs the task forever" complains about. The BODY is not
   * cancelled: it keeps running against an outcome nobody will read, exactly as
   * `ControlPlane.#withDeadline` says of its own handlers, because injected code that ignores a
   * signal cannot be stopped from outside.
   *
   * The composed signal is built and aborted here so the cooperative half can be threaded next —
   * a model stream, `runSandboxed` and `net.fetch` all already take one, and each `#run*` method
   * would have to accept it instead of reading `ctx.abort.signal`. Left out of this change
   * deliberately: it touches every node type, and the race is what makes the deadline REAL.
   */
  async #withNodeDeadline(
    ctx: RunContext,
    w: Wave,
    body: () => Promise<NodeOutcome> | NodeOutcome,
  ): Promise<NodeOutcome> {
    // THE COMPILED DEADLINE, NOT THE AUTHORED ONE — the same correction `#retryDecision` makes
    // two thousand lines down, and for the same defect. This read `w.node.timeoutMs`, so a node
    // whose author declared nothing had no deadline: measured, a one-`tool`-node graph with no
    // declaration left `Engine.advance` unsettled at 1,500 ms and would never have settled.
    // `plans[id].timeoutMs` is `node.timeoutMs ?? <default for the type>`, so the `??` here is
    // not a second policy — it is the graph-from-an-older-build case `#runSubgraph` guards the
    // same way.
    const ms = ctx.graph.plans[w.node.id]?.timeoutMs ?? w.node.timeoutMs;
    if (ms === undefined) return body();

    const timer = new AbortController();
    const onRunAbort = (): void => timer.abort(ctx.abort.signal.reason);
    ctx.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    // NOT `unref`'d, and the difference from every other timer in this codebase is the point.
    // A gate clock or a request deadline is background work that must not hold a process open;
    // THIS timer is the thing that produces the Task's outcome. An unref'd timer does not keep the
    // event loop alive, and neither does a body that never settles — so when a hanging node is a
    // process's only pending work, node exits before the deadline can fire. Measured on the exact
    // shape: `Promise.race([never, unrefTimeout(300)])` printed nothing and exited **13**
    // ("unsettled top-level await"); the same race with a ref'd timer caught the deadline and
    // exited 0. That is `loom run` on a graph with one hanging node, dying silently.
    //
    // THE SUITE DOES NOT PIN THIS, and the comment says so rather than implying otherwise:
    // `node --test` keeps the loop alive on its own, so `node-timeout.test.ts` passes with the
    // `unref` restored — measured. It was found because the test hung for an unrelated reason
    // (releasing the fixture's tool before `execute` had assigned the release), and looking at
    // the timer to explain that turned up a defect the hang was not evidence of.
    //
    // It cannot outlive the node: `clearTimeout` is in the `finally` below.
    const handle = setTimeout(() => timer.abort(), ms);
    try {
      return await Promise.race([
        Promise.resolve(body()),
        new Promise<NodeOutcome>((_resolve, reject) => {
          timer.signal.addEventListener(
            "abort",
            () => {
              // A RUN-LEVEL CANCEL IS NOT A TIMEOUT, and reporting one as the other would tell an
              // operator their node was too slow when in fact they stopped it.
              if (ctx.abort.signal.aborted) return;
              reject(
                err.timeout(CODES.E_TASK_TIMEOUT, `node "${w.node.id}" exceeded its timeoutMs of ${ms}ms`, {
                  details: { node: w.node.id, timeoutMs: ms },
                }),
              );
            },
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(handle);
      ctx.abort.signal.removeEventListener("abort", onRunAbort);
    }
  }

  /**
   * A `take` naming an edge that does not leave this node, as a failed outcome.
   *
   * Failed rather than thrown: the redirect path this mirrors returns a failed `NodeOutcome`, so
   * the refusal is journaled as the Task's error and the run ends the way every other node-level
   * refusal ends. Throwing from `#edgesToTake` — which is called from inside `#commit` — rejected
   * `advance` instead, leaving the caller with an exception where a run projection belonged.
   */
  #strayRoute(ctx: RunContext, w: Wave, outcome: NodeOutcome): NodeOutcome | undefined {
    if (outcome.take === undefined) return undefined;
    const outbound = (ctx.index.outbound.get(w.node.id) ?? []).map((e) => e.id);
    const invented = outcome.take.filter((id) => !outbound.includes(id));
    if (invented.length === 0) return undefined;
    return {
      status: "failed",
      writes: {},
      usage: outcome.usage,
      error: err.policy(
        CODES.E_ROUTE_INVALID,
        `node "${w.node.id}" selected ${invented.map((i) => `"${i}"`).join(", ")}, which ${
          invented.length === 1 ? "is not an outgoing edge" : "are not outgoing edges"
        } of it — a node may only route along its own edges`,
        { details: { node: w.node.id, take: outcome.take, declared: outbound } },
      ),
    };
  }

  async #dispatch(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    // `preNode` — BEFORE the deadline wrapper, because a skip should cost nothing, and AFTER the
    // policy decision in `#executeTask`, because a node that policy gated must still gate. The
    // canonical use is memoisation: recognise the work is already done, skip the body, supply the
    // answer. That is strictly less action — no model call, no tool, no spend.
    const skipped = await this.#preNode(ctx, w);
    if (skipped !== undefined) return skipped;

    const body = await this.#withNodeDeadline(ctx, w, () => this.#dispatchBody(ctx, p, w));

    // AN OPERATOR'S ROUTE REPLACES THE NODE'S OWN, and it is applied HERE rather than at commit
    // so that it falls under the stray-edge check below like every other producer's `take`.
    // `Engine.steer` already refused an edge that does not leave this node; this side is what
    // holds for a journal that was not written by `steer` — a hand-appended `operator.command`,
    // or one from a build whose graph had an edge this one does not.
    //
    // SUCCEEDED ONLY. A failed node routes along its `error` edges, and an operator who chose
    // a route for the successful case did not thereby choose one for the failure — overriding
    // there would send a failure down a path written for an answer.
    // AN OWN PROPERTY, NEVER `Object.prototype`'s. A node legitimately named `constructor` or
    // `toString` would otherwise read back a FUNCTION from the empty steer map and route on it —
    // an operator override nobody issued, on the one node whose name made it up.
    const steer = Object.prototype.hasOwnProperty.call(p.steers, w.node.id) ? p.steers[w.node.id] : undefined;
    const outcome =
      steer === undefined || body.status !== "succeeded" ? body : { ...body, take: steer };

    // AN UNDECLARED ROUTE IS THE SAME CLASS AS AN UNDECLARED WRITE, and this wrapper is where
    // that class is refused — for the reason the check below already gives: "a check applied
    // per-caller is a check that the next node type forgets."
    //
    // `#activate` looks an edge id up in the WHOLE graph's edge table, so a `take` naming an edge
    // belonging to another node activated that node's target and jumped everything between — a
    // HUMAN GATE included. Reproduced through the shipped binary on a graph that compiled `ok`: a
    // router case naming the gate's outbound edge ran the guarded `fs.write` with no gate raised,
    // `"status": "succeeded"`, exit 0; a `function` body returning the same `take` — from a
    // resource file the compiler cannot see — did it too, and `loom trace` said `conformance: ok`.
    //
    // The rule already existed for the THIRD producer: `#applyGateDecision` validates a human's
    // `redirect` against the node's outbound edges, and its comment describes this exact bug. The
    // router and function producers never got it. `rule005RouterEdges` now refuses the static
    // half at compile; this is the half no static check can reach.
    const strayEdge = this.#strayRoute(ctx, w, outcome);
    if (strayEdge !== undefined) return strayEdge;

    const declared = new Set(w.node.writes ?? []);
    const stray = Object.keys(outcome.writes).filter((c) => !declared.has(c));
    if (stray.length === 0) return outcome;

    // REFUSED, not dropped. Dropping leaves a node body that believes it wrote and a
    // journal that disagrees — the silent divergence class that is hardest to diagnose
    // later. A `function` body is trusted, reviewed, pinned code (A13), so an undeclared
    // write is a defect in the graph or the body, and naming it is the useful answer.
    return {
      status: "failed",
      writes: {},
      usage: outcome.usage,
      error: err.validation(
        CODES.E_GRAPH_INVALID,
        `node "${w.node.id}" wrote ${stray.map((c) => `"${c}"`).join(", ")}, which it did not declare in \`writes\`` +
          ` (declared: ${(w.node.writes ?? []).map((c) => `"${c}"`).join(", ") || "none"})`,
        { details: { node: w.node.id, stray, declared: [...declared] } },
      ),
    };
  }

  #dispatchBody(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> | NodeOutcome {
    switch (w.node.type) {
      case "function":
        return this.#runFunction(ctx, p, w);
      case "router":
        return this.#runRouter(ctx, p, w);
      // A join has no body. Its whole job is the fold, and the fold happens at commit
      // against a fresh projection — see `#foldJoin`.
      case "join":
        return { status: "succeeded", writes: {}, usage: { ...ZERO_USAGE } };
      case "tool":
        return this.#runToolNode(ctx, p, w);
      case "agent":
        return this.#runAgent(ctx, p, w);
      case "evaluator":
        return this.#runEvaluator(ctx, p, w);
      case "human_gate": {
        // Reached only when policy did not already gate — i.e. never, since a
        // human_gate node's posture is `in` by definition. Kept explicit so a
        // future posture change cannot silently skip the gate.
        const refused = sodOn(w.node, p);
        if (refused !== undefined) return refused;
        return {
          status: "gate",
          writes: {},
          usage: { ...ZERO_USAGE },
          gate: {
            policyRef: w.node.humanGate?.ref ?? "",
            payload: this.#gatePayload(ctx, p, w.node, w.task),
            binding: this.#gateBinding(ctx, p, w.node, w.task),
            auth: gateAuthorizationOf(w.node, p),
            schedule: scheduleOf(w.node),
          },
        };
      }
      case "subgraph":
        return this.#runSubgraph(ctx, p, w);
    }
  }

  /**
   * DOES THE APPROVAL ON FILE STILL COVER WHAT THIS TASK IS ABOUT TO DO?
   *
   * The check the whole oversight layer was missing. An approval bound the graph and the Task;
   * it never bound the ARGUMENTS, so anything that wrote a channel the gated node reads between
   * the raise and the dispatch changed what ran — and `openGates` went on serving the raise-time
   * payload under an unchanged digest, so the console kept showing the old question. Measured
   * before this method existed, on a graph whose only extra node was an ordinary same-wave
   * `function`: shown `state={"target":"SAFE"}`, tool received `body="EVIL"`, run `succeeded`.
   *
   * WHAT IT COVERS, named rather than claimed total: every gate this Engine raised for a node's
   * own execution — the policy `gate` effect on `function`, `agent`, `evaluator`, `router`,
   * `tool` and `subgraph` nodes. It does NOT cover a `human_gate` node (approving one completes
   * it; nothing is dispatched, so there is no payload to drift) and it does NOT cover a MIRROR,
   * which returns above: a mirror's payload is another run's channel state and cannot be
   * re-derived here. That is not a hole — the child raises its own gate on the node that
   * actually executes, and this same check runs there, in the child.
   *
   * A MISMATCH FAILS THE TASK. IT DOES NOT RE-RAISE, and the alternative was real: re-raising
   * would show the human the new payload, which is the friendlier behaviour and the wrong one.
   *
   *   - It hands whoever can write the channel an unbounded supply of fresh approval requests
   *     aimed at a human. Approval fatigue as an attack, with the run alive throughout.
   *   - The second gate looks exactly like a first gate. Nothing the approver sees says an
   *     earlier approval was just voided, and the one person deciding is the one not reading
   *     the journal.
   *   - It is the choice this file already makes next door. `#applyGateDecision` fails the Task
   *     on a decision it cannot read rather than manufacturing a human's answer; the system does
   *     not get to invent the second half of a conversation either.
   *
   * `E_GATE_REQUIRED`, so it is RUN-fatal rather than task-fatal, for the reason `sodOn` gives
   * one screen down and `RUN_FATAL_CODES` gives at the top: an ordinary failed Task takes an
   * `error` edge, and a join with `onBranchError: "skip"` absorbs it into a run that reports
   * **succeeded**. A guard on the approval path that an error edge can route around is not a
   * guard. Re-approving is then a deliberate human act through `rewind`, which is what it
   * should cost.
   */
  #approvalStillCovers(
    ctx: RunContext,
    p: RunProjection,
    node: NodeSpec,
    task: TaskRecord,
    gate: GateRecord,
  ): NodeOutcome | undefined {
    const now = digest(this.#gateBinding(ctx, p, node, task));
    if (now === gate.contentDigest) return undefined;
    return {
      status: "failed",
      writes: {},
      usage: { ...ZERO_USAGE },
      error: err.policy(
        CODES.E_GATE_REQUIRED,
        `gate "${gate.gateId}" approved a payload for node "${node.id}" that is no longer the one this task would execute — ` +
          `it was approved at ${gate.contentDigest} and now derives ${now}, so the approval on file does not cover this action`,
        { details: { nodeId: node.id, taskId: task.taskId, gateId: gate.gateId, approvedDigest: gate.contentDigest, currentDigest: now } },
      ),
    };
  }

  /**
   * Turn a resolved gate into the Task's outcome.
   *
   * THE READING SIDE OF THE ACCEPTANCE SET, AND IT IS A SEPARATE QUESTION FROM THE WRITING
   * SIDE. `gateDecisionOf` stops a decision outside the union from being APPENDED; this
   * method reads one back out of a FOLD, and the journal is authoritative (invariant 2) —
   * which means "we do not defend against it", not "it cannot say something we did not
   * write". A hand-edited database, a journal from a build that predates the guard, or a
   * `rewind`ed history can all carry `decision: "REJECT"`, and this method branched on
   * `=== "reject"` alone, so every one of those fell through to `succeeded` and ran the
   * action behind the gate. Fixing only the append would have left the same fail-open
   * reachable from the one input the system is designed to trust.
   *
   * The unreadable case FAILS the Task rather than being read as a rejection. It is not a
   * rejection — nobody refused anything — and inventing one would put a refusal in the run
   * record that no human made, which is the same class of lie in the opposite direction.
   * A failed Task stops the run and names the gate, which is what an operator holding a
   * journal they cannot account for actually needs.
   */
  #applyGateDecision(gate: GateRecord, node: NodeSpec, outbound: readonly EdgeId[]): NodeOutcome {
    if (
      gate.decision !== "approve" &&
      gate.decision !== "reject" &&
      gate.decision !== "edit" &&
      gate.decision !== "redirect"
    ) {
      return {
        status: "failed",
        writes: {},
        usage: { ...ZERO_USAGE },
        error: err.internal(
          CODES.E_REPLAY_DIVERGENCE,
          `node "${node.id}" is behind gate "${gate.gateId}", whose journaled decision is ` +
            `${JSON.stringify(gate.decision)} — not one of "approve", "reject", "edit", "redirect". ` +
            `This journal was not written by this build; the action behind the gate has NOT been run`,
          { details: { gateId: gate.gateId, decision: gate.decision } },
        ),
      };
    }
    if (gate.decision === "reject") {
      return {
        status: "failed",
        writes: {},
        usage: { ...ZERO_USAGE },
        error: err.policy(
          CODES.E_HUMAN_APPROVAL_REQUIRED,
          `node "${node.id}" was rejected: ${gate.justification ?? "no reason given"}`,
          { details: { gateId: gate.gateId } },
        ),
      };
    }
    // A `redirect` must be a subset of the node's DECLARED outgoing edges — a human
    // cannot invent a target any more than a model can. This was a comment and nothing
    // else: `#activate` looks every id up in the whole graph's edge table, so a redirect
    // naming an edge belonging to some OTHER node activated that node's target, jumping
    // whatever sat between here and there.
    const invented = (gate.take ?? []).filter((id) => !outbound.includes(id as EdgeId));
    if (invented.length > 0) {
      return {
        status: "failed",
        writes: {},
        usage: { ...ZERO_USAGE },
        error: err.policy(
          CODES.E_ROUTE_INVALID,
          `node "${node.id}" has no outgoing edge ${invented.map((i) => `"${i}"`).join(", ")}`,
          { details: { gateId: gate.gateId, take: gate.take, declared: outbound } },
        ),
      };
    }

    return {
      status: "succeeded",
      writes: { ...(gate.writes ?? {}) },
      usage: { ...ZERO_USAGE },
      ...(gate.take === undefined ? {} : { take: gate.take as readonly EdgeId[] }),
    };
  }

  /**
   * The recorded result of an effect that already ran and was NOT undone, or `undefined`.
   *
   * THIS IS THE RULE, AND IT USED TO BE ONE EXCEPTION. Effect keys are derived — `taskId:kind:
   * ordinal` — and replay served every one of the five kinds from the record. The LIVE path
   * served exactly `random`, so a Task that failed after its tool had already succeeded
   * re-entered that tool on the retry. `#retryDecision` had to refuse the retry outright to
   * keep a non-idempotent tool from ringing the bell twice; with this, the refusal narrows to
   * the case it cannot cover.
   *
   * THE GATE IS THE FOLD, NOT THE RAW JOURNAL, and that is what makes it correct in both
   * directions. `startedEffects` comes from `everStarted`, folded over LIVE events — so a
   * rewind that suppressed this effect leaves the key absent and the caller performs it afresh,
   * while a re-run whose effect was never undone reuses the recorded one. Reading the raw
   * journal to decide would serve a value a rewind had undone.
   *
   * `undefined` FOR STARTED-BUT-NEVER-COMPLETED. A process can die between the two appends;
   * the honest answer is that we do not know what the world did, and every caller falls through
   * and performs the effect again rather than failing the Task. That is the one hole
   * serve-by-key does not close, and `#unfinishedToolEffect` is where it is paid for.
   *
   * LIVE ONLY. Under `#replay` each call site serves from `ReplayEffects` and journals into the
   * shadow run, which is what keeps the two journals structurally comparable — see the note in
   * `#randomSeedEffect` about span counts.
   *
   * COSTS NOTHING ON A FIRST EXECUTION: the key cannot be in `startedEffects` before the effect
   * has started, so the journal scan happens only on a re-execution.
   *
   * Returns a WRAPPER rather than the value, so a recorded `null` is not confused with "no
   * record". Callers narrow `result` to what their own kind writes; nothing widens to fit.
   */
  /**
   * A served TOOL effect, bound to what was called and not only to where it sat.
   *
   * THE HOLE THIS CLOSES, found by a verifier and reproduced: a tool effect key is POSITIONAL —
   * `taskId:tool:<ordinal>` — so it says where a call sat in the body's sequence and nothing
   * about what it was. A `function` node declaring `effects: ["pay.charge", "audit.log"]` whose
   * body calls `pay.charge` first on attempt 1 and `audit.log` first on attempt 2 collides at
   * ordinal 0, and a key-only serve hands the second call the FIRST one's result. The same
   * collision is what let the narrowed non-idempotent refusal pass a charge that then ran twice
   * under a different ordinal.
   *
   * IDENTITY IS (name, version, argsDigest) AND IT COMES OFF `tool.called`, which is keyed
   * identically and already carried the first two. `argsDigest` is a digest of the arguments the
   * CALLER asked for — `rawArgs`, not the post-guard `final.value` — because that is the only
   * one that exists at this point in the call, and comparing anything else would be comparing
   * two different things. Values are never stored, for the reason `argsShape` gives.
   *
   * A MISMATCH IS NOT AN ERROR HERE. It means the body made a different call at this position,
   * which is a body that does not reproduce — real, and not this function's to judge. It simply
   * declines to serve, and the call is performed.
   */
  async #servedToolEffect(
    ctx: RunContext,
    p: RunProjection,
    key: string,
    identity: { readonly name: string; readonly version: string; readonly argsDigest: string },
  ): Promise<{ readonly result: unknown } | undefined> {
    const served = await this.#servedEffect(ctx, p, key);
    if (served === undefined) return undefined;
    let called: { name: string; version: string; argsDigest: string } | undefined;
    for await (const e of ctx.log.read(1 as Seq)) {
      if (isEvent(e, "tool.called") && e.payload.key === key) {
        called = { name: e.payload.name, version: e.payload.version, argsDigest: e.payload.argsDigest };
      }
    }
    if (called === undefined) return undefined;
    const same =
      called.name === identity.name && called.version === identity.version && called.argsDigest === identity.argsDigest;
    if (same) return served;

    // A MISMATCH IS DETECTED DIVERGENCE, and for a non-idempotent tool it FAILS CLOSED.
    //
    // The key is positional, so this position carrying a different call means the body did not
    // reproduce its sequence — and the danger is not the served value, it is the ordinal that
    // moved. If `pay.charge` was ordinal 0 on attempt 1 and ordinal 1 on attempt 2, nothing is
    // recorded at its new position, so performing it charges a second time. Declining to serve
    // is necessary and not sufficient.
    //
    // Refusing is always allowed; loosening never is. A body that reproduces never reaches this
    // line; one that does not has forfeited the only thing that made re-execution safe, and the
    // honest answer is to stop rather than to guess which of the two calls was the real one.
    // Idempotent tools are exempt because a second call is harmless by their own declaration —
    // which is what that flag on the manifest MEANS, and the one place it is load-bearing.
    // THE TOOL AT RISK IS THE RECORDED ONE, not the requested one. A first version asked whether
    // the call being made NOW is non-idempotent, and measured wrong: the body swapped an
    // idempotent `a.second` into ordinal 0, which is harmless to serve or perform — while the
    // non-idempotent `a.first` it displaced moved to ordinal 1, where nothing is recorded, and
    // was performed a SECOND time. Journal: ["a.first","a.second","a.first"]. What the mismatch
    // proves is that this position's recorded call has moved, so the question is whether THAT
    // call can survive being made again.
    if (identityMismatchIsFatal(this.tools.get(called.name))) {
      throw err.validation(
        CODES.E_EFFECT_UNRECORDED,
        `node re-execution diverged: effect ${key} recorded ${called.name}@${called.version} and this attempt asked for ` +
          `${identity.name}@${identity.version}. The recorded call is non-idempotent and its position moved, so it cannot ` +
          `be shown not to act twice; ` +
          `so the task fails rather than acting twice. Make the body's call sequence reproducible.`,
        { details: { key, recorded: called.name, requested: identity.name } },
      );
    }
    return undefined;
  }

  async #servedEffect(ctx: RunContext, p: RunProjection, key: string): Promise<{ readonly result: unknown } | undefined> {
    if (this.#replay !== undefined) return undefined;
    if (!p.startedEffects.includes(key)) return undefined;
    const done = await this.#completedEffects(ctx, (k) => k === key);
    return done.has(key) ? { result: done.get(key) } : undefined;
  }

  /**
   * The LAST LIVE `effect.completed` result per accepted key.
   *
   * LAST, and live, because a key can legitimately carry two completions: a rewind suppresses
   * the first, the redo appends a second. A first-match scan — which is what the seed's inline
   * version did — hands back the value the rewind undid. The suppression rule is
   * `projection.ts`'s `suppressedRanges` verbatim: `(atSeq, markerSeq)`, both ends exclusive.
   * It is recomputed here rather than imported so this stays a single pass over the journal
   * with no second buffer of every event.
   */
  async #completedEffects(ctx: { readonly log: RunLog }, accept: (key: string) => boolean): Promise<Map<string, unknown>> {
    const hits: { seq: number; key: string; result: unknown }[] = [];
    const undone: [number, number][] = [];
    for await (const e of ctx.log.read(1 as Seq)) {
      if (isEvent(e, "checkpoint.restored")) {
        if (e.payload.mode !== "rewind") continue;
        const at = (e.payload as { atSeq?: number }).atSeq;
        if (typeof at === "number") undone.push([at, e.seq]);
        continue;
      }
      if (isEvent(e, "effect.completed") && accept(e.payload.key)) hits.push({ seq: e.seq, key: e.payload.key, result: e.payload.result });
    }
    const out = new Map<string, unknown>();
    for (const h of hits) {
      if (undone.some(([from, to]) => h.seq > from && h.seq < to)) continue;
      out.set(h.key, h.result);
    }
    return out;
  }

  /**
   * The seed a body's `Math.random` is built from — drawn once per task, journaled, replayed.
   *
   * `Math` reaches a `function` realm whole while `Date` is bound to `undefined`, and that
   * asymmetry was invariant 4's one admitted gap: `Math.random()` ran unrecorded, so a body
   * that used it replayed as a divergence rather than being served. `effect.started` has
   * declared a `random` kind the whole time and nothing appended one.
   *
   * A SEED RATHER THAN A VALUE PER CALL, because a body runs synchronously inside
   * `vm.runInContext` under a per-call timeout and cannot await an append between two draws.
   * One recorded number reproduces the entire stream, which is the same trade `summarize`
   * makes in the other direction — there the ordinal is the turn because a task summarizes
   * many times; here it is `0` because a body runs once per task.
   *
   * `node:crypto` and not `Math.random()`: drawing the seed is the nondeterministic act this
   * method exists to journal, and `randomInt` is a builtin, so invariant 1 is untouched.
   */
  async #randomSeedEffect(ctx: RunContext, p: RunProjection, w: Wave): Promise<number> {
    const key = effectKey(w.task.taskId, "random", 0);

    // ALREADY DRAWN AND NOT UNDONE — serve it, and append nothing. `#servedEffect` is the
    // general form of what used to be written out here, and the seed is now one of its five
    // callers rather than the only place a live re-execution declined to repeat itself. A
    // `undefined` answer covers both "never started" and "started and never completed", and
    // the fall-through below is right for both: a half-written effect is exactly the state a
    // fresh draw is for, and `effect.completion-has-a-start` stays satisfied either way.
    const served = await this.#servedEffect(ctx, p, key);
    if (served !== undefined) return Number(served.result);

    // JOURNALED ON REPLAY TOO, which is the MODEL path's shape and not `#summarizeEffect`'s.
    // Those two differ and the difference is visible: a replay branch that returns before the
    // append leaves the shadow run's journal two events shorter per body, so `spansFrom` builds
    // a different span tree and the conformance check reports a mismatch it caused. Measured
    // while writing this — 44 spans against the original's 46. Serving the recorded value and
    // then recording it is what keeps a shadow journal structurally identical to its original.
    // THE MISS IS NOT A DIVERGENCE HERE, and this is the one place in the engine where that is
    // true. `onGraphChange: "allow"` exists so a CANDIDATE graph can be replayed against a
    // recording — that is what `runEvalSuite` does — and a candidate's new `function` node has a
    // taskId the recording never held, so no seed was ever written for it. A model or a tool
    // result cannot be invented, which is why `require` is right to throw for those; a seed can,
    // and deriving it from the key keeps the candidate's OWN replay reproducible rather than
    // making it entropy. Measured before this line existed: a candidate that computes where the
    // original wrote failed outright, and `report.replayed.channels` lost the channel the test
    // compares.
    const seed =
      this.#replay !== undefined
        ? this.#replay.has(key)
          ? Number(this.#replay.require(key).result)
          : seedFromKey(key)
        : randomInt(0, 2 ** 32);
    await this.#serialize(() =>
      ctx.log.append(
        [
          { type: "effect.started", payload: { key, kind: "random", attempt: 1 }, actor: SYSTEM_ACTOR("executor"), taskId: w.task.taskId },
          { type: "effect.completed", payload: { key, result: seed, resultDigest: digest(seed) }, actor: SYSTEM_ACTOR("executor"), taskId: w.task.taskId },
        ],
        { taskId: w.task.taskId },
      ),
    );
    return seed;
  }

  /**
   * The bound invokers a `function` body sees, one per DECLARED effect.
   *
   * Every call goes through `#invokeTool` — the single dispatch path — so a body's effect is
   * validated, policy-checked, gated where its class warrants one, journaled under a derived key
   * and served from the record on replay, by exactly the same code a `tool` node uses. That is
   * the reason this returns bound functions rather than handing the body a `call(name, args)`:
   * a name the body can compose is a name the body can invent, and the declared set stops being
   * the reachable set the moment it is a string parameter.
   *
   * THE ORDINAL IS SHARED ACROSS NAMES, and it has to be. Effect keys are per (task, kind,
   * ordinal), so a per-name counter would give the second call to `a` and the second call to `b`
   * the same key and replay would serve one the other's result. One counter over the body's whole
   * call SEQUENCE is what makes the keys distinct and reproducible.
   *
   * `nodeApproved` IS CLAIMED, and getting this wrong shipped a feature that reported success
   * while doing nothing. The first version passed `false`, reasoning that a body's calls "were not
   * on the screen the human saw". Measured, that produced: node floors at `in` → run suspends →
   * human approves → the body runs → `#invokeTool` re-decides, sees `gate`, and returns the
   * refusal string `"…requires human approval this turn cannot request"` → **the run reports
   * `succeeded` with that sentence sitting in a channel and the action never taken.** A gate a
   * human answered that changes nothing is worse than no gate.
   *
   * The claim is sound, and it is the same one a `tool` node makes: `#executeTask` ran the full
   * guard chain for this node before any body was entered, and the node's oversight floor is the
   * `max` over exactly these DECLARED names — that is what `reachableToolNames` computed it from.
   * So the human approved this set. It is a stronger claim than an agent's, whose tool choice is
   * made at run time and was never in the payload.
   *
   * ONE APPROVAL COVERS EVERY CALL THE BODY MAKES, which is the semantics an agent node already
   * has — measured there as one `gate.raised` and one `gate.decided` against two executions. The
   * declared set bounds WHICH tools, never how many times.
   */
  #effectsFor(ctx: RunContext, p: RunProjection, w: Wave): Readonly<Record<string, (args: unknown) => Promise<ToolResult>>> | undefined {
    const declared = w.node.function?.effects ?? [];
    if (declared.length === 0) return undefined;

    let ordinal = 0;
    const bound: Record<string, (args: unknown) => Promise<ToolResult>> = {};
    for (const name of declared) {
      bound[name] = async (args: unknown): Promise<ToolResult> => {
        const tool = this.tools.get(name);
        // A DECLARED-BUT-UNREGISTERED tool is a deployment mistake, not a body mistake, and the
        // compiler already warned about it. Answering with an error result rather than throwing
        // keeps it the same shape as every other tool failure a body has to handle.
        if (tool === undefined) {
          const why = `tool "${name}" is declared by node "${w.node.id}" but not registered in this process`;
          return { content: why, isError: true, error: err.validation(CODES.E_TOOL_NOT_FOUND, why) };
        }
        return this.#invokeTool(ctx, p, w.task, tool, args, ordinal++, true);
      };
    }
    return bound;
  }

  /**
   * The clock a node body sees: JOURNALED, not the wall clock.
   *
   * `FunctionContext.now` used to be the engine's injected clock passed straight through, so a
   * body that read the time produced a different answer on replay and nothing recorded the
   * difference. That was invariant 4's last admitted gap, and the sanctioned accessor was the one
   * carrying it — `Math.random` had already been closed by journaling a seed, and `Date` is absent
   * from the realm for the same reason this existed.
   *
   * The fix is not a new effect kind. `task.leased.ts` is already in the journal and already folds
   * onto the task's lease, so binding the body's clock to it makes the read reproducible with
   * nothing new written: replay folds the same event and computes the same number. This is what
   * Temporal's TypeScript sandbox does — a workflow clock is the last task-boundary time, not a
   * recorded read, because a recorded wall-clock read replays a lie.
   *
   * The consequence a body author should know: **time does not advance during a task.** Two reads
   * in one body return the same instant. That is correct for a deterministic step and it is the
   * property that makes replay total; a body needing elapsed real time is describing an effect,
   * and effects are declared.
   *
   * UNDER REPLAY THE LEASE IS SERVED, NOT FOLDED, and without that this whole argument was false
   * on the one path it exists for. A replay runs its own shadow run: it appends its OWN
   * `task.leased`, `RunLog` stamps every append `now: this.#now()` — `Date.now` on the CLI path,
   * because `loom replay` injects no clock — and `prepare` prefers that caller value over the
   * shadow store's. So the fold below read the REPLAY's wall clock, and two replays of one run
   * answered 1204 ms apart, measured: the delta is just the pause between them, which is the
   * point. `ReplayEffects.leaseAt` hands back the instant the RECORDING leased this
   * `(taskId, attempt)`. A miss falls through to the shadow's own lease — the replay ran a body
   * the recording did not — and is reported as `derivedClocks`, which is what makes
   * `ReplayReport.hermetic` honest rather than optimistic.
   */
  #bodyClock(p: RunProjection, taskId: TaskId): () => number {
    const task = p.tasks[taskId];
    const recorded = this.#replay?.leaseAt(taskId, task?.attempt ?? 1);
    const at = recorded ?? task?.lease?.at ?? p.startedAt;
    return () => at;
  }

  /**
   * The body a node runs, compiled to the node's OWN deadline where that is possible.
   *
   * ONE HELPER, TWO CALLERS, and the reason is the one `#dispatch` gives about undeclared
   * writes: "a check applied per-caller is a check that the next node type forgets."
   * `#runFunction` and `#runEvaluator`'s assertion arm are the two places a `FunctionBody` is
   * invoked, and every previous change to this contract — the seed, the clock, the outcome
   * shape — landed at one of them a commit before the other.
   *
   * See `REBIND_DEADLINE` above for what the bound covers. Three cases end here:
   *   - a sandboxed body with a declared `timeoutMs` — recompiled, and TERMINATED at that number;
   *   - a sandboxed body with none — keeps `FunctionLoaderOptions.callTimeoutMs`, default 30s;
   *   - a hand-registered body — host code, no realm, nothing to bound. Returned unchanged, and
   *     `timeoutMs` bounds its Task's outcome and not the body. That is A13.
   */
  #functionBody(ref: string, node: NodeSpec, taskId: TaskId): FunctionBody {
    const body = this.functions.require(ref);
    const rebind = (body as Rebindable)[REBIND_DEADLINE];
    // `> 0` and not `!== undefined`: `vm` rejects a non-positive timeout outright, and a graph
    // that declared one would lose the 30s default as well.
    const ms = node.timeoutMs;
    const bound = rebind === undefined || ms === undefined || !(ms > 0) ? body : rebind(ms);
    // THE PRODUCER FOR `ReplayReport.hermetic`'s THIRD CONJUNCT, and it is recorded HERE — at
    // fetch, before the body runs — because the question is "what did this replay re-execute
    // that it could not vouch for", and a body that throws still ran. `replay.ts` wrote this
    // wiring down as the two lines that would close it; this is one, and the loader carrying
    // the brand onto its wrapper is the other. `#replay` is undefined on a live run, so nothing
    // outside a replay pays for it.
    this.#replay?.bodyEntered(String(taskId), isRealmBounded(bound));
    return bound;
  }

  async #runFunction(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const body = this.#functionBody(w.node.function!.ref, w.node, w.task.taskId);
    const view = viewFor(p, ctx.graph.spec.channels, w.task.branch, w.node.reads ?? []);
    const raw = (await body(view, {
      taskId: w.task.taskId,
      signal: ctx.abort.signal,
      now: this.#bodyClock(p, w.task.taskId),
      seed: await this.#randomSeedEffect(ctx, p, w),
      ...(() => {
        const e = this.#effectsFor(ctx, p, w);
        return e === undefined ? {} : { effects: e };
      })(),
    })) as unknown;
    const out = requireOutcome(raw, w.node.function!.ref, w.node.id);
    retryRequested(out, w.node.function!.ref, w.node.id);
    return {
      status: "succeeded",
      writes: { ...(out.writes ?? {}) },
      usage: { ...ZERO_USAGE },
      ...(out.take === undefined ? {} : { take: out.take as readonly EdgeId[] }),
    };
  }

  async #runRouter(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const router = w.node.router!;
    const scope = scopeFor(p, ctx.graph.spec.channels, w.task.branch);

    for (const c of router.cases) {
      if (evaluate(this.#expr(ctx, c.when), scope) === true) {
        return { status: "succeeded", writes: {}, usage: { ...ZERO_USAGE }, take: c.take };
      }
    }
    // A router that matches nothing takes its declared fallback. It never invents a
    // target, and it never writes state — its entire output is an edge subset.
    return { status: "succeeded", writes: {}, usage: { ...ZERO_USAGE }, take: [router.fallbackEdge] };
  }

  /**
   * Fold every contribution from the branches below this join, in branch-coordinate
   * order. This is where a fan-out's held writes finally become state.
   */
  /**
   * Fold a join's declared branches. Called from `#commit`, against the projection as it
   * stands after this wave's siblings have committed — never from the body phase.
   */
  #foldJoin(ctx: RunContext, p: RunProjection, w: Wave): NodeOutcome {
    const join = w.node.join!;
    const prefix = encodeBranch(w.task.branch);
    const byChannel = new Map<string, Contribution[]>();
    let branchCount = 0;
    let skipped = 0;

    // THE DECLARATION, under or at this join's own coordinate.
    //
    // `join.branches` names the nodes that count as part of the branch, and it used to be
    // destructured here and never read — membership was pure prefix descent, so a second
    // fan-out under the same prefix had its contributions folded by BOTH joins. `at` as
    // well as `under` is load-bearing: `isDescendantBranch` requires a strict descendant,
    // so a static join whose arms sit at its own coordinate folded nothing at all.
    const declared = new Set<string>(join.branches);
    const members = Object.values(p.tasks)
      .filter((t) => {
        if (!declared.has(t.nodeId)) return false;
        const b = encodeBranch(t.branch);
        return b === prefix || isDescendantBranch(prefix, b);
      })
      .sort((a, b) => compareBranch(a.branch, b.branch) || a.iteration - b.iteration || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));

    // Counted per COORDINATE, not per task: a branch holding two nodes is one branch, and
    // D4 deviation 2 requires `branchCount + skipped` to equal the planned width.
    //
    // A branch that lost ANY member is degraded, which is why `lost` is tracked rather
    // than inferred from `seen − contributing`. Subtracting one set from the other made a
    // coordinate holding both a succeeded and a failed task count as clean — it was in
    // both sets, so `skipped` came out zero and `onBranchError: "fail"`, the mode whose
    // entire job is to stop the run when a branch dies, never fired. A multi-node branch
    // is exactly where that happens and exactly where the failure matters most.
    const contributing = new Set<string>();
    const lost = new Set<string>();
    for (const t of members) {
      const coord = encodeBranch(t.branch);
      if (t.state === "succeeded") {
        contributing.add(coord);
        // A CONTRIBUTION THIS JOIN MAY FOLD IS ONE THAT WAS HELD FOR IT, and a member that
        // already applied its own writes is not one. `#immediateReduce` applies a Task's
        // writes at commit whenever `writesHeldForJoin` is false; folding those again here
        // adds them to state a SECOND time, and every non-idempotent reducer —
        // `append_ordered`, `sum` — silently doubles.
        //
        // A real fan-out never showed this, which is why it survived: its members sit at
        // depth, `#immediateReduce` held them, and the join was their only application. The
        // shape that breaks is a STATIC sibling-branch join — arms wired `kind: "join"` with
        // no fan-out above them, so every member is at the root coordinate and every member
        // already reduced. Measured on a real Engine before this line existed: three branches
        // each writing one entry to an `append_ordered` channel produced SIX, and the run
        // compiled and succeeded.
        //
        // Per member rather than per join, because the two can mix: a join whose `branches`
        // names both a fanned-out node and a static sibling has some members held and some
        // applied, and the base `stateAtPrefix` below already carries the applied ones.
        if (!writesHeldForJoin(t.branch)) continue;
        for (const [channel, value] of Object.entries(t.writes)) {
          const list = byChannel.get(channel) ?? [];
          list.push({ branch: t.branch, nodeId: t.nodeId, iteration: t.iteration, value });
          byChannel.set(channel, list);
        }
      } else if (t.state === "failed" || t.state === "skipped" || t.state === "cancelled") {
        lost.add(coord);
      }
    }
    // A branch cannot be both. A loss anywhere in it wins, so the number an operator reads
    // means "this many branches came through intact", not "this many produced something".
    for (const coord of lost) contributing.delete(coord);
    branchCount = contributing.size;
    skipped = lost.size;

    if (join.onBranchError === "fail" && skipped > 0) {
      return {
        status: "failed",
        writes: {},
        usage: { ...ZERO_USAGE },
        error: err.validation(
          CODES.E_QUORUM_UNREACHABLE,
          `join "${w.node.id}": ${skipped} branch(es) failed and onBranchError is "fail"`,
        ),
      };
    }

    const wave: Record<string, readonly Contribution[]> = {};
    for (const [channel, list] of byChannel) wave[channel] = list;

    // HOLD AT DEPTH, APPLY AT ROOT — the rule `#immediateReduce` already enforces for
    // every other node type, and joins were the sole exception.
    //
    // A join inside a fan-out runs once per enclosing branch. Applying its fold to shared
    // channel state there would make the result depend on which sibling committed first;
    // returning it as this Task's own write instead lets the ENCLOSING join fold the
    // siblings in branch order. Associativity — which D5.3 already demands of every
    // reducer — is what makes the two-level fold equal the one-level fold.
    if ((ctx.index.fanoutDepth.get(w.node.id) ?? 0) > 0) {
      return {
        status: "succeeded",
        writes: foldPartial(ctx.graph.spec.channels, wave).values,
        usage: { ...ZERO_USAGE },
      };
    }

    const before = stateAtPrefix(p, w.task.branch);
    const reduced = reduceState(ctx.graph.spec.channels, before, wave);

    return {
      status: "succeeded",
      writes: {},
      usage: { ...ZERO_USAGE },
      reduced: {
        values: pick(reduced.state, reduced.channels),
        channels: reduced.channels,
        branchCount,
        skipped,
      },
    };
  }

  async #runToolNode(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const spec = w.node.tool!;
    const tool = this.tools.require(spec.name);
    const scope = scopeFor(p, ctx.graph.spec.channels, w.task.branch);
    const args = resolveArgs(spec.args ?? {}, scope);

    // `true`: this node already ran the full guard chain in `#executeTask`.
    const result = await this.#invokeTool(ctx, p, w.task, tool, args, 0, true);
    if (result.isError === true) {
      return {
        status: "failed",
        writes: {},
        usage: { ...ZERO_USAGE },
        // The typed reason when the refusal carries one; otherwise the old default, which is
        // still right for a tool that genuinely failed to reach its source.
        error: result.error ?? err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, result.content),
      };
    }
    // A tool's channel write is its `writes` when it declares one, otherwise its
    // model-legible `content`. NEVER `details`: that field is documented as "for
    // renderers and telemetry, never sent to the model", and letting it land in a
    // channel makes it reachable by the next node's prompt — which is exactly the
    // distinction the field exists to draw.
    return {
      status: "succeeded",
      writes: this.#assignWrites(
        ctx,
        w.node,
        mapToolWrites(w.node, result.writes ?? { [firstWrite(w.node) ?? "_"]: result.content }),
        ZERO_USAGE,
      ),
      usage: { ...ZERO_USAGE },
    };
  }

  async #runEvaluator(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const ev = w.node.evaluator!;
    if (ev.kind === "assertion") {
      const body = this.#functionBody(ev.ref, w.node, w.task.taskId);
      const view = viewFor(p, ctx.graph.spec.channels, w.task.branch, w.node.reads ?? []);
      // THE SAME CONTRACT, THE SAME CHECK. An `assertion` evaluator's ref IS a function body,
      // and this arm read `out.writes` exactly as `#runFunction` did — so the identical authoring
      // mistake was a silent no-op here after being refused there. Measured: an assertion body
      // returning `{ confidence: 0.9 }` committed nothing and the run died with
      // `E_OUTPUT_MISSING`. One validator, two callers, so the two cannot drift.
      // AND THE SEED, for the same reason and by the same route. `functions.require` has two
      // callers and this is the one that kept the defect last time; a seed passed at only one
      // of them would leave an `assertion` body's `Math.random` throwing while a `function`
      // body's worked.
      const out = requireOutcome(
        (await body(view, {
          taskId: w.task.taskId,
          signal: ctx.abort.signal,
          // BOTH ARMS, for the reason the comment above gives about the seed: an `assertion`
          // body whose clock diverged while a `function` body's did not is the same asymmetry
          // one field over, and this is the second time this pair has needed the same change.
          now: this.#bodyClock(p, w.task.taskId),
          seed: await this.#randomSeedEffect(ctx, p, w),
        })) as unknown,
        ev.ref,
        w.node.id,
      );
      // BOTH ARMS, in the same commit as the contract. This is the third change to the
      // function-body contract, and the first two each landed here a commit late.
      retryRequested(out, ev.ref, w.node.id);
      this.#checkConfidence(ctx, w, out.writes ?? {}, ev.threshold);
      return { status: "succeeded", writes: { ...(out.writes ?? {}) }, usage: { ...ZERO_USAGE } };
    }
    // A rubric evaluator is one model call that must return a typed Verdict. Its
    // output is the primary NON-HUMAN signal the evolution loop scores on, so the
    // shape is enforced rather than parsed leniently.
    const outcome = await this.#runAgent(ctx, p, w, VERDICT_SCHEMA, ev.ref);
    this.#checkConfidence(ctx, w, outcome.writes, ev.threshold);
    return outcome;
  }

  /**
   * E1 — an evaluator came back below its threshold.
   *
   * The run continues. A weak verdict is not a failure; it is a reason for someone to be
   * watching what the run does with it, which is exactly what posture `on` means.
   */
  #checkConfidence(ctx: RunContext, w: Wave, writes: Readonly<Record<string, unknown>>, threshold: number): void {
    for (const value of Object.values(writes)) {
      if (isLowConfidence(value, threshold)) {
        this.#escalate(ctx, "low_confidence", w.node.id, { threshold });
        return;
      }
    }
  }

  // ── the agent node: a bounded ReAct loop ──────────────────────────────────

  /**
   * The text a node's prompt ref names, read through the pin the compiler froze.
   *
   * Refuses rather than degrading. `E_RESOURCE_NOT_FOUND` is what a `subgraph` node already
   * raises for a ref that resolves to no `GraphSpec`, and a prompt that resolves to no
   * document is the same fact about a different kind — the run cannot do what the graph says.
   */
  #documentFor(ctx: RunContext, nodeId: NodeId, ref: string): string {
    // FROM THE COMPILED GRAPH, not from a resolver. `RunGraph.documents` was frozen when the
    // manifest was, so the executor asks nobody anything and a promotion between compile and
    // execute cannot reach it.
    const text = ctx.graph.documents[ref];
    if (text === undefined) {
      throw err.notFound(
        CODES.E_RESOURCE_NOT_FOUND,
        `node "${nodeId}" names prompt "${ref}", which resolves to no document. Publish it — a workspace serves ` +
          `resources/prompt/<name>.md — or the model is sent the ref instead of an instruction.`,
        { details: { nodeId, ref } },
      );
    }
    return text;
  }

  async #runAgent(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    schemaOverride?: JSONSchema,
    promptOverride?: string,
  ): Promise<NodeOutcome> {
    const agent = w.node.agent;
    const maxTurns = agent?.maxTurns ?? 1;
    // A replay serves every turn from the journal, so it needs no provider at all.
    // Requiring one anyway is the coupling replay exists to remove: it would mean an
    // audit could not re-derive a run without the model that produced it configured.
    const adapter = this.#replay === undefined ? this.models.require() : undefined;
    const view = viewFor(p, ctx.graph.spec.channels, w.task.branch, w.node.reads ?? []);

    // WHAT A HUMAN APPROVED WHEN THEY APPROVED THIS NODE. An agent node whose reachable
    // set contains a hard-to-undo tool now floors at `in` and gates BEFORE the model
    // runs, so the approval is an approval of this node acting — including with the tools
    // it declares. Without carrying it here the gate authorizes nothing: the model asks,
    // `#invokeTool` refuses, and the run reports success having done none of the work the
    // human said yes to.
    const nodeApproved = lastDecidedGate(p, w.task.taskId)?.decision === "approve";

    // Tool calls completed in earlier turns of THIS task. Effect keys must be unique
    // across the whole task, not within a turn.
    let callsSoFar = 0;

    const allowed = new Set(agent?.tools ?? []);
    // Structural containment (D6.8 §2): the tool set is computed from the NODE SPEC
    // before the turn. Nothing in the model's context can widen it, so an injection
    // can make the model *ask* for a tool it was never given and be refused before
    // dispatch.
    const toolSpecs = this.tools
      .list()
      .filter((t) => allowed.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    // Context is assembled from DECLARED reads, then bounded by the compaction ladder.
    // The prompt envelope below is a stable contract with the model; the ladder is a
    // contract with the context window. Keeping them separate means changing one does
    // not silently change the other.
    // THE DOCUMENT, NOT THE POINTER — and looked up by the PINNED DIGEST rather than by the
    // ref. `agent.prompt` is a `ResourceRef`, and for the whole project it was interpolated
    // verbatim, so a model received the eleven characters `prompt/x@stable` where its
    // instruction should have been. The digest comes from `RunGraph.resolutionManifest`,
    // frozen at compile: reading it by ref instead would let a promotion between compile and
    // execute swap the instruction underneath a running node, which is the defect
    // `resources/functions.ts` already found and fixed once for code.
    //
    // NO SILENT FALLBACK. A pin that names no document REFUSES, the way a `subgraph` node
    // already refuses a ref that resolves to no `GraphSpec`. The alternative is what hid this
    // for the whole project: a run that sends a pointer is a SUCCESSFUL run, and
    // `[mock] {"prompt":"prompt/x@stable"}` is only wrong if somebody reads it.
    const promptRef = promptOverride ?? agent?.prompt;
    const instructions = promptRef === undefined ? "" : this.#documentFor(ctx, w.node.id, promptRef);
    // The node's identity is orientation and goes AFTER the task, so a long document is not
    // preceded by a line about plumbing. One string, used at both sites.
    const systemPrompt = instructions === "" ? `You are node ${w.node.id}.` : `${instructions}\n\nYou are node ${w.node.id}.`;

    const assembled = await assembleContext(
      {
        // THE INSTRUCTION GOES IN THE SYSTEM SLOT, which is where a model looks for one and
        // where a multi-line document survives without being JSON-escaped into a field. The
        // node's identity is appended rather than replaced: it is orientation, not the task.
        // `system` CARRIES THE DOCUMENT AND `instruction` DOES NOT, because `systemPrompt`
        // already contains it — passing both made the ladder count the same text twice, both
        // sections INVIOLABLE, so `E_CONTEXT_OVERFLOW` fired at half the real budget.
        // Measured: a 1,000,000-character document reported `tokensBefore: 500008`, exactly 2×.
        system: systemPrompt,
        instruction: "",
        channels: Object.fromEntries(view.visible.map((c) => [c, view.get(c)])),
        channelSpecs: ctx.graph.spec.channels,
      },
      {
        maxTokens: this.#contextTokens,
        dropBelowPriority: 35,
        // The summarizer is an EFFECT, so replay serves the same summary and rung 3
        // stays deterministic.
        summarize: (text) => this.#summarizeEffect(ctx, p, w, text),
      },
    );

    // The user message carries the STATE. The instruction moved to the system slot above, so
    // `prompt` is gone from this envelope rather than duplicated into it — two copies of an
    // instruction is two things for a reader of the transcript to reconcile.
    let messages: Message[] = [{ role: "user", content: JSON.stringify({ node: w.node.id, state: assembled.channels }) }];

    let usage: UsageRecord = { ...ZERO_USAGE };
    let finalText = "";

    for (let turn = 0; turn < maxTurns; turn++) {
      // BOUND WHAT IS SENT, not merely what was assembled. `assembleContext` above ran
      // once, before this loop, over the smallest the request will ever be; the loop then
      // pushes an assistant message and a tool result per turn into the same array that
      // becomes `req.messages`. Without this the budget describes a request the model is
      // never sent. The fold is in-place because a prefix summarised on turn 3 must stay
      // summarised on turn 4 — re-deriving it every turn would spend a model call per turn
      // to compute the same summary under a different effect key.
      // THE SYSTEM PROMPT IS PART OF WHAT IS SENT, so the transcript's budget is what is left
      // after it. It used to be eighteen characters — `You are node X.` — and rounding it away
      // cost nothing; it is now the whole document, and leaving it out reproduced exactly the
      // defect `boundTurns` exists to close: measured, 127,513 tokens posted against a 100,000
      // budget, no rung, no `E_CONTEXT_OVERFLOW`, run `succeeded`.
      const bounded = await boundTurns(messages, Math.max(0, this.#contextTokens - estimateTokens(systemPrompt)), (text) =>
        this.#summarizeEffect(ctx, p, w, text, turn),
      );
      messages = [...bounded.messages];
      if (bounded.overBudget) {
        // The same verdict `assembleContext` reaches when its ladder cannot fit the
        // sections, raised for the same reason and with the same code: a transcript whose
        // un-foldable tail alone exceeds the window is not something a rung can repair.
        // Raised HERE rather than left to the provider, because the provider's answer is a
        // 400 that arrives after the request was paid for.
        throw err.validation(
          CODES.E_CONTEXT_OVERFLOW,
          `node "${w.node.id}" turn ${String(turn)}: transcript is over the ${String(this.#contextTokens)} token budget after folding`,
          { details: { node: w.node.id, turn, budget: this.#contextTokens, folded: bounded.folded } },
        );
      }

      const req: ModelRequest = {
        model: agent?.profile ?? "mock",
        // THE SITE THAT REACHES THE MODEL. `assembleContext` is handed a `system` too and its
        // answer is discarded — only `assembled.channels` is read — so changing that one alone
        // changes nothing a provider sees. Both are set, deliberately: the ladder must MEASURE
        // what is sent or the budget describes a request nobody made.
        system: systemPrompt,
        messages,
        tools: toolSpecs,
      };

      // `preModel` — the request a filter returns is the one that is ESTIMATED, RESERVED and
      // SENT, in that order. Rewriting after the reservation would price a request nobody made,
      // which is the same error `assembleContext`'s discarded `system` used to make one layer up.
      const shaped = await this.#filterHook(ctx, w.task, "preModel", req);

      let recordedProvider = "replay";
      // WHO THE TERMINAL `done` FRAME NAMED — TRI-STATE, AND JOURNALLED. D.7.6's refusal below
      // reads exactly this value, and a replay has to reach the same verdict from the record
      // alone, so the record has to carry it: `RecordedModelTurn.provider`.
      //
      //   `undefined`  no terminal `done` frame at all. Nothing named anything, so there is
      //                nothing to refuse -- and it is also what a journal written before
      //                `e6d00f2` says, which reads correctly rather than by luck: the run such a
      //                journal records did not refuse here either, so neither does its replay.
      //                Replay reproduces what happened; it does not re-judge old runs under new
      //                rules. (`""` and `undefined` are therefore NOT interchangeable here, and
      //                that is the whole reason the empty string is written rather than omitted.)
      //                THE SET IS THE WINDOW, NOT "BEFORE THE FIELD", and the difference is one
      //                real window of journals: between `e6d00f2` and `633e265^` this refusal
      //                EXISTED and nothing wrote the field, so a journal from that range replays
      //                a provider refusal as a SUCCESS with the refused string on the channel.
      //                Driven, base engine recording and fixed engine replaying: `BASE LIVE
      //                failed E_PROVIDER_BAD_REQUEST` -> `FIXED REPLAY succeeded`. Not a code
      //                defect -- the value genuinely is not in those journals and no fix can
      //                invent it -- so naming the window IS the remedy.
      //   `""`         a frame arrived and named nobody. THAT is the refusal.
      //   a name       the leaf that served it -- read off the frame rather than off the adapter
      //                this loop is holding, because that adapter is a `RoutingAdapter` in every
      //                CLI deployment and a `FallbackAdapter` may have answered from a tier
      //                nobody named.
      //
      // TWO LIVE-ONLY LOCALS USED TO STAND HERE (`sawDoneFrame`, `servingProvider`) and neither
      // survived the append, so the guard could only ever fire on the live path: a faithfully
      // recorded refusal replayed `succeeded` and wrote the refused text to the channel. One
      // value that the journal carries is what makes it fire on all three paths.
      let framedProvider: string | undefined;
      let reservation;
      // THE CEILING THIS TURN WAS SENT UNDER, hoisted out of the reservation because two things
      // need it: the token budget charges against it, and a turn that comes back truncated has
      // to NAME it — an operator told "raise the ceiling" without being told what it is now
      // cannot tell a margin from an order of magnitude. `undefined` only when the recording has
      // no quote to serve — see `#quoteEffect`.
      let ceiling: number | undefined;
      try {
        // WHAT THE ADAPTER SAID THIS TURN WOULD COST, ASKED ONCE AND RECORDED. Both numbers come
        // from one journaled effect so that a replay reaches the same three refusals below from
        // the record instead of re-deriving them against an adapter it does not have. The two
        // used to be two bare adapter calls straddling the `costUsd` check; asking them together
        // moves an `outputCeilingOf` REFUSAL (`E_PROVIDER_BAD_REQUEST`, for an adapter that will
        // not state a ceiling) ahead of that check, which is the right order — a request whose
        // ceiling nobody will state cannot be budgeted, and the budget arithmetic below is what
        // that ceiling feeds.
        const quote = await this.#quoteEffect(ctx, p, w, shaped, turn, adapter);
        const estimateUsd = quote.estimateUsd;

        // THE NODE'S OWN CEILING, and until now a number nothing read. D2 says this loop is
        // "bounded by `maxTurns` AND node budget, whichever binds first"; the second half was
        // enforced nowhere. The scope handed to `reserve` is a LABEL — the failure even reads
        // `"scope": "node:ask"` while `"limit"` is the RUN's — and `PolicyEngine.reserve`
        // consults `budget.runUsd` alone. Measured through `bin/loom` against a priced local
        // provider: a node declaring `costUsd: 1.0` spent $16 and the run reported `succeeded`,
        // while the identical spend under a GRAPH budget of $1.00 failed before the call.
        //
        // It is worse than an unread field, because the compiler builds a story around it —
        // `GRAPH009_UNBOUNDED_NODE` tells the author to ADD this very field to a spending node,
        // and `GRAPH009_BUDGET_OVERCOMMIT` errors when the numbers do not sum under the graph
        // budget. The system asked for it, checked its arithmetic, and ignored it.
        //
        // Checked against the TASK-LOCAL `usage` — what one execution has accumulated across its
        // turns — which is the only reading that needs no new durable state: a re-run task gets
        // its budget again, exactly as `reserve`/`settle` already treat a run. Reserve-worst-case
        // like the run-level check, so the estimate counts before the call rather than after it.
        // `subgraph` is deliberately NOT covered: its cost is settled from `childP.usage` after
        // the child has run, so a cap there would refuse what it could not prevent.
        const nodeCapUsd = w.node.policy?.budget?.costUsd;
        if (nodeCapUsd !== undefined && usage.costUsd + estimateUsd > nodeCapUsd + 1e-9) {
          throw err.exhausted(
            CODES.E_BUDGET_EXHAUSTED,
            `node "${w.node.id}" would exceed its $${nodeCapUsd.toFixed(2)} budget ` +
              `($${usage.costUsd.toFixed(4)} spent by this task, $${estimateUsd.toFixed(4)} estimated for this turn)`,
            {
              details: {
                dimension: "costUsd",
                scope: `node:${w.node.id}`,
                limit: nodeCapUsd,
                spent: usage.costUsd,
                reserved: 0,
                requested: estimateUsd,
              },
            },
          );
        }

        // THE SAME CEILING IN TOKENS. `estimateTurnTokens` is the worst case for THIS request —
        // the transcript that is about to be sent, plus the output ceiling — so the refusal
        // lands before the provider is reached rather than after it bills, which is the whole
        // difference between a budget and a receipt.
        //
        // `inputTokens + outputTokens` and nothing else, matching `PolicyEngine`'s
        // `billedTokens`: `UsageRecord` calls the cache fields disjoint from `inputTokens` and
        // `reasoningTokens` a subset of `outputTokens`, so a wider sum would double-count one
        // and add two the provider bills separately, and a ceiling that over-counts refuses work
        // that fit.
        //
        // THE CEILING IS ASKED FOR, NOT ASSUMED — D.7.3 — AND NOW IT IS RECORDED. It comes off
        // the quote above, which is one journaled effect on every path: a live turn asks the
        // adapter, a re-execution and a replay are handed the number the recording got. So the
        // refusal below re-derives instead of being re-guessed.
        ceiling = quote.outputCeiling;
        // WHAT `undefined` STILL MEANS, AND IT IS NOW EXACTLY ONE CASE: a replay of a journal
        // written before the `quote` effect existed. There is no quote to serve and none can be
        // invented, so `ceiling ?? 0` stands for those recordings — a LOWER BOUND on the live
        // estimate (same `shaped`, no padding), sound in one direction and holed in the other:
        //   - a replay can never refuse a turn the live run allowed. That direction is safe, and
        //     it is why this check is not simply switched off in replay. Measured, node cap 10:
        //     LIVE refuses at 1043, REPLAY refuses at 19 — skipping the check would have lost
        //     that refusal entirely and died on the missing effect instead.
        //   - a replay CAN fail to refuse a turn the live run refused, whenever the refusal
        //     needed the padding. Measured before this change, node cap 500: LIVE failed
        //     E_BUDGET_EXHAUSTED at 1043 and REPLAY did not refuse at 19, reached the model
        //     effect the live run never made, and died E_REPLAY_DIVERGENCE.
        // A journal this binary writes has the quote, so both of those are now about OLD
        // recordings only. Replay reproduces what happened; it does not re-judge a run under a
        // rule its binary never had.
        //
        // THE CLASS THAT IS NOW CLOSED, named because it was named here as open. Three
        // token/cost refusals could not be re-derived by a replay, all for one reason — the
        // quantity is an ADAPTER's answer and the journal did not carry it: this node ceiling;
        // the node `costUsd` ceiling above, whose `estimateOf(shaped) ?? 0` made it refuse
        // nothing at all in replay; and `ctx.policy.reserve` below, which charged the RUN's
        // token budget a padded number live and an unpadded one in replay. All three read the
        // quote now. `wallMs` was and is exempt, because it is settled-only — there is no worst
        // case for a duration until the call has been made.
        const estimateTokensForTurn = estimateTurnTokens(shaped, ceiling ?? 0);
        const nodeCapTokens = w.node.policy?.budget?.tokens;
        const taskTokens = usage.inputTokens + usage.outputTokens;
        if (nodeCapTokens !== undefined && taskTokens + estimateTokensForTurn > nodeCapTokens) {
          throw err.exhausted(
            CODES.E_BUDGET_EXHAUSTED,
            `node "${w.node.id}" would exceed its ${String(nodeCapTokens)}-token budget ` +
              `(${String(taskTokens)} spent by this task, ${String(estimateTokensForTurn)} estimated for this turn` +
              // THE NUMBER SAYS WHICH NUMBER IT IS. Without this the recorded refusal reads
              // "1043 estimated" and its replay reads "19 estimated", two different numbers for
              // one turn with no hint that the second is a floor — the exact failure the header
              // of `test/run/replay-fidelity.test.ts` was written about, a wrong answer
              // announcing itself as a different wrong answer.
              (ceiling === undefined
                ? `, a FLOOR: this recording carries no quote effect for the turn — it was written ` +
                  `before one existed — so the padding the recorded run reserved against is missing ` +
                  `from this number`
                : "") +
              `)`,
            {
              details: {
                dimension: "tokens",
                scope: `node:${w.node.id}`,
                limit: nodeCapTokens,
                spent: taskTokens,
                reserved: 0,
                requested: estimateTokensForTurn,
                // `null` is "nobody stated one", which now means exactly one thing: a replay of a
                // journal older than the `quote` effect. Written rather than omitted so an auditor
                // reading `budget.exhausted`'s error record can tell a padded estimate from an
                // unpadded one without knowing how it got there.
                ceiling: ceiling ?? null,
              },
            },
          );
        }

        // AND IN PROVIDER TIME, which is the one that cannot be estimated. There is no worst
        // case for a duration until the call has been made, so this is settled-only: it stops
        // the turn AFTER the ceiling is crossed and never the turn that crosses it. A node with
        // `maxTurns: 1` therefore has no wall-time bound at all, which is stated rather than
        // papered over — see `PolicyEngine.settle` for the same limitation at the run ceiling.
        const nodeCapWallMs = w.node.policy?.budget?.wallMs;
        if (nodeCapWallMs !== undefined && usage.wallMs >= nodeCapWallMs) {
          throw err.exhausted(
            CODES.E_BUDGET_EXHAUSTED,
            `node "${w.node.id}" has spent ${String(usage.wallMs)} ms of provider time, reaching its ${String(nodeCapWallMs)} ms budget`,
            {
              details: {
                dimension: "wallMs",
                scope: `node:${w.node.id}`,
                limit: nodeCapWallMs,
                spent: usage.wallMs,
                reserved: 0,
                requested: 0,
              },
            },
          );
        }

        reservation = ctx.policy.reserve(`node:${w.node.id}`, estimateUsd, estimateTokensForTurn);
        // Checked at RESERVE as well as at commit. Under reserve-worst-case, committed
        // exposure peaks at the reservation and falls back when `settle` credits the
        // real cost — so a check only at commit sees the trough and never fires. "80%
        // consumed" means 80% committed, which is the number that could still be spent.
        this.#checkBudgetWarning(ctx);
      } catch (e) {
        const le = toLoomError(e);
        if (le.code !== CODES.E_BUDGET_EXHAUSTED) throw le;
        // ONLY `fail` REACHES HERE. `gate` and `degrade` are compile errors
        // (`GRAPH003_BUDGET_ACTION_UNSUPPORTED`): `gate` used to escalate the ceiling for
        // decisions this run would never make and then fail anyway — the same outcome as
        // `fail`, reached through a word that promised a human. `degrade` was read by nothing.
        const action = ctx.graph.spec.policy?.onBudgetExhausted ?? "fail";
        // Run-level, not branch-level: journal it so a join cannot absorb it and so
        // it survives a restart.
        await this.#serialize(() =>
          ctx.log.append(
            [
              {
                type: "budget.exhausted",
                // THE LIMIT THAT WAS ACTUALLY EXCEEDED, read off the error instead of recomputed.
                // `spentUsd + remainingUsd` is `Infinity` whenever the deployment set no
                // `runUsd`, and `canonicalize` refuses a non-finite number on the durable write
                // path — so the run failed `E_INTERNAL: non-finite number Infinity at limitUsd`
                // instead of reporting the budget failure it actually had. That was unreachable
                // while `reserve` was the only thing that could throw here, because a reservation
                // cannot exceed a limit that does not exist. A node ceiling can, and did.
                // AND WHICH OF THE THREE IT WAS. `limitUsd` alone could not tell an auditor
                // whether the run died for money, for tokens or for provider time; the two
                // fields below are read off the same `details` every throw site now sets.
                payload: {
                  scope: `run:${ctx.runId}`,
                  limitUsd: exceededLimitUsd(le, ctx.policy.spentUsd),
                  action,
                  ...exceededDimension(le),
                },
                actor: SYSTEM_ACTOR("policy"),
                taskId: w.task.taskId,
              },
            ],
            { taskId: w.task.taskId },
          ),
        );
        return { status: "failed", writes: {}, usage, error: le };
      }
      const key = effectKey(w.task.taskId, "model", turn);
      // SERVED, NOT RE-ASKED. A turn this Task already completed and never undid is handed
      // back from the record — no request, no second bill, and no second `effect.completed`
      // under one key. This is also what makes serving a TOOL sound: the tool ordinal is the
      // call's index in the model's returned array, so the transcript has to be the same
      // transcript, and it is only the same transcript if the turns that built it are served
      // too. Attempt 2 therefore re-derives attempt 1 exactly, up to the first effect with no
      // recorded outcome — which is precisely replay's semantics, on the live path.
      const servedTurn = await this.#servedEffect(ctx, p, key);
      let turnUsage: UsageRecord = { ...ZERO_USAGE };
      let assistant: Message | undefined;
      let finish = "stop";

      if (servedTurn === undefined) {
        await this.#serialize(() =>
          ctx.log.append(
            [
              {
                type: "effect.started",
                payload: { key, kind: "model", attempt: 1 },
                actor: SYSTEM_ACTOR("agent"),
                taskId: w.task.taskId,
              },
            ],
            { taskId: w.task.taskId },
          ),
        );
      }

      try {
        if (servedTurn !== undefined) {
          const rec = servedTurn.result as RecordedModelTurn;
          // The same tri-state the live loop below writes, read back. A turn this task already
          // completed and had refused is refused again on the resume, rather than let through by
          // a guard that only the first attempt could evaluate.
          framedProvider = rec.provider;
          assistant = { role: "assistant", content: rec.content, ...(rec.toolCalls === undefined ? {} : { toolCalls: rec.toolCalls }) };
          finish = rec.finishReason;
          turnUsage = rec.usage;
        } else if (this.#replay !== undefined) {
          // Served, not called. `adapter.stream` is never reached, so replay makes
          // no network request and costs nothing.
          const rec = this.#replay.require(key) as { result: RecordedModelTurn };
          framedProvider = rec.result.provider;
          // The LEAF the recording named, so the shadow journal's `model.called.provider` says
          // what the original's did instead of the literal `"replay"`. `""` is not a name: it is
          // the frame that named nobody, which the refusal below handles and which must not be
          // written into a field whose readers (`telemetry/spans.ts`'s `gen_ai.system`) treat it
          // as an identity.
          recordedProvider = rec.result.provider !== undefined && rec.result.provider !== "" ? rec.result.provider : recordedProvider;
          assistant = { role: "assistant", content: rec.result.content, ...(rec.result.toolCalls === undefined ? {} : { toolCalls: rec.result.toolCalls }) };
          finish = rec.result.finishReason;
          turnUsage = rec.result.usage;
        } else {
          for await (const ev of adapter!.stream(shaped, ctx.abort.signal)) {
            if (ev.type === "done") {
              assistant = ev.message;
              finish = ev.finishReason;
              turnUsage = ev.usage;
              // WHO ACTUALLY SERVED IT — D.7.6. `""` when the frame omits it, which only an
              // untyped adapter can do; the refusal below is what happens then, and it is
              // deliberately NOT a fallback to `adapter.provider` — that fallback IS the bug this
              // removes. Assigned here and nowhere else on this path, so "a frame arrived" and
              // "it named nobody" are one fact and get journalled as one field.
              framedProvider = typeof ev.provider === "string" ? ev.provider : "";
            }
          }
        }
      } catch (e) {
        ctx.policy.settle(reservation, 0);
        const le = toLoomError(e);
        await this.#serialize(() =>
          ctx.log.append(
            [{ type: "effect.failed", payload: { key, error: errorRecord(le) }, actor: SYSTEM_ACTOR("agent"), taskId: w.task.taskId }],
            { taskId: w.task.taskId },
          ),
        );
        throw le;
      }

      // A NAME, OR NOTHING — never the empty string, which is `framedProvider`'s "the frame named
      // nobody" and is not an identity anything may be attributed to.
      const servingProvider = framedProvider === undefined || framedProvider === "" ? undefined : framedProvider;

      // A SERVED TURN COST NOTHING THIS TIME. The reservation is released at zero, so the run's
      // spend is not charged twice for one call; the task-local `usage` still accumulates the
      // recorded turn, which is what keeps the node ceiling and `excessUsage` reading the same
      // numbers on attempt 2 that they read on attempt 1.
      ctx.policy.settle(reservation, servedTurn === undefined ? turnUsage : 0);
      usage = addUsage(usage, turnUsage);

      // `postModel` — BEFORE the append, so the journal records what the filter produced and
      // replay serves that rather than re-running the hook. A redaction that happened after the
      // write would leave the unredacted text durable, which is the opposite of the point.
      if (assistant !== undefined) assistant = await this.#filterHook(ctx, w.task, "postModel", assistant);

      // A SERVED TURN IS ALREADY IN THE JOURNAL, once. Appending here would put a second
      // `effect.completed` under one key in one attempt — the state `auditRun` reports as
      // unhealthy, correctly, because it is a re-do of something still standing.
      if (servedTurn === undefined) {
        await this.#serialize(() =>
          ctx.log.append(
            [
              // `*.called` BEFORE `effect.completed`: the span fold closes the effect
              // span on `completed`, so attributes attached afterwards would be dropped.
              {
                type: "model.called",
                payload: {
                  key,
                  // THE LEAF, THEN THE RECORD, THEN THE WRAPPER — in that order, and the last
                  // arm is reached only on a live call whose adapter gave no answer, which the
                  // refusal below then fails. `adapter.provider` is the most this engine
                  // honestly knows about such a turn, and it is written because the call
                  // happened and cost money (the FX13 ordering); it is not allowed to stand as
                  // an answer.
                  provider: servingProvider ?? (this.#replay === undefined ? adapter?.provider : recordedProvider) ?? recordedProvider,
                  // `shaped`, not `req`: a `preModel` filter may have rewritten the model, and
                  // journaling the pre-filter value records a call nobody made.
                  model: shaped.model,
                  finishReason: finish,
                  usage: turnUsage,
                  // WHAT WAS ASKED, as a digest. `shaped` for the same reason `model` is: a
                  // `preModel` filter's rewrite is part of the question this run put, and a
                  // digest of `req` would certify a request that was never sent. The whole
                  // object — model, system prompt, transcript and tool specs — because each of
                  // those changes the answer, and a digest that covered only some of them
                  // would report "the same call" for a candidate that moved the rest.
                  requestDigest: digest(shaped),
                },
                actor: SYSTEM_ACTOR("agent"),
                taskId: w.task.taskId,
              },
              {
                type: "effect.completed",
                // The WHOLE turn, not just the text: replay has to reproduce tool calls
                // and accounting, not merely the prose.
                payload: (() => {
                  const rec: RecordedModelTurn = {
                    content: assistant?.content ?? "",
                    finishReason: finish,
                    usage: turnUsage,
                    // WHAT THE `done` FRAME NAMED, INCLUDING WHEN IT NAMED NOBODY. The refusal
                    // below is decided from this field on every path that does not make the call,
                    // exactly as `turnRefusal` is decided from `finishReason` beside it — the
                    // sibling guard was built this way on purpose and this one was not, so a
                    // recorded refusal replayed green and put the refused text on the channel.
                    // Omitted only when there was no frame at all, which is the one case that
                    // must NOT refuse; see `framedProvider`.
                    ...(framedProvider === undefined ? {} : { provider: framedProvider }),
                    ...(assistant?.toolCalls === undefined ? {} : { toolCalls: assistant.toolCalls }),
                  };
                  return { key, result: rec, resultDigest: digest(rec) };
                })(),
                actor: SYSTEM_ACTOR("agent"),
                taskId: w.task.taskId,
              },
            ],
            { taskId: w.task.taskId },
          ),
        );
      }

      // AN ADAPTER THAT WILL NOT SAY WHO SERVED THE TURN — D.7.6, and the same ordering as
      // the truncation refusal below and for the same reason: the call happened and cost money,
      // so `model.called` and `effect.completed` record it first, with `adapter.provider` as
      // the only thing this engine honestly knows. THEN the turn is refused. What it must not
      // do is accept `adapter.provider` and continue — that is the defect being removed, and
      // reinstating it here would restore it for exactly the adapters nobody in this repo
      // wrote. `outputCeilingOf` above is required on `ModelAdapter` and so is this field, so a
      // well-typed adapter cannot reach this arm; an `--extension-module` one can.
      //
      // A SERVED or REPLAYED turn reaches no adapter, and it does not need one: the frame's
      // answer is in the record, so the refusal RE-DERIVES rather than switching itself off.
      // It used to read two live-only locals, which is the shape `replay-fidelity.test.ts`
      // exists to condemn — a faithfully recorded refusal replayed `match: false` with
      // `state.reduced` carrying the exact string the live run had refused.
      if (framedProvider === "") {
        // PATH-INDEPENDENT WORDING, deliberately. This message used to open with
        // `model adapter "<name>"` live and `the recorded turn` in replay, because `adapter` is
        // undefined on the replay path — so a faithfully recorded refusal replayed with a
        // DIFFERENT message and nothing said so: `compare()` has no message frame, so `match`
        // stayed `true`. The adapter's name is still on `details.adapter` for anyone who wants
        // it, which is where a value a reader might branch on belongs anyway.
        //
        // STILL OPEN, and this fix does not reach it: `run/replay.ts` grades statuses, writes
        // and effects, and grades no MESSAGE. Any other refusal whose text depends on the live
        // path diverges silently the same way. That is the general fix and it is larger.
        return {
          status: "failed",
          writes: {},
          usage,
          error: err.validation(
            CODES.E_PROVIDER_BAD_REQUEST,
            `node "${w.node.id}" turn ${String(turn)}: the turn ended ` +
              `without naming the provider that served it — the \`done\` frame's required \`provider\` field was missing ` +
              `or empty. The journal is the only record of which provider answered, and a wrapper's own name is not that ` +
              `record. Refusing the turn rather than attributing it to the wrapper.`,
            { details: { node: w.node.id, turn, adapter: adapter?.provider ?? null } },
          ),
        };
      }

      // A TURN THAT DID NOT END BECAUSE THE MODEL WAS FINISHED IS NOT AN ANSWER — see
      // `turnRefusal`. Checked AFTER the appends on purpose: the call happened and cost money,
      // so `model.called` and `effect.completed` must record it, the reservation must settle at
      // the real cost, and a replay must re-derive the same refusal from the same journal rather
      // than find a turn that started and never finished.
      const refusal = turnRefusal(
        finish,
        `node "${w.node.id}" turn ${String(turn)}`,
        (assistant?.content ?? "").length,
        turnUsage.outputTokens,
        ceiling,
      );
      if (refusal !== undefined) return { status: "failed", writes: {}, usage, error: refusal };

      finalText = assistant?.content ?? finalText;
      const calls = assistant?.toolCalls ?? [];
      if (calls.length === 0) break;

      messages.push(assistant!);
      // DERIVED FROM POSITION, NOT FROM DISPATCH. The ordinal is this call's index in the
      // model's returned array, offset by the calls of every earlier turn — so it is a
      // function of the transcript, which replay has, rather than of the order bodies
      // happened to start. A counter incremented at dispatch gives the same answers today
      // and becomes arrival-ordered the moment intra-turn calls run in parallel, which is
      // invariant 7's failure mode wearing a different hat.
      for (const [i, call] of calls.entries()) {
        const result = await this.#runAgentToolCall(ctx, p, w, call, allowed, nodeApproved, callsSoFar + i);
        messages.push({ role: "tool", content: result.content, toolCallId: call.id });
      }
      callsSoFar += calls.length;
    }

    const schema = schemaOverride ?? (agent?.outputSchema as JSONSchema | undefined);
    const value = parseOutput(finalText, schema);
    if (value.ok === false) {
      return {
        status: "failed",
        writes: {},
        usage,
        error: err.validation(CODES.E_PROVIDER_BAD_REQUEST, `node "${w.node.id}" output did not match its schema: ${value.errors.join("; ")}`),
      };
    }

    // A mutation rides on the agent's structured output rather than a side channel, so
    // it is journaled with the turn that proposed it and replays with it.
    const proposal = extractMutation(value.value, w);
    return {
      status: "succeeded",
      writes: this.#assignWrites(ctx, w.node, undefined, usage, value.value),
      usage,
      ...(proposal === undefined ? {} : { mutation: proposal }),
    };
  }

  /**
   * Rung 3's summarizer, wrapped as a recorded effect.
   *
   * Without the effect boundary the ladder would be nondeterministic: a replay would
   * produce a different summary and every downstream state hash would diverge for a
   * reason that has nothing to do with the graph.
   */
  /**
   * Run a pinned child graph, and map its channels in and out.
   *
   * THE CHILD IS A SEPARATE RUN with its own journal, its own gates, and its own
   * replayable history — not an inlined region of the parent. That is what makes a
   * subgraph worth having: the child is auditable on its own terms, and the parent's
   * journal stays the size of the parent.
   *
   * The invocation is an EFFECT. `subgraph.completed` records the mapped outputs, so a
   * parent replay serves them instead of re-running the child — which matters most when
   * the child did something irreversible.
   */
  async #runSubgraph(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const sub = w.node.subgraph!;
    const key = effectKey(w.task.taskId, "subgraph", 0);

    // Replay: the child ran once, in the recorded past. Running it again would repeat
    // every side effect it had.
    if (this.#replay !== undefined) {
      const recorded = this.#replay.require(key).result as { writes: Record<string, unknown> };
      return { status: "succeeded", writes: { ...recorded.writes }, usage: { ...ZERO_USAGE } };
    }

    // AND THE SAME ON THE LIVE PATH, which is safe here for a reason worth writing down,
    // because "serve the record instead of re-entering the child" is exactly wrong for a child
    // that is only half done — the parent's retry re-enters precisely to advance it.
    //
    // It cannot happen. The three exits below that leave a child unfinished — `awaiting_gate`,
    // not terminal (retryable-unavailable), and terminal-but-not-succeeded — all return BEFORE
    // the append, and that append writes `effect.started` and `effect.completed` in ONE batch.
    // So this key being in `startedEffects` means one thing only: the child reached
    // `succeeded` and these writes are its mapped outputs. A half-done child never put the key
    // there, so nothing here can suppress the re-entry it needs.
    //
    // What this DOES fix is the mirror of the seed's case: a parent that got past its child and
    // then failed used to re-enter, take the `existing !== undefined` branch, re-derive the same
    // writes, and append a SECOND pair under one key.
    const served = await this.#servedEffect(ctx, p, key);
    if (served !== undefined) {
      const recorded = served.result as { writes: Record<string, unknown> };
      return { status: "succeeded", writes: { ...recorded.writes }, usage: { ...ZERO_USAGE } };
    }

    // FROM THE COMPILED GRAPH, not from a resolver. The parent froze every child spec it can
    // reach when it was compiled, so nothing consults a resolver while a Task is executing —
    // the rule `resources/functions.ts` states for code and A22 established for prompts,
    // reaching the third and last kind of content.
    // Optional-chained: `attach()` is public and `RunGraph` is exported, so a graph produced by
    // an older build has no `subgraphs` at all, and a `TypeError` is a worse answer than the
    // typed refusal two lines down.
    const childSpec = ctx.graph.subgraphs?.[sub.ref];
    if (childSpec === undefined) {
      throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `subgraph "${sub.ref}" does not resolve to a GraphSpec`);
    }
    const childGraph = this.#compileChild(sub.ref, childSpec, ctx.graph);

    // DERIVED, like every other id here: replay and a restart must find the same child.
    const childRunId = `${ctx.runId}~${w.task.taskId}` as RunId;

    const scope = scopeFor(p, ctx.graph.spec.channels, w.task.branch);
    const inputs: Record<string, unknown> = {};
    for (const [childCh, parentCh] of Object.entries(sub.inputs)) inputs[childCh] = scope[parentCh];

    // The slice is carved from what the PARENT still has, not from its original limit:
    // a subgraph reached late in an expensive run gets less, which is correct.
    const share = sub.budgetShare ?? 1;
    const slice = Number.isFinite(ctx.policy.remainingUsd) ? ctx.policy.remainingUsd * share : undefined;

    const existing = await this.projection(childRunId);
    if (existing === undefined) {
      // THE REFERENCE IS JOURNALED FIRST, and the order matters more than it looks.
      // `subgraph.started` is the only thing that tells a later `cancel` this child exists,
      // and appending it after `submit` left a permanent hole: a crash between the two
      // produced a live child run the parent had no record of, and the retry takes the
      // `existing !== undefined` branch below, which never writes the event. One lost
      // reference, forever, for a run that is still answerable. Writing it first inverts the
      // failure — a reference to a child that does not exist yet, which the cascade skips
      // and the retry re-states.
      await this.#serialize(() =>
        ctx.log.append(
          [
            {
              type: "subgraph.started",
              payload: { childRunId, ref: sub.ref, graphHash: childGraph.graphHash, budgetUsd: slice ?? null },
              actor: SYSTEM_ACTOR("executor"),
              taskId: w.task.taskId,
            },
          ],
          { taskId: w.task.taskId },
        ),
      );
      // THE CHILD INHERITS THE PARENT'S PRINCIPAL. A child run exists only because someone
      // started the parent, so that person started this too — and the alternatives are both
      // wrong: a synthetic `(subgraph)` subject would be a name that matches nothing while
      // reading like one that does, and leaving it absent would make a delegated run
      // invisible to the very person who caused it. It is also what makes a mirror gate's
      // inherited exclusion mean the same thing in both runs.
      // THE PARENT'S CEILING TRAVELS, and it has to be built BEFORE `submit` — that is where
      // the child's `RunContext` is created, and `#contextFor` returns an existing one
      // untouched, so a bound applied afterwards would apply to nothing.
      //
      // "Never widened" has to survive delegation or it means nothing, which is precisely the
      // shape T6 turned out to be: a guarantee a child escaped. The parent's own `subgraph`
      // node reaches no tool, so the COMPILE-time check cannot see this one at all.
      this.#contextFor(childRunId, childGraph, slice === undefined ? undefined : { runUsd: slice }, ctx.grantBound);
      await this.submit({
        graph: childGraph,
        inputs,
        runId: childRunId,
        workflow: sub.ref,
        ...(slice === undefined ? {} : { budgetUsd: slice }),
        ...(p.submittedBy === undefined ? {} : { submittedBy: p.submittedBy }),
      });
    } else {
      // THE PARENT'S CEILING TRAVELS on the resume path too — `#contextFor` returns an existing
      // context untouched, so this only matters when the process is new.
      this.#contextFor(childRunId, childGraph, undefined, ctx.grantBound);
      this.attach(childRunId, childGraph);
      // ONE HUMAN DECISION, not two. If the parent's gate was answered, that answer was
      // about the child's question — forward it rather than asking again in the child's
      // own console.
      const forwarded = await this.#forwardGateDecision(p, w, childRunId);
      if (forwarded !== undefined) {
        // A REJECTION IS THE PARENT'S OUTCOME TOO, and it is the same outcome the
        // short-circuit in `#executeTask` used to produce before a mirror's decision had
        // to travel: E_HUMAN_APPROVAL_REQUIRED, carrying the human's own reason. The
        // difference is that the child has now been told — either rejected through its own
        // gate, or cancelled when that gate was already answered elsewhere. Nothing is
        // left suspended behind a refusal.
        await this.#endChildRun(childRunId, `the parent rejected this delegation: ${forwarded.justification ?? "no reason given"}`);
        return this.#applyGateDecision(forwarded, w.node, ctx.graph.plans[w.node.id]?.outboundEdges ?? []);
      }
    }

    const childP = await this.advance(childRunId);

    if (childP.status === "awaiting_gate") {
      // DETERMINISTIC, by the journal's own order rather than by however the projection
      // happens to enumerate its map — the same rule `lastDecidedGate` uses. Which gate a
      // mirror stands in for is now durable, so the arbitrariness no longer creates a
      // hole; it would still make a replay depend on map iteration order.
      const open = oldestOpenGate(childP);
      if (open === undefined) {
        // Suspended on a gate, with no gate. Nothing to mirror and nothing a human could
        // answer, so say so rather than raising a mirror bound to nothing.
        return {
          status: "failed",
          writes: {},
          usage: { ...ZERO_USAGE },
          error: err.internal(CODES.E_SUBGRAPH_FAILED, `subgraph "${sub.ref}" is awaiting a gate it does not have`, {
            details: { childRunId },
          }),
        };
      }
      return {
        status: "gate",
        writes: {},
        usage: { ...ZERO_USAGE },
        gate: {
          policyRef: `subgraph:${sub.ref}`,
          payload: {
            subgraph: sub.ref,
            childRunId,
            childNode: open.nodeId,
            childGateId: open.gateId,
            channels: childP.channels,
          },
          // THE MIRROR IS THE GATE A HUMAN ACTUALLY ANSWERS, so it must be bound by the
          // list the child declared — and bound to the gate that declared it. Without the
          // first, the child's approvers were consulted by nobody. Without the second, the
          // inheritance was still defeated by any second child gate: the forward re-picked
          // its target later and could land on a gate whose list nobody had been checked
          // against.
          auth: mirrorAuthorizationOf(open),
          mirrorOf: open.gateId,
        },
      };
    }

    const usage: UsageRecord = { ...ZERO_USAGE, costUsd: childP.usage.costUsd, wallMs: childP.usage.wallMs };

    // NOT FINISHED IS NOT FAILED, and `!== "succeeded"` conflated them.
    //
    // `advance` returns as soon as a run has nothing RUNNABLE, which is not the same as
    // nothing left to do: a child whose only task is in retry backoff comes back
    // `status: "running"`, and so does one starved by `maxParallelism`. Both were reported
    // to the parent as E_SUBGRAPH_FAILED — a permanent, non-retryable verdict on a child
    // that was about to continue.
    //
    // The honest answer is retryable-unavailable: the parent's own retry policy re-enters
    // this node, which re-advances the child, which is precisely the "come back later" this
    // needs. `internal` would be wrong twice over — it is not a bug in Loom, and its class
    // is not retryable, so the first backoff would have killed the run.
    if (!isTerminal(childP.status)) {
      return {
        status: "failed",
        writes: {},
        usage,
        error: err.unavailable(
          CODES.E_SUBGRAPH_FAILED,
          `subgraph "${sub.ref}" has not finished (${childP.status}) — it has work left, so this is a retry rather than a failure`,
          { details: { childRunId, status: childP.status } },
        ),
      };
    }
    if (childP.status !== "succeeded") {
      return {
        status: "failed",
        writes: {},
        usage,
        error: err.internal(
          CODES.E_SUBGRAPH_FAILED,
          `subgraph "${sub.ref}" ended ${childP.status}: ${childP.error?.message ?? "no reason recorded"}`,
          { details: { childRunId, status: childP.status } },
        ),
      };
    }

    // A CHILD'S OUTPUT MAY BE A HANDLE, and mapping it out unresolved hands the parent a
    // `{$payload: …}` reference wearing the shape of an answer — the run then reports
    // `succeeded` on the wrong value, which is worse than failing.
    //
    // `#resolveReads`'s docstring enumerates the two ways a channel is read without being in
    // `observedChannels` and says `externalisableChannels` removes both from the eligible set.
    // Both of those are INPUTS. This is the other direction: the child externalised its own
    // channel on its own journal, under its own `RunId`, and the exclusion at the parent's end
    // cannot reach it. So it is resolved here, against the CHILD's run id, which is the only
    // id its payloads were stored under.
    //
    // NO STORE PLUS A HANDLE IS A REFUSAL, the same rule and the same code `#resolveReads`
    // uses: the value exists and is simply not reachable from this process, and handing the
    // parent the handle would let it succeed on a reference.
    const writes: Record<string, unknown> = {};
    for (const [parentCh, childCh] of Object.entries(sub.outputs)) {
      const ref = childP.external[childCh];
      if (ref === undefined) {
        writes[parentCh] = childP.channels[childCh];
        continue;
      }
      const store = this.#payloads;
      if (store === undefined) {
        throw err.internal(
          CODES.E_PAYLOAD_UNRESOLVED,
          `subgraph "${sub.ref}" maps its channel "${childCh}" out to "${parentCh}", and the child externalised ` +
            `that value — this engine was constructed with no \`payloads\` store, so it cannot be read back`,
          { details: { nodeId: w.node.id, childRunId, childChannel: childCh, parentChannel: parentCh } },
        );
      }
      writes[parentCh] = await store.get(childRunId, ref);
    }

    await this.#serialize(() =>
      ctx.log.append(
        [
          { type: "effect.started", payload: { key, kind: "subgraph", attempt: 1 }, actor: SYSTEM_ACTOR("executor"), taskId: w.task.taskId },
          {
            type: "effect.completed",
            payload: { key, result: { writes }, resultDigest: digest(writes) },
            actor: SYSTEM_ACTOR("executor"),
            taskId: w.task.taskId,
          },
          {
            type: "subgraph.completed",
            payload: { childRunId, ref: sub.ref, status: childP.status, usage: childP.usage, outputs: Object.keys(writes) },
            actor: SYSTEM_ACTOR("executor"),
            taskId: w.task.taskId,
          },
        ],
        { taskId: w.task.taskId },
      ),
    );

    // The child's spend counts against the parent's budget. Without this a graph could
    // exceed its declared cost by nesting, which is the one thing GRAPH009 proves at
    // compile time cannot happen.
    // THE WHOLE RECORD, so the child's tokens and provider time reach the parent's ceilings the
    // way its dollars already did — and so that `PolicyEngine`'s three totals agree with the
    // `p.usage` a restart re-seeds them from, which folds `subgraph.completed` into all four
    // fields at once.
    ctx.policy.settle(ctx.policy.reserve(`subgraph:${w.node.id}`, 0), childP.usage);

    return { status: "succeeded", writes, usage };
  }

  /**
   * Answer THE child gate this mirror was raised for, with the decision the human gave.
   *
   * "The" is the whole fix. This used to re-derive its target as "the first open gate in
   * the child", independently of the identical guess `#runSubgraph` made when it raised
   * the mirror and inherited approvers. Two unbound picks: answer any unrestricted child
   * gate between them — which is ordinary queue work, not an attack — and the restricted
   * gate slid under a mirror that had inherited nothing, so `executor:subgraph` approved,
   * as itself, a charge the same person had just been refused at.
   *
   * Now it resolves `settled.mirrorOf` or nothing. A target that is no longer open means
   * somebody answered it in the child's own console, or this forward already happened;
   * either way the human's answer has no question left, and the caller re-raises a fresh
   * mirror bound to whatever the child is actually waiting on, inheriting THAT gate's
   * approvers. Skipping is journaled by absence, which is legible: the child's log shows
   * its own `gate.decided` and no `executor:subgraph` entry beside it.
   *
   * Returns the parent-side gate record when it carried a REJECTION, because that is the
   * parent's outcome too and the caller has to produce it. Only a literal `reject` is
   * returned: an `edit` or `redirect` is refused at the door for a mirror, so one can only
   * reach here out of a journal written before that rule — it is carried to the child as a
   * refusal like anything that is not `approve`, and the parent then fails on the child's
   * own status rather than applying writes the child never saw.
   */
  async #forwardGateDecision(p: RunProjection, w: Wave, childRunId: RunId): Promise<GateRecord | undefined> {
    const settled = lastDecidedGate(p, w.task.taskId);
    if (settled?.mirrorOf === undefined) return undefined;

    // APPROVE IS THE ONLY DECISION THAT MEANS "GO AHEAD". `#authorize` refuses `edit` and
    // `redirect` on a mirror outright, so nothing else should reach here — and if a
    // journal written before that rule did, carrying it as a refusal is the safe reading.
    const rejected = settled.decision !== "approve";
    const decision: GateDecision = rejected
      ? { kind: "reject", reason: settled.justification ?? "rejected on the parent graph" }
      : { kind: "approve" };

    const childP = await this.projection(childRunId);
    const target = childP === undefined ? undefined : gateOf(childP, settled.mirrorOf);
    if (target?.state === "open") {
      await this.#resolveGateAsSystem(childRunId, {
        gateId: target.gateId,
        decision,
        actor: SYSTEM_ACTOR("executor:subgraph"),
        idempotencyKey: `parent:${w.task.taskId}`,
      });
    }
    return settled.decision === "reject" ? settled : undefined;
  }

  /**
   * Stop a child run the parent has finished with, if it is still going.
   *
   * A rejected delegation used to leave the child suspended on an open gate with nobody
   * left who would answer it — one leaked run, and one leaked journal, per refusal. The
   * forward above closes the common case by rejecting the child's own gate; this covers
   * the rest, including a gate that was answered elsewhere while the parent deliberated.
   */
  async #endChildRun(childRunId: RunId, reason: string): Promise<void> {
    const p = await this.projection(childRunId);
    if (p === undefined || isTerminal(p.status)) return;
    // NOT the human who rejected the mirror, and not `system:operator` either. The rejection
    // is journaled in the PARENT with its decider; what happened here is that the executor
    // stopped a delegation the parent refused, and `GateRecord.decidedBy` carries a kind
    // rather than a subject (`projection.ts`) so the person is not available to name. Saying
    // `operator` would claim an operator cancelled this run, and nobody did.
    // NOT `executor:subgraph`, though that is who is acting. That exact string is a member
    // of `GATE_SYSTEM_ACTORS`, whose docstring says adding a name to it is granting a
    // component the right to satisfy a human approval — so putting it on `operator.command`
    // and `run.cancelled`, where it is not an entitlement claim, blurs what the list means
    // for anything that later filters on it. A distinct name says the same thing and claims
    // nothing.
    await this.cancel(childRunId, reason, SYSTEM_ACTOR("executor:subgraph-cancel"));
  }

  /** Compile a child graph once per (ref, spec). The spec is per-run now, so the ref alone stales. */
  #compileChild(ref: string, spec: GraphSpec, parent: RunGraph): RunGraph {
    // KEYED BY EVERY INPUT THE COMPILE HAS, which the ref alone stopped being the moment the
    // spec started coming from a per-run `RunGraph`: two runs on one long-lived process can
    // carry different frozen children for one ref, and the cache served the first run's
    // compiled graph to the second — measured, two parents with identical `graphHash` and
    // different frozen children both produced the first one's answer. The parent's hash joins
    // the key for the same reason one step on: the compile now also depends on what the PARENT
    // froze, so two parents sharing a child spec across a promotion would otherwise share the
    // first one's prompts.
    const key = `${ref}@${digest(spec)}@${parent.graphHash}`;
    const hit = this.#childGraphs.get(key);
    if (hit !== undefined) return hit;
    // BOUNDED, because widening that key widened this cache. It held compiled `RunGraph`s for
    // the life of the process with nothing to evict them: `#retire` declines to touch it, for a
    // correct reason — the cache is keyed by ref rather than by run, so per-run eviction would
    // key a shared cache by the wrong thing — which nonetheless left it growing forever on the
    // one path meant to stay up for months. Adding the spec digest and then the parent hash each
    // bought a real freeze and each multiplied the number of distinct entries one ref can hold.
    //
    // A COUNT CAP IS RIGHT HERE AND WRONG NEXT DOOR. `HumanGateBroker.#ephemeral` drops only a
    // CLOSED gate's payload, because losing a live gate's route changes what the system does.
    // Here an eviction costs a recompile, and the recompile is the same one the cache was
    // standing in for.
    //
    // "THE SAME ONE" IS NOT "BYTE-IDENTICAL", and the stronger claim was written here first and
    // is false. ONE of `compileOrThrow`'s inputs is live rather than frozen: `tools.manifests()`
    // reads a registry an embedder may `register`/dispose at any time, which feeds `classFloor`.
    //
    // It used to be TWO. The other was `resolveManifest` walking only the PARENT's nodes, so a
    // child's own `function/…` and `prompt/…` refs missed the frozen map and went to the live
    // resolver on every compile — measured, a probe recording `resolve` during `advance` saw
    // `function/double@stable` three times. `0f605a9` made the manifest walk the frozen child
    // specs too, which closed it; this paragraph outlived the fix by two commits and would have
    // sent a reader to re-fix something already fixed.
    // So a recompile that straddles a promotion or a tool disposal can differ, and for a
    // long-lived subgraph Task the window is human-sized.
    //
    // That is a REAL limit of the freeze rather than of this cap — an uncached compile has it
    // too, and always did — but a cap makes recompiles reachable on purpose, so it is recorded
    // where the eviction is. Closing it means excluding entries a live run still references,
    // which needs a run→key index this class does not have.
    //
    // Insertion order and the shape of the eviction follow `GateCallbackRouter.#admitRow`,
    // which made the same trade first.
    if (this.#childGraphs.size >= MAX_CACHED_CHILD_GRAPHS) {
      const oldest = this.#childGraphs.keys().next();
      if (oldest.done !== true) this.#childGraphs.delete(oldest.value);
    }
    const compiled = compileOrThrow({
      spec,
      // WHAT THE PARENT FROZE, THEN THE LIVE STORE — `frozenFirst` covers `resolve`, `document`
      // and `subgraph` alike.
      //
      // Replacing the resolver WHOLESALE starves the child: its own `function/…` and `prompt/…`
      // refs are not in the PARENT's manifest, so every one fails `GRAPH015_RESOURCE_NOT_FOUND`
      // — 38 tests. That measurement is about the WIDE substitution and says nothing about this
      // narrow one, which overrides the single hook the parent has an answer for.
      //
      // Without it the freeze stops one level down: the GRANDCHILD spec is read from the live
      // resolver while the parent's Task is executing, which is verbatim the swap A24 exists to
      // prevent, and every deep entry `resolveSubgraphs` collected is dead.
      resolver: frozenFirst(parent, this.#resolver),
      tools: this.tools.manifests(),
      tenantCapabilities: this.#policyOpts.granted,
    });
    this.#childGraphs.set(key, compiled);
    return compiled;
  }

  /**
   * WHAT THE ADAPTER SAID THIS TURN WOULD COST, ASKED ONCE AND WRITTEN DOWN.
   *
   * `estimateOf(req)` and `outputCeilingOf(req)` are calls INTO the adapter, and three refusals
   * in `#runAgent` are computed from their answers: the node `costUsd` ceiling, the node `tokens`
   * ceiling, and the run-level `PolicyEngine.reserve`. They were the one such call nobody
   * journaled, so a replay — which reaches no adapter — re-derived them as `?? 0` and reached
   * DIFFERENT refusals than the run it claims to reproduce. This is the repo's own rule applied
   * to them: every nondeterministic call is recorded under a derived key, and replay serves the
   * record.
   *
   * BOTH NUMBERS IN ONE EFFECT, because they answer one question about one request and are read
   * together. Two effects would mean two keys, two ordinals to keep in step, and a window in
   * which a turn is half-priced.
   *
   * THE KEY IS `taskId:quote:<turn>` — the same task coordinate and the same ordinal as the
   * `model` effect of the turn it prices. `TaskId` is derived (`nodeId@branchPath#iteration`) and
   * the turn is the loop index, so a retry, a resumed task and a replay all recompute it. It is
   * deliberately NOT `taskId:model:<turn>`: a quoted turn that a budget then refuses makes no
   * model call, so the two are different facts and collapsing them would put a completion under
   * a key whose call never happened.
   *
   * THREE PATHS, AND THE APPEND IS WHAT THEY SHARE:
   *   - LIVE — ask the adapter, record the answer.
   *   - LIVE RE-EXECUTION — `#servedEffect` hands back the recorded answer and appends nothing,
   *     so a second attempt prices the turn exactly as the first did rather than at whatever the
   *     adapter now says. Same reason the model turn beside it is served.
   *   - REPLAY — serve the record and append it again, so the shadow journal has the same events
   *     under the same keys as the original. That is `#randomSeedEffect`'s lesson, measured
   *     there: a replay branch that returns before its append leaves the shadow two events
   *     shorter per body and `spansFrom` builds a different tree.
   *
   * AND THE FOURTH CASE, WHICH IS AN OLD JOURNAL. A recording written before this effect existed
   * has no quote to serve, and none can be invented. It gets `outputCeiling: undefined` and
   * `estimateUsd: 0` — verbatim the `?? 0` that stood before — which is a LOWER bound and
   * therefore sound in the only direction that matters: such a replay can fail to reproduce a
   * refusal the recording made, and can never invent one it did not. NOTHING IS APPENDED in that
   * case, deliberately: a fabricated quote in a shadow journal would be this file claiming an
   * adapter answered when none was asked.
   *
   * A RECORD THIS BUILD CANNOT READ IS A DIVERGENCE, not a fallback to zero. Falling back would
   * turn a corrupt row into a silently skipped refusal, which is loosening; refusing is always
   * allowed.
   */
  async #quoteEffect(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    req: ModelRequest,
    turn: number,
    adapter: ModelAdapter | undefined,
  ): Promise<{ readonly estimateUsd: number; readonly outputCeiling: number | undefined }> {
    const key = effectKey(w.task.taskId, "quote", turn);
    const write = async (q: RecordedQuote): Promise<void> => {
      // ONE BATCH. The write-ahead `effect.started` that `journal/sqlite.ts` describes exists so
      // a crash mid-call is distinguishable from a call never made; a quote is two synchronous
      // questions with no such window, so the pair goes down together — the shape
      // `#randomSeedEffect` and the subgraph effect already use, and it keeps
      // `effect.completion-has-a-start` satisfied either way.
      await this.#serialize(() =>
        ctx.log.append(
          [
            { type: "effect.started", payload: { key, kind: "quote", attempt: 1 }, actor: SYSTEM_ACTOR("agent"), taskId: w.task.taskId },
            { type: "effect.completed", payload: { key, result: q, resultDigest: digest(q) }, actor: SYSTEM_ACTOR("agent"), taskId: w.task.taskId },
          ],
          { taskId: w.task.taskId },
        ),
      );
    };

    const served = await this.#servedEffect(ctx, p, key);
    if (served !== undefined) return recordedQuote(served.result, key);

    if (this.#replay !== undefined) {
      if (!this.#replay.has(key)) return { estimateUsd: 0, outputCeiling: undefined };
      const recorded = recordedQuote(this.#replay.require(key).result, key);
      await write(recorded);
      return recorded;
    }

    if (adapter === undefined) {
      // Unreachable by construction — `#runAgent` binds `adapter` to `models.require()` on every
      // path that is not a replay, and the replay path returned above. Refusing rather than
      // defaulting, because a default here is a number nobody vouched for, which is exactly what
      // `outputCeilingOf` exists to refuse.
      throw err.internal(CODES.E_INTERNAL, `node "${w.node.id}" turn ${String(turn)}: no model adapter to price the turn against`);
    }
    const quote: RecordedQuote = {
      estimateUsd: estimateUsdOf(adapter, req, `node "${w.node.id}"`),
      outputCeiling: outputCeilingOf(adapter, req, `node "${w.node.id}"`),
    };
    await write(quote);
    return quote;
  }

  /**
   * `ordinal` is the TURN, not a constant.
   *
   * This keyed on a literal `0` while it had exactly one call site — `assembleContext`'s
   * rung 3, called once before the turn loop. That was safe only because the section it
   * summarised (`turns`) was never populated, so it never actually ran. The moment a
   * transcript is folded per turn, a fixed ordinal makes every summary in a task collide on
   * one key: the last write wins, and replay serves that one summary for every turn that
   * asked for a different one. Invariant 3 is the general form — a key that does not
   * distinguish two calls is not derived, it is merely stable.
   */
  async #summarizeEffect(ctx: RunContext, p: RunProjection, w: Wave, text: string, ordinal = 0): Promise<string> {
    const key = effectKey(w.task.taskId, "summarize", ordinal);
    if (this.#replay !== undefined) return String(this.#replay.require(key).result);
    // A ladder rung is a model call like any other, and a re-execution that folds the same
    // prefix asks the same question. Serving it keeps the compaction deterministic across
    // attempts — which the transcript downstream of it depends on.
    const served = await this.#servedEffect(ctx, p, key);
    if (served !== undefined) return String(served.result);

    const adapter = this.models.require();
    const req: ModelRequest = {
      model: "compaction",
      system: "Summarize the following prior turns in under 200 words. Preserve decisions and identifiers.",
      messages: [{ role: "user", content: text }],
      tools: [],
    };
    // ASKED BEFORE THE CALL, not after it, and for the same reason `#runAgent` asks before its
    // reservation: an adapter that cannot say what ceiling it is about to send is refused
    // before it spends money, rather than after. The number is what a truncation refusal names.
    const ceiling = outputCeilingOf(adapter, req, `node "${w.node.id}" context summary`);
    let summary = "";
    let finish = "stop";
    let outputTokens = 0;
    for await (const ev of adapter.stream(req, ctx.abort.signal)) {
      if (ev.type === "done") {
        summary = ev.message.content;
        finish = ev.finishReason;
        outputTokens = ev.usage.outputTokens;
      }
    }
    // THE SECOND SITE WITH THE SAME DEFECT, and the quieter one: a truncated summary is a
    // silent DELETION of the prior turns it was folding, and the ladder writes it in their
    // place with nothing to say the tail is missing. FX13 was found on the agent turn; this
    // one had never been looked at. Raised before the journal append, unlike `#runAgent`'s:
    // there is no answer to record here, only a replacement that must not be made.
    const refusal = turnRefusal(finish, `node "${w.node.id}" context summary ${String(ordinal)}`, summary.length, outputTokens, ceiling);
    if (refusal !== undefined) throw refusal;

    await this.#serialize(() =>
      ctx.log.append(
        [
          { type: "effect.started", payload: { key, kind: "summarize", attempt: 1 }, actor: SYSTEM_ACTOR("context"), taskId: w.task.taskId },
          { type: "effect.completed", payload: { key, result: summary, resultDigest: digest(summary) }, actor: SYSTEM_ACTOR("context"), taskId: w.task.taskId },
        ],
        { taskId: w.task.taskId },
      ),
    );
    return summary;
  }

  async #runAgentToolCall(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    call: ModelToolCall,
    allowed: ReadonlySet<string>,
    nodeApproved: boolean,
    ordinal: number,
  ): Promise<ToolResult> {
    if (!allowed.has(call.name)) {
      // The injection-containment path: the model asked for something the node never
      // declared, so it is refused before dispatch rather than policed inside the tool.
      const why = `tool "${call.name}" is not available to node "${w.node.id}"`;
      return { content: why, isError: true, error: err.policy(CODES.E_CAP_DENIED, why) };
    }
    const tool = this.tools.get(call.name);
    if (tool === undefined) {
      const why = `unknown tool "${call.name}"`;
      return { content: why, isError: true, error: err.validation(CODES.E_TOOL_NOT_FOUND, why) };
    }
    return this.#invokeTool(ctx, p, w.task, tool, call.arguments, ordinal, nodeApproved);
  }

  // ── THE single tool dispatch path ─────────────────────────────────────────

  /**
   * Used by `tool` nodes and by tools called inside `agent` nodes alike. There is no
   * second copy of this sequence anywhere, which is the whole point: EAgent's
   * duplicate guard chain was a documented drift hazard and a silent privilege bug
   * waiting to happen.
   */
  async #invokeTool(
    ctx: RunContext,
    /** The projection as it stood when this ATTEMPT began — the set of effects a re-execution
     *  may be served from. Taken as a parameter rather than re-projected, because a fresh fold
     *  mid-attempt would include this attempt's own appends. */
    p: RunProjection,
    task: TaskRecord,
    tool: ToolDefinition,
    rawArgs: unknown,
    ordinal: number,
    /** True when `#executeTask` already ran the full chain for this node and a human, if
     *  asked, said yes. Only a `tool` node can claim it; an agent's tool choice was never
     *  seen by that chain. */
    nodeApproved = false,
    /**
     * Which effect NAMESPACE this dispatch keys into. `tool` is a call the graph asked for;
     * `compensate` is one undoing a call the graph already made.
     *
     * TWO NAMESPACES BECAUSE THE ORDINALS MEAN DIFFERENT THINGS. A tool ordinal is positional —
     * where the call sat in the body's sequence — and a compensation's is the SEQ of the
     * `tool.called` it undoes. Sharing one namespace would let a body's second call and the undo
     * of the call at seq 1 collide on `taskId:tool:1`, and serve-by-key would hand one of them
     * the other's result. `kind` travels into `effect.started` as well as into the key, because
     * `journal/audit.ts`'s `effect.kind-matches-its-key` checks exactly that the two agree — they
     * were separate lists once and two of four sites had already drifted.
     */
    effectKind: "tool" | "compensate" = "tool",
  ): Promise<ToolResult> {
    const key = effectKey(task.taskId, effectKind, ordinal);

    // 0 — THE CALL THAT ALREADY HAPPENED. This is the payoff of serve-by-key and the reason
    // `#retryDecision` can now narrow: a Task that ran this tool, completed it, and then failed
    // for some other reason gets the recorded result back instead of a second real invocation.
    //
    // BEFORE THE GUARDS, not after, and deliberately. Validation, policy, the gate and the hold
    // all decide whether this call MAY happen; it already did. Re-deciding could only refuse an
    // action that is done, handing the model an error for a charge that went through — the
    // worst of the available answers.
    //
    // The name is still pushed below, because `#recordEvidence` deletes `ctx.toolCalls` per
    // attempt: without it the retry's n-gram would be missing every call it was served, and E5
    // would judge a sequence the node did not make.
    //
    // A RECORDED ERROR IS NOT A RECORDED ACTION — see `isServedToolResult`. Serving one would
    // turn every retry of a briefly-unreachable source into a no-op loop that re-reads the same
    // failure until `maxAttempts`, which is the layer retry exists for. Measured: three suites
    // went red on exactly that, `tool-refusal-class`'s control among them.
    const served = await this.#servedToolEffect(ctx, p, key, {
      name: tool.name,
      version: tool.version,
      argsDigest: digest(rawArgs ?? {}),
    });
    if (served !== undefined && isServedToolResult(served.result)) {
      const calls = ctx.toolCalls.get(task.taskId) ?? [];
      calls.push(tool.name);
      ctx.toolCalls.set(task.taskId, calls);
      return served.result as ToolResult;
    }

    // 1 — validate
    const first = validate(tool.parameters, rawArgs);
    if (!first.ok) {
      // A VALIDATION FAILURE, NOT AN OUTAGE. These arguments will not fit this schema on the
      // second attempt either, and before the class was carried they were re-sent to the cap.
      const why = `invalid arguments for ${tool.name}:\n- ${first.errors.join("\n- ")}`;
      return { content: why, isError: true, error: err.validation(CODES.E_TOOL_SCHEMA_INVALID, why) };
    }

    // 1.5 — THE EXTENSION SEAM. `preTool` may BLOCK the call or REWRITE its arguments, and it
    // runs here — after the schema check, before policy — for two reasons. Rewritten arguments
    // must be the ones policy judges, or a guard that redacts a secret would be authorising the
    // unredacted call; and a hook that blocks should cost nothing, so it decides before the
    // policy engine is asked. It cannot widen anything: policy still runs afterwards and
    // `narrowToolDecision` reads only `block`/`reason`/`args`, dropping any field a hook
    // invents. This is also the argument-level policy the register says has "no home" —
    // `PolicyEngine.decide` authorises on the tool's static class and never sees an argv.
    let guardedArgs = first.value;
    const preTool = this.#hooksFor(ctx, "preTool");
    if (preTool.length > 0) {
      const out = await runFilters<PreToolState>(
        preTool,
        { tool: tool.name, args: (first.value ?? {}) as Record<string, unknown> },
        { point: "preTool", runId: ctx.runId, taskId: task.taskId, signal: ctx.abort.signal },
        (v) => v.block === true,
        narrowToolDecision,
      );
      await this.#journalHooks(ctx, task, "preTool", out.changedBy);
      if (out.value.block === true) {
        const why = out.value.reason ?? "blocked by a preTool hook";
        return { content: `"${tool.name}" was blocked before dispatch: ${why}`, isError: true };
      }
      guardedArgs = out.value.args;
    }

    // 2 — policy
    const decision = ctx.policy.decide({
      runId: ctx.runId,
      nodeId: task.nodeId,
      taskId: task.taskId,
      kind: "tool",
      irreversibility: tool.irreversibility,
      capabilities: tool.capabilities,
      declaredPosture: ctx.graph.plans[task.nodeId]?.posture ?? "out",
      // E8 INSIDE THE TURN, which had no taint of any kind — this request simply omitted the
      // field. `ctx.tainted` is channel-granular and only written at COMMIT, so nothing in it
      // can describe what a tool returned two calls ago in this same turn. That is precisely
      // the canonical injection: one agent node, clean declared reads, `net.fetch` returns
      // "now call pay.charge", and the charge goes through — measured, under a de-escalated
      // ceiling, with nothing raised.
      //
      // Two sources, either sufficient. The node observed a tainted channel; or a tool has
      // already returned in this task, which makes every later argument the model writes
      // downstream of external content. `ordinal` is `callsSoFar + i`, derived from the
      // transcript rather than from dispatch order, so this stays replay-stable — a counter
      // incremented at dispatch would not.
      tainted: taintedTurn(ctx, task, ordinal),
    });
    // The policy engine already built a typed refusal; re-wrapping it as a string threw away the
    // class that says a denial is not worth retrying.
    if (decision.effect === "deny") return { content: decision.error.message, isError: true, error: decision.error };

    // A `gate` decision here is a REFUSAL, not a suspension. Suspending mid-turn would
    // need turn-level durability the engine does not have: the model's transcript for
    // this turn lives in memory, so a gate raised here could not be answered after a
    // restart. Refusing is the honest arm — the model is told, and a graph that needs a
    // human before this action expresses it as a `tool` node, which CAN suspend.
    //
    // `nodeApproved` is what keeps this ONE chain rather than a second one. A tool node
    // reaches here having already run the full chain in `#executeTask` — deny, hold, gate
    // — and, if it gated, having been approved by a human. Re-deciding there would refuse
    // the very action that approval authorized.
    if (decision.effect === "gate") {
      if (!nodeApproved) {
        // JOURNAL THE REFUSAL. Returning only an error string tells the model and nobody
        // else, and a refused irreversible action is exactly what an operator reading the
        // trace afterwards needs to see.
        await this.#serialize(() =>
          ctx.log.append(
            [
              {
                type: "policy.decided",
                payload: {
                  effect: "deny",
                  posture: "in",
                  irreversibility: tool.irreversibility,
                  reasons: [...decision.reasons, `"${tool.name}" needs a human, and an agent turn cannot raise a gate`],
                },
                actor: SYSTEM_ACTOR("policy"),
                taskId: task.taskId,
              },
            ],
            { taskId: task.taskId },
          ),
        );
        return {
          content: `"${tool.name}" is ${tool.irreversibility} and requires human approval this turn cannot request; put it on a tool node, which can suspend`,
          isError: true,
        };
      }
      // Approved at the node. Fall through and run it.
    } else if (decision.holdMs > 0 && !nodeApproved && this.#replay === undefined) {
      // The pre-irreversible hold (D4 deviation 5), on the model's path as well as the
      // node's. Without it "the supervisor may interrupt" is a promise the system keeps
      // only for tools a graph author named — never for the ones a model chose. A tool
      // node already served its window in `#executeTask`; a second would double it.
      await this.#serialize(() =>
        ctx.log.append(
          [
            {
              type: "action.pending",
              payload: {
                nodeId: task.nodeId,
                irreversibility: tool.irreversibility,
                windowMs: decision.holdMs,
                toolName: tool.name,
              },
              actor: SYSTEM_ACTOR("policy"),
              taskId: task.taskId,
            },
          ],
          { taskId: task.taskId },
        ),
      );
      await this.#sleep(decision.holdMs, ctx.abort.signal);
      if (ctx.abort.signal.aborted) {
        return { content: `"${tool.name}" was interrupted during the intervention window`, isError: true };
      }
    }

    // 3 — re-validate after any rewrite, then execute
    const final = validate(tool.parameters, guardedArgs);
    if (!final.ok) return { content: `invalid arguments after guards:\n- ${final.errors.join("\n- ")}`, isError: true };

    const started = this.#now();
    // Ordered, and recorded before the call: E5 asks what this node TRIED, and a
    // sequence that ends in a failure is exactly the novel one worth noticing.
    const calls = ctx.toolCalls.get(task.taskId) ?? [];
    calls.push(tool.name);
    ctx.toolCalls.set(task.taskId, calls);

    await this.#serialize(() =>
      ctx.log.append(
        [{ type: "effect.started", payload: { key, kind: effectKind, attempt: 1 }, actor: SYSTEM_ACTOR("tool-executor"), taskId: task.taskId }],
        { taskId: task.taskId },
      ),
    );

    let result: ToolResult;
    try {
      if (this.#replay !== undefined) {
        // A tool body is NEVER reached on replay — that is what makes replaying a
        // run with an irreversible action safe.
        result = this.#replay.require(key).result as ToolResult;
      } else {
      result = await tool.execute(final.value as Record<string, unknown>, {
        taskId: task.taskId,
        signal: ctx.abort.signal,
        progress: (chunk) => {
          // Streams to the UI; never enters the model's context.
          void this.#serialize(() =>
            ctx.log.append([{ type: "task.progress", payload: { chunk }, actor: SYSTEM_ACTOR("tool"), taskId: task.taskId }], {
              taskId: task.taskId,
            }),
          );
        },
      });
      }
    } catch (e) {
      const le = toLoomError(e);
      if (le.code === CODES.E_REPLAY_DIVERGENCE) throw le;
      await this.#serialize(() =>
        ctx.log.append(
          [{ type: "effect.failed", payload: { key, error: errorRecord(le) }, actor: SYSTEM_ACTOR("tool-executor"), taskId: task.taskId }],
          { taskId: task.taskId },
        ),
      );
      return { content: le.message, isError: true };
    }

    // `postTool` — before the append, for the same reason `postModel` is: a filter that redacts
    // a secret out of a tool result after the result is durable has redacted nothing. This is
    // also where an output-size projection would live, since the journal keeps the whole thing
    // and only the transcript needs bounding.
    result = await this.#filterHook(ctx, task, "postTool", result);

    await this.#serialize(() =>
      ctx.log.append(
        [
          {
            type: "tool.called",
            payload: {
              key,
              name: tool.name,
              version: tool.version,
              irreversibility: tool.irreversibility,
              idempotent: tool.idempotent,
              ok: result.isError !== true,
              ms: this.#now() - started,
              argsShape: shapeOf(final.value),
              argsDigest: digest(rawArgs ?? {}),
            },
            actor: SYSTEM_ACTOR("tool-executor"),
            taskId: task.taskId,
          },
          {
            type: "effect.completed",
            payload: { key, result, resultDigest: digest(result) },
            actor: SYSTEM_ACTOR("tool-executor"),
            taskId: task.taskId,
          },
        ],
        { taskId: task.taskId },
      ),
    );

    return result;
  }

  // ── commit + edge activation ──────────────────────────────────────────────

  async #commit(ctx: RunContext, w: Wave, settling: NodeOutcome): Promise<void> {
    const p = (await this.#project(ctx))!;

    // A JOIN FOLDS HERE, NOT IN THE BODY PHASE.
    //
    // `#runWave` awaits every body before committing any of them, so a fold computed in
    // the body phase reads the projection as it stood BEFORE the wave — and returns an
    // absolute channel value computed from that stale base. Two joins in one wave then
    // both wrote absolutes over the same base and the later silently discarded the
    // earlier, which made the final state a function of `maxParallelism`: a number the
    // journal never records, so the same journal replayed to different state on a
    // differently-configured engine. `p` here is freshly re-projected, so the fold sees
    // its siblings' commits. This is the whole of the fix.
    const outcome =
      w.node.type === "join" && settling.status === "succeeded" ? this.#foldJoin(ctx, p, w) : settling;

    if (outcome.status === "gate") {
      // THE RUN MAY HAVE ENDED WHILE THIS TASK WAS IN FLIGHT.
      //
      // `cancel` closes the gates that are open when it runs and cannot close one that does
      // not exist yet, so a Task that reaches its gate after the cancel used to raise a live
      // question on a dead run — and the `run.suspended` riding with it carried the status
      // back out of `cancelled`. `raise` refuses this too, and that refusal is the real
      // guard: it holds for every caller, and it commits against the projection it checked.
      // This check is here so the ordinary case — an operator cancels a run that is mid-wave
      // — is a quiet no-op rather than an exception out of `advance`, which is not an error
      // the caller can do anything about.
      if (isTerminal(p.status)) return;

      // Authorization travels with the raise, which is what puts it in `gate.raised` and
      // therefore in the projection every entry point checks against. `#commit` does not
      // compute it: it used to, from a block only one node type can carry, so every other
      // gate-raising path journaled nothing. The outcome answers for itself now.
      //
      // An empty approvers list is dropped rather than journaled as `[]` — "named nobody"
      // and "named an empty list" mean the same thing and should read the same way. An
      // empty `allowEdit` is NOT dropped, because there the two differ: absent means
      // unconstrained.
      const auth = outcome.gate!.auth;
      // THE SCHEDULE TRAVELS WITH THE RAISE TOO, and until it did the entire delivery
      // subsystem was unreachable from a graph: this call passed no `DeliverySpec`, so
      // `raise`'s `dispatcher !== undefined && delivery !== undefined` branch could only
      // ever be taken by an embedder driving the broker by hand — and no gate a graph
      // raised had a deadline for the sweep to find either. Spread rather than assigned,
      // because `exactOptionalPropertyTypes` makes an explicit `undefined` a different
      // thing from an absent field, and `raise` reads absence as "no clock".
      const sched = outcome.gate!.schedule ?? {};

      // `onGate` — the human's view, narrowed. Only `payload`, `excludedApprovers` and
      // `allowEdit` are reachable: `approvers`, `defaultAction` and `onTimeout` carry AUTHORITY,
      // and an extension that could add an approver would be granting it.
      //
      // It runs before `raise`, so a narrowed payload is the payload the approver sees — but
      // `contentDigest` is taken over `binding` and NOT over this, which is the correction this
      // comment used to have backwards. A hook that could shrink the payload could otherwise
      // shrink what the approval covers, and "the approver saw less" must never mean "less is
      // bound". What a hook narrows is the VIEW; what the approval binds is the engine's.
      //
      // Journaled through `ctx.log` directly rather than `#journalHooks`, which goes through
      // `#serialize`: this code path is already on that chain and awaiting a second entry from
      // inside one deadlocks — measured on `onError`.
      const gateHooks = this.#hooksFor(ctx, "onGate");
      let view: GateView = {
        payload: outcome.gate!.payload,
        ...(auth.excludedApprovers === undefined ? {} : { excludedApprovers: auth.excludedApprovers }),
        ...(auth.allowEdit === undefined ? {} : { allowEdit: auth.allowEdit }),
      };
      if (gateHooks.length > 0) {
        const out = await runFilters<GateView>(
          gateHooks,
          view,
          { point: "onGate", runId: ctx.runId, taskId: w.task.taskId, signal: ctx.abort.signal },
          () => false,
          narrowGateRequest,
        );
        view = out.value;
        if (out.changedBy.length > 0) {
          await ctx.log.append(
            out.changedBy.map((ref) => ({
              type: "hook.applied" as const,
              payload: { ref, point: "onGate" as const, changed: true },
              actor: SYSTEM_ACTOR("executor"),
              taskId: w.task.taskId,
            })),
            { taskId: w.task.taskId },
          );
        }
      }

      await this.#gates.raise(ctx.log, {
        runId: ctx.runId,
        taskId: w.task.taskId,
        nodeId: w.node.id,
        policyRef: outcome.gate!.policyRef,
        payload: view.payload,
        // WHAT THE APPROVAL BINDS, and it is deliberately NOT `view.payload`. Two reasons, and
        // both are why this is a separate field rather than a digest of the payload:
        //
        //   - the payload carries `costSoFarUsd`, which moves whenever any sibling commits, so
        //     re-deriving it later is not possible (see `#gateBinding`);
        //   - an `onGate` hook may have narrowed `view.payload`. Narrowing what a human is shown
        //     must not narrow what the approval covers, or an extension could shrink the bound
        //     set to nothing and hand every argument back to the race this closes.
        //
        // A MIRROR IS EXCLUDED. Its payload is the child run's channel state, nothing here can
        // re-derive it, and binding it to this node's inputs would refuse every subgraph
        // approval. The child raises its own gate on the node that executes, and
        // `#approvalStillCovers` runs there.
        ...(outcome.gate!.binding === undefined ? {} : { binding: outcome.gate!.binding }),
        allowEdit: view.allowEdit ?? auth.allowEdit,
        ...(auth.approvers.length === 0 ? {} : { approvers: auth.approvers }),
        // ABSENT stays absent and is never `[]` — a rule that bars nobody is a rule the
        // author did not write, and `[]` would journal one that reads as declared.
        ...(view.excludedApprovers === undefined ? {} : { excludedApprovers: view.excludedApprovers }),
        ...(sched.slaMs === undefined ? {} : { slaMs: sched.slaMs }),
        ...(sched.onTimeout === undefined ? {} : { onTimeout: sched.onTimeout }),
        ...(sched.delivery === undefined ? {} : { delivery: sched.delivery }),
        ...(sched.reminders === undefined ? {} : { reminders: sched.reminders }),
        // D7.9's saturation controls. They reach `raise` and nowhere else: whether this
        // gate merges with a sibling or inherits a sibling's answer is decided there,
        // against the JOURNAL, so a node cannot declare its way past an approvers list.
        ...(sched.batching === undefined ? {} : { batching: sched.batching }),
        ...(sched.dedupe === undefined ? {} : { dedupe: sched.dedupe }),
        // Which gate in which other run this one stands in for, if any. Durable for the
        // same reason the approvers are: the process that forwards the decision is not
        // necessarily the process that raised the mirror, and a binding only one of them
        // can see is a binding that a restart quietly removes.
        ...(outcome.gate!.mirrorOf === undefined ? {} : { mirrorOf: outcome.gate!.mirrorOf }),
      });
      return;
    }

    this.#recordEvidence(ctx, w, outcome);

    // THE RUN MAY HAVE ENDED WHILE THIS TASK WAS IN FLIGHT — and until this line only the
    // GATE arm above said so. `#cancelTree` already states the property this restores: "`#commit`
    // returns early on a terminal run, so a Task that was `leased` when the cancel landed stayed
    // `leased`". It did not; it returned early on one of its four exits, and the other three went
    // on producing state for a run that was over.
    //
    // BOTH POST-OUTCOME ARMS, because both create work the cancel's sweep cannot reach — the
    // sweep runs against the Tasks that exist WHEN IT RUNS, and everything below post-dates it:
    //
    //   - FAILURE: `task.retry_scheduled` + `task.ready`. Measured, on a tool that threw after
    //     the cancel landed: `9 task.cancelled | 10 run.cancelled | 11 effect.failed |
    //     12 task.retry_scheduled | 13 task.ready` — a Task in state `ready` inside a
    //     `cancelled` run, which nothing will lease and nothing will ever end.
    //   - SUCCESS: `task.committed` + `state.reduced` + the `task.ready` that `#activate`
    //     emits for every edge this commit takes. A single-node graph cannot see that one;
    //     with a second node behind a `seq` edge it is the node the operator cancelled the
    //     run to prevent, readied by the run that was cancelled to prevent it.
    //
    // WHAT STOPS IS SCHEDULING, NOT EVIDENCE, and that split is deliberate. `#invokeTool` has
    // already journaled `tool.called`/`effect.completed` (or `effect.failed`) by the time
    // control reaches here, and those stay: `run.cancelled.unknownEffects` names this effect as
    // unaccounted for, so the record of what it actually did is the one thing an operator
    // reading that field will want. `#recordEvidence` is above this line for the same reason.
    // Losing either would trade a scheduling defect for an auditing one.
    //
    // The lease is released, exactly as the two exits below do it, so the slot is not held by a
    // Task that will never commit.
    if (isTerminal(p.status)) {
      ctx.leases.delete(w.task.taskId);
      return;
    }

    // A retryable failure with attempts left is rescheduled instead of committed.
    // The slot is released during the backoff, so a retry storm costs queue depth
    // rather than concurrency (D6.3 level 3).
    let suppressionRows: readonly NewEvent[] = [];
    if (outcome.status === "failed") {
      const policyRetry = await this.#retryDecision(ctx, p, w, outcome);
      // `onError` — consulted ONLY when the policy already said yes, so a hook can suppress a
      // retry but never resurrect one. Re-running a non-idempotent tool that reached its sandbox
      // and left no completion is the case `#retryDecision` refuses on purpose, and an extension
      // able to override that refusal would be the most dangerous thing on this bus.
      const narrowed = policyRetry === undefined ? { changedBy: [] } : await this.#narrowRetry(ctx, w, policyRetry);
      const retry = narrowed.retry;
      // THE HOOK'S RECORD RIDES THE SAME BATCH AS ITS EFFECT, and it has to. `#journalHooks`
      // goes through `#serialize`, which chains onto `#commitChain` — and this code path is
      // already ON that chain, so awaiting a second entry from inside one deadlocks. The first
      // draft did exactly that and hung on the first `advance` with the tool already called.
      // Committing them together is also the better answer: the decision and the reason for it
      // become durable in one write, or neither does.
      const hookRows = narrowed.changedBy.map((ref) => ({
        type: "hook.applied" as const,
        payload: { ref, point: "onError" as const, changed: true },
        actor: SYSTEM_ACTOR("executor"),
        taskId: w.task.taskId,
      }));
      if (retry !== undefined) {
        await ctx.log.commit(
          p.seq,
          [
            ...hookRows,
            {
              type: "task.retry_scheduled",
              payload: {
                // THE ATTEMPT IS THE BUDGET, so a deferral repeats it rather than advancing it.
                // This one expression is the whole of "a rate limit is not charged to the node":
                // the fold reads `attempt` from here and nowhere else.
                attempt: retry.deferred === true ? w.task.attempt : w.task.attempt + 1,
                afterMs: retry.afterMs,
                code: retry.code,
                ...(retry.deferred === true ? { deferred: true } : {}),
              },
              actor: SYSTEM_ACTOR("executor"),
              taskId: w.task.taskId,
            },
            {
              type: "task.ready",
              payload: { nodeId: w.node.id, branchPath: encodeBranch(w.task.branch), edgesIn: [...w.task.edgesIn] },
              actor: SYSTEM_ACTOR("scheduler"),
              taskId: w.task.taskId,
            },
          ],
          this.#fence(ctx, w),
        );
        ctx.leases.delete(w.task.taskId);
        return;
      }
      // Suppressed. The rows still have to land, so they lead the events this failure commits.
      suppressionRows = hookRows;
    }

    // A proposed mutation is validated BEFORE anything it adds can run, by the same
    // compiler that validated the authored graph.
    const mutationEvents: NewEvent[] = [];
    if (outcome.mutation !== undefined) {
      const applied = this.#applyMutation(ctx, w, outcome.mutation);
      if (applied.error !== undefined) {
        return void (await ctx.log.commit(
          p.seq,
          [
            {
              type: "task.failed",
              payload: { error: errorRecord(applied.error), attempt: w.task.attempt + 1 },
              actor: SYSTEM_ACTOR("executor"),
              taskId: w.task.taskId,
            },
            {
              type: "task.committed",
              payload: { status: "failed", writes: {}, take: [], usage: outcome.usage, attempt: w.task.attempt + 1 },
              actor: SYSTEM_ACTOR("executor"),
              taskId: w.task.taskId,
            },
          ],
          this.#fence(ctx, w),
        ));
      }
      mutationEvents.push(...applied.events);
    }

    const events: NewEvent[] = [...suppressionRows, ...mutationEvents];

    // `checkpoint: "before"` WAS A SILENT NO-OP. The arm below tested `"after" || "both"` only, so
    // a node declaring `"before"` got nothing — including the human_gate node of BOTH shipped
    // workflows (`workflows/incident-triage.ts`, `builtin/authoring.ts`), which is the node an
    // author most wants a rewind target in front of.
    //
    // FIRST IN THE APPEND, which is what "before" means here: checkpoints are written at commit
    // time, so a marker pushed ahead of this node's `state.reduced` names the state as it was
    // BEFORE its writes landed. The `after` arm below names the state once they have.
    if (w.node.checkpoint === "before" || w.node.checkpoint === "both") {
      events.push({
        type: "checkpoint.created",
        payload: {
          // Distinct from the `after` id, or `both` would write one marker twice and a reader
          // could not tell which side of the node it names.
          checkpointId: `cp_${w.task.taskId}_before` as never,
          atSeq: p.seq + events.length,
          kind: "auto",
          openTasks: tasksInState(p, "ready", "leased").length,
        },
        actor: SYSTEM_ACTOR("executor"),
        taskId: w.task.taskId,
      });
    }
    const take = outcome.status === "failed" ? this.#errorEdges(ctx, w, outcome.error?.code) : this.#edgesToTake(ctx, p, w, outcome);

    if (outcome.status === "failed") {
      events.push({
        type: "task.failed",
        payload: { error: errorRecord(outcome.error ?? err.internal(CODES.E_INTERNAL, "unknown")), attempt: w.task.attempt + 1 },
        actor: SYSTEM_ACTOR("executor"),
        taskId: w.task.taskId,
      });
    }

    // A join emits its fold; a root-branch Task reduces its own writes immediately;
    // a Task inside a fan-out holds them until its join.
    //
    // COMPUTED BEFORE `task.committed` IS BUILT, which it was not, because the answer decides
    // whether that event's `writes` may be externalised at all. Nothing else moved: it is the
    // same expression over the same `p`, `w` and `outcome`.
    const reduce = outcome.reduced ?? this.#immediateReduce(ctx, p, w, outcome);

    // A WRITE THIS COMMIT DOES NOT REDUCE STAYS INLINE, and the condition is the whole reason
    // `#foldJoin` needs no resolution step. `#immediateReduce` returns `undefined` for a Task
    // inside a fan-out — its writes are a PROPOSAL a later join re-folds — and a join at depth
    // returns its partial fold as its own held write. In both of those cases the value has to
    // be foldable by a synchronous reducer later, so it is journaled whole. What is left is
    // exactly the case where this commit's own `state.reduced` carries the value forward, and
    // the handle it leaves in `TaskRecord.writes` is never read as a number or an array.
    const committed =
      outcome.reduced === undefined && reduce !== undefined
        ? await this.#externalise(ctx, outcome.writes)
        : { values: { ...outcome.writes }, projected: { ...outcome.writes } };

    events.push({
      type: "task.committed",
      payload: {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        writes: committed.values,
        take,
        usage: outcome.usage,
        attempt: w.task.attempt + 1,
        ...(committed.external === undefined ? {} : { external: committed.external }),
      },
      actor: SYSTEM_ACTOR("executor"),
      taskId: w.task.taskId,
    });

    if (reduce !== undefined) {
      const applied = await this.#externalise(ctx, reduce.values);
      const before = stateHash(p.channels);
      // `applied.projected`, not `reduce.values`: the fold builds `p.channels` from the event's
      // `values` PLUS a handle per `external` entry, so hashing the raw values here would
      // record a state hash of a projection nobody reconstructs.
      const after = stateHash({ ...p.channels, ...applied.projected });
      events.push({
        type: "state.reduced",
        payload: {
          channels: reduce.channels,
          values: applied.values,
          branchCount: reduce.branchCount,
          skipped: reduce.skipped,
          degraded: reduce.skipped > 0,
          stateHashBefore: before,
          stateHashAfter: after,
          ...(applied.external === undefined ? {} : { external: applied.external }),
        },
        actor: SYSTEM_ACTOR("executor"),
        taskId: w.task.taskId,
      });
    }

    if (w.node.checkpoint === "after" || w.node.checkpoint === "both") {
      events.push({
        type: "checkpoint.created",
        payload: {
          checkpointId: `cp_${w.task.taskId}` as never,
          atSeq: p.seq + events.length,
          kind: "auto",
          openTasks: tasksInState(p, "ready", "leased").length,
        },
        actor: SYSTEM_ACTOR("executor"),
        taskId: w.task.taskId,
      });
    }

    // Activation is part of the same append: a crash between "committed" and "next
    // task ready" would otherwise strand the run with nothing runnable.
    events.push(...this.#activate(ctx, p, w, take, outcome, outcome.status === "failed" ? "failed" : "succeeded"));

    // PRESENT THE LEASE. The store refuses an append whose token is below the highest it
    // has seen for this Task, so a worker whose lease another process has taken cannot
    // commit over it. Without this the fence was inert: the token was minted, journaled,
    // and never shown to the thing that checks it, so `E_LEASE_LOST` had no thrower.
    await ctx.log.commit(p.seq, events, this.#fence(ctx, w));
    ctx.leases.delete(w.task.taskId);
  }

  /**
   * The commit options for a Task, WITH its lease presented.
   *
   * The store refuses an append whose token is below the highest it has seen for a Task, so
   * a worker whose lease another process has taken cannot commit over it — but only if the
   * token is actually shown. `#commit` has three exits, and the fence was on one of them:
   * the retry-scheduled path and the mutation-rejected path both committed with `{taskId}`
   * alone, so a worker that had lost its lease could still reschedule the Task or record a
   * failed mutation on top of the new leaseholder's work. Reproduced by un-fencing the
   * retry exit alone: `unfenced: task.retry_scheduled+task.ready`.
   *
   * A helper rather than three call sites, for the reason invariant 6 gives about tool
   * dispatch: a rule applied at each exit is a rule the fourth exit forgets. `E_LEASE_LOST`
   * having no thrower was the previous version of this same mistake, one level up.
   */
  #fence(ctx: RunContext, w: Wave): { taskId: TaskId; fencingToken?: number } {
    const token = ctx.leases.get(w.task.taskId);
    return { taskId: w.task.taskId, ...(token === undefined ? {} : { fencingToken: token }) };
  }

  /**
   * Whether to reschedule this Task, after how long, and whether that costs it an attempt.
   *
   * TWO ANSWERS, NOT ONE, and the difference is a model decision rather than an implementation
   * one. A RETRY says "this node failed; do it again" and is charged: it needs a policy, it
   * respects `maxAttempts` and `onlyIf`, and it runs out. A DEFERRAL says "the node never ran"
   * — the provider refused to serve us — and is not charged to anybody, because charging it
   * conflates "the provider is busy" with "the work failed", and a `maxAttempts: 3` node then
   * dies of somebody else's traffic.
   *
   * WHAT DEFERS IS A NAMED SET OF TWO — `DEFERRABLE_CODES`, which carries the argument for each
   * member and for the narrowness. An overload (`E_PROVIDER_OVERLOADED`) is a judgement about
   * capacity that may or may not be about us, and a transport reset says nothing at all: both
   * stay ordinary retries.
   *
   * WHY THIS FUNCTION EXISTS IN THIS SHAPE. Half two of the rate-limit fix failed twice, both
   * times by deleting the transport's in-slot sleep and leaving only the retry arm: the sleep
   * was a UNIVERSAL rescue and a policy retry is a CONDITIONAL one, so the swap lost every case
   * where a condition did not hold. The deferral arm restores universality — no policy needed,
   * no `onlyIf`, no attempt charged — which is what makes removing the sleep lossless.
   *
   * FOUR REFUSALS, each for a different reason, and the first three bind BOTH answers:
   *   - a NON-RETRYABLE class (validation, policy) will fail identically next time;
   *   - a RUN-FATAL code is not about this Task at all;
   *   - a NON-IDEMPOTENT tool that reached its sandbox and left NO completion may have
   *     done its work anyway. Retrying is the dangerous option, so the answer is no, and
   *     the run takes its error edge or surfaces the gap. **A deferral obeys this too**: it
   *     re-enters the node body exactly as a retry does, so the bell can ring twice for
   *     exactly the same reason. This is the one row of the old failure table a deferral does
   *     not rescue, and it fails closed rather than quietly. It is asked ONCE and shared by
   *     both arms, because it reads the journal.
   *   - and for a deferral only, `DEFERRAL_BUDGET_MS`: past it the rate limit stops being a
   *     deferral and falls through to the retry arm, which will usually fail the Task. Nothing
   *     here can wait forever.
   */
  async #retryDecision(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    outcome: NodeOutcome,
  ): Promise<{ afterMs: number; code: string; deferred?: boolean } | undefined> {
    // THE COMPILED POLICY, NOT THE AUTHORED ONE. This read `w.node.retry` — a field an author
    // sets and nothing computes — so on every graph this product ships (four examples, zero
    // `"retry"` between them, and `agent()`'s own compiled spec) `policy` was `undefined` and
    // this whole function returned on its first line. The requeue exit below had never run for
    // a rate limit; a hidden sleep in the HTTP transport was standing in for it.
    //
    // `plans[id].retry` is `node.retry ?? <default for the type>`, so the `??` here is not a
    // second answer — a plan's value already contains the author's. It covers only a `RunGraph`
    // whose `plans` a caller assembled without the compiler.
    const policy = ctx.graph.plans[w.node.id]?.retry ?? w.node.retry;
    const error = outcome.error;
    if (error === undefined) return undefined;

    if (!error.retryable) return undefined;
    if (RUN_FATAL_CODES.has(error.code)) return undefined;

    // HONOUR WHAT THE SOURCE ASKED FOR, bounded. Computed once because both arms want it: the
    // provider is the only party that knows when it will serve us again, and `retry-after:
    // 86400` is a legal header, so a faithful record still needs a ceiling before it reaches a
    // scheduler. `retryAfterMs` is read off the RECORDED error, so replay computes the same
    // number from the same journal.
    const asked = error.retryAfterMs;
    const honoured =
      typeof asked === "number" && Number.isFinite(asked) && asked > 0 ? Math.min(asked, RETRY_AFTER_CEILING_MS) : 0;

    // ASKED ONCE, SHARED BY BOTH ARMS. It reads the journal, and the case where both arms want
    // it — a rate limit whose deferral budget is spent — would otherwise read it twice.
    if (await this.#mayHaveRungABell(ctx, p, w)) return undefined;

    // A DEFERRAL, decided before the policy is consulted at all — that ordering IS the fix.
    const task = p.tasks[w.task.taskId];
    // THE BUDGET IS A BOUND ON THE TOTAL, not on the total before the last one. The first
    // version asked whether the time ALREADY SPENT was under budget and then added up to
    // another `DEFERRAL_MAX_MS` on top, so the real ceiling was "budget plus one deferral" —
    // 960 s against a documented 900 s, a 33% overshoot at the worst `honoured` value. Three
    // places call it a bound. This lane's reviewer found it, and found that the test could not:
    // the fixture asks for 60 s against a 900 s budget, which divides evenly, so the last
    // deferral landed exactly ON the line and the overshoot never appeared.
    //
    // Deciding the wait FIRST and then asking whether it fits is the fail-closed order. A
    // provider asking for more time than the budget has left ends the run now rather than
    // overshooting once and ending it anyway.
    const spent = task?.deferredMs ?? 0;
    const deferralCurve = Math.min(DEFERRAL_INITIAL_MS * 2 ** (task?.deferrals ?? 0), DEFERRAL_MAX_MS);
    const afterMs = Math.max(deferralCurve, honoured);
    if (DEFERRABLE_CODES.has(error.code) && spent + afterMs <= DEFERRAL_BUDGET_MS) {
      // The attempt is REPEATED, not advanced: `task.retry_scheduled` is the event that moves
      // the budget, so writing the same number is what "not charged" means durably.
      return { afterMs, code: error.code, deferred: true };
    }

    if (policy === undefined) return undefined;
    const attempt = w.task.attempt + 1;
    if (attempt >= policy.maxAttempts) return undefined;
    if (policy.onlyIf !== undefined && !policy.onlyIf.includes(error.code)) return undefined;

    const initial = policy.initialMs ?? 500;
    const max = policy.maxMs ?? 30_000;
    const raw = policy.backoff === "fixed" ? initial : initial * 2 ** (attempt - 1);
    // No jitter here: the delay must be a pure function of (policy, attempt) or
    // replay diverges. Real jitter belongs in the distributed scheduler, where the
    // delay is not part of the recorded decision.
    const curve = Math.min(raw, max);
    return { afterMs: Math.max(curve, honoured), code: error.code };
  }

  /**
   * Whether re-entering this node's body might repeat a side effect the journal cannot account
   * for — the refusal both `#retryDecision` arms share.
   *
   * A TOOL EFFECT, not any effect. The reachable set is the right question for a
   * POSTURE — what a node might do decides how closely it is watched — and it is fine
   * here too, PROVIDED the second half of the conjunction asks about a tool. It did
   * not: `#effectStarted` matches any key prefixed by the taskId, `:model:` included,
   * so an agent lost its retry policy the moment its first MODEL call started and a
   * transport blip on turn one read as a non-idempotent tool that might have rung the
   * bell.
   *
   * The signal has to stay DURABLE — `startedEffects` is folded from the journal, so it
   * survives a restart, where an in-memory list of calls does not. What was wrong was
   * its precision, not its source: `${taskId}:` matches `:model:` too.
   *
   * Only refuse once the call REACHED the sandbox. A failure before that (schema
   * validation, a policy deny) touched nothing, so retrying it is safe even for a
   * non-idempotent tool.
   *
   * NARROWED FROM "STARTED" TO "STARTED AND NOT COMPLETED", which is what `#invokeTool`'s
   * serve-by-key bought. A tool effect that COMPLETED is handed back from the record on the
   * next attempt and its body is never entered, so re-running the Task cannot ring the bell
   * twice — and that is the whole case this refusal was blocking: a charge that went through
   * followed by a 429 on the next turn, which is the shape the rate-limit work kept failing
   * on. What serve-by-key cannot cover is the other half: `effect.started` with no
   * `effect.completed` — the tool threw, or the process died mid-call — where the world may
   * already have changed and the record cannot say. There the refusal stands, unchanged.
   *
   * IT BINDS A DEFERRAL AS WELL AS A RETRY. A deferred Task re-enters the same body by the
   * same path, so "the provider was busy" changes nothing about whether the bell may ring
   * twice. Refusing is always allowed; this is the one place the rate-limit work fails a run
   * it could have saved, and it fails closed on purpose.
   */
  async #mayHaveRungABell(ctx: RunContext, p: RunProjection, w: Wave): Promise<boolean> {
    const nonIdempotentReachable = reachableToolNames(w.node).some((name) => {
      const t = this.tools.get(name);
      return t !== undefined && !t.idempotent;
    });
    if (!nonIdempotentReachable) return false;
    return (await this.#unfinishedToolEffect(ctx, p, w.task.taskId)) !== undefined;
  }

  /**
   * The first TOOL effect of this Task that started and has no live completion, if any.
   *
   * Two narrowings, each paid for by a defect. `:tool:` and not `${taskId}:`, because a model
   * call that started and failed touched nothing outside Loom — the broad form cost an agent
   * its retry policy on a transport blip. And "unfinished" and not "started", because
   * `#invokeTool` now serves a COMPLETED tool effect from the record rather than re-entering
   * the body: a completed call cannot happen twice, so it is no longer a reason to refuse.
   *
   * What is left is the honest gap. `effect.started` with no `effect.completed` means the
   * journal cannot say what the world did — the tool threw after its request was sent, or the
   * process died between the two appends — and for a non-idempotent tool that is the case
   * where retrying is the dangerous option.
   */
  async #unfinishedToolEffect(ctx: RunContext, p: RunProjection, taskId: TaskId): Promise<string | undefined> {
    const prefix = `${taskId}:tool:`;
    const started = p.startedEffects.filter((k) => k.startsWith(prefix));
    if (started.length === 0) return undefined;
    const done = await this.#completedEffects(ctx, (k) => k.startsWith(prefix));
    // THE SAME PREDICATE `#invokeTool` SERVES ON, and it has to be the same one or the two
    // halves disagree: a call this refusal treated as finished but the next attempt re-performs
    // is precisely the double-charge the refusal exists to stop.
    return started.find((k) => !done.has(k) || !isServedToolResult(done.get(k)));
  }

  /**
   * Validate and adopt a mutation.
   *
   * Adoption swaps `ctx.graph` and `ctx.index` for the successor. `graphHash` changes,
   * which is the point: the journal records `graph.mutated{parentHash, newHash}` so the
   * chain base → mutations → final is verifiable, and a trace can still be checked
   * against the graph that actually ran.
   */
  #applyMutation(
    ctx: RunContext,
    w: Wave,
    mutation: GraphMutation,
  ): { events: NewEvent[]; error?: LoomError } {
    const decision = ctx.policy.decide({
      runId: ctx.runId,
      nodeId: w.node.id,
      taskId: w.task.taskId,
      kind: "node",
      irreversibility: "reversible_write",
      capabilities: ["graph:mutate"],
      declaredPosture: ctx.graph.plans[w.node.id]?.posture ?? "out",
    });
    if (decision.effect === "deny") return { events: [], error: decision.error };

    const result = compileMutation({
      base: ctx.graph,
      mutation,
      budget: { consumedNodes: ctx.addedNodes, expansion: ctx.graph.expansion },
      // A mutation is proposed from INSIDE an executing Task, so this is the sharpest of the
      // three: without it a `canMutate` agent's own graph re-resolved its prompts and children
      // from the live store at the moment it proposed a change.
      resolver: frozenFirst(ctx.graph, this.#resolver),
      tools: this.tools.manifests(),
      ...(this.#policyOpts.systemFloor === undefined ? {} : { systemPostureFloor: this.#policyOpts.systemFloor }),
    });
    if (!result.ok) return { events: [], error: result.error };

    const parentHash = ctx.graph.graphHash;
    ctx.graph = result.graph;
    ctx.index = indexGraph(result.graph.spec);
    ctx.addedNodes += result.addedNodes.length;

    // A newly added hard-to-undo action gates before it runs, whatever the run's
    // posture — a graph that GREW an irreversible step at runtime is exactly where
    // "somebody should look" is not negotiable. Escalated per node, not per run: the
    // rest of the graph was already reviewed and does not become riskier.
    for (const id of result.gatedNodes) {
      ctx.policy.escalate(`node:${ctx.runId}/${id}`, "in", "mutation_introduced_irreversible");
    }

    return {
      events: [
        {
          type: "graph.mutated",
          payload: {
            parentHash,
            newHash: result.graph.graphHash,
            addedNodes: [...result.addedNodes],
            addedEdges: mutation.addEdges.map((e) => e.id),
            nodes: [...mutation.addNodes],
            edges: [...mutation.addEdges],
            proposedBy: w.task.taskId,
            proposedByNode: w.node.id,
            budgetConsumed: ctx.addedNodes,
          },
          actor: SYSTEM_ACTOR("executor"),
          taskId: w.task.taskId,
        },
      ],
    };
  }

  /**
   * Update the evidence the escalation table reads, and fire E4/E5 when it warrants.
   *
   * Called once per committed Task, which is the only point where the outcome, the tools
   * it used, and the channels it wrote are all known together.
   */
  #recordEvidence(ctx: RunContext, w: Wave, outcome: NodeOutcome): void {
    // Also at commit: a run can drift over the line through settled spend across many
    // cheap tasks, without any single reservation reaching it.
    this.#checkBudgetWarning(ctx);

    // E8's evidence.
    applyTaint(ctx.tainted, w.node, outcome.writes);
    applySecretFlow(ctx.carriesSecret, w.node, outcome.writes, ctx.graph.spec.channels);

    // E4 — consecutive failures. Reset by any success, so flakiness spread over a day
    // does not accumulate into an escalation.
    const streak = ctx.streaks.record(w.node.id, outcome.status !== "failed");
    if (streak >= 3) this.#escalate(ctx, "repeated_failure", w.node.id, { streak });

    // E5 — a tool sequence never seen in a successful run of this graph.
    //
    // AGENT NODES ONLY. A `tool` node's tool is written in the spec: if it changed, the
    // graph hash changed and this is a different graph. Only an agent CHOOSES its
    // sequence at run time, so only an agent can produce one nobody has seen.
    if (this.#sequences !== undefined && outcome.status !== "failed" && w.node.type === "agent") {
      const names = ctx.toolCalls.get(w.task.taskId);
      if (names !== undefined && names.length > 0) {
        const ngram = toolNGram(names);
        if (!this.#sequences.hasSeen(ctx.graph.graphHash, w.node.id, ngram)) {
          this.#escalate(ctx, "novel_sequence", w.node.id, { ngram });
        }
      }
    }
    ctx.toolCalls.delete(w.task.taskId);
  }

  /**
   * E2 — the run has consumed 80% of its budget.
   *
   * Fires ONCE. A rule that re-escalates on every reservation past the line would flood
   * the journal with a fact that has not changed, and `max` makes the repeats no-ops
   * anyway — the flood would be pure noise.
   */
  #checkBudgetWarning(ctx: RunContext): void {
    // `nearLimit` lives on the PolicyEngine, which owns the arithmetic. Re-deriving the
    // fraction here from `spentUsd + remainingUsd` was the first attempt, and it was
    // wrong in the way re-derivations usually are: it read the numbers a moment before
    // `settle` credited the turn's real cost, so it saw the estimate and never fired.
    if (ctx.warnedBudget || !ctx.policy.nearLimit) return;
    ctx.warnedBudget = true;
    const committed = ctx.policy.spentUsd + ctx.policy.reservedUsd;
    this.#escalate(ctx, "budget_warning", undefined, {
      spentUsd: Number(committed.toFixed(6)),
      // DROPPED WHEN THERE IS NO DOLLAR CEILING. `remainingUsd` is `Infinity` whenever the
      // deployment set no `runUsd`, and `canonicalize` refuses a non-finite number on the
      // durable write path. That was unreachable while `nearLimit` consulted `runUsd` alone —
      // no dollar ceiling meant no warning — and became reachable the moment it started firing
      // for tokens and provider time too: measured as `E_INTERNAL: non-finite number Infinity
      // at detail.remainingUsd` killing `WALL TIME SURVIVES A RESTART TOO`, a run whose only
      // declared ceiling was `wallMs`. The same defect `exceededLimitUsd` already fixed one
      // field over, and the same fix: write the number when there is one.
      ...(Number.isFinite(ctx.policy.remainingUsd) ? { remainingUsd: Number(ctx.policy.remainingUsd.toFixed(6)) } : {}),
      // The other two totals, because E2 now fires for them: a row saying only "80% of the
      // budget" cannot tell a reader which of three budgets, and the escalation is supposed to
      // be the thing that says why.
      spentTokens: ctx.policy.spentTokens,
      spentWallMs: ctx.policy.spentWallMs,
    });
  }

  /**
   * E7 — this run is an outlier against its own cohort.
   *
   * Checked at FINISH, not per task, because "this run cost 3× the p99" is a fact about
   * the whole run. Escalating at the end still matters: the posture is durable, so a
   * follow-up or a resumed branch inherits it, and the journal says why.
   */
  #checkAnomaly(ctx: RunContext, p: RunProjection): void {
    if (this.#baseline === undefined) return;
    const reading = detectAnomaly(this.#baseline, ctx.graph.graphHash, {
      costUsd: p.usage.costUsd,
      tokens: p.usage.inputTokens + p.usage.outputTokens,
      wallMs: this.#now() - p.startedAt,
    });
    if (reading === undefined) return;
    this.#escalate(ctx, "anomaly", undefined, {
      metric: reading.metric,
      value: reading.value,
      p99: reading.p99,
      ratio: Number(reading.ratio.toFixed(2)),
    });
  }

  #immediateReduce(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    outcome: NodeOutcome,
  ): NodeOutcome["reduced"] | undefined {
    if (Object.keys(outcome.writes).length === 0) return undefined;
    // Inside a fan-out: hold. The join folds every sibling in branch order, so
    // applying now would make the result depend on completion order.
    //
    // `#foldJoin` asks the SAME question of each member, through the same helper, and it has
    // to be the same question: a Task this returns early for is one the join must fold, and a
    // Task it applies is one the join must skip. Two spellings of one predicate is how the
    // double-count got in — the fold had no predicate at all.
    if (writesHeldForJoin(w.task.branch)) return undefined;

    const wave: Record<string, readonly Contribution[]> = {};
    for (const [channel, value] of Object.entries(outcome.writes)) {
      wave[channel] = [{ branch: w.task.branch, nodeId: w.node.id, iteration: w.task.iteration, value }];
    }
    const reduced = reduceState(ctx.graph.spec.channels, p.channels, wave);
    return { values: pick(reduced.state, reduced.channels), channels: reduced.channels, branchCount: 1, skipped: 0 };
  }

  /**
   * May this loop edge be taken again?
   *
   * ONE ANSWER FOR BOTH ENTRANCES. The `switch` below derives its own edges and a router hands
   * them over ready-made, and only the first consulted the bound — so the same edge was bounded
   * or unbounded depending on which node named it. Two answers to one question is how they come
   * to disagree; this is the question.
   *
   * NO GRAPH-LEVEL BACKSTOP IS ADDED HERE, and that is a correction to what this fix first did.
   * `expansion.maxLoopIterations` genuinely has no runtime reader — but it needs none, because
   * the COMPILER already refuses a loop edge with no `maxIterations` (`GRAPH006_UNBOUNDED_LOOP`)
   * and no `until` (`GRAPH006_NO_STOP_RULE`). Reading the graph ceiling here would be a fallback
   * for a shape that cannot compile.
   *
   * Which makes what shipped worse rather than better: the compiler enforced a bound and the
   * executor ignored it. "Compiles, then fails at run time" is what this project's compile stage
   * exists to prevent, and this was its inversion — compiles, then runs FOREVER.
   */
  #loopMayContinue(ctx: RunContext, e: EdgeSpec, w: Wave, scope: Record<string, unknown>): boolean {
    const done = e.until !== undefined && evaluate(this.#expr(ctx, e.until), scope) === true;
    return !done && w.task.iteration + 1 < (e.maxIterations ?? 1);
  }

  #edgesToTake(ctx: RunContext, p: RunProjection, w: Wave, outcome: NodeOutcome): readonly EdgeId[] {
    // A NAMED EDGE STILL OBEYS ITS OWN BOUND, and this line used to return before the `loop` arm
    // below could say otherwise. A `router` ALWAYS produces a `take`, so a loop edge whose source
    // is a router — the canonical `verify → replan` shape — had no bound of any kind: not
    // `until`, not `maxIterations`, and not `expansion.maxLoopIterations`, which has no runtime
    // reader at all. Measured before this: `maxIterations: 3` and a graph budget of $0.000001
    // reached iteration 3,625 in 25 seconds — 3,626 model calls, 43,512 journal rows, a 17.7 MB
    // journal — and was still going when it was killed. Pointed at a paid provider that is
    // unbounded spend with no ceiling anywhere.
    //
    // Filtering rather than ignoring `take`: a router's choice is still what SELECTS the edge.
    // What it may not do is re-enter a loop the loop itself has declared finished.
    if (outcome.take !== undefined) {
      const scope = { ...scopeFor(p, ctx.graph.spec.channels, w.task.branch), ...outcome.writes };
      // Route confinement is checked in `#dispatch`, where an invalid one becomes a FAILED TASK
      // rather than a throw out of `#commit` — see `#strayRoute`.
      return outcome.take.filter((id) => {
        const e = ctx.index.edgeById.get(id);
        return e === undefined || e.kind !== "loop" || this.#loopMayContinue(ctx, e, w, scope);
      });
    }

    const scope = { ...scopeFor(p, ctx.graph.spec.channels, w.task.branch), ...outcome.writes };
    const out: EdgeId[] = [];

    for (const e of ctx.index.outbound.get(w.node.id) ?? []) {
      switch (e.kind) {
        case "error":
          break;
        // A COMPENSATION EDGE IS NEVER TRAVERSED, AND THAT IS THE DESIGN — the one item of §A.30
        // that must not be "fixed". Every other trigger in that entry has since been wired
        // (`#failRun` on every exit that fails a run, `rewind`, and both of those down into child
        // runs), so this arm now reads like the last one nobody got to. It is not.
        //
        // ROLLBACK IS JOURNAL-DRIVEN. An effect needs undoing because it HAPPENED, not because
        // an author drew a line on a diagram — so making the undo conditional on an edge would
        // mean a graph that forgot one silently keeps its writes, which is the loosening
        // direction. And the two do not even denominate the same thing: an edge names a NODE,
        // while a rollback must name a CALL. A node that called a tool three times has one
        // outgoing edge and three things to undo, and `planCompensation` keys every step on the
        // seq of the `tool.called` it reverses for exactly that reason.
        //
        // What the edge IS for is `graph/validate.ts`'s GRAPH012, which proves at compile time
        // that a declared rollback exists and refuses one naming an unregistered undo. It is a
        // DECLARATION the compiler checks, not a route the executor follows.
        case "compensation":
          break;
        case "loop": {
          if (this.#loopMayContinue(ctx, e, w, scope)) out.push(e.id);
          break;
        }
        case "conditional": {
          // A conditional leaving a router is selected by the router, never by a
          // `when` — the router already returned its `take`.
          if (w.node.type === "router") break;
          if (e.when === undefined || evaluate(this.#expr(ctx, e.when), scope) === true) out.push(e.id);
          break;
        }
        default:
          out.push(e.id);
      }
    }
    return out;
  }

  /**
   * The error edges that HANDLE this failure — not every error edge the node has.
   *
   * `EdgeSpec.codes` restricts an error edge to a set of normalized codes and had ZERO readers:
   * this filtered on `kind` alone, so every error edge was a catch-all whatever it declared. The
   * asymmetry is what makes it a trap rather than a gap — `RetryPolicy.onlyIf` IS read
   * (`policy.onlyIf.includes(error.code)`), so an author who learned that code-filtering works
   * for retry reasonably assumes it works here, declares `codes: ["E_PROVIDER_UNAVAILABLE"]` on
   * a compensation edge, and gets that edge for a validation failure too.
   *
   * An edge with no `codes` stays a catch-all. When nothing matches, the take is empty and the
   * failure is unhandled — which is the honest answer: the graph declared handlers, and none of
   * them was for this.
   */
  #errorEdges(ctx: RunContext, w: Wave, code: string | undefined): readonly EdgeId[] {
    return (ctx.index.outbound.get(w.node.id) ?? [])
      .filter((e) => e.kind === "error" && (e.codes === undefined || (code !== undefined && e.codes.includes(code))))
      .map((e) => e.id);
  }

  #activate(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    take: readonly EdgeId[],
    outcome: NodeOutcome,
    selfStatus: "succeeded" | "failed",
  ): NewEvent[] {
    const events: NewEvent[] = [];
    const scope = { ...scopeFor(p, ctx.graph.spec.channels, w.task.branch), ...outcome.writes };

    for (const edgeId of take) {
      const e = ctx.index.edgeById.get(edgeId);
      if (e === undefined) continue;

      if (e.kind === "fanout") {
        const items = scope[e.over ?? ""];
        const list = Array.isArray(items) ? items.slice(0, e.maxWidth ?? 0) : [];

        // Record the PLANNED width before materialising anything: the join reads it
        // instead of counting siblings, which is what lets branches be created in
        // bounded waves without the barrier firing early.
        events.push({
          type: "fanout.planned",
          payload: { edgeId: e.id, parentBranch: encodeBranch(w.task.branch), nodeId: e.to, width: list.length },
          actor: SYSTEM_ACTOR("scheduler"),
          taskId: w.task.taskId,
        });

        // Lazy materialisation: a 500-way fan-out costs O(maxParallelism) rows in
        // flight, not O(maxWidth). The branch COORDINATES are all determined —
        // `list[i]` is a pure function of the channel and the index — so nothing about
        // replay or the fold changes.
        if (list.length === 0) {
          // A BARRIER OVER ZERO BRANCHES IS SATISFIED. Without this the join is never
          // notified — notification rides on a branch Task's commit, and there are no
          // branch Tasks — so an alert with no pods strands the entire downstream graph
          // while the run still reports success.
          events.push(...this.#fireEmptyJoin(ctx, e, w.task.branch));
          continue;
        }

        const firstWave = Math.min(list.length, this.#maxParallelism);
        for (let i = 0; i < firstWave; i++) {
          events.push(this.#branchReady(e, w.task.branch, i, list[i]));
        }
        continue;
      }

      if (e.kind === "join") {
        const fired = this.#maybeFireJoin(ctx, p, w, e, selfStatus, take);
        if (fired !== undefined) events.push(fired);
        continue;
      }

      // The iteration counter PROPAGATES through the loop body and only increments on
      // the back-edge. Resetting it to 0 on a forward edge made the second pass
      // re-target the FIRST pass's TaskId — which the fold marks ready again, forever.
      const iteration = e.kind === "loop" ? w.task.iteration + 1 : w.task.iteration;
      events.push({
        type: "task.ready",
        payload: { nodeId: e.to, branchPath: encodeBranch(w.task.branch), edgesIn: [e.id] },
        actor: SYSTEM_ACTOR("scheduler"),
        taskId: makeTaskId(e.to, w.task.branch, iteration),
      });
    }

    // Materialise the next branch of the fan-out this Task belongs to, if any remain
    // and a slot has freed. This is what keeps in-flight width bounded without ever
    // losing a branch.
    events.push(...this.#topUpFanout(ctx, p, w));

    // A join is notified by TERMINATION, not by edge selection. A failed branch takes
    // no outgoing edge, but it still counts toward the barrier — otherwise a fan-out
    // whose last branch fails would hang forever waiting for an arrival that can
    // never come.
    for (const e of ctx.index.outbound.get(w.node.id) ?? []) {
      if (e.kind !== "join" || take.includes(e.id)) continue;
      const fired = this.#maybeFireJoin(ctx, p, w, e, selfStatus, take);
      if (fired !== undefined) events.push(fired);
    }
    return events;
  }

  /**
   * True when a failed Task's failure is contained by a downstream join.
   *
   * `onBranchError: skip` means exactly this: the branch contributes nothing and the
   * run carries on with recorded, partial evidence. Without this check a single
   * failed branch would fail the whole run, which would make `skip` a lie.
   */
  #absorbedByJoin(ctx: RunContext, nodeId: NodeId): boolean {
    for (const e of ctx.index.outbound.get(nodeId) ?? []) {
      if (e.kind !== "join") continue;
      const mode = ctx.index.byId.get(e.to)?.join?.onBranchError;
      // `compensate` is refused at compile (GRAPH008_COMPENSATE_UNIMPLEMENTED), so it
      // cannot reach here. It is NOT aliased to `skip` — that alias is what let a graph
      // ask for a rollback and silently get a discard.
      //
      // WHAT WIRING IT WOULD TAKE, recorded here because this is the line a reader reaches
      // when they ask why the word is still refused now that an executor exists. Three things,
      // and the third is the one that makes it more than plumbing:
      //
      //  1. A BRANCH SCOPE THE PLANNER DOES NOT HAVE. `CompensationInput` scopes by `sinceSeq`,
      //     a seq RANGE — and branches INTERLEAVE in seq by construction. That is not an
      //     oversight to route around, it is the planner's central claim: `seq` is the only
      //     order the journal can justify, so two concurrent branches are unwound interleaved.
      //     A range therefore cannot express "this branch", and the scope has to become a
      //     branch-path prefix over the recording `taskId`. That is `run/compensation.ts`.
      //  2. A TRIGGER POINT EARLIER THAN THE BARRIER. By the time `#maybeFireJoin` counts the
      //     failed branch, `#commit` has applied its writes, so the rollback belongs in the
      //     commit of the failing Task — before the join is notified, not after it folds.
      //  3. A FOURTH ANSWER FROM THIS METHOD. `skip` needs only "contained: yes". `compensate`
      //     is contained ONLY IF THE ROLLBACK CLEANED UP: a branch whose undo came back
      //     `failed` or `not_attempted` has left the run holding an effect nobody reversed, and
      //     absorbing it would report partial evidence over a world nobody restored — which is
      //     the same silent-discard this refusal exists to prevent, one layer down. So the
      //     tally has to decide, and `boolean` is the wrong return type for that.
      //
      // The refusal and its implementation land together or not at all, so wiring this also
      // deletes GRAPH008_COMPENSATE_UNIMPLEMENTED in `graph/validate.ts` and the case in
      // `test/graph/compensation-honesty.test.ts` that pins it.
      if (mode === "skip") return true;
    }
    return false;
  }

  /**
   * Schedule the join behind a fan-out that planned zero branches.
   *
   * The join runs at the PARENT branch with no contributions, which is exactly what an
   * empty fold means: `findings` stays at its initial value and the verdict downstream
   * reads "no evidence" rather than the graph quietly stopping.
   */
  #fireEmptyJoin(ctx: RunContext, fanout: EdgeSpec, parent: BranchCoordinate): NewEvent[] {
    const events: NewEvent[] = [];
    for (const e of ctx.index.outbound.get(fanout.to) ?? []) {
      if (e.kind !== "join") continue;
      if (!(ctx.index.byId.get(e.to)?.join?.branches ?? []).includes(fanout.to)) continue;
      const id = makeTaskId(e.to, parent, 0);
      if (events.some((x) => x.taskId === id)) continue;
      events.push({
        type: "task.ready",
        payload: { nodeId: e.to, branchPath: encodeBranch(parent), edgesIn: [e.id] },
        actor: SYSTEM_ACTOR("scheduler"),
        taskId: id,
      });
    }
    return events;
  }

  /** One branch Task of a fan-out, at a determined coordinate. */
  #branchReady(e: EdgeSpec, parent: BranchCoordinate, index: number, item: unknown): NewEvent {
    const branch = childBranch(parent, e.id, index);
    return {
      type: "task.ready",
      payload: {
        nodeId: e.to,
        branchPath: encodeBranch(branch),
        edgesIn: [e.id],
        binding: { channel: e.as ?? "item", value: item },
      },
      actor: SYSTEM_ACTOR("scheduler"),
      taskId: makeTaskId(e.to, branch, 0),
    };
  }

  /**
   * Create the next unmaterialised branch(es) of the fan-out that produced this Task.
   *
   * Called after a branch commits, so the in-flight count has just dropped by one.
   * Nothing is lost if the process dies mid-fan-out: the plan is journaled and the
   * materialised set is derivable from the Task records.
   */
  #topUpFanout(ctx: RunContext, p: RunProjection, w: Wave): NewEvent[] {
    const last = w.task.branch.segments.at(-1);
    if (last === undefined) return [];

    const parent: BranchCoordinate = { segments: w.task.branch.segments.slice(0, -1) };
    const parentPath = encodeBranch(parent);
    const plan = p.fanouts[`${last.edgeId}@${parentPath}`];
    const edge = ctx.index.edgeById.get(last.edgeId as EdgeId);
    if (plan === undefined || edge === undefined) return [];

    const siblings = Object.values(p.tasks).filter(
      (t) => t.nodeId === plan.nodeId && encodeBranch({ segments: t.branch.segments.slice(0, -1) }) === parentPath,
    );
    const materialised = siblings.length;
    if (materialised >= plan.width) return [];

    // Exclude the committing Task: `p` predates its commit, so it still reads as
    // `leased` — and counting it would leave zero room forever at maxParallelism 1.
    const inFlight = siblings.filter(
      (t) => t.taskId !== w.task.taskId && (t.state === "ready" || t.state === "leased"),
    ).length;
    const room = Math.max(0, this.#maxParallelism - inFlight);
    if (room === 0) return [];

    // Re-read `over` at the PARENT branch: the item list is state, and reading it here
    // rather than caching it keeps the materialisation a pure function of the journal.
    const scope = scopeFor(p, ctx.graph.spec.channels, parent);
    const items = scope[edge.over ?? ""];
    if (!Array.isArray(items)) return [];

    const out: NewEvent[] = [];
    for (let i = materialised; i < Math.min(plan.width, materialised + room); i++) {
      out.push(this.#branchReady(edge, parent, i, items[i]));
    }
    return out;
  }

  /**
   * Decide whether a join's barrier is satisfied. The join Task is created at the
   * PARENT branch — that is what "a join collapses branches back to one instance"
   * means concretely.
   */
  #maybeFireJoin(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    edge: EdgeSpec,
    selfStatus: "succeeded" | "failed",
    take: readonly EdgeId[] = [],
  ): NewEvent | undefined {
    const joinNode = ctx.index.byId.get(edge.to);
    const join = joinNode?.join;
    if (join === undefined) return undefined;

    // WHICH INSTANCE OF THIS BARRIER the arriving branch belongs to comes from the
    // GRAPH, not from the arriving task's own depth. `slice(0, -1)` answers "one level
    // up from whoever just arrived", so two arms at different fan-out depths computed
    // different parents and minted several instances of one barrier. The compiled
    // fan-out depth is the same for every arm — `GRAPH008_JOIN_DEPTH` refuses the graphs
    // where it would not be.
    const depth = ctx.index.fanoutDepth.get(edge.to) ?? Math.max(0, w.task.branch.segments.length - 1);
    if (depth > w.task.branch.segments.length) return undefined;
    const parent: BranchCoordinate = { segments: w.task.branch.segments.slice(0, depth) };
    const parentPath = encodeBranch(parent);
    const joinTaskId = makeTaskId(edge.to, parent, 0);
    if (p.tasks[joinTaskId] !== undefined) return undefined; // already fired

    // Members are the DECLARED branch nodes under or at this instance's coordinate — the
    // same set `#foldJoin` folds. Counting one set and folding another is the shape
    // invariant 6 forbids for tools, reproduced one subsystem over.
    const siblings = Object.values(p.tasks).filter((t) => {
      if (!join.branches.includes(t.nodeId)) return false;
      const b = encodeBranch(t.branch);
      return b === parentPath || isDescendantBranch(parentPath, b);
    });

    // `expected` comes from the fan-out PLAN, not from a sibling count. Under lazy
    // materialisation a sibling count is "how many have started", so using it would
    // fire the barrier as soon as the first wave finished — silently dropping every
    // branch that had not been created yet.
    const planned = Object.entries(p.fanouts)
      .filter(([key, plan]) => key.endsWith(`@${parentPath}`) && join.branches.includes(plan.nodeId))
      .reduce((a, [, plan]) => a + plan.width, 0);
    const expected = planned > 0 ? planned : siblings.length;

    // `p` predates this Task's own commit, so substitute its outcome rather than
    // counting it twice — once as still-running and once as finished.
    const isTerminalState = (s: string): boolean =>
      s === "succeeded" || s === "failed" || s === "skipped" || s === "cancelled";

    // A Task that HANDED OFF within the join's own branch set has not terminated its
    // branch: an investigation that failed onto an error edge is still being handled by
    // the quarantine node behind it. Counting it as terminal fires the barrier before
    // the handler has run, and the recovery it exists for is silently discarded.
    //
    // `join.branches` already carries this: an edge to a node NOT in that set is an
    // arrival at the join; an edge to a node inside it is a continuation.
    const continuesInBranch = (t: { taskId: TaskId; take: readonly string[] }): boolean =>
      (t.taskId === w.task.taskId ? take : t.take).some((id) => {
        const to = ctx.index.edgeById.get(id as EdgeId)?.to;
        return to !== undefined && join.branches.includes(to);
      });

    // QUIESCENCE: a barrier may not fire while an arrival is still possible.
    //
    // `terminal >= expected` counts what has ALREADY arrived, which is only the right
    // question when every member is a direct fan-out target. With a fan-out inside a
    // fan-out, the outer join's declared `innerJoin` members have not been created yet
    // when the outer branches finish — so the barrier fired over an empty member set and
    // committed nothing, and the result depended on how many branches a wave happened to
    // hold. A node still reaches a member if it IS one or is one of its ancestors.
    const reachesMember = (nodeId: NodeId): boolean =>
      join.branches.some((bn) => bn === nodeId || (ctx.index.ancestors.get(bn as NodeId)?.has(nodeId) ?? false));

    // This Task's own hand-off is not in `p` yet, so read it from `take`.
    const handingOff = take.some((id) => {
      const to = ctx.index.edgeById.get(id)?.to;
      return to !== undefined && reachesMember(to);
    });
    const stillLive = Object.values(p.tasks).some((t) => {
      if (t.taskId === w.task.taskId) return false;
      if (isTerminalState(t.state)) return false;
      const b = encodeBranch(t.branch);
      if (!(b === parentPath || isDescendantBranch(parentPath, b))) return false;
      return reachesMember(t.nodeId);
    });
    const quiescent = !handingOff && !stillLive;

    let succeeded = 0;
    let terminal = 0;
    for (const t of siblings) {
      const state = t.taskId === w.task.taskId ? selfStatus : t.state;
      if (continuesInBranch(t)) continue;
      if (state === "succeeded") succeeded++;
      if (isTerminalState(state)) terminal++;
    }

    // QUIESCENCE GATES THE "NO" ANSWERS, NOT THE "YES" ONES.
    //
    // A mode that short-circuits does so on EVIDENCE ALREADY IN HAND — one success is one
    // success whether or not siblings are still running, and that is the whole reason to
    // ask for `any` rather than `all`. Only the conclusions that rest on ABSENCE need
    // quiescence: "every branch is in" and "the quorum can no longer be met" are both
    // claims about arrivals that will never come, and both were wrong before, because
    // `terminal >= expected` counted what had arrived rather than asking whether more
    // could. Gating the whole decision instead of just those two collapsed `any`,
    // `firstSuccess` and `quorum` into `all`: they released at exactly the same point.
    const fire = (() => {
      switch (join.mode) {
        case "all":
          return quiescent && terminal >= expected;
        case "any":
        case "firstSuccess":
          return succeeded >= 1;
        case "quorum": {
          const k = join.k ?? 1;
          const need = k <= 1 ? Math.ceil(k * expected) : k;
          return succeeded >= need || (quiescent && terminal >= expected);
        }
      }
    })();

    if (!fire) return undefined;
    return {
      type: "task.ready",
      payload: { nodeId: edge.to, branchPath: parentPath, edgesIn: [edge.id] },
      actor: SYSTEM_ACTOR("scheduler"),
      taskId: joinTaskId,
    };
  }

  // ── run completion ────────────────────────────────────────────────────────

  /**
   * End the run.
   *
   * EVERY path below closes the run's open gates in the same append, for the reason
   * `cancel` does: a gate that outlives its run is a question in somebody's queue with
   * nowhere left to land, and — until `resolve` learned to look at the run — was a way back
   * into one.
   *
   * The success path used to be exempt, on the grounds that `advance` re-suspends rather
   * than finishing while a gate is open. That is FALSE, and the counterexample is the same
   * one the failure paths already relied on: the budget/fatal floor at the top of `advance`
   * reaches `#finish` without passing the re-suspend check, and `#finish` completes a run
   * whose declared outputs are already written. So a SUCCEEDED run left a live gate behind
   * it. An exemption justified by a claim about a different function is an exemption that
   * survives exactly until that function changes.
   *
   * The reason strings differ per path and that is part of the audit record, not decoration:
   * "the run finished without you" and "an operator cancelled this" are different facts
   * about why a question left somebody's queue, and only one of them means a person decided
   * something.
   */
  async #finish(ctx: RunContext, p: RunProjection): Promise<void> {
    if (isTerminal(p.status)) return;
    this.#checkAnomaly(ctx, p);

    // A safety net for lazy materialisation: never complete a run that still has
    // unmaterialised branches. Reaching here means a top-up was missed, and finishing
    // would silently report a partial result as a whole one.
    for (const [key, plan] of Object.entries(p.fanouts)) {
      const parentPath = key.slice(key.indexOf("@") + 1);
      const started = Object.values(p.tasks).filter(
        (t) => t.nodeId === plan.nodeId && encodeBranch({ segments: t.branch.segments.slice(0, -1) }) === parentPath,
      ).length;
      if (started < plan.width) {
        await this.#failRun(ctx, p, {
          class: "internal",
          code: CODES.E_INTERNAL,
          message: `fan-out "${key}" planned ${plan.width} branches but only ${started} were materialised`,
          retryable: false,
        });
        return;
      }
    }

    const failed = Object.values(p.tasks).filter(
      (t) =>
        t.state === "failed" &&
        t.take.length === 0 &&
        (p.budgetExhausted || RUN_FATAL_CODES.has(t.error?.code ?? "") || !this.#absorbedByJoin(ctx, t.nodeId)),
    );
    if (failed.length > 0) {
      const first = failed[0]!;
      await this.#failRun(
        ctx,
        p,
        first.error ?? {
          class: "internal",
          code: CODES.E_INTERNAL,
          message: `task ${first.taskId} failed with no error edge`,
          retryable: false,
        },
      );
      return;
    }

    // A run that produced NONE of its declared outputs did not succeed, whatever the
    // Task states say. Reaching here means a path was stranded — and "succeeded, with
    // nothing to show for it" is the plausible-wrong-answer shape this system exists to
    // refuse. Partial outputs are allowed (a router arm may legitimately write only
    // some); producing not one of them is not.
    const outputs = collectOutputs(p, ctx.graph.spec);
    const declared = ctx.graph.spec.outputs;
    if (declared.length > 0 && Object.keys(outputs).length === 0) {
      await this.#failRun(ctx, p, {
        class: "internal",
        code: CODES.E_OUTPUT_MISSING,
        message: `run finished without writing any of its declared outputs (${declared.join(", ")})`,
        retryable: false,
      });
      return;
    }

    await this.#serialize(() =>
      ctx.log.append([
        ...cancelOpenGates(p, "the run completed before this gate was answered", SYSTEM_ACTOR("executor"), this.#gates),
        {
          type: "run.completed",
          payload: { outputs, usage: p.usage },
          actor: SYSTEM_ACTOR("executor"),
        },
      ]),
    );

    // `onComplete` — the one OBSERVER. It runs after the terminal event is durable, cannot change
    // anything, and a throw is contained: the run is already over, so failing it would report a
    // failure that did not happen. Nothing here is journaled, because an observer that changed
    // nothing has nothing to record — `hook.applied{changed:true}` would be false.
    const watchers = this.#hooksFor(ctx, "onComplete");
    if (watchers.length > 0) {
      await runObservers(watchers, { run: p }, {
        point: "onComplete",
        runId: ctx.runId,
        signal: ctx.abort.signal,
      });
    }
  }

  /**
   * THE ONLY PLACE A RUN FAILS, so the only place a rollback can be forgotten is nowhere.
   *
   * `#finish` had three `run.failed` appends and compensated on exactly ONE of them. The
   * exemption was written down as a named limit — "this arm means a node failed and the graph
   * declared no handler, which is the failure a compensation edge is written for; the other two
   * are Loom disagreeing with itself" — and the argument does not survive being stated next to
   * what compensation is for. A rollback is not about WHY the run ended; it is about what the
   * run DID. An `E_OUTPUT_MISSING` run inserted the same rows as a run whose last node threw,
   * and leaving them standing because the failure was the engine's fault rather than the
   * graph's is the loosening `run/compensation.ts` spends its whole header refusing: a
   * redundant undo shows up in the record as an attempt, an un-undone write shows up nowhere.
   *
   * COMPENSATION FIRST, THEN THE TERMINAL EVENT. `run.failed` is terminal and
   * `isTerminal(p.status)` is what every entry point checks before doing anything, so a
   * rollback appended after it is work on a run the rest of the engine has agreed is over.
   *
   * WHAT THIS DOES NOT FIX, said plainly because collapsing the three sites makes it easier to
   * believe it did: a task LEASED BY ANOTHER WORKER is still producing while this rolls back.
   * Both callers of `#finish` can be reached with one — the budget/fatal floor, and the drain
   * path, which sees an empty READY set when a peer holds every lease — and `ctx.abort` reaches
   * only this process. §F.13 ("a terminal operation is not final until every producer of the
   * state it ends is stopped") is the shape, and closing it needs a way to fence a lease this
   * engine does not hold, which is a different change. The window is bounded on this side at
   * least: `#compensate` re-plans from the journal, so an effect that lands during the rollback
   * is picked up by the next pass rather than by none.
   */
  async #failRun(ctx: RunContext, p: RunProjection, error: ErrorRecord): Promise<void> {
    await this.#compensate(ctx, p, "run_failed");
    await this.#serialize(() =>
      ctx.log.append([
        ...cancelOpenGates(p, "the run failed before this gate was answered", SYSTEM_ACTOR("executor"), this.#gates),
        { type: "run.failed", payload: { error }, actor: SYSTEM_ACTOR("executor") },
      ]),
    );
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  #expr(ctx: RunContext, src: string): Expr {
    let e = ctx.exprCache.get(src);
    if (e === undefined) {
      e = parseExpr(src);
      ctx.exprCache.set(src, e);
    }
    return e;
  }

  /**
   * The worst irreversibility any tool this node can reach declares.
   *
   * `max` over the reachable set, not a lookup on `node.tool` — an agent node names no
   * tool, so the old lookup answered `read_only` and let a model choose an irreversible
   * action at the weakest posture. An unregistered name still fails closed.
   */
  #irreversibilityOf(node: NodeSpec): IrreversibilityClass {
    const names = reachableToolNames(node);
    if (names.length === 0) return "read_only";
    let worst: IrreversibilityClass = "read_only";
    for (const name of names) {
      const cls = this.tools.get(name)?.irreversibility ?? "irreversible";
      // Ranked by the posture each class asserts, so there is ONE ordering of these
      // classes in the tree rather than a second copy here that can drift from it.
      // `irreversible` and `externally_visible` both assert `in` and so rank equal —
      // every branch in the engine treats them as one disjunction anyway.
      if (postureRank(CLASS_DEFAULT_POSTURE[cls]) > postureRank(CLASS_DEFAULT_POSTURE[worst])) worst = cls;
    }
    return worst;
  }

  #capabilitiesOf(node: NodeSpec): readonly string[] {
    const own = [...(node.policy?.capabilities ?? [])];
    for (const name of reachableToolNames(node)) {
      for (const cap of this.tools.get(name)?.capabilities ?? []) if (!own.includes(cap)) own.push(cap);
    }
    return own;
  }

  /**
   * Where a node's output goes.
   *
   * v1 convention, deliberately explicit rather than clever: any declared write
   * channel whose reducer is `sum` receives the Task's cost, and the node's own
   * output value goes to the first remaining declared write channel.
   */
  #assignWrites(
    ctx: RunContext,
    node: NodeSpec,
    explicit: Record<string, unknown> | undefined,
    usage: UsageRecord,
    value?: unknown,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const declared = node.writes ?? [];
    const costChannels = declared.filter((c) => ctx.graph.spec.channels[c]?.reduce === "sum");
    for (const c of costChannels) out[c] = usage.costUsd;

    if (explicit !== undefined) {
      for (const [k, v] of Object.entries(explicit)) if (k !== "_") out[k] = v;
      return out;
    }
    const target = declared.find((c) => !costChannels.includes(c));
    if (target !== undefined && value !== undefined) out[target] = value;
    return out;
  }

  /**
   * What the human is shown.
   *
   * `observedChannels`, NOT `node.reads`, and that is the same one-word correction the taint
   * rule and `dataClassification` already carry two hundred lines up. A `tool` node's arguments
   * are resolved against `scopeFor` — every channel, declared or not — so a channel named only
   * in `tool.args` reaches the tool while being absent from `reads`. Rendering `reads` showed
   * the approver a question that omitted the very value the tool was about to receive.
   */
  #gatePayload(ctx: RunContext, p: RunProjection, node: NodeSpec, task: TaskRecord): unknown {
    const view = viewFor(p, ctx.graph.spec.channels, task.branch, observedChannels(node));
    return {
      node: node.id,
      task: task.taskId,
      posture: ctx.graph.plans[node.id]?.posture ?? "out",
      irreversibility: this.#irreversibilityOf(node),
      state: Object.fromEntries(view.visible.map((c) => [c, view.get(c)])),
      costSoFarUsd: p.usage.costUsd,
    };
  }

  /**
   * WHAT THE APPROVAL BINDS — the half of the payload that decides what will execute.
   *
   * README said "an approval binds the graph it was shown". It bound the graph and the Task
   * and nothing else: `contentDigest` appeared in this file three times and all three were
   * comments, so no code anywhere compared what an approver was shown against what was later
   * dispatched. Measured on a real Engine before this existed — one gated `fs.write` whose
   * `body` is `${target}`, one ordinary same-wave `function` node writing `target`:
   *
   *     gate payload shown : state={"target":"SAFE"}
   *     tool received      : body="EVIL"
   *     run                : succeeded
   *
   * Every member is a pure function of graph, node, Task and channel state, because
   * `#dispatchApproved` re-derives this from a fresh projection — possibly in another process
   * after a restart — and compares. That is why `costSoFarUsd` is in the PAYLOAD and not here:
   * it is the run's cumulative spend, it moves whenever any sibling commits, and a check that
   * fired on it would refuse honest approvals. See `GateRequest.binding`.
   *
   *   - `spec` is the node itself. `graph.mutated` only ever APPENDS nodes and edges, so an
   *     existing node's digest is stable across a mutation — this pins the claim README makes,
   *     at the one node the approval is actually about.
   *   - `state` is the view HASH rather than the values: the binding is machine-read, and the
   *     values are already in the payload the human reads.
   *   - `args` is a digest for a stronger reason than compactness. Resolved arguments can hold
   *     a `secret_ref` channel's value, and a gate payload is rendered to a human and handed
   *     to a delivery dispatcher. A fingerprint binds what the tool will receive without
   *     disclosing it.
   *
   * The `try` around the fingerprint is DEFENSIVE and is not known to be reachable from a
   * graph — said plainly rather than dressed up as a measurement. `resolveArgs` does not throw
   * on a missing channel (it yields `undefined` or leaves the literal); what can throw is
   * `digest`, on a bigint, a symbol or a non-finite number — and a channel holding one of those
   * could not have been committed, because the journal content-addresses every write. It is
   * kept because raising a gate must not START failing for a graph that used to reach a human,
   * and because the sentinel is deterministic: the same unresolvable argument produces the same
   * string at dispatch, so the check passes and the node fails where it always failed, with its
   * own error rather than with this one.
   */
  #gateBinding(ctx: RunContext, p: RunProjection, node: NodeSpec, task: TaskRecord): unknown {
    const view = viewFor(p, ctx.graph.spec.channels, task.branch, observedChannels(node));
    return {
      node: node.id,
      task: task.taskId,
      spec: digest(node),
      posture: ctx.graph.plans[node.id]?.posture ?? "out",
      irreversibility: this.#irreversibilityOf(node),
      state: view.hash,
      ...(node.tool === undefined ? {} : { args: this.#argsFingerprint(ctx, p, node, task) }),
      // DELEGATED INPUTS ARE ARGS TOO. `observedChannels` scans `reads` and `tool.args` only,
      // and `validate.ts` checks a subgraph input's parent channel against `spec.channels`
      // rather than against `reads` — so a graph may delegate a channel it never declares, and
      // `state` above would not cover it. Measured before this line existed: an approver shown
      // `state: {}` approved, a same-wave sibling wrote 999 to the delegated channel, and the
      // child committed 1998. Same TOCTOU as the `tool.args` one, one field over.
      ...(node.subgraph?.inputs === undefined ? {} : { delegated: this.#delegatedFingerprint(ctx, p, node, task) }),
    };
  }

  /**
   * The VALUES a subgraph node will hand its child, fingerprinted at the projection the approver
   * was shown. Mirrors `#argsFingerprint` deliberately, including its failure shape.
   */
  #delegatedFingerprint(ctx: RunContext, p: RunProjection, node: NodeSpec, task: TaskRecord): string {
    try {
      const scope = scopeFor(p, ctx.graph.spec.channels, task.branch);
      const inputs = node.subgraph?.inputs ?? {};
      const bound: Record<string, unknown> = {};
      for (const [childChannel, parentChannel] of Object.entries(inputs)) {
        bound[childChannel] = (scope as Record<string, unknown>)[String(parentChannel)];
      }
      return digest(bound);
    } catch (e) {
      return `unresolved:${toLoomError(e).code}`;
    }
  }

  #argsFingerprint(ctx: RunContext, p: RunProjection, node: NodeSpec, task: TaskRecord): string {
    try {
      const scope = scopeFor(p, ctx.graph.spec.channels, task.branch);
      return digest(resolveArgs(node.tool?.args ?? {}, scope));
    } catch (e) {
      // Deterministic in the failure too: the code, not the message, because a message can
      // carry a value and this string is compared across processes.
      return `unresolved:${toLoomError(e).code}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/**
 * Is a divergence at this effect position fatal?
 *
 * Only for a tool whose own manifest says a second call is NOT harmless. `idempotent: true` is a
 * promise by the tool author that repeating the call costs nothing, and this is the one decision
 * that promise is load-bearing for. An unknown tool is treated as non-idempotent: a name the
 * registry cannot resolve is not evidence of safety.
 */
function identityMismatchIsFatal(tool: ToolDefinition | undefined): boolean {
  return tool?.idempotent !== true;
}

/** Abort-aware sleep: an interrupt ends the hold immediately rather than after it. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** What one recorded model turn contains. Replay reconstructs the turn from this. */
interface RecordedModelTurn {
  readonly content: string;
  readonly finishReason: string;
  readonly usage: UsageRecord;
  /**
   * WHO THE `done` FRAME NAMED — the input to D.7.6's refusal, recorded so a replay can reach
   * the same verdict.
   *
   * OPTIONAL, AND THE THREE STATES ARE NOT TWO. A name is the leaf that served the turn; `""` is
   * a frame that arrived and named nobody, which `#runAgent` refuses; ABSENT is "no terminal
   * frame at all", which it does not — and absent is what journals written before `e6d00f2` — NOT every journal written before this field. D.7.6's refusal existed in the window `e6d00f2..633e265^` while nothing wrote the field, so a journal from that window replays a provider refusal as a SUCCESS, with the refused string on the channel. No fix can invent a value the journal does not hold; naming the window is the whole remedy.
   * Outside that window an old recording replays as the run it actually was rather than being
   * re-judged under a rule its binary never had. `model.called.provider` beside it is not a
   * substitute: that field falls back to the wrapper's own name, so it cannot tell a turn nobody
   * claimed from one the router served.
   */
  readonly provider?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

const VERDICT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    score: { type: "number", minimum: 0, maximum: 1 },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["pass", "score"],
};

function pick(obj: Readonly<Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

/**
 * Does this Task HOLD its writes for a join, or apply them itself at commit?
 *
 * THE ONE PREDICATE, ASKED FROM BOTH SIDES. `#immediateReduce` asks "may I apply now?" and
 * `#foldJoin` asks "was this already applied?", and those are the same question inverted —
 * so they must be one function. They were not: only the first had a rule, and the fold
 * re-applied every member it had no reason to skip.
 *
 * Depth is the whole answer. A Task inside a fan-out has a non-empty branch coordinate, its
 * writes are held so its join can fold the siblings in branch order (associativity is what
 * makes that equal a one-level fold), and applying at commit would make the result depend on
 * which sibling finished first. A Task AT the root coordinate has no siblings to be ordered
 * against, so it applies its own writes and there is nothing left for a join to fold.
 */
function writesHeldForJoin(branch: BranchCoordinate): boolean {
  return branch.segments.length > 0;
}

function isDescendantBranch(prefix: string, candidate: string): boolean {
  return candidate !== prefix && candidate.startsWith(prefix === "root" ? "root/" : `${prefix}/`);
}

/** Channel state as seen at a branch, for a join's fold baseline. */
function stateAtPrefix(p: RunProjection, branch: BranchCoordinate): Record<string, unknown> {
  let out: Record<string, unknown> = { ...p.channels };
  for (const path of branchChain(branch)) {
    const bound = p.bindings[path];
    if (bound !== undefined) out = { ...out, ...bound };
  }
  return out;
}

/** `${channel}` and `${channel.path}` substitution in tool arguments. */

/**
 * IS THIS CHANNEL UNTRUSTED FOR THIS TASK'S DECISION — the durable set plus this wave's overlay.
 *
 * Both readers go through here so the two halves cannot drift apart. `ctx.tainted` is what the
 * journal can rebuild; `ctx.waveTaint` is what a concurrent member of the same wave is about to
 * write and has not committed yet. See `RunContext.waveTaint` for why the second cannot simply
 * be folded into the first.
 */
function taintedFor(ctx: RunContext, taskId: TaskId, channel: string): boolean {
  return ctx.tainted.has(channel) || (ctx.waveTaint.get(taskId)?.has(channel) ?? false);
}

/**
 * Which channels an EXTERNAL node in this wave is about to taint, per task that is not it.
 *
 * Named beside `applyTaint` and using the same `isExternal` test, because "what counts as
 * untrusted output" must have exactly one definition — this repo has already paid for the
 * version where a rule was written twice and the copies disagreed.
 */
function waveTaintFor(wave: readonly Wave[]): Map<TaskId, ReadonlySet<string>> {
  const out = new Map<TaskId, ReadonlySet<string>>();
  const willTaint = wave.filter((w) => isExternal(w.node));
  if (willTaint.length === 0) return out;
  for (const w of wave) {
    const channels = new Set<string>();
    for (const other of willTaint) {
      if (other.task.taskId === w.task.taskId) continue;
      for (const c of other.node.writes ?? []) channels.add(c);
    }
    if (channels.size > 0) out.set(w.task.taskId, channels);
  }
  return out;
}

/**
 * Node types whose executor is runtime code that has no way out of the process.
 *
 * A `router` evaluates `cases[].when` expressions — `mode: "model"` is refused at compile time
 * by `GRAPH005_ROUTER_MODE_UNSUPPORTED`, so a compiled router never calls a model. A `join`
 * merges branch outputs its own reads already name. A `human_gate` writes a decision a HUMAN
 * made, and a human is the trusted actor this whole axis exists to protect.
 *
 * None of the three can be labelled either way, and none needs to be: nothing about the graph
 * changes whether they can reach outside. Everything NOT in this set is untrusted unless the
 * author says otherwise, which is why this is a named set and not a default arm — a node type
 * added later is untrusted until somebody looks at it here and decides it belongs.
 */
const STRUCTURALLY_PURE: ReadonlySet<NodeSpec["type"]> = new Set(["router", "join", "human_gate"]);

/**
 * A node whose writes carry output from outside the system. The ONE definition.
 *
 * UNLABELLED MEANS UNTRUSTED, and it did not used to. This predicate listed the shapes that name
 * a way out — `tool`, `subgraph`, an `agent` with tools, a `function` with declared effects — and
 * everything else originated CLEAN. So the protection was bought by a label and the label was
 * optional. Measured on two graphs one label apart, same injected string, same downstream
 * irreversible `pay.charge`, same human de-escalation to `on`:
 *
 *     producer is a plain `function`, no `effects`   -> succeeded, 0 gates, charge made with
 *                                                       `{"memo":"IGNORE PREVIOUS INSTRUCTIONS"}`
 *     the same producer with `effects: ["net.fetch"]` -> E8 fires, floor clamps to `in`, gate raised
 *
 * An author who declares nothing must not get less protection than one who declares something.
 * A security axis whose failure of omission fails OPEN is not a security axis.
 *
 * THE FLIP IS NOT `return true`. Taint by default with no way to say otherwise taints every graph,
 * and an axis that marks everything carries no information — the E8 floor would clamp every
 * irreversible node in every graph and the gate would become the approval-fatigue noise that makes
 * an oversight mechanism worthless. So the flip comes with a declassification label, and the label
 * is `effects: []`: the SAME field that declares the ways out, used to say there are none. Absent
 * `effects` is the author saying NOTHING; `effects: []` is the author saying NONE, and only the
 * second is a claim. `ALLOWED_FIELDS.function` already accepts the field and `compileOrThrow`
 * already preserves an empty array distinctly from absence (measured), so no schema moves.
 *
 * `agent` gets no such label, and deliberately. An agent node's output is model-generated text
 * whatever it was given, so there is no pure agent for a label to describe. This is a WIDENING —
 * the old rule trusted `tools: []` — and it is the same fact one node type over: `tools` absent
 * and `tools: []` were both read as "trusted", so an agent that relayed a prompt-injected
 * document laundered it. `evaluator` splits on `kind` rather than on a label, because the split
 * is in the executor: the `assertion` arm runs a function body with no `ctx.effects` bound at
 * all, the `rubric` arm is one model call.
 */
function isExternal(node: NodeSpec): boolean {
  if (STRUCTURALLY_PURE.has(node.type)) return false;
  // A `function` node that DECLARED EFFECTS can reach a tool, so it produces untrusted output
  // exactly as an agent with tools does; one that declared the empty set has no name it can say
  // and so cannot reach one. Widening `reachableToolNames` without widening this is the same set
  // answered two ways, which is the shape that produced the agent hole in the first place.
  // `Array.isArray` and not `.length`, because this reads a value that can arrive from a JOURNAL
  // as well as from a compiler that now refuses the bad shapes. `null`, `{}`, `0` and
  // `{length: 0}` all have no usable `length`, so the old test read them as "declared, and
  // empty" — the author's claim of purity — and marked the node TRUSTED. An unreadable label
  // fails closed: it is not a smaller claim, it is one nobody can check.
  if (node.type === "function") {
    const declared: unknown = node.function?.effects;
    if (declared === undefined) return true;
    return !Array.isArray(declared) || declared.length > 0;
  }
  if (node.type === "evaluator") return node.evaluator?.kind !== "assertion";
  return true;
}

/**
 * Is this tool call, inside this task, downstream of untrusted content?
 *
 * `ordinal > 0` is the load-bearing half: it says a tool has already returned in this task.
 * A `tool` node always calls with ordinal 0 and `nodeApproved`, so it is unaffected — this
 * exists for the agent loop, where the model chooses.
 */
function taintedTurn(ctx: RunContext, task: TaskRecord, ordinal: number): boolean {
  if (ordinal > 0) return true;
  const node = ctx.index.byId.get(task.nodeId);
  return node !== undefined && observedChannels(node).some((c) => taintedFor(ctx, task.taskId, c));
}

/**
 * THE CONFIDENTIALITY FLOW RULE, and the only place it is written.
 *
 * Deliberately the same shape as `applyTaint` one function below, because it answers the same
 * question on the other axis: a node that OBSERVED sensitive data and wrote something has passed
 * it on. `applyTaint`'s docstring records what happens when only half of that is implemented — a
 * `function` node doing `clean = copy(notes)` laundered untrusted content away, and those are
 * ordinary graph shapes. Confidentiality had NEITHER half: classification was read off the
 * channel spec and never followed the data, so one hop through a normalizer dropped a
 * `secret_ref` to whatever the next channel declared.
 *
 * SENSITIVE means `pii` or `secret_ref` — the two classifications whose posture floor is above
 * `out`. `internal` is not a secret; treating it as one would mark almost every channel and turn
 * this into a constant gate, which is the approval-fatigue failure that makes an oversight
 * mechanism worthless.
 *
 * The DECLARED classification still does its own work in `dataClassification`. This set is only
 * consulted where the declared one cannot help: under a human ceiling, where a laundered secret
 * is new information and a declared one is not.
 */
function applySecretFlow(
  carriesSecret: Set<string>,
  node: NodeSpec,
  writes: Readonly<Record<string, unknown>>,
  channels: Readonly<Record<string, { readonly classification?: Classification }>>,
): void {
  const sensitive = (c: string): boolean => {
    const declared = channels[c]?.classification;
    return declared === "secret_ref" || declared === "pii" || carriesSecret.has(c);
  };
  if (!observedChannels(node).some(sensitive)) return;
  for (const channel of Object.keys(writes)) carriesSecret.add(channel);
}

/**
 * THE taint rule, and the only place it is written.
 *
 * Two ways a node's writes carry untrusted content, and the second was missing entirely:
 * the node fetched it (an external producer), or the node OBSERVED it and passed it on. With
 * only the first half, any node that is not a tool laundered taint away — a `function` node
 * doing `clean = copy(notes)`, or an `agent` declaring `tools: []` and relaying its input, both
 * reproduced running an irreversible charge under a de-escalated ceiling with nothing raised.
 * Those are ordinary graph shapes: a normalizer, a summariser.
 *
 * Monotonic and never cleared, so folding it forward from seq 1 gives the same answer as
 * running it live — which is what makes the rebuild at attach honest rather than approximate.
 * The cost is over-gating: a tainted channel later overwritten by trusted data stays tainted.
 * That is the fail-safe direction, and there is deliberately no declassification operator.
 */
function applyTaint(tainted: Set<string>, node: NodeSpec, writes: Readonly<Record<string, unknown>>): void {
  // `subgraph` counts as external, and deliberately over-approximates. A child runs under a
  // DIFFERENT `RunId` and therefore a different `RunContext` with its own taint set, so nothing
  // the child learned reaches the parent — a child that fetched untrusted text and mapped it out
  // through `sub.outputs` handed the parent a channel that looked clean, and the parent charged
  // on it. Carrying the child's set across the boundary would be more precise and would not
  // SURVIVE: the fold at attach reads committed writes, and which of a child's channels were
  // tainted is not among them. Treating the boundary itself as untrusted is the version that
  // rebuilds. The cost is a pure-computation subgraph tainting its outputs.
  //
  // The other direction needs no rule. Each run gets its own `PolicyEngine` (`#contextFor`), so
  // a parent's ceiling never reaches the child, and the child re-decides every node at full
  // strictness — an irreversible child node gates at `in` on its class whatever the parent did.
  if (!isExternal(node) && !observedChannels(node).some((c) => tainted.has(c))) return;
  for (const channel of Object.keys(writes)) tainted.add(channel);
}

/**
 * `${channel}` and `${channel | json}` — the value, or the value as text.
 *
 * A lone `${x}` yields the VALUE so an object stays an object, and that is right: a tool whose
 * schema wants an object must receive one. The consequence nobody had a way around is the other
 * direction. Writing a structured channel to a file needs TEXT, and `fs.write` refuses an object
 * with "value.body must be a string" — so an author had to insert a `function` node whose entire
 * job was `JSON.stringify`, plus a published resource to hold it. Measured while authoring a
 * report-writing graph: one extra node and one extra file to serialise one value.
 *
 * `| json` says it explicitly. The embedded form (`"see ${x} here"`) already stringifies a
 * non-string, so this makes the whole form able to express the same intent without the trailing
 * space that was the only workaround.
 *
 * THE SUFFIX IS PARSED IN `graph/spec.ts`, not here. This file used to own the only regex that
 * knew `| json` existed, and `observedChannels` — which every classification, laundering and
 * taint decision reads — did not, so it named the channel `"secret | json"` while this function
 * looked up `secret`. Four documented characters and the guard stopped firing. One parse now, so
 * the two cannot disagree again.
 */
function resolveArgs(args: Readonly<Record<string, unknown>>, scope: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const resolveOne = (expr: string): { value: unknown; asText: boolean } => {
    const { path, asText } = parseTemplateExpr(expr);
    return { value: lookup(scope, path), asText };
  };
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\$\{([^}]+)\}$/.exec(v);
      // A lone `${x}` yields the VALUE (so an object stays an object); an embedded
      // one interpolates as text. `| json` asks for text explicitly.
      if (whole) {
        const { value, asText } = resolveOne(whole[1]!.trim());
        if (!asText) return value;
        return value === undefined ? undefined : typeof value === "string" ? value : JSON.stringify(value, null, 2);
      }
      return v.replace(/\$\{([^}]+)\}/g, (m, path: string) => {
        const { value } = resolveOne(path.trim());
        return value === undefined ? m : typeof value === "string" ? value : JSON.stringify(value);
      });
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = sub(val);
      return out;
    }
    return v;
  };
  return sub(args) as Record<string, unknown>;
}

function lookup(scope: Readonly<Record<string, unknown>>, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Pull a mutation out of an agent's structured output.
 *
 * Only when the node declared `canMutate`. Without that flag the key is ignored, so a
 * model cannot grant itself the ability by emitting the right shape.
 */
function extractMutation(value: unknown, w: Wave): GraphMutation | undefined {
  if (w.node.agent?.canMutate !== true) return undefined;
  if (value === null || typeof value !== "object") return undefined;
  const raw = (value as { mutation?: unknown }).mutation;
  if (raw === null || raw === undefined || typeof raw !== "object") return undefined;
  const m = raw as { addNodes?: unknown; addEdges?: unknown; reason?: unknown };
  return {
    addNodes: Array.isArray(m.addNodes) ? (m.addNodes as NodeSpec[]) : [],
    addEdges: Array.isArray(m.addEdges) ? (m.addEdges as EdgeSpec[]) : [],
    proposedBy: w.task.taskId,
    proposedByNode: w.node.id,
    ...(typeof m.reason === "string" ? { reason: m.reason } : {}),
  };
}

/**
 * Map a tool's own write vocabulary onto the NODE's declared channels.
 *
 * A TOOL CANNOT KNOW THE GRAPH'S CHANNEL NAMES. `fs.write` calls its output `written`;
 * the graph that uses it may call the channel `note`, `receipt`, or `audit_row`. Taking
 * the tool's keys verbatim makes every built-in tool usable only by graphs that happened
 * to guess its internal vocabulary — and the failure arrives AFTER the side effect, as
 * `E_CHANNEL_UNDECLARED` on a file already written.
 *
 * The rule is the one `#assignWrites` already documents for agent nodes: a value the node
 * did not name goes to the node's declared write channel. Keys the node DID declare pass
 * through untouched, which is what a graph-local tool wants.
 */
function mapToolWrites(node: NodeSpec, writes: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const declared = new Set(node.writes ?? []);
  const out: Record<string, unknown> = {};
  const unmapped: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(writes)) {
    if (declared.has(key)) out[key] = value;
    else unmapped[key] = value;
  }

  const keys = Object.keys(unmapped);
  if (keys.length === 0) return out;

  // Where does the unnamed value go? The first declared channel this tool has not
  // already filled. With none left there is nowhere honest to put it, and dropping it
  // silently would make a tool look like it wrote something it did not.
  const target = (node.writes ?? []).find((c) => !(c in out));
  if (target === undefined) return out;

  // One unmapped key unwraps; several stay an object, since collapsing them would lose
  // which was which.
  out[target] = keys.length === 1 ? unmapped[keys[0]!] : unmapped;
  return out;
}

function firstWrite(node: NodeSpec): string | undefined {
  return (node.writes ?? [])[0];
}

/**
 * Every run this one delegated to, from its own journal.
 *
 * `subgraph.started` is the ONLY link between two journals — the child's id is derived from
 * the parent's, but derivation is a convention and the event is the record. Reading it here
 * is what makes a cancel reach work the operator never named.
 *
 * DEDUPED, because the parent journals its intent before the child exists (see
 * `#runSubgraph`): a crash between those two appends leaves the reference standing, and the
 * retry writes it again. Two rows, one child.
 */
async function childRunsOf(log: RunLog): Promise<readonly RunId[]> {
  const out = new Set<RunId>();
  for await (const ev of log.read(1)) {
    if (isEvent(ev, "subgraph.started")) out.add(ev.payload.childRunId);
  }
  return [...out];
}

/**
 * The `gate.cancelled` events that close a run's open gates, for the append that ends it.
 *
 * THE WRITE SIDE THAT WAS NEVER BUILT. D7.3's lifecycle FSM has specified
 * `Open --> Cancelled: gate.cancelled` since it was drawn, D6.4 rule 4 spells out why
 * (`ctx.abort` reaches every in-flight effect and cannot reach a gate — there is no work
 * to interrupt), the event type has been in `EVENT_TYPES` and folded by `projection.ts`
 * for as long, and nothing in `src/` ever appended one. A read model with no writer looks
 * exactly like a finished feature right up until somebody answers the gate.
 *
 * Emitted in the SAME append as the terminal event, never as a follow-up: a crash between
 * the two would leave a stopped run with a live gate, which is precisely the state that
 * made the run answerable again.
 */

/**
 * The manifest as one comparable string.
 *
 * A COPY of `replay.ts`'s local `refKey`, deliberately, and the two must stay identical. Both
 * modules are barrelled through `index.ts`, so exporting a four-line pure function from either
 * would put it on the pinned public surface — the trade `storeDenyLists` already made in
 * `resources/store.ts` for the same reason. If one of these changes, change both.
 */

/** The smallest of the numbers that are present, or `undefined` when none are. */
function minDefined(...values: readonly (number | undefined)[]): number | undefined {
  let best: number | undefined;
  for (const v of values) if (v !== undefined && (best === undefined || v < best)) best = v;
  return best;
}

function manifestKey(m: readonly { readonly ref: string; readonly digest: string }[]): string {
  return m
    .map((r) => `${r.ref}=${r.digest}`)
    .sort()
    .join("\n");
}

function cancelOpenGates(
  p: RunProjection,
  reason: string,
  actor: Actor,
  gates: HumanGateBroker,
): readonly NewEvent[] {
  // The broker's non-durable half is NOT released here, deliberately — see `releaseClosed`,
  // which the callers invoke once the append has landed. Building the events is not the same
  // moment as the gates closing, and a cancel that loses its `commit` must not have dropped
  // anything.
  const closing = openGates(p);
  // The engine closes these; the broker never sees them through `resolve` or `#expire`, so this
  // is the only point at which their non-durable payloads can be let go.
  gates.releaseClosed(closing.map((g) => g.gateId));
  return closing.map((g): NewEvent => ({
    type: "gate.cancelled",
    payload: { gateId: g.gateId, reason },
    actor,
    // A gate raised by an event carrying no `taskId` folds to `""`; attributing the
    // closure to a Task that does not exist is worse than attributing it to none.
    ...(g.taskId === ("" as TaskId) ? {} : { taskId: g.taskId }),
  }));
}

/**
 * The MOST RECENT decision on this Task, not the first one recorded.
 *
 * A Task raises more than one gate whenever the work behind it suspends more than once —
 * a subgraph node raises a mirror per child gate. Reading the first decided gate meant a
 * rejection of the second question was answered by the approval given to the first: the
 * executor re-forwarded the stale `approve` and the action the human had just refused
 * went through. Ordering is by `raisedAtSeq`, the journal's own order, so it does not
 * depend on how a projection happens to enumerate its map.
 */
function lastDecidedGate(p: RunProjection, taskId: TaskId): GateRecord | undefined {
  let latest: GateRecord | undefined;
  for (const g of Object.values(p.gates)) {
    if (g.taskId !== taskId || g.state !== "decided") continue;
    if (latest === undefined || g.raisedAtSeq > latest.raisedAtSeq) latest = g;
  }
  return latest;
}

/**
 * The open gate a run has been waiting on longest, by JOURNAL order.
 *
 * `Object.values(gates).find(open)` gave the same answer in practice and depended on map
 * insertion order to do it — which is not a rule anything states, and which two separate
 * call sites were quietly relying on to agree with each other. `raisedAtSeq` is the
 * journal's own total order, so this is stable across a rebuild of the projection.
 */
function oldestOpenGate(p: RunProjection): GateRecord | undefined {
  let oldest: GateRecord | undefined;
  for (const g of Object.values(p.gates)) {
    if (g.state !== "open") continue;
    if (oldest === undefined || g.raisedAtSeq < oldest.raisedAtSeq) oldest = g;
  }
  return oldest;
}

/**
 * The one place a gate's authorization is computed, for every node type.
 *
 * `allowEdit` is the node's DECLARED WRITES and never anything wider. An `edit` decision
 * lands as this Task's writes in THIS run, so a node that may write one channel may have
 * one channel edited, and a node that declares none may have none — `[]`, not "absent",
 * which the broker reads as unconstrained.
 *
 * A mirror gate does NOT come through here — see `mirrorAuthorizationOf`. It used to,
 * with the child's approvers passed as an optional argument, and an optional argument is
 * the wrong shape for the question: a child gate that names nobody supplies `undefined`,
 * which is indistinguishable from "not a mirror at all", and the mirror silently fell
 * back to this node's own rules.
 */
function gateAuthorizationOf(node: NodeSpec, p: RunProjection): GateAuthorization {
  const approvers = node.humanGate?.approval?.approvers ?? [];
  return {
    approvers,
    // RESOLVED HERE, in the one place a gate's authorization is computed, so no raise path
    // can forget it. `sodRefusal` has already been consulted by the caller — this only turns
    // a satisfied rule into the list `#authorize` will read back out of the journal.
    excludedApprovers:
      node.humanGate?.approval?.separationOfDuties === true && typeof p.submittedBy?.subject === "string"
        ? [p.submittedBy.subject]
        : undefined,
    allowEdit: node.writes ?? [],
  };
}

/**
 * The one place a gate's CLOCK and ROUTE are read off the node, for every node type.
 *
 * It returns a spreadable object rather than an optional value so that a node declaring
 * nothing contributes no keys at all — `exactOptionalPropertyTypes` makes
 * `{schedule: undefined}` a different thing from `{}`, and `GateRequest` reads an absent
 * `slaMs` as "this gate has no deadline" while an explicit `undefined` would not typecheck.
 *
 * ONLY A `human_gate` NODE CAN DECLARE ANY OF THIS, because `humanGate` is the only block
 * carrying it and `GRAPH020_EXTRA_BLOCK` refuses a second type block. So a gate raised by
 * the posture floor on a tool node gets no deadline and no delivery, which is the honest
 * answer: nobody wrote one down. Give that gate an SLA by putting the action behind an
 * explicit `human_gate` node.
 *
 * A MIRROR GATE GETS NOTHING FROM HERE EITHER — `#runSubgraph` builds its own outcome, and
 * a `subgraph` node has no `humanGate` block to declare a route on. That is a real gap:
 * the mirror is the gate a human answers, and today it is queued rather than sent. It is
 * left rather than guessed at, because the natural fix is to inherit the CHILD gate's
 * delivery spec, and the child's spec names channels and recipients resolved in the
 * child's deployment — the same namespace mistake `mirrorAuthorizationOf` documents having
 * made twice with `allowEdit`.
 */
function scheduleOf(node: NodeSpec): GateSchedule {
  const sla = node.humanGate?.sla;
  const delivery = node.humanGate?.delivery;
  const batching = node.humanGate?.batching;
  const dedupe = node.humanGate?.dedupe;
  return {
    ...(sla?.respondWithinMs === undefined ? {} : { slaMs: sla.respondWithinMs }),
    ...(sla?.onTimeout === undefined ? {} : { onTimeout: sla.onTimeout }),
    // On `sla` rather than on `delivery`, because a reminder chooses no new recipients and
    // no new channels — see `GateSlaSpec.reminders`. It travels with the clock it is
    // measured against, and a node with no `sla` block contributes neither.
    ...(sla?.reminders === undefined ? {} : { reminders: sla.reminders }),
    ...(delivery === undefined ? {} : { delivery }),
    ...(batching === undefined ? {} : { batching }),
    ...(dedupe === undefined ? {} : { dedupe }),
  };
}

/**
 * A mirror gate's authorization: the child's approvers, and no editable channel at all.
 *
 * THE APPROVERS ARE THE CHILD'S because the mirror is the gate a human actually answers,
 * and the declaration is one run away from the action it guards.
 *
 * `allowEdit` is `[]`, which took two tries to get right. The first attempt gave the
 * mirror the child's own allow-list, naming channels in another graph's namespace. The
 * correction gave it `node.writes` — right about namespaces, wrong about everything else,
 * because for a subgraph node `node.writes` is exactly the channels the child's result
 * maps INTO. An `edit` there let a human hand the parent a result the child never
 * produced, report success with no `subgraph.completed`, and leave the child suspended on
 * an open gate forever. A mirror asks "does this delegated action go ahead?"; yes and no
 * are the whole answer it can carry, `#authorize` refuses the other two decisions
 * outright, and `[]` is how that reads back out of the journal.
 */
function mirrorAuthorizationOf(childGate: GateRecord): GateAuthorization {
  return {
    approvers: childGate.approvers ?? [],
    // INHERITED, for the reason the approvers are — and the reason is security rather than
    // economy. Without it the initiator approves the parent's mirror and `executor:subgraph`
    // forwards that approval into a child gate that excludes them: the rule is enforced one
    // run away from where the decision was made, which is exactly the hole the mirror's
    // approvers inheritance was built to close, one field over. A child run inherits its
    // parent's principal, so the child's exclusion and the parent's are the same subject.
    excludedApprovers: childGate.excludedApprovers,
    allowEdit: [],
  };
}

type ParseResult = { ok: true; value: unknown } | { ok: false; errors: readonly string[] };

function parseOutput(text: string, schema: JSONSchema | undefined): ParseResult {
  if (schema === undefined) return { ok: true, value: text };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: [`expected JSON matching the node's outputSchema, got: ${text.slice(0, 120)}`] };
  }
  const r = validate(schema, parsed);
  return r.ok ? { ok: true, value: r.value } : { ok: false, errors: r.errors };
}

export type { GateDecision };

/**
 * The budget ceiling a failure actually hit, in dollars, and always finite.
 *
 * Both throw sites put `limit` in `details` — `PolicyEngine.reserve` for the run ceiling and
 * `#runAgent` for a node's own — so the number is on the error and does not need recomputing
 * from a `PolicyEngine` whose `remainingUsd` is `Infinity` when no run budget was set. The
 * fallback is what has been spent, which is finite by construction and is the honest answer
 * when an error arrives without the field: no ceiling can be named, so name the exposure.
 */
function exceededLimitUsd(e: LoomError, spentUsd: number): number {
  const limit = (e.details as { readonly limit?: unknown } | undefined)?.limit;
  // A NON-DOLLAR REFUSAL NAMES NO DOLLAR CEILING, so it takes the fallback below and this row's
  // `limitUsd` carries the run's exposure rather than a limit — the same honest answer the
  // fallback already gave for an error that arrived without the field. `dimension` and `limit`
  // are what say which number actually bound; see `exceededDimension`.
  const dimension = (e.details as { readonly dimension?: unknown } | undefined)?.dimension;
  if (dimension !== undefined && dimension !== "costUsd") return spentUsd;
  return typeof limit === "number" && Number.isFinite(limit) ? limit : spentUsd;
}

/**
 * WHICH of the declared triple refused the work, for the journal.
 *
 * Built conditionally rather than defaulted, for two reasons that point the same way.
 * `exactOptionalPropertyTypes` is on, so an explicit `dimension: undefined` is not the shape an
 * absent key has; and `budget.exhausted` rows already in journals carry neither field, so ABSENT
 * has to keep meaning `costUsd` — an append-only log cannot go back and say so. A `limit` that is
 * not a finite number is dropped rather than written, because `canonicalize` refuses a non-finite
 * number on the durable write path and a budget failure that fails to journal is worse than one
 * that journals less.
 */
function exceededDimension(e: LoomError): { readonly dimension?: "costUsd" | "tokens" | "wallMs"; readonly limit?: number } {
  const d = (e.details as { readonly dimension?: unknown; readonly limit?: unknown } | undefined) ?? {};
  if (d.dimension !== "costUsd" && d.dimension !== "tokens" && d.dimension !== "wallMs") return {};
  return {
    dimension: d.dimension,
    ...(typeof d.limit === "number" && Number.isFinite(d.limit) ? { limit: d.limit } : {}),
  };
}

/**
 * The WORST-CASE billed tokens of one model request, for the reservation.
 *
 * The input side is measurable — it is the transcript about to be posted — and the output side is
 * not, so it is bounded by the ceiling THE ADAPTER SAYS IT IS ABOUT TO SEND. That is the whole of
 * D.7.3: this used to end `req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS`, a constant of 1,024 in
 * this file, while a second constant of the same name in `providers/http.ts` holds 4,096 and is
 * what actually goes in the body. The engine never sets `ModelRequest.maxTokens`, so the `??` arm
 * was the only arm ever taken and the reservation under-described its own request by 4× at the
 * shipped default and by 31× against the 32,000-token row in
 * `docs/evolution-loop-2026-08-27.md`. `budget.tokens` therefore did not bind what it said.
 *
 * THE ADAPTER IS ASKED BECAUSE ONLY THE ADAPTER KNOWS. `defaultMaxTokens` is per-row because
 * endpoints differ, and under the CLI the registered adapter is a `RoutingAdapter` that resolves
 * a different leaf per `req.model` — so no number the engine could hold would be right. The
 * dollar reservation two branches up already does this correctly with `adapter.estimateOf`; this
 * is the same request described by the same authority instead of by a guess.
 *
 * OVER-ESTIMATING IS THE SAFE DIRECTION and under-estimating is not: a reservation exists so that
 * 25 fan-out branches cannot each see the same remaining balance, and one that is too small lets
 * them through. `estimateTokens` is chars/4, so a request full of long tokens estimates low —
 * the padding from the output ceiling is what keeps the reservation conservative in that case.
 */
/**
 * The adapter's own output ceiling, or a REFUSAL — never a number this file made up.
 *
 * The engine deleted its `DEFAULT_MAX_OUTPUT_TOKENS` because that constant was the defect, so
 * this has no fallback to return to and must not grow one. `outputCeilingOf` is required on
 * `ModelAdapter`, which settles it for every adapter TypeScript ever saw; this guard is for the
 * one it did not — a host-realm adapter handed in through `EngineOptions.models`, or one loaded
 * from outside the tree. Absent method, `undefined`, `NaN`, `Infinity`, zero or negative all
 * take the same arm, because none of them is a bound and each of them would otherwise reserve
 * less than the request can bill.
 *
 * WHAT IT DOES WHEN IT CANNOT DECIDE: it refuses the turn before the provider is reached. It
 * does NOT substitute a constant and continue — that substitution is exactly the shape D.7.3
 * removed, and restoring it for the adapters nobody in this repo wrote would be the same defect
 * pointed at the least-trusted code in the process.
 *
 * The residual is stated rather than guarded: an adapter that reports a ceiling lower than the
 * one it then sends cannot be caught by anything here, and the operator's own configuration
 * already extends it that trust.
 */
function outputCeilingOf(adapter: ModelAdapter, req: ModelRequest, where: string): number {
  const n = (adapter as Partial<ModelAdapter>).outputCeilingOf?.(req);
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `${where}: model adapter "${adapter.provider}" did not state an output ceiling — ` +
        `\`outputCeilingOf(req)\` returned ${String(n)}, and the token budget reserves against that ` +
        `number. It must return a finite, positive count of the output tokens this request may bill. ` +
        `Refusing the turn rather than reserving a number nobody vouched for.`,
      // `String(n)` and never `n`. The values that reach here are exactly the ones
      // `canonicalize` refuses on the durable write path — `NaN`, `Infinity`, `undefined` — and
      // this refusal is journaled. Putting the raw value in `details` turns a clean refusal into
      // an unhandled `CanonicalizationError` from inside the commit, which is a worse failure
      // than the one being reported. Measured: `non-finite number NaN at error.details.returned`.
      { details: { where, provider: adapter.provider, returned: String(n) } },
    );
  }
  return n;
}

/**
 * What a `quote` effect records: the two adapter answers a turn's budget refusals are made from.
 *
 * NOT THE REQUEST THAT WAS PRICED. A digest of that already rides on `model.called.requestDigest`,
 * and a turn a budget refuses makes no model call to carry one — so this is the ANSWER only, and
 * the effect key is what binds it to a turn.
 */
type RecordedQuote = { readonly estimateUsd: number; readonly outputCeiling: number };

/**
 * A recorded quote, or a DIVERGENCE — never a fallback to zero.
 *
 * Zero is the reading an OLD journal gets, where there is no row at all and the lower bound is
 * honest. A row that is present and unreadable is a different fact: something wrote a shape this
 * build does not understand, and reading it as zero would silently drop a refusal the recording
 * made. Refusing is always allowed; loosening never is.
 *
 * The bounds are the ones the writers guarantee — `outputCeilingOf` refuses anything that is not
 * finite and positive, `estimateUsdOf` anything that is not finite and non-negative — so a value
 * outside them did not come from this engine.
 */
function recordedQuote(result: unknown, key: string): RecordedQuote {
  const o = result as { estimateUsd?: unknown; outputCeiling?: unknown } | null | undefined;
  const usd = o?.estimateUsd;
  const ceiling = o?.outputCeiling;
  if (
    typeof usd !== "number" ||
    !Number.isFinite(usd) ||
    usd < 0 ||
    typeof ceiling !== "number" ||
    !Number.isFinite(ceiling) ||
    ceiling <= 0
  ) {
    throw err.internal(
      CODES.E_REPLAY_DIVERGENCE,
      `effect "${key}" recorded a quote this build cannot read — expected {estimateUsd >= 0, outputCeiling > 0}, ` +
        `got estimateUsd=${String(usd)} outputCeiling=${String(ceiling)}. Refusing rather than pricing the turn at zero, ` +
        `which would drop a refusal the recorded run made.`,
      { details: { key, estimateUsd: String(usd), outputCeiling: String(ceiling) } },
    );
  }
  return { estimateUsd: usd, outputCeiling: ceiling };
}

/**
 * The adapter's own dollar estimate, or a REFUSAL — the sibling of `outputCeilingOf` and added
 * for the same reason one step later.
 *
 * This used to be a bare `adapter?.estimateOf(shaped) ?? 0`, and a `NaN` from it disabled the run
 * budget in silence: `spent + NaN > cap` is `false`, so the node ceiling never fires, and
 * `PolicyEngine.reserve(scope, NaN, …)` reserves nothing measurable. Journaling the number makes
 * that worse rather than better — `canonicalize` refuses a non-finite number on the durable write
 * path, so the run would die `E_INTERNAL` from inside the commit instead of reporting anything
 * useful. So it is checked here, where the answer is still a value and not yet a row.
 *
 * `String(n)` in `details` for the reason `outputCeilingOf` gives: the values that reach this arm
 * are exactly the ones the write path refuses.
 */
function estimateUsdOf(adapter: ModelAdapter, req: ModelRequest, where: string): number {
  const n = (adapter as Partial<ModelAdapter>).estimateOf?.(req);
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `${where}: model adapter "${adapter.provider}" did not state a cost estimate — \`estimateOf(req)\` returned ` +
        `${String(n)}, and the run's dollar budget reserves against that number. It must return a finite, non-negative ` +
        `cost in USD. Refusing the turn rather than reserving a number nobody vouched for.`,
      { details: { where, provider: adapter.provider, returned: String(n) } },
    );
  }
  return n;
}

function estimateTurnTokens(req: ModelRequest, ceiling: number): number {
  let n = estimateTokens(req.system);
  for (const m of req.messages) n += estimateTokens(m.content);
  for (const t of req.tools) n += estimateTokens(t.name) + estimateTokens(t.description);
  return n + ceiling;
}

/**
 * The verdict on a finished model turn: `undefined` when it is an answer, an error when it is not.
 *
 * FX13. A reasoning model called with an output ceiling below its reasoning budget answered
 * `finish_reason: "max_tokens"` with `content: ""`. `#runAgent` read `finishReason` only to
 * journal it, so the empty string was written to the node's channel, folded through a `join`,
 * approved at a gate, written to disk — and the run reported `succeeded` under a report claiming
 * three files reviewed, one of which had contributed nothing. Both adapters already DROP a
 * truncated turn's partial tool calls (`providers/openai.ts`, `providers/anthropic.ts`), so a
 * truncated turn always arrives with no calls and always ends the loop: the last thing standing
 * between it and a channel was `parseOutput`, and a node with no `outputSchema` has no check
 * there at all. `""` is valid free text.
 *
 * THE SET, NOT THE ONE REASON THAT WAS SEEN. `FinishReason` is
 * `stop | tool_use | max_tokens | content_filter | refusal` (`run/registry.ts`); `mapFinish`
 * reaches `max_tokens`/`tool_use`/`content_filter`/`stop` and `mapStop` reaches
 * `max_tokens`/`tool_use`/`refusal`/`stop`. Two of those five are an answer. Everything else —
 * including a reason no adapter in this tree produces, which the replay arm can still read off
 * an older journal as a bare `string` — REFUSES. Fail closed on the unknown member is the whole
 * reason this is a `switch` with a `default` and not `finish === "max_tokens"`.
 *
 * EMPTINESS IS NOT THE TEST. A turn cut at 4,000 characters is as incomplete as one cut at zero,
 * and nothing downstream can tell which half went missing. Checking `content === ""` would close
 * the case that was observed and leave the case that is worse: a partial answer that reads like
 * a whole one.
 *
 * NOT RETRYABLE, DELIBERATELY. `validation` and `policy` are outside `RETRYABLE` (`errors.ts`)
 * and `#retryDecision` returns early on `!error.retryable`, so no `retry` policy can re-enter
 * this. That is the point: nothing about the request changed, so the provider truncates again at
 * the same ceiling and the operator pays twice for the same non-answer. The fix is a bigger
 * `maxTokens`, and the message says so. Continuing the ReAct loop was the other candidate and is
 * worse: the truncated message carries no tool call to answer and no content to build on, so the
 * next turn re-sends the same transcript under the same cap.
 */
/**
 * Whether a recorded tool result may stand in for a re-call.
 *
 * `effect.completed` is appended for a tool that RETURNED, including one that returned
 * `isError: true` — a throw takes the `effect.failed` arm instead. So "there is a completion"
 * is not the same question as "the call succeeded", and only the second one licenses serving.
 *
 * A tool author writes `isError` when their source was briefly unreachable, and the node's
 * retry is the answer to that. Handing the retry the recorded failure makes it re-read the
 * same sentence up to `maxAttempts` and never touch the source — retry present, retry
 * useless. The same predicate decides the non-idempotent refusal, because a call that will be
 * re-performed is a call that may ring the bell twice.
 */
function isServedToolResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: unknown }).isError !== true;
}

function turnRefusal(
  finish: string,
  where: string,
  contentChars: number,
  outputTokens: number,
  ceiling: number | undefined,
): LoomError | undefined {
  const details = { where, finishReason: finish, contentChars, outputTokens, ...(ceiling === undefined ? {} : { ceiling }) };
  // `undefined` only in a REPLAY, which reaches no adapter and so has nothing to ask. Every
  // live turn has a number, because the adapter that made the call is the thing that set it.
  const of = ceiling === undefined ? "" : ` of ${String(ceiling)}`;
  switch (finish) {
    case "stop":
    case "tool_use":
      return undefined;
    case "max_tokens":
      // D.7.4 — TWO OUTCOMES, NOT ONE SENTENCE SAID TWICE. `contentChars === 0` means the turn
      // never reached content at all: the model spent its whole output allowance reasoning and
      // stopped before the first character. That is a different problem from a clipped answer
      // and it needs a different action — an order of magnitude, not a nudge — and this arm
      // used to say "raise the model's max output tokens" to both. It is the defect that
      // produced an EMPTY reviewed-file in a live run, got approved by a human, and was written
      // to disk. The distinction was in hand the whole time and was printed as a number nobody
      // was told how to read.
      return contentChars === 0
        ? err.validation(
            CODES.E_PROVIDER_BAD_REQUEST,
            `${where}: the model emitted NO content — it spent all ${String(outputTokens)} output tokens under a ceiling${of} ` +
              `and stopped before the first character (finishReason "max_tokens"). This is not a clipped answer: the ceiling is ` +
              `below this model's reasoning floor, so nudging it up returns another empty turn. Raise "defaultMaxTokens" on this ` +
              `adapter — by an order of magnitude, not a margin — or set "maxTokens" on the request.`,
            { details },
          )
        : err.validation(
            CODES.E_PROVIDER_BAD_REQUEST,
            `${where}: the model stopped at its output-token ceiling${of} (finishReason "max_tokens") after ` +
              `${String(outputTokens)} output tokens and ${String(contentChars)} characters of content. ` +
              `This turn is truncated, not finished — raise "defaultMaxTokens" on this adapter, or set "maxTokens" on the ` +
              `request; retrying at the same ceiling truncates again.`,
            { details },
          );
    case "content_filter":
    case "refusal":
      return err.policy(
        CODES.E_CONTENT_FILTERED,
        `${where}: the provider ended the turn with finishReason "${finish}" and ${String(contentChars)} characters of content. ` +
          `A refused turn is not an answer.`,
        { details },
      );
    default:
      // A reason this build does not know. It cannot be shown to be an answer, so it is not one.
      return err.validation(CODES.E_PROVIDER_BAD_REQUEST, `${where}: unrecognized finishReason "${finish}"; refusing to treat it as an answer.`, {
        details,
      });
  }
}
