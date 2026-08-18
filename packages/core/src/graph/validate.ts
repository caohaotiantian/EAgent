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
  isSyntheticSubject,
  maxPosture,
  type IrreversibilityClass,
  type Posture,
  postureRank,
} from "../vocab.ts";
import { checkExpr, type Ty } from "./expr.ts";
import {
  DEFAULT_EXPANSION,
  GRAPH_API_VERSION,
  REQUIRED_BLOCK,
  reachableToolNames,
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
   * How many fan-out coordinate segments a Task of this node carries — the LENGTH of its
   * enclosing fan-out stack. A join reads it to know which instance of itself an arriving
   * branch belongs to: the instance's coordinate is the arriving branch truncated to this
   * depth. Absent means the depth is ambiguous, which `GRAPH008_JOIN_DEPTH` refuses for
   * joins and their arms and tolerates everywhere else.
   */
  readonly fanoutDepth: ReadonlyMap<NodeId, number>;
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
  // NOTHING TRAVERSES ONE. `Engine.#edgesToTake` has `case "compensation": break;`, and
  // the error path takes `kind === "error"` edges only — which is why GRAPH008 refuses
  // `onBranchError: "compensate"` outright rather than letting it read as a rollback. A
  // compensation edge is a DECLARATION, and it earns its place as one: GRAPH012 refuses
  // an edge whose target tool declares no undo, and GRAPH010 reads it to order two
  // writers. It is NOT what lets `rewind` cross an irreversible effect — `rewind` reads
  // `ToolDefinition.compensation` from the registry, and a graph with no compensation
  // edges at all rewinds exactly the same.
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

  const { stacks, widths: parallelWidth } = computeFanoutStacks(spec, topoOrder, inbound);
  const fanoutDepth = new Map<NodeId, number>();
  for (const [id, s] of stacks) if (s !== undefined) fanoutDepth.set(id, s.length);
  const joinNodes = spec.nodes.filter((n) => n.type === "join").map((n) => n.id);
  const multiplicity = applyLoopFactors(spec, parallelWidth, loopEdges, ancestors);
  const criticalPath = computeCriticalPath(spec, topoOrder, outbound);

  return {
    fanoutDepth,
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
): { stacks: Map<NodeId, readonly number[] | undefined>; widths: Map<NodeId, number> } {
  const stacks = new Map<NodeId, readonly number[] | undefined>();
  const widths = new Map<NodeId, number>();
  for (const n of spec.nodes) {
    stacks.set(n.id, []);
    widths.set(n.id, 1);
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
  return { stacks, widths };
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
  rule021FanoutHasJoin(spec, idx, d);
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
  for (const n of spec.nodes) if (!isSafeId(n.id)) badId("node id", n.id, typeof n.id === "string" ? { nodeId: n.id } : undefined);
  for (const e of spec.edges) if (!isSafeId(e.id)) badId("edge id", e.id, typeof e.id === "string" ? { edgeId: e.id } : undefined);
  // A channel name is an object key in `ChannelState`, and `initialState` assigns it with
  // `out[name] = …` — which for `__proto__` writes the prototype and declares nothing.
  for (const name of Object.keys(spec.channels ?? {})) if (!isSafeId(name)) badId("channel name", name, { channel: name });

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

    // `compensate` NAMES AN EXECUTOR THAT DOES NOT EXIST.
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
        message: `join "${n.id}" sets onBranchError: "compensate", but no compensation executor exists — it would behave exactly as "skip"`,
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
      .find((m) => m !== undefined && (m.irreversibility === "irreversible" || m.irreversibility === "externally_visible"));
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
    // The only runtime effect a declared compensation has today is to REMOVE a refusal:
    // `Engine.rewind` will not cross an uncompensated irreversible effect, and it decides
    // that by asking whether the field is present. So `compensation: {tool: "noop"}` —
    // or a name with a typo in it — buys a legal rewind that undoes nothing. Presence is
    // not a promise; a registered tool is the least this can check.
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
    if (undo.irreversibility === "irreversible" || undo.irreversibility === "externally_visible") {
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
  d: Diagnostic[],
): void {
  const systemFloor = ctx.systemPostureFloor ?? "out";
  const graphPosture = spec.policy?.posture ?? "out";

  for (const n of spec.nodes) {
    const declared = n.policy?.posture;

    // The floor a node's own nature asserts, before any declaration. `max` over every
    // tool the node can REACH: an agent node names none, so keying on `n.tool` floored
    // every agent at `out` regardless of what its model could call.
    const classFloor: Posture =
      n.type === "human_gate"
        ? "in"
        : maxPosture(
            "out",
            // An unknown name contributes nothing, exactly as before — see the matching
            // comment in `compile.ts`.
            ...reachableToolNames(n).flatMap((name) => {
              const m = ctx.tools[name];
              return m === undefined ? [] : [CLASS_DEFAULT_POSTURE[m.irreversibility]];
            }),
          );

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
 * is worse than an unsupervised action, because nobody goes looking (D7.9). So the
 * unimplemented half is an error, and it becomes supported by deleting a check here.
 */
function checkApproval(n: NodeSpec, d: Diagnostic[]): void {
  const a = n.humanGate?.approval;
  if (a === undefined) return;
  const at = { nodeId: n.id };
  const unsupported = (what: string, fix: string): void => {
    d.push({ severity: "error", code: "GRAPH014_APPROVAL_UNSUPPORTED", message: `human_gate "${n.id}" ${what}`, at, fix });
  };

  if (a.mode !== undefined && a.mode !== "single") {
    unsupported(
      `declares approval mode "${a.mode}", which the runtime does not implement`,
      "use mode: single — quorum, all and tiered are not enforced yet, and a declaration that is not enforced is worse than none",
    );
  }
  if (a.k !== undefined) unsupported("declares a quorum k, which only mode: quorum would use", "remove k");
  // SEPARATION OF DUTIES IS ENFORCED NOW, so the refusal is gone — support arrives by
  // DELETING a check, exactly as this function's docstring says. What replaces it is narrower
  // and answers a question the runtime cannot: the rule bars the initiator, so a gate that
  // names NOBODY would read as "everybody except one person" — supervised-looking, and
  // answerable by every authenticated principal but one. That is the same failure the deleted
  // check was written against, one field over, and it IS decidable at compile time because
  // both halves are in the spec.
  if (a.separationOfDuties === true && (a.approvers ?? []).length === 0) {
    d.push({
      severity: "error",
      code: "GRAPH014_APPROVAL_INCOMPLETE",
      message: `human_gate "${n.id}" declares separationOfDuties but names no approvers, so it would exclude one person and admit everyone else`,
      at,
      fix: "list the approvers who may decide it — separation of duties narrows that list, it does not stand in for it",
    });
  }
  if (a.delegation?.allowed === true) {
    unsupported("declares delegation, which is not enforced", "remove it — a delegated approval would be recorded as the delegate's own");
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
  for (const who of a.approvers ?? []) {
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
  const sla = n.humanGate?.sla;
  if (sla === undefined) return;
  const at = { nodeId: n.id };
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

  checkReminders(n, sla, bad);
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
function checkReminders(n: NodeSpec, sla: GateSlaSpecLike, bad: (what: string, fix: string) => void): void {
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
  for (const entry of declared as readonly unknown[]) {
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
  const spec = n.humanGate?.delivery;
  if (spec === undefined) return;
  const at = { nodeId: n.id };
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
  if (spec.redactAs !== undefined && !Object.hasOwn(CLASSIFICATION_POSTURE_FLOOR, spec.redactAs)) {
    bad(
      `declares redactAs "${String(spec.redactAs)}", which is not a classification`,
      `use one of ${Object.keys(CLASSIFICATION_POSTURE_FLOOR).join(", ")}`,
    );
  }

  if (spec.escalation !== undefined && !Array.isArray(spec.escalation)) {
    bad("declares a delivery.escalation that is not a list of tiers", "escalation is an ordered array of {afterMs, to?, channels?} tiers");
  }
  const chain = asArray<EscalationTierLike>(spec.escalation);
  for (const [i, tier] of chain.entries()) {
    const where = `delivery.escalation[${i}]`;
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
    // capability is delegated downward and can never be manufactured. Every reachable
    // tool counts: an agent whose model may call it needs the grant just as a tool node
    // naming it does.
    for (const name of reachableToolNames(n)) {
      check(ctx.tools[name]?.capabilities, { nodeId: n.id }, `tool "${name}" used by node "${n.id}"`);
    }
  }
}
