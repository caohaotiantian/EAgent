/**
 * The non-TTY refusal predicate (AC14).
 *
 * The pin that matters: no configuration in which output is redirected may mount
 * Ink. Getting this wrong writes escape sequences into a user's log file, which
 * is the regression the engine's machine paths exist to prevent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { refusalReason, type TtyEnv } from "./tty.ts";

const interactive: TtyEnv = {
  stdinIsTTY: true,
  stdoutIsTTY: true,
  columns: 120,
  term: "xterm-256color",
  ci: undefined,
};

test("AC14: a real interactive terminal mounts", () => {
  assert.equal(refusalReason(interactive), null);
});

test("AC14: every redirected or non-interactive shape refuses", () => {
  const cases: [string, Partial<TtyEnv>][] = [
    ["piped stdin", { stdinIsTTY: false }],
    ["redirected stdout", { stdoutIsTTY: false }],
    ["dumb terminal", { term: "dumb" }],
    ["CI", { ci: "true" }],
    ["CI=1", { ci: "1" }],
  ];

  for (const [label, override] of cases) {
    assert.notEqual(refusalReason({ ...interactive, ...override }), null, `${label} must refuse`);
  }
});

test("an empty or falsey CI value is not a CI environment", () => {
  // `CI=` and `CI=false` are common in shells that always export the variable;
  // treating them as CI would refuse to start on a perfectly good terminal.
  for (const ci of ["", "0", "false"]) {
    assert.equal(refusalReason({ ...interactive, ci }), null, `CI=${ci} must still mount`);
  }
});

test("a terminal reporting no width still mounts — Ink falls back to 80 columns", () => {
  // Some pty wrappers and multiplexers report 0 until the first resize; refusing
  // there would decline to start on a perfectly usable terminal.
  assert.equal(refusalReason({ ...interactive, columns: 0 }), null);
  assert.equal(refusalReason({ ...interactive, columns: undefined }), null);
});

test("the reason names the first failing condition, for a useful message", () => {
  assert.equal(refusalReason({ ...interactive, stdinIsTTY: false }), "stdin is not a terminal");
  assert.equal(refusalReason({ ...interactive, term: "dumb" }), "TERM=dumb");
});
