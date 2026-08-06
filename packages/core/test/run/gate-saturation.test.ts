/**
 * Approval-queue saturation control: batching and deduplication (D7.9 rows 2 and 3).
 *
 * Both mechanisms answer the same question — "how many times is a human asked?" — and
 * neither is allowed to answer a different one. That is the claim every test here
 * approaches from a different door:
 *
 * > **ONE DECISION MAY COVER N GATES ONLY IF EVERY CHECK THAT HELD FOR ONE HOLDS FOR ALL
 * > N, AND THE JOURNAL MUST SAY WHICH N IT COVERED.**
 *
 * The register calls batching "pure UX, no oversight semantics change", which is true of
 * the design and NOT true of any particular implementation until it is made true. So the
 * headline tests are not "gates merge" — they are: a batch whose members disagree on
 * approvers does not merge; a decision by somebody the batch does not name writes
 * NOTHING, not "everything except the gate that refused"; and a decision taken against a
 * manifest that has since moved is refused rather than applied to a list nobody read.
 *
 * The clock is injected everywhere and advanced by hand — windows are the whole subject
 * here, and a test that reads the wall clock cannot state one.
 *
 * See design/loom/04-OVERSIGHT.md D7.9, and D7.8 for which of the two `contentDigest`s
 * deduplication is keyed on.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { digest } from "../../src/canonical.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { BatchingSpec, DedupeSpec, GraphSpec, HumanGateNode, RunGraph } from "../../src/graph/spec.ts";
import { newRunId, type EdgeId, type GateId, type NodeId, type RunId, type Seq, type TaskId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { ConsoleChannel, GateDispatcher, type DeliveryChannel } from "../../src/run/delivery.ts";
import { HumanGateBroker, type GateBatch, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { openGates } from "../../src/run/projection.ts";
import { FunctionRegistry } from "../../src/run/registry.ts";
import { spansFrom } from "../../src/telemetry/spans.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const alice = { kind: "human", subject: "u:alice", via: "api" } as const;
const mallory = { kind: "human", subject: "u:mallory", via: "api" } as const;

const BATCHING: BatchingSpec = { enabled: true, key: "restart-pods", windowMs: 60_000, maxBatch: 20 };
const DEDUPE: DedupeSpec = { enabled: true, windowMs: 60_000 };

const refused = (code: string) => (err: unknown): true => {
  assert.ok(isLoomError(err), `expected a LoomError, got ${String(err)}`);
  assert.equal(err.code, code, err.message);
  return true;
};

// ---------------------------------------------------------------------------
// A graph that raises many gates at once
// ---------------------------------------------------------------------------

/**
 * `start` fans out over `hosts`; every branch stops at the same `human_gate`.
 *
 * This is the shape D7.9 row 2 names — "5–20× on wide fan-outs" — and it is the only
 * shape in which batching does anything at all: one node, N branches, N gates, one
 * question repeated. The gate declares no delivery, so nothing here depends on a channel.
 */
function fanoutGatedSpec(over: Partial<HumanGateNode> = {}): GraphSpec {
  const block: Record<string, unknown> = {
    ref: "oversight/restart-pod@stable",
    approval: { approvers: ["u:alice"] },
    ...over,
  };
  for (const k of Object.keys(block)) if (block[k] === undefined) delete block[k];
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "restart-pods", project: "sre", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 8, maxLoopIterations: 1 } },
    channels: {
      hosts: { type: "array", reduce: "replace" },
      host: { type: "string", reduce: "replace" },
      restarted: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["hosts"],
    outputs: ["restarted"],
    nodes: [
      { id: n("start"), type: "function", reads: ["hosts"], function: { ref: "function/noop@stable" } },
      { id: n("approve"), type: "human_gate", reads: ["host"], humanGate: block as unknown as HumanGateNode },
      {
        id: n("collect"),
        type: "join",
        join: { branches: [n("approve")], mode: "all", onBranchError: "fail", timeoutMs: 60_000 },
      },
      {
        id: n("restart"),
        type: "function",
        reads: ["hosts"],
        writes: ["restarted"],
        function: { ref: "function/restart@stable" },
      },
    ],
    edges: [
      { id: e("f0"), from: n("start"), to: n("approve"), kind: "fanout", over: "hosts", as: "host", maxWidth: 8 },
      { id: e("j1"), from: n("approve"), to: n("collect"), kind: "join", branches: [n("approve")] },
      { id: e("s2"), from: n("collect"), to: n("restart"), kind: "seq" },
    ],
  };
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly graph: RunGraph;
  readonly clock: { t: number };
  readonly restarted: string[];
}

function rig(spec: GraphSpec): Rig {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const restarted: string[] = [];
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/restart@stable", (view) => {
    const hosts = view.get<string[]>("hosts") ?? [];
    restarted.push(...hosts);
    return { writes: { restarted: hosts } };
  });
  const engine = new Engine({ store, functions, now });
  return { engine, store, graph: compileOrThrow({ spec, resolver: resolver(), tools: {} }), clock, restarted };
}

const HOSTS = ["web-1", "web-2", "web-3", "web-4", "web-5"];

async function parkAll(r: Rig): Promise<RunId> {
  const runId = await r.engine.submit({ graph: r.graph, inputs: { hosts: HOSTS } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "every branch stopped at the gate");
  assert.equal(openGates(p).length, HOSTS.length, "one gate per branch");
  return runId;
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<readonly JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// The headline: a graph declaring batching, whose gates merge
// ---------------------------------------------------------------------------

test("FIVE GATES BECOME ONE QUESTION, AND ONE DECISION CLOSES ALL FIVE", async () => {
  const r = rig(fanoutGatedSpec({ batching: BATCHING }));
  const runId = await parkAll(r);

  const batches = await r.engine.openGateBatches(runId);
  assert.equal(batches.length, 1, "five gates, one batch");
  const batch = batches[0]!;
  assert.equal(batch.members.length, 5);
  assert.equal(batch.key, "restart-pods");
  assert.deepEqual(batch.approvers, ["u:alice"]);
  assert.equal(
    batch.batchId,
    batch.members[0]!.gateId,
    "the batch is named by its first member — a batch has no identity of its own",
  );
  // Every member carries its own rendered payload, which is what per-item diffs are
  // rendered from. A manifest of five identical rows would be the careless-bulk-approve
  // risk D7.9 names, so the console has to be able to tell them apart.
  assert.deepEqual(
    batch.members.map((m) => (m.payload as { state?: { host?: string } }).state?.host),
    HOSTS,
  );

  const after = await r.engine.resolveGateBatch(runId, {
    batchId: batch.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "one-click",
    expectManifest: batch.manifestDigest,
  });

  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
  assert.deepEqual([...r.restarted].sort(), [...HOSTS].sort(), "the action behind every member ran");
  assert.equal(openGates(after).length, 0);
  for (const g of Object.values(after.gates)) assert.equal(g.state, "decided");
});

test("THE JOURNAL SAYS WHICH GATES ONE DECISION COVERED, AND IT IS ONE APPEND", async () => {
  const r = rig(fanoutGatedSpec({ batching: BATCHING }));
  const runId = await parkAll(r);
  const batch = (await r.engine.openGateBatches(runId))[0]!;
  const ids = batch.members.map((m) => m.gateId);

  await r.engine.resolveGateBatch(runId, {
    batchId: batch.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "one-click",
    expectManifest: batch.manifestDigest,
  });

  const events = await journal(r.store, runId);
  const receipt = events.filter((ev) => ev.type === "gate.batch_decided");
  assert.equal(receipt.length, 1, "one decision, one receipt");
  const payload = receipt[0]!.payload as {
    batchId: GateId;
    gateIds: readonly GateId[];
    manifestDigest: string;
    decision: string;
  };
  assert.equal(payload.batchId, batch.batchId);
  assert.equal(payload.decision, "approve");
  assert.deepEqual([...payload.gateIds], ids, "the complete member list, in journal order");
  assert.equal(payload.manifestDigest, batch.manifestDigest, "…and what the approver was shown");
  assert.deepEqual(receipt[0]!.actor, alice, "attributed to the human who clicked, not to the broker");

  // ONE APPEND: the five decisions and the receipt are contiguous, so no reader can
  // observe a state in which three of five gates are decided.
  const decided = events.filter((ev) => ev.type === "gate.decided");
  assert.equal(decided.length, 5);
  const seqs = [...decided.map((ev) => ev.seq), receipt[0]!.seq].sort((a, b) => a - b);
  assert.equal(seqs[seqs.length - 1]! - seqs[0]!, seqs.length - 1, `contiguous seqs, got ${seqs.join(",")}`);
  assert.deepEqual(
    decided.map((ev) => (ev.payload as { gateId: GateId }).gateId),
    ids,
    "one gate.decided per member — the state change is still per gate",
  );

  // THE RECEIPT IS RE-DERIVABLE FROM THE JOURNAL ALONE. An auditor months later holds the
  // log and nothing else; if the manifest digest could not be recomputed from it, the
  // field would pin nothing.
  const raises = new Map(
    events
      .filter((ev) => ev.type === "gate.raised")
      .map((ev) => [(ev.payload as { gateId: GateId }).gateId, ev.payload as { nodeId: NodeId; contentDigest: string }]),
  );
  const rederived = digest({
    batchId: payload.batchId,
    key: "restart-pods",
    items: ids.map((id) => ({ gateId: id, nodeId: raises.get(id)!.nodeId, contentDigest: raises.get(id)!.contentDigest })),
  });
  assert.equal(rederived, payload.manifestDigest);
});

test("A BATCH DECISION IS REFUSED FOR SOMEBODY THE GATES DO NOT NAME, AND WRITES NOTHING", async () => {
  const r = rig(fanoutGatedSpec({ batching: BATCHING }));
  const runId = await parkAll(r);
  const batch = (await r.engine.openGateBatches(runId))[0]!;

  await assert.rejects(
    () =>
      r.engine.resolveGateBatch(runId, {
        batchId: batch.batchId,
        decision: { kind: "approve" },
        actor: mallory,
        idempotencyKey: "m1",
        expectManifest: batch.manifestDigest,
      }),
    refused(CODES.E_GATE_NOT_AUTHORIZED),
  );

  const p = await r.engine.projection(runId);
  assert.equal(openGates(p!).length, 5, "all five gates are still open");
  assert.equal(r.restarted.length, 0, "and nothing behind any of them ran");
  const events = await journal(r.store, runId);
  assert.equal(events.filter((ev) => ev.type === "gate.decided").length, 0);
  assert.equal(events.filter((ev) => ev.type === "gate.batch_decided").length, 0);
});

test("A BATCH CARRIES APPROVE AND REJECT, AND NOTHING ELSE", async () => {
  const r = rig(fanoutGatedSpec({ batching: BATCHING }));
  const runId = await parkAll(r);
  const batch = (await r.engine.openGateBatches(runId))[0]!;

  for (const decision of [
    { kind: "edit", writes: { host: "web-9" } },
    { kind: "redirect", take: ["s1"] },
  ] as const) {
    await assert.rejects(
      () =>
        r.engine.resolveGateBatch(runId, {
          batchId: batch.batchId,
          decision,
          actor: alice,
          idempotencyKey: `k-${decision.kind}`,
          expectManifest: batch.manifestDigest,
        }),
      refused(CODES.E_GATE_NOT_AUTHORIZED),
    );
  }

  assert.equal(openGates((await r.engine.projection(runId))!).length, 5);
});

test("A BATCH REJECT FAILS THE RUN, AND A GRAPH WITHOUT BATCHING RAISES NO BATCH AT ALL", async () => {
  const rejected = rig(fanoutGatedSpec({ batching: BATCHING }));
  const runId = await parkAll(rejected);
  const batch = (await rejected.engine.openGateBatches(runId))[0]!;
  const after = await rejected.engine.resolveGateBatch(runId, {
    batchId: batch.batchId,
    decision: { kind: "reject", reason: "not during the freeze" },
    actor: alice,
    idempotencyKey: "no",
    expectManifest: batch.manifestDigest,
  });
  assert.equal(after.status, "failed");
  assert.equal(rejected.restarted.length, 0);

  // The control: the same graph with no `batching` block groups nothing, so a console
  // that reads batches sees none and every gate is answered on its own.
  const plain = rig(fanoutGatedSpec());
  const plainRun = await parkAll(plain);
  assert.deepEqual(await plain.engine.openGateBatches(plainRun), []);
  const p = await plain.engine.projection(plainRun);
  for (const g of openGates(p!)) assert.equal(g.batch, undefined);
});

test("A REWIND ONTO THE BATCH RECEIPT IS REFUSED, LIKE ONE ONTO A MEMBER'S OWN DECISION", async () => {
  // ONE APPEND, N+2 SEQS, AND ONE OF THEM WAS A HOLE. `resolveBatch` writes N
  // `gate.decided`, then `gate.batch_decided`, then `run.resumed`. `Engine.rewind` refuses
  // a boundary that lands on a `gate.decided` — keeping the decision and dropping the
  // resume wedges the run — and the receipt is neither, so the scan walked past it.
  //
  // REPRODUCED before the fix, on this graph: seqs `24,25,26:gate.decided
  // 27:gate.batch_decided 28:run.resumed`, and `rewind(runId, 27)` was **ACCEPTED**; the
  // run folded to `awaiting_gate` with **0 open gates**, and `advance()` was a no-op with
  // zero writes — three approvals kept, the resume gone, nothing for a human to answer and
  // nothing for the scheduler to pick up. It is register entry **A10** reached through a
  // new event type, which is the argument A10 makes for itself: the refusal is a property
  // of the APPEND BOUNDARY and it is written as a property of the event type, so every row
  // added to a decision's append has to be added here too or it opens the hole again.
  const r = rig(fanoutGatedSpec({ batching: BATCHING }));
  const runId = await parkAll(r);
  const batch = (await r.engine.openGateBatches(runId))[0]!;
  await r.engine.resolveGateBatch(runId, {
    batchId: batch.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "one-click",
    expectManifest: batch.manifestDigest,
  });

  const events = await journal(r.store, runId);
  const receipt = events.find((ev) => ev.type === "gate.batch_decided")!;
  assert.equal(events.find((ev) => ev.seq === ((receipt.seq + 1) as Seq))?.type, "run.resumed", "the shape under test");

  await assert.rejects(
    () => r.engine.rewind(runId, receipt.seq, "undo the batch"),
    refused(CODES.E_RESTORE_ILLEGAL),
  );

  // …and the two coherent readings of what the operator asked for both still work: one
  // seq up keeps the whole decision, one seq down is refused by the member's own arm and
  // the message says where to go instead.
  const kept = await r.engine.rewind(runId, (receipt.seq + 1) as Seq, "keep the decision");
  assert.equal(openGates(kept).length, 0);
  for (const g of Object.values(kept.gates)) assert.equal(g.state, "decided", "every member's decision survived");
});

// ---------------------------------------------------------------------------
// Queue ordering — D7.9 row 5
// ---------------------------------------------------------------------------

test("THE QUEUE IS ORDERED BY WHAT IS MOST URGENT, NOT BY WHEN IT ARRIVED", async () => {
  // D7.9 row 5. `list` returned `openGates(p)` — journal order — so the gate a person read
  // first was the one that happened to be raised first, and the SLA that was about to
  // breach could be anywhere in the list.
  //
  // THIS IS PRESENTATION AND NOTHING ELSE, which is why the last two assertions are here:
  // the same gates, all of them, still open, still answerable by the same people. An
  // ordering that changed the SET would not be an ordering.
  const b = bench();
  const relaxed = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 3_000_000 }));
  const urgent = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 60_000 }));
  const middle = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 900_000 }));

  const listed = await b.broker.list(b.log);
  assert.deepEqual(listed.map((g) => g.gateId), [urgent, middle, relaxed], "soonest deadline first");
  assert.equal(listed.length, 3, "the same three gates, none added and none hidden");
  assert.deepEqual(
    [...listed].sort().map((g) => g.gateId).sort(),
    [relaxed, urgent, middle].sort(),
    "…and it is the same SET, which is what makes this presentation",
  );

  // AND IT DOES NOT DEPEND ON WHEN IT IS ASKED. Ordering by remaining time and ordering by
  // absolute deadline are the same order at every instant, so the list cannot reshuffle
  // under a reader's cursor between rendering a manifest and clicking it.
  b.clock.t += 30_000;
  assert.deepEqual((await b.broker.list(b.log)).map((g) => g.gateId), [urgent, middle, relaxed]);
  b.clock.t += 2_000_000;
  assert.deepEqual((await b.broker.list(b.log)).map((g) => g.gateId), [urgent, middle, relaxed], "even past two deadlines");
});

