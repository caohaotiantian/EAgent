# Implementation — OTLP metrics + logs (otel-exporter)

```
Status: closed
Closing-commit: bb75a2d
Closed-on: 2026-06-30
Deferred: RW7c-2, RW7c-3, histograms — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-30-otlp-metrics-logs` (matches design) · **Design:**
[`design/2026-06-30-otlp-metrics-logs.md`](../design/2026-06-30-otlp-metrics-logs.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D6 — metrics + logs signals in `otel-exporter.ts` | design §2 D1-D6, KDD-1..6, AC-1..AC-10 |

One Phase: additive signal handlers + flush in `src/extensions/otel-exporter.ts` (no new file, no `host.ts`
edit, no kernel change), plus tests. The **traces `/v1/traces` body is byte-identical**, BUT a config set via
the **base** var `OTEL_EXPORTER_OTLP_ENDPOINT` now **also** enables metrics + logs — this is **correct OTLP
behavior** (the base endpoint serves all three signals via `/v1/<signal>`), and is **not** a regression, but
it means **the existing traces-only tests (which use the base var) must migrate to the traces-specific
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`** to stay isolated to a single signal (see Task 0 + §5 — S1). A base-var
run legitimately produces 3 POSTs.

## 2. Phase Breakdown

### Phase 1 — metrics + logs

- **Entry condition:** on `feat/otlp-metrics-logs` off `init`. Baseline `npm test` green (1128 pass / 1129
  tests / 1 skip), kernel 2186.
- **Design refs:** §2 D1-D6; KDD-1 (Sum counters), KDD-2 (metadata-only logs), KDD-3 (cumulative), KDD-4
  (independent per-signal endpoints), KDD-5 (flush cadence + RW9-1 await), KDD-6 (in-file, no kernel change);
  AC-1..AC-10.
- **Files:** `src/extensions/otel-exporter.ts` (extend), `test/otel-exporter.test.ts` (extend — same file as
  the traces tests).

- **Per-signal endpoints + `anyEnabled` (D3):**
  - `metricsEndpoint()` / `logsEndpoint()` mirror the existing `endpoint()` (`:104`): the signal var
    (`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `…_LOGS_ENDPOINT`) if non-empty, else the base
    `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/metrics` / `/v1/logs` (strip a trailing `/` on the base, as
    `endpoint()` does), else `undefined`.
  - `const anyEnabled = () => (!!endpoint() || !!metricsEndpoint() || !!logsEndpoint()) && process.env.EAGENT_OTEL !== "off" && (e.store.get<boolean>("enabled", true) ?? true);`
  - keep the existing `enabled()` (traces) for the trace flush gate.

- **Session accumulators (D1):**
  - `const tokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };` `const toolCalls = { ok: 0, error: 0 };`
  - `const sessionStart = nanos();` (the Sum `startTimeUnixNano`).
  - `const logRecords: OtlpLogRecord[] = [];` where
    `interface OtlpLogRecord { timeUnixNano: string; severityNumber: number; severityText: string; body: { stringValue: string }; attributes: KeyValue[]; traceId?: string; spanId?: string; }`.

- **Accumulation handlers (CRITICAL placement, C1):** add the accumulation **above** the existing
  `if (!t) return` / trace-`enabled()` guards (a metrics-only run never creates a `RunTrace`):
  - in the `usage` handler (`:205`), **before** the trace logic: `if (anyEnabled()) { const u = usage; tokenUsage.input += u.inputTokens; tokenUsage.output += u.outputTokens; tokenUsage.cache_read += u.cacheReadTokens ?? 0; tokenUsage.cache_write += u.cacheWriteTokens ?? 0; }` (sum the **per-call** `usage`, the cumulative Sum is the session total).
  - in the `tool_end` handler (`:193`), **before** the trace logic: `if (anyEnabled()) { toolCalls[result.isError ? "error" : "ok"]++; }`.
  - a new `e.on("error", ({ error, where }) => { if (!logsEndpoint()) return; const t = currentActingAgent() ? traces.get(currentActingAgent()!) : undefined; logRecords.push({ timeUnixNano: nanos(), severityNumber: 17, severityText: "ERROR", body: { stringValue: \`${where}: ${(error as Error)?.constructor?.name ?? "Error"}\` }, attributes: [attr("error.where", where)], ...(t ? { traceId: t.traceId, spanId: t.rootSpanId } : {}) }); });` — **no raw `error.message`** (G2). **Gate the push on `logsEndpoint()`, NOT `anyEnabled()`** (r3 leak fix): `logRecords` is an unbounded array cleared only after a `/v1/logs` POST, so buffering it in a traces-only config (no logs endpoint → never flushed/cleared) would grow it for the session's life; only buffer when there is somewhere to send it.
  - the `agent_end` handler (currently `e.on("agent_end", () => { lastFlush = flush(); })` at `:229`) becomes
    `e.on("agent_end", ({ reason }) => { … lastFlush = flush(); })` — **destructure `reason`** and derive
    `const agent = currentActingAgent() ?? e.agent;` (`agent_end` fires inside `actingAgentStore.run`,
    `agent.ts:344`, so `currentActingAgent()` is live; G1). **Before** `lastFlush = flush()` (gated on
    `logsEndpoint()`, not `anyEnabled()` — the r3 leak fix, same as the `error` handler):
    `if (logsEndpoint()) { const t = traces.get(agent); logRecords.push({ timeUnixNano: nanos(), severityNumber: 9, severityText: "INFO", body: { stringValue: "agent_end" }, attributes: [attr("gen_ai.response.finish_reason", reason)], ...(t ? { traceId: t.traceId, spanId: t.rootSpanId } : {}) }); }`.

