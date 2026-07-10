# Design — Provider honesty & resilience (Batch A)

Slug: `2026-07-10-provider-honesty`
Status: closed
Closing-commit: Batch A closeout on `chore/production-hardening` (code commits `653175c`/`8383484`/`fa7aa1c` + closeout)
Closed-on: 2026-07-10
Deferred: finding — Gemini mid-stream error wire-shape live-backend smoke (R5; Anthropic doc-verified, Gemini detection offline-tested; no repo issue tracker — tracked in the PR); finding — `systemText` helper duplicated per-file in anthropic/gemini (trivial, matches the per-file provider-helper convention).

## 1. Background and Purpose

EAgent's three real providers (Anthropic — the default — OpenAI, Gemini) are hand-rolled
`fetch`+SSE mappers. Two source-verified defects make the **default stack behave dishonestly**,
and one gap blocks a real deployment.

### A1 — injected `system` notes are silently discarded on the default stack

Many extensions steer the model by injecting a `role:"system"` message into the transcript on the
`transformContext` seam. The Anthropic serializer drops them
(`src/providers/anthropic.ts:256-257` `for (const m of messages) { if (m.role === "system")
continue; // carried via top-level system`) and Gemini drops them identically
(`src/providers/gemini.ts:182-183` `if (m.role === "system") continue;`). Only OpenAI preserves
them (`src/providers/openai.ts:197-201` pushes `{ role: "system", content: textOf(m) }`).

The **true set of in-transcript `role:"system"` injectors** (verified by grep + reading each
`transformContext` hook) is **ten `transformContext` injectors** (plus `session.ts`, which carries
system content via a distinct mechanism, not a per-turn `transformContext` inject), not "six":

| Extension | Injected content | Size / stability | Default on? |
| --- | --- | --- | --- |
| `context-files.ts:71-91` | project AGENTS.md/CLAUDE.md context | **large, stable per session** | yes (unconditional) |
| `skills.ts:44-59` | skill catalog (name+description) | **large-ish, stable** | yes (unconditional) |
| `compact.ts:227` | compaction summary (`text("system", summaryText)`) | **large, changes on compaction** | yes |
| `goal.ts:364` | objective pin | small, stable-ish | yes (`default:true`) |
| `drift-probe.ts:327` | one-shot anti-drift note | small, one-shot | off by default |
| `playbook.ts:156` | ordered bullet playbook | small–medium, changes on merge | off by default |
| `microagents.ts` | matched micro-agent guidance | small, conditional | yes (`default:true`) |
| `templates.ts` | template guidance | small | yes (`default:true`) |
| `config-hooks.ts` | config-driven notes | small | conditional |
| `handoff.ts` | handoff summary | medium | conditional |
| `session.ts` | (system content, not a per-turn transformContext inject) | n/a | — |

Consequence: on Anthropic (the **default** provider) and Gemini, the entire context-injection
layer — including the project's own CLAUDE.md/AGENTS.md context (`context-files`) and the skill
catalog (`skills`) — is **dark**: the content is never sent to the model. Only OpenAI users get it.
No test catches this because `MockProvider` ignores message content.

### A2 — a mid-stream API error is turned into a truncated success

Each provider yields its `done` event *unconditionally after* the SSE loop ends
(`src/providers/anthropic.ts:215`; `openai.ts:172`; `gemini.ts:151` — all outside the `for await`).
None has a branch for a mid-stream `error` frame (`anthropic.ts:147-193` switch = only
`message_start`/`content_block_*`/`message_delta` + `default: break`; `openai.ts:107-151` and
`gemini.ts:99-138` if-chains have no `error` branch; none types an error variant). An
`overloaded_error`/rate-limit-after-start frame is parsed, ignored, the connection closes, the loop
ends, and the provider still yields `done` with partial content. The agent loop treats an outage as
a **successful short answer** — no error, no `onProviderError`, no retry, no telemetry.

### A4 — output length is not configurable

