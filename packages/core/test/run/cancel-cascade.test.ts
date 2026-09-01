/**
 * A CANCEL REACHES THE WORK, NOT ONLY THE RUN THE OPERATOR NAMED.
 *
 * `cancellation.test.ts` established that cancelling a run closes its own gates, so the
 * refused action cannot be driven by answering what the cancel left behind. This is the
 * same defect one level of delegation down, and it survived that fix untouched:
 * `Engine.cancel` had no notion of child runs at all. Cancelling a parent that had
 * delegated to a subgraph closed the parent's MIRROR gate and left the CHILD run
 * `awaiting_gate` with its own gate open — still listed, still returned by
 * `openGates(childRunId)`, and answering it executed the delegated irreversible action the
 * operator had just cancelled.
 *
 * The mirror is not the question. It is a copy of the question, raised in the parent so a
 * human can be asked in one place; the gate that actually stands in front of the charge
 * lives in the child, in the child's own queue, with the child's own approvers on it.
 * Closing the copy and leaving the original is worse than closing neither, because the
 * parent's console then shows nothing outstanding.
 *
 * Three residuals of the same lifecycle sit below it, each reached from a different door:
 *
 *   2. `resolve` looked a gate up with a bare index on a prototype-bearing object, so
 *      `__proto__` answered with `Object.prototype` and a gate nobody raised came back as
 *      one that exists — reported as `409 E_GATE_ALREADY_RESOLVED` rather than `404`.
 *   3. `rewind` scanned from `atSeq + 1`, so rewinding to PRECISELY a rejection's seq could
 *      not see the decision it was undoing: the `gate.decided` survived, the `run.resumed`
 *      beside it did not, and the run was left `awaiting_gate` with zero open gates.
 *   4. `gate.decided` and `gate.timeout` folded over ANY gate state, so a gate a cancel had
 *      closed read back as `decided` or `expired`.
 *
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq } from "../../src/ids.ts";
import type { Actor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import type { GateRecord, RunProjection } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const SECURITY_LEAD = "u:security-lead";
const lead: Actor = { kind: "human", subject: SECURITY_LEAD, via: "console" };
const alice: Actor = { kind: "human", subject: "u:alice", via: "console" };

const TOOLS: Record<string, ToolManifestLite> = {
  "pay.charge": {
    name: "pay.charge",
    version: "1.0",
    capabilities: ["pay"],
    irreversibility: "irreversible",
    idempotent: false,
  },
};

/** The gate is closed, so the decision has nowhere to land. */
const gateIsClosed = (err: unknown): true => {
  assert.ok(isLoomError(err), `expected a LoomError, got ${String(err)}`);
  assert.equal(err.code, CODES.E_GATE_ALREADY_RESOLVED, err.message);
  return true;
};

const noSuchGate = (err: unknown): true => {
  assert.ok(isLoomError(err), `expected a LoomError, got ${String(err)}`);
  assert.equal(err.code, CODES.E_GATE_NOT_FOUND, err.message);
  return true;
};

// ---------------------------------------------------------------------------
// The tree: top → (mid →)? leaf, where the leaf charges a card behind a gate
// ---------------------------------------------------------------------------

/** The leaf: double the amount, ask the security lead, then take the money. */
function leafSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "leaf", project: "cascade", version: 1 },
    policy: { posture: "out", capabilities: ["pay"] },
    channels: {
      amount: { type: "number", reduce: "replace" },
      doubled: { type: "number", reduce: "replace" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      {
        id: n("double"),
        type: "function",
        reads: ["amount"],
        writes: ["doubled"],
        function: { ref: "function/double@stable" },
      },
      {
        id: n("approve"),
        type: "human_gate",
        reads: ["doubled"],
        humanGate: { ref: "oversight/charge@stable", approval: { approvers: [SECURITY_LEAD] } },
      },
      {
        id: n("charge"),
        type: "tool",
        reads: ["doubled"],
        writes: ["receipt"],
        tool: { name: "pay.charge", version: "1.0", args: { amount: "${doubled}" } },
        unhandled: true,
      },
    ],
    edges: [
      { id: e("l1"), from: n("double"), to: n("approve"), kind: "seq" },
      { id: e("l2"), from: n("approve"), to: n("charge"), kind: "seq" },
    ],
  };
}

