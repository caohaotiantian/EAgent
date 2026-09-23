/**
 * GRAPH005_ERROR_PROJECTION_IN_LOOP keyed on MULTIPLICITY, not on reachability from a cycle (§A.95).
 *
 * The runtime serves `"<id>:error"` from the source's Task on the reader's branch, highest iteration
 * first — right only when the source has ONE Task per branch. The refusal covered every node on or
 * reachable from a cycle (`c153566e`), which refused sources that run once. `multiRunNodes` now
 * answers the question itself; these tests hold it to RUNS, not to its docstring:
 *
 *  - the ones it lets through run once, driven with bodies that fail and succeed on purpose;
 *  - the ones it still refuses really do run more than once — five conditions of a once-exit are
 *    each shown necessary by a graph that breaks only that one and runs the exit's target more
 *    than once (each goes green-to-red when its condition is deleted from `multiRunNodes`); the
 *    barrier condition is pinned as CONSERVATIVE, with the run that shows it;
 *  - the row's own repro, a `conditional` exit, is one of those: a body's `take` bypasses `when`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HookRegistry } from "../../src/run/hooks.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { stubResolver } from "./fixtures.ts";

// ── a graph of `function` nodes, and a way to run it with scripted bodies ─────

type Body = (view: { get(c: string): unknown }, call: number) => unknown;
type Edge = { id: string; from: string; to: string; kind: string; when?: string; until?: string; maxIterations?: number };

/** Every node reads and writes its own channel `w_<id>`; a loop source also its stop channel `stop_<id>`. */
function graph(ids: readonly string[], edges: readonly Edge[], extra: readonly Record<string, unknown>[] = []): GraphSpec {
  const channels: Record<string, unknown> = { out: { type: "object", reduce: "replace" } };
  const loopSources = new Set(edges.filter((e) => e.kind === "loop").map((e) => e.from));
  for (const id of ids) channels[`w_${id}`] = { type: "number", reduce: "replace" };
  for (const id of loopSources) channels[`stop_${id}`] = { type: "boolean", reduce: "replace" };
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "multiplicity", project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 3 } },
    channels,
    inputs: [],
    outputs: [`w_${ids[0]!}`],
    nodes: [
      ...ids.map((id) => ({
        id,
        type: "function",
        reads: [`w_${id}`, ...(loopSources.has(id) ? [`stop_${id}`] : [])],
        writes: [`w_${id}`, ...(loopSources.has(id) ? [`stop_${id}`] : [])],
        function: { ref: `function/${id}@stable` },
      })),
      ...extra,
    ],
    edges,
  } as unknown as GraphSpec;
}

const LOOP = (from: string, to: string): Edge => ({ id: `loop-${from}`, from, to, kind: "loop", until: `stop_${from} == true`, maxIterations: 3 });
/** A reader of `<source>:error`, hung off the source's own `error` edge. */
const reader = (source: string): { node: Record<string, unknown>; edge: Edge } => ({
  node: { id: `read-${source}`, type: "function", reads: [`${source}:error`], writes: ["out"], function: { ref: "function/read@stable" } },
  edge: { id: `to-read-${source}`, from: source, to: `read-${source}`, kind: "error" },
});

function inLoop(ids: readonly string[], edges: readonly Edge[], source: string): boolean {
  const r = reader(source);
  const res = compile({ spec: graph(ids, [...edges, r.edge], [r.node]), resolver: stubResolver(), tools: {}, tenantCapabilities: [] });
  return res.diagnostics.some((d) => d.code === "GRAPH005_ERROR_PROJECTION_IN_LOOP" && d.at?.nodeId === `read-${source}`);
}

const FAIL = { refuse: { reason: "on purpose" } };
const ok = (writes: Record<string, unknown> = {}): unknown => ({ writes });

