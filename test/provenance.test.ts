/**
 * Tests for the provenance extension: the CaMeL-lite arg-derivation gate. A
 * foreign-source tool result (net/mcp) taints a closure segment-store; a later
 * privileged-sink call (shell:exec/fs:write/…) whose string args contain a
 * verbatim ≥minLen untrusted segment is escalated — prompted in default mode
 * (blocked on a `false` answer), blocked outright in strict mode.
 *
 * AC-3 (gate on derived arg) runs through the real agent loop with content-guard
 * + provenance, so the load-order / fenced-body tagging is exercised. The other
 * ACs drive the `afterToolCall` (taint) and `beforeToolCall` (gate) seams
 * directly for determinism — the stub-UI pattern mirrors secret-guard/flow-guard.
 *
 * The single most important property: the matched untrusted VALUE never appears
 * in the escalation reason (only a redacted length + hash marker).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import provenance from "../src/extensions/provenance.js";
import contentGuard from "../src/extensions/content-guard.js";
import { defineTool } from "../src/kernel/define.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { ToolResult, UI } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";

interface StoreCfg {
  enabled?: boolean;
  mode?: "default" | "strict";
  foreignCaps?: string[];
  sinkCaps?: string[];
  minLen?: number;
  maxSegments?: number;
}

/** Activate provenance through the harness, seeding its namespaced store first. */
async function activate(h: Harness, cfg: StoreCfg = {}): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("provenance", (e) => {
    api = e;
    if (cfg.enabled !== undefined) e.store.set("enabled", cfg.enabled);
    if (cfg.mode !== undefined) e.store.set("mode", cfg.mode);
    if (cfg.foreignCaps !== undefined) e.store.set("foreignCaps", cfg.foreignCaps);
    if (cfg.sinkCaps !== undefined) e.store.set("sinkCaps", cfg.sinkCaps);
    if (cfg.minLen !== undefined) e.store.set("minLen", cfg.minLen);
    if (cfg.maxSegments !== undefined) e.store.set("maxSegments", cfg.maxSegments);
    return provenance(e);
  });
  return api;
}

/** A distinctive ≥24-char single whitespace-bounded token (survives split intact). */
const S = "EXFILPAYLOAD0123456789abcdef"; // 28 chars, no whitespace
/** A short token below the default minLen=24 floor. */
const SHORT = "shortword"; // 9 chars

function foreignTool(name = "fetch_page", content = "leading text " + S + " trailing text") {
  return defineTool({ name, description: "Fetch a URL.", capabilities: ["net:fetch"], execute: () => ({ content }) });
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { type: "tool_call" as const, id: "1", name, arguments: args };
}

/** Drive afterToolCall to taint the store from a foreign tool's result. */
function taint(h: Harness, name: string, content: string) {
  return h.agent.hooks.apply("afterToolCall", { content } as ToolResult, { call: toolCall(name) });
}

/** Drive beforeToolCall with the given arguments for a tool call. */
function gate(h: Harness, name: string, args: Record<string, unknown>) {
  return h.agent.hooks.apply("beforeToolCall", { block: false, arguments: args }, { call: toolCall(name) });
}

// -- Task 1: gate on a derived arg through the real loop (AC-3) ---------------

test("AC-3: a sink call whose arg derives from a foreign result is blocked when confirm=false", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({
    ui,
    responder: [
      { toolCalls: [{ name: "fetch_page" }] },
      { toolCalls: [{ name: "run_sink", arguments: { cmd: "process " + S } }] },
      { text: "done" },
    ],
  });
  let sinkRan = false;
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({
      name: "run_sink",
      description: "A privileged sink.",
      capabilities: ["shell:exec"],
      execute: () => ((sinkRan = true), { content: "ran" }),
    }),
  );
  await h.host.use("content-guard", contentGuard); // fences foreign ingress (load order)
  await activate(h, { enabled: true });

  await h.agent.run("fetch then run");

  assert.equal(sinkRan, false, "the derived sink call must be blocked");
  assert.equal(confirms, 1, "the gate consulted ui.confirm exactly once");
  const reason = h.agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result")
    .map((b) => (b.type === "tool_result" ? b.content : ""))
    .find((c) => /provenance/.test(c));
  assert.ok(reason, "the model sees a provenance block reason");
  assert.match(reason!, /run_sink/, "the reason names the sink tool");
  assert.ok(!reason!.includes(S), "the reason never echoes the untrusted value");
});

