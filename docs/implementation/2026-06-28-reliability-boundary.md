# Implementation — Reliability boundary (`onProviderError` + StopReason)

**Slug:** `2026-06-28-reliability-boundary` (matches design) · **Design:**
[`design/2026-06-28-reliability-boundary.md`](../design/2026-06-28-reliability-boundary.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Run from repo root.
Single-file accept: `node --import tsx --test "<file>"`.

## 1. Task Index (design ↔ deliverable map)

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D3 StopReason enrichment (refusal/content_filter) | design §2 D3, KDD-5, AC-7 |
| 2 | D1 onProviderError seam + D2 streamTurn wrap | design §2 D1/D2, KDD-1/2/3, AC-3/4/5/6, AC-9 |
| 3 | D4 minimal reliability extension | design §2 D4, KDD-4/6, §5 classifier, AC-8 |

Three Phases, each independently committable and `npm test`-green: P1 is a provider-side mapping change
(no kernel surface); P2 adds the kernel seam (default-inert, byte-identical); P3 adds the opt-in
extension that rides the seam. P2 depends only on nothing new; P3 depends on P2.

## 2. Phase Breakdown

### Phase 1 — StopReason enrichment (`refusal` / `content_filter`)

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-4 merged). Baseline `npm test` green.
- **Design refs:** §2 D3, KDD-5, AC-7.
- **Files:** `src/kernel/types.ts` (StopReason union), `src/providers/anthropic.ts`,
  `src/providers/openai.ts`, `src/providers/gemini.ts`, `test/anthropic.test.ts`, `test/openai.test.ts`,
  `test/gemini.test.ts`.
- **Task list (TDD order):**
  1. **(test)** AC-7 per provider — drive each provider's `stream()` with a crafted SSE/JSON body whose
     terminal carries the native policy reason, asserting `done.stopReason`: Anthropic `message_delta`
     with `stop_reason:"refusal"` → `"refusal"`; OpenAI a chunk with `finish_reason:"content_filter"` →
     `"content_filter"`; Gemini a candidate with `finishReason:"SAFETY"` → `"content_filter"` and
     `"RECITATION"` → `"content_filter"`. Also assert the pre-existing mappings still hold (Anthropic
     `end_turn`→`end_turn`, `tool_use`→`tool_use`, `max_tokens`→`max_tokens`). Use the existing
     provider-test harness pattern (each `*.test.ts` already feeds an SSE/JSON body to `stream()`).
  2. **(impl)** `src/kernel/types.ts`: extend `StopReason` to
     `"end_turn" | "tool_use" | "max_tokens" | "stop" | "error" | "refusal" | "content_filter"`.
  3. **(impl)** `src/providers/anthropic.ts` `mapStopReason`: add `case "refusal": return "refusal";`.
     `src/providers/openai.ts` `mapFinishReason`: add `case "content_filter": return "content_filter";`.
     `src/providers/gemini.ts` `mapFinishReason`: add `case "SAFETY": case "RECITATION": return
     "content_filter";`. Leave the `default → "stop"` arm for genuinely-unknown reasons.
- **Per-task accept commands:**
  - `node --import tsx --test "test/anthropic.test.ts" "test/openai.test.ts" "test/gemini.test.ts"`
  - `node --import tsx --test "test/kernel-surface.test.ts"`
  - `npm run typecheck`
- **Exit condition:** the new mapping tests pass; existing provider tests green; `kernel-surface` green
  (StopReason is a type-only export, no `EXPECTED_EXPORTS` change); `npm test` green.

### Phase 2 — `onProviderError` kernel seam

- **Entry condition:** Phase 1 merged; `npm test` green.
- **Design refs:** §2 D1/D2, KDD-1 (pre-commit/committed), KDD-2 (value/context), KDD-3 (default
  fail=true), R2 (hard bound), R3 (double-emit); AC-3/4/5/6, AC-9.
- **Files:** `src/kernel/events.ts` (onProviderError filter), `src/kernel/agent.ts` (streamTurn wrap),
  `test/agent.test.ts`.
