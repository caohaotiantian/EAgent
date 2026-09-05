/**
 * `freeze` may hand back a snapshot it made earlier, and that is only safe while it is EQUAL.
 *
 * `RunFolder.projection()` used to copy twelve containers and sort two sets on every call. That
 * is what a caller holding a projection across a commit needs — the join fold does exactly that —
 * but `GateSweeper` keeps one folder per live run across ticks and asks every tick whether or not
 * the journal moved, so an idle run paid the whole copy for a value identical to the last one.
 * The cache is dropped in `apply` and nowhere else, which is the claim these tests exist to check.
 *
 * THE EQUIVALENCE TEST IS THE LOAD-BEARING ONE. It folds every journal here one event at a time,
 * taking a snapshot after each, and compares that snapshot to what `foldRun` answers for the same
 * prefix — the fold that has no cache at all. A snapshot the cache held one event too long shows
 * up as a difference at the event that changed it.
 *
 * The clock appears once, as an absolute bound with room on both sides: 500 idle ticks over a
 * 1,600-task run cost 112.2 ms before and 0.0 ms after.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId, Seq, TaskId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { RunFolder, foldRun } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const RUN = "run_perf_lane_snap" as RunId;
const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 };

function rows(...list: readonly { type: string; payload: unknown; taskId?: string }[]): JournalEvent[] {
  return list.map(
    (r, i) =>
      ({
        seq: i + 1,
        runId: RUN,
        ts: 1_700_000_000_000 + i,
        actor: { kind: "system", id: "snap" },
        type: r.type,
        payload: r.payload,
        classification: "internal",
        ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
      }) as unknown as JournalEvent,
  );
}

/**
 * The fold, one event at a time, snapshotting after each — against the uncached fold.
 *
 * `restart()` on a rewind marker is what `GateSweeper.#catchUp` does and is part of the contract:
 * a marker changes what already-folded events mean, so the folder goes stale and the caller pays
 * one full re-fold. The loop terminates because each pass learns at least one new range.
 */
function agreesEventByEvent(events: readonly JournalEvent[], label: string): void {
  const folder = new RunFolder();
  for (let i = 0; i < events.length; i++) {
    const prefix = events.slice(0, i + 1);
    folder.push([events[i]!]);
    let guard = 0;
    while (folder.stale) {
      assert.ok(guard++ < 8, `${label}: the re-fold did not converge at event ${String(i)}`);
      folder.restart();
      folder.push(prefix);
    }
    const incremental = folder.projection();
    assert.deepEqual(incremental, foldRun(prefix), `${label}: snapshot after event ${String(i)} (${events[i]!.type})`);
    // AND ASKED TWICE. The second call is the one the cache answers; it must be the same value.
    assert.deepEqual(folder.projection(), incremental, `${label}: a second snapshot with no event between them`);
  }
}

