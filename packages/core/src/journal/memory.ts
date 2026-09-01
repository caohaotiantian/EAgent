/**
 * In-memory StateStore.
 *
 * Not a toy: it is the reference semantics. The conformance suite runs identically
 * against this and the SQLite store, which is how "swapping local → distributed
 * changes only implementations, never call sites" gets tested rather than asserted.
 * It also keeps the majority of the test suite fast and free of temp files.
 */

import { canonicalize } from "../canonical.ts";
import type { RunId, Seq, TaskId } from "../ids.ts";
import type { JournalEvent } from "./events.ts";
import {
  type AppendInput,
  type AppendResult,
  type RunFilter,
  type RunSummary,
  type StateStore,
  cursorNotFound,
  fencingStale,
  prepare,
  seqConflict,
  submitterOf,
} from "./store.ts";

interface RunLog {
  events: JournalEvent[];
  /** Highest fencing token seen per task, for the late-writer check. */
  fences: Map<string, number>;
  /**
   * The owner, established once when the run's first batch lands — `run_head.submitted_by`'s
   * counterpart, kept here rather than re-derived at list time so the two stores answer from
   * the same shape as well as the same function.
   */
  submittedBy?: string;
}

export class MemoryStateStore implements StateStore {
  readonly #runs = new Map<RunId, RunLog>();
  readonly #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? Date.now;
  }

  // The body runs to completion with no `await`, so on Node's single event loop the
  // read-check-write sequence is atomic. That is the same guarantee `BEGIN IMMEDIATE`
  // buys the SQLite store, expressed differently.
  async append(input: AppendInput): Promise<AppendResult> {
    const log = this.#runs.get(input.runId) ?? { events: [], fences: new Map<string, number>() };
    const headSeq = log.events.length === 0 ? 0 : log.events[log.events.length - 1]!.seq;
    if (headSeq !== input.expectedSeq) seqConflict(input.runId, input.expectedSeq, headSeq);

    if (input.fencingToken !== undefined && input.taskId !== undefined) {
      const seen = log.fences.get(input.taskId);
      if (seen !== undefined && input.fencingToken < seen) {
        fencingStale(input.taskId, input.fencingToken, seen);
      }
    }

    const rows = prepare(input, canonicalize, this.#now());
    // INSERT-ONLY, like the SQLite column: set when the run's row is created and never
    // rewritten, so a second `run.submitted` cannot move a run between owners under a reader.
    if (log.events.length === 0) {
      const owner = submitterOf(rows);
      if (owner !== undefined) log.submittedBy = owner;
    }
    for (const row of rows) {
      const base = {
        runId: input.runId,
        seq: row.seq,
        ts: row.ts,
        type: row.type,
        payload: JSON.parse(row.payloadJson) as never,
        actor: JSON.parse(row.actorJson) as never,
        classification: row.classification,
      };
      log.events.push((row.taskId === null ? base : { ...base, taskId: row.taskId as TaskId }) as JournalEvent);
    }

    if (input.fencingToken !== undefined && input.taskId !== undefined) {
      const seen = log.fences.get(input.taskId) ?? -1;
      log.fences.set(input.taskId, Math.max(seen, input.fencingToken));
    }
    this.#runs.set(input.runId, log);
    return { seq: rows[rows.length - 1]!.seq };
  }

  async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    const log = this.#runs.get(runId);
    if (!log) return;
    const end = toSeq ?? Number.MAX_SAFE_INTEGER;
    // Snapshot the length up front: a concurrent append during iteration must not
    // extend this read, so `read` always returns a consistent prefix.
    const limit = log.events.length;
    for (let i = 0; i < limit; i++) {
      const e = log.events[i]!;
      if (e.seq >= fromSeq && e.seq <= end) yield e;
    }
  }

  async head(runId: RunId): Promise<Seq> {
    const log = this.#runs.get(runId);
    if (!log || log.events.length === 0) return 0;
    return log.events[log.events.length - 1]!.seq;
  }

  async listRuns(limit = 100, filter?: RunFilter): Promise<readonly RunSummary[]> {
    const out: (RunSummary & { readonly gateTs?: number })[] = [];
    const mine = filter?.submittedByOrUnowned;
    const gated = filter?.raisedAGate === true;
    const after = filter?.after;
    for (const [runId, log] of this.#runs) {
      if (log.events.length === 0) continue;
      // A SCAN, where SQLite has an index — and that asymmetry is fine rather than a gap.
      // This store exists for tests and for an embedder with no file, so its journals are
      // small by construction; the SQL store is the one a deployment runs. What must NOT
      // differ is the ANSWER, which is why both order by the most recent `gate.raised` and
      // `test/journal/store-conformance.test.ts` asks the same question of both.
      // `ts` AND NOT `seq`, because `seq` is per-run: two runs that each gated on their second
      // event both have seq 2, and ordering by that is a tie between gates days apart. The SQL
      // store had the identical bug and the two agreed on it — see `listRuns` there.
      let gateTs: number | undefined;
      if (gated) {
        for (const e of log.events) if (e.type === "gate.raised") gateTs = Number(e.ts);
        if (gateTs === undefined) continue;
      }
      // Filtered BEFORE the slice below, matching the SQL store's `WHERE … LIMIT` order —
      // filtering after would make a low-volume principal's list empty on a busy journal and
      // would leak other principals' submission density through `limit`.
      if (mine !== undefined && log.submittedBy !== undefined && log.submittedBy !== mine) continue;
      out.push({
        runId,
        headSeq: log.events[log.events.length - 1]!.seq,
        firstTs: log.events[0]!.ts,
        lastTs: log.events[log.events.length - 1]!.ts,
        ...(log.submittedBy === undefined ? {} : { submittedBy: log.submittedBy }),
        ...(gateTs === undefined ? {} : { gateTs }),
      });
    }
    // Newest first, matching the SQLite store's ORDER BY — by the most recent GATE when that
    // is what was asked for, by run id otherwise.
    if (gated) out.sort((a, b) => (b.gateTs ?? 0) - (a.gateTs ?? 0) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
    else out.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
    // THE CURSOR IS AN INDEX INTO THE ORDER THAT WAS JUST PRODUCED, which is why it is applied
    // here and not while scanning: `after` names a position in the ORDER, and under
    // `raisedAGate` that order is by the most recent gate, not by run id. Finding the row in the
    // sorted array is the one formulation that cannot disagree with the sort above it — the SQL
    // store has to restate the ordering as a keyset predicate and could get that restatement
    // wrong, and `journal/conformance.ts` asking both the same question is what would catch it.
    //
    // REFUSED WHEN THE CURSOR IS NOT IN THIS ARRAY, identically to the SQL store and via the
    // same shared raiser: unknown run, another principal's run, or a run that never gated are
    // one answer, and none of them is "start again from the newest page".
    let from = 0;
    if (after !== undefined) {
      const at = out.findIndex((r) => r.runId === after);
      if (at < 0) cursorNotFound(after);
      // EXCLUSIVE — `at + 1`. The cursor row is the last row the caller already holds, so
      // including it would serve one run twice per page and a two-page walk would not advance.
      from = at + 1;
    }
    return out.slice(from, from + limit).map(({ gateTs: _drop, ...r }) => r);
  }

  close(): void {
    this.#runs.clear();
  }
}
