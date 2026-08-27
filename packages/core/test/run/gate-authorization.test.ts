/**
 * Gate authorization outlives the process that raised the gate.
 *
 * Every test here is one claim approached from a different door:
 *
 * > **A RESTART MUST NOT WIDEN WHO MAY APPROVE.**
 *
 * The defect these pin down was invisible to a single-process test, and that is the
 * whole reason this file exists rather than a few extra cases in `delivery.test.ts`.
 * Approvers and the `edit` allow-list used to live in an in-memory `Map` on the broker.
 * A second process read them back as absent, "absent" was read as "the gate named
 * nobody", and a gate that had declared `["u:alice"]` accepted `u:mallory`. So each
 * case below REBUILDS the engine and the broker from the store before it asks anything:
 * a resolution in the process that raised the gate proves nothing about the property.
 *
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { Diagnostic } from "../../src/graph/validate.ts";
import { newGateId, type GateId, type NodeId, type RunId, type TaskId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type Actor, type HumanActor, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { replayRun } from "../../src/run/replay.ts";
import { auditRun } from "../../src/journal/audit.ts";
import {
  DOCS,
  SKELETON_TENANT_CAPS,
  SKELETON_TOOLS,
  compileSkeleton,
  harness,
  resolver,
  skeletonSpec,
} from "./skeleton.ts";

const APPROVE_NODE = "approve" as NodeId;

const alice: Actor = { kind: "human", subject: "u:alice", via: "api" };
const mallory: Actor = { kind: "human", subject: "u:mallory", via: "api" };

const unauthorized = (e: unknown): true => {
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  assert.equal(e.code, CODES.E_GATE_NOT_AUTHORIZED);
  return true;
};

/** The skeleton, with the gate node declaring who may answer it. */
function specWithApprovers(approvers: readonly string[]): GraphSpec {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((n) =>
      n.id !== APPROVE_NODE ? n : { ...n, humanGate: { ref: n.humanGate!.ref, approval: { mode: "single", approvers } } },
    ),
  };
}

/**
 * Park a run on its gate, then throw the process away.
 *
 * `second` shares only the store — a fresh `Engine`, a fresh `HumanGateBroker`, and a
 * re-attached graph, which is exactly what a redeploy is.
 */
async function restartedAtGate(approvers?: readonly string[]): Promise<{
  first: ReturnType<typeof harness>;
  second: ReturnType<typeof harness>;
  runId: RunId;
  gateId: GateId;
}> {
  const spec = approvers === undefined ? skeletonSpec() : specWithApprovers(approvers);
  const first = harness();
  const runId = await first.engine.submit({
    graph: compileSkeleton(spec),
    inputs: { paths: DOCS },
    workflow: "skeleton-summarize",
  });
  const p = await first.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", "the skeleton parks on its gate");
  const gateId = Object.values(p.gates).find((g) => g.state === "open")!.gateId;

  const second = harness({ store: first.store });
  second.engine.attach(runId, compileSkeleton(spec));
  return { first, second, runId, gateId };
}

// ── the headline ─────────────────────────────────────────────────────────────

test("A RESTART DOES NOT ERASE WHO MAY APPROVE", async () => {
  const { second, runId, gateId } = await restartedAtGate(["u:alice"]);

  await assert.rejects(
    () => second.engine.resolveGate(runId, { gateId, decision: { kind: "approve" }, actor: mallory, idempotencyKey: "m1" }),
    unauthorized,
  );
  assert.equal(second.writes.length, 0, "the action behind the gate did not run");

  const p = await second.engine.projection(runId);
  assert.equal(p?.gates[gateId]?.state, "open", "a refused decision leaves the gate open, not decided");
  assert.equal(
    (await events(second, runId)).some((e) => e.type === "gate.decided"),
    false,
    "and nothing about u:mallory reached the record as a decision",
  );

  // …while the person the gate actually named still gets through.
  const after = await second.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
  });
  assert.equal(after.status, "succeeded", JSON.stringify(after.error ?? {}));
  assert.equal(second.writes.length, 1, "the guarded action ran once an approver approved");
});

test("a rebuilt broker can still TELL an operator who may approve", async () => {
  // The console asks this to render a queue. Answering "nobody in particular" after a
  // deploy is the same lie the enforcement bug told, just addressed to a human.
  const { second, runId } = await restartedAtGate(["u:alice", "u:bob"]);
  const open = await second.engine.openGates(runId);

  assert.equal(open.length, 1);
  assert.deepEqual(open[0]!.approvers, ["u:alice", "u:bob"]);
  assert.deepEqual(open[0]!.allowEdit, ["merged"], "…and which channels an edit may touch");
  assert.equal(open[0]!.payload, undefined, "the RENDERED payload is the part that is genuinely lost, and it is a UI concern");
});

// ── the same shape, for `edit` ───────────────────────────────────────────────

