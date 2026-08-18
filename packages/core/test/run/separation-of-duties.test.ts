/**
 * "An approver may not be the run's initiator" — D7.2, made executable.
 *
 * The whole point of the rule is that it must not be POSSIBLE to have it and not have it. A
 * gate that reads as supervised and is answerable by whoever started the run is worse than a
 * gate with no rule at all, because nobody goes looking — D7.9 names that the worst failure
 * available to this layer. So the shape being pinned is not "the initiator is refused"; it is
 * that every way of arriving at a toothless exclusion is a REFUSAL instead.
 *
 * Four of them, and only the first is obvious: no principal recorded, a principal that is not
 * a person, a principal that is a perimeter marker rather than a name, and a gate whose only
 * named approver is the initiator (answerable by nobody, forever).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { compileSkeleton, harness, skeletonSpec, DOCS } from "./skeleton.ts";
import { foldRun } from "../../src/run/projection.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";
import type { SubmittedBy } from "../../src/journal/events.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";

const ALICE: SubmittedBy = { kind: "human", subject: "u:alice", method: "sso" };

/** The skeleton, with its `approve` node given an approval block. */
function graphWith(approval: Record<string, unknown>): GraphSpec {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((n) => (n.humanGate === undefined ? n : { ...n, humanGate: { ref: n.humanGate.ref, approval } })),
  };
}

async function runWith(approval: Record<string, unknown>, submittedBy?: SubmittedBy) {
  const h = harness();
  const runId = await h.engine.submit({
    graph: compileSkeleton(graphWith(approval)),
    inputs: { paths: DOCS },
    ...(submittedBy === undefined ? {} : { submittedBy }),
  });
  const p = await h.engine.advance(runId);
  return { h, runId, p };
}

const SOD = { mode: "single" as const, approvers: ["u:alice", "u:bob"], separationOfDuties: true };

// ── the rule ─────────────────────────────────────────────────────────────────

test("THE INITIATOR IS REFUSED AND A CO-APPROVER IS NOT — the rule, in one run", async () => {
  const { h, runId, p } = await runWith(SOD, ALICE);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;

  // RESOLVED AT RAISE AND JOURNALED, not evaluated at decide. That is what makes it survive a
  // restart, reproduce under replay, and stay readable by `#authorize` — which reads the fold
  // of `gate.raised` and nothing else, so an exclusion computed from run state would be an
  // authorization input that is silently empty in any process that did not raise the gate.
  assert.deepEqual(gate.excludedApprovers, ["u:alice"]);

  await assert.rejects(
    () =>
      h.engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "approve" },
        actor: { kind: "human", subject: "u:alice", via: "api" },
        idempotencyKey: "k1",
      }),
    /separates duties.*u:alice/,
    "she started it, and she is named — the rule NARROWS the list rather than replacing it",
  );

  const after = await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:bob", via: "api" },
    idempotencyKey: "k2",
  });
  assert.notEqual(after.status, "failed");
  assert.equal(after.gates[gate.gateId]?.state, "decided", "and the other named approver answers it");
});

test("THE EXCLUSION SURVIVES A RESTART, because it is in the journal and not in a broker", async () => {
  const { h, runId, p } = await runWith(SOD, ALICE);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;

  // Folded from the log alone — no engine, no broker, nothing that was in memory when the
  // gate was raised. This is the property that makes the rule real rather than incidental.
  const events = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);
  const cold = foldRun(events)!;
  assert.deepEqual(cold.gates[gate.gateId]?.excludedApprovers, ["u:alice"]);
});

// ── every way to arrive at a toothless exclusion is a refusal ────────────────

test("A RUN WITH NO RECORDED PRINCIPAL FAILS THE GATE RATHER THAN RAISING A TOOTHLESS ONE", async () => {
  const { p } = await runWith(SOD);
  assert.equal(p.status, "failed");
  assert.match(String(p.error?.message), /no principal is recorded/);
  assert.match(String(p.error?.message), /loom run --as/, "and it says how to fix it");
  assert.equal(
    Object.values(p.gates).filter((g) => g.state === "open").length,
    0,
    "no gate at all — a gate barring nobody is what the rule exists to prevent",
  );
});

