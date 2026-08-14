import test from "node:test";
import assert from "node:assert/strict";

import { ROOT_BRANCH, childBranch, type BranchCoordinate } from "../../src/ids.ts";
import {
  MULTI_WRITER_SAFE,
  REDUCER_NAMES,
  type ChannelSpec,
  type Contribution,
  channelValue,
  initialState,
  makeStateView,
  reduceChannel,
  reduceState,
} from "../../src/state/channels.ts";

const b = (i: number): BranchCoordinate => childBranch(ROOT_BRANCH, "e1", i);
/** One contribution from branch `i`. `nodeId`/`iteration` are constant here, so the
 *  branch coordinate remains the only key these tests vary. */
const c = (i: number, value: unknown, ts?: number): Contribution =>
  ts === undefined
    ? { branch: b(i), nodeId: "n", iteration: 0, value }
    : { branch: b(i), nodeId: "n", iteration: 0, value, ts };

// ── the determinism property, which everything else rests on ─────────────────

test("append_ordered folds in branch order, not arrival order", () => {
  const spec: ChannelSpec = { type: "array", reduce: "append_ordered" };
  const arrivalA = [c(2, "third"), c(0, "first"), c(1, "second")];
  const arrivalB = [c(1, "second"), c(2, "third"), c(0, "first")];

  const expected = ["first", "second", "third"];
  assert.deepEqual(reduceChannel("f", spec, undefined, arrivalA), expected);
  assert.deepEqual(reduceChannel("f", spec, undefined, arrivalB), expected);
});

test("append_ordered puts branch 10 after branch 2, not between 1 and 2", () => {
  const spec: ChannelSpec = { type: "array", reduce: "append_ordered" };
  const contributions = [c(10, "ten"), c(2, "two"), c(1, "one")];
  assert.deepEqual(reduceChannel("f", spec, undefined, contributions), ["one", "two", "ten"]);
});

test("every reducer is order-independent except replace", () => {
  const cases: { reduce: ChannelSpec["reduce"]; values: unknown[]; type: ChannelSpec["type"] }[] = [
    { reduce: "append_ordered", values: [1, 2, 3], type: "array" },
    { reduce: "sum", values: [1, 2, 3], type: "number" },
    { reduce: "max", values: [5, 1, 9], type: "number" },
    { reduce: "min", values: [5, 1, 9], type: "number" },
    { reduce: "union_set", values: [["a"], ["b"], ["a"]], type: "array" },
    { reduce: "merge_object", values: [{ a: 1 }, { b: 2 }, { c: 3 }], type: "object" },
  ];
  for (const { reduce, values, type } of cases) {
    const spec: ChannelSpec = { type, reduce };
    const forward = values.map((v, i) => c(i, v));
    const reversed = [...forward].reverse();
    assert.deepEqual(
      reduceChannel("x", spec, undefined, forward),
      reduceChannel("x", spec, undefined, reversed),
      `${reduce} must be order-independent`,
    );
  }
});

test("MULTI_WRITER_SAFE excludes exactly `replace`", () => {
  const unsafe = REDUCER_NAMES.filter((r) => !MULTI_WRITER_SAFE.has(r));
  assert.deepEqual(unsafe, ["replace"]);
});

// ── individual reducers ──────────────────────────────────────────────────────

test("replace takes the last contribution in branch order", () => {
  const spec: ChannelSpec = { type: "string", reduce: "replace" };
  assert.equal(reduceChannel("x", spec, "old", [c(1, "b"), c(0, "a")]), "b");
});

test("append_ordered splices array contributions rather than nesting them", () => {
  const spec: ChannelSpec = { type: "array", reduce: "append_ordered" };
  assert.deepEqual(reduceChannel("x", spec, undefined, [c(0, [1, 2]), c(1, 3)]), [1, 2, 3]);
});

test("append_ordered extends existing state", () => {
  const spec: ChannelSpec = { type: "array", reduce: "append_ordered" };
  assert.deepEqual(reduceChannel("x", spec, ["seed"], [c(0, "new")]), ["seed", "new"]);
});

test("sum accumulates onto current state — the budget channel's behaviour", () => {
  const spec: ChannelSpec = { type: "number", reduce: "sum", initial: 0 };
  assert.equal(reduceChannel("costUsd", spec, 1.5, [c(0, 0.25), c(1, 0.25)]), 2);
});

