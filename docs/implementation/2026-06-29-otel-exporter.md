# Implementation — OpenTelemetry (OTLP) trace exporter

**Slug:** `2026-06-29-otel-exporter` (matches design) · **Design:**
[`design/2026-06-29-otel-exporter.md`](../design/2026-06-29-otel-exporter.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D5 the `otel-exporter` extension + host registration | design §2 D1-D5, KDD-1..5, AC-1..AC-8 |

One Phase: a single new off-by-default bus-observer extension (no kernel change) + one
`BUILTIN_EXTENSIONS` line.

## 2. Phase Breakdown

### Phase 1 — The `otel-exporter` extension

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-6 + 7a + 7b merged). `npm test` green.
- **Design refs:** §2 D1-D5; KDD-1 (sibling not trace.ts), KDD-2 (hand-rolled OTLP/HTTP-JSON), KDD-3
  (best-effort swallow-all), KDD-4 (operator-egress), KDD-5 (one-trace-per-run, id-keyed); AC-1..AC-8.
- **Files:** `src/extensions/otel-exporter.ts` (new), `src/host.ts` (register), `test/otel-exporter.test.ts`
  (new).
- **Data model (closure):**
  - `const hex = (bytes) => randomBytes(bytes).toString("hex")` (from `node:crypto`); `traceId = hex(16)`
    (32 chars), `spanId = hex(8)` (16 chars).
  - `interface OtlpSpan { traceId; spanId; parentSpanId?; name; kind: 1; startTimeUnixNano: string;
    endTimeUnixNano?: string; attributes: KeyValue[]; status?: { code: 1 | 2 } }` where
    `type KeyValue = { key: string; value: { stringValue: string } | { intValue: string } }`.
  - Per-run state: `currentTraceId`, an `openSpans` map keyed by an internal key (the **agent** span by a
    fixed key; **turn** span by `turn`; **tool** spans by `call.id`), and a `finished: OtlpSpan[]` buffer.
  - `nanos = () => \`${Date.now()}000000\`` (wall-clock ms→ns decimal string; **never** `Date.now()*1e6`).
  - `attr(key, v)` builds a `KeyValue` (`stringValue` for string, `intValue: String(n)` for number).
  - `endpoint()`: the traces var (as-is) if **non-empty**, else (base non-empty &&
    `${base.replace(/\/+$/,"")}/v1/traces`); returns `undefined` if neither is a non-empty string (guard
    against an operator-set empty string, not just unset — use truthiness, not `!== undefined`).
  - `enabled()`: `!!endpoint() && process.env.EAGENT_OTEL !== "off" &&
    (e.store.get<boolean>("enabled", true) ?? true)`.
