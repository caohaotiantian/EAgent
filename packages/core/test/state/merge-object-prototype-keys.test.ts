/**
 * `merge_object` READ ITS ACCUMULATOR THROUGH THE PROTOTYPE CHAIN, in the one file that wrote
 * two helpers (`declared`, `own`) precisely so that would stop happening.
 *
 * A node body writes JSON. JSON keys named `toString`, `constructor`, `valueOf`,
 * `hasOwnProperty` and `__proto__` are all legal and all ordinary in scraped or model-produced
 * data, and `k in out` is true for every one of them on an object that declared none. Both
 * directions were wrong: a crash where the correct answer is a merge, and — under
 * `onConflict: "last_by_branch"` — a silent write that RE-PARENTS the channel value and drops
 * the author's key, which `stateHash` (own keys only) cannot tell from the correct result.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ROOT_BRANCH, childBranch, type BranchCoordinate } from "../../src/ids.ts";
import { type ChannelSpec, type Contribution, reduceChannel } from "../../src/state/channels.ts";

const b = (i: number): BranchCoordinate => childBranch(ROOT_BRANCH, "e1", i);
const c = (i: number, value: unknown): Contribution => ({ branch: b(i), nodeId: "n", iteration: 0, value });

const MERGE: ChannelSpec = { type: "object", reduce: "merge_object" };
const LAST: ChannelSpec = { type: "object", reduce: "merge_object", onConflict: "last_by_branch" };

// Every one of these is a member of Object.prototype, so `k in out` finds it on a fresh {}.
const INHERITED = ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"] as const;

test("a single writer whose JSON keys are Object.prototype members merges as data", () => {
  for (const k of INHERITED) {
    // JSON.parse is how the value really arrives, and it is the only construction that makes
    // `__proto__` an OWN key rather than a prototype assignment.
    const value = JSON.parse(`{${JSON.stringify(k)}: 1, "keep": 2}`) as Record<string, unknown>;
    const out = reduceChannel("m", MERGE, undefined, [c(0, value)]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out).sort(), [k, "keep"].sort(), `key ${k}: both keys survive as own keys`);
    assert.equal(Object.hasOwn(out, k) && (out as Record<string, unknown>)[k], 1);
    assert.equal(Object.getPrototypeOf(out), Object.prototype, `key ${k}: the value must not be re-parented`);
  }
});

test("...and last_by_branch stores __proto__ as data instead of re-parenting", () => {
  const value = JSON.parse('{"__proto__": {"pwned": 1}, "keep": 2}') as Record<string, unknown>;
  const out = reduceChannel("m", LAST, undefined, [c(0, value)]) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.deepEqual((out as { pwned?: unknown }).pwned, undefined, "nothing was inherited");
  assert.deepEqual(Object.keys(out).sort(), ["__proto__", "keep"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, { pwned: 1 });
});

test("a GENUINE conflict on an inherited-name key is still refused", () => {
  // The guard must narrow to own keys, not disappear: two branches writing different values
  // for `toString` is the same conflict as two branches writing different values for `k`.
  for (const k of INHERITED) {
    assert.throws(
      () => reduceChannel("m", MERGE, undefined, [c(0, { [k]: 1 }), c(1, { [k]: 2 })]),
      new RegExp(`merge_object conflict on key "${k.replace("$", "\\$")}"`),
      `key ${k}`,
    );
    // …and an identical repeated value is still fine.
    assert.doesNotThrow(() => reduceChannel("m", MERGE, undefined, [c(0, { [k]: 1 }), c(1, { [k]: 1 })]));
  }
});

test("the ORDINARY merge_object arms are unchanged", () => {
  assert.deepEqual(reduceChannel("m", MERGE, undefined, [c(0, { a: 1 }), c(1, { b: 2 })]), { a: 1, b: 2 });
  assert.deepEqual(reduceChannel("m", MERGE, { seed: 0 }, [c(0, { a: 1 })]), { seed: 0, a: 1 });
  assert.throws(() => reduceChannel("m", MERGE, undefined, [c(0, { k: 1 }), c(1, { k: 2 })]), /conflict on key "k"/);
  assert.deepEqual(reduceChannel("m", LAST, undefined, [c(0, { k: 1 }), c(1, { k: 2 })]), { k: 2 });
});

test("union_set's identity key is read as an own key too", () => {
  // Same class, same file, two lines down: `key in v` for a declared `identity` of `toString`
  // reached the inherited function and canonicalize refused it.
  const spec: ChannelSpec = { type: "array", reduce: "union_set", identityKey: "toString" };
  const out = reduceChannel("u", spec, undefined, [c(0, [{ a: 1 }]), c(1, [{ a: 2 }])]) as unknown[];
  assert.deepEqual(out, [{ a: 1 }, { a: 2 }], "no element declares the identity key, so each is its own identity");

  const declared: ChannelSpec = { type: "array", reduce: "union_set", identityKey: "id" };
  assert.deepEqual(
    reduceChannel("u", declared, undefined, [c(0, [{ id: "x", v: 1 }]), c(1, [{ id: "x", v: 2 }])]),
    [{ id: "x", v: 1 }],
    "the ordinary identityKey arm still dedupes on the declared key",
  );
});
