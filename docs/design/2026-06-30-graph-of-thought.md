# Design — Graph-of-Thought operations (`graph_search`: aggregate + refine)

**Slug:** `2026-06-30-graph-of-thought` · **Mode:** Full · **Source:** `docs/DEFERRED-FOLLOWUPS.md` RW8a-1
(the GoT half; ToT shipped 2026-06-30 as `tree_search`). **Research:** Graph of Thoughts (Besta et al.,
2023, arXiv 2308.09687).

## 1. Background and Purpose

`reasoning-search` now has two strategies: `best_of_n` (depth-1 fan-out) and `tree_search` (multi-step ToT
**beam search over a tree** — each thought has exactly one parent). Graph of Thoughts generalizes the tree
to a **DAG** by adding two operations a tree cannot express:

- **Aggregation** — merge **several** thoughts into one (a node with *multiple parents*): take K candidate
  answers and synthesize their strengths into a single combined answer.
- **Refinement** — improve a thought **in place** (a self-loop): feed an answer back to produce a better
  version.

ToT can only *select* among independently-generated branches; it cannot *combine* them or *iterate* on one.
For tasks where partial solutions should be merged (synthesizing drafts, combining sub-results, voting-by-
synthesis) or polished (improve-this-answer), aggregation + refinement recover quality beam search leaves on
the table. These are the defining GoT operations, and the fork spine (`forkFrom` + scorers + `childScope`)
that `tree_search` already uses makes them a small, composable addition.

If we do not build this, RW8a-1 stays half-done (ToT shipped, GoT idle) and `reasoning-search` cannot merge
or refine — only generate-and-select.

## 2. Deliverables

- [ ] **D1** A new **`graph_search`** tool in `src/extensions/reasoning-search.ts` (params:
  `{ task: string; branch?: number; scorer?: "judge"|"shortest"|"longest"; refine?: boolean }`; `branch`
  defaults to the existing `DEFAULT_BRANCH=3`, clamped `[1, DEFAULT_MAX_BRANCH=4]`; `refine` defaults true).
  A **fixed Graph-of-Operations pipeline**: **generate** `branch` thoughts (fork from root, score) →
  **aggregate** the generated thoughts into one → (optional) **refine** the current best → return the
  **global best** across {generated, aggregate, refined}. Returns `ok(bestText, details)` (the `details`
  array is the flat second arg, matching `best_of_n`/`tree_search`) — each entry records a node's
  op/score/snippet.
- [ ] **D2** `aggregate(thoughts: string[])` — embeds **all the (fulfilled) generated thoughts** (there are
  ≤ `branch` ≤ 4, so no sub-selection / `aggK` is needed — the whole set is small); `forkFrom(root)` then
  `child.run(<a synthesis prompt embedding the task + the candidate texts, asking for one combined best
  answer>)`; its `finalText` is the aggregated thought, scored like any node. (If `branch===1` the aggregate
  is a single-input "merge" — semantically a near-no-op that still costs one run; harmless, KDD-5's global
  best protects the result.)
- [ ] **D3** `refine(thought: string)` — `forkFrom(root)` then `child.run(<an improve prompt embedding the
  task + the thought, asking for a better version>)`; scored like any node. Gated by `refine` (default true).
