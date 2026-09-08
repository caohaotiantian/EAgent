#!/usr/bin/env node
/**
 * Build `bin/loom` — one file, no Node installation required to run it.
 *
 * This is what turns "zero runtime dependencies" from a discipline into a deliverable.
 * The bundle is `dist/cli.js` plus nothing: because `@loom/core` imports only
 * `node:` builtins, esbuild has no third-party code to pull in, and the SEA blob is
 * the application and the runtime and nothing else.
 *
 * esbuild and postject are BUILD-only dependencies. They never appear in
 * `packages/core/package.json`, which is what `check-zero-dep.mjs` enforces — so a
 * library consumer of `@loom/core` downloads neither.
 *
 * The build also stamps the binary with a digest of the sources it compiled, so the
 * thing it produces knows when it has gone stale — see `binary-freshness.cjs` for why
 * that is a startup check inside the binary and not a gate in `npm run check`.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);
const freshness = require("./binary-freshness.cjs");
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const OUT = "bin";
const NAME = process.platform === "win32" ? "loom.exe" : "loom";
const BUNDLE = join(OUT, "loom.bundle.cjs");
const BLOB = join(OUT, "loom.blob");
const TARGET = join(OUT, NAME);

mkdirSync(OUT, { recursive: true });

// ── 0. COMPILE, then photograph the sources ──────────────────────────────────
//
// THIS SCRIPT COMPILES `dist` ITSELF, and that is the whole fix for a binary that certifies
// sources it does not contain. The stamp is a digest of `src`; what goes into the binary is
// `dist`; and the only thing that used to connect them was `distIsBehindSources`, an MTIME
// comparison. mtime cannot decide this and that function's own comment admits it. Anything
// that makes `dist/*.js` newer than `src/*.ts` without recompiling — a `touch`, a `tar -x`,
// an `rsync`, a CI build-cache restore — made the check answer "dist is at least as new",
// after which this script bundled the UNEDITED dist and stamped the EDITED src. The binary
// ran the old code and reported itself fresh forever, and `verify-binary.mjs` passed all four
// of its cases on it, because it also only compares the stamp to src.
//
// Compiling here makes `dist` a function of `src` by construction, so there is no window in
// which the two disagree. `build:binary` used to be `npm run build && node <this>`; the
// compile moved INTO the script because the hazard is running the SCRIPT, and a hazard only
// the wrapper protects against is a hazard.
execFileSync(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-b", "--force"], {
  cwd: repoRoot,
  stdio: "inherit",
});
// KEPT AS THE POST-CONDITION, not deleted. After the line above it can only fire if the
// compile emitted nothing at all, which is exactly the case a build must not stamp.
const behind = freshness.distIsBehindSources(repoRoot);
if (behind !== null) {
  console.error(`build FAILED: ${behind}.`);
  console.error("The `tsc -b --force` above emitted nothing for it — read its output.");
  process.exit(1);
}
// Taken BEFORE the bundle so the digest can only be of a tree at least as old as the
// binary: an edit racing the build makes the result refuse, never falsely pass.
const stamp = freshness.stampFor(repoRoot);

// ── 1. bundle ────────────────────────────────────────────────────────────────
// CJS, because Node's SEA loads a single CommonJS script. The ESM source is
// converted here rather than in the package, so `dist/` stays standard ESM.
await esbuild.build({
  entryPoints: ["packages/core/dist/cli.js"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: BUNDLE,
  // `node:` builtins are provided by the embedded runtime, not bundled.
  external: ["node:*"],
  banner: {
    // The banner is the only code that runs before the application, which is exactly
    // what the freshness check needs — a binary that has aged must refuse before it
    // can answer anything.
    //
    // `import.meta.url` has no CJS equivalent; the CLI uses it only to decide
    // whether it is the entry point, which inside a SEA it always is.
    js: ["const import_meta_url = 'file:///loom';", freshness.banner(stamp)].join("\n"),
  },
  define: { "import.meta.url": "import_meta_url" },
  logLevel: "warning",
});

const bundleBytes = statSync(BUNDLE).size;

// ── 2. verify the bundle pulled in nothing ───────────────────────────────────
const bundled = await esbuild.build({
  entryPoints: ["packages/core/dist/cli.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  metafile: true,
  external: ["node:*"],
  logLevel: "silent",
});
const thirdParty = Object.keys(bundled.metafile.inputs).filter((f) => f.includes("node_modules"));
if (thirdParty.length > 0) {
  console.error("build FAILED: third-party code reached the bundle:");
  for (const f of thirdParty.slice(0, 10)) console.error("  - " + f);
  process.exit(1);
}

// ── 3. SEA blob ──────────────────────────────────────────────────────────────
const seaConfig = join(OUT, "sea-config.json");
writeFileSync(
  seaConfig,
  JSON.stringify({ main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true, useCodeCache: true }, null, 2),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

// ── 4. inject into a copy of the runtime ─────────────────────────────────────
rmSync(TARGET, { force: true });
copyFileSync(process.execPath, TARGET);
chmodSync(TARGET, 0o755);

if (process.platform === "darwin") {
  // A signed binary rejects injected sections; strip the signature, inject, re-sign
  // ad-hoc. Without this the produced file is killed by the kernel on launch.
  try {
    execFileSync("codesign", ["--remove-signature", TARGET], { stdio: "ignore" });
  } catch {
    /* unsigned already */
  }
}

execFileSync(
  process.execPath,
  [
    join("node_modules", "postject", "dist", "cli.js"),
    TARGET,
    "NODE_SEA_BLOB",
    BLOB,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ],
  { stdio: "inherit" },
);

if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--sign", "-", TARGET], { stdio: "ignore" });
  } catch {
    console.error("! codesign failed; the binary may not launch on this machine");
  }
}

rmSync(BUNDLE, { force: true });
rmSync(BLOB, { force: true });
rmSync(seaConfig, { force: true });

const mb = (statSync(TARGET).size / 1024 / 1024).toFixed(1);
console.log(`built ${TARGET} — ${mb} MB (application bundle: ${(bundleBytes / 1024).toFixed(0)} KB, 0 third-party modules)`);
console.log(
  `stamped ${stamp.count} source file(s), ${stamp.digest.slice(0, 12)} — it refuses to run once ${stamp.dir} moves`,
);
