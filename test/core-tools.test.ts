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

test("edit succeeds on whitespace-drift via a fallback strategy", async () => {
  const tools = await loadTools();
  await run(tools.get("write"), { path: "drift.txt", content: "function f() {\n    return 42;\n}\n" });

  // `old` differs only by the middle line's indentation; the exact match misses
  // and the relaxed ladder locates the real indented span.
  const r = await run(tools.get("edit"), {
    path: "drift.txt",
    old: "function f() {\nreturn 42;\n}",
    new: "function f() {\n    return 7;\n}",
  });
  assert.equal(r.isError, undefined);
  assert.match(r.content, /matched via/);
  assert.match(r.content, /line-trimmed/);
  assert.equal(readFileSync(join(WORKSPACE, "drift.txt"), "utf8"), "function f() {\n    return 7;\n}\n");
});

test("edit keeps the exact-match guards unchanged", async () => {
  const tools = await loadTools();
  await run(tools.get("write"), { path: "guards.txt", content: "dup dup" });

  const twice = await run(tools.get("edit"), { path: "guards.txt", old: "dup", new: "Z" });
  assert.equal(twice.isError, true);
  assert.match(twice.content, /appears 2 times/);

  const absent = await run(tools.get("edit"), { path: "guards.txt", old: "nope", new: "Z" });
  assert.equal(absent.isError, true);
  assert.match(absent.content, /not found/);
});

test("edit rejects a disproportionate relaxed span and leaves the file unchanged", async () => {
  const tools = await loadTools();
  const lines = Array.from({ length: 10 }, (_, i) => `row${i}`);
  const original = lines.join("\n") + "\n";
  await run(tools.get("write"), { path: "prop.txt", content: original });

  // A single-line `old` (literal \n separators) escape-normalizes to a ten-line
  // span — far larger than the find — so the edit must refuse and ask for a re-read.
  const r = await run(tools.get("edit"), { path: "prop.txt", old: lines.join("\\n"), new: "ONE" });
  assert.equal(r.isError, true);
  assert.match(r.content, /re-read/);
  assert.equal(readFileSync(join(WORKSPACE, "prop.txt"), "utf8"), original);
});

test("edit replaceAll over a relaxed unique span replaces the located text", async () => {
  const tools = await loadTools();
  await run(tools.get("write"), { path: "relaxed-all.txt", content: "  const x = 1;\n" });

  // `old` collapses internal whitespace runs; the relaxed match locates the one
  // real span, and replaceAll replaces that single located span.
  const r = await run(tools.get("edit"), {
    path: "relaxed-all.txt",
    old: "const   x   =   1;",
    new: "  const x = 2;",
    replaceAll: true,
  });
  assert.equal(r.isError, undefined);
  assert.match(r.content, /matched via/);
  assert.equal(readFileSync(join(WORKSPACE, "relaxed-all.txt"), "utf8"), "  const x = 2;\n");
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
