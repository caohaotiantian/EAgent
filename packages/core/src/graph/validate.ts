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
import { CODES } from "../errors.ts";
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
  launderedChannels,
  observedChannels,
  REQUIRED_BLOCK,
  REQUIRED_FIELDS,
  reachableToolNames,
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
    for (const n of spec.nodes) {
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
  readonly entryNodes: readonly NodeId[];
  readonly terminalNodes: readonly NodeId[];
  /** Topological order over `dagEdges`; empty when the forward graph is cyclic. */
  readonly topoOrder: readonly NodeId[];
  readonly ancestors: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
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
  const dagEdges = spec.edges.filter((e) => e.kind !== "loop" && e.kind !== "compensation");
  const loopEdges = spec.edges.filter((e) => e.kind === "loop");

  // Entry: no inbound edge of any kind EXCEPT a loop back-edge. There is
  // deliberately no `entry:` field — a second way to say where a graph starts is a
  // second thing that can disagree with the edges.
  //
  // Note this differs from `dagEdges`: a compensation edge is excluded from the DAG
  // (including it makes almost every graph look cyclic) but it DOES mean its target is
  // not a start point. Nothing traverses a compensation edge, so listing its target here
  // would be the ONLY thing that ever scheduled that node — and it would run at the start
  // of the run, before the action it is declared to undo.
  const hasNonLoopIn = new Set(spec.edges.filter((e) => e.kind !== "loop").map((e) => e.to));
  const entryNodes = spec.nodes.filter((n) => !hasNonLoopIn.has(n.id)).map((n) => n.id);
  const hasForwardOut = new Set(dagEdges.map((e) => e.from));
  const terminalNodes = spec.nodes.filter((n) => !hasForwardOut.has(n.id)).map((n) => n.id);

  const topoOrder = topoSort(spec.nodes.map((n) => n.id), dagEdges);

  // Ancestors over forward edges only; used by GRAPH010's concurrency test.
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
    entryNodes,
    terminalNodes,
    topoOrder,
    ancestors,
    reachable,
    parallelWidth,
    multiplicity,
    criticalPath,
  };
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
      if (e.kind === "fanout") return [...parent, e.maxWidth ?? 1];
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
      if (e.kind === "fanout") return parentWidth * (e.maxWidth ?? 1);
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
    const iterations = Math.max(1, loop.maxIterations ?? 1);
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

