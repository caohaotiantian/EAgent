/**
 * `fs.edit` WROTE BYTES NOBODY ASKED FOR, in the one built-in whose whole design is about not
 * doing that.
 *
 * The non-`replaceAll` arm was `current.replace(span, replace)`, and `String.replace` interprets
 * `$&`, `` $` ``, `$'`, `$1` and `$<name>` in the replacement as SUBSTITUTION PATTERNS. The
 * replacement string is model-authored, and a `$` followed by one of those characters is
 * ordinary text: `$'…'` is ANSI-C shell quoting, `$&` is a regex replacement the agent is itself
 * writing, `$1` is a shell positional, `$<name>` is a named group. The `replaceAll` arm — which
 * is `split`/`join` — wrote all of them literally, so one tool had two contradictory semantics
 * selected by a boolean the model chooses.
 *
 * Nothing downstream caught it: the write is a `reversible_write`, so no gate; the tool returned
 * `edited a.ts (exact, 1 occurrence)` with `isError` unset; and the journal recorded a completed
 * effect. `fs.edit`'s docstring calls the three refusals the feature because "a fuzzy-match edit
 * tool that guesses is how a change lands in the wrong function"; this was a fourth, unrefused
 * way to write something nobody asked for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { builtinTools } from "../../src/builtin/tools.ts";
import type { ToolDefinition } from "../../src/run/registry.ts";

const ctx = () => ({ taskId: "t@root#0" as never, signal: new AbortController().signal, progress: () => {} });
const editOf = (root: string): ToolDefinition => builtinTools({ root, deny: [] }).find((t) => t.name === "fs.edit")!;

function seeded(body: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loom-edit-literal-"));
  const p = join(root, "a.txt");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Every one of these is a `String.replace` substitution pattern and ordinary text besides.
const PATTERNS: readonly [string, string][] = [
  ["$& USD", "the matched span, re-inserted"],
  ["$`x", "everything before the match, spliced in"],
  ["$'y", "everything after the match, spliced in"],
  ["$1", "a capture group that does not exist"],
  ["$<name>", "a named group that does not exist"],
  ["$$", "an escaped dollar, which collapses to one"],
];

test("the replacement text is written literally, byte for byte", async () => {
  for (const [replace, why] of PATTERNS) {
    const s = seeded("let cost = OLD;\n");
    try {
      const r = await editOf(s.root).execute({ path: "a.txt", find: "OLD", replace }, ctx());
      assert.notEqual(r.isError, true, `${replace}: ${why}`);
      assert.equal(
        readFileSync(join(s.root, "a.txt"), "utf8"),
        `let cost = ${replace};\n`,
        `replace=${JSON.stringify(replace)} — ${why}`,
      );
    } finally {
      s.cleanup();
    }
  }
});

test("...and the two arms of the same tool now agree", async () => {
  for (const [replace] of PATTERNS) {
    const one = seeded("a OLD b\n");
    const all = seeded("a OLD b\n");
    try {
      await editOf(one.root).execute({ path: "a.txt", find: "OLD", replace }, ctx());
      await editOf(all.root).execute({ path: "a.txt", find: "OLD", replace, replaceAll: true }, ctx());
      assert.equal(
        readFileSync(join(one.root, "a.txt"), "utf8"),
        readFileSync(join(all.root, "a.txt"), "utf8"),
        `replaceAll must not change what the bytes MEAN, only how many spans get them (${JSON.stringify(replace)})`,
      );
    } finally {
      one.cleanup();
      all.cleanup();
    }
  }
});

test("the ORDINARY edit is unchanged", async () => {
  const s = seeded("const x = 1;\nconst y = 2;\n");
  try {
    const r = await editOf(s.root).execute({ path: "a.txt", find: "const x = 1;", replace: "const x = 9;" }, ctx());
    assert.notEqual(r.isError, true);
    assert.equal(readFileSync(join(s.root, "a.txt"), "utf8"), "const x = 9;\nconst y = 2;\n");
    assert.equal((r.details as { occurrences: number }).occurrences, 1);
  } finally {
    s.cleanup();
  }
});

test("...including the whitespace-relaxed rung, whose span is NOT the text the model sent", async () => {
  // The replacement must land on the span `locateEdit` actually found, not on the model's
  // approximation of it — which is what makes an index-based splice the right shape.
  const s = seeded("function f() {\n\t\treturn 1;\n}\n");
  try {
    const r = await editOf(s.root).execute(
      { path: "a.txt", find: "function f() {\n  return 1;\n}", replace: "function f() {\n  return $2;\n}" },
      ctx(),
    );
    assert.notEqual(r.isError, true);
    assert.equal(readFileSync(join(s.root, "a.txt"), "utf8"), "function f() {\n  return $2;\n}\n");
  } finally {
    s.cleanup();
  }
});
