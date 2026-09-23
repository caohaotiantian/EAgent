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
 *      `src/**\/*.ts`. The fix it names is `rm -rf packages/core/dist` — never a silent delete here.
 *   3. `npm pack` the core workspace into `--out DIR`, lifecycle scripts off (the package declares
 *      none; `check-zero-dep.mjs` forbids them).
 *   4. CHECK WHAT WAS PACKED against `files` — the entry points, README and LICENSE are in, and no
 *      source map (they point at a `src/` the tarball does not carry) and no `.tsbuildinfo` is.
 *
 * It publishes nothing and touches no registry. `private: true` stays in `package.json`; removing
 * it is the maintainer's publish act, and `DESIGN.md` Sequence item 29 records what closes then.
 *
 *     node scripts/pack.mjs --out DIR     → DIR/caohaotiantian-loom-<version>.tgz, path on stdout
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
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

// ── 2. every shipped file has a source ────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const orphans = [];
let shipped = 0;
for (const file of walk(DIST)) {
  const rel = relative(DIST, file);
  const stem = rel.endsWith(".d.ts") ? rel.slice(0, -".d.ts".length) : rel.endsWith(".js") ? rel.slice(0, -".js".length) : undefined;
  if (stem === undefined) continue; // maps and .tsbuildinfo — `files` keeps them out, step 4 checks
  shipped++;
  if (!existsSync(join(SRC, `${stem}.ts`))) orphans.push(`packages/core/dist/${rel.split(sep).join("/")}`);
}
if (shipped === 0) fail("packages/core/dist holds nothing to ship — the compile above emitted nothing");
if (orphans.length > 0) {
  fail(
    `${String(orphans.length)} file(s) in dist have no source in packages/core/src, so they would ship code this tree ` +
      `does not contain:\n  ${orphans.join("\n  ")}\nRemove the stale output and pack again: rm -rf packages/core/dist`,
  );
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

console.error(
  `packed ${report.name}@${report.version} — ${String(report.entryCount)} files, ${(report.size / 1024).toFixed(0)} KB ` +
    `(${(report.unpackedSize / 1024).toFixed(0)} KB unpacked), every one compiled from this tree`,
);
console.log(tarball);