`max_tokens` is a hardcoded constructor default `opts.maxTokens ?? 4096` in all three
(`anthropic.ts:55`, `openai.ts:55`, `gemini.ts:46`), and `src/host.ts:214-216` constructs each
provider passing only `baseUrl` — never `maxTokens`. A deployment cannot lengthen outputs, and
`--thinking high` (thinking counts against the cap on Anthropic; Gemini requests a 24576 thinking
budget under a 4096 output cap) collides with 4096 → truncation or API rejection.

(There is no "A3" deliverable: an earlier idea to add a `MockProvider` throw affordance was
dropped as redundant — the loop's handling of a thrown provider error is already tested; see the
Scope Boundary. The A-numbering keeps A1/A2/A4 for continuity with the batch brief.)

If we do nothing: the context layer stays dark on the default provider; production outages read as
success (silent data loss, wrong answers surfaced confidently); and outputs can't be tuned.

## 2. Deliverables

- [ ] **D1** — Anthropic serializer folds in-transcript `role:"system"` messages into the top-level
      `system` block (content preserved; existing prompt-caching unchanged; empty-`systemPrompt`
      edge handled).
- [ ] **D2** — Gemini serializer folds in-transcript `role:"system"` messages into the top-level
      `systemInstruction.parts` (synthesizes `systemInstruction` from notes even when `systemPrompt`
      is absent).
- [ ] **D3** — Anthropic stream loop detects the `error` frame (`parsed.type === "error"`) and throws.
- [ ] **D4** — OpenAI stream loop detects the `error` frame (top-level `error` object) and throws.
- [ ] **D5** — Gemini stream loop detects the `error` frame (top-level `error` object) and throws.
- [ ] **D6** — Extract an exported `buildProviders(config, opts?)` in `host.ts` that wires
      `providers.<name>.maxTokens` from `e.config` (default 4096) into each provider constructor;
      `host.ts` calls it; add `ANTHROPIC_MAX_TOKENS`/`OPENAI_MAX_TOKENS`/`GEMINI_MAX_TOKENS` aliases
      to `ENV_ALIASES`.
- [ ] **D7** — Offline tests: (a) cross-provider system-fold survival + the empty-`systemPrompt`
      case; (b) caching-preserved (no-note path byte-identical, note path keeps cache_control on the
      systemPrompt block only); (c) per-provider mid-stream-error throw (post- and pre-commit
      positions); (d) `max_tokens` wiring via `buildProviders`. Each behavioral test RED before its
      fix, GREEN after.

## 3. Scope Boundary (NOT in scope)

- **No kernel change.** `src/kernel/*.ts` is untouched; A2 reuses the existing `committed` boundary
  (`agent.ts:419-433`) — a throw with `committed===false` reaches `onProviderError`, else it is
  rethrown. No new `StreamEvent` type. `buildProviders` lives in `host.ts` (not kernel), and does
  not alter the kernel-surface pin.
- **No Provider-interface / `CompletionRequest` change.** `max_tokens` stays a construction-time
  provider option; a per-request override is explicitly out of scope.
- **No MockProvider changes.** The loop's handling of a *thrown* provider error is pre-existing and
  already tested (`agent.test.ts:853` pre-commit rethrow, `:873` pre-commit retry, `:936`
  post-commit not-retried); A2 only needs each provider to *throw*, which is tested directly through
  each provider's `stream()` with an injected `fetch` (no MockProvider surface needed).
- **No per-tool/per-step/per-chunk timeout budgets, no watchdog, no `AbortSignal` plumbing changes**
  — that is Batch D.
- **Byte-identical cross-provider serialization is NOT a goal.** OpenAI keeps a system note at its
  transcript position; Anthropic/Gemini fold to the top-level system channel (position lost,
  **content preserved**). Only content-preservation is guaranteed.
- **Per-note-type caching optimization is out of scope** (see KDD2): the provider cannot distinguish
  a stable note (`context-files`) from a volatile one (`compact` summary), so this batch appends all
  folded notes uncached. A future optimization may cache large stable folded blocks; it is a named
  follow-up, not part of this correctness fix.
- **No change to the eleven injecting extensions, to `onProviderError`, retry policy, or
  `reliability`.** The bug is provider-side; A2 only makes the error *reach* the existing mechanisms.

