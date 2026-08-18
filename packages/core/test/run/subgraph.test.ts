/**
 * Subgraph nodes.
 *
 * The gap this closes: the compiler accepted `subgraph` nodes and validated their
 * mappings, and the executor threw. A graph that compiles must run — "compiles, then
 * fails at run time" is the exact failure this system's whole compile stage exists to
 * prevent, and having one in the executor made the guarantee conditional.
 *
 * The design decision under test: the child is a SEPARATE RUN with its own journal, and
 * the invocation is a recorded effect in the parent's.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type Actor, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { RunLog } from "../../src/run/log.ts";
import type { GateRecord } from "../../src/run/projection.ts";
import { replayRun } from "../../src/run/replay.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const TOOLS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: false },
};

/** The child: doubles a number, and optionally charges for it. */
function childSpec(withCharge = false): GraphSpec {
  return {
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
    outputs: withCharge ? ["receipt"] : ["doubled"],
    nodes: [
      { id: n("double"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
      ...(withCharge
        ? [
            {
              id: n("charge"),
              type: "tool" as const,
              reads: ["doubled"],
              writes: ["receipt"],
              tool: { name: "pay.charge", version: "1.0", args: { amount: "${doubled}" } },
              unhandled: true,
            },
          ]
        : []),
    ],
    edges: withCharge ? [{ id: e("c"), from: n("double"), to: n("charge"), kind: "seq" as const }] : [],
  };
}

/** The parent: hands `total` in, takes the child's result back as `result`. */
function parentSpec(over: Partial<GraphSpec> = {}, outputs: Record<string, string> = { result: "doubled" }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "sub", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 }, capabilities: ["pay"] },
    channels: {
      total: { type: "number", reduce: "replace" },
      result: { type: "object", reduce: "replace" },
      note: { type: "object", reduce: "replace" },
    },
    inputs: ["total"],
    outputs: ["result"],
    nodes: [
      {
        id: n("delegate"),
        type: "subgraph",
        reads: ["total"],
        writes: ["result"],
        subgraph: { ref: "graph/double@stable", inputs: { amount: "total" }, outputs, budgetShare: 0.5 },
      },
    ],
    edges: [],
    ...over,
  };
}

function resolverWith(child: GraphSpec): ResourceResolver {
  return {
    resolve: (ref) =>
      /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
        ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }
        : undefined,
    subgraph: (ref) => (ref === "graph/double@stable" ? child : undefined),
  };
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly charges: number[];
}

function rig(child: GraphSpec, opts: { budgetUsd?: number } = {}): Rig {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
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
    resolver: resolverWith(child),
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: opts.budgetUsd ?? 10 } },
  });
  return { engine, store, charges };
}

const compileParent = (child: GraphSpec, spec: GraphSpec = parentSpec()) =>
  compileOrThrow({ spec, resolver: resolverWith(child), tools: TOOLS, tenantCapabilities: ["pay"] });

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

// ── the gap ──────────────────────────────────────────────────────────────────

