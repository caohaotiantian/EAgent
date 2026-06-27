/**
 * Phase 2 integration tests — governed sub-agents (routing the four child
 * construction sites through `HookBus.childScope()`).
 *
 * These drive the REAL guards (`flow-guard`, `write-guard`) plus parent-bus
 * call/result filters and observers over a child spawned via the real
 * `spawn_agent` path, so they exercise the actual `subagents.ts` wiring (not the
 * `childScope` unit, which `test/hooks.test.ts` covers). Everything is offline
 * against `MockProvider`. (design §2 D2/D3/D4; AC-3/AC-4/AC-5/AC-6/AC-8.)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Agent } from "../src/kernel/agent.js";
import { defineTool, ok } from "../src/kernel/define.js";
import type { KernelEvents, KernelFilters } from "../src/kernel/events.js";
import { HookBus } from "../src/kernel/hooks.js";
import type { CompletionRequest, ToolResult, UI } from "../src/kernel/types.js";
import cost from "../src/extensions/cost.js";
import flowGuard from "../src/extensions/flow-guard.js";
import subagents, { childRegistryFrom } from "../src/extensions/subagents.js";
import writeGuard from "../src/extensions/write-guard.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness } from "./helpers.js";

/**
 * Register a function-responder MockProvider as the agent's default provider.
 * (makeHarness already registers a no-script mock; this overwrites the default
 * with the scripted one — register-by-overwrite, last default wins.)
 */
function scriptProvider(agent: Agent, fn: (req: CompletionRequest) => unknown): void {
  agent.providers.register(new MockProvider(fn as never), { default: true });
}

/** Tool messages so far in a request — drives a child's scripted turn sequence. */
function toolMsgCount(req: CompletionRequest): number {
  return req.messages.filter((m) => m.role === "tool").length;
}

/** A UI that records every confirm prompt and answers with `answer`. */
function recordingUI(answer: boolean): { ui: UI; confirms: string[] } {
  const confirms: string[] = [];
  return {
    ui: {
      confirm: async (q: string) => {
        confirms.push(q);
        return answer;
      },
      notify: () => {},
    },
    confirms,
  };
}

// ---------------------------------------------------------------------------
// AC-3 — flow-guard capability taint governs a child; a fresh-bus child does not
// ---------------------------------------------------------------------------

test("AC-3 flow-guard capability taint: a governed child's egress is blocked; an ungoverned (fresh-bus) child's is not", async () => {
  let egressRuns = 0;
  const { agent, host, commands } = makeHarness({ fallback: "allow" });

  // A shell:exec source and a net:fetch egress, both copied into the child
  // registry. fallback:"allow" so the capability layer never blocks the egress
  // first — the only thing that can block it is flow-guard (else the control
  // would be a false negative).
  agent.tools.register(
    defineTool({
      name: "source",
      description: "reads via shell (declares shell:exec)",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: {} },
      execute: () => ok("source-ran"),
    }),
  );
  agent.tools.register(
    defineTool({
      name: "egress",
      description: "sends over the network (declares net:fetch)",
      capabilities: ["net:fetch"],
      parameters: { type: "object", properties: {} },
      execute: () => {
        egressRuns++;
        return ok("egress-ran");
      },
    }),
  );

  // Capture every egress tool_end on the parent bus — shared with the child via
  // childScope, so a governed child's egress result surfaces here.
  const egressResults: ToolResult[] = [];
  agent.hooks.on("tool_end", ({ call, result }) => {
    if (call.name === "egress") egressResults.push(result);
  });

  await host.use("flow-guard", flowGuard);
  await host.use("subagents", subagents);
  // Block mode: a deterministic refusal with no UI prompt.
  await commands.get("flow-guard")!.run({ agent: agent as never, args: "block", print: () => {} });

  const childTurn = (req: CompletionRequest) => {
    const n = toolMsgCount(req);
    if (n === 0) return { toolCalls: [{ name: "source", arguments: {} }] };
    if (n === 1) return { toolCalls: [{ name: "egress", arguments: {} }] };
    return { text: "child-done" };
  };
  scriptProvider(agent, (req) => {
    if (req.systemPrompt.includes("SUBCHILD")) return childTurn(req);
    if (toolMsgCount(req) === 0) {
      return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "SUBCHILD" } }] };
    }
    return { text: "parent-done" };
  });

  await agent.run("kick off");

  // Governed: flow-guard blocked the child's egress before its body ran.
  assert.equal(egressResults.length, 1, "the child's egress reached the parent's shared tool_end exactly once");
  assert.equal(egressResults[0]!.isError, true, "flow-guard blocked the governed child's egress");
  assert.match(egressResults[0]!.content, /flow-guard: blocked/);
  assert.equal(egressRuns, 0, "the blocked egress body never executed");

  // Control: the SAME child construction on a fresh bus is ungoverned → egress runs.
  const control = new Agent({
    providers: agent.providers,
    capabilities: agent.capabilities,
    ui: agent.ui,
    logger: agent.logger,
    model: agent.model,
    provider: agent.providerName,
    systemPrompt: "SUBCHILD-CONTROL",
    maxTurns: 8,
    tools: childRegistryFrom(agent.tools.list()),
    hooks: new HookBus<KernelEvents, KernelFilters>(),
  });
  await control.run("go");
  assert.equal(egressRuns, 1, "the ungoverned (fresh-bus) child's egress executed — flow-guard did not govern it");
});

