import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { digest } from "../../src/canonical.ts";
import { CODES } from "../../src/errors.ts";
import { runEvalSuite } from "../../src/evolution/gate.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent, NewEvent } from "../../src/journal/events.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type MockScript, type ToolDefinition } from "../../src/run/registry.ts";
import { ReplayEffects, replayRun } from "../../src/run/replay.ts";
import { conformsToGraph, reconstructGraph, shouldExport, spansFrom } from "../../src/telemetry/spans.ts";
import { DOCS, SKELETON_TENANT_CAPS, SKELETON_TOOLS, compileSkeleton, harness, resolver, skeletonSpec } from "./skeleton.ts";

// A DEPLOYMENT TOKEN KEY, because the two span assertions below read `pii` attributes and
// `redactAttributes` omits those entirely when none is configured — see `deploymentKey` in
// `security/redact.ts`. Setting it here is also the honest statement of what a trace with
// tokens in it REQUIRES: not a process, a deployment.
process.env["LOOM_PII_TOKEN_KEY"] = "9d".repeat(32);

async function eventsOf(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/** Run the skeleton to completion and hand back everything a replay needs. */
async function recorded(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  let p = await h.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k1",
    });
  }
  return { h, graph, runId, projection: p };
}

// ── replay ───────────────────────────────────────────────────────────────────

test("a recorded run replays to an identical projection", async () => {
  const { h, graph, runId } = await recorded();
  const before = h.writes.length;

  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));
  assert.deepEqual(report.replayed.channels, report.original.channels);
  assert.equal(report.replayed.status, "succeeded");
  assert.equal(h.writes.length, before, "REPLAY PERFORMED NO SIDE EFFECTS");
});

test("replay makes no model calls at all", async () => {
  const { h, graph, runId } = await recorded();
  const callsDuringRecording = h.model.seen.length;
  assert.ok(callsDuringRecording > 0);

  await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });

  assert.equal(h.model.seen.length, callsDuringRecording, "the adapter was never reached again");
});

test("replay reads no files — the tool body is never entered", async () => {
  const { h, graph, runId } = await recorded();
  const readsDuringRecording = [...h.reads];

  await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });

  assert.deepEqual(h.reads, readsDuringRecording, "no additional tool execution");
});

test("replay consumes every recorded effect — nothing left over", async () => {
  const { h, graph, runId } = await recorded();
  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });
  assert.deepEqual(report.unservedEffects, [], "an unserved effect means the graph changed");
  assert.equal(report.hermetic, true);
});

test("replay serves the recorded human decision rather than re-asking", async () => {
  const { h, graph, runId } = await recorded();
  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });
  // The replayed run reached the same terminal state, which it could only do by
  // applying the same approval.
  assert.equal(report.replayed.status, "succeeded");
  const gate = Object.values(report.replayed.gates)[0];
  assert.equal(gate?.state, "decided");
});

test("a rejected gate replays as a rejection", async () => {
  const h = harness();
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  const gated = await h.engine.advance(runId);
  const gate = Object.values(gated.gates).find((g) => g.state === "open")!;
  await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "reject", reason: "nope" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });

  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });
  assert.equal(report.match, true);
  assert.equal(report.replayed.status, "failed");
  assert.equal(h.writes.length, 0);
});

test("a missing effect is E_REPLAY_DIVERGENCE, never a silent live call", async () => {
  const { h, graph, runId } = await recorded();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  // Drop one recorded model turn: the exact shape of a journal that has been
  // truncated, sampled, or partially restored.
  const holed = events.filter((e) => !(e.type === "effect.completed" && String((e.payload as { key: string }).key).includes(":model:0")));
  const effects = ReplayEffects.fromEvents(holed);

  const shadow = new MemoryStateStore();
  const engine = new Engine({
    store: shadow,
    tools: h.engine.tools,
    functions: h.engine.functions,
    models: h.engine.models,
    replay: effects,
    policy: { granted: ["fs:read", "fs:write"] },
  });
  const replayRunId = await engine.submit({ graph, inputs: { paths: DOCS } });
  const p = await engine.advance(replayRunId);

  assert.equal(p.status, "failed");
  assert.match(JSON.stringify(p.error), /E_REPLAY_DIVERGENCE|not in the journal/);
});

test("an effect that started with no outcome makes replay non-hermetic", () => {
  const started: JournalEvent = {
    runId: "01JRUN" as RunId,
    seq: 1,
    ts: 1,
    type: "effect.started",
    payload: { key: "n@root#0:tool:0", kind: "tool", attempt: 1 },
    actor: { kind: "system", component: "t" },
    classification: "internal",
  } as JournalEvent;

  const effects = ReplayEffects.fromEvents([started]);
  assert.deepEqual(effects.unknownOutcomes, ["n@root#0:tool:0"]);
  assert.throws(
    () => effects.require("n@root#0:tool:0"),
    /started but never recorded an outcome/,
    "replay refuses to invent what the world did while the process was dying",
  );
});

test("replaying twice gives byte-identical results", async () => {
  const { h, graph, runId } = await recorded();
  const engine = { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } };
  const a = await replayRun({ store: h.store, runId, graph, engine });
  const b = await replayRun({ store: h.store, runId, graph, engine });
  assert.deepEqual(a.replayed.channels, b.replayed.channels);
  assert.deepEqual(
    Object.values(a.replayed.tasks).map((t) => [t.taskId, t.state]),
    Object.values(b.replayed.tasks).map((t) => [t.taskId, t.state]),
  );
});

test("replay of a partially-failed run reproduces the same failure", async () => {
  const { h, graph, runId } = await recorded({ failBranch: 2 });
  const report = await replayRun({
    store: h.store,
    runId,
    graph,
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });
  assert.equal(report.match, true);
  assert.equal((report.replayed.channels["digests"] as unknown[]).length, 4);
});

