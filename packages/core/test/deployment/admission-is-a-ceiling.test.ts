/**
 * THE QUEUE IS THE JOURNAL, and this is the file that says so with a measurement.
 *
 * `POST /runs` now hands a freshly-accepted run to `ControlPlaneOptions.drive` instead of
 * firing `void engine.advance(runId)` itself, and `drive` holds at most
 * `--max-runs-in-flight` of those at once. The obvious question about that bound is what
 * happens to the surplus, and the answer this deployment gives is **nothing**: it is not
 * queued in memory, it is not refused, and it is not remembered. The run sits `running` with a
 * `ready` task, and `runClockTick`'s widened predicate re-derives it from the journal on the
 * next tick.
 *
 * So the test drives the pathological version of that — a `drive` that never dispatches at
 * all, which is what a dispatcher whose slots are permanently held looks like from outside —
 * and asserts three things: every submit still answered **202**, nothing progressed, and one
 * clock tick finishes all of them. If the third assertion ever fails, the bound has become
 * admission control with extra steps.
 *
 * THE PREDICATE IS THE OTHER HALF, and it is why the widening and the dispatcher land in one
 * commit. Before it, `due` was `t.retryAfter !== undefined && t.retryAfter <= now`: a
 * submitted-never-advanced run has a `ready` task whose `retryAfter` is `undefined`, so the
 * clock was blind to exactly the runs the dispatcher creates. The test below pins that shape
 * directly before it pins the recovery.
 *
 * OFFLINE AND DETERMINISTIC. The plane is in-process on 127.0.0.1, the tick is driven at an
 * instant this file chooses, and nothing sleeps.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { controlPlaneOptions, parseArgs, runClockTick } from "../../src/cli.ts";
import { ControlPlane, type ControlPlaneOptions } from "../../src/server/http.ts";
import type { RunId } from "../../src/ids.ts";
import { deployment, origin, publishGraph, refusing, speak, type Deployment } from "./harness.ts";

const TOKEN = "s3cret-not-a-real-token";

/** One tool node that finishes on its own. No gate, no model — the run has to REACH an end. */
const WORK = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "ceiling", project: "deployment", version: 1 },
  policy: { posture: "out", capabilities: ["fs:write"] },
  channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [
    { id: "apply", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "fs.write", version: "1.0", args: { path: "out/${note}.txt", body: "${note}" } } },
  ],
  edges: [],
};

/** A plane whose `drive` records the hand-off and DISPATCHES NOTHING — every slot held forever. */
async function stuckPlane(d: Deployment): Promise<{ url: string; handed: RunId[]; close(): Promise<void> }> {
  const ws = d.open();
  const handed: RunId[] = [];
  const base = controlPlaneOptions(ws, parseArgs(["serve", "--workspace", d.dir, "--token", TOKEN]));
  const opts: ControlPlaneOptions = { ...base, drive: (runId) => handed.push(runId) };
  const p = new ControlPlane(opts);
  const bound = await p.listen(0, "127.0.0.1");
  return {
    url: origin(bound.host, bound.port),
    handed,
    close: async () => {
      await p.close();
      ws.close();
    },
  };
}

