/**
 * A LOOP EDGE IS BOUNDED WHOEVER NAMES IT.
 *
 * `#edgesToTake` began `if (outcome.take !== undefined) return outcome.take;` — before the
 * `case "loop"` arm that evaluates `until` and `maxIterations`. A `router` ALWAYS produces a
 * `take`, so a loop edge whose source is a router — the canonical `verify → replan` shape — had
 * no bound of any kind: not `until`, not `maxIterations`, and not `expansion.maxLoopIterations`,
 * which had no runtime reader anywhere in the tree.
 *
 * Measured before the fix: `maxIterations: 3` and a graph budget of $0.000001 reached iteration
 * 3,625 in 25 seconds — 3,626 model calls, 43,512 journal rows, a 17.7 MB journal — and was still
 * going when it was killed. Pointed at a paid provider that is unbounded spend with no ceiling
 * anywhere in the system.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/** `step` writes, then a router unconditionally sends flow back down a loop edge. */
function spec(over: { maxIterations?: number; maxLoopIterations?: number }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "spin", project: "bound", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 2, maxLoopIterations: over.maxLoopIterations ?? 8 },
    },
    channels: { n: { type: "number", reduce: "replace" } },
    inputs: ["n"],
    outputs: ["n"],
    nodes: [
      { id: "step", type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/bump@stable" } },
      { id: "again", type: "router", reads: ["n"], writes: [], router: { mode: "expression", cases: [{ when: "true", take: ["back"] }] } },
    ],
    edges: [
      { id: "fwd", from: "step", to: "again", kind: "seq" },
      // THE EDGE UNDER TEST: a loop edge whose SOURCE is a router.
      // `until` is REQUIRED by the compiler (GRAPH006_NO_STOP_RULE) and must reference a channel
      // a node in the cycle writes (GRAPH006). This one never becomes true, so `maxIterations` is
      // the only thing that can stop the loop — which is exactly the case the router bypassed.
      { id: "back", from: "again", to: "step", kind: "loop", until: "n > 1000000", ...(over.maxIterations === undefined ? {} : { maxIterations: over.maxIterations }) },
    ],
  } as unknown as GraphSpec;
}

function rig(): { engine: Engine; calls: () => number } {
  let calls = 0;
  const functions = new FunctionRegistry();
  functions.register("function/bump@stable", (view) => {
    calls += 1;
    return { writes: { n: (view.get<number>("n") ?? 0) + 1 } };
  });
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], budget: { runUsd: 100 } },
  });
  return { engine, calls: () => calls };
}

async function spin(over: { maxIterations?: number; maxLoopIterations?: number }): Promise<number> {
  const r = rig();
  const graph = compileOrThrow({ spec: spec(over), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: { n: 0 } });
  // A bounded loop TERMINATES. Before the fix this call did not return.
  await r.engine.advance(runId);
  return r.calls();
}

test("A ROUTER CANNOT RE-ENTER A LOOP ITS OWN EDGE HAS FINISHED", async () => {
  // `maxIterations: 3` means three passes through `step`, not unboundedly many.
  const calls = await spin({ maxIterations: 3 });
  assert.equal(calls, 3, `the edge's own bound must hold; step ran ${calls} times`);
});

test("THE COMPILER ALREADY REFUSED WHAT THE EXECUTOR THEN IGNORED", () => {
  // Worth pinning, because it is what makes the defect above severe rather than merely missing.
  // An unbounded loop was never expressible: `GRAPH006_UNBOUNDED_LOOP` demands `maxIterations`
  // and `GRAPH006_NO_STOP_RULE` demands `until`. So the compiler enforced a bound and the
  // executor threw it away for any edge a router named — "compiles, then fails at run time"
  // inverted into "compiles, then runs forever".
  //
  // It also means no graph-level backstop belongs in `#loopMayContinue`: a fallback to
  // `expansion.maxLoopIterations` would cover a shape that cannot compile. The first version of
  // this fix added one.
  for (const [omit, code] of [
    ["maxIterations", "GRAPH006_UNBOUNDED_LOOP"],
    ["until", "GRAPH006_NO_STOP_RULE"],
  ] as const) {
    const s = spec({ maxIterations: 3 }) as unknown as { edges: Record<string, unknown>[] };
    delete s.edges[1]![omit];
    assert.throws(
      () => compileOrThrow({ spec: s as unknown as GraphSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] }),
      new RegExp(code),
      `a loop edge with no ${omit} must not compile`,
    );
  }
});
