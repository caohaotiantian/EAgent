/**
 * The durable StateStore, on Node's built-in SQLite.
 *
 * `node:sqlite` is a builtin, which is the whole reason `@loom/core` can have a real
 * SQL durable store and still declare zero runtime dependencies — and therefore why
 * the single-binary deployment is possible at all (D12.1).
 *
 * Four details carry the correctness:
 *
 *   - `BEGIN IMMEDIATE` takes the write lock at statement one, so the
 *     read-head / check-expected / insert / update-head sequence cannot interleave
 *     with another writer. Plain `BEGIN` (deferred) would upgrade mid-transaction
 *     and could fail with SQLITE_BUSY after we had already decided the CAS passed.
 *   - `WITHOUT ROWID` on the journal with `PRIMARY KEY (run_id, seq)` stores rows
 *     clustered in read order, so a fold is a sequential scan rather than an index
 *     lookup per row.
 *   - **The constructor is a contended path, not a private one.** Several worker
 *     processes on one device is the shipped topology, so opening the journal is the
 *     first thing that contends and the first thing that can kill a worker. Two races
 *     live here, and each is answered where it happens: `busy_timeout` precedes the
 *     WAL conversion (which needs a brief exclusive lock) and the conversion retries
 *     with a pause; and the schema-version stamp is one conflict-clause statement
 *     rather than a read followed by an insert. Reorder either and it is measurable —
 *     6 processes opening 14 fresh journals lose 66 of 84 openers with the timeout
 *     placed after the conversion, and 70 of 84 with the stamp split in two. As
 *     written: 0 of 84, and 0 of 720 at 16 processes.
 *   - **`synchronous` defaults to FULL, not the usual WAL pairing of NORMAL.** See
 *     `SqliteStateStoreOptions.synchronous` for why the journal buys the fsync.
 */

import { DatabaseSync } from "node:sqlite";

import { canonicalize } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { RunId, Seq, TaskId } from "../ids.ts";
import type { JournalEvent } from "./events.ts";
import {
  type AppendInput,
  type AppendResult,
  type RunFilter,
  type RunSummary,
  type StateStore,
  fencingStale,
  prepare,
  seqConflict,
  submitterOf,
} from "./store.ts";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  run_id         TEXT    NOT NULL,
  seq            INTEGER NOT NULL,
  ts             INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  actor          TEXT    NOT NULL,
  task_id        TEXT,
  payload        TEXT    NOT NULL,
  classification TEXT    NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS journal_by_type ON journal (run_id, type, seq);
CREATE INDEX IF NOT EXISTS journal_by_task ON journal (run_id, task_id, seq);

-- Head is denormalised so the CAS is one indexed read rather than MAX(seq) over the log.
CREATE TABLE IF NOT EXISTS run_head (
  run_id   TEXT    PRIMARY KEY,
  head_seq INTEGER NOT NULL,
  first_ts INTEGER NOT NULL,
  last_ts  INTEGER NOT NULL,
  -- The submitting principal's SUBJECT, or NULL for a run nobody is recorded as owning.
  -- Derived from the run.submitted this transaction is writing, so it is a read model
  -- justified by the event beside it and rebuildable by folding. Written on INSERT only,
  -- like first_ts, because an owner a later append could rewrite is an owner a reader has
  -- already answered a question with.
  submitted_by TEXT
) WITHOUT ROWID;

