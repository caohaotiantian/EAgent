/**
 * A REWIND AND A WAVE ARE ONE RUN'S WORK, SO THEY TAKE ONE QUEUE.
 *
 * `rewind` chained on `#rewinding` and `advance` on `#advancing` — two independent maps — so a
 * rewind ran CONCURRENTLY with an in-flight wave. The wave's task then journaled `tool.called`,
 * `effect.completed`, `task.committed` and `state.reduced` AFTER the `checkpoint.restored`
 * marker, and because the fold suppresses only the seqs strictly between `atSeq` and the marker,
 * the surviving history showed a task `succeeded` with no `task.ready` and no `task.leased`
 * anywhere behind it — reading a channel value nothing in the visible history produced. The run
 * reported `succeeded` and the operator's rewind was silently defeated.
 *
 * Reachable in the shipped product: `POST /runs/:id/commands {"kind":"rewind"}` while
 * `runClockTick` is driving `advance`.
 *
 * THE COST IS THE BEHAVIOUR THE OPERATOR WANTS. A rewind now waits for the wave, because the
 * alternative is dispatching an undo for work that is still running. `#rewinding`'s own docstring
 * argued against sharing the map on a DEADLOCK worry — "a rewind that waits on an advance that
 * waits on a lease" — and named rewind-against-advance as left open. Neither `rewind` nor
 * `#rewindSerially` calls `advance`, so there is no cycle to deadlock on: the three `this.advance`
 * call sites are two gate doors and `#runSubgraph`, and the third is on a DIFFERENT runId.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { OPERATOR } from "./operator.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = (): number => 1_700_000_000_000;

const TOOLS: Record<string, ToolManifestLite> = {
  "x.write": { name: "x.write", version: "1.0", capabilities: [], irreversibility: "reversible_write", idempotent: true, compensation: { tool: "x.undo" } },
  "x.slow": { name: "x.slow", version: "1.0", capabilities: [], irreversibility: "reversible_write", idempotent: true, compensation: { tool: "x.undo" } },
  "x.undo": { name: "x.undo", version: "1.0", capabilities: [], irreversibility: "reversible_write", idempotent: true },
};

const SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "race", project: "lane-a", version: 1 },
  policy: { posture: "out" },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: [],
  outputs: ["out"],
  nodes: [
    { id: n("t1"), type: "tool", writes: ["seed"], tool: { name: "x.write", version: "1.0", args: {} } },
    { id: n("t2"), type: "tool", reads: ["seed"], writes: ["out"], tool: { name: "x.slow", version: "1.0", args: {} } },
  ],
  edges: [{ id: e("s"), from: n("t1"), to: n("t2"), kind: "seq" }],
} as unknown as GraphSpec;

const RESOLVER: ResourceResolver = {
  resolve: (ref) =>
    /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined,
};

function rig(): {
  engine: Engine;
  store: MemoryStateStore;
  calls: string[];
  /** Resolves once `x.slow` has been entered, so "mid-wave" is a state a test can wait for. */
  entered: Promise<void>;
  release: () => void;
} {
  const store = new MemoryStateStore({ now: NOW });
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  let reached!: () => void;
  const entered = new Promise<void>((r) => {
    reached = r;
  });

  const tools = new ToolRegistry();
  tools.register({
    ...TOOLS["x.write"]!,
    description: "write",
    parameters: { type: "object", properties: {} },
    execute: () => {
      calls.push("x.write");
      return { content: "w", details: {}, writes: { seed: "s" } };
    },
  } as ToolDefinition);
  tools.register({
    ...TOOLS["x.slow"]!,
    description: "slow",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      calls.push("x.slow:enter");
      reached();
      await held;
      calls.push("x.slow:exit");
      return { content: "s", details: {}, writes: { out: { slow: true } } };
    },
  } as ToolDefinition);
  tools.register({
    ...TOOLS["x.undo"]!,
    description: "undo",
    parameters: { type: "object", properties: {} },
    execute: () => {
      calls.push("x.undo");
      return { content: "u" };
    },
  } as ToolDefinition);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: NOW,
    sleep: async () => {},
    policy: { granted: ["*"], systemFloor: "out" },
  });
  return { engine, store, calls, entered, release };
}

