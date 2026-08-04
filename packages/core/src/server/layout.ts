/**
 * Graph layout — computed here, never in the browser.
 *
 * D8 claims "the browser never runs graph layout", and until now that claim lived inside
 * a JavaScript string served to a browser, where nothing could check it and nothing could
 * measure it. It is a real architectural property: layout is O(nodes + edges) work that
 * depends only on the compiled graph, so doing it per client, per frame, on the slowest
 * machine in the room is the wrong place.
 *
 * Extracting it buys three things:
 *
 * 1. **It is measurable.** The 500-node row of the DoD can state a number for everything
 *    except literal paint, instead of "unmeasured".
 * 2. **It is testable.** Rank assignment, fan-out collapsing, and edge routing are pure
 *    functions of `(RunGraph, tasks)`, and a wrong one is now a failing test rather than
 *    a diagram that looks slightly off.
 * 3. **It is cacheable by `graphHash`.** Structure changes only when the graph does, so a
 *    run streaming a thousand task updates recomputes positions zero times.
 *
 * The browser still draws. Turning this geometry into SVG is presentation, and it belongs
 * where the pixels are.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D8.
 */

import type { RunGraph } from "../graph/spec.ts";
import type { EdgeId, NodeId } from "../ids.ts";
import type { TaskState } from "../run/projection.ts";

export interface LayoutBox {
  readonly width: number;
  readonly height: number;
  readonly gapX: number;
  readonly gapY: number;
  readonly margin: number;
}

export const DEFAULT_BOX: LayoutBox = { width: 190, height: 52, gapX: 70, gapY: 26, margin: 20 };

export interface PlacedNode {
  readonly id: NodeId;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly rank: number;
  /** How many Task instances of this node exist. A collapsed fan-out shows its count. */
  readonly count: number;
  /** The most interesting state among them — never an average. */
  readonly state: TaskState | "";
}

export interface PlacedEdge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  /** Cubic control points, so the client emits a path without deciding its shape. */
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly midY: number;
  readonly taken: boolean;
}

export interface GraphLayout {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
  readonly width: number;
  readonly height: number;
  /** Cache key. Structure is a function of the graph, so this is enough to reuse it. */
  readonly graphHash: string;
}

export interface TaskSummary {
  readonly nodeId: NodeId;
  readonly state: TaskState;
  readonly take?: readonly EdgeId[];
}

/**
 * The order that decides what a collapsed fan-out shows.
 *
 * Twenty-five branches, one shape: the state a person needs to see is the worst one, not
 * the commonest. A fan-out where 24 branches succeeded and one is awaiting a gate is a
 * fan-out waiting on a human, and rendering it green would be a lie of omission.
 */
const STATE_PRIORITY: readonly TaskState[] = [
  "failed",
  "awaiting_gate",
  "leased",
  "ready",
  "cancelled",
  "skipped",
  "succeeded",
];

export function dominantState(states: readonly TaskState[]): TaskState | "" {
  for (const s of STATE_PRIORITY) if (states.includes(s)) return s;
  return states[0] ?? "";
}

/**
 * Place every node and route every edge.
 *
 * Positions come from the COMPILER's `layoutRank`, which is why this is cheap: the
 * expensive part — deciding which node belongs on which row — happened once at compile,
 * and this is arithmetic over that answer.
 */
export function layoutGraph(
  graph: RunGraph,
  tasks: Iterable<TaskSummary> = [],
  box: LayoutBox = DEFAULT_BOX,
): GraphLayout {
  const { width: W, height: H, gapX, gapY, margin } = box;

  // Collapse fan-out: N instances of one node become ONE shape with a count.
  const byNode = new Map<NodeId, { count: number; states: TaskState[]; take: Set<string> }>();
  for (const t of tasks) {
    const acc = byNode.get(t.nodeId) ?? { count: 0, states: [], take: new Set<string>() };
    acc.count++;
    acc.states.push(t.state);
    for (const e of t.take ?? []) acc.take.add(e);
    byNode.set(t.nodeId, acc);
  }
  const takenEdges = new Set<string>();
  for (const acc of byNode.values()) for (const e of acc.take) takenEdges.add(e);

  const rows = new Map<number, NodeId[]>();
  for (const n of graph.spec.nodes) {
    const rank = graph.plans[n.id]?.layoutRank ?? 0;
    const row = rows.get(rank);
    if (row === undefined) rows.set(rank, [n.id]);
    else row.push(n.id);
  }

  const pos = new Map<NodeId, { x: number; y: number; rank: number }>();
  let canvasWidth = 0;
  // Sorted, so the same graph lays out identically every time. Insertion order would
  // depend on node declaration order, which is stable — but ranks are numbers and
  // sorting them is the only way "row 2 is below row 1" is actually true.
  const ranks = [...rows.keys()].sort((a, b) => a - b);
  ranks.forEach((rank, rowIndex) => {
    rows.get(rank)!.forEach((id, i) => {
      pos.set(id, { x: margin + i * (W + gapX), y: margin + rowIndex * (H + gapY), rank });
      canvasWidth = Math.max(canvasWidth, margin * 2 + (i + 1) * (W + gapX));
    });
  });

  const nodes: PlacedNode[] = graph.spec.nodes.map((n) => {
    const p = pos.get(n.id)!;
    const acc = byNode.get(n.id);
    return {
      id: n.id,
      type: n.type,
      x: p.x,
      y: p.y,
      rank: p.rank,
      count: acc?.count ?? 0,
      state: acc === undefined ? "" : dominantState(acc.states),
    };
  });

  const edges: PlacedEdge[] = [];
  for (const e of graph.spec.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    // A dangling edge cannot exist in a compiled graph (GRAPH003), but the renderer must
    // not be the thing that discovers it — skipping beats throwing in a display path.
    if (a === undefined || b === undefined) continue;
    const y1 = a.y + H;
    const y2 = b.y;
    edges.push({
      id: e.id,
      from: e.from,
      to: e.to,
      x1: a.x + W / 2,
      y1,
      x2: b.x + W / 2,
      y2,
      midY: (y1 + y2) / 2,
      taken: takenEdges.has(e.id),
    });
  }

  return {
    nodes,
    edges,
    width: canvasWidth,
    height: margin * 2 + ranks.length * (H + gapY),
    graphHash: graph.graphHash,
  };
}
