#!/usr/bin/env node
/**
 * Guard: property 1's mechanical test, given a referent.
 *
 * CLAUDE.md says **"a change that adds capability should not touch the kernel"**. Until
 * `packages/eagent` was deleted that sentence had no referent in this package — the Layout
 * block assigned the word "kernel" to the other one, and `grep -ani kernel packages/core/src/`
 * still returns exactly one hit, about the OS kernel. So the test could be quoted but never run.
 *
 * The one running P1 gate, `check-surface.mjs`, pins the exported NAME SET. That is the right
 * pin for the public contract and the wrong one for this: it reported
 * `surface guard ok: … unchanged` on the day `run/engine.ts` crossed 6,100 lines, having grown
 * from 1,375 in 21 days across 28 of this branch's 69 `feat` commits. Name-set stability and
 * kernel stability are different properties and only one of them was observed.
 *
 * ── What this pins ──────────────────────────────────────────────────────────────
 *
 * A FILE LIST — `scripts/kernel.json` — plus, for each file, a written reason it is kernel.
 * Not a line count: EAgent pinned a kernel line count, the ceiling had to be raised four times,
 * and it taxed correct primitives as much as incidental ones (`check-surface.mjs` argues this
 * at length; the argument is not repeated here). Not a content digest either — that was the
 * closest analogue of `surface.json` and it was rejected, because the reviewed diff would be one
 * opaque line, `"a3f9…" → "b12c…"`, and a pin whose update teaches a reviewer nothing is a
 * rubber stamp. `surface.json` works because a name-set diff is legible.
 *
 * ── How it decides a change "adds capability" ────────────────────────────────────
 *
 * It reads git. A commit whose subject is `feat(...)` / `feat!:` and which touches a pinned file
 * must carry a `Kernel-seam:` trailer naming the seam that was missing. `fix`, `docs`, `refactor`,
 * `test`, `chore` are free to touch the kernel — fixing the kernel is what a kernel is for; P1
 * constrains capability, not maintenance.
 *
 * Reading git is awkward for a guard and it is the honest choice: nothing in the TREE records
 * intent, and intent is the entire predicate. What that CANNOT catch, exhaustively:
 *
 *   - a capability landed under `fix:`, `refactor:` or `chore:`. The convention IS the signal;
 *     a mislabelled commit defeats it and no tree-reading check would have caught it either.
 *   - a squash-merge that collapses a `feat` into a subject of some other type.
 *   - capability added OUTSIDE the list that makes the kernel harder to change later.
 *   - uncommitted work. A dirty kernel file has no commit message yet, so it is reported as a
 *     NOTICE and never as a failure — otherwise nobody could edit the kernel and run the gate.
 *
 * FOUR THINGS IT USED NOT TO CATCH AND NOW DOES, each measured against this repo before and
 * after, and each refusing NOTHING that exists in the history today:
 *
 *   - `Feat:`, `FEAT:` and `feature:`. `/^feat(\([^)]*\))?!?:/` was case-sensitive, anchored
 *     with no leading-whitespace tolerance, and did not accept `feature`, so five ordinary
 *     spellings of the same claim were not classified as capability at all. All 35 feat
 *     commits in `86b84c9..HEAD` match under both the old rule and the new one, with an empty
 *     symmetric difference — measured today, not assumed:
 *     `git log --format='%s' 86b84c9..HEAD | /usr/bin/grep -acE '^feat(\([^)]*\))?!?:'` → 35.
 *     (This file carried the same measurement as 34 in the other paragraph. One measurement
 *     stated as two numbers is a measurement nobody made twice.)
 *   - AN EVIL MERGE. `--no-merges` is gone. It was there on the belief that "`git show
 *     --name-only` reports nothing for them", which is false: for a merge, `git show` prints
 *     the COMBINED diff, i.e. exactly the changes the resolution introduced and no others. So
 *     an ordinary merge still reports nothing and a `feat:`-subjected merge that writes a
 *     pinned file in its own resolution is now judged. Reproduced at 294e713: the guard
 *     printed ok over a merge adding `NEW_POSTURE` to `run/policy.ts`.
 *   - A RENAME. `paths.includes(f.trim())` compared a HISTORICAL commit's file list to the
 *     CURRENT pin path, so a `refactor:` rename with the pin updated in the same commit
 *     dropped that file's seams from the ledger AND erased an outstanding unfixed violation
 *     against it. The path set is now the union of every name `git log --follow` says each
 *     pinned file has had, so the history is matched under the names it was written with.
 *   - A ONE-CHARACTER TRAILER. `Kernel-seam: x` satisfied "a sentence of design argument".
 *     `MIN_SEAM_CHARS` is a floor, not a standard — see it.
 *   - DROPPING A PATH FROM `files`. See `everPinnedPaths`: the census now covers every path the
 *     pin has ever named, and a departed path is printed. The build still stops failing for it,
 *     because that is what remedy 3 means.
 *
 * ── The census cannot be reset by `since`, by editing `files`, or by both ───────
 *
 * NOR BY RENAMING THE PIN, and nor by the two knobs in sequence — two corrections this
 * paragraph has needed, one per review round. `everPinnedPaths` named `scripts/kernel.json` in
 * two hard-coded literals and asked for no `--follow`, so `git mv`ing the pin (with the path
 * updated in the same commit) erased the pin's own history and every path only an earlier
 * version named: measured on a clone of HEAD, 11 seams to 10 and the departed-path notice gone.
 * It is followed from `PIN` by the same mechanism its pinned files are.
 * `everPinnedPaths` read the pin's own history over `since..HEAD`, so de-pinning a file and
 * THEN advancing `since` past the de-pin took the ledger to 0 with exit 0 and neither notice
 * printed. Each knob was closed alone and tested alone, which is exactly why neither test saw
 * the composition; it is closed by reading the pin's history over all of HEAD.
 *
 * It could be all three ways, and that was this file's most-repeated false claim. Two knobs bound
 * what is JUDGED, which is right — grandfathering and de-pinning are both legitimate, argued
 * acts, and remedy 3 in the failure text below offers the second one. What neither may do is
 * erase the number a reader watches, and both did: advancing `since` one commit printed
 * `0 declared seams` and exit 0, and dropping a path from `files` under a `refactor:` subject
 * took an outstanding unpaid violation to exit 0 and, on this repo, would take the ledger from
 * 11 to 1 by removing `run/engine.ts` alone.
 *
 * VIOLATIONS are judged in `since..HEAD` against the CURRENT pin. The CENSUS is taken over the
 * FULL history and over every path the pin has EVER named (`everPinnedPaths`), so it moves for
 * no reason but a real one. Two notices carry what the split gives up: how many feat commits
 * touched the kernel before `since` with no seam, and which paths have left the pin — the debt
 * that was grandfathered in each case, which each knob would otherwise silently grow.
 *
 * ── The escape hatch, and why it is not a rubber stamp ───────────────────────────
 *
 * `Kernel-seam:` in the commit body. It costs a sentence of design argument, and this script's
 * own output above is the debt census: it prints every seam declared over the WHOLE history —
 * `since` bounds what is judged and nothing about what is counted — with the reason its file is
 * pinned.
 *
 * READ IT FROM HERE AND NOWHERE ELSE, and this paragraph used to say the opposite. Measured on
 * one range at the point this guard only judged `feat:` subjects: this guard 11, `git log
 * --grep='^Kernel-seam:'` 12 (it matches prose ABOUT the trailer as readily as the trailer), and
 * git's own `%(trailers:key=Kernel-seam)` a third number again, because it parses only the final
 * paragraph of a body. Three commands, three answers.
 *
 * THE GUARD NOW READS A TRAILER ON ANY SUBJECT, MERGES INCLUDED, THROUGH GIT'S OWN PARSER — one
 * more thing this file used not to catch. `fbbdac4`, the `phase1-taint` merge, carries a real
 * `Kernel-seam:` trailer naming three journal words in its own final paragraph; this guard was a
 * `feat`-only reader and never looked at it, so a real declaration sat in `git log` and outside
 * every number above. `nonFeatTrailerSeam` reads it exactly the way `%(trailers:key=...)` does —
 * `git interpret-trailers --parse`, final paragraph only. The REQUIREMENT is untouched — only
 * `feat` commits must carry one — so this is a census fix, not a new refusal. Measured after: this
 * guard 12, the grep still 13. The grep's other extra row is `2a9eda8`, which this guard drops
 * because it touches `TODO.md` and no pinned file — NOT because of the final-paragraph rule; that
 * rule's own worked case is in `kernel-boundary.test.ts` and not in this history. See
 * `nonFeatTrailerSeam`.
 *
 * EIGHT RESETS ARE CLOSED FOR THE CENSUS — the `since` advance, the `files` edit, THE TWO IN
 * SEQUENCE, a rename of a pinned FILE, a rename of THE PIN ITSELF, HISTORY SIMPLIFICATION over
 * both of those reads, the subject spelling and the one-character trailer, each described above
 * with its measurement.
 *
 * THE LAST THREE ARE THE ONES WORTH REMEMBERING, AND EACH WAS FOUND ON THE COMMIT THAT CLAIMED
 * TO HAVE CLOSED THE ONE BEFORE. Three review rounds, three resets, each hiding inside the
 * previous round's fix. That is what "a correction that lands half-done is worse than the
 * defect" measures out to when the thing being corrected is a NUMBER: every round shrank the
 * hole and none of them closed the class, because each fix reached for the next git command
 * without asking what that command's DEFAULTS do. Five were closed and five were tested, each ALONE, and
 * composing two of them reset the ledger anyway. Then the commit that closed the composition
 * read the pin's own history through a hard-coded literal with no `--follow`, which is the
 * rename hole one door further out — so the file that had just written "cannot be reset by
 * editing `files`" could still be reset by moving the file that holds `files`. Ask of a closed
 * reset what it does NEXT TO the other closed ones, and ask of every path this file names
 * whether the path itself can move. What is left is the reset no tool can close, and it is the
 * next paragraph.
 *
 * THE LIMIT THAT FIRES MOST OFTEN IS `fix:`, which may touch the kernel freely — so a capability
 * landing under it is asked for no seam at all. It happened on the phase-2-4 merge: five pinned
 * files changed and `journal/events.ts` gained three new durable payload fields
 * (`run.submitted.limits`, `run.submitted.capabilities`, `run.compiled.postures`), which is new
 * journal VOCABULARY arriving as maintenance. The commit type is the whole signal here, and a
 * reviewer is the only thing reading it.
 *
 * ── Failing closed ───────────────────────────────────────────────────────────────
 *
 * No git, an unreadable pin, an EMPTY pin, a file listed with no `why`, or a pinned path that is
 * no longer in the tree are all exit 1. The last matters most: `check-surface.mjs`'s own history
 * is a guard reading a stale artifact and printing "ok", and a pin that silently stops observing
 * is the same failure. An empty `files` list is refused for the same reason — it would pass
 * everything while watching nothing.
 *
 * ── What this does NOT establish ─────────────────────────────────────────────────
 *
 * Nothing about whether `run/engine.ts` should be split. The audit did not check that, and
 * `engine.ts:1-24` gives three real structural arguments for co-location. Making the boundary
 * observable is the goal here; the number this guard produces is the input to that argument,
 * not its conclusion.
 *
 * Usage: `node scripts/check-kernel.mjs [root]` — root defaults to the repo containing this
 * script. It is an argument so the guard can be pointed at a fixture and shown to fail;
 * `packages/core/test/kernel-boundary.test.ts` does exactly that.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const root = resolve(process.argv[2] ?? REPO);
const PIN = join(root, "scripts", "kernel.json");

/** Every refusal exits here, so there is exactly one way for this guard to say no. */
function refuse(...lines) {
  console.error("kernel guard FAILED — " + lines[0]);
  for (const l of lines.slice(1)) console.error(l);
  process.exit(1);
}

