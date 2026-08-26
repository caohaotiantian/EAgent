/**
 * THE ARMING'S MEMO IS BOUNDED BY THE WINDOW — which only more than 500 GATES can show.
 *
 * `armForeignGates` keeps `armed: Map<RunId, Seq>` so a tick that finds nothing new pays no
 * fold, and prunes it to the runs the tick can still see. Two failure modes, opposite ends:
 *
 *   - NO PRUNE and the map is write-only. A `loom serve` that is up for a month holds one
 *     entry per run it ever listed, to answer a question about gates the clock stopped
 *     watching long ago. Measured below: 1,040 gated runs, two ticks, 1,000 entries.
 *   - PRUNE TOO HARD (`armed.clear()` per tick) and the memo is gone: every tick re-folds
 *     every run in view — the exact cost `ControlPlane` declined to pay per request.
 *
 * WHY THE FIRST TEST OF THIS SHIPPED TOOTHLESS, since that is the lesson. It filled 250
 * runs that never gate, and both halves of the clock list `{ raisedAGate: true }` — so the
 * FILTER already held the view at one row and the map could not have grown whether it was
 * pruned or not. Re-measured here: with the two prune lines deleted, the deployment suite as it
 * then stood printed 5 pass / 0 fail, the test named for the prune among them. Ungated traffic
 * cannot exercise this — the window is `GATE_CLOCK_LIMIT` GATED runs, and the only thing that
 * pushes a gate out of it is another gate.
 *
 * SO THIS FILE IS DELIBERATELY BLIND TO THE FILTER, and that is what makes it a test of the
 * prune SPECIFICALLY. Every run here gates, so `listRuns(N, { raisedAGate: true })` and the
 * unfiltered `listRuns(N)` return the same rows in the same order — ULID run ids and gate
 * timestamps both ascend with `sinceTs`. MEASURED, one mutation at a time, against the suite as
 * it now stands: delete the filter and this file stays green while `gate-clock-restart.test.ts`
 * fails on `gate.timeout, run.failed`; delete the prune and exactly the reverse. Two decisions,
 * two tests, neither standing in for the other.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { GATE_CLOCK_LIMIT, armForeignGates } from "../../src/cli.ts";
import type { RunId, Seq } from "../../src/ids.ts";
import { deployment, fillGatedRuns } from "./harness.ts";

/** Enough to turn the whole window over twice, and no more: each batch fills it and spills. */
const BATCH = GATE_CLOCK_LIMIT + 20;

/** A clock tick's worth of arming, with the folds it paid counted. */
async function tick(ws: { engine: { projection: unknown } }, armed: Map<RunId, Seq>): Promise<number> {
  const engine = ws.engine as { projection: (runId: RunId) => Promise<unknown> };
  const real = engine.projection.bind(engine);
  let folds = 0;
  engine.projection = (runId: RunId): Promise<unknown> => {
    folds++;
    return real(runId);
  };
  try {
    await armForeignGates(ws as never, armed);
    return folds;
  } finally {
    delete (engine as { projection?: unknown }).projection;
  }
}

test("the arming's memo is bounded by the window, not by the journal", async () => {
  const d = deployment();
  try {
    const ws = d.open();
    try {
      // ── batch A: one full window of gates, plus a spill so the window is genuinely full.
      const a = await fillGatedRuns(ws.store, BATCH, 1_700_000_000_000);
      const firstFolds = await tick(ws, new Map<RunId, Seq>());
      const armed = new Map<RunId, Seq>();
      await tick(ws, armed);
      assert.equal(
        armed.size,
        GATE_CLOCK_LIMIT,
        `a full window must arm exactly the window: ${armed.size} entries for ${BATCH} gated runs`,
      );
      assert.equal(firstFolds, GATE_CLOCK_LIMIT, "and a cold tick folds each of them once");
      assert.equal(
        armed.has(a[0]!),
        false,
        "the oldest gate of the batch is past the window and must not be armed",
      );

      // ── batch B: another full window of NEWER gates. Every row batch A put in view is now
      // out of it, so the memo's contents and the tick's view are disjoint sets.
      await fillGatedRuns(ws.store, BATCH, 1_700_000_000_000 + BATCH);
      const secondFolds = await tick(ws, armed);

      const view = await ws.store.listRuns(GATE_CLOCK_LIMIT, { raisedAGate: true });
      assert.equal(view.length, GATE_CLOCK_LIMIT);
      const inView = new Set(view.map((r) => r.runId));
      assert.equal(
        [...armed.keys()].every((id) => inView.has(id)),
        true,
        `the memo may not remember a run the clock cannot see: ${[...armed.keys()].filter((id) => !inView.has(id)).length} of ${armed.size} entries are out of view`,
      );
      // THE NUMBER THE PRUNE IS WORTH. Without it: 1,000 — every id from both windows.
      assert.equal(
        armed.size,
        GATE_CLOCK_LIMIT,
        `the memo must not grow past the window: ${armed.size} entries after ${BATCH * 2} gated runs`,
      );
      assert.equal(secondFolds, GATE_CLOCK_LIMIT, "a turned-over window costs one fold per new run");

      // ── the other end: a tick with nothing new must still cost nothing. A prune that
      // clears the map instead of narrowing it passes every assertion above and fails here.
      const before = new Map(armed);
      const idleFolds = await tick(ws, armed);
      assert.equal(idleFolds, 0, `an idle tick must fold nothing; it folded ${idleFolds}`);
      assert.deepEqual([...armed.keys()].sort(), [...before.keys()].sort(), "and must arm the same set");
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});
