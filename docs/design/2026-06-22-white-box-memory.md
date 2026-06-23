# Design: `white-box-memory` — per-entry provenance, edit/forget/rollback for the memory extension

Slug: `2026-06-22-white-box-memory`
Status: closed
Closing-commit: 34afd8f
Closed-on: 2026-06-22
Deferred: none

## 1. Background and Purpose

The `memory` extension (`src/extensions/memory.ts`) gives a long-horizon agent
two things: an opaque, cached **summary** of the older transcript prefix
(`transformContext` seam, `memory.ts:131-143`), and a free-form **scratchpad**
exposed as the `remember`/`recall` tools (`memory.ts:190-236`). The scratchpad
stores each note as a single store key — `e.store.set(NOTE_PREFIX + key, value)`
at `memory.ts:206`, a bare string value under `"note:" + key`
(`NOTE_PREFIX = "note:"`, `memory.ts:38`).

This works until the memory is *wrong*. When the agent mis-remembers, there is
no way to:

- **pinpoint** which note is offending — a note is just `{ key → string }`,
  with no identity beyond the user-chosen key and no list view that shows where
  a note came from (`recall` with no key returns `{ key: value }` only,
  `memory.ts:230-234`);
- **see provenance** — nothing records whether a note was written by the model
  mid-turn, by a specific tool, or by the user, nor *when*;
- **roll back** a bad overwrite — `remember` on an existing key silently
  clobbers the old value (`memory.ts:206`), and the previous value is gone;
- **forget** a single note — there is no delete path in the tool surface
  (only `e.store.delete` exists in the kernel, `store.ts:31-33`, but no
  command or tool reaches it).

The only repair available today is to **re-summarize the whole prefix**
(`/compact`, `memory.ts:147-167`), which is a blunt instrument: it cannot touch
an individual scratchpad note at all.

PilotDeck's contribution is to make memory **white-box**: each remembered fact
is an individually inspectable, editable, rollback-able entry with traceable
provenance. This design brings that to EAgent's existing `memory` extension by
upgrading the `remember`/`recall` scratchpad from `{ key → string }` to
`{ key → entry }` where an entry carries an id, its source, a timestamp, and one
step of undo history, and by adding `/memory list|edit|forget|rollback` (plus an
opt-in `/memory consolidate`) over that store.

What happens if we do not build it: the agent's only working-memory repair tool
remains "re-summarize everything," mis-remembered facts persist with no audit
trail, and a wrong `remember` is unrecoverable.

## 2. Deliverables

- [ ] `src/extensions/white-box-memory.ts` — the upgraded `memory` extension
      (this design **extends `memory.ts` in place**; the slug names the
      capability, the file remains `src/extensions/memory.ts`). The `remember`
      tool writes a provenance-tagged `Entry` instead of a bare string; `recall`
      reads it back compatibly; a new `/memory` argument grammar adds
      `list|edit|forget|rollback|consolidate` over `e.store`.
- [ ] `test/memory.test.ts` — extended offline `node:test` suite (the existing
      file) covering: backward-compatible `remember`/`recall` round-trip; entry
      provenance recorded; `list` shows id+source+ts; `edit` replaces text by id
      and preserves prior value; `forget` deletes by id; `rollback` restores the
      previous value once; rollback depth bounded to one step;
      `consolidate` merges duplicates only when invoked; old-shape (bare string)
      notes tolerated; no-key `recall` over a mix of new-shape and legacy
      entries returns `{ key → text-string }` (unwraps `.text`, never an
      `Entry` object); ids distinct + stable across two `remember` calls;
      an `Entry` (with `prevText`) round-trips a `FileBackend` flush/read cycle;
      `EAGENT_MEMORY_ENTRIES=off` kill switch; and the existing
      `transformContext` summary path and `/compact`/`/memory` config view
      unaffected. Tests load via `host.use("memory", activate)` (the established
      pattern, `test/recovery.test.ts:118-120`).
- [ ] `EAGENT_MEMORY_ENTRIES=off` kill switch (mirrors `EAGENT_RECOVERY`,
      `EAGENT_WRITE_GUARD`, `EAGENT_MICROAGENTS`): when set, `remember` writes
      the legacy bare-string shape and the new sub-commands report disabled, so
      behavior is byte-identical to today's `memory`.
