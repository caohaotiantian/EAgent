/**
 * A RESTARTED PROCESS RE-ARMS THE GATES IT PICKS UP.
 *
 * A gate's non-durable half — its `DeliverySpec`, its reminder schedule, its escalation chain,
 * its pre-authorized default action — lives in the broker that raised it. `GateSweeperOptions.broker`
 * already says what a fresh one costs: a sweep holding no delivery spec makes `#fireTimeout`
 * "conclude every escalation chain is exhausted and EXPIRE gates that should have escalated.
 * Silently, and fail-closed, which is the kind of wrong that gets discovered a quarter later."
 *
 * So a `loom serve` restart disarmed every tier and every reminder, and the gates it then expired
 * carried the journaled reason "exhausted its escalation chain with no decision" — FALSE, on a
 * gate nobody had ever been paged about. This is the same false-reason defect Wave 5 fixed for a
 * different cause, reached from the restart side.
 *
 * `HumanGateBroker.rehydrate` existed for exactly this and had ZERO CALLERS — the fifth capability
 * this repo shipped with none, after `runSandboxed`, `McpClient`, `ResourceStore` and
 * `createFunctionLoader`. It had none because until a run could be re-attached from its journaled
 * graph hash, a fresh process had no way to HAVE the node — and the node is where the schedule
 * comes from, `scheduleOf` being a pure function of it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { GateDispatcher, formatRecipients, type DeliveryChannel } from "../../src/run/delivery.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import type { RunId } from "../../src/ids.ts";
import { resolver } from "./skeleton.ts";

const NOW = 1_700_000_000_000;

/** A gate with a one-second SLA and one escalation tier — the shape a restart used to disarm. */
function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "escalates", project: "rehydrate", version: 1 },
    policy: { posture: "on", expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
    inputs: ["note"],
    outputs: ["out"],
    nodes: [
      {
        id: "approve",
        type: "human_gate",
        reads: ["note"],
        writes: ["out"],
        humanGate: {
          ref: "oversight/ship@stable",
          approval: { approvers: ["u:alice"] },
          sla: { respondWithinMs: 1000, onTimeout: "escalate" },
          delivery: {
            channels: ["console"],
            recipients: [{ kind: "user", id: "u:alice" }],
            escalation: [{ afterMs: 1000, to: [{ kind: "user", id: "u:carol" }] }],
          },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly paged: { to: string; gate: string }[];
  readonly clock: { t: number };
}

/** A process. `shared` makes a SECOND one over the same journal — which is what a restart is. */
function rig(shared?: { store: MemoryStateStore; clock: { t: number } }): Rig {
  const paged: { to: string; gate: string }[] = [];
  const channel: DeliveryChannel = {
    name: "console",
    deliver: async (target) => {
      paged.push({ to: formatRecipients(target.recipients), gate: String(target.gate.gateId) });
      return "receipt";
    },
  };
  const clock = shared?.clock ?? { t: NOW };
  const store = shared?.store ?? new MemoryStateStore({ now: () => clock.t });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => clock.t,
    sleep: async () => {},
    gates: new HumanGateBroker({ now: () => clock.t, dispatcher: new GateDispatcher({ channels: [channel] }) }),
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 10 } },
  });
  return { engine, store, paged, clock };
}

const compile = () => compileOrThrow({ spec: spec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });

async function park(r: Rig): Promise<RunId> {
  const runId = await r.engine.submit({ graph: compile(), inputs: { note: "n" } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));
  return runId;
}

