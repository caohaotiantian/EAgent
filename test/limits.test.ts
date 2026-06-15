/**
 * Offline tests for the `limits` resource-guardrails extension.
 *
 * Everything runs against the deterministic MockProvider through the shared
 * harness, so there is no network and no API key. We script tool calls, then
 * assert on the resulting transcript and on counters tracked inside the test
 * tools themselves.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { Command } from "../src/kernel/commands.js";
import type { Message, ToolResultBlock } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";
import activateLimits from "../src/extensions/limits.js";

/** Collect every `role:"tool"` result block from the transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

/** Run a command captured into a lines array; returns the printed lines. */
async function runCommand(
  cmd: Command,
  agent: ReturnType<typeof makeHarness>["agent"],
  args: string,
): Promise<string[]> {
  const lines: string[] = [];
  await cmd.run({ agent, args, print: (l) => lines.push(l) });
  return lines;
}

test("truncates oversized tool output and leaves short output untouched", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) =>
      i === 0
        ? { toolCalls: [{ name: "big", id: "c0" }] }
        : i === 1
          ? { toolCalls: [{ name: "small", id: "c1" }] }
          : { text: "done" },
    fallback: "allow",
  });

  const big = "X".repeat(500);
  const small = "tiny";
  agent.tools.register(defineTool({ name: "big", description: "big", execute: () => ({ content: big }) }));
  agent.tools.register(defineTool({ name: "small", description: "small", execute: () => ({ content: small }) }));

  await host.use("limits", activateLimits);

  // Seed a low byte cap BEFORE running, via the command (it writes e.store).
  const limitsCmd = commands.get("limits")!;
  await runCommand(limitsCmd, agent, "maxToolOutputBytes=50");

  await agent.run("go");

  const results = toolResults(agent.messages);
  const bigResult = results.find((r) => r.toolCallId === "c0")!;
  const smallResult = results.find((r) => r.toolCallId === "c1")!;

  // The big output is clipped to the byte budget and carries the marker.
  assert.ok(bigResult.content.includes("[output truncated:"), "expected truncation marker");
  assert.ok(bigResult.content.includes("of 500 bytes shown]"), "marker reports original byte count");
  assert.ok(
    Buffer.byteLength(bigResult.content.split("\n\n[output truncated:")[0]!, "utf8") <= 50,
    "shown body fits within the byte cap",
  );
  assert.ok(bigResult.content.length < big.length, "content actually shrank");

  // The short output is passed through verbatim.
  assert.equal(smallResult.content, small);
  assert.ok(!smallResult.content.includes("[output truncated"), "short output untouched");
});

test("preserves isError when truncating", async () => {
  const { agent, host, commands } = makeHarness({
    responder: (_req, i) => (i === 0 ? { toolCalls: [{ name: "boom", id: "e0" }] } : { text: "ok" }),
    fallback: "allow",
  });

  agent.tools.register(
    defineTool({
      name: "boom",
      description: "errors big",
      execute: () => ({ content: "E".repeat(300), isError: true }),
    }),
  );

  await host.use("limits", activateLimits);
  await runCommand(commands.get("limits")!, agent, "maxToolOutputBytes=40");
  await agent.run("go");

  const r = toolResults(agent.messages).find((b) => b.toolCallId === "e0")!;
  assert.equal(r.isError, true, "error flag survives truncation");
  assert.ok(r.content.includes("[output truncated:"));
});

