/**
 * A JOURNAL AN OLDER BINARY WROTE STILL FOLDS, INCLUDING ROWS THIS ONE NO LONGER DECLARES.
 *
 * `channel.written` was removed from `EventPayloads` under `TODO.md` §B.2, because a member of a
 * closed vocabulary that nothing appends is not a durable fact — it is a plan for one, and it costs
 * a fold arm that reads like proof something writes it. Removing a row from that union is the same
 * reviewable act as adding one, and it has one consumer the addition does not: **a journal already
 * on somebody's disk that contains the name.**
 *
 * WHAT THIS FILE IS, SAID PLAINLY, BECAUSE HALF OF IT CANNOT GO RED FOR THE CHANGE IT SHIPS WITH.
 * `run/projection.ts`'s `channel.written` arm was `// Nothing to fold`, so the fold ignored the row
 * BEFORE the deletion and ignores it after; the equality assertions below would have passed at
 * `ef7df7d` too. They are a REGRESSION PIN, not evidence about that diff — they go red the day
 * somebody replaces an `isEvent` chain with an exhaustive `switch`, or teaches the store to
 * validate `type` on the read path, either of which turns every pre-B.2 journal into an unreadable
 * one. The argument that the deletion is safe TODAY is the reader census in the commit body.
 *
 * The half that IS red before the deletion is `THE NAME IS GONE FROM THE VOCABULARY`, which is why
 * that assertion is here rather than only in `store.test.ts`'s count: a count moving 53 → 52 says a
 * member left, never which one.
 *
 * THE ROWS GO THROUGH THE REAL DURABLE PATH, not a hand-built array. `journal/store.ts`'s `prepare`
 * writes `type` into a text column without consulting any vocabulary, and that is precisely the
 * property under test — asserting it against a literal array would be asserting it against the
 * wrong thing. So: `SqliteStateStore.append`, `node:sqlite`, and `store.read` back out — and
 * `MemoryStateStore` beside it, because both stores share `prepare` and a claim about "the store"
 * that measures one of two backends is a claim about the wrong population.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditRun } from "../../src/journal/audit.ts";
import { EVENT_TYPES, SYSTEM_ACTOR, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import type { RunId, Seq, TaskId } from "../../src/ids.ts";
import { foldRun } from "../../src/run/projection.ts";

/** Names an older binary could write and this one no longer declares. */
const DELETED = ["channel.written"] as const;

const RUN = "run_old" as RunId;
const TASK = "n@root#0" as TaskId;
const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 };

/**
 * The journal an older binary wrote: an ordinary single-task run, with the deleted rows in the
 * places that binary would have put them.
 */
function oldJournal(): { readonly type: string; readonly payload: unknown; readonly taskId?: TaskId }[] {
  return [
    { type: "run.submitted", payload: { workflow: "w", graphHash: "sha256:x", inputs: {}, idempotencyKey: "i", configDigest: "c" } },
    { type: "run.started", payload: { posture: "out" } },
    { type: "task.ready", payload: { nodeId: "n", branchPath: "root", edgesIn: [] }, taskId: TASK },
    { type: "task.leased", payload: { workerId: "w", attempt: 1 }, taskId: TASK },
    { type: "task.committed", payload: { status: "succeeded", writes: { out: 1 }, take: [], usage: ZERO, attempt: 1 }, taskId: TASK },
    // ← the deleted name, where the binary that declared it would have written it
    { type: "channel.written", payload: { channel: "out", reducer: "replace", valueDigest: "sha256:d" }, taskId: TASK },
    {
      type: "state.reduced",
      payload: {
        channels: ["out"],
        values: { out: 1 },
        branchCount: 1,
        skipped: 0,
        degraded: false,
        stateHashBefore: "sha256:a",
        stateHashAfter: "sha256:b",
      },
      taskId: TASK,
    },
    { type: "run.completed", payload: { outputs: { out: 1 }, usage: ZERO } },
  ];
}

