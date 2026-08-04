/**
 * The single writer for one Run's journal.
 *
 * Every append in the system goes through here so `expectedSeq` is managed in one
 * place. On `E_SEQ_CONFLICT` it re-reads the head and retries a bounded number of
 * times — which is correct precisely because the events being appended are *facts
 * that happened*, not decisions conditional on the head. (A decision conditional on
 * the head — "commit this Task's result" — must NOT retry; the executor passes its
 * own `expectedSeq` for that and lets the conflict surface.)
 *
 * It also publishes to the bus after a successful append, never before: a subscriber
 * must never see an event that did not become durable.
 */

import { CODES, err, isLoomError } from "../errors.ts";
import type { RunId, Seq, TaskId } from "../ids.ts";
import type { JournalEvent, NewEvent } from "../journal/events.ts";
import type { StateStore } from "../journal/store.ts";
import type { EventBus } from "../bus.ts";

const MAX_APPEND_RETRIES = 8;

export interface RunLogOptions {
  readonly store: StateStore;
  readonly bus?: EventBus;
  readonly now?: () => number;
}

export class RunLog {
  readonly runId: RunId;
  readonly #store: StateStore;
  readonly #bus: EventBus | undefined;
  readonly #now: () => number;
  #head: Seq | undefined;

  constructor(runId: RunId, opts: RunLogOptions) {
    this.runId = runId;
    this.#store = opts.store;
    this.#bus = opts.bus;
    this.#now = opts.now ?? Date.now;
  }

  async head(): Promise<Seq> {
    this.#head ??= await this.#store.head(this.runId);
    return this.#head;
  }

  /** Force a re-read. Used after another writer (or process) may have appended. */
  async refresh(): Promise<Seq> {
    this.#head = await this.#store.head(this.runId);
    return this.#head;
  }

  /**
   * Append facts. Retries on seq conflict because the events are unconditional.
   * Use `commit` for anything whose validity depends on the head not having moved.
   */
  async append(events: readonly NewEvent[], opts: { taskId?: TaskId; fencingToken?: number } = {}): Promise<Seq> {
    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      const expectedSeq = await this.head();
      try {
        const { seq } = await this.#store.append({
          runId: this.runId,
          expectedSeq,
          events,
          now: this.#now(),
          ...(opts.taskId === undefined ? {} : { taskId: opts.taskId }),
          ...(opts.fencingToken === undefined ? {} : { fencingToken: opts.fencingToken }),
        });
        this.#head = seq;
        await this.#publish(expectedSeq + 1, seq);
        return seq;
      } catch (e) {
        if (isLoomError(e) && e.code === CODES.E_SEQ_CONFLICT) {
          await this.refresh();
          continue;
        }
        throw e;
      }
    }
    throw err.conflict(
      CODES.E_SEQ_CONFLICT,
      `could not append to run ${this.runId} after ${MAX_APPEND_RETRIES} attempts`,
    );
  }

  /**
   * Conditional append. NEVER retries — the caller decided something was true at
   * `expectedSeq`, and if the head moved that decision is stale. This is the
   * primitive that turns at-least-once execution into exactly-once state.
   */
  async commit(
    expectedSeq: Seq,
    events: readonly NewEvent[],
    opts: { taskId?: TaskId; fencingToken?: number } = {},
  ): Promise<Seq> {
    const { seq } = await this.#store.append({
      runId: this.runId,
      expectedSeq,
      events,
      now: this.#now(),
      ...(opts.taskId === undefined ? {} : { taskId: opts.taskId }),
      ...(opts.fencingToken === undefined ? {} : { fencingToken: opts.fencingToken }),
    });
    this.#head = seq;
    await this.#publish(expectedSeq + 1, seq);
    return seq;
  }

  read(fromSeq: Seq = 1, toSeq?: Seq): AsyncIterable<JournalEvent> {
    return this.#store.read(this.runId, fromSeq, toSeq);
  }

  async #publish(fromSeq: Seq, toSeq: Seq): Promise<void> {
    if (this.#bus === undefined) return;
    // Read back rather than reconstructing: the stored form is the one subscribers
    // must see, including any redaction the store applied on the way in.
    for await (const e of this.#store.read(this.runId, fromSeq, toSeq)) this.#bus.publish(e);
  }
}
