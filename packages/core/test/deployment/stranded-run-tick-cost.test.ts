/**
 * A RUN THE CLOCK CANNOT DRIVE MADE EVERY TICK PAY FOR THE WHOLE WORKSPACE.
 *
 * `runClockTick`'s `due` predicate counts a `leased` task, deliberately — see its own comment,
 * and `run-clock-survives-restart.test.ts` for the crash it exists to recover from. What that
 * widening also did is put `graphsByHash(ws)` on the path of every run that is due, and
 * `graphsByHash` COMPILED EVERY GRAPH FILE IN THE WORKSPACE, every call. A run whose recorded
 * hash resolves to no file is due at every tick and driveable at none, so the compile happened
 * twice a second, forever, and its size was the WORKSPACE'S, not the stranded run's. TODO.md
 * §A0.12, measured there at ~10× a tick's cost over 31 published graphs.
 *
 * HOW THIS FILE COUNTS COMPILES, without a spy and without a clock. `loadGraph` writes one
 * stderr line per diagnostic, so a graph carrying a WARNING — a channel whose reducer is
 * `last_write_wins_by_ts`, which `graph/validate.ts` answers with GRAPH013_CLOCK_DEPENDENT —
 * prints exactly one line per compile. Counting those lines over K ticks is a count of
 * compiles. Nothing here reads a clock, so there is no timing assertion to be flaky.
 *
 * MEASURED AT THE BASE SHA, with the census test below: 8 graphs × 4 ticks = 32 compiles.
 * After the memo: 8, and the 8 are the first tick's.
 *
 * AND THE ORDINARY HALF, which is the whole risk of a cache — the three tests after the census.
 * A graph published AFTER the memo filled is compiled and its run driven on the next tick. A
 * graph REPUBLISHED IN PLACE, same filename, new bytes, is visible on the next tick with no
 * restart. A restart, whose memo is empty by construction, still drives.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unlinkSync, writeFileSync } from "node:fs";

import { main, runClockTick } from "../../src/cli.ts";
import { newRunId, type RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { deployment, publishGraph, quiet, type Deployment, type Plane } from "./harness.ts";

const LIMIT = 200;
const LAP = 1_000;
const T0 = 1_700_000_000_000;

/** One tool node, one output. `version` is what the two republished variants differ in. */
const oneTool = (name: string, version: number, clockDependent: boolean): unknown => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name, project: "deployment", version },
  policy: {
    posture: "on",
    capabilities: ["fs:write"],
    expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
  },
  channels: {
    note: { type: "string", reduce: "replace" },
    // THE COUNTER. `last_write_wins_by_ts` is GRAPH013_CLOCK_DEPENDENT, a WARNING — the graph
    // compiles, and every compile prints one line naming the file.
    out: { type: "object", reduce: clockDependent ? "last_write_wins_by_ts" : "replace" },
  },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [
    {
      id: "apply",
      type: "tool",
      reads: ["note"],
      writes: ["out"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/a.txt", body: "${note}" } },
    },
  ],
  edges: [],
});

/** Compiles counted the only way a test can count them: one warning line per compile. */
const compiles = (stderr: string): number => stderr.split("GRAPH013_CLOCK_DEPENDENT").length - 1;

/**
 * A run that is `running` with a due task, cut from a REAL journal.
 *
 * The prefix `run.submitted, run.compiled, run.started, task.ready` is what a plane killed
 * mid-advance leaves behind, and every payload in it was written by the product — the same
 * move `run-clock-survives-restart.test.ts` makes, and for the same reason: hand-written
 * events would be this test's opinion about what a stranded run looks like.
 */
async function strandedFrom(w: Plane, donor: RunId, at: number): Promise<RunId> {
  const evs: JournalEvent[] = [];
  for await (const e of w.store.read(donor, 1)) evs.push(e);
  assert.deepEqual(
    evs.slice(0, 4).map((e) => e.type),
    ["run.submitted", "run.compiled", "run.started", "task.ready"],
    `the donor's prefix is what this cuts: ${evs.map((e) => e.type).join(", ")}`,
  );
  const runId = newRunId(at);
  await w.store.append({
    runId,
    expectedSeq: 0,
    now: at,
    events: evs.slice(0, 4).map((e) => ({
      type: e.type,
      payload: e.payload,
      actor: e.actor,
      ...(e.taskId === undefined ? {} : { taskId: e.taskId }),
    })) as never,
  });
  return runId;
}

/** Run `spec` through the product once, and hand back the journal prefix of a stranded copy. */
async function donorRun(d: Deployment, file: string, at: number): Promise<RunId> {
  const { value: code } = await quiet(() => main(["run", file, "--workspace", d.dir, "--input", '{"note":"x"}']));
  assert.equal(code, 0, "the donor run must succeed — its journal is what the stranded copy is cut from");
  const w = d.open();
  try {
    const donor = (await w.store.listRuns(50)).map((r) => r.runId).sort()[0]!;
    return await strandedFrom(w, donor, at);
  } finally {
    w.close();
  }
}

