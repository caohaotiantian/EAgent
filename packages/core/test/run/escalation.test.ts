/**
 * The automatic escalation decision table.
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
import { memoryPayloads } from "../../src/journal/payloads.ts";
import { compile, compileOrThrow } from "../../src/graph/compile.ts";
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
  //
  // Non-vacuous because `registries-are-populated.test.ts` floors ESCALATION_RULES. An "every
  // member" claim over an empty table passes while asserting nothing, and this repo has shipped
  // that shape twice.
  for (const rule of Object.values(ESCALATION_RULES)) {
    assert.ok(postureRank(rule.to) > postureRank("out"), `${rule.id} escalates to "${rule.to}"`);
  }
});

test("every rule has its own D7.7 code, and E11 is still nobody's", () => {
  // The members, not a count: a code shared by two rules is a journal entry an operator cannot
  // look up. E11 is absent on purpose — D7.7 reserves it for provider fall-through, which
  // `providers/fallback.ts` names in `onFallback` and which nothing in this table builds.
  const codes = Object.values(ESCALATION_RULES).map((r) => r.code).sort();
  assert.deepEqual(codes, ["E1", "E10", "E12", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"]);
  assert.equal(new Set(codes).size, codes.length, "two rules share a code");
  assert.ok(!codes.includes("E11"), "E11 belongs to provider fall-through and is not built here");
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

/**
 * `rule` and `detail` READ SEPARATELY, because that is what the journal now carries.
 *
 * These assertions used to run against one packed string — `#escalate` journaled
 * `` `${id} ${JSON.stringify(detail)}` `` — so every one of them was written as
 * `startsWith(id)` plus a regex over the JSON tail. That worked, and it hid the defect the
 * shape caused: `evolution/trajectory.ts` compared `e.payload.rule === "violation"` against
 * `violation {"capability":{…}}` and never matched. Tests shaped around a defect are how a
 * defect survives having tests.
 */
async function escalationRows(
  store: MemoryStateStore,
  runId: RunId,
): Promise<{ rule: string; detail?: Record<string, unknown> }[]> {
  const out: { rule: string; detail?: Record<string, unknown> }[] = [];
  for await (const ev of store.read(runId, 1)) {
    if (ev.type === "policy.escalated") out.push(ev.payload as { rule: string; detail?: Record<string, unknown> });
  }
  return out;
}

/** Just the ids, for the many assertions that only care which rule fired. */
async function escalations(store: MemoryStateStore, runId: RunId): Promise<string[]> {
  return (await escalationRows(store, runId)).map((r) => r.rule);
}

/** The detail of the first row for a rule, as JSON — so an existing regex still reads. */
async function detailOf(store: MemoryStateStore, runId: RunId, rule: string): Promise<string> {
  const row = (await escalationRows(store, runId)).find((r) => r.rule === rule);
  return row === undefined ? "" : JSON.stringify(row.detail ?? {});
}

const ANSWER: MockScript = (_req, turn) =>
  turn % 2 === 0
    ? { toolCalls: [{ id: "c", name: "net.fetch", arguments: {} }], finishReason: "tool_use" }
    : { text: JSON.stringify({ ok: true }), finishReason: "stop" };

/** Over EXTERNALISE_ABOVE_BYTES (64 KiB), so the write leaves `writes` and becomes a handle. */
const BIG_ANSWER: MockScript = (_req, turn) =>
  turn % 2 === 0
    ? { toolCalls: [{ id: "c", name: "net.fetch", arguments: {} }], finishReason: "tool_use" }
    : { text: JSON.stringify({ ok: true, filler: "x".repeat(80 * 1024) }), finishReason: "stop" };

const compileEsc = (s: GraphSpec = spec()) =>
  compileOrThrow({ spec: s, resolver: resolver(), tools: TOOLS, tenantCapabilities: CAPS });

test("E5 — a never-before-seen tool sequence escalates the node", async () => {
  const sequences = new InMemorySequenceIndex();
  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = await escalations(r.store, runId);
  assert.ok(
    fired.some((f) => f === "novel_sequence"),
    `expected novel_sequence, got ${fired.join(", ")}`,
  );
  assert.match(await detailOf(r.store, runId, "novel_sequence"), /net\.fetch/, "the journal names the n-gram");
});

