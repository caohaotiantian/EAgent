# Design — OTLP metrics + logs signals (otel-exporter)

```
Status: closed
Closing-commit: bb75a2d
Closed-on: 2026-06-30
Deferred: RW7c-1 RESOLVED (traces+metrics+logs); RW7c-2 (traceparent propagation), RW7c-3 (live-collector smoke), histograms — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-30-otlp-metrics-logs` · **Mode:** Full · **Source:** `docs/DEFERRED-FOLLOWUPS.md` RW7c-1
(otel-exporter v1 emits **traces** only). **Research:** OpenTelemetry OTLP/HTTP spec (the three signals:
`/v1/traces`, `/v1/metrics`, `/v1/logs`); OTel GenAI semantic conventions (token-usage metric, GenAI events).

## 1. Background and Purpose

`otel-exporter` exports **traces** (a root agent span, turn/tool child spans) as hand-rolled OTLP/HTTP-JSON
over `fetch` — zero-dep, off by default, fold metadata only (model / tokens / tool-name / status), never
argument or result content. OpenTelemetry has **three** signals; traces answer "what happened in this run",
but the other two are missing:

- **Metrics** (`/v1/metrics`) — aggregate counters/gauges for dashboards + alerting: token usage and tool-
  call volume over time, which traces (per-run) cannot aggregate.
- **Logs** (`/v1/logs`) — structured operational records (errors, run outcomes) correlated with traces.

Without them, an operator wiring EAgent into an OTLP collector gets traces but cannot build a token-cost
metric or an error-rate alert without re-deriving them from spans. Both signals reuse the exporter's
existing endpoint-resolution, `attr`/`nanos`/`fetch`/`parseHeaders`/`warnOnce` helpers, and off-by-default
gating, so they are an additive sibling-signal extension of the same file — not a new exporter.

## 2. Deliverables

- [ ] **D1** **Metrics** in `otel-exporter.ts`: accumulate session counters and export OTLP **Sum** metrics
  to the metrics endpoint at flush:
  - `eagent.gen_ai.token.usage` (unit `{token}`, Sum, **cumulative**, monotonic) with a data point per
    token **type** (`input`, `output`, plus `cache_read`/`cache_write` when present — an open extension of the
    semconv `input`/`output` enum, deliberate) — attribute `gen_ai.token.type`, `asInt` decimal string. Fed by
    the `usage` event. **Name (G1):** deliberately **NOT** the semconv `gen_ai.client.token.usage` — that name
    is reserved for a *Histogram* instrument, so emitting a Sum under it would create a name/type conflict in a
    backend that also ingests the canonical histogram (or the Prometheus exporter). The `eagent.`-prefixed
    Sum is a counter-appropriate name; the histogram form is a follow-up (Scope Boundary).
  - `eagent.tool.calls` (unit `{call}`, Sum, cumulative, monotonic) — total tool invocations, attribute
    `error` (`"true"`/`"false"`) so error-rate is derivable. Fed by `tool_end`.
- [ ] **D2** **Logs** in `otel-exporter.ts`: buffer OTLP **logRecords** and export to the logs endpoint at
  flush — **metadata only, never content** (same posture as traces):
  - an `error` event → a `severityNumber:17`/`severityText:"ERROR"` record whose `body.stringValue` is the
    `where` + the **error class name** (`(err as Error)?.constructor?.name ?? "Error"`), **not** the raw
    `Error.message` (G2: a freeform message could embed a tool argument/result fragment — e.g.
    `new Error("bad arg: " + JSON.stringify(args))` — so excluding it keeps the no-content invariant strict;
    traces emit no error text at all). Attributes: `error.where`.
  - an `agent_end` → a `severityNumber:9`/`severityText:"INFO"` record `{ body: "agent_end", attributes:
    [gen_ai.response.finish_reason = reason] }`.
  - **Trace correlation (G3):** each record carries `traceId`/`spanId` from the acting agent's `RunTrace`
    (the exporter already holds them, `:49-55`) — for `agent_end` via `traces.get(agent)` (live), for `error`
    via `currentActingAgent()` → `traces.get` (best-effort; omitted if no live trace). No message text, no
    tool arguments/results.
