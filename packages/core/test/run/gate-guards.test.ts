/**
 * Guards nothing was holding.
 *
 * Each test here was written because the guard it covers could be DELETED and the whole
 * suite stayed green. That was established mechanically rather than by reading: revert one
 * condition, run every test, count the failures. Three came back zero, and all three are
 * refusals — the shape of code that decays silently, because deleting a refusal makes
 * things work rather than break, and the thing that then works is the thing the refusal
 * existed to stop.
 *
 * This programme has lost a guard that way twice. A rule with no test is a rule that
 * survives exactly until the next refactor finds it inconvenient.
 *
 * The two that started this file, both in `run/gates.ts`:
 *
 *   - `assertDefaultActionIsSatisfiable`'s mirror branch — a `defaultAction` is a decision
 *     arriving from the SLA instead of from a person, so every rule about which decisions
 *     a mirror can carry has to apply to it too.
 *   - `isAuthorizedActor`'s `kind === "human"` requirement — an approvers list names
 *     people, and `actorId` flattens all four actor kinds into one string space.
 *
 * The gate-lifecycle wave that followed added guards of its own, and the same sweep found
 * four more with nothing holding them — three of them parts of the very fix that wave
 * shipped. They are covered below, from "guard 3" on.
 *
 * See design/loom/04-OVERSIGHT.md D7.3–D7.4.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq, TaskId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type Actor, type JournalEvent, type NewEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { AppendInput, StateStore } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { RunFolder, foldRun } from "../../src/run/projection.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";

const RUN = "run_gate_guards" as RunId;
const CHILD_GATE = "gate_child_0000000000000000" as GateId;

const unauthorized = (e: unknown): true => {
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  assert.equal(e.code, CODES.E_GATE_NOT_AUTHORIZED, e.message);
  return true;
};

function rig(): { store: MemoryStateStore; log: RunLog; broker: HumanGateBroker; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  return { store, log: new RunLog(RUN, { store, now }), broker: new HumanGateBroker({ now }), clock };
}

const request = (over: Partial<GateRequest> = {}): GateRequest => ({
  runId: RUN,
  taskId: "delegate@root#0" as TaskId,
  nodeId: "delegate" as NodeId,
  policyRef: "subgraph:graph/charge@stable",
  payload: { subgraph: "graph/charge@stable" },
  ...over,
});

async function events(store: MemoryStateStore): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(RUN, 1)) out.push(e);
  return out;
}

// ── guard 1: a mirror's default action (gates.ts, assertDefaultActionIsSatisfiable) ──

test("A MIRROR'S DEFAULT ACTION CANNOT BE AN EDIT OR A REDIRECT, and it is refused at RAISE", async () => {
  // `#authorize` already refuses `edit` and `redirect` on a mirror when a human sends one:
  // `edit` names channels in the PARENT's namespace, which is exactly the set that forges
  // the delegated result, and `redirect` answers the parent's routing question while
  // leaving the child stranded. A `defaultAction` is the same decision arriving from the
  // SLA instead of from a person — pre-authorized at authoring time, applied with nobody
  // watching — so the rule has to reach it as well.
  //
  // At RAISE rather than at the deadline, because the alternative is discovering the
  // contradiction mid-incident: the sweep fires, the decision is refused, and the gate
  // expires with the run failing behind it. The author can see this one while authoring.
  const { store, log, broker } = rig();

  for (const bad of [
    { kind: "edit", writes: { result: { forged: true } } },
    { kind: "redirect", take: ["e1"] },
  ] as const) {
    await assert.rejects(
      () => broker.raise(log, request({ mirrorOf: CHILD_GATE, defaultAction: bad })),
      unauthorized,
      `a mirror accepted a ${bad.kind} default action`,
    );
  }

  assert.deepEqual(await events(store), [], "the gate was refused before anything became durable");

  // …and the two decisions that DO survive the trip into the other run are still allowed.
  const ok = await broker.raise(log, request({ mirrorOf: CHILD_GATE, defaultAction: { kind: "approve" } }));
  assert.ok(ok, "approve is a decision a mirror can carry");
  await broker.raise(log, request({ mirrorOf: CHILD_GATE, defaultAction: { kind: "reject", reason: "no" } }));

  // …and the same edit is fine on a gate that is NOT a mirror, which is what makes this a
  // rule about mirrors rather than a rule about default actions.
  await broker.raise(log, request({ defaultAction: { kind: "edit", writes: { result: 1 } }, allowEdit: ["result"] }));
});

// ── guard 2: only a human satisfies an approvers list (gates.ts, isAuthorizedActor) ──

const AGENT: Actor = { kind: "agent", profile: "summarizer", taskId: "delegate@root#0" as TaskId, model: "m" };
const CANDIDATE: Actor = { kind: "evolution", engineVersion: "1", candidate: "cand-7" };

test("AN AGENT NAMED IN AN APPROVERS LIST IS STILL NOT AN APPROVER", async () => {
  // An approvers list names PEOPLE. `actorId` flattens all four actor kinds into one
  // string space — `subject`, `profile`, `component`, `candidate` — so nothing prevents an
  // agent profile or an evolution candidate id from colliding with a subject id, whether
  // by accident or because somebody chose the collision. A model satisfying a human
  // approval is precisely the thing the gate exists to prevent, so the check is on the
  // actor's KIND and the name is only consulted afterwards.
  const { store, log, broker } = rig();
  const gateId = await broker.raise(log, request({ approvers: ["summarizer", "cand-7"] }));

  await assert.rejects(
    () => broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: AGENT, idempotencyKey: "a" }),
    unauthorized,
    "an agent whose profile IS in the approvers list approved a human gate",
  );
  await assert.rejects(
    () => broker.resolve(log, { gateId, decision: { kind: "approve" }, actor: CANDIDATE, idempotencyKey: "c" }),
    unauthorized,
    "the evolution engine approved a human gate",
  );

  const seq = await events(store);
  assert.equal(seq.some((e) => e.type === "gate.decided"), false, "and neither attempt reached the record as a decision");

  // …while a person of that name still gets through, so the rule is about the kind of
  // actor and not about the string.
  const ok = await broker.resolve(log, {
    gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "summarizer", via: "console" },
    idempotencyKey: "h",
  });
  assert.equal(ok.resolved, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate-lifecycle wave's own guards, found the same way
// ─────────────────────────────────────────────────────────────────────────────

const n = (id: string): NodeId => id as NodeId;
const ed = (id: string): EdgeId => id as EdgeId;
const alice: Actor = { kind: "human", subject: "u:alice", via: "console" };
const NOW = 1_700_000_000_000;

/**
 * Two open gates and a run that can be driven to `#finish` with one of them still open.
 *
 * The budget floor is what makes that reachable: `advance` re-suspends rather than
 * finishing while a gate is open, but the floor at the top of the loop reaches `#finish`
 * without passing that check. Which is exactly why `#finish`'s branches have to close
 * gates for themselves.
 */
function finishSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "finish-with-gates", project: "gate-guards", version: 1 },
    policy: { posture: "out", capabilities: [] },
    channels: {
      seed: { type: "number", reduce: "replace" },
      left: { type: "number", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["left"],
    nodes: [
      {
        id: n("work"),
        type: "function",
        reads: ["seed"],
        writes: ["left"],
        function: { ref: "function/work@stable" },
        retry: { maxAttempts: 1 },
      },
      { id: n("gateA"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/a@stable" } },
      { id: n("gateB"), type: "human_gate", reads: ["seed"], humanGate: { ref: "oversight/b@stable" } },
      { id: n("after"), type: "function", reads: ["seed"], function: { ref: "function/noop@stable" } },
    ],
    edges: [{ id: ed("ab"), from: n("gateA"), to: n("after"), kind: "seq" }],
  };
}

function finishEngine(opts: { workThrows?: boolean } = {}): { engine: Engine; store: MemoryStateStore } {
  const now = (): number => NOW;
  const store = new MemoryStateStore({ now });
  const functions = new FunctionRegistry();
  functions.register("function/work@stable", (view) => {
    if (opts.workThrows === true) throw new Error("the worker fell over");
    return { writes: { left: view.get<number>("seed") ?? 0 } };
  });
  functions.register("function/noop@stable", () => ({}));
  const engine = new Engine({
    store,
    tools: new ToolRegistry(),
    functions,
    models: new ModelRegistry(),
    now,
    resolver: resolver(),
    policy: { granted: ["*"], systemFloor: "out" },
  });
  return { engine, store };
}

async function runEvents(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

/** Park on two gates, then arm the budget floor so the next `advance` reaches `#finish`. */
async function parkedOnTwoGates(engine: Engine, store: MemoryStateStore, extra: readonly NewEvent[] = []) {
  const graph = compileOrThrow({ spec: finishSpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { seed: 7 } });
  const p = await engine.advance(runId);
  const open = Object.values(p.gates)
    .filter((g) => g.state === "open")
    .sort((a, b) => a.raisedAtSeq - b.raisedAtSeq);
  assert.equal(open.length, 2, "the shape under test: two gates open at once");

  await new RunLog(runId, { store, now: () => NOW }).append([
    ...extra,
    {
      type: "budget.exhausted",
      payload: { scope: `run:${runId}`, limitUsd: 0, action: "fail" },
      actor: SYSTEM_ACTOR("policy"),
    },
  ]);
  return { runId, open };
}

// ── guard 3: #finish closes gates on the FAN-OUT UNDERFLOW branch ────────────

test("A RUN THAT DIES OF AN UNMATERIALISED FAN-OUT STILL CLOSES ITS GATES", async () => {
  // `#finish` has four exits and each appends its own terminal event, so "close the gates"
  // is a rule each one has to carry rather than a step on a shared path. This is the exit
  // furthest from anybody's attention — the safety net for lazy materialisation, reached
  // only when a top-up was missed — and it was the one that could be deleted with the whole
  // suite staying green.
  const { engine, store } = finishEngine();
  const { runId, open } = await parkedOnTwoGates(engine, store, [
    {
      type: "fanout.planned",
      payload: { edgeId: "e-phantom", parentBranch: "root", nodeId: n("after"), width: 3 },
      actor: SYSTEM_ACTOR("scheduler"),
    },
  ]);

  const done = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a",
  });

  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /planned 3 branches but only 0/, "the exit under test really is the one taken");
  assert.equal(done.gates[open[1]!.gateId]?.state, "cancelled", "THE SURVIVING GATE WAS CLOSED WITH THE RUN");
  assert.deepEqual(await engine.openGates(runId), []);

  const seq = await runEvents(store, runId);
  const iClosed = seq.findIndex((ev) => ev.type === "gate.cancelled");
  const iRun = seq.findIndex((ev) => ev.type === "run.failed");
  assert.ok(iClosed >= 0 && iRun === iClosed + 1, "one durable fact: the gates, then the run");
});

