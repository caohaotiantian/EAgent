/**
 * A human ceiling is a judgement about the graph the human READ.
 *
 * It exists because "oversight only tightens" would otherwise make de-escalation
 * impossible: an irreversible action always computes to `in`, so "let this run
 * on-the-loop" could never be said. The lever is real and operators need it.
 *
 * But a runtime graph mutation adds a node AFTER the human read the graph, and E10
 * (`mutation_introduced_irreversible`) escalates exactly that node — with a comment in
 * `engine.ts` promising it gates "whatever the run's posture". Measured before the fix:
 * a run-scope de-escalation to `out` clamped that node-scoped escalation away, and an
 * irreversible tool the human never saw charged with zero gates raised.
 *
 * Six arms, in one file on purpose, because the fix is only right if all six hold:
 *
 *   1. the mutation-added node GATES despite a run-scope de-escalation to `out`;
 *   2. THE NEGATIVE CONTROL — a de-escalation of the graph the human actually read still
 *      works, because a fix that makes de-escalation useless pushes operators toward
 *      never de-escalating, which is worse than the hole;
 *   3. the run is not dead-ended: the human answers the gate and the work proceeds;
 *   4. the posture lever survives too — a human who NAMES the added node clears its
 *      escalation rather than clamping it;
 *   5. the approved run still REPLAYS, so no term arrived from memory;
 *   6. and none of it is held in the process: the floor is rebuilt by folding the journal.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { foldRun } from "../../src/run/projection.ts";
import { replayRun } from "../../src/run/replay.ts";
import { PolicyEngine, type PolicyRequest } from "../../src/run/policy.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type MockScript,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const PAY: ToolManifestLite = {
  name: "pay.charge",
  version: "1.0",
  capabilities: ["pay:write"],
  irreversibility: "irreversible",
  idempotent: false,
};

const CAPS = ["pay:write", "graph:mutate"];

/** A one-node graph whose planner may grow it. Nothing irreversible is in what a human reads. */
function growableSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "growable-charge", project: "test", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
      capabilities: CAPS,
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      plan: { type: "object", reduce: "replace" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["plan"],
    nodes: [
      {
        id: n("plan"),
        type: "agent",
        reads: ["goal"],
        writes: ["plan"],
        agent: {
          profile: "agent_profile/planner@stable",
          prompt: "prompt/plan@stable",
          maxTurns: 2,
          canMutate: true,
          outputSchema: { type: "object" },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/**
 * The same graph a human WOULD have read, with the charge node authored into it.
 *
 * `readsPlan` names the OTHER axis, and it has to be a knob rather than a constant because the
 * two axes answer differently. This file is about the mutation floor: a de-escalation covers the
 * graph the human read and not a node a planner grew. Whether the charge READS the planner's
 * output is an integrity question, and an `agent` node's writes are untrusted — a model's output
 * is generated text whatever it was given — so a charge reading `plan` is held at `in` by E8
 * however the graph was authored and whatever ceiling a human set. Both are true at once, and a
 * control that conflated them would pass for the wrong reason.
 */
function authoredSpec(readsPlan: boolean): GraphSpec {
  const spec = growableSpec() as unknown as { nodes: unknown[]; edges: unknown[]; metadata: { name: string } };
  spec.metadata.name = "authored-charge";
  spec.nodes.push({
    id: n("pay"),
    type: "tool",
    ...(readsPlan ? { reads: ["plan"] } : {}),
    writes: ["receipt"],
    tool: { name: "pay.charge", version: "1.0", args: {} },
    unhandled: true,
  });
  spec.edges.push({ id: e("a0"), from: n("plan"), to: n("pay"), kind: "seq" });
  return spec as unknown as GraphSpec;
}

/** A proposal that grows the graph a `pay.charge` node the human never saw. */
function proposingCharge(): MockScript {
  const addNodes: NodeSpec[] = [
    {
      id: n("pay"),
      type: "tool",
      reads: ["plan"],
      writes: ["receipt"],
      tool: { name: "pay.charge", version: "1.0", args: {} },
      unhandled: true,
    } as unknown as NodeSpec,
  ];
  const addEdges: EdgeSpec[] = [{ id: e("m0"), from: n("plan"), to: n("pay"), kind: "seq" }];
  return () => ({ text: JSON.stringify({ plan: {}, mutation: { addNodes, addEdges } }), finishReason: "stop" });
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly charged: () => number;
}

function rig(script: MockScript): Rig {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  let charged = 0;
  tools.register({
    ...PAY,
    description: "Takes money. Cannot be undone.",
    parameters: { type: "object" },
    execute: () => {
      charged++;
      return { content: "charged", writes: { receipt: { ok: true } } };
    },
  } satisfies ToolDefinition);

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);

  return {
    engine: new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions: new FunctionRegistry(),
      models,
      now,
      resolver: resolver(),
      policy: { granted: CAPS, systemFloor: "out" },
      sleep: () => Promise.resolve(),
    }),
    store,
    charged: () => charged,
  };
}

const compile = (spec: GraphSpec): RunGraph =>
  compileOrThrow({ spec, resolver: resolver(), tools: { "pay.charge": PAY }, tenantCapabilities: CAPS });

/** The request the executor would build for the mutation-added charge node. */
const payReq = (runId: RunId): PolicyRequest => ({
  runId,
  nodeId: n("pay"),
  kind: "tool",
  irreversibility: "irreversible",
  capabilities: ["pay:write"],
  declaredPosture: "out",
});

async function gatesRaised(store: MemoryStateStore, runId: RunId): Promise<number> {
  let count = 0;
  for await (const ev of store.read(runId, 1)) if (ev.type === "gate.raised") count++;
  return count;
}

test("a run-scope de-escalation does not cover a node the mutation introduced", async () => {
  const r = rig(proposingCharge());
  const runId = await r.engine.submit({ graph: compile(growableSpec()), inputs: { goal: "grow" } });
  await r.engine.deescalate(runId, `run:${runId}`, "out", "reviewed the graph, let it run", {
    kind: "human",
    id: "u:alice",
  });

  const p = await r.engine.advance(runId);
  const raised = await gatesRaised(r.store, runId);
  console.log(`via=mutation deesc=true status=${p.status} gateRaised=${raised} CHARGED=${r.charged()}`);

  assert.equal(p.escalations[`node:${runId}/pay`], "in", "precondition: E10 did fire on the added node");
  assert.equal(r.charged(), 0, "the money must not move on a node no human ever read");
  assert.equal(raised, 1, "and a gate must have been raised for it");
  assert.equal(p.status, "awaiting_gate");
});

test("a run-scope de-escalation still covers the graph the human actually read", async () => {
  // The negative control. Without this, the fix above is indistinguishable from
  // deleting `deescalate`, and an operator who cannot lower a posture stops trying.
  //
  // The charge does NOT read `plan` here, and that is the control being kept honest rather than
  // weakened: `plan` is an `agent` node's write, so it is untrusted, and a charge reading it is
  // held at `in` by the integrity floor no matter how the graph was authored. Leaving the read
  // in would make this test pass or fail on the other axis and say nothing about the ceiling.
  // The next test is that other axis, on the same graph one field apart.
  const r = rig(() => ({ text: JSON.stringify({ plan: {} }), finishReason: "stop" }));
  const runId = await r.engine.submit({ graph: compile(authoredSpec(false)), inputs: { goal: "go" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "reviewed the graph, let it run on-the-loop", {
    kind: "human",
    id: "u:alice",
  });

  const p = await r.engine.advance(runId);
  const raised = await gatesRaised(r.store, runId);
  console.log(`via=authored  deesc=true status=${p.status} gateRaised=${raised} CHARGED=${r.charged()}`);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(raised, 0, "the human read this node; their ceiling covers it");
  assert.equal(r.charged(), 1);
});

test("an AUTHORED charge reading a planner's output is still held — the model is not trusted", async () => {
  // The other axis, and the reason the control above drops the read. A human authored this node,
  // a human read the graph, and a human lowered the ceiling to `on` — every mutation-floor
  // condition is satisfied. It gates anyway, because `plan` is what a MODEL wrote and the money
  // moves on it. An `agent` node has no `effects: []` to declare: its output is generated text
  // whatever it was given, so there is no pure agent for a label to describe.
  const r = rig(() => ({ text: JSON.stringify({ plan: {} }), finishReason: "stop" }));
  const runId = await r.engine.submit({ graph: compile(authoredSpec(true)), inputs: { goal: "go" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "reviewed the graph, let it run on-the-loop", {
    kind: "human",
    id: "u:alice",
  });

  const p = await r.engine.advance(runId);
  assert.equal(r.charged(), 0, "the money moved on a model's output under a lowered ceiling");
  assert.equal(p.status, "awaiting_gate", `expected the integrity floor to hold the charge, got ${p.status}`);
});

test("AND THE RUN IS NOT DEAD-ENDED: the human answers the gate and the work proceeds", async () => {
  // The fix would be a ban rather than a floor if there were no way past it. The way past
  // is the gate itself — which is the point: the human is shown the node the mutation
  // added and says yes to THAT, rather than having said yes in advance to a graph that
  // did not contain it.
  const r = rig(proposingCharge());
  const runId = await r.engine.submit({ graph: compile(growableSpec()), inputs: { goal: "grow" } });
  await r.engine.deescalate(runId, `run:${runId}`, "out", "reviewed the graph", { kind: "human", id: "u:alice" });
  const gated = await r.engine.advance(runId);
  assert.equal(gated.status, "awaiting_gate", "precondition");
  const gate = Object.values(gated.gates).find((g) => g.state === "open");
  assert.ok(gate, "precondition: an open gate to answer");

  const done = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });
  const p = done.status === "running" ? await r.engine.advance(runId) : done;
  console.log(`via=mutation gate=approved status=${p.status} CHARGED=${r.charged()}`);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(r.charged(), 1);
});

test("AND THE POSTURE LEVER STILL EXISTS: naming the node clears the escalation, not clamps it", async () => {
  // `deescalate` DELETES `#escalations[scope]` before installing the ceiling, so a human
  // who names the added node removes the floor rather than hiding it. That deletion is
  // what keeps "no escalation is clampable" from being "no escalation is answerable" —
  // and it costs them the one thing that makes the judgement real: naming a node they
  // could only have learned about from the gate.
  //
  // Asserted on the POSTURE, not on the run, because a gate already raised is not
  // retracted by a later ceiling: the open gate still has to be answered.
  const r = rig(proposingCharge());
  const runId = await r.engine.submit({ graph: compile(growableSpec()), inputs: { goal: "grow" } });
  await r.engine.deescalate(runId, `run:${runId}`, "out", "reviewed the graph", { kind: "human", id: "u:alice" });
  await r.engine.advance(runId);
  await r.engine.deescalate(runId, `node:${runId}/pay`, "on", "looked at the new node, let it run", {
    kind: "human",
    id: "u:alice",
  });

  const events = [];
  for await (const ev of r.store.read(runId, 1)) events.push(ev);
  const p = foldRun(events);
  assert.ok(p);
  assert.equal(p.escalations[`node:${runId}/pay`], undefined, "the escalation is gone from the journal's fold");

  const fresh = new PolicyEngine({ granted: CAPS, systemFloor: "out" });
  fresh.restore({ escalations: p.escalations, ceilings: p.ceilings, spentUsd: 0 });
  assert.equal(fresh.effectivePosture(payReq(runId)), "on", "and the node now runs on-the-loop");
});

test("AND THE APPROVED RUN STILL REPLAYS — a new floor that only the recording has is a divergence", async () => {
  // The defeat attempt. A posture term the replay cannot re-derive shows up as
  // E_REPLAY_DIVERGENCE or as `match: false`, and this floor is derived from two things
  // the shadow run must reproduce for itself: the E10 escalation (re-derived by running
  // the recorded mutation) and the human ceiling (re-applied through `deescalate` by
  // `recordedCeilings`). If either arrived from memory rather than from the journal, this
  // is where it shows.
  const r = rig(proposingCharge());
  const graph = compile(growableSpec());
  const runId = await r.engine.submit({ graph, inputs: { goal: "grow" } });
  await r.engine.deescalate(runId, `run:${runId}`, "out", "reviewed the graph", { kind: "human", id: "u:alice" });
  const gated = await r.engine.advance(runId);
  const gate = Object.values(gated.gates).find((g) => g.state === "open");
  assert.ok(gate);
  const done = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });
  if (done.status === "running") await r.engine.advance(runId);
  const chargedWhileRecording = r.charged();
  assert.equal(chargedWhileRecording, 1, "precondition");

  const report = await replayRun({
    store: r.store,
    runId,
    graph,
    engine: {
      tools: r.engine.tools,
      functions: r.engine.functions,
      models: r.engine.models,
      resolver: resolver(),
      policy: { granted: CAPS, systemFloor: "out" },
      sleep: () => Promise.resolve(),
    },
  });
  console.log(`replay match=${String(report.match)} status=${report.replayed.status} CHARGED=${r.charged()}`);
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));
  assert.equal(r.charged(), chargedWhileRecording, "REPLAY TOOK NO MONEY");
});