- **Task list (TDD order):**
  1. **(test)** AC-3 default byte-identity: a `MockProvider` (or a small test provider) whose `stream()`
     throws **before** yielding any event, with NO `onProviderError` handler, makes `run()` end with
     `reason:"error"` and rethrow — identical to today.
  2. **(test)** AC-4 retry: a test provider that throws on attempt 1 (pre-commit) then succeeds on
     attempt 2; an `onProviderError` handler returning `{retry:true, fail:false}`; assert `run()`
     completes successfully and the handler saw `attempt` increment (1 then would-be-2). 
  3. **(test)** AC-5 downshift: an `onProviderError` handler returning `{retry:true, downshiftModel:"small",
     fail:false}`; assert the retried stream's request carries `model:"small"` (capture via the mock
     function responder).
  4. **(test)** AC-6 post-commit safety: a test provider that yields one `text_delta` then throws; a
     `{retry:true}` handler; assert `run()` ends with error and exactly ONE `text_delta` reached a
     `text_delta` observer (no double-emit). Also assert the kernel hard-bound stops a handler that
     always returns `{retry:true}` (R2) — finite attempts, then fail.
  5. **(impl)** `src/kernel/events.ts`: add to `KernelFilters`:
     `onProviderError: { value: { retry: boolean; downshiftModel?: string; fail: boolean }; context: {
     error: unknown; attempt: number } }`.
  6. **(impl)** `src/kernel/agent.ts` `streamTurn`: wrap **both the request assembly and** the `for await`
     stream consumption in a retry loop (each attempt rebuilds `finalReq` via the full assembly, re-running
     `transformContext`/`transformRequest`). Track `committed` set true on the FIRST yielded event of any type. On a thrown error: if
     `committed` OR `attempt >= MAX_PROVIDER_RETRIES` (a concrete kernel const = 6) → rethrow. Else apply
     `onProviderError` with value `{retry:false, fail:true}` (the default), context `{error, attempt}`
     (attempt starts at 1 for the first failure); if the result is `{retry:true}` (and not `fail`),
     increment `attempt`, and if `downshiftModel` is set assign it to a local `model` variable used by the
     **rebuilt** request assembly — thread it through BOTH the `transformContext` context `model`
     (`agent.ts:322`) and `req.model` (`agent.ts:329`, which flows into `finalReq.model`) so handlers and
     the provider both see the downshift — then loop; otherwise rethrow. With no handler the applied value is unchanged
     (`{retry:false,fail:true}`) → rethrow → byte-identical. Keep the existing `!message` throw and usage
     accumulation AFTER a successful stream (usage only added on `done`, so a pre-commit failure adds none).
- **Per-task accept commands:**
  - `node --import tsx --test "test/agent.test.ts"`
  - `node --import tsx --test "test/kernel-surface.test.ts"`
  - `npm run typecheck`
- **Exit condition:** AC-3/4/5/6 pass; default byte-identity holds; `kernel-surface` green (`< 2,200`
  lines; onProviderError is a type-only KernelFilters key, no export change); `npm test` green.

### Phase 3 — minimal `reliability` extension

- **Entry condition:** Phase 2 merged; `npm test` green.
- **Design refs:** §2 D4, KDD-4/6, §5 (conservative-retry classifier); AC-8.
- **Files:** `src/extensions/reliability.ts` (new), `src/host.ts` (register in `BUILTIN_EXTENSIONS`),
  `test/reliability.test.ts` (new). README extension table is reconciled at F.
