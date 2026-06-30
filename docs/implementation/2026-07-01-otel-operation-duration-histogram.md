# Implementation — otel-exporter operation-duration histogram (RW7c-4)

Status: closed
Closing-commit: be0154a
Closed-on: 2026-07-01
Deferred: none. Phase 1 = commit be0154a (L3 closed in 3 rounds). Whole-project F review: pass (zero
severe). Suite 1147 pass / 0 fail / 1 skip; otel-exporter 19 pass; typecheck 0; eval 5/5; kernel
untouched.

**Slug:** `2026-07-01-otel-operation-duration-histogram` (identical to the design doc). **Design:**
`docs/design/2026-07-01-otel-operation-duration-histogram.md`.

## 1. Task Index

| Design artifact | Where | Phase |
|---|---|---|
| Deliverable: histogram metric in `metricsBody()` | §2 + D2 + D3 | Phase 1 |
| Deliverable: accumulator + `turnStartMs` tracker, `turn_start`/`usage` handlers | §2 + D1 + D3 | Phase 1 |
| Deliverable: `hasMetricData()` extension | §2 | Phase 1 |
| Deliverable: offline histogram-shape tests | §2 + §7 AC#1/#2 | Phase 1 |
| Acceptance Criteria 1–3 | §7 | Phase 1 |

`<TEST-CMD>` = `npm test`. Per-file: `node --import tsx --test test/otel-exporter.test.ts`. Other gates:
`npm run typecheck`, `npm run eval`.

## 2. Phase Breakdown

### Phase 1 — `gen_ai.client.operation.duration` histogram (single phase)

**Entry condition:** clean tree on `chore/finish-deferred-followups`; baseline `npm test` green (1144
pass / 0 fail / 1 skip), typecheck 0, eval 5/5.

**Design references:** D1 (operation = inference, `turn_start`→`usage`, the guard + honest-scope note),
D2 (fixed semconv buckets), D3 (encoding + ÷1000 + clock), §2 Deliverables, §7 AC.

**Files:** `src/extensions/otel-exporter.ts`, `test/otel-exporter.test.ts`. No `src/kernel/` change.

**Task list (TDD order — test first):**

