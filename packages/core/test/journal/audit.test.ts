/**
 * NOTHING READ THE JOURNAL BACK.
 *
 * Invariant 2 makes the journal the only authoritative durable state, and until now nothing
 * checked that the authoritative state was internally consistent. The nearest thing,
 * `conformsToGraph`, is set-membership plus a hash — which is why it printed `ok` straight
 * through the human-gate bypass: every id in the bypass WAS declared. Membership was never the
 * question. The question is whether the ids stand in the right relation.
 *
 * Each rule below gets a fixture that trips it and a fixture that does not. The second half is
 * the one that keeps the auditor usable: a guard that cries wolf on correct code is worse than
 * no guard, because it gets switched off.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AUDIT_RULES, auditRun, type AuditRule } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";

const SYSTEM = { kind: "system", id: "executor" } as const;
const HUMAN = { kind: "human", subject: "u:alice", via: "console" } as const;

let seq = 0;
function ev(type: string, payload: unknown, extra: Record<string, unknown> = {}): JournalEvent {
  seq += 1;
  return {
    runId: "run_1",
    seq,
    ts: 1_700_000_000_000,
    type,
    payload,
    actor: SYSTEM,
    classification: "internal",
    ...extra,
  } as unknown as JournalEvent;
}

/** Reset the counter so each fixture reads from seq 1. */
function fixture(build: () => JournalEvent[]): JournalEvent[] {
  seq = 0;
  return build();
}

const rulesHit = (evs: JournalEvent[], opts = {}): AuditRule[] =>
  [...new Set(auditRun(evs, opts).violations.map((v) => v.rule))].sort();

const DONE = (): JournalEvent => ev("run.completed", { status: "succeeded" });

test("a well-formed run trips nothing, and says which rules it RAN", () => {
  const evs = fixture(() => [
    ev("run.submitted", {}),
    ev("effect.started", { key: "n@root#0:tool:0", kind: "tool", attempt: 1 }),
    ev("effect.completed", { key: "n@root#0:tool:0", result: {}, resultDigest: "d" }),
    ev("budget.reserved", { scope: "run:run_1", amountUsd: 1, remainingUsd: 9, warn: false }),
    ev("budget.settled", { scope: "run:run_1", reservedUsd: 1, actualUsd: 0.5 }),
    ev("gate.raised", { gateId: "g1" }),
    ev("gate.decided", { gateId: "g1", decision: "approve" }, { actor: HUMAN }),
    DONE(),
  ]);
  const r = auditRun(evs);
  assert.deepEqual(r.violations, []);
  assert.equal(r.checked.length, AUDIT_RULES.length - 1, "every rule but the graph-dependent one ran");
  assert.deepEqual(r.skipped.map((s) => s.rule), ["edge.taken-belongs-to-its-node"]);
});

test("A RULE IT CANNOT RUN IS REPORTED, NOT OMITTED", () => {
  // The defect this repo keeps hitting: a checker that returns "no violations" because it never
  // looked is indistinguishable from one that looked and found nothing.
  const evs = fixture(() => [ev("run.submitted", {})]);
  const r = auditRun(evs);
  assert.ok(r.skipped.length >= 1, "an unrunnable rule must appear in `skipped`");
  for (const s of r.skipped) {
    assert.ok(!r.checked.includes(s.rule), `${s.rule} cannot be both checked and skipped`);
    assert.ok(s.why.length > 20, `${s.rule} must say WHY it could not run`);
  }
});

test("effect.kind-matches-its-key — the one that was wrong at two of four sites for years", () => {
  // The subgraph effect keyed `subgraph` and declared `mailbox`; the summariser keyed
  // `summarize` and declared `model`. Nothing compared the two, so an auditor filtering by
  // `kind` could not find a single summarisation.
  const bad = fixture(() => [ev("effect.started", { key: "n@root#0:summarize:2", kind: "model", attempt: 1 }), DONE()]);
  assert.deepEqual(rulesHit(bad), ["effect.kind-matches-its-key"]);

  const good = fixture(() => [ev("effect.started", { key: "n@root#0:summarize:2", kind: "summarize", attempt: 1 }), DONE()]);
  assert.deepEqual(rulesHit(good), []);
});

test("the kind is read from the RIGHT, so a branch coordinate is never mistaken for it", () => {
  // A TaskId may itself contain `:`. Splitting from the left finds a branch coordinate and
  // compares it against a kind, which fails on exactly the graphs that fan out.
  const evs = fixture(() => [ev("effect.started", { key: "n@a:b:c#0:tool:0", kind: "tool", attempt: 1 }), DONE()]);
  assert.deepEqual(rulesHit(evs), []);
});

test("effect.completion-has-a-start", () => {
  const bad = fixture(() => [ev("effect.completed", { key: "k:tool:0", result: 1, resultDigest: "d" }), DONE()]);
  assert.deepEqual(rulesHit(bad), ["effect.completion-has-a-start"]);
});

test("effect.completed-once — a key may not be completed twice", () => {
  const bad = fixture(() => [
    ev("effect.started", { key: "k:tool:0", kind: "tool", attempt: 1 }),
    ev("effect.completed", { key: "k:tool:0", result: 1, resultDigest: "d" }),
    ev("effect.completed", { key: "k:tool:0", result: 2, resultDigest: "e" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(bad), ["effect.completed-once"]);
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

test("task.no-commit-after-cancel", () => {
  const bad = fixture(() => [
    ev("task.cancelled", { clean: true, reason: "operator" }, { taskId: "n@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "n@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(bad), ["task.no-commit-after-cancel"]);

  // A DIFFERENT task committing after a sibling was cancelled is ordinary.
  const good = fixture(() => [
    ev("task.cancelled", { clean: true, reason: "operator" }, { taskId: "a@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "b@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(good), []);
});

test("edge.taken-belongs-to-its-node — the gate bypass, expressed as a relation", () => {
  // `#activate` looked an edge id up in the WHOLE graph's table, so a `take` naming another
  // node's edge jumped everything in between — and span conformance reported `ok`, because
  // every id involved was declared.
  const evs = fixture(() => [
    ev("task.committed", { status: "succeeded", writes: {}, take: ["e2"], usage: {}, attempt: 1 }, { taskId: "pick@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(evs, { edgeSource: { e2: "approve" } }), ["edge.taken-belongs-to-its-node"]);
  assert.deepEqual(rulesHit(evs, { edgeSource: { e2: "pick" } }), [], "its OWN edge is fine");
  assert.deepEqual(rulesHit(evs), [], "and with no graph supplied the rule does not guess");
});

test("`eventually` rules fire only on a TERMINAL run", () => {
  // An open gate and an unsettled reservation are CORRECT in a live run. Checking them
  // unconditionally is how a guard learns to cry wolf, and a guard that cries wolf gets
  // switched off — which costs more than it ever caught.
  const live = fixture(() => [
    ev("gate.raised", { gateId: "g1" }),
    ev("budget.reserved", { scope: "run:r", amountUsd: 1, remainingUsd: 9, warn: false }),
  ]);
  assert.deepEqual(rulesHit(live), [], "a live run is not in violation for still working");
  assert.deepEqual(
    auditRun(live).skipped.map((s) => s.rule).sort(),
    ["budget.reservation-is-settled", "edge.taken-belongs-to-its-node", "gate.raised-is-resolved"],
  );

  const ended = fixture(() => [
    ev("gate.raised", { gateId: "g1" }),
    ev("budget.reserved", { scope: "run:r", amountUsd: 1, remainingUsd: 9, warn: false }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(ended), ["budget.reservation-is-settled", "gate.raised-is-resolved"]);
});
