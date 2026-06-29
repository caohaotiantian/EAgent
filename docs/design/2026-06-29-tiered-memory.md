# Design — Tiered self-editing memory (archival tier + lexical retrieval)

**Slug:** `2026-06-29-tiered-memory` · **Wave:** 7 (subsystem 2 of 3) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P3.2 · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md` §D (Letta/MemGPT, A-MEM)

## 1. Background and the gap (code as truth)

A Wave-7 surface audit (and a direct read of `memory.ts`) established the baseline precisely:

- `memory.ts` is a **flat KV scratchpad**: notes live under one `note:` keyspace as provenance-tagged
  `Entry { id, text, source, ts, prevText? }` (`memory.ts:26,40`), with `remember`/`recall` tools and
  `/memory list|edit|forget|rollback|consolidate`. **`recall` is exact-key or dump-all** (`memory.ts:302-329`)
  — no query, no scoring, no retrieval. There is **no archival tier**, **no eviction/promotion**, and
  `consolidate` is exact-normalized-text dedupe only.
- The Letta/MemGPT model the blueprint cites has two tiers: a small **core** (always in context) and a
  large **archival** memory (searchable, paged in on demand). EAgent has only the core notebook; the
  **archival + retrieval** half is the genuine gap. (Note: this wave delivers *agent-facing retrieval*
  (`recall(query)`) + *system-driven* tier management (auto-eviction) + a `/memory promote` slash command —
  not Letta's full *agent-driven* self-editing of tiers as tools; "self-editing" here means the existing
  `remember` overwrite + the new query recall, not autonomous tier tools. KDD/§3.)
- The zero-runtime-dependency rule (no SDKs, global `fetch` only) **forbids vector embeddings**, so
  retrieval must be **lexical**. The codebase already has a dependency-free lexical scorer: `handoff.ts`
  exports `salientTokens(s): Set<string>` (`handoff.ts:255`), built on a private `STOPWORDS` const
  (`handoff.ts:244`, not exported), used by its relevance gate. That is the reusable retrieval primitive —
  extract and share it, don't reinvent.

This wave **extends `memory.ts`** (tiers belong in the memory extension, not a new one) with: an archival
tier, auto-eviction core→archive at a cap, and **lexical query retrieval** added to `recall` — all
backward-compatible. Retrieval reuses a shared `lib/relevance.ts` extracted from `handoff`. No embeddings,
no kernel change, no new extension.

## 2. Deliverables

- [ ] **D1** Move `salientTokens` (+ its private `STOPWORDS` const) from `handoff.ts` into
  `src/extensions/lib/relevance.ts`, and add `overlapScore(query: string, text: string): number` (count of
  shared salient tokens — the lexical relevance score). `handoff.ts` imports `salientTokens` from the lib
  and **re-exports** it (`test/handoff.test.ts` imports `salientTokens` + `isRelevant`; `isRelevant` stays
  in handoff). `STOPWORDS` becomes a lib-internal const (it was never exported). **Behavior-identical
  refactor** — `test/handoff.test.ts` is the net.
- [ ] **D2** Add an **archival tier** to `memory.ts`: a second keyspace `archive:` holding the same `Entry`
  shape. Helpers `readArchive(key)`, `archiveKeys()`, mirroring the existing `note:` helpers.
- [ ] **D3** **Lexical query retrieval** on `recall`: add an optional `query` param. When present (and
  `key` is absent — `key` short-circuits to the exact path first, so backward compat is exact), score every
  **core (`note:`) + archive (`archive:`)** entry by `overlapScore(query, entry.text)` and return the top-K
  (default 5, store-overridable) with score > 0 as a **ranked list** `[{ key, tier, text, score }, …]`
  (content = a readable rendering; `details` = the array). **A list, not a `{key→text}` map** — because a
  key can exist in *both* tiers (evict `note:K` → `archive:K`, then a later `remember(K)` recreates
  `note:K`, since `readEntry` reads `note:` only), and a map would silently collapse the duplicate (G1).
  When `query` is absent, behavior is **byte-identical to today** (exact `key`, else dump-all of core). KDD-4.
- [ ] **D4** **Auto-eviction core→archive** at a cap: after a `remember` write, if core (`note:`) count
  exceeds `coreCap` (default 64, store-overridable), move the **oldest-by-`ts`** core entries to `archive:`
  (delete `note:K`, set `archive:K`) until core ≤ cap. Archive is FIFO-capped at `archiveCap` (default 512).
  So core stays small (always-in-context tier) and the overflow stays searchable (archival tier). Disabled
  when the kill switch (`entriesDisabled()`) is set (legacy bare-string mode keeps today's behavior).
- [ ] **D5** `/memory` subcommands: `recall <query>` (lexical search across both tiers), `archive` (list
  archive key count + keys), `promote <key>` (move `archive:K` → `note:K`). Existing subcommands unchanged.
- [ ] **D6** Tests; **no** new extension (memory count unchanged), **no** capability change (memory stays
  capability-free — the agent's private notebook), **no** kernel change.

## 3. Scope Boundary (NOT in scope)

- **No** vector embeddings / semantic search / an embed-provider — the zero-dep rule forbids it; retrieval
  is **lexical** (`overlapScore`). (The blueprint floated "optional embed-provider" — explicitly cut: it
  needs a network dep + a provider abstraction; lexical is the dependency-free v1.)
- **No** new extension and **no** kernel change — extend `memory.ts` + a shared lib; tiers belong in memory.
- **No** change to the existing `remember`/`recall`(no-query)/`list`/`edit`/`forget`/`rollback`/`consolidate`
  behavior — strictly additive (`query` param, archive tier, eviction). Backward-compatible (KDD-4).
- **No** automatic *promotion* archive→core (only manual `/memory promote`) — auto-promotion needs a
  relevance-trigger policy that is its own design; eviction (core→archive) is the load-bearing direction.
- **No** transformContext auto-injection of recalled memories — memory deliberately cedes context-shaping
  to `compact.ts` (`memory.ts:11-14`); retrieval stays a *tool* the agent calls, not an injected context.
- **No** archive-`forget` in v1: `list`/`edit`/`forget`/`rollback`/`consolidate` stay `note:`-scoped
  (unchanged); deleting an *archived* note is `/memory promote <key>` then `/memory forget <key>` (two
  steps). An archive-scoped forget is a small follow-up if needed. (Confirmed intended for v1.)

## 4. Key Design Decisions

### KDD-1 — Extend `memory.ts`, don't add a new extension
*Problem:* tiers + retrieval — new extension or extend memory? *Options:* (a) a new `memory-archive`
extension; (b) extend `memory.ts`. *Choice:* **(b)** — tiers are intrinsic to *memory*; a second extension
would fragment the notebook (two stores, two tool sets, load-order coupling) and duplicate the `Entry`
plumbing. The existing memory tests are the backward-compat net. *Rejected:* (a) fragments a cohesive
subsystem.

### KDD-2 — Lexical retrieval via a shared `lib/relevance.ts`, no embeddings
*Problem:* retrieval scoring with zero deps. *Options:* (a) vector embeddings (needs a dep/provider);
(b) reuse `handoff`'s `salientTokens` lexical scorer, extracted to `lib/relevance.ts` + an `overlapScore`.
*Choice:* **(b)** — embeddings are forbidden by the zero-dep rule (the audit's hard constraint); the
dependency-free token-overlap scorer already exists and is tested. Extract to `lib/` (the `lib/decode.ts`
/`lib/sandbox.ts` convention) so `handoff` and `memory` share one scorer, not two copies. *Rejected:* (a)
violates zero-dep; inlining a second copy duplicates security-irrelevant-but-shared logic.

### KDD-3 — Two tiers with auto-eviction core→archive (Letta core/archival)
*Problem:* a flat notebook grows unbounded and dilutes "what's important now." *Options:* (a) one flat
tier with a cap (drop oldest); (b) core (`note:`, small, always-available) + archive (`archive:`, large,
searchable), evicting oldest core→archive. *Choice:* **(b)** — the Letta model: core stays small and
self-edited; overflow is *retained and searchable* in archive (reachable via `recall(query)`) up to the
far-larger `archiveCap` (512), only FIFO-dropping beyond that (R2). *Rejected:* (a) drops overflow at the
*core* cap (64) and offers no retrieval — (b)'s loss bound is ~8× higher AND it adds search.

### KDD-4 — Strictly additive: `query` is optional, no-query path byte-identical
*Problem:* don't regress the existing notebook. *Options:* (a) replace `recall`'s semantics with search;
(b) add `query` as an optional param, leaving exact-key + dump-all untouched. *Choice:* **(b)** — the
existing `recall(key)` / `recall()` paths (and all `/memory` subcommands) stay byte-identical, so the
memory test suite is the regression net; `query` is purely additive. Eviction only runs in the
non-legacy (entries-enabled) path. *Rejected:* (a) breaks every existing caller + test.

### KDD-5 — Eviction = oldest-by-`ts`; archive FIFO-capped
*Problem:* which core entries to evict, and bound the archive. *Options:* (a) LRU (needs access tracking);
(b) oldest-by-`ts` (the `Entry.ts` already exists). *Choice:* **(b)** — `ts` is already stored
(`memory.ts:44`); oldest-first is a good proxy for "least currently relevant" without new access-tracking
state, and archive is FIFO-capped so it too stays bounded. *Rejected:* (a) needs new per-entry access
state for marginal gain.

## 5. Dependencies and Assumptions

Depends on `handoff.ts`'s `salientTokens`/`STOPWORDS` (moved, not rewritten) and `memory.ts`'s `Entry`/
store helpers. Assumes the store is disk-backed under the host (it is — `FileBackend`) so tiers persist.
Edge: a legacy bare-string note read as `Entry` has `ts: ""` (`memory.ts:70`) which sorts oldest; in the
non-legacy (entries-enabled) mode any such pre-existing bare entry would be evicted first — acceptable
(eviction *moves* it, no loss), and the kill-switch (legacy) mode evicts nothing at all.
Assumes lexical overlap is an adequate retrieval signal for short notes (it is for keyword recall; semantic
recall is out of scope, KDD-2). No network, no deps. Independent of the other Wave-7 subsystems (7a
time-travel, 7c OTel).

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P3.2; research §D. Extends `2026-06-22`-era `memory.ts`; relocates
`handoff.ts`'s lexical scorer to a shared lib (handoff behavior preserved). Orthogonal to `compact.ts`
(which owns context-shaping/compaction — memory does not inject context, KDD/§3). README `memory` row gets
an updated description (tiers + query recall); reconciled at F. No ext-count change, no kernel change.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing 1023 + new).
- **AC-3 (lib extract parity)** After moving `salientTokens`/`STOPWORDS` to `lib/relevance.ts`,
  `test/handoff.test.ts` passes **unchanged** (same imported names via re-export).
- **AC-4 (lexical query retrieval)** With several notes, `recall({query})` returns a **ranked list**
  `[{key,tier,text,score}]` of the entries sharing the most salient tokens with the query, top-K, score>0
  only; a query with no overlap returns an empty/"no matches" result (not a dump). A key present in **both**
  tiers appears as **two distinct list entries** (no map collapse — G1). Pure `overlapScore` unit-tested.
- **AC-5 (backward compat — byte-identical no-query path)** `recall({key})` (exact) and `recall({})`
  (dump-all of core) behave exactly as before this wave; the existing memory tests pass unchanged.
- **AC-6 (auto-eviction core→archive)** With `coreCap` small, adding notes past the cap moves the
  **oldest** core notes to `archive:` (core count ≤ cap; the evicted note is gone from `note:`, present in
  `archive:`), and `recall({query})` still finds the evicted note (cross-tier search). Legacy/kill-switch
  mode does **not** evict.
- **AC-7 (promote)** `/memory promote <key>` moves `archive:K` → `note:K`; `/memory archive` lists the
  archive keys. Existing `/memory` subcommands unaffected.
- **AC-8 (no new surface)** Host canonical-set test green: extension count **unchanged** (no new
  extension), no new capability, no kernel change (`kernel-surface` unaffected, 2182).

*Quality budget:* retrieval is O(entries × tokens) token-overlap over the capped tiers per `recall(query)`
call (a tool call, not a hot loop); bounded by `coreCap`+`archiveCap`. Negligible. Excluded.

## 8. Risks and Rollback

- **R1 — Lib extract regresses handoff.** *Mitigation:* AC-3 (`test/handoff.test.ts` unchanged) + move-not-
  rewrite. *Rollback:* re-inline `salientTokens` in handoff.
- **R2 — Eviction loses a note the user expected in core.** *Mitigation:* eviction *moves* to archive (no
  data loss **until `archiveCap`** — still in `recall(query)` + `/memory archive` + `/memory promote`);
  oldest-first; core cap is generous (64) + store-overridable; disabled in legacy mode. Past `archiveCap`
  (512) the oldest *archived* entry is FIFO-dropped — a generous bound, but genuine loss at that edge
  (documented, not silent in `/memory archive`'s count). *Rollback:* raise `coreCap`/`archiveCap` very high
  (no eviction/drop) or the kill switch.
- **R3 — Backward-compat break in `recall`/`/memory`.** *Mitigation:* KDD-4 additive `query`; AC-5 + the
  existing memory tests are the net. *Rollback:* drop the `query` branch.
- **R4 — Lexical recall misses a semantically-related note** (no embeddings). *Mitigation:* documented
  scope (KDD-2); lexical keyword recall is the v1; an embed-provider tier is a deferred follow-up.
  *Rollback:* n/a.
- **R5 — README `memory` row stale.** *Mitigation:* reconcile at F.

A shared lib + additive changes to one existing extension; reverting the `query`/archive/eviction
additions restores the prior flat notebook, and re-inlining the lib restores `handoff`.

## L1 Review Log

- **Round 1** — zero severe + 3 general (G1 `recall(query)` flat `{key→text}` map collapses a key present
  in both tiers → ranked **list**; G2 R2 "no data loss" contradicted `archiveCap` FIFO → scoped "until
  archiveCap"; G3 STOPWORDS wording — it's a private const, not exported) + clarifications (key+query
  precedence = key short-circuits; "self-editing" softened; archive-forget = promote+forget v1; ts
  citation; legacy `ts:""` edge). All folded.
- **Round 2** — zero severe + 1 general (G2 fix not propagated to KDD-3's "(not dropped)"). Fixed.
- **Round 3** — **zero severe, zero general.**
- **Round 4 (corroborating)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
