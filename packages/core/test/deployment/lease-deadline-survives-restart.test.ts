/**
 * `loom serve` SURVIVED ITS OWN DEATH ON FOUR NODE TYPES AND NOT ON THE OTHER FOUR.
 *
 * `run-clock-survives-restart.test.ts`'s last test is the half that already worked: a plane killed
 * between `task.leased` and `task.committed` on a `tool` node leaves that task `leased`, the run
 * clock counts it due, and `InProcessScheduler` takes the lease back past the node's own compiled
 * deadline. That deadline is `compile.ts`'s `effectiveTimeout`, which gives `DEFAULT_NODE_TIMEOUT_MS`
 * to `agent`, `tool`, `evaluator` and `function` — AND TO NOTHING ELSE. On a `router`, `join`,
 * `human_gate` or `subgraph` task there was no bound to reason from, so the reclaim arm declined,
 * correctly and permanently: TODO.md §B.1, "a plane that dies between `task.leased` and
 * `task.committed` strands that run permanently, because reclaiming needs a lease DEADLINE".
 *
 * THE FIX IS THAT THE DEPLOYMENT SUPPLIES THE NUMBER THE GRAPH DOES NOT. `openWorkspace` builds
 * `new InProcessScheduler({ strandedLeaseMs: STRANDED_LEASE_MS })`, and that is the whole change on
 * the product path — see `cli.ts`'s `STRANDED_LEASE_MS` for the figure, why it is not a flag, and
 * what it loosens. It could not go in `compile.ts` instead: `NodePlan.timeoutMs` is what
 * `Engine.#withNodeDeadline` ENFORCES on a live body, and a `human_gate` that expires because
 * nobody wrote a number is oversight failing open (that file's own argument, and
 * `graph/join-timeout-refused.test.ts`'s). A recovery bound and an enforcement bound are two
 * questions, and only the first one is asked here — nothing in `select` aborts anything.
 *
 * RECONSTRUCTED FROM THE JOURNAL, WHICH IS THE PROPERTY THAT MATTERS. The deadline is
 * `task.lease.at + strandedLeaseMs`, and `lease.at` is `projection.ts` folding the `task.leased`
 * row's own `ts`. The scheduler's one piece of memory — the set of leases IT handed out — comes
 * back EMPTY at a boot, and empty is the permissive direction: every lease in the journal then
 * looks like a predecessor's, which is exactly what it is. Nothing here is decided by a value a
 * restart could hand back wrong; the worst a lost map can do is offer a task whose commit the
 * fencing token would refuse. `cli.ts`'s container census, member 12, says the same thing.
 *
 * BUILT FROM A REAL JOURNAL, NOT FROM HAND-WRITTEN EVENTS — the distinction
 * `run/contention.test.ts` opens with, and the reason the first version of the reclaim passed a
 * green suite while being unreachable. A `loom run` of a two-node graph is driven to `succeeded`
 * through `main`, and its first five events are replayed onto fresh run ids. Every payload is one
 * the product wrote, and the entry node is a `router` — one of the four the compiler adjudicates
 * nothing about.
 *
 * WITH BOTH CONTROLS, because "the stranded run finished" is on its own consistent with two other
 * stories:
 *
 *   - THE CONTROL, same journal one event shorter (`task.ready`, never leased). If it did NOT
 *     finish, the clock drives nothing and the reclaim is not what is being measured.
 *   - THE COUNTER-CONTROL, which is not in this file, because a `Workspace` with the fallback
 *     unwired is not a thing `openWorkspace` can be asked for any more — which is the point. It
 *     is `run/inprocess-reclaims-a-dead-lease.test.ts`'s last two tests, which ask ONE folded
 *     journal at ONE instant with only the constructor argument different: without a fallback,
 *     nothing; with one, the task. The end-to-end half of the same measurement, taken by reverting
 *     `openWorkspace`'s `scheduler:` line and running this file:
 *
 *         without `strandedLeaseMs`:  status=running   pick@root#0=leased      driven, unchanged
 *         with it:                    status=succeeded pick@root#0=succeeded
 *
 *     The `driven` assertion holds in BOTH columns, which is what makes the difference the
 *     scheduler's answer rather than the clock's: the run was always offered, and never taken.
 *
 * NOTHING HERE READS A CLOCK RATIO OR TUNES A TIMING. The lease is stamped in 2023 and the engine
 * reads `Date.now()`, so `lease.at + 600000` is years in the past at every instant this test can
 * run. It is a fixed point compared against the present.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { main, runClockTick } from "../../src/cli.ts";
import { newRunId, type RunId, type TaskId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { deployment, publishGraph, quiet } from "./harness.ts";

const LIMIT = 200;
const LAP = 1_000;
/** The `router` node's task, as the engine names it. Asserted on below, not assumed. */
const TASK = "pick@root#0" as TaskId;