/** Runs the graph with these bodies (default: succeed, and a loop source never settles). */
async function run(spec: GraphSpec, bodies: Readonly<Record<string, Body>>): Promise<{ status: string; tasks: Record<string, number>; out: unknown }> {
  const functions = new FunctionRegistry();
  const calls = new Map<string, number>();
  for (const n of spec.nodes) {
    const ref = n.function?.ref;
    if (ref === undefined) continue;
    functions.register(ref, ((view: { get(c: string): unknown }) => {
      const call = calls.get(n.id) ?? 0;
      calls.set(n.id, call + 1);
      const body = bodies[n.id];
      if (body !== undefined) return body(view, call);
      return (n.writes ?? []).includes(`stop_${n.id}`) ? ok({ [`stop_${n.id}`]: false }) : ok();
    }) as never);
  }
  const store = new MemoryStateStore({ now: () => 0 });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    hooks: new HookRegistry(),
    now: () => 0,
    sleep: async () => {},
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const runId = await engine.submit({ graph: compileOrThrow({ spec, resolver: stubResolver(), tools: {}, tenantCapabilities: [] }), inputs: {} });
  let p = await engine.advance(runId);
  for (let i = 0; i < 100 && p.status === "running"; i++) p = await engine.advance(runId);
  const tasks: Record<string, number> = {};
  for (const t of Object.values(p.tasks)) tasks[t.nodeId] = (tasks[t.nodeId] ?? 0) + 1;
  return { status: p.status, tasks, out: p.channels["out"] };
}

// ── the shape it lets through ────────────────────────────────────────────────

// audit -> fix -loop-> audit, and audit's FAILURE leaves the loop for `r`.
const BODY = ["audit", "fix", "r"];
const BODY_EDGES: readonly Edge[] = [
  { id: "repair", from: "audit", to: "fix", kind: "seq" },
  LOOP("fix", "audit"),
  { id: "gave-up", from: "audit", to: "r", kind: "error" },
];

test("AN ERROR EXIT is let through: the failure that leaves the loop is the failure that ends it", async () => {
  assert.equal(inLoop(BODY, BODY_EDGES, "r"), false, "r is reached only through audit's failure");
  // …and so is everything after it, by any edge kind: a `seq` successor carries r's class.
  assert.equal(inLoop([...BODY, "r2"], [...BODY_EDGES, { id: "next", from: "r", to: "r2", kind: "seq" }], "r2"), false);
  // Both ends of the body: the loop's TARGET failing, and its SOURCE failing.
  assert.equal(inLoop(BODY, [BODY_EDGES[0]!, BODY_EDGES[1]!, { id: "gave-up", from: "fix", to: "r", kind: "error" }], "r"), false);
  // The cycle's own members stay refused, whatever the exit is.
  assert.equal(inLoop(BODY, BODY_EDGES, "audit"), true);
  assert.equal(inLoop(BODY, BODY_EDGES, "fix"), true);
});

test("…and RUNS once: audit succeeds on pass 0, fails on pass 1, and the reader is handed THAT failure", async () => {
  const r = reader("r");
  const spec = graph(BODY, [...BODY_EDGES, r.edge], [r.node]);
  const res = await run(spec, {
    audit: (_v, call) => (call === 0 ? ok() : FAIL),
    r: () => FAIL,
    "read-r": (v) => ok({ out: v.get("r:error") as Record<string, unknown> }),
  });
  assert.equal(res.tasks["audit"], 2, JSON.stringify(res.tasks));
  assert.equal(res.tasks["r"], 1, "one Task of the exit's target");
  assert.equal(res.tasks["read-r"], 1);
  assert.deepEqual(res.out, { ok: false, code: "E_FUNCTION_REFUSED", message: 'function "function/r@stable" on node "r" refused: on purpose' });
});

test("TWO error exits of ONE loop into one node share a class — both can only fire in the last pass", () => {
  const edges: Edge[] = [...BODY_EDGES, { id: "fix-gave-up", from: "fix", to: "r", kind: "error" }];
  assert.equal(inLoop(BODY, edges, "r"), false);
});

// ── the shapes it still refuses, each shown to RUN more than once ────────────

