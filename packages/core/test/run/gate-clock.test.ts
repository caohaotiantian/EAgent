/**
 * The gate clock, driven end to end from a compiled graph.
 *
 * Two defects met here, and they were the same defect seen from two sides.
 *
 *   - **Nothing drove the clock.** `grep -ran sweepTimeouts packages/core/src` found the
 *     method's own definition and nothing else — no timer, no engine hook, no route, no
 *     scheduler tick. So SLA deadlines never expired, escalation tiers never fired, and a
 *     gate declaring `onTimeout: "fail"` waited forever in any deployment that did not
 *     sweep on its own, which was all of them.
 *   - **A graph could not ask for delivery.** `Engine`'s single `#gates.raise` call passed
 *     no `DeliverySpec` and `HumanGateNode` had nowhere to declare one, so the branch that
 *     dispatches a gate was unreachable except by an embedder driving the broker by hand —
 *     and a graph-raised gate had no `slaMs` either, so there was never anything for a
 *     sweep to find.
 *
 * EVERY DELIVERY TEST BEFORE THIS ONE DROVE THE BROKER DIRECTLY, which is exactly why the
 * second one survived nine hardening waves: the mechanism worked perfectly at the seam the
 * tests used, and no graph could reach that seam. So everything here goes through
 * `compileOrThrow` → `Engine.submit` → `Engine.advance` → `Engine.sweepGates`, and the
 * first test is the one that proves both halves at once: a graph-declared two-tier chain
 * escalating on an injected clock.
 *
 * NO TIMERS AND NO SLEEPS. `now` is a parameter everywhere, `clock.t` is advanced by hand,
 * and a tick is a method call — which is the same property that makes an
 * externally-driven sweep a sound design rather than a concession.
 *
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, HumanGateNode, RunGraph } from "../../src/graph/spec.ts";
import { newRunId, type EdgeId, type GateId, type NodeId, type RunId, type Seq, type TaskId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { AppendInput, StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  ConsoleChannel,
  GateDispatcher,
  type DeliveryChannel,
  type DeliverySpec,
  type DeliveryTarget,
} from "../../src/run/delivery.ts";
import { GateSweeper, HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { FunctionRegistry } from "../../src/run/registry.ts";
import { openGates } from "../../src/run/projection.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { spansFrom } from "../../src/telemetry/spans.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const ONCALL = { kind: "role", id: "sre-oncall" } as const;
const MANAGER = { kind: "role", id: "sre-manager" } as const;
const DIRECTOR = { kind: "role", id: "director" } as const;

/**
 * A two-tier chain with a terminal tier, exactly as D7.2 draws one.
 *
 * `afterMs` is each tier's OWN window, measured from the moment the previous tier breached
 * — see `nextTier`. The numbers below are chosen so a test can tell the two readings apart:
 * under the other one, tier 2 would fire at a different instant.
 */
const CHAIN: DeliverySpec = {
  channels: ["spy"],
  recipients: [ONCALL],
  escalation: [
    { afterMs: 900_000, to: [MANAGER] },
    { afterMs: 2_700_000, to: [DIRECTOR] },
    { afterMs: 5_400_000, action: "fail" },
  ],
};

/** Records what it was asked to deliver. The one channel a graph below names. */
class SpyChannel implements DeliveryChannel {
  readonly name = "spy";
  readonly seen: DeliveryTarget[] = [];
  deliver(target: DeliveryTarget): Promise<string> {
    this.seen.push(target);
    return Promise.resolve(`spy:${target.gate.gateId}:${target.tier}`);
  }
}

/**
 * The overridable half of the `human_gate` block below.
 *
 * `| undefined` on every field, and the merge below DELETES an undefined key rather than
 * assigning it: `exactOptionalPropertyTypes` makes `{delivery: undefined}` a different
 * thing from `{}`, and what these tests mean by `delivery: undefined` is "declare no
 * delivery block at all", which is the second one.
 */
interface GateBlock {
  readonly ref?: string | undefined;
  readonly approval?: HumanGateNode["approval"] | undefined;
  readonly sla?: HumanGateNode["sla"] | undefined;
  readonly delivery?: DeliverySpec | undefined;
}

/**
 * `start → approve → apply`, where `approve` is a `human_gate` that declares its own SLA
 * and delivery. Three nodes, because the point is what the gate does and not what the
 * graph computes.
 */
function gatedSpec(over: GateBlock = {}): GraphSpec {
  const block: Record<string, unknown> = {
    ref: "oversight/apply-plan@stable",
    approval: { approvers: ["u:sre-lead"] },
    sla: { respondWithinMs: 60_000, onTimeout: "escalate" },
    delivery: CHAIN,
    ...over,
  };
  for (const k of Object.keys(block)) if (block[k] === undefined) delete block[k];
  const humanGate = block as unknown as HumanGateNode;
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated-apply", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: {
      plan: { type: "string", reduce: "replace" },
      applied: { type: "object", reduce: "replace" },
    },
    inputs: ["plan"],
    outputs: ["applied"],
    nodes: [
      { id: n("start"), type: "function", reads: ["plan"], function: { ref: "function/noop@stable" } },
      { id: n("approve"), type: "human_gate", reads: ["plan"], humanGate },
      {
        id: n("apply"),
        type: "function",
        reads: ["plan"],
        writes: ["applied"],
        function: { ref: "function/apply@stable" },
      },
    ],
    edges: [
      { id: e("e0"), from: n("start"), to: n("approve"), kind: "seq" },
      { id: e("e1"), from: n("approve"), to: n("apply"), kind: "seq" },
    ],
  };
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly broker: HumanGateBroker;
  readonly spy: SpyChannel;
  readonly graph: RunGraph;
  readonly clock: { t: number };
  readonly applied: string[];
}

function rig(spec: GraphSpec = gatedSpec()): Rig {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const spy = new SpyChannel();
  const broker = new HumanGateBroker({
    now,
    dispatcher: new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() }),
  });
  const applied: string[] = [];
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/apply@stable", (view) => {
    const plan = view.get<string>("plan") ?? "";
    applied.push(plan);
    return { writes: { applied: { plan } } };
  });
  const engine = new Engine({ store, functions, now, gates: broker });
  return { engine, store, broker, spy, graph: compileOrThrow({ spec, resolver: resolver(), tools: {} }), clock, applied };
}

async function park(r: Rig): Promise<{ runId: RunId; gateId: GateId }> {
  const runId = await r.engine.submit({ graph: r.graph, inputs: { plan: "scale api to 12 replicas" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "the graph reached its gate");
  const gate = openGates(p)[0];
  assert.ok(gate !== undefined);
  return { runId, gateId: gate.gateId };
}

// ── the one test that proves both halves ─────────────────────────────────────

test("A GRAPH-DECLARED ESCALATION CHAIN REALLY ESCALATES, ON A CLOCK SOMETHING DRIVES", async () => {
  const r = rig();
  const { runId, gateId } = await park(r);

  // TIER 0 — delivery happened because the GRAPH asked for it. Before `HumanGateNode`
  // had a `delivery` field this array was empty: the dispatcher branch in `raise` was
  // unreachable from any compiled graph.
  assert.equal(r.spy.seen.length, 1, "the gate was DELIVERED, not merely queued");
  assert.equal(r.spy.seen[0]?.tier, 0);
  assert.deepEqual(r.spy.seen[0]?.recipients, [ONCALL]);
  assert.equal(r.spy.seen[0]?.gate.gateId, gateId);

  // Nothing is due yet, and a tick that finds nothing due must do nothing.
  r.clock.t += 59_000;
  assert.deepEqual((await r.engine.sweepGates()).fired, [], "59s into a 60s SLA");
  assert.equal(r.spy.seen.length, 1);

  // TIER 1 — the SLA breached and the NEXT people were told, not the same ones louder.
  r.clock.t += 1_001;
  const first = await r.engine.sweepGates();
  assert.deepEqual(first.fired, [gateId], "the sweep fired exactly the one gate that was due");
  assert.equal(first.swept, 1);
  assert.equal(r.spy.seen.length, 2);
  assert.equal(r.spy.seen[1]?.tier, 1);
  assert.deepEqual(r.spy.seen[1]?.recipients, [MANAGER]);
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.tier, 1, "…and the tier is in the JOURNAL");

  // THE CLOCK RESET, so sweeping again immediately walks nothing. A tier that inherited
  // the original deadline would page the director about something the on-call never saw.
  assert.deepEqual((await r.engine.sweepGates()).fired, []);
  r.clock.t += 899_000;
  assert.deepEqual((await r.engine.sweepGates()).fired, [], "tier 1 has its own 900s");
  assert.equal(r.spy.seen.length, 2);

  // TIER 2.
  r.clock.t += 1_001;
  assert.deepEqual((await r.engine.sweepGates()).fired, [gateId]);
  assert.equal(r.spy.seen.length, 3);
  assert.deepEqual(r.spy.seen[2]?.recipients, [DIRECTOR]);

  // EXHAUSTED — the terminal tier is not a fourth notification, it is the end of the run.
  r.clock.t += 2_700_001;
  assert.deepEqual((await r.engine.sweepGates()).fired, [gateId]);
  assert.equal(r.spy.seen.length, 3, "nobody is told about a terminal tier");

  const done = (await r.engine.projection(runId))!;
  assert.equal(done.status, "failed");
  assert.equal(done.error?.code, "E_GATE_EXPIRED");
  assert.equal(done.gates[gateId]?.state, "expired");
  assert.deepEqual(r.applied, [], "AND EXPIRY IS STILL NOT AN APPROVAL — the guarded action never ran");
});

test("a gate a human answers in time is never escalated, and the work behind it runs", async () => {
  const r = rig();
  const { runId, gateId } = await park(r);

  r.clock.t += 30_000;
  await r.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:sre-lead", via: "console" },
    idempotencyKey: "yes",
  });

  r.clock.t += 1_000_000;
  const swept = await r.engine.sweepGates();
  assert.deepEqual(swept.fired, [], "a decided gate has no deadline left to miss");
  assert.equal(swept.swept, 0, "…and the tick does not even sweep the run");
  assert.equal(r.spy.seen.length, 1, "tier 0 and no more");
  assert.deepEqual(r.applied, ["scale api to 12 replicas"]);
});

// ── who drives it, and across which runs ─────────────────────────────────────

