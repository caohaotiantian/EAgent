/**
 * Incident triage, end to end against the real engine.
 *
 * The walking skeleton proved the architecture; this proves the product. It reaches four
 * surfaces no earlier workflow exercised together — a **router**, an **assertion
 * evaluator**, an **error edge**, and a **compensation edge** — and it is the first
 * graph where a run's oversight comes entirely from what its tools ARE.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { foldTrajectory } from "../../src/evolution/trajectory.ts";
import { outcomeOf, promotionCeiling, readSignals } from "../../src/evolution/score.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type MockScript,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { resolver } from "../run/skeleton.ts";
import {
  INCIDENT_CAPABILITIES,
  INCIDENT_TOOLS,
  assessSeverity,
  extractSignals,
  incidentTriageSpec,
  type Finding,
} from "../../src/workflows/incident-triage.ts";

const n = (id: string): NodeId => id as NodeId;

const ALERT = { symptom: "CrashLoopBackOff", pods: ["api-7f", "api-8a", "worker-2b"] };

const compileTriage = (spec: GraphSpec = incidentTriageSpec()) =>
  compileOrThrow({ spec, resolver: resolver(), tools: INCIDENT_TOOLS, tenantCapabilities: INCIDENT_CAPABILITIES });

// ── the pure functions ───────────────────────────────────────────────────────

test("extractSignals turns one alert into the fan-out's width", () => {
  assert.deepEqual(extractSignals(ALERT).signals, [
    { pod: "api-7f", symptom: "CrashLoopBackOff" },
    { pod: "api-8a", symptom: "CrashLoopBackOff" },
    { pod: "worker-2b", symptom: "CrashLoopBackOff" },
  ]);
  assert.deepEqual(extractSignals(undefined).signals, [], "a malformed alert is an empty fan-out, not a crash");
});

test("a degraded branch LOWERS confidence rather than being ignored", () => {
  const solid: Finding[] = [
    { pod: "a", cause: "oom", confidence: 0.9 },
    { pod: "b", cause: "oom", confidence: 0.9 },
  ];
  const partial: Finding[] = [...solid, { pod: "c", cause: "unknown", confidence: 0, degraded: true }];
  assert.ok(
    assessSeverity(partial).severity < assessSeverity(solid).severity,
    "a partial investigation should be LESS confident, not equally confident about less",
  );
});

test("with nothing to go on, severity is zero and the verdict fails", () => {
  const v = assessSeverity([{ pod: "a", cause: "?", confidence: 1, degraded: true }]);
  assert.equal(v.severity, 0);
  assert.equal(v.pass, false);
});

// ── the compile ──────────────────────────────────────────────────────────────

test("the graph compiles under all 22 rules with no errors", () => {
  const r = compile({
    spec: incidentTriageSpec(),
    resolver: resolver(),
    tools: INCIDENT_TOOLS,
    tenantCapabilities: INCIDENT_CAPABILITIES,
  });
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"), null, 2));
  assert.deepEqual(
    r.diagnostics.filter((d) => d.severity === "error"),
    [],
  );
});

test("OVERSIGHT COMES FROM THE TOOLS, not from the graph asking", () => {
  // The graph declares `posture: "out"` everywhere. These three still gate, because
  // `max` cannot be argued down.
  const g = compileTriage();
  assert.equal(incidentTriageSpec().policy?.posture, "out");
  assert.equal(g.plans[n("remediate")]?.posture, "in", "irreversible");
  assert.equal(g.plans[n("notify")]?.posture, "in", "externally visible");
  assert.equal(g.plans[n("escalate")]?.posture, "in", "a human gate is `in` by definition");
  assert.equal(g.plans[n("ingest")]?.posture, "out", "…and a pure function is not dragged up with them");
});

test("a compensation target is not an entry node", () => {
  const g = compileTriage();
  assert.deepEqual(g.entryNodes, ["ingest"], "scheduling `rollback` at run start would undo work nobody did");
});

test("the fan-out's worst case is priced at compile", () => {
  // 8 branches × $0.20 = $1.60 ≤ the run's $2.00. GRAPH009 proves it before anything runs.
  const g = compileTriage();
  assert.equal(g.plans[n("investigate")]?.maxInstances, 8);
});

// ── the rig ──────────────────────────────────────────────────────────────────

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly tools: ToolRegistry;
  readonly functions: FunctionRegistry;
  readonly calls: string[];
  readonly restarts: string[];
  tick(ms: number): void;
}

interface RigOptions {
  readonly script?: MockScript;
  /** Make the investigation of this pod fail, exercising the error edge. */
  readonly failPod?: string;
  readonly restartThrows?: boolean;
  readonly confidence?: number;
}

