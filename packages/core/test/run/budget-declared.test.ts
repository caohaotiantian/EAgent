/**
 * A GRAPH'S DECLARED BUDGET IS A CEILING, NOT A COMMENT.
 *
 * `spec.policy.budget.costUsd` was read by `graph/validate.ts` alone — a compile-time FEASIBILITY
 * check that the declared per-node budgets fit inside it — and by nothing at run time. So a graph
 * could declare `budget.costUsd: 0.000001`, compile clean, and spend without limit. Measured
 * alongside the unbounded-loop defect: a run with exactly that declaration spent ~$0.11 of mock
 * cost and never stopped.
 *
 * The direction matters as much as the bound. A graph is a document a deployment RAN; letting its
 * declaration replace the deployment's own `policy.budget.runUsd` would let any graph vote itself
 * more money. The first version of this fix did exactly that, and five existing tests caught it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(costUsd?: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "spend", project: "budget", version: 1 },
    policy: {
      posture: "out",
      ...(costUsd === undefined ? {} : { budget: { costUsd } }),
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
    },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [{ id: "ask", type: "agent", reads: ["q"], writes: ["a"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

/** Every model call costs a fixed amount, so "did the budget bind" is a countable question. */
function rig(runUsd?: number): { engine: Engine; store: MemoryStateStore } {
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: () => ({ text: "ok", finishReason: "stop", usage: { inputTokens: 1000, outputTokens: 1000, costUsd: 1, wallMs: 1 } }),
    }),
    true,
  );
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", ...(runUsd === undefined ? {} : { budget: { runUsd } }) },
  });
  return { engine, store };
}

const compile = (s: GraphSpec) => compileOrThrow({ spec: s, resolver: resolver(), tools: {}, tenantCapabilities: [] });

test("A DECLARED BUDGET TOO SMALL FOR THE FIRST CALL STOPS THE RUN", async () => {
  // The deployment allows plenty; the graph declares almost nothing. Before this, the graph's
  // number reached nothing at run time and the call went through.
  const r = rig(1000);
  const runId = await r.engine.submit({ graph: compile(spec(0.000001)), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.notEqual(p.status, "succeeded", `a graph that declared $0.000001 must not spend $1: ${JSON.stringify(p.usage)}`);
  assert.ok((p.usage?.costUsd ?? 0) < 1, `nothing may have been spent; usage was ${JSON.stringify(p.usage)}`);
});

test("THE SAME GRAPH RUNS WHEN ITS OWN DECLARATION COVERS THE WORK", async () => {
  // The refusal must be about the number, not about declaring one at all.
  const r = rig(1000);
  const runId = await r.engine.submit({ graph: compile(spec(50)), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

test("A GRAPH CANNOT VOTE ITSELF MORE MONEY THAN THE DEPLOYMENT ALLOWS", async () => {
  // THE DIRECTION, which the first version of this fix got backwards: `#contextFor` overwrites
  // `runUsd` with whatever it is handed, so passing the graph's declaration straight through let
  // a document raise a ceiling an operator had set.
  const r = rig(0.000001);
  const runId = await r.engine.submit({ graph: compile(spec(1000)), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.notEqual(p.status, "succeeded", "the deployment's cap must still bind");
  assert.ok((p.usage?.costUsd ?? 0) < 1, "and nothing may have been spent");
});
