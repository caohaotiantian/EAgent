/**
 * ANOTHER RUN'S DISK IS NOT AN ANSWER TO A QUESTION ABOUT THIS ONE — the five remaining sites.
 *
 * `engine-child-journal-does-not-fail-the-parent.test.ts` pins ONE cross-run child touch,
 * `#answerMirrorsTheChildAlreadyDecided`. Its residue named five more of the same shape, and this
 * file pins those five — plus F, the SEVENTH, which the five-site lane named as residue and left
 * unwrapped on scope. At least one test each, and the rest are the costs and the controls that
 * two review rounds asked to be paid rather than asserted — the guard's own printer on a hostile
 * payload, the method-vs-read decision, the bounded warning rate, a deterministic alarm's code
 * surviving the re-class, and the rewind door. Named rather than claimed total, and these are the
 * members:
 *
 *   A  `#planRollbackChild`     READ   the child's projection, and the recursive plan's own
 *                                      journal read one frame down
 *   B  `#runSubgraph`           READ   `existing = projection(childRunId)` — start or resume
 *   C  `#forwardGateDecision`   READ   `childP = projection(childRunId)` — which gate to answer
 *   D  `#resolveGateAsSystem`   WRITE  answering that gate, in the CHILD's log
 *   E  `#endChildRun`           READ + WRITE  stopping a child the parent has rejected
 *   F  `#runSubgraph`           DRIVE  `childP = advance(childRunId)` — the nested drive of the
 *                                      child's own run, wrapped later than A–E and for the same
 *                                      reason: a throw out of it was `internal`/`E_INTERNAL` on
 *                                      the PARENT
 *
 * THE TWO EXPOSURES ARE DIFFERENT, and that is why the fix is not one behaviour.
 *
 *   A escapes the verb. It runs inside `#failRun`'s compensation walk, which is OUTSIDE the
 *   `try/catch` in `#runWave` that turns a task throw into a failed task. Measured at `c54b0c2`:
 *   `advance(parent)` REJECTED with `sqlite: child disk I/O error`, out of
 *   `#planRollbackChild -> #planRollback`, mid-walk.
 *
 *   B/C/D/E do NOT escape the verb — `#runWave` catches them — but `toLoomError` classes a
 *   foreign store's rejection `internal`/`E_INTERNAL`, which is not retryable. Measured at
 *   `c54b0c2` with a single child read broken at any one of these sites:
 *   `status=failed err=E_INTERNAL/internal` on the PARENT. One transient read of another run's
 *   disk, promoted to a permanent verdict on this run and a compensation cascade over its
 *   irreversible effects.
 *
 * So A and E SWALLOW and warn — in both, the parent has already decided what it is doing and
 * reaching into the child is a courtesy — while B, C and D refuse as
 * `err.unavailable(E_SUBGRAPH_FAILED)`, the class `#runSubgraph` already uses one case earlier for
 * "the child has not finished". They cannot swallow: at B a read that failed would look like "no
 * child yet" and the parent would submit a SECOND child run over the first one's effects.
 *
 * THE FIXTURES BREAK THE STORE BY CAUSE WHERE THEY CAN AND BY COUNT WHERE THEY CANNOT, and where
 * they must count, the test ALSO asserts something only the intended site produces, so a future
 * reordering of the reads fails the test loudly instead of quietly measuring a different site.
 * That sentence was a false universal for two rounds — B and C broke the Nth read and then
 * asserted only outcomes any of the five fixes would satisfy, and C's title promised it named its
 * site while its body named nothing. It is true now because each of the three retryable sites
 * gives `LOOM_CHILD_UNREACHABLE` a DIFFERENT sentence, and B and C assert theirs: "could not read
 * the journal" is `#runSubgraph`'s probe, "could not be forwarded — reading the journal failed" is
 * `#forwardGateDecision`'s read, "answering gate … failed" is the WRITE. E asserts its own code,
 * `LOOM_CHILD_STOP_FAILED`, which one method emits.
 *
 * EVERY SUCH FILTER IS BY RUN ID AS WELL AS BY CODE. `process.emitWarning` defers to the next
 * tick, so a preceding test's warnings land inside the next listener's window — measured, twenty
 * of them at once — and an assertion reading `mine[0]` without filtering reads another run's.
 *
 * Two orders were measured on the gate fixture, and they differ because the passes do different
 * work.
 *
 *   The pass that RESUMES a child whose gate was answered in its own console:
 *     read #1  `#runSubgraph`          (B)
 *     read #2  `#forwardGateDecision`  (C)
 *     reads #3..#6  the child's OWN advance, driven by `#runSubgraph`'s `advance(childRunId)` —
 *                   site F, NOW WRAPPED. It was residue of the five-site lane on scope, not on
 *                   cancels: this paragraph said "because it would swallow a cancel" for four
 *                   rounds, and that argument is measured and dead at D's cancel-race test and
 *                   again at F's own.
 *     read #7  `#answerMirrorsTheChildAlreadyDecided` — already wrapped; warns and continues.
 *
 *   The pass that carries a REJECTION to a child whose gate was answered at another door:
 *     read #1  `#runSubgraph`          (B)
 *     read #2  `#forwardGateDecision`  (C) — finds no open target, so it writes nothing
 *     read #3  `#endChildRun`          (E)
 *
 * THE STORE FAILS ONCE, not forever, at B/C/D/E: the claim under test is that a TRANSIENT failure
 * of another run's disk costs this run a re-entry rather than its life, and a store that stayed
 * broken would fail the run either way and prove nothing about the class.
 *
 * THE STORE FAILS DURING ITERATION, not at the call, because that is how a store actually breaks:
 * `read` is an async generator and a disk error surfaces when the first row is pulled.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, err } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId, Seq } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { AppendInput, AppendResult } from "../../src/journal/store.ts";
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
const isChild = (runId: RunId): boolean => String(runId).includes("~");

/** Every warning this process emits while `body` runs, drained past `emitWarning`'s next tick. */
async function warningsWhile(body: () => Promise<void>): Promise<{ code?: string; message: string }[]> {
  const seen: { code?: string; message: string }[] = [];
  const onWarning = (w: Error & { code?: string }): void => {
    seen.push({ ...(w.code === undefined ? {} : { code: w.code }), message: w.message });
  };
  process.on("warning", onWarning);
  try {
    await body();
    await new Promise((res) => setImmediate(res));
  } finally {
    process.off("warning", onWarning);
  }
  return seen;
}

// ── Fixture 1: a parent parked on a MIRROR of its child's human gate ──────────────────────────
//
// Shared with `engine-child-journal-does-not-fail-the-parent.test.ts`.
//
// WHAT ACTUALLY RE-ENTERS THE NODE IS THE DEFERRAL, NOT THE `retry` POLICY, and an earlier version
// of this comment said the opposite. `E_SUBGRAPH_FAILED` is in `DEFERRABLE_CODES`, and
// `#retryDecision` takes the deferral arm BEFORE it consults `NodeSpec.retry` at all, so the
// refusal these three sites now raise is re-entered UNCHARGED on a 1 s curve inside a 900 s
// budget. Measured by this round's reviewer, who deleted the fixture's retry policy
// (`maxAttempts: 1`) and got 7/7 anyway, with `deferrals 1 / deferredMs 1000` on the task record.
// `compile.ts` floors a `subgraph` node with `DEFAULT_SUBGRAPH_RETRY` besides, so "a node with no
// retry policy" is not a state this fixture could reach. The policy below is kept only so the
// fixture says out loud what it relies on; it is NOT what makes the tests pass.

