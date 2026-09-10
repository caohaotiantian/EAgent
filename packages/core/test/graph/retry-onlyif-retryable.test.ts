/**
 * `retry.onlyIf: ["E_FUNCTION_REFUSED"]` COMPILED CLEAN, AND THE COMPILER ECHOED IT BACK.
 *
 *     $ loom compile out/zz-onlyif.json
 *       retry collate (declared): maxAttempts=2 backoff=exponential initialMs=500 maxMs=30000
 *                                 onlyIf=E_FUNCTION_REFUSED
 *     exit 0
 *
 * `#retryDecision` returns at `if (!error.retryable) return undefined;` — 41 lines before it
 * reads `onlyIf` — and `retryable` is `RETRYABLE.has(error.class)` over `{exhausted,
 * unavailable, timeout}`. `E_FUNCTION_REFUSED` is raised `validation`, deliberately and by
 * design (its own docstring in `errors.ts`: *"`validation`, so it is not in `RETRYABLE` and
 * `#retryDecision` declines it however generous the node's `retry` policy is — which is the
 * entire distinction between the two verdicts"*). So the filter can never match, the effect is
 * "no retry", and the harm is not a wrong run but an author who writes it, watches it compile,
 * and concludes the runtime honours it. `checkCodes` validated membership in `CODES` and
 * nothing else. (TODO §A.49.)
 *
 * ## THE PREMISE THE ROW ASSUMED, AND WHY IT IS FALSE
 *
 * The row said to refuse "an `onlyIf` naming a code whose class is not retryable", which
 * assumes `class` is a function of `code`. IT IS NOT — `class` is chosen at the RAISE SITE. A
 * scan of every `err.<class>(CODES.X)` and `new LoomError("<class>", CODES.X)` under
 * `packages/core/src` finds ten codes raised under more than one class, and five whose section
 * comment in `errors.ts` disagrees with its raise sites about RETRYABILITY itself:
 *
 *     E_GATE_DELIVERY_FAILED   section policy    raised not_found + unavailable   CAN retry
 *     E_SUBGRAPH_FAILED        section internal  raised internal + unavailable    CAN retry
 *     E_EXPANSION_EXHAUSTED    section exhausted raised policy                    cannot
 *     E_QUORUM_UNREACHABLE     section exhausted raised validation                cannot
 *     E_GRAPH_MISMATCH         section timeout   raised conflict+policy+validation cannot
 *
 * A table built from the section comments would refuse the first two, which WORK — and would let
 * the last three through. So `RAISED_CLASS` in `graph/validate.ts` records the SET of classes each
 * code is actually raised with, and the refusal fires only where that set is non-empty and holds
 * no retryable member. An EMPTY set — six codes are emitted as a bare `{code, message}` and never
 * become a `LoomError` — ACCEPTS: refusing on a class nothing pins would be the same false refusal
 * the section-comment table is rejected for.
 *
 * Its drift guard is `tsc`, not a source scan: `RAISED_CLASS` is `Record<Code, readonly
 * ErrorClass[]>`, so a code added to `errors.ts` is a TYPE ERROR until somebody classifies it. The
 * three tests at the bottom of this file are what say so out loud.
 *
 * ## WHAT THIS DOES NOT COVER
 *
 * `EdgeSpec.codes` is deliberately untouched — a non-retryable code is exactly what an `error`
 * edge is for. An `--extension-module` raising a pinned code under a class the table does not
 * list would be over-refused here; the escape is to drop `onlyIf` entirely, which retries on
 * every retryable error and loses nothing this filter could have expressed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { CODES } from "../../src/errors.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";

const RESOLVER: ResourceResolver = {
  resolve: (ref) => ({ ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }),
};

function spec(over: { onlyIf?: readonly string[]; codes?: readonly string[] }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "onlyif", project: "p", version: 1 },
    policy: { posture: "out" },
    channels: { o: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["o"],
    nodes: [
      {
        id: "a" as never,
        type: "function",
        writes: ["o"],
        function: { ref: "function/f@stable" },
        ...(over.onlyIf === undefined ? {} : { retry: { maxAttempts: 2, onlyIf: [...over.onlyIf] } }),
      },
      { id: "b" as never, type: "function", writes: ["o"], function: { ref: "function/f@stable" } },
    ],
    edges: [
      {
        id: "e1" as never,
        from: "a" as never,
        to: "b" as never,
        kind: "error",
        ...(over.codes === undefined ? {} : { codes: [...over.codes] }),
      },
    ],
  };
}

function diags(over: Parameters<typeof spec>[0], code: string) {
  const r = compile({ spec: spec(over), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  return r.diagnostics.filter((d) => d.code === code);
}

const dead = (over: Parameters<typeof spec>[0]) => diags(over, "GRAPH003_UNRETRYABLE_ONLY_IF");

// ── the row ──────────────────────────────────────────────────────────────────

test("A `retry.onlyIf` THAT CAN NEVER FIRE IS REFUSED, and the message says why", () => {
  const [d] = dead({ onlyIf: [CODES.E_FUNCTION_REFUSED] });
  assert.ok(d !== undefined, "E_FUNCTION_REFUSED is class `validation`; the filter is dead");
  assert.equal(d.severity, "error");
  assert.match(d.message, /E_FUNCTION_REFUSED/);
  assert.match(d.message, /validation/, "the class is the reason and must be named");
  assert.match(d.message, /never/, "and the consequence stated, not left to be inferred");
  assert.match(d.fix ?? "", /exhausted|unavailable|timeout/, "the fix names the classes that CAN retry");
  assert.equal(d.at?.nodeId, "a");
});

test("...and a RETRYABLE code still compiles", () => {
  for (const c of [CODES.E_PROVIDER_RATE_LIMIT, CODES.E_BUDGET_EXHAUSTED, CODES.E_PROVIDER_OVERLOADED, CODES.E_TOOL_TIMEOUT, CODES.E_FUNCTION_UNAVAILABLE]) {
    assert.deepEqual(dead({ onlyIf: [c] }), [], c);
  }
  assert.deepEqual(dead({}), [], "declaring no onlyIf is a catch-all, which is legal");
  assert.deepEqual(dead({ onlyIf: [CODES.E_PROVIDER_RATE_LIMIT, CODES.E_TOOL_TIMEOUT] }), [], "and a list of them");
});

test("ONE DIAGNOSTIC PER DEAD MEMBER, and the live ones in the same list are not reported", () => {
  const d = dead({ onlyIf: [CODES.E_FUNCTION_REFUSED, CODES.E_PROVIDER_RATE_LIMIT, CODES.E_GRAPH_INVALID] });
  assert.equal(d.length, 2, d.map((x) => x.message).join(" | "));
  assert.equal(d.some((x) => x.message.includes("E_PROVIDER_RATE_LIMIT")), false);
});

test("THE `error` EDGE IS NOT TOUCHED — a non-retryable code is what an error edge is FOR", () => {
  // Explicit, because extending the rule to `EdgeSpec.codes` is the obvious next step and it
  // would refuse the single most ordinary error-edge there is.
  assert.deepEqual(dead({ codes: [CODES.E_FUNCTION_REFUSED] }), []);
  assert.deepEqual(dead({ codes: [CODES.E_CAP_DENIED, CODES.E_INTERNAL] }), []);
});

test("the sibling rule still fires: an unknown code is still GRAPH003_UNKNOWN_ERROR_CODE", () => {
  // And it is not ALSO reported as unretryable — a code nothing raises has no class to name.
  assert.equal(diags({ onlyIf: ["E_NOT_A_CODE"] }, "GRAPH003_UNKNOWN_ERROR_CODE").length, 1);
  assert.deepEqual(dead({ onlyIf: ["E_NOT_A_CODE"] }), []);
});

test("a non-array `onlyIf` does not become one diagnostic per character", () => {
  const bad = spec({});
  (bad.nodes as unknown as { retry?: unknown }[])[0]!.retry = { maxAttempts: 2, onlyIf: "E_FUNCTION_REFUSED" };
  const r = compile({ spec: bad, resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  assert.deepEqual(r.diagnostics.filter((d) => d.code === "GRAPH003_UNRETRYABLE_ONLY_IF"), []);
});

// ── the table's own honesty ──────────────────────────────────────────────────

test("THE UNDECIDABLE ANSWER ACCEPTS, and these are the codes it accepts", () => {
  // A code raised under two classes, one of which IS retryable, must not be refused: it can
  // fire. This is the case a table built from `errors.ts`'s section comments gets WRONG —
  // E_GATE_DELIVERY_FAILED sits under `// policy` and is raised `unavailable` twice in
  // run/delivery.ts, and E_SUBGRAPH_FAILED sits under `// internal` and is raised
  // `unavailable` twice in run/engine.ts.
  for (const c of [CODES.E_GATE_DELIVERY_FAILED, CODES.E_SUBGRAPH_FAILED]) {
    assert.deepEqual(dead({ onlyIf: [c] }), [], `${c} IS raised unavailable somewhere and can fire`);
  }
  // …and a code with no `LoomError` raise site at all: emitted as a bare `{code, message}`
  // record, so nothing pins a class to it.
  for (const c of [CODES.E_OUTPUT_MISSING, CODES.E_REQUEST_TIMEOUT, CODES.E_GATE_EXPIRED, CODES.E_ROUTE_NOT_FOUND]) {
    assert.deepEqual(dead({ onlyIf: [c] }), [], `${c} has no raise site to read a class off`);
  }
});

test("AND THE REFUSALS THE SECTION COMMENTS WOULD HAVE MISSED", () => {
  // The mirror of the test above. These three sit under a RETRYABLE section heading in
  // `errors.ts` and are raised non-retryably at every site, so a section-comment table would
  // have let each of them through into a filter that can never match.
  for (const c of [CODES.E_EXPANSION_EXHAUSTED, CODES.E_QUORUM_UNREACHABLE, CODES.E_GRAPH_MISMATCH]) {
    assert.equal(dead({ onlyIf: [c] }).length, 1, `${c} is under a retryable heading but never raised retryably`);
  }
});

test("EVERY declared code has an answer in the table — the claim, named", () => {
  // `RAISED_CLASS` is `Record<Code, ErrorClass | null>`, so this is `tsc`'s job and a runtime
  // assertion cannot fail while the build is green. It is here because the guarantee is what
  // makes the rule sound: an unclassified code would silently take the accepting branch, and
  // the next reader needs to know that cannot happen quietly.
  const codes = Object.keys(CODES);
  assert.ok(codes.length >= 60, `expected the closed set to be large; got ${codes.length}`);
  for (const c of codes) {
    // Every one either refuses or does not; neither may throw, and no code may be unknown to
    // the sibling rule while being known here.
    assert.deepEqual(diags({ onlyIf: [c] }, "GRAPH003_UNKNOWN_ERROR_CODE"), [], `${c} must be a known code`);
    assert.ok(dead({ onlyIf: [c] }).length <= 1, c);
  }
});
