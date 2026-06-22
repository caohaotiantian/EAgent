# Implementation — bash-policy rule ergonomics (justification + pattern alternatives)

Design: `docs/design/2026-06-21-bash-policy-rule-ergonomics.md` (slug shared).
Single Phase: the change is additive to one source file (`src/extensions/bash-policy.ts`)
and its one test file (`test/bash-policy.test.ts`); `npm test` is green at Phase end.

## 1. Task Index

| Deliverable (design §2) | Acceptance criteria (design §7) | Tasks |
| --- | --- | --- |
| `Rule.justification?: string` (optional) | 5, 6 | T-impl-A |
| `evaluateAny` returns `rule?: Rule` | 6 | T-test-2, T-impl-C |
| Guard surfaces justification at deny / ask-prompt / ask-denied (site-appropriate) | 3, 4, 5 | T-test-3, T-impl-D |
| `toRegExp` bracket-pipe alternation `[a|b]` | 7, 8, 10 | T-test-1, T-impl-B |
| `\` escape (`\[ \] \| \\` → literals; `*` no literal form; `\`+other = literal `\`) | 12 | T-test-1, T-impl-B |
| Unterminated/degenerate brackets fail-safe literal | 9 | T-test-1, T-impl-B |
| `/bash-policy` status prints justification, pattern verbatim | 11 | T-test-4, T-impl-E |

Design line ranges for the implementer: Deliverables §2 (lines ~31–94), Decisions
§4 (~107–236), Acceptance Criteria §7 (~277–318).

## 2. Pre-flight facts (verified at L2 — do not re-litigate)

- **No in-repo rule pattern contains `[` or `\`** (grep over `test/ docs/ examples/ src/`
  for `pattern: "…[` / `…\\` returned nothing). The bracket reinterpretation breaks
  no existing test or example.
- **`Rule` has no external importer.** `recovery.ts`'s `RecoveryRule` is an unrelated
  local interface. The only consumers of `bash-policy`'s `Rule` are `evaluate`, the
  guard, and tests — all in-file or in `test/bash-policy.test.ts`.
- **Current behavior pins** (from `src/extensions/bash-policy.ts`):
  - `toRegExp` (≈472): `pattern.replace(/[.*+?^${}()|[\]\\]/g, c => c === "*" ? ".*" : "\\"+c)`,
    full-anchored. `[`, `]`, `|`, `\` are currently escaped to literals.
  - `evaluateAny` (≈482–497): returns `{ action, matched }`; fallthrough returns
    `{ action: fallthrough, matched: commands[0] ?? "" }`; the winning rule object is
    `rules[i]!`.
  - Guard reason text (≈534–542): `family = extractCommand(matched)`;
    `why = \`${family || command} (policy ${action})\``; deny →
    `bash-policy: blocked ${why}`; ask prompt → `bash-policy: allow ${family || command}?`;
    ask-denied → `bash-policy: denied ${why}`.
  - Status print (≈567): `rules.map(r => \`${r.pattern} -> ${r.action}\`).join("; ")`.

## 3. Phase 1 — justification field + pattern alternation + escape

**Entry condition:** L1 design passed and committed (done). Working tree clean on the
feature branch.

**Design references:** `docs/design/2026-06-21-bash-policy-rule-ergonomics.md` §2
(Deliverables), §4 Decisions 1–3, §7 criteria 1–12.

**Test command (whole file):** `npx tsx --test test/bash-policy.test.ts`
**Full suite:** `npm test`  **Typecheck:** `npm run typecheck`

> Runner note: the canonical gate is `npm test` (which runs
> `node --import tsx --test "test/**/*.test.ts"`). The per-task
> `npx tsx --test --test-name-pattern=… test/bash-policy.test.ts` form below is an
> equivalent single-file convenience for fast iteration (both run this repo's tests
> identically); Phase exit still requires green `npm test`.

### Task list (TDD order — tests first, each test written and confirmed red before its impl task)

All new tests go in `test/bash-policy.test.ts`. The only import addition the test
file needs is `toRegExp` (currently **not** exported — T-impl-B must add `export`);
`evaluateAny`, `Rule`, and the harness imports the file already has are sufficient
for the rest (no `Action` import is needed — the action literals are compared as
string values). Per-task acceptance command uses node:test's `--test-name-pattern`
selector.

---

**T-test-1 — `toRegExp` alternation + escape + degenerate forms (criteria 7, 8, 9, 12).**
Protects the *pattern-matching contract*: bracket groups mean alternation, the escape
yields literals, and malformed patterns are fail-safe literals (never throw, never
match wide). Write `assert`-based cases, each on the compiled `RegExp`:
- *Alternation (crit 7):* `toRegExp("git [add|commit] *")` → `.test("git add x")` and
  `.test("git commit x")` true; `.test("git push x")` and `.test("git addcommit x")` false.
- *`*` and metachar escaping inside a group (crit 8):* `toRegExp("[a*|b.c]")` →
  `.test("axxx")` true, `.test("b.c")` true, `.test("bxc")` false (the `.` is literal).
- *`|` outside a group is literal; unterminated `[` is literal (crit 9):*
  `toRegExp("a|b")` → `.test("a|b")` true, `.test("a")` false;
  `toRegExp("a[b")` → `.test("a[b")` true. Both compile without throwing
  (wrap construction in a no-throw assertion).
- *Escape yields literals; `\;` preserved (crit 12):* `toRegExp("\\[a\\|b\\]")` →
  `.test("[a|b]")` true, `.test("a")` and `.test("b")` false (brackets/pipe literal,
  not a group); `toRegExp("find * \\;")` → `.test("find x \\;")` true.
- *Empty / edge group:* `toRegExp("[a|]")` → `.test("a")` true and `.test("")`... note
  the whole pattern is `^(?:a|)$`, so `.test("a")` true and `.test("")` true (empty
  alternative) — assert `.test("a")` true and `.test("b")` false (pin the alternation
  bound, not the empty match).
- *Backward-compat (no regression):* `toRegExp("rm *")` → `.test("rm -rf x")` true,
  `.test("git rm x")` false (existing wildcard semantics unchanged).
- **Acceptance:** `npx tsx --test --test-name-pattern='toRegExp' test/bash-policy.test.ts`
  exits 0.

**T-test-2 — `evaluateAny` returns the matched rule (criterion 6).**
Protects Decision 1's resolver contract: the caller can recover *which* rule won (to
read its justification) and the fallthrough path is unchanged.
- For `rules = [{pattern:"rm *", action:"deny", justification:"j"}]`,
  `evaluateAny(["rm -rf x"], rules, "allow")` → `action === "deny"`,
  `matched === "rm -rf x"`, and `rule === rules[0]` (**same object reference**, `===`).