- **Body builders + flush (D4):**
  - `metricsBody()` → `{ resourceMetrics: [{ resource: { attributes: [attr("service.name", "eagent")] }, scopeMetrics: [{ scope: { name: "eagent" }, metrics: [tokenMetric, toolMetric] }] }] }` where `tokenMetric` is a Sum over the `tokenUsage` entries **with value > 0** (`{ name: "eagent.gen_ai.token.usage", unit: "{token}", sum: { dataPoints: [...], aggregationTemporality: 2, isMonotonic: true } }`, each data point `{ attributes: [attr("gen_ai.token.type", type)], asInt: String(n), startTimeUnixNano: sessionStart, timeUnixNano: now }`) and `toolMetric` is a Sum with two data points (`error:"false"`→ok, `error:"true"`→error). Emit no `metrics[]` entry if a counter group is all-zero.
  - `logsBody()` → `{ resourceLogs: [{ resource: { attributes: [attr("service.name", "eagent")] }, scopeLogs: [{ scope: { name: "eagent" }, logRecords }] }] }`.
  - **Refactor `flush()`** into a generic `flushSignal(url, body): Promise<void>` (the POST + `warnOnce` +
    swallow). The **traces** branch keeps its existing pre-POST work — stamp any still-open span's
    `endTimeUnixNano` (`:130-131`), build the `resourceSpans` body, then `finished = []` **after** building —
    so the traces wire is byte-identical; only its raw `fetch(...)` is replaced by `flushSignal(tracesUrl,
    spansBody)`. Each signal flushes when its endpoint resolves AND it has data (traces: `finished.length`;
    metrics: any token/tool counter > 0; logs: `logRecords.length`). After a **logs** POST, **clear the logs
    buffer** (`logRecords.length = 0`); the token/tool counters **stay** (cumulative — they keep growing, the
    Sum re-sends the running total each flush). Generalize `warnOnce`'s message to be signal-agnostic (C2:
    it currently says "failed to POST traces"). Track all in-flight POSTs so `session_shutdown` awaits them —
    `lastFlush = Promise.all([…the up-to-3 flushSignal promises…]).then(() => {})` (extend the RW9-1 pattern).
  - the top-level `flush()` (called by `agent_end`/`session_shutdown`) now flushes all three signals.

- **D5:** `/otel status` adds the metrics/logs endpoints + buffered counts (token totals, tool totals,
  `logRecords.length`); `/otel on|off` unchanged (gates via the `enabled` flag, which `anyEnabled` honors).

