/**
 * A BARRIER'S TASK IS THE BARRIER'S TO MINT, whatever kind of edge arrives at it.
 *
 * `run/engine.ts`'s `#activate` has a generic arm that mints `task.ready` for `e.to` from the
 * EDGE ALONE — no node type, no `p.tasks` lookup, no barrier state. For a Task sitting at the
 * join's own parent coordinate the id that arm computes is byte-identical to the one
 * `#maybeFireJoin` computes, and `#maybeFireJoin` is the only path to a join Task that tests
 * quiescence. So an ordinary `seq` or `conditional` edge into a join node was a fourth entrance
 * to the barrier with no barrier test on it, and it did one of two things:
 *
 *   - it fired the barrier EARLY, before the branches had committed, and every contribution
 *     that had not landed yet was discarded; or
 *   - it arrived AFTER the barrier had already fired and minted its Task a SECOND time, so
 *     `#foldJoin` folded the same members twice and the node behind the join ran twice.
 *
 * Which one you got depended on `maxParallelism` and on the hop counts of the two paths.
 * **Every one of those runs reported `succeeded`**, and every one of those graphs compiled with
 * zero diagnostics — the arithmetic is invisible unless you read the channel.
 *
 * Measured on the unfixed engine, on `sweepSpec` below at width 4 (`node --test` on this file
 * against the pre-fix `#activate` reproduces each line):
 *
 *     par=16 bh=1 nh=3   seenLen=8 against a baseline of 4   joinCommit=2 doneCommit=2  DOUBLE
 *     par=16 bh=2 nh=1   seenLen=4 against a baseline of 8                              LOST
 *     par=16 bh=3 nh=1   seenLen=4 against a baseline of 12                             LOST
 *     par= 2 bh=1 nh=1   seenLen=3 against a baseline of 4                              LOST
 *     par=16 bh=* nh=0   seenLen=0 — the channel was never written at all                LOST
 *
 * THE WORST ROW IS THE SHORTEST GRAPH, which is why `nh: 0` (a DIRECT `start -seq-> J` beside
 * the fan-out) is in the sweep: at `par=16` the barrier fired before any branch had committed
 * and the join's channel was never written, and the run still reported success.
 *
 * The file is arranged as a sweep, a NESTED case (which fails differently — see its own note,
 * where the pre-fix run DIES rather than lying), and two controls. Two controls because the two
 * failure directions are opposite and a fix can trade one for the other. The BASELINE control is
 * the same graph with no `seq` edge into the join at all: the sweep asserts equality against it
 * rather than against a written-down number, so a "fix" that suppressed the barrier everywhere
 * would fail the baseline too. The EMPTY-FAN control is the trap named in the row —
 * `#fireEmptyJoin` must NOT be routed through `#maybeFireJoin`, because the planner's own `take`
 * still holds the `fanout` edge whose `to` is a declared member, so `handingOff` is true and
 * `quiescent` never becomes true; routed, a fan of width zero strands instead of releasing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;
const WIDTH = 4;
const ITEMS = ["a", "b", "c", "d"].map((id) => ({ id }));

/**
 * Two reducers, not one, and both COMMUTATIVE on purpose. `append_ordered` shows a double fold
 * as duplicate entries and `sum` shows it as arithmetic, so a fix that happened to make one
 * idempotent is still caught by the other. Commutative because `branchLocalChannel` and
 * `GRAPH010_CONCURRENT_WRITE` are then never consulted: this is a run-time defect and the graph
 * must compile clean for the test to be about the engine.
 */
const CHANNELS = {
  items: { type: "array", reduce: "replace" },
  item: { type: "object", reduce: "replace" },
  seen: { type: "array", reduce: "append_ordered" },
  hops: { type: "number", reduce: "sum", initial: 0 },
  out: { type: "object", reduce: "replace" },
};

interface Shape {
  /** Nodes in each fanned-out branch, chained `b0 -seq-> b1 -seq-> …`. */
  readonly bh: number;
  /** Hops on the second path into the join. `0` is a DIRECT `start -> J`. */
  readonly nh: number;
  /** When false, that second path is absent entirely — the baseline. */
  readonly withSecondPath: boolean;
  /** Kind of the second path's LAST edge, the one that arrives at the join. */
  readonly arrival?: "seq" | "conditional";
  /** Items the fan-out is given. Defaults to four. */
  readonly items?: readonly unknown[];
}

