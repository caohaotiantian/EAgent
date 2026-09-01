/**
 * An agent node's declared tools are part of its oversight surface.
 *
 * The engine used to ask `node.tool` how dangerous a node was. An `agent` node has no
 * `node.tool` — it has `agent.tools` — so every agent node answered `read_only`, and the
 * `max` fold that computes the posture never saw the term that would have raised it. The
 * same blind spot reached `rewind`, which scanned committed tasks for irreversible tools
 * and looked only at `node.tool`.
 *
 * These tests pin the tools a node can REACH, not the one it names.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { Engine } from "../../src/run/engine.ts";
import type { RunProjection } from "../../src/run/projection.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import { OPERATOR } from "./operator.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;

/** Irreversible, and — deliberately — declaring no compensation. */
const DANGER: ToolManifestLite = {
  name: "danger.delete",
  version: "1.0",
  capabilities: ["danger:write"],
  irreversibility: "irreversible",
  idempotent: false,
};

const MANIFESTS: Record<string, ToolManifestLite> = { "danger.delete": DANGER };

/** One agent node whose reachable tool set contains an irreversible tool. */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "agent-reaches-danger", project: "demo", version: 1 },
    policy: {
      posture: "out",
      budget: { costUsd: 1, tokens: 100_000, wallMs: 60_000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      capabilities: ["danger:write"],
    },
    channels: {
      seed: { type: "string", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["out"],
    nodes: [
      {
        id: n("act"),
        type: "agent",
        reads: ["seed"],
        writes: ["out"],
        agent: {
          profile: "agent_profile/actor@stable",
          prompt: "prompt/act@stable",
          maxTurns: 3,
          tools: ["danger.delete"],
          outputSchema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] },
        },
        timeoutMs: 30_000,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly deletions: string[];
}

function rig(opts: { callTool?: boolean } = {}): Rig {
  const callTool = opts.callTool ?? true;
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const deletions: string[] = [];

  const danger: ToolDefinition = {
    ...DANGER,
    description: "Delete something, permanently.",
    parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
    execute: (args) => {
      deletions.push(String(args["target"]));
      return { content: `deleted ${String(args["target"])}` };
    },
  };
  tools.register(danger);

  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: (_req, turn) =>
        turn === 0 && callTool
          ? { toolCalls: [{ id: "c0", name: "danger.delete", arguments: { target: "prod-db" } }], finishReason: "tool_use" }
          : { text: JSON.stringify({ done: true }), finishReason: "stop" },
      pricePerMTok: 1,
    }),
    true,
  );

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now,
    maxParallelism: 4,
    policy: { granted: ["danger:write"], budget: { runUsd: 1 } },
  });

  return { engine, store, deletions };
}

function compiled(): ReturnType<typeof compileOrThrow> {
  return compileOrThrow({
    spec: spec(),
    resolver: resolver() as ResourceResolver,
    tools: MANIFESTS,
    tenantCapabilities: ["danger:write"],
  });
}

async function events(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

test("an agent node that can reach an irreversible tool does not plan at posture `out`", () => {
  const plan = compiled().plans[n("act")];
  assert.ok(plan !== undefined, "the agent node must have a plan");
  assert.notEqual(
    plan.posture,
    "out",
    "an agent that can call an irreversible tool must not compile to the weakest posture",
  );
});

test("an irreversible tool called BY A MODEL is gated, not silently executed", async () => {
  const r = rig();
  const runId = await r.engine.submit({ graph: compiled(), inputs: { seed: "go" } });
  const p = await r.engine.advance(runId);

  const log = await events(r.store, runId);
  const gates = log.filter((ev) => ev.type === "gate.raised");

  assert.deepEqual(
    r.deletions,
    [],
    "the tool body must not run before a human has seen it",
  );
  assert.ok(
    gates.length > 0 || p.status === "awaiting_gate",
    `an irreversible tool reached through an agent must raise a gate; status was "${p.status}" with ${gates.length} gate(s)`,
  );
});

/** Approve whatever gate is open, as a human, and drain the run. */
async function approveAndDrain(r: Rig, runId: RunId): Promise<RunProjection> {
  let p = await r.engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "awaiting_gate"; i++) {
    const gate = Object.values(p.gates).find((g) => g.state === "open");
    if (gate === undefined) break;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: `k${String(i)}`,
    });
    p = await r.engine.advance(runId);
  }
  return p;
}

test("APPROVING THE GATE AUTHORIZES THE WORK — the model's tool then actually runs", async () => {
  const r = rig();
  const runId = await r.engine.submit({ graph: compiled(), inputs: { seed: "go" } });
  await approveAndDrain(r, runId);

  assert.deepEqual(
    r.deletions,
    ["prod-db"],
    "a human said yes to this node acting; the action it authorized must happen",
  );
});

test("rewind refuses to cross an irreversible tool an AGENT actually invoked", async () => {
  const r = rig();
  const runId = await r.engine.submit({ graph: compiled(), inputs: { seed: "go" } });
  await approveAndDrain(r, runId);
  assert.deepEqual(r.deletions, ["prod-db"], "precondition: the action ran");

  await assert.rejects(
    () => r.engine.rewind(runId, 1 as never, "operator asked to undo", OPERATOR),
    /irreversible|compensation/i,
    "rewind must refuse to cross an uncompensated irreversible effect, whoever invoked it",
  );
});

test("rewind is NOT blocked by a tool the agent only declared", async () => {
  const r = rig({ callTool: false });
  const runId = await r.engine.submit({ graph: compiled(), inputs: { seed: "go" } });
  const p = await approveAndDrain(r, runId);
  assert.equal(p.status, "succeeded");
  assert.deepEqual(r.deletions, [], "precondition: nothing irreversible was called");

  // Declaring a dangerous tool and never reaching for it must not make the run
  // permanently un-rewindable — the scan is over what happened, not over what was listed.
  await r.engine.rewind(runId, 1 as never, "operator asked to undo", OPERATOR);
});

test("an UNAPPROVED agent turn is refused, and the refusal is journaled", async () => {
  const r = rig();
  const runId = await r.engine.submit({ graph: compiled(), inputs: { seed: "go" } });
  await r.engine.advance(runId); // stops at the gate; nobody answers it

  const log = await events(r.store, runId);
  assert.deepEqual(r.deletions, [], "no approval, no action");
  assert.ok(
    log.some((ev) => ev.type === "gate.raised"),
    "the node must ask before a model may use an irreversible tool",
  );
});