/** A journal from a real engine run, so the corpus is not only events this file imagined. */
async function realFanoutJournal(width: number): Promise<JournalEvent[]> {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/work@stable", (view) => ({ writes: { results: [{ i: view.get<{ i: number }>("item")?.i ?? -1 }] } }));
  functions.register("function/done@stable", (view) => ({ writes: { summary: { count: (view.get<unknown[]>("results") ?? []).length } } }));

  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "wide", project: "snap", version: 1 },
    policy: { expansion: { maxNodes: 1024, maxDepth: 1, maxFanout: width, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      results: { type: "array", reduce: "append_ordered" },
      summary: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["summary"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/noop@stable" } },
      { id: n("work"), type: "function", reads: ["item"], writes: ["results"], function: { ref: "function/work@stable" } },
      { id: n("collect"), type: "join", reads: ["results"], writes: ["results"], join: { branches: [n("work")], mode: "all", onBranchError: "fail" } },
      { id: n("done"), type: "function", reads: ["results"], writes: ["summary"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fan"), from: n("start"), to: n("work"), kind: "fanout", over: "items", as: "item", maxWidth: width },
      { id: e("join"), from: n("work"), to: n("collect"), kind: "join", branches: [n("work")] },
      { id: e("out"), from: n("collect"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    maxParallelism: 4,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { items: Array.from({ length: width }, (_, i) => ({ i })) } });
  await engine.advance(runId);

  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) out.push(ev);
  return out;
}

const GATE = "gate_snap_00000000000000" as const;
const TASK = "work@root#0" as TaskId;

test("EVERY SNAPSHOT EQUALS THE UNCACHED FOLD OF THE SAME PREFIX — a real engine journal", async () => {
  const events = await realFanoutJournal(6);
  assert.ok(events.length > 40, `only ${String(events.length)} events`);
  assert.ok(
    new Set(events.map((x) => x.type)).size >= 8,
    `only ${String(new Set(events.map((x) => x.type)).size)} distinct event types in the corpus`,
  );
  agreesEventByEvent(events, "fan-out");
});

test("…and a hand-built journal covering the containers a fan-out never touches", () => {
  // Gates, escalations, ceilings, steers, external handles, outputs, and the effect sets in both
  // directions — the containers `freeze` copies that a `function` fan-out leaves empty.
  const events = rows(
    { type: "run.submitted", payload: { workflow: "w", graphHash: "h", inputs: { a: 1 }, idempotencyKey: "i", configDigest: "c" } },
    { type: "run.started", payload: { posture: "out" } },
    { type: "task.ready", payload: { nodeId: "work", branchPath: "root", edgesIn: [] }, taskId: TASK },
    { type: "effect.started", payload: { key: "eff:a", kind: "function" }, taskId: TASK },
    { type: "effect.started", payload: { key: "eff:b", kind: "function" }, taskId: TASK },
    { type: "effect.completed", payload: { key: "eff:a", kind: "function", resultDigest: "sha256:x" }, taskId: TASK },
    { type: "model.called", payload: { model: "m", usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.01, wallMs: 3 }, attempt: 1 }, taskId: TASK },
    { type: "gate.raised", payload: { gateId: GATE, nodeId: "work", policyRef: "p", contentDigest: "d" }, taskId: TASK },
    { type: "gate.delivered", payload: { gateId: GATE, channel: "cli" } },
    { type: "gate.reminded", payload: { gateId: GATE } },
    { type: "policy.escalated", payload: { scope: "run", to: "in", rule: "test" } },
    { type: "gate.decided", payload: { gateId: GATE, decision: "approve", latencyMs: 4 } },
    { type: "state.reduced", payload: { values: { a: 2 }, channels: ["a"] }, taskId: TASK },
    { type: "effect.failed", payload: { key: "eff:b", kind: "function", error: { code: "E_X", message: "m" } }, taskId: TASK },
    { type: "task.committed", payload: { status: "succeeded", writes: { a: 2 }, take: [], usage: ZERO, attempt: 1 }, taskId: TASK },
    { type: "run.completed", payload: { status: "succeeded", outputs: { a: 2 } } },
  );
  agreesEventByEvent(events, "hand-built");
});

test("…and one carrying a rewind, which is the case that invalidates a fold rather than extending it", () => {
  const events = rows(
    { type: "run.started", payload: { posture: "out" } },
    { type: "task.ready", payload: { nodeId: "work", branchPath: "root", edgesIn: [] }, taskId: TASK },
    { type: "model.called", payload: { model: "m", usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.25, wallMs: 3 }, attempt: 1 }, taskId: TASK },
    { type: "task.committed", payload: { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, taskId: TASK },
    { type: "checkpoint.restored", payload: { checkpointId: "cp_1", mode: "rewind", atSeq: 2 } },
    { type: "task.ready", payload: { nodeId: "work", branchPath: "root", edgesIn: [] }, taskId: TASK },
    { type: "task.committed", payload: { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 2 }, taskId: TASK },
  );
  agreesEventByEvent(events, "rewind");
});

test("A HELD SNAPSHOT DOES NOT MOVE UNDER LATER EVENTS — the property `freeze` exists for", () => {
  const events = rows(
    { type: "run.started", payload: { posture: "out" } },
    { type: "task.ready", payload: { nodeId: "work", branchPath: "root", edgesIn: [] }, taskId: TASK },
    { type: "effect.started", payload: { key: "eff:a", kind: "function" }, taskId: TASK },
  );
  const later = rows(
    { type: "run.started", payload: { posture: "out" } },
    { type: "task.ready", payload: { nodeId: "work", branchPath: "root", edgesIn: [] }, taskId: TASK },
    { type: "effect.started", payload: { key: "eff:a", kind: "function" }, taskId: TASK },
    { type: "effect.started", payload: { key: "eff:b", kind: "function" }, taskId: TASK },
    { type: "task.committed", payload: { status: "succeeded", writes: { a: 1 }, take: [], usage: ZERO, attempt: 1 }, taskId: TASK },
  ).slice(3);

  const folder = new RunFolder();
  folder.push(events);
  const held = folder.projection()!;
  const before = JSON.stringify(held);

  folder.push(later);
  const after = folder.projection()!;

  assert.equal(JSON.stringify(held), before, "the snapshot a caller is holding is untouched");
  assert.notEqual(held, after, "and a snapshot taken after an event is a different object");
  assert.deepEqual(held.startedEffects, ["eff:a"], "…with the effect set as it stood");
  assert.deepEqual(after.startedEffects, ["eff:a", "eff:b"]);
  assert.equal(held.tasks[TASK]?.state, "ready");
  assert.equal(after.tasks[TASK]?.state, "succeeded");
});

test("THE EFFECT SETS ARE SORTED AND CURRENT after adds, deletes and an unknown-effect batch", () => {
  const events = rows(
    { type: "run.started", payload: { posture: "out" } },
    { type: "effect.started", payload: { key: "eff:c", kind: "function" }, taskId: TASK },
    { type: "effect.started", payload: { key: "eff:a", kind: "function" }, taskId: TASK },
    { type: "effect.started", payload: { key: "eff:b", kind: "function" }, taskId: TASK },
    { type: "effect.completed", payload: { key: "eff:b", kind: "function", resultDigest: "sha256:x" }, taskId: TASK },
    { type: "run.cancelled", payload: { reason: "operator", unknownEffects: ["eff:z", "eff:y"] } },
  );
  const folder = new RunFolder();
  for (let i = 0; i < events.length; i++) {
    folder.push([events[i]!]);
    const p = folder.projection()!;
    assert.deepEqual([...p.unknownEffects].sort(), [...p.unknownEffects], "unknownEffects is sorted");
    assert.deepEqual([...p.startedEffects].sort(), [...p.startedEffects], "startedEffects is sorted");
    assert.deepEqual(p.unknownEffects, foldRun(events.slice(0, i + 1))!.unknownEffects);
    assert.deepEqual(p.startedEffects, foldRun(events.slice(0, i + 1))!.startedEffects);
  }
  const end = folder.projection()!;
  assert.deepEqual(end.startedEffects, ["eff:a", "eff:b", "eff:c"], "every effect that ever started");
  assert.deepEqual(end.unknownEffects, ["eff:a", "eff:c", "eff:y", "eff:z"], "minus the one that completed, plus the batch");
});

test("AN IDLE FOLDER ANSWERS IN CONSTANT TIME — the GateSweeper tick", () => {
  // 500 ticks over a 1,600-task run: 112.2 ms before this, 0.0 ms after. A sweeper polls up to
  // 500 live runs per tick, and a run whose journal has not moved is the ordinary case.
  const TASKS = 1600;
  const events: JournalEvent[] = [];
  let seq = 0;
  const push = (type: string, payload: unknown, taskId?: string): void => {
    events.push({
      seq: ++seq,
      runId: RUN,
      ts: 1_700_000_000_000 + seq,
      actor: { kind: "system", id: "snap" },
      type,
      payload,
      classification: "internal",
      ...(taskId === undefined ? {} : { taskId }),
    } as unknown as JournalEvent);
  };
  push("run.started", { posture: "out" });
  for (let i = 0; i < TASKS; i++) {
    const t = `work@root/fan[${String(i)}]#0`;
    push("task.ready", { nodeId: "work", branchPath: `root/fan[${String(i)}]`, edgesIn: [] }, t);
    push("effect.started", { key: `eff:${t}`, kind: "function" }, t);
    push("effect.completed", { key: `eff:${t}`, kind: "function", resultDigest: "sha256:x" }, t);
    push("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, t);
  }

  const folder = new RunFolder();
  folder.push(events);
  assert.equal(Object.keys(folder.projection()!.tasks).length, TASKS);

  let best = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 500; i++) {
      folder.push([]); // the tail an idle run has
      assert.equal(folder.projection()!.seq, seq);
    }
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`    500 idle ticks over a ${String(TASKS)}-task run: ${best.toFixed(1)} ms (best of 3)`);
  assert.ok(best < 20, `500 idle snapshots took ${best.toFixed(0)} ms — the folder is copying state nothing changed`);
});
