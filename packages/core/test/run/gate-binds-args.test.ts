/**
 * AN APPROVAL BINDS WHAT THE NODE WILL EXECUTE, NOT ONLY THE GRAPH AND THE TASK.
 *
 * README claimed "an approval binds the graph it was shown". It bound the graph and the Task
 * and stopped there: `contentDigest` appeared in `run/engine.ts` three times and all three were
 * comments, so nothing anywhere compared the payload an approver was shown against the payload
 * that was later dispatched. Measured on a real Engine before the fix, with the graph below and
 * its only extra node an ordinary same-wave `function`:
 *
 *     status awaiting_gate  target "EVIL"
 *     gate payload shown    state={"target":"SAFE"}
 *     after approve         status succeeded  tool received body="EVIL"
 *
 * The console showed `SAFE`, the tool wrote `EVIL`, and the digest never moved — `openGates`
 * keeps serving the raise-time payload, so nothing an operator could look at said otherwise.
 *
 * WHAT EACH TEST HERE IS FOR, so a narrow revert cannot leave the file green:
 *
 *   1. the refusal itself, and that the tool never ran;
 *   2. THE CONTROL — an unmutated approval still executes. A guard that refuses everything
 *      would pass 1 on its own, and this programme has shipped exactly that before;
 *   3. a channel that reaches the tool only through `tool.args` and is in no `reads` list.
 *      `#gatePayload` used `node.reads`, which is the same one-word bypass the taint rule and
 *      `dataClassification` were fixed for; a check built on `reads` refuses nothing here;
 *   4. THE RESTART. A second Engine over the same journal must reach the same verdict, because
 *      "the journal is the only authoritative state" and a guard living in a broker's memory is
 *      a guard that a restart switches off silently;
 *   5. that an `error` edge cannot route around the refusal into a run that reports SUCCEEDED —
 *      the shape `RUN_FATAL_CODES` exists for, reached one door over;
 *   6. that the refusal is a refusal and not a fresh question. Re-raising was the alternative
 *      and was rejected: whoever can write the channel could then aim an unbounded stream of
 *      approval requests at a human.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import type { EdgeId, GateId, NodeId, RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { HumanActor, JournalEvent } from "../../src/journal/events.ts";
import { CODES } from "../../src/errors.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;
const alice: HumanActor = { kind: "human", subject: "u:alice", via: "console" };

const MANIFEST: Record<string, ToolManifestLite> = {
  "fs.write": {
    name: "fs.write",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
  },
};

/**
 * How the gated node reaches the value it will write.
 *
 *   - `read`: `reads: ["target"]`, the ordinary declared shape;
 *   - `args-only`: the channel is named ONLY inside `tool.args`. It still reaches the tool,
 *     because arguments resolve against `scopeFor` — every channel, declared or not.
 */
type Reach = "read" | "args-only";

interface Shape {
  readonly reach: Reach;
  /** Add a same-wave `function` node that rewrites the channel the gated node will use. */
  readonly mutate: boolean;
  /** Give the gated node an `error` edge, to prove a failure cannot be routed around. */
  readonly errorEdge?: boolean;
  /**
   * Make the gated node a `function` instead of a `tool`.
   *
   * WHY THIS OPTION EXISTS. Every case here used to gate a `tool` node, where
   * `#gateBinding`'s `args` fingerprint independently covers the channel. A verifier dropped
   * `state: view.hash` from the binding — one line — and all six tests stayed green while a
   * gated `function` node executed an unapproved value. `function`, `agent`, `evaluator`,
   * `router`, `join` and `subgraph` have no `args` to fall back on, so `state` is the ONLY
   * thing binding them, and nothing pinned it.
   */
  readonly nonTool?: boolean;
}