test("THE FLOOR IS REBUILT BY FOLDING THE JOURNAL, not held in the process that raised it", async () => {
  // The seventh member of the class CLAUDE.md counts at six would be a floor that only a
  // live `PolicyEngine` remembers: restart the process and the un-clampable term is gone,
  // the ceiling wins again, and the money moves on the resumed run. Both halves of this
  // decision — the escalation and the ceiling — must come back out of the events alone.
  const r = rig(proposingCharge());
  const runId = await r.engine.submit({ graph: compile(growableSpec()), inputs: { goal: "grow" } });
  await r.engine.deescalate(runId, `run:${runId}`, "out", "reviewed the graph", { kind: "human", id: "u:alice" });
  await r.engine.advance(runId);

  const events = [];
  for await (const ev of r.store.read(runId, 1)) events.push(ev);
  const p = foldRun(events);
  assert.ok(p, "the journal folds");

  // A brand-new engine, seeded the way `Engine.#advanceSerially` seeds one on attach.
  const fresh = new PolicyEngine({ granted: CAPS, systemFloor: "out" });
  fresh.restore({ escalations: p.escalations, ceilings: p.ceilings, spentUsd: 0 });
  assert.equal(
    fresh.effectivePosture(payReq(runId)),
    "in",
    "the restored engine gates the added node, with the run ceiling restored alongside it",
  );
});
