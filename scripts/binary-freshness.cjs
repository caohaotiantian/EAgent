/**
 * WHY THIS EXISTS
 *
 * A built binary is a photograph of a source tree, and this one has nothing to keep it honest:
 * `bin/` is gitignored, no git hook rebuilds it, and `.github/workflows/ci.yml` never builds it
 * at all. So from the second source edit onward, `bin/loom` answers for code it does not contain
 * and says nothing about it. That is not hypothetical — on 2026-08-25 an auditor measured
 * behaviour through a `bin/loom` 109 seconds behind `packages/core/src` and wrote down the older
 * code's answers (binary mtime 13:52:23, `telemetry/spans.ts` 13:54:12); on 2026-08-28 the same checked-out
 * binary was three days and 40 source files behind and still printed `--help` with exit 0.
 *
 * A gate in `npm run check` would not have caught either one: both people were running the
 * binary directly, hours after the last check. So the check rides INSIDE the binary.
 * `scripts/build-binary.mjs` hashes the sources it compiled, then bakes both that digest and
 * this file's own text into the SEA bundle's banner, which runs before any application code.
 * At startup the binary re-hashes the sources beside it and refuses when they have moved.
 *
 * WHAT IT DOES WHEN IT CANNOT DECIDE: it refuses, non-zero, before the application runs. There
 * is exactly one silent case and it is decidable rather than undecidable — no source directory
 * beside the binary means there is nothing it could be behind, which is every copy a user
 * installed. A source tree that is there but will not read is the undecidable case, and that
 * refuses like the rest.
 *
 * THAT SILENT CASE IS `ENOENT` ALL THE WAY UP, and `sourceDirState` below is where it is
 * decided: `lstat` must report `ENOENT` on the source path AND on every ancestor of it as far as
 * the directory the binary sits beside, until one of them resolves to a real directory. Only
 * then is there no directory entry of any kind on the way to the sources, which is the shipped
 * copy.
 *
 * THIS SENTENCE HAS BEEN FALSE TWICE, and the second time is why it now says "all the way up".
 * Until 2026-08-28 the test was `try { statSync(dir).isDirectory() } catch { false }`, which
 * answered the undecidable case with the passing value three ways: an `EACCES` anywhere on the
 * path (measured: `packages/core` chmod 000 with the sources genuinely edited ran the stale
 * binary, exit 0), a regular file at the path, and a dangling symlink there — `statSync` follows
 * links, so it reported that last one as ENOENT and it was indistinguishable from having no
 * sources at all. The fix checked the LAST component and the sentence claimed the whole path, so
 * the same hole survived one component up: with `packages` a dangling symlink and the sources
 * stale, exit 0, `APP RAN`. A directory entry did exist; it merely did not resolve.
 * `ancestorState` is that half.
 *
 * CONSTRAINTS. It is CommonJS and it is inlined verbatim into the bundle, so it may use only
 * `node:` builtins — the same zero-runtime-dependency rule `check-zero-dep.mjs` holds
 * `packages/core` to — and it must run to completion before anything else.
 */

const { createHash } = require("node:crypto");
const { lstatSync, readdirSync, readFileSync, statSync, writeSync } = require("node:fs");
const { dirname, join, sep } = require("node:path");

/**
 * THE SET THE DIGEST COVERS: every `*.ts` file under `packages/core/src`, and nothing else.
 * It is a superset of what actually reaches the bundle — `dist/` is compiled from all of it —
 * so the error is in the refusing direction: an edit to a file the bundler dropped still counts
 * as staleness. Named rather than "the sources" so the claim can be checked.
 */
const SOURCE_DIR = "packages/core/src";

/** The env var a human sets to run a stale binary anyway. Only the exact value `allow` counts. */
const OVERRIDE = "LOOM_STALE_BINARY";

