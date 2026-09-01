/**
 * NO RUN IS OUT OF THE RUN CLOCK'S REACH — AT ANY NUMBER OF RUNS.
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
 * THIS FILE PINNED THE OPPOSITE OF ITS OWN TITLE UNTIL NOW, and that is the history worth
 * keeping. The first fix rotated a window over `listRuns(RUN_CLOCK_SCAN_CEILING)` — ten
 * thousand summary rows, indexed into by arithmetic — and the third test here asserted, green,
 * that the two runs below the ceiling were reached by NO lap and that `truncated` was "the only
 * reason anyone knows". A green test can pin a starvation as readily as it pins a fix; the
 * question a reader has to keep asking is which of the two it is looking at. That case is now
 * its opposite: the runs past where the ceiling stood are reached, and the ceiling is gone.
 *
 * WHAT REPLACED IT is a cursor traversal — `listRuns(limit, { after })`, page after page to
 * the end of the listing — so what one tick materialises is one page and what it can REACH is
 * everything. These tests pin the TRAVERSAL and not only the property, so replacing the
 * mechanism again has to move them deliberately. It has been replaced twice already: the
 * position was a counter in the clock's closure (which reset at every boot, and is why
 * `run-clock-survives-restart.test.ts` exists), then an offset derived from `now` into a capped
 * array. It is a PAGE INDEX derived from `now` now, so every test here advances the clock
 * between ticks instead of holding state across them.
 *
 * What the traversal does not promise, and this file does not test, is fairness against a
 * stream of NEW submissions: a run pushed down the listing while the scan is above it waits
 * for the next lap.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { runClockTick } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { RunId } from "../../src/ids.ts";
import type { RunFilter, RunSummary } from "../../src/journal/store.ts";
import { deployment, fillRuns } from "./harness.ts";

const LIMIT = 200;
const T0 = 1_700_000_000_000;
/** The tick period these tests drive at, and therefore the page the traversal advances by. */
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
      const tick = await runClockTick(ws, LIMIT, ticks * LAP, LAP);
      assert.ok(tick.visited.length <= LIMIT, `a tick must fold at most ${LIMIT} runs, not ${tick.visited.length}`);
      assert.equal(tick.pages, 2, "ceil(201/200), which is also how many ticks a full lap takes");
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

test("the traversal wraps, so a run is visited again on the next lap", async () => {
  // A scan that reached the end and stopped would starve the NEWEST runs instead, which is the
  // same defect with the sign flipped: the clock has to come back.
  const d = deployment();
  const ws = d.open();
  try {
    const ids = await fillRuns(ws.store, 5, T0);
    const laps: RunId[][] = [];
    for (let i = 0; i < 3; i++) laps.push([...(await runClockTick(ws, 2, i * LAP, LAP)).visited]);
    assert.deepEqual(
      laps.map((l) => l.length),
      [2, 2, 1],
      "pages of 2 over 5 runs: the last page of a lap is SHORT, because a page is a place in the listing " +
        "rather than a slot in a ring. The rotation this replaces folded [2, 2, 2] and got there by " +
        "visiting one run twice a lap; a lap of pages visits each run exactly once.",
    );
    assert.deepEqual(new Set(laps.flat()).size, 5, "and three ticks of 2 cover all five");
    // Pages 0, 1, 2 then back to 0 — `ceil(5/2)` is 3, so the lap closes on the FOURTH tick,
    // asserted where it actually closes rather than where it would be convenient.
    const fourth = (await runClockTick(ws, 2, 3 * LAP, LAP)).visited;
    assert.deepEqual([...fourth], laps[0], "the lap closes: the fourth tick sees exactly what the first saw");
    assert.deepEqual([...laps[0]!], ids.slice(-2).reverse(), "and page 0 is the newest two");
  } finally {
    ws.close();
    d.dispose();
  }
});

test("THE RUNS THAT USED TO BE PAST THE CEILING ARE REACHED", async () => {
  // THE OPPOSITE OF WHAT THIS CASE USED TO ASSERT, on the same journal and the same numbers.
  // It was: twelve runs, an injected ceiling of ten, two ticks of five, and the two oldest
  // "past the ceiling and stay there" — a starvation with a test holding it in place, and
  // `RunClockTick.truncated` the only report of it. There is no ceiling to inject now.
  const d = deployment();
  const ws = d.open();
  try {
    const ids = await fillRuns(ws.store, 12, T0);
    const reached = new Set<RunId>();
    let pages = 0;
    for (let i = 0; i < 3; i++) {
      const t = await runClockTick(ws, 5, i * LAP, LAP);
      assert.ok(t.visited.length <= 5, "one page per tick, still");
      pages = t.pages;
      for (const id of t.visited) reached.add(id);
    }
    assert.equal(pages, 3, "ceil(12/5) pages — the count that used to be capped at the ceiling");
    assert.equal(reached.size, 12, "one lap reaches every run");
    assert.equal(reached.has(ids[0]!), true, "including the oldest, which the ceiling put out of reach of every lap");
    assert.equal(reached.has(ids[1]!), true);
  } finally {
    ws.close();
    d.dispose();
  }
});

