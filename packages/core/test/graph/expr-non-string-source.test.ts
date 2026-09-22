/**
 * `lex` REFUSES A NON-STRING SOURCE, AND ITS LOOP ASSERTS ITS OWN PROGRESS — TODO §A.78.
 *
 * The defect was a denial of service on `loom compile` reachable from a graph FILE. `when: [null]`
 * on any edge: `src.length` is 1, `src[0]` is `null`, and `null >= "0" && null <= "9"` is TRUE by
 * numeric coercion, so the number branch is taken; the digit regex declines `null` so `j` stays at
 * `i`; `src.slice(i, j)` on an ARRAY is `[]`, `Number([])` is `0` and finite, so a token is pushed
 * and `i = j` makes no progress. Measured at `be29cb43` with `--max-old-space-size=300`, both
 * through `compile` and through `checkExpr` alone:
 *
 *     compiling with when: [null] …
 *     FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JS heap out of memory
 *
 * — no diagnostic, no exit code an operator can act on, nothing naming the edge.
 *
 * TWO GUARDS, AND THIS FILE PINS BOTH DIFFERENTLY BECAUSE ONLY ONE IS REACHABLE.
 *
 *   THE TYPE TEST is driven here as a CENSUS over shapes rather than on `[null]` alone, because
 *   `[null]` is the value that happened to be found and the hole is "not a string". Every shape
 *   must come back as a RETURNED diagnostic and not as a throw — `checkExpr`'s whole contract is to
 *   return them — and `parseExpr`, which the executor calls directly through `#expr` without ever
 *   passing through `checkExpr`, must throw a `E_EXPR_INVALID` rather than spin.
 *
 *   THE PROGRESS ASSERTION IS UNREACHABLE FROM OUTSIDE, and is pinned by MUTATION rather than by
 *   drive. Over a real string every branch of `lex` advances `i` (whitespace `i++`; the quote branch
 *   `i = j + 1`; the digit branch is entered only when `ch` IS a digit, which the character class
 *   matches; the ident branch likewise; `op.length >= 1`), so the type test above makes it dead
 *   code — until the next branch, which is what it is for. Two mutations drive it, each hermetic:
 *   a copy of `expr.ts` in a `mkdtemp` directory with its one import rewritten to an absolute URL,
 *   and the mutation asserted to have APPLIED so a rename cannot make the pin vacuous.
 *
 *     type test disabled, `[null]`      {"ok":false,"errors":["lexer made no progress at offset 0 …"]}
 *     `i = (i + op.length) % 2`, "a+b"  THREW E_EXPR_INVALID lexer made no progress at offset 0 …
 *
 *   WHAT THE GUARD COVERS IS "EVERY ITERATION STRICTLY ADVANCES `i`", and the second mutation is
 *   why that sentence is worth its space. This pin first asserted the SOURCE TEXT
 *   `if (i === lastStart) throw` — which both forbade the strengthening the guard needed and
 *   certified a weaker guard as correct. `===` asks only whether two CONSECUTIVE iterations start
 *   at the same offset, and a branch that moves `i` BACKWARDS never repeats consecutively: with
 *   that injection `i` oscillates 0,1,0,1 and `parseExpr("a+b")` died with `FATAL ERROR:
 *   Ineffective mark-compacts near heap limit` under `--max-old-space-size=200`, which is §A.78's
 *   own heap death restored. **Pin the property, never the operator.**
 *
 *   BOTH MUTATIONS RUN IN A CHILD PROCESS, and the round that put only ONE of them there is the
 *   argument for it. The other stayed in-process on a written claim that its shape "provably
 *   terminates under either form of the test" — a claim that enumerated the two operator spellings
 *   its author had in mind. `i < lastStart`, one character off the shipped guard, is a third: the
 *   in-process pin then took the runner's heap and the whole file reported as a single anonymous
 *   failure, `ℹ tests 1  ℹ pass 0  ℹ fail 1` at 12.4 s, with all seven tests invisible — while the
 *   sibling pin, the only other one that could have caught it, passed in 52 ms. Whether a mutated
 *   copy terminates is a property of the GUARD UNDER TEST, so a pin may not assume it. See
 *   `driveMutated`.
 *
 * AND THE STRING PATH IS UNCHANGED, which is the thing a new guard at the top of a lexer is most
 * likely to break. Asserted here on the syntax and depth messages, and separately by compiling all
 * seven `examples/graphs/*.json` before and after — byte-identical diagnostics, all seven.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { compile } from "../../src/graph/compile.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { checkExpr, parseExpr } from "../../src/graph/expr.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { TENANT_CAPABILITIES, TOOLS, clone, incidentTriage, stubResolver } from "./fixtures.ts";

/**
 * Every non-string shape a `JSON.parse`d graph file can put in `when`, plus the three a
 * hand-built `RunGraph` can (`bigint`, `symbol`, `function`) and the two that LOOK like strings
 * (`new String`, an array-like). `[null]` is the one that OOMed; the rest are here because "not a
 * string" is the hole and one value is not a census.
 */
