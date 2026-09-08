/**
 * A PRNG seed the recording does not hold is a DIVERGENCE, not a derivation — unless the caller
 * said the graph may differ, and then the report says a seed was derived.
 *
 * `Engine.#randomSeedEffect` branched on `has(key)` and fell through to `seedFromKey` on every
 * miss, on the argument that a miss can only be a candidate's new node under
 * `onGraphChange: "allow"` — an option the Engine cannot see. Measured at 95a3dde on a journal
 * with no `random` effect (the population written before 2026-08-24), replayed against the
 * byte-identical graph at the DEFAULT setting: the body drew from a seed the record never held,
 * and with a draw that does not reach a channel the report said `match: true, hermetic: true`.
 * `hermetic` enumerated three things that could falsify it and this was the unnamed fourth.
 *
 * The body below is exactly that second input — `Math.random() < 2` is always true, so the
 * channel says "ok" whatever the seed — because it is the one where every other frame is blind
 * and the refusal has to come from the seed itself.
 *
 * WHAT MAY DERIVE is a fact about the GRAPH, not about `onGraphChange`: a replay of a graph that
 * is not the recorded one can hold a `function` node the recording never seeded, and that is the
 * one case a derived seed explains. It was keyed on the `"allow"` opt-out first, and that broke
 * `evolution/gate.ts`, whose `runEvalSuite` replays every candidate at the default setting — the
 * last test drives that path.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { runEvalSuite } from "../../src/evolution/gate.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";
import { withoutSeeds } from "./replay-lane-filtered-store.ts";
import { DOCS, compileSkeleton, harness, skeletonSpec } from "./skeleton.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;
const SEED_KEY = "draw@root#0:random:0";

const spec = (version = 1): GraphSpec => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "seed", project: "t", version },
  channels: { out: { type: "string", reduce: "replace" } },
  inputs: [],
  nodes: [{ id: "draw" as NodeId, type: "function", writes: ["out"], function: { ref: "function/draws@stable" } }],
  edges: [],
  outputs: ["out"],
});

async function recorded() {
  const store = new MemoryStateStore();
  const bus = new InProcessEventBus();
  const resources = new ResourceStore({ now: () => 1 });
  const ref = resources.publish({
    kind: "function",
    name: "draws",
    content: `() => ({ writes: { out: Math.random() < 2 ? "ok" : "no" } })`,
    actor: ACTOR,
  });
  resources.promote(ref, "canary", ACTOR);
  resources.promote(ref, "stable", ACTOR);
  const ref2 = resources.publish({ kind: "function", name: "draws2", content: `() => ({ writes: { out2: Math.random() < 2 ? "ok" : "no" } })`, actor: ACTOR });
  resources.promote(ref2, "canary", ACTOR);
  resources.promote(ref2, "stable", ACTOR);
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (ref) => loader.load(ref) });
  const engine = new Engine({ store, bus, tools: new ToolRegistry(), functions, models: new ModelRegistry(), resolver: resources });
  const graph = compileOrThrow({ spec: spec(), resolver: resources, tools: {}, tenantCapabilities: [] });
  /** The same nodes under a different graph hash — a graph that is not the recorded one. */
  const renamed = compileOrThrow({ spec: spec(2), resolver: resources, tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: {} });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded");
  assert.equal(p.channels["out"], "ok");

  const old = withoutSeeds(store);
  let seedEvents = 0;
  for await (const e of old.read(runId, 1 as never)) if (String((e.payload as { key?: unknown }).key ?? "") === SEED_KEY) seedEvents++;
  assert.equal(seedEvents, 0, "the fixture really holds no seed");

  return { store, old, graph, renamed, runId, resources, replayEngine: { tools: new ToolRegistry(), functions, models: new ModelRegistry() } };
}

test("A RECORDING WITH NO SEED REPLAYS TO E_REPLAY_DIVERGENCE AT THE DEFAULT SETTING — it does not invent one", async () => {
  const h = await recorded();

  const report = await replayRun({ store: h.old, runId: h.runId, graph: h.graph, engine: h.replayEngine });

  assert.equal(report.match, false);
  assert.equal(report.replayed.status, "failed", "the body could not be given a seed, so its task could not run");
  assert.equal(report.replayed.error?.code, CODES.E_REPLAY_DIVERGENCE);
  assert.match(String(report.replayed.error?.message), /holds no seed for any task, so the journal predates the random effect/);
  assert.match(String(report.replayed.error?.message), /on a graph that is not the recorded one/, "the refusal says which door exists");
  assert.deepEqual(report.derivedSeeds, [], "nothing was derived — refusing is not deriving");
  assert.ok(
    report.frames.some((f) => f.kind === "run.completed" && !f.match && f.actual === `failed:${CODES.E_REPLAY_DIVERGENCE}`),
    JSON.stringify(report.frames.filter((f) => !f.match)),
  );
});

