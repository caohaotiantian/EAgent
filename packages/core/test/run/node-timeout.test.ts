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

test("AND A NODE WITH NO timeoutMs IS UNCHANGED — the deadline is opt-in", async () => {
  // The refusal must be about the declaration, not about tool nodes in general. Without a
  // `timeoutMs` the same tool is awaited exactly as before, so this resolves only because the
  // test releases it.
  const r = rig();
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: ["fs:read"] });
  const runId = await r.engine.submit({ graph, inputs: { a: "x" } });
  // RELEASED ONCE THE TOOL IS ACTUALLY RUNNING. `release` is assigned by `execute`, which
  // `advance` reaches asynchronously — calling it on the line after `advance` starts hits the
  // initial no-op, the tool promise never resolves, and the test hangs forever. It did.
  const advancing = r.engine.advance(runId);
  await r.started;
  r.release();
  const p = await advancing;
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});
