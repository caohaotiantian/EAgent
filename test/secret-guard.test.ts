/**
 * Tests for the secret-guard extension: keep secret VALUES out of tool args (and
 * therefore out of the transcript) by scanning a leak-capable tool's arguments on
 * the `beforeToolCall` seam.
 *
 * The pure detectors (`scanSecrets`, `scanArgs`) are exercised directly, and the
 * guard handler is exercised through the harness by applying `beforeToolCall`
 * directly with inline stub tools — no provider call, no network, offline.
 *
 * The single most important property under test: the matched secret VALUE is
 * never echoed into a kind label, a reason string, or a confirm prompt.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import secretGuard, { scanSecrets, scanArgs } from "../src/extensions/secret-guard.js";
import { defineTool } from "../src/kernel/define.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { UI } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";

interface StoreCfg {
  enabled?: boolean;
  mode?: "ask" | "block";
  leakCaps?: string[];
}

/**
 * Activate secret-guard through the harness, seeding its (namespaced) store from
 * within `activate` so the per-test config is in place before the hook runs.
 * Loads via `host.use(id, activate)` — does NOT depend on `BUILTIN_EXTENSIONS`.
 * Returns the captured `ExtensionAPI` for command dispatch.
 */
async function activate(h: Harness, cfg: StoreCfg = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("secret-guard", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    if (cfg.mode !== undefined) e.store.set("mode", cfg.mode);
    if (cfg.leakCaps !== undefined) e.store.set("leakCaps", cfg.leakCaps);
    return secretGuard(e);
  });
  return api;
}

/** Dispatch the `/secret-guard` command and collect its printed lines. */
function runCommand(h: Harness, args: string): string[] {
  const lines: string[] = [];
  const cmd = h.commands.get("secret-guard");
  assert.ok(cmd, "secret-guard command is registered");
  cmd.run({ agent: h.agent, args, print: (s) => lines.push(s) });
  return lines;
}

function fetchTool(name = "post") {
  return defineTool({
    name,
    description: "Send an HTTP request.",
    capabilities: ["net:fetch"],
    execute: () => ({ content: "ok" }),
  });
}

function shellTool(name = "run_shell") {
  return defineTool({
    name,
    description: "Run a shell command.",
    capabilities: ["shell:exec"],
    execute: () => ({ content: "ok" }),
  });
}

function mcpTool(name = "mcp_call") {
  return defineTool({
    name,
    description: "Call an MCP tool.",
    capabilities: ["mcp:call"],
    execute: () => ({ content: "ok" }),
  });
}

function benignTool(name = "read_file") {
  return defineTool({
    name,
    description: "Read a file.",
    capabilities: ["fs:read"],
    execute: () => ({ content: "ok" }),
  });
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { type: "tool_call" as const, id: "1", name, arguments: args };
}

/** Apply `beforeToolCall` with the given input decision for a tool call. */
function applyHook(h: Harness, name: string, args: Record<string, unknown> = {}) {
  return h.agent.hooks.apply("beforeToolCall", { block: false, arguments: {} }, { call: toolCall(name, args) });
}

/** A representative secret literal: `sk-` + 20 chars satisfies `sk-[A-Za-z0-9_-]{16,}`. */
const SK = "sk-" + "a".repeat(20);
const AKIA = "AKIA" + "ABCDEFGHIJKLMNOP"; // AKIA + 16 upper alnum
const GHP = "ghp_" + "a".repeat(36);
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";

// -- Task 1: scanSecrets unit (AC-1, AC-2, AC-3) -----------------------------

test("AC-1: scanSecrets recognizes each known credential shape by kind", () => {
  assert.ok(scanSecrets(PEM).includes("pem-private-key"));
  assert.ok(scanSecrets(AKIA).includes("aws-access-key-id"));
  assert.ok(scanSecrets(SK).some((k) => /sk-|openai/.test(k)));
  assert.ok(scanSecrets(GHP).some((k) => /ghp|github/.test(k)));
});

test("AC-2: scanSecrets raises no false positive on benign strings", () => {
  assert.deepEqual(scanSecrets("hello world"), []);
  assert.deepEqual(scanSecrets("/tmp/x.ts"), []);
  // a 40-char lowercase hex git SHA must not match (no entropy gate, D4)
  assert.deepEqual(scanSecrets("a".repeat(40)), []);
  assert.deepEqual(scanSecrets("3f5a9c1e7b2d4f6081a9c3e5b7d9f1a2c4e6b8d0"), []);
});

