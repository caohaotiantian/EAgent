# Implementation — Provider honesty & resilience (Batch A)

Slug: `2026-07-10-provider-honesty` (matches `docs/design/2026-07-10-provider-honesty.md`)
Status: closed
Closing-commit: Batch A closeout on `chore/production-hardening`
Closed-on: 2026-07-10
Deferred: none (all 3 phases closed on their first L3 review; D1–D7 shipped).
Result: 3 phases, all closed round 1. Suite 1275 → 1288 pass (+13 tests: 5 fold, 6 stream-error, 1 max-tokens, 1 isSecretKey), 0 fail, 1 skip; typecheck 0; eval 5/5; build 0.

## 1. Task Index

Design doc: `docs/design/2026-07-10-provider-honesty.md`.
- Deliverables D1–D7 → design §2 (Deliverables).
- Acceptance Criteria AC1–AC5 → design §7.
- Key Design Decisions KDD1–KDD4 → design §4.
- Phase 1 implements D1, D2 (A1) — design §4 KDD1, KDD2; AC1, AC3.
- Phase 2 implements D3, D4, D5 (A2) — design §4 KDD3; AC2.
- Phase 3 implements D6 (A4) — design §4 KDD4; AC4.
- All phases must satisfy AC5 (gates + no regression) at their exit.

## 2. Phase Breakdown

`<TEST-CMD>` = `npm test`. Every phase leaves `<TEST-CMD>` green and adds ≥1 runnable
`<ACCEPT-CMD>`. Tests are written BEFORE implementation within each phase (TDD).

### Phase 1 — A1: fold in-transcript `system` messages (Anthropic + Gemini)

- **Entry condition:** none (first phase); branch `chore/production-hardening`, suite green
  (baseline 1275 pass / 1276 total / 1 skip).
- **Design references:** design §4 KDD1 (fold to top-level system channel), KDD2 (no-note
  byte-identical; note-present array shape; empty-`systemPrompt` handling; conversation-cache note),
  §7 AC1 + AC3.
- **Task list (TDD order):**
  1. **T1.1 (test)** — create `test/provider-system-fold.test.ts`. Protected invariant: *a
     `role:"system"` message present inside `req.messages` must reach the wire on every provider so
     that context-injecting extensions (context-files, skills, goal, …) are not silently dark on
     Anthropic/Gemini.* Cases, each via the provider's injected-`fetch` body-capture pattern (match
     `test/openai.test.ts:99-130` house style; Anthropic SSE builder emits `event:` lines):
     - `messages` include `{role:"system", content:[{type:"text", text:"PIN-A1"}]}` plus a normal
       user turn. Assert: Anthropic captured body — `JSON.stringify(body.system)` contains
       `"PIN-A1"`; Gemini captured body — `JSON.stringify(body.systemInstruction)` contains
       `"PIN-A1"`; OpenAI captured body — `JSON.stringify(body.messages)` contains `"PIN-A1"`
       (regression pin, already passes).
     - **Empty-`systemPrompt`-with-note:** `req.systemPrompt` = `""` and a `role:"system"` note
       present. Assert the note text survives (Anthropic `body.system` array carries it; Gemini
       `body.systemInstruction` is present and carries it) AND no empty `{type:"text",text:""}`
       block/part is emitted (Anthropic: no system block has `text === ""`; Gemini: no part has
       `text === ""`).
     - **No-note byte-identical (AC3):** with `req.systemPrompt="SP"`, cache ON, and NO
       `role:"system"` message, assert Anthropic `body.system` deep-equals
       `[{type:"text", text:"SP", cache_control:{type:"ephemeral"}}]` (today's exact shape,
       `anthropic.ts:82`). With a note added, assert `body.system` is an array whose first block
       equals that same cache_control block and whose subsequent note block(s) have **no**
       `cache_control` key.
  2. **T1.2 (impl D1)** — in `src/providers/anthropic.ts`, before/while building `msgs`, collect the
     text of each `role:"system"` message in `messages` (concatenate its `type:"text"` blocks, per
     `openai.ts:239-244` `textOf`). Change the `system` ternary (`:80-83`): when ≥1 note exists,
     build an array = `[ <systemPrompt block if req.systemPrompt non-empty, keeping cache_control iff
     this.#cache>, ...one {type:"text", text:note} per note (no cache_control) ]`; when 0 notes,
     leave the current code path byte-identical (string / single cache_control block / `""`). Keep
     the `if (m.role === "system") continue;` in the message loop (system content now travels via the
     top-level `system`).
  3. **T1.3 (impl D2)** — in `src/providers/gemini.ts`, collect `role:"system"` text the same way;
     build `systemInstruction.parts` = `[ {text:req.systemPrompt} if non-empty, ...{text:note} ]`;
     set `body.systemInstruction` whenever that parts array is non-empty (replacing the
     `if (req.systemPrompt)` guard at `:72`). Keep the `continue` at `:183`.