test("A WIDER CLICK MOVES A GATE UP, AND DOES NOT OUTRANK A REAL DEADLINE", async () => {
  // Row 5's second key is unreachable under a strict lexicographic sort on remaining time:
  // two gates never have the same remaining time to the millisecond, so blast radius would
  // decide nothing, ever. The credit is that idea with a working spelling, and it is
  // BOUNDED, which is the half that keeps the ordering an ordering rather than a free-for-all.
  //
  // BLAST RADIUS HERE IS THE DECISION'S, not the action's: how many open gates one click
  // closes. Row 5's third key, `cost_at_risk`, is deliberately absent — it is a RUN-level
  // number and this is a run-level queue, so it would shift every rank equally and order
  // nothing. `gateQueueOrder` says what it would take.
  const b = bench();
  // A five-member batch: one click closes five questions. Same SLA as the singleton below.
  const members: GateId[] = [];
  for (let i = 0; i < 5; i++) members.push(await b.broker.raise(b.log, request(b, { slaMs: 1_800_000 })));
  const single = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 1_800_000 }));

  const listed = (await b.broker.list(b.log)).map((g) => g.gateId);
  assert.equal(listed[0], members[0], "the wider decision is read first");
  assert.equal(listed.at(-1), single, "…and the question that unblocks one branch is last");

  // AND A REAL DEADLINE STILL WINS. The credit is worth minutes, not hours: a singleton due
  // in a minute outranks a batch of five due in half an hour, which is the property that
  // makes this an SLA queue with a nudge rather than a popularity contest.
  const urgent = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 60_000 }));
  assert.equal((await b.broker.list(b.log))[0]?.gateId, urgent);
});

test("WHAT THE RANK READS: a click's LIVE width, a capped one, and an older journal's clock", async () => {
  // Three terms of the rank that a queue test can pass without ever reaching. Each is
  // driven against a control that differs in exactly the one field.

  // 1 · THE WIDTH IS WHAT IS STILL OPEN. A click closes what is open, so a batch whose
  // siblings have been answered one at a time is a batch of one however many rows it holds.
  // Counting rows instead would leave a spent batch permanently at the front of the queue.
  {
    const b = bench();
    const members: GateId[] = [];
    for (let i = 0; i < 5; i++) members.push(await b.broker.raise(b.log, request(b, { slaMs: 1_800_000 })));
    const single = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 1_740_000 }));
    assert.equal((await b.broker.list(b.log))[0]?.gateId, members[0], "five open members outrank a slightly sooner singleton");

    for (const id of members.slice(1)) {
      await b.broker.resolve(b.log, { gateId: id, decision: { kind: "approve" }, actor: alice, idempotencyKey: `a-${id}` });
    }
    assert.equal(
      (await b.broker.list(b.log))[0]?.gateId,
      single,
      "…and one open member is one question, whatever its batch used to hold",
    );
  }

  // 2 · THE WIDTH IS CAPPED. `maxBatch` is the graph author's number and it has no ceiling,
  // so an uncapped credit is a knob a graph could use to put itself at the front of every
  // queue forever — and, worse, to break the constraint the starvation bound rests on
  // (`maxCredit` below `AGEING_MS`).
  {
    const b = bench();
    const huge = { enabled: true, key: "restart-pods", windowMs: 600_000, maxBatch: 100 };
    const wide: GateId[] = [];
    for (let i = 0; i < 25; i++) wide.push(await b.broker.raise(b.log, request(b, { batching: huge, slaMs: 3_600_000 })));
    const sooner = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 2_340_000 }));
    assert.equal(
      (await b.broker.list(b.log))[0]?.gateId,
      sooner,
      "a 25-wide click buys 19 minutes, not 24 — the gate due 21 minutes sooner is read first",
    );
    assert.equal((await b.broker.list(b.log))[1]?.gateId, wide[0], "and the batch is right behind it");
  }

  // 3 · AN OLDER JOURNAL'S CLOCK STILL ORDERS. A gate raised before `deadline` was
  // journaled carries `slaMs` alone; `#deadlineOf` reads it as `raisedAtTs + slaMs` and so
  // must the rank, or the queue puts a gate that expires in a minute behind one that
  // expires in an hour — reading it as having no clock at all.
  {
    const b = bench();
    const legacy = "gate_legacy_sla" as GateId;
    await b.log.append([
      {
        type: "gate.raised",
        payload: {
          gateId: legacy,
          nodeId: n("approve"),
          policyRef: "oversight/restart-pod@stable",
          contentDigest: "sha256:aaa",
          approvers: ["u:alice"],
          allowEdit: [],
          slaMs: 60_000, // and NO deadline: the shape a build before that field wrote
        },
        actor: { kind: "system", component: "hand-written" },
        taskId: "approve@root/f0[0]#0" as TaskId,
        ts: b.clock.t,
      },
    ]);
    const later = await b.broker.raise(b.log, request(b, { batching: undefined, slaMs: 1_800_000 }));
    assert.deepEqual(
      (await b.broker.list(b.log)).map((g) => g.gateId),
      [legacy, later],
      "an SLA with no journaled deadline is still a deadline",
    );
  }
});

test("A QUEUE NOBODY CAN PUSH TO THE BACK FOREVER — the ageing term, driven", async () => {
  // "Starvation of low-priority gates — bounded by an ageing term" is row 5's own stated
  // risk, and an unbounded-starvation queue is a way to never answer a question. The bound
  // `gateQueueOrder` argues is:
  //
  //   > NOTHING RAISED MORE THAN `maxCredit` AFTER A GATE CAN EVER DISPLACE IT,
  //
  // where `maxCredit` is 19 minutes of blast radius — `(RADIUS_CAP − 1)·PER_MEMBER_MS`. So the
  // set of gates that can outrank a given one is CLOSED at a fixed instant. That is what is
  // driven here, as the adversary would: one cheap, deadline-less, unbatched question, and
  // then wave after wave of maximum-credit arrivals.
  //
  // IT IS NOT "THE OLD GATE IS ALWAYS FIRST", and writing the test that way is how this
  // claim would get overstated. Arrivals INSIDE the window legitimately jump it — they are
  // wide, expensive questions and the queue is supposed to say so.
  const b = bench();
  const wave = (round: number): BatchingSpec => ({ enabled: true, key: `wave-${round}`, windowMs: 600_000, maxBatch: 20 });
  const cosmetic = await b.broker.raise(b.log, request(b, { batching: undefined }));
  assert.equal((await b.broker.list(b.log))[0]?.gateId, cosmetic, "alone, it is first");

  // 1 · INSIDE THE WINDOW: twenty-wide batches arriving in the next few minutes do outrank
  // it, and are meant to.
  const early: GateId[] = [];
  for (let round = 0; round < 2; round++) {
    b.clock.t += 60_000;
    for (let i = 0; i < 20; i++) early.push(await b.broker.raise(b.log, request(b, { batching: wave(round), slaMs: 7_200_000 })));
  }
  assert.notEqual((await b.broker.list(b.log))[0]?.gateId, cosmetic, "a wide, expensive question does jump it");

  // 2 · PAST THE WINDOW: nothing raised after `raisedAtTs(cosmetic) + maxCredit` can get in
  // front of it, however many arrive and however wide they are.
  b.clock.t += 19 * 60_000 + 1;
  const late: GateId[] = [];
  for (let round = 2; round < 6; round++) {
    for (let i = 0; i < 20; i++) late.push(await b.broker.raise(b.log, request(b, { batching: wave(round), slaMs: 7_200_000 })));
    const order = (await b.broker.list(b.log)).map((g) => g.gateId);
    const mine = order.indexOf(cosmetic);
    for (const id of late) {
      assert.ok(mine < order.indexOf(id), `a gate raised past the window got in front (round ${round})`);
    }
  }

  // 3 · AND WHEN THE CLOSED SET IS ANSWERED, IT IS FIRST — which is what "the set only
  // shrinks" means for the person waiting. The eighty late arrivals are still open.
  for (const id of early) {
    await b.broker.resolve(b.log, { gateId: id, decision: { kind: "approve" }, actor: alice, idempotencyKey: `a-${id}` });
  }
  const finally_ = await b.broker.list(b.log);
  assert.equal(finally_[0]?.gateId, cosmetic, "the queue drained past it, and nothing new could push it back");
  assert.equal(finally_.length, 1 + late.length, "and every one of those newcomers is still there to answer");
});

// ---------------------------------------------------------------------------
// The merge predicate, driven directly, because a graph cannot make its own
// branches disagree
// ---------------------------------------------------------------------------

interface Bench {
  readonly clock: { t: number };
  readonly store: MemoryStateStore;
  readonly broker: HumanGateBroker;
  readonly log: RunLog;
  readonly runId: RunId;
}

function bench(): Bench {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const runId = newRunId(clock.t);
  return { clock, store, broker: new HumanGateBroker({ now }), log: new RunLog(runId, { store, now }), runId };
}

let seq = 0;

/**
 * A `GateRequest` override where an explicit `undefined` DELETES the field.
 *
 * `exactOptionalPropertyTypes` makes `{batching: undefined}` a different thing from `{}`,
 * and what these tests mean by `batching: undefined` is "declare no batching at all",
 * which is the second one — so the merge below removes the key rather than assigning it.
 */
type Over = { readonly [K in keyof GateRequest]?: GateRequest[K] | undefined };

/** One gate request, with everything that decides membership overridable. */
function request(b: Bench, over: Over = {}): GateRequest {
  seq += 1;
  const base: GateRequest = {
    runId: b.runId,
    taskId: `approve@root/f0[${seq}]#0` as TaskId,
    nodeId: n("approve"),
    policyRef: "oversight/restart-pod@stable",
    payload: { host: `web-${seq}` },
    approvers: ["u:alice"],
    allowEdit: [],
    batching: BATCHING,
  };
  const merged: Record<string, unknown> = { ...base, ...over };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as unknown as GateRequest;
}

async function batchesOf(b: Bench): Promise<readonly GateBatch[]> {
  return b.broker.listBatches(b.log);
}

test("A BATCH WHOSE MEMBERS DISAGREE ON APPROVERS DOES NOT MERGE", async () => {
  const b = bench();
  const first = await b.broker.raise(b.log, request(b, { approvers: ["u:alice"] }));
  const second = await b.broker.raise(b.log, request(b, { approvers: ["u:bob"] }));
  const third = await b.broker.raise(b.log, request(b, { approvers: ["u:alice"] }));

  const batches = await batchesOf(b);
  assert.equal(batches.length, 2, "two authorities, two batches — never one");
  const byId = new Map(batches.map((x) => [x.batchId, x.members.map((m) => m.gateId)]));
  assert.deepEqual(byId.get(first), [first, third], "the two gates naming u:alice merged");
  assert.deepEqual(byId.get(second), [second], "and the one naming u:bob stands alone");

  // The point of refusing the merge, stated as behaviour: alice's one click cannot reach
  // the gate she is not named on.
  const alices = batches.find((x) => x.batchId === first)!;
  await b.broker.resolveBatch(b.log, {
    batchId: alices.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
    expectManifest: alices.manifestDigest,
  });
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[first]?.state, "decided");
  assert.equal(p.gates[third]?.state, "decided");
  assert.equal(p.gates[second]?.state, "open", "u:bob's gate is untouched by u:alice's click");
});