test("AN EDIT AFTER A RESTART STILL CANNOT WRITE AN UNDECLARED CHANNEL", async () => {
  // The demonstrated exploit: `costUsd` is a real channel with `reduce: sum`, so an
  // unchecked edit does not merely write somewhere it should not — it corrupts the
  // budget accumulator that every later admission decision reads.
  const { second, runId, gateId } = await restartedAtGate(["u:alice"]);

  await assert.rejects(
    () =>
      second.engine.resolveGate(runId, {
        gateId,
        decision: { kind: "edit", writes: { costUsd: 999 } },
        actor: alice,
        idempotencyKey: "e1",
      }),
    unauthorized,
  );

  const p = await second.engine.projection(runId);
  assert.equal(p?.gates[gateId]?.state, "open");
  assert.notEqual(p?.channels["costUsd"], 999, "the budget accumulator was not overwritten");
});

test("an edit of a DECLARED channel still works after a restart", async () => {
  // The refusal above has to be the allow-list working, not the allow-list having
  // become "nothing at all" — an over-tight failure would be just as wrong and much
  // easier to ship by accident.
  const { second, runId, gateId } = await restartedAtGate(["u:alice"]);
  const p = await second.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "edit", writes: { merged: { count: 1, markdown: "# edited by hand" } }, reason: "trimmed" },
    actor: alice,
    idempotencyKey: "e2",
  });

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(second.writes[0]?.body, "# edited by hand", "the human's text is what the tool wrote");
});

// ── …and for `redirect` ──────────────────────────────────────────────────────

test("A HUMAN CANNOT INVENT A TARGET THE NODE NEVER HAD", async () => {
  // `#activate` resolves an edge id against the WHOLE graph, so a redirect naming an
  // edge that belongs to another node activated that node's target — jumping whatever
  // sat in between, gates included. "a human cannot invent a target any more than a
  // model can" was a comment with nothing behind it.
  const { second, runId, gateId } = await restartedAtGate();
  const p = await second.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "redirect", take: ["e0"] },
    actor: alice,
    idempotencyKey: "r",
  });

  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, CODES.E_ROUTE_INVALID);
  assert.equal(second.writes.length, 0);
});

test("a redirect along an edge the node DOES declare still works", async () => {
  const { second, runId, gateId } = await restartedAtGate();
  const p = await second.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "redirect", take: ["e4"] },
    actor: alice,
    idempotencyKey: "r2",
  });

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(second.writes.length, 1);
});

// ── the permissive case must stay permissive ─────────────────────────────────

test("a gate that named nobody is still answerable by anyone", async () => {
  // Fail-closed is about "I could not read the list", never about "the list is empty".
  // Most gates in this repo declare no approvers at all, and they must keep working.
  const { second, runId, gateId } = await restartedAtGate();
  const open = await second.engine.openGates(runId);
  assert.deepEqual(open[0]!.approvers, []);

  const p = await second.engine.resolveGate(runId, {
    gateId,
    decision: { kind: "approve" },
    actor: mallory,
    idempotencyKey: "anyone",
  });
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
});

test("a MODEL never satisfies a human approval", async () => {
  // An agent actor holding the broker is not a hypothetical — an agent node runs
  // in-process with it. "Any actor whose id happens to be in the list" would let a
  // profile named `u:alice` approve its own gate.
  //
  // `resolveGate`'s parameter type refuses this at COMPILE time now, which is why the
  // cast is here; the cast is what a route added later would have to write, so the
  // runtime refusal has to hold too.
  const { second, runId, gateId } = await restartedAtGate(["u:alice"]);
  const impostor: Actor = {
    kind: "agent",
    profile: "u:alice",
    taskId: "summarize@root#0" as TaskId,
    model: "mock",
  };

  await assert.rejects(
    () =>
      second.engine.resolveGate(runId, {
        gateId,
        decision: { kind: "approve" },
        actor: impostor as unknown as HumanActor,
        idempotencyKey: "bot",
      }),
    unauthorized,
  );
});

// ── the public door takes a human, and nothing else ──────────────────────────

test("THE PUBLIC DOOR REFUSES A SYSTEM ACTOR, whatever it calls itself", async () => {
  // `Engine.resolveGate` accepted any `Actor`, so an in-process caller — or a route added
  // later — could present `{kind:"system", component:"replay"}` and walk past every
  // approvers list, because `replay` is on the broker's allow-list. The narrowing in
  // `isAuthorizedActor` was only ever as strong as every caller remembering to construct a
  // human, which is the same assumption that produced the original bypass.
  const { second, runId, gateId } = await restartedAtGate(["u:alice"]);

  for (const component of ["replay", "executor:subgraph", "gate-broker:timeout"]) {
    await assert.rejects(
      () =>
        second.engine.resolveGate(runId, {
          gateId,
          decision: { kind: "approve" },
          actor: { kind: "system", component } as unknown as HumanActor,
          idempotencyKey: `sys:${component}`,
        }),
      unauthorized,
      `system:${component} answered a gate through the public door`,
    );
  }

  const p = await second.engine.projection(runId);
  assert.equal(p?.gates[gateId]?.state, "open", "the gate is untouched");
  assert.equal(
    (await events(second, runId)).some((e) => e.type === "gate.decided"),
    false,
  );
});