- **Per-task acceptance command:**
  `node --import tsx --test test/provider-system-fold.test.ts` (exit 0; all cases pass).
- **Exit condition:** `test/provider-system-fold.test.ts` green; `npm test` green (0 fail);
  `npm run typecheck` exit 0.

### Phase 2 — A2: surface mid-stream error frames (Anthropic + OpenAI + Gemini)

- **Entry condition:** Phase 1 merged; suite green.
- **Design references:** design §4 KDD3 (throw so the committed boundary routes it), §5 (committed
  boundary + no half-paired tool call), §7 AC2.
- **Task list (TDD order):**
  1. **T2.1 (test)** — create `test/provider-stream-error.test.ts`. Protected invariant: *a
     mid-stream API error frame must surface as a thrown error, never as a fabricated `done` with
     truncated content, so the loop can retry (pre-commit) or fail honestly (post-commit) instead of
     presenting an outage as a successful answer.* For each provider, feed an SSE stream via injected
     `fetch` and assert `await collect(provider.stream(req))` **rejects** (use
     `assert.rejects`):
     - **Post-commit case:** `[one content delta, the error frame, stream close]`. Frames:
       - Anthropic: a `content_block_start`+`content_block_delta` (text "par"), then
         `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`.
       - OpenAI: a chunk with `choices[0].delta.content:"par"`, then
         `data: {"error":{"message":"Overloaded","type":"server_error","code":null}}`.
       - Gemini: a chunk with `candidates[0].content.parts[0].text:"par"`, then
         `data: {"error":{"code":429,"message":"Resource exhausted","status":"RESOURCE_EXHAUSTED"}}`.
     - **Pre-commit case:** the error frame is the FIRST data frame (no content before it); assert it
       still rejects.
     - Assert the thrown error message contains the provider name and the API error type/message
       (so `reliability`/logs can classify).
  2. **T2.2 (impl D3)** — `src/providers/anthropic.ts`: add `case "error":` to the stream switch
     (`:147-193`) that throws `new Error(\`Anthropic stream error: ${parsed.error?.type}: ${parsed.error?.message}\`)`;
     add the `error` variant to `AnthropicStreamEvent` typings (`:317-334`).
  3. **T2.3 (impl D4)** — `src/providers/openai.ts`: after `JSON.parse` in the stream loop
     (`:107-151`), add `if (parsed.error) throw new Error(\`OpenAI stream error: ${parsed.error.type ?? parsed.error.code}: ${parsed.error.message}\`);`
     add optional `error?: {message?:string; type?:string; code?:string|null}` to `OpenAIChunk` (`:263-280`).
  4. **T2.4 (impl D5)** — `src/providers/gemini.ts`: after `JSON.parse` in the stream loop
     (`:99-138`), add `if (parsed.error) throw new Error(\`Gemini stream error: ${parsed.error.status ?? parsed.error.code}: ${parsed.error.message}\`);`
     add optional `error?: {code?:number; message?:string; status?:string}` to `GeminiChunk` (`:247-263`).
- **Per-task acceptance command:**
  `node --import tsx --test test/provider-stream-error.test.ts` (exit 0).
- **Exit condition:** the error test green; `npm test` green; `npm run typecheck` exit 0. Confirm no
  existing provider test asserts a silent-`done`-on-truncation behavior (there is none).

### Phase 3 — A4: configurable output `max_tokens` via `buildProviders`

