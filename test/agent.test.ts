import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { CompletionRequest } from "../src/kernel/types.js";
import { makeHarness, lastText } from "./helpers.js";

test("runs a full tool-use turn: call -> result -> final answer", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "add", arguments: { a: 2, b: 3 } }] },
      { text: "The sum is 5." },
    ],
  });
  agent.tools.register(
    defineTool({
      name: "add",
      description: "add",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      execute: (args) => ({ content: String(Number(args.a) + Number(args.b)) }),
    }),
  );

  const { reason } = await agent.run("add 2 and 3");
  assert.equal(reason, "end_turn");
  assert.equal(lastText(agent), "The sum is 5.");

  const toolMsg = agent.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.equal((toolMsg.content[0] as { content: string }).content, "5");
});

test("parallel tool results preserve requested order regardless of finish time", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "slow", id: "c1" }, { name: "fast", id: "c2" }] },
      { text: "done" },
    ],
  });
  agent.tools.register(
    defineTool({
      name: "slow",
      description: "",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { content: "slow-result" };
      },
    }),
  );
  agent.tools.register(
    defineTool({ name: "fast", description: "", execute: () => ({ content: "fast-result" }) }),
  );

  await agent.run("go");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  const order = toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId);
  assert.deepEqual(order, ["c1", "c2"], "results must follow the order the model requested");
});

test("beforeToolCall can veto a call", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "danger" }] }, { text: "ok" }],
  });
  let executed = false;
  agent.tools.register(
    defineTool({
      name: "danger",
      description: "",
      execute: () => {
        executed = true;
        return { content: "ran" };
      },
    }),
  );
  agent.hooks.filter("beforeToolCall", (decision, { call }) => {
    if (call.name === "danger") return { ...decision, block: true, reason: "not allowed" };
    return decision;
  });

  await agent.run("go");
  assert.equal(executed, false);
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.match((toolMsg.content[0] as { content: string }).content, /blocked/i);
});

test("beforeToolCall can rewrite arguments", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "echo", arguments: { msg: "raw" } }] }, { text: "ok" }],
  });
  let seen = "";
  agent.tools.register(
    defineTool({
      name: "echo",
      description: "",
      parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      execute: (args) => {
        seen = String(args.msg);
        return { content: seen };
      },
    }),
  );
  agent.hooks.filter("beforeToolCall", (d) => ({ ...d, arguments: { ...d.arguments, msg: "rewritten" } }));
  await agent.run("go");
  assert.equal(seen, "rewritten");
});

test("a tool returning terminate stops the loop without a follow-up call", async () => {
  let providerCalls = 0;
  const { agent } = makeHarness({
    responder: (_req: CompletionRequest) => {
      providerCalls++;
      return { toolCalls: [{ name: "halt" }] };
    },
  });
  agent.tools.register(
    defineTool({ name: "halt", description: "", execute: () => ({ content: "stopped", terminate: true }) }),
  );
  const { reason } = await agent.run("go");
  assert.equal(reason, "stop");
  assert.equal(providerCalls, 1, "loop should not call the provider again after a terminate");
});

test("transformContext can inject a message before the model call", async () => {
  let sawInjected = false;
  const { agent } = makeHarness({
    responder: (req: CompletionRequest) => {
      sawInjected = req.messages.some(
        (m) => m.role === "system" && m.content.some((b) => b.type === "text" && b.text.includes("INJECTED")),
      );
      return { text: "ok" };
    },
  });
  agent.hooks.filter("transformContext", (messages) => [
    { role: "system", content: [{ type: "text", text: "INJECTED" }] },
    ...messages,
  ]);
  await agent.run("hi");
  assert.ok(sawInjected, "the injected system message should reach the provider");
  assert.equal(agent.messages.some((m) => m.content.some((b) => b.type === "text" && b.text === "INJECTED")), false,
    "transformContext must not mutate the persistent transcript");
});

test("steering injects a message before the next turn", async () => {
  const { agent } = makeHarness({
    responder: (req: CompletionRequest, i: number) => {
      if (i === 0) {
        agent.steer({ role: "user", content: [{ type: "text", text: "STEER" }] });
        return { toolCalls: [{ name: "noop" }] };
      }
      const steered = req.messages.some((m) => m.content.some((b) => b.type === "text" && b.text === "STEER"));
      return { text: steered ? "saw-steer" : "no-steer" };
    },
  });
  agent.tools.register(defineTool({ name: "noop", description: "", execute: () => ({ content: "" }) }));
  await agent.run("go");
  assert.equal(lastText(agent), "saw-steer");
});

test("declared tool capabilities are enforced", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "secret" }] }, { text: "ok" }],
    fallback: "deny",
  });
  let executed = false;
  agent.tools.register(
    defineTool({
      name: "secret",
      description: "",
      capabilities: ["secret:use"],
      execute: () => {
        executed = true;
        return { content: "ran" };
      },
    }),
  );
  await agent.run("go");
  assert.equal(executed, false, "tool must not run when its capability is denied");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.match((toolMsg.content[0] as { content: string }).content, /denied/i);
});

test("unknown tools yield an error result, not a crash", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "ghost" }] }, { text: "recovered" }],
  });
  const { reason } = await agent.run("go");
  assert.equal(reason, "end_turn");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.match((toolMsg.content[0] as { content: string }).content, /unknown tool/i);
});
