/**
 * The repo's own gate, run against a tree that does not build.
 *
 * `npm run check` is THE gate, and its first arm is `tsc -b`. `tsc -b` is INCREMENTAL, and
 * its up-to-date test is a TIMESTAMP COMPARISON, not a read of the inputs: a project whose
 * newest input is older than its oldest output is "up to date" whatever the input now says.
 * So `tsc -b` can exit 0 having compiled nothing. Nothing downstream notices — `node --test`
 * strips types rather than checking them, and `scripts/check-surface.mjs` reads
 * `packages/core/dist/index.d.ts`, which is exactly the file that was not re-emitted.
 *
 * Reproduced against the real scripts before this test existed, in a replica of this repo's
 * tsconfig layout. Source edited, its mtime moved behind `dist/`:
 *
 *     $ tsc -b .                      # the typecheck script's first arm
 *     exit=0
 *     $ node scripts/check-surface.mjs
 *     surface guard ok: 1 public exports, unchanged
 *     exit=0
 *
 * …with `export const BRAND_NEW_PUBLIC_EXPORT` sitting in `src/index.ts` and absent from the
 * `.d.ts` the guard had just read. Forcing the build turns the same tree into
 * `surface guard FAILED … added: BRAND_NEW_PUBLIC_EXPORT`. The gate reported success on a
 * tree whose public contract had changed.
 *
 * The mtime is moved here rather than waited for, because the ORDERING is the mechanism and
 * every way of producing it is incidental: a source tree restored from an archive or with
 * `cp -p`/`rsync -t` while `dist/` stayed, a clock that stepped backwards, a filesystem with
 * coarse timestamps, a checkout that preserves times. The fix — building with `--force` —
 * does not depend on which one you hit.
 *
 * HONEST LIMIT on what these two tests prove. The second arm of `typecheck`
 * (`tsc -p packages/core/tsconfig.test.json`) is NOT incremental and does include
 * `src/**\/*.ts`, so an ordinary type error is still caught by it even when the first arm
 * skips — that was checked, not assumed. What the first arm's skip loses is the EMIT, and
 * the emit is what the surface guard is reading. So the reproduced failure is a stale public
 * contract rather than a stale type check, and the first test below is the tripwire for the
 * class rather than a second copy of the same demonstration.
 *
 * These tests read the flags out of the root `package.json` and hand them to the real
 * compiler. They are not a grep for the word `--force`: drop the flag and the compiler
 * genuinely skips the replica, and both assertions below fail on what it did, not on what
 * the script says.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

/** Fixed, so nothing here depends on the wall clock — only on the ORDER of two stamps. */
const BEFORE_THE_BUILD = new Date(1_700_000_000_000);

/**
 * The flags the root `typecheck` script really passes to `tsc -b`.
 *
 * Parsed rather than hardcoded so the test cannot pass against a script that has stopped
 * carrying them. The shape is asserted first: if the first arm stops being `tsc -b` the
 * failure says so, instead of silently checking a compiler invocation nobody runs.
 */
function buildFlags(): readonly string[] {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { readonly scripts?: Record<string, string> };
  const script = pkg.scripts?.["typecheck"];
  assert.ok(script, "the root package.json has no `typecheck` script — re-point this test");
  const first = script.split("&&")[0]!.trim().split(/\s+/);
  assert.deepEqual(
    first.slice(0, 2),
    ["tsc", "-b"],
    `typecheck's first arm is no longer \`tsc -b\` (${script}) — re-point this test at whatever builds dist/`,
  );
  return first.slice(2).filter((t) => t.startsWith("-"));
}

const CLEAN_CHANNELS = [
  "export interface Channel { readonly name: string; readonly value: number; }",
  "export function make(name: string): Channel { return { name, value: 0 }; }",
  "",
].join("\n");

const CLEAN_INDEX = ['import { make } from "./channels.ts";', "export const seed = make(\"x\").value + 1;", ""].join("\n");

/**
 * A replica of this repo's project layout, using THIS repo's tsconfigs.
 *
 * Copied rather than re-typed: a compiler option that changes how staleness behaves (an
 * `incremental`, a `tsBuildInfoFile`, a `composite`) has to reach this test, and a
 * hand-written copy of `tsconfig.base.json` would quietly stop tracking it.
 */
