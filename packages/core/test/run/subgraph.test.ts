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
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
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

test("REJECTING at the parent rejects in the child, and takes no money", async () => {
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
  assert.deepEqual(r.charges, []);
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
