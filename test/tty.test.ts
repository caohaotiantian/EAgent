/**
 * The retained terminal predicates: `isFancy`, `SPINNER_FRAMES`.
 *
 * The TTY-requiring axes a piped subprocess cannot fake are driven here in-process
 * with an injected fake `Term`: stdin-TTY/stdout-pipe, `TERM=dumb`, width 0.
 * No PTY (zero-dep charter). The plain-render byte-parity axes live in
 * `engine-plain-render.test.ts` (fake non-TTY Term) and in the `cli.test.ts`
 * subprocess parity.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isFancy, SPINNER_FRAMES } from "../src/tty.js";
import { makeFakeTerm } from "./helpers.js";

test("isFancy is true only for an interactive, TTY, non-dumb, positive-width terminal", () => {
  const capable = makeFakeTerm({ isTTY: true, columns: 80 });
  assert.equal(isFancy(capable, { interactive: true, term_env: "xterm-256color" }), true, "capable terminal → fancy");

  // stdin-TTY but stdout is a pipe (term.isTTY false): the redirected-stdout trap.
  assert.equal(isFancy(makeFakeTerm({ isTTY: false, columns: 80 }), { interactive: true, term_env: "xterm" }), false);
  // TERM=dumb on an otherwise-capable terminal.
  assert.equal(isFancy(capable, { interactive: true, term_env: "dumb" }), false);
  // Width 0 / unknown.
  assert.equal(isFancy(makeFakeTerm({ isTTY: true, columns: 0 }), { interactive: true, term_env: "xterm" }), false);
  assert.equal(isFancy(makeFakeTerm({ isTTY: true, columns: undefined }), { interactive: true, term_env: "xterm" }), false);
  // Non-interactive (e.g. --eval) even on a full TTY.
  assert.equal(isFancy(capable, { interactive: false, term_env: "xterm" }), false);
});

test("SPINNER_FRAMES is the single braille frame set, all non-ASCII glyphs", () => {
  assert.equal(SPINNER_FRAMES.length, 10, "ten braille frames");
  for (const frame of SPINNER_FRAMES) {
    assert.equal([...frame].length, 1, `frame ${JSON.stringify(frame)} is a single glyph`);
    assert.ok(frame.codePointAt(0)! > 0x2800, "a braille code point (never an ASCII byte a machine stream carries)");
  }
});