test("THE SWEEP REACHES A RUN THIS PROCESS NEVER ATTACHED", async () => {
  // The restart case, and the reason the sweep is store-scoped rather than a loop over the
  // engine's attached runs. After a deploy the control plane holds no context for a run
  // that suspended before it started; a sweep that only saw attached runs would leave every
  // such gate open forever, which is precisely the failure this whole path exists to fix.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId, gateId } = await park(r);

  const fresh = new Engine({ store: r.store, now: () => r.clock.t });
  r.clock.t += 60_001;
  const report = await fresh.sweepGates();

  assert.deepEqual(report.fired, [gateId]);
  assert.equal(report.considered, 1, "one run in view");
  const p = (await fresh.projection(runId))!;
  assert.equal(p.status, "failed");
  assert.equal(p.gates[gateId]?.state, "expired");
});

test("a TERMINAL run is not swept, and neither is a run with no clock", async () => {
  const noSla = rig(gatedSpec({ sla: undefined, delivery: undefined }));
  const { runId, gateId } = await park(noSla);
  noSla.clock.t += 100_000_000;
  assert.deepEqual((await noSla.engine.sweepGates()).swept, 0, "a gate with no SLA has no deadline to miss");
  assert.equal((await noSla.engine.projection(runId))!.gates[gateId]?.state, "open");

  const cancelled = rig();
  const c = await park(cancelled);
  await cancelled.engine.cancel(c.runId, "stop");
  cancelled.clock.t += 100_000_000;
  const report = await cancelled.engine.sweepGates();
  assert.equal(report.swept, 0, "A DEAD RUN HAS NO DEADLINES LEFT TO MISS");
  const p = (await cancelled.engine.projection(c.runId))!;
  assert.equal(p.status, "cancelled", "the sweep did not walk a cancelled run back into failed");
  assert.equal(p.gates[c.gateId]?.state, "cancelled");
});

test("two sweeps at the same instant escalate ONCE, and so do two sweepers racing", async () => {
  const r = rig();
  const { runId, gateId } = await park(r);
  r.clock.t += 60_001;

  // Same engine, twice — the cursor is what stops the second one.
  await r.engine.sweepGates();
  await r.engine.sweepGates();
  assert.equal(r.spy.seen.length, 2, "one escalation");

  // Two INDEPENDENT sweepers over the same store and the same broker, with no shared
  // cursor at all: the store's compare-and-swap is what makes this safe, not coordination.
  const a = new GateSweeper({ store: r.store, broker: r.broker, now: () => r.clock.t });
  const b = new GateSweeper({ store: r.store, broker: r.broker, now: () => r.clock.t });
  r.clock.t += 900_001;
  const [ra, rb] = await Promise.all([a.sweep(), b.sweep()]);

  assert.equal(ra.fired.length + rb.fired.length, 1, "exactly one of them wrote the escalation");
  assert.equal(r.spy.seen.length, 3, "and exactly one tier-2 delivery happened");
  const escalations = (await drain(r.store, runId)).filter((ev) => ev.type === "gate.escalated");
  assert.deepEqual(escalations.map((ev) => (ev.payload as { tier: number }).tier), [1, 2]);
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.tier, 2);
});

// ── what a tick costs ────────────────────────────────────────────────────────

test("A TICK THAT FINDS NOTHING NEW READS NOTHING", async () => {
  // The whole reason `GateSweeper` carries a cursor. The obvious implementation folds every
  // run's entire journal on every tick — O(runs × events) per second — and it is the first
  // thing that falls over. This measures the claim rather than asserting it.
  const inner = new MemoryStateStore({ now: () => clock.t });
  const clock = { t: 1_700_000_000_000 };
  const counts = { read: 0, list: 0 };
  const counting: StateStore = {
    append: (i: AppendInput) => inner.append(i),
    read: (runId, from, to) => {
      counts.read++;
      return inner.read(runId, from, to);
    },
    head: (runId) => inner.head(runId),
    listRuns: (limit?: number) => {
      counts.list++;
      return inner.listRuns(limit);
    },
    close: () => inner.close(),
  };

  const engine = new Engine({ store: counting, functions: functionsFor([]), now: () => clock.t });
  const graph = compileOrThrow({ spec: gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }), resolver: resolver(), tools: {} });
  const runId = await engine.submit({ graph, inputs: { plan: "p" } });
  await engine.advance(runId);

  // First tick: the sweeper has never folded this run, so it reads it once.
  await engine.sweepGates();
  const afterFirst = counts.read;
  counts.list = 0;

  // Second and third ticks: the head has not moved and the deadline is not due, so the
  // cursor answers from three fields and the store is never read at all.
  await engine.sweepGates();
  await engine.sweepGates();
  assert.equal(counts.read, afterFirst, "NOT ONE journal read for two whole ticks");
  assert.equal(counts.list, 2, "one listRuns per tick, which is the irreducible part");
  assert.equal(runId.length > 0, true);
});

test("a run whose head MOVED costs its tail, not its history", async () => {
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId } = await park(r);
  await r.engine.sweepGates();

  // Append a run of unrelated events, then measure what the next tick reads.
  const log = new RunLog(runId, { store: r.store, now: () => r.clock.t });
  const before = (await r.engine.projection(runId))!.seq;
  for (let i = 0; i < 20; i++) {
    await log.append([{ type: "task.progress", payload: { chunk: `c${i}` }, actor: { kind: "system", component: "test" } }]);
  }
  const after = (await r.engine.projection(runId))!.seq;
  assert.equal(after - before, 20);

  const seen: Seq[] = [];
  const spyStore: StateStore = {
    append: (i: AppendInput) => r.store.append(i),
    read: (rid, from, to) => {
      seen.push(from);
      return r.store.read(rid, from, to);
    },
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };
  const sweeper = new GateSweeper({ store: spyStore, broker: r.broker, now: () => r.clock.t });
  await sweeper.sweep(); // first tick on THIS sweeper: a full fold, from seq 1
  seen.length = 0;
  await log.append([{ type: "task.progress", payload: { chunk: "last" }, actor: { kind: "system", component: "test" } }]);
  await sweeper.sweep();

  assert.deepEqual(seen, [(after + 1) as Seq], "the tail only — it did not start over at seq 1");
});

// ── two sweeps that OVERLAP rather than alternate ────────────────────────────

/** A promise and its resolver. The only synchronisation these tests need. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A store that PARKS its `nth` read and lets the test run something else first.
 *
 * The only way to put a second writer INSIDE a sweep's own read→write window on purpose. A
 * sweep's reads are its decision points — the fold it decides on, then `#commitForOpenGate`'s
 * re-read — so parking one of them and doing something in the gap is what turns "two writers
 * raced" from a coin flip into a test. `Promise.all` over two sweeps does not do this: two
 * coroutines stepping in lockstep re-read at the same depth, which is the interleave the
 * defect is invisible in.
 *
 * `nth` counts from `arm()`, so it means "the nth read of THIS tick" rather than a fact
 * about how many reads a cold sweeper does.
 */
function parkingStore(inner: StateStore): {
  readonly store: StateStore;
  readonly arm: (nth: number) => Promise<void>;
  readonly release: () => void;
} {
  let target = 0;
  let reads = 0;
  let arrived = deferred();
  let go = deferred();
  const store: StateStore = {
    append: (i: AppendInput) => inner.append(i),
    read: (rid, from, to) => {
      if (target === 0 || ++reads !== target) return inner.read(rid, from, to);
      // The inner generator's body has not run yet, so the events it yields are the ones
      // that exist when the park is RELEASED, not when it was created.
      const it = inner.read(rid, from, to);
      return (async function* () {
        arrived.resolve();
        await go.promise;
        yield* it;
      })();
    },
    head: (rid) => inner.head(rid),
    listRuns: (limit?: number) => inner.listRuns(limit),
    close: () => inner.close(),
  };
  return {
    store,
    arm: (nth: number) => {
      target = nth;
      reads = 0;
      arrived = deferred();
      go = deferred();
      return arrived.promise;
    },
    release: () => go.resolve(),
  };
}

test("TWO SWEEPS THAT DECIDED AT THE SAME SEQ ESCALATE ONCE, even when one writes first", async () => {
  // The sibling test above races two sweepers with `Promise.all` and passes, because two
  // coroutines stepping in lockstep re-read at the same depth and therefore commit against
  // the same seq — the store refuses the second and the defect is invisible. The interleave
  // that reaches it is the one two PROCESSES have: both fold, one runs to completion, and
  // only then does the other reach its write. Nothing about that is exotic; it is what a
  // second process does while the first one is inside `deliver`.
  //
  // What used to happen: B decided at seq S, A wrote at S, B's own re-read then saw S+1,
  // found the gate still `open` — an escalation does not close a gate, which is why the
  // "still open?" check cannot stand in for the swap here — and compare-and-swapped against
  // ITS OWN read rather than against the seq the decision was made at. Both landed.
  const r = rig();
  const { runId, gateId } = await park(r);

  const parking = parkingStore(r.store);
  const b = new GateSweeper({ store: parking.store, broker: r.broker, now: () => r.clock.t });
  await b.sweep(); // nothing due; B now holds a warm cursor, so its next tick reads twice
  assert.equal(r.spy.seen.length, 1, "tier 0 only, so far");

  r.clock.t += 60_001;
  // Read 1 is B's fold — the seq it decides at. Read 2 is `#commitForOpenGate`'s re-read.
  const atTheWindow = parking.arm(2);
  const bTick = b.sweep();
  await atTheWindow; // B has decided to escalate and has not written yet

  const a = new GateSweeper({ store: r.store, broker: r.broker, now: () => r.clock.t });
  const ra = await a.sweep();
  parking.release();
  const rb = await bTick;

  const escalations = (await drain(r.store, runId)).filter((ev) => ev.type === "gate.escalated");
  assert.equal(escalations.length, 1, "ONE gate, ONE escalation");
  assert.equal(ra.fired.length + rb.fired.length, 1, "…and only the sweep that wrote claims it fired");
  assert.equal(r.spy.seen.length, 2, "the manager was paged once, not twice");
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.tier, 1, "one tier burned");
});

// ── a run an operator has rewound ────────────────────────────────────────────

/**
 * Approve, then rewind past the approval, leaving the gate open again with its clock.
 *
 * `key` is a parameter because the broker's idempotency map is per `(gate, approver, key)`
 * and outlives a rewind: calling this twice with one key makes the SECOND approval a no-op,
 * which quietly turns a two-rewind journal into two adjacent markers with nothing between
 * them — the one shape in which folding them one at a time happens to give the right answer.
 */
async function rewindPastApproval(r: Rig, runId: RunId, gateId: GateId, key = "yes"): Promise<void> {
  const raisedAtSeq = (await r.engine.projection(runId))!.gates[gateId]!.raisedAtSeq;
  await r.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:sre-lead", via: "console" },
    idempotencyKey: key,
  });
  // `raisedAtSeq + 1` is the `run.suspended` that shipped in the raise's own append, so the
  // suppressed range is exactly the decision and its resume. Rewinding to the decision's own
  // seq is refused; rewinding to the raise's would drop the suspension with it.
  await r.engine.rewind(runId, (raisedAtSeq + 1) as Seq, "the change window moved");
  const p = (await r.engine.projection(runId))!;
  assert.equal(p.status, "awaiting_gate", "the FOLD honours the marker");
  assert.equal(p.gates[gateId]?.state, "open", "…and the gate is a live question again");
}

