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
 * the true one — see `the design notes` §6.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FLAGS, OPTIONS_HELP, parseArgs } from "../src/args.ts";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "args.ts"), "utf8");

/**
 * A flag NAME, for every extractor here.
 *
 * `[\w-]` and not `[a-z-]`, which was the first version and was wrong in the silent direction:
 * `--oauth2` and `--http2` are ordinary flag names, and a class that stops at lowercase letters
 * does not match them PARTIALLY — it fails to match the literal at all. Adding `--http2` to
 * `FLAGS` *and* to `parseArgs` then left both extractors returning nothing for it and the
 * three-way equality vacuously satisfied: two extractors agreeing because both were broken,
 * which is the one way a comparison test proves nothing at all.
 */
const FLAG = String.raw`--?[A-Za-z][\w-]*`;

/** `FLAGS`, read from the source rather than imported — so a mismatch names the DECLARATION. */
function declared(): readonly string[] {
  const m = /export const FLAGS = \[([\s\S]*?)\] as const;/.exec(SRC);
  assert.ok(m, "FLAGS moved or changed shape — this gate reads it from the source on purpose");
  // Comments stripped first: `// TODO: add "--dry-run"` inside the array is not a declaration,
  // and counting it turned a harmless note into a red test naming an undeclared flag.
  const body = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...body.matchAll(new RegExp(`"(${FLAG})"`, "g"))].map((x) => x[1]!).sort();
}

/**
 * Every flag `parseArgs` can accept — what the code READS.
 *
 * **EVERY DASH-PREFIXED STRING LITERAL IN THE BODY, not the `a === "…"` form.** Matching the
 * comparison shape made this defeatable by FORMATTING: `a==="--x"` without spaces was invisible
 * to it, and so were `["--x","--y"].includes(a)`, a `switch` on `a`, and any helper. Each
 * accepts a real flag at runtime while the test stays green — measured, all three. A parser
 * cannot compare against a flag it does not SPELL, so scanning the spellings asks the total
 * question; matching one syntax for asking it does not.
 *
 * `a.startsWith("-")`'s `"-"` does not match — `FLAG` requires a letter after the dashes — and
 * the `(try --help)` in the error message is a template literal, which this deliberately does
 * not scan: prose mentioning a flag is not a parser accepting one.
 */
function parsed(): readonly string[] {
  const m = /export function parseArgs\(argv: string\[\]\): Args \{([\s\S]*?)\n\}/.exec(SRC);
  assert.ok(m, "parseArgs moved or changed shape — this gate reads its body from the source");
  return [...new Set([...m[1]!.matchAll(new RegExp(`"(${FLAG})"`, "g"))].map((x) => x[1]!))].sort();
}

/**
 * Every flag `OPTIONS_HELP` advertises — what the USER is told.
 *
 * The flag column only, cut at the first run of two spaces OR a tab. A description carries
 * hyphenated prose ("Auto-grant capabilities"), so a token scan over the whole line collects
 * `-grant` as a flag, and a single-space separator was enough to reintroduce that.
 *
 * Placeholders are stripped before scanning, because they are not flags and they contain
 * hyphens: widening `<name>` to `<name-or-id>` made this report `-or-id` as "advertised and
 * unimplemented" — a red test naming a token that is not a flag, about a change that broke
 * nothing. **A guard that cries wolf on correct code is worse than no guard.**
 */
function advertised(): readonly string[] {
  const out = new Set<string>();
  for (const line of OPTIONS_HELP.split("\n")) {
    const spec = (line.trim().split(/\s{2,}|\t/)[0] ?? "").replace(/<[^>]*>/g, "");
    for (const m of spec.matchAll(new RegExp(`(${FLAG})`, "g"))) out.add(m[1]!);
  }
  return [...out].sort();
}

test("FLAGS, parseArgs AND OPTIONS_HELP ARE ONE SET", () => {
  const d = declared();
  const p = parsed();
  const a = advertised();
  // Non-vacuous, and all THREE are floored rather than just the first. An extraction that
  // returns nothing makes its comparison trivially true, so a regex that quietly stopped
  // matching turns this gate into a no-op that reports green — and only the floor sees it.
  for (const [name, got] of [["FLAGS", d], ["parseArgs", p], ["OPTIONS_HELP", a]] as const) {
    assert.ok(got.length >= 10, `the ${name} extraction returned ${String(got.length)} — its regex stopped matching`);
  }

  assert.deepEqual(
    p,
    d,
    "parseArgs and FLAGS disagree: a flag the parser accepts is undeclared, or a declared flag is unparsed",
  );
  assert.deepEqual(
    a,
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

test("EVERY ADVERTISED FLAG IS ONE parseArgs ACCEPTS — the behaviour, not the literal", () => {
  // The set comparison is textual and could pass on a literal in a dead branch. This runs the
  // parser. Value-taking flags reject a missing value, which is a different refusal and a
  // correct one; the only unacceptable answer is "unknown option".
  //
  // ADVERTISED, NOT `FLAGS` — the lesson `packages/core/test/cli/known-flags.test.ts` wrote in
  // capitals and this file's first draft ignored while citing it as its model. Iterating the
  // list under test is self-referential: dropping a flag from `FLAGS` also drops it from the
  // loop, so the mutation that does exactly that leaves this green. `OPTIONS_HELP` is the
  // operator-facing promise and the honest thing to hold the parser to.
  for (const flag of advertised()) {
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
