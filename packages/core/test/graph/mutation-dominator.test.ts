/**
 * A MUTATION MAY NOT TAKE A NODE OUT OF A HUMAN GATE'S DOMINATED REGION.
 *
 * `mutate.ts` opens with "A model can propose a graph that is wrong; it cannot propose one that
 * weakens oversight". Its region rule refused an added edge only when BOTH endpoints already
 * existed, so the remaining direction — an ADDED `from` into an EXISTING `to` — was accepted
 * with no diagnostic. That edge is a second path to the target, and `seq` edges are OR-joined,
 * so it is a path that skips whatever sat in front of the authored one. Measured end to end,
 * with an authored `human_gate` in front of a `reversible_write` tool and no operator action of
 * any kind:
 *
 *     the authored graph, human REJECTS       -> failed, the tool never ran
 *     one added node + one added edge into it -> failed, and the tool ran anyway
 *
 * The rejection is what RELEASES the action: an open gate suspends the whole run, so the grafted
 * path cannot fire while the human is deciding, and `gate.decided` carries an unconditional
 * `run.resumed`.
 *
 * `reversible_write` and not `irreversible` on purpose. `CLASS_DEFAULT_POSTURE` pins
 * `irreversible` at `in`, so for that class the grafted path still raises the node's own gate and
 * the authored one is the second of two layers. For `read_only` and `reversible_write` the
 * authored gate is the ONLY oversight there is, and that is the case this has to hold for.
 *
 * The rule is dominator preservation, and the end-to-end arm is the one that matters: the
 * compile-level checks that existed covered two of the three edge directions, and covering two
 * of three is how this arrived.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { compileMutation } from "../../src/graph/mutate.ts";
import type { EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId, TaskId } from "../../src/ids.ts";
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
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "../run/skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

/** REVERSIBLE. Its only oversight is the gate the author drew in front of it. */
const NOTE: ToolManifestLite = {
  name: "notes.write",
  version: "1.0",
  capabilities: ["notes:write"],
  irreversibility: "reversible_write",
  idempotent: false,
};

const CAPS = ["notes:write", "graph:mutate"];