test("max and min seed from the first contribution, not from a fake identity", () => {
  const max: ChannelSpec = { type: "number", reduce: "max" };
  const min: ChannelSpec = { type: "number", reduce: "min" };
  // If `max` seeded at 0 this would wrongly return 0 for all-negative inputs.
  assert.equal(reduceChannel("x", max, undefined, [c(0, -5), c(1, -1)]), -1);
  assert.equal(reduceChannel("x", min, undefined, [c(0, 5), c(1, 1)]), 1);
});

test("union_set dedupes by whole value by default", () => {
  const spec: ChannelSpec = { type: "array", reduce: "union_set" };
  const out = reduceChannel("hosts", spec, undefined, [c(0, ["a", "b"]), c(1, ["b", "c"])]);
  assert.deepEqual(out, ["a", "b", "c"]);
});

test("union_set dedupes by identityKey when declared", () => {
  const spec: ChannelSpec = { type: "array", reduce: "union_set", identityKey: "id" };
  const out = reduceChannel("items", spec, undefined, [
    c(0, [{ id: 1, v: "first" }]),
    c(1, [{ id: 1, v: "second" }]),
  ]) as { id: number; v: string }[];
  assert.equal(out.length, 1);
  assert.equal(out[0]?.v, "first", "first in branch order wins, deterministically");
});

test("merge_object errors on a genuine conflict rather than picking silently", () => {
  const spec: ChannelSpec = { type: "object", reduce: "merge_object" };
  assert.throws(
    () => reduceChannel("m", spec, undefined, [c(0, { k: 1 }), c(1, { k: 2 })]),
    /merge_object conflict on key "k"/,
  );
});

test("merge_object allows an identical repeated key", () => {
  const spec: ChannelSpec = { type: "object", reduce: "merge_object" };
  assert.deepEqual(reduceChannel("m", spec, undefined, [c(0, { k: 1 }), c(1, { k: 1 })]), { k: 1 });
});

test("merge_object honours onConflict: last_by_branch", () => {
  const spec: ChannelSpec = { type: "object", reduce: "merge_object", onConflict: "last_by_branch" };
  assert.deepEqual(reduceChannel("m", spec, undefined, [c(0, { k: 1 }), c(1, { k: 2 })]), { k: 2 });
});

test("last_write_wins_by_ts is total even when timestamps tie", () => {
  const spec: ChannelSpec = { type: "string", reduce: "last_write_wins_by_ts" };
  const forward = [c(0, "a", 100), c(1, "b", 100)];
  const reversed = [...forward].reverse();
  // Tie broken by branch order, so the result is still independent of arrival order.
  assert.equal(channelValue(spec, reduceChannel("x", spec, undefined, forward)), "b");
  assert.equal(channelValue(spec, reduceChannel("x", spec, undefined, reversed)), "b");
});

test("last_write_wins_by_ts prefers the later timestamp regardless of branch", () => {
  const spec: ChannelSpec = { type: "string", reduce: "last_write_wins_by_ts" };
  const out = reduceChannel("x", spec, undefined, [c(0, "late", 200), c(1, "early", 100)]);
  assert.equal(channelValue(spec, out), "late");
});

test("type mismatches are rejected with the channel named", () => {
  const spec: ChannelSpec = { type: "number", reduce: "sum" };
  assert.throws(() => reduceChannel("costUsd", spec, undefined, [c(0, "not a number")]), /channel "costUsd"/);
});

test("an empty contribution list leaves state untouched", () => {
  const spec: ChannelSpec = { type: "array", reduce: "append_ordered" };
  assert.deepEqual(reduceChannel("x", spec, ["kept"], []), ["kept"]);
});

// ── whole-state reduction ────────────────────────────────────────────────────

const SPECS: Record<string, ChannelSpec> = {
  findings: { type: "array", reduce: "append_ordered" },
  costUsd: { type: "number", reduce: "sum", initial: 0 },
  incident: { type: "object", reduce: "replace" },
};

test("initialState seeds only channels with declared initials", () => {
  assert.deepEqual(initialState(SPECS), { costUsd: 0 });
});

test("reduceState reports touched channels and both hashes", () => {
  const before = initialState(SPECS);
  const r = reduceState(SPECS, before, {
    findings: [c(0, "f0"), c(1, "f1")],
    costUsd: [c(0, 0.5), c(1, 0.25)],
  });
  assert.deepEqual(r.state["findings"], ["f0", "f1"]);
  assert.equal(r.state["costUsd"], 0.75);
  assert.deepEqual(r.channels, ["costUsd", "findings"], "sorted, so the event payload is stable");
  assert.notEqual(r.stateHashBefore, r.stateHashAfter);
  assert.match(r.stateHashAfter, /^sha256:/);
});

