/**
 * The acceptance set: what a gate may be answered WITH.
 *
 * `GateDecision` is a four-member union and everything downstream branches on
 * `kind === "reject"`, so for the length of this build every kind the union did NOT name
 * fell through to the permissive reading. Driven against `Engine.resolveGate` — the
 * public, pinned-surface method an embedder calls — one fresh skeleton run each, the last
 * column being whether the `fs.write` BEHIND the gate really ran:
 *
 *     {"kind":"approve"}  → run=succeeded writes=1  gate.decided decision="approve"
 *     {"kind":"REJECT"}   → run=succeeded writes=1  gate.decided decision="REJECT"
 *     {"kind":"nope"}     → run=succeeded writes=1  gate.decided decision="nope"
 *     {}                  → run=succeeded writes=1  gate.decided with NO decision field
 *     42                  → run=succeeded writes=1  gate.decided with NO decision field
 *     {"kind":"redirect"} → run=succeeded writes=1  (no `take` at all)
 *
 * An operator's caps-lock was an approval, and the journal kept `decision: "REJECT"`
 * beside an action that happened — a word in no vocabulary, recorded as the thing a human
 * decided. The three doors in front of the broker each validated the union themselves
 * (`checkedDecision`, `ownedDecision`, and `run/replay.ts`'s switch, whose `default:` arm
 * answered `{kind:"approve"}`); the broker every one of them feeds validated it nowhere.
 * Three guard chains for one union is what invariant 6 forbids, and a door is not a guard:
 * the next route added is one nobody copied the switch into.
 *
 * So the tests below drive the BROKER and the ENGINE, not the doors. `vocab.ts`'s
 * `gateDecisionOf` is the one statement of the set; each door keeps only what is genuinely
 * its own, and those parts are pinned where they live.
 *
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import type { GateId, NodeId, RunId, TaskId } from "../../src/ids.ts";
import type { Actor, JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { StateStore } from "../../src/journal/store.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { gateOf } from "../../src/run/projection.ts";
import { replayRun } from "../../src/run/replay.ts";
import { gateDecisionOf, type GateDecision } from "../../src/vocab.ts";
import { DOCS, compileSkeleton, harness } from "./skeleton.ts";

const alice: Actor = { kind: "human", subject: "u:alice", via: "console" };

const refused = (code: string) => (e: unknown): true => {
  assert.ok(isLoomError(e), `expected a LoomError, got ${String(e)}`);
  assert.equal(e.code, code, e.message);
  return true;
};

async function events(store: StateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) out.push(ev);
  return out;
}

/** The skeleton, parked on its `approve` gate with the guarded write still ahead of it. */
async function parked(): Promise<{
  h: ReturnType<typeof harness>;
  runId: RunId;
  gateId: GateId;
}> {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  assert.equal(h.writes.length, 0, "the guarded write is still ahead of the gate");
  return { h, runId, gateId: Object.values(p.gates).find((g) => g.state === "open")!.gateId };
}

/**
 * Every shape that used to approve. `null` and `undefined` are deliberately absent: they
 * threw a bare `TypeError` out of `#validate` reading `.kind` rather than approving, which
 * is a different (and already loud) failure.
 */
const NOT_DECISIONS: readonly (readonly [string, unknown])[] = [
  ["an operator's caps-lock", { kind: "REJECT" }],
  ["a word in no vocabulary", { kind: "nope" }],
  ["a decision naming no kind", {}],
  ["a number", 42],
  ["a string", "reject"],
  ["an array", ["approve"]],
  ["a redirect with no `take`", { kind: "redirect" }],
  ["an edit with no `writes`", { kind: "edit" }],
  ["a rejection whose reason is not a string", { kind: "reject", reason: 7 }],
  ["a redirect whose `take` holds a non-string", { kind: "redirect", take: ["e1", 2] }],
  ["an edit whose `writes` is an array", { kind: "edit", writes: ["merged"] }],
];

