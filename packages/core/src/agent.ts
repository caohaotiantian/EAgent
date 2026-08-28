/**
 * The one-line surface.
 *
 * WHY THIS EXISTS, since the graph already does everything it does: because a runtime whose
 * hello-world is a graph literal loses the first five minutes regardless of what it is better at
 * afterwards. The field settled this during 2025–26 — LangChain deprecated its hand-built graph
 * entry points in favour of a one-line `createAgent`, and the highest-profile visual graph builder
 * in the industry went from launch to announced shutdown in about eight months. The graph won as
 * the SUBSTRATE and lost as the AUTHORING SURFACE.
 *
 * So this is not a second runtime and it is not a shortcut around one. **`agent()` compiles to a
 * one-node graph and runs on the same engine**, which means the hello-world gets the journal, the
 * replay, the oversight gates and the budget ceiling without the caller knowing any of those words
 * yet. Reaching for `compile()` is how you add fan-out, joins and human gates — it is not how you
 * start.
 *
 * The wiring this assembles by default — an in-memory journal, a tool registry, a policy with a
 * budget — is exactly what every test harness in this repository was building by hand, which is
 * the tell that it belonged in the product rather than in the fixtures.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: pick a model for you, reach the network, or grant a
 * capability. A caller supplies the adapter; with none registered the run is served by whatever
 * the deployment registered as default, and a graph that names no tools reaches none.
 */

import { compileOrThrow } from "./graph/compile.ts";
import { digest, type Digest } from "./canonical.ts";
import { InProcessEventBus } from "./bus.ts";
import { MemoryStateStore } from "./journal/memory.ts";
import type { StateStore } from "./journal/store.ts";
import type { NodeId, RunId } from "./ids.ts";
import type { GraphSpec, ResourceRef, RunGraph } from "./graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "./graph/validate.ts";
import type { RunProjection, RunStatus } from "./run/projection.ts";
import type { UsageRecord } from "./journal/events.ts";
import { Engine, type EngineOptions } from "./run/engine.ts";
import { replayRun, type ReplayReport } from "./run/replay.ts";
import { foldTrajectory, type Trajectory } from "./evolution/trajectory.ts";
import type { JournalEvent } from "./journal/events.ts";
import {
  FunctionRegistry,
  ModelRegistry,
  ToolRegistry,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ToolDefinition,
} from "./run/registry.ts";
import type { Posture } from "./vocab.ts";

/** What a caller has to decide, and nothing more. */
export interface AgentOptions {
  /** The instructions. Inline text, not a resource ref — the ref machinery is for graphs. */
  readonly prompt: string;
  /**
   * A routing key, not a model id.
   *
   * It reaches the adapter as the profile name; a deployment that registered one default adapter
   * ignores it, and one with a routing table uses it to choose. Naming it `model` rather than
   * `profile` is deliberate: the caller is thinking of a model, and the indirection is ours.
   */
  readonly model?: string;
  /** Tool names this agent may call. Absent means none, which is the safe default and the quiet one. */
  readonly tools?: readonly string[];
  readonly maxTurns?: number;
  readonly outputSchema?: unknown;
  /** The ceiling for one run. Present by default, because an agent loop with no ceiling is the classic incident. */
  readonly budgetUsd?: number;
  /** The declared oversight floor. Irreversible tools still raise it — nothing here can lower one. */
  readonly posture?: Posture;

  // ── wiring, all optional ────────────────────────────────────────────────
  readonly adapter?: ModelAdapter;
  readonly toolDefs?: readonly ToolDefinition[];
  /** Defaults to an in-memory journal. Pass a SQLite store to survive a restart. */
  readonly store?: StateStore;
  readonly now?: () => number;
  /** Capabilities the deployment grants. A tool whose capability is absent is refused at compile. */
  readonly granted?: readonly string[];
  /**
   * WHO these runs belong to, journaled on submit.
   *
   * Optional, and its absence is the PERMISSIVE answer — a run with no recorded principal is
   * readable by every authenticated caller. That is the right default here for the same reason
   * the CLI takes it only from `--as`: an in-process library call authenticates nobody, and
   * inventing a subject is worse than recording none.
   *
   * It matters as soon as `store` is one a control plane also serves. With the default in-memory
   * journal nothing else can see these runs at all.
   */
  readonly as?: string;
}

export interface AgentResult {
  readonly runId: RunId;
  readonly status: RunStatus;
  /** What the agent wrote, when it finished. Absent when it is waiting or failed. */
  readonly output: unknown;
  readonly usage: UsageRecord;
  /** Non-empty when the run is waiting on a human. The ids are what `resolveGate` takes. */
  readonly openGates: readonly string[];
  /** The whole projection, for a caller who wants the detail without rebuilding it. */
  readonly projection: RunProjection;
}

