/**
 * A DEAD PRIMARY IS VISIBLE NOW, AND IT IS STILL NOT A CIRCUIT BREAKER.
 *
 * `FallbackOptions.onFallback` shipped declared, tested and wired by NOBODY: `readModels`
 * built `new FallbackAdapter({provider, primary, fallback: tiers})` with no callback, so a
 * chain fell through in total silence. `FallbackAdapter` is stateless by construction —
 * `stream()` enters tier 0 on every call and falls through only on a throw — so an operator
 * with a dead primary and a working secondary pays three wasted requests and about 750 ms of a
 * worker slot on EVERY model turn, indefinitely, while every run succeeds.
 *
 * The backlog called for a breaker. A breaker is REFUSED: it reads a per-source failure count
 * that spans runs, and the journal is authoritative per run, so its verdict is a value no fold
 * can reconstruct. What is built is the sightline, and the assertion that keeps it a sightline
 * is the third one below — **all eleven calls reach the wrapped provider**. That is the
 * assertion to break first if anyone ever tries to make this thing decide.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { providerNotice } from "../../src/cli.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { FallbackAdapter } from "../../src/providers/fallback.ts";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/run/registry.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, Seq } from "../../src/ids.ts";

/** A feed with the same shape `readModels` builds. Constructed here so the test owns both ends. */
function feed(): { subscribe: (fn: (f: string, t: string, e: never) => void) => () => void; emit: (f: string, t: string, e: never) => void } {
  const listeners = new Set<(f: string, t: string, e: never) => void>();
  return {
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    emit: (f, t, e) => {
      for (const fn of listeners) fn(f, t, e);
    },
  };
}

/** An adapter that counts every entry and fails the first `failures` of them. */
function counting(model: string, failures: number): ModelAdapter & { calls: number } {
  const self = {
    provider: `p-${model}`,
    calls: 0,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *stream(req: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
      self.calls++;
      if (self.calls <= failures) throw err.unavailable(CODES.E_PROVIDER_OVERLOADED, `${model} is overloaded`);
      yield { type: "text_delta", text: `from ${req.model}` } as ModelEvent;
      yield { type: "done", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } } as ModelEvent;
    },
    priceOf: () => 0,
    estimateOf: () => 0,
  };
  return self;
}

let seq = 0;
function modelCalled(model: string): JournalEvent {
  seq++;
  return {
    runId: "r-1" as RunId,
    seq: seq as Seq,
    ts: seq,
    type: "model.called",
    payload: { key: `t:model:${seq}`, provider: "p", model, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, requestDigest: "sha256:x" },
    actor: { kind: "system", component: "engine" },
  } as unknown as JournalEvent;
}

function effectFailed(code: string): JournalEvent {
  seq++;
  return {
    runId: "r-1" as RunId,
    seq: seq as Seq,
    ts: seq,
    type: "effect.failed",
    payload: { key: `t:model:${seq}`, error: { class: "unavailable", code, message: "the provider is gone", retryable: true } },
    actor: { kind: "system", component: "engine" },
  } as unknown as JournalEvent;
}

