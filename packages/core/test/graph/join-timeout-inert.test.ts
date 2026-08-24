/**
 * `JoinNode.timeoutMs` is declared, shape-validated, and read by nothing.
 *
 * A graph writes `join: { branches: [...], mode: "all", timeoutMs: 120_000 }` and gets a barrier
 * with no deadline. `grep -arn 'join?\.timeoutMs' packages/core/src/` returns nothing; the field
 * reaches only the duration check that every caller-supplied number gets.
 *
 * ## Why a warning and not an error, which is the whole judgement here
 *
 * Four other declared-but-unbuilt mechanisms ARE compile errors — `router.mode: "model"`,
 * `policy.onBudgetExhausted: "gate"`, `approval.mode: "quorum"`, `sla.onTimeout:
 * "default_action"`. Each of those SUBSTITUTES: it runs something semantically different from
 * what the graph says, so accepting one ships a graph that reads as supervised and behaves
 * otherwise. This one does nothing at all, and `02-EXECUTION-GRAPH.md` says so in three separate
 * places — the node table, the field table, and the `mode: all` row ("waits — indefinitely,
 * because `timeoutMs` is enforced by nothing"). The design is not drifting; it made a choice.
 *
 * Refusing it would therefore be taking the product decision HANDOFF §3 reserves — whether a
 * barrier timeout should FAIL the join or FOLD what arrived, the second being a semantics change
 * under `mode: all` rather than a timeout. A warning closes the gap that IS a defect (an author
 * who never read D5 has no way to learn it) without taking a decision that is not mine.
 *
 * This is `GRAPH019_POSTURE_NO_EFFECT`'s treatment, for the same reason: you declared something
 * that changes nothing.
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
        join: { branches: ["work" as never], mode: "all", onBranchError: "fail", ...(timeoutMs === undefined ? {} : { timeoutMs }) },
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
    diag: r.diagnostics.find((d) => d.code === "GRAPH008_JOIN_TIMEOUT_INERT"),
  };
}

test("A DECLARED JOIN TIMEOUT WARNS THAT IT DOES NOTHING", () => {
  const without = run();
  assert.equal(without.warnings.includes("GRAPH008_JOIN_TIMEOUT_INERT"), false, "no declaration, nothing to say");

  const with_ = run(120_000);
  // THE DEFECT: this compiled silently, and the barrier had no deadline.
  assert.ok(with_.warnings.includes("GRAPH008_JOIN_TIMEOUT_INERT"), with_.warnings.join(", "));
  assert.match(with_.diag?.message ?? "", /no executor reads/);
  assert.match(with_.diag?.fix ?? "", /node timeoutMs, which is enforced/, "the fix must name the bound that DOES work");
});

test("...and it is a WARNING — the graph still compiles", () => {
  // Load-bearing. Making it an error would take HANDOFF §3's open product decision, and it broke
  // 24 tests plus two of the corpus's own worked examples when tried — which is the measurement
  // that produced this judgement rather than an argument for it.
  const r = run(120_000);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});
