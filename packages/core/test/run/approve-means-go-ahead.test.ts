/**
 * APPROVE MEANS "GO AHEAD", NOT "CONSIDER IT DONE" — named by the type system, not by a count.
 *
 * The property the whole oversight layer is pitched on: on every node type except the gate
 * itself there is WORK BEHIND THE GATE, and an approval releases that work rather than standing
 * in for it. Treating approval as completion would report success for an action that never
 * happened — silently, in exactly the place oversight exists for. `run/engine.ts` decides it in
 * one branch (`node.type === "human_gate" || settled.decision !== "approve"` short-circuits to
 * `#applyGateDecision`; everything else falls through to `#approvalStillCovers` and `#dispatch`)
 * and explains itself in a comment above that branch.
 *
 * A COMMENT AND A COUNT WERE THE WHOLE DEFENCE. `TODO.md` F.12 carried the property with the
 * note "COUNT REFRESHED: NodeType has 8 members" — true on the day somebody counted, and
 * CLAUDE.md says in its own words how that device fails: a pointer to an enumeration is only as
 * good as the enumeration's own discipline about growing. The journal-violation count stayed at
 * five for as long as the sixth member lived in a file the pointer did not name.
 *
 * SO THE SET IS NAMED BY THE TYPE SYSTEM. `CASES` is a `Record<NodeType, Case>`, `NodeType` is
 * imported from `graph/spec.ts`, and a ninth member is a COMPILE ERROR in this file rather than
 * an uncovered path. Nothing here skips a member it does not recognise, and the key set is
 * checked a second time against the union parsed out of `spec.ts`, so widening `NodeType` to
 * `string` — which would silently un-constrain the `Record` — fails too.
 *
 * WHAT EACH CASE ASSERTS. One graph per node type, its `target` node gated (`policy.posture:
 * "in"`; a `human_gate` node is its own gate), driven to `awaiting_gate`, approved, and then
 * asked for the journaled record of the node's work. The evidence differs per type because the
 * work does, and it is checked TWICE: absent in the target task's events before the approval,
 * present after. Without the "before" half a case would pass on work that had already happened,
 * which is the tautology F.4 warns about.
 *
 *   function, evaluator  a committed write whose VALUE could only come from running the body
 *                        (it echoes the input channel), not from a constant.
 *   agent, tool,         `effect.started` of the node's own kind, plus the effect's own record
 *   subgraph             (`model.called` / `tool.called` / `subgraph.started`).
 *   router               `take: ["hit"]` — ONE of two outbound edges, the one its expression
 *                        selects. This is the discriminator, measured: gate COMPLETION activates
 *                        every outbound edge, which the `human_gate` case below shows as
 *                        `["ga", "gb"]`, and the router's declared `fallbackEdge` is the other
 *                        one. So neither "approval completed it" nor "it did not evaluate"
 *                        produces `["hit"]`.
 *   join                 the fold. A join has NO BODY — `#dispatchBody` returns an empty outcome
 *                        for it and `#foldJoin` does the work at commit — so what is pinned is
 *                        that the fold frame (`state.reduced`, `branchCount: 2`, the branch
 *                        channel) lands AFTER the approval and not before it. Stated plainly
 *                        because it is the weakest evidence in the table, and the mutation
 *                        below measures exactly how weak: it shows the join's work was still
 *                        pending at the gate, not that a dispatch produced it.
 *   human_gate           the exception, asserted from the other side — see below.
 *
 * AND THE TWO DOCUMENTED EXCLUSIONS from `#approvalStillCovers` are pinned beside it, read out
 * of `engine.ts` rather than restated, so the set that method names cannot drift unwatched.
 *
 * THE MUTATION, RUN, AND WHAT IT MEASURED. The branch this file exists to defend was flipped to
 * `if (true || node.type === "human_gate" || …)` — approval treated as completion on every node
 * type — and the suite re-run: 6 fail, 4 pass. `function` and `evaluator` fail on
 * `E_OUTPUT_MISSING`, the run reporting `failed` where the approval was supposed to release the
 * body; `agent`, `tool` and `subgraph` fail on the missing effect; `router` fails with both
 * edges taken instead of the one its expression selects.
 *
 * `join` PASSES UNDER THE MUTATION, and that is a fact about the property, not a hole in the
 * test. A join has no body: the fold is at commit, so approval-as-completion and
 * approval-as-go-ahead produce the same journal, and there is no outcome a mutation here could
 * make wrong. The engine's own comment — "every other node type has work behind the gate, and
 * treating approval as completion would report success for an action that never happened" —
 * is therefore load-bearing on SIX types, and on `join` the claim is empty rather than false.
 * The row is kept, and asserts the one thing that is true of it: the fold lands after the
 * approval and not before. `human_gate` passes because it is the exception being pinned.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec, NodeType } from "../../src/graph/spec.ts";
import type { ResourceResolver } from "../../src/graph/validate.ts";
import type { EdgeId, GateId, NodeId, RunId, TaskId } from "../../src/ids.ts";
import { isEvent, type HumanActor, type JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import { resolver, SKELETON_TENANT_CAPS, SKELETON_TOOLS } from "./skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;
const NOW = 1_700_000_000_000;
const alice: HumanActor = { kind: "human", subject: "u:alice", via: "console" };

/** Every graph gates the node called `target`, and nothing else. */
const TARGET = n("target");
/** What puts a work node behind a gate: an in-the-loop posture on the node itself. */
const GATED = { posture: "in" };

