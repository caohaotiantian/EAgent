/**
 * THE SHIPPED SCHEDULER STRANDED A RUN A CRASH LEFT MID-TASK, PERMANENTLY.
 *
 * `Engine` takes `opts.scheduler ?? new InProcessScheduler()` and `openWorkspace` passes none, so
 * `InProcessScheduler` is the only scheduler on the product path. Its `select` was
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
 *   - `Engine.#advanceSerially` DOES NOT CALL `select` ON THIS SHAPE. It short-circuits on an
 *     empty `ready` set sixty-five lines earlier and finishes the run. The last test drives a
 *     real engine over the stranded journal with a spy scheduler and asserts zero calls, so this
 *     file states the gap rather than implying the product path works. Delete that test when the
 *     engine consults `select` first, and flip it to the opposite assertion.
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

test("a node with no enforced deadline is NOT reclaimed — the scheduler fails closed", async () => {
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
 * THE ENGINE NEVER ASKS. Everything above is a property of `select`, and `select` is not on the
 * path a stranded run takes.
 *
 * This is a REGRESSION PIN ON A KNOWN GAP, not a passing feature: it asserts the wrong
 * behaviour, so that the day `engine.ts` moves its short-circuit below the scheduler call this
 * test fails and is flipped. `#advanceSerially` reads
 *
 *     const ready = tasksInState(p, "ready").filter(…);
 *     if (ready.length === 0) { … await this.#finish(ctx, p); return …; }
 *
 * sixty-five lines above `const wave = this.#scheduler.select({…})`. A SIGKILLed plane leaves
 * `ready` empty and one task `leased`, so the run is FINISHED — folded to `failed` — without any
 * scheduler being consulted.
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

test("the engine's `ready.length === 0` short-circuit means `select` is never called on a stranded run", async () => {
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

  assert.equal(spy.calls, 0, "the scheduler seam is not reached at all on the shape reclaim exists for");
  assert.equal(p.tasks[AGENT_TASK]?.state, "leased", "the stranded task is exactly where the crash left it");
  assert.equal(p.status, "failed", "and the run was declared over rather than resumed");
});
