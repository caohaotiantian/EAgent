/**
 * `loom --version` ANSWERS WITH THE VERSION, and a flag with no verb is judged like any other.
 *
 * Before: `parseArgs` defaults a missing verb to `help`, and `main` answered `help` before it
 * looked at a single flag — so `loom --version` and `loom --bogus` both printed the usage and
 * exited 0. The first made "which build is installed" unanswerable; the second is the silence
 * `assertKnownFlags` exists to refuse, reachable only by leaving the verb off.
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
  for (const argv of [["--version"], ["run", "g.json", "--version"], ["--version", "--tokne", "x"]]) {
    const r = await cli(argv);
    assert.equal(r.code, 0, argv.join(" "));
    assert.equal(r.out, `loom ${PKG.version}\n`, argv.join(" "));
  }
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

test("...while the ways to ASK for the usage still get it", async () => {
  for (const argv of [[], ["help"], ["--help"], ["--help", "--tokne", "x"]]) {
    const r = await cli(argv);
    assert.equal(r.code, 0, argv.join(" "));
    assert.match(r.out, /^loom — graph-native multi-agent orchestration/, argv.join(" "));
  }
});
