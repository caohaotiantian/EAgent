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
import type { ModelEvent, ModelRequest } from "../../src/run/registry.ts";
import { DOCS, compileSkeleton, harness, resolver } from "../run/skeleton.ts";
import { digest } from "../../src/canonical.ts";
import { agent } from "../../src/agent.ts";

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
  // THE INPUTS REALLY DO DIFFER — five documents in the opposite order is a different input,
  // and `inputDigest` still says so. What CHANGED is the bucket: it used to be a digest of the
  // whole input, so these two runs of one strategy landed in two cohorts of one and neither
  // could ever reach `MIN_COHORT_SIZE`. The default is the input's SHAPE now, and both runs
  // are `{paths:[string]}`, so the same strategy over the same kind of problem is one cohort.
  assert.notEqual(a.inputDigest, b.inputDigest, "the INPUTS still differ…");
  assert.equal(cohortKeyOf(a), cohortKeyOf(b), "…and the two runs are nonetheless comparable");
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
    authoredGraphHash: "h",
    cohort: { workflow: "w", graphHash: "h", tenantTier: "default", inputBucket: "b" },
    steps: [],
    outcome: { assertions: [], humanDecisions: [], rubrics: [], selfReported: false, runStatus: "succeeded" },
    usage: { costUsd: 1, tokens: 100, wallMs: 1000, modelCalls: 1, toolCalls: 1 , subgraphRuns: 0 },
    policy: { escalations: [], violations: 0, gatesRaised: 1 },
    inputDigest: digest({}),
    fromUnpromotedCandidate: false,
    /** The fold had the graph; `score.ts` refuses to call a `false` here a measurement. */
    specResolved: true,
    verdictsResolved: true,
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
  // A HAND-BUILT COHORT IS RANKABLE BY DEFAULT. `outcomeSpread` 0 makes `isGolden` condition 2
  // refuse outright (a saturated ladder ranks price), and every fixture below that is about some
  // OTHER condition would then be testing this one instead. The tests that mean to exercise the
  // refusal set it to 0 by name.
  outcomeSpread: 0.5,
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
    usage: { costUsd: 0, tokens: 0, wallMs: 0, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 },
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
    usage: { costUsd: 0.1, tokens: 10, wallMs: 100, modelCalls: 1, toolCalls: 1 , subgraphRuns: 0 },
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
      usage: { costUsd: i / 10, tokens: 0, wallMs: i * 10, modelCalls: 1, toolCalls: 0 , subgraphRuns: 0 },
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
  assert.equal(t.specResolved, true, "the control for the fold below");

  // …AND WITHOUT THE GRAPH THE SAME JOURNAL HAS NO LADDER AT ALL. `extractSignals` keys on
  // node types and node types come from `spec.nodes`, so both verdicts vanish and the run
  // reads exactly like one that failed every assertion. This is the fold half of the defect
  // `loom score` refused for: a candidate graph lives in candidates/, never resolves out of
  // `<workspace>/graphs/`, and scored 0.111 instead of 0.700 on the same journal.
  const blind = foldTrajectory(events);
  assert.deepEqual(blind.outcome.assertions, [], "no spec, no assertion — the verdict is still in `writes`");
  assert.deepEqual(blind.outcome.rubrics, []);
  assert.equal(blind.outcome.selfReported, false);
  assert.equal(outcomeOf(readSignals(blind)), 0, "which reads as outcome 0, the number a total failure earns");
  assert.equal(
    blind.specResolved,
    false,
    "so the fold has to say which zero it is; score.ts refuses to call this a measurement",
  );
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

// ── spend, folded once ───────────────────────────────────────────────────────

test("TRAJECTORY SPEND EQUALS PROJECTION SPEND on one real run", async () => {
  // The journal states the same money more than once — once per `model.called`, again on the
  // `task.committed` that settles the task, again as the run total on `run.completed`. A fold
  // that adds them reports 3x the spend and the scorer's cost term punishes a run for money
  // nobody spent. The projection is the second reader of the same events and the number a user
  // is shown; on a run with no tools and no subgraph the two must agree exactly.
  //
  // `now` ADVANCES, and the adapter reports a real per-turn `wallMs`, because the previous
  // version of this test asserted `t.usage.wallMs === r.usage.wallMs` with both sides 0 — an
  // assertion that cannot fail is not a control. `MockModelAdapter` hardcodes `wallMs: 0`, so
  // the turn time comes from the wrapper below.
  const TURN_MS = 37;
  const a = agent({
    prompt: "summarize the input",
    model: "mock-1",
    adapter: new TimedMockAdapter(TURN_MS, { script: () => ({ text: "done", inputTokens: 1000, outputTokens: 200 }) }),
    now: clock(),
  });

  const r = await a.run("hello");
  assert.equal(r.status, "succeeded");
  assert.ok(r.usage.costUsd > 0, "a run that cost nothing cannot detect triple-counting");
  assert.equal(r.usage.wallMs, TURN_MS, "the control has to be non-zero or the next line is vacuous");

  const t = await a.trajectory(r.runId);
  assert.equal(t.usage.costUsd, r.usage.costUsd, "one run, one bill");
  assert.equal(t.usage.tokens, r.usage.inputTokens + r.usage.outputTokens);
  assert.equal(t.usage.wallMs, r.usage.wallMs);
});

