# Design: `microagents` — keyword-triggered knowledge injection

Slug: `2026-06-22-microagents`
Status: draft

## 1. Background and Purpose

EAgent already has two context-injection extensions, but neither covers a
common, valuable pattern found in OpenHands' "knowledge microagents":

- `context-files` (`src/extensions/context-files.ts`) injects project docs
  (`AGENTS.md` / `CLAUDE.md`) **unconditionally, every turn**. It is the
  "always-on" lever.
- `skills` (`src/extensions/skills.ts`) injects only a name+description
  **catalog** every turn (tier 1) and loads a skill's full body only when the
  **model decides** to call `skill_read` (tier 2). It is "model-pull".

The missing pattern is **conditional, event-pushed knowledge**: a body of
domain instructions that should appear in context **only when the conversation
is actually about that domain**, with no model action required. Example: a
`kubernetes.md` note whose deployment conventions should be injected the moment
the user mentions "kubernetes" or "k8s" — but which would only waste tokens (and
dilute attention) if injected on every unrelated turn.

OpenHands implements this as keyword-triggered microagents
(`/tmp/OpenHands/openhands/app_server/app_conversation/skill_loader.py`,
`KeywordTrigger`). EAgent has no equivalent: `skills` always shows the catalog
and requires a model tool call to load a body; `context-files` is unconditional.

What happens if we do not build it: project-specific knowledge that is too
large to keep always-on (the `context-files` size cap is 32 KB total) and that
the model cannot reliably know to pull (`skill_read`) stays out of context
exactly when it is needed, or bloats every turn if forced always-on.

## 2. Deliverables

- [x] `src/extensions/microagents.ts` — a new extension that, on
      `transformContext`, injects the full body of each discovered microagent
      whose trigger keyword appears in the latest user message.
- [x] A `/microagents` command that re-scans and lists discovered microagents
      with their trigger keywords.
- [x] `EAGENT_MICROAGENTS=off` kill switch (mirrors `prune`, `recovery`,
      `write-guard`).
- [x] Registration in `src/host.ts` `BUILTIN_EXTENSIONS`.
- [x] `test/microagents.test.ts` — offline `node:test` suite covering match,
      non-match, word-boundary, kill switch, size cap, and the command.
- [x] One inventory line in `CLAUDE.md` "Where things live" (load-bearing doc).
- [x] `docs/EXTENSIONS.md`: no change — it is a prose author's guide with no
      per-extension inventory table, and this feature adds no capability, so
      there is no row/table to update (conditional deliverable, satisfied as a
      documented no-op).

## 3. Scope Boundary (NOT in scope)