## 4. Key Design Decisions

### KDD1 — How to preserve in-transcript `system` messages on Anthropic/Gemini
- **Problem:** Anthropic/Gemini have a single top-level system channel and no positional system role
  inside the message array, so an in-transcript `role:"system"` message has nowhere to go and is
  dropped.
- **Options:** (A) fold into the top-level system channel; (B) rewrite each as an inline
  `role:"user"` message with a `[system]` prefix at its transcript position; (C) change the eleven
  extensions to inject as a non-system role.
- **Choice: (A).** The top-level system channel is the provider-sanctioned home for standing
  instructions and maximizes salience; it fixes all eleven extensions with a two-file provider-edge
  change and no extension edits, bringing Anthropic/Gemini to parity with OpenAI's existing
  behavior. **Reject (B):** demoting a system instruction to `user` lowers its authority (models
  weight user text below system) and pollutes the transcript. **Reject (C):** touches eleven
  extensions (large blast radius) to work around a provider bug OpenAI already handles correctly —
  the fix belongs at the broken edge.
- Text extraction: concatenate a system message's `type:"text"` blocks (mirrors `openai.ts:239-244`
  `textOf`). Multiple notes are folded in transcript (iteration) order.

### KDD2 — Ordering, caching, and the empty-`systemPrompt` edge
- **Problem:** Anthropic marks `systemPrompt` with `cache_control: ephemeral`
  (`anthropic.ts:80-84`, a one-element block array). Folded notes include **large stable** blocks
  (`context-files`, `skills`) and **large changing** ones (`compact` summary). How to order/cache
  without (a) regressing the existing systemPrompt cache or (b) busting the cache every turn on a
  changing note; and what to do when there is no base `systemPrompt` but notes exist.
- **Caching options:** (A) keep `cache_control` **only** on the `systemPrompt` block (unchanged),
  append all note blocks **uncached** after it; (B) add a second cache breakpoint at the end of the
  folded notes; (C) mark every block cacheable.
- **Choice: (A).** Anthropic caches the prefix up to and including the block bearing `cache_control`;
  a block appended *after* that breakpoint is sent fresh but does **not** invalidate the cached
  prefix. So keeping the breakpoint on `systemPrompt` guarantees **zero regression** to the existing
  systemPrompt cache, while the notes reach the model. **Reject (B):** the provider cannot tell a
  stable note from a volatile one; a volatile note (compact summary, goal pin) at/inside the second
  breakpoint busts that cache prefix every turn — and worse, if a volatile note is folded *before* a
  stable one, it would also bust the stable one. A correct per-note breakpoint needs note-stability
  metadata the provider does not have → deferred (Scope Boundary). **Reject (C):** marking changing
  notes cacheable writes a new cache entry every turn, strictly increasing cost.
