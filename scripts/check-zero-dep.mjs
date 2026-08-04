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
 * Check 2 uses the TypeScript PARSER, not a regex. The regex version reported
 * `from "${branch}"` inside an error-message template literal as a dependency — a
 * guard with false positives gets disabled, and a guard that can have false
 * positives can also have false negatives.
 *
 * See design/loom/07-CONFIG-DEPLOY.md D12.1.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

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

// ── 2. import specifiers, via the parser ──────────────────────────────────────
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

/** Every module specifier the file actually imports from, statically or dynamically. */
function moduleSpecifiers(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true);
  const out = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

let scanned = 0;
for (const file of walk(join(CORE, "src"))) {
  scanned++;
  for (const spec of moduleSpecifiers(file)) {
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
console.log(`zero-dep guard ok: ${CORE} has no runtime dependencies (${scanned} files scanned)`);
