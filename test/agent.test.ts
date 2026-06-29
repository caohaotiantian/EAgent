import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent } from "../src/kernel/agent.js";
import { defineTool } from "../src/kernel/define.js";
import { setHandlerErrorReporter } from "../src/kernel/hooks.js";
import type { CompletionRequest, Message, StopReason, ToolCallBlock, ToolResult, UI, Usage } from "../src/kernel/types.js";
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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("maxConcurrency=1 serializes a parallel wave and preserves requested order", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "work0", id: "c0" }, { name: "work1", id: "c1" }, { name: "work2", id: "c2" }] },
      { text: "done" },
    ],
  });

  let inFlight = 0;
  let maxInFlight = 0;
  const started = [deferred(), deferred(), deferred()];
  const release = [deferred(), deferred(), deferred()];
  for (let i = 0; i < 3; i++) {
    agent.tools.register(
      defineTool({
        name: `work${i}`,
        description: "",
        executionMode: "parallel",
        execute: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          started[i]!.resolve();
          await release[i]!.promise;
          inFlight--;
          return { content: `r${i}` };
        },
      }),
    );
  }

  agent.maxConcurrency = 1;

  const runP = agent.run("go");
  // With a cap of 1, only one tool can be in-flight; releasing it lets the next
  // worker pick up the following call. Driving one-at-a-time would deadlock if
  // the cap were not honored (the unreleased waves would all be in-flight).
  for (let i = 0; i < 3; i++) {
    await started[i]!.promise;
    release[i]!.resolve();
  }
  await runP;

  assert.equal(maxInFlight, 1, "a cap of 1 must serialize the wave");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId),
    ["c0", "c1", "c2"],
    "results must follow the order the model requested",
  );
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { content: string }).content),
    ["r0", "r1", "r2"],
  );
});

test("maxConcurrency unset runs a parallel wave fully concurrently (fast-path == Promise.all)", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "work0", id: "c0" }, { name: "work1", id: "c1" }, { name: "work2", id: "c2" }] },
      { text: "done" },
    ],
  });

  let inFlight = 0;
  let maxInFlight = 0;
  const started = [deferred(), deferred(), deferred()];
  const release = [deferred(), deferred(), deferred()];
  for (let i = 0; i < 3; i++) {
    agent.tools.register(
      defineTool({
        name: `work${i}`,
        description: "",
        executionMode: "parallel",
        execute: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          started[i]!.resolve();
          await release[i]!.promise;
          inFlight--;
          return { content: `r${i}` };
        },
      }),
    );
  }

  const runP = agent.run("go");
  // Default (unset) maxConcurrency is Infinity ⇒ the Promise.all fast-path, so
  // all three reach in-flight before any is released.
  await Promise.all(started.map((d) => d.promise));
  assert.equal(maxInFlight, 3, "an unset cap must run the whole wave in parallel");
  for (const d of release) d.resolve();
  await runP;

  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId),
    ["c0", "c1", "c2"],
  );
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