- Fallthrough: `evaluateAny(["ls"], [], "allow")` → `action === "allow"`,
  `matched === "ls"` (i.e. `commands[0]`), `rule === undefined`.
- **Acceptance:** `npx tsx --test --test-name-pattern='evaluateAny returns' test/bash-policy.test.ts`
  exits 0.

**T-test-3 — justification surfaced through the guard (criteria 3, 4, 5, 10).**
Protects the user/model-facing surfacing at all three sites and the byte-identical
absent case, through the real agent loop (reuse `makeHarness` + the `sawBlock` /
reason-scraping pattern at `test/bash-policy.test.ts:189–194`; add a helper that
returns the matching `tool_result` reason string, and capture the `ui.confirm`
argument).
- *Deny justification reaches the model (crit 3):* deny rule
  `{pattern:"rm *", action:"deny", justification:"destructive"}` on `rm -rf x` → the
  blocked tool result reason contains `destructive` AND contains `bash-policy: blocked`
  AND contains `(policy deny)`.
- *Ask justification on prompt + denied reason (crit 4):* ask rule with
  `justification:"why-ask"`, `ui.confirm` capturing its argument and returning `false`
  → the captured prompt matches `/\(why-ask\)\?$/` (parenthetical before the `?`); the
  resulting block reason contains `why-ask`.
