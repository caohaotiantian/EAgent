# EAgent Re-Design — Living Roadmap

Living tracker for the first-principles re-design. Strategy & rationale: see
[`docs/design/2026-06-28-eagent-redesign-blueprint.md`](design/2026-06-28-eagent-redesign-blueprint.md).
This file is **maintained as work lands** — status, commits, deferrals updated per wave.

**Branch:** `feat/redesign-superpowers` · **Started:** 2026-06-28 · **Driver:** three-loop-workflow (Full Mode per wave)

Status legend: ⬜ not started · 🟡 in progress (L1/L2/L3) · ✅ done (accepted, tests green) · ⏸️ deferred

## Wave order (dependency-respecting)

| Wave | Scope | Items | Status |
|---|---|---|---|
| 1 | **Phase 0 — Foundation pack** | P0.1 CI gate+strict host · P0.2 Usage/caching accounting · P0.3 cap-set unification (mcp:call) · P0.4 validator hardening + re-validate · P0.5 bounded concurrency | ✅ |
| 2 | **transformRequest keystone** | P1.1 `transformRequest` filter (kernel seam #1) | ✅ |
| 3 | **Governed sub-agents** | P1.2 child-scoped HookBus + usage bubbling (closes HIGH guard-bypass) | ✅ |
| 4 | **Forkable state** | P1.3 snapshot/restore + step ids + frozen handle.messages + per-session server isolation | ✅ |
| 5 | **Reliability boundary** | P1.4 `onProviderError` repair seam + reliability ext + StopReason enrichment | ✅ |
| 6 | **Governance on new seams** | P2.1 provenance/taint (ext) · P2.2 `beforeDispatch` wave seam · P2.3 ExecutionTarget tiers · P2.4 reasoning replay-fidelity | ⬜ |
| 7 | **Capability extensions** | P3.1 event-sourced resume+time-travel · P3.2 tiered self-editing memory · P3.3 OTel exporter + evals-as-CI | ⬜ |
| 8 | **Advanced (opt-in)** | P4.1 reasoning-search controller · P4.2 self-improvement harness + restricted ExtensionAPI | ⬜ |

## Per-item detail & acceptance

(Each item's L1 design doc and L2 impl doc live under `docs/design/` and `docs/implementation/`
with slug `YYYY-MM-DD-<item>`. Acceptance = item's `<ACCEPT-CMD>` + full `npm test` + `npm run typecheck` green.)

### Wave 1 — Phase 0 foundation pack  ✅ (closed 2026-06-28; commits 63fa0f0…0322c27)
- **P0.1** `BUILTIN_EXTENSIONS` CI gate + strict host — load real set via `createAgentHost`, assert count==list-length, no dup tool/command names, surface activation errors. *No kernel change.*
- **P0.2** Widen `Usage` (`cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?`); stop folding cache into `inputTokens` (anthropic.ts:153-154); populate openai/gemini; fix cost.ts/budget-cap.ts pricing. *Additive kernel type.*
- **P0.3** Unify egress/foreign/leak capability sets incl. `mcp:call` (flow/secret/content guards). *No kernel change.*
- **P0.4** `validate.ts` hardening (additionalProperties, min/max, pattern, numeric-enum coercion) + unconditional re-validate of `decided.arguments` (agent.ts:359).
- **P0.5** Bounded parallel dispatch — `maxConcurrency` over the wave (agent.ts:324). *Small kernel change.*

### Wave 2 — transformRequest  ✅ (closed 2026-06-28; commit 53ad0b2)
- **P1.1** Add `transformRequest` filter: value = `{systemPrompt, messages, tools, model, toolChoice, thinking}`, ctx = `{turn, cumulativeUsage}`, applied after req build in `streamTurn`; `transformContext` kept (applied to `req.messages` first). Wrap context/request/afterTool filters in the same containment `beforeToolCall` has. Pin new export + default byte-identity in kernel-surface test.

### Wave 3 — Governed sub-agents  ✅ (closed 2026-06-28; commits 270fe18…c24d596)
- **P1.2** `HookBus.childScope({agentId,depth})` view sharing handler arrays (filters govern children) + tagging events for attribution; `AgentHandle.spawnChild`; parent folds child usage; spawn/fan-out budget. Refactor subagents/teams/templates off hand-rolled child construction.

### Wave 4 — Forkable state  ✅ (closed 2026-06-28; commits 4c57608…2bd6227)
- **P1.3** `Agent.snapshot()`/`restore()` (structuredClone), `#step` on tool_end/turn_end, frozen `handle.messages`; per-session server Agent isolation as named consumer. `fork()` only if a kernel consumer needs it (else extension-layer).

### Wave 5 — Reliability boundary  ✅ (closed 2026-06-28; commits 3e64bd4…b8dd9c3)
- **P1.4** `onProviderError` filter (`{retry, downshiftModel?, fail}`, default fail=true) around the stream loop; reliability extension (backoff/jitter/fallback/circuit-breaker); enrich `StopReason` (refusal/content_filter) across providers.

### Wave 6 — Governance on new seams  ⬜
- **P2.1** provenance/taint as extension convention (additive `ToolResult.provenance?`, `Message.meta.provenance`); afterToolCall tags, beforeToolCall escalates.
- **P2.2** `beforeDispatch` filter over `ToolCallBlock[]` (reorder/dedupe/drop/inject).
- **P2.3** `ExecutionTarget` extension-owned registry under bash/codeact, fail-closed.
- **P2.4** reasoning replay-fidelity for openai/gemini.

### Wave 7 — Capability extensions  ⬜
- **P3.1** event-sourced resume + rewind-to-step + idempotent tool replay (over P1.3).
- **P3.2** tiered self-editing memory (MemGPT/Letta + Generative-Agents scoring) over transformRequest + optional embed-provider.
- **P3.3** OTel GenAI exporter (pure observer) + offline evals-as-CI-gate.

### Wave 8 — Advanced  ⬜
- **P4.1** reasoning-search controller (best-of-N/ToT/GoT) on snapshot/fork + scoped hooks + concurrency cap.
- **P4.2** self-improvement harness (DGM/STaR-lite) + **restricted ExtensionAPI** (omit raw grantCapability/load/unload) FIRST.

## Progress log

- **2026-06-28** — Blueprint synthesized (code-as-truth audit + research + critique). Roadmap created. Branch `feat/redesign-superpowers` cut from `init`. Baseline `npm test` green. Starting Wave 1.
- **2026-06-28** — **Wave 1 (Phase 0) CLOSED.** L1 design (4 rounds incl. corroborating) + L2 impl (3 rounds), both fresh-reviewer closed; L3 all 5 phases dev→review→accept; F whole-project review **pass** (clean, blast-radius verified). Test suite 906→**948 pass** (+42 new), typecheck clean, kernel 1826→1914 lines (< 2200). Shipped: AgentHost activation-failure reporting + CI gate; cache/reasoning-aware `Usage` + correct cache pricing across all 3 providers; validator hardening (additionalProperties/min-max/pattern/enum-coercion) + single re-validate gate honoring guard arg-repair; `maxConcurrency` bounded dispatch; `mcp:call` egress/leak guard fix. Deferred findings: RW1-1/RW1-2 (limits/trace cache display). Next: Wave 2 — transformRequest.
- **2026-06-28** — **Wave 2 (transformRequest) CLOSED.** L1 (4 rounds incl. corroborating) + L2 (2 rounds), fresh-reviewer gated; L3 single phase dev→review→accept (clean first round). Added the 4th kernel filter point `transformRequest` (value: systemPrompt/messages/tools/model/toolChoice/thinking; ctx: turn+cumulativeUsage), applied in `streamTurn` with default byte-identity. Test suite **952 pass** (+4), typecheck clean, kernel 1914→1961 lines. CLAUDE.md reconciled (three→four filter hooks). No deferred findings. Next: Wave 3 — governed sub-agents.
- **2026-06-28** — **Wave 3 (governed sub-agents) CLOSED.** L1 (4 rounds, 2 severe redesigns) + L2 (4 rounds, 2 severe) + L3 (2 phases) + F whole-project review **pass**. Added `HookBus.childScope()` (shares gate filters {beforeToolCall,afterToolCall} + intra-run events; suppresses run-lifecycle events; constructor-seed mechanism), wired all 4 child-spawn sites + teams. Closes the HIGH-severity guard-bypass hole (children now governed by bash-policy/risk/secret/content/flow-capability/write guards; per-run observers not reset by children; usage counted once via shared event). Test suite **961 pass** (+5), kernel 1961→2023 lines. Deferred residuals RW3-1..RW3-4 (flow-guard data-taint for children, steer/followUp routing, spawnChild, event tagging). Next: Wave 4 — forkable state.
- **2026-06-28** — **Wave 4 (forkable state) CLOSED.** L1 (3 rounds) + L2 (4 rounds) + L3 (2 phases) + F whole-project review **pass**. Added `Agent.snapshot()`/`restore()` (raw structuredClone of messages/usage + model/providerName/systemPrompt/thinking/step; restore throws while running, in-place #messages), a monotonic `#step` (reset in clear(), on turn_end/tool_end/tool_batch_end payloads), frozen tool-facing `handle.messages`, and the `AgentState` type. Server now isolates per-session conversational state + usage via snapshot/restore (fixes the lifetime-cumulative `done.usage` bug + model/prompt bleed). Test suite **967 pass** (+6), kernel 2023→2087 lines. Deferred RW4-1 (fork→Wave 8), RW4-2 (server capability/store bleed). Next: Wave 5 — reliability boundary.
- **2026-06-28** — **Wave 5 (reliability boundary) CLOSED.** L1 (3 rounds) + L2 (4 rounds) + L3 (3 phases) + F whole-project review **pass**. Added `StopReason` `refusal`/`content_filter` (mapped across all 3 providers), the `onProviderError` kernel filter seam (5th filter point; pre-commit-only retry/downshift, `MAX_PROVIDER_RETRIES=6`, default fail=true byte-identical), and a minimal off-by-default `reliability` extension (same-provider bounded backoff-retry + model downshift; conservative allowlist; never switches provider — a different axis from `fallback-routing`). Test suite **988 pass** (+21), kernel 2087→2144 lines (56 from the ceiling). Reconciled the four→five filter-hook count across CLAUDE.md/README/EXTENSIONS/ARCHITECTURE + 52→53 ext count + 2 source docstrings. Deferred RW5-1 (fallback-routing onto the seam). Next: Wave 6 — governance on new seams. **⚠ kernel headroom: 56 lines — Wave 6 must stay tight or refactor.**
