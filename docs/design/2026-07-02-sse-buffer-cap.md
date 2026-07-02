# Light-Mode brief — parseSSE incomplete-event buffer cap (SRV-4)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-02

**Slug:** `2026-07-02-sse-buffer-cap` · **Tier:** Light (`src/providers/http.ts` + `test/http.test.ts`;
additive OOM-safety bound, no breaking change, no new contract). The one constant is an **OOM-safety
cap**, not a behavior-tuning threshold — its exact value never changes correct behavior (any generous
value works; it only bounds a pathological unbounded stream), and it's env-overridable. Source:
`docs/DEFERRED-FOLLOWUPS.md` SRV-4. Branch: `chore/audit-gaps-3`. *(Fresh reviewer: re-run the Full-Mode
gate and escalate to Full if you judge the cap a load-bearing decision.)*

## What / why

`parseSSE` (`src/providers/http.ts:22`, the **shared** SSE reader for all three fetch providers —
`openai`/`anthropic`/`gemini`) accumulates `buffer += decoder.decode(value)` and only slices on a
`\r?\n\r?\n` event boundary. A stream that sends bytes with **no event terminator** grows `buffer`
unbounded → OOM (a compromised/buggy provider endpoint DoSes the host). SRV-4.

**Change:** after processing all complete events in a `read()` chunk, if the remaining (incomplete-event)
`buffer` exceeds a cap, **throw** — surfacing as a provider stream error (the agent's existing
provider-error path handles it), instead of growing without bound. Cap = `maxSseEventBytes()` reading
`EAGENT_MAX_SSE_EVENT_BYTES` (positive integer; **default 16 MiB** — far above any legitimate single SSE
event: LLM events are small deltas, and even a whole non-streamed message is well under this, so a
legitimate stream never hits it while a no-terminator stream is bounded).

## Explicit non-goals (Simplicity First)

- **Scope:** only `parseSSE` (the shared provider-SSE reader — the broadest single fix). The MCP transport
  reads (`HttpTransport` `res.text()` `mcp.ts:354`, `StdioTransport` readline `mcp.ts:189`) are a
  **documented follow-up** (SRV-4b): they need a `readCapped` relocation / custom readline byte-counting,
  a distinct change; MCP is separately capability-gated.
- The cap bounds a *single incomplete event*, not total stream bytes (parseSSE must keep streaming). No
  change to the SSE parse semantics, the retry layer (`fetchWithRetry`), or the providers.
- No new capability, dependency, or kernel change.

## Any >1-option decision surfaced

- **Cap the incomplete-event buffer vs the whole stream** — chosen: cap the *incomplete-event* buffer
  (the unbounded-growth surface), because parseSSE is a streaming reader (a whole-stream cap would break
  legitimately long streams). The value is an OOM-safety bound (generous default, env-overridable), not a
  behavior threshold.

## Measurable acceptance command

- `node --import tsx --test test/http.test.ts` exit 0 — a NEW test: with a small `EAGENT_MAX_SSE_EVENT_
  BYTES` (e.g. 64, restored in `finally`), feeding `parseSSE` a `ReadableStream` whose bytes contain **no
  `\n\n`** and exceed the cap **throws** (the OOM is bounded); a control — a normal event stream
  (terminated events, each under the cap) yields its events unchanged, and a large-but-terminated stream
  (many small events) does NOT throw (only the *incomplete* buffer is capped). Reverting the cap makes
  the no-terminator case accumulate without throwing (the discriminator — assert via the cap firing).
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-02. `parseSSE` now caps a single incomplete-event buffer at `maxSseEventBytes()`
(`EAGENT_MAX_SSE_EVENT_BYTES`, default 16 MiB) and throws on exceed — so a no-terminator stream from any
of the three fetch providers can't grow the buffer without bound (OOM/DoS). Only the *incomplete* buffer
is bounded (throughput is unaffected); the throw surfaces as a provider stream error. Light-Mode fresh
review **pass** (Full-gate verdict: Light correct — a fail-safe OOM bound, not a behavior threshold, 16
MiB is 30-160× any legit event; correctness/parse/discriminator all confirmed). Gates: http 9 pass,
`npm test` 1192 pass / 0 fail / 1 skip, typecheck 0, eval 5/5, `src/kernel/` untouched, no new
dependency. **Deferred (SRV-4b):** the MCP transport reads (`HttpTransport` `res.text()`,
`StdioTransport` readline) — a distinct mechanism (a `readCapped` relocation / custom readline
byte-counting); MCP is separately capability-gated.
