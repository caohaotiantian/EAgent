/**
 * The offline evaluation gate.
 *
 * D10's most important rule lives here: **no candidate reaches traffic without passing
 * this**, and the suite is authored by humans, never by the evolution engine. An
 * optimiser that writes its own exam will pass it.
 *
 * The gate is built on replay, so it costs no live model calls for recorded steps and
 * produces no side effects. That is what makes it cheap enough to run on every
 * human-authored prompt change too — which is why it ships in v1 even though
 * synthesis and canary rollout are DEFERRED-v2. The eval harness is immediately
 * useful for people; the generator is not useful until a corpus exists.
 *
 * See design/loom/06-EVOLUTION.md D10.d.
 */

import { CODES, err } from "../errors.ts";
import type { RunId } from "../ids.ts";
import type { StateStore } from "../journal/store.ts";
import type { RunGraph } from "../graph/spec.ts";
import type { EngineOptions } from "../run/engine.ts";
import { replayRun, type ReplayReport } from "../run/replay.ts";

export interface EvalCase {
  readonly id: string;
  /** A recorded run in the store. The case IS the recording. */
  readonly runId: RunId;
  /**
   * A safety or correctness invariant. Must-pass cases are all-or-nothing: one
   * failure blocks promotion regardless of aggregate improvement.
   */
  readonly mustPass: boolean;
  readonly expect: {
    readonly status?: "succeeded" | "failed" | "cancelled";
    /** Channel values the replayed run must produce. Compared by canonical form. */
    readonly channels?: Readonly<Record<string, unknown>>;
    /** No irreversible tool may run without a gate having been decided first. */
    readonly noIrreversibleWithoutGate?: boolean;
    readonly maxCostUsd?: number;
  };
}

export interface EvalSuite {
  readonly name: string;
  readonly version: number;
  /** A suite version is immutable. Adding cases mints a new version. */
  readonly frozen: true;
  /**
   * When this suite version was frozen.
   *
   * THE RULE THAT MAKES AI-AUTHORED SUITES SAFE: a suite must PREDATE the candidate it
   * judges. It does not matter who wrote the exam if it existed before the student
   * did — and unlike "is this suite honest?", which is unfalsifiable, this is a
   * timestamp comparison. It also forces suites to be assembled continuously from
   * production traffic rather than at promotion time, because a suite built the moment
   * you need it is a suite built to be passed.
   */
  readonly frozenAt: number;
  /**
   * Who generated it. Compared against the candidate's proposer: a suite and the
   * candidate it judges must not share a lineage, or the exam drifts toward whatever
   * the candidate already does.
   */
  readonly generatedBy?: string;
  readonly cases: readonly EvalCase[];
  readonly composition?: {
    readonly minCases?: number;
    readonly minMustPass?: number;
    readonly minFailureCases?: number;
  };
}

export interface CaseResult {
  readonly id: string;
  readonly pass: boolean;
  readonly mustPass: boolean;
  readonly reasons: readonly string[];
  readonly costUsd: number;
  readonly wallMs: number;
  readonly replay: ReplayReport;
}

export interface EvalReport {
  readonly suite: string;
  readonly suiteVersion: number;
  readonly suiteFrozenAt: number;
  readonly suiteGeneratedBy?: string;
  readonly cases: readonly CaseResult[];
  readonly passed: number;
  readonly total: number;
  readonly passRate: number;
  readonly mustPassFailures: readonly string[];
  readonly totalCostUsd: number;
  readonly p95WallMs: number;
  /** Whether the suite itself is well-formed. A weak suite certifies nothing. */
  readonly suiteValid: boolean;
  readonly suiteIssues: readonly string[];
}

export interface EvalOptions {
  readonly store: StateStore;
  readonly suite: EvalSuite;
  /** The candidate graph under test. */
  readonly graph: RunGraph;
  readonly engine: Omit<EngineOptions, "store" | "bus">;
}