const GATE_TOOLS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: false },
};

const gateChild: GraphSpec = {
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

const gateParent: GraphSpec = {
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
      // Declared, not load-bearing — see the fixture comment above: the deferral arm re-enters this
      retry: { maxAttempts: 3, backoff: "fixed", initialMs: 0, jitter: false },
    },
  ],
  edges: [],
} as unknown as GraphSpec;

const gateResolver: ResourceResolver = {
  resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
  subgraph: (ref) => (ref === "graph/double@stable" ? gateChild : undefined),
};

/**
 * A store that breaks the CHILD's journal on demand — the Nth read, or the Nth append, once.
 *
 * ONE-SHOT, because the claim being measured is "a transient failure costs a retry". A store that
 * stayed broken would make the run fail either way and prove nothing about the class.
 */
class BreakableChildStore extends MemoryStateStore {
  failReadAt: number | undefined;
  failAppendAt: number | undefined;
  /** Not one-shot: the disk that does not come back, for the bounded-rate measurement. */
  failEveryChildRead = false;
  reads = 0;
  appends = 0;

  override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    if (isChild(runId)) {
      this.reads++;
      if (this.failEveryChildRead) throw new Error("sqlite: child disk I/O error");
      if (this.failReadAt === this.reads) {
        this.failReadAt = undefined;
        throw new Error("sqlite: child disk I/O error");
      }
    }
    yield* super.read(runId, fromSeq, toSeq);
  }

  override async append(input: AppendInput): Promise<AppendResult> {
    if (isChild(input.runId)) {
      this.appends++;
      if (this.failAppendAt === this.appends) {
        this.failAppendAt = undefined;
        throw new Error("sqlite: child disk I/O error");
      }
    }
    return super.append(input);
  }
}

/**
 * A clock the test moves by hand. `E_SUBGRAPH_FAILED` is a DEFERRABLE code, so the refusal these
 * three sites now raise takes the deferral arm of `#retryDecision` — which charges no attempt and
 * schedules the task 1 s out. Under a frozen clock that task is never due again and the run sits
 * `running` forever, which measures the fixture, not the fix. Moved in fixed steps, never read
 * from the host clock: no assertion here depends on real time.
 */
let clock = NOW;

function gateRig(store: BreakableChildStore) {
  clock = NOW;
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const charges: number[] = [];
  tools.register({
    ...GATE_TOOLS["pay.charge"]!,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: (args: Record<string, unknown>) => {
      charges.push(Number(args["amount"]));
      return { content: "charged", writes: { receipt: { ok: true, amount: Number(args["amount"]) } } };
    },
  } as ToolDefinition);
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now: () => clock,
    sleep: async () => {},
    resolver: gateResolver,
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });
  const graph = compileOrThrow({ spec: gateParent, resolver: gateResolver, tools: GATE_TOOLS, tenantCapabilities: ["pay"] });
  return { engine, store, charges, graph };
}

const openGate = (p: RunProjection): GateRecord | undefined => Object.values(p.gates).find((g) => g.state === "open");

/** Submit the parent and park it on the mirror of the child's first gate. */
async function parked(r: ReturnType<typeof gateRig>): Promise<{ runId: RunId; childRunId: RunId; mirror: GateRecord }> {
  const runId = await r.engine.submit({ graph: r.graph, inputs: { total: 10 } });
  let p = await r.engine.advance(runId);
  const own = Object.values(p.gates).find((g) => g.state === "open" && g.mirrorOf === undefined);
  if (own !== undefined) {
    p = await r.engine.resolveGate(runId, { gateId: own.gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:a", via: "console" }, idempotencyKey: "own" });
  }
  assert.equal(p.status, "awaiting_gate");
  const mirror = openGate(p)!;
  assert.ok(mirror.mirrorOf !== undefined, "parked on a mirror");
  return { runId, childRunId: `${runId}~delegate@root#0` as RunId, mirror };
}

/**
 * Drive the parent to a terminal state, approving every gate it parks on as the lead.
 *
 * TWO GATES, NOT ONE, on this fixture: the child's `approve` node, and then the policy gate the
 * `pay`-capability `charge` tool raises under `posture: "out"`. Both reach the parent as mirrors,
 * so the drive answers whatever is open rather than counting.
 */
async function settle(engine: Engine, runId: RunId): Promise<RunProjection> {
  let p = await engine.advance(runId);
  for (let i = 0; i < 20 && p.status !== "succeeded" && p.status !== "failed"; i++) {
    const g = openGate(p);
    clock += 10_000;
    p =
      g === undefined
        ? await engine.advance(runId)
        : await engine.resolveGate(runId, {
            gateId: g.gateId,
            decision: { kind: "approve" },
            actor: { kind: "human", subject: LEAD, via: "console" },
            idempotencyKey: `settle-${String(i)}`,
          });
  }
  return p;
}

/** The outcome of a verb as a comparable STRING, so a throw asserts instead of escaping. */
async function outcomeOf(body: () => Promise<RunProjection>): Promise<string> {
  try {
    const p = await body();
    return `${p.status}${p.error === undefined ? "" : `:${p.error.code}`}`;
  } catch (thrown) {
    return `threw: ${(thrown as Error).message}`;
  }
}

test("B · `#runSubgraph`'s START-OR-RESUME READ refuses retryably — a child store that hiccups costs the delegation a DEFERRAL, not the run", async () => {
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);

  // The human answers in the CHILD's own console, so the parent's next pass has real work.
  const childP = (await r.engine.projection(childRunId))!;
  await r.engine.resolveGate(childRunId, {
    gateId: openGate(childP)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });

  // Child read #1 of the parent's next pass is `#runSubgraph`'s `existing` probe. Once.
  r.store.reads = 0;
  r.store.failReadAt = 1;

  // NARROWED ONCE, then read plainly — so the assertions below say `p` rather than `p!`, and a
  // future edit that stops assigning it trips the `ok` rather than asserting on `undefined`.
  let settled: RunProjection | undefined;
  const seen = await warningsWhile(async () => {
    settled = await settle(r.engine, runId);
  });
  assert.ok(settled !== undefined, "the drive returned a projection");
  const p = settled;

  // THE SITE IS ASSERTED, NOT ASSUMED. Breaking the Nth read is a positional fixture, and every
  // assertion below would also pass if the failure had landed at C, D or E — a reviewer measured
  // exactly that gap in this test and in C's. Each of the three retryable sites gives
  // `LOOM_CHILD_UNREACHABLE` a DIFFERENT sentence, so the warning is what says which one refused:
  // "could not read the journal" is `#runSubgraph`'s and nobody else's.
  const mine = seen.filter((w) => w.code === "LOOM_CHILD_UNREACHABLE" && w.message.includes(String(childRunId)));
  assert.equal(mine.length, 1, `one refused read, one warning: ${JSON.stringify(seen.map((w) => w.message))}`);
  assert.match(mine[0]!.message, /could not read the journal/, `and it is #runSubgraph's own probe: ${mine[0]!.message}`);

  // AT `c54b0c2`: `failed` / `E_INTERNAL` — the parent run destroyed by one read of another run's
  // disk. The retry the graph declared was unreachable, because `internal` is not a retryable
  // class.
  assert.notEqual(p.status, "failed", `the parent must survive a transient child read: ${p.status}/${p.error?.code ?? ""} ${p.error?.message ?? ""}`);
  assert.equal(p.status, "succeeded", "and the delegation completes when the store comes back");
  assert.deepEqual(r.charges, [20], "the child's charge ran exactly once — a retry is not a second child run");
  assert.equal(r.store.failReadAt, undefined, "the fixture's one-shot failure really did fire");

  // The ordinary half: nothing else was disturbed. One child, one journal, one outcome.
  assert.deepEqual(p.outputs, { result: { ok: true, amount: 20 } });
});

test("B · A PERMANENTLY broken child store ENDS the run, and the warning rate is bounded", async () => {
  // THE OTHER HALF OF B, AND THE ONE THE ONE-SHOT FIXTURES CANNOT SHOW. Making the refusal
  // retryable buys a patient re-entry; the question that buys is "for how long, and how loud".
  // Both are claims in `childUnavailable`'s docstring, so both are measured here rather than
  // asserted there. The contrast that makes it matter: the SIBLING warning at
  // `#answerMirrorsTheChildAlreadyDecided` has no bound at all — a parent parked on a mirror is
  // re-driven by verbs rather than by a budget, so it warns once per verb forever.
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);
  const childP = (await r.engine.projection(childRunId))!;
  await r.engine.resolveGate(childRunId, {
    gateId: openGate(childP)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });

  r.store.failEveryChildRead = true;
  let outcome = "";
  let passes = 0;
  const seen = await warningsWhile(async () => {
    // THROUGH `outcomeOf`, so a base that THROWS out of the verb fails this test by ASSERTION
    // rather than by escaping it. At `c54b0c2` this loop's first pass rejects.
    for (passes = 1; passes < 60; passes++) {
      outcome = await outcomeOf(async () => r.engine.advance(runId));
      if (!outcome.startsWith("running") && !outcome.startsWith("awaiting_gate")) break;
      clock += 60_000;
    }
  });

  // IT ENDS. A retryable class is not a licence to spin: the deferral budget is spent, the
  // charged retries follow, and the run reaches a terminal state on its own.
  assert.equal(outcome, "failed:E_SUBGRAPH_FAILED", `the run terminates rather than deferring forever, and says what it could not reach: ${outcome}`);
  assert.ok(passes < 60, `it did not need the loop's own ceiling to stop: ${passes} passes`);

  // AND IT IS BOUNDED IN VOLUME, one line per refusal — an absolute bound with room, never a
  // ratio, and never an exact count that a change in the backoff curve would make a false alarm.
  // FILTERED BY RUN, not just by code. `process.emitWarning` defers to the next tick, so a
  // warning raised by the test BEFORE this one can land inside this listener's window — which is
  // exactly what an earlier version of this assertion tripped over, reading `mine[0]` and finding
  // another run's id in it.
  const mine = seen.filter((w) => w.code === "LOOM_CHILD_UNREACHABLE" && w.message.includes(String(childRunId)));
  assert.ok(mine.length >= 1, `the refusals are said out loud: ${JSON.stringify(seen.map((w) => w.code))}`);
  assert.ok(mine.length <= 40, `and stderr is not a firehose: ${mine.length} warnings over ${passes} passes`);
  assert.match(mine[0]!.message, /the delegation is deferred and the next pass will try again/);
});

