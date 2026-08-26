/**
 * F19, SETTLED ON A REAL ENGINE: a retry must not delete the human's answer.
 *
 * `foldTrajectory`'s retry rule used to do `s.actions.length = 0` on
 * `task.retry_scheduled`. `gate.decided` is journaled on the SAME Task that may then retry —
 * so a transient failure after a human approved erased the `gate` action, and with it S2,
 * `outcome.humanDecisions`, `readSignals`' human term and `promotionCeiling`'s "a human
 * decided on it" ⇒ `stable`.
 *
 * The finding had been reproduced twice on HAND-BUILT journals and never on a live engine,
 * so it could still have been a shape the engine refuses to produce. It is not. Under the
 * `in` posture floor a `tool` node raises its own gate on its own Task
 * (`policy.decided{effect:"gate"}`), and a retryable tool failure on the attempt that
 * follows the approval appends `task.retry_scheduled` to that same Task. Measured journal:
 *
 *     5  task.leased          write@root#0  attempt 1
 *     7  gate.raised          write@root#0
 *     9  gate.decided         write@root#0  approve
 *     11 task.leased          write@root#0  attempt 2
 *     13 tool.called          write@root#0  ok false
 *     15 task.retry_scheduled write@root#0  attempt 2
 *     17 task.leased          write@root#0  attempt 3
 *     19 tool.called          write@root#0  ok true
 *     21 task.committed       write@root#0  succeeded
 *
 * Before the fix that journal folded to `humanDecisions: []` and ceiling `draft`; after it,
 * one `approve` and ceiling `stable`.
 *
 * The tool answers with an ERROR RESULT rather than throwing, and that is deliberate: a throw
 * leaves `effect.failed` and no `tool.called`, so the retry would have nothing to clear and the
 * assertion that it still clears the failed attempt would hold vacuously. This shape journals
 * `tool.called{ok:false}` on the attempt that is thrown away, so the fold has to drop one
 * action and keep another — which is the whole rule under test.
 *
 * Offline and deterministic: no model adapter is reached, the tool is a local closure, and
 * the harness clock is injected.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import { isEvent, type JournalEvent } from "../../src/journal/events.ts";
import type { ToolDefinition } from "../../src/run/registry.ts";
import { foldTrajectory, type Trajectory } from "../../src/evolution/trajectory.ts";
import { promotionCeiling, readSignals } from "../../src/evolution/score.ts";
import { CODES, err } from "../../src/errors.ts";
import { SKELETON_TENANT_CAPS, SKELETON_TOOLS, harness, resolver } from "../run/skeleton.ts";

/** One gated, retrying tool node. The smallest graph that can hold both facts at once. */
function oneWriteSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gate-then-retry", project: "demo", version: 1 },
    policy: {
      posture: "on",
      budget: { costUsd: 1, tokens: 200_000, wallMs: 120_000 },
      expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
      capabilities: ["fs:read", "fs:write"],
    },
    channels: {
      merged: { type: "object", reduce: "replace" },
      written: { type: "object", reduce: "replace" },
    },
    inputs: ["merged"],
    outputs: ["written"],
    nodes: [
      {
        id: "write" as NodeId,
        type: "tool",
        reads: ["merged"],
        writes: ["written"],
        tool: { name: "fs.write", version: "1.0", args: { path: "out/x.md", body: "${merged.markdown}" } },
        retry: { maxAttempts: 3 },
      },
    ],
    edges: [],
  };
}

/**
 * Run it with a tool that throws exactly `failTimes` times, approving every gate the run
 * raises. `failTimes: 0` is the control — the same graph, the same approval, no retry.
 */