function git(...args) {
  const r = gitRaw(...args);
  return { ...r, out: r.out.trim() };
}

/**
 * Untrimmed, because `status --porcelain` puts its two status columns in the first two
 * characters and an unmodified-in-index file leads with a SPACE. Trimming the whole output
 * ate that space on the first line only, and the notice printed `ackages/core/...`.
 */
function gitRaw(...args) {
  // `maxBuffer` EXPLICITLY, because the default is 1 MB and the full-history census reads every
  // commit message in the repository — 1,297,843 bytes at 294e713, i.e. already past it. The
  // failure is `ENOBUFS` with an EMPTY stderr and a null status, so the guard refused with a
  // blank reason: fail-closed, but unreadable. `r.error` is reported for the same reason.
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const err = (r.stderr ?? "").trim() || (r.error ? String(r.error.message ?? r.error) : "");
  return { ok: r.status === 0, out: r.stdout ?? "", err };
}

/**
 * Like `gitRaw`, but feeds `input` on stdin — used to hand a commit's own message to
 * `git interpret-trailers --parse`, which reads a message body from stdin rather than a ref.
 */
function gitInput(input, ...args) {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  const err = (r.stderr ?? "").trim() || (r.error ? String(r.error.message ?? r.error) : "");
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err };
}

// ── the pin ──────────────────────────────────────────────────────────────────────

