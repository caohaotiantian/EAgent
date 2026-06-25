# Implementation: Agent Templates

Slug: `2026-06-25-templates`
Status: draft (L2)
Design: `docs/design/2026-06-25-templates.md`

## 1. Task Index

| Design anchor | Where realized |
| ------------- | -------------- |
| Deliverables — `docs/design/2026-06-25-templates.md:29-54` | Phase 1 tasks I1-I4 |
| §4.1-4.9 Key Design Decisions — `:95-318` | Phase 1 (I1, I2 honor each decision) |
| §5 Dependencies/Assumptions — `:320-344` | I1/I2 imports (`scopedCapabilities`, `Agent`, `defineTool`/`ok`/`fail`) |
| §7 AC-1 parse — `:373-379` | T1 → I1 (`parseTemplate`) |
| §7 AC-2 scan + validate — `:380-384` | T1 → I1 (`validateTemplate`, `scanTemplates`) |
| §7 AC-3..AC-6 resolve — `:385-397` | T2 → I1 (`resolveTemplate`) |
| §7 AC-7 catalog injection (opt-in) — `:398-403` | T3 → I1 (`injectCatalog`) / I2 (store flag) |
| §7 AC-8 kill switch — `:404-406` | T5 → I1/I2 (`EAGENT_TEMPLATES=off`) |
| §7 AC-9 delegate registry + run — `:407-413` | T4 (registry) + T6 (run) → I1 (`templateChildRegistry`) / I2 (`spawn_template`) |
| §7 AC-10 become + reset — `:414-420` | T7 → I2 (`/template use|reset` + veto) |
| §7 AC-11 registration — `:421-426` | T8 → I2 (activate) |
| §7 AC-12 no regression — `:427-430` | Phase exit acceptance commands |

## 2. Phase Breakdown

### Phase 1 — the `templates` extension (single Phase)

This feature is one extension file plus host registration, tests, and docs. Per
the design it shadows nothing and adds only new names, so it is a single
independently-committable unit that leaves `npm test` green at the end (the
`microagents` precedent: splitting pure-functions from `activate` into separate
Phases would leave a half-wired module that cannot be committed green).

**Entry condition:** L1 design passed (it has); no prior Phase.

**Design document references:** `docs/design/2026-06-25-templates.md` §2
(`:29-54`), §4.1-4.9 (`:95-318`), §5 (`:320-344`), §7 (`:371-430`).

**Module shape — `src/extensions/templates.ts`** (named exports are the pure,
unit-testable core; `activate` is the default export):

```
// imports: ThinkingLevel, Message, Tool from "../kernel/types.js";
// ToolRegistry from "../kernel/registry.js"; ExtensionAPI from "../kernel/extension.js".
export interface Template {            // a parsed-but-unresolved template
  name: string; description: string; extends?: string;
  model?: string; provider?: string; thinking?: ThinkingLevel;
  maxTurns?: number; tools?: string[]; capabilities?: string[];
  systemPrompt: string;
}
// ResolvedTemplate = Template with `extends` resolved away: same fields minus
// `extends`, with `tools`/`capabilities` merged (union) and `systemPrompt` the
// root-first concatenation across the chain (design §4.3).
export type ResolvedTemplate = Omit<Template, "extends">;
export type ResolveResult =
  | { ok: true; template: ResolvedTemplate }
  | { ok: false; error: string };     // cycle / unknown-parent → ok:false (never throw)

export function templatesRoot(): string            // EAGENT_TEMPLATES_DIR ?? ~/.eagent/templates
export function enabled(): boolean                  // process.env.EAGENT_TEMPLATES !== "off"
export function parseTemplate(md: string, fallbackName: string): Template
export function validateTemplate(t: Template): string[]     // [] = valid; else human errors
export function scanTemplates(root: string): Template[]      // sorted; invalid skipped (warn)
export function resolveTemplate(name: string, catalog: Template[]): ResolveResult
export function injectCatalog(messages: Message[], catalog: Template[], on: boolean): Message[]
export function templateChildRegistry(parentTools: Tool[], allowlist?: string[]): ToolRegistry
export default function activate(e: ExtensionAPI): void
```

**Task list (TDD order — every test task names the invariant it protects):**

Tests first (`test/templates.test.ts`; model on `test/microagents.test.ts` and
`test/subagents.test.ts`):

- **T1 — parse + validate (AC-1, AC-2).** Tests that protect:
  (a) `parseTemplate` reads each frontmatter key, splits `tools`/`capabilities`
  on commas with trimming, coerces `maxTurns` to a number, carries `thinking` as
  one of the exact `off/low/medium/high` tokens, and sets `systemPrompt` to the
  body after the closing `---`; a body with no fence yields empty frontmatter +
  the whole string as body and **does not throw** (invariant: malformed files
  degrade, never crash a scan). (b) `validateTemplate` returns a non-empty error
  list for: a non-kebab `name`, a `description` containing `<` or `>` (the
  hidden-tag injection vector — the invariant is that a template description can
  never carry angle brackets into the catalog), `thinking` outside the four
  tokens, a non-integer/≤0 `maxTurns`, and any unknown key; returns `[]` for a
  well-formed template. (c) `scanTemplates` over a temp dir **excludes** a file
  whose `validateTemplate` fails and includes valid ones, sorted; a missing dir
  returns `[]`.