- [ ] **D3** Per-signal endpoint resolution + gating: `metricsEndpoint()` / `logsEndpoint()` resolve the
  signal-specific var (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `…_LOGS_ENDPOINT`) **or** the base var +
  `/v1/metrics` / `/v1/logs` (mirroring the existing `endpoint()` for traces). Each signal is **independent**:
  it exports only when *its* endpoint resolves (an operator can enable traces without metrics/logs). All
  three share `EAGENT_OTEL=off` + the `enabled` store flag. **Accumulation gating (C1):** the shared
  `usage`/`tool_end` handlers today early-return on the *traces* `enabled()` (`:205,:193`); metric/log
  accumulation must instead be gated on "**any** signal enabled" (or be unconditional + cheap, with only the
  per-signal POST gated) — otherwise a metrics-only config (no traces endpoint) would accumulate nothing.
  Generalize the gate to `anyEnabled()` (traces || metrics || logs endpoint, and not `off`, and `enabled`).
- [ ] **D4** Flush metrics + logs at **`agent_end` + `session_shutdown`**, alongside the trace flush — reuse
  the existing fire-and-forget + the in-flight-await on shutdown (RW9-1) so a hard exit can't drop the last
  metrics/logs batch. Best-effort (swallow-all, `warnOnce` on failure — **generalize the warn message** (C2):
  the current one says "failed to POST **traces**", misleading for a metrics/logs failure; make it
  signal-agnostic or per-signal).
- [ ] **D5** `/otel status` reports the metrics/logs endpoints + buffered counts; `/otel on|off` gates all
  three signals (unchanged switch). Off by default (no endpoint → inert).
- [ ] **D6** Offline tests (TDD) pinning AC-3..AC-10 (stub `globalThis.fetch`, assert per-signal body shape +
  no content leak).

## 3. Scope Boundary (NOT in scope)

- **Histogram metrics** (operation-duration buckets, `gen_ai.client.operation.duration`) — Sum counters are
  the high-value v1; explicit-bucket histograms add bucket-boundary config + a heavier data-point shape, a
  follow-up.
- **Gauges** — nothing in v1 needs an instantaneous gauge; counters cover usage/volume.
- **Content-bearing GenAI event logs** (`gen_ai.user.message` / `gen_ai.assistant.message` with prompts/
  completions) — these carry model I/O content, which the exporter deliberately **never** emits (privacy
  posture). v1 logs are metadata-only operational records.
- **Delta aggregation temporality** — cumulative only (KDD-3).
- **Metric Views / aggregation config / a Reader API** — the OTel SDK's machinery; we hand-roll the wire.
- **Distributed-context propagation** (`traceparent` into outbound tool HTTP) — that is RW7c-2, separate.
- **A new extension / any kernel change** — metrics + logs land **in** `otel-exporter.ts`; no new
  `BUILTIN_EXTENSIONS` entry, kernel stays 2186.

## 4. Key Design Decisions

### KDD-1 — v1 metrics = token-usage + tool-call **Sum** counters (cumulative), not histograms
*Problem:* which metric instruments + which data? *Options:* (a) **Sum counters** for tokens (by type) +
tool calls (by error); (b) add **Histograms** for run/operation duration; (c) Gauges. *Choice:* **(a)** —
token usage (cost/budget) + tool-call volume (activity/error-rate) are the highest-value GenAI metrics and
map cleanly to monotonic Sums fed by the `usage`/`tool_end` events the exporter already observes (emitted
under the counter-appropriate `eagent.gen_ai.token.usage` name, *not* the semconv `gen_ai.client.token.usage`
histogram name — see D1/G1). *Rejected:* (b) histograms need
explicit-bucket boundaries + a bucketed data-point shape — real value but a heavier follow-up (Scope
Boundary); (c) gauges fit nothing here.

### KDD-2 — Logs are **metadata-only** operational records (errors + outcomes), never content
*Problem:* what becomes a log? *Options:* (a) the GenAI **event** logs (user/assistant messages — carry
prompt/completion **content**); (b) **operational** logs only — `error` events + `agent_end` outcomes, no
content. *Choice:* **(b)** — the exporter's load-bearing invariant is **never emit model I/O content** (the
traces fold only metadata); content logs would violate it and the privacy posture in one stroke.
Operational error/outcome logs are valuable (error-rate alerting, run correlation) and privacy-safe —
**and even within (b) the error record excludes the raw `Error.message`** (a freeform string that could embed
a tool arg/result), carrying only `where` + the error class name (G2), so no freeform model/tool text reaches
the wire. *Rejected:* (a) leaks content + contradicts the exporter's own no-content rule — a severe
regression of the existing guarantee.

