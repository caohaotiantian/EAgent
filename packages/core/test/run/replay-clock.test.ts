/**
 * `ctx.now()` reproduces on replay — the last place "determinism by controlling the realm" did
 * not hold.
 *
 * `Engine.#bodyClock` binds a body's clock to its journaled `task.leased.ts`, and its docstring
 * says that makes the read reproducible because "replay folds the same event and computes the
 * same number". It did not. A replay runs a SHADOW run that appends its own `task.leased`;
 * `RunLog` stamps every append with `now: this.#now()` and `journal/store.ts`'s `prepare` prefers
 * that caller value over the store's clock — so the number the body saw was the REPLAY process's
 * wall clock, and `replayRun`'s `new MemoryStateStore({now: …})` (which looks like the fix) never
 * reached an event at all. Measured before the repair, through this exact graph:
 *
 *     recorded : 1787656578075
 *     replay1  : 1787656578079   match: false
 *     replay2  : 1787656579283   match: false
 *     delta replay2 - replay1 = 1204
 *
 * The delta is just the pause between the two replays, which is the point.
 *
 * THE CONTROLS ARE THE FILE. Asserting "the two replays agreed" proves nothing on its own — a
 * body returning a constant satisfies it — so every claim here is paired:
 *
 *   - the recording is made with an INJECTED clock and the replays use the default wall clock, so
 *     "equal to the recorded value" cannot be met by a wall-clock answer;
 *   - a second live run at a different injected clock shows the body's output genuinely tracks
 *     the lease, rather than being a constant;
 *   - a replay whose body produces a different answer must STILL report `match: false`, or the
 *     repair has made replay unable to see divergence, which is worse than the bug;
 *   - a replay that cannot serve a clock must report `hermetic: false` rather than claiming it
 *     served what it re-derived.
 *
 * Deliberately no `setTimeout` anywhere: the equality that matters is against a recorded
 * constant, so this suite does not depend on real time passing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { ResourceStore } from "../../src/resources/store.ts";
import { createFunctionLoader } from "../../src/resources/functions.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

/** Two distinguishable instants, both far from any plausible `Date.now()`. */
const RECORDED_AT = 1_700_000_000_000;
const OTHER_AT = 1_600_000_000_000;

/**
 * The body reads the clock and nothing else. Through the resource loader and the `vm` realm,
 * which is the product path: `resources/functions.ts` evaluates `ctx.now()` on the host and
 * hands the NUMBER across, so what this asserts is what a workspace's `function/*.js` sees.
 */
const CLOCK_BODY = `(view, ctx) => ({ writes: { out: String(ctx.now()) } })`;
const SECOND_BODY = `(view, ctx) => ({ writes: { out2: String(ctx.now()) } })`;

function oneNode(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "clk", project: "t", version: 1 },
    channels: { out: { type: "string", reduce: "replace" } },
    inputs: [],
    nodes: [{ id: "tick" as NodeId, type: "function", writes: ["out"], function: { ref: "function/clk@stable" } }],
    edges: [],
    outputs: ["out"],
  };
}

/** The same run plus a node the recording never leased. Used only for the hermeticity control. */
function twoNodes(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "clk", project: "t", version: 1 },
    channels: { out: { type: "string", reduce: "replace" }, out2: { type: "string", reduce: "replace" } },
    inputs: [],
    nodes: [
      { id: "tick" as NodeId, type: "function", writes: ["out"], function: { ref: "function/clk@stable" } },
      { id: "tock" as NodeId, type: "function", writes: ["out2"], function: { ref: "function/clk2@stable" } },
    ],
    edges: [{ id: "e1", from: "tick", to: "tock", kind: "seq" }],
    outputs: ["out", "out2"],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly store: MemoryStateStore;
  readonly engine: Engine;
  readonly functions: FunctionRegistry;
  readonly resources: ResourceStore;
  readonly graph: RunGraph;
  readonly wide: RunGraph;
}

/** `at` is the engine clock the RECORDING runs on — every `task.leased` is stamped with it. */
function rig(at: number): Rig {
  const store = new MemoryStateStore({ now: () => at });
  const bus = new InProcessEventBus();
  const resources = new ResourceStore({ now: () => 1 });
  for (const [name, content] of [
    ["clk", CLOCK_BODY],
    ["clk2", SECOND_BODY],
  ] as const) {
    const ref = resources.publish({ kind: "function", name, content, actor: ACTOR });
    resources.promote(ref, "canary", ACTOR);
    resources.promote(ref, "stable", ACTOR);
  }
  const loader = createFunctionLoader({ store: resources });
  const functions = new FunctionRegistry({ loader: (r) => loader.load(r) });
  const engine = new Engine({
    store,
    bus,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    resolver: resources,
    now: () => at,
  });
  return {
    store,
    engine,
    functions,
    resources,
    graph: compileOrThrow({ spec: oneNode(), resolver: resources, tools: {}, tenantCapabilities: [] }),
    wide: compileOrThrow({ spec: twoNodes(), resolver: resources, tools: {}, tenantCapabilities: [] }),
  };
}

