/**
 * AN AGENT MAY NOT ANSWER A HUMAN GATE, INCLUDING ONE THAT NAMES NOBODY.
 *
 * `HumanGateBroker.#authorize` — the method whose own docstring says "THIS is where authorization
 * is enforced, and deliberately not one level up… Callers may keep their own checks as defence in
 * depth; none of them may be the only one" — ran `isAuthorizedActor` only inside
 * `if (approvers.length > 0)`. For a gate naming nobody, which the same file calls "the common
 * case" and which the shipped skeleton graph raises, an `agent` or `evolution` actor passed every
 * check and `gate.decided{decidedBy:"agent"}` was journaled.
 *
 * `HumanGateBroker` is pinned public (`scripts/surface.json`) and `EngineOptions.gates` lets a
 * deployment inject one, so the broker is reachable directly. `claim` — a strictly weaker
 * operation — refuses a non-human UNCONDITIONALLY one method over, so the two doors on the same
 * object disagreed about the same rule.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { NodeId, RunId, TaskId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";

const NOW = (): number => 1_700_000_000_000;

/** A run whose only content is one open gate that names nobody. */
async function openGate(approvers?: readonly string[]): Promise<{ broker: HumanGateBroker; log: RunLog; gateId: string }> {
  const store = new MemoryStateStore({ now: NOW });
  const runId = "01HF7YAT0000000000000LANEA" as RunId;
  const log = new RunLog(runId, { store, now: NOW });
  const broker = new HumanGateBroker({ now: NOW });
  const gateId = await broker.raise(log, {
    runId,
    nodeId: "act" as NodeId,
    taskId: "act@root#0" as TaskId,
    policyRef: "policy/act",
    payload: { question: "may I?" },
    ...(approvers === undefined ? {} : { approvers }),
  });
  return { broker, log, gateId };
}

test("A NO-APPROVERS GATE STILL REFUSES AN AGENT", async () => {
  const g = await openGate();
  await assert.rejects(
    () =>
      g.broker.resolve(g.log, {
        gateId: g.gateId as never,
        decision: { kind: "approve" },
        actor: { kind: "agent", profile: "agent_profile/planner@stable", taskId: "act@root#0" as TaskId, model: "m" },
        idempotencyKey: "k1",
      }),
    /can only be answered by a human/,
    "a model satisfying a human approval is the thing the gate exists to prevent",
  );
  const still = await g.broker.list(g.log);
  assert.equal(still[0]?.state, "open", "and the gate must still be open");
});

test("…and an evolution candidate", async () => {
  const g = await openGate();
  await assert.rejects(
    () =>
      g.broker.resolve(g.log, {
        gateId: g.gateId as never,
        decision: { kind: "approve" },
        actor: { kind: "evolution", candidate: "cand-7", engineVersion: "1" },
        idempotencyKey: "k1",
      }),
    /can only be answered by a human/,
  );
});

test("…and a `system` component that is not one of the gate system actors", async () => {
  const g = await openGate();
  await assert.rejects(
    () =>
      g.broker.resolve(g.log, {
        gateId: g.gateId as never,
        decision: { kind: "approve" },
        actor: { kind: "system", component: "executor" },
        idempotencyKey: "k1",
      }),
    /can only be answered by a human/,
    "the admitted set is `GATE_SYSTEM_ACTORS`, and it was only consulted when approvers were named",
  );
});

// ── and the ordinary cases, which the hoist must not break ──────────────────

test("A HUMAN STILL ANSWERS A GATE THAT NAMES NOBODY", async () => {
  const g = await openGate();
  const out = await g.broker.resolve(g.log, {
    gateId: g.gateId as never,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:anyone", via: "cli" },
    idempotencyKey: "k1",
  });
  assert.equal(out.resolved, true, "a gate that names nobody is permissive about WHICH human, not about whether");
});

test("A NAMED HUMAN STILL ANSWERS A GATE THAT NAMES THEM, and a stranger still does not", async () => {
  const named = await openGate(["u:ops"]);
  const ok = await named.broker.resolve(named.log, {
    gateId: named.gateId as never,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:ops", via: "cli" },
    idempotencyKey: "k1",
  });
  assert.equal(ok.resolved, true);

  const other = await openGate(["u:ops"]);
  await assert.rejects(
    () =>
      other.broker.resolve(other.log, {
        gateId: other.gateId as never,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "u:someone-else", via: "cli" },
        idempotencyKey: "k1",
      }),
    /does not name/,
  );
});

test("A GATE SYSTEM ACTOR still answers a gate that names nobody", async () => {
  // `GATE_SYSTEM_ACTORS` — the replayer, the timeout's default action, the dedup inheritor —
  // must keep passing, or every replay of every gate fails here.
  const g = await openGate();
  const out = await g.broker.resolve(g.log, {
    gateId: g.gateId as never,
    decision: { kind: "approve" },
    actor: { kind: "system", component: "replay" },
    idempotencyKey: "k1",
  });
  assert.equal(out.resolved, true);
});