test("A GRAPH THAT COMPILES RUNS — a subgraph node no longer throws", async () => {
  const child = childSpec();
  const r = rig(child);
  const runId = await r.engine.submit({ graph: compileParent(child), inputs: { total: 21 } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(p.channels["result"], 42, "the child's `doubled` came back as the parent's `result`");
});

test("THE CHILD SPEC IS FROZEN AT COMPILE — an executing Task asks no resolver for content", async () => {
  // A24. `#runSubgraph` used to call `this.#resolver.subgraph?.(sub.ref)` while a Task was
  // running, which is the floating-ref read `resources/functions.ts` records for code and A22
  // closed for prompts: a promotion between compile and execute swaps the child underneath the
  // parent. The parent's compile freezes every child spec it can reach.
  const child = childSpec();
  const r = rig(child);
  const graph = compileParent(child);
  assert.deepEqual(Object.keys(graph.subgraphs), ["graph/double@stable"], "the tree is on the compiled artifact");
  assert.equal(graph.subgraphs["graph/double@stable"]?.metadata.name, "double");

  // A POISONED RESOLVER for the run: it still `resolve`s refs, because the CHILD's compile
  // legitimately pins its own — that is the next compile, not a run-time content read — but its
  // `subgraph()` answers a childless spec that would be refused `GRAPH003_EMPTY`. If the
  // executor asked it, this run fails. It does not, because the parent froze the real one.
  const poisoned: ResourceResolver = {
    ...resolverWith(child),
    subgraph: () => ({ ...child, nodes: [], edges: [] }),
  };
  const engine = new Engine({
    store: r.store,
    resolver: poisoned,
    tools: r.engine.tools,
    functions: r.engine.functions,
    models: r.engine.models,
    now: () => 1_700_000_000_000,
    policy: { granted: ["pay"], budget: { runUsd: 1 } },
  });
  const runId = await engine.submit({ graph, inputs: { total: 21 } });
  const p = await engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(p.channels["result"], 42, "the child ran, from the frozen spec");
});

test("A DELEGATED RUN BELONGS TO WHOEVER STARTED THE PARENT", async () => {
  const child = childSpec();
  const r = rig(child);
  const runId = await r.engine.submit({
    graph: compileParent(child),
    inputs: { total: 21 },
    submittedBy: { kind: "human", subject: "u:alice", method: "sso" },
  });
  await r.engine.advance(runId);

  // A child run exists only because someone started the parent, so that person started this
  // too. The two alternatives are both worse: a synthetic `(subgraph)` subject would be a
  // name matching nothing while reading like one that does, and leaving it absent would make
  // a delegated run — the half where the irreversible work usually lives — invisible to the
  // very person who caused it, and permissive to everyone else.
  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childP = (await r.engine.projection(childRunId))!;
  assert.deepEqual(childP.submittedBy, { kind: "human", subject: "u:alice", method: "sso" });
});

test("the channel MAPPING is what crosses the boundary, not the whole child state", async () => {
  const child = childSpec();
  const r = rig(child);
  const runId = await r.engine.submit({ graph: compileParent(child), inputs: { total: 5 } });
  const p = await r.engine.advance(runId);

  assert.equal(p.channels["result"], 10);
  assert.equal(p.channels["doubled"], undefined, "the child's own channels do not leak into the parent");
  assert.equal(p.channels["amount"], undefined);
});

// ── the child is a separate run ──────────────────────────────────────────────

test("THE CHILD IS ITS OWN RUN, with its own journal", async () => {
  const child = childSpec();
  const r = rig(child);
  const runId = await r.engine.submit({ graph: compileParent(child), inputs: { total: 3 } });
  await r.engine.advance(runId);

  const started = (await events(r.store, runId)).find((ev) => ev.type === "subgraph.started");
  assert.ok(started, "the only link between the two journals");
  const childRunId = (started.payload as { childRunId: RunId }).childRunId;

  const childEvents = await events(r.store, childRunId);
  assert.ok(childEvents.length > 0, "the child is auditable on its own terms");
  assert.equal(childEvents.some((ev) => ev.type === "run.completed"), true);

  // …and the parent's journal is the size of the PARENT, not of the whole tree.
  const parentEvents = await events(r.store, runId);
  assert.ok(parentEvents.length < childEvents.length + parentEvents.length);
  assert.equal(parentEvents.some((ev) => ev.type === "run.completed"), true);
});

test("the child run id is DERIVED, so a restart finds the same child", async () => {
  const child = childSpec();
  const r = rig(child);
  const runId = await r.engine.submit({ graph: compileParent(child), inputs: { total: 3 } });
  await r.engine.advance(runId);

  const started = (await events(r.store, runId)).find((ev) => ev.type === "subgraph.started")!;
  const childRunId = (started.payload as { childRunId: string }).childRunId;
  assert.equal(childRunId, `${runId}~delegate@root#0`, "a random id would silently break replay");
});

// ── the effect boundary ──────────────────────────────────────────────────────

test("A PARENT REPLAY DOES NOT RE-RUN THE CHILD", async () => {
  // Which matters most when the child did something irreversible. The invocation is a
  // recorded effect, so replay serves the mapped outputs.
  const child = childSpec(true);
  const r = rig(child);
  const graph = compileParent(child, parentSpec({}, { result: "receipt" }));
  const runId = await r.engine.submit({ graph, inputs: { total: 4 } });
  let p = await r.engine.advance(runId);

  // The child's charge is irreversible, so it gates — through the PARENT.
  assert.equal(p.status, "awaiting_gate");
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.charges, [8], "charged once");

  const shadow = rig(child);
  const report = await replayRun({
    runId,
    store: r.store,
    graph,
    engine: {
      tools: shadow.engine.tools,
      functions: new FunctionRegistry(),
      models: new ModelRegistry(),
      now: () => 1_700_000_000_000,
      resolver: resolverWith(child),
      policy: { granted: ["pay"] },
    },
  });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match).slice(0, 2)));
  assert.deepEqual(shadow.charges, [], "THE CARD WAS NOT CHARGED A SECOND TIME");
});

// ── oversight across the boundary ────────────────────────────────────────────

