/**
 * A MUTATION MAY NOT TAKE A NODE OUT OF A HUMAN GATE'S DOMINATED REGION.
 *
 * `mutate.ts` opens with "A model can propose a graph that is wrong; it cannot propose one that
 * weakens oversight". Its region rule refused an added edge only when BOTH endpoints already
 * existed, so the remaining direction — an ADDED `from` into an EXISTING `to` — was accepted
 * with no diagnostic. That edge is a second path to the target, and `seq` edges are OR-joined,
 * so it is a path that skips whatever sat in front of the authored one. Measured end to end,
 * with an authored `human_gate` in front of a `reversible_write` tool and no operator action of
 * any kind:
 *
 *     the authored graph, human REJECTS       -> failed, the tool never ran
 *     one added node + one added edge into it -> failed, and the tool ran anyway
 *
 * The rejection is what RELEASES the action: an open gate suspends the whole run, so the grafted
 * path cannot fire while the human is deciding, and `gate.decided` carries an unconditional
 * `run.resumed`.
 *
 * `reversible_write` and not `irreversible` on purpose. `CLASS_DEFAULT_POSTURE` pins
 * `irreversible` at `in`, so for that class the grafted path still raises the node's own gate and
 * the authored one is the second of two layers. For `read_only` and `reversible_write` the
 * authored gate is the ONLY oversight there is, and that is the case this has to hold for.
 *
 * ## MERGE RESOLUTION, 2026-09-08 — THE PREDICATE IN THE TREE IS NOT THE ONE THIS FILE ARGUES FOR
 *
 * This suite was written against `phase1-taint`'s rule, whose predicate is `carriesOversight`.
 * `loom` closed the same defect independently (wave2-graph, `03b03fb`/`4e5abaa`, merged at
 * `3cfd363`) with a rule that preserves EVERY dominator, plus three things this branch's rule has
 * no answer for: a ceiling past which it refuses rather than running, an outright ban on grafting
 * into a `join` target or a node that reports to one, and an entry-seed that survives a back-edge
 * into the entry node. `loom`'s refusal set is a strict superset of this branch's, so the merge
 * keeps `loom`'s implementation whole and this file's rows follow it. Four rows here asserted an
 * ADMIT that the merged rule refuses; they are kept, inverted, as pins on that accepted cost —
 * the canonical expansion ("also do this lookup, then carry on into the node I already lead to")
 * is refused when it spans anything at all. Making them pass again is a change to the merged
 * rule's predicate and must be argued as one. The end-to-end rows, the attach-time rows and the
 * refusal rows are unchanged and are what this file still uniquely pins.
 *
 * The paragraph below is `phase1-taint`'s argument for the narrower predicate, kept because it is
 * the record of what the narrowing bought and what refusing it costs — not because the tree does
 * what it says.
 *
 * The rule is preservation of the dominators that CARRY OVERSIGHT, and the narrowing is not a
 * detail. Keyed on dominance alone it refused a four-node chain of plain `function` nodes — no
 * gate, no tool, posture `out` — proposing "also do this lookup, then carry on into the node I
 * already lead to", which is the canonical expansion and the shape a mutation exists for. The
 * last test here is that chain; the one before it is the admit half with something actually
 * spanned, replacing a version that rejoined at the proposer's own successor and therefore lost
 * no dominator at all.
 *
 * The end-to-end arm is the one that matters: the compile-level checks that existed covered two
 * of the three edge directions, and covering two of three is how this arrived.
 *
 * ## AND THREE MORE, EACH ONE THE RULE BEING RIGHT AND ITS EDGES BEING WRONG
 *
 *   - THE BAR WAS THE COMPILED POSTURE, so `CLASS_DEFAULT_POSTURE` made every ordinary
 *     `reversible_write` node an unremovable dominator and the canonical expansion was refused in
 *     a graph with no gate and no irreversible action anywhere. The admit test above used only
 *     plain `function` nodes, which is why it passed. The bar is the node TYPE now — a
 *     `human_gate` — which is what the section header argues about throughout.
 *   - THE RULE WAS COMPILE-TIME ONLY. `Engine.#rehydrateGraph` re-applied a RECORDED mutation
 *     with `compile`, which does not run this rule, so a journal already holding a graft resumed
 *     on a newer binary with the human's rejection bypassed. It replays through
 *     `compileMutation` now and refuses the resume.
 *   - ONE GRAFTED EDGE EMITTED ONE DIAGNOSTIC PER DOWNSTREAM NODE — the same sentence restated
 *     once per node in the tail. One per (culprit edge, lost dominator) now, reported at the
 *     shallowest node, which is where the author moves the edge to.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { compileMutation } from "../../src/graph/mutate.ts";
import type { EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { EdgeId, NodeId, RunId, TaskId } from "../../src/ids.ts";
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
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { resolver } from "../run/skeleton.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

/** REVERSIBLE. Its only oversight is the gate the author drew in front of it. */
const NOTE: ToolManifestLite = {
  name: "notes.write",
  version: "1.0",
  capabilities: ["notes:write"],
  irreversibility: "reversible_write",
  idempotent: false,
};

