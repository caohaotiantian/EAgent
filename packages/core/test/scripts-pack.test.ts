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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { archiveHeadInto, classifyShippedSource, namesASourceMap, runPack } from "../../../scripts/pack.mjs";

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
 * The CALL SITE is pinned by the `runPack` test below (TODO.md §H.22); this one pins the function.
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

/**
 * `runPack` ITSELF, END TO END, OVER A THROWAWAY REPOSITORY — TODO.md §H.22.
 *
 * The test above pins `archiveHeadInto`, not the CALL: a `runPack` that copied the working tree
 * into its scratch checkout instead stayed green, and its success line ("every one compiled from a
 * clean archive of that commit") then lied about what shipped. This packs a real (tiny) checkout —
 * a real `git archive`, a real `tsc -b --force`, a real offline `npm pack` — holding a committed
 * file, a tracked file with an uncommitted edit, and an untracked file, and reads the TARBALL.
 * Mutant: `archiveHeadInto(root, headSha, checkout)` → `cpSync(root, checkout, { recursive: true })`
 * (minus `.git`) turns this red on the edited file's bytes.
 */
test("runPack: an uncommitted edit and an uncommitted file are ABSENT from the tarball — TODO.md §H.22", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "loom-runpack-src-"));
  const out = mkdtempSync(join(tmpdir(), "loom-runpack-out-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const cleanEnv = { ...process.env };
  delete cleanEnv["GIT_DIR"];
  delete cleanEnv["GIT_WORK_TREE"];
  delete cleanEnv["GIT_INDEX_FILE"];
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...cleanEnv, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
    });
  const put = (rel: string, text: string): void => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  git("init", "-q");
  put(".gitignore", "node_modules\ndist\n*.tsbuildinfo\n");
  put("tsconfig.json", JSON.stringify({ files: [], references: [{ path: "packages/core" }] }));
  put(
    "packages/core/tsconfig.json",
    JSON.stringify({
      compilerOptions: { composite: true, outDir: "dist", rootDir: "src", declaration: true, sourceMap: true, module: "nodenext", target: "es2022", strict: true, types: [] },
      include: ["src"],
    }),
  );
  put("packages/core/package.json", JSON.stringify({ name: "@example/tiny", version: "0.0.1", type: "module", files: ["dist/**/*.js", "dist/**/*.d.ts"], main: "dist/index.js" }));
  put("packages/core/README.md", "tiny\n");
  put("packages/core/LICENSE", "none\n");
  for (const f of ["bin", "cli"]) put(`packages/core/src/${f}.ts`, `export const ${f}: string = "committed";\n`);
  put("packages/core/src/index.ts", 'export const marker: string = "COMMITTED-MARKER";\n');
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  // BORROWED, as `runPack` borrows it into the archive: the compiler lives in the real one.
  symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules"), join(repo, "node_modules"), "dir");

  // THE DIRTYING: a tracked file edited, and a file that exists nowhere in git.
  put("packages/core/src/index.ts", 'export const marker: string = "DIRTY-MARKER";\n');
  put("packages/core/src/extra.ts", 'export const extra: string = "UNCOMMITTED-FILE";\n');

  const realLog = console.log;
  const realErr = console.error;
  const lines: string[] = [];
  const priorExit = process.exitCode;
  console.log = (...a: unknown[]): void => void lines.push(a.join(" "));
  console.error = (...a: unknown[]): void => void lines.push(a.join(" "));
  try {
    runPack(["--out", out], repo);
    assert.notEqual(process.exitCode, 1, `runPack refused:\n${lines.join("\n")}`);
  } finally {
    console.log = realLog;
    console.error = realErr;
    process.exitCode = priorExit;
  }
  const tarball = lines.find((l) => l.endsWith(".tgz"));
  assert.ok(tarball !== undefined, `runPack printed no tarball path:\n${lines.join("\n")}`);
  const listing = execFileSync("tar", ["-tzf", tarball!], { encoding: "utf8" });
  const index = execFileSync("tar", ["-xzOf", tarball!, "package/dist/index.js"], { encoding: "utf8" });
  assert.match(index, /COMMITTED-MARKER/, "the tarball holds HEAD's bytes");
  assert.doesNotMatch(index, /DIRTY-MARKER/, "an uncommitted edit reached the tarball");
  assert.doesNotMatch(listing, /extra/, "an uncommitted file reached the tarball");
  assert.match(lines.join("\n"), /uncommitted change\(s\), left out of this pack/, "the dirty tree is named, not silently dropped");
});

test("runPack: a directory nested inside another repository is refused BY NAME — TODO.md §H.23", (t) => {
  const outer = mkdtempSync(join(tmpdir(), "loom-nested-"));
  const out = mkdtempSync(join(tmpdir(), "loom-nested-out-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const cleanEnv = { ...process.env };
  delete cleanEnv["GIT_DIR"];
  delete cleanEnv["GIT_WORK_TREE"];
  delete cleanEnv["GIT_INDEX_FILE"];
  execFileSync("git", ["init", "-q"], { cwd: outer, env: cleanEnv });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
    cwd: outer,
    env: { ...cleanEnv, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  const nested = join(outer, "loom");
  mkdirSync(nested);

  const realErr = console.error;
  const lines: string[] = [];
  const priorExit = process.exitCode;
  console.error = (...a: unknown[]): void => void lines.push(a.join(" "));
  try {
    runPack(["--out", out], nested);
    assert.equal(process.exitCode, 1);
  } finally {
    console.error = realErr;
    process.exitCode = priorExit;
  }
  const said = lines.join("\n");
  assert.ok(said.includes(realpathSync(outer)), `the refusal must name the repository git resolved (${realpathSync(outer)}):\n${said}`);
  assert.doesNotMatch(said, /does not compile/, "it used to blame a compile of a commit that was never this directory's");
});