/** The default investigator: describe the pod, then answer with a finding. */
function investigator(opts: RigOptions): MockScript {
  return (req, turn) => {
    const parsed = JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { signal?: { pod?: string } } };
    const pod = parsed.state?.signal?.pod ?? "unknown";
    if (opts.failPod === pod) return { text: "the pod is unreachable", finishReason: "stop" };
    if (turn % 2 === 0) {
      return { toolCalls: [{ id: `c${turn}`, name: "k8s.describe", arguments: { pod } }], finishReason: "tool_use" };
    }
    return {
      text: JSON.stringify({ pod, cause: "OOMKilled", confidence: opts.confidence ?? 0.9 }),
      finishReason: "stop",
    };
  };
}

function rig(opts: RigOptions = {}): Rig {
  const clock = { t: 1_700_000_000_000 };
  const now = (): number => clock.t;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();
  const calls: string[] = [];
  const restarts: string[] = [];

  const readOnly = (name: string): ToolDefinition => ({
    ...INCIDENT_TOOLS[name]!,
    description: `Read ${name}.`,
    parameters: { type: "object", properties: { pod: { type: "string" } } },
    execute: (args) => {
      calls.push(`${name}:${String(args["pod"])}`);
      return { content: `${name} output for ${String(args["pod"])}` };
    },
  });
  tools.register(readOnly("k8s.describe"));
  tools.register(readOnly("k8s.logs"));
  tools.register(readOnly("obs.query"));

  tools.register({
    ...INCIDENT_TOOLS["k8s.restart"]!,
    description: "Restart a pod. Cannot be undone.",
    parameters: { type: "object", properties: { pod: { type: "string" } } },
    execute: (args) => {
      if (opts.restartThrows === true) throw new Error("the API server said no");
      restarts.push(String(args["pod"]));
      return { content: "restarted", writes: { action: [{ kind: "restart", pod: String(args["pod"]) }] } };
    },
  });
  tools.register({
    ...INCIDENT_TOOLS["k8s.rollback"]!,
    description: "Undo a restart.",
    parameters: { type: "object", properties: { pod: { type: "string" } } },
    execute: (args) => ({ content: "rolled back", writes: { action: [{ kind: "rollback", pod: String(args["pod"]) }] } }),
  });
  tools.register({
    ...INCIDENT_TOOLS["chat.post"]!,
    description: "Post to chat.",
    parameters: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" } } },
    execute: (args) => {
      calls.push(`chat.post:${String(args["channel"])}`);
      return { content: "posted", writes: { action: [{ kind: "notify", channel: String(args["channel"]) }] } };
    },
  });

  functions.register("function/extract-signals@stable", (view) => ({ writes: extractSignals(view.get("alert")) }));
  functions.register("function/quarantine-signal@stable", (view) => {
    const signal = view.get<{ pod?: string }>("signal");
    // A placeholder finding, so the join's count is unaffected and the verdict knows
    // its evidence is incomplete.
    return { writes: { findings: [{ pod: signal?.pod ?? "?", cause: "unreachable", confidence: 0, degraded: true }] } };
  });
  functions.register("function/assess-severity@stable", (view) => ({
    writes: { verdict: assessSeverity(view.get<Finding[]>("findings") ?? []) },
  }));
  functions.register("function/write-report@stable", (view) => ({
    writes: {
      report: {
        findings: (view.get<Finding[]>("findings") ?? []).length,
        actions: view.get<unknown[]>("action") ?? [],
        verdict: view.get("verdict"),
      },
    },
  }));

  models.register(new MockModelAdapter({ script: opts.script ?? investigator(opts), pricePerMTok: 1 }), true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now,
    resolver: resolver(),
    policy: { granted: INCIDENT_CAPABILITIES, budget: { runUsd: 2.0 } },
  });

  return { engine, store, tools, functions, calls, restarts, tick: (ms) => (clock.t += ms) };
}

