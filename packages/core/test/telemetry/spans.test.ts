/**
 * What a `loom.gate` span SAYS about a gate that nobody answered.
 *
 * Hand-written journals rather than a driven run, for one reason: the four terminal
 * shapes of a gate — decided, timed out, withdrawn, and still open — have to sit next
 * to each other to be compared at all, and no single run produces all four. A driven
 * run also cannot produce the *ordering* cases (a cancel arriving after a decision),
 * which is where the fold's guards live.
 *
 * Offline and clock-free: every `ts` is a literal, so a span's `endTime` is an
 * assertion about the fold and never about the machine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { conformsToGraph, reconstructGraph, shouldExport, spansFrom, type Span } from "../../src/telemetry/spans.ts";
import { fixtureJournal } from "./trace-fixture.ts";
import { SYSTEM_ACTOR, type Actor, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { digest, digestOf } from "../../src/canonical.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq, TaskId } from "../../src/ids.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";

const RUN = "01JRUNSPAN0000000000000000" as RunId;
const TASK = "approve@#0" as TaskId;
const GATE = "gate-1" as GateId;

// A DEPLOYMENT KEY FOR THE WHOLE FILE, because without one `redactAttributes` omits every
// `pii` attribute and half the assertions below would be asserting about absence. That is
// itself a behaviour worth pinning, so the test that drives the unkeyed case takes the
// variable away again rather than this file leaving it unset. See `deploymentKey` in
// `security/redact.ts`.
const KEY_ENV = "LOOM_PII_TOKEN_KEY";
const TOKEN_KEY = "5c".repeat(32);
const OTHER_KEY = "e1".repeat(32);
process.env[KEY_ENV] = TOKEN_KEY;

const HUMAN: Actor = { kind: "human", subject: "u:alice", via: "console" };

/** `ts` is derived from `seq` so the ordering of a fixture is visible in one column. */
function ev(seq: number, type: string, payload: unknown, opts: { actor?: Actor; taskId?: TaskId | null } = {}): JournalEvent {
  const taskId = opts.taskId === undefined ? TASK : opts.taskId;
  return {
    runId: RUN,
    seq,
    ts: 1_000 + seq * 10,
    type,
    payload,
    actor: opts.actor ?? SYSTEM_ACTOR("test"),
    ...(taskId === null ? {} : { taskId }),
    classification: "internal",
  } as unknown as JournalEvent;
}

const submitted = ev(1, "run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "k", configDigest: "c" }, { taskId: null });
const ready = ev(2, "task.ready", { nodeId: "approve", branchPath: "", edgesIn: [] });
const raised = ev(3, "gate.raised", { gateId: GATE, nodeId: "approve", policyRef: "p", contentDigest: "sha256:abc" });

/** The run's own terminal event, late enough that "closed at end of journal" is visible. */
const cancelledRun = ev(9, "run.cancelled", { clean: true, unknownEffects: [], forced: false }, { taskId: null });

function gateSpan(events: readonly JournalEvent[]): Span {
  const spans = spansFrom(events);
  const gate = spans.find((s) => s.name === "loom.gate");
  assert.ok(gate, "no loom.gate span was produced");
  return gate;
}

test("a withdrawn gate closes WHEN it was withdrawn, and says so", () => {
  const cancel = ev(4, "gate.cancelled", { gateId: GATE, reason: "run cancelled by operator" });
  const gate = gateSpan([submitted, ready, raised, cancel, cancelledRun]);

  assert.equal(gate.endTime, cancel.ts, "the span must close at the cancel, not at the end of the journal");
  assert.equal(gate.attributes["gate.decision"], "cancelled");
  assert.equal(gate.attributes["gate.reason"], "run cancelled by operator");
  assert.equal(gate.status, "error", "same status as the run.cancelled and task.cancelled arms of the same fold");
});

test("withdrawn, answered and timed out are three distinguishable facts in a trace", () => {
  const withdrawn = gateSpan([
    submitted,
    ready,
    raised,
    ev(4, "gate.cancelled", { gateId: GATE, reason: "budget floor" }),
    cancelledRun,
  ]);
  const answered = gateSpan([
    submitted,
    ready,
    raised,
    ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 42 }, { actor: HUMAN }),
  ]);
  const expired = gateSpan([
    submitted,
    ready,
    raised,
    ev(4, "gate.timeout", { gateId: GATE, action: "fail" }),
  ]);

  assert.deepEqual(
    [withdrawn, answered, expired].map((s) => s.attributes["gate.decision"]),
    ["cancelled", "approve", "timeout"],
    "one attribute answers 'what happened to this question' for all three",
  );
  // And nothing else has to be opened to tell them apart.
  assert.equal(answered.attributes["gate.latency_ms"], 42);
  assert.equal(expired.attributes["gate.action"], "fail");
  assert.equal(withdrawn.attributes["gate.reason"], "budget floor");
});

test("`status: \"unset\"` on a loom.gate span means the gate never closed, and only that", () => {
  // The gate that really is still open — no terminal gate event at all.
  const open = gateSpan([submitted, ready, raised, ev(4, "task.progress", { chunk: "x" })]);
  assert.equal(open.status, "unset");
  assert.equal(open.attributes["gate.decision"], undefined, "a gate with no outcome must not claim one");

  // Every terminal shape leaves `unset` behind, which is what makes the reading above
  // usable: before this, a withdrawn gate looked exactly like this span.
  const terminals = [
    ev(4, "gate.cancelled", { gateId: GATE, reason: "r" }),
    ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: HUMAN }),
    ev(4, "gate.decided", { gateId: GATE, decision: "reject", latencyMs: 1 }, { actor: HUMAN }),
    ev(4, "gate.timeout", { gateId: GATE, action: "fail" }),
  ];
  for (const t of terminals) {
    const s = gateSpan([submitted, ready, raised, t, cancelledRun]);
    assert.notEqual(s.status, "unset", `${t.type} left the span reading as still open`);
  }
});

test("a cancel that arrives after a decision retracts nothing on the span", () => {
  // The fold's `gate.cancelled` arm is only-from-`open` for exactly this reason; the
  // span side gets it for free because `close` is a no-op on a span already closed.
  const decided = ev(4, "gate.decided", { gateId: GATE, decision: "reject", latencyMs: 7 }, { actor: HUMAN });
  const gate = gateSpan([submitted, ready, raised, decided, ev(5, "gate.cancelled", { gateId: GATE, reason: "run cancelled" }), cancelledRun]);

  assert.equal(gate.attributes["gate.decision"], "reject");
  assert.equal(gate.endTime, decided.ts);
  assert.equal(gate.attributes["gate.reason"], undefined, "the withdrawal did not happen; nothing about it belongs on this span");
});

test("the approver is TOKENISED and the withdrawing component is not named on the span", () => {
  // `gate.approver` exists only on a human decision. A cancel is written by the engine,
  // so naming a system component there would manufacture the appearance of an approver.
  const withdrawn = gateSpan([submitted, ready, raised, ev(4, "gate.cancelled", { gateId: GATE, reason: "r" }), cancelledRun]);
  assert.equal(withdrawn.attributes["gate.approver"], undefined);
  assert.equal(withdrawn.attributes["gate.approver_kind"], undefined, "nor a kind, which would say somebody decided");

  const answered = gateSpan([submitted, ready, raised, ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: HUMAN })]);
  assert.notEqual(answered.attributes["gate.approver"], "u:alice");
  // The shape is `redact.ts`'s keyed token, not a bare digest prefix. This assertion used
  // to read `/^[0-9a-f]{12}$/` and passing it meant nothing: the value it accepted was an
  // UNKEYED sha256 prefix of the subject, which is a pseudonym only for an input nobody
  // can guess. See the inversion test below for what that cost.
  assert.match(String(answered.attributes["gate.approver"]), /^pii:[0-9a-f]{12}:string$/);
  assert.equal(answered.attributes["gate.approver_kind"], "human");
});

test("AN ESCALATION IS ON THE SPAN, so a gate that woke the director does not trace like one nobody moved", () => {
  // `gate.escalated` is neither a start nor a terminal event, which is why this fold had no
  // arm for it at all: every other gate event either opens the span or closes it. So a gate
  // that climbed two tiers came back with `events: []` and `gate.escalations: undefined` —
  // identical to one nobody ever escalated — while D9.1's taxonomy claimed the attribute.
  const unmoved = gateSpan([
    submitted,
    ready,
    raised,
    ev(6, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 5 }, { actor: HUMAN }),
  ]);
  const climbed = gateSpan([
    submitted,
    ready,
    raised,
    ev(4, "gate.escalated", { gateId: GATE, tier: 1, to: "role:sre-manager", deadline: 900_000 }),
    ev(5, "gate.escalated", { gateId: GATE, tier: 2, to: "role:director", deadline: 3_600_000 }),
    ev(6, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 5 }, { actor: HUMAN }),
  ]);

  assert.equal(unmoved.attributes["gate.escalations"], undefined, "a gate nobody escalated claims no tier");
  assert.equal(climbed.attributes["gate.escalations"], 2, "the HIGHEST tier reached — what a trace search filters on");
  // The chain itself, in order, which is what an incident review reads — with `tier` in
  // the clear and the RECIPIENT tokenised. `to` is `formatRecipients`' output, so it
  // carries `user:<address>` for a named individual; before span events were redacted at
  // all it left the process verbatim, one field away from the `gate.approver` this same
  // span goes to some trouble to hide.
  assert.deepEqual(
    climbed.events.map((s) => [s.name, s.attributes?.["tier"]]),
    [
      ["gate.escalated", 1],
      ["gate.escalated", 2],
    ],
    "…and the chain itself, in order, which is what an incident review reads",
  );
  const told = climbed.events.map((s) => String(s.attributes?.["to"]));
  for (const t of told) assert.match(t, /^pii:[0-9a-f]{12}:string$/);
  assert.equal(new Set(told).size, 2, "two different tiers went to two different places, and that still reads");
  assert.equal(climbed.attributes["gate.decision"], "approve", "an escalation does not close the gate");
  assert.equal(climbed.endTime, 1_060, "it still closes on the decision");
});

test("a gate its own default action decided traces as a DECISION, not as a timeout", () => {
  // `gate.timeout{default_action}` and the `gate.decided` it licenses are ONE append, and
  // closing on the first one told the wrong story twice: the span ended as a timeout, and
  // the decision riding behind it found a closed span and was dropped. So a gate the clock
  // APPROVED traced as one nobody answered. `run/projection.ts` has always made this
  // distinction; this fold did not.
  const byDefault = gateSpan([
    submitted,
    ready,
    raised,
    ev(4, "gate.timeout", { gateId: GATE, action: "default_action" }),
    ev(5, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 60_001 }, { actor: SYSTEM_ACTOR("gate-broker:timeout") }),
  ]);
  const expired = gateSpan([submitted, ready, raised, ev(4, "gate.timeout", { gateId: GATE, action: "fail" })]);

  assert.equal(byDefault.attributes["gate.decision"], "approve");
  // …by the broker, and that is now its own attribute rather than a value smuggled into
  // the approver slot. One key may not mean two things: `gate.approver` is classified
  // `pii` and tokenised unconditionally, so the word `system` sitting in it would come
  // out `pii:…:string` and read as a person.
  // ABSENT, and asserted as absence rather than as `undefined`. `assert.equal(x, undefined)`
  // is satisfied by a key that is PRESENT and holds `undefined`, which is exactly what
  // dropping the `e.actor.kind === "human"` conjunct produces here — a system actor has no
  // `subject`, so the mutation writes `"gate.approver": undefined` and the weaker assertion
  // could not tell. `exactOptionalPropertyTypes` makes that distinction everywhere else in
  // this codebase; an OTLP exporter makes it too.
  assert.equal("gate.approver" in byDefault.attributes, false, "no person decided this");
  assert.equal(byDefault.attributes["gate.approver_kind"], "system");
  assert.equal(byDefault.endTime, 1_050, "it closed on the decision, not on the row that licensed it");
  assert.deepEqual(
    byDefault.events.map((s) => [s.name, s.attributes?.["action"]]),
    [["gate.timeout", "default_action"]],
    "the SLA is still on the record as the thing that produced the decision",
  );
  assert.equal(expired.attributes["gate.decision"], "timeout", "and every other action really is an expiry");
  assert.equal(expired.status, "error");
});

