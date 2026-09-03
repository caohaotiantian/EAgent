/**
 * A CHILD RUN'S BOUNDS ARE IN ITS OWN JOURNAL, OR A RESTART LIFTS THEM.
 *
 * Two bounds a parent imposes on a subgraph child lived only as arguments to `#contextFor`:
 *
 *   - `grantBound`, the capability allowlist the parent narrows for the child. Nothing in the
 *     CHILD's journal recorded it, so `Engine.attach(childRunId, childGraph)` rebuilt the child
 *     at its OWN declared capabilities: a `pay.charge` refused `E_CAP_DENIED` in the process
 *     that started the delegation CHARGED after a restart.
 *   - the dollar slice carved by `subgraph.budgetShare`. The resume branch passed `undefined`
 *     limits by design, with a comment asserting it "only matters when the process is new" —
 *     which is exactly when it is wrong. A child bounded to a fraction of a cent, refused
 *     `E_BUDGET_EXHAUSTED` in one process, spent after a restart.
 *
 * Both are CLAUDE.md's first non-negotiable — "if a decision reads a value, the journal must be
 * able to reconstruct that value, including across a restart" — and a child's fold reads only its
 * OWN log, so the parent's `subgraph.started.budgetUsd` cannot stand in for either. The fix puts
 * both on the child's `run.submitted.limits`/`.capabilities` and re-seeds them at the first
 * `advance`, which is the only door execution passes through.
 *
 * EACH CASE HAS ITS CONTROL. A restart-only assertion passes just as well when delegation is
 * broken, so every case here also drives the same graph without a restart and asserts the
 * ordinary outcome.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { digest } from "../../src/canonical.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/run/registry.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = (): number => 1_700_000_000_000;

const CHARGE: ToolManifestLite = {
  name: "pay.charge",
  version: "1.0",
  capabilities: ["pay"],
  irreversibility: "reversible_write",
  idempotent: true,
};
const TOOLS: Record<string, ToolManifestLite> = { "pay.charge": CHARGE };

const HUMAN = { kind: "human", subject: "u:ops", via: "cli" } as const;

/** The child parks on a gate so the process can be replaced while the run is live. */
function childSpec(after: "charge" | "spend"): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child", project: "lane-a", version: 1 },
    policy: { posture: "out", capabilities: ["pay"] },
    channels: {
      go: { type: "object", reduce: "replace" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: [],
    outputs: ["receipt"],
    nodes: [
      { id: n("gate"), type: "human_gate", writes: ["go"], humanGate: { ref: "oversight/child@stable" } },
      after === "charge"
        ? {
            id: n("act"),
            type: "tool",
            reads: ["go"],
            writes: ["receipt"],
            tool: { name: "pay.charge", version: "1.0", args: {} },
          }
        : {
            id: n("act"),
            type: "agent",
            reads: ["go"],
            writes: ["receipt"],
            agent: {
              profile: "agent_profile/w@stable",
              prompt: "prompt/w@stable",
              maxTurns: 1,
              tools: [],
              outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
            },
          },
    ],
    edges: [{ id: e("g2a"), from: n("gate"), to: n("act"), kind: "seq" }],
  } as unknown as GraphSpec;
}