if (!existsSync(PIN)) refuse(`${PIN} not found. The kernel has no referent without it.`);

let pin;
try {
  pin = JSON.parse(readFileSync(PIN, "utf8"));
} catch (e) {
  refuse(`${PIN} is not valid JSON: ${e.message}`);
}

if (!Array.isArray(pin.files) || pin.files.length === 0) {
  refuse(
    "the pinned kernel is empty.",
    "  A list of zero files passes every commit while observing nothing, which is",
    "  indistinguishable from having no guard. If the kernel really is empty, delete",
    "  this guard and the claim in CLAUDE.md together.",
  );
}

const paths = [];
for (const entry of pin.files) {
  if (typeof entry?.path !== "string" || entry.path.length === 0) {
    refuse(`${PIN}: every \`files\` entry needs a \`path\`; got ${JSON.stringify(entry)}`);
  }
  if (typeof entry?.why !== "string" || entry.why.trim().length === 0) {
    refuse(
      `${PIN}: \`${entry.path}\` is pinned with no \`why\`.`,
      "  A list nobody can justify is worse than no list — it converts a design claim into",
      "  a habit. Say which non-negotiable this file makes true, or drop it from the list.",
    );
  }
  if (!existsSync(join(root, entry.path))) {
    refuse(
      `\`${entry.path}\` is pinned as kernel but is not in the tree.`,
      "  Renamed, moved or deleted. A pin that points at nothing keeps printing ok while",
      "  observing nothing — update `files` in the same commit that moved the file.",
    );
  }
  paths.push(entry.path);
}