test("THE ROW'S REPRO STAYS REFUSED: a `conditional` exit runs once per pass under a body's `take`", async () => {
  // `when`s that are exact complements — and `#edgesToTake` does not evaluate `when` when the body
  // returns `take`, which a `function`/`evaluator` body, a gate redirect and a `steer` all can.
  const edges: Edge[] = [
    { id: "repair", from: "audit", to: "fix", kind: "conditional", when: "w_audit == 0" },
    LOOP("fix", "audit"),
    { id: "done", from: "audit", to: "r", kind: "conditional", when: "w_audit == 1" },
  ];
  assert.equal(inLoop(BODY, edges, "r"), true);
  const res = await run(graph(BODY, edges), { audit: () => ({ writes: { w_audit: 0 }, take: ["repair", "done"] }) });
  assert.equal(res.tasks["r"], 3, `the exit's target ran on every pass: ${JSON.stringify(res.tasks)}`);
  // The control: without the `take`, the complement holds and it runs once. It is the `take`, and
  // nothing the compiler can see, that decides.
  const plain = await run(graph(BODY, edges), { audit: (_v, call) => ok({ w_audit: call < 2 ? 0 : 1 }) });
  assert.equal(plain.tasks["r"], 1, JSON.stringify(plain.tasks));
});

test("c153566e's HOLE STAYS CLOSED: a node hanging off the body by `seq` runs once per pass", async () => {
  const edges: Edge[] = [BODY_EDGES[0]!, BODY_EDGES[1]!, { id: "off", from: "fix", to: "r", kind: "seq" }];
  assert.equal(inLoop(BODY, edges, "r"), true);
  assert.equal((await run(graph(BODY, edges), {})).tasks["r"], 3);
});

test("NECESSARY: an `error` edge from the exiting node back toward the loop's source continues the loop", async () => {
  // audit's failure takes BOTH of its error edges — the exit and one straight into `fix`.
  const edges: Edge[] = [...BODY_EDGES, { id: "retry-anyway", from: "audit", to: "fix", kind: "error" }];
  assert.equal(inLoop(BODY, edges, "r"), true);
  assert.equal((await run(graph(BODY, edges), { audit: () => FAIL })).tasks["r"], 3);
});

test("NECESSARY: a path to the loop's source that bypasses the exiting node carries the pass on", async () => {
  const ids = ["head", "audit", "fix", "r"];
  const edges: Edge[] = [
    { id: "a", from: "head", to: "audit", kind: "seq" },
    { id: "bypass", from: "head", to: "fix", kind: "seq" },
    { id: "b", from: "audit", to: "fix", kind: "seq" },
    LOOP("fix", "head"),
    { id: "gave-up", from: "audit", to: "r", kind: "error" },
  ];
  assert.equal(inLoop(ids, edges, "r"), true);
  assert.equal((await run(graph(ids, edges), { audit: () => FAIL })).tasks["r"], 3);
});

test("NECESSARY: a loop ENTERED once per pass of another loop runs its last pass once per entry", async () => {
  // Loop 1 (a <-> b) hands off to loop 2 (h2 <-> x2) by `seq` on every pass; x2's failure exits.
  const ids = ["a", "b", "h2", "x2", "r"];
  const edges: Edge[] = [
    { id: "ab", from: "a", to: "b", kind: "seq" },
    LOOP("b", "a"),
    { id: "enter", from: "b", to: "h2", kind: "seq" },
    { id: "h2x2", from: "h2", to: "x2", kind: "seq" },
    LOOP("x2", "h2"),
    { id: "gave-up", from: "x2", to: "r", kind: "error" },
  ];
  assert.equal(inLoop(ids, edges, "r"), true);
  const res = await run(graph(ids, edges), { x2: () => FAIL });
  assert.ok((res.tasks["r"] ?? 0) > 1, `r ran ${String(res.tasks["r"])} times: ${JSON.stringify(res.tasks)}`);
});

