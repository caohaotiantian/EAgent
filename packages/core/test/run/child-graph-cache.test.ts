/**
 * The compiled-child cache is BOUNDED, and eviction cannot change an answer.
 *
 * `Engine.#childGraphs` held compiled `RunGraph`s for the life of the process with nothing to
 * evict them. `#retire` declines to touch it for a correct reason — the cache is keyed by
 * resource ref, not by run, so per-run eviction would key a shared cache by the wrong thing —
 * which nonetheless left it growing forever on the one path meant to stay up for months.
 *
 * And the key grew twice while the cache stayed unbounded. It was `ref`, then `ref@spec` when
 * the spec started coming from a per-run `RunGraph`, then `ref@spec@parentHash` when the compile
 * started depending on what the parent froze. Each widening bought a real freeze and each
 * multiplied the number of distinct entries one ref can produce.
 *
 * A count cap is safe HERE and would not be next door: everything this map holds is a pure
 * function of frozen inputs, so an eviction costs a recompile and cannot change an answer.
 * `HumanGateBroker.#ephemeral` drops only a closed gate's PAYLOAD instead, because evicting a live
 * gate's route changes what the system does. The one test below is about that distinction.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;

/** The grandchild — its ref is what a compile of the CHILD has to ask the resolver for. */
function grandSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "grand", project: "cache", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      { id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
    ],
    edges: [],
  };
}

function childSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child", project: "cache", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      {
        id: n("deeper"),
        type: "subgraph",
        reads: ["amount"],
        writes: ["doubled"],
        subgraph: { ref: "graph/grand@stable", inputs: { amount: "amount" }, outputs: { doubled: "doubled" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  };
}

/** `note`'s type varies per parent, which is the cheapest way to move `graphHash`. */
function parentSpec(salt: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `parent-${salt}`, project: "cache", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { total: { type: "number", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
    inputs: ["total"],
    outputs: ["result"],
    nodes: [
      {
        id: n("delegate"),
        type: "subgraph",
        reads: ["total"],
        writes: ["result"],
        subgraph: { ref: "graph/child@stable", inputs: { amount: "total" }, outputs: { result: "doubled" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  };
}

interface Counting {
  readonly resolver: ResourceResolver;
  /** How many times a compile has asked for the GRANDCHILD, which only a cache MISS does. */
  grandLookups: number;
}

function countingResolver(): Counting {
  const child = childSpec();
  const grand = grandSpec();
  const state: Counting = {
    grandLookups: 0,
    resolver: {
      resolve: (ref) =>
        /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
          ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }
          : undefined,
      subgraph: (ref) => {
        if (ref === "graph/child@stable") return child;
        if (ref === "graph/grand@stable") {
          state.grandLookups += 1;
          return grand;
        }
        return undefined;
      },
    },
  };
  return state;
}

function engineOver(resolver: ResourceResolver, store: MemoryStateStore): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1000 } },
  });
}

/**
 * One parent through one engine — the result, and how many grandchild lookups the ENGINE made.
 *
 * The delta is taken around `advance` alone. `compileOrThrow` for the parent resolves subgraphs
 * recursively too, so counting across the whole call charges the engine for lookups the test
 * itself caused — which made a cache HIT indistinguishable from a miss, and the first version of
 * this test failed on a cache that was working.
 */
async function run(
  engine: Engine,
  c: Counting,
  salt: number,
  total: number,
): Promise<{ result: unknown; lookups: number }> {
  const graph = compileOrThrow({ spec: parentSpec(salt), resolver: c.resolver, tools: {}, tenantCapabilities: [] });
  const before = c.grandLookups;
  const runId = await engine.submit({ graph, inputs: { total } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", `parent ${salt} must run: ${JSON.stringify(p.error ?? {})}`);
  return { result: (p.channels as Record<string, unknown>)["result"], lookups: c.grandLookups - before };
}

test("A FLOODED CACHE STILL ANSWERS — eviction cannot change what a child computes", async () => {
  const store = new MemoryStateStore({ now: () => NOW });
  const c = countingResolver();
  const engine = engineOver(c.resolver, store);

  const first = await run(engine, c, 0, 21);
  assert.equal(first.result, 42);

  // Enough distinct parents to push the first one out several times over. Each has its own
  // `graphHash`, which is the third component of the key — the component `874c6d6` added, and
  // the reason this cache grows faster than it used to.
  for (let i = 1; i <= 256; i++) {
    const noise = await run(engine, c, i, 1);
    assert.equal(noise.result, 2, `parent ${i}`);
  }

  const again = await run(engine, c, 0, 21);
  assert.equal(again.result, 42, "a recompiled child must produce exactly what the cached one did");

  // THIS TEST IS GREEN WITH THE CAP REMOVED, measured, and that is stated rather than hidden.
  //
  // The eviction is not observable, by design and for a reason worth writing down: since A24/A25
  // the engine compiles a child through `frozenFirst`, so a MISS reads the same frozen SPEC and
  // the same frozen SUBGRAPH TREE out of the parent's `RunGraph`. The first version of this test
  // counted grandchild lookups expecting to see a miss, and measured zero for that reason.
  //
  // So this pins the property the cap could break rather than the cap: that flooding does not
  // corrupt or lose an answer. `#ephemeral` next door gets a real test because there the same
  // policy WOULD change behaviour.
  assert.deepEqual(
    [first.lookups, again.lookups],
    [0, 0],
    "a child compile must not re-resolve the grandchild SPEC — the parent's tree already holds it",
  );
});
