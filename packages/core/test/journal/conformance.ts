/**
 * One behavioural contract, run against every StateStore implementation.
 *
 * This file is the mechanical form of DoD item 7 — "swapping local → distributed
 * changes only implementations, never call sites". If the memory store and the
 * SQLite store both pass an identical suite, the interface is genuinely the
 * boundary; if one needs a special case, it isn't, and we find out here rather than
 * during a migration.
 *
 * Not named *.test.ts on purpose: it is a helper, invoked by the real test files.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES } from "../../src/errors.ts";
import { ROOT_BRANCH, taskId, type NodeId, type RunId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type NewEvent } from "../../src/journal/events.ts";
import type { StateStore } from "../../src/journal/store.ts";

export interface StoreFactory {
  readonly name: string;
  create(now: () => number): StateStore;
}

const RUN = "01JRUN0000000000000000000" as RunId;
const TASK = taskId("n" as NodeId, ROOT_BRANCH, 0);

function started(): NewEvent {
  return { type: "run.started", payload: { posture: "on" }, actor: SYSTEM_ACTOR("test") };
}

function progress(chunk: string): NewEvent {
  return { type: "task.progress", payload: { chunk }, actor: SYSTEM_ACTOR("test"), taskId: TASK };
}

async function drain(it: AsyncIterable<{ seq: number }>): Promise<number[]> {
  const out: number[] = [];
  for await (const e of it) out.push(e.seq);
  return out;
}

async function expectLoomError(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    assert.fail(`expected ${code}`);
  } catch (e) {
    assert.equal((e as { code?: string }).code, code, `expected ${code}, got: ${String(e)}`);
  }
}

export function runConformance(factory: StoreFactory): void {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const withStore = async (fn: (s: StateStore) => Promise<void>): Promise<void> => {
    const store = factory.create(now);
    try {
      await fn(store);
    } finally {
      store.close();
    }
  };

  test(`[${factory.name}] head of an unknown run is 0`, async () => {
    await withStore(async (s) => {
      assert.equal(await s.head("nope" as RunId), 0);
    });
  });

  test(`[${factory.name}] first append starts at seq 1 and numbers a batch contiguously`, async () => {
    await withStore(async (s) => {
      const r = await s.append({ runId: RUN, expectedSeq: 0, events: [started(), progress("a"), progress("b")] });
      assert.equal(r.seq, 3);
      assert.equal(await s.head(RUN), 3);
      assert.deepEqual(await drain(s.read(RUN, 1)), [1, 2, 3]);
    });
  });

  test(`[${factory.name}] a stale expectedSeq is rejected with E_SEQ_CONFLICT`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [started()] });
      await expectLoomError(
        () => s.append({ runId: RUN, expectedSeq: 0, events: [progress("dup")] }),
        CODES.E_SEQ_CONFLICT,
      );
      assert.equal(await s.head(RUN), 1, "the losing append must not have written");
    });
  });

  test(`[${factory.name}] a future expectedSeq is rejected too (no gaps)`, async () => {
    await withStore(async (s) => {
      await expectLoomError(
        () => s.append({ runId: RUN, expectedSeq: 5, events: [started()] }),
        CODES.E_SEQ_CONFLICT,
      );
      assert.equal(await s.head(RUN), 0);
    });
  });

  test(`[${factory.name}] racing appends: exactly one lands`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [started()] });

      // Both workers observe the same head, then both try to commit — the exact
      // shape of two executors racing one Task after a lease expiry.
      const expectedSeq = await s.head(RUN);
      const results = await Promise.allSettled([
        s.append({ runId: RUN, expectedSeq, events: [progress("worker-a")] }),
        s.append({ runId: RUN, expectedSeq, events: [progress("worker-b")] }),
      ]);

      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      assert.equal(ok.length, 1, "exactly one commit must land");
      assert.equal(failed.length, 1);
      assert.equal(
        (failed[0] as PromiseRejectedResult).reason.code,
        CODES.E_SEQ_CONFLICT,
        "the loser learns it lost, rather than silently double-writing",
      );
      assert.equal(await s.head(RUN), 2);
    });
  });

  test(`[${factory.name}] many racing appends serialize without gaps or duplicates`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [started()] });
      let landed = 0;
      for (let round = 0; round < 20; round++) {
        const expectedSeq = await s.head(RUN);
        const settled = await Promise.allSettled(
          Array.from({ length: 4 }, (_, i) => s.append({ runId: RUN, expectedSeq, events: [progress(`r${round}-${i}`)] })),
        );
        landed += settled.filter((r) => r.status === "fulfilled").length;
      }
      assert.equal(landed, 20, "one winner per round");
      const seqs = await drain(s.read(RUN, 1));
      assert.deepEqual(seqs, Array.from({ length: 21 }, (_, i) => i + 1), "contiguous, no gaps");
    });
  });

  test(`[${factory.name}] a batch is atomic — a rejected append writes nothing`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [started()] });
      await expectLoomError(
        () => s.append({ runId: RUN, expectedSeq: 99, events: [progress("x"), progress("y"), progress("z")] }),
        CODES.E_SEQ_CONFLICT,
      );
      assert.deepEqual(await drain(s.read(RUN, 1)), [1]);
    });
  });

  test(`[${factory.name}] fencing rejects a stale writer`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [progress("t1")], taskId: TASK, fencingToken: 5 });
      // Worker with token 3 woke up late: its lease was already re-issued as 5.
      await expectLoomError(
        () => s.append({ runId: RUN, expectedSeq: 1, events: [progress("late")], taskId: TASK, fencingToken: 3 }),
        CODES.E_FENCING_STALE,
      );
      assert.equal(await s.head(RUN), 1);
    });
  });

  test(`[${factory.name}] fencing allows the same and higher tokens`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [progress("a")], taskId: TASK, fencingToken: 5 });
      // Same token: the same worker writing twice within one lease.
      await s.append({ runId: RUN, expectedSeq: 1, events: [progress("b")], taskId: TASK, fencingToken: 5 });
      // Higher: the lease was re-issued and the new holder writes.
      await s.append({ runId: RUN, expectedSeq: 2, events: [progress("c")], taskId: TASK, fencingToken: 6 });
      assert.equal(await s.head(RUN), 3);
    });
  });

  test(`[${factory.name}] fencing is scoped per task`, async () => {
    await withStore(async (s) => {
      const other = taskId("other" as NodeId, ROOT_BRANCH, 0);
      await s.append({ runId: RUN, expectedSeq: 0, events: [progress("a")], taskId: TASK, fencingToken: 9 });
      // A low token on a DIFFERENT task is not stale — tasks are leased independently.
      await s.append({
        runId: RUN,
        expectedSeq: 1,
        events: [{ type: "task.progress", payload: { chunk: "b" }, actor: SYSTEM_ACTOR("test"), taskId: other }],
        taskId: other,
        fencingToken: 1,
      });
      assert.equal(await s.head(RUN), 2);
    });
  });

  test(`[${factory.name}] read honours inclusive bounds`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [started(), progress("a"), progress("b"), progress("c")] });
      assert.deepEqual(await drain(s.read(RUN, 2, 3)), [2, 3]);
      assert.deepEqual(await drain(s.read(RUN, 4)), [4]);
      assert.deepEqual(await drain(s.read(RUN, 9)), []);
    });
  });

  test(`[${factory.name}] read pages correctly past its internal page size`, async () => {
    await withStore(async (s) => {
      // Deliberately larger than the SQLite store's default page size so the
      // cursor-advance path is exercised rather than a single SELECT.
      const events = Array.from({ length: 1200 }, (_, i) => progress(`e${i}`));
      await s.append({ runId: RUN, expectedSeq: 0, events });
      const seqs = await drain(s.read(RUN, 1));
      assert.equal(seqs.length, 1200);
      assert.equal(seqs[0], 1);
      assert.equal(seqs[1199], 1200);
    });
  });

  test(`[${factory.name}] read returns a consistent prefix even if a write lands mid-iteration`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [started(), progress("a")] });
      const seen: number[] = [];
      for await (const e of s.read(RUN, 1)) {
        seen.push(e.seq);
        if (e.seq === 1) await s.append({ runId: RUN, expectedSeq: 2, events: [progress("late")] });
      }
      assert.deepEqual(seen, [1, 2], "the append during iteration must not extend this read");
      assert.equal(await s.head(RUN), 3);
    });
  });

  test(`[${factory.name}] events round-trip payload, actor, taskId and classification`, async () => {
    await withStore(async (s) => {
      clock.t = 1_700_000_000_123;
      await s.append({
        runId: RUN,
        expectedSeq: 0,
        events: [
          {
            type: "policy.decided",
            payload: { effect: "gate", posture: "in", irreversibility: "irreversible", reasons: ["r1", "r2"] },
            actor: { kind: "human", subject: "u:alice", via: "console", mfa: true },
            taskId: TASK,
            classification: "pii",
          },
        ],
      });
      const [e] = await Array.fromAsync(s.read(RUN, 1));
      assert.ok(e);
      assert.equal(e.type, "policy.decided");
      assert.deepEqual(e.payload, {
        effect: "gate",
        posture: "in",
        irreversibility: "irreversible",
        reasons: ["r1", "r2"],
      });
      assert.deepEqual(e.actor, { kind: "human", subject: "u:alice", via: "console", mfa: true });
      assert.equal(e.taskId, TASK);
      assert.equal(e.classification, "pii");
      assert.equal(e.ts, 1_700_000_000_123, "the injected clock is recorded, not Date.now()");
      assert.equal(e.runId, RUN);
    });
  });

  test(`[${factory.name}] taskId is absent, not null, when not supplied`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [started()] });
      const [e] = await Array.fromAsync(s.read(RUN, 1));
      assert.ok(e);
      assert.equal("taskId" in e, false, "absent means absent — folds branch on presence");
    });
  });

  test(`[${factory.name}] a per-event ts overrides the batch clock`, async () => {
    await withStore(async (s) => {
      await s.append({
        runId: RUN,
        expectedSeq: 0,
        events: [{ ...started(), ts: 42 }, progress("b")],
        now: 100,
      });
      const seqs = await Array.fromAsync(s.read(RUN, 1));
      assert.equal(seqs[0]?.ts, 42);
      assert.equal(seqs[1]?.ts, 100);
    });
  });

  test(`[${factory.name}] runs are isolated from each other`, async () => {
    await withStore(async (s) => {
      const other = "01JRUN1111111111111111111" as RunId;
      await s.append({ runId: RUN, expectedSeq: 0, events: [started()] });
      await s.append({ runId: other, expectedSeq: 0, events: [started(), progress("x")] });
      assert.equal(await s.head(RUN), 1);
      assert.equal(await s.head(other), 2);
      assert.deepEqual(await drain(s.read(RUN, 1)), [1]);
      assert.deepEqual(await drain(s.read(other, 1)), [1, 2]);
    });
  });

  test(`[${factory.name}] listRuns summarises heads and timestamps`, async () => {
    await withStore(async (s) => {
      const other = "01JRUN1111111111111111111" as RunId;
      clock.t = 1000;
      await s.append({ runId: RUN, expectedSeq: 0, events: [started()] });
      clock.t = 2000;
      await s.append({ runId: RUN, expectedSeq: 1, events: [progress("a")] });
      clock.t = 3000;
      await s.append({ runId: other, expectedSeq: 0, events: [started()] });

      const runs = await s.listRuns();
      assert.equal(runs.length, 2);
      const mine = runs.find((r) => r.runId === RUN);
      assert.ok(mine);
      assert.equal(mine.headSeq, 2);
      assert.equal(mine.firstTs, 1000);
      assert.equal(mine.lastTs, 2000);
    });
  });

  test(`[${factory.name}] an empty batch is rejected`, async () => {
    await withStore(async (s) => {
      await assert.rejects(() => s.append({ runId: RUN, expectedSeq: 0, events: [] }));
    });
  });

  test(`[${factory.name}] a negative expectedSeq is rejected`, async () => {
    await withStore(async (s) => {
      await assert.rejects(() => s.append({ runId: RUN, expectedSeq: -1, events: [started()] }));
    });
  });
}
