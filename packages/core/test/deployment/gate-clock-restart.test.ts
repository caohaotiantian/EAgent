/**
 * THE PLANE ARMS THE SET IT SWEEPS — at scale, across a restart.
 *
 * `loom serve`'s gate clock is two halves that must agree about WHICH RUNS ARE IN VIEW:
 *
 *   - `armForeignGates` re-attaches the graph and calls `rehydrateGates`, which is the only
 *     thing that puts a gate's `DeliverySpec` and escalation chain back into a broker that
 *     did not raise it;
 *   - `Engine.sweepGates` → `GateSweeper.sweep` enforces the deadline.
 *
 * They listed differently. The sweep asked for `{ raisedAGate: true }` (gates.ts) and the
 * arming asked for nothing, so past the window the arming's `ORDER BY run_id DESC` handed
 * back the newest runs and the gated one was not among them. The sweep then held no
 * `DeliverySpec` for a gate it COULD see, took `#fireTimeout`'s `spec === undefined` arm, and
 * expired it — `onTimeout: "escalate"` behaving exactly as `fail`, journaled with the reason
 * "exhausted its escalation chain with no decision", which is false: nobody was ever paged.
 * They also disagreed on SIZE — 500 in the sweeper, 200 here — which fixing the filter alone
 * would have left.
 *
 * Two things had to be true at once for it to bite, and neither is reachable from a
 * single-run in-process test: more runs than the window, and a RESTART (the arming exists
 * only because the raising process is gone). That is why this file is in `deployment/`.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { GATE_CLOCK_LIMIT, armForeignGates, main } from "../../src/cli.ts";
import type { RunId } from "../../src/ids.ts";
import type { Seq } from "../../src/ids.ts";
import { deployment, fillRuns, journalTypes, publishGraph, quiet } from "./harness.ts";

/** One gate, a one-hour SLA, one reachable escalation tier. The shape a restart used to disarm. */
const GATED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "escalates", project: "deployment", version: 1 },
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
        approval: { mode: "single", approvers: ["u:alice"] },
        sla: { respondWithinMs: 3_600_000, onTimeout: "escalate" },
        // NO CHANNEL IS CONFIGURED IN THE WORKSPACE, deliberately: a configured channel is a
        // webhook, i.e. the network. The escalation TIER is what this test is about, and it
        // is read from the compiled graph, not from a dispatcher.
        delivery: {
          channels: ["console"],
          recipients: [{ kind: "user", id: "u:alice" }],
          escalation: [{ afterMs: 3_600_000, to: [{ kind: "user", id: "u:carol" }] }],
        },
      },
    },
    // THE ACTION IS BEHIND THE GATE, so "the run resumed" and "the action ran" are different
    // facts — and so the gate gates something, which `GRAPH014_GATE_GATES_NOTHING` requires.
    // It never runs here: nothing in this file ever approves.
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

/** The absolute deadline the raise journaled. Derived, so nothing here reads the wall clock. */
async function journaledDeadline(store: { read: (r: RunId, from: number) => AsyncIterable<{ type: string; payload: unknown }> }, runId: RunId): Promise<number> {
  for await (const e of store.read(runId, 1)) {
    if (e.type !== "gate.raised") continue;
    const deadline = (e.payload as { deadline?: number }).deadline;
    assert.equal(typeof deadline, "number", "the raise must journal an absolute deadline");
    return deadline as number;
  }
  throw new Error("no gate.raised on this run");
}

test("A GATE PAST THE RUN WINDOW STILL ESCALATES AFTER A RESTART", async () => {
  const d = deployment();
  try {
    const file = publishGraph(d, "escalates", GATED);

    // ── plane 1: raise the gate through the door people actually use, and exit.
    const { value: code } = await quiet(() => main(["run", file, "--workspace", d.dir, "--input", '{"note":"ship it"}']));
    assert.equal(code, 0, "`loom run` parks on a gate and that is a success");

    // ── the scale half. 250 later runs, none of which gates.
    const filler = d.open();
    let gatedRunId: RunId;
    let deadline: number;
    try {
      const gated = (await filler.store.listRuns(10, { raisedAGate: true }))[0];
      assert.notEqual(gated, undefined, "the run that gated must be findable by the sweep's own listing");
      gatedRunId = gated!.runId;
      // SIZED OFF THE CLOCK'S OWN WINDOW, and it was not: the filler count was 250 against a
      // window of `GATE_CLOCK_LIMIT` = 500, so the preconditions below held at 200 while the
      // listing the code actually takes still had 250 free slots. Measured: with the
      // `{ raisedAGate: true }` filter deleted from `armForeignGates`, this test stayed GREEN.
      // A window test has to overflow the window the product uses, not a smaller one quoted
      // beside it.
      await fillRuns(filler.store, GATE_CLOCK_LIMIT + 20, gated!.lastTs);

      // THE PRECONDITION, MEASURED RATHER THAN ASSUMED: the unfiltered listing the arming used
      // to take can no longer see this run, and the filtered one the sweep takes still can.
      const unfiltered = await filler.store.listRuns(GATE_CLOCK_LIMIT);
      assert.equal(
        unfiltered.some((r) => r.runId === gatedRunId),
        false,
        `${GATE_CLOCK_LIMIT + 20} newer runs must have pushed the gated run out of an unfiltered listRuns(${GATE_CLOCK_LIMIT})`,
      );
      const filtered = await filler.store.listRuns(GATE_CLOCK_LIMIT, { raisedAGate: true });
      assert.equal(filtered.some((r) => r.runId === gatedRunId), true, "…while the sweep can still see it");

      deadline = await journaledDeadline(filler.store, gatedRunId);
    } finally {
      filler.close();
    }

    // ── the restart. A new Engine, a new broker holding nothing, a new SQLite handle,
    // over the same journal and the same graphs/ directory.
    const restarted = d.open();
    try {
      await armForeignGates(restarted, new Map<RunId, Seq>());
      const report = await restarted.engine.sweepGates(deadline + 1);
      assert.equal(report.fired.length, 1, `the gate's clock must fire: ${JSON.stringify(report)}`);

      // WHICH WAY IT FIRED IS THE ASSERTION. Both outcomes are "fired"; the defect is an
      // expiry where an escalation was declared.
      const types = await journalTypes(restarted.store, gatedRunId);
      assert.ok(types.includes("gate.escalated"), `must escalate; journal: ${types.join(", ")}`);
      assert.ok(!types.includes("gate.timeout"), `must NOT expire; journal: ${types.join(", ")}`);
      assert.ok(!types.includes("run.failed"), `and the run must still be answerable; journal: ${types.join(", ")}`);
    } finally {
      restarted.close();
    }
  } finally {
    d.dispose();
  }
});

/**
 * THE PRUNE THAT USED TO BE TESTED HERE IS TESTED IN `gate-clock-armed-prune.test.ts`.
 *
 * The version this file carried filled 250 runs that never gate and asserted `armed.size <= 10`.
 * Both halves of the clock list `{ raisedAGate: true }`, so the FILTER held that listing at one
 * row and the map could not have grown whether it was pruned or not: deleting the two prune
 * lines left it green. Only gates compete for slots in the gated window, so only gates can
 * push one out of it — which is what the new file does, and what nothing here could.
 */
