/**
 * A GRAPH MAY NOT VOTE ITSELF A LARGER CEILING THAN THE OPERATOR SET.
 *
 * `SubgraphNode.budgetShare` is a plain graph field. `#runSubgraph` multiplied the parent's
 * REMAINING budget by it and handed the product to `#contextFor` as the child's `runUsd` — and
 * `#contextFor` returns an existing context untouched, so `submit`'s own min-fold (which exists,
 * in its words, "so `min` cannot silently raise the deployment's ceiling") arrived too late to
 * matter. Measured on a $10 deployment with `budgetShare: 1000`: `subgraph.started.budgetUsd =
 * 10000`, and the child ran with a $10,000 ceiling on a $10 box.
 *
 * `graph/validate.ts` references `budgetShare` nowhere, so 1000, -3, 1e308 and "abc" all compile.
 * The rule "a share above 1 is not a share" belongs in that file and is OWED there; this closes
 * the executor, which is the layer that decides.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = (): number => 1_700_000_000_000;
const TOOLS: Record<string, ToolManifestLite> = {};

const CHILD: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "child", project: "lane-a", version: 1 },
  policy: { posture: "out" },
  channels: { doubled: { type: "number", reduce: "replace" } },
  inputs: [],
  outputs: ["doubled"],
  nodes: [{ id: n("double"), type: "function", writes: ["doubled"], function: { ref: "function/two@stable" } }],
  edges: [],
} as unknown as GraphSpec;

function parentSpec(share: unknown): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "lane-a", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { result: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["result"],
    nodes: [
      {
        id: n("delegate"),
        type: "subgraph",
        writes: ["result"],
        subgraph: { ref: "graph/child@stable", inputs: {}, outputs: { result: "doubled" }, budgetShare: share },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
  subgraph: (ref) => (ref === "graph/child@stable" ? CHILD : undefined),
};

/** The child ceiling the parent journaled, and what the child's own journal records. */
async function sliceFor(share: unknown, deploymentUsd: number): Promise<{ started: unknown; recorded: unknown; status: string }> {
  const store = new MemoryStateStore({ now: NOW });
  const functions = new FunctionRegistry();
  functions.register("function/two@stable", () => ({ writes: { doubled: 2 } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    resolver: RESOLVER,
    policy: { granted: ["*"], systemFloor: "out", budget: { runUsd: deploymentUsd } },
  });
  const graph = compileOrThrow({ spec: parentSpec(share), resolver: RESOLVER, tools: TOOLS, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });
  const p = await engine.advance(runId);

  const events: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) events.push(ev);
  const started = events.find((ev) => ev.type === "subgraph.started");
  const childRunId = (started?.payload as { childRunId?: RunId } | undefined)?.childRunId;
  let recorded: unknown;
  if (childRunId !== undefined) {
    for await (const ev of store.read(childRunId, 1)) {
      if (ev.type === "run.submitted") recorded = (ev.payload as { limits?: { runUsd?: number } }).limits?.runUsd;
    }
  }
  return { started: (started?.payload as { budgetUsd?: unknown } | undefined)?.budgetUsd, recorded, status: p.status };
}

test("A SHARE ABOVE 1 CANNOT RAISE THE DEPLOYMENT'S CEILING", async () => {
  const big = await sliceFor(1000, 10);
  assert.equal(big.started, 10, `a $10 deployment carved ${String(big.started)} for its child`);
  assert.equal(big.recorded, 10, "and the child's own journal must not record a wider one either");
  assert.equal(big.status, "succeeded", "the run still works; the ceiling is what changed");
});

test("…and the ORDINARY share is untouched", async () => {
  // The half a min-fold could break: a legitimate fraction must still be the fraction.
  assert.equal((await sliceFor(0.5, 10)).started, 5);
  assert.equal((await sliceFor(undefined, 10)).started, 10, "no declaration means the whole of what the parent has left");
  assert.equal((await sliceFor(1, 10)).started, 10);
});

test("A SHARE THAT IS NOT A SHARE FAILS CLOSED, not open", async () => {
  // `-3` journaled `budgetUsd: -30` and `"abc"` produced `runUsd: NaN` — and `committed +
  // estimate > NaN` is false for every input, so a dollar ceiling that is switched off rather
  // than exceeded. Both now carve nothing, which is the refusing direction.
  assert.equal((await sliceFor(-3, 10)).started, 0);
  assert.equal((await sliceFor("abc", 10)).started, 0);
  // `Infinity` never reaches here: `graphHash = digest(spec)` refuses a non-finite number, so
  // that one spelling is caught by the canonicalizer at compile. It is named because it is the
  // reason "the canonicalizer happens to catch it" was never a guard — it catches one of the
  // four spellings the compiler accepts.
});
