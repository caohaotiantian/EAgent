/**
 * Dynamic graph mutation (D5.7).
 *
 * The claim under test: an agent may GROW the graph it is running in, and every way
 * that could go wrong is a compile error rather than a runtime surprise. Proposal and
 * execution are separated by the same compiler that validated the authored graph, so a
 * model can be wrong without being dangerous.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { compileMutation, descendantsOf, type GraphMutation } from "../../src/graph/mutate.ts";
import type { EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { EdgeId, NodeId, TaskId } from "../../src/ids.ts";
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
import { resolver } from "../run/skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

const TOOLS: Record<string, ToolManifestLite> = {
  "note.append": {
    name: "note.append",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
  },
  "email.send": {
    name: "email.send",
    version: "1.0",
    capabilities: ["net:send"],
    irreversibility: "externally_visible",
    idempotent: false,
  },
};

const CAPS = ["fs:write", "net:send", "graph:mutate"];

/**
 * A two-node graph whose planner may grow it.
 *
 * Deliberately minimal: the interesting behaviour is entirely in what the mutation is
 * and is not allowed to do, so anything else in the graph is noise.
 */
function baseSpec(over: Partial<GraphSpec> = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "growable", project: "demo", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
      capabilities: CAPS,
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      plan: { type: "object", reduce: "replace" },
      detail: { type: "string", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["plan"],
    nodes: [
      {
        id: n("plan"),
        type: "agent",
        reads: ["goal"],
        writes: ["plan"],
        agent: {
          profile: "agent_profile/planner@stable",
          prompt: "prompt/plan@stable",
          maxTurns: 2,
          canMutate: true,
          outputSchema: { type: "object" },
        },
      },
    ],
    edges: [],
    ...over,
  };
}

const compileBase = (spec: GraphSpec = baseSpec()): RunGraph =>
  compileOrThrow({ spec, resolver: resolver(), tools: TOOLS, tenantCapabilities: CAPS });

/** A well-formed mutation: one new function node, wired from the proposer. */
const ADD_DETAIL: { addNodes: NodeSpec[]; addEdges: EdgeSpec[] } = {
  addNodes: [
    {
      id: n("detail"),
      type: "function",
      reads: ["plan"],
      writes: ["detail"],
      function: { ref: "function/detail@stable" },
    },
  ],
  addEdges: [{ id: e("m0"), from: n("plan"), to: n("detail"), kind: "seq" }],
};

function mutation(over: Partial<GraphMutation> = {}): GraphMutation {
  return {
    ...ADD_DETAIL,
    proposedBy: "plan@root#0" as TaskId,
    proposedByNode: n("plan"),
    ...over,
  };
}

const mutate = (m: GraphMutation, base: RunGraph = compileBase(), consumedNodes = 0) =>
  compileMutation({
    base,
    mutation: m,
    budget: { consumedNodes, expansion: base.expansion },
    resolver: resolver(),
    tools: TOOLS,
    tenantCapabilities: CAPS,
  });

// ── the happy path ───────────────────────────────────────────────────────────

test("a well-formed mutation compiles to a successor graph with a NEW hash", () => {
  const base = compileBase();
  const r = mutate(mutation(), base);
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  assert.notEqual(r.graph.graphHash, base.graphHash, "a changed graph is a changed hash; traces depend on it");
  assert.deepEqual(r.addedNodes, ["detail"]);
  assert.ok(r.graph.plans["detail" as NodeId], "the added node has a compiled plan like any other");
});

test("the successor graph is derived by the SAME compiler, so plans are real", () => {
  const r = mutate(mutation());
  assert.ok(r.ok);
  // `criticalPathLength` is compile-derived. If mutation took a shortcut and hand-built
  // a graph, this would be missing or wrong, and scheduling order would silently drift.
  assert.equal(r.graph.plans["plan" as NodeId]?.criticalPathLength, 2);
  assert.equal(r.graph.plans["detail" as NodeId]?.criticalPathLength, 1);
});

// ── additive only ────────────────────────────────────────────────────────────