async function run(r: Rig, alert: unknown = ALERT) {
  const runId = await r.engine.submit({ graph: compileTriage(), inputs: { alert } });
  return { runId, projection: await r.engine.advance(runId) };
}

const approve = (r: Rig, runId: RunId, gateId: string, key = "k") =>
  r.engine.resolveGate(runId, {
    gateId: gateId as never,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:oncall", via: "console" },
    idempotencyKey: key,
  });

// ── the high-severity path ───────────────────────────────────────────────────

test("HIGH SEVERITY: three pods investigated in parallel, then a gate before the restart", async () => {
  const r = rig();
  const { runId, projection } = await run(r);

  assert.equal(projection.status, "awaiting_gate");
  assert.equal(r.restarts.length, 0, "the restart has NOT happened — that is what the gate is for");
  assert.equal((projection.channels["findings"] as unknown[]).length, 3, "all three branches folded");
  assert.deepEqual(
    r.calls.filter((c) => c.startsWith("k8s.describe")).sort(),
    ["k8s.describe:api-7f", "k8s.describe:api-8a", "k8s.describe:worker-2b"],
  );

  const gate = Object.values(projection.gates).find((g) => g.state === "open")!;
  assert.equal(gate.nodeId, "remediate");

  const after = await approve(r, runId, gate.gateId);
  assert.equal(after.status, "succeeded");
  assert.deepEqual(r.restarts, ["api-7f"], "and only after approval");
  assert.deepEqual((after.channels["report"] as { actions: unknown[] }).actions, [{ kind: "restart", pod: "api-7f" }]);
});

test("findings fold in BRANCH order, not in the order the cluster answered", async () => {
  const r = rig();
  const { projection } = await run(r);
  const pods = (projection.channels["findings"] as Finding[]).map((f) => f.pod);
  assert.deepEqual(pods, ["api-7f", "api-8a", "worker-2b"]);
});

// ── the router ───────────────────────────────────────────────────────────────

test("LOW SEVERITY routes to notify, and the restart tool is never reached", async () => {
  const r = rig({ confidence: 0.4 });
  const { runId, projection } = await run(r);

  const gate = Object.values(projection.gates).find((g) => g.state === "open")!;
  assert.equal(gate.nodeId, "notify", "a chat post is externally visible, so it gates too");

  const after = await approve(r, runId, gate.gateId);
  assert.equal(after.status, "succeeded");
  assert.deepEqual(r.restarts, []);
  assert.ok(r.calls.includes("chat.post:#sre"));
});

test("an EMPTY verdict takes the fallback, not the low-severity arm", async () => {
  // The absence rule, load-bearing: `verdict.severity < 0.7` is false when the verdict
  // is absent, so without `has()` an alert with no pods would silently post to chat.
  const r = rig();
  const { runId, projection } = await run(r, { symptom: "quiet", pods: [] });

  const gate = Object.values(projection.gates).find((g) => g.state === "open")!;
  assert.equal(gate.nodeId, "escalate", "no evidence means a human decides, not a default");

  const after = await approve(r, runId, gate.gateId);
  assert.equal(after.status, "succeeded");
  assert.deepEqual(r.restarts, []);
  assert.deepEqual(r.calls, []);
});

// ── the error edge ───────────────────────────────────────────────────────────

test("ONE UNREACHABLE POD DOES NOT LOSE THE OTHER TWO", async () => {
  const r = rig({ failPod: "api-8a" });
  const { projection } = await run(r);

  const findings = projection.channels["findings"] as Finding[];
  assert.equal(findings.length, 3, "the failed branch still reaches the join, via quarantine");
  assert.equal(findings.find((f) => f.pod === "api-8a")?.degraded, true);

  const verdict = projection.channels["verdict"] as { severity: number; degraded: number };
  assert.equal(verdict.degraded, 1);
  assert.ok(verdict.severity < 0.9, "and the verdict is less confident for it");
});

test("a failed restart escalates to a human rather than failing the run", async () => {
  const r = rig({ restartThrows: true });
  const { runId, projection } = await run(r);

  const first = Object.values(projection.gates).find((g) => g.state === "open")!;
  assert.equal(first.nodeId, "remediate");
  const after = await approve(r, runId, first.gateId);

  // Approved, attempted, failed — and the error edge routed to the human gate.
  assert.equal(after.status, "awaiting_gate");
  const second = Object.values(after.gates).find((g) => g.state === "open")!;
  assert.equal(second.nodeId, "escalate", "a failed irreversible action is exactly when to ask");

  const done = await approve(r, runId, second.gateId, "k2");
  assert.equal(done.status, "succeeded");
});

