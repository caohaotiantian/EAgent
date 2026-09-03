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
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import { SYSTEM_ACTOR, type NewEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { encodeBranch, taskId as makeTaskId, type NodeId, type RunId, type TaskId } from "../../src/ids.ts";
import { RunLog } from "../../src/run/log.ts";
import { foldRun, type RunProjection } from "../../src/run/projection.ts";
import { InProcessScheduler, LeasedScheduler } from "../../src/run/scheduler.ts";
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

test("...and never takes back a lease this same worker still holds", async () => {
  // In-process that lease is work running RIGHT NOW, in a later wave of a re-entrant `advance`.
  const w = await strandedRun(AGENT, AGENT_TASK, "host:111:1");
  const s = new InProcessScheduler();
  assert.deepEqual(ask(s, w, LEASED_AT + 10_000_000, "host:111:1"), [], "our own lease is never expired out from under us");
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