- *Absent justification byte-identical (crit 5):* deny rule `{pattern:"rm *",
  action:"deny"}` (no justification) on `rm -rf x` → the reason **equals**
  `"bash-policy: blocked rm (policy deny)"` exactly (`assert.equal`, not substring).
- *Alternation blocks through the guard (crit 10):* deny rule `git [add|commit] *` →
  `git commit -m x` gives `sawBlock` true and does not run; a separate run of
  `git push x` gives `sawBlock` false and runs.
- **Acceptance:** `npx tsx --test --test-name-pattern='justification|alternation blocks' test/bash-policy.test.ts`
  exits 0.

**T-test-4 — `/bash-policy` status prints the justification (criterion 11).**
Protects the status-output reversal (design §3). Drive the `bash-policy` command's
`status` branch (invoke the registered command with empty/`status` args, capturing
`c.print` output).
- With rules `[{pattern:"rm *", action:"deny", justification:"destructive"},
  {pattern:"ls *", action:"allow"}]` loaded, the status output contains `destructive`
  and contains `rm * -> deny`; the `ls *` line is `ls * -> allow` (unchanged, no
  trailing parenthetical).
- **Acceptance:** `npx tsx --test --test-name-pattern='status prints' test/bash-policy.test.ts`
  exits 0.

---

**T-impl-A — add `justification?: string` to `Rule`.**
In `src/extensions/bash-policy.ts`, extend the `Rule` interface with an optional
`justification?: string`. No other change. (Makes T-test-2/3/4 type-check.)

