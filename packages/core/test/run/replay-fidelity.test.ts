/**
 * WHAT A REPLAY REPORTS MUST BE ABOUT THE RUN, NOT ABOUT THE REPLAYER.
 *
 * `loom replay` renders each failing frame as `expected X, got Y`, and two of the inputs to that
 * sentence were wrong in ways that sent an operator to the wrong artifact.
 *
 * `graphBound` is `specBound && refsBound` — the spec hash AND the resolved resources — but the
 * frame reported the GRAPH hash either way. So editing `resources/prompt/p.md` produced
 * `✗ graph.bound : expected sha256:aaf236…, got sha256:aaf236…`: two identical strings, and no
 * hint that the manifest was what moved. A diagnostic showing a difference where there is none is
 * worse than one that says nothing.
 *
 * This is the same shape as register entry A6, whose lesson was recorded and then repeated: "a
 * wrong answer that announces itself as a different wrong answer is not a loud failure."
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";

const NOW = 1_700_000_000_000;

/** A resolver whose answer for one ref can MOVE, the way a store's does when a file is edited. */
function shifting(): { resolver: ResourceResolver; bump: () => void } {
  let n = 0;
  return {
    bump: () => {
      n += 1;
    },
    resolver: {
      resolve: (ref) =>
        /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
          ? { ref, digest: `sha256:${String(n).repeat(64).slice(0, 64)}`, channel: "stable" }
          : undefined,
      document: () => "Instructions.",
    },
  };
}

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "ag", project: "fidelity", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [
      { id: "ask", type: "agent", reads: ["q"], writes: ["a"], agent: { profile: "agent_profile/x@stable", prompt: "prompt/p@stable" } },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function rig(res: ResourceResolver): { engine: Engine; store: MemoryStateStore; tools: ToolRegistry; models: ModelRegistry } {
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "ok", finishReason: "stop" }) }), true);
  const store = new MemoryStateStore({ now: () => NOW });
  const tools = new ToolRegistry();
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    resolver: res,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, store, tools, models };
}

test("A RESOURCE THAT MOVED IS REPORTED AS THE RESOURCE, not as two identical graph hashes", async () => {
  const res = shifting();
  const r = rig(res.resolver);
  const compile = () => compileOrThrow({ spec: spec(), resolver: res.resolver, tools: {}, tenantCapabilities: [] });

  const original = compile();
  const runId = await r.engine.submit({ graph: original, inputs: { q: "hi" } });
  await r.engine.advance(runId);

  // The store moves under the run, exactly as editing a prompt file does. The SPEC is untouched.
  res.bump();
  const rebound = compile();
  assert.equal(rebound.graphHash, original.graphHash, "the spec hash must NOT move — that is the point");

  const report = await replayRun({
    store: r.store,
    runId,
    graph: rebound,
    engine: { tools: r.tools, functions: new FunctionRegistry(), models: r.models, resolver: res.resolver },
    onGraphChange: "diverge",
  });

  assert.equal(report.match, false, "a run whose resources moved must not replay green");
  const frame = report.frames.find((f) => f.kind === "graph.bound");
  assert.ok(frame !== undefined, "a graph.bound frame must be raised");
  assert.notEqual(frame!.expected, frame!.actual, "the two halves of `expected X, got Y` must DIFFER");
  assert.match(frame!.expected ?? "", /prompt\/p@stable=/, `the frame must name the ref: ${frame!.expected}`);
  assert.match(frame!.actual ?? "", /prompt\/p@stable=/, `and its new pin: ${frame!.actual}`);
});

test("A SPEC THAT MOVED IS STILL REPORTED AS THE GRAPH HASH", async () => {
  // The other conjunct, so the fix is not "always print refs". Same run, a genuinely different
  // spec: the two hashes differ and are the right thing to show.
  const res = shifting();
  const r = rig(res.resolver);
  const original = compileOrThrow({ spec: spec(), resolver: res.resolver, tools: {}, tenantCapabilities: [] });
  const runId = await r.engine.submit({ graph: original, inputs: { q: "hi" } });
  await r.engine.advance(runId);

  const other = { ...spec(), metadata: { name: "different", project: "fidelity", version: 1 } };
  const changed = compileOrThrow({ spec: other as unknown as GraphSpec, resolver: res.resolver, tools: {}, tenantCapabilities: [] });
  assert.notEqual(changed.graphHash, original.graphHash);

  const report = await replayRun({
    store: r.store,
    runId,
    graph: changed,
    engine: { tools: r.tools, functions: new FunctionRegistry(), models: r.models, resolver: res.resolver },
    onGraphChange: "diverge",
  });

  const frame = report.frames.find((f) => f.kind === "graph.bound");
  assert.ok(frame !== undefined);
  assert.equal(frame!.expected, original.graphHash, "a spec change reports the recorded graph hash");
  assert.equal(frame!.actual, changed.graphHash);
});
