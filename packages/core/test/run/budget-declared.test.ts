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

// ── and the node's own ceiling, which was the same defect one level down ─────

/**
 * `D2` says an `agent` node is "a bounded ReAct loop … Bounded by `maxTurns` AND node budget,
 * whichever binds first." The second half was enforced by nothing: the scope string handed to
 * `PolicyEngine.reserve` is a LABEL, and `reserve` consults `budget.runUsd` alone.
 *
 * Measured through `bin/loom` against a local provider with prices configured, so the numbers
 * are exact rather than mock: a node declaring `costUsd: 1.0` spent $16 and the run reported
 * `succeeded`, while the identical spend under a GRAPH budget of $1.00 failed before the call.
 *
 * It was worse than an unread field, because the compiler builds a story around it.
 * `GRAPH009_UNBOUNDED_NODE` tells the author to ADD this field to a spending node, and
 * `GRAPH009_BUDGET_OVERCOMMIT` errors when the declared numbers do not sum under the graph
 * budget. The system asked for it, checked its arithmetic, and then ignored it.
 */
function nodeSpec(nodeUsd: number, graphUsd?: number): GraphSpec {
  const s = spec(graphUsd) as unknown as { nodes: { policy?: unknown }[] };
  s.nodes[0]!.policy = { budget: { costUsd: nodeUsd } };
  return s as unknown as GraphSpec;
}

test("A NODE'S OWN BUDGET BINDS — the deployment allows plenty and the node does not", async () => {
  const r = rig(1000);
  const runId = await r.engine.submit({ graph: compile(nodeSpec(0.000001)), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.notEqual(p.status, "succeeded", `a node that declared $0.000001 must not spend $1: ${JSON.stringify(p.usage)}`);
  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message ?? ""), /node "ask"/, "the message must name the node, not the run");
  assert.ok((p.usage?.costUsd ?? 0) < 1, `nothing may have been spent; usage was ${JSON.stringify(p.usage)}`);
});

test("the same node runs when its own declaration covers the work", async () => {
  // The refusal must be about the number, not about declaring one at all.
  const r = rig(1000);
  const runId = await r.engine.submit({ graph: compile(nodeSpec(50)), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

test("A NODE CEILING WITH NO RUN BUDGET JOURNALS A FINITE LIMIT", async () => {
  // The latent half, and it only became reachable when the ceiling above started firing. The
  // `budget.exhausted` row computed `limitUsd` as `spentUsd + remainingUsd`, and `remainingUsd`
  // is `Infinity` when the deployment set no `runUsd` — which `canonicalize` refuses on the
  // durable write path. So the run failed `E_INTERNAL: non-finite number Infinity at limitUsd`
  // instead of reporting the budget failure it actually had. Unreachable while `reserve` was the
  // only thing that could throw here, because a reservation cannot exceed a limit that does not
  // exist; a node ceiling can, and this is the run that found it.
  const r = rig(); // no runUsd, no graph budget — the node's number is the only ceiling
  const runId = await r.engine.submit({ graph: compile(nodeSpec(0.000001)), inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", `expected the budget failure, got ${JSON.stringify(p.error ?? {})}`);

  const rows = [];
  for await (const ev of r.store.read(runId, 1)) if (ev.type === "budget.exhausted") rows.push(ev);
  assert.equal(rows.length, 1, "the budget failure must reach the journal");
  const limitUsd = (rows[0]!.payload as { readonly limitUsd: number }).limitUsd;
  assert.ok(Number.isFinite(limitUsd), `limitUsd must be finite, was ${String(limitUsd)}`);
  assert.equal(limitUsd, 0.000001, "and it must be the ceiling that was actually exceeded");
});