test("A TASK MADE READY TWICE KEEPS ITS FIRST SPAN, not its last", () => {
  // A rewind re-runs a Task, so a SECOND `task.ready` for one taskId is an ordinary journal
  // rather than a corruption — and `spansFrom` folds the whole journal, rewind markers
  // included, so it meets both. `start` is a no-op on a span that is already open for
  // exactly this reason. Without it the span restarted: `startTime` jumped to the re-run and
  // `edges.in` — recorded on the FIRST ready so it survives a Task that never got leased —
  // was replaced by whatever the second one carried.
  //
  // The `loom.run` span has the same shape one level up: two `run.submitted` events on one
  // journal must not re-open the root.
  const first = ev(2, "task.ready", { nodeId: "approve", branchPath: "", edgesIn: ["e1", "e2"] });
  const again = ev(6, "task.ready", { nodeId: "approve", branchPath: "", edgesIn: [] });
  const spans = spansFrom([submitted, first, ev(3, "task.progress", { chunk: "x" }), again]);
  const task = spans.find((s) => s.name === "loom.task");
  assert.ok(task, "no loom.task span was produced");

  assert.equal(task.startTime, first.ts, "the span starts when the Task FIRST became ready");
  assert.deepEqual(task.attributes["edges.in"], ["e1", "e2"], "…and keeps the edges that made it ready");
  assert.deepEqual(task.events.map((s) => s.name), ["task.progress"], "the re-ready did not discard what happened");
});

test("A GATE RAISED BY AN EVENT CARRYING NO taskId IS STILL ON THE TRACE, parented on the run", () => {
  // `if (taskSpan === undefined || tid === undefined) continue;` sat ABOVE every gate arm,
  // so such a gate produced no `loom.gate` span at all — not mis-drawn, ABSENT — while
  // `run/projection.ts` and `GET /runs/:id/gates` showed it perfectly. A whole gate, its
  // escalations, its approver and its decision, invisible in the one artefact an incident
  // review opens. Reproduced before the arms moved: `spans: loom.run` and nothing else.
  //
  // Whether the engine can produce such an event is a separate question and is the reason
  // this is a fix rather than an argument: `engine.ts` branches on `gate.taskId === ""` in
  // two places with a comment saying a gate raised by a taskless event folds to it, so the
  // shape is contemplated in the tree. A gate that exists is on the trace either way.
  const taskless = [
    submitted,
    ev(3, "gate.raised", { gateId: GATE, nodeId: "approve", policyRef: "p", contentDigest: "sha256:abc" }, { taskId: null }),
    ev(4, "gate.escalated", { gateId: GATE, tier: 1, to: "role:sre-manager", deadline: 900_000 }, { taskId: null }),
    ev(5, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 9 }, { actor: HUMAN, taskId: null }),
    ev(6, "run.completed", { usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }, { taskId: null }),
  ];
  const spans = spansFrom(taskless);
  const root = spans.find((s) => s.name === "loom.run")!;
  const gate = spans.find((s) => s.name === "loom.gate");

  assert.ok(gate, "a gate the projection shows was absent from the trace entirely");
  assert.equal(gate.parentSpanId, root.spanId, "with no Task to hang it on, the run is the honest parent");
  assert.equal(gate.attributes["gate.decision"], "approve");
  assert.equal(gate.attributes["gate.escalations"], 1, "…and the escalation chain came with it");
  assert.equal(gate.endTime, 1_050, "it closes on the decision, exactly as a Task-scoped gate does");

  // The tree is still a tree: nothing is parented on a span that does not exist.
  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    if (s.parentSpanId !== undefined) assert.ok(ids.has(s.parentSpanId), `orphan span ${s.name}`);
  }

  // And a gate that DOES carry a taskId is unchanged — it still hangs off its Task.
  const withTask = spansFrom([submitted, ready, raised, ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: HUMAN })]);
  const task = withTask.find((s) => s.name === "loom.task")!;
  assert.equal(withTask.find((s) => s.name === "loom.gate")?.parentSpanId, task.spanId);
});

// ── the trace collector is outside the trust boundary ────────────────────────
//
// Everything below drives the INVERSION, not the format. Asserting "the value is not the
// plaintext" is what the old approver test did, and it passed against a construction that
// gave the plaintext back in a hundredth of a millisecond. The question a redaction test
// has to ask is whether the party holding the span can RECOVER the input, so each of these
// plays that party: it holds the candidate domain, it runs the same public construction,
// and it has to come up empty.

test("THE APPROVER CANNOT BE INVERTED FROM THE APPROVERS LIST THE SAME RUN JOURNALS", () => {
  // `gate.raised.approvers` is journaled in the clear a few events before the decision, and
  // a real approver domain is a company directory anyway. Against the old unkeyed
  // `digestOf(subject).slice(7, 19)` this loop found the answer in 0.011 ms; the whole
  // pseudonym was a lookup table nobody had to be given.
  const domain = ["u:alice@example.com", "u:bob@example.com", "u:carol@example.com", "u:dave@example.com"];
  const gate = gateSpan([
    submitted,
    ready,
    ev(3, "gate.raised", { gateId: GATE, nodeId: "approve", policyRef: "p", contentDigest: "sha256:abc", approvers: domain }),
    ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: { kind: "human", subject: "u:carol@example.com", via: "console" } }),
  ]);
  const emitted = String(gate.attributes["gate.approver"]);

  // The construction is public — this file can reproduce it exactly, which is the point.
  const guesses = domain.map((s) => digestOf(s).slice(7, 19));
  assert.equal(guesses.includes(emitted), false, "the emitted value is a member of the old, invertible construction");
  for (const s of domain) assert.notEqual(emitted, s);
  assert.match(emitted, /^pii:[0-9a-f]{12}:string$/);
});

test("A DIGEST OF A SMALL DOMAIN IS AN ORACLE, so gate.content_digest and state.hash.* are not shipped raw", () => {
  // The attacker's position: they saw the redacted rendering the channel got, so they know
  // every field but one, and they hold the span. Rebuild the payload with a candidate,
  // hash, compare. Against the raw digest a five-digit id fell in ~50 ms — the exact oracle
  // `GateDispatcher.deliver` closed for channels, reached through the trace instead.
  const payload = { command: "revoke-access", employeeId: 48_213, requester: "u:alice@example.com" };
  const state = { findings: { severity: "high" }, requester: payload.requester };

  const spans = spansFrom([
    submitted,
    ready,
    ev(3, "state.reduced", {
      channels: ["findings"],
      values: {},
      branchCount: 1,
      skipped: 0,
      degraded: false,
      stateHashBefore: digest({}),
      stateHashAfter: digest(state),
    }),
    ev(4, "gate.raised", { gateId: GATE, nodeId: "approve", policyRef: "p", contentDigest: digest(payload) }),
  ]);
  const gate = spans.find((s) => s.name === "loom.gate")!;
  const reduce = spans.find((s) => s.name === "loom.state.reduce")!;

  for (const [what, emitted] of [
    ["gate.content_digest", String(gate.attributes["gate.content_digest"])],
    ["state.hash.after", String(reduce.attributes["state.hash.after"])],
  ] as const) {
    assert.match(emitted, /^pii:[0-9a-f]{12}:string$/, `${what} is still a raw digest`);
    // Five thousand candidates is a millisecond of work and covers the real id; a raw
    // digest loses to it, a keyed token does not — the key is module-private in `redact.ts`
    // and is never exported, journaled or emitted. It IS reproducible in another process,
    // which is a different property and the one this file's determinism test rests on: it
    // is reproducible by whoever holds `LOOM_PII_TOKEN_KEY`, and by nobody else.
    for (let i = 48_000; i < 48_500; i++) {
      assert.notEqual(emitted, digest({ ...payload, employeeId: i }), `${what} confirmed employeeId=${i}`);
      assert.notEqual(emitted, digest({ ...state, employeeId: i }), `${what} confirmed employeeId=${i}`);
    }
  }

  // …AND THE TRACE STILL DOES ITS JOB. The token is a pure function of the hash, so the
  // chaining relation a reduce span exists to show survives it exactly.
  assert.notEqual(reduce.attributes["state.hash.before"], reduce.attributes["state.hash.after"], "this reduce changed state, and says so");
  const second = spansFrom([
    submitted,
    ready,
    ev(3, "state.reduced", { channels: [], values: {}, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: digest(state), stateHashAfter: digest(state) }),
  ]).find((s) => s.name === "loom.state.reduce")!;
  assert.equal(second.attributes["state.hash.before"], reduce.attributes["state.hash.after"], "after(n) === before(n+1) still holds through the token");
  assert.equal(second.attributes["state.hash.before"], second.attributes["state.hash.after"], "…and a no-op reduce is still visibly a no-op");
});

test("SPAN EVENTS ARE REDACTED TOO — `attributes` was never the only bag that leaves", () => {
  // `close` redacted `attributes` and handed `events` and `links` on raw. Invisible while
  // every event attribute was a closed enum; a live leak the moment `gate.escalated` put an
  // operator-authored recipient list on one. Both halves are asserted here because the fix
  // is the general one: whatever a future arm notes, it leaves through `redactAttributes`.
  const LEAK = "Bearer sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const spans = spansFrom([
    submitted,
    ev(2, "run.suspended", { reason: `provider refused: ${LEAK}` }, { taskId: null }),
    ready,
    raised,
    ev(4, "task.progress", { chunk: "x" }),
    ev(5, "gate.escalated", { gateId: GATE, tier: 1, to: "user:oncall@example.com, role:sre", deadline: 9 }),
    ev(6, "gate.cancelled", { gateId: GATE, reason: `budget floor; ${LEAK}` }),
    cancelledRun,
  ]);
  const root = spans.find((s) => s.name === "loom.run")!;
  const gate = spans.find((s) => s.name === "loom.gate")!;

  const suspended = root.events.find((e) => e.name === "run.suspended")!;
  assert.equal(String(suspended.attributes?.["reason"]).includes("sk-live"), false, "the detector sweep never ran on this bag");
  assert.match(String(suspended.attributes?.["reason"]), /^provider refused: Bearer \[redacted:/);
  // The identical string one field away, on the attribute bag, was redacted from the day
  // this file was written. That asymmetry is what "a second bag" cost.
  assert.match(String(gate.attributes["gate.reason"]), /^budget floor; Bearer \[redacted:/);

  const escalated = gate.events.find((e) => e.name === "gate.escalated")!;
  assert.equal(String(escalated.attributes?.["to"]).includes("oncall@example.com"), false);
  assert.equal(escalated.attributes?.["tier"], 1, "the tier is not personal data and stays legible");
  assert.equal(escalated.attributes?.["deadline"], 9);

  // An event with no attributes keeps having none: `exactOptionalPropertyTypes` treats
  // absent and empty as different things, and so does an OTLP exporter.
  const task = spans.find((s) => s.name === "loom.task")!;
  assert.equal("attributes" in task.events[0]!, false, `${task.events[0]!.name} grew an empty attribute bag`);
});

test("A URL'S CREDENTIALS DO NOT REACH THE COLLECTOR — the shape the sweep did not know", () => {
  // THE END OF THE TRACE THIS WAVE FOLLOWED. A provider is configured with
  // `baseUrl: https://svc:hunter2@api.example.com`, the transport refuses it, undici names
  // the whole URL in its message, and that string is journaled — `providers/http.ts` masks
  // it on ONE of its two paths, so the other one puts a live credential in an append-only
  // file. The journal is not redacted by design (D9.6), so from there the credential is in
  // every read of that run forever, and this file is the read that leaves the process.
  //
  // `run.suspended`'s reason is the EVENT bag and `gate.cancelled`'s is the ATTRIBUTE bag,
  // asserted together because they are two different lines in `close` and the last defect
  // in this area was one of them being handed on raw.
  //
  // WHOLE-STRING EQUALITY, not `!includes("hunter2")`: the second is satisfied by a span
  // that lost the attribute entirely, and the host is the half an operator debugs with.
  const URL_MSG =
    "Request cannot be constructed from a URL that includes credentials: https://svc:hunter2@api.example.com/v1/messages";
  const MASKED =
    "Request cannot be constructed from a URL that includes credentials: https://[redacted]@api.example.com/v1/messages";

  const events = [
    submitted,
    ev(2, "run.suspended", { reason: `provider unavailable: ${URL_MSG}` }, { taskId: null }),
    ready,
    raised,
    ev(5, "gate.cancelled", { gateId: GATE, reason: `channel refused: ${URL_MSG}` }),
    cancelledRun,
  ];
  const spans = spansFrom(events);

  const root = spans.find((s) => s.name === "loom.run")!;
  const gate = spans.find((s) => s.name === "loom.gate")!;
  assert.equal(root.events.find((e) => e.name === "run.suspended")!.attributes?.["reason"], `provider unavailable: ${MASKED}`);
  assert.equal(gate.attributes["gate.reason"], `channel refused: ${MASKED}`);

  // THE END-TO-END STATEMENT, over the bytes an exporter actually ships. A per-attribute
  // assertion says the two arms this test named are closed; this says no arm is.
  assert.equal(JSON.stringify(spans).includes("hunter2"), false, "the credential left the process on some span this test did not name");

  // AND THE OTHER HALF OF INVARIANT 8, which is the one a span may not break: telemetry may
  // DROP a value the journal keeps, and it may not CARRY one the journal hid. The journal
  // still has the credential — it is the source of truth, and this is what makes it
  // recoverable by anyone entitled to it — so the span is strictly poorer, never richer.
  assert.equal(JSON.stringify(events).includes("hunter2"), true, "the journal was redacted, which corrupts channel state (D9.6)");
});