function parentSpec(opts: { readonly caps?: readonly string[]; readonly share?: number }): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "lane-a", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 16, maxDepth: 2, maxFanout: 2, maxLoopIterations: 1 },
      ...(opts.caps === undefined ? {} : { capabilities: [...opts.caps] }),
    },
    channels: { result: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["result"],
    nodes: [
      {
        id: n("delegate"),
        type: "subgraph",
        writes: ["result"],
        subgraph: {
          ref: "graph/child@stable",
          inputs: {},
          outputs: { result: "receipt" },
          ...(opts.share === undefined ? {} : { budgetShare: opts.share }),
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function resolverFor(child: GraphSpec): ResourceResolver {
  // A DISTINCT DIGEST PER REF and a `document` hook, `skeleton.ts`'s shape: an agent node whose
  // prompt resolves to no document is refused `E_RESOURCE_NOT_FOUND` before any budget is read,
  // which would make the spend cases pass for a reason that has nothing to do with money.
  const minted = new Set<string>();
  return {
    resolve(ref) {
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      const pinned = digest({ fixture: "lane-a", ref });
      minted.add(pinned);
      return { ref, digest: pinned, channel: "stable" };
    },
    document: (pinned) => (minted.has(pinned) ? "Test instructions." : undefined),
    subgraph: (ref) => (ref === "graph/child@stable" ? child : undefined),
  };
}

interface Rig {
  readonly engine: Engine;
  readonly charged: number[];
}

function engineOn(store: MemoryStateStore, child: GraphSpec, budgetUsd: number): Rig {
  const charged: number[] = [];
  const tools = new ToolRegistry();
  const def: ToolDefinition = {
    ...CHARGE,
    description: "Take money.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      charged.push(1);
      return { content: "ok", writes: { receipt: { ok: true } } };
    },
  };
  tools.register(def);
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({ script: () => ({ text: JSON.stringify({ ok: true }), finishReason: "stop" }), pricePerMTok: 1 }),
    true,
  );
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: NOW,
    sleep: async () => {},
    resolver: resolverFor(child),
    policy: { granted: ["pay"], systemFloor: "out", budget: { runUsd: budgetUsd } },
  });
  return { engine, charged };
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

async function childOf(store: MemoryStateStore, parentRunId: RunId): Promise<RunId> {
  const started = (await journal(store, parentRunId)).find((ev) => ev.type === "subgraph.started");
  assert.ok(started !== undefined, "the parent must have journaled the delegation");
  return (started.payload as { childRunId: RunId }).childRunId;
}

/** Approve the child's own gate in `engine`, then drive the child. */
async function approveAndDrive(engine: Engine, childRunId: RunId): Promise<{ status: string; error?: unknown }> {
  const gates = await engine.openGates(childRunId);
  assert.equal(gates.length, 1, `the child must be parked on exactly one gate, saw ${JSON.stringify(gates)}`);
  const p = await engine.resolveGate(childRunId, {
    gateId: gates[0]!.gateId,
    decision: { kind: "approve" },
    actor: HUMAN,
    idempotencyKey: "k1",
  });
  return { status: p.status, error: p.error };
}

// ── 1 · the capability ceiling ──────────────────────────────────────────────

test("A PARENT'S CAPABILITY CEILING SURVIVES A RESTART OF THE CHILD", async () => {
  const child = childSpec("charge");
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, child, 1);

  // Compiled while the parent still declared `pay`, then the declaration is taken away — the
  // same shape `graph-capability-ceiling.test.ts` uses for a stale or hand-built `RunGraph`,
  // because GRAPH017 now folds the child into the parent and refuses this spec at compile.
  const compiled = compileOrThrow({ spec: parentSpec({ caps: ["pay"] }), resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  const bounded = { ...compiled, spec: { ...compiled.spec, policy: { ...compiled.spec.policy, capabilities: [] } } };

  const parentRunId = await first.engine.submit({ graph: bounded, inputs: {} });
  const parked = await first.engine.advance(parentRunId);
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));
  const childRunId = await childOf(store, parentRunId);

  // THE RESTART. A fresh Engine over the same store, reaching the CHILD run id directly — the
  // shape `loom approve <childRunId>` and `runClockTick` both have.
  const second = engineOn(store, child, 1);
  const childGraph = compileOrThrow({ spec: child, resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  second.engine.attach(childRunId, childGraph);
  await second.engine.rehydrateGates(childRunId);
  const after = await approveAndDrive(second.engine, childRunId);

  assert.equal(second.charged.length, 0, "the parent forbade `pay`; a restart is an automated path and may not widen that");
  assert.equal(after.status, "failed", `the child must refuse, saw ${after.status}`);
});

test("…and the CONTROL: the same delegation in one process refuses the same way", async () => {
  const child = childSpec("charge");
  const store = new MemoryStateStore({ now: NOW });
  const r = engineOn(store, child, 1);
  const compiled = compileOrThrow({ spec: parentSpec({ caps: ["pay"] }), resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  const bounded = { ...compiled, spec: { ...compiled.spec, policy: { ...compiled.spec.policy, capabilities: [] } } };
  const parentRunId = await r.engine.submit({ graph: bounded, inputs: {} });
  await r.engine.advance(parentRunId);
  const childRunId = await childOf(store, parentRunId);
  const after = await approveAndDrive(r.engine, childRunId);
  assert.equal(r.charged.length, 0);
  assert.equal(after.status, "failed");
});

test("…and a parent that DOES declare the capability still delegates and charges", async () => {
  // The ordinary case, so a fix that simply refuses every child would be caught here.
  const child = childSpec("charge");
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, child, 1);
  const graph = compileOrThrow({ spec: parentSpec({ caps: ["pay"] }), resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  const parentRunId = await first.engine.submit({ graph, inputs: {} });
  await first.engine.advance(parentRunId);
  const childRunId = await childOf(store, parentRunId);

  const second = engineOn(store, child, 1);
  const childGraph = compileOrThrow({ spec: child, resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  second.engine.attach(childRunId, childGraph);
  await second.engine.rehydrateGates(childRunId);
  const after = await approveAndDrive(second.engine, childRunId);
  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
  assert.equal(second.charged.length, 1, "otherwise the two cases above pass because delegation is broken");
});

// ── 2 · the budget slice ────────────────────────────────────────────────────

test("A CHILD'S BUDGET SLICE SURVIVES A RESTART", async () => {
  const child = childSpec("spend");
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, child, 1);
  const graph = compileOrThrow({ spec: parentSpec({ caps: ["pay"], share: 0.0001 }), resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  const parentRunId = await first.engine.submit({ graph, inputs: {} });
  const parked = await first.engine.advance(parentRunId);
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));
  const childRunId = await childOf(store, parentRunId);

  const second = engineOn(store, child, 1);
  const childGraph = compileOrThrow({ spec: child, resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  second.engine.attach(childRunId, childGraph);
  await second.engine.rehydrateGates(childRunId);
  const after = await approveAndDrive(second.engine, childRunId);

  assert.equal(after.status, "failed", `a child bounded to $0.0001 must not spend after a restart, saw ${after.status}`);
  const p = await second.engine.projection(childRunId);
  assert.equal(p?.usage.costUsd, 0, "and it must not have paid a provider on the way to failing");
});

test("…and the CONTROL: the same slice refuses in the process that carved it", async () => {
  const child = childSpec("spend");
  const store = new MemoryStateStore({ now: NOW });
  const r = engineOn(store, child, 1);
  const graph = compileOrThrow({ spec: parentSpec({ caps: ["pay"], share: 0.0001 }), resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  const parentRunId = await r.engine.submit({ graph, inputs: {} });
  await r.engine.advance(parentRunId);
  const childRunId = await childOf(store, parentRunId);
  const after = await approveAndDrive(r.engine, childRunId);
  assert.equal(after.status, "failed");
});

test("…and a child with room still spends it after a restart", async () => {
  // The ordinary case for the budget half: absent a slice small enough to bite, a restarted
  // child must still be able to run. A fix that seeded a zero ceiling would fail here.
  const child = childSpec("spend");
  const store = new MemoryStateStore({ now: NOW });
  const first = engineOn(store, child, 1);
  const graph = compileOrThrow({ spec: parentSpec({ caps: ["pay"], share: 0.5 }), resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  const parentRunId = await first.engine.submit({ graph, inputs: {} });
  await first.engine.advance(parentRunId);
  const childRunId = await childOf(store, parentRunId);

  const second = engineOn(store, child, 1);
  const childGraph = compileOrThrow({ spec: child, resolver: resolverFor(child), tools: TOOLS, tenantCapabilities: ["pay"] });
  second.engine.attach(childRunId, childGraph);
  await second.engine.rehydrateGates(childRunId);
  const after = await approveAndDrive(second.engine, childRunId);
  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
});