// ── spans ────────────────────────────────────────────────────────────────────

test("spans are derived from the journal and form one tree", async () => {
  const { h, runId } = await recorded();
  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));

  const roots = spans.filter((s) => s.parentSpanId === undefined);
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.name, "loom.run");

  const ids = new Set(spans.map((s) => s.spanId));
  for (const s of spans) {
    if (s.parentSpanId !== undefined) assert.ok(ids.has(s.parentSpanId), `orphan span ${s.name}`);
  }
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1, "one trace per run");
});

test("span count is O(nodes), because edges are attributes not spans", async () => {
  const { h, graph, runId } = await recorded();
  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));
  const taskSpans = spans.filter((s) => s.name === "loom.task");
  // 1 start + 5 summarize + collect + merge + approve + write = 10
  assert.equal(taskSpans.length, 10);
  assert.ok(spans.filter((s) => s.name === "loom.edge").length === 0, "no edge spans exist");
  assert.ok(graph.spec.edges.length > 0);
});

test("model spans carry gen_ai semantic-convention attributes", async () => {
  const { h, runId } = await recorded();
  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));
  const model = spans.find((s) => s.name === "loom.model");
  assert.ok(model);
  assert.equal(model.attributes["gen_ai.system"], "mock");
  assert.ok(typeof model.attributes["gen_ai.usage.input_tokens"] === "number");
  assert.ok(typeof model.attributes["loom.cost_usd"] === "number");
});

test("the gate span records THAT the approver saw something, and neither who they were nor what it was", async () => {
  // On a DRIVEN run, so the values under test are the ones the engine really journaled
  // rather than a fixture's. Both used to leave the process raw: an unkeyed 48-bit prefix
  // of the subject, and `digest(payload)` — a confirmation oracle for exactly the fields
  // `DeliverySpec.redact` hides from a channel. A trace collector is the same kind of
  // place as a channel, and usually somebody else's. See `test/telemetry/spans.test.ts`
  // for the inversions themselves.
  const { h, runId } = await recorded();
  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));
  const gate = spans.find((s) => s.name === "loom.gate");
  assert.ok(gate);
  assert.equal(gate.attributes["gate.decision"], "approve");
  assert.equal(gate.attributes["gate.approver_kind"], "human", "…by a person, which is the oversight fact and is not personal data");
  assert.match(String(gate.attributes["gate.content_digest"]), /^pii:[0-9a-f]{12}:string$/);
  assert.notEqual(gate.attributes["gate.approver"], "u:alice");
  assert.match(String(gate.attributes["gate.approver"]), /^pii:[0-9a-f]{12}:string$/);
  // The gate id stays in the clear, and that is the whole answer to "how does an audit get
  // the real values back": through the journal, inside the boundary, keyed by this.
  assert.match(String(gate.attributes["gate.id"]), /^g/);
});

test("THE CONFORMANCE ASSERTION — reconstruct(trace) ⊆ declared(graph)", async () => {
  const { h, graph, runId } = await recorded();
  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));
  const rebuilt = reconstructGraph(spans);
  const result = conformsToGraph(rebuilt, graph.spec, graph.graphHash);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.hashMatches, true);
  assert.deepEqual(result.unknownNodes, []);
  assert.deepEqual(result.unknownEdges, []);
  // And it really did reconstruct something: every node ran, and the fan-out shows
  // up as 5 instances of one node.
  assert.equal(rebuilt.nodes.length, graph.spec.nodes.length);
  assert.equal(rebuilt.instances.length, 10);
});

test("the conformance assertion FAILS if a trace claims an undeclared edge", async () => {
  const { h, graph, runId } = await recorded();
  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));
  const tampered = spans.map((s) =>
    s.name === "loom.task" ? { ...s, attributes: { ...s.attributes, "edges.taken": ["ghost-edge"] } } : s,
  );
  const result = conformsToGraph(reconstructGraph(tampered), graph.spec, graph.graphHash);
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknownEdges, ["ghost-edge"]);
});

test("an in-flight run still produces a readable trace", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  await h.engine.advance(runId); // stops at the gate

  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));
  const root = spans.find((s) => s.name === "loom.run");
  assert.ok(root);
  assert.equal(root.status, "unset", "unfinished, not errored");
  assert.ok(spans.some((s) => s.name === "loom.gate" && s.status === "unset"), "the open gate is visible");
});

test("spans are deterministic: the same journal yields identical spans", async () => {
  // WITHIN ONE PROCESS, which is all this test can see and is the half that let a
  // `randomBytes(32)` key sit under a file documented as a pure function of the journal for
  // a whole wave: a per-process key satisfies this assertion exactly. The claim that
  // actually matters — two PROCESSES, one journal, one deployment key, identical bytes — is
  // in `test/telemetry/spans.test.ts` under "A TRACE IS A PURE FUNCTION OF THE JOURNAL AND
  // THE DEPLOYMENT KEY", and it spawns a child to observe it. This one stays because it is
  // the cheap regression guard over a real driven run rather than a fixture.
  const { h, runId } = await recorded();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  assert.equal(JSON.stringify(spansFrom(events)), JSON.stringify(spansFrom(events)));
});