test("B · A DETERMINISTIC child-journal ALARM keeps its own code, in `details.cause`", async () => {
  // THE COST OF RE-CLASSING, PAID RATHER THAN HIDDEN. Making the delegation retryable means
  // answering `E_SUBGRAPH_FAILED` whatever the child's store raised — and `projection` does not
  // only raise disk errors. It raises `E_TRACE_INCONSISTENT`, a real invariant-2 alarm, which is
  // DETERMINISTIC: deferring it re-reads the same broken journal every pass. A reviewer measured
  // that arriving at the parent with its code nowhere at all, so the code now travels in
  // `details.cause` and the parent's row still says WHICH failure it was.
  //
  // The deferral itself is left alone. It is bounded (the test above), it is not a loosening —
  // neither code is in `RUN_FATAL_CODES`, so nothing about routing changes — and refusing to
  // defer would need this function to decide which foreign failures are permanent, which is the
  // taxonomy every wrap in this file exists to avoid.
  class Inconsistent extends BreakableChildStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      // A REAL `LoomError`, built the way `#project` builds this one, not a look-alike. The engine
      // asks `isLoomError`, which proves provenance rather than shape, so a hand-assembled object
      // with the right keys is correctly NOT trusted to name a code — the first version of this
      // fixture used one and the assertion caught it.
      if (isChild(runId) && this.failEveryChildRead) {
        throw err.internal(CODES.E_TRACE_INCONSISTENT, "journal for this run is inconsistent at seq 4");
      }
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const r = gateRig(new Inconsistent({ now: () => clock }));
  const { runId, childRunId } = await parked(r);
  const childP = (await r.engine.projection(childRunId))!;
  await r.engine.resolveGate(childRunId, {
    gateId: openGate(childP)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });

  r.store.failEveryChildRead = true;
  let outcome = "";
  let p: RunProjection | undefined;
  for (let i = 0; i < 60; i++) {
    outcome = await outcomeOf(async () => {
      p = await r.engine.advance(runId);
      return p;
    });
    if (!outcome.startsWith("running") && !outcome.startsWith("awaiting_gate")) break;
    clock += 60_000;
  }

  assert.equal(outcome, "failed:E_SUBGRAPH_FAILED", `the parent's own verb still answers: ${outcome}`);
  const details = p!.error?.details as { cause?: unknown; error?: unknown } | undefined;
  assert.equal(details?.cause, "E_TRACE_INCONSISTENT", `the alarm's own code survives the re-class: ${JSON.stringify(details)}`);
  assert.match(String(details?.error), /inconsistent at seq 4/, "and so does its message");
});

test("B · A HOSTILE REJECTION does not defeat the guard that catches it — `instanceof` is trappable", async () => {
  // THE PREVIOUS LANE'S HARD-WON SHAPE, APPLIED TO THIS LANE'S NEW CODE. `describeThrown` took
  // four review rounds to become total, and the last of them was exactly this: `e instanceof
  // Error` walks `[[GetPrototypeOf]]`, which a `Proxy` traps, so a guard's own failure path could
  // fail. Round 2 of THIS lane re-opened the same hole one question over — `isLoomError(e)`, asked
  // to recover the original code and to spot a cancellation, is also an `instanceof`, and it was
  // bare. `loomCodeOf` puts both trappable operations inside a `try` whose catch does nothing.
  //
  // A `StateStore` is an extension point, so nothing forces it to reject with an `Error` at all.
  class Hostile extends BreakableChildStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      if (isChild(runId) && this.failEveryChildRead) {
        throw new Proxy({}, {
          getPrototypeOf() {
            throw new Error("hostile trap");
          },
        });
      }
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const r = gateRig(new Hostile({ now: () => clock }));
  const { runId, childRunId } = await parked(r);
  const childP = (await r.engine.projection(childRunId))!;
  await r.engine.resolveGate(childRunId, {
    gateId: openGate(childP)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });

  r.store.failEveryChildRead = true;
  const outcome = await outcomeOf(async () => r.engine.advance(runId));

  // THE OBSERVABLE IS THE CLASS, NOT A THROW, and that is the whole reason this test needed a
  // second draft. A bare `isLoomError` throwing inside the catch does NOT escape `advance` — it
  // escapes into `#runWave`'s catch one frame out, which turns it into `failed / E_INTERNAL`,
  // exactly the permanent verdict this lane exists to remove. So "the verb answered" is true at
  // both commits and proves nothing; what separates them is WHICH answer.
  //
  //   at 1b37ef2 (bare `isLoomError`)   failed:E_INTERNAL         — the guard defeated
  //   here       (`loomCodeOf`)         running                   — deferred, and it will retry
  assert.notEqual(outcome, "failed:E_INTERNAL", `a hostile rejection must not defeat the guard that catches it: ${outcome}`);
  assert.ok(!outcome.startsWith("threw"), `and it must not escape the verb either: ${outcome}`);
});

