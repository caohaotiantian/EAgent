# Implementation: Agent Teams (multi-agent orchestration)

Slug: `2026-06-25-agent-teams`
Status: draft (L2)
Design: `docs/design/2026-06-25-agent-teams.md`

## 1. Task Index

| Design anchor | Where realized |
| ------------- | -------------- |
| Deliverables — `docs/design/2026-06-25-agent-teams.md:45-69` | Phase 1 (helper) + Phase 2 (extension/host/tests/docs) |
| §4.6 + §5 `buildTemplateChild` contract — `:228-261`, `:331-348` | **Phase 1** |
| §4.1-4.10 Key Design Decisions — `:107-323` | Phase 2 (honors each) |
| §7 AC-11 reuse helper (closed-cycle refactor surgical) — `:452-457` | **Phase 1** |
| §7 AC-1 parse / AC-2 scan+validate — `:394-402` | Phase 2 |
| §7 AC-3 resolve / AC-4 lead prompt / AC-5 playbook — `:403-416` | Phase 2 |
| §7 AC-6 delegate + capability guard — `:417-428` | Phase 2 |
| §7 AC-7 board / AC-8 run_team dual+fan-out / AC-9 bounds — `:429-446` | Phase 2 |
| §7 AC-10 command surface — `:447-451` | Phase 2 |
| §7 AC-12 no regression — `:458-460` | Phase 2 exit |

**Phase split rationale.** Phase 1 isolates the only edit to a **closed cycle-1
file** (`templates.ts`) — a behavior-preserving refactor — so `spawn_template`
is proven byte-identical (AC-11) on its own green checkpoint before the new
feature is built on top. Phase 2 is the new extension. Each Phase is
independently committable and leaves `npm test` green.

## 2. Phase Breakdown

### Phase 1 — `buildTemplateChild` (construct-only helper in `templates.ts`)

**Entry condition:** L1 passed (it has). No prior Phase.

**Design references:** §4.6 (`:228-261`), §5 contract (`:331-348`), AC-11
(`:452-457`).

**Module shape — edit `src/extensions/templates.ts`:**

```
// NEW export — construct-only; the caller runs `.run()`.
export function buildTemplateChild(
  resolved: ResolvedTemplate,
  parent: { providers: ProviderRegistry; ui: UI; logger: Logger;
            capabilities: CapabilityManager; model: string;
            providerName: string | undefined; tools: Tool[] },
  opts?: { baseRegistry?: ToolRegistry; extraTools?: Tool[];
           excludeCapabilities?: string[]; maxTurnsCeiling?: number },
): Agent
// base registry = opts.baseRegistry ?? templateChildRegistry(parent.tools, resolved.tools);
// then REMOVE any tool whose spec.capabilities intersects opts.excludeCapabilities;
// then ADD opts.extraTools; maxTurns = opts.maxTurnsCeiling
//   ? Math.min(resolved.maxTurns ?? ceiling, ceiling) : resolved.maxTurns;
// capabilities/model/provider/thinking/systemPrompt EXACTLY as templates.ts:399-412 today.
```

`spawn_template.execute` is refactored to build its child via
`buildTemplateChild(resolved.template, { ...parentFields }, undefined)` — **no
opts** — replacing the inline `new Agent({...})` at `templates.ts:399-412`. With
no opts the registry is exactly `templateChildRegistry(parentTools, t.tools)` and
every other field is unchanged ⇒ byte-identical child.

**Task list (TDD order — each test names the invariant):**

