/**
 * Spans, derived FROM the journal.
 *
 * Not a parallel emission path. The usual design emits telemetry alongside execution,
 * which creates a second source of truth that can disagree with the first — and the
 * disagreement always surfaces during an incident, when it is least affordable.
 * Here a trace is a pure function of the journal, so:
 *
 *   - sampling can never lose something the journal has (it only drops export);
 *   - a run recorded before this file existed still produces a trace;
 *   - `reconstruct(trace) ⊆ declared(graph)` is a real assertion about execution,
 *     not about the tracer.
 *
 * The shape mirrors OpenTelemetry (and `gen_ai.*` semantic conventions for model
 * calls) without importing it, so `@loom/core` stays zero-dependency. An exporter
 * package maps these to OTLP.
 *
 * EDGES ARE LINKS, NOT SPANS: a 500-node run with 2,000 edges produces ~500 task
 * spans, not 2,500.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D9.1–D9.2.
 */

import { digestOf } from "../canonical.ts";
import { redactAttributes } from "../security/redact.ts";
import type { EdgeId, NodeId, RunId } from "../ids.ts";
import { isEvent, type JournalEvent } from "../journal/events.ts";
import type { GraphSpec } from "../graph/spec.ts";

export type SpanKind = "internal" | "server" | "client";
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanLink {
  readonly spanId: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface SpanEvent {
  readonly name: string;
  readonly time: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTime: number;
  readonly endTime: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly links: readonly SpanLink[];
  readonly events: readonly SpanEvent[];
}

/** Deterministic ids, so two traces of the same run are byte-comparable. */
function spanId(...parts: readonly string[]): string {
  return digestOf(parts.join("|")).slice("sha256:".length, "sha256:".length + 16);
}

interface Open {
  name: string;
  kind: SpanKind;
  start: number;
  parent: string;
  attributes: Record<string, unknown>;
  links: SpanLink[];
  events: SpanEvent[];
}

/**
 * Fold a journal into a span tree.
 *
 * Unclosed spans (a run still in flight, or one that died mid-Task) are emitted with
 * `endTime` at the last observed event and `status: "unset"` — an in-flight trace is
 * a normal thing to look at, not an error.
 */
export function spansFrom(events: readonly JournalEvent[]): readonly Span[] {
  if (events.length === 0) return [];
  const runId = events[0]!.runId;
  const traceId = digestOf(runId).slice("sha256:".length, "sha256:".length + 32);
  const rootId = spanId(runId, "run");

  const open = new Map<string, Open>();
  const done: Span[] = [];
  let lastTs = events[0]!.ts;

  const start = (id: string, o: Open): void => {
    if (!open.has(id)) open.set(id, o);
  };
  const close = (id: string, ts: number, status: SpanStatus, extra: Record<string, unknown> = {}): void => {
    const o = open.get(id);
    if (o === undefined) return;
    open.delete(id);
    done.push({
      traceId,
      spanId: id,
      ...(o.parent === "" ? {} : { parentSpanId: o.parent }),
      name: o.name,
      kind: o.kind,
      startTime: o.start,
      endTime: ts,
      status,
      // Redacted HERE, not in the journal.
      //
      // The journal is the source of truth and must keep real values — redacting it
      // would corrupt channel state, since `state.reduced` payloads ARE the state.
      // Spans leave the process, so they are redacted on the way out.
      attributes: redactAttributes({ ...o.attributes, ...extra }),
      links: o.links,
      events: o.events,
    });
  };
  const attr = (id: string, patch: Record<string, unknown>): void => {
    const o = open.get(id);
    if (o !== undefined) Object.assign(o.attributes, patch);
  };
  const note = (id: string, name: string, ts: number, attributes?: Record<string, unknown>): void => {
    open.get(id)?.events.push(attributes === undefined ? { name, time: ts } : { name, time: ts, attributes });
  };

  for (const e of events) {
    lastTs = e.ts;
    const tid = e.taskId;
    const taskSpan = tid === undefined ? undefined : spanId(runId, "task", tid);

    if (isEvent(e, "run.submitted")) {
      start(rootId, {
        name: "loom.run",
        kind: "server",
        start: e.ts,
        parent: "",
        attributes: {
          "run.id": runId,
          "workflow.name": e.payload.workflow,
          "graph.hash": e.payload.graphHash,
          "idempotency.key": e.payload.idempotencyKey,
          "config.digest": e.payload.configDigest,
        },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "run.compiled")) {
      attr(rootId, { "graph.nodes": e.payload.nodes, "graph.edges": e.payload.edges, "resources.pinned": e.payload.resolutionManifest.length });
      continue;
    }
    if (isEvent(e, "run.started")) {
      attr(rootId, { "oversight.posture": e.payload.posture });
      continue;
    }
    if (isEvent(e, "run.suspended")) {
      note(rootId, "run.suspended", e.ts, { reason: e.payload.reason });
      continue;
    }
    if (isEvent(e, "run.resumed")) {
      note(rootId, "run.resumed", e.ts, { by: e.payload.by });
      continue;
    }
    if (isEvent(e, "run.completed")) {
      close(rootId, e.ts, "ok", {
        "run.status": "succeeded",
        "usage.input_tokens": e.payload.usage.inputTokens,
        "usage.output_tokens": e.payload.usage.outputTokens,
        "cost.total_usd": e.payload.usage.costUsd,
      });
      continue;
    }
    if (isEvent(e, "run.failed")) {
      close(rootId, e.ts, "error", { "run.status": "failed", "error.code": e.payload.error.code });
      continue;
    }
    if (isEvent(e, "run.cancelled")) {
      close(rootId, e.ts, "error", {
        "run.status": "cancelled",
        "cancel.clean": e.payload.clean,
        // The honest field: effects that started and never reported an outcome.
        "cancel.unknown_effects": e.payload.unknownEffects.length,
      });
      continue;
    }

    if (taskSpan === undefined || tid === undefined) continue;

    if (isEvent(e, "task.ready")) {
      // Recorded on the (not yet started) span's attributes so `edges.in` survives
      // even for a Task that never got leased.
      start(taskSpan, {
        name: "loom.task",
        kind: "internal",
        start: e.ts,
        parent: rootId,
        attributes: {
          "task.id": e.taskId,
          "node.id": e.payload.nodeId,
          "branch.path": e.payload.branchPath,
          "edges.in": [...e.payload.edgesIn],
          ...(e.payload.binding === undefined ? {} : { "branch.item_channel": e.payload.binding.channel }),
        },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "task.leased")) {
      attr(taskSpan, { "task.attempt": e.payload.attempt, "worker.id": e.payload.workerId });
      note(taskSpan, "task.leased", e.ts);
      continue;
    }
    if (isEvent(e, "task.progress")) {
      note(taskSpan, "task.progress", e.ts);
      continue;
    }
    if (isEvent(e, "policy.decided")) {
      const id = spanId(runId, "policy", tid, String(e.seq));
      start(id, {
        name: "loom.policy",
        kind: "internal",
        start: e.ts,
        parent: taskSpan,
        attributes: {
          "policy.effect": e.payload.effect,
          "policy.posture": e.payload.posture,
          "policy.reasons": [...e.payload.reasons],
          "irreversibility.class": e.payload.irreversibility,
        },
        links: [],
        events: [],
      });
      close(id, e.ts, e.payload.effect === "deny" ? "error" : "ok");
      continue;
    }
    if (isEvent(e, "effect.started")) {
      const id = spanId(runId, "effect", e.payload.key);
      start(id, {
        name: e.payload.kind === "model" ? "loom.model" : "loom.tool",
        kind: "client",
        start: e.ts,
        parent: taskSpan,
        attributes: { "loom.effect.key": e.payload.key, "effect.kind": e.payload.kind },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "model.called")) {
      const id = spanId(runId, "effect", e.payload.key);
      attr(id, {
        // gen_ai.* semantic conventions, so an OTLP exporter needs no translation.
        "gen_ai.system": e.payload.provider,
        "gen_ai.request.model": e.payload.model,
        "gen_ai.response.finish_reason": e.payload.finishReason,
        "gen_ai.usage.input_tokens": e.payload.usage.inputTokens,
        "gen_ai.usage.output_tokens": e.payload.usage.outputTokens,
        "loom.cost_usd": e.payload.usage.costUsd,
      });
      continue;
    }
    if (isEvent(e, "tool.called")) {
      const id = spanId(runId, "effect", e.payload.key);
      attr(id, {
        "tool.name": e.payload.name,
        "tool.version": e.payload.version,
        "tool.irreversibility": e.payload.irreversibility,
        "tool.idempotent": e.payload.idempotent,
      });
      continue;
    }
    if (isEvent(e, "effect.completed")) {
      close(spanId(runId, "effect", e.payload.key), e.ts, "ok", { "effect.outcome": "completed" });
      continue;
    }
    if (isEvent(e, "effect.failed")) {
      close(spanId(runId, "effect", e.payload.key), e.ts, "error", {
        "effect.outcome": "failed",
        "error.code": e.payload.error.code,
      });
      continue;
    }
    if (isEvent(e, "state.reduced")) {
      const id = spanId(runId, "reduce", String(e.seq));
      start(id, {
        name: "loom.state.reduce",
        kind: "internal",
        start: e.ts,
        parent: taskSpan,
        attributes: {
          channels: [...e.payload.channels],
          "branch.count": e.payload.branchCount,
          skipped: e.payload.skipped,
          degraded: e.payload.degraded,
          "state.hash.before": e.payload.stateHashBefore,
          "state.hash.after": e.payload.stateHashAfter,
        },
        links: [],
        events: [],
      });
      close(id, e.ts, "ok");
      continue;
    }
    if (isEvent(e, "gate.raised")) {
      start(spanId(runId, "gate", e.payload.gateId), {
        name: "loom.gate",
        kind: "internal",
        start: e.ts,
        parent: taskSpan,
        attributes: {
          "gate.id": e.payload.gateId,
          "node.id": e.payload.nodeId,
          "gate.policy_ref": e.payload.policyRef,
          // Pins WHAT THE APPROVER SAW — the field that makes a later dispute answerable.
          "gate.content_digest": e.payload.contentDigest,
        },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "gate.decided")) {
      close(spanId(runId, "gate", e.payload.gateId), e.ts, e.payload.decision === "reject" ? "error" : "ok", {
        "gate.decision": e.payload.decision,
        "gate.latency_ms": e.payload.latencyMs,
        // The approver identity is hashed, never emitted in the clear.
        "gate.approver": e.actor.kind === "human" ? digestOf(e.actor.subject).slice(7, 19) : e.actor.kind,
      });
      continue;
    }
    if (isEvent(e, "gate.timeout")) {
      close(spanId(runId, "gate", e.payload.gateId), e.ts, "error", { "gate.decision": "timeout", "gate.action": e.payload.action });
      continue;
    }
    if (isEvent(e, "task.committed")) {
      attr(taskSpan, { "edges.taken": [...e.payload.take], "task.status": e.payload.status });
      close(taskSpan, e.ts, e.payload.status === "succeeded" ? "ok" : "error");
      continue;
    }
    if (isEvent(e, "task.failed")) {
      attr(taskSpan, { "error.code": e.payload.error.code });
      continue;
    }
    if (isEvent(e, "task.cancelled")) {
      close(taskSpan, e.ts, "error", { "task.status": "cancelled", "cancel.clean": e.payload.clean });
      continue;
    }
    if (isEvent(e, "task.skipped")) {
      close(taskSpan, e.ts, "unset", { "task.status": "skipped" });
      continue;
    }
    if (isEvent(e, "checkpoint.created")) {
      const id = spanId(runId, "checkpoint", String(e.seq));
      start(id, {
        name: "loom.checkpoint",
        kind: "internal",
        start: e.ts,
        parent: taskSpan,
        attributes: { "checkpoint.seq": e.payload.atSeq, "checkpoint.kind": e.payload.kind, open_tasks: e.payload.openTasks },
        links: [],
        events: [],
      });
      close(id, e.ts, "ok");
      continue;
    }
  }

  // Everything still open belongs to a run that has not finished (or that died).
  for (const id of [...open.keys()]) close(id, lastTs, "unset");

  // Deterministic order, so two traces of the same journal are byte-identical.
  return done.sort((a, b) => a.startTime - b.startTime || (a.spanId < b.spanId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Graph reconstruction
// ---------------------------------------------------------------------------

export interface ReconstructedGraph {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly EdgeId[];
  readonly graphHash: string;
  readonly instances: readonly string[];
}

/**
 * Rebuild the graph that ACTUALLY executed, from spans alone.
 *
 * This is the mechanical enforcement of "one artifact, no parallel representations":
 * if the executor ever took an edge the GraphSpec does not declare, or ran a node it
 * does not contain, the CI assertion below fails.
 */
export function reconstructGraph(spans: readonly Span[]): ReconstructedGraph {
  const nodes = new Set<NodeId>();
  const edges = new Set<EdgeId>();
  const instances = new Set<string>();
  let graphHash = "";

  for (const s of spans) {
    if (s.name === "loom.run") graphHash = String(s.attributes["graph.hash"] ?? "");
    if (s.name !== "loom.task") continue;
    const node = s.attributes["node.id"];
    if (typeof node === "string") nodes.add(node as NodeId);
    const task = s.attributes["task.id"];
    if (typeof task === "string") instances.add(task);
    for (const key of ["edges.in", "edges.taken"] as const) {
      const list = s.attributes[key];
      if (Array.isArray(list)) for (const id of list) if (typeof id === "string") edges.add(id as EdgeId);
    }
  }

  return {
    nodes: [...nodes].sort(),
    edges: [...edges].sort(),
    graphHash,
    instances: [...instances].sort(),
  };
}

export interface ConformanceResult {
  readonly ok: boolean;
  readonly unknownNodes: readonly NodeId[];
  readonly unknownEdges: readonly EdgeId[];
  readonly hashMatches: boolean;
}

/** `reconstruct(trace) ⊆ declared(graph.hash)`. A CI assertion, not a metric. */
export function conformsToGraph(reconstructed: ReconstructedGraph, spec: GraphSpec, graphHash: string): ConformanceResult {
  const declaredNodes = new Set(spec.nodes.map((n) => n.id));
  const declaredEdges = new Set(spec.edges.map((e) => e.id));
  const unknownNodes = reconstructed.nodes.filter((n) => !declaredNodes.has(n));
  const unknownEdges = reconstructed.edges.filter((e) => !declaredEdges.has(e));
  const hashMatches = reconstructed.graphHash === graphHash;
  return {
    ok: unknownNodes.length === 0 && unknownEdges.length === 0 && hashMatches,
    unknownNodes,
    unknownEdges,
    hashMatches,
  };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface SamplingPolicy {
  /** Head ratio for ordinary runs, 0..1. */
  readonly headRatio: number;
  /** Always keep a run that gated, escalated, errored, or touched an irreversible tool. */
  readonly alwaysKeep?: boolean;
}

/**
 * Decide whether a run's spans are exported.
 *
 * Sampling applies to EXPORT ONLY — the journal is never sampled — so a sampled-out
 * run is still fully replayable and auditable. That separation is what makes a low
 * head ratio safe.
 */
export function shouldExport(events: readonly JournalEvent[], policy: SamplingPolicy): boolean {
  if (policy.alwaysKeep !== false) {
    for (const e of events) {
      if (
        e.type === "gate.raised" ||
        e.type === "run.failed" ||
        e.type === "policy.escalated" ||
        e.type === "budget.exhausted" ||
        (e.type === "tool.called" &&
          ((e.payload as { irreversibility?: string }).irreversibility === "irreversible" ||
            (e.payload as { irreversibility?: string }).irreversibility === "externally_visible"))
      ) {
        return true;
      }
    }
  }
  if (policy.headRatio >= 1) return true;
  if (policy.headRatio <= 0) return false;
  // Deterministic per run, so the decision is stable across processes and reruns —
  // never Math.random().
  const runId = events[0]?.runId ?? ("" as RunId);
  const bucket = parseInt(digestOf(runId).slice(7, 11), 16) / 0xffff;
  return bucket < policy.headRatio;
}
