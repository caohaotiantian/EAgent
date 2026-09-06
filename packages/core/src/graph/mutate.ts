/**
 * Dynamic graph mutation.
 *
 * Statically-authored graphs cover most work. Some genuinely cannot be planned ahead,
 * so an agent node may **propose** new nodes — and proposal is separated from
 * execution by the same compiler that validates authored graphs. A model can propose a
 * graph that is wrong; it cannot propose one that weakens oversight, overcommits
 * budget, or races on a channel, because those are compile errors.
 *
 * ADDITIVE ONLY. A mutation may add nodes and edges within the proposer's region. It
 * may not change or remove an existing node, edge, channel, or policy field.
 *
 * That restriction is not timidity — it is what keeps replay and incremental rendering
 * simple. Removal introduces "what happened to the branch already running through the
 * deleted edge?", a question with no cheap answer, and it would let a mutation
 * retroactively change the meaning of events already in the journal.
 *
 */

import { CODES, err, type LoomError } from "../errors.ts";
import type { NodeId, TaskId } from "../ids.ts";
import { compile, type CompileInput } from "./compile.ts";
import type { EdgeSpec, ExpansionBudget, GraphSpec, NodeSpec, RunGraph } from "./spec.ts";
import { indexGraph, reachableToolNamesThrough, type Diagnostic } from "./validate.ts";
import { isHardToUndo } from "../vocab.ts";

export interface GraphMutation {
  readonly addNodes: readonly NodeSpec[];
  readonly addEdges: readonly EdgeSpec[];
  /** The Task proposing it. Added nodes must be dominated by its node. */
  readonly proposedBy: TaskId;
  readonly proposedByNode: NodeId;
  readonly reason?: string;
}

export interface MutationBudget {
  /** Nodes already added by earlier mutations in this run. */
  readonly consumedNodes: number;
  readonly expansion: ExpansionBudget;
}

export type MutationResult =
  | {
      readonly ok: true;
      readonly graph: RunGraph;
      readonly diagnostics: readonly Diagnostic[];
      /** True when a newly added node is hard to undo and must gate before it runs. */
      readonly requiresGate: boolean;
      /** Exactly which added nodes need one. Escalating these beats escalating the run. */
      readonly gatedNodes: readonly NodeId[];
      readonly addedNodes: readonly NodeId[];
    }
  | { readonly ok: false; readonly error: LoomError; readonly diagnostics: readonly Diagnostic[] };

export interface MutateInput extends Omit<CompileInput, "spec"> {
  readonly base: RunGraph;
  readonly mutation: GraphMutation;
  readonly budget: MutationBudget;
}

/**
 * Validate a proposed mutation against a running graph.
 *
 * Pure and side-effect free: it returns the compiled successor graph or a diagnostic
 * list, and never touches the run. The executor decides what to do with the answer.
 */