// ---------------------------------------------------------------------------
// AC-4 — write-guard governs a child without over-blocking
// ---------------------------------------------------------------------------

/** Register file read/write tools that operate on real (absolute) paths. */
function registerFileTools(agent: Agent): void {
  agent.tools.register(
    defineTool({
      name: "fread",
      description: "read a file (fs:read)",
      capabilities: ["fs:read"],
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: (args) => ok(readFileSync(String(args.path), "utf8")),
    }),
  );
  agent.tools.register(
    defineTool({
      name: "fwrite",
      description: "overwrite a file (fs:write, write-shaped)",
      capabilities: ["fs:write"],
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      execute: (args) => {
        writeFileSync(String(args.path), String(args.content));
        return ok("wrote");
      },
    }),
  );
}

test("AC-4 write-guard: a governed child that reads then overwrites is NOT gated (shared tool_end seeds `seen`)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-wg-a-"));
  const file = join(dir, "target.txt");
  writeFileSync(file, "original");
  try {
    const rec = recordingUI(false); // deny if asked
    const { agent, host } = makeHarness({ fallback: "allow", ui: rec.ui });
    registerFileTools(agent);
    await host.use("write-guard", writeGuard);
    await host.use("subagents", subagents);

    scriptProvider(agent, (req) => {
      if (req.systemPrompt.includes("SUBCHILD")) {
        const n = toolMsgCount(req);
        if (n === 0) return { toolCalls: [{ name: "fread", arguments: { path: file } }] };
        if (n === 1) return { toolCalls: [{ name: "fwrite", arguments: { path: file, content: "updated" } }] };
        return { text: "child-done" };
      }
      if (toolMsgCount(req) === 0) {
        return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "SUBCHILD" } }] };
      }
      return { text: "parent-done" };
    });

    await agent.run("kick off");

    assert.equal(rec.confirms.length, 0, "a read-then-overwrite is not prompted (path seen via shared tool_end)");
    assert.equal(readFileSync(file, "utf8"), "updated", "the overwrite went through unprompted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC-4 write-guard: a governed child overwriting an UNSEEN existing file IS gated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-wg-b-"));
  const file = join(dir, "target.txt");
  writeFileSync(file, "original");
  try {
    const rec = recordingUI(false); // deny the overwrite
    const { agent, host } = makeHarness({ fallback: "allow", ui: rec.ui });
    registerFileTools(agent);
    await host.use("write-guard", writeGuard);
    await host.use("subagents", subagents);

    scriptProvider(agent, (req) => {
      if (req.systemPrompt.includes("SUBCHILD")) {
        const n = toolMsgCount(req);
        if (n === 0) return { toolCalls: [{ name: "fwrite", arguments: { path: file, content: "updated" } }] };
        return { text: "child-done" };
      }
      if (toolMsgCount(req) === 0) {
        return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "SUBCHILD" } }] };
      }
      return { text: "parent-done" };
    });

    await agent.run("kick off");

    assert.ok(rec.confirms.length >= 1, "an unseen-file overwrite prompted the human (write-guard gate fired for the child)");
    assert.equal(readFileSync(file, "utf8"), "original", "the denied overwrite was blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-5 — parent call/result filters govern a child
// ---------------------------------------------------------------------------

test("AC-5 call/result guards: a parent beforeToolCall vetoes a child's call; a parent afterToolCall annotates a child's result", async () => {
  const { agent, host } = makeHarness({ fallback: "allow" });
  let riskyRan = false;
  agent.tools.register(
    defineTool({
      name: "risky",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        riskyRan = true;
        return ok("risky-ran");
      },
    }),
  );
  agent.tools.register(
    defineTool({ name: "safe", description: "x", parameters: { type: "object", properties: {} }, execute: () => ok("safe-ran") }),
  );

  // A bash-policy-style call guard and a content-guard-style result annotation.
  agent.hooks.filter("beforeToolCall", (decision, ctx) =>
    ctx.call.name === "risky" ? { ...decision, block: true, reason: "policy: risky blocked" } : decision,
  );
  agent.hooks.filter("afterToolCall", (result, ctx) =>
    ctx.call.name === "safe" ? { ...result, content: `${result.content} [annotated]` } : result,
  );

  const captured = new Map<string, ToolResult>();
  agent.hooks.on("tool_end", ({ call, result }) => {
    captured.set(call.name, result);
  });

  await host.use("subagents", subagents);

  scriptProvider(agent, (req) => {
    if (req.systemPrompt.includes("SUBCHILD")) {
      const n = toolMsgCount(req);
      if (n === 0) return { toolCalls: [{ name: "risky", arguments: {} }] };
      if (n === 1) return { toolCalls: [{ name: "safe", arguments: {} }] };
      return { text: "child-done" };
    }
    if (toolMsgCount(req) === 0) {
      return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "SUBCHILD" } }] };
    }
    return { text: "parent-done" };
  });

  await agent.run("kick off");

  assert.equal(riskyRan, false, "the parent call-guard vetoed the child's risky call before its body ran");
  const risky = captured.get("risky")!;
  assert.equal(risky.isError, true);
  assert.match(risky.content, /policy: risky blocked/);
  const safe = captured.get("safe")!;
  assert.match(safe.content, /\[annotated\]/, "the parent result-guard annotated the child's result");
});

