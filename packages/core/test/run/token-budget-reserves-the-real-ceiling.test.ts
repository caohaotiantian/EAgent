/**
 * `budget.tokens` MUST RESERVE THE CEILING THE ADAPTER IS ABOUT TO SEND, not one the engine
 * guessed.
 *
 * D.7.3. There were TWO constants named `DEFAULT_MAX_OUTPUT_TOKENS` with different values:
 * `providers/http.ts` is 4,096 and is the number that goes in the request body; `run/engine.ts`
 * was 1,024 and was what the token reservation charged against. The engine never sets
 * `ModelRequest.maxTokens` — the request literal in `#runAgent` carries model, system, messages
 * and tools and nothing else — so `estimateTurnTokens` always took the `?? 1024` arm while the
 * adapter always sent `defaultMaxTokens ?? 4096`. The reservation under-described its own request
 * by 4× at the shipped default, and by 31× against the 32,000-token row that produced
 * `docs/evolution-loop-2026-08-27.md`.
 *
 * THIS IS THE BRIEF'S NAMED FAILURE MODE — a guard answering its undecidable case with the
 * passing value — and it had no defence, because the answer was four lines away: the DOLLAR
 * reservation on the line above asks `adapter.estimateOf(shaped)` and gets the right ceiling,
 * because the adapter knows its own row. The TOKEN reservation re-derived the same worst case in
 * the engine, where that row is unreachable, and guessed low. `estimateTurnTokens`' own docstring
 * names the direction it must not fail in: "OVER-ESTIMATING IS THE SAFE DIRECTION … one that is
 * too small lets them through."
 *
 * MEASURED ON THE TREE BEFORE THE FIX, exactly this rig:
 *
 *   budget.tokens=1200  adapter ceiling=4096  ->  status=succeeded  model.called rows=1
 *
 * A call the budget could not afford was made, billed and folded. After the fix the same rig
 * refuses before the provider is reached, with `model.called` rows 0.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(tokens: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "ceiling", project: "budget", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [
      {
        id: "ask",
        type: "agent",
        reads: ["q"],
        writes: ["a"],
        policy: { budget: { tokens } },
        agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/**
 * An adapter that would send 4,096 — the number `providers/http.ts` ships and both HTTP adapters
 * put in the body — while declaring a small, cheap per-token price so the DOLLAR ceiling is not
 * what refuses. The token budget must be the only thing that can bind here, or the test proves
 * nothing about the token budget.
 */
function rig(
  tokens: number,
  untyped?: { readonly ceiling: (() => unknown) | undefined },
): { engine: Engine; store: MemoryStateStore; graph: ReturnType<typeof compileOrThrow> } {
  const models = new ModelRegistry();
  const adapter = new MockModelAdapter({
    defaultMaxTokens: 4096,
    pricePerMTok: 0.000001,
    script: () => ({ text: "ok", finishReason: "stop" }),
  });
  // THE UNTYPED ADAPTER, stood up as an own property that shadows the prototype method —
  // `delete` on the instance removes nothing, and the first draft of the refusal tests below
  // measured the real 4,096 while claiming to measure an absent method. `estimateOf` is
  // overridden alongside it because the MOCK's `estimateOf` happens to delegate here, which an
  // out-of-tree adapter that never implemented the method would not: leaving it would have the
  // test refusing on a `TypeError` from the dollar estimate rather than on the guard.
  if (untyped !== undefined) {
    const a = adapter as unknown as { outputCeilingOf?: unknown; estimateOf: () => number };
    a.outputCeilingOf = untyped.ceiling;
    a.estimateOf = () => 0;
  }
  models.register(adapter, true);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  return { engine, store, graph: compileOrThrow({ spec: spec(tokens), resolver: resolver(), tools: {}, tenantCapabilities: [] }) };
}

async function modelCallsMade(store: MemoryStateStore, runId: RunId): Promise<number> {
  let n = 0;
  for await (const ev of store.read(runId, 1)) if (ev.type === "model.called") n++;
  return n;
}

test("A BUDGET SMALLER THAN THE ADAPTER'S CEILING REFUSES BEFORE THE CALL", async () => {
  // 1,200 is above the 1,024 the engine used to guess and below the 4,096 the adapter would
  // actually send, so it is exactly the band the old constant let through.
  const r = rig(1200);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);
  const calls = await modelCallsMade(r.store, runId);

  assert.equal(calls, 0, `the provider was reached on a budget that could not cover its ceiling (${String(calls)} model.called rows)`);
  assert.notEqual(p.status, "succeeded", `a 1,200-token budget must not fund a 4,096-token ceiling: ${JSON.stringify(p.usage)}`);
  assert.equal(p.error?.code, "E_BUDGET_EXHAUSTED", JSON.stringify(p.error ?? {}));
  assert.match(String(p.error?.message ?? ""), /node "ask"/, "the message must name the node");
});

test("THE CONTROL: a budget that covers the same ceiling still runs", async () => {
  // The refusal must be about the number, not about declaring one. 8,000 covers 4,096 plus the
  // transcript with room to spare.
  const r = rig(8000);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(await modelCallsMade(r.store, runId), 1);
});

// ── and the case the guard cannot decide ────────────────────────────────────

/**
 * `outputCeilingOf` is REQUIRED on `ModelAdapter`, so every adapter TypeScript ever saw answers
 * it. These are the ones it did not: an adapter handed in through `EngineOptions.models` by an
 * embedder, or loaded from outside the tree. The engine deleted its own constant, so there is
 * nothing to fall back to — and adding one back for exactly the least-trusted adapters in the
 * process would rebuild the defect this whole change removed, pointed at the code with the
 * weakest claim on being right.
 *
 * SO IT REFUSES, before the provider is reached. Five inputs, one arm: the method absent
 * entirely, and four answers that are not a bound.
 */
const NOT_A_BOUND: readonly (readonly [string, unknown])[] = [
  ["absent", undefined],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["zero", 0],
  ["negative", -4096],
];

for (const [label, answer] of NOT_A_BOUND) {
  test(`AN ADAPTER THAT CANNOT STATE ITS CEILING IS REFUSED, not defaulted — ${label}`, async () => {
    // A budget so large that only the missing ceiling can refuse.
    const r = rig(1_000_000, { ceiling: label === "absent" ? undefined : () => answer });
    const runId = await r.engine.submit({ graph: r.graph, inputs: { q: "hi" } });
    const p = await r.engine.advance(runId);

    assert.equal(
      await modelCallsMade(r.store, runId),
      0,
      `the provider was reached with a reservation nobody vouched for (${label})`,
    );
    assert.equal(p.error?.code, "E_PROVIDER_BAD_REQUEST", JSON.stringify(p.error ?? {}));
    assert.match(String(p.error?.message ?? ""), /did not state an output ceiling/, "the refusal must name what was missing");
    assert.match(String(p.error?.message ?? ""), /outputCeilingOf/, "and the method the adapter has to implement");
  });
}
