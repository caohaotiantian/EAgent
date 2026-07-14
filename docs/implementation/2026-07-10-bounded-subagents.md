# Implementation — Bounded sub-agents (Batch B)

Slug: `2026-07-10-bounded-subagents` (matches `docs/design/2026-07-10-bounded-subagents.md`)
Status: closed
Closing-commit: Batch B closeout on `chore/production-hardening`
Closed-on: 2026-07-10
Deferred: none (both phases closed on their first L3 review).
Result: 2 phases, both closed round 1. Suite 1288 → 1296 pass (+8: child-registry helper tests, six reworked discriminators, four fan-out cases), 0 fail, 1 skip; typecheck 0; eval 5/5; build 0. Four leaky name-based child-registry strips replaced by one capability-based lib helper; spawn_agent fan-out capped.

## 1. Task Index

Design: `docs/design/2026-07-10-bounded-subagents.md`. Deliverables D1–D8 → §2; Acceptance AC1–AC6
→ §7; KDD1–4 → §4.
- Phase 1 implements D1–D6, D8 (capability-based child registry + single-source SPAWN_CAPS + tests)
  — design KDD1, KDD2, KDD3; AC1, AC2, AC4, AC5.
- Phase 2 implements D7, D8 (fan-out cap) — design KDD4; AC3.
- Both satisfy AC6 (gates) at exit.

## 2. Phase Breakdown

`<TEST-CMD>` = `npm test`. Every phase leaves it green and adds ≥1 runnable `<ACCEPT-CMD>`. Tests
before implementation within each phase.

### Phase 1 — capability-based child registry + single-source `SPAWN_CAPS`

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1288 pass / 1 skip).
- **Design references:** §4 KDD1 (capability strip), KDD2 (lib home + re-export), KDD3 (depth by tool
  absence; invariant), §5, §7 AC1/AC2/AC4/AC5, §8 R1/R2.