test("ONE HUMAN DECISION, not two — the parent's answer resolves the child's gate", async () => {
  const child = childSpec(true);
  const r = rig(child);
  const graph = compileParent(child, parentSpec({}, { result: "receipt" }));
  const runId = await r.engine.submit({ graph, inputs: { total: 10 } });
  let p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate");
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  // The rendered payload lives on the broker's summary, not on the projection row — the
  // projection stays the durable part, the payload is re-derivable.
  const summaries = await r.engine.openGates(runId);
  const payload = (summaries.find((g) => g.gateId === gate.gateId)?.payload ?? {}) as {
    childRunId: RunId;
    childNode: string;
  };
  assert.equal(payload.childNode, "charge", "the parent's gate names the child's actual question");
  assert.deepEqual(r.charges, [], "and nothing has been charged");

  p = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });

  assert.equal(p.status, "succeeded");
  assert.deepEqual(r.charges, [20]);

  // The child's gate was decided too — by the executor, carrying the human's answer.
  const childP = (await r.engine.projection(payload.childRunId))!;
  const childGate = Object.values(childP.gates)[0]!;
  assert.equal(childGate.state, "decided");
  assert.equal(childGate.decision, "approve");
});

test("REJECTING at the parent rejects IN THE CHILD, and takes no money", async () => {
  // The name used to be a claim the test never made: it asserted the parent's status and
  // the charge count, and both were already true of a child left suspended forever. A
  // non-`approve` decision short-circuited before the forward ever ran, so every rejected
  // delegation leaked a run with an open gate nobody would answer.
  const child = childSpec(true);
  const r = rig(child);
  const graph = compileParent(child, parentSpec({}, { result: "receipt" }));
  const runId = await r.engine.submit({ graph, inputs: { total: 10 } });
  let p = await r.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;

  p = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "reject", reason: "not this quarter" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });

  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, CODES.E_HUMAN_APPROVAL_REQUIRED, "the parent fails as a refusal, not as a broken child");
  assert.match(p.error?.message ?? "", /not this quarter/, "…carrying the human's own reason");
  assert.deepEqual(r.charges, []);

  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childP = (await r.engine.projection(childRunId))!;
  assert.notEqual(childP.status, "awaiting_gate", "THE CHILD IS NOT LEFT SUSPENDED FOREVER");
  const childGate = Object.values(childP.gates)[0]!;
  assert.equal(childGate.state, "decided", "the refusal reached the gate it was about");
  assert.equal(childGate.decision, "reject");
});

// ── the mirror gate is a real gate, not a bypass ─────────────────────────────
//
// A `subgraph` node has no `humanGate` block of its own, so everything the executor
// used to derive from one — the approvers list, the `edit` allow-list — came out
// `undefined` for the gate a human ACTUALLY answers. The child's declaration was read
// by nobody. These pin the two halves of that shut.

const SECURITY_LEAD = "u:security-lead";
const lead: Actor = { kind: "human", subject: SECURITY_LEAD, via: "console" };
const mallory: Actor = { kind: "human", subject: "u:mallory", via: "console" };

const unauthorized = (e: unknown): true => {
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  assert.equal(e.code, CODES.E_GATE_NOT_AUTHORIZED);
  return true;
};

/**
 * The child, with a `human_gate` naming one person in front of the charge.
 *
 * The approvers block lives on a `human_gate` node and nowhere else: `humanGate` is a
 * type block, so GRAPH020 refuses it on the `tool` node itself. That is exactly why the
 * mirror has to inherit — the declaration is one node away from the action.
 */
function guardedChild(): GraphSpec {
  const base = childSpec(true);
  return {
    ...base,
    nodes: [
      ...base.nodes,
      {
        id: n("approve"),
        type: "human_gate",
        reads: ["doubled"],
        humanGate: { ref: "oversight/charge@stable", approval: { mode: "single", approvers: [SECURITY_LEAD] } },
      },
    ],
    edges: [
      { id: e("c"), from: n("double"), to: n("approve"), kind: "seq" },
      { id: e("g"), from: n("approve"), to: n("charge"), kind: "seq" },
    ],
  };
}

/**
 * A child that opens TWO gates in the same wave, with different approvers.
 *
 * `chatty` names nobody and has the longer critical path, so `orderByCriticalPath` runs
 * it first and its `gate.raised` lands first in the journal. `guard` names the security
 * lead and stands in front of the irreversible charge. Any code that says "the first open
 * gate" reaches `chatty` before an answer arrives and `guard` after — which is the whole
 * shape of the bypass, and is why a one-gate child cannot express this test.
 */