test("…and a replay-mode engine still serves its own recorded decisions", async () => {
  // The exception has to stay reachable where it is legitimate, or every replay of a run
  // with a RESTRICTED gate diverges — and `replay.test.ts` cannot catch that, because its
  // gate names nobody and never consults the list at all. `replayRun` builds an engine in
  // replay mode against a shadow store; that mode is the entitlement, not the name.
  const spec = specWithApprovers(["u:alice"]);
  const h = harness();
  const graph = compileSkeleton(spec);
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS }, workflow: "skeleton-summarize" });
  let p = await h.engine.advance(runId);
  const gateId = Object.values(p.gates).find((g) => g.state === "open")!.gateId;
  p = await h.engine.resolveGate(runId, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a" });
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: {
      tools: h.engine.tools,
      functions: h.engine.functions,
      models: h.engine.models,
      policy: { granted: SKELETON_TENANT_CAPS },
    },
  });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match).slice(0, 2)));
});

// ── every gate-raising path, not just the `human_gate` node ──────────────────

test("A POSTURE GATE CARRIES AN EDIT ALLOW-LIST TOO", async () => {
  // `allowEdit` used to be set only when the node had a `humanGate` block, and `#authorize`
  // skips the channel loop when the list is absent. So every gate raised by POLICY — which
  // is most of them at a raised posture — accepted an `edit` of any channel in the run,
  // `costUsd` included. `start` declares no writes at all, so its answer is `[]`.
  const h = harness({ systemFloor: "in" });
  const runId = await h.engine.submit({
    graph: compileSkeleton(),
    inputs: { paths: DOCS },
    workflow: "skeleton-summarize",
  });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");

  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  assert.equal(gate.nodeId, "start", "the first node gates on posture, with no humanGate block anywhere");
  assert.deepEqual(gate.allowEdit, [], "a node that declares no writes may have none edited");

  await assert.rejects(
    () =>
      h.engine.resolveGate(runId, {
        gateId: gate.gateId,
        decision: { kind: "edit", writes: { costUsd: 999 } },
        actor: alice,
        idempotencyKey: "e",
      }),
    unauthorized,
  );
  const after = await h.engine.projection(runId);
  assert.notEqual(after?.channels["costUsd"], 999);
});

// ── the broker itself, with no engine in front of it ─────────────────────────

const RUN = "run_gate_auth" as RunId;

function brokerRig(): { store: MemoryStateStore; log: RunLog; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  return { store, log: new RunLog(RUN, { store, now }), clock };
}

const request = (over: Partial<GateRequest> = {}): GateRequest => ({
  runId: RUN,
  taskId: "restart@root#0" as TaskId,
  nodeId: "restart" as NodeId,
  policyRef: "oversight/restart@stable",
  payload: { command: "kubectl rollout restart deploy/api" },
  ...over,
});

test("THE BROKER IS THE ENFORCEMENT SITE, so every entry point inherits the rule", async () => {
  // The old check lived in the inbound-callback route. That made the rule true for the
  // one door that remembered it and false for the HTTP control plane, the CLI and the
  // console — which is not a rule, it is a coincidence.
  const { store, log, clock } = brokerRig();
  const raiser = new HumanGateBroker({ now: () => clock.t });
  const gateId = await raiser.raise(log, request({ approvers: ["u:alice"], allowEdit: ["plan"] }));

  const restarted = new HumanGateBroker({ now: () => clock.t });
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });

  await assert.rejects(
    () => restarted.resolve(freshLog, { gateId, decision: { kind: "approve" }, actor: mallory, idempotencyKey: "k" }),
    unauthorized,
  );
  await assert.rejects(
    () =>
      restarted.resolve(freshLog, {
        gateId,
        decision: { kind: "edit", writes: { secrets: "x" } },
        actor: alice,
        idempotencyKey: "k2",
      }),
    unauthorized,
  );

  const ok = await restarted.resolve(freshLog, {
    gateId,
    decision: { kind: "edit", writes: { plan: "narrower" } },
    actor: alice,
    idempotencyKey: "k3",
  });
  assert.equal(ok.resolved, true);
});

