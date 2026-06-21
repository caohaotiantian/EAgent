# Implementation: `recovery` extension

Status: closed
Closing-commit: afccad3
Closed-on: 2026-06-21
Deferred: none

Slug: `2026-06-21-recovery-hooks`
Design: `docs/design/2026-06-21-recovery-hooks.md`

## 1. Task Index

| Design Deliverable (design §2) | Acceptance (design §7) | Phase |
| --- | --- | --- |
| `src/extensions/recovery.ts` (guard + ruleset + matcher + kill switch) | crit 1, 6, 7, 8, 9 | P1 |
| Exported `recoveryHint` + `RECOVERY_RULES` + `annotate` (guard transform) | crit 2, 3, 4, 5 | P1 |
| `test/recovery.test.ts` | all | P1 |
| Register in `BUILTIN_EXTENSIONS` (`src/host.ts`) | crit 1 | P1 |
| `CLAUDE.md` inventory entry | — (doc) | P1 |

Design §2 = `docs/design/2026-06-21-recovery-hooks.md` lines 19–35.
Design §7 (Acceptance Criteria) = lines 229–270.

## 2. Phase Breakdown

### Phase 1 — the `recovery` extension (single Phase)

This feature is one extension file, one test file, one host registration line,
and one CLAUDE.md line. It is the smallest independently-committable unit that
leaves `npm test` green and maps to the entire Deliverables block, so per the L2
granularity rule it is a single Phase (no split needed).

**Entry condition:** L1 design closed (it is). `npm test` and `npm run typecheck`
green on the current tree before any change.

**Design references:** Deliverables `docs/design/2026-06-21-recovery-hooks.md:19`–`35`;
Key Design Decisions D1–D5 `:55`–`165`; Acceptance Criteria `:229`–`270`.

**Task list, in TDD order:**

1. **(test)** Create `test/recovery.test.ts`. Import `recoveryHint`,
   `RECOVERY_RULES` from `../src/extensions/recovery.js` and the harness from
   `./helpers.js`. Write the pure-matcher tests **first** (they protect the
   business invariant that *each shipped rule fires on EAgent's real error
   string and benign output is left alone*):
   - **crit 2** — for each of the six representative trigger strings in design
     §7 crit 2 (`:235`–`245`), assert `recoveryHint(s)` is non-null and
     `assert.match(hint, /<keyword>/)` where `<keyword>` is the rule-distinctive
     word named there (`re-read`, `replaceAll` ×2 branches, `exact`, `schema`,
     `workspace`, `tool name`). Invariant: a regression that drops or breaks any
     rule's regex or hint keyword fails here.
   - **crit 3** — `assert.equal(recoveryHint("Wrote 12 bytes to /tmp/x.ts"), null)`.
     Invariant: benign (non-error-shaped) output yields no hint.
   - **crit 4** — build a synthetic string that matches two rule patterns at once
     (e.g. one that contains both `"Unknown tool: "` and `"Text not found in "`),
     assert the returned hint `===` the *earlier* rule's `.hint` from
     `RECOVERY_RULES` (look it up by index, do not hard-code the prose).
     Invariant: first-match-wins ordering is preserved.
   - **crit 5 (idempotency)** — import the exported guard transform
     `annotate(result: ToolResult): ToolResult` (task 3 makes it a top-level
     pure function so the invariant is directly testable). Build a failed result
     `{ content: "Text not found in /tmp/x.ts.", isError: true }`, then assert:
     (i) `annotate(r).content` matches `/Recovery hint: /` (one block added);
     (ii) `annotate(annotate(r)).content === annotate(r).content` — feeding
     **already-marked** content back through the guard adds **no second block**
     (this is the real marker short-circuit invariant from design D4 `:159`–`168`,
     and it fails if the `includes("Recovery hint:")` guard is removed);
     (iii) `annotate({ content: "ok", isError: false })` returns the result with
     content unchanged (success is never annotated, design D2). Invariant: the
     guard is idempotent and gated on `isError`.
2. **(test)** In the same file, write the live agent-loop tests using
   `makeHarness` + `MockProvider` scripting and a real temp file (create via
   `node:fs` `mkdtempSync` under `os.tmpdir()`, set `EAGENT_WORKSPACE` to that
   dir so `core-tools` `confine` permits it, write a known file). Load **only**
   `core-tools` and `recovery` via `h.host.use(...)`. A shared helper
   `sawHint(agent)` returns whether any `tool_result` the model saw matches
   `/Recovery hint: /`.
   - **crit 6** — script an `edit` call whose `old` is absent from the temp file,
     then a closing `{text:"done"}` turn. After `agent.run`, assert `sawHint` is
     true **and** the annotated `tool_result` content matches `/re-read/`.
     Invariant: a genuinely-failed edit reaches the model with the rule-1 hint.
   - **crit 7** — script a successful `read` of the temp file, then a closing
     turn. Assert `sawHint` is false. Invariant: successful output is never
     annotated (the `isError`-only gate, design D2).
   - **crit 8 (kill switch)** — set `process.env.EAGENT_RECOVERY = "off"` before
     `h.host.use("recovery", …)` (restore it in a `finally`), repeat the crit-6
     failed `edit`, assert `sawHint` is false. Invariant: the env kill switch
     fully disables annotation.
   - **crit 9 (teardown)** — load `recovery`, then `await h.host.unload("recovery")`
     (or dispose the registration), repeat the failed `edit`, assert `sawHint`
     is false. Invariant: teardown unregisters the `afterToolCall` hook (no leak).
   (Idempotency is covered faithfully by the unit test in task 1 — `annotate`
   fed already-marked content — so no live double-application test is needed
   here; a second scripted `edit` would only produce a fresh, single-pass result
   and would not exercise the marker short-circuit.)