test("THE TRAVERSAL COSTS ONE LISTING PER PAGE, and does not re-walk", async () => {
  // The cost that replaced the ceiling, counted rather than reasoned about. The ceiling bought
  // a bound on rows per tick by giving up on the runs below it; this pays a `run_head` scan for
  // reaching them, and the thing that must not regress is the scan happening TWICE — a walk to
  // measure the listing and a second walk to reach the page. It re-fetches the chosen page by
  // CURSOR instead, which is one call.
  //
  // Counted by shadowing the instance method, so the store under it is the real SQLite one and
  // every row these calls return is a row a deployment would have read.
  const d = deployment();
  const ws = d.open();
  try {
    await fillRuns(ws.store, 12, T0);
    const calls: (RunFilter | undefined)[] = [];
    const real = ws.store.listRuns.bind(ws.store);
    (ws.store as unknown as { listRuns: unknown }).listRuns = async (
      limit?: number,
      filter?: RunFilter,
    ): Promise<readonly RunSummary[]> => {
      calls.push(filter);
      return real(limit, filter);
    };

    // PAGE 0: the walk is 3 pages (5, 5, 2 — the last short, which ends it), and the page the
    // tick folds is the one it already holds. No fourth call.
    await runClockTick(ws, 5, 0, LAP);
    assert.equal(calls.length, 3, "three pages walked, and page 0 is not fetched twice");
    assert.deepEqual(calls.map((f) => f?.after === undefined), [true, false, false], "one uncursored call, then cursors");

    // PAGE 1: the same walk, plus exactly one cursored re-fetch of the page it landed on.
    calls.length = 0;
    await runClockTick(ws, 5, LAP, LAP);
    assert.equal(calls.length, 4, "the walk, plus ONE call to fetch the chosen page — not a second walk");
  } finally {
    ws.close();
    d.dispose();
  }
});

test("THE DEGENERATE INPUTS, where a tick must fold the first page rather than nothing", async () => {
  // `runClockWindow` used to hold this arithmetic and could be handed numbers directly. The
  // page index is three lines inside the tick now, so these go in through a store — which is
  // the honest place for them anyway: two of the four are about what the LISTING answers.
  const d = deployment();
  const ws = d.open();
  try {
    assert.deepEqual((await runClockTick(ws, 5, 5 * LAP, LAP)).visited, [], "no runs is no page");
    assert.equal((await runClockTick(ws, 5, 5 * LAP, LAP)).pages, 0);

    const ids = await fillRuns(ws.store, 3, T0);
    const newestFirst = [...ids].reverse();
    assert.deepEqual(
      [...(await runClockTick(ws, 200, 5 * LAP, LAP)).visited],
      newestFirst,
      "a page wider than the listing takes all of it, and the lap is one page long",
    );
    assert.deepEqual([...(await runClockTick(ws, 2, -1, LAP)).visited], newestFirst.slice(0, 2), "a negative instant is page 0, not NaN");
    assert.deepEqual([...(await runClockTick(ws, 2, 3 * LAP, 0)).visited], newestFirst.slice(0, 2), "and so is a zero period");
    assert.deepEqual([...(await runClockTick(ws, 0, 0, LAP)).visited], [], "a page size of zero is no clock, never an unbounded walk");
  } finally {
    ws.close();
    d.dispose();
  }
});

test("A STORE WHOSE CURSOR DOES NOT ADVANCE IS REFUSED — the walk must not be unbounded", async () => {
  // THE ONLY THING THAT ENDS THE TRAVERSAL IS THE STORE. Every exit in `runClockTick`'s loop is
  // a property of the PAGE — empty, or shorter than `limit` — so a `listRuns` that accepts
  // `after` and drops it hands back the same full page forever and the tick never returns.
  // `startRunClock`'s `running` latch is then stuck true for the life of the process: the clock
  // stops advancing backed-off runs AND stops being able to say so, because its failure line is
  // on the promise's rejection path and the promise never settles.
  //
  // NOTHING IN-TREE HITS THIS. Both shipped backends implement `after` as an exclusive keyset
  // cursor and `test/journal/conformance.ts` pins it against each. `StateStore` is an extension
  // point, so this is a store a stranger can write — and "a guard that cannot decide fails
  // closed" makes a REFUSAL the required answer rather than a stall.
  const d = deployment();
  const ws = d.open();
  try {
    await fillRuns(ws.store, 12, T0);

    // The non-conforming backend in one line: the filter is taken and not applied. Shadowed over
    // the real SQLite store, so every row returned is a row a deployment would have read.
    const real = ws.store.listRuns.bind(ws.store);
    let calls = 0;
    (ws.store as unknown as { listRuns: unknown }).listRuns = async (limit?: number): Promise<readonly RunSummary[]> => {
      calls++;
      // THE HANG, MADE INTO A FAILURE. Without the boundary check this loop does not terminate,
      // and a test that hangs reports less than no test at all — so the walk is capped here, in
      // the fixture, where a cap is a test device rather than a silent re-ceiling of the tick.
      assert.ok(calls < 100, "the traversal ran unbounded against a store that ignores `after`");
      return real(limit);
    };

    await assert.rejects(
      () => runClockTick(ws, 5, 0, LAP),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /cursor does not advance/.test(e.message),
      "a non-conforming store must be refused by name, not folded as a truncated view of the journal",
    );
    assert.equal(calls, 2, "refused on the first repeat — one page, then the page that proves the cursor did not move");
  } finally {
    ws.close();
    d.dispose();
  }
});
