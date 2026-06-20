/**
 * Tests for the prune extension: the token-budget tool-output trimmer on the
 * `transformContext` seam.
 *
 * The pure `pruneMessages` function is exercised directly (the boundary and
 * purity invariants), and the extension is exercised through the harness for
 * registration and the provider-free hot-path budget.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import prune, { pruneMessages } from "../src/extensions/prune.js";
import type { Message, ToolResultBlock } from "../src/kernel/types.js";
import { text } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness } from "./helpers.js";

const TOOL_OUTPUT_MAX_CHARS = 2000;

function userMsg(s: string): Message {
  return text("user", s);
}

function assistantMsg(s: string): Message {
  return text("assistant", s);
}

function toolMsg(id: string, n: number): Message {
  return { role: "tool", content: [{ type: "tool_result", toolCallId: id, content: "x".repeat(n) }] };
}

/** Every `tool_result` block in a message list, in order. */
function toolResults(messages: Message[]): ToolResultBlock[] {
  return messages
    .flatMap((m) => m.content)
    .filter((b): b is ToolResultBlock => b.type === "tool_result");
}

/** The single `tool_result` block carrying a given toolCallId. */
function resultFor(messages: Message[], id: string): ToolResultBlock {
  const block = toolResults(messages).find((b) => b.toolCallId === id);
  assert.ok(block, `expected a tool_result for "${id}"`);
  return block;
}