test("F · `#runSubgraph`'s NESTED `advance(childRunId)` refuses retryably — the seventh touch, and the last unwrapped one", async () => {
  // THE SITE THIS FILE'S HEADER USED TO NAME AS RESIDUE. Reads #3..#6 of the resume pass are the
  // CHILD's own drive, reached through `#runSubgraph`'s `const childP = await this.advance(...)`.
  // Measured at `d1b42ae`, one-shot failure at each read of that pass:
  //
  //     failReadAt=1  succeeded          (B, already wrapped)
  //     failReadAt=2  succeeded          (C, already wrapped)
  //     failReadAt=3  failed:E_INTERNAL/internal   charges=[]
  //     failReadAt=4  failed:E_INTERNAL/internal   charges=[]
  //     failReadAt=5  failed:E_INTERNAL/internal   charges=[]
  //     failReadAt=6  failed:E_INTERNAL/internal   charges=[]
  //     failReadAt=7  succeeded          (the already-wrapped mirror read)
  //
  // `internal` is not retryable, so one transient read of ANOTHER RUN's disk was a permanent
  // verdict on this one — and on a parent that had already run irreversible work, a compensation
  // cascade over it.
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);

  // The human answers in the CHILD's own console, so the parent's next pass really drives the
  // child rather than parking on the mirror again.
  const childP = (await r.engine.projection(childRunId))!;
  await r.engine.resolveGate(childRunId, {
    gateId: openGate(childP)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });

  r.store.reads = 0;
  r.store.failReadAt = 3;

  let settled: RunProjection | undefined;
  const seen = await warningsWhile(async () => {
    settled = await settle(r.engine, runId);
  });
  assert.ok(settled !== undefined, "the drive returned a projection");
  const p = settled;
  assert.equal(r.store.failReadAt, undefined, "the fixture's one-shot failure really did fire");

  // THE SITE IS ASSERTED, NOT ASSUMED, the way B and C had to learn to. Breaking the third read is
  // positional; the sentence is what says WHICH touch refused — "could not be advanced" is this
  // call's and nobody else's, and it is not "could not read the journal" (B's probe).
  const mine = seen.filter((w) => w.code === "LOOM_CHILD_UNREACHABLE" && w.message.includes(String(childRunId)));
  assert.equal(mine.length, 1, `one refused drive, one warning: ${JSON.stringify(mine.map((w) => w.message))}`);
  assert.match(mine[0]!.message, /could not be advanced/, `the nested drive, not the start-or-resume probe: ${mine[0]!.message}`);

  assert.notEqual(p.status, "failed", `the parent must survive a transient child read: ${p.status}/${p.error?.code ?? ""} ${p.error?.message ?? ""}`);
  assert.equal(p.status, "succeeded", "and the delegation completes when the store comes back");
  assert.deepEqual(r.charges, [20], "the child's charge ran exactly once — a re-entry is not a second child run");
  assert.deepEqual(p.outputs, { result: { ok: true, amount: 20 } });
});

test("F · THE ORDINARY HALF — a healthy child still completes, and nothing is said out loud", async () => {
  // THE HALF A BUILDER'S OWN GREEN SUITE SKIPS. A wrap that converted EVERY nested drive into a
  // refusal would still pass the test above once the store came back; what separates it from a
  // correct one is that an UNBROKEN store produces no refusal at all.
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);
  const childP = (await r.engine.projection(childRunId))!;
  await r.engine.resolveGate(childRunId, {
    gateId: openGate(childP)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });

  let settled: RunProjection | undefined;
  const seen = await warningsWhile(async () => {
    settled = await settle(r.engine, runId);
  });
  assert.ok(settled !== undefined, "the drive returned a projection");
  assert.equal(settled.status, "succeeded", `nothing was broken, so nothing is deferred: ${settled.error?.message ?? ""}`);
  assert.deepEqual(r.charges, [20], "one delegation, one charge");
  assert.deepEqual(settled.outputs, { result: { ok: true, amount: 20 } });
  const mine = seen.filter((w) => w.code === "LOOM_CHILD_UNREACHABLE" && w.message.includes(String(childRunId)));
  assert.deepEqual(mine, [], `a healthy child is not warned about: ${JSON.stringify(mine.map((w) => w.message))}`);
});

test("F · THE ORDINARY HALF — a CANCEL racing the nested drive still ends the run", async () => {
  // THE FALSE CLAIM THE ROW NAMES, DRIVEN AT THIS SITE. The argument for leaving this call
  // unwrapped was "it would swallow a cancel"; `d1b42ae`'s own comment at the D site says that
  // argument is measured and dead, but it was measured at D, not here. So it is measured here:
  // `cancel` aborts OUTSIDE the per-run drive lock, so the signal really can flip inside this
  // catch, and the answer is that the re-class cannot matter — `cancel` decides the run's status
  // by journaling `run.cancelled`, so a task deferred during a cancelled run defers into a run
  // that is already over.
  //
  // IT IS GREEN AT `d1b42ae` TOO, and that is said here rather than left for the next reader to
  // discover: it pins no behaviour this change altered, and it is not the defect pin. It is the
  // ORDINARY half — the control that says the wrap did not buy its retryability by losing an
  // operator's stop. The pin is the test three above, which is RED at `d1b42ae`.
  let engineRef: Engine | undefined;
  let parentRef: RunId | undefined;
  class CancelRacingStore extends BreakableChildStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      if (isChild(runId)) {
        this.reads++;
        if (this.failReadAt === this.reads) {
          this.failReadAt = undefined;
          await engineRef!.cancel(parentRef!, "the operator stopped it mid-delegation");
          throw new Error("sqlite: child disk I/O error");
        }
      }
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const r = gateRig(new CancelRacingStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);
  engineRef = r.engine;
  parentRef = runId;
  const childP = (await r.engine.projection(childRunId))!;
  await r.engine.resolveGate(childRunId, {
    gateId: openGate(childP)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });

  r.store.reads = 0;
  r.store.failReadAt = 3;

  const outcome = await outcomeOf(async () => settle(r.engine, runId));
  assert.equal(r.store.failReadAt, undefined, "the fixture's one-shot failure really did fire");
  assert.notEqual(outcome, "running", `a cancelled run does not keep deferring: ${outcome}`);
  const p = (await r.engine.projection(runId))!;
  assert.equal(p.status, "cancelled", `the operator's cancel is what decided this run: ${p.status}`);
  assert.deepEqual(r.charges, [], "and nothing was charged");
});

