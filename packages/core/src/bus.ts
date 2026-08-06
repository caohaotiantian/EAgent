/**
 * The in-process event bus.
 *
 * One inversion of the usual design decides everything here: **the bus is derived,
 * the journal is authoritative**. So `publish` never throws, never blocks, and never
 * applies back-pressure to the executor. A slow subscriber degrades *itself* — its
 * bounded queue drops — because the alternative (back-pressure reaching the executor)
 * means a stalled UI tab can wedge production work.
 *
 * Exactly-once delivery is available, but only through `replayThenTail`, which reads
 * the journal. That is the honest split: at-most-once on the fast path, exactly-once
 * on the path that goes to the source of truth.
 *
 * DROPPING IS LEGITIMATE; DROPPING SILENTLY IS NOT. Those are two claims and this file
 * used to make only the first. Under `onOverflow: "close"` the subscription was disposed
 * and the iterator simply ended — the same shape a finished run produces — so a
 * subscriber that did not think to read `Subscription.dropped` lost events and could not
 * tell. The answer is a *terminal signal*, not an error code and not a second delivery
 * path: the iterator ends by THROWING `SubscriberOverflowError`, after draining what it
 * still holds. `publish` still never throws and still never blocks; back-pressure still
 * never reaches the executor. What changed is only how the one policy that promises no
 * silent loss reports that it kept the promise.
 *
 * See design/loom/01-INTERFACES.md D3.9 and 03-RUNTIME.md D6.3.
 */

import type { RunId, Seq } from "./ids.ts";
import type { EventType, JournalEvent } from "./journal/events.ts";
import type { StateStore } from "./journal/store.ts";

export interface EventFilter {
  readonly runId?: RunId;
  readonly types?: readonly EventType[];
}

export type OverflowPolicy = "drop_oldest" | "drop_newest" | "close";

export interface SubscribeOptions {
  readonly queueSize: number;
  readonly onOverflow: OverflowPolicy;
}

export interface Subscription extends AsyncIterable<JournalEvent>, Disposable {
  /**
   * How many events this subscriber missed. Non-zero means it could not keep up.
   *
   * Meaningful under `drop_oldest` and `drop_newest`, which keep delivering. Under
   * `close` it is **1 and cannot grow**: overflowing unregisters the subscription, so
   * nothing after the cut is ever offered to it and there is nothing left to count. Read
   * the `SubscriberOverflowError` the iterator throws instead — it says where to resume,
   * which is the actionable fact; the size of the hole is not knowable from here.
   */
  readonly dropped: number;
  dispose(): void;
}

/**
 * Thrown INTO a consumer's `for await` when `onOverflow: "close"` cuts its subscription.
 *
 * The terminal signal C5 was missing. Iteration has exactly two terminal outcomes —
 * `done` and `throw` — and using the second for the abnormal one is why a consumer that
 * polls nothing still cannot mistake a cut for a clean end. It is deliberately NOT a
 * `LoomError` with a `Code`: `E_SUBSCRIBER_OVERFLOW` does not exist, D3.9's contract row
 * says why, and this is not a boundary error a `retry.onlyIf` list or an HTTP status map
 * should ever see. It never crosses a process edge; it is a local control-flow fact.
 *
 * RECOVERY IS `replayThenTail`, not a retry: the journal is authoritative and still has
 * everything the bus dropped. Resume from `lastSeq + 1`.
 */
export class SubscriberOverflowError extends Error {
  /**
   * Seq of the last event THIS ITERATION delivered, or `undefined` if it delivered none.
   *
   * Undefined is the second-consumer case, not a lost-everything case: the channel always
   * holds at least one queued event when it overflows (`queueSize` is floored at 1), so
   * the loop that was running drains before it throws. A loop started *after* that has
   * nothing to drain and no resume point of its own.
   *
   * A resume point only for a single-run subscription. A filter spanning runs interleaves
   * their sequences, so `lastSeq` there is the last event *seen*, not a watermark — such
   * a consumer has to track a seq per run itself.
   */
  readonly lastSeq: Seq | undefined;

  constructor(lastSeq: Seq | undefined) {
    super(
      lastSeq === undefined
        ? "subscription closed on overflow, with no event delivered on this iteration; re-read from the journal"
        : `subscription closed on overflow after seq ${lastSeq}; resume with replayThenTail(runId, ${lastSeq + 1})`,
    );
    this.name = "SubscriberOverflowError";
    this.lastSeq = lastSeq;
  }
}

export interface EventBus {
  publish(event: JournalEvent): void;
  subscribe(filter: EventFilter, opts: SubscribeOptions): Subscription;
  /** Gap-free catch-up then live tail, deduped by seq. The UI's reconnect path. */
  replayThenTail(runId: RunId, fromSeq: Seq, opts?: Partial<SubscribeOptions>): Subscription;
  readonly subscriberCount: number;
}

// ---------------------------------------------------------------------------

interface Waiter {
  resolve(value: IteratorResult<JournalEvent>): void;
}

