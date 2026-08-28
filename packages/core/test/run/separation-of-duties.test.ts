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
import { replayRun } from "../../src/run/replay.ts";
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

test("AN UNSATISFIABLE SUPERVISION REQUIREMENT IS RUN-FATAL, and raises no gate at all", async () => {
  // `E_GATE_REQUIRED` rather than `E_GATE_NOT_AUTHORIZED`, and it is in `RUN_FATAL_CODES`
  // beside a breached budget and a replay divergence. The other code says "you may not decide
  // this"; this one says "this action needs a decision that cannot be obtained", which is not
  // a thing a graph should be able to route around.
  //
  // WHAT IS PINNED HERE IS THE CODE AND THE ABSENCE OF A GATE, not the routing. A reviewer
  // reported that an `error` edge from the gate node recovers the run to `succeeded`; two
  // attempts to reproduce that — an error edge to a node writing the graph's output, and one
  // to a node writing its own channel — both ended `failed` with the recovery node never
  // activated, with and without the fatal code. So the fatal listing is justified on its own
  // terms and the routing claim is recorded in JOURNAL.md as unreproduced rather than pinned
  // by a test that passes for a reason it cannot name.
  const { p } = await runWith(SOD);
  assert.equal(p.status, "failed");
  const refused = Object.values(p.tasks).find((t) => t.state === "failed")!;
  assert.equal(refused.error?.code, "E_GATE_REQUIRED", "the run-fatal code, not an ordinary gate refusal");
  assert.equal(Object.keys(p.gates).length, 0, "and NO gate row — which is what makes this worse than a rejection");
});

test("THE DELIVERED CARD AND THE QUEUE AGREE ABOUT WHO IS BARRED", async () => {
  // Two builders carry the field into what a HUMAN sees, and both survived mutation against
  // the whole suite. `#summarize` builds the pre-projection summary the dispatcher delivers at
  // raise, field by field; `#summaryOf` spreads the folded record. If only one carried the
  // exclusion, the Slack card and the API queue would disagree about whether the gate bars
  // anyone — which is plan D8's stated hazard, and the sort of disagreement nobody notices
  // until an approver acts on the wrong one.
  const { h, runId, p } = await runWith(SOD, ALICE);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  const broker = new HumanGateBroker();
  const log = new RunLog(runId, { store: h.store, now: () => 1 });
  const listed = (await broker.list(log)).find((g) => g.gateId === gate.gateId)!;
  assert.deepEqual(listed.excludedApprovers, ["u:alice"], "the projected summary");
  assert.deepEqual(gate.excludedApprovers, ["u:alice"], "and the folded record");
});

test("AN EMPTY EXCLUSION IS REFUSED AT THE EMBEDDER DOOR", async () => {
  // Three docstrings say the field is never `[]`, and that is true of the ENGINE — which is
  // not the same as true. `raise` is a public door with no compiler behind it, and `[]`
  // journals a rule that reads as declared and bars nobody; `shownGate` would then render
  // "these people are barred: nobody" to a human. The same argument `isPositiveWholeMs`
  // already makes for `slaMs`.
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(skeletonSpec()), inputs: { paths: DOCS } });
  const broker = new HumanGateBroker();
  const log = new RunLog(runId, { store: h.store, now: () => 1 });
  await assert.rejects(
    () =>
      broker.raise(log, {
        runId,
        taskId: "approve@root#0" as never,
        nodeId: "approve" as never,
        policyRef: "p",
        payload: {},
        approvers: ["u:bob"],
        excludedApprovers: [],
      }),
    /EMPTY excludedApprovers/,
  );
});

test("AND THE SYMMETRIC ONE FOR `approvers` — a non-array and an empty list are both refused", async () => {
  // The same door, one field over, and the non-array is the worse of the two: `#authorize` asks
  // whether the list CONTAINS the subject, and `String.prototype.includes` answers `true` for
  // every substring — so `approvers: "u:alice"` journals a string that READS supervised in the
  // audit record while subject `"u"` and subject `"alice"` each approve. The empty list is the
  // familiar half: "names nobody on purpose" and "could not read who it names" produce one value,
  // and the runtime documents the first as permissive.
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(skeletonSpec()), inputs: { paths: DOCS } });
  const broker = new HumanGateBroker();
  const log = new RunLog(runId, { store: h.store, now: () => 1 });
  const raise = (approvers: unknown) =>
    broker.raise(log, {
      runId,
      taskId: "approve@root#0" as never,
      nodeId: "approve" as never,
      policyRef: "p",
      payload: {},
      approvers: approvers as never,
    });

  await assert.rejects(() => raise("u:alice"), /not a list of subject ids/);
  await assert.rejects(() => raise([]), /EMPTY approvers/);

  // ABSENT STILL MEANS ANYONE MAY DECIDE, and that asymmetry is the point — most gates in this
  // repo name nobody and must keep working. If this ever starts throwing, the refusal above has
  // stopped distinguishing "no rule" from "an unreadable rule", which is the defect it closes.
  await raise(undefined);
});

