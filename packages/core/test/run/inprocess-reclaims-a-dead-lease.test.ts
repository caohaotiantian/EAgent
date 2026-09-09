/**
 * THE SHIPPED SCHEDULER STRANDED A RUN A CRASH LEFT MID-TASK, PERMANENTLY.
 *
 * `Engine` takes `opts.scheduler ?? new InProcessScheduler()`, and `openWorkspace` passes an
 * `InProcessScheduler` of its own (it supplies `strandedLeaseMs` — see the last test in this file
 * and `cli.ts`'s `STRANDED_LEASE_MS`), so this class is the only scheduler on the product path
 * either way. Its `select` was
 * `eligible(input)` alone, and `eligible` returns `ready` tasks only — but a worker SIGKILLed
 * between `task.leased` and `task.committed` folds to `leased`, which `eligible` excludes by
 * construction. No later `advance`, in that process or after a restart, ever selected it again:
 * `loom resume` folded a complete and correct journal, chose an empty wave, and exited 0 having
 * done nothing, which reads exactly like a run legitimately waiting.
 *
 * This folds that journal — the real one, not a hand-built projection, which is the distinction
 * `contention.test.ts` opens with — and asks the scheduler.
 *
 * TWO THINGS THIS FILE ALSO PINS, because the first version of the fix passed while being
 * unreachable and while refusing the ordinary deployment:
 *
 *   - `Engine.#advanceSerially` REACHES `select` ON THIS SHAPE. It used not to: the
 *     "nothing is ready" short-circuit sat sixty-five lines above the scheduler call, so a
 *     stranded run was declared over without any scheduler being consulted. The last test drives
 *     a real engine over the stranded journal with a spy scheduler and pins the product path.
 *   - THE WORKER ID IS NOT THE IDENTITY. `Engine` defaults `workerId` to `"worker-0"`, which is
 *     stable across a restart, so a name-based "is this mine?" refused to reclaim for every
 *     embedder and for the whole test harness. The reclaim tests below therefore run under the
 *     DEFAULT id, on a fresh scheduler object, which is what a restarted process has.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import { SYSTEM_ACTOR, type NewEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { encodeBranch, taskId as makeTaskId, type NodeId, type RunId, type TaskId } from "../../src/ids.ts";
import { RunLog } from "../../src/run/log.ts";
import { foldRun, type RunProjection } from "../../src/run/projection.ts";
import { InProcessScheduler, LeasedScheduler, type Runnable, type Scheduler, type SelectInput } from "../../src/run/scheduler.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { compileSkeleton } from "./skeleton.ts";

const RUN = "run_stranded" as RunId;
const LEASED_AT = 1_000;

/** `summarize` is an `agent` and carries a declared 60 s deadline; `collect` is a `join` and has none. */
const AGENT = "summarize" as NodeId;
const JOIN = "collect" as NodeId;

const branch = { segments: [{ edgeId: "e0", index: 0 }] };
const AGENT_TASK = makeTaskId(AGENT, branch, 0);
const JOIN_TASK = makeTaskId(JOIN, { segments: [] }, 0);

/**
 * A journal in exactly the state a SIGKILL between `task.leased` and `task.committed` leaves.
 * `holder` is the worker id the dead process wrote.
 */
async function strandedRun(node: NodeId, task: TaskId, holder: string): Promise<{ graph: RunGraph; projection: RunProjection; nodes: Map<string, NodeSpec> }> {
  const clock = { t: LEASED_AT };
  const store = new MemoryStateStore({ now: () => clock.t });
  const graph = compileSkeleton();
  const log = new RunLog(RUN, { store, now: () => clock.t });
  const seed: NewEvent[] = [
    {
      type: "run.submitted",
      payload: { workflow: "stranded", graphHash: graph.graphHash, inputs: {}, idempotencyKey: "k", configDigest: "d" },
      actor: SYSTEM_ACTOR("api"),
    },
    { type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("executor") },
    {
      type: "task.ready",
      payload: { nodeId: node, branchPath: encodeBranch(node === AGENT ? branch : { segments: [] }), edgesIn: ["e0"] },
      actor: SYSTEM_ACTOR("scheduler"),
      taskId: task,
    },
    { type: "task.leased", payload: { workerId: holder, attempt: 1 }, actor: SYSTEM_ACTOR("scheduler"), taskId: task },
  ];
  await log.append(seed);
  const events = [];
  for await (const e of store.read(RUN, 1)) events.push(e);
  const projection = foldRun(events)!;
  const nodes = new Map<string, NodeSpec>(graph.spec.nodes.map((n) => [String(n.id), n]));
  return { graph, projection, nodes };
}