class Channel implements Subscription {
  readonly #queue: JournalEvent[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #size: number;
  readonly #overflow: OverflowPolicy;
  readonly #onDispose: () => void;
  #closed = false;
  #dropped = 0;
  /**
   * Why this channel closed — and the whole of C5's fix.
   *
   * `dispose()` is called on three paths that must not look alike: the consumer walking
   * away, an orderly end, and an overflow cutting the stream. Only the third sets this,
   * so only the third throws.
   */
  #overflowed = false;

  constructor(size: number, overflow: OverflowPolicy, onDispose: () => void) {
    this.#size = Math.max(1, size);
    this.#overflow = overflow;
    this.#onDispose = onDispose;
  }

  get dropped(): number {
    return this.#dropped;
  }

  /** Never throws, never blocks. This is the contract that protects the executor. */
  push(event: JournalEvent): void {
    if (this.#closed) return;

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }
    if (this.#queue.length < this.#size) {
      this.#queue.push(event);
      return;
    }
    switch (this.#overflow) {
      case "drop_oldest":
        this.#queue.shift();
        this.#queue.push(event);
        this.#dropped++;
        return;
      case "drop_newest":
        this.#dropped++;
        return;
      case "close":
        // This event is lost and so is everything after it: `dispose` unregisters the
        // channel, so the bus stops offering. Hence `dropped` stops at 1 here — see the
        // note on `Subscription.dropped`.
        this.#dropped++;
        this.#overflowed = true;
        this.dispose();
        return;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JournalEvent> {
    let lastSeq: Seq | undefined;
    try {
      for (;;) {
        const buffered = this.#queue.shift();
        if (buffered !== undefined) {
          lastSeq = buffered.seq;
          yield buffered;
          continue;
        }
        // Terminal, both times: drain first, THEN report how the stream ended. A
        // consumer that was cut off still gets every event the channel was holding —
        // throwing early would turn a bounded loss into a larger one.
        if (this.#closed) {
          if (this.#overflowed) throw new SubscriberOverflowError(lastSeq);
          return;
        }
        const next = await new Promise<IteratorResult<JournalEvent>>((resolve) => {
          this.#waiters.push({ resolve });
        });
        if (next.done) {
          // Unreachable via overflow today — `push` hands an event straight to a waiting
          // consumer, so a full queue implies no waiter — but the flag, not the path, is
          // what decides, so a future overflow path cannot end up silent by omission.
          if (this.#overflowed) throw new SubscriberOverflowError(lastSeq);
          return;
        }
        lastSeq = next.value.seq;
        yield next.value;
      }
    } finally {
      // Covers `break`, `return`, and an exception in the consumer's loop body:
      // a consumer that walks away must not leak a subscription.
      this.dispose();
    }
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true });
    this.#onDispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

function matches(e: JournalEvent, f: EventFilter): boolean {
  if (f.runId !== undefined && e.runId !== f.runId) return false;
  if (f.types !== undefined && !f.types.includes(e.type)) return false;
  return true;
}

export interface InProcessEventBusOptions {
  /** Needed only for `replayThenTail`. A bus without one is publish/subscribe only. */
  readonly store?: StateStore;
}

export class InProcessEventBus implements EventBus {
  readonly #subs = new Map<Channel, EventFilter>();
  readonly #store: StateStore | undefined;

  constructor(opts: InProcessEventBusOptions = {}) {
    this.#store = opts.store;
  }

  get subscriberCount(): number {
    return this.#subs.size;
  }

  publish(event: JournalEvent): void {
    for (const [channel, filter] of this.#subs) {
      if (matches(event, filter)) channel.push(event);
    }
  }

  subscribe(filter: EventFilter, opts: SubscribeOptions): Subscription {
    const channel = new Channel(opts.queueSize, opts.onOverflow, () => this.#subs.delete(channel));
    this.#subs.set(channel, filter);
    return channel;
  }

  /**
   * Subscribe FIRST, then read the journal, then emit journal events followed by the
   * buffered live ones with `seq <= lastReplayed` filtered out.
   *
   * Order matters: subscribing after the read would drop anything appended during it.
   * The overlap is why the dedupe exists — it is a guarantee, not a nicety.
   */
  replayThenTail(runId: RunId, fromSeq: Seq, opts: Partial<SubscribeOptions> = {}): Subscription {
    const store = this.#store;
    if (store === undefined) {
      throw new Error("replayThenTail requires a StateStore; construct the bus with { store }");
    }
    const live = this.subscribe({ runId }, {
      queueSize: opts.queueSize ?? 1024,
      onOverflow: opts.onOverflow ?? "drop_oldest",
    });

    const merged: Subscription = {
      get dropped() {
        return live.dropped;
      },
      dispose: () => live.dispose(),
      [Symbol.dispose]: () => live.dispose(),
      async *[Symbol.asyncIterator](): AsyncIterator<JournalEvent> {
        let lastSeq = fromSeq - 1;
        try {
          for await (const e of store.read(runId, fromSeq)) {
            lastSeq = e.seq;
            yield e;
          }
          for await (const e of live) {
            if (e.seq <= lastSeq) continue; // already served from the journal
            lastSeq = e.seq;
            yield e;
          }
        } finally {
          live.dispose();
        }
      },
    };
    return merged;
  }
}
