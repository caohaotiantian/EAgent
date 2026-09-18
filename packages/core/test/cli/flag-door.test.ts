/**
 * A FLAG'S VALUE AND A VERB'S ARGUMENTS ARE DECIDED BEFORE ANYTHING IS ON DISK — TODO.md §H.12,
 * §H.13.
 *
 * `openWorkspace` creates `.loom/`, `graphs/` and `resources/`, and `--workspace` defaults to the
 * cwd. §H.11 moved the refusals decided from argv alone above that — the verb, the flag NAMES,
 * the globals' values — and stopped at two families it could not reach, measured rather than
 * waved away:
 *
 *     [run --input]   exit=1 left=[.loom graphs resources]  E_CONFIG_INVALID: --input was given…
 *     [serve --port]  exit=1 left=[.loom graphs resources]  E_CONFIG_INVALID: --port was given…
 *     [serve --token] exit=1 left=[.loom graphs resources]  E_CONFIG_INVALID: --token needs a…
 *     [compile]       exit=1 left=[.loom graphs resources]  E_INTERNAL: Error: compile requires…
 *     [score]         exit=1 left=[.loom graphs resources]  E_INTERNAL: Error: score requires…
 *     [gates]         exit=1 left=[.loom graphs resources]  E_INTERNAL: Error: gates requires…
 *
 * The stated obstacle was a flag-ARITY table: a second list beside `KNOWN_FLAGS`, kept in step by
 * hand, which is the drift §H.10 spent two files on.
 *
 * ## Why there is no arity table, and what this file gates instead
 *
 * `KNOWN_FLAGS` is `Object.keys(FLAGS)` now. `FLAGS` is ONE table whose second column is the
 * FUNCTION that decides that flag's value from argv alone — the same function the `case` block
 * calls — so "does `--port` need a value" has exactly one implementation and there is nothing
 * written down for it to drift from. The door calls the entry for each flag present in argv.
 *
 * So the thing that CAN drift is which flags have an entry, and that is what is recomputed here,
 * the way `verb-flags.test.ts` recomputes the verb set out of the same source file:
 *
 *   > `FLAGS[f]` is the UNIQUE top-level function declared `function name(args: Args)` — `main`
 *   > excluded — that reads `f`, whether directly as `args.flags["f"]` or through a helper called
 *   > `helper(args, "f")`; and `null` when there is no such function or more than one.
 *
 * `(args: Args)` IS A SIGNATURE, NOT A VERDICT, and the difference has now cost two rounds of
 * review. It says a reader cannot NEED the workspace, so calling it at the door is not calling it
 * early; it says nothing about whether one that takes `ws` actually uses it, and nothing at all
 * about a read that is not in a named function.
 *
 * `--identity-file` and `--graph` were both written off as "argv cannot decide them", and the two
 * were not even wrong in the same way. `--identity-file` really did sit behind a `(ws, args)`
 * helper, `pickIdentity` — which decides it with `requireFileFlag(args, …)` and wants `ws` for a
 * different question. `--graph` has FOUR reads and only one of them is behind such a helper
 * (`recordedGraph`, shared by `replay` and `trace`); the other three were written out inside
 * `main`'s `approve`, `audit` and `score` blocks, where the rule ignores them because it ignores
 * `main`. All four are a `pathFlag` on argv. Both flags have readers now.
 *
 * So the rule finds candidates mechanically, and it has exactly two ways of producing a `null`
 * that is about the CODE rather than the flag: a read inside a function that takes more than
 * `args`, and a read inside `main`. Whether a given `null` is a fact about the flag or an accident
 * of where somebody wrote the read is a question the rule cannot answer and a reader has to.
 *
 * More than one reader means the sentence depends on the verb — `--as` has three — and the door
 * does not guess. A flag that grows a reader and keeps `null` fails the first test below; a flag
 * whose entry names a function that does not read it fails it too.
 *
 * The same shape one level over for arguments: `VERB_POSITIONALS` holds the WORDS a missing
 * argument is named with, `requirePositional` looks them up there, and the door walks the row —
 * so the second test recomputes each row's LENGTH from the indices its `case` block passes.
 *
 * ## And the behaviour, driven rather than argued
 *
 * A structural gate can be satisfied by a table nothing reads. The two sweeps at the bottom spawn
 * the binary once per flag and once per verb, each in its own `mkdtempSync` cwd, and assert the
 * property in the terms an operator would state it: it refused, it said `E_CONFIG_INVALID`, and
 * the directory it was run in is still empty.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main } from "../../src/cli.ts";
import { refusing } from "../deployment/harness.ts";

const SRC = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
const LINES = SRC.split("\n");

// ── the source, read rather than restated ───────────────────────────────────

/** Every top-level `function name(…)` body, keyed by name. A body ends at the first `}` in column 0. */
function topLevelFunctions(): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < LINES.length; i++) {
    const m = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*[(<]/.exec(LINES[i]!);
    if (m === null) continue;
    let j = i + 1;
    while (j < LINES.length && !LINES[j]!.startsWith("}")) j++;
    out.set(m[1]!, LINES.slice(i, j).join("\n"));
  }
  return out;
}

