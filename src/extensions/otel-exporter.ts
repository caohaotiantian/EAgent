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
  let currentTraceId = "";
  let currentTurnSpanId = "";
  const openSpans = new Map<string, OtlpSpan>();
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
    e.on("agent_start", () => {
      if (!enabled()) return;
      currentTraceId = hex(16);
      currentTurnSpanId = "";
      openSpans.clear();
      finished = [];
      const system = e.agent.providers.get(e.agent.providerName)?.name ?? e.agent.providerName ?? "unknown";
      openSpans.set("agent", {
        traceId: currentTraceId,
        spanId: hex(8),
        name: "agent",
        kind: 1,
        startTimeUnixNano: nanos(),
        attributes: [attr("gen_ai.system", system), attr("gen_ai.request.model", e.agent.model)],
      });
    }),

    e.on("turn_start", ({ turn }) => {
      if (!enabled()) return;
      const agent = openSpans.get("agent");
      if (!agent) return;
      const span: OtlpSpan = {
        traceId: currentTraceId,
        spanId: hex(8),
        parentSpanId: agent.spanId,
        name: `turn ${turn}`,
        kind: 1,
        startTimeUnixNano: nanos(),
        attributes: [],
      };
      currentTurnSpanId = span.spanId;
      openSpans.set(String(turn), span);
    }),

    e.on("tool_start", ({ call }) => {
      if (!enabled() || !currentTurnSpanId) return;
      openSpans.set(call.id, {
        traceId: currentTraceId,
        spanId: hex(8),
        parentSpanId: currentTurnSpanId,
        name: call.name,
        kind: 1,
        startTimeUnixNano: nanos(),
        attributes: [attr("gen_ai.tool.name", call.name)],
      });
    }),

    e.on("tool_end", ({ call, result }) => {
      if (!enabled()) return;
      const span = openSpans.get(call.id);
      if (!span) return;
      span.endTimeUnixNano = nanos();
      if (result.isError) span.status = { code: 2 };
      openSpans.delete(call.id);
      finished.push(span);
    }),

    e.on("usage", ({ usage }) => {
      if (!enabled()) return;
      const agent = openSpans.get("agent");
      if (!agent) return;
      upsert(agent, attr("gen_ai.usage.input_tokens", usage.inputTokens));
      upsert(agent, attr("gen_ai.usage.output_tokens", usage.outputTokens));
    }),

    e.on("turn_end", ({ turn }) => {
      if (!enabled()) return;
      const span = openSpans.get(String(turn));
      if (!span) return;
      span.endTimeUnixNano = nanos();
      openSpans.delete(String(turn));
      finished.push(span);
    }),

    e.on("agent_end", () => {
      if (enabled()) {
        const agent = openSpans.get("agent");
        if (agent) {
          agent.endTimeUnixNano = nanos();
          openSpans.delete("agent");
          finished.push(agent);
        }
      }
      flush();
    }),

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