test("A REWOUND RUN STILL HAS AN SLA", async () => {
  // `Engine.rewind` appends a `checkpoint.restored` marker that the fold reads as "hide
  // (atSeq, marker)". The sweeper's incremental folder cannot: it stops at the marker and
  // asks to start over, and starting over met the same marker and stopped again — so the
  // cursor described the run as it was BEFORE the rewind, with the gate `decided` and
  // nothing due. The run's deadlines never fired again, silently, and the runs this happens
  // to are exactly the ones an operator has already had to intervene in.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId, gateId } = await park(r);
  await r.engine.sweepGates(); // the cursor is warm — this is the incremental path

  r.clock.t += 30_000;
  await rewindPastApproval(r, runId, gateId);

  r.clock.t += 30_001;
  const report = await r.engine.sweepGates();
  assert.deepEqual(report.fired, [gateId], "THE DEADLINE THE JOURNAL STILL RECORDS FIRED");
  const p = (await r.engine.projection(runId))!;
  assert.equal(p.status, "failed");
  assert.equal(p.gates[gateId]?.state, "expired");
  // `applied` records that the guarded work ran ONCE, before the rewind — a rewind rolls
  // back the journal, never the world, which is why `rewind` refuses to cross an
  // irreversible effect with no compensation. It is asserted rather than ignored so nobody
  // reads this test as a claim that a rewind un-does side effects.
  assert.deepEqual(r.applied, ["scale api to 12 replicas"]);
});

test("a rewind costs ONE re-fold, not one per tick forever", async () => {
  // The other half of the same defect, and the one a deployment feels rather than sees: a
  // cursor that permanently mis-describes its run re-reads the whole journal on every tick.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 600_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId, gateId } = await park(r);

  const seen: Seq[] = [];
  const counting: StateStore = {
    append: (i: AppendInput) => r.store.append(i),
    read: (rid, from, to) => {
      seen.push(from);
      return r.store.read(rid, from, to);
    },
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };
  const sweeper = new GateSweeper({ store: counting, broker: r.broker, now: () => r.clock.t });
  await sweeper.sweep();

  r.clock.t += 30_000;
  await rewindPastApproval(r, runId, gateId);

  seen.length = 0;
  await sweeper.sweep();
  assert.equal(seen.length > 0, true, "the tick that MEETS the marker pays for it, once");

  seen.length = 0;
  await sweeper.sweep();
  await sweeper.sweep();
  assert.deepEqual(seen, [], "NOT ONE journal read for two whole ticks after the rewind");
});

// ── a terminal run stops the rest of its own tick ────────────────────────────

/**
 * Two gates open at once on ONE run.
 *
 * The only shape in which a tick can page a human about a run it has already failed: a
 * sweep is a run-wide loop over due gates, and the first gate to expire ends the run
 * underneath every gate behind it.
 */
function twoGateSpec(second: GateBlock = {}, first: GateBlock = {}): GraphSpec {
  const block = (over: GateBlock): HumanGateNode => {
    const b: Record<string, unknown> = {
      ref: "oversight/apply-plan@stable",
      approval: { approvers: ["u:sre-lead"] },
      sla: { respondWithinMs: 60_000, onTimeout: "fail" },
      ...over,
    };
    for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
    return b as unknown as HumanGateNode;
  };
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "two-gates", project: "demo", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { plan: { type: "string", reduce: "replace" } },
    inputs: ["plan"],
    outputs: [],
    nodes: [
      { id: n("start"), type: "function", reads: ["plan"], function: { ref: "function/noop@stable" } },
      { id: n("gate_a"), type: "human_gate", reads: ["plan"], humanGate: block(first) },
      { id: n("gate_b"), type: "human_gate", reads: ["plan"], humanGate: block(second) },
    ],
    edges: [
      { id: e("e0"), from: n("start"), to: n("gate_a"), kind: "seq" },
      { id: e("e1"), from: n("start"), to: n("gate_b"), kind: "seq" },
    ],
  };
}

async function parkBoth(r: Rig): Promise<{ runId: RunId; first: GateId; second: GateId }> {
  const runId = await r.engine.submit({ graph: r.graph, inputs: { plan: "scale api to 12 replicas" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  const open = openGates(p);
  assert.deepEqual(open.map((g) => g.nodeId as string), ["gate_a", "gate_b"], "journal order, which is sweep order");
  return { runId, first: open[0]!.gateId, second: open[1]!.gateId };
}

test("A RUN THE TICK HAS ALREADY FAILED GETS NO SECOND TERMINAL EVENT", async () => {
  const r = rig(twoGateSpec({}));
  const { runId, second } = await parkBoth(r);
  r.clock.t += 60_001;

  const report = await r.engine.sweepGates();
  const evs = await drain(r.store, runId);
  assert.equal(evs.filter((ev) => ev.type === "run.failed").length, 1, "ONE terminal record, not two");
  assert.equal(report.fired.length, 1, "…and the tick claims one gate, not both");
  const p = (await r.engine.projection(runId))!;
  assert.equal(p.status, "failed");
  // The sibling stays OPEN on a failed run, exactly as it does when a human's expiry ends a
  // run with other gates outstanding. `resolve` refuses it because the run is terminal.
  assert.equal(p.gates[second]?.state, "open");
});

test("NOBODY IS PAGED ABOUT A RUN THIS TICK HAS ALREADY FAILED", async () => {
  const r = rig(twoGateSpec({ sla: { respondWithinMs: 60_000, onTimeout: "escalate" }, delivery: CHAIN }));
  const { runId, second } = await parkBoth(r);
  assert.equal(r.spy.seen.length, 1, "tier 0 for the escalating gate");
  r.clock.t += 60_001;

  await r.engine.sweepGates();
  assert.equal(r.spy.seen.length, 1, "THE MANAGER WAS NOT PAGED ABOUT A RUN THAT WAS ALREADY DEAD");
  const evs = await drain(r.store, runId);
  assert.equal(evs.some((ev) => ev.type === "gate.escalated"), false, "…and no tier was burned on it");
  const p = (await r.engine.projection(runId))!;
  assert.equal(p.status, "failed");
  assert.equal(p.gates[second]?.tier, 0);
});

// ── guards nothing was holding ───────────────────────────────────────────────
//
// Found the way earlier waves found theirs: revert one condition, run the suite, count what
// goes red. Everything in THIS section turned NOTHING red, including two the sweeper's own
// comments claim are covered — and it did not find them all, which is what the section after
// it is. The headline here is the pair immediately following: the test named "a
// TERMINAL run is not swept" reaches the terminal check on NEITHER of its two runs, because
// a cancel closes the run's gates and a run with no open gate is skipped one condition
// earlier. It has been asserting the no-clock path twice.

test("A TERMINAL RUN WITH AN OVERDUE GATE STILL OPEN IS NOT SWEPT", async () => {
  // The state the check actually has to survive, and the one nothing reached: an expiry
  // FAILS the run and leaves every sibling gate open, so the cursor's `due` is defined and
  // in the past and `terminal` is the only thing standing between the sweep and a run it
  // has already ended.
  const r = rig(twoGateSpec({}));
  const { runId, second } = await parkBoth(r);
  r.clock.t += 60_001;
  await r.engine.sweepGates();

  const p = (await r.engine.projection(runId))!;
  assert.equal(p.status, "failed");
  assert.equal(p.gates[second]?.state, "open", "an overdue question on a dead run");

  const before = (await drain(r.store, runId)).length;
  r.clock.t += 60_001;
  const later = await r.engine.sweepGates();
  assert.equal(later.swept, 0, "A DEAD RUN HAS NO DEADLINES LEFT TO MISS");
  assert.deepEqual(later.fired, []);
  assert.equal((await drain(r.store, runId)).length, before, "…and nothing was appended to it");
});

test("…and the broker refuses the same run even when something calls it directly", async () => {
  // The other half, one layer down. `GateSweeper` skips a terminal run on a cursor field, so
  // that check alone would leave the rule true only for the caller that remembered it —
  // and `sweepTimeouts` is public, an embedder can drive it, and a journal an older build
  // wrote can reach it with the cancel/expiry closed differently.
  const r = rig(twoGateSpec({}));
  const { runId } = await parkBoth(r);
  r.clock.t += 60_001;
  await r.engine.sweepGates();

  const log = new RunLog(runId, { store: r.store, now: () => r.clock.t });
  const before = (await drain(r.store, runId)).length;
  assert.deepEqual(await r.broker.sweepTimeouts(log, r.clock.t + 600_000), []);
  assert.equal((await drain(r.store, runId)).length, before, "not one event");
});

test("A TICK STOPS WORKING ON A RUN IT HAS JUST FAILED, rather than merely refusing to write", async () => {
  // The ordering half of the same fix, and the half a write-side refusal cannot stand in
  // for: after the expiry, the gates behind it must cost NOTHING — no fold, no re-read, no
  // delivery attempt. Measured as a difference rather than an absolute count, so it survives
  // a restructuring of how many reads a tick legitimately makes: the same graph, the same
  // journal, the same tick, with the sibling gate's deadline moved out of range.
  const reads = (spec: GraphSpec): Promise<number> => tickReads(spec);
  const bothDue = await reads(twoGateSpec({}));
  const oneDue = await reads(twoGateSpec({ sla: { respondWithinMs: 600_000, onTimeout: "fail" } }));
  assert.equal(bothDue, oneDue, "the gate behind the expiry cost exactly what a not-yet-due gate costs: nothing");
});

/** Journal reads made by one tick, on a run parked at two gates with a 60s clock. */
async function tickReads(spec: GraphSpec): Promise<number> {
  const r = rig(spec);
  await parkBoth(r);
  let reads = 0;
  const counting: StateStore = {
    append: (i: AppendInput) => r.store.append(i),
    read: (rid, from, to) => {
      reads++;
      return r.store.read(rid, from, to);
    },
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };
  const sweeper = new GateSweeper({ store: counting, broker: r.broker, now: () => r.clock.t });
  await sweeper.sweep();
  r.clock.t += 60_001;
  reads = 0;
  await sweeper.sweep();
  return reads;
}

test("TWO LIVE GATES BOTH ESCALATE IN ONE TICK", async () => {
  // The positive case the per-gate re-fold exists for, and the reason the loop cannot decide
  // everything from the fold it started with. The first escalation moves the head; a second
  // gate whose decision is still pinned to the seq before it swaps against a journal that
  // has moved and writes nothing — so its SLA would slip a whole tick every time it shared a
  // run with another due gate.
  const r = rig(twoGateSpec({ sla: { respondWithinMs: 60_000, onTimeout: "escalate" }, delivery: CHAIN }, { sla: { respondWithinMs: 60_000, onTimeout: "escalate" }, delivery: CHAIN }));
  const { runId, first, second } = await parkBoth(r);
  assert.equal(r.spy.seen.length, 2, "tier 0 for each");

  r.clock.t += 60_001;
  const report = await r.engine.sweepGates();
  assert.deepEqual([...report.fired].sort(), [first, second].sort(), "BOTH, in the one tick");
  assert.equal(r.spy.seen.length, 4, "…and both managers were paged");
  const p = (await r.engine.projection(runId))!;
  assert.equal(p.gates[first]?.tier, 1);
  assert.equal(p.gates[second]?.tier, 1);
  assert.notEqual(p.status, "failed", "an escalation is not an ending");
});

test("A RUN IS DUE AT ITS EARLIEST DEADLINE, not its latest", async () => {
  // `nextDeadline` is what a tick reads instead of folding, so picking the wrong end of the
  // range does not fail loudly — it just makes every gate on a multi-gate run wait for the
  // most patient one. Here the second gate's SLA is ten minutes and the first's is one.
  const r = rig(twoGateSpec({ sla: { respondWithinMs: 600_000, onTimeout: "fail" } }));
  const { runId, first } = await parkBoth(r);

  r.clock.t += 60_001;
  const report = await r.engine.sweepGates();
  assert.deepEqual(report.fired, [first], "the impatient gate fired on its own clock");
  assert.equal((await r.engine.projection(runId))!.status, "failed");
});

test("A LIMIT THE SWEEP CANNOT HONOUR IS REFUSED, not clamped", async () => {
  // THIS USED TO CLAMP, and the argument for clamping does not survive being checked.
  //
  // It read: `listRuns(0)` returns nothing, so `Math.max(1, …)` makes a mistyped knob "a slow
  // tick rather than no clock at all". But `listRuns` is `ORDER BY run_id DESC LIMIT ?` over
  // time-ordered ids, so a limit of 1 pins every tick to the single NEWEST run — gates on every
  // other run never expire, which is no clock at all for all but one of them. The floor bought
  // the appearance of the guarantee, not the guarantee.
  //
  // And it guarded exactly one value. `Math.max(1, NaN)` is `NaN`, `Math.max(1, Infinity)` is
  // `Infinity`, `Math.max(1, 1.5)` is `1.5` — measured on node v24.16.0 — and all three reach
  // `listRuns`, where SQLite reads a negative as NO LIMIT and throws `datatype mismatch` on a
  // fraction while the memory store's `slice` answers differently again.
  //
  // So it joins the family `PolicyEngineOptions.interventionWindowMs` and
  // `ControlPlaneOptions.requestTimeoutMs` are already in, and refuses at construction for the
  // reason `positive` gives in `cli.ts`: a clamp substitutes a number the operator did not
  // choose, on a knob that decides whether gates expire at all.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => new GateSweeper({ store: r.store, broker: r.broker, now: () => r.clock.t, limit }),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
      `limit ${String(limit)} must be refused`,
    );
  }

  // AND THROUGH `EngineOptions.sweep`, WHICH IS THE DOOR AN EMBEDDER ACTUALLY USES. `GateSweeper`
  // is built lazily inside `sweepGates`, so a refusal that lived only in its constructor first
  // surfaced from a TICK — and the deployment snippet in that method's own docstring wraps the
  // tick in `.catch(() => {})`, which swallows it forever. `limit: 0` then swept NOTHING, on a
  // process that had started clean: worse than the clamp this replaced, which swept one run.
  for (const limit of [0, NaN, Infinity]) {
    assert.throws(
      () => new Engine({ store: r.store, now: () => r.clock.t, policy: { granted: [] }, sweep: { limit } } as never),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
      `Engine must refuse sweep.limit ${String(limit)} at construction`,
    );
  }

  // AND A USABLE ONE STILL SWEEPS, so the refusal is not a sweeper that refuses everybody.
  const { gateId } = await park(r);
  r.clock.t += 60_001;
  const report = await new GateSweeper({ store: r.store, broker: r.broker, now: () => r.clock.t, limit: 1 }).sweep();
  assert.equal(report.considered, 1);
  assert.deepEqual(report.fired, [gateId]);
});

test("A SWEEP THAT WROTE NOTHING DOES NOT REPORT THE GATE AS FIRED — the escalate arm", async () => {
  // `SweepReport.fired` is what an operator's dashboard reads, so a gate listed there is a
  // claim that the clock did something to it. A human answering inside the sweep's own
  // read→write window makes that claim false: the escalation writes nothing, and reporting
  // it anyway says the manager was paged about a question that had already been answered.
  const r = rig();
  const { runId, gateId } = await park(r);
  const parking = parkingStore(r.store);
  const sweeper = new GateSweeper({ store: parking.store, broker: r.broker, now: () => r.clock.t });
  await sweeper.sweep();

  r.clock.t += 60_001;
  const atTheWindow = parking.arm(2);
  const tick = sweeper.sweep();
  await atTheWindow;
  await r.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:sre-lead", via: "console" },
    idempotencyKey: "yes",
  });
  parking.release();

  assert.deepEqual((await tick).fired, [], "nothing landed, so nothing is claimed");
  assert.equal(r.spy.seen.length, 1, "the manager was never told");
  assert.equal((await drain(r.store, runId)).some((ev) => ev.type === "gate.escalated"), false);
  assert.deepEqual(r.applied, ["scale api to 12 replicas"], "the human's approval is what happened");
});

