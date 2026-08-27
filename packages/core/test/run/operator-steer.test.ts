/**
 * STEER: AN OPERATOR PUTS A RUNNING GRAPH ONTO A DIFFERENT EDGE THE AUTHOR DECLARED.
 *
 * `TODO.md` §D.4 fixes the shape and the bound: "steer is confined to the compiled edge set,
 * exactly as a `router` is", and it must not reach an edge the compiled graph does not
 * contain — that is `graph:mutate`, a capability a tenant either holds or does not, and
 * routing around it from the operator surface would be oversight loosening itself.
 *
 * The four refusals are the content, because the happy path is one field. In order of how
 * badly each would break something:
 *
 *   1. AN EDGE THE NODE DOES NOT DECLARE. `#activate` looks an edge id up in the WHOLE
 *      graph's edge table, so a `take` naming another node's edge activates that node's
 *      target and jumps everything in between — a `human_gate` included. That is the exact
 *      hole `#strayRoute` was written for on the body path and `#applyGateDecision` on the
 *      human path; steer is the third door onto it.
 *   2. A NON-HUMAN CALLER. Choosing a route is a decision the program otherwise makes for
 *      itself, and an operator overriding it may pick an arm with less oversight on it —
 *      which a human is allowed to do and an automated path is not. So the actor is checked
 *      rather than defaulted, and there is no `SYSTEM_ACTOR` fallback the way `cancel` has one.
 *   3. AN EMPTY `take`. "Go nowhere" is a run that stops with no terminal event, which is
 *      `cancel`'s job and is reported honestly there.
 *   4. A RUN THIS PROCESS HOLDS NO GRAPH FOR. The declared edge set lives in the compiled
 *      graph; without it there is nothing to confine the operator to, and guessing is the one
 *      thing a guard may not do.
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
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const OPERATOR = { kind: "human", subject: "u:ops", via: "cli" } as const;

/** One node with two declared arms. The smallest graph in which a route is a choice. */
function forkSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "steer-fork", project: "demo", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1, tokens: 1000, wallMs: 60_000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      capabilities: [],
    },
    channels: {
      seed: { type: "string", reduce: "replace" },
      safeMark: { type: "string", reduce: "replace" },
      riskyMark: { type: "string", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["safeMark"],
    nodes: [
      { id: n("start"), type: "function", reads: ["seed"], function: { ref: "function/start@stable" } },
      { id: n("pick"), type: "function", reads: ["seed"], function: { ref: "function/pick@stable" } },
      { id: n("safe"), type: "function", reads: ["seed"], writes: ["safeMark"], function: { ref: "function/safe@stable" } },
      { id: n("risky"), type: "function", reads: ["seed"], writes: ["riskyMark"], function: { ref: "function/risky@stable" } },
    ],
    edges: [
      { id: e("e0"), from: n("start"), to: n("pick"), kind: "seq" },
      { id: e("e_safe"), from: n("pick"), to: n("safe"), kind: "seq" },
      { id: e("e_risky"), from: n("pick"), to: n("risky"), kind: "seq" },
    ],
  };
}