/**
 * `start --fanout--> b0 -seq-> … -join-> J -seq-> done`, plus, when `withSecondPath`, a second
 * path `start -> note0 -> … -> J` whose arrival edge is an ORDINARY edge rather than a `join`.
 *
 * Every branch node carries a `join` edge because `GRAPH008_BRANCH_NOT_CONNECTED` wants one from
 * every declared member; only the last of them is an arrival, since `#maybeFireJoin`'s
 * `continuesInBranch` discounts a Task whose `take` names another member.
 */
function sweepSpec(s: Shape): GraphSpec {
  const branchNodes = Array.from({ length: s.bh }, (_, i) => n(`b${i}`));
  const nodes: unknown[] = [
    { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
    ...branchNodes.map((id) => ({
      id,
      type: "function",
      reads: ["item"],
      writes: ["seen", "hops"],
      function: { ref: "function/work@stable" },
    })),
    {
      id: n("J"),
      type: "join",
      reads: ["seen"],
      writes: ["seen", "hops"],
      join: { branches: branchNodes, mode: "all", onBranchError: "skip" },
    },
    { id: n("done"), type: "function", reads: ["seen"], writes: ["out"], function: { ref: "function/done@stable" } },
  ];
  const edges: unknown[] = [
    { id: e("fo"), from: n("start"), to: n("b0"), kind: "fanout", over: "items", as: "item", maxWidth: WIDTH },
    ...branchNodes.slice(0, -1).map((id, i) => ({ id: e(`bs${i}`), from: id, to: branchNodes[i + 1], kind: "seq" })),
    ...branchNodes.map((id, i) => ({ id: e(`jn${i}`), from: id, to: n("J"), kind: "join", branches: branchNodes })),
    { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
  ];
  if (s.withSecondPath) {
    const notes = Array.from({ length: s.nh }, (_, i) => n(`note${i}`));
    for (const id of notes) {
      nodes.push({ id, type: "function", reads: ["items"], function: { ref: "function/note@stable" } });
    }
    const chain = [n("start"), ...notes, n("J")];
    for (let i = 0; i < chain.length - 1; i++) {
      const last = i === chain.length - 2;
      edges.push({
        id: e(`ns${i}`),
        from: chain[i],
        to: chain[i + 1],
        kind: last ? (s.arrival ?? "seq") : "seq",
        ...(last && s.arrival === "conditional" ? { when: "true" } : {}),
      });
    }
  }
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-seq-entrance", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 2, maxFanout: 16, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: ["out"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

interface Result {
  readonly status: string;
  readonly seen: readonly string[];
  readonly hops: unknown;
  readonly joinReady: number;
  readonly joinCommitted: number;
  readonly joinReduced: number;
  readonly doneCommitted: number;
}

async function run(spec: GraphSpec, items: readonly unknown[], maxParallelism: number): Promise<Result> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/note@stable", () => ({}));
  functions.register("function/arm-a@stable", () => ({ writes: { seen: ["a"] } }));
  functions.register("function/arm-b@stable", () => ({ writes: { seen: ["b"] } }));
  functions.register("function/work@stable", (view) => {
    const item = view.get<{ id: string }>("item");
    return { writes: { seen: [item?.id ?? "?"], hops: 1 } };
  });
  functions.register("function/done@stable", (view) => ({
    writes: { out: { n: (view.get<unknown[]>("seen") ?? []).length } },
  }));

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { items } });
  const p = await engine.advance(runId);
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  const count = (type: string, prefix: string): number =>
    log.filter((ev) => ev.type === type && String(ev.taskId).startsWith(prefix)).length;
  return {
    status: p.status,
    seen: (p.channels["seen"] as string[]) ?? [],
    hops: p.channels["hops"],
    joinReady: count("task.ready", "J@"),
    joinCommitted: count("task.committed", "J@"),
    joinReduced: count("state.reduced", "J@"),
    doneCommitted: count("task.committed", "done@"),
  };
}