test("A BATCH THAT SOMEHOW HOLDS MEMBERS WHO DISAGREE WRITES NOTHING AT ALL", async () => {
  // `batchFor` cannot build this batch — that is the previous test. This one hand-writes
  // the journal that a different build, or a repaired store, could hold, and pins the
  // SECOND half of the argument: membership is refused at raise AND every member is
  // validated before anything is written, so a batch containing one gate this actor may
  // not decide closes NONE of them rather than the ones it reached first.
  //
  // Which is why `resolveBatch` validates in a loop of its own instead of validating as
  // it builds the events: both orders throw, but only one of them throws before the
  // append is assembled — and "all of them or none" is the property, not "an exception".
  const b = bench();
  const now = b.clock.t;
  const mine = "gate_batch_leader" as GateId;
  const theirs = "gate_batch_member" as GateId;
  await b.log.append([
    {
      type: "gate.raised",
      payload: {
        gateId: mine,
        nodeId: n("approve"),
        policyRef: "oversight/restart-pod@stable",
        contentDigest: "sha256:aaa",
        approvers: ["u:alice"],
        allowEdit: [],
        batch: { id: mine, key: "restart-pods" },
      },
      actor: { kind: "system", component: "hand-written" },
      taskId: "approve@root/f0[0]#0" as TaskId,
      ts: now,
    },
    {
      type: "gate.raised",
      payload: {
        gateId: theirs,
        nodeId: n("approve"),
        policyRef: "oversight/restart-pod@stable",
        contentDigest: "sha256:bbb",
        approvers: ["u:bob"],
        allowEdit: [],
        batch: { id: mine, key: "restart-pods" },
      },
      actor: { kind: "system", component: "hand-written" },
      taskId: "approve@root/f0[1]#0" as TaskId,
      ts: now,
    },
  ]);

  const batch = (await batchesOf(b))[0]!;
  assert.deepEqual(batch.members.map((m) => m.gateId), [mine, theirs], "the journal says they are one batch");
  await assert.rejects(
    () =>
      b.broker.resolveBatch(b.log, {
        batchId: batch.batchId,
        decision: { kind: "approve" },
        actor: alice,
        idempotencyKey: "a1",
        expectManifest: batch.manifestDigest,
      }),
    refused(CODES.E_GATE_NOT_AUTHORIZED),
  );
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[mine]?.state, "open", "not even the gate u:alice IS named on");
  assert.equal(p.gates[theirs]?.state, "open");
  assert.equal((await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.decided").length, 0);
});

test("NOR ON THE EDIT ALLOW-LIST, THE POLICY, OR MIRROR-NESS — and absent is not []", async () => {
  const b = bench();
  const first = await b.broker.raise(b.log, request(b));
  const otherAllow = await b.broker.raise(b.log, request(b, { allowEdit: ["plan"] }));
  const absentAllow = await b.broker.raise(b.log, request(b, { allowEdit: undefined }));
  const otherPolicy = await b.broker.raise(b.log, request(b, { policyRef: "oversight/other@stable" }));
  const mirror = await b.broker.raise(b.log, request(b, { mirrorOf: "gate_elsewhere" as GateId }));

  const batches = await batchesOf(b);
  const ids = new Set(batches.map((x) => x.batchId));
  assert.deepEqual([...ids], [first, otherAllow, absentAllow, otherPolicy], "four batches of one, and no fifth");
  for (const x of batches) assert.equal(x.members.length, 1);

  const p = (await b.broker.project(b.log))!;
  assert.equal(
    p.gates[mirror]?.batch,
    undefined,
    "a mirror gate never batches: its answer is forwarded into another run",
  );
});

test("maxBatch CAPS WHAT ONE CLICK CAN CLOSE, AND COUNTS MEMBERS THAT ARE ALREADY DECIDED", async () => {
  const b = bench();
  const spec: BatchingSpec = { ...BATCHING, maxBatch: 2 };
  const ids: GateId[] = [];
  for (let i = 0; i < 5; i++) ids.push(await b.broker.raise(b.log, request(b, { batching: spec })));

  const batches = await batchesOf(b);
  assert.deepEqual(
    batches.map((x) => x.members.map((m) => m.gateId)),
    [
      [ids[0]!, ids[1]!],
      [ids[2]!, ids[3]!],
      [ids[4]!],
    ],
    "2, 2, 1 — and each batch fills before the next one opens",
  );

  // Decide the first batch, then raise a sixth. A cap that counted only OPEN members
  // would let the emptied batch refill forever, so a click could close more than two.
  const full = batches[0]!;
  await b.broker.resolveBatch(b.log, {
    batchId: full.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
    expectManifest: full.manifestDigest,
  });
  const sixth = await b.broker.raise(b.log, request(b, { batching: spec }));
  const p = (await b.broker.project(b.log))!;
  assert.notEqual(p.gates[sixth]?.batch?.id, full.batchId, "the decided batch is full forever");
  assert.equal(p.gates[sixth]?.batch?.id, ids[4], "…and the sixth joins the batch that still has room");
});

test("THE FOUNDING SPEC GOVERNS THE BATCH FOR ITS WHOLE LIFE, AND A JOINER CANNOT WIDEN IT", async () => {
  // D7.9 row 2's whole safety argument is that `maxBatch` caps the blast radius of a single
  // click. `batchFor` used to evaluate that cap — and the window, and the delivery route —
  // against the BatchingSpec of whichever gate was joining, so a batch founded under one
  // policy was silently governed by a later applicant's. Measured before the fix: a batch
  // founded under `maxBatch: 2`, joined by nine gates declaring `maxBatch: 20`, came back as
  // ONE BATCH OF TEN — five times the authorised radius, with nothing in the journal saying
  // the cap had moved, because nothing in the journal had ever carried it.
  //
  // Each half below differs from the founder in EXACTLY ONE field, so neither can pass for
  // the other's reason.
  const TIGHT: BatchingSpec = { enabled: true, key: "restart-pods", windowMs: 1_000, maxBatch: 2 };

  // 1 · THE CAP. A third gate declaring a bigger cap, inside the window, on a batch that is
  // already full at the founding cap of 2.
  {
    const b = bench();
    const founder = await b.broker.raise(b.log, request(b, { batching: TIGHT }));
    const second = await b.broker.raise(b.log, request(b, { batching: TIGHT }));
    const bigger = await b.broker.raise(b.log, request(b, { batching: { ...TIGHT, maxBatch: 20 } }));

    const p = (await b.broker.project(b.log))!;
    assert.equal(p.gates[second]?.batch?.id, founder, "the control: an identical spec still merges");
    assert.equal(p.gates[bigger]?.batch?.id, bigger, "a bigger cap does not enlarge a batch founded under a smaller one");
    const mine = (await batchesOf(b)).find((x) => x.batchId === founder)!;
    assert.equal(mine.members.length, TIGHT.maxBatch, "one click still closes at most what the founder authorised");
  }

  // 2 · THE WINDOW. A joiner arriving 100 s after a batch founded under a 1 s window, whose
  // own spec declares an hour. Anchoring is already the founder's (the test below); what
  // this pins is whose DURATION is measured against that anchor.
  {
    const b = bench();
    const founder = await b.broker.raise(b.log, request(b, { batching: TIGHT }));
    b.clock.t += 100_000;
    const longer = await b.broker.raise(b.log, request(b, { batching: { ...TIGHT, windowMs: 3_600_000 } }));
    const p = (await b.broker.project(b.log))!;
    assert.equal(p.gates[longer]?.batch?.id, longer, "a window a newcomer can extend is not a window");
    assert.equal(p.gates[founder]?.batch?.id, founder);
  }

  // 3 · AND IT IS IN THE JOURNAL, which is the half that makes the two above hold in a
  // process that did not raise the founder. A cap read out of the applicant's request is a
  // cap no reader of the log can check.
  {
    const b = bench();
    const founder = await b.broker.raise(b.log, request(b, { batching: TIGHT }));
    const marker = (await b.broker.project(b.log))!.gates[founder]?.batch;
    assert.equal(marker?.maxBatch, TIGHT.maxBatch, "the batch's own cap is a durable fact");
    assert.equal(marker?.windowMs, TIGHT.windowMs, "…and so is its window");
  }
});

test("A JOINER THAT DISAGREES ABOUT THE POLICY STARTS ITS OWN BATCH, INSIDE THE WINDOW AND UNDER THE CAP", async () => {
  // THE HALF THE TEST ABOVE CANNOT REACH, found by mutation: each of its three cases is
  // refused by something OTHER than the governance equality — case 1 by the cap being full,
  // case 2 by the window having closed — so deleting `key`, `windowMs` or `maxBatch` from
  // `sameGovernance` left the whole suite green. What that predicate is FOR is the joiner
  // that would otherwise be admitted: inside the window, well under the cap, identical
  // authority, and a different policy.
  //
  // `key` is the one with teeth. It is D7.9 row 2's declared grouping, and without the
  // conjunct two DIFFERENT questions — same approvers, same policy ref, different batching
  // key — merge into one manifest that one click closes.
  const ROOMY: BatchingSpec = { enabled: true, key: "restart-pods", windowMs: 60_000, maxBatch: 20 };
  for (const [why, over] of [
    ["a different grouping key is a different question", { key: "delete-volumes" }],
    ["a different window is a different batch, even when both are open", { windowMs: 30_000 }],
    ["and so is a different cap on what one click closes", { maxBatch: 5 }],
  ] as const) {
    const b = bench();
    const founder = await b.broker.raise(b.log, request(b, { batching: ROOMY }));
    b.clock.t += 1_000; // inside the 60 s window, and the batch holds one of twenty
    const other = await b.broker.raise(b.log, request(b, { batching: { ...ROOMY, ...over } }));
    const p = (await b.broker.project(b.log))!;
    assert.equal(p.gates[other]?.batch?.id, other, why);
    assert.equal((await batchesOf(b)).length, 2, `two manifests, visibly split (${why})`);
  }

  // THE CONTROL, so this is not "nothing merges": the same policy, same instant, one batch.
  const c = bench();
  const lead = await c.broker.raise(c.log, request(c, { batching: ROOMY }));
  c.clock.t += 1_000;
  const join = await c.broker.raise(c.log, request(c, { batching: ROOMY }));
  assert.equal((await c.broker.project(c.log))!.gates[join]?.batch?.id, lead);
});

test("A BATCH WHOSE MEMBERS DISAGREE ABOUT ITS OWN POLICY ADMITS NOBODY", async () => {
  // `batchGovernance` reads the policy off `members[0]` and then requires EVERY member to
  // agree with it. Unanimity is the fail-closed reading, and nothing held it: with the loop
  // deleted the whole suite stayed green while a batch whose second row declared
  // `maxBatch: 2` accepted a third member under the first row's `maxBatch: 20`.
  //
  // On a journal `raise` produced the members cannot disagree — every one of them wrote the
  // marker it was admitted under. This is about the other kind: a repaired log, an import,
  // a second broker. "The first row wins" would let whoever wrote it choose the cap by
  // ordering, which is the same defect as reading the cap off the applicant, one layer down.
  const b = bench();
  const founder = "gate_disagree_a" as GateId;
  const dissenter = "gate_disagree_b" as GateId;
  const marker = { id: founder, key: "restart-pods", windowMs: 60_000, maxBatch: 20 };
  await b.log.append(
    [founder, dissenter].map((gateId, i) => ({
      type: "gate.raised" as const,
      payload: {
        gateId,
        nodeId: n("approve"),
        policyRef: "oversight/restart-pod@stable",
        contentDigest: "sha256:aaa",
        approvers: ["u:alice"],
        allowEdit: [],
        // The second member's row says the batch may close two gates; the first says twenty.
        batch: i === 0 ? marker : { ...marker, maxBatch: 2 },
      },
      actor: { kind: "system" as const, component: "hand-written" },
      taskId: `approve@root/f0[${i}]#0` as TaskId,
      ts: b.clock.t,
    })),
  );

  const applicant = await b.broker.raise(b.log, request(b));
  const p = (await b.broker.project(b.log))!;
  assert.equal(
    p.gates[applicant]?.batch?.id,
    applicant,
    "a batch that cannot state its own policy is not one anything may be added to",
  );
  assert.equal((await batchesOf(b)).length, 2, "the hand-written group, and the applicant's own");

  // THE CONTROL: the identical journal with both rows agreeing admits the applicant, so the
  // refusal above is the disagreement and not the hand-written shape.
  const c = bench();
  await c.log.append(
    [founder, dissenter].map((gateId, i) => ({
      type: "gate.raised" as const,
      payload: {
        gateId,
        nodeId: n("approve"),
        policyRef: "oversight/restart-pod@stable",
        contentDigest: "sha256:aaa",
        approvers: ["u:alice"],
        allowEdit: [],
        batch: marker,
      },
      actor: { kind: "system" as const, component: "hand-written" },
      taskId: `approve@root/f0[${i}]#0` as TaskId,
      ts: c.clock.t,
    })),
  );
  const admitted = await c.broker.raise(c.log, request(c));
  assert.equal((await c.broker.project(c.log))!.gates[admitted]?.batch?.id, founder);
});

test("A SATURATION BLOCK THAT SAYS `enabled: false` IS OFF IN THE BROKER, NOT ONLY IN THE COMPILER", async () => {
  // `enabled` is the field an author writes when they have thought about a mechanism and
  // decided against it, and it was the one field of either spec nothing tested. Deleting
  // `spec.enabled !== true` from `usableBatching` — and, separately, from `usableDedupe` —
  // left the whole suite green while a graph that had declared the control OFF got it ON:
  // gates merged into a batch nobody asked for, and a question that says "ask again" was
  // answered from an old click. Everything else in the block is legal and complete, which
  // is what makes the flag the only thing being read.
  const b = bench();
  const off: BatchingSpec = { enabled: false, key: "restart-pods", windowMs: 60_000, maxBatch: 20 };
  const first = await b.broker.raise(b.log, request(b, { batching: off }));
  const second = await b.broker.raise(b.log, request(b, { batching: off }));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[first]?.batch, undefined, "no marker at all — not a batch of one");
  assert.equal(p.gates[second]?.batch, undefined);
  assert.deepEqual(await batchesOf(b), [], "and nothing to show a console");

  const c = bench();
  const dedupeOff: DedupeSpec = { enabled: false, windowMs: 60_000 };
  const asked = await c.broker.raise(
    c.log,
    request(c, { payload: { host: "web-1" }, batching: undefined, dedupe: dedupeOff }),
  );
  await c.broker.resolve(c.log, { gateId: asked, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  const again = await c.broker.raise(
    c.log,
    request(c, { payload: { host: "web-1" }, batching: undefined, dedupe: dedupeOff }),
  );
  const pc = (await c.broker.project(c.log))!;
  assert.equal(pc.gates[again]?.state, "open", "the identical question is asked again, which is what off means");
  assert.equal((await journal(c.store, c.runId)).filter((ev) => ev.type === "gate.deduped").length, 0);
});

test("A BATCH WHOSE GOVERNANCE THE JOURNAL DOES NOT CARRY ACCEPTS NOBODY", async () => {
  // The fail-closed half of the rule above, and the shape a journal an older build wrote
  // really has: a batch marker with an id and a key and no cap at all. There is nothing to
  // govern a join, so nothing joins — the newcomer starts its own batch rather than
  // supplying the missing cap itself, which is the reading that put the applicant in charge
  // in the first place.
  //
  // Every authorization field below matches `request(b)` exactly, so this gate WOULD have
  // merged on the old predicate; the only thing it disagrees with is a policy nobody wrote
  // down.
  const b = bench();
  const legacy = "gate_legacy_founder" as GateId;
  await b.log.append([
    {
      type: "gate.raised",
      payload: {
        gateId: legacy,
        nodeId: n("approve"),
        policyRef: "oversight/restart-pod@stable",
        contentDigest: "sha256:aaa",
        approvers: ["u:alice"],
        allowEdit: [],
        batch: { id: legacy, key: "restart-pods" },
      },
      actor: { kind: "system", component: "hand-written" },
      taskId: "approve@root/f0[0]#0" as TaskId,
      ts: b.clock.t,
    },
  ]);

  const joiner = await b.broker.raise(b.log, request(b));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[joiner]?.batch?.id, joiner, "an ungoverned batch is not a batch anything may be added to");
  assert.equal((await batchesOf(b)).length, 2);

  // The same refusal for governance the journal carries and nothing can read as governance.
  // `usableBatching`'s reasoning one layer up, asked of a value that came out of a log
  // rather than out of a request: a window that is not a number loses every comparison, and
  // a cap of 1 declares a mechanism that can never merge anything.
  //
  // NOT `NaN`, and that is a measurement worth leaving here rather than a stylistic choice:
  // a `NaN` cap cannot be journaled at all. `canonical.ts` refuses a non-finite number, so
  // `append` throws `CanonicalizationError: non-finite number NaN at batch.maxBatch` before
  // the row exists. The dangerous shapes that CAN reach a reader are the ones below.
  for (const [why, gov] of [
    ["a window that is not a number", { windowMs: "1000", maxBatch: 20 }],
    ["a cap two gates could never reach", { windowMs: 60_000, maxBatch: 1 }],
    ["a window of zero", { windowMs: 0, maxBatch: 20 }],
  ] as const) {
    const c = bench();
    const broken = "gate_broken_founder" as GateId;
    await c.log.append([
      {
        type: "gate.raised",
        payload: {
          gateId: broken,
          nodeId: n("approve"),
          policyRef: "oversight/restart-pod@stable",
          contentDigest: "sha256:aaa",
          approvers: ["u:alice"],
          allowEdit: [],
          batch: { id: broken, key: "restart-pods", ...gov } as unknown as { id: GateId; key: string },
        },
        actor: { kind: "system", component: "hand-written" },
        taskId: "approve@root/f0[0]#0" as TaskId,
        ts: c.clock.t,
      },
    ]);
    const late = await c.broker.raise(c.log, request(c));
    assert.equal((await c.broker.project(c.log))!.gates[late]?.batch?.id, late, why);
  }
});

test("THE WINDOW IS MEASURED FROM THE BATCH'S FIRST MEMBER, NOT FROM THE LAST ONE TO JOIN", async () => {
  const b = bench();
  const first = await b.broker.raise(b.log, request(b));
  b.clock.t += 40_000;
  const second = await b.broker.raise(b.log, request(b));
  assert.equal((await b.broker.project(b.log))!.gates[second]?.batch?.id, first, "40s into a 60s window");

  // 70s after the FIRST member, and 30s after the second. Anchoring on the newest member
  // would keep a batch alive indefinitely as long as gates kept arriving.
  b.clock.t += 30_000;
  const third = await b.broker.raise(b.log, request(b));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[third]?.batch?.id, third, "the window closed; the third gate starts its own batch");
  assert.equal((await batchesOf(b)).length, 2);
});

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

