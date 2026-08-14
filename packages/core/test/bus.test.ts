import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus, SubscriberOverflowError } from "../src/bus.ts";
import type { RunId, Seq } from "../src/ids.ts";
import { SYSTEM_ACTOR, type JournalEvent } from "../src/journal/events.ts";
import { MemoryStateStore } from "../src/journal/memory.ts";

const RUN = "01JRUNBUS00000000000000000" as RunId;
const OTHER = "01JRUNBUS11111111111111111" as RunId;

function ev(seq: number, runId: RunId = RUN, type: JournalEvent["type"] = "task.progress"): JournalEvent {
  return {
    runId,
    seq,
    ts: 1000 + seq,
    type,
    payload: { chunk: `c${seq}` },
    actor: SYSTEM_ACTOR("test"),
    classification: "internal",
  } as JournalEvent;
}

/** One macrotask tick: past everything a microtask-only consumer can still reach. */
const settled = () => new Promise((r) => setImmediate(r));

/** Take n events then dispose, so a test never hangs on an open subscription. */
async function take(sub: AsyncIterable<JournalEvent>, n: number): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  if (n === 0) return out;
  for await (const e of sub) {
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

test("publish delivers to matching subscribers", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({ runId: RUN }, { queueSize: 10, onOverflow: "drop_oldest" });
  const collected = take(sub, 2);

  bus.publish(ev(1));
  bus.publish(ev(2));

  assert.deepEqual((await collected).map((e) => e.seq), [1, 2]);
});

test("filters exclude other runs and other types", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({ runId: RUN, types: ["task.progress"] }, { queueSize: 10, onOverflow: "drop_oldest" });
  const collected = take(sub, 1);

  bus.publish(ev(1, OTHER));
  bus.publish(ev(2, RUN, "run.started"));
  bus.publish(ev(3, RUN, "task.progress"));

  assert.deepEqual((await collected).map((e) => e.seq), [3]);
});

test("publish never throws and never blocks, even with no subscribers", () => {
  const bus = new InProcessEventBus();
  assert.doesNotThrow(() => bus.publish(ev(1)));
  assert.equal(bus.subscriberCount, 0);
});

test("a slow subscriber degrades itself: drop_oldest keeps the newest", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({}, { queueSize: 3, onOverflow: "drop_oldest" });

  // Nobody is reading yet, so everything queues and then overflows.
  for (let i = 1; i <= 6; i++) bus.publish(ev(i));
  assert.equal(sub.dropped, 3);

  const got = await take(sub, 3);
  assert.deepEqual(got.map((e) => e.seq), [4, 5, 6]);
});

test("drop_newest keeps the oldest", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({}, { queueSize: 3, onOverflow: "drop_newest" });
  for (let i = 1; i <= 6; i++) bus.publish(ev(i));
  assert.equal(sub.dropped, 3);
  assert.deepEqual((await take(sub, 3)).map((e) => e.seq), [1, 2, 3]);
});

test("onOverflow: close drains what it has and then THROWS — it does not look like a clean end", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({}, { queueSize: 2, onOverflow: "close" });
  for (let i = 1; i <= 5; i++) bus.publish(ev(i));

  const all: number[] = [];
  await assert.rejects(
    async () => {
      for await (const e of sub) all.push(e.seq);
    },
    (e: unknown) => {
      assert.ok(e instanceof SubscriberOverflowError, `expected SubscriberOverflowError, got ${String(e)}`);
      assert.equal(e.lastSeq, 2, "the resume point: everything after this was lost");
      return true;
    },
  );
  assert.deepEqual(all, [1, 2], "buffered events still drain first — the throw is terminal, not pre-emptive");
  assert.equal(bus.subscriberCount, 0, "and the subscription unregisters itself");
});

test("A DROPPED SUBSCRIBER AND A CLEAN END ARE DIFFERENT EVENTS, without anyone polling `dropped`", async () => {
  // The register entry C5 in its entirety: a consumer that writes the obvious loop and
  // reads no counter must not be able to mistake "I cut you off" for "the stream ended".
  const bus = new InProcessEventBus();
  const drain = async (sub: AsyncIterable<JournalEvent>): Promise<string> => {
    try {
      for await (const _ of sub) void _;
      return "ended";
    } catch (e) {
      return e instanceof SubscriberOverflowError ? "overflowed" : `unexpected: ${String(e)}`;
    }
  };

  const clean = bus.subscribe({}, { queueSize: 8, onOverflow: "close" });
  const cut = bus.subscribe({}, { queueSize: 2, onOverflow: "close" });
  const outcomes = Promise.all([drain(clean), drain(cut)]);

  for (let i = 1; i <= 5; i++) bus.publish(ev(i));
  await new Promise((r) => setImmediate(r));
  clean.dispose(); // an orderly end: the consumer, or the run, is finished

  assert.deepEqual(await outcomes, ["ended", "overflowed"]);
});

