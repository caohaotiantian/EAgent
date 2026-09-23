#!/usr/bin/env node
/**
 * WHY THIS EXISTS: the tarball is the install, so what goes into it has to be a function of `src`
 * — and, since the reviewer's fix round on TODO.md §A.91 M3, of `src` AT `HEAD`, not of whatever
 * is sitting in the maintainer's working tree at the moment they happen to run this.
 *
 * `npm pack` ships whatever `packages/core/dist` holds, and nothing tied `dist` to the sources
 * before this script did:
 *
 *   0. RESOLVE `HEAD` FROM A CLEAN `git archive`, into a throwaway checkout — not the working
 *      tree. §H.17's OWN fix (tracked-source-only) still left a hole this row closes: `git add`ing
 *      a file satisfies "tracked" while leaving it UNCOMMITTED, and a tracked file with staged or
 *      unstaged edits compiles from bytes `git log` never recorded either — the refusal's own
 *      advice, "git add the source", still shipped code that exists on this disk and nowhere
 *      else. `git archive HEAD` cannot express either hazard: it materialises exactly the tree the
 *      last commit named, so there is no "clean enough" check to get wrong. `node_modules` is
 *      symlinked into the checkout afterward — it holds no source and `check-zero-dep.mjs` forbids
 *      shipping any of it, so borrowing the real one costs nothing this row is about.
 *   1. COMPILE THERE (`tsc -b --force`), so `dist` is HEAD's, not the working tree's — and the
 *      maintainer's OWN `packages/core/dist`, from their own last build, is never touched: this
 *      script's every mutation lands in the throwaway checkout `--out`'s sibling scratch dir names
 *      as such, torn down in a `finally` regardless of outcome.
 *   2. REFUSE AN ORPHAN: every `dist/**\/*.js` and `dist/**\/*.d.ts` must have its `src/**\/*.ts`,
 *      TRACKED, at the archived commit — which every file in the archive already is, by
 *      construction, so this step now only catches `tsc -b`'s own staleness (a source removed or
 *      renamed since a stray old build artefact was last committed — it should not have been, and
 *      this is the backstop for that). Then STRIP `//# sourceMappingURL=…` off every shipped
 *      `.js`/`.d.ts`: `tsconfig.base.json` turns `sourceMap`/`declarationMap` on for local
 *      development, and the comment survived into a tarball that (correctly, `files` in
 *      `package.json` keeps `.map` out) ships no map for it to point at — measured at `48de87f6`:
 *      138 of 141 packed files ending in a pointer to a file that was never there.
 *   3. `npm pack` the core workspace into `--out DIR`, lifecycle scripts off (the package declares
 *      none; `check-zero-dep.mjs` forbids them).
 *   4. CHECK WHAT WAS PACKED against `files` — the entry points, README and LICENSE are in, no
 *      `.tsbuildinfo` is, and — extracted from the TARBALL itself, not read back off the checkout's
 *      `dist/` — no shipped `.js`/`.d.ts` still OPENS a line with `sourceMappingURL`. Anchored at
 *      LINE START rather than matched anywhere in the file: a bare substring search would flag a
 *      doc comment that merely MENTIONS the pointer (this file's own header now does, repeatedly)
 *      as if it shipped one.
 *
 * It publishes nothing and touches no registry. `private: true` stays in `package.json`; removing
 * it is the maintainer's publish act, and `DESIGN.md` Sequence item 29 records what closes then.
 *
 * OUTSIDE A GIT CHECKOUT, THIS REFUSES IN ITS OWN WORDS: `git archive` is the whole packing
 * mechanism now, not an optional check, so `fail()` names that rather than letting `git`'s own
 * stderr and a raw non-zero exit stand in for this script's diagnosis. `--out` ITSELF is not
 * created until every check has passed — TODO.md §A.91, the reviewer's second fix round: creating
 * it up front left an empty directory behind on any early failure, indistinguishable from "packed
 * zero files" to a caller scripting around this. A COMMITTED COMPILE ERROR is caught the same
 * round: `tsc -b --force`'s own diagnostics still print (`stdio: "inherit"`), but the exception
 * `execFileSync` throws for the non-zero exit is caught and turned into a `pack FAILED:` line
 * rather than an uncaught `Error: Command failed …` stack riding on top of them.
 *
 * WHAT WAS PACKED IS PRINTED WITH THE BRANCH ("detached" if none) beside the sha, and — NOT A
 * REFUSAL — a working tree with uncommitted changes is counted and named: this row packs `HEAD`
 * ON PURPOSE, so a dirty tree is a fact worth telling the operator, not an error.
 *
 * THE CLASSIFICATION IN STEP 2 IS `classifyShippedSource`, A PURE FUNCTION, exported for
 * `packages/core/test/scripts-pack.test.ts` to pin directly — deleting or loosening the check
 * turns that test red without needing a real compile, a real archive or a real `npm pack` in the
 * loop. `archiveHeadInto` (step 0's mechanism) is exported and pinned there too, directly: reverting
 * `runPack` to compile the working tree instead — deleting the one call to it — was UNPINNED after
 * the first round, because nothing else in this file asks "is a dirty tree's change absent from
 * what gets archived". The test asks that one question, offline, against a throwaway two-commit
 * repo, with no real `tsc`/`npm pack` anywhere near it.
 *
 *     node scripts/pack.mjs --out DIR     → DIR/caohaotiantian-loom-<version>.tgz, path on stdout
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `process.env`, WITH `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` REMOVED — TODO.md §A.91, the
 * reviewer's third fix round (N2). Every `git` call below names its repository by `cwd`
 * (`repoRoot`, or a caller's own directory), and any of these three variables in the calling
 * process's environment overrides that: `git` prefers them over `cwd`, so a wrapper that sets one
 * — a hook, a nested checkout, another tool's `git -C` shim — silently redirects every git call in
 * this script (and `archiveHeadInto`, which a test also calls directly against a throwaway repo)
 * to a DIFFERENT repository than the one `cwd` names. `{ ...process.env }` inherited them by
 * default; this is what every `execFileSync("git", ...)` call passes instead.
 */