// ─────────────────────────────────────────────────────────────────────────────
// the headline: the engine, and the action behind the gate
// ─────────────────────────────────────────────────────────────────────────────

test("A DECISION IN NO VOCABULARY IS REFUSED, NOT READ AS AN APPROVAL", async () => {
  // One fresh run per shape, because the point is what happens to the RUN — a shared run
  // would let the first refusal's "gate is still open" carry the rest of the assertions.
  for (const [what, decision] of NOT_DECISIONS) {
    const { h, runId, gateId } = await parked();

    await assert.rejects(
      () =>
        h.engine.resolveGate(runId, {
          gateId,
          decision: decision as GateDecision,
          actor: alice,
          idempotencyKey: "a1",
        }),
      refused(CODES.E_HUMAN_APPROVAL_REQUIRED),
      `${what} was accepted as a decision`,
    );

    const after = (await h.engine.projection(runId))!;
    assert.equal(after.status, "awaiting_gate", `${what}: the run moved`);
    assert.equal(Object.values(after.gates).filter((g) => g.state === "open").length, 1, `${what}: the gate closed`);
    assert.equal(h.writes.length, 0, `${what}: THE ACTION BEHIND THE GATE RAN`);
    assert.equal(
      (await events(h.store, runId)).some((ev) => ev.type === "gate.decided"),
      false,
      `${what}: the journal recorded it as something a human decided`,
    );
  }
});

test("…and the four that ARE decisions still work, so this is a vocabulary and not a wall", async () => {
  const approved = await parked();
  const p = await approved.h.engine.resolveGate(approved.runId, {
    gateId: approved.gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "a1",
  });
  assert.equal(p.status, "succeeded");
  assert.equal(approved.h.writes.length, 1, "an approval runs the action behind the gate");

  const rejected = await parked();
  const q = await rejected.h.engine.resolveGate(rejected.runId, {
    gateId: rejected.gateId,
    decision: { kind: "reject", reason: "the summary is wrong" },
    actor: alice,
    idempotencyKey: "r1",
  });
  assert.equal(q.status, "failed");
  assert.equal(rejected.h.writes.length, 0);

  const edited = await parked();
  const r = await edited.h.engine.resolveGate(edited.runId, {
    gateId: edited.gateId,
    decision: { kind: "edit", writes: { merged: { markdown: "the corrected summary" } } },
    actor: alice,
    idempotencyKey: "e1",
  });
  assert.equal(r.status, "succeeded");
  assert.deepEqual(r.channels["merged"], { markdown: "the corrected summary" }, "an edit writes what the human wrote");
  assert.equal(edited.h.writes[0]?.body, "the corrected summary", "…and the action behind the gate uses it");
});

// ─────────────────────────────────────────────────────────────────────────────
// the same set, asked of the guard directly
// ─────────────────────────────────────────────────────────────────────────────

test("gateDecisionOf ANSWERS undefined FOR EVERYTHING OUTSIDE THE UNION, and never throws", () => {
  for (const [what, v] of NOT_DECISIONS) {
    assert.equal(gateDecisionOf(v), undefined, `${what} was read as a decision`);
  }
  for (const v of [null, undefined, Symbol("x"), 0n, () => "approve"]) {
    assert.equal(gateDecisionOf(v), undefined, `${String(v)} was read as a decision`);
  }

  assert.deepEqual(gateDecisionOf({ kind: "approve" }), { kind: "approve" });
  assert.deepEqual(gateDecisionOf({ kind: "reject", reason: "no" }), { kind: "reject", reason: "no" });
  // The SHAPE only: an empty reason is a string, and "a rejection requires a reason" is a
  // policy each door states at its own point of use.
  assert.deepEqual(gateDecisionOf({ kind: "reject", reason: "" }), { kind: "reject", reason: "" });
  assert.deepEqual(gateDecisionOf({ kind: "edit", writes: { a: 1 } }), { kind: "edit", writes: { a: 1 } });
  assert.deepEqual(gateDecisionOf({ kind: "redirect", take: ["e1"] }), { kind: "redirect", take: ["e1"] });
  assert.deepEqual(gateDecisionOf({ kind: "approve", reason: "why not" }), { kind: "approve" }, "approve carries no reason");
});