function spec(shape: Shape): GraphSpec {
  const applyNode: Record<string, unknown> = shape.nonTool === true
    ? {
        id: n("apply"),
        type: "function",
        reads: ["target"],
        writes: ["written"],
        policy: { posture: "in" },
        function: { ref: "function/echo@stable" },
      }
    : {
        id: n("apply"),
        type: "tool",
        ...(shape.reach === "read" ? { reads: ["target"] } : {}),
        writes: ["written"],
        policy: { posture: "in" },
        tool: { name: "fs.write", version: "1.0", args: { path: "out/x", body: "${target}" } },
      };
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: `gate-binds-args-${shape.reach}`, project: "probe", version: 1 },
    policy: {
      posture: "out",
      capabilities: ["fs:write"],
      expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 },
    },
    channels: {
      seed: { type: "string", reduce: "replace" },
      target: { type: "string", reduce: "replace" },
      written: { type: "object", reduce: "replace" },
      rescued: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["written"],
    nodes: [
      { id: n("start"), type: "function", reads: ["seed"], writes: ["target"], function: { ref: "function/seed@stable" } },
      ...(shape.mutate
        ? [{ id: n("mutate"), type: "function", reads: ["seed"], writes: ["target"], function: { ref: "function/mutate@stable" } }]
        : []),
      applyNode,
      ...(shape.errorEdge === true
        ? [{ id: n("rescue"), type: "function", reads: ["seed"], writes: ["rescued"], function: { ref: "function/seed@stable" } }]
        : []),
    ],
    edges: [
      { id: e("sa"), from: n("start"), to: n("apply"), kind: "seq" },
      ...(shape.mutate ? [{ id: e("sm"), from: n("start"), to: n("mutate"), kind: "seq" }] : []),
      ...(shape.errorEdge === true ? [{ id: e("er"), from: n("apply"), to: n("rescue"), kind: "error" }] : []),
    ],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly graph: RunGraph;
  /** Every `body` argument the tool actually received. Empty means it never ran. */
  readonly bodies: string[];
}

function engineOver(store: MemoryStateStore, bodies: string[]): Engine {
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({ writes: { target: "SAFE" } }));
  functions.register("function/mutate@stable", () => ({ writes: { target: "EVIL" } }));
  // Records the value it was HANDED, so a non-tool gated node can be asked the same question
  // the tool one is: did you execute what the approver approved?
  functions.register("function/echo@stable", (view) => {
    const saw = view.get<string>("target");
    bodies.push(String(saw));
    return { writes: { written: { saw } } };
  });

  const tools = new ToolRegistry();
  const fsWrite: ToolDefinition = {
    ...MANIFEST["fs.write"]!,
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, body: { type: "string" } },
      required: ["path", "body"],
    },
    execute: (args) => {
      bodies.push(String(args["body"]));
      return { content: "ok", writes: { written: { body: String(args["body"]) } } };
    },
  };
  tools.register(fsWrite);

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  return new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now: () => NOW,
    maxParallelism: 4,
    policy: { granted: ["fs:write"], budget: { runUsd: 1 } },
  });
}

function rig(shape: Shape): Rig {
  const store = new MemoryStateStore({ now: () => NOW });
  const bodies: string[] = [];
  const engine = engineOver(store, bodies);
  const graph = compileOrThrow({
    spec: spec(shape),
    resolver: resolver(),
    tools: MANIFEST,
    tenantCapabilities: ["fs:write"],
  });
  return { engine, store, graph, bodies };
}