const CAPS = ["notes:write", "graph:mutate"];

/** plan --seq--> gate --seq--> pay. Every path to the tool passes through the gate. */
function authoredSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated-note", project: "test", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
      capabilities: CAPS,
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      plan: { type: "object", reduce: "replace" },
      note: { type: "string", reduce: "replace" },
      receipt: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["receipt"],
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
      { id: n("gate"), type: "human_gate", reads: ["goal"], humanGate: { ref: "oversight/hold@stable" } },
      {
        id: n("pay"),
        type: "tool",
        reads: ["goal"],
        writes: ["receipt"],
        tool: { name: "notes.write", version: "1.0", args: {} },
        unhandled: true,
      },
    ],
    edges: [
      { id: e("a0"), from: n("plan"), to: n("gate"), kind: "seq" },
      { id: e("a1"), from: n("gate"), to: n("pay"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/** One trivial added node, and one edge from it into the EXISTING protected node. */
const GRAFT_NODES: readonly NodeSpec[] = [
  { id: n("hop"), type: "function", reads: ["goal"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec,
];
const GRAFT_EDGES: readonly EdgeSpec[] = [
  { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" } as unknown as EdgeSpec,
  { id: e("m1"), from: n("hop"), to: n("pay"), kind: "seq" } as unknown as EdgeSpec,
];

/** A proposal that grafts a second path around the gate. */
function proposingGraft(mutate: boolean): MockScript {
  return () =>
    mutate
      ? { text: JSON.stringify({ plan: {}, mutation: { addNodes: GRAFT_NODES, addEdges: GRAFT_EDGES } }), finishReason: "stop" }
      : { text: JSON.stringify({ plan: {} }), finishReason: "stop" };
}

/** A proposal that adds a node inside the proposer's own region and takes nothing away. */
function proposingLegit(): MockScript {
  return () => ({
    text: JSON.stringify({
      plan: {},
      mutation: {
        addNodes: [{ id: n("side"), type: "function", reads: ["goal"], function: { ref: "function/noop@stable", effects: [] } }],
        addEdges: [{ id: e("s0"), from: n("plan"), to: n("side"), kind: "seq" }],
      },
    }),
    finishReason: "stop",
  });
}

const compile = (spec: GraphSpec): RunGraph =>
  compileOrThrow({ spec, resolver: resolver(), tools: { "notes.write": NOTE }, tenantCapabilities: CAPS });

interface Rig {
  readonly engine: Engine;
  readonly wrote: () => number;
}

/** The successor graph a binary that ADMITTED the graft would have compiled and journaled. */
function graftedHash(): string {
  const base = authoredSpec() as unknown as { nodes: unknown[]; edges: unknown[] };
  base.nodes.push(...(GRAFT_NODES as unknown[]));
  base.edges.push(...(GRAFT_EDGES as unknown[]));
  return compile(base as unknown as GraphSpec).graphHash;
}

function rig(script: MockScript, store: MemoryStateStore = new MemoryStateStore({ now: () => 1_700_000_000_000 })): Rig {
  const now = (): number => 1_700_000_000_000;
  const tools = new ToolRegistry();
  let wrote = 0;
  tools.register({
    ...NOTE,
    description: "Writes a note.",
    parameters: { type: "object" },
    execute: () => {
      wrote++;
      return { content: "written", writes: { receipt: { ok: true } } };
    },
  } satisfies ToolDefinition);
  const functions = new FunctionRegistry();
  functions.register("function/noop@stable", () => ({ writes: {} }));
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script, pricePerMTok: 1 }), true);

  return {
    engine: new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models,
      now,
      resolver: resolver(),
      policy: { granted: CAPS, systemFloor: "out" },
      sleep: () => Promise.resolve(),
    }),
    wrote: () => wrote,
  };
}

/** Submit, advance to the gate, answer it, advance again. No operator de-escalation anywhere. */
async function driveAndReject(mutate: boolean): Promise<{ wrote: number; status: string }> {
  const { engine, wrote } = rig(proposingGraft(mutate));
  const runId = await engine.submit({ graph: compile(authoredSpec()), inputs: { goal: "write it down" } });
  const held = await engine.advance(runId);
  const gate = Object.values(held.gates).find((g) => g.nodeId === "gate");
  if (gate !== undefined) {
    await engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:alice", via: "console" },
      idempotencyKey: "k1",
    });
  }
  const after = await engine.advance(runId);
  return { wrote: wrote(), status: after.status };
}