/**
 * The functions whose whole input is argv — `function name(args: Args)` and nothing else.
 *
 * MATCHED ON ONE LINE on purpose. A parameter list that runs over several lines is never this
 * shape, and a regex that spanned lines would have to decide where the list ends in a file whose
 * parameters carry docstrings with brackets in them.
 */
function argvOnlyReaders(): Map<string, string> {
  const bodies = topLevelFunctions();
  const out = new Map<string, string>();
  for (const line of LINES) {
    const m = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\(args: Args\)/.exec(line);
    if (m === null || m[1] === "main") continue;
    out.set(m[1]!, bodies.get(m[1]!)!);
  }
  return out;
}

/**
 * `FLAGS` as the source writes it: flag name → the entry's text (`null`, or a function name).
 *
 * A ROW THIS CANNOT PARSE IS A FAILURE, NOT A SKIP, and that is the whole of the second half of
 * this function. The value pattern is a bare identifier: a row that grew a trailing comment, a
 * cast, an arrow or a second line would match the KEY regex and not this one, and every gate in
 * this file reads its flags from here — so a dropped row would silently leave a flag unchecked by
 * BOTH the structural test and the sweep, which is the failure mode this file exists to prevent.
 * The keys are counted a second way, with the loose pattern `known-flags.test.ts` uses, and the
 * two counts must agree. A floor like `size >= 40` against 43 rows cannot see three rows go
 * missing; this can see one.
 */
function flagsTable(): Map<string, string> {
  const m = /const FLAGS: Readonly<Record<string, \(\(args: Args\) => unknown\) \| null>> = \{([\s\S]*?)\n\};/.exec(SRC);
  assert.ok(m, "FLAGS moved — this gate reads it from the source on purpose");
  const out = new Map<string, string>();
  for (const row of m[1]!.matchAll(/^ {2}"?([A-Za-z0-9_-]+)"?: ([A-Za-z0-9_]+),$/gm)) out.set(row[1]!, row[2]!);
  const keys = [...m[1]!.matchAll(/^ {2}"?([A-Za-z0-9_-]+)"?:/gm)].map((x) => x[1]!);
  assert.deepEqual(
    [...out.keys()].sort(),
    [...keys].sort(),
    `a FLAGS row's value is not a bare identifier, so this file's gates would silently skip it: ${keys.filter((k) => !out.has(k)).map((k) => `--${k}`).join(", ")}`,
  );
  return out;
}