export interface RunnableAgent {
  /** Run once, to completion or to the first thing that needs a human. */
  run(input: string): Promise<AgentResult>;
  /** Drive an existing run further — after a gate is answered, or after a restart. */
  advance(runId: RunId): Promise<AgentResult>;
  /**
   * Re-run a finished run from its journal, serving every recorded effect instead of making it.
   *
   * One line, for the same reason `run` is: the property is worthless if reaching it takes an
   * afternoon of wiring. Zero model calls and zero side effects — `report.match` is the verdict,
   * and `hermetic` says whether anything had to be re-derived rather than served.
   */
  replay(runId: RunId): Promise<ReplayReport>;
  /**
   * What this run DID, folded into the shape the scorer reads.
   *
   * The third property — a system that improves on its own runs — needs its evidence to be
   * reachable, and until now the whole capture-and-score path had no caller anywhere: correct
   * code, tested, and unreachable from a run somebody actually made. One line here is the same
   * move `replay` makes, for the same reason.
   *
   * A READ MODEL, folded from the journal rather than logged alongside it. That distinction is
   * what keeps the journal bounded: a trajectory is derived, so it costs nothing until asked
   * for, and an agent's working notes are a FILE it writes — the journal records that the file
   * changed, and the file is not in the journal.
   */
  trajectory(runId: RunId): Promise<Trajectory>;
  /** The compiled graph. This IS the agent; everything above is a convenience over it. */
  readonly graph: RunGraph;
  /** The engine, for gates, replay, cancellation and everything else the graph runtime offers. */
  readonly engine: Engine;
}

/**
 * The inline prompt's ref is CONTENT-ADDRESSED, and that is load-bearing rather than tidy.
 *
 * `graphHash` covers the SPEC and deliberately not the resolution manifest — plans are derived
 * and a re-resolve should be its own recorded fact, not a different graph. Correct for a graph
 * whose prompts live in a resource store. Wrong for an inline one: with a fixed ref, two
 * different prompts compile to the SAME hash, so editing the instructions changes what a resumed
 * run does while every identity check says nothing moved.
 *
 * That is the failure Restate documents for agents and Temporal's versioning guidance misses,
 * because in an ordinary workflow a docstring is not an input and here the prompt IS an input to
 * a recorded effect. Putting the digest in the ref puts it in the spec, which puts it in the hash.
 */
const promptRef = (prompt: string): ResourceRef =>
  `prompt/inline@${digest({ inline: prompt }).replace(/^sha256:/, "").slice(0, 16)}` as ResourceRef;

/**
 * A resolver over exactly one inline document.
 *
 * The engine refuses an agent node whose prompt pin has no document, so a one-liner needs real
 * WORDS behind its ref rather than a pointer. Digesting the text is what makes the pin honest:
 * two different prompts cannot collide onto one entry, and — the reason it matters beyond
 * tidiness — the prompt is an input to a recorded effect, so a prompt edit must change the
 * identity of what runs rather than silently altering a resumed run.
 */
function inlineResolver(prompt: string, profileRef: ResourceRef): ResourceResolver {
  const pinned: Digest = digest({ inline: prompt });
  const ownRef = promptRef(prompt);
  return {
    resolve(ref) {
      if (ref === ownRef) return { ref, digest: pinned, channel: "stable" };
      // `agent_profile` is a routing key rather than a document, so it pins to its own name.
      if (ref === profileRef) return { ref, digest: digest({ profile: ref }), channel: "stable" };
      return undefined;
    },
    document: (d) => (d === pinned ? prompt : undefined),
  };
}

/**
 * The caller's `model` reaches the provider, instead of the profile ref.
 *
 * `#runAgent` sends `agent.profile` as `ModelRequest.model` — the graph's routing KEY, which the
 * `--models-file` table maps to a real model id for a deployment that has one. A one-liner has
 * no such table, so without this the adapter received `agent_profile/claude-opus-5@v1` and a real
 * provider rejected it as an unknown model. Measured: the mock adapter answered anyway, which is
 * exactly why this survived being tested — an offline suite cannot tell a model id from a ref.
 *
 * The substitution is UNCONDITIONAL rather than keyed on the profile, and that is deliberate. The
 * engine sends other non-model strings through this seam too: a rubric evaluator sends "mock" and
 * context compaction sends "compaction". In a one-node agent every one of those calls is made on
 * behalf of THIS agent — compacting its own transcript — so they all belong on its model. A
 * deployment that wants different models for different jobs has outgrown the one-liner and wants
 * the routing table.
 */
