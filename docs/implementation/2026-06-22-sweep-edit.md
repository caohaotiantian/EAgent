# Implementation: `sweep-edit` — regex-enumerated multi-site refactor that fans a sub-agent per match

Slug: `2026-06-22-sweep-edit`
Design: [`docs/design/2026-06-22-sweep-edit.md`](../design/2026-06-22-sweep-edit.md) (status: PASSED)
Mode: **batch** — `src/host.ts`, `CLAUDE.md`, `README.md` are **off-limits** (see §3).

This guide drives a fresh agent through TDD development of the `sweep_edit`
tool. It adds **no requirement absent from the design**; every task traces to a
design Deliverable (§D-Del) or Acceptance Criterion (§D-AC). When this guide and
the design disagree, the design wins — stop and reconcile.

---

## 1. Task Index — design → phase tasks

Design Deliverables (design §2):

| Design Deliverable | Phase task(s) |
| --- | --- |
| `src/extensions/sweep-edit.ts` — one tool `sweep_edit`, gated `fs:write`+`agent:spawn`, enumerate via `grep`, one child per file | T2, T4, T6, T8, T10, T12, T14, T16 (impl tasks) |
| `test/sweep-edit.test.ts` — offline `node:test`, real temp workspace, loaded via `host.use("sweep-edit", sweepEdit)`, no `BUILTIN_EXTENSIONS` dependency | T1, T3, T5, T7, T9, T11, T13, T15 (test tasks) + T0 (scaffold) |
| Kill switch `EAGENT_SWEEP_EDIT=off` (registers nothing, no-op dispose) | T15 (test) / T16 (impl) |
| `/sweeps` command explaining the contract + max-sites cap | T13 (test) / T14 (impl) |
| Dispose loop that never throws | T15/T16 (covered by AC9 teardown test + try/catch in dispose) |
| **host.ts registration in `BUILTIN_EXTENSIONS`** | **(deferred to batch integration — DO NOT do here)** |
| **CLAUDE.md / README inventory line + extension count** | **(deferred to batch integration — DO NOT do here)** |
| `docs/implementation/2026-06-22-sweep-edit.md` (this log) | this file; closeout notes appended at §6 |

Design Acceptance Criteria (design §7) → tasks:

| Design AC | Business invariant | Task |
| --- | --- | --- |
| AC1 — enumeration fans one child per matched file | sweep enumerates all matching files and edits each | T1 → T2 |
| AC2 — a site may decline (false-positive tolerance) | a declined site is left unchanged and reported `declined` | T3 → T4 |
| (AC1 corollary) — a non-matching file is never touched | a non-matching file is never touched | T5 → T6 |
| AC6 — max-sites cap truncates and logs | the cap truncates with a logged note when exceeded | T7 → T8 |
| (Dep §5 + D1) — confinement inherited from `grep` | enumeration is confined to the workspace root (no escape) | T9 → T10 |
| AC3 — a child error fails only its site (D6) | a child error fails only that site, not the sweep | T11 → T12 |
| AC4 — capability gating (D4) | `fs:write`/`agent:spawn` required; denied → sweep refused | (folded into T13) → T14, and T2's spec assertion |
| AC7 — missing dependency yields a clear error | absent `grep`/`edit` → clear error result, not a crash | (T9/T10 covers the confinement path; missing-dep is asserted in T13/T14) |
| AC8 — kill switch | `EAGENT_SWEEP_EDIT=off` registers nothing | T15 → T16 |
| AC9 — clean teardown | `host.unload` removes the tool (and `/sweeps`) without throwing | T15 → T16 |
| AC5 — child scoped to read+edit (D3) | child registry omits `bash`/net (an `Unknown tool` result) | T11/T12 (scoped registry is built in T12; assert in T11) |
| AC10 — suite green | full suite + typecheck green | T17 (phase exit) |

> The IMPL-SPEC live-invariant list maps 1:1 onto AC1/AC2/(non-match)/AC6/
> confinement/AC3/AC4/AC9. AC4's "denied → refused" is the `agent:spawn` deny-rule
> path; the AC5 read+edit scoping is the same registry-omission lever the
> `subagents` recursion guard uses. No extra invariants are introduced.

