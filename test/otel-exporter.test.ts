/**
 * otel-exporter — OTLP/HTTP-JSON trace exporter (design 2026-06-29-otel-exporter).
 *
 * Offline: the extension reads the global `fetch`, so each test reassigns
 * `globalThis.fetch` to a capturing/throwing stub (saved and restored), and
 * drives a real `agent.run` with the MockProvider plus a registered tool.
 * The three OTEL env vars are saved/restored around every test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import otelExporter from "../src/extensions/otel-exporter.js";
import type { Tool } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "EAGENT_OTEL",
] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

interface Captured {
  url: string;
  init: RequestInit;
}

/** Replace globalThis.fetch with a capturing stub; returns the captures + a restore fn. */
function captureFetch(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

/** Replace globalThis.fetch with a stub that rejects; returns calls + restore. */
function rejectingFetch(): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    throw new Error("collector is down");
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = orig) };
}

/** A trivial tool: errors when called with `{ fail: true }`, succeeds otherwise. */
function pingTool(): Tool {
  return {
    spec: { name: "ping", description: "ping", parameters: { type: "object", properties: {} } },
    execute: async (args) => (args.fail ? { content: "RESULTBODY", isError: true } : { content: "RESULTBODY" }),
  };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
  status?: { code: number };
}

interface OtlpBody {
  resourceSpans: {
    resource: { attributes: { key: string; value: { stringValue?: string; intValue?: string } }[] };
    scopeSpans: { scope: { name: string }; spans: OtlpSpan[] }[];
  }[];
}

function parseBody(call: Captured): OtlpBody {
  return JSON.parse(String(call.init.body)) as OtlpBody;
}
function spansOf(call: Captured): OtlpSpan[] {
  return parseBody(call).resourceSpans[0]!.scopeSpans[0]!.spans;
}
function attr(span: OtlpSpan, key: string): { stringValue?: string; intValue?: string } | undefined {
  return span.attributes.find((a) => a.key === key)?.value;
}

// --- metrics + logs (sibling signals) -------------------------------------

type KV = { key: string; value: { stringValue?: string; intValue?: string } };
interface NumberDataPoint {
  attributes: KV[];
  asInt?: string;
  startTimeUnixNano: string;
  timeUnixNano: string;
}
interface OtlpMetric {
  name: string;
  unit?: string;
  sum?: { dataPoints: NumberDataPoint[]; aggregationTemporality: number; isMonotonic: boolean };
}
interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: KV[];
  traceId?: string;
  spanId?: string;
}

/** Captured calls whose URL path contains `path` (route the per-signal POSTs by URL). */
function callsTo(calls: Captured[], path: string): Captured[] {
  return calls.filter((c) => c.url.includes(path));
}
function metricsOf(call: Captured): OtlpMetric[] {
  const body = JSON.parse(String(call.init.body)) as {
    resourceMetrics: { resource: { attributes: KV[] }; scopeMetrics: { scope: { name: string }; metrics: OtlpMetric[] }[] }[];
  };
  return body.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
}
function metricNamed(call: Captured, name: string): OtlpMetric | undefined {
  return metricsOf(call).find((m) => m.name === name);
}
function dpBy(metric: OtlpMetric, key: string, value: string): NumberDataPoint | undefined {
  return metric.sum?.dataPoints.find((dp) => dp.attributes.some((a) => a.key === key && a.value.stringValue === value));
}
function logRecordsOf(call: Captured): OtlpLogRecord[] {
  const body = JSON.parse(String(call.init.body)) as {
    resourceLogs: { resource: { attributes: KV[] }; scopeLogs: { scope: { name: string }; logRecords: OtlpLogRecord[] }[] }[];
  };
  return body.resourceLogs[0]!.scopeLogs[0]!.logRecords;
}

