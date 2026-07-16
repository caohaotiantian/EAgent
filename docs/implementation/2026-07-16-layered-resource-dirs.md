# Implementation — Layered resource resolution: home + project, project wins

Slug: `2026-07-16-layered-resource-dirs`
Design: `docs/design/2026-07-16-layered-resource-dirs.md`
Status: draft

## 1. Task Index (Deliverable / AC → design location)

All references are to `docs/design/2026-07-16-layered-resource-dirs.md`.

| Item | Design §2 | Design §7 AC | Design KDD |
| --- | --- | --- | --- |
| D1 shared layered-merge helper | D1 | AC5 | KDD2, KDD4 |
| D2 templates layered | D2 | AC1-3 | KDD1, KDD2 |
| D3 teams layered (+ rewire `teams.ts:610`/`:689`) | D3 | AC6 | KDD2 |
| D4 skills layered | D4 | AC1-3 | KDD1 |
| D5 microagents layered (+ home tier) | D5 | AC1-3 | KDD1 |
| D8 official library opt-in (remove overrides) | D8 | AC7 | KDD5 |
| D6 tests / D7 docs | D6, D7 | AC1-8 | — |

`<TEST-CMD>` = `npm test`. `<GATES>` = `npm run typecheck` + `npm run typecheck:test`
+ `npm run eval` + `npm run build`. Single-file: `node --import tsx --test test/<file>.test.ts`.

## 2. Phase Breakdown

Four phases, dependency-ordered. `npm test` fully green at every boundary. No kernel
change in any phase (all work in `src/extensions/`).

---

### Phase 1 — The shared layered-merge helper (D1)

The foundation every resource type delegates to.

- **Entry condition:** branch `chore/layered-resource-dirs` at the L1-approved state;
  `npm test` green.
- **Design references:** §2 D1, KDD2 (Map home-then-project last-wins), KDD4 (helper
  is scan-agnostic — takes a `scanOne` thunk, never parses/validates), AC5.
- **Task list (TDD order):**
  1. **T1.1 (test, RED)** — create `test/resource-dirs.test.ts`. Assert:
     `loadLayered(["a","b"], scanOne)` where `scanOne` returns `[{name:"x",v:1}]` for
     dir `a` and `[{name:"x",v:2},{name:"y"}]` for `b` → returns the **`b`** entry for
     `x` (last-wins) plus `y`, name-sorted (invariant: **project (later dir) wins on
     name collision; union of names; stable name sort**). Also: `resourceDirs(config,
     "templates")` with no override returns `[~/.eagent/templates,
     <cwd>/.eagent/templates]` (home first); with `templates.dir` set returns
     `[thatDir]` (single-source); `resourceDirs(config,"microagents")` project root
     honors `config.string("workspace") ?? cwd`.
  2. **T1.2 (impl, GREEN)** — create `src/extensions/lib/resource-dirs.ts`:
     - `resourceDirs(config, kind: "templates"|"teams"|"skills"|"microagents"):
       string[]` — if `config.string(\`${kind}.dir\`)` is
       set, return `[thatDir]`; else return `[homeRoot(kind), projectRoot(kind)]`
       where `homeRoot = join(homedir(), ".eagent", kind)` and `projectRoot =
       join(kind === "microagents" ? (config.string("workspace") ?? process.cwd())
       : process.cwd(), ".eagent", kind)`. (Templates/teams/skills project root =
       cwd; microagents preserves its workspace root.)
     - `loadLayered<T extends {name:string}>(dirs, scanOne: (dir)=>T[]): T[]` —
       `const m = new Map<string,T>(); for (const d of dirs) for (const r of
       scanOne(d)) m.set(r.name, r); return [...m.values()].sort((a,b)=>
       a.name.localeCompare(b.name))`. Home inserted first so project overwrites.
     - ESM: `import { homedir } from "node:os"; import { join } from "node:path";
       import type { Config } from "../../kernel/store.js";` — the `Config` interface
       is declared in `src/kernel/store.ts` and imported by `templates.ts:40` (NOT
       `src/config.ts`, which only re-imports it).
- **Per-task acceptance commands:**
  - `node --import tsx --test test/resource-dirs.test.ts`
  - `npm run typecheck && npm run typecheck:test`
  - `npm test`
- **Exit condition:** helper exists + unit-tested (last-wins, dir resolution, override
  short-circuit); `npm test` green; no other file changed yet.

---

### Phase 2 — Templates + teams layered (D2, D3)

Grouped: teams resolves members against the templates catalog, so both move together.

- **Entry condition:** Phase 1 committed; `npm test` green.
- **Design references:** §2 D2, D3, KDD1 (override=single-source default=layered),
  KDD2, AC1-3, AC6.
