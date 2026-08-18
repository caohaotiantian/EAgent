/**
 * Two workers, one journal.
 *
 * `scheduler.test.ts` proves the seam exists and that both implementations agree on a
 * hand-built projection. That is not the same as proving `LeasedScheduler` is correct,
 * because a hand-built projection is a shape the AUTHOR chose — and the shape the author
 * chose (`state: "ready"` with a lease attached) is one the real fold produces only after
 * a retry or a gate. A worker that dies mid-Task leaves it in `state: "leased"` forever,
 * and no test here or there had ever folded a real journal to look.
 *
 * So this file builds the journal instead of the projection. Two `Worker`s, separate
 * `RunLog`s over one `MemoryStateStore`, an injected clock, and fencing tokens derived
 * from the journal rather than from a process-local counter — which is the only
 * derivation that survives a second process. Everything a real deployment would do
 * except the network.
 *
 * Five properties, in the order they matter:
 *
 *   1. mutual exclusion — a live lease is invisible to the other worker;
 *   2. reclaim — an expired one is not, so a dead worker strands nothing;
 *   3. fencing — the reclaimed lease's token is strictly greater, and the dead worker's
 *      late commit is refused by the store rather than merely detected;
 *   4. no starvation — over many rounds neither worker burns a poll on work it cannot
 *      have, and neither monopolises;
 *   5. the boundary — a lease expiring exactly AT `now` is LIVE.
 *
 * Property 3 is tested against `RunLog`/`StateStore` directly, because the executor does
 * not currently pass `fencingToken` on any append. See the JOURNAL entry for C3.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES } from "../../src/errors.ts";
import type { NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import { SYSTEM_ACTOR, type NewEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { encodeBranch, taskId as makeTaskId, type NodeId, type RunId, type TaskId } from "../../src/ids.ts";
import { RunLog } from "../../src/run/log.ts";
import { foldRun, type RunProjection } from "../../src/run/projection.ts";
import { LeasedScheduler, type Runnable } from "../../src/run/scheduler.ts";
import { ZERO_USAGE } from "../../src/vocab.ts";
import { compileSkeleton } from "./skeleton.ts";

const RUN = "run_contention" as RunId;
const NODE_ID = "summarize" as NodeId;
const LEASE_MS = 5_000;

const NODE: NodeSpec = { id: NODE_ID, type: "function", function: { ref: "function/x@stable" } };
const NODES = new Map<string, NodeSpec>([[NODE_ID, NODE]]);

/** `summarize@root/e0[k]#0` — derived, so both workers name the same Task. */
function branchTask(k: number): TaskId {
  return makeTaskId(NODE_ID, { segments: [{ edgeId: "e0", index: k }] }, 0);
}

// ---------------------------------------------------------------------------
// A deterministic two-worker world
// ---------------------------------------------------------------------------

interface World {
  readonly store: MemoryStateStore;
  readonly graph: RunGraph;
  readonly clock: { t: number };
  /** Advance the injected clock. Nothing in this file reads the wall clock. */
  tick(ms: number): void;
  project(): Promise<RunProjection>;
}

