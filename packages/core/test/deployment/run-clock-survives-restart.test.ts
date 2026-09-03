/**
 * THE 200-RUN STARVATION WAS FIXED FOR A PLANE THAT STAYS UP AND UNFIXED FOR ONE THAT RESTARTS.
 *
 * `run-clock-window.test.ts` establishes that the clock's window rotates, so every run within
 * the scan ceiling is reached within `ceil(N / limit)` ticks. Every one of its tests held ONE
 * rotation object across every tick — which is a plane that never goes down, and is not the
 * shape a crash-looping or frequently-redeployed plane has. `startRunClock` built
 * `const rot: RunClockRotation = { offset: 0 }` in its own closure, mutated it in place, and
 * nothing reconstructed it: at every boot the window went back to the newest `limit` runs.
 *
 * MEASURED WITH ITS CONTROL, which is what makes it a defect rather than an observation.
 * 250 runs, `limit` 200, the same journal both times:
 *
 *     CONTROL long-lived rot: oldest run reached on tick 1
 *     RESTARTED rot:          oldest run reached on boot -1      (never, over 20 boots)
 *
 * The control is the load-bearing half. Without it, "the oldest run was never reached" is
 * equally consistent with a rotation that does not work at all, and the fix for that is a
 * different fix.
 *
 * WHY IT IS A DEFECT AND NOT A TRADE. CLAUDE.md's first non-negotiable: "the journal is the
 * only authoritative state… if a decision reads a value, the journal must be able to
 * reconstruct that value — including across a restart." `rot.offset` decided WHICH RUNS GOT
 * ADVANCED, and no fold of any journal could rebuild it. That is the class
 * `oversight-survives-restart.test.ts` names, arriving in a producer nobody had checked.
 *
 * THE FIX IS TO REMEMBER NOTHING. The window is `(floor(now / lapMs) * limit) mod N`, so a
 * plane that restarts between every tick computes the same window a plane that stayed up would
 * have. This file is the test that says so, and it is written the way the defect was measured:
 * a fresh `openWorkspace` per tick, which is the closest an in-process test gets to a boot.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { main, runClockTick } from "../../src/cli.ts";
import { newRunId, type RunId, type TaskId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { deployment, fillRuns, publishGraph, quiet } from "./harness.ts";

const LIMIT = 200;
const LAP = 1_000;
/** The one node's task in `ONE_TOOL`, as the engine names it. Asserted on, not assumed. */
const TASK = "apply@root#0" as TaskId;

test("A CLOCK WHOSE PROCESS RESTARTS BETWEEN EVERY TICK STILL REACHES THE OLDEST RUN", async () => {
  const d = deployment();
  try {
    let oldest: RunId;
    {
      const w = d.open();
      // 250 against a window of 200: enough that the oldest is out of the first window, which
      // the assertion below re-measures rather than assuming.
      oldest = (await fillRuns(w.store, 250, 1_700_000_000_000))[0]!;
      const first = (await w.store.listRuns(LIMIT)).map((r) => r.runId);
      assert.equal(first.includes(oldest), false, "the precondition: the oldest run is past an unrotated window of 200");
      w.close();
    }

    // A BOOT PER TICK. `d.open()` is a new Engine, a new broker, a new SQLite handle and a new
    // `startRunClock` closure — everything a restart rebuilds. The clock advances by one lap
    // between boots because that is what the wall clock does while a process is coming back.
    const seen = new Set<RunId>();
    let reached = -1;
    for (let boot = 0; boot < 4; boot++) {
      const w = d.open();
      try {
        const tick = await runClockTick(w, LIMIT, boot * LAP, LAP);
        for (const id of tick.visited) seen.add(id);
        if (reached < 0 && tick.visited.includes(oldest)) reached = boot;
      } finally {
        w.close();
      }
    }
    assert.notEqual(reached, -1, `the oldest run must be reached across restarts; 4 boots saw ${seen.size} of 250 runs`);
    assert.ok(reached <= 1, `and within ceil(250/200) boots, not ${reached}`);
    assert.equal(seen.size, 250, "and a full lap of boots covers every run");
  } finally {
    d.dispose();
  }
});

