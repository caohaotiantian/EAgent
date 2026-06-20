# Implementation: `bash-policy` extension

Slug: `2026-06-20-bash-policy`
Design doc: `docs/design/2026-06-20-bash-policy.md`

## 1. Task Index

| Design Deliverable (docs/design/2026-06-20-bash-policy.md §2) | Design Acceptance Criterion (§7) | Phase |
| --- | --- | --- |
| `src/extensions/bash-policy.ts` (arity extraction, ruleset eval, guard, command, kill switch) | 1, 4, 5, 6, 7, 8, 9 | P1 |
| Exported pure `extractCommand` + `evaluate` | 2, 3 | P1 |
| `test/bash-policy.test.ts` | 2–9 | P1 |
| Register in `BUILTIN_EXTENSIONS` (`src/host.ts`) | (load-without-error, covered by existing `host.test.ts`) | P1 |
| `CLAUDE.md` inventory line | (doc only) | P1 |

Design Key Design Decisions referenced throughout: D1 (`§4` lines ~89–107),
D2 (~109–126), D3 (~128–151), D4 (~153–179), D5 (~181–205), D6 (~207–221).

## 2. Phase Breakdown

This is a single coherent, independently-committable feature (one new extension
file, one new test file, two small wiring edits) that leaves `npm test` green at
the end. Per the L2 granularity rule ("most small features are a single Phase"),
it is **one Phase** with tasks in strict TDD order (every test task precedes the
implementation it pins).

### Phase 1 — `bash-policy` extension

**Entry condition:** baseline green — `npm test` reports 242/242 pass and
`npm run typecheck` exits 0 on a clean working tree (verified at L2 authoring).

**Design references:** `docs/design/2026-06-20-bash-policy.md` §2 (Deliverables),
§4 D1–D6, §7 (Acceptance Criteria 1–9), §8 (Risks R1–R3).

**Task list (TDD order — test tasks first):**

- **T1 (test): unit tests for `extractCommand`.** In `test/bash-policy.test.ts`,
  assert the arity-extraction invariant — *a full command line is reduced to its
  human-meaningful command family*, with leading `VAR=value` assignments and
  `-flag` tokens excluded before the arity lookup (design D3). Exact cases
  (design criterion 2):
  - `extractCommand('git commit -m "wip"')` === `"git commit"`
  - `extractCommand("npm run dev --silent")` === `"npm run dev"`
  - `extractCommand("git checkout -b feature")` === `"git checkout"`
  - `extractCommand("python script.py")` === `"python script.py"` (`python` has
    arity 2 in the table (`python: 2`); the first 2 tokens of this 2-token input
    are the whole line — the implementer keeps the verbatim entry, not assumes
    absence)
  - `extractCommand("frobnicate a b")` === `"frobnicate"` (a command with **no**
    arity entry falls back to the first token — exercises the
    `tokens.slice(0, 1)` default branch that the `python` case does not)
  - `extractCommand("FOO=bar rm -rf build")` === `"rm"` (assignment + flags
    stripped, `rm` arity 1)
  - `extractCommand("   ")` === `""` (empty/whitespace → empty string; guards the
    fail-open path in D2/R2)

- **T2 (test): unit tests for `evaluate`.** Assert the last-match-wins precedence
  invariant (design D4): *the action is that of the last rule whose wildcard
  pattern matches the full command line, else the fallthrough*. With
  `rules = [{pattern:"*",action:"ask"},{pattern:"git *",action:"allow"},{pattern:"git push *",action:"deny"}]`
  (design criterion 3):
  - `evaluate("git status", rules, "allow")` === `"allow"` (last match `git *`)
  - `evaluate("git push origin main", rules, "allow")` === `"deny"` (last match
    `git push *`)
  - `evaluate("curl http://x", rules, "allow")` === `"ask"` (only `*` matches)
  - `evaluate("git status", [], "allow")` === `"allow"` (no rules → fallthrough)
  - Wildcard literalness: `evaluate("rm -rf a.b", [{pattern:"rm *.b",action:"deny"}], "allow")`
    === `"deny"` and `evaluate("rm -rf axb", [{pattern:"rm *.b",action:"deny"}], "allow")`
    === `"allow"` — proving the `.` in the pattern is matched literally (regex
    metacharacters escaped, only `*` is special; design D4).

- **T3 (impl): write `extractCommand` and `evaluate` in `src/extensions/bash-policy.ts`.**
  Port the ~140-entry arity table from opencode
  (`packages/opencode/src/permission/arity.ts`) **verbatim** (including
  `python: 2`, `git: 2`, `npm run: 3`, etc.) as an EAgent-authored `const` with a
  one-line source-attribution comment (design D3; opencode is MIT).
  Implement the longest-prefix lookup, the flag/assignment-filtering tokenizer,
  and the wildcard matcher (`*`→`.*`, every other regex metachar escaped,
  case-sensitive, matched against the raw full command line). Run T1+T2 green.

