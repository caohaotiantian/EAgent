/**
 * The automatic escalation decision table, E1–E10.
 *
 * Two properties hold for the table as a whole, and they are asserted first because
 * every individual rule depends on them: every rule only TIGHTENS, and every rule names
 * itself in the journal. A rule that could loosen would be a hole; a rule that fired
 * anonymously would be indistinguishable from a bug.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ESCALATION_RULES,
  FailureStreaks,
  InMemoryCohortBaseline,
  InMemorySequenceIndex,
  REPEATED_FAILURE_THRESHOLD,
  detectAnomaly,
  isLowConfidence,
  scopeOf,
  toolNGram,
  type EscalationRuleId,
} from "../../src/run/escalation.ts";
import { postureRank } from "../../src/vocab.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, RunId } from "../../src/ids.ts";
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
import { resolver } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

// ── the table itself ─────────────────────────────────────────────────────────

test("EVERY RULE ONLY TIGHTENS — no rule can lower a posture", () => {
  // The property that makes the table safe to extend: a new rule is at worst noise.
  for (const rule of Object.values(ESCALATION_RULES)) {
    assert.ok(postureRank(rule.to) > postureRank("out"), `${rule.id} escalates to "${rule.to}"`);
  }
});

test("the table covers E1 through E10, each exactly once", () => {
  const codes = Object.values(ESCALATION_RULES).map((r) => r.code).sort();
  assert.deepEqual(codes, ["E1", "E10", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"]);
  assert.equal(new Set(codes).size, 10);
});

test("every rule states WHY, because an operator will ask", () => {
  for (const rule of Object.values(ESCALATION_RULES)) {
    assert.ok(rule.why.length > 20, `${rule.id} has no usable explanation`);
  }
});

test("a run-scoped rule and a node-scoped rule address different scopes", () => {
  assert.equal(scopeOf(ESCALATION_RULES.violation, "r1", n("x")), "run:r1");
  assert.equal(scopeOf(ESCALATION_RULES.repeated_failure, "r1", n("x")), "node:r1/x");
  assert.equal(scopeOf(ESCALATION_RULES.repeated_failure, "r1"), "run:r1", "with no node, it can only be the run");
});

// ── E1: low confidence ───────────────────────────────────────────────────────

test("E1 — a numeric score below the threshold is low confidence", () => {
  assert.equal(isLowConfidence({ pass: true, score: 0.5 }, 0.7), true);
  assert.equal(isLowConfidence({ pass: true, score: 0.9 }, 0.7), false);
  assert.equal(isLowConfidence({ score: 0.7 }, 0.7), false, "at the threshold is not below it");
});

test("E1 — ABSENCE IS NOT FAILURE", () => {
  // A verdict with no score has not scored low; it has not scored. Treating missing as
  // zero would escalate every run whose evaluator returned a bare {pass: true}, and an
  // alarm that always fires is one people learn to ignore.
  assert.equal(isLowConfidence({ pass: true }, 0.7), false);
  assert.equal(isLowConfidence({ score: "0.1" }, 0.7), false);
  assert.equal(isLowConfidence({ score: NaN }, 0.7), false);
  assert.equal(isLowConfidence(undefined, 0.7), false);
  assert.equal(isLowConfidence(null, 0.7), false);
});

// ── E4: consecutive failures ─────────────────────────────────────────────────

test("E4 — three CONSECUTIVE failures breach; a success resets", () => {
  const s = new FailureStreaks();
  assert.equal(s.record(n("a"), false), 1);
  assert.equal(s.record(n("a"), false), 2);
  assert.equal(s.breached(n("a")), false);
  assert.equal(s.record(n("a"), false), 3);
  assert.equal(s.breached(n("a")), true);

  s.record(n("a"), true);
  assert.equal(s.streak(n("a")), 0, "a node that fails once an hour is flaky; three in a row is broken");
  assert.equal(REPEATED_FAILURE_THRESHOLD, 3);
});

test("E4 — streaks are per node, not per run", () => {
  const s = new FailureStreaks();
  s.record(n("a"), false);
  s.record(n("b"), false);
  s.record(n("a"), false);
  assert.equal(s.streak(n("a")), 2);
  assert.equal(s.streak(n("b")), 1);
});

// ── E5: novel sequence ───────────────────────────────────────────────────────

test("E5 — an n-gram is ORDERED and not deduplicated", () => {
  assert.equal(toolNGram(["read", "write", "read"]), "read>write>read");
  assert.notEqual(
    toolNGram(["read", "write", "read"]),
    toolNGram(["read", "write"]),
    "a loop that did not used to loop is exactly the novelty worth noticing",
  );
});

test("E5 — the index is keyed on (graph, node, ngram)", () => {
  const idx = new InMemorySequenceIndex();
  idx.record("h1", n("a"), "x>y");
  assert.equal(idx.hasSeen("h1", n("a"), "x>y"), true);
  assert.equal(idx.hasSeen("h2", n("a"), "x>y"), false, "a different graph version has its own history");
  assert.equal(idx.hasSeen("h1", n("b"), "x>y"), false, "and so does a different node");
});

// ── E7: anomaly ──────────────────────────────────────────────────────────────

test("E7 — NO HISTORY MEANS NO ANOMALY", () => {
  // A p99 over one run is a number about nothing; firing on it would make every new
  // graph escalate on its second run.
  const baseline = new InMemoryCohortBaseline();
  for (let i = 0; i < 9; i++) baseline.record("h", "costUsd", 1);
  assert.equal(baseline.p99("h", "costUsd"), undefined, "under 10 samples, refuse to answer");
  assert.equal(detectAnomaly(baseline, "h", { costUsd: 999, tokens: 0, wallMs: 0 }), undefined);
});

test("E7 — a value over the cohort p99 is an anomaly, with the ratio an operator wants", () => {
  const baseline = new InMemoryCohortBaseline();
  for (let i = 0; i < 100; i++) baseline.record("h", "costUsd", 1);
  const reading = detectAnomaly(baseline, "h", { costUsd: 3, tokens: 0, wallMs: 0 });
  assert.ok(reading);
  assert.equal(reading.metric, "costUsd");
  assert.equal(reading.ratio, 3);
});

test("E7 — the FIRST breaching metric is reported, not all of them", () => {
  const baseline = new InMemoryCohortBaseline();
  for (let i = 0; i < 20; i++) {
    baseline.record("h", "costUsd", 1);
    baseline.record("h", "wallMs", 100);
  }
  const reading = detectAnomaly(baseline, "h", { costUsd: 5, tokens: 0, wallMs: 5000 });
  assert.equal(reading?.metric, "costUsd", "one breach is enough to decide; a short journal entry beats a complete one");
});

test("E7 — the window caps history at the last N runs", () => {
  const baseline = new InMemoryCohortBaseline(10);
  for (let i = 0; i < 10; i++) baseline.record("h", "costUsd", 100);
  for (let i = 0; i < 10; i++) baseline.record("h", "costUsd", 1);
  assert.equal(baseline.p99("h", "costUsd"), 1, "the expensive era rolled out of the window");
});

// ── the rules, wired into a real run ─────────────────────────────────────────

const TOOLS: Record<string, ToolManifestLite> = {
  "net.fetch": { name: "net.fetch", version: "1.0", capabilities: ["net:read"], irreversibility: "read_only", idempotent: true },
  "pay.charge": { name: "pay.charge", version: "1.0", capabilities: ["pay:write"], irreversibility: "irreversible", idempotent: false },
  "note.write": { name: "note.write", version: "1.0", capabilities: ["fs:write"], irreversibility: "reversible_write", idempotent: true },
};

const CAPS = ["net:read", "pay:write", "fs:write"];

function spec(over: Partial<GraphSpec> = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "esc", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: CAPS },
    channels: {
      goal: { type: "string", reduce: "replace" },
      notes: { type: "object", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
      done: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["done"],
    nodes: [
      {
        id: n("gather"),
        type: "agent",
        reads: ["goal"],
        writes: ["notes"],
        agent: {
          profile: "agent_profile/g@stable",
          prompt: "prompt/g@stable",
          maxTurns: 4,
          tools: ["net.fetch"],
          outputSchema: { type: "object" },
        },
      },
      { id: n("act"), type: "tool", reads: ["notes"], writes: ["done"], tool: { name: "note.write", version: "1.0" }, unhandled: true },
    ],
    edges: [{ id: e("go"), from: n("gather"), to: n("act"), kind: "seq" }],
    ...over,
  };
}

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly functions: FunctionRegistry;
  readonly ran: string[];
}

function rig(script: MockScript, opts: Partial<ConstructorParameters<typeof Engine>[0]> = {}, granted = CAPS): Rig {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();
  const ran: string[] = [];

  const def = (name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
    ...TOOLS[name]!,
    description: name,
    parameters: { type: "object" },
    execute: () => {
      ran.push(name);
      return { content: "ok", writes: { done: { ok: true } } };
    },
    ...extra,
  });
  tools.register(def("net.fetch", { execute: () => ({ content: "external data" }) }));
  tools.register(def("note.write"));
  tools.register(def("pay.charge"));

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now,
    resolver: resolver(),
    policy: { granted, systemFloor: "out", budget: { runUsd: 1 } },
    ...opts,
  });
  models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);
  return { engine, store, functions, ran };
}

async function escalations(store: MemoryStateStore, runId: RunId): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "policy.escalated") out.push((ev.payload as { rule: string }).rule);
  }
  return out;
}

const ANSWER: MockScript = (_req, turn) =>
  turn % 2 === 0
    ? { toolCalls: [{ id: "c", name: "net.fetch", arguments: {} }], finishReason: "tool_use" }
    : { text: JSON.stringify({ ok: true }), finishReason: "stop" };

const compileEsc = (s: GraphSpec = spec()) =>
  compileOrThrow({ spec: s, resolver: resolver(), tools: TOOLS, tenantCapabilities: CAPS });

test("E5 — a never-before-seen tool sequence escalates the node", async () => {
  const sequences = new InMemorySequenceIndex();
  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = await escalations(r.store, runId);
  assert.ok(
    fired.some((f) => f.startsWith("novel_sequence")),
    `expected novel_sequence, got ${fired.join(", ")}`,
  );
  assert.ok(fired.find((f) => f.startsWith("novel_sequence"))?.includes("net.fetch"), "the journal names the n-gram");
});

test("E5 — a TOOL node never trips it: its tool is in the spec, not chosen", async () => {
  // `act` calls `note.write` because the graph says so. If that changed, the graph hash
  // changed and this is a different graph — there is no novelty for E5 to find.
  const sequences = new InMemorySequenceIndex();
  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = (await escalations(r.store, runId)).filter((f) => f.startsWith("novel_sequence"));
  assert.equal(fired.length, 1);
  assert.match(fired[0]!, /net\.fetch/, "the agent's choice, not the tool node's declaration");
});

test("E5 — a sequence already in the index is silent", async () => {
  const sequences = new InMemorySequenceIndex();
  const graph = compileEsc();
  sequences.record(graph.graphHash, n("gather"), "net.fetch");

  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph, inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f.startsWith("novel_sequence")), []);
});

test("E5 — with NO index configured the rule never fires", async () => {
  // Correct with no history: the rule has nothing to say about the first run of a graph.
  const r = rig(ANSWER);
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f.startsWith("novel_sequence")), []);
});

test("E6 — a denied capability escalates the whole run to `in`", async () => {
  const r = rig(ANSWER, {}, ["net:read"]);
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  const fired = await escalations(r.store, runId);
  assert.ok(fired.some((f) => f.startsWith("violation")), fired.join(", "));
});

test("E7 — a run costing more than its cohort's p99 escalates", async () => {
  const baseline = new InMemoryCohortBaseline();
  const graph = compileEsc();
  for (let i = 0; i < 20; i++) baseline.record(graph.graphHash, "costUsd", 0.000001);

  const r = rig(ANSWER, { baseline });
  const runId = await r.engine.submit({ graph, inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = await escalations(r.store, runId);
  const anomaly = fired.find((f) => f.startsWith("anomaly"));
  assert.ok(anomaly, fired.join(", "));
  assert.match(anomaly, /"metric":"costUsd"/);
});

test("E7 — with no baseline configured the rule never fires", async () => {
  const r = rig(ANSWER);
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f.startsWith("anomaly")), []);
});

test("E8 — TAINTED TOOL OUTPUT FEEDING AN IRREVERSIBLE ACTION GATES", async () => {
  // The prompt-injection path. `notes` is written by an agent that called an external
  // tool, so it carries untrusted content; `charge` reads it and cannot be undone.
  const withCharge = spec({
    nodes: [
      ...spec().nodes.filter((x) => x.id === "gather"),
      { id: n("charge"), type: "tool", reads: ["notes"], writes: ["done"], tool: { name: "pay.charge", version: "1.0" }, unhandled: true },
    ],
    edges: [{ id: e("go"), from: n("gather"), to: n("charge"), kind: "seq" }],
  });

  const r = rig(ANSWER);
  const runId = await r.engine.submit({ graph: compileEsc(withCharge), inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate");
  assert.equal(Object.values(p.gates).find((g) => g.state === "open")?.nodeId, "charge");
  assert.deepEqual(r.ran, [], "and the charge has not happened");
});

test("E4 — three failures on one node escalate it", async () => {
  // A three-way fan-out where every branch fails. Three separate Tasks, one node,
  // nothing in between succeeding — which is precisely the signal E4 exists for: a node
  // that is broken RIGHT NOW, as opposed to one that is occasionally flaky.
  const failing: GraphSpec = {
    ...spec(),
    channels: {
      ...spec().channels,
      items: { type: "array", reduce: "replace" },
      item: { type: "string", reduce: "replace" },
      results: { type: "array", reduce: "append_ordered" },
    },
    inputs: ["items"],
    nodes: [
      { id: n("start"), type: "function", reads: ["items"], function: { ref: "function/pass@stable" } },
      {
        id: n("flaky"),
        type: "agent",
        reads: ["item"],
        writes: ["results"],
        agent: {
          profile: "agent_profile/g@stable",
          prompt: "prompt/g@stable",
          maxTurns: 1,
          outputSchema: { type: "object", properties: { need: { type: "string" } }, required: ["need"] },
        },
      },
      {
        id: n("collect"),
        type: "join",
        reads: ["results"],
        writes: ["done"],
        join: { branches: [n("flaky")], mode: "all", onBranchError: "skip", timeoutMs: 1000 },
      },
    ],
    edges: [
      { id: e("fan"), from: n("start"), to: n("flaky"), kind: "fanout", over: "items", as: "item", maxWidth: 3 },
      { id: e("j"), from: n("flaky"), to: n("collect"), kind: "join", branches: [n("flaky")] },
    ],
  };

  const r = rig(() => ({ text: "not the shape you asked for", finishReason: "stop" }));
  r.functions.register("function/pass@stable", () => ({}));
  const runId = await r.engine.submit({ graph: compileEsc(failing), inputs: { items: ["a", "b", "c"] } });
  await r.engine.advance(runId);

  const fired = await escalations(r.store, runId);
  const hit = fired.find((f) => f.startsWith("repeated_failure"));
  assert.ok(hit, fired.join(", "));
  assert.match(hit, /"streak":3/);
});

test("E4 — a schema mismatch is NOT retried, so one bad answer is not a streak", async () => {
  // `E_PROVIDER_BAD_REQUEST` is validation-class: retrying a schema mismatch produces the
  // same schema mismatch. One failure is one failure.
  const r = rig(() => ({ text: "wrong shape", finishReason: "stop" }));
  const one: GraphSpec = {
    ...spec(),
    nodes: [
      {
        id: n("once"),
        type: "agent",
        reads: ["goal"],
        writes: ["done"],
        agent: {
          profile: "agent_profile/g@stable",
          prompt: "prompt/g@stable",
          maxTurns: 1,
          outputSchema: { type: "object", properties: { need: { type: "string" } }, required: ["need"] },
        },
        retry: { maxAttempts: 3, backoff: "fixed", initialMs: 0 },
      },
    ],
    edges: [],
  };
  const runId = await r.engine.submit({ graph: compileEsc(one), inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f.startsWith("repeated_failure")), []);
});

test("E1 — an evaluator below its threshold escalates the run, without failing it", async () => {
  // A weak verdict is not a failure; it is a reason for someone to be watching what the
  // run does with it, which is exactly what posture `on` means.
  const graded: GraphSpec = {
    ...spec(),
    nodes: [
      {
        id: n("judge"),
        type: "evaluator",
        reads: ["goal"],
        writes: ["verdict"],
        evaluator: { kind: "assertion", ref: "function/judge@stable", threshold: 0.7 },
      },
      { id: n("finish"), type: "function", reads: ["verdict"], writes: ["done"], function: { ref: "function/pass@stable" } },
    ],
    edges: [{ id: e("go"), from: n("judge"), to: n("finish"), kind: "seq" }],
  };

  const r = rig(ANSWER);
  r.functions.register("function/judge@stable", () => ({ writes: { verdict: { pass: false, score: 0.3 } } }));
  r.functions.register("function/pass@stable", () => ({ writes: { done: { ok: true } } }));

  const runId = await r.engine.submit({ graph: compileEsc(graded), inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", "escalation is not failure");
  const fired = await escalations(r.store, runId);
  assert.ok(fired.some((f) => f.startsWith("low_confidence")), fired.join(", "));
});

test("E1 — a verdict with NO score does not escalate", async () => {
  const graded: GraphSpec = {
    ...spec(),
    nodes: [
      {
        id: n("judge"),
        type: "evaluator",
        reads: ["goal"],
        writes: ["done"],
        evaluator: { kind: "assertion", ref: "function/judge@stable", threshold: 0.7 },
      },
    ],
    edges: [],
  };
  const r = rig(ANSWER);
  r.functions.register("function/judge@stable", () => ({ writes: { done: { pass: true } } }));
  const runId = await r.engine.submit({ graph: compileEsc(graded), inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f.startsWith("low_confidence")), []);
});

test("E2 — crossing 80% of the budget escalates ONCE", async () => {
  // A rule that re-escalated on every reservation past the line would flood the journal
  // with a fact that has not changed — and `max` makes the repeats no-ops anyway.
  const r = rig(ANSWER, { policy: { granted: CAPS, systemFloor: "out", budget: { runUsd: 0.00125 } } });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = (await escalations(r.store, runId)).filter((f) => f.startsWith("budget_warning"));
  assert.equal(fired.length, 1, `expected exactly one warning, got ${fired.length}`);
  assert.match(fired[0]!, /"remainingUsd"/, "the journal says how much is left, which is what an operator acts on");
});

test("E3 — an exhausted budget GATES when the graph asked it to", async () => {
  const gating = spec({ policy: { posture: "out", budget: { costUsd: 1 }, capabilities: CAPS, onBudgetExhausted: "gate" } });
  const r = rig(ANSWER, { policy: { granted: CAPS, systemFloor: "out", budget: { runUsd: 0.000001 } } });
  const runId = await r.engine.submit({ graph: compileEsc(gating), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = await escalations(r.store, runId);
  assert.ok(
    fired.some((f) => f.startsWith("budget_exhausted")),
    `"stop, this is expensive" and "stop" are different answers: ${fired.join(", ")}`,
  );
});

test("E3 — the default is to FAIL, not to gate", async () => {
  const r = rig(ANSWER, { policy: { granted: CAPS, systemFloor: "out", budget: { runUsd: 0.000001 } } });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f.startsWith("budget_exhausted")), []);
});

test("a rule that fires twice escalates once — `max` makes repeats no-ops", async () => {
  const sequences = new InMemorySequenceIndex();
  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const events: JournalEvent[] = [];
  for await (const ev of r.store.read(runId, 1)) events.push(ev);
  const novel = events.filter((ev) => ev.type === "policy.escalated" && String((ev.payload as { rule: string }).rule).startsWith("novel_sequence"));
  assert.equal(novel.length, 1, "the second escalation to the same posture is a no-op and is not journaled");
  assert.match(String((novel[0]!.payload as { scope: string }).scope), /\/gather$/, "and it is scoped to the AGENT that chose the sequence");
});

test("EVERY escalation names its rule in the journal", async () => {
  const sequences = new InMemorySequenceIndex();
  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const ids = new Set<string>(Object.keys(ESCALATION_RULES) as EscalationRuleId[]);
  for (const rule of await escalations(r.store, runId)) {
    assert.ok(
      [...ids].some((id) => rule.startsWith(id)),
      `"${rule}" is not a rule in the table — an anonymous escalation is indistinguishable from a bug`,
    );
  }
});