3. **(impl)** Create `src/extensions/recovery.ts`:
   - Export `interface RecoveryRule { match: RegExp; hint: string }`.
   - Export `const RECOVERY_RULES: readonly RecoveryRule[]` with the six rules of
     design D3 (`:124`–`145`), regexes exactly as specified, hints containing the
     keywords crit 2 asserts.
   - Export `function recoveryHint(content: string): string | null` — first rule
     whose `match.test(content)` is true returns its `hint`, else `null`.
   - Export a top-level pure transform
     `export function annotate(result: ToolResult): ToolResult` —
     `if (!result.isError) return result; if (result.content.includes("Recovery hint:")) return result; const hint = recoveryHint(result.content); return hint ? { ...result, content: result.content + "\n\nRecovery hint: " + hint } : result;`.
     Exporting it (rather than inlining the logic in the hook closure) is the
     test seam for design crit 5 / D4 idempotency — it is the *same* behavior the
     hook applies, exposed for direct unit testing, consistent with deliverable
     2's "export pure helpers" pattern. It introduces no new behavior.
   - `export default function activate(e: ExtensionAPI): () => void` — if
     `process.env.EAGENT_RECOVERY === "off"`, return a no-op teardown
     immediately. Otherwise register `const off = e.hook("afterToolCall", (result) => annotate(result));`
     and return a teardown that disposes `off` in a throw-guarded `try/catch`
     (matching the `todo`/`integrity` teardown idiom).
4. **(impl)** Register `recovery` in `BUILTIN_EXTENSIONS` (`src/host.ts`): add the
   import and a `["recovery", recovery]` tuple. Place it after `prune` (its
   sibling result/context-transform extension) and before `planmode`, or
   adjacent to the other reliability extensions — exact position is not
   load-bearing (order only matters for id-collision precedence, not relevant
   here). Mirror the existing import style (`import recovery from "./extensions/recovery.js";`).
5. **(impl)** Add a one-line `recovery` entry to the CLAUDE.md extension
   inventory (the bulleted list under "Where things live"), in the same terse
   style as the `prune`/`todo` entries: name it, say it appends a corrective
   hint to failed tool results via `afterToolCall`, note `EAGENT_RECOVERY=off`
   and "no capability".

**Per-task acceptance commands** (runnable from repo root):

- Matcher + idempotency + first-match (crit 2,3,4,5):
  `npm test -- --test-name-pattern="recovery"` (runs every test whose name
  contains "recovery"; all unit + live cases live in `test/recovery.test.ts`).
- Full suite (regression + live crit 6,7,8,9):
  `npm test`
- Typecheck (crit 1): `npm run typecheck`

> Note: the project `test` script globs `test/**/*.test.ts`, so the new file is
> picked up automatically. (Verified at acceptance: `--test-name-pattern` does
> **not** subset this `node --import tsx --test` runner — it executes the whole
> file set regardless — so the recovery cases are confirmed by reading the
> `ok 244`–`ok 253` lines in the full `npm test` output.) The single canonical
> acceptance gate for the Phase is `npm test` exit 0 **and**
> `npm run typecheck` exit 0.

**Exit condition:** `npm test` exits 0 (new `test/recovery.test.ts` plus all
pre-existing tests green) and `npm run typecheck` exits 0; `recovery` present in
`BUILTIN_EXTENSIONS`; CLAUDE.md inventory updated.

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md "House conventions": ESM + NodeNext with
  `.js` import specifiers even for `.ts` files; strict TypeScript
  (`noUncheckedIndexedAccess` etc., no `any`); **zero runtime dependencies
  except `jiti`**; tests use `node:test` via `tsx` and must run offline against
  `MockProvider`. `recovery` adds no dependency and no capability.
- **Four-corner subagent template** — `references/loop-3-development.md`.
- **Commit conventions** — SKILL.md "Commit conventions": `feat(phase1):` for the
  Phase opener, `fix(phase1-roundR): <keyword>` for within-round fixes;
  `npm test` / `npm run typecheck` results as trailers; no mention of AI/tooling.

## 4. Data and Fixture Dependencies

- Reuse `test/helpers.ts` (`makeHarness`, `autoUI`, `silentLogger`) and
  `MockProvider` responder scripting — no new harness needed.
- The live tests create an ephemeral temp dir/file with `node:fs`
  `mkdtempSync(join(os.tmpdir(), "eagent-recovery-"))` and point
  `process.env.EAGENT_WORKSPACE` at it so `core-tools` `confine` permits reads
  and edits; restore/clear the env and remove the dir in `finally`. No
  committed fixture files.
- No network, no API key (offline rule upheld).

## 5. Regression Protection

- `npm test` (the whole suite) must stay green: the change adds one new
  extension and registers it as a builtin. The most relevant existing suites to
  watch are `test/core-tools.test.ts` (the `edit`/`read`/`write` behavior the
  live tests drive) and `test/host.test.ts` (builtin registration). Because
  `recovery` only appends to `isError` results, no existing test that asserts on
  *successful* tool output can change; any existing test that asserts on a
  *failed* tool result's exact content is the regression risk to confirm — if
  one exists and now sees an appended hint, that is a real interaction to
  reconcile (update the assertion or confirm `recovery` is not loaded in that
  harness). Verify by running `npm test` and reading any failure.
