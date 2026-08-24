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
import { reachableToolNames } from "./spec.ts";
import type { EdgeSpec, ExpansionBudget, GraphSpec, NodeSpec, RunGraph } from "./spec.ts";
import { indexGraph, type Diagnostic } from "./validate.ts";

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
  const gatedNodes = mutation.addNodes
    .filter((n) =>
      // Reachable, not named. A proposed `agent` node names no tool, so keying on
      // `n.tool` let a mutation that hands a model an irreversible tool through with
      // `requiresGate: false` — the one case this rule calls non-negotiable.
      reachableToolNames(n).some((name) => {
        const manifest = input.tools[name];
        return (
          manifest !== undefined &&
          (manifest.irreversibility === "irreversible" || manifest.irreversibility === "externally_visible")
        );
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