test("A PRE-AUTHORIZED DEFAULT ACTION CANNOT STAND IN FOR THE PERSON THE RULE NAMES", async () => {
  // The exclusion is enforced for HUMAN actors only, correctly — the system actors that reach
  // `#authorize` are the replayer, the dedup inheritor and the timeout, none of which could be
  // the initiator. But a pre-authorized `defaultAction` turns that carve-out into a bypass of
  // a different rule: the gate expires and `gate-broker:timeout` approves the very action the
  // graph said one specific person may not sign off. The two declarations are incompatible,
  // so they are refused together at the raise. Embedder-reachable only — `checkSla` refuses
  // `default_action` from a graph — which is exactly where this function's other refusals live.
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(skeletonSpec()), inputs: { paths: DOCS } });
  const broker = new HumanGateBroker();
  const log = new RunLog(runId, { store: h.store, now: () => 1 });
  await assert.rejects(
    () =>
      broker.raise(log, {
        runId,
        taskId: "approve@root#0" as never,
        nodeId: "approve" as never,
        policyRef: "p",
        payload: {},
        approvers: ["u:bob"],
        excludedApprovers: ["u:alice"],
        onTimeout: "default_action",
        defaultAction: { kind: "approve" },
      }),
    /a clock cannot satisfy a rule about which person decides/,
  );
});

// ── the bypasses ─────────────────────────────────────────────────────────────

test("TWO GATES DO NOT MERGE ACROSS THE RULE — `sameAuthority` learned the exclusion", async () => {
  // `sameAuthority` is asked by both dedup and batching, and BATCHING is the consumer that is
  // reachable from a compiled graph: `batchFor` asks it with no `nodeId` term, so two
  // different `human_gate` nodes sharing a `policyRef` and a batching key are merge
  // candidates. (Dedup's `sameQuestion` requires the same node, and within one run+node the
  // exclusion is constant — so the dedup half is embedder-only. The first version of this
  // test asserted on two gates in two unrelated runs and exercised neither.)
  //
  // The two nodes declare no `writes` on purpose: `allowEdit` is `node.writes`, and
  // `sameAllowEdit` is another term of the same predicate — with different writes they would
  // never be merge candidates and the test would pass for a reason it does not claim.
  //
  // What a merge would mean here: one click closing a gate that bars the initiator together
  // with one that does not. `resolveBatch` validates every member, so it is not an
  // authorization bypass — it is a batch the initiator can never resolve at all, presented as
  // one question.
  const BATCH = { enabled: true, key: "k", windowMs: 60_000, maxBatch: 5 };
  const gates = (sodOnB: boolean): GraphSpec => ({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "two-gates", project: "demo", version: 1 },
    policy: {
      posture: "on",
      budget: { costUsd: 1, tokens: 1000, wallMs: 10_000 },
      expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 5, maxLoopIterations: 1 },
      capabilities: [],
    },
    channels: { a: { type: "object", reduce: "replace" } },
    inputs: [],
    outputs: ["a"],
    nodes: [
      { id: "start" as never, type: "function", writes: ["a"], function: { ref: "function/passthrough@stable" } },
      {
        id: "gA" as never,
        type: "human_gate",
        reads: ["a"],
        humanGate: { ref: "oversight/x@stable", approval: { mode: "single", approvers: ["u:alice", "u:bob"], separationOfDuties: true }, batching: BATCH },
      },
      {
        id: "gB" as never,
        type: "human_gate",
        reads: ["a"],
        humanGate: {
          ref: "oversight/x@stable",
          approval: { mode: "single", approvers: ["u:alice", "u:bob"], ...(sodOnB ? { separationOfDuties: true } : {}) },
          batching: BATCH,
        },
      },
    ],
    edges: [
      { id: "e1" as never, from: "start" as never, to: "gA" as never, kind: "seq" },
      { id: "e2" as never, from: "start" as never, to: "gB" as never, kind: "seq" },
    ],
  });

  const batchesFor = async (sodOnB: boolean): Promise<number> => {
    const h = harness();
    h.functions.register("function/passthrough@stable", () => ({}));
    const runId = await h.engine.submit({ graph: compileSkeleton(gates(sodOnB)), inputs: {}, submittedBy: ALICE });
    const p = await h.engine.advance(runId);
    return new Set(Object.values(p.gates).map((g) => g.batch?.id)).size;
  };

  assert.equal(await batchesFor(true), 1, "identical authority, including the exclusion — one question");
  assert.equal(await batchesFor(false), 2, "one bars the initiator and one does not, so they are two questions");
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

test("AN SoD RUN REPLAYS, and the shadow gate carries the same exclusion", async () => {
  // The replayer answers gates as a SYSTEM actor, which the exclusion arm deliberately does
  // not touch — so what breaks without the recorded principal is not the authorization, it is
  // the RAISE: a shadow run with no initiator cannot resolve an exclusion, so it refuses and
  // the replay reports a divergence it should not have.
  //
  // The first version of this test never called `replayRun` at all. It read the journal and
  // asserted `run.submitted.submittedBy`, which is true of a run nobody replays.
  const graph = compileSkeleton(graphWith(SOD));
  const h = harness();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS }, submittedBy: ALICE });
  const p = await h.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:bob", via: "api" },
    idempotencyKey: "k",
  });

  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });
  assert.equal(report.match, true, JSON.stringify(report.frames?.slice(0, 3) ?? []));
  const shadow = Object.values(report.replayed.gates)[0]!;
  assert.deepEqual(shadow.excludedApprovers, ["u:alice"], "the shadow run resolved the same rule, not none");
});
