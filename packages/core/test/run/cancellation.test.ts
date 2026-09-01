/**
 * CANCELLATION IS FINAL.
 *
 * Three separately-reasonable decisions composed into one hole. `Engine.cancel` stopped
 * the run and left its gates `open`; `HumanGateBroker.resolve` validated the GATE and
 * never the RUN; and `gate.decided` carries an unconditional `run.resumed` that the fold
 * applied whatever the status was. So answering a leftover gate on a cancelled run
 * RESURRECTED it, and the irreversible action the operator had just refused went through.
 *
 * The missing piece was always the write side. D7.3's lifecycle FSM has specified
 * `Open --> Cancelled: gate.cancelled` since it was drawn, `gate.cancelled` has been in
 * `EVENT_TYPES` and folded by `projection.ts` for just as long — and nothing in `src/`
 * ever appended one. The read model was ready and the writer never arrived.
 *
 * So every test here drives a REAL cancel and then tries the leftover gate. A test that
 * only exercises `resolve` in isolation cannot fail, because `resolve` was never the only
 * hole — and a test that only checks the fold cannot fail either, for the same reason.
 *
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq, TaskId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type Actor, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { foldRun } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { OPERATOR } from "./operator.ts";
import { DOCS, compileSkeleton, harness, resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const alice: Actor = { kind: "human", subject: "u:alice", via: "console" };

/** The gate is closed, so the decision has nowhere to land. */
const gateIsClosed = (e: unknown): true => {
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  assert.equal(e.code, CODES.E_GATE_ALREADY_RESOLVED, e.message);
  return true;
};

async function events(store: StateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

/** The skeleton, parked on the gate that stands in front of its one irreversible write. */
async function parked(): Promise<{ h: ReturnType<typeof harness>; runId: RunId; gateId: GateId }> {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "the skeleton parks on its gate");
  assert.equal(h.writes.length, 0, "…with the write still ahead of it");
  return { h, runId, gateId: Object.values(p.gates).find((g) => g.state === "open")!.gateId };
}

// ── the headline ─────────────────────────────────────────────────────────────