const ENGINE_SRC = readFileSync(fileURLToPath(new URL("../../src/run/engine.ts", import.meta.url)), "utf8");
const SPEC_SRC = readFileSync(fileURLToPath(new URL("../../src/graph/spec.ts", import.meta.url)), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// the table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node type, a graph that gates one node of it, and the journaled evidence of its work.
 *
 * The union is what keeps the `human_gate` row from having to invent an `ran` predicate that
 * is always false: its assertion is a different shape, and saying so in the type is cheaper
 * than a boolean nobody can read.
 */
type Case =
  | {
      readonly work: "behind the gate";
      /** What this node type's work IS — the thing an approval releases. */
      readonly what: string;
      readonly spec: GraphSpec;
      readonly inputs: Readonly<Record<string, unknown>>;
      /** Evidence over ONE task's journal events. Must be false before the approval, true after. */
      readonly ran: (evs: readonly JournalEvent[]) => boolean;
    }
  | {
      readonly work: "is the gate";
      readonly what: string;
      readonly spec: GraphSpec;
      readonly inputs: Readonly<Record<string, unknown>>;
    };

/** A graph with one gated `target`, plus whatever else the type needs to be legal. */
function graph(over: {
  name: string;
  channels: Record<string, unknown>;
  inputs: readonly string[];
  outputs: readonly string[];
  nodes: readonly unknown[];
  edges?: readonly unknown[];
  capabilities?: readonly string[];
}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: over.name, project: "approve", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 32, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 },
      ...(over.capabilities === undefined ? {} : { capabilities: over.capabilities }),
    },
    channels: over.channels,
    inputs: over.inputs,
    outputs: over.outputs,
    nodes: over.nodes,
    edges: over.edges ?? [],
  } as unknown as GraphSpec;
}

const SEED = { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } };

