/**
 * `--egress`, `--allow-exec` and `--exec-env` decide what this process may reach outside itself,
 * and each read its value as `String(args.flags[name]).split(",")`.
 *
 * A flag given with no value parses to `true`, and `String(true)` is `"true"`. So a bare flag
 * became the one-element allowlist `["true"]` — while still REGISTERING the tool it enables:
 *
 *     loom compile --allow-exec    granted=[…,proc:exec]  tools=[…,proc.exec]
 *     loom compile --egress        granted=[…,net:fetch]  tools=[…,net.fetch]
 *
 * `capabilitiesOf`'s security argument is that "a tool is registered ONLY when the operator
 * passed the flag that registers it… so 'registered implies granted' says exactly 'the operator
 * asked for this'." A flag with no argument is not that. And `true` is a real executable, so the
 * allowlist was not empty — it was one program nobody named.
 *
 * This is the `String(true)` family that `--token`, `--port`, `--input`, `--as`, `--reason` and
 * every `pathFlag` already refuse. Three flags had escaped it, and they are the three that
 * define this process's reach.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";

const SRC = readFileSync(fileURLToPath(new URL("../../src/cli.ts", import.meta.url)), "utf8");

/** `main`, with both streams muted — the refusals below are thrown, never printed. */
async function quietly(argv: readonly string[]): Promise<number> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await main([...argv]);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-listflag-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What a workspace built from these flags actually holds. */
function opened(dir: string, argv: readonly string[]) {
  const ws = openWorkspace(parseArgs([...argv, "--workspace", dir]));
  try {
    return { granted: [...ws.granted].sort(), tools: Object.keys(ws.engine.tools.manifests()).sort() };
  } finally {
    ws.close();
  }
}

/**
 * DERIVED FROM THE SOURCE, not restated here.
 *
 * This used to be a hand-written `["egress", "allow-exec", "exec-env"]`, and `listFlag` grew two
 * more callers — `--extension-module` and `--take` — without it moving. CLAUDE.md's lesson about
 * pointers to enumerations is exactly that: an enumeration is only as good as its own discipline
 * about growing, so this one reads the callers rather than remembering them, and the assertion
 * below pins the set so a sixth caller is a decision somebody has to make rather than a silent
 * addition.
 */
