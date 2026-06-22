/**
 * Tests for the risk-guard extension: the LLM-based semantic risk analyzer on
 * the `beforeToolCall` seam.
 *
 * The pure `parseVerdict` function is exercised directly (the verdict-protocol
 * invariant), and the guard handler is exercised through the harness by applying
 * `beforeToolCall` directly with a scripted, call-counting classifier provider —
 * keeping the suite offline with no network or API key.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import riskGuard, { parseVerdict } from "../src/extensions/risk-guard.js";
import { defineTool } from "../src/kernel/define.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { CompletionRequest, Logger, UI } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness, type Harness } from "./helpers.js";

interface StoreCfg {
  enabled?: boolean;
  mode?: "ask" | "block";
  sensitiveCaps?: string[];
}

/**
 * Activate risk-guard through the harness, seeding its (namespaced) store from
 * within `activate` so the per-test config is in place before the hook runs.
 * Returns the captured `ExtensionAPI` for command dispatch.
 */
async function activate(h: Harness, cfg: StoreCfg = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("risk-guard", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    if (cfg.mode !== undefined) e.store.set("mode", cfg.mode);
    if (cfg.sensitiveCaps !== undefined) e.store.set("sensitiveCaps", cfg.sensitiveCaps);
    return riskGuard(e);
  });
  return api;
}

/** Dispatch the `/risk-guard` command and collect its printed lines. */
function runCommand(h: Harness, args: string): string[] {
  const lines: string[] = [];
  const cmd = h.commands.get("risk-guard");
  assert.ok(cmd, "risk-guard command is registered");
  cmd.run({ agent: h.agent, args, print: (s) => lines.push(s) });
  return lines;
}

/** A MockProvider that returns one scripted verdict line and counts `stream`. */
class Classifier extends MockProvider {
  calls = 0;
  constructor(verdict: string) {
    super(() => ({ text: verdict }));
  }
  override async *stream(req: CompletionRequest) {
    this.calls++;
    yield* super.stream(req);
  }
}

/** A provider whose `stream` throws, to drive the fail-open path. */
class Throwing extends MockProvider {
  calls = 0;
  override async *stream(_req: CompletionRequest): AsyncGenerator<never> {
    this.calls++;
    throw new Error("provider unavailable");
  }
}

function shellTool(name = "run_shell") {
  return defineTool({
    name,
    description: "Run a shell command.",
    capabilities: ["shell:exec"],
    execute: () => ({ content: "ran" }),
  });
}

function readTool(name = "read_file") {
  return defineTool({
    name,
    description: "Read a file.",
    capabilities: ["fs:read"],
    execute: () => ({ content: "data" }),
  });
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { type: "tool_call" as const, id: "1", name, arguments: args };
}

/** Apply `beforeToolCall` with the given input decision for a tool call. */
function applyHook(h: Harness, name: string, args: Record<string, unknown> = {}) {
  return h.agent.hooks.apply("beforeToolCall", { block: false, arguments: {} }, { call: toolCall(name, args) });
}

// -- parseVerdict (task 1) ---------------------------------------------------

test("parseVerdict: RISKY with reason", () => {
  assert.deepEqual(parseVerdict("RISKY: deletes home"), { risky: true, reason: "deletes home" });
});

test("parseVerdict: RISKY without colon has empty reason", () => {
  assert.deepEqual(parseVerdict("RISKY (no colon)"), { risky: true, reason: "" });
});

test("parseVerdict: SAFE", () => {
  assert.deepEqual(parseVerdict("SAFE"), { risky: false });
});

test("parseVerdict: leading token is case-insensitive", () => {
  assert.deepEqual(parseVerdict("safe, looks fine"), { risky: false });
});

test("parseVerdict: empty and unrecognized are undefined", () => {
  assert.equal(parseVerdict(""), undefined);
  assert.equal(parseVerdict("   \n  "), undefined);
  assert.equal(parseVerdict("I think maybe..."), undefined);
});

test("parseVerdict: skips blank leading lines to the first non-empty line", () => {
  assert.deepEqual(parseVerdict("\n\n   \nRISKY: wipes disk\nmore"), { risky: true, reason: "wipes disk" });
});

// -- handler behavior (tasks 2-10) -------------------------------------------

test("AC-1: risky in block mode blocks with the model's reason", async () => {
  const h = makeHarness();
  h.agent.tools.register(shellTool());
  const c = new Classifier("RISKY: removes the home directory");
  h.agent.providers.register(c, { default: true });
  await activate(h, { enabled: true, mode: "block" });

  const out = await applyHook(h, "run_shell", { cmd: "rm -rf ~" });

  assert.equal(out.block, true);
  assert.match(out.reason ?? "", /removes the home directory/);
  assert.equal(c.calls, 1);
});

test("AC-2: risky in ask mode asks once; deny blocks, allow passes", async () => {
  let confirms = 0;
  const denyUI: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui: denyUI });
  h.agent.tools.register(shellTool());
  h.agent.providers.register(new Classifier("RISKY: dangerous"), { default: true });
  await activate(h, { enabled: true, mode: "ask" });

  const denied = await applyHook(h, "run_shell", { cmd: "x" });
  assert.equal(denied.block, true);
  assert.equal(confirms, 1);

  let allows = 0;
  const allowUI: UI = { confirm: async () => ((allows++), true), notify: () => {} };
  const h2 = makeHarness({ ui: allowUI });
  h2.agent.tools.register(shellTool());
  h2.agent.providers.register(new Classifier("RISKY: dangerous"), { default: true });
  await activate(h2, { enabled: true, mode: "ask" });

  const allowed = await applyHook(h2, "run_shell", { cmd: "x" });
  assert.equal(allowed.block, false);
  assert.equal(allows, 1);
});

