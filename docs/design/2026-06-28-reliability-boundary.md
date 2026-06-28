# Design — Reliability boundary (`onProviderError` seam + StopReason enrichment)

```
Status: closed
Closing-commit: b8dd9c3
Closed-on: 2026-06-28
Deferred: deliverable — rewrite fallback-routing onto onProviderError (RW5-1) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-28-reliability-boundary` · **Wave:** 5 · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P1.4

## 1. Background and Purpose

The oracle boundary is reliability-brittle in one specific way and policy-blind in another:

- **No in-loop error seam.** `streamTurn` consumes `provider.stream(finalReq)` in a bare `for await`
  (`agent.ts:365-375`); a throw propagates to `run()`'s `catch` (`agent.ts:300-303`), which sets
  `reason="error"` and **rethrows**, ending the session. There is no hook to retry or downshift in place.
  Existing machinery covers *parts* of this but leaves a gap: `http.ts`'s `fetchWithRetry` retries
  429/5xx at the **fetch** level (before streaming); `fallback-routing` fails over to a **different
  provider** via a composite `Provider` (pre-first-event only) — and its own docstring states the gap
  plainly: *"None of the three filter hooks wrap the provider call and the `error` event is observe-only,
  so there is no in-loop seam to retry"* (`fallback-routing.ts:9-10`). What remains uncovered: a clean,
  general in-loop seam usable by any extension, **same-provider** retry, and **model downshift** (switch
  to a smaller/cheaper model on overload — distinct from switching provider).
- **StopReason is policy-blind.** `StopReason` is `"end_turn" | "tool_use" | "max_tokens" | "stop" |
  "error"` (`types.ts:170`). All three providers collapse a **policy refusal / safety / content-filter**
  termination into the generic `"stop"`: Anthropic's `default → "stop"` (`anthropic.ts:300-302`),
  OpenAI's `content_filter → "stop"` (`openai.ts:249-250` default arm), Gemini's `SAFETY`/`RECITATION →
  "stop"` (`gemini.ts:214-215` default arm). So the loop and extensions cannot distinguish "the model declined for policy" from
  "the model finished normally."

This wave adds the **`onProviderError`** filter seam (the in-loop retry/downshift point `fallback-routing`
laments), enriches `StopReason` with `"refusal"` and `"content_filter"`, and ships a **minimal reliability
extension** that rides the seam for same-provider bounded backoff-retry + optional model-downshift —
explicitly **complementary** to `fallback-routing` (cross-provider) and `circuit-breaker` (tool loops).

## 2. Deliverables

- [ ] **D1** `onProviderError` filter point (`events.ts`): value `{ retry: boolean; downshiftModel?:
  string; fail: boolean }`, context `{ error: unknown; attempt: number }`. Applied in `streamTurn` when
  the provider stream throws **before any event is emitted** (pre-commit, KDD-1). Default (no handler) →
  `fail: true` → rethrow → **byte-identical** to today.
- [ ] **D2** `streamTurn` wraps the stream consumption: track a `committed` flag set on the provider's
  **first yielded event of ANY type** (mirroring `fallback-routing`'s proven invariant
  `fallback-routing.ts:213-215`, rather than enumerating `{text_delta,reasoning_delta,done}` — which
  would silently exclude the `tool_call` `StreamEvent` variant and rot if the loop ever changes); on a
  **pre-commit** throw, apply `onProviderError`
  with an incrementing `attempt`; if the result has `retry:true` (optionally with `downshiftModel`),
  re-stream (rebuilding `finalReq`, applying `downshiftModel` to `model`) up to a safety bound; otherwise
  rethrow. A **post-commit** throw always rethrows (retry would double-emit — the `committed` invariant,
  mirroring `fallback-routing`).
- [ ] **D3** `StopReason` gains `"refusal"` and `"content_filter"`; the three providers map their native
  policy terminations: Anthropic `refusal → "refusal"`; OpenAI `content_filter → "content_filter"`;
  Gemini `SAFETY`/`RECITATION → "content_filter"`. (Additive union members; the loop treats them like
  any non-tool stop — it ends the turn.)
