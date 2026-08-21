/**
 * Integration guard: load every built-in extension together, exactly as the CLI
 * does, and prove they coexist — no duplicate tool/command names, no activation
 * errors, and a full tool-use turn still completes. This is the regression net
 * that catches extensions stepping on each other.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import coreTools from "../src/extensions/core-tools.ts";
import skills from "../src/extensions/skills.ts";
import mcp from "../src/extensions/mcp.ts";
import codeact from "../src/extensions/codeact.ts";
import subagents from "../src/extensions/subagents.ts";
import memory from "../src/extensions/memory.ts";
import planmode from "../src/extensions/planmode.ts";
import session from "../src/extensions/session.ts";
import packages from "../src/extensions/packages.ts";
import trace from "../src/extensions/trace.ts";
import contextFiles from "../src/extensions/context-files.ts";
import limits from "../src/extensions/limits.ts";
import self from "../src/extensions/self.ts";
import web from "../src/extensions/web.ts";
import checkpoint from "../src/extensions/checkpoint.ts";
import introspect from "../src/extensions/introspect.ts";
import journal from "../src/extensions/journal.ts";
import promptsExt from "../src/extensions/prompts.ts";
import { makeHarness } from "./helpers.ts";

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
  ["journal", journal],
  ["prompts", promptsExt],
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
  for (const expected of ["tools", "skills", "mcp", "code", "agents", "memory", "plan", "save", "pkg-list", "trace", "usage", "context", "limits", "self", "fetch", "checkpoints", "describe", "apropos", "journal", "resume", "prompts", "prompt"]) {
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
