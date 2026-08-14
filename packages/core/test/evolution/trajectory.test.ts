/**
 * Trajectory capture, normalization, and scoring.
 *
 * Two claims under test. First, that normalization actually makes "the same strategy"
 * mean something: a flaky retry and a different fan-out arrival order must both fold to
 * the same trajectory. Second, that the signal ladder cannot be climbed by a model
 * grading itself — S4 alone never reaches golden, and never reaches `stable`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { shapeOf } from "../../src/canonical.ts";
import {
  DEFAULT_WEIGHTS,
  cohortKeyOf,
  isGolden,
  measureCohort,
  outcomeOf,
  promotionCeiling,
  readSignals,
  scoreTrajectory,
  type CohortStats,
  type DownstreamOutcome,
} from "../../src/evolution/score.ts";
import { foldTrajectory, type Trajectory } from "../../src/evolution/trajectory.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId, TaskId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, MockModelAdapter } from "../../src/run/registry.ts";
import { DOCS, compileSkeleton, harness, resolver } from "../run/skeleton.ts";
import { digest } from "../../src/canonical.ts";

const n = (id: string): NodeId => id as NodeId;

// ── shapeOf: the privacy boundary ────────────────────────────────────────────

test("shapeOf keeps structure and drops every value", () => {
  assert.equal(shapeOf({ namespace: "prod-payments", replicas: 3 }), "{namespace:string,replicas:number}");
  assert.equal(shapeOf({ token: "sk-live-abc123" }), "{token:string}");
});

test("shapeOf is stable under key order, so one strategy renders one way", () => {
  assert.equal(shapeOf({ b: 1, a: "x" }), shapeOf({ a: "y", b: 999 }));
});

test("shapeOf describes a heterogeneous array rather than mis-describing it", () => {
  assert.equal(shapeOf([1, "a", 2]), "[number|string]");
  assert.equal(shapeOf([]), "[]");
});

test("shapeOf recurses, so a nested secret is still only a shape", () => {
  assert.equal(shapeOf({ auth: { bearer: "eyJ..." } }), "{auth:{bearer:string}}");
});

// ── the fold, against a real run ─────────────────────────────────────────────

async function skeletonEvents(opts: Parameters<typeof harness>[0] & { inputs?: string[] } = {}) {
  const h = harness(opts);
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: opts.inputs ?? DOCS } });
  let p = await h.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open");
  if (gate !== undefined) {
    p = await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
  }
  const events: JournalEvent[] = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);
  return { events, graph, projection: p, harness: h };
}

test("a trajectory is a pure fold — capture costs the run nothing", async () => {
  const { events, graph } = await skeletonEvents();
  const a = foldTrajectory(events, { graph });
  const b = foldTrajectory(events, { graph });
  assert.deepEqual(a, b, "the same journal always folds to the same trajectory");
  assert.equal(a.outcome.runStatus, "succeeded");
  assert.ok(a.steps.length > 0);
});

test("the fold records usage, gates, and the input DIGEST — not the input", async () => {
  const { events, graph } = await skeletonEvents();
  const t = foldTrajectory(events, { graph });

  assert.ok(t.usage.modelCalls > 0);
  assert.ok(t.usage.toolCalls > 0);
  assert.equal(t.policy.gatesRaised, 1);
  assert.match(t.inputDigest, /^sha256:/);
  assert.equal(
    JSON.stringify(t).includes("doc-0.md"),
    false,
    "a trajectory store that keeps payloads is a second copy of production data",
  );
});

test("a human gate decision is a first-class STEP, not metadata", async () => {
  const { events, graph } = await skeletonEvents();
  const t = foldTrajectory(events, { graph });
  const gateAction = t.steps.flatMap((s) => s.actions).find((a) => a.kind === "gate");
  assert.ok(gateAction, "the best label the system gets must not be buried in an attribute");
  assert.equal(gateAction.kind === "gate" && gateAction.decision, "approve");
  assert.equal(t.outcome.humanDecisions.length, 1);
});

test("tool steps carry the argument SHAPE, never the arguments", async () => {
  const { events, graph } = await skeletonEvents();
  const t = foldTrajectory(events, { graph });
  const shapes = t.steps
    .flatMap((s) => s.actions)
    .filter((a) => a.kind === "tool")
    .map((a) => (a.kind === "tool" ? `${a.name}:${a.argsShape}` : ""));
  assert.ok(shapes.includes("fs.read:{path:string}"), shapes.join(" "));
  assert.ok(shapes.includes("fs.write:{body:string,path:string}"), "including the file body — a shape, not the text");
});

test("a model step is keyed to its promptRef, which is what D10.c optimises", async () => {
  const { events, graph } = await skeletonEvents();
  const t = foldTrajectory(events, { graph });
  const model = t.steps.flatMap((s) => s.actions).find((a) => a.kind === "model");
  assert.ok(model && model.kind === "model");
  assert.equal(model.promptRef, "prompt/summarize-file@stable");
  assert.match(model.promptDigest ?? "", /^sha256:/);
  assert.deepEqual(model.toolCallNames, ["fs.read"], "which phrasing produced which tool sequence");
});

// ── normalization ────────────────────────────────────────────────────────────

test("FAN-OUT ARRIVAL ORDER DOES NOT CHANGE THE TRAJECTORY", async () => {
  // The same five documents summarized in a different order is the same strategy.
  // Without content re-indexing it is two different ones, and a cohort of "similar
  // trajectories" is noise.
  const forward = await skeletonEvents();
  const reverse = await skeletonEvents({ inputs: [...DOCS].reverse() });

  const a = foldTrajectory(forward.events, { graph: forward.graph });
  const b = foldTrajectory(reverse.events, { graph: reverse.graph });

  const strategy = (t: Trajectory) =>
    t.steps.map((s) => [s.branchPath, s.nodeId, s.actions.map((x) => x.kind)]);
  assert.deepEqual(strategy(a), strategy(b));
  assert.equal(a.cohort.inputBucket !== b.cohort.inputBucket, true, "…though the INPUTS still differ");
});

test("branches are ranked by what they DID, not by when they arrived", () => {
  // Two fan-out branches: one made an extra tool call. Whichever index it happened to
  // get, it must land at the same canonical position — that is what makes two runs of
  // one strategy comparable.
  const wide = (heavyIndex: number) =>
    foldTrajectory(
      journal([
        ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
        ...[0, 1].flatMap((i) => {
          const task = `probe@root/e0[${i}]#0`;
          const calls = i === heavyIndex ? ["a.deep", "a.deep"] : ["a.deep"];
          return [
            ...calls.map((name) =>
              ev("tool.called", { key: `k${i}`, name, version: "1", irreversibility: "read_only", idempotent: true, ok: true, ms: 1, argsShape: "{}" }, task),
            ),
            ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, task),
          ];
        }),
        ev("run.completed", { outputs: {}, usage: ZERO }),
      ]),
    );

  const shape = (t: Trajectory) => t.steps.map((s) => [s.branchPath, s.actions.length]);
  assert.deepEqual(shape(wide(0)), shape(wide(1)), "the heavy branch canonicalises to one place either way");
});

test("a retry collapses to one step; the count becomes an attribute", () => {
  // Hand-built so the retry is unambiguous: attempt 1 fails, attempt 2 succeeds.
  const events = journal([
    ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
    ev("task.ready", { nodeId: n("fetch"), branchPath: "root", edgesIn: [] }, "fetch@root#0"),
    ev("tool.called", { key: "k", name: "http.get", version: "1", irreversibility: "read_only", idempotent: true, ok: false, ms: 10, argsShape: "{url:string}" }, "fetch@root#0"),
    ev("task.retry_scheduled", { attempt: 1, afterMs: 100, code: "E_PROVIDER_UNAVAILABLE" }, "fetch@root#0"),
    ev("tool.called", { key: "k", name: "http.get", version: "1", irreversibility: "read_only", idempotent: true, ok: true, ms: 12, argsShape: "{url:string}" }, "fetch@root#0"),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 2 }, "fetch@root#0"),
    ev("run.completed", { outputs: {}, usage: ZERO }),
  ]);

  const t = foldTrajectory(events);
  const step = t.steps.find((s) => s.nodeId === "fetch")!;
  assert.equal(step.attempts, 2, "the retry count is an attribute…");
  assert.equal(step.actions.filter((a) => a.kind === "tool").length, 1, "…not a second step");
  assert.equal(step.status, "succeeded");
});

test("a flaky run and a clean run of the same strategy fold identically", () => {
  const clean = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("tool.called", { key: "k", name: "http.get", version: "1", irreversibility: "read_only", idempotent: true, ok: true, ms: 12, argsShape: "{url:string}" }, "fetch@root#0"),
      ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, "fetch@root#0"),
      ev("run.completed", { outputs: {}, usage: ZERO }),
    ]),
  );
  const flaky = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("tool.called", { key: "k", name: "http.get", version: "1", irreversibility: "read_only", idempotent: true, ok: false, ms: 9, argsShape: "{url:string}" }, "fetch@root#0"),
      ev("task.retry_scheduled", { attempt: 1, afterMs: 100, code: "E_PROVIDER_UNAVAILABLE" }, "fetch@root#0"),
      ev("tool.called", { key: "k", name: "http.get", version: "1", irreversibility: "read_only", idempotent: true, ok: true, ms: 12, argsShape: "{url:string}" }, "fetch@root#0"),
      ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 2 }, "fetch@root#0"),
      ev("run.completed", { outputs: {}, usage: ZERO }),
    ]),
  );

  const strategy = (t: Trajectory) => t.steps.map((s) => [s.nodeId, s.actions]);
  assert.deepEqual(strategy(clean), strategy(flaky), "a flaky network must not fork one strategy into two");
  assert.notEqual(clean.steps[0]!.attempts, flaky.steps[0]!.attempts, "…but the flakiness is still recorded");
});

// ── the ladder ───────────────────────────────────────────────────────────────

const ZERO = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 };

function trajectory(over: Partial<Trajectory> = {}): Trajectory {
  return {
    runId: "run_1" as RunId,
    graphHash: "h",
    cohort: { workflow: "w", graphHash: "h", tenantTier: "default", inputBucket: "b" },
    steps: [],
    outcome: { assertions: [], humanDecisions: [], rubrics: [], selfReported: false, runStatus: "succeeded" },
    usage: { costUsd: 1, tokens: 100, wallMs: 1000, modelCalls: 1, toolCalls: 1 },
    policy: { escalations: [], violations: 0, gatesRaised: 1 },
    inputDigest: digest({}),
    fromUnpromotedCandidate: false,
    ...over,
  };
}

const cohort = (over: Partial<CohortStats> = {}): CohortStats => ({
  key: "w|h|default|b",
  n: 30,
  p50Cost: 1,
  p50Wall: 1000,
  p50Gates: 1,
  p90Score: 0.5,
  weightsDigest: digest(DEFAULT_WEIGHTS),
  ...over,
});

test("self-report is weighted ZERO — it cannot move the outcome at all", () => {
  const only = readSignals(trajectory({ outcome: { assertions: [], humanDecisions: [], rubrics: [], selfReported: true, runStatus: "succeeded" } }));
  assert.equal(only.length, 1);
  assert.equal(only[0]?.id, "S5");
  assert.equal(outcomeOf(only), 0, "a run whose only evidence is 'I finished' has no evidence");
});

test("an assertion outweighs a rubric, and the arithmetic says so", () => {
  const signals = readSignals(
    trajectory({
      outcome: {
        assertions: [{ nodeId: n("verify"), pass: true }],
        humanDecisions: [],
        rubrics: [{ nodeId: n("judge"), score: 0, pass: false }],
        selfReported: false,
        runStatus: "succeeded",
      },
    }),
  );
  // (1.0·1 + 0.3·0) / 1.3 ≈ 0.769 — the model's disagreement is heard, not obeyed.
  assert.ok(Math.abs(outcomeOf(signals) - 1 / 1.3) < 1e-9);
});

test("a human reject drives the outcome down even with a passing rubric", () => {
  const signals = readSignals(
    trajectory({
      outcome: {
        assertions: [],
        humanDecisions: [{ nodeId: n("approve"), decision: "reject", latencyMs: 5 }],
        rubrics: [{ nodeId: n("judge"), score: 1, pass: true }],
        selfReported: true,
        runStatus: "failed",
      },
    }),
  );
  // (0.9·0 + 0.3·1) / 1.2 = 0.25
  assert.ok(Math.abs(outcomeOf(signals) - 0.25) < 1e-9);
});

test("an edit is a half-win, because it is a correction the human had to make", () => {
  const s = readSignals(
    trajectory({
      outcome: {
        assertions: [],
        humanDecisions: [{ nodeId: n("g"), decision: "edit", latencyMs: 1 }],
        rubrics: [],
        selfReported: false,
        runStatus: "succeeded",
      },
    }),
  );
  assert.equal(s.find((x) => x.id === "S2")?.value, 0.5);
});

test("S3 is only read once the maturation window has elapsed", () => {
  const t = trajectory();
  const immature: DownstreamOutcome = { matured: false, reworked: false, incidentReopened: false };
  assert.equal(readSignals(t, immature).some((s) => s.id === "S3"), false, "no complaints yet is not acceptance");
  assert.equal(readSignals(t, { ...immature, matured: true }).some((s) => s.id === "S3"), true);
});

// ── the golden threshold ─────────────────────────────────────────────────────

test("S4 ALONE NEVER REACHES GOLDEN, no matter how high it scores", () => {
  const t = trajectory({
    outcome: {
      assertions: [],
      humanDecisions: [],
      rubrics: [{ nodeId: n("judge"), score: 1, pass: true }],
      selfReported: true,
      runStatus: "succeeded",
    },
    usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 1, toolCalls: 0 },
    policy: { escalations: [], violations: 0, gatesRaised: 0 },
  });
  const scored = scoreTrajectory(t, cohort({ p90Score: 0 }));
  assert.equal(scored.outcome, 1, "the rubric loved it");

  const verdict = isGolden(t, scored, cohort({ p90Score: 0 }));
  assert.equal(verdict.golden, false);
  assert.match(verdict.conditions.find((c) => c.id === 1)!.detail, /ABSENT/);
});

test("a cohort under 30 blocks golden — a p90 of six runs is noise", () => {
  const t = trajectory({ outcome: { assertions: [{ nodeId: n("v"), pass: true }], humanDecisions: [], rubrics: [], selfReported: false, runStatus: "succeeded" } });
  const c = cohort({ n: 6, p90Score: 0 });
  const v = isGolden(t, scoreTrajectory(t, c), c);
  assert.equal(v.golden, false);
  assert.equal(v.conditions.find((x) => x.id === 4)?.pass, false);
});

test("a policy violation blocks golden even with a perfect outcome", () => {
  const t = trajectory({
    outcome: { assertions: [{ nodeId: n("v"), pass: true }], humanDecisions: [], rubrics: [], selfReported: false, runStatus: "succeeded" },
    policy: { escalations: ["violation"], violations: 1, gatesRaised: 0 },
  });
  const c = cohort({ p90Score: 0 });
  assert.equal(isGolden(t, scoreTrajectory(t, c), c).conditions.find((x) => x.id === 3)?.pass, false);
});

test("NO SELF-TRAINING — output of an unpromoted candidate is never golden", () => {
  const t = trajectory({
    outcome: { assertions: [{ nodeId: n("v"), pass: true }], humanDecisions: [], rubrics: [], selfReported: false, runStatus: "succeeded" },
    fromUnpromotedCandidate: true,
  });
  const c = cohort({ p90Score: 0 });
  const v = isGolden(t, scoreTrajectory(t, c), c);
  assert.equal(v.golden, false);
  assert.match(v.conditions.find((x) => x.id === 5)!.detail, /unpromoted candidate/);
});

test("all five conditions met ⇒ golden", () => {
  const t = trajectory({
    outcome: {
      assertions: [{ nodeId: n("v"), pass: true }],
      humanDecisions: [{ nodeId: n("g"), decision: "approve", latencyMs: 3 }],
      rubrics: [],
      selfReported: true,
      runStatus: "succeeded",
    },
    usage: { costUsd: 0.1, tokens: 10, wallMs: 100, modelCalls: 1, toolCalls: 1 },
    policy: { escalations: [], violations: 0, gatesRaised: 0 },
  });
  const c = cohort({ p90Score: 0.5 });
  const v = isGolden(t, scoreTrajectory(t, c), c);
  assert.equal(v.golden, true, JSON.stringify(v.conditions.filter((x) => !x.pass)));
});

// ── cohorts ──────────────────────────────────────────────────────────────────

test("a cohort measured under different weights REFUSES to score", () => {
  const t = trajectory();
  assert.throws(
    () => scoreTrajectory(t, cohort({ weightsDigest: digest({ ...DEFAULT_WEIGHTS, cost: 0.5 }) })),
    (e: unknown) => (e as { code: string }).code === "E_COHORT_INVALIDATED",
  );
});

test("measureCohort derives p50s and a p90 score from its own members", () => {
  const members = Array.from({ length: 30 }, (_, i) =>
    trajectory({
      runId: `run_${i}` as RunId,
      usage: { costUsd: i / 10, tokens: 0, wallMs: i * 10, modelCalls: 1, toolCalls: 0 },
      outcome: { assertions: [{ nodeId: n("v"), pass: i % 2 === 0 }], humanDecisions: [], rubrics: [], selfReported: false, runStatus: "succeeded" },
    }),
  );
  const c = measureCohort("k", members);
  assert.equal(c.n, 30);
  assert.ok(c.p50Cost > 0 && c.p50Wall > 0);
  assert.ok(c.p90Score > 0 && c.p90Score <= 1);

  // The p90 is a real percentile: at most 10% of members clear it.
  const above = members.filter((m) => scoreTrajectory(m, c).score >= c.p90Score).length;
  assert.ok(above <= 4, `${above} of 30 above p90`);
});

test("the cohort key separates workflow, graph, tier, and input bucket", () => {
  assert.equal(cohortKeyOf(trajectory()), "w|h|default|b");
  assert.notEqual(
    cohortKeyOf(trajectory({ cohort: { workflow: "w", graphHash: "h2", tenantTier: "default", inputBucket: "b" } })),
    cohortKeyOf(trajectory()),
    "a different graph is a different thing being measured",
  );
});

// ── the promotion ceiling ────────────────────────────────────────────────────

test("a rubric-only candidate is capped at canary and never auto-promotes", () => {
  const c = promotionCeiling(readSignals(trajectory({ outcome: { assertions: [], humanDecisions: [], rubrics: [{ nodeId: n("j"), score: 1, pass: true }], selfReported: false, runStatus: "succeeded" } })));
  assert.equal(c.channel, "canary");
  assert.equal(c.requiresHumanSignOff, true);
});

test("a deterministic verifier unlocks stable without a human in the loop", () => {
  const c = promotionCeiling(readSignals(trajectory({ outcome: { assertions: [{ nodeId: n("v"), pass: true }], humanDecisions: [], rubrics: [], selfReported: false, runStatus: "succeeded" } })));
  assert.equal(c.channel, "stable");
  assert.equal(c.requiresHumanSignOff, false);
});

test("no signal above self-report means the candidate stays a draft", () => {
  const c = promotionCeiling(readSignals(trajectory({ outcome: { assertions: [], humanDecisions: [], rubrics: [], selfReported: true, runStatus: "succeeded" } })));
  assert.equal(c.channel, "draft");
});

// ── an evaluator's verdict, end to end ───────────────────────────────────────

test("an assertion evaluator yields S1; a rubric evaluator yields S4", async () => {
  // The same verdict SHAPE from two node kinds must not produce the same signal —
  // which one ran is the entire difference between 1.00 and 0.30.
  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "verify", project: "demo", version: 1 },
    channels: {
      claim: { type: "string", reduce: "replace" },
      hard: { type: "object", reduce: "replace" },
      soft: { type: "object", reduce: "replace" },
    },
    inputs: ["claim"],
    outputs: ["hard"],
    nodes: [
      { id: n("assert"), type: "evaluator", reads: ["claim"], writes: ["hard"], evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 1 } },
      { id: n("judge"), type: "evaluator", reads: ["claim"], writes: ["soft"], evaluator: { kind: "rubric", ref: "prompt/rubric@stable", threshold: 0.7 } },
    ],
    edges: [{ id: "e0" as EdgeId, from: n("assert"), to: n("judge"), kind: "seq" }],
  };

  const store = new MemoryStateStore({ now: () => 1 });
  const functions = new FunctionRegistry();
  functions.register("function/check@stable", () => ({ writes: { hard: { pass: true, score: 1 } } }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: JSON.stringify({ pass: false, score: 0.2 }) }) }), true);

  const graph = compileOrThrow({ spec, resolver: resolver(), tools: {}, tenantCapabilities: ["*"] });
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools: new ToolRegistry(),
    functions,
    models,
    now: () => 1,
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const runId = await engine.submit({ graph, inputs: { claim: "the sky is green" } });
  await engine.advance(runId);

  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  const t = foldTrajectory(events, { graph });

  assert.deepEqual(t.outcome.assertions, [{ nodeId: "assert", pass: true }]);
  assert.equal(t.outcome.rubrics.length, 1);
  assert.equal(t.outcome.rubrics[0]?.score, 0.2);

  // 1.0·1 + 0.3·0.2 over 1.3 — the assertion dominates, which is the ladder working.
  assert.ok(Math.abs(outcomeOf(readSignals(t)) - (1 + 0.3 * 0.2) / 1.3) < 1e-9);
});

test("THE CANONICALISER ORDERS BY CODE UNIT, NOT BY THE MACHINE'S COLLATION", () => {
  // `localeCompare` is locale- and ICU-dependent — `"apple".localeCompare("Zebra")` is
  // negative while code-unit order puts `Z` (0x5A) before `a` (0x61). A canonicaliser
  // that reads it folds the same journal two ways on two machines, so the same run lands
  // in two cohorts and gets two `isGolden` verdicts.
  const t = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, "apple@root#0"),
      ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, "Zebra@root#0"),
      ev("run.completed", { outputs: {}, usage: ZERO }),
    ]),
  );
  assert.deepEqual(t.steps.map((s) => s.nodeId), ["Zebra", "apple"]);
});

// ── helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
type Ev = { type: string; payload: unknown; taskId?: string };
function ev(type: string, payload: unknown, taskId?: string): Ev {
  return taskId === undefined ? { type, payload } : { type, payload, taskId };
}
function journal(events: readonly Ev[]): JournalEvent[] {
  seq = 0;
  return events.map(
    (e) =>
      ({
        seq: ++seq,
        runId: "run_1" as RunId,
        at: seq,
        actor: { kind: "system", id: "test" },
        ...e,
        ...(e.taskId === undefined ? {} : { taskId: e.taskId as TaskId }),
      }) as unknown as JournalEvent,
  );
}
