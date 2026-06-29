# Design — Governed sub-agents (scoped hook inheritance)

```
Status: closed
Closing-commit: c24d596
Closed-on: 2026-06-28
Deferred: finding — flow-guard data-taint for children (RW3-1); finding — steer/followUp routes to parent (RW3-2);
          deliverable — AgentHandle.spawnChild (RW3-3); deliverable — agentId/depth event tagging (RW3-4) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-28-governed-subagents` · **Wave:** 3 · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P1.2

## 1. Background and Purpose

Sub-agents silently fork the kernel. Every child-`Agent` construction site (`subagents.ts:78`,
`templates.ts:377`, `dynamic-workflow.ts:492`, `sweep-edit.ts:239`) calls `new Agent({ … })` **with no
`hooks`**, so the child gets a **fresh `HookBus`** (`agent.ts:106`: `this.hooks = opts.hooks ?? new
HookBus()`). The child still inherits the parent `CapabilityManager` (its `allow` fallback and
`fs:write` pre-grant) and a registry that includes `bash`/`write`, but **none of the parent's guards or
observers fire on it.** A child can run a `bash`/`write`/risky/secret-egress call the parent's guards
would block or redact, and its `usage` is discarded (`subagents.ts:110-112`) so fan-out spend is invisible.

**Guards straddle two seams.** A code-truth audit of the in-scope guards shows their defenses use both
intra-run **events** (to accumulate session state) and **gate filters** (`beforeToolCall`/`afterToolCall`):

| Guard | event-fed state | gate filter | child-transcript dependence |
|---|---|---|---|
| `bash-policy`, `risk-guard` | — | `beforeToolCall` (call args) | none |
| `content-guard` | — | `afterToolCall` (result) | none |
| `secret-guard` | — | `beforeToolCall` (`secret-guard.ts:109`) | none — confirmed call-args only (no `e.agent.messages`) → governed |
| `flow-guard` (capability taint) | `tool_end` adds cap to closure `tainted` Set (`flow-guard.ts:123`) | gate consults `tainted` (`:165`) | none — governed |
| `flow-guard` (DATA taint) | `message` tags `meta.flowGuardTaint` (`:152`) | gate scans `e.agent.messages` (`:164`) | **parent transcript — residual** |
| `write-guard` | `tool_end` adds path to closure `seen` Set (`:68`) | gate consults `seen`/fs (`:74`) | none — governed |
| `circuit-breaker`, `limits` | reset per-run on `agent_start` (`circuit-breaker.ts:190`, `limits.ts:200`) | count in `beforeToolCall`/`afterToolCall`/`usage` | none |

So governing a child requires firing the parent's **gate filters** AND its **intra-run events** on the
child — but **not** the context-shaping filters (which would inject parent context into a child's fresh
window) and **not** the run-lifecycle events (which would reset per-run observer state). This wave adds
`HookBus.childScope()` to do exactly that, routes the four sites through it, and documents the residuals
that need a deeper per-agent rework (deferred).

## 2. Deliverables

- [ ] **D1** `HookBus.childScope(): HookBus` — returns a bus **seeded with shared references** to the
  parent's `beforeToolCall` and `afterToolCall` filter chains and to the parent's **intra-run** event
  handler sets (`turn_start`/`turn_end`, `message`, `tool_start`/`tool_end`/`tool_batch_end`, `usage`,
  `text_delta`, `reasoning_delta`, `error`). All **other** points are absent from the child bus, so by the
  existing `HookBus` semantics: `apply("transformContext"|"transformRequest")` passes the value through
  unchanged (child keeps a **fresh, isolated context**), and `emit("agent_start"|"agent_end"|"session_*"|
  "reload")` is a no-op (`hooks.ts:52`, `if (!set) return`) so **per-run observer state is not reset by a
  child** (KDD-1, KDD-2, KDD-3).
- [ ] **D2** Route all four child-construction sites through `hooks: e.agent.hooks.childScope()`.
- [ ] **D3** Cost/usage visibility comes from the **shared `usage` event** (intra-run): a child's `usage`
  emit reaches the parent's `cost`/`budget-cap`/`limits` observers automatically, exactly once. **No**
  explicit usage-bubble (would double-count) (KDD-3).