function listFlagCallers(): readonly string[] {
  return [...new Set([...SRC.matchAll(/listFlag\(args, "([a-z-]+)"/g)].map((x) => x[1]!))].sort();
}

/** The three whose empty value would register a tool. The other two enable no tool at all. */
const TOOL_ENABLING_FLAGS = ["allow-exec", "egress", "exec-env"] as const;
const LIST_FLAGS = TOOL_ENABLING_FLAGS;

test("EVERY FLAG `listFlag` SERVES IS NAMED HERE, and each gets the consequence that is ITS OWN", () => {
  // The set. A sixth caller goes red here, which is the point — its empty-value sentence has to
  // be chosen, not inherited.
  assert.deepEqual(listFlagCallers(), ["allow-exec", "egress", "exec-env", "extension-module", "take"]);

  // AND THE SENTENCE IS NOT SHARED. `listFlag`'s refusal used to end with a fixed clause —
  // "while still registering the tool the flag enables. Omit the flag entirely to leave that
  // tool unregistered" — printed for all five. Driven before the fix:
  //
  //     $ loom gates ... --extension-module
  //     E_CONFIG_INVALID: --extension-module needs a module path: ... It would otherwise read as
  //     the single entry "true", while still registering the tool the flag enables.
  //
  // `--extension-module` enables no tool, and neither does `--take`. Read off the call sites,
  // because `--take`'s refusal sits behind a runId and a --node this suite has no run for.
  for (const flag of TOOL_ENABLING_FLAGS) {
    assert.match(
      SRC,
      new RegExp(`listFlag\\(args, "${flag}", "[^"]+", TOOL_ENABLING\\)`),
      `--${flag} keeps the tool-enabling sentence`,
    );
  }
  assert.match(SRC, /listFlag\(args, "extension-module", "a module path", NO_MODULE_CALLED_TRUE\)/);
  assert.match(SRC, /listFlag\(args, "take", "one or more edge ids", NO_EDGE_CALLED_TRUE\)/);
});

test("...AND THE ONE THAT IS DRIVEN SAYS IT — --extension-module names importing, not registering", async () => {
  const w = workspace();
  try {
    await assert.rejects(
      () => quietly(["compile", "nope.json", "--workspace", w.dir, "--extension-module"]),
      (e: unknown) =>
        isLoomError(e) &&
        e.code === CODES.E_CONFIG_INVALID &&
        /import a module called "true"/.test(e.message) &&
        !/registering the tool the flag enables/.test(e.message),
      "the refusal must name what this flag would actually do",
    );
  } finally {
    w.dispose();
  }
});

test("A LIST FLAG WITH NO VALUE IS REFUSED — it would read as the single entry \"true\"", () => {
  const w = workspace();
  try {
    for (const flag of LIST_FLAGS) {
      assert.throws(
        () => opened(w.dir, ["compile", `--${flag}`]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /no value at all/.test(e.message),
        `--${flag} with no value must be refused`,
      );
      assert.throws(
        () => opened(w.dir, ["compile", `--${flag}=`]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /empty/.test(e.message),
        `--${flag}= must be refused too — that is what an unset "$VAR" expands to`,
      );
    }
  } finally {
    w.dispose();
  }
});

test("THE CAPABILITY IS NOT GRANTED BY A MALFORMED FLAG", () => {
  // The half that makes this a security fix rather than an ergonomic one. Before, the tool was
  // registered — and `capabilitiesOf` derives the tenant grant FROM the registry, so a bare
  // `--allow-exec` put `proc:exec` in the grant list a graph is compiled against.
  const w = workspace();
  try {
    const bare = opened(w.dir, ["compile"]);
    assert.equal(bare.granted.includes("proc:exec"), false);
    assert.equal(bare.granted.includes("net:fetch"), false);

    const real = opened(w.dir, ["compile", "--allow-exec", "ls", "--egress", "api.example.com"]);
    assert.ok(real.granted.includes("proc:exec"), "a flag WITH a value still works");
    assert.ok(real.granted.includes("net:fetch"));
    assert.ok(real.tools.includes("proc.exec"));

    // And the malformed one grants nothing, because it never gets as far as registering.
    //
    // NAMING THE ERROR, not merely asserting one. A bare `assert.throws` passed under the
    // mutation that deletes the refusal — `v` is then `true`, `true.split` is not a function,
    // and a TypeError satisfies `throws` just as well as the refusal does. "It threw" is not
    // "it refused".
    assert.throws(
      () => opened(w.dir, ["compile", "--allow-exec"]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
    );
  } finally {
    w.dispose();
  }
});

test("a stray comma is refused rather than silently dropped", () => {
  // `--egress a,,b` reads as three entries, one of them blank. Dropping it quietly would make
  // the allowlist differ from what the operator wrote with nothing to show for it.
  const w = workspace();
  try {
    assert.throws(
      () => opened(w.dir, ["compile", "--egress", "api.example.com,,other.example.com"]),
      (e: unknown) => isLoomError(e) && /stray comma/.test(e.message),
    );
    assert.throws(() => opened(w.dir, ["compile", "--allow-exec", "ls,"]), (e: unknown) => isLoomError(e));
  } finally {
    w.dispose();
  }
});

test("entries are TRIMMED, and a whitespace-only entry is therefore a stray comma", () => {
  // The observable consequence of trimming, which is what makes it testable at all. Asserting
  // that `--egress "a, b"` still registers `net.fetch` proved nothing — it registers either way,
  // and the mutation removing `.trim()` left that green.
  //
  // With trimming, `"a, ,b"` has a blank middle entry and is refused. Without it, the middle
  // entry is a single space and becomes a host in the allowlist that nobody typed.
  const w = workspace();
  try {
    assert.throws(
      () => opened(w.dir, ["compile", "--egress", "api.example.com, ,other.example.com"]),
      (e: unknown) => isLoomError(e) && /stray comma/.test(e.message),
      "a whitespace-only entry must be caught, which requires trimming before the blank check",
    );
    // And an ordinary space after a comma is still just formatting.
    const r = opened(w.dir, ["compile", "--egress", "api.example.com, other.example.com"]);
    assert.ok(r.tools.includes("net.fetch"));
  } finally {
    w.dispose();
  }
});
