# Implementation — bash-policy compound-command expansion

Design: `docs/design/2026-06-21-bash-policy-compound-commands.md`. Slug matches.

## 1. Task Index

| Deliverable (design §2) | Acceptance (design §7) |
|---|---|
| `segments` | criterion 3 |
| `findExecCommands` | criterion 4 |
| `xargs` in `WRAPPERS` | criterion 5 |
| `expandCommands` | criterion 6 |
| guard rewired to `evaluateAny(expandCommands(...))` | criteria 7, 8, 9, 10 |
| offline tests | criteria 3–10 |
| typecheck/test green | criteria 1, 2 |

`<TEST-CMD>` = `npm test`. `<TYPECHECK>` = `npm run typecheck`.
File touched: `src/extensions/bash-policy.ts`, `test/bash-policy.test.ts`.

## 2. Phase Breakdown — single Phase (Phase 1)

One Phase: cohesive (all helpers + guard rewiring + tests in the two files),
independently committable, leaves `npm test` green. The helpers are unused until
the guard wires them, and the guard cannot compile without them, so splitting
would leave a mid-Phase red state — not allowed.

**Entry condition:** L1 design passed. Working tree clean except this task's docs.

**Design references:** Deliverables §2; Decisions §4 (1–5, esp. Decision 2's pinned
backslash/quote rule and group-depth tracking); Acceptance §7 (criteria 1–10).

**Task list (TDD order — tests first):**

T1. *(test)* In `test/bash-policy.test.ts`, import `segments` and add a unit test
   asserting design criterion 3 exactly, including: spaced and **no-space**
   operators (`git status&&rm -rf build` → `["git status","rm -rf build"]`,
   `a|rm x` → `["a","rm x"]`); `||`/`;`/`|` splits; quoted/escaped operators NOT
   split (`git commit -m "a; b"`, `echo "a | b"`, `find . -exec rm {} \;`); the
   escaped-quote case `echo "a\"b" && ls` → `['echo "a\\"b"', "ls"]`; substitution
   interior not split (`echo $(a && b)`); lone `&` not split (`sleep 1 &`).
   Invariant: a command runs each segment; the splitter must find every
   operator-delimited command an attacker can form (spacing-independent) WITHOUT
   tearing a quoted/escaped/substituted operator (which would false-block).

T2. *(test)* Import `findExecCommands`; assert criterion 4: single `\;` clause →
   `["rm -f {}"]`; two clauses (`-exec … {} + -exec … \;`) →
   `["chmod 644 {}","chown me {}"]`; a non-`find` segment → `[]`. Add a whole-token
   guard case: `findExecCommands("find . -exec g++ -O2 {} +")` → `["g++ -O2 {}"]`
   (the `g++` operand is not the `+` terminator). Invariant: the command find
   actually executes (between the `-exec`-family primary and its `;`/`+`
   terminator, terminator excluded, `{}` kept) is exposed for evaluation.

T3. *(test)* Add a NEW `unwrap` test (do not modify the existing one — keep the
   regression rule unambiguous) for xargs per criterion 5: `xargs rm -rf` →
   `"rm -rf"`; attached `xargs -n1 rm` → `"rm"`; separated
   `xargs -n 1 rm` → `"rm"`; attached replstr `xargs -I{} rm {}` → `"rm {}"`;
   separated replstr `xargs -I {} rm {}` → `"rm {}"`. Invariant: the program xargs
   runs is exposed regardless of its option spelling.

