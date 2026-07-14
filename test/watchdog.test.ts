/**
 * Tests for the watchdog extension: an idle deadline on the main provider stream.
 *
 * The watchdog wraps the default provider in place and races each iterator step
 * against an idle timeout, so a stream that goes silent past `watchdog.idleMs` is
 * aborted (the turn never hangs) while a progressing stream is never touched. A
 * `MockProvider` cannot stall (it yields synchronously and always completes), so
 * every stall/throw case here uses a bespoke `Provider` — an async generator that
 * awaits a never-resolving promise (ignoring the signal, to prove the race, not
 * abort alone, is what unblocks) or throws early. All fully offline: no network,
 * no API key, no OS sandbox. Activated via `host.use("watchdog", watchdog)` with a
 * tiny injected `watchdog.idleMs` so the deadline trips in milliseconds.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import watchdog from "../src/extensions/watchdog.js";
import type { CompletionRequest, Provider, StreamEvent } from "../src/kernel/types.js";
import { makeHarness, lastText } from "./helpers.js";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Yields nothing and awaits a promise that never resolves — and never observes
 *  the signal, so only the watchdog's `next()`-race (not abort) can unblock it. */
class NeverYield implements Provider {
  readonly name = "mock";
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    await new Promise<never>(() => {});
  }
}

/** Yields one event, then stalls forever (re-arm proof: the timer must reset
 *  after event 1 and fire `idleMs` later). */
class OneThenStall implements Provider {
  readonly name = "mock";
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: "hi" };
    await new Promise<never>(() => {});
  }
}

/** Yields an event every few ms (well under `idleMs`) then a clean `done`. */
class Steady implements Provider {
  readonly name = "mock";
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    for (const ch of ["x", "y", "z"]) {
      await delay(5);
      yield { type: "text_delta", text: ch };
    }
    yield {
      type: "done",
      message: { role: "assistant", content: [{ type: "text", text: "xyz" }] },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

/** Throws a normal (non-idle) error before `idleMs`, having yielded nothing. */
class ThrowsEarly implements Provider {
  readonly name = "mock";
  async *stream(_req: CompletionRequest): AsyncGenerator<StreamEvent> {
    await delay(5);
    throw new Error("boom");
  }
}

// AC4 — a pre-commit hang (zero events) rejects after idleMs with the idle error;
// the turn does not hang. The bounded per-test timeout is the "does not hang"
// assertion: without the watchdog the run would never settle.
test("AC4: aborts a pre-commit hang after idleMs", { timeout: 3000 }, async () => {
  const h = makeHarness();
  h.agent.providers.register(new NeverYield(), { default: true });
  h.config.set("watchdog.idleMs", 40);
  await h.host.use("watchdog", watchdog);
  await assert.rejects(h.agent.run("go"), /provider idle for 40ms/);
});

// AC4b — a mid-stream stall (one event then silence) re-arms the timer after
// event 1 and rejects idleMs later; the turn ends fatal (committed → rethrown).
test("AC4b: aborts a mid-stream stall (re-arm proof)", { timeout: 3000 }, async () => {
  const h = makeHarness();
  h.agent.providers.register(new OneThenStall(), { default: true });
  h.config.set("watchdog.idleMs", 40);
  await h.host.use("watchdog", watchdog);
  await assert.rejects(h.agent.run("go"), /provider idle for 40ms/);
});

// AC5 — a progressing stream (an event every < idleMs) is never aborted; the turn
// completes normally. Guards against a false-abort of a slow-but-live stream.
test("AC5: does not abort a progressing stream", { timeout: 3000 }, async () => {
  const h = makeHarness();
  h.agent.providers.register(new Steady(), { default: true });
  h.config.set("watchdog.idleMs", 50);
  await h.host.use("watchdog", watchdog);
  const res = await h.agent.run("go");
  assert.equal(res.reason, "end_turn");
  assert.equal(lastText(h.agent), "xyz");
});

// GEN-1 — a caller's own deadline (an upstream abort signal, e.g. runSubCall's
// timeout) bounds a signal-IGNORING stall promptly, not only the idle timer. With
// idleMs far above the test timeout, only honoring the upstream abort settles it.
test("GEN-1: an upstream abort bounds a signal-ignoring stall before idleMs", { timeout: 3000 }, async () => {
  const h = makeHarness();
  h.agent.providers.register(new NeverYield(), { default: true });
  h.config.set("watchdog.idleMs", 60000);
  await h.host.use("watchdog", watchdog);
  const wrapped = h.agent.providers.get()!;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new Error("caller deadline")), 30);
  await assert.rejects(
    (async () => {
      for await (const _ev of wrapped.stream({ messages: [], signal: ctrl.signal } as unknown as CompletionRequest)) {
        void _ev; // NeverYield never yields; the race resolves via the upstream abort
      }
    })(),
    /caller deadline/,
    "rejects with the upstream reason, not the 60s idle error",
  );
});