async function world(readyCount: number): Promise<World> {
  const clock = { t: 1_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const graph = compileSkeleton();
  const log = new RunLog(RUN, { store, now: () => clock.t });

  const seed: NewEvent[] = [
    {
      type: "run.submitted",
      payload: {
        workflow: "contention",
        graphHash: graph.graphHash,
        inputs: {},
        idempotencyKey: "k",
        configDigest: "d",
      },
      actor: SYSTEM_ACTOR("api"),
    },
    { type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("executor") },
  ];
  for (let k = 0; k < readyCount; k++) {
    seed.push({
      type: "task.ready",
      payload: { nodeId: NODE_ID, branchPath: encodeBranch({ segments: [{ edgeId: "e0", index: k }] }), edgesIn: ["e0"] },
      actor: SYSTEM_ACTOR("scheduler"),
      taskId: branchTask(k),
    });
  }
  await log.append(seed);

  return {
    store,
    graph,
    clock,
    tick: (ms) => {
      clock.t += ms;
    },
    project: async () => {
      const events = [];
      for await (const e of store.read(RUN, 1)) events.push(e);
      return foldRun(events)!;
    },
  };
}

/**
 * One worker process.
 *
 * Its own `RunLog` on purpose: `RunLog` caches the head, and two workers sharing one
 * would share a cache no distributed deployment could give them.
 */
class Worker {
  readonly id: string;
  readonly committed: TaskId[] = [];
  /** Polls that returned a Task another worker already held. Must stay 0. */
  wastedPolls = 0;
  readonly #w: World;
  readonly #log: RunLog;
  readonly #scheduler: LeasedScheduler;
  readonly #maxParallelism: number;
  /** Tokens this worker was issued, so a "late" commit can carry a stale one. */
  readonly tokens = new Map<TaskId, number>();

  constructor(id: string, w: World, opts: { maxParallelism?: number; leaseMs?: number } = {}) {
    this.id = id;
    this.#w = w;
    this.#log = new RunLog(RUN, { store: w.store, now: () => w.clock.t });
    this.#scheduler = new LeasedScheduler({ leaseMs: opts.leaseMs ?? LEASE_MS });
    this.#maxParallelism = opts.maxParallelism ?? 1;
  }

  async poll(): Promise<readonly Runnable[]> {
    const projection = await this.#w.project();
    return this.#scheduler.select({
      projection,
      graph: this.#w.graph,
      nodes: NODES,
      maxParallelism: this.#maxParallelism,
      now: this.#w.clock.t,
      workerId: this.id,
    });
  }

  /** Append `task.leased`, fenced. Returns the token this worker now holds. */
  async lease(r: Runnable): Promise<number> {
    const projection = await this.#w.project();
    const held = projection.tasks[r.task.taskId]?.lease;
    if (held !== undefined && held.workerId !== this.id) this.wastedPolls++;
    // The token comes from the JOURNAL, not a counter: a second process starting at 0
    // would re-issue tokens the first process already used, and the fence would pass a
    // write it exists to refuse.
    const token = (held?.fencingToken ?? 0) + 1;
    this.tokens.set(r.task.taskId, token);
    await this.#log.append(
      [
        {
          type: "task.leased",
          payload: { workerId: this.id, attempt: r.task.attempt + 1 },
          actor: SYSTEM_ACTOR("scheduler"),
          taskId: r.task.taskId,
        },
      ],
      { taskId: r.task.taskId, fencingToken: token },
    );
    return token;
  }

  /** Append `task.committed`, fenced with the token given. Unconditional on seq. */
  async commit(taskId: TaskId, token: number = this.tokens.get(taskId)!): Promise<void> {
    await this.#log.append(
      [
        {
          type: "task.committed",
          payload: { status: "succeeded", writes: {}, take: [], usage: { ...ZERO_USAGE }, attempt: 1 },
          actor: SYSTEM_ACTOR("executor"),
          taskId,
        },
      ],
      { taskId, fencingToken: token },
    );
    this.committed.push(taskId);
  }
}

/** A journal writer that is nobody's worker — used to inject facts a worker did not. */
function makeLog(w: World): RunLog {
  return new RunLog(RUN, { store: w.store, now: () => w.clock.t });
}

// ---------------------------------------------------------------------------
// 1 · mutual exclusion
// ---------------------------------------------------------------------------

test("CONTENTION: a live lease is invisible to the other worker", async () => {
  const w = await world(2);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  const first = (await a.poll())[0]!;
  await a.lease(first);

  const bSaw = await b.poll();
  assert.equal(bSaw.length, 1, "B still has the OTHER Task to do");
  assert.notEqual(bSaw[0]!.task.taskId, first.task.taskId, "B must not be handed A's live work");
  assert.equal(b.wastedPolls, 0);
});

test("CONTENTION: with one Task and two workers, exactly one gets it", async () => {
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  await a.lease((await a.poll())[0]!);
  assert.deepEqual(await b.poll(), [], "there is nothing left that is B's to take");
});

test("CONTENTION: a RETRYING Task is still A's while A's lease is live", async () => {
  // The shape where the lease is the ONLY thing standing between the two workers. Every
  // other case is carried by `state`, which is why this one is easy to leave untested:
  // `task.ready` puts the Task back in the queue that `eligible()` reads, and A's lease
  // is all that says the retry is A's to run.
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  const t = (await a.poll())[0]!;
  await a.lease(t);
  await makeLog(w).append(
    [
      {
        type: "task.retry_scheduled",
        payload: { attempt: 1, afterMs: 100, code: "E_TOOL_FAILED" },
        actor: SYSTEM_ACTOR("executor"),
        taskId: t.task.taskId,
      },
      {
        type: "task.ready",
        payload: { nodeId: NODE_ID, branchPath: encodeBranch(t.task.branch), edgesIn: ["e0"] },
        actor: SYSTEM_ACTOR("scheduler"),
        taskId: t.task.taskId,
      },
    ],
    { taskId: t.task.taskId },
  );

  w.tick(200); // past the backoff, nowhere near the lease deadline
  const p = await w.project();
  assert.equal(p.tasks[t.task.taskId]!.state, "ready", "it is back in the queue …");
  assert.equal((await a.poll()).length, 1, "… and A, which still holds it, takes its own retry");
  assert.deepEqual(await b.poll(), [], "but B must not race A for the retry");
});

