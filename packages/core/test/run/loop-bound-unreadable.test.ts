/**
 * A LOOP BOUND THIS BUILD CANNOT READ REFUSES THE RUN — TODO §A.81(b).
 *
 * `#assertBound` re-checked an unreadable `maxWidth` through `readableFanoutWidth`, with a written
 * reason — *"an unreadable one fans out zero branches in silence"* — and had NO equivalent for
 * `maxIterations`, one edge kind over. `#loopMayContinue` was a raw
 * `w.task.iteration + 1 < (e.maxIterations ?? 1)`, so a `RunGraph` that reached the executor
 * without passing this build's compiler carried the bound straight into that comparison. `{}`
 * makes it `NaN`, `NaN` is false, and the loop stops after ONE pass: the `until` never gets
 * another chance, the complementary `conditional` exit never fires, and the run reports
 * **`succeeded`**. Measured at `be29cb43` on the graph below with the bound bent on the RunGraph:
 *
 *     maxIterations=6     advance=status=succeeded n=["s","x","x","x","x","x","x"]
 *     maxIterations="6"   advance=status=succeeded n=["s","x","x","x","x","x","x"]
 *     maxIterations={}    advance=status=succeeded n=["s","x"]          ← a seventh of the work
 *
 * IT FAILS OPEN, WHICH IS WHAT SEPARATES IT FROM THE WIDTH. An unreadable width fans out nothing
 * and the run visibly does nothing; an unreadable bound produces a run that LOOKS finished, and a
 * wrong answer wearing `succeeded` is the worse of the two.
 *
 * THREE CLAIMS ARE PINNED HERE, AND THE THIRD IS WHY THIS IS A COPY AND NOT A NEW RULE.
 *
 *   1. An honest bound still runs every iteration. The no-regression half, and the one a
 *      readability guard is most likely to break.
 *   2. Every unreadable shape is refused — a CENSUS, not `{}` alone, because `{}` is the value
 *      that happened to be found and the hole is "not a positive safe integer". A numeric STRING
 *      is in the refused set deliberately: `"6"` runs today by `<` coercion, and refusing it is a
 *      tightening.
 *   3. The COMPILER already refuses every member of that census, so no graph that passed this
 *      build's compiler can carry one. That is the whole argument for the executor holding a
 *      second copy rather than a second rule, and it is asserted rather than asserted-about.
 *
 * WHICH VERBS REACH IT (`CLAUDE.md`'s lesson (a)). `#assertBound` has three call sites — `advance`
 * and the two gate doors, `resolveGate` and `decideGateBatch` — and this check sits in it beside
 * the two that were already there, so all three are the same door. Measured on the verbs a caller
 * actually has:
 *
 *     submit -> advance (one process)           REFUSED E_GRAPH_INVALID, journal ends run.failed
 *     restart: engine 2 attaches, advances      REFUSED E_GRAPH_INVALID, run.failed rows: 1
 *     pause -> attach -> resume -> advance      NOT refused, and NOT a hole — see below
 *     a run that HAS EXECUTED, then a restart   REFUSED every advance, run.failed rows: 0
 *
 * The third line is pre-existing and identical for the `maxWidth` guard, measured side by side:
 * `#contextFor` "returns the existing one untouched", so `attach` on a run THIS PROCESS ALREADY
 * HOLDS discards the graph handed to it. The bent graph never reaches the executor at all, which
 * is why that run completes honestly. The genuine attach path is a process that holds no context —
 * a restart — and that is line two.
 *
 * THE FOURTH LINE IS THE §A.66 ARM AND IT IS THE CORRECT ONE, which is why it is pinned rather
 * than merely noted. A run parked at a `human_gate` has EXECUTED, and `#failUnreadableGraph`
 * conjoins "never executed" because the identity pair it checks is synthesisable by anyone with
 * journal READ access — so a caller bending the bound on a run's own `graphHash` must not be able
 * to kill a live parked run. The honest cost is §A.63's own sentence: the advance is refused every
 * time and NO terminal row is ever written. Measured identically for `maxWidth`, so it is the
 * shared pre-existing arm and not something this check introduced, and the run still recovers —
 * attaching the HONEST graph advances it back to `awaiting_gate`.
 *
 * AND THE JOURNAL SAYS WHY, for the runs that have not executed. `#failUnreadableGraph` keys on
 * the CODE (`E_GRAPH_INVALID` + `validation`) and not on any one arm — "EVERY CHECK BY
 * CONSTRUCTION" — so this third check joins §A.63's machinery without touching it: the run is
 * FAILED with the refusal's own `details` rather than left `running` with nothing on the log
 * saying why. Pinned below, and pinned again as the third member of `FAULTS` in
 * `advance-refusal-is-journaled.test.ts`, which is the census that runs all six of its cases over
 * every `#assertBound` vocabulary check.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile } from "../../src/graph/compile.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver, SKELETON_TENANT_CAPS } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/**
 * A bounded convergence loop, the shape `examples/graphs/harden-config.json` ships: a `loop` edge
 * with `until` and `maxIterations`, and a complementary `conditional` exit. `until` needs five
 * elements and `maxIterations` is 6, so an honest run writes `s` plus six `x`s.
 */
function loopSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "loop-bound", project: "unreadable", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 2, maxLoopIterations: 8 } },
    channels: { n: { type: "array", reduce: "append_ordered" } },
    inputs: [],
    outputs: [],
    nodes: [
      { id: "seed", type: "function", reads: [], writes: ["n"], function: { ref: "function/seed@stable" } },
      { id: "step", type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/step@stable" } },
      { id: "done", type: "function", reads: ["n"], writes: [], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: "e1", from: "seed", to: "step", kind: "seq" },
      { id: "e2", from: "step", to: "step", kind: "loop", until: "len(n) >= 5", maxIterations: 6 },
      { id: "e3", from: "step", to: "done", kind: "conditional", when: "len(n) >= 5" },
    ],
  } as unknown as GraphSpec;
}

function engineOn(store: MemoryStateStore): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({ writes: { n: ["s"] } }));
  functions.register("function/step@stable", () => ({ writes: { n: ["x"] } }));
  functions.register("function/done@stable", () => ({ writes: {} }));
  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [], budget: { runUsd: 100 } },
  });
}

/** The honest compile, once — every case below bends a deep copy of it. */
function compiled(): RunGraph {
  const r = compile({ spec: loopSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  assert.equal(r.ok, true, `the honest graph must compile: ${r.diagnostics.map((d) => d.code).join(", ")}`);
  assert.ok(r.ok);
  return r.graph;
}

/** A RunGraph whose loop edge carries `bound` — `ABSENT` deletes the field. */
const ABSENT = Symbol("absent");
function bend(bound: unknown): RunGraph {
  const g = JSON.parse(JSON.stringify(compiled())) as RunGraph;
  const e2 = g.spec.edges.find((e) => e.id === "e2") as unknown as Record<string, unknown>;
  if (bound === ABSENT) delete e2["maxIterations"];
  else e2["maxIterations"] = bound;
  return g;
}

async function typesOf(store: MemoryStateStore, runId: RunId): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev.type);
  return out;
}

/**
 * The census. Every member must be refused by the executor AND by the compiler — the second is
 * what makes this a copy of an earlier answer rather than a rule of its own.
 */
const UNREADABLE: readonly { readonly what: string; readonly v: unknown; readonly says: string }[] = [
  { what: "an object — the §A.81 repro", v: {}, says: "an object" },
  { what: "a numeric string", v: "6", says: '"6"' },
  { what: "zero", v: 0, says: "0" },
  { what: "absent", v: ABSENT, says: "undefined" },
  { what: "a fraction", v: 2.5, says: "2.5" },
  { what: "beyond the safe integers", v: 1e21, says: "1e+21" },
  { what: "NaN", v: NaN, says: "NaN" },
  { what: "negative", v: -1, says: "-1" },
  { what: "null", v: null, says: "null" },
  { what: "true", v: true, says: "true" },
  { what: "an array", v: [6], says: "an array" },
];

