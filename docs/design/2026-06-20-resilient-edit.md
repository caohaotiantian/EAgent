# Design: resilient `edit` matching — whitespace-insensitive fallbacks

Status: closed
Closing-commit: c5f8f32
Closed-on: 2026-06-20
Deferred: finding — `IndentationFlexibleReplacer` is provably unreachable as a
first winner (its yielded span is always subsumed by `LineTrimmedReplacer`, which
runs earlier, once opencode's interleaved `BlockAnchorReplacer` is excluded per
D1); it is retained as a faithful port of opencode's ladder and is harmless (it
can never cause a wrong edit), but a future Simplicity-First pass could drop it
and relabel its unit test (no tracker available; recorded here).
Slug: `2026-06-20-resilient-edit`

## 1. Background and Purpose

EAgent's `edit` tool (`src/extensions/core-tools.ts:120-165`) replaces an
**exact** substring: `content.split(old).length - 1` counts occurrences, and the
edit fails if the count is 0 ("Text not found") or >1 without `replaceAll`
("appears N times"). This exactness is a deliberate safety choice — but it makes
`edit` brittle against the single most common LLM editing failure: the model
reproduces the target text with slightly different **whitespace** (a tab vs.
spaces, a different indentation level, a trailing space, an escaped `\n` instead
of a real newline). The bytes differ, the exact match misses, and the edit fails
even though a human can see exactly which span was meant.

