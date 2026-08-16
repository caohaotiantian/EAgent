/**
 * A join mode that short-circuits must actually short-circuit.
 *
 * The quiescence gate that fixed nested fan-outs — a barrier may not fire while an arrival
 * is still possible — was written unconditional over `join.mode`. That collapsed `any`,
 * `firstSuccess` and `quorum` into `all`: all four released at exactly the same point, so
 * choosing `any` bought nothing.
 *
 * The distinction is which direction the conclusion runs. A short-circuit fires on
 * EVIDENCE ALREADY IN HAND — one success is one success whether or not siblings are still
 * running. Only the conclusions that rest on ABSENCE need to know no arrival is possible:
 * "every branch is in", and "the quorum can no longer be met".
 *
 * At `maxParallelism: 1` the branches commit one at a time, which makes the difference
 * observable without racing anything.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function spec(mode: "all" | "any"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `join-${mode}`, project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      found: { type: "array", reduce: "append_ordered" },
      out: { type: "object", reduce: "replace" },
    },
    inputs: ["items"],
    outputs: ["out"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
      { id: n("work"), type: "function", reads: ["item"], writes: ["found"], function: { ref: "function/work@stable" } },
      {
        id: n("gather"),
        type: "join",
        reads: ["found"],
        writes: ["found"],
        join: { branches: [n("work")], mode, onBranchError: "skip" },
      },
      { id: n("done"), type: "function", reads: ["found"], writes: ["out"], function: { ref: "function/done@stable" } },
    ],
    edges: [
      { id: e("fo"), from: n("start"), to: n("work"), kind: "fanout", over: "items", as: "item", maxWidth: 3 },
      { id: e("jn"), from: n("work"), to: n("gather"), kind: "join" },
      { id: e("sq"), from: n("gather"), to: n("done"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** Seq of the join's `task.ready`, and of the last branch commit. */
interface Timing {
  readonly status: string;
  readonly found: unknown;
  readonly joinReadyAt: number;
  readonly lastBranchCommitAt: number;
  readonly branchCommits: number;
}

async function run(mode: "all" | "any"): Promise<Timing> {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({}));
  functions.register("function/work@stable", (view) => {
    const item = view.get<{ id: number }>("item");
    return { writes: { found: [`f${String(item?.id ?? -1)}`] } };
  });
  functions.register("function/done@stable", (view) => ({ writes: { out: { n: (view.get<unknown[]>("found") ?? []).length } } }));

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => 1_700_000_000_000,
    // All three branches materialise and run in ONE wave, so when the first commits its
    // siblings are live Tasks in the projection. That is what makes the difference
    // observable: at `maxParallelism: 1` the siblings do not exist yet, every barrier is
    // trivially quiescent, and `any` and `all` are indistinguishable for the wrong reason.
    maxParallelism: 3,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const graph = compileOrThrow({ spec: spec(mode), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { items: [{ id: 0 }, { id: 1 }, { id: 2 }] } });
  const p = await engine.advance(runId);

  const log = [];
  for await (const ev of store.read(runId, 1)) log.push(ev);
  const joinReady = log.find((ev) => ev.type === "task.ready" && String(ev.taskId).startsWith("gather@"));
  const commits = log.filter((ev) => ev.type === "task.committed" && String(ev.taskId).startsWith("work@"));

  return {
    status: p.status,
    found: p.channels["found"],
    joinReadyAt: joinReady?.seq ?? -1,
    lastBranchCommitAt: commits.at(-1)?.seq ?? -1,
    branchCommits: commits.length,
  };
}

test("`all` becomes ready only after the LAST branch commits", async () => {
  const r = await run("all");
  assert.equal(r.status, "succeeded");
  assert.equal(r.branchCommits, 3, "precondition: all three branches ran");
  assert.deepEqual(r.found, ["f0", "f1", "f2"], "an `all` barrier folds the whole fan-out");
  assert.ok(
    r.joinReadyAt > r.lastBranchCommitAt,
    `an \`all\` barrier must not be ready before its last branch: ready@${String(r.joinReadyAt)} vs last commit@${String(r.lastBranchCommitAt)}`,
  );
});

test("`any` BECOMES READY BEFORE THE LAST BRANCH COMMITS", async () => {
  const r = await run("any");
  assert.equal(r.status, "succeeded");
  assert.equal(r.branchCommits, 3, "precondition: the siblings still run — nothing cancels a straggler");

  // The observable is WHEN the barrier releases, not what it folds: the run drains either
  // way, so a late fold sees the same contributions. Gating the whole decision on
  // quiescence moved this seq past the last commit, which is exactly `all`.
  assert.ok(
    r.joinReadyAt < r.lastBranchCommitAt,
    `an \`any\` join must release on the first success: ready@${String(r.joinReadyAt)} vs last commit@${String(r.lastBranchCommitAt)}`,
  );
});
