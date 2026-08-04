/**
 * Incident triage — the second real workflow.
 *
 * The walking skeleton proved the architecture. This proves the *product*: it is the
 * workflow the design sketches in D10.c, built against the real engine, and it is here
 * rather than in `test/` because a workflow is data — something a user runs, not a
 * fixture.
 *
 * It exists to reach the node types and edge kinds the skeleton structurally cannot.
 * That distinction has repeatedly mattered: the authoring graph found two defects the
 * skeleton could not, because it had a loop and a permissive output schema. This one
 * has a **router**, an **assertion evaluator**, an **error edge**, and a
 * **compensation edge** — four surfaces no earlier workflow exercised end to end.
 *
 * ```
 *   ingest ─fanout(signals, ≤8)→ investigate ─join(all, skip)→ correlate
 *                                     └─error→ quarantine ─join→ correlate
 *   correlate → assess (assertion evaluator) → triage (router)
 *       ├─ severity ≥ 0.7 → remediate (irreversible tool ⇒ gates by default)
 *       ├─ severity < 0.7 → notify   (externally visible ⇒ gates by default)
 *       └─ fallback       → escalate (human_gate)
 *   remediate ─error→ escalate ; remediate ─compensation→ rollback
 *   remediate | notify | escalate → report
 * ```
 *
 * Every hard-to-undo step gates because of what it IS, not because the graph asked:
 * `CLASS_DEFAULT_POSTURE` maps `irreversible` and `externally_visible` to `in`, and the
 * posture fold takes a `max`. The graph declares `posture: "out"` and it changes nothing
 * — which is the asymmetry rule visible in a real workflow.
 */

import type { GraphSpec } from "../graph/spec.ts";
import type { ToolManifestLite } from "../graph/validate.ts";
import type { EdgeId, NodeId } from "../ids.ts";

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

export const INCIDENT_CAPABILITIES = ["k8s:read", "k8s:write", "obs:read", "chat:write"];

/** Manifests for the tools the workflow calls. Irreversibility drives the posture. */
export const INCIDENT_TOOLS: Readonly<Record<string, ToolManifestLite>> = {
  "k8s.describe": { name: "k8s.describe", version: "1.0", capabilities: ["k8s:read"], irreversibility: "read_only", idempotent: true },
  "k8s.logs": { name: "k8s.logs", version: "1.0", capabilities: ["k8s:read"], irreversibility: "read_only", idempotent: true },
  "obs.query": { name: "obs.query", version: "1.0", capabilities: ["obs:read"], irreversibility: "read_only", idempotent: true },
  "k8s.restart": {
    name: "k8s.restart",
    version: "1.0",
    capabilities: ["k8s:write"],
    irreversibility: "irreversible",
    idempotent: false,
    // Named so GRAPH012 accepts the compensation edge: a rollback target must exist
    // before an irreversible step is allowed to declare one.
    compensation: { tool: "k8s.rollback" },
  },
  "k8s.rollback": { name: "k8s.rollback", version: "1.0", capabilities: ["k8s:write"], irreversibility: "reversible_write", idempotent: true },
  "chat.post": { name: "chat.post", version: "1.0", capabilities: ["chat:write"], irreversibility: "externally_visible", idempotent: false },
};

