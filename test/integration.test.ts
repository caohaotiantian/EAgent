/**
 * Integration guard: load every built-in extension together, exactly as the CLI
 * does, and prove they coexist — no duplicate tool/command names, no activation
 * errors, and a full tool-use turn still completes. This is the regression net
 * that catches extensions stepping on each other.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import coreTools from "../src/extensions/core-tools.js";
import skills from "../src/extensions/skills.js";
import mcp from "../src/extensions/mcp.js";
import codeact from "../src/extensions/codeact.js";
import subagents from "../src/extensions/subagents.js";
import memory from "../src/extensions/memory.js";
import planmode from "../src/extensions/planmode.js";
import session from "../src/extensions/session.js";
import packages from "../src/extensions/packages.js";
import trace from "../src/extensions/trace.js";
import contextFiles from "../src/extensions/context-files.js";
import limits from "../src/extensions/limits.js";
import self from "../src/extensions/self.js";
import web from "../src/extensions/web.js";
import checkpoint from "../src/extensions/checkpoint.js";
import introspect from "../src/extensions/introspect.js";
import { makeHarness } from "./helpers.js";

type Activate = Parameters<ReturnType<typeof makeHarness>["host"]["use"]>[1];

const EXTENSIONS: [string, Activate][] = [
  ["core-tools", coreTools],
  ["skills", skills],
  ["mcp", mcp],
  ["codeact", codeact],
  ["subagents", subagents],
  ["memory", memory],
  ["planmode", planmode],
  ["session", session],
  ["packages", packages],
  ["trace", trace],
  ["context-files", contextFiles],
  ["limits", limits],
  ["self", self],
  ["web", web],
  ["checkpoint", checkpoint],
  ["introspect", introspect],
];

async function loadAll(): Promise<ReturnType<typeof makeHarness>> {
  const h = makeHarness({
    responder: [{ toolCalls: [{ name: "remember", arguments: { key: "k", value: "v" } }] }, { text: "done" }],
    fallback: "allow",
  });
  for (const [id, activate] of EXTENSIONS) await h.host.use(id, activate);
  return h;
}

test("every built-in extension activates together without conflict", async () => {
  const h = await loadAll();
  for (const [id] of EXTENSIONS) assert.ok(h.host.has(id), `${id} should be loaded`);
});

test("the combined tool surface is present", async () => {
  const h = await loadAll();
  const names = new Set(h.agent.tools.list().map((t) => t.spec.name));
  for (const expected of ["read", "write", "edit", "bash", "run_code", "spawn_agent", "skill_create", "remember", "recall", "write_extension", "fetch_url", "describe_tool"]) {
    assert.ok(names.has(expected), `tool ${expected} should be registered`);
  }
});

test("the combined command surface is present", async () => {
  const h = await loadAll();
  const names = new Set(h.commands.list().map((c) => c.name));
  for (const expected of ["tools", "skills", "mcp", "code", "agents", "memory", "plan", "save", "pkg-list", "trace", "usage", "context", "limits", "self", "fetch", "checkpoints", "describe", "apropos"]) {
    assert.ok(names.has(expected), `command /${expected} should be registered`);
  }
});

test("a full tool-use turn completes with all extensions loaded", async () => {
  const h = await loadAll();
  const { reason } = await h.agent.run("remember something");
  assert.equal(reason, "end_turn");
  // The mock reports usage, so the agent should have accumulated some.
  assert.ok(h.agent.usage.inputTokens > 0, "usage should be tracked");
});

test("unloading every extension leaves a clean slate", async () => {
  const h = await loadAll();
  for (const [id] of EXTENSIONS) await h.host.unload(id);
  assert.equal(h.agent.tools.list().length, 0, "all tools disposed");
  assert.equal(h.commands.list().length, 0, "all commands disposed");
});
