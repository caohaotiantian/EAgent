/**
 * Offline tests for the `limits` resource-guardrails extension.
 *
 * Everything runs against the deterministic MockProvider through the shared
 * harness, so there is no network and no API key. We script tool calls, then
 * assert on the resulting transcript and on counters tracked inside the test
 * tools themselves.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";

import { Agent } from "../src/kernel/agent.js";
import { defineTool, ok } from "../src/kernel/define.js";
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

/** Mirror of core-tools' confine: assert `p` resolves inside `root`. */
function isInside(root: string, p: string): boolean {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel));
}

/** Make a fresh workspace dir and point EAGENT_WORKSPACE at it. */
function withWorkspace(): { root: string; restore: () => void } {
  const prev = process.env.EAGENT_WORKSPACE;
  const root = mkdtempSync(join(tmpdir(), "eagent-spill-"));
  process.env.EAGENT_WORKSPACE = root;
  return {
    root,
    restore: () => {
      if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
      else process.env.EAGENT_WORKSPACE = prev;
      rmSync(root, { recursive: true, force: true });
    },
  };
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
  // Spill off here keeps this an in-context-truncation regression check.
  const limitsCmd = commands.get("limits")!;
  await runCommand(limitsCmd, agent, "maxToolOutputBytes=50 spillToolOutput=0");

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
  await runCommand(commands.get("limits")!, agent, "maxToolOutputBytes=40 spillToolOutput=0");
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

test("a fork's tool calls AGGREGATE onto the session's per-turn budget (root-keyed, not per-fork)", async () => {
  // The per-run tool-call budget is keyed on the SESSION ROOT and reset only on
  // the top-level agent_start (a fork's agent_start is suppressed by childScope),
  // so a fork's calls count against the same tree-wide budget. Keying per acting
  // agent would give each fork a fresh 0 and let a spawn fan-out evade the cap.
  let pingRuns = 0;
  const { agent, host, commands } = makeHarness({
    responder: (req) => {
      const last = req.messages[req.messages.length - 1];
      const lastResult =
        last?.role === "tool" ? last.content.find((b) => b.type === "tool_result") : undefined;
      const isChild = req.messages.some(
        (m) => m.role === "user" && m.content.some((b) => b.type === "text" && b.text.includes("child")),
      );
      if (isChild) {
        // The fork pings until it is blocked by the (shared, root-keyed) budget.
        if (lastResult && lastResult.type === "tool_result" && /budget/.test(lastResult.content)) {
          return { text: "child-done" };
        }
        return { toolCalls: [{ name: "ping" }] };
      }
      // The parent: ping, ping, spawn a fork, then finish.
      const toolMsgs = req.messages.filter((m) => m.role === "tool").length;
      if (toolMsgs < 2) return { toolCalls: [{ name: "ping" }] };
      if (toolMsgs === 2) return { toolCalls: [{ name: "spawn" }] };
      return { text: "parent-done" };
    },
    fallback: "allow",
  });
  agent.maxTurns = 12;

  agent.tools.register(
    defineTool({
      name: "ping",
      description: "counts one execution",
      execute: () => {
        pingRuns += 1;
        return ok("pong");
      },
    }),
  );
  agent.tools.register(
    defineTool({
      name: "spawn",
      description: "run a child agent within this session (a fork)",
      execute: async () => {
        // A fork: its own transcript, but it SHARES the session's hooks (via
        // childScope, so its agent_start is suppressed) — so child.run inherits the
        // session root and its tool calls land on the same per-turn budget.
        const child = new Agent({
          hooks: agent.hooks.childScope(),
          tools: agent.tools,
          providers: agent.providers,
          capabilities: agent.capabilities,
          ui: agent.ui,
          logger: agent.logger,
          model: "mock",
          provider: "mock",
          maxTurns: 8,
        });
        await child.run("child: ping until budget-blocked");
        return ok("spawned");
      },
    }),
  );

  await host.use("limits", activateLimits);
  // Budget of 4: parent runs ping, ping, spawn (calls 1,2,3); the fork then gets
  // exactly one ping (call 4) before the 5th is blocked — 3 successful pings total.
  await runCommand(commands.get("limits")!, agent, "maxToolCallsPerRun=4");

  await agent.run("parent go");

  // Root-keyed aggregation: parent(2) + fork(1) = 3 successful pings, the fork's
  // 2nd ping blocked by the tree-wide cap. A fresh per-fork counter would let the
  // fork ping up to its own cap of 4, yielding 6.
  assert.equal(pingRuns, 3, "the fork's calls aggregate onto the session's per-turn budget");
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
  assert.ok(out.some((l) => l.includes('"maxToolOutputBytes" must be a number')), "rejects non-positive value");
  assert.ok(out.some((l) => l.includes('unknown key "bogus"')), "rejects unknown key");
  assert.ok(out.some((l) => l.includes('"maxToolCallsPerRun" must be a number')), "rejects non-numeric value");
  assert.ok(out.some((l) => l.includes("(expected key=value)")), "rejects bare token");

  // Bad input left the config at defaults.
  assert.ok(out.some((l) => l === "maxToolOutputBytes=16384"), "config unchanged after bad input");
  assert.ok(out.some((l) => l === "maxToolCallsPerRun=100"), "config unchanged after bad input");
});

test("a token budget blocks further tool calls once exceeded", async () => {
  const { agent, host, commands } = makeHarness({
    responder: [{ toolCalls: [{ name: "probe" }] }, { text: "done" }],
    fallback: "allow",
  });
  await host.use("limits", activateLimits);

  let ran = 0;
  agent.tools.register(
    defineTool({ name: "probe", description: "", execute: () => ({ content: (++ran).toString() }) }),
  );

  // A 1-token budget is exhausted by the first turn's usage (the mock reports
  // hundreds of input tokens), so the turn's tool call is blocked.
  await runCommand(commands.get("limits")!, agent, "maxTokensPerRun=1");
  await agent.run("go");

  assert.equal(ran, 0, "the tool must not run once the token budget is exceeded");
  const results = toolResults(agent.messages);
  assert.match(results.at(-1)!.content, /token budget/i);
});

test("the token budget is disabled by default (0)", async () => {
  const { agent, host, commands } = makeHarness({
    responder: [{ toolCalls: [{ name: "probe" }] }, { text: "done" }],
    fallback: "allow",
  });
  await host.use("limits", activateLimits);
  let ran = 0;
  agent.tools.register(defineTool({ name: "probe", description: "", execute: () => ({ content: String(++ran) }) }));

  const out = await runCommand(commands.get("limits")!, agent, "");
  assert.ok(out.some((l) => l.startsWith("maxTokensPerRun=0")), "token budget defaults to disabled");
  await agent.run("go");
  assert.equal(ran, 1, "with the budget disabled the tool runs normally");
});

test("overflow spills the full output to a retrievable file inside the workspace", async () => {
  const ws = withWorkspace();
  try {
    const { agent, host, commands } = makeHarness({
      responder: (_req, i) => (i === 0 ? { toolCalls: [{ name: "big", id: "c0" }] } : { text: "done" }),
      fallback: "allow",
    });
    const big = "X".repeat(500);
    agent.tools.register(defineTool({ name: "big", description: "big", execute: () => ({ content: big }) }));

    await host.use("limits", activateLimits);
    await runCommand(commands.get("limits")!, agent, "maxToolOutputBytes=50");
    await agent.run("go");

    const r = toolResults(agent.messages).find((b) => b.toolCallId === "c0")!;

    // The marker now points at a saved file and the body still fits the cap.
    assert.match(r.content, /full output saved to /, "marker names a saved file");
    const preview = r.content.split("\n\n[output truncated:")[0]!;
    assert.ok(Buffer.byteLength(preview, "utf8") <= 50, "preview fits within the byte cap");

    // Pull the path out of the marker; it must resolve inside the workspace.
    const m = r.content.match(/full output saved to (.+?)\. Retrieve/);
    assert.ok(m, "marker embeds a path");
    const rel = m![1]!.trim();
    assert.ok(isInside(ws.root, rel), "spill path is inside the workspace root");

    const abs = isAbsolute(rel) ? rel : join(ws.root, rel);
    assert.ok(existsSync(abs), "spill file exists on disk");
    assert.equal(readFileSync(abs, "utf8"), big, "spill file holds the full original output");
  } finally {
    ws.restore();
  }
});

test("under-limit output is byte-identical and writes no spill file", async () => {
  const ws = withWorkspace();
  try {
    const { agent, host, commands } = makeHarness({
      responder: (_req, i) => (i === 0 ? { toolCalls: [{ name: "small", id: "c1" }] } : { text: "done" }),
      fallback: "allow",
    });
    const small = "tiny output";
    agent.tools.register(defineTool({ name: "small", description: "small", execute: () => ({ content: small }) }));

    await host.use("limits", activateLimits);
    await runCommand(commands.get("limits")!, agent, "maxToolOutputBytes=50");
    await agent.run("go");

    const r = toolResults(agent.messages).find((b) => b.toolCallId === "c1")!;
    assert.equal(r.content, small, "short output passes through verbatim");

    const spillDir = join(ws.root, ".eagent", "tool-output");
    assert.ok(!existsSync(spillDir), "no spill directory created for under-limit output");
  } finally {
    ws.restore();
  }
});

test("spillToolOutput=0 falls back to the in-context marker and writes no file", async () => {
  const ws = withWorkspace();
  try {
    const { agent, host, commands } = makeHarness({
      responder: (_req, i) => (i === 0 ? { toolCalls: [{ name: "big", id: "c0" }] } : { text: "done" }),
      fallback: "allow",
    });
    agent.tools.register(defineTool({ name: "big", description: "big", execute: () => ({ content: "X".repeat(500) }) }));

    await host.use("limits", activateLimits);
    await runCommand(commands.get("limits")!, agent, "maxToolOutputBytes=50 spillToolOutput=0");
    await agent.run("go");

    const r = toolResults(agent.messages).find((b) => b.toolCallId === "c0")!;
    assert.match(r.content, /output truncated: \d+ of \d+ bytes shown/);
    assert.ok(!r.content.includes("full output saved to"), "no spill hint when disabled");
    assert.ok(!existsSync(join(ws.root, ".eagent", "tool-output")), "no spill file written");
  } finally {
    ws.restore();
  }
});

test("EAGENT_TOOL_SPILL=off disables spill and writes no file", async () => {
  const ws = withWorkspace();
  const prev = process.env.EAGENT_TOOL_SPILL;
  process.env.EAGENT_TOOL_SPILL = "off";
  try {
    const { agent, host, commands } = makeHarness({
      responder: (_req, i) => (i === 0 ? { toolCalls: [{ name: "big", id: "c0" }] } : { text: "done" }),
      fallback: "allow",
    });
    agent.tools.register(defineTool({ name: "big", description: "big", execute: () => ({ content: "X".repeat(500) }) }));

    await host.use("limits", activateLimits);
    await runCommand(commands.get("limits")!, agent, "maxToolOutputBytes=50");
    await agent.run("go");

    const r = toolResults(agent.messages).find((b) => b.toolCallId === "c0")!;
    assert.match(r.content, /output truncated: \d+ of \d+ bytes shown/);
    assert.ok(!r.content.includes("full output saved to"), "kill switch disables the spill hint");
    assert.ok(!existsSync(join(ws.root, ".eagent", "tool-output")), "no spill file written");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_TOOL_SPILL;
    else process.env.EAGENT_TOOL_SPILL = prev;
    ws.restore();
  }
});

test("a spill-write failure falls back to in-context truncation without throwing", async () => {
  const ws = withWorkspace();
  try {
    const { agent, host, commands } = makeHarness({
      responder: (_req, i) => (i === 0 ? { toolCalls: [{ name: "big", id: "c0" }] } : { text: "done" }),
      fallback: "allow",
    });
    agent.tools.register(
      defineTool({ name: "big", description: "big", execute: () => ({ content: "X".repeat(500), isError: false }) }),
    );

    // Point toolOutputDir UNDER an existing regular file, so mkdirSync throws.
    const blocker = join(ws.root, "blocker");
    writeFileSync(blocker, "i am a file");
    const badDir = join(blocker, "tool-output");

    await host.use("limits", activateLimits);
    await runCommand(commands.get("limits")!, agent, `maxToolOutputBytes=50 toolOutputDir=${badDir}`);
    await agent.run("go");

    const r = toolResults(agent.messages).find((b) => b.toolCallId === "c0")!;
    assert.match(r.content, /output truncated: \d+ of \d+ bytes shown/);
    assert.ok(!r.content.includes("full output saved to"), "no spill hint when the write fails");
    assert.equal(r.isError, false, "isError unchanged by the fail-soft path");
    assert.ok(!existsSync(badDir), "no spill directory created on failure");
  } finally {
    ws.restore();
  }
});

test("spilling preserves isError, details, and terminate (only content changes)", async () => {
  const ws = withWorkspace();
  try {
    const { agent, host, commands } = makeHarness({ fallback: "allow" });
    await host.use("limits", activateLimits);
    await runCommand(commands.get("limits")!, agent, "maxToolOutputBytes=50");

    // Drive the afterToolCall filter directly so the full ToolResult (including
    // details/terminate, which the transcript block does not carry) is visible.
    const details = { code: 7, note: "kept" };
    const out = await agent.hooks.apply(
      "afterToolCall",
      { content: "X".repeat(500), isError: true, details, terminate: true },
      { call: { type: "tool_call", id: "c0", name: "big", arguments: {} } },
    );

    assert.match(out.content, /full output saved to /, "content was spilled");
    assert.equal(out.isError, true, "isError preserved through spill");
    assert.deepEqual(out.details, details, "details preserved through spill");
    assert.equal(out.terminate, true, "terminate preserved through spill");
  } finally {
    ws.restore();
  }
});

test("activation sweeps stale spill files and keeps fresh ones", async () => {
  const ws = withWorkspace();
  try {
    const dir = join(ws.root, ".eagent", "tool-output");
    mkdirSync(dir, { recursive: true });
    const stale1 = join(dir, "tool-old-1");
    const stale2 = join(dir, "tool-old-2");
    const fresh = join(dir, "tool-new-1");
    for (const f of [stale1, stale2, fresh]) writeFileSync(f, "spill");

    // Age the stale files to ~10 days old (older than the 7-day default).
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(stale1, tenDaysAgo, tenDaysAgo);
    utimesSync(stale2, tenDaysAgo, tenDaysAgo);

    const { host } = makeHarness({ fallback: "allow" });
    await host.use("limits", activateLimits);

    const remaining = readdirSync(dir);
    assert.ok(!existsSync(stale1), "stale file 1 deleted");
    assert.ok(!existsSync(stale2), "stale file 2 deleted");
    assert.ok(existsSync(fresh), "fresh file kept");
    assert.deepEqual(remaining, ["tool-new-1"], "only the fresh file remains");
  } finally {
    ws.restore();
  }
});

test("activation does not throw when the spill directory is absent", async () => {
  const ws = withWorkspace();
  try {
    assert.ok(!existsSync(join(ws.root, ".eagent", "tool-output")), "no spill dir yet");
    const { host } = makeHarness({ fallback: "allow" });
    await host.use("limits", activateLimits); // must not throw on a missing dir
  } finally {
    ws.restore();
  }
});

test("/limits prints and accepts the spill config keys", async () => {
  const { agent, host, commands } = makeHarness({ fallback: "allow" });
  await host.use("limits", activateLimits);
  const cmd = commands.get("limits")!;

  // Defaults are printed.
  const before = await runCommand(cmd, agent, "");
  assert.ok(before.some((l) => l === "spillToolOutput=true"), "spill defaults on");
  assert.ok(before.some((l) => l === "toolOutputRetentionDays=7"), "retention default printed");
  assert.ok(before.some((l) => l.startsWith("toolOutputDir=")), "spill dir printed");

  // Boolean, string, and numeric keys each update.
  const after = await runCommand(
    cmd,
    agent,
    "spillToolOutput=off toolOutputDir=/tmp/spill toolOutputRetentionDays=3",
  );
  assert.ok(after.some((l) => l === "spillToolOutput=false"), "boolean key updated");
  assert.ok(after.some((l) => l === "toolOutputDir=/tmp/spill"), "string key updated");
  assert.ok(after.some((l) => l === "toolOutputRetentionDays=3"), "numeric key updated");

  // Bad boolean and bad retention are rejected with a message, leaving prior values.
  const bad = await runCommand(cmd, agent, "spillToolOutput=maybe toolOutputRetentionDays=-1");
  assert.ok(bad.some((l) => l.includes('"spillToolOutput" must be a boolean')), "rejects bad boolean");
  assert.ok(bad.some((l) => l.includes('"toolOutputRetentionDays" must be a number')), "rejects bad number");
  assert.ok(bad.some((l) => l === "spillToolOutput=false"), "bad input left spill flag unchanged");
  assert.ok(bad.some((l) => l === "toolOutputRetentionDays=3"), "bad input left retention unchanged");
});

// -- W9.5a: the per-run token budget counts disjoint cache tokens -------------

test("the run token budget counts cache tokens (cache-inclusive total)", async () => {
  const { agent, host, commands } = makeHarness({ fallback: "allow" });
  await host.use("limits", activateLimits);

  // A usage with disjoint cache-read input and reasoning tokens. The cache-aware
  // total is input(10) + cacheRead(100) + output(5) = 115; reasoning(3) is a
  // subset of output and must NOT be added again.
  await agent.hooks.emit("usage", {
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, reasoningTokens: 3 },
    cumulative: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, reasoningTokens: 3 },
  });

  const out = await runCommand(commands.get("limits")!, agent, "");
  assert.ok(
    out.some((l) => l === "tokensThisRun=115"),
    "cache-read tokens are folded into the run budget (not just input+output)",
  );
});
