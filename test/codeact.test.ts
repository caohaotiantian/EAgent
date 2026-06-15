/**
 * Tests for the CodeAct extension. We drive the real agent loop with a scripted
 * MockProvider that emits a `run_code` tool call, then inspect the resulting
 * `role:"tool"` message to assert on the captured output and `isError` flag.
 *
 * JavaScript (node) is used for the deterministic cases since it is always
 * present; python is exercised only when `python3` exists on the box.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import type { Agent } from "../src/kernel/agent.js";
import type { ToolResultBlock } from "../src/kernel/types.js";
import codeact from "../src/extensions/codeact.js";
import { makeHarness } from "./helpers.js";

/** Find the most recent tool_result block in the transcript. */
function lastToolResult(agent: Agent): ToolResultBlock {
  for (let i = agent.messages.length - 1; i >= 0; i--) {
    const m = agent.messages[i]!;
    if (m.role !== "tool") continue;
    const block = m.content[0];
    if (block && block.type === "tool_result") return block;
  }
  throw new Error("no tool_result found in transcript");
}

/** One tool-call turn followed by an empty turn so the loop terminates. */
function scriptRunCode(args: Record<string, unknown>) {
  return [
    { toolCalls: [{ name: "run_code", arguments: args, id: "call_1" }] },
    { text: "done" },
  ];
}

const pythonAvailable = (() => {
  try {
    return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

test("run_code executes a javascript snippet and returns its output", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({ language: "javascript", code: "console.log(2+3)", timeout: 5000 }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("compute 2+3");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /5/);
});

test("run_code is blocked when the code:exec capability is denied", async () => {
  const h = makeHarness({
    fallback: "deny",
    responder: scriptRunCode({ language: "javascript", code: "console.log('SHOULD_NOT_RUN')", timeout: 5000 }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("try to run code");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError, true);
  // The capability error message contains "denied"; the program never ran.
  assert.match(result.content, /denied/i);
  assert.doesNotMatch(result.content, /SHOULD_NOT_RUN/);
});

test("run_code reports a non-zero exit as an error result", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({
      language: "javascript",
      code: "console.error('boom'); process.exit(1)",
      timeout: 5000,
    }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("run failing code");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError, true);
  assert.match(result.content, /boom/);
});

test("run_code enforces the timeout and reports it", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({
      language: "javascript",
      code: "setTimeout(() => {}, 60000)",
      timeout: 200,
    }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("run a hang");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError, true);
  assert.match(result.content, /timeout/i);
});

test("python3 snippet runs when the interpreter is present", { skip: !pythonAvailable }, async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: scriptRunCode({ language: "python", code: "print(6*7)", timeout: 5000 }),
  });
  await h.host.use("codeact", codeact);

  await h.agent.run("compute 6*7");

  const result = lastToolResult(h.agent);
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /42/);
});

test("/code command runs a one-off snippet through the capability check", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("codeact", codeact);

  const cmd = h.commands.get("code");
  assert.ok(cmd, "code command registered");

  const lines: string[] = [];
  await cmd!.run({ agent: h.agent, args: "javascript console.log(7*8)", print: (l) => lines.push(l) });

  assert.match(lines.join("\n"), /56/);
});

test("/code command refuses when capability is denied", async () => {
  const h = makeHarness({ fallback: "deny" });
  await h.host.use("codeact", codeact);

  const cmd = h.commands.get("code");
  const lines: string[] = [];
  await cmd!.run({ agent: h.agent, args: "javascript console.log('NOPE')", print: (l) => lines.push(l) });

  const out = lines.join("\n");
  assert.match(out, /Denied/i);
  assert.doesNotMatch(out, /NOPE/);
});