test("EVERY ATTRIBUTE ON EVERY SPAN GOES THROUGH THE REDACTOR, including one no arm classified", () => {
  // Reverting `redactAttributes` to a bare spread turned NOTHING red before this test — the
  // one line the whole file's confidentiality rests on was unheld. A `SecretValue`-shaped
  // key is the cheapest total probe: `SECRETISH_KEY` fires on it whatever the
  // classification says, so it proves the walk ran rather than that one arm was mapped.
  const spans = spansFrom([
    { ...submitted, payload: { ...(submitted.payload as object), workflow: "w", configDigest: "api_key: AKIAIOSFODNN7EXAMPLE" } } as JournalEvent,
    ready,
    ev(3, "task.committed", { take: [], status: "succeeded", writes: {} }),
  ]);
  const root = spans.find((s) => s.name === "loom.run")!;
  assert.equal(String(root.attributes["config.digest"]).includes("AKIAIOSFODNN7EXAMPLE"), false, "the detector sweep did not run");
  assert.equal(root.attributes["config.digest"], "api_key: [redacted:aws-key]");
});

// ── the conformance assertion, and the halves of it nothing held ─────────────
//
// `reconstruct(trace) ⊆ declared(graph.hash)` is a DoD item and a CI assertion, and a
// mutation sweep over `spans.ts` found three of its four moving parts unheld: the whole
// node comparison, the graph-hash comparison, and the coercion of a claimed id. Deleting
// `unknownNodes` or `hashMatches` from `ok` left the suite green, because the one test
// driving a failure tampers with an EDGE. The three below are that sweep's residue.

const SPEC = {
  version: 1,
  workflow: "w",
  nodes: [{ id: "a" as NodeId, type: "function", fn: "f" }],
  edges: [{ id: "e1" as EdgeId, from: "a" as NodeId, to: "a" as NodeId }],
} as unknown as GraphSpec;

/** A hand-built two-span trace: one `loom.run` carrying the hash, one `loom.task`. */
function trace(hash: string, task: Record<string, unknown>): Span[] {
  const base = { traceId: "t", startTime: 0, endTime: 1, status: "ok", links: [], events: [] } as const;
  return [
    { ...base, spanId: "r", name: "loom.run", kind: "server", attributes: { "graph.hash": hash } },
    { ...base, spanId: "s", parentSpanId: "r", name: "loom.task", kind: "internal", attributes: task },
  ];
}

test("A TRACE OF THE WRONG GRAPH DOES NOT CONFORM, even when every node and edge is declared", () => {
  // `declared` is "the GraphSpec AT span.graph.hash" (D9.2), so the hash is half the
  // assertion and not a decoration beside it. Both `hashMatches = true` and dropping the
  // `&& hashMatches` conjunct from `ok` survived the sweep: a trace from run A checked
  // against graph B passed whenever B happened to contain A's nodes.
  const conforming = conformsToGraph(reconstructGraph(trace("h", { "node.id": "a", "edges.taken": ["e1"] })), SPEC, "h");
  assert.equal(conforming.ok, true, JSON.stringify(conforming));

  const wrongGraph = conformsToGraph(reconstructGraph(trace("SOME-OTHER-HASH", { "node.id": "a", "edges.taken": ["e1"] })), SPEC, "h");
  assert.equal(wrongGraph.hashMatches, false);
  assert.equal(wrongGraph.ok, false, "the node and edge sets are clean; the hash is the only thing wrong, and it is enough");
  assert.deepEqual([wrongGraph.unknownNodes, wrongGraph.unknownEdges], [[], []]);
});

test("A TRACE CLAIMING AN UNDECLARED NODE DOES NOT CONFORM — the half the edge test does not reach", () => {
  const r = conformsToGraph(reconstructGraph(trace("h", { "node.id": "ghost-node", "edges.taken": ["e1"] })), SPEC, "h");
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknownNodes, ["ghost-node"]);
  assert.deepEqual(r.unknownEdges, [], "…and it is the NODE that is reported, not a smear across both lists");
});

test("AN ID A TRACE CLAIMS IN A SHAPE THAT IS NOT A STRING IS UNKNOWN, NOT ABSENT", () => {
  // The reads were `typeof x === "string"` guards that SKIPPED anything else, so a span
  // claiming `edges.taken: [{}]` reconstructed to no edge at all and the assertion said
  // `ok` — fail-open, in the one function whose job is to refuse a claim. Coercion cannot
  // manufacture a match: nothing here equals a declared id.
  const r = conformsToGraph(reconstructGraph(trace("h", { "node.id": 7, "edges.taken": [{}, ["e1"], null] })), SPEC, "h");
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknownNodes, ["7"]);
  assert.deepEqual(r.unknownEdges, ["(null)", "(object)"], "and a hostile toString is never called: the shape is the name");

  // Absent is still absent — inventing a node for a span that claimed none would report a
  // node nobody wrote.
  const none = reconstructGraph(trace("h", { "edges.taken": [] }));
  assert.deepEqual(none.nodes, []);
  assert.deepEqual(none.instances, []);
});

// ── sampling ─────────────────────────────────────────────────────────────────

test("EVERY always-keep RULE IS A RULE, not just the gate one", () => {
  // D9.3's tail table lists five reasons a run is kept whatever the head ratio. Exactly one
  // — `gate.raised` — had a test; deleting any of the other four left the suite green, so
  // "a failed run is always traced" was an unheld claim in the paragraph an operator sizes
  // their sampling budget from.
  const kept = (type: string, payload: unknown = {}): boolean =>
    shouldExport([ev(1, type, payload, { taskId: null })], { headRatio: 0 });

  for (const [type, payload] of [
    ["gate.raised", { gateId: GATE, nodeId: "n", policyRef: "p", contentDigest: "d" }],
    ["run.failed", { error: { code: "E_X" } }],
    ["policy.escalated", { from: "out", to: "in", reason: "r" }],
    ["budget.exhausted", { dimension: "usd", limit: 1, used: 2 }],
    ["tool.called", { key: "k", name: "t", version: "1", irreversibility: "irreversible", idempotent: false, ok: true }],
    ["tool.called", { key: "k", name: "t", version: "1", irreversibility: "externally_visible", idempotent: false, ok: true }],
  ] as const) {
    assert.equal(kept(type, payload), true, `${type} ${JSON.stringify(payload)} was dropped at headRatio 0`);
  }

  // …and the rule really is about the irreversibility, not about the event name.
  assert.equal(kept("tool.called", { key: "k", name: "t", version: "1", irreversibility: "read_only", idempotent: true, ok: true }), false);
  assert.equal(kept("task.progress", { chunk: "x" }), false, "an ordinary run is still sampled");
});

test("TWO RUNS ARE TWO TRACES — traceId is derived from the run id, not minted per process", () => {
  // A constant `traceId` passed every assertion in the suite: the one test that looks at it
  // asserts `new Set(ids).size === 1` WITHIN one run, which a constant satisfies. Two runs
  // sharing a trace id would merge two workflows into one waterfall in the collector.
  const other = { ...submitted, runId: "01JRUNSPAN0000000000000001" as RunId } as JournalEvent;
  const a = spansFrom([submitted])[0]!;
  const b = spansFrom([other])[0]!;
  assert.notEqual(a.traceId, b.traceId);
  assert.notEqual(a.spanId, b.spanId, "…and so are their root spans");
  assert.equal(a.traceId, digestOf(submitted.runId).slice(7, 39), "derived, so a re-fold of the same journal lands in the same trace");
});

test("AN EMPTY JOURNAL IS AN EMPTY TRACE, not a throw", () => {
  // `spansFrom` reads `events[0]!.runId` immediately after this guard, so reverting it is a
  // TypeError rather than a wrong answer — on a path any caller reaches by asking for the
  // trace of a run id that has no events.
  assert.deepEqual(spansFrom([]), []);
});

test("A REJECTED GATE AND A FAILED TASK CLOSE `error`, which is the status half of D9.1's table", () => {
  // The terminal-shape table gives `reject` its own row with status `error`; the suite only
  // asserted that a decided gate is not `unset`, which `ok` satisfies too.
  const rejected = gateSpan([submitted, ready, raised, ev(4, "gate.decided", { gateId: GATE, decision: "reject", latencyMs: 1 }, { actor: HUMAN })]);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.attributes["gate.decision"], "reject");

  const approved = gateSpan([submitted, ready, raised, ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: HUMAN })]);
  assert.equal(approved.status, "ok");

  const failedTask = spansFrom([submitted, ready, ev(3, "task.committed", { take: [], status: "failed", writes: {} })]).find((s) => s.name === "loom.task")!;
  assert.equal(failedTask.status, "error");
});

test("AN UNCLOSED SPAN ENDS AT THE LAST EVENT THE JOURNAL HAS, not at the first", () => {
  // `lastTs` is what makes an in-flight trace readable — an open span's duration is "how
  // long has this been running", and pinning `endTime` is the only thing that says so.
  const spans = spansFrom([submitted, ready, ev(7, "task.progress", { chunk: "x" })]);
  for (const s of spans) {
    assert.equal(s.status, "unset");
    assert.equal(s.endTime, 1_070, `${s.name} closed at the wrong instant`);
  }
});

test("alwaysKeep: false REALLY DISABLES the tail rules — the one test that passed it could not tell", () => {
  // `shouldExport(journal, {headRatio: 0, alwaysKeep: false})` was asserted once, against a
  // journal holding a single `task.progress` — which no tail rule matches, so the assertion
  // held identically with the whole `if (policy.alwaysKeep !== false)` block deleted. The
  // flag an operator uses to say "sample this deployment honestly" was therefore untested in
  // the only direction that does anything.
  const gated = [ev(1, "gate.raised", { gateId: GATE, nodeId: "n", policyRef: "p", contentDigest: "d" }, { taskId: null })];

  assert.equal(shouldExport(gated, { headRatio: 0 }), true, "the default keeps a gated run whatever the head ratio");
  assert.equal(shouldExport(gated, { headRatio: 0, alwaysKeep: true }), true, "…and so does saying so");
  assert.equal(shouldExport(gated, { headRatio: 0, alwaysKeep: false }), false, "…and turning it OFF has to actually turn it off");

  // The tail rules are the only thing the flag touches: head sampling still decides.
  assert.equal(shouldExport(gated, { headRatio: 1, alwaysKeep: false }), true);
});

test("headRatio 1 EXPORTS EVERY RUN, including the one whose bucket lands on the ceiling", () => {
  // `bucket` is `parseInt(digest.slice(7, 11), 16) / 0xffff`, so it is CLOSED at 1: a run id
  // whose digest starts `ffff` buckets to exactly 1.0, and `bucket < policy.headRatio` is
  // then false for `headRatio: 1`. The `>= 1` short-circuit is what stops "keep everything"
  // silently dropping one run in 65 536 — a sampling hole that only ever shows up as a
  // missing trace for the one incident somebody went looking for.
  //
  // The run id below was found by enumerating `run_<base36>` until the digest slice was
  // `ffff` (`digestOf("run_0031gs")` → `sha256:ffff516…`), so this test is deterministic and
  // offline; re-derive it the same way if `digestOf` ever changes.
  const onTheCeiling = "run_0031gs" as RunId;
  const journal = [{ ...ev(1, "task.progress", { chunk: "x" }), runId: onTheCeiling } as JournalEvent];

  assert.equal(shouldExport(journal, { headRatio: 1, alwaysKeep: false }), true, "100 % must mean 100 %");
  assert.equal(shouldExport(journal, { headRatio: 0, alwaysKeep: false }), false, "…and 0 % must still mean 0 %");
  assert.equal(
    shouldExport(journal, { headRatio: 0.999, alwaysKeep: false }),
    false,
    "the ceiling run is genuinely the last one in, which is why the short-circuit is needed at all",
  );

  // AND AN EMPTY JOURNAL IS A DECISION, NOT A THROW — the sampling sibling of the empty
  // trace above. `events[0]?.runId ?? ""` is what makes it one, and a caller reaches it by
  // asking whether to export a run id with no events yet.
  assert.equal(shouldExport([], { headRatio: 0.5, alwaysKeep: false }), shouldExport([], { headRatio: 0.5, alwaysKeep: false }));
  assert.equal(shouldExport([], { headRatio: 1 }), true);
});

// ── the two promises this file makes, and the tension between them ───────────

