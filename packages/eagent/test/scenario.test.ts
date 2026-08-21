/**
 * An end-to-end scenario: the agent drives the real core-tools through several
 * turns — write a file, read it back, edit it — proving the whole pipeline
 * (loop → guarded dispatch → capability check → tool execute → result feedback)
 * works together against actual files, not just in isolation.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";

import coreTools from "../src/extensions/core-tools.ts";
import type { CompletionRequest } from "../src/kernel/types.ts";
import { makeHarness, lastText } from "./helpers.ts";

const WORKSPACE = mkdtempSync(join(tmpdir(), "eagent-scenario-"));

before(() => {
  process.env.EAGENT_WORKSPACE = WORKSPACE;
});

test("write -> read -> edit across turns produces the right file and transcript", async () => {
  // The model script: each turn issues one tool call, then a final answer.
  const responder = (_req: CompletionRequest, turn: number) => {
    switch (turn) {
      case 0:
        return { toolCalls: [{ name: "write", arguments: { path: "story.txt", content: "the quick brown fox" } }] };
      case 1:
        return { toolCalls: [{ name: "read", arguments: { path: "story.txt" } }] };
      case 2:
        return { toolCalls: [{ name: "edit", arguments: { path: "story.txt", old: "brown", new: "red" } }] };
      default:
        return { text: "Done: changed brown to red." };
    }
  };

  const { agent, host } = makeHarness({ responder, fallback: "allow" });
  await host.use("core-tools", coreTools);

  const { reason } = await agent.run("make a story file and tweak it");
  assert.equal(reason, "end_turn");
  assert.equal(lastText(agent), "Done: changed brown to red.");

  // The file on disk reflects the write + edit.
  assert.equal(readFileSync(join(WORKSPACE, "story.txt"), "utf8"), "the quick red fox");

  // The transcript carried three successful tool results in order.
  const toolResults = agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result");
  assert.equal(toolResults.length, 3);
  assert.ok(toolResults.every((r) => !(r as { isError?: boolean }).isError), "no tool errors");
  // The read returned the originally-written content.
  assert.match((toolResults[1] as { content: string }).content, /quick brown fox/);
});
