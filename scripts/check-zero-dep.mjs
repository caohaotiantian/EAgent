#!/usr/bin/env node
/**
 * Guard: @loom/core has ZERO runtime dependencies.
 *
 * This is the constraint that keeps the single-binary deployment possible and keeps
 * a library embedder from downloading a UI framework. It is checked two ways,
 * because either alone is bypassable:
 *
 *   1. `dependencies` in packages/core/package.json must be empty.
 *   2. No source file under packages/core/src may import a bare specifier that is
 *      not a `node:`-prefixed builtin.
 *
 * See design/loom/07-CONFIG-DEPLOY.md D12.1.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CORE = "packages/core";
const failures = [];

// ── 1. declared dependencies ──────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
if (deps.length > 0) {
  failures.push(`${CORE}/package.json declares runtime dependencies: ${deps.join(", ")}`);
}
if (Object.keys(pkg.peerDependencies ?? {}).length > 0) {
  failures.push(`${CORE}/package.json declares peerDependencies`);
}

// ── 2. import specifiers ──────────────────────────────────────────────────────
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

// Matches `from "x"`, `import "x"`, and `import("x")`.
const SPECIFIER = /(?:\bfrom\s*|(?:^|[^.\w])import\s*(?:\(\s*)?)["']([^"']+)["']/g;

for (const file of walk(join(CORE, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(SPECIFIER)) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative
    if (spec.startsWith("node:")) continue; // builtin, explicitly prefixed
    failures.push(`${file}: imports bare specifier "${spec}" (core must be zero-dep)`);
  }
}

if (failures.length > 0) {
  console.error("zero-dep guard FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`zero-dep guard ok: ${CORE} has no runtime dependencies`);
