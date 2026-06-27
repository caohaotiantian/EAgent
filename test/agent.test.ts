import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import { setHandlerErrorReporter } from "../src/kernel/hooks.js";
import type { CompletionRequest, ToolCallBlock, ToolResult, UI } from "../src/kernel/types.js";
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

test("a parallel wave settles into exactly one ordered tool_batch_end", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "slow", id: "c1" }, { name: "mid", id: "c2" }, { name: "fast", id: "c3" }] },
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
  agent.tools.register(defineTool({ name: "mid", description: "", execute: () => ({ content: "mid-result" }) }));
  agent.tools.register(defineTool({ name: "fast", description: "", execute: () => ({ content: "fast-result" }) }));

  const batches: { batch: { call: ToolCallBlock; result: ToolResult }[] }[] = [];
  let toolEndCount = 0;
  let turnEndCount = 0;
  // AC#1: destructure ({ batch }) with no cast; `batch` must be inferred as the
  // { call, result } pair array (enforced by typecheck, exercised here at runtime).
  agent.hooks.on("tool_batch_end", ({ batch }) => {
    batches.push({ batch });
  });
  agent.hooks.on("tool_end", () => {
    toolEndCount++;
  });
  agent.hooks.on("turn_end", () => {
    turnEndCount++;
  });

  await agent.run("go");

  // AC#2: exactly one wave-settled signal for the single dispatch group.
  assert.equal(batches.length, 1, "a single parallel wave emits exactly one tool_batch_end");
  // AC#3: the batch carries the ordered {call,result} pairs in requested order.
  assert.equal(batches[0]!.batch.length, 3);
  assert.deepEqual(
    batches[0]!.batch.map((p) => p.call.id),
    ["c1", "c2", "c3"],
    "batch pairs follow the order the model requested",
  );
  // The paired results are present and correctly matched to their calls.
  assert.deepEqual(
    batches[0]!.batch.map((p) => p.result.content),
    ["slow-result", "mid-result", "fast-result"],
  );
  // AC#4: per-tool tool_end is unchanged — still fires once per tool (3x).
  assert.equal(toolEndCount, 3, "tool_end still fires once per tool");
  // AC#5: turn_end is unchanged — one tool turn + one text turn = 2 for the run.
  assert.equal(turnEndCount, 2, "turn_end fires once per turn, unperturbed by the new event");
});

test("a single-tool wave still emits one length-1 tool_batch_end", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "solo", id: "s1" }] }, { text: "done" }],
  });
  agent.tools.register(defineTool({ name: "solo", description: "", execute: () => ({ content: "solo-result" }) }));

  const batches: { batch: { call: ToolCallBlock; result: ToolResult }[] }[] = [];
  agent.hooks.on("tool_batch_end", ({ batch }) => {
    batches.push({ batch });
  });

  await agent.run("go");

  // AC#6: a wave of one fires too — once per dispatch group, no length gate.
  assert.equal(batches.length, 1, "a single-tool wave still emits exactly one tool_batch_end");
  assert.equal(batches[0]!.batch.length, 1);
  assert.equal(batches[0]!.batch[0]!.call.id, "s1");
});

test("a throwing tool_batch_end consumer does not break the loop", async () => {
  setHandlerErrorReporter(() => {});
  try {
    const { agent } = makeHarness({
      responder: [{ toolCalls: [{ name: "noop", id: "n1" }] }, { text: "recovered" }],
    });
    agent.tools.register(defineTool({ name: "noop", description: "", execute: () => ({ content: "ok" }) }));
    // AC#7: an observe-only consumer that throws cannot break the agent loop.
    agent.hooks.on("tool_batch_end", () => {
      throw new Error("boom");
    });

    const { reason } = await agent.run("go");
    assert.equal(reason, "end_turn", "the run completes despite the throwing consumer");
    assert.equal(lastText(agent), "recovered");
  } finally {
    setHandlerErrorReporter((event, err) => console.error(event, err));
  }
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

test("guard repairs invalid args", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "needsNum", arguments: { n: "oops" } }] }, { text: "ok" }],
  });
  let seen: unknown;
  agent.tools.register(
    defineTool({
      name: "needsNum",
      description: "",
      parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      execute: (args) => {
        seen = args.n;
        return { content: "ran" };
      },
    }),
  );
  // The model emitted an invalid `n`; a guard rewrites it to a valid value. The
  // single re-validate gate must honor the repair rather than reject the original.
  agent.hooks.filter("beforeToolCall", (d) => ({ ...d, arguments: { ...d.arguments, n: 7 } }));

  await agent.run("go");
  assert.equal(seen, 7, "the tool must run with the guard-repaired value");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.equal((toolMsg.content[0] as { content: string }).content, "ran");
});