if (typeof pin.since !== "string" || pin.since.trim().length === 0) {
  refuse(`${PIN}: \`since\` must name the commit at which the kernel became observable.`);
}

/**
 * An OBJECT NAME, never a ref. Reproduced while writing this guard: with `"since": "HEAD"` the
 * range `HEAD..HEAD` is empty, so the guard printed `kernel guard ok: … 0 commits judged since fb813ec`
 * over a `feat` commit that had just rewritten a pinned file. Any moving ref — `HEAD`, `@`, a
 * branch, a tag someone re-points — is the same vacuum, and it is the cheapest way to switch
 * this guard off without deleting it.
 */
if (!/^[0-9a-f]{7,40}$/.test(pin.since.trim())) {
  refuse(
    `${PIN}: \`since\` must be a commit SHA, not \`${pin.since}\`.`,
    "  A ref moves with the branch, and `HEAD..HEAD` is empty — the guard would print ok",
    "  over any commit at all. Pin the object name of the commit being grandfathered.",
  );
}

// ── git ──────────────────────────────────────────────────────────────────────────

if (!git("rev-parse", "--git-dir").ok) {
  refuse(
    `${root} is not a git repository.`,
    "  Intent lives in commit messages and nowhere else, so with no history this guard",
    "  cannot decide. It refuses rather than passing: loosening is never the default.",
  );
}

const since = git("rev-parse", "--verify", "--quiet", `${pin.since}^{commit}`);
if (!since.ok) {
  refuse(
    `\`since\` (${pin.since}) is not a commit in this repository.`,
    "  A rewritten or shallow history leaves the guard unable to name the range it should",
    "  judge. Re-pin `since` to a commit this checkout actually has.",
  );
}

const RS = "\x1e";
const US = "\x1f";

/**
 * EVERY NAME EACH PINNED FILE HAS EVER HAD, not the name it has today.
 *
 * The matcher compares a historical commit's file list to this set, and comparing it to the
 * CURRENT path was the laundering hole: `git mv run/policy.ts run/authz.ts` with `kernel.json`
 * updated in the same `refactor:` commit made every earlier commit against `run/policy.ts`
 * invisible — dropping declared seams from the ledger and, worse, erasing an outstanding
 * unfixed violation. Reproduced at 294e713 both ways.
 *
 * `--follow` is per-path by construction (git refuses it on more than one pathspec), which is
 * why this is a loop rather than one call. It is cheap: ten calls, 0.14 s over 681 commits.
 * A rename git cannot detect (a delete and an unrelated add) still escapes, and no tool
 * reading git can do better — that one belongs to the reviewer with the rest of them.
 */
function historicalNames(path) {
  // `--full-history` BESIDE `--follow`, because a pathspec makes git SIMPLIFY by default: a
  // commit whose change to this path did not survive into the first-parent line is dropped, so
  // a rename made on a side branch and resolved away is invisible. git accepts the two together
  // (measured), and the whole point of this set is that it is not simplified.
  const r = git("log", "--follow", "--full-history", "--name-only", "--format=", "HEAD", "--", path);
  if (!r.ok) refuse(`could not follow \`${path}\` through history: ${r.err}`);
  const names = new Set([path]);
  for (const line of r.out.split("\n")) {
    const f = line.trim();
    if (f.length > 0) names.add(f);
  }
  return names;
}

const watched = new Set();
for (const p of paths) for (const name of historicalNames(p)) watched.add(name);

