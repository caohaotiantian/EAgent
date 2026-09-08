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
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq } from "../../src/ids.ts";
import type { Actor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { isTerminal, type GateRecord, type RunProjection } from "../../src/run/projection.ts";
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

function rig(store = new MemoryStateStore({ now: () => NOW }), gates?: HumanGateBroker) {
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
    ...(gates === undefined ? {} : { gates }),
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

test("A TRANSIENT CONFLICT ON THE PARENT'S LOG IS RETRIED BY THE NEXT ADVANCE — the gate is marked answered, never merely looked at", async () => {
  // `#forwardToParentMirrors` marks a decided child gate in `ctx.mirrorsChecked` so the parent is
  // not re-folded on every pass. Marking the whole batch BEFORE trying the appends made the set a
  // record of what had been looked at rather than what had been answered, and the two differ on
  // the one path that matters: `RunLog.append` retries `E_SEQ_CONFLICT` internally
  // (MAX_APPEND_RETRIES = 8), so one that escapes to this method's catch means the retries were
  // EXHAUSTED — transient, and lost. Swallowed and marked, the mirror was never tried again and
  // the parent sat `awaiting_gate` on an `open` mirror for the life of the process: exactly the
  // 294e713 defect this file exists to close, restored under contention.
  //
  // THE LIAR IS BOUNDED — it refuses the parent's appends for one burst and then stops — so the
  // guarded tree and an unguarded one both terminate and differ, rather than one of them hanging.
  let refuseParent = false;
  let refusals = 0;
  class ContendedStore extends MemoryStateStore {
    override async append(input: Parameters<MemoryStateStore["append"]>[0]): ReturnType<MemoryStateStore["append"]> {
      // A child id is `${parentRunId}~${taskId}`, so an id with no `~` is the parent's log.
      if (refuseParent && !String(input.runId).includes("~")) {
        refusals++;
        throw err.conflict(CODES.E_SEQ_CONFLICT, `synthetic contention on ${String(input.runId)}`);
      }
      return super.append(input);
    }
  }
  const store = new ContendedStore({ now: () => NOW });

  const r = rig(store);
  const { runId, childRunId, mirror, childGate } = await parked(r);

  // The human answers in the child's console while the parent's log is under contention.
  refuseParent = true;
  const childP = await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c1" });
  assert.equal(childP.status, "awaiting_gate", "the child's own advance is not failed by the PARENT's contention");
  assert.ok(refusals >= 8, `the internal retries were exhausted, not merely brushed: ${String(refusals)} refusals`);
  assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "open", "the append genuinely did not land");

  // Contention clears, and the very next advance of the child answers the mirror.
  refuseParent = false;
  await r.engine.advance(childRunId);
  assert.equal(
    (await r.engine.projection(runId))!.gates[mirror.gateId]?.state,
    "decided",
    "the mirror was retried after the transient conflict, not written off as checked",
  );
});

test("A MIRROR THAT LANDS ON AN ALREADY-DECIDED CHILD GATE IS ANSWERED BY THE SAME ADVANCE THAT RAISED IT", async () => {
  // THE RACE THE CHILD-SIDE FORWARD CANNOT SEE. `#runSubgraph` decides to raise a mirror while
  // its body runs, and the `gate.raised` is not appended until the parent's whole wave commits.
  // A human answering the CHILD's gate inside that window is forwarded by the child, which finds
  // no mirror — there is none yet — and the mirror then lands OPEN on a gate already decided.
  //
  // AND NOTHING COMES BACK FOR IT. The child is terminal by then, so it is retired, and
  // `#advanceSerially` answers a retired terminal run from the fold and returns before the
  // forward ever runs; the parent is `awaiting_gate`, which no run clock counts as due. Both ends
  // stop. Measured before the parent-side half existed, driving the parent five more times:
  // `parent status: awaiting_gate  open mirror: gate_…RY  mirrorOf: gate_…RX  child gate state:
  // decided`.
  //
  // THE SLOW SIBLING IS THE WINDOW, held open by hand so the race is a fact rather than a timing
  // hope: the wave cannot commit the mirror until `t.slow` returns, and the test decides the
  // child's gate first and releases it after.
  const store = new MemoryStateStore({ now: () => NOW });
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const r = rig(store);
  r.engine.tools.register({
    name: "t.slow",
    version: "1.0",
    // `pay`, because that is what this rig's engine GRANTS — a `*` here fails the task
    // E_CAP_DENIED before it can hold the wave open, and then there is no window and no race.
    capabilities: ["pay"],
    irreversibility: "read_only",
    idempotent: true,
    description: "wait",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      await held;
      return { content: "ok", writes: { slow: "ok" } };
    },
  } as ToolDefinition);

  const racy = JSON.parse(JSON.stringify(parent)) as {
    policy: { capabilities: string[] };
    channels: Record<string, unknown>;
    nodes: unknown[];
  };
  racy.policy.capabilities = ["pay"];
  racy.channels["slow"] = { type: "string", reduce: "replace" };
  racy.nodes.push({ id: n("wait"), type: "tool", reads: ["total"], writes: ["slow"], tool: { name: "t.slow", version: "1.0", args: {} } });
  // THE CHARGE IS READ-ONLY IN THIS FIXTURE ONLY, because the parent's own compile floor —
  // raised by the child's irreversible tool — would park the parent on a gate of its OWN before
  // it ever delegates, and this test is about the mirror. The child's `human_gate` is untouched:
  // it is the gate the race is run on.
  const manifests = {
    "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "read_only", idempotent: true },
    "t.slow": { name: "t.slow", version: "1.0", capabilities: ["pay"], irreversibility: "read_only", idempotent: true },
  } as unknown as Record<string, ToolManifestLite>;
  r.engine.tools.register({
    ...manifests["pay.charge"]!,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args: Record<string, unknown>) => {
      r.charges.push(Number(args["amount"]));
      return { content: "charged", writes: { receipt: { ok: true, amount: Number(args["amount"]) } } };
    },
  } as ToolDefinition);
  const graph = compileOrThrow({
    spec: racy as unknown as GraphSpec,
    resolver,
    tools: manifests,
    tenantCapabilities: ["pay"],
  });

  const runId = await r.engine.submit({ graph, inputs: { total: 10 } });
  const driving = r.engine.advance(runId);
  const childRunId = `${runId}~delegate@root#0` as RunId;
  // Park the child on its gate while the parent's wave is still held open by `t.slow`.
  let childGate: GateRecord | undefined;
  for (let i = 0; i < 500 && childGate === undefined; i++) {
    await new Promise((res) => setImmediate(res));
    const cp = await r.engine.projection(childRunId);
    if (cp !== undefined) childGate = open(cp);
  }
  if (childGate === undefined) {
    release();
    await driving.catch(() => undefined);
  }
  assert.ok(childGate !== undefined, "the child parked on its gate inside the parent's commit window");

  // The human answers in the child's console BEFORE the parent's mirror exists.
  await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c1" });
  release();
  const p = await driving;

  // The advance that raised the mirror is the one that answered it — no second driver, and no
  // advance of the child, which is retired and could not forward anything anyway.
  const stranded = Object.values(p.gates).find((g) => g.state === "open" && g.mirrorOf !== undefined);
  assert.equal(stranded, undefined, `no mirror is left open on a decided child gate: ${JSON.stringify(stranded ?? {})}`);
  assert.equal(p.gates[childGate.gateId] as unknown, undefined, "the child's gate is the CHILD's record, not the parent's");
  const mirror = Object.values(p.gates).find((g) => g.mirrorOf === childGate.gateId);
  assert.equal(mirror?.state, "decided");
  assert.equal(mirror?.decidedBy, "system");
  assert.equal((await r.engine.projection(childRunId))!.status, "succeeded");
  assert.deepEqual(r.charges, [20], "charged once");
});

