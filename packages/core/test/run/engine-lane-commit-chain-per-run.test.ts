/**
 * One run's journal writes do not queue behind another run's payload-store I/O.
 *
 * `Engine.#serialize` chained every journal write in the process onto ONE promise, and `#commit`
 * held a slot in it while awaiting `PayloadStore.put` — arbitrary I/O — so an unrelated run's
 * appends waited for it. Measured at 294e713 with a 400 ms `put`: a two-node function graph took
 * 3 ms alone and 783–808 ms while another run externalised two payloads. The ordering the queue
 * exists for is per run (`StateStore.append` compare-and-swaps on that run's `expectedSeq`), so
 * the chain is per run now.
 *
 * NO CLOCK DECIDES THIS TEST. The payload store's `put` is gated on a promise the test releases
 * by hand: the unrelated run must reach `succeeded` while the put is still pending — which is a
 * fact about ordering, not about milliseconds. The only clock read is the guard that turns
 * "hangs forever at 294e713" into a failure with a message, and it is an absolute bound with an
 * order of magnitude of room.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { memoryPayloads, type PayloadRef, type PayloadStore } from "../../src/journal/payloads.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function graph(name: string, over: Partial<GraphSpec>): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name, project: "chain", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 1, maxLoopIterations: 1 } },
    ...over,
  } as unknown as GraphSpec;
}

/** A payload store whose `put` does not complete until the test says so. */
function gatedPayloads(): { store: PayloadStore; release: () => void; puts: () => number } {
  const inner = memoryPayloads();
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let puts = 0;
  return {
    store: {
      async put(runId: RunId, canonical: string): Promise<PayloadRef> {
        puts++;
        await gate;
        return inner.put(runId, canonical);
      },
      get: (runId, ref) => inner.get(runId, ref),
    },
    release: () => open(),
    puts: () => puts,
  };
}

test("AN UNRELATED RUN COMMITS WHILE ANOTHER RUN'S PAYLOAD PUT IS STILL PENDING", async () => {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const payloads = gatedPayloads();
  const functions = new FunctionRegistry();
  functions.register("function/big@stable", () => ({ writes: { blob: "y".repeat(70_000) } }));
  functions.register("function/sink@stable", (view) => ({ writes: { size: String(view.get<string>("blob") ?? "").length } }));
  functions.register("function/one@stable", () => ({ writes: { out: 1 } }));
  functions.register("function/two@stable", (view) => ({ writes: { out: (view.get<number>("out") ?? 0) + 1 } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    payloads: payloads.store,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  const compile = (spec: GraphSpec) => compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });

  // `blob` is 70,000 bytes, above `EXTERNALISE_ABOVE_BYTES`, and is read by a later node, so it
  // is externalised — which is the `put` this run's commit then waits on.
  const big = compile(
    graph("big", {
      channels: { seed: { type: "string", reduce: "replace" }, blob: { type: "string", reduce: "replace" }, size: { type: "number", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["size"],
      nodes: [
        { id: n("a"), type: "function", reads: ["seed"], writes: ["blob"], function: { ref: "function/big@stable" } },
        { id: n("b"), type: "function", reads: ["blob"], writes: ["size"], function: { ref: "function/sink@stable" } },
      ],
      edges: [{ id: e("ab"), from: n("a"), to: n("b"), kind: "seq" }],
    }),
  );
  const small = compile(
    graph("small", {
      channels: { seed: { type: "string", reduce: "replace" }, out: { type: "number", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [
        { id: n("a"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/one@stable" } },
        { id: n("b"), type: "function", reads: ["out"], writes: ["out"], function: { ref: "function/two@stable" } },
      ],
      edges: [{ id: e("ab"), from: n("a"), to: n("b"), kind: "seq" }],
    }),
  );

  const bigRun = await engine.submit({ graph: big, inputs: { seed: "s" } });
  const smallRun = await engine.submit({ graph: small, inputs: { seed: "s" } });

  const bigDone = engine.advance(bigRun);
  // Let the big run reach its `put` and block there.
  for (let i = 0; i < 50 && payloads.puts() === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(payloads.puts(), 1, "the big run is parked inside `PayloadStore.put`");

  // THE CLAIM: the small run finishes while that put is still pending. At 294e713 this awaited
  // forever, because every one of its appends sat behind the big run's commit slot.
  const guard = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the small run is queued behind the big run's payload put")), 5_000).unref());
  const smallP = await Promise.race([engine.advance(smallRun), guard]);
  assert.equal(smallP.status, "succeeded", JSON.stringify(smallP.error ?? {}));
  assert.equal(smallP.channels["out"], 2);
  assert.equal(payloads.puts(), 1, "…and the put it did not wait for is still the only one, still pending");

  // THE ORDINARY HALF: releasing the put lets the big run finish exactly as before.
  payloads.release();
  const bigP = await bigDone;
  assert.equal(bigP.status, "succeeded", JSON.stringify(bigP.error ?? {}));
  assert.equal(bigP.channels["size"], 70_000, "the externalised value was read back by the next node");
  assert.ok(bigP.external["blob"] !== undefined, "`blob` left the journal as a handle");
});

test("WITHIN ONE RUN THE ORDER IS UNCHANGED — appends land in submission order, and a failed one does not poison the next", async () => {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/one@stable", () => ({ writes: { out: 1 } }));
  functions.register("function/two@stable", (view) => ({ writes: { out: (view.get<number>("out") ?? 0) + 1 } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  const spec = graph("serial", {
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "number", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      { id: n("a"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/one@stable" } },
      { id: n("b"), type: "function", reads: ["out"], writes: ["out"], function: { ref: "function/two@stable" } },
    ],
    edges: [{ id: e("ab"), from: n("a"), to: n("b"), kind: "seq" }],
  });
  const g = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph: g, inputs: { seed: "s" } });
  // Two concurrent drivers of one run are chained by `#drive`; the journal must read as one
  // ordered sequence with strictly increasing seq and the run must do its work exactly once.
  const [p1, p2] = await Promise.all([engine.advance(runId), engine.advance(runId)]);
  assert.equal(p1.status, "succeeded");
  assert.equal(p2.status, "succeeded");
  const seqs: number[] = [];
  const committed: string[] = [];
  for await (const ev of store.read(runId, 1 as never)) {
    seqs.push(ev.seq);
    if (ev.type === "task.committed") committed.push(String(ev.taskId));
  }
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "seq is contiguous from 1");
  assert.deepEqual(committed, ["a@root#0", "b@root#0"], "each task committed once, in order");
});