/** `VERB_POSITIONALS` as the source writes it: verb → how many arguments the row names. */
function positionalsTable(): Map<string, number> {
  const m = /const VERB_POSITIONALS: Readonly<Record<string, readonly string\[\]>> = \{([\s\S]*?)\n\};/.exec(SRC);
  assert.ok(m, "VERB_POSITIONALS moved — this gate reads it from the source on purpose");
  const out = new Map<string, number>();
  for (const row of m[1]!.matchAll(/^ {2}"?([A-Za-z0-9_-]+)"?: \[([\s\S]*?)\],$/gm)) {
    // A backtick string FIRST: one of the rows is a template literal containing double quotes,
    // and matching `"…"` first would count the quoted word inside it as a second argument.
    out.set(row[1]!, [...row[2]!.matchAll(/`[^`]*`|"[^"]*"/g)].length);
  }
  return out;
}

/** `VERB_FLAGS` as the source writes it, so a sweep can pick a verb that reads a given flag. */
function verbFlags(): Map<string, readonly string[]> {
  const m = /const VERB_FLAGS: Readonly<Record<string, readonly string\[\]>> = \{([\s\S]*?)\n\};/.exec(SRC);
  assert.ok(m, "VERB_FLAGS moved — this gate reads it from the source on purpose");
  const out = new Map<string, readonly string[]>();
  for (const row of m[1]!.matchAll(/^ {2}"?([A-Za-z0-9_-]+)"?: \[([^\]]*)\],$/gm)) {
    out.set(row[1]!, [...row[2]!.matchAll(/"([A-Za-z0-9_-]+)"/g)].map((x) => x[1]!));
  }
  return out;
}

/** `GLOBAL_FLAGS`, the flags every verb reads. */
function globalFlags(): readonly string[] {
  const m = /const GLOBAL_FLAGS: readonly string\[\] = \[([\s\S]*?)\];/.exec(SRC);
  assert.ok(m, "GLOBAL_FLAGS moved — this gate reads it from the source on purpose");
  return [...m[1]!.matchAll(/"([A-Za-z0-9_-]+)"/g)].map((x) => x[1]!);
}

// ── the tables, recomputed ──────────────────────────────────────────────────

test("THE ROWS THIS FILE PARSED ARE THE FLAGS THE BINARY RUNS WITH — not two regexes agreeing", async () => {
  // Both halves of `flagsTable`'s own check scan the SAME string, so they can agree and both be
  // wrong. This is the third path and the only one that goes through the module: `main(["help"])`
  // renders `USAGE`, and `known-flags.test.ts` holds `USAGE` equal to the flag table's keys. A
  // row that this file's regexes dropped would be advertised by the binary and missing here.
  const real = process.stdout.write.bind(process.stdout);
  let printed = "";
  process.stdout.write = ((c: string) => ((printed += c), true)) as typeof process.stdout.write;
  try {
    assert.equal(await main(["help"]), 0);
  } finally {
    process.stdout.write = real;
  }
  const advertised = [...new Set([...printed.matchAll(/--([A-Za-z0-9_-]+)/g)].map((x) => x[1]!))].sort();
  assert.deepEqual([...flagsTable().keys()].sort(), advertised, "a flag the binary advertises is not a row this file parsed, or vice versa");
});

test("`FLAGS`' SECOND COLUMN IS WHAT ACTUALLY READS THE FLAG — recomputed from the source", () => {
  const declared = flagsTable();
  const readers = argvOnlyReaders();
  assert.ok(declared.size >= 40, `the scan found ${String(declared.size)} rows in FLAGS — the regex broke, not the CLI`);
  assert.ok(readers.size >= 15, `the scan found ${String(readers.size)} argv-only readers — the regex broke, not the CLI`);

  for (const [flag, entry] of declared) {
    const reads: string[] = [];
    for (const [name, body] of readers) {
      // Directly, or through one of the helpers that take the name — `pathFlag(args, "graph")`.
      // Deliberately over-inclusive: "can reach" is the only reading under which a door is safe.
      if (new RegExp(`args\\.flags\\["${flag}"\\]|\\b[A-Za-z0-9_]+\\(args, "${flag}"`).test(body)) reads.push(name);
    }
    const expected = reads.length === 1 ? reads[0]! : "null";
    assert.equal(
      entry,
      expected,
      reads.length === 0
        ? `--${flag} is decided by no \`(args: Args)\` reader, so its entry must be null`
        : reads.length === 1
          ? `--${flag} is decided by \`${reads[0]!}\` and by nothing else, so that is its entry — the door and the verb body must refuse through ONE function`
          : `--${flag} is decided by ${reads.length} readers (${reads.join(", ")}), so the message depends on the verb and the door must not guess: its entry must be null`,
    );
  }
});

test("`VERB_POSITIONALS` IS WHAT EACH `case` BLOCK ASKS FOR — recomputed from the source", () => {
  const declared = positionalsTable();

  // The `case` labels of `main`'s switch, and the span of source each one owns.
  const cases: { verb: string; at: number }[] = [];
  for (let i = 0; i < LINES.length; i++) {
    const m = /^ {6}case "([A-Za-z0-9_-]+)":/.exec(LINES[i]!);
    if (m !== null) cases.push({ verb: m[1]!, at: i });
  }
  assert.ok(cases.length >= 15, `the scan found ${String(cases.length)} verbs — the regex broke, not the CLI`);
  const end = LINES.findIndex((l, i) => i > cases[0]!.at && /^ {6}default:/.test(l));
  assert.notEqual(end, -1, "main's switch has no default arm — this scan reads it as the end of the last block");

  const asked = new Map<string, Set<number>>();
  for (let k = 0; k < cases.length; k++) {
    const body = LINES.slice(cases[k]!.at, k + 1 < cases.length ? cases[k + 1]!.at : end).join("\n");
    asked.set(cases[k]!.verb, new Set([...body.matchAll(/requirePositional\(args, (\d+)\)/g)].map((m) => Number(m[1]!))));
  }
  // FALL-THROUGH SHARES ITS READER'S ARGUMENTS. `case "pause":` has no body of its own and runs
  // `resume`'s, so a row read off an empty block would say `loom pause` needs no runId.
  for (let k = 0; k < cases.length; k++) {
    if (asked.get(cases[k]!.verb)!.size === 0 && k + 1 < cases.length) {
      const first = LINES[cases[k]!.at]!.trim();
      if (first.endsWith(":") && !first.endsWith("{")) asked.set(cases[k]!.verb, new Set(asked.get(cases[k + 1]!.verb)!));
    }
  }

  assert.deepEqual([...declared.keys()].sort(), [...asked.keys()].sort(), "a verb has a case block and no row, or a row and no verb");
  for (const [verb, indices] of asked) {
    // CONTIGUOUS FROM ZERO, because the door walks `0 … length - 1`: a block asking only for
    // index 1 would have a row of length 2 whose first entry names an argument nothing reads.
    assert.deepEqual([...indices].sort((a, b) => a - b), [...indices].map((_, i) => i), `\`loom ${verb}\` asks for a non-contiguous set of arguments`);
    assert.equal(declared.get(verb), indices.size, `\`loom ${verb}\`'s row is not as long as the number of arguments its case block requires`);
  }
});

// ── and the behaviour ───────────────────────────────────────────────────────

/** A directory that starts empty, so what is in it afterwards is what the command put there. */
async function inAnEmptyDirectory(argv: readonly string[]): Promise<{ code: number | null; err: string; left: readonly string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "loom-door-"));
  try {
    const { code, err } = await refusing(argv, dir);
    return { code, err, left: readdirSync(dir).sort() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("EVERY FLAG `FLAGS` NAMES A READER FOR REFUSES A MISSING VALUE WITH NOTHING ON DISK", async () => {
  // NOT A LIST RESTATED HERE: the flags are the non-null rows of `FLAGS`, and the verb each one
  // is driven on comes out of `VERB_FLAGS`, so a flag that gains a reader next year is swept on
  // the day it gains one. A global is driven on `compile`, which reaches no socket.
  //
  // WHAT THIS ASSERTS THAT THE STRUCTURAL TEST CANNOT: that the reader in the table actually
  // REFUSES a bare flag, and that the door actually calls it. That pair is the arity claim —
  // measured here, per flag, rather than written down anywhere to be kept in step by hand.
  const globals = new Set(globalFlags());
  const rows = verbFlags();
  const withReader = [...flagsTable()].filter(([, entry]) => entry !== "null").map(([flag]) => flag);
  assert.ok(withReader.length >= 25, `only ${String(withReader.length)} flags have a reader — the regex broke, not the CLI`);

  for (const flag of withReader) {
    // `serve` binds a socket when it is not refused, so it is the LAST resort — it is the only
    // verb that reads `--port`, `--token`, `--host` and `--sweep-ms`. `refusing` kills the child
    // at 15s, so a mutation that removed the refusal fails loudly instead of hanging the suite.
    const verb = globals.has(flag) ? "compile" : ([...rows].find(([v, fs]) => v !== "serve" && fs.includes(flag))?.[0] ?? [...rows].find(([, fs]) => fs.includes(flag))?.[0]);
    assert.ok(verb !== undefined, `--${flag} has a reader and belongs to no verb — \`refuseFlagsThisVerbDoesNotRead\` would reject it everywhere`);
    const { code, err, left } = await inAnEmptyDirectory([verb, `--${flag}`]);
    assert.deepEqual(left, [], `\`loom ${verb} --${flag}\` (no value) created ${left.join(", ")} — stderr was:\n${err}`);
    assert.equal(code, 1, `\`loom ${verb} --${flag}\` (no value), stderr:\n${err}`);
    assert.match(err, /E_CONFIG_INVALID/, `\`loom ${verb} --${flag}\` (no value) is an operator's mistake, not an internal error:\n${err}`);
    assert.match(err, new RegExp(`--${flag}`), `the refusal for --${flag} does not name the flag:\n${err}`);
  }
});

test("EVERY VERB MISSING AN ARGUMENT REFUSES `E_CONFIG_INVALID` WITH NOTHING ON DISK — §H.13", async () => {
  // §H.13 asked for the CODE on `compile`, `score` and `gates`. It is asserted on all seventeen
  // verbs that take an argument, because they all threw the same bare `Error` through the same
  // helper — the three the row named are the three somebody happened to run.
  const rows = [...positionalsTable()].filter(([, n]) => n > 0);
  assert.ok(rows.length >= 15, `the scan found ${String(rows.length)} verbs taking an argument — the regex broke, not the CLI`);
  for (const [verb] of rows) {
    const { code, err, left } = await inAnEmptyDirectory([verb]);
    assert.deepEqual(left, [], `\`loom ${verb}\` with no argument created ${left.join(", ")} — stderr was:\n${err}`);
    assert.equal(code, 1, `\`loom ${verb}\` with no argument, stderr:\n${err}`);
    // THE WHOLE OF §H.13 IS THIS LINE. It used to be `E_INTERNAL: Error: <verb> requires …` —
    // this system's word for "a bug in Loom" — for an operator who left out an argument.
    assert.match(err, /E_CONFIG_INVALID/, `\`loom ${verb}\` with no argument is misfiled as an internal error:\n${err}`);
    assert.doesNotMatch(err, /E_INTERNAL/, `\`loom ${verb}\` with no argument still answers E_INTERNAL:\n${err}`);
    // NAMING THE VERB AND WHAT IT WANTED, which is the other half of the row.
    assert.match(err, new RegExp(`loom ${verb} requires `), `the refusal does not name the verb and what it wanted:\n${err}`);
  }
});

test("A FLAG WITH A VALUE IS NOT REFUSED BY THE DOOR — the false-positive half", async () => {
  // The half that matters more: a door that refuses a value the verb would have accepted is
  // worse than the litter it was added to stop. `compile` fails for its missing graph file — a
  // reason that is NOT any of these flags, which is what proves they got past.
  for (const argv of [
    ["compile", "--max-parallelism", "2", "--grant", "graph:mutate"],
    ["compile", "--budget-usd", "1", "--egress", "example.invalid"],
    // `serve` is the only verb reading these four, and a `serve` the door lets through BINDS. The
    // trailing `--mcp-file` is what stops it: its path passes the door and the FILE READ that
    // follows fails, which is a refusal that is not the door's and is reached only by getting
    // past it. Without it this row would hang instead of failing — and `refusing`'s 15s kill is
    // the wrong way to learn that four flags were accepted.
    ["serve", "--port", "0", "--token", "s3cret", "--host", "127.0.0.1", "--sweep-ms", "1000", "--mcp-file", "nope.json"],
    ["run", "--input", '{"source":"a.txt"}', "--budget", "1"],
  ]) {
    const { err } = await inAnEmptyDirectory(argv);
    for (const f of argv.filter((a) => a.startsWith("--"))) {
      assert.doesNotMatch(err, new RegExp(`${f} (was given|needs|must be)`), `\`${argv.join(" ")}\` refused ${f}, which carries a value:\n${err}`);
    }
  }
});
