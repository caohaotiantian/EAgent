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
| ~~1~~ | **RESOLVED 2026-07-01** (`docs/design/2026-07-01-risk-guard-per-value-decode.md`). `risk-guard` now decode-normalizes each **string-leaf arg value** (not just the whole blob), so a rot13'd command hidden in one value (`{"cmd":"ez -es /"}` → `rm -rf /`) is surfaced to the judge — resolving the whole-blob asymmetry. A strict superset of the old candidates (deduped); off by default; `lib/decode.ts`/bash-policy untouched. The old "AC11 (negative)" asymmetry test is flipped to a positive per-value test. | — | — | — |
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

## Re-design Wave 3 (governed sub-agents) — deferred residuals

From `docs/design/2026-06-28-governed-subagents.md` (KDD-6, §3). `childScope` governs children via the
gate filters + intra-run events; these residuals need a deeper per-agent rework and are each their own
design. All are **strictly more** governance than the prior fresh-bus status quo — none is a regression.

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| RW3-1 | `flow-guard` **data-taint** does not fire for a child (read a sensitive file *without* `shell:exec`, then egress): the gate scans `e.agent.messages` = **parent** transcript (`flow-guard.ts:164`); a child's tagged message is in the child transcript. The **capability** trigger (shell:exec→egress) IS governed. | `docs/design/2026-06-28-governed-subagents.md` (§3, KDD-6) | M · M | Needs flow-guard to track data-taint in shared closure state (like the capability `tainted` Set), or per-agent guard state. |
| RW3-2 | `e.agent.handle.steer`/`followUp` **writes** route to the **parent** when a *child* triggers them (`circuit-breaker.ts:156` nudge, `budget-cap.ts:298`, `output-contract.ts:170`); `output-contract.ts:187` `e.agent.stop()` stops the parent. Hard guards still block the child's call; only the soft nudge/stop misroutes. | same (§3, KDD-6) | M · M | Part of the per-agent guard-state rework: guards should act on the *acting* agent (pass it in the hook context) rather than the closure's parent `e.agent`. |
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
| RW6b-1 | Consolidate `flow-guard`'s **data-taint** (sensitive-pattern → egress) into `provenance`'s source-taint model, so there is one taint mechanism instead of two overlapping ones. (Also would fold the Wave-3 RW3-1 child data-taint gap into provenance's already-child-governed closure store.) | `docs/design/2026-06-29-provenance-taint.md` (KDD-1) | M · M | The three guards occupy distinct axes today (ingress-label / pattern→egress / source→any-sink) and all work; consolidation is a separate refactor design once the provenance axis has proven out. Not a gap — a simplification opportunity. |

## Re-design Wave 6c (ExecutionTarget / codeact sandbox tier) — deferred residuals

From `docs/design/2026-06-29-execution-target.md` (§3, R6, L1 round-2 note).

| # | Residual | Home design | Effort · Risk | Why deferred / fix |
|---|---|---|---|---|
| RW6c-1 | A real **container/microVM backend** (gVisor/Firecracker/Kata/E2B) wired into `lib/sandbox`'s `detectBackend`/`wrapCommand` plug-in point. | `docs/design/2026-06-29-execution-target.md` (§3) | H · H | Needs deps + infra and is not zero-dep/offline-testable; the lib is the documented seam where a deployment adds one. The shipped OS-launcher tiers (`sandbox-exec`/`bwrap`/`firejail`) are the best-effort zero-dep layer. |
| RW6c-2 | A **`dir`-scoped** macOS `sandbox-exec` write profile for codeact (the current profile allows the whole `/private/tmp` + `/private/var/folders` tree). | same (R6) | M · M | The load-bearing guarantee (no home/project writes) holds; temp-wide write is ephemeral. Narrowing the profile when invoked from codeact is a refinement; `bwrap`/`firejail` are already `dir`-scoped. |
| RW6c-3 | A **real-host launcher smoke test** (`bwrap`/`sandbox-exec` actually present) before Wave 8 relies on the wrap end-to-end — the offline suite uses a forced backend + fake-launcher-on-PATH, never a real launcher. | same (L1 round-2 note) | S · M | The pure `wrapCommand` is unit-pinned and the integration is proven via a PATH shim; a one-time real-host smoke de-risks the bwrap `--tmpfs /tmp` + temp-dir-root interaction before self-improvement candidates depend on it. |
| RW8b-1 | **Real-evaluator integration test** for `self-improve` — the sandboxed candidate-eval subprocess (copy + `node_modules` symlink + real launcher + `runEvalDir`) is **integration-only / untested** (offline tests inject a stub via `setEvaluator`). | `docs/design/2026-06-29-self-improvement.md` (KDD-3, D4) | M · M | Offline CI can't spawn a real sandboxed `node --import tsx` subprocess against a real launcher deterministically; the state machine + veto + `ui.ask` gate are offline-pinned, the real path is honestly flagged. A real-host smoke (paired with RW6c-3) de-risks before reliance. |
| RW8b-2 | A **failed `loadExtension` after the staged→live `renameSync`** (adopt) leaves the candidate file in the live extensions dir, where it auto-loads on the next host restart **without** re-passing the `ui.ask` gate. | `docs/design/2026-06-29-self-improvement.md` (D5; closing review) | S · L | The human already approved it at adopt, so it is not an unreviewed load; but a clean fix moves the file back (or records `adopted:false` + skips it) on a load failure. Low-likelihood (load fails only transiently after a passing veto+eval). |
| ~~RW8a-1~~ | **RESOLVED 2026-06-30.** Both halves shipped: ToT as `tree_search` (multi-step beam search) and GoT as `graph_search` (generate → aggregate → refine), `docs/design/2026-06-30-tree-search.md` + `docs/design/2026-06-30-graph-of-thought.md`. | — | — | — |
| RW8a-3 | **GoT extensions** beyond `graph_search` v1 — a **configurable Graph-of-Operations DSL** (caller-composed operation sequence), **multi-round iterative refinement** (refine→score→refine to convergence), and **cross-tool composition** (`tree_search` feeding `graph_search`). | `docs/design/2026-06-30-graph-of-thought.md` (§3, KDD-2) | L–H · M | v1 is a fixed single-pass pipeline by design (Simplicity First); each extension is its own larger design once the fixed pipeline proves out. |
| RW8a-2 | **Early goal-termination** in `tree_search` — v1 always runs to `depth`; a goal-threshold (or classifier) that stops once a thought scores above a bar would cut cost on easy problems. | `docs/design/2026-06-30-tree-search.md` (R5, KDD-5) | S–M · L | v1's termination is purely depth-bounded by design (KDD-5); the global best-so-far is already tracked, so an early-exit is additive. |
| RW7d-1 | **Broaden the committed eval-fixture set** beyond the initial 2 (`evals/`), and (paired with DEFERRED #5) add statistical pass@k. The CI gate is real but thin — more scenarios = more regression coverage. | `docs/design/2026-06-29-evals-ci.md` (D5, §3) | S–M · L | The gate + reuse mechanism is the deliverable; fixture breadth grows incrementally as behaviors are pinned. Statistical pass@k is the `evals` design's own deferral (#5). |
| ~~RW7c-1~~ | **RESOLVED 2026-06-30.** `otel-exporter` now emits all three OTLP signals — traces + **metrics** (`/v1/metrics`: `eagent.gen_ai.token.usage` + `eagent.tool.calls` cumulative Sums) + **logs** (`/v1/logs`: metadata-only error/outcome records, trace-correlated). `docs/design/2026-06-30-otlp-metrics-logs.md`. | — | — | — |
| ~~RW7c-4~~ | **RESOLVED 2026-07-01** (Wave C). otel-exporter now emits the OTel GenAI semconv Histogram `eagent.gen_ai.client.operation.duration` (per-call inference latency, the published advisory buckets, no config) alongside the two Sums. `docs/design/2026-07-01-otel-operation-duration-histogram.md`. | — | — | — |
| RW7c-2 | **Distributed-context propagation** — inject `traceparent` into outbound tool HTTP so EAgent traces link to downstream services. | `docs/design/2026-06-29-otel-exporter.md` (§3) | M · M | v1 emits its own root traces; cross-service propagation needs a tool-HTTP injection seam, its own design. |
| RW7c-3 | **Real-collector smoke** — the offline suite stubs `fetch`/asserts the OTLP body shape; a one-time smoke against a live Jaeger/Tempo/OTLP collector validates the wire end-to-end. | `docs/design/2026-06-29-otel-exporter.md` (R2) | S · M | Offline can't validate a live backend; the body shape is unit-pinned, but a real-collector smoke de-risks before production reliance. |
| ~~RW7b-1~~ | **RESOLVED 2026-07-01.** Optional **semantic (embedding)** recall for `memory`: an injectable `Embedder` (`setEmbedder`) + a `fetch`-based real embedder from `EAGENT_MEMORY_EMBED_ENDPOINT`, embed-on-recall cosine ranking, **off by default → lexical byte-identical**, **fail-soft** to lexical, `EAGENT_MEMORY_EMBED=off` kill switch. `docs/design/2026-07-01-semantic-memory-recall.md`. **The "forbidden by the zero-dep rule" premise was wrong** — the chat providers already do zero-dep `fetch`, so a fetch embedder + a deterministic mock is feasible offline (no kernel change). | — | — | — |
| RW7b-2 | An **archive-scoped `forget`** (delete an archived note in one step). | `docs/design/2026-06-29-tiered-memory.md` (§3) | S · L | v1 deletes an archived note via `/memory promote` then `/memory forget` (two steps); a direct archive-forget is a small follow-up. |
| ~~RW7b-3~~ | **RESOLVED 2026-07-01** (`docs/design/2026-07-01-memory-auto-promotion.md`). `recall` bumps each returned archive note's `recalls` count and auto-promotes it to core at `EAGENT_MEMORY_PROMOTE_AT` (the operator-chosen relevance-trigger policy); **default off** (unset/0) ⇒ byte-identical read-only recall. Additive `Entry.recalls?` (no migration). | — | — | — |
| RW7a-1 | **Delta/incremental blob** storage for checkpoint nodes (each node stores a full `AgentState`, so a deep tree duplicates the growing transcript). | `docs/design/2026-06-29-time-travel.md` (§3) | M · M | The FIFO cap bounds disk today; delta storage (store only the message diff vs parent) is an optimization, not a correctness need. Deferred until disk pressure is real. |
| RW7a-3 | Command polish (F-review): `/rewind`/`/fork` don't re-check the `enabled` flag (so enable→create→disable→`/fork` would still write a node — harmless in the shipped-off default since no nodes exist); and an ambiguous-step selector prints both `resolve()`'s "ambiguous step" line and the caller's "no such checkpoint" line. | `docs/design/2026-06-29-time-travel.md` (F review) | S · L | Cosmetic; off-by-default makes it inert in practice. A one-line `enabled` guard on fork + suppressing the caller's second message; not worth churning merged code for an edge. |
| RW7a-2 | **Unify conversation rewind with workspace rollback** — `/rewind` restores agent state only; files are `checkpoint.ts`'s `/rollback`. A combined "rewind to step N AND roll the workspace back" needs an id-alignment design between the two extensions. | `docs/design/2026-06-29-time-travel.md` (KDD-5) | M · M | Coupling two extensions is fragile (git may be absent; step-ids ≠ workspace-checkpoint-ids). Documented; operator pairs them manually. A later design can align them. |
| RW6d-1 | A **reasoning-only** assistant turn (reasoning streamed, no text, no tool call — e.g. `max_tokens` mid-thought) now persists `content:[{thinking}]`; on replay the unsigned thinking block is dropped, leaving OpenAI `content:null` (its existing text-less shape) and **Gemini `parts:[]`** (which the API may reject). | `docs/design/2026-06-29-reasoning-fidelity.md` (R4) | S · L | Low likelihood (requires snapshotting a truncated thinking-only turn then continuing). Fix: a "drop an assistant message whose replay yields empty content" guard in the builders, if it ever bites. Left unguarded in the Light fix. |
| RW6c-4 | codeact `tier=readonly` is **non-functional on the `bwrap` backend**: `wrapCommand`'s bwrap branch mounts `--tmpfs /tmp` and only re-binds the writable root for *write* tiers, so the snippet (under `os.tmpdir()` = `/tmp` on Linux) is shadowed and the interpreter gets ENOENT. Fails **closed** (errors, no bypass); macOS `sandbox-exec` + Linux `firejail` are unaffected; codeact's recommended tiers (`workspace-write`/`no-network`) bind the dir and work. | `docs/design/2026-06-29-execution-target.md` (F review) | M · M | Fix needs a **read-only** bind of the per-call dir for non-write tiers — a `wrapCommand` contract extension (a readonly-bind param) that must not loosen the *shell* readonly tier. Deferred to a focused change; README notes the degradation. |

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
| RW9-1 | **otel last-batch hard-exit flush** — `session_shutdown` now awaits `flush()`, but `agent_end`'s eager `void flush()` usually drains the buffer first, so the last run's batch still rides the unawaited `agent_end` POST and can be cut by an immediate `process.exit`. | `otel-exporter.ts` (F-review G1) | S · L | Telemetry-only, best-effort by design; closing the window fully needs an awaited per-run flush or a shutdown drain barrier. |
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

**Still deferred (verified infeasible or intentional Simplicity-First cut — unchanged):** the audit
confirmed these stay deferred — they break the zero-dep / offline-testable / tiny-seam constraints or
have no current consumer: **RW6c-1** (container backend),
**RW7c-2** (traceparent propagation — needs a new tool-HTTP egress seam), **RW7c-3** (live-collector
smoke — un-offline-testable), **RW7a-1/2** (delta blobs, rewind↔workspace unification), **RW6a-1/2**,
**RW3-3/4**, **RW4-1/2**, **RW5-1**, **RW6b-1**, **RW8a-3** (GoT DSL/multi-round), **RW9-2/3**, and the six
top "correctly cut" items (`DEFERRED-1..6`). Building these would spend kernel headroom on no-consumer
seams or violate the zero-dep/offline posture. (**KR-1**, the one new finding registered above, was
subsequently **resolved 2026-07-01** on `chore/finish-followups-2`.)