- [ ] **D4** Tests against the **real guards**: a child under `flow-guard` that uses a `shell:exec`
  (capability-taint) source then egresses is **blocked**; a child under `write-guard` that
  reads-then-overwrites is **not** over-blocked; a child's `bash`/risky call is gated by parent
  `bash-policy`/`risk-guard`; a parent `afterToolCall` transforms a child result; the child's
  `agent_start` does **not** fire parent observers / reset `circuit-breaker`/`limits`, while the child's
  `tool_end` **does**; fan-out tokens count toward the parent's `cost`/`limits` exactly once; the four
  sites' existing tests stay green; `kernel-surface` green.

## 3. Scope Boundary (NOT in scope) — and the documented residuals

- **Context-shaping filters (`transformContext`, `transformRequest`) are NOT shared** with children: a
  sub-agent keeps its fresh, isolated context window (the `subagents.ts:11-14` design intent). Governance
  needs only the gate filters; the event-fed guard state rides shared **events**, not these filters.
- **Run-lifecycle events (`agent_start`/`agent_end`/`session_*`/`reload`) are NOT re-fired** from a child
  to parent observers — they are top-level-run boundaries; re-firing resets per-run state.
- **Known residual — `flow-guard` DATA taint** (read a sensitive file *without* `shell:exec`, then
  egress): the gate scans `e.agent.messages` (`flow-guard.ts:164`), which is the **parent** transcript;
  a child's tainted message lives in the **child** transcript, so the data trigger does **not** fire for
  children. The **capability** trigger (shell:exec→egress) **is** governed (closure `tainted` Set + shared
  `tool_end`). This residual is documented and deferred (needs flow-guard to track data-taint in shared
  closure state, or per-agent guard state — KDD-6); it is **strictly more** governance than today (fresh
  bus = zero), not a regression.
- **Known residual — `e.agent` parent-scoped surfaces.** `e.agent.handle.steer`/`followUp` **writes**
  (`circuit-breaker.ts:156` soft nudge, `budget-cap.ts:298`, `output-contract.ts:170`) route to the
  **parent** when a child triggers them, and `output-contract.ts:187` calls `e.agent.stop()` (the
  **parent**) when a child `respond` exhausts retries. The hard guards still block/return on the child's
  call; these parent-scoped *writes* misroute. (`secret-guard` was confirmed transcript-free — no
  residual.) Documented + deferred (per-agent rework, KDD-6).
- **Collateral — shared intra-run events also fire NON-guard observers for children.** Sharing all
  intra-run events + both gate filters means a child also drives opt-in-gated observers:
  `routing` (writes parent `e.agent.model` and may issue a classifier call per child turn),
  `citations` (advances the parent's `[src:N]` numbering on a child's results), `journal` (appends child
  messages to the parent journal), `output-contract` (the `e.agent.stop()` above). All are **off by
  default** / require opt-in (`outputSchema`), so this is acceptable collateral, not a regression — but
  it is part of `childScope`'s real surface, recorded here so it is a conscious choice, not a surprise.
- **No** per-agent re-architecture of guard/observer state; **no** `AgentHandle.spawnChild` (KDD-5);
  **no** `agentId`/`depth` event tagging (KDD-6); **no** change to capability sharing.

## 4. Key Design Decisions

### KDD-1 — `childScope` shares gate filters + intra-run events (not context filters, not lifecycle events)
*Problem:* the guards straddle both seams (§1); what must a child fire to be governed without side
effects? *Options:* (a) filters only; (b) all filters + all events; (c) all filters + intra-run events
(suppress lifecycle); (d) **gate filters (`beforeToolCall`/`afterToolCall`) + intra-run events only**.
*Choice:* **(d)**. (a) leaves `flow-guard`/`write-guard` (event-fed) bypassed. (b) fires child
`agent_start` → resets `circuit-breaker`/`limits` per-run state mid-parent-run (regression). (c) fixes
that but still shares `transformContext`/`transformRequest`, so 11 parent prompt-reshapers
(`compact`/`context-files`/`goal`/`skills`/`microagents`/`prune`/…) reshape the child's context — often
using the parent transcript — destroying the child's documented fresh-context isolation. (d) shares
exactly what governance needs — the gate filters run for the child, and the event-fed guard state
(`tainted`, `seen`, budget counters) accumulates via shared intra-run events — while the child keeps a
fresh context and per-run observers are not reset. *Rejected:* (a) under-governs; (b)/(c) inject parent
context and/or clobber per-run state.