test("AC-3: scanSecrets never echoes the matched value (kinds only)", () => {
  for (const secret of [SK, AKIA, GHP, PEM]) {
    const joined = scanSecrets(secret).join(" ");
    assert.ok(!joined.includes(secret.slice(0, 12)), "no substring of the secret leaks into the kind array");
  }
});

test("AC-2/AC-3: a non-string input returns []", () => {
  // scanSecrets is typed for string, but must be defensive for non-string callers.
  assert.deepEqual(scanSecrets(undefined as unknown as string), []);
  assert.deepEqual(scanSecrets(123 as unknown as string), []);
});

// -- Task 2: scanArgs nested-walk unit (AC-11) -------------------------------

test("AC-11: scanArgs descends arrays and nested objects", () => {
  assert.ok(scanArgs({ headers: ["Authorization: Bearer " + SK] }).length > 0);
  assert.ok(scanArgs({ a: { b: AKIA } }).length > 0);
  // de-duped union of kinds across nesting
  const kinds = scanArgs({ a: SK, b: { c: [SK] } });
  assert.equal(new Set(kinds).size, kinds.length, "kinds are de-duplicated");
});

test("AC-11: scanArgs on clean nested args returns []", () => {
  assert.deepEqual(scanArgs({ a: { b: "ls -la" } }), []);
  assert.deepEqual(scanArgs({ n: 5, ok: true, nil: null, list: ["one", "two"] }), []);
});

// -- Task 3: benign-cap tool is never gated (AC-4) ---------------------------

test("AC-4: a secret in a benign-cap tool's args is never gated", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(benignTool());
  await activate(h, { enabled: true, mode: "ask" });

  const out = await applyHook(h, "read_file", { path: "config", body: SK });
  assert.equal(out.block, false);
  assert.equal(confirms, 0);
});

// -- Task 4: block mode holds; ask mode deny/allow (AC-5, AC-6) ---------------

test("AC-5: block mode holds a leaky secret call, naming kind not value", async () => {
  const h = makeHarness();
  h.agent.tools.register(fetchTool());
  await activate(h, { enabled: true, mode: "block" });

  const out = await applyHook(h, "post", { headers: ["Authorization: Bearer " + SK] });
  assert.equal(out.block, true);
  assert.match(out.reason ?? "", /sk-|openai/);
  assert.ok(!(out.reason ?? "").includes(SK), "the literal secret value is absent from the reason");
});

test("AC-6: ask mode — deny blocks (confirm once)", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(shellTool());
  await activate(h, { enabled: true, mode: "ask" });

  const out = await applyHook(h, "run_shell", { cmd: 'curl -H "Authorization: Bearer ' + SK + '"' });
  assert.equal(out.block, true);
  assert.equal(confirms, 1);
  assert.ok(!(out.reason ?? "").includes(SK), "denied reason never contains the value");
});