test("A REPLAY DOES NOT TOUCH THE JOURNAL IT REPLAYS, so the original's trace is unchanged", async () => {
  // This is what the test named "A REPLAY'S TRACE MATCHES THE ORIGINAL RUN'S, because both
  // are folds of the same journal" was ACTUALLY asserting, and it is worth keeping under a
  // name that says so: `replayRun` builds a shadow `MemoryStateStore`, so both sides of its
  // comparison were the same journal read twice. The property its old name claimed is
  // impossible by construction — the replay is a different run with a different `runId` —
  // so it passed vacuously, on a determinism claim, which is precisely why nobody noticed
  // the trace had stopped being a pure function of the journal. What replay determinism DOES
  // guarantee is asserted in the test below this one.
  const { h, runId } = await recorded();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  await replayRun({
    store: h.store,
    runId,
    graph: compileSkeleton(),
    engine: { tools: h.engine.tools, functions: h.engine.functions, models: h.engine.models, policy: { granted: ["fs:read", "fs:write"] } },
  });
  const after = await eventsOf(h.store as MemoryStateStore, runId);
  assert.equal(after.length, events.length, "a replay appended to the journal it was reading");
  assert.equal(JSON.stringify(spansFrom(after)), JSON.stringify(spansFrom(events)));
});

test("A REPLAY'S TRACE IS A DIFFERENT TRACE, and what it must agree with the original about is the GRAPH", async () => {
  // Driven by hand rather than through `replayRun`, because `replayRun` keeps its shadow
  // journal to itself — which is the mechanical reason no test could ever have asserted the
  // claim the old one was named for.
  //
  // THREE THINGS DIFFER AND THEY ALL SHOULD. `traceId` and every `spanId` are `digestOf` the
  // run id, and a replay is a different run; every `pii` token is scoped to the run id, for
  // the cross-run oracle reason `tokenKey` states; and the approver is the replay component,
  // not the human — a replay is not a second approval and must never read as one.
  //
  // WHAT AGREES IS THE ANSWER TO "DID IT EXECUTE THE SAME GRAPH?", which is the whole of
  // what a deterministic replay claims: the same node instances, the same edges, the same
  // graph hash, and the same shape of trace.
  const { h, graph, runId } = await recorded();
  const original = await eventsOf(h.store as MemoryStateStore, runId);

  const shadow = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const engine = new Engine({
    store: shadow,
    tools: h.engine.tools,
    functions: h.engine.functions,
    models: h.engine.models,
    replay: ReplayEffects.fromEvents(original),
    policy: { granted: ["fs:read", "fs:write"] },
  });
  const replayRunId = await engine.submit({ graph, inputs: { paths: DOCS } });
  let rp = await engine.advance(replayRunId);
  for (let guard = 0; guard < 4 && rp.status === "awaiting_gate"; guard++) {
    const open = Object.values(rp.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    rp = await engine.resolveGate(replayRunId, {
      gateId: open.gateId,
      decision: { kind: "approve" },
      actor: { kind: "system", component: "replay" },
      idempotencyKey: `replay:${open.gateId}`,
    });
  }
  assert.equal(rp.status, "succeeded", "the replay has to have run at all for anything below to mean something");

  const a = spansFrom(original);
  const b = spansFrom(await eventsOf(shadow, replayRunId));

  // Not byte-identical, and the assertion is here rather than left implicit so that nobody
  // "fixes" this test by asserting equality and re-derives the run scope out of `close`.
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(a[0]!.traceId, b[0]!.traceId, "two runs are two traces");

  const tally = (spans: readonly { name: string }[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const s of spans) out[s.name] = (out[s.name] ?? 0) + 1;
    return out;
  };
  assert.equal(b.length, a.length, "the replay produced a different number of spans");
  assert.deepEqual(tally(b), tally(a), "…or a different shape of trace");

  const ra = reconstructGraph(a);
  const rb = reconstructGraph(b);
  assert.deepEqual(rb.nodes, ra.nodes);
  assert.deepEqual(rb.edges, ra.edges);
  assert.deepEqual(rb.instances, ra.instances, "TaskIds are DERIVED, so they survive a change of run id");
  assert.equal(rb.graphHash, ra.graphHash);
  assert.deepEqual(conformsToGraph(rb, graph.spec, graph.graphHash), {
    ok: true,
    unknownNodes: [],
    unknownEdges: [],
    hashMatches: true,
    unreadableSpans: [],
  });

  // The gate is the one place the two traces disagree about a FACT rather than about an id,
  // and it is the right disagreement: a human approved the original, the replay served that
  // decision, and the trace says so.
  const gateA = a.find((s) => s.name === "loom.gate")!;
  const gateB = b.find((s) => s.name === "loom.gate")!;
  assert.equal(gateA.attributes["gate.approver_kind"], "human");
  assert.equal(gateB.attributes["gate.approver_kind"], "system");
  assert.equal("gate.approver" in gateB.attributes, false, "a replay must not read as a second approval by that person");

  // And the same question, asked twice, tokenises into two incomparable values — the run
  // scope doing exactly its job. The journal keeps them equal, which is where the comparison
  // belongs and is why nothing was lost.
  const digestIn = (events: readonly JournalEvent[]): unknown =>
    events.find((e) => e.type === "gate.raised")?.payload?.["contentDigest" as never];
  assert.equal(digestIn(await eventsOf(shadow, replayRunId)), digestIn(original), "the replayed gate asked a different question");
  assert.notEqual(gateB.attributes["gate.content_digest"], gateA.attributes["gate.content_digest"]);
});

// ── sampling ─────────────────────────────────────────────────────────────────

test("sampling never drops a run that gated, failed, or acted irreversibly", async () => {
  const { h, runId } = await recorded();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  assert.equal(shouldExport(events, { headRatio: 0 }), true, "a gated run is always kept");
});

test("sampling is deterministic per run, never random", async () => {
  const { h, runId } = await recorded();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  const policy = { headRatio: 0.5, alwaysKeep: false };
  const first = shouldExport(events, policy);
  for (let i = 0; i < 5; i++) assert.equal(shouldExport(events, policy), first);
});

test("sampling only affects export — the journal is untouched", async () => {
  const { h, runId } = await recorded();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  shouldExport(events, { headRatio: 0, alwaysKeep: false });
  assert.equal((await eventsOf(h.store as MemoryStateStore, runId)).length, events.length);
});

test("the bus is unused by span derivation — telemetry needs no live hook", async () => {
  const store = new MemoryStateStore();
  const bus = new InProcessEventBus({ store });
  assert.equal(bus.subscriberCount, 0);
  const { h, runId } = await recorded();
  // Spans come from a journal read, so a run recorded before any tracer existed
  // still produces a full trace.
  assert.ok(spansFrom(await eventsOf(h.store as MemoryStateStore, runId)).length > 0);
});

// ── a gate inside a loop: the coordinate that distinguishes two answers ───────

/**
 * One `human_gate` node, two ITERATIONS, two different human answers.
 *
 * `nodeId` is not a coordinate that separates them and `TaskId` is
 * (`nodeId@branchPath#iteration`), which is the whole of register entry A6: the replay
 * harness matched a recorded decision on `nodeId` alone and served the first one it found
 * to every iteration.
 */
function loopedGateSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gate-in-a-loop", project: "replay", version: 1 },
    policy: { posture: "out", capabilities: [], expansion: { maxNodes: 32, maxDepth: 1, maxFanout: 2, maxLoopIterations: 4 } },
    channels: { n: { type: "number", reduce: "replace", initial: 0 }, done: { type: "number", reduce: "replace" } },
    inputs: ["n"],
    outputs: ["done"],
    nodes: [
      { id: "start" as NodeId, type: "function", reads: ["n"], writes: ["done"], function: { ref: "function/seed@stable" } },
      { id: "gate" as NodeId, type: "human_gate", reads: ["n"], humanGate: { ref: "oversight/loop@stable" } },
      { id: "work" as NodeId, type: "function", reads: ["n"], writes: ["n"], function: { ref: "function/bump@stable" } },
    ],
    edges: [
      { id: "e0" as EdgeId, from: "start" as NodeId, to: "gate" as NodeId, kind: "seq" },
      { id: "e1" as EdgeId, from: "gate" as NodeId, to: "work" as NodeId, kind: "seq" },
      { id: "e2" as EdgeId, from: "work" as NodeId, to: "gate" as NodeId, kind: "loop", until: "n >= 2", maxIterations: 2 },
    ],
  };
}

