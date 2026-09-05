/**
 * THE TWO BOUNDS IN `run/gates.ts` WHOSE FAILURE IS A HANG, NOT A WRONG ANSWER.
 *
 * `resolve`'s `MAX_DECISION_LAPS` and the sweep cursor's re-fold progress check are both
 * deliberate, both carry a paragraph of reasoning, and both could be deleted with the whole
 * suite green. That is not an accident of coverage: `node --test` runs with no timeout, so
 * the failure each one prevents does not turn a test red — it stops the process. A guard
 * whose absence CI cannot report is a guard the next refactor deletes.
 *
 * SO BOTH DOUBLES ARE BOUNDED LIARS, and that is the whole technique here. A store that
 * conflicts forever, or a journal that never folds past its marker, would hang the mutated
 * build too and prove nothing. Each double misbehaves for strictly MORE laps than the bound
 * allows and then behaves, so the guarded build refuses at the bound and the unguarded one
 * runs on and succeeds. Both terminate; the two outcomes differ; the difference is the
 * guard.
 *
 * Nothing here reads a clock, sleeps, or races: the lap counter is driven by a store fake.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CODES, err, isLoomError } from "../../src/errors.ts";
import { newRunId, type NodeId, type RunId, type Seq, type TaskId } from "../../src/ids.ts";
import type { Actor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { AppendInput, AppendResult, RunFilter, RunSummary, StateStore } from "../../src/journal/store.ts";
import { GateSweeper, HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";

const NOW = 1_700_000_000_000;
const now = (): number => NOW;

const alice: Actor = { kind: "human", subject: "u:alice", via: "api" };

function request(runId: RunId): GateRequest {
  return {
    runId,
    taskId: "approve@root#0" as TaskId,
    nodeId: "approve" as NodeId,
    policyRef: "oversight/restart-pod@stable",
    payload: { host: "web-1" },
    approvers: ["u:alice"],
    allowEdit: [],
  };
}

// ---------------------------------------------------------------------------
// `resolve` — the lap bound on the conditional commit
// ---------------------------------------------------------------------------

/**
 * A real store whose `append` loses the compare-and-swap a bounded number of times.
 *
 * `resolve` re-projects and re-commits on every `E_SEQ_CONFLICT`, which is what makes the
 * decision path safe against two people answering the same gate in the same instant. The
 * bound is what keeps a run whose head simply KEEPS MOVING — a busy run with a sweeper
 * appending `gate.delivered` rows — from turning a refusal into an unbounded loop inside an
 * HTTP handler.
 */
class ConflictingStore implements StateStore {
  conflictsLeft = 0;
  attempts = 0;
  readonly inner: MemoryStateStore;
  constructor(inner: MemoryStateStore) {
    this.inner = inner;
  }
  async append(input: AppendInput): Promise<AppendResult> {
    this.attempts++;
    if (this.conflictsLeft > 0) {
      this.conflictsLeft--;
      throw err.conflict(CODES.E_SEQ_CONFLICT, `head moved under attempt ${this.attempts}`);
    }
    return this.inner.append(input);
  }
  read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    return this.inner.read(runId, fromSeq, toSeq);
  }
  head(runId: RunId): Promise<Seq> {
    return this.inner.head(runId);
  }
  listRuns(limit?: number, filter?: RunFilter): Promise<readonly RunSummary[]> {
    return this.inner.listRuns(limit, filter);
  }
  close(): void {
    this.inner.close();
  }
}

/** D3's bound, pinned from OUTSIDE: `MAX_DECISION_LAPS` is module-private in `run/gates.ts`. */
const LAPS = 8;

test("`resolve` GIVES UP AFTER A BOUNDED NUMBER OF LAPS, rather than spinning inside a handler", async () => {
  const inner = new MemoryStateStore({ now });
  const store = new ConflictingStore(inner);
  const runId = newRunId(NOW);
  const broker = new HumanGateBroker({ now });
  const log = new RunLog(runId, { store, now });
  const gateId = await broker.raise(log, request(runId));

  // MORE CONFLICTS THAN THE BOUND ALLOWS, and then peace — so a build with the bound
  // deleted finishes rather than hanging, and finishes DIFFERENTLY.
  store.conflictsLeft = LAPS * 4;
  store.attempts = 0;

  await assert.rejects(
    () => broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" }),
    (e: unknown): true => {
      assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
      assert.equal(e.code, CODES.E_SEQ_CONFLICT, e.message);
      assert.match(e.message, /could not be decided in 8 attempts/, e.message);
      return true;
    },
  );
  assert.equal(store.attempts, LAPS, "exactly the laps the bound allows, and not one more");

  // A REFUSAL IS NOT A DECISION. Nothing landed, so nothing may be remembered as landed:
  // the idempotency entry is removed on every losing lap, and the gate is still open for
  // the approver to answer.
  const stillOpen = await broker.project(log);
  assert.equal(stillOpen?.gates[gateId]?.state, "open", "the gate is exactly as answerable as before");

  // THE ORDINARY HALF, and it is the reason the bound is 8 rather than 1: a decision that
  // loses the race a few times still lands, on the same idempotency key, without the
  // caller doing anything.
  store.conflictsLeft = LAPS - 1;
  store.attempts = 0;
  const out = await broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  assert.deepEqual(out, { resolved: true }, "seven lost races and the eighth lands");
  assert.equal(store.attempts, LAPS, "…having used every lap it was given");
  const decided = await broker.project(log);
  assert.equal(decided?.gates[gateId]?.state, "decided");
  assert.equal(decided?.gates[gateId]?.decision, "approve");
});

