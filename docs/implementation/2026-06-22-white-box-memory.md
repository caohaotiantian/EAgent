# Implementation: `white-box-memory` — per-entry provenance, edit/forget/rollback

Status: closed
Closing-commit: c7bfcaa
Closed-on: 2026-06-22
Deferred: none
Slug: `2026-06-22-white-box-memory`
Design doc: `docs/design/2026-06-22-white-box-memory.md` (Status: PASSED — read it first)

## Closeout notes (dev round r1)

All 15 acceptance criteria implemented and tested. Final gate, from repo root:

- `node --import tsx --test test/memory.test.ts` → 22 pass / 0 fail (original 7 +
  15 new white-box tests).
- `npm run typecheck` → exit 0.
- `npm test` → 529 pass / 0 fail (was 514; only the memory tests were added).

Files changed (and only these): `src/extensions/memory.ts` (MODIFY),
`test/memory.test.ts` (EXTEND), this doc.

Deferred to batch integration (NOT done here, per BATCH MODE):

- **host.ts registration** — `memory` is already in `BUILTIN_EXTENSIONS`; no new
  id introduced, nothing to add.
- **CLAUDE.md / README inventory** — the `memory` inventory clause noting
  per-entry provenance/edit/forget/rollback and any doc reconciliation are
  deferred; the README extension count is **not** bumped (no new extension).

