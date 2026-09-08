/**
 * A broken CHILD journal does not fail the PARENT's `advance`.
 *
 * `#answerMirrorsTheChildAlreadyDecided` runs inside the parent's `for(;;)` drive loop and reads
 * the CHILD's journal to see whether the gate a mirror stands for has already been decided. That
 * read was unwrapped, so a child whose store cannot be read came back as the answer to `advance`
 * on the PARENT: measured at `3d05cff`, `PARENT ADVANCE OUTCOME: threw:sqlite: child disk I/O
 * error`. It is round 4's `#forwardToParentMirrorsQuietly` defect one direction over, and the
 * argument is the same one with the roles swapped — refusing to ANSWER A MIRROR is always allowed,
 * refusing to answer the caller's question is not.
 *
 * ONE READ, AND THE SET IS NAMED — FOUR OTHERS, and `advance` is still exposed through two of
 * them. Line numbers are as of this commit: `#planRollbackChild` (`engine.ts:1785`),
 * `#runSubgraph` (`7532`), `#forwardGateDecision` (`7784`) and `#endChildRun` (`7806`) all read a
 * CHILD's journal unwrapped. Measured on this file's own fixture at the commit that narrowed this
 * paragraph — park on the mirror, approve the CHILD's gate, break the child store, then
 * `advance(parent)`:
 *
 *   PARENT ADVANCE OUTCOME AFTER CHILD DECIDED: threw:sqlite: child disk I/O error
 *       at #planRollbackChild -> #planRollback -> #compensate
 *
 * So this file's first test pins the mirror-answer read on the advance path and NOT `advance` in
 * general; an earlier version of this paragraph said those reads were reachable only from
 * `resolveGate`, and that was false. They are the next round's, not this one's — this lane was
 * authorised for the mirror-answer read — and the point of naming all four with a measurement is
 * that the next reader does not have to rediscover them.
 *
 * FAIL CLOSED HERE MEANS THE MIRROR STAYS OPEN: never approved, never marked, so a human can still
 * see it and the next pass tries again. The fixture is `engine-lane-mirror-follows-the-child.test.ts`'s,
 * deliberately — that file pins the ORDINARY half of this behaviour, and the last assertion here
 * shows the refusal cost nothing once the child's store comes back.
 *
 * THE DOUBLE FAILS DURING ITERATION, not at the call, because that is how a store actually breaks:
 * `read` is an async generator and a disk error surfaces when the first row is pulled.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId, Seq } from "../../src/ids.ts";
import type { Actor, JournalEvent } from "../../src/journal/events.ts";
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

function rig(store: MemoryStateStore) {
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const charges: number[] = [];
  tools.register({
    ...TOOLS["pay.charge"]!,
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
  const own = Object.values(p.gates).find((g) => g.state === "open" && g.mirrorOf === undefined);
  if (own !== undefined) {
    p = await r.engine.resolveGate(runId, { gateId: own.gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:a", via: "console" }, idempotencyKey: "own" });
  }
  assert.equal(p.status, "awaiting_gate");
  const mirror = open(p)!;
  assert.ok(mirror.mirrorOf !== undefined, "parked on a mirror");
  const childRunId = `${runId}~delegate@root#0` as RunId;
  return { runId, childRunId, mirror };
}

test("THE MIRROR-ANSWER READ REFUSES A BROKEN CHILD JOURNAL INSTEAD OF PROPAGATING IT — the parent's `advance` survives THIS read", async () => {
  // THE TITLE NAMES ONE READ, and it took three review rounds to stop it naming a verb. "A broken
  // child journal never fails the parent's `advance`" is FALSE at this commit — `advance` still
  // dies one step later at `#planRollbackChild`, and the file header pastes that stack. The title
  // is the one string CI prints, so a universal in it is a false claim shipped by default. This
  // lane was authorised for the mirror-answer read; the title now says exactly that.
  let breakChild = false;
  class BrokenChildReads extends MemoryStateStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      if (breakChild && String(runId).includes("~")) throw new Error("sqlite: child disk I/O error");
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const warnings: { code?: string; message: string }[] = [];
  const onWarning = (w: Error & { code?: string }): void => {
    warnings.push({ ...(w.code === undefined ? {} : { code: w.code }), message: w.message });
  };
  process.on("warning", onWarning);
  try {
    const r = rig(new BrokenChildReads({ now: () => NOW }));
    const { runId, childRunId, mirror } = await parked(r);

    breakChild = true;
    // The parent's own verb, about the parent's own run. At `3d05cff` this threw
    // `sqlite: child disk I/O error`.
    const p = await r.engine.advance(runId);
    assert.equal(p.status, "awaiting_gate", "the parent answered its own question while the child's store was down");

    // FAIL CLOSED: the mirror is left in the one state a human can see and act on.
    assert.equal(p.gates[mirror.gateId]?.state, "open", "never approved on a child this pass could not read");
    assert.equal(p.gates[mirror.gateId]?.decision, undefined);

    // `process.emitWarning` defers to the next tick, so drain before reading the listener.
    await new Promise((res) => setImmediate(res));
    const mine = warnings.filter((w) => w.code === "LOOM_MIRROR_ANSWER_FAILED");
    assert.equal(mine.length, 1, `one open mirror, one pass, one warning: ${JSON.stringify(warnings)}`);
    assert.ok(mine[0]!.message.includes(String(runId)), `it names the run whose pass refused: ${mine[0]!.message}`);
    assert.ok(mine[0]!.message.includes(String(childRunId)), `and the child whose journal is broken: ${mine[0]!.message}`);
    assert.match(mine[0]!.message, /child disk I\/O error/);
    assert.match(mine[0]!.message, /mirror stays open/);

    // The ordinary half: nothing was lost by refusing. The child's store comes back, the human
    // answers in the child's console, and the mirror is decided exactly as
    // `engine-lane-mirror-follows-the-child.test.ts` pins it.
    breakChild = false;
    const childGate = open((await r.engine.projection(childRunId))!)!;
    assert.equal(mirror.mirrorOf, childGate.gateId);
    await r.engine.resolveGate(childRunId, { gateId: childGate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "c1" });
    assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "decided", "the refusal cost nothing");
  } finally {
    process.off("warning", onWarning);
  }
});

test("THE REFUSAL IS NOT STICKY — a pass that could not read the child reads again on the next one", async () => {
  // The parent-side half answers a mirror whose child gate is ALREADY decided, and the method
  // returns whether it wrote so the drive loop can restart on a fresh projection. Wrapping the
  // whole method would have to answer `false` on any failure — a partial write reported as none,
  // and the loop carrying on from a projection the journal no longer matches. So the refusal is
  // scoped to the one mirror whose child could not be read.
  //
  // ONE ENGINE, TWO CHILDREN is not a shape this fixture can build (one subgraph node, one child),
  // so the sibling half of D1 is argued and not pinned. What IS pinned here is the fact the retry
  // rests on: a failed read records nothing anywhere, so the next pass genuinely re-reads rather
  // than short-circuiting on a memo. (`mirrorsChecked` is NOT that memo — it belongs to
  // `#forwardToParentMirrors`, the other direction, and this method is never passed it.)
  let breakChild = false;
  let reads = 0;
  class BrokenChildReads extends MemoryStateStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      if (breakChild && String(runId).includes("~")) {
        reads++;
        throw new Error("sqlite: child disk I/O error");
      }
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const r = rig(new BrokenChildReads({ now: () => NOW }));
  const { runId, mirror } = await parked(r);

  breakChild = true;
  assert.equal((await r.engine.advance(runId)).status, "awaiting_gate");
  assert.equal((await r.engine.advance(runId)).status, "awaiting_gate", "and again — the refusal is not sticky");
  assert.ok(reads >= 2, `each pass genuinely re-read the child: ${String(reads)}`);
  assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "open");
});

/**
 * Three shapes a hostile `StateStore` can reject with that a description idiom does not survive.
 *
 * `Object.create(null)` breaks `String(e)`; an `Error` subclass whose `message` GETTER throws and
 * an `Error` whose `message` is a null-prototype object both pass `instanceof Error` and break
 * `e.message` — the second reproducing the first fix's own symptom, `Cannot convert object to
 * primitive value`, one branch over. All three are driven through `Engine.advance` rather than
 * through the helper, because the claim is about the verb.
 */
