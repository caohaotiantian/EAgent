/**
 * THE GATE LIFECYCLE IS FINAL — the other doors into the same room.
 *
 * `cancellation.test.ts` closed resurrection for a gate that was ALREADY OPEN when the
 * cancel ran. Three more paths reached the same state from the other side, and one of
 * them erased the operator's cancellation outright:
 *
 *   1. A gate RAISED AFTER the cancel. `HumanGateBroker.raise` had no terminal-run check
 *      and appended `gate.raised` + `run.suspended` unconditionally — via `log.append`,
 *      which RETRIES on a seq conflict, rather than the optimistic `log.commit(p.seq, …)`
 *      every other commit path uses. Cancel a run with a Task in flight, let that Task
 *      reach its gate, and the fold's `run.suspended` arm carried the run back out of
 *      `cancelled`. So a test that raises before cancelling cannot fail: the race IS the
 *      defect.
 *   2. `rewind` past a REJECTION. It was hardened against `cancelled` only, so rewinding a
 *      run that failed because a human refused returned that gate to `open` and put the
 *      refused action back on the table. Same principle the cancel fix stated — undoing a
 *      failure is a retry, undoing a refusal overrules a person — applied consistently.
 *   3. `#finish`'s SUCCESS path. Its docstring claimed `advance` re-suspends rather than
 *      finishing while a gate is open; the budget/fatal floor reaches `run.completed` too,
 *      so a succeeded run could leave a live gate in an approver's queue.
 *   4. The fold's terminal guard covered `run.resumed` and nothing else, so a `run.failed`
 *      appended to a cancelled run overwrote `cancelled` with `failed` and the operator's
 *      cancellation vanished from the derived state.
 *
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, NodeSpec } from "../../src/graph/spec.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq, TaskId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type Actor, type JournalEvent, type NewEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { suppressedRanges } from "../../src/run/projection.ts";
import { foldRun, type RunStatus } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { ZERO_USAGE } from "../../src/vocab.ts";
import {
  DOCS,
  SKELETON_TENANT_CAPS,
  SKELETON_TOOLS,
  compileSkeleton,
  harness,
  resolver,
  skeletonSpec,
} from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const alice: Actor = { kind: "human", subject: "u:alice", via: "console" };
const NOW = 1_700_000_000_000;

const conflict = (code: string) => (err: unknown): true => {
  assert.ok(isLoomError(err), `expected a LoomError, got ${String(err)}`);
  assert.equal(err.code, code, err.message);
  return true;
};

async function events(store: StateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · a gate raised AFTER the cancel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two entry nodes, so one wave holds a Task that gates and a Task that is still working.
 * `slow` is what keeps the wave open long enough for a cancel to land between the lease
 * and the commit — which is the only window in which this defect exists.
 */
function raceSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "raise-after-cancel", project: "gate-lifecycle", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: {
      seed: { type: "number", reduce: "replace" },
      slow: { type: "number", reduce: "replace" },
      done: { type: "number", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["done"],
    nodes: [
      { id: n("slow"), type: "function", reads: ["seed"], writes: ["slow"], function: { ref: "function/slow@stable" } },
      { id: n("gate"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/race@stable" } },
      { id: n("work"), type: "function", reads: ["seed"], writes: ["done"], function: { ref: "function/work@stable" } },
    ],
    edges: [{ id: e("g2w"), from: n("gate"), to: n("work"), kind: "seq" }],
  };
}

test("A GATE RAISED AFTER THE CANCEL DOES NOT RESURRECT THE RUN", async () => {
  // THE RACE, and it has to be a real one. `cancel` closes the gates that are open when it
  // runs; it cannot close a gate that does not exist yet. A Task already in flight reaches
  // its gate AFTER the run has ended, `raise` appended `gate.raised` + `run.suspended`
  // unconditionally, and the fold's `run.suspended` arm moved the run out of `cancelled`
  // into `awaiting_gate` — a live question, on a dead run, with the action behind it
  // reachable again by anyone who answers.
  //
  // Two guards hold this, and `await`ing `advance` below tests both: `raise` REFUSES on a
  // terminal run, and `#commit` skips the raise so the refusal never surfaces as an
  // exception out of `advance` — an operator cancelling a run mid-wave is not an error the
  // caller can do anything about.
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  const ran: string[] = [];

  // The cancel fires from INSIDE the in-flight Task, which is what makes the interleaving
  // deterministic: journal writes are serialized, and a node body holds none of that queue.
  let cancelNow: () => Promise<unknown> = async () => undefined;
  functions.register("function/slow@stable", async () => {
    await cancelNow();
    return { writes: { slow: 1 } };
  });
  functions.register("function/work@stable", () => {
    ran.push("work");
    return { writes: { done: 1 } };
  });

  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver: resolver(),
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const graph = compileOrThrow({ spec: raceSpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { seed: 1 } });
  cancelNow = () => engine.cancel(runId, "the deploy must not go out");

  const p = await engine.advance(runId);

  assert.equal(p.status, "cancelled", "THE RUN STAYED CANCELLED — a late gate is not a resurrection");
  assert.deepEqual(await engine.openGates(runId), [], "and nothing was left in an approver's queue");
  assert.deepEqual(ran, [], "the action behind the gate never became reachable");

  const seq = await events(store, runId);
  const iCancelled = seq.findIndex((ev) => ev.type === "run.cancelled");
  assert.ok(iCancelled >= 0, "the cancel really did land first");
  assert.equal(
    seq.slice(iCancelled).some((ev) => ev.type === "gate.raised" || ev.type === "run.suspended"),
    false,
    "no gate and no suspension were appended after the run ended",
  );
});

// ── the same guard, at the broker ────────────────────────────────────────────

const RUN = "run_raise_terminal" as RunId;

const request = (over: Partial<GateRequest> = {}): GateRequest => ({
  runId: RUN,
  taskId: "restart@root#0" as TaskId,
  nodeId: "restart" as NodeId,
  policyRef: "oversight/restart@stable",
  payload: { command: "kubectl rollout restart deploy/api" },
  ...over,
});

const TERMINALS: readonly { readonly status: RunStatus; readonly event: NewEvent }[] = [
  {
    status: "cancelled",
    event: {
      type: "run.cancelled",
      payload: { clean: true, unknownEffects: [] },
      actor: SYSTEM_ACTOR("operator"),
    },
  },
  {
    status: "failed",
    event: {
      type: "run.failed",
      payload: { error: { class: "internal", code: CODES.E_INTERNAL, message: "boom", retryable: false } },
      actor: SYSTEM_ACTOR("executor"),
    },
  },
  {
    status: "succeeded",
    event: {
      type: "run.completed",
      payload: { outputs: { done: 1 }, usage: ZERO_USAGE },
      actor: SYSTEM_ACTOR("executor"),
    },
  },
];

test("raise REFUSES ON A RUN THAT HAS ENDED, whichever way it ended", async () => {
  // `resolve` learned to look at the run; `raise` never did. All three terminal statuses,
  // because the window is the same one: whatever ended the run, a Task in flight can still
  // arrive at its gate afterwards.
  for (const t of TERMINALS) {
    const clock = { t: 1_000_000 };
    const store = new MemoryStateStore({ now: () => clock.t });
    const log = new RunLog(RUN, { store, now: () => clock.t });
    const broker = new HumanGateBroker({ now: () => clock.t });

    await log.append([{ type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("scheduler") }]);
    await log.append([t.event]);

    await assert.rejects(
      () => broker.raise(log, request()),
      conflict(CODES.E_ILLEGAL_TRANSITION),
      `a ${t.status} run accepted a new gate`,
    );

    const after = (await broker.project(log))!;
    assert.equal(after.status, t.status, "and the refusal did not itself move the run");
    assert.equal(
      (await events(store, RUN)).some((ev) => ev.type === "gate.raised"),
      false,
      "nothing about the refused gate became durable",
    );
  }
});

/** A store that lets a foreign writer slip in between a reader's fold and its commit. */
function interposing(inner: StateStore, afterRead: () => Promise<void>): StateStore {
  let armed = true;
  return {
    append: (input) => inner.append(input),
    read: (runId, fromSeq, toSeq) => {
      const it = inner.read(runId, fromSeq, toSeq);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const ev of it) yield ev;
          if (armed) {
            armed = false;
            await afterRead();
          }
        },
      };
    },
    head: (runId) => inner.head(runId),
    listRuns: (limit) => inner.listRuns(limit),
    close: () => inner.close(),
  };
}