test("rehydrate CANNOT re-declare who may approve", async () => {
  // It is reachable by anyone holding the broker and it writes no journal entry, so a
  // list handed to it would be authorization with no audit trail behind it. It keeps
  // the rendered payload and nothing else.
  const { store, log, clock } = brokerRig();
  const raiser = new HumanGateBroker({ now: () => clock.t });
  const gateId = await raiser.raise(log, request({ approvers: ["u:alice"] }));

  const restarted = new HumanGateBroker({ now: () => clock.t });
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });
  restarted.rehydrate(gateId, request({ approvers: ["u:mallory"], payload: { rendered: "again" } }));

  const open = await restarted.list(freshLog);
  assert.deepEqual(open[0]!.approvers, ["u:alice"], "the journal wins");
  assert.deepEqual(open[0]!.payload, { rendered: "again" }, "…and the payload is what rehydrate is FOR");

  await assert.rejects(
    () => restarted.resolve(freshLog, { gateId, decision: { kind: "approve" }, actor: mallory, idempotencyKey: "k" }),
    unauthorized,
  );
});

test("THE SLA DEADLINE IS ABSOLUTE, so a deploy neither resets nor skips it", async () => {
  // Same root cause, different consequence: the deadline lived in the same `Map`, so a
  // restarted process swept forever and never fired. A gate that outlives its SLA is an
  // approval nobody ever has to give.
  const { store, log, clock } = brokerRig();
  const raiser = new HumanGateBroker({ now: () => clock.t });
  const gateId = await raiser.raise(log, request({ slaMs: 60_000, onTimeout: "fail" }));

  const restarted = new HumanGateBroker({ now: () => clock.t });
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });

  assert.deepEqual(await restarted.sweepTimeouts(freshLog, 1_059_999), [], "not due yet");

  // A rehydrate mid-life must not buy the gate another SLA; the old one recomputed
  // `now() + slaMs` here, which quietly extended every open gate on every deploy.
  clock.t = 1_059_999;
  restarted.rehydrate(gateId, request({ slaMs: 60_000 }));

  assert.deepEqual(await restarted.sweepTimeouts(freshLog, 1_060_000), [gateId], "due, in the process that never raised it");

  const seq = await events({ store }, RUN);
  assert.equal(seq.filter((e) => e.type === "gate.timeout").length, 1);
  assert.equal(seq.some((e) => e.type === "run.failed"), true, "…and an expired gate fails the run rather than hanging it");
});

test("A SYSTEM ACTOR IS NOT A SKELETON KEY", async () => {
  // `if (a.kind === "system") return true` was written for two callers whose authority is
  // journaled elsewhere — the timeout path and a parent forwarding a human's decision.
  // As a blanket rule it made every in-process component an approver for every gate.
  const { store, log, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });
  const gateId = await broker.raise(log, request({ approvers: ["u:alice"] }));

  for (const component of ["cron", "executor", "console", "replay-ish"]) {
    await assert.rejects(
      () =>
        broker.resolve(new RunLog(RUN, { store, now: () => clock.t }), {
          gateId,
          decision: { kind: "approve" },
          actor: { kind: "system", component },
          idempotencyKey: `k:${component}`,
        }),
      unauthorized,
      `system:${component} answered a gate it was never named on`,
    );
  }
});

test("…but the timeout path still answers its own gate", async () => {
  // The narrowing has to keep the two components that legitimately reach `resolve`
  // working, or "fail closed" turns every SLA on a restricted gate into a hang.
  const { store, log, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });
  await broker.raise(
    log,
    request({ approvers: ["u:alice"], slaMs: 60_000, onTimeout: "default_action", defaultAction: { kind: "approve" } }),
  );
  await broker.sweepTimeouts(log, 1_060_000);

  const seq = await events({ store }, RUN);
  assert.equal(seq.some((e) => e.type === "gate.decided"), true, "the declared default still decided a restricted gate");
});

test("A HEALTHY default_action SWEEP PASSES `auditRun` — the timeout row is not a closure", async () => {
  // `gate.timeout{default_action}` and the `gate.decided` that answers it are ONE append,
  // for the same gate, on purpose — gates.ts merged them to delete the window a second
  // sweeper raced in. A `gate.decided-once` rule that counted `gate.timeout` as a closure
  // therefore fired on every healthy SLA expiry. gates.ts says which of the two moves the
  // gate where it writes them: the timeout row "is folded as a deliberate no-op — the gate
  // stays `open` and its deadline does not move". Only `fail` ends a gate by itself.
  const { store, log, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });
  await broker.raise(
    log,
    request({ approvers: ["u:alice"], slaMs: 60_000, onTimeout: "default_action", defaultAction: { kind: "approve" } }),
  );
  await broker.sweepTimeouts(log, 1_060_000);

  const seq = await events({ store }, RUN);
  // The shape this is about has to actually be in the journal, or the assertion is vacuous.
  assert.equal(seq.filter((e) => e.type === "gate.timeout").length, 1);
  assert.equal(seq.filter((e) => e.type === "gate.decided").length, 1);

  const report = auditRun(seq);
  assert.ok(report.checked.includes("gate.decided-once"), "the rule must have examined this journal");
  assert.deepEqual(
    report.violations.filter((v) => v.rule === "gate.decided-once"),
    [],
    `a healthy default_action sweep must not violate: ${JSON.stringify(report.violations)}`,
  );
});

