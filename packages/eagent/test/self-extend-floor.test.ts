/**
 * Tests for the self-extend-floor extension: a `beforeToolCall` guard that
 * refuses a `self:extend`-capability tool call when the acting model
 * (`e.agent.model`) matches none of a configured allowlist of model substrings.
 *
 * The pure helpers `parseAllowlist`/`modelAllowed` are exercised directly (the
 * matching-semantics invariant); the guard is driven through the harness hook
 * chain via `agent.hooks.apply("beforeToolCall", …)`, keeping the suite offline
 * (no network, no API key — `agent.model` is `"mock"`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import selfExtendFloor, { modelAllowed, parseAllowlist } from "../src/extensions/self-extend-floor.ts";
import { Agent } from "../src/kernel/agent.ts";
import { defineTool, ok } from "../src/kernel/define.ts";
import { ProviderRegistry, ToolRegistry } from "../src/kernel/registry.ts";
import type { CompletionRequest, Logger, ToolResult } from "../src/kernel/types.ts";
import { MockProvider, type MockResponder } from "../src/providers/mock.ts";
import { makeHarness, type Harness } from "./helpers.ts";

/** A `self:extend`-gated probe tool. */
function probeTool(name = "probe_extend") {
  return defineTool({
    name,
    description: "test probe",
    capabilities: ["self:extend"],
    parameters: { type: "object", properties: {} },
    execute: async () => ok(""),
  });
}

/** A control tool declaring no capabilities. */
function plainTool(name = "plain") {
  return defineTool({
    name,
    description: "plain control tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ok(""),
  });
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { type: "tool_call" as const, id: "1", name, arguments: args };
}

/** Apply `beforeToolCall` (block:false input) for a tool call. */
function applyHook(h: Harness, name: string, args: Record<string, unknown> = {}) {
  return h.agent.hooks.apply("beforeToolCall", { block: false, arguments: {} }, { call: toolCall(name, args) });
}

// -- task 1: pure helpers ----------------------------------------------------

test("parseAllowlist: empty/whitespace raw → [] (inert)", () => {
  assert.deepEqual(parseAllowlist(undefined), []);
  assert.deepEqual(parseAllowlist(""), []);
  assert.deepEqual(parseAllowlist("   ,  , "), []);
  // split, trim, lowercase, drop empties
  assert.deepEqual(parseAllowlist(" Opus , SONNET ,, "), ["opus", "sonnet"]);
});

test("modelAllowed: empty patterns is inert (always true)", () => {
  assert.equal(modelAllowed("mock", []), true);
  assert.equal(modelAllowed("anything", []), true);
});

test("modelAllowed: substring match, case-insensitive; over-allow documented", () => {
  assert.equal(modelAllowed("mock", ["mock"]), true);
  assert.equal(modelAllowed("mock", ["opus", "sonnet"]), false);
  assert.equal(modelAllowed("mock", ["MOCK"]), true); // case-insensitive
  assert.equal(modelAllowed("gpt-4o-mini", ["gpt-4"]), true); // documented over-allow
});

test("modelAllowed: opt-in exact mode refuses the substring over-allow; default arg is substring", () => {
  // The documented over-allow is admitted under substring, refused under exact.
  assert.equal(modelAllowed("gpt-4o-mini", ["gpt-4"], "substring"), true);
  assert.equal(modelAllowed("gpt-4o-mini", ["gpt-4"], "exact"), false);
  // Exact is a full-id equality, case-insensitive on BOTH sides.
  assert.equal(modelAllowed("mock", ["mock"], "exact"), true);
  assert.equal(modelAllowed("mock", ["MOCK"], "exact"), true);
  // No mode arg → substring (default unchanged, byte-identical to two-arg).
  assert.equal(modelAllowed("gpt-4o-mini", ["gpt-4"]), true);
  // Empty patterns is inert even under exact (early-return before the mode branch).
  assert.equal(modelAllowed("x", [], "exact"), true);
});

// -- task 2: inert by default ------------------------------------------------

test("AC-1: inert by default — no allowlist configured → self:extend call passes", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(probeTool());

  const out = await applyHook(h, "probe_extend");
  assert.equal(out.block, false);
});

