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
/**
 * Every fixture begins the way a real journal does: `run.submitted` at seq 1.
 *
 * They did not, and adding `run.submitted-is-first-and-once` made all of them red at once —
 * correctly. A synthetic journal that starts at seq 1 with no submission is not a shape the
 * engine can produce, so a fixture shaped like that was testing the auditor against a run that
 * cannot exist.
 */
function fixture(build: () => JournalEvent[]): JournalEvent[] {
  seq = 0;
  const submitted = ev("run.submitted", { graphHash: "sha256:x", inputs: {} });
  return [submitted, ...build()];
}
/**
 * EVERY RULE THIS FILE MANAGED TO TRIP, accumulated across the whole file.
 *
 * A rule with no fixture that trips it is indistinguishable from a rule that does nothing, and
 * this module has shipped two of those before — built on event types nothing in `src/` ever
 * appends, permanently inert, and reported as `checked` on every terminal run.
 * `audit-coverage.test.ts` gates the other direction (every event TYPE is constrained or
 * excused); nothing gated this one until the last test in this file.
 */
const TRIPPED = new Set<AuditRule>();

/** Every call in this file goes through here, so the accounting cannot miss one. */
function audit(evs: JournalEvent[], opts: Parameters<typeof auditRun>[1] = {}): ReturnType<typeof auditRun> {
  const r = auditRun(evs, opts);
  for (const v of r.violations) TRIPPED.add(v.rule);
  return r;
}

const rulesHit = (evs: JournalEvent[], opts = {}): AuditRule[] =>
  [...new Set(audit(evs, opts).violations.map((v) => v.rule))].sort();

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
  const r = audit(evs);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(
    [...r.checked].sort(),
    [
      "effect.completed-once-per-attempt",
      "effect.completion-has-a-start",
      "effect.kind-matches-its-key",
      "run.submitted-is-first-and-once",
      "run.terminal-is-last-and-once",
    ],
    // The terminal rule joined the submission rule for the same reason: `DONE()` is a
    // `run.completed`, which IS the evidence. A journal with no end gives it none, and it is
    // reported skipped there — asserted three tests down.
    "the three effect rules, plus the two lifecycle rules every terminal journal gives evidence for",
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
    // A real retry COMMITS on the attempt that succeeds. Leaving this out made the fixture a run
    // the engine cannot produce — and `task.leased-is-resolved` caught it, correctly.
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 2 }, { taskId: "ask@root#0" }),
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
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "pick@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: ["e2"], usage: {}, attempt: 1 }, { taskId: "pick@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(evs, { edgeSource: { e2: "approve" } }), ["edge.taken-belongs-to-its-node"]);
  assert.deepEqual(rulesHit(evs, { edgeSource: { e2: "pick" } }), [], "its OWN edge is fine");

  // AN ABSENT GRAPH IS NOT AN EMPTY ONE. The CLI passed `{}`, so every lookup missed, nothing was
  // examined, and the report said the rule had been checked — on the one rule that catches the
  // bug this module exists for.
  const withoutGraph = audit(evs);
  assert.deepEqual(withoutGraph.violations, []);
  assert.ok(
    !withoutGraph.checked.includes("edge.taken-belongs-to-its-node"),
    "with no graph the rule must be SKIPPED, never reported as checked",
  );
  const empty = audit(evs, { edgeSource: {} });
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
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "n@root#0" }),
    ev("task.committed", { take: [7, null] }, { taskId: "n@root#0" }),
    DONE(),
  ]);
  const r = audit(evs, { edgeSource: { e1: "n" } });
  assert.ok(Array.isArray(r.violations), "it returns a report rather than throwing");
  assert.deepEqual(rulesHit(evs), ["policy.deescalation-is-human"], "a missing actor is not human");
});