// ---------------------------------------------------------------------------
// The sweep cursor — the progress check on the re-fold
// ---------------------------------------------------------------------------

/**
 * A journal that answers every read with a rewind marker the folder has not seen before.
 *
 * `RunFolder` promises that a re-push converges: it KEEPS the ranges it has been told about
 * across `restart()`, so each pass learns at least one new marker and a journal holds
 * finitely many. `#catchUp`'s `while (folder.stale)` loop rests entirely on that promise,
 * and its docstring says so — a wedged tick is the worst failure available in the gate
 * clock, because it stops every OTHER run's SLA too, silently, in a background timer nobody
 * is watching. So the loop MEASURES the promise instead of assuming it.
 *
 * This store is the promise broken: `atSeq` moves every read, so every pass learns a range
 * that is new, goes stale again, and never advances `lastSeq`. `settleAfter` is what keeps
 * an unguarded build from hanging — after that many reads the journal becomes ordinary.
 */
class NeverFoldingStore implements StateStore {
  reads = 0;
  readonly runId: RunId;
  readonly settleAfter: number;
  constructor(runId: RunId, settleAfter: number) {
    this.runId = runId;
    this.settleAfter = settleAfter;
  }
  async append(): Promise<AppendResult> {
    throw new Error("this test never appends");
  }
  read(runId: RunId, _fromSeq: Seq): AsyncIterable<JournalEvent> {
    this.reads++;
    // A NEW RANGE EVERY READ while it is lying, so `RunFolder.#learn` keeps saying "new"
    // and the fold keeps stopping at seq 1 without ever folding past it. After that it
    // answers with an ordinary event, which is what lets an UNGUARDED build terminate.
    const e: JournalEvent =
      this.reads <= this.settleAfter
        ? ({
            runId,
            seq: 1 as Seq,
            ts: NOW,
            type: "checkpoint.restored",
            payload: { checkpointId: "cp_x", mode: "rewind", atSeq: this.reads, reason: "probe" },
            actor: { kind: "system", component: "replay" },
            classification: "internal",
          } as unknown as JournalEvent)
        : ({
            runId,
            seq: 1 as Seq,
            ts: NOW,
            type: "run.resumed",
            payload: { by: "operator" },
            actor: { kind: "system", component: "replay" },
            classification: "internal",
          } as unknown as JournalEvent);
    return (async function* () {
      yield e;
    })();
  }
  async head(): Promise<Seq> {
    return 1 as Seq;
  }
  async listRuns(): Promise<readonly RunSummary[]> {
    return [{ runId: this.runId, headSeq: 1 as Seq, firstTs: NOW, lastTs: NOW }];
  }
  close(): void {}
}

test("A SWEEP TICK THAT CANNOT FOLD PAST A REWIND MARKER REFUSES, rather than wedging the gate clock", async () => {
  const runId = newRunId(NOW);
  // Settles far later than the guard would ever allow, so an unguarded build terminates —
  // and terminates with a different answer.
  const store = new NeverFoldingStore(runId, 32);
  const sweeper = new GateSweeper({ store, broker: new HumanGateBroker({ now }), now });

  const report = await sweeper.sweep(NOW);

  // THE REFUSAL REACHES THE CALLER AS `failed`, which is the shape the outer loop is built
  // for: one run must not abort the tick, and a run that cannot be folded is counted rather
  // than silently skipped.
  assert.equal(report.failed, 1, "the run is reported as failed, not swept and not silently dropped");
  assert.equal(report.swept, 0, "nothing was swept: the fold never produced a projection");
  assert.deepEqual(report.fired, [], "and no gate was fired off a projection that does not exist");
  assert.equal(report.considered, 1);
  // TWO READS AND NO MORE: the tail, then one re-fold pass that made no progress. A third
  // read would mean the loop had gone round again on a folder that had not moved.
  assert.equal(store.reads, 2, "it stops on the second pass that gained nothing, not on the thirty-second");
});

test("AND AN HONEST REWIND STILL FOLDS THROUGH — the ordinary half of the same loop", async () => {
  // The bound above must not be satisfiable by a tick that refuses everything. A journal
  // whose marker is REAL — one range, learned once — converges on the pass after it, which
  // is exactly what `RunFolder` keeps its suppressed ranges across `restart()` for.
  const runId = newRunId(NOW);
  const store = new NeverFoldingStore(runId, 1);
  const sweeper = new GateSweeper({ store, broker: new HumanGateBroker({ now }), now });

  const report = await sweeper.sweep(NOW);
  assert.equal(report.failed, 0, "a marker the folder can learn is not a livelock");
  assert.equal(report.considered, 1);
  assert.equal(store.reads, 2, "the tail, then the one re-fold the marker asked for");
});

test("AND A JOURNAL WITH NO MARKER AT ALL COSTS ONE READ", async () => {
  const runId = newRunId(NOW);
  const store = new NeverFoldingStore(runId, 0);
  const sweeper = new GateSweeper({ store, broker: new HumanGateBroker({ now }), now });

  const report = await sweeper.sweep(NOW);
  assert.equal(report.failed, 0);
  assert.equal(store.reads, 1, "no marker, no re-fold");
});
