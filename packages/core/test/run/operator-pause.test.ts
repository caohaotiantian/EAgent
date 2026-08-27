/**
 * PAUSE AND RESUME ARE JOURNALED FACTS, NOT A FLAG IN A PROCESS.
 *
 * `run.suspended{reason:"operator"}` and `run.resumed{by:"operator"}` were declared in the
 * event vocabulary and had no appender: every writer in `src/` passed `"gate"`. The fold was
 * already written — `projection.ts` turns a non-gate suspension into `interrupted`, and
 * `#advanceSerially` already returns on `interrupted` — so what was missing was the
 * operator's end of a mechanism that was otherwise complete. An operator could cancel a run
 * and could not stop one.
 *
 * The four things this file pins, because each is a way to get pause wrong:
 *
 *   1. A pause stops the NEXT wave, not the current one. In-flight work commits.
 *   2. It survives a restart, because it is folded from the journal and from nothing else.
 *   3. A run paused by one Engine resumes on another over the same store.
 *   4. AN AUTOMATED PATH MAY NOT LIFT IT. `gate.decided` carries an unconditional
 *      `run.resumed{by:"gate"}`, which folds the status straight back to `running`; if the
 *      pause were only that status, answering a gate on a paused run would restart it and
 *      drive exactly the work the operator stopped — "oversight only tightens" broken by a
 *      path nobody would call a permission change. So `paused` is its own folded fact and
 *      only `run.resumed{by:"operator"}` clears it.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { compileSkeleton, DOCS, harness, resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

/** Two function nodes in a line: the smallest graph with a SECOND wave for a pause to stop. */
function chainSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "pause-chain", project: "demo", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1, tokens: 1000, wallMs: 60_000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      capabilities: [],
    },
    channels: {
      seed: { type: "string", reduce: "replace" },
      first: { type: "string", reduce: "replace" },
      second: { type: "string", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["second"],
    nodes: [
      { id: n("a"), type: "function", reads: ["seed"], writes: ["first"], function: { ref: "function/a@stable" } },
      { id: n("b"), type: "function", reads: ["first"], writes: ["second"], function: { ref: "function/b@stable" } },
    ],
    edges: [{ id: e("e1"), from: n("a"), to: n("b"), kind: "seq" }],
  };
}

function compileChain(): RunGraph {
  return compileOrThrow({ spec: chainSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
}

interface Rig {
  readonly engine: Engine;
  readonly ran: string[];
}

/** An Engine over a given store. Called twice with the SAME store to make a restart. */
function rig(store: MemoryStateStore, duringA?: () => Promise<void>): Rig {
  const ran: string[] = [];
  const functions = new FunctionRegistry();
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now: () => 1_700_000_000_000,
    maxParallelism: 4,
    policy: { granted: [], budget: { runUsd: 1 } },
  });
  functions.register("function/a@stable", async () => {
    ran.push("a");
    if (duringA !== undefined) await duringA();
    return { writes: { first: "a-done" } };
  });
  functions.register("function/b@stable", () => {
    ran.push("b");
    return { writes: { second: "b-done" } };
  });
  return { engine, ran };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

test("A PAUSE STOPS THE NEXT WAVE AND KEEPS WHAT IS IN FLIGHT", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  let runId: RunId | undefined;
  // The pause lands while node `a` is executing — the only moment at which "does it lose
  // what is in flight?" is a real question rather than a hypothetical one.
  const r = rig(store, async () => {
    await r.engine.pause(runId!, "operator is reading the output");
  });
  runId = await r.engine.submit({ graph: compileChain(), inputs: { seed: "s" } });
  const p = await r.engine.advance(runId);

  assert.deepEqual(r.ran, ["a"], "the wave in flight must finish; the next one must not start");
  assert.equal(p.channels["first"], "a-done", "the in-flight task's commit must still land");
  assert.equal(p.paused, true);
  assert.equal(p.suspendedReason, "operator");
  assert.equal(p.status, "interrupted", "a paused run is neither running nor finished");

  const log = await events(store, runId);
  assert.ok(
    log.some((ev) => ev.type === "operator.command" && (ev.payload as { kind: string }).kind === "pause"),
    "a human acting on a running system is an operator.command, or the journal cannot say who did it",
  );
  const suspend = log.find(
    (ev) => ev.type === "run.suspended" && (ev.payload as { reason: string }).reason === "operator",
  );
  assert.ok(suspend !== undefined, "run.suspended{reason:'operator'} is the durable half");
});

test("A PAUSE SURVIVES A RESTART, AND ANOTHER ENGINE RESUMES IT", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  let runId: RunId | undefined;
  const first = rig(store, async () => {
    await first.engine.pause(runId!, "hold");
  });
  runId = await first.engine.submit({ graph: compileChain(), inputs: { seed: "s" } });
  await first.engine.advance(runId);
  assert.deepEqual(first.ran, ["a"]);

  // A SECOND ENGINE OVER THE SAME STORE — a process restart, and a different plane from the
  // one that paused. It holds no memory of the pause at all.
  const second = rig(store);
  second.engine.attach(runId, compileChain());
  const stillPaused = await second.engine.advance(runId);
  assert.equal(stillPaused.paused, true, "a pause a restart forgets is not a pause");
  assert.deepEqual(second.ran, [], "the restarted engine must not pick the run back up");

  const resumed = await second.engine.resume(runId, "cleared");
  assert.equal(resumed.paused, false);
  const done = await second.engine.advance(runId);
  assert.deepEqual(second.ran, ["b"], "resume must hand back the work the pause held");
  assert.equal(done.status, "succeeded");

  const log = await events(store, runId);
  assert.ok(
    log.some((ev) => ev.type === "run.resumed" && (ev.payload as { by: string }).by === "operator"),
    "run.resumed{by:'operator'} is what distinguishes it from a gate's resume",
  );
});

test("ANSWERING A GATE DOES NOT LIFT AN OPERATOR'S PAUSE", async () => {
  // The loosening path. `gate.decided` ships an unconditional `run.resumed{by:"gate"}`, so
  // if a pause were only the `interrupted` status, a human answering an unrelated question
  // would restart a run an operator had deliberately stopped.
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS.slice(0, 2) } });
  const atGate = await h.engine.advance(runId);
  assert.equal(atGate.status, "awaiting_gate", "the fixture must reach the gate for this test to mean anything");

  await h.engine.pause(runId, "stop before the write");
  const gates = await h.engine.openGates(runId);
  assert.equal(gates.length, 1);
  await h.engine.resolveGate(runId, {
    gateId: gates[0]!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "a1",
  });
  const after = await h.engine.advance(runId);

  assert.equal(after.paused, true, "an automated resume must not clear an operator's pause");
  assert.deepEqual(h.writes, [], "the tool behind the gate must not run while the run is paused");

  // And the operator's own resume does hand it back.
  await h.engine.resume(runId, "go");
  await h.engine.advance(runId);
  assert.equal(h.writes.length, 1, "resume must let the approved work through");
});

test("PAUSING A RUN THAT HAS ENDED IS REFUSED RATHER THAN RECORDED", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const r = rig(store);
  const runId = await r.engine.submit({ graph: compileChain(), inputs: { seed: "s" } });
  const done = await r.engine.advance(runId);
  assert.equal(done.status, "succeeded");

  await assert.rejects(
    () => r.engine.pause(runId, "too late"),
    (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_ILLEGAL_TRANSITION,
    "a finished run cannot be paused, and a no-op returning success would tell an operator it was",
  );
});
