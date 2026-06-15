import assert from "node:assert/strict";
import test from "node:test";

import type { CompletionRequest, Message, ToolResultBlock } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import subagents, { childRegistryFrom } from "../src/extensions/subagents.js";
import { defineTool } from "../src/kernel/define.js";
import { lastText, makeHarness } from "./helpers.js";

/** The last text block of the most recent user message in a request. */
function lastUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const block = m.content.find((b) => b.type === "text");
    if (block && block.type === "text") return block.text;
  }
  return "";
}

/** Collect every tool_result block from a transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

test("single mode: parent spawns one child and gets its answer", async () => {
  let parentSpawned = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      return { text: `child-answer:${lastUserText(req)}` };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "do X", system: "CHILD" } },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  const { reason } = await agent.run("kick off");

  const results = toolResults(agent.messages);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.isError, undefined);
  assert.match(results[0]!.content, /child-answer:do X/);
  assert.equal(lastText(agent), "parent-done");
  assert.equal(reason, "end_turn");
});

test("parallel mode: result mentions all three children", async () => {
  let parentSpawned = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      return { text: `did:${lastUserText(req)}` };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          {
            name: "spawn_agent",
            arguments: { mode: "parallel", prompts: ["a", "b", "c"], system: "CHILD" },
          },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined);
  assert.match(result.content, /did:a/);
  assert.match(result.content, /did:b/);
  assert.match(result.content, /did:c/);
});

test("chain mode: second child sees the first child's result", async () => {
  let parentSpawned = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      // Echo the incoming prompt so the chain prefix is observable.
      return { text: `echo<${lastUserText(req)}>` };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          {
            name: "spawn_agent",
            arguments: { mode: "chain", prompts: ["one", "two"], system: "CHILD" },
          },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined);
  // The final (returned) answer is the second child's echo, which must contain
  // the chain prefix carrying the first child's result.
  assert.match(result.content, /Previous result:/);
  assert.match(result.content, /echo<one>/); // first child's answer, fed forward
  assert.match(result.content, /Now: two/);
});

test("validation: wrong/missing prompt shape fails cleanly", async () => {
  let phase = 0;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) return { text: "unreachable" };
    phase++;
    if (phase === 1) {
      // single without prompt
      return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single" } }] };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true);
  assert.match(result.content, /requires a non-empty string `prompt`/);
});

test("recursion guard: child tool registry omits spawn_agent", () => {
  const spawn = defineTool({
    name: "spawn_agent",
    description: "x",
    execute: () => ({ content: "" }),
  });
  const helper = defineTool({
    name: "helper",
    description: "x",
    execute: () => ({ content: "" }),
  });

  const childTools = childRegistryFrom([spawn, helper]);

  assert.equal(childTools.has("spawn_agent"), false);
  assert.equal(childTools.has("helper"), true);
});

test("recursion guard (behavioral): spawned child cannot itself spawn", async () => {
  let parentSpawned = false;
  let childTriedSpawn = false;
  const provider = new MockProvider((req) => {
    if (req.systemPrompt.includes("CHILD")) {
      // The child attempts to spawn again; the tool is absent from its
      // registry, so this resolves to an "Unknown tool" error, not recursion.
      if (!childTriedSpawn) {
        childTriedSpawn = true;
        return {
          toolCalls: [
            { name: "spawn_agent", arguments: { mode: "single", prompt: "deeper", system: "CHILD" } },
          ],
        };
      }
      return { text: "child-done" };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          { name: "spawn_agent", arguments: { mode: "single", prompt: "do X", system: "CHILD" } },
        ],
      };
    }
    return { text: "parent-done" };
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("subagents", subagents);

  await agent.run("kick off");

  // Child's own spawn attempt produced an Unknown tool error, then it finished;
  // the parent's tool result is the child's final text "child-done".
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined);
  assert.match(result.content, /child-done/);
  assert.equal(lastText(agent), "parent-done");
});

test("/agents command prints mode help", async () => {
  const { commands, host } = makeHarness({ fallback: "allow" });
  await host.use("subagents", subagents);

  const cmd = commands.get("agents");
  assert.ok(cmd);
  const lines: string[] = [];
  await cmd!.run({ agent: {} as never, args: "", print: (l) => lines.push(l) });

  const joined = lines.join("\n");
  assert.match(joined, /single/);
  assert.match(joined, /parallel/);
  assert.match(joined, /chain/);
});