const FIXTURE = fileURLToPath(new URL("./trace-fixture.ts", import.meta.url));

/** Fold the fixture journal in a CHILD process, under the key named (or none). */
function childTrace(key: string | undefined): string {
  const env = { ...process.env };
  if (key === undefined) delete env[KEY_ENV];
  else env[KEY_ENV] = key;
  return execFileSync(process.execPath, [FIXTURE], { encoding: "utf8", env });
}

/** Fold the same journal HERE, under the key named (or none), and put the env back. */
function localTrace(key: string | undefined): string {
  const before = process.env[KEY_ENV];
  if (key === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = key;
  try {
    return JSON.stringify(spansFrom(fixtureJournal()));
  } finally {
    if (before === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = before;
  }
}

test("A TRACE IS A PURE FUNCTION OF THE JOURNAL AND THE DEPLOYMENT KEY — PROVED IN A SECOND PROCESS", () => {
  // THE TEST THAT USED TO STAND FOR THIS FOLDED TWICE IN ONE PROCESS (`replay.test.ts`, "the
  // same journal yields identical spans"), which a per-process random key satisfies
  // perfectly. That is how `redactAttributes` came to call a `randomBytes(32)`-keyed HMAC
  // underneath a file whose first paragraph promises a pure function of the journal, with a
  // green suite on both sides of the change. A second PROCESS is the only observer that can
  // tell the two apart, and it is what a distributed deployment actually is: two workers
  // tracing one run, joining on the attributes.
  const mine = localTrace(TOKEN_KEY);
  assert.match(mine, /pii:[0-9a-f]{12}:string/, "no token in the fixture would make every claim below vacuous");
  assert.equal(childTrace(TOKEN_KEY), mine, "two processes, one journal, one key — and the bytes must agree");

  // …and the key is genuinely what keys it, so the agreement above is not "nothing is keyed".
  assert.notEqual(childTrace(OTHER_KEY), mine, "a different deployment key must not produce the same tokens");

  // The unkeyed deployment is deterministic too, by omission rather than by tokenisation.
  const unkeyed = localTrace(undefined);
  assert.equal(childTrace(undefined), unkeyed, "with no key configured the trace still folds identically anywhere");
  assert.equal(/pii:/.test(unkeyed), false, "…because there is no token in it at all");
  assert.notEqual(unkeyed, mine, "and it is a POORER trace, which is the cost of not configuring a key");
});

test("WITHOUT A DEPLOYMENT KEY THE pii ATTRIBUTES ARE ABSENT, not blank and not equal to each other", () => {
  // Which attributes go, named one at a time, because "the trace is poorer" is not a
  // reviewable statement. Everything NOT classified `pii` must survive untouched — a trace
  // that lost `gate.id` or the state chain's shape would be a different regression wearing
  // this one's clothes.
  const unkeyed = JSON.parse(localTrace(undefined)) as Span[];
  const gate = unkeyed.find((s) => s.name === "loom.gate")!;
  const reduce = unkeyed.find((s) => s.name === "loom.state.reduce")!;

  assert.equal("gate.approver" in gate.attributes, false);
  assert.equal("gate.content_digest" in gate.attributes, false);
  assert.equal("state.hash.before" in reduce.attributes, false);
  assert.equal("state.hash.after" in reduce.attributes, false);
  assert.equal("to" in (gate.events.find((e) => e.name === "gate.escalated")?.attributes ?? {}), false, "on a span EVENT too");

  // A SENTINEL WOULD HAVE BEEN THE OTHER OPTION AND IT IS WORSE THAN ABSENCE. Two
  // deliberately different state hashes rendered as one constant would assert "this reduce
  // changed nothing" — inventing a fact out of "we could not tell you one". Absence asserts
  // nothing, which is the same rule `04-OVERSIGHT` states for an empty approvers list.
  assert.equal(gate.attributes["gate.id"], "g_1", "everything that is not pii is untouched");
  assert.equal(gate.attributes["gate.approver_kind"], "human", "…including the oversight fact beside the person");
  assert.equal(gate.events.find((e) => e.name === "gate.escalated")?.attributes?.["tier"], 1);
});

test("TWO RUNS' TOKENS DO NOT CORRELATE — the run scope `close` passes is a key, not a decoration", () => {
  // Dropping the third argument of `redactAttributes({...}, ATTRIBUTE_CLASSES, runId)` left
  // the whole suite green: every token would then be minted under `tokenKey`'s PROCESS
  // default, and a collector holding two runs' traces could tell that one person answered a
  // gate in each, or that two runs reached byte-identical channel state — an equality oracle
  // across runs and across tenants, granted to a party that holds neither value. `tokenKey`
  // states the run scope as a CONDITION on any caller whose reader is outside the boundary;
  // this is the assertion that the condition is met.
  const decided = ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: HUMAN });
  const journal = [submitted, ready, raised, decided];
  const here = gateSpan(journal);
  const elsewhere = gateSpan(journal.map((e) => ({ ...e, runId: "01JRUNSPAN0000000000000009" as RunId }) as JournalEvent));

  assert.match(String(here.attributes["gate.approver"]), /^pii:[0-9a-f]{12}:string$/);
  assert.notEqual(
    elsewhere.attributes["gate.approver"],
    here.attributes["gate.approver"],
    "one person, two runs, one token — that is the cross-run oracle the scope closes",
  );
  assert.notEqual(elsewhere.attributes["gate.content_digest"], here.attributes["gate.content_digest"], "…and the same for the digest");
  // Within one run it still correlates, which is the property the scope must not cost.
  assert.equal(gateSpan(journal).attributes["gate.approver"], here.attributes["gate.approver"]);
});

// ── the survivors an independent mutation sweep found ────────────────────────

test("A DENIED POLICY DECISION TRACES AS AN ERROR AND AN ALLOW DOES NOT — the one bit that says which", () => {
  // `close(id, e.ts, e.payload.effect === "deny" ? "error" : "ok")` survives INVERSION with
  // the whole suite green: every denied decision would trace `ok` and every allow `error`,
  // which is the one attribute a reviewer scanning a trace for refusals filters on. The
  // `policy.effect` attribute is not a substitute — a collector's error-rate view reads the
  // STATUS.
  const decided = (effect: string): Span =>
    spansFrom([
      submitted,
      ready,
      ev(3, "policy.decided", { effect, posture: "on", reasons: ["r"], irreversibility: "irreversible" }),
    ]).find((s) => s.name === "loom.policy")!;

  assert.equal(decided("deny").status, "error");
  assert.equal(decided("deny").attributes["policy.effect"], "deny");
  assert.equal(decided("allow").status, "ok");
  assert.equal(decided("escalate").status, "ok", "escalate is not a refusal — it is a refusal to decide alone");
});

test("SPANS COME OUT IN TIME ORDER, with the id only breaking ties", () => {
  // `done.sort((a, b) => a.startTime - b.startTime || (a.spanId < b.spanId ? -1 : 1))`
  // survives `||` becoming `&&`: the comparator then returns the ID comparison whenever the
  // times DIFFER and 0 when they agree, i.e. it discards time ordering entirely and keeps
  // only the tie-break. The suite stayed green because every other assertion here finds its
  // span by name. A waterfall in the wrong order is the one thing a trace is opened for.
  const spans = spansFrom([
    submitted,
    ready,
    ev(3, "checkpoint.created", { atSeq: 3, kind: "auto", openTasks: 1 }),
    ev(4, "state.reduced", { channels: [], values: {}, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: "sha256:a", stateHashAfter: "sha256:b" }),
    raised,
    ev(6, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: HUMAN }),
    ev(7, "task.committed", { take: [], status: "succeeded", writes: {} }),
    ev(8, "run.completed", { usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }, { taskId: null }),
  ]);

  const times = spans.map((s) => s.startTime);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "the waterfall is out of order");

  // …and the fixture really does distinguish the two orders, which is the half a reader has
  // to be able to check. If this ever fails, the span ids happen to agree with the clock and
  // the fixture — not the comparator — needs changing.
  const byIdAlone = [...spans].sort((a, b) => (a.spanId < b.spanId ? -1 : 1)).map((s) => s.spanId);
  assert.notDeepEqual(byIdAlone, spans.map((s) => s.spanId), "sorting by id alone would give the same answer here");

  // THE TIE-BREAK ITSELF, and it changed: it was the SPAN ID and is now journal order.
  //
  // What this assertion has always been for is determinism — two spans starting at the same
  // instant must be ordered by something, so a re-fold cannot shuffle them. A span id met that
  // bar and nothing else: it is a digest, so the order it imposes carries no meaning. Measured
  // on a four-node run through `bin/loom` — `collect` (a join) and `write` (the only node that
  // reads what it produces) both reached `task.ready` in the same millisecond, and `loom trace`
  // printed `write` above `collect`, reversing the one edge between them. Five of that run's
  // Tasks fell inside nine milliseconds, so a collision is ordinary rather than a race.
  //
  // `seq` totally orders a journal and the fold consumes it in that order, so the order spans
  // are STARTED in is causal. It is a pure function of the journal, so the determinism this
  // assertion protects is unchanged; only the meaning of the order improved. The fixture is kept
  // exactly as it was — its whole point is that the two ids sort the OTHER way round from the
  // order the fold produces them in, which is now what makes the change visible here.
  const sameTs = [
    submitted,
    ready,
    { ...ev(3, "checkpoint.created", { atSeq: 3, kind: "auto", openTasks: 1 }), ts: 2_000 } as JournalEvent,
    { ...ev(5, "state.reduced", { channels: [], values: {}, branchCount: 1, skipped: 0, degraded: false, stateHashBefore: "sha256:a", stateHashAfter: "sha256:b" }), ts: 2_000 } as JournalEvent,
  ];
  const tiedSpans = spansFrom(sameTs).filter((s) => s.startTime === 2_000);
  assert.equal(tiedSpans.length, 2);
  assert.deepEqual(
    tiedSpans.map((s) => s.name),
    ["loom.checkpoint", "loom.state.reduce"],
    "seq 3 was journaled before seq 5, so it comes first — this is the assertion that flipped",
  );
  // And the id order really would disagree, so the line above is not passing by coincidence.
  const tied = tiedSpans.map((s) => s.spanId);
  assert.notDeepEqual(tied, [...tied].sort(), "the fixture no longer inverts id order — it must, or this proves nothing");
  // Determinism, stated directly rather than through whichever key happens to break the tie.
  assert.deepEqual(JSON.stringify(spansFrom(sameTs)), JSON.stringify(spansFrom(sameTs)), "a re-fold must be byte-identical");
});

// ── reconstructGraph still trusts the trace in three places ──────────────────

test("A CLAIM WHOSE CONTAINER IS NOT A LIST IS ONE UNKNOWN EDGE, not silence", () => {
  // The sibling of "a non-string id is unknown, not absent", one level up and left behind
  // when that one was fixed: `if (Array.isArray(list))` DROPPED the whole claim when the
  // container was the wrong shape, so `"edges.taken": {}` reconstructed to no edge at all
  // and `conformsToGraph` said `ok` — fail-open in the function whose entire job is to
  // refuse a trace claiming something the graph does not declare.
  const r = conformsToGraph(reconstructGraph(trace("h", { "node.id": "a", "edges.taken": { e1: true } })), SPEC, "h");
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknownEdges, ["(object)"], "reported by its shape, which cannot collide with a declared id");

  // A scalar is a CLAIM OF ONE, not a claim of nothing. It conforms exactly when the id it
  // spells is declared, which is the same subset test every other claim gets — this function
  // has never been able to detect what a trace fails to mention, only to refuse what it
  // asserts.
  assert.deepEqual(reconstructGraph(trace("h", { "edges.taken": "e1" })).edges, ["e1"]);
  const ghost = conformsToGraph(reconstructGraph(trace("h", { "node.id": "a", "edges.taken": "ghost-edge" })), SPEC, "h");
  assert.equal(ghost.ok, false);
  assert.deepEqual(ghost.unknownEdges, ["ghost-edge"]);
});

