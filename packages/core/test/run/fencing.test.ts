/**
 * A worker whose lease was taken cannot commit over the worker that took it.
 *
 * Every part of this existed and none of it was connected: `RunLog.append`/`commit`
 * accept a `fencingToken`, `SqliteStateStore.append` compares it against `task_fence`'s
 * `max_token` and raises, and `E_LEASE_LOST`/`E_FENCING_STALE` are declared in
 * `errors.ts`. The engine minted a token, journaled it, and never presented it — so the
 * check had no input and `E_FENCING_STALE` had no thrower.
 *
 * The token could not be the process-local counter it was minted from. A second process
 * starts its counter at 1 and would lose to the first's `max_token`, so arming that would
 * fence the LEGITIMATE worker. The journal's seq is the one monotonic value every process
 * shares — the store's compare-and-set assigns it — so the lease's own seq is the token.
 *
 * This matters now because the maintainer chose multi-process workers on one device.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../../src/journal/memory.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { CODES, err } from "../../src/errors.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";
import { SYSTEM_ACTOR, type NewEvent } from "../../src/journal/events.ts";
import type { RunId, TaskId } from "../../src/ids.ts";

const TASK = "n@root#0" as TaskId;

const lease = (worker: string, attempt: number): NewEvent => ({
  type: "task.leased",
  payload: { workerId: worker, attempt, fencingToken: attempt },
  actor: SYSTEM_ACTOR("scheduler"),
  taskId: TASK,
});
const work = (): NewEvent => ({
  type: "task.progress",
  payload: { chunk: "x" },
  actor: SYSTEM_ACTOR("executor"),
  taskId: TASK,
});

test("THE STORE REFUSES A STALE LEASE — a re-leased Task cannot be written by its old holder", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const runId = "run_fence" as RunId;

  // Each worker's token is the seq of ITS OWN lease — which it only knows once the append
  // returns, which is why the engine records it at that moment rather than minting it.
  const a = await store.append({ runId, expectedSeq: 0, taskId: TASK, events: [lease("A", 1)] });
  const b = await store.append({ runId, expectedSeq: a.seq, taskId: TASK, events: [lease("B", 2)] });
  assert.ok(b.seq > a.seq, "the later lease necessarily carries the higher token");

  // B, the current holder, commits its work and thereby raises the fence.
  const committed = await store.append({
    runId,
    expectedSeq: b.seq,
    taskId: TASK,
    fencingToken: b.seq,
    events: [work()],
  });

  // A finishes and writes under the lease it no longer holds.
  await assert.rejects(
    () => store.append({ runId, expectedSeq: committed.seq, taskId: TASK, fencingToken: a.seq, events: [work()] }),
    /fenc|stale|lease/i,
    "a worker whose lease was taken must not be able to write under it",
  );
});

test("the holder of the CURRENT lease still writes normally", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const runId = "run_ok" as RunId;

  const leased = await store.append({ runId, expectedSeq: 0, taskId: TASK, events: [lease("A", 1)] });
  // A fence that refuses everybody is indistinguishable from a broken engine.
  const after = await store.append({
    runId,
    expectedSeq: leased.seq,
    taskId: TASK,
    fencingToken: leased.seq,
    events: [work()],
  });
  assert.ok(after.seq > leased.seq);
});

/**
 * The fence has to be on EVERY exit from `#commit`, not just the last one.
 *
 * `#commit` has three: a retryable failure reschedules and returns, a rejected mutation
 * records the failure and returns, and everything else falls through to the ordinary
 * commit. Only the third presented the lease, so a worker whose lease another process had
 * taken could still reschedule the Task or write a mutation failure on top of the new
 * leaseholder's work — silently, because both paths commit successfully when the store is
 * not shown a token to refuse.
 */
test("EVERY EXIT FROM #commit PRESENTS THE LEASE — the retry path is not a way around the fence", async () => {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  // `store.append` is where the token is CHECKED — `MemoryStateStore` keeps a `fences` map
  // per task and refuses anything below the highest it has seen. So it is also the honest
  // place to observe whether a token was shown at all. Only appends carrying a `taskId` are
  // counted: run-level events are not leased and have no token to present.
  // Recorded per append, paired with the event types it carried, so the assertion can name
  // the OUTCOME commits specifically. Two other task-scoped appends legitimately carry no
  // token: `task.leased` mints it (there is nothing to present yet) and `policy.decided` is
  // a decision record rather than a commit of the Task's outcome.
  const appends: { types: string[]; token: number | undefined }[] = [];
  const realAppend = store.append.bind(store);
  (store as unknown as { append: unknown }).append = ((input: {
    taskId?: string;
    fencingToken?: number;
    events: { type: string }[];
  }) => {
    if (input.taskId !== undefined) {
      appends.push({ types: input.events.map((e) => e.type), token: input.fencingToken });
    }
    return realAppend(input as never);
  }) as unknown;

  const functions = new FunctionRegistry();
  let attempts = 0;
  // Fails once with a retryable class, so the retry-scheduled exit is taken, then succeeds.
  functions.register("function/flaky@stable", () => {
    attempts += 1;
    if (attempts === 1) throw err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, "transient");
    return { writes: { out: "ok" } };
  });

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: "{}", finishReason: "stop" }) }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    maxParallelism: 1,
    policy: { granted: [], budget: { runUsd: 1 } },
  });

  const spec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "fence-every-exit", project: "probe", version: 1 },
    policy: { expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
    channels: { seed: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["out"],
    // `retry` is a NODE policy, not a graph one — putting it on the graph compiles and
    // retries nothing, which is how this probe first reported one attempt.
    nodes: [
      {
        id: "a",
        type: "function",
        reads: ["seed"],
        writes: ["out"],
        function: { ref: "function/flaky@stable" },
        retry: { maxAttempts: 3, backoff: "fixed", initialMs: 1 },
      },
    ],
    edges: [],
  };
  const graph = compileOrThrow({ spec: spec as never, resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const runId = await engine.submit({ graph, inputs: { seed: "go" } });
  await engine.advance(runId).catch(() => engine.projection(runId));

  // `advance` returns while the retry is still in backoff, so a second attempt has not run
  // yet — the attempt COUNT is the wrong observable. The journal event is the right one:
  // `task.retry_scheduled` is written by, and only by, the exit under test.
  const events = [];
  for await (const ev of store.read(runId, 1)) events.push(ev.type);
  assert.ok(
    events.includes("task.retry_scheduled"),
    `the retry exit must actually be taken; saw ${events.join(", ")}`,
  );
  assert.ok(attempts >= 1);
  // The three exits from `#commit`, by the event each one writes.
  const COMMIT_EVENTS = new Set(["task.retry_scheduled", "task.committed"]);
  const commits = appends.filter((a) => a.types.some((t) => COMMIT_EVENTS.has(t)));
  assert.ok(commits.length > 0, "no commit was observed, so this proves nothing");
  const unfenced = commits.filter((a) => a.token === undefined);
  assert.equal(
    unfenced.length,
    0,
    `every exit from #commit must present the lease; unfenced: ${unfenced.map((a) => a.types.join("+")).join(", ")}`,
  );
});