test("raise COMMITS AGAINST THE PROJECTION IT CHECKED, so a moved head is a conflict", async () => {
  // WHY `commit` AND NOT `append`. The terminal check reads a projection; `log.append`
  // retries on `E_SEQ_CONFLICT` by re-reading the head, so an append that follows a check
  // can land against a journal that has since moved — which is precisely the resurrection,
  // one process further out. `log.commit(expectedSeq, …)` exists so a writer cannot append
  // against a projection that is stale, and `raise` was the one commit path not using it.
  const clock = { t: 1_000_000 };
  const inner = new MemoryStateStore({ now: () => clock.t });
  const foreign = new RunLog(RUN, { store: inner, now: () => clock.t });
  const store = interposing(inner, async () => {
    await foreign.append([{ type: "task.progress", payload: { chunk: "still working" }, actor: SYSTEM_ACTOR("tool") }]);
  });

  const log = new RunLog(RUN, { store, now: () => clock.t });
  await log.append([{ type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("scheduler") }]);

  const broker = new HumanGateBroker({ now: () => clock.t });
  await assert.rejects(() => broker.raise(log, request()), conflict(CODES.E_SEQ_CONFLICT));

  assert.equal(
    (await events(inner, RUN)).some((ev) => ev.type === "gate.raised"),
    false,
    "the gate did not land against a projection the writer had not seen",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · rewind must not replay past a human's refusal
// ─────────────────────────────────────────────────────────────────────────────

/** The skeleton, parked on the gate in front of its one write. */
async function parked(): Promise<{ h: ReturnType<typeof harness>; runId: RunId; gateId: GateId }> {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "the skeleton parks on its gate");
  assert.equal(h.writes.length, 0, "…with the write still ahead of it");
  return { h, runId, gateId: Object.values(p.gates).find((g) => g.state === "open")!.gateId };
}

/** The seq of the `run.suspended` that put the run on its gate. */
async function suspendedAt(h: ReturnType<typeof harness>, runId: RunId): Promise<Seq> {
  const seq = await events(h.store, runId);
  const raised = seq.findIndex((ev) => ev.type === "gate.raised");
  assert.ok(raised >= 0);
  const suspended = seq.slice(raised).find((ev) => ev.type === "run.suspended");
  assert.ok(suspended !== undefined);
  return suspended.seq;
}

test("REWIND DOES NOT REPLAY PAST A HUMAN'S REJECTION", async () => {
  // The principle the cancel fix stated, applied consistently: undoing a FAILURE is a
  // retry, undoing a REFUSAL overrules a person. A rejection is a refusal — it is the
  // reason the run failed, not an outcome the run stumbled into — so rewinding past one
  // deletes the "no" from the derived state and puts the refused action back on the table
  // for anyone who answers the re-opened gate.
  const { h, runId, gateId } = await parked();
  const at = await suspendedAt(h, runId);

  const failed = await h.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "reject", reason: "the summary names a customer" },
    actor: alice,
    idempotencyKey: "r1",
  });
  assert.equal(failed.status, "failed", "a rejection ends the run");
  assert.equal(h.writes.length, 0);

  await assert.rejects(() => h.engine.rewind(runId, at, "try again"), conflict(CODES.E_RESTORE_ILLEGAL));

  const after = (await h.engine.projection(runId))!;
  assert.equal(after.status, "failed", "the refusal stands");
  assert.equal(after.gates[gateId]?.state, "decided", "…and the gate is not back in anybody's queue");
  assert.equal(after.gates[gateId]?.decision, "reject");
  assert.equal(h.writes.length, 0, "AND THE ACTION THE HUMAN REFUSED DID NOT HAPPEN");
});