test("an HONEST maxIterations still runs every iteration", async () => {
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = engineOn(store);
  const runId = await engine.submit({ graph: compiled(), inputs: {} });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded");
  // One seed and six steps: `until` needs five and the bound allows six, so the bound is what
  // stops it. A guard that broke this would look like a pass on every refusal test below.
  assert.deepEqual(p.channels["n"], ["s", "x", "x", "x", "x", "x", "x"]);
});

test("every unreadable maxIterations is refused at advance, naming the edge and the value", async () => {
  for (const { what, v, says } of UNREADABLE) {
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = engineOn(store);
    const runId = await engine.submit({ graph: bend(v), inputs: {} });
    await assert.rejects(
      () => engine.advance(runId),
      (e: unknown) => {
        assert.ok(isLoomError(e), `${what}: not a loom error`);
        assert.equal(e.code, CODES.E_GRAPH_INVALID, what);
        // The class `#failUnreadableGraph` keys on, beside the code.
        assert.equal(e.class, "validation", what);
        assert.match(e.message, /has a loop edge whose maxIterations this build cannot read/, what);
        assert.match(e.message, /"e2" \(maxIterations /, `${what}: the edge is not named`);
        assert.ok(e.message.includes(`(maxIterations ${says})`), `${what}: got ${e.message}`);
        // The consequence, in the refusal, the way the width's says what ITS reader does.
        assert.match(e.message, /stops the loop after one pass whatever bound was declared, and reports the run succeeded/, what);
        const details = e.details as Record<string, unknown> | undefined;
        assert.deepEqual(details?.["edges"], [{ id: "e2", maxIterations: says }], what);
        return true;
      },
      what,
    );
    // AND THE JOURNAL SAYS SO, rather than leaving a `running` run with no reason (§A.63).
    const types = await typesOf(store, runId);
    assert.equal(types.filter((t) => t === "run.failed").length, 1, `${what}: not journaled`);
    assert.equal(types.at(-1), "run.failed", what);
  }
});

test("the COMPILER refuses the same census, so no compiled graph can carry one", () => {
  for (const { what, v } of UNREADABLE) {
    const spec = loopSpec() as unknown as { edges: Record<string, unknown>[] };
    const e2 = spec.edges.find((e) => e["id"] === "e2")!;
    if (v === ABSENT) delete e2["maxIterations"];
    else e2["maxIterations"] = v;
    const r = compile({ spec: spec as unknown as GraphSpec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
    assert.equal(r.ok, false, `${what}: the compiler ACCEPTED it — the executor's copy is now the only reader`);
    const codes = r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
    assert.ok(
      codes.includes("GRAPH006_BAD_MAX_ITERATIONS") || codes.includes("GRAPH006_UNBOUNDED_LOOP"),
      `${what}: refused, but not for the bound: ${codes.join(", ")}`,
    );
  }
});

test("a RESTART reaches the guard: a fresh engine attaching a bent graph is refused", async () => {
  // The honest attach path. `#contextFor` returns a context this process already holds untouched,
  // so `attach` only binds anything in a process that has none — which is what a restart is.
  const store = new MemoryStateStore({ now: () => NOW });
  const first = engineOn(store);
  const runId = await first.submit({ graph: compiled(), inputs: {} });

  const second = engineOn(store);
  second.attach(runId, bend({}));
  await assert.rejects(
    () => second.advance(runId),
    (e: unknown) => {
      assert.ok(isLoomError(e));
      assert.equal(e.code, CODES.E_GRAPH_INVALID);
      return true;
    },
  );
  assert.equal((await typesOf(store, runId)).filter((t) => t === "run.failed").length, 1);
});

test("a restart with the run's OWN graph still advances — the guard is about the value", async () => {
  const store = new MemoryStateStore({ now: () => NOW });
  const first = engineOn(store);
  const runId = await first.submit({ graph: compiled(), inputs: {} });

  const second = engineOn(store);
  second.attach(runId, compiled());
  const p = await second.advance(runId);
  assert.equal(p.status, "succeeded");
  assert.deepEqual(p.channels["n"], ["s", "x", "x", "x", "x", "x", "x"]);
});

/**
 * `start --loop--> start`, then a `human_gate`: a run that EXECUTES and then PARKS, which is the
 * §A.66 arm — the one shape where the refusal is correct and the terminal row is correctly absent.
 */
function parkingSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "loop-bound-parked", project: "unreadable", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 4, maxLoopIterations: 8 } },
    channels: { n: { type: "array", reduce: "append_ordered" }, items: { type: "array", reduce: "replace" } },
    inputs: ["items"],
    outputs: [],
    nodes: [
      { id: "seed", type: "function", reads: [], writes: ["n"], function: { ref: "function/seed@stable" } },
      { id: "hold", type: "human_gate", reads: ["items"], humanGate: { ref: "oversight/hold@stable" } },
      { id: "done", type: "function", reads: ["n"], writes: [], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: "lp", from: "seed", to: "seed", kind: "loop", until: "len(n) >= 2", maxIterations: 4 },
      { id: "s0", from: "seed", to: "hold", kind: "seq" },
      { id: "s1", from: "hold", to: "done", kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

test("a run that HAS EXECUTED is refused on every advance and is NOT failed — the §A.66 arm", async () => {
  // THE CORRECT ARM, asserted so nobody "fixes" it into a terminal row. `#failUnreadableGraph`
  // conjoins "this run has never EXECUTED" precisely because the identity pair is synthesisable
  // from journal read access — so a caller who bends the bound on a run's OWN graphHash must not
  // be able to kill a live parked run. The cost is the honest one and it is stated in §A.63's
  // sentence: the run is left where it was with no row saying why the advance was refused.
  //
  // IDENTICAL FOR `maxWidth`, measured side by side, so this is the shared pre-existing arm and
  // not something the §A.81 check introduced.
  const store = new MemoryStateStore({ now: () => NOW });
  const good = compile({ spec: parkingSpec(), resolver: resolver(), tools: {}, tenantCapabilities: SKELETON_TENANT_CAPS });
  assert.ok(good.ok, `the parking graph must compile: ${good.diagnostics.map((d) => d.code).join(", ")}`);

  const first = engineOn(store);
  const runId = await first.submit({ graph: good.graph, inputs: { items: [{ id: "a" }] } });
  const parked = await first.advance(runId);
  assert.equal(parked.status, "awaiting_gate", "the run must EXECUTE and park for this arm to mean anything");

  // A restart handed the run's OWN identity with the bound bent.
  const bent = JSON.parse(JSON.stringify(good.graph)) as RunGraph;
  (bent.spec.edges.find((x) => x.id === "lp") as unknown as Record<string, unknown>)["maxIterations"] = {};
  (bent as unknown as Record<string, unknown>)["graphHash"] = good.graph.graphHash;

  const second = engineOn(store);
  second.attach(runId, bent);
  for (const attempt of ["first", "second"]) {
    await assert.rejects(
      () => second.advance(runId),
      (err: unknown) => {
        assert.ok(isLoomError(err));
        assert.equal(err.code, CODES.E_GRAPH_INVALID, attempt);
        return true;
      },
      attempt,
    );
  }

  // NO TERMINAL ROW, and the live run is intact.
  const types = await typesOf(store, runId);
  assert.equal(types.filter((t) => t === "run.failed").length, 0, "a live parked run must not be failed");
  assert.equal(types.at(-1), "run.suspended");

  // And the honest graph still advances it — the refusal was about the graph in hand, not the run.
  const third = engineOn(store);
  third.attach(runId, good.graph);
  assert.equal((await third.advance(runId)).status, "awaiting_gate");
});

test("the guard is scoped to `loop`: an unreadable maxIterations on another kind is not read", async () => {
  // `#loopMayContinue` is reached only under `e.kind === "loop"` (both entrances — the `switch`
  // arm and the router's `take` filter), so no other kind has a reader for the field, and refusing
  // a run over a field nothing reads would be a guard inventing its own scope.
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = engineOn(store);
  const g = JSON.parse(JSON.stringify(compiled())) as RunGraph;
  const e1 = g.spec.edges.find((e) => e.id === "e1") as unknown as Record<string, unknown>;
  e1["maxIterations"] = {};
  const runId = await engine.submit({ graph: g, inputs: {} });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded");
  assert.deepEqual(p.channels["n"], ["s", "x", "x", "x", "x", "x", "x"]);
});