export function compileMutation(input: MutateInput): MutationResult {
  const { base, mutation, budget } = input;
  const spec = base.spec;
  const diagnostics: Diagnostic[] = [];

  // ── 1. additive only ─────────────────────────────────────────────────────
  const existingNodes = new Set(spec.nodes.map((n) => n.id));
  const existingEdges = new Set(spec.edges.map((e) => e.id));

  for (const n of mutation.addNodes) {
    if (existingNodes.has(n.id)) {
      diagnostics.push({
        severity: "error",
        code: "MUT001_NOT_ADDITIVE",
        message: `mutation redefines existing node "${n.id}"`,
        at: { nodeId: n.id },
        fix: "give the added node a new id; a mutation may not change an existing one",
      });
    }
    for (const w of n.writes ?? []) {
      if (!(w in spec.channels)) {
        // A mutation cannot introduce channels either — the channel set is part of
        // what the compiled graph promised, and downstream folds depend on it.
        diagnostics.push({
          severity: "error",
          code: "MUT002_NEW_CHANNEL",
          message: `added node "${n.id}" writes "${w}", which the running graph does not declare`,
          at: { nodeId: n.id, channel: w },
        });
      }
    }
    if (n.policy?.posture !== undefined && n.policy.posture === "out") {
      // Not an error — the `max` fold ignores it — but worth saying out loud, because
      // an author reading the mutation should not believe it lowered anything.
      diagnostics.push({
        severity: "warning",
        code: "MUT005_POSTURE_NO_EFFECT",
        message: `added node "${n.id}" declares posture "out"; the run's floor still applies`,
        at: { nodeId: n.id },
      });
    }
  }
  for (const e of mutation.addEdges) {
    if (existingEdges.has(e.id)) {
      diagnostics.push({
        severity: "error",
        code: "MUT001_NOT_ADDITIVE",
        message: `mutation redefines existing edge "${e.id}"`,
        at: { edgeId: e.id },
      });
    }
  }

  // ── 2. dominated by the proposer ─────────────────────────────────────────
  //
  // Every added node must be reachable only THROUGH the proposing node. Otherwise a
  // mutation could graft work onto an unrelated part of the graph — including a part
  // that has already run, whose journal entries would then mean something different.
  const added = new Set(mutation.addNodes.map((n) => n.id));
  for (const e of mutation.addEdges) {
    const fromAdded = added.has(e.from);
    const fromProposer = e.from === mutation.proposedByNode;
    if (added.has(e.to) && !fromAdded && !fromProposer) {
      diagnostics.push({
        severity: "error",
        code: "MUT003_NOT_DOMINATED",
        message: `added node "${e.to}" is reachable from "${e.from}", which is neither the proposer nor another added node`,
        at: { edgeId: e.id },
        fix: `route the edge from "${mutation.proposedByNode}" or from another added node`,
      });
    }
    if (!added.has(e.to) && !added.has(e.from)) {
      diagnostics.push({
        severity: "error",
        code: "MUT003_NOT_DOMINATED",
        message: `edge "${e.id}" connects two EXISTING nodes; a mutation may only wire into what it adds`,
        at: { edgeId: e.id },
      });
    }
  }

  // ── 2b. and the region an existing node sits in may not shrink ───────────
  //
  // THE THIRD EDGE DIRECTION, which the two clauses above do not name. `added -> existing` is
  // neither "into an added node from a stranger" nor "between two existing nodes", so it was
  // accepted with no diagnostic at all — and because seq edges are OR-joined (`task.ready` is
  // emitted per satisfied edge; only `kind: "join"` is a barrier), it is a SECOND path to the
  // node it points at. Point it at a node an authored `human_gate` stands in front of and the
  // gate is no longer on every path to it: the human rejects, `gate.decided` carries an
  // unconditional `run.resumed`, and the grafted task is ready. A rejection releases the action
  // it was meant to stop. Measured at 294e713 on a `human_gate` in front of a
  // `reversible_write` tool, with no operator de-escalation anywhere: the graft ran the tool
  // (`charged=1`) where the unmutated control did not (`charged=0`).
  //
  // DOMINATOR PRESERVATION, not a ban on the direction. The invariant oversight actually rests
  // on is "every path to this node still passes through what it passed through before", which
  // is what this module's opening claim — a model "cannot propose one that weakens oversight" —
  // already promises. A ban would refuse by shape and would have to be reopened the first time
  // a mutation legitimately feeds an existing node; this admits exactly the cases that keep the
  // property, such as a step added in front of a node only the proposer dominated.
  //
  // PROPOSER-DOMINANCE WOULD NOT HAVE WORKED, and it was the obvious rule: the proposer of a
  // mutation is almost always an ancestor of everything it could graft onto — in the measured
  // repro `plan` is the entry node — so "is the target already dominated by the proposer" is
  // satisfied by the exact graph the rule exists to refuse.
  //
  // ONLY WHEN SUCH AN EDGE EXISTS, which is what keeps this free for every other mutation. An
  // existing node's inbound edges can only change through an `added -> existing` edge, and a
  // path that leaves the added region can only come back through one, so with none of them
  // present no existing node's dominators can move.
  //
  // OVER `dagEdges`, so `loop` and `compensation` are excluded — and that is not the hole it
  // looks like. Measured on the gated graph above, every other kind is caught here (`seq`,
  // `conditional`, `error`, `join`, `fanout` all report MUT003), and the two excluded ones
  // cannot form the shape at all: a `loop` edge whose target cannot reach its source is
  // GRAPH006_STUCK_LOOP, and reaching an added node from an existing one needs an
  // `existing -> added` edge, which clause 1 above already refuses for everything but the
  // proposer. So the only loop a mutation can add re-enters AT OR ABOVE the proposer — `hop ->
  // plan` compiles, `hop -> gate` and `hop -> pay` are refused — and a path through the
  // proposer passes through every dominator the proposer has, which is a superset of the ones
  // its own ancestors need.
  const grafts = mutation.addEdges.filter((e) => added.has(e.from) && !added.has(e.to) && existingNodes.has(e.to));
  if (grafts.length > 0) {
    const before = dominators(spec.nodes, indexGraph(spec).dagEdges);
    const grafted: GraphSpec = {
      ...spec,
      nodes: [...spec.nodes, ...mutation.addNodes],
      edges: [...spec.edges, ...mutation.addEdges],
    };
    const after = dominators(grafted.nodes, indexGraph(grafted).dagEdges);
    const named = grafts.map((e) => `"${e.id}"`).join(", ");
    for (const v of spec.nodes) {
      const lost = [...(before.get(v.id) ?? [])].filter((id) => !(after.get(v.id)?.has(id) ?? false));
      if (lost.length === 0) continue;
      const which = lost.map((id) => `"${id}"`).join(", ");
      diagnostics.push({
        severity: "error",
        code: "MUT003_NOT_DOMINATED",
        message:
          `edge ${named} gives "${v.id}" a path that does not pass through ${which}; a mutation may not take ` +
          `an existing node out of the region that already dominated it`,
        at: { nodeId: v.id },
        fix: `re-enter downstream of ${which}, or drop the edge into "${v.id}"`,
      });
    }
  }

  // ── 3. expansion budget ──────────────────────────────────────────────────
  const wouldConsume = budget.consumedNodes + mutation.addNodes.length;
  if (wouldConsume > budget.expansion.maxNodes) {
    diagnostics.push({
      severity: "error",
      code: "MUT004_EXPANSION_EXHAUSTED",
      message: `mutation would take the run to ${wouldConsume} added nodes, over the expansion budget of ${budget.expansion.maxNodes}`,
    });
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return {
      ok: false,
      diagnostics,
      error: err.policy(CODES.E_EXPANSION_EXHAUSTED, `mutation rejected: ${diagnostics.filter((d) => d.severity === "error").length} error(s)`, {
        details: { diagnostics: diagnostics.filter((d) => d.severity === "error") },
      }),
    };
  }

  // ── 4. the identical compile every authored graph goes through ───────────
  const merged: GraphSpec = {
    ...spec,
    nodes: [...spec.nodes, ...mutation.addNodes],
    edges: [...spec.edges, ...mutation.addEdges],
  };

  const result = compile({
    ...input,
    spec: merged,
    // The BASELINE is the running graph's own postures. A mutation that would lower
    // any of them fails with E_OVERSIGHT_LOOSENED, exactly as a candidate would.
    baselinePostures: Object.fromEntries(Object.entries(base.plans).map(([id, p]) => [id, p.posture])),
  });

  if (!result.ok) {
    return { ok: false, error: result.error, diagnostics: [...diagnostics, ...result.diagnostics] };
  }

  // ── 5. does anything newly added need a human first? ─────────────────────
  //
  // A mutation that introduces a hard-to-undo action gates BEFORE that node runs,
  // whatever the run's posture — a graph that grew a new irreversible step at runtime
  // is exactly the case where "somebody should look" is not negotiable.
  // THE COMPILED TREE FIRST, the live resolver second. `result.graph.subgraphs` is what the
  // executor will run, and it already covers every ref the merged spec can reach — but a
  // mutation that ADDS a `subgraph` node naming a ref the base never mentioned is exactly the
  // case this rule exists for, and `resolveSubgraphs` walks the merged spec, so it is in there.
  // The fallback is the older-`RunGraph` guard `#runSubgraph` uses, not a second policy.
  const childSpec = (ref: string): GraphSpec | undefined => result.graph.subgraphs?.[ref] ?? input.resolver.subgraph?.(ref);
  // One memo across the whole filter: several added nodes may delegate to the same ref, and
  // each `reachableToolNamesThrough` call would otherwise re-walk that subtree from scratch.
  const reachMemo = new Map<string, readonly string[]>();
  const gatedNodes = mutation.addNodes
    .filter((n) =>
      // Reachable, not named. A proposed `agent` node names no tool, so keying on
      // `n.tool` let a mutation that hands a model an irreversible tool through with
      // `requiresGate: false` — the one case this rule calls non-negotiable.
      //
      // AND THROUGH A SUBGRAPH, for the same reason one step further out: a proposed `subgraph`
      // node names no tool either, so a mutation that delegates an irreversible action to a
      // child came back `requiresGate: false` and the parent journal recorded no
      // `policy.escalated{rule: mutation_introduced_irreversible}` at all. The child still
      // gated on its own floor, so this is not an oversight hole — what it fixes is a parent
      // trajectory that could not be read, and a human asked after the child had already done
      // reversible work.
      reachableToolNamesThrough(n, childSpec, result.graph.expansion.maxDepth, reachMemo).some((name) => {
        const manifest = input.tools[name];
        // `isHardToUndo`, never the two names spelled out: the positive form falls through as
        // EASY for a class this binary cannot read, which is the one direction a gate may not
        // fail. A mutation is exactly where a hostile manifest arrives.
        return manifest !== undefined && isHardToUndo(manifest.irreversibility);
      }),
    )
    .map((n) => n.id);

  return {
    ok: true,
    graph: result.graph,
    diagnostics: [...diagnostics, ...result.diagnostics],
    requiresGate: gatedNodes.length > 0,
    gatedNodes,
    addedNodes: mutation.addNodes.map((n) => n.id),
  };
}

