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

import selfExtendFloor, { modelAllowed, parseAllowlist } from "../src/extensions/self-extend-floor.js";
import { defineTool, ok } from "../src/kernel/define.js";
import type { Logger } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";

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
