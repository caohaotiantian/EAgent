/**
 * Shell mode and the external-editor handoff.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { editorCommand, shellCommand, shellTranscriptEntry, stripEditorComments } from "./shell.js";

test("a leading ! enters shell mode", () => {
  assert.equal(shellCommand("!npm test"), "npm test");
  assert.equal(shellCommand("!  git status  "), "git status");
});

test("a bang inside a sentence is punctuation, not a command", () => {
  assert.equal(shellCommand("wow! that worked"), null);
  assert.equal(shellCommand("explain the ! operator"), null);
});

test("a bare ! is not a command", () => {
  assert.equal(shellCommand("!"), null);
  assert.equal(shellCommand("!   "), null);
});

test("the command and its output enter the conversation together", () => {
  const entry = shellTranscriptEntry({ command: "ls", stdout: "a.ts\nb.ts\n", exitCode: 0 });

  assert.match(entry, /^\$ ls$/m, "the command is shown as typed");
  assert.match(entry, /a\.ts/);
});

test("a non-zero exit is stated, so a silent failure cannot look like success", () => {
  const entry = shellTranscriptEntry({ command: "false", stdout: "", exitCode: 1 });

  assert.match(entry, /exit 1/);
});

test("VISUAL wins over EDITOR", () => {
  assert.equal(editorCommand({ VISUAL: "nvim", EDITOR: "vi" }), "nvim");
  assert.equal(editorCommand({ EDITOR: "vi" }), "vi");
});

test("no editor configured is reported, not guessed", () => {
  assert.equal(editorCommand({}), null);
  assert.equal(editorCommand({ EDITOR: "   " }), null);
});

test("seeded comment lines are stripped from an edited prompt", () => {
  const edited = "# the previous answer said X\n# another note\nthe real prompt\nsecond line";

  assert.equal(stripEditorComments(edited), "the real prompt\nsecond line");
});

test("a prompt with no comments survives untouched", () => {
  assert.equal(stripEditorComments("just the prompt"), "just the prompt");
});
