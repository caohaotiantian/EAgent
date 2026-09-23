/**
 * Compile-time validation: GRAPH000–GRAPH021.
 *
 * Every rule runs and every diagnostic is returned. Failing on the first error would
 * make authoring a 60-node graph a 60-round-trip exercise, and the compiler is meant
 * to be cheap enough to run on every keystroke in the editor.
 *
 * The rules exist to make three claims true *before* anything executes:
 *   - the run terminates (bounded by construction, not proved — GRAPH006/007/018)
 *   - concurrent writes are deterministic (GRAPH010)
 *   - oversight cannot be weakened anywhere (GRAPH014, GRAPH019_POSTURE_NO_EFFECT)
 *
 */

import type { EdgeId, NodeId } from "../ids.ts";
import { HOOK_POINTS, isHookPoint } from "../run/hooks.ts";
import { MULTI_WRITER_SAFE, REDUCER_NAMES, type ChannelSpec } from "../state/channels.ts";
import {
  CLASSIFICATION_POSTURE_FLOOR,
  CLASS_DEFAULT_POSTURE,
  type Classification,
  isLoosening,
  isPosture,
  isSyntheticSubject,
  maxPosture,
  POSTURES,
  type IrreversibilityClass,
  type Posture,
  postureRank,
  isHardToUndo,
} from "../vocab.ts";
import { CODES, type Code, type ErrorClass } from "../errors.ts";
import { checkExpr, type Ty } from "./expr.ts";
import {
  DEFAULT_EXPANSION,
  GRAPH_API_VERSION,
  ALLOWED_FIELDS,
  NODE_FIELDS,
  POLICY_FIELDS,
  SPEC_FIELDS,
  EDGE_FIELDS,
  NESTED_FIELDS,
  dataFloorOf,
  errorProjectionSource,
  launderedChannels,
  observedChannels,
  REQUIRED_BLOCK,
  REQUIRED_FIELDS,
  reachableToolNames,
  type EdgeKind,
  type EdgeSpec,
  type ExpansionBudget,
  type GraphSpec,
  type NodeSpec,
  type ResolvedRef,
  type ResourceRef,
} from "./spec.ts";
import type { Digest } from "../canonical.ts";

export interface Diagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly code: string;
  readonly message: string;
  readonly at?: { readonly nodeId?: NodeId; readonly edgeId?: EdgeId; readonly channel?: string };
  /** A concrete suggested edit. Never "consider reviewing". */
  readonly fix?: string;
}

/** What the compiler needs to know about a tool without depending on the registry. */
export interface ToolManifestLite {
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly irreversibility: IrreversibilityClass;
  readonly idempotent: boolean;
  readonly compensation?: { readonly tool: string };
}

export interface ResourceResolver {
  /** `undefined` ⇒ not found. A yanked resource resolves with channel `deprecated`. */
  resolve(ref: ResourceRef): ResolvedRef | undefined;
  /** Nested GraphSpec for a `subgraph` node, if the ref names one. */
  subgraph?(ref: ResourceRef): GraphSpec | undefined;
  /**
   * RUN TIME. The TEXT a pinned document holds, or `undefined` if the pin names none.
   *
   * KEYED BY DIGEST, NEVER BY REF, and that is the whole reason it is a second method rather
   * than a field on `resolve`'s answer. `resolve` is the COMPILE-time half — it turns a
   * floating `@stable` into a pin — and `resources/functions.ts` records what happens when a
   * running node calls it instead: "a promotion between compile and execute swapped the body
   * underneath the Run". Code was the exception once; a prompt must not become the second.
   * The digest comes from `RunGraph.resolutionManifest`, frozen at compile.
   */
  document?(pinned: Digest): string | undefined;
}

export interface ValidationContext {
  readonly spec: GraphSpec;
  readonly resolver: ResourceResolver;
  readonly tools: Readonly<Record<string, ToolManifestLite>>;
  /** Capabilities the tenant actually holds. Node/graph declarations are intersected. */
  readonly tenantCapabilities?: readonly string[];
  readonly systemPostureFloor?: Posture;
  /** For the asymmetry check: the postures a candidate must not go below. */
  readonly baselinePostures?: Readonly<Record<string, Posture>>;
  /** Nesting depth, for subgraph recursion. */
  readonly depth?: number;
  /** Refs already being expanded, to detect subgraph cycles. */
  readonly expanding?: readonly ResourceRef[];
  /**
   * The index for THIS `spec`, already built, as a thunk — an internal seam, not a knob.
   *
   * `compile` validated and then built its own `indexGraph(spec)`, so the analysis that is 78%
   * of compile self time ran exactly twice per `compileOrThrow` and one full result was thrown
   * away. A THUNK and not a value because the order matters: `validateGraph` gates on
   * `checkStructure` before anything indexes a spec, and building one eagerly in `compile` would
   * index a malformed graph that the structural rules exist to diagnose instead. Called only
   * after that gate, so a spec too broken to index is never handed to one.
   *
   * `CompileInput` omits this, so no caller outside this pair can supply an index for a spec it
   * does not describe.
   */
  readonly index?: () => GraphIndex;
  /**
   * Child validations already computed on this walk — see `rule016Subgraphs`, which owns it.
   *
   * Also omitted from `CompileInput`: the key does not name the resolver or the tenant, so a
   * memo carried across two unrelated compiles would answer one graph's question with another
   * graph's answer.
   */
  readonly subgraphMemo?: Map<string, readonly Diagnostic[]>;
  /**
   * Deep tool-reachability answers already computed on this walk — see
   * `reachableToolNamesThrough`, whose key discipline and lifetime this shares with
   * `subgraphMemo`, and for the same reason: the key names neither the resolver nor the
   * tenant, so a memo carried across two unrelated compiles would answer one graph's question
   * with another graph's answer.
   */
  readonly toolReachMemo?: Map<string, readonly string[]>;
}

/**
 * Every tool a node can reach INCLUDING THROUGH A SUBGRAPH, as `reachableToolNames` would answer
 * if it could see the child.
 *
 * WHY IT EXISTS. `reachableToolNames` reads one `NodeSpec`, so a `subgraph` node is classified by
 * the tools it names directly — none — however irreversible its child graph is. Measured on a
 * parent whose only node delegates to a child that calls an `irreversible` `pay.charge`:
 * `plans.s.posture` was `out`, and a parent declaring `policy.capabilities: []` compiled clean.
 *
 * WHAT IT IS AND IS NOT. It is NOT an oversight hole — every irreversible call inside the child
 * still gates at `in` on the CHILD's own compile floor, and under a human de-escalation the
 * subgraph route is strictly STRICTER than the direct one. Three things it does buy, each
 * measured:
 *   1. the `policy.escalated{rule: mutation_introduced_irreversible}` record that was missing
 *      from the PARENT journal, so a trajectory consumer counting that rule saw nothing;
 *   2. the human is asked BEFORE the child does reversible work — the direct route asks first,
 *      the subgraph route let a `note.append` land first;
 *   3. an `E_CAP_DENIED` that killed the run at RUN time becomes a COMPILE diagnostic, which is
 *      the failure the compile stage exists to prevent.
 *
 * NOT A CHANGE TO `reachableToolNames`, deliberately. That is a kernel export over a single node,
 * and giving it a resolver argument would buy nothing: `RunGraph.subgraphs` is frozen at compile
 * and carries the whole tree, so every caller already has the child specs in hand. The three
 * callers that need the deep answer — `compile.ts`'s class floor, this file's GRAPH014 floor and
 * GRAPH017 ceiling, and `mutate.ts`'s gated-node set — pass their own lookup.
 *
 * AN UNRESOLVABLE REF CONTRIBUTES NOTHING, and that does not loosen anything: GRAPH015 already
 * REFUSES a `subgraph` ref that does not resolve, so a graph this function could not descend
 * into is a graph that never compiles. The same is not true of an unknown TOOL name, which is
 * why that one is a warning and is handled by the callers exactly as before.
 *
 * DEPTH-BOUNDED AND CYCLE-GUARDED like `rule016Subgraphs`, whose two refusals this mirrors: a
 * ref already on the path is not re-entered, and the walk stops at `expansion.maxDepth`. Stopping
 * short can only UNDER-report, and under-reporting is the state this function was written to
 * improve on rather than a regression it introduces.
 */
export function reachableToolNamesThrough(
  node: NodeSpec,
  childSpec: (ref: ResourceRef) => GraphSpec | undefined,
  maxDepth: number,
  memo?: Map<string, readonly string[]>,
): readonly string[] {
  const out = [...reachableToolNames(node)];
  const root = node.subgraph?.ref;
  if (root === undefined) return out;
  for (const name of namesUnder(root, childSpec, maxDepth, memo)) if (!out.includes(name)) out.push(name);
  return out;
}

/**
 * The walk itself, keyed so a caller can pay for it once.
 *
 * ONCE PER DISTINCT (maxDepth, ref), NOT ONCE PER NODE. `rule017Capabilities` calls the
 * function above for every node in every graph on the walk, and `rule016Subgraphs`'s own memo
 * bounds how many graphs that is but not how many times each subtree is re-walked underneath.
 * It was the whole residue that memo left: on `test/graph/perf-lane-subgraph-walk.test.ts`'s
 * 12-level two-way chain, `subgraph()` resolutions go 336 -> 102 with the diagnostics
 * byte-identical (12,286 at depth 12, 196,606 at depth 16).
 *
 * `maxDepth` IS IN THE KEY because a child spec may declare its own `policy.expansion`, so two
 * callers on one walk can ask about the same ref under different budgets. `childSpec` is not,
 * which is why the memo may not outlive one `validateGraph` walk — see
 * `ValidationContext.toolReachMemo`.
 *
 * THE MEMO IS ON THE WHOLE SUBTREE ANSWER AND NOT ON EACH (ref, remaining) STEP, and the
 * step-wise version would be cheaper again. It is not taken because this walk is not
 * compositional: `reachedAt` is global to one walk, so what a subtree contributes depends on
 * what the walk has already reached. Two consequences decided it. The ORDER of the returned
 * names would change, and callers turn that order into the order their diagnostics appear in.
 * And a `policy.expansion.maxDepth` that is not a number — which nothing yet refuses, so
 * `maxDepth: "abc"` reaches here as written — makes a `remaining` countdown non-terminating
 * where `reachedAt` still stops the walk. A cheaper walk that can hang on a malformed graph is
 * not the trade.
 */
function namesUnder(
  root: ResourceRef,
  childSpec: (ref: ResourceRef) => GraphSpec | undefined,
  maxDepth: number,
  memo?: Map<string, readonly string[]>,
): readonly string[] {
  const key = `${String(maxDepth)}\u0000${root}`;
  const cached = memo?.get(key);
  if (cached !== undefined) return cached;

  const out: string[] = [];

  // THE DEPTH EACH REF WAS REACHED AT, not merely whether it was seen — the same guard
  // `compile.ts`'s `resolveSubgraphs` uses, and for the same measured reason. A bare visited-`Set`
  // is a cycle guard that also skips DESCENDING, so a ref first reached AT the depth limit is
  // never re-walked when a shallower path to it appears later in the node list. That makes the
  // answer depend on the order two sibling nodes happen to be written in, and this one feeds an
  // oversight floor: measured on two workspaces differing only in that order, one compiled `ok`
  // and the other refused with `GRAPH017_CAPABILITY_NOT_DECLARED`. An order-sensitive floor is a
  // floor that fails open half the time.
  //
  // `rule016Subgraphs` guards on the PATH (`expanding`) instead, which explores a diamond fully;
  // it is cited nearby as the model for this walk and is NOT the same guard. Re-walking when a
  // ref turns up shallower is what makes the answer independent of node order, which is the only
  // version an oversight decision may rest on.
  const reachedAt = new Map<ResourceRef, number>();
  const walk = (spec: GraphSpec, depth: number): void => {
    // A CHILD THAT IS NOT A GRAPH CONTRIBUTES NOTHING, exactly as an unresolvable ref does, and
    // for the same reason it does not loosen anything: this walk runs BEFORE `rule016Subgraphs`,
    // so it is the first thing to touch a child spec, and a resolver's answer comes out of a
    // FILE. Measured before this guard, on a resolver returning each value for a declared ref:
    //
    //     42 / {} / "x" / []   THREW TypeError: spec.nodes is not iterable
    //     null                 THREW TypeError: Cannot read properties of null (reading 'nodes')
    //
    // Skipping cannot let such a graph through: the child's own `checkStructure` refuses it
    // through `rule016Subgraphs`' recursion, re-tagged `in subgraph "…": …`. A node inside it is
    // skipped for the same reason — `reachableToolNames(null)` is the same crash one level in.
    if (typeof spec !== "object" || spec === null || !Array.isArray(spec.nodes)) return;
    for (const n of spec.nodes) {
      if (typeof n !== "object" || n === null) continue;
      for (const name of reachableToolNames(n)) if (!out.includes(name)) out.push(name);
      const ref = n.subgraph?.ref;
      if (ref === undefined || depth + 1 > maxDepth) continue;
      const been = reachedAt.get(ref);
      if (been !== undefined && been <= depth + 1) continue;
      const child = childSpec(ref);
      if (child === undefined) continue;
      reachedAt.set(ref, depth + 1);
      walk(child, depth + 1);
    }
  };

  const first = childSpec(root);
  if (first !== undefined) {
    reachedAt.set(root, 1);
    walk(first, 1);
  }
  memo?.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Graph index — computed once, reused by every rule
// ---------------------------------------------------------------------------

export interface GraphIndex {
  readonly byId: ReadonlyMap<NodeId, NodeSpec>;
  readonly edgeById: ReadonlyMap<EdgeId, EdgeSpec>;
  readonly inbound: ReadonlyMap<NodeId, readonly EdgeSpec[]>;
  readonly outbound: ReadonlyMap<NodeId, readonly EdgeSpec[]>;
  /** Edges that carry normal forward flow: everything except `loop` and `compensation`. */
  readonly dagEdges: readonly EdgeSpec[];
  readonly loopEdges: readonly EdgeSpec[];
  /**
   * EVERY EDGE THE EXECUTOR CAN TRAVERSE — `dagEdges` plus the back-edges, which is not the
   * same graph and was treated as the same graph by five analyses (§A.84).
   *
   * Same predicate as `graph/mutate.ts`'s `traversable`, and for the reason written out there:
   * `#edgesToTake` answers `case "compensation": break;` and rollback is journal-driven, so
   * `compensation` is the ONE kind nothing ever walks; `error` stays in because `#errorEdges`
   * dispatches on failure; and `loop` stays in because `#edgesToTake` DOES take a loop edge.
   */
  readonly flowEdges: readonly EdgeSpec[];
  readonly entryNodes: readonly NodeId[];
  readonly terminalNodes: readonly NodeId[];
  /** Topological order over `dagEdges`; empty when the forward graph is cyclic. */
  readonly topoOrder: readonly NodeId[];
  readonly ancestors: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
  /**
   * Ancestors over `flowEdges` with the cycles CUT rather than collapsed: the order the
   * scheduler actually realises, walking out from the entry nodes.
   *
   * It is not `ancestors` widened and it is not a full closure over `flowEdges`. See
   * `computeFlowOrder` for the construction and `canPrecede`/`rule010ConcurrentWriters` for why
   * the two readers want different halves of it.
   */
  /**
   * IMMEDIATE-DOMINATOR TREE over `flowEdges`, rooted at a virtual node above the entry set.
   *
   * `a` dominates `b` when EVERY path from an entry to `b` passes through `a` — which is the only
   * ordering strong enough for `rule010ConcurrentWriters` to stay silent on, because GRAPH010's
   * silence has to hold on every pass and "some path orders them" does not. See `computeDominators`
   * for what that replaced and the graph that proved it had to.
   */
  readonly dominators: DomTree;
  /**
   * The FULL transitive closure over `flowEdges`, cycles included: every node that can have run
   * before this one on some pass. A superset of `ancestors` by construction.
   *
   * THE OTHER HALF OF "CYCLES HANDLED", and it answers a different question from `dominators`.
   * A node inside a loop body has seen every other node of that body's writes by its second pass,
   * which is a PRODUCER question (`canPrecede`), and it is NOT ordered against them, which is a
   * CONCURRENCY question — so `rule010ConcurrentWriters` reads `dominators` and never this.
   */
  readonly flowAncestors: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
  readonly reachable: ReadonlySet<NodeId>;
  /**
   * How many instances of a node can run AT THE SAME TIME: Π fanout widths on the
   * heaviest path. Loop iterations are deliberately excluded — they are sequential.
   * This is what GRAPH010 (concurrent writers) must use.
   */
  readonly parallelWidth: ReadonlyMap<NodeId, number>;
  /**
   * How many fan-out coordinate segments a Task of this node carries — the LENGTH of its
   * enclosing fan-out stack. A join reads it to know which instance of itself an arriving
   * branch belongs to: the instance's coordinate is the arriving branch truncated to this
   * depth. Absent means the depth is ambiguous, which `GRAPH008_JOIN_DEPTH` refuses for
   * joins and their arms and tolerates everywhere else.
   */
  readonly fanoutDepth: ReadonlyMap<NodeId, number>;
  /**
   * The same stack, spelled in EDGE IDS rather than in widths — which fan-outs enclose this
   * node, innermost last.
   *
   * `parallelWidth` answers "how many at once" and `fanoutDepth` answers "how many coordinate
   * segments"; neither answers "IS THIS THE SAME FAN-OUT". GRAPH010's branch-local exemption has
   * to ask exactly that: a channel is branch-local only when its reader sits under the SAME fan
   * edge as its writer, and two sibling fan-outs of equal width are indistinguishable by number.
   *
   * Computed by the same traversal, with the same `undefined` = AMBIGUOUS convention, so the two
   * cannot drift. It is the STRICTER of the two: an edge id determines its width, so any pair of
   * inbound paths that agree on edges agrees on widths, while the converse is false.
   */
  readonly fanoutEdgeStack: ReadonlyMap<NodeId, readonly EdgeId[] | undefined>;
  /** Every `join` node, so the runtime can notify barriers without scanning the spec. */
  readonly joinNodes: readonly NodeId[];
  /**
   * Worst-case TOTAL instances over the whole run: parallelWidth × loop iterations.
   * This is what GRAPH009 (budget) and GRAPH018 (task count) must use — three loop
   * passes cost three times as much even though they never overlap.
   */
  readonly multiplicity: ReadonlyMap<NodeId, number>;
  readonly criticalPath: ReadonlyMap<NodeId, number>;
}

export function indexGraph(spec: GraphSpec): GraphIndex {
  const byId = new Map<NodeId, NodeSpec>();
  for (const n of spec.nodes) byId.set(n.id, n);

  const edgeById = new Map<EdgeId, EdgeSpec>();
  const inbound = new Map<NodeId, EdgeSpec[]>();
  const outbound = new Map<NodeId, EdgeSpec[]>();
  for (const n of spec.nodes) {
    inbound.set(n.id, []);
    outbound.set(n.id, []);
  }
  for (const e of spec.edges) {
    edgeById.set(e.id, e);
    inbound.get(e.to)?.push(e);
    outbound.get(e.from)?.push(e);
  }

  // `compensation` is not forward flow, and including it would make almost every graph
  // look cyclic.
  //
  // NOTHING TRAVERSES ONE, AND THAT IS STILL TRUE NOW THAT ROLLBACK RUNS.
  // `Engine.#edgesToTake` still has `case "compensation": break;`, and the error path
  // still takes `kind === "error"` edges only — which is why GRAPH008 refuses
  // `onBranchError: "compensate"` outright rather than letting it read as a rollback.
  //
  // What changed is what a declared compensation DOES, not how an edge is walked. Rollback
  // is driven by the JOURNAL, not by the graph: `Engine.#compensate` folds the run's
  // `tool.called` rows through `run/compensation.ts` and undoes them in reverse seq order,
  // on run failure and on rewind. It has to be journal-driven — an effect that happened
  // needs undoing whether or not an author drew an edge to it, and an edge names a NODE
  // while a rollback has to name a CALL (the third of five parallel writes has no edge of
  // its own). So a compensation edge remains a DECLARATION and still earns its place as
  // one: GRAPH012 refuses an edge whose target tool declares no undo, and GRAPH010 reads
  // it to order two writers.
  //
  // It is still NOT what lets `rewind` cross an effect: `rewind` reads
  // `ToolDefinition.compensation` from the registry, and a graph with no compensation
  // edges at all rewinds — and now rolls back — exactly the same.
  // A READER OUTSIDE THIS FUNCTION DEPENDS ON THIS EXCLUSION LIST MATCHING `ancestors`' one below:
  // `rule021FanoutHasJoin`'s `wouldCycle` asks `ancestors` whether adding an edge would close a
  // forward cycle, which is only the same question while both filters name the same two kinds. It
  // decides whether that rule OFFERS an edit AND whether it prints §A.69's counterfactual about one
  // — four of its ten message arms turn on it. Widen or narrow one filter without the other and both
  // become false statements, with nothing local to notice (§A.73). THAT COUPLING IS UNCHANGED BY
  // §A.84 AND IS THE REASON THE FIX IS A SECOND RELATION RATHER THAN A WIDER FILTER: `ancestors`
  // still walks `dagEdges`' two exclusions and nothing else, so `wouldCycle` still asks the
  // question it was written to ask, and `test/graph/fanout-branch-diagnostic.test.ts`'s pin that
  // "the `loop` edge is invisible to `ancestors`" is still true on purpose.
  //
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // EVERY ANALYSIS OVER `dagEdges`, AND WHICH OF THEM IS WRONG ON A BACK-EDGE (§A.84). The row
  // asked for this set to be NAMED before anything moved, because "include loop edges in
  // `dagEdges`" makes almost every looping graph look cyclic and is not the fix.
  //
  //   topoOrder = topoSort(nodes, dagEdges)       RIGHT, and must stay. A back-edge in here
  //                                               empties the sort, which is exactly what
  //                                               GRAPH006_UNMARKED_CYCLE reads it for.
  //   rule006Cycles, `topoOrder.length === 0`     RIGHT. "The forward graph contains a cycle" is
  //                                               a question about the graph WITHOUT its
  //                                               declared back-edges, by definition.
  //   computeFanoutStacks / computeCriticalPath   RIGHT. Both sweep `topoOrder`, so both need an
  //                                               acyclic order; a loop multiplies COUNT, which
  //                                               `applyLoopFactors` already applies separately.
  //   ancestors (its own copy of the filter)      RIGHT for `rule021`'s `wouldCycle`, which asks
  //                                               "would this edit close a FORWARD cycle", and
  //                                               WRONG for every reader that asks "did this run
  //                                               before that". Those three move, below.
  //   entryNodes (`hasNonLoopIn`)                 WRONG. It excluded `loop` from the inbound
  //                                               test, so a loop's TARGET whose only inbound
  //                                               edge is the back-edge was an ENTRY node and ran
  //                                               at t=0 beside the real first node. Measured on
  //                                               the canonical loop graph: node order
  //                                               ["parse","fix","audit","fix","audit",…] with
  //                                               the fixer running before the thing it fixes.
  //   terminalNodes (`hasForwardOut`)             WRONG. A node whose only outbound edge is the
  //                                               back-edge had no forward out, so it "ends a
  //                                               path" — and `examples/graphs/harden-config.json`
  //                                               printed `GRAPH002_DEAD_END: terminal node "fix"`
  //                                               on every command, about a node the executor
  //                                               leaves on every pass.
  //   rule005Dataflow GRAPH005_UNPRODUCED_READ    WRONG. A loop-carried write is invisible: on
  //                                               that same graph, `audit` and `collate` were
  //                                               each told "reads \"applied\", which no upstream
  //                                               node writes" about a channel `fix` writes on
  //                                               every pass.
  //   rule010ConcurrentWriters GRAPH010           WRONG. Two nodes joined only through a
  //                                               back-edge look unordered, so the canonical loop
  //                                               graph was REFUSED for `parse` and `fix` "can
  //                                               run concurrently" when every path to `fix` goes
  //                                               through `audit`.
  //   rule002Terminals `producesOutput`           WRONG for the same reason as `ancestors`.
  //
  // THE THREE THAT MOVE READ `flowAncestors` THROUGH `canPrecede`, and GRAPH010 reads `dominators`
  // INSTEAD of it for a reason stated at that rule. The ones that stay right keep `ancestors`, and so
  // does `wouldCycle`, which is how the §A.73 coupling survives a change to this function.
  // Entry and terminal keep their own filters rather than being folded into either relation — a
  // compensation edge means its target is not a start point and is still an edge nothing walks, so
  // the two questions genuinely differ and always did.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  const dagEdges = spec.edges.filter((e) => e.kind !== "loop" && e.kind !== "compensation");
  const loopEdges = spec.edges.filter((e) => e.kind === "loop");
  // The executor's own edge set. `graph/mutate.ts`'s `traversable` is this same filter and says
  // why at length: `compensation` is the only kind nothing ever walks.
  const flowEdges = spec.edges.filter((e) => e.kind !== "compensation");

  // Entry: nothing points at it — OR nothing but a back-edge AND nothing can reach it. There is
  // deliberately no `entry:` field: a second way to say where a graph starts is a second thing
  // that can disagree with the edges.
  //
  // IT WAS "no inbound edge of any kind EXCEPT a loop back-edge", FULL STOP, and that exception
  // was §A.84's third symptom. The argument for it is real and is kept — a loop whose target has
  // no other way in would otherwise never start, and `test/graph/graph-lane-mutation-dominance`
  // drives exactly that graph — but it was applied UNCONDITIONALLY, so a loop target that the
  // rest of the graph reaches perfectly well was ALSO scheduled at t=0, beside the real first
  // node. Measured on the canonical loop shape, the fixer running before the thing it fixes:
  //
  //     before   node order ["parse","fix","audit","fix","audit","fix","audit"]
  //     after    node order ["parse","audit","fix","audit","fix","audit","fix","audit"]
  //
  // So the exception is now conditional on the thing it was argued from: a node whose only
  // inbound edges are `loop` is an entry only when nothing STARTS it — when no root reaches it
  // over `flowEdges`. `#edgesToTake` has a `loop` arm, so a reachable loop target is scheduled by
  // its source exactly like any other successor and needs no second door.
  //
  // THE ROOT TEST READS `spec.edges` AND NOT `flowEdges`, which is the one place the two must
  // differ: nothing traverses a compensation edge, so listing its target as an entry would be the
  // ONLY thing that ever scheduled that node — and it would run at the START of the run, before
  // the action it is declared to undo. A node whose only inbound is a compensation edge is
  // therefore neither a root nor loop-only-inbound, and is an entry under neither arm, exactly as
  // before.
  const hasAnyIn = new Set(spec.edges.map((e) => e.to));
  const isRoot = (id: NodeId): boolean => !hasAnyIn.has(id);
  const started = new Set<NodeId>();
  {
    const flowOut = new Map<NodeId, NodeId[]>();
    for (const e of flowEdges) (flowOut.get(e.from) ?? flowOut.set(e.from, []).get(e.from)!).push(e.to);
    const q = spec.nodes.filter((n) => isRoot(n.id)).map((n) => n.id);
    while (q.length > 0) {
      const id = q.pop()!;
      if (started.has(id)) continue;
      started.add(id);
      for (const to of flowOut.get(id) ?? []) q.push(to);
    }
  }
  const entryNodes = spec.nodes
    .filter(
      (n) =>
        isRoot(n.id) ||
        (!started.has(n.id) && (inbound.get(n.id) ?? []).every((e) => e.kind === "loop")),
    )
    .map((n) => n.id);
  // Terminal: no FORWARD outbound edge. A loop's source is still where a path ends — it leaves by
  // the back-edge, which returns to somewhere the run has already been.
  //
  // THIS WAS BRIEFLY `flowEdges` AND THAT WAS WRONG, measured rather than argued. The false
  // `GRAPH002_DEAD_END` on `harden-config.json`'s `fix` is real, but making a loop source
  // non-terminal emptied the set on essentially every looping graph — the canonical loop, two
  // loops sharing a node, nested loops and a self-loop all returned `[]` — so GRAPH002 went
  // silent on exactly the graphs §A.84 makes legal, and `evolution/exam.ts`'s
  // `terminalNodes.length !== 1` refused any exam with a bounded loop in it. The false warning is
  // `rule002Terminals`' to fix, and it fixes it by asking a better question of the same set.
  const hasForwardOut = new Set(dagEdges.map((e) => e.from));
  const terminalNodes = spec.nodes.filter((n) => !hasForwardOut.has(n.id)).map((n) => n.id);

  const topoOrder = topoSort(spec.nodes.map((n) => n.id), dagEdges);

  // Ancestors over forward edges only. Among its readers — GRAPH010's concurrency test is the one it
  // was written for — is `rule021FanoutHasJoin`'s `wouldCycle` (§A.73), which reads this set as "a
  // forward path exists" in order to decide whether an edit it is about to describe would close a
  // cycle. That reading holds only while this filter names the same two kinds as `dagEdges` above.
  const ancestors = new Map<NodeId, Set<NodeId>>();
  for (const id of spec.nodes.map((n) => n.id)) ancestors.set(id, new Set());
  for (const id of topoOrder) {
    const acc = ancestors.get(id)!;
    for (const e of inbound.get(id) ?? []) {
      if (e.kind === "loop" || e.kind === "compensation") continue;
      acc.add(e.from);
      for (const a of ancestors.get(e.from) ?? []) acc.add(a);
    }
  }

  const { flowAncestors } = computeFlowOrder(spec, entryNodes, flowEdges);
  const dominators = computeDominators(spec, entryNodes, flowEdges);

  const reachable = new Set<NodeId>();
  const stack = [...entryNodes];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    // Every edge kind counts here, because this set answers "is this node connected to
    // the graph at all" for the unreachable-node rules — not "will it run". A loop target
    // is reached by the runtime; a compensation target is reached by nothing, which is a
    // fact about the executor rather than about connectivity and does not belong here.
    for (const e of outbound.get(id) ?? []) stack.push(e.to);
  }

  const { stacks, widths: parallelWidth, edgeStacks: fanoutEdgeStack } = computeFanoutStacks(spec, topoOrder, inbound);
  const fanoutDepth = new Map<NodeId, number>();
  for (const [id, s] of stacks) if (s !== undefined) fanoutDepth.set(id, s.length);
  const joinNodes = spec.nodes.filter((n) => n.type === "join").map((n) => n.id);
  const multiplicity = applyLoopFactors(spec, parallelWidth, loopEdges, ancestors);
  const criticalPath = computeCriticalPath(spec, topoOrder, outbound);

  return {
    fanoutDepth,
    fanoutEdgeStack,
    joinNodes,
    byId,
    edgeById,
    inbound,
    outbound,
    dagEdges,
    loopEdges,
    flowEdges,
    entryNodes,
    terminalNodes,
    topoOrder,
    ancestors,
    dominators,
    flowAncestors,
    reachable,
    parallelWidth,
    multiplicity,
    criticalPath,
  };
}

/**
 * The immediate-dominator tree, and `dominates(a, b)` over it.
 *
 * A TREE AND NOT A MAP OF SETS, which is the whole reason this is affordable on every compile.
 * `graph/mutate.ts`'s own `dominators` computes the same relation over the same edge set for a
 * different question — whether a graft moved what must run before an existing node — and it
 * materialises V bitset rows of V bits, a bounded quadratic its own docstring calls out and its
 * caller guards with a node ceiling. That cost is right for a rule that runs on a proposed
 * mutation and wrong for one that runs on every `loom compile`, so this keeps one parent pointer
 * per node and answers by walking the chain. THE TWO ARE THE SAME RELATION AND ARE NOT SHARED,
 * which is a duplicate worth naming rather than hiding: unifying them is a change to a file this
 * did not own.
 */
interface DomTree {
  /** Immediate dominator of each node; absent for the roots and for anything unreachable. */
  readonly idom: ReadonlyMap<NodeId, NodeId>;
  /** Does `a` dominate `b` — is `a` on every path from an entry to `b`? Reflexive. */
  dominates(a: NodeId, b: NodeId): boolean;
}

/**
 * EVERY PATH, not some path — the relation `rule010ConcurrentWriters` needs and the one it did
 * not have.
 *
 * WHAT THIS REPLACED AND WHY, because the thing it replaced looked right and shipped. The first
 * cut of §A.84 gave GRAPH010 a `flowOrder` relation: `flowEdges` with the cycles cut by a
 * depth-first walk from the entry nodes, read as "the order the scheduler realises". It is not
 * that. The cut only removes an edge whose target is still on the CURRENT PATH, so a `loop` edge
 * met as a TREE edge stays in and contributes an ordering that is true from pass two and false on
 * pass one. Measured on `siblings.json` — `start -> summarize`, `start -> scan -> fix`, and
 * `fix -loop-> summarize`, with `summarize` and `fix` both writing a `replace` channel:
 *
 *     base   GRAPH010_CONCURRENT_WRITE: nodes "summarize" and "fix" …
 *     first  cut of §A.84: compiles CLEAN, because flowOrder(summarize) contains fix
 *     the UNCHANGED executor: node order ["start","scan","summarize","fix"]
 *
 * — `summarize` and `fix` in ONE pass with nothing ordering them, which is the race GRAPH010
 * exists to refuse, and the compiler had stopped saying so. Worse, the cut depends on the order
 * `spec.nodes` and `spec.edges` are written in: the same graph permuted gave different GRAPH010
 * sets on 527 of 8,000 fuzz seeds, where base is permutation-stable at 0.
 *
 * THE DOCSTRING THAT SHIPPED WITH IT WAS THE DEFECT, and it is quoted here rather than deleted:
 * *"the cut can only withhold a refusal it was already free to withhold"*. It was not free to
 * withhold this one. An argument that a guard may only get quieter is not an argument that every
 * refusal it drops was wrong.
 *
 * DOMINANCE HAS NEITHER FAULT. `a` dominates `b` when every path from an entry to `b` runs through
 * `a`, so an ordering it reports holds on every pass by construction; and it is a property of the
 * graph, not of a traversal, so no permutation can change it. On the port's own graph every path
 * to `fix` passes through `audit` and `parse`, so they are ordered and GRAPH010 is correctly
 * silent; in `siblings.json` `summarize` is reached from `start` without `fix`, so they are
 * concurrent and it correctly refuses.
 *
 * WHAT §A.84 COSTS PER COMPILE, measured rather than waved at, because this is the second
 * whole-graph relation `indexGraph` now builds. On `scale.test.ts`'s own fixtures:
 *
 *     compile 500 nodes (best of 15)      21 ms before §A.84 -> 54 ms -> 39 ms
 *     compile 500 nodes / 4,900 edges     35.6 ms            -> 73.6 ms -> 65 ms
 *
 * The middle column is this lane's first cut; the last is after the two avoidable O(V)-per-item
 * scans it had added to GRAPH002 and GRAPH005 were replaced by the indexes those rules already
 * had to hand. What remains — roughly 1.9x — is the second closure plus this tree, and it is a
 * real cost rather than a measurement artefact. The growth EXPONENT is untouched at n^0.99 and
 * the guard's bound is 3,000 ms, so it is paid and it is nowhere near the wall.
 *
 * COOPER–HARVEY–KENNEDY, over a VIRTUAL ROOT above the entry set. The virtual root is what makes
 * a multi-entry graph answerable at all: without it two entries have no common dominator and the
 * intersection has nowhere to terminate. Nodes unreachable from any entry get no `idom` and
 * dominate nothing but themselves — GRAPH001 refuses such a node separately and this rule must not
 * also make a claim about it.
 */
function computeDominators(
  spec: GraphSpec,
  entryNodes: readonly NodeId[],
  flowEdges: readonly EdgeSpec[],
): DomTree {
  const ids = spec.nodes.map((n) => n.id);
  const index = new Map<NodeId, number>();
  ids.forEach((id, i) => index.set(id, i));
  const ROOT = ids.length; // the virtual root's slot, one past every real node

  const preds: number[][] = ids.map(() => []);
  for (const e of flowEdges) {
    const to = index.get(e.to);
    const from = index.get(e.from);
    // An edge naming an id no node declares: `GRAPH003_DANGLING_EDGE` reports it on its own.
    if (to !== undefined && from !== undefined) preds[to]!.push(from);
  }
  for (const id of entryNodes) {
    const i = index.get(id);
    if (i !== undefined) preds[i]!.push(ROOT);
  }

  const succs: number[][] = ids.map(() => []);
  for (const e of flowEdges) {
    const to = index.get(e.to);
    const from = index.get(e.from);
    if (to !== undefined && from !== undefined) succs[from]!.push(to);
  }
  const rootSucc: number[] = [];
  for (const id of entryNodes) {
    const i = index.get(id);
    if (i !== undefined) rootSucc.push(i);
  }
  const succOf = (n: number): number[] => (n === ROOT ? rootSucc : succs[n]!);

  // REVERSE POSTORDER FROM THE VIRTUAL ROOT, iteratively. CHK converges in one or two sweeps when
  // a node is visited after its predecessors, and a recursive walk is one JS frame per node on a
  // graph the scale suite builds hundreds deep.
  const postorder: number[] = [];
  const rpoNum = new Map<number, number>();
  {
    const seen = new Set<number>([ROOT]);
    const frames: { n: number; i: number }[] = [{ n: ROOT, i: 0 }];
    while (frames.length > 0) {
      const f = frames[frames.length - 1]!;
      const ss = succOf(f.n);
      if (f.i >= ss.length) {
        postorder.push(f.n);
        frames.pop();
        continue;
      }
      const next = ss[f.i]!;
      f.i += 1;
      if (seen.has(next)) continue;
      seen.add(next);
      frames.push({ n: next, i: 0 });
    }
  }
  const rpo = [...postorder].reverse();
  rpo.forEach((n, i) => rpoNum.set(n, i));

  const idomOf = new Map<number, number>();
  idomOf.set(ROOT, ROOT);
  const intersect = (a: number, b: number): number => {
    let x = a;
    let y = b;
    while (x !== y) {
      // The classic two-finger walk: the node with the LARGER reverse-postorder number is the
      // deeper one, so it climbs.
      while ((rpoNum.get(x) ?? Infinity) > (rpoNum.get(y) ?? Infinity)) x = idomOf.get(x) ?? ROOT;
      while ((rpoNum.get(y) ?? Infinity) > (rpoNum.get(x) ?? Infinity)) y = idomOf.get(y) ?? ROOT;
    }
    return x;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of rpo) {
      if (n === ROOT) continue;
      let candidate: number | undefined;
      for (const p of preds[n]!) {
        if (!idomOf.has(p)) continue; // not yet processed on this sweep
        candidate = candidate === undefined ? p : intersect(p, candidate);
      }
      if (candidate !== undefined && idomOf.get(n) !== candidate) {
        idomOf.set(n, candidate);
        changed = true;
      }
    }
  }

  const idom = new Map<NodeId, NodeId>();
  for (const [n, d] of idomOf) {
    if (n === ROOT || d === ROOT) continue;
    idom.set(ids[n]!, ids[d]!);
  }
  return {
    idom,
    dominates: (a, b) => {
      if (a === b) return true;
      const ai = index.get(a);
      let cur = index.get(b);
      if (ai === undefined || cur === undefined) return false;
      // WALK THE CHAIN, bounded by the node count: a malformed tree cannot spin here.
      for (let steps = 0; steps <= ids.length; steps++) {
        const up = idomOf.get(cur);
        if (up === undefined || up === ROOT || up === cur) return false;
        if (up === ai) return true;
        cur = up;
      }
      return false;
    },
  };
}

/**
 * "CAN `a` HAVE RUN BEFORE `b` ON SOME PASS" — the full closure over every edge the executor takes,
 * on a graph that may have cycles.
 *
 * PRODUCER, NOT ORDER, AND THE TWO NEED OPPOSITE ANSWERS INSIDE A CYCLE. A loop body's nodes have
 * all seen each other's writes by the second pass, so for a PRODUCER question they precede one
 * another — which is this map, and which is what silences `GRAPH005_UNPRODUCED_READ` on a
 * loop-carried write. They are NOT ordered against each other for a CONCURRENCY question: two of
 * them in parallel fan-out branches race, and GRAPH010 must still refuse them. So GRAPH010 reads
 * `dominators` and never this, and `computeDominators` states why nothing weaker will do.
 *
 * ORDER-FREE. A transitive closure over a fixed edge set does not depend on how the walk found it,
 * which is the property the relation this replaced did NOT have.
 *
 * THE COMPONENTS ARE TARJAN'S, AND THE CHEAPER THING WAS TRIED AND IS WRONG. "Everything on the
 * DFS stack between a back-edge's target and its source", unioned across back-edges, looks like it
 * finds the same components and does not: on a loop body that FANS OUT — `head -> left -> merge`,
 * `head -> right -> merge`, `merge -loop-> head` — the walk meets `right -> merge` as a CROSS edge,
 * because `merge` is already finished, so no window ever names `right` and it never joins the
 * component its own back-edge put `left` in. That is the exact graph the last test in
 * `test/graph/loop-edge-analyses.test.ts` drives, and it failed. Tarjan's lowlink is what
 * distinguishes a cross edge INTO the component from one leaving it; a stack window cannot.
 *
 * ONE WALK, NOT TWO. The cut needs "is the target still on the CURRENT PATH" and Tarjan's stack
 * holds finished-but-unassigned nodes too, so `grey` is tracked separately from `onStack` and the
 * two answer their own questions off the same traversal.
 */
function computeFlowOrder(
  spec: GraphSpec,
  entryNodes: readonly NodeId[],
  flowEdges: readonly EdgeSpec[],
): { flowAncestors: ReadonlyMap<NodeId, ReadonlySet<NodeId>> } {
  // EDGES AND NOT TARGETS IN THE ADJACENCY MAP, and a `selfLoop` set built in the same single
  // pass. Both are there because `test/scale.test.ts` counts every read of the spec and asserts
  // the total grows sub-quadratically in elements: the first cut of this function scanned
  // `flowEdges` to find the edge behind a back-edge and scanned it again per node to ask about a
  // self-loop, which is O(V x E) and took the growth exponent from n^0.99 to n^1.52 on the 5,400
  // element fixture — a red on a guard whose whole job is to catch exactly that.
  const ids = spec.nodes.map((n) => n.id);
  const successors = new Map<NodeId, EdgeSpec[]>();
  for (const id of ids) successors.set(id, []);
  const selfLoop = new Set<NodeId>();
  for (const e of flowEdges) {
    successors.get(e.from)?.push(e);
    if (e.from === e.to) selfLoop.add(e.from);
  }

  // ITERATIVELY, with an explicit frame stack. A recursive walk is one JS frame per node and this
  // runs on graphs the scale suite builds with hundreds of nodes on one path; the explicit stack
  // costs a cursor per frame and cannot overflow.
  const cut = new Set<EdgeSpec>();
  const order$ = new Map<NodeId, number>(); // Tarjan's discovery index; also "visited"
  const low = new Map<NodeId, number>();
  const onStack = new Set<NodeId>(); // Tarjan's component stack membership
  const grey = new Set<NodeId>(); // the CURRENT path, which is a smaller set and a different one
  const sccStack: NodeId[] = [];
  const rootOf = new Map<NodeId, NodeId>();
  /** Nodes that really go round a cycle — a component of one node with no self-loop is not one. */
  const inCycle = new Set<NodeId>();
  let counter = 0;

  const open = (id: NodeId): void => {
    order$.set(id, counter);
    low.set(id, counter);
    counter += 1;
    sccStack.push(id);
    onStack.add(id);
    grey.add(id);
  };
  const close = (id: NodeId): void => {
    grey.delete(id);
    if (low.get(id) !== order$.get(id)) return;
    const comp: NodeId[] = [];
    for (;;) {
      const m = sccStack.pop()!;
      onStack.delete(m);
      comp.push(m);
      if (m === id) break;
    }
    for (const m of comp) rootOf.set(m, id);
    if (comp.length > 1) for (const m of comp) inCycle.add(m);
    // A one-node component is a cycle only through a self-loop, which the pass above answered.
    else if (selfLoop.has(id)) inCycle.add(id);
  };

  const walk = (root: NodeId): void => {
    if (order$.has(root)) return;
    open(root);
    const frames: { id: NodeId; i: number }[] = [{ id: root, i: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const succ = successors.get(frame.id) ?? [];
      if (frame.i >= succ.length) {
        close(frame.id);
        frames.pop();
        const parentFrame = frames[frames.length - 1];
        if (parentFrame !== undefined) {
          low.set(parentFrame.id, Math.min(low.get(parentFrame.id)!, low.get(frame.id)!));
        }
        continue;
      }
      const edge = succ[frame.i]!;
      const next = edge.to;
      frame.i += 1;
      if (!order$.has(next)) {
        open(next);
        frames.push({ id: next, i: 0 });
        continue;
      }
      // ON THE COMPONENT STACK -> the target is in this node's component whether the edge was a
      // back-edge or a cross-edge, which is the distinction a stack window cannot make.
      if (onStack.has(next)) low.set(frame.id, Math.min(low.get(frame.id)!, order$.get(next)!));
    }
  };

  // ENTRIES FIRST, THEN EVERY REMAINING NODE. The second pass is not decoration: an unreachable
  // component has no entry node of its own, and leaving it unvisited would leave its members with
  // an empty `flowAncestors` — which GRAPH005 reads as "nothing wrote this". GRAPH001 refuses such
  // a component separately; this rule must not also lie about it. The ORDER of the two passes
  // cannot change the answer — Tarjan's components are a property of the graph.
  for (const id of entryNodes) walk(id);
  for (const id of ids) walk(id);

  // ON THE CONDENSATION, because an acyclic-reachability relation ∪ "everybody in my component"
  // is NOT the closure and the difference is a shipped graph: `harden-config.json`'s `collate` sits
  // OUTSIDE the loop, one `conditional` edge off `audit`, and reads a channel only `fix` — inside
  // the loop — writes. `fix` precedes it through the back-edge and then out of the cycle, which is
  // two hops of two different relations, and a predicate that unions the two without closing over
  // them says no. Collapsing each component to a point makes the graph acyclic and the ordinary
  // accumulate-over-a-topological-order answer correct again.
  const compIds = [...new Set(ids.map((id) => rootOf.get(id)!))];
  const members = new Map<NodeId, NodeId[]>();
  for (const c of compIds) members.set(c, []);
  for (const id of ids) members.get(rootOf.get(id)!)!.push(id);
  // TWO FIELDS, NOT A SPREAD. `topoSort` reads `from` and `to` and nothing else, and `{...e}`
  // copies every declared field of every edge — which `scale.test.ts`'s proxy counts, for a
  // condensation that throws the copy away.
  const compEdges: EdgeSpec[] = [];
  for (const e of flowEdges) {
    const a = rootOf.get(e.from);
    const b = rootOf.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) compEdges.push({ from: a, to: b } as EdgeSpec);
  }
  const compOrder = topoSort(compIds, compEdges);
  const compIn = new Map<NodeId, NodeId[]>();
  for (const c of compIds) compIn.set(c, []);
  for (const e of compEdges) compIn.get(e.to)?.push(e.from);
  const compAncestors = new Map<NodeId, Set<NodeId>>();
  for (const c of compIds) compAncestors.set(c, new Set());
  for (const c of compOrder) {
    const acc = compAncestors.get(c)!;
    for (const from of compIn.get(c) ?? []) {
      acc.add(from);
      for (const a of compAncestors.get(from) ?? []) acc.add(a);
    }
  }
  const flowAncestors = new Map<NodeId, Set<NodeId>>();
  for (const id of ids) {
    const acc = new Set<NodeId>();
    for (const c of compAncestors.get(rootOf.get(id)!) ?? []) for (const m of members.get(c) ?? []) acc.add(m);
    // Its own component's members count only when the component really is a cycle: a node that
    // goes round has seen every other member's writes by its second pass. A component of one node
    // with no self-loop is just a node, and `producedBySelf` is the rule that owns that case.
    if (inCycle.has(id)) for (const m of members.get(rootOf.get(id)!) ?? []) acc.add(m);
    flowAncestors.set(id, acc);
  }

  return { flowAncestors };
}

/**
 * CAN `a` HAVE RUN BEFORE `b` — the producer question, and the one predicate that answers it.
 *
 * `flowAncestors` ALONE, and the two things it already contains are why it is not a union:
 *
 *   `ancestors` ⊆ this, by construction — `dagEdges` ⊆ `flowEdges` and this is a full closure —
 *     so no reader of this predicate can start warning about a graph the old code was silent on.
 *   THE LOOP-CARRIED WRITE. `audit` reads a channel only `fix` writes, and on every pass after the
 *     first it has. That is a real read of a real value and `GRAPH005_UNPRODUCED_READ` said it was
 *     not, on a shipped example, on every command.
 *
 * NOT `dominators`, which is the same edge set asked a stricter question: "every path" is right
 * for a concurrency question and far too strong for this one — a loop-carried write reaches its
 * reader on a path that need not be every path.
 *
 * WHAT IT GIVES UP, stated because a widened predicate is a quieter compiler: the FIRST pass of a
 * loop reads what nothing has written yet. `harden-config.json`'s `audit` reads `applied` before
 * `fix` has ever run, which is intentional there — the channel is `append_ordered` and starts
 * empty — but the general case is a real hazard that no diagnostic now names, and naming it is a
 * new rule about iteration one rather than a wider version of this one.
 */
function canPrecede(idx: GraphIndex, a: NodeId, b: NodeId): boolean {
  return idx.flowAncestors.get(b)?.has(a) ?? false;
}

/**
 * Kahn, over an adjacency map rather than over the edge list.
 *
 * THE ORDER IS PART OF THE CONTRACT and is unchanged: successors are visited in edge-list
 * order and the queue is still FIFO, so this produces the same sequence the edge scan did.
 * `topoOrder` drives the ancestor closure, the fan-out stacks and the critical path, and a
 * different order would move diagnostics for no reason.
 *
 * What changed is the cost. Dequeuing a node used to scan EVERY edge to find its successors, so
 * the sort was O(V x E): 500 x 4,900 = 2.45M comparisons on `scale.test.ts`'s own largest
 * fixture, and 1,500 x 14,900 = 22.4M on a 1,500-node member of the SAME family — which is a
 * benchmark size, not a fixture this repo holds. `queue.shift()` is O(n) on top of it. The
 * `successors` map is built once and the queue is walked with a cursor instead.
 *
 * The `outbound` map `indexGraph` holds cannot be reused here: it is over ALL edges, and this
 * sort is over `dagEdges` only, so its indegrees and its successors have to come from the same
 * list.
 */
function topoSort(ids: readonly NodeId[], edges: readonly EdgeSpec[]): NodeId[] {
  const indegree = new Map<NodeId, number>();
  for (const id of ids) indegree.set(id, 0);
  const successors = new Map<NodeId, NodeId[]>();
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    const at = successors.get(e.from);
    if (at === undefined) successors.set(e.from, [e.to]);
    else at.push(e.to);
  }

  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const out: NodeId[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor]!;
    out.push(id);
    for (const to of successors.get(id) ?? []) {
      const d = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  // A short result means the forward graph has a cycle — GRAPH006 reports it.
  return out.length === ids.length ? out : [];
}

/**
 * The stack of fan-out widths enclosing each node.
 *
 * A STACK, not a product, because two things are wanted from it and only one survives
 * multiplication. Its LENGTH is the node's fan-out depth — how many coordinate segments a
 * Task of that node carries — which is what a join needs to know which instance of itself
 * an arriving branch belongs to. Its PRODUCT is the concurrent width GRAPH010 uses.
 *
 * The predecessor collapsed to `1` on any inbound `join` edge, which is wrong for a join
 * nested inside a fan-out: such a join runs once per outer branch and reported width 1, so
 * a nested graph whose only writer of a `replace` channel was that join compiled with no
 * diagnostic. Popping one level instead of collapsing keeps the outer widths.
 *
 * `undefined` for a node means AMBIGUOUS — two inbound paths disagree about the enclosing
 * fan-outs. That is legal for ordinary nodes (GRAPH010 then takes the widest reading) and
 * refused for joins and their arms, where the depth decides identity.
 */
function computeFanoutStacks(
  spec: GraphSpec,
  topoOrder: readonly NodeId[],
  inbound: ReadonlyMap<NodeId, readonly EdgeSpec[]>,
): {
  stacks: Map<NodeId, readonly number[] | undefined>;
  widths: Map<NodeId, number>;
  edgeStacks: Map<NodeId, readonly EdgeId[] | undefined>;
} {
  const stacks = new Map<NodeId, readonly number[] | undefined>();
  const widths = new Map<NodeId, number>();
  // The same stack in edge ids — see `GraphIndex.fanoutEdgeStack`. Folded into this traversal
  // rather than written as a second one, because a second walk with the same push/pop/agree
  // rules is a second thing to keep in step with this one.
  const edgeStacks = new Map<NodeId, readonly EdgeId[] | undefined>();
  for (const n of spec.nodes) {
    stacks.set(n.id, []);
    widths.set(n.id, 1);
    edgeStacks.set(n.id, []);
  }

  const product = (s: readonly number[]): number => s.reduce((a, b) => a * b, 1);

  for (const id of topoOrder) {
    const ins = (inbound.get(id) ?? []).filter((e) => e.kind !== "loop" && e.kind !== "compensation");
    if (ins.length === 0) continue;

    const candidates: (readonly number[] | undefined)[] = ins.map((e) => {
      const parent = stacks.get(e.from);
      if (parent === undefined) return undefined;
      if (e.kind === "fanout") return [...parent, countOr1(e.maxWidth)];
      if (e.kind === "join") return parent.slice(0, -1);
      return parent;
    });

    const known = candidates.filter((c): c is readonly number[] => c !== undefined);
    const agreed =
      known.length === candidates.length &&
      known.every((c) => c.length === known[0]!.length && c.every((w, i) => w === known[0]![i]));
    stacks.set(id, agreed ? known[0]! : undefined);

    // Same push, same pop, same agreement test, over edge ids.
    const edgeCandidates: (readonly EdgeId[] | undefined)[] = ins.map((e) => {
      const parent = edgeStacks.get(e.from);
      if (parent === undefined) return undefined;
      if (e.kind === "fanout") return [...parent, e.id];
      if (e.kind === "join") return parent.slice(0, -1);
      return parent;
    });
    const knownEdges = edgeCandidates.filter((c): c is readonly EdgeId[] => c !== undefined);
    const edgesAgreed =
      knownEdges.length === edgeCandidates.length &&
      knownEdges.every((c) => c.length === knownEdges[0]!.length && c.every((x, i) => x === knownEdges[0]![i]));
    edgeStacks.set(id, edgesAgreed ? knownEdges[0]! : undefined);

    // WIDTH IS COMPUTED SEPARATELY, AND NEVER FROM `known` ALONE.
    //
    // Ambiguity propagates: one undefined stack makes every descendant's stack undefined
    // too. Taking the max over `known` therefore collapsed to `Math.max(1, ...[], 1)` — a
    // width of ONE — for any node all of whose inbound paths were ambiguous, and
    // GRAPH010's concurrent-writer refusal reads this number. Under-counting concurrency
    // is the unsafe direction: it lets racing writers through on exactly the graphs whose
    // shape the compiler already admits it cannot follow.
    //
    // So width falls back to the PARENT'S width rather than to 1, and a `join` whose
    // parent stack is unknown does not pop a level it cannot see. Both over-approximate,
    // which is the direction that refuses more rather than fewer.
    const edgeWidth = (e: EdgeSpec): number => {
      const parentWidth = widths.get(e.from) ?? 1;
      const parentStack = stacks.get(e.from);
      if (e.kind === "fanout") return parentWidth * countOr1(e.maxWidth);
      if (e.kind === "join") return parentStack === undefined ? parentWidth : product(parentStack.slice(0, -1));
      return parentWidth;
    };
    widths.set(id, Math.max(1, ...ins.map(edgeWidth)));
  }
  return { stacks, widths, edgeStacks };
}

/**
 * Total instances = parallel width × loop iterations.
 *
 * Loop passes are SEQUENTIAL, so they must not feed the concurrency analysis — a node
 * that writes a `replace` channel inside a 3-iteration loop is perfectly well-defined
 * (each pass overwrites the last), whereas the same node behind a 25-way fan-out is
 * 25 racing writers. Conflating the two produced a false GRAPH010 on the worked
 * example, which is how this split was found.
 *
 * The cycle body is approximated as the nodes that are both descendants of the loop
 * target and ancestors-or-self of the loop source — exact for the single-entry loops
 * the compiler permits.
 */
function applyLoopFactors(
  spec: GraphSpec,
  parallelWidth: ReadonlyMap<NodeId, number>,
  loopEdges: readonly EdgeSpec[],
  ancestors: ReadonlyMap<NodeId, ReadonlySet<NodeId>>,
): Map<NodeId, number> {
  const mult = new Map<NodeId, number>(parallelWidth);
  for (const loop of loopEdges) {
    const iterations = countOr1(loop.maxIterations);
    for (const n of spec.nodes) {
      const isInCycle =
        n.id === loop.to ||
        n.id === loop.from ||
        ((ancestors.get(loop.from)?.has(n.id) ?? false) && (ancestors.get(n.id)?.has(loop.to) ?? false));
      if (isInCycle) mult.set(n.id, (mult.get(n.id) ?? 1) * iterations);
    }
  }
  return mult;
}

function computeCriticalPath(
  spec: GraphSpec,
  topoOrder: readonly NodeId[],
  outbound: ReadonlyMap<NodeId, readonly EdgeSpec[]>,
): Map<NodeId, number> {
  const depth = new Map<NodeId, number>();
  for (const n of spec.nodes) depth.set(n.id, 1);
  // Reverse topological order, so successors are settled before predecessors.
  for (let i = topoOrder.length - 1; i >= 0; i--) {
    const id = topoOrder[i]!;
    let best = 0;
    for (const e of outbound.get(id) ?? []) {
      if (e.kind === "loop" || e.kind === "compensation") continue;
      best = Math.max(best, depth.get(e.to) ?? 1);
    }
    depth.set(id, best + 1);
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * THE CEILINGS THEMSELVES ARE A LIMIT THAT COULD MOVE ON ITS OWN, which is the one direction a
 * limit must never move — `spec.ts`'s `POLICY_FIELDS` docstring says so about a MISSPELLED key,
 * and `GRAPH020_UNKNOWN_FIELD` closes that half. This is the other half: the key spelled right
 * and the value unusable. `{...DEFAULT_EXPANSION, ...spec.policy.expansion}` took whatever was
 * there, and every reader compares against it with a bare relational operator, so a string was
 * `NaN` on the RIGHT of the comparison and switched the ceiling off:
 *
 *     "maxFanout": "banana", "maxWidth": 30   ->  ok, exit 0
 *     "maxFanout": 24,       "maxWidth": 30   ->  GRAPH007_MAX_WIDTH_EXCEEDED
 *     "maxNodes": "banana"                    ->  ok, exit 0
 *     "maxNodes": 64                          ->  GRAPH018_NODE_COUNT
 *
 * Found by a reviewer of the `maxWidth` rule below: `maxFanout` is the OTHER OPERAND of the very
 * comparison that rule exists for, and unlike a `bigint` width it is reachable from plain JSON
 * through the shipped CLI. It also made the new `GRAPH007_BAD_MAX_WIDTH` fix line read "a whole
 * number between 1 and banana".
 *
 * The bad member falls back to its default AND is refused: falling back alone would leave the
 * author with a ceiling they did not write, and refusing alone would leave the rest of this
 * compile reading a `NaN`. `GRAPH003_MALFORMED` rather than a new code, for the reason
 * `objectBlock` gives above — an eighth, or ninth, spelling of "this is not the shape it must
 * be" is how diagnostics come to disagree about what they mean.
 */
function expansionOf(spec: GraphSpec, d: Diagnostic[]): ExpansionBudget {
  const declared = (spec.policy?.expansion ?? {}) as unknown as Record<string, unknown>;
  const out: Record<keyof ExpansionBudget, number> = { ...DEFAULT_EXPANSION };
  for (const k of Object.keys(DEFAULT_EXPANSION) as (keyof ExpansionBudget)[]) {
    if (!Object.hasOwn(declared, k)) continue;
    const v = declared[k];
    if (isPositiveInt(v)) {
      out[k] = v;
      continue;
    }
    d.push({
      severity: "error",
      code: "GRAPH003_MALFORMED",
      message:
        `policy.expansion.${k} is ${describeValue(v)}, which is not a positive integer — ` +
        `every limit is compared with \`>\`, and a value that is not a number makes that comparison false ` +
        `for everything, so the ceiling stops refusing anything`,
      fix: `set policy.expansion.${k} to a whole number ≥ 1, or remove it to take the default of ${DEFAULT_EXPANSION[k]}`,
    });
  }
  return out;
}

export function validateGraph(ctx: ValidationContext): readonly Diagnostic[] {
  const { spec } = ctx;
  const d: Diagnostic[] = [];

  // Structural problems make every later rule report nonsense, so they gate.
  const structural = checkStructure(spec, d);
  if (structural) return d;

  const idx = ctx.index === undefined ? indexGraph(spec) : ctx.index();
  const expansion = expansionOf(spec, d);
  const channelTypes = channelTypeMap(spec.channels);

  rule001Reachability(spec, idx, d);
  rule002Terminals(spec, idx, d);
  rule004Expressions(spec, idx, channelTypes, d);
  rule005Dataflow(spec, idx, d);
  rule005RouterEdges(spec, idx, d);
  rule006Cycles(spec, idx, channelTypes, d);
  rule007Fanout(spec, expansion, d);
  rule008Joins(spec, idx, d);
  rule021FanoutHasJoin(spec, idx, d);
  rule009And018Budgets(spec, idx, expansion, d);
  rule010ConcurrentWriters(spec, idx, d);
  checkToolNames(spec, ctx.tools, d);
  rule011And012ErrorPaths(spec, idx, ctx.tools, d);
  rule013Reducers(spec, d);
  // ONE MEMO FOR THE WHOLE WALK, and it has to be created HERE rather than inside the rule
  // that reads it: `rule016Subgraphs` runs first and carries `ctx` into every child, so a map
  // made in `rule017Capabilities` would be a fresh one per level and share nothing across them.
  const walkCtx: ValidationContext =
    ctx.toolReachMemo === undefined ? { ...ctx, toolReachMemo: new Map<string, readonly string[]>() } : ctx;
  rule014And019Oversight(spec, idx, walkCtx, expansion, d);
  rule015Resources(spec, ctx.resolver, d);
  rule016Subgraphs(spec, walkCtx, expansion, d);
  rule017Capabilities(spec, walkCtx, expansion, d);

  return d;
}

function channelTypeMap(channels: Readonly<Record<string, ChannelSpec>>): Record<string, Ty> {
  const out: Record<string, Ty> = {};
  for (const [name, spec] of Object.entries(channels)) out[name] = spec.type as Ty;
  return out;
}

// ── GRAPH003 + GRAPH020: structure ───────────────────────────────────────────

/**
 * What a data classification may be, and the list a diagnostic quotes back.
 *
 * ONE TEST, TWO CALLERS, and it stays module-private on purpose. `vocab.ts` exports `isPosture`
 * because the posture vocabulary is folded in files across the tree; a classification is only
 * ever *authored* in a graph, so the only thing that has to test membership is the compiler, and
 * a third exported name on a pinned public surface buys nothing. Both sites here — a channel's
 * `classification` and a delivery block's `redactAs` — now ask this rather than each spelling
 * `Object.hasOwn(CLASSIFICATION_POSTURE_FLOOR, …)` for itself, which is the two-copies drift
 * `unknownKeys` below was written to end one scope over.
 *
 * The floor table is the source because it is TOTAL over the union — every member has a floor —
 * so it cannot fall out of step with the union the way a hand-written list can.
 */
const CLASSIFICATIONS: readonly string[] = Object.keys(CLASSIFICATION_POSTURE_FLOOR);

function isClassification(v: unknown): v is Classification {
  return typeof v === "string" && Object.hasOwn(CLASSIFICATION_POSTURE_FLOOR, v);
}

/**
 * The three values in a `contextProjection`, checked at compile instead of only at run time.
 *
 * `unknownKeys` above validates the KEY NAMES and nothing looked at what they hold, so
 * `take: "abc"`, `maxTokens: "abc"` and `overflow: "TRUNCATE_TAIL"` all compiled clean and
 * refused at run time — `overflow` from inside prompt assembly, at whichever node first grew a
 * channel past its bound, which may be hours after the graph was published. `run/context.ts`
 * says in two places that the compile-time half belongs here; this is it.
 *
 * PRESENT-AND-UNREADABLE ONLY, never absent. `applyOverflow` refuses an absent `maxTokens` and an
 * absent `overflow` too, but it only runs at rung 2 — when a channel actually exceeds its bound —
 * so a graph that declares neither runs correctly today for as long as it stays under. Refusing
 * those at compile would refuse working graphs, which is a different change from closing a hole;
 * the run-time refusal still covers them, unchanged.
 *
 * THE ACCEPTED SETS ARE `run/context.ts`'s, restated rather than imported: `graph/` must not
 * depend on `run/`, and `readBound` is module-private there. What holds them together is a test
 * that drives the same table through both — see `perf-lane-context-projection-values.test.ts`,
 * which asserts the diagnostic fires exactly when the runtime refuses.
 */
function checkProjectionValues(channel: string, projection: Record<string, unknown>, d: Diagnostic[]): void {
  const bad = (message: string, fix: string): void => {
    d.push({ severity: "error", code: "GRAPH003_MALFORMED", message, at: { channel }, fix });
  };

  // `project()` reads a `take` that is neither `undefined` nor `null`, and refuses whatever it
  // cannot read — including `""`, `false` and `[]`, which `Number()` would have coerced to a
  // bound of zero. A NEGATIVE take is legal and means "the last N".
  const take = projection["take"];
  if (take !== undefined && take !== null && readProjectionBound(take) === undefined) {
    bad(
      `channel "${channel}"'s \`contextProjection.take\` is not an item count: ${describeProjectionValue(take)}`,
      "use a number, or a quoted number like `take: \"3\"`; remove it to show the whole value",
    );
  }

  // `applyOverflow` requires a readable bound STRICTLY ABOVE ZERO: a negative one passed the
  // finite test and then truncated nothing, because `slice(0, -20)` removes nothing.
  const maxTokens = projection["maxTokens"];
  if (maxTokens !== undefined) {
    const bound = readProjectionBound(maxTokens);
    if (bound === undefined || bound <= 0) {
      bad(
        `channel "${channel}"'s \`contextProjection.maxTokens\` is not a positive token bound: ${describeProjectionValue(maxTokens)}`,
        "use a positive number, or a quoted one like `maxTokens: \"2000\"`",
      );
    }
  }

  const overflow = projection["overflow"];
  if (overflow !== undefined && !OVERFLOW_RULES.includes(overflow as never)) {
    bad(
      `channel "${channel}"'s \`contextProjection.overflow\` is not a rule this build knows: ${describeProjectionValue(overflow)}`,
      `use one of ${OVERFLOW_RULES.join(", ")}`,
    );
  }
}

/** The `overflow` arms `run/context.ts`'s switch has, in the order its own message lists them. */
const OVERFLOW_RULES: readonly string[] = ["error", "truncate_tail", "summarize"];

/**
 * A finite number, or a string that PARSES as one — `take: "3"` is what hand-written YAML gives
 * for a quoted number, and it is the one non-number worth reading. Everything else is unreadable,
 * `""` and `false` and `[]` among them. This is `readBound` in `run/context.ts`, restated.
 */
function readProjectionBound(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** The rejected value, rendered so the author can see WHICH one it was — NaN and Infinity too. */
function describeProjectionValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  return JSON.stringify(value) ?? String(value);
}

/**
 * Report every key of `got` that `allowed` does not contain, suggesting the nearest real one.
 *
 * One function because there are now FOUR scopes to check — a node's type block, the node
 * itself, the graph, and an edge — and the block-level version was written first as a loop
 * inline. Four copies of "compare keys, guess the typo, push a diagnostic" is how the four
 * come to disagree about what a near miss is or how the message reads.
 */
function unknownKeys(
  got: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  what: string,
  at: Diagnostic["at"],
  d: Diagnostic[],
): boolean {
  let found = false;
  for (const key of Object.keys(got)) {
    if (allowed.includes(key)) continue;
    const near = allowed.filter((a) => a.toLowerCase().startsWith(key.slice(0, 3).toLowerCase()));
    d.push({
      severity: "error",
      code: "GRAPH020_UNKNOWN_FIELD",
      message: `${what} has an unknown field \`${key}\``,
      ...(at === undefined ? {} : { at }),
      fix:
        near.length > 0
          ? `did you mean ${near.map((a) => `\`${a}\``).join(" or ")}?`
          : `${what} may declare ${allowed.map((a) => `\`${a}\``).join(", ")}`,
    });
    found = true;
  }
  return found;
}

/**
 * The seven members of `EdgeKind`, as data a runtime check can read.
 *
 * `NodeType` is closed by GRAPH020 twenty lines from where the edge fields are checked, and this
 * set was not closed anywhere: `EDGE_FIELDS` checks an edge's KEYS and nothing checked the VALUE
 * of `kind`. Measured — `kind: "conditionl"`, `"Conditional"`, `"eror"` and `"__proto__"` all
 * compiled with ZERO diagnostics at any severity, and at run time each fell to `#edgesToTake`'s
 * `default:` arm and was TAKEN with its `when` never evaluated. The comment three lines above
 * `EDGE_FIELDS` states the consequence for the sibling case it did close: "A misspelled `when`
 * does not disable a condition — it makes the edge unconditional, so a branch the author meant to
 * guard fires every time."
 *
 * MOVED HERE FROM `graph/compile.ts` (§A.80) — where its own docstring said it did not belong,
 * *"only because of who owns which file today"*. `compile` ran the check on the top-level spec
 * alone and `rule016Subgraphs` recurses `validateGraph`, so a subgraph CHILD's `kind` was
 * unchecked; the refusal is now in `checkStructure`'s edge loop, which the child recursion runs.
 * `run/engine.ts` keeps its own copy on purpose: `Executor.attach()` is public and a `RunGraph`
 * can reach it without this build's compiler (`#assertBound`).
 */
const EDGE_KINDS: Readonly<Record<EdgeKind, true>> = {
  seq: true,
  conditional: true,
  fanout: true,
  join: true,
  error: true,
  compensation: true,
  loop: true,
};

/**
 * THE EDGE FIELDS THIS PASS DOES NOT RE-CHECK, and the check that already refuses every
 * wrong-typed value of each.
 *
 * `EDGE_FIELDS` carries a type per field (see its docstring in `graph/spec.ts`), and
 * `edgeFieldTypes` below enforces it. Six of the thirteen are left out, because for each one a
 * refusal already covers EVERY wrong type — measured, one graph per value, in
 * `test/graph/edge-field-types.test.ts`, which is what stops this set from becoming a list of
 * holes somebody once believed were covered:
 *
 *     id          GRAPH003_BAD_ID       `isSafeId` is false for every non-string
 *     from, to    GRAPH003_DANGLING_EDGE  a non-string is not a node id, so it dangles
 *     kind        GRAPH003_UNKNOWN_EDGE_KIND  in `checkStructure`'s own edge loop below, which
 *                 refuses "ANY KIND THAT IS NOT AN OWN KEY OF `EDGE_KINDS`, WHATEVER ITS TYPE"
 *     when, until GRAPH004_EXPR         `checkExpr` refuses every value, strings included
 *
 * "REFUSES EVERY WRONG TYPE" IS THE CLAIM, AND IT HAS ONE STATED EXCLUSION. Five of the six are
 * total, now that the sites naming the value render it through `describeValue` — before that a
 * `symbol` id threw `TypeError: Cannot convert a Symbol value to a string` out of this function
 * and a `bigint` id threw `Do not know how to serialize a BigInt` out of `badId`, which is a crash
 * where a refusal belonged. `kind` is the exclusion, and the REASON changed at §A.80 while the
 * exclusion did not: the check moved into this file, and its message still renders the value with
 * `JSON.stringify(edge.kind) ?? String(edge.kind)` rather than with `describeValue`, because the
 * two print different bytes for `{}` and `[]` and a relocation that also rewrites a diagnostic is
 * not a relocation. So `kind: 10n` and a `kind` whose `toJSON` throws still come out of `compile`
 * as an exception. The class is named and the two values are pinned as throwing in
 * `test/graph/edge-field-types.test.ts`, so the exclusion is a measured fact and not a hope, and
 * closing it is a decision about those bytes rather than about this set.
 *
 * A SECOND SPELLING OF ONE REFUSAL is the thing being avoided, and `objectBlock` below states the
 * cost: "an eighth spelling of one idea is how diagnostics come to disagree about what they
 * mean". For `kind` it is not even a matter of taste — the kind check and a type check here would
 * print two refusals for one mistake, which is why `kind` stays on this list now that the kind
 * check is a dozen screens down rather than in another file.
 *
 * THE DEFAULT IS TO CHECK. A field added to `EDGE_FIELDS` is type-checked unless somebody opts it
 * out here, which is the fail-closed direction: the failure mode of forgetting this set is a
 * duplicate diagnostic, not a hole.
 */
const TYPE_CHECKED_ELSEWHERE: ReadonlySet<string> = new Set(["id", "from", "to", "kind", "when", "until"]);

/**
 * One predicate per tag of `EDGE_FIELDS` — the whole of the type half of the edge schema.
 *
 * `count` IS `Number.isSafeInteger` ALONE, and the missing `>= 1` is deliberate. `maxWidth: 0` and
 * `maxIterations: 0` are well-typed counts with a policy problem: a fan-out of nothing is silent
 * and a loop bound of nothing is unbounded, and the rules that own those facts —
 * `rule007Fanout`'s ceiling and `rule006Cycles`' unbounded loop — keep the codes they have always
 * had for them, which three suites assert on. A parse decides types; a rule decides meaning. The
 * refusal below still says "not a positive integer" for those two, because that is the sentence
 * they have always printed and the values that reach it are not integers at all.
 *
 * `stringArray` INDEX-WALKS, AND `Array.prototype.every` IS WHY. `every` SKIPS HOLES: it visits
 * own indices only, so `new Array(2)` — and any array-like whose `length` is larger than the
 * indices it actually has — passed `v.every(x => typeof x === "string")` VACUOUSLY and then
 * reached `digest(spec)`, which walks `0..length-1` and does not skip. Measured on the fixture,
 * one graph per case:
 *
 *     branches: new Array(2)  ->  THREW CanonicalizationError: undefined array element
 *                                 at edges[2].branches[0]
 *     branches: [, "a"]       ->  the same, at edges[2].branches[0]
 *     codes: new Array(1)     ->  the same, at edges[13].codes[0]
 *
 * That is the exact crash class this check exists to close, reached by the one value shape `every`
 * cannot see. The loop below asks about every index the length claims, which is the same set
 * `canonical.ts` will ask about.
 */
const EDGE_FIELD_IS: Readonly<Record<"string" | "count" | "stringArray", (v: unknown) => boolean>> = {
  string: (v) => typeof v === "string",
  count: (v) => Number.isSafeInteger(v),
  stringArray: (v) => {
    if (!Array.isArray(v)) return false;
    for (let i = 0; i < v.length; i++) if (typeof v[i] !== "string") return false;
    return true;
  },
};

/**
 * What a field of each tag is, in the words the refusal uses, and the edit it asks for.
 *
 * "OR REMOVE IT" IS PER TAG AND IS DECIDED BY MEASURING EVERY FIELD OF THAT TAG on the kind that
 * declares it, because this `to` is only ever used on THAT kind — the other branch of
 * `edgeFieldTypes` writes its own "remove it" and never comes here. Removal has to be a fix the
 * compiler then accepts, and for the `string` fields it is not:
 *
 *     over / as missing on a fanout          GRAPH007_FANOUT_INCOMPLETE
 *     compensates missing on a compensation  GRAPH012_NO_COMPENSATES
 *     maxWidth missing on a fanout           GRAPH007_NO_MAX_WIDTH  (`count`)
 *     maxIterations missing on a loop        GRAPH006_UNBOUNDED_LOOP (`count`)
 *     branches missing on a join             ok, zero diagnostics
 *     codes missing on an error edge         ok, zero diagnostics
 *
 * — all six measured, one graph each. So `stringArray` keeps the hint and the other two do not. A
 * fix an author follows into a second refusal is worse than no fix; a fix that withholds the
 * simplest valid edit is worse than one that offers it. THE NEXT FIELD OF EITHER TAG HAS TO BE
 * MEASURED THE SAME WAY — a required `stringArray` field would make this row wrong, which is why
 * the table above it is the type and this one is the advice.
 *
 * `count` says "a whole number" and not "a whole number ≥ 1", because the tag is
 * `Number.isSafeInteger` alone; the two fields that DO want `≥ 1` say so in their own row below.
 * This row is unreached today for that reason, and it has to be right for the next count field
 * rather than for the two that exist.
 */
const EDGE_FIELD_SHAPE: Readonly<Record<"string" | "count" | "stringArray", { readonly is: string; readonly to: string }>> = {
  string: { is: "a string", to: "a string" },
  count: { is: "a whole number", to: "a whole number" },
  stringArray: { is: "an array of strings", to: "an array of strings, or remove it" },
};

/**
 * DATA, NOT A PREDICATE: the two fields whose wrong-type refusal has a code of its own.
 *
 * `GRAPH007_BAD_MAX_WIDTH` and `GRAPH006_BAD_MAX_ITERATIONS` were the two hand-written type
 * checks §A.62 exists to delete, and they are named by `test/examples-triage.test.ts` and by two
 * suites under `test/graph/` — so the mechanism moved and the vocabulary did not. Everything else
 * gets `GRAPH003_MALFORMED`, this file's existing answer at nine sites for "a value is not the
 * shape it must be". A THIRD code for a refusal two codes already name is the thing not to add,
 * and nothing here has to be touched to add a fourteenth field.
 */
const EDGE_FIELD_REFUSAL: Readonly<
  Record<
    string,
    { readonly code: string; readonly is: string; readonly to: (maxFanout: number) => string; readonly because: string }
  >
> = {
  maxWidth: {
    code: "GRAPH007_BAD_MAX_WIDTH",
    is: "a positive integer",
    // THE GRAPH'S OWN CEILING, not a bare `≥ 1`. `rule007Fanout` printed `between 1 and
    // ${expansion.maxFanout}` here before this check took the type half, and dropping it made the
    // fix less useful than the one it replaced — an author told `≥ 1` can still write a width the
    // very next rule refuses. The parse has the whole spec, so the number is readable.
    to: (maxFanout) => `a whole number between 1 and ${maxFanout} (unquoted: 24, not "24")`,
    because:
      "the width is multiplied into every downstream node's parallel width and sliced off the fanned channel, " +
      "and neither reader can use this value",
  },
  maxIterations: {
    code: "GRAPH006_BAD_MAX_ITERATIONS",
    is: "a positive integer",
    to: () => 'a whole number ≥ 1 (unquoted: 3, not "3")',
    because:
      "the bound is compared against the iteration counter and multiplied into the node's total multiplicity, " +
      "and neither reader can use this value",
  },
};

/**
 * `expansion.maxFanout` WITHOUT DIAGNOSING IT, because `expansionOf` is the one allowed to do
 * that — and on the path that reaches this function, `expansionOf` NEVER RUNS.
 *
 * AN EARLIER VERSION OF THIS COMMENT SAID THE AUTHOR STILL GETS THE BAD MEMBER'S OWN REFUSAL
 * "as well". THAT IS FALSE, and the measurement is one graph carrying both faults:
 *
 *     maxFanout: "24" alone              GRAPH003_MALFORMED — policy.expansion.maxFanout is "24",
 *                                        which is not a positive integer …
 *     maxFanout: "24" + maxWidth: "24"   GRAPH007_BAD_MAX_WIDTH ONLY, ceiling 32
 *
 * `edgeFieldTypes` is fatal, `checkStructure` gates, and `expansionOf` is called after the gate —
 * so a graph with a wrong-typed edge field never reaches it and the expansion member's refusal is
 * suppressed until the author has fixed the edge and compiled again. Both faults were reported in
 * one pass before this check existed. That is the cost of moving the type check in front of the
 * gate, it is paid on multi-fault graphs only, and it is the same suppression `edgeFieldTypes`
 * documents for warnings and for unrelated errors — recorded here because THIS function is where a
 * reader would otherwise conclude the opposite.
 *
 * WHAT IS TRUE: the number is `expansionOf`'s, member for member — `Object.hasOwn`, then a
 * declared value that is a positive integer, else `DEFAULT_EXPANSION`. `Object.hasOwn` and not a
 * bare index, for the reason `edgeFieldTypes` gives: with `Object.prototype.maxFanout = 8` set and
 * a graph that declares no `maxFanout` of its own, a bare read returned 8 while `expansionOf`
 * returned 32, so the fix said "between 1 and 8" about a ceiling `rule007Fanout` enforced at 32 —
 * two numbers for one limit, which is worse than either.
 */
function maxFanoutOf(spec: GraphSpec): number {
  const policy: unknown = spec.policy;
  if (typeof policy !== "object" || policy === null) return DEFAULT_EXPANSION.maxFanout;
  const declared: unknown = (policy as Record<string, unknown>)["expansion"];
  if (typeof declared !== "object" || declared === null) return DEFAULT_EXPANSION.maxFanout;
  if (!Object.hasOwn(declared as Record<string, unknown>, "maxFanout")) return DEFAULT_EXPANSION.maxFanout;
  const v: unknown = (declared as Record<string, unknown>)["maxFanout"];
  return isPositiveInt(v) ? v : DEFAULT_EXPANSION.maxFanout;
}

/**
 * Every declared field of one edge, against the type `EDGE_FIELDS` gives it.
 *
 * FATAL, for the reason `checkStructure`'s own header gives — "structural problems make every
 * later rule report nonsense". Being fatal means this refusal SUPPRESSES every diagnostic below
 * it, including warnings an author would otherwise also see; that is the gate's established
 * semantics and not a side effect of this rule. Two measured consequences of the alternative:
 * `computeFanoutStacks` multiplies the widths, so one `NaN` makes every downstream `parallelWidth`
 * `NaN` and GRAPH010's concurrent-writer refusal silently stops firing; and a `NaN` or `Infinity`
 * in any of the seven fields this checks used to reach `digest(spec)` and throw
 * `CanonicalizationError: non-finite number` OUT of `compile`.
 *
 * IT READS THE EDGE'S KIND, and the two branches are different advice rather than different
 * wording. Nine fields are declared for ONE kind (`EDGE_FIELDS`' `readBy`, which is `EdgeSpec`'s
 * own `<kind> only` comment made readable):
 *
 *     the edge IS that kind      the refusal is the one that rule printed, word for word, and the
 *                                fix says to CORRECT the value — which is right, because removing
 *                                it is a second refusal (`GRAPH007_NO_MAX_WIDTH`,
 *                                `GRAPH007_FANOUT_INCOMPLETE`, `GRAPH012_NO_COMPENSATES`).
 *     the edge is NOT that kind  nothing reads the field, so telling an author to write a valid
 *                                value would be telling them to write one nothing looks at. The
 *                                fix says to REMOVE it, and the message says which kind declares
 *                                it instead of asserting a reader that does not exist.
 *
 * `Object.hasOwn`, not `edge[field]`: the file's rule one screen down, for the reason stated there
 * — `in` and a bare index walk the prototype chain, so `Object.prototype.maxWidth = "24"` made
 * EVERY edge in EVERY graph look as though it had declared one. `unknownKeys` already reads own
 * keys; this now agrees with it.
 *
 * `describeValue` for the value AND for the edge's own id, which is untrusted here too (§A.73).
 * `describeValue("e1")` is `"e1"`, so a well-typed id renders as the surrounding lines' own
 * `edge "${e.id}"` did — and an id carrying a newline is escaped rather than able to forge a line.
 */
/**
 * ONE SPELLING OF "THAT FIELD CANNOT HOLD THAT", and both callers use it.
 *
 * `rule007Fanout` still owns the RANGE half of `maxWidth` (`< 1`, which is a policy question this
 * parse deliberately does not answer), so the same code, the same sentence and the same fix have
 * two producers. They were two COPIES for one round, and they had already drifted in the way two
 * copies always do: each fetched the ceiling its own way, so `Object.prototype.maxFanout = 8`
 * made one say "between 1 and 8" while the other enforced 32. A function rather than a byte-equal
 * test between two strings, because a test tells you they disagree and this makes it impossible.
 *
 * `kind` IS PASSED IN rather than read off the edge, so `rule007Fanout` — which has already
 * narrowed to `e.kind === "fanout"` — gets the reading-kind branch by construction.
 */
function edgeFieldRefusal(
  field: string,
  id: unknown,
  kind: unknown,
  value: unknown,
  maxFanout: number,
): Diagnostic {
  const decl = EDGE_FIELDS[field]!;
  const shape = EDGE_FIELD_SHAPE[decl.type];
  const refusal = Object.hasOwn(EDGE_FIELD_REFUSAL, field)
    ? EDGE_FIELD_REFUSAL[field]!
    : { code: "GRAPH003_MALFORMED", is: shape.is, to: () => shape.to, because: "" };
  // `decl.readBy === undefined` cannot happen for a field `edgeFieldTypes` reaches — the four
  // fields with no `readBy` are exactly `id`, `from`, `to` and `kind`, all in
  // `TYPE_CHECKED_ELSEWHERE` — but a fourteenth field declared for every kind would land here, and
  // "every kind declares it" is the same branch as "this kind declares it".
  const declaresIt = decl.readBy === undefined || kind === decl.readBy;
  const subject = declaresIt && typeof kind === "string" ? `${kind} edge` : "edge";
  const tail = declaresIt
    ? refusal.because === ""
      ? ""
      : ` — ${refusal.because}`
    : ` — and ${field} is declared for ${String(decl.readBy)} edges, not for kind ${describeValue(kind)}`;
  return {
    severity: "error",
    code: refusal.code,
    message: `${subject} ${describeValue(id)} declares ${field} ${describeValue(value)}, which is not ${refusal.is}${tail}`,
    ...(typeof id === "string" ? { at: { edgeId: id as EdgeId } } : {}),
    fix: declaresIt
      ? `set ${field} on edge ${describeValue(id)} to ${refusal.to(maxFanout)}`
      : `remove ${field} from edge ${describeValue(id)}`,
  };
}

/**
 * An edge `kind` in a diagnostic, rendered without trusting it and without changing its bytes.
 *
 * `JSON.stringify` for everything it can render — which is every value a JSON graph file can hold,
 * so the relocated `GRAPH003_UNKNOWN_EDGE_KIND` message is byte-identical to `compile.ts`'s — and
 * `describeValue` for the values it throws on. `?? String(...)` stays for `undefined`, which
 * `JSON.stringify` answers with `undefined` rather than a string: the message would otherwise
 * print the word "kind" followed by nothing and read as a formatting bug rather than as the
 * missing declaration it is.
 */
function renderKind(kind: unknown): string {
  try {
    return JSON.stringify(kind) ?? String(kind);
  } catch {
    return describeValue(kind);
  }
}

function edgeFieldTypes(edge: Readonly<Record<string, unknown>>, maxFanout: number, d: Diagnostic[]): boolean {
  let bad = false;
  const id = edge["id"];
  const kind = edge["kind"];
  for (const [field, decl] of Object.entries(EDGE_FIELDS)) {
    if (TYPE_CHECKED_ELSEWHERE.has(field)) continue;
    if (!Object.hasOwn(edge, field)) continue;
    const value = edge[field];
    if (value === undefined) continue;
    if (EDGE_FIELD_IS[decl.type](value)) continue;
    d.push(edgeFieldRefusal(field, id, kind, value, maxFanout));
    bad = true;
  }
  return bad;
}

/**
 * The tag union, DERIVED from the table rather than imported as a name.
 *
 * `graph/spec.ts` declares it module-private on purpose — `scripts/check-surface.mjs` pins the
 * exported NAME set, and a new name on the public contract arriving under a `fix:` subject is the
 * ledger-watch case `CLAUDE.md` names, not something to answer with `--write`. `EDGE_FIELDS` set
 * the precedent by writing its own tag union inline for the same reason.
 *
 * An indexed access and not a re-declaration: a second spelling of this union in a second file is
 * exactly how two enumerations come to disagree, which is the argument `REQUIRED_FIELDS` and
 * `ALLOWED_FIELDS` both make for living beside the interfaces they describe. `POLICY_FIELDS` is
 * ANNOTATED with the union (it is not `as const`), so this reads the declared type and not the
 * five tags its own rows happen to use — `NESTED_FIELDS` would give the identical answer.
 */
type BlockFieldType = (typeof POLICY_FIELDS)[keyof typeof POLICY_FIELDS][string];

/**
 * One predicate per tag of `POLICY_FIELDS`/`NESTED_FIELDS` — the type half of the block schema.
 *
 * `EDGE_FIELD_IS`' three tags with four more, and `stringArray` INDEX-WALKS for the reason stated
 * there: `Array.prototype.every` SKIPS HOLES, so `new Array(2)` passes it vacuously and then
 * reaches `digest(spec)`, which walks `0..length-1` and does not skip.
 */
const BLOCK_FIELD_IS: Readonly<Record<BlockFieldType, (v: unknown) => boolean>> = {
  string: (v) => typeof v === "string",
  count: (v) => Number.isSafeInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  stringArray: (v) => {
    if (!Array.isArray(v)) return false;
    for (let i = 0; i < v.length; i++) if (typeof v[i] !== "string") return false;
    return true;
  },
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  unknown: () => true,
};

/** What a field of each tag IS, in the words the refusal uses. */
const BLOCK_FIELD_SHAPE: Readonly<Record<BlockFieldType, string>> = {
  string: "a string",
  count: "a whole number",
  number: "a number",
  boolean: "true or false",
  stringArray: "an array of strings",
  array: "an array",
  object: "an object",
  unknown: "anything",
};

/**
 * THE BLOCK FIELDS THIS PASS DOES NOT RE-CHECK, and the rule that already refuses each.
 *
 * `TYPE_CHECKED_ELSEWHERE` one scope in, with the same doctrine and the same failure mode: a
 * second spelling of one refusal is how two diagnostics come to disagree, and the cost of
 * forgetting an entry here is a DUPLICATE diagnostic rather than a hole. Every row was measured
 * against `compile`, one graph per value, over `"banana"`, `42`, `null`, `["x"]`, `{a:1}` and
 * `true` — the six a JSON file can express — and is on this list only because a rule refused
 * every wrong one of them:
 *
 *     graphPolicy.posture, nodePolicy.posture      GRAPH003_UNKNOWN_POSTURE
 *     graphPolicy.budget, nodePolicy.budget,       GRAPH003_MALFORMED, from `objectBlock`
 *       graphPolicy.expansion, channel.contextProjection
 *     graphPolicy.onBudgetExhausted                GRAPH003_BUDGET_ACTION_UNSUPPORTED
 *     expansion.*  (all four)                      GRAPH003_MALFORMED, from `expansionOf` — which
 *                                                  also owns the `>= 1` half and the fallback, so
 *                                                  a `count` tag here would refuse LESS and say
 *                                                  it differently
 *     retry.maxAttempts                            GRAPH020_MISSING_FIELD
 *     channel.reduce                               GRAPH003_UNKNOWN_REDUCER
 *     channel.classification                       GRAPH003_UNKNOWN_CLASSIFICATION
 *     metadata.name                                GRAPH003_MALFORMED, in `checkStructure`
 *     approval.*                                   GRAPH014_APPROVER_INVALID / _APPROVAL_INVALID
 *     sla.*, slaReminder.afterMs                   GRAPH014_SLA_INVALID
 *     delivery.channels/redact/redactAs/escalation GRAPH014_DELIVERY_INVALID
 *     deliveryEscalation.afterMs/channels          GRAPH014_DELIVERY_INVALID
 *     batching.*, dedupe.*                         GRAPH014_BATCHING_INVALID / _DEDUPE_INVALID,
 *                                                  and the whole block is inert while `enabled`
 *                                                  is false, which is why the fields measure OK
 *                                                  in that state and are still not this pass's
 *
 * THE DEFAULT IS TO CHECK. A field added to either table is type-checked unless somebody opts it
 * out here, which is the fail-closed direction.
 */
const CHECKED_BY_A_RULE: ReadonlySet<string> = new Set([
  "graphPolicy.posture",
  "graphPolicy.budget",
  "graphPolicy.expansion",
  "graphPolicy.onBudgetExhausted",
  "nodePolicy.posture",
  "nodePolicy.budget",
  "expansion.maxNodes",
  "expansion.maxDepth",
  "expansion.maxFanout",
  "expansion.maxLoopIterations",
  "retry.maxAttempts",
  "channel.reduce",
  "channel.classification",
  "channel.contextProjection",
  "contextProjection.take",
  "contextProjection.maxTokens",
  "contextProjection.overflow",
  "metadata.name",
  "approval.approvers",
  "approval.separationOfDuties",
  "sla.respondWithinMs",
  "sla.onTimeout",
  "sla.reminders",
  "slaReminder.afterMs",
  "delivery.channels",
  "delivery.redact",
  "delivery.redactAs",
  "delivery.escalation",
  "deliveryEscalation.afterMs",
  "deliveryEscalation.channels",
  "batching.enabled",
  "batching.key",
  "batching.windowMs",
  "batching.maxBatch",
  "dedupe.enabled",
  "dedupe.windowMs",
]);

/**
 * Every declared field of one block, against the type its table gives it.
 *
 * NOT FATAL, and the difference from `edgeFieldTypes` is the difference between the two scopes.
 * A wrong-typed edge field reaches `computeFanoutStacks`' arithmetic and makes every downstream
 * `parallelWidth` a `NaN`, so it has to gate. These are leaves: a bad `budget.tokens` costs a
 * budget and a bad `retry.jitter` costs a jitter, and none of them makes a later rule reason
 * wrongly. That is the same distinction `checkPolicyBlocks` already draws in its own header —
 * "a bad POSTURE value is fatal … neither is a malformed `budget` or `expansion`".
 *
 * `Object.hasOwn` and not `block[field]`, for this file's rule: `in` and a bare index walk the
 * prototype chain, so `Object.prototype.jitter = "yes"` would make every `retry` block in every
 * graph look as though it had declared one. `unknownKeys` reads own keys and this agrees with it.
 */
function blockFieldTypes(
  block: Readonly<Record<string, unknown>>,
  scope: string,
  fields: Readonly<Record<string, BlockFieldType>>,
  what: string,
  at: Diagnostic["at"],
  d: Diagnostic[],
): boolean {
  let found = false;
  for (const [field, tag] of Object.entries(fields)) {
    if (CHECKED_BY_A_RULE.has(`${scope}.${field}`)) continue;
    if (!Object.hasOwn(block, field)) continue;
    const value = block[field];
    if (value === undefined) continue;
    if (BLOCK_FIELD_IS[tag]!(value)) continue;
    found = true;
    d.push({
      severity: "error",
      code: "GRAPH003_MALFORMED",
      message: `${what} declares \`${field}\` as ${describeValue(value)}, which is not ${BLOCK_FIELD_SHAPE[tag]}`,
      ...(at === undefined ? {} : { at }),
      fix: `set \`${field}\` to ${BLOCK_FIELD_SHAPE[tag]}, or remove it`,
    });
  }
  return found;
}

/**
 * A block that must be an object, reported when it is anything else.
 *
 * ABSENT IS FINE; MALFORMED IS NOT, and the two used to answer the same. The helper this
 * replaces mapped every non-object to `undefined` and every caller then skipped, on a comment
 * saying the shape was "left to the type layer". THERE IS NO TYPE LAYER: `compile`'s input is
 * `JSON.parse` output — `readSpec` in `cli.ts` parses a file and casts it — so `undefined` was
 * the entire treatment. Measured against `compile` on a graph whose control plans its `write`
 * node at `on`:
 *
 *     policy: "in"                →  ok, and the node planned at `out`
 *     policy: null                →  ok, node at `out`
 *     policy: ["posture"]         →  ok, node at `out`
 *     policy: {budget: [1, 2]}    →  ok, and no budget enforced
 *     nodes[1].policy: null       →  ok, the node's own declaration dropped
 *
 * The first row is the failure in one line: an author asking for the STRONGEST oversight got the
 * WEAKEST, silently, because `("in").posture` is `undefined` and the `?? "out"` below it applies.
 * That is the same silent-loosening shape `GRAPH003_UNKNOWN_POSTURE` closes one level in, and it
 * sits one level OUT — where the value is not a wrong word but a wrong kind of thing.
 *
 * `GRAPH003_MALFORMED` rather than a new code: it is already this file's answer to "a block is
 * not the shape it must be" at seven sites (`inputs`, `outputs`, `nodes`, `edges`,
 * `metadata.name`, a node/edge element, `hooks.<when>`), and an eighth spelling of one idea is
 * how diagnostics come to disagree about what they mean.
 */
function objectBlock(
  v: unknown,
  what: string,
  at: Diagnostic["at"],
  fix: string,
  d: Diagnostic[],
): Record<string, unknown> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    d.push({
      severity: "error",
      code: "GRAPH003_MALFORMED",
      message: `${what} must be an object, not ${v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`}`,
      ...(at === undefined ? {} : { at }),
      fix,
    });
    return undefined;
  }
  return v as Record<string, unknown>;
}

/**
 * The `policy` block's CONTENTS, at both scopes — its keys, its nested blocks' keys, and the
 * one field whose value is a vocabulary.
 *
 * `unknownKeys` above closed four scopes and `policy` was the floor of all of them: the node's
 * own keys catch `policyy: {posture: "in"}`, and one level in nothing was checked at all.
 * Measured against `compile` before this existed, on a graph that is otherwise byte-identical
 * to one that compiles clean:
 *
 *     policy: { posture:  "strict" }    →  ok, and every node planned at `out`
 *     policy: { posturr:  "out"    }    →  ok, zero diagnostics
 *     policy: { budget: {nonsense:5} }  →  ok, zero diagnostics
 *
 * The first row is the reason this is an error and not a warning, and it is worse than a lost
 * declaration: an author asking for the strongest oversight the system has was given the
 * weakest one, silently, because `POSTURE_RANK["strict"]` is `undefined` and a miss loses every
 * comparison it enters. `vocab.ts` now ranks an unreadable posture at `in` so that graph would
 * fail SAFE rather than open — but failing safe on a typo is still not what the author wrote,
 * and only the compiler is positioned to say which word was wrong and what the real ones are.
 *
 * A BAD POSTURE VALUE IS FATAL, AND SO IS A `policy` THAT IS NOT A BLOCK; a bad KEY is not, and
 * neither is a malformed `budget` or `expansion` — those cost a limit, not a posture, so no later
 * rule reasons wrongly from them. `rule014And019Oversight` computes postures
 * from this field, so leaving it in play makes the next diagnostic `GRAPH014_OVERSIGHT_LOOSENED`
 * — "this graph would weaken oversight", classified `E_OVERSIGHT_LOOSENED`, a policy refusal —
 * for what is a spelling mistake, pointing the author at the wrong line and the operator at the
 * wrong class of fault. That is the same reason `GRAPH003_UNKNOWN_REDUCER` is fatal one check
 * over. An unknown KEY stops no later rule from reasoning correctly, so it reports alongside
 * everything else, exactly as the graph-scope check above decided.
 */
function checkPolicyBlocks(spec: GraphSpec, d: Diagnostic[]): boolean {
  let fatal = false;
  const list = (fields: readonly string[]): string => fields.map((a) => `\`${a}\``).join(", ");

  const check = (
    policy: unknown,
    whose: string,
    at: Diagnostic["at"],
    scope: "graphPolicy" | "nodePolicy",
    table: Readonly<Record<string, BlockFieldType>>,
  ): void => {
    // `Object.keys` AND NOT A SECOND ARRAY. `POLICY_FIELDS` carries a type per field now, and
    // `Object.keys` preserves insertion order — so every `declares \`a\`, \`b\`, …` line these
    // messages print is byte-for-byte what the name-only table printed.
    const allowed = Object.keys(table);
    // A BARE POSTURE IS THE MISTAKE WORTH NAMING. `policy: "in"` is the reproduced case, and an
    // author who wrote it was reaching for the strongest oversight there is.
    const p = objectBlock(
      policy,
      `${whose}\`policy\``,
      at,
      isPosture(policy)
        ? `that is a posture, not a policy block — write \`policy: { posture: ${JSON.stringify(policy)} }\``
        : `${whose}\`policy\` block declares ${list(allowed)}, all optional — or drop the block`,
      d,
    );
    if (p === undefined) {
      // Absent is fine; MALFORMED is fatal, for the reason stated below the posture check.
      if (policy !== undefined) fatal = true;
      return;
    }
    unknownKeys(p, allowed, `${whose}\`policy\` block`, at, d);
    // AND WHAT THE KEYS HOLD (§A.81(a)). `capabilities` is the row that makes this load-bearing:
    // `rule017Capabilities` reads it to decide whether the tenant holds what the graph asks for,
    // and `policy: {capabilities: "k8s:write"}` — the singular an author writes by hand — threw
    // `TypeError: allow.some is not a function` out of `compile` rather than refusing.
    //
    // ON A GRAPH THAT REACHES THE CAPABILITY CHECK, and the qualifier is measured rather than
    // hedging: the crash needs a node whose capabilities are actually compared (a `tool` node,
    // against a tenant list). A function-only graph with the same malformed value produced nine
    // `GRAPH017_CAPABILITY_NOT_DECLARED` diagnostics and `ok: true` — the string iterated as its
    // own characters — so the fault is "unreadable and believed" there and "a crash" here.
    //
    // THE FATAL COSTS THE REST OF THE PASS, which is the honest price. On a `k8s.apply` node with
    // `capabilities: "k8s:write"`, `GRAPH011_UNHANDLED_IRREVERSIBLE` is suppressed along with
    // everything else below the gate — the author fixes the quoting and compiles again to see it.
    // That is the gate's established semantics, and the alternative is the crash above.
    //
    // FATAL, on the criterion this function's own header already states for `posture`: a later
    // rule REASONS from this field, so leaving it in play makes the next diagnostic wrong — and
    // here it is worse than wrong, it is the crash above. `capabilities` is also the ONLY field of
    // either policy scope this call can fire on: `posture`, `budget`, `expansion` and
    // `onBudgetExhausted` are all on `CHECKED_BY_A_RULE`, so no per-field list is needed to say
    // which failure gates. A fifth policy field added tomorrow gates too, which is the fail-closed
    // direction and is why that is stated rather than left to be noticed.
    if (blockFieldTypes(p, scope, table, `${whose}\`policy\` block`, at, d)) fatal = true;
    const budget = objectBlock(
      p["budget"],
      `${whose}\`policy.budget\``,
      at,
      `a budget declares ${list(Object.keys(POLICY_FIELDS.budget))}, all optional`,
      d,
    );
    if (budget !== undefined) {
      unknownKeys(budget, Object.keys(POLICY_FIELDS.budget), `${whose}\`policy.budget\` block`, at, d);
      // All three of `costUsd`, `tokens` and `wallMs` compiled with ZERO diagnostics holding any
      // of the six wrong types a JSON file can express — a budget nobody can enforce, silently.
      blockFieldTypes(budget, "budget", POLICY_FIELDS.budget, `${whose}\`policy.budget\` block`, at, d);
    }
    // `expansion` is graph-scope only, so a node declaring one is already an unknown key above
    // and must not also be walked as though it meant something.
    const expansion = allowed.includes("expansion")
      ? objectBlock(
          p["expansion"],
          `${whose}\`policy.expansion\``,
          at,
          `an expansion budget declares ${list(Object.keys(POLICY_FIELDS.expansion))}, all optional`,
          d,
        )
      : undefined;
    if (expansion !== undefined) {
      // A misspelled limit does not fail — it falls back to `DEFAULT_EXPANSION`. An author who
      // wrote `maxNodes: 8` and gets 256 has had a bound raised on them by a typo.
      unknownKeys(expansion, Object.keys(POLICY_FIELDS.expansion), `${whose}\`policy.expansion\` block`, at, d);
      // ALL FOUR OF ITS FIELDS ARE ON `CHECKED_BY_A_RULE`, so this call refuses nothing today —
      // and it is here rather than absent because the default in that set is to CHECK. `expansionOf`
      // owns these: it refuses a non-positive-integer AND substitutes the default, and a `count`
      // tag would refuse LESS (`0` and `-1` are well-typed counts) while saying it differently.
      // A fifth expansion field added tomorrow is type-checked by this line without a decision.
      blockFieldTypes(expansion, "expansion", POLICY_FIELDS.expansion, `${whose}\`policy.expansion\` block`, at, d);
    }
    const posture = p["posture"];
    if (posture !== undefined && !isPosture(posture)) {
      d.push({
        severity: "error",
        code: "GRAPH003_UNKNOWN_POSTURE",
        message: `${whose}\`policy.posture\` is ${JSON.stringify(posture)}, which is not an oversight posture`,
        ...(at === undefined ? {} : { at }),
        fix: `use one of ${POSTURES.join(", ")} — \`in\` gates every action for a human, \`on\` runs with a human watching and able to interrupt, \`out\` runs unsupervised`,
      });
      fatal = true;
    }
  };

  check(spec.policy, "the graph's ", undefined, "graphPolicy", POLICY_FIELDS.graphPolicy);
  for (const n of spec.nodes) check(n.policy, `node "${n.id}"'s `, { nodeId: n.id }, "nodePolicy", POLICY_FIELDS.nodePolicy);
  return fatal;
}

/**
 * The characters an id may be built from.
 *
 * Not a style rule. Every durable id in the system is a STRING JOIN with no escaping:
 * `taskId` is `nodeId@branchPath#iteration`, `encodeBranch` writes each segment as
 * `edgeId[index]` and joins them with `/`, and `effectKey` appends `:kind:ordinal`. So an
 * id carrying one of those characters is not a name, it is a second parse of somebody
 * else's id — and two consequences follow immediately. `encodeBranch` stops being
 * INJECTIVE (segments `a[0]` then `b[3]` and the single segment `a[0]/b[3]` encode to one
 * string, so two branches share one TaskId — invariant 3 — while `compareBranch` still
 * orders them strictly, which invariant 7's fold relies on being an order over distinct
 * things). And `decodeBranch` throws on a `branchPath` that is ALREADY JOURNALED, which
 * an append-only log cannot take back: every later fold of that run throws too.
 *
 * The first character must be alphanumeric, which additionally keeps `__proto__` out of
 * every object these names end up keying: the channel-state record, and the projection's
 * per-id maps.
 *
 * Widening this is safe; narrowing it is not, because ids already journaled must stay
 * decodable.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `unknown` rather than `string`: a model-proposed spec is cast, never checked. */
function isSafeId(id: unknown): boolean {
  return typeof id === "string" && SAFE_ID.test(id);
}

/**
 * The names a CHANNEL may not take, because `Object.prototype` already carries them.
 *
 * `SAFE_ID` keeps `__proto__` out and stops there, so `toString`, `constructor`,
 * `hasOwnProperty`, `valueOf`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString` and
 * the four `__define`/`__lookup` accessors all compiled clean — and then the RUN died on
 * `E_INTERNAL channel "toString": expected array, got function`, because a channel name keys
 * `ChannelState`, the reducer table and the projection, and a raw read off any of them answers
 * with the prototype's member for a channel nobody declared. `state/channels.ts` closed the
 * runtime half by asking `hasOwnProperty` at every such site; this is the other half, which is
 * that the compiler should have refused the graph before a run existed.
 *
 * READ OFF `Object.prototype`, NOT WRITTEN DOWN. The hazard is exactly "this name is on
 * `Object.prototype`", so a hand-kept list would be a second definition of that set, free to
 * drift from the one the engine actually collides with. Twelve names on Node 24; `__proto__`
 * is among them and is already unreachable through `SAFE_ID`, which costs nothing and leaves
 * the set complete on its face if `SAFE_ID` ever widens.
 *
 * CHANNELS AND NODE IDS, THOUGH FOR NODE IDS THE REACHABLE HAZARD ISN'T `plans`. TODO.md §A0.19
 * names `plans["toString"]`, which has the same plain-object shape as `channels["toString"]` —
 * but every site that reads `ctx.graph.plans[nodeId]` (`run/engine.ts`, `run/scheduler.ts`,
 * `cli.ts`, `server/layout.ts`) does it as `?.field ?? default`, and that degrades a prototype
 * FUNCTION to the same default an absent plan gives, so `plans` alone is not exploitable today.
 * The hazard that IS reachable is one own object over: `ctx.baselinePostures?.[n.id]`, read
 * below in this file's `rule014And019Oversight` and fed to `isLoosening`, which fails closed —
 * by design — on a baseline it cannot read as a `Posture`. A node named `toString` makes that
 * baseline `Object.prototype.toString`, not a `Posture`, and fabricates
 * `GRAPH014_OVERSIGHT_LOOSENED` — which `compile` turns into a POLICY refusal
 * (`err.policy`/`E_OVERSIGHT_LOOSENED`) rather than a validation one, for a spec that never
 * reached policy. The node-id check (`checkStructure`, the loop above the channel loop) refuses
 * fatally, which is what stops `validateGraph` from ever reaching that later rule for this node
 * — see the comment there and `graph-lane-reserved-node-id.test.ts`. EDGE IDS ARE NOT a hazard
 * at all: `edgeById`/`inbound`/`outbound` are all `Map`, and a `Map` does not consult
 * `Object.prototype` on `get`/`set`, so an edge named `toString` is an ordinary key with no
 * collision. SUBGRAPH REFS ARE NOT EITHER against this file's own gate, though the bound is
 * conditional rather than absolute: `subgraphs` (`compile.ts`'s `resolveSubgraphs`,
 * `out[ref] = child`) is a plain object too, but `rule015Resources` raises
 * `GRAPH015_RESOURCE_NOT_FOUND` for any `subgraph.ref` the injected `ResourceResolver` won't
 * resolve, and `compile` returns on errors before `resolveSubgraphs` ever runs — so with THIS
 * TREE'S built-in `ResourceStore`, whose `parseRef` requires a `kind/name@selector` shape
 * (`resources/store.ts`), no resolvable ref can equal a bare reserved name, `/` and `@` both
 * being outside `Object.getOwnPropertyNames(Object.prototype)`. That bound is the store's, not
 * the interface's: `ResourceResolver` is one of the members `--extension-module` can now supply
 * (CLAUDE.md §2), and a THIRD-PARTY resolver that answers `.subgraph("__proto__")` with a real
 * child spec would still reach `out["__proto__"] = child`, which sets `subgraphs`'s prototype
 * rather than declaring an entry. RUN/PROJECTION.TS'S PER-NODE-ID MAPS ARE NOT A HAZARD EITHER,
 * verified rather than assumed: `escalations`/`ceilings` are keyed by scope strings built as
 * `` `node:${nodeId}` `` or `` `run:${runId}` `` (several `engine.ts` sites) and validated on
 * every operator-facing door to match that shape (`cli.ts`, `server/http.ts`) — every key
 * contains `:`, outside the reserved set; `steers` is read at its one call site
 * (`engine.ts`) through `Object.prototype.hasOwnProperty.call`, unconditionally; and `p.tasks[id]`
 * is keyed by TaskId, `` `${nodeId}@${branch}#${iteration}` `` (`ids.ts`), which always contains
 * `@` and `#`. This is the "recorded argument that a compiler-built map is safe" TODO.md §A0.19
 * asks for, for the one runtime structure that looked like it might need the same rule.
 *
 * THE SET IS READ OFF THE RUNNING V8, AND THAT HAS A PRICE worth naming: the compiler's answer
 * stops being a pure function of its input. A future Node that adds an `Object.prototype` member
 * widens this refusal with no commit here, so the same spec could compile on one runtime and not
 * another. The trade is deliberate — the hazard IS "the name is on `Object.prototype`", and a
 * hand-kept list is a second definition of that free to drift — and it is bounded two ways: the
 * runtime hazard widens with the same member, so the refusal tracks the thing it exists for, and
 * `test/graph/graph-lane-reserved-channel-names.test.ts` pins the twelve names of Node 24, so a
 * runtime that changes the set turns that test red before it surprises anyone.
 *
 * AND IT IS REPLAY-VISIBLE. `#rehydrateGraph` calls `compile`, and a non-`ok` result there
 * raises `E_REPLAY_DIVERGENCE`, so a journal whose graph declares a `toString` channel — or,
 * since this file's node-id rule, a `toString` NODE — can no longer be attached or replayed. No
 * graph in this tree does either (checked directly: no tracked graph's `channels` or node `id`
 * is on this set); the runtime half (lane T's `state/channels.ts` fix) means such a run was
 * already broken where it mattered for channels; and refusing is the direction a guard may move.
 * Said out loud because "the graph stopped compiling" and "the run stopped folding" are
 * different costs and only the first is obvious.
 */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

const RESERVED_LIST = [...PROTOTYPE_NAMES]
  .sort()
  .map((r) => `\`${r}\``)
  .join(", ");

/**
 * The largest delay a Node timer holds. A FOURTH local copy, matching `cli.ts`, `providers/http.ts`
 * and `server/http.ts` — the tree copies a bare constant rather than exporting it, because an
 * export from a barrelled module lands on the pinned public surface (`store.ts`'s `storeDenyLists`
 * records the ruling). If one changes, change all four.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * THE CLASSES EACH ERROR CODE IS ACTUALLY RAISED WITH — a set, because it is not one.
 *
 * `retry.onlyIf` is filtered by `#retryDecision` AFTER `if (!error.retryable) return undefined;`,
 * and `retryable` is `RETRYABLE.has(error.class)` over `{exhausted, unavailable, timeout}`. So an
 * `onlyIf` naming a code that is never raised with one of those three is a filter that can never
 * match: it compiles, the compiler ECHOES it back in the retry summary, and the runtime ignores
 * it. `retry.onlyIf: ["E_FUNCTION_REFUSED"]` is the case that named the row (TODO §A.49) — that
 * code is `validation` by design, which is the entire distinction between it and
 * `E_FUNCTION_UNAVAILABLE`.
 *
 * WHY A SET AND NOT A CLASS. `class` is chosen at the RAISE SITE, not by the code, and this tree
 * proves it: ten codes are raised under more than one class, and five sit under a section heading
 * in `errors.ts` that disagrees with their raise sites about retryability itself —
 * `E_GATE_DELIVERY_FAILED` is under `// policy` and raised `unavailable` twice in
 * `run/delivery.ts`; `E_SUBGRAPH_FAILED` is under `// internal` and raised `unavailable` twice in
 * `run/engine.ts`; `E_EXPANSION_EXHAUSTED`, `E_QUORUM_UNREACHABLE` and `E_GRAPH_MISMATCH` sit
 * under retryable headings and are never raised retryably. A table read off the headings would
 * refuse the first two, which WORK. This one is read off `err.<class>(CODES.X)` and
 * `new LoomError("<class>", CODES.X)` across `packages/core/src`.
 *
 * WHAT COUNTS AS A SITE: `err.<class>(CODE)`, `new LoomError("<class>", CODE)`, and a
 * `{class, code}` RECORD LITERAL — `run.failed` and `#failRun` build errors that way rather
 * than through `LoomError`, and a class written by hand is still a class this code is paired
 * with. A first cut of this table read only the first two forms and got three entries wrong:
 * `E_OVERSIGHT_LOOSENED` is `policy` through `compile.ts`'s
 * `(loosened ? err.policy : err.validation)(…)`, which a scan for `err.policy(CODES.` cannot
 * see, and `E_GATE_EXPIRED` / `E_OUTPUT_MISSING` carry a class on a record literal.
 *
 * AN EMPTY ARRAY IS THE UNDECIDABLE ANSWER AND IT ACCEPTS, and it now covers exactly three
 * codes: `E_ROUTE_NOT_FOUND` and `E_REQUEST_TIMEOUT` are sent as a bare `{code, message}` HTTP
 * body, and `E_EFFECT_UNAVAILABLE` exists only as text inside a message a sandboxed body
 * throws. Nothing pins a class to any of them, and refusing a graph on a class nothing pins
 * would be the false refusal this table exists to avoid — the cost of accepting is at worst
 * the dead filter the rule is about, never a broken run.
 *
 * THE DRIFT GUARD IS `tsc`, NOT A SOURCE SCAN. `Record<Code, ...>` makes a code added to
 * `errors.ts` a type error here until somebody classifies it, so the set this table covers is
 * exactly `CODES` and cannot quietly stop being. Not exported, and the table lives here rather
 * than in `errors.ts`, for the reason `MAX_TIMER_MS` above states: `src/index.ts` is
 * `export * from "./errors.ts"`, so any new export there lands on the pinned public surface.
 *
 * `EdgeSpec.codes` is deliberately NOT filtered by this — a non-retryable code is exactly what
 * an `error` edge is for.
 */
const RAISED_CLASS: Record<Code, readonly ErrorClass[]> = {
  // validation
  E_GRAPH_INVALID: ["validation"],
  E_CHANNEL_UNDECLARED: ["validation"],
  E_CONTEXT_OVERFLOW: ["validation"],
  E_TOOL_SCHEMA_INVALID: ["validation"],
  E_PROVIDER_BAD_REQUEST: ["validation"],
  E_ROUTE_INVALID: ["policy"],   // raised policy, not the validation its heading claims
  E_EXPR_INVALID: ["validation"],
  E_RESOURCE_INVALID: ["validation"],
  E_FUNCTION_REFUSED: ["validation"],
  E_CONFIG_INVALID: ["internal", "validation"],   // two classes, neither retryable
  E_COHORT_INVALIDATED: ["validation"],
  E_PAYLOAD_TOO_DEEP: ["validation"],
  E_PAYLOAD_TOO_LARGE: ["validation"],
  // policy
  E_OVERSIGHT_LOOSENED: ["policy"],   // compile.ts: `(loosened ? err.policy : err.validation)(…)`
  E_OVERSIGHT_LOOSEN_FORBIDDEN: ["policy"],
  E_CAP_DENIED: ["policy"],
  E_GATE_REQUIRED: ["policy"],
  E_GATE_NOT_AUTHORIZED: ["policy"],
  E_CONTENT_FILTERED: ["policy"],
  E_PROVIDER_AUTH: ["policy"],
  E_NOT_AUTHORIZED: ["policy"],
  E_HUMAN_APPROVAL_REQUIRED: ["policy", "validation"],   // two classes, neither retryable
  E_EVAL_REGRESSION: ["policy"],
  E_GATE_DELIVERY_FAILED: ["not_found", "unavailable"],   // two classes, one retryable -> CAN fire
  E_FS_UNREADABLE: ["policy"],
  // not_found
  E_FS_NOT_FOUND: ["not_found"],
  E_RESOURCE_NOT_FOUND: ["not_found", "validation"],   // two classes, neither retryable
  E_RESOURCE_YANKED: ["policy"],   // raised policy, not the not_found its heading claims
  E_TOOL_NOT_FOUND: ["not_found", "validation"],   // two classes, neither retryable
  E_GATE_NOT_FOUND: ["not_found"],
  E_RUN_NOT_FOUND: ["not_found"],
  E_ROUTE_NOT_FOUND: [],   // no LoomError raise site: emitted as a bare {code, message}
  // conflict
  E_SEQ_CONFLICT: ["conflict"],
  E_FENCING_STALE: ["conflict"],
  E_IDEMPOTENCY_MISMATCH: ["conflict"],
  E_GATE_ALREADY_RESOLVED: ["conflict"],
  E_ILLEGAL_TRANSITION: ["conflict"],
  E_RESTORE_ILLEGAL: ["conflict", "validation"],   // two classes, neither retryable
  E_EFFECT_UNRECORDED: ["validation"],   // raised validation, not the conflict its heading claims
  E_EFFECT_UNAVAILABLE: [],   // no LoomError raise site: emitted as a bare {code, message}
  // exhausted
  E_BUDGET_EXHAUSTED: ["exhausted"],
  E_PROVIDER_RATE_LIMIT: ["exhausted"],
  E_EXPANSION_EXHAUSTED: ["policy"],   // raised policy, not the exhausted its heading claims
  E_QUORUM_UNREACHABLE: ["validation"],   // raised validation, not the exhausted its heading claims
  // unavailable
  E_FUNCTION_UNAVAILABLE: ["unavailable"],
  E_PROVIDER_OVERLOADED: ["unavailable"],
  E_PROVIDER_TRANSPORT: ["unavailable"],
  E_TOOL_SOURCE_UNAVAILABLE: ["unavailable"],
  E_CHILD_UNREACHABLE: ["unavailable"],
  // timeout
  E_TOOL_TIMEOUT: ["timeout"],
  E_GATE_EXPIRED: ["timeout"],   // a `run.failed` record literal, not a LoomError
  E_GRAPH_MISMATCH: ["conflict", "policy", "validation"],   // three classes, none retryable
  E_TASK_TIMEOUT: ["timeout"],
  E_REQUEST_TIMEOUT: [],   // no LoomError raise site: emitted as a bare {code, message}
  // cancelled
  E_CANCELLED: ["cancelled"],
  // internal
  E_INTERNAL: ["internal", "validation"],   // two classes, neither retryable
  E_REPLAY_DIVERGENCE: ["internal"],
  E_SUBGRAPH_FAILED: ["internal", "unavailable"],   // two classes, one retryable -> CAN fire
  E_FLOATING_REF_AT_RUNTIME: ["internal"],
  E_TRACE_INCONSISTENT: ["internal"],
  E_OUTPUT_MISSING: ["internal"],   // a `#failRun` record literal, not a LoomError
  E_PAYLOAD_UNRESOLVED: ["internal"],
};

/** The three classes `LoomError` marks retryable. A copy, for the reason `RAISED_CLASS` states. */
const RETRYABLE_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>(["exhausted", "unavailable", "timeout"]);

/**
 * Can an `onlyIf` naming this code ever fire? Unknown to the table — an extension's own code,
 * or one with no raise site — answers YES, because refusing is only correct where the answer
 * is provably no.
 */
function neverRetryable(code: string): readonly ErrorClass[] | undefined {
  const classes = Object.hasOwn(RAISED_CLASS, code) ? RAISED_CLASS[code as Code] : undefined;
  if (classes === undefined || classes.length === 0) return undefined;
  return classes.some((c) => RETRYABLE_CLASSES.has(c)) ? undefined : classes;
}

function checkStructure(spec: GraphSpec, d: Diagnostic[]): boolean {
  let fatal = false;
  // THE SPEC IS A SPEC, before the loop below reads a field off it. `compile`'s input is a cast
  // `JSON.parse`, and a file holding `null` is valid JSON: `spec.inputs` on it threw
  // `TypeError: Cannot read properties of null (reading 'inputs')` out of `compile`.
  //
  // IT CATCHES EVERY NON-OBJECT AND NOT ONLY THE TWO THAT CRASHED, which is a change of MESSAGE
  // for the others and is the better one. `42`, `"x"` and `true` used to reach the `inputs` row
  // below and be told "`inputs` must be an array, not absent" — true of a number in the sense
  // that a number has no `inputs`, and useless to an author who wrote a graph file that is not a
  // graph. They now read "the graph must be an object, not number". `[]` still lands here too.
  // It reaches a CHILD spec as well, through `rule016Subgraphs`' recursion.
  if (typeof spec !== "object" || spec === null) {
    d.push({
      severity: "error",
      code: "GRAPH003_MALFORMED",
      message: `the graph must be an object, not ${spec === null ? "null" : typeof spec}`,
      fix: "a graph is `{apiVersion, kind, metadata, channels, inputs, outputs, nodes, edges}`",
    });
    return true;
  }
  // TOP-LEVEL SHAPE, BEFORE ANYTHING ITERATES IT. `spec.inputs` missing produced
  // `E_INTERNAL: TypeError: spec.inputs is not iterable`, and a missing `metadata` compiled
  // CLEAN and then failed the run on `Cannot read properties of undefined (reading 'name')` —
  // a graph the compiler passed and the engine could not start.
  for (const [field, value] of [
    ["inputs", spec.inputs],
    ["outputs", spec.outputs],
    ["nodes", spec.nodes],
    ["edges", spec.edges],
  ] as const) {
    if (!Array.isArray(value)) {
      d.push({
        severity: "error",
        code: "GRAPH003_MALFORMED",
        message: `\`${field}\` must be an array, not ${value === undefined ? "absent" : typeof value}`,
        fix: `add \`${field}: []\` at the top level`,
      });
      return true;
    }
  }
  // The graph's own keys, once its arrays are known to be arrays. Deliberately NOT fatal on its
  // own: a stray top-level key does not stop any later rule from reasoning correctly, and
  // reporting it alongside the real diagnostics is more useful than replacing them.
  unknownKeys(spec as unknown as Record<string, unknown>, SPEC_FIELDS, "the graph", undefined, d);

  if (typeof spec.metadata?.name !== "string") {
    d.push({
      severity: "error",
      code: "GRAPH003_MALFORMED",
      message: "`metadata.name` is required and must be a string",
      fix: "add `metadata: { name, project, version }` at the top level",
    });
    return true;
  }
  // AND ITS CONTENTS. `SPEC_FIELDS` proves the graph has a `metadata:`; nothing looked inside it,
  // so `nmae` compiled clean. This one is TIDY rather than load-bearing — no rule reasons from
  // `metadata` beyond `name` — and it is here because the two below it are not, and a family with
  // a member left out is a family nobody can check by naming it.
  unknownKeys(spec.metadata as unknown as Record<string, unknown>, Object.keys(NESTED_FIELDS.metadata), "`metadata`", undefined, d);
  blockFieldTypes(spec.metadata as unknown as Record<string, unknown>, "metadata", NESTED_FIELDS.metadata, "`metadata`", undefined, d);
  // AND THE ELEMENTS, not just the arrays. `edges: [null]` reached `e.id` and crashed; a node
  // that is not an object does the same one loop over.
  for (const [field, list] of [
    ["nodes", spec.nodes],
    ["edges", spec.edges],
  ] as const) {
    const bad = list.findIndex((x) => typeof x !== "object" || x === null);
    if (bad !== -1) {
      d.push({
        severity: "error",
        code: "GRAPH003_MALFORMED",
        message: `\`${field}[${bad}]\` is ${list[bad] === null ? "null" : typeof list[bad]}, not an object`,
        fix: `remove it, or give it the shape the other ${field} have`,
      });
      return true;
    }
  }
  for (const [field, list] of [
    ["inputs", spec.inputs],
    ["outputs", spec.outputs],
  ] as const) {
    const bad = list.findIndex((x) => typeof x !== "string");
    if (bad !== -1) {
      d.push({
        severity: "error",
        code: "GRAPH003_MALFORMED",
        message: `\`${field}[${bad}]\` is ${typeof list[bad]}, not a channel name`,
        fix: `${field} is a list of channel names`,
      });
      return true;
    }
  }
  // `hooks` is a map of ref LISTS. `{beforeNode: 42}` crashed both the validator and the
  // compiler's manifest walk.
  for (const [when, refs] of Object.entries(spec.hooks ?? {})) {
    if (!Array.isArray(refs)) {
      d.push({
        severity: "error",
        code: "GRAPH003_MALFORMED",
        message: `\`hooks.${when}\` must be a list of resource refs, not ${refs === null ? "null" : typeof refs}`,
        fix: `hooks.${when}: ["hook/name@stable"]`,
      });
      return true;
    }
    // AN UNKNOWN POINT IS AN ERROR, not a silently dead entry. `hooks` is a `Record<string, …>`,
    // so before this check `hooks: {preTolo: [...]}` compiled clean, resolved its refs, pinned
    // them into the manifest — and never fired. Declared, pinned and silent is the shape this
    // compiler refuses everywhere else.
    if (!isHookPoint(when)) {
      d.push({
        severity: "error",
        code: "GRAPH003_UNKNOWN_HOOK_POINT",
        message: `\`hooks.${when}\` names no hook point, so nothing would ever invoke it`,
        fix: `one of: ${HOOK_POINTS.join(", ")}`,
      });
    }
  }
  // AN ERROR CODE THAT DOES NOT EXIST IS REFUSED, for the reason next door and one field over.
  //
  // `EdgeSpec.codes` and `RetryPolicy.onlyIf` are both lists of error codes read at run time and
  // validated by nothing, so a typo is not an error — it is a SILENCE. Measured, on a graph with
  // an irreversible tool whose body throws:
  //
  //     error edge, no codes        the edge fires, the handler runs
  //     codes: ["E_TYPOO"]          compiles clean, the edge NEVER fires
  //
  // And the second row still satisfies `GRAPH011_UNHANDLED_IRREVERSIBLE`, which asks only
  // whether an `error` edge exists — so the warning that exists to catch an unhandled
  // irreversible node is suppressed by an edge that cannot handle anything. On `onlyIf` the same
  // typo means "retry nothing", which reads as a retry policy and disables retry.
  //
  // The codes are a CLOSED SET (`CODES` in errors.ts), so this is checkable rather than a
  // heuristic — which is what makes it an error and not a warning. Nothing in this repo declares
  // either field on a graph today, so it refuses nothing that exists.
  const knownCode = (c: string): boolean => Object.hasOwn(CODES, c);
  const nearest = (c: string): string => {
    const head = c.split("_").slice(0, 2).join("_");
    const near = Object.keys(CODES).filter((k) => k.startsWith(head));
    return near.length === 0 ? Object.keys(CODES).slice(0, 4).join(", ") : near.join(", ");
  };
  const checkCodes = (codes: unknown, at: Diagnostic["at"], who: string): void => {
    // Caller data: `codes: "E_X"` is a string, and iterating it would report every CHARACTER.
    if (!Array.isArray(codes)) return;
    for (const c of codes) {
      if (typeof c !== "string" || knownCode(c)) continue;
      d.push({
        severity: "error",
        code: "GRAPH003_UNKNOWN_ERROR_CODE",
        message: `${who} names error code "${c}", which no error in this system carries — it would never match`,
        ...(at === undefined ? {} : { at }),
        fix: `did you mean one of: ${nearest(c)}`,
      });
    }
  };
  /**
   * A SECOND QUESTION ABOUT THE SAME LIST, and only about `retry.onlyIf`.
   *
   * `checkCodes` asks whether the code EXISTS. This asks whether naming it can ever have an
   * effect: `#retryDecision` returns on `!error.retryable` long before it reads `onlyIf`, so a
   * member never raised with a retryable class is a filter that cannot match. The effect is
   * "no retry", which is the safe direction — what it costs is an author who writes it, sees
   * the compiler echo `onlyIf=E_FUNCTION_REFUSED` back in the retry summary, and concludes the
   * runtime honours it.
   */
  const checkRetryable = (codes: unknown, nodeId: NodeId): void => {
    if (!Array.isArray(codes)) return;
    for (const c of codes) {
      if (typeof c !== "string") continue;
      const classes = neverRetryable(c);
      if (classes === undefined) continue;
      d.push({
        severity: "error",
        code: "GRAPH003_UNRETRYABLE_ONLY_IF",
        message:
          `node "${nodeId}".retry.onlyIf names error code "${c}", which is raised as ` +
          `${classes.map((x) => `\`${x}\``).join(" and ")} — a class the retry policy never retries, ` +
          `so this filter can never match and the policy is dead`,
        at: { nodeId },
        fix:
          `remove "${c}" from onlyIf (an absent onlyIf retries every retryable error), or name a code raised as ` +
          `\`exhausted\`, \`unavailable\` or \`timeout\` — if "${c}" is the failure you want handled, an \`error\` edge ` +
          `with codes: ["${c}"] is the mechanism for it, not a retry`,
      });
    }
  };

  // `describeValue(e.id)`, and this template is where a `symbol` edge id threw `TypeError: Cannot
  // convert a Symbol value to a string` out of the whole compile — the first thing in the file to
  // name an id, before anything has said whether it is one. See the edge loop below for the rest of
  // the argument; a string id renders identically, quotes included.
  for (const e of spec.edges) checkCodes(e.codes, { edgeId: e.id }, `edge ${describeValue(e.id)}`);
  for (const n of spec.nodes) checkCodes(n.retry?.onlyIf, { nodeId: n.id }, `node "${n.id}".retry.onlyIf`);
  for (const n of spec.nodes) checkRetryable(n.retry?.onlyIf, n.id);

  // A BUDGET LADDER STEP THAT DOES NOT EXIST IS REFUSED, not silently downgraded. D6.5 designs
  // warn → degrade → gate → fail; only `fail` is built. `gate` read as "ask a human rather than
  // stop", and the engine escalated the ceiling for decisions that would never happen and then
  // failed the run anyway — the same outcome as `fail`, reached through a word that promised
  // supervision. `degrade` is read by nothing at all. The reason is that a graph which reads as
  // supervised and behaves otherwise is the worst failure available, because nobody goes looking.
  //
  // `approval.mode: "quorum"` used to be cited here as the same treatment and no longer is: the
  // FIELD was deleted, because k-of-n already worked as `join{mode:"quorum", k}` over N gates.
  // The surviving sibling is `RouterNode.mode: "model"`, and its own docstring says why it is
  // different — it is REQUIRED, so deleting the value would leave an unknown VALUE nothing
  // checks. `onBudgetExhausted` is a value in a union too, which is why this refusal stays.
  //
  // Implementing `gate` needs somewhere for the human's answer to GO — a way to raise a budget
  // mid-run — and no such API exists. Delete this refusal in the same change that adds one.
  const budgetAction = (spec.policy as { onBudgetExhausted?: unknown } | undefined)?.onBudgetExhausted;
  if (budgetAction !== undefined && budgetAction !== "fail") {
    d.push({
      severity: "error",
      code: "GRAPH003_BUDGET_ACTION_UNSUPPORTED",
      message: `\`policy.onBudgetExhausted: "${String(budgetAction)}"\` is designed but not built — the run would fail exactly as \`fail\` does, having promised otherwise`,
      fix: 'use "fail", which is what the engine does today',
    });
  }
  // AND INSIDE `policy`, at both scopes. Everything above this line checks a BLOCK's name;
  // this checks the block's contents, which is where the check stopped and where a typo costs
  // the most. See `checkPolicyBlocks`.
  if (checkPolicyBlocks(spec, d)) fatal = true;

  // AN ARRAY IS NOT AN OBJECT HERE, although `typeof []` says otherwise, and the omission was
  // reachable: `channels: []` walked straight past this test, and `Object.entries([])` is `[]`, so
  // the graph read as "declares no channels" instead of "declares channels wrongly". Through a
  // SUBGRAPH that was the difference between a refusal and silence — `rule016Subgraphs` asked
  // whether the child's `channels` was a plain object and skipped its half of every mapping check
  // when it was not, so a child with `channels: []` lost both `GRAPH016_BAD_MAPPING`s the base
  // compiler printed. `Array.isArray` is the same third clause `objectBlock` twenty lines up has
  // always had, missing from the one place a caller could reach with a JSON array.
  if (typeof spec.channels !== "object" || spec.channels === null || Array.isArray(spec.channels)) {
    d.push({
      severity: "error",
      code: "GRAPH003_MALFORMED",
      message: "`channels` must be an object",
      fix: "add `channels: {}` at the top level",
    });
    return true;
  }

  // A REDUCER NAME THE STATE LAYER DOES NOT KNOW. `step()` has no default arm, so an unknown
  // reducer silently DROPPED every write to that channel and the run died `E_OUTPUT_MISSING:
  // run finished without writing any of its declared outputs` — pointing at the output rather
  // than at the typo three lines above it.
  for (const [name, ch] of Object.entries(spec.channels)) {
    // A CHANNEL THAT IS NOT AN OBJECT reaches `.reduce` on `null` and throws `E_INTERNAL` out of
    // the validator — the same "not the shape it must be" as the policy blocks above, so it gets
    // the same treatment rather than a stack trace.
    const fix = "a channel is `{type, reduce, classification?}`";
    const decl = objectBlock(ch, `channel "${name}"`, { channel: name }, fix, d);
    if (decl === undefined) {
      // `objectBlock` treats ABSENT as fine, because the `policy` blocks it also serves are
      // optional. A channel's declaration is not, so `{note: undefined}` is reported here rather
      // than becoming a `fatal` with no diagnostic behind it — which `compile` reads as `ok`.
      if (ch === undefined) {
        d.push({ severity: "error", code: "GRAPH003_MALFORMED", message: `channel "${name}" declares nothing`, at: { channel: name }, fix });
      }
      fatal = true;
      continue;
    }
    // AND ITS KEYS. This is `policyy: {posture: "in"}` exactly one scope over, and it costs the
    // same control: `classificaton: "secret_ref"` compiled clean, left the channel unclassified,
    // and dropped every reader's floor from `in` to `out` with nothing said. `initial`, `reduce`
    // and `onConflict` fail the same way one consequence down.
    unknownKeys(decl, Object.keys(NESTED_FIELDS.channel), `channel "${name}"`, { channel: name }, d);
    blockFieldTypes(decl, "channel", NESTED_FIELDS.channel, `channel "${name}"`, { channel: name }, d);
    const projection = objectBlock(
      decl["contextProjection"],
      `channel "${name}"'s \`contextProjection\``,
      { channel: name },
      `a context projection is \`{maxTokens, overflow, fields?, take?}\``,
      d,
    );
    if (projection !== undefined) {
      unknownKeys(projection, Object.keys(NESTED_FIELDS.contextProjection), `channel "${name}"'s \`contextProjection\``, { channel: name }, d);
      blockFieldTypes(projection, "contextProjection", NESTED_FIELDS.contextProjection, `channel "${name}"'s \`contextProjection\``, { channel: name }, d);
      checkProjectionValues(name, projection, d);
    }
    const reduce = decl["reduce"];
    if (!REDUCER_NAMES.includes(reduce as never)) {
      d.push({
        severity: "error",
        code: "GRAPH003_UNKNOWN_REDUCER",
        message: `channel "${name}" declares reduce ${JSON.stringify(reduce)}, which is not a reducer`,
        at: { channel: name },
        fix: `use one of ${REDUCER_NAMES.join(", ")}`,
      });
      fatal = true;
    }
    // A CLASSIFICATION IN NO VOCABULARY. `vocab.ts` now floors an unreadable one at `in` so the
    // run fails SAFE — measured, `classification: "SECRET"` and `classification: "nonsense"` both
    // plan every reader at `in` — but safe is not what the author wrote, and until this check
    // existed neither word produced a single diagnostic. An author who typed `SECRET` for
    // `secret_ref` gets the strictest gate in the system on a channel they thought was ordinary,
    // with nothing anywhere saying why; an author who typed `pubic` for `public` gets the same.
    // Only the compiler is positioned to say which word was wrong and what the real ones are.
    //
    // NOT FATAL, unlike the reducer above: `dataFloorOf` folds this value through `maxPosture`,
    // which answers `in` for a non-member, so every rule downstream already reasons from the safe
    // answer and reporting the rest of the graph's faults alongside this one is worth more.
    const cls = decl["classification"];
    if (cls !== undefined && !isClassification(cls)) {
      d.push({
        severity: "error",
        code: "GRAPH003_UNKNOWN_CLASSIFICATION",
        message: `channel "${name}" declares classification ${JSON.stringify(cls)}, which is not a data classification`,
        at: { channel: name },
        fix: `use one of ${CLASSIFICATIONS.join(", ")} — \`secret_ref\` gates every reader, \`pii\` requires a human watching, \`internal\` and \`public\` add no floor`,
      });
    }
  }

  if (spec.apiVersion !== GRAPH_API_VERSION) {
    d.push({
      severity: "error",
      code: "GRAPH000_API_VERSION",
      message: `unknown apiVersion "${spec.apiVersion}"`,
      fix: `set apiVersion: ${GRAPH_API_VERSION}`,
    });
    fatal = true;
  }

  // Ids first, and fatally: every rule after this keys a map by them, and the runtime
  // derives TaskIds, branch paths and effect keys from them by concatenation.
  const badId = (what: string, id: unknown, at: Diagnostic["at"]): void => {
    const base = {
      severity: "error" as const,
      code: "GRAPH003_BAD_ID",
      // `describeValue`, NOT `JSON.stringify`, and the difference is that one of them throws on the
      // value it is describing. `JSON.stringify(10n)` is `TypeError: Do not know how to serialize a
      // BigInt` and `JSON.stringify({toJSON(){throw}})` re-raises, so an id of either kind came out
      // of `compile` as an exception rather than as this refusal — which is the shape
      // `describeValue`'s own docstring exists for. Measured on the fixture: `id: 10n` threw from
      // this line; it is now `edge id 10n is not a usable id`. A string, a number, `null` and a
      // boolean render exactly as they did; an array is `an array`, an object `an object`, and
      // `NaN`/`Infinity` are their own names where `JSON.stringify` called both `null`.
      message: `${what} ${describeValue(id)} is not a usable id`,
      fix: "an id starts with a letter or digit and may then use letters, digits, `.`, `_` and `-`; `@ # / [ ] :` are the separators TaskId, branch paths and effect keys are built from",
    };
    d.push(at === undefined ? base : { ...base, at });
    fatal = true;
  };
  // A node id is an object key in more than one plain object, and the REACHABLE hazard is not
  // the one it looks like. `compile.ts` builds `plans[n.id] = {…}`, but every consuming read —
  // `ctx.graph.plans[nodeId]?.posture`, `.outboundEdges`, `.timeoutMs`, `.retry`, `.criticalPathLength`
  // and `.layoutRank`, across `run/engine.ts`, `run/scheduler.ts`, `cli.ts` and
  // `server/layout.ts` (the full set of `plans[` sites in the tree) — is `?.field ?? default`,
  // and `?.` on a function (what `plans["toString"]` answers when node "toString" is never
  // declared) reads no such field either, so it degrades to the same default an absent plan
  // would give. `plans` alone is not exploitable today.
  //
  // THE ONE THAT IS: `ctx.baselinePostures?.[n.id]`, read below in this same function's sibling
  // rule (search this file for `baselinePostures`), feeding `isLoosening(baseline, effective)`
  // for `GRAPH014_OVERSIGHT_LOOSENED`. `isLoosening` fails closed on a baseline it cannot read
  // as a `Posture` — deliberately, by its own docstring — so a node named `toString` with ANY
  // `baselinePostures` supplied (the promotion path in `cli.ts` and the model-proposed-mutation
  // path in `mutate.ts` both supply one) reads `Object.prototype.toString`, which is not a
  // `Posture`, and fabricates a loosening error for a graph that loosened nothing. That is not
  // merely a wrong code: `compile` raises `err.policy`/`E_OVERSIGHT_LOOSENED` rather than
  // `err.validation`/`E_GRAPH_INVALID` whenever a `GRAPH014_OVERSIGHT_LOOSENED` is present, so
  // the caller sees a POLICY refusal for a spec that never reached policy. Refusing the id here,
  // and FATALLY (`fatal = true` below, matching `badId`'s own early return), matters because
  // `validateGraph` returns as soon as `checkStructure` reports fatal — the GRAPH014 rule, which
  // runs later in the same function, never executes for this spec at all. See
  // `graph-lane-reserved-node-id.test.ts`'s "…AND SUPPRESSES A FABRICATED GRAPH014" for the pin.
  for (const n of spec.nodes) {
    if (!isSafeId(n.id)) {
      badId("node id", n.id, typeof n.id === "string" ? { nodeId: n.id } : undefined);
      continue;
    }
    if (PROTOTYPE_NAMES.has(n.id)) {
      d.push({
        severity: "error",
        code: "GRAPH003_RESERVED_NODE_ID",
        message: `node id "${n.id}" is a name \`Object.prototype\` already carries — a lookup of this id in any node-keyed object that has no entry for it (for example \`baselinePostures\`) silently answers with the prototype's member instead of \`undefined\``,
        at: { nodeId: n.id },
        fix: `rename the node; the reserved names are ${RESERVED_LIST}`,
      });
      fatal = true;
    }
  }
  // Edge ids key `edgeById`/`inbound`/`outbound` — all `Map`, not plain objects — so a `Map#get`
  // or `Map#set` on `"toString"` or `"__proto__"` is an ordinary key with no `Object.prototype`
  // collision. No reserved-name rule needed here; only the charset rule below applies.
  for (const e of spec.edges) if (!isSafeId(e.id)) badId("edge id", e.id, typeof e.id === "string" ? { edgeId: e.id } : undefined);
  // A channel name is an object key in `ChannelState`, and `initialState` assigns it with
  // `out[name] = …` — which for `__proto__` writes the prototype and declares nothing.
  for (const name of Object.keys(spec.channels ?? {})) {
    if (!isSafeId(name)) {
      badId("channel name", name, { channel: name });
      continue;
    }
    if (PROTOTYPE_NAMES.has(name)) {
      d.push({
        severity: "error",
        code: "GRAPH003_RESERVED_CHANNEL",
        message: `channel "${name}" is a name \`Object.prototype\` already carries, so no object keyed by channel name can hold it`,
        at: { channel: name },
        fix: `rename the channel; the reserved names are ${RESERVED_LIST}`,
      });
      fatal = true;
    }
  }

  const seenNodes = new Set<string>();
  for (const n of spec.nodes) {
    if (seenNodes.has(n.id)) {
      d.push({ severity: "error", code: "GRAPH003_DUPLICATE_ID", message: `duplicate node id "${n.id}"`, at: { nodeId: n.id } });
      fatal = true;
    }
    seenNodes.add(n.id);

    // A TYPE OUTSIDE THE UNION USED TO PASS BOTH HALVES OF GRAPH020 VACUOUSLY.
    // `REQUIRED_BLOCK[n.type]` is `undefined` for an unknown type, so no block was
    // required; and one block is not more than one, so the extra-block check passed too.
    // `REQUIRED_BLOCK` is the only runtime enumeration of `NodeType` and every untyped
    // entry point casts — the CLI, the resource store, a model-proposed mutation — so a
    // typo compiled clean and the engine, which has no dispatch case for it, then failed
    // the run on a raw `TypeError` rather than on anything an author could read.
    //
    // `Object.hasOwn`, not `in`: `"toString" in REQUIRED_BLOCK` is true and its value is a
    // Function, so `in` would admit exactly the names that break a lookup.
    if (!Object.hasOwn(REQUIRED_BLOCK, n.type)) {
      d.push({
        severity: "error",
        code: "GRAPH020_UNKNOWN_TYPE",
        message: `node "${n.id}" declares type ${JSON.stringify(n.type)}, which is not a node type`,
        at: { nodeId: n.id },
        fix: `use one of ${Object.keys(REQUIRED_BLOCK).join(", ")}`,
      });
      fatal = true;
      continue;
    }

    const required = REQUIRED_BLOCK[n.type];
    if (required !== undefined && n[required] === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH020_MISSING_BLOCK",
        message: `node "${n.id}" is type ${n.type} but has no \`${String(required)}\` block`,
        at: { nodeId: n.id },
        fix: `add a \`${String(required)}:\` block to node "${n.id}"`,
      });
      fatal = true;
    }
    // `function.effects` IS A LABEL A GUARD READS, so its SHAPE is load-bearing rather than
    // cosmetic. `isExternal` asks `effects === undefined || effects.length > 0`, so anything with
    // no numeric `length` — `null`, `{}`, `0` — reads as "declared, and empty", which is the
    // author's claim that this node is PURE COMPUTATION and its output need not be tainted.
    // Measured before this rule: `effects: null` and `effects: ""` compiled with no error at all
    // and marked the node pure, while `effects: {}`, `effects: 0` and `effects: {length: 0}`
    // crashed `reachableToolNames` with a raw `TypeError: object is not iterable` — a guard
    // reporting a fault and then tripping over it, the third instance of that shape this week.
    //
    // Refused rather than coerced. An empty array is a CLAIM and must be written as one; a
    // malformed value is not a smaller claim, it is an unreadable one, and the fail-closed
    // reading of an unreadable label is that the node is untrusted — which `isExternal` now also
    // answers on its own, because a journal can carry a shape this compiler never saw.
    //
    // `typeof … === "object"` AND NOT `!== undefined`, because `function: null` passed that test
    // and threw `TypeError: Cannot read properties of null (reading 'effects')` — the one member
    // of the eight-way `<block>: null` crash below that did NOT come out of `Object.keys`, and so
    // the one the check down there cannot cover on its own. A block that is not a block is that
    // check's to report; this one asks only about a block that is.
    if (n.type === "function" && typeof n.function === "object" && n.function !== null) {
      const declared: unknown = (n.function as { effects?: unknown }).effects;
      const bad =
        declared !== undefined &&
        (!Array.isArray(declared) || declared.some((x) => typeof x !== "string" || !isSafeId(x)));
      if (bad) {
        d.push({
          severity: "error",
          code: "GRAPH003_MALFORMED",
          message:
            `node "${n.id}" declares \`effects\` as ${JSON.stringify(declared)}, which is not a list of tool names — ` +
            `and \`effects\` is the label that says this node is pure computation, so an unreadable one is not a smaller claim`,
          at: { nodeId: n.id },
          fix: `write \`effects: []\` to declare the node reaches no tool, or list the tool names it may invoke`,
        });
        fatal = true;
      }
    }

    // `timeoutMs` IS A TIMER, so it joins the family every other caller-supplied duration is in.
    // `setTimeout` truncates anything above MAX_TIMER_MS to ONE MILLISECOND, so an out-of-range
    // deadline is not a loose one — it is a node that fails instantly.
    for (const [field, value] of [["timeoutMs", n.timeoutMs]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS)) {
        d.push({
          severity: "error",
          code: "GRAPH003_MALFORMED",
          message: `node "${n.id}" declares ${field} ${String(value)}, which is not a whole number of milliseconds a timer can hold (1…${MAX_TIMER_MS})`,
          at: { nodeId: n.id },
          fix: `a value above ${MAX_TIMER_MS} is truncated to 1ms by every Node timer, so it would become its own opposite`,
        });
        fatal = true;
      }
    }

    // `retry` IS THE WORST BLOCK IN THIS FAMILY, and nothing checked inside it. Measured against
    // `compile`: `retry: {maxAttemptss: 3}` → ok, zero diagnostics, `plan.retry` a block with no
    // `maxAttempts` at all. `#retryDecision` stops at `attempt >= policy.maxAttempts`, and
    // `n >= undefined` is false for every `n`, so the bound the author wrote is not lost — it is
    // ABSENT, and a node that should stop after three tries retries until the run's budget runs
    // out. `effectiveRetry` compounds it: a `retry` block that EXISTS suppresses
    // `DEFAULT_PROVIDER_RETRY`, so the typo also removes the sane default it was overriding.
    //
    // NOT `fatal`, on this file's own stated rule: a lost bound costs a limit, not a posture, and
    // no later rule reasons from `retry` — so the author gets this diagnostic alongside the rest
    // of the graph's faults rather than instead of them. It is still an ERROR: unlike
    // `GRAPH019_POSTURE_NO_EFFECT`, where the author wrote something real that cannot take
    // effect, this graph does not mean what it says.
    const retryBlock = objectBlock(
      n.retry,
      `node "${n.id}"'s \`retry\``,
      { nodeId: n.id },
      `a retry policy is \`{maxAttempts, backoff?, initialMs?, maxMs?, jitter?, onlyIf?}\``,
      d,
    );
    if (n.retry !== undefined && retryBlock === undefined) fatal = true;
    if (retryBlock !== undefined) {
      unknownKeys(retryBlock, Object.keys(NESTED_FIELDS.retry), `node "${n.id}"'s \`retry\` block`, { nodeId: n.id }, d);
      blockFieldTypes(retryBlock, "retry", NESTED_FIELDS.retry, `node "${n.id}"'s \`retry\` block`, { nodeId: n.id }, d);
      // REQUIRED, and required as a NUMBER. `RetryPolicy.maxAttempts` is the only non-optional
      // field on the interface and nothing enforced it; a string survives the comparison by
      // coercion, but `undefined`, `null` and a non-integer all make it always-false.
      const max = retryBlock["maxAttempts"];
      if (!Number.isInteger(max) || (max as number) < 1) {
        d.push({
          severity: "error",
          code: "GRAPH020_MISSING_FIELD",
          message: `node "${n.id}" has a \`retry\` block whose \`maxAttempts\` is ${
            max === undefined ? "missing" : `${JSON.stringify(max)}, which is not a whole number of attempts`
          }`,
          at: { nodeId: n.id },
          fix: `add \`maxAttempts:\` — without it the engine compares \`attempt >= undefined\`, which is never true, so the retry never stops`,
        });
      }
    }

    // AND THAT THE TYPE BLOCK IS A BLOCK AT ALL, before either check below reads inside it.
    //
    // `REQUIRED_FIELDS` proves `agent: {}` has no `profile` and `ALLOWED_FIELDS` proves it carries
    // nothing invented; both assume the thing is an object, and `typeof null === "object"` is why
    // the second one did not. Measured on one graph per node type, every one of the eight:
    //
    //     tool: null / agent: null / join: null / router: null / evaluator: null /
    //     humanGate: null / subgraph: null   ->  THREW TypeError: Cannot convert undefined or
    //                                            null to object   (`Object.keys(null)`)
    //     function: null                     ->  THREW TypeError: Cannot read properties of null
    //                                            (reading 'effects')
    //
    // — a crash where a diagnostic belonged, and the ancestor of §A.79 one scope out: a graph
    // FILE decides this value, because `compile`'s input is a cast `JSON.parse`.
    //
    // IT GATES THE TWO CHECKS BELOW rather than running beside them, because their answers are
    // false for a non-object. `subgraph: 42` reported `` `ref` is missing `` — the `ref` is not
    // missing from a block that does not exist — and a correction that replaces a false claim
    // with a differently-false one is worse than the original.
    //
    // `GRAPH003_MALFORMED` and `objectBlock` rather than a new code: this is already the file's
    // answer to "a block is not the shape it must be" at the channel, policy and element sites.
    const holder = REQUIRED_BLOCK[n.type];
    const rawBlock = (n as unknown as Record<string, unknown>)[holder as string];
    const blockWhere = `node "${n.id}"'s \`${String(holder)}\` block`;
    const declared =
      rawBlock === undefined
        ? undefined
        : objectBlock(
            rawBlock,
            blockWhere,
            { nodeId: n.id },
            `a \`${String(holder)}\` block is an object — ${blockWhere} may declare ${ALLOWED_FIELDS[n.type]
              .map((a) => `\`${a}\``)
              .join(", ")}`,
            d,
          );
    const blockIsMalformed = rawBlock !== undefined && declared === undefined;
    if (blockIsMalformed) fatal = true;

    // AND THE BLOCK'S OWN REQUIRED FIELDS. `REQUIRED_BLOCK` proves a node HAS an `agent:`; it
    // says nothing about `agent: {}`. Every one of these used to reach `parseRef(undefined)` and
    // come back as `E_INTERNAL: TypeError: Cannot read properties of undefined (reading
    // 'lastIndexOf')`, which tells an author nothing about their graph.
    for (const [field, blockHolder, shape] of blockIsMalformed ? [] : REQUIRED_FIELDS[n.type] ?? []) {
      const block = n[blockHolder] as Record<string, unknown> | undefined;
      const value = block?.[field];
      const bad = shape === "array" ? !Array.isArray(value) : typeof value !== "string";
      if (block !== undefined && bad) {
        d.push({
          severity: "error",
          code: "GRAPH020_MISSING_FIELD",
          message: `node "${n.id}" has a \`${String(blockHolder)}\` block whose \`${field}\` is ${
            value === undefined ? "missing" : `not ${shape === "array" ? "an array" : "a string"}`
          }`,
          at: { nodeId: n.id },
          fix: `add \`${field}:\` to node "${n.id}"'s \`${String(blockHolder)}\` block`,
        });
        fatal = true;
      }
    }

    // AND NOTHING THE BLOCK DOES NOT DECLARE. Missing was checked; UNKNOWN was not, for any node
    // type, so a misspelled or invented key compiled clean and decided nothing. That is quiet in
    // the dangerous direction: `evaluator: {…, effects: [...]}` reads as a capability ceiling to
    // the author who wrote it and is not one. `ALLOWED_FIELDS` is the enumeration; see its
    // docstring for why it lives beside `REQUIRED_FIELDS`.
    //
    // An ERROR rather than a warning. The other treatments in this family —
    // `GRAPH019_POSTURE_NO_EFFECT` and GRAPH013's unknown tool — warn because the graph still
    // means what it says and the author has merely been told less than they think. An unknown
    // KEY means the author wrote something the compiler cannot interpret at all, and the
    // nearest-name hint below makes a typo cheap to fix rather than cheap to ignore.
    //
    // THIS RULE IS WHERE THE INERT-DECLARATION FAMILY ENDED UP. `GRAPH019_CPUBOUND_NO_EFFECT`
    // and `GRAPH008_JOIN_TIMEOUT_INERT` were both bespoke warnings for one field each; both
    // fields were deleted, and the generic refusal here is what an author meets instead. It has
    // no undecidable case — a key is in `ALLOWED_FIELDS` or the graph is refused — where a
    // per-field warning had to be argued into existence one field at a time.
    if (declared !== undefined) {
      if (unknownKeys(declared, ALLOWED_FIELDS[n.type], blockWhere, { nodeId: n.id }, d)) fatal = true;
    }

    // AND THE NODE'S OWN KEYS. This is where the family's worst member lives: `policyy:
    // {posture: "in"}` compiled clean and ran at `out`, so an author asking for the strongest
    // oversight the system has got the weakest and was told nothing. `retry`, `timeoutMs` and
    // `checkpoint` are silently discarded the same way.
    if (unknownKeys(n as unknown as Record<string, unknown>, NODE_FIELDS, `node "${n.id}"`, { nodeId: n.id }, d)) {
      fatal = true;
    }

    // Exactly one type block, so a node cannot quietly carry a stale second config.
    const present = Object.values(REQUIRED_BLOCK).filter((k) => n[k] !== undefined);
    if (present.length > 1) {
      d.push({
        severity: "error",
        code: "GRAPH020_EXTRA_BLOCK",
        message: `node "${n.id}" declares more than one type block: ${present.join(", ")}`,
        at: { nodeId: n.id },
      });
      fatal = true;
    }
  }

  const seenEdges = new Set<string>();
  // EVERY VALUE THIS LOOP NAMES GOES THROUGH `describeValue`, and it is the same argument §A.73
  // made one rule over. `edge "${e.id}"` is a template over a value nobody has checked yet, and it
  // had two failure modes measured on this fixture: a `symbol` id threw `TypeError: Cannot convert
  // a Symbol value to a string` from the `checkCodes` call above, so the compiler crashed instead
  // of refusing; and an id carrying a newline FORGED LINES in the CLI's own output, because the
  // printer puts one diagnostic per line and nothing escaped it. `describeValue` quotes a string
  // the way `JSON.stringify` does, so an id `isSafeId` accepts renders exactly as it did — the
  // quotes moved into the renderer, they did not disappear.
  const edgeMaxFanout = maxFanoutOf(spec);
  for (const e of spec.edges) {
    if (seenEdges.has(e.id)) {
      d.push({ severity: "error", code: "GRAPH003_DUPLICATE_ID", message: `duplicate edge id ${describeValue(e.id)}`, at: { edgeId: e.id } });
      fatal = true;
    }
    seenEdges.add(e.id);
    if (!seenNodes.has(e.from)) {
      d.push({ severity: "error", code: "GRAPH003_DANGLING_EDGE", message: `edge ${describeValue(e.id)} starts at unknown node ${describeValue(e.from)}`, at: { edgeId: e.id } });
      fatal = true;
    }
    if (!seenNodes.has(e.to)) {
      d.push({ severity: "error", code: "GRAPH003_DANGLING_EDGE", message: `edge ${describeValue(e.id)} ends at unknown node ${describeValue(e.to)}`, at: { edgeId: e.id } });
      fatal = true;
    }
    // A misspelled `when` does not disable a condition — it makes the edge unconditional, so a
    // branch the author meant to guard fires every time. `codes` on an error edge is the same
    // shape widened to every code.
    if (unknownKeys(e as unknown as Record<string, unknown>, Object.keys(EDGE_FIELDS), `edge ${describeValue(e.id)}`, { edgeId: e.id }, d)) {
      fatal = true;
    }
    // AND THE ONE KEY WHOSE *VALUE* IS A VOCABULARY. `unknownKeys` closes the key names and
    // `edgeFieldTypes` closes what the other twelve hold; `kind` is the thirteenth, and it is a
    // closed set rather than a type — which is why `TYPE_CHECKED_ELSEWHERE` defers the type half
    // of it to this check rather than the other way round.
    //
    // RELOCATED FROM `graph/compile.ts`'s `unknownEdgeKinds` (§A.80), which is what that
    // function's own docstring asked for — *"the rule belongs beside GRAPH020 and moving it there
    // is a pure relocation"* — and the reason it had to move is not tidiness. `compile` ran it on
    // the TOP-LEVEL spec only, while `rule016Subgraphs` recurses `validateGraph`, so the one
    // refusal that is total over `kind` did not reach a subgraph CHILD. Measured before, on a
    // parent whose child carries one edge with `kind: 42` and `maxWidth: "24"`:
    //
    //     compile(parent)                    GRAPH007_BAD_MAX_WIDTH alone — the child's `kind`
    //                                        was unchecked and reached the executor's own
    //                                        `EDGE_KINDS` copy at run time
    //     validateGraph alone, kind: 42       (none)
    //
    // and after, both report `GRAPH003_UNKNOWN_EDGE_KIND` as well. It was pinned NEGATIVELY in
    // `test/graph/edge-field-types.test.ts`, which now pins it positively.
    //
    // NOT FATAL, which is the one thing about the move that is not free and is deliberate. The
    // rule's diagnostics used to be PREPENDED to `validateGraph`'s, so they survived a fatal
    // `checkStructure`; now they are inside it, and a graph that also trips an EARLIER fatal check
    // — `channels: null`, a malformed node — reports that one and NOT this one. That is the gate's
    // established semantics, stated at `edgeFieldTypes` for the same loop. Setting `fatal` here
    // would be the larger change: every rule below `checkStructure` runs today on a graph with an
    // unknown kind, and `rule003`'s own arms are written expecting to.
    //
    // THE OTHER TWO THINGS THE MOVE CHANGED, neither a behaviour change and both worth stating
    // because a reader comparing output across the relocation will see them:
    //
    //   POSITION. The message TEXT is byte-identical, but it used to be FIRST in `diagnostics`
    //     and is now emitted in edge-loop order — so on an edge that is also missing a key,
    //     `GRAPH020_UNKNOWN_FIELD` now precedes `GRAPH003_UNKNOWN_EDGE_KIND` where it followed.
    //     Nothing reads the order; `compile` reports a SET and the CLI prints it as one.
    //   SUPPRESSION. The lost-behind-an-earlier-fatal case above is the same fact from the
    //     author's side: `channels: null` plus `kind: 42` used to print both and now prints one.
    // `typeof !== "string"` FIRST, AND THAT IS NOT A NARROWING. The rule is still "any kind that
    // is not an own key of `EDGE_KINDS`, whatever its type" — every non-string fails this clause
    // exactly as it failed `Object.hasOwn` — but `Object.hasOwn(obj, key)` COERCES its key, so
    // `kind: [Symbol()]` threw `TypeError: Cannot convert a Symbol value to a string` from the
    // guard itself. Asking about the type first reaches the same verdict without coercing.
    if (typeof e.kind !== "string" || !Object.hasOwn(EDGE_KINDS, e.kind)) {
      d.push({
        severity: "error",
        code: "GRAPH003_UNKNOWN_EDGE_KIND",
        // `JSON.stringify` ANSWERS `undefined` FOR `undefined`, which would print the word "kind"
        // followed by nothing and read as a formatting bug rather than as the missing declaration
        // it is. `String()` covers every non-string this catches, and a string kind still gets its
        // quotes so `""` is visible.
        //
        // NOT `describeValue` FOR THE JSON-REACHABLE VALUES, although it is in this file now —
        // `JSON.stringify` prints `{}` and `[]` where `describeValue` prints "an object" and "an
        // array", so swapping it outright is a message change and not a relocation.
        //
        // BUT THE RENDER IS TOTAL NOW, and that arm is not cosmetic. `JSON.stringify` throws on a
        // `bigint`, on a circular object, and on any `toJSON` the caller wrote — and the
        // relocation put this call where a SUBGRAPH CHILD's edge reaches it, so a child edge with
        // `kind: 10n` turned an `ok: true` compile into an exception out of `compile`. Only a
        // programmatic resolver can hand one over — a JSON file expresses no `bigint`, no `symbol`
        // and no cycle — which is why the case is narrow and is NOT why it would be acceptable: a
        // guard that throws while describing what it is refusing is the
        // crash-where-a-refusal-belongs shape this file closes everywhere else.
        //
        // `describeValue` IS THE FALLBACK AND NOT THE DEFAULT, which is what keeps this a
        // relocation: it prints "an object" and "an array" where `JSON.stringify` prints `{}` and
        // `[]`, so every value a JSON file can express still renders byte-for-byte as it did, and
        // only the values that would have CRASHED take the other path.
        message: `edge "${e.id}" declares kind ${renderKind(e.kind)}, which is not an edge kind — its \`when\`, \`until\`, \`over\` and \`branches\` are all ignored and the edge is taken unconditionally`,
        at: { edgeId: e.id },
        fix: `use one of ${Object.keys(EDGE_KINDS).join(", ")}`,
      });
    }
    // AND WHAT EACH KNOWN KEY HOLDS. `EDGE_FIELDS` used to be a NAME list — it said `maxWidth` was
    // allowed and nothing about its type, so `maxWidth: "24"` parsed and every reader that needed
    // a number tested for one by hand (TODO §A.62). The table carries the type now and
    // `edgeFieldTypes` is the one place that enforces it.
    if (edgeFieldTypes(e as unknown as Record<string, unknown>, edgeMaxFanout, d)) fatal = true;
  }

  // `Object.hasOwn` at every "is this a declared channel?" site in this file. `in` walks
  // the prototype chain, so `toString`, `constructor` and `valueOf` all answered "declared"
  // against a `channels` object that declares nothing of the sort — while the state layer
  // asks `hasOwnProperty` (see `declared` in state/channels.ts) and refuses the same name
  // at run time. The compiler proved a dataflow the runtime does not have.
  for (const name of [...spec.inputs, ...spec.outputs]) {
    if (!Object.hasOwn(spec.channels, name)) {
      d.push({
        severity: "error",
        code: "GRAPH003_UNDECLARED_CHANNEL",
        message: `"${name}" is listed in inputs/outputs but is not a declared channel`,
        at: { channel: name },
      });
      fatal = true;
    }
  }
  if (spec.nodes.length === 0) {
    d.push({ severity: "error", code: "GRAPH003_EMPTY", message: "a graph must declare at least one node" });
    fatal = true;
  }
  return fatal;
}

// ── GRAPH001 ─────────────────────────────────────────────────────────────────

function rule001Reachability(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  if (idx.entryNodes.length === 0) {
    d.push({
      severity: "error",
      code: "GRAPH001_NO_ENTRY",
      message: "no entry node: every node has an inbound forward edge, so nothing can start",
      fix: "remove an inbound edge from the intended first node, or mark a back-edge kind: loop",
    });
    return;
  }
  for (const n of spec.nodes) {
    if (!idx.reachable.has(n.id)) {
      d.push({
        severity: "error",
        code: "GRAPH001_UNREACHABLE",
        message: `node "${n.id}" is unreachable from any entry node`,
        at: { nodeId: n.id },
        fix: `add an edge into "${n.id}", or delete it`,
      });
    }
  }
}

// ── GRAPH002 ─────────────────────────────────────────────────────────────────

function rule002Terminals(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  if (spec.outputs.length === 0) return;
  const writers = new Set<NodeId>();
  for (const n of spec.nodes) {
    if ((n.writes ?? []).some((w) => spec.outputs.includes(w))) writers.add(n.id);
  }
  if (writers.size === 0) {
    d.push({
      severity: "error",
      code: "GRAPH002_NO_OUTPUT_WRITER",
      message: `no node writes any declared output (${spec.outputs.join(", ")})`,
      fix: "add an output channel to some node's `writes`",
    });
    return;
  }
  // Every terminal path must be able to end somewhere that produced an output.
  //
  // BOTH DIRECTIONS OVER `flowEdges`, AND THE SECOND IS THE §A.84 FIX. This asked
  // `idx.ancestors` — "did a writer run before me" — which does not walk a `loop` edge, so
  // `harden-config.json`'s `fix` was told on every command that it "ends a path on which no
  // declared output is ever written" while `fix -loop-> audit -> collate` writes `report` on
  // every pass. The writer is DOWNSTREAM of the terminal node, through the back-edge, which is a
  // shape only a loop can produce and which the old question could not express.
  //
  // WHAT IT IS NOT: `terminalNodes` widened. Making a loop source non-terminal was tried and
  // emptied the set on nearly every looping graph, taking GRAPH002 with it — see `indexGraph`.
  // The set is the base one; only the question changed.
  //
  // AND IT STILL WARNS WHERE IT SHOULD, which is the half a widening loses: on `s -> good`
  // (writing the output) beside `s -> b -> c` with `c -loop-> b`, the terminal `c` reaches only
  // `b` and `c`, neither writes an output, and no writer reaches `c` — so it is still a dead end
  // and still says so.
  // OVER `writers`, NOT OVER EVERY NODE: the set is already built two lines up, and scanning
  // `idx.byId` to filter it back down is the same avoidable O(nodes) per terminal that
  // `rule005Dataflow` paid for per read.
  const reachesAWriter = (t: NodeId): boolean =>
    [...writers].some((w) => canPrecede(idx, w, t) || canPrecede(idx, t, w));
  for (const t of idx.terminalNodes) {
    const producesOutput = writers.has(t) || reachesAWriter(t);
    if (!producesOutput) {
      d.push({
        severity: "warning",
        code: "GRAPH002_DEAD_END",
        message: `terminal node "${t}" ends a path on which no declared output is ever written`,
        at: { nodeId: t },
      });
    }
  }
}

// ── GRAPH004 ─────────────────────────────────────────────────────────────────

function rule004Expressions(
  spec: GraphSpec,
  idx: GraphIndex,
  channelTypes: Record<string, Ty>,
  d: Diagnostic[],
): void {
  const check = (src: string, where: NonNullable<Diagnostic["at"]>, readsOf: NodeId | undefined): void => {
    // `src` IS TYPED `string` AND IS NOT ONE WHENEVER THE AUTHOR WROTE SOMETHING ELSE: `compile`'s
    // input is `JSON.parse` output that `cli.ts` casts, so `when: 42` arrives here as a number and
    // `checkExpr` refuses it — correctly, and this is the refusal `TYPE_CHECKED_ELSEWHERE` defers
    // `when` and `until` to. But the MESSAGE interpolated it raw, so `when: Symbol()` threw
    // `TypeError: Cannot convert a Symbol value to a string` from this very line and the compile
    // crashed instead of printing the refusal it had already decided on. A string passes through
    // untouched — this message quotes the expression in backticks and must keep showing it as the
    // author typed it, which is why it is not `describeValue` outright.
    const shown = typeof src === "string" ? src : describeValue(src);
    const r = checkExpr(src, channelTypes);
    if (!r.ok) {
      for (const message of r.errors) {
        d.push({ severity: "error", code: "GRAPH004_EXPR", message: `\`${shown}\`: ${message}`, at: where });
      }
      return;
    }
    if (readsOf === undefined) return;
    // An expression may only reference what its owning node declared, otherwise the
    // dataflow the compiler proved and the dataflow that runs are different graphs.
    //
    // `reads ∪ writes`, not just `reads`: an edge condition is evaluated on
    // POST-COMMIT state, so `until: verdict.pass` on an edge leaving the node that
    // just wrote `verdict` is correct and must not be rejected.
    const owner = idx.byId.get(readsOf);
    const declared = new Set([...(owner?.reads ?? []), ...(owner?.writes ?? [])]);
    for (const ref of r.refs) {
      if (!declared.has(ref)) {
        d.push({
          severity: "error",
          code: "GRAPH004_UNDECLARED_READ",
          message: `\`${shown}\` reads channel "${ref}", which node "${readsOf}" does not declare in \`reads\``,
          at: where,
          fix: `add "${ref}" to node "${readsOf}".reads`,
        });
      }
    }
  };

  for (const e of spec.edges) {
    if (e.when !== undefined) check(e.when, { edgeId: e.id }, e.from);
    if (e.until !== undefined) check(e.until, { edgeId: e.id }, e.from);
  }
  for (const n of spec.nodes) {
    // EVERY mode, not only `expression`. `#runRouter` evaluates `cases[].when` whatever
    // the mode says, so gating this check on the mode meant declaring the unbuilt `model`
    // mode also switched the expression rules off for that node: an unparseable condition
    // compiled clean and died at run time, and a condition reading an undeclared channel
    // compiled clean and then really decided the branch — the exact thing
    // `GRAPH004_UNDECLARED_READ` exists to make impossible.
    for (const c of n.router?.cases ?? []) check(c.when, { nodeId: n.id }, n.id);
  }

  // AND `tool.args`, WHICH IS A READ SET THIS RULE HAD NEVER LOOKED AT.
  //
  // The rule above says an expression may only reference what its owning node declared. A tool
  // node's arguments are the other way a node names a channel, and `#runToolNode` resolves them
  // against `scopeFor(...)` — the WHOLE channel scope, not a slice of `reads` — so
  // `args: {body: "${secret}"}` on a node declaring `reads: ["plain"]` compiled clean and handed
  // the tool the secret. That exact graph is `test/graph/data-floor.test.ts`.
  //
  // A WARNING, AND THE ARGUMENT IS THAT THE RUNTIME IS ALREADY CORRECT. Every decision computed
  // from the read set — the oversight floor, `dataClassification`, taint, the gate payload and
  // its binding — reads `observedChannels`, which folds `tool.args` in, so the channel is not
  // escaping any guard: the graph runs at the posture the secret demands. What is wrong is the
  // DECLARATION: `reads` under-reports what the node reads, to every human reading the graph and
  // to `#resolveReads`. Making that an error would refuse graphs that run correctly today —
  // including the regression test that pins the fix — and this file's own rule for an allow-list
  // is that refusing correct graphs is worse than the hole it closed. So it is reported, loudly,
  // and it does not fail the compile.
  //
  // NOT COVERED, and said rather than implied: a `subgraph` node's `inputs` name parent channels
  // and are checked against `spec.channels`, never against `reads`. `observedChannels` does not
  // scan them either, so that hop has neither half of this pair.
  for (const n of spec.nodes) {
    if (n.tool?.args === undefined) continue;
    const declared = new Set([...(n.reads ?? []), ...(n.writes ?? [])]);
    for (const ref of observedChannels(n)) {
      // A NODE'S ERROR PROJECTION IS NOT A TEMPLATE VALUE, and naming one here is refused rather
      // than warned about: `resolveArgs` resolves against channels only, so `${x:error}` would
      // silently become nothing, and a tool node is outside the set that may read it at all.
      if (errorProjectionSource(ref) !== undefined) {
        d.push({
          severity: "error",
          code: "GRAPH005_ERROR_PROJECTION_READER",
          message: `node "${n.id}"'s tool arguments name "${ref}", a node's error projection; it is served to a \`function\` body or an \`evaluator{kind: "assertion"}\` body only, never to a tool argument`,
          at: { nodeId: n.id, channel: ref },
          fix: `read "${ref}" in a function node and write what the tool needs to a declared channel`,
        });
        continue;
      }
      if (declared.has(ref)) continue;
      d.push({
        severity: "warning",
        code: "GRAPH004_UNDECLARED_ARG_READ",
        message: `node "${n.id}"'s tool arguments read channel "${ref}", which it does not declare in \`reads\``,
        at: { nodeId: n.id, channel: ref },
        fix: Object.hasOwn(spec.channels, ref)
          ? `add "${ref}" to node "${n.id}".reads — the argument is resolved against the whole channel scope either way, so the declaration is the only thing that is wrong`
          : `"${ref}" is not a declared channel either, so the argument resolves to nothing — declare it under channels: and add it to node "${n.id}".reads`,
      });
    }
  }
}

/**
 * A router may only route along its OWN edges.
 *
 * `#activate` looks an edge id up in the whole graph's edge table, so a `take` naming another
 * node's edge activated that node's target and jumped everything in between — a human gate
 * included. Reproduced through the shipped binary on a graph that compiled `ok`: a router case
 * naming the GATE's outbound edge ran the guarded `fs.write` with no gate raised, exit 0.
 *
 * The executor refuses it now (`E_ROUTE_INVALID`), and this refuses it EARLIER, which is where a
 * graph defect belongs: the run never starts, so nothing has been spent when the author is told.
 * The same rule already existed for a human's `redirect` and for nothing else.
 */
function rule005RouterEdges(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  for (const n of spec.nodes) {
    if (n.router === undefined) continue;
    const outbound = (idx.outbound.get(n.id) ?? []).map((e) => String(e.id));
    const named = [
      ...(n.router.cases ?? []).flatMap((c) => (Array.isArray(c.take) ? c.take.map(String) : [])),
      ...(typeof n.router.fallbackEdge === "string" ? [n.router.fallbackEdge] : []),
    ];
    for (const id of [...new Set(named)]) {
      if (outbound.includes(id)) continue;
      d.push({
        severity: "error",
        code: "GRAPH005_ROUTE_NOT_OWN_EDGE",
        message: `router "${n.id}" names edge "${id}", which does not leave it`,
        at: { nodeId: n.id },
        fix:
          outbound.length === 0
            ? `node "${n.id}" has no outgoing edges — a router needs at least one`
            : `use one of ${outbound.map((e) => `"${e}"`).join(", ")}; routing along another node's edge would jump whatever sits between`,
      });
    }
  }
}

// ── GRAPH005 ─────────────────────────────────────────────────────────────────

function rule005Dataflow(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  const inputs = new Set(spec.inputs);
  // WHO WRITES EACH CHANNEL, once for the rule rather than per read. See the producer check below.
  const writersByChannel = new Map<string, NodeId[]>();
  for (const n of spec.nodes) {
    for (const w of n.writes ?? []) {
      const list = writersByChannel.get(w);
      if (list === undefined) writersByChannel.set(w, [n.id]);
      else list.push(n.id);
    }
  }
  // A fanout edge introduces its item channel into the target's scope.
  const fanoutItems = new Map<NodeId, Set<string>>();
  for (const e of spec.edges) {
    if (e.kind !== "fanout" || e.as === undefined) continue;
    // The binding is in scope for the whole BRANCH, not only for the fan-out target.
    // A node on the branch's error path reads the same `signal` the investigation did —
    // scoping the item to one node would make every realistic error handler warn.
    for (const id of [e.to, ...descendants(e.to, spec)]) {
      const set = fanoutItems.get(id) ?? new Set<string>();
      set.add(e.as);
      fanoutItems.set(id, set);
    }
  }

  for (const n of spec.nodes) {
    for (const w of n.writes ?? []) {
      if (errorProjectionSource(w) !== undefined) {
        d.push({
          severity: "error",
          code: "GRAPH005_ERROR_PROJECTION_WRITE",
          message: `node "${n.id}" writes "${w}", which is a node's reserved error projection — the runtime derives it from that node's outcome and no node may write it`,
          at: { nodeId: n.id, channel: w },
          fix: `remove "${w}" from node "${n.id}".writes; to carry a fact forward, write it to a declared channel`,
        });
        continue;
      }
      if (!Object.hasOwn(spec.channels, w)) {
        d.push({
          severity: "error",
          code: "GRAPH005_UNDECLARED_WRITE",
          message: `node "${n.id}" writes undeclared channel "${w}"`,
          at: { nodeId: n.id, channel: w },
          fix: `declare "${w}" under channels:`,
        });
      }
    }
    if (n.type === "router" && (n.writes ?? []).length > 0) {
      // A router's entire output is an edge subset. If it could also mutate, "why
      // did it go there?" would require replaying arbitrary code.
      d.push({
        severity: "error",
        code: "GRAPH005_ROUTER_WRITES",
        message: `router "${n.id}" declares writes; routers cannot write state`,
        at: { nodeId: n.id },
        fix: `move the write into a function node upstream of "${n.id}"`,
      });
    }

    // `mode: "model"` NAMES AN EXECUTOR THAT DOES NOT EXIST.
    //
    // `#runRouter` never reads `mode`; it evaluates `cases[].when` and takes the first
    // match. So a graph that says "a model picks the branch" ran as "a fixed expression
    // picks the branch" — with a model profile pinned in the resolution manifest that is
    // never called, which is the paperwork of a decision nobody made. Same rule as
    // `ApprovalSpec.mode`: the field exists so the graph asking for it is REFUSED, and
    // whoever builds the mode deletes this refusal in the change that adds the
    // enforcement.
    //
    // Placed here rather than in `checkStructure` on purpose: a fatal structural error
    // returns before GRAPH004 runs, and the author needs the expression diagnostics in the
    // same pass.
    if (n.router?.mode === "model") {
      d.push({
        severity: "error",
        code: "GRAPH005_ROUTER_MODE_UNSUPPORTED",
        message: `router "${n.id}" declares mode "model", which no executor implements — its \`when\` expressions would decide the branch instead`,
        at: { nodeId: n.id },
        fix: `use mode: expression and say the rule in \`when\`, or move the judgement into an agent node upstream of "${n.id}"`,
      });
    }

    const items = fanoutItems.get(n.id) ?? new Set<string>();
    for (const r of n.reads ?? []) {
      if (items.has(r)) continue;
      const source = errorProjectionSource(r);
      if (source !== undefined) {
        checkErrorProjectionRead(spec, idx, n, r, source, d);
        continue;
      }
      if (!Object.hasOwn(spec.channels, r)) {
        d.push({
          severity: "error",
          code: "GRAPH005_UNDECLARED_READ",
          message: `node "${n.id}" reads undeclared channel "${r}"`,
          at: { nodeId: n.id, channel: r },
        });
        continue;
      }
      if (inputs.has(r)) continue;
      // PRODUCER-BEFORE-CONSUMER OVER THE EDGES THE EXECUTOR TAKES (§A.84). This read
      // `idx.ancestors`, which does not walk a `loop` edge, so a loop-carried write was invisible:
      // `examples/graphs/harden-config.json` was told on every command that `audit` and `collate`
      // each "reads \"applied\", which no upstream node writes" about a channel its `fix` node
      // writes on every pass. `canPrecede` is the same question asked of the real edge set.
      //
      // OVER THE WRITERS OF THIS CHANNEL, not over every node. The first cut scanned all of
      // `idx.byId` per READ and asked `.writes.includes(r)` inside the loop, which is
      // O(nodes x reads x writes) and took `scale.test.ts`'s 500-node compile from 21 ms to 54 ms
      // for an answer the one-pass index below gives in the same breath.
      const producedUpstream = (writersByChannel.get(r) ?? []).some((a) => a !== n.id && canPrecede(idx, a, n.id));
      const producedBySelf = (n.writes ?? []).includes(r);
      if (!producedUpstream && !producedBySelf) {
        d.push({
          severity: "warning",
          code: "GRAPH005_UNPRODUCED_READ",
          message: `node "${n.id}" reads "${r}", which no upstream node writes and which is not a graph input`,
          at: { nodeId: n.id, channel: r },
          fix: `add "${r}" to inputs:, or have an upstream node write it`,
        });
      }
    }
  }
}

/**
 * A `reads` entry naming another node's reserved error projection (`"<nodeId>:error"`,
 * `DESIGN.md` D8) — every way it can be wrong, refused, because each is a read that could only
 * ever be empty or could carry what the graph did not mean it to.
 *
 * WHO MAY READ IT is a NAMED SET: a `function` body and an `evaluator{kind: "assertion"}` body,
 * the two executors that hand code a `StateView` and nothing else. An `agent` would put the
 * failure message into a prompt, a `human_gate` into a payload, a `tool` into an argument
 * template, a `router` into an expression — each a place this phase has not decided how an
 * untrusted fact should appear, so each is refused rather than served. Widening the set later is
 * additive; narrowing it after graphs depend on it would not be.
 *
 * WHOSE projection: any node of this graph but the reader, and only one that can run BEFORE the
 * reader on some path the executor takes (`canPrecede`, over `flowEdges`, which keeps `error`
 * edges). A projection of a node that can never have finished when the reader runs is always
 * absent — `ok` would never be readable at all, which is a graph bug, not a runtime condition.
 * Nor a node inside or downstream of a loop body (it has one outcome per pass, and the runtime
 * would not know which pass the reader means), nor one inside a fan-out the reader is not inside (its outcomes
 * live on branches the reader never sees).
 *
 * AND NOT a node that observes a `pii` or `secret_ref` channel, directly, through a projection
 * it reads in turn, or by handing it to a subgraph child in `subgraph.inputs`. A failure message can quote the
 * failing node's input, and the classification field that would carry that fact across is
 * RESERVED with no producer yet (§A.82) — so the only honest answer this phase has is to refuse
 * the hop the compiler can see. The laundered case, which only a run can see, is covered by the
 * engine treating every projection read as TAINTED (`taintedOn`), which earns the same floor.
 */
function checkErrorProjectionRead(
  spec: GraphSpec,
  idx: GraphIndex,
  reader: NodeSpec,
  name: string,
  source: NodeId,
  d: Diagnostic[],
): void {
  const at = { nodeId: reader.id, channel: name };
  const readerOk = reader.type === "function" || (reader.type === "evaluator" && reader.evaluator?.kind === "assertion");
  if (!readerOk) {
    d.push({
      severity: "error",
      code: "GRAPH005_ERROR_PROJECTION_READER",
      message: `node "${reader.id}" is a ${reader.type === "evaluator" ? `${String(reader.evaluator?.kind)} evaluator` : String(reader.type)} and reads "${name}"; a node's error projection is served to a \`function\` body or an \`evaluator{kind: "assertion"}\` body only`,
      at,
      fix: `read "${name}" in a function node on the error path, and have it write what the next node needs to a declared channel`,
    });
    return;
  }
  const from = idx.byId.get(source);
  if (from === undefined) {
    d.push({
      severity: "error",
      code: "GRAPH005_ERROR_PROJECTION_UNKNOWN_NODE",
      message: `node "${reader.id}" reads "${name}", but this graph has no node "${source}"`,
      at,
      fix: `name an existing node: ${spec.nodes.map((x) => `"${x.id}:error"`).slice(0, 5).join(", ")}`,
    });
    return;
  }
  if (source === reader.id || !canPrecede(idx, source, reader.id)) {
    d.push({
      severity: "error",
      code: "GRAPH005_ERROR_PROJECTION_UNORDERED",
      message:
        source === reader.id
          ? `node "${reader.id}" reads its own error projection "${name}", which cannot exist while it runs`
          : `node "${reader.id}" reads "${name}", but "${source}" cannot run before "${reader.id}" on any path — the projection would always be absent`,
      at,
      fix: `read it from a node downstream of "${source}" — typically the target of "${source}"'s \`error\` edge`,
    });
    return;
  }
  // ONE TASK PER BRANCH, OR REFUSED. The runtime serves the source's task on the reader's branch
  // (or an ancestor of it), deepest branch first, then highest iteration — and "highest
  // iteration" is only the RIGHT one when there is exactly one. A source inside a loop body
  // runs once per pass, so a reader in pass k+1 whose path skipped the source would be handed
  // pass k's outcome as if it were current. Serving the reader's own iteration is the fix that
  // would lift this, and it needs the iteration threaded into `viewFor`; until then, refused.
  //
  // "INSIDE" MEANS EVERY NODE THAT RUNS MORE THAN ONCE, not only the cycle's own members: a node
  // hanging off a loop body by a `seq` edge inherits the pass's iteration and runs once per pass
  // too (a reviewer drove one: a reader downstream of pass 0's FAILURE was served pass 2's
  // `ok: true`). So the source is refused when it is on a cycle or reachable from one.
  const onOrAfterLoop = idx.loopEdges.some((e) => {
    const cycle = nodesInCycle(idx, e.from, e.to);
    return cycle.has(source) || [...cycle].some((c) => canPrecede(idx, c, source));
  });
  if (onOrAfterLoop) {
    d.push({
      severity: "error",
      code: "GRAPH005_ERROR_PROJECTION_IN_LOOP",
      message: `node "${reader.id}" reads "${name}", but "${source}" is inside or downstream of a loop body and runs once per pass — this phase serves a projection only for a node that runs once per branch`,
      at,
      fix: `branch on "${source}" with \`codes\` on its error edge, or read the projection of a node outside the loop`,
    });
    return;
  }
  // AND ON THE READER'S BRANCH. A source inside a fan-out that the reader is not inside — the
  // reader sits after the join — has its tasks on child branches the reader's branch chain never
  // contains, so the projection would be absent on every run: a port nothing can exercise.
  // An ambiguous stack (two paths disagree about the enclosing fan-outs) is refused too.
  const sourceStack = idx.fanoutEdgeStack.get(source);
  const readerStack = idx.fanoutEdgeStack.get(reader.id);
  if (
    sourceStack === undefined ||
    readerStack === undefined ||
    sourceStack.length > readerStack.length ||
    sourceStack.some((edge, i) => readerStack[i] !== edge)
  ) {
    d.push({
      severity: "error",
      code: "GRAPH005_ERROR_PROJECTION_BRANCH",
      message: `node "${reader.id}" reads "${name}", but "${source}" is not on "${reader.id}"'s branch — it runs inside a fan-out "${reader.id}" is not inside (or the enclosing fan-outs are ambiguous), so the projection would never be there`,
      at,
      fix: `read "${name}" from a node inside the same fan-out branch as "${source}", and carry what it needs past the join in a declared channel`,
    });
    return;
  }
  // TRANSITIVELY: a source that itself reads another node's projection passes on whatever that
  // node could have seen, because a failure message can quote a failure message.
  const classified = classifiedVia(spec, idx, source, new Set<NodeId>());
  if (classified.length > 0) {
    d.push({
      severity: "error",
      code: "GRAPH005_ERROR_PROJECTION_CLASSIFIED",
      message: `node "${reader.id}" reads "${name}", but "${source}" observes ${classified.map((c) => `"${c}"`).join(", ")}, classified above \`out\`; its failure message could carry that value, and nothing would carry the classification with it`,
      at,
      fix: `branch on "${source}" with \`codes\` on its error edge instead of reading the projection, or move the classified read off "${source}"`,
    });
  }
}

/** The channels above `out` that `id` observes — through any error projection it reads, too. */
function classifiedVia(spec: GraphSpec, idx: GraphIndex, id: NodeId, seen: Set<NodeId>): string[] {
  if (seen.has(id)) return [];
  seen.add(id);
  const node = idx.byId.get(id);
  if (node === undefined) return [];
  // AND a delegated subgraph's inputs: `E_SUBGRAPH_FAILED` carries the child's message verbatim,
  // so a child quoting an input it was handed puts that input into this node's failure.
  const handed = Object.values(node.subgraph?.inputs ?? {}).filter((c): c is string => typeof c === "string");
  return [...observedChannels(node), ...handed].flatMap((c) => {
    const via = errorProjectionSource(c);
    if (via !== undefined) return classifiedVia(spec, idx, via, seen);
    const cls = spec.channels[c]?.classification;
    return cls !== undefined && CLASSIFICATION_POSTURE_FLOOR[cls] !== "out" ? [c] : [];
  });
}

// ── GRAPH006 ─────────────────────────────────────────────────────────────────

function rule006Cycles(spec: GraphSpec, idx: GraphIndex, channelTypes: Record<string, Ty>, d: Diagnostic[]): void {
  if (idx.topoOrder.length === 0 && spec.nodes.length > 0) {
    d.push({
      severity: "error",
      code: "GRAPH006_UNMARKED_CYCLE",
      message: "the forward graph contains a cycle; a back-edge must be declared kind: loop",
      fix: "change the back-edge's kind to `loop` and give it `until` and `maxIterations`",
    });
  }

  for (const e of idx.loopEdges) {
    // `undefined` and `<= 0` keep the code they have always had — three suites assert on it. What
    // used to sit beside this test is gone: `"3" < 1` and `NaN < 1` are both false, so a
    // `maxIterations` that was not a number at all passed here and needed a second, hand-written
    // type check one arm down. `EDGE_FIELDS` carries the type now and `edgeFieldTypes` refuses a
    // non-integer FATALLY in `checkStructure`, so by the time this rule runs the value is a safe
    // integer or absent, and a bare `< 1` is the whole of what is left to decide (§A.62).
    if (e.maxIterations === undefined || e.maxIterations < 1) {
      d.push({
        severity: "error",
        code: "GRAPH006_UNBOUNDED_LOOP",
        message: `loop edge "${e.id}" has no maxIterations`,
        at: { edgeId: e.id },
        fix: `add maxIterations to edge "${e.id}"`,
      });
    }
    if (e.until === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH006_NO_STOP_RULE",
        message: `loop edge "${e.id}" has no \`until\` stop rule`,
        at: { edgeId: e.id },
      });
      continue;
    }

    // A cycle whose stop condition no node inside it can change is a guaranteed
    // spin to maxIterations. Bounded, but never what the author meant.
    const r = checkExpr(e.until, channelTypes);
    if (!r.ok) continue; // already reported by GRAPH004
    const inCycle = nodesInCycle(idx, e.from, e.to);
    const writers = new Set<string>();
    for (const id of inCycle) for (const w of idx.byId.get(id)?.writes ?? []) writers.add(w);
    const canProgress = r.refs.some((ref) => writers.has(ref));
    if (!canProgress) {
      d.push({
        severity: "error",
        code: "GRAPH006_STUCK_LOOP",
        message:
          `loop edge "${e.id}" tests \`${e.until}\`, but no node inside the cycle ` +
          `(${[...inCycle].join(", ")}) writes any channel it reads`,
        at: { edgeId: e.id },
        fix: `have a node in the cycle write one of: ${r.refs.join(", ")}`,
      });
    }
  }
}

function nodesInCycle(idx: GraphIndex, from: NodeId, to: NodeId): Set<NodeId> {
  const out = new Set<NodeId>([from, to]);
  for (const [id, anc] of idx.ancestors) {
    if (anc.has(to) && (idx.ancestors.get(from)?.has(id) ?? false)) out.add(id);
  }
  return out;
}

// ── GRAPH007 ─────────────────────────────────────────────────────────────────

/**
 * A COUNT THAT CAME OUT OF A JSON FILE IS NOT A NUMBER UNTIL SOMETHING ASKS.
 *
 * IT IS NO LONGER THE EDGE FIELDS THAT ASK HERE. `maxWidth` and `maxIterations` used to be
 * checked by this predicate inside `rule007Fanout` and `rule006Cycles`, because `EDGE_FIELDS` was
 * a NAME allow-list and nothing between the JSON and the rule asked what type the value was:
 * `"24" > 25` is false, `"banana" > 25` is false because `NaN` compares false with everything, and
 * both sailed through. `EDGE_FIELDS` carries a type per field now and `edgeFieldTypes` enforces
 * it at the structural pass, so the two rules test a RANGE and nothing more (TODO §A.62).
 *
 * WHAT STILL ASKS, and why this survives: `policy.expansion`'s four bounds, whose scope has no
 * typed table (`POLICY_FIELDS.expansion` is still names only — the same row one level in), and
 * `countOr1` below, which protects arithmetic that can run on a spec no validator has seen.
 *
 * `>= 1` and not merely an integer, because these are bounds an author sets to limit something:
 * `0` is refused for the same reason a string is — `run/engine.ts`'s `items.slice(0, maxWidth)`
 * takes zero branches and the run ends `E_OUTPUT_MISSING` having dropped every shard without a
 * word — and a non-integer because the two readers disagree about it, `slice` truncating `2.5` to
 * 2 while the width product keeps the fraction.
 */
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

/**
 * The two edge counts are ALSO read by arithmetic that can run BEFORE any rule sees them —
 * `computeFanoutStacks` multiplies the widths inside `indexGraph`, and `multiplicityOf`
 * multiplies the loop bound. A `bigint` or a `symbol` there is a `TypeError` out of the middle
 * of the compiler, so the refusal never gets to be printed and the caller gets a crash where a
 * diagnostic belonged. Driven, on a spec built in memory (JSON cannot express either, but
 * `compile` and `validateGraph` are exported and take a `GraphSpec`):
 *
 *     maxWidth: 10n       -> TypeError: Cannot mix BigInt and other types
 *     maxWidth: Symbol()  -> TypeError: Cannot convert a Symbol value to a number
 *
 * `1` is the stand-in and it is safe BECAUSE the graph is refused anyway: an unreadable width is
 * `GRAPH007_BAD_MAX_WIDTH` and an unreadable bound `GRAPH006_BAD_MAX_ITERATIONS`, from
 * `edgeFieldTypes` now rather than from the two rules, so no decision downstream of this number
 * is ever taken on a graph that reached it.
 *
 * THIS IS NOT DEAD NOW THAT THE PARSE REFUSES THOSE VALUES, and the reason is the ORDER. `compile`
 * builds the index through a THUNK precisely so `checkStructure` runs first (see
 * `ValidationContext.index`), but `run/engine.ts` calls `indexGraph(graph.spec)` DIRECTLY, on a
 * graph that reached it through the public `Executor.attach()` — the precedent `#assertBound`
 * states for `EdgeKind`. On that path this is the only thing between a forged width and a throw.
 */
function countOr1(v: unknown): number {
  return isPositiveInt(v) ? v : 1;
}

/**
 * A value in a diagnostic, rendered without trusting it. `JSON.stringify` throws on a circular
 * object, on a `bigint`, and on any `toJSON` the caller wrote — and a guard that throws while
 * describing what it is refusing is worse than the thing it refuses.
 */
function describeValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol") return "a symbol";
  if (typeof v === "function") return "a function";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "object") return "an object";
  return String(v);
}

function rule007Fanout(spec: GraphSpec, expansion: ExpansionBudget, d: Diagnostic[]): void {
  for (const e of spec.edges) {
    if (e.kind !== "fanout") continue;
    if (e.over === undefined || e.as === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH007_FANOUT_INCOMPLETE",
        message: `fanout edge "${e.id}" needs both \`over\` and \`as\``,
        at: { edgeId: e.id },
      });
    }
    if (e.maxWidth === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH007_NO_MAX_WIDTH",
        message: `fanout edge "${e.id}" has no maxWidth; unbounded fan-out is never permitted`,
        at: { edgeId: e.id },
        fix: `add maxWidth (≤ ${expansion.maxFanout}) to edge "${e.id}"`,
      });
      continue;
    }
    // A WIDTH OF NOTHING, and nothing else: `items.slice(0, 0)` takes zero branches and the run
    // ends `E_OUTPUT_MISSING` having dropped every shard without a word. The hand-written type
    // check that used to stand here is gone — `EDGE_FIELDS` carries the type and
    // `edgeFieldTypes` refuses a non-integer FATALLY in `checkStructure` under this same code, so
    // what reaches this rule is a safe integer or absent and the bound is all that is left to
    // decide (§A.62).
    if (e.maxWidth < 1) {
      // THE SAME PRODUCER THE PARSE USES, not a second copy of the same sentence. This arm and
      // `edgeFieldTypes` raise one code with one wording for one field, and the two spellings had
      // already drifted on how the ceiling is fetched before they were merged into
      // `edgeFieldRefusal`. `expansion.maxFanout` here is the REAL one, out of `expansionOf`,
      // which is what `maxFanoutOf` reproduces on the earlier path.
      d.push(edgeFieldRefusal("maxWidth", e.id, e.kind, e.maxWidth, expansion.maxFanout));
    }
    // The ceiling test is a bare `>` and must not run on a value that coerces: `"99" > 25` is
    // false and `NaN > 25` is false, which is what the parse-time type check now makes
    // impossible. `else` rather than a second `if`, so one width draws one refusal.
    else if (e.maxWidth > expansion.maxFanout) {
      d.push({
        severity: "error",
        code: "GRAPH007_MAX_WIDTH_EXCEEDED",
        message: `fanout edge "${e.id}" declares maxWidth ${e.maxWidth}, over the graph's expansion.maxFanout of ${expansion.maxFanout}`,
        at: { edgeId: e.id },
      });
    }
    if (e.over !== undefined && !Object.hasOwn(spec.channels, e.over)) {
      d.push({
        severity: "error",
        code: "GRAPH007_UNKNOWN_OVER",
        message: `fanout edge "${e.id}" fans over undeclared channel "${e.over}"`,
        at: { edgeId: e.id, channel: e.over },
      });
    }
    // The per-branch item is a real channel: the StateView has to serve it and the
    // expression type-checker has to know its type.
    if (e.as !== undefined && !Object.hasOwn(spec.channels, e.as)) {
      d.push({
        severity: "error",
        code: "GRAPH007_UNKNOWN_ITEM",
        message: `fanout edge "${e.id}" binds items to undeclared channel "${e.as}"`,
        at: { edgeId: e.id, channel: e.as },
        fix: `declare "${e.as}" under channels: (it is branch-scoped, one value per branch)`,
      });
    }
  }
}

// ── GRAPH008 ─────────────────────────────────────────────────────────────────

function rule008Joins(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  for (const n of spec.nodes) {
    const join = n.join;
    if (join === undefined) continue;

    // `compensate` IS NOT WIRED TO THE EXECUTOR THAT NOW EXISTS.
    //
    // The refusal stands and the reason has narrowed. There IS a rollback executor now —
    // `Engine.#compensate`, driven by the journal, on run failure and on rewind — but nothing
    // routes a join's `onBranchError` into it, and a BRANCH failing is neither of those two
    // triggers. So the behaviour this refusal describes is unchanged: accepting the word would
    // still get the author `skip`. What would be dishonest now is the old reason, so the
    // message says "is not wired to it" rather than "does not exist".
    //
    // It was accepted and then treated as an exact synonym for `skip`, with no
    // diagnostic — so an author who asked for their failed branch to be rolled back got
    // it silently discarded instead, and the graph read as though somebody had thought
    // about the failure. A word that means something weaker than it says is worse than
    // not offering the word: the refusal and the enforcement belong in the same change,
    // and until there is an executor the honest answer is to refuse.
    if (join.onBranchError === "compensate") {
      d.push({
        severity: "error",
        code: "GRAPH008_COMPENSATE_UNIMPLEMENTED",
        message: `join "${n.id}" sets onBranchError: "compensate", but a join's branch failure is not wired to the rollback executor (which runs on run failure and on rewind) — it would behave exactly as "skip"`,
        at: { nodeId: n.id },
        fix: `set onBranchError: "skip" to accept partial evidence, or "fail" to stop the run`,
      });
    }
    // THE DEPTH THAT DECIDES WHICH INSTANCE OF THIS BARRIER A BRANCH BELONGS TO.
    //
    // `#maybeFireJoin` truncates an arriving branch coordinate to the join's compiled
    // fan-out depth to name the instance, and `#foldJoin` reads the same number to decide
    // whether to HOLD its fold or apply it. Both were written against this rule and the
    // rule did not exist: when the depth is ambiguous the runtime silently falls back to
    // "one level up from whoever arrived", which is the pre-fix expression — so two arms
    // at different depths mint two instances of one barrier and fold the same
    // contributions twice. Refusing here is what makes that fallback unreachable.
    const joinDepth = idx.fanoutDepth.get(n.id);
    const joinStack = idx.fanoutEdgeStack.get(n.id);
    if (joinDepth === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH008_JOIN_DEPTH",
        message: `join "${n.id}" is reachable at two different fan-out depths, so which instance of the barrier a branch belongs to is undecidable`,
        at: { nodeId: n.id },
        fix: `give the join one enclosing fan-out — split it into a join per depth, or route the shallower arm through the same fan-out as the others`,
      });
    } else {
      // Every arm must agree with the join and with each other. Arms sit either at the
      // join's own coordinate (a static join) or exactly one level deeper (a fan-out).
      for (const branch of join.branches) {
        const armDepth = idx.fanoutDepth.get(branch);
        if (armDepth === undefined) {
          d.push({
            severity: "error",
            code: "GRAPH008_JOIN_DEPTH",
            message: `branch "${branch}" of join "${n.id}" is reachable at two different fan-out depths`,
            at: { nodeId: n.id },
            fix: `give "${branch}" one enclosing fan-out`,
          });
        } else if (armDepth !== joinDepth && armDepth !== joinDepth + 1) {
          d.push({
            severity: "error",
            code: "GRAPH008_JOIN_DEPTH",
            message: `branch "${branch}" sits at fan-out depth ${String(armDepth)} but join "${n.id}" is at ${String(joinDepth)} — a join folds arms at its own depth or one deeper, never further`,
            at: { nodeId: n.id },
            fix: `join "${branch}" at its own level first, then feed that join into "${n.id}"`,
          });
        } else {
          // AND THE ARM MUST BE INSIDE THE JOIN'S OWN FAN-OUTS, not merely as deep as them —
          // §A.64, and the first time this rule reads `fanoutEdgeStack` instead of a number.
          //
          // IT SAYS NOTHING WHERE THE IDENTITY IS MISSING, and nothing about how many joins claim
          // the arm. `undefined` means the node is reachable through two fan-out edges of the same
          // width, which is a shape people AUTHOR — `test/run/empty-fanout-oversight.test.ts`
          // routes between two list-builders that each fan out into one shared body node, so
          // exactly one of the two edges ever fires — and refusing it was tried here and broke
          // that fixture. How many joins fold a node is a different question from which fan-out it
          // is in, it needs no stacks at all, and the pass at the end of this function answers it.
          //
          // IT IS NOT MADE UNREACHABLE by `computeFanoutStacks`'s agreement test, which does
          // force this prefix for an arm wired `kind: join`. `join.branches` is a NAME list and
          // `GRAPH008_BRANCH_NOT_CONNECTED` below asks only that SOME edge run from the arm to
          // the join; `loop` and `compensation` edges are excluded from the stack traversal, so
          // an arm connected by one of those contributes nothing to the join's own stack and can
          // carry any stack at all. That is the graph this arm was measured on.
          const armStack = idx.fanoutEdgeStack.get(branch);
          const wrongAt =
            armStack === undefined || joinStack === undefined ? -1 : joinStack.findIndex((id, i) => armStack[i] !== id);
          if (wrongAt >= 0) {
            d.push({
              severity: "error",
              code: "GRAPH008_JOIN_DEPTH",
              message: `branch "${branch}" of join "${n.id}" is inside fan-out "${String(armStack?.[wrongAt])}" where the join is inside "${String(joinStack?.[wrongAt])}" — the same depth in a different fan-out is a different instance space`,
              at: { nodeId: n.id },
              fix: `route "${branch}" through the fan-outs "${n.id}" is inside, or give it a join of its own inside its own fan-out`,
            });
          }
        }
      }
    }

    // A HELD JOIN'S FOLD HAS TO BE COLLECTED BY SOMETHING.
    //
    // A join inside a fan-out (`fanoutDepth > 0`) does NOT apply its fold to shared channel
    // state — doing so would make the result depend on which sibling committed first. It
    // returns the fold as its own Task's writes instead, so the ENCLOSING join folds the
    // siblings in branch order, and associativity makes the two-level fold equal the
    // one-level one.
    //
    // That argument has a premise nothing checked: an enclosing join must exist AND must
    // name this join among its `branches`. When it does not, the held fold is written to a
    // Task nobody reads and the run reports success having silently dropped every result
    // the inner barrier collected. It is invisible from the journal, because the inner join
    // really did succeed and really did write.
    //
    // THE `fix:` NAMES BOTH HALVES, and that is the F1 defect living in the rule next door.
    // It used to say only "add it to the enclosing join's `branches`". Typing exactly that
    // then produced `GRAPH008_BRANCH_NOT_CONNECTED` from the loop below — "no edge runs from X
    // to the join" — because a branch entry and a `kind: join` edge are two edits and the line
    // named one. Measured on `examples/graphs/triage-failures.json` plus an inner
    // `read --fanout(subs)--> sub --join--> subJoin`: three compiles to converge, and four when
    // the outer join is also incomplete so GRAPH021 is refusing in the same run. Both drop by
    // one here. This is the same shape §A.53 closed in GRAPH021, so it closes in its words: the
    // entry AND the edge, both, ADDED to whatever the join already declares.
    //
    // INNERMOST, because under double nesting "the fan-out X is inside" names two of them and only
    // one is right. A join two fan-outs deep collected by the OUTER barrier fails closed on
    // `GRAPH008_JOIN_DEPTH` — that barrier becomes reachable at two depths — while collecting it
    // with the inner one compiles. The adjective is the whole difference between a line that
    // converges and a line that costs another compile.
    //
    // THE ENCLOSING JOIN IS REFERRED TO AND NOT NAMED, AND WHICH ONE IT IS STILL IS NOT CHECKED.
    // Naming a candidate is what cost GRAPH021 four review rounds, so this line does not try. What
    // §A.64 settled is the neighbouring question — HOW MANY joins collect this fold, not which —
    // and the answer is exactly one, enforced by the pass at the end of this function.
    //
    // THE SIBLING FAN'S BARRIER IS NOT WRONG, which is the claim two earlier drafts of this
    // comment got backwards in opposite directions. One said the author's pick was validated
    // downstream (it was not); the next said handing a held join to a sibling fan's barrier was a
    // real gap. Measured on a real `Engine`, that graph folds every contribution EXACTLY ONCE
    // (n=8 against 8 succeeded writer tasks) and differs from the same-fan spelling only in fold
    // ORDER. So the author picking a different legal barrier is still their call, and the only
    // thing refused is picking two.
    if (joinDepth !== undefined && joinDepth > 0) {
      const collectedBy = spec.nodes.filter((o) => o.join?.branches.includes(n.id) === true);
      if (collectedBy.length === 0) {
        d.push({
          severity: "error",
          code: "GRAPH008_HELD_JOIN_UNCOLLECTED",
          message: `join "${n.id}" is inside a fan-out, so it HOLDS its fold for an enclosing join to collect — but no join declares "${n.id}" among its branches, so that fold is written to a task nobody reads`,
          at: { nodeId: n.id },
          fix:
            `give the enclosing join — the barrier of the INNERMOST fan-out "${n.id}" is inside, adding one ` +
            `if that fan-out has none — an entry in its \`branches\` for "${n.id}", and a \`kind: join\` edge from ` +
            `"${n.id}" into that join: a held join needs both, and the entry is ADDED to whatever the join ` +
            `already declares. Or move "${n.id}" outside the fan-out, so it applies its own fold`,
        });
      }
    }

    for (const branch of join.branches) {
      if (!idx.byId.has(branch)) {
        d.push({
          severity: "error",
          code: "GRAPH008_UNKNOWN_BRANCH",
          message: `join "${n.id}" waits on unknown node "${branch}"`,
          at: { nodeId: n.id },
        });
        continue;
      }
      const feeds = (idx.inbound.get(n.id) ?? []).some((e) => e.from === branch);
      if (!feeds) {
        d.push({
          severity: "error",
          code: "GRAPH008_BRANCH_NOT_CONNECTED",
          message: `join "${n.id}" waits on "${branch}", but no edge runs from "${branch}" to "${n.id}"`,
          at: { nodeId: n.id },
          fix: `add an edge ${branch} -> ${n.id} with kind: join`,
        });
      }
    }
    if (join.mode === "quorum") {
      if (join.k === undefined || join.k <= 0) {
        d.push({
          severity: "error",
          code: "GRAPH008_QUORUM_K",
          message: `join "${n.id}" uses mode quorum but declares no positive k`,
          at: { nodeId: n.id },
        });
      } else if (join.k > 1 && !Number.isInteger(join.k)) {
        d.push({
          severity: "error",
          code: "GRAPH008_QUORUM_K",
          message: `join "${n.id}" quorum k=${join.k} must be a fraction ≤ 1 or a whole count`,
          at: { nodeId: n.id },
        });
      }
    }

    // A JOIN CAN ONLY PROPAGATE WHAT ITS BRANCHES WROTE, and declaring otherwise compiled clean.
    //
    // `#foldJoin` folds each branch task's committed `writes` per channel and commits the result
    // at the join's own coordinate. It has no body and no transform, so a channel no branch wrote
    // is a channel the barrier cannot produce — whatever the node's `writes` says.
    //
    // Found by writing a graph. A `collect` join declared `writes: ["report"]` over branches that
    // write `reviews`; the compiler reported `ok` with no diagnostics, the fold produced nothing,
    // and the run either failed later with `E_OUTPUT_MISSING` — a message about the OUTPUT, three
    // nodes away from the mistake — or, when a downstream node happened to write the same channel
    // itself, SUCCEEDED with an empty report. The second is the plausible-wrong-answer shape this
    // system exists to refuse.
    //
    // A WARNING, by this file's own rule: an ERROR is for a declaration that SUBSTITUTES
    // semantics — `mode: "quorum"`, `onBudgetExhausted: "gate"` — where accepting it ships a graph
    // that reads as supervised and behaves otherwise. This one does nothing at all: the channel is
    // simply not written, and the harm lands downstream on whoever reads it.
    //
    // The severity was ERROR for one test run, and what changed it is worth keeping: SIX fixtures
    // in this repository carry the same declaration, each over branches writing a different
    // channel. A mistake the codebase makes six times in its own tests is one shipped graphs make
    // too, and turning it into a compile failure would break working graphs to report something
    // that was already inert in them. Warning tells the author at authoring time, which is the
    // whole gap — my own review graph compiled `ok`, folded nothing, and wrote an empty report.
    const produced = new Set<string>(
      join.branches.flatMap((b) => spec.nodes.find((x) => x.id === b)?.writes ?? []),
    );
    for (const channel of n.writes ?? []) {
      if (produced.has(channel)) continue;
      d.push({
        severity: "warning",
        code: "GRAPH008_JOIN_WRITES_UNPRODUCED",
        message:
          `join "${n.id}" declares it writes "${channel}", but none of its branches (${join.branches.join(", ")}) ` +
          `writes that channel — a barrier folds what its branches produced and cannot make anything new`,
        at: { nodeId: n.id, channel },
        fix:
          produced.size > 0
            ? `write ${[...produced].map((c) => `"${c}"`).join(" or ")}, or put a node AFTER the join to produce "${channel}"`
            : `its branches write nothing, so this join can only signal that they finished`,
      });
    }
  }

  // ONE ARM, ONE JOIN — the half of §A.64 with teeth, and a rule about NODES, not about stacks.
  //
  // THE FACT IT RESTS ON: `writesHeldForJoin(branch) = branch.segments.length > 0` (`run/engine.ts`).
  // Holding is a property of the TASK'S OWN DEPTH and of nothing else — not of its relation to any
  // join. `#immediateReduce` does not apply the writes of a Task inside a fan-out, and `#foldJoin`
  // applies the held writes of EVERY declared member at or under the join's own coordinate. So any
  // join that names a node with `fanoutDepth >= 1` folds that node's writes, whatever the join's
  // own depth is and whichever fan-out either of them sits in. Two joins naming it fold it twice,
  // and every non-idempotent reducer — `append_ordered`, `sum` — doubles in silence.
  //
  // THE "WHICHEVER FAN-OUT" HALF IS THE ONE THE TWO SENTENCES ABOVE DO NOT PROVE, and its
  // mechanism is one line over in `#maybeFireJoin`: the instance of the barrier an arrival belongs
  // to is `segments.slice(0, depth)` of the ARRIVING task's own coordinate, where `depth` is the
  // JOIN's compiled `fanoutDepth`. So a cross-fan arm does not fail to find its barrier — the
  // barrier is MINTED in the arriving arm's own fan, at the join's depth, and `#foldJoin` then
  // applies that arm's held writes there. That is why a sibling fan's barrier folds a held join
  // once and correctly (`test/graph/join-depth.test.ts`), and why two claimants fold twice
  // wherever they sit.
  //
  // THREE EARLIER SHAPES OF THIS CHECK EACH LEFT AN ESCAPE AT THEIR OWN SEAM, which is why it is
  // one rule now: a map keyed on the fan-out EDGE missed every graph whose stacks are ambiguous
  // (ambiguity propagates from the body to the joins below it); a second map keyed on the arm NODE
  // for the ambiguous case missed a pair of claimants with one of each kind; and the
  // `armDepth === joinDepth + 1` filter both of them shared missed a join at the arm's OWN depth,
  // which the predicate above shows folds it all the same.
  //
  // MEASURED ON A REAL ENGINE over an `append_ordered` channel, counting contributions against
  // succeeded writer tasks. Folded twice, all accepted before this rule: one arm under two root
  // joins (n=4, expected 2); an ambiguous body under two joins (8/4), including through a router
  // (4/2) and at two different depths (8/4); a pair of claimants one of whose stacks is known and
  // one of whose is not (6/4); and a join at the arm's own depth plus one above it (4/2). Folded
  // ONCE EACH, and all still accepted: the ordinary fan-out and join; one barrier over several
  // sibling fan-outs; a held join collected by its own fan's barrier AND by a sibling fan's; a
  // doubly-nested pair each collected by its innermost barrier; an ambiguous body with one join;
  // and a fan-out branch whose two nodes go to two DISJOINT joins.
  //
  // WHICH IS WHY DISJOINT ARMS ARE NOT REFUSED. An earlier cut counted barriers per fan-out and
  // refused a branch split across two joins; measured, it folds every contribution exactly once
  // and only the ORDER differs. Refusing a working graph to protect an ordering nobody declared is
  // the trade this rule does not make.
  const claimedBy = new Map<NodeId, NodeId[]>();
  for (const n of spec.nodes) {
    const join = n.join;
    if (join === undefined) continue;
    for (const branch of join.branches) {
      // `undefined` is an unknown node or one reachable at two depths — both already refused, and
      // adding a second diagnostic about them says nothing the first does not.
      const armDepth = idx.fanoutDepth.get(branch);
      if (armDepth === undefined || armDepth < 1) continue;
      const owners = claimedBy.get(branch) ?? [];
      if (!owners.includes(n.id)) owners.push(n.id);
      claimedBy.set(branch, owners);
    }
  }
  // THE EDGE THIS LINE NAMES HAS TO BE THE EDGE THAT IS THERE — §A.73, and the second time in two
  // waves that this file has paid for a `fix:` predicting a SIBLING `fix:` instead of the compiler
  // (§A.65's lesson). `join.branches` is a NAME list and `GRAPH008_BRANCH_NOT_CONNECTED` accepts an
  // inbound edge of ANY kind, so a claimer is wired one of three ways: by a `kind: join` edge, by an
  // edge of some other kind carrying its own semantics, or by nothing at all. This line used to
  // dictate deleting a `kind: join` edge in all three. Measured on the `eto` graph of
  // `docs/handoff-2026-09-15b.md`: the only edge from "read" into "again" is `back`, a `loop` with
  // its own `until` and `maxIterations`, and the line told the author to delete it. That is exactly
  // the additive lesson GRAPH021 paid for at §A.69, one rule over and one release later.
  //
  // ONE CLAUSE PER DROPPER, AND THAT IS THE WHOLE REASON THE ARM COUNT IS THREE. Bucketing the
  // droppers by shape and giving each bucket a sentence makes the STRING depend on which
  // combination of shapes the graph holds — seven for three buckets — and a byte pin covers exactly
  // one combination. Here no conditional reads more than one dropper, so composing them adds no
  // arm, and `kinds` is rendered by a list join that reads the same for one kind or several, so
  // there is no singular/plural arm either. The three are pinned byte-for-byte in
  // `test/graph/join-depth.test.ts`; NOTHING pinned this line before this change — the only copy in
  // the repository was a quotation in `docs/handoff-2026-09-15b.md`.
  // AND `kind` IS RENDERED, NEVER ECHOED. It is the only unvalidated string this line reaches for:
  // `GRAPH003_UNKNOWN_EDGE_KIND` is an ERROR but not FATAL, so `checkStructure` does not gate and
  // this rule runs on an edge whose `kind` is whatever the JSON said. Reproduced through the shipped
  // binary: a kind of `seq"\nok\n   fix: nothing to do here` printed a forged bare `ok` line AND a
  // forged `fix:` line inside the compiler's own output, and an OBJECT kind rendered
  // `[object Object]` — once per edge, because a `Set` over raw values dedupes nothing when every
  // value is a distinct object. Node ids cannot do this: `GRAPH003_BAD_ID` is fatal and its charset
  // is restricted. `describeValue` is what this file already uses for a value it does not trust, and
  // `compile.ts`'s own `GRAPH003_UNKNOWN_EDGE_KIND` quotes the kind for the same reason — so a known
  // kind reads `\`kind: "loop"\`` here, quoted, matching the refusal printed beside it.
  //
  // THE `kind: join` LITERAL A FEW LINES DOWN STAYS UNQUOTED, and the asymmetry is the point rather
  // than an oversight: that one is THIS FILE naming the kind the author should type, while the
  // quoted one is the author's own value echoed back. `compile.ts`'s `GRAPH003_UNKNOWN_EDGE_KIND`
  // draws the same line in the same words. Quoting the literal too would read as a spelling the
  // author must type and would break arm 1's byte-identity with the line `docs/handoff-2026-09-15b.md`
  // quotes, which is the only copy of it that predates any pin.
  //
  // THE DEDUPE MOVED WITH IT, onto the RENDERED string. What that bounds is the COUNT of distinct
  // renderings — two distinct objects both describe as "an object" and collapse to one — and NOT the
  // length: `describeValue` has no cap, so three distinct 400-character STRING kinds are echoed at
  // their own length and this clause is ~1500 characters. That is a §H.14 input, not a hole here.
  //
  // AND `JSON.stringify` DOES NOT ESCAPE U+2028 / U+2029. The result is still ONE line to a terminal
  // and to `grep`, which is what the forged-`ok` repro was about; a consumer splitting on Unicode
  // line terminators rather than on `\n` would see two.
  const dropClause = (branch: NodeId, o: NodeId): string => {
    const into = (idx.inbound.get(o) ?? []).filter((x) => x.from === branch);
    const kinds = [...new Set(into.map((x) => describeValue(x.kind)))];
    if (into.some((x) => x.kind === "join")) {
      return `"${o}" must drop it from \`branches\` and drop the \`kind: join\` edge from "${branch}"`;
    }
    if (kinds.length === 0) {
      // AND HERE THE TWO LINES WOULD OTHERWISE CONTRADICT EACH OTHER. `GRAPH008_BRANCH_NOT_CONNECTED`
      // makes exactly this test, so it is refusing the same entry in the same compile — and its
      // `fix:` says to ADD the edge. What this line adds is that the DROP answers that refusal as
      // well: `GRAPH008_BRANCH_NOT_CONNECTED` fires per `branches` ENTRY with no edge, so removing
      // the entry removes it. The author needs one edit, not one from each line.
      //
      // AND IT PROMISES NOTHING ABOUT ADDING THE EDGE, which the first cut of this row did and was
      // wrong about twice. "Adding it cements this refusal" holds only while the edit leaves the
      // forward graph acyclic: where `o` is `branch` itself, or upstream of it, the added edge makes
      // `topoSort` return `[]`, every `fanoutDepth` collapses to 0 and `claimedBy` counts nothing —
      // so the refusal is CLEARED, under a `GRAPH006_UNMARKED_CYCLE`. Both shapes are pinned in
      // `join-depth.test.ts`. A claim about the current graph needs no such reasoning to stay true,
      // which is why this clause makes one.
      // "EVERY SUCH ENTRY", because `branches` may name one node TWICE — nothing refuses that, and
      // `GRAPH008_BRANCH_NOT_CONNECTED` then fires once per occurrence while `claimedBy` dedupes by
      // node. Dropping one of two leaves the SIBLING refusal standing — measured: one
      // `GRAPH008_BRANCH_NOT_CONNECTED` plus this `GRAPH008_JOIN_DEPTH`, the second entry still
      // being there — so "the entry" was a count this line could not keep.
      return (
        `"${o}" must drop it from \`branches\` — the ENTRY alone, no edge running from "${branch}" into it at ` +
        `all; that missing edge is what \`GRAPH008_BRANCH_NOT_CONNECTED\` is refusing in this same compile, and ` +
        `dropping every such entry answers that refusal too`
      );
    }
    return (
      `"${o}" must drop it from \`branches\` — the ENTRY alone, no \`kind: join\` edge running from "${branch}" ` +
      `into it to drop; what runs there is ${kinds.map((k) => `\`kind: ${k}\``).join(", ")}, which carries its own meaning`
    );
  };
  for (const [branch, owners] of claimedBy) {
    if (owners.length < 2) continue;
    d.push({
      severity: "error",
      code: "GRAPH008_JOIN_DEPTH",
      message:
        `node "${branch}" is inside a fan-out, so it HOLDS its writes for ONE join to fold in branch order — but ` +
        `${String(owners.length)} joins (${owners.map((o) => `"${o}"`).join(", ")}) declare it among their branches, and each of them folds ` +
        `those same writes again`,
      at: { nodeId: branch },
      fix:
        `keep one join over "${branch}": ${owners.slice(1).map((o) => dropClause(branch, o)).join(", and ")}, ` +
        `and take "${owners[0]!}"'s result as an arm instead if it still needs those writes`,
    });
  }
}

// ── GRAPH021 ─────────────────────────────────────────────────────────────────

/**
 * Every fan-out must converge on a join.
 *
 * Without one, the branches' writes have no defined fold point: they would have to be
 * applied in arrival order, which is exactly the nondeterminism the branch-coordinate
 * fold exists to remove. Requiring the join makes "when do these merge?" a question
 * the author answers rather than one the scheduler answers by accident.
 *
 * THE RULE IS ABOUT THE BRANCH, NOT ABOUT THE FAN-OUT'S TARGET, and saying otherwise cost the
 * 2026-09-09 port a compile (F1 of `docs/workflow-port-2026-09-09.md`). This message used to
 * suggest `branches: [<the fan-out's target>]`; typing that on a branch two nodes long then
 * produced `GRAPH008_BRANCH_NOT_CONNECTED` about the edge, and the actual rule — *every node in
 * a fan-out branch needs its own entry in `join.branches` AND its own `kind: join` edge into the
 * join* — was the union of two `fix:` lines that neither stated. So the branch's contents are
 * read here, off `fanoutEdgeStack`, BEFORE a `branches:` list is suggested.
 *
 * `fanoutEdgeStack` and not `ancestors`: two sibling fan-outs off one node are indistinguishable
 * by reachability, and telling an author to fold the other fan's nodes into this one's join is
 * worse than telling them too little. Its `undefined` = AMBIGUOUS convention means an ambiguous
 * node is left off the list, so `e.to` is always included by hand — the one member the rule
 * cannot be wrong about.
 *
 * WHAT IS ACCEPTED DOES NOT MOVE — the refusal condition is byte-identical to the one this rule
 * shipped with, so no graph that compiled before fails now on account of it. What DID move is
 * every `fix:` line, including a branch of one's: an earlier version of this paragraph claimed
 * that case "still produces the sentence it always did", which was true of the MESSAGE and
 * false of the `fix:`, and a reviewer had to run both compilers side by side to find that out.
 * The message tail is the only part that varies with branch size: one member gets no
 * `; the branch it opens holds N nodes (…)` clause. That tail has two forms, chosen by whether the
 * count and the dictated list AGREE — the count is what the branch contains and the list is what a
 * barrier can be told to wait on.
 *
 * A NAME IS IN THE FIRST AND NOT THE SECOND FOR EXACTLY TWO REASONS, and the clause names which.
 * (1) It does not run into EVERY candidate join — "every", not "some": with two candidates a node
 * feeding only one of them is dropped precisely because the list has to be true whichever the
 * author picks. (2) A join OTHER than the one this line NAMES already folds it (§A.65). Holding is
 * a property of the task's own depth, so a second folder is what `GRAPH008_JOIN_DEPTH` refuses —
 * dictating such a name printed, on the next compile, an error the compile before it had not.
 * Reason (1) was always so and the sentence said so only from §A.57; reason (2) is stated per
 * name, with the folding join named, and the reason-(1)-only sentence is byte-identical to the
 * one §A.57 settled on.
 *
 * "OTHER THAN THE ONE THIS LINE NAMES" is exact and was wrong once. The first cut of §A.65 excluded
 * every CANDIDATE from reason (2), so with two candidates a member one of them already folds was
 * dictated to the other, and the line compiled for one of the two names it offered and was refused
 * for the other — breaking reason (1)'s own rationale. What a member's folders become after the
 * author picks barrier C is its existing folders PLUS C, so dictating it is safe exactly when its
 * only folder could be C: knowable with ONE candidate (it IS `named`, which is why the F1 shape's
 * sentence does not move), unknowable with two. The one exception is `e.to`, dictated whatever
 * folds it, because `joined` — the condition that fires this whole rule — is a CONJUNCTION: some
 * join declares `e.to` in `branches` AND is downstream of it. Both halves matter. A list without
 * `e.to` dictates an edit that does not clear the error, and a claimer satisfying only the first
 * half does not clear it either — which is the residue named at the guard below.
 *
 * THE DISAGREEING FORM PROMISES NO REFUSAL, which cost two review rounds. It first read "a join
 * must wait on every one of them — directly, or through another branch node that folds it", and
 * the load-bearing objection is that NOTHING REFUSES A BRANCH NODE LEFT UNFOLDED: an `error` arm
 * named in the clause compiles clean once the dictated names are wired. The removal stands on that
 * alone.
 *
 * The escape it offered was also incoherent, but only in the SINGLE-candidate arm, and the first
 * correction overstated that. With one candidate ancestry is transitive, so a node folded through
 * a branch member that reaches the candidate reaches the candidate itself and is in `waitsFor`
 * already — the escape cannot exist for exactly the nodes the clause names. With TWO it can:
 * `waitsFor` filters on reaching EVERY candidate, so a held node may reach one offered join
 * through a branch node and not the other, which makes the promise not false but UNCHECKABLE —
 * true or not depending on which join the author picks. Both readings argue for the same removal.
 *
 * So the form that names nodes states what the `fix:` line dictates and stops. The agreeing form
 * keeps the pre-existing sentence byte-identical; its "must" is older than this clause and is not
 * this rule's claim to make bigger.
 *
 * With two or more candidate joins the fix NAMES them and asks the author to choose. It used to
 * say "a join downstream of X" and leave the set implicit, which let a reader pick a join that
 * was itself in the list of things to wait for — a `kind: join` edge from that node to itself,
 * i.e. `GRAPH006_UNMARKED_CYCLE`. Naming the candidates is what makes the sentence unambiguous;
 * the clause about what they are not is for the reader who sees only the message.
 */
function rule021FanoutHasJoin(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  for (const e of spec.edges) {
    if (e.kind !== "fanout") continue;
    const joined = spec.nodes.some(
      (n) =>
        n.join !== undefined &&
        n.join.branches.includes(e.to) &&
        (idx.ancestors.get(n.id)?.has(e.to) ?? false),
    );
    if (joined) continue;

    // AT THIS FAN-OUT'S OWN LEVEL — the stack's LAST element, never mere membership. A node two
    // fan-outs deep carries the outer edge id in its stack too, so `includes` listed the inner
    // fan's nodes as the outer join's branches; typing that turned a graph that compiles into
    // `GRAPH008_JOIN_DEPTH`, because the outer barrier then became reachable at two depths. The
    // inner JOIN pops back to this level and is the node the outer join really does wait on.
    const atThisLevel = (n: NodeSpec): boolean => {
      if (n.id === e.to) return true;
      const stack = idx.fanoutEdgeStack.get(n.id);
      return stack !== undefined && stack.length > 0 && stack[stack.length - 1] === e.id;
    };

    const branch = spec.nodes.filter(atThisLevel).map((n) => n.id);
    const branchList = branch.join(", ");

    // A CANDIDATE BARRIER IS A JOIN AT THE LEVEL THIS FAN-OUT OPENS FROM — not merely one that
    // is reachable. Reachability was the root cause of both defects a reviewer found in the
    // first two cuts of this rule, and of two more they found in the third: a nested fan-out's
    // INNER join is reachable from the outer target, so naming it told the author to make it
    // the outer barrier (`GRAPH008_JOIN_DEPTH`, on a graph that otherwise compiles), and a join
    // wired in by a `seq` edge is reachable while sitting INSIDE the branch, so it was named as
    // its own barrier (`GRAPH006_UNMARKED_CYCLE`). Both are the same mistake: "reachable" and
    // "is the barrier for this level" are different questions.
    //
    // A barrier for this fan-out sits where the fan-out started — its own stack is `e.to`'s
    // stack with `e.id` popped. An ambiguous stack (`undefined`) names no level, so it names no
    // candidate either, and the message falls through to the un-dictating form below.
    const openedFrom = idx.fanoutEdgeStack.get(e.to);
    const parentStack = openedFrom === undefined ? undefined : openedFrom.slice(0, -1);
    const atBarrierLevel = (n: NodeSpec): boolean => {
      const s = idx.fanoutEdgeStack.get(n.id);
      return (
        parentStack !== undefined &&
        s !== undefined &&
        s.length === parentStack.length &&
        s.every((x, i) => x === parentStack[i])
      );
    };
    const candidates = spec.nodes.filter(
      (n) => n.join !== undefined && (idx.ancestors.get(n.id)?.has(e.to) ?? false) && atBarrierLevel(n),
    );

    // THE FIX IS ADDITIVE AND NEVER A WHOLE-LIST REPLACEMENT, and that is the fifth and last
    // lesson this message cost. Every earlier cut phrased it as `must declare branches: [X]`,
    // and four reviewers found four graphs where applying that literally DELETED something:
    // one join is often the barrier for more than one fan-out, so a list built from THIS
    // fan-out's branch drops the entries that belong to the other one. On a join collecting a
    // nested fan-out and a sibling fan-out it did not even converge — it oscillated between two
    // fixes, each re-breaking what the other repaired — and two GRAPH021s on one join printed
    // contradictory lists in a single run.
    //
    // Narrowing WHEN to dictate was tried three times and failed three times, each on a shape
    // the previous cut had not imagined. What is dictated is the thing to change: an entry per
    // branch member, added to whatever the join already declares, composes across fan-outs and
    // across diagnostics, and cannot delete. The compiler knows the branch; it does not know the
    // author's whole intent for a join, and it no longer pretends to.
    const named = candidates.length === 1 ? candidates[0]! : undefined;

    // WHAT A BARRIER WAITS FOR IS THE BRANCH MEMBERS UPSTREAM OF IT — of EVERY candidate, so
    // that the list is true whichever one the author picks. A branch node with no path to the
    // barrier (a second arm, an `error` handler) cannot take a `kind: join` edge into it
    // without changing the graph's shape, and a candidate join is not its own ancestor, so this
    // one predicate also keeps a join out of the list it is being offered as the barrier for.
    //
    // ONE PREDICATE FOR BOTH ARMS, and that is the point. The ancestor filter used to live only
    // in the single-candidate arm, so the multi-candidate sentence handed back the UNFILTERED
    // branch — and on a graph with a join sitting inside the branch, "pick one join downstream
    // of X" plus a list containing that join reproduced `GRAPH006_UNMARKED_CYCLE` exactly as
    // before. A filter that has to be remembered in two places is a filter that will be
    // remembered in one.
    //
    // It can never empty the list: every candidate is downstream of `e.to` by construction, so
    // `e.to` is an ancestor of all of them and always survives.
    const reachesEveryCandidate = (id: NodeId): boolean =>
      candidates.every((c) => idx.ancestors.get(c.id)?.has(id) ?? false);

    // AND A MEMBER SOME JOIN ALREADY FOLDS IS NOT DICTATED EITHER — §A.65. Holding is a property
    // of the TASK'S OWN DEPTH (`writesHeldForJoin` in `run/engine.ts`), so every join naming a
    // node inside a fan-out folds that node's writes, and `rule008`'s one-join rule (§A.64)
    // refuses a second folder. On `a53-pickone` the branch's own inner join `gather` already
    // declares `classify`; dictating `classify` for the barrier too gave it two folders, so
    // following this line printed a `GRAPH008_JOIN_DEPTH` the compile before it had not.
    //
    // `foldersOf` IS `claimedBy`, DELIBERATELY. The question this predicate answers is not "what
    // really folds at run time" — it is "what will `GRAPH008_JOIN_DEPTH` count if the author types
    // what we are about to dictate". So it makes the test that rule makes and no other: `branches`
    // membership, for a member whose `fanoutDepth` is at least 1, with NO reachability.
    //
    // AN EARLIER CUT ANSWERED THE OTHER QUESTION, and that is the whole of what was wrong with it.
    // It required the claiming join to be DOWNSTREAM (`idx.ancestors`), reasoning that an entry
    // naming a node the join cannot reach folds nothing. MEASURED, that reasoning is not wrong
    // about the executor: with both compile-time refusals neutralised, a join declaring a
    // fanned-out node it has no edge to folds that node's writes zero extra times — 2
    // contributions with it and 2 without. It is wrong about the COMPILER, which is the only thing
    // a `fix:` line has to predict: `claimedBy` counts that entry, so the author who types what we
    // dictated is refused. `idx.ancestors` also walks neither `loop` nor `compensation` edges, so
    // a folder joined to its member by one of those was invisible here and counted there. Both
    // shapes are pinned below, and the second one is why this is not merely conservative.
    const foldersOf = (id: NodeId): readonly NodeId[] => {
      const armDepth = idx.fanoutDepth.get(id);
      if (armDepth === undefined || armDepth < 1) return [];
      return spec.nodes.filter((j) => j.join !== undefined && j.join.branches.includes(id)).map((j) => j.id);
    };

    // A FOLDER THAT IS THE ONE JOIN WE NAME IS NOT AN OBSTACLE — and that distinction is the whole
    // of the multi-candidate case. After the author picks barrier C and adds the dictated names,
    // a member's folders become its existing ones PLUS C, so dictating it is safe exactly when its
    // only folder could be C. With ONE candidate that is knowable: `named` IS the barrier, so a
    // member it already declares stays on the list and the sentence is unchanged (the F1 shape
    // `examples/graphs/triage-failures.json` sits on, where `gather` already declares `classify`).
    // With TWO it is not: excluding BOTH candidates dictated a member one of them already folds,
    // and the graph then compiled for one choice and was refused for the other — the list has to
    // be true whichever the author picks, which is `reachesEveryCandidate`'s own rationale.
    //
    // `e.to` IS DICTATED WHATEVER FOLDS IT, and that is the guard the no-empty-list invariant now
    // rests on rather than on a reachability argument. `joined` — the condition that makes this
    // whole diagnostic fire — is a CONJUNCTION: some join declares `e.to` in `branches` AND is
    // downstream of it. Naming `e.to` for a CANDIDATE satisfies both, candidates being downstream
    // by construction, so a list that leaves `e.to` out dictates an edit that does not clear the
    // error it is attached to.
    //
    // THE RESIDUE, AND WHO NAMES IT — §A.69 moved the second half of this paragraph. A join
    // satisfying only the FIRST half — declares `e.to`, not downstream of it — leaves `joined`
    // false, so this diagnostic fires and dictates `e.to`, and the edit then produces
    // `GRAPH008_JOIN_DEPTH` on `e.to`. The author has to decide which join is the barrier; the
    // graph is broken twice over and the second break is the one this rule cannot dictate around.
    // WHAT IT CAN DO IS SAY SO, and since §A.69 the `fix:` line does: the `claimed` clause below
    // names every such claimer and the refusal that follows, in this compile. It used to depend on
    // the edge — `GRAPH008_BRANCH_NOT_CONNECTED` accepts an inbound edge of ANY kind while
    // `idx.ancestors` walks neither `loop` nor `compensation`, so a claimer with NO edge at all was
    // named there in the same compile and a claimer wired by one of those two was named by NOTHING.
    // The sibling code still fires where it always did; what changed is that the `loop` and
    // `compensation` case is no longer silent. Both shapes are pinned in
    // `fanout-branch-diagnostic.test.ts`.
    const foldedElsewhereThan = (id: NodeId): readonly NodeId[] =>
      id === e.to ? [] : foldersOf(id).filter((j) => j !== named?.id);

    const waitsFor = branch.filter((id) => reachesEveryCandidate(id) && foldedElsewhereThan(id).length === 0);

    // THE COUNT AND THE LIST ANSWER DIFFERENT QUESTIONS, so the message says which nodes the two
    // disagree about. `branch` is what the branch CONTAINS; `waitsFor` is what a barrier can be
    // told to wait ON, and the filter above drops any member that does not run into every
    // candidate. Both numbers were already correct and the sentence disclosed neither: on a graph
    // with a held inner join it read "holds 3 nodes (read, classify, subJoin)" and then dictated
    // "each of read, classify", leaving a reader no way to tell the omission from a bug.
    //
    // WHAT THE CLAUSE MAY NOT CLAIM, twice over. Not that the difference is collected by
    // something WHEN IT IS NOT: on the graph that motivated §A.57, NOTHING collects `subJoin` —
    // `GRAPH008_HELD_JOIN_UNCOLLECTED` is refusing it in the same run — so a blanket "already
    // folded by an inner join" would swap a silent omission for a false statement. The reason is
    // therefore stated PER NAME and only where `foldersOf` found the folder, which is checkable
    // rather than asserted: `subJoin` still reads "does not", and `classify` reads the join that
    // has it. And not that leaving one unfolded is refused: it is not. An `error` arm sitting in
    // `held` compiles clean once the dictated names are wired, so a clause naming it and saying a
    // join "must" wait on it promises a refusal this rule does not make.
    //
    // A NAME DROPPED FOR BOTH REASONS IS REPORTED UNDER THE FIRST — a reporting choice, not a fact
    // about the graph. Reason (1) is about SHAPE: a member with no path to the barrier would have
    // to gain one before it could be waited on, and drawing that path is not an edit this line
    // dictates. Reason (2) is repaired by editing a `branches` list. So (1) is the one that
    // survives the other being removed, and naming both would read as two independent obstacles
    // when clearing (2) alone still leaves the name undictated.
    const held = branch.filter((id) => !waitsFor.includes(id));
    const unreached = held.filter((id) => !reachesEveryCandidate(id));
    const foldedElsewhere = held.filter((id) => reachesEveryCandidate(id));
    const unreachedList = unreached.map((id) => `"${id}"`).join(", ");
    const foldedClauses = foldedElsewhere
      .map((id) => `"${id}" is already folded by ${foldedElsewhereThan(id).map((j) => `"${j}"`).join(", ")}`)
      .join(", and ");

    // THE PREFIX NAMES ONLY THE REASONS THIS GRAPH ACTUALLY USED, and the reason-1-only form is
    // byte-identical to the sentence §A.57 settled on — the divergence it discloses has not
    // changed, so its words do not either.
    const disclosure =
      foldedElsewhere.length === 0
        ? `the ones that run into every join it offers — ${unreachedList} ` +
          `${unreached.length > 1 ? "do" : "does"} not`
        : unreached.length === 0
          ? `the ones no other join already folds — ${foldedClauses}`
          : `the ones that run into every join it offers and that no other join already folds — ` +
            `${unreachedList} ${unreached.length > 1 ? "do" : "does"} not, and ${foldedClauses}`;

    // ONE NAME GETS A SINGULAR SENTENCE. Since §A.65 a one-name list is the COMMON case for the
    // multi-candidate arm — everything but `e.to` is usually already folded — and "for each of
    // read, plus a `kind: join` edge from each of them into it" reads as though a list were
    // elided. Only the list clauses move: the two-or-more wording is byte-identical, which is what
    // keeps the F1 / `triage-failures.json` and §A.57 sentences (two names each) where they are.
    const each = waitsFor.join(", ");
    const one = waitsFor.length === 1;
    const dictate =
      named !== undefined
        ? (one
            ? `give join "${named.id}" an entry in its \`branches\` for ${each}, and a \`kind: join\` edge from ` +
              `${each} into "${named.id}"`
            : `give join "${named.id}" an entry in its \`branches\` for each of ${each}, and a \`kind: join\` edge from ` +
              `each of them into "${named.id}"`) +
          ` — every node inside a fan-out branch needs both. ADD to whatever ` +
          `"${named.id}" already declares: one join can be the barrier for more than one fan-out`
        : candidates.length > 1
          ? `pick one of the joins ${candidates.map((c) => `"${c.id}"`).join(" or ")} — ` +
            (one
              ? `not the node below, which is what it waits FOR — and give it an entry in its \`branches\` for ` +
                `${each}, plus a \`kind: join\` edge from ${each} into it, added to whatever it already declares`
              : `not one of the nodes below, which are what it waits FOR — and give it an entry in its \`branches\` ` +
                `for each of ${each}, plus a \`kind: join\` edge from each of them into it, added to whatever it ` +
                `already declares`)
          : `add a join node downstream of "${e.to}", with an entry in its \`branches\` for every node you leave ` +
            `inside the branch and a \`kind: join\` edge from each — as drawn that is ${each}, and a join placed ` +
            `earlier shortens it`;

    // AND WHERE THE TARGET IS ALREADY CLAIMED, THE LINE SAYS SO — §A.69, and it is the one piece of
    // this rule's own residue it could always have disclosed. `e.to` is the single member dictated
    // despite being folded ELSEWHERE THAN THE NAMED BARRIER (the guard above), which makes it the
    // single such member `foldedClauses` cannot reach: every other name folded elsewhere AND
    // reaching every candidate is dropped from `waitsFor` and named there, with its folder. BOTH
    // qualifiers are load-bearing and a shorter sentence was false twice over. `foldedElsewhereThan`
    // excludes `named`, so a member the NAMED barrier alone folds stays in `waitsFor` and appears in
    // neither clause — the F1 / `triage-failures.json` shape, where `gather` already declares
    // `classify`. And `foldedElsewhere` is `held.filter(reachesEveryCandidate)`, so a member dropped
    // for BOTH reasons is reported under the first WITHOUT its folder, which the reporting-choice
    // paragraph above already states. Without this clause the author types
    // the dictated line and the NEXT compile is the first thing that mentions the other claimer — a
    // `GRAPH008_JOIN_DEPTH` on `e.to` the compile before it had not printed.
    //
    // THE PREDICTION IS EXACT, NOT A HEDGE, and that is why it names the code and not just the
    // join. `joined` is false here — that is what fired this diagnostic — so NO join both declares
    // `e.to` and is an `idx.ancestors` descendant of it, while every candidate IS such a descendant
    // by construction. So a claimer of `e.to` is never a candidate, hence never `named`, hence
    // still a claimer after the author picks ANY barrier; `claimedBy` then counts two and refuses.
    // `foldersOf` already makes `claimedBy`'s own test, so the two agree by construction.
    //
    // THE CLAUSE THEREFORE STATES A STATE, NOT A PROPHECY — "with the barrier declaring it too",
    // not "once". Where `e.to` already has TWO claimers, `GRAPH008_JOIN_DEPTH` is printed in this
    // same compile, and a sentence promising it only afterwards would be describing the output the
    // author is already looking at.
    //
    // IT DOES NOT SUPPRESS THAT REFUSAL, AND MUST NOT. Dropping `e.to` from the dictated list would
    // dictate an edit that does not clear the error it is attached to, and picking the barrier for
    // the author is the "name a candidate" mistake that cost this rule four review rounds. The
    // graph is broken twice over and only the author can say which join is the barrier. What moves
    // is WHEN they are told: this clause carries the second break into the FIRST compile, in the
    // diagnostic that dictates the edit, rather than leaving it to the compile after.
    //
    // IT REPLACES NO SIBLING DIAGNOSTIC. Where the claimer has no inbound edge at all,
    // `GRAPH008_BRANCH_NOT_CONNECTED` names the entry in the same output and still does; where it
    // is wired by a `loop` or `compensation` edge, that rule accepts an inbound edge of ANY kind
    // and stays silent, and this clause is then the only thing that names the claim. All three —
    // no edge, `loop`, `compensation` — are pinned in `fanout-branch-diagnostic.test.ts`, the last
    // of them by a fixture whose WHOLE diagnostic set is this one line, warnings included: a second
    // claimer would have brought `GRAPH008_JOIN_DEPTH` into the same compile and the fixture would
    // have demonstrated no silence at all.
    //
    // AND IT DICTATES NO EDGE DELETION, which the first cut got wrong. When this clause fires there
    // is provably NO `kind: join` edge from `e.to` to the claimer: such an edge would put `e.to` in
    // the claimer's `idx.ancestors` (which skips only `loop` and `compensation`), making `joined`
    // true and this diagnostic silent. So the edge the author would find there is either absent or
    // a `loop`/`compensation` edge carrying its own `until`/`maxIterations`, and "drop the entry
    // AND the edge" told them to delete a retry loop the refusal never asked about — measured on
    // the §A.69 graph, dropping the `branches` entry ALONE compiles. Dictating a deletion is what
    // the additive lesson above is about; this one dictates the entry and says so.
    // NO `named` FILTER, AND THAT IS THE PROOF ABOVE BEING TAKEN SERIOUSLY. `foldedElsewhereThan`
    // excludes `named` because a member the barrier itself folds is safe to dictate; here the same
    // exclusion would be dead code, since a claimer of `e.to` cannot be a candidate and `named` is
    // always a candidate. A filter that can never fire is a filter that hides the day the proof
    // stops holding — if `named` ever COULD claim `e.to`, `joined` would be true and this whole
    // diagnostic would be silent, so the honest spelling is no filter at all.
    // AND WHERE NO EDGE RUNS THERE AT ALL, THE TAIL WAS FALSE AND THE SIBLING LINE SAID THE
    // OPPOSITE — §A.73. "whatever edge runs there now carries its own meaning" is a statement about
    // an edge, and the paragraph above proves only that it is not a `kind: join` edge, NOT that one
    // exists: a claimer may be wired by `loop` or `compensation` (the shapes §A.69 measured) or by
    // NOTHING, and the third was asserted to be the first. Measured on the `eto` graph of
    // `docs/handoff-2026-09-15b.md` with its `loop` edge deleted, on `2b1698e8`: one compile printed
    // `GRAPH008_BRANCH_NOT_CONNECTED`'s "add an edge read -> again with kind: join" and this clause's
    // "drop the `branches` ENTRY from the other", opposite edits over the same absent edge.
    //
    // WHICH OF THE TWO LINES IS WRONG WAS DECIDED BY RUNNING BOTH, not by reading them. Following
    // the sibling ALONE — adding that one edge — compiles to `ok` in ONE compile; following this
    // clause leaves GRAPH021 still firing with the dictated half still owed. So the sibling's line
    // is not merely defensible there, it is the cheaper correct edit, and teaching it to hedge would
    // have been the wrong repair. Its edge also never cements a claim that was not already refused
    // in the same compile: `claimedBy` counts `branches` ENTRIES, so two claimers of `e.to` already
    // print `GRAPH008_JOIN_DEPTH` BEFORE any edge is added, and with one claimer the edge makes
    // `joined` true, silences this diagnostic, and leaves `claimedBy` counting one.
    //
    // SO THE SINGLE-CLAIMER ARM OFFERS THE SIBLING'S EDIT BY NAME, and the plural arm must not: with
    // two claimers `GRAPH008_JOIN_DEPTH` is already on screen and adding an edge removes no entry,
    // so the edge does not clear it. THAT REASONING IS WHY THE OFFER IS SINGULAR; it is NOT printed
    // anywhere, because it holds only while the edit leaves the graph acyclic — on a cycling shape
    // the collapse takes `claimedBy` with it and the refusal goes. An earlier cut printed it as
    // "cements `GRAPH008_JOIN_DEPTH`" and was wrong for exactly that reason. `unwired` is
    // `GRAPH008_BRANCH_NOT_CONNECTED`'s own test — the same `idx.inbound` scan, `from === e.to` —
    // so the clause naming it cannot name a diagnostic that is not in this compile.
    //
    // THE OFFER IS MADE ONLY WHERE THE EDIT CANNOT CREATE A CYCLE, and getting that wrong is what
    // the first cut of this row shipped. "Adding it silences THIS diagnostic" rests on `joined`
    // becoming true, which needs `e.to` in the CLAIMER's `idx.ancestors` AFTER the edit — and where
    // the claimer IS `e.to`, or is upstream of it, the added edge closes a cycle: `topoSort` returns
    // `[]`, every `ancestors` set empties, `joined` stays false and the diagnostic is still printed,
    // now under a `GRAPH006_UNMARKED_CYCLE`. MEASURED on both shapes — the self-claimer of §A.73's
    // NOTE, and a claimer two `seq` edges upstream of the fan-out's source. An unguarded offer turns
    // a false DESCRIPTION into a false INSTRUCTION, which is worse than the residue it came from.
    //
    // `wouldCycle` IS EXACT, AND THE PREMISE IS THE PLAIN ONE — written twice wrongly before this,
    // which is the whole reason it is spelled out. `topoSort` is ALL-OR-NOTHING: it returns its
    // order only when `out.length === ids.length` and `[]` otherwise, so there is no such thing as
    // "a node the order never emitted" while the order is non-empty. A non-empty `alsoClaim` needs
    // `fanoutDepth(e.to) >= 1`, which needs a non-empty `topoOrder`, which means THE WHOLE FORWARD
    // GRAPH IS ACYCLIC and `idx.ancestors` is complete.
    //
    // WHAT KEEPS THAT TRUE IS A FATAL ELSEWHERE, and it is the load-bearing part: `topoSort` counts
    // against `spec.nodes.length` WITH duplicates, so a duplicated id could balance the count over a
    // cycle and hand back a non-empty, wrong order. `GRAPH003_DUPLICATE_ID` sets `fatal`, and
    // `validateGraph` returns on `checkStructure` before this rule runs, so that graph never reaches
    // here. If duplicate ids ever stop being fatal, this predicate is the thing that breaks.
    //
    // AND THE COUPLING THAT KEEPS IT EXACT IS IN TWO OTHER FUNCTIONS: `dagEdges` and the `ancestors`
    // walk each exclude `loop` and `compensation` and nothing else, so "`ancestors(e.to)` has `j`"
    // and "a forward path runs j ⇝ e.to" are the same statement. That is why a claimer reachable
    // from `e.to` only through a `loop` edge still gets the offer, and correctly: adding the edge
    // there compiles. If either filter ever changes, this predicate stops being exact — SEVERAL
    // fixtures notice, and `AND IT DOES NOT OVER-REFUSE` is the one written for it. Both
    // `THE OFFER IS WITHHELD` fixtures stay green, which is why that one exists. (An earlier
    // spelling of this paragraph called it "the only one that fails" — a count nobody had run, and
    // the third time on this row that a corrected sentence was corrected into a different false
    // one. Re-measure before naming a number here.)
    //
    // AND THE COUNTERFACTUAL IS GATED IN EVERY ARM, not only in the offer — the repair the first two
    // cuts of this row both missed. "It is a `kind: join` edge from `e.to` INTO X that WOULD HAVE
    // MADE THIS DIAGNOSTIC NOT FIRE" is §A.69's sentence and it is the same counterfactual the offer
    // makes, so it is false on the same shapes: where X is `e.to` or upstream of it, that edge would
    // have produced a `GRAPH006_UNMARKED_CYCLE` and left this diagnostic exactly where it is.
    // Withholding the OFFER while still printing the CLAIM underneath it was a distinction with no
    // difference to an author. `safeCounterfactual` requires it of EVERY claimer, not merely of one,
    // because the plural spelling says "INTO one of them" and a reader takes that as any of them.
    //
    // WHAT REMAINS WHEN IT IS WITHHELD IS UNCONDITIONAL. "Drop the entry, and NOT any edge" is
    // advice about what to change and needs no counterfactual; "whatever edge runs there now carries
    // its own meaning" is about the edge that IS there; and the appendix is `GRAPH008_BRANCH_NOT_CONNECTED`'s
    // own test plus the fact that the dictated drop answers it. None of the three predicts an edit.
    //
    // TEN NON-EMPTY ARMS, EACH PINNED BYTE-FOR-BYTE in `fanout-branch-diagnostic.test.ts` — the
    // count rose from six when this gate was added, and it is listed there rather than argued here.
    // The bytes §A.69 settled are two of the ten and are unchanged: a message assembled from
    // conditionals has one string per combination of conditions, a byte pin covers exactly one of
    // them, and this file has now shipped a defect in an unpinned arm twice.
    const alsoClaim = foldersOf(e.to);
    const many = alsoClaim.length > 1;
    const hasEdgeFromTarget = (j: NodeId): boolean => (idx.inbound.get(j) ?? []).some((x) => x.from === e.to);
    const wouldCycle = (j: NodeId): boolean => j === e.to || (idx.ancestors.get(e.to)?.has(j) ?? false);
    const wired = alsoClaim.filter(hasEdgeFromTarget);
    const unwired = alsoClaim.filter((j) => !hasEdgeFromTarget(j));
    const safeCounterfactual = alsoClaim.every((j) => !wouldCycle(j));
    // A FUNCTION, SO IT IS NOT EVALUATED WITH NO CLAIMER. The two SINGULAR arms interpolate
    // `alsoClaim[0]!`, which is `undefined` when the list is empty — the string was discarded, but a
    // non-null assertion that is false is one refactor from printing the word "undefined".
    const decide = (): string =>
      !many && unwired.length === 1 && !wouldCycle(unwired[0]!)
        ? // "EVERY SUCH ENTRY" HERE TOO — `branches` may name one node twice and nothing refuses it,
          // so the singular was a count this arm could not keep any more than the other three could.
          `Decide which join is the barrier for "${e.to}": drop the \`branches\` ENTRY from "${alsoClaim[0]!}" — ` +
          `every such entry, there being NO edge from "${e.to}" into it to delete — or add the \`kind: join\` edge from ` +
          `"${e.to}" INTO "${alsoClaim[0]!}" that \`GRAPH008_BRANCH_NOT_CONNECTED\` asks for in this same compile, ` +
          `which makes "${alsoClaim[0]!}" wait on "${e.to}" and silences THIS diagnostic instead`
        : `Decide which join is the barrier for "${e.to}" and drop the ` +
          `\`branches\` ENTRY from the ${many ? "others" : "other"} — the entry alone, and NOT any edge` +
          (safeCounterfactual
            ? // THE DESTINATION IS STATED. The proof is about an edge from `e.to` INTO THE CLAIMER;
              // "an edge from `e.to`" alone is false the moment one runs from `e.to` to anything
              // else, e.g. the `kind: join` edge into the barrier this very line dictates.
              `: it is a \`kind: join\` edge from "${e.to}" INTO ${many ? "one of them" : `"${alsoClaim[0]!}"`} ` +
              `that would have made this diagnostic not fire`
            : "") +
          (wired.length > 0
            ? `, so whatever edge runs there now carries its own meaning and deleting it is a second change`
            : "") +
          (unwired.length > 0
            ? `. No edge runs from "${e.to}" into ${unwired.map((j) => `"${j}"`).join(", ")} at all — that is what ` +
              `\`GRAPH008_BRANCH_NOT_CONNECTED\` is refusing in this same compile, and dropping every such ` +
              `\`branches\` ENTRY answers that refusal too`
            : "");
    const claimed =
      alsoClaim.length === 0
        ? ""
        : `. NOTE "${e.to}" is this fan-out's own target, so it is dictated whatever already folds it — but ` +
          `${alsoClaim.map((j) => `"${j}"`).join(", ")} ` +
          `${many ? "already declare it among their" : "already declares it among its"} \`branches\`, so ` +
          // TWO CLAIMERS ALREADY HAVE THE REFUSAL ON SCREEN. `claimedBy` counts them without the
          // barrier, so promising it only "once the barrier declares it too" would describe the
          // output the author is already reading. One claimer is the genuinely future case.
          `${many ? "\`GRAPH008_JOIN_DEPTH\` ALREADY refuses" : "with the barrier declaring it too \`GRAPH008_JOIN_DEPTH\` refuses"} ` +
          `"${e.to}" as held by more than one join. ${decide()}`;
    const fix = dictate + claimed;

    d.push({
      severity: "error",
      code: "GRAPH021_FANOUT_WITHOUT_JOIN",
      message:
        `fanout edge "${e.id}" expands "${e.to}" but no downstream join waits on it` +
        // The count describes the BRANCH, never the dictated list — reporting the filtered list
        // here made "holds N nodes" change when an unrelated join was added elsewhere.
        (branch.length > 1
          ? held.length > 0
            ? `; the branch it opens holds ${branch.length} nodes (${branchList}), and the \`fix:\` line dictates ` +
              `${disclosure}, so ${held.length > 1 ? "they are" : "it is"} in this count and not in that list`
            : `; the branch it opens holds ${branch.length} nodes (${branchList}), and a join must wait on every one of them`
          : ""),
      at: { edgeId: e.id },
      fix,
    });
  }
}

// ── GRAPH009 + GRAPH018 ──────────────────────────────────────────────────────

function rule009And018Budgets(
  spec: GraphSpec,
  idx: GraphIndex,
  expansion: ExpansionBudget,
  d: Diagnostic[],
): void {
  const graphBudget = spec.policy?.budget?.costUsd;

  let worstCase = 0;
  let declaredTotal = 0;
  const unbudgeted: NodeId[] = [];

  for (const n of spec.nodes) {
    const instances = idx.multiplicity.get(n.id) ?? 1;
    worstCase += instances;
    const perNode = n.policy?.budget?.costUsd;
    if (perNode === undefined) {
      // Only model-spending node types can consume budget without declaring it.
      // An `assertion` evaluator is a plain function over channel state — no model
      // call, so no spend. Only a `rubric` evaluator can consume budget.
      const spends =
        n.type === "agent" ||
        n.type === "subgraph" ||
        (n.type === "evaluator" && n.evaluator?.kind === "rubric");
      if (spends) unbudgeted.push(n.id);
      continue;
    }
    declaredTotal += perNode * instances;
  }

  if (graphBudget !== undefined && declaredTotal > graphBudget + 1e-9) {
    d.push({
      severity: "error",
      code: "GRAPH009_BUDGET_OVERCOMMIT",
      message:
        `worst-case declared spend is $${declaredTotal.toFixed(2)} ` +
        `(Σ per-node budget × max instances) but the graph budget is $${graphBudget.toFixed(2)}`,
      fix: "lower a per-node budget, lower a fanout maxWidth, or raise policy.budget.costUsd",
    });
  }
  // THE WARNING USED TO FIRE ON THE SAFER GRAPH AND STAY SILENT ON THE DANGEROUS ONE, and its
  // message was false where it fired. Both halves come from the same missing distinction.
  //
  //   graph budget declared → `submit` takes `minDefined(caller, graph, deployment)`, so the run
  //   IS bounded and IS enforced. What is unproven is the ARITHMETIC: `declaredTotal` sums
  //   per-node budgets, an undeclared spender contributes 0, and so `GRAPH009_BUDGET_OVERCOMMIT`
  //   silently underestimates. That is worth saying. "the run budget cannot be proven" is not.
  //
  //   no graph budget → nothing in the spec bounds anything. `PolicyEngine.reserve` skips its
  //   check entirely when `runUsd` is undefined and `remainingUsd` returns Infinity, and
  //   `loom run` has no default. This is the shape that can spend without limit, and it produced
  //   NO diagnostic at all.
  //
  // Which made the cheapest way to silence the old warning `delete policy.budget` — strictly
  // worse, and rewarded. Covering the silent case is what removes that incentive.
  if (unbudgeted.length > 0) {
    d.push(
      graphBudget === undefined
        ? {
            severity: "warning",
            code: "GRAPH009_NO_BUDGET",
            message:
              `node(s) ${unbudgeted.join(", ")} can spend and nothing in this graph bounds them: ` +
              `no policy.budget.costUsd here and no per-node budget either, so the only ceiling is ` +
              `whatever the deployment supplies — and a deployment that supplies none does not stop`,
            fix: `add policy.budget.costUsd to the graph, or to ${unbudgeted[0]}`,
          }
        : {
            severity: "warning",
            code: "GRAPH009_UNBOUNDED_NODE",
            message:
              `node(s) ${unbudgeted.join(", ")} can spend but declare no budget, so the ` +
              `$${graphBudget.toFixed(2)} graph budget still caps the run while ` +
              `GRAPH009_BUDGET_OVERCOMMIT cannot see what these nodes contribute to it`,
            fix: `add policy.budget.costUsd to ${unbudgeted[0]}`,
          },
    );
  }
  if (worstCase > expansion.maxNodes) {
    d.push({
      severity: "warning",
      code: "GRAPH018_NODE_COUNT",
      message: `worst-case Task count is ${worstCase}, over expansion.maxNodes of ${expansion.maxNodes}`,
      fix: "lower a fanout maxWidth or a loop maxIterations",
    });
  }
}

// ── GRAPH010 ─────────────────────────────────────────────────────────────────

function rule010ConcurrentWriters(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  const writersOf = new Map<string, NodeId[]>();
  for (const n of spec.nodes) {
    for (const w of n.writes ?? []) {
      const list = writersOf.get(w) ?? [];
      list.push(n.id);
      writersOf.set(w, list);
    }
  }

  for (const [channel, writers] of writersOf) {
    const spec_ = spec.channels[channel];
    if (spec_ === undefined || MULTI_WRITER_SAFE.has(spec_.reduce)) continue;

    // A node behind a fan-out is concurrent WITH ITSELF: 25 branches of the same
    // node writing a `replace` channel is 25 racing writers, not one.
    for (const w of writers) {
      // parallelWidth, NOT multiplicity: loop iterations are sequential and do not race.
      const instances = idx.parallelWidth.get(w) ?? 1;
      // …UNLESS THE CHANNEL NEVER LEAVES THE BRANCH, in which case there is one writer per
      // branch and no fold across them that anybody reads. See `branchLocalChannel`.
      if (instances > 1 && !branchLocalChannel(spec, idx, channel, w)) {
        d.push({
          severity: "error",
          code: "GRAPH010_CONCURRENT_WRITE",
          message:
            `node "${w}" runs up to ${instances} times in parallel and writes "${channel}", ` +
            `whose reducer \`${spec_.reduce}\` is not multi-writer safe`,
          at: { nodeId: w, channel },
          fix: `change channel "${channel}" to reduce: append_ordered (or another commutative reducer)`,
        });
      }
    }

    for (let i = 0; i < writers.length; i++) {
      for (let j = i + 1; j < writers.length; j++) {
        const a = writers[i]!;
        const b = writers[j]!;
        // ORDERED ON EVERY PASS, WHICH IS DOMINANCE AND NOT REACHABILITY (§A.84).
        //
        // `idx.ancestors` does not walk a `loop` edge, so two nodes joined only through a
        // back-edge looked unordered and the canonical loop graph was REFUSED — `nodes "parse"
        // and "fix" can run concurrently` about a graph where every path to `fix` goes through
        // `audit`. That is the defect this arm exists to fix.
        //
        // THE FIRST FIX FOR IT WAS WRONG AND IS WORTH THE SPACE. It asked whether SOME path
        // ordered the pair (a cut-cycle reachability relation), and a reason to be silent has to
        // hold on EVERY pass. On `start -> summarize`, `start -> scan -> fix`, `fix -loop->
        // summarize` that relation ordered `summarize` after `fix` — true from pass two — while
        // the executor ran `["start","scan","summarize","fix"]`, both in pass ONE, both writing
        // one `replace` channel, and GRAPH010 said nothing. It was also declaration-order
        // dependent: 527 of 8,000 permutation-fuzz seeds changed their GRAPH010 set.
        //
        // Dominance has neither fault — every path from an entry to `b` passes through `a`, which
        // is a property of the graph and not of a traversal. `computeDominators` states the whole
        // argument.
        //
        // AND `canPrecede`'s RELATION MUST NOT APPEAR HERE, for the case this rule exists for: a
        // fan-out INSIDE a loop body puts two genuinely concurrent nodes in the same cycle, so
        // "they go round together" would exempt exactly the pair that races. The producer question
        // wants that relation and the concurrency question must not have it — which is why
        // `GraphIndex` carries the two separately.
        //
        // `idx.ancestors` STAYS IN THE UNION, so this arm can only ever be quieter than the code
        // that shipped before §A.84 and no graph that compiled then starts being refused now.
        const related =
          (idx.ancestors.get(a)?.has(b) ?? false) ||
          (idx.ancestors.get(b)?.has(a) ?? false) ||
          idx.dominators.dominates(a, b) ||
          idx.dominators.dominates(b, a);
        if (related) continue; // sequential — last write is well-defined
        // A compensation node is DECLARED to run only after its target failed, so the two
        // are ordered even though `ancestors` deliberately excludes compensation edges (a
        // rollback must not become an entry node or inherit a layout rank). Today the
        // declaration is the whole of it: nothing traverses a compensation edge, so a node
        // reached ONLY that way never runs and the pair cannot overlap for a second reason.
        if (compensationOrdered(spec, idx, a, b)) continue;
        // Different arms of one router cannot both run: a router takes exactly one
        // case. Without this, every branch-and-merge graph is unbuildable — the author
        // is pushed into a per-arm channel per arm, which is worse modelling forced by
        // an over-approximation.
        if (routerExclusive(spec, idx, a, b)) continue;
        d.push({
          severity: "error",
          code: "GRAPH010_CONCURRENT_WRITE",
          message:
            `nodes "${a}" and "${b}" can run concurrently and both write "${channel}", ` +
            `whose reducer \`${spec_.reduce}\` is not multi-writer safe`,
          at: { channel },
          fix: `change channel "${channel}" to a multi-writer-safe reducer, or sequence "${a}" and "${b}"`,
        });
      }
    }
  }
}


/**
 * Does anything OTHER than these sites name `channel` anywhere in the spec?
 *
 * THE CENSUS IS INVERTED, AND THAT IS THE WHOLE DESIGN. `branchLocalChannel` has to prove a
 * NEGATIVE — that nothing outside one fan-out branch can read this channel — and an enumeration
 * of the places a channel name may appear proves nothing the moment the schema grows a place
 * nobody added to the list. The first version of this was that enumeration, keyed off
 * `NODE_FIELDS`/`EDGE_FIELDS`/`SPEC_FIELDS`/`ALLOWED_FIELDS`, and a reviewer found the hole it
 * was built to prevent: `NESTED_FIELDS` exists precisely because those four lists walk straight
 * past four more scopes, and a channel-naming key inside any of them would have left the
 * exemption ON with an uncovered site.
 *
 * So instead: remove the sites that ARE allowed, serialise everything else, and look for the
 * name. Total over any field the schema ever grows, by construction. Its failure mode is
 * over-reporting — a node id, a description, a resource ref or an unrelated string spelled like
 * the channel counts as a mention — and over-reporting REFUSES, which is the direction a
 * loosening guard is allowed to be wrong in.
 *
 * `channels` is deleted rather than searched: a channel's own DECLARATION is not a read of it,
 * and no `ChannelSpec` field names another channel (`identityKey` and `contextProjection.fields`
 * are field names inside the value).
 *
 * THE ONE WAY A NAME CAN HIDE, named rather than hand-waved: `JSON.stringify` honours `toJSON`,
 * so an object that serialises to something other than its own fields would not show them here.
 * Every spec the product loads is `JSON.parse` output — from a file, from HTTP, from the journal
 * — and a spec built in code that lied this way would already hash (`digest(spec)`) as something
 * other than what it presents. A channel NAME cannot hide: `SAFE_ID` is `[A-Za-z0-9._-]`, which
 * `JSON.stringify` emits verbatim, so there is no escaping to slip through.
 */
function namedElsewhere(spec: GraphSpec, channel: string, writer: NodeId, readers: ReadonlySet<NodeId>): boolean {
  const rest = {
    ...spec,
    channels: {},
    nodes: spec.nodes.map((n) => {
      if (n.id === writer) return { ...n, writes: (n.writes ?? []).filter((c) => c !== channel) };
      if (readers.has(n.id)) return { ...n, reads: (n.reads ?? []).filter((c) => c !== channel) };
      return n;
    }),
  };
  let text: string;
  try {
    text = JSON.stringify(rest) ?? "";
  } catch {
    return true; // a spec this cannot serialise is a spec it cannot census.
  }
  return new RegExp(`(?<![A-Za-z0-9_$])${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$])`).test(text);
}

/**
 * Is `channel` written and read entirely inside ONE fan-out branch, so that `replace` never folds
 * across branches for anything that reads it?
 *
 * THIS FUNCTION LOOSENS A GUARD, so every answer it cannot prove is `false`. What it proves, and
 * what the runtime gives it — measured, and pinned by `test/run/branch-local-replace.test.ts`:
 *
 *   - `Engine.#withBranchWrites` folds only the tasks at EXACTLY the asking task's branch path,
 *     with the same reducer the join uses. A reader at the writer's own coordinate, reached only
 *     through the writer, therefore sees the writer's own `replace` value and no sibling's.
 *   - It deliberately does NOT fold an ANCESTOR's held write. A reader one fan-out deeper reads
 *     `null`, so "inside the subtree" is not enough — the fan-out stack must be EQUAL.
 *   - `#foldJoin` folds every channel a member wrote, not only the join's declared `writes`, so
 *     the channel DOES reach shared state at the join — as the last branch in branch-coordinate
 *     order. Deterministic, and meaningless. Nothing may read it after the join.
 *
 * NOT CLAIMED, and it is a real reader of this channel: a node reached by an `error` edge from
 * the writer runs precisely when the writer FAILED, and `#withBranchWrites` folds only tasks in
 * state `succeeded` — so it reads whatever ROOT state holds. It is accepted rather than refused
 * because W6 constrains the covering join's whole INBOUND EDGE LIST — one `join` edge per branch
 * member and nothing else — which is the set every entrance to that barrier is derived from.
 * THIS SENTENCE USED TO SAY "the barrier cannot fire while such a reader is pending" as though
 * that followed from `mode: "all"`, and it did not: four reviewers found four different ways to
 * fire it early, three of them after this docstring first claimed otherwise. What makes the
 * claim safe is the closure at W6, not the mode; each of the four has its pasted reproduction
 * there. It is still not "sees the writer's own value".
 *
 * The two-writer arm of GRAPH010 is NOT relaxed and must not be: two writers inside one branch
 * fold by `compareContribution`'s `nodeId` tiebreak, which is arbitrary for `replace` in exactly
 * the way the rule exists to refuse. A second writer anywhere refuses here too.
 */
function branchLocalChannel(spec: GraphSpec, idx: GraphIndex, channel: string, writer: NodeId): boolean {
  if (spec.channels[channel] === undefined) return false;

  // W1 — exactly one enclosing fan-out, unambiguously.
  const stack = idx.fanoutEdgeStack.get(writer);
  if (stack === undefined || stack.length !== 1) return false;
  const fanId = stack[0]!;
  const fan = idx.edgeById.get(fanId);
  //
  // W2 — THE WRITER IS THE FAN-OUT'S OWN TARGET, and this is the clause that carries the
  // ordering argument. `idx.ancestors` answers "there EXISTS a path w → r", not "EVERY path to r
  // goes through w" — and a node with a second inbound edge that skips the writer is readied by
  // whichever arm arrives first (`#activate` emits `task.ready` per inbound edge and `upsertTask`
  // merges into the existing record), so it can run BEFORE the writer and read a stale value.
  // With `w === fan.to`, that cannot happen: every node whose fan-out stack is `[fanId]` either
  // IS the fan-out's target or inherited that stack from a node that is, and an inbound edge from
  // outside the branch would make the two candidate stacks disagree and the node ambiguous. So
  // reachable-from-w and dominated-by-w coincide, and `ancestors` is enough.
  //
  // A writer partway down the branch is therefore refused for want of a DOMINANCE computation,
  // not because such a graph is unsafe. Widening this to "w dominates every reader within the
  // subtree" is the obvious next step and is left undone deliberately.
  if (fan === undefined || fan.kind !== "fanout" || fan.to !== writer) return false;

  // The subtree: every node this fan-out encloses, at any depth.
  const subtree = new Set<NodeId>();
  for (const n of spec.nodes) {
    const s = idx.fanoutEdgeStack.get(n.id);
    if (s !== undefined && s.length >= 1 && s[0] === fanId) subtree.add(n.id);
  }
  if (!subtree.has(writer)) return false;

  for (const id of subtree) {
    const n = idx.byId.get(id);
    if (n === undefined) return false;
    // W3 — a `join` inside the branch pops a level and its fold leaves the branch; a `router`
    // turns one static subtree into a set of possible ones; a `subgraph` resolves its `inputs`
    // against the WHOLE scope and its child is a spec this walk cannot see.
    if (n.type === "join" || n.type === "router" || n.type === "subgraph") return false;
    // W4 — `retry` is refused for a weaker reason than the loop below, and it is written down
    // rather than dressed up: a retry re-uses the Task's own id (`task.retry_scheduled` carries
    // `w.task.taskId`), so the projection holds one record and one contribution, and the shape is
    // very likely safe. It is refused because this analysis does not track which attempt commits,
    // and a loosening does not get the benefit of "very likely".
    //
    // THIS WALKS `S`, WHICH LEAVES THE JOIN AND THE FAN-OUT PLANNER OUT — by construction, not by
    // oversight, and both are safe for the same one-line reason. `#retryDecision`'s exit `return`s
    // BEFORE `#activate`, so a retried planner never plans the fan a second time, and a retried
    // join re-runs `#foldJoin` only after its barrier has already fired — after every reader in
    // this branch has run.
    //
    // AND THE DEFAULTED POLICY COUNTS, not only the declared one. `compile.ts`'s `effectiveRetry`
    // gives a node that declared none `DEFAULT_PROVIDER_RETRY` when it reaches a provider and
    // `DEFAULT_SUBGRAPH_RETRY` when it re-enters a child — so reading `n.retry` alone refused an
    // author who wrote `maxAttempts: 2` while accepting an `agent` node that retries three times.
    // The types are named here rather than `reachesProvider` re-implemented: this is a SUPERSET
    // of it (`agent`, and `evaluator` of any kind rather than `rubric` only), so it cannot drift
    // into being narrower than the thing it stands in for. `subgraph` is refused above.
    if (n.retry !== undefined || n.type === "agent" || n.type === "evaluator") return false;
  }
  // W3, second half — a nested fan-out under this one. Measured: its nodes read `null`.
  for (const e of spec.edges) if (e.kind === "fanout" && subtree.has(e.from)) return false;

  // W4, THE LOOP CLAUSE, AND IT ASKS THE REACHABILITY QUESTION DIRECTLY.
  //
  // It used to delegate to `multiplicity !== parallelWidth`, and that was the wrong set.
  // `applyLoopFactors` calls a node "in the cycle" only when it is `loop.to`, `loop.from`, or
  // both a descendant of the one and an ancestor of the other — so a fan-out hanging off a node
  // inside the loop body but NOT on the path back to `loop.from` gets no factor at all. Measured
  // on `top --fanout--> A --> m1 --> B`, joined, with `top --> tick --loop--> top` beside it:
  // `multiplicity(A) === parallelWidth(A) === 4`, the graph compiled with zero diagnostics, and
  // `B` read another pass's `mid` — pass 1's reader saw pass 2's write, and WHICH pass depended
  // on how many nodes the branch had. `childBranch` carries no iteration, so every pass re-fires
  // the fan onto the SAME coordinates and `#withBranchWrites` folds them all.
  //
  // So: refuse if any node of the branch is reachable from any loop edge's target. That also
  // subsumes a `loop` edge INTO the writer, which `ins` filters out of the stack computation and
  // which `maxIterations: 1` would have hidden from the multiplicity test.
  //
  // WHAT `ancestors` DOES NOT WALK, said exactly, because it was once written down loosely as
  // "this covers compensation and error edges". It walks `dagEdges`, which excludes `loop` AND
  // `compensation` (see `indexGraph`). Error edges ARE in it, so an error-path node reachable
  // from a `loop.to` is caught. Compensation is not, and needs no clause: nothing traverses a
  // compensation edge — `Engine.#edgesToTake` has `case "compensation": break;` — so a node
  // reached only that way never runs, and cannot re-enter this branch. That is a fact about the
  // executor, not a gap this predicate is tolerating.
  for (const loop of idx.loopEdges) {
    for (const id of subtree) {
      if (id === loop.to || (idx.ancestors.get(id)?.has(loop.to) ?? false)) return false;
    }
  }

  // W6 — THE COVERING JOIN'S INBOUND EDGE LIST IS EXACTLY ONE `join` EDGE PER BRANCH MEMBER,
  // AND ITS `mode` IS `"all"`.
  //
  // READ THIS CLAUSE'S HISTORY BEFORE CHANGING IT. Four reviewers in a row each found a
  // DIFFERENT way to fire the barrier early, and the first three fixes each closed one entrance
  // by name — `mode`, then `branches` membership, then `Engine.#fireEmptyJoin`. That was the
  // wrong shape of fix three times over, because it keyed a compile-time guard on an enumeration
  // of ENGINE METHODS: a list the validator cannot see, that nothing keeps in step with the
  // engine, and that is not closed. The fourth entrance was `#activate`'s ordinary arm.
  //
  // THE ENTRANCE SET IS THE JOIN NODE'S INBOUND EDGE LIST, not a list of engine methods, and
  // THAT the validator can see. So constraining the inbound list closes the set by construction,
  // and the earlier clauses fall out of it rather than needing their own patch.
  //
  // THE CLAIM, STATED AT THE WIDTH IT HOLDS: every entrance that can CREATE a join Task is
  // derived from an edge whose `to` is that join. NOT "every `task.ready`" — three of the seven
  // sites below are not edge-derived at all, and an earlier draft of this sentence said
  // otherwise. Two of those three can only re-ready a Task that already exists, and the third
  // cannot reach a join this clause covers.
  //
  // NAMED RATHER THAN ASSERTED, because "this is total" is the claim that failed four times.
  // `run/engine.ts` emits `type: "task.ready"` at exactly SEVEN sites, and here is each one
  // against a covering join:
  //
  //   `#activate`, generic arm       one per INBOUND edge of any kind — the fourth entrance,
  //                                  and the reason this clause is keyed where it is
  //   `#activate`, join arm          reached only through an OUTBOUND `join` edge, into
  //                                  `#maybeFireJoin`
  //   `#maybeFireJoin`               same, and the only one that tests quiescence
  //   `#fireEmptyJoin`               walks the empty fan-out target's OUTBOUND `join` edges
  //   `#branchReady`                 `e.to` of a `fanout` edge — refused here as an inbound
  //                                  edge that is not `kind: "join"`, and by W3 besides
  //   `submit`                       `graph.entryNodes`, `edgesIn: []` — NOT edge-derived. It
  //                                  cannot reach a covering join, and the reason is THIS
  //                                  clause: `inbound.length === subtree.size` and `subtree`
  //                                  always holds the writer, so the join has at least one
  //                                  non-loop inbound edge, and `hasNonLoopIn` excludes exactly
  //                                  those from `entryNodes`
  //   `rewind`                       NOT edge-derived: re-arms stranded tasks under their own
  //                                  `task.taskId` and `edgesIn`, so it re-runs a Task that
  //                                  already existed and cannot create one
  //   `retry`                        NOT edge-derived, and the same argument — `w.task.taskId`
  //                                  again. It also `return`s before `#activate`, so a retried
  //                                  fan-out planner does not re-plan the fan
  //
  // Four are edge-derived and constrained here; `#branchReady` is edge-derived and refused; two
  // re-arm an existing Task and one cannot reach this join. If an eighth site appears, or one of
  // these learns to CREATE a join Task with no edge, this clause is false again and the
  // exemption has to go back to refusing.
  //
  // WHAT THE FOURTH ENTRANCE LOOKED LIKE. `#activate`'s generic arm mints, for a `seq` or
  // `conditional` edge into the join node at the ROOT coordinate, the SAME TaskId
  // `#maybeFireJoin` would — with no quiescence, membership or mode test — and `#maybeFireJoin`
  // then stands down because `p.tasks[joinTaskId] !== undefined`. Nothing refused a
  // non-`join`-kind edge into a join node: `GRAPH008_BRANCH_NOT_CONNECTED` matches on `e.from`
  // only and a `seq` edge satisfies it. Measured, on this file's own accept-case graph plus one
  // node (`seed -seq-> d0`, `d0 -seq-> gather`) and one extra hop in the branch:
  //
  //     COMPILE: ok, ZERO diagnostics
  //     run status : succeeded
  //     readers saw: [{"myShard":"a","rawItSees":"raw-a"},{"myShard":"b","rawItSees":"raw-d"},…]
  //
  // Branch `b` read branch `d`'s value, and whether it did depended on the hop count — the same
  // tell the membership entrance had. The SHIPPED `examples/graphs/triage-failures.json` plus
  // `plan -seq-> note -seq-> gather` stayed exempt, and with a `human_gate` in the branch the
  // window is a person's response time rather than milliseconds.
  //
  // THE OTHER THREE, kept because each is a distinct pasted reproduction and the inbound rule
  // subsumes rather than replaces them:
  //
  //   MODE. Under `any`, `quorum` or `firstSuccess` the barrier fires on evidence already in
  //   hand and applies its CROSS-BRANCH fold to root state while siblings still run — a
  //   short-circuiting join cancels nothing. Measured: `mode: "any"`, writer throwing on item 1,
  //   an error-path reader in branch 1 read branch 0's value.
  //
  //   MEMBERSHIP. Quiescence under `mode: "all"` is computed ENTIRELY from `join.branches` —
  //   `#maybeFireJoin` builds `members` from it and both `stillLive` and `continuesInBranch` ask
  //   `reachesMember` — so a branch node the join does not declare never holds the barrier.
  //   Measured on `read --error--> h0 --> h1 --> handler`: branch `b`'s handler read branch
  //   `c`'s value. This is now the "one edge per member" half: an undeclared branch node's edge
  //   into the join has a `from` that is not a member, and a member with no edge is
  //   `GRAPH008_BRANCH_NOT_CONNECTED`.
  //
  //   A SECOND FAN-OUT INTO THE SAME JOIN. `#fireEmptyJoin` has no quiescence test at all: for a
  //   fan-out that materialised no branches it readies every join naming that fan-out's target.
  //   Measured, only the sibling's input changing: `others = ["x"] → failures: [...4 entries]`
  //   versus `others = [] → failures: undefined` — the join folded before any member committed
  //   and the run said `succeeded`. This is now the "`from` is a member of THIS branch" half.
  //
  // WHY ALL OF IT MATTERS: `#withBranchWrites` returns the projection UNTOUCHED when the asking
  // branch has held nothing — a writer that failed, that returned `{writes:{}}`, or that a
  // `preNode` hook skipped — so its reader falls through to ROOT channel state. That is safe
  // only while root state still holds the pre-fan-out value, which is the same for every branch.
  //
  // A `human_gate` IN THE BRANCH is accepted and is the shape that most tests this clause: it is
  // in `CAN_SUSPEND`, so it holds its branch open for as long as a person takes. W6 is the only
  // thing that makes an unbounded human pause safe rather than merely slow.
  //
  // The join is invisible to every clause above: a `join` edge pops a level, so a join is never
  // in `subtree`. It has to be found through its own declaration.
  let covered = false;
  for (const n of spec.nodes) {
    if (n.type !== "join") continue;
    const branches = n.join?.branches;
    if (!Array.isArray(branches) || !branches.some((b) => subtree.has(b))) continue;
    if (n.join?.mode !== "all") return false;

    // `branches` is EXACTLY this branch — nothing else may be waited on here.
    const declared = new Set<NodeId>(branches);
    if (declared.size !== subtree.size) return false;
    for (const id of subtree) if (!declared.has(id)) return false;

    // AND THE ENTRANCE SET: one `join` edge per member, and nothing else at all.
    const inbound = idx.inbound.get(n.id) ?? [];
    if (inbound.length !== subtree.size) return false;
    const seen = new Set<NodeId>();
    for (const e of inbound) {
      if (e.kind !== "join") return false;
      if (!subtree.has(e.from)) return false;
      if (seen.has(e.from)) return false;
      seen.add(e.from);
    }
    covered = true;
  }
  // No join declares this branch at all: `GRAPH021_FANOUT_WITHOUT_JOIN` refuses such a graph, and
  // this refuses the exemption rather than relying on another rule having run.
  if (!covered) return false;

  const atThisFan = (id: NodeId): boolean => {
    const s = idx.fanoutEdgeStack.get(id);
    return s !== undefined && s.length === 1 && s[0] === fanId;
  };

  // W5 — this writer is the only writer, every declared reader is in the branch and downstream of
  // it, and nothing else in the whole spec names the channel at all.
  const readers = new Set<NodeId>();
  for (const n of spec.nodes) {
    if ((n.writes ?? []).includes(channel) && n.id !== writer) return false;
    if (!(n.reads ?? []).includes(channel)) continue;
    if (!atThisFan(n.id)) return false;
    if (!(idx.ancestors.get(n.id)?.has(writer) ?? false)) return false;
    readers.add(n.id);
  }
  // LAST, because it serialises the spec: everything above is cheap and refuses most graphs.
  return !namedElsewhere(spec, channel, writer, readers);
}

/** Nodes reachable from `from` over forward edges. */
function descendants(from: NodeId, spec: GraphSpec): NodeId[] {
  const out = new Set<NodeId>();
  const stack: NodeId[] = [from];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const e of spec.edges) {
      if (e.from !== id || e.kind === "loop" || out.has(e.to)) continue;
      out.add(e.to);
      stack.push(e.to);
    }
  }
  out.delete(from);
  return [...out];
}

/** True when one of the two nodes exists only to undo work the other did. */
function compensationOrdered(spec: GraphSpec, idx: GraphIndex, a: NodeId, b: NodeId): boolean {
  const ordered = (comp: NodeId, target: NodeId): boolean =>
    spec.edges.some(
      (e) =>
        e.kind === "compensation" &&
        e.to === comp &&
        (e.compensates === target || (idx.ancestors.get(comp)?.has(target) ?? false) || e.from === target),
    );
  return ordered(a, b) || ordered(b, a);
}

/**
 * The router arm a node sits on, if any.
 *
 * Walks back through single-inbound chains — including error and compensation edges, so
 * a rollback inherits the arm of the action it undoes. Returns `undefined` at any node
 * with two or more ways in, because then the node is a merge point and no single arm
 * dominates it. Deliberately conservative: it never *adds* exclusivity it cannot prove.
 */
function armOf(spec: GraphSpec, node: NodeId): { router: NodeId; edge: EdgeId } | undefined {
  const seen = new Set<NodeId>();
  let current = node;
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const inbound = spec.edges.filter((e) => e.to === current && e.kind !== "loop");
    if (inbound.length !== 1) return undefined;
    const edge = inbound[0]!;
    const from = spec.nodes.find((x) => x.id === edge.from);
    if (from?.type === "router") return { router: from.id, edge: edge.id };
    current = edge.from;
  }
}

function routerExclusive(spec: GraphSpec, _idx: GraphIndex, a: NodeId, b: NodeId): boolean {
  const armA = armOf(spec, a);
  const armB = armOf(spec, b);
  if (armA === undefined || armB === undefined || armA.router !== armB.router) return false;
  if (armA.edge === armB.edge) return false;
  const router = spec.nodes.find((x) => x.id === armA.router)?.router;
  if (router === undefined) return false;
  // Two edges in the SAME case fire together; two edges in different cases never do.
  return !router.cases.some((c) => c.take.includes(armA.edge) && c.take.includes(armB.edge));
}

// ── GRAPH011 + GRAPH012 ──────────────────────────────────────────────────────

/**
 * A `tool` node must name a tool this deployment HAS.
 *
 * `fs.raed` compiled `ok`. The run then reached the node, RAISED A GATE — a human was asked to
 * authorize a tool that does not exist — and failed `E_TOOL_NOT_FOUND` only after the approval.
 * Asking a person to vouch for something nobody can name is worse than failing.
 *
 * A WARNING, NOT AN ERROR, and the distinction is the same one `classFloor` already draws: the
 * `tools` map is what THIS process registered, and a graph is legitimately compiled against a
 * partial map — `loom compile` without `--allow-exec` sees no `proc.exec`, and that must remain
 * a capability diagnostic rather than a spurious "no such tool". An operator who sees this on a
 * graph they know is fine has learned something real: this process could not run it.
 */
function checkToolNames(
  spec: GraphSpec,
  tools: Readonly<Record<string, ToolManifestLite>>,
  d: Diagnostic[],
): void {
  const known = Object.keys(tools);
  if (known.length === 0) return; // No manifest map at all: nothing to check against.
  for (const n of spec.nodes) {
    const name = n.tool?.name;
    if (name === undefined || Object.hasOwn(tools, name)) continue;
    // The nearest known name, so a typo reads as a typo.
    const near = known.filter((k) => k.split(".")[0] === name.split(".")[0]);
    d.push({
      severity: "warning",
      code: "GRAPH013_UNKNOWN_TOOL",
      message: `node "${n.id}" names tool "${name}", which this process has not registered`,
      at: { nodeId: n.id },
      fix:
        near.length > 0
          ? `did you mean ${near.map((k) => `"${k}"`).join(" or ")}?`
          : `register it, or check the name against ${known.slice(0, 6).map((k) => `"${k}"`).join(", ")}`,
    });
  }
}

function rule011And012ErrorPaths(
  spec: GraphSpec,
  idx: GraphIndex,
  tools: Readonly<Record<string, ToolManifestLite>>,
  d: Diagnostic[],
): void {
  for (const n of spec.nodes) {
    // Reachable, not named: an agent whose model may call an irreversible tool needs an
    // error edge just as much as a tool node that names one.
    const manifest = reachableToolNames(n)
      .map((name) => tools[name])
      .find((m) => m !== undefined && isHardToUndo(m.irreversibility));
    if (manifest === undefined || n.unhandled === true) continue;

    const hasErrorEdge = (idx.outbound.get(n.id) ?? []).some((e) => e.kind === "error");
    if (!hasErrorEdge) {
      d.push({
        severity: "warning",
        code: "GRAPH011_UNHANDLED_IRREVERSIBLE",
        message: `node "${n.id}" calls ${manifest.irreversibility} tool "${manifest.name}" but has no error edge`,
        at: { nodeId: n.id },
        fix: `add an edge from "${n.id}" with kind: error, or set unhandled: true to accept run failure`,
      });
    }
  }

  for (const e of spec.edges) {
    if (e.kind !== "compensation") continue;
    if (e.compensates === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH012_NO_COMPENSATES",
        message: `compensation edge "${e.id}" does not name the node it compensates`,
        at: { edgeId: e.id },
      });
      continue;
    }
    const source = idx.byId.get(e.compensates);
    // Reachable, not named — GRAPH011 already warns that an agent node reaching an
    // irreversible tool needs an error edge, so refusing to let a compensation edge
    // target that same node would leave the two rules disagreeing about what an agent is.
    const manifest =
      source === undefined
        ? undefined
        : // THE HARDEST-TO-UNDO REACHABLE TOOL, not the first one that happens to be
          // registered. Taking the first made the verdict depend on the ORDER an author
          // wrote `agent.tools`: the same graph compiled clean or errored depending on
          // whether the read-only tool was listed before the irreversible one. The rule
          // is about whether this node can do something that needs undoing, and that is
          // a `max`, exactly as the posture floor next door is.
          reachableToolNames(source)
            .map((name) => tools[name])
            .filter((m): m is ToolManifestLite => m !== undefined)
            .sort(
              (a, b) =>
                postureRank(CLASS_DEFAULT_POSTURE[b.irreversibility]) -
                postureRank(CLASS_DEFAULT_POSTURE[a.irreversibility]),
            )[0];
    if (manifest === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH012_NOT_COMPENSATABLE",
        message: `compensation edge "${e.id}" compensates "${e.compensates}", which is not a tool node`,
        at: { edgeId: e.id },
      });
      continue;
    }
    if (manifest.compensation === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH012_NOT_COMPENSATABLE",
        message: `tool "${manifest.name}" declares no compensation, so "${e.compensates}" cannot be rolled back`,
        at: { edgeId: e.id },
        fix: `remove edge "${e.id}", or declare a compensation on tool "${manifest.name}"`,
      });
      continue;
    }

    // A DECLARED COMPENSATION MUST NAME A TOOL THAT EXISTS.
    //
    // THE NAME IS NOW DISPATCHED, not merely inspected, and this check got stronger rather
    // than weaker for it. It used to be that the only runtime effect of a declared
    // compensation was to REMOVE a refusal — `Engine.rewind` would not cross an
    // uncompensated irreversible effect and decided that by asking whether the field was
    // present — so `compensation: {tool: "noop"}`, or a name with a typo in it, bought a
    // legal rewind that undid nothing.
    //
    // `Engine.#compensate` now looks the name up in the registry and runs it. An
    // unregistered name no longer buys a silent pass — `run/compensation.ts` blocks the step
    // `unknown_compensation` and it is journaled
    // `compensation.recorded{outcome: "not_attempted", reason: "…is not registered"}` — but
    // it still buys a rewind that undoes nothing, because a step with no undo to dispatch is
    // not something a rewind can refuse on. It is now LOUD rather than silent, which is a
    // smaller claim than "prevented", and catching it at COMPILE is what actually prevents
    // it. The alternative is learning at rollback time that the undo does not exist, which
    // is the worst available moment. Presence is still not a promise; a registered tool is
    // still the least this can check.
    const undo = tools[manifest.compensation.tool];
    if (undo === undefined) {
      d.push({
        severity: "error",
        code: "GRAPH012_COMPENSATION_UNKNOWN",
        message: `tool "${manifest.name}" names compensation "${manifest.compensation.tool}", which is not a registered tool`,
        at: { edgeId: e.id },
        fix: `register "${manifest.compensation.tool}", or correct the compensation on tool "${manifest.name}"`,
      });
      continue;
    }

    // An undo that is itself hard to undo is a second irreversible action, not a
    // rollback. It may still be the right answer — refunding a charge is externally
    // visible and is exactly what you want — so this is a warning that says a human
    // should be in the loop, not a refusal.
    if (isHardToUndo(undo.irreversibility)) {
      d.push({
        severity: "warning",
        code: "GRAPH012_COMPENSATION_VISIBLE",
        message: `compensation "${undo.name}" for "${manifest.name}" is itself ${undo.irreversibility}: undoing is a second visible action, not a restoration`,
        at: { edgeId: e.id },
        fix: `keep it if that is intended — a refund is externally visible by nature — but gate the compensating node`,
      });
    }
  }
}

// ── GRAPH013 ─────────────────────────────────────────────────────────────────

function rule013Reducers(spec: GraphSpec, d: Diagnostic[]): void {
  for (const [name, channel] of Object.entries(spec.channels)) {
    if (channel.reduce === "last_write_wins_by_ts") {
      d.push({
        severity: "warning",
        code: "GRAPH013_CLOCK_DEPENDENT",
        message: `channel "${name}" uses last_write_wins_by_ts, which makes replay depend on recorded clocks`,
        at: { channel: name },
        fix: `prefer append_ordered or merge_object if the merge does not truly need time`,
      });
    }
  }
}

// ── GRAPH014 + GRAPH019: oversight ───────────────────────────────────────────

function rule014And019Oversight(
  spec: GraphSpec,
  idx: GraphIndex,
  ctx: ValidationContext,
  expansion: ExpansionBudget,
  d: Diagnostic[],
): void {
  const systemFloor = ctx.systemPostureFloor ?? "out";
  const graphPosture = spec.policy?.posture ?? "out";

  for (const n of spec.nodes) {
    const declared = n.policy?.posture;

    // The floor a node's own nature asserts, before any declaration. `max` over every
    // tool the node can REACH: an agent node names none, so keying on `n.tool` floored
    // every agent at `out` regardless of what its model could call.
    //
    // THROUGH A SUBGRAPH TOO — see `reachableToolNamesThrough`. A `subgraph` node names no tool
    // either, so it was floored at `out` however irreversible its child was, and the human was
    // asked at the innermost call inside the child rather than before the child started.
    const classFloor: Posture =
      n.type === "human_gate"
        ? "in"
        : maxPosture(
            "out",
            // An unknown name contributes nothing, exactly as before — see the matching
            // comment in `compile.ts`.
            ...reachableToolNamesThrough(n, (ref) => ctx.resolver.subgraph?.(ref), expansion.maxDepth, ctx.toolReachMemo).flatMap(
              (name) => {
                const m = ctx.tools[name];
                return m === undefined ? [] : [CLASS_DEFAULT_POSTURE[m.irreversibility]];
              },
            ),
          );

    // THE SAME HELPER THE COMPILER USES. These were two copies a word apart — `n.reads` here,
    // `observedChannels(n)` there — so this diagnostic reasoned about a lower floor than the
    // executor enforces for any node that reaches a channel through a template.
    const dataFloor = dataFloorOf(spec.channels, n);

    const floor = maxPosture(systemFloor, graphPosture, classFloor, dataFloor);
    const effective = maxPosture(floor, declared ?? "out");

    // GRAPH019: a declaration that cannot change the result is a warning, not an
    // error — a portable graph should be able to say `out` in dev and still be
    // safe in prod, where a higher floor applies.
    if (declared !== undefined && isLoosening(floor, declared)) {
      d.push({
        severity: "warning",
        code: "GRAPH019_POSTURE_NO_EFFECT",
        message: `node "${n.id}" declares posture "${declared}" but "${floor}" applies from a higher level`,
        at: { nodeId: n.id },
      });
    }

    // A LAUNDERING HOP, which the compiler had nothing to say about at all.
    //
    // `applySecretFlow` is a RUN-time rule: a node that observes a `pii` or `secret_ref` channel
    // marks every channel it writes as carrying a secret, and a human's de-escalation then stops
    // being able to lower a hard-to-undo sink below `in`. So a graph's real oversight depends on
    // a fact — "this ordinary-looking channel holds a secret now" — that appears nowhere in the
    // graph, and an author met it by running. `plans[].posture` does not show it either: it is
    // computed from DECLARED classifications, so the downstream node reads `out` here and gates
    // at `in` there.
    //
    // A WARNING, NOT A REFUSAL, and the direction is the argument. Laundering is a legitimate
    // shape — a summariser that reduces a secret to a digest is the ordinary reason to write one
    // — and its run-time consequence TIGHTENS oversight rather than loosening it. Refusing would
    // reject correct graphs to prevent something safe; that is the trade this file already
    // refuses to make for `GRAPH019_POSTURE_NO_EFFECT`. What the author is owed is the fact.
    //
    // The rule itself is `launderedChannels` in `spec.ts`, beside `dataFloorOf` and reading the
    // same `observedChannels`, because those six lines lived in two files once and drifted.
    for (const c of launderedChannels(spec.channels, n)) {
      d.push({
        severity: "warning",
        code: "GRAPH014_SECRET_LAUNDERED",
        message: `node "${n.id}" reads a classified channel and writes "${c}", which is not classified — at run time "${c}" carries the secret and holds every hard-to-undo reader at "in"`,
        at: { nodeId: n.id, channel: c },
        fix: `classify "${c}" to say so in the graph, or keep it if the node really does strip the secret — the run tightens either way, and this only says the compiled posture is not the whole story`,
      });
    }

    // GRAPH014: the asymmetry rule. A candidate may never sit below its baseline.
    const baseline = ctx.baselinePostures?.[n.id];
    if (baseline !== undefined && isLoosening(baseline, effective)) {
      d.push({
        severity: "error",
        code: "GRAPH014_OVERSIGHT_LOOSENED",
        message: `node "${n.id}" would run at posture "${effective}", below its baseline of "${baseline}"`,
        at: { nodeId: n.id },
        fix: "tightening is automatic; loosening requires an explicit human de-escalation",
      });
    }
  }

  // A `human_gate` whose policy permits a timeout default-action on an irreversible
  // successor would turn an overloaded queue into an invisible out-of-the-loop
  // system. The policy resource itself is validated by the resource layer; here we
  // check the structural half: a gate must actually gate something.
  for (const n of spec.nodes) {
    if (n.type !== "human_gate") continue;
    const outs = (idx.outbound.get(n.id) ?? []).filter((e) => e.kind !== "error");
    if (outs.length === 0) {
      d.push({
        severity: "warning",
        code: "GRAPH014_GATE_GATES_NOTHING",
        message: `human_gate "${n.id}" has no outgoing edge, so approving it does nothing`,
        at: { nodeId: n.id },
      });
    }
    checkApproval(n, d);
    checkSla(n, d);
    checkDelivery(n, d);
    checkSaturation(n, d);
  }
}

/**
 * Refuse an approval rule the runtime does not actually apply.
 *
 * The alternative — accept the block and enforce the part we implement — produces a
 * graph that reads as "two of the SRE leads must agree" and behaves as "any one of
 * them", with nothing anywhere saying so. An unsupervised action that LOOKS supervised
 * is worse than an unsupervised action, because nobody goes looking (D7.9).
 *
 * THE THREE BESPOKE REFUSALS THAT LIVED HERE ARE GONE, and so are the fields they refused.
 * `mode`, `k` and `delegation` were declared in `ApprovalSpec` in order to be rejected; they
 * are deleted, so `NESTED_FIELDS.approval` refuses them as unknown keys along with `modee`,
 * `quorumK` and `delegate`, which three exact-string checks never caught. The refusals were
 * also defeatable — `delegation: {allowd: true}` compiled clean. Support for k-of-n did not
 * arrive by deleting a check: it was already there, as N gates joined by
 * `join{mode:"quorum", k}`, and `examples/graphs/two-person-approval.json` ships it.
 *
 * What remains here is what a compiler can actually decide about the two surviving fields:
 * the block is an object, its keys are named, `approvers` is a list, the list is not empty,
 * each entry is a subject rather than a role record or a perimeter marker, and
 * `separationOfDuties` is a boolean that names somebody to narrow.
 */
function checkApproval(n: NodeSpec, d: Diagnostic[]): void {
  const at = { nodeId: n.id };
  // BLOCK GUARD FIRST, and it is not defensive tidying. `approval: null` reached `a.mode` and
  // crashed the compiler with `E_INTERNAL: TypeError: Cannot read properties of null (reading
  // 'mode')` — a raw stack instead of a diagnostic naming the node. `approval: 42` and
  // `approval: []` were worse: they read as `undefined` at every field and the whole function
  // returned having checked nothing, so a gate whose approval block was a typed-wrong value
  // compiled clean and raised as a gate naming nobody.
  const block = objectBlock(
    n.humanGate?.approval,
    `human_gate "${n.id}"'s \`approval\``,
    at,
    "an approval rule is `{approvers?, separationOfDuties?}` — an array, a number or null names no one and enforces nothing",
    d,
  );
  if (block === undefined) return;
  // EVERY KEY IS NAMED, because a dropped one here is not a lost setting. `approvres`,
  // `separationOfDutys` and `delegate` each compiled clean and produced a gate that reads as
  // supervised and admits anybody. `NESTED_FIELDS.approval` is the enumeration; the near-miss
  // hint makes the typo cheap to fix rather than cheap to ignore.
  unknownKeys(block, Object.keys(NESTED_FIELDS.approval), `human_gate "${n.id}"'s \`approval\` block`, at, d);
  blockFieldTypes(block, "approval", NESTED_FIELDS.approval, `human_gate "${n.id}"'s \`approval\` block`, at, d);
  const a = n.humanGate?.approval;
  if (a === undefined) return;
  // `approvers` MUST BE AN ARRAY, and the loop below is why. `for (const who of a.approvers ?? [])`
  // iterates a STRING's characters, every one of which is a non-empty string, so
  // `approvers: "u:alice"` passed every per-entry check. At run time the list journals as the
  // string and `String.prototype.includes` then lets subject `"u"` and subject `"alice"` each
  // approve. Refused here because the shape is decidable from the spec alone.
  if (a.approvers !== undefined && !Array.isArray(a.approvers)) {
    d.push({
      severity: "error",
      code: "GRAPH014_APPROVER_INVALID",
      message: `human_gate "${n.id}" declares approvers ${JSON.stringify(a.approvers)}, which is not a list of subject ids`,
      at,
      fix: "approvers is an array of opaque subject strings; a bare string is read character by character and admits every prefix of itself",
    });
  } else if (Array.isArray(a.approvers) && a.approvers.length === 0) {
    // AN EMPTY LIST IS A RULE THAT NAMES NOBODY, and the runtime reads "names nobody" as
    // permissive. So "this gate deliberately names no one" and "the compiler could not read who
    // it names" produced the identical value, on the one block oversight exists for. Absent
    // still means anyone may decide — that asymmetry is the point, and `gate-authorization.test.ts`
    // records that most gates in this repo name nobody and must keep working.
    d.push({
      severity: "error",
      code: "GRAPH014_APPROVAL_INCOMPLETE",
      message: `human_gate "${n.id}" declares an EMPTY approvers list, which reads as a rule and names nobody`,
      at,
      fix: "omit the field to mean anyone may decide, or list the subjects who must — an empty list is indistinguishable from a list the compiler could not read",
    });
  }

  // SEPARATION OF DUTIES IS ENFORCED NOW, so the refusal is gone — support arrives by
  // DELETING a check, exactly as this function's docstring says. What replaces it is narrower
  // and answers a question the runtime cannot: the rule bars the initiator, so a gate that
  // names NOBODY would read as "everybody except one person" — supervised-looking, and
  // answerable by every authenticated principal but one. That is the same failure the deleted
  // check was written against, one field over, and it IS decidable at compile time because
  // both halves are in the spec.
  // A BOOLEAN, OR NOTHING. Every test in this function and in the runtime is `=== true`, so a
  // truthy non-boolean — `"true"`, `"yes"`, `1` — passes silently and the rule is journaled
  // nowhere: the gate is raised as an ordinary one and the initiator approves their own run.
  // That is not a contrived shape. The canonical on-disk form is JSON and nothing type-checks
  // it on the way in, and YAML 1.2 turns a bare `yes` into the STRING "yes" — which is the
  // identical argument `checkSla` already makes sixty lines below for `onTimeout`.
  if (a.separationOfDuties !== undefined && typeof a.separationOfDuties !== "boolean") {
    d.push({
      severity: "error",
      code: "GRAPH014_APPROVAL_INVALID",
      message: `human_gate "${n.id}" declares separationOfDuties ${JSON.stringify(a.separationOfDuties)}, which is not true or false`,
      at,
      fix: "write `separationOfDuties: true` — a truthy string would be read as absent and the gate would enforce nothing",
    });
  }
  if (a.separationOfDuties === true && (a.approvers ?? []).length === 0) {
    d.push({
      severity: "error",
      code: "GRAPH014_APPROVAL_INCOMPLETE",
      message: `human_gate "${n.id}" declares separationOfDuties but names no approvers, so it would exclude one person and admit everyone else`,
      at,
      fix: "list the approvers who may decide it — separation of duties narrows that list, it does not stand in for it",
    });
  }
  // An approvers list that cannot match anything authorizes everyone, because "names
  // nobody" is the permissive case. Better to refuse the graph than to ship a gate that
  // reads as restricted and is not.
  //
  // A SYNTHETIC SUBJECT IS THE OTHER WAY TO WRITE THAT, and it is worse because it MATCHES.
  // The perimeter mints `(unidentified)` for a caller it could not identify and
  // `(shared-token)` for one holding the plane's own credential — descriptions of what the
  // perimeter concluded, not names of anybody — and a graph listing either reads as
  // restricted while being satisfied by exactly the callers nobody vouched for. The HTTP
  // door refuses a claimed `(unidentified)` at the perimeter, but that is one door of
  // three: the signed-callback route and `loom approve --as` each construct the actor
  // themselves. Refusing the SHAPE at compile time closes it everywhere at once, and
  // closes it for markers nobody has minted yet.
  //
  // ARRAY-GUARDED, because the shape refusal above REPORTS and does not return. Without this the
  // first version of that refusal pushed a diagnostic and then crashed here — `for…of 42` throws
  // `TypeError: number 42 is not iterable`, so an author got a raw stack instead of the
  // diagnostic that had just been written for them. A guard that reports a fault and then trips
  // over it has reported nothing.
  for (const who of Array.isArray(a.approvers) ? a.approvers : []) {
    if (typeof who !== "string" || who.trim() === "") {
      d.push({
        severity: "error",
        code: "GRAPH014_APPROVER_INVALID",
        message: `human_gate "${n.id}" lists an approver that is not a subject id`,
        at,
        fix: "approvers are opaque subject strings matched against a human actor's `subject`; roles and groups need an identity resolver that does not exist yet",
      });
    } else if (isSyntheticSubject(who.trim())) {
      d.push({
        severity: "error",
        code: "GRAPH014_APPROVER_INVALID",
        message: `human_gate "${n.id}" lists "${who.trim()}" as an approver, which is a marker the perimeter mints rather than a subject that names anyone`,
        at,
        fix: "name the person or service account that must approve; a parenthesised subject describes what authentication concluded and would let exactly the unidentified callers through",
      });
    }
  }
}

/**
 * Refuse a clock the runtime would not actually run.
 *
 * The SLA is the half of a gate nobody watches: an approval that is answered promptly
 * exercises none of this, so a misdeclared deadline is discovered at 3am on the one gate
 * nobody answered. Everything checkable is therefore checked at compile time.
 */
function checkSla(n: NodeSpec, d: Diagnostic[]): void {
  const at = { nodeId: n.id };
  const block = objectBlock(
    n.humanGate?.sla,
    `human_gate "${n.id}"'s \`sla\``,
    at,
    "an sla is `{respondWithinMs, onTimeout?, reminders?}` — a non-object declares a clock and gets none",
    d,
  );
  if (block === undefined) return;
  // `onTimout: "escalate"` compiled clean and the gate silently kept the default `fail`: a graph
  // that asked for someone else to be paged, and expires instead. That is `checkSla`'s own
  // argument about `default_action`, one misspelling out.
  unknownKeys(block, Object.keys(NESTED_FIELDS.sla), `human_gate "${n.id}"'s \`sla\` block`, at, d);
  blockFieldTypes(block, "sla", NESTED_FIELDS.sla, `human_gate "${n.id}"'s \`sla\` block`, at, d);
  const sla = n.humanGate?.sla;
  if (sla === undefined) return;
  const bad = (what: string, fix: string): void => {
    d.push({ severity: "error", code: "GRAPH014_SLA_INVALID", message: `human_gate "${n.id}" ${what}`, at, fix });
  };

  if (!isPositiveMs(sla.respondWithinMs)) {
    bad(
      `declares respondWithinMs ${String(sla.respondWithinMs)}, which is not a positive whole number of milliseconds`,
      "respondWithinMs is a duration from the journaled raise; omit the sla block for a gate that should wait indefinitely",
    );
  }

  // `default_action` is unrepresentable in `GateSlaSpec.onTimeout`, so this arm is only
  // reachable from a graph that arrived as JSON — which is the ordinary case, since the
  // canonical on-disk form is JSON and nothing type-checks it on the way in. A gate that
  // asked for a pre-authorized decision and got `fail` is the "declared and not enforced"
  // shape `checkApproval` exists to refuse, one field over.
  if (sla.onTimeout !== undefined && sla.onTimeout !== "escalate" && sla.onTimeout !== "fail") {
    bad(
      `declares onTimeout "${String(sla.onTimeout)}", which a graph cannot ask for`,
      "use escalate or fail — a timeout default_action is a pre-authorized decision, and nothing here can prove the action's irreversibility class permits one",
    );
  }

  // ESCALATE WITH NOWHERE TO ESCALATE TO IS `fail` WEARING ANOTHER WORD. `nextTier` finds
  // no tier, `#fireTimeout` treats the chain as exhausted, and the gate expires at the
  // first deadline — so the graph reads "the manager gets paged" and behaves as "the run
  // dies", with nothing anywhere saying so.
  //
  // A chain whose FIRST tier is already `action: "fail"` is the same thing spelled longer:
  // `nextTier` stops at the first terminal tier, so there is no tier 1 to reach. Checking
  // "has a reachable tier" rather than "is non-empty" is what catches that spelling.
  const chain = asArray<EscalationTierLike>(n.humanGate?.delivery?.escalation);
  if (sla.onTimeout === "escalate" && (chain.length === 0 || chain[0]?.action === "fail")) {
    bad(
      "declares onTimeout: escalate with no reachable delivery.escalation tier, so it would expire at the first deadline instead",
      "add a non-terminal delivery.escalation tier, or say onTimeout: fail and mean it",
    );
  }

  checkReminders(n, sla, bad, at, d);
}

/**
 * Refuse a nudge schedule the sweep would decline to run, or run forever.
 *
 * Every rule here is one of the three bounds `GateSlaSpec.reminders` names, made loud. The
 * broker refuses the same shapes and falls back to NO reminders, which is the safe
 * direction and has to be — a broker can be driven directly — but a silent fallback on the
 * one field whose whole purpose is "tell somebody" is exactly the failure this block is
 * about, so the loud half belongs at compile time.
 *
 * STRICTLY INCREASING, AND STRICTLY INSIDE THE SLA. Out of order, the sweep consumes the
 * list in order and a later-but-smaller instant is already past when it is reached, so it
 * fires immediately after its predecessor — two nudges in one tick, which reads as a bug in
 * the nudger rather than in the schedule. Equal instants are the same thing with no gap at
 * all. And an instant at or past `respondWithinMs` is a nudge for a deadline that has
 * already fired: by then the gate has escalated (a different tier, different people) or
 * expired (nobody left to nudge), so it is a schedule that outlives what it was written
 * for.
 */
function checkReminders(
  n: NodeSpec,
  sla: GateSlaSpecLike,
  bad: (what: string, fix: string) => void,
  at: Diagnostic["at"],
  d: Diagnostic[],
): void {
  const declared: unknown = sla.reminders;
  if (declared === undefined) return;
  if (!Array.isArray(declared)) {
    bad(
      "declares sla.reminders that is not a list",
      "reminders is a list of {afterMs} measured from the raise; drop the field for a gate that should be asked once",
    );
    return;
  }
  if (declared.length > MAX_REMINDERS) {
    bad(
      `declares ${declared.length} reminders, more than the ${MAX_REMINDERS} one gate may send`,
      "a nudge is a nudge; a schedule longer than this is an escalation chain wearing another name, and delivery.escalation is where that belongs",
    );
    return;
  }
  let previous = 0;
  for (const [i, entry] of (declared as readonly unknown[]).entries()) {
    // THE SCOPE THAT WAS MISSING. Every other `humanGate` block refuses an unknown key; this one
    // did not, so `{afterMs: 1000, evrey: true}` compiled clean while `sla: {..., nonsenseKey}`
    // one level up was refused. Driven with that control, so the silence was the scope rather
    // than a short-circuit.
    if (isPlainRecord(entry)) {
      unknownKeys(entry, Object.keys(NESTED_FIELDS.slaReminder), `human_gate "${n.id}"'s \`sla.reminders[${String(i)}]\``, at, d);
      blockFieldTypes(entry, "slaReminder", NESTED_FIELDS.slaReminder, `human_gate "${n.id}"'s \`sla.reminders[${String(i)}]\``, at, d);
    }
    const afterMs: unknown = isPlainRecord(entry) ? entry["afterMs"] : undefined;
    if (!isPositiveMs(afterMs)) {
      bad(
        `declares a reminder at ${String(afterMs)}, which is not a positive whole number of milliseconds`,
        "each reminder is {afterMs}, measured from the journaled raise — a NaN or a string loses the comparison the sweep makes and never fires",
      );
      return;
    }
    if (afterMs <= previous) {
      bad(
        `declares a reminder at ${afterMs}ms that does not come after the one before it`,
        "reminders are consumed in order, so the list must strictly increase — two at the same instant are one nudge and a wasted row",
      );
      return;
    }
    previous = afterMs;
    if (isPositiveMs(sla.respondWithinMs) && afterMs >= sla.respondWithinMs) {
      bad(
        `declares a reminder at ${afterMs}ms, which is not inside its own SLA of ${sla.respondWithinMs}ms`,
        "a nudge after the deadline reaches whoever the escalation moved the gate to, or nobody at all; put it before respondWithinMs, or escalate instead",
      );
      return;
    }
  }
}

/**
 * How many nudges one gate may ever send.
 *
 * A bound rather than a taste: the list is the only thing that limits how many times a
 * human is interrupted about one question, and `strictly increasing` plus `inside the SLA`
 * bounds the instants without bounding the COUNT — an SLA of an hour has room for a
 * thousand of them.
 */
const MAX_REMINDERS = 8;

/** The `sla` block as a graph that arrived as JSON may really carry it. */
interface GateSlaSpecLike {
  readonly respondWithinMs?: unknown;
  readonly onTimeout?: unknown;
  readonly reminders?: unknown;
}

/**
 * Refuse a saturation control the runtime would silently decline to apply — D7.9 rows 2
 * and 3.
 *
 * These two are the only declarations in a `human_gate` block whose failure mode is
 * QUIETER than doing nothing. A misdeclared SLA fires at the wrong time and somebody
 * notices; a misdeclared `batching` merges nothing at all, and the graph reads as "these
 * twenty approvals arrive as one" while twenty land in the queue. `HumanGateBroker`
 * refuses each of these again at run time and falls back to no batching and no dedup —
 * that is the safe direction and it has to be, because a broker can be driven directly —
 * but the fallback is silent by construction, so the loud half belongs here.
 *
 * THE NUMBERS ARE CHECKED FOR WHAT THEY END AT, NOT FOR BEING NUMBERS. `windowMs` and
 * `maxBatch` both end at a comparison, and `NaN` loses every comparison: a `maxBatch` of
 * `NaN` is not a small cap, it is NO cap, and a `windowMs` of `NaN` is not a short window,
 * it is one that never closes. Both are the wrong direction for a knob whose entire job is
 * to bound a blast radius.
 */
function checkSaturation(n: NodeSpec, d: Diagnostic[]): void {
  const at = { nodeId: n.id };
  const batching: unknown = n.humanGate?.batching;
  const dedupe: unknown = n.humanGate?.dedupe;

  if (batching !== undefined) {
    const bad = (what: string, fix: string): void => {
      d.push({ severity: "error", code: "GRAPH014_BATCHING_INVALID", message: `human_gate "${n.id}" ${what}`, at, fix });
    };
    if (!isPlainRecord(batching)) {
      bad(
        "declares a batching block that is not an object",
        "batching is {enabled, key, windowMs, maxBatch}; an array, a Map or a Date has no fields the runtime can read and would merge nothing",
      );
    } else if (unknownKeys(batching, Object.keys(NESTED_FIELDS.batching), `human_gate "${n.id}"'s \`batching\` block`, at, d)) {
      // An unknown key here is checked BEFORE the value rules, so `windowMz` is reported as the
      // typo it is rather than as a missing `windowMs` — the author who wrote one is told which.
    } else if (typeof batching["enabled"] !== "boolean") {
      bad(
        `declares batching.enabled ${String(batching["enabled"])}, which is not a boolean`,
        "say enabled: true to merge sibling gates, or drop the block — an absent block is the same as enabled: false and says so",
      );
    } else if (batching["enabled"] === true) {
      const key: unknown = batching["key"];
      if (typeof key !== "string" || key.trim() === "") {
        bad(
          "declares batching without a key, so no two gates could ever be told to group",
          "key is a literal label shared by the gates that should merge; it is not an expression over the payload",
        );
      }
      if (!isPositiveMs(batching["windowMs"])) {
        bad(
          `declares batching.windowMs ${String(batching["windowMs"])}, which is not a positive whole number of milliseconds`,
          "windowMs is measured from the batch's first member's journaled raise; a window that is not a number never closes, so the runtime declines to batch at all",
        );
      }
      const maxBatch: unknown = batching["maxBatch"];
      if (typeof maxBatch !== "number" || !Number.isSafeInteger(maxBatch) || maxBatch < 2) {
        bad(
          `declares batching.maxBatch ${String(maxBatch)}, which is not a whole number of gates that two could reach`,
          "maxBatch caps how many gates one click closes and must be at least 2 — a cap of 1 declares a mechanism and gets none",
        );
      }
    }
  }

  if (dedupe !== undefined) {
    const bad = (what: string, fix: string): void => {
      d.push({ severity: "error", code: "GRAPH014_DEDUPE_INVALID", message: `human_gate "${n.id}" ${what}`, at, fix });
    };
    if (!isPlainRecord(dedupe)) {
      bad(
        "declares a dedupe block that is not an object",
        "dedupe is {enabled, windowMs}; an array, a Map or a Date has no fields the runtime can read and would collapse nothing",
      );
    } else if (unknownKeys(dedupe, Object.keys(NESTED_FIELDS.dedupe), `human_gate "${n.id}"'s \`dedupe\` block`, at, d)) {
      // Same ordering as `batching`, and the same reason.
    } else if (typeof dedupe["enabled"] !== "boolean") {
      bad(
        `declares dedupe.enabled ${String(dedupe["enabled"])}, which is not a boolean`,
        "say enabled: true to let an identical answered question answer this one, or drop the block",
      );
    } else if (dedupe["enabled"] === true && !isPositiveMs(dedupe["windowMs"])) {
      bad(
        `declares dedupe.windowMs ${String(dedupe["windowMs"])}, which is not a positive whole number of milliseconds`,
        "windowMs is the age of the answered question, measured from ITS journaled raise; a window that is not a number would inherit a decision of any age",
      );
    }
  }
}

/**
 * A bag of fields, and nothing that merely reports `typeof "object"`.
 *
 * `typeof v !== "object"` admits an array, a `Map`, a `Date` and a `RegExp` — three waves
 * running, that reflex has been the bug — and `null` on top. This asks the one question a
 * declaration block has to answer: is it a plain record whose named fields mean what the
 * schema says? `Object.prototype.toString` rather than a prototype comparison because it
 * is realm-agnostic, and a cross-realm object's prototype is not this realm's (see the
 * `intoHostRealm` trap).
 */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === "[object Object]";
}

/** The shape `checkDelivery` reads a tier as, before it has proved it is one. */
interface EscalationTierLike {
  readonly afterMs?: unknown;
  readonly to?: unknown;
  readonly channels?: unknown;
  readonly action?: unknown;
}

/**
 * Refuse a delivery block the runtime would misread — and check nothing it cannot know.
 *
 * THE CHANNEL NAMES ARE NOT CHECKED, on purpose. A dispatcher is built by the deployment,
 * so the compiler has no channel list to check against, and inventing one would make a
 * portable graph fail to compile in the environment that has the channel. An unknown name
 * is already loud at run time — `gate.delivery_failed` plus the console fallback — and
 * delivery failure never auto-approves, so the safe direction is the one it already takes.
 *
 * `afterMs` MONOTONICITY IS NOT CHECKED EITHER, and that is a decision rather than an
 * omission. `nextTier` computes each tier's deadline as `now + afterMs` at the moment the
 * PREVIOUS tier breached, so `afterMs` is that tier's OWN window and not an offset from the
 * raise. A chain that tightens as it climbs — 15 minutes for the on-call, then 2 for the
 * director — is therefore a legitimate escalation, and refusing or even warning about it
 * would be the compiler asserting a semantic the runtime does not have.
 */
function checkDelivery(n: NodeSpec, d: Diagnostic[]): void {
  const at = { nodeId: n.id };
  const block = objectBlock(
    n.humanGate?.delivery,
    `human_gate "${n.id}"'s \`delivery\``,
    at,
    "a delivery block is `{channels, recipients?, redact?, redactAs?, escalation?}` — a non-object reaches nobody",
    d,
  );
  if (block === undefined) return;
  // `recipiants: []` compiled clean, so the gate was durable and queued and NOBODY WAS TOLD —
  // the one mode in which "an SLA fired and nobody knew" is possible, reached by one letter.
  unknownKeys(block, Object.keys(NESTED_FIELDS.delivery), `human_gate "${n.id}"'s \`delivery\` block`, at, d);
  blockFieldTypes(block, "delivery", NESTED_FIELDS.delivery, `human_gate "${n.id}"'s \`delivery\` block`, at, d);
  const spec = n.humanGate?.delivery;
  if (spec === undefined) return;
  const bad = (what: string, fix: string): void => {
    d.push({ severity: "error", code: "GRAPH014_DELIVERY_INVALID", message: `human_gate "${n.id}" ${what}`, at, fix });
  };

  if (!isNameList(spec.channels)) {
    bad(
      "declares a delivery block whose channels are not a list of non-empty names",
      "name at least one channel the deployment's GateDispatcher was built with, or drop the delivery block",
    );
  }
  for (const r of asArray<{ kind?: unknown; id?: unknown }>(spec.recipients)) {
    checkRecipient(r, "delivery.recipients", bad);
  }
  if (spec.redact !== undefined && !isNameList(spec.redact)) {
    bad(
      "declares a redact list that is not a list of non-empty field names",
      "redact names payload FIELDS, matched recursively by key; an empty entry would match nothing",
    );
  }
  if (spec.redactAs !== undefined && !isClassification(spec.redactAs)) {
    bad(
      `declares redactAs "${String(spec.redactAs)}", which is not a classification`,
      `use one of ${CLASSIFICATIONS.join(", ")}`,
    );
  }

  if (spec.escalation !== undefined && !Array.isArray(spec.escalation)) {
    bad("declares a delivery.escalation that is not a list of tiers", "escalation is an ordered array of {afterMs, to?, channels?} tiers");
  }
  const chain = asArray<EscalationTierLike>(spec.escalation);
  for (const [i, tier] of chain.entries()) {
    const where = `delivery.escalation[${i}]`;
    // EVERY TIER, not the block. A tier is where the escalation chain names NEW people, so an
    // unread key here is a director who is never told while the graph says they are.
    const tierBlock = objectBlock(
      tier as unknown,
      `human_gate "${n.id}"'s \`${where}\``,
      at,
      "a tier is `{afterMs, to?, channels?, action?}`",
      d,
    );
    // MALFORMED TIER, DONE. Continuing past it is what made `escalation: [null]` report
    // GRAPH003_MALFORMED and then crash on `tier.action` — the diagnostic was written and the
    // author never saw it.
    if (tierBlock === undefined) continue;
    unknownKeys(tierBlock, Object.keys(NESTED_FIELDS.deliveryEscalation), `human_gate "${n.id}"'s \`${where}\``, at, d);
    blockFieldTypes(tierBlock, "deliveryEscalation", NESTED_FIELDS.deliveryEscalation, `human_gate "${n.id}"'s \`${where}\``, at, d);
    if (tier.action === "fail") {
      // A TERMINAL TIER ENDS THE CHAIN WHEREVER IT SITS. `nextTier` returns `undefined` at
      // the first `action: "fail"`, so every tier after it is unreachable — a graph naming
      // a director who is never told, which is the "looks supervised" failure with the
      // people listed right there in the source.
      if (i !== chain.length - 1) {
        bad(
          `declares ${where} as a terminal action: fail, so the ${chain.length - i - 1} tier(s) after it can never be reached`,
          "move the terminal tier to the end of the chain, or delete it — an exhausted chain expires the gate anyway",
        );
      }
      if (tier.to !== undefined || tier.channels !== undefined) {
        d.push({
          severity: "warning",
          code: "GRAPH014_DELIVERY_INVALID",
          message: `human_gate "${n.id}" names recipients or channels on ${where}, which is a terminal action: fail — nobody is told`,
          at,
          fix: "a terminal tier expires the gate; put the last people you want to reach on the tier before it",
        });
      }
      continue;
    }
    if (!isPositiveMs(tier.afterMs)) {
      bad(
        `declares ${where}.afterMs ${String(tier.afterMs)}, which is not a positive whole number of milliseconds`,
        "afterMs is THIS tier's own window, measured from the moment the previous tier breached; zero or negative would walk the whole chain in one sweep",
      );
    }
    for (const r of asArray<{ kind?: unknown; id?: unknown }>(tier.to)) {
      checkRecipient(r, `${where}.to`, bad);
    }
    if (tier.channels !== undefined && !isNameList(tier.channels)) {
      bad(`declares ${where}.channels that are not a list of non-empty names`, "omit channels to reuse the gate's own");
    }
  }
}

/** The three recipient kinds a channel can resolve. Anything else reaches nobody. */
const RECIPIENT_KINDS: ReadonlySet<string> = new Set(["user", "role", "group"]);

function checkRecipient(
  r: { readonly kind?: unknown; readonly id?: unknown } | null | undefined,
  where: string,
  bad: (what: string, fix: string) => void,
): void {
  const kind: unknown = r?.kind;
  const id: unknown = r?.id;
  if (typeof kind !== "string" || !RECIPIENT_KINDS.has(kind) || typeof id !== "string" || id.trim() === "") {
    bad(
      `declares a ${where} entry that is not a {kind, id} recipient`,
      `kind is one of ${[...RECIPIENT_KINDS].join(", ")} and id is a non-empty string the channel can resolve`,
    );
  }
}

/** A duration a deadline can be built from. `Infinity` and `1.5` are neither. */
function isPositiveMs(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** A list of names, where "" and a non-string are both "names nothing". */
function isNameList(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.trim() !== "");
}

/**
 * Whatever arrived, as something safe to iterate.
 *
 * The canonical on-disk `GraphSpec` is JSON and nothing type-checks it on the way in, so a
 * `for…of` over a field the types promise is an array is a `TypeError` out of the compiler
 * for a graph somebody hand-wrote. A diagnostic saying "this is not a list" is what an
 * author can act on; a stack trace is not.
 */
function asArray<T>(v: unknown): readonly T[] {
  return Array.isArray(v) ? (v as readonly T[]) : [];
}

// ── GRAPH015 ─────────────────────────────────────────────────────────────────

function collectRefs(spec: GraphSpec): { ref: ResourceRef; at: Diagnostic["at"] }[] {
  const out: { ref: ResourceRef; at: Diagnostic["at"] }[] = [];
  for (const n of spec.nodes) {
    const at = { nodeId: n.id };
    // A MISSING REF IS A DIAGNOSTIC, NOT A CRASH. `if (n.agent)` is true for `agent: {}`, and
    // `parseRef(undefined)` reached `undefined.lastIndexOf` — so the most ordinary authoring
    // mistake there is, forgetting a required field, came back as
    // `E_INTERNAL: TypeError: Cannot read properties of undefined (reading 'lastIndexOf')`.
    // A compiler whose job is to diagnose must not be the thing that throws.
    const ref = (v: unknown): v is ResourceRef => typeof v === "string";
    if (n.function && ref(n.function.ref)) out.push({ ref: n.function.ref, at });
    if (n.agent) {
      if (ref(n.agent.profile)) out.push({ ref: n.agent.profile, at });
      if (ref(n.agent.prompt)) out.push({ ref: n.agent.prompt, at });
    }
    if (n.router?.profile !== undefined && ref(n.router.profile)) out.push({ ref: n.router.profile, at });
    if (n.evaluator && ref(n.evaluator.ref)) out.push({ ref: n.evaluator.ref, at });
    if (n.humanGate && ref(n.humanGate.ref)) out.push({ ref: n.humanGate.ref, at });
    if (n.subgraph && ref(n.subgraph.ref)) out.push({ ref: n.subgraph.ref, at });
  }
  // `hooks` is caller data too. `{beforeNode: 42}` reached `for (const ref of 42)` and returned
  // `E_INTERNAL: TypeError: refs is not iterable` — five lines under the guards this function
  // already grew for the same class of mistake.
  for (const refs of Object.values(spec.hooks ?? {})) {
    if (!Array.isArray(refs)) continue;
    for (const r of refs) if (typeof r === "string") out.push({ ref: r as ResourceRef, at: undefined });
  }
  return out;
}

/**
 * KINDS WHOSE CONTENT NOTHING READS, so a ref of that kind resolving to nothing is not an error.
 *
 * This is not a courtesy list. Every OTHER kind a graph can name becomes a document the run
 * needs — a `prompt` reaches `#documentFor`, a `function` and a `hook` are compiled bodies, a
 * `subgraph` is a child spec — and a ref that names none of those is a run that will fail. These
 * two are different in kind rather than in degree: they are KEYS.
 *
 *   `agent_profile` — the routing key. `#runAgent` passes `agent.profile` straight through as
 *     `ModelRequest.model`, and the deployment's `--models-file` `routes` table is what maps it
 *     to a real model id. `cli.ts` states the reversal: "when `agent_profile` resources carry a
 *     real profile document and something resolves one into a model id, the `routes` table is
 *     what gets deleted."
 *   `oversight` — the policy label. `humanGate.ref` becomes `policyRef`, which gates BATCH by
 *     and `resolveGate` matches on, and nothing resolves its content: D7.2's blocks are inline
 *     on the node for exactly that reason (`ApprovalSpec`'s docstring). design/loom/04-OVERSIGHT.md (deleted at f975f9f) states
 *     the reversal: "a resolver seam exists that hands a validated `OversightPolicy` document to
 *     the compiler and the broker."
 *
 * When either reversal lands, delete its entry here IN THE SAME CHANGE. A kind that has become a
 * document and is still on this list is a graph that compiles and cannot run.
 *
 * A published resource of these kinds still resolves and still pins — this only says that its
 * ABSENCE is not a diagnosis.
 */
const NAME_ONLY_KINDS: readonly string[] = ["agent_profile", "oversight"];

/** Where a workspace would publish this ref. The extension is the kind's, not one list for all. */
function publishAt(ref: string): string {
  const kind = ref.slice(0, ref.indexOf("/"));
  const name = ref.slice(ref.indexOf("/") + 1).split("@")[0] ?? "name";
  const ext =
    kind === "function" || kind === "hook" ? ".js" : kind === "subgraph" || kind === "graph" ? ".json" : ".md";
  return `publish it — a workspace serves resources/${kind}/${name}${ext} — or correct the ref`;
}

function rule015Resources(spec: GraphSpec, resolver: ResourceResolver, d: Diagnostic[]): void {
  for (const { ref, at } of collectRefs(spec)) {
    const resolved = resolver.resolve(ref);
    if (resolved === undefined) {
      if (NAME_ONLY_KINDS.includes(ref.slice(0, ref.indexOf("/")))) continue;
      // A `fix` NAMING THE FILE, because this became the diagnostic an author hits most the
      // moment the CLI stopped fabricating a pin for every syntactically valid ref, and
      // "does not resolve" answers none of "resolve where, to what, put it where".
      const base = {
        severity: "error" as const,
        code: "GRAPH015_RESOURCE_NOT_FOUND",
        message: `resource "${ref}" does not resolve`,
        fix: publishAt(ref),
      };
      d.push(at === undefined ? base : { ...base, at });
      continue;
    }
    if (resolved.channel === "deprecated") {
      const base = {
        severity: "warning" as const,
        code: "GRAPH015_DEPRECATED",
        message: `resource "${ref}" resolves to a deprecated version`,
        fix: `pin a supported version of "${ref}"`,
      };
      d.push(at === undefined ? base : { ...base, at });
    }
  }
}

// ── GRAPH016 ─────────────────────────────────────────────────────────────────

/**
 * A `subgraph` node's `inputs`/`outputs` map, or `undefined` with the refusal already pushed.
 *
 * NOT `objectBlock`, and the difference is the whole point of this function: `objectBlock` treats
 * ABSENT as fine, because the `policy` blocks it was written for are optional. These two are not
 * — `SubgraphNode` declares both, and `run/engine.ts`'s `#contextFor` walks `sub.inputs` with the
 * same `Object.entries`, so an absent one is a crash at run time rather than a subgraph that maps
 * nothing. The channel loop in `checkStructure` makes the same distinction the same way, by
 * reporting the absent case itself rather than letting a `fatal` with no diagnostic behind it
 * reach `compile` as `ok`.
 *
 * ONE MESSAGE FOR ABSENT AND FOR WRONG-SHAPED, because they are one mistake from the author's
 * side — "there is no mapping here" — and two spellings of one refusal is how two diagnostics
 * come to disagree. The message names the NODE, which is §A.79's closing condition, and states
 * the direction of the arrow, because `inputs` and `outputs` run OPPOSITE ways and a message that
 * only says "must be an object" leaves an author to guess which key is which.
 */
function requiredMapping(
  v: unknown,
  nodeId: NodeId,
  field: "inputs" | "outputs",
  keyIs: string,
  valueIs: string,
  d: Diagnostic[],
): Readonly<Record<string, unknown>> | undefined {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Readonly<Record<string, unknown>>;
  d.push({
    severity: "error",
    code: "GRAPH003_MALFORMED",
    // "DOES NOT DECLARE" FOR THE ABSENT CASE. `describeValue(undefined)` is the word "undefined",
    // so the absent case read "declares `inputs` as undefined" — which tells an author they wrote
    // something they did not write. Absent and wrong-shaped are one mistake to fix and two
    // different things to say.
    message:
      (v === undefined
        ? `subgraph "${nodeId}" does not declare \`${field}\``
        : `subgraph "${nodeId}" declares \`${field}\` as ${describeValue(v)}, which is not a channel mapping`) +
      ` — \`${field}\` maps ${keyIs} to ${valueIs} and is required`,
    at: { nodeId },
    fix: `write \`${field}: {}\` to declare the subgraph maps no ${field === "inputs" ? "input" : "output"}, or give it \`{"<${keyIs.replace(" ", "-")}>": "<${valueIs.replace(" ", "-")}>"}\``,
  });
  return undefined;
}

function rule016Subgraphs(
  spec: GraphSpec,
  ctx: ValidationContext,
  expansion: ExpansionBudget,
  d: Diagnostic[],
): void {
  const depth = ctx.depth ?? 0;
  const expanding = ctx.expanding ?? [];
  // Hoisted out of the loop on purpose: the B siblings at THIS level are exactly the copies the
  // memo exists to collapse, so a map created per node would cache nothing they share.
  const memo = ctx.subgraphMemo ?? new Map<string, readonly Diagnostic[]>();

  for (const n of spec.nodes) {
    const sub = n.subgraph;
    if (sub === undefined) continue;

    if (expanding.includes(sub.ref)) {
      d.push({
        severity: "error",
        code: "GRAPH016_SUBGRAPH_CYCLE",
        message: `subgraph "${sub.ref}" is already being expanded: ${[...expanding, sub.ref].join(" -> ")}`,
        at: { nodeId: n.id },
      });
      continue;
    }
    if (depth + 1 > expansion.maxDepth) {
      d.push({
        severity: "error",
        code: "GRAPH016_DEPTH_EXCEEDED",
        message: `subgraph "${n.id}" nests to depth ${depth + 1}, over expansion.maxDepth of ${expansion.maxDepth}`,
        at: { nodeId: n.id },
      });
      continue;
    }

    const child = ctx.resolver.subgraph?.(sub.ref);
    if (child === undefined) continue; // GRAPH015 already reported a missing ref

    // THE FOUR BLOCKS THIS RULE READS, ASKED ABOUT BEFORE THEY ARE READ (§A.79). The rule read
    // all four straight, and `compile`'s input is a cast `JSON.parse` — so a graph FILE, and a
    // resolver handing back a resource FILE, decided whether any of them existed. Measured on
    // `compile`, one graph per value, before this:
    //
    //     subgraph: {ref, outputs}       (no `inputs`)   THREW TypeError: Cannot convert
    //     subgraph: {ref, inputs}        (no `outputs`)  undefined or null to object
    //     inputs: null / outputs: null                   — the same, from `Object.entries`
    //     child spec with no `channels` / channels: null THREW the same, from `Object.hasOwn`
    //     inputs: 42                                     ok, ZERO diagnostics — the mapping
    //                                                    silently dropped, which is the quiet
    //                                                    half and the worse one
    //     inputs: "inp"                                  SIX GRAPH016_BAD_MAPPINGs about child
    //                                                    channels "0", "1", "2" — a diagnostic
    //                                                    about the string's own indices
    //
    // THE TWO HALVES GET DIFFERENT TREATMENT, because only one of them has a second reporter.
    // `sub.inputs`/`sub.outputs` are the PARENT's declaration and nothing else looks at them, so
    // they are refused here. The CHILD's `channels` is reported by the child's own
    // `checkStructure` through the recursion below, re-tagged `in subgraph "…": …` and pointed at
    // this node — so this rule only declines to answer the child half of a mapping it cannot
    // answer, rather than spelling that refusal a second time. `namesUnder`'s walk, which runs
    // before this rule, skips a malformed child for the same reason.
    //
    // `SubgraphNode.inputs` and `.outputs` are NOT optional in the type and the executor agrees:
    // `run/engine.ts` does `Object.entries(sub.inputs)` at `#contextFor` too, so an absent one is
    // a crash at run time and not a subgraph that maps nothing. Absent is a fault, and it says so.
    const inputs = requiredMapping(sub.inputs, n.id, "inputs", "child channel", "parent channel", d);
    const outputs = requiredMapping(sub.outputs, n.id, "outputs", "parent channel", "child channel", d);
    // NOT A PLAIN OBJECT IS REFUSE, NEVER SKIP, and that distinction was a defect. This used to
    // hand back `undefined` for a child whose `channels` was not a plain object and the mapping
    // loops below skipped their child half — so `channels: []` lost both `GRAPH016_BAD_MAPPING`s
    // the base compiler printed, on the reasoning that the child's own `checkStructure` would
    // report it. It did not: `typeof [] === "object"` let an array past that check too, so the
    // ONE reporter this deferred to was silent as well and the whole fault came out clean.
    //
    // An empty map is the honest stand-in rather than a skip: a child whose `channels` is not a
    // channel map declares no channel of any name, so every mapping into it really does name
    // something the child does not declare, and saying so is true rather than a placeholder. The
    // child's own `channels` refusal arrives beside it through the recursion, re-tagged at this
    // node — two diagnostics for two different mistakes, which is what base printed for `[]`.
    const childIsGraph = typeof child === "object" && child !== null;
    const rawChildChannels: unknown = childIsGraph ? child.channels : undefined;
    const childChannels: Readonly<Record<string, unknown>> =
      typeof rawChildChannels === "object" && rawChildChannels !== null && !Array.isArray(rawChildChannels)
        ? (rawChildChannels as Readonly<Record<string, unknown>>)
        : {};

    for (const [childCh, parentCh] of Object.entries(inputs ?? {})) {
      if (!Object.hasOwn(spec.channels, parentCh as string)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps input "${childCh}" from undeclared parent channel "${String(parentCh)}"`,
          at: { nodeId: n.id },
        });
      }
      if (!Object.hasOwn(childChannels, childCh)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps to child channel "${childCh}", which "${sub.ref}" does not declare`,
          at: { nodeId: n.id },
        });
      }
    }
    for (const [parentCh, childCh] of Object.entries(outputs ?? {})) {
      if (!Object.hasOwn(spec.channels, parentCh)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps output to undeclared parent channel "${parentCh}"`,
          at: { nodeId: n.id },
        });
      }
      if (!Object.hasOwn(childChannels, childCh as string)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps output from child channel "${String(childCh)}", which "${sub.ref}" does not declare`,
          at: { nodeId: n.id },
        });
      }
    }

    // Recurse with the child's own tools/resolver, carrying the expansion trail.
    //
    // ONCE PER DISTINCT (ref, depth, trail), NOT ONCE PER REFERENCING NODE. This loop had no
    // cache, so a child referenced by B nodes at each of N levels was validated B^N times and
    // produced B^N copies of each of its diagnostics — the same child fault reported 65,535
    // times at depth 16, and 13.5 s and 1,048,575 diagnostic objects at depth 20, against a
    // docstring on `compile` that promises an editor can call it on every keystroke.
    // `compile.ts`'s `resolveSubgraphs` walks the identical tree in linear time with a
    // `reachedAt` map; this is the other half of that walk agreeing with it.
    //
    // THE KEY IS ALL THREE PARTS, and the trail is not decoration. `expanding` decides
    // GRAPH016_SUBGRAPH_CYCLE, so two nodes at the same depth reaching one child by different
    // routes can genuinely get different answers — keying on `ref@depth` alone would serve one
    // route's answer to the other. `depth` is there because the depth budget is recomputed per
    // level. Everything else the child's validation reads (resolver, tools, tenant, floors) is
    // fixed for the whole walk, which is why the memo may not outlive it — see
    // `ValidationContext.subgraphMemo`.
    //
    // The CACHED value is the child's own diagnostics; the re-tagging below is per node, so an
    // author still sees the fault reported once against each node that reaches it.
    const trail = [...expanding, sub.ref];
    const key = `${String(depth + 1)}\u0000${trail.join("\u0000")}`;
    let childDiags = memo.get(key);
    if (childDiags === undefined) {
      // `index` is DROPPED, not inherited: `ctx.index` is the index of the PARENT spec, and the
      // child is a different graph. Passing it down would validate the child against its
      // parent's reachability, ancestors and fan-out widths.
      const { index: _parentIndex, ...rest } = ctx;
      childDiags = validateGraph({ ...rest, spec: child, depth: depth + 1, expanding: trail, subgraphMemo: memo });
      memo.set(key, childDiags);
    }
    for (const childDiag of childDiags) {
      d.push({
        ...childDiag,
        code: childDiag.code,
        message: `in subgraph "${sub.ref}": ${childDiag.message}`,
        at: { nodeId: n.id },
      });
    }
  }
}

// ── GRAPH017 ─────────────────────────────────────────────────────────────────

function rule017Capabilities(spec: GraphSpec, ctx: ValidationContext, expansion: ExpansionBudget, d: Diagnostic[]): void {
  const tenant = ctx.tenantCapabilities;
  if (tenant === undefined) return;

  const granted = (needle: string): boolean =>
    tenant.some((pattern) =>
      pattern.endsWith("*") ? needle.startsWith(pattern.slice(0, -1)) : pattern === needle,
    );

  const check = (caps: readonly string[] | undefined, at: Diagnostic["at"], who: string): void => {
    for (const cap of caps ?? []) {
      if (!granted(cap)) {
        const base = {
          severity: "error" as const,
          code: "GRAPH017_CAPABILITY_NOT_GRANTED",
          message: `${who} declares capability "${cap}", which the tenant does not hold`,
          fix: `remove "${cap}", or grant it to the tenant`,
        };
        d.push(at === undefined ? base : { ...base, at });
      }
    }
  };

  check(spec.policy?.capabilities, undefined, "the graph");

  /**
   * AND THE GRAPH'S OWN ALLOWLIST IS A CEILING, not a request.
   *
   * `design/loom/02-EXECUTION-GRAPH.md (deleted at f975f9f)` says `capabilities: [string]  # allowlist; intersected with system +
   * tenant (never widened)`. Only the upward half was built: the list was checked against the
   * tenant and bounded nothing below it, so `policy: { capabilities: [] }` permitted everything
   * the tenant did. Measured — a graph declaring the empty list ran `pay.charge` to completion.
   *
   * ABSENT IS NOT EMPTY. A graph that declares no list has no ceiling and is unaffected; one
   * that declares `[]` has asked for nothing. Every graph in this repo that declares a list
   * already names what its tools need, so this refuses none of them — checked by running the
   * whole suite with the rule armed before it was written.
   */
  const allow = spec.policy?.capabilities;
  const withinGraph = (needle: string): boolean =>
    allow === undefined ||
    allow.some((pattern) => (pattern.endsWith("*") ? needle.startsWith(pattern.slice(0, -1)) : pattern === needle));

  for (const n of spec.nodes) {
    check(n.policy?.capabilities, { nodeId: n.id }, `node "${n.id}"`);
    // THE CEILING DESCENDS, and only the ceiling. `withinGraph` is THIS graph's own allowlist,
    // and a `subgraph` node named no tool, so a parent declaring `capabilities: []` compiled
    // clean over a child that calls `pay.charge` and the refusal arrived at RUN time as
    // `E_CAP_DENIED`. The TENANT half below is deliberately NOT descended: `rule016Subgraphs`
    // recurses `validateGraph` into the child with the same `ctx`, so the child runs the
    // identical tenant check on its own nodes and a second copy here would only duplicate the
    // diagnostic. The graph ceiling is the half that is genuinely per-level.
    const direct = reachableToolNames(n);
    for (const name of reachableToolNamesThrough(n, (ref) => ctx.resolver.subgraph?.(ref), expansion.maxDepth, ctx.toolReachMemo)) {
      // SAY WHICH ONE, because the two have different fixes: a name this node writes down can be
      // dropped from the node, a name that arrived through the child cannot.
      const where = direct.includes(name) ? `node "${n.id}"` : `subgraph "${n.subgraph?.ref}" under node "${n.id}"`;
      for (const cap of ctx.tools[name]?.capabilities ?? []) {
        if (withinGraph(cap)) continue;
        d.push({
          severity: "error",
          code: "GRAPH017_CAPABILITY_NOT_DECLARED",
          message:
            `tool "${name}" used by ${where} needs capability "${cap}", which is outside ` +
            `this graph's declared \`policy.capabilities\``,
          at: { nodeId: n.id },
          fix: `add "${cap}" to the graph's policy.capabilities, or stop using "${name}" here`,
        });
      }
    }
    // A tool's own required capabilities must also be within the tenant's grant —
    // capability is delegated downward and can never be manufactured. Every reachable
    // tool counts: an agent whose model may call it needs the grant just as a tool node
    // naming it does.
    for (const name of reachableToolNames(n)) {
      check(ctx.tools[name]?.capabilities, { nodeId: n.id }, `tool "${name}" used by node "${n.id}"`);
    }
  }
}