/** plan --seq--> gate --seq--> pay. Every path to the tool passes through the gate. */
function authoredSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated-note", project: "test", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
      capabilities: CAPS,
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      plan: { type: "object", reduce: "replace" },
      note: { type: "string", reduce: "replace" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["receipt"],
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
      { id: n("gate"), type: "human_gate", reads: ["goal"], humanGate: { ref: "oversight/hold@stable" } },
      {
        id: n("pay"),
        type: "tool",
        reads: ["goal"],
        writes: ["receipt"],
        tool: { name: "notes.write", version: "1.0", args: {} },
        unhandled: true,
      },
    ],
    edges: [
      { id: e("a0"), from: n("plan"), to: n("gate"), kind: "seq" },
      { id: e("a1"), from: n("gate"), to: n("pay"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** One trivial added node, and one edge from it into the EXISTING protected node. */
const GRAFT_NODES: readonly NodeSpec[] = [
  { id: n("hop"), type: "function", reads: ["goal"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec,
];
const GRAFT_EDGES: readonly EdgeSpec[] = [
  { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" } as unknown as EdgeSpec,
  { id: e("m1"), from: n("hop"), to: n("pay"), kind: "seq" } as unknown as EdgeSpec,
];

/** A proposal that grafts a second path around the gate. */
function proposingGraft(mutate: boolean): MockScript {
  return () =>
    mutate
      ? { text: JSON.stringify({ plan: {}, mutation: { addNodes: GRAFT_NODES, addEdges: GRAFT_EDGES } }), finishReason: "stop" }
      : { text: JSON.stringify({ plan: {} }), finishReason: "stop" };
}

const compile = (spec: GraphSpec): RunGraph =>
  compileOrThrow({ spec, resolver: resolver(), tools: { "notes.write": NOTE }, tenantCapabilities: CAPS });

interface Rig {
  readonly engine: Engine;
  readonly wrote: () => number;
}

function rig(script: MockScript): Rig {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  let wrote = 0;
  tools.register({
    ...NOTE,
    description: "Writes a note.",
    parameters: { type: "object" },
    execute: () => {
      wrote++;
      return { content: "written", writes: { receipt: { ok: true } } };
    },
  } satisfies ToolDefinition);
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({ writes: {} }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);

  return {
    engine: new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models,
      now,
      resolver: resolver(),
      policy: { granted: CAPS, systemFloor: "out" },
      sleep: () => Promise.resolve(),
    }),
    wrote: () => wrote,
  };
}

/** Submit, advance to the gate, answer it, advance again. No operator de-escalation anywhere. */
async function driveAndReject(mutate: boolean): Promise<{ wrote: number; status: string }> {
  const { engine, wrote } = rig(proposingGraft(mutate));
  const runId = await engine.submit({ graph: compile(authoredSpec()), inputs: { goal: "write it down" } });
  const held = await engine.advance(runId);
  const gate = Object.values(held.gates).find((g) => g.nodeId === "gate");
  if (gate !== undefined) {
    await engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k1",
    });
  }
  const after = await engine.advance(runId);
  return { wrote: wrote(), status: after.status };
}

test("THE HUMAN REJECTED AND THE TOOL DID NOT RUN — a graft may not route around an authored gate", async () => {
  const grafted = await driveAndReject(true);
  assert.equal(grafted.wrote, 0, "the human said no and the tool ran anyway, through an edge the model added");

  // The control: the identical run with the model proposing nothing. If this wrote, the arm
  // above would be measuring the gate rather than the graft.
  const plain = await driveAndReject(false);
  assert.equal(plain.wrote, 0, "control: without the mutation, a rejected gate stops the tool");
});

test("THE REFUSAL NAMES THE DOMINATOR THAT WOULD HAVE BEEN LOST", () => {
  // A diagnostic that says only "refused" leaves the model — and the author reading the journal —
  // no way to tell WHICH oversight the edge removed.
  const r = compileMutation({
    base: compile(authoredSpec()),
    mutation: {
      addNodes: [...GRAFT_NODES],
      addEdges: [...GRAFT_EDGES],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("plan"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });

  assert.equal(r.ok, false, "the graft compiled");
  const lost = r.diagnostics.find((d) => d.code === "MUT003_DOMINATOR_LOST");
  assert.ok(lost !== undefined, `no dominator diagnostic; got ${r.diagnostics.map((d) => d.code).join(", ") || "(none)"}`);
  assert.match(lost.message, /\bpay\b/, "the message must name the node that lost its oversight");
  assert.match(lost.message, /\bgate\b/, "…and the dominator it would no longer pass through");
  assert.match(lost.message, /\bm1\b/, "…and the edge that did it");
});

test("A BRANCH THAT REJOINS BELOW EVERYTHING THAT DOMINATED THE TARGET IS STILL ALLOWED", () => {
  // The rule is preservation, not "no added edge may touch an existing node". An added branch
  // that leaves the proposer and re-enters at a node the gate ALREADY dominates takes nothing
  // out of the gate's region, and refusing it would make the ordinary "do this too, then carry
  // on" proposal impossible — which is the shape a mutation exists for.
  const spec = authoredSpec() as unknown as { nodes: unknown[]; edges: unknown[] };
  spec.nodes.push({ id: n("after"), type: "function", reads: ["goal"], writes: ["note"], function: { ref: "function/noop@stable", effects: [] } });
  spec.edges.push({ id: e("a2"), from: n("pay"), to: n("after"), kind: "seq" });

  const r = compileMutation({
    base: compile(spec as unknown as GraphSpec),
    mutation: {
      addNodes: [{ id: n("extra"), type: "function", reads: ["goal"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec],
      // `pay` dominates `after`, and so does `gate`; the rejoin adds no path that skips either,
      // because reaching `extra` at all means having gone through `pay`.
      addEdges: [
        { id: e("m0"), from: n("pay"), to: n("extra"), kind: "seq" } as unknown as EdgeSpec,
        { id: e("m1"), from: n("extra"), to: n("after"), kind: "seq" } as unknown as EdgeSpec,
      ],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("pay"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });

  assert.equal(
    r.diagnostics.filter((d) => d.code === "MUT003_DOMINATOR_LOST").length,
    0,
    `a legitimate rejoin was refused: ${r.diagnostics.map((d) => d.message).join(" | ")}`,
  );
  assert.equal(r.ok, true, `the rejoin did not compile: ${r.ok ? "" : r.error.message}`);
});
