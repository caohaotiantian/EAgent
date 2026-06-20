# Implementation: resilient `edit` matching — whitespace-insensitive fallbacks

Slug: `2026-06-20-resilient-edit`
Design doc: `docs/design/2026-06-20-resilient-edit.md`

## 1. Task Index

| Design Deliverable (§2) | Design Acceptance Criterion (§7) | Phase |
| --- | --- | --- |
| `src/extensions/edit-match.ts` — replacers + `isDisproportionateMatch` + `locateEdit` | 2–7 | P1 |
| `src/extensions/core-tools.ts` — `edit` calls `locateEdit`, maps each kind | 8–10 | P1 |
| `test/edit-match.test.ts` — pure unit tests | 2–7 | P1 |
| `test/core-tools.test.ts` — live `edit` tests | 8–10 | P1 |

Design Key Design Decisions: D1 (structural-only, exclude fuzzy), D2 (exact
terminal; relaxed = unique + proportionate; empty-find guard), D3 (separate pure
module), D4 (`replaceAll` over located span), D5 (announce strategy / re-read
error), D6 (no toggle).

## 2. Phase Breakdown

One coherent change: a new pure helper module + the `edit` tool wiring + two test
files; `npm test` green at the end. **One Phase**, strict TDD order.

### Phase 1 — resilient edit matching

**Entry condition:** baseline green — `npm test` `# fail 0` (261 pass on this
branch), `npm run typecheck` exit 0, clean tree.

**Design references:** `docs/design/2026-06-20-resilient-edit.md` §2, §4 D1–D6,
§7 AC 1–11, §8 R1–R3.

**The shared contract (both T1 and T2 implement to this):**

```ts
export type EditMatch =
  | { kind: "exact"; span: string; count: number }   // find occurs verbatim ≥1×
  | { kind: "relaxed"; span: string; strategy: string } // unique proportionate relaxed span
  | { kind: "ambiguous" }        // relaxed candidate(s) present but none unique
  | { kind: "disproportionate" } // a present relaxed candidate is over-broad
  | { kind: "not-found" };
export function locateEdit(content: string, find: string, replaceAll: boolean): EditMatch;
```

`locateEdit` logic (design D2): if `find.trim() === ""` → `not-found`. Count exact
occurrences of `find`; if ≥1 → `{kind:"exact", span:find, count}`. Else run the
ladder `LineTrimmed → WhitespaceNormalized → IndentationFlexible →
EscapeNormalized → TrimmedBoundary` (each a `function*(content, find)` yielding
candidate spans present in `content`); for each candidate `search` with
`content.indexOf(search) !== -1`: if `isDisproportionateMatch(search, find)` →
`{kind:"disproportionate"}`; else if `replaceAll` OR
`indexOf(search)===lastIndexOf(search)` → `{kind:"relaxed", span:search,
strategy}`; else remember "some candidate seen". After the ladder: if any
candidate was seen but none accepted → `{kind:"ambiguous"}`, else `not-found`.

**Task list (TDD order — test tasks first):**

- **T1 (test): unit tests for the replacers + `locateEdit`** in
  `test/edit-match.test.ts`. Each new behavior gets a failure-meaningful assertion
  (the invariant is *a relaxed match locates the real span only when it is unique
  and proportionate; exact always wins*):
  - exact precedence (AC-2): `find` present verbatim → `kind:"exact"`, `count`
    correct, even when a relaxed variant exists elsewhere.
  - each replacer (AC-3), with fixtures whose `find` does **not** occur verbatim
    (so exact misses): line-trimmed (per-line whitespace differs);
    whitespace-normalized (internal space/tab runs differ, full-line and
    multi-line block — **not** the excluded intra-line regex sub-span);
    indentation-flexible (uniform indent shift); escape-normalized (literal
    `\n`/`\t` in `find` vs real newline/tab in content; full unescape set);
    trimmed-boundary (extra leading/trailing blank lines/space). Assert the
    returned `span` is the real content substring and `strategy` names the matcher.
  - unique-only (AC-4): a relaxed variant matching two distinct spans →
    `kind:"ambiguous"`.
  - proportionality (AC-5): a unique relaxed candidate far larger than `find`
    (per `isDisproportionateMatch`) → `kind:"disproportionate"`.
  - empty/whitespace `find` (AC-6): `locateEdit(content, "   ", false)` →
    `kind:"not-found"`.
  - not found (AC-7): no exact, no structural match → `kind:"not-found"`.
  Watch fail (module absent).