const NON_STRINGS: readonly { readonly what: string; readonly v: unknown; readonly says: string }[] = [
  { what: "[null] — the OOM", v: [null], says: "an array" },
  { what: "an empty array", v: [], says: "an array" },
  { what: "an array of one digit", v: ["1"], says: "an array" },
  { what: "a nested array", v: [["has(x)"]], says: "an array" },
  { what: "null", v: null, says: "null" },
  { what: "a number", v: 1, says: "a number" },
  { what: "a boolean", v: true, says: "a boolean" },
  { what: "an object", v: { expr: "has(x)" }, says: "an object" },
  { what: "an array-like object", v: { length: 1, 0: null }, says: "an object" },
  { what: "a boxed String", v: new String("has(x)"), says: "an object" },
  { what: "a bigint", v: 1n, says: "a bigint" },
  { what: "a symbol", v: Symbol("has(x)"), says: "a symbol" },
  { what: "a function", v: () => true, says: "a function" },
  { what: "undefined", v: undefined, says: "undefined" },
];

test("checkExpr RETURNS a diagnostic for every non-string source, and never spins", () => {
  const started = Date.now();
  for (const { what, v, says } of NON_STRINGS) {
    let r: ReturnType<typeof checkExpr>;
    try {
      r = checkExpr(v as unknown as string, {});
    } catch (e) {
      assert.fail(`${what}: checkExpr THREW ${String(e)} — its contract is to return diagnostics`);
    }
    assert.equal(r.ok, false, `${what}: accepted`);
    assert.ok(!r.ok);
    assert.deepEqual(r.errors, [`expression must be a string, got ${says}`], what);
  }
  // An ABSOLUTE bound with an order-of-magnitude margin: the regression this file exists for takes
  // the heap, so a terminating-but-scanning one is the shape left to catch. Fourteen checks.
  assert.ok(Date.now() - started < 3000, "the census should be instant");
});

test("parseExpr — the executor's own entrance — throws E_EXPR_INVALID rather than spinning", () => {
  // `#expr` in `run/engine.ts` calls `parseExpr` directly on a `RunGraph`'s `when`/`until`, so a
  // guard living in `checkExpr` would close the compiler's door and leave this one open.
  for (const { what, v, says } of NON_STRINGS) {
    assert.throws(
      () => parseExpr(v as unknown as string),
      (e: unknown) => {
        assert.ok(isLoomError(e), `${what}: not a loom error`);
        assert.equal(e.code, CODES.E_EXPR_INVALID, what);
        assert.equal(e.message, `expression must be a string, got ${says}`, what);
        // The DESCRIPTION and not the value: `details` is journaled and rendered, and a raw
        // `symbol` or `bigint` in it is the crash the guard exists to avoid.
        assert.deepEqual(e.details, { source: says }, what);
        return true;
      },
      what,
    );
  }
});

