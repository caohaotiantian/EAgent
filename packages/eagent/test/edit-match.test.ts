import assert from "node:assert/strict";
import { test } from "node:test";

import { locateEdit } from "../src/extensions/lib/edit-match.ts";

test("exact precedence: verbatim find wins even when a relaxed variant exists elsewhere", () => {
  // "foo();" occurs once verbatim, and "  foo();" (indented) occurs once too;
  // the exact path must win and never consult the relaxed ladder.
  const content = "foo();\nif (x) {\n    foo();\n}\n";
  const m = locateEdit(content, "foo();", false);
  assert.equal(m.kind, "exact");
  if (m.kind === "exact") {
    assert.equal(m.span, "foo();");
    assert.equal(m.count, 2);
  }
});

test("exact: count reflects every verbatim occurrence", () => {
  const m = locateEdit("a x a x a", "a", false);
  assert.equal(m.kind, "exact");
  if (m.kind === "exact") assert.equal(m.count, 3);
});

test("line-trimmed: per-line whitespace differs, locates the real span", () => {
  const content = "function f() {\n    return 42;\n}\n";
  // find has no leading indentation on the middle line; not present verbatim.
  const find = "function f() {\nreturn 42;\n}";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "relaxed");
  if (m.kind === "relaxed") {
    assert.equal(m.strategy, "line-trimmed");
    assert.equal(m.span, "function f() {\n    return 42;\n}");
    assert.notEqual(content.indexOf(m.span), -1);
  }
});

test("whitespace-normalized: internal space runs differ on a full line", () => {
  const content = "const   x    =    1;\n";
  // single spaces; differs from the multi-space original; line-trim would not
  // catch internal runs, so whitespace-normalized must.
  const find = "const x = 1;";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "relaxed");
  if (m.kind === "relaxed") {
    assert.equal(m.strategy, "whitespace-normalized");
    assert.equal(m.span, "const   x    =    1;");
  }
});

test("whitespace-normalized: multi-line block with differing internal runs", () => {
  const content = "if (a   &&   b) {\n    do(  it  );\n}\n";
  const find = "if (a && b) {\ndo( it );\n}";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "relaxed");
  if (m.kind === "relaxed") {
    assert.equal(m.strategy, "whitespace-normalized");
    assert.notEqual(content.indexOf(m.span), -1);
  }
});

test("indentation-flexible: uniform indent shift locates the real span", () => {
  // The block is indented in content; find carries the same relative
  // indentation at a different base level. The relaxed ladder locates the
  // exact indented span in content.
  const content = "        outer\n            inner\n";
  const find = "outer\n    inner";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "relaxed");
  if (m.kind === "relaxed") {
    assert.equal(m.span, "        outer\n            inner");
    assert.notEqual(content.indexOf(m.span), -1);
  }
});

test("escape-normalized: literal \\n in find matches a real newline in content", () => {
  const content = "line1\nline2\n";
  const find = "line1\\nline2";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "relaxed");
  if (m.kind === "relaxed") {
    assert.equal(m.strategy, "escape-normalized");
    assert.equal(m.span, "line1\nline2");
  }
});

test("escape-normalized: literal \\t in find matches a real tab in content", () => {
  const content = "a\tb\n";
  const find = "a\\tb";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "relaxed");
  if (m.kind === "relaxed") {
    assert.equal(m.strategy, "escape-normalized");
    assert.equal(m.span, "a\tb");
  }
});

test("trimmed-boundary: extra leading blank line and trailing space", () => {
  // find adds a blank first line and a trailing space, so line count and
  // boundaries differ from content; line-trimmed and whitespace-normalized miss
  // (line counts differ), and trimmed-boundary trims to the real span.
  const content = "\tcode here\nmore";
  const find = "  \n\tcode here\nmore  ";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "relaxed");
  if (m.kind === "relaxed") {
    assert.equal(m.strategy, "trimmed-boundary");
    assert.equal(m.span, "code here\nmore");
    assert.notEqual(content.indexOf(m.span), -1);
  }
});

test("unique-only: a relaxed variant matching two distinct spans is ambiguous", () => {
  // Both lines trim to "go"; line-trimmed yields the identical "  go" span,
  // which occurs twice -> no unique candidate and no stricter strategy yields
  // one -> ambiguous (never a silent pick).
  const content = "  go\n  go\n";
  const find = "go ";
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "ambiguous");
});

test("ambiguity is bypassed under replaceAll", () => {
  const content = "  go\n  go\n";
  const find = "go ";
  const m = locateEdit(content, find, true);
  assert.equal(m.kind, "relaxed");
});

test("proportionality: a unique relaxed candidate far larger than find is disproportionate", () => {
  // find is a single line (literal \n separators), escape-normalized unescapes
  // it to a ten-line span -> searchLines far exceeds find's one line, so the
  // proportionality guard rejects it even though the span is unique.
  const lines = Array.from({ length: 10 }, (_, i) => `row${i}`);
  const content = lines.join("\n") + "\n";
  const find = lines.join("\\n");
  const m = locateEdit(content, find, false);
  assert.equal(m.kind, "disproportionate");
});

test("empty/whitespace find -> not-found (ladder skipped)", () => {
  const content = "anything here\n";
  assert.equal(locateEdit(content, "   ", false).kind, "not-found");
  assert.equal(locateEdit(content, "", false).kind, "not-found");
});

test("no exact and no structural match -> not-found", () => {
  const content = "completely unrelated content\n";
  assert.equal(locateEdit(content, "missing token", false).kind, "not-found");
});
