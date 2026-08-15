/**
 * The two rungs of the escalation ladder nothing reaches.
 *
 * `escalation.test.ts` drives E1–E7 through real runs and asserts the rule each one
 * names in the journal. Two rows of the table are not in that file, and neither is
 * reachable by the graph it uses:
 *
 *   - **E9 `operator`** needs a run at posture `on` holding an intervention window and
 *     a human who interrupts inside it. `oversight.test.ts` builds exactly that
 *     situation and asserts the money is not taken — but never that the interruption
 *     leaves a posture behind, which is the half that applies to whatever the run does
 *     NEXT rather than to the action that was caught.
 *   - **E10 `mutation_introduced_irreversible`** needs an agent that grows the graph.
 *     `mutate.test.ts` asserts the added node gates, but `email.send` is
 *     `externally_visible` and would gate from the class default alone — so that test
 *     passes with the escalation deleted, and the node-scoped posture that outlives the
 *     gate is unpinned.
 *
 * Both rules are node-level evidence about a run that has already surprised somebody,
 * and both are recorded rather than inferred: `policy.escalated{rule}` is how an
 * operator answers "why is this suddenly asking me?".
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { ESCALATION_RULES } from "../../src/run/escalation.ts";
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

interface Escalation {
  readonly rule: string;
  readonly from: string;
  readonly to: string;
  readonly scope: string;
}

async function escalations(store: MemoryStateStore, runId: RunId): Promise<Escalation[]> {
  const out: Escalation[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "policy.escalated") out.push(ev.payload as unknown as Escalation);
  }
  return out;
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

// ── E9 — an operator interrupted during an intervention window ───────────────

const PAY: ToolManifestLite = {
  name: "pay.charge",
  version: "1.0",
  capabilities: ["pay:write"],
  irreversibility: "irreversible",
  idempotent: false,
};

function chargeSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "interruptible-charge", project: "test", version: 1 },
    policy: { capabilities: ["pay:write"] },
    channels: { amount: { type: "number", reduce: "replace" }, receipt: { type: "object", reduce: "replace" } },
    inputs: ["amount"],
    outputs: ["receipt"],
    nodes: [
      {
        id: n("charge"),
        type: "tool",
        reads: ["amount"],
        writes: ["receipt"],
        tool: { name: "pay.charge", version: "1.0", args: { amount: "${amount}" } },
        unhandled: true,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface ChargeRig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly charged: () => number;
}

/** A rig whose intervention window blocks until the test cancels the run. */
function chargeRig(): ChargeRig {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  let charged = 0;
  tools.register({
    ...PAY,
    description: "Takes money. Cannot be undone.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: () => {
      charged++;
      return { content: "charged", writes: { receipt: { ok: true } } };
    },
  } satisfies ToolDefinition);

  return {
    engine: new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions: new FunctionRegistry(),
      models: new ModelRegistry(),
      now,
      policy: { granted: ["pay:write"] },
      // No timer: the hold ends when the run aborts, so nothing here races a clock.
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    }),
    store,
    charged: () => charged,
  };
}

const compileCharge = (): RunGraph =>
  compileOrThrow({
    spec: chargeSpec(),
    resolver: resolver(),
    tools: { "pay.charge": PAY },
    tenantCapabilities: ["pay:write"],
  });

test("E9 — AN INTERRUPTED WINDOW LEAVES A POSTURE BEHIND, not just a stopped action", async () => {
  // The judgement an operator made when they hit stop applies to whatever this run does
  // next. Without the escalation, the only trace is a cancelled run, and a resumed
  // branch or a follow-up would run at the posture that let this happen.
  const r = chargeRig();
  const runId = await r.engine.submit({ graph: compileCharge(), inputs: { amount: 10 } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "incident window", { kind: "human", id: "u:alice" });

  const running = r.engine.advance(runId);
  await new Promise((res) => setImmediate(res));
  const held = await journal(r.store, runId);
  assert.ok(
    held.some((ev) => ev.type === "action.pending"),
    "precondition: the run must actually be inside an intervention window",
  );

  await r.engine.cancel(runId, "supervisor stopped it");
  await running;

  assert.equal(r.charged(), 0, "precondition: the effect never started");
  const fired = await escalations(r.store, runId);
  const operator = fired.find((x) => x.rule.startsWith("operator"));
  assert.ok(operator, `expected the operator rule; got [${fired.map((x) => x.rule).join(", ")}]`);
  assert.equal(operator.to, ESCALATION_RULES.operator.to, "E9 raises to the posture its row declares");
  assert.equal(operator.scope, `run:${runId}`, "and it is a RUN-scoped judgement, not one about that node");
});

test("E9 — a window that elapses untouched escalates nothing", async () => {
  // The rule fires on the INTERRUPTION, not on the window. A hold that nobody used is
  // the system working, and an escalation there would fire on every held action.
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...PAY,
    description: "Takes money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: () => ({ content: "charged", writes: { receipt: { ok: true } } }),
  } satisfies ToolDefinition);

  const engine = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    policy: { granted: ["pay:write"] },
    sleep: () => Promise.resolve(),
  });

  const runId = await engine.submit({ graph: compileCharge(), inputs: { amount: 10 } });
  await engine.deescalate(runId, `run:${runId}`, "on", "incident window", { kind: "human", id: "u:alice" });
  const p = await engine.advance(runId);

  assert.equal(p.status, "succeeded");
  assert.deepEqual(
    (await escalations(store, runId)).filter((x) => x.rule.startsWith("operator")),
    [],
  );
});