// ── guard 4: #finish closes gates on the FAILED-TASK branch ──────────────────

test("A RUN THAT DIES OF A FAILED TASK STILL CLOSES ITS GATES", async () => {
  // The commonest exit of the four, and it had no test either. The `E_OUTPUT_MISSING` exit
  // did — which is how three of these came to look covered: one test on one branch reads
  // like a test on the rule.
  const { engine, store } = finishEngine({ workThrows: true });
  const { runId, open } = await parkedOnTwoGates(engine, store);

  const done = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a",
  });

  assert.equal(done.status, "failed");
  assert.match(done.error?.message ?? "", /the worker fell over/, "the exit under test really is the one taken");
  assert.equal(done.gates[open[1]!.gateId]?.state, "cancelled", "THE SURVIVING GATE WAS CLOSED WITH THE RUN");
  assert.deepEqual(await engine.openGates(runId), []);
});

// ── guard 5: a gate with no Task is not closed in a Task's name ──────────────

const ORPHAN = "gate_orphan_000000000000000" as GateId;

test("A GATE RAISED WITHOUT A TASK IS NOT CLOSED IN A TASK'S NAME", async () => {
  // `gate.raised` folds a missing `taskId` to `""`, and `cancelOpenGates` reads it straight
  // back out. Passing it on would journal `taskId: ""` — an event attributed to a Task that
  // does not exist, in the record an incident is reconstructed from, and one that every
  // `if (e.taskId)` in the codebase silently treats as "no task" anyway. Attributing the
  // closure to nothing is honest; attributing it to a Task named by the empty string is not.
  const { engine, store } = finishEngine();
  const graph = compileOrThrow({ spec: finishSpec(), resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const runId = await engine.submit({ graph, inputs: { seed: 7 } });
  await engine.advance(runId);

  // A gate carrying no `taskId` — the shape a subgraph mirror or an older build can write.
  await new RunLog(runId, { store, now: () => NOW }).append([
    {
      type: "gate.raised",
      payload: {
        gateId: ORPHAN,
        nodeId: n("gateA"),
        policyRef: "oversight/orphan@stable",
        contentDigest: "sha256:0",
      },
      actor: SYSTEM_ACTOR("gate-broker"),
    },
  ]);
  assert.equal((await engine.projection(runId))!.gates[ORPHAN]?.taskId, "", "the shape under test");

  await engine.cancel(runId, "stop");

  const closures = (await runEvents(store, runId)).filter((ev) => ev.type === "gate.cancelled");
  const orphanClosure = closures.find((ev) => (ev.payload as { gateId: GateId }).gateId === ORPHAN);
  assert.ok(orphanClosure !== undefined, "the orphan gate was closed with the run");
  assert.equal(orphanClosure.taskId, undefined, "…and its closure names no Task rather than the empty one");
  assert.ok(
    closures.some((ev) => typeof ev.taskId === "string" && ev.taskId.length > 0),
    "while a gate that DOES belong to a Task is still attributed to it",
  );
});

// ── guard 6: gate.cancelled does not retract a decision (projection.ts) ──────

test("A RUN-WIDE CANCEL DOES NOT RETRACT A DECISION A HUMAN ALREADY GAVE", async () => {
  // `gate.cancelled` folds only from `open`, because D7.3's other three states are terminal
  // for the gate. Without that, a cancel arriving after an approval overwrote `decided` in
  // the read model while `gate.decided` sat in the journal saying otherwise — the two halves
  // of the audit record disagreeing about whether a person answered.
  const store = new MemoryStateStore({ now: () => NOW });
  const log = new RunLog(RUN, { store, now: () => NOW });
  const broker = new HumanGateBroker({ now: () => NOW });

  await log.append([{ type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("scheduler") }]);
  const decided = await broker.raise(log, request({ taskId: "one@root#0" as TaskId }));
  const expired = await broker.raise(log, request({ taskId: "two@root#0" as TaskId }));
  await broker.resolve(log, { gateId: decided, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k" });
  await log.append([
    { type: "gate.timeout", payload: { gateId: expired, action: "fail" }, actor: SYSTEM_ACTOR("gate-broker") },
  ]);

  // The cancel arrives afterwards and names every gate, as a broad sweep would.
  await log.append([
    { type: "gate.cancelled", payload: { gateId: decided, reason: "the run was cancelled" }, actor: SYSTEM_ACTOR("operator") },
    { type: "gate.cancelled", payload: { gateId: expired, reason: "the run was cancelled" }, actor: SYSTEM_ACTOR("operator") },
  ]);

  const events: JournalEvent[] = [];
  for await (const ev of store.read(RUN, 1)) events.push(ev);
  const p = foldRun(events)!;
  assert.equal(p.gates[decided]?.state, "decided", "THE APPROVAL STANDS — a cancel does not unmake it");
  assert.equal(p.gates[decided]?.decision, "approve");
  assert.equal(p.gates[expired]?.state, "expired", "and neither does it unmake a deadline that really passed");
});

// ── guard 7: a rejection carries a reason ────────────────────────────────────

test("A REJECTION WITHOUT A REASON IS NOT A REJECTION", async () => {
  // The one label in the whole system that is worth more than the decision itself: `reject`
  // is the highest-quality signal the evolution loop ever gets (D10.b, S2), and a blank
  // justification makes the record say a person refused without saying what they refused.
  // Whitespace counts as blank, which is the half that decays first.
  const { store, log, broker } = rig();
  const gateId = await broker.raise(log, request());

  for (const reason of ["", "   ", "\n\t "]) {
    await assert.rejects(
      () => broker.resolve(log, { gateId, decision: { kind: "reject", reason }, actor: alice, idempotencyKey: `r${reason}` }),
      (e: unknown): true => {
        assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
        assert.equal(e.code, CODES.E_HUMAN_APPROVAL_REQUIRED, e.message);
        return true;
      },
      `a rejection whose reason is ${JSON.stringify(reason)} was recorded`,
    );
  }

  assert.equal((await events(store)).some((e) => e.type === "gate.decided"), false, "nothing reached the record");

  const ok = await broker.resolve(log, {
    gateId,
    decision: { kind: "reject", reason: "it names a customer" },
    actor: alice,
    idempotencyKey: "r-ok",
  });
  assert.equal(ok.resolved, true, "…while a reason that says something still goes through");
});

// ── guard 8: one gate must not switch off its run's whole SLA ────────────────

/** A store that refuses exactly one gate's timeout append, and serves every other write. */
function refusingTimeoutFor(inner: MemoryStateStore, gateId: GateId): StateStore {
  return {
    append: (input: AppendInput) => {
      const hit = input.events.some(
        (ev) => ev.type === "gate.timeout" && (ev.payload as { gateId?: GateId }).gateId === gateId,
      );
      if (hit) return Promise.reject(new Error("the store is not accepting writes"));
      return inner.append(input);
    },
    read: (runId, fromSeq, toSeq) => inner.read(runId, fromSeq, toSeq),
    head: (runId) => inner.head(runId),
    listRuns: (limit?: number) => inner.listRuns(limit),
    close: () => inner.close(),
  };
}

test("ONE GATE THAT CANNOT BE EXPIRED DOES NOT SWITCH OFF ITS RUN'S WHOLE SLA", async () => {
  // `sweepTimeouts` is a RUN-WIDE loop, so a throw inside it used to mean every gate behind
  // the failing one stopped expiring as well — and the same gate threw again on every later
  // sweep, so the loss was permanent rather than transient. One unwritable gate, and a run's
  // entire fail-closed path was gone.
  const clock = { t: 1_000_000 };
  const inner = new MemoryStateStore({ now: () => clock.t });
  const seed = new RunLog(RUN, { store: inner, now: () => clock.t });
  await seed.append([{ type: "run.started", payload: { posture: "out" }, actor: SYSTEM_ACTOR("scheduler") }]);

  const broker = new HumanGateBroker({ now: () => clock.t });
  const stuck = await broker.raise(new RunLog(RUN, { store: inner, now: () => clock.t }), {
    ...request({ taskId: "stuck@root#0" as TaskId }),
    slaMs: 60_000,
    onTimeout: "fail",
  });
  const behind = await broker.raise(new RunLog(RUN, { store: inner, now: () => clock.t }), {
    ...request({ taskId: "behind@root#0" as TaskId }),
    slaMs: 60_000,
    onTimeout: "fail",
  });

  const log = new RunLog(RUN, { store: refusingTimeoutFor(inner, stuck), now: () => clock.t });
  clock.t += 120_000;
  const fired = await broker.sweepTimeouts(log);

  assert.deepEqual(fired, [behind], "THE GATE BEHIND THE UNWRITABLE ONE STILL EXPIRED");
  const p = (await broker.project(log))!;
  assert.equal(p.gates[stuck]?.state, "open", "…and the one that could not be written is simply still open");
  assert.equal(p.status, "failed", "the run failed closed, which is the whole point of an SLA");
});

// ── guard 9: the fold's "only from `open`" arms, now that no appender reaches them ──

/**
 * A hand-written journal, because `src/` cannot produce one any more.
 *
 * The `gate.timeout` and `gate.escalated` arms in `projection.ts` are the LAST line on a
 * hazard whose first line is now `#commitForOpenGate`: the broker re-reads the gate and
 * compare-and-swaps on the seq, so a decision that beats its deadline stops the expiry at
 * the appender. That is the right place for it — invariant 2 says the journal is
 * authoritative, so refusing to WRITE the contradiction beats refusing to read it — but it
 * leaves the fold guards with no route through `src/` at all.
 *
 * They still matter for two reasons, which is why they stay and why this test exists: a
 * store written by an older build contains exactly the split the fix now prevents, and a
 * fold that trusted event order would read those journals as "approved, then expired".
 * Reverting either `g?.state === "open"` conjunct used to leave the entire suite green.
 */
function journal(
  ...rows: readonly { type: string; payload: unknown; ts?: number; taskId?: string }[]
): JournalEvent[] {
  return rows.map(
    (r, i) =>
      ({
        runId: RUN,
        seq: (i + 1) as Seq,
        ts: r.ts ?? 1_000_000 + i,
        type: r.type,
        payload: r.payload,
        actor: SYSTEM_ACTOR("test"),
        ...(r.taskId === undefined ? {} : { taskId: r.taskId }),
        classification: "internal",
      }) as unknown as JournalEvent,
  );
}

const RAISED = {
  type: "gate.raised",
  payload: { gateId: CHILD_GATE, nodeId: "delegate", policyRef: "p", contentDigest: "d", slaMs: 1000 },
};

test("A DECISION ALREADY IN THE JOURNAL IS NOT RETRACTED BY A LATER TIMEOUT", () => {
  const p = foldRun(
    journal(
      { type: "run.started", payload: { posture: "out" } },
      RAISED,
      { type: "gate.decided", payload: { gateId: CHILD_GATE, decision: "approve", latencyMs: 5 } },
      { type: "gate.timeout", payload: { gateId: CHILD_GATE, action: "fail" } },
    ),
  )!;
  assert.equal(p.gates[CHILD_GATE]?.state, "decided", "the human answered; a clock arriving afterwards does not undo it");
  assert.equal(p.gates[CHILD_GATE]?.decision, "approve");
});

test("…and neither is an EXPIRY retracted by a later decision, in the other direction", () => {
  const p = foldRun(
    journal(
      { type: "run.started", payload: { posture: "out" } },
      RAISED,
      { type: "gate.timeout", payload: { gateId: CHILD_GATE, action: "fail" } },
      { type: "gate.decided", payload: { gateId: CHILD_GATE, decision: "approve", latencyMs: 5 } },
    ),
  )!;
  assert.equal(p.gates[CHILD_GATE]?.state, "expired", "whichever transition landed FIRST is the one that happened");
  assert.equal(p.gates[CHILD_GATE]?.decision, undefined);
});

test("a gate.timeout{default_action} is NOT an expiry, so the decision behind it still lands", () => {
  // The one `gate.timeout` action that must fall through: the clock ran out and the gate's
  // pre-authorized default is about to decide it. Expiring here would make the broker's own
  // follow-up `resolve` collide with E_GATE_ALREADY_RESOLVED and abort the sweep.
  const p = foldRun(
    journal(
      { type: "run.started", payload: { posture: "out" } },
      RAISED,
      { type: "gate.timeout", payload: { gateId: CHILD_GATE, action: "default_action" } },
      { type: "gate.decided", payload: { gateId: CHILD_GATE, decision: "approve", latencyMs: 5 } },
    ),
  )!;
  assert.equal(p.gates[CHILD_GATE]?.state, "decided");
});

test("A NUDGE FOLDED ONTO A GATE THAT IS NO LONGER OPEN COUNTS FOR NOTHING", () => {
  // The `gate.reminded` arm's `open` conjunct, which is the same rule as the three above
  // and reachable the same way — `#commitForOpenGate` refuses to WRITE one onto a closed
  // gate, so only a hand-written log carries the shape. What it would say is that the SLA
  // nudged somebody about a question that had already been answered, which is the same
  // false story the `gate.timeout` arm refuses one row over.
  const p = foldRun(
    journal(
      { type: "run.started", payload: { posture: "out" } },
      RAISED,
      { type: "gate.reminded", payload: { gateId: CHILD_GATE, tier: 0, nth: 0 } },
      { type: "gate.decided", payload: { gateId: CHILD_GATE, decision: "approve", latencyMs: 5 } },
      { type: "gate.reminded", payload: { gateId: CHILD_GATE, tier: 0, nth: 1 } },
    ),
  )!;
  assert.equal(p.gates[CHILD_GATE]?.state, "decided");
  assert.equal(p.gates[CHILD_GATE]?.remindersSent, 1, "the nudge sent while it was open, and no other");

  // AND IT MOVES NOTHING ELSE, which is the difference between a reminder and an
  // escalation, checked rather than asserted in a docstring: same deadline, same tier.
  const open = foldRun(
    journal(
      { type: "run.started", payload: { posture: "out" } },
      { ...RAISED, payload: { ...RAISED.payload, deadline: 1_001_000 } },
      { type: "gate.reminded", payload: { gateId: CHILD_GATE, tier: 0, nth: 0 } },
      { type: "gate.reminded", payload: { gateId: CHILD_GATE, tier: 0, nth: 1 } },
    ),
  )!;
  assert.equal(open.gates[CHILD_GATE]?.state, "open");
  assert.equal(open.gates[CHILD_GATE]?.tier, 0);
  assert.equal(open.gates[CHILD_GATE]?.deadline, 1_001_000, "a nudge is not an extension");
  assert.equal(open.gates[CHILD_GATE]?.remindersSent, 2, "counted per ROW, so an unreadable `nth` cannot corrupt it");
});

// ── guard 10: four fold guards a 37-mutation sweep found nothing holding ─────
//
// Found the way the register's own habit prescribes: revert one condition at a time and
// count what turns red. Each of the four below left the ENTIRE suite green when reverted,
// which is what "covered" turns out to mean when nobody checks. They are all in the fold,
// and they are all about a journal `src/` cannot write — which is exactly the class this
// file exists for, since a store written by an older build, by a hand, or by another
// implementation is the input a projection cannot refuse to read.

const GUARD_TASK = "delegate@root#0";

test("A GATE ID THAT NAMES `__proto__` IS DROPPED, AND ITS TASK IS NOT PARKED BEHIND IT", () => {
  // `p.gates["__proto__"] = record` does not add a gate: it REPLACES the map's prototype.
  // Nothing in `src/` can mint such an id — `newGateId` is derived from a timestamp — so
  // this is about a journal written by hand or by something else, and the tolerant reading
  // is to drop the row rather than corrupt the map it cannot join.
  //
  // THE VISIBLE HALF IS THE TASK, which is why reverting either half of this guard used to
  // turn nothing red: `freeze` spreads `p.gates` into a fresh object on the way out, so the
  // prototype damage never reaches a caller. The `gate.raised` arm's LAST line does reach
  // one — it marks the Task `awaiting_gate` — so without the drop the fold produced a Task
  // suspended on a gate that is in no map: nothing to answer, nothing to time out, and a
  // scheduler that will never look at it again.
  const p = foldRun(
    journal(
      { type: "run.started", payload: { posture: "out" } },
      { type: "task.ready", payload: { nodeId: "delegate", branchPath: "root", edgesIn: [] }, taskId: GUARD_TASK },
      {
        type: "gate.raised",
        payload: { gateId: "__proto__", nodeId: "delegate", policyRef: "p", contentDigest: "d" },
        taskId: GUARD_TASK,
      },
    ),
  )!;

  assert.deepEqual(Object.keys(p.gates), [], "no gate was recorded");
  assert.equal(Object.getPrototypeOf(p.gates), Object.prototype, "…and the map is still an ordinary map");
  assert.equal(p.tasks[GUARD_TASK as never]?.state, "ready", "AND THE TASK IS NOT PARKED ON A GATE NOBODY CAN ANSWER");
});

test("AN ESCALATION FOR A GATE NOBODY RAISED IS DROPPED, not turned into one", () => {
  // The fold is tolerant by design — an event referring to something it has never seen makes
  // a minimal record rather than throwing — and gates are the ONE place that tolerance must
  // not extend to inventing the record, because a gate is a permission. Without this guard
  // the spread of an absent gate produced `{tier, deadline}`: a gate with no approvers, no
  // `allowEdit` and no state, which `#authorize` reads as "this gate names nobody".
  const p = foldRun(
    journal(
      { type: "run.started", payload: { posture: "out" } },
      { type: "gate.escalated", payload: { gateId: CHILD_GATE, tier: 2, to: "role:director", deadline: 9 } },
    ),
  )!;
  assert.deepEqual(Object.keys(p.gates), [], "an escalation is not a raise");
});

test("A REWIND MARKER WITH NO NUMERIC RANGE DECLARES NOTHING, IN BOTH FOLDS", () => {
  // `foldRun` suppresses nothing for a marker whose `atSeq` is not a number, so the
  // incremental folder must not go stale for one either — or an incremental reader and a
  // full reader answer differently about the same journal, permanently, and the sweeper's
  // `while (folder.stale)` loop re-folds from seq 1 on every tick for the rest of the run's
  // life.
  const evs = journal(
    { type: "run.started", payload: { posture: "out" } },
    RAISED,
    { type: "checkpoint.restored", payload: { checkpointId: "cp_x", mode: "rewind", atSeq: "oops" } },
    { type: "gate.decided", payload: { gateId: CHILD_GATE, decision: "approve", latencyMs: 1 } },
  );

  const folder = new RunFolder();
  folder.push(evs);
  assert.equal(folder.stale, false, "a marker that hides nothing is not a reason to start over");
  assert.equal(folder.projection()?.gates[CHILD_GATE]?.state, "decided", "…and the fold reached the head");
  assert.equal(foldRun(evs)?.gates[CHILD_GATE]?.state, "decided", "THE TWO FOLDS AGREE, which is the whole rule");
});

test("THE INCREMENTAL FOLD IS IDEMPOTENT UNDER A RE-PUSHED TAIL", () => {
  // `RunFolder.push` skips an event whose seq it has already folded. Every caller in `src/`
  // reads from `lastSeq + 1`, so nothing exercises it — and the day one overlaps by a single
  // event, the guard is all that stands between the journal and a projection that has
  // counted a Task's usage twice. `usage` is the accumulating field, so it is the one that
  // shows: everything else in the fold is an assignment and would look identical.
  const evs = journal(
    { type: "run.started", payload: { posture: "out" } },
    {
      type: "task.committed",
      payload: {
        status: "succeeded",
        take: [],
        writes: {},
        attempt: 1,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.25, wallMs: 1 },
      },
      taskId: GUARD_TASK,
    },
  );

  const folder = new RunFolder();
  folder.push(evs);
  folder.push(evs); // the same tail, a second time
  const p = folder.projection()!;

  assert.equal(p.usage.costUsd, 0.25, "ONE commit, counted once");
  assert.deepEqual(p.usage, foldRun(evs)!.usage, "…and the incremental fold agrees with the full one");
});