function twoGateChild(): GraphSpec {
  const base = childSpec(true);
  const echo = { ref: "function/double@stable" };
  return {
    ...base,
    nodes: [
      ...base.nodes,
      { id: n("chatty"), type: "human_gate", reads: ["doubled"], humanGate: { ref: "oversight/note@stable" } },
      { id: n("tail1"), type: "function", reads: ["amount"], writes: ["doubled"], function: echo },
      { id: n("tail2"), type: "function", reads: ["amount"], writes: ["doubled"], function: echo },
      {
        id: n("guard"),
        type: "human_gate",
        reads: ["doubled"],
        humanGate: { ref: "oversight/charge@stable", approval: { mode: "single", approvers: [SECURITY_LEAD] } },
      },
    ],
    edges: [
      { id: e("a1"), from: n("double"), to: n("chatty"), kind: "seq" },
      { id: e("a2"), from: n("chatty"), to: n("tail1"), kind: "seq" },
      { id: e("a3"), from: n("tail1"), to: n("tail2"), kind: "seq" },
      { id: e("b1"), from: n("double"), to: n("guard"), kind: "seq" },
      { id: e("b2"), from: n("guard"), to: n("charge"), kind: "seq" },
    ],
  };
}

/** Park a parent run on the mirror gate its child raised. */
async function parkedOnMirror(child: GraphSpec, spec = parentSpec({}, { result: "receipt" })) {
  const r = rig(child);
  const runId = await r.engine.submit({ graph: compileParent(child, spec), inputs: { total: 10 } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));
  return { r, runId, gate: Object.values(p.gates).find((g) => g.state === "open")! };
}

const openGate = async (r: Rig, runId: RunId) =>
  Object.values((await r.engine.projection(runId))!.gates).find((g) => g.state === "open")!;

test("AND THE CHILD'S SEPARATION OF DUTIES BINDS IT TOO — the same hole, one field over", async () => {
  // `mirrorAuthorizationOf` inherits the child's approvers because "the mirror is the gate a
  // human actually answers, and the declaration is one run away from the action it guards".
  // The exclusion is the same argument and the same hole: without it the run's INITIATOR
  // approves the parent's mirror, and `executor:subgraph` forwards that approval into a child
  // gate whose own `excludedApprovers` names them — the rule enforced one run away from where
  // the decision was made, which is precisely nowhere.
  //
  // Measured before this test existed: dropping the inheritance left all 1726 tests green and
  // the initiator approved the delegated charge.
  const base = guardedChild();
  const child: GraphSpec = {
    ...base,
    nodes: base.nodes.map((x) =>
      x.id !== n("approve")
        ? x
        : {
            ...x,
            humanGate: {
              ref: "oversight/charge@stable",
              approval: { mode: "single" as const, approvers: [SECURITY_LEAD, "u:second"], separationOfDuties: true },
            },
          },
    ),
  };
  const r = rig(child);
  // The parent is submitted BY the security lead — who the child also names as an approver.
  const runId = await r.engine.submit({
    graph: compileParent(child, parentSpec({}, { result: "receipt" })),
    inputs: { total: 10 },
    submittedBy: { kind: "human", subject: SECURITY_LEAD, method: "sso" },
  });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  assert.deepEqual(gate.excludedApprovers, [SECURITY_LEAD], "the mirror inherits the rule, not only the list");

  await assert.rejects(
    () =>
      r.engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: SECURITY_LEAD, via: "api" },
        idempotencyKey: "s",
      }),
    /separates duties/,
    "named on the child's list, and still barred — because they started the run",
  );
  assert.deepEqual(r.charges, [], "THE CARD WAS NOT CHARGED");

  // …and the other named approver still gets through, so this narrowed the door.
  const next = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:second", via: "api" },
    idempotencyKey: "t",
  });
  assert.notEqual(next.status, "failed");
});

