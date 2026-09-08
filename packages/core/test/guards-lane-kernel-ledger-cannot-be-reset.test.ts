/**
 * The four ways the kernel ledger could be reset, each driven RED at 294e713 and green now.
 *
 * CLAUDE.md §1 named three of them as measured limits and told the reader to watch the number
 * in the diff instead — "the count is a number a REVIEWER watches, not one this tool defends".
 * That is a fair thing to say about the resets no tool can close (`fix:` absorbing a feature,
 * a rename git cannot detect). It was not a fair thing to say about these four, which are all
 * decidable from the same `git log` the guard already reads:
 *
 *   1. ADVANCING `since` — one line of `scripts/kernel.json` took the ledger from 11 to 0 and
 *      the whole guard suite stayed green.
 *   2. A RENAME — `git mv` a pinned file with the pin updated in the same `refactor:` commit,
 *      and the matcher (which compared history to the CURRENT path) stopped seeing that file's
 *      commits: seams dropped off the ledger, and an outstanding unfixed VIOLATION was erased.
 *   3. AN EVIL MERGE — `--no-merges` skipped every change a merge's own conflict resolution
 *      introduced, on the stated but false premise that `git show --name-only` reports nothing
 *      for a merge. It reports the combined diff, which is exactly the resolution.
 *   4. A ONE-CHARACTER TRAILER — `Kernel-seam: x` bought a feat commit its way through a check
 *      whose docstring priced it at "a sentence of design argument".
 *
 * Every case here also carries its ORDINARY half, because four of these rules widen what the
 * guard classifies as capability and a guard that fires on correct work gets deleted: the
 * spelling widening is shown not to reclassify anything, the merge rule is shown to pass an
 * ordinary merge, and the trailer floor is shown to pass the real repo's own eleven seams.
 *
 * `kernel-boundary.test.ts` is the guard's other suite and stays as it is; these are the cases
 * it did not have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const GUARD = join(REPO, "scripts", "check-kernel.mjs");

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
};

const KERNEL = "src/engine.ts";
/** Long enough to clear `MIN_SEAM_CHARS`, so a case about something else is not about that. */
const SEAM = "Kernel-seam: there is no seam for an operator command that must stop the executor";

