/**
 * Trajectory capture and normalization.
 *
 * A `Trajectory` is a **pure fold of a completed Run's journal**. Capture therefore
 * costs nothing at run time and can be recomputed at any point from cold storage — if
 * the normalization rules change, every historical trajectory is re-derived rather
 * than being stuck at whatever the rules were on the day it ran.
 *
 * The normalization is the whole point. Without it, "similar trajectories" is
 * meaningless: a flaky network makes one strategy look like two, and five signals
 * investigated in a different arrival order look like a different plan. Four rules do
 * the work:
 *
 * | Rule | Without it |
 * |---|---|
 * | Retries collapse to the succeeding attempt; the count becomes an attribute | Transient failures fork one strategy into many |
 * | Fan-out branches are re-indexed by content digest, not arrival index | The same five signals in a different order score as a different strategy |
 * | Payloads become digests; tool arguments become type SHAPES | A trajectory store is a second copy of production data |
 * | A human gate decision is a first-class STEP, not metadata | The best label the system ever gets is buried in an attribute |
 *
 * DEVIATION from D10.a: the fold optionally takes the `RunGraph`. `promptRef` is a
 * property of the graph, not of the journal, and D10.c's delta extraction is keyed on
 * `(node, promptRef)` — so without it the corpus cannot be grouped by the thing being
 * optimised. Both inputs are immutable and content-addressed, so the fold stays pure.
 *
 * See design/loom/06-EVOLUTION.md D10.a.
 */

import { digest, type Digest } from "../canonical.ts";
import type { RunGraph } from "../graph/spec.ts";
import type { NodeType } from "../graph/spec.ts";
import { compareBranch, decodeBranch, encodeBranch, parseTaskId, type NodeId, type RunId, type TaskId } from "../ids.ts";
import { isEvent, type JournalEvent } from "../journal/events.ts";
import type { UsageRecord } from "../vocab.ts";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type TrajectoryAction =
  | {
      readonly kind: "model";
      readonly model: string;
      readonly promptRef?: string;
      readonly promptDigest?: string;
      readonly toolCallNames: readonly string[];
      readonly finishReason: string;
    }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly version: string;
      /** The argument type shape — `{pod:string,tail:number}`, never the values. */
      readonly argsShape: string;
      readonly ok: boolean;
      readonly ms: number;
    }
  | { readonly kind: "route"; readonly taken: readonly string[] }
  | {
      readonly kind: "gate";
      readonly decision: "approve" | "reject" | "edit" | "redirect";
      readonly latencyMs: number;
      /** An `edit` names the channels a human corrected — a supervised label. */
      readonly editedChannels?: readonly string[];
    };

export interface TrajectoryStep {
  readonly taskId: TaskId;
  readonly nodeId: NodeId;
  readonly nodeType: NodeType | "unknown";
  /** The CANONICAL branch path, after fan-out re-indexing. */
  readonly branchPath: string;
  /** How many attempts this step took. Retries do not appear as separate steps. */
  readonly attempts: number;
  readonly stateInHash: string;
  readonly stateOutHash: string;
  readonly actions: readonly TrajectoryAction[];
  readonly status: "succeeded" | "failed" | "skipped" | "cancelled" | "open";
  /** Content-addressed; the payload itself lives in a blob store, not here. */
  readonly observationDigest: Digest;
}

/** The raw signals a scorer reads. Extraction is here; interpretation is in `score.ts`. */
export interface OutcomeSignals {
  /** S1 — deterministic verifier verdicts, in step order. */
  readonly assertions: readonly { readonly nodeId: NodeId; readonly pass: boolean }[];
  /** S2 — human gate decisions. */
  readonly humanDecisions: readonly {
    readonly nodeId: NodeId;
    readonly decision: "approve" | "reject" | "edit" | "redirect";
    readonly latencyMs: number;
  }[];
  /** S4 — rubric-judge verdicts. Never sufficient alone; see `score.ts`. */
  readonly rubrics: readonly { readonly nodeId: NodeId; readonly score: number; readonly pass: boolean }[];
  /** S5 — the agent's own claim of completion. Recorded, weighted zero. */
  readonly selfReported: boolean;
  readonly runStatus: "succeeded" | "failed" | "cancelled" | "incomplete";
}