/**
 * EVERY PATH THE PIN HAS EVER NAMED, recovered from `kernel.json`'s own history.
 *
 * The fifth reset, and it is the rename hole one door over. `historicalNames` follows a file
 * that MOVED; nothing followed a file that was simply DROPPED from `files`. Reproduced on a
 * fixture: a `refactor(kernel): src/other.ts is not kernel after all` commit took an
 * outstanding unpaid violation to `exit=0`, and a second commit re-pinning onto a new file took
 * the ledger from 1 declared seam to 0. On this repo, dropping `run/engine.ts` would take the
 * published count from 11 to 1.
 *
 * THE SPLIT IS THE SAME ONE `since` GETS, and for the same reason. De-pinning is a legitimate,
 * argued act — the guard's own failure text offers it as remedy 3 — so VIOLATIONS are judged
 * against the CURRENT pin and a file argued out of the kernel stops failing the build. What it
 * must not do is erase the number a reader watches, so the CENSUS is taken over every path the
 * pin has ever held. A seam declared against a file is a fact about the kernel's history and
 * does not stop being one when the file leaves the list.
 *
 * WHAT IS LEFT, named rather than claimed closed: an UNPAID violation against a de-pinned file
 * stops failing the build, by construction, because that is what remedy 3 means. The report
 * says so when the two path sets differ, so the reviewer this file keeps deferring to is
 * looking at the number rather than guessing at it.
 */
function everPinnedPaths() {
  const out = new Set(paths);
  // ALL OF HEAD, NOT `since..HEAD`, AND THAT WAS THE SIXTH RESET — the two knobs composed.
  // Scoping this read to the judged range meant a de-pin that happened BEFORE `since` was
  // invisible to the census the de-pin rule exists to protect, so the two documented-legitimate
  // acts, taken in order, erased the number a reader watches with NEITHER notice printed:
  //
  //     1. `refactor(kernel): src/engine.ts is not kernel after all`  → ledger 1, notice printed
  //     2. `chore(kernel): grandfather everything up to the de-pin`   → ledger 0, exit 0, silent
  //
  // Measured on a fixture and reproduced independently by two readers. Each knob alone was
  // closed and each was tested alone, which is exactly why neither test saw it. `since` bounds
  // what is JUDGED and must bound nothing about what is COUNTED — including which paths were
  // ever counted. The census reads the pin's whole history for the same reason it reads the
  // whole commit history.
  // AND UNDER EVERY NAME THE PIN ITSELF HAS EVER HAD, which the first version of this did not
  // do — it named `scripts/kernel.json` in two hard-coded literals and asked for no `--follow`.
  // That was the rename hole a THIRD door over: `historicalNames` follows a pinned FILE that
  // moved, `everPinnedPaths` follows a pinned PATH that was dropped, and nothing followed THE
  // PIN. Driven on a clone of HEAD, two `refactor:` commits and exit 0 throughout:
  //
  //     1. refactor(kernel): engine.ts is not kernel after all       → 11 seams, notice printed
  //     2. git mv scripts/kernel.json scripts/pins/kernel.json,
  //        with PIN and these literals updated in the same commit    → 10 seams, notice GONE,
  //                                                                    grandfathered 36 → 22
  //
  // …on the very commit whose subject was "the kernel census had a sixth reset". A correction
  // that lands half-done is worse than the defect, and this file has now paid that twice. The
  // pin is followed by the same mechanism its pinned files are, from `PIN`'s own current path.
  const pinRel = relative(root, PIN);
  const pinNames = [...historicalNames(pinRel)];
  // `--full-history`, AND THAT WAS THE EIGHTH RESET — in the commit that closed the seventh.
  // `commitsIn("HEAD")` takes NO pathspec, so it really is the whole history; this read takes
  // one, and a pathspec turns on git's default history simplification. So a merge whose
  // resolution discarded a side branch's edit to the pin dropped that version of the pin, and
  // with it every path only that version named. Driven on a fixture with `-s ours` (an ordinary
  // conflict resolved in favour of the first parent is the same shape):
  //
  //     git log                HEAD -- scripts/kernel.json  → 2 commits, the side pin invisible
  //     git log --full-history HEAD -- scripts/kernel.json  → 4, the side pin recovered
  //
  // …and the guard printed `0 declared seams`, exit 0, no departed-path notice, where the
  // identical commits on a LINEAR history printed 1 seam and the notice. The docstring above
  // said "the census reads the pin's whole history for the same reason it reads the whole
  // commit history" while the two reads were differently scoped. Now they are not.
  const log = git("log", "--full-history", "--format=%H", "HEAD", "--", ...pinNames);
  // AND IT REFUSES RATHER THAN DEGRADING. `return out` here answered "the pin has only ever
  // named what it names today", which IS the de-pin reset — the census failing open into the
  // exact hole it exists to close. Every other git failure in this file refuses; so does this.
  if (!log.ok) refuse(`could not read the pin's own history: ${log.err}`);
  for (const sha of log.out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    // THE PIN'S NAME AS OF THAT COMMIT, not today's: after a rename, `${sha}:${today}` does not
    // exist for any commit before it. Each candidate is tried and the first that reads wins.
    let blob;
    for (const name of pinNames) {
      const r = git("show", `${sha}:${name}`);
      if (r.ok) {
        blob = r;
        break;
      }
    }
    if (blob === undefined) continue;
    try {
      for (const e of JSON.parse(blob.out).files ?? []) {
        if (typeof e?.path === "string" && e.path.length > 0) out.add(e.path);
      }
    } catch {
      // A malformed pin in HISTORY is not this run's problem — the CURRENT one is validated
      // above, and refusing here would make an old bad commit unfixable forever.
    }
  }
  return out;
}

