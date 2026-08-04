/**
 * The scheduler seam, and one conformance suite over two implementations.
 *
 * Checklist item 7 says "local → distributed changes implementations, never call sites".
 * For the journal that is discharged by one suite passing against both stores. For the
 * scheduler it was a claim about code with no seam at all — selection was twenty lines
 * inline in `Engine.advance`, so swapping it would have meant editing the executor.
 *
 * So: the shared suite runs against `InProcessScheduler` and `LeasedScheduler`, and the
 * lease-specific tests cover the three things a multi-worker selector must do that a
 * single-worker one never has to.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import type { NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { NodeId, TaskId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection, TaskRecord } from "../../src/run/projection.ts";
import {
  InProcessScheduler,
  LeasedScheduler,
  eligible,
  orderByCriticalPath,
  type Scheduler,
  type SelectInput,
} from "../../src/run/scheduler.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { DOCS, compileSkeleton, harness } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;

/** A projection with exactly the Tasks a test cares about. */
type TaskSeed = Omit<Partial<TaskRecord>, "nodeId"> & { nodeId?: string };

function projectionWith(tasks: TaskSeed[]): RunProjection {
  return {
    runId: "run_s" as never,
    graphHash: "h",
    status: "running",
    seq: 1 as never,
    startedAt: 0,
    posture: "out",
    channels: {},
    bindings: {},
    tasks: Object.fromEntries(
      tasks.map((t, i) => {
        const taskId = (t.taskId ?? `${t.nodeId ?? "node"}@root#${i}`) as TaskId;
        return [
          taskId,
          {
            taskId,
            nodeId: (t.nodeId ?? "node") as NodeId,
            branch: t.branch ?? { segments: [] },
            iteration: 0,
            state: t.state ?? "ready",
            attempt: 0,
            edgesIn: [],
            take: [],
            writes: {},
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 },
            ...t,
          } as TaskRecord,
        ];
      }),
    ),
    gates: {},
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 },
    reservedUsd: 0,
    outputs: {},
    unknownEffects: [],
    startedEffects: [],
    budgetExhausted: false,
    fanouts: {},
  } as unknown as RunProjection;
}

const NODE = (id: string): NodeSpec => ({ id: n(id), type: "function", function: { ref: "function/x@stable" } });

function input(over: Partial<SelectInput> & { projection: RunProjection }): SelectInput {
  const graph = compileSkeleton();
  return {
    graph,
    nodes: new Map(["start", "summarize", "collect", "merge", "approve", "write", "node", "a", "b"].map((id) => [id, NODE(id)])),
    maxParallelism: 16,
    now: 1000,
    workerId: "w1",
    ...over,
  };
}

// ── the conformance suite, run against BOTH ──────────────────────────────────

const IMPLEMENTATIONS: readonly { readonly name: string; readonly make: () => Scheduler }[] = [
  { name: "InProcessScheduler", make: () => new InProcessScheduler() },
  { name: "LeasedScheduler", make: () => new LeasedScheduler({ leaseMs: 30_000 }) },
];

for (const impl of IMPLEMENTATIONS) {
  test(`${impl.name}: selects only READY Tasks`, () => {
    const p = projectionWith([
      { nodeId: "a", state: "ready" },
      { nodeId: "b", state: "succeeded" },
      { nodeId: "a", state: "leased" },
      { nodeId: "b", state: "failed" },
    ]);
    const out = impl.make().select(input({ projection: p }));
    assert.equal(out.length, 1);
    assert.equal(out[0]?.task.state, "ready");
  });

  test(`${impl.name}: respects a retry backoff`, () => {
    const p = projectionWith([
      { nodeId: "a", state: "ready", retryAfter: 5000 },
      { nodeId: "b", state: "ready" },
    ]);
    const out = impl.make().select(input({ projection: p, now: 1000 }));
    assert.deepEqual(out.map((x) => x.task.nodeId), ["b"], "a Task still in backoff is not runnable yet");

    const later = impl.make().select(input({ projection: p, now: 9000 }));
    assert.equal(later.length, 2);
  });

  test(`${impl.name}: never exceeds maxParallelism`, () => {
    const p = projectionWith(Array.from({ length: 20 }, () => ({ nodeId: "a", state: "ready" as const })));
    assert.equal(impl.make().select(input({ projection: p, maxParallelism: 3 })).length, 3);
  });

  test(`${impl.name}: is DETERMINISTIC — the same input gives the same wave`, () => {
    // Replay re-derives waves. A scheduler that shuffled would make a replay's task order
    // differ from the original's for a reason unrelated to the graph.
    const p = projectionWith([
      { nodeId: "summarize", state: "ready" },
      { nodeId: "merge", state: "ready" },
      { nodeId: "write", state: "ready" },
    ]);
    const s = impl.make();
    const a = s.select(input({ projection: p })).map((x) => x.task.taskId);
    const b = s.select(input({ projection: p })).map((x) => x.task.taskId);
    assert.deepEqual(a, b);
  });

  test(`${impl.name}: orders by critical path, longest remaining first`, () => {
    const graph = compileSkeleton();
    const p = projectionWith([
      { nodeId: "write", state: "ready" },
      { nodeId: "start", state: "ready" },
      { nodeId: "merge", state: "ready" },
    ]);
    const out = impl.make().select(input({ projection: p, graph }));
    const lengths = out.map((x) => graph.plans[x.task.nodeId]?.criticalPathLength ?? 0);
    assert.deepEqual([...lengths].sort((a, b) => b - a), lengths, `got ${lengths.join(",")}`);
  });

  test(`${impl.name}: skips a Task whose node is not in the graph`, () => {
    // Not defensiveness for its own sake: a graph MUTATION swaps the node set mid-run, so
    // a projection can legitimately name a node this worker's index has not caught up to.
    const p = projectionWith([{ nodeId: "ghost", state: "ready" }]);
    assert.deepEqual(impl.make().select(input({ projection: p })), []);
  });

  test(`${impl.name}: an empty projection yields an empty wave, not a throw`, () => {
    assert.deepEqual(impl.make().select(input({ projection: projectionWith([]) })), []);
  });
}