- **Task list (TDD order — new + reworked tests go RED first, then the rewire makes them GREEN):**
  1. **T1.1 (test)** — create `test/child-registry.test.ts`. Protected invariant: *a spawned child's
     tool registry must exclude EVERY tool declaring a spawn-class capability (`agent:spawn` OR
     `workflow:run`), so a child cannot spawn grandchildren regardless of the spawn tool's name.*
     Cases: build a parent `[capTool("spawn_agent",["agent:spawn"]), capTool("run_workflow",
     ["workflow:run"]), capTool("run_team",["agent:spawn"]), tool("helper")]` (no-caps helper); assert
     `childRegistryFrom(parent)` has only `helper` (all three spawn tools stripped — covers BOTH caps).
     Allowlist case: `childRegistryFrom([tool("read"),tool("write"),capTool("spawn_agent",
     ["agent:spawn"])], { allowlist:["read"] })` yields only `read`. (Model the stubs after
     `test/teams.test.ts:331` / `subagent-jobs.test.ts:240` `capTool`.) RED (helper does not exist).
  2. **T1.2 (test rework — RED-first discriminators)** — update the six existing name-based registry
     tests so each (a) declares `capabilities` on its spawn stubs and (b) additionally asserts a
     *second-named* spawn tool (e.g. a `workflow:run` tool) is stripped — this assertion is RED under
     the current name-based code (the second tool survives) and GREEN after the rewire. The six files
     (all currently use capability-free `tool()`/`defineTool` stubs and import the site's builder):
     - `test/subagents.test.ts:186-202` (+ behavioral `:204-240` — register a *second*, differently
       named spawn tool in the parent, e.g. `capTool("run_workflow",["workflow:run"])`, and assert the
       spawned child cannot call it) — imports `childRegistryFrom` from `../src/…/subagents.js`.
     - `test/templates.test.ts:266-283` — the RED-first "second-named" stub must be a spawn tool
       **outside** the old name set `{spawn_agent, spawn_template}` (e.g. `capTool("run_team",
       ["agent:spawn"])`), else the old name-based code already strips it and the discriminator is not
       RED. (`:704-724` is a self-equality check — repoint only if its import moves; needs no cap stubs.)
     - `test/dynamic-workflow.test.ts:370-376` — `workflowChildRegistry`.
     - `test/reasoning-search.test.ts:202-212`, `test/tree-search.test.ts:276-286`,
       `test/graph-of-thought.test.ts:270-284` — all import `childRegistryFrom` from
       `../src/…/reasoning-search.js` and assert name-based stripping of the search tools.
     Point each import at the (re-exported) builder per T1.4-T1.5.
  3. **T1.3 (impl D1)** — create `src/extensions/lib/child-registry.ts`: `export const SPAWN_CAPS =
     ["agent:spawn","workflow:run"] as const;` and `export function childRegistryFrom(parentTools:
     Tool[], opts?: { allowlist?: string[] }): ToolRegistry` that `register`s each parent tool whose
     `capabilities` does NOT intersect `SPAWN_CAPS` and (if `opts.allowlist` given) whose `spec.name`
     is in the allowlist. Import `ToolRegistry` from `../../kernel/registry.js`, `Tool` from
     `../../kernel/types.js`. No `ExtensionAPI` import. (Shape = `jobChildRegistry`
     `subagent-jobs.ts:61-69` + the allowlist branch of `memberChildRegistry` `teams.ts:374-385`.)
  4. **T1.4 (impl D6 + re-export)** — single-source `SPAWN_CAPS` and preserve external importers:
     - `src/extensions/teams.ts`: replace `export const SPAWN_CAPS = […]` (`:105`) with
       `import { SPAWN_CAPS } from "./lib/child-registry.js";` **and** `export { SPAWN_CAPS };` (a local
       binding is required — `teams.ts` uses `SPAWN_CAPS` internally at `:376`/`:595`; a bare
       `export … from` would leave those unresolved). `subagent-jobs.ts:30`'s `./teams.js` import stays.
     - **Mandate re-export (not delete)** for the two sites whose `childRegistryFrom` export is imported
       elsewhere: `subagents.ts` (imported by `test/governed-subagents.test.ts:25`, used at `:137`) and
       `reasoning-search.ts` (imported by the three search tests). For `subagents.ts` a bare
       `export { childRegistryFrom } from "./lib/child-registry.js";` suffices. For `reasoning-search.ts`
       use a **local delegator** (`import { childRegistryFrom } from "./lib/child-registry.js"; export {
       childRegistryFrom };`) — a bare `export … from` gives no local binding and would break
       `reasoning-search.ts:179`, which calls `childRegistryFrom` internally. Both preserve every
       existing import with capability-based behavior.
  5. **T1.5 (impl D2/D3/D4/D5)** — rewire all four leaky sites to the lib helper:
     - `subagents.ts`: `buildChildRegistry` (`:52`) calls the lib `childRegistryFrom`; drop the local
       name-based body (kept only as the re-export above).
     - `templates.ts` `templateChildRegistry` (`:317`) → delegate to `childRegistryFrom(parentTools,
       { allowlist })` (preserve the `allowlist` param). `teams`' lead routes through this path
       (`teams.ts:594`, no `baseRegistry`) but its downstream `excludeCapabilities: SPAWN_CAPS` keeps
       the lead registry byte-identical — `test/teams.test.ts` must stay green.
     - `reasoning-search.ts` `childRegistryFrom` (`:87`) → the lib helper (its search tools declare
       `agent:spawn`, so no name list needed).
     - `dynamic-workflow.ts` `workflowChildRegistry` (`:313`) → the lib helper.
  6. **T1.6 (test — invariant pin)** — the KDD3 invariant test (in `test/child-registry.test.ts`): via
     `createAgentHost` with the mock provider (no API key) or the `makeHarness` used by
     `subagents.test.ts`, activate the spawn-related built-ins (enable any off-by-default one, e.g.
     `subagent-jobs`) and assert each spawner tool (`spawn_agent`, `spawn_template`, `run_team`,
     `run_workflow`, `best_of_n`, `tree_search`, `graph_search`, `sweep_edit`, `launch_job`) present in
     the registry declares a member of `SPAWN_CAPS`. (A pin, not a discriminator — it passes on
     current code and guards against a future capless spawner.)
- **Per-task acceptance commands:**
  - `node --import tsx --test test/child-registry.test.ts`
  - `node --import tsx --test test/subagents.test.ts test/templates.test.ts test/dynamic-workflow.test.ts test/reasoning-search.test.ts test/tree-search.test.ts test/graph-of-thought.test.ts test/governed-subagents.test.ts`
  - `node --import tsx --test test/teams.test.ts test/subagent-jobs.test.ts` (AC5 — must stay green)
  - Positive gate (`-a` per the non-ASCII grep gotcha): `grep -la 'lib/child-registry.js' src/extensions/subagents.ts src/extensions/templates.ts src/extensions/reasoning-search.ts src/extensions/dynamic-workflow.ts` lists all four.
- **Exit condition:** all above green; `npm test` green (0 fail); `npm run typecheck` 0. Regression
  check (design R1): confirm no test spawns a child that then calls a job-lifecycle tool from inside
  the child (grep the tests; there is none).

### Phase 2 — fan-out (breadth) cap on `spawn_agent`

- **Entry condition:** Phase 1 merged; suite green.
- **Design references:** §4 KDD4, §7 AC3.
- **Task list (TDD order):**
  1. **T2.1 (test)** — in `test/subagents.test.ts`, add: protected invariant *`spawn_agent` cannot fan
     out to an unbounded number of children in one call.* With default `subagents.maxFanout` (16): a
     `spawn_agent {mode:"parallel", prompts:[…17 strings…]}` call returns an **error** result whose
     text names the cap (and no children run); `prompts:[…16…]` is accepted. A config override
     (`subagents.maxFanout=2` via the harness config) makes a 3-prompt call error. Use the extension's
     existing test harness (mock provider).
  2. **T2.2 (impl D7)** — `src/extensions/subagents.ts`: in the `spawn_agent` execute, for
     `mode:"parallel"|"chain"`, read `maxFanout = e.config.int("subagents.maxFanout", 16)` and, when
     `prompts.length > maxFanout`, return `fail(...)` with a clear message (before spawning any child).
     `single` mode is unaffected.
- **Per-task acceptance command:** `node --import tsx --test test/subagents.test.ts`.
- **Exit condition:** the fan-out test green; `npm test` green; `npm run typecheck` 0; `npm run eval`
  5/5; `npm run build` 0 (final-phase full gate).

## 3. Engineering Constraints Index

- **Engineering norms** — `CLAUDE.md`: ESM `.js` specifiers even for `.ts`; strict TS
  (`noUncheckedIndexedAccess`); zero deps except jiti; capabilities are the security vocabulary; lib/
  helpers are pure (kernel types + Node only, no `ExtensionAPI`); config via `e.config`; NO kernel
  change (only `src/extensions/*.ts`, new `src/extensions/lib/child-registry.ts`, `test/*`). Use
  `grep -a`/Read for non-ASCII source.
- **Four-corner template** — `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):`/`fix(phaseN-roundR): <keyword>`; result trailers; no
  AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse the existing per-file test helpers: `capTool(name, caps)` and `tool(name)` (declared in
  `test/teams.test.ts:50-57`, `test/templates.test.ts:58/700`, `test/subagent-jobs.test.ts`), and the
  extension test harness used by `subagents.test.ts` for live spawns (mock provider). No new fixtures.
- The invariant test (T1.2) reuses whatever multi-extension activation the suite already has
  (`createAgentHost` with mock, or a `makeHarness` that activates named extensions).

## 5. Regression Protection

Must stay green after each phase:
- `test/teams.test.ts` (esp. `:331-360` memberChildRegistry, `:481-551` lead recursion guard) and
  `test/subagent-jobs.test.ts` (`:240-256` jobChildRegistry, `:181-229` rootOnly) — the
  already-correct capability pattern; the SPAWN_CAPS relocation must not change their behavior (AC5).
- `test/subagents.test.ts`, `test/templates.test.ts`, `test/reasoning-search.test.ts`,
  `test/tree-search.test.ts`, `test/graph-of-thought.test.ts`, `test/dynamic-workflow.test.ts` — the
  reworked/affected registries (all three search tests import `childRegistryFrom` from
  `reasoning-search.js`, so they are reworked in T1.2 and pinned by the re-export in T1.4).
- `test/governed-subagents.test.ts` — imports `subagents.childRegistryFrom` (`:25`, used at `:137`);
  the T1.4 re-export keeps it resolving (behavior is now capability-based, which is stricter — confirm
  green).
- Full suite `npm test`; final phase adds `npm run eval` (5/5) and `npm run build`.
