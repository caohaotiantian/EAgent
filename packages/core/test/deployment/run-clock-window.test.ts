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
 * The clock ROTATES its window, and these three tests pin the ROTATION rather than only the
 * property, so replacing the mechanism has to move them deliberately. It has been replaced
 * once already: the offset used to be a counter in the clock's closure, which reset to 0 at
 * every boot and is why `run-clock-survives-restart.test.ts` exists. It is now derived from
 * `now`, so every test here advances the clock between ticks instead of holding a `rot`.
 *
 * What the rotation does not promise, and this file does not test, is fairness against a
 * stream of NEW submissions: a run pushed down the listing while the window is above it waits
 * for the next lap.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { RUN_CLOCK_SCAN_CEILING, runClockTick, runClockWindow } from "../../src/cli.ts";
import type { RunId } from "../../src/ids.ts";
import { deployment, fillRuns } from "./harness.ts";

const LIMIT = 200;
const T0 = 1_700_000_000_000;
/** The tick period these tests drive at, and therefore the lap the window advances by. */
const LAP = 1_000;

test("EVERY RUN IS REACHED, INCLUDING THE ONE PAST THE WINDOW", async () => {
  const d = deployment();
  const ws = d.open();
  try {
    const ids = await fillRuns(ws.store, 201, T0);
    const oldest = ids[0]!;
    const newest = ids.at(-1)!;

    // The starvation, measured on the real store before anything is asserted about the fix.
    const listed = (await ws.store.listRuns(LIMIT)).map((r) => r.runId);
    assert.equal(listed.length, LIMIT);
    assert.equal(listed.includes(newest), true, "listRuns(200) is newest-first…");
    assert.equal(listed.includes(oldest), false, "…so with 201 runs the oldest is not in it");

    // Two ticks is `ceil(201 / 200)`, and the union has to be everything.
    const seen = new Set<RunId>();
    let ticks = 0;
    while (!seen.has(oldest) && ticks < 4) {
      const tick = await runClockTick(ws, LIMIT, ticks * LAP, RUN_CLOCK_SCAN_CEILING, LAP);
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
  // is the same defect with the sign flipped: the clock has to come back. It wraps AROUND
  // rather than resetting, so no tick is short and no tick is empty — the seam a
  // reset-to-zero left is what made a 5-run store spend a third of its ticks folding one row.
  const d = deployment();
  const ws = d.open();
  try {
    const ids = await fillRuns(ws.store, 5, T0);
    const laps: RunId[][] = [];
    for (let i = 0; i < 3; i++) laps.push([...(await runClockTick(ws, 2, i * LAP, RUN_CLOCK_SCAN_CEILING, LAP)).visited]);
    assert.deepEqual(
      laps.map((l) => l.length),
      [2, 2, 2],
      "windows of 2 over 5 runs: every tick folds a full window, because the ring has no seam",
    );
    assert.deepEqual(new Set(laps.flat()).size, 5, "and three ticks of 2 cover all five");
    // Positions 0, 2, 4 then 1, 3 — a stride of 2 around a ring of 5 closes after FIVE steps,
    // not after three. Asserted where it actually closes, because "it wraps" and "it wraps
    // where I guessed" are different claims and only the second one is checkable.
    const sixth = (await runClockTick(ws, 2, 5 * LAP, RUN_CLOCK_SCAN_CEILING, LAP)).visited;
    assert.deepEqual([...sixth], laps[0], "the ring closes: the sixth tick sees exactly what the first saw");
    assert.deepEqual([...laps[0]!], ids.slice(-2).reverse(), "and lap 0 is the newest two");
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
    const ids = await fillRuns(ws.store, 12, T0);
    const first = await runClockTick(ws, 5, 0, CEILING, LAP);
    assert.equal(first.truncated, true, "twelve runs against a ceiling of ten must say so on EVERY tick");
    const second = await runClockTick(ws, 5, LAP, CEILING, LAP);
    assert.notDeepEqual([...second.visited], [...first.visited], "and the window moves between them");

    // THE RESIDUAL HOLE, pinned rather than papered over: the two oldest of twelve are past a
    // ceiling of ten, and no lap reaches them. `truncated` is the only reason anyone knows.
    const reached = new Set([...first.visited, ...second.visited]);
    assert.equal(reached.size, 10);
    assert.equal(reached.has(ids[0]!), false, "the oldest run is past the ceiling and stays there");
    assert.equal(reached.has(ids[1]!), false);

    // AND A LISTING WELL INSIDE THE CEILING HIDES NOTHING — the negative half, without which
    // `truncated` could be hard-coded `true` and every assertion above would still hold.
    const roomy = await runClockTick(ws, 5, 0, 100, LAP);
    assert.equal(roomy.truncated, false);
  } finally {
    ws.close();
    d.dispose();
  }
});

test("THE WINDOW IS ARITHMETIC, and this is where the numbers go in directly", () => {
  // `runClockWindow` is separated from the tick so the rotation's argument can be checked
  // without a store in the way. Positions are `limit` apart around a ring of `n`.
  assert.deepEqual(runClockWindow(5, 2, 0, LAP), [0, 1]);
  assert.deepEqual(runClockWindow(5, 2, LAP, LAP), [2, 3]);
  assert.deepEqual(runClockWindow(5, 2, 2 * LAP, LAP), [4, 0], "it wraps AROUND rather than stopping short");
  assert.deepEqual(runClockWindow(5, 2, 5 * LAP, LAP), [0, 1], "and the ring closes after n/gcd steps");

  // THE COVERAGE ARGUMENT, run rather than asserted: every row of a 201-listing at limit 200
  // is inside one of the first ceil(201/200) windows, from ANY starting instant.
  for (const start of [0, 7 * LAP, 1_000_003 * LAP]) {
    const seen = new Set<number>();
    for (let t = 0; t < 2; t++) for (const i of runClockWindow(201, 200, start + t * LAP, LAP)) seen.add(i);
    assert.equal(seen.size, 201, `two ticks from ${start} must cover all 201 positions, saw ${seen.size}`);
  }

  // THE DEGENERATE INPUTS, because a clock handed one of these must fold the first window
  // rather than silently fold nothing — `(x % 0)` is NaN and `Array.from({length: NaN})` is [].
  assert.deepEqual(runClockWindow(0, 200, 5 * LAP, LAP), [], "no runs is no window");
  assert.deepEqual(runClockWindow(3, 200, 5 * LAP, LAP), [0, 1, 2], "a limit wider than the listing takes all of it");
  assert.deepEqual(runClockWindow(5, 2, -1, LAP), [0, 1], "a negative instant is the first window, not NaN");
  assert.deepEqual(runClockWindow(5, 2, 3 * LAP, 0), [0, 1], "and so is a zero period");
});