- [ ] **D4** A minimal **`reliability`** extension (off by default, `EAGENT_RELIABILITY=off` + a store
  flag / `/reliability on`): registers `onProviderError` to retry the **same** provider on a pre-commit
  error with bounded attempts + exponential backoff-with-jitter (delay injectable → 0 in tests), and an
  optional configured `downshiftModel`. **Classifier scope:** it targets the errors `http.ts` does NOT
  own — post-connect/pre-first-event stream failures, non-http providers (`mock`/`cassette`/custom), and
  the downshift case — and does **not** re-retry the 429/5xx/network errors `fetchWithRetry`
  (`http.ts:65-90`) already retries-with-backoff and exhausted, so the two layers don't stack backoff for
  no gain. Documented as complementary to `fallback-routing` (cross-provider) and `circuit-breaker` (tool
  repetition); it never switches provider.
- [ ] **D5** Tests for each; `kernel-surface.test.ts` (StopReason/onProviderError are type-only → no
  export pin change; `< 2,200` lines).

## 3. Scope Boundary (NOT in scope)

- **No** rewrite of `fallback-routing` onto `onProviderError` (it keeps its composite-`Provider`
  approach; migrating it is a separate follow-up). The new `reliability` extension is **same-provider
  only** and does **not** do cross-provider failover (KDD-4).
- **No** post-commit retry (after the first streamed event) — unsafe (double-emit), always fails (KDD-1).
- **No** change to `http.ts` `fetchWithRetry` (fetch-level 429/5xx retry stays; `onProviderError` is the
  layer **above** it, for errors that escape it or are non-http).
- **No** loop-level branching ON the new `refusal`/`content_filter` StopReasons (an extension may, later);
  this wave only makes the distinction *expressible* (the loop ends the turn as for any non-tool stop).
- **No** new sampling/cache request fields (separate concern).

## 4. Key Design Decisions

### KDD-1 — `onProviderError` fires only pre-commit
*Problem:* when is it safe to retry a failed stream? *Options:* (a) fire on any stream throw; (b) fire
only when **no event has been emitted yet**. *Choice:* **(b)** — the kernel contract is "a stream ending
in exactly one `done`," and the loop renders `text_delta`s as they arrive; retrying after any event
double-emits text and yields two `done`s. This is the identical `committed` invariant `fallback-routing`
enforces (`fallback-routing.ts:22-29`). A post-commit throw always rethrows. *Rejected:* (a) corrupts the
stream contract.

### KDD-2 — Seam value/context shape
*Problem:* what does a handler decide and see? *Options:* (a) a boolean "retry?"; (b) `{ retry,
downshiftModel?, fail }` value + `{ error, attempt }` context. *Choice:* **(b)** — `retry` requests a
re-stream, `downshiftModel` optionally swaps the model for the retry (the model-downshift use case),
`fail` (default `true`) is the explicit terminal; `attempt` lets a policy bound retries and scale
backoff, `error` lets it classify (retryable vs fatal). *Rejected:* (a) can't express downshift or bound
attempts.

### KDD-3 — Default `fail: true` (byte-identical)
*Choice:* with no `onProviderError` handler, the applied value is `{ retry:false, fail:true }` and the
kernel rethrows — exactly today's behavior. The seam is inert until an extension opts in. *Rejected:* a
default retry would change behavior and could mask real failures.

### KDD-4 — Relationship to `fallback-routing` / `circuit-breaker` (the key Simplicity decision)
*Problem:* `fallback-routing` already fails over providers; does `onProviderError` + a `reliability`
extension duplicate it? *Options:* (a) don't add the seam (rely on the composite-provider trick);
(b) add the seam + a cross-provider reliability extension (duplicates `fallback-routing`); (c) add the
seam (the general in-loop point) + a **same-provider-only** reliability extension (retry + model
downshift), leaving `fallback-routing` as the cross-provider layer. *Choice:* **(c)**. The seam's
justification is **not** that a composite `Provider` *can't* retry or rewrite the model — it can
(`fallback-routing.ts:210` already does `{ ...req, model: entry.model }` per chain entry). It is
(i) **composability**: `onProviderError` handlers compose through `hooks.apply`, whereas two
composite-provider extensions would fight over the single mutable `Agent.providerName` field; and
(ii) it is the **principled, general in-loop error point** `fallback-routing`'s own docstring documents
as missing (`fallback-routing.ts:8-10`). The new extension occupies a *different axis* (same provider —
retry/downshift) from `fallback-routing` (different provider) and `circuit-breaker` (tool-call loops),
so no duplication. *Rejected:* (a) leaves the seam gap (no composable in-loop point); (b) builds a second
cross-provider failover (real duplication of `fallback-routing`).