test("CONTENTION: a GATE-RESOLVED Task is still A's while A's lease is live", async () => {
  // Same shape from the other direction: `gate.decided` returns the Task to `ready` so
  // its holder can apply the decision. A second worker grabbing it re-runs the node the
  // human just approved — under the exact posture that exists to prevent surprises.
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  const t = (await a.poll())[0]!;
  await a.lease(t);
  const log = makeLog(w);
  await log.append(
    [
      {
        type: "gate.raised",
        payload: {
          gateId: "gate_1" as never,
          nodeId: NODE_ID,
          policyRef: "oversight/x@stable",
          contentDigest: "sha256:0",
        },
        actor: SYSTEM_ACTOR("policy"),
        taskId: t.task.taskId,
      },
    ],
    { taskId: t.task.taskId },
  );
  await log.append([
    {
      type: "gate.decided",
      payload: { gateId: "gate_1" as never, decision: "approve", latencyMs: 0 },
      actor: { kind: "human", subject: "ops", via: "console" },
    },
  ]);

  assert.equal((await w.project()).tasks[t.task.taskId]!.state, "ready");
  assert.deepEqual(await b.poll(), [], "the approval was for A's Task, and A still holds it");
  assert.equal((await a.poll()).length, 1);
});

// ---------------------------------------------------------------------------
// 2 · reclaim after expiry
// ---------------------------------------------------------------------------

test("CONTENTION: a worker that DIES holding a Task does not strand it", async () => {
  // The shape a hand-built projection never had: A leases and never commits, so the
  // fold leaves the Task in `leased` — a state `eligible()` filters out — FOREVER.
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  const t = (await a.poll())[0]!;
  await a.lease(t);
  // A dies here.

  const p = await w.project();
  assert.equal(p.tasks[t.task.taskId]!.state, "leased", "the real fold does NOT leave it `ready`");

  assert.deepEqual(await b.poll(), [], "still held, so B waits");
  w.tick(LEASE_MS + 1);
  const reclaimed = await b.poll();
  assert.deepEqual(
    reclaimed.map((r) => r.task.taskId),
    [t.task.taskId],
    "once the lease lapses the Task is B's to take, or it is stranded for good",
  );
});

test("CONTENTION: a reclaimed Task still respects its retry backoff", async () => {
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);
  const t = (await a.poll())[0]!;
  await a.lease(t);

  // A failed and rescheduled, then died before re-leasing. This is the executor's own
  // batch, verbatim: `task.retry_scheduled` + `task.ready`. The lease and the backoff
  // both survive the fold, so the Task is `ready` AND still attributed to A.
  const log = makeLog(w);
  await log.append(
    [
      {
        type: "task.retry_scheduled",
        payload: { attempt: 1, afterMs: 60_000, code: "E_TOOL_FAILED" },
        actor: SYSTEM_ACTOR("executor"),
        taskId: t.task.taskId,
      },
      {
        type: "task.ready",
        payload: { nodeId: NODE_ID, branchPath: encodeBranch(t.task.branch), edgesIn: ["e0"] },
        actor: SYSTEM_ACTOR("scheduler"),
        taskId: t.task.taskId,
      },
    ],
    { taskId: t.task.taskId },
  );
  assert.equal((await w.project()).tasks[t.task.taskId]!.state, "ready");

  w.tick(LEASE_MS + 1);
  assert.deepEqual(await b.poll(), [], "the lease lapsed but the backoff has not");
  w.tick(60_000);
  assert.equal((await b.poll()).length, 1, "and once it has, B may take it");
});

// ---------------------------------------------------------------------------
// 3 · the fencing token actually fences
// ---------------------------------------------------------------------------

test("CONTENTION: a reclaimed lease's fencing token is STRICTLY greater", async () => {
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  const tokenA = await a.lease((await a.poll())[0]!);
  w.tick(LEASE_MS + 1);
  const tokenB = await b.lease((await b.poll())[0]!);

  assert.ok(tokenB > tokenA, `reclaimed token ${tokenB} must exceed ${tokenA}`);
});

test("CONTENTION: the DEAD worker's late commit is REFUSED, not merely noticed", async () => {
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  const t = (await a.poll())[0]!.task.taskId;
  const tokenA = await a.lease((await a.poll())[0]!);
  w.tick(LEASE_MS + 1);
  await b.lease((await b.poll())[0]!);

  // A was not dead, only slow — it finished after its lease lapsed and B took over.
  // Its commit carries a token below the highest the store has seen for this Task.
  await assert.rejects(
    () => a.commit(t, tokenA),
    (e: { code?: string }) => e.code === CODES.E_FENCING_STALE,
    "a stale holder must not be able to write the outcome of work someone else now owns",
  );

  // And B, holding the current lease, still can.
  await b.commit(t);
  const p = await w.project();
  assert.equal(p.tasks[t]!.state, "succeeded");
});