test("C · `#forwardGateDecision`'s READ refuses retryably, and names its own site", async () => {
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);
  const mirror = openGate((await r.engine.projection(runId))!)!;

  // Child read #2 of the pass that forwards the decision is `#forwardGateDecision`'s. Once.
  r.store.reads = 0;
  r.store.failReadAt = 2;

  let outcome = "";
  const seen = await warningsWhile(async () => {
    outcome = await outcomeOf(async () =>
      r.engine.resolveGate(runId, {
        gateId: mirror.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: LEAD, via: "console" },
        idempotencyKey: "mirror",
      }),
    );
  });

  // AT `c54b0c2` this is `failed:E_INTERNAL`: the human's approval landed durably on the parent
  // and the parent then died on the child's disk.
  assert.notEqual(outcome, "failed:E_INTERNAL", "a foreign store must not be a permanent verdict on this run");
  assert.equal(r.store.failReadAt, undefined, "the fixture's one-shot failure really did fire");

  // "AND NAMES ITS OWN SITE" — which this test's title promised for two rounds while its body
  // named nothing, and a reviewer said so. Breaking the SECOND read is positional; the assertion
  // that makes it a test OF THIS SITE is the sentence only `#forwardGateDecision`'s read produces.
  // FILTERED BY RUN, because `process.emitWarning` defers to the next tick and a preceding test's
  // warnings land inside this listener's window — measured, twenty of them from the permanent-store
  // test two above.
  const mine = seen.filter((w) => w.code === "LOOM_CHILD_UNREACHABLE" && w.message.includes(String(childRunId)));
  assert.equal(mine.length, 1, `one refused read, one warning: ${JSON.stringify(mine.map((w) => w.message))}`);
  assert.match(mine[0]!.message, /could not be forwarded — reading the journal failed/, `the forward's READ, not the probe and not the write: ${mine[0]!.message}`);

  const p = await settle(r.engine, runId);
  assert.equal(p.status, "succeeded", `the forward is re-entered and the delegation completes: ${p.error?.message ?? ""}`);
  assert.deepEqual(r.charges, [20], "and the human's single approval produced a single charge");
});

test("D · the cross-run WRITE — answering the child's gate — refuses retryably, and the idempotency key makes the retry safe", async () => {
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId } = await parked(r);
  const mirror = openGate((await r.engine.projection(runId))!)!;

  // The first append to the CHILD's journal during the forwarding pass is
  // `#resolveGateAsSystem`'s. Once. (The child's earlier appends were made before this line.)
  r.store.appends = 0;
  r.store.failAppendAt = 1;

  const outcome = await outcomeOf(async () =>
    r.engine.resolveGate(runId, {
      gateId: mirror.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: LEAD, via: "console" },
      idempotencyKey: "mirror",
    }),
  );
  assert.notEqual(outcome, "failed:E_INTERNAL", "a failed write to ANOTHER run's log is not a verdict on this one");
  assert.equal(r.store.failAppendAt, undefined, "the fixture's one-shot failure really did fire");

  // THE CHILD'S GATE IS STILL OPEN — the write really did not land, and nothing pretended it
  // had. That is the fail-closed half: a human can still see it and answer it.
  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childGate = openGate((await r.engine.projection(childRunId))!);
  assert.ok(childGate !== undefined, "the failed write left the child's gate open, not silently decided");

  // AND THE RUN IS RECOVERABLE, which is the whole difference from base. At `c54b0c2` the parent
  // was `failed` and gone. Here it is parked, and answering the child's gate in the CHILD's own
  // console — the door `#answerMirrorsTheChildAlreadyDecided` already serves — finishes it.
  //
  // WHY THE PARENT'S OWN RETRY DOES NOT FINISH IT, stated rather than hidden: `HumanGateBroker`
  // writes its idempotency entry BEFORE the commit and removes it only on `E_SEQ_CONFLICT`, so a
  // store failure leaves the key behind and every later redelivery of the SAME key answers
  // `{resolved:false}` about an event no journal holds. That is `gates.ts`'s, not this file's —
  // recorded as this lane's residue — and it does not make the fix wrong: base is an unrecoverable
  // failed run, this is a recoverable parked one.
  await r.engine.resolveGate(childRunId, {
    gateId: childGate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "child-own",
  });
  const done = await settle(r.engine, runId);
  assert.equal(done.status, "succeeded", `the delegation completes once the child's gate is answered: ${done.error?.message ?? ""}`);
  assert.deepEqual(r.charges, [20], "exactly one charge — nothing was decided twice");
});

test("D · A STORE THAT REJECTS WITH AN `AbortError` IS NOT THIS RUN BEING CANCELLED", async () => {
  // THE VERDICT MUST COME FROM THIS RUN'S SIGNAL, NOT FROM THE VALUE'S NAME. `toLoomError` maps
  // any `Error` whose `name` is `"AbortError"` to `E_CANCELLED` — and that is the shape ANY
  // fetch- or deadline-backed `StateStore` rejects with, Node's own `DOMException` included. So a
  // cancellation guard that asks the THROWN VALUE hands a third party the power to end a parent
  // run by choosing an error name.
  //
  // Measured across this lane's own history, on this fixture:
  //   c54b0c2 base → failed:E_CANCELLED     1b37ef2 → running
  //   fdeeb1a      → running                7f908a4 → failed:E_CANCELLED
  //
  // The middle two are the shape-narrow guard; the outer two are base and the round-3 commit that
  // widened it back. THERE IS NO GUARD AT ALL NOW — the sentence here used to describe the
  // signal-reading version and outlived it by one commit, which is the same stale-prose defect
  // this file has corrected four times. What makes this green is simply that nothing at that site
  // inspects the thrown value any more: every foreign failure is refused alike, so no error name
  // can be a verdict about this run.
  class AbortingAppendStore extends BreakableChildStore {
    override async append(input: AppendInput): Promise<AppendResult> {
      if (isChild(input.runId) && this.failAppendAt !== undefined) {
        this.appends++;
        if (this.failAppendAt === this.appends) {
          this.failAppendAt = undefined;
          // A DEADLINE INSIDE THE STORE, not a cancellation of this run. The name is the only
          // thing that made the old guard call it one.
          throw Object.assign(new Error("sqlite: internal deadline, request aborted"), { name: "AbortError" });
        }
      }
      return super.append(input);
    }
  }
  const r = gateRig(new AbortingAppendStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);
  const mirror = openGate((await r.engine.projection(runId))!)!;

  r.store.appends = 0;
  r.store.failAppendAt = 1;

  let outcome = "";
  const seen = await warningsWhile(async () => {
    outcome = await outcomeOf(async () =>
      r.engine.resolveGate(runId, {
        gateId: mirror.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: LEAD, via: "console" },
        idempotencyKey: "mirror",
      }),
    );
  });

  assert.equal(r.store.failAppendAt, undefined, "the fixture's one-shot failure really did fire");
  assert.notEqual(outcome, "failed:E_CANCELLED", `a store's error NAME must not cancel this run: ${outcome}`);
  assert.equal(outcome, "running", `it is deferred like any other foreign failure: ${outcome}`);

  // AND IT IS REPORTED AS WHAT IT IS — the WRITE site's own sentence, not a cancellation.
  const mine = seen.filter((w) => w.code === "LOOM_CHILD_UNREACHABLE" && w.message.includes(String(childRunId)));
  assert.equal(mine.length, 1, `one refused write, one warning: ${JSON.stringify(mine.map((w) => w.message))}`);
  assert.match(mine[0]!.message, /answering gate .* failed/, `the WRITE, named as itself: ${mine[0]!.message}`);
  assert.match(mine[0]!.message, /request aborted/, "carrying the store's own words");

  // The run is still THIS run's to end: nothing was cancelled, and the parent is still alive.
  const p = (await r.engine.projection(runId))!;
  assert.notEqual(p.status, "cancelled", "the parent was never cancelled");
  assert.deepEqual(r.charges, [], "and nothing was charged on the refused pass");
});