- **Task list (TDD order):**
  1. **(test)** `test/otel-exporter.test.ts` — **OTLP body shape + AnyValue** (AC-3): set
     `OTEL_EXPORTER_OTLP_ENDPOINT` (save/restore), inject a stub `fetch` capturing `(url, init)`; run a turn
     with a tool call; assert one POST to `<endpoint>/v1/traces`, `Content-Type: application/json`, body
     parses to `{resourceSpans:[{resource, scopeSpans:[{scope, spans:[…]}]}]}`, and
     `resource.attributes[0]` is `{key:"service.name", value:{stringValue:"eagent"}}`.
  2. **(test)** **IDs + nesting + string nanos** (AC-4): one 32-hex `traceId` shared; each `spanId` 16 hex;
     turn.parentSpanId === agent.spanId, tool.parentSpanId === turn.spanId; `startTimeUnixNano` is a string
     matching `/^\d+$/`, `> 1e18` (wall-clock, not a tiny `performance.now()` value), `Number(start) ≤
     Number(end)`; every span `kind === 1`.
  3. **(test)** **GenAI attrs + id-paired parallel tools** (AC-5): agent/turn span has `gen_ai.system`
     (non-empty) + `gen_ai.request.model`; after a `usage` event, `gen_ai.usage.input_tokens`/`output_tokens`
     present as `{intValue:"<n>"}`; a failed tool span has `status.code === 2`; two same-name parallel tool
     calls yield two correctly id-paired spans (start/end not swapped).
  4. **(test)** **off-by-default inert + endpoint resolution** (AC-6): with neither var (or `EAGENT_OTEL=off`)
     → zero `fetch`; with ONLY `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` → exports (one POST to that URL as-is);
     with a base var ending in `/` → POSTs to a single-slash `…/v1/traces`.
  5. **(test)** **collector-down never breaks the run** (AC-7): stub `fetch` to reject/throw; assert the
     agent run still completes (`reason` normal) and no error propagates (a one-time warn).
  6. **(test)** **no content leak** (R4): assert no span attribute contains the tool's `arguments` or the
     `result.content` text (only `gen_ai.tool.name` + status).
  7. **(impl)** `src/extensions/otel-exporter.ts`: default-export `activate(e)`; `EAGENT_OTEL === "off"` is
     handled inside `enabled()` (so the listeners stay registered but inert) — OR early-return a no-op if
     you prefer; either way `enabled()` gates every action. Register `e.on(...)`:
     - `agent_start`: if `enabled()`, start a fresh run — `currentTraceId = hex(16)`, open the agent span
       (`spanId = hex(8)`, no parent, `startTimeUnixNano = nanos()`, attrs `gen_ai.system` +
       `gen_ai.request.model`), reset `finished`.
     - `turn_start` `{turn}`: open a turn span (parent = agent spanId), key by `turn`.
     - `tool_start` `{call}`: open a tool span (parent = current turn spanId), key by `call.id`, attr
       `gen_ai.tool.name = call.name`. **Do NOT** fold `call.arguments`.
     - `tool_end` `{call,result}`: close the span keyed by `call.id` (set `endTimeUnixNano`; if
       `result.isError` set `status={code:2}`); push to `finished`. **Do NOT** fold `result.content`.
     - `usage` `{usage}`: add `gen_ai.usage.input_tokens`/`output_tokens` (intValue strings) to the agent
       span's attrs.
     - `turn_end`: close the turn span → `finished`.
     - `agent_end`: close the agent span → `finished`; then `flush()`.
     - `session_shutdown`: `flush()` (in case of a partial buffer).
     - `flush()`: if `!enabled()` or `finished.length === 0` return; build the `resourceSpans` body;
       `void fetch(endpoint()!, { method:"POST", headers:{ "content-type":"application/json",
       ...parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS) }, body: JSON.stringify(body),
       signal: AbortSignal.timeout(5000) }).catch(() => warnOnce())`; clear `finished`. (`AbortSignal.timeout`
       typechecks under this toolchain's `lib: ES2023` + `@types/node`; if a future bump regresses it, fall
       back to `mcp.ts`'s manual `AbortController` + `setTimeout(...).unref()` pattern.) (Fire-and-forget;
       never await into the loop; swallow-all — KDD-3.) **Helpers to define locally:** `parseHeaders(s?)` →
       `{}` if unset, else parse the OTLP convention (comma-separated `key=value` pairs:
       `s.split(",").map(p=>p.split("=")).filter(([k,v])=>k&&v)` → object); `warnOnce()` → a closure
       boolean so the collector-down warning (`e.log?.warn?.(...)` or `console.warn`) fires at most once.
     - `e.registerCommand({ name: "otel", … })`: `status` (print enabled()/endpoint()/finished.length),
       `on` (`e.store.set("enabled", true)`), `off` (`e.store.set("enabled", false)`). **No** capability.
     - Return a teardown disposing the listeners + command.
  8. **(impl)** `src/host.ts`: `import otelExporter from "./extensions/otel-exporter.js";` and append
     `["otel-exporter", otelExporter]` to `BUILTIN_EXTENSIONS`.
  9. **(verify)** `node --import tsx --test "test/otel-exporter.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/otel-exporter.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Exit:** AC-3..AC-7 + R4 pass; off-by-default inert; host canonical-set green; `npm test` green; typecheck 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` specifiers; strict TS
  (`noUncheckedIndexedAccess` — guard `openSpans` map gets); zero deps but jiti (`node:crypto` + global
  `fetch` only — **no `@opentelemetry/*`**); offline tests (stub `fetch`); `EAGENT_OTEL=off` kill switch;
  **no capability**; append to `BUILTIN_EXTENSIONS`; **no kernel change** (pure bus observer).
  **OTLP wire-criticals:** wall-clock `Date.now()` (NOT `performance.now()`); nanos as decimal **strings**
  (`${Date.now()}000000`, never `*1e6`); attrs as `KeyValue`/`AnyValue`; `kind:1`; `status.code:2`;
  fold **only** metadata (model/tokens/tool-name/status), never argument/result **content**.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` to script a turn with (parallel) tool calls + a `usage` event. The extension reads the
**global `fetch`**; the host/ExtensionAPI does **not** inject a fetch into extensions (only providers
self-inject), so the realizable stub is **reassigning `globalThis.fetch`** (save in `beforeEach`-style,
restore in `finally`) to capture `(url, init)` — empirically confirmed to intercept the bare `fetch()`
call (the same pattern `web.ts` uses). (Alternatively, POST to a real loopback `node:http` server as
`web.test.ts` does.) Save/restore `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`EAGENT_OTEL`. Offline; no real network.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. Off-by-default (no endpoint → inert) keeps the extension
  silent in the shipped config, so existing suites are unaffected — the core net.
- The canonical-set host test covers the registration (+1 extension; no dup tool/command names).
- No kernel change → `kernel-surface.test.ts` unaffected (2182).

## L2 Review Log

- **Round 1** — **zero severe** + 2 general (`parseHeaders`/`warnOnce` referenced-but-undefined + OTLP_HEADERS
  format unpinned → now specified locally; the "host slice passes a fetch" alternative was a nonexistent
  seam → dropped, §4 corrected to `globalThis.fetch` reassignment / loopback http). The key realizability
  risk (offline fetch stubbing) was **empirically confirmed** feasible. + clarifications (timeout=5000;
  README count → F).
- **Round 2** — **zero severe, zero general** (one pathological edge: empty-string env var → fixed via
  `endpoint()`/`enabled()` truthiness).
- **Round 3 (confirming)** — **zero severe, zero general** (reviewer probed `AbortSignal.timeout` through
  `tsc`). Two-generation satisfied. **L2 closed.**