test("reduceState is a pure function of (state, wave)", () => {
  const before = initialState(SPECS);
  const wave = { findings: [c(1, "b"), c(0, "a")] };
  const first = reduceState(SPECS, before, wave);
  const second = reduceState(SPECS, before, wave);
  assert.equal(first.stateHashAfter, second.stateHashAfter);
  assert.deepEqual(before, { costUsd: 0 }, "input state must not be mutated");
});

test("writing an undeclared channel is E_CHANNEL_UNDECLARED", () => {
  assert.throws(
    () => reduceState(SPECS, {}, { nope: [c(0, 1)] }),
    (e: unknown) => (e as { code: string }).code === "E_CHANNEL_UNDECLARED",
  );
});

// ── StateView ────────────────────────────────────────────────────────────────

test("StateView exposes only declared reads", () => {
  const state = { findings: ["a"], costUsd: 1, incident: { id: "x" } };
  const view = makeStateView(SPECS, state, ["findings"]);

  assert.deepEqual(view.get("findings"), ["a"]);
  assert.equal(view.get("costUsd"), undefined, "undeclared reads are invisible");
  assert.deepEqual(view.visible, ["findings"]);
  assert.throws(
    () => view.require("costUsd"),
    (e: unknown) => (e as { code: string }).code === "E_CHANNEL_UNDECLARED",
  );
});

test("StateView hash covers only the visible slice", () => {
  const a = { findings: ["a"], costUsd: 1 };
  const bState = { findings: ["a"], costUsd: 999 };
  // Two states that differ only in an undeclared channel must look identical to the
  // node — otherwise a cache keyed on ctx.hash would miss for irrelevant reasons.
  assert.equal(makeStateView(SPECS, a, ["findings"]).hash, makeStateView(SPECS, bState, ["findings"]).hash);
  assert.notEqual(makeStateView(SPECS, a, ["findings", "costUsd"]).hash, makeStateView(SPECS, bState, ["findings", "costUsd"]).hash);
});

test("StateView unwraps last_write_wins_by_ts storage", () => {
  const specs: Record<string, ChannelSpec> = { note: { type: "string", reduce: "last_write_wins_by_ts" } };
  const stored = reduceChannel("note", specs["note"]!, undefined, [c(0, "hello", 1)]);
  const view = makeStateView(specs, { note: stored }, ["note"]);
  assert.equal(view.get("note"), "hello", "readers see the value, not the {value,ts} wrapper");
});

test("A CHANNEL NAME THAT NAMES AN INHERITED PROPERTY IS NOT A CHANNEL", () => {
  // `slice` is an ordinary object, so `slice["constructor"]` answers with the `Object`
  // function and `slice["__proto__"]` with `Object.prototype`. The allow-list check in
  // `get` is what stops a node body pulling a host function through a state read and into
  // the determinism boundary — `view.get("toString")` is a legal call for any node, since
  // `get` takes a string and `reads` are the node's own declaration.
  //
  // It looks redundant next to the slice, which is built from the allow-list and therefore
  // "cannot" hold anything else. That is exactly why nothing tested it: reverting it left
  // the whole suite green. The prototype chain is what makes it not redundant, and it is
  // the same hazard `gateOf` was written for one layer up.
  const view = makeStateView(SPECS, { findings: ["a"] }, ["findings"]);

  for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert.equal(view.get(inherited), undefined, `get("${inherited}") reached through the prototype chain`);
    assert.throws(
      () => view.require(inherited),
      (e: unknown) => (e as { code: string }).code === "E_CHANNEL_UNDECLARED",
      `require("${inherited}") did not refuse`,
    );
  }
  assert.deepEqual(view.visible, ["findings"], "and none of them is visible either");
});