### KDD-3 — Cumulative aggregation temporality (`asInt`, monotonic)
*Problem:* OTLP Sum metrics declare a temporality. *Options:* (a) **cumulative** (`aggregationTemporality:2`,
running totals since process start); (b) **delta** (per-export increments, reset each flush). *Choice:*
**(a)** — cumulative is the simpler, most-collector-friendly default; the session start time is the Sum's
`startTimeUnixNano`, totals are the session accumulators. *Rejected:* (b) delta needs a reset-after-export
dance + risks lost increments if a flush fails.

### KDD-4 — Three **independent** signal endpoints; reuse the traces resolution
*Problem:* one endpoint or per-signal? *Options:* (a) one `enabled()` gating all signals on the traces
endpoint; (b) **per-signal endpoints**, each exporting only when *its* endpoint resolves. *Choice:* **(b)** —
OTLP collectors expose per-signal paths; an operator may want traces but not metrics (or vice-versa).
`metricsEndpoint()`/`logsEndpoint()` mirror `endpoint()` (signal-specific var, else base + `/v1/<signal>`).
The `EAGENT_OTEL=off` kill switch + `enabled` flag still gate all three. *Rejected:* (a) couples the signals,
forcing all-or-nothing.

### KDD-5 — Flush on `agent_end` + `session_shutdown`, reuse the in-flight-await
Same cadence + the RW9-1 last-batch-await as traces, so metrics/logs survive a hard exit and add no new flush
machinery. *Options:* a separate timer-based metric reader (b) vs the existing event-driven flush (a).
*Choice:* **(a)** — event-driven matches the exporter; a periodic reader is SDK machinery (Scope Boundary).

### KDD-6 — In the same extension, compose, no kernel change, off by default
Metrics + logs are sibling signals of the same exporter, reusing `attr`/`nanos`/`fetch`/`parseHeaders`/
`warnOnce`/`enabled`. *Options:* a new `otel-metrics` extension (b) vs in-file (a). *Choice:* **(a)** — one
exporter owns the OTLP wire for all three signals; splitting duplicates the endpoint/fetch/gating code.
*Rejected:* (b) a second extension for the same concern.

## 5. Dependencies and Assumptions

- **Builds on (all shipped):** `otel-exporter.ts`'s `attr`/`nanos`/`hex`/`endpoint`/`enabled`/`parseHeaders`/
  `warnOnce`/the fire-and-forget+await flush (Wave 7c + RW9-1), and the `usage`/`tool_end`/`error`/`agent_end`/
  `session_shutdown` events. No new dependency (hand-rolled OTLP/HTTP-JSON over global `fetch`, zero-dep).
- **Assumes** offline tests stub `globalThis.fetch` (as the traces tests do, `web.ts`/`otel-exporter.test.ts`
  pattern) to capture `(url, init)` per signal and assert the OTLP body shape.

## 6. Relationship with Existing Designs

- **Extends** `docs/design/2026-06-29-otel-exporter.md` (the traces v1): same hand-rolled OTLP/HTTP-JSON
  posture, same off-by-default gating, same **no-content** invariant (KDD-2 upholds it for logs), same
  `fetch`/`attr` machinery. RW7c-1 in `docs/DEFERRED-FOLLOWUPS.md` is this design's registration. **No
  conflict** — additive (two more signals in the same exporter; traces unchanged).
- Reuses the RW9-1 last-batch-flush-on-shutdown fix (`otel-exporter.ts`, F-review G1).
- Terminology anchors: the otel-exporter docstring + README row; CLAUDE.md _engineering-norms_ (zero-dep,
  off-by-default, no kernel change, no content leak).

## 7. Acceptance Criteria (measurable, automatable, offline)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing + new).
- **AC-3 (metrics body)** with `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` set + a stub `fetch`, after a run with a
  `usage` event (input+output, and cache tokens) and tool calls (one ok, one error), a POST to that URL has
  `Content-Type: application/json` and body `{ resourceMetrics:[{ resource, scopeMetrics:[{ scope, metrics:[…]}]}]}`
  containing an `eagent.gen_ai.token.usage` **Sum** (data points per `gen_ai.token.type` with `asInt` strings,
  `aggregationTemporality:2`, `isMonotonic:true`) and an `eagent.tool.calls` Sum (data points by `error`).