test("THE CONTROL: A PLANE THAT STAYS UP IS NOT MADE WORSE BY THE FIX", async () => {
  // The other half of the measurement that found the defect. A long-lived rotation reached the
  // oldest run on tick 1, and that is the behaviour a stateless window has to MATCH rather
  // than merely differ from — otherwise "it survives a restart" could be bought by making
  // every tick scan everything, which is the bound the ceiling exists to keep.
  const d = deployment();
  const ws = d.open();
  try {
    const oldest = (await fillRuns(ws.store, 250, 1_700_000_000_000))[0]!;
    let reached = -1;
    for (let tick = 0; tick < 4 && reached < 0; tick++) {
      const t = await runClockTick(ws, LIMIT, tick * LAP, LAP);
      assert.ok(t.visited.length <= LIMIT, `work per tick is still bounded by limit: ${t.visited.length}`);
      if (t.visited.includes(oldest)) reached = tick;
    }
    assert.equal(reached, 1, "one plane that stays up still reaches the oldest run on tick 1");
  } finally {
    ws.close();
    d.dispose();
  }
});

test("TWO PLANES THAT NEVER SPOKE COMPUTE THE SAME WINDOW", async () => {
  // The property that replaces the one the counter had. Two counters in two processes are two
  // different answers to "which runs are in view"; a derivation is one answer, and a plane
  // that boots mid-lap is in step with one that has been up for a week.
  //
  // It is not coordination and the tick's docstring says so: they scan the SAME window and
  // duplicate the folds. What it buys is that neither of them is stuck at offset 0.
  const d = deployment();
  try {
    {
      const w = d.open();
      await fillRuns(w.store, 250, 1_700_000_000_000);
      w.close();
    }
    const a = d.open();
    const b = d.open();
    try {
      for (const at of [0, LAP, 7 * LAP]) {
        const x = await runClockTick(a, LIMIT, at, LAP);
        const y = await runClockTick(b, LIMIT, at, LAP);
        assert.deepEqual([...x.visited], [...y.visited], `two planes at the same instant must be looking at the same runs (t=${at})`);
      }
    } finally {
      a.close();
      b.close();
    }
  } finally {
    d.dispose();
  }
});

/**
 * THE SET THE CLOCK RE-OFFERS, INCLUDING THE ONE IT USED TO ABANDON.
 *
 * The three tests above are about a window: given a run the clock CAN advance, does a restart
 * still reach it? This is the other half. A plane that dies BETWEEN `task.leased` and
 * `task.committed` leaves that task `leased` — the state only advances when its holder commits,
 * and its holder is gone. `runClockTick`'s `due` predicate wanted a `ready` task, so such a run
 * was `running`, in view, and never driven, at every tick from then on.
 *
 * BUILT FROM A REAL JOURNAL, not from hand-written events: a `loom run` of a one-tool graph is
 * driven to completion through `main`, and its first five events — up to and including
 * `task.leased` — are replayed onto a fresh run id. That is exactly the prefix a plane killed
 * mid-`advance` leaves behind, and every payload in it is one the product wrote.
 *
 * WITH ITS CONTROL, for the reason the first test in this file has one: "the stranded run was
 * never driven" is equally consistent with a clock that drives nothing at all, and the fix for
 * that is a different fix. The control is the same journal truncated one event earlier — a
 * task still `ready` — and it IS driven, on the same tick.
 *
 * WIDENING THE PREDICATE DID NOT HELP UNTIL THREE THINGS WERE TRUE, and this test is where
 * the number changed. `InProcessScheduler` grew a reclaim arm that takes a lease back past the
 * node's own declared deadline; `Engine.#advanceSerially` now asks `select` BEFORE it decides a
 * run is over, where it used to return sixty-five lines earlier; and it no longer FINISHES a run
 * that still holds a lease, which is what makes driving a live-leased run a fold and a no-op
 * rather than a `failed` verdict on someone else's work in flight.
 *
 * SO THE ASSERTION IS THAT IT IS DRIVEN, not that it is reclaimed. This journal's `fs.write`
 * node carries no declared `timeoutMs`, so the scheduler correctly refuses to guess that its
 * holder is dead — "I do not know" is not "the holder is gone". What the clock owes it is a
 * drive; what happens on that drive is the scheduler's question and
 * `test/run/inprocess-reclaims-a-dead-lease.test.ts` asks it. The run staying `running` rather
 * than being declared `failed` is the second half of the same rule.
 */

