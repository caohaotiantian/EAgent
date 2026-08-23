/**
 * A list of error codes that nothing validates is a list where a typo is a SILENCE.
 *
 * `EdgeSpec.codes` and `RetryPolicy.onlyIf` are both read at run time — `#errorEdges` filters by
 * the first, `#retryDecision` by the second — and neither was checked at compile. So:
 *
 *     error edge, no codes         the edge fires, the handler runs
 *     codes: ["E_TYPOO"]           compiles clean, the edge NEVER fires
 *
 * Measured on a graph whose irreversible tool body throws. And the second row still satisfied
 * `GRAPH011_UNHANDLED_IRREVERSIBLE`, which asks only whether an `error` edge EXISTS — so the
 * warning that exists to catch an unhandled irreversible node was suppressed by an edge that
 * could not handle anything. On `onlyIf` the same typo means "retry nothing", which reads as a
 * retry policy and disables retry.
 *
 * These are checkable rather than heuristic because the codes are a closed set (`CODES`), which
 * is what makes this an error and not a warning.
 *
 * **The author cannot guess these**, which is why the fix line suggests: a tool body that throws
 * surfaces as `E_TOOL_SOURCE_UNAVAILABLE`, not the `E_TOOL_FAILED` that a reasonable person
 * writes. That exact wrong guess is what turned this up.
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

function spec(over: { codes?: readonly string[]; onlyIf?: readonly string[] }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "codes", project: "p", version: 1 },
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

function diags(over: Parameters<typeof spec>[0]) {
  const r = compile({ spec: spec(over), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  return r.diagnostics.filter((d) => d.code === "GRAPH003_UNKNOWN_ERROR_CODE");
}

test("AN ERROR CODE NO ERROR CARRIES IS REFUSED, on an edge and on a retry policy", () => {
  // THE DEFECT: both of these compiled clean and then silently did nothing.
  assert.equal(diags({ codes: ["E_TYPOO_NOT_A_CODE"] }).length, 1);
  assert.equal(diags({ onlyIf: ["E_TYPOO_NOT_A_CODE"] }).length, 1);
  assert.equal(diags({ codes: ["E_TYPOO"], onlyIf: ["E_ALSO_WRONG"] }).length, 2, "both fields, both reported");
});

test("...and a REAL code is accepted, whether or not this failure would carry it", () => {
  // The rule is about existence, not about reachability: which codes a node can actually raise
  // is not knowable at compile, and pretending otherwise would refuse correct graphs.
  assert.deepEqual(diags({ codes: [CODES.E_BUDGET_EXHAUSTED] }), []);
  assert.deepEqual(diags({ onlyIf: [CODES.E_TOOL_SOURCE_UNAVAILABLE] }), []);
  assert.deepEqual(diags({}), [], "and declaring neither is a catch-all, which is legal");
});

test("the fix line SUGGESTS, because the right code is not guessable", () => {
  const [d] = diags({ codes: ["E_BUDGET_GONE"] });
  assert.ok(d !== undefined);
  assert.match(d.fix ?? "", /E_BUDGET_EXHAUSTED/, "a near miss must name the code that was meant");
  assert.match(d.message, /would never match/);

  // The case that produced this rule: a tool body that throws surfaces as
  // `E_TOOL_SOURCE_UNAVAILABLE`, and `E_TOOL_FAILED` is the natural wrong guess.
  const [tool] = diags({ onlyIf: ["E_TOOL_FAILED"] });
  assert.match(tool?.fix ?? "", /E_TOOL_SOURCE_UNAVAILABLE/);
});

test("caller data that is not an array does not become one diagnostic per character", () => {
  // `codes: "E_X"` is a string, and iterating it would report seven unknown codes named
  // `E`, `_`, `X`… — the same shape `collectRefs` and the hooks scan already guard against.
  const bad = { ...spec({}), edges: [{ ...spec({}).edges[0]!, codes: "E_BUDGET_EXHAUSTED" as never }] };
  const r = compile({ spec: bad, resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  assert.deepEqual(r.diagnostics.filter((d) => d.code === "GRAPH003_UNKNOWN_ERROR_CODE"), []);
});
