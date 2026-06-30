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

/** An OTLP log record. `severityNumber` 9 is INFO, 17 is ERROR. */
interface OtlpLogRecord {
  /** OTLP fixed64 nanoseconds, emitted as a decimal string. */
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: KeyValue[];
  /** Correlated to the acting agent's trace when one is live. */
  traceId?: string;
  spanId?: string;
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
  // The in-flight agent_end flush, tracked so session_shutdown can await the
  // actual POST (agent_end drains the shared buffer, so by shutdown that buffer
  // is empty and a plain flush() would no-op while the POST is still in flight).
  let lastFlush: Promise<void> = Promise.resolve();

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

  /** The metrics endpoint: the signal-specific var as-is, else the base var + `/v1/metrics`. */
  const metricsEndpoint = (): string | undefined => {
    const metrics = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    if (metrics) return metrics;
    const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (base) return `${base.replace(/\/+$/, "")}/v1/metrics`;
    return undefined;
  };

  /** The logs endpoint: the signal-specific var as-is, else the base var + `/v1/logs`. */
  const logsEndpoint = (): string | undefined => {
    const logs = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    if (logs) return logs;
    const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (base) return `${base.replace(/\/+$/, "")}/v1/logs`;
    return undefined;
  };

  const notSuppressed = (): boolean =>
    process.env.EAGENT_OTEL !== "off" && (e.store.get<boolean>("enabled", true) ?? true);

  // The traces gate (the trace handlers + the trace flush branch).
  const enabled = (): boolean => !!endpoint() && notSuppressed();
  // Any signal enabled — gates the shared usage/tool_end accumulation, since a
  // metrics-only run (no traces endpoint) creates no RunTrace yet must still count.
  const anyEnabled = (): boolean =>
    (!!endpoint() || !!metricsEndpoint() || !!logsEndpoint()) && notSuppressed();