function loopRig(): { engine: Engine; store: MemoryStateStore; graph: ReturnType<typeof compileOrThrow> } {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const functions = new FunctionRegistry();
  functions.register("function/seed@stable", () => ({ writes: { done: 1 } }));
  functions.register("function/bump@stable", (view) => ({ writes: { n: (view.get<number>("n") ?? 0) + 1 } }));
  const graph = compileOrThrow({ spec: loopedGateSpec(), resolver: resolver(), tools: {}, tenantCapabilities: [] });
  const engine = new Engine({ store, functions, now: () => 1_700_000_000_000, policy: { granted: ["*"] } });
  return { engine, store, graph };
}

test("A GATE INSIDE A LOOP IS REPLAYED PER ITERATION, not per node", async () => {
  // The recorded run: the human APPROVES iteration 0 and REJECTS iteration 1, so it fails.
  const live = loopRig();
  const runId = await live.engine.submit({ graph: live.graph, inputs: { n: 0 } });
  let p = await live.engine.advance(runId);

  const answers = [
    { kind: "approve" } as const,
    { kind: "reject", reason: "not a second time" } as const,
  ];
  const askedOf: string[] = [];
  for (let i = 0; i < answers.length && p.status === "awaiting_gate"; i++) {
    const open = Object.values(p.gates).filter((g) => g.state === "open").sort((a, b) => a.raisedAtSeq - b.raisedAtSeq)[0]!;
    askedOf.push(open.taskId);
    p = await live.engine.resolveGate(runId, {
      gateId: open.gateId,
      decision: answers[i]!,
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: `k${i}`,
    });
  }

  assert.deepEqual(askedOf, ["gate@root#0", "gate@root#1"], "the loop asked the same node twice, as two Tasks");
  assert.equal(p.status, "failed", "the second answer was a rejection, so the run failed");

  // The replay must reach the SAME end. Before the fix it matched the recorded decision on
  // `nodeId` alone, served iteration 0's `approve` to both gates, and the replayed run
  // SUCCEEDED — a rejection a human actually made, replayed as an approval, with `compare`
  // reporting the divergence against task states and channels rather than against the
  // harness that caused it.
  const shadow = loopRig();
  const report = await replayRun({
    store: live.store,
    runId,
    graph: live.graph,
    engine: { functions: shadow.engine.functions, policy: { granted: ["*"] } },
  });

  assert.equal(report.replayed.status, "failed", "REPLAY SERVED THE APPROVAL TWICE AND THE REJECTION NEVER");
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));

  // WHAT THIS TEST HOLDS IS THE FIX, NOT EACH OF ITS PARTS, and the mutation sweep says so
  // rather than the docstring claiming otherwise. `firstUnservedDecision` discriminates two
  // ways — by `taskId`, and by `served` — and either alone is enough here, so reverting
  // ONE leaves this green while reverting both turns it red. They are kept as a pair on the
  // same argument the file already makes for `decided`/`decisionOf`: `taskId` is the
  // coordinate that is CORRECT, and `served` is what stops one decision being spent twice
  // if a single Task ever gates more than once. The `oldestOpen` pick is a third
  // redundancy — this run never has two gates open at once, so no fixture can distinguish
  // it from `find`, and it is here because "the first one the map yields" is not an order
  // anything states.

  const decisions = Object.values(report.replayed.gates)
    .sort((a, b) => a.raisedAtSeq - b.raisedAtSeq)
    .map((g) => `${g.taskId}:${g.decision}`);
  assert.deepEqual(decisions, ["gate@root#0:approve", "gate@root#1:reject"], "each iteration got its own answer back");
});