const everWatched = new Set();
for (const p of everPinnedPaths()) for (const name of historicalNames(p)) everWatched.add(name);

/**
 * MERGES ARE READ, NOT SKIPPED. `--no-merges` was here on a false premise this file stated
 * outright — "`git show --name-only` reports nothing for them". `git show` on a merge prints
 * the COMBINED diff: empty for an ordinary merge, and exactly the resolution's own changes for
 * an evil one. So including merges costs no false positives and closes the hole where a
 * `feat:`-subjected merge rewrites a pinned file inside its conflict resolution.
 */
function commitsIn(range) {
  const log = git("log", "--format=%H%x1f%s%x1f%b%x1e", range);
  if (!log.ok) refuse(`could not read \`${range}\`: ${log.err}`);
  return log.out
    .split(RS)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, subject, body = ""] = c.split(US);
      return { sha, subject, body };
    });
}

/**
 * The repo's convention is Conventional Commits; only `feat` claims to add capability.
 *
 * CASE-INSENSITIVE, LEADING SPACE TOLERATED, AND `feature` ACCEPTED. The strict form
 * (`/^feat(\([^)]*\))?!?:/`) read five ordinary spellings of the same claim as some other
 * type entirely. Widening it reclassifies nothing in this repo's history — all 35 feat commits
 * in `86b84c9..HEAD` match under both — so the only commits it can newly judge are ones nobody
 * has written yet.
 */
const FEAT = /^[ \t]*feat(?:ure)?(\([^)]*\))?!?:/i;
const SEAM = /^Kernel-seam:[ \t]*(\S.*)$/m;
/**
 * A FLOOR, NOT A STANDARD. The docstring's "it costs a sentence of design argument" was
 * satisfied by `Kernel-seam: x`, and a guard whose stated price is one character is a guard
 * whose ledger a reader cannot read. 40 characters and a space is roughly the shortest thing
 * that can be a sentence; the eleven seams declared in this repo run 71 characters and up, so
 * this refuses none of them. Whether a seam argument is GOOD is a reviewer's judgement and
 * always will be — this only stops the trailer from being free.
 */
const MIN_SEAM_CHARS = 40;

/** Which pinned files (under any name they have had) a commit touched. */
function kernelFilesTouched(sha, set) {
  const shown = git("show", "--name-only", "--format=", sha);
  if (!shown.ok) refuse(`could not read the file list of ${sha}: ${shown.err}`);
  return shown.out.split("\n").filter((f) => set.has(f.trim()));
}

/**
 * Whether a commit carries a `Kernel-seam:` trailer BY GIT'S OWN RULE, not this file's plain-text
 * regex — used for commits `FEAT` does not classify as capability (merges included), which are
 * never REQUIRED to declare but whose trailer, if git's own trailer parser recognizes one, is real
 * design argument the census must not drop.
 *
 * `SEAM` (the regex `judge` uses for `feat` commits) matches any line starting `Kernel-seam:`
 * ANYWHERE in the body, which over-counts exactly the way `git log --grep` over-counts: it credits
 * a body that only QUOTES the trailer as an example inside a larger paragraph of prose with a
 * declaration it never made. `git interpret-trailers --parse` recognizes a trailer only in the
 * message's own FINAL paragraph, which is the same rule the escape hatch already claims to follow
 * ("git's own trailer parser reads only the final paragraph") — so non-feat commits are read
 * through it instead of the regex.
 *
 * STATE THE MECHANISM, NOT AN EXAMPLE THAT DOES NOT DEMONSTRATE IT. This docstring named
 * `2a9eda8` — one of the two rows `git log --grep` has over this guard — as the commit the
 * final-paragraph rule excludes, and that was false. `git show --name-only --format= 2a9eda8`
 * prints `TODO.md` and nothing else, so `kernelFilesTouched` returns empty and it is out before
 * any trailer rule runs at all; measured, a mutant of this function using the plain `SEAM` regex
 * and no `git interpret-trailers` produces the byte-identical 12-row census on this repo. The
 * rule is still the right general mechanism and the wrong one to justify by that example — what
 * it is FOR is the commit nothing here has yet written: a body quoting the trailer mid-prose
 * while ALSO touching a pinned file. `kernel-boundary.test.ts` supplies exactly that pair, the
 * quoted one and the same string as a genuine final paragraph, because on this repo's own history
 * the discriminating variable is never exercised.
 *
 * Only called for a commit whose body contains the literal fragment at all (a cheap check against
 * the body `commitsIn` already fetched), so the `git show -s --format=%B` + `git interpret-trailers`
 * pair this runs costs nothing on the hundreds of ordinary commits that plainly don't.
 */