test("CANCELLING A PARENT RELEASES THE CHILD'S CONTEXT TOO — every depth, not just the run cancel was called on", async () => {
  // `cancel` retired the run it was CALLED on, through `#settled`. `#cancelTree` walked down to
  // every delegated child, journaled the cancel and never released one — so an operator stopping
  // a parent left the child's graph, branch index, taint sets and expression cache attached for
  // the life of the process. That is the leak item 1 exists to close, at the depth where a
  // delegation actually puts the memory.
  //
  // THE OBSERVABLE IS WHERE `projection` READS FROM. With a context it folds INCREMENTALLY from
  // the cursor the context holds; with none it re-reads the child's whole journal from seq 1
  // (`Engine.projection`). So a read of the CHILD's log FROM 1 is the engine saying it holds
  // nothing for that run. `attach` is not the lens here: no shipped verb re-attaches a CANCELLED
  // run — `advance` answers a terminal run from the fold, `planRewind` refuses a cancelled one —
  // which is why this reads the other end.
  let childReads = 0;
  class CountingStore extends MemoryStateStore {
    override read(runId: RunId, from: Seq): AsyncIterable<JournalEvent> {
      if (String(runId).includes("~") && Number(from) <= 1) childReads++;
      return super.read(runId, from);
    }
  }
  const r = rig(new CountingStore({ now: () => NOW }));
  const { runId, childRunId } = await parked(r);
  assert.equal((await r.engine.projection(childRunId))!.status, "awaiting_gate");

  const held = childReads;
  await r.engine.projection(childRunId);
  assert.equal(childReads, held, "while the child is attached, its projection is not a full re-fold");

  assert.equal((await r.engine.cancel(runId, "stop", lead)).status, "cancelled");
  assert.equal((await r.engine.projection(childRunId))!.status, "cancelled", "the cascade reached the child");

  const afterCancel = childReads;
  await r.engine.projection(childRunId);
  assert.ok(
    childReads > afterCancel,
    "after the cancel the child's projection is a full re-fold from seq 1, which is what a released context means",
  );
});

