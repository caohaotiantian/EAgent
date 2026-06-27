# Implementation — Governed sub-agents (scoped hook inheritance)

**Slug:** `2026-06-28-governed-subagents` (matches design) · **Design:**
[`design/2026-06-28-governed-subagents.md`](../design/2026-06-28-governed-subagents.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Run from repo root.
Single-file accept: `node --import tsx --test "<file>"`; name-scoped:
`node --import tsx --test --test-name-pattern="<regex>" "<file>"`.

## 1. Task Index (design ↔ deliverable map)

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1 `HookBus.childScope()` (constructor seed + method) | design §2 D1, KDD-1/KDD-2, §5 mechanism, AC-6/AC-7/AC-10 |
| 2 | D2 route the 4 sites + D3 usage-via-shared-event + real-guard tests | design §2 D2/D3/D4, KDD-3/KDD-4, AC-3/AC-4/AC-5/AC-8/AC-9 |

Two Phases: Phase 1 lands the kernel mechanism with unit tests (no behavior change to existing runs —
no site uses it yet, so `npm test` stays green). Phase 2 routes the four construction sites through it
and adds the real-guard integration tests. Each Phase is independently committable and leaves
`npm test` green.

## 2. Phase Breakdown

### Phase 1 — `HookBus.childScope()` kernel mechanism

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1+2 merged). Baseline `npm test` green.
- **Design refs:** §2 D1, KDD-1 (share gate filters + intra-run events), KDD-2 (suppression-by-absence),
  §5 (constructor-seed mechanism); AC-6, AC-7, AC-10.
- **Files:** `src/kernel/hooks.ts`, `test/hooks.test.ts`.
- **Task list (TDD order):**
  1. **(test)** `test/hooks.test.ts` — "childScope shares gate filters": a parent registers a
     `beforeToolCall` filter and an `afterToolCall` filter; `const child = parent.childScope()`;
     `await child.apply("beforeToolCall", decision, ctx)` runs the parent's filter (decision transformed);
     same for `afterToolCall`. *Invariant:* gate guards govern a child.
  2. **(test)** `test/hooks.test.ts` — "childScope does NOT share context filters": a parent registers a
     `transformContext` filter; `child.apply("transformContext", msgs, ctx)` returns `msgs` **unchanged**
     (passthrough — the point is absent on the child). Same for `transformRequest`. *Invariant:* child
     keeps a fresh context.
  3. **(test)** `test/hooks.test.ts` — "childScope shares intra-run events, suppresses lifecycle": a
     parent registers observers for `tool_end` and `agent_start`; `child.emit("tool_end", …)` fires the
     parent's `tool_end` observer; `child.emit("agent_start", …)` does **NOT** fire the parent's
     `agent_start` observer (no-op). Cover the full suppressed set
     {`agent_start`,`agent_end`,`session_start`,`session_shutdown`,`reload`} and a few intra-run names
     (`message`,`usage`,`turn_start`,`tool_start`,`tool_batch_end`,`text_delta`,`reasoning_delta`,`error`).
     *Invariant:* intra-run signals propagate; run-lifecycle boundaries do not.
  4. **(test)** `test/hooks.test.ts` — "childScope shares by reference; child bus is distinct": a
     `beforeToolCall` registered on the parent **before** `childScope()` is seen by the child (the chain
     is shared by reference). And the child is a distinct `HookBus` object (`child !== parent`). (Matches
     real usage: extensions register on the parent at activation, before any child spawns; children are
     bare and never register.)
  5. **(impl)** `src/kernel/hooks.ts`: add an optional constructor seed parameter, e.g.
     `constructor(seed?: { events?: Map<…>; filters?: Map<…> })`, that, when present, pre-populates
     `#events`/`#filters` by copying the provided entries (sharing the `Set`/`Registration[]` **references**,
     not deep-copying). Add `childScope(): HookBus<Events, Filters>` that builds the seed: filters =
     entries for `beforeToolCall` and `afterToolCall` (if present on this bus); events = entries for the
     intra-run names (all KernelEvents EXCEPT `agent_start`/`agent_end`/`session_start`/`session_shutdown`/
     `reload`), then `return new HookBus({ events, filters })`. Use a module-level constant for the
     suppressed-lifecycle name set and/or the shared-filter point set, with a comment tying it to KDD-1/2.
  6. **(verify)** `node --import tsx --test "test/kernel-surface.test.ts"` — `HookBus` already exported;
     a new method/constructor-param is not a new runtime export. Confirm `< 2200` lines.