function gitEnv() {
  const env = { ...process.env };
  delete env["GIT_DIR"];
  delete env["GIT_WORK_TREE"];
  delete env["GIT_INDEX_FILE"];
  return env;
}

function fail(message) {
  console.error(`pack FAILED: ${message}`);
  process.exitCode = 1;
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * WHAT ONE SHIPPED `dist` FILE COMPILES FROM, judged from two booleans a caller already knows —
 * a PURE function on purpose, so a test can pin all three answers without a filesystem, a git
 * checkout or a compile anywhere near it. TODO.md §H.17 named the first two; §A.91 M3 is the
 * reason a third exists — with packing now sourced from `git archive HEAD`, EVERY file the walk
 * below ever sees is one `git ls-files` already tracks at that commit, by construction, so
 * `"untracked"` should be UNREACHABLE from `runPack`'s own call site and is kept here, tested
 * directly, as the backstop for whichever future change makes that stop being true.
 *
 * @param {boolean} sourceExists - does `packages/core/src/<stem>.ts` exist at the commit packed?
 * @param {boolean} sourceTracked - does `git ls-files` track that path at that commit?
 * @returns {"ok" | "orphan" | "untracked"}
 */
export function classifyShippedSource(sourceExists, sourceTracked) {
  if (!sourceExists) return "orphan";
  if (!sourceTracked) return "untracked";
  return "ok";
}

/**
 * `//# sourceMappingURL=…`, anchored at the START OF A LINE — TODO.md §A.91 M3. A bare
 * `.includes("sourceMappingURL")` flags a doc comment that mentions the pointer without shipping
 * one (this file's own header, once compiled, would have been such a comment before `.mjs` files
 * — never compiled — made the worry moot for THIS file; the shipped `.d.ts`/`.js` files under
 * `packages/core/dist` are the ones a stray mention would have false-positived on).
 *
 * @param {string} text
 * @returns {boolean}
 */
export function namesASourceMap(text) {
  return /^\/\/# sourceMappingURL=/m.test(text);
}

/**
 * `git archive HEAD | tar -x`, ISOLATED — TODO.md §A.91, the reviewer's second fix round. The
 * mechanism M3 rests on: materialises exactly the tree ONE commit named, into `destDir`, with no
 * reference to whatever the working tree currently holds. Extracted on its own so
 * `packages/core/test/scripts-pack.test.ts` can pin the ONE property that actually matters — a
 * dirty working tree's changes are ABSENT from what lands in `destDir` — without paying for a real
 * `tsc -b` or a real `npm pack` to prove it. That property was UNPINNED after the first round:
 * reverting `runPack` to compile the working tree directly (deleting this whole function's call)
 * kept every other check in this file green, because none of them asked this specific question.
 *
 * `git archive`, NOT `--output` to a file: piping keeps this one process tree and needs no
 * intermediate file cleaned up on every exit path.
 *
 * @param {string} repoRoot - a directory `git` can resolve `headSha` from.
 * @param {string} headSha - the commit to materialise.
 * @param {string} destDir - an existing, empty directory to extract into.
 */
export function archiveHeadInto(repoRoot, headSha, destDir) {
  const archive = execFileSync("git", ["archive", headSha], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 1024, env: gitEnv() });
  execFileSync("tar", ["-x", "-C", destDir], { input: archive });
}