test("transformRequest: default byte-identity when no handler is registered", async () => {
  let captured: CompletionRequest | undefined;
  const { agent } = makeHarness({
    responder: (req) => {
      captured = req;
      return { text: "ok" };
    },
  });
  agent.tools.register(defineTool({ name: "noop", description: "no op", execute: () => ({ content: "" }) }));

  await agent.run("hi");

  assert.ok(captured, "the provider should have received a request");
  assert.equal(captured!.systemPrompt, agent.systemPrompt);
  assert.equal(captured!.model, agent.model);
  assert.deepEqual(
    captured!.tools.map((t) => t.name),
    agent.tools.list().map((t) => t.spec.name),
  );
  assert.equal(captured!.toolChoice, undefined);
  assert.equal(captured!.thinking, agent.thinking);
  assert.deepEqual(captured!.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("transformRequest: shapes every field of the outbound request", async () => {
  let captured: CompletionRequest | undefined;
  const { agent } = makeHarness({
    responder: (req) => {
      captured = req;
      return { text: "ok" };
    },
  });
  agent.tools.register(defineTool({ name: "keep", description: "kept", execute: () => ({ content: "" }) }));
  agent.tools.register(defineTool({ name: "drop", description: "dropped", execute: () => ({ content: "" }) }));

  agent.hooks.filter("transformRequest", (value) => ({
    ...value,
    model: "shaped-model",
    systemPrompt: `${value.systemPrompt} [shaped]`,
    tools: value.tools.filter((t) => t.name !== "drop"),
    toolChoice: { type: "tool", name: "keep" },
    thinking: "high",
    messages: [...value.messages, { role: "user", content: [{ type: "text", text: "EXTRA" }] }],
  }));

  await agent.run("hi");

  assert.ok(captured, "the provider should have received a request");
  assert.equal(captured!.model, "shaped-model");
  assert.ok(captured!.systemPrompt.endsWith(" [shaped]"), "appended systemPrompt should reach the provider");
  assert.deepEqual(captured!.tools.map((t) => t.name), ["keep"], "the dropped tool must be withheld from the model");
  assert.deepEqual(captured!.toolChoice, { type: "tool", name: "keep" });
  assert.equal(captured!.thinking, "high");
  assert.ok(
    captured!.messages.some((m) => m.content.some((b) => b.type === "text" && b.text === "EXTRA")),
    "the appended message should reach the provider",
  );
});

test("transformContext before transformRequest: context output flows into request messages", async () => {
  let observed: Message[] | undefined;
  const { agent } = makeHarness({ responder: () => ({ text: "ok" }) });

  agent.hooks.filter("transformContext", (messages) => [
    ...messages,
    { role: "user", content: [{ type: "text", text: "M1" }] },
  ]);
  agent.hooks.filter("transformRequest", (value) => {
    observed = value.messages;
    return value;
  });

  await agent.run("hi");

  assert.ok(observed, "transformRequest should have run");
  assert.ok(
    observed!.some((m) => m.content.some((b) => b.type === "text" && b.text === "M1")),
    "transformRequest must observe the message transformContext appended (context runs first)",
  );
});

test("transformRequest: sees a non-zero cumulativeUsage matching the accumulated usage", async () => {
  let recorded: Usage | undefined;
  let cumulativeAfterTurn1: Usage | undefined;
  let usageEmits = 0;
  const { agent } = makeHarness({
    responder: (_req, i) => (i === 0 ? { toolCalls: [{ name: "noop" }] } : { text: "done" }),
  });
  agent.tools.register(defineTool({ name: "noop", description: "", execute: () => ({ content: "" }) }));

  agent.hooks.on("usage", ({ cumulative }) => {
    if (++usageEmits === 1) cumulativeAfterTurn1 = cumulative;
  });
  agent.hooks.filter("transformRequest", (value, ctx) => {
    if (ctx.turn === 2) recorded = ctx.cumulativeUsage;
    return value;
  });

  await agent.run("go");

  assert.ok(recorded, "transformRequest should have recorded cumulativeUsage on turn 2");
  assert.ok(recorded!.inputTokens > 0 || recorded!.outputTokens > 0, "cumulativeUsage should be non-zero");
  assert.deepEqual(recorded, cumulativeAfterTurn1, "turn-2 cumulativeUsage equals usage accumulated after turn 1");
});

test("snapshot() is a deep copy: mutating the returned state leaves the agent unchanged", async () => {
  const { agent } = makeHarness({ responder: [{ text: "hi" }] });
  await agent.run("hello");

  const beforeLen = agent.messages.length;
  const beforeInput = agent.usage.inputTokens;
  const s = agent.snapshot();
  s.messages.push({ role: "user", content: [{ type: "text", text: "injected" }] });
  s.usage.inputTokens = 9999;

  assert.equal(agent.messages.length, beforeLen, "mutating snapshot.messages must not affect the agent");
  assert.equal(agent.usage.inputTokens, beforeInput, "mutating snapshot.usage must not affect the agent");
});

test("restore() round-trips messages, usage, model, systemPrompt, thinking, and step", async () => {
  const { agent } = makeHarness({ responder: [{ text: "one" }, { text: "two" }] });
  agent.systemPrompt = "sysA";
  agent.thinking = "low";
  await agent.run("first");

  const s = agent.snapshot();
  agent.model = "x";
  agent.systemPrompt = "sysB";
  agent.thinking = "high";
  await agent.run("second");

  agent.restore(s);

  assert.deepEqual(agent.messages, s.messages, "messages restored");
  assert.deepEqual(agent.usage, s.usage, "usage restored");
  assert.equal(agent.model, s.model, "model restored");
  assert.equal(agent.systemPrompt, s.systemPrompt, "systemPrompt restored");
  assert.equal(agent.thinking, s.thinking, "thinking restored");
  assert.equal(agent.snapshot().step, s.step, "step restored");
});

test("restore() throws when called while the agent is running", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "noop" }] }, { text: "done" }],
  });
  agent.tools.register(defineTool({ name: "noop", description: "", execute: () => ({ content: "" }) }));
  const snap = agent.snapshot();

  // The tool handle (ctx.agent) has no restore(), so capture the test-created
  // Agent in a turn_start observer. An observer throw is swallowed, so catch it
  // here and hoist the assert out of the handler (a bare throw would be false-green).
  let threw = false;
  agent.hooks.on("turn_start", () => {
    try {
      agent.restore(snap);
    } catch {
      threw = true;
    }
  });

  await agent.run("go");
  assert.ok(threw, "restore() must throw while the agent is running");
});

