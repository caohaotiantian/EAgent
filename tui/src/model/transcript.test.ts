/**
 * The transcript reducer (AC10).
 *
 * Pure and offline: no Ink, no React, no agent. These assertions are the real
 * contract of the display — ordering, sub-agent attribution, and the
 * committed/live split that makes Ink's `<Static>` safe.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  argSummary,
  initialState,
  partition,
  reduce,
  type Item,
  type TranscriptEvent,
  type TranscriptState,
} from "./transcript.js";

const ROOT = "root";
let clock = 0;

/** Fold a sequence of events as the root agent unless one names its own actor. */
function fold(events: (TranscriptEvent | (TranscriptEvent & { actingId: string }))[]): TranscriptState {
  clock = 0;
  return events.reduce<TranscriptState>(
    (s, e) => reduce(s, { actingId: ROOT, ...e, at: ++clock }),
    initialState(),
  );
}

const texts = (items: Item[]): string[] => items.map((i) => (i.kind === "tool" ? `tool:${i.name}` : i.text));

test("AC10: consecutive deltas of the same kind coalesce into one item", () => {
  const s = fold([{ kind: "text_delta", text: "Hel" }, { kind: "text_delta", text: "lo" }]);

  assert.equal(s.items.length, 1);
  assert.deepEqual(texts(s.items), ["Hello"]);
});

test("AC10: reasoning and answer are separate items, in arrival order", () => {
  const s = fold([
    { kind: "reasoning_delta", text: "thinking" },
    { kind: "text_delta", text: "answer" },
    { kind: "reasoning_delta", text: "more thought" },
  ]);

  assert.deepEqual(s.items.map((i) => i.kind), ["reasoning", "answer", "reasoning"]);
  assert.deepEqual(texts(s.items), ["thinking", "answer", "more thought"]);
});

test("AC10: a tool call closes the open text item and opens a card", () => {
  const s = fold([
    { kind: "text_delta", text: "let me look" },
    { kind: "tool_start", callId: "c1", name: "read", arguments: { file: "a.ts" } },
  ]);

  assert.deepEqual(s.items.map((i) => i.kind), ["answer", "tool"]);
  assert.equal(s.items[0]?.status, "done", "the text item was closed, not left streaming");
  assert.equal(s.items[1]?.status, "streaming");
});

test("AC10: text after a tool call starts a NEW item rather than reopening the old one", () => {
  const s = fold([
    { kind: "text_delta", text: "before" },
    { kind: "tool_start", callId: "c1", name: "read", arguments: {} },
    { kind: "tool_end", callId: "c1", content: "ok", isError: false },
    { kind: "text_delta", text: "after" },
  ]);

  assert.deepEqual(texts(s.items), ["before", "tool:read", "after"]);
});

test("AC10: progress chunks accumulate on their own card", () => {
  const s = fold([
    { kind: "tool_start", callId: "c1", name: "bash", arguments: { command: "make" } },
    { kind: "tool_start", callId: "c2", name: "bash", arguments: { command: "test" } },
    { kind: "tool_progress", callId: "c1", chunk: "compiling\n" },
    { kind: "tool_progress", callId: "c2", chunk: "running\n" },
    { kind: "tool_progress", callId: "c1", chunk: "linking\n" },
  ]);

  const [a, b] = s.items;
  assert.equal(a?.kind === "tool" && a.progress, "compiling\nlinking\n");
  assert.equal(b?.kind === "tool" && b.progress, "running\n");
});

test("progress for an unknown call is ignored, not a crash", () => {
  const s = fold([{ kind: "tool_progress", callId: "nope", chunk: "x" }]);

  assert.deepEqual(s.items, []);
});

test("AC10: tool_end records the full result and marks an error", () => {
  const s = fold([
    { kind: "tool_start", callId: "c1", name: "bash", arguments: {} },
    { kind: "tool_end", callId: "c1", content: "boom", isError: true },
  ]);

  const card = s.items[0];
  assert.equal(card?.status, "error");
  assert.equal(card?.kind === "tool" && card.result?.content, "boom");
});

test("AC10: a sub-agent's text is a separate item, attributed to it", () => {
  const s = fold([
    { kind: "text_delta", text: "root says" },
    { kind: "text_delta", text: "child says", actingId: "child" },
    { kind: "text_delta", text: " more", actingId: "child" },
  ]);

  assert.equal(s.items.length, 2, "the child never merges into the root's item");
  assert.equal(s.items[0]?.actingId, ROOT);
  assert.equal(s.items[1]?.actingId, "child");
  assert.deepEqual(texts(s.items), ["root says", "child says more"]);
});