async function gatedRun(failTimes: number): Promise<{ events: JournalEvent[]; trajectory: Trajectory; status: string }> {
  const h = harness({ systemFloor: "in", maxParallelism: 1 });
  let calls = 0;
  const flaky: ToolDefinition = {
    ...SKELETON_TOOLS["fs.write"]!,
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, body: { type: "string" } },
      required: ["path", "body"],
    },
    execute: (args) => {
      calls++;
      if (calls <= failTimes) {
        return {
          content: "upstream said try again",
          isError: true,
          error: err.unavailable(CODES.E_TOOL_SOURCE_UNAVAILABLE, "transient upstream failure"),
        };
      }
      return { content: "wrote", writes: { written: { path: String(args["path"]) } } };
    },
  };
  h.tools.register(flaky);

  const graph = compileOrThrow({
    spec: oneWriteSpec(),
    resolver: resolver(),
    tools: SKELETON_TOOLS,
    tenantCapabilities: SKELETON_TENANT_CAPS,
  });
  const runId = await h.engine.submit({ graph, inputs: { merged: { markdown: "hello" } } });
  let p = await h.engine.advance(runId);
  for (let i = 0; i < 8; i++) {
    const gate = Object.values(p.gates).find((g) => g.state === "open");
    if (gate === undefined) break;
    await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: `k${String(i)}`,
    });
    // The retry backoff is on the injected clock, so time only moves when this says so.
    h.tick(60_000);
    p = await h.engine.advance(runId);
  }
  const events: JournalEvent[] = [];
  for await (const e of h.store.read(runId as RunId, 1 as never)) events.push(e);
  return { events, trajectory: foldTrajectory(events, { graph }), status: p.status };
}

test("F19 IS REAL: a live engine journals gate.decided and task.retry_scheduled on ONE Task", async () => {
  const { events, status } = await gatedRun(1);
  assert.equal(status, "succeeded");

  const gated = events.filter((e) => isEvent(e, "gate.decided")).map((e) => e.taskId);
  const retried = events.filter((e) => isEvent(e, "task.retry_scheduled")).map((e) => e.taskId);
  assert.deepEqual(gated, ["write@root#0"], "the human decided ON the tool Task, not beside it");
  assert.deepEqual(retried, ["write@root#0"], "…and that same Task then retried");
});

test("THE FIX: the retry drops the failed attempt's actions and KEEPS the human's answer", async () => {
  const { trajectory: t } = await gatedRun(1);

  const step = t.steps.find((s) => s.nodeId === "write");
  assert.ok(step !== undefined);
  assert.deepEqual(
    step.actions.filter((a) => a.kind === "gate").map((a) => (a.kind === "gate" ? a.decision : "")),
    ["approve"],
    "the gate action survives the retry",
  );
  // The retry rule still holds for what a retry actually invalidates: the failed attempt's
  // tool call is gone, and only the succeeding one is left.
  assert.deepEqual(
    step.actions.filter((a) => a.kind === "tool").map((a) => (a.kind === "tool" ? a.ok : null)),
    [true],
    "the failed attempt's tool.called{ok:false} is gone; only the succeeding call is left",
  );

  assert.deepEqual(
    t.outcome.humanDecisions.map((d) => [d.nodeId, d.decision]),
    [["write", "approve"]],
    "S2 reaches the scorer",
  );
});

test("THE CONSEQUENCE: the promotion ceiling no longer depends on whether the run was flaky", async () => {
  const flaky = await gatedRun(1);
  const clean = await gatedRun(0);

  // The control proves the assertion below is about the RETRY and not about the graph.
  assert.equal(clean.events.some((e) => isEvent(e, "task.retry_scheduled")), false);
  assert.equal(flaky.events.some((e) => isEvent(e, "task.retry_scheduled")), true);

  const ceilingOf = (t: Trajectory) => promotionCeiling(readSignals(t)).channel;
  assert.equal(ceilingOf(clean.trajectory), "stable", "a human decided on it");
  assert.equal(
    ceilingOf(flaky.trajectory),
    ceilingOf(clean.trajectory),
    "a transient failure is not a reason to lose the best label the system ever gets",
  );

  const s2 = (t: Trajectory) => readSignals(t).find((s) => s.id === "S2")?.value;
  assert.equal(s2(clean.trajectory), 1);
  assert.equal(s2(flaky.trajectory), s2(clean.trajectory), "and the signal reads the same value");
});

