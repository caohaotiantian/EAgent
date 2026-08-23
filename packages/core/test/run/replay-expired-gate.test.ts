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
import { GateDispatcher, formatRecipients, type DeliveryChannel } from "../../src/run/delivery.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";

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
        humanGate: {
          ref: "oversight/ship@stable",
          sla: { respondWithinMs: 1000, onTimeout: "fail" },
          // A REAL DELIVERY BLOCK, or the paging test below is vacuous: `raise` only reaches the
          // dispatcher when `dispatcher !== undefined && delivery !== undefined`, so a gate that
          // declares no channel cannot page anyone however the engine is wired.
          delivery: { channels: ["console"], recipients: [{ kind: "user", id: "u:alice" }] },
        },
      },
      { id: "act", type: "tool", writes: ["done"], tool: { name: "danger.act", version: "1.0", args: {} } },
    ],
    edges: [{ id: "e1", from: "approve", to: "act", kind: "seq" }],
  } as unknown as GraphSpec;
}

function harness(gates?: HumanGateBroker) {
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
    ...(gates === undefined ? {} : { gates }),
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

test("A REPLAY MUST NOT PAGE ANYBODY — an audit has no business reaching a human", async () => {
  // This branch made `replayRun` call `sweepGates` so a run that ended on an expired gate could be
  // re-derived. `sweepTimeouts` is also the code that DELIVERS: it escalates tiers and calls the
  // dispatcher. Before that change a dispatcher on the replay engine was inert because nothing in
  // a replay ever swept; now it is not, and `replayRun` spreads `...opts.engine` straight through,
  // so an embedder replaying with their production engine options hands the shadow run their
  // broker and its channels.
  //
  // `loom replay` itself passes only tools, functions, models and policy, so the shipped CLI
  // cannot page anyone. That is a property of one call site, and this repo's own rule is that a
  // rule enforced by convention at each call site is not a rule — so it is asserted here against
  // the worst input rather than left to the caller.
  const paged: string[] = [];
  const channel: DeliveryChannel = {
    name: "console",
    deliver: async (target) => {
      paged.push(`${formatRecipients(target.recipients)}:${String(target.gate.gateId)}`);
      return "receipt";
    },
  };

  const h = harness();
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  await h.engine.advance(runId);
  await h.engine.sweepGates(NOW + 5_000);
  assert.equal((await h.engine.projection(runId))!.status, "failed");

  // THE HARNESS CAN PAGE — asserted, because a paging test on a rig that cannot page is green
  // for a reason it does not claim. The original run is driven through a broker with the same
  // channel, and it must reach the human before the replay is asked not to.
  const original = new HumanGateBroker({ now: () => NOW, dispatcher: new GateDispatcher({ channels: [channel] }) });
  const live = harness(original);
  const liveRun = await live.engine.submit({ graph: live.graph, inputs: {} });
  await live.engine.advance(liveRun);
  assert.notEqual(paged.length, 0, "the rig cannot page at all — the assertion below would be vacuous");

  paged.length = 0; // only what the REPLAY does counts
  const report = await replayRun({
    store: h.store,
    runId,
    graph: h.graph,
    // CAST ON PURPOSE. `ReplayOptions["engine"]` now excludes `gates`, so an ordinary caller
    // cannot reach this at all — that half is enforced by the compiler and needs no test. What
    // is tested here is the other half: the caller who casts past the type still must not page
    // anyone, because a rule enforced at each call site is not a rule.
    engine: {
      ...h.replayOpts(),
      gates: new HumanGateBroker({ now: () => NOW, dispatcher: new GateDispatcher({ channels: [channel] }) }),
    } as unknown as Parameters<typeof replayRun>[0]["engine"],
  });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.deepEqual(paged, [], "a replay reached a human — an audit of a run that ended days ago must not page anyone");
});
