# Design — otel-exporter operation-duration histogram (RW7c-4)

**Slug:** `2026-07-01-otel-operation-duration-histogram` · **Tier:** Full (a histogram is a new OTLP
data-point shape, and the bucket boundaries are a threshold/magic-number decision to surface). Source:
`docs/DEFERRED-FOLLOWUPS.md` RW7c-4 (deferred from the OTLP metrics/logs design,
`docs/design/2026-06-30-otlp-metrics-logs.md` §3). Branch: `chore/finish-deferred-followups`.

## 1. Background and Purpose

`otel-exporter` emits two cumulative **Sum** metrics today — `eagent.gen_ai.token.usage` and
`eagent.tool.calls` (`otel-exporter.ts:195-228`). Sums are counters: they tell you *how many* tokens
and tool calls happened, but not *how long* model calls took. An SLO/alerting consumer needs the
**latency distribution** of model operations — p50/p90/p99 — which a Sum cannot give and which span
data cannot reliably give either (spans are sampled; metrics are not). RW7c-4 is the deferred third
metric: the OTel GenAI semantic-convention histogram **`gen_ai.client.operation.duration`** (a
*Histogram*, unit `s`), recording per-operation latency into fixed explicit buckets.

If we do not add it: a production operator running EAgent against a real OTLP collector has token/tool
**counts** but no model-call **latency distribution**, so they cannot set a latency SLO or alert on a
p99 regression without bolting on their own instrumentation.

## 2. Deliverables

- [ ] A third metric in `metricsBody()`: an OTLP **Histogram** named
  `eagent.gen_ai.client.operation.duration`, unit `s`, cumulative temporality (`aggregationTemporality:
  2`), one data point with attribute `gen_ai.operation.name = "chat"`, fixed `explicitBounds` =
  the OTel GenAI semconv advisory set, emitted only when at least one duration has been recorded.
- [ ] A closure-level histogram accumulator (`count`, `sum`, `bucketCounts[]`) and a per-acting-agent
  inference-start tracker (`WeakMap<Agent, number>` of `performance.now()` ms), updated in the
  `turn_start` (start stamp) and `usage` (record `(performance.now() − start) / 1000` **seconds** on
  stream completion, skipping when no start stamp) handlers, **gated on `anyEnabled()`** like the
  existing Sums — so a metrics-only run (no traces endpoint) still records durations.
- [ ] `hasMetricData()` extended so a run whose only metric signal is duration data still flushes
  `/v1/metrics`.
- [ ] Offline tests in `test/otel-exporter.test.ts`: a scripted MockProvider run with
  `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` set produces a `/v1/metrics` body containing the histogram with
  `count >= 1`, `sum(bucketCounts) === count`, `bucketCounts.length === explicitBounds.length + 1`,
  `aggregationTemporality === 2`, unit `"s"`; plus a default-inert check (no metrics endpoint ⇒ no
  histogram / unchanged behavior) and that the two existing Sums are unperturbed.

## 3. Scope Boundary (NOT in scope)

- **No bucket configuration.** The boundaries are a fixed constant (the semconv advisory set); no env
  var, no per-deployment override. (Configurable buckets are the heavier "bucket-boundary config" the
  RW7c-4 register entry explicitly weighs against; a follow-up if a consumer needs it.)
- **No new metric beyond `operation.duration`.** No `time_per_output_chunk`, no `time_to_first_token`,
  no server-side metrics — those are separate semconv metrics, each its own follow-up.
- **No per-tool duration histogram and no run-duration metric.** This measures the *chat operation*
  (one inference call), not tool execution time or whole-run time.
- **No change to the two existing Sums, the trace spans, the log records, the endpoints/kill-switch, or
  the flush/shutdown ordering.** Additive inside `metricsBody()` + two handler additions.
- **No kernel change** (`src/kernel/` untouched; the line ceiling is unaffected). **No new dependency.**
- **Quality budget:** observability-only, off by default (inert without a metrics endpoint); no hot
  path. Measured budgets: the offline histogram-shape assertions (AC) + `npm test`/`typecheck`/`eval`
  exit 0. No latency budget applies (the accumulation is two arithmetic ops per turn).

## 4. Key Design Decisions

### D1 — what "operation" means: the inference (chat) call, measured `turn_start → usage`

- **Problem:** `gen_ai.client.operation.duration` measures one GenAI operation's latency. EAgent has no
  dedicated inference span — a *turn* span (`turn_start`→`turn_end`) wraps the provider stream **plus**
  tool dispatch. What do we measure?
