/**
 * guard-block — unit tests for the shared guard-block detection helper
 * (design 2026-07-11-guard-telemetry-precedence, AC1).
 *
 * The kernel dispatcher returns `{ content: "Tool call blocked: <reason>",
 * isError: true }` when a `beforeToolCall` guard vetoes a call. `isGuardBlock`
 * recognizes exactly that shape on a `tool_end` result — and nothing else — so
 * telemetry can break a guard block out from an ordinary tool error.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { GUARD_BLOCK_PREFIX, blockReason, isGuardBlock } from "../src/extensions/lib/guard-block.ts";
import type { ToolResult } from "../src/kernel/types.ts";

test("GUARD_BLOCK_PREFIX is the kernel dispatcher's exact block-message prefix", () => {
  // Pins the helper's copy to the string produced at src/kernel/agent.ts (and
  // mirrored at src/extensions/dynamic-workflow.ts); a kernel message change
  // breaks this loudly.
  assert.equal(GUARD_BLOCK_PREFIX, "Tool call blocked: ");
});

test("isGuardBlock is true for a dispatcher guard-block result", () => {
  const r: ToolResult = { content: "Tool call blocked: flow-guard: not allowed", isError: true };
  assert.equal(isGuardBlock(r), true);
});

test("isGuardBlock is false for a real tool error", () => {
  assert.equal(isGuardBlock({ content: "boom", isError: true }), false);
});

test("isGuardBlock is false for a successful (non-error) result", () => {
  assert.equal(isGuardBlock({ content: "ok", isError: false }), false);
});

test("isGuardBlock is false when the prefix is present but the result is not an error", () => {
  // isError is undefined here: an echo/reporting tool that happens to emit the
  // prefix text without failing must NOT be counted as a block.
  assert.equal(isGuardBlock({ content: "Tool call blocked: something" }), false);
});

test("blockReason returns the text after the prefix", () => {
  assert.equal(
    blockReason({ content: "Tool call blocked: flow-guard: nope", isError: true }),
    "flow-guard: nope",
  );
});

test("blockReason is empty for a non-block result (no junk slice)", () => {
  assert.equal(blockReason({ content: "some unrelated long error text", isError: true }), "");
});