// ── what a recorded result is bound to ───────────────────────────────────────
//
// Invariant 4 says replay serves recorded results. It does not say "serves them to
// whatever asks". These tests hold the two bindings that make the difference: the
// GRAPH the results came out of, and the CALL each individual result answered.

const REPLAY_ENGINE = (h: ReturnType<typeof harness>) => ({
  tools: h.engine.tools,
  functions: h.engine.functions,
  models: h.engine.models,
  policy: { granted: ["fs:read", "fs:write"] },
});

/**
 * The skeleton with ONE tool argument VALUE changed — a graph that writes somewhere else.
 *
 * Chosen because it is the hardest case for everything except the graph hash: same nodes,
 * same edges, same effect keys, same argument SHAPE, same recorded results. Nothing about
 * the run observably differs, which is exactly why the recorded run's identity has to be
 * carried by something other than the shape of what it did.
 */
function writesElsewhere(): RunGraph {
  const base = skeletonSpec();
  return compileSkeleton(
    skeletonSpec({
      nodes: base.nodes.map((x) =>
        x.id === ("write" as NodeId)
          ? { ...x, tool: { name: "fs.write", version: "1.0", args: { path: "out/OWNED.md", body: "${merged.markdown}" } } }
          : x,
      ),
    }),
  );
}

test("A MODIFIED GRAPH DOES NOT REPLAY GREEN — the recorded results belong to one graph", async () => {
  const { h, graph, runId } = await recorded();
  const tampered = writesElsewhere();
  assert.notEqual(tampered.graphHash, graph.graphHash, "the fixture has to actually be a different graph");

  const report = await replayRun({ store: h.store, runId, graph: tampered, engine: REPLAY_ENGINE(h) });

  // Everything that used to be the whole verdict still says "fine": every recorded effect
  // was consumed, every outcome was known, and every task and channel matched.
  assert.deepEqual(report.unservedEffects, [], "the changed graph consumed the same effect keys");
  assert.equal(report.hermetic, true);

  assert.equal(report.match, false, "a replay against a graph that did not produce these results is a divergence");
  assert.equal(report.graph.recorded, graph.graphHash);
  assert.equal(report.graph.replayed, tampered.graphHash);
  assert.equal(report.graph.match, false);

  const frame = report.frames.find((f) => f.kind === "graph.bound");
  assert.ok(frame, "the divergence is a frame, so `loom replay` prints it and exits non-zero");
  assert.equal(frame.expected, graph.graphHash);
  assert.equal(frame.actual, tampered.graphHash);
});

test("the same graph still binds, so the check is not vacuous", async () => {
  const { h, graph, runId } = await recorded();
  const report = await replayRun({ store: h.store, runId, graph, engine: REPLAY_ENGINE(h) });
  assert.equal(report.graph.match, true);
  assert.equal(report.graph.recorded, graph.graphHash);
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));
});

test("`onGraphChange: \"throw\"` refuses to serve anything at all", async () => {
  const { h, graph, runId } = await recorded();
  const before = h.writes.length;

  await assert.rejects(
    () => replayRun({ store: h.store, runId, graph: writesElsewhere(), engine: REPLAY_ENGINE(h), onGraphChange: "throw" }),
    (e: unknown): true => {
      const le = e as { code?: string; details?: { recorded?: string } };
      assert.equal(le.code, CODES.E_REPLAY_DIVERGENCE);
      assert.equal(le.details?.recorded, graph.graphHash, "the error names the graph the journal belongs to");
      return true;
    },
  );
  assert.equal(h.writes.length, before);
});

test("`onGraphChange: \"allow\"` is the named opt-out the eval gate needs", async () => {
  const { h, graph, runId } = await recorded();
  const tampered = writesElsewhere();

  const report = await replayRun({ store: h.store, runId, graph: tampered, engine: REPLAY_ENGINE(h), onGraphChange: "allow" });

  assert.equal(report.match, true, "opting out is what lets a candidate be judged on its own expectations");
  // The FACT is still reported. Opting out changes the verdict, never the record.
  assert.equal(report.graph.match, false);
  assert.equal(report.graph.recorded, graph.graphHash);
  assert.equal(report.frames.some((f) => f.kind === "graph.bound"), false, "…and no frame, so `match` is clean");
});

test("THE EVAL GATE STILL REPLAYS A CANDIDATE GRAPH — the check did not make `runEvalSuite` unreachable", async () => {
  // `runEvalSuite`'s entire job is replaying a recording against a DIFFERENT graph, and it
  // calls `replayRun` with no opt-out. This is the test that says the default check left
  // that call site working: a candidate still gets judged on the case's `expect` block.
  const { h, runId } = await recorded();

  const report = await runEvalSuite({
    store: h.store,
    suite: {
      name: "s",
      version: 1,
      frozen: true,
      frozenAt: 1_000,
      cases: [{ id: "a", runId, mustPass: true, expect: { status: "succeeded" } }],
    },
    graph: writesElsewhere(),
    engine: REPLAY_ENGINE(h),
  });

  assert.equal(report.passed, 1, JSON.stringify(report.cases[0]?.reasons));
  assert.equal(report.cases[0]?.replay.graph.match, false, "…and the gate can see that the graph changed");
});

// ── the CALL a recorded result answered ──────────────────────────────────────

const FS_APPEND = {
  name: "fs.append",
  version: "1.0",
  capabilities: ["fs:write"],
  irreversibility: "reversible_write" as const,
  idempotent: false,
};

