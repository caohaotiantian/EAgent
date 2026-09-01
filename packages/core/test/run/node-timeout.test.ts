/**
 * `NodeSpec.timeoutMs` WAS IN THE SCHEMA AND ENFORCED BY NOTHING.
 *
 * `grep -an timeoutMs packages/core/src/run/engine.ts packages/core/src/run/scheduler.ts` returned
 * NO MATCHES. A node could declare a two-minute limit and a hanging tool held its Task forever —
 * `builtin/authoring.ts` sets `timeoutMs: 120_000` and got nothing for it, and `E_TASK_TIMEOUT`
 * sat in `docs-drift.test.ts`'s `NEVER_RAISED` list, a declared code with no thrower.
 *
 * What the fix promises and what it does not: the TASK fails on time. The BODY is not cancelled —
 * it runs on against an outcome nobody reads, exactly as `ControlPlane.#withDeadline` says of its
 * own handlers, because injected code that ignores a signal cannot be stopped from outside.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(timeoutMs?: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "slow", project: "timeout", version: 1 },
    policy: {
      posture: "out",
      capabilities: ["fs:read"],
      expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
    },
    channels: { a: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["a"],
    outputs: ["out"],
    nodes: [
      {
        id: "n",
        type: "tool",
        reads: ["a"],
        writes: ["out"],
        tool: { name: "demo.hang", version: "1.0", args: {} },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        unhandled: true,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/** A tool that never resolves until the test lets it, so nothing outlives the test. */
function rig(): { engine: Engine; release: () => void; started: Promise<void> } {
  let release = (): void => {};
  // Resolved when `execute` is actually entered, so a test can wait for the tool to be RUNNING
  // rather than guessing with a yield. Guessing is what hung the first version of this file.
  let markStarted = (): void => {};
  const started = new Promise<void>((resolve) => {
    markStarted = () => resolve();
  });
  const tools = new ToolRegistry();
  const hang: ToolDefinition = {
    name: "demo.hang",
    version: "1.0",
    description: "Never finishes.",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object", properties: {} },
    execute: () =>
      new Promise((resolve) => {
        release = () => resolve({ content: "late", writes: { out: { late: true } } });
        markStarted();
      }),
  };
  tools.register(hang);
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  return { engine, release: () => release(), started };
}

test("A NODE THAT HANGS PAST ITS timeoutMs FAILS THE TASK", async () => {
  const r = rig();
  try {
    const graph = compileOrThrow({ spec: spec(25), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:read"] });
    const runId = await r.engine.submit({ graph, inputs: { a: "x" } });
    const p = await r.engine.advance(runId);

    assert.equal(p.status, "failed", `the run must not hang: ${p.status}`);
    const failed = Object.values(p.tasks).filter((t) => t.state === "failed");
    assert.equal(failed.length, 1, "exactly the slow node failed");
    assert.equal(failed[0]!.error?.code, CODES.E_TASK_TIMEOUT, JSON.stringify(failed[0]!.error));
    assert.match(failed[0]!.error?.message ?? "", /timeoutMs of 25ms/);
  } finally {
    r.release();
  }
});

test("AND A NODE WITH NO timeoutMs GETS THE COMPILED DEFAULT — the deadline is no longer opt-in", async () => {
  // THIS TEST USED TO SAY THE OPPOSITE, and the claim it made was the hole: "without a
  // `timeoutMs` the same tool is awaited exactly as before". Exactly as before meant forever —
  // measured on this very graph, `Engine.advance` was still unsettled at 1,500 ms and nothing
  // in the process would ever have settled it, and a join over such a branch waited with it.
  // `NodePlan.timeoutMs` now carries a default for the three node types `compile.ts` names.
  const r = rig();
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:read"] });
  assert.equal(graph.plans["n" as NodeId]?.timeoutMs, 600_000, "a tool node that declared nothing still has a deadline");

  // RELEASED ONCE THE TOOL IS ACTUALLY RUNNING. `release` is assigned by `execute`, which
  // `advance` reaches asynchronously — calling it on the line after `advance` starts hits the
  // initial no-op, the tool promise never resolves, and the test hangs forever. It did.
  const runId = await r.engine.submit({ graph, inputs: { a: "x" } });
  const advancing = r.engine.advance(runId);
  await r.started;
  r.release();
  const p = await advancing;
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

test("THE ENGINE READS THE COMPILED DEADLINE, not the authored field", async () => {
  // The seam, tested at the seam, because the default itself is ten minutes and no offline
  // deterministic test may wait for it. `plans` are DERIVED and excluded from `graphHash`, so a
  // plan carrying a number its node never declared is a legal `RunGraph` — the same technique
  // `graph-capability-ceiling.test.ts` uses to reach the run-time half of its rule.
  //
  // Before the fix `#withNodeDeadline` read `w.node.timeoutMs`, which is `undefined` here, and
  // this test hangs rather than fails: the assertion below is only reachable because the engine
  // now reads the plan.
  const r = rig();
  const compiled = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:read"] });
  const id = "n" as NodeId;
  const graph = { ...compiled, plans: { ...compiled.plans, [id]: { ...compiled.plans[id]!, timeoutMs: 25 } } };
  try {
    const runId = await r.engine.submit({ graph, inputs: { a: "x" } });
    const p = await r.engine.advance(runId);

    assert.equal(p.status, "failed", `the run must not hang: ${p.status}`);
    const failed = Object.values(p.tasks).filter((t) => t.state === "failed");
    assert.equal(failed[0]?.error?.code, CODES.E_TASK_TIMEOUT, JSON.stringify(failed[0]?.error));
    assert.match(failed[0]!.error?.message ?? "", /timeoutMs of 25ms/);
  } finally {
    r.release();
  }
});
