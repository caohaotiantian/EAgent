/**
 * config-hooks — declarative, config-file-driven bridge to the kernel hook bus.
 * The pure validator/matcher helpers (validateConfig, matchesCall, globToRegExp,
 * truncateBytes, parseDirective) are unit-tested directly; the guards are
 * exercised through the agent loop with only config-hooks loaded, so any block
 * reason is unambiguously config-hooks'. All offline against MockProvider.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent } from "../src/kernel/agent.js";
import { defineTool } from "../src/kernel/define.js";
import { makeHarness } from "./helpers.js";
import configHooks, {
  globToRegExp,
  matchesCall,
  validateConfig,
  truncateBytes,
  parseDirective,
  type Binding,
} from "../src/extensions/config-hooks.js";

// ---------------------------------------------------------------------------
// Pure helper units
// ---------------------------------------------------------------------------

test("globToRegExp anchors and treats only * as a wildcard", () => {
  assert.equal(globToRegExp("rm *").test("rm -rf x"), true);
  assert.equal(globToRegExp("rm *").test("git rm x"), false);
  assert.equal(globToRegExp("bash").test("bash"), true);
  assert.equal(globToRegExp("bash").test("bashful"), false);
  // A `.` is a literal, not "any char".
  assert.equal(globToRegExp("a.b").test("axb"), false);
  assert.equal(globToRegExp("a.b").test("a.b"), true);
});

test("matchesCall: absent matcher matches all; tool + args are anchored globs", () => {
  const call = { name: "bash", arguments: { command: "rm -rf build" } };
  assert.equal(matchesCall(undefined, call), true);
  assert.equal(matchesCall({ tool: "bash" }, call), true);
  assert.equal(matchesCall({ tool: "ba*" }, call), true);
  assert.equal(matchesCall({ tool: "sh" }, call), false);
  assert.equal(matchesCall({ args: { command: "rm *" } }, call), true);
  assert.equal(matchesCall({ args: { command: "git *" } }, call), false);
  // A missing arg stringifies to "undefined" and won't match a real glob.
  assert.equal(matchesCall({ args: { nope: "*" } }, call), true);
  assert.equal(matchesCall({ args: { nope: "x*" } }, call), false);
});

test("validateConfig drops unknown on / action.type and type/point mismatches", () => {
  const { bindings, errors } = validateConfig({
    hooks: [
      { on: "beforeToolCall", action: { type: "block", reason: "no" } }, // ok
      { on: "bogus", action: { type: "block" } }, // unknown on
      { on: "beforeToolCall", action: { type: "frobnicate" } }, // unknown action
      { on: "afterToolCall", action: { type: "block" } }, // type/point mismatch
      { on: "transformContext", action: { type: "inject", text: "hi" } }, // ok
    ],
  });
  assert.equal(bindings.length, 2);
  assert.equal(errors.length, 3);
  assert.match(errors.join("\n"), /unknown `on`/);
  assert.match(errors.join("\n"), /unknown `action.type`/);
  assert.match(errors.join("\n"), /not valid on `afterToolCall`/);
});

test("validateConfig accepts a bare bindings array and reports a non-array", () => {
  const ok = validateConfig([{ on: "beforeToolCall", action: { type: "allow" } }]);
  assert.equal(ok.bindings.length, 1);
  assert.equal(ok.errors.length, 0);

  const bad = validateConfig({ hooks: "not-an-array" });
  assert.equal(bad.bindings.length, 0);
  assert.equal(bad.errors.length, 1);
});

test("validateConfig validates command / truncate / match shapes", () => {
  const r = validateConfig({
    hooks: [
      { on: "beforeToolCall", action: { type: "command", command: "exit 0", timeoutMs: 500, sandbox: "required" } },
      { on: "beforeToolCall", action: { type: "command", command: "" } }, // empty command
      { on: "afterToolCall", action: { type: "truncate", limit: -1 } }, // bad limit
      { on: "beforeToolCall", match: { args: { command: 5 } }, action: { type: "allow" } }, // non-string glob
    ],
  });
  assert.equal(r.bindings.length, 1);
  assert.equal(r.bindings[0]!.action.type, "command");
  assert.equal(r.errors.length, 3);
});

test("truncateBytes caps at limit and marks truncation; passes short content through", () => {
  const out = truncateBytes("x".repeat(100), 10);
  assert.ok(out.startsWith("x".repeat(10)));
  assert.match(out, /truncated/);
  assert.equal(truncateBytes("short", 100), "short");
});

test("parseDirective parses a JSON object directive, else null", () => {
  assert.deepEqual(parseDirective('{"block":true,"reason":"r"}'), { block: true, reason: "r" });
  assert.equal(parseDirective("plain text"), null);
  assert.equal(parseDirective("[1,2]"), null);
  assert.equal(parseDirective(""), null);
});

// ---------------------------------------------------------------------------
// Through-the-loop guards
// ---------------------------------------------------------------------------

/** Register a shell:exec tool whose execute flips a flag, so blocking is observable. */
function shellTool(agent: Agent, name = "bash"): () => boolean {
  let ran = false;
  agent.tools.register(
    defineTool({
      name,
      description: "",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: () => {
        ran = true;
        return { content: "ran" };
      },
    }),
  );
  return () => ran;
}