-- Highest fencing token seen per task: stops a worker whose lease was stolen from
-- committing late.
CREATE TABLE IF NOT EXISTS task_fence (
  run_id    TEXT    NOT NULL,
  task_id   TEXT    NOT NULL,
  max_token INTEGER NOT NULL,
  PRIMARY KEY (run_id, task_id)
) WITHOUT ROWID;
`;

/** How long a contended statement waits before giving up (ms). */
const BUSY_TIMEOUT_MS = 5000;

/**
 * What the WAL conversion gets: a lower per-attempt wait, and several jittered tries.
 *
 * The conversion has two distinct failure modes and they want opposite treatments.
 *
 * When one connection simply holds the file, SQLite's busy handler *is* invoked and
 * waiting works — that is what `busy_timeout` buys, and why it has to be in force
 * before the conversion runs rather than after it.
 *
 * When several connections hold SHARED and each wants to promote to EXCLUSIVE, SQLite
 * skips the busy handler on purpose — waiting there would be a deadlock — and returns
 * SQLITE_BUSY in microseconds. That is a herd, and waiting cannot fix it. Nor can
 * retrying on its own: measured on a fresh journal opened by 6 processes at once,
 * immediate retries do not converge at any attempt count (3, 12, 40 and 120 attempts
 * all left 1-30 dead openers per 84). The herd has to be dispersed, so attempts are
 * separated by a jittered pause.
 *
 * The per-attempt timeout is below the steady-state one so that the whole loop stays
 * bounded: 12 x (500ms + pause) is the worst case before a loud failure, which is the
 * right order of magnitude for "this journal is not openable".
 */
const WAL_ATTEMPT_TIMEOUT_MS = 500;
const WAL_CONVERSION_ATTEMPTS = 12;

export interface SqliteStateStoreOptions {
  /** File path, or ":memory:". */
  readonly path: string;
  readonly now?: () => number;
  /** Rows fetched per page by `read`. Bounds memory on a long journal. */
  readonly pageSize?: number;
  /**
   * Whether a commit fsyncs the write-ahead log. Defaults to `"full"`, and ignored
   * for `":memory:"`.
   *
   * NORMAL is the conventional WAL pairing and it is wrong here. The journal holds
   * write-ahead records — `effect.started` is appended and awaited immediately before
   * an irreversible tool runs, for the sole purpose of leaving evidence if the process
   * never comes back. Under NORMAL the OS may lose the tail on power loss, and the
   * survivor is a perfectly self-consistent journal in which that effect never
   * started: the fold reports no unknown effects and a cancel reports a clean stop.
   * "A lost tail simply re-executes" is true of read-only work and false of exactly
   * the record this one exists for. Invariant 8 admits no exception for the journal.
   *
   * The rejected alternative was to keep NORMAL and force the barrier only before an
   * irreversible, non-idempotent action. It costs less, and it was rejected anyway:
   * it makes durability a property each call site has to remember to ask for (the
   * shape of bug this codebase already has one invariant about), it needs the set of
   * "records worth keeping" re-derived every time the 52-entry event vocabulary
   * grows, and it leaves the connection's durability depending on a pragma toggled
   * around each transaction, where one missed restore on a rollback path silently
   * downgrades the whole journal with no observable symptom.
   *
   * And the throughput argument does not survive measurement. Through this store's
   * own `append`, one event per call on APFS/SSD: NORMAL 24.0k/s, FULL 17.0k/s — a
   * 1.4x cost, and 3.4x over the 5k events/s target even though `task.progress` is
   * journaled per streamed chunk. (In an isolated commit loop the gap looks far worse,
   * 119k/s against 33k/s, because there the fsync is nearly the whole transaction;
   * `append` does a CAS read, an insert and a head update around it.) `PRAGMA
   * fullfsync` is the third option and is deliberately not taken: 225 commits/s, 22x
   * under target.
   *
   * Set `"normal"` for a throwaway journal — a dev loop, a fixture — where losing the
   * tail on power loss is genuinely free.
   */
  readonly synchronous?: "full" | "normal";
}

export class SqliteStateStore implements StateStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #pageSize: number;
  #closed = false;

  constructor(opts: SqliteStateStoreOptions) {
    this.#now = opts.now ?? Date.now;
    this.#pageSize = opts.pageSize ?? 500;
    this.#db = new DatabaseSync(opts.path);

    // Nothing below may run at SQLite's default zero busy timeout: every statement
    // here contends with peer worker processes, and at zero, contention is a crash
    // rather than a wait. The conversion gets the shorter of the two timeouts because
    // it also retries; see WAL_ATTEMPT_TIMEOUT_MS.
    if (opts.path !== ":memory:") {
      this.#db.exec(`PRAGMA busy_timeout = ${WAL_ATTEMPT_TIMEOUT_MS}`);
      // WAL lets readers proceed during a write, which is what keeps the UI's tail
      // and the ops console from contending with the executor.
      enableWal(this.#db);
      this.#db.exec(opts.synchronous === "normal" ? "PRAGMA synchronous = NORMAL" : "PRAGMA synchronous = FULL");
    }
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  #migrate(): void {
    let found = this.#schemaVersion();
    if (found === undefined) {
      // Bootstrap, and the second place the constructor meets a peer. The read above
      // cannot decide this on its own: two workers starting on the same fresh file
      // both see no row, and if each then inserted unconditionally the loser would die
      // on `UNIQUE constraint failed: meta.key` before its store existed. The conflict
      // clause makes the stamp idempotent, and the re-read takes whatever actually
      // landed — possibly a peer's, possibly a newer one, which the check below then
      // refuses.
      this.#db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO NOTHING")
        .run(String(SCHEMA_VERSION));
      found = this.#schemaVersion() ?? SCHEMA_VERSION;
    }
    if (found > SCHEMA_VERSION) {
      throw err.internal(
        CODES.E_INTERNAL,
        `journal schema version ${found} is newer than this build understands (${SCHEMA_VERSION})`,
      );
    }
    // Forward migrations, in order, each one transaction.
    //
    // THE STAMP IS PART OF THE MIGRATION, not a step after it. `#schemaVersion` writes the
    // stamp ONLY in the bootstrap arm above, so an existing file keeps reading its old
    // version forever — a DDL statement placed here without an accompanying `UPDATE` re-runs
    // on every open and the second one throws `duplicate column name` out of the constructor.
    // Every process after the first upgrade would be dead.
    //
    // AND IT IS `BEGIN IMMEDIATE`, for the reason the stamp itself is one conflict-clause
    // statement rather than a read followed by an insert (see this file's header): two
    // workers opening the same v1 file both read `1`, and the loser must find the work
    // already done rather than repeat it. The version is re-read INSIDE the transaction, so
    // the loser sees the winner's stamp and does nothing.
    if (found < 2) this.#migrateInTransaction(2, "ALTER TABLE run_head ADD COLUMN submitted_by TEXT");
  }

  /**
   * One forward migration: re-check, apply, stamp — atomically.
   *
   * The re-read is not belt-and-braces. `#migrate` decided to call this by reading the
   * version OUTSIDE any transaction, which is exactly the read-then-write this file's header
   * measured 70 failures out of 84 for; the second read is what makes a peer's completed
   * migration visible before this one repeats it.
   */
  #migrateInTransaction(to: number, ...statements: readonly string[]): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if ((this.#schemaVersion() ?? 0) >= to) {
        this.#db.exec("COMMIT");
        return;
      }
      for (const sql of statements) this.#db.exec(sql);
      this.#db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(to));
      this.#db.exec("COMMIT");
    } catch (e) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone; the original failure is the one worth reporting.
      }
      throw e;
    }
  }

  /** The stamp, or `undefined` on a journal that has never been stamped. */
  #schemaVersion(): number | undefined {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : Number(row.value);
  }

  async append(input: AppendInput): Promise<AppendResult> {
    this.#assertOpen();
    const rows = prepare(input, canonicalize, this.#now());

    const db = this.#db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const head = db.prepare("SELECT head_seq FROM run_head WHERE run_id = ?").get(input.runId) as
        | { head_seq: number }
        | undefined;
      const headSeq = head?.head_seq ?? 0;
      if (headSeq !== input.expectedSeq) seqConflict(input.runId, input.expectedSeq, headSeq);

      if (input.fencingToken !== undefined && input.taskId !== undefined) {
        const fence = db
          .prepare("SELECT max_token FROM task_fence WHERE run_id = ? AND task_id = ?")
          .get(input.runId, input.taskId) as { max_token: number } | undefined;
        if (fence !== undefined && input.fencingToken < fence.max_token) {
          fencingStale(input.taskId, input.fencingToken, fence.max_token);
        }
      }

      // The owner this batch establishes, read back out of the canonicalized bytes rather
      // than out of the caller's object — see `submitterOf`.
      const owner = submitterOf(rows) ?? null;

      const insert = db.prepare(
        `INSERT INTO journal (run_id, seq, ts, type, actor, task_id, payload, classification)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(input.runId, r.seq, r.ts, r.type, r.actorJson, r.taskId, r.payloadJson, r.classification);
      }

      const last = rows[rows.length - 1]!;
      const first = rows[0]!;
      // `submitted_by` is absent from the DO UPDATE clause on purpose, exactly like
      // `first_ts`: the owner is established when the row is created and no later append may
      // rewrite it. The fold makes the same decision on the first `run.submitted` it sees,
      // including when that first answer is "nobody" — the two must agree or the list route
      // and the detail route answer differently about who owns a run.
      db.prepare(
        `INSERT INTO run_head (run_id, head_seq, first_ts, last_ts, submitted_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET head_seq = excluded.head_seq, last_ts = excluded.last_ts`,
      ).run(input.runId, last.seq, first.ts, last.ts, owner);

      if (input.fencingToken !== undefined && input.taskId !== undefined) {
        db.prepare(
          `INSERT INTO task_fence (run_id, task_id, max_token) VALUES (?, ?, ?)
           ON CONFLICT (run_id, task_id) DO UPDATE SET max_token = MAX(max_token, excluded.max_token)`,
        ).run(input.runId, input.taskId, input.fencingToken);
      }

      db.exec("COMMIT");
      return { seq: last.seq };
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back by SQLite; a failing rollback must not mask the cause.
      }
      throw e;
    }
  }

  async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    this.#assertOpen();
    // Pin the upper bound before the first page. Without this, a concurrent append
    // during iteration would extend the read and the caller would see a prefix that
    // never existed as a consistent state.
    const end = toSeq ?? (await this.head(runId));
    const stmt = this.#db.prepare(
      `SELECT run_id, seq, ts, type, actor, task_id, payload, classification
       FROM journal WHERE run_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?`,
    );
    let cursor = fromSeq;
    while (cursor <= end) {
      const page = stmt.all(runId, cursor, end, this.#pageSize) as unknown as readonly JournalRow[];
      if (page.length === 0) return;
      for (const row of page) yield hydrate(row);
      cursor = page[page.length - 1]!.seq + 1;
    }
  }

  async head(runId: RunId): Promise<Seq> {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT head_seq FROM run_head WHERE run_id = ?").get(runId) as
      | { head_seq: number }
      | undefined;
    return row?.head_seq ?? 0;
  }

  async listRuns(limit = 100, filter?: RunFilter): Promise<readonly RunSummary[]> {
    this.#assertOpen();
    // FILTERED IN SQL, BEFORE THE LIMIT. Selecting the newest N and filtering in JS answers
    // the wrong question: a principal with few runs on a busy deployment gets an empty list
    // because all N belong to others, and the count that survives varies with `limit` in a
    // way that measures OTHER principals' submission rate.
    //
    // `IS NULL` is the permissive half, and it is in the same statement rather than a second
    // query because "mine, plus the ones nobody owns" is one question.
    const mine = filter?.submittedByOrUnowned;
    const rows = (
      mine === undefined
        ? this.#db
            .prepare("SELECT run_id, head_seq, first_ts, last_ts, submitted_by FROM run_head ORDER BY run_id DESC LIMIT ?")
            .all(limit)
        : this.#db
            .prepare(
              `SELECT run_id, head_seq, first_ts, last_ts, submitted_by FROM run_head
               WHERE submitted_by IS NULL OR submitted_by = ? ORDER BY run_id DESC LIMIT ?`,
            )
            .all(mine, limit)
    ) as unknown as readonly {
      run_id: string;
      head_seq: number;
      first_ts: number;
      last_ts: number;
      submitted_by: string | null;
    }[];
    return rows.map((r) => ({
      runId: r.run_id as RunId,
      headSeq: r.head_seq,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      ...(r.submitted_by === null ? {} : { submittedBy: r.submitted_by }),
    }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw err.internal(CODES.E_INTERNAL, "state store is closed");
  }
}

/**
 * Put the database into WAL mode, tolerating a peer that is mid-conversion.
 *
 * Reads the resulting mode back rather than trusting the statement to throw: a
 * conversion that quietly declines and leaves the file in rollback mode would cost
 * every reader its concurrency, silently.
 */
function enableWal(db: DatabaseSync): void {
  let reason = "";
  for (let attempt = 0; attempt < WAL_CONVERSION_ATTEMPTS; attempt++) {
    if (attempt > 0) disperse(attempt);
    try {
      const row = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | undefined;
      const mode = row?.journal_mode ?? "";
      if (mode.toLowerCase() === "wal") return;
      reason = `journal_mode came back as ${mode || "nothing"}`;
    } catch (e) {
      if (!isLockContention(e)) throw e;
      reason = e instanceof Error ? e.message : String(e);
    }
  }
  throw err.internal(
    CODES.E_INTERNAL,
    `could not put the journal into WAL mode after ${WAL_CONVERSION_ATTEMPTS} attempts: ${reason}`,
  );
}

/** A parking spot for `Atomics.wait`. Never notified; only ever timed out on. */
const PARK = new Int32Array(new SharedArrayBuffer(4));

/** Per-process backoff sequence, seeded so that no two workers share one. */
let dispersal = (Math.imul(process.pid, 2654435761) ^ 0x9e3779b9) >>> 0;

/**
 * Pause between conversion attempts, long enough to break the herd apart.
 *
 * Synchronous, because the constructor is: a `setTimeout` would need an async
 * constructor, and a spin loop would hold the CPU the peer needs to finish
 * converting. `Atomics.wait` parks the thread without either.
 *
 * The jitter is the part that does the work. A fixed pause leaves the herd in
 * lockstep — the workers collide, all wait the same amount, and collide again — so
 * the pause is drawn from a sequence seeded by pid, and *advances every attempt* so
 * that two workers who happen to draw the same first pause diverge on the next one.
 * The window widens with each attempt so a large herd still drains. None of this
 * reaches the journal; it only decides who reaches the lock first, so it is not
 * nondeterminism replay has to record.
 */
function disperse(attempt: number): void {
  dispersal = (Math.imul(dispersal, 1664525) + 1013904223) >>> 0;
  const spread = Math.min(attempt, 8) * 4 + 4;
  Atomics.wait(PARK, 0, 0, 1 + (dispersal % spread));
}

/**
 * SQLITE_BUSY (5) or SQLITE_LOCKED (6) — another connection holds the lock.
 *
 * Matched on the numeric result code `node:sqlite` attaches, not the message, which
 * is prose and may be translated or reworded.
 */
function isLockContention(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("errcode" in e)) return false;
  const code = (e as { errcode: unknown }).errcode;
  return code === 5 || code === 6;
}

interface JournalRow {
  run_id: string;
  seq: number;
  ts: number;
  type: string;
  actor: string;
  task_id: string | null;
  payload: string;
  classification: string;
}

function hydrate(row: JournalRow): JournalEvent {
  const base = {
    runId: row.run_id as RunId,
    seq: row.seq,
    ts: row.ts,
    type: row.type,
    payload: JSON.parse(row.payload) as never,
    actor: JSON.parse(row.actor) as never,
    classification: row.classification,
  };
  // Built conditionally rather than assigning undefined: with
  // exactOptionalPropertyTypes, `taskId?: TaskId` and `taskId: TaskId | undefined`
  // are different types, and the journal's absent-vs-present distinction is real.
  return (row.task_id === null ? base : { ...base, taskId: row.task_id as TaskId }) as JournalEvent;
}
