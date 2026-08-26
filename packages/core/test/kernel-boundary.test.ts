/**
 * The kernel guard, driven rather than read.
 *
 * `scripts/check-kernel.mjs` gives CLAUDE.md property 1 — "a change that adds capability should
 * not touch the kernel" — the referent it never had in this package, and a guard nobody has seen
 * go red is not a guard. Every row below is a real git history built in a temp directory and
 * judged by the real script; the RED rows were watched to fail and the GREEN rows to pass.
 *
 * Two properties of the guard are as important as its refusals, because a guard that cries wolf
 * gets switched off:
 *
 *   - `fix:` may touch the kernel. Fixing the kernel is what a kernel is for; P1 constrains
 *     capability, not maintenance.
 *   - UNCOMMITTED changes to a kernel file are a notice, never a failure. They have no commit
 *     message yet, so intent is unknowable — and the alternative is that nobody can edit the
 *     kernel and run the gate.
 *
 * The pin's own failure modes are tested too, and they are the ones that matter most in the long
 * run: an empty `files` list, a file pinned with no `why`, and a pinned path that has left the
 * tree. `check-surface.mjs`'s own history is a guard reading a stale artifact and printing "ok".
 *
 * Hermetic: `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` are pointed at /dev/null so a developer's
 * `commit.gpgsign`, `core.hooksPath` or `init.templateDir` cannot reach these repos, and every
 * author/committer date is fixed. No network, no clock.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
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

/** The two files a fixture repo treats as kernel, and the one it does not. */
const KERNEL_A = "src/engine.ts";
const KERNEL_B = "src/journal.ts";
const OUTSIDE = "src/validate.ts";

interface Pin {
  readonly since?: string;
  readonly files?: unknown[];
}

class Fixture {
  readonly root: string;

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

  /** Overwrite the pin. Left UNCOMMITTED on purpose — the guard reads the tree, not the index. */
  pin(p: Pin): void {
    this.write(
      "scripts/kernel.json",
      JSON.stringify(
        {
          since: p.since ?? this.base,
          files: p.files ?? [
            { path: KERNEL_A, why: "the executor" },
            { path: KERNEL_B, why: "the durable write path" },
          ],
        },
        null,
        2,
      ),
    );
  }

  base = "";

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

/**
 * A repo with three source files and a base commit, `since` pinned AT that base — so history
 * before the guard existed is grandfathered and every scenario commit is inside the range.
 */
function fixture(init = true): Fixture {
  const f = new Fixture(mkdtempSync(join(tmpdir(), "loom-kernel-")));
  f.write(KERNEL_A, "export const engine = 1;\n");
  f.write(KERNEL_B, "export const journal = 1;\n");
  f.write(OUTSIDE, "export const validate = 1;\n");
  f.pin({ since: "0".repeat(40) });
  if (!init) return f;
  f.git("init", "-q", "-b", "main");
  f.commit("chore: base", "", {});
  f.base = f.git("rev-parse", "HEAD");
  f.pin({});
  return f;
}

const made: Fixture[] = [];
function repo(init = true): Fixture {
  const f = fixture(init);
  made.push(f);
  return f;
}
test.after(() => {
  for (const f of made) rmSync(f.root, { recursive: true, force: true });
});

// ── the predicate ────────────────────────────────────────────────────────────────

test("RED: a feat commit that touches a pinned kernel file, with no seam declared", () => {
  const f = repo();
  const sha = f.commit("feat(engine): add a capability", "", {
    [KERNEL_A]: "export const engine = 2;\n",
  });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /kernel guard FAILED/);
  assert.match(r.output, /a change that adds capability touched the kernel/);
  assert.ok(r.output.includes(sha.slice(0, 7)), `names the commit:\n${r.output}`);
  assert.ok(r.output.includes(KERNEL_A), `names the file:\n${r.output}`);
  assert.match(r.output, /Kernel-seam:/);
});

test("RED: `feat!:` — a breaking capability is still a capability", () => {
  const f = repo();
  f.commit("feat!: replace the effect key", "", { [KERNEL_B]: "export const journal = 2;\n" });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.ok(r.output.includes(KERNEL_B), r.output);
});

test("GREEN: a feat commit outside the pinned list", () => {
  const f = repo();
  f.commit("feat(validate): add a rule", "", { [OUTSIDE]: "export const validate = 2;\n" });
  const r = f.run();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /kernel guard ok/);
});

test("GREEN: a feat commit that declares the missing seam", () => {
  const f = repo();
  f.commit(
    "feat(engine): add a capability",
    "Kernel-seam: node types are not pluggable; a registry would have been a\nsecond dispatch path, which rule 1 exists to prevent.",
    { [KERNEL_A]: "export const engine = 3;\n" },
  );
  const r = f.run();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /1 declared seam\b/);
  assert.match(r.output, /node types are not pluggable/);
});

test("RED: a `Kernel-seam:` trailer with nothing after it is not a declaration", () => {
  const f = repo();
  f.commit("feat(engine): add a capability", "Kernel-seam:", {
    [KERNEL_A]: "export const engine = 4;\n",
  });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
});