function runPack(argv) {
  const stray = argv.filter((a, i) => !(a === "--out" || a.startsWith("--out=") || argv[i - 1] === "--out"));
  if (stray.length > 0) {
    console.error(`pack FAILED: unknown argument ${stray.join(" ")} — the only one is --out DIR.`);
    process.exit(2);
  }
  const at = argv.indexOf("--out");
  const eq = argv.find((a) => a.startsWith("--out="));
  const outArg = eq !== undefined ? eq.slice("--out=".length) : at === -1 ? undefined : argv[at + 1];
  if (outArg === undefined || outArg === "" || outArg.startsWith("--")) {
    console.error("usage: node scripts/pack.mjs --out DIR");
    process.exit(2);
  }
  const OUT = resolve(outArg);
  // NOT CREATED YET — TODO.md §A.91, the reviewer's second fix round: outside a git checkout (or
  // on any other early failure) this used to leave an empty `--out` directory behind, which looks
  // exactly like "packed zero files" to a caller scripting around this. Created only once every
  // check below has passed, right before `npm pack` needs it to exist.

  // ── 0. a clean HEAD, materialised — not the working tree ───────────────────────
  let headSha;
  let branch;
  let dirtyCount;
  try {
    // `stdio: ["ignore","pipe","pipe"]`, so a failure's stderr reaches THIS message once — the
    // default inherits stdio, which printed git's own "fatal: not a git repository" a second
    // time, ahead of and separate from this script's own diagnosis of the same fact.
    const gitStdio = { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv() };
    headSha = execFileSync("git", ["rev-parse", "HEAD"], gitStdio).trim();
    // DETACHED READS "HEAD" FROM THIS COMMAND, so it is renamed for the operator: "HEAD" printed
    // next to a sha that is ALSO what `rev-parse HEAD` names is confusing in a way "detached"
    // is not.
    const abbrev = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitStdio).trim();
    branch = abbrev === "HEAD" ? "detached" : abbrev;
    // NOT A REFUSAL — TODO.md §A.91 M3. Packing sources HEAD ON PURPOSE (that is the whole of
    // this row); a dirty working tree is not an error, it is a fact the operator packing might
    // not have meant to leave out, so it is counted and named rather than silently dropped.
    dirtyCount = execFileSync("git", ["status", "--porcelain"], gitStdio)
      .split("\n")
      .filter((l) => l.length > 0).length;
  } catch (e) {
    fail(
      `this is not a git checkout (\`git rev-parse HEAD\` failed): ${(e.stderr ?? e.message).toString().trim()}\n` +
        `Packing sources HEAD via \`git archive\` — there is no working-tree fallback, because a fallback ` +
        `is exactly the hole this row closes.`,
    );
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), "loom-pack-src-"));
  try {
    const checkout = join(scratch, "checkout");
    mkdirSync(checkout, { recursive: true });
    archiveHeadInto(repoRoot, headSha, checkout);
    // BORROWED, NOT COPIED: `node_modules` holds no source `check-zero-dep.mjs` cares about, and
    // `git archive` never contains it (it is gitignored) — the checkout cannot compile without it.
    if (existsSync(join(repoRoot, "node_modules"))) {
      symlinkSync(join(repoRoot, "node_modules"), join(checkout, "node_modules"), "dir");
    }
    const CORE = join(checkout, "packages", "core");
    const DIST = join(CORE, "dist");

    // ── 1. compile, IN THE CHECKOUT — the maintainer's own dist/ is never opened ──
    try {
      // `stdio: ["ignore", "pipe", "pipe"]`, NOT `"inherit"` — TODO.md §H.17/§A.91, the reviewer's
      // third fix round (N5). `tsc` writes its own diagnostics to STDOUT, and this process's
      // stdout is reserved for the tarball path on success (`console.log(tarball)` below): a
      // committed compile error used to leave tsc's diagnostics sitting on THIS process's stdout
      // even though the failure itself is correctly reported on stderr (`fail` below), so a caller
      // reading stdout for "the path, or nothing" got compiler noise instead. Piped here and
      // re-emitted on OUR stderr in the catch below, so a clean run's stdout carries only the
      // tarball path either way.
      execFileSync(process.execPath, [join(checkout, "node_modules", "typescript", "bin", "tsc"), "-b", "--force"], {
        cwd: checkout,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (e) {
      // tsc's own diagnostics, on OUR stderr — never our stdout. `e.stdout`/`e.stderr` are what
      // `execFileSync` attaches to the thrown error when stdio is piped rather than inherited.
      if (e.stdout) process.stderr.write(e.stdout);
      if (e.stderr) process.stderr.write(e.stderr);
      fail(`the archived commit ${headSha} does not compile (tsc -b --force failed, see above) — a broken commit cannot be packed.`);
      return;
    }

    // ── 2. every shipped file has a TRACKED source ────────────────────────────────
    // `git ls-tree`, NOT `git ls-files` — `ls-files` reads the INDEX/working tree and the
    // checkout has no `.git` at all (`git archive`'s output is a plain file tree, deliberately:
    // that is what makes it immune to a dirty index). `ls-tree -r` at `headSha`, run from
    // `repoRoot` where `.git` actually lives, is the one query that names what was tracked AT
    // THAT COMMIT regardless of what the working tree looks like right now.
    const tracked = new Set(
      execFileSync("git", ["ls-tree", "-r", "--name-only", headSha, "--", "packages/core/src"], { cwd: repoRoot, encoding: "utf8", env: gitEnv() })
        .split("\n")
        .filter((l) => l.length > 0),
    );
    const orphans = [];
    const untracked = [];
    let shipped = 0;
    for (const file of walk(DIST)) {
      const rel = relative(DIST, file);
      const stem = rel.endsWith(".d.ts") ? rel.slice(0, -".d.ts".length) : rel.endsWith(".js") ? rel.slice(0, -".js".length) : undefined;
      if (stem === undefined) continue; // maps and .tsbuildinfo — `files` keeps them out, step 4 checks
      shipped++;
      const srcRel = `packages/core/src/${stem}.ts`;
      const classification = classifyShippedSource(existsSync(join(checkout, srcRel)), tracked.has(srcRel));
      if (classification === "orphan") orphans.push(`packages/core/dist/${rel.split(sep).join("/")}`);
      else if (classification === "untracked") untracked.push(`packages/core/dist/${rel.split(sep).join("/")} (source: ${srcRel})`);
    }
    if (shipped === 0) {
      fail("packages/core/dist holds nothing to ship — the compile above emitted nothing");
      return;
    }
    if (orphans.length > 0) {
      fail(
        `${String(orphans.length)} file(s) in dist have no source in packages/core/src AT ${headSha}, which should be ` +
          `unreachable once \`tsc -b --force\` just compiled that exact tree — a stale build artefact must have been ` +
          `committed:\n  ${orphans.join("\n  ")}\nRemove it from the tree and commit that.`,
      );
      return;
    }
    if (untracked.length > 0) {
      // UNREACHABLE FROM A `git archive` CHECKOUT — every file it contains is tracked at `headSha`
      // by construction. Kept as the backstop `classifyShippedSource`'s own docstring names.
      fail(
        `${String(untracked.length)} file(s) in dist compile from a source \`git ls-files\` does not track at ${headSha} — ` +
          `this should be unreachable from an archived checkout:\n  ${untracked.join("\n  ")}`,
      );
      return;
    }

    // ── 2b. strip a sourceMappingURL pointer with nothing on the other end ────────
    // `tsconfig.base.json` has `sourceMap`/`declarationMap` on for local development, and `files`
    // in `package.json` correctly keeps `.map` out of the tarball — so every emitted `.js`/`.d.ts`
    // carried a pointer to a map that was never packed (TODO.md §H.17). This mutates the THROWAWAY
    // checkout's `dist/` only — §A.91 M3's whole point — never the maintainer's own build.
    let stripped = 0;
    for (const file of walk(DIST)) {
      if (!/\.(js|d\.ts)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      const cleaned = text.replace(/\n?\/\/# sourceMappingURL=\S+\n?$/, "\n");
      if (cleaned !== text) {
        writeFileSync(file, cleaned);
        stripped++;
      }
    }

    // ── 3. pack ────────────────────────────────────────────────────────────────────
    // CREATED HERE, not at the top: every check above has passed, so this is the first point at
    // which there is anything to put in `--out` — see the note where `OUT` was resolved.
    mkdirSync(OUT, { recursive: true });
    const raw = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", OUT], {
      cwd: CORE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    // npm ≤ 10 prints an ARRAY of reports; npm 12 (measured, 12.0.2) an OBJECT keyed by package name.
    const parsed = JSON.parse(raw);
    const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed ?? {})[0];
    if (report === undefined) {
      fail(`npm pack printed no report:\n${raw}`);
      return;
    }
    const tarball = join(OUT, report.filename);
    if (!statSync(tarball).isFile()) {
      fail(`npm pack reported ${tarball} and it is not there`);
      return;
    }

    // ── 4. what went in ─────────────────────────────────────────────────────────────
    const paths = new Set(report.files.map((f) => f.path));
    const missing = ["package.json", "README.md", "LICENSE", "dist/bin.js", "dist/cli.js", "dist/index.js", "dist/index.d.ts"].filter(
      (p) => !paths.has(p),
    );
    const unwanted = [...paths].filter((p) => p.endsWith(".map") || p.endsWith(".tsbuildinfo") || p.startsWith("src/") || p.startsWith("test/"));
    if (missing.length > 0) {
      fail(`the tarball lacks ${missing.join(", ")}`);
      return;
    }
    if (unwanted.length > 0) {
      fail(`the tarball carries what "files" should keep out: ${unwanted.slice(0, 10).join(", ")}`);
      return;
    }

    // ASSERTED AGAINST THE TARBALL ITSELF, not against the checkout's `dist/` — 2b mutated that,
    // but the claim this row makes is about what a stranger's `npm install` actually unpacks.
    const verifyDir = mkdtempSync(join(tmpdir(), "loom-pack-verify-"));
    try {
      execFileSync("tar", ["-xzf", tarball, "-C", verifyDir]);
      const pointing = [];
      for (const file of walk(join(verifyDir, "package"))) {
        if (!/\.(js|d\.ts)$/.test(file)) continue;
        if (namesASourceMap(readFileSync(file, "utf8"))) pointing.push(relative(verifyDir, file).split(sep).join("/"));
      }
      if (pointing.length > 0) {
        fail(
          `${String(pointing.length)} packed file(s) still name a sourceMappingURL with no .map shipped to answer it:\n  ` +
            `${pointing.slice(0, 10).join("\n  ")}`,
        );
        return;
      }
    } finally {
      rmSync(verifyDir, { recursive: true, force: true });
    }

    console.error(
      `packed ${report.name}@${report.version} from ${branch}@${headSha.slice(0, 12)} — ${String(report.entryCount)} files, ` +
        `${(report.size / 1024).toFixed(0)} KB (${(report.unpackedSize / 1024).toFixed(0)} KB unpacked), every one compiled ` +
        `from a clean archive of that commit (${String(stripped)} sourceMappingURL pointer(s) stripped, none remain in the tarball)`,
    );
    // NOT A REFUSAL — see where `dirtyCount` was measured. A caller who forgot to commit before
    // packing gets told what was left out, rather than a tarball that quietly does not match what
    // `git status` shows on their screen.
    if (dirtyCount > 0) {
      console.error(`! the working tree has ${String(dirtyCount)} uncommitted change(s), left out of this pack (it sources ${branch}@${headSha.slice(0, 12)} only)`);
    }
    console.log(tarball);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) runPack(process.argv.slice(2));