/** Did any tool-result the model saw carry a config-hooks block reason? */
function sawBlock(agent: Agent): boolean {
  return agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /config-hooks: /.test(b.content)));
}

/** Load config-hooks with seeded store config (hooks + enabled by default). */
function withConfig(hooks: Binding[], opts: { enabled?: boolean } = {}) {
  return (e: import("../src/kernel/extension.js").ExtensionAPI) => {
    e.store.set("hooks", hooks);
    if (opts.enabled !== false) e.store.set("enabled", true);
    return configHooks(e);
  };
}

test("block binding fires through the loop", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use(
    "config-hooks",
    withConfig([{ on: "beforeToolCall", match: { tool: "bash", args: { command: "rm *" } }, action: { type: "block", reason: "no" } }]),
  );

  await h.agent.run("clean up");
  assert.equal(didRun(), false, "the block binding stops execution");
  assert.equal(sawBlock(h.agent), true, "the model sees the config-hooks block reason");
});

test("a non-matching call runs (different tool/arg)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "ls -la" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use(
    "config-hooks",
    withConfig([{ on: "beforeToolCall", match: { args: { command: "rm *" } }, action: { type: "block", reason: "no" } }]),
  );

  await h.agent.run("list");
  assert.equal(didRun(), true, "a non-matching arg does not block");
  assert.equal(sawBlock(h.agent), false, "no config-hooks block reason");
});

test("inject wiring prepends a marked ephemeral system note", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use(
    "config-hooks",
    withConfig([{ on: "transformContext", action: { type: "inject", text: "remember the budget" } }]),
  );

  const out = await h.agent.hooks.apply("transformContext", [], { turn: 0, model: "mock" });
  assert.equal(out.length, 1);
  const note = out[0]!;
  assert.equal(note.role, "system");
  assert.equal(note.meta?.source, "config-hooks");
  assert.equal(note.meta?.ephemeral, true);
  assert.equal(note.content[0]!.type === "text" && note.content[0]!.text, "remember the budget");
});

test("append and truncate transform the tool result", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use(
    "config-hooks",
    withConfig([
      { on: "afterToolCall", match: { tool: "bash" }, action: { type: "truncate", limit: 5 } },
      { on: "afterToolCall", match: { tool: "bash" }, action: { type: "append", text: "NOTE" } },
    ]),
  );

  const call = { type: "tool_call" as const, id: "1", name: "bash", arguments: {} };
  const out = await h.agent.hooks.apply("afterToolCall", { content: "x".repeat(40) }, { call });
  assert.ok(out.content.startsWith("xxxxx"));
  assert.match(out.content, /truncated/);
  assert.ok(out.content.endsWith("\nNOTE"));
});

/** A capability-free stub tool, so config-hooks' own shell:exec gate is isolated. */
function plainTool(agent: Agent, name = "note"): () => boolean {
  let ran = false;
  agent.tools.register(
    defineTool({
      name,
      description: "",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      execute: () => {
        ran = true;
        return { content: "ran" };
      },
    }),
  );
  return () => ran;
}

test("command beforeToolCall is skipped (decision unchanged) when shell:exec is denied", async () => {
  let warned = false;
  const h = makeHarness({
    fallback: "deny",
    logger: { debug: () => {}, info: () => {}, warn: () => { warned = true; }, error: () => {} },
    responder: [{ toolCalls: [{ name: "note", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  // A capability-free tool so the only shell:exec request is config-hooks' command spawn.
  const didRun = plainTool(h.agent);
  await h.host.use(
    "config-hooks",
    withConfig([{ on: "beforeToolCall", match: { tool: "note" }, action: { type: "command", command: "exit 3" } }]),
  );

  await h.agent.run("clean up");
  assert.equal(didRun(), true, "fail-open: a denied command leaves the decision unchanged");
  assert.equal(sawBlock(h.agent), false, "no fabricated block");
  assert.equal(warned, true, "the skip is logged");
});

test("command beforeToolCall blocks on non-zero exit and allows on exit 0", async () => {
  const blocked = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "do it" } }] }, { text: "done" }],
  });
  const blockedRan = shellTool(blocked.agent);
  await blocked.host.use(
    "config-hooks",
    withConfig([{ on: "beforeToolCall", match: { tool: "bash" }, action: { type: "command", command: "exit 3" } }]),
  );
  await blocked.agent.run("go");
  assert.equal(blockedRan(), false, "exit 3 blocks the call");
  assert.equal(sawBlock(blocked.agent), true, "the model sees the config-hooks block reason");

  const allowed = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "do it" } }] }, { text: "done" }],
  });
  const allowedRan = shellTool(allowed.agent);
  await allowed.host.use(
    "config-hooks",
    withConfig([{ on: "beforeToolCall", match: { tool: "bash" }, action: { type: "command", command: "exit 0" } }]),
  );
  await allowed.agent.run("go");
  assert.equal(allowedRan(), true, "exit 0 lets the call run");
  assert.equal(sawBlock(allowed.agent), false, "no config-hooks block reason");
});

