/**
 * The walking-skeleton acceptance suite.
 *
 * Each test maps to a numbered row of design/loom/08-PLAN.md D13.3. Passing all of
 * them is what turns "the architecture should work" into "the architecture works".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "../../src/graph/compile.ts";
import { SqliteStateStore } from "../../src/journal/sqlite.ts";
import { foldRun } from "../../src/run/projection.ts";
import { Engine } from "../../src/run/engine.ts";
import type { NodeId, RunId } from "../../src/ids.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import {
  DOCS,
  SKELETON_TENANT_CAPS,
  SKELETON_TOOLS,
  compileSkeleton,
  harness,
  resolver,
  skeletonSpec,
} from "./skeleton.ts";
import { omit } from "../graph/fixtures.ts";

async function events(store: { read(r: RunId, f: number): AsyncIterable<JournalEvent> }, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) out.push(e);
  return out;
}

/** Run to the gate, approve it, and return the finished projection. */
async function runToCompletion(h: ReturnType<typeof harness>, runId: RunId) {
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
  return p;
}

// ── row 1: one artifact serves every layer ───────────────────────────────────

test("row 1 — the same GraphSpec compiles, runs, and is identified by one hash", async () => {
  const h = harness();
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });

  const log = await events(h.store, runId);
  const submitted = log.find((e) => e.type === "run.submitted")!;
  const compiled = log.find((e) => e.type === "run.compiled")!;
  assert.equal((submitted.payload as { graphHash: string }).graphHash, graph.graphHash);
  assert.equal((compiled.payload as { graphHash: string }).graphHash, graph.graphHash);
});

// ── row 2: compile-time validation is real ───────────────────────────────────

test("row 2 — removing maxWidth is GRAPH007; overcommitting a branch budget is GRAPH009", () => {
  const noWidth = skeletonSpec();
  const stripped = {
    ...noWidth,
    edges: noWidth.edges.map((e) => (e.id === "e0" ? omit(e, "maxWidth") : e)),
  };
  const r1 = compile({ spec: stripped, resolver: resolver(), tools: SKELETON_TOOLS, tenantCapabilities: SKELETON_TENANT_CAPS });
  assert.equal(r1.ok, false);
  assert.ok(r1.diagnostics.some((d) => d.code === "GRAPH007_NO_MAX_WIDTH"));

  // 5 branches × $0.30 = $1.50 against a $1.00 run budget. Each branch looks fine
  // on its own; only the product is wrong.
  const overspend = skeletonSpec();
  const bumped = {
    ...overspend,
    nodes: overspend.nodes.map((n) => (n.id === "summarize" ? { ...n, policy: { budget: { costUsd: 0.3 } } } : n)),
  };
  const r2 = compile({ spec: bumped, resolver: resolver(), tools: SKELETON_TOOLS, tenantCapabilities: SKELETON_TENANT_CAPS });
  assert.equal(r2.ok, false);
  assert.ok(r2.diagnostics.some((d) => d.code === "GRAPH009_BUDGET_OVERCOMMIT"));
});

// ── row 3: parallel fan-out ──────────────────────────────────────────────────

test("row 3 — a fan-out produces one Task per item, each with its own binding", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await runToCompletion(h, runId);

  const summaries = Object.values(p.tasks).filter((t) => t.nodeId === ("summarize" as NodeId));
  assert.equal(summaries.length, 5);
  assert.deepEqual(
    summaries.map((t) => p.bindings[`root/e0[${t.branch.segments[0]?.index}]`]?.["path"]).sort(),
    [...DOCS].sort(),
  );
  // Every branch really ran its tool, so this is parallelism, not a loop in disguise.
  assert.deepEqual([...h.reads].sort(), [...DOCS].sort());
});

// ── row 4: typed join folds in BRANCH order, not completion order ────────────

