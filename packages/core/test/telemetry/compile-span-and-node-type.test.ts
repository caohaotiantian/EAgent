/**
 * TWO FACTS THE JOURNAL HAD NO WORDS FOR, AND THE SPANS THEY UNBLOCK — `DESIGN.md` item 31's
 * first slice, `TODO.md` §C.1's `loom.compile` and §C.2's `node.type`.
 *
 * `spansFrom` is a pure fold over one journal, so a span attribute is buildable only when the
 * journal already carries it. `task.leased` now carries `nodeType` and `run.compiled` carries an
 * optional, caller-measured `durationMs`. Everything below drives the ENGINE for the positive
 * half — a hand-written journal would only prove the fold agrees with itself — and hand-writes
 * the journals a driven run cannot produce: one written before either field existed, and one
 * carrying a value no engine would write.
 *
 * Offline and deterministic: injected clocks, in-memory stores, `function` bodies, and every
 * timing asserted is one the test's own clock supplied.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { NodeId, RunId, TaskId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { otlpTraceRequest } from "../../src/telemetry/otlp.ts";
import { childRunIdsOf, spansFrom, type Span } from "../../src/telemetry/spans.ts";

const n = (id: string): NodeId => id as NodeId;
const T0 = 1_700_000_000_000;
const LEAF_REF = "graph/leaf@stable";

/** One `function` node. Under `parentSpec` it is the child, so a driven trace holds two node types. */
function chainSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "chain", project: "trace", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { amount: { type: "number", reduce: "replace" }, doubled: { type: "number", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [{ id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } }],
    edges: [],
  } as unknown as GraphSpec;
}

/** A `subgraph` node delegating to `chainSpec` — the child compile is the engine's own. */
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
  subgraph: (ref) => (ref === LEAF_REF ? chainSpec() : undefined),
};

function functions(): FunctionRegistry {
  const f = new FunctionRegistry();
  f.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  return f;
}

/** `now` is handed in so a test can choose a constant clock or one that ticks per read. */
function harness(now: () => number): { store: MemoryStateStore; engine: Engine; fns: FunctionRegistry } {
  const store = new MemoryStateStore({ now });
  const fns = functions();
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: fns,
    models: new ModelRegistry(),
    now,
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { store, engine, fns };
}

const compiled = (spec: GraphSpec): RunGraph => compileOrThrow({ spec, resolver, tools: {}, tenantCapabilities: [] });

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

const compiledRow = (events: readonly JournalEvent[]): Record<string, unknown> => {
  const row = events.find((e) => e.type === "run.compiled");
  assert.ok(row !== undefined, "every submitted run journals run.compiled");
  return row.payload as unknown as Record<string, unknown>;
};
const named = (spans: readonly Span[], name: string): Span[] => spans.filter((s) => s.name === name);

// ── loom.compile ────────────────────────────────────────────────────────────

test("A MEASURED COMPILE IS [ts − durationMs, ts], A CHILD OF loom.run, ENDING WHERE THE RUN BEGINS", async () => {
  const h = harness(() => T0);
  const runId = await h.engine.submit({ graph: compiled(chainSpec()), inputs: { amount: 21 }, compileDurationMs: 7 });
  assert.equal((await h.engine.advance(runId)).status, "succeeded");

  const events = await journal(h.store, runId);
  assert.equal(compiledRow(events)["durationMs"], 7, "the caller's measurement is journaled as given");

  const spans = spansFrom(events);
  const [run] = named(spans, "loom.run");
  const compiles = named(spans, "loom.compile");
  assert.equal(compiles.length, 1, "one compile, one span");
  const c = compiles[0]!;
  assert.equal(c.parentSpanId, run!.spanId, "the compile is the run's child");
  assert.equal(c.endTime, run!.startTime, "run.submitted and run.compiled share one append and one ts — the compile ENDED there");
  assert.equal(c.startTime, T0 - 7, "and began durationMs before it");
  assert.equal(c.status, "ok");
  assert.equal(c.traceId, run!.traceId);
});

