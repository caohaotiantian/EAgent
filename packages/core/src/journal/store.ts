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
  /**
   * The SUBJECT of the principal this run was submitted for, or absent for nobody.
   *
   * The subject alone, not the whole `SubmittedBy`. `GET /runs` sends `RunSummary[]` with no
   * redaction pass, and `kind` plus `method` describe the deployment's identity topology —
   * which sources exist, which principals are services — rather than naming the owner. The
   * precedent is `GateRecord.decidedBy`, narrowed to a `kind` for the same reason: decide
   * what a reader needs before the value reaches the wire, not after.
   */
  readonly submittedBy?: string;
}

/** Which runs a listing should return. Absent fields do not filter. */
export interface RunFilter {
  /**
   * Only runs this subject owns, PLUS runs nobody owns.
   *
   * The permissive half is not an oversight and it is why this is one field rather than two:
   * a run with no recorded principal is readable by every authenticated caller, so that every
   * journal written before ownership existed stays reachable after an upgrade. A caller that
   * wants strictly-mine has no use for it — the answer would be a subset of a set it already
   * has — and offering the knob would invite a reader to assume the default is the strict one.
   */
  readonly submittedByOrUnowned?: string;
  /**
   * Only runs that have ever RAISED a human gate, newest gate first.
   *
   * A SUPERSET of "runs with an OPEN gate", and the docstring says superset because the exact
   * set cannot be answered here: whether a gate is still open is a property of the FOLD, and
   * this is an index lookup. The caller folds; this narrows what it has to fold.
   *
   * WHAT IT IS FOR. `GateSweeper` is the SLA clock, and it found its runs through
   * `listRuns(limit)` — ordered by run id descending, which is newest-CREATED first. So a tick
   * saw the `limit` most recently created runs and nothing older, and a gate raised on a run
   * that has since been pushed out of that window by newer runs never had its deadline
   * checked again after a process restart. Its SLA never fired: no escalation, no expiry, a
   * question standing in front of a human with nothing behind it. That is REGISTER **B7**.
   *
   * WHY THIS AND NOT A READ MODEL. `CLAUDE.md` invariant 2 names `human_gates` as a derived
   * read model and there is no such table — the durable schema is `meta`, `journal`,
   * `run_head`, `task_fence`. Building one means a table to keep consistent with the journal
   * on every append, which is a second source of truth to get wrong. Ordering by the gate
   * events themselves needs no table and no column: an index over `(type, seq)` makes
   * "the most recent runs that raised a gate" a single indexed scan, and it is ADDITIVE — an
   * older binary ignores an index it does not know about, and a newer one creates it on open.
   *
   * IT DOES NOT MAKE THE LISTING UNBOUNDED. The same `limit` applies; what changes is what
   * competes for the slots. A deployment that creates a million runs and gates ten of them now
   * has all ten in view instead of whichever ten are newest.
   */
  readonly raisedAGate?: boolean;
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

