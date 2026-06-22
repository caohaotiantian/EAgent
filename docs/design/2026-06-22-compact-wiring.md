# Design: make `compact` live and retire `memory`'s count-based compaction (`compact-wiring`)

Status: open
Slug: `2026-06-22-compact-wiring`

## 1. Background and Purpose

`compact` (`src/extensions/compact.ts`) shipped **dormant**. Its own design doc
(`docs/design/2026-06-22-compact.md`) closed with two explicitly deferred
deliverables (`2026-06-22-compact.md:6`, `:88-94`): host registration and the
CLAUDE.md/README inventory line. The deferral was not laziness — it is a
**sequencing constraint** spelled out in that doc's R1 (`:431-453`) and D3
(`:157-202`): `compact` **cannot** be enabled in isolation.

The hazard is concrete. Both `memory` and `compact` register a
`transformContext` filter, and filters run **in registration order**, each
receiving the previous one's output (`hooks.ts:64-76`, `:102-110`). In
`BUILTIN_EXTENSIONS`, `memory` loads at index 7 (`host.ts:81`), before any
extension appended later. `memory`'s hook (`memory.ts:327-339`) folds
**unconditionally** whenever `messages.length > threshold` (default 12,
`memory.ts:28`) keeping the last `keepRecent` (4) — and, unlike `prune`, it has
**no** `meta.kind:"summary"` guard (only `prune` breaks on the marker,
`prune.ts:61`). So if `compact` were merely appended, `memory`'s hook would fire
**first**, collapse the prefix to ~5 messages, and hand `compact` a transcript
already under its 60k budget (`compact.ts:37`) — making `compact` a **silent
no-op** (`2026-06-22-compact.md:182-202`).

This task makes `compact` **live** by doing the two things that must happen in
the *same* change: (1) register `compact` in `BUILTIN_EXTENSIONS` on the
`transformContext` seam, and (2) **retire `memory`'s count-based
`transformContext` compaction hook** so a single token-aware compactor owns the
seam. Everything else in `memory` — the `remember`/`recall` scratchpad, the
white-box per-entry provenance with `/memory list|edit|forget|rollback|
consolidate`, and the `/memory` config view — is **kept untouched**. This adds
**no new behavior**; it activates `compact` and removes the competing path, the
follow-up `compact`'s own design deferred.

## 2. Deliverables

- [ ] `src/host.ts` — `compact` imported and added to `BUILTIN_EXTENSIONS`,
      placed on the `transformContext` seam immediately **after** `prune`
      (`host.ts:82`), i.e. after `["memory", memory]`, `["prune", prune]`. Load
      order justified in D2.
- [ ] `src/extensions/memory.ts` — the count-based `transformContext`
      compaction hook (`memory.ts:326-340`) **removed** (only that hook). The
      `summarize`/`summaryFor`/`summaryMessage`/`fingerprint`/`SummaryCache`
      machinery and the `SUMMARY_SYSTEM_PROMPT`/`CACHE_KEY`/`renderFallback`/
      `textOf` symbols that become dead with it are removed too. The
      `DEFAULT_THRESHOLD`/`DEFAULT_KEEP_RECENT` constants and the `config()`
      closure are **kept** — they are *not* dead: the surviving `/memory` no-arg
      view still reads them to print `threshold=…/keepRecent=…`
      (`memory.ts:379`, `:382`) (D3 scopes exactly what dies vs survives). The
      `remember`/`recall` tools, the `note:` scratchpad, the white-box
      provenance/`Entry`/`runScratchpad` path, and the `/memory` command stay
      byte-equivalent in behavior.
- [ ] `src/extensions/memory.ts` — the `/memory` no-arg view's **cached-summary
      print block** is deleted: the `e.store.get<SummaryCache>(CACHE_KEY)` read
      (`memory.ts:380`) and the `cached summary: …` print it feeds
      (`memory.ts:383-387`) go away with `SummaryCache`/`CACHE_KEY`. This is a
      **required consequent edit** — leaving `:380`/`:383-387` referencing the
      now-deleted `SummaryCache`/`CACHE_KEY` symbols breaks `npm run typecheck`.
      The surrounding no-arg lines (`threshold=…/keepRecent=…` at `:382`, `notes:`
      at `:388`) and every sub-command are unchanged; the view loses only the one
      `cached summary` line (D3).