test("AN ORDINARY EDGE INTO A JOIN NODE NEITHER FIRES THE BARRIER EARLY NOR FIRES IT TWICE", async () => {
  // The whole sweep, asserted against the SAME graph without the second path rather than
  // against a written-down number. That is what makes this a two-sided test: a fix that fired
  // the barrier late (or never) fails the baseline, and one that fired it twice fails the
  // equality. `nh: 0` is the direct `start -seq-> J`, the row's worst case.
  for (const maxParallelism of [1, 2, 3, 16]) {
    for (const bh of [1, 2, 3]) {
      const base = await run(sweepSpec({ bh, nh: 0, withSecondPath: false }), ITEMS, maxParallelism);
      const where = `par=${maxParallelism} bh=${bh}`;

      assert.equal(base.status, "succeeded", `${where} baseline`);
      assert.equal(base.seen.length, WIDTH * bh, `${where} baseline writes one entry per branch node`);
      assert.equal(base.joinCommitted, 1, `${where} baseline: the barrier commits once`);

      for (const nh of [0, 1, 3]) {
        const r = await run(sweepSpec({ bh, nh, withSecondPath: true }), ITEMS, maxParallelism);
        const at = `${where} nh=${nh}`;

        assert.equal(r.status, "succeeded", at);
        // The load-bearing one. Before the fix this was 8 where the baseline was 4 (a double
        // fold), or 0, 3 or 4 where the baseline was 8 or 12 (an early fire that discarded
        // every contribution that had not landed).
        assert.deepEqual(r.seen, base.seen, `${at}: the fold matches the no-second-path baseline`);
        assert.equal(r.hops, base.hops, `${at}: and the same under a "sum" reducer`);
        // Exactly once, on the journal and not only on the folded channel — the defect's tell
        // was two full `task.ready`/`committed`/`state.reduced` cycles for one barrier.
        assert.equal(r.joinReady, 1, `${at}: the barrier's Task is minted once`);
        assert.equal(r.joinCommitted, 1, `${at}: and commits once`);
        assert.equal(r.joinReduced, 1, `${at}: and reduces once`);
        assert.equal(r.doneCommitted, 1, `${at}: so the node behind it runs once`);
      }
    }
  }
});

test("THE DOUBLE-COMMIT ROW, PINNED ON ITS OWN — par=16, one-node branches, three hops", async () => {
  // Named separately because it is the row's own pasted reproduction and because it is the
  // only direction in which the run produced MORE than it should have. Pre-fix:
  // `seenLen=8 seen=[a,b,c,d,a,b,c,d] joinCommit=2 doneCommit=2`, status `succeeded`.
  const r = await run(sweepSpec({ bh: 1, nh: 3, withSecondPath: true }), ITEMS, 16);

  assert.equal(r.status, "succeeded");
  assert.deepEqual(r.seen, ["a", "b", "c", "d"], "four branches, four entries — it was eight");
  assert.equal(r.hops, 4, "and the same for a `sum` reducer, which shows it as arithmetic");
  assert.equal(r.joinCommitted, 1, "one barrier, one commit — it ran two full Task cycles");
  assert.equal(r.doneCommitted, 1, "and the node behind the join ran twice");
});

test("THE EARLY-FIRE ROW, PINNED ON ITS OWN — a DIRECT `seq` into the join beside the fan-out", async () => {
  // The worst case, and the shortest graph: at par=16 the barrier fired before any branch had
  // committed, `seen` was never written at ALL, and the run reported `succeeded`. A test that
  // only counted commits would pass on this row, which is why the channel is asserted too.
  const r = await run(sweepSpec({ bh: 2, nh: 0, withSecondPath: true }), ITEMS, 16);

  assert.equal(r.status, "succeeded");
  assert.equal(r.seen.length, 8, "four branches of two nodes — the channel was empty");
  assert.deepEqual([...r.seen].sort(), ["a", "a", "b", "b", "c", "c", "d", "d"]);
  assert.equal(r.joinCommitted, 1);
});

