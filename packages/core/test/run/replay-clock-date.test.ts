/**
 * `Date` reproduces on replay through the same product path `replay-clock.test.ts` pins for
 * `ctx.now()` — TODO.md G.2.
 *
 * `Date` used to be shadowed to `undefined` inside a `function` body's realm. G.2 binds it to
 * `ctx.now` instead (`resources/realm.ts`'s `DATE_INSTALLER`, seeded per call by
 * `resources/functions.ts`'s `ARGUMENT_BRIDGE`), so a body can write `Date.now()` or `new
 * Date()` instead of threading `ctx.now()` through by hand. This file is `replay-clock.test.ts`
 * with the body rewritten to prove exactly that: the SAME claims that file makes for `ctx.now()`
 * — a recorded run answers from the LEASE, a control run at a different lease answers
 * differently, and two replays of the recording agree with each other and with the recording —
 * now hold for `Date` too, because `Date` and `ctx.now()` are reading the identical cell.
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
 * Both zero-arg forms in one body: `Date.now()` and `String(new Date())`, so a divergence in
 * either route is caught. `new Date()` is rendered through `getTime()` rather than left as a
 * locale-formatted string, so the assertion below is not also a timezone assertion.
 */
const CLOCK_BODY = `(view, ctx) => ({ writes: { out: Date.now() + "|" + new Date().getTime() } })`;

function oneNode(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "clkdate", project: "t", version: 1 },
    channels: { out: { type: "string", reduce: "replace" } },
    inputs: [],
    nodes: [{ id: "tick" as NodeId, type: "function", writes: ["out"], function: { ref: "function/clkdate@stable" } }],
    edges: [],
    outputs: ["out"],
  };
}

interface Rig {
  readonly store: MemoryStateStore;
  readonly engine: Engine;
  readonly functions: FunctionRegistry;
  readonly graph: RunGraph;
}

/** `at` is the engine clock the RECORDING runs on — every `task.leased` is stamped with it. */
function rig(at: number): Rig {
  const store = new MemoryStateStore({ now: () => at });
  const bus = new InProcessEventBus();
  const resources = new ResourceStore({ now: () => 1 });
  const ref = resources.publish({ kind: "function", name: "clkdate", content: CLOCK_BODY, actor: ACTOR });
  resources.promote(ref, "canary", ACTOR);
  resources.promote(ref, "stable", ACTOR);
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
    graph: compileOrThrow({ spec: oneNode(), resolver: resources, tools: {}, tenantCapabilities: [] }),
  };
}

/** Exactly what `loom replay` builds: tools, functions, models — and NO clock. */
function replayEngineOpts(functions: FunctionRegistry) {
  return { tools: new ToolRegistry(), functions, models: new ModelRegistry() };
}

test("A BODY'S `Date` IS THE RECORDED LEASE, AND TWO REPLAYS RETURN THE SAME NUMBER", async () => {
  const h = rig(RECORDED_AT);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.status, "succeeded", JSON.stringify(recorded.error ?? {}));

  // The recording itself: the body saw the LEASE through `Date`, not the wall clock.
  assert.equal(recorded.channels["out"], `${RECORDED_AT}|${RECORDED_AT}`);

  // CONTROL — the body is capable of answering differently, ruling out a hard-coded constant.
  const other = rig(OTHER_AT);
  const otherRunId = await other.engine.submit({ graph: other.graph, inputs: {} });
  const otherRun = await other.engine.advance(otherRunId);
  assert.equal(otherRun.channels["out"], `${OTHER_AT}|${OTHER_AT}`);
  assert.notEqual(otherRun.channels["out"], recorded.channels["out"]);

  // Two replays, back to back, each on the wall clock like the CLI's.
  const first = await replayRun({ store: h.store, runId, graph: h.graph, engine: replayEngineOpts(h.functions) });
  const second = await replayRun({ store: h.store, runId, graph: h.graph, engine: replayEngineOpts(h.functions) });

  const a = String(first.replayed.channels["out"]);
  const b = String(second.replayed.channels["out"]);

  assert.equal(a, `${RECORDED_AT}|${RECORDED_AT}`, "the replay served its own clock instead of the recording's");
  assert.equal(b, `${RECORDED_AT}|${RECORDED_AT}`, "the second replay served its own clock instead of the recording's");
  assert.equal(a, b, "two replays disagreed about Date");
  assert.equal(first.match, true, JSON.stringify(first.frames.filter((f) => !f.match)));
  assert.equal(second.match, true, JSON.stringify(second.frames.filter((f) => !f.match)));
  assert.equal(first.hermetic, true);
});

test("CONTROL — A REPLAY WHOSE `Date` OUTPUT GENUINELY DIFFERS STILL REPORTS `match: false`", async () => {
  const h = rig(RECORDED_AT);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  assert.equal((await h.engine.advance(runId)).status, "succeeded");

  const tampered = new FunctionRegistry();
  tampered.register("function/clkdate@stable", () => ({ writes: { out: "not-the-recorded-answer" } }));

  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: replayEngineOpts(tampered) });

  assert.equal(report.match, false, "a replay that produced a different answer reported agreement");
  const reduced = report.frames.filter((f) => f.kind === "state.reduced" && !f.match);
  assert.equal(reduced.length, 1, JSON.stringify(report.frames));
  assert.match(String(reduced[0]!.expected), new RegExp(String(RECORDED_AT)));
  assert.match(String(reduced[0]!.actual), /not-the-recorded-answer/);
});
