/**
 * NOTHING READ THE JOURNAL BACK.
 *
 * Invariant 2 makes the journal the only authoritative durable state, and nothing checked that
 * the authoritative state was internally consistent. The nearest thing, `conformsToGraph`, is
 * set-membership plus a hash — which is why it printed `ok` straight through the human-gate
 * bypass: every id in the bypass WAS declared. Membership was never the question.
 *
 * HALF THIS FILE IS FALSE-POSITIVE REGRESSIONS, and that is the right proportion. The first
 * version of `auditRun` fired on three healthy shapes this repo already tests — a retry, a
 * rewind, and an SLA expiry with siblings. A guard that cries wolf on correct code gets switched
 * off, which costs more than it ever caught, so each of those now has a test that keeps it quiet.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AUDIT_RULES, auditRun, type AuditRule } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";

const SYSTEM = { kind: "system", component: "executor" } as const;
const HUMAN = { kind: "human", subject: "u:alice", via: "console" } as const;

let seq = 0;
function ev(type: string, payload: unknown, extra: Record<string, unknown> = {}): JournalEvent {
  seq += 1;
  return { runId: "run_1", seq, ts: 1_700_000_000_000, type, payload, actor: SYSTEM, classification: "internal", ...extra } as unknown as JournalEvent;
}
function fixture(build: () => JournalEvent[]): JournalEvent[] {
  seq = 0;
  return build();
}
const rulesHit = (evs: JournalEvent[], opts = {}): AuditRule[] =>
  [...new Set(auditRun(evs, opts).violations.map((v) => v.rule))].sort();

const DONE = (): JournalEvent => ev("run.completed", { outputs: {}, usage: {} });

// ── the report says what it actually looked at ───────────────────────────────

test("`checked` means the rule SAW EVIDENCE, not that the switch statement ran", () => {
  // The first version seeded `checked` with every rule and only ever removed from it, so a rule
  // whose events were absent reported as checked on every run — the exact defect the module's
  // own docstring names, shipped inside the module that names it.
  const evs = fixture(() => [
    ev("effect.started", { key: "n@root#0:tool:0", kind: "tool", attempt: 1 }),
    ev("effect.completed", { key: "n@root#0:tool:0", result: {}, resultDigest: "d" }),
    DONE(),
  ]);
  const r = auditRun(evs);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(
    [...r.checked].sort(),
    ["effect.completed-once-per-attempt", "effect.completion-has-a-start", "effect.kind-matches-its-key"],
    "only the three effect rules had anything to look at",
  );
  const why = new Map(r.skipped.map((s) => [s.rule, s.why]));
  assert.ok(why.has("policy.deescalation-is-human"), "a rule with no evidence is SKIPPED, not checked");
  assert.ok(why.has("gate.raised-is-resolved"));
  for (const [rule, w] of why) assert.ok(w.length > 20, `${rule} must say why`);
  for (const s of r.skipped) assert.ok(!r.checked.includes(s.rule), `${s.rule} cannot be both`);
  assert.equal(r.checked.length + r.skipped.length, AUDIT_RULES.length, "every rule is accounted for");
});

// ── the rules ────────────────────────────────────────────────────────────────

test("effect.kind-matches-its-key — the one that was wrong at two of four sites for years", () => {
  // The subgraph effect keyed `subgraph` and declared `mailbox`; the summariser keyed
  // `summarize` and declared `model`. Nothing compared the two, so an auditor filtering by
  // `kind` could not find a single summarisation.
  const bad = fixture(() => [ev("effect.started", { key: "n@root#0:summarize:2", kind: "model", attempt: 1 }), DONE()]);
  assert.deepEqual(rulesHit(bad), ["effect.kind-matches-its-key"]);

  const good = fixture(() => [ev("effect.started", { key: "n@root#0:summarize:2", kind: "summarize", attempt: 1 }), DONE()]);
  assert.deepEqual(rulesHit(good), []);
});

test("effect.completion-has-a-start", () => {
  const bad = fixture(() => [ev("effect.completed", { key: "n@root#0:tool:0", result: 1, resultDigest: "d" }), DONE()]);
  assert.deepEqual(rulesHit(bad), ["effect.completion-has-a-start"]);
});

test("effect.completed-once-per-attempt — twice in ONE attempt is the defect", () => {
  const bad = fixture(() => [
    ev("effect.started", { key: "n@root#0:tool:0", kind: "tool", attempt: 1 }),
    ev("effect.completed", { key: "n@root#0:tool:0", result: 1, resultDigest: "d" }),
    ev("effect.completed", { key: "n@root#0:tool:0", result: 2, resultDigest: "e" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(bad), ["effect.completed-once-per-attempt"]);
});

test("REGRESSION: a RETRY re-uses the key by design and must audit clean", () => {
  // `ids.ts`: "The key under which an effect's result is journaled. Stable across retries (the
  // attempt is deliberately NOT part of it) so a tool that supports server-side idempotency
  // dedupes for free." The first rule asserted the opposite of the documented contract, so every
  // run that survived one transient provider blip exited 1.
  const evs = fixture(() => [
    ev("effect.started", { key: "ask@root#0:model:0", kind: "model", attempt: 1 }),
    ev("effect.failed", { key: "ask@root#0:model:0", error: { code: "E_PROVIDER_UNAVAILABLE" } }),
    ev("task.leased", { attempt: 2 }, { taskId: "ask@root#0" }),
    ev("effect.started", { key: "ask@root#0:model:0", kind: "model", attempt: 2 }),
    ev("effect.completed", { key: "ask@root#0:model:0", result: {}, resultDigest: "d" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(evs), [], "a successful retry is not a double completion");
});

test("policy.deescalation-is-human — invariant 5, checked against the record", () => {
  const bad = fixture(() => [ev("policy.deescalated", { from: "in", to: "on", scope: "run:r", justification: "j" }), DONE()]);
  assert.deepEqual(rulesHit(bad), ["policy.deescalation-is-human"]);

  const good = fixture(() => [
    ev("policy.deescalated", { from: "in", to: "on", scope: "run:r", justification: "j" }, { actor: HUMAN }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(good), []);
});

test("edge.taken-belongs-to-its-node — the gate bypass, expressed as a relation", () => {
  const evs = fixture(() => [
    ev("task.committed", { status: "succeeded", writes: {}, take: ["e2"], usage: {}, attempt: 1 }, { taskId: "pick@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(evs, { edgeSource: { e2: "approve" } }), ["edge.taken-belongs-to-its-node"]);
  assert.deepEqual(rulesHit(evs, { edgeSource: { e2: "pick" } }), [], "its OWN edge is fine");

  // AN ABSENT GRAPH IS NOT AN EMPTY ONE. The CLI passed `{}`, so every lookup missed, nothing was
  // examined, and the report said the rule had been checked — on the one rule that catches the
  // bug this module exists for.
  const withoutGraph = auditRun(evs);
  assert.deepEqual(withoutGraph.violations, []);
  assert.ok(
    !withoutGraph.checked.includes("edge.taken-belongs-to-its-node"),
    "with no graph the rule must be SKIPPED, never reported as checked",
  );
  const empty = auditRun(evs, { edgeSource: {} });
  assert.ok(!empty.checked.includes("edge.taken-belongs-to-its-node"), "an empty map examines nothing either");
});

test("gate.raised-is-resolved fires when a run COMPLETES with a gate still open", () => {
  const evs = fixture(() => [ev("gate.raised", { gateId: "g1", nodeId: "n" }), DONE()]);
  assert.deepEqual(rulesHit(evs), ["gate.raised-is-resolved"]);
});

test("REGRESSION: an SLA expiry abandons its SIBLINGS on purpose", () => {
  // `HumanGateBroker.#expire` fails the run for the ONE gate that expired — its docstring says a
  // timeout without the `run.failed` "leaves a run suspended with no gate to answer". The other
  // gates of a fan-out are left open deliberately, and the first rule called all of them
  // violations.
  const evs = fixture(() => [
    ev("gate.raised", { gateId: "g1", nodeId: "n" }),
    ev("gate.raised", { gateId: "g2", nodeId: "n" }),
    ev("gate.raised", { gateId: "g3", nodeId: "n" }),
    ev("gate.timeout", { gateId: "g1", action: "fail" }),
    ev("run.failed", { error: { code: "E_GATE_EXPIRED" } }),
  ]);
  assert.deepEqual(rulesHit(evs), [], "a failed run may leave siblings open");

  const live = fixture(() => [ev("gate.raised", { gateId: "g1", nodeId: "n" })]);
  assert.deepEqual(rulesHit(live), [], "and a live run is not in violation for still working");
});

test("REGRESSION: a REWIND hides the history it undid", () => {
  // A rewind never edits history — it appends a marker, and the fold suppresses what it undid.
  // Reading raw events made "approve → rewind → re-approve", which this repo tests as legal,
  // look like a double completion.
  const evs = fixture(() => [
    ev("checkpoint.created", { checkpointId: "c1", atSeq: 1 }),
    ev("effect.started", { key: "w@root#0:tool:0", kind: "tool", attempt: 1 }),
    ev("effect.completed", { key: "w@root#0:tool:0", result: 1, resultDigest: "d" }),
    ev("checkpoint.restored", { checkpointId: "c1", atSeq: 1, mode: "rewind" }),
    ev("effect.started", { key: "w@root#0:tool:0", kind: "tool", attempt: 1 }),
    ev("effect.completed", { key: "w@root#0:tool:0", result: 2, resultDigest: "e" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(evs), [], "the undone completion is not counted");
});

test("A MALFORMED JOURNAL IS DIAGNOSED, NOT CRASHED ON", () => {
  // `projection.ts` states the policy for the same input class: "A projection that crashes on a
  // slightly unexpected log is a projection that cannot be used to diagnose the incident that
  // produced the log." Every payload read here used to be a bare cast.
  const evs = fixture(() => [
    ev("effect.started", null),
    ev("gate.batch_decided", { gateIds: 3 }),
    ev("policy.deescalated", { from: "in", to: "on" }, { actor: undefined }),
    ev("task.committed", { take: [7, null] }, { taskId: "n@root#0" }),
    DONE(),
  ]);
  const r = auditRun(evs, { edgeSource: { e1: "n" } });
  assert.ok(Array.isArray(r.violations), "it returns a report rather than throwing");
  assert.deepEqual(rulesHit(evs), ["policy.deescalation-is-human"], "a missing actor is not human");
});