- **T2 (impl): `src/extensions/edit-match.ts`.** Port the five structural
  replacers from opencode `edit.ts` (244-590) as `function*` generators, **plus**
  `isDisproportionateMatch(search, find)` verbatim from `edit.ts:731-737`
  (`searchLines >= Math.max(oldLines+3, oldLines*2)`; if `oldLines===1` return
  false; else `search.trim().length > Math.max(oldTrim+500, oldTrim*4)`). Write
  `locateEdit` per the contract above. **Guard every array index** for
  `noUncheckedIndexedAccess` (the opencode source assumes unchecked indexing —
  e.g. `lines[i+j]`, `match[1]`; use a local `const x = arr[k]; if (x ===
  undefined) …` or `?? ""` as appropriate). No `any`. ESM `.js` specifiers. Make
  T1 green.

- **T3 (test): live `edit` tests** in `test/core-tools.test.ts` (extend the
  existing `edit` describe/test). Each asserts an end-to-end invariant through the
  registered tool:
  - whitespace-drift edit (AC-8): a file with indented code; `old` provided at a
    different indentation performs the replacement, the file content changes
    correctly, and the success message contains `matched via` + the strategy name.
  - exact unchanged (AC-9): the *existing* edit tests still pass (do not modify
    them); add an explicit assertion that an exact `old` present twice without
    `replaceAll` still returns the "appears 2 times" error, and a truly-absent
    `old` returns "not found".
  - proportionality re-read (AC-5 live): an `old` that relaxed-matches a
    disproportionately larger span returns an error mentioning re-reading / the
    exact text, and the file is **unchanged**.
  - `replaceAll` over located span (AC-10): exact `old` + `replaceAll` replaces
    all (unchanged); a relaxed unique `old` + `replaceAll` replaces the single
    located span.
  Watch the new ones fail.

- **T4 (impl): wire `locateEdit` into `edit`** (the `count`-based block at
  `core-tools.ts:148-162`, inside the `execute` at :135). Replace that block with
  a `locateEdit(content, oldStr, !!args.replaceAll)`
  call and a switch on `kind`:
  - `exact`: **preserve today's behavior exactly** — `count>1 && !replaceAll` →
    `fail("Text appears N times … pass replaceAll …")`; else replace
    (`replaceAll ? split(oldStr).join(new) : content.replace(oldStr,new)`); same
    success message as today.
  - `relaxed`: `replaceAll ? content.split(span).join(new) :
    content.replace(span, new)`; success message appends `; matched via
    whitespace-insensitive fallback: <strategy>`.
  - `ambiguous`: `fail` with a "appears multiple times; add surrounding context"
    message.
  - `disproportionate`: `fail("matched span is much larger than the text to
    replace; re-read the file and provide the exact text")`.
  - `not-found`: `fail("Text not found in <path>.")` (today's message).
  Keep `confine`, the read, and the write untouched. Make T3 green.

**Per-task acceptance commands** (repo root):

- T1/T2: `node --import tsx --test test/edit-match.test.ts` — unit tests pass (0 fail).
- T3/T4: `node --import tsx --test test/core-tools.test.ts` — live edit tests pass (0 fail).
- Phase exit: `npm run typecheck` exit 0 **and** `npm test`
  (`node --import tsx --test "test/**/*.test.ts"`) `# fail 0`.

**Exit condition:** typecheck 0; `npm test` `# fail 0` (≥ 261 prior + new
subtests); design AC 1–11 each map to a passing assertion.

## 3. Engineering Constraints Index

- **Project norms** — `CLAUDE.md` House conventions: ESM `.js` specifiers, strict
  TS (`noUncheckedIndexedAccess` — explicitly guard the ported loops), no `any`,
  zero deps except `jiti` (pure string logic, Node stdlib only). The `edit`
  tool's `confine`/read/write are unchanged.
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phase1): …` opener; `fix(phase1-roundR):
  <keyword>`; `npm test`/typecheck trailers; no AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- **Reused:** `test/core-tools.test.ts` existing `edit` harness (registers
  core-tools, writes a temp file under the workspace, calls the tool, asserts
  result/file). `edit-match.ts` is tested as a pure import (no harness).
- **New:** `test/edit-match.test.ts`. No network, no fixtures on disk for the
  unit tests (pure strings). Live tests reuse the existing temp-file pattern.

## 5. Regression Protection

- Full `npm test` stays `# fail 0`. The **existing `test/core-tools.test.ts`
  `edit` tests must pass unmodified** — they pin the exact-match behavior the
  `exact` switch branch reproduces byte-for-byte (success message, "Text not
  found", "appears N times" ambiguity). Do **not** edit those existing
  assertions; only add new ones.
- Only `src/extensions/edit-match.ts` (new), `src/extensions/core-tools.ts` (edit
  body only), `test/edit-match.test.ts` (new), and `test/core-tools.test.ts`
  (additions) change. No kernel change; `read`/`write`/`bash` untouched; the
  `ToolSpec`/dispatch contract unchanged. `npm run typecheck` stays clean.
- No `CLAUDE.md` change: the `edit` description ("Replace an exact substring …
  Fails if not found or ambiguous.") stays true (exact is tried first, ambiguity
  still fails), per design §6 — confirm and leave untouched.
