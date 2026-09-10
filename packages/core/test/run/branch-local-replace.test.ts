/**
 * A `replace` CHANNEL WRITTEN INSIDE A FAN-OUT BRANCH IS PER-BRANCH — the runtime property
 * GRAPH010's branch-local exemption is a compile-time bet on.
 *
 * `lane-a-branch-local-write.test.ts` already pins that a node sees what an earlier node in its
 * own branch wrote, and that a sibling's write waits for the join — but it does so over an
 * `append_ordered` channel, because until GRAPH010 was loosened a `replace` one could not
 * compile behind a fan-out. So the compiler now permits a shape whose correctness is a property
 * of `Engine.#withBranchWrites`, and nothing in the tree went red if that property moved. This
 * is the pin.
 *
 * TWO ASSERTIONS, AND THE SECOND IS THE REASON THE EXEMPTION IS NARROW. Each branch reads its
 * OWN value — which is what makes `replace` safe inside the branch. And the value the JOIN
 * leaves in shared state is the LAST branch in branch-coordinate order — deterministic, and
 * meaningless — which is why a reader after the join must still be refused.
 *
 * `#foldJoin` folds every channel a member wrote, not only the join's declared `writes`, so the
 * channel really does reach `p.channels`; that is the fact the second assertion states.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = (): number => 1_700_000_000_000;

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

/**
 * `start --fanout--> A --seq--> B`, both joining at `J`. `mid` is `replace`, and this graph
 * COMPILES — which it did not before the exemption. That is half the point of driving it here.
 */
const SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "branch-local-replace", project: "test", version: 1 },
  policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
  channels: {
    items: { type: "array", reduce: "replace" },
    item: { type: "string", reduce: "replace" },
    mid: { type: "string", reduce: "replace" },
    seen: { type: "array", reduce: "append_ordered" },
    report: { type: "object", reduce: "replace" },
  },
  inputs: ["items"],
  outputs: ["report"],
  nodes: [
    { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/pass@stable" } },
    { id: n("A"), type: "function", reads: ["item"], writes: ["mid"], function: { ref: "function/writeMid@stable" } },
    { id: n("B"), type: "function", reads: ["mid", "item"], writes: ["seen"], function: { ref: "function/readMid@stable" } },
    { id: n("J"), type: "join", reads: ["seen"], writes: ["seen"], join: { branches: [n("A"), n("B")], mode: "all", onBranchError: "fail" } },
    { id: n("done"), type: "function", reads: ["seen"], writes: ["report"], function: { ref: "function/report@stable" } },
  ],
  edges: [
    { id: e("f"), from: n("start"), to: n("A"), kind: "fanout", over: "items", as: "item", maxWidth: 4 },
    { id: e("ab"), from: n("A"), to: n("B"), kind: "seq" },
    { id: e("aj"), from: n("A"), to: n("J"), kind: "join", branches: [n("A"), n("B")] },
    { id: e("bj"), from: n("B"), to: n("J"), kind: "join", branches: [n("A"), n("B")] },
    { id: e("jd"), from: n("J"), to: n("done"), kind: "seq" },
  ],
} as unknown as GraphSpec;

function rig(): { engine: Engine; saw: { item: string; mid: unknown }[] } {
  const store = new MemoryStateStore({ now: NOW });
  const saw: { item: string; mid: unknown }[] = [];
  const functions = new FunctionRegistry();
  functions.register("function/pass@stable", () => ({ writes: {} }));
  functions.register("function/writeMid@stable", (view) => ({ writes: { mid: `mid-${String(view.get<string>("item"))}` } }));
  functions.register("function/readMid@stable", (view) => {
    saw.push({ item: String(view.get<string>("item")), mid: view.get<unknown>("mid") ?? null });
    return { writes: { seen: String(view.get<unknown>("mid") ?? "null") } };
  });
  functions.register("function/report@stable", (view) => ({ writes: { report: { seen: view.get<unknown>("seen") } } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    policy: { granted: ["*"], systemFloor: "out" },
  });
  return { engine, saw };
}

test("the graph COMPILES — a `replace` channel behind a fan-out, read only inside the branch", () => {
  const g = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  assert.equal(g.plans[n("A")]?.maxInstances, 4);
});

test("each branch reads ITS OWN `replace` write, and never a sibling's", async () => {
  const r = rig();
  const g = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const p = await r.engine.advance(await r.engine.submit({ graph: g, inputs: { items: ["0", "1", "2"] } }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const byItem = Object.fromEntries(r.saw.map((s) => [s.item, s.mid]));
  assert.deepEqual(byItem, { "0": "mid-0", "1": "mid-1", "2": "mid-2" }, `branches saw ${JSON.stringify(r.saw)}`);
});

test("…and the value the JOIN leaves at the root is the LAST branch — deterministic, and meaningless", async () => {
  // This is the whole reason a reader after the join is still refused. `#foldJoin` folds `mid`
  // even though `J` declares neither a read nor a write of it.
  const r = rig();
  const g = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const p = await r.engine.advance(await r.engine.submit({ graph: g, inputs: { items: ["0", "1", "2"] } }));
  assert.equal(p.channels["mid"], "mid-2");
  assert.deepEqual(p.channels["seen"], ["mid-0", "mid-1", "mid-2"], "and the declared fold is unaffected");
});

test("…and it is the same value on a second, independent run", async () => {
  const r = rig();
  const g = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const p = await r.engine.advance(await r.engine.submit({ graph: g, inputs: { items: ["0", "1", "2"] } }));
  assert.equal(p.channels["mid"], "mid-2");
});
