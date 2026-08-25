/**
 * A secret that moves does not stop being a secret.
 *
 * Channel `classification` is a property of the CHANNEL, not of the data in it, and nothing
 * followed the data. Measured before this existed: one ordinary node — a normalizer, a summariser
 * — reading a `secret_ref` channel and writing an `internal` one dropped the downstream sink from
 * posture `in` to `on`, no gate was raised, no diagnostic was emitted, and the tool received
 * `sk-live-…` verbatim. The integrity axis had `applyTaint` for exactly this shape; the
 * confidentiality axis had no analogue at all.
 *
 * THE DISTINCTION THAT MAKES THIS SAFE RATHER THAN MERELY STRICT, and the reason the fix is not
 * "raise the floor whenever classification is high":
 *
 *   - a DECLARED `secret_ref` is written in the graph the human de-escalated. Their "let this run
 *     on-the-loop" covered it, and a ceiling may still lower it. That is what a ceiling is for.
 *   - a LAUNDERED secret was not visible to them. It is new information about this run, exactly
 *     as untrusted tool output is, so the earlier judgement no longer covers this action.
 *
 * So the propagated set is consulted only where the declared one cannot help: under a ceiling.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const NOW = () => 1_700_000_000_000;

/**
 * `secret` --(a: launder | direct)--> `mid` --> `send` (irreversible)
 *
 * In the LAUNDER arm the sink reads `mid`, declared `internal`. In the DIRECT arm it reads
 * `secret` itself. The two differ only in what the human could see, which is the whole point.
 */
const spec = (launder: boolean, pause = false) =>
  ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "secret-flow", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["wire:send"] },
    channels: {
      secret: { type: "string", reduce: "replace", classification: "secret_ref" },
      mid: { type: "object", reduce: "replace", classification: "internal" },
      sent: { type: "object", reduce: "replace" },
    },
    inputs: ["secret"],
    outputs: ["sent"],
    nodes: [
      { id: "a", type: "function", reads: ["secret"], writes: ["mid"], function: { ref: "function/copy@stable" } },
      // `pause` puts a human gate BETWEEN the laundering node and the sink, so a restart can
      // happen after the secret has moved and before anything decides about it. Without it the
      // first `advance` drains the whole run and the second engine only reports a decision the
      // first one already made — which is how the first version of the restart test passed with
      // the restore arm deleted.
      ...(pause
        ? [{ id: "pause", type: "human_gate", reads: ["mid"], humanGate: { ref: "policy/pause@stable" } }]
        : []),
      {
        id: "b",
        type: "tool",
        reads: launder ? ["mid"] : ["secret"],
        writes: ["sent"],
        tool: { name: "wire.send", version: "1.0", args: launder ? { body: "${mid.leak}" } : { body: "${secret}" } },
        unhandled: true,
      },
    ],
    edges: pause
      ? [
          { id: "a2p", from: "a", to: "pause", kind: "seq" },
          { id: "p2b", from: "pause", to: "b", kind: "seq" },
        ]
      : [{ id: "a2b", from: "a", to: "b", kind: "seq" }],
  }) as never;