test("ABSENT IS 'NOT MEASURED': no field, no span — and a value no clock can produce is dropped, not journaled", async () => {
  for (const given of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
    const h = harness(() => T0);
    const runId = await h.engine.submit({
      graph: compiled(chainSpec()),
      inputs: { amount: 1 },
      ...(given === undefined ? {} : { compileDurationMs: given }),
    });
    await h.engine.advance(runId);
    const events = await journal(h.store, runId);
    assert.equal("durationMs" in compiledRow(events), false, `compileDurationMs=${String(given)} must journal no durationMs`);
    assert.deepEqual(named(spansFrom(events), "loom.compile"), [], `compileDurationMs=${String(given)} must draw no compile span`);
  }
  // A zero IS a measurement — "under the journal's millisecond" — and is drawn, zero-width.
  const h = harness(() => T0);
  const runId = await h.engine.submit({ graph: compiled(chainSpec()), inputs: { amount: 1 }, compileDurationMs: 0 });
  await h.engine.advance(runId);
  const [zero] = named(spansFrom(await journal(h.store, runId)), "loom.compile");
  assert.ok(zero !== undefined, "a measured 0 is still a measurement");
  assert.equal(zero.endTime - zero.startTime, 0);
});

test("A SUBGRAPH CHILD'S COMPILE IS TIMED ON THE ENGINE'S CLOCK ON A CACHE MISS, AND ABSENT ON A HIT", async () => {
  // A clock that ticks once per read: `#compileChild` reads it immediately before and after the
  // compile, with nothing asynchronous between, so a miss records exactly one tick.
  let t = T0;
  const h = harness(() => t++);
  const graph = compiled(parentSpec());

  const first = await h.engine.submit({ graph, inputs: { amount: 21 } });
  assert.equal((await h.engine.advance(first)).status, "succeeded");
  const [child1] = childRunIdsOf(spansFrom(await journal(h.store, first)));
  assert.ok(child1 !== undefined, "the parent's trace links its child");
  const child1Events = await journal(h.store, child1 as RunId);
  assert.equal(compiledRow(child1Events)["durationMs"], 1, "a miss compiled for this child, and says how long on the engine's clock");
  assert.equal(named(spansFrom(child1Events), "loom.compile").length, 1);
  assert.equal("durationMs" in compiledRow(await journal(h.store, first)), false, "the top-level submit passed no timing, so none is claimed");

  // Same parent graph, same child spec, same engine: the compile cache answers, nothing compiles.
  const second = await h.engine.submit({ graph, inputs: { amount: 4 } });
  assert.equal((await h.engine.advance(second)).status, "succeeded");
  const [child2] = childRunIdsOf(spansFrom(await journal(h.store, second)));
  assert.notEqual(child2, child1);
  const child2Events = await journal(h.store, child2 as RunId);
  assert.equal("durationMs" in compiledRow(child2Events), false, "a cache hit ran no compile for this child and must not claim one");
  assert.deepEqual(named(spansFrom(child2Events), "loom.compile"), []);
});

// ── node.type ───────────────────────────────────────────────────────────────

test("EVERY loom.task CARRIES node.type, READ OFF ITS LEASE", async () => {
  const h = harness(() => T0);
  const runId = await h.engine.submit({ graph: compiled(parentSpec()), inputs: { amount: 3 } });
  assert.equal((await h.engine.advance(runId)).status, "succeeded");
  const parentEvents = await journal(h.store, runId);
  const leases = parentEvents.filter((e) => e.type === "task.leased");
  assert.ok(leases.length > 0);
  for (const l of leases) assert.equal((l.payload as { nodeType?: unknown }).nodeType, "subgraph", "the lease names the node's declared type");

  const parentTasks = named(spansFrom(parentEvents), "loom.task");
  assert.deepEqual(parentTasks.map((s) => [s.attributes["node.id"], s.attributes["node.type"]]), [["delegate", "subgraph"]]);

  const [child] = childRunIdsOf(spansFrom(parentEvents));
  const childTasks = named(spansFrom(await journal(h.store, child as RunId)), "loom.task");
  assert.deepEqual(childTasks.map((s) => [s.attributes["node.id"], s.attributes["node.type"]]), [["double", "function"]]);
});

// ── an old journal ──────────────────────────────────────────────────────────

const OLD = "01JRUNOLDJOURNAL0000000000" as RunId;
const TASK = "double@#0" as TaskId;
function ev(seq: number, type: string, payload: unknown, taskId: TaskId | null = TASK): JournalEvent {
  return {
    runId: OLD,
    seq,
    ts: 5_000 + seq * 10,
    type,
    payload,
    actor: { kind: "system", component: "fixture" },
    ...(taskId === null ? {} : { taskId }),
    classification: "internal",
  } as unknown as JournalEvent;
}