- [ ] `/memory list|edit|forget|rollback|consolidate` sub-commands, plus the
      existing no-arg `/memory` config/cache view preserved verbatim.
- [ ] **host.ts registration** — *(deferred to batch integration)*. `memory` is
      already in `BUILTIN_EXTENSIONS`; no new id is introduced, so there is
      nothing to add. Tests do not depend on `BUILTIN_EXTENSIONS`.
- [ ] **CLAUDE.md/README inventory** — *(deferred to batch integration)*. The
      `memory` inventory line in CLAUDE.md "Where things live" gets one clause
      noting per-entry provenance/edit/forget/rollback; the README extension
      count is **not** bumped (no new extension). Reconciled at closeout.
- [ ] `docs/implementation/2026-06-22-white-box-memory.md` — closeout notes.

## 3. Scope Boundary (NOT in scope — Simplicity First)

- **No new extension / no sibling.** This is an in-place upgrade of
  `memory.ts`. A separate `white-box-memory.ts` extension would fork the
  scratchpad store (Decision D1).
- **No change to the compaction summary path.** `transformContext`
  (`memory.ts:131-143`), `summaryFor`/`summarize`/`fingerprint`
  (`memory.ts:55-127`), the `summaryCache` store key, `/compact`, and the
  no-arg `/memory` config view are left exactly as they are. A **separate
  follow-up task retires memory's count-based compaction** (toward `compact`);
  this design must not touch that path.
- **No full undo log / no time-travel.** Rollback restores **one** previous
  value per entry (`prevText`), not an unbounded history (Decision D3). No
  redo, no branching, no cross-entry transaction.
- **No automatic consolidation.** Merge/dedupe happens **only** when the user
  runs `/memory consolidate` (Decision D5). The agent never silently merges.
- **No new capability.** Like today's `remember`/`recall`, this is the agent's
  private notebook — no filesystem/shell/network reach — so it declares none
  (matches `memory.ts:186-188`, `todo.ts:13-14`).
- **No embeddings / semantic dedupe.** `consolidate` dedupes by **exact
  normalized text equality**, not similarity. Vector search is out.
- **No cross-session sync, no export format, no UI beyond command text.**

## 4. Key Design Decisions

### D1. Extend `memory` in place vs. a sibling extension

- **Problem.** Entries with provenance *are* a richer model of the same
  scratchpad data that `remember`/`recall` already own. Where should the new
  data model and sub-commands live?
- **Options.** (a) Extend `memory.ts` in place — `remember` writes the new
  shape, the `/memory` command grows arguments. (b) New sibling extension
  `white-box-memory.ts` that registers its own tools/commands over its own
  store namespace.
- **Choice.** (a) Extend in place.
- **Rationale.** Per-extension stores are **namespaced**: `e.store` is opened
  under the extension id (`extension.ts:224`, `store.open(spec.id)`). A sibling
  extension gets a *different* namespace and therefore cannot see the notes
  `memory`'s `remember` already wrote — it would fork the store, and the two
  `remember` tools (same name) would shadow each other on the registry
  (`registry`/`commands.ts:27-40` "later wins"), producing whichever loaded
  last. Keeping it in `memory.ts` means one store, one `remember`, one source
  of truth, and the `NOTE_PREFIX` keyspace stays coherent.
- **Why (b) rejected.** It splits the single scratchpad into two invisible
  halves and creates a name collision on `remember`/`recall`/`/memory` with
  nondeterministic resolution.

### D2. Entry shape

- **Problem.** What is the minimal record that makes a note inspectable,
  attributable, and reversible?
- **Options.** (a) `{ id, text, source, ts, prevText? }`. (b) Richer:
  `{ id, text, source, ts, history: Entry[], tags, confidence, links, ... }`.
  (c) Keep bare string, store provenance in a parallel side-map.