- **Task list (TDD order):**
  1. **(test)** AC-8: with `reliability` loaded but **off** (default), a pre-commit-throwing provider
     ends the run (inert). With it **on** (`/reliability on` or store flag), a provider that throws a
     recognized pre-first-event error N times then succeeds completes the run within the bound, with the
     backoff delay injected to 0 (no real sleep). Assert it never changes `agent.providerName` (no
     cross-provider failover). Assert (conservative policy) it does NOT retry an error it does not
     positively recognize as retryable (default-deny).
  2. **(impl)** `src/extensions/reliability.ts`: default-export `activate(e)`; gate on
     `EAGENT_RELIABILITY !== "off"` + a store `enabled` flag (off by default); register `onProviderError`
     returning `{retry:true, downshiftModel?, fail:false}` for a **positively-recognized** retryable
     pre-first-event error up to a configured bound with exponential backoff+jitter via an injectable
     `sleep` (0 in tests); `{retry:false, fail:true}` otherwise. **Concrete recognized-signal allowlist
     (default):** transient connection/stream errors by `error.code` ∈ {`ECONNRESET`,`ETIMEDOUT`,
     `ECONNREFUSED`,`EPIPE`} OR `error.message` matching `/socket hang up|network|timed ?out|stream
     (closed|aborted)/i` **AND NOT** matching the http.ts-exhausted shape `/ API error \d+:/` (so a 5xx
     whose body text happens to contain "timed out" is excluded — `http.ts` already owns and exhausted it;
     this prevents stacked backoff). A bare untyped `Error` without a transient `.code` and without a
     transient message therefore default-denies. Allowlist is store-overridable.
     A `/reliability [on|off|status]` command. `EAGENT_RELIABILITY=off`
     kill switch. Declares no capability (it routes errors, touches no privileged authority).
  3. **(impl)** `src/host.ts`: append `["reliability", reliability]` to `BUILTIN_EXTENSIONS` (import it).
  4. **(verify)** `node --import tsx --test "test/reliability.test.ts" "test/host.test.ts"` — the
     canonical-set CI gate (from Wave 1) now expects `BUILTIN_EXTENSIONS.length` to include reliability;
     it passes because the count is derived from the list.
- **Per-task accept commands:**
  - `node --import tsx --test "test/reliability.test.ts" "test/host.test.ts"`
  - `npm run typecheck`
- **Exit condition:** reliability tests pass (off-by-default inert; on retries within bound; never
  switches provider; conservative default-deny); host canonical-set test green; `npm test` green.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` specifiers; strict TS
  (`noUncheckedIndexedAccess`); zero deps but jiti; offline tests via `node:test`/`tsx`. New extension
  follows CLAUDE.md "Adding an extension" (capability-gate if privileged — here none; `EAGENT_<NAME>=off`
  kill switch; append to `BUILTIN_EXTENSIONS`; offline test). `types.ts`/`events.ts`/`agent.ts` are kernel
  (load-bearing); the CLAUDE.md/README/EXTENSIONS filter-hook count (now five) + StopReason references are
  reconciled at F.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phaseN):`; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI attribution.

## 4. Data and Fixture Dependencies

Phase 1 reuses each provider test's existing SSE/JSON-body→`stream()` harness. Phase 2/3 use `MockProvider`
(function responder to script throw-then-succeed and to capture the downshifted `model`) and small inline
test providers whose `stream()` throws on cue. The reliability extension's backoff `sleep` is injected to
0 in tests. No network, no new external fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at the end of every Phase.
- Phase 1: existing provider tests are the net (the new cases are additive; the `default→"stop"` arm is
  unchanged for unknown reasons). `kernel-surface` green (type-only StopReason change).
- Phase 2: AC-3 default byte-identity is the core guard (the seam is inert with no handler). `kernel-surface`
  green; `< 2,200` lines. Wave-3 `childScope` does not forward provider errors (they aren't events), so no
  interaction.
- Phase 3: the Wave-1 `BUILTIN_EXTENSIONS` canonical-set host test (count == list length, no dup
  tool/command names) is the net for the new extension; `fallback-routing`/`circuit-breaker`/`recovery`
  tests stay green (reliability is a different axis, off by default).

## L2 Review Log

- **Round 1** — zero severe + 1 general (Phase-3 classifier predicate under-specified) + clarifications.
  Concrete recognized-signal allowlist added; downshift threaded through both model sites; MAX=6 pinned.
  (The round-1 "CLAUDE.md says three" note was a stale-snapshot misread — on-disk says four.)
- **Round 2** — zero severe + 1 general (G1: regex arm could match a 5xx "timed out" body, stacking
  backoff). Fixed: regex arm excludes the http.ts-shaped `/ API error \d+:/` message.
- **Round 3** — **zero severe, zero general** (exhaustive re-grounding; both http.ts exhaustion paths
  confirmed excluded).
- **Round 4 (corroborating)** — **zero severe, zero general.** Cap-convergence
  ([[three-loop-cap-convergence-policy]]) — two-generation satisfied. **L2 closed.**
