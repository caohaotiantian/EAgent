# Implementation: incremental conversation prompt-caching (Anthropic provider)

Slug: `2026-06-20-incremental-prompt-cache`
Design doc: `docs/design/2026-06-20-incremental-prompt-cache.md`

## 1. Task Index

| Design Deliverable (§2) | Design Acceptance Criterion (§7) | Phase |
| --- | --- | --- |
| `src/providers/anthropic.ts` — message-tail breakpoint | 1–8 | P1 |
| `test/anthropic.test.ts` — caching tests | 2–8 | P1 |

Design Key Design Decisions: D1 (breakpoint on last block of last message),
D2 (3-of-4 budget), D3 (load-bearing empty-content guard + cast idiom),
D4 (ride existing `cache` flag, no new surface).

## 2. Phase Breakdown

A two-file, additive change to one provider; `npm test` green at the end.
**One Phase**, strict TDD order.

### Phase 1 — message-tail cache breakpoint

**Entry condition:** baseline green — `npm test` `# fail 0` (279 pass on this
branch), `npm run typecheck` exit 0, clean tree.

**Design references:** `docs/design/2026-06-20-incremental-prompt-cache.md` §2,
§4 D1–D4, §7 AC 1–8, §8.

**Task list (TDD order — test tasks first):**

- **T1 (test): caching-shape tests** in `test/anthropic.test.ts`, extending the
  body-capture pattern (inject `fetch`, `captured = JSON.parse(String(init.body))`,
  return `sseResponse(TEXT_EVENTS)`). Each asserts an observable invariant of the
  request body (the protected behavior: *the growing conversation tail is marked
  cacheable exactly when caching is on, within the 4-breakpoint budget, and the
  empty-content path is safe*):
  - **tail cached when on (AC-2/AC-3):** build a request with a multi-message
    history (e.g. user text, assistant tool_call, tool result, user text) **and**
    ≥2 tools, caching default-on; assert
    `captured.messages.at(-1).content.at(-1).cache_control` deep-equals
    `{type:"ephemeral"}`; assert `captured.system[0].cache_control` and the
    **last** `captured.tools` entry are `{type:"ephemeral"}` while earlier tools
    are `undefined`.
  - **off means off (AC-4):** same request with `cache:false`; assert no message
    block, no system, no tool carries `cache_control` (walk every block).
  - **empty-content last message safe (AC-7):** last message is a `tool` message
    whose blocks contain **no** `tool_result` (so it maps to `content: []`),
    caching on; assert the call does not throw, the last message has no
    `cache_control`, and system/tools are still marked.
  - **budget ≤ 4 (AC-5):** the on-request above; count every `cache_control`
    occurrence across `system`, `tools`, and all message blocks; assert ≤ 4
    (and === 3 for this request).
  - **no/empty messages safe (AC-6):** `messages: []`, caching on; assert no
    throw and no message breakpoint (system/tools still marked).
  Watch the new ones fail (the message tail is currently never marked).

- **T2 (impl): add the breakpoint** in `src/providers/anthropic.ts`. After the
  messages array is built (`const msgs = toAnthropicMessages(req.messages)` —
  hoist it from the inline `messages:` body field at ~line 88 into a local so it
  can be post-processed), when `this.#cache` and `msgs.length > 0`: take the last
  message, read its `content` (an array), and if that array is **non-empty**, set
  `cache_control: {type:"ephemeral"}` on its **last** element using the existing
  cast idiom `(block as Record<string, unknown>).cache_control = { type:
  "ephemeral" }` (mirroring `anthropic.ts:77`). Guard the last-message and
  last-block indexing for `noUncheckedIndexedAccess` (capture into a `const` and
  check for `undefined` / non-empty length before indexing). No `any`. Use the
  hoisted `msgs` in the request body. Add a one-line comment noting the
  4-breakpoint budget (system + last tool + last message = 3). Make T1 green.

**Per-task acceptance commands** (repo root):

- T1/T2: `node --import tsx --test test/anthropic.test.ts` — Anthropic tests pass
  (0 fail), including the new caching-shape tests.
- Phase exit: `npm run typecheck` exit 0 **and** `npm test`
  (`node --import tsx --test "test/**/*.test.ts"`) `# fail 0`.

**Exit condition:** typecheck 0; `npm test` `# fail 0` (≥ 279 prior + new
subtests); design AC 1–8 each map to a passing assertion.

## 3. Engineering Constraints Index

- **Project norms** — `CLAUDE.md` House conventions: ESM `.js` specifiers, strict
  TS (`noUncheckedIndexedAccess` — guard the indexing), no `any` (use the
  `Record<string, unknown>` cast like the existing tool breakpoint), providers
  are `fetch` + SSE with no SDK. The change is confined to the cache-marking
  region; the SSE parsing, request plumbing, and `toAnthropicMessages` mapping
  logic are untouched (only the last block of the already-built array is mutated).
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phase1): …`; `fix(phase1-roundR): <keyword>`;
  `npm test`/typecheck trailers; no AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- **Reused:** `test/anthropic.test.ts` `sseResponse`, `TEXT_EVENTS`, the injected
  `fetch` body-capture pattern, and the `req()` helper (which defaults a
  `systemPrompt`, so the `system[0]` assertion holds). No new fixtures, no
  network, no API key.
- **New:** only additional `test()` blocks in `test/anthropic.test.ts`.

## 5. Regression Protection

- Full `npm test` stays `# fail 0`. In particular the **existing Anthropic
  tests** — streaming text/tool parsing, usage accounting, and the existing
  `cache:true`/`cache:false` system+tool tests (`anthropic.test.ts:143-176`) —
  must pass **unmodified**: the message-tail breakpoint is additive and gated on
  the same `#cache` flag, so system/tool marking and the `cache:false` path are
  byte-identical to today. `npm run typecheck` stays clean.
- Only `src/providers/anthropic.ts` (the cache-marking region) and
  `test/anthropic.test.ts` (additions) change. No kernel change, no change to
  the OpenAI/Gemini providers, no change to `toAnthropicMessages`' mapping
  output shape (only a `cache_control` property is added to one block).
