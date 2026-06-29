# Design — OpenTelemetry (OTLP) trace exporter

**Slug:** `2026-06-29-otel-exporter` · **Wave:** 7 (subsystem 3 of 4) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P3.3 (exporter half) · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md`

## 1. Background and the gap (code as truth)

A Wave-7 surface audit established the split: P3.3 is two independent gaps — an **OTel exporter** (this
doc, 7c) and **evals-as-CI** (7d). On the exporter:

- `trace.ts` already folds the bus into a span model — `Span { kind:"agent"|"turn"|"tool", name,
  startedAt, endedAt?, durationMs?, ok?, meta? }` (`trace.ts:27-37`), nested via LIFO `openSpan`/`endSpan`
  (`trace.ts:70-82`), with `/trace` (tree), `/usage`, and `/trace-save` (custom JSONL — one `Span` per
  line, `trace.ts:242`). It is a **bespoke** format: **no** trace/span IDs, **no** W3C `traceparent`, **no**
  OTLP wire format. Nothing in `src/` references otel/otlp/opentelemetry (grep clean).
- So EAgent cannot emit to any standard observability backend (Jaeger/Tempo/Honeycomb/Grafana). The gap is
  a **standards-compliant OTLP exporter**.
- `node:crypto` is an allowed builtin (used in `server.ts`), so trace/span IDs are generatable zero-dep.

This wave ships a new off-by-default `otel-exporter` extension: a **pure bus observer** (mirroring
`trace.ts`'s folding) that builds OTLP spans with generated IDs + parent nesting + OTel **GenAI** semantic
attributes, and POSTs them as **OTLP/HTTP-JSON** to a configured collector via global `fetch`. Hand-rolled
(no `@opentelemetry/*` SDK — zero-dep). No kernel change.

## 2. Deliverables

- [ ] **D1** A new `otel-exporter` extension (`src/extensions/otel-exporter.ts`), **off by default**.
  **Single enable signal (no double-gate):** export is active iff a collector endpoint is configured —
  **either** `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` **or** `OTEL_EXPORTER_OTLP_ENDPOINT` (the resolved
  endpoint per D4) — AND not suppressed. Two suppressors: the `EAGENT_OTEL=off` kill switch, and a store
  flag toggled by `/otel on|off` that **defaults to on** (`store.get("enabled", true)`), so an
  endpoint-configured operator exports *without* a separate `/otel on`; `/otel off` is a runtime suppress.
  With **no** endpoint, the extension is inert regardless of the flag (off by default). It registers only
  `e.on(...)` listeners + the `/otel` command. **Pure observer** — registers only `e.on(...)` lifecycle
  listeners, **never** a filter hook; declares **no** capability for its own logic but **its network POST
  is gated** (see KDD-4). **No kernel change.**
- [ ] **D2** Span folding (reuse `trace.ts`'s *structure*, NOT its clock): on `agent_start` open the root
  **agent** span (new `traceId` = 16 random bytes hex = 32 hex chars, root `spanId` = 8 random bytes hex =
  16 hex chars); `turn_start` → a **turn** span (parent = agent span); `tool_start` → a **tool** span
  (parent = current turn), **keyed by `call.id`**; `tool_end` closes the span matching that **`call.id`**
  (NOT a name-based LIFO — `trace.ts:156` matches by name, which mis-pairs two same-name parallel calls;
  the exporter has `call.id` in both `tool_start` and `tool_end` payloads, so id-keying is correct).
  **Timestamps (S1+S2 — wire-critical):** use **wall-clock `Date.now()`** (NOT `trace.ts`'s
  `performance.now()` at `trace.ts:53`, which is monotonic-since-process-start and would stamp every span
  near 1970). `startTimeUnixNano`/`endTimeUnixNano` are OTLP `fixed64` → emit as **decimal strings**, built
  without float overflow: `` `${Date.now()}000000` `` (ms→ns by appending 6 zeros) — never `Date.now() *
  1e6` (≈1.78e18 > `Number.MAX_SAFE_INTEGER` ≈9e15, which corrupts low digits before serialization).
- [ ] **D3** OTel **GenAI** semantic attributes, **OTLP-encoded** as `KeyValue`/`AnyValue` (NOT a bare
  map): each attribute is `{ key, value: { stringValue } }` or `{ key, value: { intValue: "<n>" } }`
  (`intValue` is int64 → a **decimal string** in proto3 JSON). Agent/turn spans carry `gen_ai.system`
  (the provider — read via `e.agent.providers.get(e.agent.providerName)?.name`, falling back to
  `e.agent.providerName ?? "unknown"` since `providerName` may be undefined/defaulted) +
  `gen_ai.request.model` (`e.agent.model`); on `usage` events `gen_ai.usage.input_tokens` /
  `gen_ai.usage.output_tokens` (`intValue` strings). Tool spans carry `gen_ai.tool.name` (the tool name);
  span `status` = `{ code: 2 }` (OTLP `STATUS_CODE_ERROR`) for a failed tool/turn, else omitted/`{code:1}`.
  OTLP span `kind` is the **integer enum** `1` (`SPAN_KIND_INTERNAL`) — NOT `trace.ts`'s `"agent"|"turn"|
  "tool"` role string (that role goes in the span **name**/attributes).
