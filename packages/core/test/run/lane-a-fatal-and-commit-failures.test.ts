/**
 * TWO WAYS A RUN REPORTED THE WRONG THING ABOUT ITS OWN FAILURE.
 *
 *   - `#finish`'s failure filter required `t.take.length === 0`, so a task that failed with a
 *     member of `RUN_FATAL_CODES` but activated an ordinary `error` edge was excluded from the
 *     filter entirely. If the run's declared outputs were already written by an earlier node,
 *     `#finish` appended `run.completed` and the run reported **succeeded**, with a supervision
 *     requirement unmet and zero gates. `divergence-is-run-fatal.test.ts` is green only because
 *     its output channel is written by the RESCUE node; move the write one node earlier and the
 *     guard is gone.
 *
 *   - `#commit` sits outside the try/catch that turns an execution failure into
 *     `{status:"failed"}`, so a `CanonicalizationError` raised by a write the journal cannot
 *     record escaped `advance()` unconverted, `ctx.leases.delete` never ran, the task stayed
 *     `leased` forever, and the NEXT advance reported `E_OUTPUT_MISSING` — a cause unrelated to
 *     what happened. `sodOn`'s docstring states this hazard as a decided rule and it was applied
 *     to one raise path and not to the commit path beside it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
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

// ── 1 · a run-fatal code takes no error edge ────────────────────────────────

/**
 * `start` writes the DECLARED OUTPUT, then a gate that cannot be supervised fails run-fatally
 * with an `error` edge behind it. One node earlier than `divergence-is-run-fatal.test.ts` writes
 * it, which is the whole difference between that file's green and this one's red.
 */
const FATAL_SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "fatal", project: "lane-a", version: 1 },
  policy: { posture: "out" },
  channels: {
    out: { type: "object", reduce: "replace" },
    rescued: { type: "object", reduce: "replace" },
    go: { type: "object", reduce: "replace" },
  },
  inputs: [],
  outputs: ["out"],
  nodes: [
    { id: n("start"), type: "function", writes: ["out"], function: { ref: "function/answer@stable" } },
    {
      id: n("g"),
      type: "human_gate",
      writes: ["go"],
            // `approvers` is required alongside `separationOfDuties` (GRAPH014), and naming somebody
      // is what makes the refusal about the RUN's missing principal rather than about the gate.
      humanGate: { ref: "oversight/g@stable", approval: { separationOfDuties: true, approvers: ["u:ops"] } },
    },
    { id: n("rescue"), type: "function", writes: ["rescued"], function: { ref: "function/rescue@stable" } },
  ],
  edges: [
    { id: e("sg"), from: n("start"), to: n("g"), kind: "seq" },
    { id: e("err"), from: n("g"), to: n("rescue"), kind: "error" },
  ],
} as unknown as GraphSpec;

function fatalRig(): { engine: Engine; store: MemoryStateStore; rescued: number[] } {
  const store = new MemoryStateStore({ now: NOW });
  const functions = new FunctionRegistry();
  const rescued: number[] = [];
  functions.register("function/answer@stable", () => ({ writes: { out: { answer: "real" } } }));
  functions.register("function/rescue@stable", () => {
    rescued.push(1);
    return { writes: { rescued: { ok: true } } };
  });
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
  return { engine, store, rescued };
}

