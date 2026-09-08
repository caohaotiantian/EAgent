/**
 * ANOTHER RUN'S DISK IS NOT AN ANSWER TO A QUESTION ABOUT THIS ONE — the five remaining sites.
 *
 * `engine-child-journal-does-not-fail-the-parent.test.ts` pins ONE cross-run child touch,
 * `#answerMirrorsTheChildAlreadyDecided`. Its residue named five more of the same shape, and this
 * file pins those five — one test each, plus one control for A. Named rather than claimed total,
 * and these are the members:
 *
 *   A  `#planRollbackChild`     READ   the child's projection, and the recursive plan's own
 *                                      journal read one frame down
 *   B  `#runSubgraph`           READ   `existing = projection(childRunId)` — start or resume
 *   C  `#forwardGateDecision`   READ   `childP = projection(childRunId)` — which gate to answer
 *   D  `#resolveGateAsSystem`   WRITE  answering that gate, in the CHILD's log
 *   E  `#endChildRun`           READ + WRITE  stopping a child the parent has rejected
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
 * they must count, the test ALSO asserts something only the intended site produces — a warning
 * code emitted from one method, or an error only one path can raise — so a future reordering of
 * the reads fails the test loudly instead of quietly measuring a different site. Two orders were
 * measured on the gate fixture, and they differ because the two passes do different work.
 *
 *   The pass that RESUMES a child whose gate was answered in its own console:
 *     read #1  `#runSubgraph`          (B)
 *     read #2  `#forwardGateDecision`  (C)
 *     reads #3..#6  the child's OWN advance, driven by `#runSubgraph`'s `advance(childRunId)` —
 *                   NOT wrapped, deliberately: that call's throw can be the PARENT's own
 *                   cancellation travelling out of a nested drive, and turning a cancel into a
 *                   retry is loosening. This lane's recorded residue.
 *     read #7  `#answerMirrorsTheChildAlreadyDecided` — already wrapped; warns and continues.
 *
 *   The pass that carries a REJECTION to a child whose gate was answered at another door:
 *     read #1  `#runSubgraph`          (B)
 *     read #2  `#forwardGateDecision`  (C) — finds no open target, so it writes nothing
 *     read #3  `#endChildRun`          (E)
 *
 * THE STORE FAILS ONCE, not forever, at B/C/D/E: the claim under test is that a TRANSIENT failure
 * of another run's disk costs this run a retry rather than its life, and a store that stayed
 * broken would fail the run either way and prove nothing about the class.
 *
 * THE STORE FAILS DURING ITERATION, not at the call, because that is how a store actually breaks:
 * `read` is an async generator and a disk error surfaces when the first row is pulled.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
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
// Shared with `engine-child-journal-does-not-fail-the-parent.test.ts`, with one addition: the
// `delegate` node carries a `retry` policy. That is what makes B, C and D's fix OBSERVABLE rather
// than merely differently-coded — a retryable class only means anything where the graph declared
// a retry, and the honest claim is "the delegation costs a retry", not "the class changed".

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
      // Fixed, zero-length, no jitter: the retry is a fact about the graph, not about a clock.
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
  reads = 0;
  appends = 0;

  override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    if (isChild(runId)) {
      this.reads++;
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

test("B · `#runSubgraph`'s START-OR-RESUME READ refuses retryably — a child store that hiccups costs the delegation a RETRY, not the run", async () => {
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

  const p = await settle(r.engine, runId);

  // AT `c54b0c2`: `failed` / `E_INTERNAL` — the parent run destroyed by one read of another run's
  // disk. The retry the graph declared was unreachable, because `internal` is not a retryable
  // class.
  assert.notEqual(p.status, "failed", `the parent must survive a transient child read: ${p.status}/${p.error?.code ?? ""} ${p.error?.message ?? ""}`);
  assert.equal(p.status, "succeeded", "and the delegation completes on the retry");
  assert.deepEqual(r.charges, [20], "the child's charge ran exactly once — a retry is not a second child run");
  assert.equal(r.store.failReadAt, undefined, "the fixture's one-shot failure really did fire");

  // The ordinary half: nothing else was disturbed. One child, one journal, one outcome.
  assert.deepEqual(p.outputs, { result: { ok: true, amount: 20 } });
});

test("C · `#forwardGateDecision`'s READ refuses retryably, and names its own site", async () => {
  const r = gateRig(new BreakableChildStore({ now: () => clock }));
  const { runId } = await parked(r);
  const mirror = openGate((await r.engine.projection(runId))!)!;

  // Child read #2 of the pass that forwards the decision is `#forwardGateDecision`'s. Once.
  r.store.reads = 0;
  r.store.failReadAt = 2;

  const outcome = await outcomeOf(async () =>
    r.engine.resolveGate(runId, {
      gateId: mirror.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: LEAD, via: "console" },
      idempotencyKey: "mirror",
    }),
  );

  // AT `c54b0c2` this is `failed:E_INTERNAL`: the human's approval landed durably on the parent
  // and the parent then died on the child's disk.
  assert.notEqual(outcome, "failed:E_INTERNAL", "a foreign store must not be a permanent verdict on this run");
  assert.equal(r.store.failReadAt, undefined, "the fixture's one-shot failure really did fire");

  const p = await settle(r.engine, runId);
  assert.equal(p.status, "succeeded", `the forward is retried and the delegation completes: ${p.error?.message ?? ""}`);
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

/** Reads of the CHILD's journal fail from the moment `armed` is set, and stay failing. */
class ChildJournalGone extends MemoryStateStore {
  armed = false;
  override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
    if (this.armed && isChild(runId)) throw new Error("sqlite: child disk I/O error");
    yield* super.read(runId, fromSeq, toSeq);
  }
}

function compRig(opts: { breakChildOnBoom?: boolean } = {}): { engine: Engine; world: World; store: ChildJournalGone; graph: ReturnType<typeof compileOrThrow> } {
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
  return { engine, world, store, graph: compileOrThrow({ spec: compParent, resolver, tools: COMP_TOOLS, tenantCapabilities: [] }) };
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