test("a mutation may not redefine an existing node", () => {
  const r = mutate(
    mutation({
      addNodes: [{ ...ADD_DETAIL.addNodes[0]!, id: n("plan") }],
      addEdges: [],
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.diagnostics.some((d) => d.code === "MUT001_NOT_ADDITIVE"));
});

test("a mutation may not redefine an existing edge", () => {
  const base = compileBase(
    baseSpec({
      nodes: [
        ...baseSpec().nodes,
        { id: n("after"), type: "function", reads: ["plan"], function: { ref: "function/x@stable" } },
      ],
      edges: [{ id: e("k"), from: n("plan"), to: n("after"), kind: "seq" }],
    }),
  );
  const r = mutate(
    mutation({ addEdges: [{ id: e("k"), from: n("plan"), to: n("detail"), kind: "seq" }] }),
    base,
  );
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.diagnostics.some((d) => d.code === "MUT001_NOT_ADDITIVE"));
});

test("a mutation may not invent a channel", () => {
  // Channels are part of what the compiled graph promised. A new one has no reducer
  // agreed in advance, so downstream folds would be guessing.
  const r = mutate(
    mutation({ addNodes: [{ ...ADD_DETAIL.addNodes[0]!, writes: ["ghost"] }] }),
  );
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.diagnostics.some((d) => d.code === "MUT002_NEW_CHANNEL"));
});

