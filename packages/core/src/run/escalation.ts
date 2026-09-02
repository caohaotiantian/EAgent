/**
 * The automatic escalation decision table.
 *
 * This is where "oversight is a topology property" stops being a slogan. A graph author
 * declares a posture once; the rules below raise it at run time, from evidence the
 * author could not have had — a verdict that came back weak, a tool sequence nobody has
 * seen before, a run costing three times what its cohort costs.
 *
 * Two properties hold for every rule here, and they are what make the table safe to
 * extend:
 *
 * 1. **Every rule only ever TIGHTENS.** They call `escalate`, which folds by `max`. No
 *    rule can lower a posture, so adding a rule can never weaken the system — a new rule
 *    is at worst noise, never a hole. Loosening exists solely as `deescalate`, which
 *    demands a human actor and a justification.
 * 2. **Every rule names itself in the journal.** `policy.escalated{rule}` is how an
 *    operator answers "why is this suddenly asking me?", and a rule that fires anonymously
 *    is indistinguishable from a bug.
 *
 * The evidence sources are INJECTED (`SequenceIndex`, `CohortBaseline`) rather than
 * imported, because E5 and E7 need historical data the executor has no business owning.
 * A deployment with no history supplies nothing and those two rules simply never fire —
 * which is correct: neither has anything to say about the first run of a new graph.
 *
 */

import type { NodeId } from "../ids.ts";
import type { Posture } from "../vocab.ts";

export type EscalationRuleId =
  | "low_confidence"
  | "budget_warning"
  | "budget_exhausted"
  | "repeated_failure"
  | "novel_sequence"
  | "violation"
  | "anomaly"
  | "taint"
  | "operator"
  | "mutation_introduced_irreversible"
  | "fanout_skipped_gate";

export interface EscalationRule {
  readonly id: EscalationRuleId;
  /** The table row in D7.7, for cross-referencing a journal entry with the design. */
  readonly code: `E${number}`;
  readonly to: Posture;
  readonly scope: "run" | "node";
  readonly why: string;
}

/**
 * The table, as data.
 *
 * Data rather than scattered string literals so that "which rules exist" is answerable
 * by reading one array, and so a journal entry's `rule` can be looked up rather than
 * grepped for.
 */
export const ESCALATION_RULES: Readonly<Record<EscalationRuleId, EscalationRule>> = {
  low_confidence: {
    id: "low_confidence",
    code: "E1",
    to: "on",
    scope: "run",
    why: "an evaluator scored below its declared threshold",
  },
  budget_warning: {
    id: "budget_warning",
    code: "E2",
    to: "on",
    scope: "run",
    why: "the run has consumed 80% of its budget",
  },
  budget_exhausted: {
    id: "budget_exhausted",
    code: "E3",
    to: "in",
    scope: "run",
    why: "the budget is exhausted and the graph asked to gate rather than fail",
  },
  repeated_failure: {
    id: "repeated_failure",
    code: "E4",
    to: "on",
    scope: "node",
    why: "three consecutive tool failures on one node",
  },
  novel_sequence: {
    id: "novel_sequence",
    code: "E5",
    to: "on",
    scope: "node",
    why: "this node called a tool sequence never seen in a successful run of this graph",
  },
  violation: {
    id: "violation",
    code: "E6",
    to: "in",
    scope: "run",
    why: "a capability was denied, a sandbox killed, or an egress was blocked",
  },
  anomaly: {
    id: "anomaly",
    code: "E7",
    to: "on",
    scope: "run",
    why: "cost, tokens, or wall-clock exceeded the cohort's p99",
  },
  taint: {
    id: "taint",
    code: "E8",
    to: "in",
    scope: "node",
    why: "untrusted tool output is feeding a hard-to-undo action",
  },
  operator: {
    id: "operator",
    code: "E9",
    to: "in",
    scope: "run",
    why: "an operator interrupted during an intervention window",
  },
  mutation_introduced_irreversible: {
    id: "mutation_introduced_irreversible",
    code: "E10",
    to: "in",
    scope: "node",
    why: "a runtime graph mutation added a hard-to-undo node",
  },
  /**
   * E12 — A FAN-OUT OF WIDTH ZERO SKIPPED AN AUTHORED `human_gate`.
   *
   * E12 AND NOT E11: D7.7 reserves E11 for provider fall-through, which `providers/fallback.ts`
   * still names in its `onFallback` docstring and which nothing here builds. Reusing the number
   * would put two different rules behind one `code` in the one table an operator looks a journal
   * entry up in.
   *
   * The width of a fan is a runtime value, usually one a tool fetched, so it is the one way a
   * node that STATICALLY dominates an action does not run in front of it: `#fireEmptyJoin`
   * schedules the join directly and every node on the branch — the gate included — is passed
   * over. Nothing is wrong with the barrier; what is missing is the human. The escalation lands
   * on the JOIN, which is the node that releases the downstream the gate was in front of, so
   * somebody is asked exactly once and the run continues on approval rather than failing.
   */
  fanout_skipped_gate: {
    id: "fanout_skipped_gate",
    code: "E12",
    to: "in",
    scope: "node",
    why: "a fan-out planned zero branches, skipping a human gate the graph declared on the branch",
  },
};

export function scopeOf(rule: EscalationRule, runId: string, nodeId?: NodeId): string {
  return rule.scope === "run" || nodeId === undefined ? `run:${runId}` : `node:${runId}/${nodeId}`;
}

// ---------------------------------------------------------------------------
// E5 — novel tool sequence
// ---------------------------------------------------------------------------

