/**
 * TWO WRITERS OVER ONE JOURNAL — the shape none of the other 2,292 tests has.
 *
 * DESIGN.md's item 2 talks about "a second machine". A second machine is not a socket; from
 * the journal's point of view it is a SECOND WRITER, and everything that makes a second
 * machine dangerous is reachable the moment two planes hold the same `journal.db` at once.
 * `harness.ts` said so about itself for as long as it has existed — a "restart" there is
 * `close()` then `openWorkspace`, which is one writer twice, never two writers once.
 *
 * WHAT IT FOUND, driven before any of it was fixed. Two `openWorkspace` planes over one
 * directory, both armed with `armForeignGates`, `Promise.allSettled` over a reject from one
 * and an approve from the other. Both calls returned FULFILLED, and the journal read:
 *
 *     gate.decided 2 | run.resumed 2 | task.leased 3 | task.committed 2 | run.failed 2
 *
 * One gate answered twice, contradictorily, by the same subject. A run that reached a
 * terminal state twice. `loom audit` on that journal: `ok`, exit 0 — it caught
 * `task.committed-once` and called the other four fine. Three separate defects, each with
 * its own commit: the write door (`gates.ts` appended where it had to commit), the lease
 * identity (`cli.ts` never named a plane, so every one of them was `worker-0`), and the
 * auditor's missing at-most-once rules.
 *
 * THE INTERLEAVING IS FORCED, NOT RACED, and the difference matters in both directions.
 * `Promise.allSettled` over two `resolveGate` calls reproduces the defect every time; a race
 * between two OS processes on :18801/:18802 reproduced it on the second attempt. But a fix
 * that merely REORDERED would go green under the forced shape and stay broken under a real
 * one — which is why the load-bearing assertion in the first test is not "one call was
 * refused" but "one row landed". A `resolve` that threw after appending satisfies the first
 * and fails the second.
 *
 * OFFLINE AND DETERMINISTIC. No socket, no sleep, no assertion on elapsed time: the whole
 * file is two in-process planes over a temp SQLite file, and every wait is an `await` on a
 * promise the product returns.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { armForeignGates, main } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { GateId, RunId, Seq } from "../../src/ids.ts";
import { auditRun } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { LeasedScheduler } from "../../src/run/scheduler.ts";
import { deployment, journalTypes, planes, publishGraph, quiet, type Deployment } from "./harness.ts";

/**
 * One gate in front of one irreversible-ish action, and the action is what makes it a gate.
 *
 * `fs.write` behind the approval, so "the run resumed" and "the file was written" are
 * different facts — which is also what `GRAPH014_GATE_GATES_NOTHING` requires. `onTimeout:
 * "fail"` because no channel is configured (a configured one is a webhook, i.e. the network)
 * and `escalate` with nowhere to escalate to is refused at compile time.
 */
const GATED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "two-planes", project: "deployment", version: 1 },
  policy: { posture: "on", capabilities: ["fs:write"], expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [
    {
      id: "approve",
      type: "human_gate",
      reads: ["note"],
      writes: ["note"],
      humanGate: {
        ref: "oversight/ship@stable",
        approval: { approvers: ["u:alice"] },
        sla: { respondWithinMs: 3_600_000, onTimeout: "fail" },
      },
    },
    {
      id: "apply",
      type: "tool",
      reads: ["note"],
      writes: ["out"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/applied.txt", body: "${note}" } },
    },
  ],
  edges: [{ id: "e1", from: "approve", to: "apply", kind: "seq" }],
};

/** A run parked on its gate, raised through the door people actually use, by a process that then exits. */
async function parked(d: Deployment): Promise<{ runId: RunId; gateId: GateId }> {
  const file = publishGraph(d, "two-planes", GATED);
  const { value: code } = await quiet(() => main(["run", file, "--workspace", d.dir, "--input", '{"note":"ship it"}']));
  assert.equal(code, 0, "`loom run` parks on a gate and that is a success");
  const w = d.open();
  try {
    const gated = (await w.store.listRuns(10, { raisedAGate: true }))[0];
    assert.notEqual(gated, undefined, "the run that gated must be findable by the sweep's own listing");
    const p = await w.engine.projection(gated!.runId);
    const open = Object.values(p?.gates ?? {}).filter((g) => g.state === "open");
    assert.equal(open.length, 1, "exactly one gate is open on the parked run");
    return { runId: gated!.runId, gateId: open[0]!.gateId };
  } finally {
    w.close();
  }
}

async function events(store: { read: (r: RunId, from: Seq) => AsyncIterable<JournalEvent> }, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1 as Seq)) out.push(e);
  return out;
}

function counts(types: readonly string[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const t of types) c[t] = (c[t] ?? 0) + 1;
  return c;
}

const ALICE = { kind: "human", subject: "u:alice", via: "console" } as const;