test("a FAILED run reports the wall time and the spend its tasks burned", () => {
  // `run.failed` carries no usage, so a fold that reads its totals off `run.completed`
  // reports a failure as free and instantaneous — which is exactly the run the score used
  // to reward. This fixture states the same spend on BOTH the effect record and the commit,
  // so it is also the double-count control: 0.002, not 0.004.
  const spend = { inputTokens: 400, outputTokens: 100, costUsd: 0.002, wallMs: 1200 };
  const t = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("model.called", { key: "m", provider: "mock", model: "m1", finishReason: "stop", usage: spend }, "work@root#0"),
      ev("task.committed", { status: "failed", writes: {}, take: [], usage: spend, attempt: 1 }, "work@root#0"),
      ev("run.failed", { error: { code: "E_INTERNAL", message: "boom", retryable: false } }),
    ]),
  );

  assert.equal(t.outcome.runStatus, "failed");
  assert.equal(t.usage.costUsd, 0.002, "counted once, not once per event that mentions it");
  assert.equal(t.usage.wallMs, 1200, "a failure that escapes the latency term is a free failure");
  assert.equal(t.usage.tokens, 500);
});

test("A FAILED ATTEMPT THAT SPENT MONEY IS BILLED FOR IT — audit F27's own shape", () => {
  // The engine commits `ZERO_USAGE` on every failure path that already paid a provider — an
  // expired lease, a policy denial, a rejected mutation. Folding spend from `task.committed`
  // therefore reported `costUsd: 0` next to `modelCalls: 1`: one model call that cost nothing,
  // a record that contradicts itself, and a metric that pays a run for money it burned.
  const spend = { inputTokens: 1000, outputTokens: 500, costUsd: 0.25, wallMs: 900 };
  const ZERO_SPEND = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallMs: 0 };
  const t = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("model.called", { key: "a@root#0/model/0", provider: "p", model: "m", finishReason: "stop", usage: spend }, "a@root#0"),
      ev("task.committed", { status: "failed", writes: {}, take: [], usage: ZERO_SPEND, attempt: 1 }, "a@root#0"),
      ev("run.failed", { error: { code: "E_LEASE_EXPIRED", message: "lease expired", retryable: false } }),
    ]),
  );

  assert.equal(t.usage.modelCalls, 1, "control: the call is in the fold at all");
  assert.equal(t.usage.costUsd, 0.25, "the provider was paid; the summary that says otherwise is a summary");
  assert.equal(t.usage.tokens, 1500);
  assert.equal(t.usage.wallMs, 900);
});

test("A RETRIED ATTEMPT'S SPEND IS NOT REFUNDED BY SUCCEEDING THE SECOND TIME", () => {
  // A retryable failure appends `task.retry_scheduled` + `task.ready` and NO `task.committed`
  // (`run/engine.ts` 4489-4515), so the first attempt's bill exists only on its `model.called`.
  // A fold that reads commits reported half of what the run cost — under-counting in the
  // direction that flatters the run, which is the direction that matters.
  const turn = { inputTokens: 200, outputTokens: 100, costUsd: 0.003, wallMs: 400 };
  const t = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("task.ready", { nodeId: "a", branchPath: "root", edgesIn: [] }, "a@root#0"),
      ev("model.called", { key: "a@root#0/model/0", provider: "p", model: "m", finishReason: "stop", usage: turn }, "a@root#0"),
      ev("task.retry_scheduled", { attempt: 1, afterMs: 10, code: "E_PROVIDER_UNAVAILABLE" }, "a@root#0"),
      ev("task.ready", { nodeId: "a", branchPath: "root", edgesIn: [] }, "a@root#0"),
      ev("model.called", { key: "a@root#0/model/1", provider: "p", model: "m", finishReason: "stop", usage: turn }, "a@root#0"),
      ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: turn, attempt: 2 }, "a@root#0"),
      ev("run.completed", { outputs: {}, usage: turn }),
    ]),
  );

  assert.equal(t.outcome.runStatus, "succeeded");
  assert.equal(t.usage.costUsd, 0.006, "two calls happened, so two calls are billed");
  assert.equal(t.usage.tokens, 600);
  assert.equal(t.usage.wallMs, 800);
  // The RETRY RULE still holds on top of it: one step, two attempts, the discarded attempt's
  // actions gone. Money is not an action, and it does not get discarded with them.
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0]?.attempts, 2);
});

