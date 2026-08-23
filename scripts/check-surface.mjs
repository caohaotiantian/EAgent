#!/usr/bin/env node
/**
 * Guard: the public surface of @loom/core is pinned.
 *
 * EAgent pinned a kernel LINE COUNT, which taxed correct primitives as much as
 * incidental ones — the ceiling had to be raised four times. Loom pins the exported
 * NAME SET instead: adding a public export is a deliberate, reviewed act; adding 300
 * lines inside an existing implementation is not policed, because it shouldn't be.
 *
 * Update `surface.json` in the same commit that adds an export, and the diff will
 * show a reviewer exactly what grew.
 *
 * WHAT THIS PINS IS THE NAME SET, AND NOTHING ELSE. Not signatures, not arity, not the
 * members of an exported union or tuple, not whether a name is a value or a type — the
 * mapping is `symbol.getName()`, so `export declare const VERSION` and `export type VERSION`
 * produce identical output. The failure text below says "(REMOVAL IS BREAKING)", which is
 * true of a removed NAME and says nothing about a narrowed one. That is a deliberate
 * boundary rather than a hole to close here: the two `tsc` projects in `npm run typecheck`
 * are the first `&&` arm of `npm run check` and catch shape changes by USING them — every
 * exported class is constructed somewhere, so a demotion fails the gate before this script
 * runs. 01-INTERFACES.md states the same boundary for readers of the design.
 *
 * THAT COMPENSATING CLAIM IS ITSELF GATED, by
 * `packages/core/test/surface-shape-is-covered.test.ts`. It used to carry a count here — "35 of
 * the 38 exported classes" — which had drifted to 37 of 40 by the time anybody checked, and a
 * class constructed NOWHERE would have left this paragraph covering less than it says while
 * still reading true. The count is gone; the property is a test.
 *
 * IT READS `dist/`, SO IT IS ONLY AS FRESH AS THE BUILD. `npm run typecheck` therefore
 * builds with `--force`: `tsc -b` decides by comparing timestamps, and a skipped build left
 * this script diffing the pin against a `.d.ts` that no longer described `src/` — reproduced
 * as `surface guard ok: … unchanged` with an unpinned public export sitting in the tree.
 * `packages/core/test/toolchain-gate.test.ts` is that reproduction, kept.
 *
 * See design/loom/01-INTERFACES.md, "The minimalism guard, corrected".
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PIN = "scripts/surface.json";
const ENTRY = "packages/core/dist/index.d.ts";
const WRITE = process.argv.includes("--write");

if (!existsSync(ENTRY)) {
  console.error(`surface guard: ${ENTRY} not found — run \`npm run build\` first.`);
  process.exit(1);
}

// Ask the compiler, not a regex: re-exported names from the barrel's own graph are
// only visible after type resolution.
const script = `
import ts from "typescript";
const program = ts.createProgram(["${ENTRY}"], { noEmit: true, skipLibCheck: true });
const checker = program.getTypeChecker();
const sf = program.getSourceFile("${ENTRY}");
const sym = checker.getSymbolAtLocation(sf);
const names = sym ? checker.getExportsOfModule(sym).map((s) => s.getName()) : [];
console.log(JSON.stringify(names.sort()));
`;
const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
  encoding: "utf8",
  cwd: process.cwd(),
});
const actual = JSON.parse(out.trim());

if (WRITE) {
  writeFileSync(PIN, JSON.stringify(actual, null, 2) + "\n");
  console.log(`surface guard: pinned ${actual.length} exports to ${PIN}`);
  process.exit(0);
}

if (!existsSync(PIN)) {
  console.error(`surface guard: ${PIN} missing — run \`node scripts/check-surface.mjs --write\``);
  process.exit(1);
}

const expected = JSON.parse(readFileSync(PIN, "utf8"));
const added = actual.filter((n) => !expected.includes(n));
const removed = expected.filter((n) => !actual.includes(n));

if (added.length === 0 && removed.length === 0) {
  console.log(`surface guard ok: ${actual.length} public exports, unchanged`);
  process.exit(0);
}

console.error("surface guard FAILED — the public contract of @loom/core changed.");
if (added.length) console.error("  added:   " + added.join(", "));
if (removed.length) console.error("  removed: " + removed.join(", ") + "  (REMOVAL IS BREAKING)");
console.error(`\nIf intentional: node scripts/check-surface.mjs --write, and commit ${PIN}.`);
process.exit(1);
