# Deferred follow-ups register

A single ledger of sub-features that were **deliberately deferred** by an
extension's design (each named in that design's Scope Boundary + `Deferred:`
closure line), plus the rationale for keeping them deferred. This is the
"what we chose not to build, and why" record — none of these are exploitable
gaps or half-finished surfaces; each is a separate, larger design that does not
fold into the shipped slice.

Verdicts below are from a dedicated assessment pass (build-vs-defer, weighing
minimalist fit / value / effort / risk).

## Closure ledger — finish-followups program (2026-07-01)

**This ledger is the authoritative status; where a per-item row below still reads "deferred", this
ledger supersedes it.** Under the "finish every deferred item" directive, the register was driven to
exhaustion: each item was either **built** (through the three-loop, fresh-reviewer-gated) or **closed
won't-build** (validated by an adversarial reviewer briefed to *find* a buildable non-degrading
offline-testable slice — closed only when none exists, each with a deployment alternative).

This ledger accounts for **every** register ID. (A late audit re-checked four upper-table rows that
still read "deferred" — RW1-2, RW8b-1, RW7d-1, RW9-1 — and confirmed all four were **already resolved**
by the 2026-06-30 "Deferred cleanup" section below; their upper rows were merely stale. Several other
detail rows are likewise superseded by the Wave-9 reconciliation / Deferred-cleanup sections. This
ledger is authoritative over any such stale row.)

**Built / resolved:**
- *This finish-followups program:* RW7b-1 (semantic memory recall), DEFERRED-1 (risk-guard per-value
  decode), RW7b-3 (memory auto-promotion), RW8a-3 *refine-to-convergence* (`graph_search`
  `refineRounds`), RW7c-2 (OTel traceparent propagation). Each has a `docs/design/2026-07-01-*.md`
  closure block.
- *Earlier (finish-deferred / Wave A–D):* KR-1, FRESH-1/2/4, FRESH-50, RW7c-1/RW7c-4 (metrics/logs +
  histogram), RW8a-1/RW8a-2 (ToT/GoT + goalScore), RW7b-2 (archive-scoped forget), RW7a-3 (time-travel
  polish).
- *Resolved by Wave 9* (see the Wave-9 reconciliation section below; detail rows above are stale):
  RW1-1 (budget counts cache tokens), RW3-1 (flow-guard reads the acting transcript), RW3-2 (guards act
  on the acting agent), RW6c-4 (codeact readonly bwrap `--ro-bind`), RW8b-2 (failed adopt-load rolls
  back), RW6d-1 (Gemini empty-`parts` replay skip).
- *Resolved by the `sandbox-linux` CI job:* RW6c-3, RW9.3-1.
- *Resolved by the 2026-06-30 "Deferred cleanup" (stale upper rows):* RW1-2 (trace `cache=` field,
  `trace.ts:209-211`), RW7d-1 (eval fixtures broadened 2→5, every assertion predicate pinned; the
  open-ended "add more" remainder is not a bounded feature; pass@k = closed DEFERRED-5), RW8b-1
  (self-improve `realEvaluate` integration test — `test/self-improve-integration.test.ts`, run in the
  `sandbox-linux` CI job, backend-gated + `EAGENT_SI_INTEGRATION`-opt-in so `npm test` stays offline),
  RW9-1 (otel `session_shutdown` awaits `lastFlush` + a final `flush()`; the only residual — a hard
  `process.exit` with no shutdown emitted — is inherently unflushable, best-effort telemetry by design).