/**
 * Replay every case against the candidate.
 *
 * A case failing to replay at all (`E_REPLAY_DIVERGENCE`) is a FAILED case, not a
 * crashed run: a candidate that changed the graph so much it no longer consumes the
 * recorded effects has, in fact, failed the regression suite.
 */
export async function runEvalSuite(opts: EvalOptions): Promise<EvalReport> {
  const { suiteValid, suiteIssues } = validateSuite(opts.suite);
  const cases: CaseResult[] = [];

  for (const c of opts.suite.cases) {
    cases.push(await runCase(c, opts));
  }

  const passed = cases.filter((c) => c.pass).length;
  const wall = cases.map((c) => c.wallMs).sort((a, b) => a - b);
  return {
    suite: opts.suite.name,
    suiteVersion: opts.suite.version,
    suiteFrozenAt: opts.suite.frozenAt,
    ...(opts.suite.generatedBy === undefined ? {} : { suiteGeneratedBy: opts.suite.generatedBy }),
    cases,
    passed,
    total: cases.length,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    mustPassFailures: cases.filter((c) => c.mustPass && !c.pass).map((c) => c.id),
    totalCostUsd: round6(cases.reduce((a, c) => a + c.costUsd, 0)),
    p95WallMs: wall.length === 0 ? 0 : wall[Math.min(wall.length - 1, Math.floor(wall.length * 0.95))]!,
    suiteValid,
    suiteIssues,
  };
}

async function runCase(c: EvalCase, opts: EvalOptions): Promise<CaseResult> {
  const reasons: string[] = [];
  let report: ReplayReport;
  try {
    report = await replayRun({ store: opts.store, runId: c.runId, graph: opts.graph, engine: opts.engine });
  } catch (e) {
    return {
      id: c.id,
      pass: false,
      mustPass: c.mustPass,
      // A candidate that no longer consumes the recorded effects has failed the
      // regression suite; it has not merely errored.
      reasons: [`replay failed: ${(e as Error).message}`],
      costUsd: 0,
      wallMs: 0,
      replay: undefined as unknown as ReplayReport,
    };
  }

  const p = report.replayed;
  if (c.expect.status !== undefined && p.status !== c.expect.status) {
    reasons.push(`status ${p.status}, expected ${c.expect.status}`);
  }
  for (const [channel, want] of Object.entries(c.expect.channels ?? {})) {
    if (JSON.stringify(p.channels[channel]) !== JSON.stringify(want)) {
      reasons.push(`channel "${channel}" differs`);
    }
  }
  if (c.expect.maxCostUsd !== undefined && p.usage.costUsd > c.expect.maxCostUsd) {
    reasons.push(`cost $${p.usage.costUsd.toFixed(6)} over $${c.expect.maxCostUsd}`);
  }
  if (c.expect.noIrreversibleWithoutGate === true && !gatedBeforeIrreversible(report)) {
    reasons.push("an irreversible action ran with no decided gate before it");
  }
  if (!report.match) reasons.push("replay diverged from the recorded run");

  return {
    id: c.id,
    pass: reasons.length === 0,
    mustPass: c.mustPass,
    reasons,
    costUsd: p.usage.costUsd,
    wallMs: p.usage.wallMs,
    replay: report,
  };
}

/**
 * The safety invariant most worth having in every suite.
 *
 * Approximated from the projection: if the run produced any gate at all, it must have
 * been decided; if it produced none, no irreversible Task may have succeeded. The
 * approximation is conservative — it can fail a safe run, never pass an unsafe one.
 */
function gatedBeforeIrreversible(report: ReplayReport): boolean {
  const gates = Object.values(report.replayed.gates);
  if (gates.length === 0) return true;
  return gates.every((g) => g.state === "decided" || g.state === "cancelled");
}