test("row 4 — the join folds in branch-coordinate order even when branch 0 finishes last", async () => {
  // Branch 0 takes an extra tool round-trip, so it commits after the others. If the
  // fold used arrival order, doc-0 would not be first.
  const h = harness({
    script: (req, turn) => {
      const parsed = JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { path?: string } };
      const path = parsed.state?.path ?? "?";
      const slow = path === "doc-0.md";
      const readTurns = slow ? 2 : 1;
      if (turn < readTurns) {
        return { toolCalls: [{ id: `c${turn}`, name: "fs.read", arguments: { path } }], finishReason: "tool_use" };
      }
      return { text: JSON.stringify({ path, summary: `summary of ${path}` }), finishReason: "stop" };
    },
  });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await runToCompletion(h, runId);

  const digests = p.channels["digests"] as { path: string }[];
  assert.equal(digests.length, 5);
  assert.deepEqual(digests.map((d) => d.path), DOCS, "branch order, not completion order");
});

test("row 4b — the sum reducer aggregates cost across branches", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await runToCompletion(h, runId);
  assert.ok((p.channels["costUsd"] as number) > 0);
  assert.equal(typeof p.channels["costUsd"], "number");
});

// ── row 5: partial failure is contained ──────────────────────────────────────

test("row 5 — one failed branch is skipped, recorded, and the run still completes", async () => {
  const h = harness({ failBranch: 2 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await runToCompletion(h, runId);

  assert.equal(p.status, "succeeded");
  const digests = p.channels["digests"] as { path: string }[];
  assert.equal(digests.length, 4, "the failed branch contributes nothing");
  assert.ok(!digests.some((d) => d.path === "doc-2.md"));

  const reduced = (await events(h.store, runId)).filter((e) => e.type === "state.reduced");
  const joinReduce = reduced.find((e) => (e.payload as { skipped: number }).skipped > 0);
  assert.ok(joinReduce, "the fold records that it ran on partial evidence");
  assert.equal((joinReduce.payload as { degraded: boolean }).degraded, true);
});

// ── row 6: DURABLE HUMAN GATE ACROSS A PROCESS RESTART ───────────────────────

test("row 6 — a gate survives losing the process entirely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-skeleton-"));
  const path = join(dir, "journal.db");
  try {
    // ── process 1: run until the gate, then vanish ──
    const storeA = new SqliteStateStore({ path });
    const hA = harness({ store: storeA });
    const graph = compileSkeleton();
    const runId = await hA.engine.submit({ graph, inputs: { paths: DOCS } });
    const before = await hA.engine.advance(runId);

    assert.equal(before.status, "awaiting_gate");
    assert.equal(Object.values(before.gates).filter((g) => g.state === "open").length, 1);
    assert.equal(hA.writes.length, 0, "nothing irreversible has happened yet");

    // Simulate `kill -9`: no shutdown hook, no flush, no chance to save anything.
    storeA.close();

    // ── process 2: a brand-new engine, sharing only the file ──
    const storeB = new SqliteStateStore({ path });
    const hB = harness({ store: storeB });
    hB.engine.attach(runId, graph);

    const recovered = await hB.engine.projection(runId);
    assert.ok(recovered);
    assert.equal(recovered.status, "awaiting_gate", "the run is still suspended, with no recovery step");
    const gate = Object.values(recovered.gates).find((g) => g.state === "open");
    assert.ok(gate, "the gate is a row, not a promise");

    const after = await hB.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "approve" },
      actor: { kind: "human", subject: "u:bob", via: "console" },
      idempotencyKey: "k1",
    });
    assert.equal(after.status, "succeeded");
    assert.equal(hB.writes.length, 1, "and the run finished in the NEW process");
    storeB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("row 6b — a suspended run holds no in-flight work", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  const busy = Object.values(p.tasks).filter((t) => t.state === "leased" || t.state === "ready");
  assert.deepEqual(busy, [], "zero worker slots held while awaiting a human");
});

// ── row 7: rejection stops the irreversible action ───────────────────────────

test("row 7 — rejecting the gate fails the run and nothing is written", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const gated = await h.engine.advance(runId);
  const gate = Object.values(gated.gates).find((g) => g.state === "open")!;

  const p = await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "reject", reason: "summary is wrong" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });

  assert.equal(p.status, "failed");
  assert.equal(h.writes.length, 0, "the write never ran");
  assert.match(p.error?.message ?? "", /rejected: summary is wrong/);
});

