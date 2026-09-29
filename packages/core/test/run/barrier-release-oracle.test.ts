/**
 * A SEEDED, BOUNDED SLICE OF LANE K'S BARRIER ORACLE — why it exists: §A.101's fix moved every join
 * release to one asker (`#releaseSettledBarriers`, between waves, from the projection after every
 * commit), and each of the three designs before it passed the hand-written shapes and failed on a
 * graph nobody had drawn: a stranded barrier, an outer barrier of a nested fan-out released early,
 * a barrier downstream of an unreleased one released early. The full oracle (3,000 graphs × 8
 * runs) lives outside the suite; this is a fixed handful of its seeds, so a regression in the
 * release rule has something random to trip on in `npm test`.
 *
 * Random static graphs of `function` nodes over `seq` and `conditional` edges with fan-in, one to
 * four join barriers (`all`, `any`, `quorum`), chained through their successors; each run at
 * maxParallelism 1, 2 and 4, with no failures and with a fixed failure set. Per run:
 *
 *   I1  no Task commits more than once;
 *   I2  a barrier releases at most once, and no member becomes ready or commits after the release
 *       while the mode's requirement was unmet at release;
 *   I3  no barrier releases without a member Task;
 *   I4  a succeeded run leaves no barrier with a committed member unreleased — EXCEPT a join one of
 *       whose members has a non-join edge to another of its members, which never releases even
 *       unfixed (a pre-existing unit mismatch in `#joinArrivals`, on its own row: `TODO.md` §A.140);
 *   I5  succeeded runs of one variant commit the same (task, state) set at every width.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Join {
  readonly id: string;
  readonly branches: readonly string[];
  readonly mode: string;
  readonly k?: number;
}

interface Edge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: string;
  readonly when?: string;
  readonly branches?: readonly string[];
}

const fn = (id: string): Record<string, unknown> => ({ id, type: "function", reads: ["seed"], writes: ["log"], function: { ref: `function/${id}@stable` } });

function gen(seed: number): { spec: GraphSpec; edges: Edge[]; joins: Join[]; fnNodes: string[]; r: () => number } {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const nodes: Record<string, unknown>[] = [fn("start")];
  const edges: Edge[] = [];
  const order = ["start"];
  const fnNodes = ["start"];
  const memberOf = new Set<string>();
  const joins: Join[] = [];
  let e = 0;
  let f = 0;
  let jn = 0;
  const slots = 8 + Math.floor(r() * 8);
  for (let s = 0; s < slots; s++) {
    const candidates = fnNodes.filter((x) => x !== "start" && !memberOf.has(x));
    if (s > 2 && jn < 4 && r() < 0.35 && candidates.length >= 1) {
      const id = `J${jn++}`;
      const width = 1 + Math.floor(r() * Math.min(3, candidates.length));
      const branches: string[] = [];
      while (branches.length < width) {
        const c = pick(candidates);
        if (!branches.includes(c)) branches.push(c);
      }
      const mode = pick(["all", "all", "any", "quorum"]);
      const quorum = mode === "quorum" ? { k: Math.min(2, branches.length) } : {};
      nodes.push({ id, type: "join", reads: ["log", "seed"], writes: ["log"], join: { branches, mode, onBranchError: "skip", ...quorum } });
      for (const b of branches) {
        memberOf.add(b);
        edges.push({ id: `e${e++}`, from: b, to: id, kind: "join", branches });
      }
      joins.push({ id, branches, mode, ...quorum });
      order.push(id);
    } else {
      const id = `f${f++}`;
      nodes.push(fn(id));
      const sources = order.filter((x) => !memberOf.has(x));
      const inbound = 1 + (r() < 0.3 ? 1 : 0);
      const used = new Set<string>();
      for (let i = 0; i < inbound && sources.length > 0; i++) {
        const from = pick(sources);
        if (used.has(from)) continue;
        used.add(from);
        const kind = r() < 0.15 ? "conditional" : "seq";
        edges.push({ id: `e${e++}`, from, to: id, kind, ...(kind === "conditional" ? { when: r() < 0.5 ? 'seed == "never"' : 'seed == "x"' } : {}) });
      }
      if (used.size === 0) edges.push({ id: `e${e++}`, from: "start", to: id, kind: "seq" });
      order.push(id);
      fnNodes.push(id);
    }
  }
  const spec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "barrier-oracle", project: "probe", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 8, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, log: { type: "array", reduce: "append_ordered" } },
    inputs: ["seed"],
    outputs: ["log"],
    nodes,
    edges,
  } as unknown as GraphSpec;
  return { spec, edges, joins, fnNodes, r };
}

async function drive(graph: unknown, fnNodes: readonly string[], fails: ReadonlySet<string>, par: number) {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  for (const id of fnNodes) {
    functions.register(`function/${id}@stable`, () => {
      if (fails.has(id)) throw new Error(`${id} fails`);
      return { writes: { log: [id] } };
    });
  }
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    maxParallelism: par,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
  const runId = await engine.submit({ graph: graph as never, inputs: { seed: "x" } });
  let p = await engine.advance(runId);
  for (let i = 0; i < 20 && p.status === "running"; i++) p = await engine.advance(runId);
  const j: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) j.push(ev);
  return { p, j };
}

// The first 200 seeds and nothing else, bounded at a few seconds. Measured: it fails on the pre-§A.101
// engine (double commits) and passes on this one. It does NOT reach the chained-barrier release the
// fourth reviewer found (their seed 346 is a different generator's); `rearrival-runs-once.test.ts`
// section 11 pins that shape directly.
const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

const node = (taskId: unknown): string => String(taskId).slice(0, String(taskId).indexOf("@"));

test(`the barrier release rule holds on ${SEEDS.length} seeded random graphs with one to four joins`, async () => {
  const violations: string[] = [];
  let runs = 0;
  for (const seed of SEEDS) {
    const { spec, edges, joins, fnNodes, r } = gen(seed);
    if (joins.length === 0) continue;
    const compiled = compile({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
    if (!compiled.ok || compiled.diagnostics.some((d) => d.severity === "error")) continue;
    const graph = compiled.graph;
    for (const variant of [0, 1]) {
      const fails = new Set(variant === 0 ? [] : fnNodes.filter((x) => x !== "start" && r() < 0.2));
      let reference: string | undefined;
      for (const par of [1, 2, 4]) {
        runs++;
        const { p, j } = await drive(graph, fnNodes, fails, par);
        const tag = `seed ${seed} variant ${variant} par ${par}`;
        const commits = j.filter((ev) => ev.type === "task.committed");
        const perTask = new Map<string, number>();
        for (const ev of commits) perTask.set(String(ev.taskId), (perTask.get(String(ev.taskId)) ?? 0) + 1);
        for (const [t, k] of perTask) if (k > 1) violations.push(`I1 ${tag}: ${t} committed ${k}x`);
        for (const J of joins) {
          const readies = j.filter((ev) => ev.type === "task.ready" && node(ev.taskId) === J.id);
          if (readies.length > 1) violations.push(`I2 ${tag}: ${J.id} released ${readies.length}x`);
          const memberCommitted = commits.some((ev) => J.branches.includes(node(ev.taskId)));
          const chained = edges.some((x) => x.kind !== "join" && J.branches.includes(x.from) && J.branches.includes(x.to));
          if (readies.length === 0) {
            if (p.status === "succeeded" && memberCommitted && !chained) violations.push(`I4 ${tag}: ${J.id} stranded`);
            continue;
          }
          const ready = readies[0]!;
          if (!j.some((ev) => ev.seq < ready.seq && ev.type === "task.ready" && J.branches.includes(node(ev.taskId)))) {
            violations.push(`I3 ${tag}: ${J.id} released with no member`);
          }
          const before = commits.filter(
            (ev) => ev.seq < ready.seq && J.branches.includes(node(ev.taskId)) && (ev.payload as { status?: string }).status === "succeeded",
          ).length;
          const need = J.mode === "all" ? Infinity : J.mode === "any" ? 1 : (J.k ?? 1);
          const late = j.filter(
            (ev) => (ev.type === "task.committed" || ev.type === "task.ready") && ev.seq > ready.seq && J.branches.includes(node(ev.taskId)),
          );
          if (late.length > 0 && before < need) violations.push(`I2 ${tag}: ${J.id}(${J.mode}) released before ${late.map((x) => x.taskId).join(",")}`);
        }
        if (p.status !== "succeeded") continue;
        const signature = [...perTask.keys()].sort().map((t) => `${t}=${p.tasks[t as never]?.state}`).join(" ");
        if (reference === undefined) reference = signature;
        else if (signature !== reference) violations.push(`I5 ${tag}: ${signature} vs ${reference}`);
      }
    }
  }
  assert.ok(runs > 100, `the slice ran too little to mean anything: ${runs} runs`);
  assert.deepEqual(violations, []);
});
