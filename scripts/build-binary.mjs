#!/usr/bin/env node
/**
 * Build EAgent as a single standalone executable via Node's Single Executable
 * Application (SEA) facility. The engine compiles to an immutable binary; the
 * ecosystem resources (templates/teams/skills/microagents) stay external raw
 * files a user opts into with `/library install`.
 *
 * Recipe: tsc -> esbuild (CJS bundle, with an `import.meta.url` stub so the CJS
 * output cannot crash at load) -> `node --experimental-sea-config` blob ->
 * copy the running `node` -> postject the blob into it (fused) -> re-sign on
 * macOS. esbuild/postject are fetched on demand via `npx` (no committed dep).
 *
 * Output: `bin/eagent` (host platform only — SEA does not cross-compile).
 * Requires Node >= 22 and network access for the first `npx` fetch.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isMac = process.platform === "darwin";
// The fuse sentinel is fixed by Node's SEA spec — postject stamps the blob at it.
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** Run a command inheriting stdio; throws (non-zero exit) fail the build. */
function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts });
}

// Targets posix hosts (macOS proven, Linux via the same recipe without the
// codesign steps); Windows packaging is a follow-on, not handled here.
const work = mkdtempSync(join(tmpdir(), "eagent-sea-"));
const bundle = join(work, "eagent-bundle.cjs");
const blob = join(work, "eagent.blob");
const seaConfig = join(work, "sea-config.json");
const binDir = join(repoRoot, "bin");
const binPath = join(binDir, "eagent");

try {
  // 1. Type-check + emit dist/.
  run("npm", ["run", "build"]);

  // 2. Bundle dist/cli.js to a single CJS file. The `--define` rewrites every
  //    surviving `import.meta.url` to a benign stub so the CJS output (which has
  //    no real import.meta) cannot crash at load; the SEA-aware entry guard fires
  //    via isSea(), not this value.
  run("npx", [
    "--yes",
    "esbuild",
    "dist/cli.js",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    `--define:import.meta.url=${JSON.stringify("file:///eagent-sea.bin")}`,
    `--outfile=${bundle}`,
  ]);

  // 3. Generate the SEA blob from the bundle.
  writeFileSync(
    seaConfig,
    JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }, null, 2),
  );
  run(process.execPath, ["--experimental-sea-config", seaConfig]);

  // 4. Copy the running node as the target binary.
  mkdirSync(binDir, { recursive: true });
  copyFileSync(process.execPath, binPath);
  chmodSync(binPath, 0o755);

  // 5. macOS requires stripping the signature before injecting, re-signing after.
  if (isMac) run("codesign", ["--remove-signature", binPath]);

  // 6. Inject the blob into the binary at the fuse sentinel.
  const postjectArgs = [
    "--yes",
    "postject",
    binPath,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    FUSE,
  ];
  if (isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA");
  run("npx", postjectArgs);

  // 7. Re-sign on macOS (ad-hoc) so Gatekeeper will run the modified binary.
  if (isMac) run("codesign", ["--sign", "-", binPath]);

  console.log(`\n✓ Built ${binPath}`);
  run("du", ["-h", binPath]);
  console.log("\nRun it: printf 'hi\\n' | bin/eagent -p mock");
} finally {
  rmSync(work, { recursive: true, force: true });
}
