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
 */

import { digest, shapeOf, type Digest } from "../canonical.ts";
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
  /**
   * The CHANNEL NAMES this step committed, sorted. Never the values — those are behind
   * `observationDigest`, and a name is graph structure that `graphHash` already states.
   *
   * It is here because it is the only evidence in a journal that a `function`, `tool` or
   * `router` node PRODUCED anything: those nodes bill nothing (`#runFunction` returns
   * `ZERO_USAGE` and appends no `tool.called`), so a fold that counts only model and tool
   * calls reads a whole function-only workflow as a run that did nothing. Measured on a real
   * Engine before this field existed: a one-`function` graph that committed its declared
   * output folded to `modelCalls 0, toolCalls 0`, scored 0, and was dropped from its own
   * cohort — the same verdict as a body that returned `{}`.
   */
  readonly channelsWritten: readonly string[];
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
    /**
     * DISTINCT CHILD RUNS THIS RUN DELEGATED TO — the `childRunId`s named by
     * `subgraph.started`, counted once each however many attempts named them.
     *
     * A parent's journal holds none of the child's `model.called` or `tool.called` rows by
     * design — that is what keeps a parent's journal the size of the parent — so without
     * this counter the multi-agent shape is indistinguishable from a run that called
     * nothing. Measured on a real Engine before it existed: a parent of one `subgraph` node
     * over a child of one `agent` node folded to `modelCalls 0, toolCalls 0` and scored 0
     * while the identical INLINE graph scored 0.200.
     *
     * `subgraph.started` and not `subgraph.completed`: the engine appends the second on the
     * success path only (`run/engine.ts:3958`), and a child that ran and failed still ran.
     */
    readonly subgraphRuns: number;
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
  /**
   * Buckets an input into a comparable class — "a small diff", "this tenant", "a nightly".
   *
   * Default: `shape:<digest of shapeOf(inputs)>`. See `defaultBucket` for why the default is
   * the input's SHAPE and not its value, and what that costs.
   *
   * This is the seam a deployment overrides when shape is the wrong grain — either too
   * coarse (one shape covering work of wildly different size) or too fine (a config object
   * whose keys vary run to run). `loom score --bucket` is the one that ships; anything with
   * the same signature works, and the only rule is that the value must be DERIVED and short.
   * It ends up in `cohortKey`, which is journaled into `evolution.scored`, so returning an
   * input VALUE here would put production data in the journal — the same reason a step
   * records `argsShape` and not arguments.
   */
  readonly bucketInput?: (inputs: Readonly<Record<string, unknown>>) => string;
  /**
   * Graph hashes a human approved. Anything else — INCLUDING not answering — marks the run as
   * candidate output.
   *
   * Answer it. It reads as optional because `agent()` and the workflow tests fold journals for
   * inspection rather than for the corpus, and a required field there would be ceremony; but a
   * caller that does not name the promoted set has not certified anything, and the fold now
   * says so. It used to say the opposite: `promotedGraphHashes !== undefined && !has(hash)` is
   * `false` when the option is omitted, i.e. "produced by a promoted graph", so golden
   * condition 5 — the one that stops the loop training on its own unreviewed output — passed
   * vacuously for every caller in the tree.
   */
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
  let runTotal: UsageRecord | undefined;
  const childRuns = new Set<string>();
  let stateHash = "";
  /**
   * SPEND IS FOLDED FROM THE EFFECT RECORDS, AND A RESTATEMENT CAN ONLY RAISE THE TOTAL —
   * the same four arms, in the same order, as `run/projection.ts`'s `chargeUsage`.
   *
   * | Record | Contributes | Appended |
   * |---|---|---|
   * | `model.called` | the turn's whole bill | once per model turn |
   * | `tool.called` | `ms` only, and NOT through `charge` — see below | once per tool call |
   * | `subgraph.completed` | the CHILD run's whole `usage` | once, when a child run SUCCEEDS |
   * | `task.committed` / `run.completed` | only the EXCESS over what is already counted | a restatement |
   *
   * The excess arm is the fix, and it is not the old defect coming back. Reading
   * `task.committed.usage` VERBATIM was a regression, because that number is a per-ATTEMPT
   * summary that under-states spend twice in the rewarding direction: it is `ZERO_USAGE`
   * whenever an exception leaves `#executeTask` (`run/engine.ts:2487` discards every turn
   * already paid for), and it is not appended at all for an attempt that is retried
   * (`engine.ts:4565` writes `task.retry_scheduled` and no commit). Charging only
   * `max(0, stated − seen)` componentwise, against a `seen` that is cumulative PER TASK,
   * keeps both of those at zero — a commit that merely restates the `model.called` rows
   * contributes nothing — while keeping the one dollar the journal states on a commit and
   * nowhere else.
   *
   * THAT DOLLAR IS A FAILED SUBGRAPH'S CHILD SPEND. Dropping it was a 500× under-count in
   * the loosening direction — a defect INTRODUCED by an earlier fix round here, not inherited:
   * at `86b84c9` this fold charged `task.committed` too and over-counted instead.
   * `engine.ts:3958` appends `subgraph.completed` on the SUCCESS path
   * alone, so a failed subgraph states its child's cost on the failing `task.committed`
   * (`engine.ts:3905`) or nowhere. MEASURED on one real Engine — a child that burns $5.00, a
   * subgraph task that fails, an error edge to a $0.01 fallback agent, run succeeds — this fold
   * read $0.01 against a projection of $5.01. Since cost is 20% of the score, the dominant
   * move against the metric was *fail your subgraph and look cheap*, which is precisely the
   * measurement gamed by the thing being measured that CLAUDE.md forbids.
   *
   * WHAT THIS STILL CANNOT SEE, because no record in a parent's journal carries it:
   *
   * - The TOKENS of a failed subgraph. `engine.ts:3905` builds that commit's usage as
   *   `{...ZERO_USAGE, costUsd, wallMs}`, so the child's token count is stated nowhere in the
   *   parent. Measured on the fixture above: `costUsd` 5.01 and `tokens` 10,000 — the
   *   fallback's alone. Cost and wall time are right; tokens read low.
   * - A subgraph whose parent Task never commits at all — an exception out of `#executeTask`
   *   returns `ZERO_USAGE` — leaves no row stating the child's spend.
   *
   * Both are the same engine gap, and the honest fix is upstream: append `subgraph.completed`
   * on the failure path too, carrying `childP.usage` whole. This fold cannot do it from here.
   *
   * ── TOOL TIME, and why it is not an arm ─────────────────────────────────────
   *
   * `tool.called.ms` is added to the reported `wallMs` and DELIBERATELY NOT to `seen`. A
   * `UsageRecord` is a statement about PROVIDER work — `run.completed.usage` and
   * `subgraph.completed.usage` are copied verbatim between runs — and it never contains local
   * tool latency, so folding tool time into `seen` would mask real excess in a restatement.
   * This `wallMs` still includes it, because it feeds a LATENCY term meant to measure what the
   * run burned and thirty seconds in a tool is burned. `RunProjection.usage.wallMs` excludes
   * it. **Expect this `wallMs` to be the larger; that is not a disagreement.** `costUsd`, by
   * contrast, is now the SAME NUMBER as the projection's on every path, which is a property a
   * test pins rather than a claim this comment makes.
   */
  const spend = { costUsd: 0, inputTokens: 0, outputTokens: 0, wallMs: 0 };
  const seen = new Map<TaskId, Spend>();
  /** Tool latency: reported, never `seen`. See above. */
  let toolMs = 0;
  const charge = (taskId: TaskId | undefined, u: Spend): void => {
    const a = finiteSpend(u);
    spend.costUsd += a.costUsd;
    spend.inputTokens += a.inputTokens;
    spend.outputTokens += a.outputTokens;
    spend.wallMs += a.wallMs;
    if (taskId === undefined) return;
    seen.set(taskId, addSpend(seen.get(taskId) ?? ZERO_SPEND, a));
  };

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
      // A FLOOR, NOT AN ARM. `run.completed.usage` is the run total the engine copies out of
      // `p.usage`, so adding it outright double-counted every dollar; charged as excess AFTER
      // the fold it can only raise a total the per-call records under-state, never inflate one
      // they already state. Applied after the loop so the answer does not depend on this event
      // being last.
      runTotal = e.payload.usage;
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
      // A RETRY CLEARS THE ACTIONS A RETRY INVALIDATES — AND NOT THE HUMAN'S ANSWER. This
      // was `s.actions.length = 0`, which also deleted the `gate` action, because
      // `gate.decided` is journaled on the very Task that then retries. MEASURED on a real
      // Engine (`test/evolution/gate-retry.test.ts`): under the `in` posture floor a `tool`
      // node raises its own gate on its own Task, and a transient tool failure on the
      // attempt after the approval appends `task.retry_scheduled` to that same Task —
      // `9 gate.decided write@root#0`, `15 task.retry_scheduled write@root#0`. The fold
      // read back `humanDecisions: []` and a `draft` ceiling for a run a human had
      // approved; the identical non-flaky run read `approve` and `stable`.
      //
      // The failed attempt's model and tool calls really are invalid — that is the rule at
      // the top of this file, and two runs of one strategy must not fork on a flaky
      // network. A human's decision is not an attempt. It was made about the TASK, it is
      // the highest-quality label the system ever gets, and a retry is not new information
      // about it. A `route` cannot be here: it is appended by `task.committed`, and a
      // retried attempt never commits.
      s.actions = s.actions.filter((a) => a.kind === "gate");
      s.status = "open";
      continue;
    }
    if (isEvent(e, "model.called")) {
      modelCalls++;
      // The turn's whole bill, counted where the call is recorded. See `spend` above.
      charge(e.taskId, e.payload.usage);
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
      // No cost — a tool call's only price in the journal is its wall time, and that time is
      // reported without ever entering `seen`. See `spend` above.
      toolMs += typeof e.payload.ms === "number" && Number.isFinite(e.payload.ms) && e.payload.ms > 0 ? e.payload.ms : 0;
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
      // A RESTATEMENT, CHARGED AS EXCESS — never verbatim. See `spend` above for why the
      // difference is the whole fix: verbatim under-counts, excess recovers a failed
      // subgraph's child spend and contributes nothing on every other path.
      charge(e.taskId, excessSpend(seen.get(e.taskId) ?? ZERO_SPEND, e.payload.usage));
      continue;
    }
    if (isEvent(e, "subgraph.started")) {
      // DELEGATION IS WORK, and this is the only row in a PARENT's journal that says a child
      // run existed. Counted by `childRunId` so a subgraph re-entered by the parent's retry
      // policy is one child, not several. See `Trajectory.usage.subgraphRuns`.
      childRuns.add(e.payload.childRunId);
      continue;
    }
    if (isEvent(e, "subgraph.completed")) {
      // The child's own `model.called` rows are in the CHILD's journal, so this adds that
      // run's spend to the parent exactly once rather than twice. The commit that follows
      // restates the same money and is charged as excess, so it adds nothing.
      charge(e.taskId, e.payload.usage);
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

  // The floor, applied once the per-call arms are all in. See `run.completed` above.
  if (runTotal !== undefined) charge(undefined, excessSpend(spend, runTotal));

  const nodeTypes = new Map<NodeId, NodeType>();
  for (const node of opts.graph?.spec.nodes ?? []) nodeTypes.set(node.id, node.type);

  const raw = [...steps.values()].sort(
    (a, b) =>
      compareBranch(decodeBranch(a.branchPath), decodeBranch(b.branchPath)) || byCodeUnit(a.taskId, b.taskId),
  );
  const canonical = canonicalizeBranches(raw);

  const bucket = opts.bucketInput?.(inputs) ?? defaultBucket(inputs);

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
      // NAMES, never values — the values are the digest below. See `channelsWritten`.
      channelsWritten: Object.keys(s.writes).sort(byCodeUnit),
      // The payload is REPLACED by its digest. Anything that wants the payload back
      // fetches it from the blob store under this key, subject to that store's rules.
      observationDigest: digest(s.writes),
    })),
    outcome: extractSignals(canonical, nodeTypes, runStatus),
    usage: {
      costUsd: spend.costUsd,
      tokens: spend.inputTokens + spend.outputTokens,
      // Provider wall time PLUS local tool time. See `spend` above for why only one of the
      // two ever reaches `seen`.
      wallMs: spend.wallMs + toolMs,
      modelCalls,
      toolCalls,
      subgraphRuns: childRuns.size,
    },
    policy: { escalations, violations, gatesRaised },
    inputDigest: digest(inputs),
    // FAILS CLOSED: an unanswered promotion set is not a certificate of promotion.
    fromUnpromotedCandidate:
      opts.promotedGraphHashes === undefined || !opts.promotedGraphHashes.has(graphHash),
  };
}