### KDD-2 — Suppression falls out of the seeding, not a denylist
*Problem:* how to suppress lifecycle events and context filters? *Options:* (a) an `emit`/`apply`
override with a denylist; (b) **seed the child bus with shared references only for the allowed points**,
leaving the rest absent. *Choice:* **(b)** — by `HookBus`'s existing semantics, an absent event set makes
`emit` a no-op (`hooks.ts:52`) and an absent filter list makes `apply` pass through (`hooks.ts:99-100`).
So a child bus seeded with only `{beforeToolCall, afterToolCall}` filters and the intra-run event sets
*automatically* suppresses lifecycle events and context filters — no override, no subclass, no
`noImplicitOverride` concern. *Rejected:* (a) adds override logic the seeding makes unnecessary.

### KDD-3 — Usage visibility via the shared `usage` event (drop the explicit bubble)
*Choice:* **rely on the shared `usage` event** (intra-run, shared under KDD-1). A child's `usage` emit
reaches `cost`/`budget-cap`/`limits` exactly once; an explicit bubble would double-count. Consequence
(intended): fan-out tokens/tool-calls count toward the parent run's budgets — bounding total fan-out.
*Rejected:* an explicit parent-bus bubble (double-counts under shared events).

### KDD-4 — Route all four construction sites
*Choice:* all four adopt `hooks: e.agent.hooks.childScope()`. `sweep-edit` fans up to 50 edit-children —
where ungoverned writes matter most. *Rejected:* fixing only `subagents` leaves three ungoverned paths.

### KDD-5 — No `AgentHandle.spawnChild` this wave
*Choice:* defer; adding `hooks: …childScope()` to the four existing sites is the minimal change.

### KDD-6 — Defer per-agent guard-state rework, data-taint-for-children, event tagging
*Choice:* defer (a) flow-guard data-taint for children (needs shared data-taint state), (b) per-agent
isolation of guard/observer state and `steer`/`followUp` routing, (c) `agentId`/`depth` tagging. All
recorded as deferred follow-ups in `docs/DEFERRED-FOLLOWUPS.md`. *Rejected:* a multi-extension refactor
inside a seam-adding wave (Simplicity First; each is its own design).

## 5. Dependencies and Assumptions

Builds on Wave 2. Assumes a child only **fires** existing handlers, never **registers** its own (true:
extensions register on the parent at activation; children are bare) — so sharing the parent's
`beforeToolCall`/`afterToolCall` `Registration[]` arrays and intra-run event `Set`s **by reference** is
safe. Assumes those guard arrays exist at child-spawn time (true: registered at activation, before any
spawn). **Assumes the child's tools are derived from (a subset of) the parent registry** — true for all
four sites (`subagents.ts:57` `childRegistryFrom(e.agent.tools.list())`, `sweep-edit.ts:248`,
`templates`, `dynamic-workflow`) — so `capsOf`/`isFullOverwrite` reading `e.agent.tools` resolve the
child's tool capabilities correctly; capability-taint governance silently depends on this (a future child
built with tools *absent* from the parent registry would escape flow-guard's source/egress
classification). Assumes guard state lives in **activation closures** (verified: `flow-guard.tainted`,
`write-guard.seen`, `circuit-breaker.buckets`, `limits` counters), so firing the parent's handlers from a
child mutates/reads the shared closure state. **Mechanism:** `childScope()` returns `new HookBus(seed)`
where `seed` carries the shared filter `Registration[]` references for `beforeToolCall`/`afterToolCall`
and the shared event `Set` references for the intra-run events; the `HookBus` constructor gains an
optional seed parameter that pre-populates `#filters`/`#events` (initialized inline today, `hooks.ts:37-38`)
— no subclass, no `override`.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P1.2. Builds on Wave 2 (`2026-06-28-transform-request.md`). Related:
`2026-06-22-subagents-least-privilege.md` (capability scoping — complementary), `2026-06-25-agent-teams.md`
/ `2026-06-25-templates.md` (⚠ both ride the fresh-bus construction this wave fixes; child-spawn behavior
changes from ungoverned to governed — intended). CLAUDE.md Hook-bus row and the `hooks.ts` docstring gain
`childScope`; reconciled at F. No load-bearing contract removed.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0.
- **AC-2** `npm test` exits 0 (existing + new).
- **AC-3 (flow-guard capability taint governed)** With `flow-guard` active (block mode), a child built via
  `childScope()` that uses a `shell:exec` source tool then calls an egress tool (`net:fetch`/`mcp:call`)
  is **blocked**. A control child on a plain `new HookBus()` is **not** blocked. *(The data-taint
  variant — sensitive read without shell:exec — is a documented residual, §3; not asserted as governed.)*
