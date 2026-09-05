/**
 * `RunFolder.push` skips an event whose seq it has already folded, and the guard is load-bearing.
 *
 * THE TEST THAT EXISTED COULD NOT FAIL. `THE INCREMENTAL FOLD IS IDEMPOTENT UNDER A RE-PUSHED
 * TAIL` in `test/run/gate-guards.test.ts` re-pushes a `run.started` + `task.committed` pair and
 * asserts the usage was counted once — and its comment says "`usage` is the accumulating field,
 * so it is the one that shows". That is backwards for the event it chose. `task.committed` charges
 * through `chargeUsage(p, taskId, excessUsage(p.usageSeen[taskId], stated))`, and on the second
 * application `usageSeen` already equals the stated amount, so `excessUsage` returns zero: the
 * restatement is idempotent BY CONSTRUCTION and the guard is invisible to it. Deleting
 * `if (e.seq <= this.#lastSeq) continue;` leaves that test — and the whole suite — green.
 *
 * `model.called` and `subgraph.completed` are the two arms that call `chargeUsage` with the RAW
 * payload, so they are the ones that double-count. Both are here.
 *
 * WHY IT MATTERS RATHER THAN BEING TIDY: `PolicyEngine.restore` re-seeds `spentUsd` and
 * `spentTokens` from this projection on every attach, so a reader whose cursor overlaps by one
 * event inflates the run's spend and starves it of the budget it has not used.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, TaskId } from "../../src/ids.ts";
import { RunFolder, foldRun } from "../../src/run/projection.ts";

const RUN = "run_perf_lane_dedup" as RunId;
const TASK = "work@root#0" as TaskId;

function journal(...rows: readonly { type: string; payload: unknown; taskId?: string }[]): JournalEvent[] {
  return rows.map(
    (r, i) =>
      ({
        seq: i + 1,
        runId: RUN,
        ts: 1_700_000_000_000 + i,
        actor: { kind: "system", id: "dedup" },
        type: r.type,
        payload: r.payload,
        classification: "internal",
        ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
      }) as unknown as JournalEvent,
  );
}

const usage = { inputTokens: 100, outputTokens: 40, costUsd: 0.25, wallMs: 12 };

test("A RE-PUSHED `model.called` IS COUNTED ONCE — the dedup guard, on an arm that accumulates", () => {
  const evs = journal(
    { type: "run.started", payload: { posture: "out" } },
    { type: "model.called", payload: { model: "m", usage, attempt: 1 }, taskId: TASK },
  );

  const folder = new RunFolder();
  folder.push(evs);
  folder.push(evs); // the same tail, a second time — an overlapping cursor
  const p = folder.projection()!;

  assert.equal(p.usage.costUsd, 0.25, "ONE model call, charged once");
  assert.equal(p.usage.inputTokens, 100, "…and its tokens once");
  assert.deepEqual(p.usage, foldRun(evs)!.usage, "the incremental fold agrees with the full one");
});

test("…and so is a re-pushed `subgraph.completed`, the other raw-payload arm", () => {
  const evs = journal(
    { type: "run.started", payload: { posture: "out" } },
    { type: "subgraph.completed", payload: { ref: "subgraph/child@stable", childRunId: "run_child", status: "succeeded", outputs: {}, usage }, taskId: TASK },
  );

  const folder = new RunFolder();
  folder.push(evs);
  folder.push(evs);
  const p = folder.projection()!;

  assert.equal(p.usage.costUsd, 0.25, "ONE child run, charged once");
  assert.deepEqual(p.usage, foldRun(evs)!.usage);
});

test("AN OVERLAPPING TAIL IS THE REAL SHAPE: seq 1..3, then seq 2..4", () => {
  // Every caller in `src/` reads from `lastSeq + 1`, so nothing exercises the guard today. This
  // is what the day one of them overlaps by a single event looks like, and it is the reason the
  // guard is not decoration: the overlap is a READ pattern, not a journal fault.
  const evs = journal(
    { type: "run.started", payload: { posture: "out" } },
    { type: "model.called", payload: { model: "m", usage, attempt: 1 }, taskId: TASK },
    { type: "model.called", payload: { model: "m", usage, attempt: 2 }, taskId: TASK },
    { type: "task.committed", payload: { status: "succeeded", writes: {}, take: [], usage, attempt: 1 }, taskId: TASK },
  );

  const folder = new RunFolder();
  folder.push(evs.slice(0, 3));
  folder.push(evs.slice(1)); // re-serves seq 2 and 3
  const p = folder.projection()!;

  assert.equal(p.usage.costUsd, 0.5, "two model calls, each charged once");
  assert.deepEqual(p.usage, foldRun(evs)!.usage, "and the two folds still agree");
  assert.equal(folder.lastSeq, 4, "the folder reached the head");
});

test("THE ORDINARY HALF: two DISTINCT model calls still charge twice", () => {
  // The guard skips by SEQ, not by content. Two calls that happen to bill the same amount are
  // two calls, and a fix that deduped on the payload would quietly under-charge every retry.
  const evs = journal(
    { type: "run.started", payload: { posture: "out" } },
    { type: "model.called", payload: { model: "m", usage, attempt: 1 }, taskId: TASK },
    { type: "model.called", payload: { model: "m", usage, attempt: 2 }, taskId: TASK },
  );

  const folder = new RunFolder();
  folder.push(evs);
  const p = folder.projection()!;

  assert.equal(p.usage.costUsd, 0.5, "identical bills, both charged");
  assert.equal(p.usage.inputTokens, 200);
  assert.deepEqual(p.usage, foldRun(evs)!.usage);
});
