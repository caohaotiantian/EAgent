import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

import coreTools from "../src/extensions/core-tools.js";
import type { Tool, ToolContext, ToolResult } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

const WORKSPACE = mkdtempSync(join(tmpdir(), "eagent-ws-"));

before(() => {
  process.env.EAGENT_WORKSPACE = WORKSPACE;
});

function ctx(): ToolContext {
  return {
    toolCallId: "t",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: { confirm: async () => true, notify: () => {} },
    agent: { model: "mock", messages: [], steer: () => {}, followUp: () => {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function loadTools(): Promise<Map<string, Tool>> {
  const { agent, host } = makeHarness();
  await host.use("core-tools", coreTools);
  const map = new Map<string, Tool>();
  for (const t of agent.tools.list()) map.set(t.spec.name, t);
  return map;
}

function run(tool: Tool | undefined, args: Record<string, unknown>): Promise<ToolResult> {
  assert.ok(tool, "tool should be registered");
  return tool!.execute(args, ctx());
}

test("write then read round-trips inside the workspace", async () => {
  const tools = await loadTools();
  const w = await run(tools.get("write"), { path: "notes.txt", content: "alpha\nbeta" });
  assert.equal(w.isError, undefined);
  assert.equal(readFileSync(join(WORKSPACE, "notes.txt"), "utf8"), "alpha\nbeta");

  const r = await run(tools.get("read"), { path: "notes.txt" });
  assert.match(r.content, /alpha/);
  assert.match(r.content, /beta/);
});

test("rejects path traversal outside the workspace root", async () => {
  const tools = await loadTools();
  const escapes = ["../escape.txt", "../../etc/passwd", "/etc/passwd"];
  for (const path of escapes) {
    const r = await run(tools.get("read"), { path });
    assert.equal(r.isError, true, `${path} should be rejected`);
    assert.match(r.content, /outside the workspace root/);
  }
  // An absolute path INSIDE the workspace is allowed.
  writeFileSync(join(WORKSPACE, "inside.txt"), "ok");
  const r = await run(tools.get("read"), { path: join(WORKSPACE, "inside.txt") });
  assert.equal(r.isError, undefined);
  assert.match(r.content, /ok/);
});

test("edit replaces unique text and guards ambiguous edits", async () => {
  const tools = await loadTools();
  await run(tools.get("write"), { path: "edit.txt", content: "one two one" });

  const ambiguous = await run(tools.get("edit"), { path: "edit.txt", old: "one", new: "X" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content, /appears 2 times/);

  const all = await run(tools.get("edit"), { path: "edit.txt", old: "one", new: "X", replaceAll: true });
  assert.equal(all.isError, undefined);
  assert.equal(readFileSync(join(WORKSPACE, "edit.txt"), "utf8"), "X two X");

  const missing = await run(tools.get("edit"), { path: "edit.txt", old: "zzz", new: "Y" });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /not found/);
});

test("bash is gated behind shell:exec and runs when allowed", async () => {
  // Denied: shell:exec is not auto-granted by core-tools.
  const denied = makeHarness({ responder: [{ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }, { text: "ok" }], fallback: "deny" });
  await denied.host.use("core-tools", coreTools);
  await denied.agent.run("run it");
  const deniedMsg = denied.agent.messages.find((m) => m.role === "tool")!;
  assert.match((deniedMsg.content[0] as { content: string }).content, /denied/i);

  // Allowed: runs and returns output.
  const ok = makeHarness({ responder: [{ toolCalls: [{ name: "bash", arguments: { command: "echo hello-bash" } }] }, { text: "done" }], fallback: "allow" });
  await ok.host.use("core-tools", coreTools);
  await ok.agent.run("run it");
  const okMsg = ok.agent.messages.find((m) => m.role === "tool")!;
  assert.match((okMsg.content[0] as { content: string }).content, /hello-bash/);
});
