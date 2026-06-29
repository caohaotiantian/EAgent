# Design + Impl (Light Mode) — Reasoning replay-fidelity (OpenAI/Gemini)

```
Status: closed
Closing-commit: e2e21f2
Closed-on: 2026-06-29
Deferred: RW6d-1 (reasoning-only-turn replays to empty wire content) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-reasoning-fidelity` · **Wave:** 6 (subsystem 4 of 4) · **Mode:** Light
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P2.4

> Light Mode: one combined doc (design rationale + KDDs + ACs + impl tasks), a single fresh-reviewer
> pass (+ confirming), then L3. Justified: a small, well-understood, low-risk provider fix with a clear
> invariant and zero kernel/extension surface change.

## 1. Background and the gap (code as truth)

`Agent.snapshot()` (Wave 4) `structuredClone`s `#messages`; `restore()` brings them back. Persisted
fidelity therefore depends entirely on what each provider puts in `done.message.content`. Audit:

- **Anthropic** (`anthropic.ts:201-202`) pushes a `{type:"thinking", thinking, signature}` block into
  `done.message.content` — reasoning **is** persisted. ✓
- **OpenAI** (`openai.ts:138-139`) yields `reasoning_delta` from `choice.delta.reasoning_content` but
  `done.message.content` (`:151-167`) only gets `text` + `tool_call` — **reasoning is dropped** from the
  persisted message. ✗
- **Gemini** (`gemini.ts:122-124`) yields `reasoning_delta` from `part.thought === true` parts but
  `done.message.content` (`:142-146`) only gets `text` + `tool_call` — **reasoning is dropped**. ✗

So `snapshot()`/`restore()` (and any journal/transcript consumer) silently loses chain-of-thought on 2 of
3 providers. The `ThinkingBlock` type already exists in the `ContentBlock` union (`types.ts:44-46,65`);
the fix is to *use* it in the two providers that don't.

## 2. Deliverable

- [ ] **D1** OpenAI: accumulate `reasoning_content` deltas into a buffer; at `done`, if non-empty, prepend
  `{ type: "thinking", thinking: <buffer> }` (no `signature`) to `done.message.content`.
- [ ] **D2** Gemini: accumulate `part.thought` text into a buffer; at `done`, if non-empty, prepend the
  same `{ type: "thinking", thinking: <buffer> }` block.
- [ ] **D3** Tests in `test/openai.test.ts` / `test/gemini.test.ts`: a stream with reasoning → a thinking
  block present (with the reasoning text) + the text block; a stream with no reasoning → **no** thinking
  block (byte-identity); replay (`toOpenAIMessages`/`toGeminiContents`) of a message carrying a thinking
  block emits **nothing** for it on the wire (replay-safe).

## 3. Scope Boundary (NOT in scope)

- **No** kernel change, **no** new `ContentBlock` type (reuse the existing `ThinkingBlock`), **no**
  extension. No `Usage` change (reasoning *token* accounting already exists — `reasoningTokens`).
- **No** signature/cryptographic replay for OpenAI/Gemini (they emit summaries, not
  signed-and-replayable thoughts like Anthropic).
- **No** change to Anthropic (already correct).
- **No** change to how reasoning is *streamed* (`reasoning_delta` stays — live observability is unchanged);
  this only adds the *persisted* copy.

## 4. Key Design Decisions

### KDD-1 — Persist via the existing `ThinkingBlock`, matching Anthropic
*Options:* (a) a new field / `message.meta.reasoning`; (b) push a `ThinkingBlock` into `content`.
*Choice:* **(b)** — `ThinkingBlock` is already in the `ContentBlock` union and is exactly how Anthropic
persists it, so snapshot/restore, journals, and renderers handle all three providers uniformly with zero
new surface. *Rejected:* (a) invents a parallel channel the rest of the system doesn't read.

