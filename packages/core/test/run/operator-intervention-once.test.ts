/**
 * AN OPERATOR INTERVENTION LANDS ONCE, OR THE JOURNAL IS LYING ABOUT HOW MANY THERE WERE.
 *
 * `pause`'s own docstring makes the claim this file measures: "IDEMPOTENT: a second pause on
 * a paused run appends nothing. Two `run.suspended` rows would read, to anyone folding the
 * log, like two separate interventions." It held for one caller at a time and for no other
 * case: `pause` reads `p.paused`, `resume` reads `!p.paused`, and both then wrote through
 * `RunLog.append`, whose own docstring says it "retries on seq conflict because the events
 * are unconditional". These events are not unconditional. They are a decision made against a
 * head that another writer can move.
 *
 * THIS IS THE SAME DEFECT AS `HumanGateBroker.resolve`'s, one door over. That one checked the
 * gate at `p.seq` and appended through the retrying door, and two planes over one journal
 * produced `gate.decided 2 | run.resumed 2 | task.leased 3 | task.committed 2 | run.failed 2`
 * with both calls reporting success. `gates.ts` says of the fix: "A projection that cannot be
 * fooled by a journal that is already wrong is not the same as a journal that is right."
 *
 * WHY PAUSE/RESUME AND NOT `cancel`/`#finish`. A duplicated terminal event is caught by the
 * auditor's `run.terminal-is-last-and-once` rule, so it is a defect somebody eventually
 * finds. A duplicated `run.suspended` was invisible to every rule the auditor had — which is
 * why the fix for these two ships with the rule that makes them visible, and why they are
 * measured here rather than left to it.
 *
 * TWO ENGINES OVER ONE STORE is the whole rig. `#serialize` chains writes within one Engine,
 * so a single instance cannot show this; two instances over one journal is exactly the
 * "two planes over one SQLite file" shape that found the gate defect, and is what a
 * `loom serve` plus a CLI already is.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "intervene", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      { id: n("a"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/a@stable" } },
      { id: n("b"), type: "function", reads: ["out"], writes: ["out"], function: { ref: "function/a@stable" } },
    ],
    edges: [{ id: e("s"), from: n("a"), to: n("b"), kind: "seq" }],
  } as unknown as GraphSpec;
}

/** Two engines, one store — a `loom serve` and a CLI over the same journal. */
function twoPlanes(): { a: Engine; b: Engine; store: MemoryStateStore; graph: ReturnType<typeof compileOrThrow> } {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const build = (): Engine => {
    const functions = new FunctionRegistry();
    functions.register("function/a@stable", () => ({ writes: { out: "done" } }));
    const models = new ModelRegistry();
    models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
    return new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools: new ToolRegistry(),
      functions,
      models,
      now,
      maxParallelism: 2,
      policy: { granted: [], budget: { runUsd: 1 } },
    });
  };
  return {
    a: build(),
    b: build(),
    store,
    graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }),
  };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

function countOf(log: readonly JournalEvent[], type: string): number {
  return log.filter((ev) => ev.type === type).length;
}

test("TWO PLANES PAUSING ONE RUN IN THE SAME INSTANT LEAVE ONE INTERVENTION, not two", async () => {
  const { a, b, store, graph } = twoPlanes();
  const runId = await a.submit({ graph, inputs: { seed: "s" } });

  // Both read "not paused" before either writes. That is the whole race, and it is the
  // ordinary shape of an operator hitting pause in a console while a script does the same.
  const settled = await Promise.allSettled([a.pause(runId, "console"), b.pause(runId, "script")]);

  const log = await events(store, runId);
  const trace = log.map((ev) => `${String(ev.seq)} ${ev.type}`).join(" | ");
  const outcomes = settled.map((s) => s.status).join(",");

  assert.equal(countOf(log, "run.suspended"), 1, `two suspends for one pause: ${trace} (calls: ${outcomes})`);
  assert.equal(
    log.filter((ev) => ev.type === "operator.command" && (ev.payload as { kind: string }).kind === "pause").length,
    1,
    `two pause commands landed: ${trace}`,
  );

  // AND THE LOSER IS NOT AN ERROR. A second pause on a paused run is the documented no-op,
  // whether it lost a race or arrived a second later.
  assert.equal(settled.filter((s) => s.status === "rejected").length, 0, `a duplicate pause must not throw: ${outcomes}`);
  assert.equal((await a.projection(runId))?.paused, true);
});

test("TWO PLANES RESUMING ONE PAUSED RUN LEAVE ONE `run.resumed`, and the loser is refused", async () => {
  const { a, b, store, graph } = twoPlanes();
  const runId = await a.submit({ graph, inputs: { seed: "s" } });
  await a.pause(runId, "console");

  const settled = await Promise.allSettled([a.resume(runId, "console"), b.resume(runId, "script")]);

  const log = await events(store, runId);
  const trace = log.map((ev) => `${String(ev.seq)} ${ev.type}`).join(" | ");

  assert.equal(countOf(log, "run.resumed"), 1, `two resumes for one pause: ${trace}`);
  assert.equal(
    log.filter((ev) => ev.type === "operator.command" && (ev.payload as { kind: string }).kind === "resume").length,
    1,
    `two resume commands landed: ${trace}`,
  );

  // `resume` REFUSES a run that is not paused — that refusal is documented as "the
  // interesting half", and losing a race must reach it rather than route around it.
  assert.equal(
    settled.filter((s) => s.status === "rejected").length,
    1,
    `exactly one resume must be refused: ${settled.map((s) => s.status).join(",")}`,
  );
  assert.equal((await a.projection(runId))?.paused, false);
});

test("THE CONTROL: a pause and a resume in sequence still work, and still say so once each", async () => {
  const { a, store, graph } = twoPlanes();
  const runId = await a.submit({ graph, inputs: { seed: "s" } });
  await a.pause(runId, "console");
  await a.pause(runId, "console");
  await a.resume(runId, "console");

  const log = await events(store, runId);
  assert.equal(countOf(log, "run.suspended"), 1);
  assert.equal(countOf(log, "run.resumed"), 1);
  assert.equal((await a.projection(runId))?.paused, false);
});