test("D · A CANCEL RACING THE FORWARD ends the run, and no re-class can change that", async () => {
  // THE TEST THAT DELETED A GUARD. Four review rounds argued that converting a foreign failure
  // into a retryable refusal could "swallow a cancel", and three of them shipped a predicate for
  // it — the argument first appears with no guard at all, in this file's own header. This
  // drives the race the argument was about — `cancel` aborts OUTSIDE the per-run drive lock, so
  // the signal really can flip inside this catch — and the answer is that the re-class cannot
  // matter: `cancel` decides the run's status by journaling `run.cancelled`, so a task deferred
  // during a cancelled run defers into a run that is already over.
  //
  // Measured: with the guard replaced by `if (false) throw e`, this test and the other thirteen
  // stay green. That is why there is no guard at that site now, and why the honest reason for
  // leaving `#runSubgraph`'s own `advance(childRunId)` unwrapped is SCOPE rather than cancels.
  //
  // It is kept as the ORDINARY HALF of that interaction: an operator's stop, landing mid-forward,
  // still ends the run and still charges nothing.
  //
  // AND IT IS GREEN AT EVERY SHA THIS LANE PRODUCED — base included — so it pins no behaviour any
  // version of this change altered. That is stated here rather than left for the next reader to
  // discover, because a test in a defect file that cannot go red is exactly the thing somebody
  // later mistakes for the pin.
  let engineRef: Engine | undefined;
  let parentRef: RunId | undefined;
  class CancelRacingStore extends BreakableChildStore {
    override async append(input: AppendInput): Promise<AppendResult> {
      if (isChild(input.runId) && this.failAppendAt !== undefined) {
        this.appends++;
        if (this.failAppendAt === this.appends) {
          this.failAppendAt = undefined;
          await engineRef!.cancel(parentRef!, "the operator stopped it mid-forward");
          throw new Error("sqlite: child disk I/O error");
        }
      }
      return super.append(input);
    }
  }
  const r = gateRig(new CancelRacingStore({ now: () => clock }));
  const { runId } = await parked(r);
  engineRef = r.engine;
  parentRef = runId;
  const mirror = openGate((await r.engine.projection(runId))!)!;

  r.store.appends = 0;
  r.store.failAppendAt = 1;

  const outcome = await outcomeOf(async () =>
    r.engine.resolveGate(runId, {
      gateId: mirror.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: LEAD, via: "console" },
      idempotencyKey: "mirror",
    }),
  );
  assert.equal(r.store.failAppendAt, undefined, "the fixture's one-shot failure really did fire");

  // THE RUN ENDS. Whatever the failure was re-classed as, a cancelled run does not go back round
  // the deferral budget — the status came from `run.cancelled`, not from the task outcome.
  assert.notEqual(outcome, "running", `a cancelled run does not keep deferring: ${outcome}`);
  const p = (await r.engine.projection(runId))!;
  assert.equal(p.status, "cancelled", `the operator's cancel is what decided this run: ${p.status}`);
  assert.deepEqual(r.charges, [], "and nothing was charged");
});

test("E · `#endChildRun` cannot overturn the human's REJECTION — it warns, and the refusal stands", async () => {
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId, childRunId } = await parked(r);

  // THE CASE `#endChildRun` EXISTS FOR: "a gate that was answered elsewhere while the parent
  // deliberated". Written straight to the broker — the door the sweeper's default action, dedupe
  // and the batch all use — so nothing forwards and the parent's mirror stays open. When the
  // parent then REJECTS, `#forwardGateDecision` finds no open target and WRITES NOTHING, so the
  // only child touch left on that pass is `#endChildRun`'s, and none of the other four sites can
  // absorb the failure this test aims at. Measured order of the child reads on that pass:
  // #1 `#runSubgraph`, #2 `#forwardGateDecision`, #3 `#endChildRun`.
  const childBefore = (await r.engine.projection(childRunId))!;
  await new HumanGateBroker({ now: () => clock }).resolve(new RunLog(childRunId, { store: r.store, now: () => clock }), {
    gateId: openGate(childBefore)!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: LEAD, via: "console" },
    idempotencyKey: "direct",
  });

  const mirror = openGate((await r.engine.projection(runId))!)!;
  assert.ok(mirror.mirrorOf !== undefined, "the mirror is still open — the direct write forwarded nothing");
  r.store.reads = 0;
  r.store.failReadAt = 3;

  let outcome = "";
  const seen = await warningsWhile(async () => {
    outcome = await outcomeOf(async () =>
      r.engine.resolveGate(runId, {
        gateId: mirror.gateId,
        decision: { kind: "reject", reason: "not this quarter's budget" },
        actor: { kind: "human", subject: LEAD, via: "console" },
        idempotencyKey: "mirror",
      }),
    );
  });

  // AT `c54b0c2`: `failed:E_INTERNAL`. The human said no, and the run recorded a disk error.
  assert.notEqual(outcome, "failed:E_INTERNAL", `the human's answer, not the child's disk, is the parent's outcome: ${outcome}`);
  assert.equal(r.store.failReadAt, undefined, "the fixture's one-shot failure really did fire");

  // THE WARNING IS THE PROOF OF SITE. `LOOM_CHILD_STOP_FAILED` is emitted from `#endChildRun` and
  // from nowhere else, so a reordering that moved the failure to one of the other four would
  // leave this list empty rather than quietly measuring a different method.
  const mine = seen.filter((w) => w.code === "LOOM_CHILD_STOP_FAILED");
  assert.equal(mine.length, 1, `one swallowed stop, one warning: ${JSON.stringify(seen)}`);
  assert.ok(mine[0]!.message.includes(String(childRunId)), `it names the child that may be left suspended: ${mine[0]!.message}`);
  assert.match(mine[0]!.message, /child disk I\/O error/);
  assert.match(mine[0]!.message, /the parent's own decision still stands/);

  // AND THE HUMAN'S ANSWER IS WHAT THE RUN RECORDS.
  const p = await settle(r.engine, runId);
  assert.equal(p.status, "failed", "a rejected delegation fails the parent — that is the ordinary outcome");
  assert.equal(p.error?.code, "E_HUMAN_APPROVAL_REQUIRED", `the refusal carries the human's own reason, not the store's: ${p.error?.code ?? ""} ${p.error?.message ?? ""}`);
  assert.match(p.error?.message ?? "", /not this quarter's budget/);
  assert.deepEqual(r.charges, [], "and nothing was charged");
});

// ── Fixture 2: a parent whose own effects must still be undone when a CHILD's journal is gone ──

interface World {
  readonly rows: number[];
  readonly undone: number[];
}

const INSERT: ToolManifestLite = {
  name: "db.insert",
  version: "1.0",
  capabilities: [],
  irreversibility: "reversible_write",
  idempotent: true,
  compensation: { tool: "db.delete" },
};
const DELETE: ToolManifestLite = { name: "db.delete", version: "1.0", capabilities: [], irreversibility: "reversible_write", idempotent: true };
const BOOM: ToolManifestLite = { name: "boom", version: "1.0", capabilities: [], irreversibility: "read_only", idempotent: true };
const COMP_TOOLS: Record<string, ToolManifestLite> = { "db.insert": INSERT, "db.delete": DELETE, boom: BOOM };

const compToolNode = (id: string, name: string, args: Record<string, unknown>, writes: string[] = ["out"]): unknown => ({
  id,
  type: "tool",
  reads: ["seed"],
  writes,
  tool: { name, version: "1.0", args },
  retry: { maxAttempts: 1 },
});

const compChild: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "child", project: "comp", version: 1 },
  policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [compToolNode("cins", "db.insert", { row: 7 })],
  edges: [],
} as unknown as GraphSpec;

