/**
 * Graph fixtures shared by the compiler tests.
 *
 * `incidentTriage()` is the worked example from design/loom/02-EXECUTION-GRAPH.md
 * D5.5, transcribed to the canonical JSON form. It is deliberately the hardest
 * realistic graph we can state: dynamic fan-out, a quorum join, an evaluator, a
 * router, a bounded verify/remediate loop, an irreversible action behind a human
 * gate, and a compensation path. If the compiler accepts it, the rules are not
 * merely individually testable — they compose.
 */

import type { EdgeId, NodeId } from "../../src/ids.ts";
import type { GraphSpec, ResolvedRef } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";

export const TOOLS: Record<string, ToolManifestLite> = {
  "obs.query_window": {
    name: "obs.query_window",
    version: "2.1",
    capabilities: ["obs:query"],
    irreversibility: "read_only",
    idempotent: true,
  },
  "k8s.apply": {
    name: "k8s.apply",
    version: "3.0",
    capabilities: ["k8s:write"],
    irreversibility: "irreversible",
    idempotent: false,
    compensation: { tool: "k8s.rollback" },
  },
  "k8s.rollback": {
    name: "k8s.rollback",
    version: "3.0",
    capabilities: ["k8s:write"],
    irreversibility: "reversible_write",
    idempotent: true,
  },
  "chat.post": {
    name: "chat.post",
    version: "1.4",
    capabilities: ["chat:post"],
    irreversibility: "externally_visible",
    idempotent: false,
  },
  "fs.write": {
    name: "fs.write",
    version: "1.0",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
    compensation: { tool: "fs.restore" },
  },
};

export const TENANT_CAPABILITIES = ["obs:*", "k8s:read", "k8s:write", "chat:post", "fs:read", "fs:write", "net:fetch"];

/** Resolves anything that looks like `kind/name@selector`. Digest is content-free but stable. */
export function stubResolver(opts: { deprecated?: readonly string[]; missing?: readonly string[]; subgraphs?: Record<string, GraphSpec> } = {}): ResourceResolver {
  const deprecated = new Set(opts.deprecated ?? []);
  const missing = new Set(opts.missing ?? []);
  return {
    resolve(ref): ResolvedRef | undefined {
      if (missing.has(ref)) return undefined;
      if (!/^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)) return undefined;
      return {
        ref,
        // Deterministic stand-in for real content addressing; the compiler only
        // needs it to be stable across compiles of the same spec.
        digest: `sha256:${"0".repeat(64 - ref.length % 64)}${Buffer.from(ref).toString("hex").slice(0, 0)}` as ResolvedRef["digest"],
        channel: deprecated.has(ref) ? "deprecated" : "stable",
      };
    },
    subgraph(ref) {
      return opts.subgraphs?.[ref];
    },
  };
}

const n = (id: string): NodeId => id as NodeId;
const e = (id: string): EdgeId => id as EdgeId;