**T-impl-B — rewrite `toRegExp` with alternation + escape (Decision 2; Deliverables;
design §3 "no regex beyond the one group form").**
Replace the single `.replace(...)` with an escape-aware left-to-right compiler that
produces an anchored `^…$` source, then export the function (`export function toRegExp`).
Rules (from design Deliverables + Decision 2, pinned so the implementer does not guess):
- Scan the pattern char by char, building regex source:
  - `\` + one of `[`, `]`, `|`, `\` → emit that char regex-escaped (literal); consume 2.
  - `\` + any other char (or end of string) → emit a literal backslash (`\\`); consume 1
    (the next char is processed in its own iteration — preserves `\;`).
  - `*` → emit `.*`. (`*` has **no** literal form.)
  - `[` → scan forward for the first **unescaped** `]`. If none, treat the `[` as a
    literal (`\[`) and continue (unterminated → fail-safe). Otherwise split the interior
    on **unescaped** `|` into alternatives; compile each alternative with the **same**
    rules **minus** the `[`-group rule (a `[` inside a group is a literal char — groups
    are flat); emit `(?:` + alternatives joined by `|` + `)`; consume through the `]`.
  - any other char → emit it regex-escaped (literal), reusing the existing escape set
    so `.`, `+`, `?`, `^`, `$`, `{`, `}`, `(`, `)` stay literal exactly as today.
- Keep the helper that regex-escapes a single literal char (the existing
  `[.*+?^${}()|[\]\\]`-style escaping for non-metacharacters), so behavior for
  non-bracket patterns is identical to today (T-test-1 backward-compat case).
- The compiler must **never** throw on any input string (T-test-1 no-throw cases).
- **Trace:** every branch maps to a Deliverable bullet; do not add character classes,
  ranges, quantifiers, anchors, or nested groups (design §3 forbids them).

**T-impl-C — extend `evaluateAny` return with `rule?: Rule` (Decision 1).**
Change the return type to `{ action: Action; matched: string; rule?: Rule }`. On a
rule match, include `rule: rules[i]` (the actual object). On fallthrough, return
`{ action: fallthrough, matched: commands[0] ?? "", rule: undefined }` (or omit `rule`;
`undefined` either way). `evaluate` (returns `.action` only) is unchanged.

**T-impl-D — guard surfaces justification at the three sites (Decision 3).**
In the `beforeToolCall` handler, read the winning rule from the extended
`evaluateAny` return. Build a justification suffix once:
`const j = rule?.justification?.trim(); const suffix = j ? \`: ${j}\` : "";` (or
equivalent). Apply site-appropriately:
- deny: `reason: \`bash-policy: blocked ${why}${suffix}\``.
- ask-denied: `reason: \`bash-policy: denied ${why}${suffix}\``.
- ask prompt: insert the justification **before** the `?` as a parenthetical —
  `\`bash-policy: allow ${family || command}${j ? \` (${j})\` : ""}?\``.
When `justification` is absent/empty, every string is byte-identical to today
(T-test-3 crit-5 `assert.equal`). Do **not** change `family`, the `approved`
remember-key, `action`, or `matched`.

**T-impl-E — status print appends justification (Deliverables; criterion 11).**
In the `status`/default branch of the `bash-policy` command, change the rule map to
append ` (${r.justification})` when `r.justification` is present and non-empty:
`rules.map(r => \`${r.pattern} -> ${r.action}${r.justification ? \` (${r.justification})\` : ""}\`)`.
Pattern still prints verbatim.

**Exit condition:** all of T-test-1…4 green; `npm run typecheck` exit 0; `npm test`
exit 0; the four new exports/changes (`Rule.justification`, exported `toRegExp` with
alternation+escape, `evaluateAny.rule`, guard suffixing, status suffix) in place; no
pre-existing test modified except additive imports.

## 4. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM `.js` import specifiers
  even for `.ts`; strict TS (`noUncheckedIndexedAccess` etc., so guard array/string
  indexing); zero new deps; comments explain code not workflow (no `// Decision N` /
  `// round R` narration); tests offline via `node:test` + `tsx` + `MockProvider`.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phase1):` opener,
  `fix(phase1-roundR): <keyword>` for within-round fixes; `Test-Cmd` / `Accept-Cmd`
  trailers; no AI/model/tooling mention.

## 5. Data and Fixture Dependencies

No new fixtures. Reuse `makeHarness` (`test/helpers.ts`), `MockProvider` responder
scripting, and the `sawBlock` reason-scraper (`test/bash-policy.test.ts:189–194`). For
T-test-3's prompt assertion, capture the `ui.confirm` argument via a stubbed
`confirm` (the existing tests already pass `ui: { confirm: async () => …, notify: … }`).
For T-test-4, invoke the registered `bash-policy` command capturing `c.print`.

## 6. Regression Protection

`npm test` (full suite, currently 367 passing) must stay green at Phase end — in
particular every existing `bash-policy.test.ts` case:
- the no-op default, deny/ask/allow, path-qualified, wrapper-unwrapping, compound /
  piped / `find -exec`, and ask-remember tests must pass unchanged (the new
  `evaluateAny` field is additive; the absent-justification reason path is
  byte-identical; `toRegExp` non-bracket behavior is identical — pinned by T-test-1's
  backward-compat case and T-test-3's crit-5 `assert.equal`).
- `npm run typecheck` exit 0 (the optional `Rule.justification` and the additive
  `evaluateAny` return field must not break `evaluate` or any caller).

## Closure

Status: closed
Closing-commit: 387ddc8
Closed-on: 2026-06-22
Deferred: none

Phase 1 closed in a single L3 round (clean first review, no fix). `npm run
typecheck` exit 0; `npm test` exit 0 (374 passed); `npx tsx --test
test/bash-policy.test.ts` exit 0 (45 passed). No L2 rollback (no Deprecated
section). Regression protection held — the prior bash-policy tests (no-op default,
deny/ask/allow, path-qualified, wrapper-unwrapping, compound/piped/`find -exec`,
ask-remember) stayed green and unmodified; every non-bracket, non-backslash pattern
compiles byte-identically to the old `toRegExp`, and the absent-justification reason
strings are byte-identical (pinned by the crit-5 `assert.equal`).
