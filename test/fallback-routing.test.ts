/**
 * Tests for the fallback-routing extension: provider-outage failover.
 *
 * The failover lives entirely inside a composite `Provider` registered as
 * `"fallback"`; the extension rides `Agent.providerName` (capture on
 * `agent_start`, restore on `agent_end`) exactly as `routing` rides
 * `Agent.model`. These tests exercise the pure chain helpers directly and drive
 * the composite provider through the agent loop with throwing provider doubles —
 * all fully offline against `MockProvider`: no network, no API key, no OS sandbox.
 * Loaded via `host.use("fallback-routing", activate)`, never via
 * `BUILTIN_EXTENSIONS`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import fallbackRouting, {
  buildChain,
  normalizeChain,
  parseChainArgs,
  FALLBACK_PROVIDER_NAME,
  type FallbackEntry,
} from "../src/extensions/fallback-routing.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { CompletionRequest, Provider, StreamEvent } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness, lastText, type Harness } from "./helpers.js";

interface Cfg {
  enabled?: boolean;
  chain?: FallbackEntry[];
  tripAfter?: number;
}

/**
 * Activate fallback-routing through the harness, seeding its (namespaced) store
 * from within `activate` so the per-test config is in place before any handler
 * runs. Returns the captured `ExtensionAPI` for command dispatch.
 */
async function activate(h: Harness, cfg: Cfg = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("fallback-routing", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    if (cfg.chain !== undefined) e.store.set("chain", cfg.chain);
    if (cfg.tripAfter !== undefined) e.store.set("tripAfter", cfg.tripAfter);
    return fallbackRouting(e);
  });
  return api;
}

/** Dispatch the `/fallback-routing` command and collect its printed lines. */
function runCommand(h: Harness, args: string): string[] {
  const lines: string[] = [];
  const cmd = h.commands.get("fallback-routing");
  assert.ok(cmd, "fallback-routing command is registered");
  cmd.run({ agent: h.agent, args, print: (s) => lines.push(s) });
  return lines;
}

/** A provider that records the model it saw, then echoes via a real MockProvider. */
class RecordingProvider implements Provider {
  models: string[] = [];
  calls = 0;
  readonly #inner = new MockProvider();
  constructor(readonly name: string) {}
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    this.models.push(req.model);
    yield* this.#inner.stream(req);
  }
}

/** A provider whose stream throws BEFORE yielding any event (the outage case). */
class FailFast implements Provider {
  models: string[] = [];
  calls = 0;
  constructor(
    readonly name: string,
    private readonly onStream?: () => void,
  ) {}
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    this.models.push(req.model);
    this.onStream?.();
    throw new Error(`${this.name} is down`);
  }
}

/** A provider that yields one `text_delta` then throws (mid-stream failure). */
class MidStreamFail implements Provider {
  calls = 0;
  constructor(readonly name: string) {}
  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    yield { type: "text_delta", text: "partial" };
    throw new Error(`${this.name} failed mid-stream`);
  }
}

/** Spy `agent.providerName` as observed at each turn_start (post agent_start). */
function spyProviderName(h: Harness): (string | undefined)[] {
  const seen: (string | undefined)[] = [];
  h.agent.hooks.on("turn_start", () => {
    seen.push(h.agent.providerName);
  });
  return seen;
}

// -- unit: the pure chain helpers -------------------------------------------

test("buildChain: head first, then the configured fallbacks", () => {
  const chain = buildChain({ name: "a", model: "m0" }, [
    { provider: "b", model: "m1" },
    { provider: "c", model: "m2" },
  ]);
  assert.deepEqual(chain, [
    { name: "a", model: "m0" },
    { name: "b", model: "m1" },
    { name: "c", model: "m2" },
  ]);
});

test("buildChain: an absent head yields the fallbacks only", () => {
  const chain = buildChain(undefined, [{ provider: "b", model: "m1" }]);
  assert.deepEqual(chain, [{ name: "b", model: "m1" }]);
});

test("normalizeChain: drops the wrapper itself (recursion guard)", () => {
  const out = normalizeChain(
    [
      { name: "a", model: "m" },
      { name: FALLBACK_PROVIDER_NAME, model: "x" },
      { name: "b", model: "m" },
    ],
    { isRegistered: () => true, isTripped: () => false },
  );
  assert.deepEqual(out.map((x) => x.name), ["a", "b"]);
});

test("normalizeChain: drops unregistered providers (graceful degradation)", () => {
  const registered = new Set(["a"]);
  const out = normalizeChain(
    [
      { name: "a", model: "m" },
      { name: "ghost", model: "m" },
    ],
    { isRegistered: (n) => registered.has(n), isTripped: () => false },
  );
  assert.deepEqual(out.map((x) => x.name), ["a"]);
});

