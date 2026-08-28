/**
 * THE BOX HAS A CONCURRENCY DIAL NOW, AND IT IS A CEILING RATHER THAN A DOOR.
 *
 * `POST /runs` authenticated, validated, submitted, answered 202, and then fired a bare
 * `void engine.advance(runId)` with nothing bounding how many of those ran at once. Measured at
 * HEAD by driving 60 submissions the way that handler drives them: **60 concurrent provider
 * calls**. `EngineOptions.maxParallelism` bounds fan-out INSIDE one run and defaults to 16, and
 * `cli.ts` never passed it, so the operator had no dial at either level; the same construction
 * passed `policy: { granted }` with no `budget`, so the deployment half of `Engine.submit`'s
 * `minDefined` fold was always `undefined` and the only money ceiling on the whole box was
 * whatever each graph happened to declare.
 *
 * WHAT IS NOT BUILT, and this file is part of the record that says so: there is no admission
 * control. `E_ADMISSION_REJECTED` was deleted under "a code arrives with its raiser" and stays
 * deleted. Under one tenant the right answer to "too much work" is to make it WAIT, never to
 * say no — refusing throws away work the operator explicitly asked for and breaks the promise
 * the 202 makes in its own words. So every assertion below is about a bound that WITHHOLDS and
 * about a parser that REFUSES TO BOOT; none of them is about a request being turned away.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, runDispatcher } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { RunId } from "../../src/ids.ts";

/** An `advance` the test settles by hand — no timer anywhere, so nothing here reads a clock. */
function controllable(): {
  engine: { advance(runId: RunId): Promise<unknown> };
  entered: RunId[];
  peak: number;
  settle(runId: RunId, e?: unknown): void;
} {
  const pending = new Map<RunId, { resolve: () => void; reject: (e: unknown) => void }>();
  const state = {
    entered: [] as RunId[],
    peak: 0,
    engine: {
      advance: (runId: RunId): Promise<unknown> => {
        state.entered.push(runId);
        return new Promise<void>((resolve, reject) => {
          pending.set(runId, { resolve, reject });
          state.peak = Math.max(state.peak, pending.size);
        });
      },
    },
    settle: (runId: RunId, e?: unknown): void => {
      const d = pending.get(runId);
      assert.ok(d, `nothing is in flight for ${runId}`);
      pending.delete(runId);
      if (e === undefined) d.resolve();
      else d.reject(e);
    },
  };
  return state;
}

/** Let every already-settled promise's continuations run. Microtasks only — never a timer. */
async function drain(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

const A = "r-a" as RunId;
const B = "r-b" as RunId;
const C = "r-c" as RunId;

test("the bound holds, and the surplus is DROPPED rather than queued or refused", async () => {
  const rig = controllable();
  const errs: RunId[] = [];
  const d = runDispatcher(rig, 2, (runId) => errs.push(runId));

  d.drive(A);
  d.drive(B);
  d.drive(C);
  assert.deepEqual(rig.entered, [A, B], "the third run is not driven while both slots are held");
  assert.equal(d.inFlight, 2);
  assert.equal(rig.peak, 2, "the peak is the bound, not the number of requests");

  // AND `C` IS NOT REMEMBERED. This is the design and not an omission: an in-memory queue is
  // a value a decision reads that a restart empties, and the whole argument for putting the
  // bound here rather than at the door is that the queue is the JOURNAL. `runClockTick`'s
  // widened predicate re-derives `C` and offers it again; nothing in this object does.
  rig.settle(A);
  await drain();
  assert.deepEqual(rig.entered, [A, B], "a released slot does not resurrect a dropped run");
  assert.equal(d.inFlight, 1, "…but the slot IS released, in a `finally`");

  d.drive(C);
  await drain();
  assert.deepEqual(rig.entered, [A, B, C], "and the next offer of C is taken");
  assert.equal(errs.length, 0);
});

test("a run already in flight is deduped, so a clock tick on top of a live driver is a no-op", async () => {
  const rig = controllable();
  const d = runDispatcher(rig, 4, () => undefined);
  d.drive(A);
  d.drive(A);
  d.drive(A);
  assert.deepEqual(rig.entered, [A], "one advance, three offers");
  assert.equal(d.inFlight, 1);
  rig.settle(A);
  await drain();
  assert.equal(d.inFlight, 0);
  d.drive(A);
  assert.deepEqual(rig.entered, [A, A], "dedupe is about being IN FLIGHT, not about having run");
});

test("a failed advance reaches the sink and STILL releases its slot", async () => {
  // A slot held by a settled promise is the one leak this shape can have, and its end state is
  // a box that quietly drives nothing. The `finally` is what stops it, and the case that
  // proves the `finally` is the rejected one — a `.then`-shaped release would skip it.
  const rig = controllable();
  const seen: { runId: RunId; message: string }[] = [];
  const d = runDispatcher(rig, 1, (runId, e) => seen.push({ runId, message: (e as Error).message }));
  d.drive(A);
  rig.settle(A, new Error("the provider is gone"));
  await drain();
  assert.deepEqual(seen, [{ runId: A, message: "the provider is gone" }], "the operator is told, because nobody else can be");
  assert.equal(d.inFlight, 0, "and the slot came back");
  d.drive(B);
  assert.deepEqual(rig.entered, [A, B], "so the next run is driven");
});

test("a sink that throws takes neither the slot nor the process", async () => {
  // THE LAST FRAME. `onError` runs inside a `.catch` on a promise nobody awaits, so a throw in
  // it is an unhandled rejection and the process — measured: before the dispatcher contained
  // it, a reporter that threw took the whole test runner down from an object whose only job is
  // to hold a number. And the release is in a `finally` rather than in the `catch`, so a
  // reporter that throws still returns its slot.
  const rig = controllable();
  const d = runDispatcher(rig, 1, () => {
    throw new Error("the reporter failed");
  });
  d.drive(A);
  rig.settle(A, new Error("boom"));
  await drain();
  assert.equal(d.inFlight, 0, "released in a `finally`, whatever the reporter did");
  d.drive(B);
  assert.deepEqual(rig.entered, [A, B], "and the box goes on driving runs");
});

// ── the flags REFUSE TO BOOT, and never fall back ───────────────────────────

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-dial-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "g.json");
  writeFileSync(
    graphFile,
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "dial", project: "demo", version: 1 },
      policy: { posture: "out", capabilities: ["fs:read"] },
      channels: { a: { type: "string", reduce: "replace" }, b: { type: "string", reduce: "replace" } },
      inputs: ["a"],
      outputs: ["b"],
      nodes: [{ id: "read", type: "tool", reads: ["a"], writes: ["b"], tool: { name: "fs.read", version: "1.0", args: { path: "${a}" } } }],
      edges: [],
    }),
  );
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Driven through `compile`, never `serve` — `known-flags.test.ts`'s rule and for its reason:
 * `serve` BINDS A SOCKET, so a mutation that removed one of these refusals would turn a
 * failing assertion into a listening server and hang the run instead of going red. Every flag
 * below is read inside `openWorkspace`, which every verb calls.
 */
