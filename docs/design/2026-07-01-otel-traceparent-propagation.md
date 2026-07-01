# Design + impl — OTel trace-context propagation into tool HTTP (RW7c-2)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-01
Deferred: none of the core; the web.ts redirect-follow residual (below) is a documented low-severity
non-goal.

**Slug:** `2026-07-01-otel-traceparent-propagation` · **Tier:** Full (cross-extension: a new shared lib +
otel-exporter + web + mcp + their tests). Source: `docs/DEFERRED-FOLLOWUPS.md` RW7c-2. Branch:
`chore/finish-followups-4`.

## What / why

When `otel-exporter` traces are on, EAgent emits a per-tool-call span (`otel-exporter.ts:348-360`,
`traceId` + a fresh `spanId`, parented to the turn span). RW7c-2: **propagate that span as W3C
`traceparent`** on outbound tool HTTP so a downstream instrumented service becomes a child span of the
tool call — i.e. distributed traces that span EAgent → the services its tools call. Consumer: a
production deployment with instrumented downstreams (not the CLI).

## Design

**New `src/extensions/lib/otel-context.ts`** (pure, no capability, no dep):
- `traceparent(traceId, spanId) → "00-<32hex>-<16hex>-01"` (W3C, sampled flag `01`).
- a module `Map<callId, string>` with `setTraceparent(callId, tp)`, `getTraceparent(callId)`,
  `clearTraceparent(callId)` — the publish/consume channel keyed by the kernel's `toolCallId`.
- `isTrustedHost(url, allowlist) → boolean` — `new URL(url).hostname` exact-match or leading-dot suffix
  (`.example.com` matches `api.example.com`); malformed URL ⇒ false (fail-closed).
- `propagateAllowlist() → string[]` — parse `EAGENT_OTEL_PROPAGATE_HOSTS` (comma-separated), **default
  empty**.

**otel-exporter (publish):** in the existing `tool_start` handler (gated on `enabled()`), after
building the tool-call span, `setTraceparent(call.id, traceparent(span.traceId, span.spanId))`; in
`tool_end`, `clearTraceparent(call.id)`. No new hook, no behavior change to spans/metrics.

**web (consume, Cut 2):** in the `fetch` tool `execute(args, ctx)`, after building `headers`, inject
`headers["traceparent"] = tp` when `getTraceparent(ctx.toolCallId)` is set **and** `isTrustedHost(url,
propagateAllowlist())`.

**mcp (consume, Cut 1):** add an optional `callId?: string` to the internal `Transport.request` (both
`StdioTransport` — ignores it — and `HttpTransport`); the mcp tool `execute` passes `ctx.toolCallId`;
`HttpTransport.#post` injects `traceparent` when `getTraceparent(callId)` is set **and**
`isTrustedHost(this.#url, propagateAllowlist())`.

## The non-degrading gate (why default = byte-identical)

Injection fires only when **both** hold: (1) otel traces are **enabled** — the *only* writer of the map,
so with otel off `getTraceparent` is always `undefined`; **and** (2) the target host is in
`EAGENT_OTEL_PROPAGATE_HOSTS` — **default empty ⇒ `isTrustedHost` always false**. So with no allowlist
(the default, CLI included) **nothing is ever injected** — web/mcp headers are byte-identical. Keying by
`call.id` (not the agent) is race-safe under parallel dispatch (`agent.ts` runs tool calls concurrently
but each has a unique `toolCallId`). The traceparent carries only random ids (no secret).

## Non-goals / documented residual

- **web redirect-follow (low severity):** `web.ts` fetches with `redirect: "follow"` (`web.ts:195`); an
  allowlisted host that 3xx-redirects to a non-allowlisted host re-sends the `traceparent` header. The
  header holds only random trace/span ids (no secret, meaningless without the collector), so this is a
  documented low-severity residual, not a leak of sensitive data. (mcp POSTs to a fixed operator URL, no
  redirect.)
- No change to span/metric emission, no new capability, no new dependency, **no kernel change** (rides
  the existing `tool_start`/`tool_end` events + `ctx.toolCallId`).

## Acceptance

- `node --import tsx --test test/otel-context.test.ts` — unit: `traceparent` format, `isTrustedHost`
  (exact, suffix, malformed→false, empty allowlist→false), set/get/clear channel.
- `test/web.test.ts` — stub `globalThis.fetch`; otel on + host allowlisted ⇒ outbound `traceparent`
  present + well-formed; otel on + host NOT allowlisted ⇒ absent; otel off ⇒ absent; no allowlist ⇒
  absent (byte-identical).
- `test/mcp*.test.ts` — HttpTransport request with an allowlisted `#url` + a published traceparent ⇒
  the POST carries `traceparent`; not allowlisted / otel off ⇒ absent.
- `test/otel-exporter.test.ts` — a tool call publishes then clears the map entry (set at tool_start,
  gone after tool_end).
- `npm test` / `typecheck` / `eval` green · `src/kernel/` untouched · no new dependency.

## Closure

**Closed** 2026-07-01. Shipped: a pure `lib/otel-context.ts` (traceparent format, `isTrustedHost`
allowlist gate, the callId→traceparent channel); otel-exporter publishes each tool-call span's
traceparent at `tool_start` and clears at `tool_end`; web (fetch tool) and mcp (HttpTransport, via an
optional `callId?` threaded through `Transport.request`) inject the `traceparent` header — only when
otel is on AND the host is in `EAGENT_OTEL_PROPAGATE_HOSTS` (default empty ⇒ inert, byte-identical).
Full-tier adversarial fresh review **pass** (zero severe): the reviewer independently ran mutation
tests (over-inject AND under-inject both → RED, genuine two-sided discriminators), proved both default
paths byte-identical via two independent either-sufficient gates, confirmed no secret rides the
injection (traceparent = random ids), no `isTrustedHost` over-match, sound mcp threading (Stdio
unaffected), and race-safe always-cleared map. Post-review hardening: `isTrustedHost` lowercases
allowlist entries itself (defense-in-depth for direct callers). Gates: otel-context 9 + web + mcp + otel
publish all pass; `npm test` 1172 pass / 0 fail / 1 skip; typecheck 0; eval 5/5; `src/kernel/` untouched;
no new dependency. Documented low-severity residual: web `redirect: "follow"` may re-send the random-id
traceparent across a cross-host redirect (no secret).