// AC5c — an inner error before idleMs propagates to the loop, and the idle timer
// is cleared so no unhandledRejection surfaces from it (per-iteration clearTimeout).
test("AC5c: inner error propagates with no idle-timer leak", { timeout: 3000 }, async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const h = makeHarness();
    h.agent.providers.register(new ThrowsEarly(), { default: true });
    h.config.set("watchdog.idleMs", 40);
    await h.host.use("watchdog", watchdog);
    await assert.rejects(h.agent.run("go"), /boom/);
    // Wait past idleMs so a *leaked* (uncleared) idle timer would fire and reject
    // unhandled here; with the per-iteration clearTimeout it never does.
    await delay(120);
    assert.deepEqual(rejections, [], "no unhandledRejection from the idle timer");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// AC6 — dispose restores the original provider (raw re-register, not delete).
test("AC6: dispose restores the original provider", async () => {
  const h = makeHarness();
  const original = new Steady();
  h.agent.providers.register(original, { default: true });
  h.config.set("watchdog.idleMs", 40);
  await h.host.use("watchdog", watchdog);

  const wrapped = h.agent.providers.get();
  assert.notEqual(wrapped, original, "activation wraps the default provider");
  assert.equal(wrapped?.name, "mock", "wrapper preserves the provider name");

  await h.host.unload("watchdog");
  assert.equal(h.agent.providers.get(), original, "dispose restores the original (not deleted, not a wrapper)");
});

// AC6 (off switch) — EAGENT_WATCHDOG=off makes activation a total no-op: no wrap.
test("AC6: EAGENT_WATCHDOG=off does not wrap", async () => {
  const saved = process.env["EAGENT_WATCHDOG"];
  process.env["EAGENT_WATCHDOG"] = "off";
  try {
    const h = makeHarness();
    const original = new Steady();
    h.agent.providers.register(original, { default: true });
    await h.host.use("watchdog", watchdog);
    assert.equal(h.agent.providers.get(), original, "kill switch leaves the provider unwrapped");
  } finally {
    if (saved === undefined) delete process.env["EAGENT_WATCHDOG"];
    else process.env["EAGENT_WATCHDOG"] = saved;
  }
});

// AC6b — reload disposes-then-reactivates, so the original is restored before
// re-wrap: the result is a SINGLE wrapper over the original, not a wrapper of a
// wrapper. Proven by unloading after the reload and seeing the ORIGINAL restored
// (a double-wrap would restore an inner wrapper instead).
test("AC6b: reload does not double-wrap", async () => {
  const h = makeHarness();
  const original = new Steady();
  h.agent.providers.register(original, { default: true });
  h.config.set("watchdog.idleMs", 40);
  await h.host.use("watchdog", watchdog);
  assert.notEqual(h.agent.providers.get(), original, "activation wraps");

  await h.host.reload("watchdog");
  const afterReload = h.agent.providers.get();
  assert.notEqual(afterReload, original, "reload still leaves a wrapper");
  assert.equal(afterReload?.name, "mock");

  await h.host.unload("watchdog");
  assert.equal(
    h.agent.providers.get(),
    original,
    "single wrapper: unload after reload restores the ORIGINAL, not an inner wrapper",
  );
});