async function refusesToBoot(w: { dir: string; graphFile: string }, flag: string, value: string, match: RegExp): Promise<void> {
  await assert.rejects(
    () => main(["compile", w.graphFile, "--workspace", w.dir, flag, value]),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && match.test(e.message),
    `${flag} ${value} must refuse to boot`,
  );
}

test("a malformed concurrency or budget flag refuses to boot, and never falls back to a default", async () => {
  const w = workspace();
  try {
    // ZERO. `Engine` clamps `maxParallelism` with `Math.max(1, …)`, so a 0 that got through
    // would be silently disregarded — the flag accepted, the value gone.
    await refusesToBoot(w, "--max-parallelism", "0", /whole number from 1 to 1024/);
    // FRACTIONAL.
    await refusesToBoot(w, "--max-parallelism", "1.5", /whole number from 1 to 1024/);
    // NON-NUMERIC.
    await refusesToBoot(w, "--max-parallelism", "sixteen", /whole number from 1 to 1024/);
    // ABOVE THE CEILING — each of these multiplies into simultaneous sockets and SQLite
    // writers, and the failure of a value typed for the wrong flag is far from the flag.
    await refusesToBoot(w, "--max-parallelism", "100000", /whole number from 1 to 1024/);

    // `NaN` IS THE ONE THAT MATTERS FOR A BUDGET. Every comparison against `NaN` is false, so
    // a `NaN` ceiling is not a loose cap, it is NO cap, on a process reporting that it has one.
    await refusesToBoot(w, "--budget-usd", "NaN", /positive number of US dollars/);
    await refusesToBoot(w, "--budget-usd", "0", /positive number of US dollars/);
    await refusesToBoot(w, "--budget-usd", "-1", /positive number of US dollars/);
    await refusesToBoot(w, "--budget-tokens", "0", /whole number from 1 to/);
    await refusesToBoot(w, "--budget-tokens", "1e400", /whole number from 1 to/);
    await refusesToBoot(w, "--budget-wall-ms", "NaN", /whole number from 1 to/);

    // AND A FRACTIONAL DOLLAR IS AN ORDINARY VALUE, which is why `--budget-usd` does not go
    // through the whole-number check the other four do.
    assert.equal(await main(["compile", w.graphFile, "--workspace", w.dir, "--budget-usd", "0.50"]), 0);
    assert.equal(await main(["compile", w.graphFile, "--workspace", w.dir, "--max-parallelism", "1"]), 0);
  } finally {
    w.dispose();
  }
});
