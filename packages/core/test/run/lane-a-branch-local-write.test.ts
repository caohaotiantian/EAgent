/**
 * A NODE INSIDE A FAN-OUT BRANCH SEES WHAT AN EARLIER NODE IN ITS OWN BRANCH WROTE.
 *
 * `writesHeldForJoin(branch)` is true for every non-root branch, so `#immediateReduce` returned
 * `undefined` and a task's writes never reached `p.channels` or `p.bindings` — the only path back
 * into state was `#foldJoin`, which runs after the branch is over. A node chained BEHIND the
 * writer INSIDE THE SAME BRANCH therefore read the pre-fan-out value: `undefined`, with no error,
 * no diagnostic, and `status: succeeded`. The join then folded the channel correctly, so the FINAL
 * state looked right while every branch had computed on nothing.
 *
 * That is a silent wrong answer on the most ordinary real shape there is — fan out over N items,
 * do two or more steps per item, join — and the compiler cannot warn: GRAPH005_UNPRODUCED_READ
 * does not fire, because the channel IS produced.
 *
 * THE FIX MUST NOT BREAK RULE 3 of the engine's header ("a fan-out's writes wait for its join").
 * A branch sees its OWN writes and never a sibling's, which is why the second case here drives
 * two branches writing different values and asserts each one saw only its own.
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
 * `start --fanout--> A --seq--> B`, both joining at `J`.
 *
 * The shape the compiler forces: dropping `A` from `J.branches` raises
 * GRAPH021_FANOUT_WITHOUT_JOIN and dropping the `A -> J` edge raises
 * GRAPH008_BRANCH_NOT_CONNECTED.
 */
const SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "branch-local", project: "lane-a", version: 1 },
  policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
  channels: {
    items: { type: "array", reduce: "replace" },
    item: { type: "string", reduce: "replace" },
    mid: { type: "array", reduce: "append_ordered" },
    seen: { type: "array", reduce: "append_ordered" },
    report: { type: "object", reduce: "replace" },
  },
  inputs: ["items"],
  outputs: ["report"],
  nodes: [
    { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/pass@stable" } },
    { id: n("A"), type: "function", reads: ["item"], writes: ["mid"], function: { ref: "function/writeMid@stable" } },
    { id: n("B"), type: "function", reads: ["mid", "item"], writes: ["seen"], function: { ref: "function/readMid@stable" } },
    { id: n("J"), type: "join", reads: ["mid", "seen"], writes: ["mid", "seen"], join: { branches: [n("A"), n("B")], mode: "all", onBranchError: "fail" } },
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

function rig(): { engine: Engine; saw: unknown[] } {
  const store = new MemoryStateStore({ now: NOW });
  const saw: unknown[] = [];
  const functions = new FunctionRegistry();
  functions.register("function/pass@stable", () => ({ writes: {} }));
  functions.register("function/writeMid@stable", (view) => ({ writes: { mid: `mid-${String(view.get<string>("item"))}` } }));
  functions.register("function/readMid@stable", (view) => {
    const got = view.get<unknown>("mid");
    saw.push(got);
    // Stringified rather than passed through, so a branch that saw NOTHING still produces a
    // journal-recordable value and the run reports the success it used to report — the point of
    // this case is the silent wrong answer, not a crash.
    return { writes: { seen: JSON.stringify(got ?? null) } };
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

const GRAPH = (): ReturnType<typeof compileOrThrow> =>
  compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });

test("B READS WHAT A WROTE, INSIDE THE SAME BRANCH", async () => {
  const r = rig();
  const p = await r.engine.advance(await r.engine.submit({ graph: GRAPH(), inputs: { items: ["0"] } }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.saw, [["mid-0"]], `B read ${JSON.stringify(r.saw)} for a channel its own branch had just written`);
});

test("…AND A SIBLING'S WRITE STILL WAITS FOR THE JOIN — rule 3 holds", async () => {
  // Two branches, each writing a different value. If a branch could see a sibling's held write,
  // one of these would carry both.
  const r = rig();
  const p = await r.engine.advance(await r.engine.submit({ graph: GRAPH(), inputs: { items: ["0", "1"] } }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  const sorted = [...r.saw].map((v) => JSON.stringify(v)).sort();
  assert.deepEqual(sorted, [JSON.stringify(["mid-0"]), JSON.stringify(["mid-1"])], `branches saw ${JSON.stringify(r.saw)}`);
});

test("…and the JOIN still folds every branch, in branch order", async () => {
  const r = rig();
  const p = await r.engine.advance(await r.engine.submit({ graph: GRAPH(), inputs: { items: ["0", "1", "2"] } }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  // `append_ordered`, so the fold is deterministic in BRANCH order however the branches finished.
  assert.deepEqual(p.channels["mid"], ["mid-0", "mid-1", "mid-2"], "the join's own fold must be unchanged");
  assert.deepEqual(p.channels["seen"], ['["mid-0"]', '["mid-1"]', '["mid-2"]'], "and nothing may be folded twice");
});

test("…and a run with ONE item still ends with exactly one contribution per channel", async () => {
  // The double-apply this could have introduced: a branch-local view that also reached
  // `p.channels` would make the join fold a value that had already been applied.
  const r = rig();
  const p = await r.engine.advance(await r.engine.submit({ graph: GRAPH(), inputs: { items: ["7"] } }));
  assert.deepEqual(p.channels["mid"], ["mid-7"]);
  assert.deepEqual(p.channels["seen"], ['["mid-7"]']);
});
