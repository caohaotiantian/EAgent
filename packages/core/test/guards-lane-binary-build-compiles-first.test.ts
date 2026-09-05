/**
 * The binary's stamp certified sources it did not contain, and mtime is why.
 *
 * `build-binary.mjs` bundles `packages/core/dist/*.js` and stamps the digest of
 * `packages/core/src/*.ts`. The only thing that connected the two was
 * `binary-freshness.cjs`'s `distIsBehindSources`, an MTIME comparison — so anything that
 * makes dist newer than src without recompiling (a `touch`, a `tar -x`, an `rsync`, a CI
 * build-cache restore) let the build bundle the OLD code and stamp the NEW source. The
 * artifact then reported itself fresh forever, and `verify-binary.mjs` passed all four of its
 * cases on it, because it also only compares the stamp to src.
 *
 * TWO TESTS, AND THE FIRST IS THE ONE THAT MATTERS. The fix is not a better heuristic: it is
 * that the build compiles `dist` itself, so `dist` is a function of `src` and there is no
 * window. That is a fact about the script's ORDER — compile, then stamp — and this file
 * asserts it on the script's own text rather than by running it, because running it means
 * esbuild, a SEA blob and 115 MB, which is not a unit test. Where a structural assertion is
 * all that is affordable, saying so is part of the assertion.
 *
 * The second test pins the hole the compile closes, so nobody re-derives the mtime rule and
 * calls it sufficient: `distIsBehindSources` still answers "not behind" for an edited source
 * beside a touched dist, and always will, because mtime cannot answer this question.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const freshness = require(join(REPO, "scripts", "binary-freshness.cjs")) as {
  distIsBehindSources: (root: string) => string | null;
};

test("THE BUILD COMPILES dist BEFORE IT STAMPS src, so the two cannot disagree", () => {
  const script = readFileSync(join(REPO, "scripts", "build-binary.mjs"), "utf8");

  const compiledAt = script.indexOf('"-b", "--force"');
  const stampedAt = script.indexOf("freshness.stampFor(");
  const bundledAt = script.indexOf("esbuild.build(");

  assert.ok(compiledAt > 0, "build-binary.mjs must run `tsc -b --force` itself — see its §0");
  assert.ok(stampedAt > 0);
  assert.ok(bundledAt > 0);
  assert.ok(
    compiledAt < stampedAt,
    "the compile must precede the stamp: a stamp taken over src that dist was not compiled from is the defect",
  );
  assert.ok(compiledAt < bundledAt, "the compile must precede the bundle, which reads dist");

  // AND THE WRAPPER MUST NOT BE THE ONLY PROTECTION. `build:binary` was `npm run build && …`,
  // which meant the hazard was running the script directly — exactly what the reproduction did.
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts["build:binary"], "node scripts/build-binary.mjs");
});

test("mtime alone still cannot decide it — which is why the compile is the fix, not a better check", () => {
  const root = mkdtempSync(join(tmpdir(), "loom-binary-freshness-"));
  try {
    mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "core", "dist"), { recursive: true });
    const src = join(root, "packages", "core", "src", "a.ts");
    const dist = join(root, "packages", "core", "dist", "a.js");
    writeFileSync(dist, "export const a = 'THE OLD ANSWER';\n");
    writeFileSync(src, "export const a = 'EDITED, NEVER COMPILED';\n");

    // The control: src really is newer, and the heuristic says so.
    assert.match(String(freshness.distIsBehindSources(root)), /a\.ts is newer than the compiled dist/);

    // Now anything at all rewrites dist's mtime. No recompile happened; the bytes still say
    // THE OLD ANSWER. The heuristic hands back the passing value.
    const later = new Date(Date.now() + 60_000);
    utimesSync(dist, later, later);
    assert.equal(freshness.distIsBehindSources(root), null);
    assert.match(readFileSync(dist, "utf8"), /THE OLD ANSWER/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