// ── the sweep is a sweep: one gate cannot stop it ────────────────────────────

test("A REFUSED DEFAULT ACTION EXPIRES ITS GATE INSTEAD OF WEDGING EVERY LATER SWEEP", async () => {
  // The regression: making `default_action` a non-expiry removed the only thing bounding
  // an exception thrown out of `resolve`. A gate whose default action is refused left
  // itself `open` with a `gate.timeout` already on the record, so every later sweep threw
  // at the same gate and NO OTHER GATE IN THE RUN EVER FIRED AGAIN.
  const { store, log, clock } = brokerRig();
  const raiser = new HumanGateBroker({ now: () => clock.t });
  const g1 = await raiser.raise(
    log,
    request({ slaMs: 1000, onTimeout: "default_action", defaultAction: { kind: "edit", writes: { plan: "narrower" } }, allowEdit: ["plan"] }),
  );
  const g2 = await raiser.raise(log, request({ taskId: "other@root#0" as TaskId, slaMs: 1000, onTimeout: "fail" }));

  // `rehydrate` is the door around raise-time validation: it re-attaches an ephemeral
  // half with no journal entry behind it, so a wrong default action can still arrive.
  const restarted = new HumanGateBroker({ now: () => clock.t });
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });
  restarted.rehydrate(g1, request({ defaultAction: { kind: "edit", writes: { costUsd: 999 } } }));

  const fired = await restarted.sweepTimeouts(freshLog, 9_000_000);
  assert.deepEqual(fired, [g1], "the broken gate resolved itself rather than throwing out of the sweep");

  const p = (await restarted.project(freshLog))!;
  assert.equal(p.gates[g1]?.state, "expired", "a default action that cannot be applied expires its gate");
  assert.notEqual(p.channels["costUsd"], 999, "and the refused edit never landed");

  // AND THE RUN IS OVER, so `g2` is not swept — which is the ordering rule, not a wedge.
  // Expiring `g1` appended `run.failed`; a sibling gate on a run this very tick has already
  // killed must not be expired too, because that would append a SECOND terminal record.
  // What used to happen here is exactly that: `g2` fired, and the journal ended up with two
  // contradictory `run.failed` rows, the second of which the fold silently dropped.
  assert.equal(p.status, "failed");
  assert.equal(p.gates[g2]?.state, "open", "a dead run leaves its remaining questions unanswered, not answered wrongly");
  assert.equal((await events({ store }, RUN)).filter((e) => e.type === "run.failed").length, 1);

  // …and the wedge is not merely deferred: a second sweep has nothing left to do.
  const before = (await events({ store }, RUN)).length;
  assert.deepEqual(await restarted.sweepTimeouts(freshLog, 9_000_001), []);
  assert.equal((await events({ store }, RUN)).length, before, "no re-appended gate.timeout, no second throw");
});

test("A RUN THAT ENDED MID-TIMEOUT GETS NO EXPIRY WRITTEN ON TOP OF IT", async () => {
  // The one path into the journal that a run-terminal check further up cannot cover, and
  // therefore the reason the check lives at the WRITE DOOR. `#fireTimeout`'s default-action
  // arm writes `gate.timeout`, applies the decision, and — if the decision is refused —
  // expires the gate on a FRESH projection, because its own earlier write made the old seq
  // stale. A fresh projection is exactly what an operator's cancel can land in front of: the
  // sweep then holds a seq at which the run is already `cancelled`, so the compare-and-swap
  // succeeds and appends `gate.timeout` + `run.failed` on top of the refusal.
  //
  // Both terminal records would then be in the store invariant 2 calls authoritative, saying
  // opposite things about why the run stopped. The fold takes the first and drops the second,
  // so no read model is wrong — and "the journal disagrees with itself but the projection
  // hides it" is not a fix, it is the defect with a lid on.
  const { store, log, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });
  const gateId = await broker.raise(
    log,
    request({ slaMs: 1000, onTimeout: "default_action", defaultAction: { kind: "approve" } }),
  );

  // An operator cancels the run in the window between the sweep's own two writes.
  const cancelling = {
    append: async (input: Parameters<MemoryStateStore["append"]>[0]) => {
      const res = await store.append(input);
      if (input.events.some((ev) => ev.type === "gate.timeout")) {
        await store.append({
          runId: RUN,
          expectedSeq: await store.head(RUN),
          events: [
            {
              type: "run.cancelled",
              payload: { clean: true, unknownEffects: [], forced: false },
              actor: SYSTEM_ACTOR("operator"),
            },
          ],
          now: clock.t,
        });
      }
      return res;
    },
    read: (rid: RunId, from: Parameters<MemoryStateStore["read"]>[1], to?: Parameters<MemoryStateStore["read"]>[2]) =>
      store.read(rid, from, to),
    head: (rid: RunId) => store.head(rid),
    listRuns: (limit?: number) => store.listRuns(limit),
    close: () => store.close(),
  };

  await broker.sweepTimeouts(new RunLog(RUN, { store: cancelling, now: () => clock.t }), 9_000_000);

  const seq = await events({ store }, RUN);
  assert.equal(seq.filter((e) => e.type === "run.failed").length, 0, "NOTHING WAS WRITTEN ON TOP OF THE CANCEL");
  assert.equal(seq.filter((e) => e.type === "run.cancelled").length, 1);
  const p = (await broker.project(log))!;
  assert.equal(p.status, "cancelled");
  assert.notEqual(p.gates[gateId]?.state, "expired", "the operator stopped it; the clock did not");
});