/** The child a `subgraph` node delegates to. */
const CHILD: GraphSpec = graph({
  name: "child",
  channels: SEED,
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [{ id: n("echo"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/echo@stable" } }],
});

// Evidence helpers. Every one reads the journal, never the harness's own bookkeeping — a
// side-effect counter in this file would prove the body ran and prove nothing about what a
// later fold, or an operator reading history, can see.
const effectStarted = (evs: readonly JournalEvent[], kind: string): boolean =>
  evs.some((ev) => isEvent(ev, "effect.started") && ev.payload.kind === kind);
const hasType = (evs: readonly JournalEvent[], type: JournalEvent["type"]): boolean => evs.some((ev) => ev.type === type);
const writesOf = (evs: readonly JournalEvent[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const ev of evs) if (isEvent(ev, "task.committed")) Object.assign(out, ev.payload.writes);
  return out;
};
const takesOf = (evs: readonly JournalEvent[]): readonly string[] =>
  evs.flatMap((ev) => (isEvent(ev, "task.committed") ? [...ev.payload.take] : []));
const echoed = (evs: readonly JournalEvent[]): boolean =>
  (writesOf(evs)["out"] as { echoed?: unknown } | undefined)?.echoed === "s";

/**
 * THE SET, AND THE WHOLE SET. `Record<NodeType, Case>` is the mechanism: `NodeType` gaining a
 * ninth member stops this file compiling, which is the only device that survives the schema
 * growing while nobody is looking at this test.
 */
const CASES: Record<NodeType, Case> = {
  function: {
    work: "behind the gate",
    what: "the body runs and its writes are committed",
    inputs: { seed: "s" },
    spec: graph({
      name: "a-function",
      channels: SEED,
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [{ id: TARGET, type: "function", reads: ["seed"], writes: ["out"], policy: GATED, function: { ref: "function/echo@stable" } }],
    }),
    // The body echoes the input channel, so the committed value cannot have come from a
    // constant, a default, or a gate decision's `writes`.
    ran: echoed,
  },

  agent: {
    work: "behind the gate",
    what: "the model is called",
    inputs: { seed: "s" },
    spec: graph({
      name: "an-agent",
      channels: SEED,
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [
        {
          id: TARGET,
          type: "agent",
          reads: ["seed"],
          writes: ["out"],
          policy: GATED,
          agent: { profile: "agent_profile/summarizer@stable", prompt: "prompt/summarize-file@stable", maxTurns: 2 },
        },
      ],
    }),
    ran: (evs) => effectStarted(evs, "model") && hasType(evs, "model.called"),
  },

  tool: {
    work: "behind the gate",
    what: "the tool is invoked",
    inputs: { seed: "s" },
    spec: graph({
      name: "a-tool",
      channels: SEED,
      inputs: ["seed"],
      outputs: ["out"],
      capabilities: ["fs:write"],
      nodes: [
        {
          id: TARGET,
          type: "tool",
          reads: ["seed"],
          writes: ["out"],
          policy: GATED,
          tool: { name: "fs.write", version: "1.0", args: { path: "out/x", body: "${seed}" } },
        },
      ],
    }),
    ran: (evs) => effectStarted(evs, "tool") && hasType(evs, "tool.called"),
  },

  router: {
    work: "behind the gate",
    what: "the expression is evaluated and ONE edge is taken",
    inputs: { seed: "s" },
    spec: graph({
      name: "a-router",
      channels: { ...SEED, other: { type: "object", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [
        {
          id: TARGET,
          type: "router",
          reads: ["seed"],
          policy: GATED,
          // `fallbackEdge` is the OTHER edge on purpose: a router that did not evaluate takes
          // the fallback, and a completed gate takes both. Only evaluation gives `["hit"]`.
          router: { mode: "expression", cases: [{ when: "true", take: [e("hit")] }], fallbackEdge: e("miss") },
        },
        { id: n("taken"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/echo@stable" } },
        { id: n("untaken"), type: "function", reads: ["seed"], writes: ["other"], function: { ref: "function/other@stable" } },
      ],
      edges: [
        { id: e("hit"), from: TARGET, to: n("taken"), kind: "seq" },
        { id: e("miss"), from: TARGET, to: n("untaken"), kind: "seq" },
      ],
    }),
    ran: (evs) => takesOf(evs).join(",") === "hit",
  },

  join: {
    work: "behind the gate",
    what: "the branches are folded",
    inputs: { seeds: ["a", "b"] },
    spec: graph({
      name: "a-join",
      channels: {
        seeds: { type: "array", reduce: "replace" },
        seed: { type: "string", reduce: "replace" },
        parts: { type: "array", reduce: "append_ordered" },
        out: { type: "object", reduce: "replace" },
      },
      inputs: ["seeds"],
      outputs: ["out"],
      nodes: [
        { id: n("start"), type: "function", reads: ["seeds"], function: { ref: "function/passthrough@stable" } },
        { id: n("branch"), type: "function", reads: ["seed"], writes: ["parts"], function: { ref: "function/part@stable" } },
        {
          id: TARGET,
          type: "join",
          reads: ["parts"],
          writes: ["parts"],
          policy: GATED,
          join: { branches: [n("branch")], mode: "all", onBranchError: "fail" },
        },
        { id: n("after"), type: "function", reads: ["parts"], writes: ["out"], function: { ref: "function/echo@stable" } },
      ],
      edges: [
        { id: e("fan"), from: n("start"), to: n("branch"), kind: "fanout", over: "seeds", as: "seed", maxWidth: 4 },
        { id: e("bar"), from: n("branch"), to: TARGET, kind: "join", branches: [n("branch")] },
        { id: e("on"), from: TARGET, to: n("after"), kind: "seq" },
      ],
    }),
    ran: (evs) =>
      evs.some((ev) => isEvent(ev, "state.reduced") && ev.payload.branchCount === 2 && ev.payload.channels.includes("parts")),
  },

  evaluator: {
    work: "behind the gate",
    what: "the assertion body runs and scores",
    inputs: { seed: "s" },
    spec: graph({
      name: "an-evaluator",
      channels: SEED,
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [
        {
          id: TARGET,
          type: "evaluator",
          reads: ["seed"],
          writes: ["out"],
          policy: GATED,
          evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
        },
      ],
    }),
    ran: echoed,
  },

  subgraph: {
    work: "behind the gate",
    what: "the child run is started",
    inputs: { seed: "s" },
    spec: graph({
      name: "a-subgraph",
      channels: SEED,
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [
        {
          id: TARGET,
          type: "subgraph",
          reads: ["seed"],
          writes: ["out"],
          policy: GATED,
          subgraph: { ref: "graph/child@stable", inputs: { seed: "seed" }, outputs: { out: "out" }, budgetShare: 0.5 },
        },
      ],
    }),
    ran: (evs) => effectStarted(evs, "subgraph") && hasType(evs, "subgraph.started"),
  },

  human_gate: {
    work: "is the gate",
    what: "approving IS the completion — nothing is dispatched",
    inputs: { seed: "s" },
    spec: graph({
      name: "a-human-gate",
      channels: { ...SEED, other: { type: "object", reduce: "replace" } },
      inputs: ["seed"],
      outputs: ["out"],
      nodes: [
        // No `policy` block: a `human_gate` node's posture is `in` by definition, which is why
        // `#dispatchBody`'s `human_gate` arm is documented as unreachable.
        { id: TARGET, type: "human_gate", reads: ["seed"], writes: ["out"], humanGate: { ref: "oversight/demo-write@stable" } },
        { id: n("a"), type: "function", reads: ["seed"], writes: ["out"], function: { ref: "function/echo@stable" } },
        { id: n("b"), type: "function", reads: ["seed"], writes: ["other"], function: { ref: "function/other@stable" } },
      ],
      edges: [
        { id: e("ga"), from: TARGET, to: n("a"), kind: "seq" },
        { id: e("gb"), from: TARGET, to: n("b"), kind: "seq" },
      ],
    }),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// the rig
// ─────────────────────────────────────────────────────────────────────────────

interface Driven {
  readonly runId: RunId;
  readonly gateId: GateId;
  /** The gated task's own events, up to the moment the gate was answered. */
  readonly before: readonly JournalEvent[];
  /** …and the ones appended after it. */
  readonly after: readonly JournalEvent[];
  readonly status: string;
  readonly error: unknown;
}

async function drive(c: Case): Promise<Driven> {
  const store = new MemoryStateStore({ now: () => NOW });
  const functions = new FunctionRegistry();
  functions.register("function/passthrough@stable", () => ({}));
  functions.register("function/echo@stable", (view) => ({ writes: { out: { echoed: view.get<string>("seed") } } }));
  functions.register("function/other@stable", () => ({ writes: { other: { ran: true } } }));
  functions.register("function/part@stable", (view) => ({ writes: { parts: [view.get<string>("seed")] } }));
  // An assertion evaluator's ref IS a function body, and `#checkConfidence` reads `confidence`
  // off the write. `echoed` carries the same proof-of-execution the `function` case uses.
  functions.register("function/check@stable", (view) => ({
    writes: { out: { echoed: view.get<string>("seed"), confidence: 0.9 } },
  }));

  const tools = new ToolRegistry();
  const fsWrite: ToolDefinition = {
    ...SKELETON_TOOLS["fs.write"]!,
    description: "Write a file.",
    parameters: { type: "object", properties: { path: { type: "string" }, body: { type: "string" } }, required: ["path", "body"] },
    execute: (args) => ({ content: "ok", writes: { out: { echoed: String(args["body"]) } } }),
  };
  tools.register(fsWrite);

  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: '{"summary":"ran"}', finishReason: "stop" }) }), true);

  // ONE resolver instance for the compile and the run: the skeleton's mints a distinct digest
  // per ref and answers `document` only for pins it minted, so a second instance would hand the
  // agent node a prompt with no document.
  const resources: ResourceResolver = { ...resolver(), subgraph: (ref) => (ref === "graph/child@stable" ? CHILD : undefined) };

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now: () => NOW,
    maxParallelism: 4,
    resolver: resources,
    policy: { granted: SKELETON_TENANT_CAPS, budget: { runUsd: 5 } },
  });

  const compiled = compileOrThrow({
    spec: c.spec,
    resolver: resources,
    tools: SKELETON_TOOLS,
    tenantCapabilities: SKELETON_TENANT_CAPS,
  });

  const runId = await engine.submit({ graph: compiled, inputs: c.inputs });
  const parked = await engine.advance(runId);
  assert.equal(parked.status, "awaiting_gate", `no gate was raised: ${JSON.stringify(parked.error ?? {})}`);

  const open = (await engine.openGates(runId)).filter((g) => g.state === "open");
  assert.equal(open.length, 1, "exactly one gate, on the node under test");
  assert.equal(open[0]!.nodeId, TARGET);

  const taskId = Object.values(parked.tasks).find((t) => t.nodeId === TARGET)!.taskId;
  const before = await eventsFor(store, runId, taskId);
  const settled = await engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: alice,
    idempotencyKey: "k",
  });
  const whole = await eventsFor(store, runId, taskId);

  return {
    runId,
    gateId: open[0]!.gateId,
    before,
    after: whole.slice(before.length),
    status: settled.status,
    error: settled.error,
  };
}

