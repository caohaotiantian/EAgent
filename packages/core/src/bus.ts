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
 * See design/loom/01-INTERFACES.md D3.9.
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
  /** How many events this subscriber missed. Non-zero means it could not keep up. */
  readonly dropped: number;
  dispose(): void;
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
        this.#dropped++;
        this.dispose();
        return;
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JournalEvent> {
    try {
      for (;;) {
        const buffered = this.#queue.shift();
        if (buffered !== undefined) {
          yield buffered;
          continue;
        }
        if (this.#closed) return;
        const next = await new Promise<IteratorResult<JournalEvent>>((resolve) => {
          this.#waiters.push({ resolve });
        });
        if (next.done) return;
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