test("a REJECTED gate survives a retry too — the label that stops promotion is the one worth losing", async () => {
  // Same shape, opposite decision, driven by hand so the reject lands on a Task that then
  // retries. A fold that kept only approvals would pass every test above and still delete
  // the one decision that blocks a bad graph.
  const h = harness({ systemFloor: "in", maxParallelism: 1 });
  const graph = compileOrThrow({
    spec: oneWriteSpec(),
    resolver: resolver(),
    tools: SKELETON_TOOLS,
    tenantCapabilities: SKELETON_TENANT_CAPS,
  });
  const runId = await h.engine.submit({ graph, inputs: { merged: { markdown: "hello" } } });
  const p = await h.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "reject", reason: "no" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k",
  });
  await h.engine.advance(runId);

  const events: JournalEvent[] = [];
  for await (const e of h.store.read(runId as RunId, 1 as never)) events.push(e);
  // Append a retry AFTER the rejection on the same Task. The engine does not produce this
  // shape — a rejected gate fails the Task outright — so this half is a hand-built journal
  // ON PURPOSE: it pins the fold's rule, not the engine's.
  const t = foldTrajectory(
    [
      ...events,
      {
        ...events[events.length - 1]!,
        seq: (events[events.length - 1]!.seq + 1) as never,
        type: "task.retry_scheduled",
        payload: { attempt: 2, afterMs: 1, code: "E_PROVIDER_UNAVAILABLE" },
        taskId: "write@root#0" as never,
      } as JournalEvent,
    ],
    { graph },
  );
  assert.deepEqual(
    t.outcome.humanDecisions.map((d) => d.decision),
    ["reject"],
  );
});

// ── the half of the retry rule the fix left unguarded ────────────────────────
//
// ADDED 2026-08-26. A verifier mutated the fix line to `filter(a => a.kind !== "tool")` — a
// retry that keeps the failed attempt's MODEL calls — and all thirteen tests here stayed
// green. The rule's stated invariant is that a retry drops the failed attempt's model AND
// tool calls and keeps only the human's answer; only the tool half was pinned. Two runs of
// one strategy, one of which hit a flaky network, must not fold to two strategies — and a
// dropped `model` action is exactly how they would.

test("A RETRY DROPS THE FAILED ATTEMPT'S MODEL CALLS TOO, not only its tool calls", () => {
  const at = 1_700_000_000_000;
  const runId = "01M0Z1RETRYMODEL0000000000";
  const ev = (seq: number, type: string, payload: unknown, taskId?: string) =>
    ({
      runId, seq, ts: at + seq, type, payload,
      actor: { kind: "system", component: "test" }, classification: "internal",
      ...(taskId === undefined ? {} : { taskId }),
    }) as unknown as JournalEvent;

  const T = "a@root#0";
  const usage = { inputTokens: 10, outputTokens: 10, costUsd: 0.001, wallMs: 5 };
  const flaky = [
    ev(1, "run.submitted", { graphHash: "sha256:x", configDigest: "sha256:y", idempotencyKey: "k", inputs: {} }),
    ev(2, "run.compiled", { graphHash: "sha256:x", nodes: 1, edges: 0, resolutionManifest: [] }),
    ev(3, "run.started", { posture: "on" }),
    ev(4, "task.ready", { nodeId: "a", branchPath: "root", edgesIn: [] }, T),
    ev(5, "task.leased", { attempt: 1, workerId: "w0" }, T),
    // The attempt that failed, and the model call it wasted.
    ev(6, "model.called", { key: `${T}:model:0`, provider: "p", model: "m", finishReason: "stop", usage }, T),
    ev(7, "task.retry_scheduled", { attempt: 1, afterMs: 0 }, T),
    ev(8, "task.leased", { attempt: 2, workerId: "w0" }, T),
    // The attempt that worked.
    ev(9, "model.called", { key: `${T}:model:1`, provider: "p", model: "m", finishReason: "stop", usage }, T),
    ev(10, "task.committed", { attempt: 2, status: "succeeded", take: [], writes: { out: 1 }, usage }, T),
    ev(11, "run.completed", { outputs: { out: 1 }, usage }),
  ];
  // The same strategy, without the flake.
  const clean = [
    flaky[0]!, flaky[1]!, flaky[2]!, flaky[3]!,
    ev(5, "task.leased", { attempt: 1, workerId: "w0" }, T),
    ev(6, "model.called", { key: `${T}:model:0`, provider: "p", model: "m", finishReason: "stop", usage }, T),
    ev(7, "task.committed", { attempt: 1, status: "succeeded", take: [], writes: { out: 1 }, usage }, T),
    ev(8, "run.completed", { outputs: { out: 1 }, usage }),
  ];

  const modelActions = (evs: JournalEvent[]): number =>
    foldTrajectory(evs).steps.reduce((n, s) => n + s.actions.filter((a) => a.kind === "model").length, 0);

  assert.equal(modelActions(clean), 1, "control: the clean run has exactly one model action");
  assert.equal(
    modelActions(flaky),
    1,
    "a retry must drop the failed attempt's model call — otherwise a flaky run and a clean run " +
      "of the SAME strategy fold to different trajectories, which is the rule this file exists for",
  );
});
