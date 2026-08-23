/**
 * WHAT ONE APPROVAL BUYS, WHEN THE THING APPROVED IS AN AGENT.
 *
 * A tool node gates per call: the human approves that action. An AGENT node gates ONCE, before
 * its first turn, at a floor computed over every tool it can REACH (invariant 5) — and every
 * in-turn call afterwards runs under that single approval. `#invokeTool`'s `nodeApproved` arm is
 * deliberate and its comment says why: re-deciding "would refuse the very action that approval
 * authorized". The refusal arm — an in-turn call that would gate WITHOUT that approval — is
 * already pinned by `escalation.test.ts`; this is the other half, which was pinned by nothing.
 *
 * It matters because it is the difference between "a human authorised this execution" and "a
 * human authorised this agent, which then executed N times". Measured through `bin/loom` against
 * a scripted provider: one `gate.raised`, one `gate.decided`, and TWO `proc.exec` calls.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;
const CAP = "danger:launch";
const TURNS_THAT_CALL = 2;

const manifest = (): ToolManifestLite => ({
  name: "danger.act",
  version: "1.0",
  capabilities: [CAP],
  irreversibility: "irreversible",
  idempotent: false,
});

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "agent-scope", project: "t", version: 1 },
    policy: { posture: "out", capabilities: [CAP] },
    channels: { q: { type: "string", reduce: "replace" }, a: { type: "string", reduce: "replace" } },
    inputs: ["q"],
    outputs: ["a"],
    nodes: [
      {
        id: "ag",
        type: "agent",
        reads: ["q"],
        writes: ["a"],
        agent: { profile: "agent_profile/a@stable", prompt: "prompt/p@stable", maxTurns: 4, tools: ["danger.act"] },
        unhandled: true,
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

function rig() {
  const fired: string[] = [];
  const tools = new ToolRegistry();
  const def: ToolDefinition = {
    ...manifest(),
    description: "An irreversible action.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      fired.push(`call-${fired.length + 1}`);
      return { content: `did ${fired.length}` };
    },
  };
  tools.register(def);

  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      // The first TURNS_THAT_CALL turns ask for the irreversible tool; the next ends the loop.
      script: (_req, turn) =>
        turn < TURNS_THAT_CALL
          ? { toolCalls: [{ id: `t${turn}`, name: "danger.act", arguments: {} }], finishReason: "tool_use" }
          : { text: "done", finishReason: "stop" },
    }),
    true,
  );

  const store = new MemoryStateStore({ now: () => NOW });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models,
    now: () => NOW,
    sleep: async () => {},
    policy: { granted: [CAP], systemFloor: "out" },
  });
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: { "danger.act": manifest() }, tenantCapabilities: [CAP] });
  return { engine, store, graph, fired };
}

test("ONE APPROVAL OF AN AGENT NODE AUTHORISES EVERY IN-TURN CALL IT THEN MAKES", async () => {
  const h = rig();
  const runId = await h.engine.submit({ graph: h.graph, inputs: { q: "go" } });
  const parked = await h.engine.advance(runId);

  // The agent gates BEFORE its first turn, at the floor over every tool it can reach.
  assert.equal(parked.status, "awaiting_gate", JSON.stringify(parked.error ?? {}));
  assert.deepEqual(h.fired, [], "nothing irreversible may run before the human answers");

  const gate = Object.values(parked.gates).find((g) => g.state === "open")!;
  const done = await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });
  const final = done.status === "running" ? await h.engine.advance(runId) : done;

  assert.equal(final.status, "succeeded", JSON.stringify(final.error ?? {}));
  // THE POINT. One question was asked, and more than one irreversible action followed from it.
  assert.equal(h.fired.length, TURNS_THAT_CALL, `one approval authorised ${h.fired.length} calls`);
  assert.equal(Object.values(final.gates).length, 1, "and the agent did not ask again per call");
});