function rig(received: string[], shared?: MemoryStateStore) {
  const store = shared ?? new MemoryStateStore({ now: NOW });
  const send: ToolDefinition = {
    name: "wire.send",
    version: "1.0",
    description: "Send something outward.",
    parameters: { type: "object", properties: { body: { type: "string" } } },
    irreversibility: "irreversible",
    idempotent: false,
    capabilities: ["wire:send"],
    execute: (a) => {
      received.push(String((a as { body?: unknown }).body));
      return { content: "sent", writes: { sent: { ok: true } } };
    },
  };
  const tools = new ToolRegistry();
  tools.register(send);
  const functions = new FunctionRegistry();
  functions.register("function/copy@stable", (v) => ({ writes: { mid: { leak: v.get("secret") } } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now: NOW,
    sleep: async () => {},
    maxParallelism: 1,
    policy: { granted: ["wire:send"], budget: { runUsd: 1 } },
  });
  const compile = (launder: boolean, pause = false) =>
    compileOrThrow({
      spec: spec(launder, pause),
      resolver: resolver(),
      tools: { "wire.send": { irreversibility: "irreversible", capabilities: ["wire:send"] } } as never,
      tenantCapabilities: ["wire:send"],
    });
  return { store, engine, compile };
}

test("A LAUNDERED SECRET STILL GATES, even under a human ceiling", async () => {
  const received: string[] = [];
  const r = rig(received);
  const runId = await r.engine.submit({ graph: r.compile(true), inputs: { secret: "sk-live-SUPER-SECRET" } });

  // The human lowers the run to `on` — allowed, and the one thing that may lower a floor. Before
  // this fix that erased the secret's protection completely and the send ran.
  await r.engine.deescalate(runId, `run:${runId}`, "on", "operator is watching this one", {
    kind: "human",
    id: "u:alice",
  });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `the secret reached the sink unasked: ${p.status}`);
  assert.deepEqual(received, [], "THE PLAINTEXT WAS SENT — a secret that moves is still a secret");
});

test("A DECLARED secret under the same ceiling still runs — that is what a ceiling is FOR", async () => {
  // The control, and it is not decoration: a fix that also refused this one would make
  // de-escalation impossible for any graph that touches a secret, which is the mechanism's whole
  // purpose. The human read a graph whose sink says `reads: ["secret"]`. They saw it.
  const received: string[] = [];
  const r = rig(received);
  const runId = await r.engine.submit({ graph: r.compile(false), inputs: { secret: "sk-live-SUPER-SECRET" } });

  await r.engine.deescalate(runId, `run:${runId}`, "on", "operator is watching this one", {
    kind: "human",
    id: "u:alice",
  });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(received, ["sk-live-SUPER-SECRET"], "the de-escalation the human made must still mean something");
});

test("THE FLOW SET SURVIVES A RESTART — it is rebuilt from the journal", async () => {
  // Invariant 2, and the fifth field of this class taught the rule: what needs a restore arm is
  // the PRODUCER, not the field. `applySecretFlow` runs beside `applyTaint` at the commit AND in
  // `#restoreEvidence`, so a second process reaches the same answer.
  //
  // THE GATE IS WHAT MAKES THIS TEST REAL. Without a pause the first engine drains the whole run,
  // the sink's decision is already made, and the second engine only reports it — so the test
  // passed with the restore arm deleted. Suspending between the laundering node and the sink puts
  // the DECISION in the second engine, which is the only place the rebuilt set can matter.
  const received: string[] = [];
  const r = rig(received);
  const graph = r.compile(true, true);
  const runId = await r.engine.submit({ graph, inputs: { secret: "sk-live-SUPER-SECRET" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "watching", { kind: "human", id: "u:alice" });

  const first = await r.engine.advance(runId);
  assert.equal(first.status, "awaiting_gate", "precondition: the run paused after the secret moved");
  assert.deepEqual(received, [], "precondition: the sink has not run yet");

  // A NEW ENGINE OVER THE SAME JOURNAL — what a restart is. Passing a fresh store instead was the
  // first version of this, and it asserted against a run the second engine had never heard of.
  const engine2 = rig(received, r.store).engine;
  await engine2.attach(runId, graph);
  const gateId = Object.values(first.gates).find((g) => g.state === "open")!.gateId;
  await engine2.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "api" },
    idempotencyKey: "k1",
  });
  const p = await engine2.advance(runId);

  assert.deepEqual(received, [], "THE PLAINTEXT WAS SENT AFTER A RESTART — the flow set was not rebuilt");
  assert.equal(p.status, "awaiting_gate", `a restart forgot the channel carries a secret: ${p.status}`);
});
