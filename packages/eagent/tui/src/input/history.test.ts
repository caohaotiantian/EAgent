/**
 * Prompt history and reverse search (AC11).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  initialHistory,
  matchText,
  navigate,
  record,
  searchBackward,
} from "./history.ts";

test("AC11: Up walks back through history, Down walks forward", () => {
  let h = initialHistory();
  h = record(h, "first");
  h = record(h, "second");

  const up1 = navigate(h, -1, "draft");
  assert.equal(up1?.text, "second", "Up reaches the newest entry first");

  const up2 = navigate(up1!.state, -1, "second");
  assert.equal(up2?.text, "first");

  const down = navigate(up2!.state, 1, "first");
  assert.equal(down?.text, "second");
});

test("AC11: navigating back to the bottom restores the stashed draft", () => {
  let h = initialHistory();
  h = record(h, "old prompt");

  const up = navigate(h, -1, "half-typed thought");
  assert.equal(up?.text, "old prompt");

  const back = navigate(up!.state, 1, "old prompt");
  assert.equal(back?.text, "half-typed thought", "the draft was not lost");
});

test("AC11: a consecutive duplicate submission records one entry", () => {
  let h = initialHistory();
  h = record(h, "same");
  h = record(h, "same");

  assert.deepEqual(h.entries, ["same"], "Up steps to the previous DISTINCT prompt");
});

test("a non-consecutive repeat is recorded again", () => {
  let h = initialHistory();
  h = record(h, "a");
  h = record(h, "b");
  h = record(h, "a");

  assert.deepEqual(h.entries, ["a", "b", "a"]);
});

test("blank submissions are not recorded", () => {
  let h = initialHistory();
  h = record(h, "   ");
  h = record(h, "");

  assert.deepEqual(h.entries, []);
});

test("navigating past the oldest entry is refused, not wrapped", () => {
  let h = initialHistory();
  h = record(h, "only");

  const up = navigate(h, -1, "");
  assert.equal(navigate(up!.state, -1, "only"), null, "no wrap-around past the oldest");
});

test("Down at the live draft is refused", () => {
  const h = initialHistory(["a"]);
  assert.equal(navigate(h, 1, "draft"), null);
});

test("AC11: Ctrl+R searches backward, newest match first", () => {
  const entries = ["fix the parser", "add a test", "fix the renderer"];

  const first = searchBackward(entries, "fix");
  assert.equal(matchText(entries, first), "fix the renderer", "newest match wins");

  const next = searchBackward(entries, "fix", first);
  assert.equal(matchText(entries, next), "fix the parser", "Ctrl+R again steps older");

  assert.equal(searchBackward(entries, "fix", next), -1, "and then runs out");
});

test("reverse search is case-insensitive and substring-based", () => {
  const entries = ["Refactor The Kernel"];

  assert.equal(searchBackward(entries, "kernel"), 0);
  assert.equal(searchBackward(entries, "THE"), 0);
});

test("an empty query matches nothing, so Ctrl+R does not jump on open", () => {
  assert.equal(searchBackward(["anything"], ""), -1);
  assert.equal(matchText(["anything"], -1), "");
});