const ONE_TOOL = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "stranded", project: "deployment", version: 1 },
  policy: { posture: "on", capabilities: ["fs:write"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [{ id: "apply", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "fs.write", version: "1.0", args: { path: "out/a.txt", body: "${note}" } } }],
  edges: [],
};

test("A RUN WHOSE TASK WAS LEASED WHEN THE PLANE DIED IS DRIVEN AFTER THE RESTART, NOT ABANDONED", async () => {
  const d = deployment();
  try {
    const file = publishGraph(d, "stranded", ONE_TOOL);
    const { value: code } = await quiet(() => main(["run", file, "--workspace", d.dir, "--input", '{"note":"x"}']));
    assert.equal(code, 0, "the donor run must succeed — its journal is what the two truncations are cut from");

    // TWO TRUNCATIONS OF THE SAME REAL JOURNAL, one event apart: `…, task.ready` and
    // `…, task.ready, task.leased`. Everything else about the two runs is identical, so the
    // only thing the clock can be answering differently on is the lease.
    let ready: RunId;
    let leased: RunId;
    {
      const w = d.open();
      try {
        const donor = (await w.store.listRuns(10))[0]!.runId;
        const evs: JournalEvent[] = [];
        for await (const e of w.store.read(donor, 1)) evs.push(e);
        const types = evs.map((e) => e.type);
        assert.deepEqual(
          types.slice(0, 5),
          ["run.submitted", "run.compiled", "run.started", "task.ready", "task.leased"],
          `the donor's prefix is what this test cuts: ${types.join(", ")}`,
        );
        const copy = async (upTo: number, at: number): Promise<RunId> => {
          const runId = newRunId(at);
          await w.store.append({
            runId,
            expectedSeq: 0,
            now: at,
            events: evs.slice(0, upTo).map((e) => ({ type: e.type, payload: e.payload, actor: e.actor, ...(e.taskId === undefined ? {} : { taskId: e.taskId }) })) as never,
          });
          return runId;
        };
        ready = await copy(4, 1_700_000_000_001);
        leased = await copy(5, 1_700_000_000_002);
      } finally {
        w.close();
      }
    }

    // THE RESTART: a new Engine, a new broker, a new SQLite handle, folding those journals for
    // the first time. Every process-local container in `cli.ts` is empty here by construction.
    const w = d.open();
    try {
      assert.equal(
        (await w.engine.projection(leased))?.tasks[TASK]?.state,
        "leased",
        "the precondition: the fold puts the task back in `leased`, because nothing committed it",
      );
      assert.equal((await w.engine.projection(ready))?.tasks[TASK]?.state, "ready", "and the control's task folds back to `ready`");

      const driven: RunId[] = [];
      const t = await runClockTick(w, LIMIT, 1_700_000_000_100, LAP, (runId: RunId) => void driven.push(runId));

      assert.ok(t.visited.includes(leased), "the stranded run IS in the clock's window — it is not a listing problem");
      assert.ok(driven.includes(leased), "and it IS driven: `due` counts a leased task, not only a ready one");
      assert.ok(driven.includes(ready), "THE CONTROL: the same journal one event shorter IS driven on the same tick");
      // AND THE DRIVE DID NOT KILL IT. With no declared deadline on this node the scheduler
      // will not take the lease back, so the honest outcome is a run still `running` with its
      // task still `leased` — where before the engine's short-circuit finished it `failed`.
      const after = (await w.engine.projection(leased))!;
      assert.equal(after.status, "running", "a lease nobody can adjudicate leaves the run running, not failed");
      assert.equal(after.tasks[TASK]?.state, "leased", "and the task is exactly where the crash left it");
    } finally {
      w.close();
    }
  } finally {
    d.dispose();
  }
});