  // Cumulative session counters (the Sum totals). `sessionStart` is the Sum's
  // startTimeUnixNano; counters keep growing (the Sum re-sends the running total).
  const tokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const toolCalls = { ok: 0, error: 0 };
  const sessionStart = nanos();
  const hasMetricData = (): boolean =>
    tokenUsage.input > 0 ||
    tokenUsage.output > 0 ||
    tokenUsage.cache_read > 0 ||
    tokenUsage.cache_write > 0 ||
    toolCalls.ok > 0 ||
    toolCalls.error > 0;
  // Buffered log records, drained (cleared) only after a /v1/logs POST.
  const logRecords: OtlpLogRecord[] = [];

  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    e.log.warn("failed to POST telemetry to the collector (export is best-effort)");
  };

  // The shared per-signal POST: best-effort (a 5s timeout + a swallow-all
  // warnOnce). Returns the promise so session_shutdown can await the in-flight
  // batch. The body is serialized synchronously here (before any caller-side
  // buffer clear), so a caller may clear its buffer right after this returns.
  const flushSignal = (url: string, body: unknown): Promise<void> =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    }).then(() => {}, () => warnOnce());

  // A cumulative Sum NumberDataPoint: `startTimeUnixNano` is the session start,
  // `asInt` the running total as a decimal string.
  const sumPoint = (kv: KeyValue, n: number, now: string) => ({
    attributes: [kv],
    asInt: String(n),
    startTimeUnixNano: sessionStart,
    timeUnixNano: now,
  });

  const metricsBody = (): unknown => {
    const now = nanos();
    const metrics: unknown[] = [];
    const tokenPoints = (Object.entries(tokenUsage) as [string, number][])
      .filter(([, n]) => n > 0)
      .map(([type, n]) => sumPoint(attr("gen_ai.token.type", type), n, now));
    if (tokenPoints.length > 0)
      metrics.push({
        name: "eagent.gen_ai.token.usage",
        unit: "{token}",
        sum: { dataPoints: tokenPoints, aggregationTemporality: 2, isMonotonic: true },
      });
    if (toolCalls.ok > 0 || toolCalls.error > 0)
      metrics.push({
        name: "eagent.tool.calls",
        unit: "{call}",
        sum: {
          dataPoints: [
            sumPoint(attr("error", "false"), toolCalls.ok, now),
            sumPoint(attr("error", "true"), toolCalls.error, now),
          ],
          aggregationTemporality: 2,
          isMonotonic: true,
        },
      });
    return {
      resourceMetrics: [
        {
          resource: { attributes: [attr("service.name", "eagent")] },
          scopeMetrics: [{ scope: { name: "eagent" }, metrics }],
        },
      ],
    };
  };

  const logsBody = (): unknown => ({
    resourceLogs: [
      {
        resource: { attributes: [attr("service.name", "eagent")] },
        scopeLogs: [{ scope: { name: "eagent" }, logRecords }],
      },
    ],
  });

  // Flush all three signals; each exports only when ITS endpoint resolves AND it
  // has data. Returns a promise that resolves when every started POST settles, so
  // session_shutdown can await the last in-flight batch (RW9-1). The intra-run
  // agent_end caller leaves it unawaited (fire-and-forget).
  const flush = (): Promise<void> => {
    if (!notSuppressed()) return Promise.resolve();
    const pending: Promise<void>[] = [];

    const tracesUrl = endpoint();
    if (tracesUrl && finished.length > 0) {
      // Best-effort close: stamp an end ts on any still-open span (a child root
      // that never fired agent_end, or a span left open by an aborted run).
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
      finished = [];
      pending.push(flushSignal(tracesUrl, body));
    }

    const metricsUrl = metricsEndpoint();
    if (metricsUrl && hasMetricData()) pending.push(flushSignal(metricsUrl, metricsBody()));

    const logsUrl = logsEndpoint();
    if (logsUrl && logRecords.length > 0) {
      const sent = flushSignal(logsUrl, logsBody()); // serialized synchronously
      logRecords.length = 0; // cumulative counters stay; the log buffer drains
      pending.push(sent);
    }

    return Promise.all(pending).then(() => {});
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
      // Metric accumulation runs above the trace guard: a metrics-only run never
      // creates a RunTrace, but its tool calls must still be counted.
      if (anyEnabled()) toolCalls[result.isError ? "error" : "ok"]++;
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
      // Accumulate the per-call usage into the cumulative session Sum, above the
      // trace guard (a metrics-only run has no RunTrace but still counts tokens).
      if (anyEnabled()) {
        tokenUsage.input += usage.inputTokens;
        tokenUsage.output += usage.outputTokens;
        tokenUsage.cache_read += usage.cacheReadTokens ?? 0;
        tokenUsage.cache_write += usage.cacheWriteTokens ?? 0;
      }
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

    // An operational ERROR log record — metadata only: the `where` + the error
    // CLASS name, never the raw `Error.message` (which could embed a tool arg or
    // result fragment). Correlated to the acting agent's live trace if one exists.
    // Gated on `logsEndpoint()` (not `anyEnabled()`): `logRecords` drains only on
    // a /v1/logs POST, so a config with no logs endpoint must not buffer it.
    e.on("error", ({ error, where }) => {
      if (!logsEndpoint()) return;
      const acting = currentActingAgent();
      const t = acting ? traces.get(acting) : undefined;
      logRecords.push({
        timeUnixNano: nanos(),
        severityNumber: 17,
        severityText: "ERROR",
        body: { stringValue: `${where}: ${(error as Error)?.constructor?.name ?? "Error"}` },
        attributes: [attr("error.where", where)],
        ...(t ? { traceId: t.traceId, spanId: t.rootSpanId } : {}),
      });
    }),

    // Drain at the parent's agent_end (children complete within this run, so their
    // spans are already in `finished`); flush stamps any still-open root. Not
    // awaited here so the agent loop is never blocked on the network, but tracked
    // in `lastFlush` so shutdown can await this run's POST. First buffer an
    // operational INFO outcome record (gated on the logs endpoint, like `error`).
    e.on("agent_end", ({ reason }) => {
      const agent = currentActingAgent() ?? e.agent;
      if (logsEndpoint()) {
        const t = traces.get(agent);
        logRecords.push({
          timeUnixNano: nanos(),
          severityNumber: 9,
          severityText: "INFO",
          body: { stringValue: "agent_end" },
          attributes: [attr("gen_ai.response.finish_reason", reason)],
          ...(t ? { traceId: t.traceId, spanId: t.rootSpanId } : {}),
        });
      }
      lastFlush = flush();
    }),

    // Awaited (emit runs handlers serially): first the in-flight last-run POST,
    // then anything still buffered, so a hard exit can't drop the final batch.
    // Bounded by flush's 5s timeout.
    e.on("session_shutdown", async () => {
      await lastFlush;
      await flush();
    }),
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
        const tokens = tokenUsage.input + tokenUsage.output + tokenUsage.cache_read + tokenUsage.cache_write;
        ctx.print(
          `otel: ${anyEnabled() ? "enabled" : "disabled"} ` +
            `traces=${endpoint() ?? "(none)"} metrics=${metricsEndpoint() ?? "(none)"} logs=${logsEndpoint() ?? "(none)"} ` +
            `queued=${finished.length} tokens=${tokens} tools=${toolCalls.ok + toolCalls.error} logRecords=${logRecords.length}`,
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