// -- task 3: allowed model passes --------------------------------------------

test("AC-2: allowed model passes — allowlist matches agent.model", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(probeTool());
  h.config.set("selfExtendFloor.models", "mock");

  const out = await applyHook(h, "probe_extend");
  assert.equal(out.block, false);
});

// -- task 4: below-floor blocked ---------------------------------------------

test("AC-3: below-floor model blocked, reason names model and floor", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(probeTool());
  h.config.set("selfExtendFloor.models", "opus,sonnet");

  const out = await applyHook(h, "probe_extend");
  assert.equal(out.block, true);
  assert.match(out.reason ?? "", /mock/);
  assert.match(out.reason ?? "", /opus, sonnet/);
});

// -- task 5: capability-scoped -----------------------------------------------

test("AC-4: capability-scoped — a control tool (no self:extend) passes under a blocking allowlist", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(plainTool());
  h.config.set("selfExtendFloor.models", "opus,sonnet");

  const out = await applyHook(h, "plain");
  assert.equal(out.block, false);
});

// -- task 6: kill switch -----------------------------------------------------

test("AC-5: kill switch EAGENT_SELF_EXTEND_FLOOR=off fully inactivates the guard", async () => {
  const saved = process.env.EAGENT_SELF_EXTEND_FLOOR;
  process.env.EAGENT_SELF_EXTEND_FLOOR = "off";
  try {
    const h = makeHarness();
    await h.host.use("self-extend-floor", selfExtendFloor);
    h.agent.tools.register(probeTool());
    h.config.set("selfExtendFloor.models", "opus,sonnet");

    const out = await applyHook(h, "probe_extend");
    assert.equal(out.block, false);
  } finally {
    if (saved === undefined) delete process.env.EAGENT_SELF_EXTEND_FLOOR;
    else process.env.EAGENT_SELF_EXTEND_FLOOR = saved;
  }
});

// -- task 7: unknown tool tolerated ------------------------------------------

test("AC-7: unknown tool tolerated — no spec → capsOf [] → passes, no throw", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.config.set("selfExtendFloor.models", "opus,sonnet");

  const out = await applyHook(h, "no_such_tool");
  assert.equal(out.block, false);
});

// -- task 8: registration + observability ------------------------------------

test("AC-8a: registration adds exactly one beforeToolCall listener", async () => {
  const h = makeHarness();
  const before = h.agent.hooks.listenerCount("beforeToolCall");
  await h.host.use("self-extend-floor", selfExtendFloor);
  assert.equal(h.agent.hooks.listenerCount("beforeToolCall"), before + 1);
});

test("AC-8b: a block emits a warn naming the tool and the acting model", async () => {
  const warned: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => warned.push(a.join(" ")),
    error: () => {},
  };
  const h = makeHarness({ logger });
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(probeTool());
  h.config.set("selfExtendFloor.models", "opus,sonnet");

  const out = await applyHook(h, "probe_extend");
  assert.equal(out.block, true);
  assert.ok(warned.some((line) => /probe_extend/.test(line) && /mock/.test(line)),
    "block emitted a warn containing the tool name and the acting model");
});

// -- D3: end-to-end case-insensitivity through the real config path ----------

test("D3 AC-1: an uppercase allowlist matches the acting model case-insensitively", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(probeTool());
  h.config.set("selfExtendFloor.models", "MOCK"); // uppercase config

  const out = await applyHook(h, "probe_extend");
  assert.equal(out.block, false); // "mock" matches "MOCK" through the whole path
});

// -- D4: opt-in exact-mode integration ---------------------------------------

test("D4 AC-2/3: match=exact flips a substring-admitted call to blocked; exact id passes", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(probeTool());

  // Substring (default): "mock".includes("moc") → passes.
  h.config.set("selfExtendFloor.models", "moc");
  assert.equal((await applyHook(h, "probe_extend")).block, false);

  // Same call, exact mode: "mock" !== "moc" → blocked.
  h.config.set("selfExtendFloor.match", "exact");
  assert.equal((await applyHook(h, "probe_extend")).block, true);

  // Exact id under exact mode → passes.
  h.config.set("selfExtendFloor.models", "mock");
  assert.equal((await applyHook(h, "probe_extend")).block, false);
});

