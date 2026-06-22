/**
 * env-report — classify environmental failures and suppress the retry-nudge.
 *
 * The pure helpers (classifyEnv, ENV_RULES, annotateEnv, ENV_NOTE) are unit-tested
 * directly; the guard is exercised through the agent loop with `recovery` co-loaded
 * (recovery first, env-report after — the real chain order), against inline stub
 * tools that return scripted env-class / non-env error strings, so the suppression
 * composes through the actual `afterToolCall` filter chain. All offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent } from "../src/kernel/agent.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { Logger, ToolResult } from "../src/kernel/types.js";
import { defineTool } from "../src/kernel/define.js";
import { makeHarness, type Harness } from "./helpers.js";
import recovery from "../src/extensions/recovery.js";
import envReport, { classifyEnv, ENV_RULES, annotateEnv, ENV_NOTE } from "../src/extensions/env-report.js";

// -- unit: the pure classifier (AC2, AC3, AC4) -------------------------------

test("classifyEnv returns each env class on its real error string", () => {
  // AC2 — each class on its headline machine-emitted string.
  assert.equal(classifyEnv("Error: ANTHROPIC_API_KEY is not set"), "auth");
  assert.equal(classifyEnv("HTTP 401 Unauthorized"), "auth");
  assert.equal(classifyEnv("/bin/sh: rg: command not found"), "missing-binary");
  assert.equal(classifyEnv("spawn rg ENOENT"), "missing-binary");
  assert.equal(classifyEnv("getaddrinfo ENOTFOUND api.example.com"), "network");
  assert.equal(classifyEnv("connect ECONNREFUSED 127.0.0.1:443"), "network");
  assert.equal(classifyEnv("EACCES: permission denied, open '/etc/x'"), "permission");
});

test("classifyEnv returns null for recovery-matchable (self-inflicted) errors", () => {
  // AC3 — recovery's own strings must NOT be poached by env-report.
  assert.equal(classifyEnv("Text not found in /tmp/x.ts."), null);
  assert.equal(classifyEnv("Invalid arguments for edit"), null);
});

test("classifyEnv returns null for benign success-shaped output", () => {
  // AC4
  assert.equal(classifyEnv("Wrote 12 bytes to /tmp/x.ts"), null);
});

test("ENV_RULES is a non-empty readonly ruleset of class+RegExp", () => {
  assert.ok(ENV_RULES.length > 0, "the ruleset must have rules");
  for (const rule of ENV_RULES) {
    assert.ok(typeof rule.class === "string");
    assert.ok(rule.match instanceof RegExp);
  }
});

// -- unit: the guard transform (gating + idempotency + replacement) ----------

test("annotateEnv leaves a successful result unchanged", () => {
  // AC5 — gating on isError.
  const success: ToolResult = { content: "spawn rg ENOENT", isError: false };
  assert.equal(annotateEnv(success).content, success.content);
});

test("annotateEnv leaves a failed non-env result unchanged", () => {
  // AC5 — non-env failures pass through to recovery untouched.
  const nonEnv: ToolResult = { content: "the disk is on fire", isError: true };
  assert.equal(annotateEnv(nonEnv).content, nonEnv.content);
});

test("annotateEnv appends the route-around note once and is idempotent", () => {
  // AC5 idempotency.
  const failed: ToolResult = { content: "spawn rg ENOENT", isError: true };
  const once = annotateEnv(failed);
  assert.match(once.content, /environment issue/i, "an env failure gains the env note");
  assert.match(once.content, /do NOT retry/i, "the env note tells the model not to retry");
  const twice = annotateEnv(once);
  assert.equal(twice.content, once.content, "annotateEnv is idempotent on already-noted content");
});

test("annotateEnv replaces a recovery hint with the route-around note", () => {
  // AC6 — strips Recovery hint:, adds the env note.
  const withHint: ToolResult = {
    content: "spawn rg ENOENT\n\nRecovery hint: re-read the file and copy the exact text.",
    isError: true,
  };
  const out = annotateEnv(withHint);
  assert.doesNotMatch(out.content, /Recovery hint:/, "the recovery retry-nudge is stripped");
  assert.match(out.content, /environment issue/i);
  assert.match(out.content, /do NOT retry/i);
});

test("ENV_NOTE is the single literal carrying the route-around markers", () => {
  assert.match(ENV_NOTE, /environment issue/i);
  assert.match(ENV_NOTE, /do NOT retry/i);
});

// -- live: through the agent loop --------------------------------------------

/** Register an inline stub tool returning a fixed result, via host.use. */
function stubTool(result: ToolResult) {
  return (e: ExtensionAPI) =>
    e.registerTool(
      defineTool({
        name: "envfail",
        description: "A stub tool that returns a scripted error.",
        parameters: { type: "object", properties: {} },
        execute: () => result,
      }),
    );
}

/** The tool_result block the model saw for the named tool (or any tool). */
function toolResultContent(agent: Agent): string | undefined {
  for (const m of agent.messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") return b.content;
    }
  }
  return undefined;
}

/** A capturing logger: pushes warn args to `warnings`, swallows the rest. */
function captureLogger(warnings: unknown[][]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => warnings.push(args),
    error: () => {},
  };
}

