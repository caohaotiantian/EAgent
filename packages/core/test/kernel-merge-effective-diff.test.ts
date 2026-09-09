/**
 * The kernel guard's two §A0.26 holes, driven rather than read.
 *
 * `kernel-boundary.test.ts` drives the guard's predicate and the pin's failure modes. This file
 * drives the two things that predicate could not see, and it is separate because both are
 * properties of what the guard READS rather than of what it decides:
 *
 *   1. A CLEAN MERGE. `git show --name-only` prints a merge's COMBINED diff, which is empty
 *      unless the merge resolved a conflict by hand. So a clean merge reported no files, was
 *      dropped before any trailer rule ran, and could neither declare a seam nor violate —
 *      including after the round that widened the census to read a trailer on any subject
 *      precisely so that merges could declare. On this repository:
 *      `git show --name-only --format='' 878001c | wc -l` → 0, `… -m …` → 9.
 *
 *   2. ONE DEFINITION OF A TRAILER. A `feat` subject's trailer was matched anywhere in the body
 *      by a plain regex; every other subject's went through `git interpret-trailers --parse`.
 *      Two rules, so the same message meant different things depending on its subject line, and
 *      a sub-floor trailer on a non-`feat` subject vanished into neither the census, the thin
 *      notice, nor the violations — where the identical trailer on a `feat` subject was both a
 *      violation and a notice.
 *
 * FOUR OF THE SEVEN ROWS WERE WATCHED TO FAIL against `d1b42ae`'s `scripts/check-kernel.mjs` —
 * the census row, both `one definition:` rows, and the thin-trailer notice. THE OTHER THREE PASS
 * AGAINST IT AND ARE SAID SO IN PLACE, because a test that never failed has not been shown to
 * test anything and this guard's history is four rounds of fixes that each passed their author's
 * tests. They are preservation pins: the two merge rows hold the properties this change could
 * have SPENT (an ordinary merge costs no false positive; an evil merge is still judged), and the
 * `CONTROL:` row is a control by construction. Naming which is which is the point — three green
 * rows presented as coverage would be the same fiction the guard's own docstring paid for twice.
 *
 * Hermetic, on the same terms as `kernel-boundary.test.ts`: `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` point at /dev/null so a developer's `commit.gpgsign` or `core.hooksPath`
 * cannot reach these repos, and every author/committer date is fixed. No network, no clock.
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

const KERNEL_A = "src/engine.ts";
const OUTSIDE = "src/validate.ts";

/** Clears `MIN_SEAM_CHARS` (40) and contains a space, so only its POSITION can decide it. */
const SEAM_TEXT =
  "Kernel-seam: an argument long enough to clear the forty character floor here.";

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

  pin(since: string): void {
    this.write(
      "scripts/kernel.json",
      JSON.stringify({ since, files: [{ path: KERNEL_A, why: "the executor" }] }, null, 2),
    );
  }

  commit(subject: string, body: string, edits: Record<string, string>): string {
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
  const f = new Fixture(mkdtempSync(join(tmpdir(), "loom-kernel-merge-")));
  f.write(KERNEL_A, "export const engine = 1;\n");
  f.write(OUTSIDE, "export const validate = 1;\n");
  f.pin("0".repeat(40));
  f.git("init", "-q", "-b", "main");
  f.commit("chore: base", "", {});
  f.base = f.git("rev-parse", "HEAD");
  f.pin(f.base);
  f.commit("chore: pin the kernel", "", {});
  made.push(f);
  return f;
}
test.after(() => {
  for (const f of made) rmSync(f.root, { recursive: true, force: true });
});

/**
 * A merge with NO conflict: `main` advances on a file outside the kernel, `side` rewrites the
 * pinned one, and git merges them without the merge commit writing a byte of its own. That is
 * the shape whose combined diff is empty.
 */