/** Every `.ts` under `dir`, as paths relative to it, in a stable order. Throws if `dir` will not read. */
function listSources(dir) {
  const out = [];
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel === "" ? e.name : rel + "/" + e.name;
      if (e.isDirectory()) walk(join(abs, e.name), childRel);
      else if (e.name.endsWith(".ts")) out.push(childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * A digest of the file SET and the file CONTENTS — never of mtimes, so a checkout that rewrites
 * timestamps, or a `touch`, does not strand a binary that is in fact current. The relative path
 * goes into the hash before the bytes, so a rename is a change even when no byte moved.
 */
function digestSources(dir) {
  const files = listSources(dir);
  const h = createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(readFileSync(join(dir, rel)));
    h.update("\0");
  }
  return { digest: h.digest("hex"), count: files.length };
}

/** What the build bakes in. `root` is not recorded: the binary finds its own (see `sourceRoot`). */
function stampFor(root) {
  const { digest, count } = digestSources(join(root, SOURCE_DIR));
  return { dir: SOURCE_DIR, digest, count, builtAt: new Date().toISOString() };
}

/**
 * BUILD-TIME ONLY, and it is the seam where the stamp could become a lie. The bundle is built
 * from `packages/core/dist/`, but the stamp is a digest of `packages/core/src/` — so the stamp
 * only describes what is in the binary if `dist` was compiled from that `src`. `npm run
 * build:binary` runs `tsc -b --force` first and it always does; running `scripts/build-binary.mjs`
 * on its own does not, and would produce a binary that certifies sources it does not contain and
 * then reports itself fresh forever. That is worse than no check at all.
 *
 * Returns a reason to refuse, or `null` for "dist is at least as new as src". mtime is the only
 * evidence available here — `dist` has no record of what it was compiled from — but this runs at
 * build time on one machine, and an unclear answer refuses.
 */
function distIsBehindSources(root) {
  const srcDir = join(root, SOURCE_DIR);
  const distDir = join(root, "packages", "core", "dist");

  let newestSrc = -Infinity;
  let newestSrcFile = "";
  for (const rel of listSources(srcDir)) {
    const m = statSync(join(srcDir, rel)).mtimeMs;
    if (m > newestSrc) {
      newestSrc = m;
      newestSrcFile = rel;
    }
  }

  let oldestDist = Infinity;
  let count = 0;
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(abs, e.name));
      else if (e.name.endsWith(".js")) {
        count++;
        oldestDist = Math.min(oldestDist, statSync(join(abs, e.name)).mtimeMs);
      }
    }
  };
  try {
    walk(distDir);
  } catch (err) {
    // An absent dist is the fresh-clone case and gets the plain sentence; anything else
    // (a permission, a broken link) is the undecidable one and says what actually happened.
    // Both refuse.
    if (!err || err.code !== "ENOENT") {
      return "packages/core/dist is not readable (" + (err && err.message ? err.message : String(err)) + ")";
    }
  }
  if (count === 0) return "packages/core/dist holds no compiled .js — nothing has been built";
  if (newestSrc > oldestDist) {
    return "packages/core/src/" + newestSrcFile + " is newer than the compiled dist it would be stamped against";
  }
  return null;
}

/**
 * The repo root, derived from where the running code IS rather than from a path baked at build
 * time — so moving or copying the whole checkout keeps the check working, and copying only the
 * binary out of it correctly stops checking. `bin/loom` is two levels below the root.
 *
 * Inside a SEA the executable is `process.execPath`; outside one (the bundle run directly, and
 * the tests) it is this file's own location, which the build has already placed under `bin/`.
 */
function sourceRoot() {
  let anchor = __filename;
  try {
    const sea = require("node:sea");
    if (sea.isSea()) anchor = process.execPath;
  } catch {
    /* no node:sea on this runtime — the non-SEA anchor is right anyway */
  }
  return dirname(dirname(anchor));
}

/** An errno's own words where it has them; `String(err)` where it does not. Never empty. */
function said(err) {
  return err && err.message ? String(err.message) : String(err);
}