- **Task list (TDD order)** — extend `test/otel-exporter.test.ts` (reuse its `globalThis.fetch` swap
  `:44-63`, env save/restore, the turn+tool+usage scripting; the stub must **route captured calls by URL
  path** — `/v1/traces` vs `/v1/metrics` vs `/v1/logs`):
  0. **(test migration, S1)** Add `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` + `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`
     to the test's `ENV_KEYS` save/restore set (`:17-22`). **Migrate the existing traces-only tests** that
     set the **base** var `OTEL_EXPORTER_OTLP_ENDPOINT` and assert a single POST (`:109,147,195,267,327,351,392,435`)
     to the traces-**specific** `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (so they stay isolated to one signal — a
     base-var run now legitimately fires all 3, by OTLP design). Their `calls.length === 1` /
     `order:["fetch-start"]` assertions then hold. (S1; the traces *wire* is unchanged.) **EXCEPT AC-6(d)
     (`:305`)** — it asserts the base var's trailing-slash → `…/v1/traces` *derivation* (the traces-specific
     var is returned verbatim, no suffix appended, `otel-exporter.ts:105-106`, so a var-swap would break it,
     G-B). **Keep AC-6(d) on the base var and route the captured calls by URL**, asserting the `/v1/traces`
     POST (among the now-3) carries the derived `…:4318/v1/traces` — this also supplies the positive coverage
     that the base var fires all three correctly-derived per-signal URLs.
  1. **(test) AC-3 metrics body** — set `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`; run a turn with two tool calls
     (one ok, one error) and **emit a `usage` event carrying `cacheReadTokens`/`cacheWriteTokens` directly**
     (`agent.hooks.emit("usage", { usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, cumulative })`
     — C3: MockProvider's `usage` carries only input/output, so cache tokens must be emitted directly); filter
     the captured calls to the `/v1/metrics` POST; assert body has `eagent.gen_ai.token.usage` Sum (data
     points per `gen_ai.token.type`, `asInt` strings, `aggregationTemporality:2`, `isMonotonic:true`) +
     `eagent.tool.calls` Sum (data points by `error`).
  2. **(test) AC-4 logs body + correlation** — set **both** a traces endpoint (so a `RunTrace` is created)
     **and** the logs endpoint; trigger an **in-run** error so `currentActingAgent()` is live and a trace
     exists — drive the agent to its **`maxTurns` error path** (`agent.ts:329-335`, which `emit`s `error`
     in-run). **NOT** a throwing tool (G-A: `runOne` *catches* a tool throw into an `isError` result + a
     `tool_end`, `agent.ts:475-479` — it never emits an `error` event), and **NOT** a bare harness
     `hooks.emit("error", …)` (runs **outside** `actingAgentStore.run`, so `currentActingAgent()` is undefined
     → no correlation, G2). Run to `agent_end`; filter to the `/v1/logs` POST; assert a `severityNumber:17`/
     `"ERROR"` record whose body is `agent.run` + the error class (NOT a raw message) and an `agent_end`
     `severityNumber:9`/`"INFO"` record with `gen_ai.response.finish_reason`; assert both carry
     `traceId`/`spanId`. (A logs-only config has no trace → no correlation; correct, a separate assertion if
     desired.)
  3. **(test) AC-5 no content leak (strengthened)** — emit `error` with `new Error("secret=" + "XYZ")` and a
     tool call whose `arguments` contain a marker; assert **no** metrics/logs body or attribute contains
     `"secret="`/`"XYZ"`/the arg marker (only `where`, the error class, token type, finish reason, tool
     error-flag).
  4. **(test) AC-6 independent signals** — with **only** the metrics endpoint set (no logs/traces var) → a
     POST to `/v1/metrics` only, none to `/v1/logs` or `/v1/traces`; symmetrically logs-only.
  5. **(test) AC-7 off-by-default inert** — no OTLP endpoints → zero `fetch`; `EAGENT_OTEL=off` with all
     endpoints set → zero `fetch`.
  6. **(test) AC-8 cumulative + decimal strings** — token Sum data points are `aggregationTemporality:2`,
     `isMonotonic:true`, `asInt` is a decimal string, `Number(startTimeUnixNano) ≤ Number(timeUnixNano)`.
  7. **(test) AC-9 collector-down** — a stub `fetch` that rejects → the agent run still completes (reason
     normal), no throw (a `warnOnce`), and the traces export is unaffected (the existing traces tests stay
     green).
  8. **(impl)** the endpoints/`anyEnabled`, accumulators, the 4 accumulation handlers (above the trace
     guards), the body builders, the refactored 3-signal flush, `/otel status`.
  9. **(verify)** `node --import tsx --test "test/otel-exporter.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/otel-exporter.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Exit:** AC-1..AC-10 pass; `npm test` green; typecheck 0; kernel 2186; `BUILTIN_EXTENSIONS` unchanged; the
  traces `/v1/traces` body byte-identical; existing trace tests migrated to the traces-specific var (Task 0)
  and green.

## 3. Engineering Constraints Index

