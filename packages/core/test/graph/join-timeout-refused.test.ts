/**
 * THERE IS NO BARRIER DEADLINE, and declaring one is refused rather than warned about.
 *
 * `JoinNode.timeoutMs` was declared in `graph/spec.ts` — a kernel file — accepted into
 * `ALLOWED_FIELDS.join`, shape-validated as a duration, and read by NO executor. The compiler
 * warned (`GRAPH008_JOIN_TIMEOUT_INERT`) and the barrier still waited forever. The field is gone,
 * so `unknownKeys` refuses it with `GRAPH020_UNKNOWN_FIELD` and the graph does not compile.
 *
 * ## Why deletion and not enforcement, which is the whole judgement
 *
 * A barrier deadline's undecidable case is "is this branch stranded, or legitimately slow?" and
 * no journaled fact answers it — a join sees only that a sibling has not committed. `#deadlineOf`
 * deliberately gives a gate with no `slaMs` NO deadline, so a branch parked on a human gate is
 * indistinguishable from a hung socket, and a firing barrier would fail runs that are correctly
 * waiting for a person. That is this project's dominant defect class in its destructive form: a
 * guard answering an undecidable case with a decisive value.
 *
 * Firing over whatever arrived is worse. `#foldJoin` has no body and no transform, so a partial
 * fold under `mode: "all"` commits a value no reader can tell from a complete one — the
 * "SUCCEEDED with an empty report" shape `GRAPH008_JOIN_WRITES_UNPRODUCED` exists to warn about.
 * An author who wants partial evidence already has `mode: "any"` and `mode: "quorum"`.
 *
 * And every branch already has an enforced, author-declarable bound at its own locus: a node
 * branch through `NodeSpec.timeoutMs` and `#withNodeDeadline`, a gate branch through `slaMs` +
 * `onTimeout` and `GateSweeper`. The field bought a second spelling and no bound.
 *
 * WHAT THIS DOES NOT CLOSE, pinned here so no one reads the deletion as a fix: a node that
 * declares no `timeoutMs` still hangs its task forever — `#withNodeDeadline` returns straight
 * through — so a join over such a branch waits forever exactly as before. A default node deadline
 * is that fix, and it belongs at the one enforcement point that already covers every node type.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";

const RESOLVER: ResourceResolver = { resolve: (ref) => ({ ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }) };

function spec(timeoutMs?: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "j", project: "p", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      d: { type: "array", reduce: "append_ordered" },
      o: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["o"],
    nodes: [
      { id: "start" as never, type: "function", reads: ["items"], function: { ref: "function/f@stable" } },
      { id: "work" as never, type: "function", reads: ["item"], writes: ["d"], function: { ref: "function/f@stable" } },
      {
        id: "collect" as never,
        type: "join",
        // `as never` because the field is no longer in the type — which is half the point, and
        // why the compiler check below is the half that matters: TypeScript's excess-property
        // check protects nobody authoring YAML or JSON.
        join: { branches: ["work" as never], mode: "all", onBranchError: "fail", ...(timeoutMs === undefined ? {} : { timeoutMs }) } as never,
      },
      { id: "done" as never, type: "function", reads: ["d"], writes: ["o"], function: { ref: "function/f@stable" } },
    ],
    edges: [
      { id: "e0" as never, from: "start" as never, to: "work" as never, kind: "fanout", over: "items", as: "item", maxWidth: 4 },
      { id: "e1" as never, from: "work" as never, to: "collect" as never, kind: "join", branches: ["work" as never] },
      { id: "e2" as never, from: "collect" as never, to: "done" as never, kind: "seq" },
    ],
  };
}

function run(timeoutMs?: number) {
  const r = compile({ spec: spec(timeoutMs), resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  return {
    ok: r.ok,
    warnings: r.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code),
    errors: r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code),
    diag: r.diagnostics.find((d) => d.code === "GRAPH020_UNKNOWN_FIELD"),
  };
}

test("A DECLARED JOIN TIMEOUT IS AN ERROR, not a warning and not silence", () => {
  const with_ = run(120_000);
  // It compiled — with a warning — and the barrier had no deadline. Now the graph is refused.
  assert.equal(with_.ok, false, "a barrier deadline must not compile");
  assert.ok(with_.errors.includes("GRAPH020_UNKNOWN_FIELD"), with_.errors.join(", ") || "(no errors)");
  assert.match(with_.diag?.message ?? "", /timeoutMs/, "the message must name the field the author wrote");
  assert.match(with_.diag?.message ?? "", /"collect"/, "and the node it is on");
  // The replacement message lists what a join MAY declare. It is worse advice than the warning it
  // replaces — that is the honest cost, and it is why the fix text is asserted rather than assumed.
  assert.match(with_.diag?.fix ?? "", /branches/);
  assert.match(with_.diag?.fix ?? "", /onBranchError/);
  assert.doesNotMatch(with_.diag?.fix ?? "", /timeoutMs/, "the removed field must not be offered back");
});

test("...and a join that declares no deadline still compiles clean", () => {
  // The control. If the deletion had taken a legitimate field with it, this is what would say so.
  const without = run();
  assert.equal(without.ok, true, without.errors.join(", "));
  assert.deepEqual(without.errors, []);
  assert.equal(without.warnings.includes("GRAPH008_JOIN_TIMEOUT_INERT"), false, "the old warning is gone with the field");
});

test("THE NODE-LEVEL DEADLINE IS UNTOUCHED — it is the one that was always enforced", () => {
  // `NodeSpec.timeoutMs` and `JoinNode.timeoutMs` were two fields one word apart, and only the
  // outer one ever bound anything. Deleting the inner one must not have caught the outer.
  const s = spec();
  const nodes = s.nodes.map((n) => (n.id === ("work" as never) ? { ...n, timeoutMs: 5_000 } : n));
  const r = compile({ spec: { ...s, nodes }, resolver: RESOLVER, tools: {}, tenantCapabilities: ["*"] });
  assert.equal(r.ok, true, r.diagnostics.map((d) => `${d.severity}:${d.code}`).join(", "));
});
