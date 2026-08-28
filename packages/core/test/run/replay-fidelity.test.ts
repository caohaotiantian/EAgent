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
import type { RunProjection } from "../../src/run/projection.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ModelAdapter,
  type ModelEvent,
} from "../../src/run/registry.ts";
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

/**
 * A GUARD THAT ONLY THE LIVE PATH CAN EVALUATE IS A REPLAY DIVERGENCE.
 *
 * D.7.6 added a refusal for an adapter whose terminal `done` frame names no provider, and built it
 * out of two locals that exist only while the stream is being read — `sawDoneFrame` and
 * `servingProvider`. Neither reached the journal, so `RecordedModelTurn` carried nothing the guard
 * could read and the refusal could not fire on replay. MEASURED, through `replayRun`:
 *
 *   LIVE   status= failed err= E_PROVIDER_BAD_REQUEST a= undefined
 *   REPLAY match= false
 *    { k: task.committed, e: "failed",   a: "succeeded" }
 *    { k: state.reduced,  e: {"q":"hi"}, a: {"q":"hi","a":"an answer nobody may use"} }
 *    { k: run.failed,     e: "failed",   a: "succeeded" }
 *
 * The shadow run wrote to the channel the exact string the live run had refused. That is
 * CLAUDE.md's first non-negotiable — "a value a decision reads must be reconstructable by folding
 * the journal" — and the SIBLING guard in the same function is built the other way on purpose:
 * `turnRefusal` re-derives because `finishReason` IS in `RecordedModelTurn`. The fix puts
 * `provider` there beside it.
 *
 * THE FIELD IS TRI-STATE, AND THE THIRD TEST BELOW IS WHY. `""` is a frame that arrived and named
 * nobody, which refuses; ABSENT is no terminal frame at all, which the live path allows — and
 * absent is also what every journal written before this field says, so collapsing the two would
 * make an old recording replay as a refusal of a run that succeeded.
 */

/** An untyped adapter: a terminal frame with no `provider`. Only `--extension-module` code can. */
class NamelessAdapter implements ModelAdapter {
  readonly provider = "wrapper";
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "an answer nobody may use" } as ModelEvent;
    yield {
      type: "done",
      message: { role: "assistant", content: "an answer nobody may use" },
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.0001, wallMs: 0 },
    } as unknown as ModelEvent;
  }
  priceOf(): number {
    return 0;
  }
  estimateOf(): number {
    return 0;
  }
  outputCeilingOf(): number {
    return 1024;
  }
}

/** The other shape: a stream that ends with no terminal frame at all. The live path ALLOWS it. */
class FramelessAdapter implements ModelAdapter {
  readonly provider = "wrapper";
  async *stream(): AsyncIterable<ModelEvent> {
    yield { type: "text_delta", text: "partial" } as ModelEvent;
  }
  priceOf(): number {
    return 0;
  }
  estimateOf(): number {
    return 0;
  }
  outputCeilingOf(): number {
    return 1024;
  }
}

/** Run one agent node live under `adapter`, then replay the journal it wrote. */
async function liveThenReplay(adapter: ModelAdapter): Promise<{
  live: RunProjection;
  report: Awaited<ReturnType<typeof replayRun>>;
}> {
  const res = shifting();
  const models = new ModelRegistry();
  models.register(adapter, true);
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
    resolver: res.resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const graph = compileOrThrow({ spec: spec(), resolver: res.resolver, tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { q: "hi" } });
  const live = await engine.advance(runId);
  const report = await replayRun({
    store,
    runId,
    graph,
    engine: { tools, functions: new FunctionRegistry(), models, resolver: res.resolver },
  });
  return { live, report };
}

const diverged = (r: Awaited<ReturnType<typeof replayRun>>): string => JSON.stringify(r.frames.filter((f) => !f.match));

test("A PROVIDER REFUSAL THE JOURNAL RECORDED REFUSES AGAIN ON REPLAY, and the refused text stays off the channel", async () => {
  const { live, report } = await liveThenReplay(new NamelessAdapter());

  assert.equal(live.status, "failed");
  assert.equal(live.error?.code, "E_PROVIDER_BAD_REQUEST");
  assert.equal(live.channels["a"], undefined, "the live run refused, so nothing reached the channel");

  assert.equal(report.match, true, `a faithfully recorded refusal must replay green: ${diverged(report)}`);
  assert.equal(report.replayed.status, "failed", "the replay must reach the same verdict");
  assert.equal(report.replayed.error?.code, "E_PROVIDER_BAD_REQUEST", "and for the same reason, re-derived from the record");
  assert.equal(report.replayed.channels["a"], undefined, "the shadow run must not write the string the live run refused");
});

test("THE CONTROL: a frame that NAMES its provider replays green", async () => {
  const named = new MockModelAdapter({ provider: "leaf", script: () => ({ text: "ok", finishReason: "stop" }) });
  const { live, report } = await liveThenReplay(named);

  assert.equal(live.status, "succeeded", JSON.stringify(live.error ?? {}));
  assert.equal(report.match, true, diverged(report));
  assert.equal(report.replayed.status, "succeeded");
  assert.equal(report.replayed.channels["a"], "ok");
});

test("A TURN WITH NO TERMINAL FRAME IS NOT A REFUSAL — absent must not be read as the empty string", async () => {
  // The live path allows this: a stream that never finished is a different question from a frame
  // that named nobody, and D.7.6 answers only the second. What matters here is that the replay
  // AGREES with it — and this is the same reading every journal written before
  // `RecordedModelTurn.provider` gets, so it is also the test that old recordings are not
  // re-judged under a rule their binary never had.
  const { live, report } = await liveThenReplay(new FramelessAdapter());

  assert.equal(live.status, "succeeded", JSON.stringify(live.error ?? {}));
  assert.equal(report.match, true, diverged(report));
  assert.equal(report.replayed.status, "succeeded", "an absent `provider` must replay as the run it was, not as a refusal");
});