test("handle.messages is a frozen, distinct copy that cannot be structurally mutated", async () => {
  let frozen = false;
  let distinct = false;
  let pushThrew = false;
  let lenUnchanged = false;
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "probe" }] }, { text: "done" }],
  });
  agent.tools.register(
    defineTool({
      name: "probe",
      description: "",
      execute: (_args, ctx) => {
        const it = ctx.agent.messages;
        frozen = Object.isFrozen(it);
        distinct = it !== agent.messages;
        const lenBefore = agent.messages.length;
        try {
          (it as Message[]).push({ role: "user", content: [{ type: "text", text: "x" }] });
        } catch {
          pushThrew = true;
        }
        lenUnchanged = agent.messages.length === lenBefore;
        return { content: "" };
      },
    }),
  );

  await agent.run("go");
  assert.ok(frozen, "handle.messages must be frozen");
  assert.ok(distinct, "handle.messages must be a distinct array from the internal transcript");
  assert.ok(pushThrew, "pushing to the frozen handle copy must throw in strict mode");
  assert.ok(lenUnchanged, "the agent's transcript length must be unaffected");
});

test("#step starts at 0, increments once per turn, and is stamped on turn_end/tool_end", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "noop" }] }, { text: "done" }],
  });
  agent.tools.register(defineTool({ name: "noop", description: "", execute: () => ({ content: "" }) }));

  assert.equal(agent.snapshot().step, 0, "a fresh agent has step 0");

  const turnEndSteps: number[] = [];
  const toolEndSteps: number[] = [];
  agent.hooks.on("turn_end", ({ step }) => {
    turnEndSteps.push(step);
  });
  agent.hooks.on("tool_end", ({ step }) => {
    toolEndSteps.push(step);
  });

  await agent.run("go");

  assert.deepEqual(turnEndSteps, [1, 2], "turn_end carries the post-increment step, +1 per turn");
  assert.deepEqual(toolEndSteps, [0], "tool_end (mid turn 1) carries the call-time (pre-increment) step");
  assert.equal(agent.snapshot().step, 2, "after a 2-turn run, step is 2");

  agent.clear();
  assert.equal(agent.snapshot().step, 0, "clear() resets step to 0");
});

// --- onProviderError seam (Phase 2) ---------------------------------------

test("onProviderError default (no handler): a pre-commit throw ends with reason:error and rethrows", async () => {
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
  let endReason: StopReason | undefined;
  agent.hooks.on("agent_end", ({ reason }) => {
    endReason = reason;
  });
  await assert.rejects(() => agent.run("go"), /provider exploded/);
  assert.equal(endReason, "error", "with no handler the seam is inert: reason is error, byte-identical to today");
});

test("onProviderError retry: a pre-commit throw then success completes the run", async () => {
  const { agent } = makeHarness();
  let attempts = 0;
  agent.providers.register(
    {
      name: "mock",
      async *stream() {
        attempts++;
        if (attempts === 1) throw new Error("transient pre-commit");
        yield {
          type: "done",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          stopReason: "end_turn",
        } as const;
      },
    },
    { default: true },
  );
  const seenAttempts: number[] = [];
  agent.hooks.filter("onProviderError", (_value, ctx) => {
    seenAttempts.push(ctx.attempt);
    return { retry: true, fail: false };
  });

  const { reason } = await agent.run("go");
  assert.equal(reason, "end_turn", "the run completes after the retry succeeds");
  assert.equal(attempts, 2, "the provider stream was re-invoked exactly once");
  assert.deepEqual(seenAttempts, [1], "the handler saw attempt=1 on the first (only) failure");
});