test("REJECTING the remediation escalates to a human rather than dying", async () => {
  const r = rig();
  const { runId, projection } = await run(r);
  const gate = Object.values(projection.gates).find((g) => g.state === "open")!;

  const after = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "reject", reason: "we are mid-deploy" },
    actor: { kind: "human", subject: "u:oncall", via: "console" },
    idempotencyKey: "k",
  });

  // A rejection fails the Task, and the node's error edge routes that failure to the
  // escalation gate. The run does not die; it asks a person what to do instead.
  assert.equal(after.status, "awaiting_gate");
  assert.equal(Object.values(after.gates).find((g) => g.state === "open")?.nodeId, "escalate");
  assert.deepEqual(r.restarts, []);
});

// ── replay and trajectory ────────────────────────────────────────────────────

test("the whole run replays with ZERO model calls and zero side effects", async () => {
  const r = rig();
  const { runId, projection } = await run(r);
  const gate = Object.values(projection.gates).find((g) => g.state === "open")!;
  await approve(r, runId, gate.gateId);

  // A SECOND rig, with live tool bodies wired up. If replay touched any of them its
  // counters would move — which is the actual claim, stronger than passing empty
  // registries (an unknown tool merely fails, and a failure is not proof of hermeticity).
  const shadow = rig();
  const report = await replayRun({
    runId,
    store: r.store,
    graph: compileTriage(),
    engine: {
      tools: shadow.tools,
      functions: shadow.functions,
      // NO model adapter: a replay that reaches a provider is not a replay.
      models: new ModelRegistry(),
      now: () => 1_700_000_000_000,
      resolver: resolver(),
      policy: { granted: INCIDENT_CAPABILITIES },
    },
  });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match).slice(0, 3), null, 2));
  assert.equal(report.hermetic, true, "no unknown-outcome effect, so the replay is exact");
  assert.deepEqual(report.unservedEffects, [], "every recorded effect was consumed");
  assert.deepEqual(shadow.restarts, [], "the pod was NOT restarted a second time");
  assert.deepEqual(shadow.calls, [], "and no tool body ran at all — every result came from the journal");
});

test("the run folds to a trajectory carrying an S1 signal", async () => {
  const r = rig();
  const { runId, projection } = await run(r);
  const gate = Object.values(projection.gates).find((g) => g.state === "open")!;
  await approve(r, runId, gate.gateId);

  const events: JournalEvent[] = [];
  for await (const e of r.store.read(runId, 1)) events.push(e);
  const t = foldTrajectory(events, { graph: compileTriage() });

  assert.equal(t.cohort.workflow, "incident-triage");
  assert.equal(t.outcome.runStatus, "succeeded");
  assert.equal(t.outcome.assertions.length, 1, "the assertion evaluator is the ground truth");
  assert.equal(t.outcome.assertions[0]?.pass, true);
  assert.equal(t.outcome.humanDecisions[0]?.decision, "approve");

  // S1 (1.00) and S2 (0.90) both present and both positive.
  const signals = readSignals(t);
  assert.equal(outcomeOf(signals), 1);
  assert.equal(promotionCeiling(signals).channel, "stable");

  assert.equal(
    JSON.stringify(t).includes("api-7f"),
    false,
    "the pod name is production data; a trajectory keeps shapes and digests",
  );
});

test("a degraded run is scored DOWN by the ground-truth signal, not by a vibe", async () => {
  const r = rig({ failPod: "api-8a", confidence: 0.75 });
  const { runId, projection } = await run(r);
  const gate = Object.values(projection.gates).find((g) => g.state === "open");
  if (gate !== undefined) await approve(r, runId, gate.gateId);

  const events: JournalEvent[] = [];
  for await (const e of r.store.read(runId, 1)) events.push(e);
  const t = foldTrajectory(events, { graph: compileTriage() });

  assert.equal(t.outcome.assertions[0]?.pass, false, "0.75 average minus a 0.1 degradation penalty is below 0.7");
  assert.ok(outcomeOf(readSignals(t)) < 1);
});
