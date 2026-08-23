/**
 * A FLAG THIS BINARY DOES NOT UNDERSTAND IS REFUSED, not ignored — and for `--token`, ignored
 * meant an unauthenticated control plane.
 *
 * `parseArgs` accepts any `--word` and puts it in the map, and nothing checked the set. Measured:
 *
 *     loom serve --token s3cret    token set, plane authenticated
 *     loom serve --tokne s3cret    flags {"tokne": "s3cret"}, token ABSENT
 *     loom serve --Token s3cret    same
 *
 * and absent means "run an open plane on purpose". The operator's secret sits in `ps`, nothing
 * complains, and every caller is authorized.
 *
 * **That flag's own docstring already named this class.** `--name=value` support was added
 * because parsing only the space form "registers a flag literally NAMED `token=s3cret` and
 * leaves `flags["token"]` undefined… a security bug rather than an ergonomic gap". One spelling
 * of the class was fixed; a misspelling reached the identical place.
 *
 * ## Three lists, gated against each other
 *
 * `KNOWN_FLAGS` is what the refusal reads, `USAGE` is what an operator is told, and
 * `args.flags[…]` is what the code actually consults. Any two of those disagreeing is a defect:
 * a flag in USAGE and not in KNOWN_FLAGS is refused despite being advertised, and one read by
 * the code and not in USAGE is undiscoverable — which this repo has already shipped once, with
 * `--graph` appearing "in no usage text, no error message, and not in the hint `loom run` itself
 * prints". So the test below asserts all three are the same set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { controlPlaneOptions, main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

const SRC = readFileSync(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "utf8");

/** Read from the SOURCE, so none of the three can be restated here and drift. */
function declared(): readonly string[] {
  const m = /const KNOWN_FLAGS: readonly string\[\] = \[([\s\S]*?)\];/.exec(SRC);
  assert.ok(m, "KNOWN_FLAGS moved — this gate reads it from the source on purpose");
  return [...m[1]!.matchAll(/"([a-z][a-z-]*)"/g)].map((x) => x[1]!).sort();
}
function advertised(): readonly string[] {
  const m = /const USAGE = `([\s\S]*?)`;/.exec(SRC);
  assert.ok(m, "USAGE moved");
  return [...new Set([...m[1]!.matchAll(/--([a-z][a-z-]*)/g)].map((x) => x[1]!))].sort();
}
function read(): readonly string[] {
  const direct = [...SRC.matchAll(/args\.flags\["([a-z-]+)"\]/g)].map((x) => x[1]!);
  const viaHelper = [...SRC.matchAll(/(?:pathFlag|requireFileFlag|numberFlag|stringFlag)\(args, "([a-z-]+)"/g)].map((x) => x[1]!);
  return [...new Set([...direct, ...viaHelper])].sort();
}

test("KNOWN_FLAGS, USAGE AND THE CODE'S READERS ARE ONE SET", () => {
  const k = declared();
  assert.ok(k.length >= 15, `the source scan found ${k.length} flags — the regex broke, not the CLI`);
  assert.deepEqual(advertised(), k, "a flag is advertised that the refusal does not know, or vice versa");
  assert.deepEqual(read(), k, "a flag is read by the code that is not declared here, or vice versa");
});

// ── the refusal ─────────────────────────────────────────────────────────────

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-flags-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Every refusal below is driven through `compile`, never `serve`.
 *
 * The refusal runs before the verb dispatches, so any verb exercises it — and `serve` BINDS A
 * SOCKET. A mutation that removes the refusal therefore turns `assert.rejects(cli(["serve",…]))`
 * from a failing test into a listening server, and the mutation sweep hung instead of going red.
 * A test that hangs under the mutation it is meant to catch is worse than one that passes.
 */
async function cli(argv: string[]): Promise<number> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await main(argv);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("A MISSPELLED FLAG IS REFUSED, and the message names the one that was meant", async () => {
  const w = workspace();
  try {
    for (const [typo, meant] of [["tokne", "token"], ["worksapce", "workspace"], ["egres", "egress"]] as const) {
      await assert.rejects(
        () => cli(["compile", "nope.json", `--${typo}`, "x", "--workspace", w.dir]),
        (e: unknown) =>
          isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && e.message.includes(`--${typo}`) && e.message.includes(`--${meant}`),
        `--${typo} must be refused and point at --${meant}`,
      );
    }
  } finally {
    w.dispose();
  }
});

test("...including a flag that differs only in CASE, which reads as correct", async () => {
  const w = workspace();
  try {
    await assert.rejects(
      () => cli(["compile", "nope.json", "--Token", "s3cret", "--workspace", w.dir]),
      (e: unknown) => isLoomError(e) && /case-sensitive/.test(e.message),
      "--Token must say why it is not --token",
    );
  } finally {
    w.dispose();
  }
});

test("THE SECURITY CASE: a typo'd --token no longer opens the plane", async () => {
  // What the refusal is actually for. Before it, this pair produced two different planes from
  // two argv that read the same to an operator scanning `ps`.
  const w = workspace();
  try {
    const ws = openWorkspace(parseArgs(["serve", "--workspace", w.dir]));
    try {
      const good = controlPlaneOptions(ws, parseArgs(["serve", "--token", "s3cret", "--workspace", w.dir]));
      assert.equal(good.token, "s3cret", "the correct spelling still authenticates");

      // The typo still parses into a flag map — `parseArgs` is a parser and stays one — and it
      // still yields NO token. The refusal is what stops that map ever reaching here.
      const typo = controlPlaneOptions(ws, parseArgs(["serve", "--tokne", "s3cret", "--workspace", w.dir]));
      assert.equal(typo.token, undefined, "which is exactly why the door refuses it");
    } finally {
      ws.close();
    }
    // NAMING THE REFUSAL, not merely asserting one. Without this the mutation that deletes
    // `assertKnownFlags` left this test green: `compile nope.json` throws anyway, for a missing
    // file, and `assert.rejects` cannot tell two failures apart.
    await assert.rejects(
      () => cli(["compile", "nope.json", "--tokne", "s3cret", "--workspace", w.dir]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /unknown flag/.test(e.message),
      "the typo must be refused BEFORE the command gets far enough to fail for its own reasons",
    );
  } finally {
    w.dispose();
  }
});

test("`loom help` still works, and every real flag is accepted", async () => {
  // The refusal runs AFTER `help`, so a reader who typo'd can still get the list. And a
  // false positive here would be worse than the bug: every advertised flag must pass.
  assert.equal(await cli(["help"]), 0);
  assert.equal(await cli(["--help"]), 0);
  // AND `--help` WORKS ALONGSIDE THE TYPO, which is the point of ordering the refusal after it:
  // the reader who misspelled a flag is exactly the one who needs the list. Ordering this the
  // other way is a mutation the sweep reported as undistinguished until this line existed.
  assert.equal(await cli(["--help", "--tokne", "x"]), 0, "a typo must not cost a reader the usage text");

  const w = workspace();
  try {
    // `compile` with a bad path fails for a REASON THAT IS NOT the flag check — proving the
    // flags got through rather than that the command succeeded.
    // ADVERTISED, not `declared()`. Iterating the list under test is self-referential: dropping
    // a flag from KNOWN_FLAGS also drops it from the loop, so the mutation that does exactly
    // that left this green. USAGE is the operator-facing promise and is the right contract to
    // hold the refusal to.
    for (const flag of advertised()) {
      if (flag === "help") continue;
      await assert.rejects(
        () => cli(["compile", "nope.json", `--${flag}`, "x", "--workspace", w.dir]),
        (e: unknown) => isLoomError(e) && !/unknown flag/.test(e.message),
        `--${flag} is advertised and must not be refused as unknown`,
      );
    }
  } finally {
    w.dispose();
  }
});
