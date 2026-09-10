/**
 * `--help` NAMES THE SET THE REGISTRAR ACTUALLY PASSES — asserted against the CALL, not
 * against a second copy of the list.
 *
 * The help text said `called with {models, tools, channels, identity}` and claimed "FOUR
 * things need no fork", while `loadExtensionModules` passed ten members and README documented
 * nine `--extension-module` rows against them — `store.register` among them, which README
 * calls the sharpest row on its list. A stranger reading the thing in front of them did not
 * learn that `store`, `resolver`, `functions`, `hooks`, `payloads` or `jail` exist at all.
 *
 * The measurement that made it a defect, at the source:
 *
 *     $ /usr/bin/grep -an 'models, tools, channels, identity' packages/core/src/cli.ts
 *     303:  called with {models, tools, channels, identity} — this process's     ← help
 *     2839: )({ models, tools, channels, identity, functions, hooks, … , jail }) ← the call
 *
 * A test that spelled the ten names again would have been a THIRD copy to drift. So the
 * fixture module reports `Object.keys` of the object its own factory was handed — the real
 * argument, at the real call site — and the assertions run against that. A member added to
 * that call and not to the help text fails here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadExtensionModules, main } from "../../src/cli.ts";

/** `loom --help`, captured. `main([])` is the no-argument door the usage text is printed by. */
async function help(): Promise<string> {
  const out: string[] = [];
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  try {
    await main([]);
  } finally {
    process.stdout.write = real;
  }
  return out.join("");
}

/**
 * `--extension-module`'s OWN paragraph, and not a byte past it.
 *
 * Slicing to the end of USAGE made this a leaky guard: `tools`, `channels` and `jail` all
 * appear again later in the help text ("discovered tools are inside the", "--channels-file",
 * "dissolves the fs jail"), so three of the ten members could be deleted from the paragraph
 * that is supposed to name them and the assertion still passed. Measured on the live text:
 * 6915 chars to the end of USAGE against 3537 for the paragraph.
 *
 * The paragraph ends at the next flag, which is the next line starting with two spaces and a
 * dash. `+5` skips this flag's own opening.
 */
function extensionModuleParagraph(text: string): string {
  const start = text.indexOf("  --extension-module P,P");
  assert.notEqual(start, -1, "the help text must carry an --extension-module section");
  const rest = text.slice(start);
  const end = rest.indexOf("\n  --", 5);
  assert.notEqual(end, -1, "the paragraph must be followed by another flag, or this bound is not one");
  return rest.slice(0, end);
}

/**
 * The keys the factory is really handed.
 *
 * The module writes them beside itself rather than returning them: `loadExtensionModules`
 * discards a factory's return value, and it also REFUSES a module that registers nothing — so
 * the fixture registers one tool, which is the cheapest registration that satisfies that check.
 */
async function registrarKeys(): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), "loom-registrar-"));
  try {
    const receipt = join(dir, "keys.json");
    const modPath = join(dir, "probe.mjs");
    writeFileSync(
      modPath,
      `import { writeFileSync } from "node:fs";\n` +
        `export default (reg) => {\n` +
        `  writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(Object.keys(reg)));\n` +
        `  reg.tools.register({ name: "probe.noop", version: "1.0", description: "d", capabilities: ["probe:noop"],\n` +
        `    irreversibility: "read_only", idempotent: true, parameters: { type: "object", properties: {} },\n` +
        `    execute: () => ({ ok: true }) });\n` +
        `};\n`,
    );
    await loadExtensionModules([modPath]);
    return JSON.parse(readFileSync(receipt, "utf8")) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every member the registrar passes is named in --help", async () => {
  const keys = await registrarKeys();
  // A GUARD ON THE GUARD. If the fixture ever stopped receiving an object, `keys` would be
  // empty and every assertion below would pass over nothing.
  assert.ok(keys.length >= 4, `the factory must be handed a registrar, got: ${JSON.stringify(keys)}`);

  const section = extensionModuleParagraph(await help());

  // STRUCTURE, NOT A WORD SEARCH. `\btools\b` and `\bjail\b` occur in the paragraph's own
  // PROSE ("so a module can build tools bounded the way the built-ins are", "the operator's own
  // jail"), so a `filter(k => !new RegExp(k).test(section))` passes with those members deleted
  // from the list that is supposed to name them — measured, by removing the `tools` row and
  // watching only the COUNT assertion go red. These two read the two places the help text
  // actually makes the claim: the destructured argument, and one row per slot.
  const destructured = /called with \{([\s\S]*?)\}/.exec(section);
  assert.ok(destructured !== null, `the paragraph must show the destructured registrar: ${section}`);
  assert.deepEqual(
    destructured[1]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    [...keys],
    "the argument --help shows must be the argument the registrar passes, in the same order",
  );

  // Indent 22 is the ROW indent; the paragraph's prose sits at 20, so this cannot pick up a
  // sentence. One space or more after the name — `functions` is exactly the pad width.
  const rows = [...section.matchAll(/^ {22}(\w+) +\S/gm)].map((m) => m[1]!);
  assert.deepEqual(
    rows,
    keys.filter((k) => k !== "jail"),
    "every member but `jail` must have its own row saying what it opens",
  );
});

test("the count in --help is the registrar's, minus the one member that registers nothing", async () => {
  const keys = await registrarKeys();
  const text = await help();

  // `jail` is handed IN — the operator's own fs confinement — and is not something a module
  // registers, so the "need no fork" count is one less than the member count. Naming it here
  // rather than hard-coding 9: if `jail` were ever dropped from the call, this recomputes.
  const registrations = keys.filter((k) => k !== "jail").length;
  const claimed = /So (\d+) things need no fork/.exec(text);
  assert.ok(claimed !== null, `the help text must state a derived count, got none in:\n${text.slice(0, 200)}`);
  assert.equal(Number(claimed[1]), registrations, "the number in --help must be the registrar's own");

  // AND THE NUMBER IS NOT THE OLD ONE. The defect was a word, so a regression that reverted to
  // prose would satisfy the regex above with whatever it typed; this pins the direction.
  assert.ok(!/FOUR things need no fork/.test(text), "the four-member claim is the defect");
});