test("ONE GATE CANNOT WEDGE THE SWEEP FOR THE WHOLE RUN", async () => {
  // The property the test above used to carry, isolated from the run-terminal ordering that
  // now (correctly) stops a tick after an expiry. A sweep is a RUN-WIDE loop, so a gate
  // whose write throws must cost that gate and no other — here the store refuses `g1`'s
  // expiry, which leaves the run alive, and `g2` behind it must still reach its deadline in
  // the SAME tick.
  const { store, log, clock } = brokerRig();
  const raiser = new HumanGateBroker({ now: () => clock.t });
  const g1 = await raiser.raise(log, request({ slaMs: 1000, onTimeout: "fail" }));
  const g2 = await raiser.raise(log, request({ taskId: "other@root#0" as TaskId, slaMs: 1000, onTimeout: "fail" }));

  const refusing = {
    append: (input: Parameters<MemoryStateStore["append"]>[0]) =>
      input.events.some((ev) => ev.type === "gate.timeout" && (ev.payload as { gateId: GateId }).gateId === g1)
        ? Promise.reject(new Error("the store is not accepting writes"))
        : store.append(input),
    read: (rid: RunId, from: Parameters<MemoryStateStore["read"]>[1], to?: Parameters<MemoryStateStore["read"]>[2]) =>
      store.read(rid, from, to),
    head: (rid: RunId) => store.head(rid),
    listRuns: (limit?: number) => store.listRuns(limit),
    close: () => store.close(),
  };

  const broker = new HumanGateBroker({ now: () => clock.t });
  const fired = await broker.sweepTimeouts(new RunLog(RUN, { store: refusing, now: () => clock.t }), 9_000_000);
  assert.deepEqual(fired, [g2], "THE GATE BEHIND THE UNWRITABLE ONE STILL FIRED");

  const p = (await broker.project(new RunLog(RUN, { store, now: () => clock.t })))!;
  assert.equal(p.gates[g1]?.state, "open", "the refused write left its own gate exactly as it found it");
  assert.equal(p.gates[g2]?.state, "expired");
});

test("AN UNSATISFIABLE DEFAULT ACTION IS REFUSED AT RAISE, not discovered at the deadline", async () => {
  // Finding a configuration error when the SLA expires is finding it at the worst
  // possible moment: mid-incident, with a run suspended behind it.
  const { log, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });

  await assert.rejects(
    () =>
      broker.raise(
        log,
        request({ slaMs: 1000, onTimeout: "default_action", defaultAction: { kind: "edit", writes: { costUsd: 999 } }, allowEdit: ["plan"] }),
      ),
    unauthorized,
  );

  const p = await broker.project(log);
  assert.equal(p, undefined, "the gate was never persisted, so no run is suspended behind it");
});

// ── a journal written before the deadline was journaled ──────────────────────

/** A `gate.raised` in the old shape: no `deadline`, no `slaMs`. */
async function legacyGate(log: RunLog, clock: { t: number }): Promise<GateId> {
  const gateId = newGateId(clock.t);
  await log.append(
    [
      {
        type: "gate.raised",
        payload: { gateId, nodeId: "restart" as NodeId, policyRef: "oversight/restart@stable", contentDigest: "sha256:old" },
        actor: SYSTEM_ACTOR("gate-broker"),
        taskId: "restart@root#0" as TaskId,
      },
      { type: "run.suspended", payload: { reason: "gate" }, actor: SYSTEM_ACTOR("gate-broker") },
    ],
    { taskId: "restart@root#0" as TaskId },
  );
  return gateId;
}

test("A GATE RAISED BEFORE THE DEADLINE WAS JOURNALED STILL TIMES OUT", async () => {
  // The sweep reads only the journal now, and `rehydrate` deliberately discards the SLA
  // an operator supplies — so an old-format gate hung open forever with its run
  // suspended, which is the opposite of the fail-closed direction.
  const { store, log, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });
  const gateId = await legacyGate(log, clock);
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });

  assert.deepEqual(await broker.sweepTimeouts(freshLog, 1e9), [], "with nothing supplied it still has no clock");

  broker.rehydrate(gateId, request({ slaMs: 1000, onTimeout: "fail" }));
  assert.deepEqual(await broker.sweepTimeouts(freshLog, 1e9), [gateId], "an operator can give an old gate a terminating clock");

  const seq = await events({ store }, RUN);
  assert.equal(seq.some((e) => e.type === "run.failed"), true);
});