test("GREEN: `fix:` may touch the kernel — fixing it is what a kernel is for", () => {
  const f = repo();
  f.commit("fix(engine): the join folded siblings out of order", "", {
    [KERNEL_A]: "export const engine = 5;\n",
  });
  f.commit("refactor(journal): extract the fold", "", { [KERNEL_B]: "export const journal = 3;\n" });
  f.commit("docs(engine): say why", "", { [KERNEL_A]: "// why\nexport const engine = 5;\n" });
  const r = f.run();
  assert.equal(r.status, 0, r.output);
});

test("GREEN: history before `since` is grandfathered, not judged retroactively", () => {
  const f = repo();
  // A feat touching the kernel, then `since` advanced past it.
  f.commit("feat(engine): capability that predates the guard", "", {
    [KERNEL_A]: "export const engine = 6;\n",
  });
  f.pin({ since: f.git("rev-parse", "HEAD") });
  const r = f.run();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /0 commits since/);
});

test("GREEN + NOTICE: an uncommitted kernel edit is reported and never fails", () => {
  const f = repo();
  f.write(KERNEL_A, "export const engine = 99;\n");
  const r = f.run();
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /notice: 1 kernel file/);
  assert.ok(r.output.includes(KERNEL_A), r.output);
});

// ── the pin's own failure modes ──────────────────────────────────────────────────

test("RED: an empty kernel list passes everything while observing nothing", () => {
  const f = repo();
  f.pin({ files: [] });
  f.commit("feat(engine): add a capability", "", { [KERNEL_A]: "export const engine = 7;\n" });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the pinned kernel is empty/);
});

test("RED: a file pinned with no `why` — a list nobody can justify", () => {
  const f = repo();
  f.pin({ files: [{ path: KERNEL_A }, { path: KERNEL_B, why: "the durable write path" }] });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /pinned with no `why`/);
});

test("RED: a pinned file that has left the tree — the stale-artifact failure", () => {
  const f = repo();
  unlinkSync(join(f.root, KERNEL_B));
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /is not in the tree/);
});

test("RED: `since` names a commit this repository does not have", () => {
  const f = repo();
  f.pin({ since: "0000000000000000000000000000000000000000" });
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /is not a commit in this repository/);
});

/**
 * The cheapest way to switch this guard off without deleting it, and it was reproduced by
 * accident: `"since": "HEAD"` makes the range `HEAD..HEAD`, so the guard printed
 * `kernel guard ok: … 0 commits since fb813ec` over a feat commit that had just rewritten a
 * pinned file. Any moving ref does it — a branch name, a re-pointed tag.
 */
test("RED: `since` is a moving ref, so the range is empty and the guard is vacuous", () => {
  const f = repo();
  f.commit("feat(engine): add a capability", "", { [KERNEL_A]: "export const engine = 8;\n" });
  for (const ref of ["HEAD", "@", "main"]) {
    f.pin({ since: ref });
    const r = f.run();
    assert.equal(r.status, 1, `${ref}:\n${r.output}`);
    assert.match(r.output, /must be a commit SHA/);
  }
});

test("RED: no pin at all", () => {
  const f = repo();
  unlinkSync(join(f.root, "scripts", "kernel.json"));
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /not found/);
});

test("RED: not a git repository — intent is unreadable, so it refuses", () => {
  const f = repo(false);
  const r = f.run();
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /is not a git repository/);
});

// ── the real repo ────────────────────────────────────────────────────────────────

test("the real repo's own kernel pin is coherent and green", () => {
  const r = spawnSync(process.execPath, [GUARD, REPO], { encoding: "utf8" });
  assert.equal(r.status, 0, (r.stdout ?? "") + (r.stderr ?? ""));
  assert.match(r.stdout, /kernel guard ok: \d+ files pinned/);
});

/**
 * The guard can be switched off without deleting it, and the two ways are covered here
 * because neither shows up as a failing assertion anywhere else.
 *
 * The first is UNWIRING: `npm run check` is THE gate, and a guard absent from it runs only
 * when somebody remembers to. The second is HOLLOWING the pin — dropping `run/engine.ts`
 * while leaving the count intact. That file is the reason this guard exists (1,375 to 6,104
 * lines in 21 days, 28 of 69 feat commits); a pin of ten stable files that omits it would
 * print `kernel guard ok` forever and observe nothing that moves.
 */
test("the guard is wired into `npm run check`", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.match(
    pkg.scripts.check,
    /node scripts\/check-kernel\.mjs/,
    "a guard outside the gate runs only when somebody remembers to",
  );
});

test("the pin names run/engine.ts, and CLAUDE.md's count agrees with it", () => {
  const pin = JSON.parse(readFileSync(join(REPO, "scripts", "kernel.json"), "utf8"));
  const paths: string[] = pin.files.map((f: { path: string }) => f.path);
  assert.ok(
    paths.includes("packages/core/src/run/engine.ts"),
    `the file this guard exists because of is not pinned:\n${paths.join("\n")}`,
  );

  const WORDS: Record<number, string> = {
    8: "eight", 9: "nine", 10: "ten", 11: "eleven", 12: "twelve", 13: "thirteen",
  };
  const claude = readFileSync(join(REPO, "CLAUDE.md"), "utf8");
  const stated = /\*\*The kernel is a named list of ([a-z]+) files\*\*/.exec(claude);
  assert.ok(stated, "CLAUDE.md no longer states how many files the kernel is");
  assert.equal(
    stated[1],
    WORDS[paths.length],
    `CLAUDE.md says ${stated[1]} kernel files; scripts/kernel.json pins ${paths.length}`,
  );
});
