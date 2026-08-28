/**
 * C3 probe. Scratch only.
 *
 * Two joins that land in the SAME wave, at DISJOINT branch prefixes, both folding
 * `findings` from a pre-wave base and both committing an ABSOLUTE value. The
 * projection folds `state.reduced` as `{...p.channels, ...values}`, so the second
 * commit of the wave overwrites the first — the first join's contributions vanish.
 *
 * Shape (nesting is what makes the two joins' member sets disjoint; two joins at the
 * root prefix would each fold the OTHER's subtree too, C2, and so agree by accident):
 *
 *   start ─fanout(2 outers)→ outer ─fanout(2 inners)→ inner ─join→ innerJoin
 *                              └──────────── join ────────────────→ outerJoin ─seq→ finish
 *
 * `innerJoin` instances sit at `root/fo[0]` and `root/fo[1]`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import { validateGraph } from "../../src/graph/validate.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { replayRun } from "../../src/run/replay.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "c3-two-joins-one-wave", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 128, maxDepth: 2, maxFanout: 8, maxLoopIterations: 1 } },
    channels: {
      outerSeed: { type: "array", reduce: "replace" },
      innerSeed: { type: "array", reduce: "replace" },
      outerItem: { type: "object", reduce: "replace" },
      innerItem: { type: "object", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["outerSeed", "innerSeed"],
    outputs: ["report"],
    nodes: [
      { id: n("start"), type: "function", reads: ["outerSeed"], function: { ref: "function/seed@stable" } },
      { id: n("outer"), type: "function", reads: ["outerItem"], function: { ref: "function/outer@stable" } },
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
      { id: n("finish"), type: "function", reads: ["findings"], writes: ["report"], function: { ref: "function/report@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("outer"), kind: "fanout", over: "outerSeed", as: "outerItem", maxWidth: 8 },
      { id: e("fi"), from: n("outer"), to: n("inner"), kind: "fanout", over: "innerSeed", as: "innerItem", maxWidth: 8 },
      { id: e("ji"), from: n("inner"), to: n("innerJoin"), kind: "join", branches: [n("inner")] },
      { id: e("jo1"), from: n("outer"), to: n("outerJoin"), kind: "join", branches: [n("outer")] },
      { id: e("jo2"), from: n("innerJoin"), to: n("outerJoin"), kind: "join", branches: [n("innerJoin")] },
      { id: e("done"), from: n("outerJoin"), to: n("finish"), kind: "seq" },
    ],
  };
}

function fns(): FunctionRegistry {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/outer@stable", () => ({}));
  functions.register("function/inner@stable", (view) => {
    const o = (view.get<{ o: string }>("outerItem") ?? { o: "?" }).o;
    const i = (view.get<{ i: number }>("innerItem") ?? { i: -1 }).i;
    return { writes: { findings: [`${o}${i}`] } };
  });
  functions.register("function/report@stable", (view) => ({
    writes: { report: { findings: view.get<unknown[]>("findings") ?? [] } },
  }));
  return functions;
}

function engineOpts(maxParallelism: number): {
  tools: ToolRegistry;
  functions: FunctionRegistry;
  models: ModelRegistry;
  now: () => number;
  maxParallelism: number;
  policy: { granted: string[] };
} {
  return {
    tools: new ToolRegistry(),
    functions: fns(),
    models: new ModelRegistry(),
    now: () => 1_700_000_000_000,
    maxParallelism,
    policy: { granted: [] },
  };
}

interface Driven {
  readonly store: MemoryStateStore;
  readonly runId: RunId;
  readonly findings: unknown;
  readonly reduced: Frame[];
}

interface Frame {
  readonly seq: number;
  readonly taskId: string;
  readonly values: Record<string, unknown>;
  readonly channels: readonly string[];
  readonly before: string;
  readonly after: string;
  readonly branchCount: number;
  readonly skipped: number;
}

async function drive(maxParallelism: number): Promise<Driven> {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const engine = new Engine({ store, ...engineOpts(maxParallelism) });
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({
    graph,
    inputs: { outerSeed: [{ o: "A" }, { o: "B" }], innerSeed: [{ i: 0 }, { i: 1 }] },
  });
  const p = await engine.advance(runId);

  const events: JournalEvent[] = [];
  for await (const ev of store.read(runId as RunId, 1)) events.push(ev);

  const reduced: Frame[] = [];
  console.log(`\n=== maxParallelism = ${maxParallelism} ===`);
  for (const ev of events) {
    if (ev.type === "task.ready" || ev.type === "task.committed") {
      console.log(
        `  seq=${String(ev.seq).padStart(3)} ${ev.type.padEnd(15)} ${(ev.taskId ?? "").padEnd(30)} ${JSON.stringify(ev.payload).slice(0, 130)}`,
      );
    }
    if (ev.type === "state.reduced") {
      const pl = ev.payload as {
        values: Record<string, unknown>;
        channels: readonly string[];
        stateHashBefore: string;
        stateHashAfter: string;
        branchCount: number;
        skipped: number;
      };
      const f: Frame = {
        seq: ev.seq,
        taskId: String(ev.taskId ?? ""),
        values: pl.values,
        channels: pl.channels,
        before: pl.stateHashBefore,
        after: pl.stateHashAfter,
        branchCount: pl.branchCount,
        skipped: pl.skipped,
      };
      reduced.push(f);
      console.log(
        `  seq=${String(ev.seq).padStart(3)} state.reduced   ${f.taskId.padEnd(30)} branchCount=${f.branchCount} channels=${JSON.stringify(f.channels)} values=${JSON.stringify(f.values)}`,
      );
      console.log(`      before=${f.before.slice(7, 19)}  after=${f.after.slice(7, 19)}`);
    }
  }
  console.log("  status:", p.status);
  console.log("  FINAL channels.findings:", JSON.stringify(p.channels["findings"]));
  console.log("  outputs.report:", JSON.stringify(p.outputs["report"]));
  return { store, runId: runId as RunId, findings: p.channels["findings"], reduced };
}

test("a nested fan-out folds every inner finding exactly once", async () => {
  const diags = validateGraph({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  assert.deepEqual(
    diags.filter((d) => d.severity === "error"),
    [],
    "the nested fixture must compile clean",
  );

  const wide = await drive(16);
  assert.deepEqual(
    wide.findings,
    ["A0", "A1", "B0", "B1"],
    "each inner branch contributes once: no double-count from prefix descent, no loss from an absolute overwrite",
  );
});

test("THE SAME GRAPH GIVES THE SAME ANSWER AT ANY maxParallelism", async () => {
  // The invariant-2 half of C3. Wave membership is bounded by `maxParallelism`, which the
  // journal never records — so if the fold depended on it, one journal would replay to
  // different state on a differently-configured engine.
  const answers = new Map<number, string>();
  for (const mp of [1, 2, 3, 16]) {
    const d = await drive(mp);
    answers.set(mp, JSON.stringify(d.findings));
  }
  const distinct = new Set(answers.values());
  assert.equal(
    distinct.size,
    1,
    `final channel state must not depend on maxParallelism, got ${JSON.stringify([...answers])}`,
  );
  assert.equal([...distinct][0], JSON.stringify(["A0", "A1", "B0", "B1"]));
});

test("an inner join HOLDS its fold rather than applying it to shared state", async () => {
  // A join inside a fan-out runs once per enclosing branch. Applying there would make the
  // result depend on which sibling committed first, so it returns its fold as its own
  // write and the enclosing join folds the siblings in branch order.
  const wide = await drive(16);
  const innerFrames = wide.reduced.filter((f) => f.taskId.startsWith("innerJoin@"));
  assert.deepEqual(innerFrames, [], "a join at depth > 0 must emit no state.reduced");
});

test("a journal recorded at one maxParallelism replays identically at another", async () => {
  const wide = await drive(16);
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });

  for (const mp of [16, 1]) {
    const report = await replayRun({
      store: wide.store,
      runId: wide.runId,
      graph,
      engine: engineOpts(mp),
    });
    const bad = report.frames.filter((f) => !f.match).slice(0, 3);
    assert.equal(
      report.match,
      true,
      `a journal recorded at maxParallelism=16 must replay identically at ${mp}; diverged at ${bad
        .map((f) => `seq ${String(f.seq)} ${f.kind}`)
        .join(", ")}`,
    );
    assert.deepEqual(report.replayed.channels["findings"], ["A0", "A1", "B0", "B1"]);
  }
});
