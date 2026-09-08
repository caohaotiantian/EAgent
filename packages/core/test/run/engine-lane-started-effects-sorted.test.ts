/**
 * `RunProjection.startedEffects` comes back SORTED from a real fold, and the executor relies on it.
 *
 * `Engine.#servedEffect` used to ask the array `includes(key)` — one entry per effect the run
 * ever started, so O(effects) per served-effect question, six questions per task. It binary
 * searches now (`sortedHas`), which is correct only while `freeze` hands the array back in the
 * order `<` gives — `[...everStarted].sort()`, `projection.ts`. That sort is another file's
 * decision and its docstring does not promise it, so this pins it from the outside: a projection
 * that stops sorting fails here, with the file named, rather than making a re-execution repeat
 * an effect it had already recorded.
 *
 * The ordinary half is the re-execution itself: a task that recorded its seed and then failed
 * is served the SAME seed on attempt 2 and appends no second `random` pair — which is exactly
 * the lookup `sortedHas` answers, over an array that by then holds several keys.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function spec(width: number): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "sorted", project: "eff", version: 1 },
    policy: { expansion: { maxNodes: 64, maxDepth: 1, maxFanout: width, maxLoopIterations: 1 } },
    channels: {
      items: { type: "array", reduce: "replace" },
      item: { type: "object", reduce: "replace" },
      results: { type: "array", reduce: "append_ordered" },
      seeds: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    outputs: ["results"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/noop@stable" } },
      { id: n("work"), type: "function", reads: ["item"], writes: ["results", "seeds"], function: { ref: "function/work@stable" }, retry: { maxAttempts: 2, backoff: "fixed", initialMs: 0 } },
      { id: n("collect"), type: "join", reads: ["results"], writes: ["results"], join: { branches: [n("work")], mode: "all", onBranchError: "fail" } },
    ],
    edges: [
      { id: e("fan"), from: n("start"), to: n("work"), kind: "fanout", over: "items", as: "item", maxWidth: width },
      { id: e("join"), from: n("work"), to: n("collect"), kind: "join", branches: [n("work")] },
    ],
  } as unknown as GraphSpec;
}

async function run(width: number, failOnceAt: number | undefined) {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  const attempts = new Map<number, number>();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/work@stable", (view, ctx) => {
    const i = view.get<{ i: number }>("item")?.i ?? -1;
    const seen = (attempts.get(i) ?? 0) + 1;
    attempts.set(i, seen);
    if (i === failOnceAt && seen === 1) throw err.unavailable(CODES.E_PROVIDER_RATE_LIMIT, "first attempt refuses");
    return { writes: { results: [{ i }], seeds: [{ i, seed: ctx.seed }] } };
  });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    maxParallelism: 4,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: spec(width), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { items: Array.from({ length: width }, (_, i) => ({ i })) } });
  let p = await engine.advance(runId);
  // A rate-limited task is deferred until `retryAfter`, so the injected clock has to move for
  // the retry to be due; nothing here reads the wall clock.
  for (let i = 0; i < 4 && p.status === "running"; i++) {
    clock.t += 60_000;
    p = await engine.advance(runId);
  }
  const events: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) events.push(ev);
  return { p, events, attempts };
}

test("A REAL FOLD HANDS `startedEffects` BACK SORTED — the property the binary search stands on", async () => {
  const { p, events } = await run(9, undefined);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.ok(p.startedEffects.length >= 10, `only ${String(p.startedEffects.length)} effects started`);
  for (let i = 1; i < p.startedEffects.length; i++) {
    assert.ok(p.startedEffects[i - 1]! < p.startedEffects[i]!, `out of order at ${String(i)}: ${p.startedEffects[i - 1]} !< ${p.startedEffects[i]}`);
  }
  // And the same is true of every prefix of the journal, which is what a re-execution mid-run reads.
  for (let k = 1; k <= events.length; k++) {
    const prefix = foldRun(events.slice(0, k))!;
    for (let i = 1; i < prefix.startedEffects.length; i++) {
      assert.ok(prefix.startedEffects[i - 1]! < prefix.startedEffects[i]!, `prefix ${String(k)} out of order at ${String(i)}`);
    }
  }
});

test("ORDINARY HALF — a re-executed body is served its recorded seed and records no second one", async () => {
  const { p, events, attempts } = await run(9, 4);
  assert.equal(p.status, "succeeded", `${p.status} ${JSON.stringify(p.error ?? {})} ${JSON.stringify(Object.values(p.tasks).map((t) => [t.taskId, t.state, t.attempt, t.retryAfter ?? null]))}`);
  assert.equal(attempts.get(4), 2, "branch 4 ran twice");
  const seedRows = events.filter((ev) => ev.type === "effect.started" && (ev.payload as { key: string }).key === "work@root/fan[4]#0:random:0");
  assert.equal(seedRows.length, 1, "one `random` effect for the task across both attempts");
  const seeds = p.channels["seeds"] as { i: number; seed: number }[];
  assert.equal(seeds.filter((s) => s.i === 4).length, 1);
  const recorded = events.find((ev) => ev.type === "effect.completed" && (ev.payload as { key: string }).key === "work@root/fan[4]#0:random:0")!;
  assert.equal(seeds.find((s) => s.i === 4)!.seed, (recorded.payload as { result: number }).result, "attempt 2 used the seed attempt 1 recorded");
});