### KDD-5 — StopReason additions are `refusal` + `content_filter`
*Problem:* which policy terminations to surface? *Options:* (a) one generic `"safety"`; (b) `"refusal"`
(model declined) + `"content_filter"` (provider safety/content system blocked). *Choice:* **(b)** — they
are distinct (a model *refusal* vs a *content-filter* block) and map cleanly to provider vocabularies
(Anthropic `refusal`; OpenAI `content_filter`; Gemini `SAFETY`/`RECITATION` → `content_filter`). Two
precise members beat one ambiguous one. *Rejected:* (a) loses the refusal-vs-filter distinction.

### KDD-6 — Ship a minimal reliability extension (vs defer)
*Problem:* given `http.ts` retry + `fallback-routing` cover much of reliability, is a new extension worth
it? *Options:* (a) ship the seam + StopReason only, defer any extension; (b) ship a **minimal**
same-provider retry+downshift extension, off by default. *Choice:* **(b)** — it delivers the genuinely
new capability (same-provider bounded retry without the composite-provider setup, + model downshift) and
demonstrates the seam, at small cost, off by default. If L1 review judges it redundant with `http.ts`
retry, fall back to (a). *Rejected:* (a) ships a seam with no in-tree consumer (less validated).

## 5. Dependencies and Assumptions

Builds on Wave 2 (`transformRequest` lives in the same `streamTurn`; the `onProviderError` retry
re-streams a freshly-shaped request). Independent of Waves 3/4. Assumes the retry re-runs the full
request assembly (so `transformContext`/`transformRequest`/`downshiftModel` apply to the retried
attempt). Assumes the reliability extension's backoff delay is injectable (a `sleep(ms)` indirection set
to 0 in tests — no real sleeping in the offline suite). Assumes provider native reason strings: Anthropic
`refusal` (`anthropic.ts` `mapStopReason`), OpenAI `content_filter` (`openai.ts` `mapFinishReason`),
Gemini `SAFETY`/`RECITATION` (`gemini.ts` `mapFinishReason`) — verified against current parsing in L2.
**L2 detail (classifier mechanism):** `fetchWithRetry` throws an untyped `Error` on exhaustion
(`http.ts:86`), so the reliability extension's "don't re-retry http.ts-owned 429/5xx" rule is realized in
L2 by a **conservative retry policy** (only retry errors it positively recognizes as pre-first-event/
non-http, default-deny otherwise) rather than by string-matching the http.ts message — pinned in the L2 doc.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P1.4. Builds on Wave 2. Related/complementary (⚠ not conflicts):
`fallback-routing` (`2026-06-25`-era; cross-provider composite — this wave adds the in-loop seam it
documents as missing, but does **not** rewrite it), `circuit-breaker` (`2026-06-22-circuit-breaker.md`;
tool-call repetition), `recovery` (`2026-06-21-recovery-hooks.md`; failed-tool nudges),
`2026-06-20-reasoning-thinking-support.md` (StopReason/thinking). CLAUDE.md filter-hook prose (now
"four filter hooks") gains a **fifth** point `onProviderError`; the README/EXTENSIONS filter-hook
enumerations + `StopReason` references are reconciled at F (load-bearing-doc surfaces).

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0.  **AC-2** `npm test` exits 0 (existing + new).
- **AC-3** Default byte-identity: with **no** `onProviderError` handler, a provider whose stream throws
  pre-first-event makes `run()` end with `reason:"error"` and rethrow — identical to today (a test
  provider that throws; assert the same outcome as a baseline without the seam wrapper).
