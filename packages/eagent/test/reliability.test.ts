/**
 * Tests for the reliability extension (AC-8): same-provider bounded retry on a
 * pre-first-event provider error, riding the kernel's `onProviderError` seam.
 *
 * The extension occupies a DIFFERENT axis from `fallback-routing` (cross-provider
 * failover) and `circuit-breaker` (tool-call loops): it retries the SAME provider
 * (optionally downshifting the model) and must NEVER mutate `agent.providerName`.
 * Everything runs offline against `MockProvider`-backed doubles; the backoff
 * `sleep` is injected to 0 so no real time passes. Loaded via
 * `host.use("reliability", activate)`, never via `BUILTIN_EXTENSIONS`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import reliability, { isRetryable, DEFAULT_RETRY_CODES } from "../src/extensions/reliability.ts";
import type { ExtensionAPI } from "../src/kernel/extension.ts";
import type { CompletionRequest, Provider, StreamEvent } from "../src/kernel/types.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { makeHarness, lastText, type Harness } from "./helpers.ts";

interface Cfg {
  enabled?: boolean;
  maxRetries?: number;
  downshiftModel?: string;
}

/**
 * Activate reliability through the harness with the backoff `sleep` stubbed to a
 * no-op (offline: no real delay), seeding the namespaced store before any handler
 * runs. Returns the captured `ExtensionAPI` for command dispatch.
 */
async function activate(h: Harness, cfg: Cfg = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("reliability", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    if (cfg.maxRetries !== undefined) e.store.set("maxRetries", cfg.maxRetries);
    if (cfg.downshiftModel !== undefined) e.store.set("downshiftModel", cfg.downshiftModel);
    return reliability(e, { sleep: async () => {} });
  });
  return api;
}

/** Dispatch the `/reliability` command and collect its printed lines. */
function runCommand(h: Harness, args: string): string[] {
  const lines: string[] = [];
  const cmd = h.commands.get("reliability");
  assert.ok(cmd, "reliability command is registered");
  cmd.run({ agent: h.agent, args, print: (s) => lines.push(s) });
  return lines;
}

/**
 * A provider that throws (pre-first-event) on its first `failTimes` calls, then
 * echoes via a real MockProvider. Records the model seen on each attempt so a
 * downshift is observable.
 */
class FlakyProvider implements Provider {
  calls = 0;
  models: string[] = [];
  readonly #inner = new MockProvider();
  readonly name: string;
  readonly #failTimes: number;
  readonly #makeError: () => unknown;
  constructor(name: string, failTimes: number, makeError: () => unknown) {
    this.name = name;
    this.#failTimes = failTimes;
    this.#makeError = makeError;
  }
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    this.models.push(req.model);
    if (this.calls <= this.#failTimes) throw this.#makeError();
    yield* this.#inner.stream(req);
  }
}

const econnreset = (): unknown => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
const httpExhausted = (): unknown => new Error("Anthropic API error 504: upstream timed out");
const opaque = (): unknown => new Error("something unexpected happened");

// -- the classifier (pure) ---------------------------------------------------

test("isRetryable: recognizes transient connection codes", () => {
  for (const code of DEFAULT_RETRY_CODES) {
    assert.equal(isRetryable(Object.assign(new Error("x"), { code })), true, `code ${code} is retryable`);
  }
});

test("isRetryable: recognizes transient stream/network messages", () => {
  assert.equal(isRetryable(new Error("socket hang up")), true);
  assert.equal(isRetryable(new Error("network failure")), true);
  assert.equal(isRetryable(new Error("the request timed out")), true);
  assert.equal(isRetryable(new Error("stream closed unexpectedly")), true);
  assert.equal(isRetryable(new Error("stream aborted")), true);
});

test("isRetryable: default-denies an opaque error and a non-error value", () => {
  assert.equal(isRetryable(new Error("something unexpected happened")), false);
  assert.equal(isRetryable(null), false);
  assert.equal(isRetryable("socket hang up"), false, "a bare string is not an error object");
});

test("isRetryable: excludes the http.ts-exhausted shape even when its body says 'timed out'", () => {
  // http.ts already owns/exhausted 429/5xx; re-retrying would stack backoff.
  assert.equal(isRetryable(new Error("Anthropic API error 504: upstream timed out")), false);
  assert.equal(isRetryable(new Error("OpenAI API error 429: rate limited")), false);
});

// -- off by default (inert) --------------------------------------------------

test("off by default: a recognized pre-commit error ends the run (inert)", async () => {
  const h = makeHarness();
  const flaky = new FlakyProvider("flaky", 1, econnreset);
  h.agent.providers.register(flaky);
  h.agent.providerName = "flaky";
  await activate(h); // enabled unset → false

  await assert.rejects(h.agent.run("hello"), /socket hang up/, "the error propagated — no retry while disabled");
  assert.equal(flaky.calls, 1, "the provider was tried exactly once (no retry)");
  assert.equal(h.agent.providerName, "flaky", "providerName unchanged");
});

// -- enabled: bounded retry on a recognized transient error ------------------