- [ ] **D4** **OTLP/HTTP-JSON export**: on `agent_end` (and `session_shutdown` flush), POST the collected
  spans as `{ resourceSpans: [{ resource: { attributes: [{ key:"service.name", value:{ stringValue:
  "eagent" } }, …] }, scopeSpans: [{ scope: { name:"eagent" }, spans: [ … ] }] }] }` (every `attributes`
  entry is the `KeyValue`/`AnyValue` shape from D3 — **not** a bare key/value map) with
  `Content-Type: application/json`, via global `fetch` with a **bounded timeout** (AbortSignal) and a
  **swallow-all** catch (a collector being down must never break the agent loop — best-effort, like
  `trace.ts`). **Endpoint:** POST to `${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT}` **as-is** if set, else
  `${OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, "")}/v1/traces` (the OTLP env convention: the
  signal-specific var is used verbatim, the base var gets a **single** `/v1/traces` appended — strip any
  trailing slash first so a `host:4318/` base doesn't yield a `//v1/traces` double-slash that collectors
  404). Honor `OTEL_EXPORTER_OTLP_HEADERS` (e.g. an auth header) if set.
- [ ] **D5** A `/otel [status|on|off]` command (status: enabled/endpoint/queued-span-count). Registered in
  `BUILTIN_EXTENSIONS`. Tests stub `fetch` and assert the OTLP body shape.

## 3. Scope Boundary (NOT in scope)

- **No** `@opentelemetry/*` SDK / any npm dependency — hand-rolled OTLP/HTTP-**JSON** over global `fetch`
  (the zero-dep rule). No protobuf/gRPC exporter (JSON-over-HTTP is the simplest conformant transport).
- **No** change to `trace.ts` — it stays the local/REPL tracer; this is the *export-to-a-backend* sibling.
  (Reuse its span *shape/folding pattern*, but a separate extension — they have different lifecycles:
  trace.ts is always-on local introspection, otel-exporter is opt-in network egress.)
- **No** metrics/logs OTLP signals in v1 — **traces** only (the highest-value signal; metrics/logs are a
  follow-up).
- **No** distributed-context propagation (injecting `traceparent` into outbound tool HTTP) — v1 emits its
  own root traces; cross-service propagation is a later design.
- **No** kernel change — pure bus observer + an extension.
- **On by default? No** — inert without an endpoint; opt-in via config (network egress must be deliberate).

## 4. Key Design Decisions

### KDD-1 — A new extension, not an extension of `trace.ts`
*Problem:* trace.ts already models spans — extend it or add a sibling? *Options:* (a) add OTLP export to
`trace.ts`; (b) a new `otel-exporter` extension reusing trace.ts's *folding pattern*. *Choice:* **(b)** —
different lifecycles (trace.ts is always-on local introspection with zero egress; the exporter is opt-in
**network egress** to an external collector — a privileged, deliberate action). Bundling network egress
into the always-on local tracer would surprise operators and couple two concerns. They share the span
*shape* (copied/adapted), not the module. *Rejected:* (a) couples local introspection with network export.