test("A CONTENDED APPEND ON THE CHILD'S LAST PASS IS STILL RETRIED — a retired child answers its parent's mirror", async () => {
  // THE FIX ROUND'S OWN GAP, and the sharpest case against "leave it unmarked so the next pass
  // tries again": for a child whose gate decision is on its LAST pass there is no next pass.
  // `#settled` retires the child at its terminal exit and `#advanceSerially` answers a retired
  // terminal run from the fold, returning ABOVE the drive loop the forward lives in. The
  // parent-side half cannot recover it either — the parent is `awaiting_gate` on the open mirror,
  // which nothing counts as due. So a seq conflict on the final pass stranded the parent
  // permanently: the exact state d4115c9 exists to eliminate.
  //
  // ONE GATE IN THE CHILD is what makes it the last pass; the suite's other contention case
  // survives only because its child parks on a SECOND gate and therefore gets another pass.
  let refuseParent = false;
  let refusals = 0;
  class ContendedStore extends MemoryStateStore {
    override async append(input: Parameters<MemoryStateStore["append"]>[0]): ReturnType<MemoryStateStore["append"]> {
      if (refuseParent && !String(input.runId).includes("~")) {
        refusals++;
        throw err.conflict(CODES.E_SEQ_CONFLICT, `synthetic contention on ${String(input.runId)}`);
      }
      return super.append(input);
    }
  }
  const store = new ContendedStore({ now: () => NOW });
  const r = rig(store);
  // A child with exactly one gate: `charge` is read-only here, so it raises no posture gate of
  // its own and the run ends on the pass that answers `approve`.
  const manifests = {
    "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "read_only", idempotent: true },
  } as unknown as Record<string, ToolManifestLite>;
  r.engine.tools.register({
    ...manifests["pay.charge"]!,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args: Record<string, unknown>) => {
      r.charges.push(Number(args["amount"]));
      return { content: "charged", writes: { receipt: { ok: true, amount: Number(args["amount"]) } } };
    },
  } as ToolDefinition);
  const graph = compileOrThrow({ spec: parent, resolver, tools: manifests, tenantCapabilities: ["pay"] });

  const runId = await r.engine.submit({ graph, inputs: { total: 10 } });
  let p = await r.engine.advance(runId);
  const ownGate = Object.values(p.gates).find((g) => g.state === "open" && g.mirrorOf === undefined);
  if (ownGate !== undefined) {
    p = await r.engine.resolveGate(runId, { gateId: ownGate.gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:a", via: "console" }, idempotencyKey: "own" });
  }
  assert.equal(p.status, "awaiting_gate");
  const mirror = open(p)!;
  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childGate = open((await r.engine.projection(childRunId))!)!;
  assert.equal(mirror.mirrorOf, childGate.gateId);

  // The human answers the child's only gate while the parent's log is contended. The child runs
  // to completion on this very pass and is retired.
  refuseParent = true;
  const childP = await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c1" });
  assert.equal(childP.status, "succeeded", "the child finished on the pass that answered its gate — there is no later pass");
  assert.ok(refusals >= 8, `the internal retries were exhausted: ${String(refusals)} refusals`);
  assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "open", "the append genuinely did not land");

  // Contention clears. Any later touch of the retired child answers the mirror off the fold.
  refuseParent = false;
  assert.equal((await r.engine.advance(childRunId)).status, "succeeded", "a retired terminal run still answers from the fold");
  assert.equal(
    (await r.engine.projection(runId))!.gates[mirror.gateId]?.state,
    "decided",
    "…and forwards on the way, so the parent is not stranded by a conflict on the child's last pass",
  );
  assert.equal((await r.engine.advance(runId)).status, "succeeded");
  assert.deepEqual(r.charges, [20], "charged once");
});