test("EVERY SUBMIT IS 202 EVEN WITH NOTHING DRIVING, AND THE CLOCK FINISHES THEM ALL", async () => {
  const d = deployment();
  try {
    publishGraph(d, "ceiling", WORK);
    const plane = await stuckPlane(d);
    const ids: RunId[] = [];
    try {
      // 202 IS UNCONDITIONAL AND STAYS UNCONDITIONAL. The body says "accepted means this WILL
      // run, not that it HAS run", and a bound that answered 429 here would be admission
      // control — which this decision refuses permanently. Three submissions against a plane
      // that will drive none of them: all three are accepted.
      for (const note of ["a", "b", "c"]) {
        const r = await speak(`${plane.url}/runs`, { method: "POST", token: TOKEN, body: { workflow: "ceiling", inputs: { note } } });
        assert.equal(r.status, 202, `every submission is accepted: ${r.body}`);
        ids.push((JSON.parse(r.body) as { runId: RunId }).runId);
      }
      assert.deepEqual(plane.handed, ids, "the handler hands off through `drive` and does not advance anything itself");

      // NOTHING PROGRESSED, and the shape of "nothing" is the point: each run is `running`
      // with a `ready` task whose `retryAfter` is `undefined`. That is precisely the shape the
      // OLD `due` predicate could not see, so a clock without the widening would leave these
      // three here forever.
      const ws = d.open();
      try {
        for (const runId of ids) {
          const p = (await ws.engine.projection(runId))!;
          assert.equal(p.status, "running", `${runId} is running and undriven`);
          const ready = Object.values(p.tasks).filter((t) => t.state === "ready");
          assert.ok(ready.length > 0, "…with at least one ready task");
          assert.ok(
            ready.every((t) => t.retryAfter === undefined),
            "…and no elapsed backoff, which is what the pre-widening predicate keyed on",
          );
        }
      } finally {
        ws.close();
      }
    } finally {
      await plane.close();
    }

    // ONE TICK, with the default `drive` — an awaited `advance` — and every run finishes. This
    // is the whole claim: the dispatcher's slots are a scheduling hint whose loss is safe,
    // because the queue was never a data structure. Nothing was carried over from the plane;
    // this workspace holds only the journal.
    const ws = d.open();
    try {
      const t = await runClockTick(ws, 200, 1, 1_000);
      assert.equal(t.pages, 1, "sixty runs at a page of 200 is one page, so one tick sees every one of them");
      for (const runId of ids) {
        const p = (await ws.engine.projection(runId))!;
        assert.equal(p.status, "succeeded", `${runId} must reach a terminal state from the journal alone`);
      }
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("a plane built with no `drive` still advances its own submissions", async () => {
  // THE COMPATIBILITY HALF, asserted rather than assumed. `drive` is optional and absent means
  // today's behaviour, so a library embedder of `ControlPlane` sees no change — and the
  // fallback path is the one carrying the rewritten failure line, which now says which of the
  // two worlds the reader is in instead of asserting that nothing will come back for the run.
  const d = deployment();
  try {
    publishGraph(d, "ceiling", WORK);
    const ws = d.open();
    const opts = controlPlaneOptions(ws, parseArgs(["serve", "--workspace", d.dir, "--token", TOKEN]));
    assert.equal(opts.drive, undefined, "controlPlaneOptions supplies no dispatcher; `serve` adds one");
    const plane = new ControlPlane(opts);
    const bound = await plane.listen(0, "127.0.0.1");
    try {
      const r = await speak(`${origin(bound.host, bound.port)}/runs`, { method: "POST", token: TOKEN, body: { workflow: "ceiling", inputs: { note: "z" } } });
      assert.equal(r.status, 202, r.body);
      const runId = (JSON.parse(r.body) as { runId: RunId }).runId;
      // The handler's own `advance` is not awaited by the response, so the assertion polls the
      // journal for a terminal status rather than reading it once.
      for (let i = 0; i < 200 && (await ws.engine.projection(runId))?.status !== "succeeded"; i++) await Promise.resolve();
      assert.equal((await ws.engine.projection(runId))?.status, "succeeded", "an embedder's plane drives its own runs");
    } finally {
      await plane.close();
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("a malformed --max-runs-in-flight refuses to BOOT, so no socket is ever bound", async () => {
  // `refusing` spawns a real `loom` that must END BY ITSELF. That matters here more than
  // anywhere: this is the one of the five flags read inside the `serve` arm, so the only way to
  // check it is through a verb that binds a port — and a mutation that removed the refusal must
  // show up as a failing assertion rather than as a listening server and a hung run.
  const d = deployment();
  try {
    const bad = await refusing(["serve", "--workspace", d.dir, "--port", "0", "--max-runs-in-flight", "0"]);
    assert.notEqual(bad.code, 0, "a box with a zero ceiling must not start");
    assert.match(bad.err, /--max-runs-in-flight must be a whole number from 1 to 1024/);
    const bare = await refusing(["serve", "--workspace", d.dir, "--port", "0", "--max-runs-in-flight", "--token", TOKEN]);
    assert.notEqual(bare.code, 0, "…and neither must one whose ceiling is the value `parseArgs` invented");
    assert.match(bare.err, /bare flag with no value/);
  } finally {
    d.dispose();
  }
});