test("A LIST WHOSE ELEMENTS CANNOT BE READ IS ONE UNKNOWN EDGE TOO — the third move `readProp` did not close", () => {
  // `readProp`'s docstring said it was "the only way this file reads one" property of an
  // untrusted value, and `reconstructGraph`'s said a hostile bag's "only remaining move is to
  // ANSWER". Both were false in the same loop: `for (const id of list)` reads `Symbol.iterator`
  // and then each element off a value the bag supplied, and `Array.isArray` is the wrong
  // gatekeeper for that because it is PROXY-agnostic — it unwraps to the target — and because
  // an ordinary array can carry an accessor at index 0. So a bag that ANSWERED could still
  // throw, which is not "unreadable", not "silent" and not an answer: it is
  // `reconstructGraph` raising, so `conformsToGraph` never runs and the CI assertion returns
  // neither `ok: true` nor `ok: false`. Reproduced, two-span trace, intact `loom.run`:
  //
  //   array with a getter at [0] that throws  ⇒  Error: element getter
  //   array with a throwing Symbol.iterator   ⇒  Error: iterator
  //   new Proxy(["e1"], {get() { throw … }})  ⇒  Error: proxy get
  const throwingElement: unknown[] = [];
  Object.defineProperty(throwingElement, "0", { get(): never { throw new Error("element getter"); }, enumerable: true, configurable: true });
  throwingElement.length = 1;
  const throwingIterator = Object.defineProperty(["e1"], Symbol.iterator, { value: (): never => { throw new Error("iterator"); } });
  const proxied = new Proxy(["e1"], { get(): never { throw new Error("proxy get"); } });

  // None of the three throws any more, and the three verdicts DIFFER, which is the point of
  // reading rather than gatekeeping: what each list managed to say is what it is judged on.
  for (const [what, list, edges] of [
    // `length` answers 1 and the element read does not, so the element is `undefined` —
    // rendered `"undefined"`, the same text a genuinely absent element already produced
    // through `for…of`. Reported and refused rather than lost.
    ["a getter at index 0", throwingElement, ["undefined"]],
    // A FORGED ITERATOR NO LONGER DECIDES WHAT THE LIST SAYS. Indexing reads the element the
    // array really holds, so this one is now read correctly rather than merely not throwing —
    // the strengthening that comes free with the fix.
    ["a throwing Symbol.iterator", throwingIterator, ["e1"]],
    // A LIST THAT WILL NOT SAY HOW LONG IT IS gets the CONTAINER verdict — one unknown edge
    // named by its shape — because "it would not answer `length`" says nothing about its
    // contents rather than that it has none. Falling to zero there is the fail-open this whole
    // function is a correction of.
    ["a Proxy over an array", proxied, ["(object)"]],
  ] as const) {
    const rebuilt = reconstructGraph(trace("h", { "node.id": "a", "edges.taken": list }));
    assert.deepEqual(rebuilt.edges, [...edges], `${what}: the throw escaped and took the conformance check with it`);
    assert.deepEqual(rebuilt.unreadableSpans, [], `${what}: the span answered, so it is judged and not refused`);
    assert.equal(
      conformsToGraph(rebuilt, SPEC, "h").ok,
      edges[0] === "e1",
      `${what}: an edge nobody declared must not certify, and the one that is declared must`,
    );
  }

  // A LIST THAT ANSWERS IS STILL READ ELEMENT BY ELEMENT, so this is a totality fix and not a
  // new refusal — including a `Proxy` that participates, whose claims go through the same
  // subset test an honest one's do.
  assert.deepEqual(reconstructGraph(trace("h", { "edges.taken": ["e1", "ghost"] })).edges, ["e1", "ghost"].sort());
  assert.deepEqual(reconstructGraph(trace("h", { "edges.taken": new Proxy(["e1"], {}) })).edges, ["e1"]);
  assert.deepEqual(reconstructGraph(trace("h", { "edges.taken": [] })).edges, [], "an empty list is a claim of no edges");
});

test("THE ARRAY AROUND A TRACE IS PART OF THE TRACE — `reconstructGraph` refuses what `conformsToGraph` already refused", () => {
  // The sibling of `conformsToGraph`'s `Array.isArray(claimed)` guard, which was written for a
  // hand-built `ReconstructedGraph` whose `unreadableSpans` is not a list and which reasons
  // that "`?? []` here would be the fail-open again, arriving through a caller". The same
  // caller hands `reconstructGraph` its argument, and there the bare `spans.entries()`
  // answered `TypeError: spans.entries is not a function or its return value is not iterable`
  // — a verification function neither certifying nor refusing, which is the outcome both
  // functions' docstrings rule out. One file, one question, two answers.
  for (const notATrace of [undefined, null, {}, { length: 1 }, "loom.run", 7, new Set([1])]) {
    const r = reconstructGraph(notATrace as unknown as Span[]);
    assert.deepEqual(r.unreadableSpans, ["(unreadable)"], `${String(notATrace)} threw instead of being refused`);
    assert.deepEqual([r.nodes, r.edges, r.instances, r.graphHash], [[], [], [], ""], "a refusal, not an invention");
    assert.equal(conformsToGraph(r, SPEC, "").ok, false, "…and it may not be certified, even against the empty hash");
  }
  // AN EMPTY TRACE IS NOT AN UNREADABLE ONE. `[]` is a real answer — a trace that claims
  // nothing — and it has always reconstructed to nothing; a guard that swept it up would turn
  // `spansFrom([])`'s documented empty result into a refusal.
  assert.deepEqual(reconstructGraph([]).unreadableSpans, []);
});

test("A GRAPH HASH A TRACE CLAIMS IS READ TOTALLY, and a span whose bag is unreadable is REFUSED", () => {
  // `String(s.attributes["graph.hash"] ?? "")` was a bare coercion on an untrusted value in
  // the same loop as the three reads `idText` was written for — it runs a caller-supplied
  // `toString`, which can throw and take the whole conformance check with it, or answer
  // differently the second time. And `s.attributes` was dereferenced without being checked
  // to exist at all, on a value this function's premise says did not have to come from
  // `spansFrom`.
  const hostile = {
    toString(): string {
      throw new Error("a trace is untrusted input");
    },
  };
  const r = reconstructGraph(trace(hostile as unknown as string, { "node.id": "a" }));
  assert.equal(r.graphHash, "(object)", "named by its shape; its own toString is never invoked");
  assert.equal(reconstructGraph(trace(7 as unknown as string, {})).graphHash, "7", "a primitive still reads as itself");

  // The check for that bag USED TO SAY a span with no attributes is one that claims
  // nothing, and it certified: `[[], [], [], ""]` plus `ok` whenever the hash happened to
  // match. It now claims nothing AND is refused, which are two different statements.
  const bagless = trace("h", { "node.id": "a" }).map((s) => ({ ...s, attributes: undefined as unknown as Record<string, unknown> }));
  const empty = reconstructGraph(bagless);
  assert.deepEqual([empty.nodes, empty.edges, empty.instances, empty.graphHash], [[], [], [], ""]);
  assert.deepEqual(empty.unreadableSpans, ["#0", "#1"], "both spans are unreadable, and both are named");
  assert.equal(conformsToGraph(empty, SPEC, "h").hashMatches, false, "an absent hash matches nothing but an absent one");
  assert.equal(conformsToGraph(empty, SPEC, "").ok, false, "…and even a caller asking about the empty hash gets a refusal");
});

test("A SPAN WHOSE CLAIMS CANNOT BE READ MAKES THE TRACE NON-CONFORMANT — silence is not conformance", () => {
  // THE GUARD THAT PRODUCED THIS WAS ADDED TO HARDEN THIS FUNCTION AGAINST AN UNTRUSTED
  // TRACE, and it was the worst available version of the class it was closing: `if
  // (attributes === null || typeof attributes !== "object") continue;` erased every claim a
  // `loom.task` span makes — the span still SAYS `loom.task`, so the trace still asserts
  // that a Task ran — and `conformsToGraph` answered `ok: true`. Before the guard the same
  // input threw, which was ugly and correct. Reproduced against the whole shape family:
  //
  //   bag = undefined / null / 7 / "edges.taken:ghost-edge"  → ok=true, nodes=[] edges=[]
  //
  // A fail-open in a VERIFICATION function does not degrade a feature, it inverts a check.
  for (const bag of [undefined, null, 7, "edges.taken:ghost-edge", (): string[] => ["ghost-edge"]] as unknown[]) {
    const spans = trace("h", {});
    const rebuilt = reconstructGraph([spans[0]!, { ...spans[1]!, attributes: bag as Record<string, unknown> }]);
    const r = conformsToGraph(rebuilt, SPEC, "h");

    assert.deepEqual(rebuilt.unreadableSpans, ["#1"], `${typeof bag} bag: read as a span that claims nothing`);
    assert.equal(r.ok, false, `${typeof bag} bag: an unreadable span certified as conformant`);
    assert.deepEqual(r.unreadableSpans, ["#1"]);
    // A REFUSAL, NOT AN INVENTION. Nothing is added to either unknown list: this function
    // cannot say what the span claimed, and manufacturing a node or an edge nobody wrote
    // would be the mirror-image lie.
    assert.deepEqual([r.unknownNodes, r.unknownEdges], [[], []]);
    assert.equal(r.hashMatches, true, "the run span was readable and its hash still matches");
  }

  // An ELEMENT that is not a span at all is the same refusal one level up. `s.attributes`
  // on a `null` was a TypeError that took the whole conformance check with it — loud, but
  // it answered a question nobody asked instead of the one that was asked.
  const withJunk = conformsToGraph(reconstructGraph([null as unknown as Span, ...trace("h", { "node.id": "a" })]), SPEC, "h");
  assert.equal(withJunk.ok, false);
  assert.deepEqual(withJunk.unreadableSpans, ["#0"], "named by POSITION: reading an id off a malformed span is one more untrusted read");

  // …and the trace that is merely EMPTY still certifies nothing and refuses nothing. This
  // function has never been able to detect what a trace fails to mention.
  const nothing = conformsToGraph(reconstructGraph([]), SPEC, "");
  assert.deepEqual(nothing.unreadableSpans, []);
  assert.equal(nothing.ok, true, "an empty trace claims nothing, which is a different thing from claiming unreadably");
});

test("AN ARRAY, A Map, A Date OR A RegExp CLAIMS NOTHING — and it is the CLAIMS that say so, not the container", () => {
  // THE REFUSAL ABOVE WAS THE RIGHT VERDICT REACHED BY THE WRONG TEST, three times running.
  // `attributes === null || typeof attributes !== "object"` admits every exotic object
  // JavaScript has: `typeof [] === "object"`, and so are `Map`, `Date`, `RegExp` and `Set`.
  // Each reads back `undefined` for `node.id`, `task.id`, `edges.in` and `edges.taken` — a
  // `Map` keeps its entries in internal slots, not in properties — so a `loom.task` span
  // carrying one contributed NO claims, joined no `unreadableSpans`, and `conformsToGraph`
  // answered `ok: true`. Reproduced before the second iteration:
  //
  //   bag = [] | new Map([["node.id","ghost-node"]]) | new Date(0) | /ghost/
  //     ⇒ unreadableSpans=[]  ok=true  nodes=[] edges=[]
  //
  // The verdict below is unchanged and the reason is not: these are refused because the
  // four reads came back empty, which is a fact about what the span said rather than a
  // guess about what it is made of. The two tests that followed the `typeof` one are gone —
  // see `readProp` in `spans.ts` for why no fourth is worth writing.
  for (const bag of [
    [],
    ["node.id", "ghost-node"],
    new Map([["node.id", "ghost-node"]]),
    new Set(["e1"]),
    new Date(0),
    /ghost/,
  ] as unknown[]) {
    const spans = trace("h", {});
    const rebuilt = reconstructGraph([spans[0]!, { ...spans[1]!, attributes: bag as Record<string, unknown> }]);
    const r = conformsToGraph(rebuilt, SPEC, "h");
    const what = (bag as object).constructor.name;
    assert.deepEqual(rebuilt.unreadableSpans, ["#1"], `a ${what} bag was read as a span that claims nothing`);
    assert.equal(r.ok, false, `a ${what} bag certified as conformant`);
    assert.deepEqual([r.unknownNodes, r.unknownEdges], [[], []], "a refusal, not an invention");
  }

  // AN ARRAY WEARING `Object.prototype` IS STILL AN ARRAY. It was the one shape the
  // prototype half of the old pair could not see, which is what made `Array.isArray` look
  // redundant beside it until this case; now neither half is consulted and the array is
  // refused for the same reason every container above is — `["node.id"]` is `undefined`.
  const disguised: unknown[] = ["node.id", "ghost-node"];
  Object.setPrototypeOf(disguised, Object.prototype);
  const dressed = trace("h", {});
  const rebuiltDisguised = reconstructGraph([dressed[0]!, { ...dressed[1]!, attributes: disguised as unknown as Record<string, unknown> }]);
  assert.deepEqual(rebuiltDisguised.unreadableSpans, ["#1"], "an array is an array whatever prototype it is wearing");

  // A CLASS INSTANCE IS NOW READ, AND THAT IS THE ONE VERDICT THAT CHANGED. The shape test
  // refused it under the argument that "refusing a readable bag costs a false `ok: false`
  // and admitting an unreadable one costs a false `ok: true`" — sound while the check was
  // the bag, and moot once the check is the claims: a bag that ANSWERS has made a claim,
  // and a claim is the thing this function tests. `ghost-node` is reported by name, which
  // is strictly more information than `#1` was.
  class Bag {
    "node.id" = "ghost-node";
  }
  const instance = trace("h", {});
  const withInstance = conformsToGraph(reconstructGraph([instance[0]!, { ...instance[1]!, attributes: new Bag() as unknown as Record<string, unknown> }]), SPEC, "h");
  assert.deepEqual(withInstance.unreadableSpans, [], "a bag that answers is not a bag that could not be read");
  assert.equal(withInstance.ok, false, "…and what it answered is judged");
  assert.deepEqual(withInstance.unknownNodes, ["ghost-node"]);

  // …AND A NULL-PROTOTYPE RECORD READS LIKE ANY OTHER. This was a corner the prototype test
  // had to name explicitly — `ATTRIBUTE_CLASSES` in `spans.ts` is `Object.create(null)`-based
  // on purpose, so a rule written as `getPrototypeOf(v) === Object.prototype` alone would
  // have refused the construction this codebase reaches for. Nothing asks about a prototype
  // any more, so it is not a corner at all.
  const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { "node.id": "a", "edges.taken": ["e1"] });
  const clean = conformsToGraph(reconstructGraph(trace("h", nullProto)), SPEC, "h");
  assert.deepEqual(clean.unreadableSpans, []);
  assert.equal(clean.ok, true, JSON.stringify(clean));
});

