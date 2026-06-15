/**
 * Tests for the `trace` observability extension. They drive the agent with the
 * deterministic MockProvider and assert that the trace, metrics, and JSONL
 * export are folded purely out of lifecycle events — no core changes needed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import activate from "../src/extensions/trace.js";
import { defineTool } from "../src/kernel/define.js";
import { makeHarness } from "./helpers.js";

/** Register the two scripted tools used by several tests. */
function registerTools(agent: import("../src/kernel/agent.js").Agent): void {
  agent.tools.register(
    defineTool({
      name: "echo",
      description: "returns ok",
      execute: () => ({ content: "ok" }),
    }),
  );
  agent.tools.register(
    defineTool({
      name: "boom",
      description: "returns an error",
      execute: () => ({ content: "boom", isError: true }),
    }),
  );
}

/** Run a command and capture its printed lines. */
async function runCommand(
  h: ReturnType<typeof makeHarness>,
  name: string,
  args = "",
): Promise<string[]> {
  const out: string[] = [];
  const cmd = h.commands.get(name);
  assert.ok(cmd, `command ${name} should be registered`);
  await cmd.run({ agent: h.agent, args, print: (l) => out.push(l) });
  return out;
}

test("trace shows agent, turn, and tool spans with durations", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "echo" }] }, { text: "done" }],
  });
  registerTools(h.agent);
  await h.host.use("trace", activate);

  await h.agent.run("hello");

  const out = (await runCommand(h, "trace")).join("\n");
  assert.match(out, /^agent.*\(\d+(\.\d+)?ms\)/m);
  assert.match(out, /turn 1.*\(\d+(\.\d+)?ms\)/);
  assert.match(out, /tool echo \[ok\].*\(\d+(\.\d+)?ms\)/);
});

test("metrics report turn, tool-call, and error counts with per-tool breakdown", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "echo" }, { name: "boom" }] }, { text: "fin" }],
  });
  registerTools(h.agent);
  await h.host.use("trace", activate);

  await h.agent.run("go");

  const out = (await runCommand(h, "usage")).join("\n");
  // Two turns: one tool turn + one final text turn.
  assert.match(out, /turns=2/);
  assert.match(out, /toolCalls=2/);
  assert.match(out, /toolErrors=1/);
  assert.match(out, /echo=1/);
  assert.match(out, /boom=1/);
});

test("usage shows non-zero input/output token counts", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ text: "a non-empty answer" }] });
  registerTools(h.agent);
  await h.host.use("trace", activate);

  await h.agent.run("count my tokens please");

  const out = (await runCommand(h, "usage")).join("\n");
  const m = out.match(/tokens: in=(\d+) out=(\d+) total=(\d+)/);
  assert.ok(m, `usage line should be present, got:\n${out}`);
  assert.ok(Number(m![1]) > 0, "input tokens should be > 0");
  assert.ok(Number(m![2]) > 0, "output tokens should be > 0");
  assert.equal(Number(m![3]), Number(m![1]) + Number(m![2]));
});

test("trace-save writes valid JSONL of spans", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "echo" }] }, { text: "saved" }],
  });
  registerTools(h.agent);
  await h.host.use("trace", activate);

  await h.agent.run("save me");

  const dir = mkdtempSync(join(tmpdir(), "eagent-trace-test-"));
  const path = join(dir, "run.jsonl");
  const out = (await runCommand(h, "trace-save", path)).join("\n");
  assert.match(out, new RegExp(`wrote \\d+ span\\(s\\) to ${path.replace(/[.\\/]/g, "\\$&")}`));

  const body = readFileSync(path, "utf8");
  const lines = body.split("\n").filter((l) => l.length > 0);
  assert.ok(lines.length >= 3, "should have agent + turn + tool spans");
  for (const line of lines) {
    const span = JSON.parse(line) as { kind?: string };
    assert.ok(
      span.kind === "agent" || span.kind === "turn" || span.kind === "tool",
      `each line should be a span with a kind, got: ${line}`,
    );
  }
});

test("a tool-less run does not throw and trace still prints sensibly", async () => {
  const h = makeHarness({ fallback: "allow", responder: [{ text: "just text, no tools" }] });
  registerTools(h.agent);
  await h.host.use("trace", activate);

  await h.agent.run("hi");

  const out = (await runCommand(h, "trace")).join("\n");
  assert.match(out, /^agent/m);
  assert.match(out, /turn 1/);
  // No tool was called, so no tool span should appear.
  assert.doesNotMatch(out, /tool /);
});

test("trace before any run reports no recording without throwing", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("trace", activate);

  const out = (await runCommand(h, "trace")).join("\n");
  assert.match(out, /no run recorded/);
});