const HOSTILE_THROWS: readonly { readonly what: string; readonly make: () => unknown }[] = [
  { what: "an object with no prototype", make: () => Object.create(null) },
  {
    what: "an Error whose message getter throws",
    make: () => {
      class Nasty extends Error {
        override get message(): string {
          throw new Error("the getter itself throws");
        }
      }
      return new Nasty();
    },
  },
  {
    what: "an Error whose message is a null-prototype object",
    make: () => {
      const bad = new Error("x");
      Object.defineProperty(bad, "message", { value: Object.create(null) });
      return bad;
    },
  },
];

test("A CHILD STORE THAT REJECTS WITH SOMETHING UNDESCRIBABLE IS STILL SWALLOWED — the guard's own failure path cannot throw", async () => {
  // `StateStore` is an extension point (README's twelve rows), so nothing forces a third-party
  // store to reject with an `Error`. `String(e)` on an object with a null prototype throws inside
  // the catch, and the exception escapes `advance` — the guard producing the outcome the guard
  // exists to prevent. Measured before this was fixed:
  // `PARENT ADVANCE OUTCOME (non-Error child failure): threw:Cannot convert object to primitive value`.
  let breakChild = false;
  let thrown: () => unknown = () => new Error("unset");
  class HostileChildReads extends MemoryStateStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      if (breakChild && String(runId).includes("~")) throw thrown() as Error;
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const warnings: { code?: string; message: string }[] = [];
  const onWarning = (w: Error & { code?: string }): void => {
    warnings.push({ ...(w.code === undefined ? {} : { code: w.code }), message: w.message });
  };
  process.on("warning", onWarning);
  try {
    for (const shape of HOSTILE_THROWS) {
      thrown = shape.make;
      const r = rig(new HostileChildReads({ now: () => NOW }));
      const { runId, mirror } = await parked(r);

      breakChild = true;
      const p = await r.engine.advance(runId);
      breakChild = false;
      assert.equal(p.status, "awaiting_gate", `the parent still answers its own question: ${shape.what}`);
      assert.equal(p.gates[mirror.gateId]?.state, "open", `and the mirror is still fail-closed: ${shape.what}`);

      await new Promise((res) => setImmediate(res));
      const mine = warnings.filter((w) => w.code === "LOOM_MIRROR_ANSWER_FAILED" && w.message.includes(String(runId)));
      assert.equal(mine.length, 1, `it is still said out loud (${shape.what}): ${JSON.stringify(warnings)}`);
      assert.ok(
        /whose message could not be read/.test(mine[0]!.message),
        `and the warning says what it could not describe rather than dying trying (${shape.what}): ${mine[0]!.message}`,
      );
      // AND IT DOES NOT INVENT A CAUSE. Only the first shape's string conversion actually threw;
      // the other two threw on `message`. The description names the shape it saw and stops there,
      // and it keeps the fact an operator can act on — that two of the three WERE `Error`s.
      assert.ok(
        mine[0]!.message.includes(shape.what.startsWith("an Error") ? "a thrown Error" : "a thrown object"),
        `and it says which shape it saw (${shape.what}): ${mine[0]!.message}`,
      );
    }
  } finally {
    process.off("warning", onWarning);
  }
});