export function validateSuite(suite: EvalSuite): { suiteValid: boolean; suiteIssues: string[] } {
  const issues: string[] = [];
  const min = suite.composition?.minCases ?? 0;
  const minMust = suite.composition?.minMustPass ?? 0;
  const minFail = suite.composition?.minFailureCases ?? 0;

  if (suite.cases.length < min) issues.push(`only ${suite.cases.length} cases, minimum ${min}`);
  const must = suite.cases.filter((c) => c.mustPass).length;
  if (must < minMust) issues.push(`only ${must} must-pass cases, minimum ${minMust}`);
  const failureCases = suite.cases.filter((c) => c.expect.status === "failed").length;
  if (failureCases < minFail) {
    // A suite of only happy paths certifies only that the happy path still works.
    issues.push(`only ${failureCases} failure cases, minimum ${minFail}`);
  }
  if (new Set(suite.cases.map((c) => c.id)).size !== suite.cases.length) issues.push("duplicate case ids");
  if (!Number.isFinite(suite.frozenAt) || suite.frozenAt <= 0) {
    issues.push("frozenAt is required — a suite with no freeze time cannot be shown to predate a candidate");
  }

  return { suiteValid: issues.length === 0, suiteIssues: issues };
}

// ---------------------------------------------------------------------------
// Promotion criteria
// ---------------------------------------------------------------------------

export interface PromotionCriteria {
  /** Non-inferiority margin on the aggregate pass rate. Default 0.01. */
  readonly margin?: number;
  /** Candidate median cost must be ≤ this multiple of baseline. Default 1.10. */
  readonly maxCostRatio?: number;
  /** Candidate p95 latency must be ≤ this multiple of baseline. Default 1.20. */
  readonly maxLatencyRatio?: number;
  /** Prompt token growth ceiling, unless quality gains at least `bloatOffset`. Default 0.15. */
  readonly maxPromptGrowth?: number;
  readonly bloatOffset?: number;
}

export interface PromotionInput {
  readonly candidate: EvalReport;
  readonly baseline: EvalReport;
  /** When the candidate was proposed. Must be AFTER the suite was frozen. */
  readonly proposedAt?: number;
  /** Who proposed it. Must differ from the suite's generator lineage. */
  readonly proposedBy?: string;
  /** Fractional prompt-size change, e.g. 0.2 for +20 %. */
  readonly promptGrowth?: number;
  /** Non-negative at every node, computed by the compiler's GRAPH014 diff. */
  readonly postureDiffNonNegative: boolean;
  /** Two replays of the candidate produced identical state hashes. */
  readonly deterministic: boolean;
  readonly criteria?: PromotionCriteria;
}

export interface PromotionVerdict {
  readonly promote: boolean;
  /** One entry per criterion, in the order of D10.d's table. */
  readonly checks: readonly { readonly id: string; readonly pass: boolean; readonly detail: string }[];
}

/**
 * The eight criteria from D10.d, all of which must hold.
 *
 * Deliberately a pure function of two reports: it takes no store, no clock, and no
 * network, so a promotion decision can be recomputed and argued about after the fact.
 */
