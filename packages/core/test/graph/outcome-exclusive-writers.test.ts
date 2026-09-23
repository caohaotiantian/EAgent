/**
 * GRAPH010 no longer calls one node's SUCCESS arm and its FAILURE arm concurrent writers (§A.94).
 *
 * `examples/graphs/grant-access.json`'s `prior` (behind `read-ledger`'s `seq` edge) and
 * `first-grant` (behind its `error` edge) both write `history`. With `history: replace` the compiler
 * said they "can run concurrently" — a graph property it could not see, because `error` is on no
 * exclusion list and the pair is neither ordered nor on two router arms. A Task commits ONE outcome
 * and a failed one routes by `#errorEdges` alone, so the two never both run. The port shipped
 * `merge_object` + `onConflict: "last_by_branch"` as the workaround, a conflict arm that cannot fire.
 *
 * What is pinned: the row's repro compiles; the minimal shape compiles AND runs each way with one
 * writer only; and the shapes the exemption must not cover are still refused — the one that matters
 * most (the deciding node on a loop) shown to RUN both writers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { builtinTools } from "../../src/builtin/tools.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HookRegistry } from "../../src/run/hooks.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { stubResolver } from "./fixtures.ts";

type Edge = { id: string; from: string; to: string; kind: string; until?: string; maxIterations?: number; over?: string; as?: string; maxWidth?: number };

/** `function` nodes; `writers` also write the shared `replace` channel `h`. */
function graph(ids: readonly string[], writers: readonly string[], edges: readonly Edge[], extra: Record<string, unknown> = {}): GraphSpec {
  const channels: Record<string, unknown> = { h: { type: "string", reduce: "replace" }, stop: { type: "boolean", reduce: "replace" }, ...extra };
  const loopSources = new Set(edges.filter((e) => e.kind === "loop").map((e) => e.from));
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "outcome-exclusive", project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 3 } },
    channels,
    inputs: [],
    outputs: ["h"],
    nodes: ids.map((id) => ({
      id,
      type: "function",
      reads: loopSources.has(id) ? ["stop"] : [],
      writes: [...(writers.includes(id) ? ["h"] : []), ...(loopSources.has(id) ? ["stop"] : [])],
      function: { ref: `function/${id}@stable` },
    })),
    edges,
  } as unknown as GraphSpec;
}

function concurrent(spec: GraphSpec): string[] {
  return compile({ spec, resolver: stubResolver(), tools: {}, tenantCapabilities: [] })
    .diagnostics.filter((d) => d.code === "GRAPH010_CONCURRENT_WRITE")
    .map((d) => d.message);
}

