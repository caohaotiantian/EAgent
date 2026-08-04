/**
 * The durable StateStore, on Node's built-in SQLite.
 *
 * `node:sqlite` is a builtin, which is the whole reason `@loom/core` can have a real
 * SQL durable store and still declare zero runtime dependencies — and therefore why
 * the single-binary deployment is possible at all (D12.1).
 *
 * Two details carry the correctness:
 *
 *   - `BEGIN IMMEDIATE` takes the write lock at statement one, so the
 *     read-head / check-expected / insert / update-head sequence cannot interleave
 *     with another writer. Plain `BEGIN` (deferred) would upgrade mid-transaction
 *     and could fail with SQLITE_BUSY after we had already decided the CAS passed.
 *   - `WITHOUT ROWID` on the journal with `PRIMARY KEY (run_id, seq)` stores rows
 *     clustered in read order, so a fold is a sequential scan rather than an index
 *     lookup per row.
 */

import { DatabaseSync } from "node:sqlite";

import { canonicalize } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { RunId, Seq, TaskId } from "../ids.ts";
import type { JournalEvent } from "./events.ts";
import {
  type AppendInput,
  type AppendResult,
  type RunSummary,
  type StateStore,
  fencingStale,
  prepare,
  seqConflict,
} from "./store.ts";

const SCHEMA_VERSION = 1;

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
  last_ts  INTEGER NOT NULL
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

export interface SqliteStateStoreOptions {
  /** File path, or ":memory:". */
  readonly path: string;
  readonly now?: () => number;
  /** Rows fetched per page by `read`. Bounds memory on a long journal. */
  readonly pageSize?: number;
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

    // WAL lets readers proceed during a write, which is what keeps the UI's tail
    // and the ops console from contending with the executor. NORMAL sync is the
    // standard WAL pairing: durable across process crash, and across OS crash it
    // can lose only the last transactions — acceptable because a lost tail simply
    // re-executes (at-least-once task execution, D12.5).
    if (opts.path !== ":memory:") {
      this.#db.exec("PRAGMA journal_mode = WAL");
      this.#db.exec("PRAGMA synchronous = NORMAL");
    }
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  #migrate(): void {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (row === undefined) {
      this.#db
        .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
      return;
    }
    const found = Number(row.value);
    if (found > SCHEMA_VERSION) {
      throw err.internal(
        CODES.E_INTERNAL,
        `journal schema version ${found} is newer than this build understands (${SCHEMA_VERSION})`,
      );
    }
    // No backward migrations yet; when there are, they run here, in order.
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

      const insert = db.prepare(
        `INSERT INTO journal (run_id, seq, ts, type, actor, task_id, payload, classification)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const r of rows) {
        insert.run(input.runId, r.seq, r.ts, r.type, r.actorJson, r.taskId, r.payloadJson, r.classification);
      }

      const last = rows[rows.length - 1]!;
      const first = rows[0]!;
      db.prepare(
        `INSERT INTO run_head (run_id, head_seq, first_ts, last_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET head_seq = excluded.head_seq, last_ts = excluded.last_ts`,
      ).run(input.runId, last.seq, first.ts, last.ts);

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

  async listRuns(limit = 100): Promise<readonly RunSummary[]> {
    this.#assertOpen();
    const rows = this.#db
      .prepare("SELECT run_id, head_seq, first_ts, last_ts FROM run_head ORDER BY run_id DESC LIMIT ?")
      .all(limit) as unknown as readonly { run_id: string; head_seq: number; first_ts: number; last_ts: number }[];
    return rows.map((r) => ({
      runId: r.run_id as RunId,
      headSeq: r.head_seq,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
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