function compileFork(): RunGraph {
  return compileOrThrow({ spec: forkSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
}

interface Rig {
  readonly engine: Engine;
  readonly ran: string[];
}

function rig(store: MemoryStateStore, duringStart?: () => Promise<void>): Rig {
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
  // LEFT TO ITSELF THE GRAPH GOES `risky`. That is the program's own choice, and a steer that
  // agreed with it would prove nothing.
  functions.register("function/start@stable", async () => {
    ran.push("start");
    if (duringStart !== undefined) await duringStart();
    return {};
  });
  functions.register("function/pick@stable", () => {
    ran.push("pick");
    return { take: ["e_risky"] };
  });
  functions.register("function/safe@stable", () => {
    ran.push("safe");
    return { writes: { safeMark: "safe" } };
  });
  functions.register("function/risky@stable", () => {
    ran.push("risky");
    return { writes: { riskyMark: "risky" } };
  });
  return { engine, ran };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

test("A STEER PUTS THE RUN ON THE OTHER DECLARED ARM, AND SURVIVES A RESTART DOING IT", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  let runId: RunId | undefined;
  // pause → steer → resume is the workflow, and the graph has a `start` node in front of the
  // fork for a reason that is a real bound rather than fixture convenience: a steer is read
  // when a node is DISPATCHED, and a pause lets the wave IN FLIGHT commit. So pausing while
  // `pick` itself runs would be too late — `pick` would commit its own `take` on the way out,
  // and the steer would arrive to find the route already journaled. An operator's steer takes
  // effect on the next node to be dispatched, never on the one they were watching.
  const first = rig(store, async () => {
    await first.engine.pause(runId!, "deciding which arm");
  });
  runId = await first.engine.submit({ graph: compileFork(), inputs: { seed: "s" } });
  await first.engine.advance(runId);
  assert.deepEqual(first.ran, ["start"], "paused before `pick` was dispatched, which is when a steer is read");

  // A SECOND ENGINE — the steer is journaled, so the plane that applies it need not be the
  // plane that received it.
  const second = rig(store);
  second.engine.attach(runId, compileFork());
  await second.engine.steer(runId, { nodeId: n("pick"), take: [e("e_safe")] }, "the risky arm is not wanted", OPERATOR);
  await second.engine.resume(runId, "go");
  const done = await second.engine.advance(runId);

  assert.deepEqual(second.ran, ["pick", "safe"], "the steered arm ran and the program's own choice did not");
  assert.equal(done.channels["safeMark"], "safe");
  assert.equal(done.channels["riskyMark"], undefined, "the arm the program chose was not also taken");
  assert.equal(done.status, "succeeded");

  const log = await events(store, runId);
  const steer = log.find((ev) => ev.type === "operator.command" && (ev.payload as { kind: string }).kind === "steer");
  assert.ok(steer !== undefined, "an operator changing a run's course is on the record or it did not happen");
  assert.equal(steer.actor.kind, "human");
  assert.deepEqual((steer.payload as unknown as { args: { take: unknown } }).args.take, ["e_safe"]);
});

test("A STEER ONTO AN EDGE THE NODE DOES NOT DECLARE IS REFUSED, AND NOTHING IS JOURNALED", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const r = rig(store);
  const runId = await r.engine.submit({ graph: compileFork(), inputs: { seed: "s" } });

  await assert.rejects(
    () => r.engine.steer(runId, { nodeId: n("pick"), take: [e("e_invented")] }, "somewhere else", OPERATOR),
    (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_ROUTE_INVALID,
    "an operator may not invent an edge any more than a model or an approver may",
  );
  // AND AN EDGE THAT EXISTS BUT BELONGS TO ANOTHER NODE is the same refusal — that is the
  // shape that jumps a human gate, not a typo.
  await assert.rejects(
    () => r.engine.steer(runId, { nodeId: n("safe"), take: [e("e_risky")] }, "jump", OPERATOR),
    (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_ROUTE_INVALID,
  );
  await assert.rejects(
    () => r.engine.steer(runId, { nodeId: n("nowhere"), take: [e("e_safe")] }, "no such node", OPERATOR),
    (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_ROUTE_INVALID,
  );

  const log = await events(store, runId);
  assert.equal(
    log.some((ev) => ev.type === "operator.command"),
    false,
    "a refused command is not a command; journaling it would put an intervention nobody made on the record",
  );
});

test("AN AUTOMATED CALLER CANNOT STEER, AND AN EMPTY ROUTE IS NOT A ROUTE", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const r = rig(store);
  const runId = await r.engine.submit({ graph: compileFork(), inputs: { seed: "s" } });

  await assert.rejects(
    () =>
      r.engine.steer(
        runId,
        { nodeId: n("pick"), take: [e("e_safe")] },
        "the scheduler thought better of it",
        { kind: "system", component: "scheduler" } as never,
      ),
    (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_HUMAN_APPROVAL_REQUIRED,
    "a route an operator may take because they are a person is not one a component may take",
  );

  await assert.rejects(
    () => r.engine.steer(runId, { nodeId: n("pick"), take: [] }, "nowhere", OPERATOR),
    (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_ROUTE_INVALID,
    "stopping a run is `cancel`, which reports what it left unaccounted for",
  );
});

test("A RUN THIS PROCESS HOLDS NO GRAPH FOR CANNOT BE STEERED", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const first = rig(store);
  const runId = await first.engine.submit({ graph: compileFork(), inputs: { seed: "s" } });

  // A restart that has not re-attached. `cancel` and `pause` deliberately work here — they are
  // a projection and two appends. `steer` cannot: the declared edge set it must confine the
  // operator to lives in the compiled graph, and there is nothing else to check against.
  const detached = rig(store);
  await assert.rejects(
    () => detached.engine.steer(runId, { nodeId: n("pick"), take: [e("e_safe")] }, "blind", OPERATOR),
    (thrown: unknown) => isLoomError(thrown) && thrown.code === CODES.E_RUN_NOT_FOUND,
    "guessing at the edge set is the one thing a guard that cannot decide may not do",
  );
});