- **AC-4 (write-guard not over-blocked)** With `write-guard` active, a child that reads an existing file
  (shared `tool_end` populates `seen`) then overwrites it is **not** prompted/blocked; an unseen-file
  overwrite **is** gated.
- **AC-5 (call/result guards)** A parent `beforeToolCall` blocks a child's matching call; a parent
  `afterToolCall` annotates a child's result.
- **AC-6 (lifecycle suppression — KDD-1/2)** A parent `e.on("agent_start", …)` observer does **not** fire
  when a `childScope()` child runs (so `circuit-breaker`/`limits` are not reset by a child); a parent
  `e.on("tool_end", …)` observer **does** fire for the child's tools.
- **AC-7 (context filters not shared — KDD-1)** A parent `transformContext` handler that injects a marker
  message does **not** run for a `childScope()` child (the child's context is fresh).
- **AC-8 (usage once)** After a child consumes tokens, a parent `cost`/usage observer includes the
  child's tokens **exactly once** (shared `usage` event; no explicit bubble).
- **AC-9** Existing `test/subagents.test.ts`, `test/teams.test.ts`, `test/templates.test.ts`,
  `test/dynamic-workflow.test.ts`, `test/sweep-edit.test.ts` stay green.
- **AC-10** `kernel-surface.test.ts` passes: `src/kernel/` `< 2,200` lines; export list unchanged.

*Quality budget:* `childScope` is O(1) (copies a handful of map-entry references); negligible. Excluded.

## 8. Risks and Rollback

- **R1 — `flow-guard` data-taint residual for children** (§3). *Mitigation:* documented + deferred; the
  capability trigger IS governed (AC-3); the event-driven defenses are strictly more than today.
  *Rollback:* none — no regression vs the fresh-bus status quo.
- **R2 — Non-guard observer collateral** (`routing`/`citations`/`journal`/`output-contract` fire for
  children). *Mitigation:* all are off-by-default / opt-in; §3 "Collateral" documents them; AC-9 (the four
  sites' existing tests) is the regression net. *Rollback:* exclude specific event points from child scope
  if a default-on observer proves harmful (none is today). *(`secret-guard` was confirmed call-args-only —
  no residual.)*
- **R3 — Soft `steer`/`followUp` nudges (circuit-breaker, budget-cap) route to the parent** on
  child-triggered activity. *Mitigation:* the hard block still applies to the child; only the soft nudge
  misroutes; documented + deferred (KDD-6). *Rollback:* n/a.
- **R4 — Fan-out counts toward the parent's `limits`/circuit budget.** *Mitigation:* intended (bounds
  total fan-out); a normal child is too small to trip it; a runaway *should* be bounded. *Rollback:*
  exclude `limits`/`circuit` filter points from child scope (deferred option).
- **R5 — Child mutates a shared registration array.** *Mitigation:* children never register (§5).
  *Rollback:* deep-copy registrations into the child bus.
- **R6 — CLAUDE.md / `hooks.ts` docstring stale.** *Mitigation:* reconcile at F step 8.

The change is one kernel constructor-seed + one `childScope()` method + four one-line construction edits;
reverting the construction edits restores the prior (ungoverned) behavior.

## L1 Review Log

- **Round 1** — **SEVERE**: "filters-only, fresh events" plan left `flow-guard`/`write-guard` (event-fed)
  bypassed for children and mis-counted `circuit-breaker`/`limits` (KDD-1 justification inverted).
  Redesigned.
- **Round 2** — **SEVERE**: rewrite (share filters + intra-run events) over-claimed `flow-guard`
  data-taint as governed (gate reads parent transcript) and would inject parent context-filters into a
  child's fresh window. Redesigned to gate-filters-only + intra-run events; data-taint documented as
  residual.
- **Round 3** — **zero severe**; 1 general (non-guard observer collateral) + clarifications (secret-guard
  confirmed transcript-free; output-contract `e.agent.stop()`; cite drift; capsOf assumption). Applied.
- **Round 4 (corroborating)** — **zero severe, zero general.** Cap-convergence policy
  ([[three-loop-cap-convergence-policy]]) — two-generation satisfied. **L1 closed.**