/**
 * Exactly what `loom replay` builds: tools, functions, models — and NO clock, so the replay
 * Engine runs on `Date.now`. That absence is the condition the defect needed.
 */
function replayEngineOpts(functions: FunctionRegistry) {
  return { tools: new ToolRegistry(), functions, models: new ModelRegistry() };
}

test("A BODY'S CLOCK IS THE RECORDED LEASE, AND TWO REPLAYS RETURN THE SAME NUMBER", async () => {
  const h = rig(RECORDED_AT);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.status, "succeeded", JSON.stringify(recorded.error ?? {}));

  // The recording itself: the body saw the LEASE, not some other clock.
  assert.equal(recorded.channels["out"], String(RECORDED_AT));

  // CONTROL — the body is capable of answering differently. Without this, a body hard-wired to
  // one string would satisfy every assertion below.
  const other = rig(OTHER_AT);
  const otherRunId = await other.engine.submit({ graph: other.graph, inputs: {} });
  const otherRun = await other.engine.advance(otherRunId);
  assert.equal(otherRun.channels["out"], String(OTHER_AT));
  assert.notEqual(otherRun.channels["out"], recorded.channels["out"]);

  // Two replays, back to back, each on the wall clock like the CLI's.
  const first = await replayRun({ store: h.store, runId, graph: h.graph, engine: replayEngineOpts(h.functions) });
  const second = await replayRun({ store: h.store, runId, graph: h.graph, engine: replayEngineOpts(h.functions) });

  const a = String(first.replayed.channels["out"]);
  const b = String(second.replayed.channels["out"]);

  // THE DETERMINISTIC CLAIM FIRST, deliberately. `a === b` is satisfiable by two wall-clock reads
  // that land in the same millisecond, so it is not the assertion this suite can rely on to go
  // red; equality with a recorded constant six orders of magnitude away is.
  assert.equal(a, String(RECORDED_AT), "the replay served its own clock instead of the recording's");
  assert.equal(b, String(RECORDED_AT), "the second replay served its own clock instead of the recording's");
  assert.equal(a, b, `two replays disagreed about ctx.now() — delta ${Number(b) - Number(a)} ms`);
  assert.equal(first.match, true, JSON.stringify(first.frames.filter((f) => !f.match)));
  assert.equal(second.match, true, JSON.stringify(second.frames.filter((f) => !f.match)));
  assert.equal(first.hermetic, true);
});

test("CONTROL — A REPLAY WHOSE OUTPUT GENUINELY DIFFERS STILL REPORTS `match: false`", async () => {
  // The clock repair must not make replay blind. Same journal, same graph, same resolution
  // manifest — only the in-process body differs, so `graph.bound` stays green and the divergence
  // has to be caught by `state.reduced` or by nothing at all.
  const h = rig(RECORDED_AT);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.status, "succeeded");

  const tampered = new FunctionRegistry();
  // A hand-registered body WINS over a loaded one — `FunctionRegistry.get` says so.
  tampered.register("function/clk@stable", () => ({ writes: { out: "not-the-recorded-answer" } }));

  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: replayEngineOpts(tampered) });

  assert.equal(report.match, false, "a replay that produced a different answer reported agreement");
  assert.equal(report.graph.match, true, "the graph and its manifest were identical; the divergence is in the output");
  const reduced = report.frames.filter((f) => f.kind === "state.reduced" && !f.match);
  assert.equal(reduced.length, 1, JSON.stringify(report.frames));
  assert.match(String(reduced[0]!.expected), new RegExp(String(RECORDED_AT)));
  assert.match(String(reduced[0]!.actual), /not-the-recorded-answer/);
});

test("CONTROL — A CLOCK THE RECORDING CANNOT ANSWER IS `hermetic: false`", async () => {
  // `hermetic` is documented as "nothing had to be re-derived rather than served". A body the
  // recording never leased has no lease to serve, so the shadow's own is used — and saying so is
  // the difference between a flag and a wish. `onGraphChange: "allow"` keeps the verdict about
  // the clock rather than about the graph hash.
  const h = rig(RECORDED_AT);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  assert.equal((await h.engine.advance(runId)).status, "succeeded");

  const narrow = await replayRun({ store: h.store, runId, graph: h.graph, engine: replayEngineOpts(h.functions) });
  assert.equal(narrow.hermetic, true, "the baseline replay serves every clock it reads");

  const wider = await replayRun({
    store: h.store,
    runId,
    graph: h.wide,
    engine: replayEngineOpts(h.functions),
    onGraphChange: "allow",
  });
  // `tock` ran and read a clock — and the number it got is the SHADOW's lease, because the
  // recording has none to serve. Asserting what it is not, rather than what it is, is the honest
  // shape: the fallback is a wall-clock read and this suite does not pin the wall clock.
  assert.equal(typeof wider.replayed.channels["out2"], "string");
  assert.notEqual(wider.replayed.channels["out2"], String(RECORDED_AT));
  assert.equal(wider.replayed.channels["out"], String(RECORDED_AT), "`tick` was still served from the record");
  assert.equal(wider.hermetic, false, "a body clock was re-derived and the report claimed it was served");
});
