# skills-hardening — supply-chain scan, frontmatter lint, allowed-tools scoping, trigger-gated disclosure

Status: closed
Closing-commit: 186f0dd
Closed-on: 2026-06-22
Deferred: finding — trigger-gating couples to skills.ts tier-1 render format; skill:write capability characterization corrected (doc-precision)
Date: 2026-06-22
Author: design author (EAgent)

## 1. Background and Purpose

Skills are EAgent's most-trusted self-extension surface and the least guarded.
A skill is a folder with a `SKILL.md` (`src/extensions/skills.ts`): YAML-ish
frontmatter (`name`, `description`) plus a markdown body that is loaded verbatim
into context via `skill_read` (`skills.ts:62`), optionally referencing scripts
the agent then runs through the ordinary `bash` tool. Three structural gaps make
this dangerous:

1. **No body/script scanning.** The `integrity` extension
   (`src/extensions/integrity.ts`) sweeps only tool *descriptions*: its `sweep()`
   iterates `e.agent.tools.list()` and runs `detectSuspiciousDescription` on
   `tool.spec.description` (`integrity.ts:44-51`). A downloaded or poisoned
   `SKILL.md` *body* — or a referenced script doing `eval`/`child_process.exec`,
   `curl … | sh` exfil, or an `API_KEY`/`.env` credential read near a network
   call — rides straight into context and onto `bash` with zero scanning.
2. **No frontmatter validation.** `scanSkills` (`skills.ts:134`) accepts whatever
   `parseFrontmatter` (`skills.ts:155`) returns: any `name`, any `description`,
   any keys, no length caps, angle brackets allowed. A hostile `description`
   becomes a tier-1 line injected every turn.
3. **No tool scoping.** Anthropic's SKILL.md standard has an `allowed-tools`
   field, but EAgent ignores it: an active skill inherits the full ambient tool
   surface. The capability layer (`src/kernel/capabilities.ts`) exists but is not
   wired to skills.
4. **Unconditional tier-1 disclosure.** The `transformContext` hook
   (`skills.ts:43-59`) injects *every* skill's `name + description` on *every*
   turn, regardless of relevance.

The purpose of `skills-hardening` is to close these four gaps with four small,
independently-killable additions, each **reusing an existing detector or
mechanism** rather than inventing a new one:

- (1) add a `session_start` sweep (and `/skills` surfacing) that scans each
  SKILL.md **body** and referenced scripts using `mcp`'s exported
  `detectSuspiciousDescription` markers **plus** a small
  `eval`/`exec`/`curl`/env-near-network pattern set, and fingerprints bodies for
  cross-session rug-pull detection (warn, never block) — mirroring `integrity`'s
  baseline-in-store pattern (`integrity.ts:54-69`) and re-implementing its 4-line
  djb2 hash (`integrity.ts:36-40`) locally rather than importing it, since that
  hash is module-private to `integrity.ts` (its sole export is `activate`) and
  exporting it would mean editing a second existing file;
- (2) a **frontmatter validator** on `scanSkills` (kebab-case `name` ≤64,
  non-empty `description` ≤1024 with no angle brackets, key allowlist) surfaced
  via `/skills` and enforced by `skill_create`;
- (3) parse the spec's `allowed-tools` and, while a skill is **active**, a
  `beforeToolCall` hook asks/denies any tool outside the allowlist (no-op when
  `allowed-tools` is unspecified — back-compat) — reusing the capability
  ask/deny vocabulary and the `write-guard` beforeToolCall pattern;
- (4) optional `triggers:` frontmatter so a skill's tier-1 line is injected
  **only** when a trigger word hits the latest user message — reusing
  `microagents`' whole-word `triggered`/`latestUserText` algorithm
  (`microagents.ts:77,96`); kill switch `EAGENT_SKILL_TRIGGERS=off`.

## 2. Deliverables

- [ ] `src/extensions/skills-hardening.ts` — the new extension: the four
      additions above, each independently killable, dispose loop that never
      throws.
- [ ] Edit `src/extensions/skills.ts` minimally: (a) add **new named exports**
      for the helpers the new file imports (`scanSkills`, `skillsRoot`,
      `parseFrontmatter`, and the new `validateFrontmatter`) — today the file
      exports only `activate`; and (b) one behavioral change — `skill_create`
      invokes `validateFrontmatter` so invalid frontmatter is rejected at the
      authoring boundary. The body-scan, scoping, and trigger-gating logic (the
      latter owning its **own** `transformContext` in `skills-hardening.ts`, not
      editing the tier-1 hook in `skills.ts`) all live in the new file; the tests
      call the exported helpers without duplicating the scan loop. (See D1.)