test("AN EMPTY BAG IS A `loom.task` SPAN THAT CLAIMED NOTHING — the case four shape tests never asked about", () => {
  // THE ARGUMENT FOR ASKING THE READS INSTEAD OF THE CONTAINER, in one input. Three
  // iterations of a bag test — `typeof !== "object"`, then prototype identity, then
  // prototype identity plus `Array.isArray` — were each written to stop a `loom.task` span
  // contributing no claims while the trace went on asserting a Task ran. Not one of them
  // looked at `{}`, which is the plainest bag there is and which contributes no claims by
  // the identical route. Reproduced against the third iteration, two-span trace, intact
  // `loom.run`:
  //
  //   bag = {} | Object.create(null)  ⇒  unreadableSpans=[]  ok=true  nodes=[] edges=[]
  //
  // A container test cannot see this and no fourth one would. What sees it is the question
  // the reads answer: a span that says `loom.task` and yields none of `node.id`,
  // `task.id`, `edges.in`, `edges.taken` is a span whose claims could not be read,
  // WHATEVER the bag turned out to be made of.
  for (const bag of [{}, Object.create(null) as Record<string, unknown>]) {
    const spans = trace("h", bag as Record<string, unknown>);
    const rebuilt = reconstructGraph(spans);
    const r = conformsToGraph(rebuilt, SPEC, "h");
    assert.deepEqual(rebuilt.unreadableSpans, ["#1"], "an empty bag certified as a Task that claimed nothing");
    assert.equal(r.ok, false, "…and the trace was certified with it");
    assert.deepEqual([r.unknownNodes, r.unknownEdges], [[], []], "a refusal, not an invention");
  }

  // ONE CLAIM IS ENOUGH TO BE READ. `task.id` alone is what `spansFrom` puts on a Task that
  // never got leased, so this is the ordinary shape and not a corner: it claims an instance
  // and no node, and it is read rather than refused.
  const justTheId = reconstructGraph(trace("h", { "task.id": "approve@#0" }));
  assert.deepEqual(justTheId.unreadableSpans, []);
  assert.deepEqual(justTheId.instances, ["approve@#0"]);
});

test("A BAG BEHIND A `Proxy` THAT LIES ABOUT ITS PROTOTYPE CANNOT BUY `ok: true`", () => {
  // THE FOURTH ITERATION THAT WAS NOT WRITTEN. `isAttributeBag` asked `getPrototypeOf(v) ===
  // Object.prototype`, deliberately avoiding `Object.prototype.toString` because the tag form
  // reads a caller-supplied `Symbol.toStringTag` getter. The reasoning was right and the
  // result was still forged in one line: `getPrototypeOf` is a `Proxy` trap too, and a
  // `Proxy` over a `Map` answered `Object.prototype`, passed the test, then answered
  // `undefined` to every claim. Reproduced against the third iteration:
  //
  //   new Proxy(new Map([["edges.taken",["ghost-edge"]]]), {getPrototypeOf: () => Object.prototype})
  //     ⇒ unreadableSpans=[]  ok=true  edges=[]
  //
  // A `Proxy` can forge every observable an inspector can ask for except the extensibility
  // of its target, so "is this a plain bag?" has no answer to harden towards. Asking the
  // READS has one: a forged bag that answers nothing is unreadable, and a forged bag that
  // ANSWERS has made a claim, which is the thing this function tests.
  const liar = (target: object): Record<string, unknown> =>
    new Proxy(target, { getPrototypeOf: () => Object.prototype }) as Record<string, unknown>;

  for (const target of [new Map([["edges.taken", ["ghost-edge"]]]), new Set(["e1"]), new Date(0), /ghost/] as object[]) {
    const spans = trace("h", {});
    const rebuilt = reconstructGraph([spans[0]!, { ...spans[1]!, attributes: liar(target) }]);
    assert.deepEqual(rebuilt.unreadableSpans, ["#1"], `a Proxy over a ${target.constructor.name} bought silence`);
    assert.equal(conformsToGraph(rebuilt, SPEC, "h").ok, false);
  }

  // A THROWING TRAP IS THE SAME ANSWER AND USED TO BE A DIFFERENT ONE: the read was bare, so
  // the trap's error came out of `reconstructGraph` and cost the caller the whole
  // conformance check — a verification function answering neither yes nor no.
  const detonator = new Proxy(
    {},
    {
      getPrototypeOf: () => Object.prototype,
      get(): never {
        throw new Error("a trace is untrusted input");
      },
    },
  ) as Record<string, unknown>;
  const boom = trace("h", {});
  const rebuiltBoom = reconstructGraph([boom[0]!, { ...boom[1]!, attributes: detonator }]);
  assert.deepEqual(rebuiltBoom.unreadableSpans, ["#1"], "the trap's throw escaped instead of being a refusal");

  // …AND A PROXY THAT ANSWERS IS BELIEVED, because answering is participating: its claims go
  // through the same subset test every honest span's do, and an undeclared one is refused
  // by name rather than by shape.
  const answering = new Proxy(
    { "node.id": "ghost-node" },
    { getPrototypeOf: () => Object.prototype },
  ) as Record<string, unknown>;
  const spoke = trace("h", {});
  const r = conformsToGraph(reconstructGraph([spoke[0]!, { ...spoke[1]!, attributes: answering }]), SPEC, "h");
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknownNodes, ["ghost-node"], "a forged bag that speaks is judged on what it said");
});

test("A SPAN'S `name` IS READ ONCE — a getter that answers twice used to erase every claim it made", () => {
  // A12's sweep, applied to the value that STEERS this loop rather than to one it reports:
  // `s.name` was read twice, `=== "loom.run"` and then `!== "loom.task"`. A span whose
  // `name` answers `loom.task` first and `loom.run` second therefore failed the run test and
  // passed the skip test, so its claims were never read at all. Reproduced:
  //
  //   {get name() { return n++ === 0 ? "loom.task" : "loom.run"; },
  //    attributes: {"node.id":"ghost-node","edges.taken":["ghost-edge"]}}
  //     ⇒ nodes=[] edges=[] unreadableSpans=[]  ok=true
  //
  // A trace claiming an undeclared node AND an undeclared edge, certified — in the function
  // whose only job is to refuse exactly that.
  let n = 0;
  const dodger = {
    get name(): string {
      return n++ === 0 ? "loom.task" : "loom.run";
    },
    attributes: { "node.id": "ghost-node", "edges.taken": ["ghost-edge"] },
    traceId: "t",
    spanId: "x",
    kind: "internal",
    startTime: 0,
    endTime: 1,
    status: "ok",
    links: [],
    events: [],
  } as unknown as Span;
  const r = conformsToGraph(reconstructGraph([dodger]), SPEC, "");
  assert.equal(r.ok, false, "the span dodged the loop and the trace was certified");
  assert.deepEqual(r.unknownNodes, ["ghost-node"]);
  assert.deepEqual(r.unknownEdges, ["ghost-edge"]);

  // A `name` THAT CANNOT BE READ AT ALL IS NOT A SPAN, which is the element-level refusal
  // stated as a property of the first read rather than of the element's container. It is the
  // same answer a `null` element gets, by the same line.
  const mute = { get name(): string { throw new Error("no"); }, attributes: { "node.id": "a" } } as unknown as Span;
  assert.deepEqual(reconstructGraph([mute]).unreadableSpans, ["#0"]);
  assert.deepEqual(reconstructGraph([{ name: 7 } as unknown as Span]).unreadableSpans, ["#0"], "a name that is not a string names nothing");
});

// ── the values the JOURNAL supplies, in the shapes it is not supposed to ─────
//
// The journal is authoritative and trusted (invariant 2), and "trusted" means "we do not
// defend against it" — not "it cannot be malformed". Neither store can produce the shapes
// below: `journal/sqlite.ts` and `journal/memory.ts` both map a NULL `task_id` column to an
// ABSENT field rather than to `null`, and `prepare` writes `e.taskId ?? input.taskId ??
// null`. A hand-written or legacy journal is the reachable path, and this repo folds those
// routinely — every fixture in this file is one.

/** An event with `taskId` FORCED to a raw value, which is what a hand-written journal is. */
function rawTaskId(e: JournalEvent, v: unknown): JournalEvent {
  return { ...e, taskId: v } as unknown as JournalEvent;
}

test("A taskId THAT IS null OR EMPTY IS NO taskId — one SHARED span is worse than none", () => {
  // `null` passed BOTH halves of the task-scope guard. `tid === undefined` is false for it,
  // and `taskSpan` is derived under the same test — and `spanId(runId, "task", null)` is a
  // perfectly ordinary string, because `[…, null].join("|")` renders `null` as the EMPTY
  // one. So every taskless event in a journal folded into ONE `loom.task` span keyed on the
  // empty task id: two different Tasks' claims merged, and `"task.id": null` on the result.
  //
  // `""` reaches the same span by the other road, and this comment used to say the engine
  // already refused to journal it — "`run/gates.ts` and `run/engine.ts` both strip `taskId`
  // when a gate's folded id is `""`", so "this fold now agrees with them". Verified against
  // both files and it is two-thirds true: `gates.ts` strips at `#commitForOpenGate` and at
  // `resolveBatch`'s lead and NOT at `raise` or `resolve`, and `engine.ts` strips from the
  // event rather than from the append. `""` is not nullish, so `prepare`'s
  // `e.taskId ?? input.taskId ?? null` passes it straight through — see `tid` in `spans.ts`.
  // The block below drives that end to end; this fold is the place that is total, not the
  // place that agrees.
  for (const bogus of [null, "", 7, {}] as unknown[]) {
    const spans = spansFrom([
      submitted,
      rawTaskId(ev(2, "task.ready", { nodeId: "approve", branchPath: "", edgesIn: ["e1"] }), bogus),
      rawTaskId(ev(3, "task.ready", { nodeId: "review", branchPath: "", edgesIn: ["e2"] }), bogus),
      rawTaskId(ev(4, "task.committed", { take: ["e3"], status: "succeeded", writes: {} }), bogus),
    ]);
    assert.deepEqual(
      spans.filter((s) => s.name === "loom.task").map((s) => s.attributes["task.id"]),
      [],
      `taskId ${JSON.stringify(bogus)} minted a Task span with no Task behind it`,
    );
    // Telemetry may drop data (invariant 8); it may not invent it. Dropping the arm is the
    // whole of the fix — nothing is manufactured in its place.
    assert.deepEqual(spans.map((s) => s.name), ["loom.run"]);
  }

  // AND THE TREE STAYS A TREE, which is the observable that made this a defect rather than
  // a tidiness question: a gate arm parents on `taskSpan ?? rootId`, so a `null` taskId gave
  // it a defined parent id for a span that was never started. Reproduced before the fix:
  // `loom.gate` hanging off an id present on no span in the trace — an ORPHAN, which a
  // collector renders as a second root.
  const gateSpans = spansFrom([
    submitted,
    rawTaskId(raised, null),
    rawTaskId(ev(4, "gate.decided", { gateId: GATE, decision: "approve", latencyMs: 1 }, { actor: HUMAN }), null),
    ev(5, "run.completed", { usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }, { taskId: null }),
  ]);
  const ids = new Set(gateSpans.map((s) => s.spanId));
  const gate = gateSpans.find((s) => s.name === "loom.gate")!;
  assert.ok(ids.has(String(gate.parentSpanId)), "the gate was parented on a span that does not exist");
  assert.equal(gate.parentSpanId, gateSpans.find((s) => s.name === "loom.run")!.spanId, "with no Task, the run is the honest parent");

  // A REAL taskId IS UNTOUCHED, and the span id is still derived from the SAME read the
  // `task.id` attribute reports — the attribute used to be a second read of `e.taskId`.
  const real = spansFrom([submitted, ready, ev(3, "task.committed", { take: [], status: "succeeded", writes: {} })]);
  const task = real.find((s) => s.name === "loom.task")!;
  assert.equal(task.attributes["task.id"], TASK);
  assert.equal(task.spanId, digestOf(`${RUN}|task|${TASK}`).slice(7, 23), "the span id and the attribute must come from one read");
});

