/**
 * D7.3's `Claimed` soft lock — mostly, what it is NOT.
 *
 * > **A CLAIM IS A COORDINATION HINT BETWEEN APPROVERS. IT GRANTS NOTHING AND IT BLOCKS
 * > NOTHING.**
 *
 * That sentence is `HumanGateBroker.claim`'s contract, and it is the only interesting
 * thing about this feature: a soft lock is a comfort, and every way a comfort can harden
 * into a permission or into a stall is a way the oversight layer stops working. So the
 * tests are not "a claim can be taken". They are:
 *
 *   - claiming does not make the claimant an approver, and the approvers list does not
 *     move;
 *   - a live claim does not delay a DIFFERENT legitimate approver by one instant, and does
 *     not delay the CLOCK either — `resolve`, `resolveBatch` and `#fireTimeout` read no
 *     claim at all;
 *   - the claim door is deliberately NARROWER than the decision door, and the sharpest
 *     evidence is an actor that `#authorize` admits and `claim` refuses;
 *   - two claims in the same instant produce ONE lock, and the loser is told who holds it
 *     rather than told they hold it;
 *   - one credential claiming every gate in a queue stalls nothing, because nothing on the
 *     decision path reads a claim.
 *
 * The clock is injected and advanced by hand: a TTL is the whole subject here, and a test
 * that reads the wall clock cannot state one. The TTL constant itself is module-private in
 * `run/gates.ts`, so the five minutes D7.3 specifies is pinned FROM OUTSIDE — through the
 * `until` a caller is handed — which is where a client would notice it change.
 *
 * The second half of the file drives `foldRun` over hand-written journals. That is not
 * belt-and-braces: `projection.ts`'s `gate.claimed` arm IS the arbiter — `claim` appends
 * and then reads its answer back out of the fold — so the contention rules are properties
 * of the fold, and a journal written by another process or an older build is the input
 * they have to hold for.
 *
 * See design/loom/04-OVERSIGHT.md D7.3.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { newRunId, type GateId, type NodeId, type RunId, type Seq, type TaskId } from "../../src/ids.ts";
import { SYSTEM_ACTOR, type Actor, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { HumanGateBroker, type GateRequest } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import { foldRun, type GateRecord } from "../../src/run/projection.ts";

const n = (id: string): NodeId => id as NodeId;

const alice = { kind: "human", subject: "u:alice", via: "api" } as const;
const bob = { kind: "human", subject: "u:bob", via: "api" } as const;
const mallory = { kind: "human", subject: "u:mallory", via: "api" } as const;

/**
 * D7.3's five minutes, asserted from OUTSIDE the module that holds it.
 *
 * `CLAIM_TTL_MS` is module-private in `run/gates.ts` and importing it would make every
 * assertion below a tautology — the test would agree with whatever the constant said. This
 * is the number a console renders and a client re-claims against, so it is pinned here.
 */
const TTL = 300_000;

const refused = (code: string) => (err: unknown): true => {
  assert.ok(isLoomError(err), `expected a LoomError, got ${String(err)}`);
  assert.equal(err.code, code, err.message);
  return true;
};

// ---------------------------------------------------------------------------
// A broker on an injected clock
// ---------------------------------------------------------------------------

interface Bench {
  readonly clock: { t: number };
  readonly store: MemoryStateStore;
  readonly broker: HumanGateBroker;
  readonly log: RunLog;
  readonly runId: RunId;
}

const T0 = 1_700_000_000_000;

function bench(): Bench {
  const clock = { t: T0 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const runId = newRunId(clock.t);
  return { clock, store, broker: new HumanGateBroker({ now }), log: new RunLog(runId, { store, now }), runId };
}

let seq = 0;

/** A `GateRequest` override where an explicit `undefined` DELETES the field. */
type Over = { readonly [K in keyof GateRequest]?: GateRequest[K] | undefined };

function request(b: Bench, over: Over = {}): GateRequest {
  seq += 1;
  const base: GateRequest = {
    runId: b.runId,
    taskId: `approve@root/f0[${seq}]#0` as TaskId,
    nodeId: n("approve"),
    policyRef: "oversight/restart-pod@stable",
    payload: { host: `web-${seq}` },
    approvers: ["u:alice"],
    allowEdit: [],
  };
  const merged: Record<string, unknown> = { ...base, ...over };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return merged as unknown as GateRequest;
}

async function gateOf(b: Bench, gateId: GateId): Promise<GateRecord> {
  const p = await b.broker.project(b.log);
  const g = p === undefined ? undefined : p.gates[gateId];
  assert.ok(g !== undefined, `no gate ${gateId}`);
  return g;
}

async function rows(b: Bench, type: string): Promise<readonly JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of b.store.read(b.runId, 1)) if (ev.type === type) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// What a claim IS — the smallest possible surface
// ---------------------------------------------------------------------------

