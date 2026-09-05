/**
 * `compile()` diagnoses a bad expression; it never throws one.
 *
 * At 294e713 `checkExpr` caught only around `parseExpr`, so an expression that PARSES but
 * whose AST is deeper than the remaining stack threw a bare `RangeError` out of `checkExpr`,
 * out of `validateGraph`, and out of `compile()` — a function that returns a result union and
 * whose docstring says an editor may call it on every keystroke. Reproduced there:
 *
 *     ITEM4 && chain x10000: THREW RangeError: Maximum call stack size exceeded
 *     ITEM4 ! chain x5000:   THREW RangeError: Maximum call stack size exceeded
 *     ITEM4 parens x5000:    ok=false diags=["GRAPH004_EXPR"]
 *
 * Three inputs of one class, two different answers, and which one you got depended on the
 * caller's remaining stack rather than on the input. `MAX_EXPR_DEPTH` makes it a property of
 * the input.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { checkExpr, parseExpr } from "../../src/graph/expr.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { stubResolver } from "./fixtures.ts";

const CHANNELS = { inp: "string", out: "object" } as const;

const withWhen = (when: string): GraphSpec =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "g", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: { inp: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["inp"],
    outputs: ["out"],
    nodes: ["a", "b"].map((id) => ({
      id: id as NodeId,
      type: "function",
      reads: ["inp"],
      writes: ["out"],
      function: { ref: "function/noop@stable" },
      unhandled: true,
    })),
    edges: [{ id: "ab" as EdgeId, from: "a" as NodeId, to: "b" as NodeId, kind: "seq", when }],
  }) as unknown as GraphSpec;

const compileWith = (when: string) =>
  compile({ spec: withWhen(when), resolver: stubResolver({}), tools: {}, tenantCapabilities: ["*"] });

/** The three shapes, each reaching a different part of the machinery. */
const chain = (n: number): string => Array.from({ length: n }, () => "has(inp)").join(" && ");
const bangs = (n: number): string => "!".repeat(n) + "has(inp)";
const parens = (n: number): string => "(".repeat(n) + "has(inp)" + ")".repeat(n);

test("A 10,000-TERM `&&` CHAIN IS A DIAGNOSTIC, not a RangeError out of compile()", () => {
  // The left-associative chain is the shape a source-length cap would not have caught: it is
  // parsed by a LOOP, so the parser never recurses, and the 10,000-deep AST only bites when
  // `inferType` walks it.
  const r = compileWith(chain(10_000));
  assert.equal(r.ok, false);
  const expr = r.diagnostics.filter((d) => d.code === "GRAPH004_EXPR");
  assert.equal(expr.length, 1, r.diagnostics.map((d) => d.code).join(", "));
  assert.match(expr[0]!.message, /nests deeper than 256/);
});

test("…and so are a 5,000-deep unary chain and 5,000 nested parentheses", () => {
  for (const [what, src] of [
    ["unary", bangs(5_000)],
    ["parens", parens(5_000)],
  ] as const) {
    const r = compileWith(src);
    assert.equal(r.ok, false, what);
    assert.ok(
      r.diagnostics.some((d) => d.code === "GRAPH004_EXPR" && /nests deeper than 256/.test(d.message)),
      `${what}: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`,
    );
  }
});

test("`parseExpr` itself refuses, so the ENGINE cannot be handed one either", () => {
  // `run/engine.ts` and `run/externalise.ts` call `parseExpr` directly at run time. A graph
  // carrying such an expression can no longer compile, but the refusal belongs where the
  // hazard is rather than only in the compiler that happens to be in front of it today.
  for (const src of [chain(10_000), bangs(5_000), parens(5_000)]) {
    assert.throws(() => parseExpr(src), /nests deeper than 256/);
  }
});

test("THE ORDINARY HALF: real expressions still compile, typecheck and report their refs", () => {
  // The deepest `when`/`until` written anywhere in this tree is 5.
  const real = "has(inp) && len(inp) > 0";
  const r = compileWith(real);
  assert.deepEqual(
    r.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
  assert.equal(r.ok, true);

  const ok = checkExpr(real, CHANNELS);
  assert.equal(ok.ok, true);

  // AND THE LIMIT IS NOT REACHED BY ANYTHING A PERSON WOULD WRITE. 128 terms is already
  // absurd for a hand-written edge condition and is still accepted; 256 is where it stops.
  assert.equal(checkExpr(chain(128), CHANNELS).ok, true);
  assert.equal(checkExpr(chain(255), CHANNELS).ok, true);
  const over = checkExpr(chain(257), CHANNELS);
  assert.equal(over.ok, false);
  assert.match(over.ok ? "" : over.errors[0]!, /nests deeper than 256/);

  // A TYPE ERROR IS STILL A TYPE ERROR, not swallowed by the widened try.
  const bad = checkExpr("len(inp)", CHANNELS);
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.errors[0]!, /must evaluate to a boolean/);
});