test("A HOSTILE DECISION COSTS THE DECISION, NEVER THE PROCESS", () => {
  // One of the callers is the UNAUTHENTICATED callback route, where the value comes from a
  // vendor adapter. Every read is through a total accessor, so a trap is a refusal.
  const throwing = <T extends string>(field: T): unknown =>
    new Proxy({ kind: "approve" } as Record<string, unknown>, {
      get(t, k) {
        if (k === field) throw new Error(`${field} getter`);
        return t[k as string];
      },
    });

  assert.equal(gateDecisionOf(throwing("kind")), undefined, "a throwing `kind` is not an approval");
  assert.deepEqual(gateDecisionOf(throwing("reason")), { kind: "approve" }, "a throwing `reason` costs the reason");

  const revoked = Proxy.revocable({ kind: "redirect", take: ["e1"] }, {});
  revoked.revoke();
  assert.equal(gateDecisionOf(revoked.proxy), undefined, "a revoked proxy is refused, not thrown out of");

  // An ordinary array can carry an accessor at index 0 — `Array.isArray` says nothing
  // about whether reading the elements is safe.
  const hostileTake: unknown[] = [];
  Object.defineProperty(hostileTake, 0, {
    enumerable: true,
    get() {
      throw new Error("element getter");
    },
  });
  assert.equal(gateDecisionOf({ kind: "redirect", take: hostileTake }), undefined);
});

test("A `take` IS WALKED BY INDEX UNDER A BOUNDED LENGTH, never through the caller's iterator", () => {
  // `Array.isArray` answers for the target's exotic-array-ness and says NOTHING about
  // `Symbol.iterator`, which is an ordinary own property a caller may replace. A `for…of`
  // therefore drove an iterator the caller wrote, with no element cap — measured under
  // `--max-old-space-size=96`, an array carrying its own infinite `Symbol.iterator` exited
  // 134 with "JavaScript heap out of memory". An OOM is not catchable, so the `try` this
  // function's contract rests on did not hold, on a path one of whose callers is the
  // UNAUTHENTICATED callback route.
  // A forged `length` is checked FIRST and with a small number, deliberately: it is the
  // assertion that distinguishes bounded from unbounded in microseconds. `MAX_TAKE` is 4096
  // and module-private, so the literal is spelled here — if the cap moves, this moves.
  const forged = (length: number): unknown =>
    new Proxy([] as unknown[], {
      get(t, k) {
        if (k === "length") return length;
        if (typeof k === "string" && /^\d+$/.test(k)) return "e1";
        return Reflect.get(t, k);
      },
    });
  assert.equal(gateDecisionOf({ kind: "redirect", take: forged(4097) }), undefined, "a `take` past the cap was walked");
  assert.equal(
    (gateDecisionOf({ kind: "redirect", take: forged(4096) }) as { take: string[] } | undefined)?.take.length,
    4096,
    "…and the cap itself is legal",
  );

  // THE INDICES, NOT THE ITERATOR. An array's `Symbol.iterator` is an ordinary own property
  // a caller may replace, and `Array.isArray` says nothing about it — so `for…of` reads
  // values the indices do not hold. Honest `length`, lying iterator:
  const lying = ["e1", "e2"];
  Object.defineProperty(lying, Symbol.iterator, {
    value: function* (): Generator<string> {
      yield "e-elsewhere";
    },
  });
  assert.deepEqual(
    gateDecisionOf({ kind: "redirect", take: lying }),
    { kind: "redirect", take: ["e1", "e2"] },
    "the caller's iterator was consulted instead of the indices",
  );

  // …and an ordinary redirect still works, so the cap bounds a hostile value, not an author.
  const real = Array.from({ length: 64 }, (_, i) => `e${i}`);
  assert.deepEqual(gateDecisionOf({ kind: "redirect", take: real }), { kind: "redirect", take: real });
});