test("invalid args with no repairing guard still error before capability prompt", async () => {
  let prompted = false;
  const ui: UI = {
    confirm: async () => {
      prompted = true;
      return true;
    },
    notify: () => {},
  };
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "gated", arguments: { n: "oops" } }] }, { text: "ok" }],
    fallback: "ask",
    ui,
  });
  let executed = false;
  agent.tools.register(
    defineTool({
      name: "gated",
      description: "",
      capabilities: ["secret:use"],
      parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      execute: () => {
        executed = true;
        return { content: "ran" };
      },
    }),
  );

  await agent.run("go");
  assert.equal(executed, false, "an invalid-args call must not execute");
  assert.equal(prompted, false, "the capability UI must not be consulted for invalid args");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.match((toolMsg.content[0] as { content: string }).content, /Invalid arguments for gated/);
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

test("stop() halts the loop before the next turn", async () => {
  let providerCalls = 0;
  const { agent } = makeHarness({
    responder: (_req: CompletionRequest) => {
      providerCalls++;
      // Turn 1 asks for a tool (whose execution aborts); later turns would speak.
      return providerCalls === 1 ? { toolCalls: [{ name: "stopper" }] } : { text: "should-not-reach" };
    },
  });
  agent.tools.register(
    defineTool({
      name: "stopper",
      description: "",
      execute: () => {
        agent.stop();
        return { content: "stopping" };
      },
    }),
  );
  const { reason } = await agent.run("go");
  assert.equal(reason, "stop", "an aborted run should end with reason 'stop'");
  assert.equal(providerCalls, 1, "the loop must not call the provider again after stop()");
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

test("a provider error is surfaced as an error event and rethrown", async () => {
  const { agent } = makeHarness();
  agent.providers.register(
    {
      name: "mock",
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("provider exploded");
      },
    },
    { default: true },
  );
  let errored = false;
  agent.hooks.on("error", () => {
    errored = true;
  });
  await assert.rejects(() => agent.run("go"), /provider exploded/);
  assert.equal(errored, true, "an error event should fire");
  assert.equal(agent.running, false, "the agent must not be left in a running state");
});

test("a stream that ends without a done event is an error, not a hang", async () => {
  const { agent } = makeHarness();
  agent.providers.register(
    {
      name: "mock",
      async *stream() {
        yield { type: "text_delta", text: "partial" } as const;
        // never yields a "done" event
      },
    },
    { default: true },
  );
  await assert.rejects(() => agent.run("go"), /without a "done"/);
  assert.equal(agent.running, false);
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

test("forwards the thinking level and surfaces reasoning deltas as a hook event", async () => {
  const { agent, provider } = makeHarness({ responder: [{ reasoning: "thinking hard", text: "done" }] });
  agent.thinking = "high";
  const reasoning: string[] = [];
  agent.hooks.on("reasoning_delta", ({ text }) => reasoning.push(text));

  await agent.run("go");

  assert.equal(provider.lastThinking, "high", "the level reaches the provider request");
  assert.equal(reasoning.join(""), "thinking hard");
  // The signed thinking block is retained on the assistant message.
  const assistant = agent.messages.find((m) => m.role === "assistant")!;
  assert.equal(assistant.content[0]?.type, "thinking");
});
