/**
 * The prompt component (AC11).
 *
 * Thin by design — the editing logic is pinned in `input/*.test.ts`. What these
 * assert is the wiring: that a keystroke reaches the right action, and that
 * submission, multiline, and reverse search behave as a user experiences them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";

import { initialHistory, type HistoryState } from "../input/history.js";
import { Prompt } from "./Prompt.js";

/** Ink parses input on its own tick; a bare ESC is the slowest case. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

function mount(opts: { history?: HistoryState; disabled?: boolean } = {}) {
  const submitted: string[] = [];
  let history = opts.history ?? initialHistory();
  const r = render(
    <Prompt
      history={history}
      onHistoryChange={(h) => (history = h)}
      onSubmit={(t) => submitted.push(t)}
      disabled={opts.disabled ?? false}
    />,
  );
  return { ...r, submitted, getHistory: () => history };
}

test("AC11: the placeholder shows on an empty prompt and typing replaces it", async () => {
  const { stdin, lastFrame } = mount();
  assert.match(lastFrame() ?? "", /ask anything/);

  stdin.write("hello");
  await tick();

  assert.match(lastFrame() ?? "", /hello/);
  assert.doesNotMatch(lastFrame() ?? "", /ask anything/);
});

test("AC11: Enter submits and clears the prompt", async () => {
  const { stdin, submitted, lastFrame } = mount();

  stdin.write("do the thing");
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(submitted, ["do the thing"]);
  assert.match(lastFrame() ?? "", /ask anything/, "the prompt cleared");
});

test("Enter on an empty or whitespace prompt does not submit", async () => {
  const { stdin, submitted } = mount();

  stdin.write("\r");
  stdin.write("   ");
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(submitted, []);
});

test("AC11: Ctrl+J inserts a newline instead of submitting", async () => {
  const { stdin, submitted, lastFrame } = mount();

  stdin.write("first");
  await tick();
  stdin.write("\x0a"); // Ctrl+J
  await tick();
  stdin.write("second");
  await tick();

  assert.deepEqual(submitted, [], "still composing");
  const frame = lastFrame() ?? "";
  assert.match(frame, /first/);
  assert.match(frame, /second/);
});

test("AC11: a trailing backslash turns Enter into a newline", async () => {
  const { stdin, submitted, lastFrame } = mount();

  stdin.write("line one\\");
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(submitted, [], "the backslash escaped the submit");
  assert.doesNotMatch(lastFrame() ?? "", /\\/, "and the backslash itself is consumed");
});

test("AC11: Ctrl+W deletes the previous word", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("keep this");
  await tick();
  stdin.write("\x17"); // Ctrl+W
  await tick();

  assert.match(lastFrame() ?? "", /keep/);
  assert.doesNotMatch(lastFrame() ?? "", /this/);
});

test("AC11: Ctrl+U clears the line and Ctrl+Y yanks it back", async () => {
  const { stdin, lastFrame } = mount();

  stdin.write("some draft");
  await tick();
  stdin.write("\x15"); // Ctrl+U
  await tick();
  assert.match(lastFrame() ?? "", /ask anything/, "the line was killed");

  stdin.write("\x19"); // Ctrl+Y
  await tick();
  assert.match(lastFrame() ?? "", /some draft/, "and yanked back");
});

test("AC11: Up recalls the previous prompt on a single-line buffer", async () => {
  const { stdin, lastFrame } = mount({ history: initialHistory(["earlier prompt"]) });

  stdin.write("\x1b[A"); // Up
  await tick();

  assert.match(lastFrame() ?? "", /earlier prompt/);
});

test("AC11: Ctrl+R opens reverse search and Enter accepts the match", async () => {
  const { stdin, lastFrame, submitted } = mount({
    history: initialHistory(["fix the parser", "add a test"]),
  });

  stdin.write("\x12"); // Ctrl+R
  await tick();
  assert.match(lastFrame() ?? "", /reverse-i-search/);

  stdin.write("parser");
  await tick();
  assert.match(lastFrame() ?? "", /fix the parser/);

  stdin.write("\r"); // accept into the prompt, not submit
  await tick();
  assert.deepEqual(submitted, [], "accepting a match does not submit it");
  assert.match(lastFrame() ?? "", /fix the parser/);
});

test("reverse search says so when nothing matches", async () => {
  const { stdin, lastFrame } = mount({ history: initialHistory(["one"]) });

  stdin.write("\x12");
  await tick();
  stdin.write("zzz");
  await tick();

  assert.match(lastFrame() ?? "", /no match/);
});

test("Esc closes reverse search without changing the prompt", async () => {
  const { stdin, lastFrame } = mount({ history: initialHistory(["one"]) });

  stdin.write("\x12");
  await tick();
  stdin.write("\x1b");
  await tick();

  assert.doesNotMatch(lastFrame() ?? "", /reverse-i-search/);
  assert.match(lastFrame() ?? "", /ask anything/);
});

test("a disabled prompt ignores input — the transcript owns the keyboard", async () => {
  const { stdin, lastFrame, submitted } = mount({ disabled: true });

  stdin.write("ignored");
  await tick();
  stdin.write("\r");
  await tick();

  assert.deepEqual(submitted, []);
  assert.match(lastFrame() ?? "", /ask anything/);
});

test("a pasted multi-line block arrives intact rather than submitting at the first newline", async () => {
  const { stdin, lastFrame, submitted } = mount();

  // Ink delivers a bracketed paste as one multi-character input.
  stdin.write("line one\nline two");
  await tick();

  assert.deepEqual(submitted, [], "a paste does not submit");
  const frame = lastFrame() ?? "";
  assert.match(frame, /line one/);
  assert.match(frame, /line two/);
});

// A regression the unit tests missed for four phases, because they wrote the
// text and the Enter as SEPARATE stdin writes. A real terminal coalesces: a
// paste ending in a newline, or fast typing, arrives as one chunk with
// `key.return === false`, so the submit branch never sees it.
test("text arriving in ONE chunk ending in Enter still submits", async () => {
  const { stdin, submitted, lastFrame } = mount();

  stdin.write("hello\r");
  await tick();

  assert.deepEqual(submitted, ["hello"], "the coalesced Enter still submitted");
  assert.doesNotMatch(lastFrame() ?? "", /hello/, "and the prompt cleared");
});

test("a chunk ending in Enter leaves no stray control character behind", async () => {
  const { stdin, submitted } = mount();

  stdin.write("first\r");
  await tick();
  stdin.write("second\r");
  await tick();

  assert.deepEqual(submitted, ["first", "second"], "consecutive coalesced turns both submit");
});

test("a multi-line paste ENDING in a newline submits the whole block", async () => {
  const { stdin, submitted } = mount();

  stdin.write("line one\nline two\n");
  await tick();

  assert.deepEqual(submitted, ["line one\nline two"], "interior newlines survive, the trailing one submits");
});

test("a multi-line paste with NO trailing newline still does not submit", async () => {
  const { stdin, submitted, lastFrame } = mount();

  stdin.write("line one\nline two");
  await tick();

  assert.deepEqual(submitted, [], "still composing");
  assert.match(lastFrame() ?? "", /line two/);
});
