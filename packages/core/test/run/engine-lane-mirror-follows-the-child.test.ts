/**
 * A child gate answered in the CHILD's own console reaches the parent waiting on its mirror.
 *
 * A subgraph node parks its parent on a MIRROR of the child gate it is waiting on. Answering the
 * mirror forwarded into the child (`#forwardGateDecision`); answering the child's own gate —
 * which `GET /gates` lists beside the mirror — forwarded nowhere. Measured at 294e713 on the
 * fixture below: child gate approved, child moved on to its next question, parent `awaiting_gate`
 * with the mirror `open`, and no later `advance` of the parent changed that.
 *
 * The forward is read off the JOURNAL when the child advances (`#forwardToParentMirrors`), so it
 * does not matter which door decided the child gate: the second test writes `gate.decided`
 * through the broker directly, bypassing `Engine.resolveGate`, and the third answers from a fresh
 * engine over the same store with the parent never attached — the restart shape. It appends the
 * mirror's decision and drives nothing; the parent is advanced by whoever drives runs, which in
 * these tests is the test.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, GateId, NodeId, RunId } from "../../src/ids.ts";
import type { Actor } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import type { GateRecord, RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;
const LEAD = "u:security-lead";
const lead: Actor = { kind: "human", subject: LEAD, via: "console" };

const TOOLS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: false },
};

/** The child: doubles a number, asks a named human, then charges — an irreversible tool. */
const child: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "double", project: "sub", version: 1 },
  policy: { posture: "out", capabilities: ["pay"] },
  channels: {
    amount: { type: "number", reduce: "replace" },
    doubled: { type: "number", reduce: "replace" },
    receipt: { type: "object", reduce: "replace" },
  },
  inputs: ["amount"],
  outputs: ["receipt"],
  nodes: [
    { id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
    { id: n("approve"), type: "human_gate", reads: ["doubled"], humanGate: { ref: "oversight/charge@stable", approval: { approvers: [LEAD] } } },
    { id: n("charge"), type: "tool", reads: ["doubled"], writes: ["receipt"], tool: { name: "pay.charge", version: "1.0", args: { amount: "${doubled}" } }, unhandled: true },
  ],
  edges: [
    { id: e("c"), from: n("double"), to: n("approve"), kind: "seq" },
    { id: e("g"), from: n("approve"), to: n("charge"), kind: "seq" },
  ],
} as unknown as GraphSpec;

const parent: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "parent", project: "sub", version: 1 },
  policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 }, capabilities: ["pay"] },
  channels: { total: { type: "number", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
  inputs: ["total"],
  outputs: ["result"],
  nodes: [
    {
      id: n("delegate"),
      type: "subgraph",
      reads: ["total"],
      writes: ["result"],
      subgraph: { ref: "graph/double@stable", inputs: { amount: "total" }, outputs: { result: "receipt" }, budgetShare: 0.5 },
    },
  ],
  edges: [],
} as unknown as GraphSpec;

const resolver: ResourceResolver = {
  resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
  subgraph: (ref) => (ref === "graph/double@stable" ? child : undefined),
};

function rig(store = new MemoryStateStore({ now: () => NOW })) {
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const charges: number[] = [];
  const charge: ToolDefinition = {
    ...TOOLS["pay.charge"]!,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args) => {
      charges.push(Number(args["amount"]));
      return { content: "charged", writes: { receipt: { ok: true, amount: Number(args["amount"]) } } };
    },
  };
  tools.register(charge);
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => NOW,
    resolver,
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const graph = compileOrThrow({ spec: parent, resolver, tools: TOOLS, tenantCapabilities: ["pay"] });
  return { engine, store, charges, graph };
}

const open = (p: RunProjection): GateRecord | undefined => Object.values(p.gates).find((g) => g.state === "open");

