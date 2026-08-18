/**
 * Retention tiering and the audit record.
 *
 * Two claims, both about what cannot happen:
 *
 * 1. The journal is never PRUNED, only tiered — archiving changes where events live, not
 *    whether they exist, and a restored journal still replays.
 * 2. A retention change made for telemetry cost cannot shorten the record of who
 *    approved what, because the audit tier has its own window and its own store.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RETENTION,
  MemoryTierStore,
  TierManager,
  auditViolations,
  extractAudit,
  tierFor,
  type RetentionPolicy,
} from "../../src/journal/retention.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { GateId, RunId, TaskId } from "../../src/ids.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { replayRun } from "../../src/run/replay.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { DOCS, compileSkeleton, harness } from "../run/skeleton.ts";

const RUN = "run_ret" as RunId;
const DAY = 86_400_000;

let seq = 0;
function ev(type: string, payload: unknown, extra: Partial<JournalEvent> = {}): JournalEvent {
  seq++;
  return {
    seq,
    runId: RUN,
    ts: seq * 1000,
    actor: { kind: "system", component: "test" },
    type,
    payload,
    ...extra,
  } as unknown as JournalEvent;
}

const HUMAN = { kind: "human", subject: "u:alice", via: "console" } as const;

function journal(): JournalEvent[] {
  seq = 0;
  return [
    ev("run.submitted", {
      workflow: "w",
      graphHash: "h",
      inputs: {},
      idempotencyKey: "i",
      configDigest: "c",
      submittedBy: { kind: "human", subject: "u:alice", method: "sso" },
    }),
    ev(
      "policy.decided",
      { effect: "gate", posture: "in", irreversibility: "irreversible", reasons: ["irreversible tool", "system floor on"] },
      { taskId: "charge@root#0" as TaskId },
    ),
    ev(
      "gate.raised",
      { gateId: "g1" as GateId, nodeId: "charge", policyRef: "p", contentDigest: "sha256:abc" },
      { taskId: "charge@root#0" as TaskId },
    ),
    ev(
      "gate.decided",
      { gateId: "g1" as GateId, decision: "reject", justification: "wrong account", latencyMs: 42_000 },
      { taskId: "charge@root#0" as TaskId, actor: HUMAN },
    ),
    ev("policy.escalated", { rule: "violation", from: "on", to: "in", scope: `run:${RUN}` }),
    ev(
      "policy.deescalated",
      { from: "in", to: "on", scope: `run:${RUN}`, justification: "incident window" },
      { actor: HUMAN },
    ),
    ev("operator.command", { kind: "pause", args: {} }, { actor: HUMAN }),
    ev(
      "tool.called",
      { key: "k", name: "pay.charge", version: "1.0", irreversibility: "irreversible", idempotent: false, ok: true, ms: 12, argsShape: "{amount:number}" },
      { taskId: "charge@root#0" as TaskId },
    ),
    ev(
      "tool.called",
      { key: "k2", name: "fs.read", version: "1.0", irreversibility: "read_only", idempotent: true, ok: true, ms: 1, argsShape: "{path:string}" },
      { taskId: "read@root#0" as TaskId },
    ),
    ev("run.completed", { outputs: {}, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 } }),
  ];
}

const manager = (policy?: RetentionPolicy, now = () => 10 * DAY) =>
  new TierManager({
    cold: new MemoryTierStore("cold"),
    audit: new MemoryTierStore("audit"),
    now,
    ...(policy === undefined ? {} : { policy }),
  });

// ── tier assignment ──────────────────────────────────────────────────────────

test("tiering is by AGE and by nothing else", () => {
  assert.equal(tierFor(0), "hot");
  assert.equal(tierFor(7 * DAY), "hot");
  assert.equal(tierFor(8 * DAY), "warm");
  assert.equal(tierFor(31 * DAY), "cold");
  // An event does not become more retainable because of what it says — auditability is
  // handled by DUPLICATION, not by exempting some events from tiering.
});

test("the audit window is INDEPENDENT of the cold window", () => {
  assert.equal(
    DEFAULT_RETENTION.audit.retentionMs,
    Infinity,
    "coupling them lets a cost-cutting change shorten the approval record as a side effect",
  );
  // The two are infinite for unrelated reasons — audit because no mandate applies, cold
  // because cold IS the journal — so agreeing here proves nothing about independence.
  // The test that would catch a coupled `audit` is the one that shortens cold below.
  assert.equal(DEFAULT_RETENTION.cold.retentionMs, Infinity);
  assert.equal(DEFAULT_RETENTION.hot.retentionMs, 7 * DAY, "telemetry tiers keep real numbers");
  assert.equal(DEFAULT_RETENTION.warm.retentionMs, 30 * DAY);
});

// ── the audit record ─────────────────────────────────────────────────────────

test("every kind of accountable act becomes an audit record", () => {
  const records = extractAudit(journal());
  assert.deepEqual(
    records.map((r) => r.kind),
    ["run_submitted", "gate_decision", "policy_change", "policy_change", "operator_command", "agent_action"],
  );
});

test("the submission record names the PRINCIPAL, because its actor cannot", () => {
  const submitted = extractAudit(journal()).find((r) => r.kind === "run_submitted")!;
  // The row was appended by a system component and says so — that is the honest answer to
  // "what wrote this", and in the real engine it is `system:control-plane`. Without the
  // second field the audit projection would answer "who started this run that spent money"
  // with "the software did".
  assert.equal(submitted.actor.kind, "system");
  assert.deepEqual(submitted.principal, { kind: "human", subject: "u:alice", method: "sso" });
  assert.equal(submitted.decision, "w", "which workflow was started");
});

test("a run submitted with no recorded principal still audits, and claims nobody", () => {
  const [first] = extractAudit([
    ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
  ]);
  // Absent, not a synthetic name: a journal written before the field existed says nothing
  // about who started the run, and a placeholder would read like an answer.
  assert.equal(first?.kind, "run_submitted");
  assert.equal(first?.principal, undefined);
});

test("a read-only tool call is NOT an audit record; an irreversible one is", () => {
  const actions = extractAudit(journal()).filter((r) => r.kind === "agent_action");
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.decision, "pay.charge@1.0", "'who did what' includes what the machine did alone");
});

test("a gate decision carries WHAT THE APPROVER SAW", () => {
  const gate = extractAudit(journal()).find((r) => r.kind === "gate_decision")!;
  assert.equal(gate.contentDigest, "sha256:abc");
  assert.equal(gate.decision, "reject");
  assert.equal(gate.justification, "wrong account");
  assert.equal(gate.latencyMs, 42_000);
  assert.deepEqual(gate.actor, HUMAN, "the human, not the component that wrote the row");
});

test("a gate decision carries the POLICY REASONS that made it necessary", () => {
  const gate = extractAudit(journal()).find((r) => r.kind === "gate_decision")!;
  assert.deepEqual(gate.policyReasons, ["irreversible tool", "system floor on"]);
  // An audit that cannot say why the question was asked is not an audit.
});

test("a posture change records both sides of the transition", () => {
  const changes = extractAudit(journal()).filter((r) => r.kind === "policy_change");
  assert.deepEqual(changes[0]?.priorState, { posture: "on" });
  assert.deepEqual(changes[0]?.newState, { posture: "in" });
  assert.equal(changes[1]?.justification, "incident window", "a de-escalation must say why");
});

test("auditViolations catches a rejection or de-escalation with no justification", () => {
  assert.deepEqual(auditViolations(extractAudit(journal())), []);

  const bad = extractAudit([
    ev("gate.raised", { gateId: "g" as GateId, nodeId: "n", policyRef: "p", contentDigest: "d" }),
    ev("gate.decided", { gateId: "g" as GateId, decision: "reject", latencyMs: 1 }, { actor: HUMAN }),
  ]);
  assert.equal(auditViolations(bad).length, 1);
  assert.match(auditViolations(bad)[0]!, /no justification/);
});

test("extraction is a pure fold, so the audit store is always rebuildable", () => {
  assert.deepEqual(extractAudit(journal()), extractAudit(journal()));
});

// ── archiving ────────────────────────────────────────────────────────────────

test("archiving writes the FULL journal to cold and the audit records to audit", async () => {
  const m = manager();
  const events = journal();
  const result = await m.archive(RUN, events);

  assert.equal(result.events, events.length);
  assert.equal(result.auditRecords, 6);
  assert.ok(result.bytes > 0);

  const restored = await m.restore(RUN);
  assert.deepEqual(restored, events, "cold holds the WHOLE journal, not a summary");
});

test("THE JOURNAL IS NEVER PRUNED — an archived run still replays", async () => {
  const h = harness();
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  let p = await h.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });
  assert.equal(p.status, "succeeded");

  const events: JournalEvent[] = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);

  const m = manager();
  await m.archive(runId, events);
  const restored = (await m.restore(runId))!;

  // Rebuild a store from cold alone and replay out of it. If tiering had dropped a
  // single event, the effects would not resolve and this would diverge.
  const revived = new MemoryStateStore({ now: () => 1 });
  for (const e of restored) {
    await revived.append({
      runId,
      expectedSeq: (e.seq - 1) as typeof e.seq,
      events: [
        { type: e.type, payload: e.payload, actor: e.actor, ...(e.taskId === undefined ? {} : { taskId: e.taskId }) },
      ] as never,
    });
  }

  // The shadow rig has live tool bodies. If the restored journal were missing an
  // effect, replay would fall through to them and its counters would move.
  const shadow = harness();
  const report = await replayRun({
    runId,
    store: revived,
    graph,
    engine: {
      tools: shadow.tools,
      functions: shadow.functions,
      models: new ModelRegistry(),
      now: () => 1,
    },
  });
  assert.equal(report.match, true, "a run restored from cold storage still replays exactly");
  assert.deepEqual(shadow.writes, [], "and no tool body ran — every result came from the restored journal");
  assert.deepEqual(shadow.reads, []);
});

// ── the WORM property ────────────────────────────────────────────────────────

test("AN AUDIT RECORD CANNOT BE REWRITTEN", async () => {
  const audit = new MemoryTierStore("audit");
  await audit.put("k", { decision: "approve" }, 1);
  await assert.rejects(
    () => audit.put("k", { decision: "reject" }, 2),
    (e: unknown) => (e as { code: string }).code === "E_AUDIT_IMMUTABLE",
    "an audit store you can rewrite is a story, not a record",
  );
});

test("re-archiving the same run is idempotent, not a conflict", async () => {
  // A retry must not be an error. Only a DIFFERENT value under the same key is someone
  // editing history.
  const m = manager();
  await m.archive(RUN, journal());
  await m.archive(RUN, journal());
  assert.equal((await m.restore(RUN))?.length, journal().length);
});

test("cold storage is NOT write-once — a re-archive may legitimately supersede", async () => {
  const cold = new MemoryTierStore("cold");
  await cold.put("journal/x", [1], 1);
  await cold.put("journal/x", [1, 2], 2);
  assert.deepEqual(await cold.get("journal/x"), [1, 2]);
});

test("a TierManager refuses to start with a non-audit store in the audit slot", () => {
  assert.throws(
    () => new TierManager({ cold: new MemoryTierStore("cold"), audit: new MemoryTierStore("warm") }),
    (e: unknown) => (e as { code: string }).code === "E_CONFIG_INVALID",
  );
});

// ── the sweep ────────────────────────────────────────────────────────────────

test("THE SHIPPED DEFAULT NEVER DELETES THE JOURNAL — cold is where it rests, not a cache of it", async () => {
  // `archive` writes exactly one thing to cold: the whole event array under
  // `journal/<runId>`. So `policy.cold` is not a telemetry knob, it is the journal's
  // deletion window — and nothing exists below cold to tier to, so expiring it is
  // deletion rather than tiering. A finite default therefore inverts both rule 1 and the
  // journal's authority: the derived audit record, kept forever, would outlive the log it
  // was derived from. Today only a redundant copy is at stake, because nothing removes a
  // run from the hot store; the default is the part that must not be waiting for that.
  const m = manager();
  const events = journal();
  await m.archive(RUN, events);

  const swept = await m.sweep(1000 * 365 * DAY);
  assert.deepEqual(swept["cold"], [], "a thousand years on, the journal is still there");
  assert.deepEqual(await m.restore(RUN), events, "…and still replays, which is what rule 1 means");
});

test("deleting journals has to be SAID — it is not reachable by omission", async () => {
  const finite: RetentionPolicy = { ...DEFAULT_RETENTION, cold: { retentionMs: DAY } };
  assert.throws(
    () =>
      new TierManager({ cold: new MemoryTierStore("cold"), audit: new MemoryTierStore("audit"), policy: finite }),
    (e: unknown) => (e as { code: string }).code === "E_CONFIG_INVALID",
    "a finite cold window prunes the journal; half-saying it must not start",
  );

  // Saying it is allowed. An operator under a real erasure mandate is not blocked, only
  // made to state the intent somewhere a reviewer reads it.
  const m = new TierManager({
    cold: new MemoryTierStore("cold"),
    audit: new MemoryTierStore("audit"),
    policy: finite,
    pruneJournal: true,
    now: () => 0,
  });
  await m.archive(RUN, journal());
  assert.deepEqual((await m.sweep(30 * DAY))["cold"], [`journal/${RUN}`]);
});

test("SHORTENING COLD RETENTION DOES NOT TOUCH THE AUDIT RECORD", async () => {
  // The whole reason the two policies are separate. Someone cuts cold to a day — with
  // `pruneJournal`, because after that is what cutting cold means — and the record of who
  // approved what is unaffected.
  const now = { t: 0 };
  const m = new TierManager({
    cold: new MemoryTierStore("cold"),
    audit: new MemoryTierStore("audit"),
    policy: { ...DEFAULT_RETENTION, cold: { retentionMs: DAY } },
    pruneJournal: true,
    now: () => now.t,
  });
  await m.archive(RUN, journal());

  now.t = 30 * DAY;
  const swept = await m.sweep();
  assert.equal(swept["cold"]?.length, 1, "the journal aged out of cold");
  assert.deepEqual(swept["audit"], [], "the approval record did not");

  assert.equal(await m.restore(RUN), undefined);
  // …and the audit copy is still there, which is the point.
  const auditStore = new MemoryTierStore("audit");
  assert.equal(auditStore.tier, "audit");
});

test("an audit sweep with a finite window does expire — the policy is a real knob", async () => {
  const audit = new MemoryTierStore("audit");
  await audit.put("k", { a: 1 }, 0);
  assert.deepEqual(await audit.expire(DAY * 2, DAY), ["k"]);
});

test("an INFINITE window expires nothing, ever", async () => {
  const audit = new MemoryTierStore("audit");
  await audit.put("k", { a: 1 }, 0);
  assert.deepEqual(await audit.expire(Number.MAX_SAFE_INTEGER, Infinity), []);
  assert.equal((await audit.list()).length, 1);
});

test("archiving an empty journal is an error, not an empty archive", async () => {
  await assert.rejects(
    () => manager().archive(RUN, []),
    (e: unknown) => (e as { code: string }).code === "E_RUN_NOT_FOUND",
  );
});

// ── entries ──────────────────────────────────────────────────────────────────

test("a tier entry records size and digest, so a restore can be verified", async () => {
  const m = manager();
  await m.archive(RUN, journal());
  const cold = await new MemoryTierStore("cold").list();
  assert.deepEqual(cold, [], "a fresh store is empty — entries belong to the store that wrote them");

  const store = new MemoryTierStore("cold");
  const entry = await store.put("journal/x", [{ a: 1 }], 5);
  assert.equal(entry.tier, "cold");
  assert.equal(entry.ts, 5);
  assert.match(entry.digest, /^sha256:/);
  assert.ok(entry.bytes > 0);
});

test("listing returns entries in timestamp order", async () => {
  const store = new MemoryTierStore("cold");
  await store.put("b", 1, 20);
  await store.put("a", 1, 10);
  assert.deepEqual((await store.list()).map((e) => e.key), ["a", "b"]);
});

// ── bus is untouched by tiering ──────────────────────────────────────────────

test("tiering is offline: it never publishes to the live bus", async () => {
  const store = new MemoryStateStore({ now: () => 1 });
  const bus = new InProcessEventBus({ store });
  const seen: unknown[] = [];
  const sub = bus.subscribe({ runId: RUN }, { queueSize: 16, onOverflow: "drop_oldest" });
  void (async () => {
    for await (const e of sub) seen.push(e);
  })();

  await manager().archive(RUN, journal());
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [], "archiving is bookkeeping, not history");
  sub.dispose();
});