- [ ] `test/skills-hardening.test.ts` — offline `node:test` suite against
      `MockProvider` via `makeHarness`, loaded with `host.use("skills-hardening",
      …)` (and `host.use("skills", …)`) using temp dirs through
      `EAGENT_SKILLS_DIR`. Does **not** depend on the extension being in
      `BUILTIN_EXTENSIONS`.
- [ ] Kill switches: `EAGENT_SKILL_TRIGGERS=off` (piece 4), and additive scan +
      scoping pieces are revertable by diff; each of the four is independently
      disabled (see D6 / §8).
- [ ] `host.ts` registration in `BUILTIN_EXTENSIONS` — **(deferred to batch
      integration)**.
- [ ] CLAUDE.md / README inventory line reconciled at closeout — **(deferred to
      batch integration)**; README extension count **not** bumped here.

## 3. Scope Boundary (NON-goals — Simplicity First)

- **No `.skill` packaging / zip handling.** Scanning operates on already-unpacked
  `SKILL.md` folders under the skills root. Download, unzip, signature
  verification, and install flows are explicitly out of scope.
- **No blocking of suspicious bodies/scripts.** The supply-chain scan is
  warn-only (D2). It surfaces; a human reviews. It never refuses to load a skill
  or quarantines a folder.
- **No new capability.** Reuses `skill:read`/`skill:write` (already granted/asked
  in `skills.ts:37-38`) and the existing capability ask/deny vocabulary. No
  `skill:scan` or similar.
- **No script execution sandbox.** Piece (1) reads script *files* and pattern-
  matches their text; it does not run, instrument, or sandbox them. Runtime shell
  control already lives in `bash-policy` / `flow-guard` / `risk-guard`.
- **No recursive/transitive scanning.** Scan the SKILL.md body and the scripts
  *directly referenced in or co-located with* the skill folder (top level), not
  an arbitrary dependency graph.
- **No multi-skill activation model.** Active-skill state (D3) tracks the set of
  skills activated this session via `skill_read`; it does not build a
  lifecycle/priority/eviction system.
- **No deactivation command, no per-skill UI, no remote skill registry.**

## 4. Key Design Decisions

### D1 — Where the four additions live: extend in place vs. a new sibling extension

- **Problem.** The four hardenings touch surfaces owned by `skills` (scan,
  authoring, tier-1) and `integrity` (the `session_start` sweep). Do we modify
  those two files, or add a third extension?
- **Options.**
  (a) Fold everything into `skills.ts` + `integrity.ts` directly.
  (b) A standalone `skills-hardening.ts` that imports newly-exported helpers from
  `skills`/`microagents`/`mcp` and wires its own hooks.
  (c) A separate sibling extension that re-implements its own skill scan loop.
- **Choice.** **(b)** — a new `skills-hardening.ts` extension that imports and
  reuses the *existing* primitives where they are (or can cheaply become)
  exported (`detectSuspiciousDescription` from `mcp.ts` and
  `triggered`/`latestUserText` from `microagents.ts` are **already exported**, so
  they import as-is; but `scanSkills`/`skillsRoot`/`parseFrontmatter` from
  `skills.ts` are module-private today — that file exports only its default
  `activate` — so they **need new named exports**), plus a *small* set of new
  pure helpers exported from `skills.ts` for the frontmatter rules so the
  validator is shared between authoring (`skill_create`) and scan (`/skills`).
  `integrity`'s `fingerprint` is **not** imported — it is module-private to
  `integrity.ts`, so piece (1) re-implements that 4-line djb2 hash locally to
  avoid editing a second file (D2).