---

## 2. Phase Breakdown

There is **one phase**. The deliverable is two new files that compose three
already-tested extensions (`core-tools`, `search`, `subagents`-style spawning);
nothing here is separable into an earlier independently-shippable slice — the
tool is meaningless without enumeration, spawning, and the cap together, and the
tests need all of them loaded. So: single phase, TDD task order below.

### Entry condition

- Working tree clean on a fresh branch off the integration base.
- `npm test` and `npm run typecheck` both green **before** any change (establish
  the regression baseline — see §5).
- You have read the design doc end-to-end and the four reference files this guide
  cites: `src/extensions/subagents.ts`, `src/extensions/search.ts`,
  `src/extensions/core-tools.ts`, `test/recovery.test.ts` (the
  `host.use`/kill-switch/`unload` test pattern) and `test/subagents.test.ts`
  (the child-scripting + recursion-guard pattern).

### Design refs (read before writing code)

- **Enumeration (D1):** reuse the registered `grep` tool — `e.agent.tools.get("grep")`,
  call `.execute({ pattern, include }, ctx)`, parse the `path:line:text` lines
  (`search.ts:230`, format `${rel}:${n + 1}:${line}`). Do **not** add a second
  walker. `grep` already confines to `EAGENT_WORKSPACE`/cwd, skips symlinks,
  ignores `.git`/`node_modules`, and caps at 100 matches (`search.ts:19,25-46,99-119`).
  **Parse defensively — two grep output lines are not sites:** (i) on the empty
  result `grep` returns the literal string `(no matches)` (`search.ts:236`), which
  must map to an **empty worklist**, not a site named `(no matches)`; (ii) when the
  100-match cap is hit `grep` appends a non-conforming trailer
  `... (truncated at 100 matches; narrow the search to see more)` via `withMarker`
  (`search.ts:121-124`), which has no parseable `:line:` segment. So: split each
  output line on the **first two** `:` (path, line-number, then the rest as text)
  and **skip any line whose line-number segment is not a positive integer** — this
  drops both the trailer and the `(no matches)` line cleanly. (The seeded fixtures
  stay well under 100 matches, so the cap trailer is unlikely to appear in the
  tests, but D1/T9 make `grep` the sole enumerator — handle it so the tool is
  robust outside the fixtures.)
- **One child per site (D2):** group the parsed matches by file; spawn one child
  per file with `{file, matchedLines, instruction}`. Independent sites run via
  `Promise.all` (the `subagents.ts:158` pattern).
- **Scoped child (D3):** build the child registry as **read+edit only** — a fresh
  `ToolRegistry` seeded with exactly the parent's `read` and `edit` tools, nothing
  else. This is the same registry-omission lever as `childRegistryFrom`
  (`subagents.ts:210-217`); here the closed set is `[read, edit]`. Run the child
  against the **parent's** capability manager (`e.agent.capabilities`) — it needs
  `fs:read`+`fs:write`, so the `readOnly` lane (`subagents.ts:202-204`) is too
  strict and is **not** reused. Confinement is by registry omission, not
  capability (design §8 names this residual).
- **Capabilities (D4):** declare `capabilities: ["fs:write", "agent:spawn"]` on
  the tool spec; `activate` calls `e.grantCapability("agent:spawn")` (mirrors
  `subagents.ts:44`; `fs:write` is already granted by `core-tools.ts:46`, but a
  grant is idempotent — granting it again is harmless and makes the extension
  self-sufficient about the capability it requires).
- **Cap (D5):** named constant `DEFAULT_MAX_SITES = 50`, overridable via the
  `maxSites` parameter. When the file worklist exceeds the cap, truncate to the
  cap, set `truncated: true` in the returned summary, and `e.log.warn(...)` a
  message containing the word "truncat" (no silent cap — `search.ts:122-124`
  precedent).
- **Per-site failure (D6):** each child runs inside try/catch; a throw or a
  failure-signalling child becomes `{file, status: "error", note}` and the other
  sites are unaffected (`agent.ts:295-306` posture).