function cleanMerge(f: Fixture, sideSubject: string, mergeSubject: string, mergeBody: string): string {
  f.git("checkout", "-q", "-b", "side");
  f.commit(sideSubject, "", { [KERNEL_A]: "export const engine = 2;\n" });
  f.git("checkout", "-q", "main");
  f.commit("chore: unrelated", "", { [OUTSIDE]: "export const validate = 2;\n" });
  const args = ["merge", "--no-ff", "-q", "-m", mergeSubject];
  if (mergeBody) args.push("-m", mergeBody);
  f.git(...args, "side");
  const sha = f.git("rev-parse", "HEAD");
  assert.equal(
    f.git("show", "--name-only", "--format=", sha),
    "",
    "the fixture must be a CLEAN merge — an empty combined diff is the whole point",
  );
  return sha;
}

// ── 1 · a clean merge's effective diff ───────────────────────────────────────────

/**
 * Before the fix: `0 declared seams`, the merge's sha absent from the output entirely — the
 * guard's census could not see a declaration written in the one place a merge can write one.
 */
test("CENSUS: a CLEAN merge's Kernel-seam trailer reaches the ledger", () => {
  const f = repo();
  const sha = cleanMerge(f, "fix(engine): a side-branch repair", "merge: side — the repair", SEAM_TEXT);
  const r = f.run();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /1 declared seam\b/, r.output);
  assert.ok(r.output.includes(sha.slice(0, 7)), `names the clean merge:\n${r.output}`);
  assert.ok(r.output.includes("clear the forty character floor"), r.output);
});

/**
 * THE OTHER HALF OF THE SAME DECISION, and the half a first attempt at this fix got wrong: the
 * `-m` read belongs to the CENSUS and must not reach the REQUIREMENT.
 *
 * A clean merge writes nothing its parents did not already contain. Its `feat` commits are in
 * the history and judged on their own — the one below declares its seam on the branch — so
 * refusing the merge as well would demand a SECOND trailer for a seam already declared, and
 * double it in the ledger. Reading `-m` on the requirement path made exactly that happen, and
 * `guards-lane-kernel-ledger-cannot-be-reset.test.ts`'s "AN ORDINARY MERGE is still not a
 * violation — the rule costs no false positive" went red. This row is that test's shape with a
 * `feat:` merge subject, kept here so the two reads cannot be collapsed back into one.
 */
test("GREEN: a `feat:`-subjected CLEAN merge is not itself a violation — the branch was judged already", () => {
  const f = repo();
  f.git("checkout", "-q", "-b", "side");
  f.commit("feat(engine): a capability, declared", SEAM_TEXT, { [KERNEL_A]: "export const engine = 30;\n" });
  f.git("checkout", "-q", "main");
  f.commit("chore: unrelated", "", { [OUTSIDE]: "export const validate = 3;\n" });
  f.git("merge", "--no-ff", "-q", "-m", "feat(engine): merge side", "side");
  const r = f.run();
  assert.equal(r.status, 0, `an ordinary merge was treated as capability:\n${r.output}`);
  assert.match(r.output, /1 declared seam\b/, `the seam must be counted once, not twice:\n${r.output}`);
});

/**
 * The evil merge stays judged, and by its own resolution — the property the previous round won
 * and this one must not spend. `git show`'s combined diff is what the requirement reads, and a
 * hand-resolved conflict is exactly what a combined diff contains.
 */
test("RED: an EVIL merge under a `feat:` subject is still judged by its own resolution", () => {
  const f = repo();
  f.git("checkout", "-q", "-b", "side");
  f.commit("fix(engine): side", "", { [KERNEL_A]: "export const engine = 10;\n" });
  f.git("checkout", "-q", "main");
  f.commit("fix(engine): main", "", { [KERNEL_A]: "export const engine = 11;\n" });
  spawnSync("git", ["-C", f.root, "merge", "--no-ff", "-q", "side"], { encoding: "utf8", env: GIT_ENV });
  f.write(KERNEL_A, "export const engine = 12; // resolved\n");
  f.git("add", "-A");
  f.git("commit", "-q", "-m", "feat(engine): merge, resolving by hand");
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /merge, resolving by hand/, r.output);
  assert.ok(r.output.includes(KERNEL_A), `names the pinned file:\n${r.output}`);
});

// ── 2 · one definition of a trailer, on every subject ────────────────────────────