### KDD-2 — No signature; safe because every request-builder ignores unsigned thinking
*Problem:* will persisting a thinking block break replay (the next request)? *Verified against source:*
`openai.ts` `textOf` filters `type==="text"` only (`:234-239`) and the assistant builder uses
`textOf` + tool_calls (`:206-214`) — a thinking block is ignored; `gemini.ts` `toGeminiContents` maps
only text/tool_call/image parts (`:195-203`) — a thinking block falls through, ignored; `anthropic.ts`
replays a thinking block **only with a signature** (`:278-279`) — an unsigned one is dropped. So an
unsigned OpenAI/Gemini thinking block is **inert on replay across all three providers** (even after a
mid-conversation provider switch). *Choice:* omit `signature`. *Rejected:* fabricating a signature (would
risk Anthropic re-sending a bogus signed block).

### KDD-3 — Thinking block first in `content`
Reasoning precedes the answer in the stream and Anthropic emits the thinking block before text; prepend
the thinking block so block order is consistent across providers. *Rejected:* appending (inconsistent
order, harder for a renderer to treat uniformly).

### KDD-4 — Only when reasoning was actually streamed ⇒ byte-identical default
Push the block only when the buffer is non-empty. Non-reasoning models / `thinking: off` stream no
reasoning → no block → `done.message.content` is byte-identical to today. *Rejected:* always pushing an
(empty) block (pollutes the transcript, breaks byte-identity).

## 5. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing 1010 + new). NOTE: two existing tests
  (`test/openai.test.ts:297`, `test/gemini.test.ts:213`) assert `content[0]` is text while reasoning is
  present and **must be updated** (task 0) — they are not "untouched"; the count grows, none should fail.
- **AC-3 (OpenAI persist)** Feed an SSE stream with `choice.delta.reasoning_content` chunks + text
  chunks; assert `done.message.content` contains a `{type:"thinking", thinking:<concatenated reasoning>}`
  block (first) **and** the `{type:"text"}` block; `reasoning_delta` events still fire (streaming
  unchanged).
- **AC-4 (Gemini persist)** Feed an SSE stream with `parts:[{text, thought:true}, …]` + a normal text
  part; assert the same thinking-block-first + text-block shape.
- **AC-5 (replay-safe)** `toOpenAIMessages`/`toGeminiContents` of an assistant message containing a
  thinking block produce wire output with **no** reasoning/thought content (the block is dropped) — pins
  KDD-2.
- **AC-6 (byte-identity)** A stream with **no** reasoning → `done.message.content` has **no** thinking
  block (identical to today).

## 6. Impl tasks (TDD order)

0. **(test, REQUIRED — fixes pre-existing assertions that this change breaks)** Update the two existing
   reasoning tests that assert `content[0]` is the **text** block while reasoning is present — they break
   once the thinking block is prepended (KDD-3): `test/openai.test.ts:297`
   (`done.message.content[0].text === "answer"`) and `test/gemini.test.ts:213`
   (`content[0].text === "Hi"`). Rewrite each to locate the text block robustly —
   `content.find(b => b.type === "text")` — so they pass and now **also** corroborate D1/D2 (assert a
   thinking block is additionally present). (`test/agent.test.ts:532` already expects thinking-first vs
   MockProvider — unaffected. These two are the **only** suite tests that feed reasoning and assert on
   `content[0]`.)
1. **(test)** `test/openai.test.ts`: AC-3 (reasoning persisted, first, + text), AC-6 (no-reasoning →
   no block), AC-5 (replay of a thinking-block message → no reasoning on the wire — write it by putting a
   `ThinkingBlock` into `req().messages` and **capturing the wire body** via the injectable `fetch`, the
   pattern at `openai.test.ts:99-130`; `toOpenAIMessages` is module-private). Use the existing
   `sse([...])` + injectable `fetch` + `collect(provider.stream(req()))` harness.
2. **(test)** `test/gemini.test.ts`: AC-4, AC-6, AC-5 with `parts:[{text,thought:true}]` (capture the wire
   body via injectable `fetch`, pattern at `gemini.test.ts:85-115`).