- **Return shape (D7):** JSON string of `[{file, status, note}]` plus a header
  line with totals and the `truncated` flag. Pure format choice.
- **Child Agent construction:** same surface `subagents.ts:59-70` uses —
  `new Agent({ providers: e.agent.providers, capabilities: e.agent.capabilities,
  ui: e.agent.ui, logger: e.agent.logger, model: e.agent.model,
  provider: e.agent.providerName, systemPrompt, maxTurns, tools: childRegistry })`.
  Harvest the child's final text with a `finalText`-style helper
  (`subagents.ts:227-235`). Use a small `maxTurns` (the `DEFAULT_MAX_TURNS = 8`
  bound is the established default; a child either edits in a turn or two, or
  declines).
- **Kill switch + dispose:** `if (process.env.EAGENT_SWEEP_EDIT === "off") return () => {};`
  (mirrors `recovery.ts:103`); dispose loop wraps each `.dispose()` in try/catch
  so teardown never throws (`recovery.ts:107-113`).

### Task list (TDD order — every TEST task names the business invariant it
protects and precedes the impl it protects)

> Convention: a TEST task (Tn, n odd) is written and **must fail for the right
> reason** (red) before its paired IMPL task (Tn+1) makes it pass (green). Run
> the named acceptance command after each task. All tests live in the single new
> file `test/sweep-edit.test.ts`; impl in `src/extensions/sweep-edit.ts`.

#### T0 — scaffold (no behavior)

- Create `test/sweep-edit.test.ts` with imports and a temp-workspace helper.
  Reuse the `scratch()` pattern from `test/recovery.test.ts:84-99`: `mkdtempSync`
  under `tmpdir()`, set/restore `process.env.EAGENT_WORKSPACE`, `rmSync` cleanup.
  Reuse `makeHarness`, `lastText` from `test/helpers.ts` (do **not** add a new
  harness — §4). Generalize the helper to seed **2–3 files containing the
  pattern + at least one non-matching file**.
- Create `src/extensions/sweep-edit.ts` with the module header comment, the
  kill-switch guard, an empty `activate` that returns a no-op dispose, and the
  `DEFAULT_MAX_SITES`/`DEFAULT_MAX_TURNS` constants. No tool yet.
- **Acceptance:** `npm run typecheck` exit 0 (file compiles; no test asserts
  behavior yet).

#### T1 (TEST) — invariant: **`sweep_edit` enumerates all matching files and edits each**

Protects AC1. Seed a temp workspace with **3 files matching the pattern + 1
non-matching**. Load `core-tools`, `search`, `sweep-edit` via `host.use(...)`
(in that order; design Dep §5). Script a `MockProvider` whose responder:
- when the **parent** system prompt is active, emits one `sweep_edit` tool call
  (`{ pattern, instruction, glob? }`) then a final text;
- when a **child** system prompt is active (branch on a sentinel the child system
  prompt carries — the `subagents.test.ts:35-48` `req.systemPrompt.includes(...)`
  pattern), emits one `edit` tool call against the child's file, then a final text.

Assert: the returned summary has **exactly 3 entries, all `status: "edited"`**;
the 3 matching files' contents **changed on disk**; the non-matching file is
**byte-identical** (covered fully in T5, but the count==3 here already pins it).

- **Acceptance (red):** `node --import tsx --test test/sweep-edit.test.ts`
  fails (tool not registered yet).

#### T2 (IMPL) — register `sweep_edit`, enumerate via `grep`, spawn one child per file

Implement: parameters `pattern` (string, required), `glob?` (string → `grep`'s
`include`), `instruction` (string, required), `maxSites?` (integer). Declare
`capabilities: ["fs:write", "agent:spawn"]`. In `execute`:
1. resolve `e.agent.tools.get("grep")`, `e.agent.tools.get("read")`,
   `e.agent.tools.get("edit")` — if any absent, return `fail(...)` naming the
   missing tool (Dep §5; asserted in T13);
