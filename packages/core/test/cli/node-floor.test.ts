/**
 * AN INSTALLED `loom` ON A NODE BELOW THE FLOOR SAYS SO IN ONE SENTENCE, and says what it is.
 *
 * Measured before `bin.ts` existed, on the tarball's `dist/cli.js`: Node 22.1 died at ESM link time
 * with `ERR_UNKNOWN_BUILTIN_MODULE` and a stack trace — `node:sqlite` is a static import, so no
 * check anywhere in `cli.ts` could run first — and `loom --version` printed the whole usage and
 * exited 0 on every build, so the probe a stranger reaches for first could not tell one install
 * from another.
 *
 * These drive `src/bin.ts` as a real child. The old Nodes are SIMULATED with a preload, because a
 * test that needs a second Node installed is a test CI skips: `process.versions.node` is a
 * configurable property, and a loader hook can make `node:sqlite` unresolvable. The real Node 22.1
 * run is pasted in the lane's report and repeatable with any fnm/nvm Node 22.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BIN_SRC = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
  version: string;
  bin: Record<string, string>;
  engines: { node: string };
};

function node(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [...args], { timeout: 30_000, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null;
      resolve({ code, stdout, stderr });
    });
  });
}

const PRETEND_22 = 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.1.0"})';
const NO_SQLITE =
  "data:text/javascript,import{register}from\"node:module\";" +
  'register("data:text/javascript,export async function resolve(s,c,n){if(s===\\"node:sqlite\\")throw new Error(\\"gone\\");return n(s,c)}")';

test("THE FLOOR `bin.ts` CHECKS IS THE ONE `engines` DECLARES, and the installed `bin` is `bin.js`", () => {
  const src = readFileSync(BIN_SRC, "utf8");
  const floor = /^const FLOOR = (\d+);$/m.exec(src);
  assert.ok(floor, "FLOOR moved — this test reads it from the source");
  const engines = /^>=(\d+)\.0\.0$/.exec(PKG.engines.node);
  assert.ok(engines, `engines.node is ${PKG.engines.node}; this test expects ">=N.0.0"`);
  assert.equal(floor[1], engines[1], "bin.ts refuses below a different Node than package.json declares");
  assert.deepEqual(PKG.bin, { loom: "./dist/bin.js" });
});

test("`bin.ts` HAS NO STATIC IMPORT — a static `node:sqlite` anywhere below it fails before it runs", () => {
  const sf = ts.createSourceFile(BIN_SRC, readFileSync(BIN_SRC, "utf8"), ts.ScriptTarget.ESNext, true);
  const staticImports = sf.statements.filter(
    (s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s) || (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined),
  );
  assert.deepEqual(staticImports.map((s) => s.getText(sf)), []);
});

test("ON THE FLOOR, `loom --version` prints `loom <version>` ONCE and exits 0", async () => {
  // ONCE: `cli.ts` also starts itself when it is the entry point, so a `bin.ts` import that it
  // mistook for one would run `main` twice and print the line twice.
  const r = await node([BIN_SRC, "--version"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `loom ${PKG.version}\n`);
});

test("...AND THROUGH A SYMLINK named `loom`, which is what npm's `bin` writes on POSIX", async () => {
  const d = mkdtempSync(join(tmpdir(), "loom-floor-link-"));
  try {
    // Named `.ts` so Node type-strips it; the basename still differs from `cli`, which is the case
    // `startedAsTheEntryPoint` has to answer "no" to here.
    const link = join(d, "loom.ts");
    symlinkSync(BIN_SRC, link);
    const r = await node([link, "--version"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `loom ${PKG.version}\n`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("BELOW THE FLOOR it refuses in one sentence naming both versions, exit 2, and runs nothing", async () => {
  const r = await node(["--import", PRETEND_22, BIN_SRC, "--version"]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stdout, "", "the CLI must not have run");
  assert.match(r.stderr, /^loom needs Node\.js 24 or newer, and this is Node\.js 22\.1\.0 \(.+\); install Node\.js 24 or newer and run it again\.\n$/);
});

test("ON THE FLOOR WITHOUT `node:sqlite` it refuses too, rather than crashing at link time", async () => {
  const r = await node(["--import", NO_SQLITE, BIN_SRC, "--version"]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /^loom needs a Node\.js that can load node:sqlite/);
  assert.equal(r.stderr.split("\n").filter((l) => l !== "").length, 1, `one sentence, not a stack:\n${r.stderr}`);
});
