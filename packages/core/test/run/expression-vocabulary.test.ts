/**
 * AN EXPRESSION THE EXECUTOR CANNOT PARSE IS REFUSED AT THE DOOR, NOT MID-COMMIT. (§A.85.)
 *
 * `#expr` has three call sites — a `conditional` edge's `when` (`#edgesToTake`), a `loop` edge's
 * `until` (`#loopMayContinue`) and a router case's `when` (`#runRouter`) — and all three run INSIDE
 * `#commit`, after the node's work is done. The compiler refuses a bad expression (GRAPH004_EXPR),
 * so this is reachable only through a `RunGraph` that did not come from this build's compiler, which
 * is exactly what `submit` and `attach` accept. Measured on `2af9716a` by the row's own probe, a
 * compiled loop graph with one field bent:
 *
 *     conditional when: [null]
 *       1st advance: THREW E_EXPR_INVALID: expression must be a string, got an array
 *       2nd advance: status=running
 *       terminal rows: run.failed=0 | last row: effect.completed
 *     loop until: [null]            (identical, line for line)
 *
 * — work committed, a run nobody can tell from a live one, and a second `advance` that answers
 * `running` rather than naming the fault. `#assertBound`'s fourth vocabulary check moves the refusal
 * to the door, where `#failUnreadableGraph` journals it like the other three; the census row lives in
 * `advance-refusal-is-journaled.test.ts`. This file holds the row's exact shape and the two halves a
 * census cannot: the ORDINARY half (every compiled graph still runs) and the SCOPE (a field no reader
 * reaches is not refused — the loop bound's rule, "refusing a run over a field nothing reads would be
 * a guard inventing its own scope").
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/** The row's probe graph: `seed -> step (loop until) -> done (conditional when)`. */
function loopSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "expr-vocab-loop", project: "a85", version: 1 },
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

/** `seed -> R (router) -> hi | lo`, where the router's conditionals carry no `when` of their own. */
function routerSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "expr-vocab-router", project: "a85", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { n: { type: "array", reduce: "append_ordered" } },
    inputs: [],
    outputs: [],
    nodes: [
      { id: "seed", type: "function", reads: [], writes: ["n"], function: { ref: "function/seed@stable" } },
      { id: "R", type: "router", reads: ["n"], router: { mode: "expression", fallbackEdge: "to-lo", cases: [{ when: "len(n) >= 1", take: ["to-hi"] }] } },
      { id: "hi", type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/hi@stable" } },
      { id: "lo", type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/lo@stable" } },
    ],
    edges: [
      { id: "s", from: "seed", to: "R", kind: "seq" },
      { id: "to-hi", from: "R", to: "hi", kind: "conditional" },
      { id: "to-lo", from: "R", to: "lo", kind: "conditional" },
    ],
  } as unknown as GraphSpec;
}

function engineOn(store: MemoryStateStore): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({ writes: { n: ["s"] } }));
  functions.register("function/step@stable", () => ({ writes: { n: ["x"] } }));
  functions.register("function/done@stable", () => ({ writes: {} }));
  functions.register("function/hi@stable", () => ({ writes: { n: ["hi"] } }));
  functions.register("function/lo@stable", () => ({ writes: { n: ["lo"] } }));
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

const compiled = (s: GraphSpec): RunGraph => compileOrThrow({ spec: s, resolver: resolver(), tools: {}, tenantCapabilities: [] });

/** A deep copy of a compiled graph with ONE field bent — the `RunGraph` a caller can hand `submit`. */
function bent(g: RunGraph, bend: (spec: { edges: Record<string, unknown>[]; nodes: Record<string, unknown>[] }) => void): RunGraph {
  const copy = JSON.parse(JSON.stringify(g)) as RunGraph;
  bend(copy.spec as unknown as { edges: Record<string, unknown>[]; nodes: Record<string, unknown>[] });
  return copy;
}

async function rows(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as never)) out.push(ev);
  return out;
}

const edge = (spec: { edges: Record<string, unknown>[] }, id: string): Record<string, unknown> => spec.edges.find((x) => x["id"] === id)!;

test("THE ROW'S REPRO: an unparseable when/until fails the run at the door, before anything executes", async () => {
  // The row measured `[null]`; `{}` and `42` are the other non-strings its text names, and the two
  // strings are ones `parseExpr` rejects — the check is "parses", not "is a string".
  const VALUES: readonly unknown[] = [[null], {}, 42, "len(n) >=", "len(n) >= 5 )"];
  for (const value of VALUES) {
    for (const [field, id] of [
      ["when", "e3"],
      ["until", "e2"],
    ] as const) {
      const where = `${field}: ${JSON.stringify(value)}`;
      const store = new MemoryStateStore({ now: () => NOW });
      const engine = engineOn(store);
      const runId = await engine.submit({ graph: bent(compiled(loopSpec()), (s) => void (edge(s, id)[field] = value)), inputs: {} });

      await assert.rejects(
        () => engine.advance(runId),
        (e: { code?: unknown; details?: { edges?: { id: string; field: string }[] } }) => {
          assert.equal(e.code, "E_GRAPH_INVALID", `${where}: refused at the door, not E_EXPR_INVALID from inside #commit`);
          assert.deepEqual(e.details?.edges?.map((x) => [x.id, x.field]), [[id, field]], `${where}: naming the edge and the field`);
          return true;
        },
      );
      const log = await rows(store, runId);
      assert.equal(log.some((ev) => ev.type === "task.leased"), false, `${where}: nothing executed — the base leased, ran and committed first`);
      assert.equal(log.filter((ev) => ev.type === "run.failed").length, 1, `${where}: and the run is terminal, with a row saying why`);
      assert.equal((await engine.projection(runId))?.status, "failed", `${where}: not \`running\``);
      await assert.rejects(() => engine.advance(runId), (e: { code?: unknown }) => e.code === "E_GRAPH_INVALID", `${where}: a second advance still names the fault`);
      assert.equal((await rows(store, runId)).filter((ev) => ev.type === "run.failed").length, 1, `${where}: and appends no second row`);
    }
  }
});

