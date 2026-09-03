/**
 * A REFUSAL NOBODY CAN DIAGNOSE IS HALF A REFUSAL.
 *
 * `asNumber` is right to refuse a non-finite value — a channel that folds NaN poisons every
 * later `sum`, `max` and `min`, and `stateHash` cannot canonicalize it either. But the message
 * was built from `typeof got`, and `typeof NaN` is `"number"`, so the operator holding the
 * journal row read:
 *
 *     channel "n": expected number, got number
 *
 * Arrays are the same shape one step removed: `typeof [1]` is `"object"`, so an array written to
 * an `object` channel read `expected object, got object`.
 *
 * The value itself stays out of the message on purpose — a channel holds model and tool output,
 * and this string reaches a journal.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { reduceState, type ChannelSpec, type Contribution } from "../../src/state/channels.ts";

const contrib = (value: unknown): readonly Contribution[] => [
  { branch: { path: [] } as never, nodeId: "a", iteration: 0, value },
];

const specs = (reduce: ChannelSpec["reduce"], type: ChannelSpec["type"]): Record<string, ChannelSpec> => ({
  n: { type, reduce },
});

const refusal = (reduce: ChannelSpec["reduce"], type: ChannelSpec["type"], value: unknown): string => {
  try {
    reduceState(specs(reduce, type), {}, { n: contrib(value) });
  } catch (e) {
    return (e as Error).message;
  }
  return "(accepted)";
};

test("a non-finite number is named as what it is, not as `number`", () => {
  assert.equal(refusal("sum", "number", Number("abc")), 'channel "n": expected number, got NaN');
  assert.equal(refusal("max", "number", Number.POSITIVE_INFINITY), 'channel "n": expected number, got Infinity');
  assert.equal(refusal("min", "number", Number.NEGATIVE_INFINITY), 'channel "n": expected number, got -Infinity');
});

test("...and an array is named as an array, not as `object`", () => {
  assert.equal(refusal("merge_object", "object", [1, 2]), 'channel "n": expected object, got array');
});

test("the ORDINARY refusals still say the same thing, and the ordinary folds still fold", () => {
  assert.equal(refusal("sum", "number", "7"), 'channel "n": expected number, got string');
  assert.equal(refusal("sum", "number", null), 'channel "n": expected number, got null');
  assert.equal(refusal("sum", "number", true), 'channel "n": expected number, got boolean');
  assert.equal(refusal("merge_object", "object", "x"), 'channel "n": expected object, got string');

  assert.deepEqual(reduceState(specs("sum", "number"), {}, { n: contrib(3) }).state, { n: 3 });
  assert.deepEqual(reduceState(specs("sum", "number"), { n: 4 }, { n: contrib(3) }).state, { n: 7 });
  assert.deepEqual(reduceState(specs("merge_object", "object"), {}, { n: contrib({ a: 1 }) }).state, { n: { a: 1 } });
});
