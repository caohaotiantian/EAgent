# Design: Agent Teams (multi-agent orchestration)

Slug: `2026-06-25-agent-teams`
Status: draft (L1)
Builds on: `docs/design/2026-06-25-templates.md` (closed) — the named role unit teams orchestrate.

## 1. Background and Purpose

Cycle 1 shipped **agent templates**: named, file-based, scoped role-agents you
can spawn (`spawn_template`) or become. Its Scope Boundary named the explicit
follow-up: *"multi-agent team orchestration — a coordinator that runs several
template-backed agents collaboratively, with role hand-off / shared task state."*
This is that cycle.

A **team** composes several template-backed roles into a collaboration on one
complex task. The kernel already has two adjacent mechanisms, and a team is
neither:

- `subagents`/`spawn_agent` — raw single/parallel/chain prompt fan-out (no roles,
  no shared state).
- `dynamic-workflow`/`run_workflow` — a **script/DAG holds the plan**; the model
  emits the whole dependency graph of anonymous steps up front (data-flow).

Per Claude Code's own taxonomy (design input C below), **agent teams** are the
third thing: *"a lead agent supervising peer sessions,"* where *"the lead agent
decides turn by turn,"* intermediate results live in *"a shared task list,"* and
the repeatable unit is *"the team definition."* That is exactly what cycle 1's
templates set up the substrate for and what this cycle delivers.

The user's requirements for this cycle (recorded at intent-confirmation):
1. **Support the full set of coordination patterns** reported by the two
   coordination-pattern sources (design inputs A and B below), and
2. **give the agent the ability to select and apply the most appropriate pattern
   for the task at hand**;
3. a **dedicated shared-board tool** for shared task state;
4. **both** file-based and programmatic definition/invocation, *"like the
   workflows function in Claude Code."*

Here, "support a pattern" means **enactable + documented + steerable** (a member
playbook the lead applies through concrete primitives, optionally pinned), **not
deterministically enforced** by a per-pattern scheduler (Decision 4.3). If we do
not do this: templates remain single specialists with no way to collaborate on a
task that needs decomposition, parallelism, cross-checking, or synthesis.

## 2. Deliverables

- [ ] `src/extensions/teams.ts` — one extension exporting pure, offline-testable
  functions (`parseTeam`, `validateTeam`, `scanTeams`, `resolveTeam`,
  `buildLeadPrompt`, `memberChildRegistry`, `makeBoard`, `PATTERN_PLAYBOOK`) plus
  a default `activate(e)` that registers: a `run_team` tool (model-driven; file
  **or** inline roster), a `/team` command (`list`/`show`/`run`, with `/teams`
  alias), and an `EAGENT_TEAMS=off` kill switch. The board and member-`delegate`
  tools are **per-run** tools built inside `run_team` (not globally registered).
- [ ] `teams` registered in `BUILTIN_EXTENSIONS` (`src/host.ts`), placed
  immediately **after `templates`** (it reuses the templates resolver and is the
  next layer of the multi-agent stack).
- [ ] One small **construct-only** helper added to `src/extensions/templates.ts`
  — `buildTemplateChild(resolved, parent, opts?)` (contract in §5) — factoring out
  the child `Agent` construction at `templates.ts:399-412` so teams reuses it
  instead of duplicating it. `spawn_template` is refactored to call it with **no
  opts**, producing a byte-identical child (AC-11). (The only edit to a cycle-1
  file; surgical, additive, behavior-preserving.)
- [ ] `test/teams.test.ts` — offline `node:test`/`tsx`/`MockProvider` suite,
  AC-numbered, covering §7.
- [ ] `README.md` — one extension-table row (Capability column `agent:spawn`), and
  the `45`→`46` count updates (`README.md:338`, `CLAUDE.md:65`, `CLAUDE.md:79`).
- [ ] No kernel change; no new npm dependency; no new capability in the kernel
  vocabulary (reuse `agent:spawn`).

## 3. Scope Boundary (NOT in scope)