test("onProviderError downshift: the retried request carries the downshifted model", async () => {
  const { agent } = makeHarness();
  const reqModels: string[] = [];
  let attempts = 0;
  agent.providers.register(
    {
      name: "mock",
      async *stream(req) {
        reqModels.push(req.model);
        attempts++;
        if (attempts === 1) throw new Error("overloaded");
        yield {
          type: "done",
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          stopReason: "end_turn",
        } as const;
      },
    },
    { default: true },
  );
  const ctxModels: string[] = [];
  agent.hooks.filter("transformContext", (msgs, ctx) => {
    ctxModels.push(ctx.model);
    return msgs;
  });
  agent.hooks.filter("onProviderError", () => ({ retry: true, downshiftModel: "small", fail: false }));

  const { reason } = await agent.run("go");
  assert.equal(reason, "end_turn");
  assert.deepEqual(reqModels, ["mock", "small"], "the retried provider request used the downshifted model");
  assert.deepEqual(ctxModels, ["mock", "small"], "transformContext context.model reflected the downshift on retry");
});

test("onProviderError post-commit: an emitted-then-throwing stream is not retried (no double-emit)", async () => {
  const { agent } = makeHarness();
  let attempts = 0;
  agent.providers.register(
    {
      name: "mock",
      async *stream() {
        attempts++;
        yield { type: "text_delta", text: "hello" } as const;
        throw new Error("post-commit boom");
      },
    },
    { default: true },
  );
  let deltas = 0;
  agent.hooks.on("text_delta", () => {
    deltas++;
  });
  agent.hooks.filter("onProviderError", () => ({ retry: true, fail: false }));

  await assert.rejects(() => agent.run("go"), /post-commit boom/);
  assert.equal(attempts, 1, "a post-commit throw is never retried, even with a retry handler");
  assert.equal(deltas, 1, "exactly one text_delta reached observers (no double-emit)");
});

test("onProviderError hard bound: an always-retry handler terminates after MAX_PROVIDER_RETRIES", async () => {
  const { agent } = makeHarness();
  let attempts = 0;
  agent.providers.register(
    {
      name: "mock",
      // eslint-disable-next-line require-yield
      async *stream() {
        attempts++;
        throw new Error("always pre-commit");
      },
    },
    { default: true },
  );
  agent.hooks.filter("onProviderError", () => ({ retry: true, fail: false }));

  await assert.rejects(() => agent.run("go"), /always pre-commit/);
  assert.equal(attempts, 6, "the kernel hard bound (MAX_PROVIDER_RETRIES=6) stops a perpetual-retry handler");
});

// --- beforeDispatch wave seam (Phase 1) -----------------------------------

const SKIP_NOTE = /skipped by a beforeDispatch hook/;

function registerNamed(agent: Agent, names: string[], ran?: string[]): void {
  for (const name of names) {
    agent.tools.register(
      defineTool({
        name,
        description: "",
        execute: () => {
          ran?.push(name);
          return { content: `r-${name}` };
        },
      }),
    );
  }
}

test("beforeDispatch reorders execution but the transcript pairs by id in original order (AC-3)", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "t1", id: "c1" }, { name: "t2", id: "c2" }, { name: "t3", id: "c3" }] },
      { text: "done" },
    ],
  });
  registerNamed(agent, ["t1", "t2", "t3"]);
  const started: string[] = [];
  agent.hooks.on("tool_start", ({ call }) => {
    started.push(call.id);
  });

  agent.hooks.filter("beforeDispatch", (calls) => [...calls].reverse());

  await agent.run("go");

  assert.deepEqual(started, ["c3", "c2", "c1"], "execution order follows the reordered dispatch set");

  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId),
    ["c1", "c2", "c3"],
    "transcript tool_results are keyed 1:1 to original ids, in ORIGINAL order",
  );
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { content: string }).content),
    ["r-t1", "r-t2", "r-t3"],
    "each original id pairs with its own result content",
  );
});

