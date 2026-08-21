/**
 * Security regression: secret-guard still holds a leak-capable call whose args
 * carry a secret value, on the `beforeToolCall` seam, and never echoes the
 * literal value into its reason.
 *
 * Offline through the agent loop via `makeHarness` + `host.use`, for parity with
 * the sibling regression tests (bash-policy/flow-guard/write-guard all drive the
 * attack through `agent.run` rather than applying the hook directly). Asserts the
 * defining action: in block mode the leak-capable tool does NOT run, the model
 * sees a `secret-guard:` reason, and the literal secret value never appears in
 * the transcript.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent } from "../../src/kernel/agent.ts";
import secretGuard from "../../src/extensions/secret-guard.ts";
import { defineTool } from "../../src/kernel/define.ts";
import { makeHarness } from "../helpers.ts";

/** A representative secret literal: `sk-` + 20 chars satisfies the openai shape. */
const SK = "sk-" + "a".repeat(20);

/** Register a leak-capable `net:fetch` tool, exposing whether it ran. */
function postTool(agent: Agent): () => boolean {
  let sent = false;
  agent.tools.register(
    defineTool({
      name: "post",
      description: "Send an HTTP request.",
      capabilities: ["net:fetch"],
      execute: () => {
        sent = true;
        return { content: "ok" };
      },
    }),
  );
  return () => sent;
}

test("secret-guard blocks a net:fetch call whose args leak a secret (block mode)", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "post", arguments: { headers: ["Authorization: Bearer " + SK] } }] },
      { text: "done" },
    ],
  });
  const didPost = postTool(h.agent);
  await h.host.use("secret-guard", (e) => {
    e.store.set("enabled", true);
    e.store.set("mode", "block");
    return secretGuard(e);
  });

  await h.agent.run("send the auth header out");

  assert.equal(didPost(), false, "a secret in a leak-capable tool's args is held — the call never runs");

  const reasons = h.agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content.filter((b) => b.type === "tool_result").map((b) => b.content))
    .filter((r) => /secret-guard:/.test(r));
  assert.ok(reasons.length > 0, "the model sees a secret-guard block reason");
  assert.ok(
    reasons.every((r) => /sk-|openai/.test(r)),
    "the reason names the secret kind (sk-/openai)",
  );
  // The guard's own reason must name the kind without echoing the literal value.
  assert.ok(reasons.every((r) => !r.includes(SK)), "the literal secret value never appears in a guard reason");
});