test("A `conditional` EDGE INTO A JOIN IS THE SAME ENTRANCE, and is closed the same way", async () => {
  // `#activate`'s generic arm handles every edge kind that is not `fanout` and not `join`, so
  // the defect was never about `seq` specifically. Pinning a second kind is what stops the fix
  // from being read as a special case for one word.
  for (const maxParallelism of [2, 16]) {
    const base = await run(sweepSpec({ bh: 2, nh: 1, withSecondPath: false }), ITEMS, maxParallelism);
    const r = await run(sweepSpec({ bh: 2, nh: 1, withSecondPath: true, arrival: "conditional" }), ITEMS, maxParallelism);

    assert.equal(r.status, "succeeded", `par=${maxParallelism}`);
    assert.deepEqual(r.seen, base.seen, `par=${maxParallelism}: the fold matches the baseline`);
    assert.equal(r.joinCommitted, 1, `par=${maxParallelism}: the barrier commits once`);
    assert.equal(r.doneCommitted, 1);
  }
});

test("THE ORDINARY GRAPH IS UNCHANGED — a fan-out and its join, with no second path at all", async () => {
  // The control that makes the fix a fix rather than a deletion. Every entrance now tests
  // quiescence, so the failure mode of an over-broad fix is a barrier that never releases: this
  // is the shape that would catch it, and it is the shape almost every graph in the tree has.
  for (const maxParallelism of [1, 4, 16]) {
    const r = await run(sweepSpec({ bh: 2, nh: 0, withSecondPath: false }), ITEMS, maxParallelism);
    assert.equal(r.status, "succeeded", `par=${maxParallelism}`);
    assert.deepEqual([...r.seen].sort(), ["a", "a", "b", "b", "c", "c", "d", "d"], `par=${maxParallelism}`);
    assert.equal(r.hops, 8, `par=${maxParallelism}`);
    assert.equal(r.joinCommitted, 1, `par=${maxParallelism}`);
    assert.equal(r.doneCommitted, 1, `par=${maxParallelism}`);
  }
});

/**
 * `start -fanout-> outer -fanout-> inner -join-> innerJoin`, both joins folding `findings`, with
 * `outer -seq-> note -seq-> innerJoin` beside the inner fan-out. `note` sits at depth 1, which is
 * the inner barrier's OWN parent coordinate, so the ids collide exactly as they do at the root.
 *
 * The nested shape is here because it fails DIFFERENTLY, and neither the row nor the flat sweep
 * above catches it. Pre-fix, at `maxParallelism: 4` only:
 *
 *     variant=A par=1  status=succeeded findings=["A0","A1","B0","B1"] finish=1
 *     variant=A par=4  status=failed    findings=undefined             finish=0
 *     variant=A par=16 status=succeeded findings=["A0","A1","B0","B1"] finish=1
 *
 * A run that DIES is the friendly version of this defect; the flat sweep's rows all reported
 * `succeeded` with the wrong number in the channel. One parallelism in three, and the two either
 * side of it are clean — which is why the assertion below sweeps rather than picking one.
 */