test("compile refuses `when: [null]` with GRAPH004_EXPR, naming the edge, in bounded time", () => {
  const spec = clone(incidentTriage()) as unknown as { edges: Record<string, unknown>[] };
  const i = spec.edges.findIndex((e) => e["id"] === "e3");
  assert.ok(i >= 0, "fixture should carry edge e3");
  spec.edges[i] = { ...spec.edges[i]!, when: [null] };

  const started = Date.now();
  const r = compile({
    spec: spec as unknown as GraphSpec,
    resolver: stubResolver(),
    tools: TOOLS,
    tenantCapabilities: TENANT_CAPABILITIES,
  });
  assert.ok(Date.now() - started < 3000, "compile should answer immediately");

  assert.equal(r.ok, false);
  const expr = r.diagnostics.filter((d) => d.severity === "error" && d.code === "GRAPH004_EXPR");
  assert.equal(expr.length, 1, `expected one GRAPH004_EXPR, got ${r.diagnostics.map((d) => d.code).join(", ")}`);
  assert.match(expr[0]!.message, /expression must be a string, got an array/);
  // The edge is named, which is the half the heap death took away entirely.
  assert.match(JSON.stringify(expr[0]!), /e3/);
});

/**
 * A copy of `expr.ts` with `mutate` applied, importable — the machinery both progress-assertion
 * pins run on.
 *
 * HERMETIC: the copy lands in a fresh `mkdtemp` directory, its ONE import (`../errors.ts`) is
 * rewritten to an absolute `file://` URL of the real module, and the directory is removed after.
 * Nothing is written inside the repository and nothing is left behind.
 *
 * THE MUTATION IS ASSERTED TO HAVE APPLIED, which is the failure mode a source-rewriting test
 * actually has: rename the thing being matched and the mutation silently becomes a no-op, the
 * copy behaves like the original, and the test passes while testing nothing.
 */
function mutatedCopy(dir: string, tag: string, find: string, replace: string): string {
  const original = readFileSync(new URL("../../src/graph/expr.ts", import.meta.url), "utf8");
  const errors = new URL("../../src/errors.ts", import.meta.url).href;
  assert.ok(original.includes(find), `the mutation target ${JSON.stringify(find)} is gone from expr.ts — this pin is testing nothing`);
  const text = original.replace('from "../errors.ts"', `from ${JSON.stringify(errors)}`).replace(find, replace);
  const file = join(dir, `expr-${tag}.ts`);
  writeFileSync(file, text);
  return file;
}

/**
 * Drive a mutated copy IN A CHILD PROCESS and hand back whatever it printed.
 *
 * EVERY MUTATION PIN GOES THROUGH HERE, AND THE REASON IS THE ONE THING A MUTATION PIN MAY NOT
 * ASSUME. What it is testing is the guard that BOUNDS THE LOOP, so whether a mutated copy
 * terminates at all is a property of the code under test — exactly the thing in question. A pin
 * that runs such a copy in-process is betting on the answer it is there to check, and when it
 * loses the bet it does not fail: it takes the runner's heap with it.
 *
 * MEASURED, because this file shipped that bet once. The CONSUMES-NOTHING pin below ran in-process
 * on the argument that its shape "provably terminates under either form of the test" — an
 * enumeration of the two spellings its author had in mind. Weakening the shipped guard by ONE
 * CHARACTER, to `i < lastStart`, is a third spelling that terminates under neither, and the whole
 * FILE died as one unnamed failure with its seven tests reporting nothing:
 *
 *     ✖ packages/core/test/graph/expr-non-string-source.test.ts (12437.531084ms)
 *     ℹ tests 1   ℹ pass 0   ℹ fail 1        ← seven tests, one anonymous result
 *     FATAL ERROR: Ineffective mark-compacts near heap limit
 *
 * and the sibling pin, the only other one that could have caught `<`, PASSED in 52 ms. So the
 * single mutation that reached the defect reported it by crashing the runner. Under the child
 * process both pins name themselves and go red in milliseconds.
 *
 * THE COMMENT THAT ENUMERATES SPELLINGS IS THE BUG, not the operator it happened to omit: the next
 * weakening will be a spelling nobody listed either. A child process is correct for any of them.
 *
 * A non-zero exit is CAPTURED rather than thrown, so a heap death arrives at the assertion as text
 * and the test fails with the child's own output in the message.
 */