test("`taskId: \"\"` IS APPENDABLE ON BOTH STORES — the claim this fold used to lean on instead of deciding", async () => {
  // REGISTER A17's second measured fact reads "`taskId: \"\"` is deliberately never appended",
  // and `spans.ts`'s `tid` comment leaned on the same sentence to present its own guard as
  // agreement with the engine rather than as a decision. Neither is true. `run/gates.ts`
  // strips the id at `#commitForOpenGate` and at `resolveBatch`'s lead, and NOT at `raise`
  // (`{ taskId: req.taskId }`) or `resolve` (`{ taskId: gate.taskId }`); `run/engine.ts`
  // strips it from the EVENT in `cancelOpenGates`, which holds only because that function's
  // call sites append with no append-level id of their own.
  //
  // The shape below is exactly what `raise` writes when `req.taskId` is `""` — the field on
  // the event AND the stamp on the append — and `prepare`'s `e.taskId ?? input.taskId ??
  // null` passes it through because `""` is not nullish. Driven against BOTH stores, because
  // "neither store can hand this over" is the form the claim took.
  for (const [label, store] of [
    ["memory", new MemoryStateStore({ now: () => 1 })],
    ["sqlite", new SqliteStateStore({ path: ":memory:", now: () => 1 })],
  ] as const) {
    const runId = "01JRUNEMPTYTASKID00000000" as RunId;
    await store.append({
      runId,
      expectedSeq: 0 as Seq,
      events: [
        {
          type: "gate.raised",
          payload: { gateId: GATE, nodeId: "approve" as NodeId, policyRef: "p", contentDigest: "sha256:abc" },
          actor: SYSTEM_ACTOR("gate-broker"),
          taskId: "" as TaskId,
        },
      ],
      taskId: "" as TaskId,
    });
    const read: JournalEvent[] = [];
    for await (const e of store.read(runId, 1 as Seq)) read.push(e);
    assert.equal(read.length, 1, label);
    assert.equal("taskId" in read[0]!, true, `${label}: the field was dropped, so the claim would hold`);
    assert.equal(read[0]!.taskId, "", `${label}: an empty taskId came back as an empty taskId`);

    // …and the FOLD is what keeps the empty id off the trace, which is the property `tid`
    // actually has: a positive test, not an echo of a strip only two of five appends
    // perform. The gate is still drawn — that is the arms-above-the-guard fix — and it is
    // parented on the run rather than on a `loom.task` span keyed on the empty string.
    const folded = spansFrom(read);
    assert.deepEqual(folded.map((s) => s.name), ["loom.gate"], "a gate that exists is on the trace");
    assert.equal(folded[0]!.parentSpanId, digestOf(`${runId}|run`).slice(7, 23), "with no usable taskId, the run is the parent");
    assert.equal(
      folded.some((s) => s.spanId === digestOf(`${runId}|task|`).slice(7, 23)),
      false,
      "the empty id must not mint a Task span",
    );
  }
});

test("A `task.ready` WHOSE binding IS null DOES NOT TAKE THE WHOLE TRACE WITH IT", () => {
  // `e.payload.binding === undefined ? {} : e.payload.binding.channel` is the same reflex as
  // the taskId guard above, one payload deeper: `null` is not `undefined`, so `null.channel`
  // threw a TypeError out of `spansFrom` and the caller lost EVERY span for the run — not
  // one dropped attribute but the whole trace, and for `loom trace` the whole process.
  // Reproduced: `TypeError: Cannot read properties of null (reading 'channel')`.
  const spans = spansFrom([submitted, ev(2, "task.ready", { nodeId: "approve", branchPath: "", edgesIn: [], binding: null })]);
  const task = spans.find((s) => s.name === "loom.task");
  assert.ok(task, "the whole trace was lost to one malformed optional field");
  assert.equal("branch.item_channel" in task.attributes, false, "absent is absent — an attribute holding `undefined` is not the same thing");

  // The present half, which nothing held either: `edges.in` and the channel both survive.
  const bound = spansFrom([
    submitted,
    ev(2, "task.ready", { nodeId: "approve", branchPath: "", edgesIn: ["e1"], binding: { channel: "items", index: 0 } }),
  ]).find((s) => s.name === "loom.task")!;
  assert.equal(bound.attributes["branch.item_channel"], "items");
  assert.deepEqual(bound.attributes["edges.in"], ["e1"]);
});