test("…and the default-action arm, which no graph can declare and an operator can", async () => {
  // `default_action` is a compile error on a graph (a graph cannot pre-authorize a decision)
  // and is reachable through the broker, which is where a rehydrated gate gets one. Same
  // window, same rule: a decision inside it means the clock writes nothing at all, not even
  // the `gate.timeout{default_action}` row — which on a decided gate would read as the SLA
  // having had a say in an outcome it never reached.
  const r = rig();
  const runId = "run_default_action" as RunId;
  const parking = parkingStore(r.store);
  const raiseLog = new RunLog(runId, { store: r.store, now: () => r.clock.t });
  const gateId = await r.broker.raise(raiseLog, {
    runId,
    taskId: "approve@root#0" as TaskId,
    nodeId: n("approve"),
    policyRef: "oversight/apply-plan@stable",
    payload: { plan: "scale api" },
    slaMs: 60_000,
    onTimeout: "default_action",
    defaultAction: { kind: "approve" },
  });

  r.clock.t += 60_001;
  const atTheWindow = parking.arm(2);
  const tick = r.broker.sweepTimeouts(new RunLog(runId, { store: parking.store, now: () => r.clock.t }), r.clock.t);
  await atTheWindow;
  await r.broker.resolve(raiseLog, {
    gateId,
    decision: { kind: "reject", reason: "not this week" },
    actor: { kind: "human", subject: "u:sre-lead", via: "console" },
    idempotencyKey: "no",
  });
  parking.release();

  assert.deepEqual(await tick, [], "nothing landed, so nothing is claimed");
  const evs = await drain(r.store, runId);
  assert.equal(evs.some((ev) => ev.type === "gate.timeout"), false, "not even the non-expiring row");
  assert.equal((await r.broker.project(raiseLog))!.gates[gateId]?.decision, "reject");
});

test("a run rewound TWICE still folds, and still has an SLA", async () => {
  // Two markers with REAL EVENTS BETWEEN THEM, met in one catch-up — which is the shape that
  // needs more than one pass. Each pass stops at the first marker it has not been told about,
  // so pass 2 gets past the first rewind and then folds the second approval as if it had
  // happened, before meeting the second marker that says it did not. A fold that starts over
  // only once hands that projection back: the gate reads `decided`, the run reads
  // `succeeded`, and nothing is ever due again. Three passes is the correct cost of two
  // rewinds, and it is paid once.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId, gateId } = await park(r);
  const raisedAtSeq = (await r.engine.projection(runId))!.gates[gateId]!.raisedAtSeq;

  r.clock.t += 20_000;
  await rewindPastApproval(r, runId, gateId);
  r.clock.t += 10_000;
  await rewindPastApproval(r, runId, gateId, "again");
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.state, "open");
  assert.equal(raisedAtSeq > 0, true);

  // A COLD sweeper, so both markers are met in the same catch-up.
  r.clock.t += 30_001;
  const report = await new GateSweeper({ store: r.store, broker: r.broker, now: () => r.clock.t }).sweep();
  assert.deepEqual(report.fired, [gateId]);
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.state, "expired");
});

test("…and an ENGINE that meets both markers at once folds them too", async () => {
  // The same defect in the executor's copy of the same loop. A process that was following
  // the run learned the first range as it happened, so it only ever meets one new marker at
  // a time; a process that ATTACHES to a run someone else rewound twice meets both in its
  // first fold, and that is the one that has to work — it is the restart case, which is
  // where every other gate defect in this file was found.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId, gateId } = await park(r);

  r.clock.t += 20_000;
  await rewindPastApproval(r, runId, gateId);
  r.clock.t += 10_000;
  await rewindPastApproval(r, runId, gateId, "again");

  const fresh = new Engine({ store: r.store, now: () => r.clock.t, gates: r.broker });
  fresh.attach(runId, r.graph);
  const p = (await fresh.projection(runId))!;
  assert.equal(p.status, "awaiting_gate", "the fresh process agrees with the journal");
  assert.equal(p.gates[gateId]?.state, "open");
});

// ── the A9 race, driven deterministically ────────────────────────────────────