/**
 * A graph whose entire body is one delegation.
 *
 * The same shape at every level, so `top → leaf` and `top → mid → leaf` are the same
 * test with one more link — which is the whole question for a cascade.
 */
function delegatorSpec(ref: string, name: string): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name, project: "cascade", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 32, maxDepth: 4, maxFanout: 4, maxLoopIterations: 1 },
      capabilities: ["pay"],
    },
    channels: {
      amount: { type: "number", reduce: "replace" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      {
        id: n("delegate"),
        type: "subgraph",
        reads: ["amount"],
        writes: ["receipt"],
        subgraph: { ref, inputs: { amount: "amount" }, outputs: { receipt: "receipt" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  };
}

function resolverWith(graphs: Readonly<Record<string, GraphSpec>>): ResourceResolver {
  return {
    resolve: (ref) =>
      /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
        ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }
        : undefined,
    subgraph: (ref) => graphs[ref],
  };
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly charges: number[];
  readonly graphs: Readonly<Record<string, GraphSpec>>;
}

function rig(graphs: Readonly<Record<string, GraphSpec>>, over?: MemoryStateStore): Rig {
  const now = (): number => 1_700_000_000_000;
  const store = over ?? new MemoryStateStore({ now });
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
    now,
    resolver: resolverWith(graphs),
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, store, charges, graphs };
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

const openOf = (p: RunProjection): GateRecord =>
  Object.values(p.gates)
    .filter((g) => g.state === "open")
    .sort((a, b) => a.raisedAtSeq - b.raisedAtSeq)[0]!;

/**
 * Drive a tree of delegators until the LEAF parks on the gate in front of its charge.
 *
 * `levels` is how many delegating runs sit above the leaf: 1 is `top → leaf`, 2 is
 * `top → mid → leaf`.
 */
async function parkedOnDelegation(levels: number): Promise<{
  r: Rig;
  /** Root first, leaf last. */
  runIds: readonly RunId[];
  /** The compiled top graph, so a second engine can re-attach the root and nothing else. */
  graph: RunGraph;
}> {
  const graphs: Record<string, GraphSpec> = { "graph/leaf@stable": leafSpec() };
  let ref = "graph/leaf@stable";
  for (let i = 1; i < levels; i++) {
    const name = `mid${i}`;
    graphs[`graph/${name}@stable`] = delegatorSpec(ref, name);
    ref = `graph/${name}@stable`;
  }
  const topSpec = delegatorSpec(ref, "top");

  const r = rig(graphs);
  const graph = compileOrThrow({
    spec: topSpec,
    resolver: resolverWith(graphs),
    tools: TOOLS,
    tenantCapabilities: ["pay"],
  });
  const runId = await r.engine.submit({ graph, inputs: { amount: 10 } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));

  const runIds: RunId[] = [runId];
  for (let i = 0; i < levels; i++) runIds.push(`${runIds[i]!}~delegate@root#0` as RunId);

  // EACH DELEGATOR NOW ASKS BEFORE IT DELEGATES, and that is the shape under test's cost, not
  // its subject. A `subgraph` node's compile floor folds in the tools its CHILD can reach, so
  // every `delegate` node above the leaf reaches `pay.charge` and stands at posture `in` — the
  // human is asked before the child starts rather than at the innermost call. To park the LEAF
  // on the gate this file is about, those `levels` delegation gates have to be answered first.
  for (let i = 0; i < levels; i++) {
    const id = runIds[i]!;
    const parked = (await r.engine.projection(id))!;
    if (parked.status !== "awaiting_gate") continue;
    await r.engine.resolveGate(id, {
      gateId: openOf(parked).gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: SECURITY_LEAD, via: "console" },
      idempotencyKey: `delegate-${i}`,
    });
    await r.engine.advance(runIds[0]!);
  }
  return { r, runIds, graph };
}

// ── the headline ─────────────────────────────────────────────────────────────

test("CANCELLING A PARENT REACHES THE CHILD IT DELEGATED TO", async () => {
  // The whole exploit: park a delegation on the child's gate, cancel the PARENT, then
  // answer the CHILD's gate directly. `cancel` closed the parent's mirror and had no
  // notion of a child run at all, so the question the mirror was a copy OF stayed open in
  // the child's own queue — with the child's own approvers on it, so every authorization
  // check passes and the charge goes through.
  const { r, runIds } = await parkedOnDelegation(1);
  const [top, leaf] = runIds as [RunId, RunId];

  const before = (await r.engine.projection(leaf))!;
  assert.equal(before.status, "awaiting_gate", "the shape under test: the child is the one being asked");
  const childGate = openOf(before);
  assert.deepEqual(childGate.approvers, [SECURITY_LEAD]);

  const cancelled = await r.engine.cancel(top, "the charge must not go out");
  assert.equal(cancelled.status, "cancelled");

  const after = (await r.engine.projection(leaf))!;
  assert.equal(after.status, "cancelled", "THE DELEGATED RUN STOPPED WITH THE RUN THAT DELEGATED TO IT");
  assert.equal(after.gates[childGate.gateId]?.state, "cancelled", "…and its gate was closed, not merely orphaned");
  assert.deepEqual(await r.engine.openGates(leaf), [], "nothing is left in anybody's queue");

  // The security lead is named on this gate, so authorization is not what stops them.
  await assert.rejects(
    () =>
      r.engine.resolveGate(leaf, {
        gateId: childGate.gateId,
        decision: { kind: "approve" },
        actor: lead,
        idempotencyKey: "resurrect",
      }),
    gateIsClosed,
  );

  assert.equal((await r.engine.projection(leaf))!.status, "cancelled", "the cancelled child stayed cancelled");
  assert.deepEqual(r.charges, [], "AND THE DELEGATED IRREVERSIBLE ACTION DID NOT HAPPEN");
});

test("…and it is TRANSITIVE: a child that itself delegated is reached too", async () => {
  // One more link, and the recursion is the point: the middle run is the only thing that
  // knows about the leaf, so a cascade that stops at the first generation leaves exactly
  // the same live question one run further away from the operator who cancelled it.
  const { r, runIds } = await parkedOnDelegation(2);
  const [top, mid, leaf] = runIds as [RunId, RunId, RunId];

  const leafGate = openOf((await r.engine.projection(leaf))!);
  await r.engine.cancel(top, "stop the whole tree");

  for (const [name, id] of [["top", top], ["mid", mid], ["leaf", leaf]] as const) {
    assert.equal((await r.engine.projection(id))!.status, "cancelled", `${name} is cancelled`);
    assert.deepEqual(await r.engine.openGates(id), [], `${name} has nothing left open`);
  }

  await assert.rejects(
    () =>
      r.engine.resolveGate(leaf, {
        gateId: leafGate.gateId,
        decision: { kind: "approve" },
        actor: lead,
        idempotencyKey: "deep",
      }),
    gateIsClosed,
  );
  assert.deepEqual(r.charges, []);
});

test("the cascade is IDEMPOTENT: cancelling twice does not journal twice", async () => {
  // A cancel that re-closes what it already closed is not merely noisy: every extra
  // `gate.cancelled` is a second closure of a gate with one closure, and an operator
  // reading the log cannot tell a retry from a second decision.
  const { r, runIds } = await parkedOnDelegation(2);
  const [top, mid, leaf] = runIds as [RunId, RunId, RunId];

  await r.engine.cancel(top, "stop");
  const first = await Promise.all(runIds.map((id) => events(r.store, id)));

  await r.engine.cancel(top, "stop again");
  const second = await Promise.all(runIds.map((id) => events(r.store, id)));

  assert.deepEqual(
    second.map((evs) => evs.length),
    first.map((evs) => evs.length),
    "a second cancel of a cancelled tree appends NOTHING, at any level",
  );
  for (const id of [top, mid, leaf]) {
    const evs = await events(r.store, id);
    assert.equal(evs.filter((ev) => ev.type === "run.cancelled").length, 1, `${id}: one run.cancelled`);
    assert.equal(evs.filter((ev) => ev.type === "gate.cancelled").length <= 1, true, `${id}: at most one closure per gate`);
  }
});

test("the ROOT is cancelled LAST, so a terminal parent proves the tree went with it", async () => {
  // The atomicity the cascade can actually offer. There is no transaction across two
  // journals, so the ordering IS the guarantee: children are ended before the parent's
  // own `run.cancelled` lands, which makes "the parent is cancelled" evidence that every
  // run below it already is. A crash mid-cascade leaves the parent non-terminal with its
  // `operator.command` on the record — a state re-running `cancel` finishes.
  const { r, runIds } = await parkedOnDelegation(2);
  const [top, mid, leaf] = runIds as [RunId, RunId, RunId];
  await r.engine.cancel(top, "stop");

  const endedAt = async (id: RunId): Promise<number> => {
    const evs = await events(r.store, id);
    return evs.findIndex((ev) => ev.type === "run.cancelled");
  };
  assert.ok((await endedAt(leaf)) >= 0 && (await endedAt(mid)) >= 0 && (await endedAt(top)) >= 0);

  const topEvents = await events(r.store, top);
  const cmd = topEvents.findIndex((ev) => ev.type === "operator.command");
  const done = topEvents.findIndex((ev) => ev.type === "run.cancelled");
  assert.ok(cmd >= 0 && done > cmd, "the command is journaled before it is dispatched, as it always was");

  // The child's log says WHY it stopped, and names the run that stopped it.
  const reason = (await events(r.store, leaf)).find((ev) => ev.type === "operator.command");
  assert.ok(reason, "the child was commanded, not merely abandoned");
  assert.match(JSON.stringify(reason.payload), /stop/, "carrying the operator's own reason down");
});

test("A CHILD THIS PROCESS NEVER ATTACHED IS STILL REACHED", async () => {
  // The restart case, and the reason the cascade cannot be written in terms of `#require`.
  // An operator who restarts the control plane re-attaches the graph they have on disk —
  // the ROOT's. A child's graph is resolved lazily by the node that delegates to it, so
  // after a restart no child is attached to anything, and a cascade that could only cancel
  // attached runs would cancel exactly the run the operator named and nothing else. Which
  // is the defect, restated.
  const { r, runIds, graph } = await parkedOnDelegation(2);
  const [top, mid, leaf] = runIds as [RunId, RunId, RunId];
  const leafGateId = openOf((await r.engine.projection(leaf))!).gateId;

  const restarted = rig(r.graphs, r.store);
  restarted.engine.attach(top, graph);

  const p = await restarted.engine.cancel(top, "stop, and I only have the top graph");
  assert.equal(p.status, "cancelled");
  for (const id of [mid, leaf]) {
    assert.equal((await restarted.engine.projection(id))!.status, "cancelled", `${id} was reached without a graph`);
  }

  await assert.rejects(
    () =>
      restarted.engine.resolveGate(leaf, {
        gateId: leafGateId,
        decision: { kind: "approve" },
        actor: lead,
        idempotencyKey: "after-restart",
      }),
    // The child was never attached to this engine, so the ENGINE's own door refuses first.
    (err: unknown) => {
      assert.ok(isLoomError(err), String(err));
      assert.equal(err.code, CODES.E_RUN_NOT_FOUND, err.message);
      return true;
    },
  );
  assert.deepEqual(restarted.charges, []);
  assert.deepEqual(r.charges, []);
});

test("A CRASH MID-CASCADE LEAVES A TREE THE NEXT CANCEL CAN FINISH", async () => {
  // The atomicity claim, tested rather than asserted. There is no transaction across two
  // journals, so what a crash must not produce is a tree that LOOKS finished: the root's
  // `run.cancelled` is the last thing to land, so it can only be there once everything
  // below it already is.
  const { r, runIds } = await parkedOnDelegation(2);
  const [top, mid, leaf] = runIds as [RunId, RunId, RunId];

  const real = r.store.append.bind(r.store);
  let armed = true;
  (r.store as { append: MemoryStateStore["append"] }).append = async (input) => {
    if (armed && input.runId === leaf && input.events.some((ev) => ev.type === "run.cancelled")) {
      armed = false;
      throw new Error("the process died between two journals");
    }
    return real(input);
  };

  await assert.rejects(() => r.engine.cancel(top, "stop"), /died between two journals/);

  assert.equal((await r.engine.projection(leaf))!.status, "awaiting_gate", "the leaf did not close");
  for (const id of [top, mid]) {
    assert.equal(
      isTerminalStatus((await r.engine.projection(id))!.status),
      false,
      `${id} is NOT terminal, so nothing reports this tree as stopped`,
    );
  }

  const p = await r.engine.cancel(top, "stop, again");
  assert.equal(p.status, "cancelled");
  for (const id of [top, mid, leaf]) {
    assert.equal((await r.engine.projection(id))!.status, "cancelled", `${id} was finished by the second cancel`);
    assert.deepEqual(await r.engine.openGates(id), []);
  }
  assert.deepEqual(r.charges, []);
});

const isTerminalStatus = (s: string): boolean => s === "succeeded" || s === "failed" || s === "cancelled";

test("a delegating run that has already FINISHED is left alone", async () => {
  // The cascade must not reach backwards into work that completed. A child that succeeded
  // is a fact, not an outstanding question, and re-terminating it would rewrite the record
  // of a run nobody cancelled.
  const graphs: Record<string, GraphSpec> = {
    "graph/leaf@stable": {
      ...leafSpec(),
      nodes: leafSpec().nodes.filter((node) => node.id !== n("approve") && node.id !== n("charge")),
      outputs: ["doubled"],
      edges: [],
    },
  };
  const r = rig(graphs);
  const spec = delegatorSpec("graph/leaf@stable", "top");
  const graph = compileOrThrow({
    spec: { ...spec, nodes: spec.nodes.map((node) => ({ ...node, subgraph: { ...node.subgraph!, outputs: { receipt: "doubled" } } })) },
    resolver: resolverWith(graphs),
    tools: TOOLS,
    tenantCapabilities: ["pay"],
  });
  const runId = await r.engine.submit({ graph, inputs: { amount: 4 } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  const childRunId = `${runId}~delegate@root#0` as RunId;
  const before = await events(r.store, childRunId);
  await r.engine.cancel(runId, "too late");
  assert.equal((await r.engine.projection(runId))!.status, "succeeded", "a finished run is not retroactively cancelled");
  assert.deepEqual((await events(r.store, childRunId)).length, before.length, "and neither is its finished child");
});

// ── residual 2: the prototype-key lookup ─────────────────────────────────────

test("A GATE ID THAT NAMES AN INHERITED PROPERTY IS NOT A GATE", async () => {
  // `p.gates` is a plain object, so `p.gates["__proto__"]` answers with `Object.prototype`
  // — an object, therefore "found" — and the state check one line down reads `undefined`,
  // which is not "open". A gate nobody raised came back as `409 E_GATE_ALREADY_RESOLVED`,
  // which tells a caller that a gate by that name exists and has been decided.
  //
  // The delivery layer closed this for ITS door with `safeGateId`. This closes it where
  // the lookup happens, so every caller inherits it rather than each door growing a guard.
  const { r, runIds } = await parkedOnDelegation(1);
  const [top] = runIds as [RunId, RunId];

  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    await assert.rejects(
      () =>
        r.engine.resolveGate(top, {
          gateId: name as GateId,
          decision: { kind: "approve" },
          actor: alice,
          idempotencyKey: `p:${name}`,
        }),
      noSuchGate,
      `"${name}" is not a gate anybody raised`,
    );
  }
});

test("…and the fold never hands a gate map its own prototype", async () => {
  // The write half of the same shape: `p.gates[gid] = record` with `gid === "__proto__"`
  // does not add a gate, it REPLACES the map's prototype. Everything downstream then reads
  // a projection whose gate map inherits from a gate record.
  const store = new MemoryStateStore({ now: () => 1 });
  const runId = "01JGATEPROTOPOLLUTION000000" as RunId;
  const log = new RunLog(runId, { store, now: () => 1 });
  await log.append([
    { type: "run.started", payload: { posture: "out" }, actor: { kind: "system", component: "scheduler" } },
    {
      type: "gate.raised",
      payload: {
        gateId: "__proto__" as GateId,
        nodeId: n("x"),
        policyRef: "oversight/x@stable",
        contentDigest: "sha256:0",
      },
      actor: { kind: "system", component: "gate-broker" },
    },
  ]);

  const broker = new HumanGateBroker({ now: () => 1 });
  const p = (await broker.project(log))!;
  assert.equal(Object.getPrototypeOf(p.gates), Object.prototype, "the gate map is still an ordinary object");
  assert.deepEqual(await broker.list(log), [], "and a gate that cannot be named is not offered to anyone");
});

// ── residual 3: rewinding to exactly a rejection's seq ────────────────────────

test("REWINDING TO PRECISELY A REJECTION'S SEQ IS REFUSED", async () => {
  // The scan started at `atSeq + 1`, so the one seq a rewind cannot see is the decision
  // sitting exactly on the boundary. The suppression range is exclusive at both ends: the
  // `gate.decided{reject}` survives and the `run.resumed` beside it does not, so the run
  // comes back `awaiting_gate` with the gate already decided — zero open gates, no legal
  // way forward, and (the run is not `cancelled`) no legal way back either.
  const { r, runIds } = await parkedOnDelegation(1);
  const [top] = runIds as [RunId, RunId];
  const mirror = openOf((await r.engine.projection(top))!);

  const p = await r.engine.resolveGate(top, {
    gateId: mirror.gateId,
    decision: { kind: "reject", reason: "not at this amount" },
    actor: lead,
    idempotencyKey: "no",
  });
  assert.equal(p.status, "failed", "a refusal fails the run");

  const decided = (await events(r.store, top)).find((ev) => ev.type === "gate.decided")!;
  await assert.rejects(
    () => r.engine.rewind(top, decided.seq as Seq, "undo the refusal from exactly its own seq"),
    (err: unknown) => {
      assert.ok(isLoomError(err), String(err));
      assert.equal(err.code, CODES.E_RESTORE_ILLEGAL, err.message);
      return true;
    },
  );

  const after = (await r.engine.projection(top))!;
  assert.equal(after.status, "failed", "THE RUN WAS NOT WEDGED");
  assert.deepEqual(await r.engine.openGates(top), []);
  assert.deepEqual(r.charges, []);
});

/**
 * Approve the mirror WITHOUT advancing, so the decision reaches the journal and the
 * delegated charge does not. `resolveGate` would drive the forward; this is the same two
 * events that arrive when the process dies between the decision and the resume.
 */
async function approvedWithoutAdvancing(): Promise<{ r: Rig; top: RunId; decidedSeq: Seq }> {
  const { r, runIds } = await parkedOnDelegation(1);
  const top = runIds[0]!;
  const mirror = openOf((await r.engine.projection(top))!);

  const log = new RunLog(top, { store: r.store, now: () => 1_700_000_000_000 });
  const broker = new HumanGateBroker({ now: () => 1_700_000_000_000 });
  await broker.resolve(log, {
    gateId: mirror.gateId,
    decision: { kind: "approve" },
    actor: lead,
    idempotencyKey: "yes",
  });

  const decided = (await events(r.store, top)).find((ev) => ev.type === "gate.decided")!;
  return { r, top, decidedSeq: decided.seq as Seq };
}

test("…and the same boundary on an APPROVAL is refused too, naming the two seqs that mean something", async () => {
  // The wedge with the sign flipped. `gate.decided` and `run.resumed` are ONE append across
  // TWO seqs, so a boundary of exactly the decision's seq keeps the decision and drops the
  // resume — `awaiting_gate` with zero open gates, and `advance` returns on `awaiting_gate`
  // before it looks for work. The rejection arm above refuses because undoing a refusal
  // overrules a person; this one refuses because the state it would produce never existed.
  const { r, top, decidedSeq } = await approvedWithoutAdvancing();

  await assert.rejects(
    () => r.engine.rewind(top, decidedSeq, "rewind to exactly the approval"),
    (err: unknown) => {
      assert.ok(isLoomError(err), String(err));
      assert.equal(err.code, CODES.E_RESTORE_ILLEGAL, err.message);
      // The message has to be actionable, because BOTH readings of "rewind to the decision"
      // are legitimate and the operator has to be told which seq each one is.
      assert.match(err.message, new RegExp(`rewind to ${decidedSeq + 1} `), err.message);
      assert.match(err.message, new RegExp(`or to ${decidedSeq - 1} `), err.message);
      return true;
    },
  );

  const after = (await r.engine.projection(top))!;
  assert.equal(after.status, "running", "the refused rewind changed nothing");
  assert.deepEqual(r.charges, []);
});

test("…and both seqs the refusal names really do work", async () => {
  // The advice is checked, not merely written. `atSeq + 1` is the `run.resumed`, so the
  // decision is kept and the run stays where the human left it; `atSeq - 1` suppresses the
  // decision as well, so the gate comes back OPEN and the same person is asked again. Those
  // are the two coherent readings, and between them they are why this is a refusal rather
  // than a permanent wedge.
  const keep = await approvedWithoutAdvancing();
  const kept = await keep.r.engine.rewind(keep.top, (keep.decidedSeq + 1) as Seq, "keep the approval");
  assert.equal(kept.status, "running", "the resume survived");
  assert.equal(
    Object.values(kept.gates).find((g) => g.state === "decided")?.decision,
    "approve",
    "…and so did the decision",
  );

  const undo = await approvedWithoutAdvancing();
  const reopened = await undo.r.engine.rewind(undo.top, (undo.decidedSeq - 1) as Seq, "ask again");
  assert.equal(reopened.status, "awaiting_gate");
  assert.equal((await undo.r.engine.openGates(undo.top)).length, 1, "THE GATE IS BACK IN THE HUMAN'S QUEUE");
  assert.deepEqual(keep.r.charges, []);
  assert.deepEqual(undo.r.charges, []);
});

// ── residual 4: gate.decided / gate.timeout folded over any state ────────────

/** Park the leaf on its gate and hand back a broker + log over the child's journal. */
async function leafGate(): Promise<{
  r: Rig;
  runId: RunId;
  log: RunLog;
  broker: HumanGateBroker;
  gate: GateRecord;
}> {
  const { r, runIds } = await parkedOnDelegation(1);
  const runId = runIds[1]!;
  const log = new RunLog(runId, { store: r.store, now: () => 1_700_000_000_000 });
  const broker = new HumanGateBroker({ now: () => 1_700_000_000_000 });
  return { r, runId, log, broker, gate: openOf((await r.engine.projection(runId))!) };
}

test("TWO DECISIONS ON ONE GATE: THE SECOND ONE IS REFUSED, AND WRITES NOTHING", async () => {
  // WHAT THIS FILE USED TO ASSERT HERE, and why it changed. `resolve` read the gate, found
  // it open, and then wrote through `log.append` — which RETRIES on a seq conflict, because
  // it is built for facts rather than for decisions conditional on the head. So two people
  // answering the same gate in the same instant BOTH LANDED: this test asserted "both calls
  // were accepted" and "two decisions reached the journal", and the property it protected
  // was only that the FOLD picked the first of the two. That is a projection defending
  // itself against a journal that is already wrong, and the journal is the only
  // authoritative state.
  //
  // `resolve` now goes out `log.commit(p.seq, …)`, the door whose docstring says it never
  // retries, so the loser of the race re-reads, sees a gate that is no longer open, and is
  // refused. The fold's first-one-wins arm is still real and still tested — one test down,
  // against a hand-built journal, because `src/` can no longer produce that journal.
  const { r, runId, log, broker, gate } = await leafGate();

  const results = await Promise.allSettled([
    broker.resolve(log, { gateId: gate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "yes" }),
    broker.resolve(log, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "not at this amount" },
      actor: lead,
      idempotencyKey: "no",
    }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1, "exactly one of two concurrent answers may be accepted");
  const refused = results.find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
  assert.notEqual(refused, undefined, "the other must be REFUSED, not silently dropped");
  assert.ok(isLoomError(refused!.reason), `the refusal must be a Loom error: ${String(refused!.reason)}`);
  assert.equal(refused!.reason.code, CODES.E_GATE_ALREADY_RESOLVED, "…and it must say the gate is no longer open");

  // THE HALF THAT MAKES IT A TEST OF THE WRITE DOOR AND NOT OF THE ERROR MESSAGE. A
  // `resolve` that threw after appending would satisfy every line above.
  const journal = await events(r.store, runId);
  assert.equal(journal.filter((ev) => ev.type === "gate.decided").length, 1, "one decision in the journal, not two");
  assert.equal(journal.filter((ev) => ev.type === "run.resumed").length, 1, "…and one resume beside it, not two");
});

test("A JOURNAL THAT ALREADY HOLDS TWO DECISIONS STILL READS BACK AS THE FIRST", async () => {
  // The fold arm the test above used to cover, kept, and now reached the way residual 4's
  // neighbour reaches its own: by writing the journal by hand. A store written by an older
  // build contains exactly this shape — the write door is what changed, not the rows that
  // are already on disk — so "the read model carries the first decision" has to stay true
  // for a log this version would refuse to produce. A rule that holds only for logs this
  // version writes is not a rule.
  const { r, runId, log, broker, gate } = await leafGate();
  await broker.resolve(log, { gateId: gate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "yes" });

  await log.append([
    {
      type: "gate.decided",
      payload: { gateId: gate.gateId, decision: "reject", latencyMs: 0 },
      actor: lead,
      taskId: gate.taskId,
    },
    { type: "run.resumed", payload: { by: "gate" }, actor: lead },
  ]);

  const decisions = (await events(r.store, runId)).filter((ev) => ev.type === "gate.decided");
  assert.equal(decisions.length, 2, "the precondition: a journal with two decisions on one gate");
  const p = (await r.engine.projection(runId))!;
  assert.equal(
    p.gates[gate.gateId]?.decision,
    (decisions[0]!.payload as { decision: string }).decision,
    "THE READ MODEL CARRIES THE FIRST DECISION, not whichever landed last",
  );
});

test("a gate a CANCEL closed does not read back as DECIDED", async () => {
  // The same race, against the operator instead of against another approver, and it is the
  // race above that makes this journal reachable: `resolve` reads the gate as open, the
  // cancel closes it, and the decision lands afterwards. Whether the two interleave that way
  // in any given run is a scheduling question, so the ORDER is fixed here and the fold arm
  // is what is under test — the same split `cancellation.test.ts` draws when it appends a
  // `run.resumed` to a genuinely cancelled run.
  //
  // `gate.cancelled` already refused to overwrite a decided gate. The reverse direction had
  // no such rule, so the operator's closure vanished from the read model and the gate
  // reported a decision on a run nobody could act on.
  const { r, runId, log, gate } = await leafGate();
  await r.engine.cancel(runIdRoot(runId), "stop");
  assert.equal((await r.engine.projection(runId))!.gates[gate.gateId]?.state, "cancelled");

  await log.append([
    {
      type: "gate.decided",
      payload: { gateId: gate.gateId, decision: "approve", latencyMs: 0 },
      actor: lead,
      taskId: gate.taskId,
    },
    { type: "run.resumed", payload: { by: "gate" }, actor: lead },
  ]);

  const p = (await r.engine.projection(runId))!;
  assert.equal(p.gates[gate.gateId]?.state, "cancelled", "THE OPERATOR'S CLOSURE IS STILL WHAT HAPPENED");
  assert.equal(p.status, "cancelled", "…and the run it belonged to did not come back either");
  assert.deepEqual(r.charges, []);
});

test("A DECISION THAT BEATS ITS DEADLINE IS NOT OVERRULED BY IT, and the sweep writes NOTHING", async () => {
  // This test used to assert the opposite half of the same race, and it is worth saying
  // what changed. `#expire` appended `gate.timeout` + `run.failed` unconditionally, so a
  // decision landing inside `sweepTimeouts`'s read→append window landed AND was overruled:
  // the fold's "only from `open`" guard kept the gate reading `decided`, nothing guarded
  // the `run.failed` riding with it, and the read model ended up saying *this gate was
  // approved and the run was killed for not answering it*. The old assertion — "both a
  // decision and an expiry reached the journal" — pinned that journal as the shape under
  // test, and it is now unreachable: the expiry is a `commit` against the seq it was
  // decided at, so the store refuses it outright.
  //
  // The fold guard it used to reach is now exercised directly, over a hand-written
  // journal, in `gate-guards.test.ts` — because a guard whose only route was a defect is a
  // guard with no test the moment the defect is fixed.
  const { r, runId, log, broker, gate } = await leafGate();

  // Re-attach an SLA the journal never carried, then run the sweep past its deadline.
  broker.rehydrate(gate.gateId, {
    runId,
    taskId: gate.taskId,
    nodeId: gate.nodeId,
    policyRef: gate.policyRef,
    payload: {},
    slaMs: 1,
  });

  const [sweep] = await Promise.all([
    broker.sweepTimeouts(log, 1_700_000_999_999),
    broker.resolve(log, { gateId: gate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "yes" }),
  ]);

  const evs = await events(r.store, runId);
  assert.equal(evs.some((ev) => ev.type === "gate.decided"), true, "the human's answer landed");
  assert.equal(
    evs.some((ev) => ev.type === "gate.timeout"),
    false,
    "AND THE DEADLINE IT BEAT WROTE NOTHING — not the expiry, and not the run.failed riding with it",
  );
  assert.equal(evs.some((ev) => ev.type === "run.failed"), false);
  assert.deepEqual(sweep, [], "…and the sweep does not report a gate it did not fire");

  const p = (await r.engine.projection(runId))!;
  assert.equal(p.gates[gate.gateId]?.state, "decided");
  assert.notEqual(p.status, "failed", "the run is not killed for not answering a gate it answered");
});

/** The root of a derived child id: everything before the first `~`. */
function runIdRoot(childRunId: RunId): RunId {
  const at = childRunId.indexOf("~");
  return (at === -1 ? childRunId : childRunId.slice(0, at)) as RunId;
}
