/**
 * WHY THIS EXISTS
 *
 * A built binary is a photograph of a source tree, and this one has nothing to keep it honest:
 * `bin/` is gitignored, no git hook rebuilds it, and `.github/workflows/ci.yml` never builds it
 * at all. So from the second source edit onward, `bin/loom` answers for code it does not contain
 * and says nothing about it. That is not hypothetical — on 2026-08-25 an auditor measured
 * behaviour through a `bin/loom` 109 seconds behind `packages/core/src` and wrote down the older
 * code's answers (`docs/todo-recheck-2026-08-25.md`:1858); on 2026-08-28 the same checked-out
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
 * CONSTRAINTS. It is CommonJS and it is inlined verbatim into the bundle, so it may use only
 * `node:` builtins — the same zero-runtime-dependency rule `check-zero-dep.mjs` holds
 * `packages/core` to — and it must run to completion before anything else.
 */

const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, statSync, writeSync } = require("node:fs");
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
  const dir = join(sourceRoot(), stamp.dir);

  let present = false;
  try {
    present = statSync(dir).isDirectory();
  } catch {
    present = false;
  }
  if (!present) return; // a shipped copy: no sources here, so nothing to be behind

  let now = null;
  let failure = null;
  try {
    now = digestSources(dir);
  } catch (err) {
    failure = err && err.message ? String(err.message) : String(err);
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
  sourceRoot,
  check,
  banner,
};
