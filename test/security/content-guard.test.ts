/**
 * Security regression: content-guard still sanitizes AND labels a foreign
 * (net:fetch-capable) tool result on `afterToolCall`. Unlike the four gating
 * guards, content-guard never blocks or asks (design §7 AC11 carves this out):
 * it strips invisible-Unicode injection and wraps the payload in the provenance
 * envelope.
 *
 * Offline through the agent loop via `makeHarness` + `host.use`; reuses the
 * attack shape from `test/content-guard.test.ts:123-143`. Asserts the defining
 * action: the model-visible content is fenced and carries no invisible codepoint.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Agent } from "../../src/kernel/agent.js";
import type { ExtensionAPI } from "../../src/kernel/extension.js";
import { defineTool, ok } from "../../src/kernel/define.js";
import { makeHarness } from "../helpers.js";
import contentGuard from "../../src/extensions/content-guard.js";

const FENCE_MARKER = "<untrusted-content";
// Any documented always-invisible injection codepoint.
const INVISIBLE = /[​-‍﻿‪-‮⁦-⁩\u{E0000}-\u{E007F}︀-️]/u;

/** The content of the first tool_result block the model would see. */
function firstResultContent(agent: Agent): string | undefined {
  const toolMsg = agent.messages.find((m) => m.role === "tool");
  const block = toolMsg?.content.find((b) => b.type === "tool_result");
  return block && block.type === "tool_result" ? block.content : undefined;
}

/** A stub net:fetch tool returning a body laced with invisible injection chars. */
function foreignTool(body: string) {
  return (e: ExtensionAPI): void => {
    e.grantCapability("net:fetch");
    e.registerTool(
      defineTool({
        name: "grab",
        description: "fetch a page",
        capabilities: ["net:fetch"],
        parameters: { type: "object", properties: {} },
        execute: () => ok(body),
      }),
    );
  };
}

test("content-guard sanitizes and labels a foreign payload with invisible injection", async () => {
  const zwsp = "​"; // zero-width space
  const zwj = "‍"; // zero-width joiner
  const bom = "﻿"; // BOM / zero-width no-break
  const rlo = "‮"; // right-to-left override (bidi control)
  const tag = String.fromCodePoint(0xe0041); // Plane-14 tag char
  const vs = "️"; // variation selector-16
  const body = `safe${zwsp}${zwj}${bom}${rlo}${tag}${vs}text`;

  const h = makeHarness();
  h.provider.script([{ toolCalls: [{ name: "grab", arguments: {} }] }, { text: "done" }]);
  await h.host.use("stub", foreignTool(body));
  await h.host.use("content-guard", contentGuard);

  await h.agent.run("go");

  const content = firstResultContent(h.agent) ?? "";
  // Labeled: wrapped in the provenance envelope, sourced to the producing tool.
  assert.ok(content.includes(FENCE_MARKER), "the foreign result is wrapped in the provenance envelope");
  assert.match(content, /<untrusted-content-[0-9a-f]+ source="grab">/, "fenced with a nonce'd tag and the producing tool's name as source");
  // Sanitized: the visible body survives contiguous, with no invisible codepoint.
  assert.ok(content.includes("safetext"), "the visible body survives, contiguous after stripping");
  assert.ok(!INVISIBLE.test(content), "no invisible injection codepoint remains in what the model sees");
});
