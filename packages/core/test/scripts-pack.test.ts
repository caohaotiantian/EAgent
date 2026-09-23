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
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveHeadInto, classifyShippedSource, namesASourceMap } from "../../../scripts/pack.mjs";

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

/**
 * `archiveHeadInto` IS THE WHOLE MECHANISM M3 RESTS ON, AND WAS UNPINNED — TODO.md §A.91, the
 * reviewer's second fix round. Reverting `runPack` to compile the working tree directly (deleting
 * the call to this function) kept every OTHER check in `pack.mjs` green, because none of them ask
 * the one question this row is actually about: is a dirty working tree's change absent from what
 * gets packed? This test asks it directly, offline and fast — a throwaway ONE-commit repo, no real
 * `tsc`/`npm pack` anywhere near it.
 *
 * WHAT THIS DOES NOT PIN — TODO.md §A.91, the reviewer's third fix round (N1), said rather than
 * left implicit: this asserts `archiveHeadInto` itself is correct, never that `runPack` actually
 * CALLS it on the path that matters. A mutant that swapped the call site back to compiling the
 * working tree directly — an `rsync`-the-tree-instead-of-`git archive` regression — would leave
 * this file, and every other check in it, green: none of them drive `runPack`'s own dirty-tree
 * behavior end to end (that needs a real `tsc -b --force`, which this file's own docstring says it
 * is deliberately not paying for). Closing that gap costs one of: exporting `runPack`'s pre-compile
 * stage so a test can assert it called `archiveHeadInto` rather than a raw copy, or a `--dry-run`/
 * staging flag that stops after the archive step and reports what it archived. Neither is done
 * here; this is residue, not a fix, and `scripts/pack.mjs`'s own docstring is the place a reader
 * would look for the call site this test does not reach.
 */
test("archiveHeadInto: a dirty working tree's change is ABSENT from the archived checkout", () => {
  const repo = mkdtempSync(join(tmpdir(), "loom-archive-src-"));
  const dest = mkdtempSync(join(tmpdir(), "loom-archive-dest-"));
  try {
    // AN INHERITED GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE MUST NOT REACH THIS REPO — TODO.md §A.91,
    // the reviewer's third fix round (N2). `execFileSync`'s `env` otherwise inherits whatever this
    // TEST RUNNER's own process carries, and a caller invoking this suite from inside a git hook
    // (or any wrapper that sets one of those three to point at a DIFFERENT repository) makes every
    // `git` call below operate on that repository instead of the throwaway one just initialised —
    // `git init -q` in `repo` would silently no-op against an already-initialised GIT_DIR, and the
    // "committed" vs "DIRTY, UNCOMMITTED" assertion would be reading and writing someone else's
    // history. Stripped rather than left to chance.
    const cleanEnv = { ...process.env };
    delete cleanEnv["GIT_DIR"];
    delete cleanEnv["GIT_WORK_TREE"];
    delete cleanEnv["GIT_INDEX_FILE"];
    const git = (...args: string[]): string =>
      execFileSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        // NO GLOBAL CONFIG ASSUMED: a CI checkout may have no user.name/email set at all, and
        // this repo must commit regardless.
        env: { ...cleanEnv, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
      });
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "committed\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    const headSha = git("rev-parse", "HEAD").trim();

    // THE DIRTYING. Same file, uncommitted — the exact shape `runPack`'s own first round missed:
    // packing the working tree instead of HEAD would carry this straight into the tarball.
    writeFileSync(join(repo, "a.txt"), "DIRTY, UNCOMMITTED\n");

    archiveHeadInto(repo, headSha, dest);
    assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "committed\n", "the archive must reflect HEAD, not the dirtied working tree");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