- **No walk-up discovery.** A single directory is scanned, not every ancestor
  (that is `context-files`' job). Resolution (exact order in Decision 4.1):
  `EAGENT_MICROAGENTS_DIR` env override, else `<workspace>/.eagent/microagents/`,
  where `<workspace>` is `EAGENT_WORKSPACE` or `process.cwd()`. This reuses
  `context-files`' *workspace* concept but **not** its `store`-backed `baseDir`
  override layer.
- **No user-global + project merge.** One directory only.
- **No model-pull tool.** Loading a microagent body via a tool call is exactly
  what `skills` already does; we do not duplicate it.
- **No regex / glob / semantic triggers.** Triggers are a literal,
  case-insensitive, whole-word keyword list only.
- **No always-on microagents.** A file with no `triggers` is ignored — use
  `context-files` for always-on content. Every microagent needs ≥1 trigger.
- **No capability gating and no LLM calls.** Pure local read-only context
  injection, identical in privilege to `context-files` and `skills` tier-1
  (both `readFileSync` a conventional directory with no capability).
- **No remote / repository fetching** of microagents (OpenHands' public skills
  repo). Local files only.
- **No trigger matching against assistant/tool messages or older user turns.**
  Only the most recent `user` message is scanned (see Decision 4.2).

## 4. Key Design Decisions

### 4.1 Discovery location — one directory, env-overridable

- **Problem**: where do microagent files live?
- **Options**:
  1. Walk up the tree like `context-files`.
  2. Merge a user-global dir and a project dir like `skills`
     (`~/.eagent/skills`).
  3. A single project directory with an env override.
- **Choice**: option 3, with this **exact** two-level resolution order:
  1. `process.env.EAGENT_MICROAGENTS_DIR`, if set (the directory override,
     modeled on `EAGENT_SKILLS_DIR` in `skills.ts:33`); else
  2. `join(<workspace>, ".eagent", "microagents")`, where `<workspace>` is
     `process.env.EAGENT_WORKSPACE ?? process.cwd()`.

  Note the deliberate divergence from `context-files`: `context-files.ts:51-54`
  resolves `store.get("baseDir") ?? EAGENT_WORKSPACE ?? cwd` — a **`store`-backed
  `baseDir` override checked first**. This design **intentionally omits** that
  `store` layer; there is no runtime store override of the microagents directory.
- **Rationale**: Simplicity First. Microagents are **project knowledge**, so a
  project-rooted directory is the natural home; the env override makes the suite
  hermetic (tests point it at a temp dir). Walk-up (option 1) is the wrong model
  — it is for always-on docs that cascade by specificity, whereas a microagent
  is a single conditional unit. User-global merge (option 2) adds override/merge
  semantics with no demonstrated need and complicates precedence; rejected to
  keep the first version minimal. The `store`-backed `baseDir` layer that
  `context-files` carries is omitted because no caller needs to retarget the
  microagents directory at runtime, and adding an unused knob violates
  Simplicity First.

### 4.2 What text is scanned for triggers — the latest user message only

- **Problem**: keywords are matched against which messages?
- **Options**:
  1. Only the most recent `user` message.
  2. Every `user` message in the transcript.
  3. The entire transcript (all roles).
- **Choice**: option 1 — the last message whose `role === "user"`.
- **Rationale**: A keyword trigger models "the user's current ask is about X".
  Scanning every user message (option 2) or the whole transcript (option 3)
  pins a microagent permanently after a single mention, which defeats the
  *conditional* purpose and steadily bloats context — the exact failure the
  feature exists to avoid. Anchoring on the **last** `user` message (not merely
  the last message) is deliberate: `transformContext` also runs on follow-up
  calls after tool execution where the final message is a `tool_result`;
  scanning the last *user* message keeps the trigger set stable across a turn's
  tool round-trips. This matches OpenHands' `KeywordTrigger`, which evaluates
  the user message.
- **Trigger text extraction**: the text scanned is the concatenation (joined by
  a space) of the `text` blocks in that latest `user` message; non-text blocks
  (`image`, and any tool/thinking blocks should they appear) are ignored. If the
  transcript contains no `user` message, nothing is injected.

### 4.3 Match semantics — case-insensitive, whole-word

- **Problem**: how is a keyword matched within the message text?
- **Options**:
  1. Case-insensitive substring (`includes`).
  2. Case-insensitive whole-word (keyword bounded by non-alphanumeric chars or
     string edges).
  3. Word-boundary regex (`\b`).
- **Choice**: option 2.
- **Rationale**: Plain substring (option 1) fires "cat" inside "category" and
  "k8s" inside "xk8sy" — false positives that inject irrelevant knowledge.
  A JS `\b` regex (option 3) treats `k8s` correctly at edges but `\b` is defined
  on `\w` and mishandles keywords whose own edges are non-word (e.g. a keyword
  ending in `+` like `c++`), and building a regex per keyword per turn invites
  escaping bugs. Option 2 — lowercase both sides, find the keyword, and require
  the characters immediately before and after the match to be non-alphanumeric
  (or absent) — is a few lines, allocation-light, and handles `k8s`, `ci`, and
  punctuated keywords predictably. Keywords are themselves lowercased and
  trimmed at parse time.

### 4.4 Frontmatter format — reuse the `skills` single-line parser

- **Problem**: how are `triggers` (and optional `name`/`description`) declared?
- **Options**:
  1. A new YAML parser (adds complexity; house rule forbids new deps).
  2. Reuse the existing single-line `key: value` frontmatter convention from
     `skills.ts` (`parseFrontmatter`), with `triggers` a comma-separated value.
- **Choice**: option 2 — `triggers: kubernetes, k8s, helm` on one line, split on
  commas, each entry trimmed and lowercased; empty entries dropped. `name`
  defaults to the filename (without `.md`); `description` optional.
- **Rationale**: Consistency with `skills` and Zero-deps. The single-line list
  is sufficient for a keyword set. A file with no non-empty `triggers` after
  parsing is **not** a microagent and is skipped (enforces "no always-on"
  from Scope Boundary).

### 4.5 Size cap and ordering

- **Problem**: bound per-turn cost when several microagents match.
- **Choice**: inject matched microagents ordered by filename (deterministic);
  accumulate bodies until a total byte cap (`MAX_TOTAL_BYTES = 32 * 1024`,
  matching `context-files.ts:31`) would be exceeded, then **stop** adding
  (prefix fill). Each matched microagent is injected whole or not at all (no
  mid-file truncation).
- **Rationale**: Bounded per-turn cost is the same constraint `context-files`
  already solved; reuse its numeric budget and whole-file granularity. The
  algorithm is intentionally simpler than `context-files`' `capTotal`
  (`context-files.ts:196-206`), which tail-fills from the most-specific entry
  and can skip a large middle file: microagents have no specificity ordering, so
  a deterministic filename-ordered prefix fill that stops at the first overflow
  is sufficient and easier to reason about. The shared property — and the only
  one that matters here — is whole-file granularity under a fixed byte budget.

### 4.6 Caching

- **Problem**: avoid re-reading the directory every turn.
- **Choice**: cache the parsed scan result (like `context-files`' `cache`).
  `transformContext` reads the cache (scanning once on first use); the
  `/microagents` command forces a fresh re-scan and refreshes the cache before
  listing.
- **Rationale**: Matching (a string scan of one message) is cheap and runs every
  turn; directory I/O is not, so it is cached. The command is the explicit
  reload lever, matching `context-files`' `context` / `context-reload` shape but
  folded into one command (Simplicity First).

## 5. Dependencies and Assumptions

- Depends only on the kernel `transformContext` hook (`src/kernel/events.ts`),
  the `ExtensionAPI` (`e.hook`, `e.registerCommand`, `e.store`, `e.log`), and
  Node `fs`/`path`/`os` — all already used by `context-files` and `skills`.
- Assumes the `Message` content model from `src/kernel/types.ts`
  (text blocks carry user prose; tool/assistant blocks are not scanned).
- Assumes `transformContext` returns a **new** array and never mutates the
  durable transcript (the contract `prune`, `memory`, `context-files` all hold).
- No external systems, no network, no new npm dependency (jiti-only rule holds).
- Data format: UTF-8 markdown files with single-line `key: value` frontmatter.

## 6. Relationship with Existing Designs

- `docs/design/2026-06-20-prune.md` and `src/extensions/prune.ts` establish the
  `transformContext`-returns-new-array, kill-switch (`EAGENT_PRUNE=off`)
  convention this feature mirrors (`EAGENT_MICROAGENTS=off`).
- `src/extensions/context-files.ts` is the closest sibling: same hook, same
  *workspace* concept (`EAGENT_WORKSPACE` ?? `cwd`), same `MAX_TOTAL_BYTES =
  32*1024` budget (`context-files.ts:31`), same cached-scan + reload-command
  shape, same ephemeral system-message injection with `meta.source`. Two
  deliberate divergences: (a) this design omits `context-files`' `store`-backed
  `baseDir` override (`context-files.ts:51`; see Decision 4.1); (b) the size cap
  is a simpler **prefix fill** (filename order, stop at first overflow) rather
  than `context-files`' `capTotal` **tail-fill** (`context-files.ts:196-206`),
  which fills from the most-specific tail and can skip a large middle file — see
  Decision 4.5. This design deliberately reuses the shared patterns; it does
  **not** conflict with them (always-on vs. keyword-conditional are
  complementary, not overlapping).
- `src/extensions/skills.ts` provides the `parseFrontmatter` single-line
  convention (reused), the `EAGENT_SKILLS_DIR` env-override precedent (mirrored
  as `EAGENT_MICROAGENTS_DIR`), and the tier-1 catalog-injection pattern.
  Microagents are the **push** counterpart to skills' **pull**; no overlap in
  directory or mechanism.
- No conflicts identified. Terminology anchors: CLAUDE.md (the extension
  inventory under "Where things live") and the project README.

## 7. Acceptance Criteria

All verified offline by `npm test` (the suite runs against `MockProvider`, no
network, no API key). Each criterion is realized as an assertion in
`test/microagents.test.ts` unless noted.

1. **Trigger fires**: with a microagent file `k8s.md` containing
   `triggers: kubernetes, k8s` and body `BODY-K8S`, calling the registered
   `transformContext` handler on messages whose latest `user` message text is
   `"how do I scale kubernetes?"` returns an array that contains a system
   message whose text includes `BODY-K8S`.
2. **No trigger, no injection**: the same handler on a latest user message
   `"how do I scale a database?"` returns the input array **by reference**
   (no new array allocated on the no-match path, matching `context-files.ts:79`
   and `prune.ts:73`, the no-work-needed returns of both siblings).
3. **Case-insensitive**: latest user message `"Deploy to KUBERNETES"` fires the
   `kubernetes` trigger.
4. **Whole-word, no substring false positive**: a microagent with
   `triggers: cat` is **not** injected for latest user message
   `"list the category"`; it **is** injected for `"feed the cat."`.
5. **Latest-user-message anchoring**: when the last message is a `tool_result`
   but the most recent `user` message contains the keyword, the microagent is
   still injected (trigger evaluated against the last `user` message, not the
   last message).
6. **Multiple matches + size cap**: two matching microagents are both injected
   when under budget; when their combined size exceeds `MAX_TOTAL_BYTES`, the
   handler injects whole files in filename order until the next file would
   exceed the cap, and never mid-truncates a file. (Verified with oversized
   temp files.)
7. **Files without triggers are ignored**: a `.md` file with no `triggers`
   frontmatter is never injected and does not appear in `/microagents` output.
8. **Kill switch**: with `EAGENT_MICROAGENTS=off`, the handler returns the input
   array unchanged (by reference) regardless of matches.
9. **Command**: the `/microagents` command prints each discovered microagent's
   name and its trigger keywords; with an empty/absent directory it prints a
   "none" line and does not throw.
10. **Quality budget**: `npm run typecheck` exits 0 and the full `npm test`
    exits 0 (`# fail 0`) with the new `test/microagents.test.ts` subtests
    included — i.e. no pre-existing subtest regresses and the new suite passes.
    (Per-turn cost is bounded by the
    32 KB cap from criterion 6; no separate latency budget is declared because
    the hot path is a single bounded string scan plus a cached directory read —
    documented here rather than measured, consistent with `context-files`,
    which declares no latency budget either.)

## 8. Risks and Rollback

- **Risk: stale cache in a long REPL session** — a microagent added mid-session
  is not seen until reload. *Mitigation*: `/microagents` forces a re-scan; this
  matches `context-files`' explicit-reload model. Acceptable.
- **Risk: false-positive injection** diluting context. *Mitigation*: whole-word
  matching (Decision 4.3) plus the latest-user-message-only scope (4.2) bound
  this; the size cap (4.5) bounds the cost when it happens.
- **Risk: malformed frontmatter / unreadable file** throwing in the hot path.
  *Mitigation*: discovery wraps file reads in try/catch and skips bad entries
  (same as `skills.scanSkills` and `context-files.firstInDir`); a discovery
  failure degrades to injecting nothing, never throws out of `transformContext`.
- **Risk: directory traversal / reading outside the workspace.** The scan reads
  only direct children (`*.md`) of the single resolved microagents directory; it
  does not follow paths from file contents. No capability is exposed.
- **Rollback**: the feature is a single self-contained extension plus one line
  in `BUILTIN_EXTENSIONS`. Removing that line (or `EAGENT_MICROAGENTS=off`)
  fully disables it with zero effect on other extensions; deleting
  `src/extensions/microagents.ts` and `test/microagents.test.ts` removes it
  entirely. No schema, storage, or protocol change to revert.