test("A DECISION LANDING INSIDE THE SWEEP'S OWN WRITE WINDOW IS NOT OVERRULED", async () => {
  // The register's reproduction, as a test. `#expire` used to read the projection once and
  // append `gate.timeout` + `run.failed` without re-reading the gate, so a decision landing
  // in that window produced `5:gate.decided 6:run.resumed 7:gate.timeout 8:run.failed` and
  // a read model saying *this gate was approved and the run was killed for not answering
  // it*. The interleave is forced here rather than raced, because a race that reproduces
  // one time in ten is a test that passes nine times out of ten.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId, gateId } = await park(r);

  let interleave: (() => Promise<unknown>) | undefined;
  const holding: StateStore = {
    append: async (input: AppendInput) => {
      const isExpiry = input.events.some((ev) => ev.type === "gate.timeout");
      if (isExpiry && interleave !== undefined) {
        // The decision lands WHILE the expiry is in flight: after the sweep read the gate
        // and decided it was overdue, before its own write reaches the store.
        const run = interleave;
        interleave = undefined;
        await run();
      }
      return r.store.append(input);
    },
    read: (rid, from, to) => r.store.read(rid, from, to),
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };

  interleave = () =>
    r.engine.resolveGate(runId, {
      gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:sre-lead", via: "console" },
      idempotencyKey: "yes",
    });

  r.clock.t += 60_001;
  const sweeper = new GateSweeper({ store: holding, broker: r.broker, now: () => r.clock.t });
  const report = await sweeper.sweep();

  const evs = await drain(r.store, runId);
  assert.equal(evs.some((ev) => ev.type === "gate.decided"), true, "the human's answer landed");
  assert.equal(evs.some((ev) => ev.type === "gate.timeout"), false, "AND THE EXPIRY WROTE NOTHING");
  assert.equal(evs.some((ev) => ev.type === "run.failed"), false, "…including the run.failed that rode with it");
  assert.deepEqual(report.fired, [], "a sweep that wrote nothing does not claim it fired anything");

  const p = (await r.engine.projection(runId))!;
  assert.equal(p.gates[gateId]?.state, "decided");
  assert.notEqual(p.status, "failed");
});

// ── one run's failure does not switch off another run's SLA ──────────────────

test("A STORE THAT REFUSES ONE RUN DOES NOT STOP THE OTHER RUNS' DEADLINES", async () => {
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const a = await park(r);
  const b = await park(r);
  assert.notEqual(a.runId, b.runId);

  const refusing: StateStore = {
    append: (input: AppendInput) =>
      input.runId === a.runId && input.events.some((ev) => ev.type === "gate.timeout")
        ? Promise.reject(new Error("the store is not accepting writes"))
        : r.store.append(input),
    read: (rid, from, to) => r.store.read(rid, from, to),
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };

  r.clock.t += 60_001;
  const report = await new GateSweeper({ store: refusing, broker: r.broker, now: () => r.clock.t }).sweep();

  assert.deepEqual(report.fired, [b.gateId], "THE RUN BEHIND THE UNWRITABLE ONE STILL EXPIRED");
  assert.equal(report.failed, 0, "the refusal was absorbed per gate, one level down, so the tick itself was clean");
  assert.equal((await r.engine.projection(a.runId))!.gates[a.gateId]?.state, "open");
  assert.equal((await r.engine.projection(b.runId))!.status, "failed");
});

test("a store that will not READ a run costs that run's tick and no other", async () => {
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));
  const a = await park(r);
  const b = await park(r);

  const unreadable: StateStore = {
    append: (i: AppendInput) => r.store.append(i),
    read: (rid, from, to) => {
      if (rid === a.runId) throw new Error("the store is not accepting reads");
      return r.store.read(rid, from, to);
    },
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };

  r.clock.t += 60_001;
  const report = await new GateSweeper({ store: unreadable, broker: r.broker, now: () => r.clock.t }).sweep();
  assert.deepEqual(report.fired, [b.gateId]);
  assert.equal(report.failed, 1, "…and the tick SAYS one run failed rather than swallowing it");
});

// ── the four the previous probe pass left standing ───────────────────────────
//
// Same method as the section above, run again AFTER it: revert one condition, run the
// suite, count what goes red. Nineteen conditions in `GateSweeper`, `sweepTimeouts`,
// `#commitForOpenGate` and `RunFolder` were probed; fifteen turned exactly one test red and
// these four turned NOTHING red.
//
// Three of them are cost and memory guards, and that is why every correctness test above
// walks past them: dropping a cursor, dropping a folder, and folding a tick's own writes
// change what a tick READS, never what it writes, so an outcome assertion cannot see them
// and the thing to assert is the read. A cost claim nobody measures is a cost claim nobody
// has — the sweeper's docstring makes three of them.
//
// The fourth is not a cost guard at all, and the file was wrong about it: `#commitForOpenGate`'s
// open-gate re-read was described as a politeness that turns a doomed swap into a quiet
// `undefined`. It is that on every path whose `atSeq` is the sweep's own fold. On the one
// path that re-reads before writing it is the only thing standing between a refused default
// action and a `run.failed` on top of a human's approval.

test("A TICK FOLDS ITS OWN WRITES, so the tick after it pays nothing for them", async () => {
  const r = rig();
  const { runId, gateId } = await park(r);
  let reads = 0;
  const counting: StateStore = {
    append: (i: AppendInput) => r.store.append(i),
    read: (rid, from, to) => {
      reads++;
      return r.store.read(rid, from, to);
    },
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };
  const sweeper = new GateSweeper({ store: counting, broker: r.broker, now: () => r.clock.t });
  await sweeper.sweep();

  r.clock.t += 60_001;
  const escalating = await sweeper.sweep();
  assert.deepEqual(escalating.fired, [gateId], "the tick that moved the head");
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.tier, 1);

  reads = 0;
  const after = await sweeper.sweep();
  assert.equal(after.caughtUp, 0, "THE HEAD ITS PREDECESSOR WROTE IS ALREADY IN THE CURSOR");
  assert.equal(reads, 0, "…so the tick after an escalation costs exactly what an idle tick costs");
});

test("A RUN THAT LEAVES THE LISTING LEAVES THE CURSOR MAP, which is the memory bound", async () => {
  // `#cursors` is REPLACED by the map this tick built, never merged into. Merging keeps a
  // whole `RunProjection` for every run the listing has ever returned, so the bound stops
  // being `limit` and becomes the store's run count — growing in a background timer nobody
  // is watching. A dropped cursor is not observable as an outcome; it is observable as the
  // fold the next sighting has to pay for.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 600_000, onTimeout: "fail" }, delivery: undefined }));
  const a = await park(r);
  const b = await park(r);
  assert.notEqual(a.runId, b.runId);

  let shown: RunId[] = [];
  const listing: StateStore = {
    append: (i: AppendInput) => r.store.append(i),
    read: (rid, from, to) => r.store.read(rid, from, to),
    head: (rid) => r.store.head(rid),
    listRuns: async (limit?: number) => (await r.store.listRuns(limit)).filter((s) => shown.includes(s.runId)),
    close: () => r.store.close(),
  };
  const sweeper = new GateSweeper({ store: listing, broker: r.broker, now: () => r.clock.t });

  shown = [a.runId];
  assert.equal((await sweeper.sweep()).caughtUp, 1, "A is cold, as any run this sweeper has never met is");
  shown = [b.runId];
  assert.equal((await sweeper.sweep()).caughtUp, 1, "B is cold too, and A has fallen out of the window");
  shown = [a.runId];
  assert.equal((await sweeper.sweep()).caughtUp, 1, "A IS COLD AGAIN — its cursor did not outlive the listing");
});

test("A TERMINAL RUN'S CURSOR HOLDS NO PROJECTION, so the bound is LIVE runs", async () => {
  // Most runs in any store are finished, so a folder per listed run makes the tick's memory
  // proportional to the listing and a folder per LIVE listed run makes it proportional to
  // the runs that still have questions open. Dropping it changes no outcome — a terminal run
  // is skipped whatever its cursor holds — so what is asserted is where the next fold
  // STARTS. Seq 1 means there was nothing left to fold from.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 600_000, onTimeout: "fail" }, delivery: undefined }));
  const { runId, gateId } = await park(r);
  const seen: Seq[] = [];
  const counting: StateStore = {
    append: (i: AppendInput) => r.store.append(i),
    read: (rid, from, to) => {
      seen.push(from);
      return r.store.read(rid, from, to);
    },
    head: (rid) => r.store.head(rid),
    listRuns: (limit?: number) => r.store.listRuns(limit),
    close: () => r.store.close(),
  };
  const sweeper = new GateSweeper({ store: counting, broker: r.broker, now: () => r.clock.t });
  await sweeper.sweep();

  await r.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:sre-lead", via: "console" },
    idempotencyKey: "yes",
  });
  assert.equal((await r.engine.projection(runId))!.status, "succeeded");
  await sweeper.sweep(); // the tick that MEETS the ending, and drops what it folded

  // A terminal run's head still moves — a late task event, a cancel closing its gates, an
  // operator's rewind — and that is the tick that discovers what the cursor kept.
  const log = new RunLog(runId, { store: r.store, now: () => r.clock.t });
  await log.append([
    { type: "task.progress", payload: { chunk: "late" }, actor: { kind: "system", component: "test" } },
  ]);

  seen.length = 0;
  const report = await sweeper.sweep();
  assert.deepEqual(seen, [1 as Seq], "IT FOLDS FROM SEQ 1, because it kept nothing to fold from");
  assert.equal(report.swept, 0, "…and the run is still skipped, which is what folding it was for");
});

test("A REFUSED DEFAULT ACTION DOES NOT EXPIRE A GATE A HUMAN HAS SINCE ANSWERED", async () => {
  // A default action `rehydrate` attached and the journal never validated, so the sweep
  // meets one it cannot carry out and falls through to the expiry a gate with no usable
  // default gets. A human answering inside THAT window must still win: `gate.timeout{fail}`
  // and `run.failed` on top of an approval is a read model saying *this gate was approved
  // and the run was killed for not answering it*.
  //
  // THE WINDOW MOVED, and this test moved with it — recorded rather than quietly rewritten,
  // because which guard a test holds is the thing a later reader has to know. The refusal
  // used to be discovered by CALLING `resolve`, after `gate.timeout{default_action}` was
  // already on the record; the expiry was then taken at a seq this same call had written,
  // the store had nothing to arbitrate, and `#commitForOpenGate`'s open-gate re-read was the
  // only thing refusing it (the tick did four reads, and this test armed the fourth). The
  // decision is validated BEFORE anything is written now, so the expiry swaps at the sweep's
  // own fold like every other write here and the store refuses it as well. The outcome below
  // is what this test is for; the mechanism is named so the next reader can tell which of
  // the two they broke.
  const r = rig();
  const runId = "run_refused_default" as RunId;
  const raiseLog = new RunLog(runId, { store: r.store, now: () => r.clock.t });
  const req = {
    runId,
    taskId: "approve@root#0" as TaskId,
    nodeId: n("approve"),
    policyRef: "oversight/apply-plan@stable",
    payload: { plan: "scale api" },
    approvers: ["u:sre-lead"],
    // Journaled, so it survives into `#authorize` — and it permits nothing, which is what
    // makes the default action below unusable.
    allowEdit: [],
    slaMs: 60_000,
    onTimeout: "default_action" as const,
  };
  const gateId = await r.broker.raise(raiseLog, req);
  // `rehydrate` attaches a default action the journal never validated — `raise` would have
  // refused this one — and that is exactly why `#fireTimeout` has a refusal path at all.
  r.broker.rehydrate(gateId, { ...req, defaultAction: { kind: "edit", writes: { plan: "rewritten" } } });

  const parking = parkingStore(r.store);
  r.clock.t += 60_001;
  // Two reads now, and the second is the window: (1) the sweep's own fold, which is the seq
  // the expiry is decided at, and (2) `#commitForOpenGate`'s, taken with the expiry already
  // built and not yet written.
  const atTheWindow = parking.arm(2);
  const tick = r.broker.sweepTimeouts(
    new RunLog(runId, { store: parking.store, now: () => r.clock.t }),
    r.clock.t,
  );
  await atTheWindow;
  await r.broker.resolve(raiseLog, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:sre-lead", via: "console" },
    idempotencyKey: "yes",
  });
  parking.release();
  await tick;

  const evs = await drain(r.store, runId);
  assert.equal(evs.filter((ev) => ev.type === "run.failed").length, 0, "THE RUN A HUMAN JUST APPROVED WAS NOT KILLED");
  assert.deepEqual(
    evs.filter((ev) => ev.type === "gate.timeout").map((ev) => (ev.payload as { action: string }).action),
    [],
    "…and NO timeout row at all: an unusable default action never earned one, and the expiry it fell through to lost",
  );
  const p = (await r.broker.project(raiseLog))!;
  assert.equal(p.gates[gateId]?.state, "decided");
  assert.equal(p.gates[gateId]?.decision, "approve");
  assert.notEqual(p.status, "failed");
});