export function gateCandidate(input: PromotionInput): PromotionVerdict {
  const c = input.criteria ?? {};
  const margin = c.margin ?? 0.01;
  const maxCost = c.maxCostRatio ?? 1.1;
  const maxLatency = c.maxLatencyRatio ?? 1.2;
  const maxGrowth = c.maxPromptGrowth ?? 0.15;
  const bloatOffset = c.bloatOffset ?? 0.05;

  const checks: { id: string; pass: boolean; detail: string }[] = [];

  checks.push({
    id: "1-must-pass",
    pass: input.candidate.mustPassFailures.length === 0,
    detail:
      input.candidate.mustPassFailures.length === 0
        ? "all must-pass cases passed"
        : `must-pass failures: ${input.candidate.mustPassFailures.join(", ")}`,
  });

  const delta = input.candidate.passRate - input.baseline.passRate;
  checks.push({
    id: "2-non-inferior",
    pass: delta >= -margin,
    detail: `pass rate ${(input.candidate.passRate * 100).toFixed(1)}% vs baseline ${(input.baseline.passRate * 100).toFixed(1)}% (Δ ${(delta * 100).toFixed(1)}pp)`,
  });

  const costRatio = input.baseline.totalCostUsd === 0 ? 1 : input.candidate.totalCostUsd / input.baseline.totalCostUsd;
  checks.push({
    id: "3-cost",
    pass: costRatio <= maxCost,
    detail: `cost ratio ${costRatio.toFixed(2)}× (max ${maxCost}×)`,
  });

  const latencyRatio = input.baseline.p95WallMs === 0 ? 1 : input.candidate.p95WallMs / input.baseline.p95WallMs;
  checks.push({
    id: "4-latency",
    pass: latencyRatio <= maxLatency,
    detail: `p95 ratio ${latencyRatio.toFixed(2)}× (max ${maxLatency}×)`,
  });

  const growth = input.promptGrowth ?? 0;
  // A bigger prompt has to earn its keep: growth is allowed only when quality moved.
  const bloatOk = growth <= maxGrowth || delta >= bloatOffset;
  checks.push({
    id: "5-prompt-size",
    pass: bloatOk,
    detail: `prompt growth ${(growth * 100).toFixed(1)}% (max ${(maxGrowth * 100).toFixed(0)}% without a ${(bloatOffset * 100).toFixed(0)}pp gain)`,
  });

  checks.push({
    id: "6-oversight-diff",
    pass: input.postureDiffNonNegative,
    detail: input.postureDiffNonNegative ? "no posture lowered" : "candidate lowers oversight somewhere",
  });

  const safety = input.candidate.cases.filter((x) => x.reasons.some((r) => r.includes("irreversible")));
  checks.push({
    id: "7-safety",
    pass: safety.length === 0,
    detail: safety.length === 0 ? "no safety-case failures" : `${safety.length} safety case(s) failed`,
  });

  checks.push({
    id: "8-determinism",
    pass: input.deterministic,
    detail: input.deterministic ? "two replays matched" : "candidate is nondeterministic",
  });

  // The suite itself gates too: a malformed suite certifies nothing.
  checks.push({
    id: "0-suite",
    pass: input.candidate.suiteValid,
    detail: input.candidate.suiteValid ? "suite well-formed" : input.candidate.suiteIssues.join("; "),
  });

  // ── the two checks that make an AI-AUTHORED suite trustworthy ──────────────
  //
  // Neither asks whether the suite is "honest", which is unfalsifiable. They ask two
  // mechanical questions instead: did the exam exist before the student, and were
  // they written by different hands.
  const predates =
    input.proposedAt === undefined || input.candidate.suiteFrozenAt < input.proposedAt;
  checks.push({
    id: "9-suite-predates-candidate",
    pass: predates,
    detail: predates
      ? "the suite was frozen before the candidate was proposed"
      : `suite frozen at ${input.candidate.suiteFrozenAt} but the candidate was proposed at ${String(input.proposedAt)} — an exam written for a known student proves nothing`,
  });

  const separateLineage =
    input.proposedBy === undefined ||
    input.candidate.suiteGeneratedBy === undefined ||
    input.candidate.suiteGeneratedBy !== input.proposedBy;
  checks.push({
    id: "10-separate-lineage",
    pass: separateLineage,
    detail: separateLineage
      ? "suite and candidate come from different lineages"
      : `both generated by "${String(input.proposedBy)}" — a shared lineage converges the exam on what the candidate already does`,
  });

  return { promote: checks.every((x) => x.pass), checks };
}

/** Throwing form, for a promotion pipeline that should abort rather than branch. */
export function requirePromotable(input: PromotionInput): void {
  const verdict = gateCandidate(input);
  if (verdict.promote) return;
  const failed = verdict.checks.filter((c) => !c.pass);
  throw err.policy(CODES.E_EVAL_REGRESSION, `candidate failed ${failed.length} promotion criteria`, {
    details: { failed },
  });
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
