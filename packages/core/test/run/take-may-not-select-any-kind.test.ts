/**
 * A PRODUCER'S `take` MAY NOT SELECT AN EDGE CONTROL DOES NOT FLOW ALONG.
 *
 * `#edgesToTake` returned `outcome.take` filtered ONLY for a spent `loop` bound, so a router
 * could name an edge of ANY kind and `#activate` would fall through to the generic `task.ready`
 * for it. A `compensation` edge is the one that costs something: it is a DECLARATION the
 * compiler checks (GRAPH012) and never a route the executor follows, so `graph/mutate.ts`'s
 * dominance rule drops it from `traversable` — correctly, given the switch — and a router that
 * names one carries control straight past a human gate.
 *
 * Reproduced by the `wave2-graph` lane at `8fd58f5` on the mutation below: `ok = true`, the
 * human REJECTED, and `ran = ["note.append"]` against `ran = []` in the unmutated control.
 * The take path predates that branch, so an AUTHORED graph reaches it with no mutation at all —
 * which is the second test here.
 *
 * The ordinary half is the other two: a router still routes along a `seq` and along a
 * `conditional` edge (a router's selection substitutes for the `when`), and a compensation still
 * fires through the mechanism it actually has — `planCompensation` over the journal, when a run
 * fails — which is what makes the refusal a refusal of ROUTING and not of compensation.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type MockScript,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const CAPS = ["fs:write", "graph:mutate"];

/** Reversible on purpose: the class whose only oversight is the gate an author put in front. */
const NOTE: ToolManifestLite = {
  name: "note.append",
  version: "1.0",
  capabilities: ["fs:write"],
  irreversibility: "reversible_write",
  idempotent: true,
  // Declared so a `compensation` edge naming this node satisfies GRAPH012 — the point being
  // that satisfying GRAPH012 is all a compensation edge ever does.
  compensation: { tool: "note.undo" },
};
const UNDO: ToolManifestLite = {
  name: "note.undo",
  version: "1.0",
  capabilities: ["fs:write"],
  irreversibility: "reversible_write",
  idempotent: true,
};
const MANIFESTS = { "note.append": NOTE, "note.undo": UNDO };

interface Rig {
  readonly engine: Engine;
  readonly ran: string[];
  readonly undone: string[];
}

function rig(script: MockScript = () => ({ text: JSON.stringify({ plan: { ok: true } }), finishReason: "stop" })): Rig {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();
  const ran: string[] = [];
  const undone: string[] = [];

  tools.register({
    ...NOTE,
    description: "Append a note.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      ran.push("note.append");
      // `details` is the undo record — `#compensate` refuses to dispatch an undo whose
      // arguments the journal cannot reconstruct, so without this the rollback control below
      // would pass for the wrong reason.
      return { content: "appended", details: { note: "n" } };
    },
  } as ToolDefinition);
  tools.register({
    ...UNDO,
    description: "Undo the note.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      undone.push("note.undo");
      return { content: "undone" };
    },
  } as ToolDefinition);
  tools.register({
    name: "boom",
    version: "1.0",
    description: "always fails",
    capabilities: [],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object", properties: {} },
    execute: () => {
      throw Object.assign(new Error("boom"), { code: "E_PROVIDER_UNAVAILABLE", class: "unavailable", retryable: false });
    },
  } as ToolDefinition);

  functions.register("function/plan@stable", () => {
    ran.push("plan");
    return { writes: { plan: { ok: true } } } as never;
  });
  functions.register("function/detail@stable", () => {
    ran.push("done");
    return {} as never;
  });
  models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);

  return {
    engine: new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models,
      now,
      sleep: async () => {},
      resolver: resolver(),
      policy: { granted: CAPS, systemFloor: "out", budget: { runUsd: 1 } },
    }),
    ran,
    undone,
  };
}

