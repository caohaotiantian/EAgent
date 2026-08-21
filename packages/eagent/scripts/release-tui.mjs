#!/usr/bin/env node
/**
 * Prepare `tui/package.json` for publication.
 *
 * During development `tui/` depends on the engine through `"@eagent/core":
 * "file:.."`, which npm resolves to a symlink. A `file:` range is meaningless to
 * anyone installing from the registry, so it must be rewritten to the real
 * version before publishing — and the two packages release in lockstep, so that
 * version is always the root's.
 *
 * Run with `--check` in CI to verify the versions agree without writing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkgPath = join(repoRoot, "package.json");
const tuiPkgPath = join(repoRoot, "tui", "package.json");

const root = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const tui = JSON.parse(readFileSync(tuiPkgPath, "utf8"));

if (root.version !== tui.version) {
  console.error(`version mismatch: ${root.name}@${root.version} vs ${tui.name}@${tui.version}`);
  console.error("the two packages release in lockstep; bump both.");
  process.exit(1);
}

if (process.argv.includes("--check")) {
  console.log(`versions agree: ${root.version}`);
  process.exit(0);
}

tui.dependencies["@eagent/core"] = root.version;
writeFileSync(tuiPkgPath, JSON.stringify(tui, null, 2) + "\n");
console.log(`pinned @eagent/core to ${root.version} in tui/package.json`);