export function incidentTriageSpec(over: Partial<GraphSpec> = {}): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "incident-triage", project: "sre", version: 1 },
    policy: {
      // `out` deliberately. Every gate this workflow raises comes from what the tools
      // ARE, not from the graph asking nicely — which is the point being demonstrated.
      posture: "out",
      budget: { costUsd: 2.0, tokens: 400_000, wallMs: 300_000 },
      expansion: { maxNodes: 64, maxDepth: 1, maxFanout: 8, maxLoopIterations: 1 },
      capabilities: INCIDENT_CAPABILITIES,
    },
    channels: {
      alert: { type: "object", reduce: "replace" },
      signals: { type: "array", reduce: "replace" },
      signal: { type: "object", reduce: "replace" },
      // Ordered by branch coordinate, so a report reads the same way every time even
      // though the branches finish in whatever order the cluster answers in.
      findings: { type: "array", reduce: "append_ordered" },
      verdict: { type: "object", reduce: "replace" },
      // A LIST, not a `replace` object. Four arms write it, and a run that remediated
      // and was then rolled back took two actions — squashing them into one slot loses
      // the rollback, which is the record that matters most. The compiler said so:
      // `replace` is not multi-writer safe, and GRAPH010 refused the graph until this
      // was modelled honestly.
      action: { type: "array", reduce: "append_ordered", initial: [] },
      report: { type: "object", reduce: "replace" },
      costUsd: { type: "number", reduce: "sum", initial: 0 },
    },
    inputs: ["alert"],
    outputs: ["report"],
    nodes: [
      {
        id: n("ingest"),
        type: "function",
        reads: ["alert"],
        writes: ["signals"],
        function: { ref: "function/extract-signals@stable" },
      },
      {
        id: n("investigate"),
        type: "agent",
        reads: ["signal"],
        writes: ["findings", "costUsd"],
        agent: {
          profile: "agent_profile/sre-investigator@stable",
          prompt: "prompt/investigate-signal@stable",
          maxTurns: 4,
          tools: ["k8s.describe", "k8s.logs", "obs.query"],
          outputSchema: {
            type: "object",
            properties: {
              pod: { type: "string" },
              cause: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["pod", "cause", "confidence"],
          },
        },
        // Per-branch, and 8 × 0.2 = 1.6 ≤ the run's 2.0 — GRAPH009 checks that sum at
        // compile, so a fan-out cannot promise more than the run can pay.
        policy: { budget: { costUsd: 0.2 } },
        retry: { maxAttempts: 2, backoff: "exponential", initialMs: 50 },
        timeoutMs: 60_000,
      },
      {
        id: n("quarantine"),
        type: "function",
        reads: ["signal"],
        writes: ["findings"],
        function: { ref: "function/quarantine-signal@stable" },
      },
      {
        id: n("correlate"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        // `skip` because one unreachable pod must not lose the other four
        // investigations. The trajectory still records that a branch was skipped.
        join: { branches: [n("investigate"), n("quarantine")], mode: "all", onBranchError: "skip", timeoutMs: 120_000 },
      },
      {
        id: n("assess"),
        type: "evaluator",
        reads: ["findings"],
        writes: ["verdict"],
        // An ASSERTION, not a rubric: a deterministic function over the findings. This
        // is the S1 signal the evolution loop scores on, and the only one a model
        // cannot argue with.
        evaluator: { kind: "assertion", ref: "function/assess-severity@stable", threshold: 0.7 },
      },
      {
        id: n("triage"),
        type: "router",
        reads: ["verdict"],
        router: {
          mode: "expression",
          cases: [
            // `has()` first: absence makes every ordering comparison false, so without
            // the guard an empty verdict would silently take the low-severity path.
            { when: "has(verdict) && verdict.severity >= 0.7", take: [e("to-remediate")] },
            // `severity > 0` is the real predicate: SOME evidence, but not enough to act
            // on. A verdict of exactly zero means every investigation failed or there was
            // nothing to investigate, and that is a human's call — not a chat message
            // saying everything looks fine.
            { when: "has(verdict) && verdict.severity > 0 && verdict.severity < 0.7", take: [e("to-notify")] },
          ],
          fallbackEdge: e("to-escalate"),
        },
      },
      {
        id: n("remediate"),
        type: "tool",
        reads: ["verdict"],
        writes: ["action"],
        tool: { name: "k8s.restart", version: "1.0", args: { pod: "${verdict.pod}" } },
        retry: { maxAttempts: 1 },
        checkpoint: "both",
      },
      {
        id: n("rollback"),
        type: "tool",
        reads: ["action"],
        writes: ["action"],
        tool: { name: "k8s.rollback", version: "1.0", args: { pod: "${verdict.pod}" } },
        unhandled: true,
      },
      {
        id: n("notify"),
        type: "tool",
        reads: ["verdict"],
        writes: ["action"],
        tool: { name: "chat.post", version: "1.0", args: { channel: "#sre", text: "${verdict.summary}" } },
        unhandled: true,
      },
      {
        id: n("escalate"),
        type: "human_gate",
        reads: ["verdict"],
        writes: ["action"],
        humanGate: { ref: "oversight/sre-escalation@stable" },
        checkpoint: "before",
      },
      {
        id: n("report"),
        type: "function",
        reads: ["findings", "verdict", "action"],
        writes: ["report"],
        function: { ref: "function/write-report@stable" },
      },
    ],
    edges: [
      { id: e("fan"), from: n("ingest"), to: n("investigate"), kind: "fanout", over: "signals", as: "signal", maxWidth: 8 },
      // The error edge: an investigation that fails routes to quarantine rather than
      // failing the run. Its branch still reaches the join, so the barrier's count is
      // unaffected.
      { id: e("err-inv"), from: n("investigate"), to: n("quarantine"), kind: "error" },
      { id: e("join-inv"), from: n("investigate"), to: n("correlate"), kind: "join", branches: [n("investigate"), n("quarantine")] },
      { id: e("join-quar"), from: n("quarantine"), to: n("correlate"), kind: "join", branches: [n("investigate"), n("quarantine")] },
      { id: e("to-assess"), from: n("correlate"), to: n("assess"), kind: "seq" },
      { id: e("to-triage"), from: n("assess"), to: n("triage"), kind: "seq" },
      { id: e("to-remediate"), from: n("triage"), to: n("remediate"), kind: "conditional" },
      { id: e("to-notify"), from: n("triage"), to: n("notify"), kind: "conditional" },
      { id: e("to-escalate"), from: n("triage"), to: n("escalate"), kind: "conditional" },
      // The compensation edge. Reached only when `remediate` fails, and never scheduled
      // at run start — compensation targets are excluded from entry-node discovery.
      // A failed restart escalates to a human. Compensation is a REWIND facility — the
      // engine never takes a compensation edge on failure — so without this edge the
      // node genuinely has no error handling, and GRAPH011 says so.
      { id: e("err-rem"), from: n("remediate"), to: n("escalate"), kind: "error" },
      { id: e("comp"), from: n("remediate"), to: n("rollback"), kind: "compensation", compensates: n("remediate") },
      { id: e("rep-r"), from: n("remediate"), to: n("report"), kind: "seq" },
      { id: e("rep-n"), from: n("notify"), to: n("report"), kind: "seq" },
      { id: e("rep-e"), from: n("escalate"), to: n("report"), kind: "seq" },
      { id: e("rep-b"), from: n("rollback"), to: n("report"), kind: "seq" },
    ],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The function resources
// ---------------------------------------------------------------------------

export interface Signal {
  readonly pod: string;
  readonly symptom: string;
}

export interface Finding {
  readonly pod: string;
  readonly cause: string;
  readonly confidence: number;
  /** True when the investigation failed and this is a placeholder. */
  readonly degraded?: boolean;
}

/** Split one alert into per-pod signals. Pure — the fan-out width comes from here. */
export function extractSignals(alert: unknown): { signals: Signal[] } {
  const a = (alert ?? {}) as { pods?: unknown; symptom?: unknown };
  const pods = Array.isArray(a.pods) ? a.pods : [];
  const symptom = typeof a.symptom === "string" ? a.symptom : "unknown";
  return { signals: pods.map((pod) => ({ pod: String(pod), symptom })) };
}

/**
 * The verdict, computed by a real function.
 *
 * Severity rises with agreement across findings and falls with each degraded branch —
 * a partial investigation should be *less* confident, not equally confident about less.
 */
export function assessSeverity(findings: readonly Finding[]): {
  pass: boolean;
  score: number;
  severity: number;
  pod: string;
  summary: string;
  degraded: number;
} {
  const real = findings.filter((f) => f.degraded !== true);
  const degraded = findings.length - real.length;
  if (real.length === 0) {
    return { pass: false, score: 0, severity: 0, pod: "", summary: "no successful investigation", degraded };
  }
  const avg = real.reduce((a, f) => a + f.confidence, 0) / real.length;
  // Each degraded branch costs a tenth of the confidence, floored at zero.
  const penalty = Math.min(1, degraded * 0.1);
  const severity = Math.max(0, avg - penalty);
  const worst = [...real].sort((a, b) => b.confidence - a.confidence)[0]!;
  return {
    pass: severity >= 0.7,
    score: severity,
    severity,
    pod: worst.pod,
    summary: `${real.length} finding(s), leading cause "${worst.cause}" on ${worst.pod}`,
    degraded,
  };
}