const BASE = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "take-kind", project: "test", version: 1 },
  policy: {
    posture: "out",
    expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
    capabilities: CAPS,
    budget: { costUsd: 1 },
  },
  channels: {
    goal: { type: "string", reduce: "replace" },
    plan: { type: "object", reduce: "replace" },
    out: { type: "object", reduce: "replace" },
  },
  inputs: ["goal"],
  outputs: ["out"],
};

const GATE = { id: "gate", type: "human_gate", reads: ["plan"], writes: [], humanGate: { ref: "oversight/sre-prod-change@stable" } };
const PAY = { id: "pay", type: "tool", reads: ["plan"], writes: ["out"], tool: { name: "note.append", version: "1.0", args: {} } };

/** `plan -> gate -> pay`, with `plan` a function so nothing here needs a model. */
function authored(hopEdgeKind: string, extra: Record<string, unknown> = {}, hopTo = "pay"): GraphSpec {
  return {
    ...BASE,
    nodes: [
      { id: "plan", type: "function", reads: ["goal"], writes: ["plan"], function: { ref: "function/plan@stable" } },
      GATE,
      PAY,
      {
        id: "hop",
        type: "router",
        reads: ["plan"],
        writes: [],
        router: { mode: "expression", cases: [{ when: "has(plan)", take: ["m1"] }], fallbackEdge: "m1" },
      },
      { id: "done", type: "function", reads: ["plan"], writes: [], function: { ref: "function/detail@stable" } },
    ],
    edges: [
      { id: "a0", from: "plan", to: "gate", kind: "seq" },
      { id: "a1", from: "gate", to: "pay", kind: "seq" },
      { id: "m0", from: "plan", to: "hop", kind: "seq" },
      { id: "m1", from: "hop", to: hopTo, kind: hopEdgeKind, ...extra },
    ],
  } as unknown as GraphSpec;
}

const compiled = (spec: GraphSpec): RunGraph =>
  compileOrThrow({ spec, resolver: resolver(), tools: MANIFESTS, tenantCapabilities: CAPS });

async function rejectAtTheGate(r: Rig, graph: RunGraph): Promise<{ status: string; codes: string[] }> {
  const runId = await r.engine.submit({ graph, inputs: { goal: "go" } });
  let p = await r.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
  }
  const codes = Object.values(p.tasks)
    .filter((t) => t.state === "failed")
    .map((t) => t.error?.code ?? "");
  return { status: p.status, codes };
}

test("AN AUTHORED ROUTER MAY NOT TAKE A `compensation` EDGE PAST THE GATE — no mutation anywhere", async () => {
  const r = rig();
  const graph = compiled(authored("compensation", { compensates: "pay" }));
  const { status, codes } = await rejectAtTheGate(r, graph);

  assert.deepEqual(
    r.ran.filter((x) => x === "note.append"),
    [],
    "the human rejected, so the tool the gate stands in front of must not have run",
  );
  assert.notEqual(status, "succeeded", `the run must not report success: ${status}`);
  assert.ok(
    codes.includes(CODES.E_ROUTE_INVALID),
    `the refusal must be loud and name the route: ${codes.join(", ") || "no failed task"}`,
  );
});

/**
 * The lane's exact mutation shape, driven through a model that proposes it.
 *
 * `graph/mutate.ts` still ADMITS this — `traversable` drops `compensation` and that is the
 * non-goal of this fix — so the mutation compiles and the run reaches the gate. What must hold
 * is the executor's answer at the moment the router names the edge.
 */
const GRAFTER: MockScript = () => ({
  text: JSON.stringify({
    plan: { ok: true },
    mutation: {
      addNodes: [
        {
          id: "hop",
          type: "router",
          reads: ["plan"],
          writes: [],
          router: { mode: "expression", cases: [{ when: "has(plan)", take: ["m1"] }], fallbackEdge: "m1" },
        },
      ],
      addEdges: [
        { id: "m0", from: "plan", to: "hop", kind: "seq" },
        { id: "m1", from: "hop", to: "pay", kind: "compensation", compensates: "pay" },
      ],
    },
  }),
  finishReason: "stop",
});

