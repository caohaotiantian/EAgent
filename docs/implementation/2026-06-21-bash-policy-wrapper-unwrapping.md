# Implementation — bash-policy wrapper unwrapping

Design: `docs/design/2026-06-21-bash-policy-wrapper-unwrapping.md`. Slug matches.

## 1. Task Index

| Deliverable (design §2) | Acceptance (design §7) |
|---|---|
| `unwrap` helper + `WRAPPERS` table | criteria 3, 5 |
| `evaluateAny` + `evaluate` reimplemented on it | criteria 4 |
| guard wiring (candidate list, label/remember via `matched`) | criteria 5, 6, 7, 8, 9 |
| offline tests | criteria 3–9 |
| typecheck/test green | criteria 1, 2 |

`<TEST-CMD>` = `npm test`. `<TYPECHECK>` = `npm run typecheck`.

## 2. Phase Breakdown — single Phase (Phase 1)

One Phase: the work is one contiguous block (helpers + guard wiring + tests in
`src/extensions/bash-policy.ts` and `test/bash-policy.test.ts`), independently
committable, and leaves `npm test` green. No mid-Phase red state. Splitting would
violate "smallest independently-committable set that leaves TEST green" (the
helpers are unused until the guard wires them; the guard cannot compile without
them).

**Entry condition:** L1 design passed (it has). Working tree clean except this
task's docs.

**Design references:** Deliverables `docs/design/2026-06-21-bash-policy-wrapper-unwrapping.md`
§2; Decisions §4 (1–5); Acceptance §7 (criteria 1–9).

**Task list (TDD order — test tasks first):**

T1. *(test)* In `test/bash-policy.test.ts`, add a unit test block for `unwrap`
   (import it from the extension) asserting design criterion 3 exactly:
   `unwrap("sudo rm -rf build") === "rm -rf build"`,
   `unwrap("env FOO=bar rm -rf build") === "rm -rf build"`,
   `unwrap("nice -n 10 rm x") === "rm x"`, `unwrap("timeout 5 rm x") === "rm x"`,
   `unwrap("sudo -u root rm x") === "rm x"`,
   `normalizeProgram(unwrap("sudo env /bin/rm x")!) === "rm x"` (stacked + path
   inner), `unwrap("/usr/bin/sudo rm x") === "rm x"`,
   and `unwrap` returns `null` for `"rm -rf build"`, `"git commit"`, `"sudo"`, `""`.
   Invariant protected: a recognized wrapper's own option/argument prefix is
   consumed so the *real* inner command is exposed, and a non-wrapper or
   program-less line yields `null` (best-effort, design Decision 4).

T2. *(test)* Add a unit test for `evaluateAny` asserting design criterion 4:
   `evaluateAny(["sudo rm -rf build","rm -rf build"], [{pattern:"rm *",action:"deny"}], "allow")`
   → `action==="deny"` and `matched==="rm -rf build"`;
   `evaluateAny(["sudo rm -rf build","rm -rf build"], [{pattern:"rm *",action:"deny"},{pattern:"sudo rm *",action:"allow"}], "allow")`
   → `action==="allow"` (later rule, matching the outer line, wins).
   Invariant protected: union-at-matching under preserved last-match-wins — a later
   more-specific rule overrides an earlier inner match (design Decision 1 Option C;
   this is the case strictest-wins would wrongly block).

T3. *(test)* Add agent-loop integration tests (reuse the file's existing
   `shellTool`/`sawBlock`/`makeHarness` helpers, one rule unless noted):
   - criterion 5: with `[{pattern:"rm *",action:"deny"}]`, each of
     `sudo rm -rf build`, `env rm -rf build`, `nice -n 10 rm -rf build`,
     `timeout 5 rm -rf build`, `/usr/bin/sudo rm -rf build` is blocked
     (`didRun()===false` and `sawBlock===true`).
   - criterion 6: with `[{pattern:"sudo *",action:"deny"}]` and no `rm` rule,
     `sudo apt update` is blocked.
   - criterion 7: with `[{pattern:"rm *",action:"deny"},{pattern:"sudo rm *",action:"allow"}]`,
     `sudo rm -rf build` runs (`didRun()===true`, `sawBlock===false`).
   - criterion 8: empty ruleset, `sudo rm -rf build` runs.
   - criterion 9: with `[{pattern:"rm *",action:"ask"}]` and a call-counting
     `confirm` injected via `makeHarness({ ui: { confirm, notify } })` (same
     pattern as the existing ask tests) returning true, responder issuing
     `sudo rm -rf a` then `rm -rf b`, assert `confirms===1` (approval keyed to the
     inner family `rm` covers the later bare `rm`).
   Invariants protected: wrapper transparency makes inner-program rules fire
   (5), wrapper-level rules do not regress (6), author override authority is
   preserved / no false block (7), no false positive at rest (8), ask-remember key
   is scoped to the inner program (9).