- **Choice.** (a) `interface Entry { id: string; text: string; source: string; ts: string; prevText?: string }`.
- **Rationale.** This is the smallest shape that satisfies every stated need:
  `id` gives identity for `list`/`edit`/`forget`/`rollback`; `text` is the
  value; `source` is provenance (the turn/tool/`"user"` that created it);
  `ts` is the captured timestamp; `prevText` is the single-step undo
  (Decision D3). `source` and `ts` are plain strings — a **string/format
  choice, non-behavioral**: `source` is a free-form label (e.g.
  `"tool:remember"`, `"user"`, `"turn:3"`) and `ts` is an ISO-8601 string via
  `new Date().toISOString()` (the same path session.ts:87 and checkpoint.ts:110
  use; `ToolContext` carries no clock, `types.ts:154-164`, so capturing time at
  tool-execute time is the normal extension path — the kernel's no-`Date.now()`
  rule is about deterministic seams like `fingerprint`, not tool side effects).
- **Why (b) rejected.** Speculative; nothing in the problem needs tags,
  confidence, links, or a multi-entry history. Each extra field is store growth
  and serialization surface with no driving requirement (Simplicity First).
- **Why (c) rejected.** A parallel side-map duplicates the keyspace and creates
  two things to keep in sync (and to migrate); folding provenance into the
  value is strictly simpler and atomic per `store.set`.

### D3. Rollback depth: one previous value vs. full history

- **Problem.** How much undo history does an entry keep?
- **Options.** (a) Last value only — `prevText?: string`, one step.
  (b) Full history — `history: string[]`, unbounded (or N-deep) stack.
- **Choice.** (a) One step (`prevText`).
- **Rationale.** The driving failure is "a `remember` clobbered a good value;
  put the good value back." One previous value covers exactly that. It bounds
  store growth to **2× text per entry worst case** (current + one prior),
  independent of how many times the entry is edited — each `edit`/`remember`
  overwrite shifts the *current* text into `prevText` and discards the
  older prior. A second consecutive `rollback` is a **no-op** (there is nothing
  before `prevText`), which is honest and predictable.
- **Why (b) rejected.** Unbounded history is the primary store-growth risk this
  design must mitigate (see §8); an N-deep stack just moves the bound and adds a
  trim policy, a redo question, and more serialized bytes — none of which the
  stated problem asks for.

### D4. Backward compatibility & migration

- **Problem.** The existing `remember`/`recall`/summary must keep working, and
  any notes already written as bare strings (`memory.ts:206`) must not break
  `recall` or `list`.
- **Options.** (a) Eager migration: on activate, rewrite every `note:` string
  into an `Entry`. (b) Lazy coexistence: tolerate both shapes on read; a
  string is treated as `{ text: <string>, source: "legacy", ts: "", id: key }`
  with no `prevText`; the next `remember`/`edit` on that key upgrades it in
  place. (c) Break: require entries, drop old notes.
- **Choice.** (b) Lazy coexistence.
- **Rationale.** Eager migration (a) needs a one-time pass that mutates the
  store on activate — surprising, and it touches data the user has not asked to
  change, with no rollback if the migration itself is wrong. Lazy coexistence
  reads either shape (`typeof v === "string" ? wrap(v) : v`) so `recall` and
  `list` work on day-one data, and the first write through the new path
  upgrades the entry naturally. `recall`'s no-key list still returns
  `{ key → text }` (so its existing JSON contract and the
  `memory.test.ts:152-157` round-trip assertion hold); `list` is the new,
  richer view. The summary/compaction path is **untouched** by all of this —
  it reads no `note:` keys.
- **Why (a) rejected.** Mutates user data at startup; risk/benefit is poor for a
  shape `recall` can read lazily anyway.
- **Why (c) rejected.** Violates the explicit backward-compat requirement and
  would silently drop existing notes.

### D5. Consolidate: opt-in command vs. automatic

- **Problem.** Should duplicate/near-duplicate entries be merged automatically?
- **Options.** (a) Automatic — dedupe on every `remember`. (b) Opt-in —
  `/memory consolidate` only.