test("A REJECTION CAN NEVER BE INSIDE A SUPPRESSED RANGE — which is why the scan need not filter one", async () => {
  // REGISTER E5 says `rewind`'s rejection scan reads `(atSeq, head]` "without excluding events an
  // earlier rewind already suppressed, so a rejection whose effect was already erased still blocks
  // a new rewind", and records the fix as blocked on exporting `suppressedRanges`.
  //
  // BOTH HALVES ARE STALE. `suppressedRanges` is exported and is in the pinned public surface —
  // `journal/audit.ts` needed it — so the stated obstacle is gone. And the over-refusal it
  // describes is not reachable, for a reason that is worth a test rather than a paragraph:
  //
  //   a rejection at seq R is suppressed only by a rewind to some atSeq < R,
  //   and that rewind's own scan reads (atSeq, head], which contains R,
  //   so the rule refuses it. The state E5 describes has no way to be entered.
  //
  // This is the positive control for a negative claim. It fails the moment the rejection refusal
  // is loosened — which is exactly when filtering suppressed events WOULD start to matter, so it
  // fails at the right time rather than never.
  const { h, runId, gateId } = await parked();
  const at = await suspendedAt(h, runId);

  await h.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "reject", reason: "no" },
    actor: alice,
    idempotencyKey: "r1",
  });

  // Every rewind an operator could ask for, from the start of the run to past its end.
  const all = await events(h.store, runId);
  const head = all[all.length - 1]!.seq;
  const rejectSeqs = all.filter((e) => e.type === "gate.decided" && (e.payload as { decision: string }).decision === "reject").map((e) => e.seq);
  assert.equal(rejectSeqs.length, 1, "one rejection, so the property below is about something");

  for (let target = 0; target <= Number(head) + 1; target++) {
    await h.engine.rewind(runId, target as Seq, "sweep").catch(() => undefined);
  }

  // Whatever was accepted, the rejection is still live: no suppressed range covers it.
  const after = await events(h.store, runId);
  const hidden = suppressedRanges(after);
  for (const r of rejectSeqs) {
    const covering = hidden.filter(([from, to]) => Number(r) > from && Number(r) < to);
    assert.deepEqual(covering, [], `seq ${String(r)} is a rejection and landed inside a suppressed range ${JSON.stringify(covering)}`);
  }
  assert.equal((await h.engine.projection(runId))!.gates[gateId]?.decision, "reject", "and the refusal still stands in the fold");
  assert.equal(h.writes.length, 0, "AND THE ACTION THE HUMAN REFUSED STILL DID NOT HAPPEN");
});

test("…but rewinding past an APPROVAL is allowed, because it ASKS AGAIN rather than assuming", async () => {
  // The same question with the opposite sign, and it resolves the other way for a reason
  // that is checkable rather than aesthetic: suppressing `gate.decided` returns the gate to
  // `open`, so the human is asked the same question a second time before anything runs.
  // Re-asking someone who said yes costs a click. Re-asking someone who said no is an
  // appeal against a decision already made, which is why the branch above refuses.
  const { h, runId, gateId } = await parked();
  const at = await suspendedAt(h, runId);

  const done = await h.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
  });
  assert.equal(done.status, "succeeded");
  assert.equal(h.writes.length, 1, "the approved write happened");

  const rewound = await h.engine.rewind(runId, at, "re-run the write");
  assert.equal(rewound.status, "awaiting_gate", "the run is back in front of the human");
  assert.equal(rewound.gates[gateId]?.state, "open", "THE GATE IS ASKED AGAIN, not assumed");
  assert.equal(rewound.gates[gateId]?.decision, undefined);
  assert.equal(h.writes.length, 1, "and nothing re-ran on its own");
});