// ── what only the leased one has to do ───────────────────────────────────────

test("LeasedScheduler SKIPS A TASK ANOTHER WORKER HOLDS", () => {
  // Running it anyway is the double execution the fencing token catches AFTER the fact —
  // and after the fact is too late for a tool that already sent an email.
  const p = projectionWith([
    { nodeId: "a", state: "ready", lease: { workerId: "w2", at: 900, fencingToken: 1 } },
    { nodeId: "b", state: "ready" },
  ]);
  const out = new LeasedScheduler({ leaseMs: 30_000 }).select(input({ projection: p, now: 1000, workerId: "w1" }));
  assert.deepEqual(out.map((x) => x.task.nodeId), ["b"]);
});

test("LeasedScheduler RECLAIMS AN EXPIRED LEASE — a dead worker must not strand a Task", () => {
  const p = projectionWith([{ nodeId: "a", state: "ready", lease: { workerId: "w2", at: 0, fencingToken: 1 } }]);
  const s = new LeasedScheduler({ leaseMs: 5000 });

  assert.equal(s.select(input({ projection: p, now: 4000, workerId: "w1" })).length, 0, "still held");
  assert.equal(s.select(input({ projection: p, now: 6000, workerId: "w1" })).length, 1, "expired, so reclaimable");
});

test("LeasedScheduler takes back its OWN lease without waiting", () => {
  // A worker resuming its own work after a restart is not contention with itself.
  const p = projectionWith([{ nodeId: "a", state: "ready", lease: { workerId: "w1", at: 999, fencingToken: 1 } }]);
  const out = new LeasedScheduler({ leaseMs: 30_000 }).select(input({ projection: p, now: 1000, workerId: "w1" }));
  assert.equal(out.length, 1);
});

test("InProcessScheduler ignores leases entirely, because there is only one worker", () => {
  const p = projectionWith([{ nodeId: "a", state: "ready", lease: { workerId: "w2", at: 0, fencingToken: 1 } }]);
  assert.equal(new InProcessScheduler().select(input({ projection: p })).length, 1);
});

// ── the helpers ──────────────────────────────────────────────────────────────

test("eligible() is shared, because 'ready and past its backoff' is not a policy", () => {
  const p = projectionWith([
    { nodeId: "a", state: "ready" },
    { nodeId: "b", state: "leased" },
  ]);
  assert.equal(eligible(input({ projection: p })).length, 1);
});

test("orderByCriticalPath breaks ties on branch coordinate, which is a TOTAL order", () => {
  const graph = compileSkeleton();
  const p = projectionWith([
    { nodeId: "summarize", state: "ready", branch: { segments: [{ edgeId: "e0", index: 10 }] } },
    { nodeId: "summarize", state: "ready", branch: { segments: [{ edgeId: "e0", index: 2 }] } },
  ]);
  const ordered = orderByCriticalPath(eligible(input({ projection: p })), graph);
  assert.deepEqual(ordered.map((x) => x.task.branch.segments[0]?.index), [2, 10], "branch 10 after branch 2");
});

// ── the seam, through the real engine ────────────────────────────────────────

test("THE EXECUTOR TAKES A SCHEDULER, so the swap is a constructor argument", async () => {
  // The whole content of "changes implementations, never call sites" for this component.
  const store = new MemoryStateStore({ now: () => 1 });
  const h = harness();
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: h.tools,
    functions: h.functions,
    models: new ModelRegistry(),
    now: () => 1,
    scheduler: new LeasedScheduler({ leaseMs: 60_000 }),
    policy: { granted: ["*"], systemFloor: "out" },
  });
  assert.ok(engine);
});

test("a run driven by the DEFAULT scheduler still completes, unchanged", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  assert.equal((p.channels["digests"] as unknown[]).length, 5);
});

test("THE PROJECTION NOW CARRIES THE LEASE the journal always recorded", async () => {
  // The read model was shaped for one worker: it folded `task.leased` into a state and
  // threw the worker id away. A second worker's first question is "is anyone on this?"
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  await h.engine.advance(runId);
  const p = (await h.engine.projection(runId))!;

  const leased = Object.values(p.tasks).filter((t) => t.lease !== undefined);
  assert.ok(leased.length > 0, "every executed Task was leased at some point");
  for (const t of leased) {
    assert.equal(typeof t.lease!.workerId, "string");
    assert.ok(t.lease!.fencingToken > 0, "and the fencing token came along with it");
  }
});
