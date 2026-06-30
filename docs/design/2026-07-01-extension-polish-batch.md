# Light-Mode brief — extension polish batch (RW8a-2, RW7b-2, RW7a-3)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-01
Deferred: none (RW8a-2, RW7b-2, RW7a-3 all resolved).

**Slug:** `2026-07-01-extension-polish-batch` · **Tier:** Light. Three independent, trivial,
byte-identical-when-unused polish changes, each in its own extension + test (precedent:
`docs/design/2026-06-30-deferred-cleanup-batch1.md` bundled 3 unrelated small fixes as one Light task).
Source: `docs/DEFERRED-FOLLOWUPS.md` RW8a-2 / RW7b-2 / RW7a-3. Branch: `chore/finish-deferred-followups`.

> **File-count note for the fresh-eyes tier check:** this touches **6 files** (3 src + 3 test), above
> the literal "≤3 non-load-bearing files" line — but each change is an independent, additive, low-risk
> polish item (no breaking change, no new contract beyond one optional tool param + one new command
> verb, no migration, no unresolved/threshold decision), matching the batch-1 precedent. (The fresh
> Light reviewer re-ran the Full-Mode gate against the diff and confirmed Light is correct.)

## What / why

Three closed-out polish follow-ups, each a separate file:

- **RW8a-2 — `tree_search` early goal-termination** (`src/extensions/reasoning-search.ts`). `tree_search`
  always runs to `depth`; the global best-so-far is already tracked across all depths. Add an
  **optional** `goalScore?: number` param: after the per-depth best update + `details.push`,
  `if (goalScore !== undefined && best && best.score >= goalScore) break;` — stop once a thought scores
  at/above the bar, saving fork cost on easy problems. **Default-absent ⇒ byte-identical** depth-bounded
  behavior.

- **RW7b-2 — `memory` archive-scoped forget** (`src/extensions/memory.ts`). Deleting an archived note
  today takes two steps (`/memory promote <key>` then `/memory forget <id>`). Add a **new** switch verb
  `forget-archive <key>` that deletes `ARCHIVE_PREFIX + key` directly (mirroring the `promote` case:
  `readArchive` existence check, not-found message, `store.delete`), and extend the command description
  + the `default`-case usage string. A **new** verb (NOT an overload of the id-based `forget`).

- **RW7a-3 — `time-travel` command polish** — the one item with a real (if low-impact) defect. (a) An
  ambiguous bare-step selector printed **two contradictory lines** (`resolve()`'s `ambiguous step …`
  then the caller's `no such checkpoint: …`). Fix: `resolve()` returns `Node | "ambiguous" | undefined`;
  `/rewind` + `/fork` add `if (node === "ambiguous") return;` **before** the not-found print — so an
  ambiguous step prints exactly **one** line. (b) `/fork` lacked the `cfg().enabled` guard that
  `/timetravel checkpoint` has, so enable→create→disable→`/fork` still **wrote** a branch node. Fix: add
  the same `if (!cfg().enabled) { print(off); return; }` at the top of `/fork`.

## Explicit non-goals (Simplicity First)

- **RW8a-2:** no goal *classifier* / no per-scorer goal semantics — just a numeric threshold; default
  path unchanged; no change to the bounding/recursion guards.
- **RW7b-2:** not overloading `/memory forget`; no auto-archive-GC; no change to
  `archive`/`promote`/`recall`/eviction.
- **RW7a-3:** `resolve()` only gains the `"ambiguous"` sentinel; the resolution logic is unchanged. Only
  `/fork` gets the `enabled` guard (it is the one that **writes** a node) — `/rewind` is a read+restore
  that creates no node, so it is intentionally left unguarded.
- **All three:** no kernel change; no new capability/env/kill-switch; no dependency.

## Any >1-option decision surfaced

- **RW7b-2 verb form** — new `forget-archive <key>` verb (chosen) vs overloading `/memory forget`.
  Chosen the new verb: id-based vs key-based deletion have different argument shapes, so overloading
  would be ambiguous; a distinct verb matches the existing `promote <key>` shape.
- **RW7a-3 enabled-guard scope** — `/fork` only (chosen) vs `/fork`+`/rewind`. Chosen `/fork` only: the
  defect is a *write* while disabled; `/rewind` writes no node.
- (RW8a-2 has no real alternative — an optional threshold + early-break is the additive minimum.)

## Measurable acceptance command

- `node --import tsx --test test/tree-search.test.ts` — `goalScore:1` ⇒ `details.length === 1` (early
  break after depth 0); no `goalScore` ⇒ `details.length === 2`.
- `node --import tsx --test test/memory.test.ts` — seed `archive:<k>`, `/memory forget-archive <k>` ⇒
  the archive note is deleted and the core `note:` keyspace is untouched; an unknown key prints
  not-found.
- `node --import tsx --test test/time-travel.test.ts` — an ambiguous bare-step selector prints exactly
  one line (the `ambiguous step …`, no `no such checkpoint`); `/fork` while disabled prints the
  off-message and writes no node.
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-01. All three items shipped as specified; default paths byte-identical. Light-Mode
fresh review **pass** (Light tier confirmed against the diff — the 6-file count is a batch artifact, no
Full trigger). Gates: tree-search/memory/time-travel **51 pass / 0 fail** (4 new tests), `npm test`
**1151 pass / 0 fail / 1 skip**, typecheck 0, eval 5/5, `src/kernel/` untouched, no new dependency.
(Process note: an earlier copy of this brief was written as an untracked file while a background L3
workflow's dev agent was operating in the main tree, and was clobbered by its git ops; re-created and
committed atomically with the code here.)