- **Options:**
  1. **`turn_start` → the turn's `usage` event** (chosen): the `usage` event is emitted right after the
     provider stream is fully consumed (`agent.ts:437`), *before* tool dispatch — so the delta is the
     pure inference latency. `usage` fires once per turn unconditionally, and turn-level events fire for
     the **acting** agent (so forks are measured too).
  2. `turn_start` → `turn_end` (the whole turn): includes tool-execution time, which pollutes an
     "LLM-latency" signal (a slow `bash` call would inflate the model-latency p99).
  3. `agent_start` → `agent_end` (whole run): coarse (one point per run, not per call), and
     `agent_start` does **not** fire for child forks (`otel-exporter.ts:280`), so fork runs would be
     unmeasured without a workaround.
- **Choice: option 1.** It is the closest available measurement for a metric named
  `…operation.duration` (per-inference latency, **excluding** tool dispatch), reliably fires every turn,
  and handles forks. Attribute `gen_ai.operation.name = "chat"` (the semconv operation name for a chat
  completion). The `usage` handler already runs `anyEnabled()`-gated token accumulation, so the
  duration record sits beside it with no new event subscription; only `turn_start` gains a
  start-stamp line. **Honest scope of the measured delta:** between `turn_start` and `usage` the loop
  also runs the `transformContext`/`transformRequest` filter hooks and, on a pre-commit
  `onProviderError` retry, every re-stream attempt (the agent-loop `continue` re-streams immediately;
  any inter-attempt backoff is HTTP-level inside a single `provider.stream` call) — `agent.ts:363-434`.
  So the value is "request-prep + provider stream (incl. any retries)," not solely the network
  round-trip. This is usually negligible and is the right "client operation" envelope; noted so the
  semantics are honest.