test("E5 — a TOOL node never trips it: its tool is in the spec, not chosen", async () => {
  // `act` calls `note.write` because the graph says so. If that changed, the graph hash
  // changed and this is a different graph — there is no novelty for E5 to find.
  const sequences = new InMemorySequenceIndex();
  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = (await escalations(r.store, runId)).filter((f) => f === "novel_sequence");
  assert.equal(fired.length, 1);
  assert.match(await detailOf(r.store, runId, "novel_sequence"), /net\.fetch/, "the agent's choice, not the tool node's declaration");
});

test("E5 — a sequence already in the index is silent", async () => {
  const sequences = new InMemorySequenceIndex();
  const graph = compileEsc();
  sequences.record(graph.graphHash, n("gather"), "net.fetch");

  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph, inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f === "novel_sequence"), []);
});

test("E5 — with NO index configured the rule never fires", async () => {
  // Correct with no history: the rule has nothing to say about the first run of a graph.
  const r = rig(ANSWER);
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f === "novel_sequence"), []);
});

test("E6 — a denied capability escalates the whole run to `in`", async () => {
  const r = rig(ANSWER, {}, ["net:read"]);
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  const fired = await escalations(r.store, runId);
  assert.ok(fired.some((f) => f === "violation"), fired.join(", "));
});

test("E7 — a run costing more than its cohort's p99 escalates", async () => {
  const baseline = new InMemoryCohortBaseline();
  const graph = compileEsc();
  for (let i = 0; i < 20; i++) baseline.record(graph.graphHash, "costUsd", 0.000001);

  const r = rig(ANSWER, { baseline });
  const runId = await r.engine.submit({ graph, inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = await escalations(r.store, runId);
  const anomaly = fired.find((f) => f === "anomaly");
  assert.ok(anomaly, fired.join(", "));
  assert.match(await detailOf(r.store, runId, "anomaly"), /"metric":"costUsd"/);
});

test("E7 — with no baseline configured the rule never fires", async () => {
  const r = rig(ANSWER);
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f === "anomaly"), []);
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

  // THE ASSERTION THAT MAKES THIS TEST ABOUT TAINT. `pay.charge` is `irreversible`, so it
  // gates on its class alone and every line above passes with E8 deleted — which is how the
  // rule stayed inert under a covering test. The escalation event is the part only taint
  // can produce.
  const fired = await escalations(r.store, runId);
  assert.ok(fired.some((f) => f === "taint"), `E8 must actually fire: ${fired.join(", ")}`);
  assert.match(await detailOf(r.store, runId, "taint"), /"reads":\["notes"\]/, "naming the channel that carried it");
});