// ── the one sweep write that changed nothing ─────────────────────────────────

/**
 * A store that parks AFTER its `nth` append has landed.
 *
 * `parkingStore` parks a READ, which puts a second writer inside a sweep's decision window
 * — before it writes. This is the other half of the same question, and the half no test
 * asked: what does a second sweeper make of the journal the first one has just left BEHIND?
 * A sweep that writes twice has a state between its writes, and any state between two writes
 * is a state somebody else folds.
 */
function parkingAppends(inner: StateStore): {
  readonly store: StateStore;
  readonly arm: (nth: number) => Promise<void>;
  readonly release: () => void;
} {
  let target = 0;
  let appends = 0;
  let arrived = deferred();
  let go = deferred();
  const store: StateStore = {
    append: async (i: AppendInput) => {
      const out = await inner.append(i);
      if (target !== 0 && ++appends === target) {
        arrived.resolve();
        await go.promise;
      }
      return out;
    },
    read: (rid, from, to) => inner.read(rid, from, to),
    head: (rid) => inner.head(rid),
    listRuns: (limit?: number) => inner.listRuns(limit),
    close: () => inner.close(),
  };
  return {
    store,
    arm: (nth: number) => {
      target = nth;
      appends = 0;
      arrived = deferred();
      go = deferred();
      return arrived.promise;
    },
    release: () => go.resolve(),
  };
}

/** A gate with a pre-authorized decision and a 60s clock, raised outside any graph. */
async function parkOnDefaultAction(r: Rig, runId: RunId): Promise<{ raiseLog: RunLog; gateId: GateId }> {
  const raiseLog = new RunLog(runId, { store: r.store, now: () => r.clock.t });
  const gateId = await r.broker.raise(raiseLog, {
    runId,
    taskId: "approve@root#0" as TaskId,
    nodeId: n("approve"),
    policyRef: "oversight/apply-plan@stable",
    payload: { plan: "scale api" },
    slaMs: 60_000,
    onTimeout: "default_action",
    defaultAction: { kind: "approve" },
  });
  return { raiseLog, gateId };
}

test("A SECOND SWEEPER MEETING THE FIRST'S OWN TIMEOUT ROW DOES NOT GET A SAY OF ITS OWN", async () => {
  // THE ONE SWEEP WRITE THAT WAS NEITHER IDEMPOTENT NOR PROTECTED BY THE SWAP.
  // `gate.timeout{default_action}` is folded as a deliberate no-op — the gate stays `open`
  // and its deadline does not move — so writing it on its own, ahead of the decision it
  // licenses, left a journal on which the gate was STILL DUE. A second sweeper folding at
  // exactly that seq decided the same deadline all over again, and its compare-and-swap
  // SUCCEEDED, because the head it swapped against was the row the first sweeper had just
  // written. Same shape as the double escalation, on the one arm nobody had audited.
  //
  // The second sweeper is a FRESH broker, which is what a second process is: the
  // pre-authorized decision lives in the memory of whoever raised the gate, so the newcomer
  // has none, degrades to `fail` (the fail-closed rule) and expires. That is the outcome
  // this is really about — it is not a duplicated row, it is a run killed for not answering
  // a question its own approval was already answering.
  const r = rig();
  const runId = "run_two_sweepers" as RunId;
  const { raiseLog, gateId } = await parkOnDefaultAction(r, runId);

  const parking = parkingAppends(r.store);
  r.clock.t += 60_001;
  const written = parking.arm(1); // park once the sweep's FIRST append is durable
  const first = r.broker.sweepTimeouts(new RunLog(runId, { store: parking.store, now: () => r.clock.t }), r.clock.t);
  await written;

  // A process that never raised this gate, sweeping the journal the first one just moved.
  const newcomer = new HumanGateBroker({ now: () => r.clock.t });
  const second = await newcomer.sweepTimeouts(new RunLog(runId, { store: r.store, now: () => r.clock.t }), r.clock.t);
  parking.release();
  const firstFired = await first;

  const evs = await drain(r.store, runId);
  assert.equal(evs.filter((ev) => ev.type === "run.failed").length, 0, "THE RUN WAS NOT KILLED BY ITS OWN APPROVAL");
  assert.deepEqual(
    evs.filter((ev) => ev.type === "gate.timeout").map((ev) => (ev.payload as { action: string }).action),
    ["default_action"],
    "one deadline, one timeout row",
  );
  assert.equal(evs.filter((ev) => ev.type === "gate.decided").length, 1, "…and one decision");
  assert.deepEqual([...firstFired, ...second], [gateId], "only the sweep that wrote claims it fired");

  const p = (await r.broker.project(raiseLog))!;
  assert.equal(p.gates[gateId]?.state, "decided");
  assert.equal(p.gates[gateId]?.decision, "approve");
  assert.notEqual(p.status, "failed");
});

test("…and the row cannot be counted twice by a sweeper that DOES hold the decision", async () => {
  // The same interleave with the same broker on both sides, which is one process's own two
  // ticks overlapping. The idempotency map collapses the second `resolve`, so this one never
  // produced a second DECISION — what it produced was a second `gate.timeout{default_action}`
  // row and two ticks each reporting the gate as fired. A deadline that fires twice is a
  // deadline an operator cannot count, and it is the same defect one consequence down.
  const r = rig();
  const runId = "run_same_broker" as RunId;
  const { gateId } = await parkOnDefaultAction(r, runId);

  const parking = parkingAppends(r.store);
  r.clock.t += 60_001;
  const written = parking.arm(1);
  const first = r.broker.sweepTimeouts(new RunLog(runId, { store: parking.store, now: () => r.clock.t }), r.clock.t);
  await written;
  const second = await r.broker.sweepTimeouts(new RunLog(runId, { store: r.store, now: () => r.clock.t }), r.clock.t);
  parking.release();
  const firstFired = await first;

  const evs = await drain(r.store, runId);
  assert.equal(evs.filter((ev) => ev.type === "gate.timeout").length, 1, "ONE row for one deadline");
  assert.deepEqual([...firstFired, ...second], [gateId], "…and one tick claims it");
});

// ── what the clock leaves in the trace ───────────────────────────────────────

test("THE CLOCK'S OWN WRITES ARE VISIBLE IN THE TRACE", async () => {
  // The gate clock is new, so `gate.escalated` and `gate.timeout` had never been produced by
  // anything before it existed — and it produced them with no `taskId`. `spans.ts` skips
  // every event with no task before it reaches a single gate arm, so the whole of an SLA's
  // work was invisible: the `loom.gate` span stayed open, fell out of the end-of-journal
  // sweep with `status: "unset"` and no decision, and read exactly like a gate still waiting
  // for a human. The observability gap arrived with the feature.
  const r = rig();
  const { runId, gateId } = await park(r);

  r.clock.t += 60_001;
  await r.engine.sweepGates(); // tier 1
  r.clock.t += 900_001;
  await r.engine.sweepGates(); // tier 2
  r.clock.t += 2_700_001;
  await r.engine.sweepGates(); // the chain is exhausted: expiry

  const events = await journalOf(r.store, runId);
  const gate = spansFrom(events).find((s) => s.name === "loom.gate");
  assert.ok(gate, "no loom.gate span at all");

  // A TIMEOUT, AN ESCALATION TO TIER N, AND AN EXPIRY ARE THREE DISTINGUISHABLE THINGS.
  assert.equal(gate.status, "error");
  assert.equal(gate.attributes["gate.decision"], "timeout", "the gate closed, and says how");
  assert.equal(gate.attributes["gate.action"], "fail", "…as an expiry rather than a default action");
  assert.equal(gate.attributes["gate.escalations"], 2, "…having woken two tiers on the way");
  assert.deepEqual(
    gate.events.map((ev) => [ev.name, ev.attributes?.["tier"]]),
    [
      ["gate.escalated", 1],
      ["gate.escalated", 2],
    ],
    "the chain, in order, with who was told on each event",
  );
  assert.equal(gate.attributes["gate.id"], gateId);

  const timeoutTs = events.find((ev) => ev.type === "gate.timeout")!.ts;
  assert.equal(gate.endTime, timeoutTs, "it closed at its expiry, not at the end of the journal");
});

// ── what the compiler refuses ────────────────────────────────────────────────

