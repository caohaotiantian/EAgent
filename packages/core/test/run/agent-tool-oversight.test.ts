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
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

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

function rig(): Rig {
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
        turn === 0
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

test("rewind refuses to cross an irreversible tool an AGENT invoked", async () => {
  const r = rig();
  const runId = await r.engine.submit({ graph: compiled(), inputs: { seed: "go" } });
  await r.engine.advance(runId);

  // Whatever the run did, a rewind to the very beginning must not silently succeed once
  // an uncompensated irreversible action has been committed.
  if (r.deletions.length === 0) return; // the gate arm above already holds the line

  await assert.rejects(
    () => r.engine.rewind(runId, 1 as never, "operator asked to undo"),
    /irreversible|compensation/i,
    "rewind must refuse to cross an uncompensated irreversible effect, whoever invoked it",
  );
});
