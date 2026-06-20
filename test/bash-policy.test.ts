/**
 * bash-policy — command-granular shell authority. The pure helpers
 * (extractCommand, evaluate) are unit-tested directly; the guard is exercised
 * through the agent loop with only bash-policy loaded, so any ui.confirm is
 * unambiguously bash-policy's. All offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { Agent } from "../src/kernel/agent.js";
import { makeHarness } from "./helpers.js";
import bashPolicy, { extractCommand, evaluate, type Rule } from "../src/extensions/bash-policy.js";

test("extractCommand reduces a command line to its arity-based command family", () => {
  assert.equal(extractCommand('git commit -m "wip"'), "git commit");
  assert.equal(extractCommand("npm run dev --silent"), "npm run dev");
  assert.equal(extractCommand("git checkout -b feature"), "git checkout");
  assert.equal(extractCommand("python script.py"), "python script.py");
  assert.equal(extractCommand("frobnicate a b"), "frobnicate");
  assert.equal(extractCommand("FOO=bar rm -rf build"), "rm");
  assert.equal(extractCommand("   "), "");
});

test("evaluate resolves a ruleset with last-match-wins wildcard precedence", () => {
  const rules: Rule[] = [
    { pattern: "*", action: "ask" },
    { pattern: "git *", action: "allow" },
    { pattern: "git push *", action: "deny" },
  ];
  assert.equal(evaluate("git status", rules, "allow"), "allow");
  assert.equal(evaluate("git push origin main", rules, "allow"), "deny");
  assert.equal(evaluate("curl http://x", rules, "allow"), "ask");
  assert.equal(evaluate("git status", [], "allow"), "allow");
});

test("evaluate matches wildcards literally except for *", () => {
  const rules: Rule[] = [{ pattern: "rm *.b", action: "deny" }];
  assert.equal(evaluate("rm -rf a.b", rules, "allow"), "deny");
  assert.equal(evaluate("rm -rf axb", rules, "allow"), "allow");
});

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

/** Did any tool-result the model saw carry a bash-policy block reason? */
function sawBlock(agent: Agent): boolean {
  return agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /bash-policy: /.test(b.content)));
}

test("default is a no-op: a bash call runs and is not blocked", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", bashPolicy);

  await h.agent.run("clean up");
  assert.equal(didRun(), true, "with no rules, the command runs");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("deny blocks the matching command", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up");
  assert.equal(didRun(), false, "a deny rule blocks execution");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

test("ask defers to the human and blocks on a 'no'", async () => {
  const h = makeHarness({
    fallback: "allow",
    ui: { confirm: async () => false, notify: () => {} },
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "curl http://x" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "curl *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("fetch");
  assert.equal(didRun(), false, "ask + 'no' blocks");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

test("ask passes on a 'yes'", async () => {
  const h = makeHarness({
    fallback: "allow",
    ui: { confirm: async () => true, notify: () => {} },
    responder: [{ toolCalls: [{ name: "bash", arguments: { command: "curl http://x" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "curl *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("fetch");
  assert.equal(didRun(), true, "ask + 'yes' passes");
  assert.equal(sawBlock(h.agent), false, "no bash-policy block reason");
});

test("ask remembers within a session and re-prompts after session_start", async () => {
  let confirms = 0;
  const h = makeHarness({
    fallback: "allow",
    ui: {
      confirm: async () => {
        confirms++;
        return true;
      },
      notify: () => {},
    },
    responder: [
      { toolCalls: [{ name: "bash", arguments: { command: "curl http://a" } }] },
      { toolCalls: [{ name: "bash", arguments: { command: "curl http://b" } }] },
      { text: "done" },
    ],
  });
  shellTool(h.agent);
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "curl *", action: "ask" }]);
    return bashPolicy(e);
  });

  await h.agent.run("two curls");
  assert.equal(confirms, 1, "the affirmative is remembered prefix-wise for the session");

  await h.agent.hooks.emit("session_start", {});

  h.provider.script([{ toolCalls: [{ name: "bash", arguments: { command: "curl http://c" } }] }, { text: "done" }]);
  await h.agent.run("another curl after reset");
  assert.equal(confirms, 2, "remember cleared on session_start, so confirm is asked again");
});

test("capability fidelity: a shell:exec tool named other than bash is gated", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "sh", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
  });
  const didRun = shellTool(h.agent, "sh");
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
    return bashPolicy(e);
  });

  await h.agent.run("clean up");
  assert.equal(didRun(), false, "matching is on the declared capability, not the tool name");
  assert.equal(sawBlock(h.agent), true, "the model sees the bash-policy block reason");
});

test("EAGENT_BASH_POLICY=off disables the guard", async () => {
  const prev = process.env.EAGENT_BASH_POLICY;
  process.env.EAGENT_BASH_POLICY = "off";
  try {
    const h = makeHarness({
      fallback: "allow",
      responder: [{ toolCalls: [{ name: "bash", arguments: { command: "rm -rf build" } }] }, { text: "done" }],
    });
    const didRun = shellTool(h.agent);
    await h.host.use("bash-policy", (e) => {
      e.store.set("rules", [{ pattern: "rm *", action: "deny" }]);
      return bashPolicy(e);
    });

    await h.agent.run("clean up");
    assert.equal(didRun(), true, "the kill switch disables blocking");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_BASH_POLICY;
    else process.env.EAGENT_BASH_POLICY = prev;
  }
});
