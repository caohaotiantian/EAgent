# Implementation — Tiered self-editing memory

**Slug:** `2026-06-29-tiered-memory` (matches design) · **Design:**
[`design/2026-06-29-tiered-memory.md`](../design/2026-06-29-tiered-memory.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1 extract scorer → `lib/relevance.ts` (behavior-identical) | design §2 D1, KDD-2, AC-3 |
| 2 | D2-D5 archival tier + query recall + eviction + `/memory` subcmds | design §2 D2-D5, KDD-1/3/4/5, AC-4..AC-8 |

Two Phases: Phase 1 a behavior-preserving extract (gated by handoff's tests); Phase 2 the additive memory
extension. Each independently committable; `npm test` green at each Phase end.

## 2. Phase Breakdown

### Phase 1 — Extract the lexical scorer to `src/extensions/lib/relevance.ts`

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-6 + 7a merged). `npm test` green.
- **Design refs:** §2 D1; KDD-2; AC-3.
- **Files:** `src/extensions/lib/relevance.ts` (new), `src/extensions/handoff.ts` (import + re-export),
  `test/handoff.test.ts` (unchanged — the parity net), optional `test/lib-relevance.test.ts`.
- **Task list:**
  1. **(impl)** Create `src/extensions/lib/relevance.ts`; **move** verbatim from `handoff.ts`: the
     `STOPWORDS` const and `export function salientTokens(s)`. Add
     `export function overlapScore(query: string, text: string): number` = size of the set-intersection of
     `salientTokens(query)` and `salientTokens(text)` (count of shared salient tokens). Lib imports: none
     beyond JS built-ins (pure; no `ExtensionAPI` → no circular import).
  2. **(impl)** `handoff.ts`: delete the moved `STOPWORDS` + `salientTokens` definitions; add
     `import { salientTokens } from "./lib/relevance.js";` and **re-export**:
     `export { salientTokens } from "./lib/relevance.js";` (so `test/handoff.test.ts`'s
     `import { salientTokens, isRelevant }` keeps resolving). `isRelevant` (which uses `salientTokens`)
     stays in `handoff.ts`. The only handoff internal consumer of `salientTokens` is `isRelevant`
     (`handoff.ts:309-311`); confirm it still resolves via the import (typecheck verifies).
  3. **(verify)** `node --import tsx --test "test/handoff.test.ts"` passes **unchanged** (AC-3);
     `npm run typecheck` 0.
  4. **(test, optional)** `test/lib-relevance.test.ts`: `overlapScore` unit cases (overlap count; stopwords
     dropped; zero on no shared salient tokens) + a `salientTokens` smoke (AC-4's pure-scorer part).
- **Accept:** `node --import tsx --test "test/handoff.test.ts"`; `npm run typecheck`.
- **Exit:** handoff tests green unchanged; typecheck 0; `npm test` green.

### Phase 2 — Archival tier + query recall + eviction in `memory.ts`

- **Entry condition:** Phase 1 merged.
- **Design refs:** §2 D2-D5; KDD-1 (extend memory), KDD-3 (two tiers), KDD-4 (additive `query`, byte-
  identical no-query), KDD-5 (oldest-by-ts evict, archive FIFO); AC-4..AC-8.
- **Files:** `src/extensions/memory.ts`, `test/memory.test.ts`.
- **Data model:** `const ARCHIVE_PREFIX = "archive:";`. Store-overridable config (alongside the existing
  `threshold`/`keepRecent`): `coreCap` (default 64), `archiveCap` (default 512), `recallTopK` (default 5).
  Helpers mirroring the existing `note:` ones: `readArchive(store,key)` (like `readEntry` but
  `ARCHIVE_PREFIX`), `archiveKeys(store)` (like `noteKeys`).
- **Task list (TDD order):**
  1. **(test)** `test/memory.test.ts` — **lexical query retrieval** (AC-4): remember several notes; call
     the `recall` tool with `{query}`; assert the result `details` is a **ranked array**
     `[{key,tier,text,score}]` of the best token-overlap matches, top-K, score>0 only; a no-overlap query
     returns an empty/"no matches" result (not a dump). Add a pure `overlapScore` assertion (or rely on
     Phase 1's lib test).
  2. **(test)** **backward compat — byte-identical no-query** (AC-5): `recall({key})` (exact) and
     `recall({})` (dump-all `{key→text}` map) behave exactly as before (assert against the current
     contract). The existing memory tests must stay green.
  3. **(test)** **auto-eviction core→archive** (AC-6): set `coreCap` small (store); remember past the cap;
     assert core (`note:`) count ≤ cap, the **oldest** note is gone from `note:` and present in `archive:`,
     and `recall({query})` matching the evicted note's text still finds it (tier `archive`). With the kill
     switch (`EAGENT_MEMORY_ENTRIES=off` or the disabled flag), assert **no** eviction occurs.
  4. **(test)** **promote + archive list** (AC-7): evict a note; `/memory promote <key>` moves it back to
     `note:` (gone from `archive:`); `/memory archive` lists the archive keys/count. Existing `/memory`
     subcommands (`list`/`forget`/etc.) still operate on `note:` only.
  5. **(impl)** `memory.ts`: import `{ overlapScore }` from `./lib/relevance.js`. Add `ARCHIVE_PREFIX`,
     `readArchive`, `archiveKeys`, and the config reads (`coreCap`/`archiveCap`/`recallTopK`).
     - `recall` tool: extend `parameters.properties` with `query: { type: "string", description: "..." }`
       (still no `required`, no `additionalProperties` — additive). In `execute`: **keep the existing
       `args.key` short-circuit first** (exact path, unchanged), **then** the existing dump-all when no
       `key` AND no `query` (unchanged). **New branch:** if `query` is a non-empty string, score
       `note:`+`archive:` entries via `overlapScore(query, entry.text)`, sort desc, take top-`recallTopK`
       with score>0, return `{ content: <readable rendering>, details: [{key,tier,text,score}, …] }`.
     - `remember` tool: after the existing `e.store.set(NOTE_PREFIX + key, entry)` (entries-enabled path
       only — NOT the `entriesDisabled()` branch), call `evictIfOverCap()`.
     - `evictIfOverCap()`: if `entriesDisabled()` return; read `noteKeys`; while count > `coreCap`: pick the
       note with the **lowest `ts`** (guard the sorted-`[0]` / `readEntry` result for `undefined` under
       `noUncheckedIndexedAccess`; legacy `ts:""` sorts first), `e.store.set(ARCHIVE_PREFIX+key, entry);
       e.store.delete(NOTE_PREFIX+key)`; then enforce `archiveCap` FIFO (while `archiveKeys` > `archiveCap`:
       delete the lowest-`ts` archive entry). NOTE: the archive is single-slot per key (`archive:K`), so
       re-eviction of a re-`remember`ed key overwrites the prior `archive:K` (a bounded loss edge, distinct
       from the `archiveCap` FIFO drop; acceptable per design G1 — a key may live in both tiers but the
       archive keeps only its latest evicted value).
     - `runScratchpad` (the `/memory` dispatcher): add `recall <query…>` (lexical search → print ranked),
       `archive` (print archive count + keys), `promote <key>` (move `archive:K`→`note:K`; print result).
       Keep existing subcommands untouched (they stay `note:`-scoped).
  6. **(verify)** `node --import tsx --test "test/memory.test.ts" "test/handoff.test.ts" "test/host.test.ts"`;
     `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/memory.test.ts"`; `npm run typecheck`.
- **Exit:** AC-4..AC-7 pass; existing memory + handoff tests green; host canonical-set green (no new
  extension/capability); `npm test` green; typecheck 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` specifiers (`./lib/relevance.js`);
  strict TS (`noUncheckedIndexedAccess` — guard `entry` reads, `.sort` access); zero deps but jiti (no
  embeddings/network — lexical only); offline tests. **No kernel change**, **no new extension**, **no
  capability** (memory stays capability-free). The `EAGENT_MEMORY_ENTRIES=off` kill switch keeps the legacy
  flat-string path (eviction disabled). Backward compat: the no-`query` `recall` + all existing `/memory`
  subcommands stay byte-identical (the existing memory tests are the net).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`/`feat(phase2):`; no AI attribution.

## 4. Data and Fixture Dependencies

`test/memory.test.ts` exists (the regression net for backward compat). Drive the `remember`/`recall` tools
directly via a host slice (the existing memory tests show the pattern) + the `/memory` command via a
`CommandContext`. A `MemoryBackend` store keeps tiers in-memory and deterministic; set `coreCap`/
`archiveCap` small via `e.store.set` for the eviction tests. Save/restore `EAGENT_MEMORY_ENTRIES`. Offline.

## 5. Regression Protection

- **Phase 1:** `test/handoff.test.ts` is the parity net — passes **unchanged** (same `salientTokens` import
  via re-export). `npm test` green.
- **Phase 2:** the existing `test/memory.test.ts` (remember/recall-no-query/list/edit/forget/rollback/
  consolidate + kill switch) is the backward-compat net — all must stay green (KDD-4 additive). `npm test`
  green at each Phase end.
- No kernel change → `kernel-surface.test.ts` unaffected (2182). No new extension → host canonical-set
  count unchanged.

## L2 Review Log

- **Round 1** — **zero severe, zero blocking-general** (1 cosmetic: stale `MIN_OVERLAP` ref → the consumer
  is `isRelevant`) + 2 clarifications (archive single-slot re-eviction loss edge; `noUncheckedIndexedAccess`
  guard on the oldest-pick). All folded.
- **Round 2** — **zero severe, zero general.**
- **Round 3 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**