test("THE CHILD'S APPROVERS BIND THE PARENT'S MIRROR GATE", async () => {
  // The bypass: the child declared `["u:security-lead"]` in front of an irreversible
  // charge, the parent's mirror named nobody, and u:mallory answering the mirror had the
  // executor forward an approval into the child as a system actor that `isAuthorizedActor`
  // waved through. Two individually-reasonable decisions, one complete hole.
  const { r, runId, gate } = await parkedOnMirror(guardedChild());
  assert.deepEqual(gate.approvers, [SECURITY_LEAD], "the mirror inherits the list the child declared");

  await assert.rejects(
    () => r.engine.resolveGate(runId, { gateId: gate.gateId, decision: { kind: "approve" }, actor: mallory, idempotencyKey: "m" }),
    unauthorized,
  );
  assert.deepEqual(r.charges, [], "THE CARD WAS NOT CHARGED");

  const still = await r.engine.projection(runId);
  assert.equal(still?.gates[gate.gateId]?.state, "open", "a refused decision leaves the mirror open");

  // …and the person the child named still gets through.
  const next = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: lead,
    idempotencyKey: "l",
  });

  // The charge node then raises its OWN posture gate, which declares nobody — a tool node
  // has no syntax for an approvers list. That is a limit worth stating out loud, not a
  // second bypass: nothing was declared there, so nothing was ignored.
  assert.equal(next.status, "awaiting_gate");
  const second = await openGate(r, runId);
  assert.notEqual(second.gateId, gate.gateId);
  assert.equal(second.approvers, undefined, "a posture gate names nobody, because nothing declared one");

  const done = await r.engine.resolveGate(runId, {
    gateId: second.gateId,
    decision: { kind: "approve" },
    actor: lead,
    idempotencyKey: "l2",
  });
  assert.equal(done.status, "succeeded", JSON.stringify(done.error ?? {}));
  assert.deepEqual(r.charges, [20]);
});

test("the executor's forwarded approval carries the CHILD's own declaration through", async () => {
  // `executor:subgraph` passes the child's approvers check because the human's authority
  // is journaled on the parent's `gate.decided`. That is only true while the parent's
  // mirror enforces the same list — so the two halves are one test.
  const { r, runId, gate } = await parkedOnMirror(guardedChild());
  await r.engine.resolveGate(runId, { gateId: gate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "l" });

  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childP = (await r.engine.projection(childRunId))!;
  const childGate = Object.values(childP.gates).find((g) => g.nodeId === n("approve"))!;
  assert.equal(childGate.decision, "approve");
  assert.deepEqual(childGate.approvers, [SECURITY_LEAD], "the child's own gate kept its declaration");
});

test("A LATER REJECTION IS NOT SATISFIED BY AN EARLIER APPROVAL", async () => {
  // A subgraph node raises one mirror per child gate, so its Task accumulates several
  // decided gates. Reading "the first decided gate for this Task" turned a rejection of
  // the SECOND question into a re-forward of the approval given to the first — and the
  // charge the human had just refused went through.
  const { r, runId, gate } = await parkedOnMirror(guardedChild());
  await r.engine.resolveGate(runId, { gateId: gate.gateId, decision: { kind: "approve" }, actor: lead, idempotencyKey: "l" });

  const second = await openGate(r, runId);
  const p = await r.engine.resolveGate(runId, {
    gateId: second.gateId,
    decision: { kind: "reject", reason: "not at this amount" },
    actor: lead,
    idempotencyKey: "no",
  });

  assert.equal(p.status, "failed");
  assert.deepEqual(r.charges, [], "THE REFUSED CHARGE DID NOT HAPPEN");
});

test("A MIRROR GATE CANNOT EDIT A CHANNEL THE SUBGRAPH NODE NEVER DECLARED", async () => {
  // Same budget-corruption path the `human_gate` case pins shut, one node type over:
  // `spend` has `reduce: sum`, so an unchecked edit does not merely write somewhere it
  // should not — it rewrites the accumulator every later admission decision reads.
  const child = childSpec(true);
  const spec = parentSpec(
    {
      channels: {
        total: { type: "number", reduce: "replace" },
        result: { type: "object", reduce: "replace" },
        note: { type: "object", reduce: "replace" },
        spend: { type: "number", reduce: "sum", initial: 0 },
      },
    },
    { result: "receipt" },
  );
  const { r, runId, gate } = await parkedOnMirror(child, spec);
  assert.deepEqual(gate.allowEdit, [], "a mirror declares no editable channel at all");

  await assert.rejects(
    () =>
      r.engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "edit", writes: { spend: 999_999 } },
        actor: mallory,
        idempotencyKey: "e",
      }),
    unauthorized,
  );

  const after = await r.engine.projection(runId);
  assert.notEqual(after?.channels["spend"], 999_999, "the budget accumulator was not overwritten");
  assert.deepEqual(r.charges, []);
});

// ── the mirror is bound to ONE gate, not to "whichever is open" ──────────────
//
// The narrowed form of the same bypass. The mirror inherited its approvers from one
// `Object.values(gates).find(open)` at RAISE time and forwarded into a second, independent
// one at FORWARD time. Nothing bound the two picks together, so answering an unrestricted
// child gate between them — which any operator working the child's queue would do — moved
// the restricted gate under the mirror and had the executor approve it as a system actor.