/** Submit the parent and park it on the mirror of the child's first gate. */
async function parked(r: ReturnType<typeof rig>) {
  const runId = await r.engine.submit({ graph: r.graph, inputs: { total: 10 } });
  let p = await r.engine.advance(runId);
  // The parent's own pre-delegation gate (its compile floor folds in the child's irreversible
  // tool) is not a mirror; step past it.
  const own = Object.values(p.gates).find((g) => g.state === "open" && g.mirrorOf === undefined);
  if (own !== undefined) {
    p = await r.engine.resolveGate(runId, { gateId: own.gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:a", via: "console" }, idempotencyKey: "own" });
  }
  assert.equal(p.status, "awaiting_gate");
  const mirror = open(p)!;
  assert.ok(mirror.mirrorOf !== undefined, "parked on a mirror");
  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childGate = open((await r.engine.projection(childRunId))!)!;
  assert.equal(mirror.mirrorOf, childGate.gateId);
  return { runId, childRunId, mirror, childGate };
}

test("APPROVING THE CHILD'S OWN GATE DECIDES THE PARENT'S MIRROR, and the parent then finishes on the child's result", async () => {
  const r = rig();
  const { runId, childRunId, mirror, childGate } = await parked(r);

  // The human answers in the CHILD's console.
  let childP = await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c1" });
  let parentP = (await r.engine.projection(runId))!;
  assert.equal(parentP.gates[mirror.gateId]?.state, "decided", "at 294e713 the mirror stayed open forever");
  assert.equal(parentP.gates[mirror.gateId]?.decision, "approve");
  assert.equal(parentP.gates[mirror.gateId]?.decidedBy, "system");
  assert.equal(parentP.status, "running", "`gate.decided` carries `run.resumed`, which is what makes the run clock offer it");

  // The child moved on to its next question — the charge's own posture gate — and the parent,
  // when driven, mirrors THAT one.
  assert.equal(childP.status, "awaiting_gate");
  parentP = await r.engine.advance(runId);
  assert.equal(parentP.status, "awaiting_gate");
  const second = open(parentP)!;
  assert.equal(second.mirrorOf, open(childP)!.gateId, "a fresh mirror, bound to the child's second gate");

  // Answer that one in the child's console too.
  childP = await r.engine.resolveGate(childRunId, { gateId: open(childP)!.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c2" });
  assert.equal(childP.status, "succeeded");
  assert.deepEqual(r.charges, [20]);
  parentP = await r.engine.advance(runId);
  assert.equal(parentP.status, "succeeded", JSON.stringify(parentP.error ?? {}));
  assert.deepEqual(parentP.channels["result"], { ok: true, amount: 20 });
  assert.deepEqual(r.charges, [20], "charged once");
});

test("WHICHEVER DOOR DECIDED THE CHILD GATE — the broker written directly, not `Engine.resolveGate`", async () => {
  const r = rig();
  const { runId, childRunId, mirror, childGate } = await parked(r);
  // The sweeper's default action, dedupe and the batch door all reach the journal without
  // `Engine.resolveGate`; a direct broker write stands in for all three.
  const broker = new HumanGateBroker({ now: () => NOW });
  await broker.resolve(new RunLog(childRunId, { store: r.store, now: () => NOW }), {
    gateId: childGate.gateId,
    decision: { kind: "approve" },
    actor: lead,
    idempotencyKey: "direct",
  });
  assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "open", "nothing has driven the child yet");
  await r.engine.advance(childRunId);
  assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "decided", "the child's advance read the decision off the fold and answered the mirror");
});

test("ACROSS A RESTART, WITH THE PARENT NEVER ATTACHED — the decision lands on the parent's own log", async () => {
  const first = rig();
  const { runId, childRunId, mirror, childGate } = await parked(first);

  // A new process over the same store: only the child is attached (that is what a gate decision
  // on the child binds), and the parent is not.
  const second = rig(first.store);
  const childGraph = first.graph.subgraphs["graph/double@stable"]!;
  second.engine.attach(childRunId, compileOrThrow({ spec: childGraph, resolver, tools: TOOLS, tenantCapabilities: ["pay"] }));
  await second.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "r1" });
  const parentP = (await second.engine.projection(runId))!;
  assert.equal(parentP.gates[mirror.gateId]?.state, "decided");
  assert.equal(parentP.status, "running");
  assert.equal(Object.values(parentP.tasks).find((t) => t.nodeId === n("delegate"))?.state, "ready", "what `runClockTick` counts as due");
  // The parent, attached later, carries on from there.
  second.engine.attach(runId, second.graph);
  const driven = await second.engine.advance(runId);
  assert.equal(driven.status, "awaiting_gate", "mirroring the child's second gate now");
  assert.notEqual(open(driven)!.gateId, mirror.gateId);
});

test("A REJECTION IN THE CHILD'S CONSOLE IS THE CHILD'S TO HANDLE — the parent reads the child's outcome and cancels nothing", async () => {
  const r = rig();
  const { runId, childRunId, mirror, childGate } = await parked(r);
  const childP = await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "reject", reason: "not at this amount" }, actor: lead, idempotencyKey: "no" });
  assert.equal(childP.status, "failed", "the child failed on its own gate, through its own graph");
  assert.deepEqual(r.charges, []);
  const parentP = (await r.engine.projection(runId))!;
  assert.equal(parentP.gates[mirror.gateId]?.decision, "approve", "the mirror says `wait for the child`, never `cancel the child`");
  const done = await r.engine.advance(runId);
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, CODES.E_SUBGRAPH_FAILED);
  assert.match(done.error?.message ?? "", /ended failed/);
  assert.equal((await r.engine.projection(childRunId))!.status, "failed", "not cancelled — the child's own verdict stands");
});

test("THE OTHER DIRECTION IS UNCHANGED — approving the MIRROR still forwards into the child (the ordinary half)", async () => {
  const r = rig();
  const { runId, childRunId, mirror } = await parked(r);
  let p = await r.engine.resolveGate(runId, { gateId: mirror.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "m1" });
  assert.equal(p.status, "awaiting_gate");
  p = await r.engine.resolveGate(runId, { gateId: open(p)!.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "m2" });
  assert.equal(p.status, "succeeded");
  assert.deepEqual(r.charges, [20]);
  const childP = (await r.engine.projection(childRunId))!;
  assert.ok(Object.values(childP.gates).every((g) => g.state === "decided"));
  assert.equal(childP.status, "succeeded");
  // And no mirror was decided twice: the child's decisions were made BY the forward, and the
  // reverse direction saw them already closed.
  const decidedBySystem = Object.values(p.gates).filter((g: GateRecord) => g.decidedBy === "system");
  assert.deepEqual(decidedBySystem, [], "every parent-side decision here was the human's");
  void (null as unknown as GateId);
});
