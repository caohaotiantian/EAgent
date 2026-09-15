/**
 * A REFUSAL THAT READS ARGV ALONE MUST COST THE CALLER NOTHING ON DISK — TODO.md §H.11.
 *
 * `openWorkspace` creates `.loom/`, `graphs/` and `resources/`, and `--workspace` defaults to the
 * current directory, so "wherever you happened to be standing" is where they land. `main` used to
 * open the workspace before the `switch (args.command)` whose `default` arm prints the usage, and
 * the measured consequence was:
 *
 *     $ R=$PWD; D=$(mktemp -d); cd "$D"; node "$R/packages/core/src/cli.ts" nonsense 2>err; ls -a
 *     .   ..   .loom   err   graphs   resources
 *
 * — three directories in a stranger's cwd, for a verb the binary does not have. It is also §H.10's
 * second file: the same open is what put a `.loom/` in the repo when a spawned test omitted
 * `--workspace`, and `.gitignore` is why nobody saw it for as long as they did.
 *
 * **THE SET THIS COVERS, and why it is this set.** A member is a refusal `main` can decide FROM
 * ARGV ALONE, so opening a workspace to reach it buys nothing:
 *
 *   1. no verb at all, `help`, `--help`, and `--help` after a verb — the usage, exit 0;
 *   2. an unknown verb, INCLUDING a name that exists on `Object.prototype` (§H.11's own case);
 *   3. an unknown flag (`assertKnownFlags`);
 *   4. a known flag the verb does not read (`refuseFlagsThisVerbDoesNotRead`);
 *   5. a repeated `--extension-module` (`refuseRepeated`);
 *   6. a GLOBAL flag given with no value — `--workspace`, refused by `openWorkspace`'s pre-flight
 *      before it creates anything.
 *
 * Only (2) was open; the other five already held, and they are here because each holds for a
 * DIFFERENT reason — five orderings, any one of which a later edit can reverse without touching
 * the one §H.11 named. (6) is the one decided inside `openWorkspace` rather than before it, which
 * is exactly the ordering that could rot silently.
 *
 * **AND THE ONE THAT IS NOT A MEMBER**, pinned below as what it is: a VERB flag given with no
 * value (`loom run --input`) is refused inside its own `case` block, after the workspace is open.
 * Hoisting it needs a flag-ARITY table — a second list beside `KNOWN_FLAGS`, kept in step by hand —
 * and three lists drifting apart is the defect §H.10 spent two files on. So the boundary of the set
 * is asserted rather than described.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { refusing } from "../deployment/harness.ts";

/** A directory that starts empty, so what is in it afterwards is what the command put there. */
async function inAnEmptyDirectory(argv: readonly string[]): Promise<{ code: number | null; err: string; left: readonly string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-empty-cwd-"));
  try {
    const { code, err } = await refusing(argv, dir);
    return { code, err, left: readdirSync(dir).sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The set above, one row each: what a stranger types, and the exit code they get for it. */
const LEAVES_NOTHING: readonly { readonly what: string; readonly argv: readonly string[]; readonly code: number }[] = [
  { what: "no verb at all", argv: [], code: 0 },
  { what: "the `help` verb", argv: ["help"], code: 0 },
  { what: "`--help` with no verb", argv: ["--help"], code: 0 },
  { what: "`--help` after a verb", argv: ["run", "--help"], code: 0 },
  { what: "an unknown verb", argv: ["nonsense"], code: 2 },
  { what: "an unknown verb named on Object.prototype", argv: ["constructor"], code: 2 },
  { what: "an unknown verb named on Object.prototype, with a flag", argv: ["constructor", "--port", "1"], code: 2 },
  { what: "an unknown flag", argv: ["run", "--bogus", "x"], code: 1 },
  { what: "a known flag this verb does not read", argv: ["score", "--suite", "x"], code: 1 },
  { what: "a repeated --extension-module", argv: ["compile", "--extension-module", "a", "--extension-module", "b"], code: 1 },
  { what: "a global flag given with no value", argv: ["compile", "--workspace"], code: 1 },
];

for (const row of LEAVES_NOTHING) {
  test(`${row.what} — \`loom ${row.argv.join(" ")}\` leaves an empty directory empty`, async () => {
    const { code, err, left } = await inAnEmptyDirectory(row.argv);
    assert.deepEqual(left, [], `\`loom ${row.argv.join(" ")}\` created ${left.join(", ")} in the caller's cwd — stderr was:\n${err}`);
    assert.equal(code, row.code, `exit code, stderr:\n${err}`);
  });
}

test("AN UNKNOWN VERB SAYS SO — even one whose name is a property of Object.prototype", async () => {
  // `VERB_FLAGS` is an object literal, so `VERB_FLAGS["constructor"]` is a FUNCTION and the
  // `applies === undefined` lookup this replaced fell through to `applies.includes(f)`. Measured
  // before the fix: `E_INTERNAL: TypeError: applies.includes is not a function`, exit 1 — an
  // internal error where the operator's mistake was a verb that does not exist. `Object.hasOwn`
  // is the whole of the repair, and this is the case that says so.
  const bare = await inAnEmptyDirectory(["constructor"]);
  assert.match(bare.err, /unknown command "constructor"/);
  const flagged = await inAnEmptyDirectory(["constructor", "--port", "1"]);
  assert.match(flagged.err, /unknown command "constructor"/);
  assert.doesNotMatch(flagged.err, /E_INTERNAL|includes is not a function/, "the prototype key reached a member lookup again");
});

test("THE BOUNDARY: a VERB flag with no value is refused AFTER the workspace opens, and is not in the set", async () => {
  // A RECORD, NOT A WISH. `runInputs` throws from inside `case "run"`, which `main` reaches only
  // with `ws` already built, so this refusal still costs three directories. It is not in the set
  // above because closing it means a flag-arity table and not an ordering change — see this file's
  // header. The day that table exists, delete this case and move the row into `LEAVES_NOTHING`;
  // until then this assertion is what stops the set's boundary from being a sentence nobody checks.
  const { code, err, left } = await inAnEmptyDirectory(["run", "--input"]);
  assert.equal(code, 1, err);
  assert.match(err, /--input was given with no value/);
  assert.deepEqual(left, [".loom", "graphs", "resources"], "`loom run --input` no longer opens a workspace — good: move it into LEAVES_NOTHING");
});