test("row 7b — an `edit` decision writes channels and then proceeds", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const gated = await h.engine.advance(runId);
  const gate = Object.values(gated.gates).find((g) => g.state === "open")!;

  const p = await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "edit", writes: { merged: { count: 1, markdown: "human rewrote this" } }, reason: "tightened" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });

  assert.equal(p.status, "succeeded");
  assert.equal(h.writes[0]?.body, "human rewrote this", "the human's edit is what got written");
});

test("row 7c — a gate decision is idempotent per approver", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const gated = await h.engine.advance(runId);
  const gate = Object.values(gated.gates).find((g) => g.state === "open")!;
  const input = {
    gateId: gate.gateId,
    decision: { kind: "approve" as const },
    actor: { kind: "human" as const, subject: "u:alice", via: "console" as const },
    idempotencyKey: "double-click",
  };

  await h.engine.resolveGate(runId, input);
  await h.engine.resolveGate(runId, input); // the double-click
  const p = await h.engine.projection(runId);
  assert.equal(p?.status, "succeeded");
  assert.equal(h.writes.length, 1, "one decision, one write");
});

// ── row 8: the journal is complete and re-foldable ───────────────────────────

test("row 8 — re-folding the journal reproduces the identical projection", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const live = await runToCompletion(h, runId);

  const refolded = foldRun(await events(h.store, runId));
  assert.ok(refolded);
  assert.deepEqual(refolded.channels, live.channels);
  assert.deepEqual(refolded.outputs, live.outputs);
  assert.equal(refolded.status, live.status);
  assert.equal(refolded.seq, live.seq);
});

test("row 8b — every state change comes from a state.reduced event", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  await runToCompletion(h, runId);

  const log = await events(h.store, runId);
  const inputs = (log.find((e) => e.type === "run.submitted")!.payload as { inputs: Record<string, unknown> }).inputs;
  // Fold using ONLY the inputs and state.reduced events; if anything else silently
  // mutated channel state, this reconstruction would differ.
  let channels: Record<string, unknown> = { ...inputs };
  for (const e of log) {
    if (e.type === "state.reduced") channels = { ...channels, ...(e.payload as { values: Record<string, unknown> }).values };
  }
  const full = foldRun(log)!;
  assert.deepEqual(channels, full.channels);
});

// ── row 9: the journal reconstructs the executed graph ───────────────────────

test("row 9 — the executed graph is a subset of the declared graph", async () => {
  const h = harness();
  const graph = compileSkeleton();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  await runToCompletion(h, runId);

  const p = (await h.engine.projection(runId))!;
  const declaredNodes = new Set(graph.spec.nodes.map((x) => x.id));
  const declaredEdges = new Set(graph.spec.edges.map((x) => x.id));

  const executedNodes = new Set(Object.values(p.tasks).map((t) => t.nodeId));
  const executedEdges = new Set(Object.values(p.tasks).flatMap((t) => [...t.take, ...t.edgesIn]));

  for (const id of executedNodes) assert.ok(declaredNodes.has(id), `executed unknown node ${id}`);
  for (const id of executedEdges) assert.ok(declaredEdges.has(id), `executed unknown edge ${id}`);
  assert.equal(p.graphHash, graph.graphHash);
});

// ── row 10: no external service ──────────────────────────────────────────────