async function run(spec: GraphSpec, fail: ReadonlySet<string> | ((id: string, call: number) => boolean)): Promise<{ ran: string[]; h: unknown }> {
  const functions = new FunctionRegistry();
  const calls = new Map<string, number>();
  for (const n of spec.nodes) {
    functions.register(n.function!.ref, (() => {
      const call = calls.get(n.id) ?? 0;
      calls.set(n.id, call + 1);
      const fails = typeof fail === "function" ? fail(n.id, call) : fail.has(n.id);
      if (fails) return { refuse: { reason: "on purpose" } };
      const writes: Record<string, unknown> = {};
      if ((n.writes ?? []).includes("h")) writes["h"] = n.id;
      if ((n.writes ?? []).includes("stop")) writes["stop"] = false;
      return { writes };
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
  const ran = Object.values(p.tasks).filter((t) => t.state === "succeeded" || t.state === "failed").map((t) => t.nodeId);
  return { ran: [...new Set(ran)].sort(), h: p.channels["h"] };
}

// X decides; `a` is its success arm, `b` its failure arm; both write `h`.
const IDS = ["X", "a", "b"];
const ARMS: readonly Edge[] = [
  { id: "ok", from: "X", to: "a", kind: "seq" },
  { id: "failed", from: "X", to: "b", kind: "error" },
];

test("THE ROW'S REPRO: grant-access with `history: replace` compiles — prior and first-grant are exclusive", () => {
  const path = fileURLToPath(new URL("../../../../examples/graphs/grant-access.json", import.meta.url));
  const shipped = JSON.parse(readFileSync(path, "utf8")) as GraphSpec & { channels: Record<string, unknown> };
  const tools = Object.fromEntries(builtinTools({ root: tmpdir(), deny: [] }).map((t) => [t.name, t]));
  const compileIt = (spec: GraphSpec) => compile({ spec, resolver: stubResolver(), tools, tenantCapabilities: ["*"] });
  const replaced = { ...shipped, channels: { ...shipped.channels, history: { type: "object", reduce: "replace" } } } as GraphSpec;
  assert.deepEqual(compileIt(replaced).diagnostics.map((d) => `${d.code}: ${d.message}`), []);
  // The shipped workaround still compiles too — this is a refusal dropped, not a shape changed.
  assert.deepEqual(compileIt(shipped).diagnostics.map((d) => d.code), []);
});

test("THE MINIMAL SHAPE compiles, and RUNS with exactly one writer either way", async () => {
  const spec = graph(IDS, ["a", "b"], ARMS);
  assert.deepEqual(concurrent(spec), []);
  assert.deepEqual(await run(spec, new Set()), { ran: ["X", "a"], h: "a" });
  assert.deepEqual(await run(spec, new Set(["X"])), { ran: ["X", "b"], h: "b" });
});

test("…further down each arm too: every path to one crosses a success arm, every path to the other the failure arm", () => {
  const spec = graph(
    ["X", "a0", "a", "b0", "b"],
    ["a", "b"],
    [
      { id: "ok", from: "X", to: "a0", kind: "seq" },
      { id: "a1", from: "a0", to: "a", kind: "seq" },
      { id: "failed", from: "X", to: "b0", kind: "error" },
      { id: "b1", from: "b0", to: "b", kind: "error" },
    ],
  );
  assert.deepEqual(concurrent(spec), []);
});

test("STILL REFUSED: a second way into the success-side writer that does not cross X's success arm", () => {
  const spec = graph(["S", ...IDS], ["a", "b"], [{ id: "go", from: "S", to: "X", kind: "seq" }, { id: "also", from: "S", to: "a", kind: "seq" }, ...ARMS]);
  assert.equal(concurrent(spec).length, 1, "S reaches a whatever X does");
});

test("STILL REFUSED, AND BOTH RUN: the deciding node on a loop decides once per pass", async () => {
  // X succeeds on pass 0 (a runs) and fails on pass 1 (b runs): one outcome per TASK is not one
  // outcome per node. `multiRunNodes` is what keeps X out of the exemption.
  const spec = graph(["X", "fix", "a", "b"], ["a", "b"], [
    ...ARMS,
    { id: "again", from: "X", to: "fix", kind: "seq" },
    { id: "loop", from: "fix", to: "X", kind: "loop", until: "stop == true", maxIterations: 3 },
  ]);
  assert.equal(concurrent(spec).length, 1, JSON.stringify(concurrent(spec)));
  // Run it with `h` made safe, to show the two writers really do both run.
  const safe = { ...spec, channels: { ...spec.channels, h: { type: "array", reduce: "append_ordered" } } } as GraphSpec;
  const res = await run(safe, (id, call) => id === "X" && call === 1);
  assert.deepEqual(res.ran, ["X", "a", "b", "fix"]);
});

test("STILL REFUSED, AND BOTH RUN: X reached by TWO edges fails on the first arrival and succeeds on the second", async () => {
  // A `task.ready` landing after X committed readies it AGAIN under the same Task id. Found by the
  // lane's seeded random-graph oracle against the runtime, on this rule's first cut, which asked
  // only that X run once per pass: `s -> X` beside `s -> m -> m1 -> m3 -> X`.
  const ids = ["s", "m", "m1", "m3", ...IDS];
  const edges: Edge[] = [
    { id: "sx", from: "s", to: "X", kind: "seq" },
    { id: "sm", from: "s", to: "m", kind: "seq" },
    { id: "mm1", from: "m", to: "m1", kind: "seq" },
    { id: "m1m3", from: "m1", to: "m3", kind: "seq" },
    { id: "m3x", from: "m3", to: "X", kind: "seq" },
    ...ARMS,
  ];
  assert.equal(concurrent(graph(ids, ["a", "b"], edges)).length, 1);
  const safe = graph(ids, ["a", "b"], edges, { h: { type: "array", reduce: "append_ordered" } });
  let xRuns = 0;
  const res = await run(safe, (id) => id === "X" && xRuns++ === 0);
  assert.deepEqual(res.ran, ["X", "a", "b", "m", "m1", "m3", "s"]);
  assert.deepEqual(res.h, ["b", "a"], "the failure arm, then the success arm");
});

test("STILL REFUSED: a join edge is in neither arm — a barrier fires on termination, failures included", () => {
  const spec = {
    ...graph(IDS, ["a", "b"], []),
    nodes: [
      ...graph(IDS, ["a", "b"], []).nodes,
      { id: "J", type: "join", reads: [], writes: [], join: { branches: ["X"], mode: "all", onBranchError: "skip" } },
    ],
    edges: [
      { id: "in", from: "X", to: "J", kind: "join", branches: ["X"] },
      { id: "after", from: "J", to: "a", kind: "seq" },
      { id: "failed", from: "X", to: "b", kind: "error" },
    ],
  } as unknown as GraphSpec;
  assert.equal(concurrent(spec).length, 1, JSON.stringify(concurrent(spec)));
});

test("PER COMPILE, NOT PER PAIR: 150 writers beside 150 error arms compiles well under the bound", () => {
  // The first cut ran two whole-graph searches per candidate X for EVERY writer pair: a reviewer
  // measured 80/80 at 5,965 ms and 150/150 at 71 s (base: 30 ms, 89 ms). Absolute bound, wide margin.
  const ids = ["r"];
  const writers: string[] = [];
  const edges: Edge[] = [];
  for (let i = 0; i < 150; i++) {
    ids.push(`x${i}`, `y${i}`, `w${i}`);
    writers.push(`w${i}`);
    edges.push(
      { id: `rx${i}`, from: "r", to: `x${i}`, kind: "seq" },
      { id: `xe${i}`, from: `x${i}`, to: `y${i}`, kind: "error" },
      { id: `rw${i}`, from: "r", to: `w${i}`, kind: "seq" },
    );
  }
  const spec = graph(ids, writers, edges);
  (spec.policy as unknown as { expansion: { maxNodes: number } }).expansion.maxNodes = 1000;
  const t0 = performance.now();
  const n = concurrent(spec).length;
  const ms = performance.now() - t0;
  assert.equal(n, (150 * 149) / 2, "every pair is still refused — none of them is exclusive");
  assert.ok(ms < 5000, `compile took ${ms.toFixed(0)} ms`);
});
