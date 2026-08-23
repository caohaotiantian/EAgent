/**
 * A THROW ASSERTION WITHOUT A PREDICATE ACCEPTS ANY ERROR — including one from the code being
 * broken rather than the code refusing.
 *
 * `assert.throws(fn)` and `assert.rejects(fn)` pass on a `TypeError`, a `ReferenceError`, or an
 * error from three layers below the thing under test. That is not a theoretical hole: it was
 * measured twice in one afternoon, both times by a mutation sweep on a fix in progress.
 *
 *   - `list-flag-values.test.ts` asserted that a bare `--allow-exec` throws. Deleting the guard
 *     makes the value `true`, and `true.split` is not a function — so the TypeError satisfied
 *     `assert.throws` exactly as well as the refusal did, and the test stayed green while the
 *     capability it was protecting was granted.
 *   - `known-flags.test.ts` asserted that `compile nope.json --tokne x` rejects. It does anyway,
 *     for the missing file. Deleting the flag check changed nothing the test could see.
 *
 * **"It threw" is not "it refused."** Eleven call sites in this suite made only the first claim;
 * this gate is what stops a twelfth.
 *
 * ## What counts as guarded
 *
 * Any second argument: a predicate, a RegExp, an error class, an object of expected properties.
 * The bar is deliberately low — the aim is to make the author say WHICH failure they mean, not
 * to prescribe how. `isLoomError(e)` alone is enough, and is the right minimum where the point
 * of a test is something other than the error itself.
 *
 * Scoped to `packages/core/test/`. `packages/eagent` has its own suite and its own conventions;
 * widening this gate to it is a separate decision with its own migration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./", import.meta.url));

/**
 * Scan from just after an open paren to its match, counting TOP-LEVEL commas.
 *
 * Written as a scanner rather than a regex because the first argument is routinely a multi-line
 * arrow function containing commas, parens and braces of its own — a line-based check reported
 * nine false positives before this existed, which would have made the gate noise.
 */
function topLevelCommas(src: string, i: number): number {
  let depth = 0;
  let commas = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i) + 2;
      continue;
    }
    // A regex literal — `/…/` in argument position. Without this, `assert.throws(fn, /x\)/)`
    // reads the escaped paren as structure and the scan desynchronises.
    if (c === "/") {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k]!)) k--;
      if (k >= 0 && "(,=:&|!?".includes(src[k]!)) {
        i++;
        while (i < src.length && src[i] !== "/" && src[i] !== "\n") {
          if (src[i] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return commas;
      depth--;
    } else if (c === "," && depth === 0) commas++;
    i++;
  }
  return commas;
}

/** One scan over a source text: how many throw assertions, and which of them are bare. */
function scan(src: string): { readonly total: number; readonly bare: readonly number[] } {
  const bare: number[] = [];
  let total = 0;
  const re = /assert\.(?:throws|rejects)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    // Not inside a line comment or a docstring line.
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (before.includes("//") || before.trimStart().startsWith("*")) continue;
    total++;
    if (topLevelCommas(src, m.index + m[0].length) === 0) bare.push(src.slice(0, m.index).split("\n").length);
  }
  return { total, bare };
}

/** The whole suite, through the SAME scanner the tests below exercise. */
function sweep(): { readonly total: number; readonly bare: readonly string[] } {
  let total = 0;
  const bare: string[] = [];
  for (const file of globSync(`${ROOT}**/*.test.ts`).sort()) {
    if (file.endsWith("predicate-on-throws.test.ts")) continue;
    const r = scan(readFileSync(file, "utf8"));
    total += r.total;
    for (const line of r.bare) bare.push(`${file.slice(ROOT.length)}:${line}`);
  }
  return { total, bare };
}

test("EVERY THROW ASSERTION SAYS WHICH FAILURE IT MEANS", () => {
  assert.deepEqual(
    sweep().bare,
    [],
    "these accept any error, including one from the code being broken rather than refusing — " +
      "add a second argument (a predicate, a RegExp, or an error class). `isLoomError(e)` is enough.",
  );
});

test("the scanner sees the assertions it is scanning for", () => {
  // A gate whose scan silently finds nothing reports success forever, and the FIRST version of
  // this floor counted with its own separate regex — so breaking the scanner's left it green.
  // Mutation-tested. The floor has to come out of the same scan the gate uses.
  const { total } = sweep();
  assert.ok(total > 200, `the scan found only ${total} throw assertions — the scanner broke, not the suite`);
});

test("the classifier tells the two shapes apart, INCLUDING a regex with an escaped paren", () => {
  assert.deepEqual(scan("assert.throws(() => f());").bare.length, 1, "a bare call must be flagged");
  assert.deepEqual(scan("assert.throws(() => f(), (e) => ok(e));").bare.length, 0, "a predicate is a second argument");
  assert.deepEqual(scan("assert.rejects(fn, /boom/);").bare.length, 0, "so is a RegExp");

  // THE DESYNC CASE, and it took two tries to state correctly. An unbalanced paren inside a
  // regex literal — `\\(` — is not structure. Read as structure it unbalances the scan, and the
  // consequence is a FALSE POSITIVE rather than a miss: each `assert.` match is scanned from its
  // own start, so a swallowed call is still found on its own pass. What breaks is a guarded call
  // whose FIRST argument contains such a regex — the comma before its predicate ends up counted
  // at depth 1, the call reads as bare, and the gate reports a test that is already correct.
  //
  // A gate that cries wolf is a gate somebody switches off, which is the failure this case
  // exists to prevent.
  const guardedWithRegexInThunk = String.raw`assert.throws(() => f(/a\(b/), (e) => ok(e));`;
  assert.deepEqual(scan(guardedWithRegexInThunk).bare, [], "a regex in the thunk must not make a guarded call read as bare");
});