function nestedSpec(withSecondPath: boolean): GraphSpec {
  const nodes: unknown[] = [
    { id: n("start"), type: "function", reads: ["outerSeed"], function: { ref: "function/seed@stable" } },
    { id: n("outer"), type: "function", reads: ["outerItem"], function: { ref: "function/note@stable" } },
    {
      id: n("inner"),
      type: "function",
      reads: ["innerItem", "outerItem"],
      writes: ["findings"],
      function: { ref: "function/inner@stable" },
    },
    {
      id: n("innerJoin"),
      type: "join",
      reads: ["findings"],
      writes: ["findings"],
      join: { branches: [n("inner")], mode: "all", onBranchError: "skip" },
    },
    {
      id: n("outerJoin"),
      type: "join",
      reads: ["findings"],
      writes: ["findings"],
      // GRAPH021 forces the fan-out TARGET (`outer`) to be named here.
      join: { branches: [n("outer"), n("innerJoin")], mode: "all", onBranchError: "skip" },
    },
    { id: n("finish"), type: "function", reads: ["findings"], writes: ["out"], function: { ref: "function/report@stable" } },
  ];
  const edges: unknown[] = [
    { id: e("fo"), from: n("start"), to: n("outer"), kind: "fanout", over: "outerSeed", as: "outerItem", maxWidth: 8 },
    { id: e("fi"), from: n("outer"), to: n("inner"), kind: "fanout", over: "innerSeed", as: "innerItem", maxWidth: 8 },
    { id: e("ji"), from: n("inner"), to: n("innerJoin"), kind: "join", branches: [n("inner")] },
    { id: e("jo1"), from: n("outer"), to: n("outerJoin"), kind: "join", branches: [n("outer")] },
    { id: e("jo2"), from: n("innerJoin"), to: n("outerJoin"), kind: "join", branches: [n("innerJoin")] },
    { id: e("fin"), from: n("outerJoin"), to: n("finish"), kind: "seq" },
  ];
  if (withSecondPath) {
    nodes.push({ id: n("note"), type: "function", reads: ["outerItem"], function: { ref: "function/note@stable" } });
    edges.push({ id: e("na"), from: n("outer"), to: n("note"), kind: "seq" });
    edges.push({ id: e("nb"), from: n("note"), to: n("innerJoin"), kind: "seq" });
  }
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-seq-entrance-nested", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 128, maxDepth: 2, maxFanout: 8, maxLoopIterations: 1 } },
    channels: {
      ...CHANNELS,
      outerSeed: { type: "array", reduce: "replace" },
      innerSeed: { type: "array", reduce: "replace" },
      outerItem: { type: "object", reduce: "replace" },
      innerItem: { type: "object", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["outerSeed", "innerSeed"],
    outputs: ["out"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

async function runNested(spec: GraphSpec, maxParallelism: number): Promise<{ status: string; findings: unknown; finish: number }> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/note@stable", () => ({}));
  functions.register("function/inner@stable", (view) => {
    const o = (view.get<{ o: string }>("outerItem") ?? { o: "?" }).o;
    const i = (view.get<{ i: number }>("innerItem") ?? { i: -1 }).i;
    return { writes: { findings: [`${o}${i}`] } };
  });
  functions.register("function/report@stable", (view) => ({
    writes: { out: { findings: view.get<unknown[]>("findings") ?? [] } },
  }));

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => NOW,
    maxParallelism,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { outerSeed: [{ o: "A" }, { o: "B" }], innerSeed: [{ i: 0 }, { i: 1 }] } });
  const p = await engine.advance(runId);
  const log: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  return {
    status: p.status,
    findings: p.channels["findings"],
    finish: log.filter((ev) => ev.type === "task.committed" && String(ev.taskId).startsWith("finish@")).length,
  };
}

test("A NESTED FAN-OUT'S INNER BARRIER IS THE SAME ENTRANCE — and pre-fix it KILLED the run", async () => {
  for (const maxParallelism of [1, 2, 4, 8, 16]) {
    const base = await runNested(nestedSpec(false), maxParallelism);
    const r = await runNested(nestedSpec(true), maxParallelism);
    const at = `par=${maxParallelism}`;

    assert.equal(base.status, "succeeded", `${at}: baseline`);
    assert.deepEqual(base.findings, ["A0", "A1", "B0", "B1"], `${at}: baseline`);

    // Pre-fix this was `status: "failed"` with `findings: undefined` at par=4, and clean at
    // par=1 and par=16 — so a test that picked one parallelism would have missed it.
    assert.equal(r.status, "succeeded", `${at}: the second path must not kill the run`);
    assert.deepEqual(r.findings, base.findings, `${at}: the inner fold matches the baseline`);
    assert.equal(r.finish, 1, `${at}: and the node behind the outer join runs once`);
  }
});

/**
 * A STATIC sibling join whose LAST arm carries an extra ordinary edge to the join.
 *
 * This is the shape that collides the two arms of `#activate`'s take loop. Both edges are in
 * `take`, so the termination sweep at the bottom skips the `join` edge (`take.includes(e.id)`)
 * and never runs — the two mints come from the join arm and the generic arm of the loop itself.
 * It must be the LAST arm: an earlier one does not satisfy the barrier, so neither arm fires and
 * there is nothing to suppress.
 *
 * Behind a fan-out the same shape does not compile (`GRAPH008_JOIN_DEPTH`,
 * `GRAPH010_CONCURRENT_WRITE`), so a static join is the whole of the reachable set today.
 */
function twoEdgesToOneJoinSpec(withExtra: boolean): GraphSpec {
  const arms = ["a", "b"];
  const edges: unknown[] = [
    ...arms.map((id) => ({ id: e(`s${id}`), from: n("start"), to: n(id), kind: "seq" })),
    ...arms.map((id) => ({ id: e(`j${id}`), from: n(id), to: n("J"), kind: "join", branches: arms.map(n) })),
    { id: e("sq"), from: n("J"), to: n("done"), kind: "seq" },
  ];
  if (withExtra) edges.push({ id: e("extra"), from: n("b"), to: n("J"), kind: "seq" });
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "join-seq-entrance-dedupe", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: CHANNELS,
    inputs: ["items"],
    outputs: ["out"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      ...arms.map((id) => ({
        id: n(id),
        type: "function",
        reads: ["items"],
        writes: ["seen"],
        function: { ref: `function/arm-${id}@stable` },
      })),
      {
        id: n("J"),
        type: "join",
        reads: ["seen"],
        writes: ["seen"],
        join: { branches: arms.map(n), mode: "all", onBranchError: "skip" },
      },
      { id: n("done"), type: "function", reads: ["seen"], writes: ["out"], function: { ref: "function/done@stable" } },
    ],
    edges,
  } as unknown as GraphSpec;
}

