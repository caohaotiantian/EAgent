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
 *   code — until the next branch, which is what it is for. Measured by deleting the five lines of
 *   the type test from a backup copy of `expr.ts` and re-running the `[null]` probe:
 *
 *     {"ok":false,"errors":["lexer made no progress at offset 0 in ``"]}
 *
 *   in place of the heap death. Its presence is pinned below by reading the source, which is a weak
 *   pin and an honest one: it catches a silent deletion and it does not claim to exercise it.
 *
 * AND THE STRING PATH IS UNCHANGED, which is the thing a new guard at the top of a lexer is most
 * likely to break. Asserted here on the syntax and depth messages, and separately by compiling all
 * seven `examples/graphs/*.json` before and after — byte-identical diagnostics, all seven.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

test("the progress assertion is still in `lex` — pinned by source, exercised by mutation", () => {
  // Unreachable while the type test above stands (see this file's header for the mutation that
  // drives it). This catches its deletion, and claims nothing more than that.
  const src = readFileSync(new URL("../../src/graph/expr.ts", import.meta.url), "utf8");
  assert.match(src, /lexer made no progress/, "the progress assertion was removed from `lex`");
  assert.match(src, /if \(i === lastStart\) throw/, "the progress assertion no longer guards the loop");
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
