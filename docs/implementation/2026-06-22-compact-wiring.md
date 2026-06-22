# Implementation: compact-wiring — make `compact` live and retire `memory`'s count-based compaction

Status: open
Slug: `2026-06-22-compact-wiring`
Design: [`docs/design/2026-06-22-compact-wiring.md`](../design/2026-06-22-compact-wiring.md) (PASSED)

> Read the design first. This guide adds **no requirement** absent from it. Every
> task below traces to a design Deliverable (§2) or Acceptance Criterion (§7);
> the trace is named inline. Where the design and this guide could appear to
> diverge, the design wins.

This is a **single-phase** task. It is an *integration* change, not a feature:
`compact.ts` is finished and tested in isolation; this task **wires it into the
host** and **removes the one competing path** in `memory.ts` so a single
token-aware compactor owns the `transformContext` seam. The two edits MUST land
in the same change (the design's R1 sequencing constraint, §1, D1): registering
`compact` without removing `memory`'s count-hook makes `compact` a silent no-op
(`memory` folds first, under-budget, and hands `compact` nothing to do).

---

## 1. Task Index

Maps every design Deliverable (§2) and Acceptance Criterion (§7) to a task in the
single phase below.

| Design ref | What it asks | Task |
| ---------- | ------------ | ---- |
| §2 D-host, §7 AC-1/AC-2/AC-5 | `compact` imported + added to `BUILTIN_EXTENSIONS`, immediately after `prune` (D2) | T6 |
| §2 D-mem-hook, D1, D3 | Remove ONLY `memory`'s count-based `transformContext` hook + its now-dead helpers/constants | T7 |
| §2 D-mem-noarg, D3 | Delete the `/memory` no-arg view's `cached summary` print block (consequent typecheck edit) | T7 |
| §2 D-mem-cmd, D6 | Remove `memory`'s orphaned `/compact` command | T7 |
| §2 D-mem-tests, §7 AC-3 | Drop/adjust `memory.test.ts` count-compaction tests + the two AC-12 `/compact` lines | T1 |
| §2 D-coload, §7 AC-1 | New co-load regression test (`memory` + `compact`, no double-compaction) | T2 |
| §2 D-force-preview, §7 AC-6 | New test: `/compact force` under-budget **preview** branch | T3 |
| §7 AC-2 | New test: `memory` registers **no** `transformContext` hook | T4 |
| §2 D6, §7 AC-5 | Adjust `compact.test.ts` AC-10 (shadow/restore) → sole-owner contract | T5 |
| §2 D-killswitch, §7 AC-4, D5 | `EAGENT_COMPACT` unchanged; `compact` stays off-by-default after registration | covered by T2/T6 + existing `compact.test.ts` AC-8/AC-9 (regression, §5) |
| §2 D-claude, D-readme | Reconcile CLAUDE.md + README; bump built-in count `41 → 42` | T8 |
| §7 AC-7 | Full suite + typecheck green, no double-compaction | T9 (exit gate) |

---

## 2. Phase Breakdown — Single Phase: wire `compact`, retire `memory`'s count-hook

The design does not separate this into multiple phases, and it should not be: the
host registration and the hook removal are a single atomic change (R1/D1) — split
them and an intermediate commit is either a silent no-op (`compact` registered,
`memory` still folds) or a regression (`memory`'s hook gone, `compact` not yet
registered → no conversation compaction at all). Keep it one phase.

### Entry condition

- On a fresh branch off `init` (do not commit on the default branch).
- `npm test` and `npm run typecheck` are green at HEAD (establish the baseline you
  must return to).
- You have read `docs/design/2026-06-22-compact-wiring.md`, `src/extensions/memory.ts`,
  `src/extensions/compact.ts`, `test/memory.test.ts`, and `test/compact.test.ts`.

### Design refs

- §1 (the hazard: two `transformContext` folders, `memory` loads first at
  `host.ts:81`, no `meta.kind:"summary"` guard).
- D1 (retire `memory`'s count-compaction entirely; `compact` is the successor).
- D2 (`compact` slots immediately **after** `prune` in `BUILTIN_EXTENSIONS`).
- D3 (exact surgical scope: what dies vs what survives in `memory.ts`).
- D4 (the co-load regression test proves no double-compaction with `memory` +
  `compact` co-loaded; no injector — see T2).
- D5 (`compact` stays off-by-default once registered).
- D6 (remove `memory`'s orphaned `/compact` command; do not keep it as an
  unload fallback).
- §7 AC-1..AC-7.

### Task list (TDD order)

Tests come first and are watched failing before the implementation that makes
them pass. The host registration (T6) and the `memory.ts` surgery (T7) are the
**only** production edits; everything before them is test work that should fail
(or, for the new co-load test, fail in the documented way) until T6/T7 land.

> Ordering rationale: T1–T5 establish the full test contract (some assertions go
> red, some stay green) **before** the source changes; T6/T7 are the surgical
> edits that turn the contract green; T8 reconciles docs; T9 is the exit gate.

---

#### T1 — Drop/adjust `memory.test.ts` count-compaction tests

**Business invariant protected:** *`memory` no longer owns the compaction seam or
the `/compact` command — its scratchpad/white-box/`/memory`-config surface is the
only behavior it still asserts.* (§2 D-mem-tests, §7 AC-3.) This is a TEST task:
it removes the assertions that pin the about-to-be-deleted behavior, so that T7's
removal does not leave a contradicting test red for the wrong reason.

Edit `test/memory.test.ts`:

- **Delete** these tests (they assert the removed count-hook / `/compact`
  command, design §2 D-mem-tests):
  - `"below threshold: context is not compacted"` (`:70`)
  - `"above threshold: context is compacted into a summary + recent tail"` (`:90`)
  - `"caching: an unchanged prefix is not re-summarized every turn"` (`:114`)
  - `"compaction does not mutate the persistent transcript"` (`:170`)
  - `"/memory prints config and cache status, /compact folds older messages"` (`:190`)
  - `"/compact with too few messages reports nothing to compact"` (`:221`)
- In `"AC 12: host.unload removes registrations and never throws"` (`:536`),
  **delete the two `/compact` lines only** (`:541` `assert.ok(h.commands.get("compact"))`
  and `:548` `assert.equal(h.commands.get("compact"), undefined)`). `memory` no
  longer registers `/compact`; the remember/recall/`/memory` register-and-unload
  assertions in that test stay unchanged (§7 AC-3).
- Remove only the fixtures/helpers/imports left **truly** dangling by the deletions.
  After the six deletions, only `makeResponder` and `seedPairs` become unused —
  remove those two (strict TS / unused-import hygiene). **Do NOT remove**
  `freshRecorder`, `Recorder`, or `isSummarizeReq` — they are still referenced by
  SURVIVING white-box tests (e.g. `memory.test.ts:139,306` and `:143,309,455`);
  deleting them breaks the green tests. Verify with a grep before removing any
  symbol. **Keep** everything the remaining white-box tests use (`execTool`,
  `makeMemHarness`, `loadMem`, `runMemory`, `rawNote`, `Entry`, the
  `EAGENT_MEMORY_ENTRIES` kill-switch test, the FileBackend round-trip).

**Acceptance command (expect PASS at this point — `memory.ts` still has the hook
and `/compact`, but every deleted assertion targeted the soon-removed behavior, so
the surviving tests never touch the compaction path and the file stays green):**

```bash
node --import tsx --test test/memory.test.ts
```

The surviving white-box tests (AC 1–15 minus the two AC-12 lines) must stay green
*now* (they never touched the compaction path — §5 of the design). Confirm no test
references a symbol you removed. (The remaining red, if any, only manifests after
T7; at T1 this file should be green because every assertion against the soon-removed
behavior is gone.)

---

#### T2 — Co-load regression test: `compact` owns the seam, `memory` does not count-compact

**Business invariant protected:** *With `memory` + `compact` both live, an
over-budget transcript yields exactly ONE summary, authored by `compact`
(`meta.source === "compact"`), never a second `memory` count-fold.* (§2 D-coload,
§7 AC-1.) This is the runnable proof that the documented double-compaction hazard
(§1) is gone once `memory`'s count-hook is retired (T6) and `compact` is registered
(T7).

> No injector is needed (and none must be added): the regression property is
> "exactly one summary, sourced `compact`, no second `memory` fold." That is fully
> exercised by co-loading just `memory` + `compact`. (The earlier draft asserted an
> upstream-injected note *survives* compaction — that is mechanically WRONG: skills/
> microagents prepend their note at array index 0, which is in `compact`'s OLDER
> slice `[0, idx)` (`compact.ts:99-114` only protects the last `keepTurns` USER
> turns), so it is FOLDED into the summary — the compact design itself notes this is
> benign (`2026-06-22-compact.md:448-453`). `compact`'s OWN tests already cover its
> boundary-split (D4 iii); this co-load test's job is *no double-compaction*, which
> needs no injector.)

Add to `test/compact.test.ts` (it already imports `memory`, `makeHarness`, the
`overBudget()` fixture, `applyHook`, and `summaries`/`textOf` — reuse them):

- Load both via `host.use`: `memory` (`host.use("memory", memory)`) then `compact`
  enabled (the test's `activate(h, { enabled: true })` wrapper, or a direct
  `host.use` that sets `enabled`). Order is irrelevant to the property (memory no
  longer compacts after T6); load `memory` first to mirror `host.ts`.
- **Fixture sizing (load-bearing — makes this a genuine regression guard):** use a
  transcript with MORE messages than `memory`'s count threshold so that, *before*
  T6, `memory`'s count-hook WOULD fold it (and thus pre-T6 you'd get a second /
  `memory`-sourced summary — a real double-compaction the test catches). `memory`'s
  hook short-circuits on `messages.length <= DEFAULT_THRESHOLD` with
  `DEFAULT_THRESHOLD === 12` (`memory.ts:28,329`), and the existing `overBudget()`
  fixture is exactly 12 messages — so it does NOT trip memory's gate. Either extend
  `overBudget()` to > 12 messages (add a couple of older user/assistant pairs that
  keep it over the token budget) or build a `>12`-message over-budget fixture for
  this test, so memory's pre-T6 fold actually fires. Drive it through
  `await applyHook(h, <fixture>())`.
- Assert, per §7 AC-1:
  - `summaries(out).length === 1` (exactly one `meta.kind === "summary"`)
    — **load-bearing**: the no-double-compaction guard.
  - that one summary's `meta.source === "compact"` (never `"memory"`)
    — **load-bearing**: proves `compact` owns the seam, not `memory`.
  - the last `keepTurns` user-turn tags survive verbatim (the recent window is not
    folded).
- **Pre-T6 expectation (only with a > 12-message fixture):** before T6 retires
  memory's hook, this test FAILS — memory ALSO folds, yielding a second /
  `memory`-sourced summary; that failure is the proof the retirement is what fixes
  it. (With the bare 12-message `overBudget()` fixture memory's threshold gate is
  not tripped, so it would pass pre-T6 too — hence the >12 sizing above.)

**Acceptance command (with the >12-message fixture: expect FAIL until T6+T7,
because today `memory`'s count-hook also folds → a second / `memory`-sourced
summary):**

```bash
node --import tsx --test test/compact.test.ts
```

---

#### T3 — Test: `/compact force` under-budget **preview** branch

**Business invariant protected:** *`/compact force` on a transcript that has a
foldable boundary but is UNDER budget previews the future fold with the
"once the transcript next goes over budget" phrasing and makes NO summarization
sub-call.* (§2 D-force-preview, §7 AC-6.) This closes the cosmetic finding
`compact`'s own design deferred (the `compact.ts:374-377` `when` branch).

Add to `test/compact.test.ts`. The existing
`"/compact force on an under-budget transcript with no foldable boundary prints
nothing-to-compact"` test (`:560`) covers the **no-boundary** path (`idx <= 0`).
This new test covers the **boundary-exists-but-under-budget** path:

- Activate `compact` enabled (`activate(h, { enabled: true })`).
- `h.agent.load(...)` a transcript with **4+ short user turns** (more than
  `keepTurns`, so `splitIndex` returns a boundary `> 0`) but whose total token
  estimate is **under** the 60k budget — e.g. several `userMsg("...")` /
  `assistantMsg("...")` short pairs. (`splitIndex` ignores the budget, so a
  foldable boundary exists; `tokenEstimate(messages) <= budget` is true.)
- Run `/compact force` via `h.commands.get("compact")!.run(...)`, collecting
  printed lines.
- Assert the output matches `/once the transcript next goes over budget/`
  (the `compact.ts:374-377` under-budget `when` branch).
- Assert `count.sub === 0` (no sub-call — `force` is pure-`splitIndex`,
  `compact.ts:357-360`; use the `{ sub, real }` count via
  `makeResponder({ count })` as `compact.test.ts:540-558` does).

**Acceptance command (this test should PASS as soon as it is written — it exercises
existing, unchanged `compact.ts` behavior; it is added here only because it was a
deferred coverage gap):**

```bash
node --import tsx --test test/compact.test.ts
```

If it does **not** pass when written, the test's transcript is mis-sized (either
over budget, or fewer than `keepTurns+1` user turns) — fix the fixture, not
`compact.ts`. (§3 of the design: this task is **not** a rewrite of `compact.ts`.)

