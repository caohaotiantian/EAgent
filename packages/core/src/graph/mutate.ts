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
  // a mutation legitimately feeds an existing node; this admits a step added in front of a node
  // only the proposer dominated.
  //
  // WHAT IT ADMITS IS NARROW, and saying it "admits exactly the cases that keep the property"
  // overstated it. An accepted graft must descend from EVERY existing dominator of its target,
  // so in most graphs the admitted set is close to the shape-ban. It also refuses one shape that
  // TIGHTENS oversight: a mutation inserting a new `human_gate` in front of an existing node
  // displaces that node's prior dominator and is refused with everything else. Refusing a
  // tightening is safe and is the direction this project always takes when a guard cannot
  // decide, but it is a real limitation and not a design intent.
  //
  // AND IT GUARDS THE NODE, NOT THE ACTION. A mutation that adds its OWN `tool` node naming the
  // same tool the gate stands in front of is not an `added -> existing` edge at all, reaches
  // none of this, and still runs after a rejection. That hole is older than this rule and wider
  // than it: `gatedNodes` below escalates an added node only when `isHardToUndo`, so a
  // `reversible_write` whose only oversight is an authored gate is not covered anywhere. The
  // invariant that would close it is about the TOOL rather than the node id.
  //
  // PROPOSER-DOMINANCE WOULD NOT HAVE WORKED, and it was the obvious rule: the proposer of a
  // mutation is almost always an ancestor of everything it could graft onto — in the measured
  // repro `plan` is the entry node — so "is the target already dominated by the proposer" is
  // satisfied by the exact graph the rule exists to refuse.
  //
  // WHICH VERBS REACH THIS GUARD: one. `compileMutation` is called from `#applyMutation`, on the
  // live commit path, and from nowhere else. `#rehydrateGraph` — the attach and replay path —
  // folds every `graph.mutated` onto the authored spec and calls `compile`, so a journal that
  // ALREADY carries a grafting mutation is rebuilt with none of this checked. Two things follow,
  // and the second is owed to `run/engine.ts` rather than to this file. Nothing here breaks
  // replay, which is the opposite of what `03b03fb`'s commit body says: the grafted spec still
  // compiles, so an old journal still folds. And a pre-fix journal keeps its bypass, because the
  // only door that refuses it is the one the mutation already came through.
  //
  // ONLY WHEN SUCH AN EDGE EXISTS, which is what keeps this free for every other mutation. An
  // existing node's inbound edges can only change through an `added -> existing` edge, and a
  // path that leaves the added region can only come back through one, so with none of them
  // present no existing node's dominators can move.
  //
  // OVER EVERY EDGE THE EXECUTOR CAN TRAVERSE, which is not `dagEdges` and was `dagEdges` first.
  // Dominance means "every execution path to this node passes through that one", so the edge set
  // has to be the one the executor actually walks; an edge left out of it is a path the check
  // cannot see. `dagEdges` drops `loop` AND `compensation`, and the argument that this was safe —
  // that a `loop` edge whose target cannot reach its source is GRAPH006_STUCK_LOOP — was an
  // accident of the fixture it was measured on. `rule006Cycles` asks `nodesInCycle`, so the loop
  // is refused only when neither endpoint writes a channel the `until` reads; give the added node
  // one read the `until` touches and it compiles:
  //
  //     m1 = { from: hop, to: pay, kind: "loop", until: "has(out)" }, hop reads ["out"]
  //     -> ok = true, and `#edgesToTake` DOES take a loop edge, so the human rejects and the
  //        tool runs: ran = ["hop", "note.append"]
  //
  // which is the defect this rule exists to close, arriving one edge kind over. `compensation`
  // is the ONLY kind that may be dropped, and for a reason `dagEdges` does not encode: nothing
  // ever traverses one — `#edgesToTake` answers `case "compensation": break;` and rollback is
  // journal-driven. `error` edges stay in, because `#errorEdges` dispatches them on failure.
  const grafts = mutation.addEdges.filter((e) => added.has(e.from) && !added.has(e.to) && existingNodes.has(e.to));
  if (grafts.length > 0) {
    const traversable = (g: GraphSpec): readonly EdgeSpec[] => g.edges.filter((e) => e.kind !== "compensation");
    const grafted: GraphSpec = {
      ...spec,
      nodes: [...spec.nodes, ...mutation.addNodes],
      edges: [...spec.edges, ...mutation.addEdges],
    };
    const baseIdx = indexGraph(spec);
    const graftedIdx = indexGraph(grafted);
    const before = dominators(spec.nodes, traversable(spec), baseIdx.topoOrder, baseIdx.entryNodes);
    const after = dominators(grafted.nodes, traversable(grafted), graftedIdx.topoOrder, graftedIdx.entryNodes);
    const named = grafts.map((e) => `"${e.id}"`).join(", ");
    // NO ENTRY, NO ANSWER. Dominance is defined relative to where the run starts, so a grafted
    // graph with no entry node makes the question undecidable rather than false — and an
    // undecidable guard refuses. `compile` would also refuse it GRAPH001_NO_ENTRY, but this rule
    // may not depend on another rule running first to avoid answering "accepted".
    if (graftedIdx.entryNodes.length === 0) {
      diagnostics.push({
        severity: "error",
        code: "MUT003_NOT_DOMINATED",
        message:
          `edge ${named} leaves the graph with no entry node, so what dominates ` +
          `"${grafts[0]!.to}" cannot be decided; a mutation may not make that question unanswerable`,
        at: { edgeId: grafts[0]!.id },
      });
    }
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
 * SEEDED FROM THE GRAPH'S ENTRY SET, and it used to seed "every node whose predecessor list is
 * empty" instead. Those are the same set only while the edges are acyclic, and this walk stopped
 * being acyclic the moment `loop` edges joined it. A mutation that adds a back-edge into the
 * entry node leaves NO node with an empty predecessor list, every set then stays at "everything
 * dominates me" for want of a seed, and nothing can report a LOST dominator — so the graft the
 * caller exists to refuse was accepted. Measured on the gated fixture, `{plan->hop, hop->pay,
 * hop->plan loop}`: `ok = true`, and end to end the human rejected and the tool ran
 * (`ran = ["hop", "note.append"]`). An entry is not recomputed from its predecessors, which is
 * what makes a back-edge into it harmless instead of fatal.
 *
 * `entryNodes` is `indexGraph`'s — "no inbound edge of any kind EXCEPT a loop back-edge", which
 * is the set the executor actually starts from, so this asks the same question the run answers.
 *
 * Everything that is not an entry starts at "every node dominates me" and shrinks, which is what
 * makes the fixpoint converge from the safe side — a node the walk never reaches keeps the full
 * set rather than the empty one, so an unreachable region cannot report a LOST dominator it
 * never had.
 *
 * IN TOPOLOGICAL ORDER, and that is a cost fix rather than a preference. Sweeping in
 * declaration order needs one pass per level when a graph is declared backwards, and this runs
 * on the RUN path because `#commit` calls `compileMutation`. Measured on a chain of N nodes
 * declared in reverse, one added node, one grafting edge:
 *
 *     N          declaration order      topological order      no graft (rule skipped)
 *     200                  155 ms                    8 ms                       4 ms
 *     400                1,160 ms                   18 ms                       8 ms
 *     800               13,947 ms                   76 ms                      18 ms
 *
 * Visiting a node after its predecessors converges in one sweep, and it also makes declaration
 * order stop mattering: the same 800-node graph declared FORWARD costs 75 ms either way.
 * `topoOrder` is empty when the forward graph is cyclic and omits nodes only `loop` edges
 * reach, so anything missing from it is appended and the loop still runs to a fixpoint; the
 * ORDER is an optimisation and never part of the answer.
 *
 * Callers compare the result against the same computation over a graph with edges ADDED, and
 * look only at what a node LOST. Not at what it gained: a node with no inbound edge starts at
 * `{itself}`, so acquiring a predecessor GROWS its set — "adding an edge can only remove
 * dominators" is false for exactly that node, and this used to say so.
 */
function dominators(
  nodes: readonly NodeSpec[],
  edges: readonly EdgeSpec[],
  topoOrder: readonly NodeId[],
  entryNodes: readonly NodeId[],
): ReadonlyMap<NodeId, ReadonlySet<NodeId>> {
  const ids = nodes.map((n) => n.id);
  const preds = new Map<NodeId, NodeId[]>();
  for (const id of ids) preds.set(id, []);
  for (const e of edges) preds.get(e.to)?.push(e.from);

  const entries = new Set<NodeId>(entryNodes.filter((id) => preds.has(id)));
  // A node with no predecessor at all is an entry too even where `entryNodes` disagrees — it is
  // unreachable, and seeding it `{itself}` keeps it out of every other node's intersection.
  for (const id of ids) if (preds.get(id)!.length === 0) entries.add(id);

  const dom = new Map<NodeId, Set<NodeId>>();
  for (const id of ids) dom.set(id, entries.has(id) ? new Set([id]) : new Set(ids));

  const seen = new Set<NodeId>(topoOrder);
  const order = [...topoOrder.filter((id) => preds.has(id)), ...ids.filter((id) => !seen.has(id))];

  for (let changed = true; changed; ) {
    changed = false;
    for (const id of order) {
      if (entries.has(id)) continue;
      const p = preds.get(id)!;
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
