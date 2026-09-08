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
    const named = grafts.map((e) => `"${e.id}"`).join(", ");
    const byId = new Map(spec.nodes.map((v) => [v.id, v]));

    // A `join` TARGET IS REFUSED OUTRIGHT, and here the shape-ban is the correct rule rather
    // than the lazy one. Two facts meet on it. `#edgesToTake` dispatches on the EDGE's kind and
    // not on the target node's type, so a `seq` edge into a join node takes the generic
    // `task.ready` arm and makes the join ready with ZERO branches arrived — the barrier is not
    // weakened, it is skipped. And `dominators` cannot see that it was: an `all` join fires only
    // when every branch arrives, so a gate in front of ONE branch is a must-execute ancestor of
    // the join, but an INTERSECTION over the branches can never contain it. `dom_before(j)`
    // never held the gate, so nothing could be lost. Measured on `plan -> gate -> A`,
    // `plan -> B`, `A|B -[join]-> j -> pay`, mutation `{plan->hop, hop->j seq}`: `ok = true`
    // with no diagnostic, and end to end the human rejected while `note.append` ran.
    //
    // WHY NOT MAKE `dominators` HONEST INSTEAD, which is the obvious repair — take the UNION of
    // the branch dominators for an `all` join rather than their intersection. Because the union
    // is not sound: `#fireEmptyJoin` fires a join whose fan-out produced NO branches, so a gate
    // inside a branch that never materialised did not execute, and a rule resting on the union
    // would call it a dominator anyway. It is unsound for `quorum` and `firstSuccess` for the
    // plainer reason that a named branch need not arrive at all. An under-approximated `before`
    // is safe here — it can only fail to refuse — and every node DOWNSTREAM of the join still
    // carries `j` itself in its set, so a graft that routes around the join loses `j` and is
    // caught by the loop below. The join node itself was the one hole, and it closes by
    // refusing rather than by guessing.
    for (const g of grafts) {
      if (byId.get(g.to)?.type !== "join") continue;
      diagnostics.push({
        severity: "error",
        code: "MUT003_NOT_DOMINATED",
        message:
          `edge "${g.id}" enters the join node "${g.to}"; an edge that is not a join edge makes a join ready ` +
          `with none of its branches arrived, so the barrier — and every gate standing in front of a branch — ` +
          `is skipped`,
        at: { nodeId: g.to },
        fix: `re-enter downstream of "${g.to}", or drop the edge`,
      });
    }

    // THE SIZE CEILING, and it is a refusal rather than a slow path. This runs inside `#commit`
    // on the live run, and it is reached only because a MODEL proposed an `added -> existing`
    // edge. Everything below is quadratic in the BASE graph's node count — the fixpoint in
    // bitset words, `indexGraph`'s own `ancestors` map in Set entries — and a quadratic a model
    // can reach on the commit path is an availability hole whatever its constant, so past a
    // bound the question is answered "refuse" rather than answered slowly. Measured on a chain
    // of N nodes with one graft edge, whole `compileMutation` call, against the same call with
    // the graft edge removed (which skips all of this):
    //
    //     N        with the graft          without it
    //     1000      46 ms /   49 MB
    //     2000     168 ms /  211 MB
    //     4000     675 ms /  467 MB
    //     8000    3093 ms / 1837 MB      1059 ms / 1033 MB
    //
    // The Set-of-Sets form this replaced was 115 ms / 122 MB at 1,000 and died of heap
    // exhaustion at 8,000, so the bound is the second of two fixes and not a substitute for the
    // first. 4,096 sits three orders of magnitude above any authored graph in this tree (the
    // largest is 7 nodes; `scale.test.ts` compiles 500) and below where the cost stops being
    // ordinary. It is a flat constant on purpose: the cost is driven by the BASE graph's size,
    // which `expansion.maxNodes` — a budget for ADDED nodes — says nothing about.
    if (grafted.nodes.length > MAX_DOMINATOR_NODES) {
      diagnostics.push({
        severity: "error",
        code: "MUT003_NOT_DOMINATED",
        message:
          `edge ${named} would need a dominator check over ${grafted.nodes.length} nodes, past the ` +
          `${MAX_DOMINATOR_NODES} this rule answers for; a mutation may not feed an existing node in a graph ` +
          `this large`,
        at: { edgeId: grafts[0]!.id },
      });
    } else {
    // AFTER the ceiling, not before it: `indexGraph` builds an `ancestors` Map of Sets that is
    // itself O(V^2), so calling it on an unbounded graph would put back the memory the bitset
    // and the ceiling just took out. Measured on the 8,000-node chain, this order is what turns
    // 1,838 MB into 1,033 MB — the whole remainder being `compile`'s own index, which every
    // mutation pays anyway.
    const baseIdx = indexGraph(spec);
    const graftedIdx = indexGraph(grafted);
    const before = dominators(spec.nodes, traversable(spec), baseIdx.topoOrder, baseIdx.entryNodes);
    const after = dominators(grafted.nodes, traversable(grafted), graftedIdx.topoOrder, graftedIdx.entryNodes);
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
      const lost = before.lostBy(v.id, after);
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
 * The largest graph the dominator rule answers for; past it the rule refuses. See the ceiling's
 * own comment in `compileMutation` for the measurements and for why it is flat.
 */
const MAX_DOMINATOR_NODES = 4096;

/** Dominator sets, held as one bit per (node, dominator) — see `dominators`. */
interface DomSets {
  /** The ids this node lost between the two computations; empty when its region is intact. */
  lostBy: (id: NodeId, after: DomSets) => readonly NodeId[];
  has: (id: NodeId, dominator: NodeId) => boolean;
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
 *
 * ONE BIT PER (NODE, DOMINATOR) rather than a `Set` per node, and that is an availability fix
 * rather than a tidy-up. The Set-of-Sets form allocated V sets of size V and a fresh
 * intersection per predecessor per sweep, on the LIVE commit path, reached because a model
 * proposed one `added -> existing` edge. Measured on a chain of N nodes with one graft edge:
 *
 *     N        Set-of-Sets              bitset
 *     1000     115 ms / 122 MB
 *     2000     456 ms / 428 MB
 *     4000    2111 ms / 1503 MB
 *     8000    heap out of memory        (and see the node ceiling at the caller)
 *
 * The same graph WITHOUT the graft edge finished in 2 s, so that one edge was the difference
 * between a working engine and a dead process. The bitset is V*ceil(V/32) words — 8 MB at
 * 8,000 — and the caller refuses past a node ceiling on top of it, because a bounded quadratic
 * is still a quadratic on a path a model can reach.
 *
 * The result is deliberately NOT a Map of Sets: materialising V sets of V ids to hand back
 * would put the memory straight back. `lostBy` walks one row against the other computation.
 */
function dominators(
  nodes: readonly NodeSpec[],
  edges: readonly EdgeSpec[],
  topoOrder: readonly NodeId[],
  entryNodes: readonly NodeId[],
): DomSets {
  const ids = nodes.map((n) => n.id);
  const at = new Map<NodeId, number>();
  ids.forEach((id, i) => at.set(id, i));
  const words = Math.max(1, Math.ceil(ids.length / 32));

  const preds: number[][] = ids.map(() => []);
  for (const e of edges) {
    const to = at.get(e.to);
    const from = at.get(e.from);
    // An edge from or to an id no node declares; `compile` reports it as its own diagnostic.
    if (to !== undefined && from !== undefined) preds[to]!.push(from);
  }

  const entries = new Set<number>();
  for (const id of entryNodes) {
    const i = at.get(id);
    if (i !== undefined) entries.add(i);
  }
  // A node with no predecessor at all is an entry too even where `entryNodes` disagrees — it is
  // unreachable, and seeding it `{itself}` keeps it out of every other node's intersection.
  for (let i = 0; i < ids.length; i++) if (preds[i]!.length === 0) entries.add(i);

  const rows: Uint32Array[] = [];
  for (let i = 0; i < ids.length; i++) {
    const row = new Uint32Array(words);
    if (entries.has(i)) row[i >>> 5]! |= 1 << (i & 31);
    else {
      row.fill(0xff_ff_ff_ff);
      // The tail past `ids.length` must stay clear or every row "differs" forever.
      const spare = words * 32 - ids.length;
      if (spare > 0) row[words - 1] = 0xff_ff_ff_ff >>> spare;
    }
    rows.push(row);
  }

  const seen = new Set<NodeId>(topoOrder);
  const order = [
    ...topoOrder.map((id) => at.get(id)).filter((i): i is number => i !== undefined),
    ...ids.map((id, i) => (seen.has(id) ? -1 : i)).filter((i) => i >= 0),
  ];

  const next = new Uint32Array(words);
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of order) {
      if (entries.has(i)) continue;
      const p = preds[i]!;
      next.set(rows[p[0]!]!);
      for (let k = 1; k < p.length; k++) {
        const dq = rows[p[k]!]!;
        for (let w = 0; w < words; w++) next[w]! &= dq[w]!;
      }
      next[i >>> 5]! |= 1 << (i & 31);
      const cur = rows[i]!;
      let same = true;
      for (let w = 0; w < words; w++) if (next[w] !== cur[w]) { same = false; break; }
      if (same) continue;
      cur.set(next);
      changed = true;
    }
  }
  return {
    lostBy(id, after) {
      const i = at.get(id);
      if (i === undefined) return [];
      const row = rows[i]!;
      const lost: NodeId[] = [];
      for (let j = 0; j < ids.length; j++) {
        if ((row[j >>> 5]! & (1 << (j & 31))) === 0) continue;
        if (!after.has(id, ids[j]!)) lost.push(ids[j]!);
      }
      return lost;
    },
    has(id, dominator) {
      const i = at.get(id);
      const j = at.get(dominator);
      if (i === undefined || j === undefined) return false;
      return (rows[i]![j >>> 5]! & (1 << (j & 31))) !== 0;
    },
  };
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