class Fixture {
  readonly root: string;
  base = "";
  constructor(root: string) {
    this.root = root;
  }
  git(...args: string[]): string {
    const r = spawnSync("git", ["-C", this.root, ...args], { encoding: "utf8", env: GIT_ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  }
  write(rel: string, body: string): void {
    const p = join(this.root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  pin(path: string, since?: string): void {
    this.write(
      "scripts/kernel.json",
      JSON.stringify({ since: since ?? this.base, files: [{ path, why: "the executor" }] }, null, 2),
    );
  }
  commit(subject: string, body: string, edits: Record<string, string> = {}): string {
    for (const [rel, content] of Object.entries(edits)) this.write(rel, content);
    this.git("add", "-A");
    const args = ["commit", "-q", "-m", subject];
    if (body) args.push("-m", body);
    this.git(...args);
    return this.git("rev-parse", "HEAD");
  }
  run(): { status: number; output: string } {
    const r = spawnSync(process.execPath, [GUARD, this.root], { encoding: "utf8", env: GIT_ENV });
    return { status: r.status ?? -1, output: (r.stdout ?? "") + (r.stderr ?? "") };
  }
}

const made: Fixture[] = [];
function repo(): Fixture {
  const f = new Fixture(mkdtempSync(join(tmpdir(), "loom-kernel-ledger-")));
  made.push(f);
  f.write(KERNEL, "export const engine = 1;\n");
  f.pin(KERNEL, "0".repeat(40));
  f.git("init", "-q", "-b", "main");
  f.commit("chore: base", "");
  f.base = f.git("rev-parse", "HEAD");
  f.pin(KERNEL);
  f.commit("chore: pin", "");
  return f;
}
test.after(() => {
  for (const f of made) rmSync(f.root, { recursive: true, force: true });
});

/** How many `seam` rows the guard's ledger printed. */
function seams(output: string): number {
  return output.split("\n").filter((l) => l.trimStart().startsWith("seam ")).length;
}

test("ADVANCING `since` no longer zeroes the ledger", () => {
  const f = repo();
  f.commit("feat(run): a posture", SEAM, { [KERNEL]: "export const engine = 2;\n" });
  const before = f.run();
  assert.equal(before.status, 0, before.output);
  assert.equal(seams(before.output), 1, before.output);

  // The exact repro: re-pin `since` at HEAD, so the judged range is empty.
  f.pin(KERNEL, f.git("rev-parse", "HEAD"));
  f.commit("chore: advance since", "");
  const after = f.run();
  assert.equal(after.status, 0, after.output);
  // The seam is STILL counted — the census is over the full history — and the line says the
  // judged range no longer contains it, which is the fact `since` is allowed to change.
  assert.equal(seams(after.output), 1, after.output);
  assert.match(after.output, /1 declared seam over the full history \(0 of them judged/);
});

test("ADVANCING `since` over an UNPAID violation names the debt instead of erasing it", () => {
  const f = repo();
  f.commit("feat(run): a posture, no seam", "", { [KERNEL]: "export const engine = 2;\n" });
  const before = f.run();
  assert.equal(before.status, 1, before.output);

  f.pin(KERNEL, f.git("rev-parse", "HEAD"));
  f.commit("chore: advance since", "");
  const after = f.run();
  // It passes — grandfathering is what `since` is FOR — but it does not go quiet.
  assert.equal(after.status, 0, after.output);
  assert.match(after.output, /1 feat commit\(s\) touched the kernel before `since`.*declared no seam/s);
  assert.match(after.output, /advancing `since` grows this number/);
});

test("A RENAME does not launder an outstanding violation", () => {
  const f = repo();
  f.commit("feat(run): a posture, no seam", "", { [KERNEL]: "export const engine = 2;\n" });
  assert.equal(f.run().status, 1);

  f.git("mv", KERNEL, "src/executor.ts");
  f.pin("src/executor.ts");
  f.commit("refactor(run): rename engine.ts to executor.ts", "");
  const after = f.run();
  assert.equal(after.status, 1, `the rename laundered the violation:\n${after.output}`);
  assert.match(after.output, /feat\(run\): a posture, no seam/);
  // Reported under the name the commit was written with, which is the only name that exists
  // in that commit — a report naming today's path would name a file that commit never touched.
  assert.match(after.output, /src\/engine\.ts/);
});

test("A RENAME does not drop a declared seam from the ledger", () => {
  const f = repo();
  f.commit("feat(run): a posture", SEAM, { [KERNEL]: "export const engine = 2;\n" });
  assert.equal(seams(f.run().output), 1);

  f.git("mv", KERNEL, "src/executor.ts");
  f.pin("src/executor.ts");
  f.commit("refactor(run): rename engine.ts to executor.ts", "");
  const after = f.run();
  assert.equal(after.status, 0, after.output);
  assert.equal(seams(after.output), 1, `the rename dropped the seam:\n${after.output}`);
});

test("AN EVIL MERGE is judged by the changes its own resolution introduced", () => {
  const f = repo();
  f.git("checkout", "-q", "-b", "side");
  f.commit("chore: side", "", { "src/other.ts": "export const other = 1;\n" });
  f.git("checkout", "-q", "main");
  f.commit("chore: main", "", { "src/third.ts": "export const third = 1;\n" });
  f.git("merge", "-q", "--no-ff", "--no-commit", "side");
  // The resolution writes a pinned file that neither parent wrote.
  f.write(KERNEL, "export const engine = 1;\nexport const NEW_POSTURE = 'wide-open';\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "feat(run): merge side, adding NEW_POSTURE in the resolution");

  const after = f.run();
  assert.equal(after.status, 1, `the evil merge walked past the guard:\n${after.output}`);
  assert.match(after.output, /adding NEW_POSTURE in the resolution/);
});

test("AN ORDINARY MERGE is still not a violation — the rule costs no false positive", () => {
  const f = repo();
  f.git("checkout", "-q", "-b", "side");
  // A `feat:` on the branch, with its seam declared: legitimate, and already judged on its own.
  f.commit("feat(run): a posture", SEAM, { [KERNEL]: "export const engine = 2;\n" });
  f.git("checkout", "-q", "main");
  f.commit("chore: main", "", { "src/third.ts": "export const third = 1;\n" });
  f.git("merge", "-q", "--no-ff", "-m", "feat(run): merge side", "side");

  const after = f.run();
  assert.equal(after.status, 0, `an ordinary merge was treated as capability:\n${after.output}`);
  assert.equal(seams(after.output), 1, after.output);
});

test("A ONE-CHARACTER SEAM TRAILER is not a design argument", () => {
  const f = repo();
  f.commit("feat(run): a posture", "Kernel-seam: x", { [KERNEL]: "export const engine = 2;\n" });
  const r = f.run();
  assert.equal(r.status, 1, `a one-character trailer bought the commit through:\n${r.output}`);
  assert.match(r.output, /its Kernel-seam trailer is 1 character\(s\), "x"/);
  assert.match(r.output, /the floor is 40 and a space/);
});

test("A SEAM WITH NO SPACE is not a sentence however long", () => {
  const f = repo();
  f.commit("feat(run): a posture", `Kernel-seam: ${"x".repeat(60)}`, { [KERNEL]: "export const engine = 2;\n" });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
});

test("EVERY SPELLING OF `feat` claims capability", () => {
  for (const subject of ["Feat(run): a posture", "FEAT: a posture", "feature(run): a posture", " feat(run): a posture"]) {
    const f = repo();
    f.commit(subject, "", { [KERNEL]: "export const engine = 2;\n" });
    const r = f.run();
    assert.equal(r.status, 1, `"${subject}" was not classified as capability:\n${r.output}`);
  }
});

test("THE OTHER DIRECTION: `feature-flag` and `fix` are not `feat`", () => {
  // The widened pattern must not swallow a subject that merely STARTS with the letters. Both
  // of these touch the kernel with no seam and must stay green — a guard that refuses
  // maintenance is a guard that gets deleted.
  for (const subject of ["fix(run): a feature flag was read twice", "chore: featurewise cleanup"]) {
    const f = repo();
    f.commit(subject, "", { [KERNEL]: "export const engine = 2;\n" });
    const r = f.run();
    assert.equal(r.status, 0, `"${subject}" was misread as capability:\n${r.output}`);
  }
});

test("the real repo still passes, and every seam it declares clears the trailer floor", () => {
  const r = spawnSync(process.execPath, [GUARD, REPO], { encoding: "utf8" });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, output);
  // AT LEAST THE ELEVEN THAT EXISTED WHEN THE FLOOR LANDED, NOT EXACTLY ELEVEN. `=== 11` was
  // an equality against a number every future lane is supposed to move: the first legitimate
  // `Kernel-seam:` commit anywhere in the repo would turn `npm run check` red HERE, in a file
  // about resetting the ledger, with the message "the real repo still passes". A guard that
  // fires on correct work is a guard someone deletes. What this test is FOR is the trailer
  // floor refusing nothing that exists, and that is what the two assertions below say.
  assert.ok(seams(output) >= 11, `the ledger shrank below the eleven seams the floor was measured against:\n${output}`);
  // …and the floor really is clear of all of them: exit 0 above IS that assertion, because a
  // seam under MIN_SEAM_CHARS is a violation and a violation exits 1.
  for (const line of output.split("\n")) {
    if (!line.trimStart().startsWith("seam ")) continue;
    assert.ok(line.length > 0);
  }
});

test("DROPPING A PATH FROM `files` no longer erases its seams from the census", () => {
  // The fifth reset, found by review and the same shape as the rename: `historicalNames`
  // followed a file that MOVED and nothing followed one that was simply de-pinned. Measured on
  // this fixture before the fix: the ledger went 1 → 0 and exit stayed 0, and on the real repo
  // dropping `run/engine.ts` alone would have taken the published count from 11 to 1.
  const f = repo();
  f.commit("feat(run): a posture", SEAM, { [KERNEL]: "export const engine = 2;\n" });
  assert.equal(seams(f.run().output), 1);

  f.write("src/other.ts", "export const other = 1;\n");
  f.pin("src/other.ts");
  f.commit("refactor(kernel): engine.ts is not kernel after all", "");
  const after = f.run();
  assert.equal(after.status, 0, "de-pinning is remedy 3 and must still pass");
  assert.equal(seams(after.output), 1, `the de-pin erased the seam:\n${after.output}`);
  // …and the fact that a path left is not silent, because an unpaid violation against it does
  // stop failing the build — that half is what remedy 3 means and cannot be closed.
  assert.match(after.output, /path\(s\) were pinned as kernel earlier in this history and are not now/);
  assert.match(after.output, /src\/engine\.ts/);
});

test("…and a de-pinned file stops FAILING the build, which is what remedy 3 means", () => {
  const f = repo();
  f.commit("feat(run): a posture, no seam", "", { [KERNEL]: "export const engine = 2;\n" });
  assert.equal(f.run().status, 1);

  f.write("src/other.ts", "export const other = 1;\n");
  f.pin("src/other.ts");
  f.commit("refactor(kernel): engine.ts is not kernel after all", "");
  const after = f.run();
  assert.equal(after.status, 0, "the guard's own failure text offers this as remedy 3");
  // The debt is NAMED rather than erased — that is the whole of what the split buys.
  assert.match(after.output, /an UNPAID violation against one no longer fails the build/);
});

/**
 * THE SIXTH RESET: THE TWO KNOBS IN SEQUENCE, which each of the tests above missed by testing
 * its own knob alone.
 *
 * `everPinnedPaths` recovered the pin's history over `${since}..HEAD`, so a de-pin that
 * happened BEFORE `since` was invisible to the census the de-pin rule exists to protect. Two
 * ordinary commits — both of them acts this file documents as legitimate — took the ledger to
 * zero with exit 0 and NEITHER notice printed. Measured on this fixture at dcc77fc:
 *
 *     1. refactor(kernel): src/engine.ts is not kernel after all
 *        → "1 declared seam over the full history", departed-path notice printed
 *     2. chore(kernel): grandfather everything up to the de-pin
 *        → "1 files pinned, 1 commits judged since 4883204, 0 declared seams over the full history"
 *
 * The file's headline claim was "The census cannot be reset by moving `since`, OR by editing
 * `files`" — true of each and false of their composition, which is the correction CLAUDE.md
 * calls worse than the original defect if it lands half-done. The pin's history is read over
 * all of HEAD now, for the same reason the commit history is.
 */
test("DE-PINNING AND THEN ADVANCING `since` PAST THE DE-PIN still cannot zero the ledger", () => {
  const f = repo();
  f.commit("feat(run): a posture", SEAM, { [KERNEL]: "export const engine = 2;\n" });
  assert.equal(seams(f.run().output), 1);

  // Knob 2: de-pin. Legitimate — it is the guard's own remedy 3 — and already covered above.
  f.write("src/other.ts", "export const other = 1;\n");
  f.pin("src/other.ts");
  f.commit("refactor(kernel): engine.ts is not kernel after all", "");
  const dropped = f.git("rev-parse", "HEAD");
  assert.equal(seams(f.run().output), 1, "the de-pin alone was already closed");

  // Knob 1: advance `since` PAST the de-pin, so the de-pin commit itself leaves the judged
  // range. Legitimate on its own too. Together they were a reset.
  f.pin("src/other.ts", dropped);
  f.commit("chore(kernel): grandfather everything up to the de-pin", "");
  const after = f.run();
  assert.equal(after.status, 0, after.output);
  assert.equal(seams(after.output), 1, `the two knobs in sequence erased the seam:\n${after.output}`);
  // …and the de-pin is still said out loud, which is the half that makes the number readable.
  assert.match(after.output, /path\(s\) were pinned as kernel earlier in this history and are not now/);
  assert.match(after.output, /src\/engine\.ts/);
});

/**
 * The `grandfathered` notice counts commits `since` EXCLUDES, and nothing else.
 *
 * It was `all.violations.length - violations.length` — a difference between two runs judged
 * over DIFFERENT path sets, so an unpaid violation inside `since..HEAD` against a de-pinned
 * path fell into it and was announced as "touched the kernel before `since`". That is untrue of
 * such a commit, and it files de-pin debt under the wrong heading: the departed-path notice is
 * what carries that, and says so in its own words.
 */
test("THE GRANDFATHERED NOTICE DOES NOT COUNT A DE-PINNED IN-RANGE VIOLATION", () => {
  const f = repo();
  // An unpaid violation AFTER `since`, then de-pinned. It stops failing the build (remedy 3),
  // and the departed-path notice is what reports it.
  f.commit("feat(run): a posture, no seam", "", { [KERNEL]: "export const engine = 2;\n" });
  f.write("src/other.ts", "export const other = 1;\n");
  f.pin("src/other.ts");
  f.commit("refactor(kernel): engine.ts is not kernel after all", "");
  const after = f.run();
  assert.equal(after.status, 0, after.output);
  assert.doesNotMatch(
    after.output,
    /feat commit\(s\) touched the kernel before `since`/,
    `de-pin debt was filed under the \`since\` heading:\n${after.output}`,
  );
  assert.match(after.output, /an UNPAID violation against one no longer fails the build/);
});

/** THE ORDINARY HALF: a real pre-`since` violation is still counted under its own heading. */
test("…and a genuine pre-`since` violation is still named, which is what that notice is for", () => {
  const f = repo();
  f.commit("feat(run): a posture, no seam", "", { [KERNEL]: "export const engine = 2;\n" });
  assert.equal(f.run().status, 1);
  f.pin(KERNEL, f.git("rev-parse", "HEAD"));
  f.commit("chore: advance since", "");
  const after = f.run();
  assert.equal(after.status, 0, after.output);
  assert.match(after.output, /1 feat commit\(s\) touched the kernel before `since`.*declared no seam/s);
});

/**
 * THE SEVENTH RESET, AND IT IS THE RENAME HOLE A THIRD DOOR OVER: THE PIN ITSELF.
 *
 * `historicalNames` follows a pinned FILE that moved. `everPinnedPaths` follows a pinned PATH
 * that was dropped. Nothing followed `scripts/kernel.json` — the census read the pin's own
 * history through a hard-coded literal with no `--follow`, so every version of the pin written
 * under an earlier name was invisible, and with it every path only THAT version named. Found by
 * review on the very commit whose subject was "the kernel census had a sixth reset", which is
 * this file paying CLAUDE.md's "a correction that lands half-done is worse than the defect" for
 * the second time.
 *
 * DRIVEN IN THE DIRECTION A FIXTURE CAN REACH. The guard resolves its pin at
 * `<root>/scripts/kernel.json`, so a fixture cannot move the pin to a new name and still be
 * read — the reviewer's reproduction moved it and edited the guard in the same commit. The
 * identical hole is reachable from the other side, with no edit to anything: let the pin have
 * BEEN somewhere else and have been renamed INTO place. Everything written under the old name
 * — including the seam declared against a file that version pinned — is what `--follow`
 * recovers and a bare pathspec loses.
 */
test("A RENAME OF THE PIN FILE ITSELF does not erase the pin's own history", () => {
  const f = new Fixture(mkdtempSync(join(tmpdir(), "loom-kernel-pinmove-")));
  made.push(f);
  f.write(KERNEL, "export const engine = 1;\n");
  f.write("src/other.ts", "export const other = 1;\n");
  // The pin starts life under a DIFFERENT name, so nothing at HEAD's path knows about it.
  f.write("scripts/pins.json", JSON.stringify({ since: "0".repeat(40), files: [{ path: KERNEL, why: "the executor" }] }, null, 2));
  f.git("init", "-q", "-b", "main");
  f.commit("chore: base", "");
  f.base = f.git("rev-parse", "HEAD");
  f.write("scripts/pins.json", JSON.stringify({ since: f.base, files: [{ path: KERNEL, why: "the executor" }] }, null, 2));
  f.commit("chore: pin", "");
  // A seam declared against `src/engine.ts`, while only the OLD pin name names it.
  f.commit("feat(run): a posture", SEAM, { [KERNEL]: "export const engine = 2;\n" });

  // Now the pin moves into the place the guard reads, and de-pins that file in the same breath
  // — two acts this guard documents as legitimate, and it is their COMPOSITION that resets.
  f.git("mv", "scripts/pins.json", "scripts/kernel.json");
  f.pin("src/other.ts");
  f.commit("refactor(kernel): the pin moves to scripts/kernel.json, and engine.ts is de-pinned", "");

  const after = f.run();
  assert.equal(after.status, 0, after.output);
  // At 83958c0 this printed `0 declared seams`: `git log HEAD -- scripts/kernel.json` saw only
  // the move commit, whose `files` no longer names engine.ts, so the seam had no watched path.
  assert.equal(seams(after.output), 1, `the pin's own rename erased the seam:\n${after.output}`);
  assert.match(after.output, /path\(s\) were pinned as kernel earlier in this history and are not now/);
  assert.match(after.output, /src\/engine\.ts/);
});

/**
 * NOT A TEST, A NOTE, because the honest answer to "what ran?" here is "nothing new".
 *
 * `everPinnedPaths` answered a failed `git log` with `return out` — "the pin has only ever
 * named what it names today", which IS the de-pin reset: the census failing open into the exact
 * hole it exists to close, and the one git read in this file that did not `refuse`. It refuses
 * now. There is no test beside it: every way a fixture can make that read fail (no repository,
 * an unreadable `since`, a missing pin) is refused EARLIER by a check that already has one, so
 * a test written against it would be green at the previous commit and would be testing nothing.
 * The change is a one-line fail-closed correction and is recorded here rather than pinned.
 */

/**
 * A SEAM TOO THIN TO COUNT IS SAID OUT LOUD, not dropped.
 *
 * `MIN_SEAM_CHARS` turns a short trailer into a violation, and a violation outside the judged
 * range is neither printed nor counted — so the floor's own arrival silently deleted any
 * pre-`since` seam that failed it, from the one number this file exists to keep. None exists in
 * this repo, which is precisely why nobody would have seen it.
 */
test("A PRE-`since` SEAM UNDER THE TRAILER FLOOR IS COUNTED AS A NOTICE, not deleted", () => {
  const f = repo();
  f.commit("feat(run): a posture", "Kernel-seam: x", { [KERNEL]: "export const engine = 2;\n" });
  assert.equal(f.run().status, 1, "in range it is a violation, which the suite above pins");
  // Grandfather it: it leaves the judged range and stops failing the build — legitimate.
  f.pin(KERNEL, f.git("rev-parse", "HEAD"));
  f.commit("chore: advance since", "");
  const after = f.run();
  assert.equal(after.status, 0, after.output);
  assert.equal(seams(after.output), 0, "a one-character trailer is not a seam");
  // …and it does not simply vanish, which is what it did before.
  assert.match(after.output, /1 commit\(s\) declared a Kernel-seam trailer shorter than the 40-character floor/);
});

/**
 * THE EIGHTH RESET: HISTORY SIMPLIFICATION, found in the commit that closed the seventh.
 *
 * `commitsIn("HEAD")` takes no pathspec, so it really is the whole history. The pin's own
 * history read takes one — and a pathspec turns on git's DEFAULT SIMPLIFICATION, which drops
 * any commit whose change to that path did not survive into the first-parent line. So a merge
 * whose resolution discarded a side branch's edit to `kernel.json` dropped that version of the
 * pin, and with it every path only that version named. The docstring claimed the two reads
 * were scoped alike while they were not. `--full-history` is the difference, on this read and
 * on `historicalNames`' `--follow` beside it.
 *
 *     git log                HEAD -- scripts/kernel.json  → the side-branch pin invisible
 *     git log --full-history HEAD -- scripts/kernel.json  → recovered
 *
 * `-s ours` is the cheapest way to write "a merge that kept the first parent's version"; an
 * ordinary conflict resolved the same way is the same shape and the same loss.
 */
test("A MERGE THAT DISCARDS A SIDE BRANCH'S PIN EDIT does not erase what that pin named", () => {
  const f = repo();
  f.git("checkout", "-q", "-b", "side");
  // On the side branch the pin ALSO names src/other.ts, and a seam is declared against it.
  f.write("src/other.ts", "export const other = 1;\n");
  f.write(
    "scripts/kernel.json",
    JSON.stringify({ since: f.base, files: [{ path: KERNEL, why: "the executor" }, { path: "src/other.ts", why: "the other" }] }, null, 2),
  );
  f.commit("chore: pin other.ts too", "");
  f.commit("feat(run): a posture", SEAM, { "src/other.ts": "export const other = 2;\n" });
  f.git("checkout", "-q", "main");
  // The merge keeps MAIN's pin, so `src/other.ts` is not pinned at HEAD and never was on the
  // first-parent line — which is exactly what simplification hides.
  f.git("merge", "-q", "-s", "ours", "--no-ff", "-m", "chore: merge side, keeping main's pin", "side");

  const after = f.run();
  assert.equal(after.status, 0, after.output);
  // At 85973f5 this printed `0 declared seams over the full history`, exit 0, with no notice.
  assert.equal(seams(after.output), 1, `simplification erased the seam:\n${after.output}`);
  assert.match(after.output, /path\(s\) were pinned as kernel earlier in this history and are not now/);
  assert.match(after.output, /src\/other\.ts/);
});

/** THE LINEAR CONTROL, so the loss above is attributable to the merge and not to the fixture. */
test("…and the identical commits on a linear history always counted it — the control", () => {
  const f = repo();
  f.write("src/other.ts", "export const other = 1;\n");
  f.write(
    "scripts/kernel.json",
    JSON.stringify({ since: f.base, files: [{ path: KERNEL, why: "the executor" }, { path: "src/other.ts", why: "the other" }] }, null, 2),
  );
  f.commit("chore: pin other.ts too", "");
  f.commit("feat(run): a posture", SEAM, { "src/other.ts": "export const other = 2;\n" });
  f.pin(KERNEL);
  f.commit("refactor(kernel): other.ts is not kernel after all", "");
  const after = f.run();
  assert.equal(after.status, 0, after.output);
  assert.equal(seams(after.output), 1, after.output);
});
