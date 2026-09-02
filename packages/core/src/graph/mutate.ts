/**
 * Dynamic graph mutation.
 *
 * Statically-authored graphs cover most work. Some genuinely cannot be planned ahead,
 * so an agent node may **propose** new nodes — and proposal is separated from
 * execution by the same compiler that validates authored graphs. A model can propose a
 * graph that is wrong; it cannot propose one that weakens oversight, overcommits
 * budget, or races on a channel, because those are compile errors.
 *
 * THE OVERSIGHT HALF OF THAT SENTENCE NAMES TWO MECHANISMS, and for a while it only had one.
 * A posture cannot be lowered because section 4 recompiles against the running graph's own
 * postures. But a posture is not the only thing oversight rests on: a `human_gate` protects a
 * node by DOMINATING it, and a mutation that adds a second path to that node weakens oversight
 * without touching a single posture. Section 2b is the other mechanism.
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
import { indexGraph, reachableToolNamesThrough, type Diagnostic, type GraphIndex } from "./validate.ts";
import { isHardToUndo, postureRank } from "../vocab.ts";

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
  //
  // THIS SECTION IS ABOUT THE ADDED NODES. The two clauses below cover an added `to` from a
  // stranger, and an edge between two existing nodes. The third direction — an added `from`
  // into an existing `to` — is not an error by itself, because the ordinary "do this too, then
  // carry on" proposal has that shape; what it may not do is remove a dominator, which is 2b.
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

  // ── 2b. no existing node loses an OVERSIGHT-BEARING dominator ────────────
  //
  // The rule above is about the ADDED nodes' region. It says nothing about the direction that
  // matters most: an added `from` into an EXISTING `to`. That edge is a second path to a node
  // somebody already reviewed, and because `seq` edges are OR-joined it is a path that skips
  // whatever sat in front of the authored one. Driven end to end — an authored `human_gate` in
  // front of a `reversible_write` tool, no operator action of any kind:
  //
  //     the authored graph, human REJECTS       -> failed, the tool never ran
  //     one added node + one added edge into it -> failed, and the tool ran anyway
  //
  // A rejection RELEASES the grafted path rather than stopping it: an open gate suspends the
  // whole run, and `gate.decided` carries an unconditional `run.resumed`.
  //
  // PROPOSER DOMINANCE IS NOT THE PREDICATE, and it was the first thing tried. The proposer of a
  // mutation is almost always an ancestor of everything it could graft onto — in the graph above
  // the proposer IS the entry node — so "the target must already be dominated by the proposer"
  // is satisfied by the exploit and refuses nothing.
  //
  // What oversight actually depends on is DOMINANCE ITSELF: `gate` protects `pay` while every
  // path from an entry to `pay` runs through `gate`. So the rule is preservation. It admits the
  // legitimate rejoin — an added branch re-entering below everything that dominated its target
  // adds no path that skips anything — and refuses the graft, which is the whole of the
  // difference between the two.
  //
  // PRESERVATION OF *EVERY* DOMINATOR IS THE WRONG RULE, and it shipped once. Nothing in the
  // argument above is about a dominator that carries no oversight, and refusing on one refuses
  // the canonical expansion — "also do this lookup, then carry on into the node I already lead
  // to". Measured on a four-node chain of plain `function` nodes, no gate, no tool, posture
  // `out`, proposer `a`, one added node rejoining at `c`:
  //
  //     a -> b -> c -> d, add a -> lookup -> c   -> MUT003_DOMINATOR_LOST, lost dominator "b"
  //
  // `b` protects nothing. Property 3 runs through `compileMutation` and a refused mutation fails
  // the task, so that is the most expensive thing this rule can get wrong. The predicate is
  // therefore the oversight the lost dominator CARRIED, not the dominance: `oversightRank` below,
  // and the target's own rank is the bar — losing a dominator no stricter than the target itself
  // takes nothing away from it.
  //
  // DOMINANCE IS NECESSARY AND IT IS NOT SUFFICIENT, and this comment said "exactly while" until
  // the counterexample was driven. Static dominance is a claim about PATHS; whether the
  // dominating node RUNS is a claim about the run, and the two come apart at a fan-out of width
  // zero. `Engine.#fireEmptyJoin` schedules the join directly when a fan plans no branches, so
  // every node on the branch is passed over — a `human_gate` among them — while every path from
  // an entry to the node below the join still runs through it. Measured, one graph driven twice
  // with a `reversible_write` tool below the join:
  //
  //     the fetched page yields two items -> awaiting_gate, gates=1, wrote=0
  //     the fetched page yields none      -> succeeded,     gates=0, wrote=1
  //
  // That is `test/run/empty-fanout-oversight.test.ts`, and E12 `fanout_skipped_gate` is the
  // answer to it — at the engine, because the width is a runtime value and no compile-time rule
  // over the spec can see it. What this rule owns is the STATIC half: a mutation may not remove a
  // dominator. Preserving it does not promise the dominator ran; it promises the mutation did not
  // remove the only thing that could.
  if (!diagnostics.some((d) => d.severity === "error")) {
    const mergedForDominance: GraphSpec = {
      ...spec,
      nodes: [...spec.nodes, ...mutation.addNodes],
      edges: [...spec.edges, ...mutation.addEdges],
    };
    const before = dominatorsOf(spec);
    const after = dominatorsOf(mergedForDominance);
    const mergedIndex = indexGraph(mergedForDominance);
    for (const v of spec.nodes) {
      const was = before.get(v.id);
      const now = after.get(v.id);
      if (was === undefined || now === undefined) continue;
      // ONLY A DOMINATOR THAT CARRIED OVERSIGHT. Losing one that did not is an ADDITIVE
      // ALTERNATIVE PATH, which is the shape a mutation exists for — see the section header.
      const target = oversightRank(base, v.id);
      const lost = [...was].filter((d) => !now.has(d)).find((d) => oversightRank(base, d) > target);
      if (lost === undefined) continue;
      // The edge to NAME, and the order matters: a graft is a CHAIN of added edges, and every
      // one of them reaches the target. The edge worth pointing at is the one that crosses back
      // into the existing graph, so the model reading the refusal is told where to move it —
      // not the first hop of its own new branch.
      const reaches = (e: EdgeSpec): boolean => e.to === v.id || forwardFrom(mergedIndex, [e.to]).has(v.id);
      const culprit =
        mutation.addEdges.find((e) => e.to === v.id) ??
        mutation.addEdges.find((e) => !added.has(e.to) && reaches(e)) ??
        mutation.addEdges.find(reaches);
      diagnostics.push({
        severity: "error",
        code: "MUT003_DOMINATOR_LOST",
        message:
          `edge "${culprit?.id ?? mutation.addEdges[0]?.id ?? "(none)"}" gives "${v.id}" a path that does not pass through "${lost}"`,
        at: culprit === undefined ? { nodeId: v.id } : { edgeId: culprit.id, nodeId: v.id },
        fix: `route the edge into a node that "${lost}" already dominates, or through "${lost}" itself`,
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
      reachableToolNamesThrough(n, childSpec, result.graph.expansion.maxDepth).some((name) => {
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
 * HOW MUCH OVERSIGHT A NODE CARRIES, as one comparable number.
 *
 * `human_gate` sits ABOVE every posture rather than beside them, and that gap is what the number
 * is for: a posture says how closely a person watches an action that is going to happen anyway,
 * and a gate says the run stops until a person acts. Ranking the gate at 3 rather than folding it
 * into `in` is what makes "the lost dominator was a gate" refuse whatever the target's own
 * posture is — including a target already at `in`, which raises its own gate and would otherwise
 * compare EQUAL and be admitted.
 *
 * The posture is the COMPILED one — `plans[id].posture`, after the `max` fold over the graph
 * policy, the node's own declaration and its tool's irreversibility class — because that is the
 * level the node actually runs at. Reading `NodeSpec.policy.posture` instead would miss every
 * node whose oversight came from its class, which is most of the nodes that have any.
 *
 * A node absent from `plans` ranks 0, which is the fail-OPEN direction and is deliberate: the
 * only way to be absent is to not be in the compiled graph, and the caller compares two ids that
 * both came out of `base.spec.nodes`.
 */