- **AC-4 (logs body + trace correlation)** with the logs endpoint set, an `error` event → a logRecord
  `severityNumber:17`/`severityText:"ERROR"`, `body.stringValue` = `where` + the error **class name** (NOT the
  raw message); an `agent_end` → a `severityNumber:9`/`severityText:"INFO"` record with
  `gen_ai.response.finish_reason`, carrying the run's `traceId`/`spanId` (G3). Body
  `{ resourceLogs:[{ resource, scopeLogs:[{ scope, logRecords:[…]}]}]}`.
- **AC-5 (no content leak — strengthened)** assert **no** metrics/logs attribute or log body contains a
  tool's `arguments`/`result.content` text or any model message text; specifically, an `error` thrown with a
  message embedding an argument fragment (`new Error("secret=" + x)`) does **NOT** appear in the log body
  (which is bounded to `where` + the error class name, G2). Only metadata: token type, finish reason, where,
  error class, tool error-flag.
- **AC-6 (independent signals)** with **only** the metrics endpoint set (no logs, no traces var) → a POST to
  `/v1/metrics` only, none to `/v1/logs` or `/v1/traces`; and vice-versa for logs.
- **AC-7 (off-by-default inert)** with no OTLP endpoint vars → zero `fetch`; with `EAGENT_OTEL=off` → zero
  `fetch` even if endpoints are set.
- **AC-8 (cumulative + decimal strings)** token Sum data points are `aggregationTemporality:2`,
  `isMonotonic:true`, `asInt` is a decimal **string**, with `startTimeUnixNano` (session start) ≤
  `timeUnixNano`.
- **AC-9 (collector-down never breaks the run)** a stub `fetch` that rejects → the agent run still completes
  (reason normal), no error propagates (a `warnOnce`), and the trace export is unaffected.
- **AC-10 (no kernel change)** `kernel-surface` green; `src/kernel` still **2186**; `BUILTIN_EXTENSIONS`
  count unchanged (signals added in-file); no capability change (the exporter declares none).

*Quality budget excluded:* the exporter is a best-effort, off-by-default observer on a fire-and-forget
`fetch`; no latency/throughput AC (same stance as the traces v1, `otel-exporter.md` §7).

## 8. Risks and Rollback

- **R1 — OTLP wire-format errors** (a collector rejects a malformed metrics/logs body). *Mitigation:* the
  body shapes are pinned to the OTLP/HTTP-JSON spec (resourceMetrics/Sum/NumberDataPoint;
  resourceLogs/LogRecord) and asserted offline (AC-3/AC-4); `asInt`/nanos are decimal strings (the trace
  exporter's proven convention). *Residual:* no live-collector validation — RW7c-3 (real-collector smoke)
  stays deferred. *Rollback:* unset the metrics/logs endpoint vars (each signal inert independently).
- **R2 — content leak via metrics/logs** (the exporter's load-bearing invariant). *Mitigation:* KDD-2 (logs
  metadata-only) + AC-5 (explicit no-content assertion over both new signals). *Rollback:* the no-content
  rule is enforced by what the code folds; a leak is a test failure, not a config.
- **R3 — metric cardinality blow-up** (e.g. a data point per tool *name* → unbounded series). *Mitigation:*
  `eagent.tool.calls` is keyed only by `error` (true/false), not tool name; token usage by the 4 fixed types
  — bounded label sets. Documented.
- **R4 — best-effort export drops data on a down collector.** *Mitigation:* `warnOnce` + the run is never
  blocked (AC-9); the RW9-1 shutdown-await reduces hard-exit loss. Accepted (observability is best-effort).
- *Rollback:* metrics/logs are additive event-observers + flush calls in one file; removing them (or unsetting
  their endpoints) restores byte-identical traces-only behavior.

## L1 Review Log

- **Round 1** — zero severe (OTLP body shapes confirmed wire-correct) + 3 generals (G1 semconv
  `gen_ai.client.token.usage` is a Histogram → renamed the Sum to `eagent.gen_ai.token.usage`; G2 raw
  `Error.message` could leak a tool arg → bound the error log to `where` + the error class name; G3 trace
  correlation claimed but not wired → add `traceId`/`spanId` from the RunTrace) + clarifications (C1 generalize
  the accumulation gate to `anyEnabled()` for signal independence; C2 generalize `warnOnce`; C3 INFO
  severityText; C4 cache-types open-enum note). All folded.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
  (Impl reminder, not an issue: place metric/log accumulation *above* the existing `if (!trace) return` guard
  in the `usage`/`tool_end` handlers — a metrics-only run creates no RunTrace.)