/**
 * A candidate that calls a DIFFERENT TOOL at the same effect key.
 *
 * Effect keys are `taskId:kind:ordinal` and carry no fact about the call itself, so
 * `write@root#0:tool:0` names the same slot whichever tool the node points at. The
 * recorded `fs.write` result is therefore served to an `fs.append` call, and the graph
 * hash is the only thing that used to notice — which is no help to the one caller that
 * legitimately replays against a different graph.
 */
function appendsInstead(): RunGraph {
  const base = skeletonSpec();
  return compileOrThrow({
    spec: skeletonSpec({
      nodes: base.nodes.map((x) =>
        x.id === ("write" as NodeId)
          ? { ...x, tool: { name: "fs.append", version: "1.0", args: { path: "out/summary.md", body: "${merged.markdown}" } } }
          : x,
      ),
    }),
    resolver: resolver(),
    tools: { ...SKELETON_TOOLS, "fs.append": FS_APPEND },
    tenantCapabilities: SKELETON_TENANT_CAPS,
  });
}

test("A RECORDED RESULT IS NOT SILENTLY SERVED TO A DIFFERENT CALL", async () => {
  const { h, runId } = await recorded();
  h.tools.register({
    ...FS_APPEND,
    description: "Append to a file.",
    parameters: { type: "object", properties: { path: { type: "string" }, body: { type: "string" } }, required: ["path", "body"] },
    execute: () => {
      throw new Error("a tool body ran during a replay");
    },
  });

  // Opted out of the graph-hash check ON PURPOSE: this is the case the audit called the
  // load-bearing half — the one that still works when the hash legitimately changed.
  const report = await replayRun({ store: h.store, runId, graph: appendsInstead(), engine: REPLAY_ENGINE(h), onGraphChange: "allow" });

  assert.deepEqual(report.unservedEffects, [], "the same keys were consumed, which is the whole problem");
  assert.equal(report.match, false, "serving one call's result to another call is a divergence");
  assert.ok(report.frames.some((f) => f.kind === "effect.rebound" && !f.match));
  assert.deepEqual(
    report.reboundEffects.map((r) => [r.key, r.recorded, r.replayed]),
    [["write@root#0:tool:0", "fs.write@1.0({body:string,path:string})", "fs.append@1.0({body:string,path:string})"]],
  );
});

test("an unchanged run rebinds nothing", async () => {
  const { h, graph, runId } = await recorded();
  const report = await replayRun({ store: h.store, runId, graph, engine: REPLAY_ENGINE(h) });
  assert.deepEqual(report.reboundEffects, []);
});

// ── a recorded effect the replay never asked for ─────────────────────────────
//
// `unservedEffects` was reported BESIDE `match` and excluded FROM it, so a replay could
// certify a recording two of whose results it never consumed. Two shapes reproduce it,
// and neither is visible to `compare`: an agent's tool result reaches the transcript
// only, and the model turn that would have reacted to it is itself served from the
// journal — so a tool result that is never fetched cannot move a channel.

/** Two `fs.read` calls in ONE model turn, so the journal carries `:tool:0` AND `:tool:1`. */
const TWO_CALL_SCRIPT: MockScript = (req, turn) => {
  const parsed = JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { path?: string } };
  const path = parsed.state?.path ?? "unknown";
  if (turn % 2 === 0) {
    return {
      toolCalls: [
        { id: `c${turn}a`, name: "fs.read", arguments: { path } },
        { id: `c${turn}b`, name: "fs.read", arguments: { path: `OTHER-${path}` } },
      ],
      finishReason: "tool_use",
    };
  }
  return { text: JSON.stringify({ path, summary: `summary of ${path}` }), finishReason: "stop" };
};

const ONE_DOC = ["doc-0.md"];
const TOOL_0 = "summarize@root/e0[0]#0:tool:0";
const TOOL_1 = "summarize@root/e0[0]#0:tool:1";
const MODEL_0 = "summarize@root/e0[0]#0:model:0";

/** One document, an agent that calls its tool twice in the first turn, gate approved. */
async function recordedTwoCall(): Promise<{ h: ReturnType<typeof harness>; graph: RunGraph; runId: RunId }> {
  const h = harness({ script: TWO_CALL_SCRIPT });
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: ONE_DOC } });
  let p = await h.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await h.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k1",
    });
  }
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  return { h, graph, runId };
}

/**
 * The same journal, under the same runId, with one event rewritten.
 *
 * Rebuilt through `append` rather than mutated in place, so every row goes through
 * `canonicalize` exactly as the engine's own writes did and the copy is a journal a
 * store would accept — seqs contiguous from 1, ts and actor and taskId preserved.
 */
async function rebuiltJournal(
  events: readonly JournalEvent[],
  runId: RunId,
  edit: (e: JournalEvent) => JournalEvent,
): Promise<MemoryStateStore> {
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  let seq = 0;
  for (const original of events) {
    const e = edit(original);
    await store.append({
      runId,
      expectedSeq: seq,
      events: [
        {
          type: e.type,
          payload: e.payload,
          actor: e.actor,
          ts: e.ts,
          classification: e.classification,
          ...(e.taskId === undefined ? {} : { taskId: e.taskId }),
        } as NewEvent,
      ],
    });
    seq += 1;
  }
  return store;
}