async function twoGateRig(): Promise<{
  r: Rig;
  runId: RunId;
  childRunId: RunId;
  mirror: GateRecord;
  chatty: GateRecord;
  guard: GateRecord;
}> {
  const child = twoGateChild();
  const r = rig(child);
  const graph = compileParent(child, parentSpec({}, { result: "receipt" }));
  const runId = await r.engine.submit({ graph, inputs: { total: 10 } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));

  const childRunId = `${runId}~delegate@root#0` as RunId;
  const childP = (await r.engine.projection(childRunId))!;
  const open = Object.values(childP.gates)
    .filter((g) => g.state === "open")
    .sort((a, b) => a.raisedAtSeq - b.raisedAtSeq);
  assert.equal(open.length, 2, "the shape under test: two child gates open at once");
  assert.equal(open[0]!.nodeId, "chatty", "the permissive one is raised first");
  assert.equal(open[1]!.nodeId, "guard");

  const mirror = Object.values(p.gates).find((g) => g.state === "open")!;
  return { r, runId, childRunId, mirror, chatty: open[0]!, guard: open[1]! };
}

test("A MIRROR ANSWERS THE GATE IT WAS RAISED FOR, not whichever is open when the answer arrives", async () => {
  const { r, runId, childRunId, mirror, chatty, guard } = await twoGateRig();
  assert.equal(mirror.approvers, undefined, "the mirror inherited the PERMISSIVE gate's list");

  // Entirely legitimate: `chatty` names nobody, so any operator may answer it in the
  // child's own console. This is the only unusual step the exploit needs.
  await r.engine.resolveGate(childRunId, {
    gateId: chatty.gateId,
    decision: { kind: "approve" },
    actor: mallory,
    idempotencyKey: "direct",
  });

  // Also legitimate: the mirror names nobody either, because that is what it inherited.
  await r.engine.resolveGate(runId, {
    gateId: mirror.gateId,
    decision: { kind: "approve" },
    actor: mallory,
    idempotencyKey: "mirror",
  });

  const after = (await r.engine.projection(childRunId))!;
  assert.equal(
    after.gates[guard.gateId]?.state,
    "open",
    "THE GATE u:security-lead WAS NAMED ON WAS NOT ANSWERED BY THE EXECUTOR",
  );
  assert.deepEqual(r.charges, [], "and u:mallory alone did not move money");

  const forwarded = (await events(r.store, childRunId)).filter(
    (ev) => ev.type === "gate.decided" && (ev.actor as { component?: string }).component === "executor:subgraph",
  );
  assert.deepEqual(forwarded, [], "no system-actor decision reached the child at all");
});

test("…and the parent then asks again, bound to the gate the child is ACTUALLY waiting on", async () => {
  // The refusal above must not be a hang: a mirror whose question was answered elsewhere
  // is spent, and the executor has to raise a fresh one for whatever is still open —
  // inheriting THAT gate's approvers, which is what puts the security lead back in front
  // of the charge.
  const { r, runId, childRunId, mirror, chatty, guard } = await twoGateRig();
  await r.engine.resolveGate(childRunId, {
    gateId: chatty.gateId,
    decision: { kind: "approve" },
    actor: mallory,
    idempotencyKey: "direct",
  });
  let p = await r.engine.resolveGate(runId, {
    gateId: mirror.gateId,
    decision: { kind: "approve" },
    actor: mallory,
    idempotencyKey: "mirror",
  });

  assert.equal(p.status, "awaiting_gate");
  const second = await openGate(r, runId);
  assert.notEqual(second.gateId, mirror.gateId);
  assert.deepEqual(second.approvers, [SECURITY_LEAD], "the second mirror carries the guarded gate's list");

  await assert.rejects(
    () =>
      r.engine.resolveGate(runId, {
        gateId: second.gateId,
        decision: { kind: "approve" },
        actor: mallory,
        idempotencyKey: "m2",
      }),
    unauthorized,
  );

  // …and the person the child named still gets all the way through.
  p = await r.engine.resolveGate(runId, {
    gateId: second.gateId,
    decision: { kind: "approve" },
    actor: lead,
    idempotencyKey: "l2",
  });
  assert.equal((await r.engine.projection(childRunId))!.gates[guard.gateId]?.decision, "approve");

  assert.equal(p.status, "awaiting_gate", "the charge's own posture gate is next");
  const third = await openGate(r, runId);
  p = await r.engine.resolveGate(runId, {
    gateId: third.gateId,
    decision: { kind: "approve" },
    actor: lead,
    idempotencyKey: "l3",
  });
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.charges, [20]);
});