test("AND THE MIRROR IS ANSWERED BY THE READ THIS DIFF WRAPS ONCE THE CHILD'S STORE COMES BACK — the recovery, through the right half", async () => {
  // THE FIRST TEST'S RECOVERY ASSERTION GOES THROUGH THE OTHER DIRECTION. It calls
  // `resolveGate(child, …)`, so `#forwardToParentMirrors` — the CHILD-side forward — is what
  // decides the mirror, and the read this diff wraps is never what recovers. That is a real gap:
  // the plan's Accept says "the very next pass answers the mirror", and "the very next pass" means
  // the PARENT's.
  //
  // SO THE CHILD'S GATE IS DECIDED STRAIGHT ON ITS OWN JOURNAL, through the broker and a bare
  // `RunLog`, with no engine verb on the child at all — the sweeper's `defaultAction`, the batch
  // door and the broker's dedupe all reach the journal this way. Nothing forwards. The only thing
  // that can answer the parent's mirror is `#answerMirrorsTheChildAlreadyDecided`, on the parent's
  // own next `advance`, through the wrapped read.
  let breakChild = false;
  class BrokenChildReads extends MemoryStateStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      if (breakChild && String(runId).includes("~")) throw new Error("sqlite: child disk I/O error");
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const store = new BrokenChildReads({ now: () => NOW });
  const r = rig(store);
  const { runId, childRunId, mirror } = await parked(r);
  const childGate = open((await r.engine.projection(childRunId))!)!;

  // Decided on the child's journal, by no engine verb.
  await new HumanGateBroker({ now: () => NOW }).resolve(new RunLog(childRunId, { store, now: () => NOW }), {
    gateId: childGate.gateId,
    decision: { kind: "approve" },
    actor: lead,
    idempotencyKey: "direct",
  });

  // While the child's store is down, the parent's pass refuses and leaves the mirror open.
  breakChild = true;
  assert.equal((await r.engine.advance(runId)).status, "awaiting_gate");
  assert.equal((await r.engine.projection(runId))!.gates[mirror.gateId]?.state, "open", "refused, not answered");

  // The store comes back and the parent's very next pass answers it — through the wrapped read,
  // which is the half this diff is about.
  breakChild = false;
  const healed = await r.engine.advance(runId);
  const answered = (await r.engine.projection(runId))!.gates[mirror.gateId];
  assert.equal(answered?.state, "decided", `the parent's own next pass answered it: ${JSON.stringify(healed.status)}`);
  assert.equal(answered?.decision, "approve");
  assert.equal(answered?.decidedBy, "system");
});