---

#### T4 — Test: `memory` registers no `transformContext` hook

**Business invariant protected:** *Loading `memory` alone adds ZERO
`transformContext` listeners — the seam is no longer `memory`'s.* (§7 AC-2.)

Add a test (in `test/memory.test.ts` or `test/compact.test.ts` — wherever the
`makeHarness` import is already present; `compact.test.ts` is the natural home
since it owns the seam-ownership story):

- On a fresh `makeHarness`, record
  `h.agent.hooks.listenerCount("transformContext")` as the baseline.
- `await host.use("memory", memory)`.
- Assert the count is **unchanged** by loading `memory` alone (§7 AC-2).

**Acceptance command (expect FAIL until T7 removes the hook):**

```bash
node --import tsx --test test/compact.test.ts test/memory.test.ts
```

---

#### T5 — Adjust `compact.test.ts` AC-10 to the sole-owner contract

**Business invariant protected:** *`/compact` is owned solely by `compact`; there
is no stale `memory` fallback restored on `compact` unload.* (§2 D6, §7 AC-5.)

The current `"AC-10: /compact supersedes memory's command; disposing compact
restores memory's"` test (`compact.test.ts:437-452`) asserts `memory` registers
`/compact` (`:443`), `compact` shadows it (`:447-448`), and unloading `compact`
**restores** `memory`'s (`:451`). After D6 removes `memory`'s `/compact`, that last
assertion is false. Rewrite the test (design §7 AC-5, replacing
`compact.test.ts:437-452`) to assert:

- After `host.use("memory", memory)` then `host.use("compact", compact)`,
  `commands.get("compact")` resolves to **`compact`'s** command (a distinct
  description — `compact`'s describes status/force/on/off/pin; `memory` provides
  none).
- After `host.unload("compact")`, `commands.get("compact") === undefined`
  (`memory` no longer provides one — §7 AC-5, D6).

> This is the one place a design decision (D6) **flips** an existing assertion
> from "restored" to "undefined". Do not preserve the old shadow/restore shape;
> the new contract is the correct, less-surprising one (D6 rationale).

**Acceptance command (expect FAIL until T7 removes `memory`'s `/compact`):**

```bash
node --import tsx --test test/compact.test.ts
```

---

#### T6 — Register `compact` in `BUILTIN_EXTENSIONS` (host wiring)

**Implements:** §2 D-host, D2. First production edit. Run T2/T4/T5 *before* this and
watch them fail; this edit moves them toward green.

Edit `src/host.ts`:

- Add the import alongside the other extension imports (ESM, `.js` specifier even
  for the `.ts` file — house rule):
  ```ts
  import compact from "./extensions/compact.js";
  ```
  Place it logically near `memory`/`prune` (import order is cosmetic; the
  registration order is what matters).
- Insert `["compact", compact]` into the `BUILTIN_EXTENSIONS` array **immediately
  after** `["prune", prune]` (currently `host.ts:82`), i.e. between
  `["prune", prune]` and `["recovery", recovery]` (D2: filters run in registration
  order, so `compact` runs after `prune`'s free byte-trim; `compact`'s paid
  sub-call only fires if the conversation itself is still over budget).

Do **not** flip any default: registration only makes `compact` available;
`compact` stays off-by-default via its own `cfg()` (`compact.ts:168-169`) and the
`EAGENT_COMPACT` kill switch (§2 D-killswitch, D5, §7 AC-4). No new capability is
added (§3).

**Acceptance commands:**

```bash
npm run typecheck
node --import tsx --test test/compact.test.ts
```

(typecheck must be exit 0; the co-load/sole-owner/off-by-default tests move
green once T7 also lands — see T9 for the combined gate.)

---

#### T7 — Surgical removal in `memory.ts`: count-hook + dead helpers + `/compact` + no-arg cache line

**Implements:** §2 D-mem-hook, D-mem-noarg, D-mem-cmd; D1, D3, D6. Second and final
production edit. **Surgical** — remove only what the design enumerates; keep the
scratchpad/white-box/`/memory`-config surface byte-equivalent in behavior.

Edit `src/extensions/memory.ts`. **Remove** (and only these — D3):

- The `e.hook("transformContext", …)` block (`memory.ts:326-340`) — the
  count-based compaction hook itself.
- The `/compact` command registration (`memory.ts:344-366`) — orphaned once the
  hook is gone (D6; do **not** leave it as an unload fallback — it would do paid
  work with zero transcript effect).
- The now-unreachable helpers and symbols:
  - `summarize` (`:273-288`)
  - `summaryFor` (`:296-315`)
  - `summaryMessage` (`:317-322`)
  - `fingerprint` (`:236-244`)
  - the `SummaryCache` interface (`:42-48`)
  - `renderFallback` (`:500-516`)
  - the bottom `textOf` (`:488-493`)
  - the `SUMMARY_SYSTEM_PROMPT` constant (`:32-34`)
  - the `CACHE_KEY` constant (`:37`)
- The `/memory` no-arg view's **cached-summary block** (the consequent edit, D3):
  the `const cache = e.store.get<SummaryCache>(CACHE_KEY)` read (`:380`) and the
  `cached summary: …` print it feeds (`:383-387`). Leaving these references the
  now-deleted `SummaryCache`/`CACHE_KEY` symbols and **breaks `npm run typecheck`**
  — they must go in the same edit. The surrounding no-arg lines
  (`threshold=…/keepRecent=…` at `:382`, `notes:` at `:388`) and every
  sub-command stay; the view loses only the one `cached summary` line.

**Keep verbatim in behavior** (D3 — do not touch):

- `remember`/`recall` tools (`:406-474`), the `note:` scratchpad.
- The `Entry`/`readEntry`/`noteKeys`/`findById`/`normalize`/`runScratchpad`
  white-box path (`:62-228`).
- `DEFAULT_THRESHOLD`/`DEFAULT_KEEP_RECENT` (`:28-29`) and the `config()` closure
  (`:247-250`) — **NOT dead**: the surviving `/memory` no-arg view still reads them
  to print `threshold=…/keepRecent=…` (`:379`, `:382`).
- `newId` (`:258-260`), the `EAGENT_MEMORY_ENTRIES` kill switch (`:79-81`), and the
  never-throw dispose loop (`:476-484`).

No migration / compatibility shim (§3): the only on-disk state tied to the removed
hook is the `summaryCache` store key, which simply goes unread (harmless dead key).

**Acceptance commands:**

```bash
npm run typecheck
node --import tsx --test test/memory.test.ts test/compact.test.ts
```

Both must pass: `typecheck` exit 0 (every removed symbol's references gone — R4),
and the two test files green (memory's scratchpad surface intact per §7 AC-3;
compact owns the seam per AC-1/AC-2/AC-5).

---

#### T8 — Reconcile CLAUDE.md + README; bump built-in count

**Implements:** §2 D-claude, D-readme. Do this after T6/T7 so the docs describe the
code as it now is.

- **CLAUDE.md** — rewrite the `compact` inventory line (`CLAUDE.md:196-201`): it is
  no longer "not yet wired into `BUILTIN_EXTENSIONS`" / "a tracked follow-up". It is
  now a **registered, off-by-default** built-in (token-gated structured
  conversation compaction on `transformContext`; opt-in via `enabled` / `/compact
  on`; `EAGENT_COMPACT=off` kill switch). Update `memory`'s line (`CLAUDE.md:64`) to
  drop the "count-based compaction" claim — `memory` is now just the
  `remember`/`recall` + white-box scratchpad + `/memory` config view (it no longer
  compacts).
- **README** — update the `memory` row (`README.md:201`) to drop `/compact` and the
  "context compaction via `transformContext`" claim (it keeps `remember`/`recall`
  scratchpad + `/memory`). Add a `compact` row (token-gated structured conversation
  compaction; commands `/compact`; off by default). Bump the built-in count
  `41 → 42` (`README.md:334`).

**Acceptance command (docs-only; just confirm the suite still builds/runs):**

```bash
npm run typecheck
```

---

#### T9 — Exit gate: full suite + typecheck green, no double-compaction

**Implements:** §7 AC-7 (the overall gate). Run from repo root:

```bash
npm test
npm run typecheck
```

Both must be exit 0. `npm test` covers the full offline suite (every other
extension's tests must stay green — §5). The new co-load test (T2) is the runnable
proof of "no double-compaction": exactly one summary, sourced `compact`.

### Exit condition

- `node --import tsx --test test/memory.test.ts test/compact.test.ts` passes.
- `npm run typecheck` exit 0 (no dangling import, no unused symbol, no `any`).
- `npm test` exit 0 (full suite green; the co-load test proves a single compactor).
- `compact` is registered in `BUILTIN_EXTENSIONS` after `prune`, off by default.
- `memory`'s count-based `transformContext` hook and `/compact` command are gone;
  its scratchpad/white-box/`/memory`-config surface is unchanged.
- CLAUDE.md + README reconciled; built-in count bumped `41 → 42`.

---

## 3. Engineering Constraints Index

House rules (CLAUDE.md "House conventions" + design §5) — non-negotiable:

- **ESM + NodeNext.** Always `.js` import specifiers even when importing a `.ts`
  file (e.g. `import compact from "./extensions/compact.js"`). Required by
  `module: NodeNext` + `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. No `any` cop-outs.
  Removing a symbol means removing every reference to it (the typecheck is the
  guard for the D3 consequent edit — design R4).
- **Zero runtime dependencies except `jiti`.** Pure Node. Providers use global
  `fetch`. Do not add an npm dependency. (This task adds none.)
- **Offline tests only.** `node:test` run via `tsx`, against the scriptable
  `MockProvider`. No network, no `ANTHROPIC_API_KEY`. The summarization sub-call is
  detected by its system prompt (`/summar/i`) exactly as the existing tests do.
- **Capabilities are the security vocabulary.** This task adds **no** capability —
  the `transformContext` seam is read/transform-only and `memory`'s surviving
  scratchpad is the agent's private notebook (design §3, §5).
- **Kill switch unchanged.** `EAGENT_COMPACT` is read inside `compact`'s hook
  (`compact.ts:168-169`); registration does not flip it (§2 D-killswitch, D5).
  `memory`'s `EAGENT_MEMORY_ENTRIES` kill switch is untouched.
- **Dispose loops never throw.** Both `compact.ts:396-404` and `memory.ts:476-484`
  already swallow teardown errors; T7 removes registrations from `memory`'s
  `disposables`/dispose surface cleanly (just don't push the removed hook/command).

### Commit conventions

- One branch off `init` (you start on `init`; **branch first** — do not commit on
  the default branch). Commit only when the user asks.
- Commit-message prefixes (project workflow): `feat(phaseN)` for the
  implementation, `fix(phaseN-roundR)` for review-driven fixes. This is the single
  Phase, so `feat(phase1)`.
- Trailers: include `npm test` and `npm run typecheck` results as trailers.
- **No mention of AI/model/tooling** in commit messages.
- End the commit message with the session trailer:
  `Claude-Session: https://claude.ai/code/session_014R8mvT426fK6BkWHbdbLt2`.

---

## 4. Data / Fixture Dependencies

Reuse existing instruments; introduce no new fixture machinery.

- **`test/helpers.ts` → `makeHarness({ responder, fallback })`** — the canonical
  instrument: a `MemoryBackend` store, a scriptable `MockProvider`, a
  `CommandRegistry`, and an `ExtensionHost` with `host.use` loading. Both
  `memory.test.ts` and `compact.test.ts` already build on it.
- **`test/compact.test.ts` existing fixtures** (reuse verbatim for T2/T3):
  - `overBudget()` (`:118-135`) — the ≈250k-char, several-user-turn-boundary,
    last-3-turns-verbatim transcript (§7 AC-1's input).
  - `applyHook(h, msgs)` (`:96-98`) — drives
    `h.agent.hooks.apply("transformContext", msgs, {turn:0, model:"mock"})`.
  - `summaries(out)` / `textOf(m)` (`:49-60`) — extract summary messages / message
    text.
  - `makeResponder({ count })` (`:68-79`) — function responder branching on
    `/summar/i`, with a `{ sub, real }` call counter for AC-6's `count.sub === 0`.
  - `activate(h, { enabled })` (`:85-93`) — the `compact` activation wrapper that
    seeds the `enabled` store flag from inside `activate`.
  - `userMsg`/`assistantMsg`/`callMsg`/`resultMsg` (`:34-47`) — message builders.
- **`test/compact.test.ts` already imports `memory`** (`:19`,
  `import memory from "../src/extensions/memory.js"`) — reuse it for the co-load
  test (T2) and the seam-ownership test (T4). No injector is imported or needed (see
  the T2 note); the regression property is no-double-compaction with `memory` +
  `compact` alone.
- **`test/memory.test.ts` white-box harness** (keep for the surviving AC 1–15):
  `makeMemHarness` (`:257`), `loadMem` (`:270`), `runMemory` (`:281`),
  `rawNote` (`:288`), `execTool` (`:554`), the `Entry` interface (`:235`).
- **Store backends:** `MemoryBackend` (default) and `FileBackend` (the AC-14
  round-trip test) from `src/kernel/store.js`. No new backend.

No external data files, no network fixtures, no recorded cassettes are needed.

---

## 5. Regression Protection

These must stay **green** through and after the change (design §5, §7 AC-3/AC-7):

- **`test/compact.test.ts` — the entire existing `compact` suite** (Tasks 1–13 /
  AC-1..AC-13, plus the `/compact` command-surface tests). `compact.ts` is
  unchanged; registering it must not alter any isolated-mode behavior. The
  **only** existing test that changes is AC-10 (`:437-452`) — and that is a
  required edit (T5), not a regression. In particular, AC-8 (off by default,
  `:395`) and AC-9 (`EAGENT_COMPACT=off` hard kill, `:416`) are the regression
  guards for §7 AC-4 (off-by-default after registration) — they must stay green.
- **`test/memory.test.ts` — the white-box scratchpad suite** (AC 1–15:
  provenance, remember/recall round-trip, `list|edit|forget|rollback|consolidate`,
  the `EAGENT_MEMORY_ENTRIES` kill switch, the FileBackend round-trip, clean
  unload). All stay green **unchanged** except the two `/compact` lines deleted
  from AC-12 (`:541`, `:548`) — design §7 AC-3. These tests never touched the
  compaction path, so the surgery must not perturb them.
- **The full `npm test` suite** (design §7 AC-7). Pay attention to any test that
  loads the **full builtin set** via `createAgentHost` / counts extensions / asserts
  the `BUILTIN_EXTENSIONS` length or order — adding `compact` and bumping
  `41 → 42` may require updating such a count. Search for any host/builtin-count
  assertion before declaring T9 done; if one exists, update it to `42` (this is a
  mechanical consequence of D2, not new behavior). Likewise check
  `test/prune.test.ts` and any `transformContext`-chain test for an assumption
  about how many filters are registered.
- **`npm run typecheck`** — exit 0. The D3 consequent edit (deleting the no-arg
  cache print block) is precisely what keeps this green after `SummaryCache`/
  `CACHE_KEY` are removed (R4).

> No-double-compaction is the headline regression: the co-load test (T2) is its
> runnable guard — exactly one summary, `meta.source === "compact"`, on a co-loaded
> `memory` + `compact` pair.
