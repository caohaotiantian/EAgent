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

// ---------------------------------------------------------------------------
// AC-3 — OTLP body shape + KeyValue/AnyValue encoding
// ---------------------------------------------------------------------------
test("AC-3: posts one OTLP/HTTP-JSON body with the resourceSpans envelope and KeyValue resource attrs", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318";
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
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318";
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
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318";
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
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318";
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

  // (d) base var with a trailing slash -> single-slash .../v1/traces (no //).
  {
    const saved = saveEnv();
    clearEnv();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318/";
    const { calls, restore } = captureFetch();
    try {
      const { agent, host } = makeHarness({ responder: [{ text: "hi" }] });
      await host.use("otel-exporter", otelExporter);
      await agent.run("go");
      assert.equal(calls.length, 1, "base var exports");
      assert.equal(calls[0]!.url, "http://collector.test:4318/v1/traces", "trailing slash stripped, single /v1/traces");
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
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318";
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
// R4 — no content leak (only metadata: tool name + status)
// ---------------------------------------------------------------------------
test("R4: no span attribute leaks tool arguments or result content", async () => {
  const saved = saveEnv();
  clearEnv();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector.test:4318";
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