test("beforeDispatch drops one call: it never runs but its id still pairs with a neutral skip result (AC-4)", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "t1", id: "c1" }, { name: "t2", id: "c2" }, { name: "t3", id: "c3" }] },
      { text: "done" },
    ],
  });
  const ran: string[] = [];
  registerNamed(agent, ["t1", "t2", "t3"], ran);
  const started: string[] = [];
  agent.hooks.on("tool_start", ({ call }) => {
    started.push(call.id);
  });

  agent.hooks.filter("beforeDispatch", (calls) => calls.filter((c) => c.id !== "c2"));

  await agent.run("go");

  assert.deepEqual(ran.sort(), ["t1", "t3"], "the dropped tool must not execute");
  assert.ok(!started.includes("c2"), "no tool_start fires for the dropped call");

  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId),
    ["c1", "c2", "c3"],
    "every original id still receives a tool_result, in original order",
  );
  const byId = (id: string) =>
    toolMsg.content.find((b) => (b as { toolCallId: string }).toolCallId === id) as {
      content: string;
      isError?: boolean;
    };
  assert.match(byId("c2").content, SKIP_NOTE, "the dropped id gets the neutral skip note");
  assert.ok(!byId("c2").isError, "a dropped call's synthetic result is neutral (isError falsy)");
  assert.equal(byId("c1").content, "r-t1", "the surviving calls pair to their real results");
  assert.equal(byId("c3").content, "r-t3");
});

test("beforeDispatch drop-all still emits an all-synthetic tool message and the loop continues (AC-5)", async () => {
  let providerCalls = 0;
  const { agent } = makeHarness({
    responder: (_req, i) => {
      providerCalls++;
      return i === 0
        ? { toolCalls: [{ name: "t1", id: "c1" }, { name: "t2", id: "c2" }, { name: "t3", id: "c3" }] }
        : { text: "after-drop" };
    },
  });
  const ran: string[] = [];
  registerNamed(agent, ["t1", "t2", "t3"], ran);

  agent.hooks.filter("beforeDispatch", () => []);

  const { reason } = await agent.run("go");

  // (a) nothing ran; (c) the loop continued to the next streamTurn, not the no-calls/end path.
  assert.deepEqual(ran, [], "no tool executes when the whole wave is dropped");
  assert.equal(reason, "end_turn", "the loop continued past the drop-all rather than taking the no-calls path");
  assert.equal(providerCalls, 2, "the model was called again after the drop-all (loop continued)");
  assert.equal(lastText(agent), "after-drop");

  // (b) a tool message with exactly one synthetic skip-result per original id.
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.equal(toolMsg.content.length, 3, "one tool_result per original id");
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId),
    ["c1", "c2", "c3"],
  );
  for (const b of toolMsg.content) {
    assert.match((b as { content: string }).content, SKIP_NOTE);
    assert.ok(!(b as { isError?: boolean }).isError, "synthetic skip results are neutral");
  }

  // (d) no orphan: every assistant tool_use id has a matching tool_result.
  const assistant = agent.messages.find((m) => m.role === "assistant")!;
  const useIds = assistant.content.filter((b): b is ToolCallBlock => b.type === "tool_call").map((b) => b.id);
  const resultIds = toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId);
  assert.deepEqual([...resultIds].sort(), [...useIds].sort(), "every tool_use id has a matching tool_result");
});

test("beforeDispatch: a terminate:true call surviving a partial drop still terminates the run (AC-5)", async () => {
  const { agent } = makeHarness({
    responder: (_req, i) =>
      i === 0
        ? { toolCalls: [{ name: "halt", id: "h1" }, { name: "noop", id: "n1" }] }
        : { text: "should-not-reach" },
  });
  agent.tools.register(defineTool({ name: "halt", description: "", execute: () => ({ content: "stopped", terminate: true }) }));
  agent.tools.register(defineTool({ name: "noop", description: "", execute: () => ({ content: "ok" }) }));
  // Drop the non-terminating call; keep halt. The executed set ([halt]) drives terminate.
  agent.hooks.filter("beforeDispatch", (calls) => calls.filter((c) => c.id === "h1"));

  const { reason } = await agent.run("go");
  assert.equal(reason, "stop", "the surviving terminate:true call still terminates (executed set drives terminate)");

  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId).sort(),
    ["h1", "n1"],
    "both original ids pair even though one was dropped",
  );
});