- [ ] `src/extensions/memory.ts` — `memory`'s now-orphaned `/compact` command
      (`memory.ts:344-366`) is **removed**; `/compact` is owned solely by
      `compact` (D3 of `2026-06-22-compact.md` had `compact` *shadow* it; once
      `memory`'s hook is gone the shadowed command would only be a confusing
      fallback on `compact` unload — see D4 below).
- [ ] `test/memory.test.ts` — the three count-compaction tests
      (`below threshold` `:70`, `above threshold` `:90`, `caching` `:114`),
      the `compaction does not mutate the persistent transcript` test (`:170`),
      the `/memory ... /compact folds` test (`:190`) and the
      `/compact with too few messages` test (`:221`) **dropped or adjusted** to
      stop asserting the removed hook/command. **One** white-box test also touches
      the removed command: `AC 12: host.unload removes registrations` (`:536-549`)
      asserts `h.commands.get("compact")` is registered (`:541`) and `undefined`
      after unload (`:548`); since `memory` no longer registers `/compact`, both
      assertions are **deleted** (memory provides no `/compact` to assert on).
      Every other white-box/scratchpad assertion across `:292-549` **stays green**
      unchanged — only those two lines move.
- [ ] `test/compact.test.ts` — a new **co-load regression test**: load
      `memory` + `compact` together via `host.use` (no injector — see D4), drive
      an over-budget transcript through the live `transformContext` chain, and
      assert (a) exactly **one** `summary` message, (b) it is
      `meta.source === "compact"` (proves `compact` owns the seam and `memory`
      did **not** count-compact), and (c) the recent user turns survive. (AC-1.)
- [ ] `test/compact.test.ts` — the deferred cosmetic finding closed: a test for
      the `/compact force` **under-budget preview** branch — a foldable boundary
      exists but the transcript is under budget, so `force` prints the
      `"once the transcript next goes over budget"` phrasing
      (`compact.ts:374-382`). (AC-6.)
- [ ] `EAGENT_COMPACT` kill switch unchanged and verified live: registration
      does **not** flip the default; `compact` stays off-by-default
      (`compact.ts:168-169`). (D5, AC-4.)
- [ ] CLAUDE.md inventory line for `compact` rewritten (no longer "not yet wired
      / dormant"; now a registered, off-by-default built-in) and `memory`'s line
      updated to drop "count-based compaction" (`CLAUDE.md:64`, `:196-201`).
- [ ] README: `memory` row (`README.md:201`) updated to drop `/compact` and the
      "context compaction" claim; a `compact` row added; the built-in count
      `41 → 42` (`README.md:334`). Reconciled at closeout.

## 3. Scope Boundary (NON-goals — Simplicity First)

- **Not** a rewrite of `compact.ts`. The extension is finished and tested; this
  task only wires it and removes its competitor. No new compaction behavior,
  budgets, slots, or pinning logic is added.
- **Not** a removal of `memory`'s scratchpad/white-box/`/memory` surface. Only
  the count-based `transformContext` hook (and its now-dead helpers and the
  orphaned `/compact` command) are removed. `remember`/`recall`, `note:`
  entries, provenance, `list|edit|forget|rollback|consolidate`, and the
  `EAGENT_MEMORY_ENTRIES` kill switch are untouched (D3).
- **Not** an enable-by-default flip. `compact` stays opt-in
  (`compact.ts:168-169`); registration only makes it **available** (D5).
- **Not** a change to `prune`. `prune` keeps truncating tool-output bytes and
  keeps stopping at the `summary` marker (`prune.ts:61`); the `compact`/`prune`
  interplay (`compact` emits `meta.kind:"summary"`, `prune` honors it) is
  already designed (`2026-06-22-compact.md:352-356`) and unchanged.
- **Not** a new capability. Neither the seam (read/transform only) nor
  `memory`'s surviving scratchpad needs one (`memory.ts:402-404`,
  `2026-06-22-compact.md:118`).
