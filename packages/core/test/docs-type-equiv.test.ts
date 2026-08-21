/**
 * A `ts` block in `design/loom/` must describe the interface the code actually has.
 *
 * `docs-drift.test.ts` already checks that the NAMES line up — that a method the design
 * describes exists, that a `loom.*` span the design cites is one `spans.ts` emits. It says
 * so itself, and it is the right check for the questions it asks. What it cannot see is the
 * inside of a declaration: a document can say `readonly atSeq: Seq` while the code says
 * `atSeq?: number`, and every name-level guard in the repo stays green.
 *
 * That is the drift class `REGISTER.md` records over and over, and it is the one this file
 * closes. For every `export interface` in a fenced `ts` block, the member set is compared
 * against the same-named declaration in `packages/core/src`:
 *
 *   - a member the design describes and the code does not have is drift — the document
 *     says something FALSE;
 *   - a member whose OPTIONALITY differs is drift, for the same reason: `foo?: T` and
 *     `foo: T` are different contracts, and `exactOptionalPropertyTypes` makes them
 *     different types.
 *
 * A member the code has and the design OMITS is not drift, and this asymmetry is
 * deliberate. A design document summarises; requiring it to enumerate every member makes it
 * brittle against every additive change and turns the guard into a chore that gets
 * disabled. The line is: a document may be incomplete, and may not be false.
 *
 * INHERITED MEMBERS COUNT. `ToolDefinition extends ToolManifestLite`, and a first version of
 * this guard reported nine of its members as missing from the code because it did not follow
 * `extends` — the guard's own bug, reported as the code's. A guard that cries wolf on
 * correct code is worse than no guard.
 *
 * DELIBERATELY NOT a full structural comparison. Comparing rendered type text would fail on
 * `readonly x: Seq` vs `readonly x: number` — a difference that is real but that a doc is
 * allowed to simplify — and a guard that fires on correct documents is a guard that gets
 * deleted. Member presence and optionality are the two properties a reader relies on and
 * that cannot be simplified away without saying something false.
 *
 * An interface the design names that does NOT exist in `src/` is skipped, not failed:
 * `design/loom/` deliberately describes things that are not built, and the marker registry
 * in `docs-drift.test.ts` is what governs those. This file is about declarations that exist
 * in both places and disagree.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { interfaceBody, members, membersDeep } from "./helpers/ts-members.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "..", "src");
const DESIGN = join(HERE, "..", "..", "..", "design", "loom");

/** Every `.ts` file under `src/`, concatenated — the corpus a declaration is looked up in. */
function sourceText(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(SRC);
  return out.join("\n");
}

/** Every fenced `ts` block in the design corpus, with where it came from. */
function docBlocks(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  for (const name of readdirSync(DESIGN).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(join(DESIGN, name), "utf8");
    for (const m of text.matchAll(/```ts\n([\s\S]*?)```/g)) out.push({ file: name, code: m[1]! });
  }
  return out;
}

test("EVERY INTERFACE THE DESIGN DESCRIBES HAS THE MEMBERS THE CODE HAS", () => {
  const src = sourceText();
  const problems: string[] = [];
  let compared = 0;

  for (const { file, code } of docBlocks()) {
    for (const m of code.matchAll(/export\s+interface\s+([A-Za-z_$][\w$]*)/g)) {
      const name = m[1]!;
      const codeBody = interfaceBody(src, name);
      // Described but not built. `design/loom/` says such things on purpose, and the
      // marker registry in docs-drift.test.ts is what governs them.
      if (codeBody === undefined) continue;
      const docBody = interfaceBody(code, name);
      if (docBody === undefined) continue;

      compared++;
      const inDoc = members(docBody, true);
      const inCode = membersDeep(src, name);

      for (const [k, optional] of inDoc) {
        if (!inCode.has(k)) {
          problems.push(`${file}: ${name}.${k} is described but the code has no such member`);
        } else if (inCode.get(k) !== optional) {
          problems.push(
            `${file}: ${name}.${k} is ${optional ? "optional" : "required"} in the design and ` +
              `${inCode.get(k) === true ? "optional" : "required"} in the code`,
          );
        }
      }
    }
  }

  assert.ok(compared > 0, "no interface was compared, so this guard proves nothing — check the block extraction");
  assert.deepEqual(
    problems,
    [],
    `the design and the code disagree about ${String(problems.length)} member(s). ` +
      `The code is the source of truth (CLAUDE.md), so fix the document — or fix the code and say so in the journal.`,
  );
});
