/**
 * Security regression: secret-guard still holds a leak-capable call whose args
 * carry a secret value, on the `beforeToolCall` seam, and never echoes the
 * literal value into its reason.
 *
 * Offline via `makeHarness` + `host.use`; reuses the attack shape from
 * `test/secret-guard.test.ts:159-168`. Asserts the defining action: the call is
 * blocked (block mode) and the secret value is absent from the reason.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import secretGuard from "../../src/extensions/secret-guard.js";
import { defineTool } from "../../src/kernel/define.js";
import { makeHarness } from "../helpers.js";

/** A representative secret literal: `sk-` + 20 chars satisfies the openai shape. */
const SK = "sk-" + "a".repeat(20);

test("secret-guard blocks a net:fetch call whose args leak a secret (block mode)", async () => {
  const h = makeHarness();
  h.agent.tools.register(
    defineTool({ name: "post", description: "Send an HTTP request.", capabilities: ["net:fetch"], execute: () => ({ content: "ok" }) }),
  );
  await h.host.use("secret-guard", (e) => {
    e.store.set("enabled", true);
    e.store.set("mode", "block");
    return secretGuard(e);
  });

  const out = await h.agent.hooks.apply(
    "beforeToolCall",
    { block: false, arguments: {} },
    { call: { type: "tool_call", id: "1", name: "post", arguments: { headers: ["Authorization: Bearer " + SK] } } },
  );

  assert.equal(out.block, true, "a secret in a leak-capable tool's args is held");
  assert.match(out.reason ?? "", /sk-|openai/, "the reason names the secret kind");
  assert.ok(!(out.reason ?? "").includes(SK), "the literal secret value never appears in the reason");
});
