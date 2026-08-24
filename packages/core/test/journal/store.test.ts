import test from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CODES, isLoomError } from "../../src/errors.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { type Actor, EVENT_TYPES, type EventType, SYSTEM_ACTOR } from "../../src/journal/events.ts";
import type { StateStore } from "../../src/journal/store.ts";
import type { RunId, TaskId } from "../../src/ids.ts";
import { foldRun } from "../../src/run/projection.ts";
import { runConformance } from "./conformance.ts";
import type { FromWorker, ToWorker } from "./open-worker.ts";

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

test("[sqlite] A v1 JOURNAL MIGRATES, AND OPENS AGAIN — the second open is the one that used to die", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-migrate-"));
  const path = join(dir, "journal.db");
  const run = "01JRUNMIGRATE00000000000" as RunId;
  try {
    // A v1 file, built the way v1 built it: the pre-ownership `run_head`, stamped 1.
    const v1 = new DatabaseSync(path);
    v1.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE journal (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
        actor TEXT NOT NULL, task_id TEXT, payload TEXT NOT NULL, classification TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      ) WITHOUT ROWID;
      CREATE TABLE run_head (
        run_id TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE task_fence (
        run_id TEXT NOT NULL, task_id TEXT NOT NULL, max_token INTEGER NOT NULL, PRIMARY KEY (run_id, task_id)
      ) WITHOUT ROWID;
      INSERT INTO meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO run_head (run_id, head_seq, first_ts, last_ts) VALUES ('${run}', 1, 5, 5);
      INSERT INTO journal VALUES ('${run}', 1, 5, 'run.started', '{"kind":"system","component":"t"}', NULL, '{"posture":"on"}', 'internal');
    `);
    v1.close();

    const first = new SqliteStateStore({ path });
    const listed = await first.listRuns();
    assert.equal(listed.length, 1, "the pre-existing run is still there");
    assert.equal(listed[0]?.submittedBy, undefined, "and it is unowned, which is the permissive case");
    first.close();

    // THE POINT OF THIS TEST. `#migrate` stamps the version only in its bootstrap arm, so an
    // ALTER TABLE that does not also restamp re-runs on every open and the SECOND one throws
    // `duplicate column name` out of the constructor — every process after the first upgrade
    // dead, on a journal that had already migrated successfully.
    const second = new SqliteStateStore({ path });
    assert.equal((await second.listRuns()).length, 1);
    second.close();

    // A third, for the same reason a second worker exists: nothing about the fix may depend
    // on the migrating process being the only one.
    const third = new SqliteStateStore({ path });
    assert.equal((await third.head(run)), 1);
    third.close();

    const check = new DatabaseSync(path);
    const row = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    assert.equal(row.value, "2", "the stamp moved, which is what stops the migration repeating");
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[sqlite] A HALF-MIGRATED FILE IS NOT A BRICK — the stamp and the table can disagree", async () => {
  // Two states the stamp alone cannot describe, both of which threw a raw, untyped
  // ERR_SQLITE_ERROR out of the constructor or out of every append. Gating each step on
  // `PRAGMA table_info` rather than on the bookkeeping row makes them ordinary.
  const dir = mkdtempSync(join(tmpdir(), "loom-halfmig-"));
  try {
    const v1 = (name: string, meta: string | undefined, withColumn: boolean): string => {
      const path = join(dir, name);
      const db = new DatabaseSync(path);
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE journal (
          run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
          actor TEXT NOT NULL, task_id TEXT, payload TEXT NOT NULL, classification TEXT NOT NULL,
          PRIMARY KEY (run_id, seq)
        ) WITHOUT ROWID;
        CREATE TABLE run_head (
          run_id TEXT PRIMARY KEY, head_seq INTEGER NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL
          ${withColumn ? ", submitted_by TEXT" : ""}
        ) WITHOUT ROWID;
        CREATE TABLE task_fence (
          run_id TEXT NOT NULL, task_id TEXT NOT NULL, max_token INTEGER NOT NULL, PRIMARY KEY (run_id, task_id)
        ) WITHOUT ROWID;
        ${meta === undefined ? "" : `INSERT INTO meta (key, value) VALUES ('schema_version', '${meta}');`}
      `);
      db.close();
      return path;
    };

    // (1) The ALTER landed, the stamp did not — a partial restore, or a peer killed between
    // two statements in an older build. Re-running the DDL would be `duplicate column name`.
    const altered = new SqliteStateStore({ path: v1("altered.db", "1", true) });
    assert.deepEqual(await altered.listRuns(), []);
    altered.close();

    // (2) NO STAMP AT ALL, but a v1-shaped table. `CREATE TABLE IF NOT EXISTS` no-ops, so the
    // bootstrap arm would stamp it CURRENT and every later append would fail with
    // `no such column: submitted_by` — a file that opens cleanly and cannot be written to.
    const unstamped = new SqliteStateStore({ path: v1("unstamped.db", undefined, false) });
    const run = "01JRUNUNSTAMPED0000000000" as RunId;
    await unstamped.append({
      runId: run,
      expectedSeq: 0,
      events: [{ type: "run.started", payload: { posture: "on" }, actor: SYSTEM_ACTOR("t") }],
    });
    assert.equal((await unstamped.listRuns()).length, 1, "it migrated rather than being stamped as already current");
    unstamped.close();
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

// ── multi-process startup ────────────────────────────────────────────────────
//
// v1 runs several worker processes against one journal file on one device, so the
// constructor is a contended path, not a private one. Two tests: one isolates the
// single-peer case against a lock held on demand, the other runs the stampede that a
// fleet actually produces at startup.

const WORKER = join(import.meta.dirname, "open-worker.ts");

function spawnWorker(role: "holder" | "opener"): ChildProcess {
  // `execArgv: []` because the parent is running under `node --test`; inheriting that
  // flag would make the child try to be a test runner.
  return fork(WORKER, [role], { execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"] });
}

/** Resolves on the first message the predicate accepts. */
function nextMessage(child: ChildProcess, want: (m: FromWorker) => boolean): Promise<FromWorker> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown): void => {
      const msg = raw as FromWorker;
      if (!want(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`worker exited early with code ${String(code)}`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function tell(child: ChildProcess, msg: ToWorker): void {
  child.send(msg);
}

/**
 * True while some other connection is parked waiting to upgrade to EXCLUSIVE.
 *
 * A waiting upgrader holds PENDING, and PENDING refuses *new* readers while leaving
 * existing ones alone — so a throwaway connection that cannot even read the schema is
 * proof that someone is blocked on the lock. This is the observable that makes the
 * test below deterministic: it distinguishes "waited" from "died instantly" without
 * measuring time.
 */
function someoneIsWaitingForTheLock(path: string): boolean {
  const probe = new DatabaseSync(path);
  try {
    probe.prepare("SELECT count(*) FROM sqlite_schema").get();
    return false;
  } catch {
    return true;
  } finally {
    probe.close();
  }
}

test("[sqlite] a WAL conversion blocked by another process waits for the lock instead of dying", { timeout: 60_000 }, async () => {
  // The defect is an ORDERING one: `PRAGMA busy_timeout` must be set before the WAL
  // conversion, because the conversion needs a brief exclusive lock and SQLite's
  // default timeout is zero. A holder process pins a SHARED lock, and the parent
  // releases it only once it can SEE that the opener is parked on the lock. So the
  // pass condition is not "the open eventually succeeded" — a store that dies on
  // contention never parks, the release is never sent, and it reports its failure
  // instead. No sleeps, and no dependence on which process the scheduler runs first.
  const dir = mkdtempSync(join(tmpdir(), "loom-walrace-"));
  const path = join(dir, "journal.db");
  const holder = spawnWorker("holder");
  const opener = spawnWorker("opener");
  try {
    const held = nextMessage(holder, (m) => m.kind === "held");
    tell(holder, { kind: "hold", path });
    await held;

    const settled = nextMessage(opener, (m) => m.kind === "opened" || m.kind === "failed");
    let gaveUp = false;
    void settled.then(
      () => {
        gaveUp = true;
      },
      () => {
        gaveUp = true;
      },
    );
    const announced = nextMessage(opener, (m) => m.kind === "opening");
    tell(opener, { kind: "open", id: 1, path });
    await announced;

    while (!gaveUp && !someoneIsWaitingForTheLock(path)) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    tell(holder, { kind: "release" });

    const result = await settled;
    assert.equal(
      result.kind,
      "opened",
      `the constructor must park on a held lock, not die on it: ${JSON.stringify(result)}`,
    );
  } finally {
    holder.kill("SIGKILL");
    opener.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[sqlite] many processes opening one fresh journal at once all survive the constructor", { timeout: 120_000 }, async () => {
  // A fleet starting up: N workers all open the same journal at once. Every step of
  // the constructor that touches a lock is in scope here, and empirically two of them
  // are — the WAL conversion and the schema-version stamp — so this catches a
  // regression in either without knowing in advance which one broke. Rounds are
  // barrier-synchronised over IPC (no sleeps), and each round gets a fresh path so
  // the conversion really runs rather than short-circuiting on an already-WAL file.
  const WORKERS = 6;
  const ROUNDS = 14;
  const dir = mkdtempSync(join(tmpdir(), "loom-stampede-"));
  const workers = Array.from({ length: WORKERS }, () => spawnWorker("opener"));
  const failures: string[] = [];
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const path = join(dir, `round-${round}.db`);
      const settled = workers.map((w) =>
        nextMessage(w, (m) => m.kind === "opened" || m.kind === "failed"),
      );
      for (const w of workers) tell(w, { kind: "open", id: round, path });
      for (const m of await Promise.all(settled)) {
        if (m.kind === "failed") failures.push(m.error);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `${failures.length} of ${WORKERS * ROUNDS} concurrent opens died in the constructor`,
    );
  } finally {
    for (const w of workers) w.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── durability of the write-ahead record ─────────────────────────────────────

test("[sqlite] the write-ahead effect record is what survives a restart", async () => {
  // `effect.started` is appended and awaited immediately before an irreversible tool
  // runs, precisely so that a crash leaves evidence the effect may have reached the
  // world. This pins the property the durability pragma exists to protect: after a
  // restart, folding the journal must still report the key as unknown. If the record
  // is lost, the fold is perfectly self-consistent and reports a CLEAN stop — the
  // failure has no symptom, which is why it needs a test of its own.
  const dir = mkdtempSync(join(tmpdir(), "loom-wal-intent-"));
  const path = join(dir, "journal.db");
  const run = "01JRUNINTENT00000000000000" as RunId;
  const task = "send-email@root#0" as TaskId;
  const key = "send-email@root#0:tool:0";
  try {
    const first = new SqliteStateStore({ path });
    await first.append({
      runId: run,
      expectedSeq: 0,
      events: [
        { type: "run.started", payload: { posture: "in" }, actor: SYSTEM_ACTOR("test") },
        {
          type: "effect.started",
          payload: { key, kind: "tool", attempt: 0 },
          actor: SYSTEM_ACTOR("test"),
          taskId: task,
        },
      ],
    });
    first.close();

    const second = new SqliteStateStore({ path });
    const projection = foldRun(await Array.fromAsync(second.read(run, 1)));
    second.close();
    assert.ok(projection);
    assert.deepEqual(projection.unknownEffects, [key], "a restart must not turn an open effect into a clean stop");
    assert.deepEqual(projection.startedEffects, [key]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("[sqlite] the durability knob changes only durability, never behaviour", async () => {
  // `synchronous` is per-connection state and `#db` is private, so the pragma itself
  // is not observable from out here, and the loss it prevents needs a power cut — no
  // offline test can prove the fsync happened. What a test CAN pin is that this is a
  // durability knob and nothing else: both values must yield the same events, the same
  // head and the same fold, so no semantic difference can later be smuggled in behind
  // it.
  const dir = mkdtempSync(join(tmpdir(), "loom-sync-knob-"));
  const run = "01JRUNSYNCKNOB000000000000" as RunId;
  try {
    const read = async (mode: "full" | "normal"): Promise<unknown> => {
      const store = new SqliteStateStore({ path: join(dir, `${mode}.db`), synchronous: mode, now: () => 7 });
      await store.append({
        runId: run,
        expectedSeq: 0,
        events: [
          { type: "run.started", payload: { posture: "in" }, actor: SYSTEM_ACTOR("test") },
          { type: "effect.started", payload: { key: "k:tool:0", kind: "tool", attempt: 0 }, actor: SYSTEM_ACTOR("test") },
        ],
      });
      const events = await Array.fromAsync(store.read(run, 1));
      const head = await store.head(run);
      store.close();
      return { head, events, fold: foldRun(events) };
    };
    assert.deepEqual(await read("full"), await read("normal"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EVENT_TYPES matches the EventPayloads key set", () => {
  // EVENT_TYPES is `as const satisfies readonly EventType[]`, so the compiler already rejects
  // an entry that is NOT an EventType. The other direction — a payload added to the map and
  // forgotten in the runtime list — is what this test claimed to catch and did not: neither a
  // duplicate check nor a length of 52 changes when a key is added only to `EventPayloads`.
  //
  // Reproduced before fixing. With one extra key in the map and nothing added here, this file
  // passed 65/0, `audit-coverage.test.ts` passed 3/0, `docs-drift.test.ts` passed 42/0, and
  // `tsc` exited 0 — so the type was fully appendable to the journal while being exempt from
  // its audit rule, from the excuse list that exists so an unruled type must be argued for,
  // from the has-an-appender check, and from D3.10's documented vocabulary. FOUR gates, every
  // one of them iterating this array, all switched off for that one type by an omission.
  assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length, "no duplicates");
  assert.equal(EVENT_TYPES.length, 52, "update this count when the vocabulary grows, deliberately");

  // THE MISSING DIRECTION, ENFORCED BY THE COMPILER RATHER THAN COUNTED. `Exclude` is empty
  // exactly when every `EventPayloads` key appears in the array; when it is not, this fails to
  // COMPILE and the error names the absent keys, which no runtime scan of a type could do.
  // Wrapped in tuples so a union does not distribute across the conditional.
  const exhaustive: [Exclude<EventType, (typeof EVENT_TYPES)[number]>] extends [never]
    ? true
    : Exclude<EventType, (typeof EVENT_TYPES)[number]> = true;
  assert.equal(exhaustive, true);
});

// ── depth on the durable write path ──────────────────────────────────────────

/**
 * The limit `canonicalize` enforces, mirrored here as a literal.
 *
 * It is deliberately NOT imported: `scripts/check-surface.mjs` pins the exported NAME
 * SET of `@loom/core`, `index.ts` re-exports all of `canonical.ts`, and adding a public
 * export is a reviewed act that re-pins `surface.json`. So the constant stays private and
 * this literal is the coupling. If it ever disagrees with `canonical.ts`, these tests fail
 * — which is the intent.
 */
const MAX_DEPTH = 256;

/** `depth` nested containers around a leaf. A loop, so building it cannot itself overflow. */
function nest(depth: number, kind: "object" | "array" = "object"): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = kind === "object" ? { a: v } : [v];
  return v;
}

const STORES: readonly { name: string; create: () => StateStore }[] = [
  { name: "memory", create: () => new MemoryStateStore({ now: () => 5 }) },
  { name: "sqlite", create: () => new SqliteStateStore({ path: ":memory:", now: () => 5 }) },
];

for (const { name, create } of STORES) {
  test(`[${name}] append REFUSES an over-deep payload instead of overflowing the stack`, async () => {
    // MEASURED, not guessed: on this machine (Node 24.16, default stack) the unbounded
    // recursion in `canonicalize` dies at a nesting depth of 5700 flat, and lower the
    // deeper the caller already is — 5100 under 1000 caller frames, 3800 under 3000. So
    // 20_000 is comfortably past it and the pre-fix failure is a bare
    // `RangeError: Maximum call stack size exceeded` thrown out of the durable write path.
    //
    // Invariant 2 says the journal is the only authoritative durable state. A write path
    // that dies with an untyped host error tells no caller what to do — it is neither a
    // `validation` refusal a caller can fix nor a `unavailable` one they can retry.
    const store = create();
    const run = `01JRUNDEEP${name.toUpperCase()}00000000000`.slice(0, 26) as RunId;
    try {
      await assert.rejects(
        () =>
          store.append({
            runId: run,
            expectedSeq: 0,
            events: [
              {
                type: "operator.command",
                payload: { kind: "probe", args: { deep: nest(20_000) } },
                actor: SYSTEM_ACTOR("test"),
              },
            ],
          }),
        (e: unknown) => {
          assert.ok(
            isLoomError(e),
            `expected a LoomError, got ${(e as Error)?.name}: ${String((e as Error)?.message).slice(0, 80)}`,
          );
          assert.equal(e.code, CODES.E_PAYLOAD_TOO_DEEP);
          assert.equal(e.class, "validation");
          assert.equal(e.retryable, false, "a deeper retry of the same value cannot succeed");
          return true;
        },
      );
      // REFUSED MEANS NOTHING LANDED. `prepare` runs before any row is written, so the
      // batch is rejected whole; a half-written batch would break the CAS the next
      // append performs against `expectedSeq`.
      assert.equal(await store.head(run), 0);
    } finally {
      store.close();
    }
  });

  test(`[${name}] append refuses an over-deep ACTOR too`, async () => {
    // `prepare` canonicalizes the actor as well as the payload — two calls, one line apart —
    // so the guard has to cover both. `Actor` has no `unknown`-typed field, so reaching this
    // needs a cast — which is exactly what the control plane does when it builds an actor
    // out of external identity data, and what the type system cannot police at a process
    // boundary.
    const store = create();
    const run = `01JRUNACTR${name.toUpperCase()}00000000000`.slice(0, 26) as RunId;
    try {
      await assert.rejects(
        () =>
          store.append({
            runId: run,
            expectedSeq: 0,
            events: [
              {
                type: "run.started",
                payload: { posture: "in" },
                actor: { kind: "system", component: "test", rule: nest(20_000) } as unknown as Actor,
              },
            ],
          }),
        (e: unknown) => {
          assert.ok(isLoomError(e), `expected a LoomError, got ${(e as Error)?.name}`);
          assert.equal(e.code, CODES.E_PAYLOAD_TOO_DEEP);
          return true;
        },
      );
      assert.equal(await store.head(run), 0);
    } finally {
      store.close();
    }
  });

  test(`[${name}] the limit is the mechanism, not the stack: depth ${MAX_DEPTH} appends, ${MAX_DEPTH + 1} does not`, async () => {
    // Both of these depths canonicalize fine on today's stack, so this pair pins the
    // BOUNDARY rather than the crash — the difference between "we chose a limit" and "we
    // happened to survive". The accepted side also round-trips, which is what makes the
    // limit a promise about stored data rather than about a rejection message.
    const store = create();
    const ok = `01JRUNEDGE${name.toUpperCase()}00000000000`.slice(0, 26) as RunId;
    const bad = `01JRUNOVER${name.toUpperCase()}00000000000`.slice(0, 26) as RunId;
    try {
      // The payload itself is a container and `args` is a second, so the nest under
      // `args.deep` starts at depth 2 and may be at most MAX_DEPTH - 2 containers tall.
      // Stating the arithmetic rather than a bare literal is the point: the limit is on
      // the WHOLE journaled value, envelope included, not on the interesting part of it.
      await store.append({
        runId: ok,
        expectedSeq: 0,
        events: [
          {
            type: "operator.command",
            payload: { kind: "probe", args: { deep: nest(MAX_DEPTH - 2, "array") } },
            actor: SYSTEM_ACTOR("test"),
          },
        ],
      });
      const [event] = await Array.fromAsync(store.read(ok, 1));
      assert.deepEqual(event?.payload, { kind: "probe", args: { deep: nest(MAX_DEPTH - 2, "array") } });

      await assert.rejects(
        () =>
          store.append({
            runId: bad,
            expectedSeq: 0,
            events: [
              {
                type: "operator.command",
                payload: { kind: "probe", args: { deep: nest(MAX_DEPTH - 1, "array") } },
                actor: SYSTEM_ACTOR("test"),
              },
            ],
          }),
        (e: unknown) => {
          assert.ok(isLoomError(e), `expected a LoomError, got ${(e as Error)?.name}`);
          assert.equal(e.code, CODES.E_PAYLOAD_TOO_DEEP);
          return true;
        },
      );
    } finally {
      store.close();
    }
  });

  test(`[${name}] the limit is on DEPTH, not size — a wide shallow payload still appends`, async () => {
    // Guards against the cure becoming a payload-size cap by accident. 20_000 sibling keys
    // canonicalize to a few hundred kilobytes — far more BYTES than any value these tests
    // refuse — while nesting exactly two levels.
    const store = create();
    const run = `01JRUNWIDE${name.toUpperCase()}00000000000`.slice(0, 26) as RunId;
    try {
      const args: Record<string, unknown> = {};
      for (let i = 0; i < 20_000; i++) args[`k${i}`] = i;
      const seq = await store.append({
        runId: run,
        expectedSeq: 0,
        events: [{ type: "operator.command", payload: { kind: "wide", args }, actor: SYSTEM_ACTOR("test") }],
      });
      assert.equal(seq.seq, 1);
    } finally {
      store.close();
    }
  });
}

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


// ── raisedAGate: the same answer from both stores ────────────────────────────

test("BOTH STORES ANSWER `raisedAGate` THE SAME WAY — ordered by the most recent gate", async () => {
  // The two implementations are structurally different — SQLite joins against an index, the
  // memory store scans — so "they agree" is a claim that has to be asked of both rather than
  // reasoned about once. It is load-bearing: `GateSweeper` is the SLA clock and it runs against
  // whichever store a deployment configured, so a divergence here is a gate that expires on one
  // and never on the other.
  const dir = mkdtempSync(join(tmpdir(), "loom-gated-"));
  // AN INJECTED, ADVANCING CLOCK, so the ordering assertion is about `ts` and not about the
  // tiebreak. Without it every append lands in the same millisecond, `run_id DESC` decides, and
  // the last assertion below passes for a reason it does not claim — which is the failure mode
  // that put `MAX(seq)` in here in the first place.
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const sqlite = new SqliteStateStore({ path: join(dir, "j.db"), now });
  const memory = new MemoryStateStore({ now });
  const actor: Actor = SYSTEM_ACTOR("t");

  try {
    for (const store of [sqlite, memory] as StateStore[]) {
      clock.t = 1_700_000_000_000;
      // Three runs. The OLDEST gates; the two newer ones never do — which is exactly the shape
      // that used to hide a gate behind newer runs.
      await store.append({
        runId: "r-1" as never,
        expectedSeq: 0,
        events: [
          { type: "run.started", payload: { posture: "on" }, actor },
          { type: "gate.raised", payload: { gateId: "g1", nodeId: "n", approvers: [], kind: "policy" }, actor },
        ] as never,
      });
      clock.t += 1000;
      await store.append({ runId: "r-2" as never, expectedSeq: 0, events: [{ type: "run.started", payload: { posture: "on" }, actor }] as never });
      clock.t += 1000;
      await store.append({ runId: "r-3" as never, expectedSeq: 0, events: [{ type: "run.started", payload: { posture: "on" }, actor }] as never });

      const all = (await store.listRuns(10)).map((r) => r.runId);
      const gated = (await store.listRuns(10, { raisedAGate: true })).map((r) => r.runId);

      assert.deepEqual([...all].sort(), ["r-1", "r-2", "r-3"], "the unfiltered listing still returns everything");
      assert.deepEqual(gated, ["r-1"], "and the filtered one returns only the run that raised a gate");

      // A LIMIT OF 1 IS THE WHOLE POINT. Unfiltered it returns the newest RUN; filtered it
      // returns the run with the newest GATE — and those are different runs, which is B7.
      assert.deepEqual((await store.listRuns(1)).map((r) => r.runId), ["r-3"], "unfiltered: newest run");
      assert.deepEqual((await store.listRuns(1, { raisedAGate: true })).map((r) => r.runId), ["r-1"], "filtered: newest GATE");

      // Ordering among gated runs is by the most recent gate, not by run id.
      // THE ORDERING CASE, CONSTRUCTED SO seq AND ts DISAGREE — and the first version of this
      // was not. It gave both runs a gate as their second event, so `MAX(seq)` tied at 2, the
      // `run_id DESC` tiebreak produced the expected answer, and reverting the fix to `MAX(seq)`
      // left the test green. A test whose two candidate implementations agree distinguishes
      // nothing.
      //
      // Here r-1 gets three filler events so its gate lands at a HIGHER seq than r-2's, while
      // r-2 gates strictly LATER in ts. `MAX(seq)` puts r-1 first; `MAX(ts)` puts r-2 first;
      // the tiebreak never runs because there is no tie. Only the correct implementation passes.
      for (let i = 0; i < 3; i++) {
        clock.t += 1;
        await store.append({
          runId: "r-1" as never,
          expectedSeq: (2 + i) as never,
          events: [{ type: "task.progress", payload: { chunk: "filler" }, actor }] as never,
        });
      }
      clock.t += 1;
      await store.append({
        runId: "r-1" as never,
        expectedSeq: 5 as never,
        events: [{ type: "gate.raised", payload: { gateId: "g1b", nodeId: "n", approvers: [], kind: "policy" }, actor }] as never,
      });

      clock.t += 1000; // strictly later than every r-1 event, and at a LOWER seq
      await store.append({
        runId: "r-2" as never,
        expectedSeq: 1,
        events: [{ type: "gate.raised", payload: { gateId: "g2", nodeId: "n", approvers: [], kind: "policy" }, actor }] as never,
      });

      assert.deepEqual(
        (await store.listRuns(10, { raisedAGate: true })).map((r) => r.runId),
        ["r-2", "r-1"],
        "r-2 gated LATER (ts 2000-ish, seq 2); r-1 gated EARLIER at a HIGHER seq (6). Ordering by seq " +
          "would put r-1 first — seq is per-run and does not compare across runs",
      );
    }
  } finally {
    sqlite.close();
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
