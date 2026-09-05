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

test("the real repo still passes, and its eleven seams still clear the trailer floor", () => {
  const r = spawnSync(process.execPath, [GUARD, REPO], { encoding: "utf8" });
  const output = (r.stdout ?? "") + (r.stderr ?? "");
  assert.equal(r.status, 0, output);
  assert.equal(seams(output), 11, output);
});
