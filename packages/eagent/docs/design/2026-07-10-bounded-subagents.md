# Design — Bounded sub-agents: capability-based recursion guard (Batch B)

Slug: `2026-07-10-bounded-subagents`
Status: closed
Closing-commit: Batch B closeout on `chore/production-hardening` (code commits `ccecf65`/`267ba31` + closeout)
Closed-on: 2026-07-10
Deferred: finding — the KDD3 invariant pin hard-codes the nine known spawner names rather than enumerating the live registry (an accepted residual; a future capless spawner would slip both the strip and the pin; no repo issue tracker — tracked in the PR).

## 1. Background and Purpose

EAgent spawns sub-agents through the public `Agent` surface. Every spawner is supposed to prevent a
child from recursively spawning grandchildren (a runaway agent tree). The guard is implemented as a
**child tool-registry filter**, but four spawners filter by tool **name**, which is incomplete — a
child keeps every *other* spawn tool and can spawn again. This directly contradicts the module's own
claim that "a runaway tree is impossible" (`subagents.ts:22-24`).

The four leaky, name-based child-registry builders (verified):
- `subagents.ts:470-477` — `childRegistryFrom` strips only the tool literally named `spawn_agent`
  (`SPAWN_TOOL`, `:36`). A child keeps `run_team`, `run_workflow`, `spawn_template`, `best_of_n`,
  `launch_job`, `sweep_edit` — and can spawn again.
- `templates.ts:317-326` — `templateChildRegistry` strips a **name set** `{spawn_agent,
  spawn_template}` (`:70`); misses `run_team`, `run_workflow`, `best_of_n`, …
- `reasoning-search.ts:87-95` — strips four search names `{best_of_n, spawn_agent, tree_search,
  graph_search}`; a fork keeps `run_team`, `spawn_template`, `run_workflow`, `sweep_edit`, ….
- `dynamic-workflow.ts:313-319` — `workflowChildRegistry` strips only `run_workflow`.

The **correct pattern already exists** and is the model to hoist: `subagent-jobs.ts:61-69`
(`jobChildRegistry`) and `teams.ts:374-385` (`memberChildRegistry`) strip by **capability** —
`tool.capabilities?.some((c) => SPAWN_CAPS.includes(c))` where
`SPAWN_CAPS = ["agent:spawn", "workflow:run"]` (`teams.ts:105`). `test/teams.test.ts:331-354`
explicitly proves this excludes a `workflow:run` tool too ("not keyed on agent:spawn alone").

A second, orthogonal hole: `spawn_agent`'s `parallel`/`chain` modes accept an **unbounded**
`prompts` array — `asPrompts` (`subagents.ts:480-484`) rejects only empty/non-string arrays, no
length cap — so one call can fan out to thousands of children (DoS / cost blowout).

If we do nothing: the advertised recursion guarantee is false on the default tool set, and a single
`spawn_agent` call can exhaust resources. Both are table-stakes per the research (bounded
execution budgets; enforce the depth cap by *withholding the spawn tool*, not trusting the model).

## 2. Deliverables

- [ ] **D1** — New pure helper `src/extensions/lib/child-registry.ts` exporting `SPAWN_CAPS`
      (the single source of truth) and `childRegistryFrom(parentTools, opts?)` that strips every tool
      whose `capabilities` intersect `SPAWN_CAPS`, with an optional `{ allowlist?: string[] }` (only
      `templates` uses `allowlist`; no `extraTools` — `teams`' `board` re-add is not adopting this
      helper this batch, so that generality is deliberately omitted, Simplicity First). No
      `ExtensionAPI` import.
- [ ] **D2** — `subagents.ts` uses the lib helper (replace the name-based `childRegistryFrom`).
- [ ] **D3** — `templates.ts` uses the lib helper for `spawn_template`'s child registry (capability
      strip; keep the existing name-`allowlist` behavior via the helper's `allowlist` option).
- [ ] **D4** — `reasoning-search.ts` uses the lib helper for its fork registry (search tools declare
      `agent:spawn`, so the capability strip removes them — no name list needed).
