# Design — Reasoning-search controller (best-of-N over forked agents)

**Slug:** `2026-06-29-reasoning-search` · **Wave:** 8 (subsystem 1 of 2) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P4.1 · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md` §C (LangGraph branching / fork-as-primitive)

## 1. Background and the gap (code as truth)

A Wave-8 surface audit: `search.ts` is `glob`/`grep` (filesystem), **not** reasoning-search — so a
best-of-N / tree-of-thought controller is genuinely missing. The primitives it needs already exist:

- **Fork is already a solved extension pattern.** `subagents.ts` constructs child agents with
  `new Agent({ …, hooks: e.agent.hooks.childScope() })` (`subagents.ts:78-88`) and fans them out under a
  bounded `Promise.all` (`subagents.ts:239`), gated by `agent:spawn` (`:50,132`). The `Agent` constructor
  is public and takes `AgentOptions` (`agent.ts:39,115`).
- **State is forkable.** Wave 4's `snapshot()`/`restore()` (`agent.ts`) + a child Agent restored from the
  parent snapshot is exactly the "fork a branch" primitive (Wave 7a proved the rewind/fork tree on it).
- **A scorer already exists.** `evals.ts` ships a recursion-safe LLM `judge` sub-call + `checkExpect`
  trajectory predicates — reusable to rank candidates.

So reasoning-search is a **composition** of existing public primitives — **no kernel change** (RW4-1's
`Agent.fork()` convenience is unnecessary; the extension forks via the constructor + `childScope` +
`restore`, exactly as `subagents` does). Research (LangGraph) framed fork as the shared primitive; here
best-of-N is N forks scored and one selected.

This wave ships an off-by-default `reasoning-search` extension: a `best_of_n` tool that forks N governed
child attempts at a sub-task from the current state, scores them, and returns the best — the minimal,
non-speculative slice of P4.1. (ToT/GoT multi-step search is explicitly deferred — KDD-4.)

## 2. Deliverables

- [ ] **D1** A new `reasoning-search` extension (`src/extensions/reasoning-search.ts`), **off by default**
  (`EAGENT_REASONING_SEARCH=off` kill switch + a store `enabled` flag default false), declaring
  `agent:spawn` (it spawns child agents — same authority as `subagents`). **No kernel change.**
- [ ] **D2** A `best_of_n` tool: params `{ task: string, n?: number (default 3, capped), scorer?:
  "judge" | "shortest" | "longest" (default "judge") }`. It (a) `snapshot()`s the current agent, (b) forks
  **N** child agents (`new Agent({ providers, tools, commands, capabilities, hooks:
  e.agent.hooks.childScope() })` each `restore(snapshot)`-d, so each branch inherits the conversation +
  governance), (c) runs each child on `task` to completion under a **bounded concurrency cap**
  (`maxConcurrency`, like `subagents`), (d) **scores** the N final outputs, (e) returns the **best**
  candidate's text (+ details: per-candidate score). The parent transcript is **not** mutated by the
  losing branches (children are separate agents; only the returned text re-enters via the tool result).
- [ ] **D3** Scorers: `judge` (default) — a recursion-safe tool-less sub-call (reuse `evals`'s judge
  pattern / a fresh child with no tools) that ranks the N candidates and returns the best index;
  `shortest`/`longest` — deterministic length heuristics (offline-testable without a judge). A malformed
  judge reply falls back to the first candidate (fail-soft, never throws).
- [ ] **D4** Governance + bounds: children use `childScope()` (parent gate filters govern them — Wave 3);
  N is capped (default max 5) to bound fan-out cost; child usage bubbles to the parent via the shared
  usage event (Wave 3); a per-call total-spawn budget mirrors `subagents`'. Declares `agent:spawn`.
- [ ] **D5** A `/reasoning-search [on|off|status]` command. Registered in `BUILTIN_EXTENSIONS`. Tests
  (offline, deterministic via the `shortest`/`longest` scorers + MockProvider).

## 3. Scope Boundary (NOT in scope)

- **No** kernel change — composes `Agent` constructor + `childScope()` + `snapshot()`/`restore()` +
  `agent:spawn`, all existing/public. No `Agent.fork()` kernel method (RW4-1 stays deferred — unneeded).
- **No** ToT / GoT / MCTS multi-step tree search in v1 — only **single-step best-of-N** (fork N attempts at
  one sub-task, pick best). Tree/graph search (expand→evaluate→backtrack over many plies) is a much larger,
  more speculative design; deferred (KDD-4).
- **No** automatic interception of the *main* loop's every step — `best_of_n` is an **explicit tool** the
  agent (or a workflow) calls for a hard sub-problem, not an always-on wrapper around every turn.
- **No** new scorer infrastructure beyond the three above — a pluggable user scorer is a follow-up.
- **No** mutation of the parent transcript by losing branches — only the winning text returns via the
  tool result (clean, no cross-branch contamination).
- **On by default? No** — opt-in (`agent:spawn` + fan-out cost); like `subagents`' posture.

## 4. Key Design Decisions

### KDD-1 — Compose existing fork primitives; no kernel change
*Problem:* best-of-N needs N forked branches. *Options:* (a) add `Agent.fork()` to the kernel (RW4-1);
(b) the extension forks via `new Agent({hooks: childScope()}).restore(snapshot())`, exactly as
`subagents.ts` constructs children. *Choice:* **(b)** — the pattern is already proven in `subagents`; the
kernel primitives (constructor, childScope, snapshot/restore) are public and sufficient; adding a kernel
method spends scarce ceiling lines (2187/2200) on a convenience an extension expresses cleanly. *Rejected:*
(a) unnecessary kernel growth against the small-kernel bet.

### KDD-2 — Single-step best-of-N first, not ToT/GoT
*Problem:* P4.1 lists best-of-N/ToT/GoT. *Options:* (a) build a general tree/graph search controller;
(b) ship best-of-N (one fork-set, scored, select) and defer multi-ply search. *Choice:* **(b)** — best-of-N
is the highest-value, lowest-complexity slice; it exercises the fork+score+select spine that ToT/GoT would
reuse, and is fully offline-testable. ToT/GoT add expansion/backtracking/frontier management — a separate,
larger design once best-of-N proves out. *Rejected:* (a) speculative scope-balloon.

### KDD-3 — Governed children via `childScope`; bounded fan-out
*Problem:* N forked agents could bypass guards or blow up cost. *Options:* (a) raw `new Agent()` (fresh
bus, ungoverned — the Wave-3 hole); (b) `childScope()` children + a concurrency cap + an N cap + a spawn
budget. *Choice:* **(b)** — children inherit the parent's gate filters (bash/secret/flow/provenance
guards govern every branch) and usage bubbles up; `maxConcurrency` + `n ≤ max` + a per-call budget bound
the cost, mirroring `subagents`. *Rejected:* (a) re-opens the governance hole Wave 3 closed.

### KDD-4 — `judge` default scorer with deterministic fallbacks
*Problem:* scoring N candidates needs a ranker; an LLM judge isn't deterministic for tests. *Options:*
(a) judge-only; (b) `judge` default + `shortest`/`longest` deterministic scorers for offline tests +
a fail-soft fallback. *Choice:* **(b)** — judge is the realistic ranker (reuses the recursion-safe judge
pattern); the heuristic scorers make the fork/select machinery offline-testable without a live model, and
a malformed judge reply falls back to candidate 0 (never throws). *Rejected:* (a) untestable offline +
brittle on a bad judge reply.

## 5. Dependencies and Assumptions

Reuses `subagents.ts`'s child-construction pattern (`new Agent` + `childScope` + bounded `Promise.all`),
Wave 4 `snapshot()`/`restore()`, Wave 3 `childScope()` + usage bubbling, and `evals`'s judge pattern (or a
fresh tool-less child). Assumes the `Agent` constructor is public + accepts shared registries
(`agent.ts:39,115` — it is, and `subagents` proves it). Assumes a scriptable/real provider for the children
(offline tests use MockProvider + the deterministic scorers). `agent:spawn` is the authority (host policy
gates it). No network, no deps.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P4.1; research §C. Composes Wave 3 (childScope governance), Wave 4
(snapshot/restore), and the `subagents` fan-out pattern; reuses `evals`'s judge. Sibling to the Wave-7a
time-travel tree (both build on the same fork primitive; time-travel persists branches, reasoning-search
scores ephemeral ones). The Wave-8b self-improvement harness is independent. README extension table gains
a `reasoning-search` row + count 56→57; reconciled at F. No kernel change.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing 1041 + new).
- **AC-3 (best-of-N forks + selects)** With the extension enabled and a MockProvider scripting N distinct
  child outputs, `best_of_n({ task, n: 3, scorer: "longest" })` returns the **longest** candidate's text
  (deterministic); assert the result is the expected candidate and `details` lists 3 per-candidate scores.
- **AC-4 (governed children)** A child's tool call is subject to a parent `beforeToolCall` guard (register
  a blocking guard; assert the child's blocked call did not execute) — proving `childScope` governance
  carries to the forked branches.
- **AC-5 (bounded)** `n` above the cap (default max 5) is clamped; assert no more than `cap` children run.
  Child usage bubbles to the parent (assert the parent's cumulative usage includes the children's).
- **AC-6 (parent transcript unmutated by losers)** After `best_of_n`, the parent `agent.messages` contains
  only the user/assistant/tool-result for the `best_of_n` call itself — **not** the losing branches'
  internal turns (they ran in separate child agents).
- **AC-7 (scorer fallbacks)** `shortest`/`longest` are deterministic (pinned offline); a `judge` scorer
  with a malformed reply falls back to candidate 0 without throwing.
- **AC-8 (off-by-default inert)** With the extension loaded but not enabled, `best_of_n` is unavailable or
  inert; host canonical-set green (`BUILTIN_EXTENSIONS.length` +1, no dup tool/command names); no kernel
  change (`kernel-surface` 2187).

*Quality budget:* N child runs bounded by the concurrency cap + N cap + spawn budget; opt-in. The judge is
one extra sub-call. Documented; not a hot path. Excluded.

## 8. Risks and Rollback

- **R1 — Fan-out cost blow-up.** *Mitigation:* `n ≤ cap` (default 5) + `maxConcurrency` + a per-call spawn
  budget (KDD-3); off by default. *Rollback:* `/reasoning-search off` / kill switch.
- **R2 — Ungoverned children (Wave-3 hole).** *Mitigation:* `childScope()` children (AC-4 pins guard
  inheritance); usage bubbles up. *Rollback:* n/a.
- **R3 — Non-deterministic judge breaks tests.** *Mitigation:* `shortest`/`longest` deterministic scorers
  for tests (AC-3/AC-7); judge fail-soft fallback. *Rollback:* n/a.
- **R4 — Parent-transcript contamination from branches.** *Mitigation:* children are separate agents; only
  the winning text returns via the tool result (AC-6). *Rollback:* n/a.
- **R5 — README table/count stale.** *Mitigation:* reconcile at F (56→57).

A single off-by-default extension composing existing fork/score primitives; reverting the registration
removes it cleanly with zero kernel/other-component effect.
