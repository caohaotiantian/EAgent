/**
 * The engine's dependency charter, enforced rather than asserted in prose.
 *
 * `@eagent/core` may depend on `jiti` at runtime and on nothing else. It must not import a UI
 * framework anywhere, must not ship a terminal-client bin, and must not advertise one from
 * `src/`. The terminal client itself was deleted 2026-08-25 — the operator surface is the
 * browser — so these checks now guard against its RETURN rather than against its leakage.
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
  // There is no TUI any more. These assertions stay because they name the exact shapes that
  // would drag a UI framework back onto the engine's load path — a bin, a build script, a
  // `.tsx` glob, a `jsx` compiler option — and each is cheaper to refuse than to remove twice.
  assert.equal(pkg.bin?.["eagent-tui"], undefined, "there is no tui bin");
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


test("AC5: THERE IS NO TERMINAL CLIENT, and no route back to one", () => {
  // This test used to assert the opposite — that `tui/` EXISTS and is the only place ink and
  // react may appear. The terminal client is deleted: the operator surface is the browser, and
  // a second rich client is a second thing to keep consistent with the HTTP contract.
  //
  // Inverted rather than removed, because the property worth keeping is the one the old test was
  // really protecting: **no UI framework on the engine's load path.** That was true when the
  // dependency arrow pointed one way; it is true more cheaply when there is no second package to
  // point at all. A deleted directory silently coming back as a dependency is exactly what a
  // guard is for.
  assert.equal(existsSync(join(repoRoot, "tui")), false, "the tui/ package was deleted; it must not return");

  for (const rel of ["package.json", "package-lock.json"]) {
    const p = join(repoRoot, rel);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const name of BANNED_PACKAGES) {
      assert.doesNotMatch(text, new RegExp(`"${name.replace("/", "\\/")}"\\s*:`), `${rel} must not name ${name}`);
    }
  }

  // No source file anywhere in this package may import a UI framework or reach for a tui path.
  for (const file of walk(join(repoRoot, "src"), (n) => /\.tsx?$/.test(n))) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, FORBIDDEN_IMPORT, `${relative(repoRoot, file)} must not import ink/react`);
    assert.doesNotMatch(
      src,
      /from\s+["'][^"']*\/tui\//,
      `${relative(repoRoot, file)} must not import from a tui/ path`,
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

test("AC15: ONE package, and the `eagent` bin name is deliberately unclaimed", () => {
  // This asserted a two-package lockstep release: `@eagent/core` the library, `eagent` the
  // installable TUI, same version, `release-tui.mjs` rewriting the `file:..` dependency at
  // publish time. All three are gone with the terminal client.
  //
  // What replaces it is narrower on purpose. The engine keeps `eagent-headless`, its own name,
  // and **nothing claims `eagent`** — that name belonged to the product users installed, and
  // which package should own it now is a packaging decision for the redesign, not a default to
  // back into here. A test that invented an answer would make the decision by accident.
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    name?: string;
    bin?: Record<string, string>;
  };

  assert.equal(root.name, "@eagent/core", "the engine is the scoped library");
  assert.ok(root.bin?.["eagent-headless"], "the machine entry keeps its own name");
  assert.equal(root.bin?.["eagent"], undefined, "the `eagent` name is unclaimed until the redesign assigns it");
  assert.equal(existsSync(join(repoRoot, "scripts", "release-tui.mjs")), false, "the lockstep release script is gone");
});