The upstream project [opencode](https://github.com/anomalyco/opencode) solves
this in `packages/opencode/src/tool/edit.ts` with a ladder of `Replacer`
strategies: try the exact match first, then progressively whitespace-insensitive
ones (line-trimmed, whitespace-normalized, indentation-flexible,
escape-normalized, trimmed-boundary), and — only as a last resort — similarity
(Levenshtein) matching. Each replacer locates the *actual* span in the file so
the replacement preserves surrounding formatting.

This task digests opencode's **deterministic, structural** replacers into
EAgent's `edit` tool. When (and only when) the exact match finds **zero**
occurrences, `edit` tries the fallback strategies in strict→loose order and
accepts the first one that identifies a **single, unique** span. The strict
exact-match path and the existing ambiguity guard are unchanged; the only
behavior delta is that some edits that **fail today** now succeed when the
intended span is unambiguous. The similarity/Levenshtein replacers are
deliberately **excluded** (see D1) — EAgent never edits on a fuzzy guess.

If we do not do this, `edit` keeps failing on benign whitespace drift, forcing
the agent into re-read/retry loops that waste turns and context.

## 2. Deliverables

- [x] `src/extensions/edit-match.ts` — a pure, dependency-free module exporting
      `locateEdit(content, find, replaceAll): EditMatch` that returns the matched
      span and the strategy that found it, or a typed
      not-found / ambiguous / disproportionate result. Houses the ported
      structural replacers, the `isDisproportionateMatch` guard, and the
      empty-`find` guard (D2).
- [x] `src/extensions/core-tools.ts` — the `edit` tool calls `locateEdit` on an
      exact-match miss, replaces the located span (honoring `replaceAll`), and
      reports which strategy matched when it was a non-exact one.
- [x] `test/edit-match.test.ts` — offline unit tests for each replacer and the
      `locateEdit` contract (exact precedence, unique-only acceptance,
      strict→loose order, not-found/ambiguous results).
- [x] `test/core-tools.test.ts` — extend with live `edit` tests: whitespace-drift
      now edits; exact behavior and the ambiguity guard are unchanged; the
      feedback names a non-exact strategy.
- [x] `CLAUDE.md` — confirmed no change required: the four-builtins description
      does not enumerate matching semantics, so it stays accurate (out of scope).

## 3. Scope Boundary (NOT in scope)

- **No similarity / fuzzy matching.** The Levenshtein-based `BlockAnchorReplacer`
  and `ContextAwareReplacer` (opencode `edit.ts:288`, `:588`) and the
  `MultiOccurrenceReplacer` are **not** ported. EAgent only relaxes
  *whitespace/escaping*, never matches on a similarity threshold — a wrong-span
  edit is worse than a failed edit.
- **No intra-line sub-span regex matching.** opencode's
  `WhitespaceNormalizedReplacer` has a branch (`edit.ts:438-455`) that builds a
  `\s+`-joined regex from the `find` words and can match a *partial line*. EAgent
  ports only its full-line and multi-line-block matching; the intra-line regex
  branch is **excluded** (it is the most surprising path and the one most likely
  to yield an unexpected unique span).
- **The `EscapeNormalizedReplacer` ports opencode's full unescape set**
  (`edit.ts:501-524`: `\n \t \r ' " ` + "`" + ` \\ \n $`), not a reduced subset —
  faithful repair of the literal-escape drift models actually emit.
- **The empty/whitespace-only `find` exact-path behavior is unchanged.** Only the
  new relaxed ladder adds an empty-`find` guard (D2); the pre-existing exact
  handling of an empty `old` is left exactly as-is (not fixed here).
- **No weakening of the exact path.** When the exact substring occurs ≥1 time,
  behavior is byte-for-byte identical to today (including the "appears N times →
  pass `replaceAll`" ambiguity error). Fallbacks run **only** on exact-count 0.
- **No new tool, no kernel change.** Only the `edit` tool body changes; `read`,
  `write`, `bash` are untouched; the `ToolSpec`/dispatch contract is unchanged.
- **No multi-file or regex edit.** Still a single-file, literal-span replacement.
- **No config/kill switch.** The change is strictly additive (only converts
  current failures into unambiguous successes) and self-announcing (D5), so no
  toggle is introduced (see D6).
- **No auto-formatting / re-indentation of the replacement text.** The
  replacement string is inserted verbatim, exactly as today.

## 4. Key Design Decisions

### D1. Port the structural replacers only; exclude similarity matching

- **Problem:** Which of opencode's replacers belong in a minimalist, safety-first
  kernel?
- **Options:** (a) port all (incl. Levenshtein BlockAnchor/ContextAware);
  (b) port none (keep exact-only); (c) port only the deterministic structural
  ones (LineTrimmed, WhitespaceNormalized, IndentationFlexible, TrimmedBoundary,
  EscapeNormalized).
- **Choice:** (c).
- **Rationale:** The structural replacers relax only *whitespace* or *escaping*
  and still require the non-whitespace content to match exactly — a
  near-zero-risk relaxation. The similarity replacers (a) accept a span at
  ≥0.65 Levenshtein similarity, i.e. they will edit text that is **not** what the
  model asked for — exactly the silent-wrong-edit failure EAgent's strictness
  exists to prevent. (b) leaves the real pain unsolved. (c) captures ~all the
  practical benefit (whitespace drift is the dominant failure) with none of the
  guessing. Rejected (a) on safety, (b) on value.

### D2. Safety contract: exact path untouched; relaxed path is unique + proportionate

This is a **faithful port of opencode's relaxed mechanics, with one deliberate
EAgent-stricter deviation** — stated explicitly so a reviewer does not mistake
it for opencode's exact loop.

- **Problem:** How to add flexibility without ever editing the wrong place?
- **Choice:**
  1. **Exact first, and exact is terminal (EAgent-stricter than opencode).** If
     the exact substring `find` occurs **≥1** time, `locateEdit` returns
     `kind:"exact"` and the caller applies today's logic verbatim (count 1 →
     replace; count >1 → `replaceAll` or the "appears N times" ambiguity error).
     The fallback ladder does **not** run. (opencode `edit.ts:705-721` would fall
     through to relaxed strategies even when an exact-but-ambiguous match exists;
     EAgent refuses to, to keep the exact-path guarantee absolute.)
  2. **Relaxed ladder only on exact-count 0.** Run the structural replacers in
     **opencode's source order for the kept strategies** (`edit.ts:694-704` minus
     the excluded ones): `LineTrimmed → WhitespaceNormalized →
     IndentationFlexible → EscapeNormalized → TrimmedBoundary`. For each replacer
     in order, for each candidate span `search` it yields that is present in
     `content` (`indexOf !== -1`):
     - **Proportionality guard (ported `isDisproportionateMatch`,
       `edit.ts:731-737`):** reject the whole edit with a "re-read and provide the
       exact text" error if `search` is disproportionately larger than `find` —
       `searchLines >= max(oldLines+3, oldLines*2)`, or (when `oldLines===1` is
       false) `search.trim().length > max(oldTrim+500, oldTrim*4)`. This bounds
       *how much* text a relaxed match may replace, independent of uniqueness.
     - **Uniqueness:** for a non-`replaceAll` edit, accept `search` only if it is
       unique (`indexOf(search) === lastIndexOf(search)`); a non-unique candidate
       is skipped in favour of a later (stricter-yielding) one.
     - The **first** candidate that is present, proportionate, and (unique or
       `replaceAll`) wins.
  3. **Outcomes:** if some candidate was present but none was unique →
     `kind:"ambiguous"`; if a present candidate was disproportionate →
     `kind:"disproportionate"` (caller emits the re-read error); if nothing was
     present → `kind:"not-found"`.
  4. **Empty/whitespace `find` guard:** if `find.trim() === ""`, the ladder is
     skipped and `kind:"not-found"` is returned, so a degenerate `find` (which
     `TrimmedBoundary`/escape relaxation could collapse to the empty string) can
     never match everything. (The pre-existing exact path's handling of an empty
     `find` is unchanged and out of scope — §3.)