- CLAUDE.md "House conventions" — ESM NodeNext `.js` specifiers; strict TS (`noUncheckedIndexedAccess` — guard
  `tokenUsage`/`toolCalls` keyed access; build data points via `Object.entries`/explicit literals, not raw
  index); zero deps but jiti (`node:crypto` + global `fetch` only — **no `@opentelemetry/*`**); offline tests
  (stub `globalThis.fetch`); `EAGENT_OTEL=off` kill switch (now via `anyEnabled`); **no capability**; **no
  kernel change** (pure bus observer). **OTLP wire-criticals (same as traces):** wall-clock `nanos()` decimal
  strings; `asInt` decimal strings; `aggregationTemporality:2` (cumulative); `severityNumber` 9=INFO/17=ERROR;
  attrs as `KeyValue`/`AnyValue`; **fold only metadata, never argument/result/message content** (G2 — the
  error log excludes the raw `Error.message`).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` to script a turn with (parallel) tool calls + a `usage` event carrying `cacheReadTokens`; the
existing `globalThis.fetch` swap (`otel-exporter.test.ts:44-63`) capturing `(url, init)` **per signal** (the
test must route by URL path — `/v1/traces` vs `/v1/metrics` vs `/v1/logs`). Save/restore the OTLP endpoint
env vars (`…_ENDPOINT`, `…_METRICS_ENDPOINT`, `…_LOGS_ENDPOINT`, base) + `EAGENT_OTEL`. Emit an `error` event
via the kernel (the agent's error path, or a direct `e.agent.hooks.emit("error", …)` in the harness).
Offline; no new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. The **traces `/v1/traces` body is byte-identical** (the trace
  logic is unchanged; the shared `usage`/`tool_end` gate generalizes `enabled()`→`anyEnabled()`, a superset,
  and the new accumulation/log lines run before the unchanged trace logic). **But** a config set via the
  **base** var now fires metrics + logs too (correct OTLP — the base serves all signals), so the existing
  traces-only tests (which used the base var) are **migrated to the traces-specific var** in Task 0 to stay
  single-signal — a per-test 1-line change, not a behavior fix. After Task 0, all existing trace assertions
  (`calls.length === 1`, `order:["fetch-start"]`) hold. (S1.)
- The canonical-set host test covers no new registration (no new extension) — `BUILTIN_EXTENSIONS` unchanged.
- No kernel change → `kernel-surface.test.ts` unaffected (2186).

## L2 Review Log

- **Round 1** — 1 SEVERE (S1: the existing traces tests set the base var, which now derives metrics/logs
  endpoints too → a base-var run fires 3 POSTs, breaking `calls.length===1` — correct OTLP, but the tests
  must migrate to the traces-specific var) + generals (agent_end handler `agent`/`reason` not in scope; AC-4
  correlation needs an in-run error). Fixed: Task 0 migration + ENV_KEYS; the agent_end derivation; the
  maxTurns correlation route.
- **Round 2** — zero severe + 2 generals (G-A: a throwing tool is caught into an isError result + tool_end,
  emits no `error` event → AC-4 must use the maxTurns path; G-B: Task 0 over-migrated AC-6(d), which tests
  base-var derivation → keep it on the base var + URL-route). Fixed.
- **Round 3 (confirming, at cap)** — **zero severe, zero general.** Convergence confirmed (doc-text-only for
  two rounds, no design flaw). One non-blocking finding folded as an impl fix: gate the log-record push on
  `logsEndpoint()` (not `anyEnabled()`) so a traces-only config doesn't accumulate an unbounded `logRecords`
  buffer it never flushes. **L2 closed.**

## F Closeout Review

- **F end-to-end review** — **pass, zero severe.** OTLP metrics + logs bodies wire-correct (Sum{NumberDataPoint,
  aggregationTemporality:2, isMonotonic:true}, asInt/nanos decimal strings; resourceLogs/severityNumber
  9/17/traceId/spanId); the no-content invariant upheld (error body = `where` + class name, never
  `Error.message` — AC-5 strong); the traces `/v1/traces` wire byte-identical (only the `fetch` wrapped in
  `flushSignal`); the r3 leak fix applied (log pushes gated on `logsEndpoint()`); RW9-1 shutdown-await
  preserved via `Promise.all`. All 10 ACs real-tested + Task 0 migration complete (no traces test broken).
  Consolidation: README otel row + RW7c-1 RESOLVED. Gates: typecheck 0, `npm test` 1136 pass / 1 skip,
  kernel 2186, ext 58.