### KDD-2 — Hand-rolled OTLP/HTTP-JSON over `fetch` (zero-dep)
*Problem:* OTLP normally ships via `@opentelemetry/exporter-*`. *Options:* (a) the SDK (a dep — forbidden);
(b) hand-roll the OTLP/HTTP-JSON envelope and POST via global `fetch`. *Choice:* **(b)** — the zero-dep
rule forbids the SDK; OTLP/HTTP-JSON is a stable, documented wire format (`resourceSpans` → `scopeSpans` →
`spans`), and `fetch` is already the provider transport. IDs via `node:crypto` (an allowed builtin).
*Rejected:* (a) violates zero-dep.

### KDD-3 — Pure observer; best-effort, swallow-all export
*Problem:* a down collector must not affect the agent. *Options:* (a) await/propagate export errors;
(b) pure `e.on` observer; the POST is fire-and-forget with a bounded timeout + a swallow-all catch + a
one-time warn. *Choice:* **(b)** — observability is never load-bearing; mirrors `trace.ts`'s best-effort
posture and the kernel's handler-error containment. The exporter can never break a run. *Rejected:* (a)
makes telemetry a failure mode.

### KDD-4 — Network egress gating
*Problem:* the exporter POSTs to a network endpoint — should it declare `net:fetch`? *Options:* (a) declare
`net:fetch` on a *tool*; (b) it has no tool — it's a bus observer that POSTs directly. *Choice:* the
exporter is **opt-in by configuration** (no endpoint → no POST) and **off by default**; the endpoint is an
operator-set env var (a deliberate, trusted target, like the LLM provider's own endpoint, which also isn't
capability-gated). It registers no tool, so there is no `execute` for the dispatcher to gate; the egress is
to an operator-configured, fixed, non-model-controlled URL (KDD-3 best-effort). Documented honestly: this
is *operator-configured telemetry egress*, not model-controlled `net:fetch`. (If a deployment wants it
gated, the kill switch + the absent-endpoint default are the controls.) *Rejected:* (a) there is no tool to
attach the capability to; faking one would be misleading.

### KDD-5 — One trace per `run()`; LIFO-nested spans (reuse trace.ts folding)
*Problem:* trace/span structure. *Options:* (a) a flat span list; (b) a root agent span per run, turn
spans as children, tool spans as grandchildren (LIFO match like `trace.ts:70-82`). *Choice:* **(b)** — it
mirrors `trace.ts`'s proven folding and produces the conventional nested trace observability backends
expect. A fresh `traceId` per `agent_start`; `parentSpanId` wires the nesting. *Rejected:* (a) loses the
call hierarchy.

## 5. Dependencies and Assumptions

Independent of the other Wave-7 subsystems. Reuses `trace.ts`'s span shape/folding *pattern* (adapted, not
imported — though a shared helper is possible if clean). Uses `node:crypto` `randomBytes` (allowed builtin)
for IDs and global `fetch` (the provider transport) for export. Assumes `OTEL_EXPORTER_OTLP_ENDPOINT` is an
operator-trusted collector. Assumes the bus emits `agent_start`/`turn_start`/`tool_start`/`*_end`/`usage`/
`agent_end`/`session_shutdown` (it does). Offline tests stub `fetch`.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P3.3 (exporter half; evals-as-CI is the sibling 7d). Complements `trace.ts`
(local tracer) and `evals.ts` (offline quality). Adds a `otel-exporter` row to the README table + count
55→56; reconciled at F. No kernel change, no filter-count change.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing 1033 + new).
- **AC-3 (OTLP body shape + AnyValue encoding)** With `OTEL_EXPORTER_OTLP_ENDPOINT` set and a **stubbed
  `fetch`**, run a turn with a tool call; assert exactly one POST to `<endpoint>/v1/traces`,
  `Content-Type: application/json`, body parses to `{resourceSpans:[{resource, scopeSpans:[{scope,
  spans:[…]}]}]}`, and the `service.name` resource attribute is the **`{key, value:{stringValue}}`**
  KeyValue shape (NOT a bare map) — assert `resource.attributes[0].key==="service.name"` &&
  `.value.stringValue==="eagent"`.
- **AC-4 (IDs + nesting + string nanos)** All spans share one **32-hex-char** `traceId`; each `spanId` is
  **16 hex chars**; the turn span's `parentSpanId` = the agent span's `spanId`, and the tool span's
  `parentSpanId` = the turn span's `spanId`; `startTimeUnixNano`/`endTimeUnixNano` are **decimal strings**
  (assert `typeof === "string"` and `/^\d+$/`), `Number(start) ≤ Number(end)`, and the value is wall-clock
  (≈ now·1e6, i.e. > 1e18 — NOT a tiny `performance.now()`-derived number). `kind === 1` (INTERNAL).
