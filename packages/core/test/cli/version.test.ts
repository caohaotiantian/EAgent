/**
 * `loom --version` ANSWERS WITH THE VERSION, and a flag with no verb is judged like any other.
 *
 * Before: `parseArgs` defaults a missing verb to `help`, and `main` answered `help` before it
 * looked at a single flag — so `loom --version` and `loom --bogus` both printed the usage and
 * exited 0. The first made "which build is installed" unanswerable; the second is the silence
 * `assertKnownFlags` exists to refuse, reachable only by leaving the verb off.
 *
 * TODO.md §H.19, the residue `assertKnownFlags` alone did not close: `loom --port 1` (a KNOWN
 * flag, naming no verb) and `loom --version --tokne x` (an unknown one riding beside `--version`,
 * which used to answer and return before `assertKnownFlags` ever ran) both exited 0. The fix moved
 * `assertKnownFlags` ahead of `versionFlag` and added `refuseFlagsBeforeAVerb` for the flags that
 * ARE known but unread by both `--version` and the default `help` answer.
 *
 * TODO.md §A.91 M2, the fix round that followed: the FIRST draft of `refuseFlagsBeforeAVerb`
 * treated every flag as unread, `GLOBAL_FLAGS` included — so `loom --workspace .`, naming no verb,
 * refused with "--workspace is read by no verb this binary dispatches", which is false for all
 * fourteen globals, and a wrapper shaped `loom() { command loom --workspace ~/ws "$@"; }` exited 1
 * on `wrapper --version` and on a bare `wrapper` where the real binary exited 0. Fixed by exempting
 * `GLOBAL_FLAGS` the way `refuseFlagsThisVerbDoesNotRead` already does for a dispatched verb.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { VERSION } from "../../src/version.ts";

const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string };

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const real = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
  try {
    return { code: await main(argv), out };
  } finally {
    process.stdout.write = real;
  }
}

test("VERSION IS THE PACKAGE'S VERSION — the constant exists because the binary has no package.json", () => {
  assert.equal(VERSION, PKG.version, "bump src/version.ts and packages/core/package.json together");
});

test("`loom --version` prints `loom <version>` and nothing else, with or without a verb", async () => {
  for (const argv of [["--version"], ["run", "g.json", "--version"]]) {
    const r = await cli(argv);
    assert.equal(r.code, 0, argv.join(" "));
    assert.equal(r.out, `loom ${PKG.version}\n`, argv.join(" "));
  }
});

test("`loom --version` READS NO FLAG BESIDE ITSELF — TODO.md §H.19, both exit non-zero naming the flag", async () => {
  // UNKNOWN, riding beside --version: before the fix `versionFlag` answered and returned before
  // `assertKnownFlags` ever ran, so a misspelt --token was accepted and ignored.
  await assert.rejects(
    () => cli(["--version", "--tokne", "x"]),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /unknown flag: --tokne/.test(e.message),
  );
  // KNOWN, but unread by --version or by any verb this invocation names: `assertKnownFlags` alone
  // cannot catch this one, because --port IS a flag the binary understands — just not this one's.
  await assert.rejects(
    () => cli(["--version", "--port", "1"]),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--port is read by `loom serve`/.test(e.message),
  );
});

test("`loom` NAMING NO VERB READS NO FLAG EITHER — TODO.md §H.19's other half", async () => {
  // Before the fix this printed the whole usage and exited 0: --port is a KNOWN flag, so
  // `assertKnownFlags` said nothing, and "help" (never a `case` in the switch) is not a row
  // `refuseFlagsThisVerbDoesNotRead` checks — so nothing between the parse and the usage print
  // ever looked at it.
  await assert.rejects(
    () => cli(["--port", "1"]),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--port is read by `loom serve`/.test(e.message),
  );
});

test("A GLOBAL FLAG BESIDE `--version` OR NAMING NO VERB IS ACCEPTED — TODO.md §A.91 M2", async () => {
  // `--workspace` is read by EVERY verb (`GLOBAL_FLAGS`), including the ones this door answers
  // before `openWorkspace` is ever reached — a wrapper prepending it ahead of whatever the caller
  // typed is the ordinary shape, not a misuse `refuseFlagsBeforeAVerb` gets to invent an opinion
  // about.
  const withVersion = await cli(["--workspace", "/does/not/need/to/exist", "--version"]);
  assert.equal(withVersion.code, 0, "a global flag beside --version must not be refused");
  assert.equal(withVersion.out, `loom ${PKG.version}\n`);

  const bare = await cli(["--workspace", "/does/not/need/to/exist"]);
  assert.equal(bare.code, 0, "a global flag naming no verb must not be refused — base behaviour: the usage");
  assert.match(bare.out, /^loom — graph-native multi-agent orchestration/);
});

test("`--version` GIVEN A VALUE IS REFUSED, not dropped while the verb runs", async () => {
  // Before the flag existed `--version 1` was an unknown flag and refused; a first draft that
  // checked `=== true` only let `loom run g.json --version 1` run the graph and exit 0.
  for (const argv of [["run", "g.json", "--version", "1"], ["--version=yes"], ["--version", "foo"]]) {
    await assert.rejects(
      () => cli(argv),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--version takes no value/.test(e.message),
      argv.join(" "),
    );
  }
});

test("A BARE `--` is refused without a guess that lists every flag", async () => {
  await assert.rejects(
    () => cli(["--"]),
    (e: unknown) => isLoomError(e) && /unknown flag: --\. /.test(e.message) && !/did you mean/.test(e.message),
  );
});

test("AN UNKNOWN FLAG WITH NO VERB IS REFUSED — it used to print the usage and exit 0", async () => {
  for (const argv of [["--bogus"], ["help", "--tokne", "x"]]) {
    await assert.rejects(
      () => cli(argv),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /unknown flag/.test(e.message),
      argv.join(" "),
    );
  }
});

test("`--help` READS NO FLAG BESIDE ITSELF EITHER — TODO.md §A.91 N7, the hole --version had", async () => {
  // `loom --help --tokne x` used to answer `--help` before `assertKnownFlags` ever ran, the exact
  // shape `--version` was fixed for in §H.19 above — an unknown flag riding beside it was silently
  // accepted and read by nothing.
  //
  // THIS REVERSES `ad83204d`'s OWN ORDERING ON PURPOSE — "assertKnownFlags refuses at the door —
  // after help, so a reader who typo'd still gets the list" — and the maintainer AFFIRMED the
  // reversal on 2026-09-24 rather than restoring the original order, having weighed both: the
  // usage text is not the list a typo needs (`assertKnownFlags`'s own "did you mean --token?" is),
  // and a flag silently accepted and read by nothing is the worse failure of the two.
  await assert.rejects(
    () => cli(["--help", "--tokne", "x"]),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /unknown flag: --tokne/.test(e.message),
  );
});

test("...while the ways to ASK for the usage still get it", async () => {
  for (const argv of [[], ["help"], ["--help"]]) {
    const r = await cli(argv);
    assert.equal(r.code, 0, argv.join(" "));
    assert.match(r.out, /^loom — graph-native multi-agent orchestration/, argv.join(" "));
  }
});
