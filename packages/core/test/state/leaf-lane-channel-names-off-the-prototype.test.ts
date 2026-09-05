/**
 * THE FILE NAMED A SET AND SWEPT PART OF IT.
 *
 * `state/channels.ts` grew `declared()` and `own()` with docstrings saying the job is to
 * "enumerate the set" of raw own-key lookups rather than to fix the one that was noticed. Three
 * were left, all in the two whole-state entry points, and they are the reachable ones: a channel
 * name is author-written and a node body's writes are JSON, so `toString`, `constructor`,
 * `valueOf` and `__proto__` are all names a graph may use.
 *
 * Measured at 95a3dde:
 *
 *     reduceState({toString})  -> E_INTERNAL channel "toString": expected array, got function
 *     reduceState({__proto__}) -> E_INTERNAL channel "__proto__": expected array, got object
 *     foldPartial({toString})  -> walked past `spec === undefined` into reduceChannel
 *
 * The first two are the run dying on a channel whose state is simply empty. `__proto__` is the
 * worse one on the write side: `next["__proto__"] = v` stores nothing and sets a prototype
 * `stateHash` cannot see.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { foldPartial, initialState, makeStateView, reduceState } from "../../src/state/channels.ts";
import type { ChannelSpec, Contribution } from "../../src/state/channels.ts";
import { ROOT_BRANCH } from "../../src/ids.ts";

/** Every name that resolves on `Object.prototype`, plus the accessor one. */
const INHERITED = ["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"] as const;

const appended = (name: string): Record<string, ChannelSpec> => ({ [name]: { reduce: "append_ordered" } as ChannelSpec });
const wave = (name: string, value: unknown): Record<string, readonly Contribution[]> => ({
  [name]: [{ value, branch: ROOT_BRANCH, nodeId: "n", iteration: 0 }],
});

for (const name of INHERITED) {
  test(`reduceState folds a channel named "${name}" instead of dying on Object.prototype`, () => {
    const r = reduceState(appended(name), {}, wave(name, ["a"]));
    assert.deepEqual(r.channels, [name]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(r.state, name)?.value, ["a"]);
    assert.equal(Object.getPrototypeOf(r.state), Object.prototype, "the write must not have moved the prototype");
  });

  test(`...and a SECOND wave onto "${name}" accumulates onto the first`, () => {
    const first = reduceState(appended(name), {}, wave(name, ["a"]));
    const second = reduceState(appended(name), first.state, wave(name, ["b"]));
    assert.deepEqual(Object.getOwnPropertyDescriptor(second.state, name)?.value, ["a", "b"], "the read is own-key too");
  });

  test(`foldPartial folds a channel named "${name}"`, () => {
    const r = foldPartial(appended(name), wave(name, ["a"]));
    assert.deepEqual(r.channels, [name]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(r.values, name)?.value, ["a"]);
    assert.equal(Object.getPrototypeOf(r.values), Object.prototype);
  });

  test(`foldPartial still refuses to invent a spec for "${name}" from the prototype`, () => {
    // `specs` declares something else entirely, so there is no spec for this name and the fold
    // must produce nothing — not `Object.prototype[name]` used as a ChannelSpec.
    const r = foldPartial({ other: { reduce: "append_ordered" } as ChannelSpec }, wave(name, ["a"]));
    assert.deepEqual(r.channels, []);
    assert.deepEqual(r.values, {});
  });
}

test("an UNDECLARED inherited name is still refused, which is the half that already held", () => {
  for (const name of INHERITED) {
    assert.throws(
      () => reduceState({ other: { reduce: "append_ordered" } as ChannelSpec }, {}, wave(name, ["a"])),
      /E_CHANNEL_UNDECLARED|undeclared channel/,
      name,
    );
  }
});

test("ORDINARY: an ordinary channel name is folded exactly as before", () => {
  const specs = { findings: { reduce: "append_ordered" } as ChannelSpec, total: { reduce: "sum" } as ChannelSpec };
  const r = reduceState(specs, { findings: ["x"], total: 2 }, {
    findings: [{ value: ["y"], branch: ROOT_BRANCH, nodeId: "n", iteration: 0 }],
    total: [{ value: 3, branch: ROOT_BRANCH, nodeId: "n", iteration: 0 }],
  });
  assert.deepEqual(r.state, { findings: ["x", "y"], total: 5 });
  assert.deepEqual([...r.channels].sort(), ["findings", "total"]);
});

test("...and the two members the file's claim DID cover stay covered", () => {
  const specs = appended("toString");
  assert.deepEqual(initialState(specs), {}, "initialState iterates own entries and has no initial to seed");
  const view = makeStateView(specs, reduceState(specs, {}, wave("toString", ["a"])).state, ["toString"]);
  assert.deepEqual(view.get("toString"), ["a"]);
  assert.deepEqual(view.visible, ["toString"]);
});