test("a supplied SLA is measured from the JOURNALED raise, so it cannot be refreshed", async () => {
  // Otherwise the rescue path reintroduces the defect it rescues from: re-rehydrating on
  // every deploy would hand the gate a fresh SLA each time.
  const { store, log, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });
  const gateId = await legacyGate(log, clock);
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });

  broker.rehydrate(gateId, request({ slaMs: 1000, onTimeout: "fail" }));
  clock.t = 1_000_000_000;
  broker.rehydrate(gateId, request({ slaMs: 1000, onTimeout: "fail" }));

  assert.deepEqual(await broker.sweepTimeouts(freshLog, 1_001_000), [gateId], "due 1000ms after it was RAISED");
});

test("a supplied SLA cannot shorten a deadline the journal already has", async () => {
  const { store, log, clock } = brokerRig();
  const raiser = new HumanGateBroker({ now: () => clock.t });
  const gateId = await raiser.raise(log, request({ slaMs: 60_000, onTimeout: "fail" }));

  const restarted = new HumanGateBroker({ now: () => clock.t });
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });
  restarted.rehydrate(gateId, request({ slaMs: 1 }));

  assert.deepEqual(await restarted.sweepTimeouts(freshLog, 1_000_002), [], "the journaled deadline is the only one");
});

test("a default_action whose decision did not survive the restart FAILS CLOSED", async () => {
  // The pre-authorized decision is deliberately not journaled. Losing it must not leave
  // the gate expired with a run suspended behind it and no path out — a hang wearing a
  // policy's clothes.
  const { store, log, clock } = brokerRig();
  const raiser = new HumanGateBroker({ now: () => clock.t });
  await raiser.raise(log, request({ slaMs: 60_000, onTimeout: "default_action", defaultAction: { kind: "approve" } }));

  const restarted = new HumanGateBroker({ now: () => clock.t });
  const freshLog = new RunLog(RUN, { store, now: () => clock.t });
  await restarted.sweepTimeouts(freshLog, 1_060_000);

  const seq = await events({ store }, RUN);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "a lost default action never approves by omission");
  assert.deepEqual(
    seq.filter((e) => e.type === "gate.timeout").map((e) => (e.payload as { action: string }).action),
    ["fail"],
    "the journal records what actually happened, not what was declared",
  );
  assert.equal(seq.some((e) => e.type === "run.failed"), true);
});

test("the SAME process still honours its own default action", async () => {
  const { log, store, clock } = brokerRig();
  const broker = new HumanGateBroker({ now: () => clock.t });
  await broker.raise(log, request({ slaMs: 60_000, onTimeout: "default_action", defaultAction: { kind: "approve" } }));
  await broker.sweepTimeouts(log, 1_060_000);

  const seq = await events({ store }, RUN);
  assert.equal(seq.some((e) => e.type === "gate.decided"), true);
});

// ── declaring it in a graph ──────────────────────────────────────────────────

const diagnose = (spec: GraphSpec): readonly Diagnostic[] =>
  compile({ spec, resolver: resolver(), tools: SKELETON_TOOLS, tenantCapabilities: SKELETON_TENANT_CAPS }).diagnostics;

const withApproval = (approval: Record<string, unknown>): GraphSpec => {
  const base = skeletonSpec();
  return {
    ...base,
    nodes: base.nodes.map((n) => (n.id !== APPROVE_NODE ? n : { ...n, humanGate: { ref: n.humanGate!.ref, approval } })),
  };
};

test("a graph can declare its approvers, and the plain case compiles", () => {
  const d = diagnose(withApproval({ mode: "single", approvers: ["u:alice"] }));
  assert.deepEqual(d.filter((x) => x.severity === "error"), []);
});

test("AN APPROVAL RULE THE RUNTIME DOES NOT APPLY IS REFUSED, NOT IGNORED", () => {
  // "Looks supervised, is not" is the worst failure this layer has (D7.9), and silently
  // downgrading `quorum: 2` to one approver is exactly it — in the place nobody checks,
  // because the graph says it is covered.
  for (const approval of [
    { mode: "quorum", k: 2, approvers: ["u:alice", "u:bob"] },
    { mode: "all", approvers: ["u:alice"] },
    { mode: "tiered", approvers: ["u:alice"] },
    { mode: "single", k: 2, approvers: ["u:alice"] },
    { mode: "single", approvers: ["u:alice"], delegation: { allowed: true, maxDepth: 2 } },
  ]) {
    const hit = diagnose(withApproval(approval)).filter((x) => x.code === "GRAPH014_APPROVAL_UNSUPPORTED");
    assert.ok(hit.length > 0, `${JSON.stringify(approval)} compiled clean`);
    assert.equal(hit[0]!.severity, "error");
  }
  // `separationOfDuties` LEFT THIS LIST BY BEING BUILT, which is how the docstring says
  // support arrives: by deleting a check. It is the only one that has.
  assert.deepEqual(
    diagnose(withApproval({ mode: "single", approvers: ["u:alice"], separationOfDuties: true })).filter((x) => x.severity === "error"),
    [],
  );
});