- **No** migration or compatibility shim for the removed `memory` hook. There is
  no on-disk state for the compaction path other than the `summaryCache` store
  key, which simply goes unread (harmless dead key; not worth a cleanup pass).

## 4. Key Design Decisions

### D1 — Retire `memory`'s count-compaction entirely vs keep both compactors

- **Problem:** with `compact` registered, two `transformContext` filters would
  both fold the older prefix. Keep both, or remove `memory`'s?
- **Options:** (a) keep both hooks registered (they coexist); (b) remove
  `memory`'s count-based hook, leaving `compact` the sole conversation
  compactor.
- **Choice:** (b) — remove `memory`'s. `compact` is the token-aware
  structured-slot **successor** to `memory`'s count-based path
  (`compact.ts:13-22`, `2026-06-22-compact.md:43-46`). Per the house "newer /
  more-tested compactor wins, never run two" rule (`2026-06-22-compact.md:
  166-167`), `compact` owns the seam.
- **Why (a) rejected:** it is the **documented hazard**. `memory` loads first
  (`host.ts:81`), its hook has no marker guard (`memory.ts:327-339`,
  cf. `prune.ts:61`), so it would fire first, collapse the prefix under the 60k
  budget, and make `compact` a silent no-op — and on a later turn re-fold an
  array already holding a `compact` summary, burning a sub-call and degrading
  fidelity (`2026-06-22-compact.md:175-202`, R1 `:431-440`). Two compactors on
  one seam is precisely what the seam's "one strategy at a time" contract
  forbids (`memory.ts:13-19`).

### D2 — `compact`'s load-order slot in `BUILTIN_EXTENSIONS`

- **Problem:** where in the load order does `compact` go, relative to `memory`,
  `prune`, and the injectors (`skills`/`microagents`/`context-files`)?
- **Options:** (a) before `memory`/`prune`; (b) immediately after `prune`
  (index 9, right after `["prune", prune]` at `host.ts:82`); (c) at the end of
  the array, after all injectors and guards.
- **Choice:** (b) — append immediately after `prune`. Filters run in
  registration order (`hooks.ts:102-110`), so `compact` runs **after** `prune`:
  `prune`'s cheap, provider-free byte-trim of oversized tool results
  (`prune.ts:50-82`) gets the first crack, and `compact`'s paid sub-call only
  fires if the *conversation itself* is still over its (higher, 60k vs prune's
  40k protect floor — `compact.ts:37`, `prune.ts:23`) budget. `compact` produces
  the `meta.kind:"summary"` marker `prune` already honors
  (`compact.ts:229`, `prune.ts:61`); putting `compact` after `prune` means a
  fold that `compact` writes is seen by no *later* `prune` pass in the same
  chain, but the marker interplay is order-independent because each turn re-runs
  the whole chain over fresh `[...this.#messages]` (`agent.ts` apply site;
  `2026-06-22-compact.md:294-301`).
- **Why (a) rejected:** running `compact` *before* `prune` would summarize
  dialogue before `prune` ever trims tool-output bytes — inverting the
  cheap-defense-first ordering and paying for a sub-call `prune` might have made
  unnecessary.
- **Why (c) rejected:** placing `compact` at the very end runs it *after* the
  injectors (`skills`/`microagents`/`context-files`), so a freshly injected
  note could fall into the older slice and be summarized. The `compact` design
  judges this **benign** (injections are small and re-injected each turn, and
  `compact` splits at user-turn boundaries — `2026-06-22-compact.md:448-453`),
  but slotting `compact` next to the other size-managers (`memory`/`prune`)
  keeps the "size managers cluster, injectors after" reading of the array and is
  where the seam's compaction strategy conceptually lives. The co-load test
  (D4/AC-1) proves no double-compaction regardless of which of (b)/(c)
  is chosen; (b) is the clearer grouping.

### D3 — Surgical removal: only the count-compaction hook, keep everything else

- **Problem:** `memory.ts` interleaves the compaction path with the scratchpad
  and white-box paths. What exactly is removed vs kept?