T4. *(test)* Import `expandCommands`; assert criterion 6: parity
   `expandCommands("sudo rm -rf build")` deep-equals `["sudo rm -rf build","rm -rf
   build"]`; `expandCommands("cat x | xargs rm -rf")` includes `"rm -rf"`;
   `expandCommands("find . -exec rm {} \;")` includes `"rm {}"`. Also pin
   inner-last ordering at the unit level for a compound case:
   `expandCommands("git status && rm -rf build").indexOf("rm -rf build") > 0` (the
   sub-command appears strictly after the whole line, so `evaluateAny`'s last-match
   labeling names `rm`). Invariant: the candidate set is the whole line plus every
   effective sub-command, first-wins deduped, inner candidates last (so the prior
   task's labeling/parity hold).

T5. *(test)* Add agent-loop integration tests (reuse `shellTool`/`sawBlock`/
   `makeHarness`):
   - criterion 7: rule `[{rm *: deny}]` blocks each of `git status && rm -rf
     build`, `cat list | xargs rm -rf`, `find . -name '*.log' -exec rm -f {} \;`,
     `: ; rm -rf build` (`didRun()===false`, `sawBlock===true`).
   - criterion 8 (no false block on a quoted operator): rule `[{rm *: deny}]`,
     command `git commit -m "fixup; rm temp"` runs (`didRun()===true`,
     `sawBlock===false`).
   - criterion 9 (no regression): `sudo rm -rf build` and `nice -n 10 rm -rf build`
     still block under `[{rm *: deny}]`; the override `[{rm *: deny},{sudo rm *:
     allow}]` runs `sudo rm -rf build`; empty ruleset runs `git status && rm -rf
     build`.
   - criterion 10 (ask remember keyed to sub-command): rule `[{rm *: ask}]`,
     call-counting `confirm` via `makeHarness({ ui: { confirm, notify } })`,
     responder issuing `a && rm -rf x` then `rm -rf y`; assert `confirms===1`.
   Invariants: compound/embedded/piped commands are gated through the real guard
   (7); quoted operators do not false-block (8); all prior guarantees hold (9);
   approval is scoped to the offending sub-command family (10).

T6. *(impl)* Add `xargs` to the `WRAPPERS` table: `argFlags` =
   `-n --max-args -P --max-procs -I --replace -d --delimiter -a --arg-file -E -L
   --max-lines -s --max-chars` (separated-value flags; attached forms resolve via
   the existing boolean-flag fallthrough — do NOT special-case them), `positionals:
   0`, `assignments: false`.

T7. *(impl)* Implement `export function segments(commandLine: string): string[]`
   per design Decision 2 Option C: a single character-scan tracking single-quote,
   double-quote, backtick state, `$(`/`(` paren depth, and backslash escapes (the
   pinned rule: backslash escapes the next char when unquoted or in double quotes,
   literal inside single quotes). Split on `|` (and `||`), `&&`, `;`, and newline
   only at quote/group depth 0 and unescaped; a lone `&` does not split. Trim
   segments and drop empties.

T8. *(impl)* Implement `export function findExecCommands(segment: string):
   string[]`: if `normalizeProgram(segment)`'s program basename is not `find`,
   return `[]`. Otherwise tokenize (offset-aware, like `unwrap`), scan for
   whole-token `-exec`/`-execdir`/`-ok`/`-okdir`; for each, take tokens after it up
   to (excluding) the next whole-token terminator (`;`, `\;`, `+`, `';'`, `";"` —
   recognized wherever the token appears; `{} +` positional adjacency is NOT
   required), or to end if none; slice the original for verbatim spacing; push
   non-empty;
   continue past the terminator.

T9. *(impl)* Implement `export function expandCommands(commandLine: string):
   string[]`: start an ordered, first-wins-deduped list; `add(line)` =
   `normalizeProgram` it, push if non-empty/new, and push its `unwrap` inner
   (normalized) if non-null. Call `add(commandLine)` first (whole line), then for
   each `segments(commandLine)` segment call `add(segment)` and `add(inner)` for
   each `findExecCommands(segment)`.

T10. *(impl)* Rewire the `beforeToolCall` guard: replace the inline
   `outer = normalizeProgram(command)` / `unwrap` / `[outer, inner]` construction
   with `const candidates = expandCommands(command); const { action, matched } =
   evaluateAny(candidates, rules, fallthrough);` then derive
   `family = extractCommand(matched)` exactly as today. Keep the capability check,
   `commandArgKey` lookup, kill switch, `allow` fast-path, and `approved`
   remember-set logic unchanged.

**Per-task acceptance commands (runnable from repo root):**
- After impl tasks: `npm run typecheck`
- Full Phase: `npx tsx --test test/bash-policy.test.ts` then `npm test`. Both exit 0.

**Exit condition:** `npm run typecheck` and `npm test` exit 0; tests for criteria
3–10 present and passing; no pre-existing test modified except adding the new
imports.

## 3. Engineering Constraints Index

- CLAUDE.md _house conventions_: ESM `.js` import specifiers; strict TS
  (`noUncheckedIndexedAccess` — guard every array/string index); zero runtime deps;
  comments explain code, not the workflow (no `// Decision N`, no `// Phase 1`);
  offline `node:test`+`tsx`.
- Four-corner subagent template: `references/loop-3-development.md`.
- Commit conventions: `feat(phase1):` opener; `fix(phase1-roundR): <keyword>` for
  within-round fixes; `npm test` / `npm run typecheck` trailers; no AI/model/tooling
  mention.

## 4. Data and Fixture Dependencies

No new fixtures. Reuse `test/bash-policy.test.ts` helpers (`shellTool`,
`sawBlock`, `makeHarness`) and existing imports (`extractCommand`, `evaluate`,
`evaluateAny`, `normalizeProgram`, `unwrap`).

## 5. Regression Protection

The full existing `test/bash-policy.test.ts` suite must stay green — including the
argv[0] normalization tests, the wrapper-unwrapping tests (the `[outer, inner]`
behavior `expandCommands` must reproduce), and the original family/evaluate/ask
tests. `npm test` (all 356+ tests) must stay green. Criterion-9 integration tests
explicitly re-assert the prior wrapper/override/empty-ruleset behavior through the
rewired guard.

## Closure

Status: open.
