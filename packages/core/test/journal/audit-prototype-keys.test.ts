/**
 * A JOURNAL STRING IS NOT A SAFE OBJECT KEY, and `auditRun` read two of them as if it were.
 *
 * Both defects are the same shape and both are in the module whose whole job is to say whether
 * the authoritative state holds together, so both of them disable the report rather than the
 * rule: one by answering "clean" for an escalation that lowered a posture, the other by
 * throwing a raw TypeError that takes all 26 other rules' findings down with it.
 *
 * `vocab.ts` already writes the first of these correctly (`Object.hasOwn(POSTURE_RANK, v)`)
 * with a docstring about exactly this miss; audit.ts carried the copy that had not learnt it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { auditRun } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";

const SYSTEM = { kind: "system", component: "executor" } as const;

let seq = 0;
function ev(type: string, payload: unknown, extra: Record<string, unknown> = {}): JournalEvent {
  seq += 1;
  return { runId: "run_1", seq, ts: 1_700_000_000_000, type, payload, actor: SYSTEM, classification: "internal", ...extra } as unknown as JournalEvent;
}
function fixture(build: () => JournalEvent[]): JournalEvent[] {
  seq = 0;
  return [ev("run.submitted", { graphHash: "sha256:x", inputs: {} }), ...build()];
}
const DONE = (): JournalEvent => ev("run.completed", { status: "succeeded" });

// Every one of these is a member of Object.prototype, so a bare index finds a non-undefined
// value for it on an object literal that never declared it.
const INHERITED = ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"] as const;

test("policy.escalated naming an inherited key is a MALFORMED posture, not a clean escalation", () => {
  for (const from of INHERITED) {
    const evs = fixture(() => [ev("policy.escalated", { rule: "taint", from, to: "out", scope: "run:r" }), DONE()]);
    const rules = auditRun(evs).violations.map((v) => v.rule);
    assert.deepEqual(
      rules,
      ["policy.escalation-only-raises"],
      `from: ${JSON.stringify(from)} must trip the malformed-posture arm, not pass both arms`,
    );
  }
});

test("...and the chain check does not adopt the crafted posture as the scope's new value", () => {
  // The second escalation is a legitimate `out -> on`. If the first one had been allowed to set
  // the scope's recorded posture to "out", this one would validate against it and the crafted
  // event would have silently rewritten the ladder every later event is checked against.
  const evs = fixture(() => [
    ev("policy.escalated", { rule: "taint", from: "__proto__", to: "out", scope: "run:r" }),
    ev("policy.escalated", { rule: "violation", from: "out", to: "on", scope: "run:r" }),
    DONE(),
  ]);
  const details = auditRun(evs).violations.map((v) => v.detail);
  assert.equal(details.length, 1, `exactly the crafted event is reported: ${JSON.stringify(details)}`);
  assert.match(details[0]!, /not out\/on\/in/);
});

test("the ORDINARY escalation arms are unchanged", () => {
  const lowered = fixture(() => [ev("policy.escalated", { rule: "t", from: "in", to: "on", scope: "run:r" }), DONE()]);
  assert.deepEqual(auditRun(lowered).violations.map((v) => v.rule), ["policy.escalation-only-raises"]);
  const raised = fixture(() => [
    ev("policy.escalated", { rule: "v", from: "out", to: "on", scope: "run:r" }),
    ev("policy.escalated", { rule: "t", from: "on", to: "in", scope: "run:r" }),
    DONE(),
  ]);
  assert.deepEqual(auditRun(raised).violations, [], "out -> on -> in is a real ladder and stays silent");
});

test("hook.applied naming an inherited key returns a report instead of throwing", () => {
  for (const point of INHERITED) {
    const evs = fixture(() => [ev("hook.applied", { ref: "hook/ghost@stable", point, changed: true }), DONE()]);
    const r = auditRun(evs, { hookRefs: { preTool: ["hook/guard@stable"] } });
    assert.deepEqual(
      r.violations.map((v) => v.rule),
      ["hook.applied-ref-is-declared"],
      `point: ${JSON.stringify(point)} must be reported as undeclared, not throw`,
    );
  }
});

test("...and a hookRefs entry that is not an array is undeclared, not a crash", () => {
  // `spec.hooks` is JSON an operator wrote, so the value may not be an array even at a
  // legitimate point.
  const evs = fixture(() => [ev("hook.applied", { ref: "hook/ghost@stable", point: "preTool", changed: true }), DONE()]);
  const r = auditRun(evs, { hookRefs: { preTool: "hook/ghost@stable" } as unknown as Record<string, readonly string[]> });
  assert.deepEqual(r.violations.map((v) => v.rule), ["hook.applied-ref-is-declared"]);
});

test("the ORDINARY hook arms are unchanged", () => {
  const evs = fixture(() => [ev("hook.applied", { ref: "hook/ghost@stable", point: "preTool", changed: true }), DONE()]);
  assert.deepEqual(auditRun(evs, { hookRefs: { preTool: ["hook/ghost@stable"] } }).violations, [], "a declared hook is fine");
  assert.deepEqual(
    auditRun(evs, { hookRefs: { preTool: ["hook/guard@stable"] } }).violations.map((v) => v.rule),
    ["hook.applied-ref-is-declared"],
  );
});