test("EAGENT_CONFIG_HOOKS=off disables the guard", async () => {
  const prev = process.env.EAGENT_CONFIG_HOOKS;
  process.env.EAGENT_CONFIG_HOOKS = "off";
  try {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
    });
    const didRun = shellTool(h.agent);
    await h.host.use(
      "config-hooks",
      withConfig([{ on: "beforeToolCall", match: { tool: "bash" }, action: { type: "block", reason: "no" } }]),
    );

    await h.agent.run("clean up");
    assert.equal(didRun(), true, "the kill switch disables blocking");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_CONFIG_HOOKS;
    else process.env.EAGENT_CONFIG_HOOKS = prev;
  }
});

test("opt-in default: without the enabled flag, a block binding does not fire", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use(
    "config-hooks",
    withConfig([{ on: "beforeToolCall", match: { tool: "bash" }, action: { type: "block", reason: "no" } }], { enabled: false }),
  );

  await h.agent.run("clean up");
  assert.equal(didRun(), true, "ships off: no enabled flag, no block");
  assert.equal(sawBlock(h.agent), false, "no config-hooks block reason");
});

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

async function runCmd(h: ReturnType<typeof makeHarness>, args: string): Promise<string> {
  let out = "";
  await h.commands.get("config-hooks")!.run({
    agent: h.agent,
    args,
    print: (line: string) => {
      out += `${line}\n`;
    },
  });
  return out;
}

test("/config-hooks off actually disables after a prior on (toggle is symmetric)", async () => {
  // Regression: `on` used to also write the runtime override, which `off` never
  // cleared — leaving a shell-executing extension stuck enabled (override shadows
  // the store flag). The toggle must round-trip.
  const h = makeHarness({
    fallback: "allow",
    responder: (req) =>
      req.messages.some((m) => m.role === "tool")
        ? { text: "done" }
        : { toolCalls: [{ name: "bash", arguments: { command: "rm x" } }] },
  });
  const didRun = shellTool(h.agent);
  await h.host.use(
    "config-hooks",
    withConfig([{ on: "beforeToolCall", match: { tool: "bash" }, action: { type: "block", reason: "no" } }], { enabled: false }),
  );

  await runCmd(h, "on");
  await h.agent.run("do it");
  assert.equal(didRun(), false, "on: the bash block fires");

  await runCmd(h, "off");
  h.agent.clear();
  await h.agent.run("do it again");
  assert.equal(didRun(), true, "off: the block no longer fires (extension disabled)");
});

test("/config-hooks on then status prints on; list prints the bindings", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use(
    "config-hooks",
    withConfig(
      [
        { on: "beforeToolCall", match: { tool: "bash" }, action: { type: "block", reason: "no" } },
        { on: "transformContext", action: { type: "inject", text: "hi" } },
      ],
      { enabled: false },
    ),
  );

  assert.match(await runCmd(h, "on"), /config-hooks on/);
  const status = await runCmd(h, "status");
  assert.match(status, /config-hooks on/);
  assert.match(status, /beforeToolCall=1/);

  const list = await runCmd(h, "list");
  assert.match(list, /beforeToolCall\s+tool=bash\s+-> block/);
  assert.match(list, /transformContext\s+\*\s+-> inject/);

  assert.match(await runCmd(h, "off"), /config-hooks off/);
});

test("/config-hooks reload over a malformed store entry prints an error count and does not throw", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("config-hooks", (e) => {
    e.store.set("enabled", true);
    e.store.set("hooks", [{ on: "bogus", action: { type: "block" } }]);
    return configHooks(e);
  });

  let out = "";
  await assert.doesNotReject(async () => {
    out = await runCmd(h, "reload");
  });
  assert.match(out, /loaded 0 binding\(s\), 1 error\(s\)/);
});