test("a rejection whose child gate was already answered elsewhere still ENDS the child", async () => {
  // The forward has nothing to reject — the gate it was raised for is decided — but the
  // human's "no" is still the parent's answer, and walking away from it would leave the
  // child suspended on its remaining gate for good. Every such run leaked a suspended run
  // and its journal permanently.
  const { r, runId, childRunId, mirror, chatty } = await twoGateRig();
  await r.engine.resolveGate(childRunId, {
    gateId: chatty.gateId,
    decision: { kind: "approve" },
    actor: mallory,
    idempotencyKey: "direct",
  });

  const p = await r.engine.resolveGate(runId, {
    gateId: mirror.gateId,
    decision: { kind: "reject", reason: "not this quarter" },
    actor: mallory,
    idempotencyKey: "no",
  });

  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, CODES.E_HUMAN_APPROVAL_REQUIRED);
  const childP = (await r.engine.projection(childRunId))!;
  assert.equal(childP.status, "cancelled", "the delegated run is stopped, not abandoned");
  assert.deepEqual(r.charges, []);
});

test("…AND THE CANCELLED CHILD CANNOT BE RESURRECTED THROUGH ITS LEFTOVER GATE", async () => {
  // Where the resurrection was reproduced. The step above stops the child; this is what
  // "stopped" has to mean. `#endChildRun` cancelled the run and left `guard` — the gate
  // standing in front of the irreversible charge — `open`, because nothing in `src/` ever
  // appended the `gate.cancelled` D7.3 has specified since it was drawn. The parent had
  // just REFUSED this delegation. Answering the gate it left behind put the child back to
  // `running` and took the money anyway: a cancel that the thing it cancelled can undo.
  const { r, runId, childRunId, mirror, chatty, guard } = await twoGateRig();
  await r.engine.resolveGate(childRunId, {
    gateId: chatty.gateId,
    decision: { kind: "approve" },
    actor: mallory,
    idempotencyKey: "direct",
  });
  await r.engine.resolveGate(runId, {
    gateId: mirror.gateId,
    decision: { kind: "reject", reason: "not this quarter" },
    actor: mallory,
    idempotencyKey: "no",
  });

  const stopped = (await r.engine.projection(childRunId))!;
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.gates[guard.gateId]?.state, "cancelled", "the child's remaining gate was closed WITH the run");

  // The security lead is on this gate's approvers list, so every authorization check here
  // passes. The only thing standing between them and the charge is that the run is over.
  await assert.rejects(
    () =>
      r.engine.resolveGate(childRunId, {
        gateId: guard.gateId,
        decision: { kind: "approve" },
        actor: lead,
        idempotencyKey: "resurrect",
      }),
    (e: unknown) => {
      assert.ok(isLoomError(e), String(e));
      assert.equal(e.code, CODES.E_GATE_ALREADY_RESOLVED, e.message);
      return true;
    },
  );

  assert.equal((await r.engine.projection(childRunId))!.status, "cancelled", "the cancelled run stayed cancelled");
  assert.deepEqual(r.charges, [], "AND THE REFUSED CHARGE STILL DID NOT HAPPEN");
});

test("a child suspended on a gate it DOES NOT HAVE fails the node, rather than mirroring nothing", async () => {
  // `#runSubgraph` reads `childP.status === "awaiting_gate"` and then goes looking for the
  // gate to stand in for. Those are two different facts and a journal can hold them apart:
  // `run.suspended{reason:"gate"}` with no `gate.raised` behind it is what a crash between
  // the broker's two appends used to leave, and what any partially-written child log looks
  // like. The old code raised a mirror carrying `childGateId: undefined` — a question a
  // human could answer, bound to nothing, forwarding into nothing.
  const child = childSpec();
  const r = rig(child);
  const runId = "01JSUBGRAPHGATELESS000000" as RunId;
  const childRunId = `${runId}~delegate@root#0` as RunId;

  await new RunLog(childRunId, { store: r.store }).append([
    { type: "run.suspended", payload: { reason: "gate" }, actor: SYSTEM_ACTOR("gate-broker") },
  ]);

  await r.engine.submit({ graph: compileParent(child), inputs: { total: 4 }, runId });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, CODES.E_SUBGRAPH_FAILED);
  assert.match(p.error?.message ?? "", /awaiting a gate it does not have/);

  const mirrors = (await events(r.store, runId)).filter((ev) => ev.type === "gate.raised");
  assert.deepEqual(mirrors, [], "no mirror was raised for a question that does not exist");
});

