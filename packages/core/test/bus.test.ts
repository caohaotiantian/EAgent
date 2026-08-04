import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../src/bus.ts";
import type { RunId } from "../src/ids.ts";
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

test("onOverflow: close ends the subscription instead of dropping silently", async () => {
  const bus = new InProcessEventBus();
  const sub = bus.subscribe({}, { queueSize: 2, onOverflow: "close" });
  for (let i = 1; i <= 5; i++) bus.publish(ev(i));

  const all: number[] = [];
  for await (const e of sub) all.push(e.seq);
  assert.deepEqual(all, [1, 2], "buffered events still drain, then the iterator ends");
  assert.equal(bus.subscriberCount, 0, "and the subscription unregisters itself");
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