async function eventsFor(store: MemoryStateStore, runId: RunId, taskId: TaskId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1)) if (ev.taskId === taskId) out.push(ev);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · the seven types with work behind the gate
// ─────────────────────────────────────────────────────────────────────────────

for (const [type, c] of Object.entries(CASES) as readonly [NodeType, Case][]) {
  if (c.work !== "behind the gate") continue;

  test(`APPROVING A GATED \`${type}\` NODE RUNS IT — ${c.what}`, async () => {
    const d = await drive(c);

    // The "not consider it done" half. If the evidence were already in the journal at the
    // moment the human answered, the assertion below would prove nothing.
    assert.equal(c.ran(d.before), false, `the work was already journaled BEFORE the approval on a \`${type}\` node`);
    assert.equal(d.status, "succeeded", JSON.stringify(d.error ?? {}));
    assert.equal(c.ran(d.after), true, `an approved \`${type}\` node left no journaled record of ${c.what}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · the one type that is its own approval
// ─────────────────────────────────────────────────────────────────────────────

test("AND APPROVING A `human_gate` NODE COMPLETES IT — nothing is dispatched", async () => {
  const c = CASES.human_gate;
  const d = await drive(c);
  assert.equal(d.status, "succeeded", JSON.stringify(d.error ?? {}));

  // NO SECOND RAISE. `#dispatchBody`'s `human_gate` arm returns `status: "gate"`, so a dispatch
  // here would re-raise the gate it just answered — the loop `#executeTask`'s short-circuit
  // comment names. One raise in the task's whole journal is the proof it never got there.
  const raises = [...d.before, ...d.after].filter((ev) => ev.type === "gate.raised");
  assert.equal(raises.length, 1, "an approved gate node re-raised its own gate");

  // NO WORK. Every other row in the table leaves an `effect.started` or a write; this one must
  // leave neither, because there is no body to run.
  assert.deepEqual(
    d.after.filter((ev) => ev.type === "effect.started").map((ev) => ev.type),
    [],
    "a gate node dispatched an effect",
  );
  assert.deepEqual(writesOf(d.after), {}, "a gate node committed writes of its own");

  // AND THE RUN WENT ON, by every outbound edge. This is the measurement that makes the
  // `router` case's `["hit"]` mean something: completion activates the node's whole fan-out,
  // so a single selected edge cannot be produced by this path.
  assert.deepEqual([...takesOf(d.after)].sort(), ["ga", "gb"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · the table is the schema
// ─────────────────────────────────────────────────────────────────────────────

test("THE TABLE COVERS EVERY `NodeType`, READ FROM `spec.ts` — not a number in a doc", () => {
  // `Record<NodeType, Case>` already refuses a missing member at compile time. This is the
  // second half: it also refuses `NodeType` being WIDENED — to `string`, or to a union with an
  // index signature — which would leave the `Record` satisfied by any table at all.
  const m = /export type NodeType =\n([\s\S]*?);\n/.exec(SPEC_SRC);
  assert.ok(m, "`NodeType` moved or changed shape — this test reads it from the source");
  const declared = [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).sort();

  assert.deepEqual(Object.keys(CASES).sort(), declared, "a node type has no case here, or a case has no node type");
  assert.equal(
    Object.values(CASES).filter((c) => c.work === "is the gate").length,
    1,
    "exactly one node type is its own approval",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · the exclusions `#approvalStillCovers` names
// ─────────────────────────────────────────────────────────────────────────────

test("`#approvalStillCovers` STILL NAMES ITS TWO EXCLUSIONS, and their reasons", () => {
  const m = /DOES THE APPROVAL ON FILE STILL COVER([\s\S]*?)\n   \*\//.exec(ENGINE_SRC);
  assert.ok(m, "`#approvalStillCovers`'s docstring moved — it is the thing being pinned");
  const doc = m[1]!;

  // 1 · a `human_gate` node. Pinned behaviourally by test 2 above as well: approving one
  // completes it, so nothing is dispatched and there is no payload that could have drifted.
  assert.match(doc, /does NOT cover a `human_gate` node \(approving one completes\s+\*\s+it; nothing is dispatched/);
  // 2 · a MIRROR, which returns one branch earlier. Its payload is another run's channel state
  // and cannot be re-derived in this run; the child raises its own gate on the node that
  // actually executes and this same check runs there. Source-pinned only — a mirror needs a
  // suspended child run to exist at all, and `gate-guards.test.ts` drives that path.
  assert.match(doc, /does NOT cover a MIRROR,\s+\*\s+which returns above/);

  // AND THE SET IT CLAIMS TO COVER, so the two lists cannot drift apart in silence. `join` is
  // absent from it, and that is a REPORTED GAP rather than a fact about the code: the branch in
  // `#executeTask` excludes `human_gate` and mirrors and nothing else, and the `join` row above
  // shows a `policy.posture: "in"` join node raising a gate and resuming through it. A join has
  // no body, which is the most likely reason the list was written without it. Pinned as a gap so
  // that closing it is a visible edit here rather than a silent one there.
  const covered = [...(/the policy `gate` effect on([\s\S]*?)nodes\./.exec(doc)?.[1] ?? "").matchAll(/`([a-z_]+)`/g)].map((x) => x[1]!);
  const missing = Object.keys(CASES).filter((t) => !covered.includes(t) && t !== "human_gate");
  assert.deepEqual(missing, ["join"], "the covered set moved — reconcile it with the branch in `#executeTask`");
});
