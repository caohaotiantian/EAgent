/**
 * Permanent zero-dep + no-TUI surface pin (design 2026-07-27-drop-ink-tui AC1/AC2/AC8).
 *
 * Replaces the deleted test/tui-isolation.test.ts: the engine may only depend on
 * `jiti` at runtime, must not import ink/react anywhere, must not ship eagent-tui,
 * and must not advertise a removed rich-TUI bin from src/.
 *
 * Uses readFileSync walks (never bare shell grep — macOS silently skips sources
 * with non-ASCII glyphs).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string, pred: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walk(full, pred));
    } else if (pred(entry.name)) out.push(full);
  }
  return out;
}

const FORBIDDEN_IMPORT =
  /\b(?:from|import)\s*\(?\s*["'](?:ink(?:-testing-library)?|react(?:\/[^"']*)?)["']/;

const BANNED_PACKAGES = ["ink", "react", "@types/react", "ink-testing-library"] as const;

test("AC1: runtime dependencies are only jiti; no ink/react packages", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const runtime = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(
    runtime.filter((k) => k !== "jiti"),
    [],
    `runtime dependencies must be ⊆ { jiti }; found: ${runtime.join(", ") || "(none)"}`,
  );
  assert.ok(runtime.includes("jiti"), "jiti must remain the sole sanctioned runtime dep");

  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const name of BANNED_PACKAGES) {
    assert.equal(all[name], undefined, `package.json must not list ${name}`);
  }
});

test("AC1: no ink/react imports under src/ or test/", () => {
  const files = [
    ...walk(join(repoRoot, "src"), (n) => /\.(tsx?|jsx?|mjs)$/.test(n)),
    ...walk(join(repoRoot, "test"), (n) => /\.(tsx?|jsx?|mjs)$/.test(n)),
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      FORBIDDEN_IMPORT,
      `${relative(repoRoot, file)} must not import ink/react`,
    );
  }
});

test("AC2: no eagent-tui bin, build:tui/test:tui scripts, tsx globs, or tui dirs", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.equal(pkg.bin?.["eagent-tui"], undefined, "no eagent-tui bin");
  assert.equal(pkg.scripts?.["build:tui"], undefined, "no build:tui script");
  assert.equal(pkg.scripts?.["test:tui"], undefined, "no test:tui script");
  assert.ok(
    !(pkg.scripts?.test ?? "").includes("test.tsx") && !(pkg.scripts?.test ?? "").includes(".tsx"),
    "default test script must not include a *.test.tsx glob",
  );

  assert.equal(existsSync(join(repoRoot, "src/tui")), false, "src/tui must not exist");
  assert.equal(existsSync(join(repoRoot, "test/tui")), false, "test/tui must not exist");

  const tsxFiles = [
    ...walk(join(repoRoot, "src"), (n) => n.endsWith(".tsx")),
    ...walk(join(repoRoot, "test"), (n) => n.endsWith(".tsx")),
  ];
  assert.deepEqual(tsxFiles.map((f) => relative(repoRoot, f)), [], "no .tsx under src/ or test/");

  for (const name of ["tsconfig.json", "tsconfig.test.json"]) {
    const cfg = JSON.parse(readFileSync(join(repoRoot, name), "utf8")) as {
      compilerOptions?: { jsx?: string };
      include?: string[];
    };
    assert.equal(cfg.compilerOptions?.jsx, undefined, `${name} must not set jsx`);
    const includes = cfg.include ?? [];
    assert.ok(
      !includes.some((g) => g.includes(".tsx")),
      `${name} include must not list .tsx globs: ${includes.join(", ")}`,
    );
  }
});

test("AC8: src/ must not mention shouldSuggestTui or eagent-tui", () => {
  const files = walk(join(repoRoot, "src"), (n) => /\.(tsx?|jsx?|mjs)$/.test(n));
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.ok(!src.includes("shouldSuggestTui"), `${relative(repoRoot, file)} must not contain shouldSuggestTui`);
    assert.ok(!src.includes("eagent-tui"), `${relative(repoRoot, file)} must not contain eagent-tui`);
  }
});

test("AC4: server header still documents monitor routes + session summary", () => {
  const s = readFileSync(join(repoRoot, "src/server.ts"), "utf8");
  for (const line of [
    "GET    /sessions",
    "GET    /sessions/:id",
    "GET    /sessions/:id/events",
    "POST   /sessions/:id/stop",
    "GET    /events",
  ]) {
    assert.ok(s.includes(line), `src/server.ts header must document ${line}`);
  }
});