/**
 * ABSENT vs UNREADABLE — the one distinction that decides whether this whole check is allowed
 * to be silent, so it is made rather than assumed.
 *
 * `lstatSync` and not `statSync`, because the question is about the PATH and not about what it
 * points at: `statSync` follows symlinks, so a dangling one reports `ENOENT` and is therefore
 * indistinguishable from having no sources at all — which is the passing answer.
 *
 * Returns `{ present: false }` for the shipped copy, `{ present: true, why: null }` for a
 * source directory the digest can be taken over, and `{ present: true, why }` for the
 * undecidable case, where `why` is the sentence the refusal prints.
 *
 * THE SET THAT PASSES SILENTLY, named so it can be checked: `ENOENT` from `lstat` here AND an
 * `ancestorState` that finds a real directory above with nothing missing but this path. Every
 * other errno — `EACCES` on this directory or any parent, `ENOTDIR`, `ELOOP`, `EPERM` — and
 * every non-directory at the path or at any ancestor refuses, because none of them is evidence
 * that there are no sources here to be behind. It is only evidence that this code cannot tell.
 *
 * `root` bounds the ancestor walk, and it is a PARAMETER so a test can pin that boundary. It is
 * a belt to `ancestorState`'s own braces rather than the only stop: the walk also ends at the
 * first ancestor that resolves to a directory, and the binary's own directory is one, so an
 * omitted `root` cannot in practice climb past the tree the binary is in.
 */
function sourceDirState(dir, root) {
  let entry;
  try {
    entry = lstatSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return ancestorState(dir, root);
    return { present: true, why: "the source path could not be examined (" + said(err) + ")" };
  }

  if (entry.isDirectory()) return { present: true, why: null };

  if (!entry.isSymbolicLink()) {
    return { present: true, why: "the source path is not a directory, so no digest can be taken over it" };
  }

  // Something IS here — a symlink — so "nothing to be behind" is already ruled out. All that is
  // left is whether it lands on a directory, and both other answers are refusals.
  let target;
  try {
    target = statSync(dir);
  } catch (err) {
    return { present: true, why: "the source path is a symlink that does not resolve (" + said(err) + ")" };
  }
  if (!target.isDirectory()) return { present: true, why: "the source path is a symlink to something that is not a directory" };
  return { present: true, why: null };
}

/**
 * `ENOENT` ON THE SOURCE PATH IS NOT YET "NOTHING IS HERE" — the ancestors decide.
 *
 * `lstat` reports `ENOENT` for a path whose PARENT does not resolve just as it does for one whose
 * parent is a directory with nothing in it, and only the second means "no sources beside this
 * binary". Until 2026-08-28 the check stopped at the source path, so the fix that closed a
 * dangling symlink AT `packages/core/src` left the same hole one component up:
 *
 *     packages is a DANGLING symlink, sources STALE   exit=0  stdout=[APP RAN]
 *
 * The header sentence — "no directory entry of any kind" — was a claim about the whole path that
 * the code only checked at its last component. A directory entry did exist; it simply did not
 * resolve, which is the undecidable case wearing the passing answer, and this file exists because
 * that shape has now cost the same guard twice.
 *
 * WALKS UP TO `root` AND NO FURTHER, which is what keeps it from wandering into a user's
 * filesystem: `root` is the directory the binary is in the `bin/` of, and everything above it is
 * somebody else's business. The first ancestor that RESOLVES TO A DIRECTORY ends the walk with
 * `present: false` — the sources are genuinely not here. Anything else there refuses: a
 * non-directory, a symlink that does not resolve or resolves to a non-directory, or any errno
 * other than `ENOENT`.
 *
 * WHICH OF THOSE ARMS ACTUALLY FIRES, measured rather than assumed, because this file's own
 * defect class is a claim wider than its code. On POSIX `lstat` answers ENOTDIR — not ENOENT —
 * for a path whose parent is a regular file, and EACCES for one whose parent cannot be searched,
 * so `sourceDirState`'s own `errno !== "ENOENT"` arm has already refused both before this
 * function is reached. Driven on this tree: `packages` a symlink to a FILE, and
 * `packages/core` a symlink to a FILE, both come back "the source path could not be examined
 * (ENOTDIR…)". THE ONE ARM HERE THAT ANSWERS A CASE NOTHING ELSE ANSWERS is the dangling symlink
 * — `lstat` on the child of a link that resolves to nothing really is ENOENT. The rest are
 * belt-and-braces and are kept because the cost is three `lstat` calls on the install path and
 * the alternative is a guard whose fail-closed shape depends on an errno table.
 */