test("A ROUTER CASE WHOSE when CANNOT BE PARSED — or a router with no readable cases — is refused the same way", async () => {
  const BENDS: readonly [string, (s: { nodes: Record<string, unknown>[] }) => void, string][] = [
    ["case when [null]", (s) => void ((s.nodes.find((x) => x["id"] === "R")!["router"] as { cases: { when: unknown }[] }).cases[0]!.when = [null]), "router.cases[0].when"],
    ["case when absent", (s) => void delete (s.nodes.find((x) => x["id"] === "R")!["router"] as { cases: { when?: unknown }[] }).cases[0]!.when, "router.cases[0].when"],
    ["case not an object", (s) => void ((s.nodes.find((x) => x["id"] === "R")!["router"] as { cases: unknown[] }).cases[0] = "len(n) >= 1"), "router.cases[0].when"],
    ["cases not an array", (s) => void ((s.nodes.find((x) => x["id"] === "R")!["router"] as { cases: unknown }).cases = {}), "router.cases"],
  ];
  for (const [what, bend, field] of BENDS) {
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = engineOn(store);
    const runId = await engine.submit({ graph: bent(compiled(routerSpec()), bend), inputs: {} });
    await assert.rejects(
      () => engine.advance(runId),
      (e: { code?: unknown; details?: { nodes?: { id: string; field: string }[] } }) => {
        assert.equal(e.code, "E_GRAPH_INVALID", `${what}: refused at the door`);
        assert.deepEqual(e.details?.nodes?.map((x) => [x.id, x.field]), [["R", field]], `${what}: naming the NODE and the field`);
        return true;
      },
    );
    assert.equal((await engine.projection(runId))?.status, "failed", `${what}: terminal, with the row`);
  }
});

test("THE ORDINARY HALF: every compiled graph still runs — the check refuses nothing the compiler accepted", async () => {
  // Both readers' graphs, unbent, to their ends, and the router takes its case. The expressions are
  // parsed by the check and served to the readers from the same cache. The loop's `n` is the value
  // `#assertBound`'s §A.81 paragraph measured for this exact graph at `be29cb43`
  // (`maxIterations=6  advance=status=succeeded n=["s","x","x","x","x","x","x"]`) — the same run,
  // so the new check changed nothing about how a readable loop goes.
  const loopStore = new MemoryStateStore({ now: () => NOW });
  const loopEngine = engineOn(loopStore);
  const loopRun = await loopEngine.submit({ graph: compiled(loopSpec()), inputs: {} });
  const looped = await loopEngine.advance(loopRun);
  assert.equal(looped.status, "succeeded", JSON.stringify(looped.error ?? {}));
  assert.deepEqual(looped.channels["n"], ["s", "x", "x", "x", "x", "x", "x"], "the loop ran exactly as it did before the check");

  const routerStore = new MemoryStateStore({ now: () => NOW });
  const routerEngine = engineOn(routerStore);
  const routed = await routerEngine.advance(await routerEngine.submit({ graph: compiled(routerSpec()), inputs: {} }));
  assert.equal(routed.status, "succeeded", JSON.stringify(routed.error ?? {}));
  assert.deepEqual(routed.channels["n"], ["s", "hi"], "the router took its case");
});

test("SCOPED TO THE READER: a when or until nothing evaluates is not refused", async () => {
  // Each of these is a field `#expr` never reaches, bent to a value it could not parse, and each run
  // must go on exactly as the unbent one does. A `when` on a conditional LEAVING a router is skipped
  // by `#edgesToTake` (the router's `take` already chose); a `when` on a `seq` and an `until` on a
  // non-loop edge have no reader at all.
  const loopCases: readonly [string, (s: { edges: Record<string, unknown>[] }) => void][] = [
    ["a when on a seq edge", (s) => void (edge(s, "e1")["when"] = [null])],
    ["an until on a conditional edge", (s) => void (edge(s, "e3")["until"] = {})],
  ];
  for (const [what, bend] of loopCases) {
    const store = new MemoryStateStore({ now: () => NOW });
    const engine = engineOn(store);
    const p = await engine.advance(await engine.submit({ graph: bent(compiled(loopSpec()), bend), inputs: {} }));
    assert.equal(p.status, "succeeded", `${what}: ${JSON.stringify(p.error ?? {})}`);
  }
  const store = new MemoryStateStore({ now: () => NOW });
  const engine = engineOn(store);
  const g = bent(compiled(routerSpec()), (s) => void (edge(s, "to-hi")["when"] = [null]));
  const p = await engine.advance(await engine.submit({ graph: g, inputs: {} }));
  assert.equal(p.status, "succeeded", `a when on a router's own conditional: ${JSON.stringify(p.error ?? {})}`);
  assert.deepEqual(p.channels["n"], ["s", "hi"], "and the router's case still chose the edge");
});