/** Four plain `function` nodes and nothing else: no gate, no tool, and the graph posture `out`. */
function plainChain(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "plain-chain", project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 }, capabilities: [] },
    channels: {
      goal: { type: "string", reduce: "replace" },
      a1: { type: "string", reduce: "replace" },
      b1: { type: "string", reduce: "replace" },
      c1: { type: "string", reduce: "replace" },
      d1: { type: "string", reduce: "replace" },
      x1: { type: "string", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["d1"],
    nodes: [
      { id: n("a"), type: "function", reads: ["goal"], writes: ["a1"], function: { ref: "function/noop@stable", effects: [] } },
      { id: n("b"), type: "function", reads: ["a1"], writes: ["b1"], function: { ref: "function/noop@stable", effects: [] } },
      { id: n("c"), type: "function", reads: ["b1"], writes: ["c1"], function: { ref: "function/noop@stable", effects: [] } },
      { id: n("d"), type: "function", reads: ["c1"], writes: ["d1"], function: { ref: "function/noop@stable", effects: [] } },
    ],
    edges: [
      { id: e("a0"), from: n("a"), to: n("b"), kind: "seq" },
      { id: e("a1e"), from: n("b"), to: n("c"), kind: "seq" },
      { id: e("a2"), from: n("c"), to: n("d"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

test("THE HUMAN REJECTED AND THE TOOL DID NOT RUN — a graft may not route around an authored gate", async () => {
  const grafted = await driveAndReject(true);
  assert.equal(grafted.wrote, 0, "the human said no and the tool ran anyway, through an edge the model added");

  // The control: the identical run with the model proposing nothing. If this wrote, the arm
  // above would be measuring the gate rather than the graft.
  const plain = await driveAndReject(false);
  assert.equal(plain.wrote, 0, "control: without the mutation, a rejected gate stops the tool");
});

test("THE REFUSAL NAMES THE DOMINATOR THAT WOULD HAVE BEEN LOST", () => {
  // A diagnostic that says only "refused" leaves the model — and the author reading the journal —
  // no way to tell WHICH oversight the edge removed.
  const r = compileMutation({
    base: compile(authoredSpec()),
    mutation: {
      addNodes: [...GRAFT_NODES],
      addEdges: [...GRAFT_EDGES],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("plan"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });

  assert.equal(r.ok, false, "the graft compiled");
  const lost = r.diagnostics.find((d) => d.code === "MUT003_NOT_DOMINATED");
  assert.ok(lost !== undefined, `no dominator diagnostic; got ${r.diagnostics.map((d) => d.code).join(", ") || "(none)"}`);
  assert.match(lost.message, /\bpay\b/, "the message must name the node that lost its oversight");
  assert.match(lost.message, /\bgate\b/, "…and the dominator it would no longer pass through");
  assert.match(lost.message, /\bm1\b/, "…and the edge that did it");
});

test("A REJOIN THAT SPANS AN ORDINARY NODE IS REFUSED — the merged rule is dominance, not oversight", () => {
  // THE ADMIT HALF, AND IT HAS TO SPAN SOMETHING. The version this replaces rejoined at the
  // proposer's own immediate successor, where NO dominator is lost at all — the only rejoin a
  // preserve-every-dominator rule admits — so it passed while that rule refused the canonical
  // expansion. Here `pay -> extra -> after` skips `mid`, so `mid` really does leave `after`'s
  // dominator set, and `mid` is a plain `function` at posture `out` that protects nothing.
  //
  // Measured with the rule keyed on dominance alone:
  //
  //     pay -> mid -> after, add pay -> extra -> after  -> MUT003_NOT_DOMINATED, lost "mid"
  const spec = authoredSpec() as unknown as { nodes: unknown[]; edges: unknown[] };
  spec.nodes.push({ id: n("mid"), type: "function", reads: ["goal"], writes: ["note"], function: { ref: "function/noop@stable", effects: [] } });
  spec.nodes.push({ id: n("after"), type: "function", reads: ["goal"], function: { ref: "function/noop@stable", effects: [] } });
  spec.edges.push({ id: e("a2"), from: n("pay"), to: n("mid"), kind: "seq" });
  spec.edges.push({ id: e("a3"), from: n("mid"), to: n("after"), kind: "seq" });

  const r = compileMutation({
    base: compile(spec as unknown as GraphSpec),
    mutation: {
      addNodes: [{ id: n("extra"), type: "function", reads: ["goal"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec],
      addEdges: [
        { id: e("m0"), from: n("pay"), to: n("extra"), kind: "seq" } as unknown as EdgeSpec,
        { id: e("m1"), from: n("extra"), to: n("after"), kind: "seq" } as unknown as EdgeSpec,
      ],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("pay"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });

  // MERGE RESOLUTION, 2026-09-08: this row asserted an ADMIT on `phase1-taint`, where the
  // predicate was `carriesOversight`. `loom`'s rule (wave2-graph, 3cfd363) preserves EVERY
  // dominator, so the merged tree refuses it. The row is kept inverted as a pin on the cost:
  // the canonical expansion is refused, and a change that makes it pass again is a change to
  // the rule's predicate, not a silent drift.
  assert.ok(
    r.diagnostics.filter((d) => d.code === "MUT003_NOT_DOMINATED").length > 0,
    `the merged rule no longer refuses a rejoin that spans an ordinary node: ${r.diagnostics.map((d) => d.message).join(" | ") || "(none)"}`,
  );
  assert.equal(r.ok, false, "the merged rule admits no dominator loss at all");

  // AND THE GATE IS STILL THE BAR. The same graph, the same proposer, one edge moved: the rejoin
  // now lands on `pay` itself, which `gate` dominates and `extra` does not. Nothing about the
  // shape changed — only whether the dominator the edge removes is the one carrying oversight.
  const g = compileMutation({
    base: compile(spec as unknown as GraphSpec),
    mutation: {
      addNodes: [{ id: n("extra"), type: "function", reads: ["goal"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec],
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("extra"), kind: "seq" } as unknown as EdgeSpec,
        { id: e("m1"), from: n("extra"), to: n("pay"), kind: "seq" } as unknown as EdgeSpec,
      ],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("plan"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });
  const lost = g.diagnostics.find((d) => d.code === "MUT003_NOT_DOMINATED");
  assert.ok(lost !== undefined, `the graft around the gate compiled: ${g.diagnostics.map((d) => d.code).join(", ") || "(none)"}`);
  assert.match(lost.message, /\bgate\b/, "…and it is the gate that was named");
});

test("A PLAIN CHAIN IS REFUSED THE CANONICAL EXPANSION — the merged rule's accepted cost", () => {
  // The regression this rule shipped, in its smallest form: four plain `function` nodes and a
  // proposal that adds a lookup and carries on into the node the proposer already leads to.
  // There is no oversight anywhere in this graph — no `human_gate`, no tool, and the graph
  // posture is `out` — so there is nothing a second path could route around.
  const r = compileMutation({
    base: compileOrThrow({ spec: plainChain(), resolver: resolver(), tools: {}, tenantCapabilities: [] }),
    mutation: {
      addNodes: [
        { id: n("lookup"), type: "function", reads: ["a1"], writes: ["x1"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec,
      ],
      addEdges: [
        { id: e("m0"), from: n("a"), to: n("lookup"), kind: "seq" } as unknown as EdgeSpec,
        { id: e("m1"), from: n("lookup"), to: n("c"), kind: "seq" } as unknown as EdgeSpec,
      ],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("a"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });
  // MERGE RESOLUTION, 2026-09-08: this row asserted an ADMIT on `phase1-taint`, where the
  // predicate was `carriesOversight`. `loom`'s rule (wave2-graph, 3cfd363) preserves EVERY
  // dominator, so the merged tree refuses it. The row is kept inverted as a pin on the cost:
  // the canonical expansion is refused, and a change that makes it pass again is a change to
  // the rule's predicate, not a silent drift.
  assert.ok(
    r.diagnostics.filter((d) => d.code === "MUT003_NOT_DOMINATED").length > 0,
    `the merged rule no longer refuses the canonical expansion: ${r.diagnostics.map((d) => d.message).join(" | ") || "(none)"}`,
  );
  assert.equal(r.ok, false, "the merged rule admits no dominator loss at all");
});

/** `a -> w -> c -> d` with `w` an ordinary REVERSIBLE tool. No gate, no irreversible action. */
function writeChain(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "write-chain", project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 }, capabilities: CAPS },
    channels: {
      goal: { type: "string", reduce: "replace" },
      a1: { type: "string", reduce: "replace" },
      receipt: { type: "object", reduce: "replace" },
      c1: { type: "string", reduce: "replace" },
      d1: { type: "string", reduce: "replace" },
      x1: { type: "string", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["d1"],
    nodes: [
      { id: n("a"), type: "function", reads: ["goal"], writes: ["a1"], function: { ref: "function/noop@stable", effects: [] } },
      { id: n("w"), type: "tool", reads: ["a1"], writes: ["receipt"], tool: { name: "notes.write", version: "1.0", args: {} }, unhandled: true },
      { id: n("c"), type: "function", reads: ["receipt"], writes: ["c1"], function: { ref: "function/noop@stable", effects: [] } },
      { id: n("d"), type: "function", reads: ["c1"], writes: ["d1"], function: { ref: "function/noop@stable", effects: [] } },
    ],
    edges: [
      { id: e("a0"), from: n("a"), to: n("w"), kind: "seq" },
      { id: e("a1e"), from: n("w"), to: n("c"), kind: "seq" },
      { id: e("a2"), from: n("c"), to: n("d"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

test("A CHAIN WITH A REVERSIBLE_WRITE IN IT IS REFUSED THE CANONICAL EXPANSION TOO", () => {
  // The bar used to be the COMPILED POSTURE, and `CLASS_DEFAULT_POSTURE` puts `reversible_write`
  // at `on` — so any ordinary `fs.write`/`notes.write` node became an unremovable dominator and
  // the canonical expansion was refused in a graph with NO gate and NO irreversible action
  // anywhere. The admit test one below used only plain `function` nodes, which is why it passed.
  //
  //     the bar is the compiled posture -> MUT003_NOT_DOMINATED, lost dominator "w"
  //     the bar is the node type        -> ok
  const r = compileMutation({
    base: compile(writeChain()),
    mutation: {
      addNodes: [
        { id: n("lookup"), type: "function", reads: ["a1"], writes: ["x1"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec,
      ],
      addEdges: [
        { id: e("m0"), from: n("a"), to: n("lookup"), kind: "seq" } as unknown as EdgeSpec,
        { id: e("m1"), from: n("lookup"), to: n("c"), kind: "seq" } as unknown as EdgeSpec,
      ],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("a"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });
  // MERGE RESOLUTION, 2026-09-08: this row asserted an ADMIT on `phase1-taint`, where the
  // predicate was `carriesOversight`. `loom`'s rule (wave2-graph, 3cfd363) preserves EVERY
  // dominator, so the merged tree refuses it. The row is kept inverted as a pin on the cost:
  // the canonical expansion is refused, and a change that makes it pass again is a change to
  // the rule's predicate, not a silent drift.
  assert.ok(
    r.diagnostics.filter((d) => d.code === "MUT003_NOT_DOMINATED").length > 0,
    `the merged rule no longer refuses an expansion past an ordinary write: ${r.diagnostics.map((d) => d.message).join(" | ") || "(none)"}`,
  );
  assert.equal(r.ok, false, "the merged rule admits no dominator loss at all");

  // AND THE GATE IS STILL THE BAR IN THE SAME GRAPH. One `human_gate` in front of `c`, and the
  // identical rejoin is refused — so the row above is the narrowing and not the rule going away.
  const gated = writeChain() as unknown as { nodes: unknown[]; edges: EdgeSpec[] };
  gated.nodes.push({ id: n("gate"), type: "human_gate", reads: ["goal"], humanGate: { ref: "oversight/hold@stable" } });
  gated.edges = gated.edges.filter((x) => x.id !== e("a1e"));
  gated.edges.push({ id: e("g0"), from: n("w"), to: n("gate"), kind: "seq" } as unknown as EdgeSpec);
  gated.edges.push({ id: e("g1"), from: n("gate"), to: n("c"), kind: "seq" } as unknown as EdgeSpec);
  const g = compileMutation({
    base: compile(gated as unknown as GraphSpec),
    mutation: {
      addNodes: [
        { id: n("lookup"), type: "function", reads: ["a1"], writes: ["x1"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec,
      ],
      addEdges: [
        { id: e("m0"), from: n("a"), to: n("lookup"), kind: "seq" } as unknown as EdgeSpec,
        { id: e("m1"), from: n("lookup"), to: n("c"), kind: "seq" } as unknown as EdgeSpec,
      ],
      proposedBy: "t1" as TaskId,
      proposedByNode: n("a"),
    },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });
  const lost = g.diagnostics.find((d) => d.code === "MUT003_NOT_DOMINATED");
  assert.ok(lost !== undefined, `the graft around the gate compiled: ${g.diagnostics.map((d) => d.code).join(", ") || "(none)"}`);
  assert.match(lost.message, /\bgate\b/, "…and it is the gate that was named");
});

test("A GRAFTED EDGE IS REPORTED AT EVERY NODE IT TAKES OUT, the shallowest among them", () => {
  // The loop reported per DOWNSTREAM NODE, so one edge that takes a whole tail out of a gate's
  // region produced one sentence per node in the tail — the same fact, restated, differing only
  // in which node it named. Measured on `plan -> gate -> pay -> after -> last` with the graft
  // rejoining at `pay`:
  //
  //     per downstream node          -> 3 diagnostics: "pay", "after", "last"
  //     per (culprit edge, lost)     -> 1 diagnostic: "pay"
  const tailed = authoredSpec() as unknown as { nodes: unknown[]; edges: unknown[] };
  tailed.nodes.push({ id: n("after"), type: "function", reads: ["goal"], writes: ["note"], function: { ref: "function/noop@stable", effects: [] } });
  tailed.nodes.push({ id: n("last"), type: "function", reads: ["note"], function: { ref: "function/noop@stable", effects: [] } });
  tailed.edges.push({ id: e("a2"), from: n("pay"), to: n("after"), kind: "seq" });
  tailed.edges.push({ id: e("a3"), from: n("after"), to: n("last"), kind: "seq" });

  const g = compileMutation({
    base: compile(tailed as unknown as GraphSpec),
    mutation: { addNodes: [...GRAFT_NODES], addEdges: [...GRAFT_EDGES], proposedBy: "t1" as TaskId, proposedByNode: n("plan") },
    budget: { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } },
    resolver: resolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });
  // MERGE RESOLUTION, 2026-09-08: `phase1-taint` reported one diagnostic per (culprit edge,
  // lost dominator); `loom` reports one per node whose region moved, so the tail produces three.
  const lost = g.diagnostics.filter((d) => d.code === "MUT003_NOT_DOMINATED");
  assert.equal(lost.length, 3, `one per node in the tail, got ${String(lost.length)}: ${lost.map((d) => d.message).join(" | ")}`);
  assert.ok(lost.some((d) => /"pay"/.test(d.message)), "and the shallowest node the edge took out is among them");
});

test("A GRAFT ALREADY IN THE JOURNAL IS REFUSED AT ATTACH — the compile-time rule was compile-time only", async () => {
  // MUT003 ran in `#applyMutation` and nowhere else. `#rehydrateGraph` re-applied the RECORDED
  // mutation with `compile`, which runs the 22 authored-graph rules and not the four
  // `compileMutation` adds — so a journal written by a binary without §2b resumed on one that has
  // it with the graft intact and the human's rejection bypassed. `mutate.ts`'s header claims a
  // model "cannot propose one that weakens oversight ... because those are compile errors", and
  // that was true only for the process that did the proposing.
  //
  // The journal is written here the way `control-flow-taint.test.ts` ages one: the run is
  // submitted, a `graph.mutated` holding the exact graft is appended straight into the log, and a
  // SECOND Engine attaches the AUTHORED graph — which is what a caller has on disk.
  //
  //     fold-and-compile      -> failed, wrote 1   (the human rejected and the tool ran)
  //     replay-and-revalidate -> attach refuses,  wrote 0
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const first = rig(proposingGraft(false), store);
  const graph = compile(authoredSpec());
  const runId = await first.engine.submit({ graph, inputs: { goal: "write it down" } });

  let headSeq = 0;
  for await (const ev of store.read(runId, 1 as never)) headSeq = ev.seq;
  await store.append({
    runId,
    expectedSeq: headSeq as never,
    events: [
      {
        type: "graph.mutated",
        payload: {
          parentHash: graph.graphHash,
          newHash: graftedHash(),
          addedNodes: GRAFT_NODES.map((x) => x.id),
          addedEdges: GRAFT_EDGES.map((x) => x.id),
          nodes: [...GRAFT_NODES],
          edges: [...GRAFT_EDGES],
          proposedBy: "t-old" as TaskId,
          proposedByNode: n("plan"),
          budgetConsumed: 1,
        },
        actor: { kind: "system", id: "executor" },
      } as never,
    ],
  });

  // `#rehydrateGraph` runs on the first `advance` after an attach, which is where the recorded
  // mutation is replayed and therefore where it is refused.
  const second = rig(proposingGraft(false), store);
  second.engine.attach(runId, graph);
  await assert.rejects(
    () => second.engine.advance(runId),
    (e: unknown) => /MUT003_NOT_DOMINATED/.test((e as Error).message),
    "a recorded graft around an authored gate was adopted on resume",
  );
  assert.equal(second.wrote(), 0, "and nothing ran");
});

test("A LEGITIMATE RECORDED MUTATION STILL REHYDRATES — the re-validation is not a refusal of every graft", async () => {
  // The half that must not move. The same replay, with a mutation that removes no gate from
  // anybody's dominator set: a second process attaching the AUTHORED graph rebuilds the successor
  // from the journal, matches the recorded hash, and the run goes on. Without this the arm above
  // would be measuring "attach refuses after any mutation".
  const store = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  const first = rig(proposingLegit(), store);
  const graph = compile(authoredSpec());
  const runId = await first.engine.submit({ graph, inputs: { goal: "write it down" } });
  const held = await first.engine.advance(runId);
  assert.equal(held.status, "awaiting_gate", `precondition: the authored gate stops the run: ${held.status}`);
  const folded = (await first.engine.projection(runId))?.graphHash;
  assert.notEqual(folded, graph.graphHash, "precondition: the run really did adopt a mutation");

  // A second Engine with no memory of the first, handed the graph a caller has on disk.
  const second = rig(proposingLegit(), store);
  second.engine.attach(runId, graph);

  const gate = Object.values(held.gates).find((g) => g.nodeId === "gate");
  assert.ok(gate !== undefined, "precondition: the authored gate is open");
  await second.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k1",
  });
  const done = await second.engine.advance(runId);
  assert.equal(done.status, "succeeded", `a legitimate recorded mutation blocked the resume: ${done.status}`);
  assert.equal(done.graphHash, folded, "and the graph it ran out on is the successor the journal recorded");
  assert.equal(second.wrote(), 1, "and the action the human approved runs");
});

// ---------------------------------------------------------------------------
// A `subgraph` AS THE DOMINATOR, whose CHILD holds the only gate
// ---------------------------------------------------------------------------

const CHILD_REF = "graph/approver@stable";

/** The delegated graph: the gate the parent cannot see. */
function childSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "approver", project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 1 } },
    channels: { payload: { type: "string", reduce: "replace" }, out: { type: "string", reduce: "replace" } },
    inputs: ["payload"],
    outputs: ["out"],
    nodes: [
      { id: n("hold"), type: "human_gate", reads: ["payload"], humanGate: { ref: "oversight/hold@stable" } },
      { id: n("leaf"), type: "function", reads: ["payload"], writes: ["out"], function: { ref: "function/noop@stable", effects: [] } },
    ],
    edges: [{ id: e("toLeaf"), from: n("hold"), to: n("leaf"), kind: "seq" }],
  } as unknown as GraphSpec;
}

function childResolver(): ReturnType<typeof resolver> {
  const base = resolver();
  return { ...base, subgraph: (ref: string) => (ref === CHILD_REF ? childSpec() : undefined) };
}

/** `a -> delegate -> c -> d`, with `delegate` a `subgraph` and no `human_gate` anywhere in the parent. */
function delegatingChain(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "delegating-chain", project: "test", version: 1 },
    policy: { posture: "out", expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 }, capabilities: CAPS },
    channels: {
      goal: { type: "string", reduce: "replace" },
      a1: { type: "string", reduce: "replace" },
      b1: { type: "string", reduce: "replace" },
      c1: { type: "string", reduce: "replace" },
      d1: { type: "string", reduce: "replace" },
      x1: { type: "string", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["d1"],
    nodes: [
      { id: n("a"), type: "function", reads: ["goal"], writes: ["a1"], function: { ref: "function/noop@stable", effects: [] } },
      {
        id: n("delegate"),
        type: "subgraph",
        reads: ["a1"],
        writes: ["b1"],
        subgraph: { ref: CHILD_REF, inputs: { payload: "a1" }, outputs: { b1: "out" }, budgetShare: 0.5 },
      },
      { id: n("c"), type: "function", reads: ["b1"], writes: ["c1"], function: { ref: "function/noop@stable", effects: [] } },
      { id: n("d"), type: "function", reads: ["c1"], writes: ["d1"], function: { ref: "function/noop@stable", effects: [] } },
    ],
    edges: [
      { id: e("a0"), from: n("a"), to: n("delegate"), kind: "seq" },
      { id: e("a1e"), from: n("delegate"), to: n("c"), kind: "seq" },
      { id: e("a2"), from: n("c"), to: n("d"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

/**
 * THE DOMINATOR THAT CARRIES OVERSIGHT NEED NOT BE A `human_gate` — IT MAY DELEGATE TO ONE.
 *
 * The bar here was the literal type `human_gate`, scanned over the PARENT's nodes, while
 * `Engine.#fireEmptyJoin` had already been widened to `human_gate ∪ subgraph` for exactly this
 * reason. One question, two files, two answers — and a `subgraph` is a wrapper for arbitrary node
 * types, so any set defined by listing types is wrong at that boundary.
 *
 *     the bar is the literal `human_gate` -> ok                                (before)
 *     the bar is `carriesOversight`       -> MUT003_DOMINATOR_LOST, "delegate"  (now)
 *
 * And the half that must not move: the identical rejoin in the identical chain with an ordinary
 * `function` in the delegation's place is still admitted, so this is the SET being widened and
 * not the rule turning into "refuse every rejoin".
 */
test("A `subgraph` DOMINATOR IS PRESERVED TOO — and so, on the merged rule, is an ordinary one", () => {
  const graft = {
    addNodes: [
      { id: n("lookup"), type: "function", reads: ["a1"], writes: ["x1"], function: { ref: "function/noop@stable", effects: [] } } as unknown as NodeSpec,
    ],
    addEdges: [
      { id: e("m0"), from: n("a"), to: n("lookup"), kind: "seq" } as unknown as EdgeSpec,
      { id: e("m1"), from: n("lookup"), to: n("c"), kind: "seq" } as unknown as EdgeSpec,
    ],
    proposedBy: "t1" as TaskId,
    proposedByNode: n("a"),
  };
  const budget = { consumedNodes: 0, expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 } };

  const r = compileMutation({
    base: compileOrThrow({ spec: delegatingChain(), resolver: childResolver(), tools: { "notes.write": NOTE }, tenantCapabilities: CAPS }),
    mutation: graft,
    budget,
    resolver: childResolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });
  const lost = r.diagnostics.find((d) => d.code === "MUT003_NOT_DOMINATED");
  assert.ok(lost !== undefined, `the graft around the delegation compiled: ${r.diagnostics.map((d) => d.code).join(", ") || "(none)"}`);
  assert.match(lost.message, /\bdelegate\b/, "…and it is the delegation that was named");

  // THE HALF THAT MUST NOT MOVE. The same chain with a plain `function` where the delegation was.
  const plain = delegatingChain() as unknown as { nodes: { id: NodeId }[] };
  plain.nodes[1] = {
    id: n("delegate"),
    type: "function",
    reads: ["a1"],
    writes: ["b1"],
    function: { ref: "function/noop@stable", effects: [] },
  } as unknown as { id: NodeId };
  const ok = compileMutation({
    base: compileOrThrow({ spec: plain as unknown as GraphSpec, resolver: childResolver(), tools: { "notes.write": NOTE }, tenantCapabilities: CAPS }),
    mutation: graft,
    budget,
    resolver: childResolver(),
    tools: { "notes.write": NOTE },
    tenantCapabilities: CAPS,
  });
  // MERGE RESOLUTION, 2026-09-08: this row asserted an ADMIT on `phase1-taint`, where the
  // predicate was `carriesOversight`. `loom`'s rule (wave2-graph, 3cfd363) preserves EVERY
  // dominator, so the merged tree refuses it. The row is kept inverted as a pin on the cost:
  // the canonical expansion is refused, and a change that makes it pass again is a change to
  // the rule's predicate, not a silent drift.
  assert.ok(
    ok.diagnostics.filter((d) => d.code === "MUT003_NOT_DOMINATED").length > 0,
    `the merged rule no longer refuses the canonical expansion past an ordinary node: ${ok.diagnostics.map((d) => d.message).join(" | ") || "(none)"}`,
  );
  assert.equal(ok.ok, false, "the merged rule admits no dominator loss at all");
});
