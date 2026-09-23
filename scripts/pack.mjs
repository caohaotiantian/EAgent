#!/usr/bin/env node
/**
 * WHY THIS EXISTS: the tarball is the install, so what goes into it has to be a function of `src`.
 *
 * `npm pack` ships whatever `packages/core/dist` holds, and nothing ties `dist` to the sources:
 * `tsc -b` skips a build it believes is current, and even `--force` never DELETES the output of a
 * source file that has since been removed or renamed — so a stale `dist/old-name.js` rides into the
 * tarball and is importable by a stranger forever, compiled from code this repository no longer
 * has. Same hazard `build-binary.mjs` §0 closes for the binary, closed the same way:
 *
 *   1. COMPILE HERE (`tsc -b --force`), so `dist` is this tree's.
 *   2. REFUSE AN ORPHAN: every `dist/**\/*.js` and `dist/**\/*.d.ts` must have its
 *      `src/**\/*.ts`, and that source must be one `git ls-files` TRACKS — an untracked file on
 *      the maintainer's own disk still compiles and still has no place in a published tarball
 *      (TODO.md §H.17). The fix named is `rm -rf packages/core/dist` for a stale output, or `git
 *      add`/removing the file for one this tree does not track — never a silent delete here. Then
 *      STRIP `//# sourceMappingURL=…` off every shipped `.js`/`.d.ts`: `tsconfig.base.json` turns
 *      `sourceMap`/`declarationMap` on for local development, and the comment survived into a
 *      tarball that (correctly, `files` in `package.json` keeps `.map` out) ships no map for it to
 *      point at — measured at `48de87f6`: 138 of 141 packed files ending in a pointer to a file
 *      that was never there. This is dist mutation, not source: `tsc -b --force` one line up
 *      recompiles it every run, so nothing here survives past this script's own exit.
 *   3. `npm pack` the core workspace into `--out DIR`, lifecycle scripts off (the package declares
 *      none; `check-zero-dep.mjs` forbids them).
 *   4. CHECK WHAT WAS PACKED against `files` — the entry points, README and LICENSE are in, no
 *      `.tsbuildinfo` is, and — extracted from the TARBALL itself, not read back off the `dist/`
 *      this script just mutated — no shipped `.js`/`.d.ts` still names a `sourceMappingURL`.
 *
 * It publishes nothing and touches no registry. `private: true` stays in `package.json`; removing
 * it is the maintainer's publish act, and `DESIGN.md` Sequence item 29 records what closes then.
 *
 *     node scripts/pack.mjs --out DIR     → DIR/caohaotiantian-loom-<version>.tgz, path on stdout
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CORE = join(repoRoot, "packages", "core");
const SRC = join(CORE, "src");
const DIST = join(CORE, "dist");

function fail(message) {
  console.error(`pack FAILED: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
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
mkdirSync(OUT, { recursive: true });

// ── 1. compile ────────────────────────────────────────────────────────────────
execFileSync(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-b", "--force"], {
  cwd: repoRoot,
  stdio: "inherit",
});

// ── 2. every shipped file has a TRACKED source ─────────────────────────────────
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
// `git ls-files` rather than `existsSync`: a file this checkout has on disk but never `git add`ed
// compiles exactly like a tracked one, so `existsSync` alone cannot tell the two apart — measured
// at `48de87f6` with `echo 'export const x = 1;' > packages/core/src/zz-untracked-probe.ts`, packed
// clean. Paths come back relative to `repoRoot`, which is what `join(repoRoot, …)` below expects.
const tracked = new Set(
  execFileSync("git", ["ls-files", "--full-name", "--", "packages/core/src"], { cwd: repoRoot, encoding: "utf8" })
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
  if (!existsSync(join(repoRoot, srcRel))) orphans.push(`packages/core/dist/${rel.split(sep).join("/")}`);
  else if (!tracked.has(srcRel)) untracked.push(`packages/core/dist/${rel.split(sep).join("/")} (source: ${srcRel})`);
}
if (shipped === 0) fail("packages/core/dist holds nothing to ship — the compile above emitted nothing");
if (orphans.length > 0) {
  fail(
    `${String(orphans.length)} file(s) in dist have no source in packages/core/src, so they would ship code this tree ` +
      `does not contain:\n  ${orphans.join("\n  ")}\nRemove the stale output and pack again: rm -rf packages/core/dist`,
  );
}
if (untracked.length > 0) {
  fail(
    `${String(untracked.length)} file(s) in dist compile from a source \`git ls-files\` does not track, so they would ship ` +
      `code that is on this disk and nowhere else:\n  ${untracked.join("\n  ")}\n\`git add\` the source, or remove it and pack again.`,
  );
}

// ── 2b. strip a sourceMappingURL pointer with nothing on the other end ─────────
// `tsconfig.base.json` has `sourceMap`/`declarationMap` on for local development, and `files` in
// `package.json` correctly keeps `.map` out of the tarball — so every emitted `.js`/`.d.ts` carried
// a pointer to a map that was never packed (TODO.md §H.17). `tsc -b --force` regenerated `dist` one
// step up, so this mutates only the copy this run just produced.
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

// ── 3. pack ───────────────────────────────────────────────────────────────────
const raw = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", OUT], {
  cwd: CORE,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
// npm ≤ 10 prints an ARRAY of reports; npm 12 (measured, 12.0.2) an OBJECT keyed by package name.
const parsed = JSON.parse(raw);
const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed ?? {})[0];
if (report === undefined) fail(`npm pack printed no report:\n${raw}`);
const tarball = join(OUT, report.filename);
if (!statSync(tarball).isFile()) fail(`npm pack reported ${tarball} and it is not there`);

// ── 4. what went in ───────────────────────────────────────────────────────────
const paths = new Set(report.files.map((f) => f.path));
const missing = ["package.json", "README.md", "LICENSE", "dist/bin.js", "dist/cli.js", "dist/index.js", "dist/index.d.ts"].filter(
  (p) => !paths.has(p),
);
const unwanted = [...paths].filter((p) => p.endsWith(".map") || p.endsWith(".tsbuildinfo") || p.startsWith("src/") || p.startsWith("test/"));
if (missing.length > 0) fail(`the tarball lacks ${missing.join(", ")}`);
if (unwanted.length > 0) fail(`the tarball carries what "files" should keep out: ${unwanted.slice(0, 10).join(", ")}`);

// ASSERTED AGAINST THE TARBALL ITSELF, not against `dist/` — 2b mutated this run's `dist/`, but the
// claim this row makes is about what a stranger's `npm install` actually unpacks.
const verifyDir = mkdtempSync(join(tmpdir(), "loom-pack-verify-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", verifyDir]);
  const pointing = [];
  for (const file of walk(join(verifyDir, "package"))) {
    if (!/\.(js|d\.ts)$/.test(file)) continue;
    if (readFileSync(file, "utf8").includes("sourceMappingURL")) pointing.push(relative(verifyDir, file).split(sep).join("/"));
  }
  if (pointing.length > 0) {
    fail(
      `${String(pointing.length)} packed file(s) still name a sourceMappingURL with no .map shipped to answer it:\n  ` +
        `${pointing.slice(0, 10).join("\n  ")}`,
    );
  }
} finally {
  rmSync(verifyDir, { recursive: true, force: true });
}

console.error(
  `packed ${report.name}@${report.version} — ${String(report.entryCount)} files, ${(report.size / 1024).toFixed(0)} KB ` +
    `(${(report.unpackedSize / 1024).toFixed(0)} KB unpacked), every one compiled from this tree and TRACKED ` +
    `(${String(stripped)} sourceMappingURL pointer(s) stripped, none remain in the tarball)`,
);
console.log(tarball);