- **Options:** (a) delete `memory.ts` wholesale and re-home the scratchpad; (b)
  surgically remove only the count-based `transformContext` hook
  (`memory.ts:326-340`) plus the symbols that become dead with it, and the
  orphaned `/compact` command (`memory.ts:344-366`).
- **Choice:** (b) — surgical. **Removed:** the `e.hook("transformContext", …)`
  block (`memory.ts:326-340`); the `/compact` command (`memory.ts:344-366`); and
  the helpers that become unreachable once both are gone —
  `summarize` (`:273-288`), `summaryFor` (`:296-315`), `summaryMessage`
  (`:317-322`), `fingerprint` (`:236-244`), the `SummaryCache` interface
  (`:42-48`), `renderFallback` (`:500-516`), the bottom `textOf` (`:488-493`),
  and the constants `SUMMARY_SYSTEM_PROMPT` (`:32-34`) and `CACHE_KEY` (`:37`).
  **Kept verbatim in behavior:** `remember`/`recall` (`:406-474`), the `note:` scratchpad, the
  `Entry`/`readEntry`/`noteKeys`/`findById`/`normalize`/`runScratchpad`
  white-box path (`:62-228`), the `DEFAULT_THRESHOLD`/`DEFAULT_KEEP_RECENT`
  constants (`:28-29`) and the `config()` closure (`:247-250`) — a surviving
  caller **does** remain: the `/memory` no-arg view (`:379`, `:382`); the
  `/memory` command (`:368-400` — its no-arg view loses **only** the
  `cached summary` line. Because `SummaryCache`/`CACHE_KEY` are gone, the block
  that read and printed that line — the `CACHE_KEY` read at `:380` and the
  `cached summary: …` print at `:383-387` — **must be deleted in the same edit**
  (enumerated as its own §2 deliverable), else `:380`/`:383-387` are dangling
  references that fail `npm run typecheck`. The `threshold=…/keepRecent=…` line at
  `:382`, the `notes:` count at `:388`, and the sub-commands are unchanged), the
  `newId` generator (`:258-260`), the
  `EAGENT_MEMORY_ENTRIES` kill switch (`:79-81`), and the never-throw dispose
  loop (`:476-484`).
- **Why (a) rejected:** wholesale deletion would re-home a fully-tested
  scratchpad (`memory.test.ts:292-549`, AC 1–15) for no benefit and would churn
  `host.ts`/CLAUDE.md/README far beyond this task's purpose — the opposite of
  Simplicity First and a needless regression surface.

### D4 — Co-load regression test proves no double-compaction (no injector)

- **Problem:** the `compact` suite tests `compact` in isolation
  (`2026-06-22-compact.md:376-377`). After this change, the live agent runs
  `memory` + `compact` on the same seam. What proves the seam is correct (the D1
  hazard — two compactors — is gone)?
- **Options:** (a) only assert command shadowing (AC-10 of the compact doc,
  `compact.test.ts:437-452`); (b) a co-load hook test with `memory` + `compact`
  (no injector); (c) a co-load hook test with `memory` + `compact` + an injector,
  asserting the injected note *survives* compaction.
- **Choice:** (b). Load `memory` + `compact` via `host.use`, run an over-budget
  transcript through `h.agent.hooks.apply("transformContext", …)`
  (the `compact.test.ts:96-98` helper), and assert: exactly one `summary` message;
  its `meta.source === "compact"` (not `"memory"`); and the recent user turns
  survive verbatim. This is the runnable proof that (i) `memory` no longer
  count-compacts (its hook is gone, so no `memory`-sourced summary appears) and
  (ii) `compact` owns the seam. No injector is needed for *this* property.
- **Why (a) rejected:** command shadowing says nothing about the **hooks**
  running together — the actual hazard (D1) is two hooks on one seam, which a
  command-only test cannot observe.
