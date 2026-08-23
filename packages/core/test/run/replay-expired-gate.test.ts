/**
 * A RUN NOBODY ANSWERED IS STILL A RUN AN AUDITOR HAS TO RE-DERIVE.
 *
 * `replayRun`'s gate loop served a recorded `gate.decided` and threw `E_REPLAY_DIVERGENCE` when it
 * found none. A gate the CLOCK resolved has no decision — it has `gate.timeout`, folding to
 * `state: "expired"` — so every run that ended because a deadline passed was unreplayable. And
 * `onTimeout: "fail"` is the DEFAULT, which makes that the ordinary unanswered run rather than a
 * corner.
 *
 * Reproduced first through `bin/loom` against a live plane, on a run whose journal reads
 * `gate.raised → gate.escalated → gate.delivered → gate.timeout → run.failed`:
 *
 *     $ loom replay <id> --graph esc2.json
 *     E_REPLAY_DIVERGENCE: replay raised a gate on node "approve" … that the recorded run never decided
 *
 * The same shape as the de-escalation gap `replay-deescalation.test.ts` closed, and the argument
 * transfers with more force: that one needed a human to have used a rare lever, this one is what
 * happens when nobody does anything at all.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";

const CAP = "danger:launch";
const NOW = 1_700_000_000_000;

const manifest = (name: string): ToolManifestLite => ({
  name,
  version: "1.0",
  capabilities: [CAP],
  irreversibility: "irreversible",
  idempotent: false,
});

function tool(fired: string[]): ToolDefinition {
  return {
    ...manifest("danger.act"),
    description: "An irreversible action nobody authorised.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      fired.push("act");
      return { content: "acted", writes: { done: { ok: true } } };
    },
  };
}

/** A gate with a deadline, and behind it the action the deadline exists to withhold. */
function gateSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "expiry", project: "t", version: 1 },
    policy: { posture: "out", capabilities: [CAP] },
    channels: { done: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["done"],
    nodes: [
      {
        id: "approve",
        type: "human_gate",
        writes: [],
        humanGate: { ref: "oversight/ship@stable", sla: { respondWithinMs: 1000, onTimeout: "fail" } },
      },
      { id: "act", type: "tool", writes: ["done"], tool: { name: "danger.act", version: "1.0", args: {} } },
    ],
    edges: [{ id: "e1", from: "approve", to: "act", kind: "seq" }],
  } as unknown as GraphSpec;
}

function harness() {
  const fired: string[] = [];
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register(tool(fired));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    policy: { granted: [CAP], systemFloor: "out" },
  });
  const graph = compileOrThrow({
    spec: gateSpec(),
    resolver: { resolve: () => undefined },
    tools: { "danger.act": manifest("danger.act") },
    tenantCapabilities: [CAP],
  });
  const replayOpts = () => ({
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    sleep: async (): Promise<void> => {},
    policy: { granted: [CAP], systemFloor: "out" as const },
  });
  return { store, engine, graph, fired, replayOpts };
}

test("A RUN WHOSE GATE EXPIRED REPLAYS — the clock is an answer too", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  let p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "the graph must actually ask");

  // NOBODY ANSWERS. The deadline does.
  await h.engine.sweepGates(NOW + 5_000);
  const recorded = (await h.engine.projection(runId))!;
  assert.equal(recorded.status, "failed", "the SLA must have ended the run");
  assert.equal(Object.values(recorded.gates)[0]?.state, "expired");
  assert.deepEqual(h.fired, [], "and the action behind the gate must not have run");

  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: h.replayOpts() });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(report.replayed.status, "failed", "the replay reaches the same end, by the same route");
  assert.equal(Object.values(report.replayed.gates)[0]?.state, "expired");
  assert.deepEqual(h.fired, [], "a replay of a refusal must not perform the thing that was refused");
});