/** Write rows through the real store and read them back, exactly as a restart would. */
async function roundTrip(rows: readonly { readonly type: string; readonly payload: unknown; readonly taskId?: TaskId }[]): Promise<JournalEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), "loom-deleted-types-"));
  try {
    const store = new SqliteStateStore({ path: join(dir, "journal.db"), now: () => 1_700_000_000_000 });
    try {
      let seq = 0;
      for (const r of rows) {
        // `as never`: the whole point is that these names are outside `EventType` now. The STORE
        // does not care, which is the property being measured.
        await store.append({
          runId: RUN,
          expectedSeq: seq as Seq,
          events: [{ type: r.type, payload: r.payload, actor: SYSTEM_ACTOR("old-binary") }] as never,
          ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
        });
        seq += 1;
      }
      const out: JournalEvent[] = [];
      for await (const e of store.read(RUN, 1 as Seq)) out.push(e);
      return out;
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("THE NAME IS GONE FROM THE VOCABULARY — the half of this file that is red before the deletion", () => {
  // Non-empty first: a `for` over an emptied list passes while asserting nothing, which is the
  // shape `registries-are-populated.test.ts` exists to refuse one level up.
  assert.ok(DELETED.length > 0, "no deleted names listed — every assertion below would be vacuous");
  for (const name of DELETED) {
    assert.ok(
      !(EVENT_TYPES as readonly string[]).includes(name),
      `${name} is still declared; B.2 decided DELETE for it and a count alone cannot say which member left`,
    );
  }
});

test("THE MEMORY STORE ANSWERS THE SAME, so the claim covers both backends and not just one", async () => {
  // `prepare` is shared by both stores (`journal/store.ts`), which is the reason to expect this —
  // but "expect" is not "measured", and the commit body reasons about BOTH stores.
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  let seq = 0;
  for (const r of oldJournal()) {
    await store.append({
      runId: RUN,
      expectedSeq: seq as Seq,
      events: [{ type: r.type, payload: r.payload, actor: SYSTEM_ACTOR("old-binary") }] as never,
      ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
    });
    seq += 1;
  }
  const read: JournalEvent[] = [];
  for await (const e of store.read(RUN, 1 as Seq)) read.push(e);

  assert.deepEqual(read.map((e) => e.type), oldJournal().map((r) => r.type), "same rows, same order");
  assert.equal(foldRun(read)?.status, "succeeded");
  assert.deepEqual(foldRun(read)?.channels, { out: 1 });
});

test("THE DURABLE PATH ACCEPTS AND RETURNS A NAME THIS BINARY DOES NOT DECLARE", async () => {
  const read = await roundTrip(oldJournal());

  assert.deepEqual(
    read.map((e) => e.type),
    oldJournal().map((r) => r.type),
    "every row the older binary wrote comes back, in order and by name",
  );
  // WIDENED ON PURPOSE. `e.type` is `EventType`, which no longer has this member, so a direct
  // comparison is a compile error — which is itself the deletion working. The row is still on the
  // disk and still comes back; it is only the TYPE that stopped admitting it.
  const rows: readonly { readonly type: string; readonly payload: unknown; readonly taskId?: string }[] = read;
  const written = rows.find((e) => e.type === "channel.written");
  assert.ok(written, "including the one whose name left the union");
  assert.deepEqual(written.payload, { channel: "out", reducer: "replace", valueDigest: "sha256:d" }, "with its payload intact");
  assert.equal(written.taskId, TASK, "and its task_id column");
});

test("AND THE FOLD REACHES THE SAME ANSWER IT WOULD WITHOUT THOSE ROWS", async () => {
  const withDeleted = await roundTrip(oldJournal());
  const without = await roundTrip(oldJournal().filter((r) => !(DELETED as readonly string[]).includes(r.type)));

  const a = foldRun(withDeleted);
  const b = foldRun(without);
  assert.ok(a && b);

  // Seqs differ by construction (one journal is shorter), so compare what a reader of the run
  // actually asks for rather than the whole projection object.
  assert.equal(a.status, b.status);
  assert.equal(a.status, "succeeded");
  assert.deepEqual(a.channels, b.channels);
  assert.deepEqual(a.channels, { out: 1 });
  assert.deepEqual(Object.keys(a.tasks), Object.keys(b.tasks));
  assert.deepEqual(a.tasks[TASK]?.state, b.tasks[TASK]?.state);
  assert.equal(a.tasks[TASK]?.state, "succeeded");
  assert.deepEqual(a.tasks[TASK]?.writes, b.tasks[TASK]?.writes);

  // AND THE AUDITOR AGREES, which is the other fold an operator runs over an old journal. An
  // unknown type hits `default: break`, so it constrains nothing and accuses nothing.
  const ra = auditRun(withDeleted);
  const rb = auditRun(without);
  // Captured before the emptiness assertion, which narrows `violations` to `never[]`.
  const rulesA = ra.violations.map((v) => v.rule);
  const rulesB = rb.violations.map((v) => v.rule);
  assert.deepEqual(rulesA, rulesB, "the deleted rows change no verdict");
  assert.deepEqual([...ra.checked].sort(), [...rb.checked].sort(), "…and no rule's evidence");
  assert.deepEqual(ra.violations, [], JSON.stringify(ra.violations));
});
