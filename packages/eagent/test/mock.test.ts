import assert from "node:assert/strict";
import { test } from "node:test";

import type { CompletionRequest, StreamEvent } from "../src/kernel/types.ts";
import { MockProvider, type MockResponder } from "../src/providers/mock.ts";

function req(): CompletionRequest {
  return {
    systemPrompt: "be helpful",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    model: "mock",
    signal: new AbortController().signal,
  };
}

/** Drive the provider's stream directly and return the terminal `done` event. */
async function done(responder: MockResponder): Promise<Extract<StreamEvent, { type: "done" }>> {
  const provider = new MockProvider(responder);
  let final: Extract<StreamEvent, { type: "done" }> | undefined;
  for await (const ev of provider.stream(req())) {
    if (ev.type === "done") final = ev;
  }
  assert.ok(final, "stream must end with a done event");
  return final;
}

test("MockProvider yields a scripted terminal stopReason", async () => {
  const ev = await done({ text: "cut off", stopReason: "max_tokens" });
  assert.equal(ev.stopReason, "max_tokens");
});

test("MockProvider infers end_turn when no stopReason and no toolCalls (regression pin)", async () => {
  const ev = await done({ text: "all done" });
  assert.equal(ev.stopReason, "end_turn");
});

test("MockProvider infers tool_use when no stopReason but toolCalls present (regression pin)", async () => {
  const ev = await done({ toolCalls: [{ name: "noop", arguments: {} }] });
  assert.equal(ev.stopReason, "tool_use");
});

test("a scripted stopReason overrides the tool_use inference when toolCalls are present", async () => {
  const ev = await done({ toolCalls: [{ name: "noop", arguments: {} }], stopReason: "max_tokens" });
  assert.equal(ev.stopReason, "max_tokens");
});
