/**
 * THE PARSER EDITED TEXT IT HAD NO BUSINESS EDITING, IN THE MODULE WHOSE THESIS IS REFUSING.
 *
 * `parseYaml` stripped comments and dropped blank lines over EVERY source line before block
 * structure was known, so three separate edits were made inside a `|` or `>` block scalar — where
 * there is no comment syntax and a blank line is content. A fourth mis-read sliced a
 * under-indented continuation line mid-word. Measured at 95a3dde:
 *
 *     d: |  /  "line one # not a comment in YAML"  /  "line two"  ->  "line one\nline two\n"
 *     d: |  /  "para one"  /  ""  /  "para two"                   ->  "para one\npara two\n"
 *     d: |  /  "a"  /  "# b"  /  "c"                              ->  "a\nc\n"
 *     k: |  /  "      first"  /  "   second"                      ->  "first\nond\n"
 *
 * And three outside block scalars: an apostrophe in a plain scalar opened a quoted span and
 * swallowed the rest of the line; the anchor and alias refusals fired on `&` and `*` INSIDE a
 * quoted string, which is a false refusal in the loud direction; and a lone-`\r` file parsed as
 * one line, and a leading BOM as a key.
 *
 * The module's own words: "a parser that silently mis-handles an anchor produces a graph the
 * author did not write, and the compiler would then validate the wrong thing perfectly."
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseYaml } from "../../src/graph/yaml.ts";

// ── block scalars read the raw source ────────────────────────────────────────

test("a `#` inside a block scalar is content, not a comment", () => {
  assert.deepEqual(parseYaml("d: |\n  line one # not a comment in YAML\n  line two\n"), {
    d: "line one # not a comment in YAML\nline two\n",
  });
});

test("a blank line inside a block scalar is a paragraph break, not nothing", () => {
  assert.deepEqual(parseYaml("d: |\n  para one\n\n  para two\n"), { d: "para one\n\npara two\n" });
});

test("a line that is only a `#` inside a block scalar is a line", () => {
  assert.deepEqual(parseYaml("d: |\n  a\n  # b\n  c\n"), { d: "a\n# b\nc\n" });
});

test("a folded `>` scalar keeps its `#` too — the same source path", () => {
  assert.deepEqual(parseYaml("d: >\n  line one # not a comment\n  line two\n"), {
    d: "line one # not a comment line two\n",
  });
});

test("`|-` still strips the trailing newline, and clipping still drops trailing blanks", () => {
  assert.deepEqual(parseYaml("a: |-\n  one\n  two\n"), { a: "one\ntwo" });
  assert.deepEqual(parseYaml("a: |\n  one\n\n\nb: 2\n"), { a: "one\n", b: 2 });
});

test("a block scalar is not swallowed by the blank line before the next key", () => {
  assert.deepEqual(parseYaml("a: |\n  one\n\nb: 2\n"), { a: "one\n", b: 2 });
});

test("A LINE INDENTED BELOW THE BLOCK'S FIRST IS REFUSED, not sliced mid-word", () => {
  assert.throws(
    () => parseYaml("k: |\n      first\n   second\n", { filename: "g.yaml" }),
    /g\.yaml:3: a block scalar line indented 3 where its first line is indented 6/,
  );
});

test("a block scalar inside a sequence item reads the raw source too", () => {
  assert.deepEqual(parseYaml("nodes:\n  - id: a\n    prompt: |\n      hello # world\n\n      again\n  - id: b\n"), {
    nodes: [{ id: "a", prompt: "hello # world\n\nagain\n" }, { id: "b" }],
  });
});

// ── plain scalars, quoted spans, and line endings ────────────────────────────

test("an apostrophe in a plain scalar does not open a quoted span", () => {
  assert.deepEqual(parseYaml("d: don't do this # a note"), { d: "don't do this" });
  assert.deepEqual(parseYaml("d: it's fine"), { d: "it's fine" });
});

test("...and a real single-quoted string still is one", () => {
  assert.deepEqual(parseYaml("a: 'x # y'\nb: '2'"), { a: "x # y", b: "2" });
  assert.deepEqual(parseYaml("a: ['x # y', 'z']"), { a: ["x # y", "z"] });
});

test("`&` and `*` INSIDE a quoted string are content, not an anchor and an alias", () => {
  assert.deepEqual(parseYaml(`d: "Tom &Jerry x"`), { d: "Tom &Jerry x" });
  assert.deepEqual(parseYaml(`d: "2 *3 x"`), { d: "2 *3 x" });
  assert.deepEqual(parseYaml(`d: 'A &B'`), { d: "A &B" });
});

test("...and a real anchor or alias is still refused, which is the half that mattered", () => {
  assert.throws(() => parseYaml("a: &anchor 1"), /an anchor \(&name\)/);
  assert.throws(() => parseYaml("a: *alias"), /an alias \(\*name\)/);
  assert.throws(() => parseYaml(`a: "quoted" &anchor`), /an anchor \(&name\)/);
});

test("a lone `\\r` is a line ending", () => {
  assert.deepEqual(parseYaml("a: 1\rb: 2\r"), { a: 1, b: 2 });
  assert.deepEqual(parseYaml("a: 1\r\nb: 2\n"), { a: 1, b: 2 }, "CRLF and LF are unchanged");
});

// ── the second round: three the first fix got wrong ─────────────────────────

test("a folded `>` scalar folds blank lines to NEWLINES, not to runs of spaces", () => {
  // Preserving blank lines and then `join(" ")` produced two spaces for one paragraph break and
  // three for two — a value no author wrote, in the fix whose subject is values no author wrote.
  assert.deepEqual(parseYaml("p: >\n  You are a reviewer.\n\n  Answer in one line.\n\n\n  Be brief.\n"), {
    p: "You are a reviewer.\nAnswer in one line.\n\nBe brief.\n",
  });
  assert.deepEqual(parseYaml("d: >\n  line one\n  line two\n"), { d: "line one line two\n" }, "a single break is still a space");
});

test("a block whose FIRST line is a comment keeps it, and its indent is measured from the raw line", () => {
  assert.deepEqual(parseYaml("a: |\n  # a note\n  x\n"), { a: "# a note\nx\n" });
  // And the refusal must not fire on legal YAML because the indent was read from a later line.
  assert.deepEqual(parseYaml("a: |\n  # note\n    x\n  y\n"), { a: "# note\n  x\ny\n" });
});

test("a leading blank line inside a block scalar is content", () => {
  assert.deepEqual(parseYaml("a: |\n\n  x\n"), { a: "\nx\n" });
});

test("AN UNTERMINATED QUOTE STILL REACHES THE REFUSALS — the guard fails closed", () => {
  // Blanking a quoted span to end-of-line when the quote is never closed made all four
  // categories reachable by simply leaving a quote open.
  assert.throws(() => parseYaml(`d: "abc &anc x`), /an anchor \(&name\)/);
  assert.throws(() => parseYaml(`d: 'abc *ali x`), /an alias \(\*name\)/);
  assert.throws(() => parseYaml(`t: "x !!python/object y`), /a tag \(!!type\)/);
});

test("a leading BOM is not part of the first key", () => {
  assert.deepEqual(parseYaml("﻿a: 1\nb: 2\n"), { a: 1, b: 2 });
});