test("THE OPT-OUT DOES NOT BUY A SEED ON THE RECORDED GRAPH — `onGraphChange: \"allow\"` refuses the same miss", async () => {
  const h = await recorded();

  const report = await replayRun({ store: h.old, runId: h.runId, graph: h.graph, engine: h.replayEngine, onGraphChange: "allow" });

  assert.equal(report.replayed.status, "failed", "the graph IS the recorded one, so nothing explains the missing seed");
  assert.equal(report.replayed.error?.code, CODES.E_REPLAY_DIVERGENCE);
  assert.deepEqual(report.derivedSeeds, []);
});

test("A GRAPH THAT DIFFERS BUT HOLDS THE RECORDED NODE STILL REFUSES — a recorded node with no seed is an old journal, not a new node", async () => {
  const h = await recorded();
  assert.notEqual(h.renamed.graphHash, h.graph.graphHash, "the premise: a different graph hash over the same nodes");

  const report = await replayRun({ store: h.old, runId: h.runId, graph: h.renamed, engine: h.replayEngine });

  assert.equal(report.replayed.status, "failed", "the recording LEASED `draw`; a graph rename does not explain its missing seed");
  assert.equal(report.replayed.error?.code, CODES.E_REPLAY_DIVERGENCE);
  assert.match(String(report.replayed.error?.message), /holds no seed for any task, so the journal predates the random effect/);
  assert.deepEqual(report.derivedSeeds, []);
});

test("A NODE THE RECORDING NEVER HAD, ON A GRAPH THAT IS NOT THE RECORDED ONE, GETS A DERIVED SEED — NAMED, AND COSTING `hermetic`", async () => {
  const h = await recorded();
  const added = compileOrThrow({
    spec: {
      ...spec(),
      channels: { ...spec().channels, out2: { type: "string", reduce: "replace" } },
      nodes: [...spec().nodes, { id: "draw2" as NodeId, type: "function", writes: ["out2"], function: { ref: "function/draws2@stable" } }],
    },
    resolver: h.resources,
    tools: {},
    tenantCapabilities: [],
  });

  // The DEFAULT setting, which is what `runEvalSuite` uses, over the UNTOUCHED journal: the
  // recorded node is served its seed and only the new one derives.
  const report = await replayRun({ store: h.store, runId: h.runId, graph: added, engine: h.replayEngine });

  assert.equal(report.replayed.status, "succeeded");
  assert.deepEqual(report.derivedSeeds, ["draw2@root#0:random:0"], "the new node, and only the new node");
  assert.equal(report.hermetic, false, "a replay that derived any entropy is not hermetic");
  assert.deepEqual(report.liveBodies, [], "the bodies ARE branded — hermetic is false for the seed, not for the body");
});

test("ORDINARY HALF — the untouched journal serves its seed, derives nothing, and is hermetic", async () => {
  const h = await recorded();

  const report = await replayRun({ store: h.store, runId: h.runId, graph: h.graph, engine: h.replayEngine });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.deepEqual(report.derivedSeeds, []);
  assert.equal(report.hermetic, true);
});

test("THE EVAL GATE STILL JUDGES A CANDIDATE THAT ADDS A FUNCTION NODE — its seed is derived at the gate's default setting", async () => {
  const h = harness();
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });

  // A node the recording never had, and therefore never seeded. Deterministic, draws nothing.
  const base = skeletonSpec();
  const candidate = compileSkeleton(
    skeletonSpec({ nodes: [...base.nodes, { id: "extra" as NodeId, type: "function", function: { ref: "function/passthrough@stable" } }] }),
  );

  const report = await runEvalSuite({
    store: h.store,
    suite: { name: "s", version: 1, frozen: true, frozenAt: 1_000, cases: [{ id: "a", runId, mustPass: true, expect: { status: "succeeded" } }] },
    graph: candidate,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });

  assert.equal(report.passed, 1, JSON.stringify(report.cases[0]?.reasons));
  assert.equal(report.cases[0]?.replay?.replayed.status, "succeeded");
  assert.deepEqual(report.cases[0]?.replay?.derivedSeeds, ["extra@root#0:random:0"], "the new node's seed was derived, and the report says so");
  assert.equal(report.cases[0]?.replay?.hermetic, false);
});
