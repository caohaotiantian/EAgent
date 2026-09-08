/**
 * A model-proposed mutation may not take an existing node out of the region that dominates it.
 *
 * `compileMutation` refused an added edge only when BOTH endpoints already existed, or when an
 * ADDED node was targeted from something that was neither the proposer nor another added node.
 * The third direction — added `from`, existing `to` — was accepted with no diagnostic at all,
 * and because `seq` edges are OR-joined it is a SECOND path to whatever it points at. Point it
 * past an authored `human_gate` and the gate stops being on every path: the human rejects,
 * `gate.decided` carries an unconditional `run.resumed`, and the grafted task is ready. The
 * rejection RELEASES the action it was meant to stop.
 *
 * The end-to-end test below is the one that matters, and it deliberately uses a
 * `reversible_write` tool. For `irreversible` and `externally_visible`,
 * `CLASS_DEFAULT_POSTURE` pins the node at `in`, so the grafted path raises the node's own gate
 * and a second layer catches it. For a tool whose only oversight is the gate an author put in
 * front of it for business reasons, there is no second layer — measured at 294e713 as
 * `charged=1` after a rejection, against `charged=0` in the unmutated control.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { compileMutation, type GraphMutation } from "../../src/graph/mutate.ts";
import type { EdgeSpec, GraphSpec, NodeSpec, RunGraph } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
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

const NOTE: ToolManifestLite = {
  name: "note.append",
  version: "1.0",
  capabilities: ["fs:write"],
  // REVERSIBLE ON PURPOSE. The class whose only oversight is the authored gate.
  irreversibility: "reversible_write",
  idempotent: true,
};
const CAPS = ["fs:write", "graph:mutate"];

/** plan -> gate -> pay. The gate dominates `pay`; that is the whole property. */
function gatedSpec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "gated", project: "test", version: 1 },
    policy: {
      posture: "out",
      expansion: { maxNodes: 8, maxDepth: 2, maxFanout: 4, maxLoopIterations: 2 },
      capabilities: CAPS,
      budget: { costUsd: 1 },
    },
    channels: {
      goal: { type: "string", reduce: "replace" },
      plan: { type: "object", reduce: "replace" },
      out: { type: "object", reduce: "replace" },
    },
    inputs: ["goal"],
    outputs: ["out"],
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
      { id: n("gate"), type: "human_gate", reads: ["plan"], writes: [], humanGate: { ref: "oversight/sre-prod-change@stable" } },
      { id: n("pay"), type: "tool", reads: ["plan"], writes: ["out"], tool: { name: "note.append", version: "1.0", args: {} } },
    ],
    edges: [
      { id: e("a0"), from: n("plan"), to: n("gate"), kind: "seq" },
      { id: e("a1"), from: n("gate"), to: n("pay"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

const compiled = (spec: GraphSpec = gatedSpec()): RunGraph =>
  compileOrThrow({ spec, resolver: resolver(), tools: { "note.append": NOTE }, tenantCapabilities: CAPS });

const HOP: NodeSpec = {
  id: n("hop"),
  type: "function",
  reads: ["plan"],
  writes: [],
  function: { ref: "function/detail@stable" },
} as unknown as NodeSpec;

/** The graft: proposer -> hop, then hop -> `pay`, which is downstream of the gate. */
const GRAFT: { addNodes: NodeSpec[]; addEdges: EdgeSpec[] } = {
  addNodes: [HOP],
  addEdges: [
    { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
    { id: e("m1"), from: n("hop"), to: n("pay"), kind: "seq" },
  ],
};

const mutation = (over: Partial<GraphMutation> = {}): GraphMutation => ({
  ...GRAFT,
  proposedBy: "plan@root#0" as TaskId,
  proposedByNode: n("plan"),
  ...over,
});

const attempt = (base: RunGraph, m: GraphMutation) =>
  compileMutation({
    base,
    mutation: m,
    budget: { consumedNodes: 0, expansion: base.expansion },
    resolver: resolver(),
    tools: { "note.append": NOTE },
    tenantCapabilities: CAPS,
  });

test("AN ADDED EDGE THAT ROUTES PAST A HUMAN GATE IS REFUSED, and the diagnostic names the gate", () => {
  const r = attempt(compiled(), mutation());
  assert.equal(r.ok, false);
  const errors = r.diagnostics.filter((d) => d.severity === "error");
  assert.equal(errors.length, 1, errors.map((d) => d.message).join(" | "));
  assert.equal(errors[0]?.code, "MUT003_NOT_DOMINATED");
  assert.equal(errors[0]?.at?.nodeId, "pay");
  assert.match(errors[0]!.message, /edge "m1" gives "pay" a path that does not pass through "gate"/);
});

test("…and the proposer being an ancestor of the target does not excuse it", () => {
  // The obvious rule — "refuse unless the proposer already dominates the target" — is
  // satisfied by this exact graph: `plan` is the entry node, so it dominates everything. The
  // control is that `plan` genuinely does dominate `pay` in the base graph, which is why that
  // rule would have passed the mutation the test above refuses.
  const base = compiled();
  assert.ok(base.plans[n("pay")] !== undefined);
  const r = attempt(compiled(), mutation({ proposedByNode: n("plan") }));
  assert.equal(r.ok, false);
});

test("THE ORDINARY HALF: an added node hung off the proposer is still accepted", () => {
  const r = attempt(compiled(), mutation({ addEdges: [{ id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" }] }));
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.diagnostics));
});

test("AND SO IS AN `added -> existing` EDGE THAT KEEPS THE REGION, which is why this is not a ban on the direction", () => {
  // `plan -> step` only, so `dom(step) = {plan, step}`. A mutation that inserts `hop` between
  // them adds a path `plan -> hop -> step`, which still passes through everything that
  // dominated `step` before. A rule that refused `added -> existing` by shape would refuse
  // this too; dominator preservation admits it.
  const spec = gatedSpec();
  const open = {
    ...spec,
    nodes: [spec.nodes[0]!, { ...spec.nodes[2]!, id: n("step") }],
    edges: [{ id: e("a0"), from: n("plan"), to: n("step"), kind: "seq" }],
  } as unknown as GraphSpec;
  const base = compiled(open);
  const r = attempt(
    base,
    mutation({
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
        { id: e("m1"), from: n("hop"), to: n("step"), kind: "seq" },
      ],
    }),
  );
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
});

test("EVERY EDGE KIND THE EXECUTOR CAN TAKE, which is not `dagEdges`", () => {
  // THE LOOP ARM IS THE ONE THAT MATTERS, and it is here because the first version of this rule
  // ran over `indexGraph().dagEdges` and missed it. `dagEdges` drops `loop`, the argument for
  // that being that a `loop` edge whose target cannot reach its source is GRAPH006_STUCK_LOOP —
  // which was an accident of the fixture it was measured on. `rule006Cycles` asks `nodesInCycle`,
  // so the loop is refused only when neither endpoint writes a channel the `until` reads. Give
  // the added node one read the `until` touches (the `hopReading` case below) and it compiled,
  // and `#edgesToTake` takes a loop edge, so the human rejected and the tool ran anyway.
  const base = compiled();
  const extra = (kind: string): Record<string, unknown> => {
    if (kind === "conditional") return { when: "has(plan)" };
    if (kind === "error") return { codes: ["*"] };
    if (kind === "loop") return { until: "has(plan)", maxIterations: 2 };
    if (kind === "join") return { branches: [n("hop")] };
    if (kind === "fanout") return { over: "plan", as: "plan", maxWidth: 2 };
    return {};
  };
  for (const kind of ["seq", "conditional", "error", "join", "fanout"]) {
    const r = attempt(
      base,
      mutation({
        addEdges: [
          { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
          { id: e("m1"), from: n("hop"), to: n("pay"), kind, ...extra(kind) } as unknown as EdgeSpec,
        ],
      }),
    );
    assert.equal(r.ok, false, kind);
    assert.ok(
      r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.at?.nodeId === "pay"),
      `${kind}: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}`,
    );
  }

  // THE LOOP GRAFT THAT COMPILES. `hop` reads `out` and the `until` reads `out`, so
  // GRAPH006_STUCK_LOOP does not fire and only this rule stands between the proposal and the
  // gated tool.
  const hopReading: NodeSpec = { ...HOP, reads: ["out"] } as unknown as NodeSpec;
  const loopGraft = attempt(
    base,
    mutation({
      addNodes: [hopReading],
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
        { id: e("m1"), from: n("hop"), to: n("pay"), kind: "loop", until: "has(out)", maxIterations: 2 } as unknown as EdgeSpec,
      ],
    }),
  );
  assert.equal(loopGraft.ok, false, "a loop edge is a path the executor takes");
  assert.ok(
    loopGraft.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.at?.nodeId === "pay"),
    `loop: ${loopGraft.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join(" | ")}`,
  );

  // AND THE ONE LOOP THAT IS STILL LEGAL: back to the PROPOSER, which takes nothing away —
  // a path through the proposer passes through every dominator the proposer has. The control
  // that keeps the arm above from being vacuous. `until` reads `plan` here rather than `out`
  // because the cycle is {hop, plan} and GRAPH006 wants a writer inside it.
  const backToProposer = attempt(
    base,
    mutation({
      addNodes: [{ ...HOP, reads: ["plan", "out"] } as unknown as NodeSpec],
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
        { id: e("m1"), from: n("hop"), to: n("plan"), kind: "loop", until: "has(plan)", maxIterations: 2 } as unknown as EdgeSpec,
      ],
    }),
  );
  assert.equal(
    backToProposer.ok,
    true,
    backToProposer.ok ? "" : JSON.stringify(backToProposer.diagnostics.filter((d) => d.severity === "error")),
  );

  // `compensation` IS THE ONE KIND THE CHECK MAY DROP, and not because of anything about
  // cycles: `#edgesToTake` answers `case "compensation": break;`, so nothing ever traverses one
  // and it is not a path. It is refused here by GRAPH012 for its own unrelated reason.
  const comp = attempt(
    base,
    mutation({
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
        { id: e("m1"), from: n("hop"), to: n("pay"), kind: "compensation" } as unknown as EdgeSpec,
      ],
    }),
  );
  assert.equal(comp.ok, false);
  assert.ok(comp.diagnostics.some((d) => d.code === "GRAPH012_NO_COMPENSATES"));
});

/**
 * THE THIRD SHAPE, and it is a NODE TYPE rather than an edge kind: a `join` node.
 *
 * Two facts meet. `#maybeFireJoin` fires a `mode:"all"` join only when its branches arrive, so
 * a gate standing in front of ONE branch is a must-execute ancestor of the join — but
 * `dominators` intersects over predecessors, and an intersection over the branches cannot
 * contain it. So `dom_before(j)` never held the gate, and nothing could be LOST. And
 * `#edgesToTake` dispatches on the EDGE's kind, not on the target node's type, so a `seq` edge
 * into a join node takes the generic `task.ready` arm and makes the join ready with ZERO
 * branches arrived — the barrier is not weakened, it is skipped.
 *
 * Reproduced end to end at `a678b86`: `ok = true` with no diagnostic, and the human rejected
 * while `note.append` ran.
 */
function joinSpec(): GraphSpec {
  const base = gatedSpec();
  const plan = base.nodes[0]!;
  const gate = base.nodes[1]!;
  const pay = base.nodes[2]!;
  return {
    ...base,
    channels: { ...base.channels, a: { type: "object", reduce: "replace" }, b: { type: "object", reduce: "replace" } },
    nodes: [
      plan,
      gate,
      // `function` nodes, so `ran` distinguishes them from the tool the gate guards.
      { id: n("A"), type: "function", reads: ["plan"], writes: ["a"], function: { ref: "function/detail@stable" } },
      { id: n("B"), type: "function", reads: ["plan"], writes: ["b"], function: { ref: "function/detail@stable" } },
      { id: n("j"), type: "join", reads: [], writes: [], join: { branches: [n("A"), n("B")], mode: "all", onBranchError: "fail" } },
      pay,
    ],
    edges: [
      { id: e("a0"), from: n("plan"), to: n("gate"), kind: "seq" },
      { id: e("a1"), from: n("gate"), to: n("A"), kind: "seq" },
      { id: e("a2"), from: n("plan"), to: n("B"), kind: "seq" },
      { id: e("a3"), from: n("A"), to: n("j"), kind: "join" },
      { id: e("a4"), from: n("B"), to: n("j"), kind: "join" },
      { id: e("a5"), from: n("j"), to: n("pay"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

test("A GRAFT INTO A `join` NODE IS REFUSED, because an edge that is not a `join` edge skips the barrier", () => {
  const r = attempt(
    compiled(joinSpec()),
    mutation({
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
        { id: e("m1"), from: n("hop"), to: n("j"), kind: "seq" },
      ],
    }),
  );
  assert.equal(r.ok, false, "a seq edge into a join node makes it ready with zero branches arrived");
  assert.ok(
    r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.at?.nodeId === "j"),
    r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join(" | "),
  );
});

test("…AND THE CONTROL: on the same join graph, a mutation that does not touch the join is accepted", () => {
  const r = attempt(
    compiled(joinSpec()),
    mutation({ addEdges: [{ id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" }] }),
  );
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
});

/**
 * THE CEILING, and its ordinary half either side of the boundary.
 *
 * Everything the rule does is quadratic in the BASE graph's node count, it runs inside
 * `#commit`, and it is reached only because a MODEL proposed an `added -> existing` edge. Before
 * the bitset rewrite the Set-of-Sets fixpoint took 1.5 GB at 4,000 nodes and killed the process
 * at 8,000 while the SAME call without the graft edge finished in two seconds — one model-chosen
 * edge was the difference between a working engine and a dead one. Both halves are here: under
 * the ceiling the real answer is still computed, over it the rule refuses instead of running.
 */
function chainSpec(N: number): GraphSpec {
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (let i = 0; i < N; i++) {
    nodes.push({ id: n(`c${String(i)}`), type: "function", reads: i === 0 ? ["goal"] : [], writes: [], function: { ref: "function/detail@stable" } });
    if (i > 0) edges.push({ id: e(`ce${String(i)}`), from: n(`c${String(i - 1)}`), to: n(`c${String(i)}`), kind: "seq" });
  }
  const base = gatedSpec();
  return { ...base, channels: { goal: base.channels["goal"] }, inputs: ["goal"], outputs: [], nodes, edges } as unknown as GraphSpec;
}

/** `c0 -> hop -> c<N-1>`: a second path to the last node, which the whole chain dominated. */
const chainGraft = (N: number): Partial<GraphMutation> => ({
  addNodes: [{ ...HOP, reads: [] } as unknown as NodeSpec],
  addEdges: [
    { id: e("m0"), from: n("c0"), to: n("hop"), kind: "seq" },
    { id: e("m1"), from: n("hop"), to: n(`c${String(N - 1)}`), kind: "seq" },
  ],
});

/**
 * THE BITSET ACROSS ITS WORD BOUNDARIES, which is the failure mode a fixture cannot show.
 *
 * One bit per (node, dominator) packed 32 to a word means a wrong shift or a wrong tail mask
 * silently answers "nothing was lost" — the passing value, for graphs of exactly the wrong size.
 * So the same graft is driven over every node count either side of 32, 64, 96 and 128, with the
 * gate at three positions in each, and each case must not merely refuse but NAME the gate.
 */
test("THE PACKED DOMINATOR ROWS ARE RIGHT ACROSS EVERY 32-NODE BOUNDARY, gate named each time", () => {
  const chainWithGate = (N: number, G: number): GraphSpec => {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    for (let i = 0; i < N; i++) {
      nodes.push(
        i === G
          ? { id: n(`c${String(i)}`), type: "human_gate", reads: [], writes: [], humanGate: { ref: "oversight/sre-prod-change@stable" } }
          : { id: n(`c${String(i)}`), type: "function", reads: i === 0 ? ["goal"] : [], writes: [], function: { ref: "function/detail@stable" } },
      );
      if (i > 0) edges.push({ id: e(`ce${String(i)}`), from: n(`c${String(i - 1)}`), to: n(`c${String(i)}`), kind: "seq" });
    }
    const base = gatedSpec();
    return { ...base, channels: { goal: base.channels["goal"] }, inputs: ["goal"], outputs: [], nodes, edges } as unknown as GraphSpec;
  };
  let checked = 0;
  for (const N of [2, 3, 30, 31, 32, 33, 34, 63, 64, 65, 96, 97, 128, 129]) {
    // DEDUPED: at N=3 all three positions are the same node, and counting it three times would
    // overstate the sweep. N=2 has no interior position at all and contributes none.
    for (const G of [...new Set([1, Math.floor(N / 2), N - 2])]) {
      if (G < 1 || G > N - 2) continue;
      const r = attempt(compiled(chainWithGate(N, G)), mutation({ ...chainGraft(N), proposedByNode: n("c0") }));
      assert.equal(r.ok, false, `N=${String(N)} G=${String(G)}`);
      assert.ok(
        r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.message.includes(`"c${String(G)}"`)),
        `N=${String(N)} G=${String(G)}: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join(" | ")}`,
      );
      checked++;
    }
  }
  assert.equal(checked, 37, "the boundary sweep must actually have run every DISTINCT shape");
});

test("UNDER THE CEILING the rule still answers, on a graph two orders of magnitude past any authored one", () => {
  const N = 4000;
  const r = attempt(compiled(chainSpec(N)), mutation({ ...chainGraft(N), proposedByNode: n("c0") }));
  assert.equal(r.ok, false);
  assert.ok(
    r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.at?.nodeId === `c${String(N - 1)}`),
    r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", "),
  );
});

test("OVER THE CEILING it refuses rather than running, and says which bound it hit", () => {
  const N = 4200;
  const r = attempt(compiled(chainSpec(N)), mutation({ ...chainGraft(N), proposedByNode: n("c0") }));
  assert.equal(r.ok, false);
  const hit = r.diagnostics.find((d) => d.code === "MUT003_NOT_DOMINATED" && /past the 4096/.test(d.message));
  assert.ok(hit, r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join(" | "));
});

/**
 * THE FOURTH SHAPE, and it is neither an edge kind nor a node type: a ROLE.
 *
 * `#fireEmptyJoin` walks `outbound(fanout.to)` for `join` edges and readies the join at the
 * parent branch when a fanout's item list is EMPTY. So an added `fanout` edge over a channel
 * nobody writes, pointed at an ordinary BRANCH node, satisfies the barrier with nothing executed
 * at all — and the branch node's own dominators do not move, because the graft comes from a node
 * that already dominated it. Reproduced at `f3cec2b`: `ok = true` with zero diagnostics, and end
 * to end `ran = ["fn","fn","note.append"]` after a rejection against the control's `["fn"]`.
 *
 * The rule now bans a graft into anything that REPORTS to a barrier — a node with an outbound
 * `join` edge — rather than into a barrier. Both functions that decide whether a barrier is
 * satisfied reach the join that way, which is why the property is read off the mechanism.
 */
function fanoutJoinSpec(): GraphSpec {
  const base = gatedSpec();
  const plan = base.nodes[0]!;
  const gate = base.nodes[1]!;
  const pay = base.nodes[2]!;
  return {
    ...base,
    channels: {
      ...base.channels,
      b: { type: "array", reduce: "append_ordered" },
      items: { type: "array", reduce: "replace" },
      none: { type: "array", reduce: "replace" },
      it: { type: "object", reduce: "replace" },
    },
    inputs: ["goal", "items"],
    nodes: [
      plan,
      gate,
      { id: n("B"), type: "function", reads: ["plan"], writes: ["b"], function: { ref: "function/detail@stable" } },
      { id: n("j"), type: "join", reads: [], writes: [], join: { branches: [n("gate"), n("B")], mode: "all", onBranchError: "fail" } },
      pay,
    ],
    edges: [
      { id: e("a0"), from: n("plan"), to: n("gate"), kind: "fanout", over: "items", as: "it", maxWidth: 2 },
      { id: e("a2"), from: n("plan"), to: n("B"), kind: "fanout", over: "items", as: "it", maxWidth: 2 },
      { id: e("a3"), from: n("gate"), to: n("j"), kind: "join" },
      { id: e("a4"), from: n("B"), to: n("j"), kind: "join" },
      { id: e("a5"), from: n("j"), to: n("pay"), kind: "seq" },
    ],
  } as unknown as GraphSpec;
}

const EMPTY_FANOUT_GRAFT: Partial<GraphMutation> = {
  addNodes: [{ ...HOP, reads: [] } as unknown as NodeSpec],
  addEdges: [
    { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
    { id: e("m1"), from: n("hop"), to: n("B"), kind: "fanout", over: "none", as: "it", maxWidth: 2 } as unknown as EdgeSpec,
  ],
};

test("A GRAFT INTO A NODE THAT REPORTS TO A BARRIER IS REFUSED, even though its own dominators do not move", () => {
  const r = attempt(compiled(fanoutJoinSpec()), mutation(EMPTY_FANOUT_GRAFT));
  assert.equal(r.ok, false, "an empty fanout into a branch node fires the join with nothing executed");
  assert.ok(
    r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.at?.nodeId === "B"),
    r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join(" | "),
  );
});

test("…AND ITS CONTROL: on that same graph a mutation that touches neither the join nor a branch is accepted", () => {
  const r = attempt(
    compiled(fanoutJoinSpec()),
    mutation({ addNodes: [{ ...HOP, reads: [] } as unknown as NodeSpec], addEdges: [{ id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" }] }),
  );
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
});

// ── end to end, through the engine ───────────────────────────────────────────

interface Rig {
  readonly engine: Engine;
  readonly store: MemoryStateStore;
  readonly ran: string[];
}

function rig(script: MockScript): Rig {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  const functions = new FunctionRegistry();
  const models = new ModelRegistry();
  const ran: string[] = [];

  const note: ToolDefinition = {
    ...NOTE,
    description: "Append a note.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      ran.push("note.append");
      return { content: "appended" };
    },
  };
  tools.register(note);
  functions.register("function/detail@stable", () => {
    ran.push("hop");
    return {};
  });
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
    }),
    store,
    ran,
  };
}

const GRAFTER: MockScript = () => ({
  text: JSON.stringify({ plan: { ok: true }, mutation: GRAFT }),
  finishReason: "stop",
});

/** The same bypass one edge kind over — the shape the first version of this rule let through. */
const LOOP_GRAFTER: MockScript = () => ({
  text: JSON.stringify({
    plan: { ok: true },
    mutation: {
      addNodes: [{ ...HOP, reads: ["out"] }],
      addEdges: [
        { id: "m0", from: "plan", to: "hop", kind: "seq" },
        { id: "m1", from: "hop", to: "pay", kind: "loop", until: "has(out)", maxIterations: 2 },
      ],
    },
  }),
  finishReason: "stop",
});
const HONEST: MockScript = () => ({ text: JSON.stringify({ plan: { ok: true } }), finishReason: "stop" });

test("A HUMAN REJECTS AND THE TOOL DOES NOT RUN, on a graph a model tried to graft around", async () => {
  const r = rig(GRAFTER);
  const runId = await r.engine.submit({ graph: compiled(), inputs: { goal: "go" } });
  let p = await r.engine.advance(runId);

  // The proposal is refused at compile, so the run never reaches the gate — it fails on the
  // mutation instead. Either way the claim under test is the last line: `note.append` never
  // ran, where at 294e713 it ran after the rejection.
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
  }
  assert.notEqual(p.status, "succeeded");
  assert.deepEqual(r.ran, [], "the tool the gate stands in front of must not have run");
});

test("…AND THE SAME THING THROUGH A `loop` EDGE, which is how the first version of this rule was defeated", async () => {
  const r = rig(LOOP_GRAFTER);
  const runId = await r.engine.submit({ graph: compiled(), inputs: { goal: "go" } });
  let p = await r.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
  }
  assert.notEqual(p.status, "succeeded");
  assert.deepEqual(r.ran, [], "a loop edge is a path the executor takes, so it is a path this rule must see");
});

/**
 * The same bypass a THIRD way: the graft, plus a `loop` edge back to the ENTRY node.
 *
 * `dominators` seeded `{itself}` for a node with no predecessor. Add a back-edge into the entry
 * and NO node has an empty predecessor list, so every set stays at "everything dominates me" and
 * nothing can report a LOST dominator — the guard answers its undecidable case with the passing
 * value. The seed is the graph's entry set now, and an entry is not recomputed from its
 * predecessors, which is what makes a back-edge into it harmless rather than fatal.
 */
test("A LOOP BACK TO THE ENTRY NODE DOES NOT ERASE THE SEED, and the graft is still refused", () => {
  const r = attempt(
    compiled(),
    mutation({
      addNodes: [{ ...HOP, reads: ["plan", "out"] } as unknown as NodeSpec],
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
        { id: e("m1"), from: n("hop"), to: n("pay"), kind: "seq" },
        { id: e("m2"), from: n("hop"), to: n("plan"), kind: "loop", until: "has(plan)", maxIterations: 2 } as unknown as EdgeSpec,
      ],
    }),
  );
  assert.equal(r.ok, false, "a back-edge into the entry must not turn the check off");
  assert.ok(
    r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.at?.nodeId === "pay"),
    r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join(" | "),
  );
});

/**
 * THE SAME ERASED SEED WITH NO MUTATED LOOP EDGE AT ALL, and this is the likelier real graph:
 * "retry from the start until done" is an ordinary authored shape, so the back-edge is in the
 * BASE spec and the model proposes only the plain graft. Nothing about the mutation looks
 * unusual; the base graph alone was enough to turn the check off.
 */
test("AN AUTHORED BACK-EDGE INTO THE ENTRY DOES NOT EXCUSE THE GRAFT EITHER", () => {
  const spec = gatedSpec();
  const looped = {
    ...spec,
    edges: [
      ...spec.edges,
      { id: e("a2"), from: n("pay"), to: n("plan"), kind: "loop", until: "has(out)", maxIterations: 2 },
    ],
  } as unknown as GraphSpec;
  const r = attempt(compiled(looped), mutation());
  assert.equal(r.ok, false, "the base graph's own loop must not turn the check off");
  assert.ok(
    r.diagnostics.some((d) => d.code === "MUT003_NOT_DOMINATED" && d.at?.nodeId === "pay"),
    r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join(" | "),
  );
});

test("…AND ITS CONTROL: on that same looped base, a mutation that does not bypass is accepted", () => {
  const spec = gatedSpec();
  const looped = {
    ...spec,
    edges: [
      ...spec.edges,
      { id: e("a2"), from: n("pay"), to: n("plan"), kind: "loop", until: "has(out)", maxIterations: 2 },
    ],
  } as unknown as GraphSpec;
  const r = attempt(compiled(looped), mutation({ addEdges: [{ id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" }] }));
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
});

test("…AND THE CONTROL: the loop back to the entry ON ITS OWN is still accepted", () => {
  // Without the grafting edge `hop -> pay` the same back-edge takes nothing away, so this is
  // what keeps the test above from passing for the wrong reason (a rule that refuses every
  // mutation carrying a loop edge would pass it).
  const r = attempt(
    compiled(),
    mutation({
      addNodes: [{ ...HOP, reads: ["plan", "out"] } as unknown as NodeSpec],
      addEdges: [
        { id: e("m0"), from: n("plan"), to: n("hop"), kind: "seq" },
        { id: e("m2"), from: n("hop"), to: n("plan"), kind: "loop", until: "has(plan)", maxIterations: 2 } as unknown as EdgeSpec,
      ],
    }),
  );
  assert.equal(r.ok, true, r.ok ? "" : JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
});

/** The graft plus a back-edge into the entry — the shape that erased the dominator seed. */
const ENTRY_LOOP_GRAFTER: MockScript = () => ({
  text: JSON.stringify({
    plan: { ok: true },
    mutation: {
      addNodes: [{ ...HOP, reads: ["plan", "out"] }],
      addEdges: [
        { id: "m0", from: "plan", to: "hop", kind: "seq" },
        { id: "m1", from: "hop", to: "pay", kind: "seq" },
        { id: "m2", from: "hop", to: "plan", kind: "loop", until: "has(plan)", maxIterations: 2 },
      ],
    },
  }),
  finishReason: "stop",
});

test("…AND THE SAME THING WITH A BACK-EDGE INTO THE ENTRY, which turned the whole check off", async () => {
  const r = rig(ENTRY_LOOP_GRAFTER);
  const runId = await r.engine.submit({ graph: compiled(), inputs: { goal: "go" } });
  let p = await r.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
  }
  assert.notEqual(p.status, "succeeded");
  assert.deepEqual(r.ran, [], "no node with an empty predecessor list is not the same as no entry");
});

/** The join bypass end to end — the shape `dominators` could not see, because it never held the gate. */
const JOIN_GRAFTER: MockScript = () => ({
  text: JSON.stringify({
    plan: { ok: true },
    mutation: {
      addNodes: [{ ...HOP, reads: [] }],
      addEdges: [
        { id: "m0", from: "plan", to: "hop", kind: "seq" },
        { id: "m1", from: "hop", to: "j", kind: "seq" },
      ],
    },
  }),
  finishReason: "stop",
});

test("…AND THE SAME THING THROUGH A `join` NODE, where a seq edge fires the barrier with nothing arrived", async () => {
  const r = rig(JOIN_GRAFTER);
  const runId = await r.engine.submit({ graph: compiled(joinSpec()), inputs: { goal: "go" } });
  let p = await r.engine.advance(runId);
  if (p.status === "awaiting_gate") {
    const gate = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: "k",
    });
  }
  assert.notEqual(p.status, "succeeded");
  assert.deepEqual(
    r.ran.filter((x) => x === "note.append"),
    [],
    "the tool the gate stands in front of must not have run",
  );
});

/** The empty-fanout bypass — the fourth shape, end to end. */
const EMPTY_FANOUT_GRAFTER: MockScript = () => ({
  text: JSON.stringify({
    plan: { ok: true },
    mutation: {
      addNodes: [{ ...HOP, reads: [] }],
      addEdges: [
        { id: "m0", from: "plan", to: "hop", kind: "seq" },
        { id: "m1", from: "hop", to: "B", kind: "fanout", over: "none", as: "it", maxWidth: 2 },
      ],
    },
  }),
  finishReason: "stop",
});

test("…AND THE SAME THING THROUGH AN EMPTY FANOUT INTO A BRANCH, which executes nothing and fires the join", async () => {
  const r = rig(EMPTY_FANOUT_GRAFTER);
  const runId = await r.engine.submit({ graph: compiled(fanoutJoinSpec()), inputs: { goal: "go", items: ["x"] } });
  let p = await r.engine.advance(runId);
  for (let i = 0; i < 4 && p.status === "awaiting_gate"; i++) {
    const gate = Object.values(p.gates).find((g) => g.state === "open");
    if (gate === undefined) break;
    p = await r.engine.resolveGate(runId, {
      gateId: gate.gateId,
      decision: { kind: "reject", reason: "no" },
      actor: { kind: "human", subject: "u:a", via: "console" },
      idempotencyKey: `k${String(i)}`,
    });
  }
  assert.notEqual(p.status, "succeeded");
  assert.deepEqual(
    r.ran.filter((x) => x === "note.append"),
    [],
    "the tool the gate stands in front of must not have run",
  );
});

test("THE ORDINARY HALF END TO END: the same graph, no mutation, approve and the tool runs", async () => {
  const r = rig(HONEST);
  const runId = await r.engine.submit({ graph: compiled(), inputs: { goal: "go" } });
  let p = await r.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.ran, []);

  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(r.ran, ["note.append"], "an approved gate still lets the work through");
});

test("AND THE REJECTION CONTROL: no mutation, human rejects, the tool does not run", async () => {
  const r = rig(HONEST);
  const runId = await r.engine.submit({ graph: compiled(), inputs: { goal: "go" } });
  let p = await r.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await r.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "reject", reason: "no" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });
  assert.equal(p.status, "failed");
  assert.deepEqual(r.ran, []);
});