test("a mutation may not rewire two nodes that already exist", () => {
  const base = compileBase(
    baseSpec({
      nodes: [
        ...baseSpec().nodes,
        { id: n("other"), type: "function", reads: ["plan"], function: { ref: "function/x@stable" } },
      ],
    }),
  );
  const r = mutate(
    mutation({ addNodes: [], addEdges: [{ id: e("m9"), from: n("plan"), to: n("other"), kind: "seq" }] }),
    base,
  );
  assert.equal(r.ok, false);
  assert.ok(r.ok || r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED"));
});

test("added work must hang off the PROPOSER, not off some unrelated node", () => {
  const base = compileBase(
    baseSpec({
      nodes: [
        ...baseSpec().nodes,
        { id: n("elsewhere"), type: "function", reads: ["plan"], function: { ref: "function/x@stable" } },
      ],
    }),
  );
  const r = mutate(
    mutation({ addEdges: [{ id: e("m0"), from: n("elsewhere"), to: n("detail"), kind: "seq" }] }),
    base,
  );
  assert.equal(r.ok, false);
  assert.ok(
    r.ok || r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED"),
    "grafting onto a node that may have ALREADY RUN would change what its journal entries mean",
  );
});

// ── the budget ───────────────────────────────────────────────────────────────

test("the expansion budget is cumulative across mutations, not per mutation", () => {
  const base = compileBase();
  assert.equal(mutate(mutation(), base, 7).ok, true, "7 + 1 = 8, exactly at the ceiling");
  const over = mutate(mutation(), base, 8);
  assert.equal(over.ok, false);
  assert.ok(over.ok || over.diagnostics.some((d) => d.code === "MUT004_EXPANSION_EXHAUSTED"));
});

// ── what the compiler refuses ────────────────────────────────────────────────

test("a mutation cannot weaken oversight anywhere in the running graph", () => {
  // The baseline is the RUNNING graph's own postures, so this is the same GRAPH014 a
  // proposed candidate hits — there is no second, weaker rule for runtime.
  const base = compileBase(baseSpec({ policy: { ...baseSpec().policy, posture: "in" } }));
  const r = compileMutation({
    base,
    mutation: mutation(),
    budget: { consumedNodes: 0, expansion: base.expansion },
    resolver: resolver(),
    tools: TOOLS,
    tenantCapabilities: CAPS,
    // The added node compiles at `out` unless the graph floor lifts it; simulating a
    // lower floor is what a loosening mutation would effectively achieve.
    systemPostureFloor: "out",
  });
  // `detail` is new, so it has no baseline; `plan` does, and must not drop.
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  assert.equal(r.graph.plans["plan" as NodeId]?.posture, "in", "the existing node keeps its posture");
});

test("a mutation proposing an unbounded fan-out is rejected by the ordinary rules", () => {
  const r = mutate(
    mutation({
      addNodes: [{ ...ADD_DETAIL.addNodes[0]!, reads: ["detail"] }],
      addEdges: [{ id: e("m0"), from: n("plan"), to: n("detail"), kind: "fanout", over: "plan", as: "detail" }],
    }),
  );
  assert.equal(r.ok, false, "no maxWidth ⇒ GRAPH007, exactly as at author time");
});

// ── the gate on newly-added irreversibility ──────────────────────────────────

test("a mutation that adds an irreversible node names it as needing a gate", () => {
  const r = mutate(
    mutation({
      addNodes: [
        {
          id: n("notify"),
          type: "tool",
          reads: ["plan"],
          tool: { name: "email.send", version: "1.0", args: { to: "a@b.c" } },
          unhandled: true,
        },
      ],
      addEdges: [{ id: e("m0"), from: n("plan"), to: n("notify"), kind: "seq" }],
    }),
  );
  assert.ok(r.ok, r.ok ? "" : r.error.message);
  assert.equal(r.requiresGate, true);
  assert.deepEqual(r.gatedNodes, ["notify"], "the run did not become riskier — one new node did");
});

test("a mutation adding only reversible work needs no gate", () => {
  const r = mutate(mutation());
  assert.ok(r.ok);
  assert.equal(r.requiresGate, false);
});

test("A CLASS THE VOCABULARY CANNOT READ GATES — the unreadable case is the strongest, not the weakest", () => {
  // This gate read `=== "irreversible" || === "externally_visible"` — a positive list, so a
  // class this binary cannot parse matched neither name and fell through as EASY. Measured
  // before the fix, one mutation adding one tool node: `nuclear`, `REVERSIBLE_WRITE` and `""`
  // all came back `requiresGate: false, gatedNodes: []`, while the two spelled correctly gated.
  // A misspelled class was strictly LESS protected than a correct one, which is the inversion
  // `isHardToUndo`'s docstring records; that predicate now lives in `vocab.ts` and this is one
  // of its four callers.
  const tools = (cls: string): Record<string, ToolManifestLite> => ({
    ...TOOLS,
    "odd.act": { name: "odd.act", version: "1.0", capabilities: ["net:send"], irreversibility: cls as never, idempotent: false },
  });
  const gate = (cls: string) =>
    compileMutation({
      base: compileBase(),
      mutation: mutation({
        addNodes: [
          { id: n("odd"), type: "tool", reads: ["plan"], tool: { name: "odd.act", version: "1.0", args: {} }, unhandled: true },
        ],
        addEdges: [{ id: e("m0"), from: n("plan"), to: n("odd"), kind: "seq" }],
      }),
      budget: { consumedNodes: 0, expansion: compileBase().expansion },
      resolver: resolver(),
      tools: tools(cls),
      tenantCapabilities: CAPS,
    });

  for (const cls of ["irreversible", "externally_visible", "nuclear", "REVERSIBLE_WRITE", ""]) {
    const r = gate(cls);
    assert.ok(r.ok, r.ok ? "" : r.error.message);
    assert.equal(r.requiresGate, true, `irreversibility ${JSON.stringify(cls)} must gate`);
    assert.deepEqual(r.gatedNodes, ["odd"]);
  }
  // And the two that must NOT gate, so this does not pass by gating everything.
  for (const cls of ["read_only", "reversible_write"]) {
    const r = gate(cls);
    assert.ok(r.ok);
    assert.equal(r.requiresGate, false, `${cls} is easy to undo and must not gate`);
  }
});

// ── the region helper ────────────────────────────────────────────────────────

test("descendantsOf walks the whole reachable region, cycles included", () => {
  const spec = baseSpec({
    nodes: [
      ...baseSpec().nodes,
      { id: n("a"), type: "function", reads: ["plan"], function: { ref: "function/x@stable" } },
      { id: n("b"), type: "function", reads: ["plan"], function: { ref: "function/x@stable" } },
    ],
    edges: [
      { id: e("x1"), from: n("plan"), to: n("a"), kind: "seq" },
      { id: e("x2"), from: n("a"), to: n("b"), kind: "seq" },
      { id: e("x3"), from: n("b"), to: n("a"), kind: "loop", until: "true", maxIterations: 2 },
    ],
  });
  assert.deepEqual([...descendantsOf(spec, n("plan"))].sort(), ["a", "b"]);
});

// ── end to end, through the engine ───────────────────────────────────────────

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly ran: string[];
  readonly models: MockModelAdapter;
}