test("AC-3: the same derived sink call is allowed when confirm=true", async () => {
  const ui: UI = { confirm: async () => true, notify: () => {} };
  const h = makeHarness({
    ui,
    responder: [
      { toolCalls: [{ name: "fetch_page" }] },
      { toolCalls: [{ name: "run_sink", arguments: { cmd: "process " + S } }] },
      { text: "done" },
    ],
  });
  let sinkRan = false;
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({
      name: "run_sink",
      description: "A privileged sink.",
      capabilities: ["shell:exec"],
      execute: () => ((sinkRan = true), { content: "ran" }),
    }),
  );
  await h.host.use("content-guard", contentGuard);
  await activate(h, { enabled: true });

  await h.agent.run("fetch then run");
  assert.equal(sinkRan, true, "with confirm=true the derived sink call executes");
});

// -- Task 2: clean arg passes; sub-minLen overlap does not trigger (AC-4) -----

test("AC-4: a sink call with no untrusted segment is not escalated (confirm untouched)", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({ name: "run_sink", description: "", capabilities: ["shell:exec"], execute: () => ({ content: "ran" }) }),
  );
  await activate(h, { enabled: true });

  await taint(h, "fetch_page", "leading " + S + " trailing");
  const out = await gate(h, "run_sink", { cmd: "ls -la /tmp" });
  assert.equal(out.block, false, "a clean sink call passes");
  assert.equal(confirms, 0, "ui.confirm is not consulted for a clean call");
});

test("AC-4: an overlap shorter than minLen does not trigger", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({ name: "run_sink", description: "", capabilities: ["shell:exec"], execute: () => ({ content: "ran" }) }),
  );
  await activate(h, { enabled: true });

  // The foreign result carries only short tokens, so nothing is stored.
  await taint(h, "fetch_page", "the " + SHORT + " here is fine");
  const out = await gate(h, "run_sink", { cmd: "echo " + SHORT });
  assert.equal(out.block, false, "a sub-minLen overlap does not gate");
  assert.equal(confirms, 0, "no escalation for a sub-minLen overlap");
});

// -- Task 3: a non-sink tool is never escalated (AC-5) ------------------------

test("AC-5: a non-sink tool with an arg derived from untrusted content is never escalated", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({ name: "read_file", description: "", capabilities: ["fs:read"], execute: () => ({ content: "ok" }) }),
  );
  await activate(h, { enabled: true });

  await taint(h, "fetch_page", "leading " + S + " trailing");
  const out = await gate(h, "read_file", { path: S });
  assert.equal(out.block, false, "a non-sink tool is not gated");
  assert.equal(confirms, 0, "no escalation for a non-sink tool");
});

// -- Task 4: off by default — inert (AC-6) -----------------------------------

test("AC-6: with the extension loaded but not enabled, a derived sink call is inert", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({ name: "run_sink", description: "", capabilities: ["shell:exec"], execute: () => ({ content: "ran" }) }),
  );
  await activate(h); // enabled defaults false

  await taint(h, "fetch_page", "leading " + S + " trailing");
  const out = await gate(h, "run_sink", { cmd: "echo " + S });
  assert.equal(out.block, false, "off by default: a derived sink call is not blocked");
  assert.equal(confirms, 0, "off by default: no escalation");
});

// -- Task 5: governs children via a shared closure (AC-7) --------------------

