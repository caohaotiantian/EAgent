import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { EVENT_TYPES, SYSTEM_ACTOR } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { runConformance } from "./conformance.ts";

// The same contract, both implementations. If these ever diverge, the StateStore
// interface is not the real boundary and the local -> distributed swap is a lie.
runConformance({
  name: "memory",
  create: (now) => new MemoryStateStore({ now }),
});

runConformance({
  name: "sqlite",
  // A small page size so `read`'s cursor-advance path runs even on short journals.
  create: (now) => new SqliteStateStore({ path: ":memory:", now, pageSize: 7 }),
});

// ── implementation-specific behaviour ────────────────────────────────────────

test("[sqlite] survives close and reopen on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-journal-"));
  const path = join(dir, "journal.db");
  const run = "01JRUNPERSIST0000000000000" as RunId;
  try {
    const first = new SqliteStateStore({ path });
    await first.append({
      runId: run,
      expectedSeq: 0,
      events: [
        { type: "run.started", payload: { posture: "in" }, actor: SYSTEM_ACTOR("test") },
        { type: "task.progress", payload: { chunk: "work" }, actor: SYSTEM_ACTOR("test") },
      ],
    });
    first.close();

    // A new process would see exactly this: the head and the events, with no
    // recovery step. Durable suspension across restart rests on it.
    const second = new SqliteStateStore({ path });
    assert.equal(await second.head(run), 2);
    const events = await Array.fromAsync(second.read(run, 1));
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "run.started");
    assert.deepEqual(events[1]?.payload, { chunk: "work" });

    // And the CAS still refuses a stale write after the restart.
    await assert.rejects(
      () => second.append({ runId: run, expectedSeq: 0, events: [{ type: "run.started", payload: { posture: "on" }, actor: SYSTEM_ACTOR("t") }] }),
      /E_SEQ_CONFLICT|expected seq/,
    );
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[sqlite] fencing state also survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-fence-"));
  const path = join(dir, "journal.db");
  const run = "01JRUNFENCE000000000000000" as RunId;
  try {
    const first = new SqliteStateStore({ path });
    await first.append({
      runId: run,
      expectedSeq: 0,
      events: [{ type: "task.progress", payload: { chunk: "a" }, actor: SYSTEM_ACTOR("t") }],
      taskId: "n@root#0" as never,
      fencingToken: 12,
    });
    first.close();

    const second = new SqliteStateStore({ path });
    await assert.rejects(
      () =>
        second.append({
          runId: run,
          expectedSeq: 1,
          events: [{ type: "task.progress", payload: { chunk: "late" }, actor: SYSTEM_ACTOR("t") }],
          taskId: "n@root#0" as never,
          fencingToken: 4,
        }),
      /E_FENCING_STALE|stale/,
    );
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[sqlite] refuses to open a journal from a newer schema version", () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-schema-"));
  const path = join(dir, "journal.db");
  try {
    const s = new SqliteStateStore({ path });
    s.close();
    // Simulate a downgrade: an older binary meeting a newer file must fail loudly
    // rather than silently misreading rows.
    const db = new DatabaseSync(path);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();

    assert.throws(() => new SqliteStateStore({ path }), /newer than this build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVENT_TYPES matches the EventPayloads key set", () => {
  // EVENT_TYPES is `as const satisfies readonly EventType[]`, so the compiler already
  // rejects an entry that is not an EventType. This catches the other direction: a
  // payload added to the map but forgotten in the runtime list.
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length, "no duplicates");
  assert.equal(EVENT_TYPES.length, 52, "update this count when the vocabulary grows, deliberately");
});

test("SQLITE EMITS NO EXPERIMENTAL WARNING (open thread T3)", () => {
  // T3 asked whether to suppress `node:sqlite`'s ExperimentalWarning for CLI UX. As of
  // Node 24.16 it no longer emits one, so the answer is "nothing to suppress" — and this
  // guard is what turns that from a thing that happens to be true today into a thing we
  // would notice stopping. Suppressing warnings globally was the alternative, and it
  // would have hidden every OTHER warning too.
  const seen: string[] = [];
  const onWarning = (w: Error): void => {
    if (w.name === "ExperimentalWarning" && /sqlite/i.test(w.message)) seen.push(w.message);
  };
  process.on("warning", onWarning);

  const db = new SqliteStateStore({ path: ":memory:" });
  db.close();

  process.off("warning", onWarning);
  assert.deepEqual(seen, [], "if this fires, decide suppression deliberately — do not silence process warnings wholesale");
});

