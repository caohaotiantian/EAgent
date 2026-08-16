/**
 * An engine that never forgets a run is an engine with a lifetime.
 *
 * `#runs` was written on submit and never deleted, so a long-lived `loom serve` accumulated
 * one `RunContext` per run it had ever seen — the taint set, the leases, the tool-call
 * index, the expression cache, and a reference to the compiled graph — for as long as the
 * process lived. Nothing in a test suite notices; a deployment does, eventually, all at once.
 *
 * Releasing it is safe because none of it is durable. Invariant 2 says the journal is
 * authoritative and every field here is derived from it, which is why `projection` already
 * folds the log when it finds no context.
 *
 * RETIREMENT IS THE CALLER'S, and the automatic version is deliberately absent. Evicting on
 * the call that finishes a run looks obviously right and breaks two public operations that
 * legitimately act on terminal runs — `openGates`, which renders a payload the projection
 * does not carry, and `rewind`, which forks from a completed run. Both read the context and
 * both raise `E_RUN_NOT_FOUND` without it; the attempt cost three suite failures. Giving
 * each of them the journal fallback `advance` now has is the real fix and is its own change.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "lifecycle", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      { id: n("a"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/a@stable" } },
      { id: n("b"), type: "function", reads: ["out"], writes: ["out"], function: { ref: "function/a@stable" } },
    ],
    edges: [{ id: e("s"), from: n("a"), to: n("b"), kind: "seq" }],
  } as unknown as GraphSpec;
}

function rig(): { engine: Engine; graph: ReturnType<typeof compileOrThrow> } {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/a@stable", () => ({ writes: { out: "done" } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now,
    maxParallelism: 2,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  // `#runs` is genuinely private, so its size is not the observable. What IS observable is
  // the behaviour eviction must preserve — a released run still answers, and a live one
  // still refuses — and that is what these tests assert. A test that reached into the
  // private field would pin the implementation instead of the contract.
  return { engine, graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }) };
}

test("A FORGOTTEN RUN IS STILL FULLY QUERYABLE — releasing memory does not release history", async () => {
  const { engine, graph } = rig();
  const ids: RunId[] = [];
  for (let i = 0; i < 5; i++) {
    const runId = await engine.submit({ graph, inputs: { seed: `s${String(i)}` } });
    ids.push(runId);
    assert.equal((await engine.advance(runId)).status, "succeeded");
  }
  for (const runId of ids) engine.forget(runId);
  // This is what makes `forget` safe rather than destructive: every field it drops is
  // derived, so the answer is still there — it just costs a fold instead of a lookup.
  for (const runId of ids) {
    const p = await engine.projection(runId);
    assert.equal(p?.status, "succeeded", "a released run answers by folding its log");
  }
});

test("ADVANCING A FORGOTTEN-BUT-FINISHED RUN ANSWERS FROM THE JOURNAL, rather than raising not-found", async () => {
  const { engine, graph } = rig();
  const runId = await engine.submit({ graph, inputs: { seed: "s" } });
  assert.equal((await engine.advance(runId)).status, "succeeded");
  engine.forget(runId);

  // A terminal run is not an unknown run, and the log is what tells them apart. This also
  // fixes a case that predates `forget`: after a process restart, polling a run that had
  // already finished raised E_RUN_NOT_FOUND until something called `attach` — for a run
  // with no work left to bind a graph for.
  assert.equal((await engine.advance(runId)).status, "succeeded");
  assert.equal((await engine.projection(runId))?.status, "succeeded");
});

test("forget() IS IDEMPOTENT and does not error on a run this engine never saw", () => {
  const { engine } = rig();
  engine.forget("run_never_existed" as RunId);
  engine.forget("run_never_existed" as RunId);
});

test("forget() on a live run leaves the journal intact — it releases memory, not history", async () => {
  const { engine, graph } = rig();
  const runId = await engine.submit({ graph, inputs: { seed: "s" } });
  engine.forget(runId);
  // Submitted but never advanced, so it is not terminal: `advance` must refuse rather than
  // silently starting a second time against a half-built context.
  await assert.rejects(async () => engine.advance(runId), /E_RUN_NOT_FOUND|not attached/);
  // …and the journal still has it, because forgetting is a memory operation.
  const p = await engine.projection(runId);
  assert.notEqual(p, undefined, "the run's log survives forgetting its context");
});

