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
