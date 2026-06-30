# Design — Tree-of-Thought search (multi-step beam search over forked agents)

**Slug:** `2026-06-30-tree-search` · **Mode:** Full · **Source:** `docs/DEFERRED-FOLLOWUPS.md` RW8a-1
(reasoning-search's registered follow-up). **Research:** Tree of Thoughts (Yao et al., 2023, arXiv 2305.10601);
Graph of Thoughts (Besta et al., 2023, arXiv 2308.09687).

## 1. Background and Purpose

Wave 8a shipped `reasoning-search`'s `best_of_n`: fork N governed child agents from a `snapshot()`, run each
one step on a sub-task, score each output to a number, return the argmax. That is the **depth-1** slice of
reasoning search — N continuations, scored and selected once. Tree of Thoughts generalizes it to
**multi-step search**: treat each intermediate answer as a "thought" node, expand promising nodes into more
thoughts, score, keep a beam of the best, and repeat — so the agent explores and prunes a *tree* of
reasoning paths instead of a single fan-out. For decomposable problems (planning, multi-step proofs,
search-like tasks) a single greedy chain or a depth-1 best-of-N leaves quality on the table; a bounded beam
search over the existing fork→score→select spine recovers it.

If we do not build this, `reasoning-search` stays depth-1 and the "search over reasoning" capability the
extension's docstring names ("tree/graph search … is deferred") stays unbuilt, with the fork infrastructure
already present and idle.

## 2. Deliverables

- [ ] **D1** A new **`tree_search`** tool in `src/extensions/reasoning-search.ts` (params:
  `{ task: string; branch?: number; beam?: number; depth?: number; scorer?: "judge"|"shortest"|"longest";
  maxNodes?: number }`). Runs bounded beam search and returns `ok(bestPathText, { details })` where
  `details` summarizes the explored frontier per depth (each node's score + a text snippet) — the same
  shape-style as `best_of_n`'s `details`.
- [ ] **D2** A `forkFrom(state: AgentState)` helper for expanding **any** node (not just the root).
  `forkChild` (`reasoning-search.ts:139`) already accepts an arbitrary `AgentState` — it is root-only only in
  *usage* — so the deltas are narrow: (i) **internalize** the `withoutDanglingToolUse` prune (today applied
  *externally* at `reasoning-search.ts:219`, once, before the root fork) **into** `forkFrom`, so every fork
  (root and intermediate) starts from a provider-valid transcript; (ii) build the child registry via the
  guard in D3. No larger refactor of `forkChild` is needed.
- [ ] **D3** Recursion guard: `childRegistryFrom` (and `tree_search`'s child registry) drops **`tree_search`**
  in addition to `best_of_n`/`spawn_agent`, so a forked node cannot launch a nested search.
- [ ] **D4** The beam-search loop: root snapshot → for each depth, expand each frontier node into `branch`
  children, score (value scorer), prune to the top-`beam` by score, repeat to `depth` — bounded by a hard
  **`maxNodes`** cap on total child runs, with `Promise.allSettled` (one node's throw → score `-Infinity`,
  never fails the search; all-fail → clean `fail`). **Multi-wave abort (G1):** unlike `best_of_n`'s single
  fan-out (whose abort handler closes over one fixed `children` array), `tree_search` runs **sequential
  waves** (one `allSettled` per depth), so the `ctx.signal`→`stop()` handler must follow the **moving
  frontier** — keep a mutable reference to the *current* live wave (or re-register per wave) and `stop()`
  exactly its children, so an abort at depth d stops depth-d's live children, not depth-(d−1)'s already
  settled set. A naive copy of `best_of_n`'s fixed-array handler silently fails AC-7 at depth ≥ 2.
- [ ] **D5** Off by default — gated by `reasoning-search`'s existing `enabled` store flag +
  `EAGENT_REASONING_SEARCH=off` kill switch (no new flag); `/reasoning-search status` mentions `tree_search`.
- [ ] **D6** Offline tests (TDD) pinning AC-3..AC-11 (MockProvider; deterministic order-invariant scorers).

## 3. Scope Boundary (NOT in scope)

- **Graph-of-Thought operations** — thought **aggregation** (merge several thoughts into one) and
  **refinement** (improve a thought in place), i.e. a thought *DAG*. v1 is a **tree** (each node has one
  parent); GoT is a separate, larger design (KDD-2).
- **MCTS / learned value models / rollouts / UCT** — beam search only; no simulation budget or value net.
- **Tree persistence / visualization / a `/tree` inspector command** — `details` in the tool result is the
  only surfaced trace.
- **A new extension** — `tree_search` is a new **tool inside the existing `reasoning-search` extension**;
  `BUILTIN_EXTENSIONS` count is unchanged (no new file, no host.ts edit).
- **Any kernel change** — composes existing public primitives only (Agent fork + `childScope` +
  `snapshot`/`restore` + reasoning-search helpers). Kernel stays 2186.
- **Latency/cost budget** — explicitly excluded as a *measured* budget: each node is a full child agent run,
  so wall-cost scales with `maxNodes`; the design bounds *count* (AC-4) but does not assert a latency
  threshold (an opt-in, human-invoked, off-by-default search tool, not a hot path). Cost is controlled by
  conservative defaults + the `maxNodes` cap, not a timing AC.

## 4. Key Design Decisions

### KDD-1 — Beam search (BFS + beam width), not DFS / best-first / MCTS
*Problem:* which search strategy over the thought tree? *Options:* (a) **beam search** — expand the whole
frontier one depth at a time, keep the top-`beam`; (b) DFS with backtracking; (c) best-first (priority
frontier); (d) MCTS (selection/expansion/simulation/backprop). *Choice:* **(a)** — it is the ToT paper's
standard for bounded problems, maps **directly** onto `best_of_n`'s existing parallel fork→score→argmax wave
(each depth is one `best_of_n`-style wave, reusing `Promise.allSettled` + the abort wiring), is trivially
bounded (`branch × beam × depth`), and is deterministic for testing. *Rejected:* (b) DFS needs explicit
backtracking + a frontier stack and serializes poorly; (c) best-first is a minor variant that complicates
the bound without clear gain at these depths; (d) MCTS needs a simulation/rollout budget + a value model —
speculative and far larger, exactly the over-build Simplicity First forbids.

### KDD-2 — Tree of Thoughts v1; Graph of Thoughts deferred
*Problem:* ToT only, or ToT + GoT aggregation/refinement? *Options:* (a) ToT (tree) v1, defer GoT; (b)
ToT+GoT now. *Choice:* **(a)** — GoT's aggregate/refine operators need a thought-DAG, merge prompts, and
dependency tracking — a much larger surface; ToT beam search proves the multi-step **expand→score→prune**
spine GoT would reuse, exactly as `best_of_n` proved the depth-1 spine this reuses. *Rejected:* (b) scope
explosion for a speculative gain before the tree spine is proven.

### KDD-3 — Bounding: `branch`/`beam`/`depth` params + a hard `maxNodes` cap
*Problem:* beam search fans out combinatorially (`branch × beam` new child runs per depth); each child run
is a full agent loop, so an unbounded search is a cost/DoS hazard. *Options:* (a) only clamp the three
params; (b) clamp **and** a hard `maxNodes` ceiling on total child runs (the analog of `best_of_n`'s N-cap).
*Choice:* **(b)** — params are clamped to small ranges (`branch`≤`DEFAULT_MAX_BRANCH=4`, `beam`≤`DEFAULT_MAX_BEAM=3`,
`depth`≤`DEFAULT_MAX_DEPTH=3`) **and** total child runs are capped at `maxNodes` (default `DEFAULT_MAX_NODES=16`,
clamped to the range `[branch, HARD_MAX_NODES=32]` — never below `branch`, so depth-1 always runs at least the
root expansion). **Enforcement granularity (G2):** each depth wave is **clipped to the remaining budget** —
before a wave, if `cumulative + frontier.length × branch > maxNodes`, expand only as many (top-`beam`) nodes'
children as fit, and once the budget is exhausted, **terminate and return the best leaf found so far** (not an
error). This uses the full budget and avoids a degenerate empty first frontier (the `[branch, …]` clamp
guarantees depth-1 runs). Defaults are deliberately conservative: ToT's Game-of-24 used `b=5,T=3`, but each
EAgent node is a full agent run (far costlier than a single LLM call), so EAgent caps lower —
`branch=3,beam=2,depth=2` by default (`3 + 1·2·3 = 9` runs typical). The cap is the **only** hard fan-out
bound and is non-optional. *Rejected:* (a) params alone — the true max-param worst case is
`branch + (depth−1)·beam·branch = 4 + 2·12 = 28` child runs (not the naive `4×3×3` product), which both
exceeds the default `maxNodes` 16 (so the cap does real clipping) **and** sits under `HARD_MAX_NODES=32` (so
the absolute ceiling is never the binding limit) — params alone would not bound a misconfigured `maxNodes`.

### KDD-4 — A node is a forked `AgentState` continuation (reuse the fork spine; no new state primitive)
*Problem:* how is a "thought" node represented + expanded? *Options:* (a) a node carries a forked
`AgentState` snapshot; expanding = `forkFrom(node.state)` → `child.run(stepPrompt)` → the child's
`finalText` is the thought and `child.snapshot()` is the new node's state; (b) a bespoke thought-string tree
that re-runs the whole prefix each expansion. *Choice:* **(a)** — it reuses the proven, governed
`snapshot`/`restore`/`childScope` fork machinery (no re-running prefixes, no new state type), and each node
naturally inherits the conversation up to that thought. *Rejected:* (b) re-implements state management and
recomputes prefixes — slower and a second source of truth.

### KDD-5 — Value scoring reuses the existing scorers; optional early termination
*Problem:* how are nodes valued + when does search stop? *Options:* (a) reuse `best_of_n`'s
`judge`/`shortest`/`longest` scorers (judge default) as the node value, terminate at `depth` (+ keep the
global best-scoring leaf); (b) a new ToT-specific value prompt + a goal classifier. *Choice:* **(a)** for
v1 — the scorers already map candidate→number; the answer is the **global** best-scoring leaf found across
all depths (a running best, not only the final frontier — so an early high-scoring thought is never lost to
a weaker-but-deeper one), consistent with G2/R4/AC-4's "best so far."
(Early-stop on a goal *threshold* is **deferred** to keep v1's termination purely depth-bounded — noted in
Scope Boundary-adjacent risk R5.) *Rejected:* (b) a bespoke goal classifier is its own design; the existing
judge scorer is sufficient to rank thoughts.

### KDD-6 — Compose, no kernel change, off by default
*Problem:* new primitive or composition? *Options:* (a) a kernel search primitive; (b) a tool composing
`Agent` fork + `childScope` + `snapshot`/`restore` + the reasoning-search helpers. *Choice:* **(b)** — same
bet as `best_of_n` (Wave 8a shipped depth-1 with zero kernel change); the tree loop is extension-layer
orchestration. Off by default (reuses reasoning-search's gate). *Rejected:* (a) no kernel justification —
the fork spine already exists.

## 5. Dependencies and Assumptions

- **Builds on (all shipped):** the `Agent` constructor + `hooks.childScope()` (Wave 3), `snapshot()`/
  `restore()` (Wave 4), the `reasoning-search.ts` helpers `childRegistryFrom`/`forkChild`/`finalText`/
  `argmax`/`withoutDanglingToolUse`/`pickScorer`/`judgeScore` (Wave 8a), and the `ctx.signal`→`stop` +
  `Promise.allSettled` fork-robustness from W9.4. No new dependency (zero-dep rule holds).
- **Assumes** `agent:spawn` is grantable (already granted by reasoning-search) and offline tests drive a
  scriptable `MockProvider`. Determinism for the selection assertion relies on order-invariant scorers
  (`longest`/`shortest`), as `best_of_n`'s tests do.

## 6. Relationship with Existing Designs

- **Extends** `docs/design/2026-06-29-reasoning-search.md` (the direct parent). `best_of_n` is the depth-1,
  beam=∞ special case of `tree_search`. Reuses its KDD-1 (compose fork primitives), KDD-3 (pruned child
  registry + the N-cap → generalized to `maxNodes`), **D3** (the scorer→number + argmax convention →
  top-`beam` selection; KDD-4 is the *judge-default* decision, also reused), KDD-5 (restore-from-snapshot so
  a branch inherits context). RW8a-1 in `docs/DEFERRED-FOLLOWUPS.md` is this
  design's registration. **No conflict** — purely additive (a second tool in the same extension; `best_of_n`
  is unchanged).
- No relationship with the self-improvement / sandbox / otel designs.
- Terminology anchors: reasoning-search's docstring + README row; CLAUDE.md _engineering-norms_ (zero-dep,
  off-by-default, capability-gated, no kernel change).

## 7. Acceptance Criteria (measurable, automatable, offline)

- **AC-1** `npm run typecheck` exit 0. **AC-2** `npm test` exit 0 (existing + new).
- **AC-3 (multi-step beam selects the best path)** MockProvider scripts a 2-depth tree where one lineage
  scores highest at each depth (use a deterministic `longest`/`shortest` scorer so the winner is
  order-invariant); `tree_search({ task, branch:2, beam:1, depth:2, scorer:"longest" })` returns that
  lineage's final text, and `details` shows 2 depth levels. (Beam=1 makes the expected winner deterministic.)
  Script via MockProvider's **function/input-keyed responder** (`mock.ts:34-36`, keyed on the prompt), not a
  flat shared queue — concurrently-running forks drain a flat queue in scheduler order, which makes
  "highest at each depth" fragile.
- **AC-4 (bounded)** `branch`/`beam`/`depth` above their caps are clamped; `maxNodes` is clamped to
  `[branch, 32]`; and a config whose worst-case run count (`branch + (depth−1)·beam·branch`) exceeds
  `maxNodes` runs **≤ maxNodes** total child agents — assert a child-run counter is ≤ the configured
  `maxNodes`, and that when the budget is exhausted the search returns the best leaf so far (not `fail`).
- **AC-5 (recursion guard)** a forked node's registry contains **neither** `tree_search` **nor** `best_of_n`
  (assert via the child registry) — a node cannot launch a nested search or fan-out.
- **AC-6 (governed)** a parent `beforeToolCall` guard that blocks a tool also blocks that tool inside a
  forked node (childScope governance carries to every node).
- **AC-7 (abort, multi-wave)** with `ctx.signal` aborted **during depth ≥ 2**, every **currently-live**
  child receives `stop()` and `tree_search` returns/rejects promptly — proving the handler follows the
  moving frontier (G1), not a stale depth-1 array (a blocking custom provider + asserted `stop` count on the
  live wave; not MockProvider, which cannot block — mirrors W9.4's AC).
- **AC-8 (one node's throw ≠ search failure)** a throwing child is scored `-Infinity` and dropped via
  `allSettled`; the search still returns the best surviving leaf; **all** nodes throwing → a clean `fail`.
- **AC-9 (off-by-default inert)** loaded-but-not-enabled → `tree_search` is unavailable/inert.
- **AC-10 (parent transcript unmutated)** after `tree_search`, `e.agent.messages` holds only the
  user/assistant/tool-result for the `tree_search` call — no losing-branch internal turns leak (children are
  separate `Agent` instances).
- **AC-11 (no kernel change)** `kernel-surface` green; `src/kernel` still **2186**; `BUILTIN_EXTENSIONS`
  count unchanged (new tool, not new extension); declares `agent:spawn`.

## 8. Risks and Rollback

- **R1 — fan-out / cost explosion.** *Mitigation:* the hard `maxNodes` cap (KDD-3) + param clamping + the
  `ctx.signal`→`stop` abort wiring; off by default. *Rollback:* `/reasoning-search off` / kill switch.
- **R2 — dangling `tool_use` when forking a node.** The root snapshot is taken mid-dispatch (the in-flight
  `tree_search` tool_use dangles), and an intermediate node whose child ended on an unresolved tool_call
  would dangle too. *Mitigation:* apply `withoutDanglingToolUse` at **every** `forkFrom` (root and
  intermediate), not just the root. *Pinned by:* a test that a node whose state ends on a tool_call forks to
  a provider-valid transcript.
- **R3 — non-determinism in tests** (all children share one MockProvider). *Mitigation:* AC-3 uses
  order-invariant `longest`/`shortest` scorers + `beam:1`, as `best_of_n`'s tests do; never asserts on
  `judge` ordering.
- **R4 — a degenerate empty frontier** (all children at a depth throw / score `-Infinity`). *Mitigation:*
  if a depth produces no surviving node, terminate and return the best node found **so far** (the best of the
  previous frontier), not an error — only an all-empty **first** depth yields `fail`.
- **R5 — no early goal-termination** (v1 always runs to `depth`). *Accepted, documented:* depth-bounded
  termination is the v1 contract; a goal-threshold early-stop is a deferred follow-up (registered at F).
- *Rollback:* `tree_search` is an additive tool in one file; removing its registration (or the kill switch)
  restores byte-identical pre-change behavior. `best_of_n` is untouched.

## L1 Review Log

- **Round 1** — PASS (zero severe; realizability crux confirmed sound) + 3 generals (multi-wave abort must
  follow the moving frontier; `maxNodes` clip-granularity unpinned; the `36`-vs-`28` worst-case figure) + 4
  clarifications (D2 forkChild-already-takes-AgentState; AC-3 keyed responder; §6 KDD-4→D3 citation; the
  latency exclusion is legitimate). All folded.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