/**
 * THE DEFAULT BUCKET IS THE INPUT'S SHAPE, and this is the difference between a promotion
 * path that exists and one that is arithmetic nobody can reach.
 *
 * It used to be `digest(inputs).slice(7, 15)` — a digest of the whole input — so two runs
 * were comparable only if their inputs were byte-identical. `isGolden` condition 4 needs 30
 * comparable runs, and a code-review workflow reviews a different diff every time, so for
 * every workflow whose inputs vary the cohort was permanently one. Measured on five live
 * GLM-5.2 runs of one graph over five diffs: five distinct cohort keys, every one `n = 1`,
 * `goldenBlockers: ["cohort large enough: n = 1 (need ≥ 30)"]`. Nothing was wrong with the
 * scoring; the corpus could not assemble.
 *
 * `shapeOf` is already this file's privacy rule one level up — a step records `argsShape`,
 * never arguments — and it is the same claim here: STRUCTURE generalises and values do not.
 * `{diff:string}` is every run of a review workflow, which is exactly the set a person means
 * by "the same kind of problem".
 *
 * WHAT IT COSTS, MEASURED. A ten-line diff and a ten-thousand-line diff have one shape, so
 * `p50Cost` and `p50Wall` become medians over genuinely different work. Five real Engine runs
 * of the walking skeleton over one to five documents (`test/evolution/cohort-bucket.test.ts`)
 * now form ONE cohort of 5, with costs $0.000075 → $0.000375 around a p50 of $0.000225 — a 5x
 * spread inside one cohort. Five runs whose OUTCOME is identical (1.000 each) score
 * `0.833 0.767 0.700 0.700 0.700` instead of `0.700` five times: the cost term now reflects
 * input size as well as quality, and that is the noise this trade buys.
 *
 * AND WHAT THE OLD DEFAULT COST, which is larger. `costNormalized` is
 * `clamp01(cost / cohort.p50Cost)` and the term is `weights.cost * (1 - costNormalized)`, so in
 * a cohort of ONE a run is compared against itself: `costNormalized` is exactly 1 — measured
 * `[1, 1, 1, 1, 1]` for those same five runs scored alone — and the cost term contributes
 * exactly 0, so all five scored `0.700`. Not because the ruler was precise: because 20% of the
 * metric was structurally dead. `latencyNormalized` is the same construction over `p50Wall`
 * and goes the same way on any run whose wall time is non-zero. A noisier ruler that exists
 * beats an exact one no two runs ever stand on, and `bucketInput` is the seam for a deployment
 * that needs finer.
 *
 * WHAT IT DOES NOT DO: it is not a constant. A different input shape is still a different
 * cohort, which is what stops "make the cohort big enough" from becoming "compare everything
 * to everything".
 *
 * Digested rather than used raw: `shapeOf` on an array union emits `|`, which is
 * `cohortKeyOf`'s own separator, and a shape string is unbounded in length. The `shape:`
 * prefix is deliberate — a cohort key that does not say which rule produced its bucket cannot
 * be compared across a change to that rule, the same reason `weightsDigest` rides with a
 * score. A bucket rule change reads as a different cohort instead of silently merging.
 *
 * No migration: a `Trajectory` is a pure fold, so historical journals re-derive under the new
 * rule the moment they are folded again.
 */