test("A CLAIM IS FIVE MINUTES, IT NAMES ITS HOLDER, AND ITS SUBJECT IS ON THE APPEND", async () => {
  const b = bench();
  const gateId = await b.broker.raise(b.log, request(b));

  const held = await b.broker.claim(b.log, { gateId, actor: alice });
  assert.deepEqual(held, { claimed: true, by: "u:alice", until: T0 + TTL }, "D7.3's five minutes, from now");

  const [row, ...extra] = await rows(b, "gate.claimed");
  assert.deepEqual(extra, [], "one claim, one row");
  assert.deepEqual(row!.payload, { gateId, until: T0 + TTL }, "{gateId, until} and NOTHING ELSE");
  assert.deepEqual(row!.actor, alice, "WHO is the event's actor — a subject in the payload would be a second copy");

  const g = await gateOf(b, gateId);
  assert.equal(g.claimedBy, "u:alice", "…and the fold reads it off the actor");
  assert.equal(g.claimedUntil, T0 + TTL);
  assert.equal(g.state, "open", "a claim is not a transition: the gate is exactly as answerable as it was");
});

test("A CLAIM ON A GATE THAT IS NOT THERE REFUSES RATHER THAN GOING QUIET", async () => {
  // A caller reads silence as "I hold it", so every case where the claim did not happen
  // throws. This is the one that is not about state at all.
  const b = bench();
  await b.broker.raise(b.log, request(b));
  await assert.rejects(
    () => b.broker.claim(b.log, { gateId: "gate_nope" as GateId, actor: alice }),
    refused(CODES.E_GATE_NOT_FOUND),
  );
});

// ---------------------------------------------------------------------------
// IT GRANTS NOTHING
// ---------------------------------------------------------------------------

test("CLAIMING DOES NOT MAKE THE CLAIMANT AN APPROVER, AND MOVES NOBODY ONTO THE LIST", async () => {
  const b = bench();
  const named = await b.broker.raise(b.log, request(b, { approvers: ["u:alice"] }));

  // The direction that cannot even be attempted: a gate that names people is claimable
  // only by them, because a claim by anyone else tells the people who must look that they
  // need not.
  await assert.rejects(
    () => b.broker.claim(b.log, { gateId: named, actor: mallory }),
    refused(CODES.E_GATE_NOT_AUTHORIZED),
  );
  assert.deepEqual(await rows(b, "gate.claimed"), [], "a refused claim writes nothing");

  // And the direction that can: alice may claim it, and afterwards mallory is exactly as
  // unauthorized as before. If a claim were an authorization primitive, THIS is where it
  // would leak — a lock held by a legitimate approver widening what the gate admits.
  await b.broker.claim(b.log, { gateId: named, actor: alice });
  await assert.rejects(
    () =>
      b.broker.resolve(b.log, {
        gateId: named,
        decision: { kind: "approve" },
        actor: mallory,
        idempotencyKey: "m1",
      }),
    refused(CODES.E_GATE_NOT_AUTHORIZED),
  );
  const g = await gateOf(b, named);
  assert.deepEqual(g.approvers, ["u:alice"], "the approvers list is the fold of `gate.raised`, and a claim is not one");
  assert.equal(g.state, "open");
  assert.equal(g.decision, undefined);

  // A gate that names NOBODY is answerable by anyone, so anyone may claim it — "somebody
  // is looking" is the whole content there, and it is still not a grant: the set of people
  // who may decide was everybody before the claim and is everybody after it.
  const open = await b.broker.raise(b.log, request(b, { approvers: undefined }));
  const anyone = await b.broker.claim(b.log, { gateId: open, actor: mallory });
  assert.equal(anyone.claimed, true);
  const decided = await b.broker.resolve(b.log, {
    gateId: open,
    decision: { kind: "approve" },
    actor: bob,
    idempotencyKey: "b1",
  });
  assert.equal(decided.resolved, true, "bob was always able to answer this, and mallory's claim changed nothing");
});