export interface CohortKey {
  readonly workflow: string;
  readonly graphHash: string;
  readonly tenantTier: string;
  /** A coarse bucket of the input, so "same kind of problem" is comparable. */
  readonly inputBucket: string;
}

export interface Trajectory {
  readonly runId: RunId;
  readonly graphHash: string;
  readonly cohort: CohortKey;
  readonly steps: readonly TrajectoryStep[];
  readonly outcome: OutcomeSignals;
  readonly usage: {
    readonly costUsd: number;
    readonly tokens: number;
    readonly wallMs: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
  };
  readonly policy: {
    readonly escalations: readonly string[];
    readonly violations: number;
    readonly gatesRaised: number;
  };
  /** For dedup and drift detection. NOT the input itself. */
  readonly inputDigest: Digest;
  /**
   * True when this run executed a graph that no human approved — a candidate under
   * canary. Condition 5 of the golden threshold reads this: training on the output of
   * an unpromoted candidate is how a loop teaches itself its own mistakes.
   */
  readonly fromUnpromotedCandidate: boolean;
}

export interface FoldTrajectoryOptions {
  /** Supplies `promptRef`/`promptDigest` and node types. See the deviation above. */
  readonly graph?: RunGraph;
  readonly tenantTier?: string;
  /** Buckets an input into a comparable class. Default: the digest's first 8 chars. */
  readonly bucketInput?: (inputs: Readonly<Record<string, unknown>>) => string;
  /** Graph hashes a human approved. Anything else marks the run as candidate output. */
  readonly promotedGraphHashes?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

interface RawStep {
  taskId: TaskId;
  nodeId: NodeId;
  branchPath: string;
  attempts: number;
  stateInHash: string;
  stateOutHash: string;
  actions: TrajectoryAction[];
  status: TrajectoryStep["status"];
  writes: Record<string, unknown>;
}

export function foldTrajectory(
  events: readonly JournalEvent[],
  opts: FoldTrajectoryOptions = {},
): Trajectory {
  const steps = new Map<TaskId, RawStep>();
  const escalations: string[] = [];
  const gateNodes = new Map<string, NodeId>();

  let runId = "" as RunId;
  let workflow = "";
  let graphHash = "";
  let inputs: Readonly<Record<string, unknown>> = {};
  let runStatus: OutcomeSignals["runStatus"] = "incomplete";
  let violations = 0;
  let gatesRaised = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let stateHash = "";
  const usage = { costUsd: 0, tokens: 0, wallMs: 0 };

  const stepFor = (id: TaskId): RawStep => {
    let s = steps.get(id);
    if (s === undefined) {
      const parsed = parseTaskId(id);
      s = {
        taskId: id,
        nodeId: parsed.nodeId,
        branchPath: encodeBranch(parsed.branch),
        attempts: 1,
        stateInHash: stateHash,
        stateOutHash: stateHash,
        actions: [],
        status: "open",
        writes: {},
      };
      steps.set(id, s);
    }
    return s;
  };

  for (const e of events) {
    runId = e.runId;

    if (isEvent(e, "run.submitted")) {
      workflow = e.payload.workflow;
      graphHash = e.payload.graphHash;
      inputs = e.payload.inputs;
      continue;
    }
    if (isEvent(e, "graph.mutated")) {
      // A mutated run is a different strategy from the graph it started as, and
      // comparing the two would compare different things.
      graphHash = e.payload.newHash;
      continue;
    }
    if (isEvent(e, "run.completed")) {
      runStatus = "succeeded";
      usage.costUsd += e.payload.usage.costUsd;
      usage.wallMs = Math.max(usage.wallMs, e.payload.usage.wallMs);
      continue;
    }
    if (isEvent(e, "run.failed")) {
      runStatus = "failed";
      continue;
    }
    if (isEvent(e, "run.cancelled")) {
      runStatus = "cancelled";
      continue;
    }
    if (isEvent(e, "state.reduced")) {
      stateHash = e.payload.stateHashAfter;
      continue;
    }
    if (isEvent(e, "policy.escalated")) {
      escalations.push(e.payload.rule);
      if (e.payload.rule === "violation") violations++;
      continue;
    }
    if (isEvent(e, "policy.decided")) {
      if (e.payload.effect === "deny") violations++;
      continue;
    }
    if (isEvent(e, "gate.raised")) {
      gatesRaised++;
      gateNodes.set(e.payload.gateId, e.payload.nodeId);
      continue;
    }
    if (isEvent(e, "gate.decided")) {
      // A human decision is a STEP, not an attribute. It is the highest-quality label
      // the system ever gets, and burying it in metadata is how it stops being used.
      if (e.taskId !== undefined) {
        const s = stepFor(e.taskId);
        s.actions.push({
          kind: "gate",
          decision: e.payload.decision,
          latencyMs: e.payload.latencyMs,
          ...(e.payload.writes === undefined ? {} : { editedChannels: Object.keys(e.payload.writes).sort() }),
        });
      }
      continue;
    }

    if (e.taskId === undefined) continue;
    const s = stepFor(e.taskId);

    if (isEvent(e, "task.retry_scheduled")) {
      // THE RETRY RULE: the attempt count becomes an attribute and the failed attempt
      // leaves no step of its own. Two runs of one strategy, one of which hit a flaky
      // network, must not look like two strategies.
      s.attempts = Math.max(s.attempts, e.payload.attempt + 1);
      s.actions.length = 0;
      s.status = "open";
      continue;
    }
    if (isEvent(e, "model.called")) {
      modelCalls++;
      usage.costUsd += e.payload.usage.costUsd;
      usage.tokens += e.payload.usage.inputTokens + e.payload.usage.outputTokens;
      const node = opts.graph?.spec.nodes.find((x) => x.id === s.nodeId);
      const ref = node?.agent?.prompt ?? node?.evaluator?.ref;
      const resolved = opts.graph?.resolutionManifest.find((r) => r.ref === ref);
      s.actions.push({
        kind: "model",
        model: e.payload.model,
        ...(ref === undefined ? {} : { promptRef: ref }),
        ...(resolved === undefined ? {} : { promptDigest: resolved.digest }),
        toolCallNames: [],
        finishReason: e.payload.finishReason,
      });
      continue;
    }
    if (isEvent(e, "tool.called")) {
      toolCalls++;
      // Attribute the call to the model turn that asked for it, when there was one:
      // "which phrasing produced which tool sequence" is the question D10.c asks.
      const lastModel = [...s.actions].reverse().find((a) => a.kind === "model");
      if (lastModel !== undefined && lastModel.kind === "model") {
        (lastModel.toolCallNames as string[]).push(e.payload.name);
      }
      s.actions.push({
        kind: "tool",
        name: e.payload.name,
        version: e.payload.version,
        argsShape: e.payload.argsShape,
        ok: e.payload.ok,
        ms: e.payload.ms,
      });
      continue;
    }
    if (isEvent(e, "task.committed")) {
      s.status = e.payload.status === "succeeded" ? "succeeded" : "failed";
      s.stateOutHash = stateHash;
      s.writes = { ...e.payload.writes };
      if (e.payload.take.length > 0) s.actions.push({ kind: "route", taken: [...e.payload.take] });
      usage.costUsd += e.payload.usage.costUsd;
      continue;
    }
    if (isEvent(e, "task.skipped")) {
      s.status = "skipped";
      continue;
    }
    if (isEvent(e, "task.cancelled")) {
      s.status = "cancelled";
      continue;
    }
  }

  const nodeTypes = new Map<NodeId, NodeType>();
  for (const node of opts.graph?.spec.nodes ?? []) nodeTypes.set(node.id, node.type);

  const raw = [...steps.values()].sort(
    (a, b) =>
      compareBranch(decodeBranch(a.branchPath), decodeBranch(b.branchPath)) || byCodeUnit(a.taskId, b.taskId),
  );
  const canonical = canonicalizeBranches(raw);

  const bucket = opts.bucketInput?.(inputs) ?? digest(inputs).slice(7, 15);

  return {
    runId,
    graphHash,
    cohort: {
      workflow,
      graphHash,
      tenantTier: opts.tenantTier ?? "default",
      inputBucket: bucket,
    },
    steps: canonical.map((s) => ({
      taskId: s.taskId,
      nodeId: s.nodeId,
      nodeType: nodeTypes.get(s.nodeId) ?? "unknown",
      branchPath: s.branchPath,
      attempts: s.attempts,
      stateInHash: s.stateInHash,
      stateOutHash: s.stateOutHash,
      actions: s.actions,
      status: s.status,
      // The payload is REPLACED by its digest. Anything that wants the payload back
      // fetches it from the blob store under this key, subject to that store's rules.
      observationDigest: digest(s.writes),
    })),
    outcome: extractSignals(canonical, nodeTypes, runStatus),
    usage: { ...usage, modelCalls, toolCalls },
    policy: { escalations, violations, gatesRaised },
    inputDigest: digest(inputs),
    fromUnpromotedCandidate:
      opts.promotedGraphHashes !== undefined && !opts.promotedGraphHashes.has(graphHash),
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Re-index fan-out branches by CONTENT, not by arrival.
 *
 * Two runs that investigated the same five signals are the same strategy even if the
 * signals arrived in a different order. Sorting siblings by the digest of what they
 * actually did — and rewriting their index to that rank — makes the two folds equal.
 *
 * Deeper segments are rewritten first, so a parent's digest is computed over children
 * that are already canonical and the result does not depend on traversal order.
 */
function canonicalizeBranches(steps: readonly RawStep[]): RawStep[] {
  const depth = (p: string): number => (p === "root" ? 0 : p.split("/").length - 1);
  const maxDepth = steps.reduce((m, s) => Math.max(m, depth(s.branchPath)), 0);

  let current = steps.map((s) => ({ ...s }));
  for (let d = maxDepth; d >= 1; d--) {
    // Group the branches at this depth by (parent path, edge id) — one fan-out.
    const groups = new Map<string, Set<string>>();
    for (const s of current) {
      if (depth(s.branchPath) < d) continue;
      const prefix = s.branchPath.split("/").slice(0, d + 1).join("/");
      const b = decodeBranch(prefix);
      const seg = b.segments[b.segments.length - 1]!;
      const parent = encodeBranch({ segments: b.segments.slice(0, -1) });
      const key = `${parent} ${seg.edgeId}`;
      (groups.get(key) ?? groups.set(key, new Set()).get(key)!).add(prefix);
    }

    const rename = new Map<string, string>();
    for (const [key, members] of groups) {
      const parent = key.slice(0, key.indexOf(" "));
      const edgeId = key.slice(key.indexOf(" ") + 1);
      const ranked = [...members]
        .map((prefix) => ({ prefix, d: branchDigest(current, prefix) }))
        // Ties broken on the original path so the order is total, never arbitrary.
        .sort((a, b) => (a.d === b.d ? byCodeUnit(a.prefix, b.prefix) : a.d < b.d ? -1 : 1));
      ranked.forEach(({ prefix }, i) => {
        const parentSegs = parent === "root" ? [] : decodeBranch(parent).segments;
        rename.set(prefix, encodeBranch({ segments: [...parentSegs, { edgeId, index: i }] }));
      });
    }

    current = current.map((s) => {
      const prefix = s.branchPath.split("/").slice(0, d + 1).join("/");
      const to = rename.get(prefix);
      if (to === undefined || to === prefix) return s;
      return { ...s, branchPath: to + s.branchPath.slice(prefix.length) };
    });
  }

  return current.sort(
    (a, b) =>
      compareBranch(decodeBranch(a.branchPath), decodeBranch(b.branchPath)) || byCodeUnit(a.nodeId, b.nodeId),
  );
}

/**
 * UTF-16 code-unit order — the house rule `canonical.ts` states, applied to every tie
 * broken in this file.
 *
 * `localeCompare` is locale- and ICU-dependent (`"apple".localeCompare("Zebra")` is
 * negative; code-unit order puts `Z` at 0x5A before `a` at 0x61, and `["ä","z","a"]`
 * sorts differently under `en` and `sv`). Reading it inside a CANONICALISER is
 * nondeterminism that never passes through `ctx.effect`: two machines with different ICU
 * builds re-index the same fan-out to different branch indices, which means different
 * cohort membership and a different `isGolden` verdict for one unchanged journal.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What a branch DID — node ids and actions, never values or ids that carry order. */
function branchDigest(steps: readonly RawStep[], prefix: string): Digest {
  const inBranch = steps
    .filter((s) => s.branchPath === prefix || s.branchPath.startsWith(`${prefix}/`))
    .map((s) => [s.nodeId, s.actions.map(actionKey)] as const)
    .sort((a, b) => byCodeUnit(a[0], b[0]));
  return digest(inBranch);
}

function actionKey(a: TrajectoryAction): string {
  switch (a.kind) {
    case "model":
      return `model:${a.model}:${[...a.toolCallNames].sort().join(",")}`;
    case "tool":
      return `tool:${a.name}@${a.version}:${a.argsShape}:${a.ok}`;
    case "route":
      return `route:${[...a.taken].sort().join(",")}`;
    case "gate":
      return `gate:${a.decision}`;
  }
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

interface Verdict {
  readonly pass?: unknown;
  readonly score?: unknown;
}

function extractSignals(
  steps: readonly RawStep[],
  nodeTypes: ReadonlyMap<NodeId, NodeType>,
  runStatus: OutcomeSignals["runStatus"],
): OutcomeSignals {
  const assertions: { nodeId: NodeId; pass: boolean }[] = [];
  const rubrics: { nodeId: NodeId; score: number; pass: boolean }[] = [];
  const humanDecisions: OutcomeSignals["humanDecisions"][number][] = [];
  let selfReported = false;

  for (const s of steps) {
    for (const a of s.actions) {
      if (a.kind === "gate") {
        humanDecisions.push({ nodeId: s.nodeId, decision: a.decision, latencyMs: a.latencyMs });
      }
    }
    if (nodeTypes.get(s.nodeId) === "evaluator") {
      const v = firstVerdict(s.writes);
      if (v !== undefined) {
        const pass = v.pass === true;
        const score = typeof v.score === "number" ? v.score : pass ? 1 : 0;
        // An `assertion` evaluator is a function with real assertions (S1); a `rubric`
        // is a model judging a model (S4). The gap between them is the whole ladder,
        // so which one produced a verdict is never inferred from the verdict's shape.
        const isRubric = s.actions.some((a) => a.kind === "model");
        if (isRubric) rubrics.push({ nodeId: s.nodeId, score, pass });
        else assertions.push({ nodeId: s.nodeId, pass });
      }
    }
    if (nodeTypes.get(s.nodeId) === "agent" && s.status === "succeeded") selfReported = true;
  }

  return { assertions, humanDecisions, rubrics, selfReported, runStatus };
}

function firstVerdict(writes: Readonly<Record<string, unknown>>): Verdict | undefined {
  for (const key of Object.keys(writes).sort()) {
    const v = writes[key];
    if (v !== null && typeof v === "object" && ("pass" in v || "score" in v)) return v as Verdict;
  }
  return undefined;
}