test("A RUN-FATAL FAILURE FAILS THE RUN EVEN WITH AN ERROR EDGE AND THE OUTPUTS ALREADY WRITTEN", async () => {
  const r = fatalRig();
  const graph = compileOrThrow({ spec: FATAL_SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  // NO `submittedBy`: the run has no recorded principal, so a gate declaring separation of
  // duties cannot be supervised and `sodOn` refuses with `E_GATE_REQUIRED`.
  const p = await r.engine.advance(await r.engine.submit({ graph, inputs: {} }));

  assert.equal(p.status, "failed", `a supervision requirement went unmet and the run reported ${p.status}`);
  assert.equal(p.error?.code, "E_GATE_REQUIRED", JSON.stringify(p.error ?? {}));
  assert.equal(Object.keys(p.gates).length, 0, "and no gate was ever answered");
});

test("…and a run-fatal code takes no error edge at all", async () => {
  const r = fatalRig();
  const graph = compileOrThrow({ spec: FATAL_SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: {} });
  await r.engine.advance(runId);
  const events: JournalEvent[] = [];
  for await (const ev of r.store.read(runId, 1)) events.push(ev);
  const committed = events.filter((ev) => ev.type === "task.committed" && ev.taskId === "g@root#0");
  assert.equal(committed.length, 1);
  assert.deepEqual(
    (committed[0]!.payload as { take: readonly string[] }).take,
    [],
    "the two guards agree by construction: a fatal code activates nothing, so nothing downstream can route around it",
  );
  assert.equal(r.rescued.length, 0, "and the rescue node never ran");
});

test("…while an ORDINARY failure still takes its error edge", async () => {
  // The half a blanket "fatal codes fail the run" would break: an error edge is how a graph
  // handles the failures it declared handlers for, and that must keep working.
  const spec: GraphSpec = {
    ...FATAL_SPEC,
    nodes: [
      { id: n("start"), type: "function", writes: ["out"], function: { ref: "function/answer@stable" } },
      { id: n("g"), type: "function", writes: ["go"], function: { ref: "function/boom@stable" } },
      { id: n("rescue"), type: "function", writes: ["rescued"], function: { ref: "function/rescue@stable" } },
    ],
  } as unknown as GraphSpec;
  const store = new MemoryStateStore({ now: NOW });
  const functions = new FunctionRegistry();
  const rescued: number[] = [];
  functions.register("function/answer@stable", () => ({ writes: { out: { answer: "real" } } }));
  functions.register("function/boom@stable", () => {
    throw new Error("an ordinary failure");
  });
  functions.register("function/rescue@stable", () => {
    rescued.push(1);
    return { writes: { rescued: { ok: true } } };
  });
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
  const graph = compileOrThrow({ spec, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const p = await engine.advance(await engine.submit({ graph, inputs: {} }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(rescued.length, 1, "the graph declared a handler and it must still run");
});

// ── 2 · a write the journal cannot record ───────────────────────────────────

const HOLEY_SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "holey", project: "lane-a", version: 1 },
  policy: { posture: "out" },
  channels: { out: { type: "array", reduce: "replace" } },
  inputs: [],
  outputs: ["out"],
  nodes: [{ id: n("a"), type: "function", writes: ["out"], function: { ref: "function/holey@stable" } }],
  edges: [],
} as unknown as GraphSpec;

function holeyRig(): { engine: Engine; store: MemoryStateStore } {
  const store = new MemoryStateStore({ now: NOW });
  const functions = new FunctionRegistry();
  // A sparse array — `canonical.ts` refuses it by design, as it does NaN, BigInt and a cycle.
  functions.register("function/holey@stable", () => ({ writes: { out: [undefined, "x"] } }));
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
  return { engine, store };
}

test("A WRITE THE JOURNAL CANNOT RECORD IS AN ORDINARY TASK FAILURE, NOT AN ESCAPING THROW", async () => {
  const r = holeyRig();
  const graph = compileOrThrow({ spec: HOLEY_SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: {} });

  // It used to reject with a raw `CanonicalizationError` — not a `LoomError`, so the HTTP layer
  // had nothing to key on.
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "failed");
  assert.match(p.error?.message ?? "", /"a"/, "the message must name the node…");
  assert.match(p.error?.message ?? "", /"out"/, "…and the channel");
  assert.notEqual(p.error?.code, "E_OUTPUT_MISSING", "the cause reported must be the cause");

  // AND THE LEASE IS RELEASED. The task used to be left `leased` forever, so every later
  // advance re-leased, re-executed and threw again.
  assert.equal(Object.values(p.tasks)[0]?.state, "failed", JSON.stringify(p.tasks));
  const again = await r.engine.advance(runId);
  assert.equal(again.status, "failed");
  assert.equal(again.error?.code, p.error?.code, "and a second advance reports the same cause, not a different one");
});

test("…and an ordinary write still commits", async () => {
  const store = new MemoryStateStore({ now: NOW });
  const functions = new FunctionRegistry();
  functions.register("function/holey@stable", () => ({ writes: { out: ["a", "x"] } }));
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
  const graph = compileOrThrow({ spec: HOLEY_SPEC, resolver: RESOLVER, tools: {}, tenantCapabilities: [] });
  const p = await engine.advance(await engine.submit({ graph, inputs: {} }));
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["out"], ["a", "x"]);
});