test("THE CLAIM DOOR IS NARROWER THAN THE DECISION DOOR — an actor `#authorize` ADMITS is refused", async () => {
  // The sharpest form of "this is not the authorization chain": `GATE_SYSTEM_ACTORS`
  // admits a handful of SYSTEM components to the decision path, because their authority is
  // journaled elsewhere. None of them LOOKS at anything, and "the clock is reading this
  // gate" is not a fact — it would silence the humans who are. So `claim` refuses what
  // `#authorize` accepts, and the divergence is checked here rather than asserted, because
  // the rule is that every divergence may only make CLAIMING harder.
  const b = bench();
  const clockActor = SYSTEM_ACTOR("gate-broker:timeout");
  const one = await b.broker.raise(b.log, request(b, { approvers: ["u:alice"] }));
  const two = await b.broker.raise(b.log, request(b, { approvers: ["u:alice"] }));

  await assert.rejects(
    () => b.broker.claim(b.log, { gateId: one, actor: clockActor }),
    refused(CODES.E_GATE_NOT_AUTHORIZED),
  );
  await assert.rejects(
    () =>
      b.broker.claim(b.log, {
        gateId: one,
        actor: { kind: "agent", profile: "p", taskId: "approve@root#0" as TaskId, model: "m" },
      }),
    refused(CODES.E_GATE_NOT_AUTHORIZED),
  );
  assert.deepEqual(await rows(b, "gate.claimed"), []);

  // …and the same actor, on the same authority, DECIDES a gate naming only u:alice. That
  // is what makes the refusal above a deliberate narrowing rather than an accident.
  const out = await b.broker.resolve(b.log, {
    gateId: two,
    decision: { kind: "approve" },
    actor: clockActor,
    idempotencyKey: "t1",
  });
  assert.equal(out.resolved, true, "the decision path admits it; the claim path does not");
});

// ---------------------------------------------------------------------------
// IT BLOCKS NOTHING
// ---------------------------------------------------------------------------

test("A LIVE CLAIM DOES NOT BLOCK A DIFFERENT LEGITIMATE APPROVER", async () => {
  // A soft lock that hardens is one person holding up an urgent approval. The way to keep
  // it soft is for the decision path to have no branch on it at all — so bob answers a
  // gate alice is holding exactly as he would answer one nobody has touched.
  const b = bench();
  const gateId = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"] }));
  await b.broker.claim(b.log, { gateId, actor: alice });

  const out = await b.broker.resolve(b.log, {
    gateId,
    decision: { kind: "approve" },
    actor: bob,
    idempotencyKey: "b1",
  });
  assert.equal(out.resolved, true, "no wait, no refusal, no second call needed");

  const g = await gateOf(b, gateId);
  assert.equal(g.state, "decided");
  assert.equal(g.decision, "approve");
  assert.equal(g.decidedBy, "human");
  assert.equal(g.claimedBy, "u:alice", "the claim was neither consulted nor consumed — it is simply still on the record");
  assert.equal(g.claimedUntil, T0 + TTL);
});

test("NOR DOES IT BLOCK THE CLOCK: a claimed gate expires on exactly the same instant", async () => {
  // `#fireTimeout` reads no claim either, which matters more than the human case: an SLA
  // that a claim could pause is an SLA anybody with a credential can switch off.
  // TWO RUNS, because an expiry fails the run it belongs to and deliberately leaves its
  // siblings open — so a control gate has to live in its own journal to be a control at all.
  const run = async (hold: boolean): Promise<{ b: Bench; gateId: GateId; before: readonly GateId[]; at: readonly GateId[] }> => {
    const b = bench();
    const gateId = await b.broker.raise(b.log, request(b, { slaMs: 60_000, onTimeout: "fail" }));
    if (hold) await b.broker.claim(b.log, { gateId, actor: alice });
    b.clock.t += 59_999;
    const before = await b.broker.sweepTimeouts(b.log, b.clock.t);
    b.clock.t += 2;
    const at = await b.broker.sweepTimeouts(b.log, b.clock.t);
    return { b, gateId, before, at };
  };

  const held = await run(true);
  const control = await run(false);
  assert.deepEqual(held.before, [], "not due one millisecond early, claimed or not");
  assert.deepEqual(control.before, []);
  assert.deepEqual(held.at, [held.gateId], "and due on exactly the instant the control is");
  assert.deepEqual(control.at, [control.gateId]);
  assert.equal((await gateOf(held.b, held.gateId)).state, "expired");
  assert.equal((await gateOf(control.b, control.gateId)).state, "expired");
  assert.equal((await gateOf(held.b, held.gateId)).claimedBy, "u:alice", "and nothing reaped the claim on the way past");
});

