/**
 * What the two stores cost, and what an existing journal file is owed when the schema changes.
 *
 * Two properties that nothing else in the suite holds:
 *
 *   - `MemoryStateStore.read(runId, fromSeq)` must FIND the tail rather than scan to it. Every
 *     test in the suite folds through this store and `Engine.#project` asks it for
 *     `lastSeq + 1` once per wave, so a scan from index 0 makes the incremental fold — whose
 *     entire purpose is reading only the tail — quadratic in the run's own history. The
 *     conformance suite pins the ANSWER and cannot see the cost, so this file reads a clock.
 *
 *   - Dropping `journal_by_task` changes the ON-DISK shape, and a journal file is the one
 *     artifact a deployment cannot re-create. An existing file carrying the index must open,
 *     read back every event it already held, and keep accepting appends.
 *
 * THE CLOCK HERE IS ONE ABSOLUTE BOUND, never a ratio of two timings. Measured in this test on
 * this tree: 456 ms with the scan, 19-28 ms with the binary search, against a bound of 200 ms —
 * about ten times the observed cost and about half the scanning one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunId, Seq } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { foldRun } from "../../src/run/projection.ts";

const RUN = "01JRUNPERFLANE0000000000" as RunId;

async function fill(store: MemoryStateStore, events: number): Promise<void> {
  let seq = 0;
  for (let i = 0; i < events / 5; i++) {
    await store.append({
      runId: RUN,
      expectedSeq: seq as Seq,
      events: Array.from({ length: 5 }, () => ({
        type: "task.ready",
        payload: { nodeId: "n", branchPath: "root", edgesIn: [] },
        actor: SYSTEM_ACTOR("perf"),
      })) as never,
    });
    seq += 5;
  }
}

test("THE MEMORY STORE FINDS THE TAIL, it does not scan to it", async () => {
  const store = new MemoryStateStore({ now: () => 1 });
  const TOTAL = 40_000;
  await fill(store, TOTAL);

  // FASTEST OF THREE, for the reason `scale.test.ts` gives: interference is one-directional, so
  // the minimum converges on the code's own cost from above while a single shot carries whatever
  // else the machine was doing. It is still one absolute number, not a ratio of two.
  let seen = 0;
  let best = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < TOTAL / 5; i++) {
      // The fold's own pattern: ask for a `fromSeq` that walks forward through the journal and
      // take the first event. A scan from index 0 pays for everything before it, every time.
      const from = (Math.floor((i / (TOTAL / 5)) * TOTAL) + 1) as Seq;
      for await (const _e of store.read(RUN, from)) {
        seen++;
        break;
      }
    }
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    ${String(TOTAL / 5)} tail reads over ${String(TOTAL)} events: ${best.toFixed(1)} ms (best of 3)`);
  assert.equal(seen, (TOTAL / 5) * 3);
  // 19-28 ms here; 456 ms with the scan this replaced. 200 ms is the widest bound those two
  // numbers allow: about ten times the observed cost, and still well under the cost of the
  // complexity regression it exists to catch.
  assert.ok(best < 200, `${String(TOTAL / 5)} tail reads took ${best.toFixed(0)} ms — the read is scanning again`);
});

test("…and it still answers exactly what it answered before: prefix, bounds, and misses", async () => {
  const store = new MemoryStateStore({ now: () => 1 });
  await fill(store, 20);

  const all: JournalEvent[] = [];
  for await (const e of store.read(RUN, 1 as Seq)) all.push(e);
  assert.deepEqual(all.map((e) => e.seq), Array.from({ length: 20 }, (_, i) => i + 1));

  const tail: JournalEvent[] = [];
  for await (const e of store.read(RUN, 15 as Seq)) tail.push(e);
  assert.deepEqual(tail.map((e) => e.seq), [15, 16, 17, 18, 19, 20], "an interior fromSeq starts exactly there");

  const window: JournalEvent[] = [];
  for await (const e of store.read(RUN, 8 as Seq, 11 as Seq)) window.push(e);
  assert.deepEqual(window.map((e) => e.seq), [8, 9, 10, 11], "toSeq is inclusive, and stops");

  const past: JournalEvent[] = [];
  for await (const e of store.read(RUN, 21 as Seq)) past.push(e);
  assert.deepEqual(past, [], "a fromSeq past the head yields nothing rather than throwing");

  const empty: JournalEvent[] = [];
  for await (const e of store.read(RUN, 5 as Seq, 4 as Seq)) empty.push(e);
  assert.deepEqual(empty, [], "an inverted window is empty");

  const zero: JournalEvent[] = [];
  for await (const e of store.read(RUN, 0 as Seq)) zero.push(e);
  assert.equal(zero.length, 20, "a fromSeq below the first event is the whole journal");

  const unknown: JournalEvent[] = [];
  for await (const e of store.read("01JRUNNOSUCH000000000000" as RunId, 1 as Seq)) unknown.push(e);
  assert.deepEqual(unknown, [], "an unknown run is empty, not an error");
});

test("A BOUND THE READ CANNOT UNDERSTAND YIELDS NOTHING, which is the direction the filter failed in", async () => {
  // Every comparison against NaN is false, so the range test the binary search sits in front of
  // answers "no" for an unreadable bound. Deriving the answer from the search alone would have
  // put the start index at 0 and served the WHOLE journal — a read that widens when it cannot
  // read its own arguments. Neither bound is reachable as NaN from `src/` today; the point is
  // that the guard does not depend on that staying true.
  const store = new MemoryStateStore({ now: () => 1 });
  await fill(store, 20);

  for (const [from, to] of [
    [NaN, undefined],
    [1, NaN],
    [NaN, NaN],
  ] as const) {
    const seen: JournalEvent[] = [];
    for await (const e of store.read(RUN, from as Seq, to as Seq | undefined)) seen.push(e);
    assert.deepEqual(seen, [], `read(${String(from)}, ${String(to)}) must yield nothing`);
  }

  // THE ORDINARY HALF: the same journal with readable bounds still answers in full.
  const ok: JournalEvent[] = [];
  for await (const e of store.read(RUN, 1 as Seq)) ok.push(e);
  assert.equal(ok.length, 20);
});

test("THE READ IS A CONSISTENT PREFIX even when an append lands mid-iteration", async () => {
  // The `limit` snapshot this read pins is the reason: the binary search is over that pinned
  // prefix, not over the live array, so a concurrent append cannot extend a read in flight.
  const store = new MemoryStateStore({ now: () => 1 });
  await fill(store, 10);

  const seen: number[] = [];
  for await (const e of store.read(RUN, 1 as Seq)) {
    seen.push(e.seq);
    if (e.seq === 3) {
      await store.append({
        runId: RUN,
        expectedSeq: 10 as Seq,
        events: [{ type: "run.completed", payload: { status: "succeeded", outputs: {} }, actor: SYSTEM_ACTOR("perf") }] as never,
      });
    }
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "the read served the prefix it started with");
});

test("A JOURNAL FILE THAT ALREADY CARRIES journal_by_task STILL OPENS, READS AND APPENDS", async () => {
  // Dropping an index is a change to the on-disk shape, and the file is the artifact a
  // deployment cannot re-create. This builds a journal the way the previous schema built one —
  // index included — and then opens it with this build.
  const dir = mkdtempSync(join(tmpdir(), "loom-perf-lane-idx-"));
  const path = join(dir, "journal.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE journal (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
        actor TEXT NOT NULL, task_id TEXT, payload TEXT NOT NULL, classification TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      ) WITHOUT ROWID;
      CREATE INDEX journal_by_type ON journal (run_id, type, seq);
      CREATE INDEX journal_by_task ON journal (run_id, task_id, seq);
      CREATE INDEX journal_by_type_global ON journal (type, ts);
      CREATE TABLE run_head (
        run_id TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
        submitted_by TEXT
      ) WITHOUT ROWID;
      CREATE TABLE task_fence (
        run_id TEXT NOT NULL, task_id TEXT NOT NULL, max_token INTEGER NOT NULL, PRIMARY KEY (run_id, task_id)
      ) WITHOUT ROWID;
      INSERT INTO meta (key, value) VALUES ('schema_version', '2');
      INSERT INTO run_head (run_id, head_seq, first_ts, last_ts, submitted_by) VALUES ('${RUN}', 2, 5, 6, NULL);
      INSERT INTO journal VALUES ('${RUN}', 1, 5, 'run.started', '{"kind":"system","component":"t"}', NULL, '{"posture":"out"}', 'internal');
      INSERT INTO journal VALUES ('${RUN}', 2, 6, 'task.ready', '{"kind":"system","component":"t"}', 'n@root#0', '{"nodeId":"n","branchPath":"root","edgesIn":[]}', 'internal');
    `);
    const before = old.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as { name: string }[];
    assert.ok(before.some((r) => r.name === "journal_by_task"), "the fixture really has the index");
    old.close();

    const store = new SqliteStateStore({ path });
    const read: JournalEvent[] = [];
    for await (const e of store.read(RUN, 1 as Seq)) read.push(e);
    assert.deepEqual(read.map((e) => e.type), ["run.started", "task.ready"], "every event the file already held");
    assert.equal(read[1]?.taskId, "n@root#0", "including its task_id column");
    assert.equal(await store.head(RUN), 2);
    assert.equal((await store.listRuns()).length, 1);

    // And the fold reaches the same answer it would have before.
    const p = foldRun(read)!;
    assert.equal(p.status, "running");
    assert.equal(Object.keys(p.tasks).length, 1);

    // The CAS still runs off the head this file already had.
    await store.append({
      runId: RUN,
      expectedSeq: 2 as Seq,
      taskId: "n@root#0" as never,
      // `task.leased`, because `task.started` was deleted from the vocabulary (B.2). This site was
      // NOT in that decision's `blockedOn` list — the `as never` hid it from the compiler and from
      // the pin alike, which is `e50a2e7`'s "the docstring said three files; there were nine"
      // happening again. What this test asserts (head advances, the dead index is gone) is
      // unchanged by which event rides the append.
      events: [{ type: "task.leased", payload: { workerId: "w", attempt: 1 }, actor: SYSTEM_ACTOR("perf") }] as never,
    });
    assert.equal(await store.head(RUN), 3);
    store.close();

    const after = new DatabaseSync(path);
    const names = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => n.startsWith("journal_by"));
    assert.deepEqual(names, ["journal_by_type", "journal_by_type_global"], "and the dead index is gone from the file");
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