test("E8 — TAINT OUTLIVES A HUMAN DE-ESCALATION; the class default does not", async () => {
  // THE PROMPT-INJECTION PATH, and the only case where taint can change an answer at all.
  // On the floor a taint bump is arithmetically dead: it raises exactly the two classes
  // `CLASS_DEFAULT_POSTURE` already puts at `in`. So the mechanism is only ever observable
  // once a human has lowered the ceiling — and there it was defeated by the hard floor,
  // which clamped to `on` whatever the taint said. Untainted, `on` is right: someone is
  // watching. Tainted, the human lowered it without having seen the untrusted content that
  // now feeds the charge, so they are asked again.
  const withCharge = spec({
    nodes: [
      ...spec().nodes.filter((x) => x.id === "gather"),
      { id: n("charge"), type: "tool", reads: ["notes"], writes: ["done"], tool: { name: "pay.charge", version: "1.0" }, unhandled: true },
    ],
    edges: [{ id: e("go"), from: n("gather"), to: n("charge"), kind: "seq" }],
  });

  const r = rig(ANSWER);
  const runId = await r.engine.submit({ graph: compileEsc(withCharge), inputs: { goal: "x" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "watching this one myself", {
    kind: "human",
    id: "u:alice",
  });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `a de-escalated run must still gate a TAINTED charge: ${p.status}`);
  assert.equal(Object.values(p.gates).find((g) => g.state === "open")?.nodeId, "charge", "and it is the CHARGE that gated");
  assert.deepEqual(r.ran, [], "and the charge has not happened");
});

test("E8 — A TOOL RESULT TAINTS THE REST OF ITS OWN AGENT TURN", async () => {
  // THE CANONICAL PROMPT INJECTION, and the shape none of the channel-level machinery can
  // see: one agent node, declared reads clean, both tools its own. `net.fetch` returns text
  // telling the model to charge, and the model does. `ctx.tainted` is written at COMMIT, so
  // at the moment of the charge there is no committed write anywhere to have tainted.
  //
  // The node itself gates at `in` on its reachable-tool floor, so the exposure is exactly the
  // de-escalated case E8 exists for — hence the ceiling here.
  const injected: MockScript = (_req, turn) =>
    turn === 0
      ? { toolCalls: [{ id: "c1", name: "net.fetch", arguments: {} }], finishReason: "tool_use" }
      : turn === 1
        ? { toolCalls: [{ id: "c2", name: "pay.charge", arguments: {} }], finishReason: "tool_use" }
        : { text: JSON.stringify({ ok: true }), finishReason: "stop" };

  const oneNode = spec({
    nodes: [
      {
        id: n("act"),
        type: "agent",
        reads: ["goal"],
        writes: ["notes"],
        agent: { profile: "agent_profile/g@stable", prompt: "prompt/g@stable", maxTurns: 4, tools: ["net.fetch", "pay.charge"], outputSchema: { type: "object" } },
      },
    ],
    edges: [],
    outputs: ["notes"],
  });

  const r = rig(injected, { sleep: async () => {} });
  const runId = await r.engine.submit({ graph: compileEsc(oneNode), inputs: { goal: "x" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "watching", { kind: "human", id: "u:alice" });
  await r.engine.advance(runId);

  // `net.fetch` is registered with its own `execute`, so `ran` records the CHARGE alone —
  // which is the only thing in question. Before this, it read `["pay.charge"]`.
  assert.deepEqual(r.ran, [], "the fetch is fine; the charge downstream of it is not");

  // AND THE REFUSAL IS JOURNALED. An agent turn cannot suspend — the transcript is in memory,
  // so a gate raised here could not be answered after a restart — so `gate` becomes a refusal
  // the model is told about. Asserting the journal is what separates "refused" from "the model
  // happened not to ask".
  const reasons: string[] = [];
  for await (const ev of r.store.read(runId, 1)) {
    if (ev.type === "policy.decided") reasons.push(JSON.stringify(ev.payload));
  }
  assert.ok(
    reasons.some((x) => x.includes("an agent turn cannot raise a gate") && x.includes("(E8)")),
    `the charge must be refused FOR TAINT: ${reasons.join(" | ")}`,
  );
});

test("E8 — TAINT SURVIVES A PROCESS RESTART", async () => {
  // THE THIRD EPHEMERAL HALF. `attach`'s docstring enumerates two things a fresh process does
  // not carry; `ctx.tainted` was a third, and the only one an authorization decision reads.
  // Same journal, same graph, same human decisions — only a process boundary between the
  // tainting write and the charge — and the charge ran.
  //
  // The ceiling is the control built into the test: it is restored (that fix already landed),
  // so process 2 is genuinely at `on`. If taint were also restored the charge must gate; if it
  // is not, `on` lets an irreversible action through, which is the whole defect.
  const shared = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const proc = (): Rig => rig(ANSWER, { store: shared, bus: new InProcessEventBus({ store: shared }), sleep: async () => {} });

  const graph = compileEsc(
    spec({
      nodes: [
        ...spec().nodes.filter((x) => x.id === "gather"),
        { id: n("ask"), type: "human_gate", reads: ["goal"], writes: [], humanGate: { ref: "oversight/g@stable", approval: { approvers: ["u:alice"] } } },
        { id: n("charge"), type: "tool", reads: ["notes"], writes: ["done"], tool: { name: "pay.charge", version: "1.0" }, unhandled: true },
      ],
      edges: [
        { id: e("go"), from: n("gather"), to: n("ask"), kind: "seq" },
        { id: e("go2"), from: n("ask"), to: n("charge"), kind: "seq" },
      ],
    }),
  );

  const first = proc();
  const runId = await first.engine.submit({ graph, inputs: { goal: "x" } });
  await first.engine.deescalate(runId, `run:${runId}`, "on", "watching", { kind: "human", id: "u:alice" });
  const parked = await first.engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", "process 1 parks on the unrelated gate");

  // THE RESTART.
  const second = proc();
  second.engine.attach(runId, graph);
  const gateId = Object.values(parked.gates).find((g) => g.state === "open")!.gateId;
  await second.engine.resolveGate(runId, { gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:alice", via: "console" }, idempotencyKey: "k1" });
  const p = await second.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `the charge must still gate after a restart: ${p.status}`);
  assert.deepEqual(second.ran, [], "and the charge has not happened");
});

test("E8 — TAINT SURVIVES A LAUNDERING HOP through a node that calls no tools", async () => {
  // `#recordEvidence` asked "did this node call tools", but propagation needs "did this node
  // READ tainted data". So every node that is not a tool cleared the bit on everything it
  // wrote, and `function` / `agent`-with-`tools: []` are the ordinary shapes that do it: a
  // normalizer, a summariser. Reproduced running the charge with nothing raised.
  const laundered = spec({
    nodes: [
      ...spec().nodes.filter((x) => x.id === "gather"),
      { id: n("mid"), type: "function", reads: ["notes"], writes: ["verdict"], function: { ref: "function/mid@stable" } },
      { id: n("charge"), type: "tool", reads: ["verdict"], writes: ["done"], tool: { name: "pay.charge", version: "1.0" }, unhandled: true },
    ],
    edges: [
      { id: e("go"), from: n("gather"), to: n("mid"), kind: "seq" },
      { id: e("go2"), from: n("mid"), to: n("charge"), kind: "seq" },
    ],
  });

  const r = rig(ANSWER, { sleep: async () => {} });
  r.functions.register("function/mid@stable", (view) => ({ writes: { verdict: { copied: view.get("notes") } } }));
  const runId = await r.engine.submit({ graph: compileEsc(laundered), inputs: { goal: "x" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "watching", { kind: "human", id: "u:alice" });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `the copy is still untrusted: ${p.status}`);
  assert.deepEqual(r.ran, [], "and the charge has not happened");
});

test("E8 — A TAINTED CHANNEL INTERPOLATED INTO `tool.args` COUNTS AS A READ", async () => {
  // `reads` is not the read set. `#runToolNode` resolves `tool.args` against the WHOLE scope,
  // and `GRAPH004_UNDECLARED_READ` does not cover `tool.args` — so dropping the channel from
  // `reads` and templating it into an argument put the untrusted bytes directly into an
  // irreversible tool's arguments with E8 checking a set that no longer mentioned them.
  const smuggled = spec({
    nodes: [
      ...spec().nodes.filter((x) => x.id === "gather"),
      {
        id: n("charge"),
        type: "tool",
        reads: ["goal"],
        writes: ["done"],
        tool: { name: "pay.charge", version: "1.0", args: { memo: "${notes.text}" } },
        unhandled: true,
      },
    ],
    edges: [{ id: e("go"), from: n("gather"), to: n("charge"), kind: "seq" }],
  });

  const r = rig(ANSWER, { sleep: async () => {} });
  const runId = await r.engine.submit({ graph: compileEsc(smuggled), inputs: { goal: "x" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "watching", { kind: "human", id: "u:alice" });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `an argument is a read: ${p.status}`);
  assert.deepEqual(r.ran, [], "and the charge has not happened");
});

test("E8 — an UNTAINTED irreversible action still honours the de-escalation", async () => {
  // The control, and the reason the fix is at the ceiling rather than a blanket `in`. The
  // same node, the same class, the same lowered ceiling — reading an INPUT channel no tool
  // wrote. Nothing untrusted is in play, so "let this run on-the-loop" still means what the
  // human said it meant. Without this, the fix would read as "irreversible always gates" and
  // would have deleted de-escalation for the case it exists for.
  const clean = spec({
    nodes: [
      { id: n("charge"), type: "tool", reads: ["goal"], writes: ["done"], tool: { name: "pay.charge", version: "1.0" }, unhandled: true },
    ],
    edges: [],
  });

  // `sleep` injected: an untainted `irreversible` action at `on` takes a real intervention
  // hold, and this file is not the place to spend five seconds proving the clock works.
  const r = rig(ANSWER, { sleep: async () => {} });
  const runId = await r.engine.submit({ graph: compileEsc(clean), inputs: { goal: "x" } });
  await r.engine.deescalate(runId, `run:${runId}`, "on", "watching this one myself", {
    kind: "human",
    id: "u:alice",
  });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", `${p.status}: ${JSON.stringify(p.error ?? {})}`);
  assert.deepEqual(r.ran, ["pay.charge"], "the charge runs under the human's watch");
  assert.deepEqual((await escalations(r.store, runId)).filter((x) => x === "taint"), [], "and E8 stays silent");
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
        join: { branches: [n("flaky")], mode: "all", onBranchError: "skip" },
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
  const hit = fired.find((f) => f === "repeated_failure");
  assert.ok(hit, fired.join(", "));
  assert.match(await detailOf(r.store, runId, "repeated_failure"), /"streak":3/);
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
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f === "repeated_failure"), []);
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
  assert.ok(fired.some((f) => f === "low_confidence"), fired.join(", "));
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
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f === "low_confidence"), []);
});

test("E2 — crossing 80% of the budget escalates ONCE", async () => {
  // A rule that re-escalated on every reservation past the line would flood the journal
  // with a fact that has not changed — and `max` makes the repeats no-ops anyway.
  const r = rig(ANSWER, { policy: { granted: CAPS, systemFloor: "out", budget: { runUsd: 0.00125 } } });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const fired = (await escalations(r.store, runId)).filter((f) => f === "budget_warning");
  assert.equal(fired.length, 1, `expected exactly one warning, got ${fired.length}`);
  assert.match(await detailOf(r.store, runId, "budget_warning"), /"remainingUsd"/, "the journal says how much is left, which is what an operator acts on");
});

test("E3 — `onBudgetExhausted: \"gate\"` IS A COMPILE ERROR, because it never gated", () => {
  // THIS TEST USED TO ASSERT THE ILLUSION. It was called "an exhausted budget GATES when the
  // graph asked it to" and its message read "'stop, this is expensive' and 'stop' are different
  // answers" — and it checked only that an ESCALATION EVENT fired. It never checked that a gate
  // was raised or that the run parked, and neither happened: the engine escalated the ceiling
  // for decisions this run would never make, then returned `failed` exactly as `fail` does.
  //
  // A word that promises a human and delivers a failure is the "looks supervised, is not" shape
  // this repo refuses at compile everywhere else, so it is refused here too. Implementing it
  // needs somewhere for the human's answer to GO — a way to raise a budget mid-run — and no such
  // API exists.
  const gating = spec({ policy: { posture: "out", budget: { costUsd: 1 }, capabilities: CAPS, onBudgetExhausted: "gate" } });
  const r = compile({ spec: gating, resolver: resolver(), tools: TOOLS, tenantCapabilities: CAPS });
  assert.equal(r.ok, false, "a graph asking for a budget gate must not compile");
  assert.ok(
    (r.diagnostics ?? []).some((x) => x.code === "GRAPH003_BUDGET_ACTION_UNSUPPORTED"),
    (r.diagnostics ?? []).map((x) => x.code).join(", "),
  );

  // `degrade` is the same: read by nothing at all.
  const degrading = spec({ policy: { posture: "out", budget: { costUsd: 1 }, capabilities: CAPS, onBudgetExhausted: "degrade" } });
  assert.equal(compile({ spec: degrading, resolver: resolver(), tools: TOOLS, tenantCapabilities: CAPS }).ok, false);

  // And the one that IS built still compiles.
  const failing = spec({ policy: { posture: "out", budget: { costUsd: 1 }, capabilities: CAPS, onBudgetExhausted: "fail" } });
  assert.equal(compile({ spec: failing, resolver: resolver(), tools: TOOLS, tenantCapabilities: CAPS }).ok, true);
});

test("E3 — the default is to FAIL, not to gate", async () => {
  const r = rig(ANSWER, { policy: { granted: CAPS, systemFloor: "out", budget: { runUsd: 0.000001 } } });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.deepEqual((await escalations(r.store, runId)).filter((f) => f === "budget_exhausted"), []);
});

test("a rule that fires twice escalates once — `max` makes repeats no-ops", async () => {
  const sequences = new InMemorySequenceIndex();
  const r = rig(ANSWER, { sequences });
  const runId = await r.engine.submit({ graph: compileEsc(), inputs: { goal: "x" } });
  await r.engine.advance(runId);

  const events: JournalEvent[] = [];
  for await (const ev of r.store.read(runId, 1)) events.push(ev);
  const novel = events.filter((ev) => ev.type === "policy.escalated" && String((ev.payload as { rule: string }).rule) === "novel_sequence");
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

test("E8 — TAINT SURVIVES A RESTART FOR AN EXTERNALISED CHANNEL TOO", async () => {
  // THE SIXTH MEMBER, and it is not a new counter — it is the same counter losing its input
  // because the payload shape changed underneath it. Payload externalisation moves a channel
  // value over 64 KiB out of `task.committed.writes` and leaves a `PayloadRef` under the same
  // name in `.external`. `#restoreEvidence` folded `writes` alone, so a restart rebuilt the
  // taint set WITHOUT the externalised channel — and the charge ran under a human
  // de-escalation with no gate and no escalation.
  //
  // The sibling above passes and could not catch this: its `notes` is small, so nothing is
  // externalised and `writes` still carries the channel. The size IS the test.
  const shared = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const payloads = memoryPayloads();
  const proc = (): Rig =>
    rig(BIG_ANSWER, { store: shared, bus: new InProcessEventBus({ store: shared }), sleep: async () => {}, payloads });

  const graph = compileEsc(
    spec({
      nodes: [
        ...spec().nodes.filter((x) => x.id === "gather"),
        { id: n("ask"), type: "human_gate", reads: ["goal"], writes: [], humanGate: { ref: "oversight/g@stable", approval: { approvers: ["u:alice"] } } },
        { id: n("charge"), type: "tool", reads: ["notes"], writes: ["done"], tool: { name: "pay.charge", version: "1.0" }, unhandled: true },
      ],
      edges: [
        { id: e("go"), from: n("gather"), to: n("ask"), kind: "seq" },
        { id: e("go2"), from: n("ask"), to: n("charge"), kind: "seq" },
      ],
    }),
  );

  const first = proc();
  const runId = await first.engine.submit({ graph, inputs: { goal: "x" } });
  await first.engine.deescalate(runId, `run:${runId}`, "on", "watching", { kind: "human", id: "u:alice" });
  const parked = await first.engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", "process 1 parks on the unrelated gate");

  // PRECONDITION: the channel really was externalised, or this test is the sibling above
  // wearing a longer name.
  const beforeRestart = await first.engine.projection(runId);
  assert.ok(beforeRestart?.external["notes"] !== undefined, "precondition: `notes` must be externalised");

  const second = proc();
  second.engine.attach(runId, graph);
  const gateId = Object.values(parked.gates).find((g) => g.state === "open")!.gateId;
  await second.engine.resolveGate(runId, { gateId, decision: { kind: "approve" }, actor: { kind: "human", subject: "u:alice", via: "console" }, idempotencyKey: "k1" });
  const p = await second.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", `the charge must still gate after a restart: ${p.status}`);
  assert.deepEqual(second.ran, [], "and the charge has not happened");
});