function oversightRank(base: RunGraph, id: NodeId): number {
  if (base.spec.nodes.find((x) => x.id === id)?.type === "human_gate") return 3;
  const posture = base.plans[id]?.posture;
  return posture === undefined ? 0 : postureRank(posture);
}

/**
 * Forward flow, walked once from a seed set.
 *
 * `compensation` is excluded because the executor never traverses one; `error` and `loop` are
 * included because it does. Loop edges matter here rather than being a detail: a mutation that
 * grafts a BACKWARD edge reaches a node the same way a forward one does, and dropping them from
 * the walk would let that shape through the check below.
 */
function forwardFrom(idx: GraphIndex, seeds: Iterable<NodeId>): Set<NodeId> {
  const seen = new Set<NodeId>();
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of idx.outbound.get(id) ?? []) {
      if (e.kind === "compensation" || seen.has(e.to)) continue;
      seen.add(e.to);
      stack.push(e.to);
    }
  }
  return seen;
}

/**
 * `dom(v)` for every node an entry REACHES: the nodes every path from an entry to `v` passes
 * through. Reaches, not runs — a node this map calls live may still not execute (a fan-out of
 * width zero skips its whole branch), which is why the caller's rule is stated as a static one.
 *
 * The ordinary iterative fixpoint — `dom(v) = {v} ∪ ⋂ dom(p)` over `v`'s predecessors, entries
 * pinned to themselves — over the same edge set `forwardFrom` walks. A node no entry reaches is
 * LEFT OUT rather than given the top element, because "unknown" and "everything dominates it"
 * would otherwise be the same value, and the caller subtracts these sets.
 */
function dominatorsOf(spec: GraphSpec): Map<NodeId, Set<NodeId>> {
  const idx = indexGraph(spec);
  const entries = new Set(idx.entryNodes);
  const live = forwardFrom(idx, entries);
  for (const id of entries) live.add(id);
  const nodes = spec.nodes.map((n) => n.id).filter((id) => live.has(id));
  const dom = new Map<NodeId, Set<NodeId>>();
  for (const id of nodes) dom.set(id, entries.has(id) ? new Set([id]) : new Set(nodes));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of nodes) {
      if (entries.has(id)) continue;
      let next: Set<NodeId> | undefined;
      for (const e of idx.inbound.get(id) ?? []) {
        if (e.kind === "compensation") continue;
        const d = dom.get(e.from);
        if (d === undefined) continue;
        if (next === undefined) next = new Set(d);
        else for (const x of [...next]) if (!d.has(x)) next.delete(x);
      }
      const settled = next ?? new Set<NodeId>();
      settled.add(id);
      const current = dom.get(id)!;
      if (current.size !== settled.size || [...settled].some((x) => !current.has(x))) {
        dom.set(id, settled);
        changed = true;
      }
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