2. call `grep.execute({ pattern, include: glob }, ctx)`, parse `path:line:text`
   lines into a `Map<file, lines[]>` — skip any line without a parseable `:line:`
   integer segment, so the `(no matches)` empty-result line and the cap trailer
   are not mistaken for sites (see §Design refs D1 parse-defensively note);
3. for each file, spawn a child (read+edit registry, parent caps, small
   `maxTurns`) with a prompt carrying `{file, matchedLines, instruction}`;
4. collect `{file, status, note}`; classify the child outcome (see D7/D6);
5. return `ok(JSON.stringify(summary, ...))` with a header + `truncated` flag.

Also pin the **declared-capability contract** (AC4(b)) with a direct assertion in
the test file:
`assert.deepEqual(agent.tools.get("sweep_edit")!.capabilities, ["fs:write", "agent:spawn"])`.

- **Acceptance (green):** `node --import tsx --test test/sweep-edit.test.ts`
  passes T1; `npm run typecheck` exit 0.

#### T3 (TEST) — invariant: **a site the child declines is left unchanged and reported `declined`**

Protects AC2. Same seed. Script **one** child (branch on its file/sentinel) to
emit a final text that **declines** (no `edit` call); the others edit. Assert:
that file's summary entry is `status: "declined"`, the file is **byte-identical**
on disk, and the **other** sites are still `edited`.

- **Acceptance (red):** the new test fails (no decline classification yet).

#### T4 (IMPL) — classify a no-edit child as `declined`

Determine per-site status from the child's transcript: an `edit` ran
successfully → `edited`; the child produced a final answer but issued no
successful `edit` → `declined`. (Inspect the child's `messages` for a successful
`edit` `tool_result`, mirroring how `subagents.test.ts:24-31` collects
`tool_result` blocks.)

- **Acceptance (green):** `node --import tsx --test test/sweep-edit.test.ts`
  passes T1+T3; `npm run typecheck` exit 0.

#### T5 (TEST) — invariant: **a non-matching file is never touched**

AC1 corollary. Assert the non-matching seed file's bytes are **identical** before
and after the sweep, and that it appears in **no** summary entry. (Enumeration is
by `grep` over `pattern` (+`glob`), so a non-matching file is never a site.)

- **Acceptance (red/green):** if T2 enumerated strictly via `grep`, this likely
  passes already — keep it as an explicit regression pin. If it fails, the bug is
  in enumeration, not a new feature: fix in `sweep-edit.ts`, no new requirement.

#### T6 (IMPL) — (only if T5 red) tighten enumeration to grep-derived files only

No file outside the parsed `grep` worklist may be spawned/edited. (Most likely a
no-op if T2 was written correctly.)

- **Acceptance:** `node --import tsx --test test/sweep-edit.test.ts` passes
  T1+T3+T5.

#### T7 (TEST) — invariant: **the max-sites cap truncates with a logged note when exceeded**

Protects AC6. Seed `maxSites + 1` matching files (e.g. pass `maxSites: 2` with 3
matching files). Capture warnings via a `logger` whose `warn` pushes to an array
(`helpers.ts:9-14` `silentLogger` shape, but with a recording `warn`), passed to
`makeHarness({ logger })`. Assert: summary length === `maxSites` (2);
`truncated === true`; `warnings.some(w => /truncat/i.test(w))`.

- **Acceptance (red):** fails (no cap yet).

#### T8 (IMPL) — apply the `DEFAULT_MAX_SITES = 50` cap, overridable, with a `warn`

Resolve the effective cap (`maxSites` arg if a positive integer, else
`DEFAULT_MAX_SITES`). If the file worklist length exceeds it, slice to the cap,
set `truncated: true`, and `e.log.warn(...)` a message containing "truncat".

- **Acceptance (green):** `node --import tsx --test test/sweep-edit.test.ts`
  passes T1+T3+T5+T7; `npm run typecheck` exit 0.

#### T9 (TEST) — invariant: **enumeration is confined to the workspace root (no escape)**