test("A HEAD RATIO THAT IS NOT A RATIO EXPORTS, AND SAYS SO — a validation failure must not read as `headRatio: 0`", async () => {
  // `if (r >= 1) return true; if (r <= 0) return false; return bucket < r;` is not total.
  // `NaN`, `undefined` and `{}` lose EVERY comparison, so they fell past both short-circuits
  // and past the bucket test and exported NOTHING — observationally identical to a
  // deliberate `headRatio: 0`. `null` and a negative reached the same answer through
  // `null <= 0` and `-1 <= 0`, which are both TRUE. So a deployment that mistyped its
  // sampling policy saw a collector holding only the runs the tail rules keep, and had no
  // way to tell that from the 0 % head sampling it might well have configured.
  //
  // THE DIRECTION IS EXPORT, and it is argued rather than defaulted. Sampling is a COST
  // optimisation over data the journal already holds in full; when its parameter cannot be
  // read, the honest fallback is not to optimise. It is also the visible one — a collector
  // suddenly holding every run is noticed in a day, and a collector quietly holding none is
  // noticed when somebody goes looking for the one trace that mattered. This is where the
  // rule parts company with `redactAttributes`'s unusable scope, which DROPS: there the
  // alternative is disclosing under a key the caller did not choose, so quiet is strictly
  // safer. Here nothing is disclosed either way, and quiet is only quiet.
  const journal = [ev(1, "task.progress", { chunk: "x" }, { taskId: null })];
  await new Promise((resolve) => setImmediate(resolve));
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  const warned: string[] = [];
  const capture = (w: Error): void => void warned.push(w.message);
  process.on("warning", capture);
  try {
    for (const bad of [NaN, undefined, null, {}, "0.5", -1, 2, Infinity, -Infinity, 1n] as unknown[]) {
      assert.equal(
        shouldExport(journal, { headRatio: bad as number, alwaysKeep: false }),
        true,
        `headRatio ${String(bad)} silently exported nothing, exactly like a deliberate 0`,
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warned.length, 1, "a malformed sampling policy must say so — once per process, like every other config warning here");
    assert.match(warned[0]!, /headRatio/);
  } finally {
    process.off("warning", capture);
    for (const l of listeners) process.on("warning", l as (w: Error) => void);
  }

  // AND EVERY RATIO THAT IS ONE STILL DECIDES. The refusal above is a range test, so the
  // boundary values it must not swallow are pinned here rather than inferred.
  const onTheCeiling = [{ ...ev(1, "task.progress", { chunk: "x" }), runId: "run_0031gs" as RunId } as JournalEvent];
  assert.equal(shouldExport(journal, { headRatio: 0, alwaysKeep: false }), false, "0 must still mean 0");
  assert.equal(shouldExport(journal, { headRatio: 1, alwaysKeep: false }), true);
  assert.equal(shouldExport(onTheCeiling, { headRatio: 0.999, alwaysKeep: false }), false, "…and the bucket comparison still runs");
});

// ── the reads the "every read goes through `readProp`" claim did not name ─────

test("THE ELEMENTS OF THE TRACE ARRAY ARE READS TOO — the one that falsified `readProp`'s claim", () => {
  // `readProp`'s docstring said "inside `reconstructGraph` every read of one now goes through
  // here or through `Array.isArray`", and `reconstructGraph`'s said "THE ARGUMENT IS A TRACE,
  // AND A TRACE IS UNTRUSTED — including the array around it". Both were falsified by the
  // statement two lines under the guard: `for (const [i, s] of spans.entries())` reads
  // `.entries` off the untrusted array and then, per element, a `[[Get]]` the array iterator
  // performs — neither read going through `readProp`, and `Array.isArray` protecting neither,
  // because it unwraps a `Proxy` to its target and an ordinary array can carry an accessor at
  // index 0. This is the SAME defect the inner `edges.taken` loop was fixed for, one level up
  // and in the same function; the fix that named it stopped at the container it was holding.
  // Reproduced, node v24.16.0:
  //
  //   spans = array with a throwing accessor at [0]      ⇒ Error: outer element getter
  //   spans = new Proxy([span], {get(){throw}})          ⇒ Error: outer get trap
  //   spans = new Proxy([span], {get: entries-only trap}) ⇒ Error: outer entries trap
  const good = { name: "loom.run", attributes: { "graph.hash": "h" } } as unknown as Span;

  const throwingElement: unknown[] = [];
  Object.defineProperty(throwingElement, "0", { get(): never { throw new Error("outer element getter"); }, enumerable: true, configurable: true });
  throwingElement.length = 1;
  // AN ELEMENT THAT WILL NOT BE READ IS A SPAN THAT CLAIMS NOTHING, named by POSITION —
  // exactly the verdict a `null` element and a throwing `name` getter already get, because
  // `readProp` conflates "unreadable" with "absent" and the first read of an element is its
  // `name`. One rule, not a third one invented for this case.
  assert.deepEqual(reconstructGraph(throwingElement as Span[]).unreadableSpans, ["#0"]);

  // A `Proxy` THAT WILL NOT SAY HOW LONG IT IS gets the ARGUMENT verdict, which is the same
  // rule the inner list already takes ("a list that will not say how long it is") applied to
  // the container this function was handed: `(unreadable)`, because there are no positions to
  // name when the position count is what could not be read.
  const opaque = new Proxy([good], { get(): never { throw new Error("outer get trap"); } });
  assert.equal(Array.isArray(opaque), true, "…and `Array.isArray` said yes to it, which is why it is not the guard");
  assert.deepEqual(reconstructGraph(opaque as Span[]).unreadableSpans, ["(unreadable)"]);

  // AND A TRACE THAT ANSWERS IS STILL READ, which is what makes this a totality fix rather
  // than a new refusal. `.entries` is no longer read at all, so a bag that traps only that
  // property now reconstructs correctly instead of throwing.
  const entriesTrap = new Proxy([good], {
    get(t, k, r): unknown {
      if (k === "entries") throw new Error("outer entries trap");
      return Reflect.get(t, k, r);
    },
  });
  assert.equal(reconstructGraph(entriesTrap as Span[]).graphHash, "h");
  assert.deepEqual(reconstructGraph(entriesTrap as Span[]).unreadableSpans, []);

  // A LENGTH THAT LIES REPORTS THE GAP rather than hiding it: the elements that are not
  // there read back `undefined`, which yields no dispatchable `name`, which is a span this
  // function could not read. Losing them silently is the fail-open the whole function is a
  // correction of.
  const overlong = new Proxy([good], { get(t, k, r): unknown { return k === "length" ? 3 : Reflect.get(t, k, r); } });
  assert.deepEqual(reconstructGraph(overlong as Span[]).unreadableSpans, ["#1", "#2"]);
  assert.equal(reconstructGraph(overlong as Span[]).graphHash, "h", "…and the span that WAS there is still read");
});

test("`Array.isArray` IS NOT A TOTAL READ — a revoked `Proxy` throws, at all three call sites", () => {
  // The Traps list records the platform fact — `IsArray` follows a proxy to its target, and on
  // a REVOKED one the handler is `null`, so it throws `TypeError: Cannot perform 'IsArray' on a
  // proxy that has been revoked` (node v24.16.0). `readProp`'s docstring nonetheless named it
  // as one of the two ways this file reads an untrusted trace TOTALLY, which is the same
  // "un-forgeable and safe-to-ask are different properties" mistake `run/delivery.ts` paid for.
  // Three bare calls, three verdicts, all of which were a throw out of a VERIFICATION function
  // — neither certifying nor refusing:
  const revoked = (v: unknown): unknown => {
    const r = Proxy.revocable(v as object, {});
    r.revoke();
    return r.proxy;
  };

  // 1. the argument. Same verdict as anything else this function cannot walk.
  const arg = reconstructGraph(revoked([]) as Span[]);
  assert.deepEqual(arg.unreadableSpans, ["(unreadable)"]);
  assert.equal(conformsToGraph(arg, SPEC, "").ok, false);

  // 2. a claim's container. Same verdict as any other container that is not a list: ONE
  // unknown edge named by its shape — `typeof` is safe on a revoked proxy (it is fixed at
  // construction and consults no handler), so `idText` can still name it without asking it
  // anything.
  const claim = reconstructGraph(trace("h", { "node.id": "a", "edges.taken": revoked(["e1"]) }));
  assert.deepEqual(claim.edges, ["(object)"]);
  assert.equal(conformsToGraph(claim, SPEC, "h").ok, false, "an edge nobody declared must not certify");

  // 3. `conformsToGraph`'s own `unreadableSpans`, which is the one that ends in a verdict a
  // CI job reads.
  const handBuilt = conformsToGraph(
    { nodes: [], edges: [], graphHash: "", instances: [], unreadableSpans: revoked([]) as readonly string[] },
    SPEC,
    "",
  );
  assert.deepEqual(handBuilt.unreadableSpans, ["(unreadable)"]);
  assert.equal(handBuilt.ok, false, "a reconstruction this cannot read is one it may not certify");

  // AND `isList` IS NOT A GUARD FOR THE READ THAT FOLLOWS IT — the survivor a 252-combination
  // sweep found, and it was a sibling of the read the guard had just been added for.
  // `Array.isArray` unwraps a `Proxy` to its target, so a `Proxy` over `[]` whose every trap
  // throws is ACCEPTED as a list (it is one) and `unreadableSpans.length` in the `ok`
  // expression was then bare: `Error: trap get`, out of the CI assertion. Same verdict as any
  // other container that will not say how long it is.
  const trapped = new Proxy([] as string[], new Proxy({}, { get: () => () => { throw new Error("trap"); } }) as ProxyHandler<string[]>);
  assert.equal(Array.isArray(trapped), true, "…and it really does pass the list test, which is the whole trap");
  const opaqueList = conformsToGraph({ nodes: [], edges: [], graphHash: "", instances: [], unreadableSpans: trapped }, SPEC, "");
  assert.deepEqual(opaqueList.unreadableSpans, ["(unreadable)"]);
  assert.equal(opaqueList.ok, false, "a length it could not read certified the trace");
  // An honest empty list still certifies, so this is a totality fix and not a new refusal.
  assert.equal(conformsToGraph({ nodes: [], edges: [], graphHash: "", instances: [], unreadableSpans: [] }, SPEC, "").ok, true);
});

test("`shouldExport` DOES NOT THROW FOR ANY POLICY — its own `NOT A THROW` had a counterexample two lines down", () => {
  // The docstring argues the direction at length — "NOT A THROW … a throw here is an exporter
  // dying per run over a telemetry knob, which invariant 8 has an opinion about" — and then
  // reads `policy.headRatio` and `policy.alwaysKeep` bare, so the exact failure it rules out
  // was reachable with a getter. Reproduced before the fix, node v24.16.0:
  //
  //   { get headRatio() { throw } }   ⇒ Error: headRatio getter
  //   { get alwaysKeep() { throw } }  ⇒ Error: alwaysKeep getter
  //   policy = null                   ⇒ TypeError: Cannot read properties of null
  //   policy = a revoked Proxy        ⇒ TypeError: Cannot perform 'get' on a revoked proxy
  //
  // THE SCOPE IS THE POLICY AND NOT THE JOURNAL. `events` is the run's own log, and its
  // partial reads are REGISTER A18's one deliberate decision rather than twelve edits; this
  // claim is about the argument a DEPLOYMENT supplies, which is what the paragraph above is
  // about.
  const journal = [ev(1, "task.progress", { chunk: "x" }, { taskId: null })];
  const revoked = Proxy.revocable({ headRatio: 1 }, {});
  revoked.revoke();
  // LABELLED RATHER THAN INTERPOLATED: `String(revokedProxy)` throws too, so a message built
  // from the input would be a second copy of this defect inside its own test.
  const hostile: readonly (readonly [string, unknown])[] = [
    ["a throwing headRatio getter", { get headRatio(): number { throw new Error("headRatio getter"); }, alwaysKeep: false }],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a string", "0.5"],
    ["a revoked Proxy", revoked.proxy],
    ["a Proxy whose every get throws", new Proxy({}, { get(): never { throw new Error("get trap"); } })],
  ];
  // AN UNREADABLE RATIO EXPORTS, which is the direction the docstring already argues for a
  // ratio that is merely the wrong type — a knob that cannot be read is not a knob that was
  // set to zero.
  for (const [what, p] of hostile) {
    assert.equal(shouldExport(journal, p as { headRatio: number }), true, `${what}: an unreadable policy killed the exporter`);
  }

  // AN UNREADABLE `alwaysKeep` KEEPS THE TAIL RULES ON, because only the exact value `false`
  // turns them off and "I could not read it" is not that value. The safe direction is the
  // same one an absent field already takes.
  const gated = [ev(1, "gate.raised", { gateId: GATE }, { taskId: null })];
  assert.equal(
    shouldExport(gated, { headRatio: 0, get alwaysKeep(): boolean { throw new Error("alwaysKeep getter"); } } as { headRatio: number }),
    true,
    "an unreadable alwaysKeep silently disabled every tail rule",
  );
  // …and a readable one still decides, in both directions, so this is a totality fix and not
  // a knob quietly welded on.
  assert.equal(shouldExport(gated, { headRatio: 0, alwaysKeep: false }), false);
  assert.equal(shouldExport(gated, { headRatio: 0, alwaysKeep: true }), true);

  // THE LIMIT, HELD EXECUTABLE, on the `A Proxy DEFEATS THE SHAPE TEST` pattern: the claim is
  // about `policy` and NOT about `events`, and a sentence nobody can fail cannot be trusted to
  // stay narrow. `events` is the run's own journal and its reads are bare here exactly as they
  // are throughout `spansFrom` (REGISTER A18 — one decision, not twelve edits). Measured: 82
  // hostile policies × honest journals threw 0; the same policies against a `Proxy` over an
  // array threw on every one that reached the loop.
  const hostileJournal = new Proxy([] as JournalEvent[], {
    get(): never {
      throw new Error("the journal is trusted, not total");
    },
  });
  assert.throws(
    () => shouldExport(hostileJournal, { headRatio: 1, alwaysKeep: true }),
    /the journal is trusted, not total/,
    "if this stops throwing, `events` has been made total and the docstring's scope must widen with it",
  );
});

// ── the three QUIET partial reads: a wrong trace, not a failed one ────────────

test("A `ts` THAT IS NOT A NUMBER DOES NOT REORDER THE WATERFALL", () => {
  // `ts` went straight to `startTime`/`endTime`, and the span sort is
  // `a.startTime - b.startTime` — `NaN` for any non-number. `NaN` is falsy, so the
  // `|| (a.spanId < b.spanId ? -1 : 1)` tie-break fires and every pair involving the bad
  // span is ordered by a HASH. The comparator is intransitive, so it can reorder two
  // WELL-FORMED spans against each other too. Measured before the guard: a journal whose
  // `run.submitted` carried `ts: "x"` folded to `startTimes=[1020,"x"]`,
  // `order=loom.task,loom.run` — the run span, which starts first, sorted LAST.
  //
  // A trace is opened to find out what happened when. Being loud would cost the caller
  // every span for the run, which is what the twelve deliberately-left partial reads in
  // `spansFrom` already do; being WRONG costs an incident review.
  for (const junk of ["x", null, undefined, NaN, Infinity, {}, []]) {
    const bad = { ...submitted, ts: junk } as unknown as JournalEvent;
    const spans = spansFrom([bad, ready, raised, cancelledRun]);

    for (const s of spans) {
      assert.equal(typeof s.startTime, "number", `${s.name} startTime is ${String(s.startTime)}`);
      assert.ok(Number.isFinite(s.startTime), `${s.name} startTime is ${String(s.startTime)}`);
      assert.ok(s.endTime === undefined || Number.isFinite(s.endTime), `${s.name} endTime is ${String(s.endTime)}`);
    }
    // The run span starts first and must still sort first.
    assert.equal(spans[0]?.name, "loom.run", `with ts=${String(junk)} the waterfall reordered`);
    // …and it is placed at the first instant the journal ACTUALLY CLAIMS, not at the epoch.
    // Seeding `lastTs` at 0 would put the run — and every span before the first readable
    // `ts` — at 1970, which is a fabricated measurement rather than a missing one, and it
    // is finite, so the assertions above cannot see it. `ready` is the first readable event
    // in this fixture.
    assert.equal(spans[0]?.startTime, ready.ts, `with ts=${String(junk)} the run span was fabricated at the epoch`);
  }
});

test("A CLAIM THAT IS NOT A LIST IS ONE CLAIM, not an iterable to be split", () => {
  // `[...e.payload.edgesIn]` splits a STRING into characters: `edgesIn: "e1"` folded to
  // `"edges.in": ["e","1"]`, so `reconstructGraph` reported TWO ghost edges where the
  // journal claimed one — a FABRICATION, in the input to `conformsToGraph`, which is the
  // verdict a CI job reads. The same spread threw outright on `undefined`, `null` or a
  // number, costing the caller every span for the run.
  //
  // `reconstructGraph` in this same file already takes the correct verdict on exactly this
  // class ("a container that is not a list is ONE unknown edge"); the journal side did not.
  const readyWith = (edgesIn: unknown): JournalEvent =>
    ({ ...ready, payload: { nodeId: "approve", branchPath: "", edgesIn } }) as unknown as JournalEvent;

  const edgesOf = (edgesIn: unknown): unknown => {
    const task = spansFrom([submitted, readyWith(edgesIn), cancelledRun]).find((s) => s.name === "loom.task");
    assert.ok(task, "no loom.task span");
    return task.attributes["edges.in"];
  };

  assert.deepEqual(edgesOf(["e1", "e2"]), ["e1", "e2"], "an honest list is still a list");
  assert.deepEqual(edgesOf("e1"), ["e1"], "a string is ONE claim, not two characters");
  assert.deepEqual(edgesOf(undefined), ["undefined"], "…and an absent one does not cost the whole run its trace");
  assert.deepEqual(edgesOf(7), ["7"]);
  assert.deepEqual(edgesOf({ 0: "e1", length: 1 }), ["(object)"], "an array-like is not an array");

  // THE UNREADABLE CONTAINER IS RENDERED, NOT PASSED ON, and this half is what a fix that
  // stops at "do not spread it" gets wrong. Returning the value itself keeps the hostile
  // object, and the next reader is `redactAttributes`, whose `walk` calls `.map` on anything
  // `Array.isArray` accepts — so a `Proxy` over `[]` claiming `length: 2 ** 32 - 1` was
  // refused here and then walked there. This assertion HUNG the suite before the marker.
  const forged = new Proxy([] as unknown[], {
    get(t, k) {
      if (k === "length") return 2 ** 32 - 1;
      if (typeof k === "string" && /^\d+$/.test(k)) return "e1";
      return Reflect.get(t, k);
    },
  });
  assert.deepEqual(edgesOf(forged), ["(object)"], "a forged length was walked, here or downstream");
});

test("A runId THAT IS NOT A STRING DOES NOT TAKE THE WHOLE TRACE WITH IT", () => {
  // `digestOf` is `createHash().update(v, "utf8")` and throws `ERR_INVALID_ARG_TYPE` for a
  // non-string. It is LOUD, which is better than wrong — but it takes `shouldExport` with
  // it, so a malformed run id becomes a run nothing can decide about rather than a run that
  // is exported.
  for (const junk of [null, undefined, 42, {}]) {
    const bad = { ...submitted, runId: junk } as unknown as JournalEvent;
    const spans = spansFrom([bad]);
    assert.ok(spans.length > 0, `runId ${String(junk)} produced no spans at all`);
    assert.equal(typeof spans[0]!.traceId, "string");
    // A RATIO STRICTLY BETWEEN 0 AND 1, because `shouldExport` returns at `ratio >= 1` six
    // lines BEFORE it reads the run id. With `headRatio: 1` this assertion passed without
    // ever reaching the guard it is named for — an inert test, which is the failure this
    // file's own sweep is meant to catch.
    assert.equal(typeof shouldExport([bad], { headRatio: 0.5, alwaysKeep: false }), "boolean");
  }

  // …and the traceId is still DERIVED, which is the property the trace rests on: a constant
  // one merges two runs into a single waterfall.
  const a = spansFrom([{ ...submitted, runId: "run-a" } as unknown as JournalEvent])[0]!.traceId;
  const b = spansFrom([{ ...submitted, runId: "run-b" } as unknown as JournalEvent])[0]!.traceId;
  assert.notEqual(a, b);
});