- [ ] **D5** — `dynamic-workflow.ts` uses the lib helper for the `agent`-step child registry.
- [ ] **D6** — `teams.ts` imports `SPAWN_CAPS` from lib and **re-exports** it (back-compat for
      `subagent-jobs.ts:30`'s existing `import { SPAWN_CAPS } from "./teams.js"`); the single
      definition now lives in lib. `teams.ts`/`subagent-jobs.ts` working registry builders are
      otherwise **unchanged**.
- [ ] **D7** — Fan-out cap on `spawn_agent` `parallel`/`chain`: reject when `prompts.length` exceeds
      `subagents.maxFanout` (config, default 16, mirroring `teams.ts` `MAX_MEMBERS`).
- [ ] **D8** — Tests: a capability-based leak test (a child registry excludes a *second*,
      differently-named spawn tool); a behavioral test (a spawned child cannot call `run_workflow`);
      a fan-out-cap test; an **invariant test** asserting each built-in spawner tool
      (`spawn_agent`, `spawn_template`, `run_team`, `run_workflow`, `best_of_n`, `tree_search`,
      `graph_search`, `sweep_edit`, `launch_job`) declares a SPAWN_CAP (pins the KDD3 invariant the
      strip relies on); and updates to the four name-based registry tests to declare `capabilities`
      on their spawn stubs (mirroring `teams.test.ts:331`/`subagent-jobs.test.ts:240`) AND additionally
      assert a *second-named* spawn tool is stripped (so they cannot pass under the old name-based
      code). Each new behavioral test RED before its fix.

## 3. Scope Boundary (NOT in scope)

- **No separate depth/tree-counter mechanism.** The capability strip removes *all* spawn-class tools
  from a child's registry, so the child's spawn attempt hits the loop's **unknown-tool path**
  (`agent.ts:485-487`, "Unknown tool: …") — depth is bounded to one nesting level **by construction**.
  Note the bound comes from the tool's *absence*, not from a capability denial: a child inherits the
  parent's capability manager (`subagents.ts:334`), which has `agent:spawn` *granted*, so a spawn tool
  that were still present would pass the `require` check (`agent.ts:515-517`). This is why keying the
  strip on `Tool.capabilities` (the authoritative spawner marker the kernel enforces) and removing
  those tools is the correct guard — stricter than the research's 5-level cap. A depth counter would
  be redundant mechanism (Simplicity First). `Agent`/`AgentState` gain **no** `depth`/`parent` field
  (no kernel change).
- **No change to `teams.ts`/`subagent-jobs.ts` registry builders.** They are already correct; only
  the `SPAWN_CAPS` constant relocates to lib (single source). `teams`' intentional two-level nesting
  (root → lead → members, bounded by `MAX_MEMBERS`/`DELEGATE_CAP`) is preserved.
- **No global cost/token budget** (that is Batch F / `budget-cap`).
- **No new fan-out caps on `reasoning-search`/`teams`/`dynamic-workflow`** — they already carry local
  caps (`DEFAULT_MAX_N`/`MAX_NODES`, `MAX_MEMBERS`, plan structure). Only `spawn_agent`'s unbounded
  `prompts` array is capped.
- **No kernel change.** Only `src/extensions/*.ts`, a new `src/extensions/lib/child-registry.ts`, and
  `test/*`.

## 4. Key Design Decisions

### KDD1 — Capability-based vs name-based child-registry stripping
- **Problem:** name-based strips are per-site name lists that drift; four are already incomplete.
- **Options:** (A) strip by capability (`SPAWN_CAPS` intersection); (B) expand each site's name list to
  every current spawn tool; (C) leave per-site custom logic.
- **Choice: (A).** A capability is the *accurate, authoritative* marker of a spawner (the kernel
  reads `capabilities` at dispatch), so one filter covers every current and future spawn tool by
  shape — a new spawn tool cannot reopen the hole *so long as it declares a SPAWN_CAP* (the invariant
  stated in KDD3, test-pinned in D8). It matches the already-correct `teams`/`subagent-jobs` pattern. **Reject (B):** four hand-maintained name lists are exactly what
  drifted; adding a spawner would require editing four lists or the hole returns. **Reject (C):**
  duplication of a security-critical filter.

### KDD2 — Where the helper and `SPAWN_CAPS` live
- **Problem:** the correct pattern is duplicated in `teams.ts` and `subagent-jobs.ts`, and `SPAWN_CAPS`
  lives in an *extension* (`teams.ts`) that `subagent-jobs.ts` peer-imports.
- **Options:** (A) new `src/extensions/lib/child-registry.ts` owns `SPAWN_CAPS` + the builder;
  `teams.ts` imports and re-exports for back-compat. (B) keep `SPAWN_CAPS` in `teams.ts` and import it
  into lib. (C) duplicate the constant in lib.
- **Choice: (A).** `lib/` is the sanctioned home for logic two extensions share (pure, no
  `ExtensionAPI`); a single source of truth prevents the lib helper and `teams`/`jobs` from drifting.
  `teams.ts` re-exporting `SPAWN_CAPS` keeps `subagent-jobs.ts:30`'s existing import working
  unchanged. **Reject (B):** it leaves the security constant owned by an *extension* rather than the
  shared layer, so the single-source goal is unmet and the dependency direction is inverted (`lib/`
  importing an extension — a shape to avoid, though not absolute in the tree today, cf.
  `lib/decode.ts:27`). **Reject (C):** two definitions of a security constant drift. The decisive
  rationale for (A) is single source of truth, not lib purity.

### KDD3 — Depth budget: no separate mechanism
- **Problem:** the audit suggested a "process-wide depth/breadth budget"; is a depth counter needed?
- **Options:** (A) rely on the capability strip (a child has no spawn tools → cannot spawn → depth
  bounded to one level); (B) add an `AsyncLocalStorage` depth counter + `maxDepth` config, checked per
  spawn.
- **Choice: (A).** The strip makes runaway depth *structurally impossible* — a child's registry has
  no spawn tool, so any spawn attempt is an unknown tool (`agent.ts:485-487`) — so a counter adds a
  redundant cross-agent mechanism for a guarantee already provided, and it would have to special-case
  `teams`' intentional two-level nesting. **Reject (B):** new mechanism, more state, no additional
  safety over the strip. (Breadth is handled by KDD4; cost by Batch F.)
- **Invariant this relies on (stated explicitly):** *every child-spawning tool declares a SPAWN_CAP.*
  All six extension child-spawn sites comply — `subagents.ts:73`, `subagent-jobs.ts:131`,
  `sweep-edit.ts:239`, `dynamic-workflow.ts:493`, `templates.ts:387` (reused by teams), and
  `reasoning-search.ts:184` (shared by the three search tools); the root construction at `host.ts:248`
  is not a SPAWN_CAP-gated tool and is excluded. A future spawner that declared neither cap would slip
  the filter — the same drift axis the name lists suffer, moved to capabilities — so D8 adds a test
  pinning that each built-in spawner tool declares a SPAWN_CAP.

### KDD4 — Fan-out (breadth) cap on `spawn_agent`
- **Problem:** `spawn_agent` `parallel`/`chain` accepts an unbounded `prompts` array.
- **Options:** (A) reject when `prompts.length > subagents.maxFanout` (config, default 16); (B) no cap;
  (C) a global breadth budget across all spawners.
- **Choice: (A).** `spawn_agent` is the one unbounded fan-out; a per-call configurable cap (default
  16, matching `teams` `MAX_MEMBERS`) is the minimal breadth guard, with a clear error and a config
  lever to raise it. **Reject (B):** leaves a DoS/cost hole (thousands of children in one call).
  **Reject (C):** a global breadth budget is a new mechanism for marginal gain over per-call caps,
  and the other fan-outs already have local caps.

## 5. Dependencies and Assumptions

- **`Tool.capabilities`** is an optional `string[]` on `Tool` (`types.ts:149`), NOT on `ToolSpec`; the
  kernel enforces it at dispatch (`agent.ts:515-517`). The filter reads `tool.capabilities`.
- **`ToolRegistry`** (`registry.ts:19-54`): `register`, `get`, `has`, `list()` (returns active tools
  sorted by name — deterministic). The helper builds `new ToolRegistry()` and `register`s survivors.
- **`SPAWN_CAPS = ["agent:spawn", "workflow:run"]`** (currently `teams.ts:105`) — the exhaustive
  spawn-class capability set; every spawner in the tree declares one of these (verified inventory:
  `spawn_agent`, `spawn_template`, `run_team`, `best_of_n`/`tree_search`/`graph_search`,
  `run_workflow`, `sweep_edit`, `launch_job`…). Stripping every SPAWN_CAP-carrying tool from a child
  removes two classes: (a) genuine child-spawners (which a leaf child must not reach — the fix), and
  (b) the job-lifecycle tools `job_status`/`collect_job`/`cancel_job` (`subagent-jobs.ts:236/267/306`),
  which also declare `agent:spawn` but do not spawn. Only `launch_job` is `rootOnly()`-gated
  (`subagent-jobs.ts:184`); the other three are **not**, so today a `spawn_agent` child (whose
  name-based strip removes only `spawn_agent`) *can* call them. So the strip is a **real behavior
  change for class (b), not a no-op** — but a beneficial one: jobs are a root-scoped, in-process,
  off-by-default facility, and a leaf sub-agent has no legitimate need to manage the root's job queue,
  so removing that cross-agent reach is intended hardening. No benign tool a *non-spawning* child
  legitimately needs carries a SPAWN_CAP.
- **lib/ import depth** is `../../kernel/...` (lib is one level below extensions).
- **Config** via `e.config` (`subagents.maxFanout`, env `EAGENT_SUBAGENTS_MAX_FANOUT`).
- **Measured baseline (this branch, post-Batch-A):** `npm test` 1288 pass / 0 fail / 1 skip;
  typecheck 0; eval 5/5; build 0.

## 6. Relationship with Existing Designs

- `docs/design/2026-07-09-subagent-jobs.md` — established the capability-based `jobChildRegistry` +
  `rootOnly()` this batch hoists. No conflict; this batch generalizes that correct pattern to the
  four leaky sites and relocates the shared `SPAWN_CAPS` to lib.
- No conflict with `teams`/`templates`/`reasoning-search`/`dynamic-workflow` designs (no design docs);
  this batch tightens their child registries to the already-correct capability model. No warning
  markers required.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (capability strip):** `childRegistryFrom([spawn_agent(agent:spawn), run_workflow(workflow:run),
  run_team(agent:spawn), helper(no-caps)])` yields a registry with `has("helper")===true` and
  `has` false for all three spawn tools. RED before the fix for the name-based builders. Command:
  `node --import tsx --test test/child-registry.test.ts`.
- **AC2 (behavioral, no grandchildren):** a live `spawn_agent` whose child is given a parent tool set
  containing a *second* spawn tool (`run_workflow`) — the child's attempt to call `run_workflow`
  reports "Unknown tool" (the tool is absent from the child registry). RED before D2. Command:
  `node --import tsx --test test/subagents.test.ts`.
- **AC3 (fan-out cap):** `spawn_agent {mode:"parallel", prompts:[…17…]}` with default `maxFanout=16`
  returns an error result naming the cap; `prompts:[…16…]` is accepted; setting
  `subagents.maxFanout` raises the bound. Command: `node --import tsx --test test/subagents.test.ts`.
- **AC4 (no name-based strip remains):** AC4 ≡ AC1 ∧ AC2 ∧ the four reworked per-site tests all green,
  **plus** a mechanical **positive** gate (`-a` per the macOS non-ASCII grep gotcha):
  `grep -la 'lib/child-registry.js' src/extensions/subagents.ts
  src/extensions/templates.ts src/extensions/reasoning-search.ts src/extensions/dynamic-workflow.ts`
  lists **all four** files (each now imports and delegates to the shared helper). Also verified by the
  D8 invariant test asserting each built-in spawner tool declares a SPAWN_CAP.
- **AC5 (single source, no regression):** `teams` and `subagent-jobs` still strip correctly —
  `test/teams.test.ts` and `test/subagent-jobs.test.ts` pass unchanged (SPAWN_CAPS relocation is
  behavior-neutral; `teams.ts` re-exports it).
- **AC6 (gates):** `npm test` green (1288 prior pass + new tests, 0 fail); `npm run typecheck` 0;
  `npm run eval` 5/5; `npm run build` 0. The four updated name-based registry tests
  (`subagents.test.ts:186`, `templates.test.ts:275/704`, `dynamic-workflow.test.ts:370`) are
  reworked to declare `capabilities` and still pass.

## 8. Risks and Rollback

- **R1 — the capability strip removes MORE tools than the name strip did** (all spawn-class, not one
  name). This is a **real behavior change**, not a no-op: besides the spawners (the intended fix), it
  also removes the ungated job-lifecycle tools `job_status`/`collect_job`/`cancel_job` from a child
  (see §5). That removal is intended hardening (a leaf child managing the root's in-process job queue
  is not a legitimate pattern). Regression check (impl must confirm): no existing test or documented
  flow spawns a child and then calls a job-lifecycle tool *from inside that child*. `teams`' lead
  registry *does* route through the D3-modified `templateChildRegistry` (`teams.ts:594` passes no
  `baseRegistry`), but its downstream `excludeCapabilities: SPAWN_CAPS` (`templates.ts:371-378`) — a
  strict superset of the old `{spawn_agent, spawn_template}` name strip — keeps the lead's net
  registry byte-identical, so `teams` behavior is unchanged (AC5 pins it). Rollback: revert per-site
  adoption.
- **R2 — relocating `SPAWN_CAPS` could break importers.** Mitigated: lib owns it, `teams.ts`
  re-exports it, so `subagent-jobs.ts`'s existing `./teams.js` import is unchanged; AC5 pins
  `teams`/`jobs` behavior. Rollback: revert D6.
- **R3 — the fan-out cap could reject a legitimate large parallel spawn.** Default 16 is generous
  (matches `teams`); it is configurable via `subagents.maxFanout`. The error is explicit. Rollback:
  revert D7.
- **R4 — updated tests could mask a real regression** if reworked carelessly. Mitigation: the reworked
  tests must declare `capabilities` on the spawn stubs (the whole point) and additionally assert a
  *second-named* spawn tool is stripped (the actual leak), so they can't pass under the old name-based
  code. Rollback: revert the test edits.
- **Overall:** every change is extension + lib + tests; each site independently revertible; branch
  `chore/production-hardening`, PR-gated.
