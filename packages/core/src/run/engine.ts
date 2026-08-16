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
 * See design/loom/03-RUNTIME.md D6 and 02-EXECUTION-GRAPH.md D4.
 */

import { digest, shapeOf } from "../canonical.ts";
import { CODES, err, isLoomError, toLoomError, type LoomError } from "../errors.ts";
import {
  ROOT_BRANCH,
  childBranch,
  compareBranch,
  effectKey,
  encodeBranch,
  newRunId,
  taskId as makeTaskId,
  type BranchCoordinate,
  type EdgeId,
  type GateId,
  type NodeId,
  type RunId,
  type Seq,
  type TaskId,
} from "../ids.ts";
import { SYSTEM_ACTOR, errorRecord, isEvent, type Actor, type HumanActor, type NewEvent } from "../journal/events.ts";
import type { StateStore } from "../journal/store.ts";
import type { EventBus } from "../bus.ts";
import { evaluate, parseExpr, type Expr } from "../graph/expr.ts";
import { reachableToolNames } from "../graph/spec.ts";
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
import { assembleContext, boundTurns } from "./context.ts";
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
  maxPosture,
  type GateDecision,
  type IrreversibilityClass,
  postureRank,
  CLASS_DEFAULT_POSTURE,
  type Posture,
  type UsageRecord,
} from "../vocab.ts";
import type { DeliverySpec } from "./delivery.ts";
import {
  GateSweeper,
  HumanGateBroker,
  type GateBatch,
  type GateSummary,
  type GateSweeperOptions,
  type ResolveBatchInput,
  type ResolveInput,
  type SweepReport,
  type TimeoutAction,
} from "./gates.ts";
import { RunLog } from "./log.ts";
import { PolicyEngine, classificationOf, type PolicyActor, type PolicyEngineOptions } from "./policy.ts";
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
  type GateRecord,
  type RunProjection,
  type TaskRecord,
} from "./projection.ts";
import {
  FunctionRegistry,
  ModelRegistry,
  ToolRegistry,
  type Message,
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
}

/**
 * Failures a join must NEVER absorb.
 *
 * `onBranchError: skip` means "this branch's *work* failed"; it does not mean "the
 * run may continue past a breached budget or an invalid replay". Without this set,
 * fixing branch-failure containment silently defeats both.
 */
const RUN_FATAL_CODES: ReadonlySet<string> = new Set([CODES.E_BUDGET_EXHAUSTED, CODES.E_REPLAY_DIVERGENCE]);