/**
 * A `router` first, a `tool` second.
 *
 * The entry node has to be one of the four with no compiled deadline or this measures the case
 * that already worked. `router` is the one of the four that needs no extra machinery to reach:
 * `join` needs a fan-out to join over, `human_gate` parks the run on a person, and `subgraph`
 * needs a second published spec. All four take the same path through `deadlineExpired`, which is
 * keyed on `plans[nodeId].timeoutMs` being absent and knows nothing about node type.
 */
const ROUTED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "routed", project: "deployment", version: 1 },
  policy: { posture: "on", capabilities: ["fs:write"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [
    { id: "pick", type: "router", reads: ["note"], router: { mode: "expression", cases: [{ when: "true", take: ["go"] }], fallbackEdge: "go" } },
    { id: "apply", type: "tool", reads: ["note"], writes: ["out"], tool: { name: "fs.write", version: "1.0", args: { path: "out/a.txt", body: "${note}" } } },
  ],
  edges: [{ id: "go", from: "pick", to: "apply", kind: "conditional" }],
};

test("A RUN STRANDED ON A NODE THE COMPILER GIVES NO DEADLINE IS RECLAIMED AFTER A RESTART, AND FINISHES", async () => {
  const d = deployment();
  try {
    const file = publishGraph(d, "routed", ROUTED);

    // THE FIXTURE'S PREMISE, READ OFF THE PRODUCT RATHER THAN ASSUMED. `loom compile` prints one
    // `deadline <node>` line per node the compiler gave a `NodePlan.timeoutMs`. The `tool` node
    // gets the default; the `router` gets NO LINE AT ALL, and that absence is the whole reason
    // the reclaim arm had nothing to reason from before `strandedLeaseMs`.
    const plan = await quiet(() => main(["compile", file, "--workspace", d.dir]));
    assert.equal(plan.value, 0, plan.err);
    assert.match(plan.out, /deadline apply \(default\): timeoutMs=600000/, `the tool node is adjudicable:\n${plan.out}`);
    assert.doesNotMatch(plan.out, /deadline pick/, `and the router node is not:\n${plan.out}`);

    const { value: code } = await quiet(() => main(["run", file, "--workspace", d.dir, "--input", '{"note":"x"}']));
    assert.equal(code, 0, "the donor run must succeed — its journal is what the two truncations are cut from");

    let ready: RunId;
    let stranded: RunId;
    {
      const w = d.open();
      try {
        const donor = (await w.store.listRuns(10))[0]!.runId;
        const evs: JournalEvent[] = [];
        for await (const e of w.store.read(donor, 1)) evs.push(e);
        assert.deepEqual(
          evs.slice(0, 5).map((e) => e.type),
          ["run.submitted", "run.compiled", "run.started", "task.ready", "task.leased"],
          `the donor's prefix is what this test cuts: ${evs.map((e) => e.type).join(", ")}`,
        );
        assert.equal(String(evs[4]!.taskId), TASK, "and the lease it cuts after is the ROUTER's — the point of the fixture");

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
        stranded = await copy(5, 1_700_000_000_002);
      } finally {
        w.close();
      }
    }

    // THE RESTART: a new Engine, a new broker, a new SQLite handle, a new `InProcessScheduler`
    // whose `#handedOut` is empty, folding these journals for the first time.
    const w = d.open();
    try {
      const before = (await w.engine.projection(stranded))!;
      assert.equal(before.tasks[TASK]?.state, "leased", "the precondition: the fold puts the task back in `leased`, because nothing committed it");
      assert.equal((await w.engine.projection(ready))?.tasks[TASK]?.state, "ready", "and the control's task folds back to `ready`");
      assert.ok(typeof before.tasks[TASK]?.lease?.at === "number", "and the deadline's input came out of the journal, not out of this process");

      assert.notEqual(
        await w.engine.compiledGraphHash(stranded),
        undefined,
        "the run's graph still resolves — otherwise the clock's OTHER failure shape is what is being measured",
      );

      const driven: RunId[] = [];
      const t = await runClockTick(w, LIMIT, 1_700_000_000_100, LAP, async (runId: RunId) => {
        driven.push(runId);
        await w.engine.advance(runId);
      });

      assert.ok(t.visited.includes(stranded), "the stranded run is in the clock's window");
      assert.ok(driven.includes(stranded), "and it is driven: `due` counts a leased task");
      assert.ok(driven.includes(ready), "THE CONTROL: the same journal one event shorter is driven on the same tick");

      const after = (await w.engine.projection(stranded))!;
      assert.equal(after.status, "succeeded", `the reclaimed run completed: ${JSON.stringify(after.error ?? {})}`);
      assert.equal(after.tasks[TASK]?.state, "succeeded", "and the stranded ROUTER task is the one that was re-leased and finished");
      assert.equal((await w.engine.projection(ready))?.status, "succeeded", "THE CONTROL finished too, which is what makes the comparison a comparison");
    } finally {
      w.close();
    }
  } finally {
    d.dispose();
  }
});