test("AC-2: no-op below budget", () => {
  // One eligible tool output of exactly 40000 tokens (total === PRUNE_PROTECT,
  // kept), then two user turns forming the protected recency window.
  const input: Message[] = [
    userMsg("q0"),
    toolMsg("A", 4 * 40000),
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const out = pruneMessages(input);
  for (const block of toolResults(out)) {
    assert.equal(block.content.length, 4 * 40000);
  }
});

test("AC-3: prune over budget", () => {
  // Eligible region, chronological (oldest first) so A is the newest eligible
  // output, nearest the recency boundary, and E the oldest.
  const input: Message[] = [
    toolMsg("E", 4 * 8000),
    toolMsg("D", 4 * 8000),
    toolMsg("C", 4 * 8000),
    toolMsg("B", 4 * 8000),
    toolMsg("A", 4 * 30000),
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const out = pruneMessages(input);

  // A (total 30000) and B (total 38000) stay byte-for-byte verbatim.
  assert.equal(resultFor(out, "A").content.length, 4 * 30000);
  assert.equal(resultFor(out, "B").content.length, 4 * 8000);

  // C, D, E (totals 46000/54000/62000) are truncated; pruned = 24000 > 20000.
  for (const id of ["C", "D", "E"]) {
    const block = resultFor(out, id);
    assert.ok(block.content.length <= TOOL_OUTPUT_MAX_CHARS + 64);
    assert.match(block.content, /pruned \d+ chars/);
  }
});

test("AC-4: recency protection", () => {
  // AC-3's over-budget eligible region, plus an even larger output placed after
  // the second-most-recent user message (inside the protected window).
  const input: Message[] = [
    toolMsg("E", 4 * 8000),
    toolMsg("D", 4 * 8000),
    toolMsg("C", 4 * 8000),
    toolMsg("B", 4 * 8000),
    toolMsg("A", 4 * 30000),
    userMsg("q1"),
    toolMsg("R", 4 * 60000),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const out = pruneMessages(input);
  assert.equal(resultFor(out, "R").content.length, 4 * 60000);
});

test("AC-5: summary boundary", () => {
  // Over-budget oversized outputs before a summary message: the backward walk
  // breaks at the summary, so they are never reached or truncated.
  const summary: Message = {
    role: "system",
    content: [{ type: "text", text: "summary" }],
    meta: { kind: "summary" },
  };
  const input: Message[] = [
    toolMsg("E", 4 * 8000),
    toolMsg("D", 4 * 8000),
    toolMsg("C", 4 * 8000),
    toolMsg("B", 4 * 8000),
    toolMsg("A", 4 * 30000),
    summary,
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const out = pruneMessages(input);
  for (const id of ["A", "B", "C", "D", "E"]) {
    const expected = id === "A" ? 4 * 30000 : 4 * 8000;
    assert.equal(resultFor(out, id).content.length, expected);
  }
});

test("AC-6: below-minimum no-op", () => {
  // Kept block of 38000 tokens then one oversized crossing block of 5000 tokens
  // (total 43000 > 40000, pruned 5000). 5000 is not > 20000, so nothing is cut.
  const input: Message[] = [
    toolMsg("X", 4 * 5000),
    toolMsg("H", 4 * 38000),
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const out = pruneMessages(input);
  assert.equal(resultFor(out, "H").content.length, 4 * 38000);
  assert.equal(resultFor(out, "X").content.length, 4 * 5000);
});

test("AC-7: transcript purity", () => {
  const input: Message[] = [
    toolMsg("E", 4 * 8000),
    toolMsg("D", 4 * 8000),
    toolMsg("C", 4 * 8000),
    toolMsg("B", 4 * 8000),
    toolMsg("A", 4 * 30000),
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const snapshotMsgs = [...input];
  const snapshotContents = toolResults(input).map((b) => ({ block: b, content: b.content }));

  const out = pruneMessages(input);

  // The input array, each Message object, and each tool_result string are
  // unchanged; the returned array is a different reference.
  assert.notEqual(out, input);
  assert.equal(input.length, snapshotMsgs.length);
  for (let i = 0; i < input.length; i++) assert.equal(input[i], snapshotMsgs[i]);
  for (const { block, content } of snapshotContents) assert.equal(block.content, content);
});

test("AC-8b: synchronous hot path", () => {
  const input: Message[] = [
    toolMsg("E", 4 * 8000),
    toolMsg("D", 4 * 8000),
    toolMsg("C", 4 * 8000),
    toolMsg("B", 4 * 8000),
    toolMsg("A", 4 * 30000),
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const r = pruneMessages(input);
  assert.ok(Array.isArray(r));
  assert.equal(typeof (r as { then?: unknown }).then, "undefined");
});

test("AC-9: kill switch", () => {
  const input: Message[] = [
    toolMsg("E", 4 * 8000),
    toolMsg("D", 4 * 8000),
    toolMsg("C", 4 * 8000),
    toolMsg("B", 4 * 8000),
    toolMsg("A", 4 * 30000),
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ];
  const saved = process.env.EAGENT_PRUNE;
  process.env.EAGENT_PRUNE = "off";
  try {
    const out = pruneMessages(input);
    for (const id of ["A", "B", "C", "D", "E"]) {
      const expected = id === "A" ? 4 * 30000 : 4 * 8000;
      assert.equal(resultFor(out, id).content.length, expected);
    }
  } finally {
    if (saved === undefined) delete process.env.EAGENT_PRUNE;
    else process.env.EAGENT_PRUNE = saved;
  }
});

test("AC-1: registration adds one transformContext filter, no tool or command", async () => {
  const h = makeHarness();
  const toolsBefore = h.agent.tools.list().length;
  const commandsBefore = h.commands.list().length;
  const hooksBefore = h.agent.hooks.listenerCount("transformContext");

  await h.host.use("prune", prune);

  assert.equal(h.agent.tools.list().length, toolsBefore);
  assert.equal(h.commands.list().length, commandsBefore);
  assert.equal(h.agent.hooks.listenerCount("transformContext"), hooksBefore + 1);
});

test("AC-8a: provider-free under a real turn", async () => {
  class Counting extends MockProvider {
    calls = 0;
    override async *stream(req: Parameters<MockProvider["stream"]>[0]) {
      this.calls++;
      yield* super.stream(req);
    }
  }
  const h = makeHarness();
  const c = new Counting([{ text: "done" }]);
  h.agent.providers.register(c, { default: true });
  await h.host.use("prune", prune);

  h.agent.load([
    toolMsg("E", 4 * 8000),
    toolMsg("D", 4 * 8000),
    toolMsg("C", 4 * 8000),
    toolMsg("B", 4 * 8000),
    toolMsg("A", 4 * 30000),
    userMsg("q1"),
    assistantMsg("a1"),
    userMsg("q2"),
    assistantMsg("a2"),
  ]);
  await h.agent.run("go");

  assert.equal(c.calls, 1);
});