// ---------------------------------------------------------------------------
// AC-3 — OTLP body shape + KeyValue/AnyValue encoding
// ---------------------------------------------------------------------------
test("AC-3: posts one OTLP/HTTP-JSON body with the resourceSpans envelope and KeyValue resource attrs", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    await agent.run("go");

    assert.equal(calls.length, 1, "exactly one POST to the collector");
    assert.equal(calls[0]!.url, "http://collector.test:4318/v1/traces");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["content-type"], "application/json");

    const body = parseBody(calls[0]!);
    assert.ok(Array.isArray(body.resourceSpans), "resourceSpans is an array");
    const rs = body.resourceSpans[0]!;
    assert.ok(rs.resource, "resource present");
    assert.ok(Array.isArray(rs.scopeSpans), "scopeSpans is an array");
    const ss = rs.scopeSpans[0]!;
    assert.ok(ss.scope, "scope present");
    assert.ok(Array.isArray(ss.spans) && ss.spans.length > 0, "spans is a non-empty array");
    assert.deepEqual(rs.resource.attributes[0], { key: "service.name", value: { stringValue: "eagent" } });

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-4 — IDs + nesting + string nanos
// ---------------------------------------------------------------------------
test("AC-4: one 32-hex traceId, 16-hex spanIds, agent->turn->tool nesting, decimal-string wall-clock nanos", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    await agent.run("go");

    const spans = spansOf(calls[0]!);
    // One trace shared by all spans.
    const traceIds = new Set(spans.map((s) => s.traceId));
    assert.equal(traceIds.size, 1, "all spans share one traceId");
    const traceId = [...traceIds][0]!;
    assert.match(traceId, /^[0-9a-f]{32}$/, "traceId is 32 hex chars");
    for (const s of spans) {
      assert.match(s.spanId, /^[0-9a-f]{16}$/, "spanId is 16 hex chars");
      assert.equal(s.kind, 1, "kind is SPAN_KIND_INTERNAL (1)");
      assert.equal(typeof s.startTimeUnixNano, "string");
      assert.match(s.startTimeUnixNano, /^\d+$/, "startTimeUnixNano is a decimal string");
      assert.ok(Number(s.startTimeUnixNano) > 1e18, "start is wall-clock nanos, not a tiny perf.now value");
      assert.ok(s.endTimeUnixNano !== undefined, "span is closed");
      assert.match(s.endTimeUnixNano!, /^\d+$/, "endTimeUnixNano is a decimal string");
      assert.ok(Number(s.startTimeUnixNano) <= Number(s.endTimeUnixNano!), "start <= end");
    }

    const agentSpan = spans.find((s) => s.parentSpanId === undefined);
    assert.ok(agentSpan, "an agent span with no parent exists");
    const turnSpanIds = new Set(spans.filter((s) => s.parentSpanId === agentSpan!.spanId).map((s) => s.spanId));
    assert.ok(turnSpanIds.size > 0, "at least one turn span parented to the agent span");
    const toolSpan = spans.find((s) => attr(s, "gen_ai.tool.name") !== undefined);
    assert.ok(toolSpan, "a tool span exists");
    assert.ok(turnSpanIds.has(toolSpan!.parentSpanId!), "tool.parentSpanId === a turn span's spanId");

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-5 — GenAI attributes + id-paired parallel tools
// ---------------------------------------------------------------------------
test("AC-5: agent span carries gen_ai.system/model + usage ints; failed tool span has status 2; parallel pair id-keyed", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [
        {
          toolCalls: [
            { name: "ping", arguments: { fail: true } },
            { name: "ping", arguments: { fail: false } },
          ],
        },
        { text: "done" },
      ],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    await agent.run("go");

    const spans = spansOf(calls[0]!);
    const agentSpan = spans.find((s) => s.parentSpanId === undefined)!;
    assert.ok(attr(agentSpan, "gen_ai.system")?.stringValue, "gen_ai.system non-empty");
    assert.equal(attr(agentSpan, "gen_ai.request.model")?.stringValue, "mock");

    const inTok = attr(agentSpan, "gen_ai.usage.input_tokens");
    const outTok = attr(agentSpan, "gen_ai.usage.output_tokens");
    assert.ok(inTok && typeof inTok.intValue === "string" && /^\d+$/.test(inTok.intValue), "input_tokens intValue");
    assert.ok(outTok && typeof outTok.intValue === "string" && /^\d+$/.test(outTok.intValue), "output_tokens intValue");

    const toolSpans = spans.filter((s) => attr(s, "gen_ai.tool.name") !== undefined);
    assert.equal(toolSpans.length, 2, "two id-keyed tool spans for the parallel same-name pair");
    for (const ts of toolSpans) {
      assert.equal(attr(ts, "gen_ai.tool.name")?.stringValue, "ping");
      assert.ok(ts.endTimeUnixNano !== undefined, "each parallel tool span is closed (no orphan/double-close)");
    }
    const errored = toolSpans.filter((s) => s.status?.code === 2);
    assert.equal(errored.length, 1, "exactly one tool span carries STATUS_CODE_ERROR");

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-6 — off-by-default inert + endpoint resolution
// ---------------------------------------------------------------------------
test("AC-6: inert with no endpoint and with EAGENT_OTEL=off; traces var used as-is; base var single-slash /v1/traces", async () => {
  // (a) neither var set -> zero fetch calls.
  {
    const saved = saveEnv();
    clearEnv();
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({
        responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
      });
      agent.tools.register(pingTool());
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(calls.length, 0, "no endpoint => inert, zero POSTs");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }

  // (b) endpoint set but EAGENT_OTEL=off -> inert.
  {
    const saved = saveEnv();
    clearEnv();
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
    process.env.EAGENT_OTEL = "off";
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(calls.length, 0, "EAGENT_OTEL=off kill switch => inert");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }

  // (c) only the traces var set -> POST to that URL verbatim (no /v1/traces appended).
  {
    const saved = saveEnv();
    clearEnv();
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:9999/custom/traces";
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(calls.length, 1, "traces var alone exports");
      assert.equal(calls[0]!.url, "http://collector.test:9999/custom/traces", "traces var used as-is");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }

  // (d) base var with a trailing slash -> fires all three signals, each at its
  // single-slash derived path (no //). Route the captured POSTs by URL.
  {
    const saved = saveEnv();
    clearEnv();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318/";
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      // The base var serves all three signals via /v1/<signal> (correct OTLP).
      const tr = callsTo(calls, "/v1/traces");
      const me = callsTo(calls, "/v1/metrics");
      const lo = callsTo(calls, "/v1/logs");
      assert.equal(tr.length, 1, "base var derives a /v1/traces POST");
      assert.equal(tr[0]!.url, "http://collector.test:4318/v1/traces", "trailing slash stripped, single /v1/traces");
      assert.equal(me.length, 1, "base var derives a /v1/metrics POST");
      assert.equal(me[0]!.url, "http://collector.test:4318/v1/metrics", "trailing slash stripped, single /v1/metrics");
      assert.equal(lo.length, 1, "base var derives a /v1/logs POST");
      assert.equal(lo[0]!.url, "http://collector.test:4318/v1/logs", "trailing slash stripped, single /v1/logs");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }
});

// ---------------------------------------------------------------------------
// AC-7 — collector down never breaks the run
// ---------------------------------------------------------------------------
test("AC-7: a rejecting fetch is swallowed; the agent run still completes normally", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  const { calls, restore } = rejectingFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    const result = await agent.run("go");
    assert.equal(result.reason, "end_turn", "the run completes normally despite the export failure");
    assert.equal(calls.length, 1, "the export was attempted (then swallowed)");
    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// D-W9.6b — session_shutdown awaits the export (final batch not dropped)
// ---------------------------------------------------------------------------
test("D-W9.6b: session_shutdown performs the export AND awaits it before resolving", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  // A slow fetch: record ordering so we can prove the shutdown handler awaited
  // the POST (fetch-end must precede shutdown-resolved), not fire-and-forget.
  const order: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    order.push("fetch-start");
    await new Promise((r) => setTimeout(r, 10));
    order.push("fetch-end");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
    await host.use("otel-exporter", otelExporter);

    // Buffer spans WITHOUT firing agent_end (which would pre-flush): a turn span
    // and the eager-pushed root land in the shared `finished` buffer.
    await agent.hooks.emit("turn_start", { turn: 1 });
    await agent.hooks.emit("turn_end", { turn: 1, step: 1 });

    await agent.hooks.emit("session_shutdown", {});
    order.push("shutdown-resolved");
    assert.deepEqual(
      order,
      ["fetch-start", "fetch-end", "shutdown-resolved"],
      "session_shutdown exported the buffered spans and awaited the POST before resolving",
    );

    await host.dispose();
  } finally {
    globalThis.fetch = orig;
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// RW9-1 — session_shutdown awaits the in-flight agent_end flush of the last run
// ---------------------------------------------------------------------------
test("RW9-1: session_shutdown awaits the last run's in-flight agent_end POST before resolving", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  // A slow fetch records ordering. agent_end drains the buffer with a fire-and-
  // forget POST; the fix tracks that promise so session_shutdown awaits it (the
  // hard-exit window where a process.exit right after a run could drop the batch).
  const order: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    order.push("fetch-start");
    await new Promise((r) => setTimeout(r, 10));
    order.push("fetch-end");
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
    await host.use("otel-exporter", otelExporter);

    // A full run buffers the root+turn spans and drains them at agent_end, whose
    // POST is in flight (started, not awaited) when the run resolves.
    await agent.run("go");
    assert.deepEqual(order, ["fetch-start"], "agent_end started the POST but did not await it");

    // Shutdown immediately after the run must await that in-flight POST.
    await agent.hooks.emit("session_shutdown", {});
    order.push("shutdown-resolved");
    assert.deepEqual(
      order,
      ["fetch-start", "fetch-end", "shutdown-resolved"],
      "session_shutdown awaited the last run's in-flight agent_end POST before resolving",
    );

    await host.dispose();
  } finally {
    globalThis.fetch = orig;
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// R4 — no content leak (only metadata: tool name + status)
// ---------------------------------------------------------------------------
test("R4: no span attribute leaks tool arguments or result content", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [{ toolCalls: [{ name: "ping", arguments: { secret: "TOPSECRET" } }] }, { text: "done" }],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    await agent.run("go");

    const serialized = String(calls[0]!.init.body);
    assert.ok(!serialized.includes("TOPSECRET"), "tool arguments must never appear in any span attribute");
    assert.ok(!serialized.includes("RESULTBODY"), "tool result content must never appear in any span attribute");
    // The tool name (metadata) is allowed and present.
    assert.ok(serialized.includes("gen_ai.tool.name"), "tool name metadata is folded");

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ===========================================================================
// OTLP metrics + logs sibling signals (design 2026-06-30-otlp-metrics-logs).
// ===========================================================================

// ---------------------------------------------------------------------------
// AC-3 (metrics) — token-usage Sum (by type) + tool-call Sum (by error)
// ---------------------------------------------------------------------------
test("AC-3 metrics: posts an eagent.gen_ai.token.usage Sum (by token type) + eagent.tool.calls Sum (by error)", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://collector.test:4318/v1/metrics";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [
        { toolCalls: [{ name: "ping", arguments: {} }, { name: "ping", arguments: { fail: true } }] },
        { text: "done" },
      ],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    // MockProvider's usage carries only input/output, so emit the cache tokens directly.
    await agent.hooks.emit("usage", {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
      cumulative: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
    });
    await agent.run("go");

    const metricsCalls = callsTo(calls, "/v1/metrics");
    assert.equal(metricsCalls.length, 1, "exactly one POST to the metrics endpoint");
    assert.equal((metricsCalls[0]!.init.headers as Record<string, string>)["content-type"], "application/json");

    const tokenMetric = metricNamed(metricsCalls[0]!, "eagent.gen_ai.token.usage");
    assert.ok(tokenMetric, "token-usage metric present");
    assert.equal(tokenMetric!.unit, "{token}");
    assert.equal(tokenMetric!.sum!.aggregationTemporality, 2, "cumulative temporality");
    assert.equal(tokenMetric!.sum!.isMonotonic, true);
    for (const type of ["input", "output", "cache_read", "cache_write"]) {
      const dp = dpBy(tokenMetric!, "gen_ai.token.type", type);
      assert.ok(dp, `data point for token type ${type}`);
      assert.match(dp!.asInt!, /^\d+$/, "asInt is a decimal string");
    }
    assert.ok(Number(dpBy(tokenMetric!, "gen_ai.token.type", "cache_read")!.asInt) >= 30, "cache_read accumulated");

    const toolMetric = metricNamed(metricsCalls[0]!, "eagent.tool.calls");
    assert.ok(toolMetric, "tool-calls metric present");
    assert.equal(toolMetric!.unit, "{call}");
    assert.equal(dpBy(toolMetric!, "error", "false")!.asInt, "1", "one ok tool call");
    assert.equal(dpBy(toolMetric!, "error", "true")!.asInt, "1", "one errored tool call");

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-4 (logs) — in-run error (maxTurns path) + agent_end, both trace-correlated
// ---------------------------------------------------------------------------
test("AC-4 logs: maxTurns error -> ERROR record (class name, no message) + agent_end INFO record, both trace-correlated", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://collector.test:4318/v1/logs";
  const { calls, restore } = captureFetch();
  try {
    // A responder that keeps wanting a tool so the loop runs to maxTurns.
    const { agent, host } = makeHarness({ responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }] });
    agent.tools.register(pingTool());
    agent.maxTurns = 1; // turn 1 dispatches, then the maxTurns error path emits `error` in-run.
    await host.use("otel-exporter", otelExporter);
    await agent.run("go");

    const logsCalls = callsTo(calls, "/v1/logs");
    assert.equal(logsCalls.length, 1, "exactly one POST to the logs endpoint");
    const records = logRecordsOf(logsCalls[0]!);

    const err = records.find((r) => r.severityNumber === 17);
    assert.ok(err, "an ERROR record");
    assert.equal(err!.severityText, "ERROR");
    assert.equal(err!.body.stringValue, "agent.run: Error", "body is where + error class name, not the raw message");
    assert.equal(err!.attributes.find((a) => a.key === "error.where")?.value.stringValue, "agent.run");
    assert.match(err!.traceId!, /^[0-9a-f]{32}$/, "ERROR record correlated to the run trace");
    assert.match(err!.spanId!, /^[0-9a-f]{16}$/);

    const info = records.find((r) => r.severityNumber === 9);
    assert.ok(info, "an INFO record");
    assert.equal(info!.severityText, "INFO");
    assert.equal(info!.body.stringValue, "agent_end");
    assert.equal(
      info!.attributes.find((a) => a.key === "gen_ai.response.finish_reason")?.value.stringValue,
      "stop",
    );
    assert.equal(info!.traceId, err!.traceId, "both records share the run's traceId");
    assert.equal(info!.spanId, err!.spanId, "both records carry the root spanId");

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-5 (no content leak — strengthened over metrics + logs)
// ---------------------------------------------------------------------------
test("AC-5 no-leak: an error message fragment + a tool arg marker never reach the metrics/logs wire", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://collector.test:4318/v1/metrics";
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://collector.test:4318/v1/logs";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [{ toolCalls: [{ name: "ping", arguments: { marker: "ARGMARKER" } }] }, { text: "done" }],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    // An error whose message embeds an argument-like fragment must NOT leak.
    await agent.hooks.emit("error", { where: "tool.exec", error: new Error("secret=" + "XYZ") });
    await agent.run("go");

    const bodies = [...callsTo(calls, "/v1/metrics"), ...callsTo(calls, "/v1/logs")];
    assert.ok(callsTo(calls, "/v1/logs").length >= 1, "a logs POST occurred (real content to scan)");
    for (const c of bodies) {
      const body = String(c.init.body);
      assert.ok(!body.includes("secret="), "the error message must not leak");
      assert.ok(!body.includes("XYZ"), "the error message fragment must not leak");
      assert.ok(!body.includes("ARGMARKER"), "the tool argument must not leak");
      assert.ok(!body.includes("RESULTBODY"), "the tool result content must not leak");
    }

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-6 (independent signals) — each endpoint exports only its own signal
// ---------------------------------------------------------------------------
test("AC-6 independent: metrics-only posts only /v1/metrics; logs-only posts only /v1/logs", async () => {
  // (a) only the metrics endpoint set.
  {
    const saved = saveEnv();
    clearEnv();
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://collector.test:4318/v1/metrics";
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({
        responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
      });
      agent.tools.register(pingTool());
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(callsTo(calls, "/v1/metrics").length, 1, "a metrics POST");
      assert.equal(callsTo(calls, "/v1/logs").length, 0, "no logs POST");
      assert.equal(callsTo(calls, "/v1/traces").length, 0, "no traces POST");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }
  // (b) only the logs endpoint set.
  {
    const saved = saveEnv();
    clearEnv();
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://collector.test:4318/v1/logs";
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(callsTo(calls, "/v1/logs").length, 1, "a logs POST (the agent_end INFO record)");
      assert.equal(callsTo(calls, "/v1/metrics").length, 0, "no metrics POST");
      assert.equal(callsTo(calls, "/v1/traces").length, 0, "no traces POST");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }
});

// ---------------------------------------------------------------------------
// AC-7 (off-by-default inert across all signals)
// ---------------------------------------------------------------------------
test("AC-7 off: no endpoints => zero POSTs; EAGENT_OTEL=off with all endpoints set => zero POSTs", async () => {
  // (a) no endpoints at all.
  {
    const saved = saveEnv();
    clearEnv();
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({
        responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
      });
      agent.tools.register(pingTool());
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(calls.length, 0, "no endpoint => inert, zero POSTs");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }
  // (b) all three endpoints set but the kill switch is off.
  {
    const saved = saveEnv();
    clearEnv();
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://collector.test:4318/v1/metrics";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://collector.test:4318/v1/logs";
    process.env.EAGENT_OTEL = "off";
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({
        responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
      });
      agent.tools.register(pingTool());
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(calls.length, 0, "EAGENT_OTEL=off kill switch => inert across all signals");
      await host.dispose();
    } finally {
      restore();
      restoreEnv(saved);
    }
  }
});

// AC-7 off (kill switch is inert, not just silent): with the switch engaged and
// a logs endpoint set, the `error`/`agent_end` handlers must not buffer records
// into `logRecords` (flush early-returns and never drains them => a leak).
test("AC-7 off: EAGENT_OTEL=off with a logs endpoint does not buffer log records (no leak)", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://collector.test:4318/v1/logs";
  process.env.EAGENT_OTEL = "off";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host, commands } = makeHarness({
      responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    // An in-run error plus the agent_end at the run's close — both would push.
    await agent.hooks.emit("error", { where: "tool.exec", error: new Error("boom") });
    await agent.run("go");

    assert.equal(calls.length, 0, "kill switch => zero POSTs");
    const lines: string[] = [];
    await commands.get("otel")!.run({ agent, args: "status", print: (l) => lines.push(l) });
    assert.match(lines.join("\n"), /logRecords=0\b/, "kill switch must not buffer log records");

    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-8 (cumulative + decimal strings) — token Sum data points
// ---------------------------------------------------------------------------
test("AC-8 cumulative: token Sum data points are cumulative/monotonic, asInt decimal, start <= time", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://collector.test:4318/v1/metrics";
  const { calls, restore } = captureFetch();
  try {
    const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
    await host.use("otel-exporter", otelExporter);
    await agent.hooks.emit("usage", {
      usage: { inputTokens: 7, outputTokens: 3 },
      cumulative: { inputTokens: 7, outputTokens: 3 },
    });
    await agent.run("go");

    const tokenMetric = metricNamed(callsTo(calls, "/v1/metrics")[0]!, "eagent.gen_ai.token.usage")!;
    assert.equal(tokenMetric.sum!.aggregationTemporality, 2);
    assert.equal(tokenMetric.sum!.isMonotonic, true);
    assert.ok(tokenMetric.sum!.dataPoints.length > 0, "at least one token data point");
    for (const dp of tokenMetric.sum!.dataPoints) {
      assert.match(dp.asInt!, /^\d+$/, "asInt is a decimal string");
      assert.match(dp.startTimeUnixNano, /^\d+$/);
      assert.match(dp.timeUnixNano, /^\d+$/);
      assert.ok(Number(dp.startTimeUnixNano) <= Number(dp.timeUnixNano), "session start <= now");
    }
    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// AC-9 (collector-down never breaks the run) — over metrics + logs
// ---------------------------------------------------------------------------
test("AC-9 collector-down: a rejecting fetch on every signal is swallowed; the run still completes normally", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "http://collector.test:4318/v1/metrics";
  process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "http://collector.test:4318/v1/logs";
  const { calls, restore } = rejectingFetch();
  try {
    const { agent, host } = makeHarness({
      responder: [{ toolCalls: [{ name: "ping", arguments: {} }] }, { text: "done" }],
    });
    agent.tools.register(pingTool());
    await host.use("otel-exporter", otelExporter);
    const result = await agent.run("go");
    assert.equal(result.reason, "end_turn", "the run completes normally despite the export failures");
    assert.equal(callsTo(calls, "/v1/metrics").length, 1, "a metrics export was attempted (then swallowed)");
    assert.equal(callsTo(calls, "/v1/logs").length, 1, "a logs export was attempted (then swallowed)");
    assert.equal(callsTo(calls, "/v1/traces").length, 1, "the traces export was attempted and unaffected");
    await host.dispose();
  } finally {
    restore();
    restoreEnv(saved);
  }
});