test("the loss-tolerant policies still end cleanly — only `close` promises no silent loss", async () => {
  // `drop_oldest` and `drop_newest` are the policies a subscriber picks when loss is
  // acceptable, so signalling it would be noise. `close` is the one picked by a
  // subscriber that would rather be cut off than be quietly wrong, and it is the only
  // one that changed.
  const bus = new InProcessEventBus();
  for (const onOverflow of ["drop_oldest", "drop_newest"] as const) {
    const sub = bus.subscribe({}, { queueSize: 2, onOverflow });
    for (let i = 1; i <= 5; i++) bus.publish(ev(i));
    const seen: number[] = [];
    const loop = (async () => {
      for await (const e of sub) seen.push(e.seq);
    })();
    await new Promise((r) => setImmediate(r));
    sub.dispose();
    await loop; // no throw
    assert.equal(sub.dropped, 3, `${onOverflow} still reports its loss through the counter`);
  }
});

test("the loop that was running drains and names its resume point; a later one throws with none", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({}, { queueSize: 1, onOverflow: "close" });
  bus.publish(ev(7));
  bus.publish(ev(8)); // overflows immediately; seq 7 is still queued

  const seen: number[] = [];
  const thrown: (number | undefined)[] = [];
  const catching = (e: unknown): true => {
    assert.ok(e instanceof SubscriberOverflowError, `expected SubscriberOverflowError, got ${String(e)}`);
    thrown.push(e.lastSeq);
    return true;
  };

  await assert.rejects(async () => {
    for await (const e of sub) seen.push(e.seq);
  }, catching);
  assert.deepEqual(seen, [7], "the queued event is delivered before the throw, not swallowed by it");

  // Re-iterating a dead subscription must not read as a clean end either — and this
  // second loop drained nothing, so it has no resume point to offer.
  await assert.rejects(async () => {
    for await (const e of sub) seen.push(e.seq);
  }, catching);

  assert.deepEqual(thrown, [7, undefined]);
});

test("replayThenTail propagates an overflow of its live tail instead of ending short", async () => {
  const store = new MemoryStateStore({ now: () => 1000 });
  const bus = new InProcessEventBus({ store });
  await store.append({
    runId: RUN,
    expectedSeq: 0,
    events: [{ type: "task.progress", payload: { chunk: "a" }, actor: SYSTEM_ACTOR("t") }],
  });

  const sub = bus.replayThenTail(RUN, 1, { queueSize: 2, onOverflow: "close" });
  // Overflow the live channel before the consumer gets past the journal read.
  for (let i = 2; i <= 6; i++) bus.publish(ev(i));

  const seen: number[] = [];
  await assert.rejects(async () => {
    for await (const e of sub) seen.push(e.seq);
  }, SubscriberOverflowError);
  assert.deepEqual(seen, [1, 2, 3], "the journal event, then the two the live channel held");
  assert.equal(bus.subscriberCount, 0);
});

test("one slow subscriber cannot stall a fast one", async () => {
  const bus = new InProcessEventBus();
  const slow = bus.subscribe({}, { queueSize: 1, onOverflow: "drop_oldest" });
  const fast = bus.subscribe({}, { queueSize: 100, onOverflow: "drop_oldest" });
  const fastCollected = take(fast, 5);

  for (let i = 1; i <= 5; i++) bus.publish(ev(i));

  assert.deepEqual((await fastCollected).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(slow.dropped, 4, "the slow subscriber ate the loss, not the producer");
  slow.dispose();
});

test("dispose unregisters and ends the iterator", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({}, { queueSize: 4, onOverflow: "drop_oldest" });
  assert.equal(bus.subscriberCount, 1);

  bus.publish(ev(1));
  const drained: number[] = [];
  const loop = (async () => {
    for await (const e of sub) drained.push(e.seq);
  })();

  await new Promise((r) => setImmediate(r));
  sub.dispose();
  await loop;

  assert.deepEqual(drained, [1]);
  assert.equal(bus.subscriberCount, 0);
});

test("breaking out of the loop disposes the subscription", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({}, { queueSize: 4, onOverflow: "drop_oldest" });
  bus.publish(ev(1));
  await take(sub, 1);
  assert.equal(bus.subscriberCount, 0, "a consumer that walks away must not leak");
});

