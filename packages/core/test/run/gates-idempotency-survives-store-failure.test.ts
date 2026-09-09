/**
 * A0.24 — `HumanGateBroker#resolveOnce` must not remember a decision that never landed.
 *
 * The idempotency entry is written BEFORE `log.commit`, so it can be answered while the write
 * is in flight (`gates.ts`'s own comment: "the idempotency entry ... must exist while the write
 * is in flight"). Its `catch` used to delete that entry only when the thrown error was
 * `E_SEQ_CONFLICT` — every OTHER throw from `log.commit` (a store outage, a disk error, any
 * failure that is not a lost compare-and-swap) left the entry behind, against the comment two
 * lines above it: "NOTHING LANDED, so nothing may be remembered as landed." A retry of the same
 * idempotency key then read `{ resolved: false }` from the stale entry instead of actually
 * committing, so the caller's decision was silently inert for the rest of the process's life —
 * it self-heals only on restart, because the map is rebuilt by folding the journal, which holds
 * no `gate.decided` event for the failed attempt.
 *
 * This suite drives a store whose `append` throws an ordinary (non-`E_SEQ_CONFLICT`) error on
 * the first call and succeeds after, and checks that a SECOND `resolve()` with the same
 * `idempotencyKey` actually commits rather than answering from a stale map entry.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { newRunId, type NodeId, type RunId, type Seq, type TaskId } from "../../src/ids.ts";
import type { Actor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { AppendInput, AppendResult, RunFilter, RunSummary, StateStore } from "../../src/journal/store.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
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

/** A store whose `append` fails with an ORDINARY error — never `E_SEQ_CONFLICT` — N times. */
class FaultyStore implements StateStore {
  failures = 0;
  attempts = 0;
  readonly inner: MemoryStateStore;
  constructor(inner: MemoryStateStore) {
    this.inner = inner;
  }
  async append(input: AppendInput): Promise<AppendResult> {
    this.attempts++;
    if (this.failures > 0) {
      this.failures--;
      throw new Error("sqlite: disk I/O error");
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

test("a repeat delivery AFTER A STORE FAILURE actually commits, rather than answering from a stale idempotency entry", async () => {
  const inner = new MemoryStateStore({ now });
  const store = new FaultyStore(inner);
  const runId = newRunId(NOW);
  const broker = new HumanGateBroker({ now });
  const log = new RunLog(runId, { store, now });
  const gateId = await broker.raise(log, request(runId));

  // FIRST DELIVERY: the commit throws a non-`E_SEQ_CONFLICT` error. `resolve()` does not
  // retry a plain throw (only `E_SEQ_CONFLICT` re-laps), so it propagates.
  store.failures = 1;
  await assert.rejects(
    () => broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" }),
    /disk I\/O error/,
  );

  // NOTHING LANDED: the gate is still open.
  const afterFailure = await broker.project(log);
  assert.equal(afterFailure?.gates[gateId]?.state, "open", "the failed commit journaled nothing");

  // SECOND DELIVERY, same idempotency key, store now healthy. Before the fix this read the
  // stale idempotency entry and answered `{ resolved: false }` without ever calling `append`
  // again — the decision was inert for the life of the process. After the fix it actually
  // commits.
  const out = await broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  assert.deepEqual(out, { resolved: true }, "the retry must actually land the decision");

  const decided = await broker.project(log);
  assert.equal(decided?.gates[gateId]?.state, "decided", "the gate is decided, not stuck open forever");
  assert.equal(decided?.gates[gateId]?.decision, "approve");
});

test("THE ORDINARY HALF: a repeat delivery after a SUCCESSFUL commit still answers idempotently", async () => {
  const inner = new MemoryStateStore({ now });
  const store = new FaultyStore(inner);
  const runId = newRunId(NOW);
  const broker = new HumanGateBroker({ now });
  const log = new RunLog(runId, { store, now });
  const gateId = await broker.raise(log, request(runId));
  const afterRaise = store.attempts;

  const first = await broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  assert.deepEqual(first, { resolved: true });
  assert.equal(store.attempts, afterRaise + 1);

  // A repeat of the SAME idempotency key must not append a second time.
  const second = await broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  assert.deepEqual(second, { resolved: false }, "already-decided repeat answers from the idempotency entry");
  assert.equal(store.attempts, afterRaise + 1, "no second append for the same idempotency key");
});
