/**
 * The prompt editor reducer (AC11).
 *
 * Every keybinding in the Phase 3 table is exercised here against the pure
 * reducer, so a regression shows up as a failing assertion rather than as a
 * terminal that misbehaves under one specific emulator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  cursorRowCol,
  initialEditor,
  lineEndOf,
  lineStartOf,
  reduceEditor,
  verticalMove,
  type Action,
  type EditorState,
} from "./editor.js";

/** Apply a sequence, starting from `text` with the cursor at its end. */
function run(text: string, ...actions: Action[]): EditorState {
  return actions.reduce(reduceEditor, initialEditor(text));
}

/** Render as `text` with `|` marking the cursor — far easier to read than offsets. */
const show = (s: EditorState): string => s.text.slice(0, s.cursor) + "|" + s.text.slice(s.cursor);

test("AC11: typing inserts at the cursor", () => {
  const s = run("", { kind: "insert", text: "hello" });
  assert.equal(show(s), "hello|");

  const mid = run("held", { kind: "left" }, { kind: "left" }, { kind: "insert", text: "XX" });
  assert.equal(show(mid), "heXX|ld");
});

test("AC11: backspace and delete remove on either side, and no-op at the edges", () => {
  assert.equal(show(run("abc", { kind: "backspace" })), "ab|");
  assert.equal(show(run("abc", { kind: "lineStart" }, { kind: "backspace" })), "|abc");
  assert.equal(show(run("abc", { kind: "lineStart" }, { kind: "delete" })), "|bc");
  assert.equal(show(run("abc", { kind: "delete" })), "abc|");
});

test("AC11: Ctrl+A / Ctrl+E move within the CURRENT logical line", () => {
  const s = run("first\nsecond", { kind: "lineStart" });
  assert.equal(show(s), "first\n|second", "start of the current line, not the buffer");

  const e = reduceEditor(s, { kind: "lineEnd" });
  assert.equal(show(e), "first\nsecond|");
});

test("AC11: Alt+B / Alt+F move by word across whitespace", () => {
  const back = run("one two three", { kind: "wordLeft" });
  assert.equal(show(back), "one two |three");

  const twice = reduceEditor(back, { kind: "wordLeft" });
  assert.equal(show(twice), "one |two three");

  const fwd = run("one two three", { kind: "lineStart" }, { kind: "wordRight" });
  assert.equal(show(fwd), "one| two three");
});

test("AC11: Ctrl+W kills the previous word onto the ring", () => {
  const s = run("delete this word", { kind: "killWord" });
  assert.equal(show(s), "delete this |");
  assert.deepEqual(s.kills, ["word"]);
});

test("AC11: Ctrl+K kills to end of line; at the line end it joins the next", () => {
  const s = run("keep this", { kind: "lineStart" }, { kind: "wordRight" }, { kind: "killToEnd" });
  assert.equal(show(s), "keep|");
  assert.deepEqual(s.kills, [" this"]);

  // With the cursor at the END of the first line there is nothing left to kill
  // on it, so Ctrl+K consumes the newline and joins — readline's behavior, and
  // what stops a repeated Ctrl+K from stalling.
  const joined = run("a\nb", { kind: "left" }, { kind: "left" }, { kind: "killToEnd" });
  assert.equal(joined.text, "ab");
  assert.deepEqual(joined.kills, ["\n"]);
});

test("AC11: Ctrl+U kills to line start", () => {
  const s = run("drop this", { kind: "killToStart" });
  assert.equal(show(s), "|");
  assert.deepEqual(s.kills, ["drop this"]);
});

test("AC11: Ctrl+Y yanks the most recent kill", () => {
  const killed = run("hello world", { kind: "killWord" });
  const yanked = reduceEditor(killed, { kind: "yank" });
  assert.equal(show(yanked), "hello world|");

  const twice = reduceEditor(yanked, { kind: "yank" });
  assert.equal(show(twice), "hello worldworld|");
});

test("yank with an empty ring is a no-op rather than inserting undefined", () => {
  const s = run("abc", { kind: "yank" });
  assert.equal(s.text, "abc");
});

test("AC11: Ctrl+_ undoes the last edit, including a kill", () => {
  const killed = run("hello world", { kind: "killWord" });
  const undone = reduceEditor(killed, { kind: "undo" });
  assert.equal(show(undone), "hello world|");
});

test("undo restores the cursor, not just the text", () => {
  const s = run("abc", { kind: "lineStart" }, { kind: "insert", text: "X" });
  assert.equal(show(s), "X|abc");
  assert.equal(show(reduceEditor(s, { kind: "undo" })), "|abc");
});

test("undo on a fresh editor is a no-op", () => {
  assert.equal(reduceEditor(initialEditor("abc"), { kind: "undo" }).text, "abc");
});

test("pure movement does not push undo history", () => {
  const s = run("abc", { kind: "left" }, { kind: "right" }, { kind: "lineStart" });
  assert.equal(s.history.length, 0, "moving is not an edit");
});

test("AC11: newline inserts a line break for multiline input", () => {
  const s = run("first", { kind: "newline" }, { kind: "insert", text: "second" });
  assert.equal(s.text, "first\nsecond");
});

test("clear empties the buffer but stays undoable", () => {
  const s = run("some draft", { kind: "clear" });
  assert.equal(s.text, "");
  assert.equal(reduceEditor(s, { kind: "undo" }).text, "some draft");
});

test("set replaces the buffer and parks the cursor at its end (history recall)", () => {
  const s = run("typed", { kind: "set", text: "recalled" });
  assert.equal(show(s), "recalled|");
});

// -- geometry ---------------------------------------------------------------

test("lineStartOf / lineEndOf bound the current logical line", () => {
  const t = "one\ntwo\nthree";
  assert.equal(lineStartOf(t, 5), 4);
  assert.equal(lineEndOf(t, 5), 7);
  assert.equal(lineStartOf(t, 0), 0);
  assert.equal(lineEndOf(t, t.length), t.length);
});

test("cursorRowCol reports the cursor's row and column", () => {
  const t = "one\ntwo";
  assert.deepEqual(cursorRowCol(t, 0), { row: 0, col: 0 });
  assert.deepEqual(cursorRowCol(t, 5), { row: 1, col: 1 });
});

test("AC11: Up/Down move within a multiline prompt before reaching history", () => {
  const t = "first\nsecond";

  // On the last line, Up moves to the first — it does not recall history yet.
  assert.equal(verticalMove(t, t.length, -1), 5, "Up moved within the prompt");
  // On the first line, Up belongs to history.
  assert.equal(verticalMove(t, 2, -1), null, "Up at the top hands off to history");
  // Symmetrically for Down.
  assert.equal(verticalMove(t, 2, 1), 8);
  assert.equal(verticalMove(t, t.length, 1), null, "Down at the bottom hands off to history");
});

test("AC11: a single-line prompt sends Up and Down straight to history", () => {
  assert.equal(verticalMove("one line", 3, -1), null);
  assert.equal(verticalMove("one line", 3, 1), null);
});

test("vertical movement clamps the column on a shorter target line", () => {
  const t = "ab\nlonger line";
  // Cursor near the end of line 2, moving up to a 2-char line.
  assert.equal(verticalMove(t, 10, -1), 2, "clamped to the end of the shorter line");
});