  /**
   * Newest first, at most `limit`.
   *
   * THE FILTER IS APPLIED BEFORE THE LIMIT, and an implementation that reverses that is
   * wrong in two ways: a low-volume principal on a busy deployment sees an empty list because
   * every one of the newest N belongs to somebody else, and a caller can infer other
   * principals' submission density by varying `limit` and watching how many of its own runs
   * survive.
   */
  listRuns(limit?: number, filter?: RunFilter): Promise<readonly RunSummary[]>;

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
 * The largest a single event's canonical payload may be.
 *
 * NOTHING BOUNDED BYTES AT ALL before this. Measured: a 256 MiB single event was accepted by both
 * stores, taking ~2.5 GiB of RSS on the way in. The one payload guard that existed is `MAX_DEPTH`,
 * and it is byte-blind — a 300-deep 5 KB value is refused while a 2-deep 64 MiB one is written.
 *
 * **AND THE JOURNAL AMPLIFIES.** Measured on a chain of `function` nodes passing one value:
 * `journal_bytes = payload × (2N + 2)` where N is the nodes the value flows through —
 * `task.committed` and `state.reduced` each carry a full copy per hop, plus `run.submitted`'s
 * inputs and `run.completed`'s outputs. Exact at every N tried. One run, one 16 MiB value, four
 * nodes = 160 MiB of SQLite, every byte fsynced because invariant 8 says durability is not
 * negotiable. An operator's first sign of this today is `du`.
 *
 * EIGHT MEBIBYTES, and the number is chosen to be uncontroversial rather than tight. Temporal
 * refuses a payload above 2 MB and kills a history above 50 MB; Golem inlines to 65 KB and
 * externalises past it; this repo's own HTTP door already caps a request body at 1 MiB. By those
 * standards this is generous, deliberately: the bound exists to catch a runaway, not to constrain
 * a workload.
 *
 * IT WAS 4 MiB FOR ABOUT A MINUTE, and what moved it is worth keeping. The SSE backpressure test
 * writes a deliberate 4 MiB wall to fill a socket buffer — so a payload of exactly that size is
 * something this codebase already produces on purpose. A bound that refuses a size the tree
 * demonstrably uses is not "certainly a mistake", and editing the test to fit the number would
 * have been fitting the evidence to the conclusion.
 *
 * REFUSE, NEVER TRUNCATE — the rule `MAX_DEPTH` states one layer down, for the same reason: a
 * clipped payload is journaled as a value that is not the value, and replay compares digests, so
 * truncating converts a loud failure into a silent divergence.
 *
 * **THIS IS A BOUND, NOT THE FIX**, and the fix now exists beside it. This still stops a runaway
 * and still knows nothing about the amplification; what addresses that is `journal/payloads.ts` —
 * a reference above 64 KiB, resolved before a node body runs. The two thresholds are deliberately
 * unrelated numbers with the same boundary rule: `<=` passes here, and a value of exactly
 * `EXTERNALISE_ABOVE_BYTES` stays inline there.
 *
 * NOTHING BELOW READS THE PAYLOAD STORE, and that is the point. Externalisation happens in the
 * ENGINE, before `append` is called, so a payload arriving here is already whatever it is going to
 * be and this bound still weighs the bytes that will actually be written. An event carrying a
 * handle is a small event, so the two guards do not have to be told about each other.
 */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

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
/** Canonical bytes, or a refusal that says which event and by how much. */
function boundedPayload(json: string, type: string): string {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_PAYLOAD_BYTES) return json;
  throw err.validation(
    CODES.E_PAYLOAD_TOO_LARGE,
    `a "${type}" payload is ${(bytes / 1048576).toFixed(1)} MiB, over the ${String(MAX_PAYLOAD_BYTES / 1048576)} MiB per-event bound. ` +
      `The journal keeps every version of every value forever and writes one copy per hop, so a large value costs ` +
      `roughly (2 x nodes + 2) times its own size on disk. Put a REFERENCE in the channel — a path, a URL, a blob id — ` +
      `and let a tool fetch the bytes when it needs them.`,
    { details: { type, bytes, limit: MAX_PAYLOAD_BYTES } },
  );
}

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
    payloadJson: boundedPayload(canonicalize(e.payload), e.type),
    actorJson: canonicalize(e.actor),
    taskId: e.taskId ?? input.taskId ?? null,
    classification: e.classification ?? DEFAULT_CLASSIFICATION,
  }));
}

/**
 * The owner a batch establishes, read back out of the bytes that were journaled.
 *
 * ONE DEFINITION, SHARED, for the reason `prepare` is shared: a divergence between the two
 * stores here is a divergence about who may read a run, not a test-only inconsistency.
 *
 * IT PARSES `payloadJson` RATHER THAN READING `input.events` AGAIN. `prepare` has already
 * canonicalized the payload; going back to the caller's object is a SECOND `[[Get]]` on a
 * value from outside this process, and a getter or a `Proxy` may answer the two reads
 * differently — leaving the read-model column and the journal row disagreeing about who owns
 * the run, which is invariant 2's failure mode in the field that decides access. The parse
 * costs one call per run and is provably the same value the row holds.
 *
 * `undefined` for a batch that establishes nothing — no `run.submitted`, or one naming
 * nobody. Callers write it INSERT-ONLY, so "this batch says nothing about the owner" and
 * "this batch says the owner is nobody" are the same instruction to a column that is only
 * ever written when the row is created.
 */
export function submitterOf(rows: readonly PreparedEvent[]): string | undefined {
  for (const r of rows) {
    if (r.type !== "run.submitted") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.payloadJson);
    } catch {
      return undefined;
    }
    // Total reads throughout: this is a plain object minted by `JSON.parse`, but the shape
    // inside it came from a caller and `submittedBy` may be any JSON value.
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const by: unknown = (parsed as Record<string, unknown>)["submittedBy"];
    if (typeof by !== "object" || by === null) return undefined;
    const subject: unknown = (by as Record<string, unknown>)["subject"];
    if (typeof subject !== "string" || subject === "") return undefined;
    // BOUNDED, and refused rather than truncated. The HTTP door caps a subject at the same
    // size and refuses an over-long one on the stated grounds that injected code writes into
    // durable rows; an embedder calling `append` directly is the other door, and truncating
    // here would invent a different person rather than declining to name one. Refusing to
    // DERIVE is safe in a way refusing to append would not be: the journal still carries what
    // it was given, and the read model simply declines to claim an owner it cannot vouch for
    // — which the access rule reads as "unreadable", not as "nobody".
    return subject.length <= MAX_SUBJECT ? subject : undefined;
  }
  return undefined;
}

/** Matches `MAX_IDENTITY_FIELD` at the HTTP perimeter; the journal is the same journal. */
const MAX_SUBJECT = 256;

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
