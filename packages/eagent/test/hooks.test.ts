import assert from "node:assert/strict";
import { test } from "node:test";

import type { KernelEvents, KernelFilters } from "../src/kernel/events.ts";
import { HookBus, setHandlerErrorReporter } from "../src/kernel/hooks.ts";
import type { Message, ToolCallBlock } from "../src/kernel/types.ts";
import { text, ZERO_USAGE } from "../src/kernel/types.ts";

type Events = { ping: { n: number } };
type Filters = { refine: { value: number; context: { base: number } } };

test("events fire in registration order and await handlers", async () => {
  const bus = new HookBus<Events, Filters>();
  const seen: number[] = [];
  bus.on("ping", async (p) => {
    await Promise.resolve();
    seen.push(p.n * 1);
  });
  bus.on("ping", (p) => {
    seen.push(p.n * 2);
  });
  await bus.emit("ping", { n: 10 });
  assert.deepEqual(seen, [10, 20]);
});

test("a throwing event handler does not abort the others", async () => {
  setHandlerErrorReporter(() => {});
  const bus = new HookBus<Events, Filters>();
  const seen: string[] = [];
  bus.on("ping", () => {
    throw new Error("boom");
  });
  bus.on("ping", () => {
    seen.push("survived");
  });
  await bus.emit("ping", { n: 1 });
  assert.deepEqual(seen, ["survived"]);
  setHandlerErrorReporter((event, err) => console.error(event, err));
});

test("filters thread the value through each handler", async () => {
  const bus = new HookBus<Events, Filters>();
  bus.filter("refine", (v, ctx) => v + ctx.base);
  bus.filter("refine", (v) => v * 2);
  const result = await bus.apply("refine", 1, { base: 4 });
  assert.equal(result, (1 + 4) * 2);
});

test("filters can short-circuit via shouldStop", async () => {
  const bus = new HookBus<Events, Filters>();
  let secondRan = false;
  bus.filter("refine", () => 99);
  bus.filter("refine", (v) => {
    secondRan = true;
    return v;
  });
  const result = await bus.apply("refine", 0, { base: 0 }, (v) => v === 99);
  assert.equal(result, 99);
  assert.equal(secondRan, false);
});

test("disposing a listener removes it", async () => {
  const bus = new HookBus<Events, Filters>();
  let count = 0;
  const d = bus.on("ping", () => {
    count++;
  });
  await bus.emit("ping", { n: 1 });
  d.dispose();
  await bus.emit("ping", { n: 1 });
  assert.equal(count, 1);
});

// --- childScope (governed sub-agents, KDD-1/KDD-2) --------------------------

test("childScope shares gate filters (beforeToolCall + afterToolCall)", async () => {
  const parent = new HookBus<KernelEvents, KernelFilters>();
  parent.filter("beforeToolCall", (decision) => ({
    ...decision,
    block: true,
    reason: "blocked-by-parent",
  }));
  parent.filter("afterToolCall", (result) => ({
    ...result,
    content: `${result.content} [annotated-by-parent]`,
  }));

  const child = parent.childScope();
  const call: ToolCallBlock = { type: "tool_call", id: "c1", name: "bash", arguments: {} };

  const decision = await child.apply("beforeToolCall", { block: false, arguments: {} }, { call });
  assert.equal(decision.block, true);
  assert.equal(decision.reason, "blocked-by-parent");

  const result = await child.apply("afterToolCall", { content: "raw" }, { call });
  assert.equal(result.content, "raw [annotated-by-parent]");
});

test("childScope does NOT share context filters (transformContext + transformRequest)", async () => {
  const parent = new HookBus<KernelEvents, KernelFilters>();
  parent.filter("transformContext", (msgs) => [...msgs, text("user", "INJECTED-CONTEXT")]);
  parent.filter("transformRequest", (req) => ({ ...req, systemPrompt: "INJECTED-SYSTEM" }));

  const child = parent.childScope();
  const msgs: Message[] = [text("user", "hi")];

  // The point is absent on the child, so apply() passes the value through unchanged.
  const outMsgs = await child.apply("transformContext", msgs, { turn: 1, model: "m" });
  assert.equal(outMsgs, msgs);
  assert.equal(outMsgs.length, 1);

  const req = { systemPrompt: "orig-system", messages: msgs, tools: [], model: "m" };
  const outReq = await child.apply("transformRequest", req, {
    turn: 1,
    cumulativeUsage: ZERO_USAGE,
  });
  assert.equal(outReq.systemPrompt, "orig-system");
});

test("childScope shares intra-run events but suppresses run-lifecycle events", async () => {
  const parent = new HookBus<KernelEvents, KernelFilters>();
  const fired: string[] = [];
  const allNames = [
    "session_start",
    "session_shutdown",
    "reload",
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message",
    "text_delta",
    "reasoning_delta",
    "tool_start",
    "tool_end",
    "tool_batch_end",
    "usage",
    "error",
  ] as const;
  for (const n of allNames) parent.on(n, () => void fired.push(n));

  const child = parent.childScope();
  const call: ToolCallBlock = { type: "tool_call", id: "c1", name: "t", arguments: {} };

  await child.emit("session_start", {});
  await child.emit("session_shutdown", {});
  await child.emit("reload", {});
  await child.emit("agent_start", { input: text("user", "x") });
  await child.emit("agent_end", { reason: "end_turn" });
  await child.emit("turn_start", { turn: 1 });
  await child.emit("turn_end", { turn: 1, step: 1 });
  await child.emit("message", { message: text("user", "x") });
  await child.emit("text_delta", { text: "x" });
  await child.emit("reasoning_delta", { text: "x" });
  await child.emit("tool_start", { call });
  await child.emit("tool_end", { call, result: { content: "" }, step: 1 });
  await child.emit("tool_batch_end", { batch: [], step: 1 });
  await child.emit("usage", { usage: ZERO_USAGE, cumulative: ZERO_USAGE });
  await child.emit("error", { error: new Error("x"), where: "test" });

  const suppressed = ["agent_start", "agent_end", "session_start", "session_shutdown", "reload"];
  const intraRun = [
    "turn_start",
    "turn_end",
    "message",
    "text_delta",
    "reasoning_delta",
    "tool_start",
    "tool_end",
    "tool_batch_end",
    "usage",
    "error",
  ];

  for (const n of suppressed) {
    assert.ok(!fired.includes(n), `${n} (run-lifecycle) must NOT fire on a child`);
  }
  for (const n of intraRun) {
    assert.ok(fired.includes(n), `${n} (intra-run) must propagate from a child to the parent`);
  }
});

test("childScope shares the gate-filter chain by reference; child bus is distinct", async () => {
  const parent = new HookBus<KernelEvents, KernelFilters>();
  // (a) a filter registered BEFORE childScope() is visible to the child.
  parent.filter("beforeToolCall", (d) => ({ ...d, reason: `${d.reason ?? ""}A` }));

  const child = parent.childScope();
  assert.notEqual(child, parent);
  assert.ok(child instanceof HookBus);

  // (b) the chain is shared by REFERENCE, not snapshot-copied: a filter the
  //     parent registers AFTER childScope() also runs for the child.
  parent.filter("beforeToolCall", (d) => ({ ...d, reason: `${d.reason ?? ""}B` }));

  const call: ToolCallBlock = { type: "tool_call", id: "c1", name: "t", arguments: {} };
  const decision = await child.apply("beforeToolCall", { block: false, arguments: {} }, { call });
  assert.equal(decision.reason, "AB");
});