function nonFeatTrailerSeam(sha) {
  const msg = git("show", "-s", "--format=%B", sha);
  if (!msg.ok) refuse(`could not read the message of ${sha}: ${msg.err}`);
  const parsed = gitInput(msg.out, "interpret-trailers", "--parse", "--no-divider");
  if (!parsed.ok) refuse(`could not parse the trailers of ${sha}: ${parsed.err}`);
  const m = /^Kernel-seam:[ \t]*(\S.*)$/im.exec(parsed.out);
  if (!m) return undefined;
  const value = m[1].trim();
  return value.length >= MIN_SEAM_CHARS && /\s/.test(value) ? value : undefined;
}

/**
 * `FEAT` commits are judged for both the REQUIREMENT (a missing or thin trailer is a violation)
 * and the CENSUS, via the plain regex — unchanged. Every other subject, merges included, is never
 * required to declare and so can never violate; but if `nonFeatTrailerSeam` finds a trailer git's
 * own parser recognizes as real, on a commit that touches the kernel, it is real design argument
 * and belongs in `declared` — this is the fix for the ledger's most-cited gap: `fbbdac4`, a
 * `merge:` commit, carries one naming three journal words, and until now the guard never looked.
 */
function judge(commits, set = watched) {
  const violations = [];
  const declared = [];
  for (const c of commits) {
    if (FEAT.test(c.subject)) {
      const touched = kernelFilesTouched(c.sha, set);
      if (touched.length === 0) continue;
      const seam = SEAM.exec(c.body);
      const value = seam ? seam[1].trim() : "";
      if (seam && (value.length < MIN_SEAM_CHARS || !/\s/.test(value))) {
        violations.push({ ...c, touched, thin: value });
      } else if (seam) {
        declared.push({ ...c, touched, seam: value });
      } else {
        violations.push({ ...c, touched });
      }
      continue;
    }
    if (!/Kernel-seam/i.test(c.body)) continue;
    const touched = kernelFilesTouched(c.sha, set);
    if (touched.length === 0) continue;
    const seam = nonFeatTrailerSeam(c.sha);
    if (seam !== undefined) declared.push({ ...c, touched, seam });
  }
  return { violations, declared };
}

const commits = commitsIn(`${since.out}..HEAD`);
const { violations, declared } = judge(commits);

/**
 * THE CENSUS IS TAKEN OVER ALL OF HEAD, so `since` cannot zero it.
 *
 * `since` grandfathers what is JUDGED — that is what it is for, and advancing it after a real
 * review is a legitimate act. What it must not do is erase the number a reader watches, and it
 * did: one line of `kernel.json` took the ledger from 11 to 0 with every test still green.
 * Counting over the whole history costs one more pass and makes the reset visible instead.
 */
const all = judge(commitsIn("HEAD"), everWatched);
/**
 * Feat commits that touched the kernel BEFORE `since` and declared nothing: the grandfathered
 * debt, judged over exactly the commits `since` excludes.
 *
 * IT USED TO BE `all.violations.length - violations.length`, WHICH IS TWO SUBTRACTIONS AT ONCE.
 * `all` is judged over `everWatched` and `violations` over `watched`, so a violation INSIDE
 * `since..HEAD` against a DE-PINNED path fell into the difference and was reported as "touched
 * the kernel before `since`" — untrue of that commit, and it files de-pin debt under the
 * `since` heading when the de-pin notice below is what should carry it. Measured: a `feat`
 * commit two commits AFTER `since`, de-pinned, printed `1 feat commit(s) touched the kernel
 * before `since``.
 *
 * Judging `since` itself — the commits reachable FROM it — answers the question the notice
 * asks, with no arithmetic between two differently-scoped runs.
 */