function diagnose(over: GateBlock): readonly string[] {
  const out = compile({ spec: gatedSpec(over), resolver: resolver(), tools: {} });
  return out.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`);
}

test("an SLA the runtime would not run is a COMPILE error", () => {
  assert.match(
    diagnose({ sla: { respondWithinMs: 0, onTimeout: "fail" } }).join("\n"),
    /GRAPH014_SLA_INVALID.*respondWithinMs 0/s,
  );
  assert.match(
    diagnose({ sla: { respondWithinMs: 1.5, onTimeout: "fail" } }).join("\n"),
    /GRAPH014_SLA_INVALID/,
  );
  // A graph cannot pre-authorize a decision, so it cannot ask for one: `default_action`
  // would degrade to `fail` at the first sweep and nothing would say so.
  assert.match(
    diagnose({ sla: { respondWithinMs: 1000, onTimeout: "default_action" } as never }).join("\n"),
    /GRAPH014_SLA_INVALID.*default_action/s,
  );
});

test("ESCALATE WITH NOWHERE TO ESCALATE TO IS REFUSED, because it behaves as fail", () => {
  const sla = { respondWithinMs: 60_000, onTimeout: "escalate" } as const;
  const refused = /GRAPH014_SLA_INVALID.*no reachable delivery\.escalation tier/s;

  // Three spellings of the same graph, and all three had to be caught by the same check:
  // "has a reachable tier", not "declares a chain".
  assert.match(diagnose({ sla, delivery: undefined }).join("\n"), refused, "no delivery block at all");
  assert.match(
    diagnose({ sla, delivery: { channels: ["spy"], escalation: [] } }).join("\n"),
    refused,
    "a chain with no tiers",
  );
  assert.match(
    diagnose({ sla, delivery: { channels: ["spy"], escalation: [{ afterMs: 1000, action: "fail" }] } }).join("\n"),
    refused,
    "a chain whose FIRST tier is terminal — nextTier stops there, so tier 1 does not exist",
  );
});

test("A TERMINAL TIER IN THE MIDDLE OF A CHAIN IS REFUSED — the tiers after it reach nobody", () => {
  const errs = diagnose({
    sla: { respondWithinMs: 60_000, onTimeout: "escalate" },
    delivery: {
      channels: ["spy"],
      escalation: [
        { afterMs: 1000, action: "fail" },
        { afterMs: 2000, to: [DIRECTOR] },
      ],
    },
  }).join("\n");
  assert.match(errs, /GRAPH014_DELIVERY_INVALID.*can never be reached/s);
});

test("a delivery block that names nothing, or names it badly, is refused", () => {
  const base = { sla: { respondWithinMs: 60_000, onTimeout: "fail" } } as const;
  assert.match(diagnose({ ...base, delivery: { channels: [] } }).join("\n"), /GRAPH014_DELIVERY_INVALID.*channels/s);
  assert.match(
    diagnose({ ...base, delivery: { channels: ["spy"], recipients: [{ kind: "team", id: "sre" } as never] } }).join("\n"),
    /GRAPH014_DELIVERY_INVALID.*recipient/s,
  );
  assert.match(
    diagnose({ ...base, delivery: { channels: ["spy"], recipients: [{ kind: "role", id: "  " }] } }).join("\n"),
    /GRAPH014_DELIVERY_INVALID.*recipient/s,
  );
  assert.match(
    diagnose({ ...base, delivery: { channels: ["spy"], redact: [""] } }).join("\n"),
    /GRAPH014_DELIVERY_INVALID.*redact/s,
  );
  assert.match(
    diagnose({ ...base, delivery: { channels: ["spy"], redactAs: "confidential" as never } }).join("\n"),
    /GRAPH014_DELIVERY_INVALID.*redactAs/s,
  );
  assert.match(
    diagnose({
      ...base,
      delivery: { channels: ["spy"], escalation: [{ afterMs: -1, to: [MANAGER] }] },
    }).join("\n"),
    /GRAPH014_DELIVERY_INVALID.*afterMs/s,
  );
});

test("A CHAIN THAT TIGHTENS AS IT CLIMBS COMPILES, because afterMs is each tier's OWN window", () => {
  // Deliberately NOT checked, and the reason is in `checkDelivery`: `nextTier` computes a
  // tier's deadline as `now + afterMs` at the moment the previous tier breached, so
  // "15 minutes for the on-call, then 2 for the director" is a legitimate escalation.
  // Refusing it — or even warning — would be the compiler asserting a semantic the runtime
  // does not have.
  assert.deepEqual(
    diagnose({
      sla: { respondWithinMs: 60_000, onTimeout: "escalate" },
      delivery: {
        channels: ["spy"],
        escalation: [
          { afterMs: 900_000, to: [MANAGER] },
          { afterMs: 120_000, to: [DIRECTOR] },
        ],
      },
    }),
    [],
  );
});

test("an UNKNOWN CHANNEL NAME compiles, and fails loudly at delivery instead", async () => {
  // The compiler has no channel list to check against — a dispatcher is built by the
  // deployment — so inventing one would make a portable graph fail to compile in the very
  // environment that has the channel. The run-time behaviour is what makes that safe.
  assert.deepEqual(diagnose({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: { channels: ["pagerduty"] } }), []);

  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: { channels: ["pagerduty"] } }));
  const { runId, gateId } = await park(r);
  const evs = await drain(r.store, runId);
  const failed = evs.find((ev) => ev.type === "gate.delivery_failed");
  assert.ok(failed, "the failure is journaled");
  assert.match((failed.payload as { error: string }).error, /no delivery channel named "pagerduty"/);
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.state, "open", "AND DELIVERY FAILURE NEVER AUTO-APPROVES");
});

// ── reminders (D7.2) ─────────────────────────────────────────────────────────

/** The same graph, with a nudge schedule inside its own SLA. */
const REMINDING: HumanGateNode["sla"] = {
  respondWithinMs: 60_000,
  onTimeout: "escalate",
  reminders: [{ afterMs: 20_000 }, { afterMs: 40_000 }],
};

test("A REMINDER NUDGES THE SAME PEOPLE, MOVES NO CLOCK, AND FIRES ONCE", async () => {
  // THE WHOLE OF WHAT A REMINDER IS, stated as the four things it must not do. It is not an
  // escalation: same tier, same recipients, same channels, and the deadline it was measured
  // against is exactly where it was. It is journaled, because "why did nobody answer?" is
  // the question the delivery journal exists for and a nudge nobody recorded cannot be part
  // of that answer. It fires once, because the row it writes is what makes the next tick
  // ask about the NEXT entry. And it is not a deadline firing, so it is not reported as one.
  const r = rig(gatedSpec({ sla: REMINDING }));
  const { runId, gateId } = await park(r);
  const before = (await r.engine.projection(runId))!.gates[gateId]!;
  assert.equal(r.spy.seen.length, 1, "the first ask");

  // Nothing is due yet — the sweeper does not even fold the run.
  r.clock.t += 19_000;
  assert.equal((await r.engine.sweepGates(r.clock.t)).swept, 0);

  r.clock.t += 1_001; // 20_001ms after the raise
  const report = await r.engine.sweepGates(r.clock.t);
  assert.equal(report.swept, 1, "a reminder is a due-instant like any other, or the tick never wakes for it");
  assert.deepEqual(report.fired, [], "…but it is NOT a deadline firing, and must not be reported as one");

  assert.equal(r.spy.seen.length, 2, "the nudge went out");
  const nudge = r.spy.seen[1]!;
  assert.equal(nudge.tier, 0, "the same tier");
  assert.deepEqual(nudge.recipients, [ONCALL], "…and the same people who were asked first");

  const after = (await r.engine.projection(runId))!.gates[gateId]!;
  assert.equal(after.state, "open", "a nudge decides nothing");
  assert.equal(after.tier, before.tier, "and burns no tier");
  assert.equal(after.deadline, before.deadline, "AND MOVES NO DEADLINE — that is the difference from an escalation");
  assert.equal(after.remindersSent, 1, "one nudge, counted from the journal");

  const rows = (await drain(r.store, runId)).filter((ev) => ev.type === "gate.reminded");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.payload, { gateId, tier: 0, nth: 0 }, "which entry fired, and who was nudged");

  // FIRED ONCE. Ten more ticks at the same instant, and at every instant up to the next
  // entry, add nothing: the row it wrote is what makes it no longer due.
  for (let i = 0; i < 10; i++) await r.engine.sweepGates(r.clock.t);
  r.clock.t += 19_000;
  await r.engine.sweepGates(r.clock.t);
  assert.equal(r.spy.seen.length, 2, "a reminder that folded to nothing would fire on every tick forever");

  r.clock.t += 1_001; // 40_001ms
  await r.engine.sweepGates(r.clock.t);
  assert.equal(r.spy.seen.length, 3, "the second entry, in order");
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.remindersSent, 2);

  // THE SCHEDULE IS SPENT, AND THE SLA IS UNTOUCHED. Two nudges cost the approver nothing
  // in time: the deadline is still 60s from the raise, and it is the ESCALATION that moves
  // it, exactly as it would have with no reminders at all.
  r.clock.t += 20_001; // 60_002ms
  const fired = await r.engine.sweepGates(r.clock.t);
  assert.deepEqual(fired.fired, [gateId], "the SLA fires on time");
  const escalated = (await r.engine.projection(runId))!.gates[gateId]!;
  assert.equal(escalated.tier, 1);
  assert.equal(escalated.deadline, r.clock.t + 900_000, "the tier's own clock, not one the nudges extended");
  assert.equal(escalated.remindersSent, 2, "and the schedule is spent: at most `reminders.length` nudges, ever");

  r.clock.t += 900_002;
  await r.engine.sweepGates(r.clock.t);
  assert.equal(
    (await drain(r.store, runId)).filter((ev) => ev.type === "gate.reminded").length,
    2,
    "no third nudge exists to send, whatever happens to the gate afterwards",
  );
});

test("A REMINDER IS NOT SENT ONCE THE DEADLINE ITSELF IS DUE", async () => {
  // Both due in one tick — a sweeper that was down, or an interval longer than the gap. The
  // timeout wins: it moves the tier, and "still waiting?" sent in the same instant as an
  // escalation is a message about a question that has just gone to somebody else.
  const r = rig(gatedSpec({ sla: REMINDING }));
  const { runId, gateId } = await park(r);
  r.clock.t += 60_001;
  const report = await r.engine.sweepGates(r.clock.t);
  assert.deepEqual(report.fired, [gateId], "the deadline fired");

  const p = (await r.engine.projection(runId))!.gates[gateId]!;
  assert.equal(p.tier, 1);
  assert.deepEqual(
    r.spy.seen.map((s) => s.tier),
    [0, 1],
    "the first ask and the escalation — and no nudge wedged between them",
  );
  assert.equal((await drain(r.store, runId)).filter((ev) => ev.type === "gate.reminded").length, 0);
});

test("A NUDGE THE SWEEPER SLEPT THROUGH IS DROPPED, NOT DELIVERED LATE", async () => {
  // The one way a reminder can outlive the window it was written for, given that
  // `usableReminders` puts every instant strictly inside the SLA: A SWEEP THAT DID NOT
  // HAPPEN. Nothing runs the clock but the deployment, so a tick can be late by any amount
  // and one tick can find both the whole reminder schedule and the deadline due.
  //
  // The escalation wins that tick, and the backlog behind it is then DROPPED rather than
  // discharged. Three reasons, and the first is arithmetic rather than taste:
  //
  //   - every unsent instant names a moment inside `[raisedAtTs, raisedAtTs + slaMs)`, and
  //     the escalation fired at or after the END of that window — so each one is a nudge
  //     about a deadline that has already breached. `#nextReminder`'s `g.tier !== 0` is
  //     that sentence written as one comparison;
  //   - the escalation has ALREADY told the people who now hold the question, louder and
  //     with the right deadline. Nudging them again says nothing the page did not;
  //   - and discharging the backlog is the storm: a sweeper down for an hour would
  //     otherwise pay out its whole schedule one nudge per tick, at the escalated tier,
  //     immediately after the tier changed.
  //
  // The cost of dropping is that a nudge somebody was owed never arrives. That is the
  // cheaper failure by a distance, because the thing it was owed FOR — "this question is
  // still open" — was said by the escalation in the same tick.
  const r = rig(gatedSpec({ sla: REMINDING }));
  const { runId, gateId } = await park(r);

  // Nothing sweeps for 65 s: past both reminders AND past the deadline.
  r.clock.t += 65_000;
  await r.engine.sweepGates(r.clock.t);
  assert.equal((await r.engine.projection(runId))!.gates[gateId]?.tier, 1, "the deadline won that tick");
  assert.deepEqual(r.spy.seen.map((s) => s.tier), [0, 1], "and no nudge went out in it");

  // However many times it is swept afterwards, the spent window owes nothing.
  for (let i = 0; i < 5; i++) await r.engine.sweepGates(r.clock.t);
  assert.deepEqual(
    r.spy.seen.map((s) => s.tier),
    [0, 1],
    "the ask and the escalation, and not one late nudge behind them",
  );
  assert.equal(
    (await drain(r.store, runId)).filter((ev) => ev.type === "gate.reminded").length,
    0,
    "nothing was journaled as sent either — a nudge nobody got is not recorded as one",
  );
  assert.equal(
    (await r.engine.projection(runId))!.gates[gateId]?.deadline,
    r.clock.t + 900_000,
    "and the tier-1 window is the one still running",
  );
});

