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
  // The TUI ships from `tui/`, which has its own bin and its own scripts. The
  // root package must not grow a parallel set — that is what would drag ink back
  // into the engine's dependency tree.
  assert.equal(pkg.bin?.["eagent-tui"], undefined, "the tui bin belongs to tui/package.json");
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


test("AC5: tui/ is the ONLY place ink and react may appear", () => {
  // Topology: the published `eagent` command IS the TUI package, and it depends
  // on `@eagent/core` — the engine, which stays embeddable and dependency-free.
  // The boundary that makes the whole topology work. The engine stays embeddable
  // — a library consumer of `eagent` must never download React — while the TUI
  // package is free to take whatever it needs.
  const tuiPkgPath = join(repoRoot, "tui", "package.json");
  assert.ok(existsSync(tuiPkgPath), "tui/package.json exists");

  const tui = JSON.parse(readFileSync(tuiPkgPath, "utf8")) as {
    private?: boolean;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const tuiDeps = { ...(tui.dependencies ?? {}), ...(tui.devDependencies ?? {}) };
  for (const name of ["ink", "react"] as const) {
    assert.ok(tuiDeps[name], `tui/ declares ${name}`);
  }
  assert.ok(tui.dependencies?.["@eagent/core"], "tui/ depends on the engine, not the reverse");

  // No engine file may import from the TUI package: the dependency arrow points
  // one way, and reversing it would put React on the engine's load path.
  for (const file of walk(join(repoRoot, "src"), (n) => /\.tsx?$/.test(n))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /from\s+["'][^"']*\/tui\//,
      `${relative(repoRoot, file)} must not import from tui/`,
    );
  }
});

test("AC15: the SEA binary bundles the HEADLESS entry, and says so", () => {
  // D6's accepted divergence, enforced rather than incidental: `yoga-layout`
  // ships a WASM artifact Node's SEA facility cannot embed without a separate
  // asset-injection step, so `bin/eagent` is machine-only. A future change that
  // pointed the bundler at the TUI would silently ship a broken binary.
  const script = readFileSync(join(repoRoot, "scripts", "build-binary.mjs"), "utf8");

  assert.match(script, /dist\/cli\.js/, "the bundler entry is the headless CLI");
  assert.doesNotMatch(script, /tui/, "the TUI is not bundled");

  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /headless/, "and the README says the binary is headless");
});

test("AC15: the two packages are named and wired for a lockstep release", () => {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
  };
  const tui = JSON.parse(readFileSync(join(repoRoot, "tui", "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
  };

  assert.equal(root.name, "@eagent/core", "the engine is the scoped library");
  assert.equal(tui.name, "eagent", "the product users install is the TUI");
  assert.equal(tui.bin?.["eagent"], "./dist/cli.js", "`eagent` runs the TUI");
  assert.equal(root.bin?.["eagent"], undefined, "the engine does not also claim the name");
  assert.ok(root.bin?.["eagent-headless"], "the machine entry keeps its own name");
  assert.equal(root.version, tui.version, "they release in lockstep");
});