test("A REPLAY THAT NEVER SERVED A RECORDED EFFECT DOES NOT REPORT `match: true`", async () => {
  // THE NAMED REPRO, reconstructed. The original is a journal written by HEAD (two tool
  // calls in one turn → `:tool:0` and `:tool:1`) replayed by code that only ever asks for
  // `:tool:0`; that code is a reverted `engine.ts` this test cannot run. What it CAN build
  // is the state that distinguishes the two — a well-formed journal carrying a recorded
  // `:tool:1` that this replay never requests — by serving a model turn that asks for one
  // call while both results stay recorded. The digest is recomputed, so the journal is
  // self-consistent and the digest check below is not what fires here.
  const { h, graph, runId } = await recordedTwoCall();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  assert.deepEqual(
    events.filter((e) => e.type === "effect.completed").map((e) => (e.payload as { key: string }).key),
    [
      // The seed for `start`'s function body — every `function` and `evaluator{assertion}` node
      // journals one, so `Math.random()` inside a body is served on replay instead of diverging.
      // Listed rather than filtered out: this assertion is the fixture's inventory, and an
      // inventory that quietly skips a kind stops noticing when a kind appears.
      "start@root#0:random:0",
      MODEL_0,
      TOOL_0,
      TOOL_1,
      "summarize@root/e0[0]#0:model:1",
      "merge@root#0:random:0",
      "write@root#0:tool:0",
    ],
    "the recording really did make two tool calls in one turn",
  );

  const store = await rebuiltJournal(events, runId, (e) => {
    if (e.type !== "effect.completed" || (e.payload as { key: string }).key !== MODEL_0) return e;
    const p = e.payload as { key: string; result: { toolCalls?: unknown[] }; resultDigest: string };
    const result = { ...p.result, toolCalls: (p.result.toolCalls ?? []).slice(0, 1) };
    return { ...e, payload: { key: p.key, result, resultDigest: digest(result) } } as JournalEvent;
  });

  const report = await replayRun({ store, runId, graph, engine: REPLAY_ENGINE(h) });

  // Everything the verdict used to be built from says "fine": same tasks, same channels,
  // same status, same graph, nothing rebound.
  assert.deepEqual(report.replayed.channels, report.original.channels);
  assert.equal(report.replayed.status, "succeeded");
  assert.equal(report.graph.match, true);
  assert.deepEqual(report.reboundEffects, []);
  assert.equal(
    report.frames.filter((f) => f.kind !== "effect.unserved").every((f) => f.match),
    true,
    "the divergence is invisible to `compare`, which is what made it silent",
  );

  // And the fact that says otherwise, which used to be reported beside the verdict.
  assert.deepEqual(report.unservedEffects, [TOOL_1]);
  assert.equal(report.match, false, "a replay that never served a recorded effect did not reproduce the recording");
  const frame = report.frames.find((f) => f.kind === "effect.unserved");
  assert.ok(frame, "the divergence is a frame, so `loom replay` prints it and exits non-zero");
  assert.equal(frame.expected, TOOL_1);
  assert.equal(frame.actual, "(never requested)");
});

/**
 * The skeleton with the `write` TOOL node replaced by a function that writes the same
 * value — a candidate graph that reaches the same end without making the recorded call.
 *
 * The second shape, and the one with no journal edit anywhere in it: the engine drives it
 * end to end. `write@root#0:tool:0` is simply never requested.
 */
function computesInsteadOfWriting(h: ReturnType<typeof harness>): RunGraph {
  h.functions.register("function/write-instead@stable", (view) => ({
    writes: { written: { path: "out/summary.md", body: (view.get<{ markdown?: string }>("merged") ?? {}).markdown ?? "" } },
  }));
  const base = skeletonSpec();
  return compileSkeleton(
    skeletonSpec({
      nodes: base.nodes.map((x) =>
        x.id === ("write" as NodeId)
          ? { id: x.id, type: "function", reads: ["merged"], writes: ["written"], function: { ref: "function/write-instead@stable" } }
          : x,
      ),
    }),
  );
}

test("A CANDIDATE THAT SKIPS A RECORDED CALL IS NOT `match: true` UNDER `\"allow\"`", async () => {
  const { h, graph, runId } = await recorded();
  const candidate = computesInsteadOfWriting(h);
  assert.notEqual(candidate.graphHash, graph.graphHash);

  // Opted out of the graph-hash check on purpose: that is the mode `runEvalSuite` exists
  // for, and it is where the unserved effect is the ONLY thing left that can notice.
  const report = await replayRun({ store: h.store, runId, graph: candidate, engine: REPLAY_ENGINE(h), onGraphChange: "allow" });

  assert.deepEqual(report.replayed.channels, report.original.channels, "the candidate reached the same state");
  assert.equal(report.replayed.status, "succeeded");
  assert.deepEqual(report.unservedEffects, ["write@root#0:tool:0"]);
  assert.equal(report.match, false, "the recorded fs.write result was never consumed by anything");
  assert.equal(h.writes.length, 1, "…and the replay still performed no side effect of its own");
});

test("consuming every recorded effect is what keeps the check non-vacuous", async () => {
  const { h, graph, runId } = await recorded();
  const report = await replayRun({ store: h.store, runId, graph, engine: REPLAY_ENGINE(h) });
  assert.deepEqual(report.unservedEffects, []);
  assert.equal(report.frames.some((f) => f.kind === "effect.unserved"), false);
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));
});

// ── the digest of a served result ────────────────────────────────────────────