test("A GATE PICKED UP BY A FRESH PROCESS STILL ESCALATES", async () => {
  const first = rig();
  const runId = await park(first);

  // THE RESTART. A second engine over the same journal, holding none of the first's broker
  // memory — which is exactly what `loom serve` coming back up is.
  const second = rig({ store: first.store, clock: first.clock });
  second.engine.attach(runId, compile());
  const armed = await second.engine.rehydrateGates(runId);
  assert.equal(armed, 1, "the open gate must be re-armed");

  second.paged.length = 0;
  second.clock.t += 1_500;
  const fired = await second.engine.sweepGates();
  assert.equal(fired.fired.length, 1, `the gate's clock must fire: ${JSON.stringify(fired)}`);

  // WHICH WAY IT FIRED is the assertion. Expiry and escalation both appear in the report, and
  // the fail-closed bug is precisely an EXPIRY where an escalation was declared.
  const types: string[] = [];
  for await (const ev of second.store.read(runId, 1)) types.push(ev.type);
  assert.ok(types.includes("gate.escalated"), `must escalate; journal: ${types.join(", ")}`);
  assert.ok(!types.includes("gate.timeout"), `must NOT expire; journal: ${types.join(", ")}`);
  assert.deepEqual(
    second.paged.map((p) => p.to),
    ["user:u:carol"],
    "tier 1's recipient must be paged, which needs the DeliverySpec the restart restored",
  );
});

test("WITHOUT REHYDRATION THE SAME GATE EXPIRES WITH A REASON THAT IS FALSE", async () => {
  // The defect, pinned. Kept because it is what makes the test above mean something: the failure
  // is not "nothing happens", it is a durable `run.failed` whose stated reason never happened.
  const first = rig();
  const runId = await park(first);

  const second = rig({ store: first.store, clock: first.clock });
  second.engine.attach(runId, compile());
  // Deliberately NOT calling `rehydrateGates`.

  second.clock.t += 1_500;
  await second.engine.sweepGates();

  const events: { type: string; payload: unknown }[] = [];
  for await (const ev of second.store.read(runId, 1)) events.push({ type: ev.type, payload: ev.payload });
  assert.ok(
    events.some((e) => e.type === "gate.timeout"),
    "unrehydrated, the gate expires instead of escalating",
  );
  const failure = events.find((e) => e.type === "run.failed");
  assert.match(
    JSON.stringify(failure?.payload ?? {}),
    /exhausted its escalation chain/,
    "and the journaled reason is the false one this fix exists to prevent",
  );
  assert.deepEqual(second.paged, [], "nobody was ever paged");
});

test("REHYDRATING A LIVE GATE MUST NOT ERASE THE PAYLOAD IT ALREADY HAS", async () => {
  // `rehydrateGates` builds its request from the journal, and the journal does not carry the
  // rendered payload — it passes `payload: undefined` deliberately, "absent rather than faked".
  // `rehydrate` then REPLACED the ephemeral entry wholesale, so arming a gate whose payload was
  // still in memory erased it.
  //
  // Harmless while the only callers were re-attach doors on a process that had just started and
  // held no payloads. It stopped being harmless when the gate clock began arming every run in
  // `awaiting_gate` on every tick: measured through the console API, a gate raised in-process
  // answered with `payload.state = {note: …}` for two queries and `null` from the third, one tick
  // later. The approver loses the thing they are approving — `Engine.openGates`' own docstring
  // calls that "a gate that gets approved on trust, which is the failure mode the whole oversight
  // layer exists to avoid".
  const r = rig();
  const runId = await park(r);

  const before = await r.engine.openGates(runId);
  assert.equal(before.length, 1);
  assert.notEqual(before[0]!.payload, undefined, "the raising process must hold the rendered payload");

  // The same process arms its own gate, which is what a clock tick does.
  r.engine.attach(runId, compile());
  await r.engine.rehydrateGates(runId);

  const after = await r.engine.openGates(runId);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0]!.payload, before[0]!.payload, "arming a gate may add a payload, never take one away");
});

test("and a gate with no payload in memory still gets everything else re-attached", async () => {
  // The correction must not become "never overwrite": a genuine restart holds no payload, and
  // the SLA, delivery spec and tier still have to be re-attached or the sweep expires gates it
  // should escalate — which is what the first test in this file is about.
  const first = rig();
  const runId = await park(first);
  const second = rig({ store: first.store, clock: first.clock });
  second.engine.attach(runId, compile());
  assert.equal(await second.engine.rehydrateGates(runId), 1, "the open gate must still be re-armed");
  const gates = await second.engine.openGates(runId);
  assert.equal(gates[0]!.payload, undefined, "a process that never rendered it has none to show");
  assert.notEqual(gates[0]!.deadline, undefined, "but the clock is back");
});