test("enabled: retries a recognized transient error within the bound and completes", async () => {
  const h = makeHarness();
  const flaky = new FlakyProvider("flaky", 2, econnreset); // 2 failures then success
  h.agent.providers.register(flaky);
  h.agent.providerName = "flaky";
  await activate(h, { enabled: true, maxRetries: 3 });

  const res = await h.agent.run("hello");

  assert.equal(res.reason, "end_turn", "the run completed after retrying past the transient failures");
  assert.equal(flaky.calls, 3, "2 failed attempts + 1 successful attempt");
  assert.equal(h.agent.providerName, "flaky", "same provider — it NEVER switched provider");
  assert.match(lastText(h.agent), /hello/, "the (mock) provider answered after recovery");
});

test("enabled: a persistently-failing recognized error gives up at the configured bound", async () => {
  const h = makeHarness();
  const flaky = new FlakyProvider("flaky", Number.POSITIVE_INFINITY, econnreset);
  h.agent.providers.register(flaky);
  h.agent.providerName = "flaky";
  await activate(h, { enabled: true, maxRetries: 2 });

  await assert.rejects(h.agent.run("hello"), /socket hang up/, "after exhausting retries the error propagates");
  assert.equal(flaky.calls, 3, "1 initial attempt + 2 retries, then give up");
  assert.equal(h.agent.providerName, "flaky", "provider never switched");
});

// -- conservative default-deny -----------------------------------------------

test("conservative default-deny: an unrecognized (http.ts-shaped) error is NOT retried", async () => {
  const h = makeHarness();
  const flaky = new FlakyProvider("flaky", 1, httpExhausted);
  h.agent.providers.register(flaky);
  h.agent.providerName = "flaky";
  await activate(h, { enabled: true, maxRetries: 3 });

  await assert.rejects(h.agent.run("hello"), /API error 504/, "the http.ts-owned error is not re-retried");
  assert.equal(flaky.calls, 1, "no retry for an http.ts-exhausted error");
  assert.equal(h.agent.providerName, "flaky");
});

test("conservative default-deny: a bare error with no transient signal is NOT retried", async () => {
  const h = makeHarness();
  const flaky = new FlakyProvider("flaky", 1, opaque);
  h.agent.providers.register(flaky);
  h.agent.providerName = "flaky";
  await activate(h, { enabled: true, maxRetries: 3 });

  await assert.rejects(h.agent.run("hello"), /something unexpected/);
  assert.equal(flaky.calls, 1, "an unrecognized error default-denies");
});

// -- model downshift on retry (same provider) --------------------------------

test("enabled with a configured downshiftModel: the retry carries the smaller model, same provider", async () => {
  const h = makeHarness();
  const flaky = new FlakyProvider("flaky", 1, econnreset);
  h.agent.providers.register(flaky);
  h.agent.providerName = "flaky";
  h.agent.model = "big";
  await activate(h, { enabled: true, maxRetries: 3, downshiftModel: "small" });

  const res = await h.agent.run("hello");

  assert.equal(res.reason, "end_turn");
  assert.deepEqual(flaky.models, ["big", "small"], "first attempt 'big', retry downshifted to 'small'");
  assert.equal(h.agent.providerName, "flaky", "provider unchanged — only the model downshifted");
});

// -- command surface ---------------------------------------------------------

test("/reliability on|off|status toggles the enabled flag", async () => {
  const h = makeHarness();
  await activate(h); // disabled by default

  assert.match(runCommand(h, "status").join("\n"), /enabled=false/, "off by default");
  runCommand(h, "on");
  assert.match(runCommand(h, "status").join("\n"), /enabled=true/);
  runCommand(h, "off");
  assert.match(runCommand(h, "status").join("\n"), /enabled=false/);
});

test("/reliability on enables retry without re-activation", async () => {
  const h = makeHarness();
  const flaky = new FlakyProvider("flaky", 1, econnreset);
  h.agent.providers.register(flaky);
  h.agent.providerName = "flaky";
  await activate(h); // disabled
  runCommand(h, "on"); // enable via the command

  const res = await h.agent.run("hello");
  assert.equal(res.reason, "end_turn", "enabling via the command makes the retry handler live");
  assert.equal(flaky.calls, 2, "1 failure + 1 success");
});

// -- kill switch -------------------------------------------------------------

test("EAGENT_RELIABILITY=off: no command and no retry (total no-op)", async () => {
  const saved = process.env.EAGENT_RELIABILITY;
  process.env.EAGENT_RELIABILITY = "off";
  try {
    const h = makeHarness();
    const commandsBefore = h.commands.list().length;
    await activate(h, { enabled: true });
    assert.equal(h.commands.list().length, commandsBefore, "no command registered");

    const flaky = new FlakyProvider("flaky", 1, econnreset);
    h.agent.providers.register(flaky);
    h.agent.providerName = "flaky";
    await assert.rejects(h.agent.run("hello"), /socket hang up/);
    assert.equal(flaky.calls, 1, "no retry — the extension is a complete no-op");
  } finally {
    if (saved === undefined) delete process.env.EAGENT_RELIABILITY;
    else process.env.EAGENT_RELIABILITY = saved;
  }
});
