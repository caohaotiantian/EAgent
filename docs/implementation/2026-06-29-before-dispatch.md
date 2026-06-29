# Implementation — `beforeDispatch` wave-level seam

**Slug:** `2026-06-29-before-dispatch` (matches design) · **Design:**
[`design/2026-06-29-before-dispatch.md`](../design/2026-06-29-before-dispatch.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1 `beforeDispatch` filter point + D2 reconciliation in `run()` | design §2 D1-D4, KDD-1..6, AC-1..AC-9 |

One Phase: a single coherent kernel change (one filter-map key + a reconciliation block in `run()`'s
tool-dispatch section). Independently committable; `npm test` green at the end.

## 2. Phase Breakdown

### Phase 1 — Add `beforeDispatch` and the pairing-safe reconciliation

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-5 merged). Baseline `npm test` green.
- **Design refs:** §2 D1-D4; KDD-1 (pairing), KDD-2 (no inject), KDD-3 (apply after no-calls check; empty
  dispatch → all-synthetic), KDD-4 (neutral synthetic), KDD-5 (executed-set for tool_batch_end +
  terminate; transcript = all ids, original order), KDD-6 (not shared to children); AC-1..AC-9.
- **Files:** `src/kernel/events.ts`, `src/kernel/agent.ts`, `test/agent.test.ts`.
- **Task list (TDD order):**
  1. **(test)** `test/agent.test.ts` — **reorder** (AC-3): a tool turn with 3 parallel calls; register a
     `beforeDispatch` handler returning them reversed; assert execution order (via `tool_start` observer)
     is reversed, the transcript tool message has 3 `tool_result`s keyed 1:1 to the original ids with
     correct content, in **original** order.
  2. **(test)** `test/agent.test.ts` — **drop one** (AC-4): handler drops the middle call; assert that
     tool does NOT execute (no `tool_start` for it), its id still gets a `tool_result` with the neutral
     skip note and `isError` falsy, and the other two execute and pair normally.
  3. **(test)** `test/agent.test.ts` — **drop-all** (AC-5, pairing-critical): handler returns `[]` for a
     3-call wave; assert (a) no tool executes, (b) a tool message with exactly 3 synthetic skip
     `tool_result`s (one per original id) is appended, (c) the loop continues to the next `streamTurn`
     (NOT end/no-calls), (d) every assistant `tool_use` id has a matching `tool_result` (no orphan). Also
     assert a `terminate:true` tool in a partially-dropped wave still terminates (the executed set drives
     the terminate check), while a fully-dropped wave does NOT terminate.
  4. **(test)** `test/agent.test.ts` — **inject-ignored** (AC-6): handler returns an extra call with an
     id not in the originals; assert it does not execute and no extra/orphan `tool_result` appears.
  5. **(test)** `test/agent.test.ts` — **default byte-identity** (AC-7) + **divergence** (AC-9): with no
     handler, 3 calls dispatch in original order, results map 1:1, no synthetics; and (with a drop
     handler) `tool_batch_end` carries only executed results while the transcript carries all ids.
  6. **(impl)** `src/kernel/events.ts`: add to `KernelFilters`:
     `beforeDispatch: { value: ToolCallBlock[]; context: { turn: number } }` (import `ToolCallBlock` —
     already imported in events.ts).
  7. **(impl)** `src/kernel/agent.ts` `run()` tool-dispatch section (after the `calls.length === 0` check
     at ~257, before `dispatch` at ~270): let `originalCalls = calls`. Apply
     `const wanted = await this.hooks.apply("beforeDispatch", [...originalCalls], { turn })`. Compute
     `dispatchSet = wanted.filter(c => originalCalls.some(o => o.id === c.id))` (subset/permutation by id;
     unknown injected ids dropped). `const results = await this.dispatch(dispatchSet)` (may be empty).
     Keep `tool_batch_end` emitting `results` (executed set) and keep the `terminate` check on `results`
     (it already guards `results.length > 0`, so drop-all doesn't spuriously terminate). For the
     transcript, build a **reconciled `DispatchOutcome[]`** over `originalCalls` in original order so the
     **existing** toolMessage builder (`agent.ts:280-287`, which maps `r.call.id`/`r.result.content`/
     `r.result.isError`) is reused unchanged:
     `const reconciled = originalCalls.map(oc => results.find(r => r.call.id === oc.id) ?? { call: oc,
     result: { content: "(skipped by a beforeDispatch hook)", isError: false } })`
     (the `?? synthetic` is mandatory under `noUncheckedIndexedAccess` — `.find` is `T | undefined`).
     Map the toolMessage over `reconciled` instead of `results`. Continue the loop exactly as today. With
     no handler, `dispatchSet` content equals `originalCalls`, so `reconciled === results` content-wise —
     every id real, original order, no synthetics — byte-identical. (Pass `[...originalCalls]` to `apply`
     as a defensive copy so an in-place-mutating handler can't corrupt the originals.)
  8. **(verify)** `node --import tsx --test test/kernel-surface.test.ts` — `beforeDispatch` is a type-only
     `KernelFilters` key (no runtime export change); confirm `< 2200` lines.
- **Per-task accept commands:**
  - `node --import tsx --test "test/agent.test.ts"`
  - `node --import tsx --test "test/kernel-surface.test.ts"`
  - `npm run typecheck`
- **Exit condition:** AC-3..AC-7 + AC-9 tests pass; default byte-identity holds; `kernel-surface` green
  (`< 2200`); `npm test` green.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` specifiers; strict TS
  (`noUncheckedIndexedAccess` — guard the `.find`/`.some` over arrays); zero deps but jiti; offline tests.
  `events.ts`/`agent.ts` are kernel (load-bearing); the CLAUDE.md/README/EXTENSIONS/ARCHITECTURE
  filter-hook count (now six) is reconciled at F.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI attribution.

## 4. Data and Fixture Dependencies

Reuse `MockProvider` (function responder to script a multi-tool-call assistant turn). Inline test tools
that record `tool_start` order and optionally return `terminate:true`. No network, no new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. The default-no-handler path is byte-identical
  (`hooks.apply` passthrough), so existing `agent.test.ts` tool-dispatch / terminate / tool_batch_end
  tests stay green — they are the core regression net.
- `test/kernel-surface.test.ts` green (no export change; `< 2200`).
- Wave-3 `childScope` is unaffected (beforeDispatch deliberately NOT in `SHARED_FILTER_POINTS`).

## L2 Review Log

- **Round 1** — **zero severe, zero general** (3 clarifications: reconciled-DispatchOutcome form,
  defensive copy, terminate operand). Folded the reconciled-`DispatchOutcome[]` spelling into step 7.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**
