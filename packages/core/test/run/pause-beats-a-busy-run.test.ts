/**
 * THE OPERATOR'S EMERGENCY BRAKE MUST WORK WHILE THE RUN IS BUSY — that is the only moment
 * anybody reaches for it.
 *
 * `pause`/`resume` moved off `RunLog.append` onto `RunLog.commit(p.seq, …)` so an intervention
 * is written CONDITIONAL on the head it was decided against; `operator-intervention-once.test.ts`
 * measures why. That change was right and this file guards the hole it opened: `#intervene`
 * read the projection and decided OUTSIDE `#serialize` and entered the chain only for the
 * commit, so every append an in-flight `advance` made landed between the decide and the
 * commit. `append`'s old retry loop ran entirely INSIDE one `#serialize` slot, which is why
 * it never lost this race — the retry was cheap and nothing could interleave.
 *
 * ONE ENGINE, WHICH IS THE POINT. `operator-intervention-once` needs two Engines over one
 * store because `#serialize` chains writes within one instance. This defect is the opposite:
 * it is visible with a SINGLE Engine, because the losing writer is the engine's own running
 * graph. That is `loom serve` exactly — the engine answering the HTTP pause is the engine
 * driving the run.
 *
 * A RANGE OF TICK COUNTS, NOT ONE. The window is where the pause lands relative to the wave
 * loop, so a test pinned to a single tick count can pass at a value the bug never covered and
 * prove nothing. Measured on the broken tree: fulfilled at 34/36, REJECTED at 38/40/42 with
 * `E_SEQ_CONFLICT … could not be paused in 8 attempts`, and on the rejected laps the run went
 * on to COMPLETE — zero `run.suspended` rows in a 144-event journal. Against `2c36026`, the
 * tree before `pause` moved off `append`, all twelve pass.
 *
 * WHAT THIS FILE DOES **NOT** COVER, said plainly so nobody reads it as "pause is safe now".
 * ONE Engine is the whole claim. TWO Engines over one store — a `loom serve` driving the run
 * and a CLI hitting pause — is a DIFFERENT and still-open case, because `#serialize` orders
 * only the writers one instance can see. Measured on this fix with the same rig, engine A
 * advancing and engine B pausing:
 *
 *   ticks=24 ok  32 E_SEQ_CONFLICT  38 ok  40 ok  42 E_SEQ_CONFLICT  48 E_SEQ_CONFLICT
 *   52 ok  56 ok       — three of eight refused, `run.suspended` 0, journal 144 events
 *   against 2c36026: eight of eight ok, one suspension each, 13 events
 *
 * So the cross-process half of the same regression is still there and is not closed by moving
 * the decision into the chain. It cannot be: the decision has to be conditional on a head
 * another PROCESS is moving, and `commit(expectedSeq)` is the only conditional the journal
 * offers — it demands that nothing at all changed, when what `pause` needs is that nothing
 * RELEVANT changed. Closing it needs a semantic conditional in `journal/store.ts`, which is a
 * kernel seam and a decision nobody has made. The refusal is at least fail-closed: the brake
 * says it did not engage rather than reporting a pause that never landed.
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

const CHAIN = 20;

/** A long `seq` chain, so the run is still busy many microtasks after `advance` is entered. */
function spec(): GraphSpec {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < CHAIN; i++) {
    nodes.push({
      id: n(`k${String(i)}`),
      type: "function",
      reads: [i === 0 ? "seed" : "out"],
      writes: ["out"],
      function: { ref: "function/step@stable" },
    });
    if (i > 0) edges.push({ id: e(`s${String(i)}`), from: n(`k${String(i - 1)}`), to: n(`k${String(i)}`), kind: "seq" });
  }
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "busy", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: CHAIN + 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    nodes,
    edges,
  } as unknown as GraphSpec;
}

function plane(): { engine: Engine; store: MemoryStateStore; graph: ReturnType<typeof compileOrThrow> } {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/step@stable", () => ({ writes: { out: "done" } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now,
    maxParallelism: 2,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
  return { engine, store, graph: compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] }) };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

function countOf(log: readonly JournalEvent[], type: string): number {
  return log.filter((ev) => ev.type === type).length;
}

/** The tick counts a reviewer measured the window across. Every one of them must pause. */
const TICKS = [24, 28, 32, 34, 36, 38, 40, 42, 44, 48, 52, 56];

for (const ticks of TICKS) {
  test(`PAUSE LANDS ON A RUN THAT IS MID-WAVE — ${String(ticks)} microtask ticks in`, async () => {
    const { engine, store, graph } = plane();
    const runId: RunId = await engine.submit({ graph, inputs: { seed: "s" } });

    const advancing = engine.advance(runId);
    for (let i = 0; i < ticks; i++) await Promise.resolve();

    const paused = await engine.pause(runId, "console").then(
      () => undefined,
      (cause: unknown) => cause,
    );
    await advancing.catch(() => undefined);

    const log = await events(store, runId);
    const trace = `suspended=${String(countOf(log, "run.suspended"))} events=${String(log.length)}`;

    assert.equal(paused, undefined, `pause was refused on a busy run at ticks=${String(ticks)}: ${String(paused)} — ${trace}`);
    assert.equal(countOf(log, "run.suspended"), 1, `the brake did not journal exactly one suspension: ${trace}`);
    assert.equal(countOf(log, "run.succeeded"), 0, `the run ran to completion through a pause: ${trace}`);

    const p = await engine.projection(runId);
    assert.equal(p?.paused, true, `projection says the run is not paused: ${trace}`);
  });
}