test("A JOURNAL WRITTEN BEFORE EITHER FIELD STILL TRACES — no node.type, no loom.compile, no throw", () => {
  const old = [
    ev(1, "run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "k", configDigest: "c" }, null),
    ev(2, "run.compiled", { graphHash: "h", nodes: 1, edges: 0, resolutionManifest: [] }, null),
    ev(3, "run.started", { posture: "out" }, null),
    ev(4, "task.ready", { nodeId: "double", branchPath: "", edgesIn: [] }),
    ev(5, "task.leased", { workerId: "w1", attempt: 1 }),
    ev(6, "task.committed", { take: [], status: "succeeded", writes: {} }),
    ev(7, "run.completed", { usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }, null),
  ];
  const spans = spansFrom(old);
  assert.deepEqual(spans.map((s) => s.name), ["loom.run", "loom.task"]);
  const [task] = named(spans, "loom.task");
  assert.equal("node.type" in task!.attributes, false, "absent stays absent; nothing is looked up to fill it");
  assert.equal(task!.attributes["task.attempt"], 1, "the lease's other attributes are still read");

  // And the shapes a hand-written journal can carry that no engine writes: every one is dropped
  // rather than drawn, and none throws.
  for (const [durationMs, nodeType] of [["7", 5], [-3, null], [Number.NaN, {}], [null, ["function"]]] as const) {
    const odd = old.map((e) =>
      e.type === "run.compiled"
        ? ev(2, "run.compiled", { ...(e.payload as object), durationMs }, null)
        : e.type === "task.leased"
          ? ev(5, "task.leased", { workerId: "w1", attempt: 1, nodeType })
          : e,
    );
    const s = spansFrom(odd);
    assert.deepEqual(named(s, "loom.compile"), [], `durationMs=${JSON.stringify(durationMs)} is not a measurement`);
    assert.equal("node.type" in named(s, "loom.task")[0]!.attributes, false, `nodeType=${JSON.stringify(nodeType)} is not a type`);
  }
});

// ── replay ──────────────────────────────────────────────────────────────────

test("NEITHER FIELD IS A REPLAY FRAME: a timed run replays match:true, and the shadow claims no compile it did not time", async () => {
  const h = harness(() => T0);
  const graph = compiled(chainSpec());
  const runId = await h.engine.submit({ graph, inputs: { amount: 21 }, compileDurationMs: 12 });
  assert.equal((await h.engine.advance(runId)).status, "succeeded");

  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: new ToolRegistry(), functions: functions(), models: new ModelRegistry(), resolver },
  });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  const shadowCompiled = report.replayedEvents.find((e) => e.type === "run.compiled");
  assert.ok(shadowCompiled !== undefined);
  assert.equal("durationMs" in (shadowCompiled.payload as object), false, "the shadow's submit is handed no timing, and that is correct");
  const shadowLease = report.replayedEvents.find((e) => e.type === "task.leased");
  assert.equal((shadowLease?.payload as { nodeType?: unknown }).nodeType, "function", "the shadow's lease is written by the same appender");
});

// ── the wire ────────────────────────────────────────────────────────────────

test("THE OTLP EXPORT CARRIES BOTH: node.type as a KeyValue on loom.task, loom.compile with its measured width", async () => {
  const h = harness(() => T0);
  const runId = await h.engine.submit({ graph: compiled(chainSpec()), inputs: { amount: 2 }, compileDurationMs: 3 });
  await h.engine.advance(runId);
  const payload = otlpTraceRequest(spansFrom(await journal(h.store, runId))) as unknown as {
    resourceSpans: { scopeSpans: { spans: { name: string; startTimeUnixNano: string; endTimeUnixNano: string; attributes: { key: string; value: unknown }[] }[] }[] }[];
  };
  const wire = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
  const task = wire.find((s) => s.name === "loom.task");
  assert.deepEqual(
    task?.attributes.find((a) => a.key === "node.type"),
    { key: "node.type", value: { stringValue: "function" } },
  );
  const compile = wire.find((s) => s.name === "loom.compile");
  assert.ok(compile !== undefined, "the compile span reaches the collector");
  assert.equal(BigInt(compile.endTimeUnixNano) - BigInt(compile.startTimeUnixNano), 3_000_000n);
});
