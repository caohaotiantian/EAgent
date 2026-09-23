/**
 * `scripts/pack.mjs`'S OWN CLASSIFICATION, PINNED WITHOUT A COMPILE, AN ARCHIVE OR A REAL `npm
 * pack` ANYWHERE IN THE LOOP — TODO.md §A.91 M3.
 *
 * `pack.mjs` decides, per shipped `dist` file, whether its declared source exists and is tracked
 * — and until this test existed, that decision lived inline in a loop nobody could pin except by
 * running the whole script end to end (a real `tsc -b`, a real `git archive`, a real `npm pack`).
 * `classifyShippedSource` and `namesASourceMap` are the two PURE pieces of that: extracted so this
 * file can assert their three-and-two answers directly, and so deleting or loosening either one
 * turns this test red without needing the rest of the script to run at all.
 *
 * `pack.mjs` only runs its side-effecting body when invoked AS a script (`isMain`, guarded by
 * `import.meta.url` against `process.argv[1]`) — importing it here, the way this file does, runs
 * none of it. That guard is what makes this import path usable by `node --test
 * 'packages/*\/test/**\/*.test.ts'` at all: without it, importing the module would shell out to
 * `git`, `tsc` and `npm` as a side effect of loading a test file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { classifyShippedSource, namesASourceMap } from "../../../scripts/pack.mjs";

test("classifyShippedSource: ok, orphan, untracked — the three answers TODO.md §H.17 and §A.91 M3 name", () => {
  assert.equal(classifyShippedSource(true, true), "ok", "a source that exists and is tracked ships clean");
  assert.equal(classifyShippedSource(false, true), "orphan", "no source at all — a stale build artefact, §H.17's first shape");
  assert.equal(classifyShippedSource(false, false), "orphan", "no source outranks untracked — there is nothing to be tracked OR not");
  assert.equal(classifyShippedSource(true, false), "untracked", "a source that exists but git does not track — §H.17's second shape");
});

test("namesASourceMap: a pointer at line start, never a bare substring — TODO.md §A.91 M3", () => {
  assert.equal(namesASourceMap("//# sourceMappingURL=cli.js.map"), true, "the pointer itself, alone");
  assert.equal(namesASourceMap("export const x = 1;\n//# sourceMappingURL=cli.js.map\n"), true, "the pointer as the file's last line");
  assert.equal(namesASourceMap(""), false, "an empty file");
  assert.equal(namesASourceMap("export const x = 1;\n"), false, "an ordinary file with no pointer");
  // THE CASE A BARE `.includes("sourceMappingURL")` WOULD HAVE GOTTEN WRONG: the substring is
  // present, but not as a pointer that opens a line — a doc comment MENTIONING the mechanism, or
  // a string literal naming it, must not read as a shipped map reference.
  assert.equal(
    namesASourceMap("/** this file carries no sourceMappingURL, deliberately */\nexport const x = 1;\n"),
    false,
    "a comment that mentions the word is not a pointer",
  );
  assert.equal(
    namesASourceMap('export const MARKER = "//# sourceMappingURL=fake.map";\n'),
    false,
    "a string literal holding the exact text is not a pointer either — it does not OPEN a line",
  );
});