function rig(script: MockScript, opts: { granted?: string[]; store?: MemoryStateStore; resolver?: ResourceResolver } = {}): Rig {
  const now = (): number => 1_700_000_000_000;
  const store = opts.store ?? new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();
  const ran: string[] = [];

  const email: ToolDefinition = {
    ...TOOLS["email.send"]!,
    description: "Send an email.",
    parameters: { type: "object", properties: { to: { type: "string" } } },
    execute: () => {
      ran.push("email.send");
      return { content: "sent" };
    },
  };
  tools.register(email);

  functions.register("function/detail@stable", () => {
    ran.push("detail");
    return { writes: { detail: "elaborated" } };
  });

  const adapter = new MockModelAdapter({ script, pricePerMTok: 1 });
  models.register(adapter, true);

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions,
    models,
    now,
    resolver: opts.resolver ?? resolver(),
    policy: { granted: opts.granted ?? CAPS, systemFloor: "out" },
  });
  return { engine, store, ran, models: adapter };
}

/** A planner that proposes a hard-to-undo node — the case that must gate. */
const IRREVERSIBLE_PROPOSER: MockScript = () => ({
  text: JSON.stringify({
    plan: {},
    mutation: {
      addNodes: [
        {
          id: "notify",
          type: "tool",
          reads: ["plan"],
          tool: { name: "email.send", version: "1.0", args: { to: "a@b.c" } },
          unhandled: true,
        },
      ],
      addEdges: [{ id: "m0", from: "plan", to: "notify", kind: "seq" }],
    },
  }),
  finishReason: "stop",
});

/** A planner that proposes `ADD_DETAIL` on its first (and only) turn. */
const PROPOSER: MockScript = () => ({
  text: JSON.stringify({ plan: { ok: true }, mutation: ADD_DETAIL }),
  finishReason: "stop",
});