- **Per-task accept commands:**
  - `node --import tsx --test "test/hooks.test.ts"`
  - `node --import tsx --test "test/kernel-surface.test.ts"`
  - `npm run typecheck`
- **Exit condition:** new `hooks.test.ts` childScope cases pass; `kernel-surface` green; `npm test` green
  (no existing run uses `childScope` yet, so behavior is unchanged).

### Phase 2 — Route the four sites + real-guard governance

- **Entry condition:** Phase 1 merged; `npm test` green.
- **Design refs:** §2 D2/D3/D4, KDD-3 (usage via shared event), KDD-4 (all four sites); AC-3, AC-4, AC-5,
  AC-8, AC-9.
- **Files:** `src/extensions/subagents.ts`, `src/extensions/dynamic-workflow.ts`,
  `src/extensions/sweep-edit.ts`, `src/extensions/templates.ts`, **`src/extensions/teams.ts`** (required —
  see task 5b), and the test files: a new `test/governed-subagents.test.ts` for the cross-guard
  integration tests, plus the existing `test/{subagents,teams,templates,dynamic-workflow,sweep-edit}.test.ts`
  for regression.
- **Task list (TDD order):**
  1. **(test)** Integration test (new `test/governed-subagents.test.ts`) — **flow-guard capability taint**
     (AC-3): build a host with `core-tools` + `flow-guard` (block mode) + `subagents`; drive the parent so
     the model spawns a child whose script (MockProvider) uses a `shell:exec` source tool then a
     `net:fetch`/`mcp:call` egress tool; assert the child's egress call is **blocked** (result isError /
     blocked message). **Precondition (required):** grant/allow `shell:exec` + `net:fetch` (build the host
     with capability fallback `allow`, e.g. `yolo: true`, or pre-grant those caps) so the **capability
     layer** does not block the egress first — otherwise both the test child AND the control would be
     blocked by capabilities (a false control). The point under test is that **flow-guard** (not the
     capability layer) blocks the egress in the governed child. Add a control: the same child built on a
     plain `new HookBus()` is **not** blocked by flow-guard. *Invariant:* the guard-bypass hole is closed
     for the capability trigger.
  2. **(test)** **write-guard not over-blocked** (AC-4): host with `write-guard` + `subagents`; a child
     reads an existing file then overwrites it → **not** blocked (shared `tool_end` populated `seen`); a
     child overwriting an unseen existing file → gated.
  3. **(test)** **call/result guards** (AC-5): a parent `bash-policy`-style `beforeToolCall` blocks a
     child's matching `bash`; a parent `afterToolCall` annotation appears on a child's result.
  4. **(test)** **lifecycle suppression + usage once** (AC-6/AC-8): a parent `agent_start` observer does
     NOT fire when a child runs; a parent `tool_end` observer DOES; with `cost` active, a child consuming
     mock tokens increments the parent cost **once** (no double count).
  5a. **(impl, `e.agent` in scope)** In `subagents.ts:78`, `dynamic-workflow.ts:492`, and
     `sweep-edit.ts:239`, add `hooks: e.agent.hooks.childScope()` to the `new Agent({…})` options. No
     other change (no explicit usage bubble — KDD-3).
  5b. **(impl, `templates.ts` + `teams.ts` threading — `e.agent` is NOT in scope at the site)**
     `templates.ts:377` is inside the module-scope `buildTemplateChild(parent, …)` whose `parent`
     parameter is a **structural type** (`{ providers, ui, logger, capabilities, model, providerName,
     tools }`, `templates.ts:342-350`), **not** an `Agent` — so `parent.hooks` does not exist. Thread it
     as an **OPTIONAL** field so callers that don't supply it degrade gracefully (there is a test helper
     `test/templates.test.ts:parentFor` (~677-696) that builds `parent` without hooks and must keep
     working un-edited):
     - (i) add `hooks?: HookBus<KernelEvents, KernelFilters>` (**optional**) to the `parent` param type
       and import the types from `../kernel/hooks.js` / `../kernel/events.js` (`.js` specifiers;
       `templates.ts:38` already imports `ToolDecision` from `events.js`).
     - (ii) at the site pass `hooks: parent.hooks?.childScope()` — when `parent.hooks` is absent this is
       `undefined`, and the `Agent` constructor already falls back to a fresh bus (`agent.ts:106`
       `opts.hooks ?? new HookBus()`), so the test helper still works (ungoverned, as before); production
       callers that supply `hooks` get a **governed** child.
     - (iii) make the production callers supply it: `templates.ts:468` (uses `e.agent`) → `hooks:
       e.agent.hooks`; and the `teams.ts` `parentFields()` helper — add `hooks: e.agent.hooks` to its
       returned literal (`teams.ts:553-561`) AND add `hooks: Agent["hooks"]` to its explicit return-type
       annotation (`teams.ts:545-552`), so `teams.ts:573`/`:591` children become governed. This is why
       `teams.ts` is an edit target (team children spawn via `buildTemplateChild`; KDD-4 requires all
       spawns governed). No other behavior change.
  6. **(verify)** Run the four sites' existing suites (`test/subagents.test.ts`, `test/teams.test.ts`,
     `test/templates.test.ts`, `test/dynamic-workflow.test.ts`, `test/sweep-edit.test.ts`) — all green
     (AC-9). They must still spawn/return correctly, now governed.