Protects Dep §5 / D1 (confinement inherited from `grep`). Two sub-assertions:
(a) a `pattern`/`glob` that would point outside the workspace yields no
out-of-root site (the sweep never edits a file above the workspace);
(b) `sweep_edit` loaded **without** `search` returns an `isError` result whose
message names the missing `grep` tool (AC7) — confirming `sweep_edit` does not
fall back to its own walker.

- **Acceptance (red):** the missing-`grep` half fails until the dependency check
  exists (it was added in T2; if so this passes — keep as a regression pin). The
  confinement half passes by construction (it rides `grep`).

#### T10 (IMPL) — (only if T9 red) clear missing-dependency error; no fallback walker

Ensure the absent-`grep` path returns `fail(...)` naming `grep` (and likewise for
`read`/`edit`). Never shell out, never walk the tree directly (design §3 NON-goal
and D1).

- **Acceptance:** `node --import tsx --test test/sweep-edit.test.ts` passes
  through T9.

#### T11 (TEST) — invariant: **a child error fails only that site, not the sweep** (and child is scoped to read+edit)

Protects AC3 + AC5. Script **one** child to call `edit` with an `old` string that
is **absent** in its file (so `edit` returns `Text not found in ...` —
`core-tools.ts:181`) and never recover. Assert: that site is `status: "error"`,
its `note` carries the failure text, the **other** sites are still `edited`, and
**the sweep itself did not throw** (the `await` resolved). In the same or a
sibling test, script a child to call `bash`; assert the child transcript contains
an `Unknown tool: bash` result (AC5 — `bash` is absent from the read+edit
registry), the child's site still completes, and no shell ran. This is the
`subagents.test.ts:174-214` recursion-guard pattern applied to the closed
`[read, edit]` set.

- **Acceptance (red):** fails (no per-site error isolation / scoped registry
  yet).

#### T12 (IMPL) — per-site try/catch + scoped read+edit child registry

Wrap each child run in try/catch; on throw, or on a child whose `edit` failed
(`isError` `tool_result`) with no successful edit, record `{status: "error",
note}`. Build the child registry as a fresh `ToolRegistry` seeded with **only**
the parent's `read` and `edit` tools (closed set — never extended from caller
input, design §8). Confirm `bash`/net tools are absent, so a child `bash` call
resolves to `Unknown tool`.

- **Acceptance (green):** `node --import tsx --test test/sweep-edit.test.ts`
  passes through T11; `npm run typecheck` exit 0.

#### T13 (TEST) — invariant: **`fs:write`/`agent:spawn` required (denied → the sweep is refused)** + `/sweeps` command