/** Run until the gate on `apply` is open, and return it. */
async function parked(r: Rig): Promise<{ runId: RunId; gateId: GateId; shown: unknown }> {
  const runId = await r.engine.submit({ graph: r.graph, inputs: { seed: "s" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));
  const open = (await r.engine.openGates(runId)).filter((g) => g.state === "open");
  assert.equal(open.length, 1, "exactly one gate, on the node that will execute");
  assert.equal(open[0]!.nodeId, n("apply"));
  return { runId, gateId: open[0]!.gateId, shown: open[0]!.payload };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

const approve = { kind: "approve" } as const;

/**
 * Answer the gate and let the run continue. `Engine.resolveGate` advances on the way out, so
 * the returned projection is already the state after the dispatch that the approval permits —
 * there is no second `advance` to forget.
 */
async function decide(engine: Engine, runId: RunId, gateId: GateId): Promise<RunProjection> {
  return engine.resolveGate(runId, { gateId, decision: approve, actor: alice, idempotencyKey: "k" });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · the refusal
// ─────────────────────────────────────────────────────────────────────────────

test("AN APPROVED PAYLOAD THAT CHANGED BEFORE DISPATCH IS REFUSED, and the tool never runs", async () => {
  const r = rig({ reach: "read", mutate: true });
  const { runId, gateId, shown } = await parked(r);

  // What the approver is looking at, and what the channel already says. The gap between these
  // two lines is the whole finding.
  assert.deepEqual((shown as { state: Record<string, unknown> }).state, { target: "SAFE" });
  const after = await decide(r.engine, runId, gateId);

  assert.deepEqual(r.bodies, [], "the tool must not have been called at all");
  assert.equal(after.status, "failed", "the run stops rather than executing an unapproved payload");

  const failed = Object.values(after.tasks).find((t) => t.nodeId === n("apply"));
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.error?.code, CODES.E_GATE_REQUIRED, failed?.error?.message);
  // The operator has to be able to see WHICH approval no longer covers WHAT.
  const details = failed?.error?.details as Record<string, unknown> | undefined;
  assert.equal(details?.["gateId"], gateId);
  assert.notEqual(details?.["approvedDigest"], details?.["currentDigest"], "both digests are reported");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · the control — a guard that refuses everything is not a guard
// ─────────────────────────────────────────────────────────────────────────────

test("AND AN UNMUTATED APPROVAL STILL EXECUTES — the control", async () => {
  const r = rig({ reach: "read", mutate: false });
  const { runId, gateId } = await parked(r);
  const after = await decide(r.engine, runId, gateId);

  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
  assert.deepEqual(r.bodies, ["SAFE"], "the approved payload is the one the tool received");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · the channel that is in no `reads` list
// ─────────────────────────────────────────────────────────────────────────────

test("A CHANNEL THAT REACHES THE TOOL ONLY THROUGH `tool.args` IS BOUND TOO", async () => {
  // `reads` is not the set that reaches a tool: arguments resolve against `scopeFor`, which is
  // every channel. A gate payload rendered from `node.reads` showed the approver a question with
  // the operative value missing, and a check derived from `reads` would compare a set that does
  // not contain the thing being swapped. `observedChannels` is the set, and it is the same
  // correction `#executeTask`'s taint rule and `dataClassification` already carry.
  const shownOf = async (mutate: boolean): Promise<unknown> => {
    const r = rig({ reach: "args-only", mutate });
    const { shown } = await parked(r);
    return shown;
  };
  // First: the approver is actually shown it, despite it not being declared.
  assert.deepEqual((await shownOf(false) as { state: Record<string, unknown> }).state, { target: "SAFE" });

  const r = rig({ reach: "args-only", mutate: true });
  const { runId, gateId } = await parked(r);
  const after = await decide(r.engine, runId, gateId);

  assert.deepEqual(r.bodies, [], "the undeclared channel is still what the tool would have received");
  assert.equal(after.status, "failed");
  assert.equal(
    Object.values(after.tasks).find((t) => t.nodeId === n("apply"))?.error?.code,
    CODES.E_GATE_REQUIRED,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · the restart
// ─────────────────────────────────────────────────────────────────────────────

test("THE REFUSAL SURVIVES A RESTART, because it is derived from the journal and not remembered", async () => {
  // THE DECISION IS TAKEN IN A PROCESS THAT NEVER RAISED THE GATE, which is the only version of
  // this test worth having. `Engine.resolveGate` advances on the way out, so answering on the
  // engine that raised the gate would dispatch inside the process still holding the raise-time
  // payload in `HumanGateBroker`'s `#ephemeral` map — and a check reading from there would look
  // exactly like a check reading from the journal. Here the second Engine has an empty broker.
  const r = rig({ reach: "read", mutate: true });
  const { runId, gateId } = await parked(r);

  const bodies: string[] = [];
  const revived = engineOver(r.store, bodies);
  await revived.attach(runId, r.graph);
  const after = await decide(revived, runId, gateId);

  assert.deepEqual(bodies, [], "the mutated payload must not execute in the new process either");
  assert.deepEqual(r.bodies, [], "nor in the old one");
  assert.equal(after.status, "failed");
  assert.equal(
    Object.values(after.tasks).find((t) => t.nodeId === n("apply"))?.error?.code,
    CODES.E_GATE_REQUIRED,
  );

  // And the control's other half: a run that was never mutated still completes when it is
  // answered by a second process, so the restart itself is not what refuses.
  const clean = rig({ reach: "read", mutate: false });
  const parkedClean = await parked(clean);
  const cleanBodies: string[] = [];
  const cleanRevived = engineOver(clean.store, cleanBodies);
  await cleanRevived.attach(parkedClean.runId, clean.graph);
  const cp = await decide(cleanRevived, parkedClean.runId, parkedClean.gateId);
  assert.equal(cp.status, "succeeded", JSON.stringify(cp.error ?? {}));
  assert.deepEqual(cleanBodies, ["SAFE"]);
  assert.deepEqual(clean.bodies, [], "the engine that raised the gate did not run the tool");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · an error edge may not route around it
// ─────────────────────────────────────────────────────────────────────────────

test("AN `error` EDGE CANNOT TURN THE REFUSAL INTO A RUN THAT SUCCEEDED", async () => {
  // The reason `RUN_FATAL_CODES` exists, reached through the door next to the one it was built
  // for: an ordinary failed Task takes its error edge, the run carries on, and the graph that
  // reads "this action is human-approved" reports **succeeded** having dispatched nothing a
  // human agreed to. `E_GATE_REQUIRED` is the code for "this action needs a decision that
  // cannot be obtained", which is exactly what a voided approval is.
  const r = rig({ reach: "read", mutate: true, errorEdge: true });
  const { runId, gateId } = await parked(r);
  const after = await decide(r.engine, runId, gateId);

  assert.deepEqual(r.bodies, []);
  assert.notEqual(after.status, "succeeded", "an error edge must not absorb a voided approval");
  assert.equal(after.status, "failed");
  // THE EDGE MUST NOT HAVE BEEN TAKEN AT ALL, which is the half a status check misses: a
  // non-fatal code leaves the run `failed` here too, and would still have run the handler and
  // everything downstream of it. `rescued` is written by that handler and by nothing else.
  // THE HANDLER MUST NOT HAVE RUN, which is the half a status check misses: a non-fatal code
  // leaves the run `failed` here too, having taken the edge, run the handler, and carried on
  // through everything downstream of it. `rescued` is written by that handler and by nothing
  // else. The Task for it may EXIST — `#activate` writes the edge's target before `advance`
  // reads the fatal code and stops — and that is the difference between an activated edge and
  // a taken one.
  assert.equal(after.channels["rescued"], undefined, "the handler behind the error edge never ran");
  assert.notEqual(Object.values(after.tasks).find((t) => t.nodeId === n("rescue"))?.state, "succeeded");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 · it refuses, it does not ask again
// ─────────────────────────────────────────────────────────────────────────────

test("IT REFUSES RATHER THAN RE-RAISING, so a mutation cannot summon approval requests", async () => {
  // The rejected alternative, pinned so a later change has to argue with it rather than drift
  // into it. Re-raising shows the human the new payload — friendlier, and it hands whoever can
  // write the channel an unbounded supply of fresh questions aimed at a person, with the run
  // alive the whole time. One `gate.raised` for this node, ever.
  const r = rig({ reach: "read", mutate: true });
  const { runId, gateId } = await parked(r);
  await decide(r.engine, runId, gateId);

  const raised = (await events(r.store, runId)).filter((ev) => ev.type === "gate.raised");
  assert.equal(raised.length, 1, "the approval is void; the answer to that is not another question");
  assert.equal((await r.engine.openGates(runId)).filter((g) => g.state === "open").length, 0);
});


// ─────────────────────────────────────────────────────────────────────────────
// 7 · the node types with no `args` to fall back on
// ─────────────────────────────────────────────────────────────────────────────

test("A GATED NON-TOOL NODE IS BOUND BY `state` ALONE, and that is the only thing binding it", async () => {
  // Added 2026-08-25 after a verifier dropped `state: view.hash` from `#gateBinding` — one line —
  // and every test above stayed green, because all of them gate a `tool` node whose `args`
  // fingerprint covers the same channel independently. `function`, `agent`, `evaluator`,
  // `router`, `join` and `subgraph` have no such fallback: five of the six node types the
  // binding claims to cover were unpinned.
  const r = rig({ reach: "read", mutate: true, nonTool: true });
  const { runId, gateId, shown } = await parked(r);

  assert.deepEqual((shown as { state: Record<string, unknown> }).state, { target: "SAFE" });
  const after = await decide(r.engine, runId, gateId);

  assert.deepEqual(r.bodies, [], "the body must not have run at all");
  assert.equal(after.status, "failed", "an unapproved value must not reach a function body either");
  const failed = Object.values(after.tasks).find((t) => t.nodeId === n("apply"));
  assert.equal(failed?.error?.code, CODES.E_GATE_REQUIRED, failed?.error?.message);
});

test("…and the control: an unmutated approval on a non-tool node still executes", async () => {
  const r = rig({ reach: "read", mutate: false, nonTool: true });
  const { runId, gateId } = await parked(r);
  const after = await decide(r.engine, runId, gateId);

  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
  assert.deepEqual(r.bodies, ["SAFE"], "the approved value is the one the body received");
});