- **Cost analysis (the reviewer's concern):** relative to **today**, folding is strictly more
  correct — on Anthropic these notes are currently sent **zero** times (dropped), so the model never
  sees project context or the skill catalog. Folding sends them (uncached), reaching parity with
  OpenAI, which already sends them every turn. The per-request token increase is the *intended*
  behavior of enabling those extensions; it is not a regression versus a working baseline, because
  there is no working Anthropic baseline today. The uncached re-send of large stable blocks is the
  known cost of the minimal correctness fix; caching them is the deferred optimization above.
- **No-note path is byte-identical (the common path).** When the transcript has **no**
  `role:"system"` message, both serializers run their current code verbatim — including Anthropic
  sending `system: ""` when `req.systemPrompt` is empty (`anthropic.ts:80-83` else-branch → `:104`),
  and Gemini omitting `systemInstruction`. The fold logic engages *only* when ≥1 note is present.
- **Note-present shape (never emit an empty `{type:"text",text:""}` block):**
  - Anthropic: `system` becomes `[systemPrompt-block?, ...note-blocks]` — the systemPrompt block is
    included only when `req.systemPrompt` is non-empty (carrying `cache_control` iff caching on), and
    each note block is appended **uncached**. So a note with an empty base prompt yields an array of
    note blocks only (no empty leading block).
  - Gemini: `systemInstruction.parts` = `[systemPrompt-part?, ...note-parts]`, and
    `systemInstruction` is set whenever that array is non-empty — synthesizing it from notes even
    when `req.systemPrompt` is absent (today it is set only `if (req.systemPrompt)` — `gemini.ts:72`).
- **Conversation-cache interaction (bounded, inherent).** Beyond the systemPrompt breakpoint,
  `anthropic.ts:90-99` places a third `cache_control` breakpoint on the last content block of the
  last message (the growing-conversation cache). Folded notes sit in the top-level `system` block,
  which precedes `messages` in Anthropic's cache-prefix order, so a note whose content **changes
  between turns** (`compact` summary on compaction, `playbook` on merge, `goal` pin on edit)
  invalidates that conversation-cache prefix on the turns it changes. This is **inherent and
  unavoidable** — a changing standing instruction must precede the messages, and today it is simply
  dropped instead — and **bounded** (only the turns a note actually changes; stable notes like
  `context-files`/`skills` never trigger it). AC3 therefore verifies the `system` *payload shape*
  (breakpoint kept on the first block, notes uncached), not this conversation-cache behavior, which
  is asserted here as a documented, accepted cost.

### KDD3 — How to surface a mid-stream error frame
- **Problem:** the parsed error frame is currently ignored and the loop fabricates a `done`.
- **Options:** (A) detect the frame and `throw` inside the stream loop; (B) yield a synthetic `done`
  with an error `stopReason`; (C) add a new `error` `StreamEvent` type handled in the kernel loop.
- **Choice: (A).** Throwing reuses the tested `streamTurn` error path (`agent.ts:419-433`; verified
  by `agent.test.ts:853/873/936`) with zero kernel change: `committed===false` (error before any
  yielded event) → offered to `onProviderError` (retryable); `committed===true` (error after a
  delta) → rethrown as `reason:error`. **Reject (B):** a `done` is "success" to the loop — it *is*
  the bug; `stopReason` has no error variant. **Reject (C):** a new kernel `StreamEvent`+branch
  violates the minimal-core bet and the no-kernel-change scope, and is unnecessary.
- **Verbatim-sourced frame shapes:**
  - **Anthropic** (official docs, "Error events", platform.claude.com/docs/en/build-with-claude/streaming):
    `event: error` / `data: {"type": "error", "error": {"type": "overloaded_error", "message":
    "Overloaded"}}`. The provider switches on `parsed.type`, so `case "error": throw` matches
    exactly; `overloaded_error` (HTTP 529 analogue) and other API error types can appear mid-stream.
  - **OpenAI:** a mid-stream SSE frame carrying a top-level `error` object `{"error":{"message":..,
    "type":..,"code":..}}`. Detection: after `JSON.parse`, `if (parsed.error) throw`. (Sourced from
    the OpenAI streaming error convention; `OpenAIChunk` gains an optional `error?` field.)
  - **Gemini:** `streamGenerateContent?alt=sse` may deliver an error as a top-level `error` object
    `{"error":{"code":..,"message":..,"status":..}}`. Detection: `if (parsed.error) throw`.
    **Residual risk (deferred follow-up):** Gemini's exact SSE error framing is the least
    documented; a live-backend smoke to confirm the wire shape is a deferred follow-up (offline
    tests validate the detection against the modeled shape; see R5). Detection is written to catch a
    top-level `error` object regardless of surrounding array framing.
- The thrown `Error` message includes the provider name and the API error `type`/`message` so
  `reliability`/logs can classify it.

### KDD4 — `max_tokens` configurability, made offline-testable
- **Problem:** output cap is hardcoded; the host never overrides it; and the production wiring line
  (`new AnthropicProvider({...})` in `host.ts`) is not offline-testable as-is (offline there is no
  API key, so `createAgentHost` never registers the real provider — it selects `mock`).
- **Options:** (A) extract an exported `buildProviders(config, opts?: {fetch?})` from `host.ts`,
  have `host.ts` call it, and unit-test the *same function* with a stub `fetch` + config override;
  (B) add a `fetch`/provider-factory seam to `createAgentHost` and drive it end-to-end; (C) test the
  two halves (config key, provider option) separately.
- **Choice: (A).** `buildProviders` exercises the **exact** construction code the host uses (not a
  copy), is offline-runnable (pass a stub `fetch` and a config with `providers.anthropic.maxTokens`
  set + a test key), and is a small honest refactor that also improves host testability. **Reject
  (B):** a full host fetch seam is larger scope than A4 needs (Simplicity First). **Reject (C):**
  testing config and the provider option separately never proves the host *composes* them — the
  exact defect class the reviewer flagged.
- The constructor option already exists on all three providers; default stays 4096, preserving
  behavior. Env derivation is automatic (`EAGENT_PROVIDERS_ANTHROPIC_MAX_TOKENS`); short aliases are
  added for symmetry with the existing `*_BASE_URL`/`*_MODEL` aliases.

## 5. Dependencies and Assumptions

- **Config facility** (`src/config.ts`, injected `e.config`): `int(key, fallback)` resolves
  `override > env > file > default`; `host.ts:214-216`/`:233-241` already read config to build
  providers. See `docs/design/2026-07-07-centralized-config.md`.
- **Committed boundary** (`agent.ts:401-433`): the first yielded event of any type flips
  `committed`; usage accrues only on a fully-consumed stream (`agent.ts:435`), so a mid-stream throw
  cannot double-count usage. `MAX_PROVIDER_RETRIES = 6` (`agent.ts:72`).
- **A mid-stream throw cannot strand a half-paired tool call** — but *not* because tool_calls are
  post-loop (Gemini actually yields `tool_call` **inside** its SSE loop at `gemini.ts:134`; only
  Anthropic `:211` and OpenAI `:169` yield post-loop). The real safety comes from the transcript
  structure: the assistant message is appended only when `streamTurn` returns a **`done`-derived**
  message (`agent.ts:252`), and the dispatched tool-call wave is filtered from
  `assistant.message.content` (`agent.ts:255-257`), never from the stream's mid-flight `tool_call`
  events. A pre-`done` throw skips `:252` (control jumps to the catch at `agent.ts:333`), so nothing
  is appended and nothing is dispatched — regardless of whether a `tool_call` event was already
  yielded in-loop.
- **`text()` helper** (`types.ts:87`) produces `{ role, content: [{ type:"text", text }] }`.
- **Anthropic `system` accepts a string or an array of text blocks** (optional per-block
  `cache_control`) — the array form used for the folded case is a valid documented shape.
- **Test harness:** each provider test injects `fetch` and asserts on the captured request body or
  the parsed `StreamEvent`s (`test/{anthropic,openai,gemini}.test.ts`); Anthropic's SSE builder
  emits `event:` lines, OpenAI/Gemini use bare `data:` frames. No network, no API key.
- **Measured baseline (this branch):** `npm test` = 1276 tests, 1275 pass, 0 fail, 1 skip;
  `npm run typecheck` exit 0; `npm run eval` 5/5; `npm run build` exit 0.

## 6. Relationship with Existing Designs

- `docs/design/2026-07-07-centralized-config.md` — the `e.config` facility A4 reads; no conflict
  (A4 adds two provider keys following the documented precedence/env derivation).
- `docs/design/2026-07-09-playbook-extension.md`, and `context-files`/`skills`/`goal`/`drift-probe`
  (no design docs) — the consumers whose `role:"system"` injections A1 rescues; no conflict, this
  batch makes their documented mechanism work on Anthropic/Gemini. No warning markers required.
- No prior provider design doc exists; terminology anchors are `CLAUDE.md` and `README.md`.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (A1):** a test builds a request whose `messages` include a `role:"system"` message with text
  `"PIN-<marker>"`; after `stream()` (fetch-capture stub), the Anthropic request body contains
  `"PIN-<marker>"` inside `system`, the Gemini body inside `systemInstruction.parts`, and the OpenAI
  body inside `messages` (regression pin). Includes an **empty-`systemPrompt`-with-note** case
  asserting no empty text block/part is emitted and the note still survives. RED on Anthropic+Gemini
  before D1/D2. Command: `node --import tsx --test test/provider-system-fold.test.ts`.
- **AC2 (A2):** for each provider, a test streams `[one content delta, an error frame, close]` and
  asserts `provider.stream()` **throws** (does not yield `done`); a second case with the error frame
  **before** any content asserts it throws. RED before D3/D4/D5. Command:
  `node --import tsx --test test/provider-stream-error.test.ts`.
- **AC3 (caching preserved):** with caching on and **no** in-transcript system message, the Anthropic
  `system` payload equals today's one-element `cache_control` **array** `[{type:"text",text,
  cache_control}]` (byte-identical to `anthropic.ts:82`); with a note present, `system` is an array
  whose first block retains `cache_control` and whose note block(s) carry none. Command: same file as
  AC1.
- **AC4 (A4):** a test sets `process.env.ANTHROPIC_API_KEY` to a dummy value (the constructor reads
  it at `anthropic.ts:52`, and it is restored in a `finally`), then calls `buildProviders(config,
  {fetch})` with a config override `providers.anthropic.maxTokens = 8000` and asserts the captured
  Anthropic request body carries `max_tokens: 8000`; with no override it carries `4096`. This runs
  the exact construction code `host.ts` uses (not a copy). Command:
  `node --import tsx --test test/provider-max-tokens.test.ts`.
- **AC5 (gates / no regression):** `npm test` exits 0 with **1275 prior tests still passing, 0 fail**
  (plus the new D7 tests green); `npm run typecheck` exits 0; `npm run eval` reports 5/5; `npm run
  build` exits 0. A pre-flight check confirms no existing `test/{anthropic,gemini}.test.ts` asserts
  the *drop* of an in-transcript system message (D1/D2 flip that behavior).

## 8. Risks and Rollback

- **R1 — throwing on error frames converts a former (fake) success into a real error.** Intended:
  pre-commit errors retry via `onProviderError`, post-commit rethrow as today. Residual risk: a
  benign frame misclassified as fatal. Mitigation: only the documented terminal shapes are matched
  (`type==="error"` / a top-level `error` object); partial/`ping`/unknown frames keep
  `default`/`continue`. Rollback: revert D3–D5 (isolated, no kernel coupling).
- **R2 — folding could bust Anthropic prompt caching.** The **systemPrompt cache** is fully
  preserved (KDD2 Option A: breakpoint stays on the systemPrompt block; notes appended after it,
  uncached; no-note path byte-identical). The **conversation cache** (third breakpoint,
  `anthropic.ts:90-99`) is invalidated on turns a folded note *changes* — a bounded, inherent cost
  documented and accepted in KDD2 (a changing standing instruction must precede the messages; today
  it is dropped entirely). Rollback: revert D1.
- **R3 — max_tokens default drift.** Default stays 4096; behavior changes only when configured; AC4
  pins the default. Rollback: revert D6 (host-only).
- **R4 — `buildProviders` extraction changes host construction.** It is a pure move of the existing
  construction lines plus the new `maxTokens` read; `host.ts` behavior is otherwise identical, and
  the extraction is covered by AC4. Rollback: inline it back.
- **R5 — Gemini mid-stream error wire shape uncertainty.** Offline tests validate detection against
  the modeled top-level `error` shape; a live-backend smoke confirming Gemini's exact SSE error
  framing is a deferred follow-up (does not block this batch; Anthropic — the default — is
  doc-verified). If the real shape differs, D5 detection is a localized one-line adjust.
- **R6 — large folded blocks increase per-request tokens on Anthropic/Gemini.** This brings them to
  OpenAI parity for content the user explicitly enabled; not a regression versus a working baseline
  (there is none today). Per-note caching is the deferred optimization.
- **Overall rollback:** every change is provider-layer + host + tests, each deliverable
  independently revertible; the branch is `chore/production-hardening`, PR-gated, not merged to
  `init` without review.
