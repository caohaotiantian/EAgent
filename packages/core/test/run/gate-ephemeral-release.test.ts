/**
 * A CLOSED GATE'S NON-DURABLE HALF IS RELEASED, and a live one's is not.
 *
 * `HumanGateBroker.#ephemeral` holds what the journal deliberately does not — the rendered
 * payload, the `DeliverySpec`, the pre-authorized default action — and nothing ever removed an
 * entry. Measured before the fix: 6000 gates carrying 4 KiB each held 33.0 MiB for the life of
 * the process, in a component whose whole purpose is to run for months.
 *
 * The obvious fix is the wrong one, which is why both halves are pinned here. A size cap evicts
 * in insertion order; insertion order is raise order; the oldest-raised gate is the one still
 * waiting on a slow human. So an age policy targets exactly the entries still in use, and
 * `gates.ts`'s own `GateSweeperOptions.broker` docstring already says what happens to them:
 * `#fireTimeout` "concludes every escalation chain is exhausted and EXPIRES gates that should
 * have escalated. Silently, and fail-closed." The second test is that sentence as an assertion.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";

import type { GateId, NodeId, RunId, TaskId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type Actor } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { GateDispatcher, formatRecipients, type DeliveryChannel } from "../../src/run/delivery.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";

const NOW = 1_700_000_000_000;
const alice: Actor = { kind: "human", subject: "u:alice", via: "console" };

/**
 * A full GC, without needing `--expose-gc` on the runner.
 *
 * `npm test` is a bare `node --test`, so a test that needed the flag would be a test that never
 * ran — which is the failure mode this file exists to avoid, one level up.
 *
 * `type: "major"` is load-bearing: the default scavenge leaves the object alive, so a probe
 * built on it reports "still held" for everything and can only ever fail.
 */
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as (opts?: { type: string; execution: string }) => void;
setFlagsFromString("--no-expose-gc");

async function collect(): Promise<void> {
  // A MACROTASK FIRST. `WeakRef.deref` puts its target on the agent's kept-alive list, which is
  // cleared only when the microtask queue drains — so without this, dereffing once to prove an
  // object IS held guarantees the later assertion that it is NOT.
  await new Promise((r) => setImmediate(r));
  gc({ type: "major", execution: "sync" });
}

async function openRun(store: MemoryStateStore, runId: string): Promise<RunLog> {
  const log = new RunLog(runId as RunId, { store, now: () => NOW });
  await log.append([
    {
      type: "run.submitted",
      payload: {
        workflow: "ephemeral-release",
        graphHash: `sha256:${"a".repeat(64)}`,
        inputs: {},
        idempotencyKey: `k-${runId}`,
        configDigest: "d",
      },
      actor: SYSTEM_ACTOR("test"),
    },
  ]);
  return log;
}

function request(taskId: string, payload: unknown, extra: Partial<GateRequest> = {}): GateRequest {
  return {
    runId: "unused" as RunId,
    taskId: taskId as TaskId,
    nodeId: "gate" as NodeId,
    policyRef: "policy/approve@stable",
    payload,
    ...extra,
  } as GateRequest;
}

test("A DECIDED GATE'S PAYLOAD IS RELEASED — the map is the only thing holding it", async () => {
  const store = new MemoryStateStore({ now: () => NOW });
  const broker = new HumanGateBroker({ now: () => NOW });
  const log = await openRun(store, "run_release");

  // The payload OBJECT is what `#ephemeral` retains, so a WeakRef to it answers the question
  // the map's privacy otherwise makes unanswerable.
  //
  // THE LOCAL IS DROPPED EXPLICITLY, and that is not ceremony. A binding that merely goes out of
  // scope stays reachable through its enclosing context however dead it looks — measured here:
  // an object referenced by nothing but a finished block survived a major GC. Written the
  // obvious way this probe reports "still held" for everything and can only ever fail. The
  // two-sided control at the end is what keeps that honest.
  let payload: object | undefined = { summary: "approve the deploy" };
  // THE SPEC MUST SURVIVE WHAT THE PAYLOAD DOES NOT, and that is the whole shape of the fix.
  // A gate that closes can be REOPENED — `Engine.rewind` does it by design and the engine's own
  // refusals tell operators to — so dropping the entry whole stripped a live gate's route.
  let delivery: object | undefined = { channels: ["console"], recipients: [{ kind: "user", id: "u:alice" }] };
  const seen = new WeakRef(payload);
  const route = new WeakRef(delivery);
  const gateId = await broker.raise(log, request("gate@root#0", payload, { delivery: delivery as never }));
  payload = undefined;
  delivery = undefined;

  await collect();
  assert.notEqual(seen.deref(), undefined, "an OPEN gate's payload must still be held");

  await broker.resolve(log, {
    gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "decide-once",
  });

  await collect();
  assert.equal(seen.deref(), undefined, "a decided gate's payload must not outlive the decision");
  assert.notEqual(
    route.deref(),
    undefined,
    "but its DeliverySpec must — a decided gate can be reopened by rewind, and a reopened gate " +
      "with no route is expired by #fireTimeout with a reason that is false",
  );

  // AND THE BROKER IS STILL ALIVE AT THE ASSERTION. Without this the whole broker is
  // unreachable by then and V8 collects it wholesale, so the WeakRef clears whether or not
  // anything was released — an assertion that passes with the fix reverted. The identical
  // artifact made the original heap measurement of this leak read 0.7 MiB instead of 33.0.
  assert.equal((await broker.list(log)).length, 0, "the run has no open gates left");

  // THE CONTROL: this probe must be able to report "still held". Everything above is a claim
  // that an object went away, and a broken collector reports that for free.
  const held: object[] = [];
  const anchor = (() => {
    const o = { kept: true };
    held.push(o);
    return new WeakRef(o);
  })();
  await collect();
  assert.notEqual(anchor.deref(), undefined, "the probe reports a REFERENCED object as collected");
  assert.equal(held.length, 1);
});