function warnedEnvIssue(warnings: unknown[][]): boolean {
  return warnings.some((args) => args.some((a) => typeof a === "string" && /environment_issue/.test(a)));
}

test("live: an env error replaces the retry-nudge", async () => {
  // AC7 — recovery then env-report; env error reaches the model with the route-around
  // note and NOT a Recovery hint.
  const h = makeHarness({
    responder: [{ toolCalls: [{ name: "envfail" }] }, { text: "done" }],
  });
  await h.host.use("recovery", recovery);
  await h.host.use("env-report", envReport);
  await h.host.use("stub", stubTool({ isError: true, content: "spawn rg ENOENT" }));

  await h.agent.run("go");
  const content = toolResultContent(h.agent);
  assert.ok(content !== undefined, "the model saw a tool_result");
  assert.match(content, /environment issue/i);
  assert.match(content, /do NOT retry/i);
  assert.doesNotMatch(content, /Recovery hint:/);
});

test("live: a non-env error keeps recovery's nudge", async () => {
  // AC8 — a recovery-matchable error reaches the model with recovery's hint intact
  // and NO env note.
  const h = makeHarness({
    responder: [{ toolCalls: [{ name: "envfail" }] }, { text: "done" }],
  });
  await h.host.use("recovery", recovery);
  await h.host.use("env-report", envReport);
  await h.host.use("stub", stubTool({ isError: true, content: "Text not found in x.ts." }));

  await h.agent.run("go");
  const content = toolResultContent(h.agent);
  assert.ok(content !== undefined, "the model saw a tool_result");
  assert.match(content, /Recovery hint:/, "recovery's nudge survives for a correctable error");
  assert.doesNotMatch(content, /environment issue/i, "env-report does not poach recovery's domain");
});

test("live: the host signal environment_issue is emitted on an env failure", async () => {
  // AC9 — operator-visible warn line.
  const warnings: unknown[][] = [];
  const h = makeHarness({
    responder: [{ toolCalls: [{ name: "envfail" }] }, { text: "done" }],
    logger: captureLogger(warnings),
  });
  await h.host.use("recovery", recovery);
  await h.host.use("env-report", envReport);
  await h.host.use("stub", stubTool({ isError: true, content: "spawn rg ENOENT" }));

  await h.agent.run("go");
  assert.ok(warnedEnvIssue(warnings), "an environment_issue warn line was emitted");
});

test("live: the env_report tool surfaces a model-declared blocker", async () => {
  // AC10 — the model declares a blocker via env_report; result is successful and
  // carries the route-around note + a warn line.
  const warnings: unknown[][] = [];
  const h = makeHarness({
    responder: [
      { toolCalls: [{ name: "env_report", arguments: { reason: "GITHUB_TOKEN not set; cannot push" } }] },
      { text: "done" },
    ],
    logger: captureLogger(warnings),
  });
  await h.host.use("env-report", envReport);

  await h.agent.run("go");
  const toolMsg = h.agent.messages.find((m) => m.role === "tool");
  const block = toolMsg?.content.find((b) => b.type === "tool_result");
  assert.ok(block && block.type === "tool_result", "the env_report tool produced a tool_result");
  assert.ok(!block.isError, "the env_report tool result is successful");
  assert.match(block.content, /environment issue/i);
  assert.match(block.content, /do NOT retry/i);
  assert.ok(warnedEnvIssue(warnings), "the env_report tool emits an environment_issue warn line");
});

test("live: EAGENT_ENV_REPORT=off disables rewrite and does not register the tool", async () => {
  // AC11 — kill switch restores baseline.
  const prev = process.env.EAGENT_ENV_REPORT;
  process.env.EAGENT_ENV_REPORT = "off";
  try {
    const h = makeHarness({
      responder: [{ toolCalls: [{ name: "envfail" }] }, { text: "done" }],
    });
    await h.host.use("recovery", recovery);
    await h.host.use("env-report", envReport);
    await h.host.use("stub", stubTool({ isError: true, content: "spawn rg ENOENT" }));

    await h.agent.run("go");
    const content = toolResultContent(h.agent);
    assert.ok(content !== undefined);
    assert.doesNotMatch(content, /environment issue/i, "kill switch suppresses the env note");
    assert.equal(h.agent.tools.get("env_report"), undefined, "the env_report tool is not registered");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_ENV_REPORT;
    else process.env.EAGENT_ENV_REPORT = prev;
  }
});

test("live: disposing env-report unregisters the hook and the tool (no leak)", async () => {
  // AC12 — clean disposal.
  const h: Harness = makeHarness({
    responder: [{ toolCalls: [{ name: "envfail" }] }, { text: "done" }],
  });
  await h.host.use("recovery", recovery);
  await h.host.use("env-report", envReport);
  await h.host.use("stub", stubTool({ isError: true, content: "spawn rg ENOENT" }));
  await h.host.unload("env-report");

  await h.agent.run("go");
  const content = toolResultContent(h.agent);
  assert.ok(content !== undefined);
  assert.doesNotMatch(content, /environment issue/i, "after teardown the hook no longer rewrites");
  assert.equal(h.agent.tools.get("env_report"), undefined, "after teardown the tool is gone");
});