- **Why (c) rejected:** its proposed "the injected note survives" assertion is
  mechanically false. Skills/microagents prepend their note at array index 0,
  which is in `compact`'s OLDER slice `[0, idx)` (`compact.ts:99-114` protects only
  the last `keepTurns` USER turns), so `compact` FOLDS it into the summary — the
  `compact` design itself states this is benign (`2026-06-22-compact.md:448-453`).
  An injected note therefore does NOT survive, so (c) cannot prove what it claims.
  `compact`'s user-turn-boundary split (it never severs a tool_call/tool_result
  pair, and the recent window is protected) is `compact`'s OWN property, already
  covered by `compact`'s isolated tests; this wiring task's regression need is only
  *no double-compaction*, which (b) proves without an injector.

### D5 — `compact` stays off-by-default once registered

- **Problem:** registration makes `compact` **available**. Should it also be
  **enabled** by default?
- **Options:** (a) off by default (registration only loads it;
  `EAGENT_COMPACT=off` hard kill, `e.store.set("enabled", true)` / `/compact on`
  to enable); (b) on by default.
- **Choice:** (a) — off by default, unchanged from `compact.ts:168-169`.
  Registration just loads the extension; the `enabled` store flag defaults
  `false` and the `EAGENT_COMPACT=off` env kill is read inside the hook
  (`compact.ts:168-169`, `:247`). This mirrors `risk-guard`'s posture
  (off-by-default, opt-in) exactly as `compact`'s own D7 argues
  (`2026-06-22-compact.md:273-287`): it makes a **paid, latency-adding model
  sub-call** and **rewrites the context the model sees**, so it must be opt-in.
- **Why (b) rejected:** flipping it on by default at the moment of registration
  would silently impose a summarization sub-call and a context rewrite on every
  long session — a surprising cost and behavior change, and a regression versus
  the prior world where `memory`'s count-compaction was free (provider-call-wise
  it summarized, but the new default would be a *behavioral* surprise without an
  opt-in). `prune` can default-on because it is provider-free
  (`prune.ts:11-16`); `compact`, like `risk-guard`, cannot. Off-by-default also
  keeps this task strictly an *availability* change, not a *behavior* change —
  the Simplicity-First framing.

### D6 — Remove `memory`'s `/compact` command vs leave it as an unload fallback

- **Problem:** `compact`'s D3 (`2026-06-22-compact.md:157-178`) had `compact`'s
  `/compact` *shadow* `memory`'s (last-wins, `commands.ts:42-44`), so unloading
  `compact` restored `memory`'s. With `memory`'s **hook** gone, what should
  `memory`'s orphaned `/compact` command do?
- **Options:** (a) keep `memory`'s `/compact` command as a fallback restored on
  `compact` unload; (b) remove `memory`'s `/compact` command entirely so
  `compact` is its sole owner.
- **Choice:** (b) — remove it. Once `memory`'s count-compaction hook is gone, its
  `/compact` command (`memory.ts:344-366`) calls `summaryFor(…, force:true)`
  against a **cache nothing reads** — it would summarize and re-cache, but the
  hook that consumed the cache no longer exists, so the command does paid work
  with **zero effect on the transcript**. Leaving it as an "unload fallback"
  restores a command that silently does nothing useful — a confusing trap.
  Removing it makes `compact` the single, honest owner of `/compact`.
- **Why (a) rejected:** a fallback that runs a paid sub-call and changes nothing
  is worse than no fallback. It also means `compact.test.ts:437-452` (AC-10,
  which asserts `memory`'s `/compact` is *restored* on unload) must change — and
  changing it to assert "no `/compact` after unloading `compact` when `memory`'s
  is removed" is the correct, less-surprising contract. (This is a pure
  consequence of removing the hook, not new behavior.)

## 5. Dependencies and Assumptions

- **Hook surface:** `transformContext` is a kernel filter applied each turn over
  a fresh `[...this.#messages]` copy; returning a new array never mutates the
  durable transcript (`2026-06-22-compact.md:327-330`, `:294-301`). Filters run
  in registration order, each receiving the prior's output
  (`hooks.ts:64-76`, `:102-110`). Assumed stable.
- **Command registry:** last-registered wins (`commands.get` returns `.at(-1)`,
  `commands.ts:42-44`); disposing a command splices it out by identity
  (`commands.ts:31-39`). Both already relied on by `compact`.
