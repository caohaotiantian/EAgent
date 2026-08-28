/**
 * THE STALENESS GUARD IS ALLOWED TO BE SILENT EXACTLY ONCE, AND NOTHING PINNED THE EDGE OF IT.
 *
 * `scripts/binary-freshness.cjs` refuses when the sources beside the binary have moved. It has
 * one silent case — a copy a user installed, with no sources next to it, which cannot be behind
 * anything. Its header calls that case decidable and says "a source tree that is there but will
 * not read is the undecidable case, and that refuses like the rest."
 *
 * That was not true. The test was `try { statSync(dir).isDirectory() } catch { present = false }`
 * — a bare catch answering the undecidable case with the passing value. Measured on 2026-08-28
 * against a fake repo with the sources genuinely edited, before the fix:
 *
 *     packages/core unreadable (chmod 000), sources STALE   exit=0  stdout=[APP RAN]
 *     packages/core/src is a regular file                   exit=0  stdout=[APP RAN]
 *     packages/core/src is a dangling symlink               exit=0  stdout=[APP RAN]
 *
 * `readme-gaps.test.ts`'s "WHEN IT CANNOT DECIDE IT REFUSES" covers a `readFileSync` failure
 * INSIDE a tree that opened, which is the later branch and was always right. Nothing covered the
 * question of whether the tree is there at all, so this file does — one test per way of being
 * something-other-than-a-readable-directory.
 *
 * WHY NO `chmod` HERE, though EACCES is the case a reviewer actually measured: `readme-gaps`
 * gives the reason for its own construction — a chmod does not raise for root, so a suite run in
 * a container would quietly stop testing anything. Every case below raises for every user.
 * `ENOTDIR` and `EACCES` are the same branch (`err.code !== "ENOENT"`), and `ENOTDIR` is the one
 * that can be produced without privilege, so it is what stands in for the pair.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

const freshness = require_(fileURLToPath(new URL("../../../scripts/binary-freshness.cjs", import.meta.url))) as {
  SOURCE_DIR: string;
  stampFor: (root: string) => unknown;
  banner: (stamp: unknown) => string;
  sourceDirState: (dir: string) => { present: boolean; why: string | null };
};

/**
 * A throwaway repo plus the fake binary, stamped against the sources as they are RIGHT NOW.
 * The "application" is one `console.log`, so `APP RAN` on stdout means the guard let it through.
 */
function fakeRepo(): { root: string; bin: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), "loom-fresh-edge-"));
  const src = join(root, freshness.SOURCE_DIR);
  mkdirSync(join(src, "run"), { recursive: true });
  writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(src, "run", "b.ts"), "export const b = 2;\n");
  mkdirSync(join(root, "bin"), { recursive: true });
  const bin = join(root, "bin", "loom.cjs");
  writeFileSync(bin, `${freshness.banner(freshness.stampFor(root))}\nconsole.log("APP RAN");\n`);
  return { root, bin, src };
}

function runFake(bin: string): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** Every refusal looks the same from outside: non-zero, no application, and it says why. */
function assertRefused(r: { code: number; out: string; err: string }, because: RegExp): void {
  assert.equal(r.code, 1, `must not run: ${JSON.stringify(r.out)}`);
  assert.doesNotMatch(r.out, /APP RAN/, "…and must not reach the application");
  assert.match(r.err, /STALE/, r.err);
  assert.match(r.err, because, r.err);
}

test("A REGULAR FILE where the source tree should be is undecidable, so it refuses", () => {
  // Not "no sources": something is at the path. Nothing here can say whether the binary is
  // behind it, and the old code called that fresh.
  const { bin, src } = fakeRepo();
  rmSync(src, { recursive: true });
  writeFileSync(src, "this is not a source tree");
  assertRefused(runFake(bin), /not a directory/);
});

test("A DANGLING SYMLINK where the source tree should be refuses — `stat` calls that ENOENT", () => {
  // The sharpest one, and the reason the check uses `lstat`: `statSync` follows the link, so this
  // path reported the *shipped copy's* errno. Distinguishing absent from unreadable by errno
  // alone, on a call that follows links, is not enough.
  const { root, bin, src } = fakeRepo();
  rmSync(src, { recursive: true });
  symlinkSync(join(root, "nowhere"), src);
  assertRefused(runFake(bin), /does not resolve/);
});

test("AN ERRNO THAT IS NOT ENOENT refuses — the branch the chmod-000 measurement lands in", () => {
  // `packages/core` as a regular file makes `lstat` on `packages/core/src` throw ENOTDIR, which
  // is the same `err.code !== "ENOENT"` branch an EACCES on any parent directory takes.
  const { root, bin, src } = fakeRepo();
  rmSync(join(root, "packages"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "packages", "core"), "not a directory either");
  assert.equal(freshness.sourceDirState(src).present, true, "something IS at the path");
  assertRefused(runFake(bin), /could not be examined/);
});

test("AND THE ONE SILENT CASE IS STILL SILENT: no sources beside it, so nothing to be behind", () => {
  // The arm that keeps this from becoming a refusal generator. If it ever goes red, `bin/loom`
  // has become undistributable.
  const { root, bin } = fakeRepo();
  rmSync(join(root, "packages"), { recursive: true });
  const r = runFake(bin);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APP RAN/);
  assert.equal(r.err, "", "a binary with no sources beside it says nothing");
});

test("THE SET THAT PASSES IS ONE ERRNO WIDE, asserted on the decision itself and not on a binary", () => {
  // The end-to-end tests above prove the behaviour; this proves the shape of the claim in the
  // header, so a later refactor cannot widen the silent case without turning a test red.
  const { root, src } = fakeRepo();

  assert.deepEqual(freshness.sourceDirState(src), { present: true, why: null }, "a readable directory decides");

  rmSync(join(root, "packages"), { recursive: true });
  assert.equal(freshness.sourceDirState(src).present, false, "ENOENT, and only ENOENT, is the shipped copy");
  assert.equal(freshness.sourceDirState(src).why, null);
});