- [ ] **D4** Bounding + robustness: total child runs = `branch` (generate) + 1 (aggregate) + (`refine` ? 1 :
  0), with `branch` clamped to `[1, DEFAULT_MAX_BRANCH]` (reuse `tree_search`'s constant) — a small, fixed
  bound, no `maxNodes` loop needed. Reuse the `ctx.signal`→`stop()` abort wiring + `Promise.allSettled` (a
  failed op is dropped, never fails the search; if **every** node fails → clean `fail`).
- [ ] **D5** Recursion guard: `childRegistryFrom` drops **`graph_search`** too (alongside
  `tree_search`/`best_of_n`/`spawn_agent`) so a fork cannot launch a nested graph search. Off by default
  (reuses `reasoning-search`'s `enabled` flag + `EAGENT_REASONING_SEARCH=off`); `/reasoning-search status`
  mentions `graph_search`.
- [ ] **D6** Offline tests (TDD) pinning AC-3..AC-12 (MockProvider; deterministic order-invariant scorers;
  prompt-keyed responder to distinguish generate / aggregate / refine turns).

## 3. Scope Boundary (NOT in scope)

- **A configurable Graph-of-Operations DSL** — v1 is a **single fixed pipeline** (generate → aggregate →
  (refine)). An operation-sequence the caller composes (the GoT paper's "GoO") is a much larger, speculative
  surface, deferred.
- **Multi-round iterative refinement** (refine → score → refine → … to convergence) — v1 does **one**
  aggregate and **at most one** refine pass.
- **Multi-step tree expansion / backtracking** — that is `tree_search` (ToT); `graph_search` adds the
  aggregate/refine **operations**, not deeper search. The two are siblings, not a merge.
- **Cross-tool composition** (e.g. `tree_search` feeding `graph_search`) — each is standalone in v1.
- **A new extension / any kernel change** — a third **tool** in the existing `reasoning-search` extension;
  `BUILTIN_EXTENSIONS` count unchanged, kernel stays 2186.
- **Latency/cost budget** — excluded as a *measured* budget (each node is a full agent run; the fixed
  `branch + 2` bound controls cost, off-by-default, human-invoked — not a hot path). Same stance as
  `tree_search` §3.

## 4. Key Design Decisions

### KDD-1 — The two operations to add are **aggregate** + **refine** (the DAG-specific ones)
*Problem:* GoT is a large family of graph operations; which subset is v1? *Options:* (a) **aggregate +
refine** — the two operations a tree (ToT) structurally cannot express (multi-parent merge; in-place
self-loop); (b) a full configurable Graph-of-Operations; (c) generation only. *Choice:* **(a)** — generation
already exists (`best_of_n`/`tree_search`), so aggregate (the *defining* GoT multi-parent merge) + refine
(the self-loop) are exactly the new expressive power, and both are one `forkFrom`+prompt each. *Rejected:*
(b) a GoO DSL is the over-build Simplicity First forbids before the two core ops are proven; (c)
generation-only adds nothing over `best_of_n`.

### KDD-2 — A fixed pipeline, not a configurable operation graph
*Problem:* fixed generate→aggregate→refine, or a caller-composed operation sequence? *Options:* (a) fixed
pipeline; (b) configurable GoO. *Choice:* **(a)** — the fixed pipeline captures GoT's merge+improve essence
in one tool call with a tiny parameter surface; a configurable graph is a separate, larger design once the
operations prove out (mirrors how `tree_search` shipped a fixed beam loop, not a search-strategy DSL).
*Rejected:* (b) scope explosion + a speculative API before the operations are validated.

### KDD-3 — Aggregate/refine fork from the **root** + inject texts via the prompt (not fork a thought's state)
*Problem:* how is an aggregation (multi-parent) or refinement node produced on the single-parent fork
machinery? *Options:* (a) `forkFrom(root)` and pass the candidate/thought **texts in the run prompt** (the
child synthesizes/improves from the texts, starting from the shared root context); (b) try to fork from
multiple parent states. *Choice:* **(a)** — aggregation has **no single parent state** to fork from (it
depends on K thoughts), so the texts must enter via the prompt; forking from root gives a clean, governed
agent with the shared conversation, and reuses `forkFrom` unchanged. **Refine has a real choice** (it *does*
have a single parent — the current-best node): (a1) `forkFrom(root)` + the thought's **text** in the prompt
("here is an answer; improve it"), or (a2) fork from the best node's own `AgentState` to *continue* its
branch. *Choice for refine:* **(a1)** — uniform with aggregate (one text-level op shape), the improvement is
about the *answer text* not continuing the branch's reasoning, and it means `graph_search` need not retain
per-node `AgentState` snapshots (only the root) — generated thoughts are kept as **text+score**, not state,
so the tool is simpler and lighter than `tree_search`. *Rejected:* (a2) retaining every node's state to
re-fork the winner buys "inherited reasoning context" that a refine prompt embedding the text already
conveys, at the cost of state bookkeeping; (b) the kernel has no multi-state fork (for aggregate), and
inventing one is a kernel change for no gain — the prompt carries the parent texts naturally.

### KDD-4 — Fixed `branch + 2` bound; reuse abort/`allSettled`; no `maxNodes` loop
*Problem:* bounding. *Options:* (a) the `tree_search` `maxNodes` clip loop; (b) a fixed `branch + 1
aggregate + (refine?1:0)` count with `branch` clamped. *Choice:* **(b)** — `graph_search` is not an
unbounded multi-depth search; its node count is a fixed small function of `branch` (≤ `DEFAULT_MAX_BRANCH +
2 = 6`), so a clamp is sufficient and simpler than a budget loop. Reuse the moving-`stop()` abort + the
`allSettled` fault isolation from `tree_search`/W9.4. *Rejected:* (a) the `maxNodes` loop is machinery for a
variable-depth search this tool doesn't do.

### KDD-5 — Scoring reuses the existing scorers; return the **global best across all nodes**
*Problem:* node value + what's returned? *Options:* (a) reuse `judge`/`shortest`/`longest` (judge default);
return the **global best** across {generated, aggregate, refined} — so the pipeline never returns a *worse*
aggregate/refine than an already-good generated thought; (b) always return the refined (final) node.
*Choice:* **(a)** — aggregation/refinement are *attempts*, not guaranteed improvements; a running global
best (the `tree_search` KDD-5 rule) guarantees `graph_search` ≥ `best_of_n` quality on the same generated
set. *Rejected:* (b) returning the final node can regress if refine produced something worse.

### KDD-6 — Compose, no kernel change, off by default
*Problem:* new primitive or composition? *Options:* (a) a kernel "graph-search" primitive; (b) extension-
layer orchestration over the existing fork spine. *Choice:* **(b)** — same bet as `best_of_n`/`tree_search`:
a third tool, no new file, no kernel change, gated behind `reasoning-search`'s `enabled` flag. *Rejected:*
(a) unjustified — the fork spine (`forkFrom`/`childScope`/scorers) already exists; a kernel primitive spends
ceiling lines on what a tool expresses.

## 5. Dependencies and Assumptions

- **Builds on (all shipped):** `reasoning-search.ts`'s `forkFrom` (`:178`), `pickScorer` (`:207`),
  `finalText`, `argmax`, `childRegistryFrom` (`:83`, already skips `best_of_n`/`tree_search`/`spawn_agent`),
  `clamp` (`:120`), `DEFAULT_MAX_BRANCH`, and the `ctx.signal`→`stop()` + `Promise.allSettled` robustness
  (Wave 8a + W9.4 + the `tree_search` build). No new dependency (zero-dep rule holds).
- **Assumes** `agent:spawn` (already granted by the extension) and offline tests drive a `MockProvider`
  function responder that can distinguish the generate / aggregate / refine turns by **prompt content**
  (the aggregate/refine prompts embed distinct marker phrasing), and order-invariant `longest`/`shortest`
  scorers for deterministic selection.

## 6. Relationship with Existing Designs

- **Sibling of** `docs/design/2026-06-30-tree-search.md`: `tree_search` is ToT (tree/beam, multi-step
  search); `graph_search` is GoT (aggregate/refine **operations**, single fixed pipeline). Reuses
  `tree_search`'s `forkFrom`-internalized-prune, the `childRegistryFrom` recursion-guard pattern (now adding
  `graph_search`), the scorer + global-best convention (its KDD-5), and the abort/`allSettled` robustness.
  **No conflict** — additive (a third tool; `best_of_n`/`tree_search` unchanged).
- **Extends** `docs/design/2026-06-29-reasoning-search.md` (KDD-1 compose fork primitives, D3 scorer→number).
- Terminology anchors: the `reasoning-search` docstring + README row; CLAUDE.md _engineering-norms_
  (zero-dep, off-by-default, capability-gated, no kernel change).

## 7. Acceptance Criteria (measurable, automatable, offline)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing + new).
- **AC-3 (aggregate is produced + can win)** a prompt-keyed MockProvider returns, for the **aggregate**
  prompt, a text the `longest` scorer ranks above all generated thoughts; `graph_search({ task, branch:3,
  scorer:"longest", refine:false })` returns the **aggregate** text, and `details` records an `aggregate`
  node.
- **AC-4 (refine is produced + can win)** with `refine:true`, the **refine** prompt returns a text ranked
  above the aggregate + all generated; `graph_search` returns the **refined** text; `details` records a
  `refine` node.
- **AC-5 (global best, never a worse aggregate/refine)** when the aggregate/refine produce *lower*-scoring
  text than a generated thought, `graph_search` returns the **generated** best (the running global best),
  not the final node.
- **AC-6 (bounded)** total child runs = `branch + 1 + (refine?1:0)` — assert a **provider call-counter**
  equals the expected count, **under a deterministic scorer** (`longest`/`shortest`, so no `judge` sub-call
  inflates the count) **and single-turn mock responses** (each child run = one stream call); `branch:99`
  clamps to `DEFAULT_MAX_BRANCH` (so `branch+1+1 = 6`).
- **AC-7 (recursion guard)** a forked node's registry contains **none** of `graph_search`/`tree_search`/
  `best_of_n`.
- **AC-8 (governed)** a parent `beforeToolCall` guard blocks a tool inside a forked node (childScope carries).
- **AC-9 (abort + fault isolation)** with a **blocking custom provider** (MockProvider cannot block — as in
  `tree_search` AC-7), `ctx.signal` abort stops the **currently-live** op and returns/rejects promptly — the
  abort handler reassigns its live-set across the **three phases** (the concurrent generate array → the
  single aggregate fork → the single refine fork), the moving-`live` pattern of `tree_search`. Separately
  (with MockProvider): one op's throw is dropped via `allSettled` (the search still returns the best
  survivor); **all** ops failing → a clean `fail`.
- **AC-10 (off-by-default inert)** loaded-but-not-enabled → `graph_search` unavailable/inert.
- **AC-11 (parent transcript unmutated)** after `graph_search`, `e.agent.messages` holds only the
  user/assistant/tool-result for the `graph_search` call (no op-internal turns leak).
- **AC-12 (no kernel change)** `kernel-surface` green; `src/kernel` still **2186**; `BUILTIN_EXTENSIONS`
  count unchanged; declares `agent:spawn`.

## 8. Risks and Rollback

- **R1 — distinguishing generate/aggregate/refine turns in tests.** *Mitigation:* the aggregate/refine
  prompts embed distinct marker phrasing; the MockProvider responder keys on the prompt to script each op's
  output. Pinned by AC-3/AC-4.
- **R2 — aggregate/refine regress quality.** *Mitigation:* KDD-5 global-best — the pipeline returns the best
  node across *all* ops, so `graph_search` ≥ the generated best. Pinned by AC-5.
- **R3 — fan-out cost.** *Mitigation:* the fixed `branch + 2` bound + `branch` clamp; off by default. *No*
  unbounded loop. *Rollback:* `/reasoning-search off` / kill switch.
- **R4 — an op throws / all ops throw / zero generated thoughts.** *Mitigation:* `allSettled` drops a failed
  op; an all-fail returns a clean `fail` (R4 of `tree_search`, same shape). If **every generate-fork fails**,
  aggregate still runs (it is an unconditional `forkFrom(root)`) but its prompt embeds **no** candidate texts
  — degrading to a plain from-root attempt on the task; KDD-5 global-best returns whichever of {aggregate,
  refined} survives, or a clean `fail` if none do. Pinned by AC-9.
- **R5 — abort during a live op.** *Mitigation:* the `ctx.signal`→`stop()` over the live children
  (generate runs concurrently; aggregate/refine are sequential single forks tracked the same way). Pinned by
  AC-9.
- *Rollback:* `graph_search` is an additive tool in one file; removing its registration (or the kill switch)
  restores byte-identical behavior. `best_of_n`/`tree_search` untouched.

## L1 Review Log

- **Round 1** — PASS (zero severe; realizability crux confirmed — aggregate/refine via `forkFrom(root)`+prompt,
  no kernel change) + 2 generals (`aggK` undefined → aggregate all generated thoughts; refine's root-fork
  unjustified → weighed (a1) root+text vs (a2) fork-best-node-state, picked (a1)) + clarifications (branch
  default; AC-6 deterministic-scorer assumption; AC-9 blocking provider + 3-phase moving-live; KDD-6 options).
  All folded.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