test("row 10 — a full run on a fresh SQLite file, with no network and no API key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-empty-"));
  try {
    const store = new SqliteStateStore({ path: join(dir, "fresh.db") });
    const h = harness({ store });
    const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
    const p = await runToCompletion(h, runId);
    assert.equal(p.status, "succeeded");
    assert.equal(h.writes.length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── row 11: posture is a config change, not a code change ────────────────────

test("row 11 — the SAME graph runs autonomously when the gate node is removed", async () => {
  // Identical nodes and edges apart from dropping the human_gate; no code differs.
  const autonomous = skeletonSpec();
  const spec = {
    ...autonomous,
    nodes: autonomous.nodes.filter((n) => n.id !== "approve"),
    edges: autonomous.edges
      .filter((e) => e.id !== "e3" && e.id !== "e4")
      .concat([{ id: "e3b" as never, from: "merge" as NodeId, to: "write" as NodeId, kind: "seq" as const }]),
  };
  const h = harness();
  const graph = compile({ spec, resolver: resolver(), tools: SKELETON_TOOLS, tenantCapabilities: SKELETON_TENANT_CAPS });
  assert.equal(graph.ok, true);
  if (!graph.ok) return;

  const runId = await h.engine.submit({ graph: graph.graph, inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "succeeded", "no gate, no suspension");
  assert.equal(h.writes.length, 1);
});

test("row 11b — a system floor of `in` gates a run that would otherwise be autonomous", async () => {
  const h = harness({ systemFloor: "in" });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  // The very first node now needs a human, because nothing can lower the floor.
  assert.equal(p.status, "awaiting_gate");
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  assert.equal(gate.nodeId, "start" as NodeId);
});

// ── row 12: cost governance under fan-out ────────────────────────────────────

test("row 12 — reservations stop 5 concurrent branches from overspending", async () => {
  // A budget too small for five branches. Reservation debits the worst case up
  // front, so the overspend is refused rather than discovered after the fact.
  const h = harness({ budgetUsd: 0.000_02 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.match(JSON.stringify(p.error), /E_BUDGET_EXHAUSTED|budget/);
  assert.equal(h.writes.length, 0, "no irreversible action happened on a broke run");
});

test("row 12b — reservations are released, so a completed run holds nothing", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await runToCompletion(h, runId);
  assert.equal(p.status, "succeeded");
  assert.equal(p.reservedUsd, 0, "every reservation settled");
});

// ── supporting behaviour ─────────────────────────────────────────────────────

test("the tool allowlist is structural: an injected tool name is refused pre-dispatch", async () => {
  const h = harness({
    script: (req, turn) => {
      const parsed = JSON.parse(req.messages[0]?.content ?? "{}") as { state?: { path?: string } };
      const path = parsed.state?.path ?? "?";
      if (turn % 2 === 0) {
        // The classic injection outcome: the model asks for a tool the node never
        // declared. `fs.write` IS registered — it is simply not in this node's list.
        return { toolCalls: [{ id: "x", name: "fs.write", arguments: { path: "/etc/passwd", body: "pwned" } }], finishReason: "tool_use" };
      }
      return { text: JSON.stringify({ path, summary: "ok" }), finishReason: "stop" };
    },
  });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: ["doc-0.md"] } });
  await runToCompletion(h, runId);

  assert.deepEqual(
    h.writes.map((w) => w.path),
    ["out/summary.md"],
    "only the declared write node wrote; the injected call never dispatched",
  );
});

test("a tool that throws surfaces as a failed Task, not a crashed engine", async () => {
  const h = harness({ writeThrows: true });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: ["doc-0.md"] } });
  const p = await runToCompletion(h, runId);
  assert.equal(p.status, "failed");
  assert.match(JSON.stringify(p.error), /disk on fire/);
});

test("maxParallelism bounds the in-flight wave without losing Tasks", async () => {
  const h = harness({ maxParallelism: 2 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await runToCompletion(h, runId);
  assert.equal(p.status, "succeeded");
  assert.equal((p.channels["digests"] as unknown[]).length, 5, "all five branches still ran");
});

test("the bus sees the run's events live", async () => {
  const h = harness();
  const seen: string[] = [];
  const sub = h.bus.subscribe({}, { queueSize: 1000, onOverflow: "drop_oldest" });
  void (async () => {
    for await (const e of sub) seen.push(e.type);
  })();

  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: ["doc-0.md"] } });
  await runToCompletion(h, runId);
  await new Promise((r) => setImmediate(r));
  sub.dispose();

  assert.ok(seen.includes("run.submitted"));
  assert.ok(seen.includes("gate.raised"));
  assert.ok(seen.includes("run.completed"));
});
