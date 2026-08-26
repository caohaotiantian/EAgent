/**
 * THE OLDEST RUN IS NOT STARVED BY THE 200-RUN WINDOW.
 *
 * `startRunClock` is the only thing that comes back to a run whose retry backoff has elapsed
 * when nothing else is driving it — a run submitted over HTTP, or one a restarted plane
 * picked up. It found its runs through `listRuns(200)`, which is `ORDER BY run_id DESC`, so
 * with 201 live runs the 201st was never listed, never projected, never advanced: it waited
 * for a human to POST `{"kind":"advance"}` by hand, forever. That is a scheduling policy —
 * "the oldest run is dropped" — and nobody chose it or wrote it down.
 *
 * MEASURED, and it is what the first assertion below pins: 201 run heads in a
 * `SqliteStateStore`, `listRuns(200)` returns 200, the newest present and the oldest absent.
 *
 * The clock now ROTATES its window: each tick takes the next `limit` rows and wraps at the
 * end of the listing, so work per tick is still bounded by `limit` folds and every run within
 * `RUN_CLOCK_SCAN_CEILING` is reached within `ceil(N / limit)` ticks. What that does not
 * promise, and this file does not test, is fairness against a stream of NEW submissions: a
 * run pushed down the listing while the window is above it waits for the next lap.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { RUN_CLOCK_SCAN_CEILING, runClockTick, type RunClockRotation } from "../../src/cli.ts";
import type { RunId } from "../../src/ids.ts";
import { deployment, fillRuns } from "./harness.ts";

const LIMIT = 200;

test("EVERY RUN IS REACHED, INCLUDING THE ONE PAST THE WINDOW", async () => {
  const d = deployment();
  const ws = d.open();
  try {
    const ids = await fillRuns(ws.store, 201, 1_700_000_000_000);
    const oldest = ids[0]!;
    const newest = ids.at(-1)!;

    // The starvation, measured on the real store before anything is asserted about the fix.
    const listed = (await ws.store.listRuns(LIMIT)).map((r) => r.runId);
    assert.equal(listed.length, LIMIT);
    assert.equal(listed.includes(newest), true, "listRuns(200) is newest-first…");
    assert.equal(listed.includes(oldest), false, "…so with 201 runs the oldest is not in it");

    // Two ticks is `ceil(201 / 200)`, and the union has to be everything.
    const rot: RunClockRotation = { offset: 0 };
    const seen = new Set<RunId>();
    let ticks = 0;
    while (!seen.has(oldest) && ticks < 4) {
      const tick = await runClockTick(ws, rot, LIMIT, 1_700_000_000_000);
      assert.ok(tick.visited.length <= LIMIT, `a tick must fold at most ${LIMIT} runs, not ${tick.visited.length}`);
      for (const id of tick.visited) seen.add(id);
      ticks++;
    }
    assert.equal(seen.has(oldest), true, `the oldest run must be reached; ${ticks} ticks saw ${seen.size} of 201 runs`);
    assert.equal(ticks, 2, "and it must take ceil(201/200) ticks to get there, not a lucky one");
    assert.equal(seen.size, 201, "the union of one lap is every run");
  } finally {
    ws.close();
    d.dispose();
  }
});

test("the rotation wraps, so a run is visited again on the next lap", async () => {
  // A rotation that reached the end and stopped would starve the NEWEST runs instead, which
  // is the same defect with the sign flipped: the clock has to come back.
  const d = deployment();
  const ws = d.open();
  try {
    const ids = await fillRuns(ws.store, 5, 1_700_000_000_000);
    const rot: RunClockRotation = { offset: 0 };
    const laps: RunId[][] = [];
    for (let i = 0; i < 3; i++) laps.push([...(await runClockTick(ws, rot, 2, 1_700_000_000_000)).visited]);
    assert.deepEqual(
      laps.map((l) => l.length),
      [2, 2, 1],
      "windows of 2 over 5 runs: two full and one short, then a wrap",
    );
    assert.deepEqual(new Set(laps.flat()).size, 5, "one lap covers all five");
    const fourth = (await runClockTick(ws, rot, 2, 1_700_000_000_000)).visited;
    assert.deepEqual([...fourth], ids.slice(-2).reverse(), "and the fourth tick is back at the newest two");
  } finally {
    ws.close();
    d.dispose();
  }
});

test("the scan is bounded, and a deployment past the bound is TOLD", async () => {
  // The ceiling is the part that is still a BOUND rather than a fix, so the one thing it may
  // not be is silent — that is the whole complaint against the 200 it replaces. Driven with an
  // injected ceiling of 10 rather than by journaling ten thousand runs; the shipped constant
  // is the same code path with a bigger number.
  const CEILING = 10;
  const d = deployment();
  const ws = d.open();
  try {
    const ids = await fillRuns(ws.store, 12, 1_700_000_000_000);
    const rot: RunClockRotation = { offset: 0 };
    const first = await runClockTick(ws, rot, 5, 1_700_000_000_000, CEILING);
    assert.equal(first.truncated, false, "a window well inside the ceiling hides nothing");
    assert.equal(rot.offset, 5, "and it advances");

    const second = await runClockTick(ws, rot, 5, 1_700_000_000_000, CEILING);
    assert.equal(second.truncated, true, "a window that fills while sitting on the ceiling must say so");
    assert.equal(rot.offset, 0, "and it wraps rather than climbing past a bound it cannot page through");

    // THE RESIDUAL HOLE, pinned rather than papered over: the two oldest of twelve are past a
    // ceiling of ten, and no lap reaches them. `truncated` is the only reason anyone knows.
    const reached = new Set([...first.visited, ...second.visited]);
    assert.equal(reached.size, 10);
    assert.equal(reached.has(ids[0]!), false, "the oldest run is past the ceiling and stays there");
    assert.equal(reached.has(ids[1]!), false);
  } finally {
    ws.close();
    d.dispose();
  }
});
