/**
 * THE GATE QUEUE'S SECOND FOLD, AND THE ONE THING A FOLD CACHE MAY NEVER DO.
 *
 * `HumanGateBroker.project` re-read every event of a run from seq 1 on every call. `GET /gates`
 * calls it once per candidate run per poll — through `engine.openGates` — on a journal the
 * same handler has already folded incrementally one line earlier. Measured on 8 runs each
 * parked on an open gate: 1,056 journal events read on poll #1 and 1,056 again on poll #2, all
 * of them from that second fold, on a console that polls every four seconds.
 *
 * It now folds FORWARD from where it left off, which makes the second poll free. The whole
 * risk of that lives in one sentence: **a cache on the oversight queue that can hide a
 * question is a denial of oversight, in the route that exists to prevent one.** So the tests
 * that matter here are not the cheap ones. They are:
 *
 *   - a gate raised AFTER a cached fold is in the very next answer;
 *   - so is a gate DECIDED after one, and an expiry, and a cancel;
 *   - a rewind that re-opens a decided gate re-opens it for this reader too;
 *   - the cached fold and a cold full fold agree, event for event.
 *
 * Reads are counted through a store wrapper, so the cost claims here are measurements rather
 * than descriptions. Nothing reads a clock.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { newRunId, type CheckpointId, type GateId, type NodeId, type RunId, type Seq, type TaskId } from "../../src/ids.ts";
import type { Actor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { AppendInput, AppendResult, RunFilter, RunSummary, StateStore } from "../../src/journal/store.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { foldRun } from "../../src/run/projection.ts";

const NOW = 1_700_000_000_000;

const alice: Actor = { kind: "human", subject: "u:alice", via: "api" };

/** A real store that counts the events it hands out. */
class CountingStore implements StateStore {
  events = 0;
  readonly inner: MemoryStateStore;
  constructor(inner: MemoryStateStore) {
    this.inner = inner;
  }
  append(input: AppendInput): Promise<AppendResult> {
    return this.inner.append(input);
  }
  read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    const inner = this.inner.read(runId, fromSeq, toSeq);
    const self = this;
    return (async function* () {
      for await (const e of inner) {
        self.events++;
        yield e;
      }
    })();
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

interface Bench {
  readonly clock: { t: number };
  readonly store: CountingStore;
  readonly broker: HumanGateBroker;
  readonly log: RunLog;
  readonly runId: RunId;
}

function bench(): Bench {
  const clock = { t: NOW };
  const now = (): number => clock.t;
  const store = new CountingStore(new MemoryStateStore({ now }));
  const runId = newRunId(clock.t);
  return { clock, store, broker: new HumanGateBroker({ now }), log: new RunLog(runId, { store, now }), runId };
}

let seq = 0;
function request(b: Bench, over: Partial<GateRequest> = {}): GateRequest {
  seq += 1;
  return {
    runId: b.runId,
    taskId: `approve@root/f0[${seq}]#0` as TaskId,
    nodeId: "approve" as NodeId,
    policyRef: "oversight/restart-pod@stable",
    payload: { host: `web-${seq}` },
    approvers: ["u:alice"],
    allowEdit: [],
    ...over,
  };
}

const openIds = (gs: readonly { gateId: GateId; state: string }[]): readonly GateId[] =>
  gs.filter((g) => g.state === "open").map((g) => g.gateId).sort();

/** The same journal, folded cold by a broker that has never seen it. */
async function coldFold(b: Bench): Promise<readonly GateId[]> {
  const fresh = new HumanGateBroker({ now: () => b.clock.t });
  return openIds(await fresh.list(b.log));
}

test("A REPEAT POLL COSTS ONE EVENT, and the first one costs the journal exactly once", async () => {
  const b = bench();
  const one = await b.broker.raise(b.log, request(b));
  const two = await b.broker.raise(b.log, request(b));
  const total = await b.store.head(b.runId);
  assert.ok(total > 1, "there is a journal to re-read");

  // THE COLD BROKER IS THE RESTARTED PROCESS, and it is the poll `GET /gates` makes first.
  // It folds the run once, from seq 1 — which is what `project` used to do on EVERY call.
  const cold = new HumanGateBroker({ now: () => b.clock.t });
  b.store.events = 0;
  assert.deepEqual(openIds(await cold.list(b.log)), [one, two].sort());
  assert.equal(b.store.events, total, "the whole journal, once");

  // ONE EVENT, NOT ZERO, and the one is the mark: `project` re-reads the last event it folded
  // to check this journal is still the one the fold describes. O(1) per poll rather than
  // O(history), and the price of a cache that cannot answer about somebody else's journal.
  b.store.events = 0;
  assert.deepEqual(openIds(await cold.list(b.log)), [one, two].sort());
  assert.equal(b.store.events, 1, "the second poll re-reads the mark and nothing else");

  b.store.events = 0;
  assert.deepEqual(openIds(await cold.list(b.log)), [one, two].sort());
  assert.equal(b.store.events, 1, "and so does the third — the cost is per EVENT, not per poll");
  assert.ok(total > 1, "…against a journal with more than one event in it");
});

test("A FOLD IS NEVER SERVED TO A JOURNAL THAT IS NOT THE ONE IT DESCRIBES", async () => {
  // The cache is keyed by run id, which is the only handle a `RunLog` offers, so a broker
  // handed logs over two DIFFERENT stores that both hold the same run id would — keyed on that
  // alone — answer about the wrong journal. Not a crash: the second caller would be handed the
  // FIRST journal's gates, for a run that never raised them, which is the cache inventing a
  // question. Nothing in `src/` does this (`Engine` builds its own broker; `replayRun` deletes
  // `gates` from the options it forwards), but "no caller does it" is a fact about callers, not
  // a property of the cache.
  const now = (): number => NOW;
  const runId = newRunId(NOW);
  const one = new CountingStore(new MemoryStateStore({ now }));
  const two = new CountingStore(new MemoryStateStore({ now }));
  const broker = new HumanGateBroker({ now });
  const logOne = new RunLog(runId, { store: one, now });
  const logTwo = new RunLog(runId, { store: two, now });

  const gateId = await broker.raise(logOne, {
    runId,
    taskId: "approve@root#0" as TaskId,
    nodeId: "approve" as NodeId,
    policyRef: "oversight/restart-pod@stable",
    payload: { host: "web-1" },
    approvers: ["u:alice"],
    allowEdit: [],
  });
  assert.deepEqual(openIds(await broker.list(logOne)), [gateId], "store one has the question");

  // THE SAME RUN ID, AN EMPTY JOURNAL. The answer is what that journal says, which is nothing.
  assert.equal(await broker.project(logTwo), undefined, "an empty journal folds to nothing");
  assert.deepEqual(await broker.list(logTwo), [], "and holds no gates at all");

  // AND THE FIRST JOURNAL IS UNDISTURBED — the check drops a fold, it does not corrupt one.
  assert.deepEqual(openIds(await broker.list(logOne)), [gateId]);

  // The same rule for a journal that CONTRADICTS the fold rather than lacking it: store two
  // now has an event at the marked seq, and it is a different event.
  await logTwo.append([{ type: "run.started", payload: { posture: "out" }, actor: alice }]);
  const folded = await broker.project(logTwo);
  assert.equal(folded?.status, "running", "store two's own history, folded from seq 1");
  assert.deepEqual(Object.keys(folded?.gates ?? {}), [], "and no gate borrowed from store one");
});

test("A GATE RAISED AFTER A CACHED POLL IS IN THE NEXT ONE — the only thing this cache may never do", async () => {
  const b = bench();
  const first = await b.broker.raise(b.log, request(b));
  assert.deepEqual(openIds(await b.broker.list(b.log)), [first], "poll #1, and the fold is now cached at this head");

  // RAISED AFTER THE CACHED SEQ, through the same broker.
  const late = await b.broker.raise(b.log, request(b));
  assert.deepEqual(openIds(await b.broker.list(b.log)), [first, late].sort(), "poll #2 shows the new question");
  assert.deepEqual(await coldFold(b), [first, late].sort(), "…and agrees with a cold full fold");

  // RAISED BY SOMEBODY ELSE, which is the case a per-process cache is actually at risk from:
  // a second plane over the same store, appending where this broker cannot see it happen.
  const other = new HumanGateBroker({ now: () => b.clock.t });
  const elsewhere = await other.raise(b.log, request(b));
  assert.deepEqual(openIds(await b.broker.list(b.log)), [first, late, elsewhere].sort(), "poll #3 shows that one too");
  assert.deepEqual(await coldFold(b), [first, late, elsewhere].sort());
});

test("AND A GATE ANSWERED AFTER A CACHED POLL LEAVES IT — in every way a gate can close", async () => {
  const b = bench();
  const decided = await b.broker.raise(b.log, request(b));
  const expired = await b.broker.raise(b.log, request(b, { slaMs: 1_000, onTimeout: "fail" }));
  const cancelled = await b.broker.raise(b.log, request(b));
  assert.deepEqual(openIds(await b.broker.list(b.log)), [decided, expired, cancelled].sort(), "three open questions");

  await b.broker.resolve(b.log, { gateId: decided, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  assert.deepEqual(openIds(await b.broker.list(b.log)), [expired, cancelled].sort(), "a decision is visible at once");

  b.clock.t = NOW + 60_000;
  await b.broker.sweepTimeouts(b.log, b.clock.t);
  assert.deepEqual(openIds(await b.broker.list(b.log)), [cancelled], "so is an expiry the clock wrote");

  // `gate.cancelled` is written by `Engine`, not by the broker — an operator cancel, or a run
  // that fails with siblings still open. It reaches this reader the same way everything else
  // does: as an event on the tail.
  await b.log.append([{ type: "gate.cancelled", payload: { gateId: cancelled, reason: "operator asked" }, actor: alice }]);
  assert.deepEqual(openIds(await b.broker.list(b.log)), [], "and so is a cancel written by somebody else");
  assert.deepEqual(await coldFold(b), [], "…all of it agreeing with a cold full fold");
});

test("A REWIND RE-OPENS A DECIDED GATE FOR THIS READER TOO, which is what makes the fold a fold", async () => {
  // The one shape an incremental fold cannot serve by reading forward: a `checkpoint.restored`
  // marker changes what events ALREADY FOLDED mean. `RunFolder` answers it by going stale and
  // re-folding from seq 1, keeping the ranges it has learned so the second pass converges.
  const b = bench();
  const gateId = await b.broker.raise(b.log, request(b));
  const raisedAt = (await b.broker.project(b.log))!.seq;
  await b.broker.resolve(b.log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  assert.deepEqual(openIds(await b.broker.list(b.log)), [], "answered, and the fold is cached that way");

  // The rewind hides everything after the raise, which puts the gate back to `open`.
  await b.log.append([
    {
      type: "checkpoint.restored",
      payload: { checkpointId: "cp_1" as CheckpointId, mode: "rewind", atSeq: raisedAt as Seq, reason: "ask again" },
      actor: alice,
    },
  ]);

  assert.deepEqual(openIds(await b.broker.list(b.log)), [gateId], "the question is back in the queue");
  assert.deepEqual(await coldFold(b), [gateId], "…exactly as a cold full fold reads the same journal");

  // AND IT IS ANSWERABLE AGAIN, which is the point of a rewind and the thing a stale fold
  // would refuse with `E_GATE_ALREADY_RESOLVED`.
  const out = await b.broker.resolve(b.log, {
    gateId,
    decision: { kind: "reject", reason: "asked again, answered differently" },
    actor: alice,
    idempotencyKey: "k2",
  });
  assert.deepEqual(out, { resolved: true });
  assert.deepEqual(openIds(await b.broker.list(b.log)), []);
});

test("THE CACHED FOLD AND A COLD FULL FOLD AGREE ON THE WHOLE PROJECTION, not just on the gates", async () => {
  // `project` is on the decision path — `resolve` commits at the `seq` it returns — so
  // "the gates look right" is not enough. This compares the whole thing, at every step of a
  // run's life, against `foldRun` over the same events.
  const b = bench();
  const checks: string[] = [];
  const agree = async (label: string): Promise<void> => {
    const events: JournalEvent[] = [];
    for await (const e of b.store.read(b.runId, 1 as Seq)) events.push(e);
    assert.deepEqual(await b.broker.project(b.log), foldRun(events), label);
    checks.push(label);
  };

  const a = await b.broker.raise(b.log, request(b));
  await agree("after a raise");
  await b.broker.claim(b.log, { gateId: a, actor: alice });
  await agree("after a claim");
  const c = await b.broker.raise(b.log, request(b));
  await agree("after a second raise");
  await b.broker.resolve(b.log, { gateId: a, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  await agree("after a decision");
  await b.log.append([{ type: "gate.cancelled", payload: { gateId: c, reason: "done" }, actor: alice }]);
  await agree("after a cancel");
  assert.equal(checks.length, 5);
  assert.ok(c !== a);
});

test("A FINISHED RUN IS NOT REMEMBERED, so the map does not grow with a deployment's history", async () => {
  // `raisedAGate` — the candidate set `GET /gates` and the sweeper both walk — accumulates for
  // the life of a deployment and most of what it holds is finished. Keeping those folds is the
  // one way this cache could grow without bound in the process that most needs it not to.
  const b = bench();
  await b.broker.raise(b.log, request(b));
  await b.log.append([{ type: "run.cancelled", payload: { clean: true, unknownEffects: [] }, actor: alice }]);

  const p = await b.broker.project(b.log);
  assert.equal(p?.status, "cancelled");

  b.store.events = 0;
  await b.broker.project(b.log);
  assert.ok(b.store.events > 0, "a terminal run is folded from seq 1 again rather than held");
});
