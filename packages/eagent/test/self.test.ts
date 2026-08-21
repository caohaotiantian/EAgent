/**
 * Tests for the `self` extension — the agent authoring and hot-loading its own
 * real extensions at runtime. These exercise the full path through `agent.run`
 * (so capability enforcement applies), plus the read/reload tools and the
 * `/self` command.
 *
 * The extensions directory is pointed at a per-test temp directory by setting
 * `process.env.EAGENT_WORKSPACE` to a fresh temp workspace; the extension then
 * writes into `<workspace>/.eagent/extensions`. We restore the env var after.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

/** This package's root, resolved from THIS file — not from `process.cwd()`, which is the
 *  monorepo root when the suite runs from there. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");


import { makeHarness } from "./helpers.ts";
import self from "../src/extensions/self.ts";

const KERNEL_DEFINE = JSON.stringify(join(PKG_ROOT, "src/kernel/define.ts"));

/** Generated extension source registering a tool named `gen_tool`. */
const genCode =
  `import { defineTool } from ${KERNEL_DEFINE};\n` +
  `export default function activate(e){ e.registerTool(defineTool({ ` +
  `name: "gen_tool", description: "generated", execute: () => ({ content: "generated-ok" }) })); }`;

/** A second generation registering a differently-named tool `gen_tool_v2`. */
const genCodeV2 =
  `import { defineTool } from ${KERNEL_DEFINE};\n` +
  `export default function activate(e){ e.registerTool(defineTool({ ` +
  `name: "gen_tool_v2", description: "generated v2", execute: () => ({ content: "v2-ok" }) })); }`;

let workspace: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "eagent-self-"));
  prevWorkspace = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = workspace;
});

afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.EAGENT_WORKSPACE;
  else process.env.EAGENT_WORKSPACE = prevWorkspace;
  rmSync(workspace, { recursive: true, force: true });
});

/** The directory the extension writes into for the current workspace. */
function extDir(): string {
  return join(workspace, ".eagent", "extensions");
}

test("self-authoring: write_extension writes and hot-loads a new tool", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "write_extension", arguments: { name: "gen-ext", code: genCode } }] },
      { text: "done" },
    ],
  });
  await h.host.use("self", self);

  await h.agent.run("make me an extension");

  assert.ok(h.agent.tools.has("gen_tool"), "gen_tool should be registered after the live load");
  assert.ok(existsSync(join(extDir(), "gen-ext.ts")), "the extension file should exist on disk");
});

test("capability gate: write_extension is blocked under fallback deny", async () => {
  const h = makeHarness({
    fallback: "deny",
    responder: [
      { toolCalls: [{ name: "write_extension", arguments: { name: "gen-ext", code: genCode } }] },
      { text: "done" },
    ],
  });
  await h.host.use("self", self);

  const result = await h.agent.run("make me an extension");

  const toolMsg = result.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "there should be a tool message");
  const block = toolMsg!.content.find((b) => b.type === "tool_result");
  assert.ok(block && block.type === "tool_result");
  assert.match(block.content, /denied|CapabilityError/i, "the tool result should report a capability denial");
  assert.ok(!h.agent.tools.has("gen_tool"), "gen_tool must NOT be registered when denied");
});

test("read_extension returns the source that was written", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "write_extension", arguments: { name: "gen-ext", code: genCode } }] },
      { text: "done" },
    ],
  });
  await h.host.use("self", self);
  await h.agent.run("make it");

  const read = h.agent.tools.get("read_extension");
  assert.ok(read, "read_extension should be registered");
  const out = await read!.execute(
    { name: "gen-ext" },
    fakeCtx(),
  );
  assert.ok(!out.isError, "read_extension should succeed");
  assert.equal(out.content, genCode, "read_extension should return the exact written source");
});

test("reload_extension picks up edited source with a new tool name", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "write_extension", arguments: { name: "gen-ext", code: genCode } }] },
      { text: "done" },
    ],
  });
  await h.host.use("self", self);
  await h.agent.run("make it");
  assert.ok(h.agent.tools.has("gen_tool"), "first version registers gen_tool");

  // Overwrite the file on disk with a new generation, then reload.
  writeFileSync(join(extDir(), "gen-ext.ts"), genCodeV2, "utf8");
  const reload = h.agent.tools.get("reload_extension");
  assert.ok(reload, "reload_extension should be registered");
  const out = await reload!.execute({ id: "gen-ext" }, fakeCtx());

  assert.ok(!out.isError, `reload should succeed: ${out.content}`);
  assert.ok(h.agent.tools.has("gen_tool_v2"), "reloaded version should register gen_tool_v2");
  assert.ok(!h.agent.tools.has("gen_tool"), "the old tool should be gone after a clean swap");
});

test("/self command prints guidance and the extensions directory", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("self", self);

  const cmd = h.commands.get("self");
  assert.ok(cmd, "the /self command should be registered");
  const lines: string[] = [];
  await cmd!.run({ agent: h.agent, args: "", print: (l) => lines.push(l) });
  const text = lines.join("\n");
  assert.match(text, /extend/i, "should explain self-extension");
  assert.match(text, /write_extension/, "should mention write_extension");
  assert.match(text, /\.eagent[\\/]extensions/, "should mention where extensions are written");
});

test("read_extension refuses a path-traversal name (cannot escape the extensions dir)", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("self", self);
  const read = h.agent.tools.get("read_extension");
  assert.ok(read, "read_extension should be registered");
  // A traversal with a recognized suffix that, unsanitized, resolves to a real
  // file outside the extensions directory. The slug-only candidate build must
  // keep it confined, so this fails rather than leaking /etc/hosts.
  const out = await read!.execute({ name: "../../../../../../../../etc/hosts.js" }, fakeCtx());
  assert.ok(out.isError, "a traversal name must not resolve to a real file");
  assert.match(out.content, /no extension named/i);
  assert.doesNotMatch(out.content, /localhost|127\.0\.0\.1/i, "must not leak the contents of /etc/hosts");
});

/** A minimal ToolContext for invoking read/reload tools directly. */
function fakeCtx() {
  return {
    toolCallId: "test",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: { confirm: async () => true, notify: () => {} },
    agent: {} as never,
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}
