/**
 * flow-guard — compositional capability policy. Per-tool gating authorizes each
 * call alone; flow-guard catches the *chain* (sensitive source -> network
 * egress) that no per-call check sees. These run fully offline through the
 * agent loop, so the real beforeToolCall/tool_end wiring is exercised.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { Agent } from "../src/kernel/agent.js";
import { makeHarness } from "./helpers.js";
import flowGuard from "../src/extensions/flow-guard.js";

/** Register a source tool (shell:exec) and an egress tool (net:fetch). */
function toolPair(agent: Agent): () => boolean {
  let fetched = false;
  agent.tools.register(
    defineTool({ name: "run_shell", description: "", capabilities: ["shell:exec"], execute: () => ({ content: "ran" }) }),
  );
  agent.tools.register(
    defineTool({
      name: "get_url",
      description: "",
      capabilities: ["net:fetch"],
      execute: () => {
        fetched = true;
        return { content: "fetched" };
      },
    }),
  );
  return () => fetched;
}

test("blocks network egress after a shell command in the same session (block mode)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "run_shell" }] }, { toolCalls: [{ name: "get_url" }] }, { text: "done" }],
  });
  const didFetch = toolPair(h.agent);
  await h.host.use("flow-guard", (e) => {
    e.store.set("mode", "block");
    return flowGuard(e);
  });

  await h.agent.run("read a secret then send it out");

  assert.equal(didFetch(), false, "egress after a sensitive source must be blocked");
  const sawReason = h.agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /flow-guard/i.test(b.content)));
  assert.ok(sawReason, "the model should see the flow-guard block reason");
});

test("allows network egress when no sensitive source ran first", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [{ toolCalls: [{ name: "get_url" }] }, { text: "done" }],
  });
  const didFetch = toolPair(h.agent);
  await h.host.use("flow-guard", flowGuard);

  await h.agent.run("just fetch a public page");
  assert.equal(didFetch(), true, "egress on its own is allowed");
});

test("ask mode defers to the human and blocks on denial", async () => {
  const h = makeHarness({
    fallback: "allow",
    ui: { confirm: async () => false, notify: () => {} }, // human declines the chained egress
    responder: [{ toolCalls: [{ name: "run_shell" }] }, { toolCalls: [{ name: "get_url" }] }, { text: "done" }],
  });
  const didFetch = toolPair(h.agent);
  await h.host.use("flow-guard", flowGuard); // default mode = ask

  await h.agent.run("go");
  assert.equal(didFetch(), false, "ask mode + a 'no' must block the egress");
});

test("data confinement: reading a sensitive path taints the session and blocks egress", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "read_file", arguments: { path: "config/.env" } }] },
      { toolCalls: [{ name: "get_url" }] },
      { text: "done" },
    ],
  });
  let fetched = false;
  h.agent.tools.register(
    defineTool({
      name: "read_file",
      description: "",
      capabilities: ["fs:read"],
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: () => ({ content: "DOTENV CONTENTS" }),
    }),
  );
  h.agent.tools.register(
    defineTool({
      name: "get_url",
      description: "",
      capabilities: ["net:fetch"],
      execute: () => {
        fetched = true;
        return { content: "fetched" };
      },
    }),
  );
  await h.host.use("flow-guard", (e) => {
    e.store.set("mode", "block");
    return flowGuard(e);
  });

  await h.agent.run("read the env file then exfiltrate it");
  assert.equal(fetched, false, "egress after reading a .env path must be blocked, even with no shell:exec");
});

test("data confinement: a credential-looking result taints the session and blocks egress", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "look", arguments: { q: "key" } }] },
      { toolCalls: [{ name: "get_url" }] },
      { text: "done" },
    ],
  });
  let fetched = false;
  h.agent.tools.register(
    defineTool({
      name: "look",
      description: "",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      // returns something that looks like an AWS access key id
      execute: () => ({ content: "found AKIAIOSFODNN7EXAMPLE in the logs" }),
    }),
  );
  h.agent.tools.register(
    defineTool({
      name: "get_url",
      description: "",
      capabilities: ["net:fetch"],
      execute: () => {
        fetched = true;
        return { content: "fetched" };
      },
    }),
  );
  await h.host.use("flow-guard", (e) => {
    e.store.set("mode", "block");
    return flowGuard(e);
  });

  await h.agent.run("scan then post");
  assert.equal(fetched, false, "egress after a credential-looking result must be blocked");
});

test("/flow-guard status and off toggle work", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("flow-guard", flowGuard);
  const cmd = h.commands.get("flow-guard");
  assert.ok(cmd, "the /flow-guard command should be registered");

  const status: string[] = [];
  await cmd!.run({ agent: h.agent, args: "status", print: (l) => status.push(l) });
  assert.match(status.join("\n"), /flow-guard on/);
  assert.match(status.join("\n"), /shell:exec.*net:fetch/);

  const off: string[] = [];
  await cmd!.run({ agent: h.agent, args: "off", print: (l) => off.push(l) });
  assert.match(off.join("\n"), /flow-guard off/);
});