interface Wave {
  readonly task: TaskRecord;
  readonly node: NodeSpec;
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
  /** Channels an `edit` may write. Always concrete; `[]` means none. */
  readonly allowEdit: readonly string[];
}

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
  /** Serializes journal commits. Work runs in parallel; the log has one writer. */
  #commitChain: Promise<unknown> = Promise.resolve();
  #fencing = 0;

  constructor(opts: EngineOptions) {
    this.#store = opts.store;
    this.#bus = opts.bus;
    this.tools = opts.tools ?? new ToolRegistry();
    this.functions = opts.functions ?? new FunctionRegistry();
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
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#contextTokens = opts.contextTokens ?? 100_000;
    // Mutations must resolve the same refs the original compile did. Without a real
    // resolver a mutation can only add nodes that reference nothing.
    this.#resolver = opts.resolver ?? { resolve: () => undefined };
    this.#scheduler = opts.scheduler ?? new InProcessScheduler();
    this.#sequences = opts.sequences;
    this.#baseline = opts.baseline;
    this.#sweepOpts = opts.sweep ?? {};
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
  #escalate(ctx: RunContext, id: EscalationRuleId, nodeId?: NodeId, detail?: Record<string, unknown>): void {
    const rule = ESCALATION_RULES[id];
    ctx.policy.escalate(scopeOf(rule, ctx.runId, nodeId), rule.to, detail === undefined ? id : `${id} ${JSON.stringify(detail)}`);
  }

  get replaying(): boolean {
    return this.#replay !== undefined;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async submit(input: SubmitInput): Promise<RunId> {
    const runId = input.runId ?? newRunId(this.#now());
    const ctx = this.#contextFor(runId, input.graph, input.budgetUsd);

    // Durable at ACK: run.submitted + the compiled graph + the manifest. NOT any
    // execution — a 202 means "this WILL run", never "this HAS run".
    await ctx.log.append([
      {
        type: "run.submitted",
        payload: {
          workflow: input.workflow ?? input.graph.spec.metadata.name,
          graphHash: input.graph.graphHash,
          inputs: input.inputs,
          idempotencyKey: input.idempotencyKey ?? runId,
          configDigest: digest(this.#policyOpts),
        },
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
    if (ctx === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} is not attached to this engine`);
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
        ctx.policy.restore({ escalations: p.escalations, ceilings: p.ceilings, spentUsd: p.usage.costUsd });
      }
      if (isTerminal(p.status) || p.status === "awaiting_gate" || p.status === "interrupted") return p;

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
   * sets can never take a hard-to-undo action below `on` — someone stays watching.
   */
  async deescalate(
    runId: RunId,
    scope: string,
    to: Posture,
    justification: string,
    actor: PolicyActor,
  ): Promise<RunProjection> {
    const ctx = this.#require(runId);
    const before = ctx.policy.ceilingFor(scope) ?? "in";
    ctx.policy.deescalate(scope, to, justification, actor);
    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "policy.deescalated",
          payload: { from: before, to, scope, justification },
          actor: { kind: "human", subject: actor.id, via: "api" },
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
    const ctx = this.#runs.get(runId);
    if (ctx === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} is not attached to this engine`);
    return this.#gates.list(ctx.log);
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
    const ctx = this.#runs.get(runId);
    if (ctx === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} is not attached to this engine`);
    return this.#gates.listBatches(ctx.log);
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
   * Re-attach a run after a process restart.
   *
   * There is deliberately nothing to restore: the projection is a fold, open gates
   * are rows, and incomplete Tasks are re-leased because their state is `ready` or
   * `leased` in the log. This method exists only to bind the RunGraph, which is not
   * itself journaled (its hash is).
   */
  attach(runId: RunId, graph: RunGraph): void {
    this.#contextFor(runId, graph);
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
  async cancel(runId: RunId, reason = "operator"): Promise<RunProjection> {
    const ctx = this.#require(runId);
    await this.#cancelTree(runId, reason, new Set());
    return (await this.#project(ctx))!;
  }

  /**
   * One run's cancellation, then its children's, then its own terminal event.
   *
   * `seen` is a cycle guard rather than an optimisation. Child ids are derived
   * (`parent~taskId`), so a cycle cannot arise from anything this engine writes — but this
   * walks a journal, and a journal is an input.
   */
  async #cancelTree(runId: RunId, reason: string, seen: Set<RunId>): Promise<void> {
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
        { type: "operator.command", payload: { kind: "cancel", args: { reason } }, actor: SYSTEM_ACTOR("operator") },
      ]),
    );
    ctx?.abort.abort();

    for (const child of await childRunsOf(log)) {
      await this.#cancelTree(child, `the run that delegated to it was cancelled: ${reason}`, seen);
    }

    // Re-projected AFTER the children, because ending them can end this run too: a child
    // that reaches a terminal state resolves the parent's Task, and an `advance` still in
    // flight may have finished the parent while the cascade ran.
    const p = await this.projection(runId);
    if (p !== undefined && isTerminal(p.status)) return;

    await this.#serialize(() =>
      log.append([
        // THE GATES GO WITH IT. `ctx.abort` reaches every in-flight effect and reaches no
        // gate at all — an open gate has no work to interrupt; it is a row and a queue
        // entry — so cancelling the run used to stop the executor and leave the question
        // standing. Answering it afterwards resurrected the run and drove the action the
        // cancel existed to prevent. D6.4 rule 4 says it plainly: gates are cancelled by
        // command, not by signal.
        ...(p === undefined ? [] : cancelOpenGates(p, `the run was cancelled: ${reason}`, SYSTEM_ACTOR("operator"))),
        {
          type: "run.cancelled",
          payload: {
            clean: (p?.unknownEffects ?? []).length === 0,
            unknownEffects: p?.unknownEffects ?? [],
            forced: false,
          },
          actor: SYSTEM_ACTOR("operator"),
        },
      ]),
    );
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
   */
  async rewind(runId: RunId, atSeq: Seq, reason: string): Promise<RunProjection> {
    const ctx = this.#require(runId);

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

    const p = (await this.#project(ctx))!;

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
    for await (const ev of ctx.log.read((atSeq + 1) as Seq)) {
      if (ev.type !== "tool.called") continue;
      const called = ev.payload;
      if (called.irreversibility !== "irreversible" && called.irreversibility !== "externally_visible") continue;
      // Fail closed: a tool the registry no longer carries cannot be shown to compensate.
      if (this.tools.get(called.name)?.compensation === undefined) {
        throw err.conflict(
          CODES.E_RESTORE_ILLEGAL,
          `cannot rewind to ${atSeq}: "${called.name}" ran at seq ${ev.seq}, is ${called.irreversibility}, and declares no compensation`,
          { details: { runId, atSeq, seq: ev.seq, tool: called.name } },
        );
      }
    }

    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "checkpoint.restored",
          payload: { checkpointId: `cp_${atSeq}` as never, mode: "rewind", atSeq, reason },
          actor: SYSTEM_ACTOR("operator"),
        },
      ]),
    );
    return (await this.#project(ctx))!;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #require(runId: RunId): RunContext {
    const ctx = this.#runs.get(runId);
    if (ctx === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} is not attached`);
    return ctx;
  }

  #contextFor(runId: RunId, graph: RunGraph, budgetUsd?: number): RunContext {
    const existing = this.#runs.get(runId);
    if (existing !== undefined) return existing;
    const ctx: RunContext = {
      runId,
      graph,
      index: indexGraph(graph.spec),
      log: new RunLog(runId, {
        store: this.#store,
        now: this.#now,
        ...(this.#bus === undefined ? {} : { bus: this.#bus }),
      }),
      policy: new PolicyEngine({
        ...this.#policyOpts,
        ...(budgetUsd === undefined ? {} : { budget: { ...this.#policyOpts.budget, runUsd: budgetUsd } }),
        onEscalate: (rule, from, to, scope) => {
          ctx.escalationWrites.push(
            this.#serialize(() =>
              ctx.log.append([
                { type: "policy.escalated", payload: { rule, from, to, scope }, actor: SYSTEM_ACTOR("policy") },
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
      resolver: this.#resolver,
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
                payload: { workerId: this.#workerId, attempt: w.task.attempt + 1, fencingToken: ++this.#fencing },
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

  async #executeTask(ctx: RunContext, w: Wave): Promise<NodeOutcome> {
    const p = (await this.#project(ctx))!;
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
      return this.#dispatch(ctx, p, w);
    }

    const decision = ctx.policy.decide({
      runId: ctx.runId,
      nodeId: node.id,
      taskId: task.taskId,
      kind: node.tool === undefined ? "node" : "tool",
      irreversibility: this.#irreversibilityOf(node),
      capabilities: this.#capabilitiesOf(node),
      declaredPosture: ctx.graph.plans[node.id]?.posture ?? "out",
      dataClassification: [classificationOf(spec.channels, [...(node.reads ?? []), ...(node.writes ?? [])])],
      // E8. A channel a tool wrote carries output from outside the system. Feeding that
      // into a hard-to-undo action is the prompt-injection path, and the policy layer
      // already knows what to do with the bit — it was just never being told.
      tainted: (node.reads ?? []).some((r) => ctx.tainted.has(r)),
    });

    await this.#serialize(() =>
      ctx.log.append(
        [
          {
            type: "policy.decided",
            payload: {
              effect: decision.effect,
              posture: decision.effect === "deny" ? "in" : decision.posture,
              irreversibility: this.#irreversibilityOf(node),
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
                irreversibility: this.#irreversibilityOf(node),
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
      return {
        status: "gate",
        writes: {},
        usage: { ...ZERO_USAGE },
        gate: {
          policyRef: node.humanGate?.ref ?? `policy:${node.id}`,
          payload: this.#gatePayload(ctx, p, node, task),
          auth: gateAuthorizationOf(node),
          schedule: scheduleOf(node),
        },
      };
    }

    return this.#dispatch(ctx, p, w);
  }

  /** Run the node body. Reached once policy has allowed it — or a human has. */
  #dispatch(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> | NodeOutcome {
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
      case "human_gate":
        // Reached only when policy did not already gate — i.e. never, since a
        // human_gate node's posture is `in` by definition. Kept explicit so a
        // future posture change cannot silently skip the gate.
        return {
          status: "gate",
          writes: {},
          usage: { ...ZERO_USAGE },
          gate: {
            policyRef: w.node.humanGate?.ref ?? "",
            payload: this.#gatePayload(ctx, p, w.node, w.task),
            auth: gateAuthorizationOf(w.node),
            schedule: scheduleOf(w.node),
          },
        };
      case "subgraph":
        return this.#runSubgraph(ctx, p, w);
    }
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

  async #runFunction(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const body = this.functions.require(w.node.function!.ref);
    const view = viewFor(p, ctx.graph.spec.channels, w.task.branch, w.node.reads ?? []);
    const out = await body(view, {
      taskId: w.task.taskId,
      signal: ctx.abort.signal,
      now: this.#now,
    });
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
    const result = await this.#invokeTool(ctx, w.task, tool, args, 0, true);
    if (result.isError === true) {
      return {
        status: "failed",
        writes: {},
        usage: { ...ZERO_USAGE },
        error: err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, result.content),
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
      const body = this.functions.require(ev.ref);
      const view = viewFor(p, ctx.graph.spec.channels, w.task.branch, w.node.reads ?? []);
      const out = await body(view, { taskId: w.task.taskId, signal: ctx.abort.signal, now: this.#now });
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
    const assembled = await assembleContext(
      {
        system: `You are node ${w.node.id}.`,
        instruction: promptOverride ?? agent?.prompt ?? "",
        channels: Object.fromEntries(view.visible.map((c) => [c, view.get(c)])),
        channelSpecs: ctx.graph.spec.channels,
      },
      {
        maxTokens: this.#contextTokens,
        dropBelowPriority: 35,
        // The summarizer is an EFFECT, so replay serves the same summary and rung 3
        // stays deterministic.
        summarize: (text) => this.#summarizeEffect(ctx, w, text),
      },
    );

    let messages: Message[] = [
      {
        role: "user",
        content: JSON.stringify({
          node: w.node.id,
          prompt: promptOverride ?? agent?.prompt ?? "",
          state: assembled.channels,
        }),
      },
    ];

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
      const bounded = await boundTurns(messages, this.#contextTokens, (text) =>
        this.#summarizeEffect(ctx, w, text, turn),
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
        system: `You are node ${w.node.id}.`,
        messages,
        tools: toolSpecs,
      };

      let recordedProvider = "replay";
      let reservation;
      try {
        // A replay makes no call, so it reserves nothing. Estimating against a provider
        // that is not there would be inventing a cost for work that never happens.
        reservation = ctx.policy.reserve(`node:${w.node.id}`, adapter?.estimateOf(req) ?? 0);
        // Checked at RESERVE as well as at commit. Under reserve-worst-case, committed
        // exposure peaks at the reservation and falls back when `settle` credits the
        // real cost — so a check only at commit sees the trough and never fires. "80%
        // consumed" means 80% committed, which is the number that could still be spent.
        this.#checkBudgetWarning(ctx);
      } catch (e) {
        const le = toLoomError(e);
        if (le.code !== CODES.E_BUDGET_EXHAUSTED) throw le;
        // E3. `gate` means the graph asked for a human rather than a failure when the
        // money runs out — the difference between "stop, this is expensive" and "stop".
        const action = ctx.graph.spec.policy?.onBudgetExhausted ?? "fail";
        if (action === "gate") this.#escalate(ctx, "budget_exhausted", w.node.id);
        // Run-level, not branch-level: journal it so a join cannot absorb it and so
        // it survives a restart.
        await this.#serialize(() =>
          ctx.log.append(
            [
              {
                type: "budget.exhausted",
                payload: { scope: `run:${ctx.runId}`, limitUsd: ctx.policy.spentUsd + ctx.policy.remainingUsd, action },
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
      let turnUsage: UsageRecord = { ...ZERO_USAGE };
      let assistant: Message | undefined;
      let finish = "stop";

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

      try {
        if (this.#replay !== undefined) {
          // Served, not called. `adapter.stream` is never reached, so replay makes
          // no network request and costs nothing.
          const rec = this.#replay.require(key) as { result: RecordedModelTurn & { provider?: string } };
          recordedProvider = rec.result.provider ?? recordedProvider;
          assistant = { role: "assistant", content: rec.result.content, ...(rec.result.toolCalls === undefined ? {} : { toolCalls: rec.result.toolCalls }) };
          finish = rec.result.finishReason;
          turnUsage = rec.result.usage;
        } else {
          for await (const ev of adapter!.stream(req, ctx.abort.signal)) {
            if (ev.type === "done") {
              assistant = ev.message;
              finish = ev.finishReason;
              turnUsage = ev.usage;
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

      ctx.policy.settle(reservation, turnUsage.costUsd);
      usage = addUsage(usage, turnUsage);

      await this.#serialize(() =>
        ctx.log.append(
          [
            // `*.called` BEFORE `effect.completed`: the span fold closes the effect
            // span on `completed`, so attributes attached afterwards would be dropped.
            {
              type: "model.called",
              payload: {
                key,
                provider: adapter?.provider ?? recordedProvider,
                model: req.model,
                finishReason: finish,
                usage: turnUsage,
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
        const result = await this.#runAgentToolCall(ctx, w, call, allowed, nodeApproved, callsSoFar + i);
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

    const childSpec = this.#resolver.subgraph?.(sub.ref);
    if (childSpec === undefined) {
      throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `subgraph "${sub.ref}" does not resolve to a GraphSpec`);
    }
    const childGraph = this.#compileChild(sub.ref, childSpec);

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
      await this.submit({
        graph: childGraph,
        inputs,
        runId: childRunId,
        workflow: sub.ref,
        ...(slice === undefined ? {} : { budgetUsd: slice }),
      });
    } else {
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

    const writes: Record<string, unknown> = {};
    for (const [parentCh, childCh] of Object.entries(sub.outputs)) writes[parentCh] = childP.channels[childCh];

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
    ctx.policy.settle(ctx.policy.reserve(`subgraph:${w.node.id}`, 0), childP.usage.costUsd);

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
    await this.cancel(childRunId, reason);
  }

  /** Compile a child graph once per ref. The tree is fixed, so the cache never stales. */
  #compileChild(ref: string, spec: GraphSpec): RunGraph {
    const hit = this.#childGraphs.get(ref);
    if (hit !== undefined) return hit;
    const compiled = compileOrThrow({
      spec,
      resolver: this.#resolver,
      tools: this.tools.manifests(),
      tenantCapabilities: this.#policyOpts.granted,
    });
    this.#childGraphs.set(ref, compiled);
    return compiled;
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
  async #summarizeEffect(ctx: RunContext, w: Wave, text: string, ordinal = 0): Promise<string> {
    const key = effectKey(w.task.taskId, "summarize", ordinal);
    if (this.#replay !== undefined) return String(this.#replay.require(key).result);

    const adapter = this.models.require();
    let summary = "";
    for await (const ev of adapter.stream(
      {
        model: "compaction",
        system: "Summarize the following prior turns in under 200 words. Preserve decisions and identifiers.",
        messages: [{ role: "user", content: text }],
        tools: [],
      },
      ctx.abort.signal,
    )) {
      if (ev.type === "done") summary = ev.message.content;
    }

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
    w: Wave,
    call: ModelToolCall,
    allowed: ReadonlySet<string>,
    nodeApproved: boolean,
    ordinal: number,
  ): Promise<ToolResult> {
    if (!allowed.has(call.name)) {
      // The injection-containment path: the model asked for something the node never
      // declared, so it is refused before dispatch rather than policed inside the tool.
      return { content: `tool "${call.name}" is not available to node "${w.node.id}"`, isError: true };
    }
    const tool = this.tools.get(call.name);
    if (tool === undefined) return { content: `unknown tool "${call.name}"`, isError: true };
    return this.#invokeTool(ctx, w.task, tool, call.arguments, ordinal, nodeApproved);
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
    task: TaskRecord,
    tool: ToolDefinition,
    rawArgs: unknown,
    ordinal: number,
    /** True when `#executeTask` already ran the full chain for this node and a human, if
     *  asked, said yes. Only a `tool` node can claim it; an agent's tool choice was never
     *  seen by that chain. */
    nodeApproved = false,
  ): Promise<ToolResult> {
    const key = effectKey(task.taskId, "tool", ordinal);

    // 1 — validate
    const first = validate(tool.parameters, rawArgs);
    if (!first.ok) return { content: `invalid arguments for ${tool.name}:\n- ${first.errors.join("\n- ")}`, isError: true };

    // 2 — policy
    const decision = ctx.policy.decide({
      runId: ctx.runId,
      nodeId: task.nodeId,
      taskId: task.taskId,
      kind: "tool",
      irreversibility: tool.irreversibility,
      capabilities: tool.capabilities,
      declaredPosture: ctx.graph.plans[task.nodeId]?.posture ?? "out",
    });
    if (decision.effect === "deny") return { content: decision.error.message, isError: true };

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
    const final = validate(tool.parameters, first.value);
    if (!final.ok) return { content: `invalid arguments after guards:\n- ${final.errors.join("\n- ")}`, isError: true };

    const started = this.#now();
    // Ordered, and recorded before the call: E5 asks what this node TRIED, and a
    // sequence that ends in a failure is exactly the novel one worth noticing.
    const calls = ctx.toolCalls.get(task.taskId) ?? [];
    calls.push(tool.name);
    ctx.toolCalls.set(task.taskId, calls);

    await this.#serialize(() =>
      ctx.log.append(
        [{ type: "effect.started", payload: { key, kind: "tool", attempt: 1 }, actor: SYSTEM_ACTOR("tool-executor"), taskId: task.taskId }],
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
      await this.#gates.raise(ctx.log, {
        runId: ctx.runId,
        taskId: w.task.taskId,
        nodeId: w.node.id,
        policyRef: outcome.gate!.policyRef,
        payload: outcome.gate!.payload,
        allowEdit: auth.allowEdit,
        ...(auth.approvers.length === 0 ? {} : { approvers: auth.approvers }),
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

    // A retryable failure with attempts left is rescheduled instead of committed.
    // The slot is released during the backoff, so a retry storm costs queue depth
    // rather than concurrency (D6.3 level 3).
    if (outcome.status === "failed") {
      const retry = this.#retryDecision(ctx, p, w, outcome);
      if (retry !== undefined) {
        await ctx.log.commit(
          p.seq,
          [
            {
              type: "task.retry_scheduled",
              payload: { attempt: w.task.attempt + 1, afterMs: retry.afterMs, code: retry.code },
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
          { taskId: w.task.taskId },
        );
        return;
      }
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
          { taskId: w.task.taskId },
        ));
      }
      mutationEvents.push(...applied.events);
    }

    const events: NewEvent[] = [...mutationEvents];
    const take = outcome.status === "failed" ? this.#errorEdges(ctx, w) : this.#edgesToTake(ctx, p, w, outcome);

    if (outcome.status === "failed") {
      events.push({
        type: "task.failed",
        payload: { error: errorRecord(outcome.error ?? err.internal(CODES.E_INTERNAL, "unknown")), attempt: w.task.attempt + 1 },
        actor: SYSTEM_ACTOR("executor"),
        taskId: w.task.taskId,
      });
    }

    events.push({
      type: "task.committed",
      payload: {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        writes: outcome.writes,
        take,
        usage: outcome.usage,
        attempt: w.task.attempt + 1,
      },
      actor: SYSTEM_ACTOR("executor"),
      taskId: w.task.taskId,
    });

    // A join emits its fold; a root-branch Task reduces its own writes immediately;
    // a Task inside a fan-out holds them until its join.
    const reduce = outcome.reduced ?? this.#immediateReduce(ctx, p, w, outcome);
    if (reduce !== undefined) {
      const before = stateHash(p.channels);
      const after = stateHash({ ...p.channels, ...reduce.values });
      events.push({
        type: "state.reduced",
        payload: {
          channels: reduce.channels,
          values: reduce.values,
          branchCount: reduce.branchCount,
          skipped: reduce.skipped,
          degraded: reduce.skipped > 0,
          stateHashBefore: before,
          stateHashAfter: after,
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
    const token = ctx.leases.get(w.task.taskId);
    await ctx.log.commit(p.seq, events, {
      taskId: w.task.taskId,
      ...(token === undefined ? {} : { fencingToken: token }),
    });
    ctx.leases.delete(w.task.taskId);
  }

  /**
   * Whether to retry, and after how long.
   *
   * Three independent refusals, each for a different reason:
   *   - a NON-RETRYABLE class (validation, policy) will fail identically next time;
   *   - a RUN-FATAL code is not about this Task at all;
   *   - a NON-IDEMPOTENT tool that already reached its sandbox may have done its
   *     work. Retrying is the dangerous option, so the answer is no, and the run
   *     takes its error edge or surfaces the gap.
   */
  #retryDecision(
    ctx: RunContext,
    p: RunProjection,
    w: Wave,
    outcome: NodeOutcome,
  ): { afterMs: number; code: string } | undefined {
    const policy = w.node.retry;
    const error = outcome.error;
    if (policy === undefined || error === undefined) return undefined;

    const attempt = w.task.attempt + 1;
    if (attempt >= policy.maxAttempts) return undefined;
    if (!error.retryable) return undefined;
    if (RUN_FATAL_CODES.has(error.code)) return undefined;
    if (policy.onlyIf !== undefined && !policy.onlyIf.includes(error.code)) return undefined;

    // A TOOL EFFECT, not any effect. The reachable set is the right question for a
    // POSTURE — what a node might do decides how closely it is watched — and it is fine
    // here too, PROVIDED the second half of the conjunction asks about a tool. It did
    // not: `#effectStarted` matches any key prefixed by the taskId, `:model:` included,
    // so an agent lost its retry policy the moment its first MODEL call started and a
    // transport blip on turn one read as a non-idempotent tool that might have rung the
    // bell.
    const nonIdempotentReachable = reachableToolNames(w.node).some((name) => {
      const t = this.tools.get(name);
      return t !== undefined && !t.idempotent;
    });
    //
    // The signal has to stay DURABLE — `startedEffects` is folded from the journal, so it
    // survives a restart, where an in-memory list of calls does not. What was wrong was
    // its precision, not its source: `${taskId}:` matches `:model:` too.
    //
    // Only refuse once the call REACHED the sandbox. A failure before that (schema
    // validation, a policy deny) touched nothing, so retrying it is safe even for a
    // non-idempotent tool.
    if (nonIdempotentReachable && this.#toolEffectStarted(p, w.task.taskId)) return undefined;

    const initial = policy.initialMs ?? 500;
    const max = policy.maxMs ?? 30_000;
    const raw = policy.backoff === "fixed" ? initial : initial * 2 ** (attempt - 1);
    // No jitter here: the delay must be a pure function of (policy, attempt) or
    // replay diverges. Real jitter belongs in the distributed scheduler, where the
    // delay is not part of the recorded decision.
    return { afterMs: Math.min(raw, max), code: error.code };
  }

  /**
   * True when this Task already started a TOOL effect.
   *
   * The narrower question, and the one the non-idempotent retry refusal wants: a model
   * call that started and failed touched nothing outside Loom, so it says nothing about
   * whether a tool may have. The broader `${taskId}:` form this replaced matched
   * `:model:` too, which cost an agent its retry policy on a transport blip.
   */
  #toolEffectStarted(p: RunProjection, taskId: TaskId): boolean {
    return p.startedEffects.some((k) => k.startsWith(`${taskId}:tool:`));
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
      resolver: this.#resolver,
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

    // E8's evidence: a channel a TOOL wrote holds output from outside the system.
    if (w.node.type === "tool" || (w.node.type === "agent" && (w.node.agent?.tools ?? []).length > 0)) {
      for (const channel of Object.keys(outcome.writes)) ctx.tainted.add(channel);
    }

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
      remainingUsd: Number(ctx.policy.remainingUsd.toFixed(6)),
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
    if (w.task.branch.segments.length > 0) return undefined;

    const wave: Record<string, readonly Contribution[]> = {};
    for (const [channel, value] of Object.entries(outcome.writes)) {
      wave[channel] = [{ branch: w.task.branch, nodeId: w.node.id, iteration: w.task.iteration, value }];
    }
    const reduced = reduceState(ctx.graph.spec.channels, p.channels, wave);
    return { values: pick(reduced.state, reduced.channels), channels: reduced.channels, branchCount: 1, skipped: 0 };
  }

  #edgesToTake(ctx: RunContext, p: RunProjection, w: Wave, outcome: NodeOutcome): readonly EdgeId[] {
    if (outcome.take !== undefined) return outcome.take;

    const scope = { ...scopeFor(p, ctx.graph.spec.channels, w.task.branch), ...outcome.writes };
    const out: EdgeId[] = [];

    for (const e of ctx.index.outbound.get(w.node.id) ?? []) {
      switch (e.kind) {
        case "error":
        case "compensation":
          break;
        case "loop": {
          const done = e.until !== undefined && evaluate(this.#expr(ctx, e.until), scope) === true;
          const exhausted = w.task.iteration + 1 >= (e.maxIterations ?? 1);
          if (!done && !exhausted) out.push(e.id);
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

  #errorEdges(ctx: RunContext, w: Wave): readonly EdgeId[] {
    return (ctx.index.outbound.get(w.node.id) ?? []).filter((e) => e.kind === "error").map((e) => e.id);
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
        await this.#serialize(() =>
          ctx.log.append([
            ...cancelOpenGates(p, "the run failed before this gate was answered", SYSTEM_ACTOR("executor")),
            {
              type: "run.failed",
              payload: {
                error: {
                  class: "internal",
                  code: CODES.E_INTERNAL,
                  message: `fan-out "${key}" planned ${plan.width} branches but only ${started} were materialised`,
                  retryable: false,
                },
              },
              actor: SYSTEM_ACTOR("executor"),
            },
          ]),
        );
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
      await this.#serialize(() =>
        ctx.log.append([
          ...cancelOpenGates(p, "the run failed before this gate was answered", SYSTEM_ACTOR("executor")),
          {
            type: "run.failed",
            payload: {
              error: first.error ?? {
                class: "internal",
                code: CODES.E_INTERNAL,
                message: `task ${first.taskId} failed with no error edge`,
                retryable: false,
              },
            },
            actor: SYSTEM_ACTOR("executor"),
          },
        ]),
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
      await this.#serialize(() =>
        ctx.log.append([
          ...cancelOpenGates(p, "the run failed before this gate was answered", SYSTEM_ACTOR("executor")),
          {
            type: "run.failed",
            payload: {
              error: {
                class: "internal",
                code: CODES.E_OUTPUT_MISSING,
                message: `run finished without writing any of its declared outputs (${declared.join(", ")})`,
                retryable: false,
              },
            },
            actor: SYSTEM_ACTOR("executor"),
          },
        ]),
      );
      return;
    }

    await this.#serialize(() =>
      ctx.log.append([
        ...cancelOpenGates(p, "the run completed before this gate was answered", SYSTEM_ACTOR("executor")),
        {
          type: "run.completed",
          payload: { outputs, usage: p.usage },
          actor: SYSTEM_ACTOR("executor"),
        },
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

  #gatePayload(ctx: RunContext, p: RunProjection, node: NodeSpec, task: TaskRecord): unknown {
    const view = viewFor(p, ctx.graph.spec.channels, task.branch, node.reads ?? []);
    return {
      node: node.id,
      task: task.taskId,
      posture: ctx.graph.plans[node.id]?.posture ?? "out",
      irreversibility: this.#irreversibilityOf(node),
      state: Object.fromEntries(view.visible.map((c) => [c, view.get(c)])),
      costSoFarUsd: p.usage.costUsd,
    };
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

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
function resolveArgs(args: Readonly<Record<string, unknown>>, scope: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sub = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\$\{([^}]+)\}$/.exec(v);
      // A lone `${x}` yields the VALUE (so an object stays an object); an embedded
      // one interpolates as text.
      if (whole) return lookup(scope, whole[1]!.trim());
      return v.replace(/\$\{([^}]+)\}/g, (m, path: string) => {
        const found = lookup(scope, path.trim());
        return found === undefined ? m : typeof found === "string" ? found : JSON.stringify(found);
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
function cancelOpenGates(p: RunProjection, reason: string, actor: Actor): readonly NewEvent[] {
  return openGates(p).map((g): NewEvent => ({
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
function gateAuthorizationOf(node: NodeSpec): GateAuthorization {
  return {
    approvers: node.humanGate?.approval?.approvers ?? [],
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
  return { approvers: childGate.approvers ?? [], allowEdit: [] };
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
