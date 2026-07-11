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

test("usage shows a cache= field on a cached run, summing read+write tokens", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("trace", activate);

  // The MockProvider reports no cache fields, so synthesize a cached-run reading
  // straight through the bus (the trace handler mirrors `cumulative`).
  await h.agent.hooks.emit("usage", {
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 },
    cumulative: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 },
  });

  const out = (await runCommand(h, "usage")).join("\n");
  const line = out.split("\n").find((l) => l.startsWith("tokens:"));
  // cache = 100 + 20 = 120; total = 10 + 100 + 20 + 5 = 135.
  assert.equal(line, "tokens: in=10 cache=120 out=5 total=135");
});

test("usage line is byte-identical (no cache= field) when there are no cache tokens", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("trace", activate);

  await h.agent.hooks.emit("usage", {
    usage: { inputTokens: 10, outputTokens: 5 },
    cumulative: { inputTokens: 10, outputTokens: 5 },
  });

  const out = (await runCommand(h, "usage")).join("\n");
  const line = out.split("\n").find((l) => l.startsWith("tokens:"));
  assert.equal(line, "tokens: in=10 out=5 total=15");
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

test("concurrent same-name tool spans are matched by id, not mis-attributed", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("trace", activate);

  // Two overlapping calls to the SAME-named tool, ended in reverse order: `b`
  // errors, `a` succeeds. Name-based matching would close them swapped; id-based
  // matching attributes each end to its own start.
  const call = (id: string) => ({ type: "tool_call" as const, id, name: "bash", arguments: {} });
  await h.agent.hooks.emit("tool_start", { call: call("a") });
  await h.agent.hooks.emit("tool_start", { call: call("b") });
  await h.agent.hooks.emit("tool_end", { call: call("b"), result: { content: "", isError: true }, step: 0 });
  await h.agent.hooks.emit("tool_end", { call: call("a"), result: { content: "", isError: false }, step: 0 });

  const dir = mkdtempSync(join(tmpdir(), "eagent-trace-idmatch-"));
  const path = join(dir, "run.jsonl");
  await runCommand(h, "trace-save", path);
  const spans = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { kind?: string; ok?: boolean; meta?: { id?: string } });
  const byId = (id: string): { ok?: boolean } | undefined => spans.find((s) => s.kind === "tool" && s.meta?.id === id);
  assert.equal(byId("a")?.ok, true, "span a (ended ok) is closed as ok");
  assert.equal(byId("b")?.ok, false, "span b (ended error) is closed as error");
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

// ---------------------------------------------------------------------------
// AC-3 — a guard block is counted as `blocked`, NOT as a tool error. This is
// deliberately different from otel (which keeps a block additively in `error`);
// trace shows it distinctly.
// ---------------------------------------------------------------------------
test("a guard block counts as toolBlocked and leaves toolErrors at 0", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "echo" }] }, { text: "done" }],
  });
  registerTools(h.agent);
  // Veto the call; the dispatcher returns the canonical block result.
  h.agent.hooks.filter("beforeToolCall", (decision, { call }) =>
    call.name === "echo" ? { ...decision, block: true, reason: "flow-guard: nope" } : decision,
  );
  await h.host.use("trace", activate);

  await h.agent.run("go");

  const out = (await runCommand(h, "usage")).join("\n");
  assert.match(out, /toolBlocked=1/);
  // The block must NOT double-count into errors.
  assert.match(out, /toolErrors=0/);
});

test("a real tool error counts as toolErrors and leaves toolBlocked at 0", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "boom" }] }, { text: "done" }],
  });
  registerTools(h.agent);
  await h.host.use("trace", activate);

  await h.agent.run("go");

  const out = (await runCommand(h, "usage")).join("\n");
  assert.match(out, /toolErrors=1/);
  assert.match(out, /toolBlocked=0/);
});

test("the trace tree marks a blocked tool span as [blk], not [err]", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "echo" }] }, { text: "done" }],
  });
  registerTools(h.agent);
  h.agent.hooks.filter("beforeToolCall", (decision, { call }) =>
    call.name === "echo" ? { ...decision, block: true, reason: "flow-guard: nope" } : decision,
  );
  await h.host.use("trace", activate);

  await h.agent.run("go");

  const out = (await runCommand(h, "trace")).join("\n");
  assert.match(out, /tool echo \[blk\]/);
  assert.doesNotMatch(out, /tool echo \[err\]/);
});
