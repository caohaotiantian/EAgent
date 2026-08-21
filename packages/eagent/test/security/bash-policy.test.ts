/**
 * Security regression: bash-policy still denies a destructive shell command
 * against an `rm *` deny rule, through the agent loop on `beforeToolCall`.
 *
 * Offline via `makeHarness` + `host.use`; reuses the attack shape from
 * `test/bash-policy.test.ts:210-224`. Asserts the defining action: the shell
 * tool does NOT run and the model sees the bash-policy block reason. Also pins
 * the pure `evaluate` deny on the same command for an unambiguous unit-level
 * regression.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../../src/kernel/define.ts";
import type { Agent } from "../../src/kernel/agent.ts";
import { makeHarness } from "../helpers.ts";
import bashPolicy, { evaluate, type Rule } from "../../src/extensions/bash-policy.ts";

/** Register a shell:exec tool whose execute flips a flag, so blocking is observable. */
function shellTool(agent: Agent): () => boolean {
  let ran = false;
  agent.tools.register(
    defineTool({
      name: "bash",
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

test("bash-policy: evaluate denies rm -rf under an rm * deny rule", () => {
  const rules: Rule[] = [{ pattern: "rm *", action: "deny" }];
  assert.equal(evaluate("rm -rf build", rules, "allow"), "deny");
});

test("bash-policy blocks rm -rf build through the loop under an rm * deny rule", async () => {
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
  const sawBlock = h.agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /bash-policy: /.test(b.content)));
  assert.ok(sawBlock, "the model sees the bash-policy block reason");
});
