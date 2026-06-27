/**
 * Unit tests for the widened `Usage` arithmetic (P0.2 / KDD-1, KDD-2).
 *
 * `Usage` gains optional `cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens`.
 * The load-bearing invariant is *omit-when-absent* (AC-13): `addUsage` of two
 * plain 2-field usages must return an object deep-equal to a 2-field object —
 * no `cacheReadTokens: 0` key may appear, or the provider `deepEqual` assertions
 * (anthropic/openai/gemini) break. When either operand carries an optional field,
 * that field is summed (AC-4). `totalTokens` counts input + cacheRead + cacheWrite
 * + output, but NOT reasoning (a subset of output already counted).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { addUsage, totalTokens, type Usage } from "../src/kernel/types.js";

test("addUsage of two 2-field usages stays a 2-field object (omit-invariant, AC-13)", () => {
  const sum = addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 });
  assert.deepEqual(sum, { inputTokens: 4, outputTokens: 6 });
  // Explicit: no optional key leaked in (a `cacheReadTokens: 0` would pass a
  // loose check but fail deepEqual and the provider tests).
  assert.deepEqual(Object.keys(sum).sort(), ["inputTokens", "outputTokens"]);
});

test("addUsage sums every optional field when both operands carry them (AC-4)", () => {
  const a: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 10, cacheWriteTokens: 3, reasoningTokens: 1 };
  const b: Usage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 2 };
  assert.deepEqual(addUsage(a, b), {
    inputTokens: 4,
    outputTokens: 6,
    cacheReadTokens: 30,
    cacheWriteTokens: 8,
    reasoningTokens: 3,
  });
});

test("addUsage includes an optional field present in only one operand (treating the absent side as 0)", () => {
  const sum = addUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 5 }, { inputTokens: 1, outputTokens: 1 });
  assert.deepEqual(sum, { inputTokens: 2, outputTokens: 2, cacheReadTokens: 5 });
  // The fields neither operand carried stay omitted.
  assert.equal("cacheWriteTokens" in sum, false);
  assert.equal("reasoningTokens" in sum, false);
});

test("totalTokens = input + cacheRead + cacheWrite + output (reasoning excluded as an output subset)", () => {
  const u: Usage = { inputTokens: 4, outputTokens: 6, cacheReadTokens: 30, cacheWriteTokens: 8, reasoningTokens: 3 };
  assert.equal(totalTokens(u), 4 + 30 + 8 + 6); // 48 — reasoning (3) is NOT added
  // A plain 2-field usage totals exactly input+output (unchanged from before).
  assert.equal(totalTokens({ inputTokens: 10, outputTokens: 5 }), 15);
});

test("reasoningTokens is an informational subset of outputTokens (reasoningTokens <= outputTokens)", () => {
  const u: Usage = { inputTokens: 0, outputTokens: 20, reasoningTokens: 8 };
  assert.ok(u.reasoningTokens! <= u.outputTokens, "reasoning must not exceed billable output");
});