test("A RECORDED RESULT THAT NO LONGER MATCHES ITS OWN DIGEST IS NOT SERVED", async () => {
  // `effect.completed.resultDigest` was written at four sites and read by none: a durable
  // field whose name asserted a property nothing checked. What it can check is exactly one
  // thing — that the `result` in the journal is the `result` the engine hashed when it
  // recorded it. Here a tool result is rewritten and the digest is left alone, which is
  // what a hand-edited, corrupted, or substituted journal looks like from inside a replay.
  const { h, graph, runId } = await recordedTwoCall();
  const events = await eventsOf(h.store as MemoryStateStore, runId);

  const store = await rebuiltJournal(events, runId, (e) => {
    if (e.type !== "effect.completed" || (e.payload as { key: string }).key !== TOOL_0) return e;
    const p = e.payload as { key: string; result: { content?: string }; resultDigest: string };
    // The digest is deliberately NOT recomputed. That is the whole point.
    return { ...e, payload: { ...p, result: { ...p.result, content: "contents of ATTACKER.md" } } } as JournalEvent;
  });

  const report = await replayRun({ store, runId, graph, engine: REPLAY_ENGINE(h) });

  // The refusal lands where every other `E_REPLAY_DIVERGENCE` lands — the task that asked
  // for the result fails, so the replayed run fails and the verdict is `false`. That is
  // the same shape as "effect is not in the journal" (see the test above), and it is what
  // makes the edit visible: without the check this journal replays to the recorded
  // channels, the recorded status, and `match: true`.
  assert.equal(report.match, false);
  assert.equal(report.replayed.status, "failed");
  const failure = JSON.stringify(report.replayed.error ?? {});
  assert.match(failure, new RegExp(CODES.E_REPLAY_DIVERGENCE));
  assert.match(failure, /no longer hashes to its recorded digest/);
  assert.ok(failure.includes(TOOL_0), "the error names the effect whose result no longer hashes to its digest");
});

test("an untouched journal serves every result, so the digest check is not vacuous", async () => {
  const { h, graph, runId } = await recordedTwoCall();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  const store = await rebuiltJournal(events, runId, (e) => e);
  const report = await replayRun({ store, runId, graph, engine: REPLAY_ENGINE(h) });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));
});

// ── the one write site whose digest is not a digest of its result ────────────

const PAY_TOOLS: Record<string, ToolManifestLite> = {
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay"], irreversibility: "irreversible", idempotent: false },
};

function doublingChild(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "double", project: "sub", version: 1 },
    policy: { posture: "out", capabilities: ["pay"] },
    channels: {
      amount: { type: "number", reduce: "replace" },
      doubled: { type: "number", reduce: "replace" },
    },
    inputs: ["amount"],
    outputs: ["doubled"],
    nodes: [
      { id: "double" as NodeId, type: "function", reads: ["amount"], writes: ["doubled"], function: { ref: "function/double@stable" } },
    ],
    edges: [],
  };
}

function delegatingParent(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "sub", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 }, capabilities: ["pay"] },
    channels: { total: { type: "number", reduce: "replace" }, result: { type: "object", reduce: "replace" } },
    inputs: ["total"],
    outputs: ["result"],
    nodes: [
      {
        id: "delegate" as NodeId,
        type: "subgraph",
        reads: ["total"],
        writes: ["result"],
        subgraph: { ref: "graph/double@stable", inputs: { amount: "total" }, outputs: { result: "doubled" }, budgetShare: 0.5 },
      },
    ],
    edges: [],
  };
}

function subgraphResolver(child: GraphSpec): ResourceResolver {
  return {
    resolve: (ref) => (/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref) ? { ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" } : undefined),
    subgraph: (ref) => (ref === "graph/double@stable" ? child : undefined),
  };
}

function subgraphRig(child: GraphSpec): { engine: Engine; store: MemoryStateStore; tools: ToolRegistry; functions: FunctionRegistry } {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const charge: ToolDefinition = {
    ...PAY_TOOLS["pay.charge"]!,
    description: "Take money.",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
    execute: () => ({ content: "charged" }),
  };
  tools.register(charge);
  functions.register("function/double@stable", (view) => ({ writes: { doubled: (view.get<number>("amount") ?? 0) * 2 } }));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models: new ModelRegistry(),
    now,
    resolver: subgraphResolver(child),
    policy: { granted: ["pay"] },
  });
  return { engine, store, tools, functions };
}

test("THE SUBGRAPH SITE STILL DOES NOT DIGEST ITS RESULT — this is what the exemption is for", async () => {
  // A RE-DERIVED PREDICATE, not a prose reason. `engine.ts:2191` writes
  // `result: {writes}` with `resultDigest: digest(writes)`, so the recorded digest is a
  // digest of a SUB-OBJECT of the result and a strict comparison would refuse every
  // subgraph replay. When that line is fixed this test fails, and the failure is the
  // instruction: delete `DIGEST_NOT_OVER_RESULT` from `run/replay.ts`.
  const child = doublingChild();
  const r = subgraphRig(child);
  const graph = compileOrThrow({ spec: delegatingParent(), resolver: subgraphResolver(child), tools: PAY_TOOLS, tenantCapabilities: ["pay"] });
  const runId = await r.engine.submit({ graph, inputs: { total: 4 } });
  const p = await r.engine.advance(runId);
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  const completed = (await eventsOf(r.store, runId)).filter(
    (e) => e.type === "effect.completed" && (e.payload as { key: string }).key.includes(":subgraph:"),
  );
  assert.equal(completed.length, 1);
  const payload = completed[0]!.payload as { key: string; result: unknown; resultDigest: string };
  assert.notEqual(
    digest(payload.result),
    payload.resultDigest,
    "engine.ts:2191 now digests its result — delete DIGEST_NOT_OVER_RESULT in run/replay.ts",
  );

  // And with the exemption, a subgraph run still replays rather than being refused by a
  // check aimed at journal edits.
  const shadow = subgraphRig(child);
  const report = await replayRun({
    store: r.store,
    runId,
    graph,
    engine: {
      tools: shadow.tools,
      functions: new FunctionRegistry(),
      models: new ModelRegistry(),
      now: () => 1_700_000_000_000,
      resolver: subgraphResolver(child),
      policy: { granted: ["pay"] },
    },
  });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match), null, 1));
});
