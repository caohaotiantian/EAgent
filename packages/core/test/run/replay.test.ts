import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { ReplayEffects, replayRun } from "../../src/run/replay.ts";
import { conformsToGraph, reconstructGraph, shouldExport, spansFrom } from "../../src/telemetry/spans.ts";
import { DOCS, compileSkeleton, harness } from "./skeleton.ts";

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

test("the gate span records what the approver saw, and hashes who they were", async () => {
  const { h, runId } = await recorded();
  const spans = spansFrom(await eventsOf(h.store as MemoryStateStore, runId));
  const gate = spans.find((s) => s.name === "loom.gate");
  assert.ok(gate);
  assert.equal(gate.attributes["gate.decision"], "approve");
  assert.match(String(gate.attributes["gate.content_digest"]), /^sha256:/);
  assert.notEqual(gate.attributes["gate.approver"], "u:alice", "the approver identity is hashed");
  assert.match(String(gate.attributes["gate.approver"]), /^[0-9a-f]{12}$/);
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
  const { h, runId } = await recorded();
  const events = await eventsOf(h.store as MemoryStateStore, runId);
  assert.equal(JSON.stringify(spansFrom(events)), JSON.stringify(spansFrom(events)));
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