const grandfathered = judge(commitsIn(since.out), everWatched).violations.length;
/**
 * SEAMS THAT WERE DECLARED AND ARE TOO THIN TO COUNT, said out loud rather than dropped.
 *
 * A `Kernel-seam:` trailer under `MIN_SEAM_CHARS` becomes a VIOLATION, and a violation outside
 * the judged range is never printed and never counted — so introducing the floor silently
 * DELETED any pre-`since` seam that failed it, from a ledger whose whole job is not to lose
 * numbers. None exists in this repo (the eleven run 71 characters and up), which is exactly why
 * it would have gone unnoticed: the floor's own arrival is a census-shrinking event nobody
 * would have seen. Counted separately because the count means something different — these
 * commits DID declare, and what is missing is the argument.
 */
const thin = all.violations.filter((v) => v.thin !== undefined).length;

// ── the working tree: a notice, never a failure ──────────────────────────────────

const dirty = gitRaw("status", "--porcelain", "--", ...paths);
const dirtyFiles = dirty.ok
  ? dirty.out
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).trim())
  : [];

// ── report ───────────────────────────────────────────────────────────────────────

if (violations.length > 0) {
  console.error("kernel guard FAILED — a change that adds capability touched the kernel.");
  console.error("");
  for (const v of violations) {
    console.error(`  ${v.sha.slice(0, 7)}  ${v.subject}`);
    for (const f of v.touched) console.error(`            ${f}`);
    if (v.thin !== undefined) {
      console.error(
        `            its Kernel-seam trailer is ${String(v.thin.length)} character(s), ` +
          `"${v.thin}" — the floor is ${String(MIN_SEAM_CHARS)} and a space`,
      );
    }
  }
  console.error("");
  console.error("CLAUDE.md property 1: if a feature must change the kernel, the kernel is missing");
  console.error("a seam, and the seam is the thing to design. Three ways forward, all deliberate:");
  console.error("");
  console.error("  1. Move the capability behind a seam so the kernel file stops changing.");
  console.error("  2. If it genuinely belongs in the kernel, amend the commit with a trailer");
  console.error("     naming the seam that was missing:");
  console.error("");
  console.error("         Kernel-seam: <which seam was absent, and why adding one was worse>");
  console.error("");
  console.error("     It is not a rubber stamp: this script's own output is the running census");
  console.error("     of every time the kernel absorbed a feature. Read it from here — `git log");
  console.error("     --grep` over-counts (it matches prose about the trailer) and git's own");
  console.error("     trailer parser reads only the final paragraph. Three commands, three answers.");
  console.error("");
  console.error(`  3. Or the file is not kernel after all — argue that in ${PIN}.`);
  process.exit(1);
}

console.log(
  `kernel guard ok: ${paths.length} files pinned, ` +
    `${commits.length} commits judged since ${since.out.slice(0, 7)}, ` +
    `${all.declared.length} declared seam${all.declared.length === 1 ? "" : "s"} over the full history` +
    (declared.length === all.declared.length ? "" : ` (${declared.length} of them judged, the rest before \`since\`)`),
);
// THE FULL-HISTORY LEDGER, not the judged range's. `since` decides what is enforced and must
// not decide what is visible — see the census note above.
for (const d of all.declared) {
  console.log(`  seam  ${d.sha.slice(0, 7)}  ${d.subject}`);
  console.log(`        ${d.seam}`);
}
// THE PATHS THAT HAVE LEFT THE PIN, said out loud. De-pinning is remedy 3 and is allowed; what
// is not allowed is for it to be invisible. Their seams stay in the census above.
const departed = [...everWatched].filter((f) => !watched.has(f)).sort();
if (departed.length > 0) {
  console.log(
    `  notice: ${String(departed.length)} path(s) were pinned as kernel earlier in this history and are not now. ` +
      "Their declared seams are still counted; an UNPAID violation against one no longer fails the build:",
  );
  for (const f of departed) console.log(`        ${f}`);
}
if (thin > 0) {
  console.log(
    `  notice: ${String(thin)} commit(s) declared a Kernel-seam trailer shorter than the ` +
      `${String(MIN_SEAM_CHARS)}-character floor, so they are counted as undeclared rather than as seams. ` +
      "The floor arriving must not quietly shrink the ledger.",
  );
}
if (grandfathered > 0) {
  console.log(
    `  notice: ${String(grandfathered)} feat commit(s) touched the kernel before \`since\` (${since.out.slice(0, 7)}) ` +
      "and declared no seam. Grandfathered, not paid — advancing `since` grows this number.",
  );
}
if (dirtyFiles.length > 0) {
  console.log(
    `  notice: ${dirtyFiles.length} kernel file(s) modified but not committed — ` +
      "no commit message yet, so not judged:",
  );
  for (const f of dirtyFiles) console.log(`        ${f}`);
}
process.exit(0);
