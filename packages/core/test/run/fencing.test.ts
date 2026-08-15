/**
 * A worker whose lease was taken cannot commit over the worker that took it.
 *
 * Every part of this existed and none of it was connected: `RunLog.append`/`commit`
 * accept a `fencingToken`, `SqliteStateStore.append` compares it against `task_fence`'s
 * `max_token` and raises, and `E_LEASE_LOST`/`E_FENCING_STALE` are declared in
 * `errors.ts`. The engine minted a token, journaled it, and never presented it — so the
 * check had no input and `E_FENCING_STALE` had no thrower.
 *
 * The token could not be the process-local counter it was minted from. A second process
 * starts its counter at 1 and would lose to the first's `max_token`, so arming that would
 * fence the LEGITIMATE worker. The journal's seq is the one monotonic value every process
 * shares — the store's compare-and-set assigns it — so the lease's own seq is the token.
 *
 * This matters now because the maintainer chose multi-process workers on one device.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SYSTEM_ACTOR, type NewEvent } from "../../src/journal/events.ts";
import type { RunId, TaskId } from "../../src/ids.ts";

const TASK = "n@root#0" as TaskId;

const lease = (worker: string, attempt: number): NewEvent => ({
  type: "task.leased",
  payload: { workerId: worker, attempt, fencingToken: attempt },
  actor: SYSTEM_ACTOR("scheduler"),
  taskId: TASK,
});
const work = (): NewEvent => ({
  type: "task.progress",
  payload: { chunk: "x" },
  actor: SYSTEM_ACTOR("executor"),
  taskId: TASK,
});

test("THE STORE REFUSES A STALE LEASE — a re-leased Task cannot be written by its old holder", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const runId = "run_fence" as RunId;

  // Each worker's token is the seq of ITS OWN lease — which it only knows once the append
  // returns, which is why the engine records it at that moment rather than minting it.
  const a = await store.append({ runId, expectedSeq: 0, taskId: TASK, events: [lease("A", 1)] });
  const b = await store.append({ runId, expectedSeq: a.seq, taskId: TASK, events: [lease("B", 2)] });
  assert.ok(b.seq > a.seq, "the later lease necessarily carries the higher token");

  // B, the current holder, commits its work and thereby raises the fence.
  const committed = await store.append({
    runId,
    expectedSeq: b.seq,
    taskId: TASK,
    fencingToken: b.seq,
    events: [work()],
  });

  // A finishes and writes under the lease it no longer holds.
  await assert.rejects(
    () => store.append({ runId, expectedSeq: committed.seq, taskId: TASK, fencingToken: a.seq, events: [work()] }),
    /fenc|stale|lease/i,
    "a worker whose lease was taken must not be able to write under it",
  );
});

test("the holder of the CURRENT lease still writes normally", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const runId = "run_ok" as RunId;

  const leased = await store.append({ runId, expectedSeq: 0, taskId: TASK, events: [lease("A", 1)] });
  // A fence that refuses everybody is indistinguishable from a broken engine.
  const after = await store.append({
    runId,
    expectedSeq: leased.seq,
    taskId: TASK,
    fencingToken: leased.seq,
    events: [work()],
  });
  assert.ok(after.seq > leased.seq);
});