- **T2 — resolve + inheritance (AC-3, AC-4, AC-5, AC-6).** Tests that protect:
  no-`extends` returns own fields (AC-3); a 2-level `child extends base` yields
  child-scalar-override, inherited-when-absent, **de-duplicated union** of
  `tools`/`capabilities`, and `systemPrompt === base.body + "\n\n" + child.body`
  (invariant: the merge contract is exactly scalar-override / list-union /
  root-first-prompt-concat); a 3-level `root→mid→leaf` concatenates root-first
  (`root + "\n\n" + mid + "\n\n" + leaf`); a cycle `a↔b` returns
  `{ok:false, error}` naming the cycle and **terminates** (invariant: no infinite
  loop / stack overflow); an unknown `extends` target returns `{ok:false, error}`
  naming the missing parent.
- **T3 — catalog injection opt-in (AC-7).** Tests that protect: with `on=true`
  and ≥1 template, `injectCatalog` returns a **new** array whose first element is
  a `system` message with `meta.ephemeral === true`, `meta.source ===
  "templates"`, and one `- <name>: <description>` line per template; with
  `on=false` (default), an empty catalog, **or** `EAGENT_TEMPLATES=off`, it
  returns **the same array reference** (invariant: zero standing cost when the
  catalog is off — assert `result === input`).
- **T4 — child registry + recursion guard (AC-9 registry half).** Tests that
  protect: `templateChildRegistry([read, write, edit, spawn_agent, spawn_template],
  ["read","write"])` contains exactly `read`+`write`; with no allowlist it
  contains every parent tool **except** `spawn_agent` and `spawn_template`
  (invariant: a delegated child can never re-spawn — `registry.has("spawn_agent")
  === false` and `registry.has("spawn_template") === false`).
- **T5 — kill switch (AC-8).** Tests (env saved/restored in `finally`) that with
  `EAGENT_TEMPLATES=off`: `injectCatalog(..., true)` returns input by reference;
  the `spawn_template` tool returns an error result whose text says templates are
  disabled; `/template use x` prints a disabled refusal (invariant: one env var
  fully neutralizes the extension).
- **T6 — delegate end-to-end (AC-9 run half).** Using `makeHarness` +
  `provider.script`, the parent calls `spawn_template` with a template name; the
  child runs on `MockProvider` and the tool returns the child's final answer
  (invariant: a template resolves into a runnable specialized child). A second
  case registers a `RenamedProvider("critic", mock)` and a template with
  `provider: critic`, asserting the child is built against that provider
  (assert via the returned `details`/child provider, mirroring
  `subagents.test.ts` provider cases). Behavioral recursion guard: a child that
  tries to call `spawn_template` gets an unknown-tool error and still finishes
  (mirror `subagents.test.ts:204`).
- **T7 — become + reset, incl. use→use→reset (AC-10).** Using `makeHarness` +
  the `/template` command (dispatch via the registered command's `run(ctx)` with
  a `print` spy, as `microagents.test.ts` does): `/template use specialist` sets
  `agent.systemPrompt`/`model`/`thinking`/`maxTurns` to the resolved values and
  leaves `agent.providerName` unchanged (invariant: become never swaps provider);
  a `beforeToolCall` for a tool outside the allow-list yields a blocked decision
  (assert via `agent.hooks` filter result or a scripted run where the blocked
  tool returns the veto error); `/template use other` then `/template reset`
  restores the **pristine** pre-first-`use` values (invariant: baseline saved
  once; switching templates does not corrupt it) and a previously blocked tool is
  allowed again.
- **T8 — registration + commands (AC-11).** Activating `templates` via
  `host.use("templates", templates)` registers exactly one tool
  (`spawn_template`), the `/template` command and `/templates` alias, **exactly
  one** `transformContext` listener and **exactly one** `beforeToolCall` listener
  (assert exact listener-count deltas around `host.use`, as `microagents.test.ts`
  /`prune.test.ts` do; invariant: the veto is registered once at activate, not
  per-`use`); `/templates` prints the catalog names; `/template catalog on` then
  `off` flips the `e.store` flag that T3/AC-7 reads.

Implementation after tests:

- **I1 — pure core** in `src/extensions/templates.ts`: `templatesRoot`,
  `enabled`, `parseTemplate` (reuse the single-line parser idiom of
  `skills.ts:160-171` — do **not** import skills' `validateFrontmatter`),
  `validateTemplate`, `scanTemplates` (skip-invalid-with-warn, mirroring
  `scanSkills`' try/catch-skip), `resolveTemplate` (visited-set walk, root-first
  prompt concat, typed `ResolveResult`), `injectCatalog` (by-reference no-op when
  off/empty/disabled), `templateChildRegistry` (single pass: keep iff
  `(allowlist empty || name∈allowlist) && name∉{spawn_agent,spawn_template}`).
- **I2 — `activate(e)`**: `e.grantCapability("agent:spawn")`; a
  `transformContext` hook calling `injectCatalog(messages, scanTemplates(...),
  catalogFlag(e.store))`; the `spawn_template` tool
  (`capabilities:["agent:spawn"]`) — resolve the named template (error result on
  unknown name **listing available names** for discovery-by-error), build a child
  `Agent` (model/provider/thinking/maxTurns/systemPrompt from the resolved
  template, `tools: templateChildRegistry(e.agent.tools.list(), resolved.tools)`,
  `capabilities: resolved.capabilities ? scopedCapabilities(resolved.capabilities,
  e.agent.ui) : e.agent.capabilities`), run it on `prompt`, return its final text;
  one `beforeToolCall` veto reading module-scope `active` state (block a tool not
  in `active.tools`); the `/template` command dispatching `list`/`show <name>`/
  `use <name>`/`reset`/`catalog on|off` (save baseline on first `use` only; refuse
  when `!enabled()`).
- **I3 — host registration**: in `src/host.ts` import `templates from
  "./extensions/templates.js"` and add `["templates", templates]` to
  `BUILTIN_EXTENSIONS` immediately **after** `["dynamic-workflow", dynamicWorkflow]`
  (line 83), keeping `subagents`→`dynamic-workflow` adjacent.
- **I4 — docs**: add one `README.md` extension-table row (Capability column
  `agent:spawn`; mention `/template` + the `EAGENT_TEMPLATES=off` kill switch and
  opt-in catalog); update the three `44`→`45` counts (`README.md:337`,
  `CLAUDE.md:65`, `CLAUDE.md:79`).

**Per-task acceptance commands (runnable from the repo root):**

- After T1-T8 + I1-I2 (extension complete):
  `node --import tsx --test test/templates.test.ts` → exits 0, all AC tests pass.
- After I3 (host registration) + I4: `npm run typecheck` → exits 0 (strict TS over
  `src/`, including the new extension and `host.ts`).
- Phase exit (AC-12): `npm test` → exits 0 (whole offline suite green).

**Exit condition:** `node --import tsx --test test/templates.test.ts`,
`npm run typecheck`, and `npm test` all exit 0; `templates` is in
`BUILTIN_EXTENSIONS`; README row + counts updated.

## 3. Engineering Constraints Index

- **Project engineering norms** — CLAUDE.md "House conventions": ESM + NodeNext
  with `.js` import specifiers even for `.ts` (`import { defineTool } from
  "../kernel/define.js"`); strict TS (`strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`) — model the types, no
  `any`; **zero runtime deps except `jiti`** (use Node `fs`/`os`/`path` and the
  global only); the kill-switch convention `EAGENT_<NAME>=off`; privileged tools
  declare `capabilities:[...]`.
- **Untypechecked tests (gotcha)** — `tsconfig.json` excludes `test/`, and
  `npm test` runs via `tsx` (transpile-only); neither `typecheck` nor `test`
  type-checks `test/templates.test.ts`. Keep the test file's own types sound by
  hand; `npm run typecheck` only guarantees `src/`.
- **Non-ASCII grep gotcha** — source/tests may contain non-ASCII (`→`, `≤`);
  audits must use `grep -a` or the Read tool, not bare `grep`.
- **Four-corner subagent template** — `references/loop-3-development.md`.
- **Commit conventions** — SKILL.md "Commit conventions": Phase opener
  `feat(phase1): …`; within-round fix `fix(phase1-roundR): <failing-item-keyword>`;
  `npm test`/`npm run typecheck` results as trailers; **no AI/model/tooling
  mention, no `Co-Authored-By: Claude`, no `Claude-Session`/claude.ai trailers**
  (CLAUDE.md "No Claude Code artifacts in the commit history").

## 4. Data and Fixture Dependencies

- **Reused test infra:** `test/helpers.ts` (`makeHarness`, `lastText`,
  `RenamedProvider`, `autoUI`); `src/providers/mock.ts` (`MockProvider.script`).
  No new shared fixture is added.
- **Per-test temp dirs:** template files are written to a per-test directory
  under `os.tmpdir()` and pointed at via `EAGENT_TEMPLATES_DIR`, mirroring the
  temp-dir pattern in `test/microagents.test.ts` (`scanMicroagents` cases). All
  `process.env` mutations (`EAGENT_TEMPLATES`, `EAGENT_TEMPLATES_DIR`) are
  saved and restored in `finally` to prevent cross-test leakage.

## 5. Regression Protection

- **Whole suite green:** `npm test` must remain exit 0 — in particular
  `test/subagents.test.ts` (this extension imports `scopedCapabilities` from
  `subagents.ts`; the import must not perturb subagents' own exports) and
  `test/host.test.ts` (adding a `BUILTIN_EXTENSIONS` entry — confirm any
  count/order assertions there still hold).
- **Kernel surface untouched:** `test/kernel-surface.test.ts` must stay green;
  this is an extension-only change with no `src/kernel/` edit, so the 2,200-line
  ceiling and the pinned public exports are unaffected.
- **Type safety:** `npm run typecheck` exit 0 after host registration.
