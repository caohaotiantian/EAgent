/**
 * A child subgraph that has not finished is not a child that failed.
 *
 * `advance` returns as soon as a run has nothing RUNNABLE, which is not the same as nothing
 * left to do — a run whose only task is in retry backoff comes back `status: "running"`, and
 * so does one starved by `maxParallelism`. `#runSubgraph` tested `childP.status !==
 * "succeeded"` and reported every one of those to the parent as `E_SUBGRAPH_FAILED`, raised
 * with `err.internal`.
 *
 * That is wrong twice. It is not a bug in Loom, and the `internal` class is NOT retryable —
 * so the parent's retry policy could not re-enter the node, and a child that was about to
 * continue killed the run that delegated to it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { CODES, err } from "../../src/errors.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";

/**
 * A resolver that can actually hand back the child spec.
 *
 * `skeleton.ts`'s resolver answers `resolve` for any well-formed ref and has NO `subgraph`
 * method, so a subgraph node compiled against it never finds its child — and a first
 * version of this test passed for that reason rather than for the one it claims.
 */
function subgraphResolver(children: Record<string, GraphSpec>): ResourceResolver {
  return {
    resolve(ref) {
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      return { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" };
    },
    subgraph(ref) {
      return children[ref];
    },
  };
}

/** The child: one node that fails once with a retryable class, then succeeds. */
const CHILD: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "child", project: "probe", version: 1 },
  policy: { expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [
    {
      id: "c",
      type: "function",
      reads: ["seed"],
      writes: ["out"],
      function: { ref: "function/flaky@stable" },
      retry: { maxAttempts: 3, backoff: "fixed", initialMs: 1 },
    },
  ],
  edges: [],
} as unknown as GraphSpec;

const PARENT: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "parent", project: "probe", version: 1 },
  policy: { expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [
    {
      id: "p",
      type: "subgraph",
      reads: ["seed"],
      writes: ["out"],
      subgraph: { ref: "subgraph/child@stable", inputs: { seed: "seed" }, outputs: { out: "out" } },
    },
  ],
  edges: [],
} as unknown as GraphSpec;

test("A CHILD STILL IN RETRY BACKOFF IS REPORTED AS RETRYABLE, not as a permanent failure", async () => {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });

  const functions = new FunctionRegistry();
  let attempts = 0;
  functions.register("function/flaky@stable", () => {
    attempts += 1;
    if (attempts === 1) throw err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, "transient");
    return { writes: { out: "ok" } };
  });

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now,
    sleep: async () => {},
    maxParallelism: 2,
    resolver: subgraphResolver({ "subgraph/child@stable": CHILD }),
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({
    spec: PARENT,
    resolver: subgraphResolver({ "subgraph/child@stable": CHILD }),
    tools: {},
    tenantCapabilities: [],
  });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  await engine.advance(runId).catch(() => undefined);

  // The parent must not have recorded a PERMANENT verdict on a child that had work left.
  // `internal` is non-retryable, so recording it here ends the parent run for good.
  const fatal: string[] = [];
  for await (const ev of store.read(runId, 1)) {
    const e = (ev.payload as { error?: { code?: string; class?: string } }).error;
    if (e?.code === "E_SUBGRAPH_FAILED" && e.class === "internal") fatal.push(String(ev.type));
  }
  assert.deepEqual(
    fatal,
    [],
    "a child that has not finished must not be reported with a non-retryable `internal` E_SUBGRAPH_FAILED",
  );
});
