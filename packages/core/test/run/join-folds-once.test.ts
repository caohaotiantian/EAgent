/**
 * A JOIN FOLDS EACH BRANCH'S WRITES EXACTLY ONCE.
 *
 * `#immediateReduce` applies a Task's writes at commit whenever the Task is at the root
 * coordinate; `#foldJoin`'s root path then folded the same `t.writes` onto `stateAtPrefix`
 * again. Measured on a real Engine before the fix, on the static graph below:
 *
 *     status succeeded  found ["a","b","c","a","b","c"]  out {"n":6}
 *
 * Three branches, six entries, and the graph compiles `ok`. Every non-idempotent reducer —
 * `append_ordered`, `sum` — silently doubles, and the join's own `task.committed` carries
 * `writes: {}` while its `state.reduced` carries the doubled value, so the arithmetic is
 * invisible unless you read the channel.
 *
 * WHY IT SURVIVED, and why the obvious test suggests the finding is false: a REAL fan-out does
 * not double-count. Its members sit at depth, `#immediateReduce` held them, and the join is
 * their only application. The shape that breaks is a STATIC sibling-branch join — arms wired
 * `kind: "join"` with no fan-out above them, so every member is at the root coordinate and
 * every member has already reduced itself.
 *
 * So the file is arranged as a pair. The static shape must produce three, and the fan-out
 * control must ALSO produce three — not two. A fix that skips the fold everywhere turns the
 * double-count into a drop, which is the same defect with the sign flipped and is worse,
 * because a missing branch looks like a branch that failed.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;
const ARMS = ["a", "b", "c"] as const;

/**
 * Two reducers, not one. `append_ordered` shows the doubling as duplicate entries and `sum`
 * shows it as arithmetic — a fix that happened to make one of them idempotent would still be
 * caught by the other, and "the defect is an `append_ordered` quirk" is a reading this closes.
 */
const CHANNELS = {
  seed: { type: "string", reduce: "replace" },
  items: { type: "array", reduce: "replace" },
  item: { type: "object", reduce: "replace" },
  found: { type: "array", reduce: "append_ordered" },
  total: { type: "number", reduce: "sum", initial: 0 },
  out: { type: "object", reduce: "replace" },
};

/** Three sibling `function` nodes, no fan-out anywhere, joined AT the root coordinate. */
function staticSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "static-sibling-join", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      { id: n("start"), type: "function", reads: ["seed"], function: { ref: "function/seed@stable" } },
      ...ARMS.map((id) => ({
        id: n(id),
        type: "function",
        reads: ["seed"],
        writes: ["found", "total"],
        function: { ref: `function/${id}@stable` },
      })),
      {
        id: n("gather"),
        type: "join",
        reads: ["found"],
        writes: ["found", "total"],
        join: { branches: ARMS.map(n), mode: "all", onBranchError: "skip" },
      },
      { id: n("done"), type: "function", reads: ["found"], writes: ["out"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      ...ARMS.map((id) => ({ id: e(`s${id}`), from: n("start"), to: n(id), kind: "seq" })),
      ...ARMS.map((id) => ({ id: e(`j${id}`), from: n(id), to: n("gather"), kind: "join", branches: ARMS.map(n) })),
      { id: e("sq"), from: n("gather"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** The control: a real fan-out over three items, joined at depth. */
function fanoutSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "fanout-join", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: ["out"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      {
        id: n("work"),
        type: "function",
        reads: ["item"],
        writes: ["found", "total"],
        function: { ref: "function/work@stable" },
      },
      {
        id: n("gather"),
        type: "join",
        reads: ["found"],
        writes: ["found", "total"],
        join: { branches: [n("work")], mode: "all", onBranchError: "skip" },
      },
      { id: n("done"), type: "function", reads: ["found"], writes: ["out"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("work"), kind: "fanout", over: "items", as: "item", maxWidth: 3 },
      { id: e("jn"), from: n("work"), to: n("gather"), kind: "join" },
      { id: e("sq"), from: n("gather"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

async function run(spec: GraphSpec, inputs: Record<string, unknown>): Promise<{ p: RunProjection; log: JournalEvent[] }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  for (const id of ARMS) {
    functions.register(`function/${id}@stable`, () => ({ writes: { found: [id], total: 1 } }));
  }
  functions.register("function/work@stable", (view) => {
    const item = view.get<{ id: string }>("item");
    return { writes: { found: [item?.id ?? "?"], total: 1 } };
  });
  functions.register("function/done@stable", (view) => ({
    writes: { out: { n: (view.get<unknown[]>("found") ?? []).length } },
  }));

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    // All three arms materialise and run in ONE wave, which is the arrangement the double-count
    // needed: the join folds against a projection in which every sibling has already committed
    // — and, before the fix, already reduced.
    maxParallelism: 3,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs });
  const p = await engine.advance(runId);
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  return { p, log };
}

test("A STATIC SIBLING-BRANCH JOIN AT THE ROOT COORDINATE FOLDS EACH BRANCH ONCE", async () => {
  const { p } = await run(staticSpec(), { seed: "s" });

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["found"], ["a", "b", "c"], "three branches, three entries — it was six");
  assert.equal(p.channels["total"], 3, "and the same for a `sum` reducer, which shows it as arithmetic");
  // Read back through a node, so this is what a graph AUTHOR sees and not only what the
  // projection holds.
  assert.deepEqual(p.channels["out"], { n: 3 });
});

test("AND A REAL FAN-OUT STILL FOLDS EACH BRANCH ONCE — the control, which must not become a DROP", async () => {
  // The half that makes the fix a fix rather than a deletion. `#immediateReduce` HOLDS at
  // depth, so these three contributions have never been applied and the join is the only thing
  // that can apply them: skipping the fold here would produce two, or zero, and a branch that
  // silently contributed nothing is indistinguishable from a branch that failed.
  const { p } = await run(fanoutSpec(), { items: [{ id: "a" }, { id: "b" }, { id: "c" }] });

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["found"], ["a", "b", "c"], "each fanned-out branch contributes exactly once");
  assert.equal(p.channels["total"], 3);
  assert.deepEqual(p.channels["out"], { n: 3 });
});

test("THE JOIN'S OWN `state.reduced` AGREES WITH THE CHANNEL, in both shapes", async () => {
  // The defect's tell was that these two disagreed: the join's `task.committed` carried
  // `writes: {}` while the `state.reduced` beside it carried six. An operator reading the
  // journal saw a number no node had written, which is why this is asserted on the EVENT and
  // not only on the folded state.
  for (const [name, spec, inputs] of [
    ["static", staticSpec(), { seed: "s" }],
    ["fan-out", fanoutSpec(), { items: [{ id: "a" }, { id: "b" }, { id: "c" }] }],
  ] as const) {
    const { log } = await run(spec, inputs);
    const reduced = log.filter((ev) => ev.type === "state.reduced" && String(ev.taskId).startsWith("gather@"));
    assert.equal(reduced.length, 1, `${name}: the join reduces once`);
    const values = (reduced[0]!.payload as { values: Record<string, unknown> }).values;
    // `found` is absent from the static join's fold — every arm had already applied itself, so
    // the join has nothing left to add, and saying so is the correct answer rather than a
    // missing one. When it IS present it must be the folded three.
    if (values["found"] !== undefined) {
      assert.deepEqual(values["found"], ["a", "b", "c"], `${name}: the event carries the folded value`);
    }
  }
});
