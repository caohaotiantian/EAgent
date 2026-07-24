/**
 * Phase 4 — dependency isolation (design §3, AC9, R3).
 *
 * `ink`/`react` are the repo's first-ever runtime dependencies, sanctioned ONLY
 * for the `src/tui/` front end. This is an import-graph guarantee, not a
 * package.json boundary — so it is enforced by a source scan, not by inspecting
 * dependencies. A stray `ink`/`react` import in the engine (kernel/providers/
 * extensions/host/server/cli/jsonl/engine-render) or in the shared neutral cores
 * (view-model/attribution) would bloat the SEA binary and break the charter; an
 * import in `test/` outside `test/tui/` would drag Ink into the offline suite.
 *
 * A `readFileSync` scan (never shell grep — macOS silently skips source files
 * with non-ASCII glyphs; the repo is full of them), matching the
 * `test/jsonl-adoption.test.ts` precedent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.ts`/`.tsx` file under `dir`, recursively (absolute paths). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `.ts`/`.tsx` file under `rel` (a file or a directory), optionally
 *  excluding a sub-path — used to skip `test/tui/`, the sanctioned Ink home. */
function collect(rel: string, opts: { skip?: string } = {}): string[] {
  const abs = join(repoRoot, rel);
  const files = statSync(abs).isDirectory() ? walk(abs) : [abs];
  const skipAbs = opts.skip ? join(repoRoot, opts.skip) : undefined;
  return skipAbs ? files.filter((f) => !f.startsWith(skipAbs)) : files;
}

// An import of `ink`, `ink-testing-library`, `react`, or a `react/*` subpath,
// as a static `from "…"` or a dynamic `import("…")`.
const FORBIDDEN = /\b(?:from|import)\s*\(?\s*["'](?:ink(?:-testing-library)?|react(?:\/[^"']*)?)["']/;

test("AC9: ink/react are imported ONLY under src/tui/ (engine + shared cores are dependency-free)", () => {
  const engineTargets = [
    ...collect("src/kernel"),
    ...collect("src/providers"),
    ...collect("src/extensions"),
    "src/host.ts",
    "src/server.ts",
    "src/cli.ts",
    "src/jsonl.ts",
    "src/engine-render.ts",
    "src/view-model.ts",
    "src/attribution.ts",
  ].flatMap((t) => (t.startsWith("src/") ? collect(t) : [t]));

  for (const file of engineTargets) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, FORBIDDEN, `${relative(repoRoot, file)} must not import ink/react (engine stays zero-dep, AC9)`);
  }
});

test("AC9: no test outside test/tui/ imports ink/react (the offline suite stays Ink-free)", () => {
  for (const file of collect("test", { skip: "test/tui" })) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, FORBIDDEN, `${relative(repoRoot, file)} must not import ink/react (only test/tui/ may)`);
  }
});