test("…AND THE SLICE IS BUILT THE SAME WAY, which is the half the allow-list does not cover", () => {
  // The carve-out above — "the slice cannot hold anything else, it is built from the
  // allow-list" — is the claim that was wrong. `makeStateView`'s construction loop read
  // `specs[name]` and `state[name]` BARE, before the `Set` is ever consulted, so an
  // inherited name in the node's own `reads` reached the slice rather than being skipped.
  //
  // And it is reachable from an ordinary graph: `graph/compile` admits `reads:
  // ["constructor"]` with only a WARNING (`GRAPH005_UNPRODUCED_READ`). Measured before the
  // fix, one function node declaring it:
  //
  //     run status: failed   channels: {}
  //     run.failed {"code":"E_INTERNAL","message":"CanonicalizationError: function is not
  //                 representable at constructor"}
  //
  // — `digest(slice)` choking on the `Object` function that `state["constructor"]`
  // returned. The whole run dies with an untyped internal error instead of the
  // `E_CHANNEL_UNDECLARED` this layer promises for a channel nobody declared.
  for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const view = makeStateView(SPECS, { findings: ["a"] }, ["findings", inherited]);
    assert.deepEqual(view.visible, ["findings"], `"${inherited}" reached the slice`);
    // All THREE reads, because the slice is built once and read back twice: fixing only
    // the construction leaves `get` and `require` indexing the slice bare, and the
    // allow-list does not save them — the node DECLARED this name, so `allowed.has` is
    // true and the early return never fires.
    assert.equal(view.get(inherited), undefined, `get("${inherited}") read through the prototype chain`);
    assert.throws(
      () => view.require(inherited),
      (e: unknown) => (e as { code: string }).code === "E_CHANNEL_UNDECLARED",
      `require("${inherited}") returned a host function instead of refusing`,
    );
  }

  // The value side is the same lookup: a spec that IS declared must not pick up a value
  // from `Object.prototype` when the state has none of its own.
  const declaredButUnset = makeStateView(SPECS, {}, ["findings"]);
  assert.deepEqual(declaredButUnset.visible, [], "an unset declared channel is absent, not inherited");
});

test("A WRITE TO AN INHERITED NAME IS REFUSED, not accepted as a channel nothing declared", () => {
  // `reduceState` did `const spec = specs[channel]`, and `specs["constructor"]` answers with
  // the `Object` FUNCTION rather than `undefined` — so `E_CHANNEL_UNDECLARED`, the one check
  // between a node body's write vocabulary and the graph's declared channels, did not run
  // for four names. Reproduced against `specs = {findings}`:
  //
  //     reduceState({constructor}) → ACCEPTED  channels=["constructor"]  state={}
  //     reduceState({toString})    → ACCEPTED  channels=["toString"]     state={}
  //     reduceState({nope})        → refused: E_CHANNEL_UNDECLARED
  //
  // Nothing landed in state — `reduceChannel` with `spec = Object` returns `undefined`,
  // which the spread drops — so it is a fail-OPEN REFUSAL rather than a state corruption.
  // The cost is the `state.reduced` event, which named a channel in `channels` that no graph
  // declares and no reducer wrote.
  for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.throws(
      () => reduceState(SPECS, {}, { [inherited]: [c(0, "leak")] }),
      (e: unknown) => (e as { code: string }).code === "E_CHANNEL_UNDECLARED",
      `a write to "${inherited}" was accepted`,
    );
  }

  // `__proto__` is the one name whose answer depends on HOW the wave was built, and both
  // readings are correct here for different reasons. Assigning it (`wave["__proto__"] = …`)
  // invokes the SETTER, so the key is never own, `Object.keys` never sees it, and the write
  // vanishes before `reduceState` is reached. `JSON.parse` does NOT invoke the setter, so it
  // yields a genuine own property — which reaches the lookup and is refused like any other
  // name no graph declared. Both are pinned so a future reader does not "fix" either one.
  assert.deepEqual(
    reduceState(SPECS, {}, (() => {
      const wave: Record<string, Contribution[]> = {};
      wave["__proto__"] = [c(0, "leak")];
      return wave;
    })()).channels,
    [],
    "an ASSIGNED `__proto__` never becomes an own key, so there is no write to refuse",
  );
  assert.throws(
    () => reduceState(SPECS, {}, JSON.parse('{"__proto__": []}') as Record<string, Contribution[]>),
    (e: unknown) => (e as { code: string }).code === "E_CHANNEL_UNDECLARED",
    "a `__proto__` from JSON.parse IS an own key, and is refused like any other undeclared channel",
  );

  // …and a declared channel still reduces, so this is a lookup rule and not a new refusal.
  assert.deepEqual(reduceState(SPECS, {}, { findings: [c(0, "a")] }).channels, ["findings"]);
});