function driveMutated(tag: string, find: string, replace: string, drive: string): string {
  const dir = mkdtempSync(join(tmpdir(), `loom-expr-${tag}-`));
  try {
    const file = mutatedCopy(dir, tag, find, replace);
    const driver = join(dir, `driver-${tag}.mjs`);
    writeFileSync(driver, `const m = await import(${JSON.stringify(pathToFileURL(file).href)});\n${drive}\n`);
    try {
      return execFileSync(process.execPath, ["--max-old-space-size=200", driver], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const c = e as { stdout?: string; stderr?: string; message?: string };
      return `CHILD DID NOT COMPLETE: ${c.stdout ?? ""}${c.stderr ?? ""} ${c.message ?? ""}`;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the progress assertion refuses a branch that CONSUMES NOTHING — by mutation", () => {
  // Unreachable from outside while the type test stands, so it is driven by disabling that test in
  // a copy and handing the copy the value that OOMed: `i` never leaves 0, so no iteration after
  // the first one advances it.
  const out = driveMutated(
    "nogress",
    'if (typeof src !== "string") {',
    'if ((false as boolean) && typeof src !== "string") {',
    `try { console.log("RESULT " + JSON.stringify(m.checkExpr([null], {}))); } catch (e) { console.log("THREW " + e.message); }`,
  );
  assert.ok(
    out.includes(`RESULT {"ok":false,"errors":["lexer made no progress at offset 0 in \`\`"]}`),
    `a branch consuming nothing was not refused: ${out}`,
  );
});

test("the progress assertion refuses a branch that moves `i` BACKWARDS — by mutation", () => {
  // THE PROPERTY, NOT THE OPERATOR. The first cut of this pin asserted the source text
  // `if (i === lastStart) throw`, which forbade the very strengthening the guard needed: `===`
  // asks "did two CONSECUTIVE iterations start at the same offset?", and a branch that moves `i`
  // backwards never repeats consecutively. With `i = (i + op.length) % 2` injected into the
  // operator arm, `i` oscillates 0,1,0,1 and `parseExpr("a+b")` died with
  // `FATAL ERROR: Ineffective mark-compacts near heap limit` — §A.78's heap death restored.
  const out = driveMutated(
    "backwards",
    "    i += op.length;",
    "    i = (i + op.length) % 2;",
    `try { m.parseExpr("a+b"); console.log("RETURNED"); } catch (e) { console.log("THREW", e.code, e.message); }`,
  );
  assert.match(out, /THREW E_EXPR_INVALID lexer made no progress/, `the backwards branch was not refused: ${out}`);
});

test("the progress assertion is still in `lex` at all", () => {
  // The message, not the operator — B2's lesson. A pin on the exact comparison is a pin against
  // its own strengthening.
  const src = readFileSync(new URL("../../src/graph/expr.ts", import.meta.url), "utf8");
  assert.match(src, /lexer made no progress/, "the progress assertion was removed from `lex`");
});

test("a STRING source keeps the message it had — the new guard changes no existing text", () => {
  // Byte pins on the three shapes of refusal a string can reach, because a guard at the top of a
  // lexer is most likely to break the path it was not aimed at.
  const cases: readonly { readonly src: string; readonly says: string }[] = [
    { src: "1 +", says: "expected a value at offset 3 in `1 +`" },
    { src: "@", says: 'unexpected character "@" at offset 0 in `@`' },
    { src: "'abc", says: "unterminated string at offset 0 in `'abc`" },
  ];
  for (const { src, says } of cases) {
    const r = checkExpr(src, {});
    assert.equal(r.ok, false, src);
    assert.ok(!r.ok);
    assert.deepEqual(r.errors, [says], src);
  }
  // And an ordinary well-typed expression still compiles to an AST.
  const ok = checkExpr("has(verdict) && verdict.severity > 0", { verdict: "unknown" });
  assert.equal(ok.ok, true);
});