test("AND NEITHER MAY A ROUTER A MODEL GRAFTED IN, which is the shape the lane reproduced", async () => {
  const r = rig(GRAFTER);
  const graph = compiled({
    ...BASE,
    nodes: [
      {
        id: "plan",
        type: "agent",
        reads: ["goal"],
        writes: ["plan"],
        agent: { profile: "agent_profile/planner@stable", prompt: "prompt/plan@stable", maxTurns: 2, canMutate: true, outputSchema: { type: "object" } },
      },
      GATE,
      PAY,
    ],
    edges: [
      { id: "a0", from: "plan", to: "gate", kind: "seq" },
      { id: "a1", from: "gate", to: "pay", kind: "seq" },
    ],
  } as unknown as GraphSpec);
  const { status } = await rejectAtTheGate(r, graph);

  assert.deepEqual(
    r.ran.filter((x) => x === "note.append"),
    [],
    "the human rejected, and a grafted compensation edge is not a way around that",
  );
  assert.notEqual(status, "succeeded", `the run must not report success: ${status}`);
});

test("THE ORDINARY HALF: a router still takes a `seq` edge, and still takes a `conditional` one", async () => {
  for (const [kind, extra] of [
    ["seq", {}],
    // A `conditional` selected by a router is NOT re-evaluated against its `when` — the router
    // already chose. `when: "false"` is what makes that visible: it must still be taken.
    ["conditional", { when: "false" }],
  ] as const) {
    const r = rig();
    const graph = compiled(authored(kind, extra, "done"));
    const runId = await r.engine.submit({ graph, inputs: { goal: "go" } });
    let p = await r.engine.advance(runId);
    assert.equal(p.status, "awaiting_gate", `${kind}: ${JSON.stringify(p.error ?? {})}`);
    assert.deepEqual(r.ran.filter((x) => x === "note.append"), [], `${kind}: the gate holds the tool until it is answered`);

    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
    assert.equal(p.status, "succeeded", `${kind}: ${JSON.stringify(p.error ?? {})}`);
    assert.ok(r.ran.includes("done"), `${kind}: the router's own edge must still carry control`);
    assert.ok(r.ran.includes("note.append"), `${kind}: and an approved gate still lets the work through`);
  }
});

test("THE OTHER ORDINARY HALF: a compensation still fires through the mechanism it has", async () => {
  // `pay -> bad`, no compensation edge and no router: the run fails and `planCompensation`
  // undoes what the journal says happened. The refusal above is about ROUTING, and this is the
  // control that says compensation itself is untouched.
  const r = rig();
  const graph = compiled({
    ...BASE,
    nodes: [
      { id: "plan", type: "function", reads: ["goal"], writes: ["plan"], function: { ref: "function/plan@stable" } },
      PAY,
      { id: "bad", type: "tool", reads: ["plan"], writes: ["out"], tool: { name: "boom", version: "1.0", args: {} }, retry: { maxAttempts: 1 } },
    ],
    edges: [
      { id: "a0", from: "plan", to: "pay", kind: "seq" },
      { id: "a1", from: "pay", to: "bad", kind: "seq" },
    ],
  } as unknown as GraphSpec);
  const runId = await r.engine.submit({ graph, inputs: { goal: "go" } });
  let status = "running";
  for (let i = 0; i < 12; i++) {
    const p = await r.engine.advance(runId);
    status = p.status;
    if (p.status === "succeeded" || p.status === "failed") break;
  }
  assert.equal(status, "failed");
  assert.deepEqual(r.ran.filter((x) => x === "note.append"), ["note.append"], "the tool ran, so there is something to undo");
  assert.deepEqual(r.undone, ["note.undo"], "and the failed run undid it — journal-driven, not edge-driven");
});