/**
 * THE RULE THE GUARD ACTUALLY NEEDS, and the reason it is neither of the two it replaced.
 * `git interpret-trailers --parse` ends a trailer block at the first line that is neither a
 * trailer nor an INDENTED continuation, so this message parses as NO trailer at all — and five
 * of this repository's twelve declared seams are written exactly this way. Under git's parser
 * they would each become a build-failing violation.
 *
 * Before the fix this passed for a `feat` subject (the plain regex) and FAILED for every other
 * subject (the parser). That disagreement is the defect; the assertion is that both now agree.
 */
test("one definition: a flush-left continuation still declares, on a feat subject and on a fix subject alike", () => {
  const body = `${SEAM_TEXT}\nThe continuation line is flush left, which is how this repo writes them.`;
  for (const subject of ["feat(engine): add a capability", "fix(engine): repair the fold"]) {
    const f = repo();
    const sha = f.commit(subject, body, { [KERNEL_A]: "export const engine = 20;\n" });
    const r = f.run();
    assert.equal(r.status, 0, `${subject}:\n${r.output}`);
    assert.match(r.output, /1 declared seam\b/, `${subject}:\n${r.output}`);
    assert.ok(r.output.includes(sha.slice(0, 7)), `${subject}:\n${r.output}`);
  }
});

/**
 * The other side of the same coin, and the case the plain regex got wrong: a body that only
 * QUOTES the trailer mid-prose declares nothing, whatever its subject.
 *
 * Before the fix the `fix:` row already passed (the parser) and the `feat:` row did NOT: the
 * plain regex credited the quotation, so a `feat` commit could satisfy the requirement by
 * mentioning the trailer in a paragraph of prose. That is a real tightening and it refuses
 * nothing in this repository's history — the ledger is byte-identical across the change.
 */
test("one definition: a trailer QUOTED mid-prose declares nothing, on a feat subject and on a fix subject alike", () => {
  const body = `The escape hatch looks like this:\n\n${SEAM_TEXT}\n\nWrite one when a feat touches the kernel.`;
  const expected: Record<string, number> = {
    "feat(engine): add a capability": 1,
    "fix(engine): repair the fold": 0,
  };
  for (const [subject, status] of Object.entries(expected)) {
    const f = repo();
    const sha = f.commit(subject, body, { [KERNEL_A]: "export const engine = 21;\n" });
    const r = f.run();
    assert.equal(r.status, status, `${subject}:\n${r.output}`);
    if (status === 0) {
      assert.match(r.output, /\b0 declared seams\b/, `${subject}:\n${r.output}`);
      assert.ok(!r.output.includes(sha.slice(0, 7)), `must not credit a quotation:\n${r.output}`);
    }
  }
});

/**
 * §A0.26's second carrier, stated as its own row. A thin trailer on a non-`feat` subject was
 * dropped in SILENCE: `nonFeatTrailerSeam` returned `undefined`, so it was not a seam, not a
 * notice, and — the subject being non-`feat` — not a violation either. Before the fix this
 * printed `0 declared seams` with no notice at all.
 *
 * It must still not fail the build: the REQUIREMENT is `feat`-only, and making a merge declare
 * would be a new refusal rather than a census fix.
 */
test("NOTICE: a thin trailer on a non-feat subject is counted as thin, not dropped in silence", () => {
  const f = repo();
  f.commit("fix(engine): repair the fold", "Kernel-seam: none", {
    [KERNEL_A]: "export const engine = 22;\n",
  });
  const r = f.run();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\b0 declared seams\b/, r.output);
  assert.match(r.output, /notice: 1 commit\(s\) declared a Kernel-seam trailer shorter than the/, r.output);
});

/** CONTROL: the identical trailer on a `feat` subject is a violation AND is counted as thin. */
test("CONTROL: the same thin trailer on a feat subject is a violation", () => {
  const f = repo();
  f.commit("feat(engine): add a capability", "Kernel-seam: none", {
    [KERNEL_A]: "export const engine = 23;\n",
  });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /its Kernel-seam trailer is 4 character\(s\)/, r.output);
});