Protects AC4 + the `/sweeps` Deliverable. AC4(a): build the agent directly with a
`new CapabilityManager({ deny: ["agent:spawn"] })` (the `cassette.test.ts:70-72` /
`capabilities.test.ts:21` direct-construction pattern — `makeHarness` forwards
only `fallback`, so construct the `Agent` yourself for this one test), load
`core-tools`+`search`+`sweep-edit`, invoke `sweep_edit`, and assert the
`tool_result` block is `isError: true` (denied at the dispatcher before any child
runs; a `deny` rule beats any grant — `capabilities.ts:86-88`). AC4(b) is the
`assert.deepEqual` on the spec capabilities (already added in T2's test). For
`/sweeps`: assert `commands.get("sweeps")` exists and its `run` prints text
mentioning the contract and the max-sites cap (the `subagents.test.ts:295-308`
`/agents` pattern).

- **Acceptance (red):** fails (no `/sweeps` command; deny-gate assertion needs
  the tool's declared capabilities).

#### T14 (IMPL) — register `/sweeps`; confirm capability declaration drives the gate

Register a `sweeps` command (mirrors `subagents.ts:180-190`) whose `run` prints
the tool's contract and the cap. The capability **declaration** on the tool spec
(done in T2) is what the dispatcher enforces (`agent.ts:331-333`); no extra code
needed for AC4(a) beyond that declaration — the test pins it.

- **Acceptance (green):** `node --import tsx --test test/sweep-edit.test.ts`
  passes through T13; `npm run typecheck` exit 0.

#### T15 (TEST) — invariant: **kill switch registers nothing** & **`host.unload` removes the tool** (clean teardown)

Protects AC8 + AC9. Kill switch: set `process.env.EAGENT_SWEEP_EDIT = "off"`
(save/restore around the test — `recovery.test.ts:149-171` pattern), `host.use`,
then assert `agent.tools.has("sweep_edit") === false` **and**
`commands.get("sweeps") === undefined`. Teardown: with the switch unset, `host.use`
then `await host.unload("sweep-edit")` and assert `agent.tools.has("sweep_edit")
=== false`, `commands.get("sweeps") === undefined`, and that `unload` **did not
throw** (the `recovery.test.ts:173-192` `unload` pattern).

- **Acceptance (red):** fails until the kill switch + tracked-disposal dispose
  loop are in place.

#### T16 (IMPL) — kill switch + never-throwing dispose loop

Add `if (process.env.EAGENT_SWEEP_EDIT === "off") return () => {};` at the top of
`activate` (mirrors `recovery.ts:103`). Track every registration's disposable and
return a dispose that wraps each `.dispose()` in try/catch (mirrors
`recovery.ts:107-113`) so teardown never throws. (Registrations made through
`e.registerTool`/`e.registerCommand` are already host-tracked for `unload`
(`extension.ts:228-230`); on `host.unload` the host pushes this returned dispose
onto the **same** disposables array it already tracks and combines all of them
(`extension.ts:243-256`), so each tool/command handle is disposed **twice** — once
via host tracking, once via this returned dispose. That is intentional and benign:
a second `.dispose()` on an already-disposed registry handle is a no-op here, the
**host tracking is the real teardown path**, and the returned dispose is purely
defensive — present only to satisfy the never-throw rule for any disposable not
host-tracked. The AC9 teardown test (T15) asserts the end state, `tools.has(...)
=== false` and no throw, which a clean single-dispose and this redundant
double-dispose reach identically, so the test does not — and need not —
distinguish them.)

- **Acceptance (green):** `node --import tsx --test test/sweep-edit.test.ts`
  passes the full file; `npm run typecheck` exit 0.

#### T17 — phase close: full suite + typecheck

- **Acceptance:** `npm test` exit 0 (full suite green; `search.test.ts` and
  `subagents.test.ts` unaffected) **and** `npm run typecheck` exit 0.

### Exit condition

- Every Tn-test in `test/sweep-edit.test.ts` is green and each protects a named
  business invariant traceable to design §7.
- `node --import tsx --test test/sweep-edit.test.ts` passes.
- `npm test` exit 0 and `npm run typecheck` exit 0 (design AC10).
- Only these files changed: `src/extensions/sweep-edit.ts`,
  `test/sweep-edit.test.ts`, and this doc. **`src/host.ts`, `CLAUDE.md`,
  `README.md` untouched** (§3).
- Closeout notes (§6) filled in.

---

## 3. Engineering Constraints Index

House rules (from `CLAUDE.md`; this guide does not invent any):

- **ESM + NodeNext.** Always use `.js` import specifiers even when importing a
  `.ts` file (e.g. `import { defineTool, fail, ok } from "../kernel/define.js";`,
  `import { Agent } from "../kernel/agent.js";`,
  `import { ToolRegistry } from "../kernel/registry.js";`). Required by
  `module: NodeNext` + `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are on. **No `any`** — model
  the types (`unknown` + narrowing, like `core-tools.ts` does with `String(args.x)`
  and `typeof` guards). `noUncheckedIndexedAccess` means array/Map indexing yields
  `T | undefined` — narrow before use (the `!` and `?.at(-1)` idioms in
  `subagents.ts`/`registry.ts` show the house style).
- **Zero runtime dependencies except `jiti`.** Pure Node only. Do **not** add an
  npm dependency, do **not** shell out, do **not** add a walker — enumeration is
  the registered `grep` tool (design D1, §3 NON-goal).
- **Every side-effecting extension is capability-gated.** `sweep_edit` declares
  `capabilities: ["fs:write", "agent:spawn"]`; the dispatcher enforces them before
  `execute` (`agent.ts:331-333`). `activate` grants `agent:spawn` via
  `e.grantCapability` (`subagents.ts:44` precedent).
- **Offline `node:test` via `tsx`.** No network, no `ANTHROPIC_API_KEY`. The
  scriptable `MockProvider` (`src/providers/mock.ts`) drives every child. Keep it
  offline.
- **Kill switch.** `EAGENT_SWEEP_EDIT=off` → register nothing, no-op dispose
  (`recovery.ts:103` shape).
- **Dispose loop that never throws.** try/catch around each `.dispose()`
  (`recovery.ts:107-113`).
- **Reuse, do not reimplement.** Compose `grep` (enumeration), the `Agent`
  surface (spawning), and `read`/`edit` (mutation). No new edit primitive, no new
  capability string, no DAG, no re-sweep (design §3 NON-goals).

Commit conventions (single phase ⇒ phase 1):

- Subject prefix `feat(phase1)` for forward work; `fix(phase1-roundR)` for a
  review-round fix (R = the review round number).
- Trailers: include the `npm test` and `npm run typecheck` results.
- **No mention of AI/model/tooling** in commit messages (and none of the
  branch's other automated trailers beyond what the repo's git hooks add).
- Branch first (never commit on the default branch); commit/push only when asked.

---

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`** — `makeHarness({ responder, fallback, ui, logger })`,
  `lastText`, `silentLogger`, `autoUI`. Do **not** write a second harness.
  - `makeHarness` forwards only `fallback` to the `CapabilityManager`. For the
    AC4(a) **deny** test (T13) you must construct the `Agent` directly with
    `new CapabilityManager({ deny: ["agent:spawn"] })` — the
    `cassette.test.ts:70-72` / `capabilities.test.ts:21` direct-construction
    pattern. Register the `MockProvider` on `agent.providers` and build the
    `ExtensionHost` the way `makeHarness` does (or reuse `makeHarness` for all
    other tests and hand-roll only this one).
  - For the cap test (T7) pass a recording `logger` (clone `silentLogger`, make
    `warn` push to an array) so the truncation warning is observable.
- **Temp workspace fixture** — copy the `scratch()` helper shape from
  `test/recovery.test.ts:84-99`: `mkdtempSync(join(tmpdir(), "eagent-sweep-"))`,
  set `process.env.EAGENT_WORKSPACE = dir` (save/restore the prior value),
  `writeFileSync` the seed files, `rmSync({ recursive: true, force: true })` in
  `cleanup()` inside a `finally`. Seed **2–3 files containing the pattern + at
  least one non-matching file** (AC1/AC2/non-match); add extra matching files for
  the cap test (T7 needs `maxSites + 1`).
- **Scripted `MockProvider`** — branch the responder on the **system prompt**:
  parent vs child (`req.systemPrompt.includes(<sentinel>)`, the
  `subagents.test.ts:35-48` pattern). To target a *specific* child by file,
  include the file path in the child system prompt (the prompt `sweep_edit`
  passes per site) or inspect the last user text
  (`subagents.test.ts:13-21` `lastUserText`). Each child emits an `edit` call
  (edit), a `bash` call (AC5 scoping), an absent-`old` `edit` (AC3 error), or a
  bare final text (AC2 decline).
- **No new fixture files on disk** beyond the temp workspace; no committed
  fixtures, no network, no cassette.

---

## 5. Regression Protection

The composition reuses `grep`, the `Agent` spawn surface, and `read`/`edit`
**without modifying any of them**. These prior suites must stay green and are the
canary that the reuse did not regress its dependencies:

- **`test/search.test.ts`** — `grep`/`glob` confinement, symlink-skipping,
  binary guard, 100-result cap. `sweep_edit` is a *consumer* of `grep`; this
  suite must be **unaffected** (design AC10, §6 relationship).
- **`test/subagents.test.ts`** — child spawning, the `childRegistryFrom`
  recursion guard, `readOnlyCapabilities`. `sweep_edit` reuses the same `Agent`
  construction surface; this suite must be **unaffected**.
- **`test/core-tools.test.ts`** — `read`/`edit`/`write`/`bash` + `fs:write` /
  `shell:exec` gating. The child edits via the unchanged `edit` tool; this suite
  must stay green.
- **`test/recovery.test.ts`** — the `host.use`/kill-switch/`unload` pattern this
  guide mirrors; unchanged.
- **The full suite** (`npm test`) and `npm run typecheck` — the phase-exit gate
  (T17, design AC10). Run both before starting (baseline) and at close.

If any prior test changes behavior, **stop** — the design mandates pure
composition with no edits to the reused extensions or the kernel. A regression
there means the implementation reached into a dependency it should only consume.

---

## 6. Closeout notes

Phase 1 complete. Branch `20260622sweepedit-dev-r1`, base
`1dd14589187cd26fbc548652d1415578ff08b09f`.

- [x] All `test/sweep-edit.test.ts` invariants green (13 tests, one per AC +
      the AC1-corollary/confinement pins). Each was validated by mutation: the
      decline/error classification, the `maxSites` cap, the scoped `[read, edit]`
      child registry, the kill switch, and the declared-capability contract were
      each broken in turn and the matching test went red, confirming no test is a
      tautology.
- [x] `npm test` exit 0 (456 pass, 0 fail — 443 baseline + 13 new);
      `npm run typecheck` exit 0.
- [x] `search.test.ts` + `subagents.test.ts` + `core-tools.test.ts` (+
      `recovery.test.ts`) unaffected — 42/42 green; the composition reuses `grep`,
      the `Agent` spawn surface, and `read`/`edit` with **no edits** to any of
      them.
- [x] Files changed limited to `src/extensions/sweep-edit.ts`,
      `test/sweep-edit.test.ts`, this doc (closeout).
- [x] `src/host.ts`, `CLAUDE.md`, `README.md` **untouched** (batch-deferred).
- [x] Deferred for batch integration: `BUILTIN_EXTENSIONS` registration +
      CLAUDE.md/README inventory line + extension count.

### TDD order followed (red → green)

- **T1 (AC1)** written first; ran red ("the sweep_edit tool result is present"
  failed — tool unregistered). **T2** implemented the tool → green.
- **T3 (AC2 decline)** — validated red via mutation (forcing `declined`→`edited`
  fails AC2); classified a no-edit child as `declined` → green.
- **T5 (AC1 corollary, non-match)** — regression pin; passed on the grep-derived
  worklist as the impl doc anticipated (enumeration is strictly grep-driven).
- **T7 (AC6 cap)** — validated red via mutation (removing the cap fails AC6); the
  `DEFAULT_MAX_SITES = 50` cap, `truncated` flag, and `e.log.warn` make it green.
- **T9 (AC7 missing-dep + confinement)** — the absent-`grep` path returns a clear
  `fail` naming `grep`; confinement rides `grep` (no second walker).
- **T11 (AC3 + AC5)** — validated red via mutation (breaking per-site error
  isolation fails AC3; seeding `bash` into the child registry fails AC5); per-site
  try/catch + the closed `[read, edit]` registry make both green.
- **T13 (AC4)** — the deny-rule gate (a) is driven by the declared capability
  array, and (b) is pinned directly; `/sweeps` prints the contract + cap.
- **T15 (AC8 + AC9)** — kill switch (validated red via mutation) registers nothing
  under `EAGENT_SWEEP_EDIT=off`; `host.unload` removes tool + command without
  throwing (never-throwing dispose loop).

### Notes / residuals (as designed)

- Confinement is **defense-by-registry-omission, not by capability** (design §8,
  D3): the child runs against the parent's capability manager, so AC5 asserts
  `bash` is *absent from the registry* (an `Unknown tool: bash` result), not that
  the capability layer denies a shell call. The `[read, edit]` registry is a
  closed two-tool set, never extended from caller input.
- Return shape (D7): the tool's `content` is a single JSON object
  `{total, edited, declined, errors, truncated, sites:[{file,status,note}]}` — the
  per-site array plus the totals/`truncated` header fields in one machine- and
  model-legible payload. Pure format choice; no behavior hinges on it.
</content>
</invoke>