- **AC-4** Retry: a test provider that throws on attempt 1 (pre-commit) then succeeds on attempt 2, with
  an `onProviderError` handler returning `{retry:true, fail:false}`, makes `run()` **complete
  successfully**; the handler saw `attempt` incrementing.
- **AC-5** Downshift: an `onProviderError` handler returning `{retry:true, downshiftModel:"small",
  fail:false}` causes the retried stream's request to carry `model:"small"` (captured via the mock
  function responder).
- **AC-6** Post-commit safety: a provider that emits one `text_delta` then throws is **not** retried even
  with a `{retry:true}` handler — `run()` ends with error (no double-emit; assert a single `text_delta`
  reached observers).
- **AC-7** StopReason mapping (the mappers are module-private — test by **driving each provider's
  `stream()` with a crafted SSE/JSON body** and asserting `done.stopReason`, not by exporting the
  mappers): Anthropic `refusal → "refusal"`; OpenAI `content_filter → "content_filter"`; Gemini `SAFETY`
  and `RECITATION → "content_filter"`; and pre-existing mappings (end_turn/tool_use/max_tokens) unchanged.
- **AC-8** `reliability` extension: off by default (a throwing pre-commit provider ends the run when the
  extension is loaded but not enabled — proving inert); enabled, it retries a pre-commit-throwing
  provider up to its bound (delay injected to 0) and the run completes; it never switches provider.
- **AC-9** `kernel-surface.test.ts` passes: `StopReason`/`onProviderError` are type-only (no
  `EXPECTED_EXPORTS` change); `src/kernel/` `< 2,200` lines.

*Quality budget:* the seam adds a try/catch + a bounded retry loop around an already-async provider call;
negligible. Excluded from a numeric budget.

## 8. Risks and Rollback

- **R1 — Duplication with `fallback-routing`/`http.ts` retry (the KDD-4 concern).** *Mitigation:* the
  `reliability` extension is same-provider + downshift only (a different axis), off by default; L1 review
  pressure-tests this, and KDD-6 option (a) (seam + StopReason only) is the fallback if judged redundant.
  *Rollback:* drop the extension, keep the seam + StopReason.
- **R2 — Unbounded retry loop.** *Mitigation:* the kernel enforces a hard safety bound on
  `onProviderError` retries regardless of handler (e.g. ≤ a small constant) so a buggy handler returning
  perpetual `retry:true` cannot spin forever; AC-4/AC-8 exercise the bound. *Rollback:* n/a.
- **R3 — Post-commit double-emit.** *Mitigation:* KDD-1 `committed` flag; AC-6 pins it. *Rollback:* n/a.
- **R4 — New StopReason members break an exhaustive `switch`.** *Mitigation:* grep consumers of
  `StopReason`; the loop and renderers treat unknown stops as "end the turn"; additive union members are
  handled by the `default`/non-tool path. AC-2 is the net. *Rollback:* drop the members.
- **R5 — CLAUDE.md/README/EXTENSIONS filter-hook count + StopReason docs stale.** *Mitigation:* reconcile
  at F step 8 (now five filter hooks). *Rollback:* n/a.
- **R6 — Kernel line ceiling** (≈ 2,087 now; +≈ 30-50 for the seam + StopReason). *Mitigation:* keep the
  retry loop terse; AC-9 enforces `< 2,200`. *Rollback:* n/a.

The kernel change is one filter point + a bounded retry wrapper in `streamTurn` + two StopReason members;
reverting the wrapper restores prior behavior, and the extension is independently revertible.

## L1 Review Log

- **Round 1** — zero severe + 2 general (KDD-4 overstated "composite can't downshift" — re-grounded on
  hook-bus composability + the principled in-loop point; `committed` should set on first event of ANY type
  to mirror `fallback-routing`) + clarifications (cite fixes; classifier excludes http.ts-owned 429/5xx;
  AC-7 drives `stream()` not exported mappers). All applied. Native reason strings verified accurate.
- **Round 2** — **zero severe, zero general** (one L2-deferred clarification: conservative-retry classifier
  mechanism). Folded into §5.
- **Round 3 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
