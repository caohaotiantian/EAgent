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

import { digest } from "../canonical.ts";
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
  type NodeId,
  type RunId,
  type Seq,
  type TaskId,
} from "../ids.ts";
import { SYSTEM_ACTOR, errorRecord, type Actor, type NewEvent } from "../journal/events.ts";
import type { StateStore } from "../journal/store.ts";
import type { EventBus } from "../bus.ts";
import { evaluate, parseExpr, type Expr } from "../graph/expr.ts";
import type { EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../graph/spec.ts";
import { indexGraph, type GraphIndex } from "../graph/validate.ts";
import { validate, type JSONSchema } from "../schema.ts";
import {
  reduceState,
  stateHash,
  type ChannelSpec,
  type Contribution,
} from "../state/channels.ts";
import { ZERO_USAGE, addUsage, maxPosture, type Posture, type UsageRecord } from "../vocab.ts";
import { HumanGateBroker, type GateDecision, type ResolveInput } from "./gates.ts";
import { RunLog } from "./log.ts";
import { PolicyEngine, classificationOf, type PolicyEngineOptions } from "./policy.ts";
// Type-only: `replay.ts` constructs an Engine at runtime, so a value import here
// would be a real module cycle.
import type { ReplayEffects } from "./replay.ts";
import {
  branchChain,
  collectOutputs,
  foldRun,
  isTerminal,
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

interface NodeOutcome {
  readonly status: "succeeded" | "failed" | "gate";
  readonly writes: Record<string, unknown>;
  readonly take?: readonly EdgeId[];
  readonly usage: UsageRecord;
  readonly error?: LoomError;
  readonly gate?: { readonly payload: unknown; readonly policyRef: string };
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
  readonly graph: RunGraph;
  readonly index: GraphIndex;
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
  readonly gates: HumanGateBroker;
  readonly #now: () => number;
  readonly #workerId: string;
  readonly #maxParallelism: number;
  readonly #policyOpts: Omit<PolicyEngineOptions, "onEscalate">;
  readonly #replay: ReplayEffects | undefined;

  readonly #runs = new Map<RunId, RunContext>();
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
    this.gates = opts.gates ?? new HumanGateBroker({ now: this.#now });
    this.#workerId = opts.workerId ?? "worker-0";
    this.#maxParallelism = Math.max(1, opts.maxParallelism ?? 16);
    this.#policyOpts = opts.policy ?? { granted: ["*"] };
    this.#replay = opts.replay;
  }

  get replaying(): boolean {
    return this.#replay !== undefined;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async submit(input: SubmitInput): Promise<RunId> {
    const runId = newRunId(this.#now());
    const ctx = this.#contextFor(runId, input.graph);

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
  async advance(runId: RunId): Promise<RunProjection> {
    const ctx = this.#runs.get(runId);
    if (ctx === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} is not attached to this engine`);

    for (;;) {
      const p = await this.#project(ctx);
      if (p === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} has no journal`);
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
        await this.#finish(ctx, p);
        const done = await this.#project(ctx);
        return done!;
      }

      // Within-run ordering: longest remaining path first, so the run's makespan
      // shrinks without extra concurrency. Ties break on branch coordinate, which
      // keeps execution order deterministic for replay.
      const wave = ready
        .map((task): Wave | undefined => {
          const node = ctx.index.byId.get(task.nodeId);
          return node === undefined ? undefined : { task, node };
        })
        .filter((w): w is Wave => w !== undefined)
        .sort((a, b) => {
          const ca = ctx.graph.plans[a.task.nodeId]?.criticalPathLength ?? 0;
          const cb = ctx.graph.plans[b.task.nodeId]?.criticalPathLength ?? 0;
          return cb - ca || compareBranch(a.task.branch, b.task.branch);
        })
        .slice(0, this.#maxParallelism);

      await this.#runWave(ctx, wave);
    }
  }

  async resolveGate(runId: RunId, input: ResolveInput): Promise<RunProjection> {
    const ctx = this.#require(runId);
    await this.gates.resolve(ctx.log, input);
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
   * Cancel a run.
   *
   * Reports `clean: false` and lists `unknownEffects` when cancellation raced an
   * effect that started and never recorded an outcome. A framework that reports every
   * cancel as clean is lying to its operator.
   */
  async cancel(runId: RunId, reason = "operator"): Promise<RunProjection> {
    const ctx = this.#require(runId);
    // Journal the command BEFORE dispatching it, so a crash here re-drives the cancel
    // on restart rather than losing it.
    await this.#serialize(() =>
      ctx.log.append([
        { type: "operator.command", payload: { kind: "cancel", args: { reason } }, actor: SYSTEM_ACTOR("operator") },
      ]),
    );
    ctx.abort.abort();

    const p = (await this.#project(ctx))!;
    if (isTerminal(p.status)) return p;

    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "run.cancelled",
          payload: { clean: p.unknownEffects.length === 0, unknownEffects: p.unknownEffects, forced: false },
          actor: SYSTEM_ACTOR("operator"),
        },
      ]),
    );
    return (await this.#project(ctx))!;
  }

  /**
   * Rewind to a checkpoint by APPENDING a restore marker.
   *
   * The original journal is never edited; the fold hides `(atSeq, marker)` instead.
   * So a rewind is itself auditable, and a trace still shows what was undone.
   */
  async rewind(runId: RunId, atSeq: Seq, reason: string): Promise<RunProjection> {
    const ctx = this.#require(runId);
    const p = (await this.#project(ctx))!;

    // Refuse to rewind past a committed irreversible effect with no compensation —
    // the store must not offer a silently-unsafe undo.
    for (const t of Object.values(p.tasks)) {
      const node = ctx.index.byId.get(t.nodeId);
      const tool = node?.tool === undefined ? undefined : this.tools.get(node.tool.name);
      if (tool === undefined || t.state !== "succeeded") continue;
      const irreversible = tool.irreversibility === "irreversible" || tool.irreversibility === "externally_visible";
      if (irreversible && tool.compensation === undefined) {
        throw err.conflict(
          CODES.E_RESTORE_ILLEGAL,
          `cannot rewind past "${t.nodeId}": ${tool.name} is ${tool.irreversibility} and declares no compensation`,
          { details: { taskId: t.taskId, tool: tool.name } },
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

  #contextFor(runId: RunId, graph: RunGraph): RunContext {
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
        onEscalate: (rule, from, to, scope) => {
          void ctx.log.append([
            { type: "policy.escalated", payload: { rule, from, to, scope }, actor: SYSTEM_ACTOR("policy") },
          ]);
        },
      }),
      abort: new AbortController(),
      exprCache: new Map(),
    };
    this.#runs.set(runId, ctx);
    return ctx;
  }

  #runPosture(graph: RunGraph): Posture {
    return maxPosture(
      this.#policyOpts.systemFloor ?? "out",
      graph.spec.policy?.posture ?? "out",
      ...Object.values(graph.plans).map((p) => p.posture),
    );
  }

  async #project(ctx: RunContext): Promise<RunProjection | undefined> {
    const events = [];
    for await (const e of ctx.log.read(1)) events.push(e);
    return foldRun(events);
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
        await this.#serialize(() =>
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
    const settled = Object.values(p.gates).find((g) => g.taskId === task.taskId && g.state === "decided");
    if (settled !== undefined) return this.#applyGateDecision(settled, node);

    const decision = ctx.policy.decide({
      runId: ctx.runId,
      nodeId: node.id,
      taskId: task.taskId,
      kind: node.tool === undefined ? "node" : "tool",
      irreversibility: this.#irreversibilityOf(node),
      capabilities: this.#capabilitiesOf(node),
      declaredPosture: ctx.graph.plans[node.id]?.posture ?? "out",
      dataClassification: [classificationOf(spec.channels, [...(node.reads ?? []), ...(node.writes ?? [])])],
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
      return { status: "failed", writes: {}, usage: { ...ZERO_USAGE }, error: decision.error };
    }
    if (decision.effect === "gate") {
      return {
        status: "gate",
        writes: {},
        usage: { ...ZERO_USAGE },
        gate: {
          policyRef: node.humanGate?.ref ?? `policy:${node.id}`,
          payload: this.#gatePayload(ctx, p, node, task),
        },
      };
    }

    switch (node.type) {
      case "function":
        return this.#runFunction(ctx, p, w);
      case "router":
        return this.#runRouter(ctx, p, w);
      case "join":
        return this.#runJoin(ctx, p, w);
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
          gate: { policyRef: node.humanGate?.ref ?? "", payload: this.#gatePayload(ctx, p, node, w.task) },
        };
      case "subgraph":
        throw err.internal(CODES.E_INTERNAL, "subgraph nodes are not implemented in v1");
    }
  }

  /** Turn a resolved gate into the Task's outcome. */
  #applyGateDecision(gate: GateRecord, node: NodeSpec): NodeOutcome {
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
    return {
      status: "succeeded",
      writes: { ...(gate.writes ?? {}) },
      usage: { ...ZERO_USAGE },
      // A `redirect` must be a subset of the node's DECLARED outgoing edges — a human
      // cannot invent a target any more than a model can.
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
  async #runJoin(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const join = w.node.join!;
    const prefix = encodeBranch(w.task.branch);
    const byChannel = new Map<string, Contribution[]>();
    let branchCount = 0;
    let skipped = 0;

    const members = Object.values(p.tasks)
      .filter((t) => isDescendantBranch(prefix, encodeBranch(t.branch)))
      .sort((a, b) => compareBranch(a.branch, b.branch));

    for (const t of members) {
      if (t.state === "succeeded") {
        branchCount++;
        for (const [channel, value] of Object.entries(t.writes)) {
          const list = byChannel.get(channel) ?? [];
          list.push({ branch: t.branch, value });
          byChannel.set(channel, list);
        }
      } else if (t.state === "failed" || t.state === "skipped" || t.state === "cancelled") {
        skipped++;
      }
    }

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

    const result = await this.#invokeTool(ctx, w.task, tool, args, 0);
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
      writes: this.#assignWrites(ctx, w.node, result.writes ?? { [firstWrite(w.node) ?? "_"]: result.content }, ZERO_USAGE),
      usage: { ...ZERO_USAGE },
    };
  }

  async #runEvaluator(ctx: RunContext, p: RunProjection, w: Wave): Promise<NodeOutcome> {
    const ev = w.node.evaluator!;
    if (ev.kind === "assertion") {
      const body = this.functions.require(ev.ref);
      const view = viewFor(p, ctx.graph.spec.channels, w.task.branch, w.node.reads ?? []);
      const out = await body(view, { taskId: w.task.taskId, signal: ctx.abort.signal, now: this.#now });
      return { status: "succeeded", writes: { ...(out.writes ?? {}) }, usage: { ...ZERO_USAGE } };
    }
    // A rubric evaluator is one model call that must return a typed Verdict. Its
    // output is the primary NON-HUMAN signal the evolution loop scores on, so the
    // shape is enforced rather than parsed leniently.
    return this.#runAgent(ctx, p, w, VERDICT_SCHEMA, ev.ref);
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
    const adapter = this.models.require();
    const view = viewFor(p, ctx.graph.spec.channels, w.task.branch, w.node.reads ?? []);

    const allowed = new Set(agent?.tools ?? []);
    // Structural containment (D6.8 §2): the tool set is computed from the NODE SPEC
    // before the turn. Nothing in the model's context can widen it, so an injection
    // can make the model *ask* for a tool it was never given and be refused before
    // dispatch.
    const toolSpecs = this.tools
      .list()
      .filter((t) => allowed.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    const messages: Message[] = [
      {
        role: "user",
        content: JSON.stringify({
          node: w.node.id,
          prompt: promptOverride ?? agent?.prompt ?? "",
          state: Object.fromEntries(view.visible.map((c) => [c, view.get(c)])),
        }),
      },
    ];

    let usage: UsageRecord = { ...ZERO_USAGE };
    let finalText = "";

    for (let turn = 0; turn < maxTurns; turn++) {
      const req: ModelRequest = {
        model: agent?.profile ?? "mock",
        system: `You are node ${w.node.id}.`,
        messages,
        tools: toolSpecs,
      };

      let reservation;
      try {
        reservation = ctx.policy.reserve(`node:${w.node.id}`, adapter.estimateOf(req));
      } catch (e) {
        const le = toLoomError(e);
        if (le.code !== CODES.E_BUDGET_EXHAUSTED) throw le;
        // Run-level, not branch-level: journal it so a join cannot absorb it and so
        // it survives a restart.
        await this.#serialize(() =>
          ctx.log.append(
            [
              {
                type: "budget.exhausted",
                payload: { scope: `run:${ctx.runId}`, limitUsd: ctx.policy.spentUsd + ctx.policy.remainingUsd, action: "fail" },
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
          const rec = this.#replay.require(key) as { result: RecordedModelTurn };
          assistant = { role: "assistant", content: rec.result.content, ...(rec.result.toolCalls === undefined ? {} : { toolCalls: rec.result.toolCalls }) };
          finish = rec.result.finishReason;
          turnUsage = rec.result.usage;
        } else {
          for await (const ev of adapter.stream(req, ctx.abort.signal)) {
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
                provider: adapter.provider,
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
      for (const call of calls) {
        const result = await this.#runAgentToolCall(ctx, w, call, allowed);
        messages.push({ role: "tool", content: result.content, toolCallId: call.id });
      }
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

    return { status: "succeeded", writes: this.#assignWrites(ctx, w.node, undefined, usage, value.value), usage };
  }

  async #runAgentToolCall(
    ctx: RunContext,
    w: Wave,
    call: ModelToolCall,
    allowed: ReadonlySet<string>,
  ): Promise<ToolResult> {
    if (!allowed.has(call.name)) {
      // The injection-containment path: the model asked for something the node never
      // declared, so it is refused before dispatch rather than policed inside the tool.
      return { content: `tool "${call.name}" is not available to node "${w.node.id}"`, isError: true };
    }
    const tool = this.tools.get(call.name);
    if (tool === undefined) return { content: `unknown tool "${call.name}"`, isError: true };
    return this.#invokeTool(ctx, w.task, tool, call.arguments, 0);
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

    // 3 — re-validate after any rewrite, then execute
    const final = validate(tool.parameters, first.value);
    if (!final.ok) return { content: `invalid arguments after guards:\n- ${final.errors.join("\n- ")}`, isError: true };

    const started = this.#now();
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

  async #commit(ctx: RunContext, w: Wave, outcome: NodeOutcome): Promise<void> {
    const p = (await this.#project(ctx))!;

    if (outcome.status === "gate") {
      await this.gates.raise(ctx.log, {
        runId: ctx.runId,
        taskId: w.task.taskId,
        nodeId: w.node.id,
        policyRef: outcome.gate!.policyRef,
        payload: outcome.gate!.payload,
        ...(w.node.humanGate === undefined ? {} : { allowEdit: w.node.writes ?? [] }),
      });
      return;
    }

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

    const events: NewEvent[] = [];
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

    await ctx.log.commit(p.seq, events, { taskId: w.task.taskId });
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

    const tool = w.node.tool === undefined ? undefined : this.tools.get(w.node.tool.name);
    // Only refuse once the call REACHED the sandbox. A failure before that (schema
    // validation, a policy deny) touched nothing, so retrying it is safe even for a
    // non-idempotent tool.
    if (tool !== undefined && !tool.idempotent && this.#effectStarted(p, w.task.taskId)) return undefined;

    const initial = policy.initialMs ?? 500;
    const max = policy.maxMs ?? 30_000;
    const raw = policy.backoff === "fixed" ? initial : initial * 2 ** (attempt - 1);
    // No jitter here: the delay must be a pure function of (policy, attempt) or
    // replay diverges. Real jitter belongs in the distributed scheduler, where the
    // delay is not part of the recorded decision.
    return { afterMs: Math.min(raw, max), code: error.code };
  }

  /** True when this Task already started an effect — i.e. the bell may have rung. */
  #effectStarted(p: RunProjection, taskId: TaskId): boolean {
    return p.startedEffects.some((k) => k.startsWith(`${taskId}:`));
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
      wave[channel] = [{ branch: w.task.branch, value }];
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
        for (let i = 0; i < list.length; i++) {
          const branch = childBranch(w.task.branch, e.id, i);
          events.push({
            type: "task.ready",
            payload: {
              nodeId: e.to,
              branchPath: encodeBranch(branch),
              edgesIn: [e.id],
              binding: { channel: e.as ?? "item", value: list[i] },
            },
            actor: SYSTEM_ACTOR("scheduler"),
            taskId: makeTaskId(e.to, branch, 0),
          });
        }
        continue;
      }

      if (e.kind === "join") {
        const fired = this.#maybeFireJoin(ctx, p, w, e, selfStatus);
        if (fired !== undefined) events.push(fired);
        continue;
      }

      const iteration = e.kind === "loop" ? w.task.iteration + 1 : 0;
      events.push({
        type: "task.ready",
        payload: { nodeId: e.to, branchPath: encodeBranch(w.task.branch), edgesIn: [e.id] },
        actor: SYSTEM_ACTOR("scheduler"),
        taskId: makeTaskId(e.to, w.task.branch, iteration),
      });
    }

    // A join is notified by TERMINATION, not by edge selection. A failed branch takes
    // no outgoing edge, but it still counts toward the barrier — otherwise a fan-out
    // whose last branch fails would hang forever waiting for an arrival that can
    // never come.
    for (const e of ctx.index.outbound.get(w.node.id) ?? []) {
      if (e.kind !== "join" || take.includes(e.id)) continue;
      const fired = this.#maybeFireJoin(ctx, p, w, e, selfStatus);
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
      if (mode === "skip" || mode === "compensate") return true;
    }
    return false;
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
  ): NewEvent | undefined {
    const joinNode = ctx.index.byId.get(edge.to);
    const join = joinNode?.join;
    if (join === undefined) return undefined;

    const parent: BranchCoordinate = { segments: w.task.branch.segments.slice(0, -1) };
    const parentPath = encodeBranch(parent);
    const joinTaskId = makeTaskId(edge.to, parent, 0);
    if (p.tasks[joinTaskId] !== undefined) return undefined; // already fired

    // `expected` is simply how many sibling Tasks exist: a fan-out materialises them
    // all in one append, so the width is known the moment the first branch commits.
    // (Lazy materialisation under backpressure would make this a count of *planned*
    // branches instead — deferred, and noted in the journal.)
    const siblings = Object.values(p.tasks).filter(
      (t) => join.branches.includes(t.nodeId) && encodeBranch({ segments: t.branch.segments.slice(0, -1) }) === parentPath,
    );
    const expected = siblings.length;

    // `p` predates this Task's own commit, so substitute its outcome rather than
    // counting it twice — once as still-running and once as finished.
    const isTerminalState = (s: string): boolean =>
      s === "succeeded" || s === "failed" || s === "skipped" || s === "cancelled";
    let succeeded = 0;
    let terminal = 0;
    for (const t of siblings) {
      const state = t.taskId === w.task.taskId ? selfStatus : t.state;
      if (state === "succeeded") succeeded++;
      if (isTerminalState(state)) terminal++;
    }

    const fire = (() => {
      switch (join.mode) {
        case "all":
          return terminal >= expected;
        case "any":
        case "firstSuccess":
          return succeeded >= 1;
        case "quorum": {
          const k = join.k ?? 1;
          const need = k <= 1 ? Math.ceil(k * expected) : k;
          return succeeded >= need || terminal >= expected;
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

  async #finish(ctx: RunContext, p: RunProjection): Promise<void> {
    if (isTerminal(p.status)) return;

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

    await this.#serialize(() =>
      ctx.log.append([
        {
          type: "run.completed",
          payload: { outputs: collectOutputs(p, ctx.graph.spec), usage: p.usage },
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

  #irreversibilityOf(node: NodeSpec) {
    if (node.tool === undefined) return "read_only" as const;
    return this.tools.get(node.tool.name)?.irreversibility ?? "irreversible";
  }

  #capabilitiesOf(node: NodeSpec): readonly string[] {
    const own = node.policy?.capabilities ?? [];
    if (node.tool === undefined) return own;
    return [...own, ...(this.tools.get(node.tool.name)?.capabilities ?? [])];
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

function firstWrite(node: NodeSpec): string | undefined {
  return (node.writes ?? [])[0];
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
