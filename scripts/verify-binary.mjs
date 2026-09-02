#!/usr/bin/env node
/**
 * WHY THIS EXISTS
 *
 * `binary-freshness.cjs` is a guard that lives INSIDE the artifact it protects, and that shape
 * has a bootstrap hole nothing else could see: a binary built before the guard existed does not
 * carry it, cannot report that it does not carry it, and is therefore silently stale forever.
 *
 * WHAT ALREADY COVERED WHAT, named rather than dismissed, because two suites do a real job here
 * and the gap is narrower than "nothing tested this". `binary-freshness-absent-or-unreadable.test.ts`
 * and `binary-freshness-ancestors.test.ts` stamp a fake `bin/loom.cjs` with `banner(stampFor(root))`
 * in a temp directory: they prove the CHECK decides correctly, one arm per test.
 * `readme-gaps.test.ts`'s "THE BUILD ACTUALLY BAKES IT IN" greps `build-binary.mjs`'s own TEXT
 * for `binary-freshness.cjs`, `.banner(` and `banner: {`: it proves the wiring is still written
 * down. Between them the only thing left unexamined was THE ARTIFACT — nothing ever ran a
 * produced binary and watched it refuse.
 *
 * THAT GAP IS NOT THEORETICAL, and a source grep is structurally unable to close it. Driven on
 * this tree 2026-09-02: `build-binary.mjs` edited to compute `freshness.banner(stamp)` into a
 * variable and inject `bannerText.slice(0, 0)` — every string the grep requires still present.
 * `readme-gaps.test.ts` passed all 22 tests including that one; the build printed its usual
 * success line, "it refuses to run once packages/core/src moves"; and
 * `grep -ac 'THIS BINARY IS STALE' bin/loom` returned 0. This script failed STALE and OVERRIDE.
 * The build's own success line is a claim about the artifact that nothing checked.
 *
 * MEASURED 2026-09-02, on the maintainer's own checkout, which is what made this worth writing:
 *
 *     stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' bin/loom                  2026-08-25 13:52:23
 *     find packages/core/src -name '*.ts' -newer bin/loom | wc -l    48   (of 62)
 *     /usr/bin/grep -ac 'THIS BINARY IS STALE' bin/loom              0
 *     /usr/bin/grep -ac 'LOOM_STALE_BINARY' bin/loom                 0
 *     ./bin/loom --help ; echo $?                                    exit 0, 67 lines of help
 *
 * Eight days and 48 files behind, answering with exit 0, and the reason is not that the guard
 * is broken — it is that the guard shipped three days AFTER that binary was built and no build
 * has happened since. `.github/workflows/ci.yml` never built the binary, so nothing outside a
 * human's hands ever produced one to look at.
 *
 * So this script drives the REAL artifact. It is what the `binary` CI job runs after
 * `npm run build:binary`, and it is runnable by hand against any `bin/loom` to answer the one
 * question the file cannot answer about itself: does this thing refuse when its sources move?
 *
 * THE FOUR CASES, which are the guard's whole contract as its header states it:
 *
 *   CURRENT   sources beside it, byte-identical to what was stamped  -> runs, exit 0
 *   STALE     one source file edited                                 -> refuses, exit 1, says so
 *   OVERRIDE  the same stale tree with LOOM_STALE_BINARY=allow       -> runs, AND still says so
 *   SHIPPED   no source tree beside it at all                        -> runs, silently
 *
 * Each runs the binary out of a temp root with a copied source tree, never against this
 * checkout — so a failing case leaves the working tree untouched, and STALE can edit a file
 * without `git checkout --` being part of the contract.
 *
 * WHAT THIS DELIBERATELY DOES NOT RE-TEST: the undecidable cases (a regular file, a dangling
 * symlink, an unreadable ancestor). Those are the two unit suites' subject, they are covered
 * one arm per test there, and driving them through a 115 MB binary would buy a slower copy of
 * an existing assertion. The four above are the ones that need the real artifact, because each
 * is a claim about what the BUILD produced rather than about what the check decides.
 *
 * OFFLINE AND DETERMINISTIC: the only argument passed is `--help`, which prints usage and exits
 * without opening a socket, reading a key, or touching the working tree. Everything this script
 * writes goes under `mkdtempSync` and is removed. No assertion here reads a clock.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, appendFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The same set `binary-freshness.cjs` digests. Named here too so a rename breaks both. */
const SOURCE_DIR = join("packages", "core", "src");
const NAME = process.platform === "win32" ? "loom.exe" : "loom";
const OVERRIDE = "LOOM_STALE_BINARY";

/** The sentence the guard prints. Matching on it rather than on exit code alone: a binary that
 *  exits 1 for an unrelated reason must not read as a passing STALE case. */