test("A DECISION TAKEN AGAINST A MANIFEST THAT HAS SINCE MOVED IS REFUSED", async () => {
  const b = bench();
  const first = await b.broker.raise(b.log, request(b));
  const shown = (await batchesOf(b))[0]!;
  assert.deepEqual(shown.members.map((m) => m.gateId), [first]);

  // A member joins inside the window, after the approver read the manifest.
  const second = await b.broker.raise(b.log, request(b));
  assert.equal((await b.broker.project(b.log))!.gates[second]?.batch?.id, first);

  await assert.rejects(
    () =>
      b.broker.resolveBatch(b.log, {
        batchId: shown.batchId,
        decision: { kind: "approve" },
        actor: alice,
        idempotencyKey: "stale",
        expectManifest: shown.manifestDigest,
      }),
    refused(CODES.E_GATE_ALREADY_RESOLVED),
  );
  const p = (await b.broker.project(b.log))!;
  assert.equal(openGates(p).length, 2, "nothing was decided against a list nobody read");

  // Re-reading the batch shows both, and the decision then applies to both.
  const fresh = (await batchesOf(b))[0]!;
  assert.notEqual(fresh.manifestDigest, shown.manifestDigest);
  const out = await b.broker.resolveBatch(b.log, {
    batchId: fresh.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "fresh",
    expectManifest: fresh.manifestDigest,
  });
  assert.deepEqual([...out.gateIds], [first, second]);
});

test("A SECOND CLICK ON A BATCH IS THE SAME DECISION, NOT A SECOND ONE", async () => {
  const b = bench();
  await b.broker.raise(b.log, request(b));
  await b.broker.raise(b.log, request(b));
  const batch = (await batchesOf(b))[0]!;
  const input = {
    batchId: batch.batchId,
    decision: { kind: "approve" } as const,
    actor: alice,
    idempotencyKey: "double-click",
    expectManifest: batch.manifestDigest,
  };

  const first = await b.broker.resolveBatch(b.log, input);
  assert.equal(first.resolved, true);
  const second = await b.broker.resolveBatch(b.log, input);
  assert.equal(second.resolved, false, "a repeat collapses rather than 404ing on a batch it just closed");

  const events = await journal(b.store, b.runId);
  assert.equal(events.filter((ev) => ev.type === "gate.batch_decided").length, 1);
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test("AN IDENTICAL QUESTION ALREADY ANSWERED IS ANSWERED AGAIN, IN THE APPEND THAT RAISES IT", async () => {
  const b = bench();
  const payload = { host: "web-1", action: "restart" };
  const first = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  await b.broker.resolve(b.log, {
    gateId: first,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
  });

  b.clock.t += 5_000;
  const second = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));

  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[second]?.state, "decided", "the duplicate collapsed onto the first answer");
  assert.equal(p.gates[second]?.decision, "approve");
  assert.equal(openGates(p).length, 0);

  const events = await journal(b.store, b.runId);
  const deduped = events.filter((ev) => ev.type === "gate.deduped");
  assert.equal(deduped.length, 1);
  const payloadOut = deduped[0]!.payload as { gateId: GateId; ofGateId: GateId; contentDigest: string; decision: string };
  assert.equal(payloadOut.gateId, second);
  assert.equal(payloadOut.ofGateId, first, "…naming the gate whose decision it inherited");
  assert.equal(payloadOut.decision, "approve");
  assert.equal(payloadOut.contentDigest, p.gates[first]!.contentDigest);

  // ONE APPEND, and no suspension: the run never waited on this gate, so writing a
  // `run.suspended` and a `run.resumed` for it would be two contradictory status facts
  // about a suspension that did not happen.
  const tail = events.filter((ev) => ev.seq > events.findIndex((x) => x.type === "gate.decided") + 1);
  const raisedSecond = events.find((ev) => ev.type === "gate.raised" && (ev.payload as { gateId: GateId }).gateId === second)!;
  const decidedSecond = events.find(
    (ev) => ev.type === "gate.decided" && (ev.payload as { gateId: GateId }).gateId === second,
  )!;
  assert.equal(decidedSecond.seq - raisedSecond.seq, 2, "raised, deduped, decided — three rows, one append");
  assert.deepEqual(
    tail.filter((ev) => ev.seq >= raisedSecond.seq).map((ev) => ev.type),
    ["gate.raised", "gate.deduped", "gate.decided"],
    "no run.suspended and no run.resumed for a gate that never suspended the run",
  );

  // The decision is journaled as the broker's, not as alice's: she never saw this gate.
  // Her name is one hop away, on the row `ofGateId` points at.
  assert.deepEqual(decidedSecond.actor, { kind: "system", component: "gate-broker:dedupe" });
  const decidedFirst = events.find(
    (ev) => ev.type === "gate.decided" && (ev.payload as { gateId: GateId }).gateId === payloadOut.ofGateId,
  )!;
  assert.deepEqual(decidedFirst.actor, alice);
});