const ask = (
  s: { select: (i: never) => readonly { task: { taskId: TaskId } }[] },
  w: Awaited<ReturnType<typeof strandedRun>>,
  now: number,
  workerId: string,
): string[] =>
  s
    .select({ projection: w.projection, graph: w.graph, nodes: w.nodes, maxParallelism: 8, now, workerId } as never)
    .map((r) => String(r.task.taskId));

test("a task the dead worker leased is folded `leased`, which `eligible` excludes", async () => {
  const w = await strandedRun(AGENT, AGENT_TASK, "host:111:1");
  assert.equal(w.projection.tasks[AGENT_TASK]?.state, "leased", "the journal is complete and correct");
  // This is the shape the fix has to reach; the assertion is here so the fixture cannot rot.
  assert.equal(w.projection.tasks[AGENT_TASK]?.lease?.workerId, "host:111:1");
});

test("InProcessScheduler reclaims it once the node's OWN declared deadline has passed", async () => {
  const w = await strandedRun(AGENT, AGENT_TASK, "host:111:1");
  const s = new InProcessScheduler();
  const restarted = "host:222:1"; // a restart comes back under a new pid

  assert.deepEqual(ask(s, w, LEASED_AT + 1, restarted), [], "inside the deadline the holder may still be running it");
  assert.deepEqual(ask(s, w, LEASED_AT + 60_000, restarted), [], "the boundary is live, as it is for LeasedScheduler");
  assert.deepEqual(ask(s, w, LEASED_AT + 60_001, restarted), [AGENT_TASK], "past it, no live execution can hold it");
});

test("...under `Engine`'s DEFAULT worker id, which a restart does not change", async () => {
  // The shape the whole product path is in: `EngineOptions.workerId` is optional and defaults to
  // `"worker-0"`, so the dead plane and the one reading its journal are the same NAME. A test
  // that only ever varied the name proved the fix on the one deployment `cli.ts` produces and
  // missed every embedder and this suite's own harness.
  const w = await strandedRun(AGENT, AGENT_TASK, "worker-0");
  const s = new InProcessScheduler(); // fresh, because a restart builds a fresh one
  assert.deepEqual(ask(s, w, LEASED_AT + 60_000, "worker-0"), [], "inside the deadline, still live");
  assert.deepEqual(ask(s, w, LEASED_AT + 60_001, "worker-0"), [AGENT_TASK], "past it, the predecessor's work is reclaimed");
});