- **Choice.** (b) Opt-in command.
- **Rationale.** Automatic merging is a **surprise mutation**: two notes the
  agent deliberately kept distinct could vanish mid-run, and a merge that drops
  a `prevText` destroys undo history the user may want. Making it a command
  keeps every automatic write a pure append/overwrite of one entry, and lets the
  human (or model, via the command path) opt into a dedupe pass with a printed
  summary of what merged. `consolidate` dedupes by exact normalized
  (`trim()`, case-folded) text equality — keep the earliest entry, drop later
  exact duplicates, report the count.
- **Why (a) rejected.** Surprise data loss and undo-history destruction on a
  hot path; the cost (a manual command) is trivial.

## 5. Dependencies and Assumptions

- **Kernel store API** (`src/kernel/store.ts:12-17`): `get<T>(key, fallback?)`,
  `set(key, value)`, `delete(key)`, `keys()`. The design uses only these; no
  kernel change. `MemoryBackend` (tests) and `FileBackend` (persisted) both
  satisfy it; `Entry` is plain JSON-serializable data so `FileBackend`'s
  `JSON.stringify` flush (`store.ts:88-95`) round-trips it — **criterion 14**
  exercises that round-trip (including `prevText`) against a real `FileBackend`.
- **ExtensionAPI** (`src/kernel/extension.ts:41-78`): `registerTool`,
  `registerCommand`, `store`, `on` — all already used by `memory.ts`. No new
  surface.
- **`CommandContext`** (`src/kernel/commands.ts:10-16`): `args` (raw string
  after the command name) and `print`. Sub-command dispatch parses `ctx.args`
  with `args.trim().split(/\s+/)` — the established pattern
  (`prompts.ts:67`, `limits.ts:245`).
- **`defineTool`/`ok`/`fail`** (`src/kernel/define.ts:26-49`) for the rewritten
  `remember`/`recall` (today they use raw `e.registerTool({spec,execute})`;
  this design may keep that or move to `defineTool` — non-behavioral).
- **Timestamp source.** `new Date().toISOString()` at tool-execute time
  (precedent: `session.ts:87`, `checkpoint.ts:110`). `ToolContext`
  (`types.ts:154-164`) exposes no clock; capturing wall time in the tool body
  is the normal extension path. Tests assert *shape*/monotone presence of `ts`,
  not an exact value.
- **Assumption.** Entry ids are unique within the `note:` keyspace and stable
  across reads. Generated as a short monotonic/random token (e.g. a
  counter-suffixed key); **criterion 13** pins this to a testable predicate
  (distinct ids across two `remember` calls, identical id on re-read). No
  `crypto` dependency required (pure Node, zero-dep rule).
- **Assumption.** Notes are small (working-memory scale), so a full `keys()`
  scan over `note:`-prefixed keys per `list`/`consolidate` is acceptable — the
  existing `/memory` config view already scans all keys
  (`memory.ts:175`).

## 6. Relationship with Existing Designs

- **Closest — `src/extensions/memory.ts` (the file being extended).** Its
  scratchpad store (`NOTE_PREFIX = "note:"`, `memory.ts:38`; write at `:206`;
  read at `:225-234`), the `remember`/`recall` tools (`memory.ts:190-236`), the
  `/memory` config command (`memory.ts:169-184`), and the `transformContext`
  summary path (`memory.ts:131-143`). This design **only** touches the
  `remember`/`recall` entry model and the `/memory` argument grammar; it leaves
  the summary/cache/`/compact` machinery byte-for-byte.
- **`memory.test.ts`** — the existing suite is extended, not replaced; the
  `remember`/`recall` round-trip (`memory.test.ts:128-158`) and the
  `/memory`+`/compact` view (`:180-209`) must still pass.
- **Dedup vs. neighbors.** `memory`'s summary is an **opaque cached digest** of
  the transcript with no per-fact identity; `compact`
  (`docs/design/2026-06-22-compact.md`) summarizes a transcript slice; a
  `handoff`/`session` distills a session to a resume doc
  (`src/extensions/session.ts`). **None** of these makes individual memory
  *facts* inspectable, attributable, editable, or reversible — they all operate
  on transcript spans, not on named entries. `todo` (`src/extensions/todo.ts`)
  is the closest *structural* analog (session-scoped list + tool + command, no
  capability) but is whole-list-replace with no identity, provenance, or undo.
