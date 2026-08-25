/**
 * The budget warning fired on the bounded graph and stayed silent on the unbounded one.
 *
 * `rule009And018Budgets` gated its warning on `graphBudget !== undefined`, so:
 *
 *   - a graph declaring `policy.budget.costUsd` with an undeclared spender → WARNED, and the
 *     message said "the run budget cannot be proven". False. `Engine.submit` computes
 *     `minDefined(caller, graph, deployment)`, so a declared graph budget is a hard, enforced
 *     run ceiling. What could not be proven was `GRAPH009_BUDGET_OVERCOMMIT`'s arithmetic — an
 *     undeclared spender contributes 0 to `declaredTotal`, so that sum underestimates.
 *   - a graph declaring NO budget at all → SILENT. `PolicyEngine.reserve` skips its check
 *     entirely when `runUsd` is undefined, `remainingUsd` returns `Infinity`, and `loom run`
 *     supplies no default. Nothing anywhere bounds the spend, and the compiler said nothing.
 *
 * THE THIRD TEST IS THE POINT. Because the old rule keyed on the budget's PRESENCE, the cheapest
 * way to silence it was to delete `policy.budget` — which moves the graph from the bounded shape
 * to the unbounded one. A guard whose easiest remedy is strictly worse than the finding is a
 * guard that makes graphs less safe than having no guard at all.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { resolver } from "../run/skeleton.ts";

const spend = (id: string, nodeUsd?: number) => ({
  id,
  type: "agent",
  reads: ["a"],
  writes: [id],
  agent: { profile: "agent_profile/x@v1", prompt: "prompt/p@stable", maxTurns: 4 },
  ...(nodeUsd === undefined ? {} : { policy: { budget: { costUsd: nodeUsd } } }),
});

const plain = (id: string) => ({ id, type: "function", reads: ["a"], writes: [id], function: { ref: "function/f@stable" } });

function codes(nodes: readonly unknown[], graphUsd?: number): readonly string[] {
  const chans: Record<string, unknown> = { a: { type: "string", reduce: "replace" } };
  for (const n of nodes as { id: string }[]) chans[n.id] = { type: "object", reduce: "replace" };
  const r = compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "bb", project: "test", version: 1 },
      policy: { posture: "out", ...(graphUsd === undefined ? {} : { budget: { costUsd: graphUsd } }), capabilities: [] },
      channels: chans,
      inputs: ["a"],
      outputs: [(nodes as { id: string }[])[0]!.id],
      nodes,
      edges: [],
    } as never,
    resolver: resolver(),
    tools: {} as never,
    tenantCapabilities: [],
  });
  return r.diagnostics.map((x) => x.code);
}

test("A GRAPH THAT BOUNDS NOTHING IS REPORTED — the case that was silent", () => {
  const c = codes([spend("a1")]);
  assert.ok(c.includes("GRAPH009_NO_BUDGET"), `expected the unbounded graph to be reported; got: ${c.join(", ") || "(none)"}`);
});

test("A DECLARED GRAPH BUDGET IS NOT CALLED UNPROVEN — it is enforced at submit", () => {
  const r = compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "bb", project: "test", version: 1 },
      policy: { posture: "out", budget: { costUsd: 3 }, capabilities: [] },
      channels: { a: { type: "string", reduce: "replace" }, a1: { type: "object", reduce: "replace" } },
      inputs: ["a"],
      outputs: ["a1"],
      nodes: [spend("a1")],
      edges: [],
    } as never,
    resolver: resolver(),
    tools: {} as never,
    tenantCapabilities: [],
  });
  const c = r.diagnostics.map((x) => x.code);
  assert.ok(!c.includes("GRAPH009_NO_BUDGET"), "a graph that declares a ceiling is not the unbounded shape");
  assert.ok(c.includes("GRAPH009_UNBOUNDED_NODE"), c.join(", "));

  // The message must not repeat the false claim. It names what is actually unproven.
  const m = r.diagnostics.find((x) => x.code === "GRAPH009_UNBOUNDED_NODE")!.message;
  assert.match(m, /still caps the run/, `the message still claims the run is unbounded: ${m}`);
  assert.match(m, /GRAPH009_BUDGET_OVERCOMMIT/, "say which check is the one that cannot see these nodes");
});

test("DELETING THE GRAPH BUDGET CANNOT SILENCE THE WARNING — the incentive is gone", () => {
  // The property, stated directly. Under the old rule `withBudget` warned and `without` did not,
  // so an author following the path of least resistance made their graph strictly less bounded.
  const withBudget = codes([spend("a1")], 3).filter((x) => x.startsWith("GRAPH009"));
  const without = codes([spend("a1")]).filter((x) => x.startsWith("GRAPH009"));

  assert.equal(withBudget.length, 1, withBudget.join(", "));
  assert.equal(without.length, 1, without.join(", "));
  assert.notDeepEqual(without, [], "removing the ceiling must never be the quiet option");
});

test("A GRAPH WHOSE SPENDERS ALL DECLARE A BUDGET IS QUIET — the guard is not universal", () => {
  // The control that keeps the first test honest: per-node budgets are enforced at run time
  // (`budget-declared.test.ts`), so a graph that declares them everywhere really is bounded.
  const c = codes([spend("a1", 0.5)]).filter((x) => x.startsWith("GRAPH009"));
  assert.deepEqual(c, [], `a fully-declared graph must not be reported: ${c.join(", ")}`);
});

test("A GRAPH WITH NO SPENDING NODES IS QUIET, budget or no budget", () => {
  // `function` and `tool` nodes make no model call, so there is nothing to bound.
  assert.deepEqual(codes([plain("f1")]).filter((x) => x.startsWith("GRAPH009")), []);
  assert.deepEqual(codes([plain("f1")], 3).filter((x) => x.startsWith("GRAPH009")), []);
});