- **AC-5 (GenAI attributes)** The agent/turn span carries `gen_ai.system` (provider, non-empty) +
  `gen_ai.request.model`; after a `usage` event, `gen_ai.usage.input_tokens`/`output_tokens` are present as
  `{intValue:"<n>"}` (decimal-string int); a failed tool span has `status.code === 2` (STATUS_CODE_ERROR).
  Parallel same-name tool calls produce correctly id-paired spans (start/end not swapped).
- **AC-6 (off-by-default inert)** With **neither** endpoint var set (or `EAGENT_OTEL=off`), a full run
  makes **zero** `fetch` calls (the stub is never invoked) — inert. Also assert that setting **only**
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (not the base var) **does** export (no silent inertness), and that a
  base var with a trailing slash POSTs to a single-slash `…/v1/traces` (no `//`).
- **AC-7 (collector-down never breaks the run)** With `fetch` stubbed to reject/throw, the agent run still
  completes (`reason` normal); the export error is swallowed (a one-time warn, no throw).
- **AC-8 (no new surface beyond the row)** Host canonical-set green: `BUILTIN_EXTENSIONS.length` +1, no dup
  tool/command names; no kernel change (`kernel-surface` 2182).

*Quality budget:* span folding is O(events) in memory; one batched `fetch` POST per run (bounded timeout).
Negligible; off by default. Excluded.

## 8. Risks and Rollback

- **R1 — Export blocks/slows the loop.** *Mitigation:* fire-and-forget POST, bounded `AbortSignal`
  timeout, swallow-all catch (KDD-3); AC-7 pins it. *Rollback:* `EAGENT_OTEL=off` / unset the endpoint.
- **R2 — Malformed OTLP rejected by the collector.** *Mitigation:* AC-3/AC-4/AC-5 pin the body shape +
  id/nesting/attribute conventions against a stub; a real-collector smoke is a deferred follow-up
  (offline can't validate a live backend). *Rollback:* the kill switch.
- **R3 — Unintended network egress.** *Mitigation:* off by default (no endpoint → inert, AC-6); endpoint
  is operator-set; kill switch; documented as operator-configured egress (KDD-4). *Rollback:* unset.
- **R4 — Sensitive data in span attributes** (prompts/results). *Mitigation:* v1 emits *metadata* (model,
  token counts, tool names, status) — **not** message/argument content. The `tool_start` payload carries
  `call.arguments` and `tool_end` carries the full `result` (`events.ts:41,43`); the exporter MUST
  deliberately fold **only** `call.name`/`result.isError`, never `arguments`/`result.content`, into
  attributes (a test asserts no argument/result content appears in any span). *Rollback:* the kill switch.
- **R5 — README table/count stale.** *Mitigation:* reconcile at F (55→56).

A single off-by-default, inert-without-config bus-observer extension; reverting the registration removes it
cleanly with zero effect on any other component.

## L1 Review Log

- **Round 1** — 2 SEVERE (compounding OTLP timestamp defects): S1 reusing `trace.ts`'s `performance.now()`
  (monotonic, not wall-clock) → ~1970 timestamps; S2 nanos as `ms × 1e6` (≈1.78e18) overflow
  `Number.MAX_SAFE_INTEGER` + OTLP `fixed64` needs decimal **strings**. + general (AnyValue/KeyValue
  encoding; tool-span id-keying vs name-LIFO; `gen_ai.system` accessor) + clarifications (kind=1 INTERNAL;
  status.code=2; traces-endpoint-as-is). Fixed: `Date.now()` + `${...}000000` strings; KeyValue encoding;
  id-keyed pairing; integer enums; content-drop test.
- **Round 2** — zero severe + 2 general (enablement keyed only on the base var → silent inertness when
  only the traces var is set; trailing-slash `//v1/traces` 404). Fixed (either-var; strip trailing slash).
- **Round 3** — **zero severe, zero general** (one non-blocking note: enablement double-gate). Fixed —
  single enable signal, store flag defaults on.
- **Round 4 (corroborating)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