- **`compact.ts` is unchanged and correct:** all its acceptance criteria pass in
  isolation today (`test/compact.test.ts`). This task adds no `compact` code; it
  only registers it and adds two tests (co-load + the under-budget `force`
  preview branch).
- **`memory`'s scratchpad/white-box tests are independent of the compaction
  path:** they execute tools and `/memory` sub-commands directly
  (`memory.test.ts:292-549`), never asserting the removed hook, so they stay
  green after the surgery.
- **`makeHarness` is the test instrument** (`test/helpers.ts:38-58`): a
  `MemoryBackend` store, a scriptable `MockProvider`, and `host.use` loading. The
  co-load test scripts the provider to branch on the summarization system prompt
  (`/summar/i`) exactly as `memory.test.ts:30-32` and `compact.test.ts:29-32` do.
- **House rules:** ESM with `.js` specifiers even for `.ts`; strict TS
  (`noUncheckedIndexedAccess`, no `any`); zero runtime deps beyond `jiti`;
  offline `node:test` against `MockProvider`; the `EAGENT_COMPACT` kill switch;
  a dispose loop that never throws (`compact.ts:396-404`).
- **Assumption:** the only on-disk `memory` state tied to the removed hook is the
  `summaryCache` store key; leaving it unread is harmless. No migration needed.

## 6. Relationship with Existing Designs

This is the **follow-up that `compact`'s own design deferred**
(`docs/design/2026-06-22-compact.md:6`, `:88-94`, R1 `:440-447`). It is **not** a
first design and adds **no** new behavior.

- **`src/extensions/compact.ts`** + **`docs/design/2026-06-22-compact.md`** — the
  dormant extension being wired live. Its R1 (`:431-453`) and D3 (`:157-202`)
  prescribe *exactly* this change: register `compact` **and** retire `memory`'s
  count hook in one change, and add a co-load regression test once the hook is
  gone (`:446-447`). No conflict — this completes that doc's deferred
  deliverables and closes its deferred cosmetic finding (`:6`).
- **`src/extensions/memory.ts`** — the count-compaction hook (`:326-340`) and
  orphaned `/compact` command (`:344-366`) are removed here. **CONFLICT
  (resolved):** `memory` previously owned `/compact` and emitted a
  `summary`-marked message; after this change `compact` is the sole `/compact`
  owner and the sole conversation compactor. The scratchpad/white-box/`/memory`
  surface is untouched.
- **`src/extensions/prune.ts`** — unchanged. `compact` emits the
  `meta.kind:"summary"` marker (`compact.ts:229`) that `prune` stops at
  (`prune.ts:61`); load order (D2) puts `compact` after `prune`.
- **`src/host.ts`** — `BUILTIN_EXTENSIONS` (`:73-115`) gains `compact` after
  `prune` (`:82`); the count `41 → 42`.

DEDUP statement: this task **activates** `compact` and **removes** the competing
`memory` path. It is the integration half of the `compact`/`memory`/`prune`
compaction lineage; no parallel design covers it.

## 7. Acceptance Criteria (measurable / automatable)

All via `makeHarness` + `host.use`, offline, scripting the `MockProvider`.

1. **Co-load: `compact` owns the seam, `memory` does not count-compact.** Load
   `memory` and `compact` (no injector — see D4) via
   `host.use`; feed an over-budget transcript (`compact.test.ts:118-135`
   `overBudget()`) through `h.agent.hooks.apply("transformContext", msgs,
   {turn:0, model:"mock"})`. Assert: `out.filter(m => m.meta?.kind ===
   "summary").length === 1` **and** that one summary has `meta.source ===
   "compact"` (never `"memory"`), **and** the last 3 user-turn tags
   (`recent-A/B/C`) survive verbatim.
2. **`memory` registers no `transformContext` hook.** After
   `host.use("memory", memory)` on a fresh harness, the count of
   `transformContext` listeners equals the baseline before loading `memory`
   (assert `h.agent.hooks.listenerCount("transformContext")` is unchanged by
   loading `memory` alone).
