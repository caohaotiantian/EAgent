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

import { RUN_CLOCK_SCAN_CEILING, runClockTick } from "../../src/cli.ts";
import type { RunId } from "../../src/ids.ts";
import { deployment, fillRuns } from "./harness.ts";

const LIMIT = 200;
const LAP = 1_000;

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
        const tick = await runClockTick(w, LIMIT, boot * LAP, RUN_CLOCK_SCAN_CEILING, LAP);
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
      const t = await runClockTick(ws, LIMIT, tick * LAP, RUN_CLOCK_SCAN_CEILING, LAP);
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
        const x = await runClockTick(a, LIMIT, at, RUN_CLOCK_SCAN_CEILING, LAP);
        const y = await runClockTick(b, LIMIT, at, RUN_CLOCK_SCAN_CEILING, LAP);
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