test("enforces a per-run tool-call budget and stops invoking the tool body", async () => {
  // The model always wants to call the tool; with a budget of 2 the 3rd is
  // blocked. The loop keeps going (blocked calls return an error result), so the
  // tool body must run exactly twice and no more.
  const { agent, host, commands } = makeHarness({
    responder: () => ({ toolCalls: [{ name: "loop" }] }),
    fallback: "allow",
  });
  agent.maxTurns = 10; // give the budget room to bite before maxTurns

  let bodyRuns = 0;
  agent.tools.register(
    defineTool({
      name: "loop",
      description: "loops",
      execute: () => {
        bodyRuns += 1;
        return { content: "ok" };
      },
    }),
  );

  await host.use("limits", activateLimits);
  await runCommand(commands.get("limits")!, agent, "maxToolCallsPerRun=2");

  await agent.run("go");

  // The tool body ran exactly the budget; later calls were blocked pre-execute.
  assert.equal(bodyRuns, 2, "tool body ran exactly maxToolCallsPerRun times");

  const results = toolResults(agent.messages);
  const blocked = results.filter((r) => r.content.includes("budget"));
  assert.ok(blocked.length >= 1, "at least one call was blocked with a budget message");
  assert.ok(
    blocked.every((r) => r.isError),
    "blocked calls are reported as errors",
  );
});

test("budget counter resets between runs", async () => {
  // Call the tool on the first turn of EACH run (when the latest message is the
  // user's), then finish — the mock's turn index is global across runs, so we
  // key off the transcript instead.
  const { agent, host, commands } = makeHarness({
    responder: (req) => {
      const last = req.messages[req.messages.length - 1];
      const isUserTurn = last?.role === "user";
      return isUserTurn ? { toolCalls: [{ name: "t" }] } : { text: "done" };
    },
    fallback: "allow",
  });

  let bodyRuns = 0;
  agent.tools.register(
    defineTool({
      name: "t",
      description: "t",
      execute: () => {
        bodyRuns += 1;
        return { content: "ok" };
      },
    }),
  );

  await host.use("limits", activateLimits);
  await runCommand(commands.get("limits")!, agent, "maxToolCallsPerRun=1");

  await agent.run("first");
  await agent.run("second");

  // One call per run, both allowed because the counter resets on agent_start.
  assert.equal(bodyRuns, 2, "each run gets a fresh budget");
});

test("/limits prints config with no args and updates it with key=value args", async () => {
  const { agent, host, commands } = makeHarness({ fallback: "allow" });
  await host.use("limits", activateLimits);
  const cmd = commands.get("limits")!;

  // No args: prints defaults plus the live per-run counter.
  const before = await runCommand(cmd, agent, "");
  assert.ok(before.some((l) => l === "maxToolOutputBytes=16384"), "default output cap printed");
  assert.ok(before.some((l) => l === "maxToolCallsPerRun=100"), "default call budget printed");
  assert.ok(before.some((l) => l.startsWith("toolCallsThisRun=")), "run counter printed");

  // Update one key; the new value is reflected immediately.
  const after = await runCommand(cmd, agent, "maxToolOutputBytes=1024");
  assert.ok(after.some((l) => l === "maxToolOutputBytes=1024"), "updated cap printed");
  assert.ok(after.some((l) => l === "maxToolCallsPerRun=100"), "untouched key unchanged");

  // And it persists for the next invocation.
  const again = await runCommand(cmd, agent, "");
  assert.ok(again.some((l) => l === "maxToolOutputBytes=1024"), "update persisted");
});

test("/limits rejects bad values and unknown keys without throwing", async () => {
  const { agent, host, commands } = makeHarness({ fallback: "allow" });
  await host.use("limits", activateLimits);
  const cmd = commands.get("limits")!;

  const out = await runCommand(cmd, agent, "maxToolOutputBytes=-5 bogus=1 maxToolCallsPerRun=abc nope");
  assert.ok(out.some((l) => l.includes("must be a positive number")), "rejects non-positive value");
  assert.ok(out.some((l) => l.includes('unknown key "bogus"')), "rejects unknown key");
  assert.ok(out.some((l) => l.includes("must be a positive number")), "rejects non-numeric value");
  assert.ok(out.some((l) => l.includes("(expected key=value)")), "rejects bare token");

  // Bad input left the config at defaults.
  assert.ok(out.some((l) => l === "maxToolOutputBytes=16384"), "config unchanged after bad input");
  assert.ok(out.some((l) => l === "maxToolCallsPerRun=100"), "config unchanged after bad input");
});
