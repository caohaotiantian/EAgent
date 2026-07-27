import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateFromMessages } from "./history.js";

test("hydrateFromMessages: user + assistant text becomes a turn and answer section", () => {
  const { turns, model } = hydrateFromMessages([
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.user, "hello");
  assert.equal(turns[0]!.sectionFrom, 0);
  assert.equal(model.sections.length, 1);
  assert.equal(model.sections[0]!.kind, "answer");
  if (model.sections[0]!.kind === "answer") assert.equal(model.sections[0]!.text, "hi there");
});

test("hydrateFromMessages: tool_call + tool_result pairs into a tool card", () => {
  const { model } = hydrateFromMessages([
    { role: "user", content: [{ type: "text", text: "ls" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "bash", arguments: { cmd: "ls" } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: "c1", content: "a.txt\n", isError: false }],
    },
  ]);
  const tool = model.sections.find((s) => s.kind === "tool");
  assert.ok(tool && tool.kind === "tool");
  if (tool && tool.kind === "tool") {
    assert.equal(tool.name, "bash");
    assert.equal(tool.status, "success");
    assert.equal(tool.result?.content, "a.txt\n");
    assert.deepEqual(tool.arguments, { cmd: "ls" });
  }
});

test("hydrateFromMessages: multi-turn sectionFrom ranges", () => {
  const { turns, model } = hydrateFromMessages([
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "assistant", content: [{ type: "text", text: "A" }] },
    { role: "user", content: [{ type: "text", text: "two" }] },
    { role: "assistant", content: [{ type: "text", text: "B" }, { type: "thinking", thinking: "why" }] },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.sectionFrom, 0);
  assert.equal(turns[1]!.sectionFrom, 1);
  assert.equal(model.sections.length, 3); // A, B, thinking
});