3. **`memory`'s scratchpad/white-box still work.** Every test in
   `memory.test.ts:292-549` (AC 1–15: provenance, remember/recall round-trip,
   `list|edit|forget|rollback|consolidate`, the `EAGENT_MEMORY_ENTRIES` kill
   switch, FileBackend round-trip, clean unload) passes — all unchanged **except**
   `AC 12: host.unload removes registrations` (`:536-549`), whose two `/compact`
   assertions (`:541`, `:548`) are deleted because `memory` no longer registers
   `/compact`; the rest of that test (remember/recall/`/memory` register-and-
   unload) is untouched. Runnable: the `memory.test.ts` file is green with the
   count-compaction tests removed and those two AC-12 lines dropped.
4. **`compact` is off by default after registration.** With `EAGENT_COMPACT`
   unset and no `enabled` store flag, an over-budget transcript through the seam
   yields `summaries(out).length === 0`; after `e.store.set("enabled", true)` the
   same transcript yields `1` (the existing `compact.test.ts:395-414` AC-8,
   re-run with `compact` loaded as a built-in path).
5. **`/compact` is owned solely by `compact`; no stale `memory` fallback.** After
   loading `memory` then `compact` via `host.use`, `commands.get("compact")`
   resolves to `compact`'s command (distinct description). After
   `host.unload("compact")`, `commands.get("compact") === undefined` (memory no
   longer provides one). Runnable assertion replacing
   `compact.test.ts:437-452`.
6. **`/compact force` under-budget preview branch (deferred finding).** Seed a
   transcript with a foldable boundary but **under** the 60k budget (e.g. 4+
   short user turns), run `/compact force`, and assert the printed line matches
   `/once the transcript next goes over budget/` (the
   `compact.ts:374-377` `when` branch) **and** `count.sub === 0` (no sub-call —
   `force` is pure-`splitIndex`, `compact.ts:357-360`).
7. **Full suite green.** `npm test` and `npm run typecheck` both pass after the
   surgery — no dangling import, no unused symbol, no failing assertion.

## 8. Risks and Rollback

- **R1 — removing `memory`'s count-compaction changes `memory`'s documented
  behavior.** A long session that previously folded at 12 messages no longer does
  so via `memory`. **Mitigated:** the removal is **surgical** (D3) — only the
  hook and its dead helpers and the orphaned `/compact` command go; the
  scratchpad/white-box/`/memory` paths are untouched and their tests (AC-3) stay
  green. The replacement compactor (`compact`) is strictly better on the axis
  that matters (token budget, structured slots, pinned block) and is wired in the
  same change. CLAUDE.md/README are reconciled (Deliverables) so the docs never
  claim `memory` compacts.
- **R2 — `compact` becoming live could surprise users.** **Mitigated:** `compact`
  stays **off by default** (D5, `compact.ts:168-169`); registration only makes it
  available. Nothing folds until `EAGENT_COMPACT` is unset *and* `enabled` is set
  (`/compact on`). The co-load test (AC-1) proves no double-compaction when both
  are loaded.
- **R3 — load-order regression (two folders, or wrong order vs `prune`).**
  **Mitigated:** `memory`'s hook is gone (only one folder remains), and `compact`
  is slotted right after `prune` (D2). AC-1/AC-2 are the runnable guards.
- **R4 — a dropped test leaves a coverage hole or a dangling import breaks the
  build.** **Mitigated:** AC-7 (`npm test` + `npm run typecheck` green) is the
  gate; removed symbols are enumerated in D3 so the typecheck catches any
  survivor reference.
- **Rollback (graduated):**
  1. `EAGENT_COMPACT=off` — env hard kill read inside `compact`'s hook
     (`compact.ts:168-169`); `compact` never fires. (`memory`'s hook stays
     removed, so the seam is simply un-compacted by conversation — `prune` still
     trims tool-output bytes.)
  2. `/compact off` (or `e.store.set("enabled", false)`) — runtime disable of
     `compact` without touching the env.
  3. Remove `compact` from `BUILTIN_EXTENSIONS` and restore `memory`'s hook and
     `/compact` command — full revert of this change; the dispose loops on both
     extensions never throw (`compact.ts:396-404`, `memory.ts:476-484`).
