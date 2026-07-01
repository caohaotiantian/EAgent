# Light-Mode brief — memory auto-promotion archive→core (RW7b-3)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-01
Deferred: none (RW7b-3 resolved).

**Slug:** `2026-07-01-memory-auto-promotion` · **Tier:** Light (`src/extensions/memory.ts` +
`test/memory.test.ts`; additive, off by default → byte-identical; no breaking change, no new contract,
no migration; one surfaced default decision). Source: `docs/DEFERRED-FOLLOWUPS.md` RW7b-3. Branch:
`chore/finish-followups-3`.

## What / why

`memory` evicts core→archive at a cap; a frequently-recalled archived note stays in the (searched but
colder) archive tier forever — manual `/memory promote <key>` is the only way back to core. RW7b-3:
**auto-promote** an archived note back to core once it has been returned by `recall` a configurable
number of times (it's "hot").

**Change:** add an optional `recalls?: number` to the archive `Entry`. In `searchTiers`
(`memory.ts:226`, the sole recall path — 2 callers, both the recall command/tool), after ranking, when
a returned match is in the **archive** tier, increment that note's `recalls`; when it reaches
`EAGENT_MEMORY_PROMOTE_AT` (a positive integer), promote it (`store.set(NOTE_PREFIX+key, …)` +
`store.delete(ARCHIVE_PREFIX+key)`, same as manual `/memory promote`), dropping the transient `recalls`.
**Default `EAGENT_MEMORY_PROMOTE_AT=0` (or unset) = disabled** ⇒ recall is byte-identical to today.

## Explicit non-goals (Simplicity First)

- **Off by default.** Auto-promotion is opt-in (the register deferred it pending a policy; a positive
  `EAGENT_MEMORY_PROMOTE_AT` is that policy, operator-chosen). Unset/0 ⇒ recall writes nothing, exactly
  as today.
- **No recency/decay policy, no demotion, no cross-tier score fusion.** A simple monotone recall count
  with a threshold; the count lives in the archive entry and is dropped on promotion.
- **No Entry migration.** Existing archive entries have no `recalls` (read as 0); no stored-shape
  change to core `note:` entries. Core entries are never counted (already in core).
- No change to `overlapScore`, the semantic path (RW7b-1), eviction, or the other `/memory` verbs. No
  new capability, no new dependency, no kernel change.

## Any >1-option decision surfaced

- **Where the counter lives + the default** — (a) a `recalls` field on the archive Entry, incremented in
  `searchTiers`, gated on `EAGENT_MEMORY_PROMOTE_AT > 0`, **default off** (chosen); (b) a separate
  counter keyspace; (c) default-ON with a hardcoded threshold. **Chosen (a) + default-off**: the count
  rides the entry it describes (dropped on promote/forget with the entry), one write per hot recall, and
  **default-off keeps recall byte-identical** — the safe v1 the register asked for (it flagged that
  making `recall` a writer needs a deliberate policy). (b) adds a parallel keyspace to keep in sync; (c)
  imposes an un-asked behavior change + a magic-number threshold on everyone.

## Measurable acceptance command

- `node --import tsx --test test/memory.test.ts` exit 0 — a NEW test: with `EAGENT_MEMORY_PROMOTE_AT=2`,
  seed an `archive:<k>` note, `recall` a query matching it **twice**; after the 2nd recall assert the
  note has moved to core (`note:<k>` exists, `archive:<k>` gone) and its `recalls` counter is dropped; a
  control with `EAGENT_MEMORY_PROMOTE_AT` unset/0 leaves the note in archive after many recalls
  (byte-identical). Restore the env var in `finally`.
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-01. `searchTiers` now wraps a pure `rankTiers` (the prior ranking, verbatim) with
`autoPromote`, which — when `EAGENT_MEMORY_PROMOTE_AT > 0` — bumps each returned archive note's
`recalls` and promotes it to core at the threshold (dropping the counter), mirroring `/memory promote`.
Default (unset/0) ⇒ no store writes, byte-identical recall. `Entry.recalls?` is additive (no migration).
Light-Mode fresh review **pass** (clean first round; `lexicalRank` verified byte-for-byte vs `init`;
all off-cases proven no-op; genuine red→green discriminator; fork-safe). Gates: memory 31 pass,
`npm test` 1160 pass / 0 fail / 1 skip, typecheck 0, eval 5/5, `src/kernel/` untouched, no new
dependency. (Noted non-blocking: manual `/memory promote` leaves a stray `recalls` on a core entry —
cosmetic/inert, out of this scope.)