3. **(impl)** `openai.ts`: add `let reasoningBuffer = "";` near `textBuffer`; in the reasoning branch
   (`:138-139`) also `reasoningBuffer += choice.delta.reasoning_content;` (keep the `yield`). At done
   (`:151`), before pushing text: `if (reasoningBuffer) content.push({ type: "thinking", thinking:
   reasoningBuffer });` then the existing text/tool_call pushes — so thinking is first.
4. **(impl)** `gemini.ts`: add `let reasoningBuffer = "";`; in the thought branch (`:122-124`) also
   `reasoningBuffer += part.text;` (keep the `yield`). At done (`:142`), before text:
   `if (reasoningBuffer) content.push({ type: "thinking", thinking: reasoningBuffer });`.
5. **(verify)** `node --import tsx --test "test/openai.test.ts" "test/gemini.test.ts" "test/anthropic.test.ts"`;
   `npm run typecheck`; `npm test`.

- **Accept:** `node --import tsx --test "test/openai.test.ts" "test/gemini.test.ts"`; `npm run typecheck`.
- **Exit:** AC-3..AC-6 pass; Anthropic tests still green; `npm test` green.

## 7. Engineering Constraints

ESM NodeNext `.js` specifiers; strict TS (`noUncheckedIndexedAccess`); zero deps but jiti; offline
provider tests via the injectable `fetch` + `sse()` helper. No kernel change (kernel stays 2182), no
extension change, no `Usage` change. `ThinkingBlock` already exists. No AI attribution in commits.

## 8. Risks and Rollback

- **R1 — A persisted thinking block breaks a later request.** *Mitigation:* KDD-2 (all three builders
  ignore/drop unsigned thinking), pinned by AC-5. *Rollback:* drop the two `content.push` lines.
- **R2 — Byte-identity drift on non-reasoning runs.** *Mitigation:* KDD-4 + AC-6 (only push when the
  buffer is non-empty). *Rollback:* same.
- **R3 — Renderer double-shows reasoning** (streamed live + now in the transcript). *Mitigation:* this is
  the same situation Anthropic already produces (thinking block in the message + `reasoning_delta`
  stream); existing renderers already handle the Anthropic case, so the two non-Anthropic providers now
  just match. No new behavior. *Rollback:* n/a.
- **R4 — Reasoning-only turn replays to empty wire content** (rare): a turn with reasoning but **no** text
  and **no** tool call now persists `content:[{thinking}]`; on replay the unsigned thinking block is
  dropped (KDD-2), leaving OpenAI `content:null` (already its text-less shape, `openai.ts:211`) and Gemini
  `parts:[]` (which the Gemini API may reject). *Likelihood:* low — requires a truncated thinking-only
  turn (e.g. `max_tokens` mid-thought) that is then snapshotted and continued. *Mitigation:* documented;
  a future "drop an assistant message whose replay yields empty content" guard if it ever bites. Not
  guarded in this Light fix. *Rollback:* n/a.

Two `content.push` lines + two buffer accumulations in the providers, plus the task-0 update of two
existing test assertions; reverting the provider lines restores prior runtime behavior exactly.

## Review Log (Light Mode)

- **Round 1** — **SEVERE** S1: prepending the thinking block breaks two existing tests asserting
  `content[0]` is text (`test/openai.test.ts:297`, `test/gemini.test.ts:213`) — the plan omitted the
  required test updates. + clarifications (C1 reasoning-only replay edge; C2 AC-5 wire-capture). Fixed:
  impl task 0 updates the two tests (`content.find`), AC-2 note, R4, wire-capture in tasks 1/2. Gap + fix
  + replay-safety verified correct against source.
- **Round 2 (confirming)** — **zero severe, zero general** (S1 fix + "only two breaking tests" claim
  independently re-verified). **Closed.**