test("beforeDispatch: a fully-dropped wave does NOT terminate even if the dropped call was terminate:true (AC-5)", async () => {
  let providerCalls = 0;
  const { agent } = makeHarness({
    responder: (_req, i) => {
      providerCalls++;
      return i === 0 ? { toolCalls: [{ name: "halt", id: "h1" }] } : { text: "continued" };
    },
  });
  agent.tools.register(defineTool({ name: "halt", description: "", execute: () => ({ content: "stopped", terminate: true }) }));
  agent.hooks.filter("beforeDispatch", () => []);

  const { reason } = await agent.run("go");
  // Empty executed set: `[].every(...)` is vacuously true, so the length>0 guard
  // is what keeps a drop-all from spuriously terminating.
  assert.equal(reason, "end_turn", "an empty executed set must not be treated as all-terminate");
  assert.equal(providerCalls, 2, "the loop continued past the fully-dropped wave");
});

test("beforeDispatch: an injected call whose id is not among the originals is ignored (AC-6)", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "t1", id: "c1" }, { name: "t2", id: "c2" }] },
      { text: "done" },
    ],
  });
  const ran: string[] = [];
  registerNamed(agent, ["t1", "t2", "injected"], ran);

  agent.hooks.filter("beforeDispatch", (calls) => [
    ...calls,
    { type: "tool_call", id: "x99", name: "injected", arguments: {} },
  ]);

  await agent.run("go");

  assert.ok(!ran.includes("injected"), "an injected (unknown-id) call must not execute");
  assert.deepEqual(ran.sort(), ["t1", "t2"]);

  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId),
    ["c1", "c2"],
    "no extra/orphan tool_result appears for the injected id",
  );
});

test("beforeDispatch: default (no handler) dispatches in original order, 1:1, no synthetics (AC-7)", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "t1", id: "c1" }, { name: "t2", id: "c2" }, { name: "t3", id: "c3" }] },
      { text: "done" },
    ],
  });
  registerNamed(agent, ["t1", "t2", "t3"]);
  const started: string[] = [];
  agent.hooks.on("tool_start", ({ call }) => {
    started.push(call.id);
  });

  await agent.run("go");

  assert.deepEqual(started, ["c1", "c2", "c3"], "no handler -> original dispatch order");
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId), ["c1", "c2", "c3"]);
  assert.deepEqual(toolMsg.content.map((b) => (b as { content: string }).content), ["r-t1", "r-t2", "r-t3"]);
  for (const b of toolMsg.content) {
    assert.doesNotMatch((b as { content: string }).content, SKIP_NOTE, "no synthetic results with no handler");
  }
});

test("beforeDispatch divergence: tool_batch_end carries only executed results; transcript carries all original ids in original order (AC-9)", async () => {
  const { agent } = makeHarness({
    responder: [
      { toolCalls: [{ name: "t1", id: "c1" }, { name: "t2", id: "c2" }, { name: "t3", id: "c3" }] },
      { text: "done" },
    ],
  });
  registerNamed(agent, ["t1", "t2", "t3"]);
  // Drop c2 AND reverse the survivors: exercise both divergence and the
  // original-order transcript against a reordered dispatch.
  agent.hooks.filter("beforeDispatch", (calls) => calls.filter((c) => c.id !== "c2").reverse());

  let batch: { call: ToolCallBlock; result: ToolResult }[] | undefined;
  agent.hooks.on("tool_batch_end", ({ batch: b }) => {
    batch = b;
  });

  await agent.run("go");

  // tool_batch_end is "what ran": only c3, c1, in execution order; c2 absent.
  assert.deepEqual(batch!.map((p) => p.call.id), ["c3", "c1"], "tool_batch_end carries only executed results, in execution order");
  assert.ok(!batch!.some((p) => p.call.id === "c2"), "the dropped id is absent from tool_batch_end");

  // The transcript is "every original id paired", in ORIGINAL order.
  const toolMsg = agent.messages.find((m) => m.role === "tool")!;
  assert.deepEqual(
    toolMsg.content.map((b) => (b as { toolCallId: string }).toolCallId),
    ["c1", "c2", "c3"],
    "the transcript tool message carries every original id in original order regardless of reorder/drop",
  );
  assert.match(
    (toolMsg.content.find((b) => (b as { toolCallId: string }).toolCallId === "c2") as { content: string }).content,
    SKIP_NOTE,
    "the dropped id carries the synthetic skip note in the transcript",
  );
});
