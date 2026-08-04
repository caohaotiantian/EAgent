/**
 * The `GraphSpec` — the single source artifact.
 *
 * One artifact is authored once and consumed by all six layers: rendered by the UI,
 * compiled and executed by the scheduler, emitted as spans by observability,
 * versioned in the resource layer, and mutated by the evolution loop. No layer keeps
 * a private representation. That is enforced mechanically: the compiler emits
 * `graphHash = digest(spec)`, every span carries it, and a reconstruction test
 * asserts the folded journal reproduces the same hash.
 *
 * The canonical on-disk form is JSON. YAML is authoring sugar handled outside
 * `@loom/core` — the core never parses YAML, which is what keeps it zero-dependency
 * and keeps hashing unambiguous (canonical JSON has one representation; YAML has
 * several for the same document).
 *
 * ENTRY NODES are nodes with no inbound non-loop edge. There is no `entry:` field:
 * a second way to say where a graph starts is a second thing that can disagree with
 * the edges.
 *
 * See design/loom/02-EXECUTION-GRAPH.md D5.4.
 */

import type { Digest } from "../canonical.ts";
import type { EdgeId, NodeId } from "../ids.ts";
import type { ChannelSpec } from "../state/channels.ts";
import type { Posture } from "../vocab.ts";

export const GRAPH_API_VERSION = "loom.dev/v1";

/** `kind/name@selector` — e.g. `prompt/investigate-signal@stable`. */
export type ResourceRef = string;

export interface Budget {
  readonly costUsd?: number;
  readonly tokens?: number;
  readonly wallMs?: number;
}

export interface ExpansionBudget {
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly maxFanout: number;
  readonly maxLoopIterations: number;
}

export interface GraphPolicy {
  readonly posture?: Posture;
  readonly budget?: Budget;
  readonly expansion?: ExpansionBudget;
  readonly capabilities?: readonly string[];
  readonly onBudgetExhausted?: "degrade" | "gate" | "fail";
}

export interface NodePolicy {
  readonly posture?: Posture;
  readonly budget?: Budget;
  readonly capabilities?: readonly string[];
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff?: "exponential" | "fixed";
  readonly initialMs?: number;
  readonly maxMs?: number;
  readonly jitter?: boolean;
  /** Retry only for these normalized error codes. Absent ⇒ any retryable class. */
  readonly onlyIf?: readonly string[];
}

export type NodeType =
  | "function"
  | "agent"
  | "tool"
  | "router"
  | "join"
  | "evaluator"
  | "human_gate"
  | "subgraph";

export interface FunctionNode {
  readonly ref: ResourceRef;
  readonly cpuBound?: boolean;
}

export interface AgentNode {
  readonly profile: ResourceRef;
  readonly prompt: ResourceRef;
  readonly outputSchema?: unknown;
  readonly maxTurns: number;
  readonly tools?: readonly string[];
}

export interface ToolNode {
  readonly name: string;
  readonly version: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface RouterCase {
  readonly when: string;
  readonly take: readonly EdgeId[];
}

export interface RouterNode {
  readonly mode: "expression" | "model";
  readonly cases: readonly RouterCase[];
  /** Taken when no case matches, or when a `model` router returns an invalid id. */
  readonly fallbackEdge: EdgeId;
  /** `model` mode only. */
  readonly profile?: ResourceRef;
}

export interface JoinNode {
  readonly branches: readonly NodeId[];
  readonly mode: "all" | "any" | "quorum" | "firstSuccess";
  /** `quorum` only: an integer count, or a fraction of the branch width. */
  readonly k?: number;
  readonly onBranchError: "fail" | "skip" | "compensate";
  readonly timeoutMs: number;
  /** Keep non-arriving branches running after the join fires. */
  readonly drain?: boolean;
}

export interface EvaluatorNode {
  readonly kind: "assertion" | "rubric";
  readonly ref: ResourceRef;
  readonly threshold: number;
}

export interface HumanGateNode {
  readonly ref: ResourceRef;
}

export interface SubgraphNode {
  readonly ref: ResourceRef;
  /** child channel ← parent channel. */
  readonly inputs: Readonly<Record<string, string>>;
  /** parent channel ← child channel. */
  readonly outputs: Readonly<Record<string, string>>;
  readonly budgetShare?: number;
}

export interface NodeSpec {
  readonly id: NodeId;
  readonly type: NodeType;
  readonly reads?: readonly string[];
  readonly writes?: readonly string[];
  readonly policy?: NodePolicy;
  readonly retry?: RetryPolicy;
  readonly timeoutMs?: number;
  readonly checkpoint?: "none" | "before" | "after" | "both";
  /** Suppresses GRAPH011 for a node whose failure is intentionally unhandled. */
  readonly unhandled?: boolean;