test("agent_end closes every streaming item and stops the spinner", () => {
  const s = fold([
    { kind: "agent_start" },
    { kind: "text_delta", text: "partial" },
    { kind: "tool_start", callId: "c1", name: "read", arguments: {} },
    { kind: "agent_end", reason: "end_turn" },
  ]);

  assert.equal(s.running, false);
  assert.ok(s.items.every((i) => i.status !== "streaming"), "nothing is left streaming");
});

test("agent_start marks running and bumps the run counter", () => {
  const s = fold([{ kind: "agent_start" }]);

  assert.equal(s.running, true);
  assert.equal(s.run, 1);
});

test("a user turn is recorded as a finished item immediately", () => {
  const s = fold([{ kind: "user", text: "hello" }]);

  assert.equal(s.items[0]?.kind, "user");
  assert.equal(s.items[0]?.status, "done");
});

test("usage updates the running token total", () => {
  const s = fold([{ kind: "usage", total: 1234 }]);

  assert.equal(s.tokens, 1234);
});

// -- the <Static> invariant --------------------------------------------------

test("AC10: while a turn runs, the whole turn is the live tail", () => {
  const s = fold([
    { kind: "user", text: "go" },
    { kind: "agent_start" },
    { kind: "text_delta", text: "working" },
  ]);

  const { committed, live } = partition(s);
  assert.deepEqual(texts(committed), [], "nothing from this turn has been finalised");
  assert.deepEqual(texts(live), ["go", "working"], "so all of it can still repaint");
});

test("AC10: a finished turn commits, and the next turn is live on its own", () => {
  const first = fold([
    { kind: "user", text: "one" },
    { kind: "agent_start" },
    { kind: "text_delta", text: "answer one" },
    { kind: "agent_end", reason: "end_turn" },
  ]);
  const second = [
    { kind: "user" as const, text: "two" },
    { kind: "agent_start" as const },
    { kind: "text_delta" as const, text: "answer two" },
  ].reduce((s, e) => reduce(s, { actingId: ROOT, ...e, at: ++clock }), first);

  const { committed, live } = partition(second);
  assert.deepEqual(texts(committed), ["one", "answer one"], "the finished turn is in scrollback");
  assert.deepEqual(texts(live), ["two", "answer two"], "the new turn repaints");
});

test("AC10: with nothing streaming the whole transcript is committed", () => {
  const s = fold([
    { kind: "user", text: "go" },
    { kind: "text_delta", text: "done" },
    { kind: "agent_end", reason: "end_turn" },
  ]);

  const { committed, live } = partition(s);
  assert.equal(live.length, 0);
  assert.equal(committed.length, 2);
});

test("AC10: a committed item never returns to the live tail", () => {
  // The invariant <Static> depends on: once an item is behind the streaming
  // boundary, no later event may move it back.
  const events: TranscriptEvent[] = [
    { kind: "user", text: "go" },
    { kind: "text_delta", text: "a" },
    { kind: "tool_start", callId: "c1", name: "read", arguments: {} },
    { kind: "tool_end", callId: "c1", content: "ok", isError: false },
    { kind: "text_delta", text: "b" },
    { kind: "agent_end", reason: "end_turn" },
  ];

  let state = initialState();
  const everCommitted = new Set<string>();
  let at = 0;
  for (const e of events) {
    state = reduce(state, { actingId: ROOT, ...e, at: ++at });
    const { committed, live } = partition(state);
    for (const item of committed) everCommitted.add(item.id);
    for (const item of live) {
      assert.ok(!everCommitted.has(item.id), `item ${item.id} went back to the live tail`);
    }
  }
});

test("AC10: unchanged items keep their identity across a reduce", () => {
  // What lets a renderer skip repainting finished work.
  const first = fold([{ kind: "user", text: "go" }]);
  const second = reduce(first, { kind: "text_delta", text: "x", actingId: ROOT, at: 99 });

  assert.equal(second.items[0], first.items[0], "the finished user item is the same object");
  assert.notEqual(second.items, first.items, "but the array itself is new");
});

// -- formatting helpers ------------------------------------------------------

test("argSummary is bounded, single-line, and survives odd values", () => {
  assert.equal(argSummary({ file: "a.ts" }), "file=a.ts");
  assert.equal(argSummary({ cmd: "a\nb" }), "cmd=a b", "newlines collapse");
  assert.equal(argSummary({}), "");

  const long = argSummary({ p: "x".repeat(300) });
  assert.ok(long.length <= 60);
  assert.ok(long.endsWith("…"));

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => argSummary({ circular }));
  assert.doesNotThrow(() => argSummary({ big: 1n }));
});