function ancestorState(dir, root) {
  let at = dirname(dir);
  for (;;) {
    let entry;
    try {
      entry = lstatSync(at);
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        return { present: true, why: "an ancestor of the source path (" + at + ") could not be examined (" + said(err) + ")" };
      }
      // Nothing here either. Stop at `root`, and stop at the filesystem root, so a `root` that
      // is itself absent cannot spin.
      const up = dirname(at);
      if (at === root || up === at) return { present: false, why: null };
      at = up;
      continue;
    }
    if (entry.isDirectory()) return { present: false, why: null };
    if (!entry.isSymbolicLink()) {
      return { present: true, why: "an ancestor of the source path (" + at + ") is not a directory, so nothing under it can be examined" };
    }
    try {
      if (statSync(at).isDirectory()) return { present: false, why: null };
    } catch (err) {
      return { present: true, why: "an ancestor of the source path (" + at + ") is a symlink that does not resolve (" + said(err) + ")" };
    }
    return { present: true, why: "an ancestor of the source path (" + at + ") is a symlink to something that is not a directory" };
  }
}

function report(stamp, headline, detail) {
  const lines = [
    "",
    "loom: THIS BINARY IS STALE — it is not the code sitting beside it.",
    "",
    "  " + headline,
    "  built    " + stamp.builtAt + " from " + stamp.count + " file(s)",
    "  " + detail,
    "  covering every *.ts under " + stamp.dir,
    "",
    "Anything you measure with it is the older code's answer. Rebuild it:",
    "",
    "  npm run build:binary",
    "",
    "Or set " + OVERRIDE + "=allow to run it anyway — it stays stale, and it stays wrong.",
    "",
  ];
  // `writeSync(2, …)` and not `process.stderr.write`: stderr to a pipe is asynchronous, and the
  // `process.exit(1)` below would be free to truncate the very message that explains the exit.
  // Wrapped because a closed stderr must not turn a refusal into an unhandled throw.
  try {
    writeSync(2, lines.join("\n") + "\n");
  } catch {
    /* nobody is listening; the exit code still says everything it can */
  }
}

/**
 * Run before the application. Returns on a binary that is current, or on one that has no source
 * tree beside it; otherwise prints and exits 1, unless a human set the override — in which case
 * it prints the same report and returns, because the bar is that nobody drives a stale binary
 * WITHOUT BEING TOLD, not that nobody drives one.
 */
function check(stamp) {
  const root = sourceRoot();
  const dir = join(root, stamp.dir);

  // `root` bounds the ancestor walk: the silent case is a claim about the path BETWEEN the
  // binary and its sources, and nothing above that is this check's business.
  const state = sourceDirState(dir, root);
  if (!state.present) return; // a shipped copy: no sources here, so nothing to be behind

  // `state.why` is already a refusal; only a directory that resolved gets as far as the digest.
  let now = null;
  let failure = state.why;
  if (failure === null) {
    try {
      now = digestSources(dir);
    } catch (err) {
      failure = said(err);
    }
  }

  if (failure !== null) {
    report(
      stamp,
      "the source tree beside it could not be read, so freshness could not be decided",
      "at       " + dir + sep + " — " + failure,
    );
  } else if (now.digest !== stamp.digest) {
    report(
      stamp,
      "the sources have changed since it was built",
      "now      " + now.count + " file(s), " + now.digest.slice(0, 12) + " ≠ " + stamp.digest.slice(0, 12),
    );
  } else {
    return; // current
  }

  if (process.env[OVERRIDE] === "allow") return;
  process.exit(1);
}

/**
 * The text to inject as the SEA bundle's banner: this whole file, wrapped so its `module` and
 * `exports` are locals and cannot touch the bundle's own, followed by the one call that runs it.
 * Build-time only — inside the binary nothing calls this, and `__filename` would not resolve.
 */
function banner(stamp) {
  return [
    "(function () {",
    "var module = { exports: {} }; var exports = module.exports;",
    readFileSync(__filename, "utf8"),
    "module.exports.check(" + JSON.stringify(stamp) + ");",
    "})();",
  ].join("\n");
}

module.exports = {
  SOURCE_DIR,
  OVERRIDE,
  listSources,
  digestSources,
  stampFor,
  distIsBehindSources,
  sourceDirState,
  sourceRoot,
  check,
  banner,
};
