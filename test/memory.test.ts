/**
 * Tests for the memory extension: the `transformContext` compaction seam, its
 * caching, the manual commands, and the remember/recall scratchpad.
 *
 * The mock provider's FUNCTION responder is the instrument: it records every
 * `req.messages` it is handed (so we can inspect the exact context the model
 * would have seen) and branches on the summarization system prompt to return a
 * canned summary — separating "real" turns from the nested summarization call.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import activate from "../src/extensions/memory.js";
import type { CompletionRequest, Message } from "../src/kernel/types.js";
import { text } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

/** Robustly detect our summarization sub-call by its dedicated system prompt. */
function isSummarizeReq(req: CompletionRequest): boolean {
  return /summar/i.test(req.systemPrompt);
}

interface Recorder {
  /** Context handed to every NON-summarization (real) provider call. */
  realCalls: Message[][];
  /** Number of summarization sub-calls made. */
  summarizeCalls: number;
}

/**
 * Build a function responder that records what it sees and returns a canned
 * summary for summarization calls, "ok N" otherwise.
 */
function makeResponder(rec: Recorder) {
  return (req: CompletionRequest) => {
    if (isSummarizeReq(req)) {
      rec.summarizeCalls++;
      return { text: "SUMMARY: folded prefix" };
    }
    rec.realCalls.push(req.messages.map((m) => structuredClone(m)));
    return { text: `ok ${rec.realCalls.length}` };
  };
}

function freshRecorder(): Recorder {
  return { realCalls: [], summarizeCalls: 0 };
}

/** Seed N user/assistant message pairs into the transcript without running. */
function seedPairs(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i++) {
    out.push(text("user", `q${i}`));
    out.push(text("assistant", `a${i}`));
  }
  return out;
}

test("below threshold: context is not compacted", async () => {
  const rec = freshRecorder();
  const { agent, host } = makeHarness({ responder: makeResponder(rec), fallback: "allow" });
  await host.use("memory", activate);

  await agent.run("hi 1");
  await agent.run("hi 2");

  // Every real call's context must be the verbatim history — no summary.
  for (const ctx of rec.realCalls) {
    assert.ok(ctx.length > 0);
    const hasSummary = ctx.some((m) => m.meta?.source === "memory");
    assert.equal(hasSummary, false, "no summary system message below threshold");
  }
  // Last real context should be plain user/assistant messages.
  const last = rec.realCalls.at(-1)!;
  assert.equal(last[0]!.role, "user");
  assert.equal(rec.summarizeCalls, 0, "no summarization below threshold");
});

test("above threshold: context is compacted into a summary + recent tail", async () => {
  const rec = freshRecorder();
  const { agent, host } = makeHarness({ responder: makeResponder(rec), fallback: "allow" });
  await host.use("memory", activate);

  // Seed well past the default threshold (12) so the next run triggers it.
  agent.load(seedPairs(10)); // 20 messages
  await agent.run("trigger");

  const triggered = rec.realCalls.at(-1)!;
  const keepRecent = 4;
  // Compacted shape: one summary + keepRecent recent messages.
  assert.equal(triggered.length, 1 + keepRecent, "summary plus recent tail");

  const head = triggered[0]!;
  assert.equal(head.role, "system");
  assert.equal(head.meta?.source, "memory");
  assert.equal(head.meta?.kind, "summary");
  const headText = head.content.find((b) => b.type === "text");
  assert.ok(headText && headText.type === "text" && headText.text.includes("SUMMARY"));

  assert.ok(rec.summarizeCalls >= 1, "summarization happened");
});

test("caching: an unchanged prefix is not re-summarized every turn", async () => {
  const rec = freshRecorder();
  const { agent, host } = makeHarness({ responder: makeResponder(rec), fallback: "allow" });
  await host.use("memory", activate);

  agent.load(seedPairs(10)); // 20 messages, over threshold
  await agent.run("t1");
  const afterFirst = rec.summarizeCalls;
  assert.ok(afterFirst >= 1, "first compaction summarizes");

  // A single further run adds only user+assistant (2 msgs) < keepRecent(4)
  // beyond the covered prefix on the very next call, so the cache is reused.
  await agent.run("t2");
  assert.equal(
    rec.summarizeCalls,
    afterFirst,
    "cached summary reused for an unchanged-enough prefix",
  );

  // Even so, the compacted context is still summary + recent tail.
  const lastCtx = rec.realCalls.at(-1)!;
  assert.equal(lastCtx[0]!.meta?.source, "memory");
});

test("remember/recall round-trips a note", async () => {
  const rec = freshRecorder();
  // Script: turn 1 calls remember, turn 2 calls recall, turn 3 plain text.
  let turn = 0;
  const responder = (req: CompletionRequest) => {
    if (isSummarizeReq(req)) {
      rec.summarizeCalls++;
      return { text: "SUMMARY" };
    }
    turn++;
    if (turn === 1) {
      return { toolCalls: [{ name: "remember", arguments: { key: "color", value: "blue" } }] };
    }
    if (turn === 2) {
      return { toolCalls: [{ name: "recall", arguments: { key: "color" } }] };
    }
    return { text: "done" };
  };
  const { agent, host } = makeHarness({ responder, fallback: "allow" });
  await host.use("memory", activate);

  await agent.run("remember my color then recall it");

  // Find the tool result message carrying recall's answer.
  const toolResults = agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result");
  const recalled = toolResults.find((b) => b.type === "tool_result" && b.content === "blue");
  assert.ok(recalled, "recall returned the stored value");
});

test("compaction does not mutate the persistent transcript", async () => {
  const rec = freshRecorder();
  const { agent, host } = makeHarness({ responder: makeResponder(rec), fallback: "allow" });
  await host.use("memory", activate);

  agent.load(seedPairs(10)); // 20 messages
  const before = agent.messages.length;
  await agent.run("trigger");

  // The transcript grew only by the real run's messages, never shrank, and
  // contains NO injected summary system message.
  assert.ok(agent.messages.length >= before + 1);
  const hasSummary = agent.messages.some((m) => m.meta?.source === "memory");
  assert.equal(hasSummary, false, "transcript untouched by compaction");
  // The original seeded messages are still present, in order.
  assert.equal(agent.messages[0]!.content[0]!.type, "text");
  const first = agent.messages[0]!.content[0]!;
  assert.ok(first.type === "text" && first.text === "q0");
});
