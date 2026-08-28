/**
 * THE LINK, CHECKED AGAINST THE EVENTS THE ENGINE ACTUALLY WRITES.
 *
 * `subgraph-trace.test.ts` folds hand-written journals, which is the only way to reach the
 * shapes a driven run cannot produce — a child still running, a child that failed, a
 * completion whose start was rewound away. It cannot check the one thing a hand-written
 * journal assumes: that `spansFrom`'s subgraph arm derives THE SAME span id
 * `effect.started` will, because both are `effectKey(taskId, "subgraph", n)` and the fold
 * counts `n` while `#runSubgraph` writes it. Get that wrong and the trace grows a second
 * span per subgraph, and every assertion over a hand-written fixture still passes.
 *
 * So this drives a real parent and a real child through `Engine`, reads BOTH journals out
 * of the store, and folds them. Offline and deterministic: an injected `now`, an in-memory
 * store, a `function` node for a body, and no assertion about elapsed time.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { childRunIdsOf, conformsToGraph, reconstructGraph, spansFrom, spliceSubgraph, type Span } from "../../src/telemetry/spans.ts";

const n = (id: string): NodeId => id as NodeId;

const LEAF_REF = "graph/leaf@stable";

/** One `function` node, so the child has a real interior and no gate to answer. */
function leafSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "leaf", project: "trace", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [{ id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

/** One `subgraph` node and nothing else — the parent is the delegation. */
function parentSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "top", project: "trace", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      {
        id: n("delegate"),
        type: "subgraph",
        reads: ["amount"],
        writes: ["doubled"],
        subgraph: { ref: LEAF_REF, inputs: { amount: "amount" }, outputs: { doubled: "doubled" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

const resolver: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
  subgraph: (ref) => (ref === LEAF_REF ? leafSpec() : undefined),
};

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

async function drive(): Promise<{ store: MemoryStateStore; runId: RunId; graphHash: string }> {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });

  const graph = compileOrThrow({ spec: parentSpec(), resolver, tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { amount: 21 } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(p.channels["doubled"], 42, "the child's output really did come back through the parent");
  return { store, runId, graphHash: graph.graphHash };
}

const subgraphSpans = (spans: readonly Span[]): Span[] => spans.filter((s) => s.attributes["effect.kind"] === "subgraph");

test("a driven subgraph produces ONE span, and it carries the child's run id and verdict", async () => {
  const { store, runId } = await drive();
  const parent = spansFrom(await journal(store, runId));

  const subs = subgraphSpans(parent);
  assert.equal(subs.length, 1, `one subgraph is one span; got ${subs.length} — the ordinal the fold counts and the one the engine writes have diverged`);
  const sub = subs[0]!;

  const [child] = childRunIdsOf(parent);
  assert.ok(child, "the fold produced no route into the child");
  assert.equal(child, `${runId}~delegate@root#0`, "the child's id is derived from the parent's, and the trace says which");

  assert.equal(sub.attributes["subgraph.status"], "succeeded", "the child's own verdict, which the parent's task status does not carry");
  assert.equal(sub.attributes["effect.outcome"], "completed");
  assert.equal(sub.attributes["subgraph.ref"], LEAF_REF);
  assert.equal(sub.attributes["subgraph.outputs"], 1);
  assert.equal(sub.status, "ok");

  // The child really is a separate journal under that id, and the link's span id is the
  // root of ITS fold — derived, never looked up.
  const childSpans = spansFrom(await journal(store, child as RunId));
  const childRoot = childSpans.find((s) => s.name === "loom.run");
  assert.ok(childRoot, "the child run has a root span of its own");
  assert.equal(sub.links[0]?.spanId, childRoot.spanId);
  assert.equal(sub.links[0]?.traceId, childRoot.traceId);
});

test("the two folds splice into one tree, and conformance still answers about one run", async () => {
  const { store, runId, graphHash } = await drive();
  const parent = spansFrom(await journal(store, runId));
  const child = spansFrom(await journal(store, childRunIdsOf(parent)[0]! as RunId));

  const one = spliceSubgraph(parent, child);
  const sub = subgraphSpans(one)[0]!;
  const childRoot = one.find((s) => s.name === "loom.run" && s.spanId !== sub.parentSpanId && s.attributes["run.id"] !== runId)!;
  assert.equal(childRoot.parentSpanId, sub.spanId, "the child's run hangs under the subgraph node that started it");
  assert.ok(
    one.some((s) => s.name === "loom.task" && s.attributes["node.id"] === "double"),
    "the child's INTERIOR is in the tree — the node the parent could never see",
  );
  assert.equal(new Set(one.map((s) => s.traceId)).size, 1, "one tree is one traceId");

  // The parent's own fold still certifies; the spliced one is refused rather than certified
  // against a spec that declares only the parent's nodes.
  assert.equal(conformsToGraph(reconstructGraph(parent), compiledParentSpec(), graphHash).ok, true);
  const spliced = conformsToGraph(reconstructGraph(one), compiledParentSpec(), graphHash);
  assert.equal(spliced.ok, false, "a trace covering two graphs may not certify against one of them");
  assert.equal(spliced.hashMatches, false);
});

function compiledParentSpec(): GraphSpec {
  return compileOrThrow({ spec: parentSpec(), resolver, tools: {}, tenantCapabilities: [] }).spec;
}
