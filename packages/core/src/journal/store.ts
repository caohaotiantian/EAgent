/**
 * The durable write path.
 *
 * `append` is a compare-and-swap on `expectedSeq`. That single decision is what
 * converts at-least-once *task execution* into exactly-once *state*: two workers
 * racing the same Task both compute results, exactly one commit lands, and the loser
 * gets E_SEQ_CONFLICT and discards its work. Nothing else in the system needs a
 * distributed lock.
 *
 * `fencingToken` closes the second race: a worker whose lease expired and was
 * re-issued to someone else must not be able to commit late. Tokens are monotonic
 * per (run, task); a write carrying a token below the highest already seen is
 * rejected with E_FENCING_STALE.
 *
 * See design/loom/01-INTERFACES.md D3.10 and 07-CONFIG-DEPLOY.md D12.5.
 */

import { CODES, err } from "../errors.ts";
import type { RunId, Seq, TaskId } from "../ids.ts";
import type { Classification, EventType, JournalEvent, NewEvent } from "./events.ts";

export interface AppendInput {
  readonly runId: RunId;
  /** The seq the caller believes is current. 0 for the first append of a run. */
  readonly expectedSeq: Seq;
  /** Committed atomically as one transaction, or not at all. */
  readonly events: readonly NewEvent[];
  /** Monotonic per (runId, taskId). Required whenever `taskId` is set by a leased worker. */
  readonly fencingToken?: number;
  /** Scope for fencing. Usually every event in the batch shares it. */
  readonly taskId?: TaskId;
  /** Injected clock, so tests and replay are not wall-clock dependent. */
  readonly now?: number;
}

export interface AppendResult {
  /** The seq of the LAST event written. */
  readonly seq: Seq;
}

export interface RunSummary {
  readonly runId: RunId;
  readonly headSeq: Seq;
  readonly firstTs: number;
  readonly lastTs: number;
}

export interface StateStore {
  /**
   * Conditional append. Rejects with:
   *   - E_SEQ_CONFLICT   `expectedSeq` did not match the current head
   *   - E_FENCING_STALE  a higher fencing token already wrote for this task
   *
   * Deliberately takes no AbortSignal: it is one small transaction, and a
   * half-cancelled durable write is exactly the thing this interface must not have.
   */
  append(input: AppendInput): Promise<AppendResult>;

  /** Inclusive on both ends. `fromSeq` of 1 reads from the beginning. */
  read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent>;

  /** 0 if the run has no events. */
  head(runId: RunId): Promise<Seq>;

  listRuns(limit?: number): Promise<readonly RunSummary[]>;

  close(): void;
}

// ---------------------------------------------------------------------------
// Shared validation — identical semantics for every implementation
// ---------------------------------------------------------------------------

const DEFAULT_CLASSIFICATION: Classification = "internal";

export interface PreparedEvent {
  readonly seq: Seq;
  readonly ts: number;
  readonly type: EventType;
  readonly payloadJson: string;
  readonly actorJson: string;
  readonly taskId: string | null;
  readonly classification: Classification;
}

/**
 * Turn a batch into positioned rows. Pure, so both stores share exactly one
 * definition of "what an append means" — the reason a conformance suite can hold
 * them to the same behaviour.
 *
 * THE TWO `canonicalize` CALLS BELOW ARE THE ONLY UNBOUNDED RECURSION ON THE DURABLE WRITE
 * PATH, and a deeply nested payload used to take them — and the process — down with a bare
 * `RangeError: Maximum call stack size exceeded`. That is the one failure mode invariant 2
 * cannot have: a durable write that fails in a vocabulary no caller branches on is neither
 * a refusal they can fix nor a fault they can retry. (Everything else here iterates. The
 * memory store's `JSON.parse` of `payloadJson` does recurse, but only over text this
 * function already produced, so it inherits the bound rather than needing its own.)
 *
 * The depth bound is enforced by the INJECTED FUNCTION, not by this one — `canonical.ts`
 * raises `E_PAYLOAD_TOO_DEEP` (class `validation`) and both stores inject it. The signature
 * deliberately keeps taking any `(v: unknown) => string`, so this function guarantees only
 * that it is TOTAL OR NOTHING: it is pure, it canonicalizes before returning a single row,
 * and both stores call it before they touch storage (SQLite before `BEGIN IMMEDIATE`,
 * memory before its first `push`). A refusal therefore rejects the whole batch and leaves
 * the head where it was. `test/journal/store.test.ts` tests that composition against both
 * stores, because the composition is what an append actually is.
 *
 * WHAT IS NOT PINNED, and was not before this either: the two stores disagree about WHICH
 * refusal wins when a batch is both stale and unrepresentable. Memory checks the CAS first,
 * SQLite canonicalizes first, so one append reports `E_SEQ_CONFLICT` and the other
 * `E_PAYLOAD_TOO_DEEP` for the same call — measured, not inferred. Both are honest
 * refusals and neither writes anything, so this is a precedence difference rather than a
 * durability one; it belongs to `memory.ts` and `sqlite.ts`, and `journal/conformance.ts`
 * is where a decision about it would be pinned.
 */
export function prepare(
  input: AppendInput,
  canonicalize: (v: unknown) => string,
  now: number,
): readonly PreparedEvent[] {
  if (input.events.length === 0) {
    throw err.validation(CODES.E_INTERNAL, "append requires at least one event");
  }
  if (!Number.isInteger(input.expectedSeq) || input.expectedSeq < 0) {
    throw err.validation(CODES.E_INTERNAL, `expectedSeq must be a non-negative integer, got ${input.expectedSeq}`);
  }
  const ts = input.now ?? now;
  return input.events.map((e, i) => ({
    seq: input.expectedSeq + i + 1,
    ts: e.ts ?? ts,
    type: e.type,
    payloadJson: canonicalize(e.payload),
    actorJson: canonicalize(e.actor),
    taskId: e.taskId ?? input.taskId ?? null,
    classification: e.classification ?? DEFAULT_CLASSIFICATION,
  }));
}

export function seqConflict(runId: RunId, expected: Seq, actual: Seq): never {
  throw err.conflict(
    CODES.E_SEQ_CONFLICT,
    `run ${runId}: expected seq ${expected}, head is ${actual}`,
    { details: { runId, expected, actual } },
  );
}

export function fencingStale(taskId: TaskId, token: number, seen: number): never {
  throw err.conflict(
    CODES.E_FENCING_STALE,
    `task ${taskId}: fencing token ${token} is stale, ${seen} already wrote`,
    { details: { taskId, token, seen } },
  );
}