test("A CLAIM CANNOT BE A DENIAL OF SERVICE: one credential holding every gate stalls nothing", async () => {
  // The whole queue, claimed by one person, and then answered by another with no
  // intervention at all. This is the property that falls out of "nothing on the decision
  // path reads a claim" — there is no bound to check and no lock to break, because there is
  // no reader.
  const b = bench();
  const ids: GateId[] = [];
  for (let i = 0; i < 8; i++) ids.push(await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"] })));
  for (const gateId of ids) {
    const held = await b.broker.claim(b.log, { gateId, actor: alice });
    assert.equal(held.claimed, true, `alice holds ${gateId}`);
  }

  for (const [i, gateId] of ids.entries()) {
    const out = await b.broker.resolve(b.log, {
      gateId,
      decision: { kind: "approve" },
      actor: bob,
      idempotencyKey: `b${i}`,
    });
    assert.equal(out.resolved, true, `bob answered ${gateId} without asking anybody`);
  }
  const p = (await b.broker.project(b.log))!;
  assert.deepEqual(
    Object.values(p.gates).map((g) => g.state),
    ids.map(() => "decided"),
    "eight questions, eight answers, zero contention",
  );
});

// ---------------------------------------------------------------------------
// A claim on a question nobody can answer any more
// ---------------------------------------------------------------------------

test("A CLAIM REFUSES ON A GATE THAT IS DECIDED, CANCELLED OR EXPIRED", async () => {
  // Each is terminal for the gate, and a hint about a question with an answer is not a
  // hint — it is a mistake about what the queue holds. The code and the shape are
  // `resolve`'s, for the same two facts.
  const b = bench();

  const decided = await b.broker.raise(b.log, request(b));
  await b.broker.resolve(b.log, { gateId: decided, decision: { kind: "approve" }, actor: alice, idempotencyKey: "a1" });
  await assert.rejects(
    () => b.broker.claim(b.log, { gateId: decided, actor: alice }),
    refused(CODES.E_GATE_ALREADY_RESOLVED),
  );

  const expired = await b.broker.raise(b.log, request(b, { slaMs: 1_000, onTimeout: "fail" }));
  b.clock.t += 1_001;
  await b.broker.sweepTimeouts(b.log, b.clock.t);
  assert.equal((await gateOf(b, expired)).state, "expired");
  await assert.rejects(
    () => b.broker.claim(b.log, { gateId: expired, actor: alice }),
    refused(CODES.E_GATE_ALREADY_RESOLVED),
  );

  assert.deepEqual(await rows(b, "gate.claimed"), [], "three refusals, and nothing durable from any of them");
});

test("A CLAIM REFUSES ON A TERMINAL RUN, WHATEVER THE GATE ROW SAYS", async () => {
  // The legacy shape `resolve`'s own terminal check exists for: a run an operator ended
  // whose gates an older build left `open`. The gate reads answerable and the run is not.
  const b = bench();
  const gateId = await b.broker.raise(b.log, request(b));
  await b.log.append([
    {
      type: "run.cancelled",
      payload: { clean: true, unknownEffects: [], forced: false },
      actor: SYSTEM_ACTOR("test"),
    },
  ]);
  assert.equal((await gateOf(b, gateId)).state, "open", "the gate row still says open — that is the point");

  await assert.rejects(
    () => b.broker.claim(b.log, { gateId, actor: alice }),
    refused(CODES.E_GATE_ALREADY_RESOLVED),
  );
  assert.deepEqual(await rows(b, "gate.claimed"), []);
});

// ---------------------------------------------------------------------------
// Contention: the case this whole feature exists for
// ---------------------------------------------------------------------------

test("TWO CLAIMS IN THE SAME INSTANT PRODUCE ONE LOCK, AND THE LOSER IS TOLD WHO HOLDS IT", async () => {
  // TWO BROKERS ON ONE JOURNAL, which is the deployment this is for: a claim held in one
  // process's memory is no claim at all in the process the second approver reached.
  //
  // The assertion holds under EVERY interleaving, deliberately. If the two really race,
  // both pre-checks see no holder and the FOLD arbitrates; if the store serialises them,
  // the second one's pre-check sees the first and returns without appending. Either way
  // there is exactly one holder and both callers are told the same name — which is the
  // property, and it is the one an order-sensitive test would not have stated.
  const clock = { t: T0 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const runId = newRunId(clock.t);
  const b: Bench = { clock, store, broker: new HumanGateBroker({ now }), log: new RunLog(runId, { store, now }), runId };
  const other = new HumanGateBroker({ now });
  const otherLog = new RunLog(runId, { store, now });

  const gateId = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"] }));
  await other.project(otherLog);

  const [first, second] = await Promise.all([
    b.broker.claim(b.log, { gateId, actor: alice }),
    other.claim(otherLog, { gateId, actor: bob }),
  ]);

  const winners = [first, second].filter((r) => r.claimed);
  assert.equal(winners.length, 1, `exactly one lock, got ${JSON.stringify([first, second])}`);
  assert.equal(first.by, second.by, "and both callers are told the SAME name");
  assert.equal(first.until, second.until, "…for the same instant");
  assert.equal(winners[0]!.by, first.by, "the winner is the one who was told `claimed: true`");

  const g = await gateOf(b, gateId);
  assert.equal(g.claimedBy, first.by, "the journal agrees with what both were told");
  assert.equal(g.claimedUntil, first.until);
});

test("THE CLAIMANT'S OWN RE-CLAIM REFRESHES IT; ANOTHER SUBJECT'S DOES NOT", async () => {
  const b = bench();
  const gateId = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"] }));
  await b.broker.claim(b.log, { gateId, actor: alice });

  // A person still typing keeps it, and the evidence that they are still there is the
  // re-claim itself — which is exactly what the abandoned case cannot produce.
  b.clock.t += 120_000;
  const again = await b.broker.claim(b.log, { gateId, actor: alice });
  assert.deepEqual(again, { claimed: true, by: "u:alice", until: T0 + 120_000 + TTL }, "the window moved with her");
  assert.equal((await gateOf(b, gateId)).claimedUntil, T0 + 120_000 + TTL);

  // Bob, inside the refreshed window, is told the truth rather than handed a second lock.
  b.clock.t += 60_000;
  const denied = await b.broker.claim(b.log, { gateId, actor: bob });
  assert.deepEqual(denied, { claimed: false, by: "u:alice", until: T0 + 120_000 + TTL });
  assert.equal((await rows(b, "gate.claimed")).length, 2, "a losing claim writes nothing — contention is not an event");
});

test("A CLAIM EXPIRES BY BEING IGNORED: NOTHING SWEEPS IT, AND NOTHING WRITES ITS END", async () => {
  // `until` is an absolute instant in the journal and `now` is the READER's clock, so
  // expiry is a comparison rather than a transition. That is why there is no sweeper arm
  // and no `gate.claim_expired`: there is no state to reap, and a row whose only content is
  // that time passed would be a durable fact nobody could observe the absence of.
  const b = bench();
  const gateId = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"], slaMs: 3_600_000 }));
  await b.broker.claim(b.log, { gateId, actor: alice });

  b.clock.t += TTL - 1;
  assert.deepEqual(
    await b.broker.claim(b.log, { gateId, actor: bob }),
    { claimed: false, by: "u:alice", until: T0 + TTL },
    "one millisecond inside, and it still holds",
  );

  // The instant itself is the end: `now < until`, not `<=`.
  b.clock.t += 1;
  const taken = await b.broker.claim(b.log, { gateId, actor: bob });
  assert.deepEqual(taken, { claimed: true, by: "u:bob", until: T0 + TTL + TTL });

  await b.broker.sweepTimeouts(b.log, b.clock.t);
  const types = new Set<string>();
  for await (const ev of b.store.read(b.runId, 1)) types.add(ev.type);
  assert.equal(types.has("gate.claim_expired"), false, "there is no such event, and there must not be");
  assert.equal((await rows(b, "gate.claimed")).length, 2, "alice's, then bob's — the expiry wrote nothing between them");

  const g = await gateOf(b, gateId);
  assert.equal(g.claimedBy, "u:bob");
  assert.equal(g.state, "open", "and the question is exactly as open as it was throughout");
});

test("A BATCH IS CLAIMED ONCE — the rule that pages it once and nudges it once per reminder", async () => {
  // A batch is one question, so two people holding "different" members of one manifest is
  // the collision this exists to prevent rather than an arrangement it should permit. One
  // click closes every member, after all.
  const b = bench();
  const batching = { enabled: true, key: "restart-pods", windowMs: 60_000, maxBatch: 20 } as const;
  const first = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"], batching }));
  const second = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"], batching }));
  const third = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"], batching }));
  assert.equal((await gateOf(b, third)).batch?.id, first, "one batch, three members");

  await b.broker.claim(b.log, { gateId: second, actor: alice });
  assert.deepEqual(
    await b.broker.claim(b.log, { gateId: third, actor: bob }),
    { claimed: false, by: "u:alice", until: T0 + TTL },
    "bob is told who has the MANIFEST, not handed a second lock on the same click",
  );
  assert.deepEqual(
    await b.broker.claim(b.log, { gateId: first, actor: bob }),
    { claimed: false, by: "u:alice", until: T0 + TTL },
    "…from any member, including the one the batch is named for",
  );

  // Alice's own hand on another member is hers, and it refreshes rather than colliding.
  b.clock.t += 1_000;
  const hers = await b.broker.claim(b.log, { gateId: third, actor: alice });
  assert.deepEqual(hers, { claimed: true, by: "u:alice", until: T0 + 1_000 + TTL });

  // An UNBATCHED gate is its own question and is unaffected by any of it.
  const alone = await b.broker.raise(b.log, request(b, { approvers: ["u:alice", "u:bob"], batching: undefined }));
  assert.equal((await b.broker.claim(b.log, { gateId: alone, actor: bob })).claimed, true);
});

// ---------------------------------------------------------------------------
// The fold IS the arbiter — driven over journals `src/` would not write
// ---------------------------------------------------------------------------

const RUN = "run_claimfold" as RunId;
const GATE = "gate_one" as GateId;

/** A hand-written journal. Each row carries its OWN actor, which the claim arm reads. */
function journal(
  ...rowsIn: readonly { type: string; payload: unknown; actor?: Actor; ts?: number }[]
): JournalEvent[] {
  return rowsIn.map(
    (r, i) =>
      ({
        runId: RUN,
        seq: (i + 1) as Seq,
        ts: r.ts ?? 1_000_000 + i,
        type: r.type,
        payload: r.payload,
        actor: r.actor ?? SYSTEM_ACTOR("test"),
        classification: "internal",
      }) as unknown as JournalEvent,
  );
}

const STARTED = { type: "run.started", payload: { posture: "out" } };
const RAISED = {
  type: "gate.raised",
  payload: { gateId: GATE, nodeId: "approve", policyRef: "p", contentDigest: "d" },
};
const claimed = (actor: Actor, until: unknown, ts: number): { type: string; payload: unknown; actor: Actor; ts: number } => ({
  type: "gate.claimed",
  payload: { gateId: GATE, until },
  actor,
  ts,
});

test("THE FOLD KEEPS THE FIRST LIVE CLAIM AND DROPS A SECOND ONE BY ANOTHER SUBJECT", () => {
  // The arbitration `claim` reads its answer back out of. Both rows landed — a
  // compare-and-swap is not what decides this, two brokers may both append — so the
  // question is which one the JOURNAL gives the lock to, and it is the first.
  const p = foldRun(
    journal(
      STARTED,
      RAISED,
      claimed(alice, 1_000_000 + TTL, 1_000_000),
      claimed(bob, 1_000_000 + TTL, 1_000_000),
    ),
  )!;
  assert.equal(p.gates[GATE]?.claimedBy, "u:alice");
  assert.equal(p.gates[GATE]?.claimedUntil, 1_000_000 + TTL);
});

test("THE FOLD HAS NO CLOCK, SO IT ARBITRATES AT THE ARRIVING EVENT'S OWN `ts`", () => {
  // A fold with a clock would give the same journal two answers at two instants, which is
  // the property replay verification exists to refuse. The instant that decides "was the
  // incumbent still live?" is therefore the second claim's own timestamp — the moment it
  // was made — and the answer is stable forever afterwards.
  const held = journal(STARTED, RAISED, claimed(alice, 1_000_000 + TTL, 1_000_000), claimed(bob, 9e15, 1_000_000 + TTL - 1));
  const lapsed = journal(STARTED, RAISED, claimed(alice, 1_000_000 + TTL, 1_000_000), claimed(bob, 9e15, 1_000_000 + TTL));

  assert.equal(foldRun(held)!.gates[GATE]?.claimedBy, "u:alice", "one ms inside alice's window, so bob's row is dropped");
  assert.equal(
    foldRun(lapsed)!.gates[GATE]?.claimedBy,
    "u:bob",
    "`now < until`, so a claim whose instant has arrived is over and the next claimant takes it",
  );

  // Stability, stated as a property rather than as an absence: the same bytes folded again
  // give the same record, so no later wall clock can produce a third answer.
  assert.deepEqual(foldRun(held)!.gates[GATE], foldRun(held)!.gates[GATE]);
  assert.equal(foldRun(lapsed)!.gates[GATE]?.claimedUntil, 9e15, "and the winner's own `until` is the one on the row");
});

test("A LAPSED HOLDER LOSES IT WITHOUT ANYTHING HAVING WRITTEN THEIR EXPIRY", () => {
  const evs = journal(
    STARTED,
    RAISED,
    claimed(alice, 1_000_000 + TTL, 1_000_000),
    claimed(bob, 1_000_000 + TTL * 3, 1_000_000 + TTL * 2),
  );
  const p = foldRun(evs)!;
  assert.equal(p.gates[GATE]?.claimedBy, "u:bob");
  assert.equal(p.gates[GATE]?.claimedUntil, 1_000_000 + TTL * 3);
  assert.deepEqual(
    evs.map((e) => e.type),
    ["run.started", "gate.raised", "gate.claimed", "gate.claimed"],
    "two claims and no expiry row: the whole journal is what was CLAIMED, never what lapsed",
  );
});

test("THE CLAIMANT'S OWN RE-CLAIM REFRESHES IN THE FOLD, LIVE OR LAPSED", () => {
  const live = foldRun(
    journal(STARTED, RAISED, claimed(alice, 1_000_000 + TTL, 1_000_000), claimed(alice, 1_000_000 + TTL * 2, 1_000_000 + 5)),
  )!;
  assert.equal(live.gates[GATE]?.claimedUntil, 1_000_000 + TTL * 2, "hers, so it moves");

  // It REPLACES rather than raising: a re-claim from a process whose clock is behind can
  // only shorten its OWN lock, which costs a second person opening the same gate. The
  // opposite failure — a claim that outlives its claimant — is the one this layer exists to
  // prevent, so shortening is the direction a disagreement is allowed to move in.
  const shortened = foldRun(
    journal(STARTED, RAISED, claimed(alice, 1_000_000 + TTL, 1_000_000), claimed(alice, 1_000_000 + 10, 1_000_000 + 5)),
  )!;
  assert.equal(shortened.gates[GATE]?.claimedUntil, 1_000_000 + 10);
});

test("A CLAIM BY ANYTHING THAT IS NOT A PERSON IS DROPPED BY THE FOLD", () => {
  // `claim` refuses every non-human actor at the door, so this shape only comes from a
  // hand-written log or another implementation — which is exactly the input a fold cannot
  // refuse to read. `claimedBy` is a `subject`, and only the human arm of `Actor` has one.
  for (const actor of [
    SYSTEM_ACTOR("gate-broker:timeout"),
    { kind: "agent", profile: "p", taskId: "approve@root#0" as TaskId, model: "m" } as Actor,
    { kind: "evolution", engineVersion: "1", candidate: "c" } as Actor,
  ]) {
    const p = foldRun(journal(STARTED, RAISED, claimed(actor, 9e15, 1_000_000)))!;
    assert.equal(p.gates[GATE]?.claimedBy, undefined, `${actor.kind} holds nothing`);
    assert.equal(p.gates[GATE]?.claimedUntil, undefined);
  }

  // And it cannot displace a person who does hold it.
  const p = foldRun(
    journal(STARTED, RAISED, claimed(alice, 9e15, 1_000_000), claimed(SYSTEM_ACTOR("gate-broker:timeout"), 9e15, 1_000_001)),
  )!;
  assert.equal(p.gates[GATE]?.claimedBy, "u:alice");
});

test("A CLAIM FOLDED ONTO A GATE THAT IS NO LONGER OPEN COUNTS FOR NOTHING", () => {
  // The same `open` conjunct every gate arm carries. A claim on a question that has been
  // answered would say somebody is looking at a decision, which is not a fact about
  // anything — and `claim` refuses to write one, so the shape is hand-written.
  for (const closing of [
    { type: "gate.decided", payload: { gateId: GATE, decision: "approve", latencyMs: 1 } },
    { type: "gate.cancelled", payload: { gateId: GATE, reason: "run ended" } },
    { type: "gate.timeout", payload: { gateId: GATE, action: "fail" } },
  ]) {
    const p = foldRun(journal(STARTED, RAISED, closing, claimed(alice, 9e15, 1_000_000)))!;
    assert.equal(p.gates[GATE]?.claimedBy, undefined, `a ${closing.type} gate cannot be claimed`);
  }
});

test("AN UNREADABLE `until` READS AS UNCLAIMED, WHICH IS THE DIRECTION THAT COSTS A LOOK", () => {
  // The values are what the APPENDER wrote (invariant 2), so the fold passes `until`
  // through and `liveClaim` re-validates it. A number that loses every comparison means
  // "unclaimed" — a duplicated look — rather than a lock nobody can take back.
  for (const bad of [Number.NaN, "soon", null, undefined]) {
    const p = foldRun(journal(STARTED, RAISED, claimed(alice, bad, 1_000_000), claimed(bob, 9e15, 1_000_001)))!;
    assert.equal(p.gates[GATE]?.claimedBy, "u:bob", `an incumbent \`until\` of ${String(bad)} holds nothing`);
  }
});

test("A CLAIM CANNOT REACH A GATE THE MAP DOES NOT OWN", () => {
  // `p.gates["__proto__"]` answers with `Object.prototype` — an object, therefore "found",
  // whose `state` is `undefined`. Nothing in `src/` can mint such an id, so this is about a
  // journal written by hand.
  //
  // HONEST LIMIT, MEASURED: this does NOT hold the arm's `gateIn` call. Replacing it with a
  // bare `p.gates[e.payload.gateId]` leaves the whole file green, because the `open`
  // conjunct one line down refuses `undefined` before the write — the two guards overlap
  // here and only one of them is load-bearing for this input. `gateIn` stays because it is
  // THE lookup (see `gateOf`), not because this test proves it necessary.
  const p = foldRun(
    journal(
      STARTED,
      { type: "gate.raised", payload: { gateId: "__proto__", nodeId: "approve", policyRef: "p", contentDigest: "d" } },
      { type: "gate.claimed", payload: { gateId: "__proto__", until: 9e15 }, actor: alice, ts: 1_000_000 },
    ),
  )!;
  assert.deepEqual(Object.keys(p.gates), [], "no gate, and therefore no claim");
  assert.equal(({} as Record<string, unknown>)["claimedBy"], undefined, "and Object.prototype is untouched");
});

// ---------------------------------------------------------------------------
// `deliveredAt` — the other half of "is an announcement still outstanding?"
// ---------------------------------------------------------------------------

test("`deliveredAt` IS FOLDED FROM `gate.delivered`, FIRST WRITE WINS", () => {
  // One raise writes one row per CHANNEL and every escalation writes more, so the first is
  // "when this question was first announced" — a fact that does not move. Which is what
  // `announcementOutstanding` needs: somebody was TOLD, and has not ANSWERED.
  const p = foldRun(
    journal(
      STARTED,
      RAISED,
      { type: "gate.delivered", payload: { gateId: GATE, channel: "slack", receipt: "r1" }, ts: 1_000_100 },
      { type: "gate.delivered", payload: { gateId: GATE, channel: "email", receipt: "r2" }, ts: 1_000_200 },
      { type: "gate.escalated", payload: { gateId: GATE, tier: 1, to: "manager" }, ts: 1_000_300 },
      { type: "gate.delivered", payload: { gateId: GATE, channel: "slack", receipt: "r3" }, ts: 1_000_400 },
    ),
  )!;
  assert.equal(p.gates[GATE]?.deliveredAt, 1_000_100, "the first channel that took it, and nothing later");
  assert.equal(p.gates[GATE]?.state, "open", "delivery is a receipt, not a transition");
  assert.equal(p.gates[GATE]?.tier, 1, "…and it moved nothing the escalation moved");
});

test("A GATE NOBODY WAS TOLD ABOUT HAS NO `deliveredAt`, WHICH IS THE WHOLE POINT OF THE FIELD", () => {
  // Every channel failed. The gate is open and holds NO announcement, so suppressing a
  // batch joiner against it would produce N questions and no notifications.
  const p = foldRun(
    journal(
      STARTED,
      RAISED,
      {
        type: "gate.delivery_failed",
        payload: { gateId: GATE, channel: "slack", error: "boom", tier: 0, fellBack: false },
      },
    ),
  )!;
  assert.equal(p.gates[GATE]?.state, "open");
  assert.equal(p.gates[GATE]?.deliveredAt, undefined);
});

test("a `gate.delivered` for a gate that is not in the fold changes nothing", () => {
  const p = foldRun(
    journal(STARTED, { type: "gate.delivered", payload: { gateId: GATE, channel: "slack", receipt: "r" } }),
  )!;
  assert.deepEqual(Object.keys(p.gates), [], "a receipt does not conjure the gate it is about");
});