test("A SCHEDULE THE BROKER CANNOT RUN IS NO SCHEDULE — the fail-closed direction", async () => {
  // `usableReminders` is `usableBatching`'s reading applied to a nudge: a broker can be
  // driven directly, so every rule the compiler makes loud is re-made here quietly, and
  // "no reminders" is the outcome that costs nothing. ONE bad entry refuses the WHOLE list:
  // a schedule half applied is a schedule nobody declared.
  //
  // THE `afterMs >= slaMs` CASE NEEDS AN ESCALATION CHAIN TO BE VISIBLE AT ALL, and finding
  // that out is why this loop declares one. With `onTimeout: "fail"` a reminder past the
  // deadline can never fire whether it is refused or not — the gate expires first and the
  // sweep's timeout arm wins the tick — so the guard reads as held by a test that cannot
  // see it. With `escalate`, the gate outlives its first deadline and an unrefused entry
  // fires at the tier the question has MOVED to, which is the failure the rule is about.
  const runId = newRunId(1_700_000_000_000);
  const chain = [{ afterMs: 900_000, to: [MANAGER] }] as const;
  for (const [why, sla, reminders] of [
    ["no SLA at all — there is no deadline for a nudge to come before", undefined, [{ afterMs: 10_000 }]],
    ["an entry that is not a positive whole number of ms", 60_000, [{ afterMs: Number.NaN }]],
    ["an entry that does not come after the one before it", 60_000, [{ afterMs: 20_000 }, { afterMs: 20_000 }]],
    ["an entry at or past the SLA it was written for", 20_000, [{ afterMs: 25_000 }]],
    ["one bad entry among good ones", 60_000, [{ afterMs: 10_000 }, { afterMs: -1 }]],
    [
      "more nudges than one gate may ever send",
      60_000,
      Array.from({ length: 9 }, (_, i) => ({ afterMs: (i + 1) * 1_000 })),
    ],
  ] as const) {
    const clock = { t: 1_700_000_000_000 };
    const now = (): number => clock.t;
    const store = new MemoryStateStore({ now });
    const spy = new SpyChannel();
    const broker = new HumanGateBroker({
      now,
      dispatcher: new GateDispatcher({ channels: [spy], fallback: new ConsoleChannel() }),
    });
    const log = new RunLog(runId, { store, now });
    await broker.raise(log, {
      runId,
      taskId: "approve@root#0" as TaskId,
      nodeId: n("approve"),
      policyRef: "oversight/apply-plan@stable",
      payload: { plan: "p" },
      allowEdit: [],
      delivery: { channels: ["spy"], recipients: [ONCALL], escalation: chain },
      reminders: reminders as readonly { readonly afterMs: number }[],
      ...(sla === undefined ? {} : { slaMs: sla, onTimeout: "escalate" as const }),
    });
    assert.equal(spy.seen.length, 1, `the first ask still goes out (${why})`);

    // Every instant any of those entries could have named, and nothing is ever due for a
    // nudge — including the "one bad entry among good ones" case, whose FIRST entry is
    // perfectly legal and still does not fire, and the past-the-SLA case, whose gate has
    // escalated by then and is still open to be nudged.
    for (const t of [1_000, 10_001, 20_001, 25_001, 30_000]) {
      clock.t = 1_700_000_000_000 + t;
      await broker.sweepTimeouts(log, clock.t);
    }
    // The journal is the claim: not one nudge was owed, at any of those instants. (The spy
    // can also see an ESCALATION page in the past-the-SLA case, which is the gate's own
    // clock doing its job and not a nudge — so it is the rows that are counted here.)
    const rows = [];
    for await (const ev of store.read(runId, 1 as Seq)) if (ev.type === "gate.reminded") rows.push(ev);
    assert.deepEqual(rows, [], `no nudge was ever due (${why})`);
    assert.equal(spy.seen.filter((s) => s.tier === 0).length, 1, `and tier 0 was asked exactly once (${why})`);
  }
});

test("a nudge schedule the runtime would not run is a COMPILE error", () => {
  const withReminders = (reminders: unknown): readonly string[] =>
    diagnose({ sla: { respondWithinMs: 60_000, onTimeout: "escalate", reminders } as never });

  assert.match(withReminders({ afterMs: 10_000 }).join("\n"), /GRAPH014_SLA_INVALID.*not a list/s);
  assert.match(withReminders([{ afterMs: 0 }]).join("\n"), /GRAPH014_SLA_INVALID.*positive whole/s);
  assert.match(withReminders([{ afterMs: "20000" }]).join("\n"), /GRAPH014_SLA_INVALID.*positive whole/s);
  assert.match(
    withReminders([{ afterMs: 40_000 }, { afterMs: 20_000 }]).join("\n"),
    /GRAPH014_SLA_INVALID.*does not come after/s,
  );
  assert.match(
    withReminders([{ afterMs: 20_000 }, { afterMs: 20_000 }]).join("\n"),
    /GRAPH014_SLA_INVALID.*does not come after/s,
  );
  assert.match(
    withReminders([{ afterMs: 60_000 }]).join("\n"),
    /GRAPH014_SLA_INVALID.*not inside its own SLA/s,
    "a nudge after the deadline reaches the wrong people, or nobody",
  );
  assert.match(
    withReminders(Array.from({ length: 9 }, (_, i) => ({ afterMs: (i + 1) * 1_000 }))).join("\n"),
    /GRAPH014_SLA_INVALID.*more than the 8/s,
  );

  // The control: D7.2's own example schedule, scaled into this graph's SLA, compiles.
  assert.deepEqual(withReminders([{ afterMs: 20_000 }, { afterMs: 40_000 }]), []);
});

// ── helpers ──────────────────────────────────────────────────────────────────

function functionsFor(applied: string[]): FunctionRegistry {
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({}));
  functions.register("function/apply@stable", (view) => {
    applied.push(view.get<string>("plan") ?? "");
    return { writes: { applied: {} } };
  });
  return functions;
}

async function drain(store: StateStore, runId: RunId): Promise<readonly { type: string; payload: unknown }[]> {
  const out: { type: string; payload: unknown }[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) out.push(ev);
  return out;
}

/** The same read, keeping the events whole: a trace is a fold of these, not of `{type, payload}`. */
async function journalOf(store: StateStore, runId: RunId): Promise<readonly JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) out.push(ev);
  return out;
}

test("A GATE ON AN OLD RUN STILL HAS A CLOCK — the sweep window is gated runs, not new ones", async () => {
  // REGISTER B7. `GateSweeper` found its runs through `listRuns(limit)`, which is
  // `ORDER BY run_id DESC` over time-ordered ids — so a tick saw the `limit` most recently
  // CREATED runs and nothing older. In a live process that was survivable: a gate is raised
  // while its run is new, so the sweeper met it inside the window and kept a cursor. A PROCESS
  // RESTART threw the cursors away, and any gate whose run had since been pushed out by newer
  // runs lost its clock permanently. No escalation, no expiry — a question standing in front of
  // a human with nothing behind it, which is the one failure an oversight framework must not
  // have quietly.
  //
  // The fix is not a bigger limit. It is that the listing now orders by the most recent
  // `gate.raised`, so only runs that have EVER gated compete for the slots.
  const r = rig(gatedSpec({ sla: { respondWithinMs: 60_000, onTimeout: "fail" }, delivery: undefined }));

  // The gate is raised FIRST, on the oldest run in the store.
  const { runId, gateId } = await park(r);

  // …then three newer runs are created and finish, so under the old ordering they would fill a
  // window of three and push the gated run out of view entirely.
  const plain = compileOrThrow({ spec: gatedSpec({ sla: undefined, delivery: undefined }), resolver: resolver(), tools: {} });
  void plain;
  for (let i = 0; i < 3; i++) {
    r.clock.t += 1000;
    await r.engine.submit({ graph: r.graph, inputs: { plan: `later ${String(i)}` } });
  }

  // A FRESH SWEEPER, which is what a restart produces: no cursors, only what the listing shows.
  // `limit: 3` is smaller than the four runs now in the store, so the ordering is what decides
  // whether the gated one is visible at all.
  const sweeper = new GateSweeper({ store: r.store, broker: r.broker, now: () => r.clock.t, limit: 3 });

  r.clock.t += 120_000; // well past the 60s SLA
  const report = await sweeper.sweep();

  const p = (await r.engine.projection(runId))!;
  assert.equal(p.gates[gateId]?.state, "expired", `the SLA must have fired; report=${JSON.stringify(report)}`);

  // THE CONTROL, and without it this test passes against a sweeper that ignores `limit`
  // entirely: the bound still bounds something. Four gated runs against a limit of 3 means one
  // is out of view, and it is the one whose gate is OLDEST — which is the right one to drop,
  // because the ordering is by most recent gate.
  assert.ok(report.considered <= 3, `the limit must still bound the tick, saw ${String(report.considered)}`);
});
