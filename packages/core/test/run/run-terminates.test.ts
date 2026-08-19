/**
 * `loom run` FINISHES THE RUN, and tells the truth about whether it did.
 *
 * `Engine.advance` returns while a Task is in backoff — its own comment says "so the caller can
 * advance again once the clock has moved" — and no caller did. `loom run` called it exactly once,
 * so a retryable failure left the run `running` forever: the journal ended at
 * `task.retry_scheduled` / `task.ready` and never moved again. There is no `loom advance`, and
 * `loom serve` starts a gate clock but no run clock, so nothing anywhere in the product finished
 * that run.
 *
 * And the command exited **0**. A CI script reading the exit code saw a green run for work that
 * had not happened.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "flaky", project: "term", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { a: { type: "string", reduce: "replace" } },
    inputs: ["a"],
    outputs: ["a"],
    nodes: [
      {
        id: "n",
        type: "function",
        reads: ["a"],
        writes: ["a"],
        function: { ref: "function/flaky@stable" },
        // `retry` is a NODE policy; on the graph it compiles and retries nothing.
        retry: { maxAttempts: 3, backoff: "fixed", initialMs: 50 },
        unhandled: true,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

test("A RUN LEFT IN BACKOFF IS `running`, WHICH IS WHY ONE `advance` IS NOT ENOUGH", async () => {
  // The engine's half of the contract, pinned so the CLI's loop has something to stand on.
  let attempts = 0;
  const functions = new FunctionRegistry();
  functions.register("function/flaky@stable", () => {
    attempts += 1;
    // `unavailable` is one of the three RETRYABLE classes — a plain `throw new Error` is not,
    // and a fixture built on one fails immediately rather than backing off. That is why the
    // first attempt to reproduce this measured a failed run instead of a stalled one.
    throw err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, "transient");
  });

  // A MOVABLE CLOCK, because `retryAfter` is a wall-clock instant: with a frozen one
  // `retryAfter <= now()` is false forever and the run can never progress. That is exactly the
  // state the product shipped in — the clock moved and nothing re-entered `advance`.
  const clock = { t: NOW };
  const store = new MemoryStateStore({ now: () => clock.t });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => clock.t,
    // Real backoff is what the CLI waits out; the engine's own sleep is not what drives it.
    sleep: async () => {},
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { a: "x" } });
  const first = await engine.advance(runId);

  assert.equal(first.status, "running", "one advance leaves a backing-off run RUNNING, not terminal");
  assert.equal(attempts, 1, "and only the first attempt has been made");

  const types: string[] = [];
  for await (const ev of store.read(runId, 1)) types.push(ev.type);
  assert.ok(types.includes("task.retry_scheduled"), `the retry must be journaled: ${types.join(", ")}`);

  // ADVANCING AGAIN, ONCE THE CLOCK HAS MOVED, IS WHAT FINISHES IT — the caller's job, which
  // nothing in the product did. `loom run` now waits out `retryAfter` and re-enters.
  clock.t += 1_000;
  let second = await engine.advance(runId);
  for (let i = 0; i < 8 && second.status === "running"; i++) {
    clock.t += 1_000;
    second = await engine.advance(runId);
  }
  assert.ok(attempts > 1, `a second advance must make the next attempt; attempts=${attempts}`);
  assert.notEqual(second.status, "running", `the run must reach rest: ${second.status}`);
});