1. **[test] histogram-present-and-well-formed** in `test/otel-exporter.test.ts` (mirror the AC-8
   `eagent.gen_ai.token.usage` metrics test, ~line 785): set
   `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `captureFetch()`, `makeHarness({ responder: [{ text: "hi" }] })`,
   `await host.use("otel-exporter", otelExporter)`, `await agent.run("go")`. Then locate the metric
   named `eagent.gen_ai.client.operation.duration` in `callsTo(calls, "/v1/metrics")[0]`. **Business
   invariant:** a completed turn records exactly one well-formed duration observation. Assert:
   `unit === "s"`; `metric.histogram.aggregationTemporality === 2`; one data point with
   `Number(dp.count) >= 1`; `dp.count` matches `/^\d+$/` (decimal string); each `dp.bucketCounts[i]`
   matches `/^\d+$/`; `dp.bucketCounts.reduce((a,b)=>a+Number(b),0) === Number(dp.count)`;
   `dp.bucketCounts.length === dp.explicitBounds.length + 1`; `dp.explicitBounds` deep-equals
   `[0.01,0.02,0.04,0.08,0.16,0.32,0.64,1.28,2.56,5.12,10.24,20.48,40.96,81.92]`; the data point's
   attribute `gen_ai.operation.name === "chat"`; and `dp.sum` is a finite number `>= 0`. (Add a
   `histogram?: { aggregationTemporality: number; dataPoints: HistogramDataPoint[] }` field next to
   `sum?` on the test's local `OtlpMetric` type — `test/otel-exporter.test.ts:114-118` — where
   `HistogramDataPoint = { attributes: KV[]; startTimeUnixNano: string; timeUnixNano: string;
   count: string; sum: number; bucketCounts: string[]; explicitBounds: number[] }`. Additive,
   test-only; test files aren't type-checked by `typecheck`/`test`, so it runs regardless, but the
   annotation keeps the assertions readable. Use `agent.run("go")` directly — the MockProvider's `done`
   carries `usage`, so the per-turn `usage` event fires and `count === 1` deterministically; assert only
   `count >= 1` + shape, never a bucket position, NEVER a value magnitude.)
2. **[test] Sums unperturbed + default-inert** in `test/otel-exporter.test.ts`: in the same (or a
   sibling) test, assert the two existing Sums (`eagent.gen_ai.token.usage`, `eagent.tool.calls`) are
   still present/unchanged in the body; and a second test asserts that with NO metrics endpoint there is
   no `/v1/metrics` POST (reuse an existing default-inert assertion pattern). **Invariant:** the new
   metric is additive and off without an endpoint.
3. **[impl] the bounds constant** — add a module/closure constant
   `OP_DURATION_BOUNDS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
   40.96, 81.92]` (the OTel GenAI semconv advisory set for this metric).
4. **[impl] accumulator + tracker** — add a closure-level `opDuration = { count: 0, sum: 0, buckets:
   new Array(OP_DURATION_BOUNDS.length + 1).fill(0) }` and `const turnStartMs = new WeakMap<Agent,
   number>()`. Add a `recordDuration(seconds: number)` helper: `opDuration.count++; opDuration.sum +=
   seconds; let i = OP_DURATION_BOUNDS.findIndex((b) => seconds <= b); if (i < 0) i =
   OP_DURATION_BOUNDS.length; opDuration.buckets[i]!++;`.
5. **[impl] `turn_start` start-stamp** — in the `turn_start` handler, BEFORE the existing
   `if (!enabled()) return;`, add `const acting = currentActingAgent() ?? e.agent; if (anyEnabled())
   turnStartMs.set(acting, performance.now());`. (Reuse `acting` for the existing trace work below
   instead of recomputing, or compute locally — match the file's style; do not change trace behavior.)
6. **[impl] `usage` record (with the ÷1000 + guard)** — in the `usage` handler, inside the existing
   `if (anyEnabled()) { … }` token-accumulation block, add: `const acting = currentActingAgent() ??
   e.agent; const start = turnStartMs.get(acting); if (start !== undefined) { recordDuration(
   (performance.now() - start) / 1000); turnStartMs.delete(acting); }`. **The `/1000` is load-bearing
   (ms→s) — confirm it literally; the guard skips a turn with no start stamp.** Use the **positive**
   `if (start !== undefined) { … }` form shown — NOT an early `return` — because the trace
   usage-upsert (`otel-exporter.ts:347-350`) sits below this in the same handler and must still run when
   `start` is undefined (a mid-run `/otel on` flip); an early `return` would wrongly skip it.
7. **[impl] `metricsBody()` histogram branch** — after the two Sum pushes, add (when `opDuration.count
   > 0`):
   ```
   metrics.push({
     name: "eagent.gen_ai.client.operation.duration",
     unit: "s",
     histogram: {
       aggregationTemporality: 2,
       dataPoints: [{
         attributes: [attr("gen_ai.operation.name", "chat")],
         startTimeUnixNano: sessionStart,
         timeUnixNano: now,
         count: String(opDuration.count),
         sum: opDuration.sum,
         bucketCounts: opDuration.buckets.map(String),
         explicitBounds: OP_DURATION_BOUNDS,
       }],
     },
   });
   ```
   (No `isMonotonic` — that is Sum-only.)
8. **[impl] `hasMetricData()`** — extend it to also return true when `opDuration.count > 0`, so a run
   whose only metric signal is duration data still flushes `/v1/metrics`.

**Per-task acceptance commands:**
- `node --import tsx --test test/otel-exporter.test.ts` exit 0 (existing + the new tests).
- `npm run typecheck` exit 0.

**Exit condition:** the new histogram test(s) pass; all existing otel-exporter tests stay green;
`npm test` green; typecheck 0; eval 5/5; `src/kernel/` untouched.

## 3. Engineering Constraints Index

- **Project engineering norms:** CLAUDE.md "House conventions" — ESM `.js` import specifiers, strict TS
  (no `any`), zero runtime deps, offline `node:test`. **No Claude/AI attribution in commits.**
- **Four-corner template:** `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):` / `fix(phase1-roundR):`; `<TEST-CMD>`/`<ACCEPT-CMD>`
  trailers; no AI mention.
- **OTLP correctness:** the histogram encoding must match D3 (string count/bucketCounts, number
  sum/explicitBounds, `length === bounds+1`, temporality 2). The reviewer confirms the `/1000` literal.

## 4. Data and Fixture Dependencies

- **Reuse:** `test/otel-exporter.test.ts` helpers — `captureFetch`/`rejectingFetch`, `callsTo`,
  `metricsOf`/`metricNamed`, `saveEnv`/`clearEnv`/`restoreEnv`, the `makeHarness` + `host.use` pattern,
  the `responder` scripting. The AC-8 token-usage metrics test (~785) is the template.
- **New:** the histogram test(s); possibly a `histogram?` field on the test's local `OtlpMetric` type
  (additive, test-only). No new npm dependency; `performance.now()` is a Node global.

## 5. Regression Protection

- **Must stay green:** all existing `test/otel-exporter.test.ts` tests (the two Sums, traces, logs,
  endpoints, kill switch, collector-down) — the histogram is additive and must not perturb them; the
  full `npm test` suite; `npm run eval` (5/5). `src/kernel/` untouched (kernel-surface unaffected).