// ── E10 — a runtime mutation added a hard-to-undo node ───────────────────────

const MUTATION_TOOLS: Record<string, ToolManifestLite> = {
  "note.append": {
    name: "note.append",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
  },
  "email.send": {
    name: "email.send",
    version: "1.0",
    capabilities: ["net:send"],
    irreversibility: "externally_visible",
    idempotent: false,
  },
};

const MUTATION_CAPS = ["fs:write", "net:send", "graph:mutate"];

/** A one-node graph whose planner may grow it. */
function growableSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "growable-escalation", project: "test", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
      capabilities: MUTATION_CAPS,
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      plan: { type: "object", reduce: "replace" },
      note: { type: "string", reduce: "replace" },
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

/** A proposal that adds a node with the named tool behind it. */
function proposing(tool: "email.send" | "note.append", id: string): MockScript {
  const addNodes: NodeSpec[] = [
    {
      id: n(id),
      type: "tool",
      reads: ["plan"],
      ...(tool === "note.append" ? { writes: ["note"] } : {}),
      tool: { name: tool, version: "1.0", args: {} },
      unhandled: true,
    } as unknown as NodeSpec,
  ];
  const addEdges: EdgeSpec[] = [{ id: e("m0"), from: n("plan"), to: n(id), kind: "seq" }];
  return () => ({ text: JSON.stringify({ plan: {}, mutation: { addNodes, addEdges } }), finishReason: "stop" });
}

interface MutationRig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly ran: string[];
}

function mutationRig(script: MockScript): MutationRig {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const ran: string[] = [];
  for (const name of ["note.append", "email.send"] as const) {
    tools.register({
      ...MUTATION_TOOLS[name]!,
      description: name,
      parameters: { type: "object" },
      execute: () => {
        ran.push(name);
        return { content: "done", writes: { note: "done" } };
      },
    } satisfies ToolDefinition);
  }

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
      policy: { granted: MUTATION_CAPS, systemFloor: "out" },
    }),
    store,
    ran,
  };
}

const compileGrowable = (): RunGraph =>
  compileOrThrow({
    spec: growableSpec(),
    resolver: resolver(),
    tools: MUTATION_TOOLS,
    tenantCapabilities: MUTATION_CAPS,
  });

test("E10 — A GRAPH THAT GREW A HARD-TO-UNDO NODE SAYS SO, in the journal, by name", async () => {
  // The gate alone proves nothing here: `email.send` is `externally_visible`, so the
  // class default would gate it in an authored graph too. What the escalation adds is
  // the RECORD that this node arrived at run time — and a node-scoped posture that
  // outlives the gate rather than being recomputed from the spec.
  const r = mutationRig(proposing("email.send", "notify"));
  const runId = await r.engine.submit({ graph: compileGrowable(), inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", "precondition: the added node stops for a human");
  assert.deepEqual(r.ran, [], "precondition: and it has not run");

  const fired = await escalations(r.store, runId);
  const rule = fired.find((x) => x.rule.startsWith("mutation_introduced_irreversible"));
  assert.ok(rule, `expected E10; got [${fired.map((x) => x.rule).join(", ")}]`);
  assert.equal(rule.to, ESCALATION_RULES.mutation_introduced_irreversible.to);
  assert.equal(
    rule.scope,
    `node:${runId}/notify`,
    "scoped to the ADDED node: the rest of the graph was already reviewed and did not become riskier",
  );
  assert.equal(p.escalations[`node:${runId}/notify`], "in", "and it folds into the run's durable posture");
});

test("E10 — a mutation that adds only reversible work escalates nothing", async () => {
  // The rule is about what the graph GREW, not about growing. A mutation that adds an
  // undoable step is the ordinary case and must stay silent, or E10 fires on every
  // adaptive run and stops meaning anything.
  const r = mutationRig(proposing("note.append", "jot"));
  const runId = await r.engine.submit({ graph: compileGrowable(), inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.ran, ["note.append"], "precondition: the added node really did run");
  assert.deepEqual(
    (await escalations(r.store, runId)).filter((x) => x.rule.startsWith("mutation_introduced_irreversible")),
    [],
  );
});