test("...and never takes back a lease THIS scheduler object handed out", async () => {
  // In-process that lease is work running RIGHT NOW, in a later wave of a re-entrant `advance`.
  // The journal cannot tell the two apart — same id, same shape — so the discriminator is that
  // this object returned the task from `select` and therefore owns what happened next.
  const clock = { t: LEASED_AT };
  const store = new MemoryStateStore({ now: () => clock.t });
  const graph = compileSkeleton();
  const log = new RunLog(RUN, { store, now: () => clock.t });
  const nodes = new Map<string, NodeSpec>(graph.spec.nodes.map((nd) => [String(nd.id), nd]));
  await log.append([
    {
      type: "run.submitted",
      payload: { workflow: "reentrant", graphHash: graph.graphHash, inputs: {}, idempotencyKey: "k", configDigest: "d" },
      actor: SYSTEM_ACTOR("api"),
    },
    { type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("executor") },
    {
      type: "task.ready",
      payload: { nodeId: AGENT, branchPath: encodeBranch(branch), edgesIn: ["e0"] },
      actor: SYSTEM_ACTOR("scheduler"),
      taskId: AGENT_TASK,
    },
  ]);
  const fold = async (): Promise<RunProjection> => {
    const events = [];
    for await (const ev of store.read(RUN, 1)) events.push(ev);
    return foldRun(events)!;
  };

  const s = new InProcessScheduler();
  // The wave this process dispatches …
  assert.deepEqual(ask(s, { graph, projection: await fold(), nodes }, LEASED_AT, "worker-0"), [AGENT_TASK]);
  // … and the lease the executor then writes for it.
  await log.append([
    { type: "task.leased", payload: { workerId: "worker-0", attempt: 1 }, actor: SYSTEM_ACTOR("scheduler"), taskId: AGENT_TASK },
  ]);
  const leased = { graph, projection: await fold(), nodes };
  assert.deepEqual(
    ask(s, leased, LEASED_AT + 10_000_000, "worker-0"),
    [],
    "our own in-flight lease is never expired out from under us, at any age",
  );
  // A DIFFERENT process reading the same journal is a fresh object, and it reclaims.
  assert.deepEqual(ask(new InProcessScheduler(), leased, LEASED_AT + 60_001, "worker-0"), [AGENT_TASK]);

  // AND THE MEMORY IS RELEASED WHEN THE TASK RESOLVES, which is observable rather than a claim
  // about a private map: once the task commits, this object is no longer answerable for it, so a
  // LATER lease on the same id — the shape a retry plus a crash produces — is reclaimable again.
  clock.t = LEASED_AT + 1;
  await log.append([
    { type: "task.committed", payload: { status: "succeeded" as const, writes: {}, take: [], attempt: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 } }, actor: SYSTEM_ACTOR("executor"), taskId: AGENT_TASK },
  ]);
  assert.deepEqual(ask(s, { graph, projection: await fold(), nodes }, LEASED_AT + 2, "worker-0"), [], "committed, so nothing to run");
  await log.append([
    { type: "task.ready", payload: { nodeId: AGENT, branchPath: encodeBranch(branch), edgesIn: ["e0"] }, actor: SYSTEM_ACTOR("scheduler"), taskId: AGENT_TASK },
    { type: "task.leased", payload: { workerId: "worker-0", attempt: 2 }, actor: SYSTEM_ACTOR("scheduler"), taskId: AGENT_TASK },
  ]);
  assert.deepEqual(
    ask(s, { graph, projection: await fold(), nodes }, LEASED_AT + 60_002, "worker-0"),
    [AGENT_TASK],
    "the id was forgotten when it stopped being `leased`, so this lease is a stranger's",
  );
});

test("a node with no enforced deadline is NOT reclaimed BY DEFAULT — the scheduler fails closed", async () => {
  // `join`, `router`, `human_gate` and `subgraph` get no effective timeout (compile.ts's
  // `effectiveTimeout` says why for each), so there is no bound to prove the holder is gone.
  const w = await strandedRun(JOIN, JOIN_TASK, "host:111:1");
  const s = new InProcessScheduler();
  assert.deepEqual(ask(s, w, LEASED_AT + 10_000_000, "host:222:1"), [], "no deadline is not permission");
  // …and the seam that CAN reclaim it is the one already on the public surface.
  assert.deepEqual(
    ask(new LeasedScheduler({ leaseMs: 30_000 }) as never, w, LEASED_AT + 30_001, "host:222:1"),
    [JOIN_TASK],
    "LeasedScheduler's flat lease covers what the graph's own deadlines cannot",
  );
});