const compParent: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "rollback-tree", project: "comp", version: 1 },
  policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 3, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [
    compToolNode("ins1", "db.insert", { row: 1 }),
    { id: "delegate", type: "subgraph", reads: ["seed"], writes: ["out"], subgraph: { ref: "graph/child@stable", inputs: { seed: "seed" }, outputs: { out: "out" } } },
    compToolNode("bad", "boom", {}),
  ],
  edges: [
    { id: "e1", from: "ins1", to: "delegate", kind: "seq" },
    { id: "e2", from: "delegate", to: "bad", kind: "seq" },
  ],
} as unknown as GraphSpec;

/**
 * Reads of the CHILD's journal fail from the moment `armed` is set, and stay failing.
 *
 * `skipChildReads` delays that by N child reads. It exists for one test: the wrap at A goes
 * around the METHOD rather than around its first read, and the only input that can tell the two
 * apart is a store that survives the projection read and dies on the recursive plan's journal
 * read one frame down.
 *
 * `hostileRef` is the SECOND way this store can be hostile, and it is the one that defeated the
 * first version of the guard: instead of rejecting, it answers the PARENT's read normally but
 * rewrites the `ref` inside `subgraph.started` to a value that cannot be coerced to a string. A
 * `StateStore` is an extension point, so nothing forces the payload it hands back to hold the
 * bytes that were written — and the guard's failure path prints that payload.
 */
class ChildJournalGone extends MemoryStateStore {
  armed = false;
  hostileRef = false;
  skipChildReads = 0;
  override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    if (this.armed && isChild(runId)) {
      if (this.skipChildReads > 0) this.skipChildReads--;
      else throw new Error("sqlite: child disk I/O error");
    }
    for await (const ev of super.read(runId, fromSeq, toSeq)) {
      if (this.hostileRef && ev.type === "subgraph.started") {
        yield { ...ev, payload: { ...ev.payload, ref: Object.create(null) as string } } as JournalEvent;
        continue;
      }
      yield ev;
    }
  }
}

/** `ins1 → delegate`, with no failing node: a run that SUCCEEDS and is then rewound. */
const compParentOk: GraphSpec = {
  ...(compParent as unknown as Record<string, unknown>),
  metadata: { name: "rewindable-tree", project: "comp", version: 1 },
  nodes: [
    compToolNode("ins1", "db.insert", { row: 1 }),
    { id: "delegate", type: "subgraph", reads: ["seed"], writes: ["out"], subgraph: { ref: "graph/child@stable", inputs: { seed: "seed" }, outputs: { out: "out" } } },
  ],
  edges: [{ id: "e1", from: "ins1", to: "delegate", kind: "seq" }],
} as unknown as GraphSpec;

function compRig(opts: { breakChildOnBoom?: boolean; spec?: GraphSpec } = {}): { engine: Engine; world: World; store: ChildJournalGone; graph: ReturnType<typeof compileOrThrow> } {
  const breakChildOnBoom = opts.breakChildOnBoom ?? true;
  const world: World = { rows: [], undone: [] };
  const tools = new ToolRegistry();
  const store = new ChildJournalGone({ now: () => NOW });
  tools.register({
    ...INSERT,
    description: "insert a row",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.rows.push(row);
      return { content: `inserted ${String(row)}`, details: { row }, writes: { out: { row } } };
    },
  } as ToolDefinition);
  tools.register({
    ...DELETE,
    description: "the compensation for db.insert",
    parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
    execute: (args) => {
      const row = Number(args["row"]);
      world.undone.push(row);
      const at = world.rows.indexOf(row);
      if (at >= 0) world.rows.splice(at, 1);
      return { content: `deleted ${String(row)}` };
    },
  } as ToolDefinition);
  tools.register({
    ...BOOM,
    description: "always fails, and takes the child's journal with it",
    parameters: { type: "object" },
    execute: () => {
      // THE STORE BREAKS AT THE MOMENT THE RUN STARTS FAILING, which is the window this defect
      // lives in: the child has already done its work, and the walk that would undo it is what
      // cannot read the journal.
      store.armed = breakChildOnBoom;
      throw Object.assign(new Error("boom"), { code: "E_PROVIDER_UNAVAILABLE", class: "unavailable", retryable: false });
    },
  } as ToolDefinition);

  const resolver: ResourceResolver = {
    resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
    subgraph: (ref) => (ref === "graph/child@stable" ? compChild : undefined),
  };
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    sleep: async () => {},
    resolver,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, world, store, graph: compileOrThrow({ spec: opts.spec ?? compParent, resolver, tools: COMP_TOOLS, tenantCapabilities: [] }) };
}

test("A · `#planRollbackChild` — an unreadable CHILD no longer aborts the PARENT's own rollback, and `advance` still answers", async () => {
  const r = compRig();
  const runId = await r.engine.submit({ graph: r.graph, inputs: { seed: "x" } });

  let outcome = "";
  const seen = await warningsWhile(async () => {
    for (let i = 0; i < 20; i++) {
      outcome = await outcomeOf(async () => r.engine.advance(runId));
      if (outcome.startsWith("succeeded") || outcome.startsWith("failed") || outcome.startsWith("threw")) break;
    }
  });

  // AT `c54b0c2` this is `threw: sqlite: child disk I/O error`, out of
  // `#planRollbackChild -> #planRollback`, with the parent's own `db.delete` never dispatched.
  assert.equal(outcome, "failed:E_TOOL_SOURCE_UNAVAILABLE", `the verb ANSWERS, with the run’s OWN failure: ${outcome}`);

  // THE POINT OF THE FIX, and the reason `[]` is the closed answer rather than a rethrow: the
  // parent's own undo still ran. The child's row stands, which is honest — nothing could read
  // its journal — and the warning is what says so.
  assert.deepEqual(r.world.undone, [1], `the parent's own row was undone: ${JSON.stringify(r.world)}`);
  assert.deepEqual(r.world.rows, [7], "and only the unreadable child's row stands");

  const mine = seen.filter((w) => w.code === "LOOM_ROLLBACK_CHILD_UNREADABLE");
  assert.ok(mine.length >= 1, `the refusal is said out loud: ${JSON.stringify(seen)}`);
  assert.match(mine[0]!.message, /child disk I\/O error/);
  assert.match(mine[0]!.message, /graph\/child@stable/);
  assert.match(mine[0]!.message, /a later rewind will try again/);
});

test("A · THE ORDINARY HALF — with the child's journal readable, the whole tree is still undone", async () => {
  // The control that makes the test above mean something: the same graph, the same failing node,
  // and the ONLY difference is that `boom` does not take the child's journal down with it.
  const r = compRig({ breakChildOnBoom: false });
  const runId = await r.engine.submit({ graph: r.graph, inputs: { seed: "x" } });

  let outcome = "";
  for (let i = 0; i < 20; i++) {
    outcome = await outcomeOf(async () => r.engine.advance(runId));
    if (outcome.startsWith("succeeded") || outcome.startsWith("failed") || outcome.startsWith("threw")) break;
  }
  assert.equal(outcome, "failed:E_TOOL_SOURCE_UNAVAILABLE");
  assert.deepEqual(r.world.rows, [], "every row in the tree is gone when nothing is broken");
  assert.deepEqual(new Set(r.world.undone), new Set([1, 7]), `the child's row too: ${JSON.stringify(r.world.undone)}`);
});