/** Let the bus's async iterator deliver what has been published. Microtasks only — no timer. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("ten fall-throughs produce ONE down-line and ONE recovery line — and all eleven calls reach the provider", async () => {
  const lines: string[] = [];
  const bus = new InProcessEventBus();
  const chain = feed();
  const notice = providerNotice({ bus, models: { fallbacks: chain as never } }, (l) => lines.push(l));
  try {
    const primary = counting("primary-model", 10);
    const secondary = counting("secondary-model", 0);
    const adapter = new FallbackAdapter({
      provider: "chain(x)",
      primary: { adapter: primary, model: "primary-model" },
      fallback: [{ adapter: secondary, model: "secondary-model", when: [CODES.E_PROVIDER_OVERLOADED] }],
      // EXACTLY THE WIRING `readModels` NOW DOES.
      onFallback: (from, to, e) => chain.emit(from, to, e as never),
    });

    for (let i = 0; i < 11; i++) {
      for await (const _ of adapter.stream({ model: "primary-model", messages: [] } as unknown as ModelRequest, new AbortController().signal)) {
        // drained
      }
      // WHAT THE ENGINE DOES ON A SUCCESSFUL TURN, and the reporter's only recovery signal.
      // `effect.failed` carries no model id, so a successful turn is the one event that can
      // name the source that came back.
      bus.publish(modelCalled(i < 10 ? "secondary-model" : "primary-model"));
      await drain();
    }

    const down = lines.filter((l) => l.includes("IS FAILING"));
    const up = lines.filter((l) => l.includes("recovered"));
    assert.equal(down.length, 1, `exactly one down-line, not one per turn: ${JSON.stringify(lines)}`);
    assert.match(down[0]!, /PRIMARY MODEL "primary-model" IS FAILING/);
    assert.match(down[0]!, /falls through to "secondary-model"/);
    assert.match(down[0]!, new RegExp(CODES.E_PROVIDER_OVERLOADED));
    assert.equal(up.length, 1, `exactly one recovery line: ${JSON.stringify(lines)}`);

    // THE ASSERTION THAT KEEPS THIS A REPORT. Nothing was withheld: eleven turns, eleven
    // entries into the primary. A breaker would have stopped calling it after the trip count,
    // and this line is what would go red.
    assert.equal(primary.calls, 11, "every single turn still paid the failed call — this thing decides nothing");
    assert.equal(secondary.calls, 10, "…and the ten that fell through were served by the secondary");
  } finally {
    notice.stop();
  }
});

test("a deployment with NO chain is covered too, keyed on the code because the event carries no model", async () => {
  // `effect.failed`'s payload is `{key, error}` — measured at `journal/events.ts:321`. There is
  // no model id in it, so this half of the reporter honestly says what it knows: model calls
  // are failing, and with which code. Inventing a source name here would be the "correction
  // that replaces a false claim with a differently-false one".
  const lines: string[] = [];
  const bus = new InProcessEventBus();
  const notice = providerNotice({ bus, models: undefined }, (l) => lines.push(l));
  try {
    for (let i = 0; i < 5; i++) bus.publish(effectFailed(CODES.E_PROVIDER_OVERLOADED));
    await drain();
    assert.equal(lines.filter((l) => l.includes("MODEL CALLS ARE FAILING")).length, 1, `latched: ${JSON.stringify(lines)}`);

    bus.publish(modelCalled("some-model"));
    await drain();
    assert.equal(lines.filter((l) => l.includes("recovered")).length, 1);

    // AND IT RE-ARMS, so a second outage is reported rather than swallowed by a latch that
    // only ever falls one way.
    bus.publish(effectFailed(CODES.E_PROVIDER_OVERLOADED));
    await drain();
    assert.equal(lines.filter((l) => l.includes("MODEL CALLS ARE FAILING")).length, 2);
  } finally {
    notice.stop();
  }
});

test("a failing TOOL is not reported as a failing provider", async () => {
  // The filter is on the effect KIND parsed out of `effectKey(task, kind, ordinal)`. Without
  // it every `E_TOOL_SOURCE_UNAVAILABLE` in the deployment would print a line claiming the
  // model provider was down, which is a report that misleads — strictly worse than silence.
  const lines: string[] = [];
  const bus = new InProcessEventBus();
  const notice = providerNotice({ bus, models: undefined }, (l) => lines.push(l));
  try {
    seq++;
    bus.publish({
      runId: "r-1" as RunId,
      seq: seq as Seq,
      ts: seq,
      type: "effect.failed",
      payload: { key: `t:tool:${seq}`, error: { class: "unavailable", code: CODES.E_TOOL_SOURCE_UNAVAILABLE, message: "gone", retryable: true } },
      actor: { kind: "system", component: "engine" },
    } as unknown as JournalEvent);
    await drain();
    assert.deepEqual(lines, [], "a tool effect is not this reporter's subject");
  } finally {
    notice.stop();
  }
});

test("stop() disposes the subscription, so `serve` does not leave a second reader behind", async () => {
  const lines: string[] = [];
  const bus = new InProcessEventBus();
  const notice = providerNotice({ bus, models: undefined }, (l) => lines.push(l));
  notice.stop();
  bus.publish(effectFailed(CODES.E_PROVIDER_OVERLOADED));
  await drain();
  assert.deepEqual(lines, [], "nothing is read after stop");
  assert.equal(bus.subscriberCount, 0, "and the bus is holding no queue for it");
});
