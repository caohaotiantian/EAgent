/**
 * Pure wireObjectToSourceEvent mapper (design 2026-07-27-web-frontend AC4).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { wireObjectToSourceEvent } from "../src/wire-events.js";

const ctx = { session: "s1", at: 42 };

test("text_delta / reasoning_delta tag with session actingId", () => {
  const t = wireObjectToSourceEvent({ type: "text_delta", text: "hi" }, ctx);
  assert.deepEqual(t, {
    kind: "text_delta",
    text: "hi",
    actingId: "s1",
    rootId: "s1",
    at: 42,
  });
  const r = wireObjectToSourceEvent({ type: "reasoning_delta", text: "think" }, ctx);
  assert.equal(r?.kind, "reasoning_delta");
  if (r?.kind === "reasoning_delta") assert.equal(r.text, "think");
});

test("tool_start / tool_end map call and result", () => {
  const start = wireObjectToSourceEvent(
    { type: "tool_start", id: "c1", name: "bash", arguments: { cmd: "ls" } },
    ctx,
  );
  assert.equal(start?.kind, "tool_start");
  if (start?.kind === "tool_start") {
    assert.equal(start.call.id, "c1");
    assert.deepEqual(start.call.arguments, { cmd: "ls" });
  }
  const end = wireObjectToSourceEvent(
    { type: "tool_end", id: "c1", name: "bash", content: "out", isError: false },
    ctx,
  );
  assert.equal(end?.kind, "tool_end");
  if (end?.kind === "tool_end") {
    assert.equal(end.result.content, "out");
    assert.equal(end.result.isError, false);
  }
});

test("agent_end / usage / error / action_required", () => {
  const end = wireObjectToSourceEvent({ type: "agent_end", reason: "end_turn" }, ctx);
  assert.equal(end?.kind, "agent_end");
  const usage = wireObjectToSourceEvent(
    {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 2 },
      cumulative: { inputTokens: 3, outputTokens: 4 },
    },
    ctx,
  );
  assert.equal(usage?.kind, "usage");
  const err = wireObjectToSourceEvent({ type: "error", where: "x", message: "m" }, ctx);
  assert.deepEqual(err, { kind: "error", where: "x", message: "m" });
  const ask = wireObjectToSourceEvent(
    { type: "action_required", id: 7, question: "OK?", options: ["y", "n"] },
    ctx,
  );
  assert.deepEqual(ask, {
    kind: "action_required",
    id: 7,
    question: "OK?",
    options: ["y", "n"],
  });
});

test("unknown type returns undefined", () => {
  assert.equal(wireObjectToSourceEvent({ type: "nope" }, ctx), undefined);
});