test("TWO EDGES FROM ONE MEMBER TO ONE JOIN MINT THE BARRIER ONCE, not twice", async () => {
  // `pushJoin`'s reason for existing, driven. `#maybeFireJoin` stands down on
  // `p.tasks[joinTaskId]`, but `p` predates every event in the array `#activate` is building —
  // so both arms saw an empty slot and both appended a `task.ready` for `J@root#0`. Before the
  // guard this graph journals TWO of them; after, one. The projection happens to dedupe on
  // taskId so the pre-fix run still committed once, which is exactly why this is asserted on the
  // JOURNAL: a duplicate row that today only looks wrong is a fold's problem tomorrow.
  for (const maxParallelism of [1, 2, 16]) {
    const base = await run(twoEdgesToOneJoinSpec(false), [], maxParallelism);
    const r = await run(twoEdgesToOneJoinSpec(true), [], maxParallelism);
    const at = `par=${maxParallelism}`;

    assert.equal(r.status, "succeeded", at);
    assert.equal(r.joinReady, 1, `${at}: ONE task.ready row for the barrier — it was two`);
    assert.equal(r.joinReady, base.joinReady, `${at}: and the same as without the extra edge`);
    assert.equal(r.joinCommitted, 1, at);
    assert.deepEqual(r.seen, base.seen, `${at}: the fold is unchanged by the extra edge`);
    assert.equal(r.doneCommitted, 1, at);
  }
});

test("A FAN-OUT OF WIDTH ZERO STILL RELEASES ITS BARRIER — the trap the row names", async () => {
  // `#fireEmptyJoin` must NOT be routed through `#maybeFireJoin`. The planner's own `take` holds
  // the `fanout` edge whose `to` is a declared member, so `handingOff` is true and `quiescent`
  // never becomes true; routed, this graph strands with `status: "failed"` and zero hops. An
  // empty fan needs `#maybeFireJoin` to be TOLD the fan planned nothing, which is a design and
  // not a call-site swap — so this is here to fail loudly if a later author makes the swap.
  for (const maxParallelism of [1, 16]) {
    const r = await run(sweepSpec({ bh: 2, nh: 0, withSecondPath: false }), [], maxParallelism);
    assert.equal(r.status, "succeeded", `par=${maxParallelism}: the empty fan releases`);
    assert.equal(r.joinCommitted, 1, `par=${maxParallelism}: over zero branches, but it fires`);
    assert.equal(r.doneCommitted, 1, `par=${maxParallelism}: and the graph behind it runs`);
  }

  // And with the second path present, which is the interaction the fix creates: the `seq`
  // arrival must not fire the empty barrier either early or a second time.
  for (const maxParallelism of [1, 16]) {
    const r = await run(sweepSpec({ bh: 2, nh: 1, withSecondPath: true }), [], maxParallelism);
    assert.equal(r.status, "succeeded", `par=${maxParallelism}: empty fan + second path`);
    assert.equal(r.joinCommitted, 1, `par=${maxParallelism}: still exactly one`);
    assert.equal(r.doneCommitted, 1);
  }
});
