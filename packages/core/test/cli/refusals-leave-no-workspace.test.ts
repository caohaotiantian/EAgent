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
 * **THE SET THIS COVERS, and why it is this set.** A member is a refusal decided FROM ARGV ALONE,
 * so creating a workspace to reach it buys nothing:
 *
 *   1. no verb at all, `help`, `--help`, and `--help` after a verb — the usage, exit 0;
 *   2. an unknown verb, INCLUDING a name that exists on `Object.prototype` (§H.11's own case),
 *      and one carrying an `--extension-module`, which used to be LOADED AND RUN before the verb
 *      was judged — argv naming a path to execute, for a command this binary does not have;
 *   3. an unknown flag (`assertKnownFlags`);
 *   4. a known flag the verb does not read (`refuseFlagsThisVerbDoesNotRead`);
 *   5. a repeated `--extension-module` (`refuseRepeated`);
 *   6. **EVERY** global flag given with no value — all thirteen, plus `--help` and `--mcp-file`,
 *      iterated out of `GLOBAL_FLAGS` in the source rather than listed here, so a global added
 *      later is covered on the day it is added.
 *
 * (2) was open, and so was most of (6): measured on the parent commit, SEVEN of the fifteen
 * refused with nothing on disk — `--workspace`, `--data-dir`, `--channels-file`, `--models-file`
 * and `--extension-module` by `openWorkspace`'s own pre-flight, plus `--mcp-file`, which held for
 * a DIFFERENT reason (`main` reads it before it calls `openWorkspace` at all), and `--help`, which
 * is not a value — and EIGHT left three directories (`--grant`, `--egress`, `--exec-env`,
 * `--allow-exec`, the three `--budget-*`, `--max-parallelism`), because `openWorkspace` ran its
 * three `mkdirSync`s the moment the two path flags were read. They are read before it now. The
 * rest of the set already held, and each holds for a DIFFERENT reason — orderings a later edit can
 * reverse one at a time without touching the one §H.11 named.
 *
 * **AND THE SET THAT IS NOT COVERED**, pinned below as what it is rather than described. Two
 * families, both refused inside a `case` block with the workspace already open, both measured
 * leaving `.loom/`, `graphs/` and `resources/`:
 *
 *   - a VERB flag given with no value — `run --input`, `serve --port`, `serve --token`;
 *   - a missing POSITIONAL — `compile`, `score`, `gates`, each with none.
 *
 * Neither is an ordering: a verb flag needs a flag-ARITY table to be judged at the door (a second
 * list beside `KNOWN_FLAGS`, kept in step by hand, which is the drift §H.10 spent two files on),
 * and a positional needs a per-verb arity table beside it. So the boundary of the set is asserted,
 * and the day either table exists these rows move up.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { refusing } from "../deployment/harness.ts";

/**
 * A directory that starts empty, so what is in it afterwards is what the command put there.
 *
 * `plant` writes files the command is meant to READ — an extension module, say — and they are
 * subtracted from what is reported, because a file the test put there is not litter.
 */
async function inAnEmptyDirectory(
  argv: (dir: string) => readonly string[],
  plant: Readonly<Record<string, string>> = {},
): Promise<{ code: number | null; out: string; err: string; left: readonly string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-empty-cwd-"));
  try {
    for (const [name, body] of Object.entries(plant)) writeFileSync(join(dir, name), body);
    const { code, out, err } = await refusing(argv(dir), dir);
    // `Object.hasOwn`, not `f in plant`: `"constructor" in {}` is TRUE, so a file the command
    // created called `constructor`, `toString` or `__proto__` would be subtracted from what it
    // left behind — which is `dispatchesVerb`'s own defect, in the file whose subject is it.
    return { code, out, err, left: readdirSync(dir).filter((f) => !Object.hasOwn(plant, f)).sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `GLOBAL_FLAGS`, read out of the source the way `verb-flags.test.ts` reads its lists. */
function globalFlags(): readonly string[] {
  const src = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
  const m = /const GLOBAL_FLAGS: readonly string\[\] = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, "GLOBAL_FLAGS moved — this test reads it from the source on purpose");
  return [...m[1]!.matchAll(/"([a-z][a-z-]*)"/g)].map((x) => x[1]!).sort();
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
];

for (const row of LEAVES_NOTHING) {
  test(`${row.what} — \`loom ${row.argv.join(" ")}\` leaves an empty directory empty`, async () => {
    const { code, out, err, left } = await inAnEmptyDirectory(() => row.argv);
    assert.deepEqual(left, [], `\`loom ${row.argv.join(" ")}\` created ${left.join(", ")} in the caller's cwd — stderr was:\n${err}`);
    assert.equal(code, row.code, `exit code, stderr:\n${err}`);
    // A HELP PATH HAS TO HAVE HELPED SOMEBODY. Exit 0 and an empty directory is also what a
    // command that printed nothing at all would produce, and the usage goes to STDOUT — so this
    // is the assertion that tells the two apart, and the reason `refusing` returns `out`.
    if (row.code === 0) assert.match(out, /loom — graph-native/, `\`loom ${row.argv.join(" ")}\` printed no usage`);
  });
}

test("EVERY GLOBAL FLAG GIVEN NO VALUE REFUSES WITH NOTHING ON DISK — the list read from the source", async () => {
  // NOT A LIST RESTATED HERE. `GLOBAL_FLAGS` is the set of flags `openWorkspace` and `main` read
  // before the switch dispatches, so it is exactly the set whose missing value can be judged from
  // argv — and reading it out of the source is what makes a global added next year covered on the
  // day it is added, instead of covered by whoever remembers this file.
  //
  // WHAT THIS CAUGHT. Seven of the fifteen refused with nothing on disk — the five path flags
  // `openWorkspace` reads first, plus `--mcp-file` (refused in `main`, before this function is
  // called) and `--help` (not a value) — and EIGHT did not, because `openWorkspace` ran its three
  // `mkdirSync`s as soon as the two path flags had been read and everything else — the jail, the
  // grant list, the ceiling, the budget — was read between forty and four hundred lines later.
  // Those four reads are pure over `args` and now happen first.
  const flags = globalFlags();
  // EXACT, NOT A FLOOR. The number moves with `GLOBAL_FLAGS` and bumping it is the point: a floor
  // with two members of slack passes on exactly the scan this line exists to catch — a regex that
  // matched most of the list — and a new global arriving uncovered is the other thing it catches.
  assert.equal(flags.length, 15, `the scan found ${String(flags.length)} global flags: ${flags.join(", ")}. Either the regex broke, or GLOBAL_FLAGS changed — check the new flag is covered below, then set this number to it`);
  for (const f of flags) {
    const { code, out, err, left } = await inAnEmptyDirectory(() => ["compile", `--${f}`]);
    assert.deepEqual(left, [], `\`loom compile --${f}\` (no value) created ${left.join(", ")} — stderr was:\n${err}`);
    // `--help` is the one global that is not a value at all: it prints the usage and exits 0.
    assert.equal(code, f === "help" ? 0 : 1, `\`loom compile --${f}\` (no value), stderr:\n${err}`);
    if (f === "help") assert.match(out, /loom — graph-native/);
    else assert.match(err, new RegExp(`--${f}`), `the refusal for --${f} does not name the flag: ${err}`);
  }
});

test("AN UNKNOWN VERB DOES NOT LOAD --extension-module — argv naming a path to EXECUTE", async () => {
  // THE HALF THAT IS NOT ABOUT DIRECTORIES. `loadExtensionModules` ran between `parseArgs` and
  // `openWorkspace`, so `loom nonsense --extension-module ./evil.mjs` imported and RAN the module
  // and only then printed `unknown command`. Measured both ways on the same fixture — a module
  // whose top level writes a marker file: with the door removed it exits 1 and the marker exists;
  // with the door it exits 2 and the marker does not.
  //
  // `--extension-module` reads its path from ARGV AND NOWHERE ELSE, which is the whole trust
  // argument at `loadExtensionModules`; a verb this binary does not have is not a reason to
  // execute what argv named, and the door is now the thing that says so.
  const module = 'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./EXECUTED", import.meta.url), "ran\\n");\nexport default () => ({ tools: [] });\n';
  const { code, err, left } = await inAnEmptyDirectory((dir) => ["nonsense", "--extension-module", join(dir, "evil.mjs")], { "evil.mjs": module });
  assert.equal(code, 2, `stderr:\n${err}`);
  assert.match(err, /unknown command "nonsense"/);
  assert.deepEqual(left, [], `the module ran, or the workspace was opened: ${left.join(", ")}`);
});

test("AN UNKNOWN VERB SAYS SO — even one whose name is a property of Object.prototype", async () => {
  // `VERB_FLAGS` is an object literal, so `VERB_FLAGS["constructor"]` is a FUNCTION and the
  // `applies === undefined` lookup this replaced fell through to `applies.includes(f)`. Measured
  // before the fix: `E_INTERNAL: TypeError: applies.includes is not a function`, exit 1 — an
  // internal error where the operator's mistake was a verb that does not exist. `Object.hasOwn`
  // is the whole of the repair, and this is the case that says so.
  const bare = await inAnEmptyDirectory(() => ["constructor"]);
  assert.match(bare.err, /unknown command "constructor"/);
  const flagged = await inAnEmptyDirectory(() => ["constructor", "--port", "1"]);
  assert.match(flagged.err, /unknown command "constructor"/);
  assert.doesNotMatch(flagged.err, /E_INTERNAL|includes is not a function/, "the prototype key reached a member lookup again");
});

/**
 * THE BOUNDARY, ASSERTED — the refusals that still cost three directories, and are not in the set.
 *
 * A RECORD, NOT A WISH. Each of these throws from inside a `case` block, which `main` reaches only
 * with `ws` already built. Neither family is an ordering: a verb flag with no value can only be
 * judged at the door against a flag-ARITY table, and a missing positional against a per-verb arity
 * table — second and third lists beside `KNOWN_FLAGS`, kept in step by hand, which is the drift
 * §H.10 spent two files on. The day either table exists, these rows move into `LEAVES_NOTHING`
 * and this block shrinks; until then this is what stops the set's boundary from being a sentence
 * nobody checks.
 */
const STILL_OPENS_A_WORKSPACE: readonly { readonly what: string; readonly argv: readonly string[]; readonly says: RegExp }[] = [
  { what: "a verb flag with no value", argv: ["run", "--input"], says: /--input was given with no value/ },
  { what: "a verb flag with no value", argv: ["serve", "--port"], says: /--port was given with no value/ },
  { what: "a verb flag with no value", argv: ["serve", "--token"], says: /--token needs a non-empty value/ },
  { what: "a missing positional", argv: ["compile"], says: /compile requires a graph file/ },
  { what: "a missing positional", argv: ["score"], says: /score requires a runId/ },
  { what: "a missing positional", argv: ["gates"], says: /gates requires a runId/ },
];

for (const row of STILL_OPENS_A_WORKSPACE) {
  test(`NOT IN THE SET · ${row.what} — \`loom ${row.argv.join(" ")}\` still opens a workspace first`, async () => {
    const { code, err, left } = await inAnEmptyDirectory(() => row.argv);
    assert.equal(code, 1, err);
    assert.match(err, row.says);
    assert.deepEqual(left, [".loom", "graphs", "resources"], `\`loom ${row.argv.join(" ")}\` no longer opens a workspace — good: move it into LEAVES_NOTHING`);
  });
}
