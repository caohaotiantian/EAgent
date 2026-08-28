/**
 * THE SURFACE GUARD PINS NAMES AND NOTHING ELSE — and says so. This is the claim it leans on.
 *
 * `check-surface.mjs` is explicit about its boundary: the pin is `symbol.getName()`, so
 * `export declare const VERSION` and `export type VERSION` are indistinguishable, and a narrowed
 * signature, a dropped parameter or a demoted return type all pass. It calls that "a deliberate
 * boundary rather than a hole to close here", and names what closes it instead:
 *
 *   > the two `tsc` projects in `npm run typecheck` … catch shape changes by USING them — 35 of
 *   > the 38 exported classes are constructed in `test/`, the other three inside `src/` — so a
 *   > demotion fails the gate before this script runs.
 *
 * That is a good argument and it rests on a fact nothing checked. Measured today: **40** exported
 * classes, **37** constructed in `test/`, three inside `src/`. The property still holds; the
 * numbers had drifted by two, and a 41st class constructed NOWHERE would leave the compensating
 * argument silently covering less than it claims — at which point the surface guard's stated
 * boundary becomes a real hole rather than a considered one.
 *
 * So the property is a gate now and the numbers are gone. A guard whose honesty depends on a
 * sentence in another file's docstring is only as honest as that sentence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (pattern: string): string =>
  globSync(`${ROOT}${pattern}`)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

const PIN: readonly string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../scripts/surface.json", import.meta.url)), "utf8"),
) as string[];

const SRC = read("src/**/*.ts");
const TESTS = read("test/**/*.ts");

/** Pinned names that are classes — the ones `new` can be applied to. */
function exportedClasses(): readonly string[] {
  return PIN.filter((n) => new RegExp(`export (?:abstract )?class ${n}\\b`).test(SRC));
}

test("EVERY EXPORTED CLASS IS CONSTRUCTED SOMEWHERE, so typecheck really does cover its shape", () => {
  const classes = exportedClasses();
  // The scan must not silently find nothing: an empty list would make this pass forever.
  assert.ok(classes.length >= 30, `found ${classes.length} exported classes — the scan broke, not the surface`);

  const uncovered = classes.filter((c) => {
    const used = new RegExp(`new ${c}\\s*\\(`);
    return !used.test(TESTS) && !used.test(SRC);
  });
  assert.deepEqual(
    uncovered,
    [],
    "these exported classes are never constructed, so `tsc` never checks their shape — and the " +
      "surface guard pins only their NAME. A signature change to one of these passes both gates. " +
      "Construct it in a test, or stop exporting it.",
  );
});

test("the two constructed only inside `src/` are named, so the exception cannot grow quietly", () => {
  // `check-surface.mjs` says "the other three inside `src/`". Which ones matters: a class only
  // `src/` constructs is covered by typecheck, but no TEST exercises its shape, so a change is
  // caught only if some internal caller happens to break. That is weaker, and the list is short
  // enough to be worth stating.
  //
  // IT WENT THREE -> TWO, and the direction is the point: `ReplayEffects` left the list because
  // the change that made `hermetic` falsifiable had to construct one to test it. A name leaving
  // this set is a public shape gaining its first real check. The assertion is an equality rather
  // than a subset so that BOTH directions are a decision — a name arriving is a shape losing its
  // cover, and a name leaving should be noticed and celebrated rather than silently absorbed.
  const classes = exportedClasses();
  const srcOnly = classes.filter((c) => !new RegExp(`new ${c}\\s*\\(`).test(TESTS)).sort();
  assert.deepEqual(
    srcOnly,
    ["CanonicalizationError", "SubscriberOverflowError"],
    "the set of exported classes no test constructs has changed — each addition is one more " +
      "public shape checked only by an internal caller",
  );
});

test("the surface guard still SAYS what it pins, so this file is checking a live claim", () => {
  // If the guard ever starts pinning signatures, this whole file is redundant and should go.
  // Pinned so that change is a decision rather than a discovery.
  const guard = readFileSync(fileURLToPath(new URL("../../../scripts/check-surface.mjs", import.meta.url)), "utf8");
  assert.match(guard, /WHAT THIS PINS IS THE NAME SET, AND NOTHING ELSE/);
  assert.match(guard, /typecheck/, "and it must still name typecheck as what covers the rest");
});
