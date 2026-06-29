/**
 * OpenTelemetry (OTLP) trace exporter as a pure event-bus consumer.
 *
 * The kernel's lifecycle bus already narrates a run — agent start, each turn,
 * every tool call, and token usage. This extension listens to that narration
 * and folds it into OTLP spans (a root agent span, turn spans as children, tool
 * spans as grandchildren), then POSTs them to a configured collector as
 * OTLP/HTTP-JSON via the global `fetch`. It is the export-to-a-backend sibling of
 * the always-on local `trace` tracer: same folding shape, a different lifecycle
 * (opt-in network egress, off by default).
 *
 * Off by default: it is active only when a collector endpoint is configured
 * (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, or `OTEL_EXPORTER_OTLP_ENDPOINT` with
 * `/v1/traces` appended) and not suppressed (the `EAGENT_OTEL=off` kill switch or
 * `/otel off`). With no endpoint it is inert. Export is best-effort: a fire-and-
 * forget POST with a bounded timeout and a swallow-all catch, so a down collector
 * can never break the agent loop. It folds only metadata (provider, model, token
 * counts, tool name, error status) — never message, argument, or result content.
 *
 * Hand-rolled OTLP/HTTP-JSON over `fetch` with IDs from `node:crypto` (zero-dep).
 */

import { randomBytes } from "node:crypto";

import { currentActingAgent, type Agent } from "../kernel/agent.js";
import type { ExtensionAPI } from "../kernel/extension.js";

/** An OTLP attribute (`KeyValue` with an `AnyValue`): string or int64 (decimal string). */
type KeyValue = { key: string; value: { stringValue: string } | { intValue: string } };

/** An OTLP span. `kind` 1 is SPAN_KIND_INTERNAL; `status.code` 2 is STATUS_CODE_ERROR. */
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1;
  /** OTLP fixed64 nanoseconds, emitted as a decimal string. */
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: KeyValue[];
  status?: { code: 1 | 2 };
}