test("A · AROUND THE METHOD, NOT AROUND THE READ — the SECOND throwing read is the input that tells them apart", async () => {
  // THE DIFF'S MAIN DECISION, PINNED RATHER THAN ARGUED. `#planRollbackChild` wraps the whole
  // body because the body has TWO reads that can throw: `projection(child.runId)`, and the
  // recursive `#planRollback`'s own `log.read` over the child's journal one frame down. A
  // reviewer built the narrow alternative — wrap only the projection read — and it passed every
  // other test in this file, because those fixtures break the store before the FIRST read. The
  // shape below is the only one that separates them, and it was measured on both:
  //
  //   SHIPPED (method-wide)  failed:E_TOOL_SOURCE_UNAVAILABLE   rows [7]     undone [1]
  //   NARROW  (read only)    threw: sqlite: child disk I/O error rows [1,7]  undone []
  //
  // An untested decision is a decision the next refactor deletes for free; this is the test that
  // costs it something.
  const r = compRig();
  const runId = await r.engine.submit({ graph: r.graph, inputs: { seed: "x" } });
  r.store.skipChildReads = 1;

  let outcome = "";
  const seen = await warningsWhile(async () => {
    for (let i = 0; i < 20; i++) {
      outcome = await outcomeOf(async () => r.engine.advance(runId));
      if (outcome.startsWith("succeeded") || outcome.startsWith("failed") || outcome.startsWith("threw")) break;
    }
  });

  assert.equal(r.store.skipChildReads, 0, "the fixture really did let the first child read through");
  assert.equal(outcome, "failed:E_TOOL_SOURCE_UNAVAILABLE", `the verb answers when the SECOND read is the one that dies: ${outcome}`);
  assert.deepEqual(r.world.undone, [1], `and the parent's own undo still ran: ${JSON.stringify(r.world)}`);
  assert.ok(
    seen.some((w) => w.code === "LOOM_ROLLBACK_CHILD_UNREADABLE"),
    `the refusal is said out loud from the deeper read too: ${JSON.stringify(seen)}`,
  );
});

test("A · THE GUARD'S OWN FAILURE PATH PRINTS STORE-SUPPLIED VALUES, and they are described rather than coerced", async () => {
  // FOUND BY REVIEW, ON THE FIRST VERSION OF THIS LANE'S OWN WRAP. The catch ran `describeThrown`
  // on the rejection and then coerced `child.runId` and `child.ref` raw — two values read out of
  // `subgraph.started.payload`, i.e. out of the same third-party store the guard exists to
  // survive. A store answering `ref: Object.create(null)` therefore killed the guard through the
  // template literal instead of through the `catch`, and `advance(parent)` threw
  // `Cannot convert object to primitive value` with the parent's own undo never dispatched —
  // byte for byte the outcome the wrap was written to remove.
  //
  // THE SHAPE IS CHOSEN BY OPERATION, not by example: `Object.create(null)` is the one value that
  // defeats BOTH doors at once — the template literal's implicit `ToString` and `JSON.stringify`'s
  // treatment of the `detail` — which is why one shape suffices for two lines.
  const r = compRig();
  const runId = await r.engine.submit({ graph: r.graph, inputs: { seed: "x" } });
  r.store.hostileRef = true;

  let outcome = "";
  const seen = await warningsWhile(async () => {
    for (let i = 0; i < 20; i++) {
      outcome = await outcomeOf(async () => r.engine.advance(runId));
      if (outcome.startsWith("succeeded") || outcome.startsWith("failed") || outcome.startsWith("threw")) break;
    }
  });

  assert.equal(outcome, "failed:E_TOOL_SOURCE_UNAVAILABLE", `the verb still ANSWERS on a hostile payload: ${outcome}`);
  assert.deepEqual(r.world.undone, [1], `and the parent's own undo still ran: ${JSON.stringify(r.world)}`);

  // The warning is still emitted, and it says the id and the ref could not be described rather
  // than inventing a value for them.
  const mine = seen.filter((w) => w.code === "LOOM_ROLLBACK_CHILD_UNREADABLE");
  assert.ok(mine.length >= 1, `the refusal is still said out loud: ${JSON.stringify(seen)}`);
  assert.match(mine[0]!.message, /undescribable object/, `the unprintable ref is named, not coerced: ${mine[0]!.message}`);
});

test("A · WHICH VERBS REACH IT — the rewind door refuses EARLIER, at a SIXTH cross-run read, and this diff did not open it", async () => {
  // WHICH VERBS REACH THE GUARD, ASKED RATHER THAN ASSUMED — and the answer was not the one the
  // wrap's own docstring first claimed. `#planRollbackChild` sits under two doors: `#failRun` →
  // `#compensate` (the test above, through `advance`) and `#rewindPlanOf`, which `rewind` and
  // `planRewind` share. Driven here, the second door does NOT reach it while the child is
  // unreadable, because `#rewindRefusals` runs first and `#uncompensatedIrreversible` — which
  // follows `subgraph.started` into the CHILD's journal — throws before the walk is ever planned:
  //
  //   at ChildJournalGone.read -> #uncompensatedIrreversible (recursing into itself)
  //      -> #rewindRefusals -> Engine.planRewind
  //
  // METHOD NAMES, NOT LINE NUMBERS. This paragraph carried four line citations and a reviewer
  // found all four stale by eight lines, shifted by the very commit that wrote them — the third
  // time this file's neighbourhood has shipped that. A line number in a comment is a claim with a
  // shelf life of one commit; a method name has survived every commit in this lane.
  //
  // THAT IS A SIXTH SITE OF THE SAME SHAPE AND IT IS DELIBERATELY LEFT ALONE. It is a REFUSAL
  // guard — it decides whether a rewind may proceed past an irreversible effect a child
  // performed — so its undecidable case must fail CLOSED, and throwing already does. Wrapping it
  // the way A and E are wrapped would answer "no uncompensated irreversible effect down there"
  // about a journal nobody read, which is the loosening CLAUDE.md's first lens names. What is
  // wrong with it is only the ATTRIBUTION — the operator sees a raw store error rather than this
  // engine's own refusal — and that is recorded as this lane's residue, not fixed here.
  //
  // So this test is a CONTROL, green at `c54b0c2` and green now: it pins that the new `[]` did
  // not turn the rewind door into a preview of a plan nobody could read.
  const r = compRig({ spec: compParentOk });
  const runId = await r.engine.submit({ graph: r.graph, inputs: { seed: "x" } });
  for (let i = 0; i < 20; i++) {
    const p = await r.engine.advance(runId);
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  assert.deepEqual(r.world.rows, [1, 7], "both rows were inserted and nothing has been undone yet");

  const lead = { kind: "human", subject: LEAD, via: "console" } as const;
  const before = await r.engine.planRewind(runId, 1 as Seq, lead);
  assert.ok(
    before.steps.some((s) => s.runId !== String(runId)),
    `the healthy preview shows the CHILD's step: ${JSON.stringify(before.steps.map((s) => `${s.runId}:${s.tool}`))}`,
  );

  r.store.armed = true;
  let after: Awaited<ReturnType<Engine["planRewind"]>> | undefined;
  let threw = "";
  try {
    after = await r.engine.planRewind(runId, 1 as Seq, lead);
  } catch (thrown) {
    threw = `threw: ${(thrown as Error).message}`;
  }

  // REFUSING IS THE RIGHT ANSWER HERE, and the one thing that would be wrong is a plan that
  // silently omits the child's irreversible step and lets an operator authorise it.
  assert.equal(threw, "threw: sqlite: child disk I/O error", `the rewind door refuses on an unreadable child: ${threw}`);
  assert.equal(after, undefined, "and it produced no plan for a human to authorise");
});
