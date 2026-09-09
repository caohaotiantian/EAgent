/**
 * AN OUTCOME'S WRITES CAN EACH BE RECORDABLE WHILE THEIR REDUCTION IS NOT.
 *
 * `#unrecordableOutcome` guards the three fields `#commit` copies out of the outcome — `writes`,
 * `error`, `usage` — and its docstring called that "exactly the set `#commit` appends from the
 * outcome … named rather than called total, because a fourth field added to those events has to
 * be added here too". A fourth was already there and is not a field of the outcome at all:
 * `#commit` appends `state.reduced`, whose `values` the REDUCER derives from those writes and
 * the channels as they stand.
 *
 * `1e308` is a perfectly ordinary number and `canonicalize` emits it. Two of them summed are
 * `Infinity`, which it refuses. So each write passed the guard and the append did not:
 *
 *     static-sibling-join THREW OUT OF advance(): CanonicalizationError | non-finite number Infinity at total
 *        is LoomError? false
 *     real-fanout         THREW OUT OF advance(): LoomError | channel "total": expected number, got number
 *
 * Byte-identical at `7eaa206`, so this is an incomplete new guard rather than a regression — and
 * it is the exact wedge that guard's own docstring describes: a raw `CanonicalizationError` that
 * is not a `LoomError`, so `server/http.ts` has nothing to key on; `ctx.leases.delete` never
 * runs, so the task stays `leased` forever; and the next advance reports `succeeded` with the
 * dropped write invisible unless you read the channel.
 *
 * TWO PRODUCERS, NOT ONE, which is why the fix is not a fourth `canonicalize` call. A Task at
 * the root coordinate reduces its own writes through `#immediateReduce`; a JOIN folds its
 * branches through `#foldJoin`, one screen earlier, and `reduceState` refuses a non-finite
 * accumulator there too — `asNumber` failing closed, correctly, and throwing out of `advance()`
 * all the same. A refusal a caller cannot catch is not a refusal. Both arms are below.
 *
 * THE ORDINARY HALF IS `join-folds-once.test.ts`: these are its two graphs with `1e308` in place
 * of `1`, and with `1` they both succeed and fold to three.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, TaskId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;
const ARMS = ["a", "b", "c"] as const;

/** `1e308` canonicalizes; three of them summed do not. That gap is the whole fixture. */
const HUGE = 1e308;

const CHANNELS = {
  seed: { type: "string", reduce: "replace" },
  items: { type: "array", reduce: "replace" },
  item: { type: "object", reduce: "replace" },
  found: { type: "array", reduce: "append_ordered" },
  total: { type: "number", reduce: "sum", initial: 0 },
  out: { type: "object", reduce: "replace" },
};

/** Sibling arms at the ROOT coordinate: each reduces its OWN writes, through `#immediateReduce`. */
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

/** A real fan-out: the members are HELD at depth, so the JOIN is the only thing that reduces. */
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
      { id: n("work"), type: "function", reads: ["item"], writes: ["found", "total"], function: { ref: "function/work@stable" } },
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

async function run(spec: GraphSpec, inputs: Record<string, unknown>, contribution: number): Promise<RunProjection> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  for (const id of ARMS) {
    functions.register(`function/${id}@stable`, () => ({ writes: { found: [id], total: contribution } }));
  }
  functions.register("function/work@stable", (view) => {
    const item = view.get<{ id: string }>("item");
    return { writes: { found: [item?.id ?? "?"], total: contribution } };
  });
  functions.register("function/done@stable", (view) => ({ writes: { out: { n: (view.get<unknown[]>("found") ?? []).length } } }));

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism: 3,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs });
  // NOT wrapped in a try: `advance` throwing at all is the defect. If this line throws, the
  // guard is back where it started and the message will say which producer did it.
  return engine.advance(runId);
}

test("A WRITE THAT REDUCES TO SOMETHING UNRECORDABLE FAILS ITS OWN TASK, rather than escaping `advance`", async () => {
  const p = await run(staticSpec(), { seed: "s" }, HUGE);

  // The first arm applies cleanly; the second and third are the ones whose `sum` overflows.
  //
  // SELECTED BY THE ERROR, NOT BY THE STATE, and that is not a relaxation — it is what keeps this
  // test asking its own question. `gather` declares `onBranchError: "skip"`, so once
  // `Engine.#skippedByJoin` existed the two refused arms became `skipped` rather than `failed`
  // (B.2: a branch a join absorbs is skipped). `state === "failed"` then selected ZERO arms and
  // this assertion would have compared 0 to 2. The claim was never about the word: it is that the
  // refusal is TYPED, JOURNALLED and attached to the arm that caused it, and `upsertTask` merges,
  // so `t.error` is exactly as present as it was. The state is asserted separately below, so both
  // facts are pinned and neither can drift silently.
  const refused = Object.entries(p.tasks).filter(([, t]) => t.error?.code === "E_RESOURCE_INVALID");
  assert.equal(refused.length, 2, `two arms overflow the sum: ${JSON.stringify(Object.fromEntries(Object.entries(p.tasks).map(([k, t]) => [k, `${t.state}/${t.error?.code ?? "-"}`])))}`);
  assert.deepEqual(
    [...new Set(refused.map(([, t]) => t.state))],
    ["skipped"],
    "and the join absorbed them, which is what `onBranchError: \"skip\"` asked for",
  );
  for (const [id, t] of refused) {
    assert.equal(t.error?.code, "E_RESOURCE_INVALID", `${id} carries a typed, journalled refusal`);
    assert.match(t.error!.message, /reduce/, `${id}: the message names what could not be recorded — ${t.error!.message}`);
  }
  // Not `leased`. The lease was returned, which is the half that used to strand the run.
  assert.equal(
    Object.values(p.tasks).some((t) => t.state === "leased"),
    false,
    "no task is left holding a lease its commit threw out of",
  );
  assert.equal(p.channels["total"], HUGE, "the one contribution that DID reduce stands, and is a number the journal can hold");
});

test("AND SO DOES A JOIN'S FOLD — the second producer, one screen earlier than the first", async () => {
  const p = await run(fanoutSpec(), { items: [{ id: "a" }, { id: "b" }, { id: "c" }] }, HUGE);

  assert.equal(p.tasks["gather@root#0" as TaskId]?.state, "failed", "the join is what overflows here: its members are held at depth");
  assert.equal(p.tasks["gather@root#0" as TaskId]?.error?.code, "E_RESOURCE_INVALID");
  assert.equal(
    Object.values(p.tasks).some((t) => t.state === "leased"),
    false,
    "and the join is not left leased either",
  );
});

test("THE ORDINARY HALF: the same two graphs with an ordinary contribution are untouched", async () => {
  // `join-folds-once.test.ts` is this assertion's home; it is repeated here because a guard that
  // refuses everything would pass both tests above.
  const a = await run(staticSpec(), { seed: "s" }, 1);
  assert.equal(a.status, "succeeded", JSON.stringify(a.error ?? {}));
  assert.equal(a.channels["total"], 3);
  assert.deepEqual(a.channels["found"], ["a", "b", "c"]);

  const b = await run(fanoutSpec(), { items: [{ id: "a" }, { id: "b" }, { id: "c" }] }, 1);
  assert.equal(b.status, "succeeded", JSON.stringify(b.error ?? {}));
  assert.equal(b.channels["total"], 3);
  assert.deepEqual(b.channels["found"], ["a", "b", "c"]);
});