/**
 * THE COUNTER-CONTROL FOR TODO.md §B.1, AND IT IS ONE CONSTRUCTOR ARGUMENT WIDE.
 *
 * The test above is the whole reason `loom serve` could not survive its own death on four of the
 * eight node types: a crash on a `join`, `router`, `human_gate` or `subgraph` task left it
 * `leased`, `eligible` excludes `leased`, and the reclaim arm had no bound to reason from. The
 * answer was "ask for a `LeasedScheduler`" — a seam an EMBEDDER can reach and the binary did not.
 *
 * `strandedLeaseMs` is that bound, supplied by the deployment rather than by the graph, and this
 * asks the SAME folded journal at the SAME instant with only that argument different. It belongs
 * beside the refusal because the two sentences are one decision: with no number, no reclaim; with
 * a number, the number.
 *
 * IT DOES NOT WEAKEN `held`, WHICH IS THE ONLY THING KEEPING IT SAFE — the third and fourth
 * assertions are that half. A lease this scheduler object handed out is never taken back at any
 * age, and a fresh object (what a restart builds) reclaims it. Same map, same rule, wider
 * deadline. The fifth and sixth are the other bound: a node that declared its OWN deadline keeps
 * it, so a fallback can only ever add a bound where there was none.
 */
test("...and IS reclaimed when the deployment supplies a fallback lease deadline", async () => {
  const w = await strandedRun(JOIN, JOIN_TASK, "host:111:1");
  const s = new InProcessScheduler({ strandedLeaseMs: 30_000 });
  assert.deepEqual(ask(s, w, LEASED_AT + 30_000, "host:222:1"), [], "the boundary is live, as it is everywhere else here");
  assert.deepEqual(ask(s, w, LEASED_AT + 30_001, "host:222:1"), [JOIN_TASK], "past the deployment's bound, the predecessor's task is offered");

  // AND `held` STILL BOUNDS IT. `s` has now offered JOIN_TASK once, so it owns whatever happened
  // next; the same projection at ten million ms is no longer its to take back. A FRESH object —
  // which is what a restart builds, and the only thing that ever sees this state — still does.
  //
  // (Asked before the AGENT fixture below, deliberately: `strandedRun` reuses one run id, and
  // `select`'s prune drops any held id the projection it is handed no longer shows as `leased`.
  // Asking `s` about a DIFFERENT projection of the same run would empty the map and make the
  // assertion above pass for the wrong reason.)
  assert.deepEqual(ask(s, w, LEASED_AT + 10_000_000, "host:222:1"), [], "a lease this object handed out is never re-offered, at any age");
  assert.deepEqual(
    ask(new InProcessScheduler({ strandedLeaseMs: 30_000 }), w, LEASED_AT + 30_001, "host:222:1"),
    [JOIN_TASK],
    "the restarted plane's own scheduler has handed out nothing, so the predecessor's lease is a stranger's",
  );

  // THE NODE'S OWN DEADLINE STILL WINS where it has one. `summarize` declares 60 s, so a 30 s
  // fallback must not make it reclaimable at 30 s — a fallback is what a node with no bound falls
  // back TO, never a second bound applied beside one.
  const a = await strandedRun(AGENT, AGENT_TASK, "host:111:1");
  const s2 = new InProcessScheduler({ strandedLeaseMs: 30_000 });
  assert.deepEqual(ask(s2, a, LEASED_AT + 30_001, "host:222:1"), [], "the 60 s the node declared is the one that applies");
  assert.deepEqual(ask(s2, a, LEASED_AT + 60_001, "host:222:1"), [AGENT_TASK], "and it applies unchanged");
});