test("NECESSARY: a node on TWO loops' cycles — its failure ends one loop and drives the other", async () => {
  // `h` heads two loops. For `s2 -> h` every condition holds on its own; but `h`'s failure also
  // takes `h -> s1`, and `s1 -> h` is the other loop's back-edge — one iteration counter, so the
  // failure that "exits" loop 2 starts the next pass. (The random-graph oracle found this shape.)
  const ids = ["h", "s1", "s2", "r"];
  const edges: Edge[] = [
    { id: "on-failure", from: "h", to: "s1", kind: "error" },
    LOOP("s1", "h"),
    { id: "on-success", from: "h", to: "s2", kind: "seq" },
    LOOP("s2", "h"),
    { id: "gave-up", from: "h", to: "r", kind: "error" },
  ];
  assert.equal(inLoop(ids, edges, "r"), true);
  assert.equal((await run(graph(ids, edges), { h: () => FAIL })).tasks["r"], 3);
});

test("MIXED CLASSES join to `top`: a node reached by a once-exit AND from before the loop runs at #0 and #k", async () => {
  const ids = ["start", ...BODY];
  const edges: Edge[] = [
    { id: "go", from: "start", to: "audit", kind: "seq" },
    ...BODY_EDGES,
    { id: "early", from: "start", to: "r", kind: "seq" },
  ];
  assert.equal(inLoop(ids, edges, "r"), true);
  const res = await run(graph(ids, edges), { audit: (_v, call) => (call < 2 ? ok() : FAIL) });
  assert.equal(res.tasks["r"], 2, `r#0 from start, r#2 from the exit: ${JSON.stringify(res.tasks)}`);
});

test("CONSERVATIVE, NOT SHOWN NECESSARY: a barrier inside the body keeps the exit refused", async () => {
  // `m` dominates the loop's source and its failure leaves by `m -> r`, but `m -join-> J` fires on
  // TERMINATION, failures included. Driven, this shape does NOT re-enter: a member whose failure
  // took an `error` edge is not absorbed as `skip`, so `J` fails the run and `r` runs once. The
  // condition stays because the argument for a once-exit is about what `X`'s failure ACTIVATES,
  // and a join edge is activated by it — so this pins the refusal, and the run below pins that the
  // refusal is conservative today rather than claiming it is load-bearing.
  const spec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-in-loop", project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 3 } },
    channels: {
      seen: { type: "array", reduce: "append_ordered" },
      stop_S: { type: "boolean", reduce: "replace" },
      w_r: { type: "number", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
    },
    inputs: [],
    outputs: [],
    nodes: [
      { id: "H", type: "function", reads: [], writes: [], function: { ref: "function/H@stable" } },
      { id: "m", type: "function", reads: [], writes: ["seen"], function: { ref: "function/m@stable" } },
      { id: "J", type: "join", reads: ["seen"], writes: ["seen"], join: { branches: ["m"], mode: "all", onBranchError: "skip" } },
      { id: "S", type: "function", reads: ["stop_S"], writes: ["stop_S"], function: { ref: "function/S@stable" } },
      { id: "r", type: "function", reads: [], writes: ["w_r"], function: { ref: "function/r@stable" } },
    ],
    edges: [
      { id: "hm", from: "H", to: "m", kind: "seq" },
      { id: "in", from: "m", to: "J", kind: "join", branches: ["m"] },
      { id: "js", from: "J", to: "S", kind: "seq" },
      LOOP("S", "H"),
      { id: "gave-up", from: "m", to: "r", kind: "error" },
    ],
  } as unknown as GraphSpec;
  const withReader = {
    ...spec,
    nodes: [...spec.nodes, { id: "read-r", type: "function", reads: ["r:error"], writes: ["out"], function: { ref: "function/read@stable" } }],
    edges: [...spec.edges, { id: "to-read-r", from: "r", to: "read-r", kind: "error" }],
  } as unknown as GraphSpec;
  const refused = compile({ spec: withReader, resolver: stubResolver(), tools: {}, tenantCapabilities: [] }).diagnostics;
  assert.ok(refused.some((d) => d.code === "GRAPH005_ERROR_PROJECTION_IN_LOOP"), JSON.stringify(refused.map((d) => d.code)));
  const res = await run(spec, { m: () => FAIL });
  assert.deepEqual([res.status, res.tasks["r"]], ["failed", 1], JSON.stringify(res.tasks));
});