test("A STRANDED RUN COSTS ONE COMPILE PER GRAPH FILE, NOT ONE PER GRAPH PER TICK", async () => {
  const d = deployment();
  try {
    // The stranded run's own graph, published only long enough to mint a real journal, then
    // DELETED: its hash now resolves to no file, which is one of the two shapes §A0.12 names.
    const strandedFile = publishGraph(d, "stranded", oneTool("stranded", 1, false));
    const stranded = await donorRun(d, strandedFile, T0 + 1);
    unlinkSync(strandedFile);

    // The workspace the tick was paying for. Eight is enough to tell 8 from 32; the row's own
    // measurement was 31, and the property is per-file either way.
    const N = 8;
    for (let i = 0; i < N; i++) publishGraph(d, `noise-${i}`, oneTool(`noise-${i}`, 1, true));

    const w = d.open();
    try {
      assert.equal((await w.engine.projection(stranded))?.status, "running", "the precondition: the stranded run is in view");

      const K = 4;
      const { err } = await quiet(async () => {
        for (let tick = 0; tick < K; tick++) await runClockTick(w, LIMIT, tick * LAP, LAP);
      });
      assert.equal(
        compiles(err),
        N,
        `every graph file is compiled once, not once per tick: ${compiles(err)} compiles over ${K} ticks of ${N} graphs ` +
          `(the defect measured ${N * K})`,
      );
      assert.equal((await w.engine.projection(stranded))?.status, "running", "and the stranded run is still stranded, undriven");
    } finally {
      w.close();
    }
  } finally {
    d.dispose();
  }
});

test("A GRAPH PUBLISHED AFTER THE MEMO FILLED IS COMPILED, AND ITS RUN DRIVEN, ON THE NEXT TICK", async () => {
  const d = deployment();
  try {
    const file = publishGraph(d, "late", oneTool("late", 1, true));
    const run = await donorRun(d, file, T0 + 1);
    unlinkSync(file);

    const w = d.open();
    try {
      // Tick once with the graph GONE: the memo fills with whatever else is there, and this
      // run is not driveable.
      await quiet(() => runClockTick(w, LIMIT, 0, LAP));
      assert.equal((await w.engine.projection(run))?.status, "running", "not driveable while its graph is unpublished");

      // Publish it again, at a path the memo has never seen, and tick. A cache that only
      // invalidated on a restart would leave this run stranded forever.
      publishGraph(d, "late-again", oneTool("late", 1, true));
      const { err } = await quiet(() => runClockTick(w, LIMIT, LAP, LAP));
      assert.equal(compiles(err), 1, "the newly published file is compiled on that tick");
      assert.equal((await w.engine.projection(run))?.status, "succeeded", "and the run it unblocks is driven to completion");
    } finally {
      w.close();
    }
  } finally {
    d.dispose();
  }
});

test("A GRAPH REPUBLISHED IN PLACE — SAME FILENAME, NEW BYTES — IS VISIBLE ON THE NEXT TICK", async () => {
  const d = deployment();
  try {
    // `swap.json` holds v2 while the donor runs, so the stranded copy records v2's hash.
    const file = publishGraph(d, "swap", oneTool("swap", 2, true));
    const run = await donorRun(d, file, T0 + 1);

    // Then the same PATH is overwritten with v1 — a different graph, a different hash.
    writeFileSync(file, JSON.stringify(oneTool("swap", 1, true), null, 2));

    const w = d.open();
    try {
      const first = await quiet(() => runClockTick(w, LIMIT, 0, LAP));
      assert.equal(compiles(first.err), 1, "the memo fills with v1, under swap.json");
      assert.equal((await w.engine.projection(run))?.status, "running", "v1 does not answer for a run that compiled v2");

      // Republished IN PLACE. Nothing about the path changed and nothing restarted; only the
      // bytes did. A memo keyed on the path alone would serve v1 here forever.
      writeFileSync(file, JSON.stringify(oneTool("swap", 2, true), null, 2));
      const second = await quiet(() => runClockTick(w, LIMIT, LAP, LAP));
      assert.equal(compiles(second.err), 1, "changed bytes are recompiled");
      assert.equal((await w.engine.projection(run))?.status, "succeeded", "and the republished graph drives the run");
    } finally {
      w.close();
    }
  } finally {
    d.dispose();
  }
});

test("A RESTART STARTS WITH AN EMPTY MEMO AND STILL DRIVES", async () => {
  const d = deployment();
  try {
    const file = publishGraph(d, "restart", oneTool("restart", 1, true));
    const run = await donorRun(d, file, T0 + 1);
    unlinkSync(file);

    // One plane fills a memo over a workspace that cannot answer for this run, then goes away.
    // Nothing it learned is durable, and nothing needs to be: the second plane folds the same
    // journal and reads the same directory.
    {
      const w = d.open();
      try {
        await quiet(() => runClockTick(w, LIMIT, 0, LAP));
        assert.equal((await w.engine.projection(run))?.status, "running", "the first plane cannot drive it");
      } finally {
        w.close();
      }
    }
    publishGraph(d, "restart", oneTool("restart", 1, true));
    const w = d.open();
    try {
      const { err } = await quiet(() => runClockTick(w, LIMIT, LAP, LAP));
      assert.equal(compiles(err), 1, "a fresh plane compiles from disk — the memo did not survive it");
      assert.equal((await w.engine.projection(run))?.status, "succeeded", "and the run is driven");
    } finally {
      w.close();
    }
  } finally {
    d.dispose();
  }
});