- **Rationale:** Preserves every current guarantee (exact wins; exact ambiguity
  still errors) and adds two independent safety bounds on the *relaxed* path —
  **uniqueness** (never silently pick one of several whitespace-variant spans)
  and **proportionality** (never let a short `find` swallow a much larger span,
  the failure mode uniqueness alone does not bound). The strict→loose order means
  the tightest relaxation that works is the one used.

### D3. Algorithm in a separate pure module `edit-match.ts`

- **Problem:** Where does the matching logic live?
- **Options:** (a) inline in `core-tools.ts`; (b) a separate pure module.
- **Choice:** (b) `src/extensions/edit-match.ts`.
- **Rationale:** The replacers are ~120 lines of pure string logic with rich edge
  cases; inlining them would bloat the four-builtins file and bury the tool
  wiring. A separate module is unit-testable in isolation (each replacer tested
  directly) and keeps `core-tools.ts` readable. Rejected (a) on readability and
  testability. (The module sits in `src/extensions/` beside `core-tools.ts`; it
  is a helper, not a registered extension.)

### D4. `replaceAll` operates on the located span

- **Problem:** How does `replaceAll` interact with a fallback match?
- **Choice:** When `locateEdit` returns a span `M` (exact or relaxed),
  `replaceAll` replaces **every occurrence of `M`** (the located literal text) in
  `content`, exactly as `content.split(M).join(new)` does today. Because a
  relaxed match is accepted only when `M` is the single distinct span, relaxed +
  `replaceAll` replaces that one span (equivalent to a single replace); exact +
  `replaceAll` is unchanged.
- **Rationale:** Keeps one coherent replacement primitive (replace literal `M`)
  for both paths; no separate relaxed-replaceAll semantics to reason about.
  Avoids the surprising case of `replaceAll` expanding a fuzzy match across many
  near-variants.

### D5. Transparency: a non-exact match is announced in the result

- **Problem:** The model/user should know an edit matched via relaxed whitespace,
  not exactly.