- **Conflict watch (marked).** A **separate follow-up** retires `memory`'s
  count-based compaction toward `compact`. This design must **not** touch the
  `transformContext`/`summaryFor`/`fingerprint`/`summaryCache`/`/compact` code
  to avoid a merge conflict on that path; it confines all edits to the
  `remember`/`recall`/`note:` model and the `/memory` argument handler.
- **First-design note.** Per-entry provenance + edit/forget/rollback over the
  memory scratchpad has no prior design in `docs/design/`.

## 7. Acceptance Criteria

All driven by `makeHarness` (`test/helpers.ts:27`) with `host.use("memory",
activate)` (`test/recovery.test.ts:118-120`); offline against `MockProvider`.
Tool calls are exercised by scripting the responder (as in
`memory.test.ts:128-158`); commands by invoking
`commands.get("memory")!.run({ agent, args, print })`
(as in `memory.test.ts:193-208`).

1. **Backward-compatible round-trip.** A `remember {key:"color",value:"blue"}`
   then `recall {key:"color"}` returns `tool_result.content === "blue"`
   (the existing `memory.test.ts:128-158` assertion still passes unchanged).
2. **Provenance recorded.** After a `remember`, the stored value at
   `note:color` is an object with `text === "blue"`, a non-empty `source`
   string, a non-empty ISO-8601 `ts` (matches `/^\d{4}-\d{2}-\d{2}T/`), and a
   defined `id`. Asserted by reading `e.store` via a second `host.use` handle or
   by `recall`-list/`list` output.
3. **`/memory list` shows id + provenance.** With two notes present,
   `run({args:"list"})`'s printed lines each contain the entry's `id`,
   `source`, and a date-shaped `ts`, one line per entry; line count equals
   note count.
4. **`/memory edit <id> <text>` replaces by id and preserves prior value.**
   After editing the entry, its `text` equals the new text **and** its
   `prevText` equals the original text. A `recall` of that key returns the new
   text.
5. **`/memory forget <id>` deletes by id.** After `forget`, the `note:` key is
   gone (`e.store.get` is `undefined`), `recall {key}` returns the
   `No note for "<key>"` error result (`memory.ts:227`), and `list` no longer
   lists it.
6. **`/memory rollback <id>` restores the previous value, once.** After an
   `edit` then `rollback`, `text` equals the original value again; a **second**
   consecutive `rollback` leaves `text` unchanged (bounded depth — Decision D3),
   asserted by equality before/after the second call.
7. **`remember` on an existing key shifts current→prevText.** Re-`remember`ing
   the same key with a new value leaves `prevText` equal to the value that was
   current before the call (overwrite is reversible one step), asserted on the
   stored entry.
8. **Old-shape tolerance.** Pre-seeding `e.store.set("note:legacy","old")`
   (bare string) then `recall {key:"legacy"}` returns `"old"`, and `list`
   includes the legacy entry with a sentinel `source` (e.g. `"legacy"`) — no
   throw (Decision D4).
9. **`/memory consolidate` is opt-in and dedupes exact text.** With two notes
   whose normalized text is identical, plain `remember` keeps **both** (no
   auto-merge); after `run({args:"consolidate"})`, exactly one remains and the
   command prints a merged-count line. With distinct texts, `consolidate`
   removes nothing.
10. **Kill switch.** With `EAGENT_MEMORY_ENTRIES=off`, `remember
    {key,value}` writes a **bare string** (`typeof e.store.get("note:"+key) ===
    "string"`), and `run({args:"list"})` prints a disabled/notice line rather
    than entry rows; criterion 1 (`recall` round-trip) still passes.
11. **Summary path untouched.** The existing
    `memory.test.ts` compaction tests (below-threshold `:60`, above-threshold
    `:80`, caching `:104`, no-transcript-mutation `:160`, `/compact`+`/memory`
    view `:180`) all still pass with no edits — proving the `transformContext`
    seam and `/compact` are unaffected.