T4. *(impl)* In `src/extensions/bash-policy.ts` add the `WRAPPERS` data table and
   `unwrap` per design Decisions 2, 3, 4: recognize the head program by basename;
   consume the wrapper prefix with one bounded loop using the table
   (`argFlags` consuming a following or attached value, leading `positionals`,
   `assignments`); recurse on the remainder (terminates because argv[0] is always
   removed); return the inner command line, or `null` when the head is not a
   recognized wrapper or no inner program remains. Preserve the inner line's
   verbatim spacing by slicing the original string at the inner program's offset
   (use `matchAll(/\S+/g)` token offsets), consistent with `normalizeProgram`.

T5. *(impl)* Add `evaluateAny(commands, rules, fallthrough)` per the pinned
   algorithm in design §2 Deliverable 3 (iterate rules last→first; first rule
   whose pattern matches some candidate wins; `matched` = last candidate in given
   order matched by that rule; no match → `{action:fallthrough, matched:commands[0]}`).
   Reimplement `evaluate(command, rules, fallthrough)` as
   `evaluateAny([command], rules, fallthrough).action` — keep its exported
   signature and behavior unchanged.

T6. *(impl)* Update the `beforeToolCall` guard: compute
   `outer = normalizeProgram(command)`; `innerRaw = unwrap(outer)`;
   `inner = innerRaw != null ? normalizeProgram(innerRaw) : null`;
   `candidates = inner != null ? [outer, inner] : [outer]`;
   `{ action, matched } = evaluateAny(candidates, rules, fallthrough)`. On a
   non-allow action, derive `family = extractCommand(matched)` and use it for the
   block/ask message and the `approved` remember key. Keep the capability check,
   the `commandArgKey` lookup, the kill switch, and the `allow` fast-path exactly
   as they are.

**Per-task acceptance commands (runnable from repo root):**
- After T4/T5/T6 (helpers + wiring): `npm run typecheck`
- Full Phase: `npx tsx --test test/bash-policy.test.ts` (the bash-policy suite)
  then `npm test` (whole offline suite). Both exit 0.

**Exit condition:** `npm run typecheck` and `npm test` exit 0; the new unit and
integration tests (criteria 3–9) are present and pass; no pre-existing test was
modified except adding the `unwrap`/`evaluateAny` imports.

## 3. Engineering Constraints Index

- CLAUDE.md _house conventions_: ESM `.js` import specifiers; strict TS
  (`noUncheckedIndexedAccess` — guard array indexing); zero runtime deps except
  `jiti`; capability gating unchanged (bash-policy already keys on `shell:exec`);
  offline tests via `node:test` + `tsx`.
- Four-corner subagent template: `references/loop-3-development.md`.
- Commit conventions: SKILL.md "Commit conventions" — `feat(phase1):` opener,
  `fix(phase1-roundR): <keyword>` for within-round fixes; `npm test` /
  `npm run typecheck` results as trailers; no AI/model/tooling mention.

## 4. Data and Fixture Dependencies

No new fixtures. Reuse the existing `test/bash-policy.test.ts` helpers
(`shellTool`, `sawBlock`, `makeHarness` from `./helpers.js`) and the
`extractCommand`/`evaluate`/`normalizeProgram` imports already present.

## 5. Regression Protection

The full existing `test/bash-policy.test.ts` suite (including the argv[0]
normalization tests from the prior task and the original family/evaluate/ask
tests) must stay green — `evaluate`'s reimplementation on `evaluateAny` must not
change any existing assertion. `npm test` (all 343+ tests) must stay green.

## Closure

Status: closed
Closing-commit: 24fa6b0
Closed-on: 2026-06-21
Deferred: none

Phase 1 closed: `npm run typecheck` exit 0; `npm test` exit 0 (356 passed);
`npx tsx --test test/bash-policy.test.ts` exit 0 (27 passed). No L2 rollback
occurred (no Deprecated section). Regression protection held — the pre-existing
bash-policy suite (argv[0] normalization + family/evaluate/ask tests) stayed green
and unmodified; `evaluate` reimplemented on `evaluateAny` is behavior-identical for
the single-line case.