test("`using` disposes the subscription at scope exit", () => {
  const bus = new InProcessEventBus();
  {
    using _sub = bus.subscribe({}, { queueSize: 1, onOverflow: "drop_oldest" });
    assert.equal(bus.subscriberCount, 1);
  }
  assert.equal(bus.subscriberCount, 0);
});

test("replayThenTail is gap-free across the journal/live boundary", async () => {
  const store = new MemoryStateStore({ now: () => 1000 });
  const bus = new InProcessEventBus({ store });

  await store.append({
    runId: RUN,
    expectedSeq: 0,
    events: [
      { type: "run.started", payload: { posture: "on" }, actor: SYSTEM_ACTOR("t") },
      { type: "task.progress", payload: { chunk: "a" }, actor: SYSTEM_ACTOR("t") },
    ],
  });

  const sub = bus.replayThenTail(RUN, 1);
  const collected = take(sub, 4);

  // Published while the consumer is still draining the journal — exactly the race a
  // reconnecting UI hits.
  bus.publish(ev(3));
  bus.publish(ev(4));

  assert.deepEqual((await collected).map((e) => e.seq), [1, 2, 3, 4]);
});

test("replayThenTail's DEFAULT overflow policy cuts at the new end, never at the seam", async () => {
  // `queueSize` is given and `onOverflow` is not, so this pins the default and nothing
  // else. `drop_oldest` discards from the OLD end of the queue — which, on this path, is
  // the run of events immediately after the journal head, because the live channel is
  // subscribed before the journal read and nobody is attached to it during the read. The
  // `seq <= lastSeq` dedupe filters duplicates; it cannot see a gap.
  const store = new MemoryStateStore({ now: () => 1000 });
  const bus = new InProcessEventBus({ store });
  await store.append({
    runId: RUN,
    expectedSeq: 0,
    events: [{ type: "task.progress", payload: { chunk: "a" }, actor: SYSTEM_ACTOR("t") }],
  });

  const sub = bus.replayThenTail(RUN, 1, { queueSize: 2 });
  for (let i = 2; i <= 6; i++) bus.publish(ev(i));

  const seen: number[] = [];
  let thrown: unknown;
  const consumer = (async () => {
    try {
      for await (const e of sub) seen.push(e.seq);
    } catch (e) {
      thrown = e;
    }
  })();
  // The consumer runs entirely in microtasks, so one macrotask tick is past every
  // outcome it can reach on its own. Disposing after that turns a silent tail — the
  // failure this test is about — into a failed assertion instead of a hung suite.
  await settled();
  sub.dispose();
  await consumer;

  assert.deepEqual(seen, [1, 2, 3], "the journal event, then the two the live channel still held");
  assert.ok(thrown instanceof SubscriberOverflowError, `the cut must be reported, not inferred; got ${String(thrown)}`);
  assert.equal((thrown as SubscriberOverflowError).lastSeq, 3, "…naming the resume point");
  assert.equal(bus.subscriberCount, 0);
});

test("replayThenTail delivers a contiguous prefix under load, or says where it stopped", async () => {
  // The reconnecting-UI race at scale, with no timers: the journal read is longer than
  // the burst, so the consumer is provably still inside it when the last event is
  // published — `for await` over an async generator costs at least one microtask per
  // event, and the publisher hands out exactly one per event.
  const JOURNALED = 2000;
  const LIVE = 1500; // more than the default 1024-slot queue, so the seam must overflow
  const store = new MemoryStateStore({ now: () => 1000 });
  const bus = new InProcessEventBus({ store });
  await store.append({
    runId: RUN,
    expectedSeq: 0,
    events: Array.from({ length: JOURNALED }, (_, i) => ({
      type: "task.progress" as const,
      payload: { chunk: `j${i}` },
      actor: SYSTEM_ACTOR("t"),
    })),
  });

  const sub = bus.replayThenTail(RUN, 1);
  const seen: number[] = [];
  let thrown: unknown;
  const consumer = (async () => {
    try {
      for await (const e of sub) {
        seen.push(e.seq);
        if (e.seq === JOURNALED + LIVE) break;
      }
    } catch (e) {
      thrown = e;
    }
  })();

  for (let s = JOURNALED + 1; s <= JOURNALED + LIVE; s++) {
    bus.publish(ev(s));
    await null;
  }
  await settled();
  sub.dispose();
  await consumer;

  const gaps = seen.filter((s, i) => i > 0 && s !== seen[i - 1]! + 1);
  assert.deepEqual(gaps, [], "a hole inside the one path that promises there are none");
  assert.equal(seen[0], 1);
  assert.ok(seen.length > JOURNALED, "the live tail was reached, so the seam was actually crossed");
  assert.ok(thrown instanceof SubscriberOverflowError, `the cut must be reported, not inferred; got ${String(thrown)}`);
  assert.equal(
    (thrown as SubscriberOverflowError).lastSeq,
    seen[seen.length - 1],
    "resume is lastSeq + 1, so the journal can supply everything the bus did not",
  );
});