Resolved design ambiguity (recorded so the closeout reviewer can see the call):
the impl-guide T11 prose says rollback "swaps text↔prevText" leaving the
just-replaced value as the new `prevText`, but design D3 (§168-169) and AC 6
require a **second consecutive** rollback to be a **no-op** ("there is nothing
before prevText"). Per the guide's own "where the design and this guide
disagree, the design wins" rule, `rollback` restores `prevText` into `text` and
**consumes** `prevText` (clears it), so a second rollback finds nothing to undo.
This is the only reading that satisfies AC 6 and keeps the 2×-text storage
bound.

This guide directs a fresh agent through TDD development of the white-box-memory
upgrade. It introduces **no requirement absent from the design** — every task
below traces to a §2 Deliverable and a §7 Acceptance Criterion. Where the design
and this guide disagree, the design wins; report the discrepancy rather than
inventing scope.

## 0. Orientation (read before coding)

- This is an **in-place upgrade of `src/extensions/memory.ts`** (Decision D1).
  There is **no new `white-box-memory.ts` file** — the slug names the
  capability, not a file. A sibling extension would fork the namespaced store and
  collide on `remember`/`recall`/`/memory` (D1 rationale).
- **BATCH MODE (CRITICAL).** Do **NOT** modify `src/host.ts`, `CLAUDE.md`, or
  `README.md`. `memory` is already in `BUILTIN_EXTENSIONS`; no new id is
  introduced, so there is nothing to register. The CLAUDE.md inventory clause and
  any doc reconciliation are **deferred to a separate batch-integration step**.
  Tests load the extension directly via `host.use("memory", activate)` — the
  established offline pattern (`test/recovery.test.ts:118-120`) — and must **not**
  depend on `BUILTIN_EXTENSIONS`. Do **not** bump the README extension count.
- **Files you may touch, and only these:** `src/extensions/memory.ts` (MODIFY),
  `test/memory.test.ts` (EXTEND), `docs/design/`, `docs/implementation/`.
- **DO NOT touch the compaction summary path.** `transformContext`
  (`memory.ts:131-143`), `summaryFor`/`summarize`/`fingerprint`
  (`memory.ts:55-127`), the `summaryCache` store key, `/compact`, and the no-arg
  `/memory` config view are out of scope (§3, Decision D4 closing note). A
  **separate follow-up** retires memory's count-based compaction; do not pre-empt
  it. Your edits confine to the `note:` model and the `/memory` argument handler.

## 1. Task Index — design Deliverables + AC → phase tasks

Single phase (the change is one extension file + its test; the sub-commands and
entry model are not separable without forking the store — D1). Tasks are labelled
`T<n>` and run in the strict TDD order of §2.

| Design Deliverable (§2) | Design Acceptance Criterion (§7) | Task |
| --- | --- | --- |
| Upgraded `memory.ts`: `remember` writes a provenance-tagged `Entry`; `recall` reads compatibly | 1, 2, 7, 15 | T2 (test), T3 (impl) |
| `/memory list` — id + source + ts view | 3 | T4 (test), T5 (impl) |
| `/memory edit <id> <text>` — replace by id, preserve prior | 4 | T6 (test), T7 (impl) |
| `/memory forget <id>` — delete by id | 5 | T8 (test), T9 (impl) |
| `/memory rollback <id>` — restore prior value, bounded to one step (D3) | 6 | T10 (test), T11 (impl) |
| `/memory consolidate` — opt-in exact-text dedupe (D5) | 9 | T12 (test), T13 (impl) |
| Lazy backward-compat for legacy bare-string notes (D4) | 8, 15 | T2/T4/T14 (test), T3/T5 (impl) |
| `EAGENT_MEMORY_ENTRIES=off` kill switch | 10 | T14 (test), T15 (impl) |
| Entry ids unique + stable; `prevText` bound (D2, D3) | 13 | T2 (test), T3 (impl) |
| `Entry` (with `prevText`) round-trips `FileBackend` flush/read | 14 | T16 (test), (impl covered by T3/T7/T11) |
| Summary/`/compact`/no-arg `/memory` view untouched (regression) | 11 | T1 (regression baseline), T17 (final regression) |
| Clean teardown — `host.unload("memory")` never throws, removes registrations | 12 | T18 (test), (impl: dispose loop in T3) |
| `host.ts` registration | — | **(deferred to batch integration)** — do nothing |
| CLAUDE.md/README inventory | — | **(deferred to batch integration)** — do nothing |
| `docs/implementation/2026-06-22-white-box-memory.md` | — | this file; closeout at the end |

Acceptance criteria 1–15 are all covered. AC 11 and 12 are guarded both at the
start (T1 baseline) and end (T17/T18). AC 14 and 15 are the two criteria the
design flags as otherwise-untested edges — give them dedicated tests.

## 2. Phase Breakdown — Phase 1 (single phase)

### Entry condition

- Baseline green: `npm test` → `# fail 0` (514 pass on this branch),
  `npm run typecheck` → exit 0, working tree clean apart from this doc.
- Confirm `node --import tsx --test test/memory.test.ts` passes (7 tests) before
  any edit — that is the regression set AC 11 protects.

### Design references

`docs/design/2026-06-22-white-box-memory.md` §2 (Deliverables), §4 D1–D5
(decisions), §5 (dependencies/assumptions), §7 AC 1–15, §8 (risks/rollback).
Code anchors: `memory.ts:38` (`NOTE_PREFIX`), `:190-236` (remember/recall),
`:169-184` (no-arg `/memory` view), kernel `store.ts:12-17` (Store API),
`commands.ts:10-16` (CommandContext), `define.ts:26-49` (`defineTool`/`ok`/`fail`).

### The entry model (from D2 — implement exactly, no extra fields)

```ts
interface Entry {
  id: string;        // identity for list/edit/forget/rollback
  text: string;      // the value
  source: string;    // provenance label, e.g. "tool:remember", "user", "legacy"
  ts: string;        // ISO-8601 via new Date().toISOString()
  prevText?: string; // single-step undo (D3); absent until first overwrite
}
```

Non-negotiable behaviors the tests pin:
- **Lazy coexistence (D4):** on read, `typeof v === "string"` is treated as a
  legacy entry `{ id: key, text: v, source: "legacy", ts: "" }` with no
  `prevText`. No startup migration, no rewrite, no throw on old data.
- **Single-step undo (D3):** each overwrite (`remember` re-write or `edit`)
  shifts the **current** `text` into `prevText` and discards the older prior.
  `rollback` swaps `text` and `prevText` once; a **second consecutive** rollback
  is a no-op (nothing before `prevText`).
- **No-key `recall` contract (D4):** returns `{ key → text-string }` — unwrap
  `.text` from `Entry` objects, pass legacy bare strings through unchanged. A
  value must **never** serialize as `{id,text,source,ts,...}` (AC 15).
- **`consolidate` (D5):** dedupe by **exact normalized** (`trim()`, case-folded)
  text equality; keep the **earliest** entry, drop later exact duplicates, print
  the merged count. Distinct texts → removes nothing. **Opt-in only** — plain
  `remember` never auto-merges.
- **Kill switch:** `process.env.EAGENT_MEMORY_ENTRIES === "off"` → `remember`
  writes the **legacy bare string** (byte-identical to today), and the new
  sub-commands print a disabled/notice line instead of entry rows.
- **id generation:** short, distinct across two `remember` calls, stable on
  re-read. Pure Node, no `crypto` dependency (zero-dep rule) — a
  counter-suffixed/random token is fine (§5 assumption).

### Task list (TDD order — every TEST task names the BUSINESS INVARIANT it protects and precedes the impl it guards)

**T1 (regression baseline — no edit).** Run `node --import tsx --test
test/memory.test.ts` and `npm test`; record they are green. This pins the
**invariant: the existing summary/compaction seam, `/compact`, the no-arg
`/memory` view, and the remember/recall round-trip must remain unchanged** (AC
11). Do not modify these tests.

> Test-harness idioms (reuse, do not reinvent): build with `makeHarness({
> responder, fallback: "allow" })` (`test/helpers.ts:27`); load with
> `await host.use("memory", activate)`. Drive tool calls by scripting the
> responder (`memory.test.ts:128-158`). Drive commands with
> `commands.get("memory")!.run({ agent, args, print: (l) => out.push(l) })`
> (`memory.test.ts:193-208`). Read the store directly via the harness `host` /
> a second `host.use` handle, or assert through `recall`/`list` output
> (AC 2 explicitly allows either).

**T2 (test) — provenance + backward-compat round-trip + id uniqueness.** In
`test/memory.test.ts`, add tests that protect the **invariant: a remembered fact
is a provenance-tagged, individually identified entry, and the old
remember→recall round-trip is byte-compatible.** Cover:
- AC 1: `remember {key:"color",value:"blue"}` then `recall {key:"color"}` →
  `tool_result.content === "blue"` (the existing assertion at `:128-158` must
  also still hold).
- AC 2: the stored value at `note:color` is an object with `text === "blue"`, a
  non-empty `source`, an ISO-8601 `ts` matching `/^\d{4}-\d{2}-\d{2}T/`, and a
  defined `id`.
- AC 7: re-`remember`ing the same key with a new value leaves `prevText` equal
  to the value that was current before the call.
- AC 13: two `remember` calls with **distinct keys** produce **distinct** `id`s
  (`a.id !== b.id`); each `id` is **stable** on re-read.

**T3 (impl) — Entry model in `remember`/`recall`.** Extend the store schema to
discrete `Entry` records with provenance and the bounded `prevText`. `remember`
writes an `Entry` (shifting current→`prevText` on overwrite); single-key `recall`
unwraps `.text` (tolerating legacy strings); no-key `recall` returns
`{ key → text }` per AC 15. Generate stable, distinct ids. Make the extension's
default export return a **dispose loop that never throws** (pattern of
`todo.ts:128-136` / `recovery.ts:107-113`), tracking every `registerTool` /
`registerCommand` disposable. Run T2 to green.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T4 (test) — `/memory list` shows id + provenance.** Protect the **invariant:
every entry is individually inspectable with its identity and provenance
visible** (AC 3). With two notes present, `run({args:"list"})`'s printed lines
each contain the entry's `id`, `source`, and a date-shaped `ts`; one line per
entry; line count equals note count. Include a legacy bare-string note
(`e.store.set("note:legacy","old")`) so the list shows it with a `"legacy"`
sentinel source and does not throw (AC 8, list path).

**T5 (impl) — `/memory list` sub-command.** Extend the `/memory` command to
parse `ctx.args` with `args.trim().split(/\s+/)` (the `prompts.ts:67` /
`limits.ts:245` pattern). When the first token is `list`, scan `note:`-prefixed
keys, render one line per entry with id/source/ts (lazily wrapping legacy
strings). **Preserve the no-arg `/memory` config view verbatim** — `list` is a
new branch, not a rewrite of the default. Run T4 + T1's regression to green.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T6 (test) — `/memory edit <id> <text>`.** Protect the **invariant: an entry's
text can be corrected by id, and the prior value is preserved for one-step
undo** (AC 4). After editing, the entry's `text` equals the new text **and**
`prevText` equals the original; `recall {key}` returns the new text.

**T7 (impl) — `/memory edit` sub-command.** Resolve the target by id (scan
`note:` keys for matching `Entry.id`), set `prevText` to the current `text`, set
`text` to the new value, persist. Run T6 to green.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T8 (test) — `/memory forget <id>`.** Protect the **invariant: a single
mis-remembered fact can be deleted without touching the rest** (AC 5). After
`forget`, the `note:` key is gone (`e.store.get` is `undefined`), `recall {key}`
returns the `No note for "<key>".` error result (`memory.ts:227`), and `list` no
longer lists it.

**T9 (impl) — `/memory forget` sub-command.** Resolve by id, `e.store.delete` the
matching `note:` key. Run T8 to green.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T10 (test) — `/memory rollback <id>`, bounded to one step.** Protect the
**invariant: a bad overwrite is reversible exactly once — rollback restores the
prior value, and a second rollback is a safe no-op** (AC 6, Decision D3). After
an `edit` then `rollback`, `text` equals the original; a **second** consecutive
`rollback` leaves `text` unchanged (assert equality before/after the second
call).

**T11 (impl) — `/memory rollback` sub-command.** Resolve by id; if `prevText` is
present, swap `text`↔`prevText` (so the prior value returns and the just-replaced
value becomes the new `prevText`); if `prevText` is absent, no-op. Run T10 to
green.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T12 (test) — `/memory consolidate` is opt-in + exact-text dedupe.** Protect the
**invariant: duplicate facts are merged only when the user asks, by exact
normalized text, never silently on the write hot path** (AC 9, Decision D5). With
two notes whose normalized text is identical, plain `remember` keeps **both** (no
auto-merge); after `run({args:"consolidate"})`, exactly one remains and the
command prints a merged-count line. With distinct texts, `consolidate` removes
nothing.

**T13 (impl) — `/memory consolidate` sub-command.** Scan `note:` entries, group
by `text.trim().toLowerCase()`, keep the earliest entry per group, delete later
exact duplicates, print the merged count. Run T12 to green.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T14 (test) — kill switch + no-key list unwrap over mixed shapes.** Two
invariants:
- **invariant: the kill switch reverts to byte-identical legacy behavior** (AC
  10) — with `EAGENT_MEMORY_ENTRIES=off`, `remember {key,value}` writes a **bare
  string** (`typeof e.store.get("note:"+key) === "string"`), `run({args:"list"})`
  prints a disabled/notice line (not entry rows), and the AC-1 `recall`
  round-trip still passes. Set/restore the env var in the test (save prior,
  delete-or-restore in `finally`, mirroring `recovery.test.ts:88-98`).
- **invariant: the no-key `recall` list always yields plain text, never an Entry
  object, across mixed new+legacy shapes** (AC 15) — with a new-shape entry
  (`remember {key:"color",value:"blue"}`) **and** a pre-seeded legacy bare string
  (`e.store.set("note:legacy","old")`), a no-key `recall {}` returns
  `details` / parsed `content` deep-equal to `{ color: "blue", legacy: "old" }`.

**T15 (impl) — kill switch.** At the top of the relevant write/command paths,
gate on `process.env.EAGENT_MEMORY_ENTRIES === "off"`: `remember` writes the
legacy bare string; the new sub-commands (`list|edit|forget|rollback|
consolidate`) print a disabled notice. The no-arg `/memory` view and
`recall`/`/compact` are unaffected by the switch. Run T14 to green.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T16 (test) — `Entry` (with `prevText`) round-trips `FileBackend`.** Protect the
**invariant: the persisted on-disk store growth-and-rollback claim holds — an
Entry with its single prevText survives a JSON flush/read cycle** (AC 14,
§8/D3). Activate against a real `FileBackend` (not the default `MemoryBackend`,
`helpers.ts:43`) under a temp dir (`mkdtempSync`/`rmSync`, the
`recovery.test.ts:84-99` pattern). Do `remember` → `edit` (so the entry carries a
`prevText`) → re-open/read `note:<key>`: the deserialized `Entry`'s `text`,
`source`, `ts`, `id`, **and `prevText`** are byte-identical to pre-flush values,
and a subsequent `rollback` restores `prevText` correctly. No impl change should
be needed if T3/T7/T11 keep `Entry` plain JSON-serializable; if the test fails,
fix the schema, not the test.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes;
  `npm run typecheck` exit 0.

**T17 (regression) — summary path untouched.** Confirm the **invariant: the
compaction seam, caching, `/compact`, and the no-arg `/memory` config view are
byte-unaffected** (AC 11). The existing tests at `memory.test.ts` (below-threshold
`:60`, above-threshold `:80`, caching `:104`, no-transcript-mutation `:160`,
`/compact`+`/memory` view `:180`, nothing-to-compact `:211`) must all pass with
**no edits**. Run the full file.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes (all original
  7 + new tests).

**T18 (test) — clean teardown.** Protect the **invariant: unloading the extension
never throws and removes every registration** (AC 12, dispose loop). After
`host.use("memory", activate)`, `host.unload("memory")` does not throw and the
`remember`/`recall`/`memory`/`compact` registrations are gone (`agent.tools.get`
/ `commands.get` → undefined). The dispose loop from T3 must wrap each
`.dispose()` in try/catch.

- Acceptance: `node --import tsx --test test/memory.test.ts` passes.

### Exit condition

- `node --import tsx --test test/memory.test.ts` passes (original 7 +
  new tests, AC 1–15 each exercised).
- `npm run typecheck` exit 0.
- `npm test` exit 0 — all 514 prior tests stay green; the suite total rises only
  by the memory tests added.
- Only `src/extensions/memory.ts`, `test/memory.test.ts`, and this implementation
  doc changed. `git diff --name-only` shows nothing else — **especially not**
  `src/host.ts`, `CLAUDE.md`, or `README.md`.
- Update this doc's header to `Status: closed` with the closing-commit sha and
  date at closeout; record what was deferred to batch integration.

## 3. Engineering Constraints Index (house rules, commit conventions)

House rules (CLAUDE.md "House conventions") — all enforced here:
- **ESM + NodeNext.** Use `.js` import specifiers even for `.ts` files (e.g.
  `import { defineTool, ok, fail } from "../kernel/define.js"`). Required by
  `module: NodeNext` + `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are on. **No `any`** — model
  the `Entry` type and narrow legacy reads with `typeof v === "string"`. Index
  accesses (`split(/\s+/)[1]`) are `T | undefined` under
  `noUncheckedIndexedAccess` — guard them.
- **Zero runtime dependencies except `jiti`.** Pure Node only. No `crypto`, no
  npm packages for id generation.
- **Capability gating.** This is the agent's private notebook — **no new
  capability** (matches `memory.ts:186-188`, `todo.ts`; §3 scope boundary). Do
  not add `capabilities: [...]`.
- **Kill switch.** `EAGENT_MEMORY_ENTRIES=off` (mirrors `EAGENT_RECOVERY`,
  `EAGENT_WRITE_GUARD`, `EAGENT_MICROAGENTS`).
- **Dispose loop that never throws** (every registration tracked, each
  `.dispose()` wrapped in try/catch — `todo.ts:128-136`, `recovery.ts:107-113`).
- **Offline `node:test` via `tsx`** against `MockProvider` (`makeHarness`); no
  network, no `ANTHROPIC_API_KEY`.
- **Timestamp source:** `new Date().toISOString()` at tool-execute time
  (precedent `session.ts:87`, `checkpoint.ts:110`); this is a tool side effect,
  not a deterministic seam, so it does not violate the no-`Date.now()` rule.
  Tests assert `ts` **shape** (`/^\d{4}-\d{2}-\d{2}T/`), not an exact value.

Commit conventions (per task instructions):
- Prefix: `feat(phase1)` for implementation commits; `fix(phase1-roundR)` for
  review-round fixes.
- Trailers: include `npm test` and `npm run typecheck` results.
- **No mention of AI / model / tooling** in commit messages.
- End commit messages with the `Claude-Session:` trailer per repo policy.
- Branch first if on the default branch; commit/push only when the user asks.

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`.** `makeHarness({ responder, fallback: "allow" })`
  provides `{ agent, host, commands, provider }`. Do not stand up your own Agent /
  CapabilityManager / ExtensionHost.
- **Load pattern:** `await host.use("memory", activate)` (import
  `activate from "../src/extensions/memory.js"`). Never rely on
  `BUILTIN_EXTENSIONS` (batch mode).
- **Responder scripting:** array form (`[{ toolCalls:[...] }, { text:"done" }]`)
  or function form branching on `isSummarizeReq(req)` — both already in
  `memory.test.ts`. Keep the `isSummarizeReq` guard so summary sub-calls stay
  separable from real turns.
- **Command invocation:** `commands.get("memory")!.run({ agent, args, print })`
  capturing lines into an array (`memory.test.ts:193-208`).
- **Store inspection:** read entries via the harness store (a second
  `host.use("memory", ...)` handle returns the same namespaced store) or assert
  through `recall`/`list` output — AC 2 sanctions either.
- **FileBackend fixture (T16 only):** `new FileBackend(dir)` over a
  `mkdtempSync(join(tmpdir(), "eagent-memory-"))` dir; clean up with
  `rmSync(dir, { recursive: true, force: true })` in `finally` — the
  `recovery.test.ts:84-99` scratch pattern. The default harness store is
  `MemoryBackend` (`helpers.ts:43`); T16 needs a real on-disk backend to exercise
  the `JSON.stringify` flush (`store.ts:88-95`).

## 5. Regression Protection (which prior tests must stay green)

- **`test/memory.test.ts` — the original 7 tests must stay green unchanged**
  (AC 11, T17): below-threshold (`:60`), above-threshold compaction (`:80`),
  caching (`:104`), remember/recall round-trip (`:128`), no-transcript-mutation
  (`:160`), `/memory`+`/compact` view (`:180`), nothing-to-compact (`:211`).
  These guard the summary/compaction seam you must not touch.
- **The full suite — `npm test` must stay at 514 pass / 0 fail plus the new
  memory tests.** Because no kernel, host, capability, or new file is introduced
  and only `memory.ts` + `memory.test.ts` change, no other test file should move.
  If any non-memory test changes status, you have touched something out of scope —
  stop and investigate.
- **`npm run typecheck` exit 0** at every task boundary.

Final gate (all three, from repo root):

```
node --import tsx --test test/memory.test.ts
npm run typecheck
npm test
```