- **Task list (TDD order):**
  1. **T2.1 (test, RED)** — in `test/templates.test.ts`, add layered tests (isolate
     `process.env.HOME`→tempH and cwd→tempP via temp dirs): (a) a template only in
     `tempH/.eagent/templates` is listed; (b) only in `tempP/.eagent/templates` is
     listed; (c) same `name` in both → the project one resolves (assert a
     distinguishing `description`); (d) with `EAGENT_TEMPLATES_DIR` set, only that dir
     loads (regression pin — preserves existing isolation). Invariant: templates
     resolve from home+project, project-wins, unless overridden to single-source.
  2. **T2.2 (test, RED)** — in `test/teams.test.ts` (AC6): a member template present
     only in the **project** tier resolves when the team file is in **home** (proves
     the templates→teams flow through the rewired catalog). Isolate HOME+cwd.
  3. **T2.3 (impl, GREEN)** — templates: rewire **all three** template-catalog builds
     in `templates.ts` — `:424` (the `transformContext` catalog inject), `:464`
     (`spawn_template`), `:497` (`/template` command) — from
     `scanTemplates(templatesRoot(e.config), …)` to
     `loadLayered(resourceDirs(e.config, "templates"), (d)=>scanTemplates(d, warn))`
     (factor a small `layeredTemplates(config, warn)` helper — **export it from
     `templates.ts`** so teams reuses it, mirroring teams' existing peer import of
     `scanTemplates`/`templatesRoot` from `templates.js` at `teams.ts:50-52`).
     **No test covers `spawn_template` (`:464`) seeing project-tier templates, so a
     missed site would NOT go red — wire all three.** Keep `scanTemplates(dir, warn)`
     and `templatesRoot(config)` unchanged (pure single-dir primitives the tests call).
  4. **T2.4 (impl, GREEN)** — teams: rewire **both** template-catalog builds
     (`teams.ts:610`, `:689`) to the layered templates loader (reuse the P2 T2.3
     helper) — `/team show` at `:689`, like `spawn_template`, has **no asserting
     test**, so wire it regardless — AND **both** team-catalog builds (`teams.ts:612`,
     `:671` —
     `scanTeams(teamsRoot(e.config), …)`) to
     `loadLayered(resourceDirs(e.config,"teams"), (d)=>scanTeams(d, warn))`. Keep
     `scanTeams`/`teamsRoot` primitives unchanged.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/templates.test.ts`
  - `node --import tsx --test test/teams.test.ts`
  - `npm run typecheck && npm test`
- **Exit condition:** templates + teams resolve layered (project-wins), teams member
  resolution sees project-tier templates, override still single-source; `npm test` green.

---

### Phase 3 — Skills + microagents layered (D4, D5)

- **Entry condition:** Phase 1 committed; `npm test` green.
- **Design references:** §2 D4 (read only; write path UNCHANGED), D5 (add home tier),
  KDD1, AC1-3.
- **Task list (TDD order):**
  1. **T3.1 (test, RED)** — `test/skills.test.ts`: home-only skill listed;
     project-only skill listed; same folder `name` in both → project wins; override
     (`EAGENT_SKILLS_DIR`) = single-source (regression). Isolate HOME+cwd. **Do NOT
     change the write path** — `skill_create` still writes to `skillsRoot`.
  2. **T3.2 (test, RED)** — `test/microagents.test.ts`: a microagent only in
     `tempH/.eagent/microagents` (home — NEW tier) is now injected/listed; the
     existing project tier still works; override = single-source (preserve the
     existing "no microagents" empty-override test at `:196-199` — it sets the
     override so it stays single-source). Isolate HOME+cwd.
  3. **T3.3 (impl, GREEN)** — skills: the read catalog resolves via
     `loadLayered(resourceDirs(e.config,"skills"), scanSkills)` (note `scanSkills` has
     no `warn` param — pass it directly). Keep `skillsRoot`/`scanSkills` and the
     `skill_create` write to `skillsRoot` unchanged.
  4. **T3.4 (impl, GREEN)** — microagents: rewire **both** scan sites —
     `microagents.ts:194` (activate-time cache fill) and `:204` (`/microagents`
     re-scan) — to `loadLayered(resourceDirs(e.config,"microagents"), scanMicroagents)`.
     This adds the `~/.eagent/microagents` home tier to the existing workspace project
     root. Preserve the cache behavior (re-scan on `/microagents`).
- **Per-task acceptance commands:**
  - `node --import tsx --test test/skills.test.ts`
  - `node --import tsx --test test/microagents.test.ts`
  - `npm run typecheck && npm test`
- **Exit condition:** skills + microagents resolve layered home+project (project-wins);
  microagents gains its home tier; skill write path unchanged; `npm test` green.

---

### Phase 4 — Official library opt-in + docs (D8, D7)

- **Entry condition:** Phases 1-3 committed; `npm test` green.
- **Design references:** §2 D8, D7, KDD5, AC7.
- **Task list (TDD order):**
  1. **T4.1 (test, RED)** — `test/templates.test.ts` (or a small new test): with no
     override and `HOME`→tempH + cwd→tempP both empty, the templates catalog is
     **empty** (`library/` not auto-loaded); after copying `library/templates/*` into
     `tempP/.eagent/templates`, they appear (AC7). Confirms opt-in.
  2. **T4.2 (impl, GREEN)** — **delete** `eagent.config.json` (it holds only the four
     resource-dir override keys; `loadConfigFile`'s `existsSync` guard makes its
     absence a no-op; the `host.ts` repo-root config path support stays). Confirm no
     eval/test regresses (the L1 review verified none reference `library/`).
  3. **T4.3 (docs)** — `library/README.md`: present `library/` as the committed
     **opt-in official library**; replace the "auto-loaded via `eagent.config.json`"
     wording with the opt-in install path (copy `library/<kind>/*` into
     `~/.eagent/<kind>` or `<cwd>/.eagent/<kind>`). `README.md` + `CLAUDE.md`: document
     the layered home+project resource model (project-wins; `<kind>.dir` override =
     single-source) alongside the existing plugin/config layering.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/templates.test.ts`
  - `npm test`
  - `npm run typecheck && npm run typecheck:test && npm run eval && npm run build`
- **Exit condition:** `library/` is opt-in (not auto-loaded), `eagent.config.json`
  deleted, docs updated; AC7 green; all `<GATES>` green.

## 3. Engineering Constraints Index

- **Project norms** — CLAUDE.md _House conventions_: ESM + NodeNext (`.js`
  specifiers even for `.ts`); strict TS, no `any`; zero runtime deps except `jiti`
  (helper uses only `node:os`/`node:path`); a helper shared by ≥2 extensions lives in
  `src/extensions/lib/` (not imported peer-to-peer); each extension keeps its offline
  tests. **No kernel change** — `src/kernel/` untouched, so no line-ceiling concern.
- **Precedents to mirror** — `host.ts:319-327` discover `[home, project]` later-wins;
  `extension.ts:218-228` id-collision teardown; `config.ts:205-221` `loadConfigFile`
  last-wins. The helper is the `.md`-resource analogue.
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — SKILL.md: `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`;
  `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; **no AI/model/tooling attribution**.

## 4. Data and Fixture Dependencies

- **Reuse:** the existing per-extension test harnesses (`templates.test.ts`,
  `teams.test.ts`, `skills.test.ts`, `microagents.test.ts`) — they already create temp
  resource dirs and set `EAGENT_*_DIR`; the new layered tests extend that pattern and
  additionally set `process.env.HOME`→tempH (restored in `finally`) to isolate the
  home tier. `MockProvider` for any end-to-end resolution driven through an agent.
- **New fixtures/files:** `src/extensions/lib/resource-dirs.ts` (D1),
  `test/resource-dirs.test.ts` (D1). No external data.
- **Deleted:** `eagent.config.json` (D8).

## 5. Regression Protection

- **Every Phase:** full `npm test` green; no kernel file touched.
- **Phase 2/3:** the existing `EAGENT_*_DIR` override tests
  (`templates.test.ts`, `teams.test.ts`, `skills.test.ts`, `microagents.test.ts:196-199`
  "no microagents") MUST stay green — they set an override, which stays single-source
  (KDD1), so layering must not perturb them. `config-backcompat.test.ts:30`
  (`EAGENT_TEAMS_DIR`→`teams.dir`) must stay green — the `<kind>.dir` key is unchanged.
  The pure `scan*(dir)` tests (`templates.test.ts:136-156`, etc.) must stay green —
  the primitives keep their single-dir signature.
- **Phase 3:** `skill_create` write-path tests (`skills.test.ts`,
  `skills-hardening.test.ts`) stay green — write path unchanged.
- **Phase 4:** `npm run eval` 5/5 and `docs-drift.test.ts` stay green — neither
  depends on `library/` auto-loading (L1-verified); deleting `eagent.config.json` is a
  no-op for `loadConfigFile`.
- **Home-bleed guard (R1):** every NEW layered test sets `process.env.HOME` to a temp
  dir; a test that reads the default (no override) without isolating HOME is a defect.
- **Do NOT "fix" the empty-catalog display messages.** `templates.ts:502`,
  `teams.ts:676`, `microagents.ts:206`, `skills.ts:132` print `(no X in <root>)` via
  the retained single-dir `*Root(config)` and so name only one of the two scanned
  dirs when empty. This is cosmetic (shown only when empty) and intended — leaving
  the primitives single-dir is deliberate; do not rewire these display calls.