- **Rejected:** (2) over-counts tool time for an LLM-latency metric; (3) coarse + fork-blind.
- **Edges (both skip cleanly, no leak):** (i) a turn whose stream throws before `usage` records no
  duration (a failed inference isn't a completed operation) and leaves a stale `WeakMap` entry that the
  next `turn_start` overwrites (turns are sequential) and the WeakMap GCs with the agent; (ii) if
  `anyEnabled()` flips true mid-run (e.g. `/otel on` between `turn_start` and `usage`), the
  start-stamp is absent — so the `usage` record step **guards `if (start === undefined) return`**
  (mirroring the codebase's `if (!t) return` convention at `otel-exporter.ts:345-346`) and simply
  skips that one turn rather than recording a garbage delta.

### D2 — fixed bucket boundaries: the OTel GenAI semconv advisory set, no config

- **Problem:** an explicit-bucket histogram needs boundaries; arbitrary boundaries are a magic-number
  decision.
- **Options:** (a) the **OTel GenAI semconv advisory `ExplicitBucketBoundaries`** for this exact metric
  (chosen); (b) a custom set; (c) env-configurable boundaries.
- **Choice: (a)** — `[0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96,
  81.92]` (seconds). This is **not** an invented magic number: it is the published advisory set for
  `gen_ai.client.operation.duration` in the OpenTelemetry GenAI semantic conventions (verified against
  the semconv reference, 2026-07-01; a ×2 geometric progression 10 ms → ~82 s). Using the standard set
  makes EAgent's histogram directly comparable to every other GenAI-instrumented service and removes
  the decision from the operator. Defined as a single source-of-truth constant `OP_DURATION_BOUNDS`.
- **Rejected:** (b) a custom set would be the actual magic-number anti-pattern; (c) configurability is
  out of scope (Simplicity First) — add it only when a consumer needs non-standard buckets.

### D3 — cumulative temporality + correct OTLP/JSON histogram encoding; monotonic clock for the delta

- **Temporality:** cumulative (`aggregationTemporality: 2`), matching the two existing Sums (`:205,217`)
  and `sessionStart` as `startTimeUnixNano` — the exporter re-sends running totals each flush.
- **Encoding (OTLP/JSON `HistogramDataPoint`):** `count` and each `bucketCounts[i]` are uint64 →
  **decimal strings** (like the Sum's `asInt`); `sum` and `explicitBounds` are doubles → **numbers**;
  `bucketCounts.length === explicitBounds.length + 1` (the `+1` is the overflow bucket for values above
  the last bound). A value `d` lands in the first bucket whose bound `>= d`, else the overflow bucket.
- **Clock + unit:** the start/end pair uses **`performance.now()`** (monotonic, the correct primitive
  for an elapsed-time measurement — immune to wall-clock adjustment; already the codebase's
  duration clock at `trace.ts:53`), distinct from the span/point *timestamps* which must stay wall-clock
  `nanos()` (`Date.now()`-based) because those are absolute times. The two uses don't mix: the
  histogram's `startTimeUnixNano`/`timeUnixNano` are still `sessionStart`/`now` (wall clock); only the
  **value** is a `performance.now()` delta. **`performance.now()` returns milliseconds and the metric
  unit is `s`, so the recorded value is `(perfEnd − perfStart) / 1000` (seconds).** This `÷1000` is
  load-bearing: a missed conversion records ms-magnitude values that still produce a *well-formed*
  histogram (count/sum/bucketCounts shape intact) but land in the wrong buckets — so AC#1's shape
  assertions cannot catch it. The impl must convert, and a code reviewer must confirm the `/1000`
  literally (a near-instant MockProvider makes a value-magnitude test assertion either trivial or
  flaky, so it is checked by reading the code, not by a bucket-position assertion).

## 5. Dependencies and Assumptions

- No external systems for the offline tests (the `fetch` stub captures the POST body). Node globals only
  (`performance.now()`), no new dependency.
- Assumes `usage` is emitted once per turn after the stream completes (`agent.ts:436-437`,
  unconditional) — verified — so each completed inference is measured exactly once.
- Assumes the test's existing helpers (`metricsOf`/`metricNamed`/`callsTo`/`stubFetch`, the
  metrics-endpoint env var, and however the existing metrics tests await the `agent_end` flush) carry
  over; the histogram test mirrors the existing `eagent.gen_ai.token.usage` metrics test.

## 6. Relationship with Existing Designs

- **`docs/design/2026-06-30-otlp-metrics-logs.md`** (the two Sums + logs) — this is its registered
  follow-up RW7c-4. Strictly additive: same `metricsBody()` builder, same `anyEnabled()` gate, same
  `flushSignal`/endpoint plumbing; the two Sums and the logs signal are byte-identical. No conflict.
- **`docs/design/2026-06-29-otel-exporter.md`** (the trace exporter) — unaffected; traces are a separate
  signal/endpoint. The histogram is metrics-only and inert without a metrics endpoint.
- **W9.1 acting-agent seam** — the duration tracker is keyed by `currentActingAgent() ?? e.agent`,
  matching the existing `anyEnabled()`-gated Sum accumulation, so forks are attributed to the acting
  agent like everything else. No conflict.
- Terminology anchors: the OTel GenAI semconv (metric/attribute names), the existing `metricsBody`
  naming convention (`eagent.`-prefixed semconv metric names), CLAUDE.md.

## 7. Acceptance Criteria (measurable / automatable)

1. **Histogram present + well-formed:** with `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` set, a scripted
   MockProvider run that completes ≥1 turn yields a `/v1/metrics` POST whose body contains a metric
   named `eagent.gen_ai.client.operation.duration` with: `unit === "s"`; a `histogram` with
   `aggregationTemporality === 2`; one data point with `count >= 1` (decimal string),
   `Number(count) === sum-of-Number(bucketCounts)`, `bucketCounts.length === explicitBounds.length + 1`,
   `explicitBounds` equal to the advisory array, and `gen_ai.operation.name === "chat"` attribute. PASS
   = test green.
2. **Default inert / unperturbed Sums:** with a metrics endpoint set, the same body still contains the
   two existing Sums (`eagent.gen_ai.token.usage`, `eagent.tool.calls`) unchanged; with **no** metrics
   endpoint, no `/v1/metrics` POST occurs (existing behavior). PASS = test green.
3. **No regression:** `npm test` exit 0 (existing otel-exporter tests + the new ones; full suite ≥ 1144
   pass / 0 fail / 1 skip), `npm run typecheck` exit 0, `npm run eval` exit 0, `src/kernel/` untouched.

## 8. Risks and Rollback

- **Risk:** the `usage`-as-inference-end coupling mis-measures if a future change stops emitting `usage`
  per turn. **Mitigation:** `usage` is unconditional today (verified `agent.ts:436-437`); a missing
  `usage` only *omits* a measurement (no crash) and the WeakMap entry GCs. **Rollback:** remove the
  histogram branch + the two handler additions; the two Sums are untouched.
- **Risk:** wrong OTLP histogram encoding (e.g., `count` as a number, or `bucketCounts.length` off by
  one) → a collector rejects the metric. **Mitigation:** AC#1 asserts the exact shape (string
  count/bucketCounts, `length === bounds+1`, temporality 2) against the captured body. **Rollback:** as
  above; metrics are best-effort (a rejected POST is swallowed, never breaks the agent).
- **Risk (silent, AC-invisible):** recording the delta in **milliseconds** instead of seconds (omitting
  the `÷1000`). The histogram stays *well-formed* (count/sum/bucketCounts shape intact), so AC#1 passes,
  but every value lands in the overflow bucket (ms values ≫ the 81.92 s top bound) — a wrong latency
  distribution. **Mitigation:** D3/Deliverable #2 mandate `(performance.now() − start) / 1000`, and the
  L2/L3 review explicitly confirms the `/1000` literal by reading the code (a near-instant MockProvider
  can't pin the magnitude). **Rollback:** revert the histogram branch.
- **Risk:** the duration record perturbs an existing metrics test (e.g., a body-shape assertion). 
  **Mitigation:** AC#2 pins the two Sums unchanged; the histogram is additive (a new array element).
  **Rollback:** revert the `metricsBody` branch.
- **Overall rollback:** one self-contained extension diff (one file + its test); revert restores the
  two-Sum behavior exactly.