export default function activate(e: ExtensionAPI): () => void {
  // Per-agent trace state so concurrent forks don't collide on a shared
  // `openSpans["1"]` or traceId. Keyed by the ACTING agent; lazily created on the
  // first intra-run event, since children never fire agent_start. (W9.1.)
  interface RunTrace {
    traceId: string;
    rootSpanId: string;
    currentTurnSpanId: string;
    openSpans: Map<string, OtlpSpan>;
  }
  const traces = new WeakMap<Agent, RunTrace>();
  // Shared drain buffer: every closed span — and each lazily-created root, eager-
  // pushed while still open — lands here and is flushed at the parent's agent_end.
  // The WeakMap is not enumerable, so flush scans only this.
  let finished: OtlpSpan[] = [];
  let warned = false;

  const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
  // Wall-clock ms -> ns as a decimal string by appending six zeros: never
  // `Date.now() * 1e6`, which exceeds Number.MAX_SAFE_INTEGER and corrupts digits.
  const nanos = (): string => `${Date.now()}000000`;

  const attr = (key: string, v: string | number): KeyValue =>
    typeof v === "string" ? { key, value: { stringValue: v } } : { key, value: { intValue: String(v) } };

  /** Replace an existing attribute with the same key, or append it. */
  const upsert = (span: OtlpSpan, kv: KeyValue): void => {
    const i = span.attributes.findIndex((a) => a.key === kv.key);
    if (i >= 0) span.attributes[i] = kv;
    else span.attributes.push(kv);
  };

  /** The trace for an agent, lazily created with a fresh root span on first use. */
  const traceFor = (agent: Agent): RunTrace => {
    let t = traces.get(agent);
    if (!t) {
      const traceId = hex(16);
      const rootSpanId = hex(8);
      const system = agent.providers.get(agent.providerName)?.name ?? agent.providerName ?? "unknown";
      const root: OtlpSpan = {
        traceId,
        spanId: rootSpanId,
        name: "agent",
        kind: 1,
        startTimeUnixNano: nanos(),
        attributes: [attr("gen_ai.system", system), attr("gen_ai.request.model", agent.model)],
      };
      t = { traceId, rootSpanId, currentTurnSpanId: "", openSpans: new Map([["agent", root]]) };
      traces.set(agent, t);
      finished.push(root); // eager-push the open root so flush emits it
    }
    return t;
  };

  /** The traces endpoint: the signal-specific var as-is, else the base var + `/v1/traces`. */
  const endpoint = (): string | undefined => {
    const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (traces) return traces;
    const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (base) return `${base.replace(/\/+$/, "")}/v1/traces`;
    return undefined;
  };

  const enabled = (): boolean =>
    !!endpoint() && process.env.EAGENT_OTEL !== "off" && (e.store.get<boolean>("enabled", true) ?? true);

  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    e.log.warn("failed to POST traces to the collector (export is best-effort)");
  };

  const flush = (): void => {
    if (!enabled() || finished.length === 0) return;
    const url = endpoint();
    if (!url) return;
    // Best-effort close: stamp an end ts on any still-open span (a child root that
    // never fired agent_end, or a span left open by an aborted run).
    const end = nanos();
    for (const s of finished) if (!s.endTimeUnixNano) s.endTimeUnixNano = end;
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [attr("service.name", "eagent")] },
          scopeSpans: [{ scope: { name: "eagent" }, spans: finished }],
        },
      ],
    };
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).catch(() => warnOnce());
    finished = [];
  };

  const disposers = [
    // The parent seeds its trace here (a fresh root + a clean buffer for the run);
    // children never fire agent_start, so they seed lazily on their first turn.
    e.on("agent_start", () => {
      if (!enabled()) return;
      const agent = currentActingAgent() ?? e.agent;
      traces.delete(agent);
      finished = [];
      traceFor(agent);
    }),

    e.on("turn_start", ({ turn }) => {
      if (!enabled()) return;
      const t = traceFor(currentActingAgent() ?? e.agent);
      const span: OtlpSpan = {
        traceId: t.traceId,
        spanId: hex(8),
        parentSpanId: t.rootSpanId,
        name: `turn ${turn}`,
        kind: 1,
        startTimeUnixNano: nanos(),
        attributes: [],
      };
      t.currentTurnSpanId = span.spanId;
      t.openSpans.set(String(turn), span);
    }),

    e.on("tool_start", ({ call }) => {
      if (!enabled()) return;
      const t = traceFor(currentActingAgent() ?? e.agent);
      if (!t.currentTurnSpanId) return;
      t.openSpans.set(call.id, {
        traceId: t.traceId,
        spanId: hex(8),
        parentSpanId: t.currentTurnSpanId,
        name: call.name,
        kind: 1,
        startTimeUnixNano: nanos(),
        attributes: [attr("gen_ai.tool.name", call.name)],
      });
    }),

    e.on("tool_end", ({ call, result }) => {
      if (!enabled()) return;
      const t = traces.get(currentActingAgent() ?? e.agent);
      if (!t) return;
      const span = t.openSpans.get(call.id);
      if (!span) return;
      span.endTimeUnixNano = nanos();
      if (result.isError) span.status = { code: 2 };
      t.openSpans.delete(call.id);
      finished.push(span);
    }),

    e.on("usage", ({ usage }) => {
      if (!enabled()) return;
      const t = traces.get(currentActingAgent() ?? e.agent);
      if (!t) return;
      const root = t.openSpans.get("agent");
      if (!root) return;
      upsert(root, attr("gen_ai.usage.input_tokens", usage.inputTokens));
      upsert(root, attr("gen_ai.usage.output_tokens", usage.outputTokens));
    }),

    e.on("turn_end", ({ turn }) => {
      if (!enabled()) return;
      const t = traces.get(currentActingAgent() ?? e.agent);
      if (!t) return;
      const span = t.openSpans.get(String(turn));
      if (!span) return;
      span.endTimeUnixNano = nanos();
      t.openSpans.delete(String(turn));
      finished.push(span);
    }),

    // Drain at the parent's agent_end (children complete within this run, so their
    // spans are already in `finished`); flush stamps any still-open root.
    e.on("agent_end", () => flush()),

    e.on("session_shutdown", () => flush()),
  ];

  const command = e.registerCommand({
    name: "otel",
    description: "OTLP trace exporter: /otel [status|on|off].",
    run: (ctx) => {
      const sub = ctx.args.trim();
      if (sub === "on") {
        e.store.set("enabled", true);
        ctx.print("otel: export enabled (active when a collector endpoint is configured)");
      } else if (sub === "off") {
        e.store.set("enabled", false);
        ctx.print("otel: export disabled");
      } else {
        ctx.print(
          `otel: ${enabled() ? "enabled" : "disabled"} endpoint=${endpoint() ?? "(none)"} queued=${finished.length}`,
        );
      }
    },
  });

  return () => {
    for (const d of [command, ...disposers]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}

/** Parse the OTLP `OTEL_EXPORTER_OTLP_HEADERS` convention: comma-separated `key=value` pairs. */
function parseHeaders(s: string | undefined): Record<string, string> {
  if (!s) return {};
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const [key, value] = part.split("=");
    if (key && value) out[key] = value;
  }
  return out;
}