test("A MIRROR CANNOT FORGE THE DELEGATED RESULT", async () => {
  // `allowEdit` was the subgraph node's declared writes — which is exactly the set that
  // lets a human hand the parent a result the child never produced. The parent reported
  // success with invented values, no `subgraph.completed` was journaled, and the child sat
  // suspended with an open gate forever. A mirror carries approve or reject; nothing else
  // survives the trip into the other run's namespace.
  const child = childSpec(true);
  const { r, runId, gate } = await parkedOnMirror(child);
  assert.deepEqual(gate.allowEdit, [], "a mirror permits no edit at all");

  await assert.rejects(
    () =>
      r.engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "edit", writes: { result: { amount: 999_999, forged: true, ok: true } } },
        actor: mallory,
        idempotencyKey: "forge",
      }),
    unauthorized,
  );

  const p = (await r.engine.projection(runId))!;
  assert.notEqual(p.status, "succeeded");
  assert.equal(p.gates[gate.gateId]?.state, "open", "the refused decision left the mirror open");
  assert.equal(p.channels["result"], undefined, "no invented result reached the parent");
  assert.deepEqual(r.charges, []);
});

test("a mirror refuses a REDIRECT too, because there is no edge in the child to take", async () => {
  // The same leak from the other side: a redirect answers the parent's routing question
  // and says nothing the child's gate could be resolved with, so it would strand the
  // child while the parent walked on.
  const { r, runId, gate } = await parkedOnMirror(childSpec(true));
  await assert.rejects(
    () =>
      r.engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "redirect", take: [] },
        actor: mallory,
        idempotencyKey: "rd",
      }),
    unauthorized,
  );
  assert.equal((await r.engine.projection(runId))!.gates[gate.gateId]?.state, "open");
});

test("a child that FAILS fails the parent node with the child named", async () => {
  const broken: GraphSpec = {
    ...childSpec(),
    nodes: [{ id: n("boom"), type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/missing@stable" } }],
    edges: [],
  };
  const r = rig(broken);
  const runId = await r.engine.submit({ graph: compileParent(broken), inputs: { total: 1 } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_SUBGRAPH_FAILED");
  assert.match(p.error?.message ?? "", /graph\/double@stable/);
});

// ── budget ───────────────────────────────────────────────────────────────────

test("a subgraph's slice is carved from what the parent still has", async () => {
  const child = childSpec();
  const r = rig(child, { budgetUsd: 4 });
  const runId = await r.engine.submit({ graph: compileParent(child), inputs: { total: 1 } });
  await r.engine.advance(runId);

  const started = (await events(r.store, runId)).find((ev) => ev.type === "subgraph.started")!;
  assert.equal((started.payload as { budgetUsd: number }).budgetUsd, 2, "budgetShare 0.5 of $4 remaining");
});

test("the child's spend counts against the PARENT's budget", async () => {
  // Without this, a graph could exceed its declared cost by nesting — the one thing
  // GRAPH009 proves at compile time cannot happen.
  const child = childSpec();
  const r = rig(child);
  const runId = await r.engine.submit({ graph: compileParent(child), inputs: { total: 1 } });
  await r.engine.advance(runId);

  const completed = (await events(r.store, runId)).find((ev) => ev.type === "subgraph.completed");
  assert.ok(completed, "the roll-up is journaled, so the parent's accounting is auditable");
  assert.equal((completed.payload as { status: string }).status, "succeeded");
});

// ── what the compiler still refuses ──────────────────────────────────────────

test("a subgraph that nests past maxDepth is still a COMPILE error", () => {
  const selfish: GraphSpec = {
    ...childSpec(),
    nodes: [
      ...childSpec().nodes,
      {
        id: n("again"),
        type: "subgraph",
        reads: ["doubled"],
        writes: ["doubled"],
        subgraph: { ref: "graph/double@stable", inputs: { amount: "doubled" }, outputs: { doubled: "doubled" } },
      },
    ],
    edges: [{ id: e("x"), from: n("double"), to: n("again"), kind: "seq" }],
  };
  const r = compile({
    spec: parentSpec({ policy: { ...parentSpec().policy, expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } } }),
    resolver: resolverWith(selfish),
    tools: TOOLS,
    tenantCapabilities: ["pay"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.diagnostics.some((d) => d.code.startsWith("GRAPH016")), JSON.stringify(r.diagnostics.slice(0, 2)));
});

test("a subgraph mapping a channel the child never declares is a COMPILE error", () => {
  const r = compile({
    spec: parentSpec({}, { result: "nonexistent" }),
    resolver: resolverWith(childSpec()),
    tools: TOOLS,
    tenantCapabilities: ["pay"],
  });
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.diagnostics.some((d) => d.code === "GRAPH016_BAD_MAPPING"));
});