test("gate.decision-has-a-raise — a forged approval passes every other rule clean", () => {
  // The mirror of `effect.completion-has-a-start`, and the direction that matters for security.
  // `gates.ts` spends hundreds of lines making a decision-without-a-raise impossible at the door;
  // nothing read the record back to confirm the door held.
  const forged = fixture(() => [ev("gate.decided", { gateId: "g9", decision: "approve" }, { actor: HUMAN }), DONE()]);
  assert.deepEqual(rulesHit(forged), ["gate.decision-has-a-raise"]);

  const real = fixture(() => [
    ev("gate.raised", { gateId: "g9", nodeId: "n" }),
    ev("gate.decided", { gateId: "g9", decision: "approve" }, { actor: HUMAN }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(real), []);
});

test("task.committed-once — the double-commit the seq-CAS exists to prevent", () => {
  const twice = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(twice), ["task.committed-once"]);

  // A loop iteration and a fan-out branch each mint a DIFFERENT TaskId, so these are not doubles.
  const legal = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root#1" }),
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root/e0[1]#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#1" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root/e0[1]#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(legal), [], "different taskIds are different tasks");
});

test("task.leased-precedes-commit — a commit with no lease held no fencing token", () => {
  // The lease's own seq IS the token: the journal's seq is the only monotonic source every
  // process shares, so a task that commits without one committed under no token at all — the
  // concurrent double-execution the compare-and-set exists to prevent.
  const unfenced = fixture(() => [
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(unfenced), ["task.leased-precedes-commit"]);

  const fenced = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(fenced), []);
});

test("run.submitted-is-first-and-once", () => {
  // `fixture` prepends the submission, so these build the raw array to say otherwise.
  seq = 0;
  const noSubmission = [ev("task.ready", { nodeId: "w" }, { taskId: "w@root#0" }), DONE()];
  assert.deepEqual(rulesHit(noSubmission), ["run.submitted-is-first-and-once"]);

  seq = 0;
  const late = [ev("task.ready", { nodeId: "w" }, { taskId: "w@root#0" }), ev("run.submitted", {}), DONE()];
  assert.deepEqual(rulesHit(late), ["run.submitted-is-first-and-once"], "a submission that is not first is two writers");

  const twice = fixture(() => [ev("run.submitted", {}), DONE()]);
  assert.deepEqual(rulesHit(twice), ["run.submitted-is-first-and-once"], "and one run may not be submitted twice");
});

test("A PARTIAL JOURNAL IS NOT A MALFORMED ONE — the submission rule stands down", () => {
  // `auditRun` takes any array. A caller reading from seq 5 has a journal with no submission in
  // it, which is not a defect in the RUN — and a rule that cannot tell those apart is a rule
  // that fires on healthy tails.
  seq = 4;
  const tail = [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    DONE(),
  ];
  const r = audit(tail);
  assert.deepEqual(r.violations, []);
  assert.ok(
    r.skipped.some((s) => s.rule === "run.submitted-is-first-and-once" && s.why.includes("seq 1")),
    "and it says WHY it stood down",
  );
});

// ── the three at-most-once rules only a SECOND WRITER breaks ─────────────────
//
// Every fixture below is a journal `src/` cannot write today and could write yesterday. They
// were driven, not imagined: two `openWorkspace` planes over one SQLite file, both armed,
// `Promise.allSettled` over a reject from one and an approve from the other, produced
// `gate.decided 2 | run.resumed 2 | task.leased 3 | task.committed 2 | run.failed 2` — and
// `loom audit` on that journal reported `ok — 11 rule(s) checked, 10 skipped`, exit 0. It
// caught `task.committed-once` and nothing else.

test("gate.decided-once — one gate, two contradictory answers, both durable", () => {
  // The shape the write door used to allow: `resolve` checked the gate at `p.seq` and wrote
  // through the RETRYING `log.append`, so two people answering the same open gate in the same
  // instant both landed. The fold shows the first and the record holds both, which is why the
  // AUDITOR is the thing that has to say so.
  const twice = fixture(() => [
    ev("policy.decided", { decision: "allow", posture: "on", reasons: [] }, { taskId: "approve@root#0" }),
    ev("gate.raised", { gateId: "g1", nodeId: "approve", policyRef: "p", contentDigest: "d" }, { taskId: "approve@root#0" }),
    ev("gate.decided", { gateId: "g1", decision: "reject", latencyMs: 1 }, { actor: HUMAN, taskId: "approve@root#0" }),
    ev("gate.decided", { gateId: "g1", decision: "approve", latencyMs: 1 }, { actor: HUMAN, taskId: "approve@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(twice), ["gate.decided-once"]);

  // A TIMEOUT AFTER A DECISION IS THE SAME DEFECT ONE DOOR OVER: a sweeper that expires a gate
  // somebody already answered. `gate.raised-is-resolved` cannot see it — the gate IS resolved.
  const decidedThenExpired = fixture(() => [
    ev("policy.decided", { decision: "allow", posture: "on", reasons: [] }, { taskId: "approve@root#0" }),
    ev("gate.raised", { gateId: "g1", nodeId: "approve", policyRef: "p", contentDigest: "d" }, { taskId: "approve@root#0" }),
    ev("gate.decided", { gateId: "g1", decision: "approve", latencyMs: 1 }, { actor: HUMAN, taskId: "approve@root#0" }),
    ev("gate.timeout", { gateId: "g1", action: "fail" }, { taskId: "approve@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(decidedThenExpired), ["gate.decided-once"]);

  // THE LEGITIMATE NEIGHBOUR IT MUST NOT FIRE ON, and it is the reason `gate.deduped` is
  // excluded from the set by name. `HumanGateBroker.raise` writes raise → deduped → decided as
  // ONE append for a NEW gate whose answer was inherited from another; the `gate.deduped` names
  // the source and closes nothing. A rule that counted it would fire on a saturation-control
  // path the product takes on purpose.
  const deduped = fixture(() => [
    ev("policy.decided", { decision: "allow", posture: "on", reasons: [] }, { taskId: "approve@root#0" }),
    ev("gate.raised", { gateId: "g2", nodeId: "approve", policyRef: "p", contentDigest: "d" }, { taskId: "approve@root#0" }),
    ev("gate.deduped", { gateId: "g2", ofGateId: "g1", contentDigest: "d", decision: "approve" }, { taskId: "approve@root#0" }),
    ev("gate.decided", { gateId: "g2", decision: "approve", latencyMs: 0 }, { actor: HUMAN, taskId: "approve@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(deduped), [], "a deduped gate is raised, annotated and decided ONCE");

  // …and the ordinary batch, IN THE SHAPE `decideBatch` ACTUALLY WRITES IT. This fixture used
  // to hold a bare `gate.batch_decided` with no per-member rows, which is a journal `src/`
  // never produces — so it reported the batch neighbour safe while the real path violated five
  // times over. `HumanGateBroker.decideBatch` writes one `gate.decided` PER MEMBER and THEN
  // one `gate.batch_decided` naming every member in `gateIds`: the roll-up is a summary of
  // closures that already happened, never a closure of its own. The live counterpart of this
  // fixture drives the real engine — see gate-saturation.test.ts, "A HEALTHY BATCH APPROVAL
  // PASSES auditRun".
  const twoGates = fixture(() => [
    ev("policy.decided", { decision: "allow", posture: "on", reasons: [] }, { taskId: "a@root#0" }),
    ev("gate.raised", { gateId: "g1", nodeId: "a", policyRef: "p", contentDigest: "d" }, { taskId: "a@root#0" }),
    ev("policy.decided", { decision: "allow", posture: "on", reasons: [] }, { taskId: "b@root#0" }),
    ev("gate.raised", { gateId: "g2", nodeId: "b", policyRef: "p", contentDigest: "d" }, { taskId: "b@root#0" }),
    ev("gate.decided", { gateId: "g1", decision: "approve", latencyMs: 1 }, { actor: HUMAN, taskId: "a@root#0" }),
    ev("gate.decided", { gateId: "g2", decision: "approve", latencyMs: 1 }, { actor: HUMAN, taskId: "b@root#0" }),
    ev("gate.batch_decided", { batchId: "b1", gateIds: ["g1", "g2"], decision: "approve", latencyMs: 1 }, { actor: HUMAN }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(twoGates), [], "the roll-up beside its members closes each gate exactly once");
});

test("run.terminal-is-last-and-once — a run that ended twice, and a run that kept going after it ended", () => {
  // THE MIRROR OF `run.submitted-is-first-and-once`, which guarded the START while the END was
  // guarded by nothing. `audit-coverage.test.ts` excused `run.failed` as "a terminal marker; the
  // auditor reads its ABSENCE… to decide whether `eventually` rules apply" — a claim falsified by
  // producing a journal with two of them.
  const endedTwice = fixture(() => [
    ev("run.failed", { error: { code: "E_X", message: "x" } }),
    ev("run.failed", { error: { code: "E_X", message: "x" } }),
  ]);
  assert.deepEqual(rulesHit(endedTwice), ["run.terminal-is-last-and-once"]);

  // TWO DIFFERENT terminals is the same defect and the worse-looking one: a run both cancelled
  // and completed says two incompatible things about whether the work happened.
  const cancelledThenCompleted = fixture(() => [ev("run.cancelled", { reason: "stop" }), ev("run.completed", { outputs: {}, usage: {} })]);
  assert.deepEqual(rulesHit(cancelledThenCompleted), ["run.terminal-is-last-and-once"]);

  // THE HALF THE SECOND PLANE ACTUALLY PRODUCED: the run failed while the first plane's tool was
  // still running, and the tool's own rows landed AFTER the terminal event.
  const workAfterTheEnd = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "apply@root#0" }),
    ev("run.failed", { error: { code: "E_OUTPUT_MISSING", message: "x" } }),
    ev("run.resumed", { by: "gate" }, { actor: HUMAN }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "apply@root#0" }),
  ]);
  const after = audit(workAfterTheEnd).violations.filter((v) => v.rule === "run.terminal-is-last-and-once");
  assert.deepEqual(rulesHit(workAfterTheEnd), ["run.terminal-is-last-and-once"]);
  assert.equal(after.length, 2, "BOTH later events are named, not just the first — an operator needs the extent");

  // WHAT IT DELIBERATELY DOES NOT CLAIM, and the two neighbours that would have made it fire on
  // healthy runs. `evolution.scored` is appended after `run.completed` on purpose —
  // `test/cli/evolution-score.test.ts` asserts `loom audit` exits 0 over exactly that journal —
  // and an inbound callback rejected after a run ends is a refusal that changed nothing.
  const scoredAfterwards = fixture(() => [
    DONE(),
    ev("evolution.scored", { suite: "s", outcome: 1, components: { completed: true }, weightsDigest: "d" }),
    ev("gate.callback_rejected", { channel: "slack", reason: "run_not_found" }),
  ]);
  assert.deepEqual(rulesHit(scoredAfterwards), [], "an event outside the named ADVANCES_A_RUN set is not this rule's business");
});

test("task.leased-once — two fencing tokens for one attempt", () => {
  // The missing mirror of `effect.completed-once-per-attempt`. `#runWaveInner` journals
  // `attempt: w.task.attempt + 1` read from the fold, so ONE writer's re-lease always carries a
  // HIGHER attempt. Two writers both fold attempt 1 and both journal 2 — measured, with two
  // planes over one journal, as `13:task.leased {"attempt":2}` and `14:task.leased {"attempt":2}`.
  const twoTokens = fixture(() => [
    ev("task.leased", { workerId: "a", attempt: 2 }, { taskId: "apply@root#0" }),
    ev("task.leased", { workerId: "b", attempt: 2 }, { taskId: "apply@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 2 }, { taskId: "apply@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(twoTokens), ["task.leased-once"]);

  // THE LEGITIMATE NEIGHBOUR: a retry. The attempt increments, and this is the shape half this
  // file exists to keep quiet about — a rule that fires on a retry gets switched off.
  const retried = fixture(() => [
    ev("task.leased", { workerId: "a", attempt: 1 }, { taskId: "apply@root#0" }),
    ev("task.failed", { error: { code: "E_X", message: "x" }, attempt: 1 }, { taskId: "apply@root#0" }),
    ev("task.retry_scheduled", { attempt: 1, delayMs: 10 }, { taskId: "apply@root#0" }),
    ev("task.leased", { workerId: "a", attempt: 2 }, { taskId: "apply@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 2 }, { taskId: "apply@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(retried), [], "a retry re-leases at a HIGHER attempt, by construction");

  // …and two different TASKS at the same attempt number are unrelated, which is the ordinary
  // parallel wave.
  const wave = fixture(() => [
    ev("task.leased", { workerId: "a", attempt: 1 }, { taskId: "left@root#0" }),
    ev("task.leased", { workerId: "a", attempt: 1 }, { taskId: "right@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "left@root#0" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: {}, attempt: 1 }, { taskId: "right@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(wave), [], "one attempt each, on two tasks");
});

test("call-pairs-with-its-effect — a call the journal describes and replay cannot reproduce", () => {
  // `model.called`/`tool.called` are the human-legible record of an outbound call; `effect.started`
  // is the replayable one. They are appended together at four sites, and nothing checked they
  // stayed together — a `*.called` with no effect is the ledger and the mechanism disagreeing.
  const orphan = fixture(() => [
    ev("model.called", { key: "ask@root#0:model:0", provider: "anthropic", model: "m", finishReason: "stop", usage: {} }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(orphan), ["call-pairs-with-its-effect"]);

  const paired = fixture(() => [
    ev("effect.started", { key: "ask@root#0:model:0", kind: "model", attempt: 1 }),
    ev("model.called", { key: "ask@root#0:model:0", provider: "anthropic", model: "m", finishReason: "stop", usage: {} }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(paired), []);
});

test("...and the KIND must match the call, not merely exist", () => {
  // A `tool.called` sitting on a `model` effect would mean the two records describe different
  // things under one key — the shape `effect.kind-matches-its-key` catches from the other side.
  const crossed = fixture(() => [
    ev("effect.started", { key: "n@root#0:tool:0", kind: "model", attempt: 1 }),
    ev("tool.called", { key: "n@root#0:tool:0", name: "fs.write" }),
    DONE(),
  ]);
  assert.deepEqual(
    rulesHit(crossed).sort(),
    ["call-pairs-with-its-effect", "effect.kind-matches-its-key"],
    "both sides of the same disagreement fire, which is correct",
  );
});

test("compensation.names-a-recorded-call — a rollback claim about a call the journal does not carry", () => {
  // `compensation.recorded` is where a run says "this effect is undone", and its identity is the
  // SEQ of the `tool.called` it undoes rather than that call's effect key — the key is positional
  // and a rewind-then-redo reuses it. That makes the seq load-bearing: `run/compensation.ts`
  // folds these into `settled` and skips those calls on the next pass, so a record naming the
  // wrong seq silently exempts a call nobody undid. A rollback that looks done.
  const invented = fixture(() => [
    ev("compensation.recorded", {
      compensates: "n@root#0:tool:0",
      compensatesSeq: 99,
      tool: "db.insert",
      undo: "db.delete",
      outcome: "compensated",
      trigger: "run_failed",
    }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(invented), ["compensation.names-a-recorded-call"]);

  // The control: the same claim, about a `tool.called` that is actually there. `fixture` assigns
  // seq in order — `run.submitted` is seq 1 — so the `tool.called` below is seq 3 and the record names it.
  const real = fixture(() => [
    ev("effect.started", { key: "n@root#0:tool:0", kind: "tool", attempt: 1 }),
    ev("tool.called", { key: "n@root#0:tool:0", name: "db.insert" }),
    ev("effect.started", { key: "n@root#0:compensate:3", kind: "compensate", attempt: 1 }),
    // The undo is an ordinary tool dispatch and journals an ordinary `tool.called`. It keys into
    // the `compensate` namespace because its ordinal is the seq it undoes; `call-pairs-with-its-effect`
    // accepts that kind for a `tool.called` and would fire here if it did not.
    ev("tool.called", { key: "n@root#0:compensate:3", name: "db.delete" }),
    ev("compensation.recorded", {
      compensates: "n@root#0:tool:0",
      compensatesSeq: 3,
      tool: "db.insert",
      undo: "db.delete",
      outcome: "compensated",
      trigger: "run_failed",
    }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(real), [], "a real rollback of a real call trips nothing");
});

test("gate.raise-has-a-decision — a gate manufactured outside the guard chain", () => {
  // A gate is the OUTPUT of the guard chain; `policy.decided` is the input that produced it —
  // the reasons, the posture, the class. A gate raised for a task that never had a decision came
  // from somewhere other than the chain, which is the thing invariant 6's single dispatch path
  // is supposed to make impossible.
  const orphan = fixture(() => [
    ev("gate.raised", { gateId: "g1", nodeId: "n" }, { taskId: "n@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(orphan).sort(), ["gate.raise-has-a-decision", "gate.raised-is-resolved"]);

  const proper = fixture(() => [
    ev("policy.decided", { effect: "gate", posture: "in", irreversibility: "irreversible", reasons: [] }, { taskId: "n@root#0" }),
    ev("gate.raised", { gateId: "g1", nodeId: "n" }, { taskId: "n@root#0" }),
    ev("gate.decided", { gateId: "g1", decision: "approve" }, { actor: HUMAN }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(proper), []);
});

test("...and a MIRROR gate is keyed on the TASK, not on the decision being a gate", () => {
  // A subgraph delegation raises a mirror gate in the PARENT for a task whose own decision was
  // `allow` — the child is what gated. Keying this rule on `effect === "gate"` would fire on
  // every delegation that gates, which is a shape this repo tests and ships. Measured against a
  // real parent journal: policy.decided(allow) → subgraph.started → gate.raised, 0 violations.
  const mirror = fixture(() => [
    ev("policy.decided", { effect: "allow", posture: "out", irreversibility: "read_only", reasons: [] }, { taskId: "d@root#0" }),
    ev("subgraph.started", { childRunId: "run_1~d@root#0", ref: "graph/c@stable", graphHash: "h", budgetUsd: null }, { taskId: "d@root#0" }),
    ev("gate.raised", { gateId: "g1", nodeId: "d", mirrorOf: "gate_child" }, { taskId: "d@root#0" }),
    ev("gate.decided", { gateId: "g1", decision: "approve" }, { actor: HUMAN }),
    ev("subgraph.completed", { childRunId: "run_1~d@root#0", ref: "graph/c@stable", status: "succeeded", usage: {}, outputs: [] }, { taskId: "d@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(mirror), []);
});

test("state.chain-is-unbroken — every reduction starts where the last one finished", () => {
  // `state.reduced` carries the channel-state hash either side of it. A break means a write went
  // missing between them, a second writer interleaved, or a reduction was computed against a
  // projection that had already moved.
  const broken = fixture(() => [
    ev("state.reduced", { channels: ["a"], values: {}, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: "h0", stateHashAfter: "h1" }),
    ev("state.reduced", { channels: ["b"], values: {}, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: "hX", stateHashAfter: "h2" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(broken), ["state.chain-is-unbroken"]);

  const chained = fixture(() => [
    ev("state.reduced", { channels: ["a"], values: {}, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: "h0", stateHashAfter: "h1" }),
    ev("state.reduced", { channels: ["b"], values: {}, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: "h1", stateHashAfter: "h2" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(chained), []);
});

test("state.root-writes-are-reduced — and a FAN-OUT branch is allowed to hold its writes", () => {
  // A root-branch task reduces immediately; one inside a fan-out holds until its join. A rule
  // that could not tell them apart would fire on every parallel branch this engine runs.
  const lost = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.committed", { status: "succeeded", writes: { out: 1 }, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(lost), ["state.root-writes-are-reduced"]);

  const held = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root/e0[0]#0" }),
    ev("task.committed", { status: "succeeded", writes: { out: 1 }, take: [], usage: {}, attempt: 1 }, { taskId: "w@root/e0[0]#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(held), [], "a branch holds its writes for the join — that is not a loss");

  const reduced = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "w@root#0" }),
    ev("task.committed", { status: "succeeded", writes: { out: 1 }, take: [], usage: {}, attempt: 1 }, { taskId: "w@root#0" }),
    ev("state.reduced", { channels: ["out"], values: { out: 1 }, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: "h0", stateHashAfter: "h1" }, { taskId: "w@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(reduced), []);
});

test("subgraph.start-and-completion-pair — both directions", () => {
  const orphanEnd = fixture(() => [
    ev("subgraph.completed", { childRunId: "run_1~d@root#0", ref: "graph/c@stable", status: "succeeded", usage: {}, outputs: [] }, { taskId: "d@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(orphanEnd), ["subgraph.start-and-completion-pair"], "a child nobody recorded starting");

  const neverEnded = fixture(() => [
    ev("subgraph.started", { childRunId: "run_1~d@root#0", ref: "graph/c@stable", graphHash: "h", budgetUsd: null }, { taskId: "d@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(neverEnded), ["subgraph.start-and-completion-pair"], "the parent completed without recording its end");

  const paired = fixture(() => [
    ev("subgraph.started", { childRunId: "run_1~d@root#0", ref: "graph/c@stable", graphHash: "h", budgetUsd: null }, { taskId: "d@root#0" }),
    ev("subgraph.completed", { childRunId: "run_1~d@root#0", ref: "graph/c@stable", status: "succeeded", usage: {}, outputs: [] }, { taskId: "d@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(paired), []);
});

test("A LIVE PARENT MAY HAVE A CHILD STILL RUNNING", () => {
  // The "eventually" half is gated on the parent having COMPLETED, like the gate rule. A
  // suspended parent with a child mid-flight is the normal shape of a delegation.
  seq = 0;
  const live = [
    ev("run.submitted", {}),
    ev("subgraph.started", { childRunId: "run_1~d@root#0", ref: "graph/c@stable", graphHash: "h", budgetUsd: null }, { taskId: "d@root#0" }),
    ev("run.suspended", {}),
  ];
  assert.deepEqual(rulesHit(live), [], "a delegation in flight is not a lost child");
});

test("subgraph.child-id-is-derived — invariant 3, read back out of the journal", () => {
  // `#runSubgraph` derives the child's id as `${runId}~${taskId}` so replay and a restart find
  // the SAME child. A random one would break both silently.
  const random = fixture(() => [
    ev("subgraph.started", { childRunId: "run_9f3a1c", ref: "graph/c@stable", graphHash: "h", budgetUsd: null }, { taskId: "d@root#0" }),
    ev("subgraph.completed", { childRunId: "run_9f3a1c", ref: "graph/c@stable", status: "succeeded", usage: {}, outputs: [] }, { taskId: "d@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(random), ["subgraph.child-id-is-derived"]);
});

test("policy.escalation-only-raises — a posture lowered through the tightening door", () => {
  // `PolicyEngine.escalate` computes `max(from, to)` and returns WITHOUT firing when that equals
  // `from`, so a journalled escalation strictly raises by construction.
  const lowered = fixture(() => [
    ev("policy.escalated", { rule: "taint", from: "in", to: "on", scope: "run:r" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(lowered), ["policy.escalation-only-raises"]);

  const flat = fixture(() => [ev("policy.escalated", { rule: "taint", from: "on", to: "on", scope: "run:r" }), DONE()]);
  assert.deepEqual(rulesHit(flat), ["policy.escalation-only-raises"], "an escalation that changes nothing is never fired");

  const raised = fixture(() => [
    ev("policy.escalated", { rule: "violation", from: "out", to: "on", scope: "run:r" }),
    ev("policy.escalated", { rule: "taint", from: "on", to: "in", scope: "run:r" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(raised), [], "and a real ladder chains out -> on -> in");
});

test("...and escalations CHAIN per scope — a gap means a second writer", () => {
  const gap = fixture(() => [
    ev("policy.escalated", { rule: "violation", from: "out", to: "on", scope: "run:r" }),
    ev("policy.escalated", { rule: "taint", from: "out", to: "in", scope: "run:r" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(gap), ["policy.escalation-only-raises"]);

  // A DIFFERENT scope keeps its own ladder — node scopes and the run scope do not interleave.
  const scoped = fixture(() => [
    ev("policy.escalated", { rule: "violation", from: "out", to: "on", scope: "run:r" }),
    ev("policy.escalated", { rule: "taint", from: "out", to: "in", scope: "node:r/pay" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(scoped), []);
});

test("hook.applied-ref-is-declared — an extension that was not installed changed something", () => {
  const evs = fixture(() => [
    ev("hook.applied", { ref: "hook/ghost@stable", point: "preTool", changed: true }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(evs, { hookRefs: { preTool: ["hook/guard@stable"] } }), ["hook.applied-ref-is-declared"]);
  assert.deepEqual(rulesHit(evs, { hookRefs: { preTool: ["hook/ghost@stable"] } }), [], "a declared hook is fine");
  assert.deepEqual(
    rulesHit(evs, { hookRefs: { postTool: ["hook/ghost@stable"] } }),
    ["hook.applied-ref-is-declared"],
    "declared at a DIFFERENT point does not license it here",
  );

  // With no graph the rule is skipped, never guessed at — the same discipline as edgeSource.
  const r = audit(evs);
  assert.deepEqual(r.violations, []);
  assert.ok(!r.checked.includes("hook.applied-ref-is-declared"));
});

test("task.leased-is-resolved — work the run reported as done and never did", () => {
  // Reproduced from a real defect: a rewind whose checkpoint sat between a task's lease and its
  // commit suppressed the commit and left the lease, so `#advanceSerially` — which leases only
  // `ready` tasks — never re-ran it, and the run re-completed with its output channel back at
  // the INPUT value.
  const stranded = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "one@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(stranded), ["task.leased-is-resolved"]);

  const failedInstead = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "one@root#0" }),
    ev("task.failed", { error: { code: "E_TOOL_SOURCE_UNAVAILABLE" }, attempt: 1 }, { taskId: "one@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(failedInstead), [], "a task that FAILED resolved its lease");

  // A run that did not COMPLETE may legitimately abandon an in-flight lease.
  seq = 0;
  const cancelled = [
    ev("run.submitted", {}),
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "one@root#0" }),
    ev("run.cancelled", { reason: "operator" }),
  ];
  assert.deepEqual(rulesHit(cancelled), [], "a cancelled run is not in violation for stopping");
});

test("task.cancelled-not-after-commit — a cancel stops work, it does not un-land work", () => {
  // `Engine.#cancelTree` appends `task.cancelled` for every NON-TERMINAL Task, which is what
  // stopped a cancelled run leaving a Task reading as still `leased` (REGISTER E6). The rule is
  // the other side of that filter: a Task that already committed is finished, and re-ending it
  // would erase work that really happened — a worse lie in the read model than the stranded
  // lease the event was added to fix.
  //
  // The rule exists because the EVENT is new. `task.cancelled` sat in `NEVER_APPENDED` until the
  // E6 fix, so there was nothing to constrain; the moment it gained an appender the coverage
  // guard asked for a rule and the `todo` ratchet refused to let it be deferred. Both guards
  // were right, and neither needed a human to notice.
  const undone = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "one@root#0" }),
    ev("task.committed", { take: [], status: "succeeded" }, { taskId: "one@root#0" }),
    ev("task.cancelled", { clean: true, reason: "operator" }, { taskId: "one@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(undone), ["task.cancelled-not-after-commit"]);

  // THE HEALTHY SHAPE, which is what `#cancelTree` actually produces: the Task was leased and
  // never committed, so cancelling it un-lands nothing.
  const stopped = fixture(() => [
    ev("task.leased", { workerId: "w", attempt: 1 }, { taskId: "one@root#0" }),
    ev("task.cancelled", { clean: true, reason: "operator" }, { taskId: "one@root#0" }),
    DONE(),
  ]);
  assert.deepEqual(rulesHit(stopped), [], "cancelling work that never landed is the whole point of the event");
});

test("evolution.score-completed-matches-the-run — both directions", () => {
  // A score is a pure function of a fold of this journal, so a journalled score that disagrees
  // with the journal is a forgery. The full recomputation rule cannot live in `journal/` — it
  // would have to import `evolution/`, and the kernel's vocabulary must not depend on an
  // extension. What IS checkable here with no dependency is the half that decides WHICH of two
  // very different zeroes a `score: 0` is: "the run was bad" or "the run never got anywhere".
  const scored = (completed: boolean): JournalEvent =>
    ev("evolution.scored", {
      cohortKey: "w|sha256:g|t|b",
      score: 0,
      outcome: 0,
      components: { costNormalized: 0, latencyNormalized: 0, humanEffortSaved: 1, completed, delivered: false },
      weightsDigest: "sha256:w",
      ceiling: "draft",
    });

  // Claims it completed; the journal never says so.
  const liesUp = fixture(() => [
    ev("run.failed", { error: { class: "internal", code: "E_INTERNAL", message: "x", retryable: false } }),
    scored(true),
  ]);
  assert.deepEqual(
    rulesHit(liesUp),
    ["evolution.score-completed-matches-the-run"],
    "a failed run scored as completed — the flattering zero",
  );

  // Claims it did not complete; the journal says it did. Caught too, because a score that
  // under-states is still a score that disagrees with the record.
  const liesDown = fixture(() => [DONE(), scored(false)]);
  assert.deepEqual(
    rulesHit(liesDown),
    ["evolution.score-completed-matches-the-run"],
    "a completed run scored as incomplete",
  );

  // The control: agreement in both directions trips nothing.
  assert.deepEqual(rulesHit(fixture(() => [DONE(), scored(true)])), [], "completed and says so");
  assert.deepEqual(
    rulesHit(fixture(() => [
      ev("run.failed", { error: { class: "internal", code: "E_INTERNAL", message: "x", retryable: false } }),
      scored(false),
    ])),
    [],
    "did not complete and says so",
  );
});

// ── and the gate that keeps the rule set honest ─────────────────────────────

test("EVERY AUDIT RULE HAS A FIXTURE THAT TRIPS IT", () => {
  // `audit-coverage.test.ts` gates one direction: every event TYPE is constrained by a rule or
  // excused in writing. This is the other, and neither implies the other — a rule can exist,
  // branch on a type that IS appended, and still have no journal shape in this file that makes
  // it fire. Such a rule is indistinguishable from one that does nothing, and this module has
  // shipped two: built on event types nothing in `src/` ever appends, permanently inert, and
  // reported as `checked` on every terminal run.
  //
  // Declared LAST on purpose. `node:test` runs a file's tests in declaration order, so `TRIPPED`
  // holds what every test above managed to provoke. Running this file with
  // `--test-name-pattern` will therefore fail it, which is the honest failure: the accounting
  // is over the whole file or it is over nothing.
  const never = [...AUDIT_RULES].filter((r) => !TRIPPED.has(r)).sort();
  assert.deepEqual(
    never,
    [],
    "these rules were never made to fire by any fixture here — write one that trips each, or " +
      "delete the rule; a rule no test can distinguish from a no-op is not a guard",
  );
  // And the accounting itself must not silently break: if `audit()` stopped recording, `never`
  // would be the whole list and the message above would be the only clue.
  assert.equal(TRIPPED.size, AUDIT_RULES.length, "the recorder saw a different number of rules than exist");
});

test("A SKIPPED RULE'S REASON MUST BE TRUE — three rules share one precondition, one had its reason", () => {
  // `if (completed)` makes `gate.raised-is-resolved`, `task.leased-is-resolved` and
  // `subgraph.start-and-completion-pair` all inapplicable to a run that failed. Only the gate one
  // said so; the other two fell through to "no event this rule constrains appears in this
  // journal" — a checkable claim, and false about a journal that contains `task.leased`.
  //
  // Measured through `bin/loom audit` on a real run whose seq 5 was `task.leased`. An operator
  // reading that goes looking for a missing event instead of reading the run's status, and of the
  // three this is the rule that catches a stranded lease — register defect D2.
  const evs = fixture(() => [
    ev("run.started", { posture: "out" }),
    ev("task.ready", { nodeId: "n", branchPath: "root", edgesIn: [] }, { taskId: "n@root#0" }),
    ev("task.leased", { attempt: 1, leaseId: "l1", expiresAt: 2 }, { taskId: "n@root#0" }),
    ev("subgraph.started", { childRunId: "run_child", nodeId: "n" }, { taskId: "n@root#0" }),
    ev("gate.raised", { gateId: "g1", nodeId: "n", policyRef: "oversight/x@stable", contentDigest: "d" }, { taskId: "n@root#0" }),
    ev("run.failed", { error: { code: "E_X", message: "nope", class: "internal", retryable: false } }),
  ]);
  const why = new Map(audit(evs).skipped.map((s) => [s.rule, s.why]));

  for (const rule of ["task.leased-is-resolved", "subgraph.start-and-completion-pair", "gate.raised-is-resolved"] as const) {
    const reason = why.get(rule);
    assert.ok(reason !== undefined, `${rule} should be skipped on a failed run`);
    assert.doesNotMatch(
      reason,
      /no event this rule constrains appears in this journal/,
      `${rule}: the journal DOES contain the event this rule constrains — the reason is false`,
    );
    assert.match(reason, /did not complete/, `${rule}: the true reason is the run's status`);
  }
});

test("and a journal that really lacks the event still says so", () => {
  // The correction must not become a blanket excuse: a failed run with no lease and no child has
  // nothing for those rules to constrain, and the generic reason is the honest one there.
  const evs = fixture(() => [
    ev("run.started", { posture: "out" }),
    ev("run.failed", { error: { code: "E_X", message: "nope", class: "internal", retryable: false } }),
  ]);
  const why = new Map(audit(evs).skipped.map((s) => [s.rule, s.why]));
  assert.match(why.get("task.leased-is-resolved") ?? "", /no event this rule constrains/);
  assert.match(why.get("subgraph.start-and-completion-pair") ?? "", /no event this rule constrains/);
});