test("A CANCELLED RUN CANNOT BE RESURRECTED BY ANSWERING ITS LEFTOVER GATE", async () => {
  // The whole exploit, in five lines: park on the gate, cancel, answer the gate anyway.
  // The gate row outlived the run it belonged to, `resolve` had no opinion about the run,
  // and `run.resumed` folded the status back to `running` — so the approval drove the very
  // write the cancel existed to stop.
  const { h, runId, gateId } = await parked();

  const cancelled = await h.engine.cancel(runId, "the summary must not go out");
  assert.equal(cancelled.status, "cancelled");

  await assert.rejects(
    () => h.engine.resolveGate(runId, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" }),
    gateIsClosed,
  );

  const after = (await h.engine.projection(runId))!;
  assert.equal(after.status, "cancelled", "THE RUN STAYED CANCELLED");
  assert.equal(h.writes.length, 0, "AND THE ACTION IT WAS CANCELLED TO PREVENT DID NOT HAPPEN");
  assert.equal(
    (await events(h.store, runId)).some((ev) => ev.type === "gate.decided"),
    false,
    "nothing about the refused decision reached the record as a decision",
  );
});

// ── layer 1: cancel closes the gates ─────────────────────────────────────────

test("CANCEL CLOSES THE GATES, in the same append that ends the run", async () => {
  // The transition D7.3 specified and nobody wrote. It goes in the SAME append as
  // `run.cancelled` because a crash between the two would leave a stopped run with a live
  // gate — which is precisely the state the resurrection needs.
  const { h, runId, gateId } = await parked();
  await h.engine.cancel(runId, "operator changed their mind");

  const p = (await h.engine.projection(runId))!;
  assert.equal(p.gates[gateId]?.state, "cancelled", "the gate is closed, not merely orphaned");

  const seq = await events(h.store, runId);
  const closed = seq.filter((ev) => ev.type === "gate.cancelled");
  assert.equal(closed.length, 1, "one gate.cancelled per open gate, and it really is appended");
  assert.equal((closed[0]!.payload as { gateId: GateId }).gateId, gateId);
  assert.match(
    (closed[0]!.payload as { reason: string }).reason,
    /operator changed their mind/,
    "the reason says WHY the queue lost this item",
  );

  const iCancelled = seq.findIndex((ev) => ev.type === "gate.cancelled");
  const iRun = seq.findIndex((ev) => ev.type === "run.cancelled");
  assert.ok(iCancelled >= 0 && iRun === iCancelled + 1, "one durable fact: the gates, then the run");

  // …and the gate is gone from the approver's queue, which is the point of closing it.
  assert.deepEqual(await h.engine.openGates(runId), []);
});

test("AND THE TASKS GO WITH IT — a cancelled run does not leave a Task reading as still running", async () => {
  // REGISTER E6. `#commit` returns early on a terminal run, so a Task that was mid-flight when
  // the cancel landed kept whatever state it last had — typically `leased`. The run then read
  // `cancelled` while one of its Tasks read as still running: a projection describing a state
  // the system is not in, and the read model is the thing every other surface renders from.
  //
  // It is also C1's `task.cancelled` finally gaining an appender. THREE folds were written for
  // this event and none of them could ever run — `projection.ts`, `evolution/trajectory.ts` and
  // `telemetry/spans.ts` — so the dead code was on the READING side, which is where it is
  // hardest to see and where a registry of never-appended types is the only thing that finds it.
  const { h, runId, gateId } = await parked();

  const before = (await h.engine.projection(runId))!;
  const live = Object.values(before.tasks).filter((t) => !["succeeded", "failed", "skipped", "cancelled"].includes(t.state));
  assert.ok(live.length > 0, "the run must actually have a non-terminal Task, or this test asserts nothing");

  await h.engine.cancel(runId, "operator changed their mind");

  const p = (await h.engine.projection(runId))!;
  assert.equal(p.status, "cancelled");
  for (const t of live) {
    assert.equal(p.tasks[t.taskId]?.state, "cancelled", `Task ${t.taskId} was ${t.state} and must not still read that way`);
  }
  assert.deepEqual(
    Object.values(p.tasks).filter((t) => t.state === "leased"),
    [],
    "NO Task may be left leased on a run that has ended",
  );

  // The event really is appended, with the taskId the fold needs on the ENVELOPE — the fold is
  // `isEvent(e, "task.cancelled") && e.taskId`, so a payload-only taskId would fold to nothing
  // and this test would pass on the projection while the journal said nothing.
  const seq = await events(h.store, runId);
  const cancelled = seq.filter((ev) => ev.type === "task.cancelled");
  assert.equal(cancelled.length, live.length, "one task.cancelled per non-terminal Task");
  for (const ev of cancelled) {
    assert.ok(ev.taskId, "the taskId is on the envelope, which is what the fold reads");
    assert.match((ev.payload as { reason: string }).reason, /operator changed their mind/);
  }

  // AND IT IS ONE DURABLE FACT with the rest: tasks, then gates, then the run.
  const iTask = seq.findIndex((ev) => ev.type === "task.cancelled");
  const iGate = seq.findIndex((ev) => ev.type === "gate.cancelled");
  const iRun = seq.findIndex((ev) => ev.type === "run.cancelled");
  assert.ok(iTask >= 0 && iTask < iGate && iGate < iRun, `order must be task, gate, run — saw ${String(iTask)}, ${String(iGate)}, ${String(iRun)}`);
});

test("A TASK THAT ALREADY FINISHED IS NOT RE-ENDED BY A CANCEL", async () => {
  // The negative control. Without it, a change that cancelled EVERY task would satisfy the test
  // above perfectly while rewriting history the cancel never touched — a succeeded Task reading
  // as cancelled is a worse lie than a leased one, because it erases work that really happened.
  const { h, runId } = await parked();
  const before = (await h.engine.projection(runId))!;
  const finished = Object.values(before.tasks).filter((t) => t.state === "succeeded");
  assert.ok(finished.length > 0, "the skeleton has run some tasks to completion before it gates");

  await h.engine.cancel(runId, "stop");

  const p = (await h.engine.projection(runId))!;
  for (const t of finished) {
    assert.equal(p.tasks[t.taskId]?.state, "succeeded", `Task ${t.taskId} succeeded before the cancel and must still say so`);
  }
});

// ── layer 2: resolve refuses on a terminal run ───────────────────────────────

const RUN = "run_cancel_broker" as RunId;

const request = (over: Partial<GateRequest> = {}): GateRequest => ({
  runId: RUN,
  taskId: "restart@root#0" as TaskId,
  nodeId: "restart" as NodeId,
  policyRef: "oversight/restart@stable",
  payload: { command: "kubectl rollout restart deploy/api" },
  ...over,
});

test("resolve REFUSES ON A TERMINAL RUN, whatever the gate's own state says", async () => {
  // "The gate is still open" is not evidence that the run is. This is the journal shape
  // every cancel wrote before the layer above existed, and it is also what any store
  // written by an older build still contains — so the check has to be about the RUN, not
  // about the gate row that outlived it.
  const clock = { t: 1_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const log = new RunLog(RUN, { store, now: () => clock.t });
  const broker = new HumanGateBroker({ now: () => clock.t });
  const gateId = await broker.raise(log, request());

  await log.append([
    {
      type: "run.cancelled",
      payload: { clean: true, unknownEffects: [] },
      actor: SYSTEM_ACTOR("operator"),
    },
  ]);

  const before = (await broker.project(log))!;
  assert.equal(before.status, "cancelled");
  assert.equal(before.gates[gateId]?.state, "open", "the shape under test: a gate that outlived its run");

  await assert.rejects(
    () => broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k" }),
    gateIsClosed,
  );

  const after = (await broker.project(log))!;
  assert.equal(after.status, "cancelled", "and the refusal did not itself resume anything");
  assert.equal(
    (await events(store, RUN)).some((ev) => ev.type === "run.resumed"),
    false,
    "no run.resumed was appended, which is where the fix belongs: the append side",
  );
});

test("a run that ENDED IN FAILURE is just as unanswerable", async () => {
  // Same question, the other terminal status. An expired gate fails the run and leaves
  // every OTHER gate on it open, so this is not a hypothetical shape.
  const clock = { t: 1_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const log = new RunLog(RUN, { store, now: () => clock.t });
  const broker = new HumanGateBroker({ now: () => clock.t });
  const gateId = await broker.raise(log, request({ taskId: "other@root#0" as TaskId }));

  await log.append([
    {
      type: "run.failed",
      payload: { error: { class: "timeout", code: CODES.E_GATE_EXPIRED, message: "another gate expired", retryable: false } },
      actor: SYSTEM_ACTOR("gate-broker"),
    },
  ]);

  await assert.rejects(
    () => broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k" }),
    gateIsClosed,
  );
});

// ── layer 3: the fold does not resurrect ─────────────────────────────────────

test("THE FOLD DOES NOT RESURRECT: run.resumed after a terminal status is ignored", async () => {
  // Invariant 2 says the journal is authoritative and read models are derived, so the
  // primary fix is on the APPEND side — `resolve` refuses, and `gates.ts` is the only
  // appender of `run.resumed`. This is the other half: a journal that ALREADY contains
  // one, written by a build without that check, must not be re-animated by folding it.
  // The fold's job is to be honest about the log it is handed, not to trust it.
  const { h, runId } = await parked();
  await h.engine.cancel(runId, "stop");

  const log = new RunLog(runId, { store: h.store, now: () => 1_700_000_000_000 });
  await log.append([{ type: "run.resumed", payload: { by: "gate" }, actor: SYSTEM_ACTOR("gate-broker") }]);

  const p = foldRun(await events(h.store, runId))!;
  assert.equal(p.status, "cancelled", "a contradiction in the journal reads as the terminal fact, not the later one");
  assert.ok(p.endedAt !== undefined, "…and the run still knows when it ended");
});

// ── generalisation: run.failed is a terminal transition too ──────────────────

function twoGateSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "two-gates", project: "cancel", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: {
      seed: { type: "number", reduce: "replace" },
      left: { type: "number", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["left"],
    nodes: [
      { id: n("gateA"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/a@stable" } },
      { id: n("gateB"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/b@stable" } },
      { id: n("work"), type: "function", reads: ["seed"], writes: ["left"], function: { ref: "function/echo@stable" } },
    ],
    edges: [{ id: e("ab"), from: n("gateA"), to: n("work"), kind: "seq" }],
  };
}

function twoGateEngine(): { engine: Engine; store: MemoryStateStore } {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/echo@stable", (view) => ({ writes: { left: view.get<number>("seed") ?? 0 } }));
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver: resolver(),
    policy: { granted: ["*"], systemFloor: "out" },
  });
  return { engine, store };
}

test("A RUN THAT FAILS CLOSES ITS OPEN GATES TOO", async () => {
  // The same three questions, asked of the other terminal transition. A budget breach is
  // run-level and durable, so it is the one `#finish` path a run with a gate still open
  // can reach — answer one of two gates, the run resumes, the breach fails it, and the
  // SECOND gate used to be left sitting in somebody's queue attached to a dead run.
  const { engine, store } = twoGateEngine();
  const graph = compileOrThrow({ spec: twoGateSpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { seed: 7 } });

  const parkedP = await engine.advance(runId);
  assert.equal(parkedP.status, "awaiting_gate");
  const open = Object.values(parkedP.gates).filter((g) => g.state === "open").sort((a, b) => a.raisedAtSeq - b.raisedAtSeq);
  assert.equal(open.length, 2, "the shape under test: two gates open at once");

  // The policy engine's own event, appended here because nothing in this graph spends.
  await new RunLog(runId, { store, now: () => 1_700_000_000_000 }).append([
    { type: "budget.exhausted", payload: { scope: `run:${runId}`, limitUsd: 0, action: "fail" }, actor: SYSTEM_ACTOR("policy") },
  ]);

  const failed = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.gates[open[1]!.gateId]?.state, "cancelled", "THE SURVIVING GATE WAS CLOSED WITH THE RUN");
  assert.deepEqual(await engine.openGates(runId), [], "nothing is left in the queue for a run that has ended");
});

// ── generalisation: rewind must not undo a cancel ────────────────────────────

test("A CANCELLED RUN CANNOT BE REWOUND BACK TO LIFE", async () => {
  // Rewind is the other door to the same room, and a wider one: suppressing
  // `run.cancelled` suppresses the `gate.cancelled` events beside it, so the gates reopen
  // with the run and the resurrection returns wholesale. Cancelled is the one terminal
  // status that records an INTENTION rather than an outcome — undoing a failure is a
  // retry, undoing a refusal is overruling the person who made it. A new run is the way
  // back, and it gets a new id and a new journal.
  const { h, runId, gateId } = await parked();
  await h.engine.cancel(runId, "stop");

  await assert.rejects(() => h.engine.rewind(runId, 1 as Seq, "undo the cancel", OPERATOR), (e: unknown) => {
    assert.ok(isLoomError(e));
    assert.equal(e.code, CODES.E_RESTORE_ILLEGAL, e.message);
    return true;
  });

  const p = (await h.engine.projection(runId))!;
  assert.equal(p.status, "cancelled");
  assert.equal(p.gates[gateId]?.state, "cancelled");
  assert.equal(h.writes.length, 0);
});

test("…but a FAILED run may still be rewound, because that is a retry and not an overrule", async () => {
  const { h, runId } = await parked();
  const log = new RunLog(runId, { store: h.store, now: () => 1_700_000_000_000 });
  await log.append([
    {
      type: "run.failed",
      payload: { error: { class: "internal", code: CODES.E_INTERNAL, message: "boom", retryable: false } },
      actor: SYSTEM_ACTOR("executor"),
    },
  ]);

  const p = await h.engine.rewind(runId, 1 as Seq, "try again", OPERATOR);
  assert.notEqual(p.status, "failed", "the rewind took effect");
});