test("CONTENTION: fencing does not depend on WHO writes, only on the token", async () => {
  // A worker that restarts under the same id is still stale if its token is.
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);
  const t = (await a.poll())[0]!.task.taskId;
  const stale = await a.lease((await a.poll())[0]!);
  w.tick(LEASE_MS + 1);
  await b.lease((await b.poll())[0]!);

  const revived = new Worker("wa", w);
  await assert.rejects(
    () => revived.commit(t, stale),
    (e: { code?: string }) => e.code === CODES.E_FENCING_STALE,
  );
});

// ---------------------------------------------------------------------------
// 4 · no starvation
// ---------------------------------------------------------------------------

test("CONTENTION: over 20 Tasks neither worker starves and nothing runs twice", async () => {
  const TASKS = 20;
  const w = await world(TASKS);
  const a = new Worker("wa", w, { maxParallelism: 2 });
  const b = new Worker("wb", w, { maxParallelism: 2 });

  // A polls first every round — the adversarial order, since the wave is deterministic
  // and A therefore always has first pick of the same ordering B is about to see.
  for (let round = 0; round < 20; round++) {
    for (const worker of [a, b]) {
      const wave = await worker.poll();
      for (const r of wave) await worker.lease(r);
      for (const r of wave) await worker.commit(r.task.taskId);
    }
    w.tick(1);
  }

  const all = [...a.committed, ...b.committed];
  assert.equal(all.length, TASKS, "every Task ran");
  assert.equal(new Set(all).size, TASKS, "and none of them ran twice");
  assert.equal(a.wastedPolls + b.wastedPolls, 0, "neither worker burned a round on work it could not have");
  assert.ok(
    Math.min(a.committed.length, b.committed.length) >= TASKS * 0.4,
    `share was ${a.committed.length}/${b.committed.length}; a worker below 40% is being starved`,
  );
});

test("CONTENTION: a SLOW worker holding leases does not block the fast one", async () => {
  // The starvation shape that matters: A takes work and sits on it. B must keep finding
  // work every round rather than spinning on Tasks A holds.
  const TASKS = 12;
  const w = await world(TASKS);
  const a = new Worker("wa", w, { maxParallelism: 2, leaseMs: 1_000_000 });
  const b = new Worker("wb", w, { maxParallelism: 2 });

  const progress: number[] = [];
  for (let round = 0; round < 3; round++) {
    for (const r of await a.poll()) await a.lease(r); // leases, never commits
    const wave = await b.poll();
    for (const r of wave) await b.lease(r);
    for (const r of wave) await b.commit(r.task.taskId);
    progress.push(b.committed.length);
  }

  assert.deepEqual(progress, [2, 4, 6], "B commits its full wave every round while A hoards");
  assert.equal(b.wastedPolls, 0);
});

// ---------------------------------------------------------------------------
// 5 · the boundary
// ---------------------------------------------------------------------------

test("CONTENTION: a lease expiring exactly AT `now` is LIVE", async () => {
  // Both answers are defensible; they are not symmetric. Calling a live lease dead
  // double-executes a Task that may already have sent the email. Calling a dead one
  // live costs one poll interval. Ambiguity resolves toward the cheaper mistake.
  const w = await world(1);
  const a = new Worker("wa", w);
  const b = new Worker("wb", w);

  const leasedAt = w.clock.t;
  await a.lease((await a.poll())[0]!);

  w.clock.t = leasedAt + LEASE_MS;
  assert.deepEqual(await b.poll(), [], "at the deadline exactly, the lease is still A's");

  w.clock.t = leasedAt + LEASE_MS + 1;
  assert.equal((await b.poll()).length, 1, "one tick past it, and only then, B may reclaim");
});

test("CONTENTION: a worker does not reclaim its OWN live lease", async () => {
  // Which is the same boundary from the other side: in-process, a `leased` Task the
  // fold still attributes to this worker is one this worker is running RIGHT NOW.
  const w = await world(1);
  const a = new Worker("wa", w);

  await a.lease((await a.poll())[0]!);
  assert.deepEqual(await a.poll(), [], "re-selecting it would double-execute it in one process");

  w.tick(LEASE_MS + 1);
  assert.equal((await a.poll()).length, 1, "after a restart and an expiry, resuming it is correct");
});