// ---------------------------------------------------------------------------
// AC-6/AC-8 — lifecycle suppression + usage counted exactly once
// ---------------------------------------------------------------------------

test("AC-6/AC-8 lifecycle suppression + usage once: child agent_start suppressed, child tool_end observed, usage fires once per model call", async () => {
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.tools.register(
    defineTool({ name: "work", description: "x", parameters: { type: "object", properties: {} }, execute: () => ok("worked") }),
  );

  let agentStarts = 0;
  let childToolEnds = 0;
  let usageEvents = 0;
  agent.hooks.on("agent_start", () => {
    agentStarts++;
  });
  agent.hooks.on("tool_end", ({ call }) => {
    if (call.name === "work") childToolEnds++;
  });
  agent.hooks.on("usage", () => {
    usageEvents++;
  });

  await host.use("cost", cost); // cost active (another usage observer on the parent bus)
  await host.use("subagents", subagents);

  let streamCalls = 0;
  scriptProvider(agent, (req) => {
    streamCalls++;
    if (req.systemPrompt.includes("SUBCHILD")) {
      const n = toolMsgCount(req);
      if (n === 0) return { toolCalls: [{ name: "work", arguments: {} }] };
      return { text: "child-done" };
    }
    if (toolMsgCount(req) === 0) {
      return { toolCalls: [{ name: "spawn_agent", arguments: { mode: "single", prompt: "go", system: "SUBCHILD" } }] };
    }
    return { text: "parent-done" };
  });

  await agent.run("kick off");

  assert.equal(agentStarts, 1, "only the parent's agent_start fired; the child's was suppressed (no per-run reset)");
  assert.ok(childToolEnds >= 1, "the child's tool_end reached the parent observer (intra-run events shared)");
  assert.ok(streamCalls > 2, "the child contributed model calls");
  assert.equal(usageEvents, streamCalls, "exactly one usage event per model call — child usage counted once, no double bubble");
});