// ── 1 · one question, two answers, at the same instant ──────────────────────

test("TWO PLANES ANSWER ONE GATE AT ONCE: ONE DECISION LANDS AND THE OTHER IS REFUSED", async () => {
  const d = deployment();
  try {
    const { runId, gateId } = await parked(d);
    const two = planes(d, 2);
    try {
      const [a, b] = two.all as [(typeof two.all)[number], (typeof two.all)[number]];
      // ARMED, both of them: `armForeignGates` is what re-attaches the graph and rehydrates a
      // gate raised by a process that is gone. Without it neither plane can decide anything and
      // the test would pass by refusing everything.
      await armForeignGates(a, new Map<RunId, Seq>());
      await armForeignGates(b, new Map<RunId, Seq>());

      const results = await Promise.allSettled([
        a.engine.resolveGate(runId, { gateId, actor: ALICE, decision: { kind: "reject", reason: "not at this amount" }, idempotencyKey: "k-a" }),
        b.engine.resolveGate(runId, { gateId, actor: ALICE, decision: { kind: "approve" }, idempotencyKey: "k-b" }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, `exactly one plane may decide: ${JSON.stringify(results.map((r) => r.status))}`);
      const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(isLoomError(refused.reason), `the loser must be refused with a Loom error, got ${String(refused.reason)}`);
      assert.equal(refused.reason.code, CODES.E_GATE_ALREADY_RESOLVED);

      // THE LOAD-BEARING HALF. Everything above is satisfied by a `resolve` that appends and
      // then throws; only the journal can say whether the second decision is durable. This is
      // the assertion that was red before `gates.ts` moved to the conditional door — measured
      // then as `gate.decided 2 | run.resumed 2`.
      const c = counts(await journalTypes(a.store, runId));
      assert.equal(c["gate.decided"], 1, `one decision in the journal, not ${String(c["gate.decided"])}`);
      assert.equal(c["run.resumed"], 1, `one resume beside it, not ${String(c["run.resumed"])}`);
      assert.equal((c["run.failed"] ?? 0) + (c["run.completed"] ?? 0), 1, "and the run ended once");
    } finally {
      two.dispose();
    }
  } finally {
    d.dispose();
  }
});

// ── 2 · the same thing sequentially, which is the case with no race to win ───

test("A DECISION ALREADY IN THE JOURNAL IS REFUSED BY THE OTHER PLANE, AND WRITES NOTHING", async () => {
  const d = deployment();
  try {
    const { runId, gateId } = await parked(d);
    const two = planes(d, 2);
    try {
      const [a, b] = two.all as [(typeof two.all)[number], (typeof two.all)[number]];
      await armForeignGates(a, new Map<RunId, Seq>());
      await armForeignGates(b, new Map<RunId, Seq>());

      await a.engine.resolveGate(runId, { gateId, actor: ALICE, decision: { kind: "reject", reason: "no" }, idempotencyKey: "k-a" });
      const before = await events(a.store, runId);

      // PLANE B FOLDED THIS RUN BEFORE THE DECISION LANDED and has an `awaiting_gate`
      // projection in its own broker's memory. It must re-read rather than trust it — which is
      // the whole content of "the journal is the only authoritative state" for a second writer.
      let refused: unknown;
      try {
        await b.engine.resolveGate(runId, { gateId, actor: ALICE, decision: { kind: "approve" }, idempotencyKey: "k-b" });
      } catch (e) {
        refused = e;
      }
      assert.ok(isLoomError(refused), `plane B must refuse, got ${String(refused)}`);
      assert.equal(refused.code, CODES.E_GATE_ALREADY_RESOLVED);

      const after = await events(a.store, runId);
      assert.equal(after.length, before.length, `the refusal must append NOTHING: ${after.slice(before.length).map((e) => e.type).join(", ")}`);
    } finally {
      two.dispose();
    }
  } finally {
    d.dispose();
  }
});

// ── 3 · two planes are two workers, and a live lease says so ────────────────

test("EACH PLANE NAMES ITSELF, SO A LIVE LEASE HELD BY ONE IS NOT SELECTABLE BY THE OTHER", async () => {
  const d = deployment();
  try {
    // The ids are read out of the JOURNAL rather than out of the constructor: `task.leased`
    // carries the `workerId` the plane actually used, so this is the product's own value and
    // not a restatement of the argument passed in.
    // BOTH RUNS ARE PARKED BEFORE EITHER PLANE BOOTS. `armForeignGates` attaches the runs it
    // finds AT THE MOMENT IT RUNS; a run raised afterwards is `E_RUN_NOT_FOUND` to that plane,
    // which this test discovered by doing it the other way round first.
    const one = await parked(d);
    const second = await parked(d);
    const two = planes(d, 2);
    let names: string[];
    try {
      const [a, b] = two.all as [(typeof two.all)[number], (typeof two.all)[number]];
      await armForeignGates(a, new Map<RunId, Seq>());
      await armForeignGates(b, new Map<RunId, Seq>());
      // A decision from each plane on a run of its OWN, so each one leases something under its
      // own name. Not the same run: that is test 1, and there only one of them gets to lease.
      await a.engine.resolveGate(one.runId, { gateId: one.gateId, actor: ALICE, decision: { kind: "approve" }, idempotencyKey: "k-a" });
      await b.engine.resolveGate(second.runId, { gateId: second.gateId, actor: ALICE, decision: { kind: "approve" }, idempotencyKey: "k-b" });
      const first = (await events(a.store, one.runId)).filter((e) => e.type === "task.leased");
      const other = (await events(b.store, second.runId)).filter((e) => e.type === "task.leased");
      names = [
        String((first.at(-1)!.payload as { workerId: string }).workerId),
        String((other.at(-1)!.payload as { workerId: string }).workerId),
      ];
    } finally {
      two.dispose();
    }

    assert.notEqual(names[0], names[1], `two planes must not share a lease identity — both called themselves "${names[0]}"`);

    // AND THE NAME IS WHAT THE EXCLUSION READS. `LeasedScheduler.select` decides with
    // `if (held.workerId === input.workerId) return true;`, whose purpose is "my own lease,
    // take it back". Fed the two names the planes above actually journaled: the holder may
    // re-take its own live lease, and the other plane may not touch it. With the old default
    // both of these printed ["t"], because both planes were "worker-0".
    const s = new LeasedScheduler({ leaseMs: 30_000 });
    const ask = (workerId: string): readonly string[] =>
      s
        .select({
          projection: { status: "running", tasks: { t: { taskId: "t", nodeId: "n", branch: "", state: "ready", attempt: 1, lease: { workerId: names[0]!, at: 1000 } } } },
          graph: { plans: { n: { criticalPathLength: 0 } } },
          nodes: new Map([["n", { id: "n", type: "tool" }]]),
          maxParallelism: 4,
          now: 1100,
          workerId,
        } as never)
        .map((r) => String(r.task.taskId));
    assert.deepEqual(ask(names[0]!), ["t"], "the holder may re-take its own live lease — that is what the identity arm is for");
    assert.deepEqual(ask(names[1]!), [], "and the other plane may not: somebody else's live lease is somebody else's work");
  } finally {
    d.dispose();
  }
});

// ── 4 · what naming the planes COSTS a restart, measured ────────────────────

/**
 * THE TRADE THE IDENTITY FIX MADE, PRICED — TODO.md §A.17.
 *
 * Test 3 establishes that a live foreign lease is not selectable. The same line has a second
 * consequence nobody had measured: a plane that RESTARTS comes back under a new name, so its
 * OWN pre-restart leases are foreign to it too, and it waits for `reclaimable()` rather than
 * taking them back through the identity arm. Arguably correct — after a restart those leases
 * ARE held by a process that is gone — but "arguably correct" is not a number, and a fast
 * redeploy is the case where a number decides whether the trade is acceptable.
 *
 * TWO NAMES FROM A REAL RESTART, not two literals: `d.open()` twice around a `close()` is the
 * harness's restart, and both names are read back out of `task.leased`, so this measures the
 * identity the product actually journals. WHAT THAT DOES NOT COVER, per `harness.ts`: it is
 * one OS process, so the two names differ in their ORDINAL where a real restart differs in its
 * PID. The property under test — the restarted plane does not answer to the old name — is the
 * same either way, and it is the only thing the scheduler reads.
 *
 * OFFLINE AND DETERMINISTIC, and specifically NOT A TIMING: every `now` here is an integer
 * handed to `select`, and the answer is a set of task ids. Nothing sleeps and no elapsed time
 * is asserted on. The searched boundary is the product's own arithmetic, not a stopwatch.
 *
 * IT PINS THE PRICE RATHER THAN A FIX, and that is deliberate — see `planeWorkerId` for why no
 * identity can do better without a coordinator. It goes red in the direction that matters: an
 * identity made stable across restarts would let the restarted plane take the lease at t=1100,
 * which is the double-execution defect test 3 exists to keep closed.
 */
test("A RESTARTED PLANE WAITS EXACTLY ONE LEASE FOR ITS OWN ORPHANED WORK, AND NO LONGER", async () => {
  const d = deployment();
  try {
    const one = await parked(d);
    const second = await parked(d);
    let before: string;
    let after: string;
    {
      const w = d.open();
      try {
        await armForeignGates(w, new Map<RunId, Seq>());
        await w.engine.resolveGate(one.runId, { gateId: one.gateId, actor: ALICE, decision: { kind: "approve" }, idempotencyKey: "k-1" });
        before = String(((await events(w.store, one.runId)).filter((e) => e.type === "task.leased").at(-1)!.payload as { workerId: string }).workerId);
      } finally {
        w.close();
      }
    }
    // THE RESTART. A second `openWorkspace` over the same directory, leasing on its own run so
    // the name it journals is its own rather than a copy of the first plane's.
    {
      const w = d.open();
      try {
        await armForeignGates(w, new Map<RunId, Seq>());
        await w.engine.resolveGate(second.runId, { gateId: second.gateId, actor: ALICE, decision: { kind: "approve" }, idempotencyKey: "k-2" });
        after = String(((await events(w.store, second.runId)).filter((e) => e.type === "task.leased").at(-1)!.payload as { workerId: string }).workerId);
      } finally {
        w.close();
      }
    }
    assert.notEqual(before, after, "the precondition: a restart changes the name, which is what costs the wait");

    const LEASE_MS = 30_000;
    const AT = 1_000;
    const s = new LeasedScheduler({ leaseMs: LEASE_MS });
    const ask = (workerId: string, now: number, state: "ready" | "leased"): readonly string[] =>
      s
        .select({
          projection: { status: "running", tasks: { t: { taskId: "t", nodeId: "n", branch: "", state, attempt: 1, lease: { workerId: before, at: AT } } } },
          graph: { plans: { n: { criticalPathLength: 0 } } },
          nodes: new Map([["n", { id: "n", type: "tool" }]]),
          maxParallelism: 4,
          now,
          workerId,
        } as never)
        .map((r) => String(r.task.taskId));

    // THE COST IS ZERO ON THE CASE THAT SOUNDS WORST. A task genuinely in flight when the
    // plane died is `leased`, and `reclaimable` expires EVERY holder including the one that
    // took it — so the pre-restart plane had no head start to lose here.
    assert.deepEqual(ask(before, 1_100, "leased"), [], "not even its own live lease is reclaimed early");
    assert.deepEqual(ask(after, 1_100, "leased"), [], "so a restart costs a genuinely-leased task nothing");

    // AND IT IS ONE LEASE ON THE CASE THAT ACTUALLY PAYS: a retry or a resolved gate returns a
    // task to `ready` without clearing who last held it, and there the identity arm is what a
    // restart loses.
    assert.deepEqual(ask(before, 1_100, "ready"), ["t"], "the same plane takes its own ready-with-a-lease task back at once");
    assert.deepEqual(ask(after, 1_100, "ready"), [], "the restarted one may not — this is the wait being measured");

    // THE NUMBER, SEARCHED RATHER THAN ASSUMED. The first instant the restarted plane may take
    // the task is the product's arithmetic, not a constant copied out of it.
    for (const state of ["ready", "leased"] as const) {
      let n = AT;
      while (n < AT + 5 * LEASE_MS && ask(after, n, state).length === 0) n += 1;
      assert.equal(n - AT, LEASE_MS + 1, `a restarted plane waits one leaseMs for a ${state} task, not ${String(n - AT)}ms`);
    }
  } finally {
    d.dispose();
  }
});

// ── 5 · and the product's own judge agrees ──────────────────────────────────

test("THE JOURNAL TWO PLANES PRODUCE PASSES `auditRun` WITH NO VIOLATIONS", async () => {
  // The producer is checked by the JUDGE the product ships, not by a bespoke assertion — and
  // the judge is the one that called the corrupt version of this journal `ok`. Its three new
  // at-most-once rules are exactly the ones a second writer breaks, so a regression in the
  // write door shows up here as well as in test 1, from the other direction.
  const d = deployment();
  try {
    const { runId, gateId } = await parked(d);
    const two = planes(d, 2);
    try {
      const [a, b] = two.all as [(typeof two.all)[number], (typeof two.all)[number]];
      await armForeignGates(a, new Map<RunId, Seq>());
      await armForeignGates(b, new Map<RunId, Seq>());
      await Promise.allSettled([
        a.engine.resolveGate(runId, { gateId, actor: ALICE, decision: { kind: "approve" }, idempotencyKey: "k-a" }),
        b.engine.resolveGate(runId, { gateId, actor: ALICE, decision: { kind: "reject", reason: "no" }, idempotencyKey: "k-b" }),
      ]);
      const report = auditRun(await events(a.store, runId));
      assert.deepEqual(report.violations, [], `a two-writer journal must hold together: ${JSON.stringify(report.violations, null, 2)}`);
      // NOT VACUOUS. A report with none of the three new rules checked would pass the line
      // above while proving nothing about them.
      for (const rule of ["gate.decided-once", "run.terminal-is-last-and-once", "task.leased-once"] as const) {
        assert.ok(report.checked.includes(rule), `${rule} must have SEEN this journal, not skipped it`);
      }
    } finally {
      two.dispose();
    }
  } finally {
    d.dispose();
  }
});
