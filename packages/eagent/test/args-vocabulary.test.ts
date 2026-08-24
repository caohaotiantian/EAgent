/**
 * The flag vocabulary exists THREE times in `args.ts`, and nothing held the three together.
 *
 * `FLAGS` declares every flag including short aliases. `parseArgs` re-lists all fourteen as
 * string literals in its `else if` chain. `OPTIONS_HELP` re-lists them a third time as the help
 * text both front ends print. A flag added to one and forgotten in the others is silent in the
 * direction that matters: advertised and unimplemented (`unknown option`, at the user), or
 * implemented and undiscoverable (works, documented nowhere).
 *
 * **`FLAGS` had no reader at all**, and its docstring named two — the TUI's help and "its parity
 * test". The TUI imports `OPTIONS_HELP` and `parseArgs`; the parity test was never written. So
 * the list a maintainer would update first was the one nothing consulted, which is worse than
 * having two lists: it is two lists plus a decoy.
 *
 * This is the class `HANDOFF.md`'s *Traps* names — *"A VOCABULARY WITH TWO REPRESENTATIONS WILL
 * DRIFT, and every gate iterating the wrong one is silently switched off"* — found twice at the
 * Loom end (error codes, event types) and never looked for here.
 *
 * ## Read from the SOURCE, never restated
 *
 * Every list below is extracted from `src/args.ts` by reading the file, the way
 * `packages/core/test/cli/known-flags.test.ts` reads `KNOWN_FLAGS` and `USAGE`. A test that
 * restates the expected flags is a FOURTH representation, and it drifts like the other three —
 * it would go green on a flag nobody implemented as soon as somebody updated the test.
 *
 * ## What this gate cannot see
 *
 * `packages/eagent/tui` is outside every gate in this repository — not typechecked by the root
 * `typecheck`, not matched by the root test glob, not a workspace, so its dependencies are never
 * installed. Its `cli.tsx` prints `OPTIONS_HELP` and calls `parseArgs`, so it inherits whatever
 * this file protects; but nothing here executes a line of it. Recorded so the coverage claim is
 * the true one — see `design/loom/HANDOFF.md` §6.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FLAGS, OPTIONS_HELP, parseArgs } from "../src/args.ts";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "args.ts"), "utf8");

/** `FLAGS`, read from the source rather than imported — so a mismatch names the DECLARATION. */
function declared(): readonly string[] {
  const m = /export const FLAGS = \[([\s\S]*?)\] as const;/.exec(SRC);
  assert.ok(m, "FLAGS moved or changed shape — this gate reads it from the source on purpose");
  return [...m[1]!.matchAll(/"(--?[a-z][a-z-]*)"/g)].map((x) => x[1]!).sort();
}

/** Every flag literal `parseArgs` actually compares against — what the code READS. */
function parsed(): readonly string[] {
  const m = /export function parseArgs\(argv: string\[\]\): Args \{([\s\S]*?)\n\}/.exec(SRC);
  assert.ok(m, "parseArgs moved or changed shape — this gate reads its body from the source");
  return [...new Set([...m[1]!.matchAll(/a === "(--?[a-z][a-z-]*)"/g)].map((x) => x[1]!))].sort();
}

/**
 * Every flag `OPTIONS_HELP` advertises — what the USER is told.
 *
 * The flag column only. A description carries hyphenated prose ("Auto-grant capabilities") and
 * value placeholders, and a token scan over the whole line would collect `-grant` as a flag —
 * so each line is cut at the first run of two or more spaces, which is the column separator.
 */
function advertised(): readonly string[] {
  const out = new Set<string>();
  for (const line of OPTIONS_HELP.split("\n")) {
    const spec = line.trim().split(/\s{2,}/)[0] ?? "";
    for (const m of spec.matchAll(/(--?[a-z][a-z-]*)/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

test("FLAGS, parseArgs AND OPTIONS_HELP ARE ONE SET", () => {
  const d = declared();
  // Non-vacuous: an empty extraction would make every comparison below trivially true, which is
  // exactly how a regex that stopped matching turns a gate into a no-op.
  assert.ok(d.length >= 10, `FLAGS extraction returned ${String(d.length)} — the regex stopped matching`);

  assert.deepEqual(
    parsed(),
    d,
    "parseArgs and FLAGS disagree: a flag the parser accepts is undeclared, or a declared flag is unparsed",
  );
  assert.deepEqual(
    advertised(),
    d,
    "OPTIONS_HELP and FLAGS disagree: a flag is advertised and unimplemented, or implemented and undiscoverable",
  );
});

test("the imported FLAGS is the one this gate checked", () => {
  // The three extractions above are textual. If `FLAGS` were ever built at runtime — spread,
  // filtered, concatenated — the source form and the exported value could differ and every
  // assertion above would be about a list nothing imports.
  assert.deepEqual([...FLAGS].sort(), [...declared()], "the exported FLAGS is not the literal in the source");
});

test("EVERY DECLARED FLAG IS ONE parseArgs ACCEPTS — the behaviour, not the literal", () => {
  // The set comparison is textual and could pass on a literal in a dead branch. This runs the
  // parser. Value-taking flags reject a missing value, which is a different refusal and a
  // correct one; the only unacceptable answer is "unknown option".
  for (const flag of FLAGS) {
    let message = "";
    try {
      parseArgs([flag, "value"]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.ok(
      !message.startsWith("unknown option"),
      `${flag} is declared in FLAGS and refused by parseArgs: ${message}`,
    );
  }
});

test("an undeclared flag is still REFUSED, so the set above is a closed one", () => {
  // The positive control. Without it, "no flag is refused" would also be true of a parser that
  // refused nothing at all, and the test above would be measuring the absence of a guard.
  assert.throws(
    () => parseArgs(["--not-a-real-flag"]),
    /unknown option: --not-a-real-flag/,
    "an unknown flag must be refused, not collected as prompt text",
  );
});