export function incidentTriage(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "incident-triage", project: "sre", version: 7 },
    policy: {
      posture: "on",
      budget: { costUsd: 12.0, tokens: 2_000_000, wallMs: 900_000 },
      expansion: { maxNodes: 256, maxDepth: 3, maxFanout: 25, maxLoopIterations: 3 },
      capabilities: ["net:fetch", "obs:query", "k8s:read", "k8s:write", "chat:post"],
      onBudgetExhausted: "gate",
    },
    channels: {
      incident: { type: "object", reduce: "replace", classification: "pii" },
      signals: { type: "array", reduce: "replace" },
      // Branch-scoped: one value per fan-out branch, bound by edge e1's `as`.
      signal: { type: "object", reduce: "replace" },
      findings: { type: "array", reduce: "append_ordered" },
      hypothesis: { type: "object", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
      plan: { type: "object", reduce: "replace" },
      applied: { type: "array", reduce: "append_ordered" },
      costUsd: { type: "number", reduce: "sum", initial: 0 },
      report: { type: "object", reduce: "replace" },
    },
    inputs: ["incident"],
    outputs: ["report", "applied"],
    nodes: [
      {
        id: n("gather_signals"),
        type: "tool",
        reads: ["incident"],
        writes: ["signals"],
        tool: { name: "obs.query_window", version: "2.1", args: { minutes: 30 } },
        retry: { maxAttempts: 3, backoff: "exponential", initialMs: 500, maxMs: 8000, jitter: true },
        timeoutMs: 20_000,
      },
      {
        id: n("investigate"),
        type: "agent",
        reads: ["incident", "signal"],
        writes: ["findings", "costUsd"],
        agent: {
          profile: "agent_profile/sre-investigator@stable",
          prompt: "prompt/investigate-signal@stable",
          maxTurns: 6,
          tools: ["obs.query_window"],
        },
        policy: { budget: { costUsd: 0.35 } },
        timeoutMs: 120_000,
      },
      {
        id: n("correlate"),
        type: "join",
        reads: ["findings"],
        writes: ["findings"],
        join: { branches: [n("investigate")], mode: "quorum", k: 0.8, onBranchError: "skip", timeoutMs: 180_000 },
      },
      {
        id: n("hypothesise"),
        type: "agent",
        reads: ["incident", "findings"],
        writes: ["hypothesis", "costUsd"],
        agent: { profile: "agent_profile/sre-lead@stable", prompt: "prompt/root-cause@stable", maxTurns: 4 },
        policy: { budget: { costUsd: 0.5 } },
      },
      {
        id: n("grade"),
        type: "evaluator",
        reads: ["hypothesis", "findings"],
        writes: ["verdict"],
        evaluator: { kind: "rubric", ref: "prompt/grade-hypothesis@stable", threshold: 0.7 },
        policy: { budget: { costUsd: 0.2 } },
      },
      {
        id: n("choose_path"),
        type: "router",
        reads: ["verdict", "hypothesis"],
        router: {
          mode: "expression",
          cases: [
            { when: "has(verdict) && verdict.score < 0.7", take: [e("to_escalate")] },
            { when: "hypothesis.remediation == 'read_only'", take: [e("to_report")] },
            { when: "true", take: [e("to_plan")] },
          ],
          fallbackEdge: e("to_escalate"),
        },
      },
      {
        id: n("plan_remediation"),
        type: "agent",
        reads: ["hypothesis", "findings"],
        writes: ["plan", "costUsd"],
        agent: { profile: "agent_profile/sre-lead@stable", prompt: "prompt/plan-remediation@stable", maxTurns: 3 },
        policy: { budget: { costUsd: 0.4 } },
      },
      {
        id: n("approve_remediation"),
        type: "human_gate",
        reads: ["plan", "hypothesis", "verdict", "findings"],
        writes: ["plan"],
        humanGate: { ref: "oversight/sre-prod-change@stable" },
        checkpoint: "before",
      },
      {
        id: n("apply_remediation"),
        type: "tool",
        reads: ["plan"],
        writes: ["applied"],
        tool: { name: "k8s.apply", version: "3.0" },
        policy: { posture: "in" },
        retry: { maxAttempts: 1 },
        checkpoint: "both",
      },
      {
        id: n("verify"),
        type: "evaluator",
        reads: ["incident", "applied"],
        writes: ["verdict"],
        evaluator: { kind: "assertion", ref: "function/verify-slo-recovered@stable", threshold: 1.0 },
      },
      {
        id: n("rollback"),
        type: "tool",
        reads: ["applied"],
        writes: ["applied"],
        tool: { name: "k8s.rollback", version: "3.0" },
      },
      {
        id: n("escalate"),
        type: "tool",
        reads: ["incident", "findings", "verdict", "report"],
        writes: ["report"],
        tool: { name: "chat.post", version: "1.4" },
        unhandled: true,
      },
      {
        id: n("write_report"),
        type: "function",
        reads: ["incident", "findings", "hypothesis", "verdict", "applied", "costUsd"],
        writes: ["report"],
        function: { ref: "function/render-incident-report@stable" },
      },
    ],
    edges: [
      { id: e("e1"), from: n("gather_signals"), to: n("investigate"), kind: "fanout", over: "signals", as: "signal", maxWidth: 25 },
      { id: e("e2"), from: n("investigate"), to: n("correlate"), kind: "join", branches: [n("investigate")] },
      { id: e("e3"), from: n("correlate"), to: n("hypothesise"), kind: "seq" },
      { id: e("e4"), from: n("hypothesise"), to: n("grade"), kind: "seq" },
      { id: e("e5"), from: n("grade"), to: n("choose_path"), kind: "seq" },
      { id: e("to_plan"), from: n("choose_path"), to: n("plan_remediation"), kind: "conditional" },
      { id: e("to_report"), from: n("choose_path"), to: n("write_report"), kind: "conditional" },
      { id: e("to_escalate"), from: n("choose_path"), to: n("escalate"), kind: "conditional" },
      { id: e("e6"), from: n("plan_remediation"), to: n("approve_remediation"), kind: "seq" },
      { id: e("e7"), from: n("approve_remediation"), to: n("apply_remediation"), kind: "seq" },
      { id: e("e8"), from: n("apply_remediation"), to: n("verify"), kind: "seq" },
      { id: e("e9"), from: n("verify"), to: n("plan_remediation"), kind: "loop", until: "verdict.pass || len(applied) >= 3", maxIterations: 3 },
      { id: e("e10"), from: n("verify"), to: n("write_report"), kind: "conditional", when: "verdict.pass" },
      { id: e("e11"), from: n("apply_remediation"), to: n("escalate"), kind: "error" },
      { id: e("e12"), from: n("apply_remediation"), to: n("rollback"), kind: "compensation", compensates: n("apply_remediation") },
      { id: e("e13"), from: n("escalate"), to: n("write_report"), kind: "seq" },
    ],
  };
}

/** The smallest graph that compiles: one function node, one input, one output. */
export function minimal(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "minimal", project: "test", version: 1 },
    channels: {
      inp: { type: "string", reduce: "replace" },
      out: { type: "string", reduce: "replace" },
    },
    inputs: ["inp"],
    outputs: ["out"],
    nodes: [
      {
        id: n("only"),
        type: "function",
        reads: ["inp"],
        writes: ["out"],
        function: { ref: "function/identity@stable" },
      },
    ],
    edges: [],
  };
}

/** Top-level-mutable view of a spec, so a test can reassign `nodes`/`edges`/`channels`. */
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K];
};

/**
 * Remove a key entirely rather than setting it to `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `{...x, foo: undefined}` does not typecheck
 * against `foo?: T` — and that strictness is the point: "absent" and "present but
 * undefined" are genuinely different in the journal and in the spec.
 */
export function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

/** Deep-clone a spec so a test can mutate it without affecting the next test. */
export function clone<T>(v: T): Mutable<T> {
  return structuredClone(v) as Mutable<T>;
}