function replica(): string {
  const root = mkdtempSync(join(tmpdir(), "loom-toolchain-gate-"));
  mkdirSync(join(root, "packages", "core", "src"), { recursive: true });
  copyFileSync(join(REPO, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
  // The replica declares its OWN reference list rather than copying the repo's. Copying it
  // coupled this guard to how many packages the monorepo happens to have — adding
  // `packages/eagent` made `tsc -b` fail here on a missing referenced project, which says
  // nothing about the thing under test. What is under test is whether `tsc -b` re-emits
  // `dist/` for a project whose sources are older than its output.
  writeFileSync(join(root, "tsconfig.json"), '{"files":[],"references":[{"path":"./packages/core"}]}\n');
  copyFileSync(join(REPO, "packages", "core", "tsconfig.json"), join(root, "packages", "core", "tsconfig.json"));
  writeFileSync(join(root, "package.json"), '{"name":"replica","private":true,"type":"module","workspaces":["packages/*"]}\n');
  writeFileSync(join(root, "packages", "core", "package.json"), '{"name":"@replica/core","private":true,"type":"module"}\n');
  writeFileSync(join(root, "packages", "core", "src", "channels.ts"), CLEAN_CHANNELS);
  writeFileSync(join(root, "packages", "core", "src", "index.ts"), CLEAN_INDEX);
  return root;
}

interface Build {
  readonly status: number;
  readonly output: string;
}

function build(root: string, flags: readonly string[]): Build {
  const r = spawnSync(process.execPath, [TSC, "-b", root, ...flags], { encoding: "utf8" });
  return { status: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Rewrite a source file and put its mtime BEHIND everything the last build emitted. */
function editBackwards(root: string, file: string, contents: string): void {
  const path = join(root, "packages", "core", "src", file);
  writeFileSync(path, contents);
  utimesSync(path, BEFORE_THE_BUILD, BEFORE_THE_BUILD);
}

test("THE TYPECHECK GATE COMPILES THE TREE IT IS POINTED AT, even when dist/ looks newer than src/", () => {
  assert.ok(existsSync(TSC), `no compiler at ${TSC} — run npm ci`);
  const flags = buildFlags();
  const root = replica();
  try {
    const first = build(root, flags);
    assert.equal(first.status, 0, `the replica does not build clean, so nothing below means anything:\n${first.output}`);

    editBackwards(
      root,
      "channels.ts",
      [
        "export interface Channel { readonly name: string; readonly value: number; }",
        'export function make(name: string): Channel { return { name, value: "not a number" }; }',
        "",
      ].join("\n"),
    );

    const second = build(root, flags);
    assert.notEqual(
      second.status,
      0,
      "the gate compiled nothing and reported success on a tree with a type error in it — " +
        `\`tsc -b\` skipped the project because dist/ is newer than src/. Flags were [${flags.join(" ")}]`,
    );
    assert.match(second.output, /TS2322/, `it failed, but not for the type error:\n${second.output}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("THE TYPECHECK GATE RE-EMITS dist/, which is the file the surface guard reads", () => {
  // The half that actually shipped a hole: `check-surface.mjs` diffs the exported name set
  // out of `packages/core/dist/index.d.ts`, and `ci.yml` says in a comment that typecheck
  // emits it. A skipped build leaves the previous `.d.ts` in place, so the guard compares
  // the pin against a contract that is no longer the code's.
  const flags = buildFlags();
  const root = replica();
  try {
    assert.equal(build(root, flags).status, 0);

    editBackwards(root, "index.ts", CLEAN_INDEX + 'export const BRAND_NEW_PUBLIC_EXPORT = "surface changed";\n');
    const second = build(root, flags);
    assert.equal(second.status, 0, `the edit is legal TypeScript and must build:\n${second.output}`);

    const emitted = readFileSync(join(root, "packages", "core", "dist", "index.d.ts"), "utf8");
    assert.match(
      emitted,
      /BRAND_NEW_PUBLIC_EXPORT/,
      "dist/index.d.ts does not describe src/ — the surface guard would read this file and report the contract unchanged",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