function defaultBucket(inputs: Readonly<Record<string, unknown>>): string {
  return `shape:${digest(shapeOf(inputs)).slice(7, 15)}`;
}

// ---------------------------------------------------------------------------
// Spend arithmetic
// ---------------------------------------------------------------------------

/** The four numbers a `UsageRecord` carries, as a mutable-free local. */
interface Spend {
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wallMs: number;
}

const ZERO_SPEND: Spend = { costUsd: 0, inputTokens: 0, outputTokens: 0, wallMs: 0 };

/**
 * A journal is written by an appender, and the types are a claim about that appender rather
 * than about the bytes — a hand-written, replayed or corrupted row can carry `NaN`, a
 * negative, or a string. One `NaN` dollar makes `costUsd` `NaN` for the rest of the fold, and
 * every comparison against `NaN` is false, so a cohort's `p50Cost` and every score computed
 * against it silently stop meaning anything. A non-finite component is dropped, and a negative
 * one is dropped too: a refund is the direction that loosens. `run/projection.ts` fails closed
 * the same way, for the same reason on the budget side.
 */
function finiteSpend(u: Spend | UsageRecord | undefined): Spend {
  if (u === null || typeof u !== "object") return ZERO_SPEND;
  const ok = (x: number): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  return {
    costUsd: ok(u.costUsd),
    inputTokens: ok(u.inputTokens),
    outputTokens: ok(u.outputTokens),
    wallMs: ok(u.wallMs),
  };
}

function addSpend(a: Spend, b: Spend): Spend {
  return {
    costUsd: a.costUsd + b.costUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    wallMs: a.wallMs + b.wallMs,
  };
}

/** Componentwise `max(0, stated − seen)`: the part of a restatement nothing has counted. */
function excessSpend(seen: Spend, stated: UsageRecord | undefined): Spend {
  const over = (a: number, b: number): number => (b > a ? b - a : 0);
  const s = finiteSpend(stated);
  return {
    costUsd: over(seen.costUsd, s.costUsd),
    inputTokens: over(seen.inputTokens, s.inputTokens),
    outputTokens: over(seen.outputTokens, s.outputTokens),
    wallMs: over(seen.wallMs, s.wallMs),
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