test("NEITHER MECHANISM LEAVES A GATE SPAN HANGING OPEN", async () => {
  // The clock's own defect, one door over: a `loom.gate` span that never closes falls out
  // of the end-of-journal sweep with `status: "unset"` and reads exactly like a gate still
  // waiting for a human. Both mechanisms here close gates by writing `gate.decided`, which
  // is the arm `spans.ts` already has — so this passes with NO change to `telemetry/`, and
  // it is a test rather than an assurance because that is the difference between the two.
  const b = bench();
  const payload = { host: "web-1" };
  const asked = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  await b.broker.resolve(b.log, { gateId: asked, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  const duplicate = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  const batched = await b.broker.raise(b.log, request(b, { payload: { host: "web-2" } }));
  const alsoBatched = await b.broker.raise(b.log, request(b, { payload: { host: "web-3" } }));
  const batch = (await batchesOf(b))[0]!;
  await b.broker.resolveBatch(b.log, {
    batchId: batch.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a2",
    expectManifest: batch.manifestDigest,
  });

  const spans = spansFrom(await journal(b.store, b.runId));
  const gates = new Map(
    spans.filter((s) => s.name === "loom.gate").map((s) => [s.attributes["gate.id"] as GateId, s] as const),
  );
  for (const id of [asked, duplicate, batched, alsoBatched]) {
    assert.notEqual(gates.get(id), undefined, `gate ${id} has a span`);
    // A CLOSED span, not merely a present one. `spansFrom` emits an UNCLOSED span too —
    // with `endTime` at the last observed event and `status: "unset"` — so `endTime` is
    // never absent and asking whether it is there proves nothing. The status is the field
    // that distinguishes "this gate was answered" from "this gate is still waiting".
    assert.equal(gates.get(id)!.status, "ok", `gate ${id}'s span is closed, not left hanging`);
  }
  // …and the one question a reviewer opens a trace to ask is answerable as a FILTER
  // rather than a format-sniff: which of these did a person actually decide?
  assert.equal(gates.get(asked)!.attributes["gate.approver_kind"], "human");
  assert.equal(gates.get(duplicate)!.attributes["gate.approver_kind"], "system");
  assert.equal(gates.get(batched)!.attributes["gate.approver_kind"], "human");
});

test("A DUPLICATE OF AN UNANSWERED QUESTION IS NOT COLLAPSED — THERE IS NOTHING TO INHERIT", async () => {
  const b = bench();
  const payload = { host: "web-1" };
  const first = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  const second = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));

  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[first]?.state, "open");
  assert.equal(p.gates[second]?.state, "open", "the second waits on a human, not on the first gate");
  assert.equal((await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.deduped").length, 0);
});

test("DEDUP INHERITS FROM A `decided` GATE AND FROM NO OTHER STATE", async () => {
  // WHAT HOLDS THIS, said out loud because no single-guard revert can show it.
  // `#inheritable` states the rule twice — `g.state !== "decided"` skips the gate, and
  // `decisionOf(g) === undefined` refuses what is left — and over any journal `foldRun`
  // can produce the two are the SAME condition: `decision` is written in exactly ONE arm
  // of `projection.ts` (`gate.decided`), which sets `state: "decided"` in the same object,
  // and every other gate transition folds only from `open`. So reverting either conjunct
  // alone is invisible, and both stay for different readers — the state test says which
  // gates are ELIGIBLE, the decision test says whether the record carries the DATA, which
  // a journal an older build wrote may not.
  //
  // THIS COMMENT USED TO CLAIM A MEASUREMENT IT DID NOT HAVE. It said the test "turns red
  // on `decisionOf`'s `default:` arm answering `{kind: 'approve'}` instead of `undefined`",
  // and it did not: the two closings below are `cancelled` and `expired`, which the STATE
  // conjunct rejects before `decisionOf` is ever called, so that arm was reached by nothing
  // here. Run against the whole tree with the arm mutated, the suite stayed at
  // **1223 pass / 0 fail** — the arm was held by nothing anywhere. The block at the end of
  // this test is what makes the sentence true, and it is separated from the loop because it
  // holds a different line.
  const payload = { host: "web-1" };
  const closings = [
    ["cancelled", { type: "gate.cancelled", reason: "the run ended without you" }],
    ["expired", { type: "gate.timeout", action: "fail" }],
  ] as const;

  for (const [state, closing] of closings) {
    const b = bench();
    const source = "gate_source" as GateId;
    const taskId = "approve@root/f0[0]#0" as TaskId;
    await b.log.append([
      {
        type: "gate.raised",
        payload: {
          gateId: source,
          nodeId: n("approve"),
          policyRef: "oversight/restart-pod@stable",
          contentDigest: digest(payload),
          approvers: ["u:alice"],
          allowEdit: [],
        },
        actor: { kind: "system", component: "hand-written" },
        taskId,
      },
      closing.type === "gate.cancelled"
        ? {
            type: "gate.cancelled",
            payload: { gateId: source, reason: closing.reason },
            actor: { kind: "system", component: "hand-written" },
          }
        : {
            type: "gate.timeout",
            payload: { gateId: source, action: "fail" },
            actor: { kind: "system", component: "hand-written" },
          },
    ]);
    const p0 = (await b.broker.project(b.log))!;
    assert.equal(p0.gates[source]?.state, state, "the source gate is in the state under test");
    assert.equal(p0.gates[source]?.decision, undefined, "…and no state but `decided` carries a decision");

    const second = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
    const p = (await b.broker.project(b.log))!;
    assert.equal(p.gates[second]?.state, "open", `a ${state} gate answers nothing, so a human is asked`);
    assert.equal((await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.deduped").length, 0, state);
  }

  // The control, so the loop above is not passing because dedup never fires on a
  // hand-written journal: the identical shape, closed by a DECISION, is inherited.
  const c = bench();
  const decided = "gate_source" as GateId;
  await c.log.append([
    {
      type: "gate.raised",
      payload: {
        gateId: decided,
        nodeId: n("approve"),
        policyRef: "oversight/restart-pod@stable",
        contentDigest: digest(payload),
        approvers: ["u:alice"],
        allowEdit: [],
      },
      actor: { kind: "system", component: "hand-written" },
      taskId: "approve@root/f0[0]#0" as TaskId,
    },
    { type: "gate.decided", payload: { gateId: decided, decision: "approve", latencyMs: 1 }, actor: alice },
  ]);
  const dup = await c.broker.raise(c.log, request(c, { payload, batching: undefined, dedupe: DEDUPE }));
  assert.equal((await c.broker.project(c.log))!.gates[dup]?.state, "decided", "the control inherits");

  // AND THE `decided` GATE WHOSE DECISION IS IN NO VOCABULARY — the state conjunct admits
  // it and only `decisionOf` refuses it, so this is the case that holds that arm.
  //
  // It is register entry **A19** reached one layer in. A19's finding is that an unreadable
  // decision took the PERMISSIVE branch at the point of use; here the same unreadable value
  // would be copied onto a *second* gate, by a system actor, in the append that raises it —
  // an approval nobody gave, on a question nobody was asked. `GateRecord.decision` is typed
  // as the four-member union and a journal is not obliged to honour that (invariant 2:
  // authoritative, not well-formed), which is exactly why the arm exists.
  for (const word of ["APPROVE", "approved", "yes", ""]) {
    const d = bench();
    const odd = "gate_odd_decision" as GateId;
    await d.log.append([
      {
        type: "gate.raised",
        payload: {
          gateId: odd,
          nodeId: n("approve"),
          policyRef: "oversight/restart-pod@stable",
          contentDigest: digest(payload),
          approvers: ["u:alice"],
          allowEdit: [],
        },
        actor: { kind: "system", component: "hand-written" },
        taskId: "approve@root/f0[0]#0" as TaskId,
      },
      {
        type: "gate.decided",
        payload: { gateId: odd, decision: word as "approve", latencyMs: 1 },
        actor: alice,
        taskId: "approve@root/f0[0]#0" as TaskId,
      },
    ]);
    const p0 = (await d.broker.project(d.log))!;
    assert.equal(p0.gates[odd]?.state, "decided", `a ${JSON.stringify(word)} decision still folds to decided`);

    const heir = await d.broker.raise(d.log, request(d, { payload, batching: undefined, dedupe: DEDUPE }));
    const p1 = (await d.broker.project(d.log))!;
    assert.equal(p1.gates[heir]?.state, "open", `${JSON.stringify(word)} is not a decision, so a human is asked`);
    assert.equal(p1.gates[heir]?.decision, undefined);
    assert.equal(
      (await journal(d.store, d.runId)).filter((ev) => ev.type === "gate.deduped").length,
      0,
      `nothing was inherited from ${JSON.stringify(word)}`,
    );
  }
});

test("DEDUP IS REFUSED BY EVERY TERM OF THE EQUALITY IT RESTS ON", async () => {
  const payload = { host: "web-1" };

  /** Answer one gate, then raise a second that differs in exactly one way. */
  async function differing(over: Over, advanceMs = 0): Promise<{ b: Bench; second: GateId }> {
    const b = bench();
    const first = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
    await b.broker.resolve(b.log, { gateId: first, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
    b.clock.t += advanceMs;
    const second = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE, ...over }));
    return { b, second };
  }

  for (const [why, over, advanceMs] of [
    ["a different payload", { payload: { host: "web-2" } }, 0],
    ["a different approvers list", { approvers: ["u:bob"] }, 0],
    ["a different node", { nodeId: n("approve-2") }, 0],
    ["a different policy", { policyRef: "oversight/other@stable" }, 0],
    ["a different edit allow-list", { allowEdit: ["plan"] }, 0],
    ["a mirror gate", { mirrorOf: "gate_elsewhere" as GateId }, 0],
    ["no dedupe declared", { dedupe: undefined }, 0],
    ["a question older than the window", {}, 60_001],
  ] as const) {
    const { b, second } = await differing(over as Over, advanceMs);
    const p = (await b.broker.project(b.log))!;
    assert.equal(p.gates[second]?.state, "open", `${why} must still be asked`);
    assert.equal((await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.deduped").length, 0, why);
  }

  // …and the control, so the loop above is not passing because dedup never fires.
  const { b, second } = await differing({}, 59_000);
  assert.equal((await b.broker.project(b.log))!.gates[second]?.state, "decided", "59s into a 60s window");
});

test("AN INHERITED REJECT CARRIES ITS REASON, AND ONE WITH NO REASON IS NOT INHERITED", async () => {
  const b = bench();
  const payload = { host: "web-1" };
  const first = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  await b.broker.resolve(b.log, {
    gateId: first,
    decision: { kind: "reject", reason: "the freeze is on" },
    actor: alice,
    idempotencyKey: "a1",
  });
  const second = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[second]?.decision, "reject");
  assert.equal(p.gates[second]?.justification, "the freeze is on", "the reason travels, or the rejection is unexplained");

  // The refusal path: a hand-written journal can hold a rejection with no reason, which
  // `#validate` refuses — so the gate is RAISED and a human is asked, rather than
  // inheriting a decision the one validation chain would not accept.
  const c = bench();
  const raw = await c.broker.raise(c.log, request(c, { payload, batching: undefined, dedupe: DEDUPE }));
  await c.log.append([
    {
      type: "gate.decided",
      payload: { gateId: raw, decision: "reject", latencyMs: 0 },
      actor: alice,
      taskId: `approve@root/f0[0]#0` as TaskId,
    },
  ]);
  const dup = await c.broker.raise(c.log, request(c, { payload, batching: undefined, dedupe: DEDUPE }));
  assert.equal((await c.broker.project(c.log))!.gates[dup]?.state, "open", "a rejection with no reason is not inherited");
});

test("A DEDUPED GATE LETS THE RUN CARRY STRAIGHT ON, DRIVEN FROM A GRAPH", async () => {
  // The graph raises the same question on every branch — `restart` is not read by the
  // gate's payload, so all five branches digest identically — with dedupe declared and no
  // batching. The first is answered by a human; the rest inherit it.
  const spec = fanoutGatedSpec({ dedupe: DEDUPE });
  const withoutHost = {
    ...spec,
    nodes: spec.nodes.map((node) => (node.id === n("approve") ? { ...node, reads: [] } : node)),
  };
  const r = rig(withoutHost);
  const runId = await r.engine.submit({ graph: r.graph, inputs: { hosts: HOSTS } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  const open = openGates(p);
  assert.equal(open.length, 5, "the first wave has nothing to inherit yet");

  // Answer ONE. Every later gate on the same question inherits it — and there are no
  // later gates in this run, so what this proves is the run finishing on one decision
  // plus four inheritances is not what happens: the four siblings were raised together.
  const after = await r.engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
  });
  assert.equal(after.status, "awaiting_gate", "four siblings raised before any answer are still four questions");
  assert.equal(openGates(after).length, 4);
});

test("A GATE ANSWERED IN THE APPEND THAT RAISED IT DOES NOT SPEND A SLOT IN maxBatch", async () => {
  // WHY DEDUP IS ASKED BEFORE BATCHING, as a measurement rather than as an assertion in a
  // comment. `maxBatch` is a bound on HOW MANY QUESTIONS ONE CLICK CLOSES; a gate that is
  // decided in the same append that raises it is a question nobody is ever asked, so
  // letting it join a batch spends that bound on nothing and every later batch is smaller
  // for it.
  //
  // Reproduced by flipping the order in `raise` — `batchFor` first, dedup second — with
  // maxBatch 3: the batch that holds two open questions here held ONE, and the two gates
  // behind it were pushed into a second batch. Two clicks where there was one, which is
  // the load reduction D7.9 row 2 exists for, spent on a gate with an answer already.
  const b = bench();
  const both = { batching: { ...BATCHING, maxBatch: 3 }, dedupe: DEDUPE } as const;
  const payload = { host: "web-1" };

  const answered = await b.broker.raise(b.log, request(b, { ...both, payload }));
  await b.broker.resolve(b.log, { gateId: answered, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  const duplicate = await b.broker.raise(b.log, request(b, { ...both, payload }));
  const third = await b.broker.raise(b.log, request(b, both));
  const fourth = await b.broker.raise(b.log, request(b, both));
  const fifth = await b.broker.raise(b.log, request(b, both));

  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[duplicate]?.state, "decided", "the duplicate inherited");
  assert.equal(p.gates[duplicate]?.batch, undefined, "…and joined no batch, so it holds no slot");

  const batches = await batchesOf(b);
  assert.deepEqual(
    batches.map((x) => x.members.map((m) => m.gateId)),
    [[third, fourth], [fifth]],
    "the cap is spent on questions somebody is asked: two in the first batch, not one",
  );
});

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

function diagnose(over: Partial<HumanGateNode>): readonly string[] {
  const out = compile({ spec: fanoutGatedSpec(over), resolver: resolver(), tools: {} });
  return out.diagnostics.filter((x) => x.severity === "error").map((x) => x.code);
}

test("A SATURATION BLOCK THAT IS NOT A RECORD IS REFUSED — arrays, Maps, Dates and RegExps included", async () => {
  for (const shape of [[], new Map(), new Date(), /restart/, null, "restart-pods", 7] as const) {
    assert.deepEqual(
      diagnose({ batching: shape as unknown as BatchingSpec }),
      ["GRAPH014_BATCHING_INVALID"],
      `batching: ${Object.prototype.toString.call(shape)}`,
    );
    assert.deepEqual(
      diagnose({ dedupe: shape as unknown as DedupeSpec }),
      ["GRAPH014_DEDUPE_INVALID"],
      `dedupe: ${Object.prototype.toString.call(shape)}`,
    );
  }
  // THE CASE THAT TELLS THE STRICT CHECK FROM THE REFLEX, and it is the only one that
  // does. Every shape above is refused under BOTH readings — under `typeof v === "object"`
  // they get past the shape test and then fail on `enabled`, with the same code — so none
  // of them can catch the reflex coming back. An array CARRYING the fields can:
  // `typeof` says "object", every field reads correctly off it, and the block is accepted.
  // Reverting `isPlainRecord` to the `typeof` form turns exactly this assertion red, and
  // nothing else in this file.
  const arrayWithFields = Object.assign([], BATCHING);
  assert.equal(typeof arrayWithFields, "object", "the reflex would call this a record");
  assert.equal(arrayWithFields["enabled"], true, "…and every field reads off it");
  assert.deepEqual(diagnose({ batching: arrayWithFields as unknown as BatchingSpec }), ["GRAPH014_BATCHING_INVALID"]);
  assert.deepEqual(
    diagnose({ dedupe: Object.assign([], DEDUPE) as unknown as DedupeSpec }),
    ["GRAPH014_DEDUPE_INVALID"],
  );

  // …and the runtime says the same, because a broker can be driven without a compiler.
  const b = bench();
  const first = await b.broker.raise(b.log, request(b, { batching: arrayWithFields as unknown as BatchingSpec }));
  const second = await b.broker.raise(b.log, request(b, { batching: arrayWithFields as unknown as BatchingSpec }));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[first]?.batch, undefined, "an array is not a batching block at run time either");
  assert.equal(p.gates[second]?.batch, undefined);

  // A class instance IS a record — the line is drawn at exotic built-ins, not at
  // `Object.prototype` — so a TypeScript embedder constructing one still works.
  class Batching {
    readonly enabled = true;
    readonly key = "restart-pods";
    readonly windowMs = 60_000;
    readonly maxBatch = 20;
  }
  const c = bench();
  const g1 = await c.broker.raise(c.log, request(c, { batching: new Batching() }));
  const g2 = await c.broker.raise(c.log, request(c, { batching: new Batching() }));
  assert.equal((await c.broker.project(c.log))!.gates[g2]?.batch?.id, g1, "a class instance batches");
});

test("A CAP OR A WINDOW THAT IS NOT A NUMBER IS REFUSED AT COMPILE, AND MERGES NOTHING AT RUN TIME", async () => {
  for (const bad of [NaN, Infinity, -1, 0, 1.5, "60000", null] as const) {
    assert.deepEqual(diagnose({ batching: { ...BATCHING, windowMs: bad as number } }), ["GRAPH014_BATCHING_INVALID"]);
    assert.deepEqual(diagnose({ dedupe: { ...DEDUPE, windowMs: bad as number } }), ["GRAPH014_DEDUPE_INVALID"]);
  }
  for (const bad of [NaN, Infinity, 1, 0, -2, 2.5, "20"] as const) {
    assert.deepEqual(
      diagnose({ batching: { ...BATCHING, maxBatch: bad as number } }),
      ["GRAPH014_BATCHING_INVALID"],
      `maxBatch: ${String(bad)}`,
    );
  }
  assert.deepEqual(diagnose({ batching: { ...BATCHING, key: "  " } }), ["GRAPH014_BATCHING_INVALID"]);
  assert.deepEqual(diagnose({ batching: { ...BATCHING, enabled: "yes" as unknown as boolean } }), [
    "GRAPH014_BATCHING_INVALID",
  ]);
  assert.deepEqual(diagnose({ batching: BATCHING }), [], "the valid block compiles");
  assert.deepEqual(diagnose({ dedupe: DEDUPE }), []);
  assert.deepEqual(diagnose({ batching: { enabled: false } as unknown as BatchingSpec }), [], "disabled needs no key");

  // THE RUNTIME REFUSES THEM AGAIN, and in the direction that costs nothing: `NaN` loses
  // every comparison, so `members.length >= NaN` is a cap that caps nothing and
  // `now - anchor > NaN` is a window that never closes. Both would be silent.
  const b = bench();
  const broken: BatchingSpec = { ...BATCHING, maxBatch: NaN };
  const first = await b.broker.raise(b.log, request(b, { batching: broken }));
  const second = await b.broker.raise(b.log, request(b, { batching: broken }));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[first]?.batch, undefined, "an unusable cap batches nothing at all");
  assert.equal(p.gates[second]?.batch, undefined);
  assert.deepEqual(await batchesOf(b), []);

  const c = bench();
  const dupBroken: DedupeSpec = { enabled: true, windowMs: NaN };
  const g1 = await c.broker.raise(c.log, request(c, { payload: { same: 1 }, batching: undefined, dedupe: dupBroken }));
  await c.broker.resolve(c.log, { gateId: g1, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  const g2 = await c.broker.raise(c.log, request(c, { payload: { same: 1 }, batching: undefined, dedupe: dupBroken }));
  assert.equal(
    (await c.broker.project(c.log))!.gates[g2]?.state,
    "open",
    "a window that is not a window would otherwise inherit a decision of any age",
  );
});

// ---------------------------------------------------------------------------
// The batch against the rest of the gate layer
// ---------------------------------------------------------------------------

test("A BATCH ON A RUN THAT HAS ENDED IS REFUSED — AND THE CANCEL CASE PASSES FOR A DIFFERENT REASON", async () => {
  // TWO REFUSALS SHARING ONE ERROR CODE, WHICH IS WHY THIS TEST HAD TO BE SPLIT.
  // `resolveBatch` refuses on `isTerminal(p.status)` and again on "every member is already
  // resolved", both with `E_GATE_ALREADY_RESOLVED` — so a test that only drives CANCEL
  // cannot tell you which one fired, and the answer was: not the one the test was named
  // for. `Engine.cancel` closes every open gate, so the batch is EMPTY by the time the
  // status is read, and the terminal check was held by nothing. Deleting it left the whole
  // suite green at 1223 pass.
  //
  // Both halves are below, and the second is the one that guards the fifth resurrection
  // route: with the check removed it decides two gates on a `failed` run and walks two
  // Tasks back to `ready` behind it.

  // 1 · CANCEL. What this really pins is that cancel closed the gates — a real property,
  // now stated as itself.
  {
    const r = rig(fanoutGatedSpec({ batching: BATCHING }));
    const runId = await parkAll(r);
    const batch = (await r.engine.openGateBatches(runId))[0]!;
    await r.engine.cancel(runId, "the freeze started");
    const cancelled = (await r.engine.projection(runId))!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(openGates(cancelled).length, 0, "cancel closed every member, so the batch is empty first");

    await assert.rejects(
      () =>
        r.engine.resolveGateBatch(runId, {
          batchId: batch.batchId,
          decision: { kind: "approve" },
          actor: alice,
          idempotencyKey: "late",
          expectManifest: batch.manifestDigest,
        }),
      refused(CODES.E_GATE_ALREADY_RESOLVED),
    );
    assert.equal(r.restarted.length, 0);
  }

  // 2 · EXPIRY — a terminal run whose batch STILL HAS OPEN MEMBERS, which is the state the
  // check exists for and the only way to reach it. A gate expiry fails the run and leaves
  // every sibling gate open (`resolve`'s own terminal check says so in prose; this is the
  // batch layer's copy of that sentence, driven).
  {
    const r = rig(fanoutGatedSpec({ batching: BATCHING, sla: { respondWithinMs: 60_000, onTimeout: "fail" } }));
    const runId = await parkAll(r);
    r.clock.t += 60_001;
    await r.engine.sweepGates(r.clock.t);

    const dead = (await r.engine.projection(runId))!;
    assert.equal(dead.status, "failed", "one gate's deadline killed the run");
    assert.equal(dead.error?.code, CODES.E_GATE_EXPIRED);
    const survivors = openGates(dead);
    assert.ok(survivors.length > 0, "and its siblings are still open — nothing closed them");

    const stale = (await r.engine.openGateBatches(runId))[0]!;
    assert.equal(stale.members.length, survivors.length, "so the batch is answerable-looking and must not be answered");

    await assert.rejects(
      () =>
        r.engine.resolveGateBatch(runId, {
          batchId: stale.batchId,
          decision: { kind: "approve" },
          actor: alice,
          idempotencyKey: "late",
          expectManifest: stale.manifestDigest,
        }),
      (e: unknown): true => {
        refused(CODES.E_GATE_ALREADY_RESOLVED)(e);
        assert.match((e as Error).message, /which is failed/, "the RUN refused it, not the members");
        return true;
      },
    );

    // The resurrection this prevents, stated as state rather than as an exception: with the
    // check removed, the members fold to `decided`, their Tasks fold back to `ready`, and
    // the journal carries a batch receipt underneath a `run.failed`.
    const after = (await r.engine.projection(runId))!;
    assert.equal(after.status, "failed");
    assert.equal(openGates(after).length, survivors.length, "every survivor is still open and still unanswerable");
    assert.equal(
      (await journal(r.store, runId)).filter((ev) => ev.type === "gate.batch_decided").length,
      0,
      "and nothing was written",
    );
    assert.equal(r.restarted.length, 0);
  }

  const b = bench();
  await b.broker.raise(b.log, request(b));
  await assert.rejects(
    () =>
      b.broker.resolveBatch(b.log, {
        batchId: "gate_nobody_raised" as GateId,
        decision: { kind: "approve" },
        actor: alice,
        idempotencyKey: "x",
        expectManifest: "sha256:0",
      }),
    refused(CODES.E_GATE_NOT_FOUND),
  );
  // Including the inherited-property names every gate lookup in this codebase has to
  // survive. A `Map` has no prototype to reach, which is why the grouping uses one.
  for (const name of ["__proto__", "constructor", "toString", "valueOf"]) {
    await assert.rejects(
      () =>
        b.broker.resolveBatch(b.log, {
          batchId: name as GateId,
          decision: { kind: "approve" },
          actor: alice,
          idempotencyKey: `x-${name}`,
          expectManifest: "sha256:0",
        }),
      refused(CODES.E_GATE_NOT_FOUND),
      name,
    );
  }
});

test("AN ESCALATION MOVES A MEMBER'S DEADLINE AND NOT THE MANIFEST", async () => {
  // The manifest digest pins WHAT IS BEING ASKED. A tier change resets a clock and pages
  // somebody new; it does not change the question, and refusing a decision because the
  // on-call was paged in the meantime would be an SLA cancelling an approval. This is the
  // claim `batchManifestDigest`'s docstring makes about what it deliberately omits.
  const b = bench();
  const first = await b.broker.raise(b.log, request(b, { slaMs: 60_000 }));
  await b.broker.raise(b.log, request(b, { slaMs: 60_000 }));
  const before = (await batchesOf(b))[0]!;

  await b.log.append([
    {
      type: "gate.escalated",
      payload: { gateId: first, tier: 1, to: "role:sre-manager", deadline: b.clock.t + 900_000 },
      actor: { kind: "system", component: "gate-broker" },
    },
  ]);

  const after = (await batchesOf(b))[0]!;
  assert.equal(after.members[0]?.tier, 1, "the tier moved");
  assert.equal(after.members[0]?.deadline, b.clock.t + 900_000, "…and so did that member's clock");
  assert.equal(after.manifestDigest, before.manifestDigest, "the question did not");

  const out = await b.broker.resolveBatch(b.log, {
    batchId: before.batchId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
    expectManifest: before.manifestDigest,
  });
  assert.equal(out.gateIds.length, 2, "so a decision taken before the page still lands");
});

test("SATURATION CONTROL IS ALSO DELIVERY CONTROL: A MERGED GATE PAGES NOBODY TWICE", async () => {
  // This is where D7.9's load reduction is actually paid. Merging twenty gates into one
  // manifest and then sending twenty notifications would reduce the queue and not the
  // interruptions, which is the half of "survivable" a human notices.
  const seen: string[] = [];
  const spy: DeliveryChannel = {
    name: "spy",
    deliver: (target) => {
      seen.push(target.gate.gateId);
      return Promise.resolve(`spy:${target.gate.gateId}`);
    },
  };
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const runId = newRunId(clock.t);
  const broker = new HumanGateBroker({
    now,
    dispatcher: new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() }),
  });
  const b: Bench = { clock, store, broker, log: new RunLog(runId, { store, now }), runId };
  const delivery = { channels: ["spy"] };

  const leader = await broker.raise(b.log, request(b, { delivery }));
  const joiner = await broker.raise(b.log, request(b, { delivery }));
  assert.deepEqual(seen, [leader], "the batch is announced once, by its first member");
  assert.equal((await broker.project(b.log))!.gates[joiner]?.batch?.id, leader);

  // A gate that could not merge IS its own first ask, so it is delivered.
  const loner = await broker.raise(b.log, request(b, { delivery, approvers: ["u:bob"] }));
  assert.deepEqual(seen, [leader, loner]);

  // And a deduped gate pages nobody at all: it already has its answer.
  const payload = { host: "web-9" };
  const asked = await broker.raise(b.log, request(b, { payload, delivery, batching: undefined, dedupe: DEDUPE }));
  await broker.resolve(b.log, { gateId: asked, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  assert.deepEqual(seen, [leader, loner, asked]);
  await broker.raise(b.log, request(b, { payload, delivery, batching: undefined, dedupe: DEDUPE }));
  assert.deepEqual(seen, [leader, loner, asked], "a question with an answer is not a notification");
});

/** A bench whose broker pages a spy, so what a channel actually SAW is observable. */
function paging(): { bench: Bench; pages: { gateId: GateId; tier: number; to: string; payload: unknown }[] } {
  const pages: { gateId: GateId; tier: number; to: string; payload: unknown }[] = [];
  const spy: DeliveryChannel = {
    name: "spy",
    deliver: (target) => {
      pages.push({
        gateId: target.gate.gateId,
        tier: target.tier,
        to: target.recipients.map((r) => `${r.kind}:${r.id}`).join(","),
        payload: target.payload,
      });
      return Promise.resolve(`spy:${target.gate.gateId}`);
    },
  };
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const runId = newRunId(clock.t);
  const broker = new HumanGateBroker({
    now,
    dispatcher: new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() }),
  });
  return { bench: { clock, store, broker, log: new RunLog(runId, { store, now }), runId }, pages };
}

test("TWO GATES WHOSE DELIVERY ROUTE DIFFERS DO NOT MERGE, BECAUSE MERGING IS WHAT SUPPRESSES A PAGE", async () => {
  // THE TWO QUESTIONS BATCHING ASKS ABOUT DELIVERY, SEPARATED — because the shipped code
  // answered the first and never asked the second.
  //
  //   1. Should a gate that JOINS a batch be delivered? NO. That is the point of batching
  //      and it is what `SATURATION CONTROL IS ALSO DELIVERY CONTROL` above pins.
  //   2. May two gates with DIFFERENT delivery policies merge at all? No — and they did.
  //      `sameAuthority` never compared `delivery`, and it could not: the route lives in
  //      `EphemeralGate`, which is empty in any process that did not raise the gate, so a
  //      comparison against it would be an authorization check whose input can be silently
  //      empty. The answer is a `deliveryDigest` on the journaled batch marker: equality is
  //      the only thing a merge needs, and equality is all a digest discloses.
  //
  // Answering 1 without 2 is a silent substitution: suppressing the joiner's page in favour
  // of the FOUNDER'S page means the founder's channels, recipients and redact list stand in
  // for the joiner's, and nothing anywhere recorded the swap.
  const { bench: b, pages } = paging();
  const open = { channels: ["spy"], recipients: [{ kind: "role", id: "oncall" } as const] };
  const guarded = {
    channels: ["spy"],
    recipients: [{ kind: "user", id: "u:security" } as const],
    redact: ["ssn"],
  };

  const founder = await b.broker.raise(b.log, request(b, { payload: { host: "web-1", ssn: "111-22-3333" }, delivery: open }));
  const strict = await b.broker.raise(b.log, request(b, { payload: { host: "web-2", ssn: "444-55-6666" }, delivery: guarded }));

  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[strict]?.batch?.id, strict, "a different route is a different batch");
  assert.notEqual(
    p.gates[founder]?.batch?.deliveryDigest,
    p.gates[strict]?.batch?.deliveryDigest,
    "and the journal says why, without saying where either page went",
  );

  // Both are announced, each on its own terms — which is the behaviour the merge was
  // costing. The one that asked for its ssn hidden gets it hidden; the one that did not,
  // does not, which is its own author's doing and not the batch's.
  assert.deepEqual(pages.map((x) => x.gateId), [founder, strict]);
  assert.deepEqual(pages.map((x) => x.to), ["role:oncall", "user:u:security"]);
  assert.equal((pages[0]?.payload as Record<string, unknown>)["ssn"], "111-22-3333");
  assert.notEqual(
    (pages[1]?.payload as Record<string, unknown>)["ssn"],
    "444-55-6666",
    "the joiner's own redact list is applied, because the joiner's own delivery ran",
  );

  // The control, so the split above is not "nothing ever merges": the same route merges,
  // and then exactly one page goes out for both.
  const { bench: c, pages: cp } = paging();
  const lead = await c.broker.raise(c.log, request(c, { delivery: guarded }));
  const join = await c.broker.raise(c.log, request(c, { delivery: guarded }));
  assert.equal((await c.broker.project(c.log))!.gates[join]?.batch?.id, lead);
  assert.deepEqual(cp.map((x) => x.gateId), [lead], "one manifest, one page");

  // And two gates that BOTH declare no delivery still merge — absent must compare equal to
  // absent, not to something. A console-only deployment is a real configuration.
  const d = bench();
  const q1 = await d.broker.raise(d.log, request(d, { delivery: undefined }));
  const q2 = await d.broker.raise(d.log, request(d, { delivery: undefined }));
  const pd = (await d.broker.project(d.log))!;
  assert.equal(pd.gates[q2]?.batch?.id, q1);
  assert.equal(pd.gates[q1]?.batch?.deliveryDigest, undefined, "and no route means no digest, not a digest of nothing");
});

test("ONE MERGED QUESTION PAGES THE ESCALATION TIER ONCE, NOT ONCE PER MEMBER", async () => {
  // WHERE D7.9 ROW 2'S LOAD REDUCTION INVERTED. Batching cut the tier-0 page from N to 1,
  // and the escalation path had no notion of a batch at all — so one merged question paged
  // the escalation tier N TIMES, and it did so exactly when the queue is worst, which is
  // when an SLA is breaching. Measured before the fix on the five-member batch below: 1 page
  // at tier 0 and **5 at tier 1**, all of them to `role:sre-manager` about one manifest.
  //
  // The `gate.escalated` ROWS stay per member and must: each burns that member's own tier
  // and resets that member's own clock, which is the state the next sweep folds and the
  // reason `GateSweeper` never had to learn about batches. What is bounded is the PAGE.
  const { bench: b, pages } = paging();
  const delivery = {
    channels: ["spy"],
    recipients: [{ kind: "role", id: "oncall" } as const],
    escalation: [{ afterMs: 900_000, to: [{ kind: "role", id: "sre-manager" } as const] }],
  };
  const over = { delivery, slaMs: 60_000, onTimeout: "escalate" as const };

  const ids: GateId[] = [];
  for (let i = 0; i < 5; i++) ids.push(await b.broker.raise(b.log, request(b, over)));
  assert.equal(pages.filter((x) => x.tier === 0).length, 1, "one manifest, one first ask");

  b.clock.t += 60_001;
  const fired = await b.broker.sweepTimeouts(b.log, b.clock.t);
  assert.equal(fired.length, 5, "every member's own clock still fires — the batch is not a clock");

  const p = (await b.broker.project(b.log))!;
  for (const id of ids) assert.equal(p.gates[id]?.tier, 1, "…and every member's own tier moved, in its own row");
  assert.equal(
    (await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.escalated").length,
    5,
    "five escalations in the journal, because five clocks breached",
  );
  assert.deepEqual(
    pages.filter((x) => x.tier === 1).map((x) => x.to),
    ["role:sre-manager"],
    "and ONE page, because it is one question",
  );

  // THE PAGE IS NOT THE FOUNDER'S PRIVILEGE — it belongs to whichever member reaches the
  // tier first. A rule keyed on the founder's id would go SILENT the moment the founder is
  // answered singly, which is the "guard that goes quiet" failure one layer along: the
  // remaining members would escalate and page nobody.
  const { bench: c, pages: cp } = paging();
  const cids: GateId[] = [];
  for (let i = 0; i < 3; i++) cids.push(await c.broker.raise(c.log, request(c, over)));
  await c.broker.resolve(c.log, { gateId: cids[0]!, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  c.clock.t += 60_001;
  await c.broker.sweepTimeouts(c.log, c.clock.t);
  assert.deepEqual(
    cp.filter((x) => x.tier === 1).map((x) => x.gateId),
    [cids[1]],
    "the founder is decided; the next member up pages, and only it",
  );

  // And a gate in NO batch is its own question, so it always pages — the bound is per
  // batch, not a cap on escalations.
  const { bench: d, pages: dp } = paging();
  await d.broker.raise(d.log, request(d, { ...over, batching: undefined }));
  await d.broker.raise(d.log, request(d, { ...over, batching: undefined }));
  d.clock.t += 60_001;
  await d.broker.sweepTimeouts(d.log, d.clock.t);
  assert.equal(dp.filter((x) => x.tier === 1).length, 2, "two unbatched gates are two questions");
});

/**
 * A store whose Nth read pauses to let a SECOND sweeper run, and then carries on.
 *
 * The only way to state a claim about two sweeps that OVERLAP rather than alternate.
 * `sweepTimeouts` is `async` all the way down, so the interleaving points are exactly its
 * awaits, and every one of them is a read: the fold at the top, `#commitForOpenGate`'s
 * re-read, and — before the fix this fixture exists for — the page decision's own re-read
 * after the commit. Numbering the reads is what makes the race a deterministic test rather
 * than a flake: it names the window instead of hoping to land in it.
 */
function interleaving(real: MemoryStateStore): {
  readonly store: MemoryStateStore;
  /** Run `fn` just before the `nth` read from now returns. */
  at(nth: number, fn: () => Promise<void>): void;
} {
  let reads = 0;
  let want = 0;
  let hook: (() => Promise<void>) | undefined;
  const store = {
    append: (input: Parameters<MemoryStateStore["append"]>[0]) => real.append(input),
    head: (runId: RunId) => real.head(runId),
    listRuns: (limit?: number) => real.listRuns(limit),
    close: () => real.close(),
    read: (runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> => {
      const inner = real.read(runId, fromSeq, toSeq);
      return (async function* () {
        reads += 1;
        if (hook !== undefined && reads === want) {
          const fn = hook;
          hook = undefined;
          await fn();
        }
        for await (const ev of inner) yield ev;
      })();
    },
  } as unknown as MemoryStateStore;
  return {
    store,
    at: (nth, fn) => {
      reads = 0;
      want = nth;
      hook = fn;
    },
  };
}

test("TWO SWEEPS THAT OVERLAP PAGE THE TIER ONCE — AND, ABOVE ALL, NEVER ZERO TIMES", async () => {
  // THE ONE-PAGE-PER-TIER RULE, ASKED THE QUESTION A READ CANNOT ANSWER. `siblingReachedTier`
  // decided "has this tier already been paged?" from a projection read AFTER this member's
  // own `gate.escalated` had landed — so a sibling's row arriving in that window made this
  // member believe the page had gone out. Both members can reach that conclusion, and then
  // NOBODY is paged, which is strictly worse than the N-times paging the rule replaced: a
  // silent non-page is the failure the whole delivery subsystem exists to prevent.
  //
  // REPRODUCED, two brokers over one store, interleaved at exactly the post-commit read
  // (read #3 of sweeper A's tick — fold, `#commitForOpenGate`'s re-read, then the page's):
  //
  //     tiers: [1, 1]    tier-1 pages: []
  //
  // The fix is the instrument the sweeper already had: decide the page at the seq the
  // write SWAPS ON, not at whatever the journal says afterwards. A read is not a lock.
  //
  // A FRESH RUN PER INTERLEAVE POINT, which is not tidiness: after one tick both members
  // sit at tier 1 with a reset deadline, so a loop that reused the fixture would exercise
  // exactly the first interleave and pass for the other five by doing nothing. The
  // mutation is how that was found — reverting the fix left this test GREEN until each
  // point got its own run.
  for (let nth = 1; nth <= 6; nth += 1) {
    const pages: { gateId: GateId; tier: number }[] = [];
    const spy: DeliveryChannel = {
      name: "spy",
      deliver: (target) => {
        pages.push({ gateId: target.gate.gateId, tier: target.tier });
        return Promise.resolve(`spy:${target.gate.gateId}`);
      },
    };
    const clock = { t: 1_700_000_000_000 };
    const now = (): number => clock.t;
    const real = new MemoryStateStore({ now });
    const wrapped = interleaving(real);
    const runId = newRunId(clock.t);
    const dispatcher = (): GateDispatcher => new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() });
    const a = new HumanGateBroker({ now, dispatcher: dispatcher() });
    const b = new HumanGateBroker({ now, dispatcher: dispatcher() });
    const logA = new RunLog(runId, { store: wrapped.store, now });
    const logB = new RunLog(runId, { store: wrapped.store, now });
    const benchA: Bench = { clock, store: wrapped.store, broker: a, log: logA, runId };

    const delivery = {
      channels: ["spy"],
      recipients: [{ kind: "role", id: "oncall" } as const],
      escalation: [{ afterMs: 900_000, to: [{ kind: "role", id: "sre-manager" } as const] }],
    };
    const over = { delivery, slaMs: 60_000, onTimeout: "escalate" as const };
    const first = request(benchA, over);
    const second = request(benchA, over);
    const g1 = await a.raise(logA, first);
    const g2 = await a.raise(logA, second);
    // The second sweeper knows the route as well — a deploy, or a second worker. Without
    // this it would find no delivery spec and expire both gates instead of escalating them.
    b.rehydrate(g1, first);
    b.rehydrate(g2, second);
    assert.equal(pages.filter((x) => x.tier === 0).length, 1, "one manifest, one first ask");

    clock.t += 60_001;
    wrapped.at(nth, async () => {
      await b.sweepTimeouts(logB, clock.t);
    });
    await a.sweepTimeouts(logA, clock.t);

    const p = (await a.project(logA))!;
    assert.deepEqual([p.gates[g1]?.tier, p.gates[g2]?.tier], [1, 1], `both members escalated (interleave ${nth})`);
    assert.equal(
      pages.filter((x) => x.tier === 1).length,
      1,
      `exactly one page for one question, interleaved at read ${nth} — got ${pages.filter((x) => x.tier === 1).length}`,
    );
    // The journal still carries one escalation row per member: what is bounded is the
    // page, never the clock.
    const rows = (await journal(real, runId)).filter((ev) => ev.type === "gate.escalated");
    assert.equal(rows.length, 2, `one gate.escalated per member, whoever wrote it (interleave ${nth})`);
  }
});

test("A MEMBER TWO TIERS AHEAD HAS ALREADY BEEN PAGED AT THE TIER BELOW IT", async () => {
  // `siblingReachedTier` asks `m.tier >= tier` and its docstring says why: "a member whose
  // SLA is shorter can be two tiers ahead. It has been paged at this tier and at the one
  // above it." No fixture had ever produced a member more than one tier ahead of its
  // siblings, so `>=` narrowed to `===` left the suite green — and the sibling arriving late
  // at tier 1 paged a tier that had already seen this exact manifest.
  const { bench: b, pages } = paging();
  const delivery = {
    channels: ["spy"],
    recipients: [{ kind: "role", id: "oncall" } as const],
    escalation: [
      { afterMs: 900_000, to: [{ kind: "role", id: "sre-manager" } as const] },
      { afterMs: 900_000, to: [{ kind: "role", id: "director" } as const] },
    ],
  };
  const over = { delivery, slaMs: 60_000, onTimeout: "escalate" as const };
  const ahead = await b.broker.raise(b.log, request(b, over));
  const behind = await b.broker.raise(b.log, request(b, over));
  assert.equal((await b.broker.project(b.log))!.gates[behind]?.batch?.id, ahead, "one batch");
  assert.deepEqual(pages.map((x) => x.tier), [0], "one first ask");

  // The first member is walked to tier 2 by hand rather than by two sweeps, because two
  // sweeps would also walk the second one: what this pins is the READING of a gap between
  // members' tiers, not how the gap is arrived at.
  await b.log.append([
    {
      type: "gate.escalated",
      payload: { gateId: ahead, tier: 2, to: "role:director", deadline: b.clock.t + 900_000 },
      actor: { kind: "system", component: "gate-broker" },
    },
  ]);

  b.clock.t += 60_001;
  await b.broker.sweepTimeouts(b.log, b.clock.t);
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[behind]?.tier, 1, "the late member escalates on its own clock, as it must");
  assert.deepEqual(
    pages.filter((x) => x.tier === 1),
    [],
    "and pages nobody: the tier below a member already at tier 2 has seen this manifest",
  );
});

test("A BATCH WHOSE EVERY MEMBER IS ANSWERED IS NOT A MESSAGE ANYBODY IS STILL HOLDING", async () => {
  // THE JOINER'S SILENCE IS BORROWED FROM SOMEBODY ELSE'S OPEN QUESTION, and it was never
  // checked that there still was one. `batchFor` groups over `"any"` on purpose — a decided
  // member still counts against `maxBatch`, so a batch cannot be refilled after it fills —
  // so a gate could join a batch every member of which had already been answered, and be
  // suppressed against a manifest that had been read, clicked and closed.
  //
  // REPRODUCED: founder raised and paged, founder approved, second gate raised → it joined
  // the founder's batch, `pages` held only the founder, and `openGates` was exactly the one
  // gate nobody had been told about, with the run suspended behind it.
  const { bench: b, pages } = paging();
  const delivery = { channels: ["spy"], recipients: [{ kind: "role", id: "oncall" } as const] };

  const founder = await b.broker.raise(b.log, request(b, { delivery }));
  assert.deepEqual(pages.map((x) => x.gateId), [founder], "the founder is the first ask");

  await b.broker.resolve(b.log, {
    gateId: founder,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
  });

  b.clock.t += 1_000;
  const joiner = await b.broker.raise(b.log, request(b, { delivery }));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[joiner]?.batch?.id, founder, "it still JOINS the batch — the cap still counts it");
  assert.deepEqual(
    pages.map((x) => x.gateId),
    [founder, joiner],
    "…and it is announced, because the message it was added to has been answered and closed",
  );

  // THE CONTROL, so this is not "the suppression was deleted": with the founder still
  // open, the joiner is silent, which is D7.9 row 2's entire load reduction.
  const { bench: c, pages: cp } = paging();
  const lead = await c.broker.raise(c.log, request(c, { delivery }));
  await c.broker.raise(c.log, request(c, { delivery }));
  assert.deepEqual(cp.map((x) => x.gateId), [lead], "one live manifest, one page");

  // And an EXPIRED member is no more a live message than a decided one. The run fails on
  // the expiry, so this is asked of the projection the raise is decided at rather than of a
  // later gate: a batch whose only member expired holds nobody's attention either.
  const { bench: d, pages: dp } = paging();
  const doomed = await d.broker.raise(d.log, request(d, { delivery, slaMs: 30_000, onTimeout: "fail" }));
  d.clock.t += 30_001;
  await d.broker.sweepTimeouts(d.log, d.clock.t);
  const pd = (await d.broker.project(d.log))!;
  assert.equal(pd.gates[doomed]?.state, "expired");
  assert.deepEqual(dp.map((x) => x.gateId), [doomed], "only the expired member was ever paged");
});

test("DEDUP INHERITS THE LATEST ANSWER TO THE QUESTION, NOT THE FIRST ONE FOUND", async () => {
  // "If the question was asked and answered twice, the later answer is the one that stands"
  // — the same rule `lastDecidedGate` uses one layer up. Nothing held it: with the
  // `raisedAtSeq` comparison reduced to "the first match wins", the suite stayed green while
  // a duplicate inherited an APPROVE that a later, identical question had already been
  // REJECTED. An answer that was superseded is the one shape of stale decision this
  // mechanism must not copy forward.
  //
  // The second gate declares no dedup of its own, which is how two identical DECIDED gates
  // come to exist at all: with it enabled the second would have inherited the first.
  const b = bench();
  const payload = { host: "web-1" };
  const approved = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  await b.broker.resolve(b.log, { gateId: approved, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });

  b.clock.t += 1_000;
  const asked = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: undefined }));
  await b.broker.resolve(b.log, {
    gateId: asked,
    decision: { kind: "reject", reason: "the freeze started" },
    actor: alice,
    idempotencyKey: "r1",
  });

  b.clock.t += 1_000;
  const third = await b.broker.raise(b.log, request(b, { payload, batching: undefined, dedupe: DEDUPE }));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[third]?.state, "decided", "both sources are in the window, so one of them is inherited");
  assert.equal(p.gates[third]?.decision, "reject", "and it is the LATER answer");
  assert.equal(p.gates[third]?.justification, "the freeze started", "carried with its reason, as `resolve` would");
  const deduped = (await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.deduped");
  assert.equal((deduped.at(-1)!.payload as { ofGateId: GateId }).ofGateId, asked, "…and the journal names which gate");
});

