import assert from "node:assert/strict";
import test from "node:test";

import { runSubCall } from "../src/extensions/lib/sub-call.ts";
import { MockProvider } from "../src/providers/mock.ts";
import type { CompletionRequest, Message } from "../src/kernel/types.ts";
import { Hanging } from "./helpers.ts";

// Protected invariant: a provider sub-call must terminate on a deadline
// (throwing a distinguishable /timed out/ error) or on the caller's abort — it
// must never hang, and its deadline timer must not leak.

const req: Omit<CompletionRequest, "signal"> = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  model: "mock",
};

function textOf(msg: Message): string {
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

test("AC1: a hung provider times out with a synthesized /timed out/ error and clears its timer", { timeout: 3000 }, async (t) => {
  const clearSpy = t.mock.method(globalThis, "clearTimeout");
  await assert.rejects(runSubCall(new Hanging(), req, { timeoutMs: 50 }), /timed out/);
  assert.ok(clearSpy.mock.callCount() >= 1, "the deadline timer must be cleared on the timeout path");
});

test("AC1: a normal provider resolves to the done Message and clears its timer", { timeout: 3000 }, async (t) => {
  const clearSpy = t.mock.method(globalThis, "clearTimeout");
  const provider = new MockProvider({ text: "hello sub-call" });
  const msg = await runSubCall(provider, req, { timeoutMs: 5000 });
  assert.equal(textOf(msg), "hello sub-call");
  assert.ok(clearSpy.mock.callCount() >= 1, "the deadline timer must be cleared on the success path");
});

test("AC2: a caller abort wins the race (not /timed out/) and clears its timer", { timeout: 3000 }, async (t) => {
  const clearSpy = t.mock.method(globalThis, "clearTimeout");
  const caller = new AbortController();
  setTimeout(() => caller.abort(), 20);
  await assert.rejects(
    runSubCall(new Hanging(), req, { timeoutMs: 5000, signal: caller.signal }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /timed out/);
      return true;
    },
  );
  assert.ok(clearSpy.mock.callCount() >= 1, "the deadline timer must be cleared on the caller-abort path");
});