- **T1.1 (test)** — in `test/templates.test.ts`, add an AC-11 test: build a child
  the way the refactored `spawn_template` does (via `buildTemplateChild` with no
  opts) over a parent tool set and a template with a `tools` allow-list, and
  assert its registry membership **equals** `templateChildRegistry(parentTools,
  t.tools)` (invariant: the closed-cycle child is unchanged by the refactor). Add
  a second test for the opts path: `excludeCapabilities:["agent:spawn"]` removes a
  spawn-class tool, `extraTools:[x]` adds `x`, `maxTurnsCeiling:8` caps a
  template `maxTurns:99` to 8 (invariant: the helper's compose rules).
- **T1.2 (impl)** — add `buildTemplateChild` (exported) implementing the §5
  contract; refactor `spawn_template.execute` to call it with no opts. Touch
  nothing else in `templates.ts`.

**Acceptance commands (repo root):**
- `node --import tsx --test test/templates.test.ts` → exits 0 (all prior
  templates tests + the new AC-11 tests pass).
- `npm run typecheck` → exits 0.

**Exit condition:** `node --import tsx --test test/templates.test.ts` and
`npm run typecheck` exit 0; `spawn_template` proven byte-identical (T1.1).

### Phase 2 — the `teams` extension

**Entry condition:** Phase 1 closed (`buildTemplateChild` exists, exported,
`spawn_template` byte-identical).

**Design references:** §2 (`:45-69`), §4.1-4.10 (`:107-323`), §5 (`:324-370`),
§7 AC-1..AC-10, AC-12.

**Module shape — `src/extensions/teams.ts`** (named exports = pure core;
`activate` = default):

```
// imports (.js specifiers): ThinkingLevel, Message, Tool, ToolResult from "../kernel/types.js";
// ToolRegistry from "../kernel/registry.js"; ExtensionAPI from "../kernel/extension.js";
// ToolDecision from "../kernel/events.js"; Agent from "../kernel/agent.js";
// defineTool, ok, fail from "../kernel/define.js";
// resolveTemplate, scanTemplates, templatesRoot, buildTemplateChild,
//   type Template, type ResolvedTemplate from "./templates.js".

export interface Team { name; description; lead?: string; members: string[];
  pattern?: string; mission: string }
export interface ResolvedTeam { name; mission; pattern: string;
  lead: ResolvedTemplate; members: { name: string; template: ResolvedTemplate }[] }
export type ResolveTeamResult = { ok: true; team: ResolvedTeam } | { ok: false; error: string }

export const PATTERN_KEYS = ["auto","orchestrator","parallel","sequential",
  "generator-verifier","consensus","blackboard"] as const
export const PATTERN_PLAYBOOK: string   // fixed constant: the six patterns + when-to-use + selection heuristic
export const SPAWN_CAPS = ["agent:spawn","workflow:run"] as const
export const MAX_MEMBERS = 16, LEAD_MAX_TURNS = 16, DELEGATE_CAP = 32, MEMBER_MAX_TURNS = 8
export function teamsRoot(): string                 // EAGENT_TEAMS_DIR ?? ~/.eagent/teams
export function enabled(): boolean                  // process.env.EAGENT_TEAMS !== "off"
export function parseTeam(md, fallbackName): Team
export function validateTeam(t: Team): string[]     // [] = valid
export function scanTeams(root, warn?): Team[]       // sorted; invalid skipped+warned; missing → []
export function resolveTeam(name|Team, teamCatalog, templateCatalog): ResolveTeamResult
export function buildLeadPrompt(rt: ResolvedTeam, task: string): string
export function memberChildRegistry(parentTools: Tool[], allowlist: string[]|undefined,
  board: Tool): ToolRegistry            // templateChildRegistry-style ∩ allowlist, exclude SPAWN_CAPS-intersecting, add board
export function makeBoard(): { tool: Tool; entries(): unknown[] }   // synchronous post/list/update; count+byte caps
export default function activate(e: ExtensionAPI): void
```

**Task list (TDD order; tests modeled on `test/templates.test.ts` +
`test/subagents.test.ts`; temp dirs under `os.tmpdir()` via `EAGENT_TEAMS_DIR`
and `EAGENT_TEMPLATES_DIR`; env saved/restored in `finally`):**

- **T2.1 (test) parse + validate (AC-1, AC-2):** `parseTeam` reads frontmatter
  (name, description, lead?, members comma-list, pattern?) + `mission`=body;
  no-fence degrades without throwing. `validateTeam` returns errors for non-kebab
  name, `<`/`>` in description (the injection vector), unknown `pattern` (not in
  `PATTERN_KEYS`), empty `members`, a roster over `MAX_MEMBERS`, unknown keys;
  `[]` for valid. `scanTeams` excludes invalid files, sorts, missing dir → `[]`.
- **T2.2 (test) resolve (AC-3):** `resolveTeam` resolves each member + lead via
  `resolveTemplate` against a template catalog; unknown member/lead → typed error
  naming it; a roster over `MAX_MEMBERS` → error; returns the `ResolvedTeam`
  shape. (Invariant: a team only resolves when every role maps to a real
  template.)
- **T2.3 (test) lead prompt + playbook (AC-4, AC-5):** `buildLeadPrompt` contains
  the mission, each member name + its template description, the full
  `PATTERN_PLAYBOOK`, the `task`, and the pinned-pattern directive (concrete
  `pattern`) or the selection heuristic (`auto`). `PATTERN_PLAYBOOK` names all six
  patterns each with a when-to-use line + the heuristic. (Substring assertions.)
- **T2.4 (test) capability-driven recursion guard (AC-6):** build a parent tool
  list with `spawn_agent`/`spawn_template`/`sweep_edit` (`capabilities:["agent:spawn"]`),
  `run_workflow` (`capabilities:["workflow:run"]`), a plain `read`, and the board;
  `memberChildRegistry(parent, undefined, board)` contains `read`+`board` and
  **none** of the four spawn-class tools (the `run_workflow`/`workflow:run` case
  proves the guard is not keyed on `agent:spawn` alone); intersection-not-subset
  retains a plain `write` (`["fs:write"]`). (Invariant: a member can reach no
  agent-spawning/workflow tool.)
- **T2.5 (test) board (AC-7):** `makeBoard().tool` — a `post` is visible in a
  later `list`; the same board instance shared by two callers; **two concurrent
  `post`s** (`await Promise.all([...])`) get **distinct ids** (invariant: sync
  id-assign survives a parallel batch); the count/byte cap is enforced.
- **T2.6 (test) delegate (AC-6 behavior):** the per-run `delegate` tool (built in
  `run_team`) — an off-roster member errors with the roster listed; a member runs
  on `MockProvider` and its final text is returned; the `delegate` tool spec has
  default (`parallel`) executionMode (assert `tool.executionMode !== "sequential"`).
- **T2.7 (test) run_team end-to-end, file + inline (AC-8):** with a scripted
  `MockProvider` lead emitting two `delegate` calls in one turn then a synthesis,
  `run_team` over a file-based team returns the synthesis and both members ran;
  `run_team` over an inline roster `{members:[...], task}` likewise runs.
- **T2.8 (test) bounds + kill switch (AC-9):** the delegate counter rejects the
  (cap+1)-th call; a member template `maxTurns:99` is built capped to
  `MEMBER_MAX_TURNS`; a roster over `MAX_MEMBERS` is rejected; `EAGENT_TEAMS=off`
  makes `run_team` fail and `/team run` refuse.
- **T2.9 (test) command surface (AC-10):** activating `teams` registers exactly
  one tool (`run_team`), `/team` + `/teams`; `/team list` prints names; `/team
  show <name>` prints roster + pattern; `/team run <name> <task>` runs and prints.
  Registration counts via the harness.

Then implementation:

- **I2.1 pure core:** `teamsRoot`, `enabled`, `parseTeam` (reuse the single-line
  frontmatter idiom; do not import templates' validator), `validateTeam`,
  `scanTeams`, `resolveTeam`, `buildLeadPrompt`, `PATTERN_PLAYBOOK`/`PATTERN_KEYS`,
  `memberChildRegistry`, `makeBoard`, the caps constants.
- **I2.2 activate(e):** `e.grantCapability("agent:spawn")`; the `run_team` tool
  (`capabilities:["agent:spawn"]`; arg = `team` name **or** inline roster + `task`;
  fail when `!enabled()`) whose core `runTeam(rt, task)`: builds a per-run
  `makeBoard()`, a per-run `delegate` tool (default parallel executionMode;
  synchronous delegate-cap counter; resolves member vs roster; child via
  `buildTemplateChild(memberTemplate, parent, { baseRegistry:
  memberChildRegistry(e.agent.tools.list(), member.template.tools, board.tool),
  maxTurnsCeiling: MEMBER_MAX_TURNS })`), then builds the **lead** via
  `buildTemplateChild(rt.lead, parent, { extraTools: [board.tool, delegateTool],
  maxTurnsCeiling: LEAD_MAX_TURNS })` with `systemPrompt = buildLeadPrompt(rt,
  task)`, runs the lead, returns its final text; the `/team` command
  (`list`/`show`/`run`, refuse when `!enabled()`) + `/teams` alias.
- **I2.3 host registration:** import `teams` in `src/host.ts`; add `["teams",
  teams]` to `BUILTIN_EXTENSIONS` immediately **after** `["templates", templates]`.
- **I2.4 docs:** one `README.md` extension-table row (Capability `agent:spawn`;
  mention `/team`, `run_team`, the patterns, `EAGENT_TEAMS=off`); update the three
  `45`→`46` counts (`README.md:338`, `CLAUDE.md:65`, `CLAUDE.md:79`).

**Acceptance commands (repo root):**
- `node --import tsx --test test/teams.test.ts` → exits 0 (AC-1..AC-10).
- `npm run typecheck` → exits 0 (strict TS over `src/`, incl. `teams.ts` + `host.ts`).
- `npm test` → exits 0 (AC-12; full suite incl. `templates`/`subagents`/`host`/
  `kernel-surface` regressions).

**Exit condition:** all three acceptance commands exit 0; `teams` in
`BUILTIN_EXTENSIONS`; README row + counts updated.

## 3. Engineering Constraints Index

- **Project norms** — CLAUDE.md "House conventions": ESM + NodeNext `.js`
  specifiers even for `.ts`; strict TS (`noUncheckedIndexedAccess`, no `any`);
  **zero runtime deps except `jiti`**; kill-switch `EAGENT_<NAME>=off`; privileged
  tools declare `capabilities:[...]`; the in-use capability vocabulary is fixed —
  reuse `agent:spawn`, add none.
- **Untypechecked tests (gotcha)** — `tsconfig.json` excludes `test/`; `npm test`
  runs via `tsx` (transpile-only). Neither `typecheck` nor `test` type-checks the
  test files; keep their types sound by hand. `npm run typecheck` guards only
  `src/` (incl. the new `teams.ts`, the `templates.ts` edit, and `host.ts`).
- **Non-ASCII grep gotcha** — use `grep -a` / Read for audits (source contains `→`,
  `≤`, `∩`).
- **Surgical edit to a closed file** — Phase 1 touches only the child
  construction in `templates.ts` (extract + call-site); change nothing else;
  AC-11 + `test/templates.test.ts` green prove it behavior-preserving.
- **Four-corner subagent template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN): …` opener; `fix(phaseN-roundR):
  <keyword>` within-round; `npm test`/`npm run typecheck` results as trailers;
  **no AI/model/tooling mention, no `Co-Authored-By: Claude`, no
  `Claude-Session`/claude.ai trailers** (CLAUDE.md).

## 4. Data and Fixture Dependencies

- **Reused test infra:** `test/helpers.ts` (`makeHarness`, `lastText`,
  `RenamedProvider`, `autoUI`); `src/providers/mock.ts` (`MockProvider.script`).
  No new shared fixture.
- **Per-test temp dirs:** team files under `os.tmpdir()` via `EAGENT_TEAMS_DIR`,
  and template files via `EAGENT_TEMPLATES_DIR` (a team's members must resolve to
  real templates), mirroring `test/microagents.test.ts`/`test/templates.test.ts`.
  All `process.env` mutations (`EAGENT_TEAMS`, `EAGENT_TEAMS_DIR`,
  `EAGENT_TEMPLATES_DIR`) saved/restored in `finally`.

## 5. Regression Protection

- **`test/templates.test.ts`** must stay green through **both** Phases — it is the
  guard that the `buildTemplateChild` refactor kept `spawn_template` identical
  (Phase 1 AC-11) and that Phase 2 did not perturb templates.
- **`test/subagents.test.ts`** — teams reuses nothing from subagents directly
  except (transitively) `scopedCapabilities` via `buildTemplateChild`; confirm it
  stays green.
- **`test/host.test.ts`** — a new `BUILTIN_EXTENSIONS` entry; confirm any
  count/order assumptions hold.
- **`test/kernel-surface.test.ts`** — extension-only change, no `src/kernel/` edit;
  the 2,200-line ceiling and pinned exports are unaffected.
- **`npm run typecheck`** exit 0 after the `templates.ts` edit + `teams.ts` +
  `host.ts`.
