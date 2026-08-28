/**
 * THE SAME HOLE, ONE PATH COMPONENT UP — and the header claimed the whole path.
 *
 * `scripts/binary-freshness.cjs` may be silent in exactly one case: no sources beside the
 * binary, so there is nothing it could be behind. Its header states that case as "`ENOENT` from
 * `lstat` on the source path — **no directory entry of any kind**". On 2026-08-28 the check was
 * fixed to stop `statSync` from following a dangling symlink AT `packages/core/src`, and the
 * sentence was written then. It was still a claim about the whole path checked only at its last
 * component: `lstat` reports `ENOENT` for a path whose PARENT does not resolve exactly as it does
 * for one that simply is not there. Measured against a fake repo with the sources genuinely
 * edited, before this fix:
 *
 *     packages is a DANGLING symlink, sources STALE   exit=0  stdout=[APP RAN]
 *     packages symlinks to a FILE,    sources STALE   exit=0  stdout=[APP RAN]
 *
 * A directory entry did exist at `packages`; it merely did not resolve. That is the undecidable
 * case wearing the passing answer, which is the defect this guard was built to close, and it had
 * now cost the same guard twice.
 *
 * THE FIX IS `ancestorState`, and the header now says "all the way up" rather than restating a
 * claim the code checks at one component. A guard's header must not claim more than its code
 * does; that is the whole class.
 *
 * The two silent-case controls are here too, because a widening that turns `bin/loom` into a
 * refusal generator would be worse than the hole: a real directory above ends the walk, and a
 * repo with `packages` genuinely absent still says nothing. Every case below raises for every
 * user — no `chmod`, for the reason `binary-freshness-absent-or-unreadable.test.ts` gives.
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
  sourceDirState: (dir: string, root?: string) => { present: boolean; why: string | null };
};

/**
 * A throwaway repo plus the fake binary, stamped against the sources as they are RIGHT NOW, then
 * EDITED — so every case below is a binary that really is stale, and a silent pass really is the
 * defect rather than an accident of the fixture.
 */
function staleRepo(t: { after: (fn: () => void) => void }): { root: string; bin: string; src: string } {
  const root = mkdtempSync(join(tmpdir(), "loom-fresh-anc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, freshness.SOURCE_DIR);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
  mkdirSync(join(root, "bin"), { recursive: true });
  const bin = join(root, "bin", "loom.cjs");
  writeFileSync(bin, `${freshness.banner(freshness.stampFor(root))}\nconsole.log("APP RAN");\n`);
  // THE EDIT. Without it a silent pass and a correct pass look the same from outside.
  writeFileSync(join(src, "a.ts"), "export const a = 2;\n");
  return { root, bin, src };
}

function runFake(bin: string): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function assertRefused(r: { code: number; out: string; err: string }, because: RegExp): void {
  assert.equal(r.code, 1, `must not run: ${JSON.stringify(r.out)}`);
  assert.doesNotMatch(r.out, /APP RAN/, "…and must not reach the application");
  assert.match(r.err, /STALE/, r.err);
  assert.match(r.err, because, r.err);
}

/** The control every case here needs: with the tree intact, the edit IS caught. */
test("THE PREMISE — an edited source tree that reads normally already refuses", (t) => {
  const { bin } = staleRepo(t);
  assertRefused(runFake(bin), /the sources have changed/);
});

test("AN INTERMEDIATE DANGLING SYMLINK IS NOT AN ABSENT SOURCE TREE", (t) => {
  const { root, bin, src } = staleRepo(t);
  rmSync(join(root, "packages"), { recursive: true });
  // `packages` exists as a directory ENTRY and resolves to nothing. `lstat` on
  // `packages/core/src` therefore throws ENOENT — the shipped copy's errno.
  symlinkSync(join(root, "nowhere"), join(root, "packages"));

  assert.equal(freshness.sourceDirState(src, root).present, true, "something IS on the path");
  assertRefused(runFake(bin), /does not resolve/);
});

test("WHICH ARM ANSWERS, pinned — an intermediate symlink to a FILE was never the ancestor walk", (t) => {
  // The control that keeps this file honest about its own coverage. It is tempting to read
  // "packages is a symlink to a file" as a second case the walk closes; it is not. On POSIX
  // `lstat` on the CHILD of a non-directory answers ENOTDIR, so `sourceDirState`'s
  // `errno !== "ENOENT"` arm has already refused before `ancestorState` is reached — which is
  // where it was refused before this change too. Asserted on the sentence, so a refactor that
  // reordered the two arms could not quietly hand this case to the other one.
  const { root, bin, src } = staleRepo(t);
  rmSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "a-file"), "not a tree");
  symlinkSync(join(root, "a-file"), join(root, "packages"));

  assert.match(
    String(freshness.sourceDirState(src, root).why),
    /^the source path could not be examined \(ENOTDIR/,
    "the errno arm, not the ancestor walk",
  );
  assertRefused(runFake(bin), /could not be examined/);
});

test("THE SILENT CASE SURVIVES THE WIDENING — a real directory above ends the walk", (t) => {
  // The arm that keeps this from becoming a refusal generator. `packages` is a genuine, empty
  // directory: the sources are absent, nothing on the path is ambiguous, and a distributed
  // binary must say nothing.
  const { root, bin, src } = staleRepo(t);
  rmSync(join(root, "packages"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });

  assert.deepEqual(freshness.sourceDirState(src, root), { present: false, why: null });
  const r = runFake(bin);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APP RAN/);
  assert.equal(r.err, "", "a binary with no sources beside it says nothing");
});

test("…AND SO DOES THE CASE WHERE THE WHOLE CHAIN IS GONE, which is what a user installs", (t) => {
  const { root, bin, src } = staleRepo(t);
  rmSync(join(root, "packages"), { recursive: true });

  assert.deepEqual(freshness.sourceDirState(src, root), { present: false, why: null });
  const r = runFake(bin);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /APP RAN/);
  assert.equal(r.err, "");
});