  readonly function?: FunctionNode;
  readonly agent?: AgentNode;
  readonly tool?: ToolNode;
  readonly router?: RouterNode;
  readonly join?: JoinNode;
  readonly evaluator?: EvaluatorNode;
  readonly humanGate?: HumanGateNode;
  readonly subgraph?: SubgraphNode;
}

export type EdgeKind = "seq" | "conditional" | "fanout" | "join" | "error" | "compensation" | "loop";

export interface EdgeSpec {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly kind: EdgeKind;
  /** `conditional` only (absent when the source is a router — the router decides). */
  readonly when?: string;
  /** `fanout` only. */
  readonly over?: string;
  readonly as?: string;
  readonly maxWidth?: number;
  /** `join` only. */
  readonly branches?: readonly NodeId[];
  /** `loop` only. */
  readonly until?: string;
  readonly maxIterations?: number;
  /** `error` only: restrict to these normalized codes. */
  readonly codes?: readonly string[];
  /** `compensation` only. */
  readonly compensates?: NodeId;
}

export interface GraphMetadata {
  readonly name: string;
  readonly project: string;
  readonly version: number;
  readonly description?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface GraphSpec {
  readonly apiVersion: string;
  readonly kind: "GraphSpec";
  readonly metadata: GraphMetadata;
  readonly policy?: GraphPolicy;
  readonly channels: Readonly<Record<string, ChannelSpec>>;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly nodes: readonly NodeSpec[];
  readonly edges: readonly EdgeSpec[];
  readonly hooks?: Readonly<Record<string, readonly ResourceRef[]>>;
}

// ---------------------------------------------------------------------------
// Compiled form
// ---------------------------------------------------------------------------

export interface ResolvedRef {
  readonly ref: ResourceRef;
  readonly digest: Digest;
  readonly channel: "draft" | "canary" | "stable" | "deprecated";
}

/**
 * A node's derived schedule metadata. Computed once at compile so the scheduler and
 * the UI never recompute graph analysis at run time.
 */
export interface NodePlan {
  readonly id: NodeId;
  /** Worst-case number of Task instances: Π(fanout widths) × Π(loop iterations). */
  readonly maxInstances: number;
  /** Longest remaining path to a terminal, in nodes. Drives `criticalPathFirst`. */
  readonly criticalPathLength: number;
  readonly inboundEdges: readonly EdgeId[];
  readonly outboundEdges: readonly EdgeId[];
  /** Effective posture after the `max` fold over every declared level. */
  readonly posture: Posture;
  /** Rank for the UI's layered layout, so the browser never runs graph layout. */
  readonly layoutRank: number;
}

/**
 * The compiled, validated plan for one Run.
 *
 * Immutable. Carries the resolution manifest, which is what makes the pinning rule
 * real: a Run reads only what its manifest names, so a Resource published, promoted,
 * or deprecated mid-run cannot affect it.
 */
export interface RunGraph {
  readonly graphHash: Digest;
  readonly spec: GraphSpec;
  readonly plans: Readonly<Record<NodeId, NodePlan>>;
  readonly entryNodes: readonly NodeId[];
  readonly terminalNodes: readonly NodeId[];
  readonly resolutionManifest: readonly ResolvedRef[];
  readonly expansion: ExpansionBudget;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_EXPANSION: ExpansionBudget = {
  maxNodes: 256,
  maxDepth: 3,
  maxFanout: 32,
  maxLoopIterations: 8,
};

/** Which type-specific block each node type requires. Used by GRAPH020. */
export const REQUIRED_BLOCK: Readonly<Record<NodeType, keyof NodeSpec>> = {
  function: "function",
  agent: "agent",
  tool: "tool",
  router: "router",
  join: "join",
  evaluator: "evaluator",
  human_gate: "humanGate",
  subgraph: "subgraph",
};

/** Node types that can suspend a Run mid-execution (D5.1 invariant 3). */
export const CAN_SUSPEND: ReadonlySet<NodeType> = new Set<NodeType>(["agent", "tool", "human_gate", "subgraph"]);

/** Node types the scheduler may run inline on the committing worker. */
export const CONTROL_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["router", "join", "function"]);