test("AC-3: safe passes without prompting", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(shellTool());
  h.agent.providers.register(new Classifier("SAFE"), { default: true });
  await activate(h, { enabled: true, mode: "ask" });

  const out = await applyHook(h, "run_shell", { cmd: "ls" });
  assert.equal(out.block, false);
  assert.equal(confirms, 0);
});

test("AC-4: out-of-scope tool makes no provider call", async () => {
  const h = makeHarness();
  h.agent.tools.register(readTool());
  const c = new Classifier("RISKY: x");
  h.agent.providers.register(c, { default: true });
  await activate(h, { enabled: true, mode: "block" });

  const out = await applyHook(h, "read_file", { path: "a.txt" });
  assert.equal(out.block, false);
  assert.equal(c.calls, 0);
});

test("AC-5: an already-blocked decision passes through untouched", async () => {
  const h = makeHarness();
  h.agent.tools.register(shellTool());
  const c = new Classifier("RISKY: x");
  h.agent.providers.register(c, { default: true });
  await activate(h, { enabled: true, mode: "block" });

  const out = await h.agent.hooks.apply(
    "beforeToolCall",
    { block: true, reason: "upstream", arguments: {} },
    { call: toolCall("run_shell", { cmd: "x" }) },
  );
  assert.equal(out.block, true);
  assert.equal(out.reason, "upstream");
  assert.equal(c.calls, 0);
});

test("AC-6: disabled (default, and via env switch) makes no provider call", async () => {
  const h = makeHarness();
  h.agent.tools.register(shellTool());
  const c = new Classifier("RISKY: x");
  h.agent.providers.register(c, { default: true });
  await activate(h); // enabled left at its default (off)

  const out = await applyHook(h, "run_shell", { cmd: "x" });
  assert.equal(out.block, false);
  assert.equal(c.calls, 0);

  const saved = process.env.EAGENT_RISK_GUARD;
  process.env.EAGENT_RISK_GUARD = "off";
  try {
    const h2 = makeHarness();
    h2.agent.tools.register(shellTool());
    const c2 = new Classifier("RISKY: x");
    h2.agent.providers.register(c2, { default: true });
    await activate(h2, { enabled: true, mode: "block" });

    const out2 = await applyHook(h2, "run_shell", { cmd: "x" });
    assert.equal(out2.block, false);
    assert.equal(c2.calls, 0);
  } finally {
    if (saved === undefined) delete process.env.EAGENT_RISK_GUARD;
    else process.env.EAGENT_RISK_GUARD = saved;
  }
});

test("AC-7: analyzer failure fails open with a warning", async () => {
  const warnings: unknown[][] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
  };

  // (a) provider stream throws.
  const ha = makeHarness({ logger });
  ha.agent.tools.register(shellTool());
  ha.agent.providers.register(new Throwing(), { default: true });
  await activate(ha, { enabled: true, mode: "block" });

  const outA = await applyHook(ha, "run_shell", { cmd: "x" });
  assert.equal(outA.block, false);
  assert.ok(warnings.length >= 1);
  assert.ok(warnings.some((args) => args.some((a) => typeof a === "string" && /risk-guard/.test(a))));

  // (b) garbled verdict line.
  warnings.length = 0;
  const hb = makeHarness({ logger });
  hb.agent.tools.register(shellTool());
  hb.agent.providers.register(new Classifier("hmm not sure"), { default: true });
  await activate(hb, { enabled: true, mode: "block" });

  const outB = await applyHook(hb, "run_shell", { cmd: "x" });
  assert.equal(outB.block, false);
  assert.ok(warnings.length >= 1);
});

test("AC-8: registration adds one beforeToolCall filter and one command, no tools", async () => {
  const h = makeHarness();
  const toolsBefore = h.agent.tools.list().length;
  const commandsBefore = h.commands.list().length;
  const hooksBefore = h.agent.hooks.listenerCount("beforeToolCall");

  await h.host.use("risk-guard", riskGuard);

  assert.equal(h.agent.tools.list().length, toolsBefore);
  assert.equal(h.commands.list().length, commandsBefore + 1);
  assert.equal(h.agent.hooks.listenerCount("beforeToolCall"), hooksBefore + 1);
});

test("AC-9: command toggles state and gates only when on", async () => {
  const h = makeHarness();
  h.agent.tools.register(shellTool());
  const c = new Classifier("RISKY: x");
  h.agent.providers.register(c, { default: true });
  await activate(h);

  runCommand(h, "on");
  assert.match(runCommand(h, "status").join("\n"), /risk-guard on/);
  assert.match(runCommand(h, "status").join("\n"), /shell:exec/);

  runCommand(h, "block");
  assert.match(runCommand(h, "status").join("\n"), /mode=block/);

  runCommand(h, "ask");
  assert.match(runCommand(h, "status").join("\n"), /mode=ask/);

  runCommand(h, "off");
  assert.match(runCommand(h, "status").join("\n"), /risk-guard off/);

  const out = await applyHook(h, "run_shell", { cmd: "x" });
  assert.equal(out.block, false);
  assert.equal(c.calls, 0);
});