test("TOOL TIME IS BURNED TIME — the projection cannot see it, and the latency term should", () => {
  // A `tool` node commits ZERO_USAGE and an agent's tool calls run BETWEEN model turns, so no
  // `task.committed` anywhere carries a tool's milliseconds. Fold them and a run that spends
  // thirty seconds in a tool stops looking instantaneous.
  const turn = { inputTokens: 10, outputTokens: 10, costUsd: 0.001, wallMs: 100 };
  const t = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("model.called", { key: "k0", provider: "p", model: "m", finishReason: "tool_use", usage: turn }, "a@root#0"),
      ev("tool.called", { key: "k1", name: "http.get", version: "1", irreversibility: "none", idempotent: true, ok: true, ms: 2500, argsShape: "{url:string}" }, "a@root#0"),
      ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: turn, attempt: 1 }, "a@root#0"),
      ev("run.completed", { outputs: {}, usage: turn }),
    ]),
  );

  assert.equal(t.usage.toolCalls, 1);
  assert.equal(t.usage.wallMs, 2600, "100ms of model plus 2500ms of tool, and the commit knows only the 100");
  assert.equal(t.usage.costUsd, 0.001, "a tool call carries no cost of its own, and inventing one would be a lie");
});

test("A SUBGRAPH'S CHILD SPEND IS COUNTED ONCE IN THE PARENT", () => {
  // The child's own `model.called` rows are in the CHILD's journal, so `subgraph.completed` is
  // the only place the parent's fold can see that money — and reading it here cannot
  // double-count, because there is nothing here to double it with.
  const child = { inputTokens: 50, outputTokens: 20, costUsd: 0.01, wallMs: 700 };
  const t = foldTrajectory(
    journal([
      ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
      ev("subgraph.completed", { childRunId: "run_2", ref: "sub@stable", status: "succeeded", usage: child, outputs: ["out"] }, "s@root#0"),
      ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: { ...child, inputTokens: 0, outputTokens: 0 }, attempt: 1 }, "s@root#0"),
      ev("run.completed", { outputs: {}, usage: child }),
    ]),
  );

  assert.equal(t.usage.costUsd, 0.01);
  assert.equal(t.usage.tokens, 70);
  assert.equal(t.usage.wallMs, 700);
});

test("CONDITION 5 IS NOT A FREE PASS — an unanswered promotion set means unpromoted", () => {
  const events = journal([
    ev("run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "i", configDigest: "c" }),
    ev("task.committed", { status: "succeeded", writes: {}, take: [], usage: ZERO, attempt: 1 }, "work@root#0"),
    ev("run.completed", { outputs: {}, usage: ZERO }),
  ]);

  assert.equal(
    foldTrajectory(events).fromUnpromotedCandidate,
    true,
    "a caller who never named the promoted graphs has not certified this one",
  );
  assert.equal(foldTrajectory(events, { promotedGraphHashes: new Set(["h"]) }).fromUnpromotedCandidate, false);
  assert.equal(foldTrajectory(events, { promotedGraphHashes: new Set(["other"]) }).fromUnpromotedCandidate, true);
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

/** A monotonic test clock. `now: () => 1` makes every duration 0, which is unfalsifiable. */
function clock(step = 1): () => number {
  let t = 1_700_000_000_000;
  return () => (t += step);
}

/**
 * `MockModelAdapter` with `wallMs` on the turn.
 *
 * It exists because the shipped mock hardcodes `usage.wallMs: 0` (`run/registry.ts`), so every
 * assertion about model wall time made through it compares 0 to 0. Wrapping rather than
 * changing that adapter keeps every other suite's numbers where they were.
 */
class TimedMockAdapter extends MockModelAdapter {
  readonly #ms: number;
  constructor(ms: number, opts: ConstructorParameters<typeof MockModelAdapter>[0]) {
    super(opts);
    this.#ms = ms;
  }
  override async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    for await (const e of super.stream(req, signal)) {
      yield e.type === "done" ? { ...e, usage: { ...e.usage, wallMs: this.#ms } } : e;
    }
  }
}