**Closed (won't-build, adversarially validated):**
- Batch 1 — `docs/design/2026-07-01-deferred-closures.md`: **RW6c-2**, **RW6b-1**, **DEFERRED-5**.
- Batch 2 — `docs/design/2026-07-01-deferred-closures-batch2.md`: kernel-headroom cluster
  **RW4-1**, **RW3-3**, **RW3-4**, **RW6a-1**, **RW6a-2**, **RW5-1**; correctness-hazard/no-consumer
  **RW7a-1**, **RW7a-2**, **DEFERRED-2**, **RW6c-1**, **DEFERRED-6**; inert/speculative **DEFERRED-3**,
  **DEFERRED-4**, **RW7c-3**; working-guard/cosmetic **RW9-2**, **RW9-3**, **RW4-2**; plus the RW8a-3
  sub-parts (GoT operations-DSL + `tree_search→graph_search` composition).

Every closed item has a validated deployment alternative in its closure doc — none leaves a capability
gap. **The register is now fully accounted for: every ID is built, resolved, or validated-closed** — a
late audit re-verified the four apparently-open upper rows (RW1-2, RW7d-1, RW8b-1, RW9-1) and found all
four already shipped (2026-06-30 cleanup). A subsequent **register-blind production-readiness audit
(2026-07-02)** then found 13 *new* gaps not previously tracked — recorded and being resolved below.

## Production-readiness audit gaps (2026-07-02)

A 63-agent register-blind audit (6 dimension scanners → adversarial verification) surfaced 13 genuine
gaps (0 high, 1 medium, 12 low) outside the existing register — the HTTP host was the least
production-ready surface, plus a handful of guard/kernel/test edges. These are being resolved across
several three-loop waves; status updated per wave.

| ID | Gap | Location | Sev | Status |
|----|-----|----------|-----|--------|
| SRV-1 | Streaming `res` has no `'error'` listener + **no process-level `uncaughtException`/`unhandledRejection` backstop** anywhere in `src/` → a client socket reset mid-stream can crash the whole host. | `server.ts:345`; `cli.ts` | MED | **RESOLVED** (Wave 2) — class-wide `res.on("error")` at the createServer callback covers every response + streaming teardown; targeted, no masking global handler. |
| SRV-2 | The top-level 500 fallback re-sends headers after the stream committed them (`ERR_HTTP_HEADERS_SENT`) → unhandled rejection → host crash. | `server.ts:159-161,299,420` | LOW | **RESOLVED** (Wave 2) — `sendJson` no-ops when `headersSent`; `restore` moved inside `streamRun`'s try so a setup throw becomes an in-stream error line. |
| SRV-3 | `sessions` Map is unbounded (full `AgentState` per turn, freed only by `DELETE`) → a client rotating session ids grows heap to OOM. | `server.ts:148,370` | LOW | **RESOLVED** (Wave 2) — LRU-bounded at `EAGENT_MAX_SESSIONS` (default 1000, `0`=unbounded; empty/invalid → 1000). |
| SRV-4 | External stream inputs read with no size cap (`parseSSE` buffer, provider accumulators, MCP `res.text()`/readline) → OOM/DoS; `readCapped` primitive exists but isn't applied. | `providers/http.ts:29`; `mcp.ts:189,354` | LOW | **RESOLVED (parseSSE)** (Wave 3, `docs/design/2026-07-02-sse-buffer-cap.md`) — the shared `parseSSE` incomplete-event buffer is capped at `EAGENT_MAX_SSE_EVENT_BYTES` (default 16 MiB), protecting all 3 fetch providers. **SRV-4b (deferred):** the MCP transport reads (`res.text()`, stdio readline) — a distinct mechanism, MCP separately gated. |
| SRV-5 | Error-path exit (`main().catch`) skips `host.dispose()` → `session_shutdown` never fires → orphaned stdio-MCP children. | `cli.ts:442`; `server.ts:453` | LOW | **RESOLVED** (Wave 2) — server + CLI `main()` bodies wrapped to dispose the host on an error exit (symmetric with the signal paths). |
| SRV-6 | SIGINT/SIGTERM `shutdown` is not idempotent → a second signal re-emits `session_shutdown` to live handlers during the first dispose. | `server.ts:447-448` | LOW | **RESOLVED** (Wave 2) — idempotent `HttpServer.close` + a `shuttingDown` guard on the server `shutdown` and the CLI signal path. |
| KERN-1 | `CapabilityManager.require()` is an async check-then-act (`has()` … await `confirm` … `set()`) → concurrent tool dispatch double-prompts the human and races the remembered write. (Kernel; 0 headroom.) | `capabilities.ts:95,116-117` | LOW | OPEN |
| GUARD-1 | `secret-guard` (default-ON) arg scanner has **no recursion depth bound** → a deeply-nested payload → RangeError → its fail-open catch skips the scan → secret bypass. `provenance` bounds the identical scan (`MAX_SCAN_DEPTH=8`); secret-guard doesn't. | `secret-guard.ts:81-91,126` | LOW | **RESOLVED** (Wave 4a, `docs/design/2026-07-02-secret-guard-scan-depth.md`) — `walk` bounded at `MAX_SCAN_DEPTH=8`, mirroring provenance. |
| GUARD-2 | `flow-guard` sensitive-path taint scans only top-level arg values (no recursion) → a path nested in a sub-object isn't tainted; asymmetric with provenance/secret-guard. | `flow-guard.ts:129-138` | LOW | **RESOLVED** (Wave 4b, `docs/design/2026-07-02-flow-guard-path-recursion.md`) — path taint recurses a depth-bounded string-leaf search (nested paths now tainted). |
| GUARD-3 | `risk-guard` classifier sub-call uses a never-aborted `AbortController` (no timeout) inside a blocking gate → a hung provider stalls the gated call forever. | `risk-guard.ts:149` | LOW | **RESOLVED** (Wave 4c, `docs/design/2026-07-02-risk-guard-classify-timeout.md`) — classifier sub-call now `AbortSignal.timeout` (default 10000, `EAGENT_RISK_GUARD_TIMEOUT_MS`); a hang times out → fail-open. |
| TEST-1 | `memory` real fetch embedder (`resolveEmbedder`) has zero offline coverage though it's cheaply `fetch`-stub-testable → a regression yields permanent silent lexical fallback with no failing test. | `memory.ts:153-165`; `memory.test.ts` | LOW | **RESOLVED** (Wave 6, `docs/design/2026-07-02-memory-embedder-wire-test.md`) — `resolveEmbedder` exported + a `fetch`-stub wire test (endpoint/headers/body/parse/throw). |
| DOC-1 | RW7c-2 is marked RESOLVED yet still appears in the "still deferred" prose list (factually false). | `DEFERRED-FOLLOWUPS.md` (2026-07-01 still-deferred prose list) | LOW | **RESOLVED** (Wave 1) — superseding banner added over the stale 2026-07-01 list. |
| DOC-2 | Six per-item detail rows read "deferred" over already-fixed code (RW1-1, RW3-1/2, RW6c-4, RW8b-2, RW6d-1) — incomplete strikethrough pass. | `DEFERRED-FOLLOWUPS.md` detail rows | LOW | **RESOLVED** (Wave 1) — all six rows struck to RESOLVED. |

## Kept deferred (correctly cut — Simplicity First)

| # | Sub-feature | Home design doc | Effort · Risk | Why it stays deferred |
|---|---|---|---|---|
| ~~1~~ | **RESOLVED 2026-07-01** (`docs/design/2026-07-01-risk-guard-per-value-decode.md`). `risk-guard` now decode-normalizes each **string-leaf arg value** (not just the whole blob), so a rot13'd command hidden in one value (`{"cmd":"ez -es /"}` → `rm -rf /`) is surfaced to the judge — resolving the whole-blob asymmetry. A strict superset of the old candidates (deduped); off by default; `lib/decode.ts`/bash-policy untouched. The old "AC11 (negative)" asymmetry test is flipped to a positive per-value test. | — | — | — |
| 2 | secret-guard env-ref **rewriting** (`$NAME` / asterisks) | `docs/design/2026-06-22-secret-guard.md` (§3, D3, §8) | M · H | Silent mutation of model output is a correctness minefield — rewriting to `$OPENAI_API_KEY` only works if that env var exists; a wrong guess silently breaks the call. detect-+-hold (ask/block) is the safe v1 boundary; rewrite is high blast-radius. |
| 3 | routing **N-tier** policy + **cost-feedback** routing | `docs/design/2026-06-22-routing.md` (§3) | M · M | The design caps at two tiers on purpose; N-tier generality and cost-aware routing are speculative and each need their own design once requirements crystallize. (NOTE: the assessment floated a "tier-model **registry validation**" quick win, but on inspection it is **not applicable** — EAgent has no model-id registry. `ProviderRegistry` keys by provider *name* (`registry.ts:74`) and model ids are free-form strings passed straight to the provider API, so there is nothing to validate a model id against. `routing.ts:278-287` already does the maximal possible check: the tier-map entry must be a usable non-empty string, else it falls back to the captured baseline with a warning — never a throw, never an empty assignment. Nothing to build here.) |
| 4 | mcp-resources **subscriptions** + change-notifications + parameterized **templates** | `docs/design/2026-06-22-mcp-resources.md` (§3) | L–H · H | Subscriptions need server→client push + cache invalidation (new transport plumbing + state); templates are speculative (a model can read concrete URIs today). The request/response v1 is complete for the stated problem. |
| ~~5~~ | **CLOSED (won't-build) 2026-07-01** — evals pass@k CIs. `docs/design/2026-07-01-deferred-closures.md`; fresh adversarial review confirmed no non-inert offline slice: MockProvider is deterministic (`mock.ts:114-119`; `runEvalDir` runs each scenario once), so pass@k ≡ pass@1 and the CI is degenerate. A varied-mock version measures a hand-authored distribution, not agent reliability. Real pass@k needs a live stochastic provider (ops/CI-with-keys, off the offline gate). | — | — | — |
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
| ~~RW1-1~~ | **RESOLVED** (Wave 9; row was stale) — the per-run token budget now counts cache tokens via cache-aware `totalTokens` (`limits.ts:210`). | — | — | — |
| ~~RW1-2~~ | **RESOLVED** (already fixed; row was stale). `trace.ts:209-211` computes `cache = cacheRead + cacheWrite` and renders a `cache=${cache}` field (shown only when >0, so an uncached line stays byte-identical) alongside `in=`/`out=`/`total=`, so the split never reads as contradictory. | — | — | — |

## Re-design Wave 3 (governed sub-agents) — deferred residuals

From `docs/design/2026-06-28-governed-subagents.md` (KDD-6, §3). `childScope` governs children via the
gate filters + intra-run events; these residuals need a deeper per-agent rework and are each their own
design. All are **strictly more** governance than the prior fresh-bus status quo — none is a regression.

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| ~~RW3-1~~ | **RESOLVED** (Wave 9; row was stale) — flow-guard data-taint now reads the acting-agent transcript via `currentActingAgent()` (`flow-guard.ts:168`), so a child that reads a sensitive file is governed. | — | — | — |
| ~~RW3-2~~ | **RESOLVED** (Wave 9; row was stale) — circuit-breaker/budget-cap/output-contract now act on the acting agent via `currentActingAgent()`, so a child's soft nudge/stop no longer misroutes to the parent. | — | — | — |
| RW3-3 | `AgentHandle.spawnChild` not added — the four sites still construct children directly (now with `childScope`). | same (KDD-5) | S · L | A first-class spawn helper is best designed once Wave 8's search controller has concrete needs. |
| RW3-4 | `agentId`/`depth` event **attribution/tagging** not added (would change every `KernelEvents` payload). | same (KDD-6) | M · M | Add once a consumer needs to attribute/dedupe child vs parent lifecycle signals. |

## Re-design Wave 4 (forkable state) — deferred residuals

From `docs/design/2026-06-28-forkable-state.md` (KDD-2, KDD-5). The kernel ships snapshot/restore/#step;
these are scoped-out extensions/consumers, not gaps.

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| RW4-1 | `Agent.fork()` not added (a child Agent reusing registries with a deep-copied transcript). The Wave-4 consumer (the server) is sequential and needs restore-into-the-same-agent, not a second live agent. | `docs/design/2026-06-28-forkable-state.md` (KDD-2) | S · L | Designed with **Wave 8**'s reasoning-search controller, which needs governed branches (`new Agent({…registries, hooks: parent.hooks.childScope()}).restore(parent.snapshot())`). |
| RW4-2 | Server **cross-session bleed of non-conversational state**: `done.usage`/model/systemPrompt/thinking are now per-session, but the `CapabilityManager` audit log, the namespaced `Store`, and `cost`/`budget-cap` accumulators remain process-shared across sessions. | same (KDD-5) | M · M | Needs `fork()` (RW4-1) or per-session `CapabilityManager`/`Store` instances — a larger server rework. snapshot/restore isolates conversational state + usage only. |

## Re-design Wave 5 (reliability boundary) — deferred residual

From `docs/design/2026-06-28-reliability-boundary.md` (KDD-4, §3).

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| RW5-1 | Rewrite `fallback-routing` onto the new `onProviderError` seam (it currently uses the composite-`Provider` + mutable-`Agent.providerName` approach). | `docs/design/2026-06-28-reliability-boundary.md` (KDD-4, §3) | M · M | The seam now exists (Wave 5), but cross-provider failover via `onProviderError` would need the seam to expose/allow a provider swap (it currently does same-provider retry + model downshift). Migrating `fallback-routing` is a separate design; the composite approach works and stays until then. |

## Re-design Wave 6a (beforeDispatch) — deferred residuals

From `docs/design/2026-06-29-before-dispatch.md` (KDD-2, KDD-6).

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| RW6a-1 | `beforeDispatch` cannot **inject** brand-new tool-call ids (only reorder/drop the originals). | `docs/design/2026-06-29-before-dispatch.md` (KDD-2) | M · M | An injected id has no matching assistant `tool_use`, so its `tool_result` would orphan next turn — supporting it requires also mutating the already-emitted assistant message. A separate design that handles the assistant-message side. |
| RW6a-2 | `beforeDispatch` is **not** shared to sub-agents (not in `SHARED_FILTER_POINTS`), so a child's wave runs its own empty→passthrough chain. | same (KDD-6) | S · L | One-line add to `SHARED_FILTER_POINTS` if wave-governance-for-children is wanted; deferred to avoid reaching into Wave 3's childScope contract with no current consumer. |

## Re-design Wave 6b (provenance/taint) — deferred residual

From `docs/design/2026-06-29-provenance-taint.md` (KDD-1).

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| ~~RW6b-1~~ | **CLOSED (won't-build) 2026-07-01** — consolidate flow-guard data-taint into provenance. `docs/design/2026-07-01-deferred-closures.md`; fresh adversarial review confirmed it's a pure internal refactor with **no user-visible gain** and **regression risk to a default-ON guard**: flow-guard (read-sensitive→egress, pattern, default-ON, clears on `/clear`) and provenance (fetch-foreign→sink, verbatim-segment, default-OFF, doesn't clear) are genuinely dual axes. The RW3-1 child-gap is already closed by W9.1 (`flow-guard.ts:168-169`). | — | — | — |

## Re-design Wave 6c (ExecutionTarget / codeact sandbox tier) — deferred residuals

From `docs/design/2026-06-29-execution-target.md` (§3, R6, L1 round-2 note).

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| RW6c-1 | A real **container/microVM backend** (gVisor/Firecracker/Kata/E2B) wired into `lib/sandbox`'s `detectBackend`/`wrapCommand` plug-in point. | `docs/design/2026-06-29-execution-target.md` (§3) | H · H | Needs deps + infra and is not zero-dep/offline-testable; the lib is the documented seam where a deployment adds one. The shipped OS-launcher tiers (`sandbox-exec`/`bwrap`/`firejail`) are the best-effort zero-dep layer. |
| ~~RW6c-2~~ | **CLOSED (won't-build) 2026-07-01** — dir-scoped macOS sandbox-exec write profile. `docs/design/2026-07-01-deferred-closures.md`; fresh adversarial review confirmed every narrowing risks an **offline-uncatchable fail-closed EPERM/ENOENT**: codeact spawns the interpreter with a scrubbed env (`HOME=os.tmpdir()` under `/private/var/folders`, `TMPDIR` unset → Node `os.tmpdir()`=`/tmp`), so dropping *either* temp subpath breaks a legit snippet; the only string-testable variant is a trap knob. `bwrap`/`firejail` are already dir-scoped; the no-home/project-writes guarantee already holds. | — | — | — |
| RW6c-3 | A **real-host launcher smoke test** (`bwrap`/`sandbox-exec` actually present) before Wave 8 relies on the wrap end-to-end — the offline suite uses a forced backend + fake-launcher-on-PATH, never a real launcher. | same (L1 round-2 note) | S · M | The pure `wrapCommand` is unit-pinned and the integration is proven via a PATH shim; a one-time real-host smoke de-risks the bwrap `--tmpfs /tmp` + temp-dir-root interaction before self-improvement candidates depend on it. |
| ~~RW8b-1~~ | **RESOLVED** (2026-06-30 cleanup; row was stale). `test/self-improve-integration.test.ts` exercises the real `realEvaluate` (spawn + sandbox + subprocess + `runEvalDir` + tamper path) end-to-end; it runs in the `sandbox-linux` bwrap CI job (`ci.yml:50-53`), backend-gated + `EAGENT_SI_INTEGRATION`-opt-in so default `npm test` stays fast/offline. | — | — | — |
| ~~RW8b-2~~ | **RESOLVED** (Wave 9; row was stale) — a failed adopt-load now reverts the staged→live `renameSync` (`self-improve.ts:427-434`), so a broken candidate doesn't auto-load un-reviewed on restart. | — | — | — |
| ~~RW8a-1~~ | **RESOLVED 2026-06-30.** Both halves shipped: ToT as `tree_search` (multi-step beam search) and GoT as `graph_search` (generate → aggregate → refine), `docs/design/2026-06-30-tree-search.md` + `docs/design/2026-06-30-graph-of-thought.md`. | — | — | — |
| RW8a-3 | **GoT extensions** beyond `graph_search` v1. **Multi-round iterative refinement (refine→score→refine to convergence): RESOLVED 2026-07-01** (`docs/design/2026-07-01-graph-search-refine-rounds.md` — optional `refineRounds?`, default 1 = byte-identical, stops the first non-improving round). The other two sub-parts **CLOSED (won't-build)**: the configurable Graph-of-Operations DSL and cross-tool `tree_search→graph_search` composition are speculative generality with no consumer, and the composition entangles the shared recursion-guard registry pruning (`reasoning-search.ts:89`). | `docs/design/2026-06-30-graph-of-thought.md` (§3, KDD-2) | — | Refine-to-convergence shipped; DSL/composition won't-build (speculative). |
| RW8a-2 | **Early goal-termination** in `tree_search` — v1 always runs to `depth`; a goal-threshold (or classifier) that stops once a thought scores above a bar would cut cost on easy problems. | `docs/design/2026-06-30-tree-search.md` (R5, KDD-5) | S–M · L | v1's termination is purely depth-bounded by design (KDD-5); the global best-so-far is already tracked, so an early-exit is additive. |
| ~~RW7d-1~~ | **RESOLVED** (2026-06-30 cleanup; row was stale). Eval fixtures broadened 2→5 (`parallel-wave`, `subsequence-in-order`, `text-only-budget`), pinning every assertion predicate (`order:in_order`/`exact`, `maxSpans`, `maxTokens`, `finishReason`, `noToolErrors`); `npm run eval` 5/5. The open-ended "keep adding fixtures" remainder is incremental-by-nature (not a bounded feature); statistical pass@k = **closed** DEFERRED-5 (inert against the deterministic MockProvider). | — | — | — |
| ~~RW7c-1~~ | **RESOLVED 2026-06-30.** `otel-exporter` now emits all three OTLP signals — traces + **metrics** (`/v1/metrics`: `eagent.gen_ai.token.usage` + `eagent.tool.calls` cumulative Sums) + **logs** (`/v1/logs`: metadata-only error/outcome records, trace-correlated). `docs/design/2026-06-30-otlp-metrics-logs.md`. | — | — | — |
| ~~RW7c-4~~ | **RESOLVED 2026-07-01** (Wave C). otel-exporter now emits the OTel GenAI semconv Histogram `eagent.gen_ai.client.operation.duration` (per-call inference latency, the published advisory buckets, no config) alongside the two Sums. `docs/design/2026-07-01-otel-operation-duration-histogram.md`. | — | — | — |
| ~~RW7c-2~~ | **RESOLVED 2026-07-01** (`docs/design/2026-07-01-otel-traceparent-propagation.md`). otel-exporter publishes each tool-call span's W3C `traceparent`; web + mcp inject it onto outbound tool HTTP — gated on otel-on **and** an `EAGENT_OTEL_PROPAGATE_HOSTS` allowlist (default empty ⇒ inert, byte-identical). No kernel change. | — | — | — |
| RW7c-3 | **Real-collector smoke** — the offline suite stubs `fetch`/asserts the OTLP body shape; a one-time smoke against a live Jaeger/Tempo/OTLP collector validates the wire end-to-end. | `docs/design/2026-06-29-otel-exporter.md` (R2) | S · M | Offline can't validate a live backend; the body shape is unit-pinned, but a real-collector smoke de-risks before production reliance. |
| ~~RW7b-1~~ | **RESOLVED 2026-07-01.** Optional **semantic (embedding)** recall for `memory`: an injectable `Embedder` (`setEmbedder`) + a `fetch`-based real embedder from `EAGENT_MEMORY_EMBED_ENDPOINT`, embed-on-recall cosine ranking, **off by default → lexical byte-identical**, **fail-soft** to lexical, `EAGENT_MEMORY_EMBED=off` kill switch. `docs/design/2026-07-01-semantic-memory-recall.md`. **The "forbidden by the zero-dep rule" premise was wrong** — the chat providers already do zero-dep `fetch`, so a fetch embedder + a deterministic mock is feasible offline (no kernel change). | — | — | — |
| RW7b-2 | An **archive-scoped `forget`** (delete an archived note in one step). | `docs/design/2026-06-29-tiered-memory.md` (§3) | S · L | v1 deletes an archived note via `/memory promote` then `/memory forget` (two steps); a direct archive-forget is a small follow-up. |
| ~~RW7b-3~~ | **RESOLVED 2026-07-01** (`docs/design/2026-07-01-memory-auto-promotion.md`). `recall` bumps each returned archive note's `recalls` count and auto-promotes it to core at `EAGENT_MEMORY_PROMOTE_AT` (the operator-chosen relevance-trigger policy); **default off** (unset/0) ⇒ byte-identical read-only recall. Additive `Entry.recalls?` (no migration). | — | — | — |
| RW7a-1 | **Delta/incremental blob** storage for checkpoint nodes (each node stores a full `AgentState`, so a deep tree duplicates the growing transcript). | `docs/design/2026-06-29-time-travel.md` (§3) | M · M | The FIFO cap bounds disk today; delta storage (store only the message diff vs parent) is an optimization, not a correctness need. Deferred until disk pressure is real. |
| RW7a-3 | Command polish (F-review): `/rewind`/`/fork` don't re-check the `enabled` flag (so enable→create→disable→`/fork` would still write a node — harmless in the shipped-off default since no nodes exist); and an ambiguous-step selector prints both `resolve()`'s "ambiguous step" line and the caller's "no such checkpoint" line. | `docs/design/2026-06-29-time-travel.md` (F review) | S · L | Cosmetic; off-by-default makes it inert in practice. A one-line `enabled` guard on fork + suppressing the caller's second message; not worth churning merged code for an edge. |
| RW7a-2 | **Unify conversation rewind with workspace rollback** — `/rewind` restores agent state only; files are `checkpoint.ts`'s `/rollback`. A combined "rewind to step N AND roll the workspace back" needs an id-alignment design between the two extensions. | `docs/design/2026-06-29-time-travel.md` (KDD-5) | M · M | Coupling two extensions is fragile (git may be absent; step-ids ≠ workspace-checkpoint-ids). Documented; operator pairs them manually. A later design can align them. |
| ~~RW6d-1~~ | **RESOLVED** (Wave 9; row was stale) — the Gemini builder now skips an empty-`parts` assistant turn on replay (`gemini.ts:208-212`), so a reasoning-only turn can't emit a rejectable `parts:[]`. | — | — | — |
| ~~RW6c-4~~ | **RESOLVED** (Wave 9; row was stale) — the bwrap branch now `--ro-bind`s the per-call dir for non-write tiers (`lib/sandbox.ts:119-121`), so codeact `tier=readonly` works on bwrap. | — | — | — |

---

## Wave 9 reconciliation (2026-06-29)

**Resolved by Wave 9** (closed in source + pinned by tests; F closeout pass): RW3-1 (flow-guard child
data-taint reads the acting transcript), RW3-2 (circuit-breaker/budget-cap/output-contract no longer
misroute to the parent), RW6c-4 (codeact readonly bwrap `--ro-bind`), RW8b-2 (failed adopt-load rolls back
to staging), RW1-1 (per-run token budget counts cache tokens), RW6d-1 (Gemini empty-`parts` replay skip).

**New residuals registered by Wave 9** (all low-priority / non-blocking):

| ID | Item | Source | Sev·Likelihood | Why deferred |
|----|------|--------|----------------|--------------|
| RW9.3-1 | **Linux bwrap CI job** so the new sandbox real-backend confinement tests (`test/sandbox-tiers.test.ts`) *execute* in CI rather than skip (they execute locally on macOS sandbox-exec; a Linux runner has no sandbox by default). | `docs/design/2026-06-29-sandbox-hardening.md` §3 | M · — | Infra/CI change, environment-specific; the tests skip-not-fail without a backend, so the suite stays green. |
| ~~RW9-1~~ | **RESOLVED** (2026-06-30 cleanup; row was stale). `agent_end`'s flush promise is tracked in `lastFlush`; `session_shutdown` awaits it then a final `flush()` (`otel-exporter.ts:462,468-471`), so a `process.exit` right after a run can't drop the batch. The only residual — a hard `process.exit` with no `session_shutdown` emitted at all — is inherently unflushable (best-effort telemetry by design). | — | — | — |
| RW9-2 | **Headless-fork guard-UI divergence** — circuit-breaker prompts via the *acting* agent's `ui.confirm` (a headless fork auto-denies in `ask` mode) while flow-guard/provenance prompt via the *parent* `ui`. | `circuit-breaker.ts` (F-review G2) | S · L | Both directions are fail-closed/safe; arguably correct (no N human prompts per fork). Pick one convention if unified UX is wanted. |
| RW9-3 | **citations × reasoning-search cross-fork warn** — a fork's `[src:N]` ids live in the child's per-agent state; if the parent's final answer echoes one, `agent_end` validation may log a spurious "fabricated source id" warning. | `citations.ts` (F-review G3) | S · L | Warn-only; both extensions default off. |

**2026-06-30:** RW9.3-1 **and** RW6c-3 RESOLVED by the `sandbox-linux` bwrap CI job (`.github/workflows/ci.yml`,
branch `chore/sandbox-ci-bwrap`). A dedicated `ubuntu-22.04` job installs `bubblewrap`, smoke-checks that bwrap
can create namespaces (fails loudly — never a silent skip), and runs `test/sandbox-tiers.test.ts` under the
real backend, so the security-critical wrappers (`--unshare-net`, write confinement, the readonly re-bind) are
exercised against a real launcher in CI, not only on local macOS sandbox-exec. Fresh-reviewer pass (zero severe).

## Deferred cleanup (2026-06-30, branch `chore/finish-deferred`)

Closed the genuinely-valuable small follow-ups via Light-Mode (four-field brief → fresh-reviewer dev→review
→accept). Briefs: `docs/design/2026-06-30-deferred-cleanup-batch1.md`, `2026-06-30-self-improve-real-eval-test.md`.

**Resolved:**
- **RW9-1** — otel last-batch hard-exit flush: `agent_end`'s flush promise is tracked in `lastFlush`;
  `session_shutdown` awaits it (then a final flush), so a `process.exit` right after a run can't drop the batch.
- **RW1-2** — `trace.ts` token line now shows a `cache=` field (sum of cache read/write) when > 0; uncached
  output byte-identical.
- **RW7d-1** — eval fixtures broadened 2→5 (`parallel-wave`, `subsequence-in-order`, `text-only-budget`),
  pinning the `order:in_order` / `maxSpans` / `maxTokens` / parallel-wave predicates; `npm run eval` 5/5.
- **RW8b-1** — self-improve's production `realEvaluate` now has a backend-gated, `EAGENT_SI_INTEGRATION`-opt-in
  integration test exercising the real spawn+sandbox+subprocess+`runEvalDir`+tamper path end-to-end (verified
  executing on macOS sandbox-exec; runs in the `sandbox-linux` bwrap CI job). The default `npm test` skips it
  (kept fast). Closes "the production eval path ships untested".

> **Superseded 2026-07-01:** every item this paragraph names as "kept deferred" (RW8a-3, RW7c-2/3,
> RW6c-1/2, RW4-1/2, RW5-1, RW3-3/4, RW6a-1/RW6b-1, RW9-2/3, RW7a-3/RW7b-2, RW6a-2) was subsequently
> **built or validated-closed** by the finish-followups program — see the **Closure ledger** at the top
> of this file. This paragraph is retained as historical context only.

**Reviewed and kept deferred** (Simplicity First — changing working/fail-closed code for no clear win, or a
larger design with no current consumer): **RW9-2** (headless-fork guard-UI divergence — the Wave-9 F-review
judged it "arguably correct"; a fork auto-denying is fail-closed), **RW9-3** (warn-only citations×fork edge,
off-by-default), **RW7a-3 / RW7b-2** (cosmetic / minor UX, off-by-default), **RW6a-2** (one-line beforeDispatch
share — no current consumer). Larger designs remain correctly deferred: **RW8a-3** (GoT extensions — DSL/multi-round/cross-tool; RW8a-1's ToT+GoT both shipped 2026-06-30), **RW7c-2/3** (OTLP context-propagation, live-collector smoke; RW7c-1 metrics/logs + RW7c-4 histograms shipped), **RW6c-1/2** (container backend, dir-scoped macOS profile), **RW4-1/2** (`Agent.fork`, per-session server
state), **RW5-1** (fallback-routing onto `onProviderError`), **RW3-3/4** (`spawnChild`, event attribution),
**RW6a-1 / RW6b-1** (beforeDispatch injection, taint consolidation), and the six top "correctly cut" items.

## Kernel defensive-robustness pass (2026-07-01, branch `chore/finish-deferred-followups`)

From the 2026-06-30 production-readiness verification audit's register-blind kernel sweep — three *new*
defects in the kernel primitives (not previously in this register), closed via the full three-loop
(L1 4 rounds incl. corroborating; L2 2 rounds + an L2-restart for a design-conflict; L3 per-Phase
dev→review→accept; F whole-project review **pass**, zero severe). Design/impl:
`docs/{design,implementation}/2026-06-30-kernel-robustness.md`.

**Resolved:**
- **FRESH-1** (HIGH) — a user `stop()`/abort that lands *during* an in-flight provider stream surfaced
  as `reason:"error"` + an `"error"` event + a thrown `run()` (a real `fetch` provider rejects the
  stream; `MockProvider` breaks gracefully, so the offline suite never caught it). `run()`'s catch now
  reports `reason:"stop"` with no event and no re-throw when `signal.aborted`; a genuine error (signal
  not aborted) keeps the exact `reason:"error"` + emit + throw path. **Blast-radius:** the sole test
  pinning the old contract (`fallback-routing.test.ts`) was updated (keeps its `spy.calls===0`
  no-failover invariant); CLI cancel UX **improved** (no spurious red `✗`); server `streamRun` already
  handled `reason:"stop"`. Commit f6b5148.
- **FRESH-2** — `maxConcurrency <= 0` spawned an empty worker pool → sparse `results` → `TypeError` at
  the reconcile `.find` (`agent.ts:303`). Clamped to a floor of `1` in the constructor
  (`Math.max(1, … ?? Infinity)`; default `Infinity` and the fast path unchanged). Commit f6b5148.
- **FRESH-4** — `FileStore.read()` conflated an absent file (normal first run) with corrupt JSON and
  let the next `flush()` atomically overwrite/destroy the corrupt file. Now an `existsSync` guard keeps
  absent silent, and a corrupt file is **best-effort** renamed aside to `*.corrupt-<pid>-<ts>` before
  returning `{}` (recoverable; `flush()` untouched). Commit 335e701.

Kernel stayed `< 2200` (2198 → **2199**) by compressing the `run()` abort comment, not raising the
ceiling. Suite 1136 → **1143 pass / 0 fail / 1 skip**; typecheck 0; eval 5/5.

**New finding registered (deferred):**
- ~~**KR-1**~~ — **RESOLVED 2026-07-01** (branch `chore/finish-followups-2`). Server `streamRun`
  snapshotted the session inside the `reason:"stop"` path, so a *first* turn aborted before any
  assistant output persisted a bare dangling `[user]` transcript (a later turn could then form two
  consecutive user messages). Fixed: `streamRun` skips `sessions.set(...)` when `agent.messages` ends on
  a `user` turn (`server.ts:363-371`), keeping the session's last valid state; the aborted turn is
  discarded. Light-Mode brief `docs/design/2026-07-01-server-abort-snapshot-guard.md`; fresh review
  confirmed the heuristic cannot false-positive (no resumable state ends on a `user` message).

**Documented, benign, no action:** under a real provider, a parent-aborted `reasoning-search` fork now
resolves `reason:"stop"` (scored normally) instead of rejecting (scored `-Infinity`) — only during
parent cancellation when the fork's result is moot; offline tests use graceful-break providers and are
unchanged.

## Finish-deferred-followups program — Waves B/C/D (2026-07-01)

Completing the genuinely-valuable, feasible deferred work surfaced by the 2026-06-30 verification audit,
on branch `chore/finish-deferred-followups`. Wave A (the kernel pass, FRESH-1/2/4 + KR-1) is the section
above; B/C/D below. Each wave fresh-reviewer-gated (Full L1→L2→L3→F for A + C; Light four-field brief +
fresh-review for B + D). Suite 1136 → **1151 pass / 0 fail / 1 skip**; typecheck 0; eval 5/5; kernel
2199/2200 (Wave A's +1; B/C/D no kernel change); no new dependency.

**Resolved:**
- **FRESH-50** (Wave B) — `checkpoint` gained an `EAGENT_CHECKPOINT=off` kill switch (early no-op
  return in `activate`; the auto-snapshot runs synchronous git on every mutating tool call, so the
  default-on extension now honors the house opt-out convention). On-by-default preserved. Commit 5e26fa1.
- **RW7c-4** (Wave C) — `otel-exporter` now emits the OTel GenAI semconv **Histogram**
  `eagent.gen_ai.client.operation.duration` (per-call inference latency, seconds, the published advisory
  buckets) alongside the two Sums — the latency *distribution* (p50/p90/p99) a Sum can't give. Measured
  `turn_start → usage` (before tool dispatch), `(performance.now() − start)/1000` s, gated `anyEnabled()`.
  `docs/{design,implementation}/2026-07-01-otel-operation-duration-histogram.md`. Commit be0154a.
- **RW8a-2** (Wave D) — `tree_search` optional `goalScore?` early-termination (break after the per-depth
  best-update once `best.score >= goalScore`; default-absent ⇒ byte-identical). Commit 1b1722c.
- **RW7b-2** (Wave D) — `memory` `forget-archive <key>` verb (delete an archived note in one step).
  Commit 1b1722c.
- **RW7a-3** (Wave D) — `time-travel` command polish: an ambiguous bare-step selector prints **one** line
  (`resolve()` returns an `"ambiguous"` sentinel, callers suppress the duplicate `no such checkpoint`);
  `/fork` honors `cfg().enabled` (the write path). Commit 1b1722c.

> **Superseded 2026-07-01 (DOC-1 fix):** this 2026-07-01 audit list is stale — the finish-followups
> program subsequently **built** RW7c-2 (traceparent propagation) and RW8a-3's refine-to-convergence,
> and **validated-closed** the rest (RW9-2/3, RW4-1/2, RW5-1, RW6b-1, RW3-3/4, RW6a-1/2, RW7a-1/2,
> RW6c-1, DEFERRED-2/3/4/6). See the **Closure ledger** at the top, which is authoritative. Retained as
> historical context only.

**Still deferred (verified infeasible or intentional Simplicity-First cut — unchanged):** the audit
confirmed these stay deferred — they break the zero-dep / offline-testable / tiny-seam constraints or
have no current consumer: **RW6c-1** (container backend),
**RW7c-2** (traceparent propagation — needs a new tool-HTTP egress seam), **RW7c-3** (live-collector
smoke — un-offline-testable), **RW7a-1/2** (delta blobs, rewind↔workspace unification), **RW6a-1/2**,
**RW3-3/4**, **RW4-1/2**, **RW5-1**, **RW6b-1**, **RW8a-3** (GoT DSL/multi-round), **RW9-2/3**, and the six
top "correctly cut" items (`DEFERRED-1..6`). Building these would spend kernel headroom on no-consumer
seams or violate the zero-dep/offline posture. (**KR-1**, the one new finding registered above, was
subsequently **resolved 2026-07-01** on `chore/finish-followups-2`.)