test("an agent grows the graph mid-run, and the node it added actually runs", async () => {
  const r = rig(PROPOSER);
  const runId = await r.engine.submit({ graph: compileBase(), inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.ran, ["detail"], "the proposed node was scheduled and executed");
  assert.equal(p.channels["detail"], "elaborated");
});

test("the mutation is journaled with the full spec, so the change is auditable", async () => {
  const r = rig(PROPOSER);
  const runId = await r.engine.submit({ graph: compileBase(), inputs: { goal: "grow" } });
  await r.engine.advance(runId);

  const events = [];
  for await (const ev of r.store.read(runId, 1)) events.push(ev);
  const m = events.find((ev) => ev.type === "graph.mutated");
  assert.ok(m, "a graph that changed shape without an event is a graph nobody can audit");

  const payload = m.payload as unknown as {
    parentHash: string;
    newHash: string;
    nodes: NodeSpec[];
    proposedByNode: string;
  };
  assert.notEqual(payload.parentHash, payload.newHash);
  assert.equal(payload.nodes[0]?.id, "detail", "the SPEC is recorded, not just the id");
  assert.equal(payload.proposedByNode, "plan");
});

test("the projection follows the new graph hash", async () => {
  const r = rig(PROPOSER);
  const base = compileBase();
  const runId = await r.engine.submit({ graph: base, inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);
  assert.notEqual(p.graphHash, base.graphHash, "a trace checked against the authored hash would be wrong");
});

test("a run that restarts mid-flight rebuilds its mutated graph FROM THE JOURNAL", async () => {
  // The durability claim, proven where it bites: the run suspends AFTER mutating, and a
  // fresh process re-attaches the AUTHORED graph — the only thing on disk. If the
  // successor were not rebuilt from events, `notify` would not exist in the graph the
  // second engine schedules from, and the approved work would silently never run.
  const first = rig(IRREVERSIBLE_PROPOSER);
  const runId = await first.engine.submit({ graph: compileBase(), inputs: { goal: "grow" } });
  let p = await first.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  assert.equal(first.ran.length, 0);

  const second = rig(IRREVERSIBLE_PROPOSER, { store: first.store });
  second.engine.attach(runId, compileBase());

  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await second.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(second.ran, ["email.send"], "a node that exists ONLY in the successor graph ran");
  assert.notEqual(p.graphHash, compileBase().graphHash);
});

test("A MUTATION INHERITS WHAT THE RUN ALREADY FROZE, and only ADDS to it", async () => {
  // The mutated path was the one place a run still re-resolved content mid-flight.
  // `#applyMutation` recompiles from inside the executing Task that proposed the change, and
  // `#rehydrateGraph` recompiles when a process picks up a run behind its own history — both
  // with the live resolver, so a
  // promotion between the run's compile and its mutation swapped the prompt or the child
  // underneath it. That is the swap A22 and A24 closed everywhere else.
  //
  // The resolver here changes its answer the moment the run starts: whatever the graph compiled
  // against, every LATER lookup returns "PROMOTED". If the mutation re-resolved, the agent's
  // own prompt would change under it.
  // The property is observable directly: after the run's own compile, a recompile must not ASK
  // the live store about a ref the run already froze. Counting the lookups is the assertion —
  // asserting on the original graph object would prove nothing, since it cannot change.
  // A STORE-SHAPED RESOLVER: per-ref digests, and the digest MOVES when the content does —
  // which is what `ResourceStore` actually does (`digest({kind, name, content})`). A fixture
  // that gives every ref one constant digest cannot show this defect at all, and the first
  // version of this test used one.
  let promoted = false;
  const pin = (ref: string, text: string): `sha256:${string}` => `sha256:${Buffer.from(`${ref}:${text}`).toString("hex").padEnd(64, "0").slice(0, 64)}` as `sha256:${string}`;
  const textFor = (ref: string): string => (promoted && ref === "prompt/plan@stable" ? "PROMOTED" : `doc for ${ref}`);
  const asked: string[] = [];
  let counting = false;
  const shifting: ResourceResolver = {
    resolve: (ref) => {
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      return { ref, digest: pin(ref, textFor(ref)), channel: "stable" };
    },
    document: (pinned) => {
      if (counting) asked.push(pinned);
      for (const ref of ["agent_profile/planner@stable", "prompt/plan@stable", "function/detail@stable"]) {
        if (pin(ref, textFor(ref)) === pinned) return textFor(ref);
      }
      return undefined;
    },
  };

  const r = rig(PROPOSER, { resolver: shifting });
  const graph = compileOrThrow({ spec: baseSpec(), resolver: shifting, tools: TOOLS, tenantCapabilities: CAPS });
  assert.equal(graph.documents["prompt/plan@stable"], "doc for prompt/plan@stable", "the run froze the original");

  // PROMOTED between the run's compile and its mutation. A digest is over CONTENT, so this
  // moves the pin — which is exactly why freezing only `document` was not enough: `resolve`
  // came back with the NEW digest, the frozen map missed, and the live fallback served the
  // promoted bytes to a node that already existed.
  promoted = true;
  counting = true;
  const runId = await r.engine.submit({ graph, inputs: { seed: "go" } });
  const p = await r.engine.advance(runId);
  assert.notEqual(p.status, "failed", JSON.stringify(p.error ?? {}));

  const after = (await r.engine.projection(runId))!;
  assert.notEqual(after.graphHash, graph.graphHash, "the graph really did mutate");

  // THE PROMOTED BYTES REACHED NOBODY. Counting lookups is not enough on its own — the point
  // is which TEXT the already-compiled node ends up with.
  const systems = r.models.seen.map((req) => String(req.system));
  assert.equal(
    systems.some((x) => x.includes("PROMOTED")),
    false,
    `a node compiled before the promotion was sent the promoted prompt: ${JSON.stringify(systems)}`,
  );
  // AND THE ADDITIVE HALF IS EXERCISED, which the first version of this test could not show:
  // its fixture gave every ref one constant digest, so the genuinely NEW ref hit the frozen map
  // too and the live fallback the whole design rests on was never called. Deleting it kept the
  // suite green. Here the mutation's own `function/detail@stable` is the only thing asked live.
  assert.deepEqual(asked, [pin("function/detail@stable", "doc for function/detail@stable")], "only the ref the mutation ADDED");

  // THE REHYDRATE SITE IS NOT COVERED HERE, and saying so beats a test that cannot fail.
  // `#rehydrateGraph` recompiles only when the in-memory graph is BEHIND the journal — a second
  // process attaching a run that already mutated — and its effect is observable only through
  // what a LATER node is sent. This fixture's run reaches `succeeded` on the first `advance`,
  // so a re-attach does no work: an assertion there passed with the site reverted. Covering it
  // needs a mutating graph that parks (a gate) and resumes, which this file has no fixture for.
});

test("a node that did not declare canMutate cannot grant itself the power", async () => {
  const spec = baseSpec();
  const noMutate: GraphSpec = {
    ...spec,
    nodes: spec.nodes.map((x) => ({ ...x, agent: { ...x.agent!, canMutate: false } })),
  };
  const r = rig(PROPOSER);
  const runId = await r.engine.submit({ graph: compileBase(noMutate), inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "succeeded");
  assert.deepEqual(r.ran, [], "emitting the right JSON shape is not authorisation");
});

test("without the graph:mutate capability the proposal fails the task, loudly", async () => {
  const r = rig(PROPOSER, { granted: ["fs:write", "net:send"] });
  const runId = await r.engine.submit({ graph: compileBase(), inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.equal(p.error?.code, "E_CAP_DENIED");
  assert.deepEqual(r.ran, []);
});

test("an invalid proposal fails the proposing task rather than corrupting the run", async () => {
  const r = rig(() => ({
    text: JSON.stringify({
      plan: {},
      mutation: { addNodes: [{ ...ADD_DETAIL.addNodes[0], writes: ["ghost"] }], addEdges: ADD_DETAIL.addEdges },
    }),
    finishReason: "stop",
  }));
  const runId = await r.engine.submit({ graph: compileBase(), inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "failed");
  assert.deepEqual(r.ran, []);
  const failed = Object.values(p.tasks).filter((t) => t.state === "failed");
  assert.equal(failed.length, 1, "exactly the proposer failed");
});

test("a mutation that adds an irreversible node forces a gate before it runs", async () => {
  const r = rig(IRREVERSIBLE_PROPOSER);
  const runId = await r.engine.submit({ graph: compileBase(), inputs: { goal: "grow" } });
  const p = await r.engine.advance(runId);

  assert.equal(p.status, "awaiting_gate", "a graph that GREW a send-email step stops for a human");
  assert.deepEqual(r.ran, [], "and the send has not happened yet");

  // AND THE HUMAN CAN ACTUALLY ANSWER IT. This test used to park here and stop, which is how a
  // regression hid: `#assertBound` compared the attached graph against `run.compiled.graphHash`,
  // while `#applyMutation` had already REPLACED `ctx.graph` with the successor — so after any
  // mutation the two could never agree and approve was impossible forever. The designed flow is
  // exactly this one: a mutation introduces an irreversible node and gates it. The run was
  // wedged, exitable only by cancel. Caught by a reviewer, in one process, with no attack.
  const open = await r.engine.openGates(runId);
  assert.equal(open.length, 1, "one gate to answer");
  const after = await r.engine.resolveGate(runId, {
    gateId: open[0]!.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "approve-the-mutation",
  });
  assert.notEqual(after.status, "awaiting_gate", `the gate must be answerable: ${JSON.stringify(after.error ?? {})}`);
  assert.deepEqual(r.ran, ["email.send"], "and the irreversible tool the mutation added is what ran");
});