test("DEDUP INHERITS ONLY FROM A GATE A HUMAN DECIDED", async () => {
  // `GATE_SYSTEM_ACTORS` entitles `gate-broker:dedupe` on a written argument: it "carries a
  // decision a human made … the audit trail from this row to the human is one hop". Both
  // halves were false, and each is a different way for an approval to have no person behind
  // it at all.
  //
  //   1. A gate the CLOCK decided. Measured: source with `onTimeout: "default_action"` and
  //      a pre-authorized `approve` expired into `gate.decided` by
  //      `system:gate-broker:timeout`; the next identical gate — `onTimeout: "fail"`, no
  //      default action of its own — inherited it and was decided in the append that raised
  //      it. The pre-authorization GRAPH014 proved safe belonged to the source.
  //   2. A CHAIN. Each duplicate is itself a `decided` gate with a fresh `raisedAtTs`, so 20
  //      duplicates 50 s apart carried one click 1000 s past a declared 60 s window.
  const b = bench();
  const timed = await b.broker.raise(
    b.log,
    request(b, {
      payload: { host: "web-clock" },
      batching: undefined,
      dedupe: DEDUPE,
      slaMs: 10_000,
      onTimeout: "default_action",
      defaultAction: { kind: "approve" },
    }),
  );
  b.clock.t += 10_001;
  await b.broker.sweepTimeouts(b.log, b.clock.t);
  const p1 = (await b.broker.project(b.log))!;
  assert.equal(p1.gates[timed]?.state, "decided", "the clock decided it");
  assert.equal(p1.gates[timed]?.decidedBy, "system", "…and the fold says so, which is the fact that was missing");

  const dup = await b.broker.raise(
    b.log,
    request(b, { payload: { host: "web-clock" }, batching: undefined, dedupe: DEDUPE, onTimeout: "fail" }),
  );
  const p2 = (await b.broker.project(b.log))!;
  assert.equal(p2.gates[dup]?.state, "open", "a decision no human made is not a decision to inherit");
  assert.equal(
    (await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.deduped").length,
    0,
    "and nothing was journaled claiming it was",
  );

  // THE CHAIN, one hop deep and no deeper: the window is measured from the SOURCE's raise,
  // so a duplicate that could itself be a source is a window with no end.
  const c = bench();
  const asked = await c.broker.raise(c.log, request(c, { payload: { host: "web-9" }, batching: undefined, dedupe: DEDUPE }));
  await c.broker.resolve(c.log, { gateId: asked, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  assert.equal((await c.broker.project(c.log))!.gates[asked]?.decidedBy, "human");

  const ids: GateId[] = [];
  for (let i = 0; i < 4; i++) {
    c.clock.t += 50_000; // always inside 60 s of the PREVIOUS duplicate, never of the human's gate
    ids.push(await c.broker.raise(c.log, request(c, { payload: { host: "web-9" }, batching: undefined, dedupe: DEDUPE })));
  }
  const p3 = (await c.broker.project(c.log))!;
  assert.deepEqual(
    ids.map((id) => p3.gates[id]?.state),
    ["decided", "open", "open", "open"],
    "the first duplicate is inside the human's window; the rest are not, and no chain extends it",
  );
  assert.equal(
    (await journal(c.store, c.runId)).filter((ev) => ev.type === "gate.deduped").length,
    1,
    "one hop from the human, and the journal can be walked to say so",
  );

  // THE CONTROL: an ordinary duplicate of a human's decision, inside the window, still
  // inherits — this narrowed dedup, it did not delete it.
  const d = bench();
  const one = await d.broker.raise(d.log, request(d, { payload: { host: "web-1" }, batching: undefined, dedupe: DEDUPE }));
  await d.broker.resolve(d.log, { gateId: one, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  d.clock.t += 1_000;
  const two = await d.broker.raise(d.log, request(d, { payload: { host: "web-1" }, batching: undefined, dedupe: DEDUPE }));
  const pd = (await d.broker.project(d.log))!;
  assert.equal(pd.gates[two]?.state, "decided");
  assert.equal(pd.gates[two]?.decidedBy, "system", "by the dedup component, which is what gate.deduped explains");
});

test("A BATCH IS NUDGED ONCE PER REMINDER, THE WAY IT IS ASKED ONCE AND ESCALATED ONCE PER TIER", async () => {
  // THE SAME QUESTION ASKED OF THE THIRD ANNOUNCEMENT SITE. A batch is one question, so it
  // is announced once by its founder, escalated once per tier by the first member to reach
  // it, and — now — nudged once per reminder by the first member to owe it. Answering this
  // one differently would have reintroduced the defect the escalation rule was written for:
  // five members, one manifest, five nudges, and the load reduction inverting exactly when
  // somebody is already not answering.
  const { bench: b, pages } = paging();
  const delivery = { channels: ["spy"], recipients: [{ kind: "role", id: "oncall" } as const] };
  const over = { delivery, slaMs: 60_000, onTimeout: "fail" as const, reminders: [{ afterMs: 20_000 }] };

  const ids: GateId[] = [];
  for (let i = 0; i < 5; i++) ids.push(await b.broker.raise(b.log, request(b, over)));
  assert.equal(pages.length, 1, "one manifest, one first ask");

  b.clock.t += 20_001;
  await b.broker.sweepTimeouts(b.log, b.clock.t);
  assert.equal(pages.length, 2, "…and ONE nudge, not five");

  // The rows stay per member, like `gate.escalated`'s: each member's own counter is what
  // the next tick reads, and a shared one would be a second home for a per-gate fact.
  const p = (await b.broker.project(b.log))!;
  for (const id of ids) assert.equal(p.gates[id]?.remindersSent, 1, "every member's own schedule advanced");
  assert.equal((await journal(b.store, b.runId)).filter((ev) => ev.type === "gate.reminded").length, 5);

  // And five gates in NO batch are five questions, so they are nudged five times: the bound
  // is per batch, not a cap on nudges.
  const { bench: c, pages: cp } = paging();
  for (let i = 0; i < 5; i++) await c.broker.raise(c.log, request(c, { ...over, batching: undefined }));
  c.clock.t += 20_001;
  await c.broker.sweepTimeouts(c.log, c.clock.t);
  assert.equal(cp.length, 10, "five first asks, five nudges");
});

test("TWO GATES WHOSE NUDGE SCHEDULES DIFFER DO NOT MERGE, FOR THE REASON TWO ROUTES DO NOT", async () => {
  // The delivery digest is what makes suppressing a member's announcement honest: the page
  // it is not getting is one that would have gone to the same people, on the same channels,
  // with the same redact list. A nudge schedule is the WHEN of that same announcement, and
  // it arrived after the digest did — so two gates agreeing on the route and disagreeing on
  // the schedule would have merged, and the joiner's reminder at 10 s would have been
  // silently replaced by the founder's at 50 s. Same substitution, one field over, and
  // quieter: a nudge that never goes out leaves no trace where it was owed.
  const { bench: b, pages } = paging();
  const delivery = { channels: ["spy"], recipients: [{ kind: "role", id: "oncall" } as const] };
  const base = { delivery, slaMs: 60_000, onTimeout: "fail" as const };

  const founder = await b.broker.raise(b.log, request(b, { ...base, reminders: [{ afterMs: 50_000 }] }));
  const eager = await b.broker.raise(b.log, request(b, { ...base, reminders: [{ afterMs: 10_000 }] }));
  const p = (await b.broker.project(b.log))!;
  assert.equal(p.gates[eager]?.batch?.id, eager, "a different schedule is a different announcement policy");
  assert.notEqual(
    p.gates[founder]?.batch?.deliveryDigest,
    p.gates[eager]?.batch?.deliveryDigest,
    "and the journal says why, without saying when either one is due",
  );

  // Both are nudged on their own terms, which is the behaviour the merge was costing.
  b.clock.t += 10_001;
  await b.broker.sweepTimeouts(b.log, b.clock.t);
  assert.deepEqual(pages.map((x) => x.gateId), [founder, eager, eager], "the eager one, at its own instant");
  b.clock.t += 40_000;
  await b.broker.sweepTimeouts(b.log, b.clock.t);
  assert.deepEqual(pages.map((x) => x.gateId), [founder, eager, eager, founder], "…and the patient one at its own");

  // THE CONTROL: identical schedules still merge, and a batch of gates that declare no
  // reminders at all still merges — absent must compare equal to absent.
  const { bench: c } = paging();
  const lead = await c.broker.raise(c.log, request(c, { ...base, reminders: [{ afterMs: 10_000 }] }));
  const join = await c.broker.raise(c.log, request(c, { ...base, reminders: [{ afterMs: 10_000 }] }));
  assert.equal((await c.broker.project(c.log))!.gates[join]?.batch?.id, lead);

  const d = bench();
  const q1 = await d.broker.raise(d.log, request(d, { delivery: undefined }));
  const q2 = await d.broker.raise(d.log, request(d, { delivery: undefined }));
  const pd = (await d.broker.project(d.log))!;
  assert.equal(pd.gates[q2]?.batch?.id, q1, "no route and no schedule is still a policy two gates can share");
  assert.equal(pd.gates[q1]?.batch?.deliveryDigest, undefined, "and it is the absence of a digest, not a digest of nothing");
});

test("EACH MEMBER KEEPS ITS OWN CLOCK, AND THE BATCH SHOWS THE EARLIEST", async () => {
  const b = bench();
  const first = await b.broker.raise(b.log, request(b, { slaMs: 90_000 }));
  const second = await b.broker.raise(b.log, request(b, { slaMs: 30_000 }));
  const batch = (await batchesOf(b))[0]!;
  assert.deepEqual(batch.members.map((m) => m.gateId), [first, second], "different SLAs still merge");
  assert.equal(
    batch.deadline,
    b.clock.t + 30_000,
    "the earliest — the instant the batch stops being answerable as a whole",
  );
  assert.deepEqual(
    batch.members.map((m) => m.deadline),
    [b.clock.t + 90_000, b.clock.t + 30_000],
    "and the journal still carries one deadline per gate, which is what the sweep reads",
  );
});