class OneModelAdapter implements ModelAdapter {
  readonly provider: string;
  readonly #inner: ModelAdapter;
  readonly #model: string;
  constructor(inner: ModelAdapter, model: string) {
    this.#inner = inner;
    this.#model = model;
    this.provider = inner.provider;
  }
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    return this.#inner.stream({ ...req, model: this.#model }, signal);
  }
  priceOf(_model: string, usage: Parameters<ModelAdapter["priceOf"]>[1]): number {
    // PRICED AS THE REAL MODEL, not as the ref. `priceOf` on an unknown id returns 0, so pricing
    // the key would silently make every run free and every budget ceiling unreachable.
    return this.#inner.priceOf(this.#model, usage);
  }
  estimateOf(req: ModelRequest): number {
    return this.#inner.estimateOf({ ...req, model: this.#model });
  }
  outputCeilingOf(req: ModelRequest): number {
    return this.#inner.outputCeilingOf({ ...req, model: this.#model });
  }
}

function specFor(opts: AgentOptions, profileRef: ResourceRef): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "agent", project: "inline", version: 1 },
    policy: {
      posture: opts.posture ?? "out",
      budget: { costUsd: opts.budgetUsd ?? 1 },
      ...(opts.granted === undefined ? {} : { capabilities: [...opts.granted] }),
    },
    channels: {
      input: { type: "string", reduce: "replace" },
      output: { type: "object", reduce: "replace" },
    },
    inputs: ["input"],
    outputs: ["output"],
    nodes: [
      {
        id: "agent" as NodeId,
        type: "agent",
        reads: ["input"],
        writes: ["output"],
        agent: {
          profile: profileRef,
          prompt: promptRef(opts.prompt),
          maxTurns: opts.maxTurns ?? 8,
          ...(opts.tools === undefined ? {} : { tools: [...opts.tools] }),
          ...(opts.outputSchema === undefined ? {} : { outputSchema: opts.outputSchema }),
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/**
 * Build a runnable agent.
 *
 * Everything is assembled eagerly so that a configuration mistake — an unknown tool, a capability
 * the deployment does not hold, a prompt that resolves to nothing — is a THROW here rather than a
 * failure three minutes into a run that has already spent money.
 */
export function agent(opts: AgentOptions): RunnableAgent {
  const profileRef = `agent_profile/${opts.model ?? "default"}@v1` as ResourceRef;

  const tools = new ToolRegistry();
  const manifest: Record<string, ToolManifestLite> = {};
  for (const t of opts.toolDefs ?? []) {
    tools.register(t);
    manifest[t.name] = { irreversibility: t.irreversibility, capabilities: t.capabilities ?? [] } as ToolManifestLite;
  }

  const models = new ModelRegistry();
  if (opts.adapter !== undefined) {
    models.register(new OneModelAdapter(opts.adapter, opts.model ?? "default"), true);
  }

  const store = opts.store ?? new MemoryStateStore(opts.now === undefined ? {} : { now: opts.now });
  const graph = compileOrThrow({
    spec: specFor(opts, profileRef),
    resolver: inlineResolver(opts.prompt, profileRef),
    tools: manifest,
    tenantCapabilities: [...(opts.granted ?? [])],
  });

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    maxParallelism: 1,
    policy: {
      granted: [...(opts.granted ?? [])],
      budget: { runUsd: opts.budgetUsd ?? 1 },
    },
  });

  const engineOptions: Omit<EngineOptions, "store" | "bus" | "gates"> = {
    tools,
    functions: new FunctionRegistry(),
    models,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    maxParallelism: 1,
    policy: {
      granted: [...(opts.granted ?? [])],
      budget: { runUsd: opts.budgetUsd ?? 1 },
    },
  };

  const shape = (p: RunProjection): AgentResult => ({
    runId: p.runId,
    status: p.status,
    output: p.channels["output"],
    usage: p.usage,
    openGates: Object.values(p.gates)
      .filter((g) => g.state === "open")
      .map((g) => String(g.gateId)),
    projection: p,
  });

  return {
    graph,
    engine,
    async run(input: string): Promise<AgentResult> {
      const runId = await engine.submit({ graph, inputs: { input }, ...(opts.as === undefined ? {} : { principal: opts.as }) });
      return shape(await engine.advance(runId));
    },
    async advance(runId: RunId): Promise<AgentResult> {
      return shape(await engine.advance(runId));
    },
    async replay(runId: RunId): Promise<ReplayReport> {
      return replayRun({ store, runId, graph, engine: engineOptions });
    },
    async trajectory(runId: RunId): Promise<Trajectory> {
      const events: JournalEvent[] = [];
      for await (const e of store.read(runId, 1 as never)) events.push(e);
      return foldTrajectory(events, { graph });
    },
  };
}