test("A REWIND TO SEQ 0 IS REFUSED, because it ERASES the run rather than rewinding it", async () => {
  // `rewind` refuses three wedges by name — a cancelled run, a rejection in range, and a
  // boundary that splits a decision from its resume — and accepted the one with no way out.
  // `suppressedRanges` hides `(atSeq, marker)` exclusive at both ends, so `atSeq: 0` hides
  // EVERY event there has ever been, `run.submitted` included.
  //
  // Measured before the refusal, on this same skeleton parked at seq 88: `rewind(runId, 0)`
  // was ACCEPTED and folded to `status: "queued"`, `graphHash: ""`, zero tasks, zero gates
  // and **zero channels** — the run's own inputs gone with the event that carried them.
  // `advance()` then found no work, no open gate and nothing terminal, walked straight to
  // `#finish`, and appended `run.failed{E_OUTPUT_MISSING}: run finished without writing any
  // of its declared outputs (written)`. A run that had done everything asked of it and was
  // waiting on a human, reported as having produced nothing.
  //
  // AND NOTHING BRINGS IT BACK. Every other refusal here names a recovery that suppresses
  // MORE — "rewind to `atSeq - 1` to ask again" — and there is no seq below 0. Measured:
  // after `rewind(0)`, rewinding to 1, 2, 50, 88 and 89 in turn each folded back to `queued`
  // with zero tasks and zero channels, because the first range still hides what a later one
  // would have kept.
  const { h, runId, gateId } = await parked();

  await assert.rejects(() => h.engine.rewind(runId, 0 as Seq, "start over"), conflict(CODES.E_RESTORE_ILLEGAL));
  await assert.rejects(() => h.engine.rewind(runId, -1 as Seq, "start over"), conflict(CODES.E_RESTORE_ILLEGAL));

  const after = (await h.engine.projection(runId))!;
  assert.equal(after.status, "awaiting_gate", "the run is exactly where it was");
  assert.equal(after.gates[gateId]?.state, "open");
  assert.deepEqual(after.channels["paths"], DOCS, "…and it still knows what it was asked to do");
  assert.equal(
    (await events(h.store, runId)).some((ev) => ev.type === "checkpoint.restored"),
    false,
    "a refused rewind writes no marker",
  );
});