export function validateGraph(ctx: ValidationContext): readonly Diagnostic[] {
  const { spec } = ctx;
  const d: Diagnostic[] = [];

  // Structural problems make every later rule report nonsense, so they gate.
  const structural = checkStructure(spec, d);
  if (structural) return d;

  const idx = ctx.index === undefined ? indexGraph(spec) : ctx.index();
  const expansion = { ...DEFAULT_EXPANSION, ...(spec.policy?.expansion ?? {}) };
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

  const check = (policy: unknown, whose: string, at: Diagnostic["at"], allowed: readonly string[]): void => {
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
    const budget = objectBlock(
      p["budget"],
      `${whose}\`policy.budget\``,
      at,
      `a budget declares ${list(POLICY_FIELDS.budget)}, all optional`,
      d,
    );
    if (budget !== undefined) unknownKeys(budget, POLICY_FIELDS.budget, `${whose}\`policy.budget\` block`, at, d);
    // `expansion` is graph-scope only, so a node declaring one is already an unknown key above
    // and must not also be walked as though it meant something.
    const expansion = allowed.includes("expansion")
      ? objectBlock(
          p["expansion"],
          `${whose}\`policy.expansion\``,
          at,
          `an expansion budget declares ${list(POLICY_FIELDS.expansion)}, all optional`,
          d,
        )
      : undefined;
    if (expansion !== undefined) {
      // A misspelled limit does not fail — it falls back to `DEFAULT_EXPANSION`. An author who
      // wrote `maxNodes: 8` and gets 256 has had a bound raised on them by a typo.
      unknownKeys(expansion, POLICY_FIELDS.expansion, `${whose}\`policy.expansion\` block`, at, d);
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

  check(spec.policy, "the graph's ", undefined, POLICY_FIELDS.graphPolicy);
  for (const n of spec.nodes) check(n.policy, `node "${n.id}"'s `, { nodeId: n.id }, POLICY_FIELDS.nodePolicy);
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

function checkStructure(spec: GraphSpec, d: Diagnostic[]): boolean {
  let fatal = false;
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
  unknownKeys(spec.metadata as unknown as Record<string, unknown>, NESTED_FIELDS.metadata, "`metadata`", undefined, d);
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
  for (const e of spec.edges) checkCodes(e.codes, { edgeId: e.id }, `edge "${e.id}"`);
  for (const n of spec.nodes) checkCodes(n.retry?.onlyIf, { nodeId: n.id }, `node "${n.id}".retry.onlyIf`);

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

  if (typeof spec.channels !== "object" || spec.channels === null) {
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
    unknownKeys(decl, NESTED_FIELDS.channel, `channel "${name}"`, { channel: name }, d);
    const projection = objectBlock(
      decl["contextProjection"],
      `channel "${name}"'s \`contextProjection\``,
      { channel: name },
      `a context projection is \`{maxTokens, overflow, fields?, take?}\``,
      d,
    );
    if (projection !== undefined) {
      unknownKeys(projection, NESTED_FIELDS.contextProjection, `channel "${name}"'s \`contextProjection\``, { channel: name }, d);
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
      message: `${what} ${JSON.stringify(id)} is not a usable id`,
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
    if (n.type === "function" && n.function !== undefined) {
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
      unknownKeys(retryBlock, NESTED_FIELDS.retry, `node "${n.id}"'s \`retry\` block`, { nodeId: n.id }, d);
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

    // AND THE BLOCK'S OWN REQUIRED FIELDS. `REQUIRED_BLOCK` proves a node HAS an `agent:`; it
    // says nothing about `agent: {}`. Every one of these used to reach `parseRef(undefined)` and
    // come back as `E_INTERNAL: TypeError: Cannot read properties of undefined (reading
    // 'lastIndexOf')`, which tells an author nothing about their graph.
    for (const [field, holder, shape] of REQUIRED_FIELDS[n.type] ?? []) {
      const block = n[holder] as Record<string, unknown> | undefined;
      const value = block?.[field];
      const bad = shape === "array" ? !Array.isArray(value) : typeof value !== "string";
      if (block !== undefined && bad) {
        d.push({
          severity: "error",
          code: "GRAPH020_MISSING_FIELD",
          message: `node "${n.id}" has a \`${String(holder)}\` block whose \`${field}\` is ${
            value === undefined ? "missing" : `not ${shape === "array" ? "an array" : "a string"}`
          }`,
          at: { nodeId: n.id },
          fix: `add \`${field}:\` to node "${n.id}"'s \`${String(holder)}\` block`,
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
    const holder = REQUIRED_BLOCK[n.type];
    const declared = (n as unknown as Record<string, unknown>)[holder as string] as Record<string, unknown> | undefined;
    if (declared !== undefined && typeof declared === "object") {
      const where = `node "${n.id}"'s \`${String(holder)}\` block`;
      if (unknownKeys(declared, ALLOWED_FIELDS[n.type], where, { nodeId: n.id }, d)) fatal = true;
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
  for (const e of spec.edges) {
    if (seenEdges.has(e.id)) {
      d.push({ severity: "error", code: "GRAPH003_DUPLICATE_ID", message: `duplicate edge id "${e.id}"`, at: { edgeId: e.id } });
      fatal = true;
    }
    seenEdges.add(e.id);
    if (!seenNodes.has(e.from)) {
      d.push({ severity: "error", code: "GRAPH003_DANGLING_EDGE", message: `edge "${e.id}" starts at unknown node "${e.from}"`, at: { edgeId: e.id } });
      fatal = true;
    }
    if (!seenNodes.has(e.to)) {
      d.push({ severity: "error", code: "GRAPH003_DANGLING_EDGE", message: `edge "${e.id}" ends at unknown node "${e.to}"`, at: { edgeId: e.id } });
      fatal = true;
    }
    // A misspelled `when` does not disable a condition — it makes the edge unconditional, so a
    // branch the author meant to guard fires every time. `codes` on an error edge is the same
    // shape widened to every code.
    if (unknownKeys(e as unknown as Record<string, unknown>, EDGE_FIELDS, `edge "${e.id}"`, { edgeId: e.id }, d)) {
      fatal = true;
    }
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
  for (const t of idx.terminalNodes) {
    const producesOutput = writers.has(t) || [...(idx.ancestors.get(t) ?? [])].some((a) => writers.has(a));
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
    const r = checkExpr(src, channelTypes);
    if (!r.ok) {
      for (const message of r.errors) {
        d.push({ severity: "error", code: "GRAPH004_EXPR", message: `\`${src}\`: ${message}`, at: where });
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
          message: `\`${src}\` reads channel "${ref}", which node "${readsOf}" does not declare in \`reads\``,
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
      const producedUpstream = [...(idx.ancestors.get(n.id) ?? [])].some((a) =>
        (idx.byId.get(a)?.writes ?? []).includes(r),
      );
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
    if (e.maxWidth > expansion.maxFanout) {
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
    if (joinDepth !== undefined && joinDepth > 0) {
      const collectedBy = spec.nodes.filter((o) => o.join?.branches.includes(n.id) === true);
      if (collectedBy.length === 0) {
        d.push({
          severity: "error",
          code: "GRAPH008_HELD_JOIN_UNCOLLECTED",
          message: `join "${n.id}" is inside a fan-out, so it HOLDS its fold for an enclosing join to collect — but no join declares "${n.id}" among its branches, so that fold is written to a task nobody reads`,
          at: { nodeId: n.id },
          fix: `add "${n.id}" to the enclosing join's \`branches\`, or move "${n.id}" outside the fan-out so it applies its own fold`,
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
}

// ── GRAPH021 ─────────────────────────────────────────────────────────────────

/**
 * Every fan-out must converge on a join.
 *
 * Without one, the branches' writes have no defined fold point: they would have to be
 * applied in arrival order, which is exactly the nondeterminism the branch-coordinate
 * fold exists to remove. Requiring the join makes "when do these merge?" a question
 * the author answers rather than one the scheduler answers by accident.
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
    if (!joined) {
      d.push({
        severity: "error",
        code: "GRAPH021_FANOUT_WITHOUT_JOIN",
        message: `fanout edge "${e.id}" expands "${e.to}" but no downstream join waits on it`,
        at: { edgeId: e.id },
        fix: `add a join node downstream of "${e.to}" with branches: [${e.to}]`,
      });
    }
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
        const related = (idx.ancestors.get(a)?.has(b) ?? false) || (idx.ancestors.get(b)?.has(a) ?? false);
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
  //   `submit`                       `graph.entryNodes` only. A covering join has at least one
  //                                  inbound edge (this clause requires |inbound| = |branch|),
  //                                  so it is never an entry node
  //   `rewind`                       re-arms STRANDED tasks under their own `task.taskId` and
  //                                  their own `edgesIn`. That re-runs a Task that already
  //                                  existed, so it is not a new entrance — and neither is
  //                                  `retry`, which re-readies `w.task.taskId` for the same
  //                                  reason
  //
  // Five are edge-derived and constrained here; two re-arm or start something that is not this
  // join. If an eighth site appears, or one of these learns to ready a join with no edge, this
  // clause is false again and the exemption has to go back to refusing.
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
  unknownKeys(block, NESTED_FIELDS.approval, `human_gate "${n.id}"'s \`approval\` block`, at, d);
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
  unknownKeys(block, NESTED_FIELDS.sla, `human_gate "${n.id}"'s \`sla\` block`, at, d);
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
      unknownKeys(entry, NESTED_FIELDS.slaReminder, `human_gate "${n.id}"'s \`sla.reminders[${String(i)}]\``, at, d);
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
    } else if (unknownKeys(batching, NESTED_FIELDS.batching, `human_gate "${n.id}"'s \`batching\` block`, at, d)) {
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
    } else if (unknownKeys(dedupe, NESTED_FIELDS.dedupe, `human_gate "${n.id}"'s \`dedupe\` block`, at, d)) {
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
  unknownKeys(block, NESTED_FIELDS.delivery, `human_gate "${n.id}"'s \`delivery\` block`, at, d);
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
    unknownKeys(tierBlock, NESTED_FIELDS.deliveryEscalation, `human_gate "${n.id}"'s \`${where}\``, at, d);
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

    for (const [childCh, parentCh] of Object.entries(sub.inputs)) {
      if (!Object.hasOwn(spec.channels, parentCh)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps input "${childCh}" from undeclared parent channel "${parentCh}"`,
          at: { nodeId: n.id },
        });
      }
      if (!Object.hasOwn(child.channels, childCh)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps to child channel "${childCh}", which "${sub.ref}" does not declare`,
          at: { nodeId: n.id },
        });
      }
    }
    for (const [parentCh, childCh] of Object.entries(sub.outputs)) {
      if (!Object.hasOwn(spec.channels, parentCh)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps output to undeclared parent channel "${parentCh}"`,
          at: { nodeId: n.id },
        });
      }
      if (!Object.hasOwn(child.channels, childCh)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps output from child channel "${childCh}", which "${sub.ref}" does not declare`,
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