test("the ORDINARY selection is unchanged — ready tasks, critical path first", async () => {
  const clock = { t: LEASED_AT };
  const store = new MemoryStateStore({ now: () => clock.t });
  const graph = compileSkeleton();
  const log = new RunLog(RUN, { store, now: () => clock.t });
  const t0 = makeTaskId(AGENT, { segments: [{ edgeId: "e0", index: 0 }] }, 0);
  const t1 = makeTaskId(AGENT, { segments: [{ edgeId: "e0", index: 1 }] }, 0);
  await log.append([
    {
      type: "run.submitted",
      payload: { workflow: "ordinary", graphHash: graph.graphHash, inputs: {}, idempotencyKey: "k", configDigest: "d" },
      actor: SYSTEM_ACTOR("api"),
    },
    { type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("executor") },
    ...[0, 1].map((k) => ({
      type: "task.ready" as const,
      payload: { nodeId: AGENT, branchPath: encodeBranch({ segments: [{ edgeId: "e0", index: k }] }), edgesIn: ["e0"] },
      actor: SYSTEM_ACTOR("scheduler"),
      taskId: k === 0 ? t0 : t1,
    })),
  ]);
  const events = [];
  for await (const e of store.read(RUN, 1)) events.push(e);
  const projection = foldRun(events)!;
  const nodes = new Map<string, NodeSpec>(graph.spec.nodes.map((n) => [String(n.id), n]));
  const w = { graph, projection, nodes };
  assert.deepEqual(ask(new InProcessScheduler(), w, LEASED_AT, "host:111:1"), [t0, t1], "both ready tasks, in branch order");
  assert.deepEqual(
    new InProcessScheduler().select({ projection, graph, nodes, maxParallelism: 1, now: LEASED_AT, workerId: "w" } as never).length,
    1,
    "maxParallelism still bounds the wave",
  );
});

/**
 * THE ENGINE ASKS. Everything above is a property of `select`; this is the product path.
 *
 * `#advanceSerially` calls `this.#scheduler.select({…})` BEFORE its `ready.length === 0`
 * short-circuit, and that short-circuit now also requires an empty wave. While the order was the
 * other way round a SIGKILLed plane — `ready` empty, one task `leased` — was FINISHED, folded to
 * `failed`, with no scheduler consulted; that is what this test pinned before the fix and what it
 * refutes now.
 */
class SpyScheduler implements Scheduler {
  readonly kind = "spy";
  calls = 0;
  readonly #inner = new InProcessScheduler();
  select(input: SelectInput): readonly Runnable[] {
    this.calls += 1;
    return this.#inner.select(input);
  }
}

test("the engine consults `select` on a stranded run, and the reclaimed task is dispatched", async () => {
  const clock = { t: LEASED_AT };
  const store = new MemoryStateStore({ now: () => clock.t });
  const graph = compileSkeleton();
  const log = new RunLog(RUN, { store, now: () => clock.t });
  await log.append([
    {
      type: "run.submitted",
      payload: { workflow: "stranded", graphHash: graph.graphHash, inputs: {}, idempotencyKey: "k", configDigest: "d" },
      actor: SYSTEM_ACTOR("api"),
    },
    { type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("executor") },
    {
      type: "task.ready",
      payload: { nodeId: AGENT, branchPath: encodeBranch(branch), edgesIn: ["e0"] },
      actor: SYSTEM_ACTOR("scheduler"),
      taskId: AGENT_TASK,
    },
    { type: "task.leased", payload: { workerId: "worker-0", attempt: 1 }, actor: SYSTEM_ACTOR("scheduler"), taskId: AGENT_TASK },
  ]);

  const spy = new SpyScheduler();
  // Well past the node's 60 s deadline, so `select` WOULD reclaim — see the tests above, which
  // ask this exact scheduler the same question over this exact journal and get the task back.
  clock.t = LEASED_AT + 10_000_000;
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => clock.t,
    scheduler: spy,
    policy: { granted: ["fs:read", "fs:write"], budget: { runUsd: 1 } },
  });
  engine.attach(RUN, graph);

  const p = await engine.advance(RUN);

  assert.equal(spy.calls, 1, "the scheduler seam is reached on the shape reclaim exists for");
  // Dispatched, not stranded and not buried: an `agent` node under posture `out` asks before it
  // acts, so the reclaimed task is at its gate. `leased` would mean the crash still owns it and
  // `failed` would mean the run was declared over — the two outcomes this change removes.
  assert.equal(p.tasks[AGENT_TASK]?.state, "awaiting_gate", "the reclaimed task ran and reached its gate");
  assert.equal(p.status, "awaiting_gate", "and the run is alive, waiting on a human, rather than failed");
});
