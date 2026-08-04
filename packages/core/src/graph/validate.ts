/**
 * Compile-time validation: GRAPH001–GRAPH020.
 *
 * Every rule runs and every diagnostic is returned. Failing on the first error would
 * make authoring a 60-node graph a 60-round-trip exercise, and the compiler is meant
 * to be cheap enough to run on every keystroke in the editor.
 *
 * The rules exist to make three claims true *before* anything executes:
 *   - the run terminates (bounded by construction, not proved — GRAPH006/007/018)
 *   - concurrent writes are deterministic (GRAPH010)
 *   - oversight cannot be weakened anywhere (GRAPH014, GRAPH019)
 *
 * See design/loom/02-EXECUTION-GRAPH.md D5.6.
 */

import type { EdgeId, NodeId } from "../ids.ts";
import { MULTI_WRITER_SAFE, type ChannelSpec } from "../state/channels.ts";
import {
  CLASSIFICATION_POSTURE_FLOOR,
  CLASS_DEFAULT_POSTURE,
  isLoosening,
  maxPosture,
  type IrreversibilityClass,
  type Posture,
} from "../vocab.ts";
import { checkExpr, type Ty } from "./expr.ts";
import {
  DEFAULT_EXPANSION,
  GRAPH_API_VERSION,
  REQUIRED_BLOCK,
  type EdgeSpec,
  type ExpansionBudget,
  type GraphSpec,
  type NodeSpec,
  type ResolvedRef,
  type ResourceRef,
} from "./spec.ts";

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

  // `compensation` is not forward flow — it runs on the error path, in reverse — so
  // including it would make almost every graph look cyclic.
  const dagEdges = spec.edges.filter((e) => e.kind !== "loop" && e.kind !== "compensation");
  const loopEdges = spec.edges.filter((e) => e.kind === "loop");

  // Entry: no inbound edge of any kind EXCEPT a loop back-edge. There is
  // deliberately no `entry:` field — a second way to say where a graph starts is a
  // second thing that can disagree with the edges.
  //
  // Note this differs from `dagEdges`: a compensation edge is excluded from the DAG
  // (it runs in reverse, on the error path, so including it makes almost every graph
  // look cyclic) but it DOES mean its target is not a start point. Treating a
  // compensation target as an entry node would schedule a rollback at run start.
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
    // Loop and compensation targets are reachable too — just not via forward flow.
    for (const e of outbound.get(id) ?? []) stack.push(e.to);
  }

  const parallelWidth = computeParallelWidth(spec, topoOrder, inbound);
  const multiplicity = applyLoopFactors(spec, parallelWidth, loopEdges, ancestors);
  const criticalPath = computeCriticalPath(spec, topoOrder, outbound);

  return {
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

function topoSort(ids: readonly NodeId[], edges: readonly EdgeSpec[]): NodeId[] {
  const indegree = new Map<NodeId, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const e of edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);

  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const out: NodeId[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      const d = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  // A short result means the forward graph has a cycle — GRAPH006 reports it.
  return out.length === ids.length ? out : [];
}

/** Concurrent instances only: fan-out multiplies, a join collapses back to one. */
function computeParallelWidth(
  spec: GraphSpec,
  topoOrder: readonly NodeId[],
  inbound: ReadonlyMap<NodeId, readonly EdgeSpec[]>,
): Map<NodeId, number> {
  const width = new Map<NodeId, number>();
  for (const n of spec.nodes) width.set(n.id, 1);

  for (const id of topoOrder) {
    const ins = (inbound.get(id) ?? []).filter((e) => e.kind !== "loop" && e.kind !== "compensation");
    if (ins.length === 0) continue;
    let best = 0;
    for (const e of ins) {
      const parent = width.get(e.from) ?? 1;
      // A join is a barrier: its branches converge to a single downstream instance.
      const w = e.kind === "join" ? 1 : e.kind === "fanout" ? parent * (e.maxWidth ?? 1) : parent;
      best = Math.max(best, w);
    }
    width.set(id, Math.max(1, best));
  }
  return width;
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

  const idx = indexGraph(spec);
  const expansion = { ...DEFAULT_EXPANSION, ...(spec.policy?.expansion ?? {}) };
  const channelTypes = channelTypeMap(spec.channels);

  rule001Reachability(spec, idx, d);
  rule002Terminals(spec, idx, d);
  rule004Expressions(spec, idx, channelTypes, d);
  rule005Dataflow(spec, idx, d);
  rule006Cycles(spec, idx, channelTypes, d);
  rule007Fanout(spec, expansion, d);
  rule008Joins(spec, idx, d);
  rule009And018Budgets(spec, idx, expansion, d);
  rule010ConcurrentWriters(spec, idx, d);
  rule011And012ErrorPaths(spec, idx, ctx.tools, d);
  rule013Reducers(spec, d);
  rule014And019Oversight(spec, idx, ctx, d);
  rule015Resources(spec, ctx.resolver, d);
  rule016Subgraphs(spec, ctx, expansion, d);
  rule017Capabilities(spec, ctx, d);

  return d;
}

function channelTypeMap(channels: Readonly<Record<string, ChannelSpec>>): Record<string, Ty> {
  const out: Record<string, Ty> = {};
  for (const [name, spec] of Object.entries(channels)) out[name] = spec.type as Ty;
  return out;
}

// ── GRAPH003 + GRAPH020: structure ───────────────────────────────────────────

function checkStructure(spec: GraphSpec, d: Diagnostic[]): boolean {
  let fatal = false;
  if (spec.apiVersion !== GRAPH_API_VERSION) {
    d.push({
      severity: "error",
      code: "GRAPH000_API_VERSION",
      message: `unknown apiVersion "${spec.apiVersion}"`,
      fix: `set apiVersion: ${GRAPH_API_VERSION}`,
    });
    fatal = true;
  }

  const seenNodes = new Set<string>();
  for (const n of spec.nodes) {
    if (seenNodes.has(n.id)) {
      d.push({ severity: "error", code: "GRAPH003_DUPLICATE_ID", message: `duplicate node id "${n.id}"`, at: { nodeId: n.id } });
      fatal = true;
    }
    seenNodes.add(n.id);

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
  }

  for (const name of [...spec.inputs, ...spec.outputs]) {
    if (!(name in spec.channels)) {
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
    if (n.router?.mode === "expression") {
      for (const c of n.router.cases) check(c.when, { nodeId: n.id }, n.id);
    }
  }
}

// ── GRAPH005 ─────────────────────────────────────────────────────────────────

function rule005Dataflow(spec: GraphSpec, idx: GraphIndex, d: Diagnostic[]): void {
  const inputs = new Set(spec.inputs);
  // A fanout edge introduces its item channel into the target's scope.
  const fanoutItems = new Map<NodeId, Set<string>>();
  for (const e of spec.edges) {
    if (e.kind === "fanout" && e.as !== undefined) {
      const set = fanoutItems.get(e.to) ?? new Set<string>();
      set.add(e.as);
      fanoutItems.set(e.to, set);
    }
  }

  for (const n of spec.nodes) {
    for (const w of n.writes ?? []) {
      if (!(w in spec.channels)) {
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

    const items = fanoutItems.get(n.id) ?? new Set<string>();
    for (const r of n.reads ?? []) {
      if (items.has(r)) continue;
      if (!(r in spec.channels)) {
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
    if (e.over !== undefined && !(e.over in spec.channels)) {
      d.push({
        severity: "error",
        code: "GRAPH007_UNKNOWN_OVER",
        message: `fanout edge "${e.id}" fans over undeclared channel "${e.over}"`,
        at: { edgeId: e.id, channel: e.over },
      });
    }
    // The per-branch item is a real channel: the StateView has to serve it and the
    // expression type-checker has to know its type.
    if (e.as !== undefined && !(e.as in spec.channels)) {
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
      if (n.type === "agent" || n.type === "evaluator" || n.type === "subgraph") unbudgeted.push(n.id);
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
  if (graphBudget !== undefined && unbudgeted.length > 0) {
    d.push({
      severity: "warning",
      code: "GRAPH009_UNBOUNDED_NODE",
      message: `node(s) ${unbudgeted.join(", ")} can spend but declare no budget, so the run budget cannot be proven`,
      fix: `add policy.budget.costUsd to ${unbudgeted[0]}`,
    });
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
      if (instances > 1) {
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

// ── GRAPH011 + GRAPH012 ──────────────────────────────────────────────────────

function rule011And012ErrorPaths(
  spec: GraphSpec,
  idx: GraphIndex,
  tools: Readonly<Record<string, ToolManifestLite>>,
  d: Diagnostic[],
): void {
  for (const n of spec.nodes) {
    const manifest = n.tool === undefined ? undefined : tools[n.tool.name];
    const irreversible =
      manifest !== undefined &&
      (manifest.irreversibility === "irreversible" || manifest.irreversibility === "externally_visible");
    if (!irreversible || n.unhandled === true) continue;

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
    const manifest = source?.tool === undefined ? undefined : tools[source.tool.name];
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
  d: Diagnostic[],
): void {
  const systemFloor = ctx.systemPostureFloor ?? "out";
  const graphPosture = spec.policy?.posture ?? "out";

  for (const n of spec.nodes) {
    const declared = n.policy?.posture;

    // The floor a node's own nature asserts, before any declaration.
    const manifest = n.tool === undefined ? undefined : ctx.tools[n.tool.name];
    const classFloor: Posture =
      n.type === "human_gate"
        ? "in"
        : manifest !== undefined
          ? CLASS_DEFAULT_POSTURE[manifest.irreversibility]
          : "out";

    const dataFloor = maxPosture(
      ...[...(n.reads ?? []), ...(n.writes ?? [])].map((c) => {
        const cls = spec.channels[c]?.classification;
        return cls === undefined ? ("out" as Posture) : CLASSIFICATION_POSTURE_FLOOR[cls];
      }),
    );

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
  }
}

// ── GRAPH015 ─────────────────────────────────────────────────────────────────

function collectRefs(spec: GraphSpec): { ref: ResourceRef; at: Diagnostic["at"] }[] {
  const out: { ref: ResourceRef; at: Diagnostic["at"] }[] = [];
  for (const n of spec.nodes) {
    const at = { nodeId: n.id };
    if (n.function) out.push({ ref: n.function.ref, at });
    if (n.agent) {
      out.push({ ref: n.agent.profile, at });
      out.push({ ref: n.agent.prompt, at });
    }
    if (n.router?.profile) out.push({ ref: n.router.profile, at });
    if (n.evaluator) out.push({ ref: n.evaluator.ref, at });
    if (n.humanGate) out.push({ ref: n.humanGate.ref, at });
    if (n.subgraph) out.push({ ref: n.subgraph.ref, at });
  }
  for (const refs of Object.values(spec.hooks ?? {})) {
    for (const ref of refs) out.push({ ref, at: undefined });
  }
  return out;
}

function rule015Resources(spec: GraphSpec, resolver: ResourceResolver, d: Diagnostic[]): void {
  for (const { ref, at } of collectRefs(spec)) {
    const resolved = resolver.resolve(ref);
    if (resolved === undefined) {
      const base = { severity: "error" as const, code: "GRAPH015_RESOURCE_NOT_FOUND", message: `resource "${ref}" does not resolve` };
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
      if (!(parentCh in spec.channels)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps input "${childCh}" from undeclared parent channel "${parentCh}"`,
          at: { nodeId: n.id },
        });
      }
      if (!(childCh in child.channels)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps to child channel "${childCh}", which "${sub.ref}" does not declare`,
          at: { nodeId: n.id },
        });
      }
    }
    for (const [parentCh, childCh] of Object.entries(sub.outputs)) {
      if (!(parentCh in spec.channels)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps output to undeclared parent channel "${parentCh}"`,
          at: { nodeId: n.id },
        });
      }
      if (!(childCh in child.channels)) {
        d.push({
          severity: "error",
          code: "GRAPH016_BAD_MAPPING",
          message: `subgraph "${n.id}" maps output from child channel "${childCh}", which "${sub.ref}" does not declare`,
          at: { nodeId: n.id },
        });
      }
    }

    // Recurse with the child's own tools/resolver, carrying the expansion trail.
    for (const childDiag of validateGraph({
      ...ctx,
      spec: child,
      depth: depth + 1,
      expanding: [...expanding, sub.ref],
    })) {
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

function rule017Capabilities(spec: GraphSpec, ctx: ValidationContext, d: Diagnostic[]): void {
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
  for (const n of spec.nodes) {
    check(n.policy?.capabilities, { nodeId: n.id }, `node "${n.id}"`);
    // A tool's own required capabilities must also be within the tenant's grant —
    // capability is delegated downward and can never be manufactured.
    const manifest = n.tool === undefined ? undefined : ctx.tools[n.tool.name];
    check(manifest?.capabilities, { nodeId: n.id }, `tool "${n.tool?.name}" used by node "${n.id}"`);
  }
}