12. **Clean teardown.** `host.unload("memory")` after activation does not throw
    and removes the `remember`/`recall`/`memory`/`compact` registrations
    (dispose loop never throws — pattern of `todo.ts:128-136`).
13. **Entry ids are unique and stable.** Two `remember` calls with **distinct
    keys** produce entries whose `id` values are **distinct**
    (`a.id !== b.id`), and each `id` is **stable** — re-reading the same entry
    via a later `recall`/`list` (or a second `host.use` handle) returns the
    identical `id`. This pins the §5 id-uniqueness assumption to a testable
    predicate: every id-addressed criterion (4–7) dereferences an id, so a
    colliding or shifting id is a defect, not a passing implementation.
14. **FileBackend round-trip of an `Entry`.** Activating against a `FileBackend`
    (not the test default `MemoryBackend`, `helpers.ts:43`), then `remember` →
    `edit` (so the entry carries a `prevText`) → flush/read cycle: a fresh read
    of `note:<key>` deserializes to an `Entry` whose `text`, `source`, `ts`,
    `id`, **and `prevText`** are byte-identical to the pre-flush values, and a
    subsequent `rollback` restores `prevText` correctly. This exercises the §5
    `JSON.stringify` flush (`store.ts:88-95`) and guards the §8 / D3
    persisted-store growth-and-rollback claims, which are stated for the on-disk
    store and otherwise untested.
15. **No-key `recall` list unwraps `.text` over mixed shapes.** With a new-shape
    entry present (a `remember {key:"color",value:"blue"}`, stored as an `Entry`
    object) **and** a pre-seeded legacy bare string
    (`e.store.set("note:legacy","old")`), a no-key `recall {}` (the list path,
    `memory.ts:230-234`) returns `details` / parsed `content` deep-equal to
    `{ color: "blue", legacy: "old" }` — every value is the unwrapped **text
    string**, never an `Entry` object (no key serializes as
    `{id,text,source,ts,...}`). This pins the D4 promise that the no-key list
    "still returns `{ key → text }`" (white-box-memory.md:189-193) over the new
    Entry shape — the exact spot the implementation must unwrap `.text` from an
    `Entry` while passing legacy bare strings through unchanged. Criterion 1
    covers single-key unwrap and criterion 8 covers single-key legacy; this is
    the only criterion exercising the no-key list path against the object shape.

## 8. Risks and Rollback

- **Risk: store growth from per-entry history.** *Mitigation:* `prevText` is a
  single previous value (Decision D3), so growth is bounded to 2× text per
  entry regardless of edit count; `/memory forget <id>` and `/memory
  consolidate` actively shrink the store; ids are short. No unbounded log. This
  bound is stated for what lands on disk, so **criterion 14** verifies the
  persisted `Entry` (with its single `prevText`) round-trips a `FileBackend`
  flush rather than only the in-test `MemoryBackend`.
- **Risk: backward-compat with existing scratchpad data.** *Mitigation:* lazy
  coexistence (Decision D4) — `recall`/`list` read bare strings as a
  `legacy`-sourced entry; no startup migration, no data rewrite, no throw on
  old data. Criterion 8 asserts this.
- **Risk: breaking the summary/compaction seam.** *Mitigation:* the design
  touches **only** the `note:` model and the `/memory` argument handler; the
  `transformContext`/`summaryFor`/`fingerprint`/`summaryCache`/`/compact` code
  is unchanged, and criterion 11 re-runs the existing summary tests as a guard.
- **Risk: the new entry shape destabilizes a downstream reader.** *Mitigation:*
  `recall`'s no-key list keeps returning `{ key → text }` (text only), so any
  existing JSON consumer sees the same contract; the richer view is `list`.
- **Kill switch.** `EAGENT_MEMORY_ENTRIES=off` makes `remember` write the
  legacy bare string and disables the new sub-commands, reverting `memory` to
  its current behavior at runtime (criterion 10). **Code rollback** is a clean
  revert of `memory.ts` + `memory.test.ts` to the prior commit; because no
  kernel, host, capability, or new file is introduced, the revert is local and
  the rest of the system is unaffected. The change is additive: existing
  `remember`/`recall`/`/memory`/`/compact` behavior is preserved.