/**
 * Which nodes every path to each node must pass through.
 *
 * The textbook iterative fixpoint, and it is here rather than in `validate.ts` because one
 * caller needs it: nothing else in the compiler asks a dominance question, and a second export
 * on a pinned surface for a single use is a cost with no buyer.
 *
 * A node with no inbound edge is an entry and dominates only itself. Everything else starts at
 * "every node dominates me" and shrinks, which is what makes the fixpoint converge from the
 * safe side — a node the walk never reaches keeps the full set rather than the empty one, so an
 * unreachable region cannot report a LOST dominator it never had.
 *
 * Callers compare the result against the same computation over a graph with edges ADDED. That
 * direction is one-way: adding an edge can only remove dominators, never add one, so a base
 * node whose set is unchanged is one whose oversight region is intact.
 */
function dominators(nodes: readonly NodeSpec[], edges: readonly EdgeSpec[]): ReadonlyMap<NodeId, ReadonlySet<NodeId>> {
  const ids = nodes.map((n) => n.id);
  const preds = new Map<NodeId, NodeId[]>();
  for (const id of ids) preds.set(id, []);
  for (const e of edges) preds.get(e.to)?.push(e.from);

  const dom = new Map<NodeId, Set<NodeId>>();
  for (const id of ids) dom.set(id, preds.get(id)!.length === 0 ? new Set([id]) : new Set(ids));

  for (let changed = true; changed; ) {
    changed = false;
    for (const id of ids) {
      const p = preds.get(id)!;
      if (p.length === 0) continue;
      let next: Set<NodeId> | undefined;
      for (const q of p) {
        const dq = dom.get(q);
        if (dq === undefined) continue; // an edge from an id no node declares; `compile` reports it
        next = next === undefined ? new Set(dq) : new Set([...next].filter((x) => dq.has(x)));
      }
      if (next === undefined) continue;
      next.add(id);
      const cur = dom.get(id)!;
      if (next.size === cur.size && [...next].every((x) => cur.has(x))) continue;
      dom.set(id, next);
      changed = true;
    }
  }
  return dom;
}

/** Nodes reachable from a node, for a caller checking a proposer's region. */
export function descendantsOf(spec: GraphSpec, from: NodeId): ReadonlySet<NodeId> {
  const idx = indexGraph(spec);
  const out = new Set<NodeId>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of idx.outbound.get(id) ?? []) {
      if (out.has(e.to)) continue;
      out.add(e.to);
      stack.push(e.to);
    }
  }
  return out;
}