test("normalizeChain: drops tripped-open providers", () => {
  const out = normalizeChain(
    [
      { name: "a", model: "m" },
      { name: "b", model: "m" },
    ],
    { isRegistered: () => true, isTripped: (n) => n === "a" },
  );
  assert.deepEqual(out.map((x) => x.name), ["b"]);
});

test("normalizeChain: de-duplicates by name (first surviving wins)", () => {
  const out = normalizeChain(
    [
      { name: "a", model: "m0" },
      { name: "a", model: "m1" },
      { name: "b", model: "m2" },
    ],
    { isRegistered: () => true, isTripped: () => false },
  );
  assert.deepEqual(out, [
    { name: "a", model: "m0" },
    { name: "b", model: "m2" },
  ]);
});

test("parseChainArgs: parses provider/model pairs", () => {
  const r = parseChainArgs(["openai", "gpt-x", "gemini", "g-pro"]);
  assert.ok(r.ok);
  assert.deepEqual(r.chain, [
    { provider: "openai", model: "gpt-x" },
    { provider: "gemini", model: "g-pro" },
  ]);
});

test("parseChainArgs: rejects an odd argument count", () => {
  const r = parseChainArgs(["openai", "gpt-x", "gemini"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /even number/);
});

test("parseChainArgs: rejects the reserved 'fallback' provider name", () => {
  const r = parseChainArgs(["fallback", "x"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /recurse/);
});

test("parseChainArgs: rejects an empty argument list", () => {
  const r = parseChainArgs([]);
  assert.equal(r.ok, false);
});

// -- fail-fast failover + per-entry model rewrite ----------------------------

test("fail-fast head fails over to the next provider (happy path + model rewrite)", async () => {
  const h = makeHarness();
  const down = new FailFast("down");
  const echo = new RecordingProvider("echo");
  h.agent.providers.register(down);
  h.agent.providers.register(echo);
  h.agent.providerName = "down";
  h.agent.model = "head-model";
  await activate(h, { enabled: true, chain: [{ provider: "echo", model: "echo-model" }] });

  const res = await h.agent.run("hello");

  assert.equal(res.reason, "end_turn", "run completed without throwing");
  assert.match(lastText(h.agent), /hello/, "the fallback (mock echo) answered");
  assert.equal(down.calls, 1, "the head was tried once");
  assert.equal(down.models[0], "head-model", "the head saw the configured model");
  assert.equal(echo.calls, 1, "the fallback was reached");
  assert.equal(echo.models[0], "echo-model", "the fallback saw its own configured model (rewrite)");
});

test("head succeeds → the fallback is never invoked", async () => {
  const h = makeHarness();
  const spy = new RecordingProvider("spy");
  h.agent.providers.register(spy);
  // baseline provider is the default "mock", which succeeds.
  await activate(h, { enabled: true, chain: [{ provider: "spy", model: "x" }] });

  await h.agent.run("hi there");

  assert.equal(spy.calls, 0, "the fallback stream was never called when the head succeeded");
  assert.match(lastText(h.agent), /hi there/, "the head (mock echo) answered");
});

// -- mid-stream failure is fatal (no failover, no double-emit) ---------------

test("a mid-stream failure is fatal: no failover, no duplicated deltas", async () => {
  const h = makeHarness();
  const flaky = new MidStreamFail("flaky");
  const spy = new RecordingProvider("spy");
  h.agent.providers.register(flaky);
  h.agent.providers.register(spy);
  h.agent.providerName = "flaky";
  await activate(h, { enabled: true, chain: [{ provider: "spy", model: "x" }] });

  const deltas: string[] = [];
  h.agent.hooks.on("text_delta", (p) => {
    deltas.push((p as { text: string }).text);
  });

  await assert.rejects(h.agent.run("hello"), /mid-stream/, "the mid-stream error propagated");
  assert.equal(spy.calls, 0, "no failover after the head committed events");
  assert.deepEqual(deltas, ["partial"], "the head's delta was seen exactly once (no duplication)");
});

// -- abort during the head is not a failover trigger -------------------------

test("an abort during the head propagates and does NOT fail over", async () => {
  const h = makeHarness();
  const down = new FailFast("down", () => h.agent.stop());
  const spy = new RecordingProvider("spy");
  h.agent.providers.register(down);
  h.agent.providers.register(spy);
  h.agent.providerName = "down";
  await activate(h, { enabled: true, chain: [{ provider: "spy", model: "x" }] });

  await assert.rejects(h.agent.run("hello"), "the aborted head error propagated");
  assert.equal(spy.calls, 0, "the next entry was not tried after an abort");
});

// -- recursion guard via a misconfigured chain -------------------------------

test("a 'fallback' entry in the chain is dropped (no recursion, run completes)", async () => {
  const h = makeHarness();
  const down = new FailFast("down");
  const echo = new RecordingProvider("echo");
  h.agent.providers.register(down);
  h.agent.providers.register(echo);
  h.agent.providerName = "down";
  await activate(h, {
    enabled: true,
    chain: [
      { provider: FALLBACK_PROVIDER_NAME, model: "x" },
      { provider: "echo", model: "echo-model" },
    ],
  });

  const res = await h.agent.run("hello");

  assert.equal(res.reason, "end_turn", "run terminated normally — no stack overflow");
  assert.equal(echo.calls, 1, "the real fallback answered after the head failed");
  assert.match(lastText(h.agent), /hello/);
});

// -- offline degrade: an all-unregistered chain is head-only -----------------

test("an all-unregistered fallback list degrades to a transparent head-only pass-through", async () => {
  const h = makeHarness();
  // baseline = "mock" (the registered default); fallbacks reference nothing real.
  await activate(h, {
    enabled: true,
    chain: [
      { provider: "ghost-a", model: "x" },
      { provider: "ghost-b", model: "y" },
    ],
  });

  const res = await h.agent.run("offline please");

  assert.equal(res.reason, "end_turn", "the head answered; zero behavior change");
  assert.match(lastText(h.agent), /offline please/, "the head (mock) answered directly");
});

// -- per-run circuit trip: a down provider is skipped after tripAfter --------

test("per-run circuit: a head that trips is skipped on the next turn", async () => {
  const h = makeHarness();
  const down = new FailFast("down");
  const echo = new RecordingProvider("echo");
  h.agent.providers.register(down);
  h.agent.providers.register(echo);
  h.agent.providerName = "down";
  // tripAfter=1: one failure trips the head open for the rest of the run.
  await activate(h, { enabled: true, tripAfter: 1, chain: [{ provider: "echo", model: "echo-model" }] });

  // Drive a 2nd turn so the trip is observable on a later turn.
  h.agent.hooks.on("turn_start", (p) => {
    if ((p as { turn: number }).turn === 1) {
      h.agent.followUp({ role: "user", content: [{ type: "text", text: "again" }] });
    }
  });

  const res = await h.agent.run("first");

  assert.equal(res.reason, "end_turn");
  assert.equal(down.calls, 1, "the tripped head was NOT re-invoked on turn 2");
  assert.equal(echo.calls, 2, "the fallback served both turns");
});

// -- restore on agent_end (no residue) + soft off ----------------------------

test("providerName is restored on agent_end (no residue)", async () => {
  const h = makeHarness();
  const down = new FailFast("down");
  h.agent.providers.register(down);
  h.agent.providerName = "down";
  await activate(h, { enabled: true, chain: [{ provider: "mock", model: "mock" }] });

  const seen = spyProviderName(h);
  assert.equal(h.agent.providerName, "down", "baseline before run");
  await h.agent.run("hello");
  assert.equal(seen[0], FALLBACK_PROVIDER_NAME, "pointed at the wrapper during the run");
  assert.equal(h.agent.providerName, "down", "configured provider restored after the run");
});

test("/fallback-routing off restores the configured baseline immediately", async () => {
  const h = makeHarness();
  await activate(h, { enabled: true });
  // Simulate the override being live mid-session; off must restore now.
  h.agent.providerName = FALLBACK_PROVIDER_NAME;
  runCommand(h, "off");
  assert.equal(h.agent.providerName, "mock", "/fallback-routing off restored the baseline");
});

// -- EAGENT_FALLBACK_ROUTING=off is a total no-op ----------------------------

test("EAGENT_FALLBACK_ROUTING=off: no provider, no listeners, no command", async () => {
  const saved = process.env.EAGENT_FALLBACK_ROUTING;
  process.env.EAGENT_FALLBACK_ROUTING = "off";
  try {
    const h = makeHarness();
    const providersBefore = h.agent.providers.list().length;
    const agentStartBefore = h.agent.hooks.listenerCount("agent_start");
    const agentEndBefore = h.agent.hooks.listenerCount("agent_end");
    const commandsBefore = h.commands.list().length;

    await activate(h, { enabled: true });

    assert.equal(h.agent.providers.list().length, providersBefore, "no provider registered");
    assert.equal(h.agent.providers.get(FALLBACK_PROVIDER_NAME), undefined, "no 'fallback' provider");
    assert.equal(h.agent.hooks.listenerCount("agent_start"), agentStartBefore, "no agent_start listener");
    assert.equal(h.agent.hooks.listenerCount("agent_end"), agentEndBefore, "no agent_end listener");
    assert.equal(h.commands.list().length, commandsBefore, "no command");

    const seen = spyProviderName(h);
    await h.agent.run("hello");
    assert.notEqual(seen[0], FALLBACK_PROVIDER_NAME, "providerName never pointed at the wrapper");
    assert.equal(h.agent.providerName, "mock", "ends on the configured provider");
  } finally {
    if (saved === undefined) delete process.env.EAGENT_FALLBACK_ROUTING;
    else process.env.EAGENT_FALLBACK_ROUTING = saved;
  }
});

// -- disabled default: wrapper registered but unused -------------------------

test("disabled (default): providerName is never pointed at the wrapper", async () => {
  const h = makeHarness();
  await activate(h); // enabled unset → false

  const seen = spyProviderName(h);
  await h.agent.run("hello");

  assert.notEqual(seen[0], FALLBACK_PROVIDER_NAME, "wrapper registered but unused while disabled");
  assert.equal(seen[0], "mock", "the configured provider was used directly");
  assert.match(lastText(h.agent), /hello/);
});

// -- registration deltas + unload reversibility ------------------------------

test("activation adds one provider, agent_start/agent_end + one command, zero tools", async () => {
  const h = makeHarness();
  const providersBefore = h.agent.providers.list().length;
  const toolsBefore = h.agent.tools.list().length;
  const commandsBefore = h.commands.list().length;
  const agentStartBefore = h.agent.hooks.listenerCount("agent_start");
  const agentEndBefore = h.agent.hooks.listenerCount("agent_end");

  await h.host.use("fallback-routing", fallbackRouting);

  assert.equal(h.agent.providers.list().length, providersBefore + 1, "one provider");
  assert.ok(h.agent.providers.get(FALLBACK_PROVIDER_NAME), "the 'fallback' provider exists");
  assert.equal(h.agent.tools.list().length, toolsBefore, "zero tools");
  assert.equal(h.commands.list().length, commandsBefore + 1, "one command");
  assert.equal(h.agent.hooks.listenerCount("agent_start"), agentStartBefore + 1);
  assert.equal(h.agent.hooks.listenerCount("agent_end"), agentEndBefore + 1);

  await h.host.unload("fallback-routing");

  assert.equal(h.agent.providers.list().length, providersBefore, "provider removed");
  assert.equal(h.agent.providers.get(FALLBACK_PROVIDER_NAME), undefined, "wrapper gone");
  assert.equal(h.commands.list().length, commandsBefore, "command removed");
  assert.equal(h.agent.hooks.listenerCount("agent_start"), agentStartBefore, "agent_start removed");
  assert.equal(h.agent.hooks.listenerCount("agent_end"), agentEndBefore, "agent_end removed");
});

test("after unload a subsequent run never points at the wrapper", async () => {
  const h = makeHarness();
  await activate(h, { enabled: true });
  await h.host.unload("fallback-routing");

  const seen = spyProviderName(h);
  await h.agent.run("hello");
  assert.notEqual(seen[0], FALLBACK_PROVIDER_NAME, "providerName unchanged after unload");
  assert.equal(h.agent.providerName, "mock");
});

// -- command surface ---------------------------------------------------------

test("/fallback-routing on|off|status|chain|reset", async () => {
  const h = makeHarness();
  await activate(h); // disabled by default

  assert.match(runCommand(h, "status").join("\n"), /enabled=false/, "off by default");
  runCommand(h, "on");
  assert.match(runCommand(h, "status").join("\n"), /enabled=true/);
  runCommand(h, "off");
  assert.match(runCommand(h, "status").join("\n"), /enabled=false/);

  // chain setter: valid pairs.
  const out = runCommand(h, "chain openai gpt-x gemini g-pro");
  assert.match(out.join("\n"), /openai:gpt-x -> gemini:g-pro/, "the chain setter stored the pairs");
  assert.match(runCommand(h, "status").join("\n"), /openai:gpt-x/, "status reflects the new chain");

  // chain setter: odd arg count is rejected.
  assert.match(runCommand(h, "chain openai").join("\n"), /even number/, "odd arg count rejected");

  // chain setter: the reserved name is rejected.
  assert.match(runCommand(h, "chain fallback x").join("\n"), /recurse/, "reserved name rejected");

  // reset clears the per-run circuit.
  assert.match(runCommand(h, "reset").join("\n"), /circuit cleared/);
});
