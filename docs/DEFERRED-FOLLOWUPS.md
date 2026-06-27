# Deferred follow-ups register

A single ledger of sub-features that were **deliberately deferred** by an
extension's design (each named in that design's Scope Boundary + `Deferred:`
closure line), plus the rationale for keeping them deferred. This is the
"what we chose not to build, and why" record — none of these are exploitable
gaps or half-finished surfaces; each is a separate, larger design that does not
fold into the shipped slice.

Verdicts below are from a dedicated assessment pass (build-vs-defer, weighing
minimalist fit / value / effort / risk).

## Kept deferred (correctly cut — Simplicity First)

| # | Sub-feature | Home design doc | Effort · Risk | Why it stays deferred |
|---|---|---|---|---|
| 1 | risk-guard `commandArgKey` / per-value rot13 decode | `docs/design/2026-06-22-decode-normalize.md` (§3, §8 AC-11) | M · M | The rot13-in-JSON-arg asymmetry is **documented**, not hidden: embedded base64/hex/idiom payloads inside the args blob are already caught, and bash-policy covers rot13 via clean sub-command extraction. Per-argument extraction needs a new call-shape mapping + test surface for a single edge case. |
| 2 | secret-guard env-ref **rewriting** (`$NAME` / asterisks) | `docs/design/2026-06-22-secret-guard.md` (§3, D3, §8) | M · H | Silent mutation of model output is a correctness minefield — rewriting to `$OPENAI_API_KEY` only works if that env var exists; a wrong guess silently breaks the call. detect-+-hold (ask/block) is the safe v1 boundary; rewrite is high blast-radius. |
| 3 | routing **N-tier** policy + **cost-feedback** routing | `docs/design/2026-06-22-routing.md` (§3) | M · M | The design caps at two tiers on purpose; N-tier generality and cost-aware routing are speculative and each need their own design once requirements crystallize. (NOTE: the assessment floated a "tier-model **registry validation**" quick win, but on inspection it is **not applicable** — EAgent has no model-id registry. `ProviderRegistry` keys by provider *name* (`registry.ts:74`) and model ids are free-form strings passed straight to the provider API, so there is nothing to validate a model id against. `routing.ts:278-287` already does the maximal possible check: the tier-map entry must be a usable non-empty string, else it falls back to the captured baseline with a warning — never a throw, never an empty assignment. Nothing to build here.) |
| 4 | mcp-resources **subscriptions** + change-notifications + parameterized **templates** | `docs/design/2026-06-22-mcp-resources.md` (§3) | L–H · H | Subscriptions need server→client push + cache invalidation (new transport plumbing + state); templates are speculative (a model can read concrete URIs today). The request/response v1 is complete for the stated problem. |
| 5 | evals **statistical** pass@k CIs + eval-awareness gap + probe rotation | `docs/design/2026-06-22-evals.md` (§3, D5) | L–H · M | The design is explicitly built **against** scope-ballooning into a full eval framework. The thin slice (assertions + scorecard + one judge) is complete and independently valuable; statistical machinery is a natural follow-up once the foundation is proven. |
| 6 | skills-hardening `.skill` **packaging** / signature verification / install-flow vetting | `docs/design/2026-06-22-skills-hardening.md` (§3) | L–M · M | In-place hardening (body scan, frontmatter lint, tool scoping, trigger gating) is done and addresses the core threats. Packaging + signatures is a **distribution** layer (how skills arrive), separate from hardening skills already present, and brings key-management / release-pipeline concerns. |

After the assessment, the three deferred sub-features with real functional value
were BUILT (each through a build + independent fresh-review gate); the six above
were confirmed as correct, intentional cuts and nothing in this round needed to
touch them.

## Delivered this round (previously-deferred functional gaps, now closed)

| Sub-feature | Extension | What landed |
|---|---|---|
| Provider decode-time **forcing** | output-contract | `ToolChoice` on `CompletionRequest` + `Agent.forceTool`; per-provider native mapping with graceful degrade; forces the `respond` tool only on the corrective/reask turn (multi-step work stays free). Best-effort → near-guaranteed. |
| Server-side **ask/resume** channel | ask | `action_required` NDJSON event + `POST /answer` with bounded-timeout/disconnect fallback, so `ask_user_question` reaches a human over HTTP instead of always falling back. (Review caught + fixed a fail-open `confirm` regression.) |
| Session-start **auto-resume** injection | handoff | opt-in, relevance- + freshness-gated `transformContext` injection of the newest matching prior handoff, once per fresh session. The read side handoff was missing. |

## Output-contract residual

- Decode-time forcing was the big deferred piece — **now delivered** (provider
  `toolChoice` + `Agent.forceTool`, corrective-turn-only). The only remaining
  non-goal is a provider `responseFormat`/JSON-schema decode constraint, which
  Anthropic does not support; tool-choice forcing is sufficient because the
  `respond` tool's parameters *are* the schema. No further work tracked.

## Re-design Wave 1 (Phase 0) — deferred findings

From the F whole-project closeout review of `docs/design/2026-06-28-phase0-foundation.md`. These are the
acknowledged out-of-scope ripples of the `Usage.inputTokens` redefinition (KDD-2: `inputTokens` is now
fresh/non-cached input; cache tokens are disjoint siblings). Both are non-blocking and harmless today
(no test or production path exercises a cached run through them); committed cache-aware scope was
`cost.ts` + `budget-cap.ts` only (Surgical Changes).

| # | Finding | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| RW1-1 | `limits.ts:207` per-run token budget omits cache tokens on a cached run (`usage.inputTokens + usage.outputTokens`) | `docs/design/2026-06-28-phase0-foundation.md` (§3, KDD-2 ripple; impl §5) | S · L | No test exercises a cached run through `limits`. Fix: sum via `totalTokens(usage)` so cache tokens count. |
| RW1-2 | `trace.ts:206` `in=`/`out=` split display shows fresh input only on a cached run (cosmetic; `total=` already cache-aware via `totalTokens`) | `docs/design/2026-06-28-phase0-foundation.md` (§3, KDD-2 ripple; impl §5) | S · L | Display-only. Fix: add a `cache=` field or fold cache into the `in=` display. |