/**
 * Let everything that CAN run without the held tool returning actually run.
 *
 * Fifty macrotask turns, and no clock is read: every step a concurrent rewind takes is an
 * in-memory journal append, so under the defect it runs to completion inside a handful of turns
 * and under the fix it is blocked on the advance chain and takes none of them.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

async function typesOf(store: MemoryStateStore, runId: RunId): Promise<{ type: string; taskId?: string }[]> {
  const out: { type: string; taskId?: string }[] = [];
  for await (const ev of store.read(runId, 1)) out.push({ type: ev.type, ...(ev.taskId === undefined ? {} : { taskId: ev.taskId }) });
  return out;
}

test("A REWIND WAITS FOR AN IN-FLIGHT WAVE INSTEAD OF LANDING UNDER IT", async () => {
  const r = rig();
  const graph = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: TOOLS, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: {} });

  const driving = r.engine.advance(runId);
  await r.entered;

  // The operator rewinds while `x.slow` is still inside its own `execute`.
  const plan = await r.engine.planRewind(runId, 3 as Seq, OPERATOR);
  const rewinding = r.engine.rewind(runId, 3 as Seq, "put it back", OPERATOR, { planHash: plan.planHash });

  // Everything the rewind could do without the wave finishing, it now does. Under the two-map
  // version that was the whole rewind: `compensation.recorded` and `checkpoint.restored` landed
  // at seqs 17-18 while `x.slow` was still inside its own `execute`.
  await drain();
  r.release();
  await driving;
  const outcome = await rewinding.then(() => "rewound", (err: Error) => err.message);

  // NOTHING MAY COMMIT ON TOP OF THE MARKER. That is the fold describing a run that could not
  // have happened — a task `succeeded` with its `task.ready` and `task.leased` suppressed.
  const events = await typesOf(r.store, runId);
  const marker = events.findIndex((ev) => ev.type === "checkpoint.restored");
  if (marker >= 0) {
    assert.deepEqual(
      events.slice(marker).filter((ev) => ev.type === "task.committed"),
      [],
      `a task committed after the rewind marker: ${JSON.stringify(events.map((ev) => ev.type))}`,
    );
  } else {
    // The other honest outcome: the rewind waited, re-planned against a journal the wave had
    // moved, and the plan hash refused it — which `rewind`'s own docstring calls "the correct
    // answer and the one the operator can act on".
    assert.match(outcome, /Call `planRewind` again/, outcome);
  }
});

test("…and the surviving fold has a lease behind every task that succeeded", async () => {
  const r = rig();
  const graph = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: TOOLS, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: {} });
  const driving = r.engine.advance(runId);
  await r.entered;
  const plan = await r.engine.planRewind(runId, 3 as Seq, OPERATOR);
  const rewinding = r.engine.rewind(runId, 3 as Seq, "put it back", OPERATOR, { planHash: plan.planHash });
  await drain();
  r.release();
  await driving;
  const p = await rewinding.catch(() => r.engine.projection(runId));

  for (const [taskId, task] of Object.entries(p?.tasks ?? {})) {
    if (task.state !== "succeeded") continue;
    assert.ok(task.lease !== undefined, `task ${taskId} is succeeded with no lease behind it in the visible history`);
  }
});

test("…and the ORDINARY rewind, with nothing in flight, still rewinds", async () => {
  const r = rig();
  const graph = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: TOOLS, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: {} });
  r.release(); // nothing blocks; the run goes straight through
  const done = await r.engine.advance(runId);
  assert.equal(done.status, "succeeded", JSON.stringify(done.error ?? {}));

  const plan = await r.engine.planRewind(runId, 3 as Seq, OPERATOR);
  const after = await r.engine.rewind(runId, 3 as Seq, "put it back", OPERATOR, { planHash: plan.planHash });
  assert.notEqual(after.status, "succeeded", "the run is back before its work");
  assert.ok(r.calls.includes("x.undo"), `the undos must have been dispatched: ${JSON.stringify(r.calls)}`);
});

test("…and two advances still chain, which is the property the shared queue must not lose", async () => {
  const r = rig();
  const graph = compileOrThrow({ spec: SPEC, resolver: RESOLVER, tools: TOOLS, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph, inputs: {} });
  const first = r.engine.advance(runId);
  await r.entered;
  const second = r.engine.advance(runId);
  await drain();
  r.release();
  await Promise.all([first, second]);
  assert.deepEqual(
    r.calls.filter((c) => c === "x.slow:enter"),
    ["x.slow:enter"],
    "a second advance must not dispatch the same task twice",
  );
});
