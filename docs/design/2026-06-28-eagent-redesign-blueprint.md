# EAgent First-Principles Re-Design Blueprint

**Date:** 2026-06-28
**Status:** L1 pre-step synthesis (strategy input; per-superpower L1 design docs follow once scope is chosen)
**Method:** code-as-truth audit (9 subagents reading source/tests only, ignoring docs/comments) ∥ external research (4 subagents: papers, OSS frameworks, industry engineering, superpower deep-dives) → first-principles synthesis → adversarial critique → main-agent verification of contested claims against source.

> This document treats **code as the only source of truth**. Every claim about EAgent's current
> behavior carries a `file:line` citation verified against source, not against comments or prose docs.

---

## 1. The irreducible first principles (critique-tightened)

The synthesis proposed nine "axioms"; the adversarial critique correctly showed only a handful are
truly irreducible — the rest are *engineering consequences* worth arguing, not axioms to assert. The
honest minimal set:

1. **An agent is a control loop over a stochastic, untrusted oracle.** Maintain STATE → ask the
   oracle for an ACTION → EXECUTE for an OBSERVATION → fold back → repeat to a terminal condition.
   The kernel's job is not to be smart; it is to be the *substrate on which smartness composes*.
2. **The kernel's only leverage is the quality of the boundary it puts around the oracle** — making
   the oracle's effects *observable, interceptable, reversible, and bounded*. The product is the
   boundary, not a feature count. (Merges the synthesis's "observability" + "boundary" axioms.)
3. **A small kernel is justified only if its primitives compose.** N extensions on one seam must
   combine predictably (order, veto, transform, isolation). Therefore: **deepen seams** (richer
   values threaded through *fewer* points) rather than add shallow one-off events.

Everything else — "exactly four seams," "state is an object," "three governance axes," "uniformity
across embeddings" — are **derivable design consequences**, not axioms. They are still useful, and
they still point at real work; they are just not first principles. The redesign is organized around
the consequences they imply:

- **The four request/response seams** (shape what the oracle SEES · interpret what it SAYS · mediate
  the ACTION · absorb the OBSERVATION). A seam that exposes a *partial* value caps every extension on it.
- **State as a first-class object** (snapshot/restore/fork) — the precondition for resume, time-travel,
  and deliberate search.
- **Three blast-radius axes** — AUTHORITY (capability), PROVENANCE (taint), REVERSIBILITY (checkpoint).
- **Uniformity across embeddings** — sub-agent, resumed session, forked branch, headless and
  interactive runs should be the *same governed loop*.

---

## 2. Current-state assessment (verified)

EAgent is **an exceptionally well-engineered ReAct executor with a best-in-class OBSERVE surface and
a strong-but-shallow INTERVENE surface.** It is at/beyond SOTA on minimalism (1,826 / 2,200 kernel
lines, mechanically enforced by `test/kernel-surface.test.ts`), capability gating
(`deny > grant > remembered > fallback > ask` with an audit log, `capabilities.ts:85`), tool-ordering
guarantees (`agent.ts:314-325`), transactional hot reload (`extension.ts:218-256`), and fully offline
determinism (`MockProvider` / `cassette`). Its observe surface — typed lifecycle events with
per-handler isolation (`hooks.ts:50-61`) and a wave-settled `tool_batch_end` — rivals OpenHands'
EventLog without the ceremony.

It is **behind SOTA on the deep primitives the field is built on**:

1. **Request-shaping seam is amputated.** `transformContext` reshapes only `Message[]` with
   `{turn,model}` context (`events.ts`), while the loop always ships the full registry tool list
   (`agent.ts:279`). Per-turn tool filtering, dynamic system prompts, model routing, prompt-cache
   control, and plan/act mode allowlists all ride **mutable `Agent` fields** (`Agent.model`,
   `forceTool`, `systemPrompt`) instead of a composable hook — so they cannot stack, and *no extension
   can withhold a tool from the model.*
2. **State is not a first-class object.** The transcript is a private array (`agent.ts:94`) exposed
   **live and mutable** through `handle.messages` despite a `readonly` type (`agent.ts:130-135`);
   `transformContext` folds run on a copy and are never written back (`agent.ts:271`). There is no
   `snapshot/restore/fork`. Resume is whole-transcript replay; time-travel / Tree-of-Thoughts /
   durable execution are *not ergonomic* (achievable today only via `agent.load()` of a copied
   transcript — ugly and lossy, **not "structurally impossible"** as the synthesis overstated).
3. **Sub-agents fork the kernel.** A child runs the same loop but on a **fresh `HookBus`**
   (`agent.ts:102`); subagents/teams/templates pass no hooks, so every filter-based guard
   (risk/content/secret/flow) silently does **not** apply to children, while the child still inherits
   the parent's tools and `allow` fallback. **HIGH-severity guard-bypass hole.** Child usage is
   discarded — fan-out cost is invisible and unbounded.

Security has structural escapes: `self:extend` and pkg-installed code receive raw `grantCapability`
(`extension.ts:233`), so one grant subsumes all capabilities; the host *pre-grants* `fs:write`
(`host.ts:199`) and capabilities are **coarse/type-level** — `fs:write` names no path, `shell:exec`
no command, and `#remembered` is keyed by capability string only (`capabilities.ts:63`). Injection
defenses are heuristic (a few hardcoded regexes; `mcp:call` missing from some egress/leak sets).
**No isolation exists**: all extensions run in-process via jiti, unsandboxed — the docstring admits
the capability layer is the only enforced boundary (`extension.ts:16-22`).

Net: **a superb chassis missing drivetrain depth.** Crucially, nearly every fix is *deepening an
existing seam* (richer request value, forkable state, scoped hooks, taint metadata) — squarely
on-bet for the small-kernel thesis, not a pile of features.

### 2.1 One synthesis claim corrected by source

The synthesis (echoing generic research advice) claimed the Anthropic provider sets **no**
`cache_control`, calling it "the single highest-ROI change (50-90% input cost unrealized)." **This is
false.** `anthropic.ts:58` defaults `cache: true` and lines 76-99 set **three** `cache_control:
{type:'ephemeral'}` breakpoints (last tool, system, last message). **Prompt caching is already
implemented and on by default.** The *real* gap is narrower and is observability/control:
`anthropic.ts:153-154` folds `cache_read_input_tokens` + `cache_creation_input_tokens` **into**
`inputTokens`, so caching is invisible to accounting and `cost.ts`/`budget-cap.ts` misprice cached
turns; and `cache` is a constructor option, not per-request controllable via `CompletionRequest`.
Phase 0 is reframed accordingly.

---

## 3. The superpower roadmap (critique-reconciled)

Eleven candidate improvements, dependency-ordered into phases. Each is a kernel **seam deepening** or
a capability-gated, kill-switched **extension** with an offline test — never a popular extension
promoted into core. Priority and scope reflect the adversarial critique's corrections.

### Phase 0 — Foundation & quick wins (days, near-zero architectural risk)

The regression net + cheap correctness/security/observability fixes that make every later kernel
edit safe. **The critique's #1 recommendation: build the CI gate FIRST.**

- **P0.1 — `BUILTIN_EXTENSIONS` CI gate + strict host.** A host test that loads the *real* exported
  set via `createAgentHost`, asserts `loaded-count == list-length`, and asserts no duplicate
  tool/command names; make activation failures observable instead of swallowed (`host.ts:236-242`).
  Today no test loads the canonical set; `integration.test.ts` hand-maintains a divergent 18-item
  list, so a refactor that silently drops dozens of extensions passes CI. **Prerequisite safety net
  for the whole program.**
- **P0.2 — Make caching observable & correctly priced** *(reframed; caching already on)*. Widen
  `Usage` (additive: `cacheReadTokens?`, `cacheWriteTokens?`, `reasoningTokens?`), stop folding cache
  reads into `inputTokens` (`anthropic.ts:153-154`), populate the fields in openai/gemini, and fix
  `cost.ts`/`budget-cap.ts` to price per-model and discount cached input. Optionally expose
  `cache`/sampling via `CompletionRequest`.
- **P0.3 — Unify egress/foreign/leak capability sets incl. `mcp:call`** (~5 lines, no kernel change).
  Closes the audited MCP-exfiltration bypass where flow/secret/content guards disagree on whether
  `mcp:call` is an egress sink.
- **P0.4 — Validator hardening + unconditional re-validate.** `validate.ts` ignores
  `additionalProperties:false`, min/max, pattern, and mis-coerces numeric enums — yet it is the gate
  before every `execute()`. Also re-validate `decided.arguments` unconditionally (`agent.ts:359`
  asymmetry).
- **P0.5 — Bounded parallel dispatch (concurrency cap).** `agent.ts:324` fires unbounded
  `Promise.all` over a wave; sweep-edit/subagents fan unboundedly → 429-storms. A kernel
  `maxConcurrency` is cheap, on-bet, and a precondition for the reasoning-search controller.

### Phase 1 — The keystone seams (the re-design spine)

- **P1.1 — `transformRequest` (kernel-change, M, low risk) — priority 95, the keystone.** One filter
  handing extensions the whole outbound `CompletionRequest` (systemPrompt, messages, tools, model,
  toolChoice, thinking) plus cumulative usage, right before the provider call. Unblocks model
  routing, per-turn tool masking (least-privilege to the model), dynamic prompt assembly,
  prompt-cache control, plan/act modes, progressive disclosure, and memory injection — *all
  compositionally, on one point.* Keep `transformContext` for back-compat (apply to `req.messages`
  first). ~50-70 kernel lines; pin the new export + default byte-identity. **The highest-leverage
  single change — most extensions unblocked per kernel line.**
- **P1.2 — Uniform governed sub-agents (hybrid, M, medium) — DECOUPLED from P1.3.** A child-scoped
  `HookBus` so guards/observers apply to children, plus usage bubbling to the parent. Closes the
  HIGH-severity guard-bypass hole; precondition for safe teams/search. The critique corrected the
  synthesis's false dependency on forkable state — *this needs only hook-scope inheritance + usage
  bubbling.* **Ship in the same early wave as P1.1.**
- **P1.3 — First-class snapshot/restore + step ids (kernel-change, M→L, medium).** `Agent.snapshot()`
  (structuredClone of messages/usage/model/etc.), `Agent.restore(s)`, a monotonic `#step` stamped on
  `tool_end`/`turn_end`, and a frozen `handle.messages` (fixes the live-mutable hole). The critique
  advises shipping snapshot/restore/step-ids in the kernel but leaving `fork()` composition to the
  extension layer unless a kernel consumer needs it. **Named consumer: per-session server Agent
  isolation** (`server.ts` shares one Agent across sessions — usage/store/audit/model bleed; the most
  direct violation of the uniformity consequence, nearly free once snapshot exists).
- **P1.4 — `onProviderError` repair seam + reliability extension + `StopReason` enrichment.** A
  stream-boundary filter (`{retry, downshiftModel?, fail}`) defaulting to `fail=true` (byte-identical
  today), so a transient 429/5xx can retry/downshift instead of ending the run (`agent.ts:251/308`).
  Reliability extension implements backoff+jitter+fallback-chain+circuit-breaker. Enrich `StopReason`
  with refusal/content_filter (all 3 providers currently collapse safety stops to generic `stop`).

### Phase 2 — Governance & reliability on the new seams

- **P2.1 — Provenance/taint as an extension convention** *(critique-corrected: NOT kernel
  derivation).* Bless an additive `ToolResult.provenance?` + `Message.meta.provenance`; an
  `afterToolCall` extension tags net/mcp/file results untrusted, a `beforeToolCall` guard escalates
  `allow→ask/deny` for privileged tools whose args derive from tainted content (CaMeL-lite, OWASP
  LLM01). Keep substring-matching domain logic in the *extension*, not the line-capped kernel.
- **P2.2 — `beforeDispatch` wave-level seam** (the genuine "fifth" point). Today the wave is
  observe-only (`tool_batch_end`); a `beforeDispatch` filter over `ToolCallBlock[]` lets extensions
  reorder/dedupe/drop/inject calls compositionally. On-bet (deepen, don't add features).
- **P2.3 — Tiered `ExecutionTarget` (extension-owned registry)** under bash/codeact so isolation
  strength tracks trust (local / gVisor / microVM), fail-**closed** when a backend is missing (fixes
  sandbox-tiers' fail-open). Real isolation is OS/VM-level — *not* an in-process JS sandbox.
- **P2.4 — Reasoning replay-fidelity fix.** OpenAI/Gemini drop reasoning from `done.message.content`;
  snapshot/restore would silently lose chain-of-thought on 2 of 3 providers. Make the persisted state
  lossless.

### Phase 3 — High-value capability extensions (pure extensions once the seams exist)

- **P3.1 — Event-sourced resume + time-travel** over P1.3: append-only JSONL event log (async,
  batched), `resume` (replay via `restore()`), `rewind <step>`, idempotent replay of completed tool
  calls. Replaces the brittle journal/session/checkpoint trio (the LangGraph/OpenHands/Cline baseline).
- **P3.2 — Tiered self-editing memory** (MemGPT/Letta + Generative-Agents scoring) over
  `transformRequest` + Store: core/archival/recall tiers, model-callable memory-edit tools, recency
  +importance+relevance retrieval, token-pressure paging/eviction, embeddings via an *optional*
  embed-provider in `ProviderRegistry` (no kernel dep). Off by default.
- **P3.3 — OTel GenAI observability exporter + offline evals-as-CI-gate.** Pure observer mapping
  lifecycle events to `gen_ai.*` spans (OTLP/HTTP via global fetch, no SDK); an evals CLI on
  `evals.ts` + cassette as a CI regression gate.

### Phase 4 — Advanced, opt-in, off by default

- **P4.1 — Reasoning-search controller (best-of-N / Tree / Graph of Thoughts)** on snapshot/fork +
  scoped hooks + concurrency cap. Makes the teams "patterns" (currently prompt-text only) real code.
- **P4.2 — Self-improvement harness (DGM/STaR-lite) — the moonshot, LAST.** Propose extension/skill
  mutation → evaluate in an **isolated** host using the offline test/eval suite as a *fitness
  function* → archive winners, discard losers. EAgent uniquely owns a deterministic offline fitness
  function — its strongest defensible edge. **Prerequisite: a RESTRICTED `ExtensionAPI`** for
  generated/installed code (omits raw `grantCapability`/`loadExtension`/`unloadExtension`), closing
  the `self.ts`/`packages.ts` privilege-escalation. Do **not** ship before that hardening + isolated
  eval host exist.

---

## 4. Anti-recommendations (protect the small-kernel bet)

- **No graph/workflow engine in the kernel.** The loop stays linear; branching/DAGs/search are
  extensions composed from snapshot/fork + scoped hooks.
- **No embeddings / vector DB / tokenizer as a runtime dep or kernel module** (zero-deps but jiti).
  Retrieval calls out via an optional embed-provider; the kernel keeps the `chars/4` estimate.
- **No multi-agent as a kernel primitive.** MAST/Cognition show naive multi-agent often *loses* to a
  single coherent agent at ~15× the token cost. Single-agent-first; teams/debate are opt-in extensions.
- **No auto-persisting context folds into the live transcript** — corrupts replay fidelity. Cache the
  fold; make state forkable; persistence is an explicit extension decision.
- **No in-process JS sandbox** for jiti extensions — security theater. Real isolation is OS/VM-level
  via `ExecutionTarget`, or state the trust boundary honestly and keep untrusted code out-of-process.
- **No speculative `StreamEvent` expansion** (note: a `tool_call` event already exists and is *unused*
  by the loop, `agent.ts:297-307` — the loop reads tool calls from the `done` message).
- **No tree-sitter for a repo-map** (breaches zero-deps); ship a lighter ctags/regex symbol extractor.
- **No CoALA memory taxonomy as kernel types** — keep Store an untyped namespaced KV; typing is an
  extension convention.
- **Don't promote popular extensions (compact/prune/routing/teams) into core.** The kernel grows only
  by deepening shared seams.

---

## 5. Decision required

The roadmap is large (11 items, one XL moonshot). The first formal **L1→L2→L3** build needs a chosen
scope. Recommendation: **Phase 0 foundation pack first** (the prerequisite safety net + cheap wins),
then the **Phase 1 keystone seams** (`transformRequest` + governed sub-agents in the same wave, then
snapshot/restore). See the question posed alongside this document.

---

## Appendix A — Standing on the shoulders of giants (research citations)

**Foundations:** ReAct (arxiv 2210.03629) · Reflexion (2303.11366) · Toolformer (2302.04761) ·
Voyager (2305.16291) · MemGPT (2310.08560) · CoALA (2309.02427) · Tree of Thoughts (2305.10601) ·
Generative Agents (2304.03442) · DSPy (2310.03714) · GEPA (2507.19457) · Zep temporal KG (2501.13956).

**OSS architecture:** OpenHands Agent SDK (2511.03690) & platform (2407.16741) · LangGraph interrupts/
checkpointing · OpenAI Agents SDK (handoffs, guardrails) · Letta/MemGPT memory blocks · Aider repo-map.

**Industry engineering:** Anthropic *Building Effective Agents* · *Effective context engineering* ·
Claude context-engineering cookbook · MCP spec (transports/resources/prompts/sampling) · *Breaking the
Protocol* MCP injection analysis (2601.17549) · Claude Code hooks/skills/subagents · Agent Skills
(SKILL.md, three-tier progressive disclosure) · OpenTelemetry GenAI semantic conventions.

## Appendix B — Provenance of this analysis

- Main-agent independent kernel read (agent/hooks/types/extension/registry/capabilities/host) +
  verification of the contested `cache_control` claim against `anthropic.ts`.
- 9 code-truth audit subagents (kernel-core, kernel-support+providers, sub-agent orchestration,
  memory/skills/self, security guards, context/cost/reliability, orchestration/control, IO/integration,
  wiring+tests).
- 4 research subagents (academic, OSS frameworks, industry engineering, superpower deep-dives).
- 1 synthesis + 1 adversarial critique (verdict: *adequate*; its corrections are folded in above).