- **Per-task accept commands:**
  - `node --import tsx --test "test/governed-subagents.test.ts"`
  - `node --import tsx --test "test/subagents.test.ts" "test/teams.test.ts" "test/templates.test.ts" "test/dynamic-workflow.test.ts" "test/sweep-edit.test.ts"`
  - `npm run typecheck`
- **Exit condition:** the new integration tests pass (real guards govern children; lifecycle suppressed;
  usage counted once); the four sites' existing suites stay green; `npm test` green.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` import specifiers; strict TS
  (the seed param + childScope must type-check under `noUncheckedIndexedAccess`/`noImplicitOverride` — use
  a constructor param, NOT a subclass override); zero deps but jiti; offline tests via `node:test`/`tsx`.
  CLAUDE.md Hook-bus row + `hooks.ts` docstring are load-bearing — reconciled at F (childScope added).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phaseN):`; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI attribution.

## 4. Data and Fixture Dependencies

Reuse `MockProvider` function-responder form to script child turns (a child whose first turn calls a
source tool, second calls an egress/overwrite tool, etc.). The integration tests build a real host slice
via `createAgentHost`/`ExtensionHost` with the specific guards + `subagents` loaded (offline, `provider:
'mock'`). No new external fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at the end of every Phase.
- Phase 1 changes are inert to existing runs (no site uses `childScope` yet) — `test/hooks.test.ts` plus
  the full suite are the guard.
- Phase 2: the four sites' existing suites (`subagents`/`teams`/`templates`/`dynamic-workflow`/`sweep-edit`)
  are the regression net for "children still spawn and return correctly, now governed."
- `test/kernel-surface.test.ts` green after Phase 1 (`< 2200` lines; export list unchanged).

## L2 Review Log

- **Round 1** — **SEVERE**: `templates.ts` `buildTemplateChild` `parent` is not an Agent (no `.hooks`);
  `teams.ts` threading missing from the plan. + general (AC-3 needs capability precondition). Fixed
  (task 5 split 5a/5b; teams added; precondition added).
- **Round 2** — **SEVERE**: required `hooks` would break `test/templates.test.ts:parentFor` (4th caller)
  at runtime. Fixed: `hooks` made **optional** → graceful fresh-bus degrade; teams return-type annotation
  noted.
- **Round 3** — **zero severe, zero general** (clarifications: complete caller set + exhaustive event
  partition confirmed).
- **Round 4 (corroborating)** — **zero severe, zero general** (tsc declaration-emit empirically verified).
  Cap-convergence ([[three-loop-cap-convergence-policy]]) — two-generation satisfied. **L2 closed.**