- **T4 (test): live guard tests through the agent loop.** In the same test file,
  using `makeHarness` (`test/helpers.ts`) + a scripted `MockProvider` responder,
  with **only `bash-policy` loaded** via `h.host.use("bash-policy", …)` (design
  §7 preamble — no `flow-guard`, so any `ui.confirm` is unambiguously
  bash-policy's). Each test registers a `shell:exec` tool whose `execute` flips a
  `ran` flag so blocking is observable offline:
  - **No-op default** (criterion 4): no rules configured → a scripted `bash`
    call runs (`ran === true`), and no tool-result message matches
    `/bash-policy: /`.
  - **Deny blocks** (criterion 5): rule `{pattern:"rm *",action:"deny"}`, scripted
    `bash {command:"rm -rf build"}` → `ran === false` and the tool-result the
    model sees matches `/bash-policy: /`.
  - **Ask → no blocks** (criterion 6): rule `{pattern:"curl *",action:"ask"}`,
    `ui.confirm` returns `false` → `ran === false`, result matches `/bash-policy: /`.
  - **Ask → yes passes** (criterion 6): same rule, `ui.confirm` returns `true` →
    `ran === true`, no `/bash-policy: /` block.
  - **Ask remembers within session, clears on session_start** (criterion 7):
    rule `{pattern:"curl *",action:"ask"}`, `confirm` returns `true`, count
    invocations; two `curl` calls in one session → `confirm` called exactly once;
    after emitting a `session_start` event (drive it directly with
    `h.agent.hooks.emit("session_start", {})`, the same channel
    `extension.ts` uses), a third `curl` call → `confirm` called again
    (total 2). Protects the prefix-keyed session-remember invariant (design D5).
  - **Capability fidelity** (criterion 8): a `shell:exec` tool **named `sh`**
    (not `bash`) with rule `{pattern:"rm *",action:"deny"}` and a `bash`-style
    `command` arg → blocked. Proves D2 matches on the declared capability, not
    the tool name.
  - **Kill switch** (criterion 9): set `process.env.EAGENT_BASH_POLICY = "off"`
    (restore in a `finally`/`after`), a `deny`-matching command → `ran === true`
    (not blocked by bash-policy).

- **T5 (impl): write the extension body in `src/extensions/bash-policy.ts`.**
  `export default function activate(e)` mirroring `flow-guard.ts`: read config
  from `e.store` (`rules`, `fallthrough` default `"allow"`, `commandArgKey`
  default `"command"`) + `EAGENT_BASH_POLICY=off`; a `beforeToolCall` filter that
  (1) passes through unless the called tool declares `shell:exec`
  (`e.agent.tools.get(ctx.call.name)?.capabilities`), (2) reads the command
  string from the arg key (non-string/absent → pass through, design D2/R2),
  (3) `evaluate`s it, (4) on `deny` returns
  `{...decision, block:true, reason:"bash-policy: ..."}`, on `ask` consults
  `e.agent.ui.confirm` with the extracted prefix and remembers an affirmative in
  a session-scoped `Set` keyed by the prefix, on `allow`/remembered passes. A
  `session_start`/`session_shutdown` handler clears the remember set. A
  `/bash-policy` command (`on|off|status` minimum) and clean teardown returning a
  disposer. Run T4 green.

- **T6 (impl): wire into the host.** Add the import and a
  `["bash-policy", bashPolicy]` entry to `BUILTIN_EXTENSIONS` in `src/host.ts`,
  beside `flow-guard`/`integrity` (design D6). Add a one-line `bash-policy`
  entry to the extension inventory bullet in `CLAUDE.md`. Run the full suite.

**Per-task acceptance commands** (runnable from repo root):

- T1+T2+T3: `node --import tsx --test test/bash-policy.test.ts` — arity +
  evaluate unit tests pass.
- T4+T5: `node --import tsx --test test/bash-policy.test.ts` — all live-guard
  subtests pass (0 fail).
- T6: `node --import tsx --test test/host.test.ts` — host still loads the builtin
  set with `bash-policy` added (0 fail).
- Phase exit (all tasks): `npm run typecheck` exits 0 **and** `npm test` (the
  literal package script `node --import tsx --test "test/**/*.test.ts"`) reports
  `# fail 0` with the suite total increased by the new file's subtests.

**Exit condition:** `npm run typecheck` exits 0; `npm test` reports `# fail 0`
(≥ 242 prior tests still green plus the new `bash-policy` subtests); design
acceptance criteria 1–9 each map to a passing assertion in
`test/bash-policy.test.ts`.

## 3. Engineering Constraints Index

- **Project engineering norms** — `CLAUDE.md` "House conventions": ESM +
  NodeNext (`.js` import specifiers even for `.ts`), strict TypeScript
  (`noUncheckedIndexedAccess` etc., no `any`), zero runtime deps except `jiti`
  (the arity table is vendored data, not a package — allowed), every extension
  capability-gated with an offline test. Mirror `src/extensions/flow-guard.ts`
  for structure (config via `e.store`, env kill switch, slash command, disposer).
- **Four-corner subagent template** — `references/loop-3-development.md`.
- **Commit conventions** — SKILL.md "Commit conventions": `feat(phase1): …`
  opener, `fix(phase1-roundR): <keyword>` for within-round fixes; `npm test` /
  acceptance results as trailers; no mention of AI/model/tooling.

## 4. Data and Fixture Dependencies

- **Reused:** `test/helpers.ts` `makeHarness` (+ `autoUI`, `lastText`),
  `MockProvider` responder scripting, `defineTool` from `src/kernel/define.js`,
  and the `tool_result` message inspection pattern from `test/flow-guard.test.ts`
  (lines ~50–53). No new fixtures, no network, no `ANTHROPIC_API_KEY`.
- **New:** only `test/bash-policy.test.ts`. The arity table is a source constant
  in `src/extensions/bash-policy.ts`, not a fixture.

## 5. Regression Protection

- The full `npm test` suite (242 prior tests) must remain `# fail 0` — in
  particular `test/host.test.ts` (the builtin set now includes `bash-policy`),
  `test/flow-guard.test.ts` (the other `beforeToolCall` consumer must still pass
  — both extensions compose, neither is modified), and `test/core-tools.test.ts`
  (the `bash` tool is unchanged). `npm run typecheck` must stay clean.
- No existing source file is modified except the two additive wiring edits in
  `src/host.ts` (import + one array entry) and the one-line `CLAUDE.md` inventory
  addition; no behavior of any existing extension changes (bash-policy ships a
  no-op default, design D6).