- **A dedicated asynchronous message-bus / event broker** (the pub/sub
  "Message Bus" / "Event-Driven" pattern in inputs A/B). A true broker needs
  persistent async infrastructure beyond a single bounded agent run; EAgent has
  no such primitive. The **shared-board / blackboard** pattern (Decision 4.5)
  covers the collaborative decentralized-shared-state subset those patterns
  target. This is the one requested pattern realized only in its shared-state
  form, and it is fenced here explicitly (Decision 4.4).
- **N hard-coded deterministic schedulers** (one code path per pattern). Patterns
  are realized as a **playbook the lead applies via primitives**, not separate
  scheduler implementations (Decision 4.3). A `pattern` field *steers* the lead;
  it does not select a code path. Patterns are guided, not guaranteed.
- **Nested teams** (a member that is itself a team / orchestrates). Members are
  template-backed leaf agents; the capability-driven recursion guard (4.6)
  forbids a member from reaching any `agent:spawn` tool.
- **Cross-run persistent team memory.** The shared board is **run-scoped**; not
  persisted across runs (cross-session memory is `memory`/`handoff`'s job).
- **Team inheritance / composition between teams** (`extends`). Teams are flat in
  v1 (templates already provide role-level inheritance).
- **Changing `spawn_template`'s existing (narrower) recursion guard.** Cycle 1's
  `spawn_template` strips only `spawn_agent`/`spawn_template`; that behavior is
  unchanged here (Surgical Changes). Only teams' stricter `delegate` uses the
  capability-driven guard (4.6). The `buildTemplateChild` refactor must keep
  `spawn_template` byte-identical (AC-11).
- **A `become`-style "the whole session joins a team."** Teams are delegated-to,
  not applied to the live session.
- **Quality budget:** not a hot path. No latency/throughput budget. The measured
  attributes are bounded by Decision 4.8's hard caps: per-run agent/token cost
  (lead `maxTurns`, delegate cap, member `maxTurns` ceiling), the board (entry +
  byte caps), and the roster (member-count cap). The lead prompt's **content** is
  asserted by AC-4; the `PATTERN_PLAYBOOK` is a fixed-size constant (bounded by
  construction) and the roster section is bounded by the member-count cap (AC-9) —
  so the prompt is content-checked, not separately size-budgeted.

## 4. Key Design Decisions

### 4.1 Ship as an extension, not a kernel primitive

- **Problem:** Where does team logic live?
- **Options:** (a) a kernel primitive; (b) a single extension `teams.ts`.
- **Choice:** (b). **Rationale:** identical to cycle 1 (Decision 4.1 there) — the
  kernel runs *one* loop; orchestration is policy composed from public seams
  (`Agent` constructor, tool registry, the templates resolver, the loop's
  concurrent tool-batch). The 2,200-line kernel ceiling stands. **Reject (a):** a
  primitive for policy that composes from existing primitives.

### 4.2 File-based definition **and** programmatic inline roster (both)

- **Problem:** How is a team defined and invoked? (User: *both*, "like Claude
  Code workflows" — saved + inline `args`.)
- **Options:** (a) file-only; (b) programmatic-only; (c) both.
- **Choice:** (c). A team file `~/.eagent/teams/<name>.md` — frontmatter
  (`name`, `description`, `lead` *(optional template; default a generic
  coordinator)*, `members` *(comma list of template names)*, `pattern`
  *(optional; a `PATTERN_PLAYBOOK` key or `auto`, default `auto`)*) + markdown
  body = mission/coordination notes. Parsed with the same single-line frontmatter
  parser templates uses (`skills.ts:160` idiom), validated at scan time
  (Decision 4.10). `run_team` ALSO accepts an **inline roster**
  `{ lead?, members: string[], pattern?, mission }`. **Validation asymmetry
  (intentional):** the **file** `description` is angle-bracket-guarded at scan
  (it flows into the `/team list` catalog and the lead prompt — the templates 4.9
  injection surface). The **inline roster** is *model-originated* — already inside
  the trust boundary, exactly like `spawn_agent`'s free-text `prompt` and a
  template body — so its `mission` is not angle-bracket-validated; but its
  `members[]` are validated as **known template names** (an unknown name is a
  typed error) and its `pattern` is validated against the playbook keys, on both
  the file and inline paths. **Rationale:** mirrors cycle-1 templates (file +
  tool) and Claude Code's saved-workflow + inline-`args` model. **Reject (a)/(b):**
  the user asked for both; each alone drops a needed mode.

### 4.3 Coordination = an LLM **lead + primitives + a pattern playbook** (the agent selects/applies the pattern), NOT N coded schedulers

- **Problem:** How are the many coordination patterns supported, and how does
  "the agent select and apply the most appropriate pattern" (user's explicit
  ask) actually work?
- **Options:**
  - (a) **Lead + primitives + playbook.** `run_team` builds one LLM **lead
    agent** (from the `lead` template) whose context carries the mission, the
    member **roster**, and a **pattern playbook** (the patterns + when-to-use +
    selection heuristic). The lead is given concrete orchestration **primitives**
    — `delegate` (spawn a member on a subtask; default `parallel` executionMode,
    so several `delegate` calls in one assistant turn run concurrently via
    `Promise.all`, `agent.ts:324` — this IS the fan-out realization), and the
    shared **board** — and it *selects and enacts* the pattern by composing them.
    A pinned `pattern` prepends a directive to use that pattern.
  - (b) **N deterministic schedulers**, one code path per pattern, chosen by a
    `pattern` enum.
  - (c) **Reuse `dynamic-workflow`'s DAG** as the team engine.
- **Choice:** (a). **Rationale:** it *directly* realizes "the agent selects and
  applies the most appropriate pattern" — selection is an LLM decision over a
  documented playbook, not a config switch — and is **minimal mechanism**: the
  same two primitives (plus native concurrent batching) express orchestrator,
  parallel, sequential, generator-verifier, consensus, and blackboard
  (Decision 4.4), so breadth lives in *playbook text*, not six code paths. It is
  the EAgent bet (intelligence in the agent, mechanism small) and matches Claude
  Code's agent-teams model ("the lead decides turn by turn"). Each pattern is
  mechanically **enactable** (parallel is real `Promise.all` fan-out, not prose),
  **observable** (via the board + member results), and **steerable** (pinned
  `pattern`). **Reject (b):** six scheduler implementations is a large, rigid
  surface that *removes* the agent's pattern choice — the opposite of the ask.
  **Reject (c):** `dynamic-workflow` is the *script-holds-the-plan* tool
  (deterministic DAG up front); teams is *lead-decides-turn-by-turn* (input C's
  own distinction). Complementary, not wrapped. **Trade-off (surfaced):**
  lead-driven patterns are *guided, not guaranteed* — the lead could misapply a
  pattern. Mitigations: the selection heuristic, the optional pinned `pattern`,
  and that a misapplied pattern still returns a (sub-optimal) answer, not a crash.
  A hard-guaranteed scheduler is a future option (or use `dynamic-workflow`);
  out of v1 scope.

### 4.4 The supported pattern set (the playbook)

- **Problem:** Which patterns from inputs A and B does the playbook document, and
  how faithfully?
- **Options:** (a) all patterns including a real message-bus broker; (b) the
  subset realizable through the lead+primitives+board model; (c) a minimal three.
- **Choice:** (b). `PATTERN_PLAYBOOK` is a fixed constant documenting, each with a
  one-line when-to-use, the deduplicated union realizable via the primitives:
  - **orchestrator** (supervisor/hierarchical) — lead decomposes, delegates,
    synthesizes. *(A: Orchestrator-Subagent, Agent Teams; B: Hierarchical.)*
  - **parallel** (fan-out/fan-in) — delegate to several members at once, merge.
    *(B: Parallel.)*
  - **sequential** (pipeline) — members in order, each consuming the prior + board.
    *(B: Sequential.)*
  - **generator-verifier** — a member produces, another critiques; loop to a bar.
    *(A: Generator-Verifier.)*
  - **consensus** (vote) — several members answer the same question; lead takes a
    majority/quorum. *(B: Consensus.)*
  - **blackboard** (shared-state) — members read/write the board across rounds
    until a termination condition. *(A: Shared State; B: Event-Driven, in its
    shared-state realization.)*
  Plus the selection heuristic (input A in spirit): *"start with orchestrator; if
  subtasks are independent and speed matters, parallel; if they must build in
  order, sequential; if quality is critical, generator-verifier or consensus; if
  agents must build on each other's findings continuously, blackboard."*
  **Reject (a):** an async pub/sub broker is out-of-scope infra (§3); its
  collaborative subset is the blackboard. **Reject (c):** the user asked for broad
  support.

### 4.5 Shared task state = a per-run **board tool** shared by lead and members

- **Problem:** How is "shared task state" realized? (User: *dedicated board
  tool*.)
- **Options:** (a) a dedicated board tool; (b) reuse `todo`/`memory`; (c)
  lead-held only.
- **Choice:** (a). A **run-scoped** shared board: a plain in-memory structure
  (`makeBoard()`) created per `run_team` call, exposed through a `board` tool
  (actions: `post {note, by?}` → returns a new id; `list`; `update {id, status?,
  note?}`) given to **both the lead and every member** (a member's write is
  visible to a later read — the blackboard substrate). **Board ops are
  synchronous (no internal `await`):** the id counter and entry append happen in
  one non-yielding step, so concurrent `post`s from a *parallel* `delegate` batch
  (Decision 4.6) cannot interleave — each gets a distinct id (AC-7). **Rationale:**
  realizes "shared task state" self-containedly, is the substrate decentralized
  patterns need, stays run-scoped. **Reject (b):** couples teams to those
  extensions' lifecycles. **Reject (c):** "shared" would be implicit. Board
  entries are count + byte capped (Decision 4.8).

### 4.6 Member delegation reuses the templates child-builder; capability-driven recursion guard

- **Problem:** How does the lead spawn a member, and how is the leaf-only
  guarantee actually enforced?
- **Options:** (a) reuse `spawn_template` directly (any template, name-list
  guard); (b) a team-scoped `delegate` tool with a capability-driven guard.
- **Choice:** (b). A per-run `delegate` tool ({member, task}, **default
  `parallel` executionMode** — never `sequential`, so batched calls fan out via
  `Promise.all`) that: resolves the named member **against the team roster only**
  (off-roster → typed error listing the roster), builds the child via
  `buildTemplateChild` (§5) with `memberChildRegistry`, runs it, returns its final
  text.
- **`memberChildRegistry`** (the recursion guard) is **capability-driven, not a
  name list:** starting from the member template's tool allow-list ∩ the parent
  tools, it **excludes every tool whose `spec.capabilities` intersects the
  spawn-class set `SPAWN_CAPS = {"agent:spawn", "workflow:run"}`** — which
  auto-covers `spawn_agent` / `spawn_template` / `sweep_edit` / `delegate` /
  `run_team` (all `agent:spawn`) **and `run_workflow`** (which declares
  `workflow:run`, not `agent:spawn` — `dynamic-workflow.ts:140`), plus any future
  spawn-class tool — and then **adds the shared board tool**. A member therefore
  can reach **no** agent-spawning or workflow-running tool, closing the
  recursion/cost escape. (Keying only on `agent:spawn` would miss `run_workflow`;
  both orchestration capabilities must be in the set.) The predicate is **set
  intersection** with `SPAWN_CAPS` (a tool is excluded iff *any* of its declared
  capabilities is in the set), **not** subset — so `sweep_edit`'s
  `["fs:write","agent:spawn"]` is excluded via its `agent:spawn` member while a
  plain `write` tool (`fs:write` only) is retained. **Rationale:** the existing single-family child registries
  (`templateChildRegistry`, `subagents.childRegistryFrom`,
  `dynamic-workflow.workflowChildRegistry`) each strip only their *own* family;
  teams promises to strip *all* spawn tools, so it must NOT copy that pattern — a
  capability predicate is the self-maintaining guard. **Reject (a):**
  `spawn_template` is unscoped (any template), injects no board, and strips only
  two names — it would let a member be any template and reach `run_workflow`.

### 4.7 Invocation surface: `run_team` tool + `/team` command

- **Problem:** The model-facing and human-facing entry points.
- **Options:** (a) one surface (tool-only or command-only); (b) both, over one
  `runTeam(resolved, task)` core.
- **Choice:** (b). A `run_team` tool (`capabilities:["agent:spawn"]`; arg = a
  `team` name **or** an inline roster, plus `task`) for model-driven use, and a
  `/team` command (`list` / `show <name>` / `run <name> <task>`, with `/teams`
  alias) for humans. Mirrors cycle-1 templates' tool+command symmetry and Claude
  Code's saved-`/name` + inline forms. **Reject (a):** the model needs a tool and
  humans need a command; a single surface drops one audience. `agent:spawn` (not
  `workflow:run`) is the gate because `run_team` spawns *member agents*, exactly
  like `spawn_template`/`spawn_agent` (Decision 4.9).

### 4.8 Safety and bounds

- **Problem:** Multi-agent orchestration can run away (cost, recursion, loops).
- **Options:** (a) bounded with hard caps; (b) unbounded.
- **Choice:** (a). Each a hard bound:
  - **Recursion:** members reach no `agent:spawn` tool (capability-driven guard,
    Decision 4.6) — a member cannot orchestrate.
  - **Lead length:** the lead runs with a capped `maxTurns` (default 16).
  - **Delegate cap:** a per-run counter, **checked and incremented synchronously
    at the top of `delegate.execute` before any `await`** (race-free under the
    concurrent fan-out batch), rejects the (cap+1)-th delegation (default cap 32,
    mirroring `dynamic-workflow`'s `MAX_STEPS`).
  - **Member length:** `buildTemplateChild`, for teams, imposes a **member
    `maxTurns` ceiling** (default 8) = `min(template.maxTurns ?? ceiling,
    ceiling)`, so a member template with a large/absent `maxTurns` cannot blow the
    per-run cost (worst case is then lead 16 × delegate-cap 32 × member 8, all
    finite, with no grandchildren).
  - **Roster:** a **member-count cap** (default 16) — a team file or inline roster
    with more members than the cap is rejected at resolve.
  - **Board:** entry-count + byte caps.
  - **Kill switch:** `EAGENT_TEAMS=off` (run_team fails, `/team` refuses).
  **Reject (b):** a runaway team is the dominant failure mode.

### 4.9 Reuse `agent:spawn`; add no new capability

- **Problem:** Does teams need a new capability?
- **Options:** (a) a new `team:run`; (b) reuse the existing vocabulary.
- **Choice:** (b). Spawning members is `agent:spawn` (the extension
  `grantCapability("agent:spawn")`; `run_team`/`delegate` declare it) — the same
  gate `spawn_template`/`spawn_agent` use, since teams spawns member *agents*
  (not a `run_workflow`-style DAG, so not `workflow:run`). Reading team/template
  files is host-pre-granted `fs:read`. **Reject (a):** expands the fixed security
  vocabulary for no new authority; there is no authoring tool ⇒ no write
  capability.

### 4.10 One teams directory + env override, validate at scan time

- **Problem:** Where are teams found, and how is the injection surface closed?
- **Options:** (a) layered dirs; (b) one dir + env override, scan-time validation.
- **Choice:** (b). `EAGENT_TEAMS_DIR ?? join(homedir(), ".eagent", "teams")`
  (mirrors `templatesRoot`). `validateTeam` runs at scan time (no authoring
  boundary; a team `description` flows into the `/team list` catalog and the lead
  prompt): reject non-kebab `name`, `<`/`>` in `description`, an unknown `pattern`
  value, empty `members`, a roster over the member-count cap, unknown keys; a
  failing file is skipped with a logged warning (mirrors templates Decision 4.9,
  the angle-bracket injection guard). **Reject (a):** unrequested layering; and
  trust-on-disk re-opens the injection vector cycle-1 closed.

## 5. Dependencies and Assumptions

- **Builds on `docs/design/2026-06-25-templates.md` (closed).** Reuses, from
  `src/extensions/templates.ts`: `resolveTemplate`, `templateChildRegistry`,
  `scanTemplates`, `templatesRoot`, the `Template`/`ResolvedTemplate` types, and a
  **new construct-only** helper `buildTemplateChild` (Deliverable). From
  `src/extensions/subagents.ts`: `scopedCapabilities` (exported, `subagents.ts:293`).
- **`buildTemplateChild` contract (the cycle-1 refactor).** Factor out the
  `new Agent({...})` construction at `templates.ts:399-412` into:
  `buildTemplateChild(resolved: ResolvedTemplate, parent: { providers, ui, logger,
  capabilities, model, providerName, tools: Tool[] }, opts?: { baseRegistry?:
  ToolRegistry; extraTools?: Tool[]; excludeCapabilities?: string[];
  maxTurnsCeiling?: number }): Agent`. It **constructs and returns the `Agent`**
  (the caller runs `.run()` — so both `spawn_template` and `delegate` keep their
  own run/return logic; the cited boundary is 399-412, the construction only).
  Behavior: base registry = `templateChildRegistry(parent.tools, resolved.tools)`
  unless `baseRegistry` given; then **remove** any tool whose `spec.capabilities`
  intersects `excludeCapabilities`; then **add** `extraTools`; `maxTurns =
  maxTurnsCeiling ? min(resolved.maxTurns ?? maxTurnsCeiling, maxTurnsCeiling) :
  resolved.maxTurns`; capabilities/model/provider/thinking/systemPrompt exactly as
  today. **`spawn_template` calls it with no `opts`** ⇒ byte-identical to the
  current child (no exclusions, no extras, no ceiling) — AC-11. **`delegate`
  calls it with** `excludeCapabilities: ["agent:spawn", "workflow:run"]`,
  `extraTools: [boardTool]`, `maxTurnsCeiling: 8`.
- **Design inputs (external, fetched during L1 pre-step):**
  - **A** — Anthropic, "Multi-agent coordination patterns" (claude.com/blog):
    Generator-Verifier, Orchestrator-Subagent, Agent Teams, Message Bus, Shared
    State; *"start with orchestrator-subagent… evolve toward other patterns."*
  - **B** — Microsoft AZD-for-beginners ch.06 "coordination-patterns": Sequential,
    Parallel, Hierarchical, Event-Driven, Consensus; per-pattern selection notes.
  - **C** — Claude Code "dynamic workflows" docs (code.claude.com): the
    Subagents/Skills/**Agent teams**/Workflows distinction (who holds the plan;
    where intermediate results live; the repeatable unit) and the saved-`/name` +
    inline-`args` model. Design rationale, not runtime dependencies.
- **Code assumptions (verified):** the agent loop dispatches a batch of `parallel`
  (default) tool calls concurrently via `Promise.all` and only serializes when a
  `sequential` tool is in the batch (`agent.ts:314-324`; `types.ts:147`), so the
  lead enacts fan-out natively; `spawn_template` constructs a child from a
  resolved template at `templates.ts:399-414`; per-tool registries isolate a
  child's visible tools (`registry.ts`). The spawn-class tools and their declared
  capabilities (verified): `spawn_agent` (`subagents.ts:131`), `spawn_template`
  (`templates.ts:376`), `sweep_edit` (`sweep-edit.ts:151`) all declare
  `agent:spawn`; **`run_workflow` declares `workflow:run`** (`dynamic-workflow.ts:140`),
  *not* `agent:spawn`. The guard (4.6) therefore keys on the set `{agent:spawn,
  workflow:run}` to cover all of them.
- **Runtime:** Node `fs`/`os`/`path` + global only; zero new npm deps.

## 6. Relationship with Existing Designs

- **`docs/design/2026-06-25-templates.md` (closed)** — direct foundation; teams
  reuses its resolver and adds one construct-only helper to it. The
  `spawn_template` refactor is behavior-preserving (AC-11). No conflict; additive.
- **`src/extensions/dynamic-workflow.ts`** — *distinct, complementary* (input C's
  distinction): `run_workflow` = a deterministic DAG the model emits up front
  (script holds the plan); a **team** = an LLM lead deciding turn-by-turn over a
  shared board (the team definition is the repeatable unit). Teams does **not**
  wrap or duplicate the DAG scheduler. A member is *barred* from calling
  `run_workflow` by the capability guard (4.6). Flagged so a reviewer does not
  read teams as a `dynamic-workflow` reimplementation.
- **`src/extensions/subagents.ts`** — teams reuses `scopedCapabilities`;
  `spawn_agent` remains the low-level fan-out primitive. No conflict.
- **`src/extensions/handoff.ts`** — *naming caution, not a conflict*: `handoff` is
  session-*resume* documents, NOT agent-to-agent hand-off. This design's
  "coordination/hand-off" is intra-run delegation via `delegate`; it does not
  touch `handoff`. The README row says "team orchestration" to avoid drift.
- **No prior agent-team design exists**; terminology anchors are the templates
  design, CLAUDE.md, and inputs A/B/C.

## 7. Acceptance Criteria (each offline-automatable in `test/teams.test.ts`)

- **AC-1 parse:** `parseTeam(md, "fallback")` returns
  `{name, description, lead?, members: string[], pattern?, mission}` with members
  comma-split/trimmed, `pattern` a string, `mission` = the body after the closing
  fence; a no-fence file degrades (empty frontmatter / body as mission) without
  throwing.
- **AC-2 scan + validate (injection guard):** `scanTeams(dir)` returns valid teams
  sorted; a missing dir → `[]`; a file failing `validateTeam` — non-kebab `name`,
  `<`/`>` in `description`, an unknown `pattern`, empty `members`, a roster over
  the member-count cap, or an unknown key — is excluded (with a logged warning).
- **AC-3 resolve:** `resolveTeam(name, teamCatalog, templateCatalog)` resolves each
  member name to a template (via `resolveTemplate`) and the `lead` (or a default
  coordinator); an unknown member/lead template, or a roster over the member-count
  cap, → a typed error naming it; returns `ResolvedTeam {name, mission, pattern,
  lead: ResolvedTemplate, members: {name, template: ResolvedTemplate}[]}`.
- **AC-4 lead prompt (content):** `buildLeadPrompt(resolvedTeam, task)` produces a
  system prompt containing the mission, the roster (each member name + its template
  description), the full `PATTERN_PLAYBOOK`, the `task`, and — when `pattern` is a
  concrete key — a directive to apply that pattern; when `auto`, the selection
  heuristic. Asserted by substring checks.
- **AC-5 playbook content:** `PATTERN_PLAYBOOK` names all six patterns
  (orchestrator, parallel, sequential, generator-verifier, consensus, blackboard),
  each with a when-to-use line, and includes the selection heuristic. Substring
  checks.
- **AC-6 delegate + capability-driven recursion guard:** `memberChildRegistry`
  builds a registry that **excludes every tool whose capabilities intersect
  `{agent:spawn, workflow:run}`** — asserted by constructing a parent registry
  containing `spawn_agent`/`spawn_template`/`sweep_edit` (each with
  `capabilities:["agent:spawn"]`) **and `run_workflow` (with
  `capabilities:["workflow:run"]`)** plus a plain `read` tool and the board, and
  verifying the result contains `read` + `board` and **none** of the four
  spawn-class tools (the `run_workflow` case specifically proves the guard is not
  keyed on `agent:spawn` alone) — and **includes** the board tool. The per-run `delegate` tool: an off-roster member name errors with the
  roster listed; a `MockProvider` member runs and its final text is returned;
  `delegate` is registered with the default (`parallel`) executionMode (asserted on
  the tool spec).
- **AC-7 shared board (incl. concurrent posts):** the run-scoped board: a `post`
  by one caller is visible in a later `list`; lead and members receive the **same**
  board instance (a member's `post` is visible to the lead's later `list`); **two
  concurrent `post`s** (awaited together via `Promise.all`, simulating a parallel
  delegate batch) both land with **distinct ids**; the entry-count/byte cap is
  enforced.
- **AC-8 run_team end-to-end, file + inline (dual invocation + native fan-out):**
  with a scripted `MockProvider` lead that emits two `delegate` calls in one turn
  then a final synthesis, `run_team` over a **file-based** team returns the
  synthesized answer and both members ran; `run_team` over an **inline roster**
  `{members:[...], task}` likewise runs. (Exercises the lead+primitives path and
  that the two `delegate` calls dispatch concurrently via `Promise.all`.)
- **AC-9 bounds + kill switch:** the per-run delegate counter (incremented
  synchronously before the child runs) rejects the (cap+1)-th delegation; a member
  template with `maxTurns` above the ceiling is built with the **capped** value
  (`min`); a roster over the member-count cap is rejected (AC-3); the lead's
  `maxTurns` is set to its cap; `EAGENT_TEAMS=off` makes `run_team` fail with a
  disabled message and `/team run` refuse.
- **AC-10 command surface:** activating `teams` registers exactly one tool
  (`run_team`), the `/team` command + `/teams` alias; `/team list` prints team
  names; `/team show <name>` prints the resolved roster + pattern; `/team run
  <name> <task>` runs and prints the result. Registration counts asserted via the
  harness.
- **AC-11 reuse helper (closed-cycle refactor is surgical):** `buildTemplateChild`
  is used by both `spawn_template` and `delegate`. The `spawn_template`-path child
  registry is **unchanged** — asserted by building a child via the refactored
  `spawn_template` path and verifying its registry membership equals
  `templateChildRegistry(parentTools, t.tools)` (the pre-refactor contents), and
  `test/templates.test.ts` stays green.
- **AC-12 no regression (meta):** `npm test` exits 0 and `npm run typecheck` exits
  0 with `teams` in `BUILTIN_EXTENSIONS`; kernel-surface ceiling unaffected
  (extension-only).

## 8. Risks and Rollback

- **Risk — runaway orchestration** (cost/loops). *Mitigation:* capability-driven
  member recursion guard, lead `maxTurns` cap, synchronously-incremented delegate
  cap, member `maxTurns` ceiling, roster member-count cap, board caps,
  `EAGENT_TEAMS=off` (Decision 4.8) — worst case is finite (lead × cap × member,
  no grandchildren). *Rollback:* kill switch or drop the `BUILTIN_EXTENSIONS` line.
- **Risk — member reaches a spawn tool** (the severe escape). *Mitigation:* the
  guard excludes **every** tool whose capabilities intersect `{agent:spawn,
  workflow:run}` — covering `spawn_agent`/`spawn_template`/`sweep_edit`
  (`agent:spawn`) and `run_workflow` (`workflow:run`), plus future spawn tools —
  verified by AC-6 against all four by name.
- **Risk — lead misapplies a pattern** (the 4.3 trade-off). *Mitigation:* the
  selection heuristic and optional pinned `pattern`; a misapplied pattern degrades
  quality, it does not crash. *Rollback:* pin `pattern`.
- **Risk — the `buildTemplateChild` refactor regresses `spawn_template`** (closed
  cycle-1 file). *Mitigation:* the helper is construct-only and called with no
  opts from `spawn_template`; AC-11 asserts the built registry is unchanged and
  `test/templates.test.ts` stays green — a regression there blocks the Phase.
- **Risk — frontmatter injection / malformed team file.** *Mitigation:* scan-time
  `validateTeam` (Decision 4.10, AC-2); the inline path is model-trusted (4.2).
- **Risk — board races under parallel delegate.** *Mitigation:* board ops are
  synchronous (no await between id-assign and append), so concurrent posts get
  distinct ids (AC-7).
- **Overall rollback:** the change is one new extension + one additive
  construct-only helper in `templates.ts` + one `BUILTIN_EXTENSIONS` line + docs.
  Remove the line (or `EAGENT_TEAMS=off`) to disable; revert the helper to inline
  the construction. No kernel change.
