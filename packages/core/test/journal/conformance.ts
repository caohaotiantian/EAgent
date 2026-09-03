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
import { ROOT_BRANCH, taskId, type GateId, type NodeId, type RunId } from "../../src/ids.ts";
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

function submitted(subject?: string): NewEvent {
  return {
    type: "run.submitted",
    payload: {
      workflow: "w",
      graphHash: "h",
      inputs: {},
      idempotencyKey: "i",
      configDigest: "c",
      ...(subject === undefined ? {} : { submittedBy: { kind: "human" as const, subject, method: "test" } }),
    },
    actor: SYSTEM_ACTOR("control-plane"),
  };
}

function raised(): NewEvent {
  return {
    type: "gate.raised",
    payload: { gateId: "g" as GateId, nodeId: "n" as NodeId, policyRef: "p", contentDigest: "d" },
    actor: SYSTEM_ACTOR("test"),
  };
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

  test(`[${factory.name}] listRuns reports the owner, and filters on it BEFORE the limit`, async () => {
    await withStore(async (s) => {
      const hers = "01JRUN2222222222222222222" as RunId;
      const nobodys = "01JRUN3333333333333333333" as RunId;
      await s.append({ runId: RUN, expectedSeq: 0, events: [submitted("u:alice")] });
      await s.append({ runId: hers, expectedSeq: 0, events: [submitted("u:bob")] });
      await s.append({ runId: nobodys, expectedSeq: 0, events: [submitted()] });

      const all = await s.listRuns();
      assert.deepEqual(
        all.map((r) => r.submittedBy).sort(),
        ["u:alice", "u:bob", undefined],
        "the subject alone reaches a summary — not `kind`, not `method`, which describe the deployment",
      );

      // MINE PLUS NOBODY'S. The permissive half is why the filter is one field: a run with no
      // recorded principal stays readable by everyone, so a journal written before ownership
      // existed is still reachable after an upgrade.
      const scoped = await s.listRuns(100, { submittedByOrUnowned: "u:alice" });
      assert.deepEqual(new Set(scoped.map((r) => r.runId)), new Set([RUN, nobodys]));

      // BEFORE the limit, not after. Filtering the newest N would answer `[]` here — both of
      // bob's-and-nobody's ids sort above alice's — and the count that survived would measure
      // how often OTHER principals submit.
      const oneOfMine = await s.listRuns(2, { submittedByOrUnowned: "u:alice" });
      assert.equal(oneOfMine.length, 2, "two runs match; the limit cuts the matches, not the candidates");
    });
  });

  // ── the cursor ───────────────────────────────────────────────────────────────
  //
  // `RunFilter.after` is the widening DESIGN item 13 needed, and the reason it is pinned HERE
  // rather than in either store's own tests is that a cursor is a claim about ORDER. Both
  // stores already agreed on the ordering and both were wrong about it once — `MAX(seq)` where
  // `MAX(ts)` was meant — and neither store's own suite could have found it. A keyset cursor
  // restates the ordering a second time, in a second language (a `WHERE` predicate in SQL, an
  // array index in memory), so it is exactly the kind of change that makes two backends drift.

  /** Five runs, newest id last, so `ids.at(-1)` is the head of a `run_id DESC` listing. */
  const FIVE = ["01JRUNA", "01JRUNB", "01JRUNC", "01JRUND", "01JRUNE"].map((p) => `${p}0000000000000000000` as RunId);

  test(`[${factory.name}] after is EXCLUSIVE, and two pages abut exactly`, async () => {
    await withStore(async (s) => {
      for (const id of FIVE) await s.append({ runId: id, expectedSeq: 0, events: [started()] });
      const all = (await s.listRuns(10)).map((r) => r.runId);
      assert.deepEqual(all, [...FIVE].reverse(), "the precondition: newest run id first");

      const first = await s.listRuns(2);
      const second = await s.listRuns(2, { after: first.at(-1)!.runId });
      assert.deepEqual(
        [...first, ...second].map((r) => r.runId),
        all.slice(0, 4),
        "page 2 starts one PAST the cursor: nothing repeated, nothing skipped",
      );
      assert.equal(
        second.some((r) => r.runId === first.at(-1)!.runId),
        false,
        "the cursor row itself is not served again — an inclusive boundary is a walk that never advances",
      );
    });
  });

  test(`[${factory.name}] a full walk by cursor visits every run exactly once, and terminates`, async () => {
    // THE PROPERTY THE RUN CLOCK RESTS ON. `listRuns(limit)` alone can only reach the newest
    // `limit`; a walk has to be total or the scan ceiling it replaces was not a ceiling but a
    // policy. Pages of 2 over 5 runs also exercises the SHORT final page, which is how a walker
    // learns it has reached the end.
    await withStore(async (s) => {
      for (const id of FIVE) await s.append({ runId: id, expectedSeq: 0, events: [started()] });
      const seen: RunId[] = [];
      let cursor: RunId | undefined;
      let pages = 0;
      for (;;) {
        const page = await s.listRuns(2, cursor === undefined ? undefined : { after: cursor });
        if (page.length === 0) break;
        pages++;
        for (const r of page) seen.push(r.runId);
        if (page.length < 2) break;
        cursor = page.at(-1)!.runId;
      }
      assert.deepEqual(seen, [...FIVE].reverse(), "every run, in listing order, once");
      assert.equal(new Set(seen).size, 5);
      assert.equal(pages, 3, "ceil(5/2) pages, the last of them short");
    });
  });

  test(`[${factory.name}] a cursor this listing does not admit is REFUSED, not restarted`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [submitted("u:alice")] });
      const hers = "01JRUN2222222222222222222" as RunId;
      await s.append({ runId: hers, expectedSeq: 0, events: [submitted("u:bob")] });

      // 1 · A RUN NOBODY EVER JOURNALED — the cursor from another store, or from a journal that
      //     is not this one. Restarting from the top here is how a truncated walk looks exactly
      //     like a complete one.
      await expectLoomError(() => s.listRuns(10, { after: "01JRUNZZZZZZZZZZZZZZZZZZZ" as RunId }), CODES.E_RUN_NOT_FOUND);

      // 2 · A RUN THAT EXISTS BUT THIS FILTER DOES NOT ADMIT. Same refusal, same code — which is
      //     what stops `after` from answering "does bob have a run with this id?" for a caller
      //     that may not list bob's runs.
      await expectLoomError(
        () => s.listRuns(10, { submittedByOrUnowned: "u:alice", after: hers }),
        CODES.E_RUN_NOT_FOUND,
      );
      // The control: the SAME cursor is fine once the filter admits the run, so the refusal
      // above is about the filter and not about the id.
      assert.deepEqual(
        (await s.listRuns(10, { after: hers })).map((r) => r.runId),
        [RUN],
        "…and unfiltered the SAME id is a position, not an error: the refusal is about the filter, not the id",
      );

      // 3 · A RUN WITH NO POSITION IN THIS ORDER AT ALL. `raisedAGate` orders by the most recent
      //     `gate.raised`; a run that never gated is not in that listing, so it cannot be a place
      //     in it to resume from.
      await expectLoomError(() => s.listRuns(10, { raisedAGate: true, after: RUN }), CODES.E_RUN_NOT_FOUND);
    });
  });

  test(`[${factory.name}] the cursor walks the GATE order, not the run-id order`, async () => {
    // The one case where the two orders disagree, and the one a keyset predicate can get wrong
    // by comparing the id alone: the run with the NEWEST id gated FIRST, so it is last in the
    // gated listing. A cursor that compared `run_id` would hand back an empty page here.
    await withStore(async (s) => {
      const older = "01JRUNAAAAAAAAAAAAAAAAAAA" as RunId;
      const newer = "01JRUNBBBBBBBBBBBBBBBBBBB" as RunId;
      clock.t = 1000;
      await s.append({ runId: newer, expectedSeq: 0, events: [started(), raised()] });
      clock.t = 2000;
      await s.append({ runId: older, expectedSeq: 0, events: [started(), raised()] });

      const gated = (await s.listRuns(10, { raisedAGate: true })).map((r) => r.runId);
      assert.deepEqual(gated, [older, newer], "newest GATE first, which is the opposite of newest id first");
      const next = await s.listRuns(10, { raisedAGate: true, after: older });
      assert.deepEqual(
        next.map((r) => r.runId),
        [newer],
        "the page after the newest gate is the older gate — a run-id keyset would return nothing",
      );
    });
  });

  test(`[${factory.name}] the owner is established once and no later append rewrites it`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [submitted("u:alice")] });
      await s.append({ runId: RUN, expectedSeq: 1, events: [submitted("u:mallory")] });
      const [only] = await s.listRuns(100, { submittedByOrUnowned: "u:alice" });
      assert.equal(only?.submittedBy, "u:alice", "a second run.submitted cannot move a run between owners");
    });
  });

  test(`[${factory.name}] a run whose FIRST submission named nobody stays unowned`, async () => {
    await withStore(async (s) => {
      await s.append({ runId: RUN, expectedSeq: 0, events: [submitted()] });
      await s.append({ runId: RUN, expectedSeq: 1, events: [submitted("u:mallory")] });
      // The permissive case is the one that must not be adoptable: it is what every
      // pre-upgrade journal looks like, and the fold makes the identical decision.
      const [only] = await s.listRuns();
      assert.equal(only?.submittedBy, undefined);
    });
  });

  // A CLOSED STORE IS CLOSED FOR EVERY METHOD, IN BOTH BACKENDS. The memory store used to
  // clear its map and then answer as if it were fresh, so an append at `expectedSeq: 0` for a
  // run whose journal it had just discarded PASSED the CAS and started a second, empty journal
  // under the same id — a durable-write API reporting success for a write it threw away, which
  // is the one outcome the CAS exists to make impossible. SQLite refused all four the whole
  // time; the divergence was invisible because no case here called `close()`.
  test(`[${factory.name}] every method refuses after close, and close is idempotent`, async () => {
    const store = factory.create(now);
    await store.append({ runId: RUN, expectedSeq: 0, events: [started()] });
    store.close();
    store.close(); // idempotent — the second call must not throw
    await expectLoomError(() => store.append({ runId: RUN, expectedSeq: 0, events: [started()] }), CODES.E_INTERNAL);
    await expectLoomError(() => drain(store.read(RUN, 1)), CODES.E_INTERNAL);
    await expectLoomError(() => store.head(RUN), CODES.E_INTERNAL);
    await expectLoomError(() => store.listRuns(10), CODES.E_INTERNAL);
  });

  // THE GATED LISTING ORDERS BY A RUN'S LATEST GATE, WHICH IS NOT ITS LAST GATE IN SEQ ORDER.
  // `prepare` honours a per-event `ts`, and a wall clock steps backwards (NTP, VM resume), so
  // seq order and ts order come apart. SQL took `MAX(ts)`; memory kept whichever `gate.raised`
  // it saw last while scanning. The two then paged the SLA sweep in different orders.
  test(`[${factory.name}] the gated listing orders by a run's LATEST gate ts, not its last in seq order`, async () => {
    await withStore(async (s) => {
      const backwards = "01JRUNCCCCCCCCCCCCCCCCCCC" as RunId;
      const single = "01JRUNDDDDDDDDDDDDDDDDDDD" as RunId;
      await s.append({ runId: backwards, expectedSeq: 0, events: [started()] });
      await s.append({ runId: backwards, expectedSeq: 1, events: [{ ...raised(), ts: 5000 }] });
      await s.append({ runId: backwards, expectedSeq: 2, events: [{ ...raised(), ts: 1000 }] });
      await s.append({ runId: single, expectedSeq: 0, events: [started(), { ...raised(), ts: 3000 }] });

      const gated = (await s.listRuns(10, { raisedAGate: true })).map((r) => r.runId);
      assert.deepEqual(gated, [backwards, single], "5000 is the run's latest gate even though 1000 came later in seq");
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