test("A MIRROR THE BROKER ANSWERS `{resolved:false}` DOES NOT RESTART THE DRIVE PASS — the loop reads the result, not the call", async () => {
  // `#answerMirrorsTheChildAlreadyDecided` returns whether it WROTE, and the drive loop restarts
  // its pass on that answer. `HumanGateBroker.resolve` returns `{resolved:false}` from its
  // in-memory idempotency map BEFORE it looks at the gate's state, so a repeat under the same key
  // returns quietly having written nothing. Setting the flag from "resolve did not throw" made
  // the loop restart on a pass that changed nothing, and the termination argument — "the mirror
  // it answered is no longer open" — assumed a write that never happened. Reachable through a
  // rewind, which suppresses the `gate.decided` while the broker keeps the idempotency entry.
  //
  // THE DOUBLE IS BOUNDED AND ALWAYS TERMINATES, deliberately. A liar that answers
  // `{resolved:false}` forever is what the defect turns into an unbounded loop, and a test that
  // HANGS at base is not a test that fails at base — worse, this loop is pure microtasks, so it
  // starves timers and `--test-timeout` cannot rescue the suite. So the assertion is the
  // BOUNDED one that distinguishes the two behaviours safely: with the flag read correctly, the
  // pass is not restarted and the broker is asked about this mirror a small, bounded number of
  // times. The unbounded half is measured out of tree, in a killable child process, and recorded
  // in the lane report.
  let falseAnswers = 0;
  class LyingBroker extends HumanGateBroker {
    override async resolve(
      log: Parameters<HumanGateBroker["resolve"]>[0],
      input: Parameters<HumanGateBroker["resolve"]>[1],
    ): ReturnType<HumanGateBroker["resolve"]> {
      // Only the executor's own cross-run answer is lied about; a human's decision is untouched.
      if (input.actor.kind === "system" && String(input.actor.component) === "executor:subgraph" && input.gateId.startsWith("gate_")) {
        void log;
        falseAnswers++;
        return { resolved: false };
      }
      return super.resolve(log, input);
    }
  }
  const r = rig(new MemoryStateStore({ now: () => NOW }), new LyingBroker({ now: () => NOW }));
  const { runId, childRunId, mirror, childGate } = await parked(r);

  await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c1" });
  // The mirror is never written, because the broker says so. What must NOT happen is the drive
  // loop restarting its pass on that answer for ever.
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "the pass ended rather than restarting on a write that did not happen");
  assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "open", "nothing was written, which is the premise");
  assert.ok(falseAnswers >= 1, "the double was actually consulted");
  assert.ok(falseAnswers < 50, `the pass is not restarted on a `+"`{resolved:false}`"+`: ${String(falseAnswers)} calls`);
});

test("POLLING A FINISHED CHILD STILL ANSWERS WHEN THE PARENT'S LOG IS BROKEN — the forward may refuse, the answer may not", async () => {
  // `#advanceSerially`'s retired-terminal branch exists so that a caller polling `advance` until
  // it sees `succeeded` keeps getting an answer — "the eviction turning a completed run into a
  // missing one" is the thing it was added to prevent. It was read-only until the mirror forward
  // was put on it, and the forward swallows two gate codes and rethrows everything else. So a
  // failure on the PARENT's log became the answer to a question about a finished, successful
  // CHILD: a store I/O error, a fold that throws, anything.
  //
  // Refusing to forward is always allowed. Refusing to ANSWER is not, and it costs nothing to
  // swallow here because this call site keeps no memo — the next poll asks the fold again.
  let breakParent = false;
  class BrokenParentStore extends MemoryStateStore {
    override read(runId: RunId, from: Seq): AsyncIterable<JournalEvent> {
      if (breakParent && !String(runId).includes("~")) throw new Error("sqlite: disk I/O error");
      return super.read(runId, from);
    }
  }
  const r = rig(new BrokenParentStore({ now: () => NOW }));
  // A child with exactly one gate, so approving it finishes and retires the child — which is the
  // state whose poll this branch answers. `charge` is read-only here for that reason only.
  const manifests = {
    "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "read_only", idempotent: true },
  } as unknown as Record<string, ToolManifestLite>;
  r.engine.tools.register({
    ...manifests["pay.charge"]!,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args: Record<string, unknown>) => {
      r.charges.push(Number(args["amount"]));
      return { content: "charged", writes: { receipt: { ok: true, amount: Number(args["amount"]) } } };
    },
  } as ToolDefinition);
  const graph = compileOrThrow({ spec: parent, resolver, tools: manifests, tenantCapabilities: ["pay"] });
  const runId = await r.engine.submit({ graph, inputs: { total: 10 } });
  let p = await r.engine.advance(runId);
  const ownGate = Object.values(p.gates).find((g) => g.state === "open" && g.mirrorOf === undefined);
  if (ownGate !== undefined) {
    p = await r.engine.resolveGate(runId, { gateId: ownGate.gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:a", via: "console" }, idempotencyKey: "own" });
  }
  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childGate = open((await r.engine.projection(childRunId))!)!;
  const childP = await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c1" });
  assert.equal(childP.status, "succeeded", "the child is finished and retired");

  breakParent = true;
  const answered = await r.engine.advance(childRunId);
  assert.ok(
    isTerminal(answered.status),
    `a finished child answers its own poll even when the parent's log cannot be read: ${JSON.stringify(answered.error ?? answered.status)}`,
  );
  assert.equal(String(answered.runId), String(childRunId));
});
