# Design: incremental conversation prompt-caching for the Anthropic provider

Status: closed
Closing-commit: c548e65
Closed-on: 2026-06-20
Deferred: none
Slug: `2026-06-20-incremental-prompt-cache`

## 1. Background and Purpose

EAgent's Anthropic provider already does prompt caching, but only of the
**static** prefix: it marks the system prompt and the last tool definition
`cache_control: {type:"ephemeral"}` (`src/providers/anthropic.ts:76-82`). The
**conversation history** — which grows every turn and is by far the largest
part of a long agentic run's input — is never marked, so Anthropic re-reads and
re-bills the entire message list at full input price on every turn.

The upstream project [opencode](https://github.com/anomalyco/opencode) caches
the conversation too: its cache policy (`packages/llm/src/cache-policy.ts`)
places a third breakpoint at the **latest user message**, so each turn writes a
cache entry extending the previous one and subsequent turns read the prior
prefix at ~0.1× cost ("incremental caching"). The Anthropic prompt-caching
guidance confirms this is the canonical multi-turn pattern: "Put a breakpoint on
the last content block of the most-recently-appended turn. Each subsequent
request reuses the entire prior conversation prefix … hits accrue incrementally
as the conversation grows."

This task adds that one breakpoint to EAgent's Anthropic provider. With a system
breakpoint (1) and a tool breakpoint (1) already in place, adding a message
breakpoint (1) totals **3 of the 4** breakpoints Anthropic allows. For a
multi-turn or tool-heavy session this turns the entire prior transcript from
full-price input into cache reads — a large, direct cost and latency reduction.

If we do not do this, every turn of every Anthropic session re-bills the full
growing history at 1× input, which on long agentic runs is the dominant cost.

## 2. Deliverables

- [x] `src/providers/anthropic.ts` — when caching is enabled and at least one
      message is sent, mark the **last content block of the last message** with
      `cache_control: {type:"ephemeral"}`, in addition to the existing system and
      last-tool breakpoints.
- [x] `test/anthropic.test.ts` — offline tests: the last message's last content
      block is marked when caching is on; it is **not** marked when caching is
      off; a last `tool` message that filters to zero blocks is handled without a
      breakpoint or a throw; system + last-tool breakpoints are unaffected; the
      request never carries more than 4 `cache_control` breakpoints.

## 3. Scope Boundary (NOT in scope)

- **No change to the OpenAI or Gemini providers.** `cache_control` is
  Anthropic-specific; OpenAI caches automatically and Gemini uses a different
  mechanism. This task touches `anthropic.ts` only.
- **No new public option or config.** The breakpoint rides the **existing**
  `cache` flag (`AnthropicProvider` `cache?: boolean`, default true). Caching off
  → no breakpoints at all (today's behavior).
- **No 20-block-lookback intermediate breakpoints.** Anthropic walks back at most
  20 content blocks from a breakpoint to find a prior cache entry; a single turn
  that appends >20 blocks can miss. Placing extra intermediate breakpoints to
  cover that is **out of scope** (opencode's default doesn't either). Documented
  as a known limitation in Risks.
- **No TTL change.** Stays the default 5-minute `{type:"ephemeral"}` (no `ttl:
  "1h"`), matching the existing system/tool breakpoints.
- **No caching of assistant/thinking specifics.** The breakpoint is placed on
  whatever the last message's last block is; no special-casing by role or type.

## 4. Key Design Decisions

### D1. Add one breakpoint on the last content block of the last message

- **Problem:** The growing conversation prefix is never cached.
- **Options:** (a) leave as-is (static-only caching); (b) breakpoint on the last
  content block of the last message (the documented multi-turn pattern); (c)
  track and re-mark multiple historical breakpoints each request.
- **Choice:** (b). EAgent intentionally **generalizes** opencode's
  `latest-user-message` rule to "the last message, regardless of role." The two
  coincide in practice (the provider is called after a user/tool turn), and when
  the last message is an assistant turn the breakpoint still lands on a valid
  cacheable block (R3) — so the implementation is not diverging from a spec, it
  is applying the simpler, role-agnostic form of the same pattern.
- **Rationale:** (b) is exactly the Anthropic-documented incremental-caching
  pattern and what opencode's `cache-policy.ts` does (its `latest-user-message`
  breakpoint). It is one mark on the data EAgent already builds in
  `toAnthropicMessages`. (a) leaves the dominant cost unaddressed. (c) is
  unnecessary: Anthropic only needs the *current* request's breakpoints — the
  prior request already **wrote** the earlier prefix to cache, so a single
  breakpoint at the new tail reads that prefix and writes only the new
  extension. Rejected (c) as complexity with no benefit.

### D2. Breakpoint budget: 3 of 4, message breakpoint placed last

- **Problem:** Anthropic allows at most 4 `cache_control` breakpoints; exceeding
  it is a 400.
- **Choice:** system (1, existing) + last tool (1, existing) + last message (1,
  new) = **3 ≤ 4**. The message breakpoint is independent of the others;
  ordering does not matter to the count.
- **Rationale:** Three is safely under the cap, leaving headroom. The invalidation
  hierarchy makes the three orthogonal: a message-content change invalidates only
  the messages cache, not the tools/system caches, so the new breakpoint cannot
  disturb the existing static caching. An acceptance criterion asserts the count
  never exceeds 4.

### D3. Mark the last *content block*, guarding empty content

- **Problem:** A message's `content` is an array that could in principle be
  empty; `cache_control` attaches to a content **block**, not the message object.
- **Choice:** Take the last message in the mapped array; if its `content` is a
  non-empty array, set `cache_control` on the **last element**. If there are no
  messages, or the last message has empty content, place no message breakpoint
  (the static breakpoints still apply).
- **Rationale:** Matches where Anthropic accepts `cache_control` (on text /
  tool_use / tool_result / image blocks, per the prompt-caching reference). The
  empty-guard is **load-bearing, not merely defensive**: `toAnthropicMessages`
  builds a `tool` message's content by *filtering* to `tool_result` blocks
  (`anthropic.ts:225-230`) and an assistant message's content with a `flatMap`
  that drops unsigned `thinking` blocks (`anthropic.ts:236-251`), so a real
  message can map to `content: []`. Because the provider is normally called right
  after a user/tool message, "last message is a tool message that filtered to
  zero blocks" is a realistic path, not a corner case — the guard skips the
  message breakpoint there (the static system/tool breakpoints still apply) and
  falls back to the previous message's tail on the *next* call. Under
  `noUncheckedIndexedAccess` the last-element access is guarded regardless.
- **Type-safety note:** `toAnthropicMessages` returns `unknown[]` and each
  `content` is `unknown[]`; attaching `cache_control` uses the **same cast idiom
  the existing tool breakpoint uses** — `(block as Record<string, unknown>)
  .cache_control = {...}` (`anthropic.ts:77`) — never `any` (CLAUDE.md).

### D4. Ride the existing `cache` flag; no new surface

- **Problem:** Should this be independently switchable?
- **Choice:** Gate the message breakpoint on the same `#cache` boolean that
  already gates the system/tool breakpoints. No new constructor option, env var,
  or config.
- **Rationale:** The three breakpoints are one coherent caching strategy; a
  separate toggle would be speculative configuration (Simplicity First). `cache:
  false` already means "no caching at all" and must keep meaning exactly that —
  an acceptance criterion verifies the message breakpoint is absent when caching
  is off.

## 5. Dependencies and Assumptions

- **Anthropic prompt-caching semantics** (verified via the claude-api skill):
  max 4 breakpoints; `cache_control` on content blocks; multi-turn breakpoint on
  the last block of the latest message; 20-block lookback window; default
  5-minute ephemeral TTL. These are stable API behaviors.
- **`toAnthropicMessages`** (`src/providers/anthropic.ts:218`) produces an array
  of `{role, content: block[]}`; the new code mutates the last element's last
  block after that array is built (or inside the mapping). No kernel change.
- **Test harness** injects `fetch` and captures `JSON.parse(init.body)`
  (`test/anthropic.test.ts:85-90, 143-162`); the new assertions read
  `captured.messages`. Offline, no network, no API key.
- **Strict TS** (`noUncheckedIndexedAccess`): last-message / last-block indexing
  must be guarded.

## 6. Relationship with Existing Designs

- Independent of the prior tasks (`bash-policy`, `tool-output-spill`,
  `resilient-edit`); no shared state, no supersession.
- **Extends** the existing static caching in `anthropic.ts` (the system + last
  tool breakpoints at lines 76-82). The change is additive and within the same
  `#cache` gate; when caching is off, behavior is byte-identical to today.
- Terminology anchor: CLAUDE.md (providers are `fetch` + SSE, read config from
  `process.env`, no SDK) and the existing `anthropic.ts` caching comment
  (lines 70-74), which this design extends to the message tail.

## 7. Acceptance Criteria

Verified by `npm test` (offline) and `npm run typecheck` (exit 0). Tests capture
the request body via the injected `fetch`.

1. **Typecheck clean:** `npm run typecheck` exits 0 (indexing guarded).
2. **Message tail cached when on (default):** with caching enabled and a request
   carrying a multi-message history **and** ≥2 tools (so criteria 2, 3, 5 share
   one request), `captured.messages.at(-1).content.at(-1).cache_control`
   deep-equals `{type:"ephemeral"}`.
3. **Static breakpoints intact:** in the same request, `captured.system[0]` and
   the **last** `captured.tools[]` entry still carry
   `cache_control:{type:"ephemeral"}`, and earlier tools do not (the existing
   test at `anthropic.test.ts:143` continues to pass unmodified).
4. **Off means off:** with `cache:false`, no message block carries
   `cache_control` (assert every block of every message has
   `cache_control === undefined`), and `system`/`tools` are unmarked (the
   existing `cache:false` behavior is unchanged).
5. **Breakpoint budget:** for a request with system + ≥2 tools + ≥2 messages and
   caching on, the **total** number of `cache_control` occurrences across
   `system`, `tools`, and all message blocks is **≤ 4** (and equals 3 here).
6. **Empty/no messages safe:** a request with `messages: []` and caching on does
   not throw and sends no message breakpoint (system/tools still marked).
7. **Empty-content last message safe (the guard's real case):** a request whose
   **last message is a `tool` message that filters to zero `tool_result` blocks**
   (so its mapped `content` is `[]`) and caching on does not throw, sets no
   message breakpoint, and still marks system/tools — proving the load-bearing
   guard from D3.
8. **Regression:** `npm test` reports `# fail 0` (≥ 279 prior tests plus the new
   subtests); the existing Anthropic streaming/tool/cache tests pass unmodified.

No latency budget: the change adds one constant-time array index + property set
per request, off any hot loop — excluded per the Scope Boundary.

## 8. Risks and Rollback

- **R1 — 20-block lookback miss on very tool-heavy single turns.** If one turn
  appends >20 content blocks after the previous breakpoint, Anthropic may not
  find the prior cache entry and re-processes that span. *Mitigation:* this only
  *reduces* the benefit (never breaks correctness or raises cost above today's
  uncached baseline), is the same behavior as opencode's default, and is
  documented here; intermediate breakpoints are a possible future enhancement,
  explicitly out of scope (§3).
- **R2 — Breakpoint-count regression.** A future change adding a fourth
  category of breakpoint could exceed 4 and 400. *Mitigation:* acceptance
  criterion 5 asserts the count stays ≤ 4; the comment in `anthropic.ts` notes
  the budget.
- **R-min — Below-minimum prefix silently won't cache.** Anthropic only caches a
  prefix above a model-dependent minimum (~4096 tokens on Opus 4.8, ~2048 on
  Fable 5 / Sonnet 4.6); a shorter conversation returns
  `cache_creation_input_tokens: 0` with no error. Like R1, this only *reduces*
  benefit on short sessions, never breaks correctness or raises cost above
  today's uncached baseline. No action; noted as the other benign "silent no-op"
  condition a reader will ask about.
- **R3 — Marking an assistant/thinking tail block.** When the last message is an
  assistant turn (rare at generation time — the provider is normally called
  after a user/tool message), the breakpoint lands on an assistant block. This is
  still a valid cacheable block and harmless. *Mitigation:* none needed; noted so
  a reviewer doesn't mistake it for a bug.
- **Rollback:** revert the `anthropic.ts` diff (remove the message-breakpoint
  block) and the added tests. No persisted state, no config, no migration; the
  static caching and the `cache:false` path are untouched.