test("AC-7: a childScope sub-agent's foreign read taints and its sink call is escalated", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  // Tools live on the parent registry so capsOf classifies them for the child too.
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({ name: "run_sink", description: "", capabilities: ["shell:exec"], execute: () => ({ content: "ran" }) }),
  );
  await activate(h, { enabled: true });

  // The single provenance handler instance governs the derived child bus.
  const child = h.agent.hooks.childScope();
  await child.apply("afterToolCall", { content: "leading " + S + " trailing" } as ToolResult, {
    call: toolCall("fetch_page"),
  });
  const out = await child.apply("beforeToolCall", { block: false, arguments: { cmd: "process " + S } }, {
    call: toolCall("run_sink"),
  });
  assert.equal(out.block, true, "the shared closure store gates the child's sink call");
  assert.equal(confirms, 1, "the child gate consulted ui.confirm");
  assert.ok(!(out.reason ?? "").includes(S), "the child reason never echoes the value");
});

// -- Task 6: strict mode blocks without consulting the UI --------------------

test("strict mode blocks a derived sink call WITHOUT consulting ui.confirm", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), true), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({ name: "run_sink", description: "", capabilities: ["shell:exec"], execute: () => ({ content: "ran" }) }),
  );
  await activate(h, { enabled: true, mode: "strict" });

  await taint(h, "fetch_page", "leading " + S + " trailing");
  const out = await gate(h, "run_sink", { cmd: "process " + S });
  assert.equal(out.block, true, "strict mode blocks the derived sink call");
  assert.equal(confirms, 0, "strict mode never consults ui.confirm");
  assert.ok(!(out.reason ?? "").includes(S), "the reason never echoes the value");
});

// -- Command surface ---------------------------------------------------------

test("/provenance [on|strict|off|status] toggles and reports without throwing", async () => {
  const h = makeHarness();
  await activate(h);
  const cmd = h.commands.get("provenance");
  assert.ok(cmd, "the /provenance command is registered");
  const run = (args: string): string => {
    const lines: string[] = [];
    cmd!.run({ agent: h.agent, args, print: (s) => lines.push(s) });
    return lines.join("\n");
  };
  assert.match(run("on"), /on/);
  assert.match(run("strict"), /strict/);
  assert.match(run("off"), /off/);
  assert.match(run("status"), /off|on/);
  for (const arg of ["", "on", "off", "strict", "status", "bogus"]) {
    assert.doesNotThrow(() => run(arg), `'${arg}' must not throw`);
  }
});

// -- W9.5c: a tainted string nested inside a structured arg is still detected --

test("W9.5c: a tainted segment nested in an object/array sink arg is gated", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(foreignTool());
  // mcp:call is a default sink and routinely takes arbitrary nested params.
  h.agent.tools.register(
    defineTool({ name: "mcp_tool", description: "", capabilities: ["mcp:call"], execute: () => ({ content: "ran" }) }),
  );
  await activate(h, { enabled: true });

  await taint(h, "fetch_page", "leading " + S + " trailing");
  // The tainted segment is buried inside an object, then an array — never a
  // top-level string value, which the old top-level-only scan would miss.
  const out = await gate(h, "mcp_tool", { params: { items: ["safe", "prefix " + S + " suffix"] } });
  assert.equal(out.block, true, "a nested tainted arg is detected and gated on confirm=false");
  assert.equal(confirms, 1, "the gate escalated via ui.confirm exactly once");
  assert.ok(!(out.reason ?? "").includes(S), "the reason still never echoes the untrusted value");
});

test("W9.5c: a clean nested arg with no untrusted segment is not escalated", async () => {
  let confirms = 0;
  const ui: UI = { confirm: async () => ((confirms++), false), notify: () => {} };
  const h = makeHarness({ ui });
  h.agent.tools.register(foreignTool());
  h.agent.tools.register(
    defineTool({ name: "mcp_tool", description: "", capabilities: ["mcp:call"], execute: () => ({ content: "ran" }) }),
  );
  await activate(h, { enabled: true });

  await taint(h, "fetch_page", "leading " + S + " trailing");
  const out = await gate(h, "mcp_tool", { params: { items: ["nothing", "tainted", "here at all"] } });
  assert.equal(out.block, false, "a clean nested arg passes through");
  assert.equal(confirms, 0, "no escalation for a clean nested arg");
});