/**
 * THIS ONE IS GREEN WITH THE RELEASE REVERTED, measured, and it is kept anyway.
 *
 * It does not cover the fix; it pins the property the REJECTED design would have broken. A size
 * cap evicts in insertion order, insertion order is raise order, and the gate below is raised
 * FIRST — so it is the first entry an age policy discards, and it is the one still waiting on a
 * human. Losing its `DeliverySpec` sends `#fireTimeout` down the `spec === undefined` arm, which
 * expires the gate with "exhausted its escalation chain with no decision" — false, in the
 * journal, on a gate nobody was ever paged about. The `route` WeakRef in the test above is what
 * actually covers the shipped behaviour; this is the deployment-shaped version of the same claim.
 */
test("AN OPEN GATE STILL ESCALATES AFTER OTHER GATES CLOSE — what an age policy would have broken", async () => {
  const store = new MemoryStateStore({ now: () => NOW });
  // A REAL `GateDispatcher` over a recording channel, not a stub in its place: `GateDispatcher`
  // is a class, and the tier arithmetic under test lives inside it rather than in the broker.
  const delivered: { to: string; body: string }[] = [];
  const channel: DeliveryChannel = {
    name: "console",
    deliver: async (target) => {
      delivered.push({ to: formatRecipients(target.recipients), body: String(target.gate.gateId) });
      return "receipt";
    },
  };
  const broker = new HumanGateBroker({
    now: () => NOW,
    dispatcher: new GateDispatcher({ channels: [channel] }),
  });

  const delivery = {
    channels: ["console"],
    recipients: [{ kind: "user", id: "u:alice" }],
    escalation: [{ afterMs: 1000, to: [{ kind: "user", id: "u:carol" }] }],
  };

  // The gate that must survive is raised FIRST, so it is the one an insertion-ordered cap
  // would evict first. That ordering is the point of the test, not an accident of setup.
  const slow = await openRun(store, "run_slow");
  const slowGate = await broker.raise(
    slow,
    request("gate@root#0", { summary: "the one nobody has answered" }, {
      delivery: delivery as never,
      slaMs: 1000,
      onTimeout: "escalate",
    }),
  );

  // Then a crowd of gates that all close, which is what fills the map in a real deployment.
  for (let i = 0; i < 50; i++) {
    const log = await openRun(store, `run_noise_${i}`);
    const id = await broker.raise(log, request(`gate@root#${i}`, { summary: `noise ${i}` }));
    await broker.resolve(log, {
      gateId: id,
      decision: { kind: "approve" },
      actor: alice,
      idempotencyKey: `noise-${i}`,
    });
  }

  delivered.length = 0;
  const fired = await broker.sweepTimeouts(slow, NOW + 1500);
  assert.deepEqual([...fired], [slowGate], "the surviving gate is the one whose clock ran out");

  // WHICH WAY IT FIRED is the assertion, not that it fired: expiry and escalation both appear
  // in `sweepTimeouts`'s return, and the fail-closed bug is precisely an EXPIRY where an
  // escalation was declared.
  const types: string[] = [];
  for await (const ev of store.read("run_slow" as RunId, 1)) types.push(ev.type);
  assert.ok(types.includes("gate.escalated"), `must escalate; journal: ${types.join(", ")}`);
  assert.ok(!types.includes("gate.timeout"), `must NOT expire; journal: ${types.join(", ")}`);
  assert.deepEqual(
    delivered.map((d) => [d.body, d.to]),
    [[String(slowGate), "user:u:carol"]],
    "tier 1's recipient must actually be paged, which needs the DeliverySpec the map still holds",
  );
});