- **Rationale & why others rejected.** (c) is rejected by the SPEC's own DEDUP
  rule: a sibling would duplicate the scan loop and the skills-dir resolution,
  and drift from `skills.ts`'s frontmatter parsing. (a) is rejected because it
  conflates four independently-killable behaviors into two always-on files,
  defeating D6's independent kill switches and the batch-mode requirement to keep
  the new code in one auditable file; it also bloats two of the seven-primitive
  ecosystem's most load-bearing extensions. (b) keeps each behavior in one place,
  reuses every detector, and lets tests load just `skills` + `skills-hardening`.
  The concession is a **widened export surface on `skills.ts`** — today it
  exports only `activate`, so (b) adds named exports for the helpers
  `skills-hardening.ts` must call: the frontmatter `validateFrontmatter` (so
  `skill_create` rejects invalid frontmatter at the authoring boundary, where
  that code already lives), plus `scanSkills`/`skillsRoot` for the body sweep
  (piece 1) and `parseFrontmatter` for re-resolving an activated skill's
  `allowed-tools` (piece 3). These are pure-function exports of code already
  present in `skills.ts`; no behavior in `skills.ts` changes (§8).

### D2 — Supply-chain body/script scan: warn-only vs. block

- **Problem.** When the body/script scan fires a marker, do we block the skill
  from loading or merely warn?
- **Options.** (a) Block/quarantine a flagged skill. (b) Warn-only, mirroring
  `integrity`'s pure-observer stance (`integrity.ts:8-9` "never blocks a tool,
  only surfaces").
- **Choice.** **(b) Warn-only.** A flagged body emits an `e.log.warn` on
  `session_start` and via the surfacing command; the skill still loads. Bodies
  are additionally fingerprinted (a local copy of `integrity`'s 4-line djb2 hash,
  `integrity.ts:36-40`, since that function is module-private — see D1) so a
  cross-session **rug-pull** — a body benign when approved that changes on a
  later update — is warned exactly as `integrity` already does for descriptions
  (`integrity.ts:78-80`).
- **Rationale & why (a) rejected.** A skill body is *prose plus example code*. A
  legitimate skill that *teaches* `curl` usage or shows an `eval` anti-pattern
  would trip the markers; blocking it would break a correct skill on a false
  positive — an unacceptable failure mode for a heuristic regex set. Warn-only
  matches the established `integrity` contract, fails safe (the human decides),
  and keeps the detector reusable without a new capability. The rug-pull
  fingerprint is the high-signal half: a body that *changes* between sessions is
  the actual supply-chain swap, and that is exactly what `integrity` already
  treats as warn-worthy.

### D3 — allowed-tools scoping: how "active skill" state is tracked

- **Problem.** Enforcing `allowed-tools` requires knowing *which skill(s) are
  active* in this session, because the constraint only applies while a skill is
  in use. EAgent has **no skill-activation event** today — `skill_read`
  (`skills.ts:62-83`) is a plain tool call with no lifecycle signal.
- **Options for the state source.**
  (a) Treat *every* skill in the catalog as always-active (apply the union of all
  allowlists at all times).
  (b) Persist active-skill set in the extension store across sessions.
  (c) Session-scoped in-memory set, populated when the agent calls `skill_read`
  for a skill whose frontmatter declares `allowed-tools`, observed via the
  existing `tool_end` event (the same signal `write-guard` uses to track seen
  paths, `write-guard.ts:68-72`).
- **Options for the enforcement.** A `beforeToolCall` filter
  (value `ToolDecision{block,reason?,arguments}`, context `{call}`,
  `events.ts:41-58`): when ≥1 active skill declares `allowed-tools` and the
  pending tool name is in **none** of the active allowlists, `ask` via
  `e.agent.ui.confirm` (deny on "no" by setting `block:true`), matching the
  `write-guard` ask/deny shape (`write-guard.ts:74-87`). No-op when no active
  skill declares `allowed-tools` (back-compat).
