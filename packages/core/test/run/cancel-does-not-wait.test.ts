/**
 * DOES `cancel` WAIT FOR AN IN-FLIGHT EFFECT TO SETTLE? Measured here, because a second verb
 * was going to be built on the answer.
 *
 * `TODO.md` §D.4 defines `kill` as "`cancel` that does not wait for an in-flight effect to
 * settle", with `run.cancelled.forced` as its record. That definition presumes `cancel` waits.
 * This file is the reproduction of what it actually does, and it is a test rather than a note
 * because the premise is the kind of thing that changes under later edits: if `cancel` ever
 * grows a drain, the second verb becomes real and this goes red pointing at the decision.
 *
 * THE ASSERTION IS AN ORDER, NOT A DURATION. `run.cancelled` is at a lower seq than the
 * in-flight tool's `effect.completed`, in one journal, which is a fact about what happened
 * rather than about how long anything took.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
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
};

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "slow-cancel", project: "demo", version: 1 },
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
        retry: { maxAttempts: 1 },
        unhandled: true,
      },
    ],
    edges: [] as { id: EdgeId; from: NodeId; to: NodeId; kind: "seq" }[],
  };
}

/** A promise somebody else resolves. The only ordering primitive this test uses. */
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

test("CANCEL DOES NOT WAIT FOR AN IN-FLIGHT EFFECT — so `kill` would be a second name for it", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const entered = deferred<void>();
  const release = deferred<void>();
  let settled = false;

  const tools = new ToolRegistry();
  const slow: ToolDefinition = {
    ...MANIFESTS["slow.write"]!,
    description: "A write that does not come back until this test says so.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    // DELIBERATELY DEAF TO `ctx.abort`. The question is whether CANCEL waits, not whether a
    // cooperative tool stops — a tool that honours the signal would answer a different one,
    // and the effects that matter most (a charge already posted to a provider) are the deaf
    // kind by nature.
    execute: async () => {
      entered.resolve();
      await release.promise;
      settled = true;
      return { content: "written", writes: { done: { ok: true } } };
    },
  };
  tools.register(slow);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => 1_700_000_000_000,
    maxParallelism: 4,
    policy: { granted: ["fs:write"], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: MANIFESTS, tenantCapabilities: ["fs:write"] });
  const runId = await engine.submit({ graph, inputs: { seed: "s" } });

  // Not awaited: the run is meant to be mid-effect when the cancel lands.
  const driving = engine.advance(runId);
  await entered.promise;

  const p = await engine.cancel(runId, "operator stopped it");
  assert.equal(p.status, "cancelled", "cancel returned while the tool body had not returned");
  assert.equal(settled, false, "the tool has NOT finished, and cancel came back anyway");

  const mid = await events(store, runId);
  const cancelledAt = mid.find((ev) => ev.type === "run.cancelled")?.seq;
  assert.ok(cancelledAt !== undefined, "the run really was cancelled");
  assert.equal(
    mid.some((ev) => ev.type === "effect.completed"),
    false,
    "no effect had completed when the run was declared cancelled — there was no drain to skip",
  );

  // AND IT SAID SO. An effect that started and never recorded an outcome is exactly what
  // `unknownEffects` is for; a framework that reported this cancel as clean would be lying.
  assert.equal(p.unknownEffects.length, 1, `expected one unaccounted effect, got ${JSON.stringify(p.unknownEffects)}`);
  const cancelled = mid.find((ev) => ev.type === "run.cancelled")!;
  assert.equal((cancelled.payload as { clean: boolean }).clean, false);

  release.resolve();
  await driving;
  const after = await events(store, runId);
  const completedAt = after.find((ev) => ev.type === "effect.completed")?.seq;
  if (completedAt !== undefined) {
    assert.ok(completedAt > cancelledAt, "the effect settled AFTER the run was cancelled, not before it");
  }
});