const REFUSAL = "THIS BINARY IS STALE";

const binary = process.argv[2] ?? join(repoRoot, "bin", NAME);

if (!existsSync(binary)) {
  console.error(`verify FAILED: no binary at ${binary}.`);
  console.error("Run `npm run build:binary` first, or pass a path.");
  process.exit(1);
}

/**
 * A temp root holding the binary at `bin/` and, unless `withSources` is false, a copy of this
 * checkout's sources at the path the stamp names. The guard derives its root from
 * `process.execPath`, so a binary two levels under `root` looks for `root/packages/core/src` —
 * which is what makes a copied tree a complete test rig rather than a partial one.
 */
function rig(withSources) {
  const root = mkdtempSync(join(tmpdir(), "loom-verify-binary-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  const bin = join(root, "bin", NAME);
  cpSync(binary, bin, { preserveTimestamps: true });
  if (withSources) cpSync(join(repoRoot, SOURCE_DIR), join(root, SOURCE_DIR), { recursive: true });
  return { root, bin };
}

/**
 * `--help`, with stdout and stderr kept apart: the refusal goes to fd 2 and the help to fd 1.
 *
 * `[OVERRIDE]: ""` before the caller's `env` clears any `LOOM_STALE_BINARY` the invoking shell
 * exported — otherwise an operator who set it to run their own stale binary would turn STALE
 * into a silent pass, which is the one direction this script must never fail in. Only the
 * OVERRIDE case puts it back, and it puts back the exact value `allow`.
 */
function run(bin, env) {
  const r = spawnSync(bin, ["--help"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, [OVERRIDE]: "", ...env },
  });
  if (r.error) return { status: null, stdout: "", stderr: String(r.error.message) };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const failures = [];
function expect(caseName, ok, saw) {
  if (ok) console.log(`  ok    ${caseName} — ${saw}`);
  else {
    console.log(`  FAIL  ${caseName} — ${saw}`);
    failures.push(caseName);
  }
}

const mb = (statSync(binary).size / 1024 / 1024).toFixed(1);
console.log(`verifying ${binary} (${mb} MB)`);

// ── CURRENT ──────────────────────────────────────────────────────────────────
// The no-false-positive half. If this fails, either the binary was not built from these
// sources or the digest is not reproducible from a copied tree — both are the build's problem.
{
  const { root, bin } = rig(true);
  const r = run(bin, {});
  expect(
    "CURRENT",
    r.status === 0 && !r.stderr.includes(REFUSAL) && r.stdout.includes("loom"),
    `exit=${r.status}, refusal=${r.stderr.includes(REFUSAL)}`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ── STALE and OVERRIDE ───────────────────────────────────────────────────────
// One rig for both, because OVERRIDE's claim is about the SAME tree STALE just refused on:
// the bar the guard's header sets is that nobody drives a stale binary WITHOUT BEING TOLD,
// so the override must still print the report it is overriding.
{
  const { root, bin } = rig(true);
  appendFileSync(join(root, SOURCE_DIR, "agent.ts"), "\n// verify-binary: a byte the stamp never saw\n");

  const stale = run(bin, {});
  expect(
    "STALE",
    stale.status === 1 && stale.stderr.includes(REFUSAL) && stale.stderr.includes("the sources have changed"),
    `exit=${stale.status}, refusal=${stale.stderr.includes(REFUSAL)}`,
  );

  const forced = run(bin, { [OVERRIDE]: "allow" });
  expect(
    "OVERRIDE",
    forced.status === 0 && forced.stderr.includes(REFUSAL),
    `exit=${forced.status}, still-told=${forced.stderr.includes(REFUSAL)}`,
  );
  rmSync(root, { recursive: true, force: true });
}

// ── SHIPPED ──────────────────────────────────────────────────────────────────
// The one silent case, and the one a user actually installs: nothing beside it to be behind.
// A guard that refused here would make every install unusable, so this is the case that keeps
// the other three from being "over-tighten and call it safe".
{
  const { root, bin } = rig(false);
  const r = run(bin, {});
  expect(
    "SHIPPED",
    r.status === 0 && !r.stderr.includes(REFUSAL) && r.stdout.includes("loom"),
    `exit=${r.status}, refusal=${r.stderr.includes(REFUSAL)}`,
  );
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nverify FAILED: ${failures.join(", ")}`);
  console.error("This binary does not carry a working freshness guard. Anything measured with it");
  console.error("may be an older tree's answer, and it will never say so. Rebuild it:");
  console.error("\n  npm run build:binary\n");
  process.exit(1);
}
console.log("\nall four cases hold — this binary refuses when its sources move, and only then.");