- **Choice.** State source **(c)**; enforcement via the `beforeToolCall`
  ask/deny. The active set is a `Set<string>` reset on `session_start` /
  `session_shutdown` (exactly `write-guard`'s lifecycle, `write-guard.ts:89-91`),
  populated on a successful `skill_read` `tool_end` by re-resolving that skill's
  frontmatter and recording it only if it carries `allowed-tools`.
- **Rationale & why others rejected.** (a) is rejected because the union of all
  allowlists across the catalog approaches "allow everything" and punishes
  skills that *do* scope themselves — it inverts the intent. (b) is rejected
  because activation is inherently a *session* property (a skill you read this
  session, not last week); a store-persisted set would wrongly constrain a fresh
  session and adds reload/cleanup complexity for no benefit. (c) is the minimum
  reliable signal: `skill_read` *is* the activation act, `tool_end` already fires
  for it, and the session-scoped `Set` is the genuinely-new bit kept as small as
  possible. The ask/deny (not silent block) is chosen because a skill's
  `allowed-tools` is the *author's* hint, not the *operator's* policy — the human
  confirms once per capability-equivalent, consistent with the capability layer's
  ask default (`capabilities.ts:14-17`).

### D4 — Frontmatter validation: which keys and which limits

- **Problem.** `parseFrontmatter` accepts anything. What constitutes valid
  frontmatter, and what are the caps?
- **Options.** (a) No validation (status quo). (b) A schema with a *key
  allowlist* + length/charset caps. (c) A full YAML schema validator (new dep —
  forbidden by house rules).
- **Choice.** **(b)**, with:
  - `name`: required, kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$`, length ≤ 64. (The
    authoring path already slugifies via `slug`, `skills.ts:172`; the validator
    makes the same shape mandatory on the *scan* path so a hand-edited folder
    can't smuggle a non-conforming name.)
  - `description`: required, non-empty, length ≤ 1024, **no `<` or `>`** (blocks
    the `hidden-tag` injection vector that `detectSuspiciousDescription` already
    flags, `mcp.ts:130`, before it ever reaches tier-1).
  - allowed keys: `{ name, description, allowed-tools, triggers }` — any other key
    is reported as unknown (warn on scan; reject on `skill_create`).
- **Rationale & why others rejected.** (a) leaves the tier-1 injection and
  authoring path unguarded — the gap this whole design exists to close. (c) is
  rejected outright: zero runtime deps except `jiti` (house rule); a YAML library
  is exactly the kind of dependency the kernel forbids. The specific caps are a
  **non-behavioral format choice**: 64 chars is generous for a kebab-case
  identifier yet bounds a padded `/skills` table column (`skills.ts:125`
  `padEnd(20)`); 1024 chars bounds a one-sentence tier-1 line that is injected
  every turn; the angle-bracket ban is the minimal charset rule that pre-empts
  the `hidden-tag` marker. The key allowlist is closed because the only fields
  EAgent reads are these four — an unknown key is either a typo or a smuggle
  attempt, and surfacing it costs nothing.

### D5 — Trigger-gated tier-1 disclosure: reuse vs. reinvent, and default state

- **Problem.** Tier-1 currently injects every skill every turn. Gate a skill's
  line on relevance — but with which matching algorithm, and on by default or off?
- **Options for the algorithm.** (a) New substring match. (b) Reuse
  `microagents`' `triggered` whole-word, case-insensitive matcher
  (`microagents.ts:77-90`) + `latestUserText` (`microagents.ts:96-106`).
- **Options for default.** (c) Trigger-gating on by default. (d) Opt-in per skill
  via a `triggers:` frontmatter line, globally killable with
  `EAGENT_SKILL_TRIGGERS=off`.
- **Choice.** Algorithm **(b)**; default **(d)**. A skill with **no** `triggers:`
  line keeps the current always-injected behavior (back-compat). A skill that
  *declares* `triggers:` is injected into tier-1 only when `triggered(latestUser,
  skill.triggers)` is true. `EAGENT_SKILL_TRIGGERS=off` disables the gating
  entirely (everything reverts to always-on), read at hook time like
  `microagents`' own switch (`microagents.ts:117`).
- **Rationale & why others rejected.** (a) is rejected by DEDUP: a substring
  match would re-introduce the `cat`-in-`category` false-fire that
  `microagents.triggered` was written to avoid (`microagents.ts:75`), and would
  duplicate a tested algorithm. (c) (gate-by-default) is rejected because it
  could silently *hide* a skill the user wanted but didn't name with a trigger
  word — a behavior regression for every existing trigger-less skill; opt-in
  (d) means a skill author who wants gating asks for it, and everyone else is
  unaffected. The kill switch makes the whole gate revertable in one env var
  (§8).

### D6 — Independent killability of the four pieces

- **Problem.** Should the four additions share one on/off, or each be separately
  disablable?
- **Options.** (a) One `EAGENT_SKILLS_HARDENING=off` master switch. (b) Each
  piece independently killable.
- **Choice.** **(b)** — piece (4) has `EAGENT_SKILL_TRIGGERS=off`; pieces (1)
  scan, (2) validation, and (3) scoping are additive hooks whose registrations
  can be disabled/reverted independently (the scan is the new file's own
  `session_start` sweep modeled on `integrity`'s; the validator is a pure function
  the caller invokes; scoping is one `beforeToolCall` filter). A future per-piece env switch follows the same
  pattern as the other guards.
- **Rationale & why (a) rejected.** A single master switch couples a false-
  positive in the body scan to the loss of the (independently valuable)
  frontmatter validation and trigger gating. The whole "four small additions"
  framing exists so an operator can keep the parts that work and drop the part
  that misfires — exactly the malleability the kernel is built for. Each piece is
  a distinct hook/registration, so independent disablement costs no extra
  structure.

## 5. Dependencies and Assumptions

- **Reused code (no new deps):**
  - From `src/extensions/skills.ts` — **needs new named exports** (today the file
    exports only `activate`): `scanSkills` and `skillsRoot` (body sweep, piece 1),
    `parseFrontmatter` (re-resolve an activated skill's `allowed-tools`, piece 3),
    and the new `validateFrontmatter` helper (piece 2). Only `skill_create` is
    *edited in place* (to call `validateFrontmatter`); the `skill_read`/`/skills`
    registrations and the tier-1 `transformContext` are left as-is — the new
    file's own hooks compose over them (the trigger gate is a later
    `transformContext` pass, §6). (`slug`/`renderSkill` stay module-private —
    `skills-hardening` does not need them.)
  - `detectSuspiciousDescription` from `src/extensions/mcp.ts:135` — already
    exported; imported as-is.
  - The `descBaseline` store pattern from `src/extensions/integrity.ts:54-69`
    (under a parallel `skillBodyBaseline` key), with a **local re-implementation**
    of its 4-line djb2 `fingerprint` (`integrity.ts:36-40`) — that function is
    module-private to `integrity.ts`, so it is copied, not imported (D1/D2); no
    edit to `integrity.ts`.
  - `triggered` + `latestUserText` from `src/extensions/microagents.ts:77,96` —
    already exported; imported as-is.
  - The `beforeToolCall` ask/deny + `tool_end`/`session_start`/`session_shutdown`
    lifecycle pattern from `src/extensions/write-guard.ts`.
  - Hook/event surface from `src/kernel/events.ts` and `ExtensionAPI`
    (`src/kernel/extension.ts:41-78`): `e.on`, `e.hook`, `e.store`, `e.log`,
    `e.agent.tools.get/list`, `e.agent.ui.confirm`, `e.grantCapability`,
    `e.registerCommand`.
- **Assumptions:**
  - `EAGENT_SKILLS_DIR` (or `~/.eagent/skills`) is the skills root (`skills.ts:33`);
    folders contain a top-level `SKILL.md`.
  - `skill_read` is the activation act for a session (D3); its `tool_end` fires
    on success with `call.arguments.name` identifying the skill.
  - Frontmatter uses the existing single-line `key: value` convention
    (`skills.ts:155-166` / `microagents.ts:50-54`); `allowed-tools` and
    `triggers` are comma-separated single-line lists, parsed identically to
    `microagents`' `triggers`.
  - No new runtime dependency; pure Node, strict TS
    (`noUncheckedIndexedAccess`, no `any`), ESM `.js` import specifiers.
  - All side-effecting tools remain gated by the *existing* capabilities; this
    extension adds none.

## 6. Relationship with Existing Designs

- **Closest surfaces (hardened, not replaced):**
  - `src/extensions/skills.ts` — `scanSkills` (134), `skill_create` (86),
    tier-1 `transformContext` (43), `/skills` (118), `skillsRoot`/
    `EAGENT_SKILLS_DIR` (33). This is the surface being hardened by pieces (2)
    and (4) and the activation source for (3).
  - `src/extensions/integrity.ts` — read as the **template** for piece (1), not
    edited: its `session_start` sweep (71), its use of the `mcp`-exported
    `detectSuspiciousDescription` detector (25), and its `fingerprint`/
    `descBaseline` rug-pull machinery (36, 28, 54-83). Piece (1) builds a
    *parallel* body/script sweep in `skills-hardening.ts` (its own
    `skillBodyBaseline` store key, a local copy of the djb2 `fingerprint`) rather
    than extending `integrity`'s — `integrity`'s only export is `activate`, so its
    internals cannot be imported and `integrity.ts` stays untouched (D1/D2, §8).
  - `src/extensions/microagents.ts` — `triggered` (77) / `latestUserText` (96),
    already named exports, imported and reused verbatim by piece (4).
  - `src/kernel/capabilities.ts` — the ask/deny vocabulary (14-17, 85-120) reused
    (not extended) by piece (3)'s `beforeToolCall` enforcement.
  - `src/extensions/write-guard.ts` — the structural template for D3: a
    `beforeToolCall` ask/deny over session-scoped state tracked via `tool_end`
    and reset on `session_start`/`session_shutdown`.
- **Deduplication (why this is not redundant):**
  - `integrity` guards only tool **descriptions**; it never reads a SKILL.md body
    or a script — piece (1) covers that surface with a *parallel* sweep in the new
    file (modeled on `integrity`, but not editing it), reaching what `integrity`
    bypasses today.
  - `microagents` triggers a **separate** directory of `*.md` files
    (`microagentsDir`, `microagents.ts:180`), not the skills catalog — piece (4)
    applies the same matcher to the *skills* tier-1 line, which `microagents`
    never touches.
  - The capability layer exists but is **not wired to skills**; piece (3) is the
    first connection between an active skill's `allowed-tools` and the dispatcher.
- **Conflicts:** none expected. Tier-1 gating runs as the new file's **own**
  later `transformContext` pass that only *narrows* (strips the gated lines from)
  what `skills.ts` already injected — it never edits `skills.ts`'s hook — and is
  opt-in + killable, so it cannot regress a trigger-less skill.
  The body scan is additive warn-only and shares `integrity`'s store namespace
  pattern under a *distinct* key (`skillBodyBaseline`), so it cannot corrupt
  `integrity`'s `descBaseline`. The `beforeToolCall` scoping composes with
  `write-guard`/`flow-guard`/`bash-policy` filters (each returns the threaded
  `ToolDecision`; `block:true` short-circuits via the kernel's `shouldStop`,
  `hooks.ts:93-107`).
- **First-design note:** not a first design — this hardens four established
  extensions; it is a composition over existing detectors, not a new primitive.

## 7. Acceptance Criteria

Each is a runnable assertion in `test/skills-hardening.test.ts`, offline, against
`MockProvider` via `makeHarness`, using a temp `EAGENT_SKILLS_DIR`.

1. **Body scan fires on a poisoned body.** Write a skill whose `SKILL.md` body
   contains a `detectSuspiciousDescription` marker (e.g. `ignore all previous
   instructions`) or a new pattern (`child_process.exec`, `curl … | sh`,
   `process.env.AWS_SECRET…` near an `http`/`fetch` token). Capture `e.log.warn`
   via a recording `Logger`; assert ≥1 warn naming the skill and the marker(s).
   `assert.match(warned, /poison|suspicious|risky body|<marker>/i)`.
2. **Body scan is warn-only.** After the poisoned-body sweep, assert
   `skill_read` for that skill still succeeds (result `!isError`) and the catalog
   still lists it — `assert.equal(result.isError, undefined/false)`.
3. **Body rug-pull is detected across sessions.** Sweep once (records the body
   fingerprint), mutate the body bytes, sweep again; assert a warn matching
   `/changed since the last (session|scan)/i` for that skill, and no such warn on
   an unchanged body.
4. **Script scan flags a referenced script.** Place a sibling script (e.g.
   `run.sh` with `curl … | sh` / `eval $(…)`) in the skill folder; assert the
   sweep warns naming the script path and the marker.
5. **Frontmatter validator rejects bad fields.** Unit-call the exported
   `validateFrontmatter`: a `name` with uppercase/spaces, a `name` >64 chars, an
   empty `description`, a `description` containing `<`, and an unknown key each
   yield a non-empty error list; a clean `{name,description}` yields `[]`.
   `assert.deepEqual(validateFrontmatter(good), [])` and
   `assert.ok(validateFrontmatter(bad).length > 0)`.
6. **`skill_create` enforces the validator.** Drive the agent to `skill_create`
   with a description containing `<script>`; assert no `SKILL.md` is written
   (`existsSync(...) === false`) and the tool result is an error mentioning the
   rejected field. (Valid input still writes, proving back-compat.)
7. **`/skills` surfaces validation findings.** With one invalid hand-written
   skill folder present, run the `/skills` command and assert the printed output
   flags the invalid skill (`assert.match(printed, /invalid|unknown key|too
   long/i)`), while valid skills still list.
8. **allowed-tools scoping asks/denies an out-of-list tool.** Create a skill with
   `allowed-tools: read`. Drive: `skill_read` that skill, then a `bash` call.
   With `ui.confirm => false`, assert the `bash` tool call is blocked (a tool
   message matching `/skills-hardening: blocked|not in .* allowed-tools/i`); with
   `ui.confirm => true`, assert it proceeds.
9. **Scoping is a no-op without allowed-tools (back-compat).** A skill with **no**
   `allowed-tools`: after `skill_read`, a `bash` call runs with **no** confirm
   prompt and no block. `assert.equal(confirmCalls, 0)`.
10. **Scoping is a no-op for a skill never activated.** A skill declaring
    `allowed-tools: read` exists but is never `skill_read`; a `bash` call runs
    unprompted. (Proves activation is session-scoped, not catalog-wide — D3.)
11. **Trigger gating hides a non-matching skill's tier-1 line.** A skill with
    `triggers: kubernetes`. On a user turn `"hello"`, assert the tier-1 catalog
    note injected into `req.messages` does **not** contain that skill's name; on
    `"deploy to kubernetes"`, assert it **does** (whole-word, reusing
    `triggered`).
12. **Trigger gating respects `EAGENT_SKILL_TRIGGERS=off`.** With the env var set,
    the triggered skill's line appears regardless of the user message (reverts to
    always-on). Restore the env var after.
13. **Trigger-less skills are always injected (back-compat).** A skill with no
    `triggers:` appears in tier-1 on any user message, gating on or off.
14. **Dispose loop never throws and unregisters cleanly.** After
    `host.use("skills-hardening", …)` then unload, assert the `beforeToolCall`,
    `tool_end`, `session_start`, and `transformContext`-affecting hook counts via
    `agent.hooks.listenerCount` return to their pre-load values, and unload does
    not throw.

## 8. Risks and Rollback

- **Body-scan false positives on legitimate example code.** A skill that teaches
  `curl`/`eval`/`exec` trips the markers. *Mitigation:* warn-only (D2) — the
  skill still loads; a human reviews. No execution is blocked by this extension.
- **Allowed-tools scoping needs reliable active-skill state.** If `skill_read`'s
  `tool_end` is missed (e.g. an error), the skill is simply not marked active and
  scoping no-ops for it (fail-open, never fail-closed onto an unrelated tool).
  *Mitigation:* state is session-scoped, reset on `session_start`/
  `session_shutdown` (D3), and only populated on a *successful* `skill_read`.
- **Trigger gating could hide a skill the user wanted.** *Mitigation:* opt-in per
  skill via `triggers:` frontmatter; trigger-less skills stay always-on (D5).
  Globally revertable via the kill switch below.
- **Store-key collision with `integrity`.** *Mitigation:* the body baseline uses
  a distinct store key (`skillBodyBaseline`), never `integrity`'s `descBaseline`.
- **Composition with other `beforeToolCall` guards.** The scoping filter returns
  the threaded `ToolDecision` and sets `block:true`/`reason` only on a denied
  ask, so it composes with `write-guard`/`flow-guard`/`bash-policy` without
  reordering assumptions (kernel `shouldStop` short-circuits on the first block,
  `hooks.ts:93-107`).

**Rollback / kill switches:**

- `EAGENT_SKILL_TRIGGERS=off` — disables trigger gating; tier-1 reverts to
  always-on for all skills (piece 4).
- Pieces (1) scan, (2) validation, (3) scoping are **additive**: not loading
  `skills-hardening.ts` (or reverting its registrations) restores exact prior
  runtime behavior of `skills`/`integrity`, since all four hooks live in the new
  file. `integrity.ts` is **not edited at all** (piece 1 copies its djb2 hash
  locally — D2). The only edited existing file is `skills.ts`, whose diff is two
  kinds of change: (i) **new named exports** of helpers the new file imports
  (`scanSkills`, `skillsRoot`, `parseFrontmatter`, `validateFrontmatter`) — these
  are pure additions that change no existing behavior and are inert if the new
  file is absent; and (ii) **one behavioral call site** — `skill_create` invoking
  `validateFrontmatter` to reject invalid frontmatter at the authoring boundary,
  guarded so that removing that one call restores the old accept-anything path.
  So the *behavioral* rollback footprint in `skills.ts` is the single
  `skill_create` guard; the rest of the `skills.ts` diff is export-only.
- Each of the four is independently killable (D6); no piece's misfire forces the
  others off.