- **Entry condition:** Phase 2 merged; suite green.
- **Design references:** design §4 KDD4 (exported `buildProviders`, offline-testable), §7 AC4.
- **Task list (TDD order):**
  1. **T3.1 (test)** — create `test/provider-max-tokens.test.ts`. Protected invariant: *the host
     wires a configurable per-provider output cap into the real provider construction (defaulting to
     4096), so a deployment can lengthen outputs; a hardcoded 4096 would silently truncate long
     answers and collide with high thinking budgets.* Steps: in a `try/finally`, set
     `process.env.ANTHROPIC_API_KEY="test"`; construct a `LayeredConfig` (or the host's config
     object) with an override `providers.anthropic.maxTokens = 8000`; call
     `buildProviders(config, { fetch: capturingFetch })`; drive the anthropic provider's `stream()`
     over a minimal canned SSE response; assert the captured request body has `max_tokens === 8000`.
     Second case: no override yields `max_tokens === 4096`. Restore the env in `finally`.
     *Seeding the override:* `LayeredConfig` takes an `overrideStore` (`config.ts:61-68`) that is a
     `Store` (get/set/delete/keys), so use `new MemoryStore()` — exactly the pattern at
     `test/config.test.ts:19` (`new LayeredConfig({ fileValues, overrideStore: new MemoryStore() })`)
     — then `config.set("providers.anthropic.maxTokens", 8000)`.
  2. **T3.2 (impl D6)** — in `src/host.ts`, extract the three-provider construction (`:214-216`) into
     an exported `export function buildProviders(config: Config, opts?: { fetch?: typeof fetch }):
     { anthropic; openai; gemini }` that passes
     `maxTokens: config.int("providers.<name>.maxTokens", 4096)` (and the existing `baseUrl`, and
     `opts?.fetch` when provided) to each constructor; have the host call `buildProviders(config)`.
     Add `ANTHROPIC_MAX_TOKENS`/`OPENAI_MAX_TOKENS`/`GEMINI_MAX_TOKENS` → the derived
     `providers.<name>.maxTokens` keys in `ENV_ALIASES` (`src/config.ts:36-47`).
- **Per-task acceptance command:**
  `node --import tsx --test test/provider-max-tokens.test.ts` (exit 0).
- **Exit condition:** the max-tokens test green; `npm test` green; `npm run typecheck` exit 0;
  `npm run eval` reports 5/5; `npm run build` exit 0 (final-phase full-gate check).

## 3. Engineering Constraints Index

- **Project engineering norms** — `CLAUDE.md` House conventions: ESM + `.js` import specifiers even
  for `.ts`; strict TS (`noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`); zero runtime deps except `jiti`; providers hand-rolled `fetch`+SSE;
  config via injected `e.config` (providers may read `process.env` only for secrets/keys as today);
  no kernel change (kept under the 2250-line ceiling — this batch touches only `src/providers/*`,
  `src/host.ts`, `src/config.ts`, `test/*`). Use `grep -a`/Read for non-ASCII source.
- **Four-corner subagent template** — `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`.
- **Commit conventions** — SKILL.md "Commit conventions": `feat(phaseN):` / `fix(phaseN):` opener,
  `fix(phaseN-roundR): <keyword>` for within-round fixes; `<TEST-CMD>`/`<ACCEPT-CMD>` results as
  trailers; **no** AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse each provider test's existing local helpers (re-declared per file): the `sse(...)` /
  `sseResponse(...)` SSE builder, the `req(over)` request factory, and `collect(asyncIterable)`.
  Anthropic's builder emits `event:` lines; OpenAI/Gemini use bare `data:` frames. New test files
  copy these helpers in the same house style (they are per-file by convention).
- No new external fixtures. The injected-`fetch` stub returns canned `Response` objects; no network,
  no API key (Phase 3 sets a dummy `ANTHROPIC_API_KEY` only to pass the provider's key guard, and
  restores it).

## 5. Regression Protection

Must remain green after every phase:
- `test/anthropic.test.ts`, `test/openai.test.ts`, `test/gemini.test.ts` — existing serialization +
  streaming assertions (the no-note byte-identical path in Phase 1 preserves the 14 Anthropic
  `system` assertions; Phase 2 adds a switch case / early-throw that does not alter success-path
  parsing).
- `test/agent.test.ts` (esp. `:853/:873/:936` committed-boundary error paths — Phase 2 relies on
  them, must not regress), `test/fallback-routing.test.ts` (`MidStreamFail`).
- `test/http.test.ts`, and the full suite via `npm test`.
- **Phase 3 specifically:** `test/host.test.ts` and `test/host-config.test.ts` (whichever exist) —
  they exercise `createAgentHost` and are the tests most likely to catch a `buildProviders`
  extraction regression; run them explicitly in addition to the full suite.
- The final phase additionally runs `npm run eval` (5/5) and `npm run build` (exit 0).