test("A `take` ELEMENT IS READ ONCE, so the value checked is the value kept", () => {
  // A getter that answers a legal edge id and then something else would otherwise pass the
  // check and ship the second answer into `gate.decided`'s payload.
  let n = 0;
  const flipping: unknown[] = [];
  Object.defineProperty(flipping, 0, {
    enumerable: true,
    get: () => (n++ === 0 ? "e1" : "e-elsewhere"),
  });
  assert.deepEqual(gateDecisionOf({ kind: "redirect", take: flipping }), { kind: "redirect", take: ["e1"] });
});

// ─────────────────────────────────────────────────────────────────────────────
// the decision nobody is present for
// ─────────────────────────────────────────────────────────────────────────────

const RUN = "run_gate_decision" as RunId;

function brokerRig(): { store: MemoryStateStore; log: RunLog; broker: HumanGateBroker; clock: { t: number } } {
  const clock = { t: 1_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  return { store, log: new RunLog(RUN, { store, now }), broker: new HumanGateBroker({ now }), clock };
}

const request = (over: Partial<GateRequest> = {}): GateRequest => ({
  runId: RUN,
  taskId: "approve@root#0" as TaskId,
  nodeId: "approve" as NodeId,
  policyRef: "oversight/demo-write@stable",
  payload: { merged: {} },
  ...over,
});

test("A DEFAULT ACTION IN NO VOCABULARY IS REFUSED AT THE RAISE", async () => {
  // The worst member of the class: nobody is present when the clock applies a default
  // action, so a kind that fell through to the permissive branch would approve at 3am with
  // no operator to notice. `raise` is where an author can still see it.
  const { store, log, broker } = brokerRig();

  for (const [what, defaultAction] of NOT_DECISIONS) {
    await assert.rejects(
      () => broker.raise(log, request({ defaultAction: defaultAction as GateDecision, slaMs: 1000, onTimeout: "default_action" })),
      refused(CODES.E_HUMAN_APPROVAL_REQUIRED),
      `${what} was accepted as a default action`,
    );
  }

  const written: JournalEvent[] = [];
  for await (const ev of store.read(RUN, 1)) written.push(ev);
  assert.deepEqual(written, [], "every refusal happened before anything became durable");

  // …and one that IS a decision still raises, which is what makes this a vocabulary check.
  await broker.raise(log, request({ defaultAction: { kind: "approve" }, slaMs: 1000, onTimeout: "default_action" }));
});

test("A REHYDRATED DEFAULT ACTION IN NO VOCABULARY EXPIRES THE GATE INSTEAD OF APPROVING IT", async () => {
  // `rehydrate` is the one path that reaches `#validate` having passed through no compiler
  // and no door — an operator re-supplying an SLA for a gate whose journal predates it. So
  // it is the one place where the acceptance-set check is the only thing standing between
  // an unreadable `defaultAction` and a gate the clock silently approves.
  const { log, broker, clock } = brokerRig();
  const gateId = await broker.raise(log, request({ slaMs: 1000, onTimeout: "default_action", defaultAction: { kind: "approve" } }));

  broker.rehydrate(gateId, {
    ...request(),
    slaMs: 1000,
    onTimeout: "default_action",
    defaultAction: { kind: "APPROVE" } as unknown as GateDecision,
  });

  clock.t += 5000;
  const fired = await broker.sweepTimeouts(log);
  assert.equal(fired.length, 1, "the deadline fired");

  const p = (await broker.project(log))!;
  const after = Object.values(p.gates)[0]!;
  assert.equal(after.state, "expired", "an unreadable default action expires the gate");
  assert.notEqual(after.decision, "APPROVE", "and is not journaled as a decision");
});

test("A REHYDRATED SLA THAT IS NOT A NUMBER IS NO SLA, rather than a deadline that never arrives", async () => {
  // The same door as the test above and the other half of A12. `rehydrate` takes a
  // `GateRequest` from an operator re-supplying an SLA for a gate whose journal predates
  // the field — no compiler behind it — and `#deadlineOf` reads it as its last source.
  // `deadline = raisedAtTs + NaN` is `NaN`, which loses every comparison, so it is not a
  // deadline; but it is not ABSENT either, and the difference is visible everywhere a
  // deadline is a number. `nextDeadline` is the cheapest place to see it: the sweeper asks
  // it whether a run is worth folding, and `gateQueueOrder` ranks by it — a `NaN` there is
  // the non-transitive comparator that reorders a queue of questions for humans.
  const { log, broker } = brokerRig();
  await broker.raise(log, request());

  for (const junk of [NaN, Infinity, -1, 0, 1.5, "1000" as unknown as number]) {
    broker.rehydrate(Object.values((await broker.project(log))!.gates)[0]!.gateId, { ...request(), slaMs: junk });
    assert.equal(
      broker.nextDeadline((await broker.project(log))!),
      undefined,
      `slaMs: ${String(junk)} became a deadline`,
    );
  }

  // …and a usable one still gives the gate a clock, which is what `rehydrate` is for.
  broker.rehydrate(Object.values((await broker.project(log))!.gates)[0]!.gateId, { ...request(), slaMs: 1000 });
  assert.equal(typeof broker.nextDeadline((await broker.project(log))!), "number");
});

test("…AND `raise` IS THE SOURCE THAT OUTRANKS IT, so guarding only `rehydrate` guarded the weaker one", async () => {
  // `#deadlineOf` reads three sources in strict order of authority: the JOURNALED deadline,
  // a journaled `slaMs`, and last an operator's re-supplied one. The test above covers the
  // last. `raise` computes `raisedAt + req.slaMs` and journals it, so an unusable `slaMs`
  // there wrote `deadline: NaN` into the gate's own `gate.raised` — permanent, highest
  // authority, and `now >= NaN` is false forever. The compiler refuses every shape a GRAPH
  // can declare; `raise` is a public method an embedder calls with no compiler behind it.
  for (const junk of [NaN, Infinity, -1, 0, 1.5, "1000" as unknown as number]) {
    const { log, broker, clock } = brokerRig();
    const gateId = await broker.raise(log, request({ slaMs: junk, onTimeout: "fail" }));

    const p = (await broker.project(log))!;
    assert.equal(gateOf(p, gateId)?.deadline, undefined, `slaMs: ${String(junk)} was journaled as a deadline`);
    // …and NOT as an `slaMs` either, which is `#deadlineOf`'s SECOND source: guarding one
    // field and journaling the other moves the defect one line over.
    assert.equal(gateOf(p, gateId)?.slaMs, undefined, `slaMs: ${String(junk)} was journaled as an SLA`);
    assert.equal(broker.nextDeadline(p), undefined);

    // …and the sweep agrees: a gate with no clock is not expired by one.
    clock.t += 10_000_000;
    assert.deepEqual(await broker.sweepTimeouts(log), [], `slaMs: ${String(junk)} produced a deadline that never arrives`);
  }

  // A usable one still journals a deadline and still fires.
  const { log, broker, clock } = brokerRig();
  await broker.raise(log, request({ slaMs: 1000, onTimeout: "fail" }));
  clock.t += 5000;
  assert.equal((await broker.sweepTimeouts(log)).length, 1, "a real SLA still expires its gate");
});

// ─────────────────────────────────────────────────────────────────────────────
// the same question, asked of a journal this build did not write
// ─────────────────────────────────────────────────────────────────────────────

test("A JOURNALED DECISION THE ENGINE CANNOT READ FAILS THE TASK, instead of running the action", async () => {
  // THE READING SIDE, WHICH IS A SEPARATE QUESTION FROM THE WRITING SIDE. `gateDecisionOf`
  // stops a decision outside the union being APPENDED; `Engine.#applyGateDecision` reads
  // one back out of a FOLD, and it branched on `=== "reject"` alone — so a journal carrying
  // `decision: "REJECT"` still fell through to `succeeded` and ran the guarded write.
  //
  // The journal is authoritative (invariant 2), and *trusted* means "we do not defend
  // against it", not "it cannot be malformed": a hand-edited database, or one written by a
  // build older than the guard, is a real shape this repo folds. Fixing only the append
  // would have left the same fail-open reachable through the one input the system trusts.
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const parkedAt = await h.engine.advance(runId);
  const gate = Object.values(parkedAt.gates).find((g) => g.state === "open")!;
  assert.equal(h.writes.length, 0);

  // Hand-write the pair `resolve` would have written, with a decision it would now refuse.
  const log = new RunLog(runId, { store: h.store, now: () => 1_700_000_000_000 });
  await log.append(
    [
      {
        type: "gate.decided",
        payload: { gateId: gate.gateId, decision: "REJECT" as never, latencyMs: 0 },
        actor: alice,
      },
      { type: "run.resumed", payload: { by: "gate" }, actor: alice },
    ],
    { taskId: gate.taskId },
  );

  const after = await h.engine.advance(runId);
  assert.equal(after.status, "failed", "the run completed on a decision nobody can read");
  assert.equal(h.writes.length, 0, "THE ACTION BEHIND THE GATE RAN");
  assert.equal(after.error?.code, CODES.E_REPLAY_DIVERGENCE, "…and the failure does not say why");
  assert.match(String(after.error?.message ?? ""), /not one of "approve", "reject", "edit", "redirect"/);
  assert.match(String(after.error?.message ?? ""), /has NOT been run/);
});

test("REPLAY DIVERGES ON A RECORDED DECISION IT CANNOT READ, instead of re-serving it as an approval", async () => {
  // `run/replay.ts`'s `decisionOf` had the same `default: {kind:"approve"}` the broker had,
  // and it is the harder one to see: replay is what the D10 promotion gate and the CI state
  // hash are built on, so the wrong answer here is the one that CERTIFIES a candidate.
  //
  // No fixture reaches this arm any more — the broker refuses to journal a decision outside
  // the vocabulary, which is the fix one layer up. What reaches it is a journal this build
  // did not write: a hand-edited database, or one from a version that had the defect. So
  // the store is wrapped rather than re-appended, which keeps every seq and ts identical
  // and changes exactly the one field under test.
  const h = harness();
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  let p = await h.engine.advance(runId);
  const gateId = Object.values(p.gates).find((g) => g.state === "open")!.gateId;
  p = await h.engine.resolveGate(runId, { gateId, decision: { kind: "approve" }, actor: alice, idempotencyKey: "k1" });
  assert.equal(p.status, "succeeded");

  const legacy: StateStore = {
    append: (input) => h.store.append(input),
    head: (id) => h.store.head(id),
    listRuns: (limit) => h.store.listRuns(limit),
    close: () => h.store.close(),
    read: (id, from, to) => ({
      async *[Symbol.asyncIterator]() {
        for await (const ev of h.store.read(id, from, to)) {
          yield ev.type === "gate.decided"
            ? ({ ...ev, payload: { ...(ev.payload as object), decision: "APPROVE" } } as unknown as typeof ev)
            : ev;
        }
      },
    }),
  };

  await assert.rejects(
    () =>
      replayRun({
        store: legacy,
        runId,
        graph,
        engine: {
          tools: h.engine.tools,
          functions: h.engine.functions,
          models: h.engine.models,
          policy: { granted: ["fs:read", "fs:write"] },
        },
      }),
    refused(CODES.E_REPLAY_DIVERGENCE),
    "an unreadable recorded decision was re-served as an approval",
  );
});
