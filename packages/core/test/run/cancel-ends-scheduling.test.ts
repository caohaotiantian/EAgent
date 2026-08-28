/**
 * A CANCELLED RUN MUST NOT SCHEDULE MORE WORK — including work an effect that was already
 * in flight settles into after the cancel has landed.
 *
 * `TODO.md` §F.13's property is "a terminal operation is not final until every producer of
 * the state it ends is stopped". `cancel` sweeps the Tasks it can see and writes
 * `run.cancelled`; a Task whose body was mid-effect at that moment settles LATER, and
 * `#commit` is the producer that runs after the sweep. Both of its post-outcome arms create
 * new state on a run that is already terminal:
 *
 *   - the RETRY arm journals `task.retry_scheduled` + `task.ready` — a Task in state `ready`
 *     inside a run whose status is `cancelled`, which nothing will ever lease and nothing
 *     will ever end;
 *   - the SUCCESS arm journals `task.committed` + `state.reduced` and then activates the
 *     downstream edges, so a two-node graph gets a `task.ready` for a node the operator
 *     stopped the run to prevent.
 *
 * WHAT MUST STILL LAND IS THE EVIDENCE. `tool.called`, `effect.completed` and `effect.failed`
 * are written by `#invokeTool` before `#commit` is reached, and they stay:
 * `run.cancelled.unknownEffects` already names the effect as unaccounted, and dropping the
 * record of what it actually did would trade a scheduling defect for an auditing one. What
 * stops is scheduling.
 *
 * TWO NODES IN THE SUCCESS ARM ON PURPOSE. A single-node graph cannot see this defect —
 * there is no downstream edge for the commit to activate — which is why the retry-arm probe
 * above was not enough on its own.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { auditRun } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const MANIFESTS: Record<string, ToolManifestLite> = {
  "slow.write": {
    name: "slow.write",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
  },
  "next.write": {
    name: "next.write",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
  },
};

/** A promise somebody else resolves. The only ordering primitive this file uses. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

function engineOn(store: MemoryStateStore, tools: ToolRegistry): Engine {
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => 1_700_000_000_000,
    maxParallelism: 4,
    policy: { granted: ["fs:write"], budget: { runUsd: 1 } },
  });
}

function runnable(tasks: Record<string, { state: string }>): string[] {
  return Object.entries(tasks)
    .filter(([, t]) => t.state === "ready" || t.state === "leased")
    .map(([id, t]) => `${id}:${t.state}`);
}

// -- the retry arm ----------------------------------------------------------

function retrySpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "cancel-then-retry", project: "demo", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1, tokens: 1000, wallMs: 60_000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      capabilities: ["fs:write"],
    },
    channels: {
      seed: { type: "string", reduce: "replace" },
      done: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["done"],
    nodes: [
      {
        id: n("slow"),
        type: "tool",
        reads: ["seed"],
        writes: ["done"],
        tool: { name: "slow.write", version: "1.0", args: { path: "out/x" } },
        // Attempts left, so the failure below is a RETRY rather than a terminal task failure.
        retry: { maxAttempts: 3 },
        unhandled: true,
      },
    ],
    edges: [] as { id: EdgeId; from: NodeId; to: NodeId; kind: "seq" }[],
  };
}

test("A CANCELLED RUN DOES NOT SCHEDULE A RETRY for an effect that settles after the sweep", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const entered = deferred<void>();
  const release = deferred<void>();

  const tools = new ToolRegistry();
  const slow: ToolDefinition = {
    ...MANIFESTS["slow.write"]!,
    description: "A write that fails, but not until this test says so.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => {
      entered.resolve();
      await release.promise;
      throw new Error("the source went away");
    },
  };
  tools.register(slow);

  const engine = engineOn(store, tools);
  const graph = compileOrThrow({
    spec: retrySpec(),
    resolver: resolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["fs:write"],
  });
  const runId = await engine.submit({ graph, inputs: { seed: "s" } });

  const driving = engine.advance(runId);
  await entered.promise;
  const p = await engine.cancel(runId, "operator stopped it");
  assert.equal(p.status, "cancelled");

  release.resolve();
  await driving;

  const after = await events(store, runId);
  const cancelledAt = after.find((ev) => ev.type === "run.cancelled")!.seq;
  const trace = after.map((ev) => `${String(ev.seq)} ${ev.type}`).join(" | ");

  assert.equal(
    after.filter((ev) => ev.type === "task.retry_scheduled" && ev.seq > cancelledAt).length,
    0,
    `a cancelled run scheduled a retry: ${trace}`,
  );
  assert.equal(
    after.filter((ev) => ev.type === "task.ready" && ev.seq > cancelledAt).length,
    0,
    `a cancelled run readied a Task: ${trace}`,
  );

  // The evidence still lands: the effect failed and the journal says so.
  assert.ok(
    after.some((ev) => ev.type === "effect.failed" && ev.seq > cancelledAt),
    `the settling effect's own record must survive: ${trace}`,
  );

  const final = await engine.projection(runId);
  assert.equal(final?.status, "cancelled");
  assert.deepEqual(runnable(final!.tasks), [], "a terminal run holds no runnable Task");

  // AND THE AUDITOR AGREES. `run.terminal-is-last-and-once` names every event that moves a run
  // it has already ended; on this journal before the fix it named five, and the argument for
  // keeping the settling effect's own rows is only honest if the auditor can tell those apart
  // from the scheduling. It can — see `settlesAnEffectStartedBefore` in `journal/audit.ts`.
  assert.deepEqual(
    auditRun(after).violations.map((v) => `${v.rule}@${String(v.seq)}: ${v.detail}`),
    [],
    "the journal a cancel-mid-effect leaves behind must audit clean",
  );
});

// -- the success arm --------------------------------------------------------

function chainSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "cancel-then-succeed", project: "demo", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1, tokens: 1000, wallMs: 60_000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      capabilities: ["fs:write"],
    },
    channels: {
      seed: { type: "string", reduce: "replace" },
      mid: { type: "object", reduce: "replace" },
      done: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["done"],
    nodes: [
      {
        id: n("slow"),
        type: "tool",
        reads: ["seed"],
        writes: ["mid"],
        tool: { name: "slow.write", version: "1.0", args: { path: "out/x" } },
        retry: { maxAttempts: 1 },
        unhandled: true,
      },
      {
        id: n("after"),
        type: "tool",
        reads: ["mid"],
        writes: ["done"],
        tool: { name: "next.write", version: "1.0", args: { path: "out/y" } },
        retry: { maxAttempts: 1 },
        unhandled: true,
      },
    ],
    edges: [{ id: e("s"), from: n("slow"), to: n("after"), kind: "seq" as const }],
  };
}

test("A CANCELLED RUN DOES NOT ACTIVATE THE NEXT NODE when the in-flight effect settles SUCCESSFULLY", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const entered = deferred<void>();
  const release = deferred<void>();
  let downstreamRan = false;

  const tools = new ToolRegistry();
  tools.register({
    ...MANIFESTS["slow.write"]!,
    description: "A write that does not come back until this test says so.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => {
      entered.resolve();
      await release.promise;
      return { content: "written", writes: { mid: { ok: true } } };
    },
  } as ToolDefinition);
  tools.register({
    ...MANIFESTS["next.write"]!,
    description: "The node the operator cancelled the run to prevent.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => {
      downstreamRan = true;
      return { content: "second", writes: { done: { ok: true } } };
    },
  } as ToolDefinition);

  const engine = engineOn(store, tools);
  const graph = compileOrThrow({
    spec: chainSpec(),
    resolver: resolver(),
    tools: MANIFESTS,
    tenantCapabilities: ["fs:write"],
  });
  const runId = await engine.submit({ graph, inputs: { seed: "s" } });

  const driving = engine.advance(runId);
  await entered.promise;
  const p = await engine.cancel(runId, "operator stopped it");
  assert.equal(p.status, "cancelled");

  release.resolve();
  await driving;

  const after = await events(store, runId);
  const cancelledAt = after.find((ev) => ev.type === "run.cancelled")!.seq;
  const trace = after.map((ev) => `${String(ev.seq)} ${ev.type}`).join(" | ");

  // The effect's own record is expected AFTER the cancel -- that is the evidence half.
  assert.ok(
    after.some((ev) => ev.type === "effect.completed" && ev.seq > cancelledAt),
    `the settling effect's own record must survive: ${trace}`,
  );

  // What must NOT happen is everything downstream of it.
  assert.equal(
    after.filter((ev) => ev.type === "task.committed" && ev.seq > cancelledAt).length,
    0,
    `a cancelled run committed a Task: ${trace}`,
  );
  assert.equal(
    after.filter((ev) => ev.type === "state.reduced" && ev.seq > cancelledAt).length,
    0,
    `a cancelled run reduced state: ${trace}`,
  );
  assert.equal(
    after.filter((ev) => ev.type === "task.ready" && ev.seq > cancelledAt).length,
    0,
    `a cancelled run readied the next node: ${trace}`,
  );
  assert.equal(downstreamRan, false, "the node after the cancelled one did not run");

  const final = await engine.projection(runId);
  assert.equal(final?.status, "cancelled");
  assert.deepEqual(runnable(final!.tasks), [], "a terminal run holds no runnable Task");

  // AND THE AUDITOR AGREES. `run.terminal-is-last-and-once` names every event that moves a run
  // it has already ended; on this journal before the fix it named five, and the argument for
  // keeping the settling effect's own rows is only honest if the auditor can tell those apart
  // from the scheduling. It can — see `settlesAnEffectStartedBefore` in `journal/audit.ts`.
  assert.deepEqual(
    auditRun(after).violations.map((v) => `${v.rule}@${String(v.seq)}: ${v.detail}`),
    [],
    "the journal a cancel-mid-effect leaves behind must audit clean",
  );
});