test("replayThenTail dedupes an event that is both journaled and republished", async () => {
  const store = new MemoryStateStore({ now: () => 1000 });
  const bus = new InProcessEventBus({ store });
  await store.append({
    runId: RUN,
    expectedSeq: 0,
    events: [{ type: "task.progress", payload: { chunk: "a" }, actor: SYSTEM_ACTOR("t") }],
  });

  const sub = bus.replayThenTail(RUN, 1);
  const collected = take(sub, 2);
  bus.publish(ev(1)); // the overlap: already served from the journal
  bus.publish(ev(2));

  assert.deepEqual((await collected).map((e) => e.seq), [1, 2]);
});

test("replayThenTail honours a starting seq", async () => {
  const store = new MemoryStateStore({ now: () => 1000 });
  const bus = new InProcessEventBus({ store });
  await store.append({
    runId: RUN,
    expectedSeq: 0,
    events: [
      { type: "task.progress", payload: { chunk: "a" }, actor: SYSTEM_ACTOR("t") },
      { type: "task.progress", payload: { chunk: "b" }, actor: SYSTEM_ACTOR("t") },
      { type: "task.progress", payload: { chunk: "c" }, actor: SYSTEM_ACTOR("t") },
    ],
  });
  const sub = bus.replayThenTail(RUN, 3);
  assert.deepEqual((await take(sub, 1)).map((e) => e.seq), [3]);
});

test("replayThenTail without a store is a construction error, not a runtime surprise", () => {
  const bus = new InProcessEventBus();
  assert.throws(() => bus.replayThenTail(RUN, 1), /requires a StateStore/);
});

test("A SUBSCRIPTION IS ONE CONSUMER'S CHANNEL, and two loops over one SPLIT the stream", () => {
  // Not a bug — a contract, and it was nowhere stated. The iterator is a generator over a
  // SHARED queue, so each event goes to exactly one of two concurrent `for await` loops, and
  // whichever ends first runs the generator's `finally`, which disposes for BOTH. Neither
  // loop throws and neither `dropped` counter moves, so a consumer that assumed a bus fans
  // out sees half a run and is told nothing.
  //
  // This test exists to make the sharp edge executable rather than to defend against it:
  // `Subscription`'s docstring now says so, and if the behaviour is ever made
  // unrepresentable this is the test that has to change, deliberately.
  const bus = new InProcessEventBus({ store: new MemoryStateStore() });
  const sub = bus.subscribe({}, { queueSize: 16, onOverflow: "drop_oldest" });

  const a: number[] = [];
  const b: number[] = [];
  const drain = async (into: number[]): Promise<void> => {
    for await (const e of sub) {
      into.push(e.seq);
      if (into.length >= 2) break;
    }
  };
  const both = Promise.all([drain(a), drain(b)]);

  for (let seq = 1; seq <= 4; seq++) {
    bus.publish({
      runId: "r" as RunId,
      seq: seq as Seq,
      ts: seq,
      type: "run.started",
      payload: {},
      actor: SYSTEM_ACTOR("test"),
      classification: "internal",
    } as unknown as JournalEvent);
  }

  return both.then(() => {
    assert.deepEqual([...a, ...b].sort((x, y) => x - y), [1, 2, 3, 4], "every event reached exactly one loop");
    // DISJOINTNESS is the assertion that can actually fail. Each loop `break`s at two
    // entries, so `a` can never deep-equal `[1,2,3,4]` and "notDeepEqual to the whole run"
    // is a tautology — it holds for a bus that fans out perfectly. Under fan-out BOTH loops
    // would see `[1,2]`; under splitting they see disjoint halves.
    // No one-line mutation of `Channel` disproves this, and that is a property of the
    // subject rather than of the assertion: fan-out is a per-consumer cursor, i.e. a
    // redesign, not a condition to flip. The assertion discriminates — under fan-out both
    // loops hold `[1, 2]` and this line fails — it just cannot be reached by the sweep.
    assert.equal(a.some((seq) => b.includes(seq)), false, "THE STREAM FANNED OUT — both readers saw the same event");
    assert.notDeepEqual(a, b, "…and each reader saw a different half");
    assert.equal(bus.subscriberCount, 0, "and the first loop to leave disposed the subscription for both");
  });
});