- **Choice:** On a fallback match, the success message appends the strategy, e.g.
  `Edited <path> (1 replacement; matched via whitespace-insensitive fallback:
  line-trimmed).` Exact matches keep today's message verbatim. A
  `kind:"disproportionate"` result yields a distinct **error** ("matched span is
  much larger than the text to replace; re-read the file and provide the exact
  text"), so the model re-reads rather than over-replacing.
- **Rationale:** Silent relaxation would hide that `edit` made a judgement call.
  Naming the strategy makes the behavior observable and debuggable, and lets a
  caller notice if a relaxed match was unexpected. Mirrors opencode surfacing the
  replacement count.

### D6. No config toggle (strictly-additive + transparent)

- **Problem:** Should relaxed matching be switchable off?
- **Options:** (a) add a config/env kill switch; (b) always on.
- **Choice:** (b).
- **Rationale:** Unlike the policy guards (`bash-policy`, spill) whose defaults
  change observable behavior for *succeeding* operations, this change only ever
  converts a **failing** exact edit into a unique, announced success — it never
  alters an edit that succeeds today (D2) and it announces itself (D5). A toggle
  would be speculative configuration (Simplicity First). Rejected (a); revisit
  only if a concrete need for exact-only mode appears.

## 5. Dependencies and Assumptions

- **`edit` tool internals** (`core-tools.ts:120-165`): currently uses
  `content.split(old)` for counting and replacing; the new flow inserts a
  `locateEdit` call between the read and the write. `confine`, the read, and the
  write are unchanged.
- **Pure string/Node only.** No npm dependency; no `fs` beyond what `edit`
  already does. The replacers are pure functions of `(content, find)`.
- **Strict TS** (`noUncheckedIndexedAccess`): the ported loops index
  `lines[i+j]` etc.; the EAgent port must guard those accesses (opencode runs
  without that flag) — an implementation obligation, noted for L2.
- **Test harness:** `test/core-tools.test.ts` already drives `edit` directly
  (registering the extension and calling the tool); `edit-match.ts` is tested as
  a pure import. Offline, no network.

## 6. Relationship with Existing Designs

- Independent of the `bash-policy` and `tool-output-spill` tasks (no shared
  state); same repo conventions. No supersession.
- **Modifies a core builtin** (`edit` in `core-tools.ts`), one of the "four
  built-in tools" CLAUDE.md calls out. The change is contained to the `edit`
  body + a new helper module; `read`/`write`/`bash` and the kernel are untouched.
  This is the load-bearing surface that makes this a Full-Mode change.
- Terminology anchor: CLAUDE.md ("everything is an extension"; the four builtins
  live in `core-tools.ts`) and the existing `edit` tool description ("Replace an
  exact substring in a file. Fails if not found or ambiguous.") — note the
  description's "exact"/"ambiguous" wording stays **true** under this change
  (exact is still tried first; ambiguity still fails), so it need not change.

## 7. Acceptance Criteria

Verified by `npm test` (offline) and `npm run typecheck` (exit 0).

1. **Typecheck clean:** `npm run typecheck` exits 0 (the ported loops are
   index-guarded for `noUncheckedIndexedAccess`).
2. **Exact precedence (unit):** when `find` occurs exactly in `content`,
   `locateEdit` returns `kind:"exact"` with the exact span, even if a relaxed
   strategy would also match elsewhere — exact is never overridden.
3. **Each structural replacer matches its case (unit), tried in the order
   line-trimmed → whitespace-normalized → indentation-flexible →
   escape-normalized → trimmed-boundary:** each fixture's `find` must **not**
   occur verbatim in `content` (so the exact path misses and the relaxed ladder
   actually runs); direct tests prove
   - line-trimmed: `find` with different leading/trailing per-line whitespace
     locates the real span;
   - whitespace-normalized: `find` whose internal runs of spaces/tabs differ
     (full-line or multi-line block) locates the span;
   - indentation-flexible: `find` indented at a different level (uniform shift)
     locates the span;
   - escape-normalized: `find` containing literal `\n`/`\t` locates the real
     span containing the actual newline/tab;
   - trimmed-boundary: `find` with extra leading/trailing blank lines/space
     locates the span.
4. **Unique-only acceptance (unit):** a relaxed strategy that would match two
   distinct spans does **not** silently pick one; `locateEdit` reports
   `kind:"ambiguous"` (when no stricter strategy yields a unique span).
5. **Proportionality guard (unit):** a relaxed candidate whose span is
   disproportionately larger than `find` (per the ported `isDisproportionateMatch`
   thresholds) yields `kind:"disproportionate"`, and the live `edit` returns the
   re-read error instead of replacing — even though the candidate was unique.
6. **Empty/whitespace `find` (unit):** `locateEdit(content, "   ", …)` returns
   `kind:"not-found"` (the ladder is skipped), never matching the whole file.
7. **Not found (unit):** content with no exact and no structural match returns
   `kind:"not-found"`.
8. **Live edit on whitespace drift:** through the registered `edit` tool, an
   `old` that differs from the file only by indentation/trailing whitespace
   performs the replacement and the file content changes correctly; the result
   message names the fallback strategy (D5).
9. **Exact behavior unchanged (live/regression):** the existing
   `test/core-tools.test.ts` `edit` tests pass unmodified — exact replace works,
   "Text not found" still returned when truly absent, and the
   appears-N-times-without-`replaceAll` ambiguity error is unchanged.
10. **`replaceAll` over a located span (live):** `replaceAll` with an exact `old`
    replaces all occurrences (unchanged); with a relaxed unique `old` it replaces
    that single located span.
11. **Regression:** `npm test` reports `# fail 0` (≥ 261 prior tests plus the new
    subtests).

No performance budget: the replacers are O(lines × find-lines) string scans run
once per `edit` call only on an exact miss — off any hot loop — so a latency
budget is excluded per the Scope Boundary.

## 8. Risks and Rollback

- **R1 — A relaxed match picks an unintended (but unique) span.** Possible only
  when the exact match fails AND a whitespace/escape-normalized variant uniquely
  matches a *different* location. *Mitigation:* three independent bounds —
  relaxation is whitespace/escaping only (content must otherwise match);
  acceptance requires a **single** unique span; and the **proportionality guard**
  (D2, ported `isDisproportionateMatch`) rejects a span much larger than `find`,
  closing the "unique but over-broad" hole uniqueness alone leaves open. The
  result also **announces** the fallback (D5) so the edit is auditable, and the
  exact + ambiguity guarantees are untouched. This is a far smaller risk surface
  than opencode's accepted similarity matching, which this design excludes (D1).
- **R2 — Strict-TS index-access regressions.** Porting loops written without
  `noUncheckedIndexedAccess` can introduce `undefined` index reads.
  *Mitigation:* AC-1 (typecheck) plus per-replacer unit tests (AC-3) catch these;
  the L2 plan calls out index guarding explicitly.
- **R3 — Scope creep into fuzzy matching.** A future contributor may be tempted
  to add the excluded similarity replacers. *Mitigation:* the exclusion is an
  explicit Scope Boundary item and D1 records the safety rationale.
- **Rollback:** revert the `core-tools.ts` `edit` diff (restoring the
  `split`-based exact replace) and delete `edit-match.ts` + its tests; no
  persisted state, no config, no migration. The exact path is unchanged, so a
  revert is behavior-neutral for all currently-succeeding edits.
