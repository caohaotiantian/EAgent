# Design — Layered resource resolution: home + project, project wins

Slug: `2026-07-16-layered-resource-dirs`
Status: draft

## 1. Background and Purpose

EAgent's ecosystem resources (recipes/templates, teams, skills, microagents) are
raw files the engine reads at runtime. Today each type reads a **single**
directory, and the defaults are **inconsistent**:

- `templates` → `~/.eagent/templates` (home) (`templates.ts:87-89`)
- `teams` → `~/.eagent/teams` (home) (`teams.ts:130-132`)
- `skills` → `~/.eagent/skills` (home) (`skills.ts:33-35`)
- `microagents` → `<workspace>/.eagent/microagents` (**project/cwd**) (`microagents.ts:181-186`)

Meanwhile **plugins (extensions) and config already read BOTH tiers**, project
winning: `host.discover([~/.eagent/extensions, <cwd>/.eagent/extensions])` with a
later-wins id-collision teardown (`host.ts:319-327`, `extension.ts:218-228`), and
`loadConfigFile([~/.eagent/config.json, <cwd>/eagent.config.json, <cwd>/.eagent/config.json])`
last-wins (`config.ts:201-221`).

**Goal (user's confirmed rule):** *"all can be read from home and project, combine
them, and project wins if there are conflicts."* Make every `.md`-directory resource
type resolve from **both** `~/.eagent/<kind>` (home / global) and
`<cwd>/.eagent/<kind>` (project / local), merged by name, **project-wins** — exactly
like plugins and config already do. This is the engine half of the larger goal:
split the immutable compiled CLI binary (kernel + built-ins) from a raw,
home-and-project-layered, self-extensible resource tree.

If we do nothing: recipes/skills/teams can only live in one place (home), so a
project can't ship its own experts alongside the user's global ones, and the
resource surface stays inconsistent with the plugin/config surface.

## 2. Deliverables

- [ ] **D1 — shared layered-merge helper** `src/extensions/lib/resource-dirs.ts`:
      (a) `resourceDirs(config, kind)` returns the ordered dir list to read for a
      kind — `[homeRoot, projectRoot]` (home first, project last), OR a single
      `[overrideDir]` when `config.string("<kind>.dir")` is set; (b) a generic
      `loadLayered(dirs, scanOne)` that runs the existing single-dir scanner over
      each dir and merges results into a `Map` keyed by resource `name`,
      **inserting home then project so project overwrites (last-wins)**, returning a
      name-sorted list. Mirrors `resolveTemplate`'s `new Map(catalog…)` last-wins
      (`templates.ts:241`) and the `discover`/`loadConfigFile` precedent.
- [ ] **D2 — templates layered** — `templatesRoot`/`scanTemplates` stay as the
      single-dir primitives (tests call them directly); the templates extension's
      activate path resolves the layered catalog via D1.
- [ ] **D3 — teams layered** — same treatment for `scanTeams`/`teamsRoot`. Teams
      does **NOT** inherit template layering for free: `teams.ts:610` (and the
      `/team show` path at `:689-690`) call `scanTemplates(templatesRoot(...))` on a
      **single** dir, so D3 must **explicitly rewire** those template-catalog builds
      to the layered template loader for a project-tier member template to resolve
      (AC6 depends on this).
- [ ] **D4 — skills layered** — the read path (`scanSkills`) resolves the layered
      skill catalog via D1. The `skill_create` **write path is unchanged** (writes to
      `skillsRoot` = home, or the override dir); home is one of the two read layers,
      so a home-written skill is still discovered — no write change is needed for
      this read feature. (Aligning the write target to the project tier is a separate
      follow-on, out of scope — see §3.)
- [ ] **D5 — microagents layered** — add the **home** tier
      (`~/.eagent/microagents`) to the current project/workspace default so it too is
      home+project (the inverse gap). Preserve the `workspace`-based project root.
- [ ] **D6 — tests** — offline tests: (a) a resource present only in home loads;
      (b) only in project loads; (c) same `name` in both → project wins; (d) an
      explicit `<kind>.dir` override reads only that dir (single-source preserved);
      (e) the D1 merge helper unit-tested directly. New layered tests **isolate both
      HOME and cwd** to temp dirs so a dev's real `~/.eagent/*` cannot bleed in.
- [ ] **D7 — docs** — README/CLAUDE.md/`library/README.md`: document the layered
      home+project model, project-wins, that an explicit `<kind>.dir` override is
      single-source, and (per D8) that `library/` is the opt-in official library.
- [ ] **D8 — official library becomes opt-in (KDD5)** — remove the resource-dir
      override keys (`templates.dir`/`teams.dir`/`microagents.dir`/`skills.dir`) from
      the committed `eagent.config.json` so the auto-loaded tiers are the standard
      home+project (D1); `library/` stays as the committed opt-in official library.
      Update `library/README.md` to present `library/` as opt-in and document
      installing it into a tier (copy `library/<kind>/*` into `~/.eagent/<kind>` or
      `<cwd>/.eagent/<kind>`). Confirm no repo gate (`eval`/test) depended on
      `library/` auto-loading. **Delete** the now-empty `eagent.config.json` (it held
      only those four keys; `loadConfigFile`'s `existsSync` guard makes its absence a
      no-op, and the `host.ts` repo-root config-path support stays for future keys).

## 3. Scope Boundary (NOT in scope)

- **No kernel change.** All work is in `src/extensions/` + the new `lib/` helper.
  `host.discover`/`extension.ts`/`config.ts` (the precedents) are read, not changed.
- **Packages are NOT layered.** `packages` has no dir-of-`.md` catalog — it is a
  store-backed registry keyed by id (`packages.ts:88,154`), materialized/loaded via
  jiti. Home+project `.md` merging does not apply; leaving it single-dir is the
  Simplicity-First choice. (Its `packages.dir` remains a single dir.)
- **Explicit `<kind>.dir` stays single-source (replace, not add).** Setting the
  override reads ONLY that dir — backward-compatible and required to keep the
  existing `EAGENT_*_DIR` temp-dir isolation tests green. Layering is the **default**
  (no-override) behavior. See KDD1.
- **The `<kind>.dir` config key is unchanged** — still a single string
  (`config.string("<kind>.dir")`), preserving `config-backcompat.test.ts:30`.
- **The pure `scan*(dir)` functions keep their single-dir signature** — layering is
  a new wrapper *above* them, so the pure-scan tests (`templates.test.ts:136-156`,
  etc.) are untouched.
- **No write-target changes.** `write_extension` already writes to the project tier
  (`self.ts:34-39`); `skill_create` keeps writing to `skillsRoot` (home / override).
  Aligning `skill_create` to write to the project tier (the "extended by EAgent"
  promotion loop) is a deliberate, separate change deferred to a follow-on — this
  cycle is **read-layering only**.
- **No latency/throughput budget declared.** `skills`/`templates`/`microagents`
  already scan their directory on the per-turn `transformContext` path; layering
  adds at most **one extra directory scan** per resource per turn (microagents
  already caches its scan). The added cost is bounded (one extra `readdirSync` +
  its file reads) and not measured as a budget here.
- **No `/library install` command** — the opt-in install of the official library
  into a tier is documented (copy) this cycle; a convenience command is a fast-follow.
- **No binary/packaging work** — producing the immutable single-file binary and a
  `~/.eagent` seed/install script is a separate follow-on (prototyped already), not
  this functional change.
- **No change to merge *ordering within a tier*** beyond de-dupe — files within one
  dir keep today's behavior.

## 4. Key Design Decisions

### KDD1 — Override semantics: layered default, single-source override
- **Problem:** when `<kind>.dir` (config/env) is set, does it (A) replace the
  layered pair with that one dir, or (B) become an additional layer combined with
  home+project?
- **Options:** (A) replace — override reads only that dir; layering happens only
  when no override; (B) additive — always read `[home, override?, project]`.
- **Choice: (A).** Every existing resource test sets `EAGENT_<KIND>_DIR` to an
  isolated temp dir and asserts isolation (`templates.test.ts:316…`,
  `microagents.test.ts:196-199` asserts "no microagents" pointing at an empty dir).
  Under (B) those tests would ALSO read the dev machine's real `~/.eagent/<kind>`
  and flake/break (home bleed). (A) preserves them, is backward-compatible (an
  override remains a deliberate single-source), and still delivers the user's rule
  as the **default** (no override → `[home, project]` merged, project-wins).
  **Reject (B):** breaks test isolation and surprises anyone who set an override
  expecting one source; the "combine everything" behavior it adds is available via
  the default path anyway.
- Consequence for this repo: D8 **removes** this repo's `eagent.config.json`
  resource-dir overrides (KDD5), so the repo runs the layered default (home +
  project) and `library/` becomes the opt-in official library. An override remains
  available to any user who deliberately wants a single source.

### KDD2 — Merge mechanics: Map keyed by name, home-then-project, last-wins
- **Problem:** `scanTemplates`/`scanTeams` end with a trailing `.sort()` and do **no
  de-dupe** (`templates.ts:229`, `teams.ts:260`), so a naive `[...home, ...project]`
  concat then scan loses project-precedence.
- **Options:** (a) concat dir contents then scan (loses ordering — wrong); (b) scan
  each dir separately, then merge the parsed results into a `Map` keyed by resource
  `name`, inserting home first and project second so project overwrites; (c) teach
  each scanner to accept a dir list.
- **Choice: (b).** Scan each tier with the **existing single-dir** `scanOne`
  primitive, then `loadLayered` merges: `const m = new Map(); for (const dir of
  dirs) for (const r of scanOne(dir)) m.set(r.name, r)` → `[...m.values()].sort(by
  name)`. This mirrors `resolveTemplate`'s `new Map(catalog.map(...))` last-wins
  (`templates.ts:241`) and the `extension.ts` id-collision "later wins" precedent
  (`:218-228`). **Reject (a):** the trailing sort scrambles precedence. **Reject
  (c):** changes the pure `scan*(dir)` signature → breaks the pure-scan tests and
  couples the primitive to layering; a wrapper is cleaner (Simplicity/Surgical).
- **Merge key = frontmatter `name` (filename fallback)** for all four types —
  already how each scanner names entries (`templates.ts:130`, `teams.ts:168`,
  `skills.ts:153`, `microagents.ts:67`).
- **Within-tier de-dupe is an intended consequence:** the Map merge also collapses
  two files sharing a frontmatter `name` *within one tier* to a single entry
  (today both are listed by `/template list` etc.). This matches `resolveTemplate`'s
  existing `new Map(catalog…)` (`templates.ts:241`) — a duplicate name was already
  unusable at resolve time; now it is also de-duped in listings. No test asserts
  duplicate-name listing (verified).

### KDD3 — Scope: the four `.md`-dir resources; not packages
- **Problem:** does "every resource type" include packages?
- **Choice: templates, teams, skills, microagents only.** These are dir-of-`.md`
  catalogs with the same scan shape. `packages` is a **store-registry** keyed by id,
  with git/npm materialization + jiti loading and a tamper guard tying entries to
  `packagesDir` (`packages.ts:88,154,233-241`) — home+project `.md` merging is
  meaningless for it, and layering it would fight its registry model. **Reject
  including packages:** speculative scope against a mechanism that doesn't fit
  (Simplicity First). Plugins (extensions) already layer via `discover`.

### KDD4 — Warn discipline in the shared helper
- **Problem:** templates/teams pass a `warn` callback and warn on invalid files
  (`templates.ts:224`, `teams.ts:255`); skills/microagents silently skip
  (`skills.ts:154`, `microagents.ts:169`). The helper wraps all four.
- **Choice:** the helper is **agnostic** — it takes a `scanOne(dir) => Resource[]`
  thunk and never parses/validates itself, so each extension keeps its own
  scan+warn behavior unchanged. The helper only resolves dirs and merges by name.
  **Reject** unifying warn behavior here: that is an orthogonal cleanup (Surgical
  Changes — mention, don't fold in).

### KDD5 — The "official library" is opt-in; auto-load is home+project (USER DECISION)
- **Decision (user, resolving the escalated C1):** move the auto-load model to the
  standard home+project `.eagent` tiers "like others" (plugins/config), and keep a
  committed repo subdirectory as the curated **official library** that users *choose
  to use or not* — not auto-loaded.
- **Concretely:**
  - **Auto-loaded tiers** = `~/.eagent/<kind>` (home) + `<cwd>/.eagent/<kind>`
    (project), layered, project-wins (D1-D6). A fresh clone / fresh `~/.eagent`
    auto-loads only what the user has put in those tiers — nothing by default.
  - `library/` stays as the committed **official library** (the canonical curated
    catalog of recipes/teams/skills/microagents/prompts) but is **NOT auto-loaded**:
    D8 removes the `eagent.config.json` resource-dir override keys that currently pin
    the auto-loaded dirs to `./library/*`.
  - **Opt-in:** a user enables the official library by installing it into a tier —
    copying `library/<kind>/*` into `~/.eagent/<kind>` (global) or
    `<cwd>/.eagent/<kind>` (project). This cycle **documents** that path (D7); a
    `/library install [--home|--project]` convenience command is a noted fast-follow,
    **out of scope here**.
- **Consequence (flagged behavior change):** a fresh repo clone now auto-loads **no**
  recipes until the user opts in — deliberately reversing the library PR's
  auto-load-via-override. This is the user's chosen model (official library =
  opt-in), not a regression.
- **Rejected:** (A) keep auto-loading `library/` via the overrides — contradicts the
  opt-in decision; (B) physically move/duplicate `library/*` into committed
  `./.eagent/*` — the opt-in copy achieves the same without a canonical duplicate or
  a `.gitignore` change.

## 5. Dependencies and Assumptions

- **Precedents to mirror (verbatim):** `host.ts:319-327` dirs `[home, project]` +
  comment "later registration wins on an id collision"; `extension.ts:218-228`
  id-collision teardown (later wins); `config.ts:201-221` `loadConfigFile` last-wins
  over `[home, …, project]`.
- **Scanners (verbatim):** each reads one dir, keys by frontmatter `name` (filename
  fallback), no de-dupe: `scanTemplates` `templates.ts:205-230`, `scanTeams`
  `teams.ts:236-261`, `scanSkills` `skills.ts:140-159`, `scanMicroagents`
  `microagents.ts:155-174`. `teams` member resolution: `resolveTeam` →
  `resolveTemplate(name, scanTemplates(templatesRoot))` (`teams.ts:310,609-614`).
- **`config.string("<kind>.dir")`** resolves `override > env(EAGENT_<KIND>_DIR) >
  file > default` (`config.ts`); the env alias is derived, no explicit alias needed
  (confirmed `config-backcompat.test.ts:30` for teams).
- **Home root** = `join(homedir(), ".eagent", "<kind>")`; **project root** =
  `join(process.cwd(), ".eagent", "<kind>")`, except microagents' project root uses
  `config.string("workspace") ?? process.cwd()` (preserve that).
- **Test isolation assumption:** new layered tests set BOTH `process.env.HOME` and
  the cwd (or `process.chdir`) to temp dirs so neither the dev's real home nor the
  repo tree bleeds into the assertion. `homedir()` honors `HOME` on posix — spike:
  `HOME=/tmp/x node -e "console.log(require('os').homedir())"` prints `/tmp/x` on
  darwin (confirmed).
- **No new dependency.** Pure `node:fs`/`node:path`/`node:os`, matching the scanners.
- **Measured baseline (confirm at L2):** `npm test`, `typecheck`, `typecheck:test`,
  `eval`, `build` green before changes.

## 6. Relationship with Existing Designs

- `docs/design/2026-07-07-centralized-config.md` — the `e.config` facility whose
  `string(key)` this uses; no conflict (D1 reads existing keys, adds no config key).
- `docs/design/2026-07-07-centralized-config.md` (the config-file layer at
  `host.ts:214-221`) + the merged **library PR** (#43, commit `3796bc0`, which has
  **no design doc**) — the latter introduced the committed `eagent.config.json`
  resource-dir overrides + the `host.ts` repo-root config path. **⚠ Interaction:**
  D8 **removes** those resource-dir override keys from `eagent.config.json` so the
  repo auto-loads the standard home+project tiers and `library/` becomes opt-in
  (KDD5). The `host.ts` repo-root config-path support stays (it is general). This
  partially reverses the library PR's auto-load-via-override — a deliberate change,
  flagged in KDD5, not a silent conflict. The `<kind>.dir` override still means
  single-source for any user who sets it (KDD1).
- No prior design covers resource-dir resolution; terminology anchors are CLAUDE.md
  (extensions, capabilities) + README.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (home-only loads):** with HOME→tempH, cwd→tempP (empty project tier), a
  template/team/skill/microagent placed in `tempH/.eagent/<kind>` is listed by the
  extension. RED before D2-D5.
- **AC2 (project-only loads):** the same resource placed only in
  `tempP/.eagent/<kind>` is listed. RED before D2-D5.
- **AC3 (project wins):** the SAME `name` present in both tiers → the project
  version is the one resolved (assert a distinguishing field, e.g. description).
  RED before D1/D2-D5.
- **AC4 (override = single-source):** with `EAGENT_<KIND>_DIR` set to `tempO`, only
  `tempO` is read — a resource in `tempH`/`tempP` does NOT appear. Preserves the
  existing isolation contract (regression pin). Command:
  `node --import tsx --test test/<kind>.test.ts`.
- **AC5 (merge helper unit):** `loadLayered([a,b], scanOne)` with a name collision
  returns the `b` (last) entry for that name, all names union'd, sorted. RED before
  D1. Command: `node --import tsx --test test/resource-dirs.test.ts`.
- **AC6 (teams flow):** a member template present only in the project tier resolves
  when running a team whose file is in home (proves the templates→teams flow).
  Command: `node --import tsx --test test/teams.test.ts`.
- **AC7 (official library opt-in):** with no override and `HOME`→`tempH` +
  cwd→`tempP` both empty, the extensions list **no** resources (`library/` is not
  auto-loaded); after copying `library/templates/*` into `tempP/.eagent/templates`,
  they appear. Confirms the opt-in model. RED before D8.
- **AC8 (gates + no regression):** `npm test` exits 0 with all prior tests passing
  (esp. the `EAGENT_*_DIR` isolation tests and `config-backcompat.test.ts`);
  `typecheck`, `typecheck:test`, `build` exit 0; `eval` 5/5. No kernel line change.

## 8. Risks and Rollback

- **R1 — home bleed into tests.** The top risk: layered default reads the dev's real
  `~/.eagent/<kind>`. Mitigated by KDD1(A) (existing tests use overrides = single
  dir, no home read) + D6 isolating HOME in new tests. If any existing test flakes,
  it names a real gap. Rollback: revert the extension's activate path to the
  single-dir call.
- **R2 — merge precedence wrong (home shadows project).** Mitigated by AC3 + AC5
  pinning last-wins. Rollback: fix the Map insertion order (home before project).
- **R3 — teams member resolution regression.** Changing the template catalog feeds
  teams; mitigated by AC6 + the full teams suite. Rollback: revert D2.
- **R4 — microagents home tier picks up unexpected global files.** Additive (home
  was never read before); a user with `~/.eagent/microagents` now gets them merged.
  Intended (uniformity); documented. Rollback: revert D5.
- **Overall rollback:** each extension's layering is an isolated activate-path change
  over the shared helper; revert per-deliverable. Branch `chore/layered-resource-dirs`,
  PR-gated to `init`.