test("AC-6: ask mode — allow passes (confirm once)", async () => {
  let allows = 0;
  const ui: UI = { confirm: async () => ((allows++), true), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(shellTool());
  await activate(h, { enabled: true, mode: "ask" });

  const out = await applyHook(h, "run_shell", { cmd: 'curl -H "Authorization: Bearer ' + SK + '"' });
  assert.equal(out.block, false);
  assert.equal(allows, 1);
});

test("AC-5/§8: the confirm prompt never contains the literal value", async () => {
  const prompts: string[] = [];
  const ui: UI = { confirm: async (q) => (prompts.push(q), true), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(fetchTool());
  await activate(h, { enabled: true, mode: "ask" });

  await applyHook(h, "post", { headers: ["Authorization: Bearer " + SK] });
  assert.equal(prompts.length, 1);
  assert.ok(!prompts[0]!.includes(SK), "the confirm prompt names the kind, not the value");
});

test("an mcp:call tool is in the leak set: a secret in its args is held (block mode)", async () => {
  const h = makeHarness();
  h.agent.tools.register(mcpTool());
  await activate(h, { enabled: true, mode: "block" });

  const out = await applyHook(h, "mcp_call", { headers: ["Authorization: Bearer " + SK] });
  assert.equal(out.block, true);
  assert.match(out.reason ?? "", /sk-|openai/);
  assert.ok(!(out.reason ?? "").includes(SK), "the literal secret value is absent from the reason");
});

// -- Task 5: clean args pass without prompting (AC-7) ------------------------

test("AC-7: clean args on a leak-capable tool pass without prompt or block", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(shellTool());
  await activate(h, { enabled: true, mode: "ask" });

  const out = await applyHook(h, "run_shell", { cmd: "ls -la" });
  assert.equal(out.block, false);
  assert.equal(confirms, 0);
});

// -- Task 6: kill switch (AC-8) ----------------------------------------------

test("AC-8: EAGENT_SECRET_GUARD=off disables the guard", async () => {
  const saved = process.env.EAGENT_SECRET_GUARD;
  process.env.EAGENT_SECRET_GUARD = "off";
  try {
    let confirms = 0;
    const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
    const h = makeHarness({ ui });
    h.agent.tools.register(shellTool());
    await activate(h, { enabled: true, mode: "block" });

    const out = await applyHook(h, "run_shell", { cmd: "echo " + SK });
    assert.equal(out.block, false);
    assert.equal(confirms, 0);
  } finally {
    if (saved === undefined) delete process.env.EAGENT_SECRET_GUARD;
    else process.env.EAGENT_SECRET_GUARD = saved;
  }
});

test("§8: an already-blocked decision passes through untouched (never un-blocked)", async () => {
  const h = makeHarness();
  h.agent.tools.register(shellTool());
  await activate(h, { enabled: true, mode: "block" });

  const out = await h.agent.hooks.apply(
    "beforeToolCall",
    { block: true, reason: "upstream", arguments: {} },
    { call: toolCall("run_shell", { cmd: "echo " + SK }) },
  );
  assert.equal(out.block, true);
  assert.equal(out.reason, "upstream");
});

// -- Task 7: clean teardown via host.unload (AC-10) --------------------------

test("AC-10: host.unload removes the beforeToolCall hook", async () => {
  const h = makeHarness();
  h.agent.tools.register(shellTool());
  const before = h.agent.hooks.listenerCount("beforeToolCall");
  await activate(h, { enabled: true, mode: "block" });
  assert.equal(h.agent.hooks.listenerCount("beforeToolCall"), before + 1);

  await h.host.unload("secret-guard");
  assert.equal(h.agent.hooks.listenerCount("beforeToolCall"), before);

  const out = await applyHook(h, "run_shell", { cmd: "echo " + SK });
  assert.equal(out.block, false, "after unload the filter is gone");
});

// -- Task 8: the command surface (AC-9) --------------------------------------

test("AC-9: /secret-guard [off|block|status] toggles guard behavior", async () => {
  const h = makeHarness();
  h.agent.tools.register(shellTool());
  await activate(h, { enabled: true, mode: "block" });

  // off — a matching call now passes.
  runCommand(h, "off");
  const offOut = await applyHook(h, "run_shell", { cmd: "echo " + SK });
  assert.equal(offOut.block, false);

  // on + block — a subsequent matching call is held.
  runCommand(h, "on");
  runCommand(h, "block");
  const blockOut = await applyHook(h, "run_shell", { cmd: "echo " + SK });
  assert.equal(blockOut.block, true);

  // ask flips the mode word.
  assert.doesNotThrow(() => runCommand(h, "ask"));

  // status reports on/off, the mode, and a leakCaps token.
  const status = runCommand(h, "status").join("\n");
  assert.match(status, /\bon\b|\boff\b/);
  assert.match(status, /ask|block/);
  assert.match(status, /net:fetch|shell:exec/);
});

test("AC-9: no /secret-guard subcommand throws (including unknown args)", async () => {
  const h = makeHarness();
  await activate(h, { enabled: true });
  for (const arg of ["", "on", "off", "ask", "block", "status", "bogus"]) {
    assert.doesNotThrow(() => runCommand(h, arg), `'${arg}' must not throw`);
  }
});

// -- GUARD-1: scanArgs is depth-bounded (a deep payload can't RangeError past a scannable secret) --

test("GUARD-1: a pathologically deep arg doesn't overflow the scan; a shallow secret is still detected", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 25000; i++) deep = { n: deep };
  const args = { key: "AKIAIOSFODNN7EXAMPLE", blob: deep };
  let kinds: string[] = [];
  assert.doesNotThrow(() => {
    kinds = scanArgs(args);
  }, "a deeply-nested arg must not overflow the recursive scan");
  assert.ok(kinds.includes("aws-access-key-id"), "the shallow secret is still surfaced (not lost to a fail-open throw)");
});

test("GUARD-1: a normally-nested secret (within the depth bound) is still detected", () => {
  const args = { a: { b: { c: { d: "AKIAIOSFODNN7EXAMPLE" } } } }; // depth 4, well within the bound
  assert.ok(scanArgs(args).includes("aws-access-key-id"));
});