test("THE SHARED HELPER IS LOAD-BEARING ON THE FORWARD SIDE TOO — the one line this lane changed in round 4's wrapper", async () => {
  // `#forwardToParentMirrorsQuietly` swallows EVERYTHING by contract, and its description idiom
  // was the one thing in it that could throw. This lane adopted `describeThrown` there — the only
  // edit it made to round 4's code, and the "sharing a helper" its brief permits — and until this
  // test that one line was the only part of the diff nothing drove.
  //
  // THE PARENT'S STORE IS WHAT BREAKS HERE, and the verb is the CHILD's: the mirror image of every
  // other test in this file.
  let breakParent = false;
  class HostileParentReads extends MemoryStateStore {
    override async *read(runId: RunId, fromSeq: Seq, toSeq?: Seq): AsyncIterable<JournalEvent> {
      if (breakParent && !String(runId).includes("~")) {
        const bad = new Error("x");
        // Passes `instanceof Error`, and every implicit conversion of `.message` throws.
        Object.defineProperty(bad, "message", { value: Object.create(null) });
        throw bad;
      }
      yield* super.read(runId, fromSeq, toSeq);
    }
  }
  const warnings: { code?: string; message: string }[] = [];
  const onWarning = (w: Error & { code?: string }): void => {
    warnings.push({ ...(w.code === undefined ? {} : { code: w.code }), message: w.message });
  };
  process.on("warning", onWarning);
  try {
    const r = rig(new HostileParentReads({ now: () => NOW }));
    const { runId, childRunId } = await parked(r);
    const childGate = open((await r.engine.projection(childRunId))!)!;

    breakParent = true;
    // The child's own verb, about the child's own gate, with the parent's store rejecting
    // undescribably. Before the helper was shared, `String(e.message)` here threw out of
    // `resolveGate` — the exact outcome round 4's wrapper exists to prevent.
    const childP = await r.engine.resolveGate(childRunId, {
      gateId: childGate.gateId,
      decision: { kind: "approve" },
      actor: lead,
      idempotencyKey: "c1",
    });
    assert.equal(childP.status, "awaiting_gate", "the child answered its own question");
    assert.equal(
      (await r.engine.projection(childRunId))!.gates[childGate.gateId]?.state,
      "decided",
      "and its decision is durable, which is why propagating the parent's fault would mislead",
    );

    await new Promise((res) => setImmediate(res));
    const mine = warnings.filter((w) => w.code === "LOOM_MIRROR_FORWARD_FAILED" && w.message.includes(String(childRunId)));
    assert.ok(mine.length >= 1, `the refusal is still announced: ${JSON.stringify(warnings)}`);
    assert.ok(
      /whose message could not be read/.test(mine[0]!.message),
      `and it names what it could not describe rather than dying trying: ${mine[0]!.message}`,
    );
    void runId;
  } finally {
    process.off("warning", onWarning);
  }
});