test("SEPARATION OF DUTIES NARROWS AN APPROVERS LIST — it does not stand in for one", () => {
  // The rule bars the initiator. Declared with no approvers it would read as "everybody
  // except one person" — supervised-looking and answerable by every authenticated principal
  // but one, which is the same failure the deleted refusal was written against. Unlike that
  // one this IS decidable at compile time, because both halves are in the spec.
  const codes = diagnose(withApproval({ separationOfDuties: true })).map((x) => x.code);
  assert.ok(codes.includes("GRAPH014_APPROVAL_INCOMPLETE"), "declared with no approvers");
  assert.deepEqual(
    diagnose(withApproval({ separationOfDuties: true, approvers: ["u:alice"] })).filter((x) => x.severity === "error"),
    [],
    "…and with one, it compiles",
  );
});

test("declaring a feature and turning it OFF is not an error", () => {
  const d = diagnose(withApproval({ approvers: ["u:alice"], separationOfDuties: false, delegation: { allowed: false } }));
  assert.deepEqual(d.filter((x) => x.severity === "error"), []);
});

test("an approver that cannot match anything is refused", () => {
  // An approvers list of `[""]` authorizes everybody by accident, because "matches
  // nobody" and "names nobody" look identical at the check.
  for (const approvers of [[""], ["   "], [{ kind: "role", id: "sre-oncall" }]]) {
    const codes = diagnose(withApproval({ approvers })).map((x) => x.code);
    assert.ok(codes.includes("GRAPH014_APPROVER_INVALID"), `${JSON.stringify(approvers)} compiled clean`);
  }
});

test("AN APPROVER THAT MATCHES THE WRONG THING IS REFUSED TOO — a synthetic marker is not a subject", () => {
  // The other way to write "this list authorizes everyone", and the worse one, because it
  // MATCHES. `ControlPlane` mints `(unidentified)` for a caller it could not identify and
  // `(shared-token)` for one holding the plane's own credential — descriptions of what the
  // perimeter concluded, not names — so a gate reading "the security lead must approve" is
  // satisfied by exactly the callers nobody vouched for.
  //
  // The HTTP door refuses a CLAIMED `(unidentified)` at the perimeter, which is why this
  // read as unreachable for two waves. It is one door of three: `SignedWebhookChannel`'s
  // callback route and `loom approve --as` each construct the actor themselves.
  for (const who of ["(unidentified)", "(shared-token)", "(admin)", "(system)"]) {
    const hit = diagnose(withApproval({ approvers: [who] })).filter((x) => x.code === "GRAPH014_APPROVER_INVALID");
    assert.ok(hit.length > 0, `"${who}" compiled clean as an approver`);
    assert.equal(hit[0]!.severity, "error");
  }

  // The refusal is on the parenthesised FORM and not on a list of the two markers this
  // build happens to mint, so a marker added later is refused by construction. It is also
  // not a ban on brackets anywhere in a subject.
  //
  // THE SHAPE IS THE MARKER'S OWN GRAMMAR — one parenthesised lower-case token — and that
  // precision is load-bearing in both directions. A looser `startsWith("(") &&
  // endsWith(")")` refused `"(sre) alice (oncall)"` and `"( )"`, which at the HTTP
  // perimeter means a deployment whose SSO subjects carry a parenthesised team prefix
  // cannot authenticate anyone at all.
  assert.deepEqual(
    diagnose(
      withApproval({
        approvers: ["u:alice", "svc:deployer", "u:o'brien (sre)", "(sre) alice (oncall)", "( )", "()", "(Team)"],
      }),
    ).filter((x) => x.code === "GRAPH014_APPROVER_INVALID").length,
    0,
    "an ordinary subject that merely contains parentheses is still a subject",
  );

  // …and whitespace is not a way around it. The three doors disagree about trimming —
  // `checkApproval` trims before asking, `subjectFlag` and `checkedAuth` do not — so the
  // rule trims, once, where it is stated.
  for (const padded of [" (unidentified)", "(unidentified) ", "  (shared-token)  "]) {
    assert.ok(
      diagnose(withApproval({ approvers: [padded] })).some((x) => x.code === "GRAPH014_APPROVER_INVALID"),
      `"${padded}" slipped past on whitespace`,
    );
  }
});

// ── helper ───────────────────────────────────────────────────────────────────

async function events(h: { store: { read: MemoryStateStore["read"] } }, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of h.store.read(runId, 1)) out.push(e);
  return out;
}
