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
    ["effect.completed-once-per-attempt", "effect.completion-has-a-start", "effect.kind-matches-its-key", "run.submitted-is-first-and-once"],
    "the three effect rules, plus the submission rule every real journal gives evidence for",
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
