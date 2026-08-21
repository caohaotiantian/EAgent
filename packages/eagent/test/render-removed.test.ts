/**
 * AC11 — `src/render/` is gone and nothing imports it.
 *
 * A `readFileSync` source-scan (NOT shell grep, which silently skips files
 * containing ◆/→/σ — the CLAUDE.md macOS gotcha): the directory no longer exists,
 * and no `src/` or `test/` file imports a `../render/*` module. The reducer, the
 * attribution adapter, and the terminal seam that briefly lived at `src/` were
 * themselves removed with the display layer; this stays as a cheap permanent pin
 * that the old directory cannot come back.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("src/render/ no longer exists", () => {
  assert.equal(existsSync(join(repoRoot, "src", "render")), false, "the render/ directory was removed");
});

test("no src/ or test/ file imports a removed render/ module", () => {
  const files = [...sourceFiles(join(repoRoot, "src")), ...sourceFiles(join(repoRoot, "test"))];
  const importsRender = /\bfrom\s+["'][^"']*\/render\/[^"']*["']/;
  for (const path of files) {
    assert.doesNotMatch(readFileSync(path, "utf8"), importsRender, `${path} imports a removed render/ module`);
  }
});