test("…and seq 1 is the floor, not a synonym for it: a run keeps its identity there", async () => {
  // WHERE THE LINE IS, pinned so that widening it is a decision somebody takes rather than
  // one that drifts. Boundaries of 1, 2 and 3 are also unrunnable — no `task.ready` survives
  // them, so `advance` reaches `#finish` and fails with `E_OUTPUT_MISSING` exactly as seq 0
  // does — and they are NOT refused, because the run is still ITSELF: it keeps its graph
  // hash and its inputs, so an operator can see what they broke and a later boundary means
  // something. Seq 0 is the one where the run stops being a run.
  const { h, runId } = await parked();

  const rewound = await h.engine.rewind(runId, 1 as Seq, "back to the submission");
  assert.equal(rewound.status, "queued", "no run.started survives, so the run is not running");
  assert.deepEqual(rewound.channels["paths"], DOCS, "BUT ITS INPUTS DO");
  assert.notEqual(rewound.graphHash, "", "…and so does the graph it was compiled against");
  assert.deepEqual(Object.keys(rewound.gates), [], "everything after the submission is suppressed");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · the success path must not strand a live gate
// ─────────────────────────────────────────────────────────────────────────────

function successSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "succeed-with-gate", project: "gate-lifecycle", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: {
      seed: { type: "number", reduce: "replace" },
      left: { type: "number", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["left"],
    nodes: [
      { id: n("work"), type: "function", reads: ["seed"], writes: ["left"], function: { ref: "function/echo@stable" } },
      { id: n("gateA"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/a@stable" } },
      { id: n("gateB"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/b@stable" } },
      { id: n("after"), type: "function", reads: ["seed"], function: { ref: "function/noop@stable" } },
    ],
    edges: [{ id: e("ab"), from: n("gateA"), to: n("after"), kind: "seq" }],
  };
}

function successEngine(): { engine: Engine; store: MemoryStateStore } {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/echo@stable", (view) => ({ writes: { left: view.get<number>("seed") ?? 0 } }));
  functions.register("function/noop@stable", () => ({}));
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

test("A RUN THAT SUCCEEDS CLOSES ITS OPEN GATES TOO", async () => {
  // `#finish` closed gates on its three FAILURE branches and justified skipping the success
  // branch with "`advance` re-suspends rather than finishing while a gate is open". That is
  // false: the budget/fatal floor at the top of `advance` reaches `#finish` without passing
  // the re-suspend check, and `#finish` completes a run whose declared outputs are already
  // written. So a SUCCEEDED run left a live gate in an approver's queue.
  const { engine, store } = successEngine();
  const graph = compileOrThrow({ spec: successSpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { seed: 7 } });

  const parkedP = await engine.advance(runId);
  assert.equal(parkedP.status, "awaiting_gate");
  assert.equal(parkedP.channels["left"], 7, "the declared output is already written");
  const open = Object.values(parkedP.gates)
    .filter((g) => g.state === "open")
    .sort((a, b) => a.raisedAtSeq - b.raisedAtSeq);
  assert.equal(open.length, 2, "the shape under test: two gates open at once");

  await new RunLog(runId, { store, now: () => NOW }).append([
    {
      type: "budget.exhausted",
      payload: { scope: `run:${runId}`, limitUsd: 0, action: "fail" },
      actor: SYSTEM_ACTOR("policy"),
    },
  ]);

  const done = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a",
  });
  assert.equal(done.status, "succeeded", "the shape under test: the floor reaches run.completed");
  assert.equal(done.gates[open[1]!.gateId]?.state, "cancelled", "THE SURVIVING GATE WAS CLOSED WITH THE RUN");
  assert.deepEqual(await engine.openGates(runId), [], "nothing is left in the queue for a run that has ended");

  const closed = (await events(store, runId)).filter((ev) => ev.type === "gate.cancelled");
  assert.equal(closed.length, 1);
  const reason = (closed[0]!.payload as { reason: string }).reason;
  assert.doesNotMatch(reason, /cancel|fail/i, "an operator did not cancel this, and the run did not fail");
  assert.match(reason, /finished|completed/i, `the audit record says what actually happened, not "${reason}"`);

  const seq = await events(store, runId);
  const iClosed = seq.findIndex((ev) => ev.type === "gate.cancelled");
  const iRun = seq.findIndex((ev) => ev.type === "run.completed");
  assert.ok(iClosed >= 0 && iRun === iClosed + 1, "one durable fact: the gates, then the run");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · which status transitions are legal from a terminal state? none.
// ─────────────────────────────────────────────────────────────────────────────

test("NO STATUS TRANSITION IS LEGAL FROM A TERMINAL STATE", async () => {
  // The fold guarded `run.resumed` and nothing else, which made the rule a property of one
  // event rather than of the status. Every arm that MOVES the run's status is the same
  // question, so it is answered once: a terminal status has an `endedAt`, and nothing
  // appended afterwards can unmake it. Silent rather than throwing, for the reason the whole
  // fold is tolerant — a projection that crashes on a strange log cannot be used on the
  // incident that produced it.
  const later: readonly NewEvent[] = [
    { type: "run.started", payload: { posture: "in" }, actor: SYSTEM_ACTOR("scheduler") },
    { type: "run.suspended", payload: { reason: "gate" }, actor: SYSTEM_ACTOR("gate-broker") },
    { type: "run.resumed", payload: { by: "gate" }, actor: SYSTEM_ACTOR("gate-broker") },
    { type: "run.completed", payload: { outputs: { x: 1 }, usage: ZERO_USAGE }, actor: SYSTEM_ACTOR("executor") },
    { type: "run.failed", payload: { error: { class: "timeout", code: CODES.E_GATE_EXPIRED, message: "expired", retryable: false } }, actor: SYSTEM_ACTOR("gate-broker") },
    { type: "run.cancelled", payload: { clean: true, unknownEffects: [] }, actor: SYSTEM_ACTOR("operator") },
  ];

  for (const first of TERMINALS) {
    for (const second of later) {
      const runId = `run_${first.status}_${second.type}` as RunId;
      const store = new MemoryStateStore({ now: () => NOW });
      const log = new RunLog(runId, { store, now: () => NOW });
      await log.append([{ type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("scheduler") }]);
      await log.append([first.event]);
      const ended = (foldRun(await events(store, runId)))!.endedAt;
      await log.append([second]);

      const p = foldRun(await events(store, runId))!;
      assert.equal(p.status, first.status, `${first.status} was overwritten by ${second.type}`);
      assert.equal(p.endedAt, ended, `${second.type} moved the end of a ${first.status} run`);
    }
  }
});

test("THE SWEEP DOES NOT FAIL A RUN THAT ALREADY ENDED", async () => {
  // The append side of the same rule, and the legacy shape `resolve`'s check was kept for:
  // a cancelled run whose gate was left open by a build that did not close it. The sweep
  // read the gate, found it overdue, and appended `run.failed` — overwriting the operator's
  // cancellation with a timeout in every read model derived from that journal.
  const clock = { t: 1_000_000 };
  const store = new MemoryStateStore({ now: () => clock.t });
  const log = new RunLog(RUN, { store, now: () => clock.t });
  const broker = new HumanGateBroker({ now: () => clock.t });

  await log.append([{ type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("scheduler") }]);
  const gateId = await broker.raise(log, request({ slaMs: 60_000, onTimeout: "fail" }));
  // The legacy shape, written by hand: cancel WITHOUT closing the gate.
  await log.append([
    { type: "run.cancelled", payload: { clean: true, unknownEffects: [] }, actor: SYSTEM_ACTOR("operator") },
  ]);

  const before = (await broker.project(log))!;
  assert.equal(before.status, "cancelled");
  assert.equal(before.gates[gateId]?.state, "open", "the shape under test: a gate that outlived its run");

  clock.t += 120_000;
  assert.deepEqual(await broker.sweepTimeouts(log), [], "a dead run has no deadlines left to miss");

  const after = (await broker.project(log))!;
  assert.equal(after.status, "cancelled", "THE OPERATOR'S CANCELLATION SURVIVED");
  assert.equal(
    (await events(store, RUN)).some((ev) => ev.type === "run.failed"),
    false,
    "and no failure was appended to a run that had already ended",
  );
});

// ── 5 · an expiry splits an append too, and the boundary refusal did not see it ──

/**
 * The skeleton with a clock on its gate, so the sweep can expire it.
 *
 * `onTimeout: "fail"` is what routes the deadline through `HumanGateBroker.#expire`, which
 * writes `gate.timeout` + `run.failed` in ONE append — the identical two-seq shape the
 * `gate.decided` arm of `rewind`'s boundary scan refuses, arriving under a different event
 * type. That is register entry A10.
 */
function expiringSpec(): GraphSpec {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((node: NodeSpec) =>
      node.id !== n("approve")
        ? node
        : { ...node, humanGate: { ref: node.humanGate!.ref, sla: { respondWithinMs: 1000, onTimeout: "fail" as const } } },
    ),
  };
}

test("A REWIND ONTO A GATE'S EXPIRY IS REFUSED, for the same reason as one onto its decision", async () => {
  // Reproduced before the refusal, on this shape: `#expire` wrote `89:gate.timeout
  // 90:run.failed`; `rewind(runId, 89)` was ACCEPTED; the run folded to
  // `run=awaiting_gate gate=expired openGates=0`; `advance()` was a no-op with zero writes;
  // `sweepGates` fired nothing, because the gate is no longer open; and `resolveGate`
  // answered "is expired, not open". Neither the clock nor a human could move it — the same
  // permanent wedge the `gate.decided` arm exists to prevent, reached by asking for the seq
  // one door along.
  const h = harness();
  const graph = compileOrThrow({ spec: expiringSpec(), resolver: resolver(), tools: SKELETON_TOOLS, tenantCapabilities: SKELETON_TENANT_CAPS });
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  const parkedAt = await h.engine.advance(runId);
  assert.equal(parkedAt.status, "awaiting_gate");

  h.tick(5000);
  const report = await h.engine.sweepGates();
  assert.equal(report.fired.length, 1, "the deadline fired");

  const all = await events(h.store, runId);
  const timeout = all.find((ev) => ev.type === "gate.timeout")!;
  const failed = all.find((ev) => ev.type === "run.failed")!;
  assert.equal(failed.seq, timeout.seq + 1, "the expiry and the failure are ONE append, two seqs");

  await assert.rejects(
    () => h.engine.rewind(runId, timeout.seq, "undo the expiry"),
    conflict(CODES.E_RESTORE_ILLEGAL),
    "rewinding onto the expiry's own seq keeps it and drops the failure",
  );

  // …and both coherent readings of what the operator asked for still work, which is what
  // makes this a refusal rather than a wall. `atSeq - 1` reopens the gate.
  const reopened = await h.engine.rewind(runId, (timeout.seq - 1) as Seq, "ask again");
  assert.equal(reopened.status, "awaiting_gate");
  assert.equal(Object.values(reopened.gates).filter((g) => g.state === "open").length, 1, "the gate is answerable again");
  assert.equal(h.writes.length, 0, "and the action behind it still has not run");
});

test("…and a gate.timeout that is NOT an expiry is still a legal boundary", async () => {
  // The refusal above is narrowed to `action: "fail"`, and the narrowing is the load-bearing
  // half: `gate.timeout{default_action}` heads a THREE-event append (timeout + decision +
  // resume) whose FIRST seq suppresses all three and leaves the gate OPEN — recoverable,
  // and exactly what an operator asking for that seq wants. Refusing every `gate.timeout`
  // would take a working boundary away and nothing in the graph-driven suite would notice,
  // because `GateSlaSpec` cannot declare a `defaultAction` at all — only an embedder driving
  // `HumanGateBroker` directly can produce that row. So the row is written directly here,
  // which is also the honest statement of who can reach it.
  const { h, runId, gateId } = await parked();
  const at = await suspendedAt(h, runId);

  const log = new RunLog(runId, { store: h.store, now: () => NOW });
  await log.append([
    {
      type: "gate.timeout",
      payload: { gateId, action: "default_action" },
      actor: SYSTEM_ACTOR("gate-broker"),
    },
  ]);
  const marker = await h.store.head(runId);

  const rewound = await h.engine.rewind(runId, marker, "undo the clock's no-op");
  assert.equal(rewound.status, "awaiting_gate", "the run is where it was");
  assert.equal(rewound.gates[gateId]?.state, "open", "and the gate is still answerable");
  assert.ok(at <= marker, "the boundary really was inside this run's history");
});