// -- D4: unknown-mode falls back to substring; empty stays inert under exact --

test("D4 AC-5/7: unknown match value falls back to substring; empty allowlist inert under exact", async () => {
  const h = makeHarness();
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.agent.tools.register(probeTool());

  // Unknown mode → substring fallback: "mock".includes("mo") → passes.
  h.config.set("selfExtendFloor.models", "mo");
  h.config.set("selfExtendFloor.match", "weird");
  assert.equal((await applyHook(h, "probe_extend")).block, false);

  // Empty allowlist is inert even with match=exact (early-return before mode).
  h.config.set("selfExtendFloor.models", "");
  h.config.set("selfExtendFloor.match", "exact");
  assert.equal((await applyHook(h, "probe_extend")).block, false);
});

// -- D5: the guard keys on the ACTING (sub-agent's) model, not e.agent.model --

/** Tool messages so far in a request — drives a scripted child turn sequence. */
function toolMsgCount(req: CompletionRequest): number {
  return req.messages.filter((m) => m.role === "tool").length;
}

/**
 * A `self:extend` probe that counts its executions, plus the child that calls it
 * once (via a scripted MockProvider) under a distinct model. The probe is
 * registered on BOTH the root registry (the guard's capability lookup
 * `e.agent.tools.get` runs there) and the child registry (so the child can call
 * it). `run` returns the number of times the probe body actually executed —
 * 0 when the guard blocked, 1 when it passed.
 */
async function runChildProbe(root: Agent, childModel: string): Promise<{ ran: number; blocked: ToolResult[] }> {
  let ran = 0;
  const probe = defineTool({
    name: "probe_extend",
    description: "test probe",
    capabilities: ["self:extend"],
    parameters: { type: "object", properties: {} },
    execute: async () => {
      ran++;
      return ok("");
    },
  });
  root.tools.register(probe); // guard's cap lookup is on the ROOT registry

  const childTools = new ToolRegistry();
  childTools.register(probe);
  const providers = new ProviderRegistry();
  const script: MockResponder = (req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "probe_extend", arguments: {} }] } : { text: "done" });
  providers.register(new MockProvider(script), { default: true });

  const blocked: ToolResult[] = [];
  root.hooks.on("tool_end", ({ call, result }) => {
    if (call.name === "probe_extend" && result.isError) blocked.push(result);
  });

  const child = new Agent({
    providers,
    capabilities: root.capabilities,
    ui: root.ui,
    logger: root.logger,
    model: childModel,
    provider: "mock",
    systemPrompt: "CHILD",
    tools: childTools,
    hooks: root.hooks.childScope(),
  });
  await child.run("go");
  return { ran, blocked };
}

test("D5 AC-6: the floor blocks the child on the CHILD's model (root on-floor, child off-floor)", async () => {
  const h = makeHarness(); // root model "mock"
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.config.set("selfExtendFloor.models", "mock"); // root on-floor, child "weakmodel" off-floor

  const { ran, blocked } = await runChildProbe(h.agent, "weakmodel");
  assert.equal(ran, 0, "the child's self:extend body never ran — blocked on the child's model");
  assert.equal(blocked.length, 1, "exactly one blocked result reached tool_end");
  assert.match(blocked[0]?.content ?? "", /self-extend-floor/);
  assert.match(blocked[0]?.content ?? "", /weakmodel/); // keyed on the acting (child) model, not root "mock"
});

test("D5 AC-6: the floor passes the child when the CHILD's model is on-floor", async () => {
  const h = makeHarness(); // root model "mock"
  await h.host.use("self-extend-floor", selfExtendFloor);
  h.config.set("selfExtendFloor.models", "weakmodel"); // child on-floor, root "mock" off-floor

  const { ran, blocked } = await runChildProbe(h.agent, "weakmodel");
  assert.equal(ran, 1, "the child's self:extend call passed — the acting (child) model is on-floor");
  assert.equal(blocked.length, 0, "no block fired");
});