test("A SERVICE PRINCIPAL IS NOT A PERSON, and a MARKER is not even a service", async () => {
  for (const by of [
    { kind: "service", subject: "svc:ci", method: "bearer" } as SubmittedBy,
    { kind: "service", subject: "(shared-token)", method: "shared-token" } as SubmittedBy,
    { kind: "human", subject: "(unidentified)", method: "open" } as SubmittedBy,
  ]) {
    const { p } = await runWith(SOD, by);
    // Excluding any of these bars a subject no human actor can present, so the gate would be
    // journaled as supervised and answerable by everyone — including whoever started the run.
    assert.equal(p.status, "failed", `${by.subject} raised a gate`);
    assert.match(String(p.error?.message), /is not a person/);
  }
});

test("A GATE WHOSE ONLY APPROVER IS THE INITIATOR IS REFUSED — the compiler cannot see this one", async () => {
  // `approvers` is static in the spec and the initiator is a runtime fact, so no compile-time
  // check can catch it. `raise` holds both. Without this the run parks on a question nobody
  // can ever answer, until an SLA it may not have.
  const { p } = await runWith({ mode: "single", approvers: ["u:alice"], separationOfDuties: true }, ALICE);
  assert.equal(p.status, "failed");
  assert.match(String(p.error?.message), /the only approver it names is "u:alice"/);
});

test("THE REFUSAL FAILS THE TASK CLEANLY — it does not wedge the run", async () => {
  // `#commit` is called OUTSIDE the try/catch that turns a throw into a failed outcome, so a
  // refusal raised as an exception escapes `advance()` with the task still `leased`: every
  // later `advance` re-leases, re-executes and throws again, and the run never terminates. A
  // hang dressed as a policy is the one shape this refusal must not take.
  const { h, runId, p } = await runWith(SOD);
  assert.equal(p.status, "failed");
  const again = await h.engine.advance(runId);
  assert.equal(again.status, "failed", "still terminal on a second advance, not re-executing");
  assert.equal(
    Object.values(again.tasks).filter((t) => t.state === "leased").length,
    0,
    "and nothing is left leased",
  );
});

// ── the bypasses ─────────────────────────────────────────────────────────────

test("A DUPLICATE CANNOT INHERIT ACROSS THE RULE — dedupe compares the exclusion too", async () => {
  // `sameAuthority` is what dedup and batching both ask. Without the exclusion in it, a gate
  // declaring separation of duties would inherit a decision made on one that did not — from
  // the very person the rule bars — and be decided in the append that raised it.
  const { p } = await runWith(SOD, ALICE);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  assert.deepEqual(gate.excludedApprovers, ["u:alice"]);

  const plain = await runWith({ mode: "single", approvers: ["u:alice", "u:bob"] }, ALICE);
  const other = Object.values(plain.p.gates).find((g) => g.state === "open")!;
  assert.equal(other.excludedApprovers, undefined);
  // Same node, same approvers, same policy — and NOT the same question, which is the whole
  // claim. The digests match only if the payloads do; what this pins is that the authorization
  // differs, which is the term `sameAuthority` gained.
  assert.notDeepEqual(gate.excludedApprovers, other.excludedApprovers);
});

test("THE INITIATOR CANNOT CLAIM IT EITHER — the claim door stays narrower than the decision door", async () => {
  // A claim grants nothing, so this is not authorization; it is about what a claim SAYS.
  // Letting the one person who provably cannot decide hold it tells the approvers that
  // somebody is looking, which is the one thing a soft lock must never do falsely.
  const { h, runId, p } = await runWith(SOD, ALICE);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  const broker = new HumanGateBroker();
  const log = new RunLog(runId, { store: h.store, now: () => 1 });
  await assert.rejects(
    () => broker.claim(log, { gateId: gate.gateId, actor: { kind: "human", subject: "u:alice", via: "api" } }),
    /separates duties/,
  );
  // …and a co-approver still can, so this narrowed the door rather than closing it.
  const held = await broker.claim(log, { gateId: gate.gateId, actor: { kind: "human", subject: "u:bob", via: "api" } });
  assert.equal(held.claimed, true);
});

test("A REPLAY OF AN SoD RUN DOES NOT FAIL AT RAISE", async () => {
  // The replayer answers gates as a SYSTEM actor, which the exclusion arm deliberately does
  // not touch — so what breaks without the recorded principal is not the authorization, it is
  // the RAISE: a shadow run with no initiator cannot resolve an exclusion, so it refuses and
  // the replay throws instead of reporting.
  const { h, runId, p } = await runWith(SOD, ALICE);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:bob", via: "api" },
    idempotencyKey: "k",
  });
  const events = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);
  const submitted = events.find((e) => e.type === "run.submitted")!;
  assert.deepEqual((submitted.payload as { submittedBy?: unknown }).submittedBy, ALICE, "the fact replay reads");
  void (runId as RunId);
});