/**
 * The ordered tool n-gram a node produced.
 *
 * Ordered and NOT deduplicated: `[read, write, read]` is a different strategy from
 * `[read, write]`, and collapsing them would make the most interesting novelty —
 * a loop that did not used to loop — invisible.
 */
export function toolNGram(toolNames: readonly string[]): string {
  return toolNames.join(">");
}

export interface SequenceIndex {
  /**
   * Has this (node, n-gram) been seen in a SUCCESSFUL run of this graph version?
   *
   * "Successful" matters: indexing failed runs would teach the index that the sequence
   * which broke production is normal, and E5 would then stay quiet the next time.
   */
  hasSeen(graphHash: string, nodeId: NodeId, ngram: string): boolean;
}

/** A `SequenceIndex` over trajectories already folded. */
export class InMemorySequenceIndex implements SequenceIndex {
  readonly #seen = new Set<string>();

  static key(graphHash: string, nodeId: NodeId, ngram: string): string {
    return `${graphHash}|${nodeId}|${ngram}`;
  }

  record(graphHash: string, nodeId: NodeId, ngram: string): void {
    this.#seen.add(InMemorySequenceIndex.key(graphHash, nodeId, ngram));
  }

  hasSeen(graphHash: string, nodeId: NodeId, ngram: string): boolean {
    return this.#seen.has(InMemorySequenceIndex.key(graphHash, nodeId, ngram));
  }

  get size(): number {
    return this.#seen.size;
  }
}

// ---------------------------------------------------------------------------
// E7 — anomaly
// ---------------------------------------------------------------------------

export interface CohortBaseline {
  /** p99 of the last N runs of this graph version, or `undefined` when there is no history. */
  p99(graphHash: string, metric: "costUsd" | "tokens" | "wallMs"): number | undefined;
}

export interface AnomalyReading {
  readonly metric: "costUsd" | "tokens" | "wallMs";
  readonly value: number;
  readonly p99: number;
  /** How many times over the p99 — the number an operator actually wants to see. */
  readonly ratio: number;
}

/**
 * The first metric that exceeds its p99, if any.
 *
 * FIRST rather than all: escalation is a single decision, and one breach is enough to
 * make it. Reporting the first keeps the journal entry short and its cause unambiguous.
 */
export function detectAnomaly(
  baseline: CohortBaseline,
  graphHash: string,
  usage: { readonly costUsd: number; readonly tokens: number; readonly wallMs: number },
): AnomalyReading | undefined {
  const metrics = [
    { metric: "costUsd", value: usage.costUsd },
    { metric: "tokens", value: usage.tokens },
    { metric: "wallMs", value: usage.wallMs },
  ] as const;

  for (const { metric, value } of metrics) {
    const p99 = baseline.p99(graphHash, metric);
    // No history ⇒ no anomaly. A p99 of one run is a number about nothing, and firing on
    // it would make every new graph escalate on its second run.
    if (p99 === undefined || p99 <= 0) continue;
    if (value > p99) return { metric, value, p99, ratio: value / p99 };
  }
  return undefined;
}

/** A `CohortBaseline` from observed samples. */
export class InMemoryCohortBaseline implements CohortBaseline {
  readonly #samples = new Map<string, number[]>();
  readonly #window: number;

  /** `window` caps the history per (graph, metric) — D7.7 says the last 100 runs. */
  constructor(window = 100) {
    this.#window = window;
  }

  record(graphHash: string, metric: string, value: number): void {
    const key = `${graphHash}|${metric}`;
    const list = this.#samples.get(key) ?? [];
    list.push(value);
    if (list.length > this.#window) list.shift();
    this.#samples.set(key, list);
  }

  p99(graphHash: string, metric: "costUsd" | "tokens" | "wallMs"): number | undefined {
    const list = this.#samples.get(`${graphHash}|${metric}`);
    // Under 10 samples a "p99" is the maximum wearing a hat. Refusing to answer is more
    // honest than answering with the largest thing seen so far.
    if (list === undefined || list.length < 10) return undefined;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  }
}

// ---------------------------------------------------------------------------
// E4 — consecutive failures
// ---------------------------------------------------------------------------

export const REPEATED_FAILURE_THRESHOLD = 3;

/**
 * Consecutive failures per node, reset by any success.
 *
 * CONSECUTIVE, not cumulative: a node that fails once an hour all day is flaky, and a
 * node that has just failed three times in a row is broken. Only the second is evidence
 * that a human should look now.
 */
export class FailureStreaks {
  readonly #streaks = new Map<NodeId, number>();

  record(nodeId: NodeId, ok: boolean): number {
    if (ok) {
      this.#streaks.delete(nodeId);
      return 0;
    }
    const next = (this.#streaks.get(nodeId) ?? 0) + 1;
    this.#streaks.set(nodeId, next);
    return next;
  }

  streak(nodeId: NodeId): number {
    return this.#streaks.get(nodeId) ?? 0;
  }

  breached(nodeId: NodeId): boolean {
    return this.streak(nodeId) >= REPEATED_FAILURE_THRESHOLD;
  }
}

// ---------------------------------------------------------------------------
// E1 — low confidence
// ---------------------------------------------------------------------------

/**
 * Did an evaluator come back below its threshold?
 *
 * ABSENCE IS NOT FAILURE. A verdict with no numeric score has not scored low; it has not
 * scored. Treating a missing score as 0 would escalate every run whose evaluator returned
 * a bare `{pass: true}`, and an escalation that fires constantly is one people learn to
 * ignore.
 */
export function isLowConfidence(verdict: unknown, threshold: number): boolean {
  if (verdict === null || typeof verdict !== "object") return false;
  const score = (verdict as { score?: unknown }).score;
  if (typeof score !== "number" || !Number.isFinite(score)) return false;
  return score < threshold;
}
