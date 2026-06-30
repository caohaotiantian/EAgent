# Implementation — Tree-of-Thought search (`tree_search`)

**Slug:** `2026-06-30-tree-search` (matches design) · **Design:**
[`design/2026-06-30-tree-search.md`](../design/2026-06-30-tree-search.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D6 — the `tree_search` tool + `forkFrom` + recursion guard, in the existing `reasoning-search` extension | design §2 D1-D6, KDD-1..6, AC-1..AC-11 |

One Phase: a new tool + two small helpers inside `src/extensions/reasoning-search.ts` (no new file, no
`host.ts` edit, no kernel change), plus tests. `best_of_n` is left **byte-identical**.

## 2. Phase Breakdown

### Phase 1 — `tree_search`

- **Entry condition:** on `feat/tree-search` off `init`. Baseline `npm test` green (1104 pass / 1105 tests / 1 skipped, post-deferred-cleanup trunk), kernel 2186.
- **Design refs:** §2 D1-D6; KDD-1 (beam search), KDD-3 (`maxNodes` clip-to-budget), KDD-4 (forked-state
  node), KDD-5 (global best-so-far), KDD-6 (compose, no kernel change); AC-1..AC-11.
- **Files:** `src/extensions/reasoning-search.ts` (extend), `test/tree-search.test.ts` (new).

- **Constants (module-level, beside the existing `DEFAULT_N`/`DEFAULT_MAX_N`):**
  `TREE_SEARCH = "tree_search"`, `DEFAULT_BRANCH = 3`, `DEFAULT_MAX_BRANCH = 4`, `DEFAULT_BEAM = 2`,
  `DEFAULT_MAX_BEAM = 3`, `DEFAULT_DEPTH = 2`, `DEFAULT_MAX_DEPTH = 3`, `DEFAULT_MAX_NODES = 16`,
  `HARD_MAX_NODES = 32`. A `clamp(v, lo, hi)` helper.

- **D3 recursion guard (1-line):** add `TREE_SEARCH` to `childRegistryFrom`'s skip-set (it already skips
  `BEST_OF_N`/`SPAWN_TOOL`, `:72`). This makes **both** `best_of_n`'s and `tree_search`'s forked children
  unable to launch a nested `tree_search` (or `best_of_n`/`spawn_agent`). No other change to `childRegistryFrom`.

- **D2 `forkFrom` (closure in `activate`, beside `forkChild`):**
  `const forkFrom = (state: AgentState): Agent => forkChild({ ...state, messages: withoutDanglingToolUse(state.messages) });`
  — internalizes the dangling-`tool_use` prune so **every** fork (root + intermediate) starts provider-valid.
  `forkChild` (`:139`) is unchanged; `best_of_n` keeps its existing external prune + `forkChild` (byte-identical).

- **D1+D4 `tree_search` tool** (`capabilities: ["agent:spawn"]`, params per design D1). `execute(args, ctx)`:
  1. `if (!isEnabled()) return fail("tree_search: disabled — enable with \`/reasoning-search on\`.")`.
  2. `const task = typeof args.task === "string" ? args.task : ""; if (!task) return fail(\`${TREE_SEARCH} requires a non-empty string \`task\`.\`)`.
  3. Clamp: `branch = clamp(n(args.branch, DEFAULT_BRANCH), 1, DEFAULT_MAX_BRANCH)`; `beam` similarly to
     `[1, DEFAULT_MAX_BEAM]`; `depth` to `[1, DEFAULT_MAX_DEPTH]`; `maxNodes = clamp(n(args.maxNodes,
     DEFAULT_MAX_NODES), branch, HARD_MAX_NODES)` (lower bound `branch` so depth-1 always runs).
     `const scorer = pickScorer(args.scorer, task, ctx);`
  4. `const root: AgentState = e.agent.snapshot();` (the prune happens inside `forkFrom`).
     `interface Node { state: AgentState; text: string; score: number; }`
     `let frontier: Node[] = [{ state: root, text: "", score: -Infinity }];` (the root, unexpanded).
     `let best: { text: string; score: number } | null = null;` `let used = 0;` `const details: …[] = [];`
  5. **Moving-frontier abort (G1):** `let live: Agent[] = [];` `const stopLive = () => { for (const c of
     live) c.stop(); };` `ctx.signal.addEventListener("abort", stopLive);` … `finally {
     ctx.signal.removeEventListener("abort", stopLive); }`.
  6. **Depth loop** `for (let d = 0; d < depth; d++)`:
     - `if (ctx.signal.aborted) break;`
     - **Expand (clip to budget):** build `const children: Agent[] = [];` by iterating `frontier`, and for
       each node up to `branch` times: `if (used >= maxNodes) break;` `children.push(forkFrom(node.state)); used++;`
       (break the outer loop too when `used >= maxNodes`). `if (children.length === 0) break;` (budget
       exhausted → terminate). `live = children;`
     - **Run + collect:** `const settled = await Promise.allSettled(children.map(async (c) => { await c.run(task); return { text: finalText(c.messages), state: c.snapshot() }; }));`
     - **Score** (only fulfilled; a rejected child is dropped = score `-Infinity`, never selected):
       `const scored: Node[] = []; for (const r of settled) { if (r.status !== "fulfilled") continue; const score = await scorer(r.value.text); scored.push({ state: r.value.state, text: r.value.text, score }); }`
     - **Global best (KDD-5):** `for (const c of scored) if (!best || c.score > best.score) best = { text: c.text, score: c.score };`
     - `details.push(scored.map((c) => ({ score: c.score, text: c.text.slice(0, 120) })));`
     - **Prune to beam:** `scored.sort((a, b) => b.score - a.score); frontier = scored.slice(0, beam);`
       `if (frontier.length === 0) break;` (whole wave rejected → terminate with best-so-far).
  7. `if (!best) return fail("tree_search: every branch failed.");` `return ok(best.text, { details });`

- **D5:** register the tool only when the extension activates (same gate as `best_of_n`); add `tree_search`
  to the `/reasoning-search status` line. `e.grantCapability("agent:spawn")` already called for `best_of_n`.

- **Task list (TDD order)** — `test/tree-search.test.ts` (study `test/reasoning-search.test.ts` first; reuse
  `makeHarness` + the enable-the-extension pattern; the blocking-provider at
  `reasoning-search.test.ts:410-489` is a *starting point* that must be adapted for the multi-wave case — see
  step 5):
  1. **(test) AC-3 multi-step beam selects best path** — a **function responder** keyed on the **whole
     `req.messages`** (NOT just the task: sibling forks share an identical `task`, so a task-keyed responder
     returns identical text for every sibling and every depth). Detect depth via the transcript (e.g. the
     presence/count of a prior assistant "thought" turn) and the lineage, scripting one lineage to yield the
     **longest** text at each depth; `tree_search({ task, branch:2, beam:1, depth:2, scorer:"longest" })`
     returns that lineage's final text; assert `details.length === 2`. (The `mock.ts:34-37` responder
     receives the full request, so whole-transcript keying is realizable.)
  2. **(test) AC-4 bounded + clip + best-so-far** — a config whose worst case exceeds a small `maxNodes`
     (e.g. `branch:4, beam:3, depth:3, maxNodes:5`) runs **≤ maxNodes** child agents — count via a
     **provider call-counter** (increment per child run, e.g. on each `lastUserText === task` stream call;
     `forkFrom` is an `activate` closure a test cannot wrap) — and returns a node (best-so-far), not `fail`;
     `branch:99` clamps to `DEFAULT_MAX_BRANCH`; `maxNodes:1` clamps up to `branch`.
  3. **(test) AC-5 recursion guard** — a forked node's registry (via `childRegistryFrom(e.agent.tools.list())`)
     contains **neither** `tree_search` **nor** `best_of_n`.
  4. **(test) AC-6 governed** — a parent `beforeToolCall` guard blocking a tool also blocks it inside a forked
     node (childScope carries).
  5. **(test) AC-7 abort multi-wave** — a custom provider that **lets depth-1 complete but blocks at depth ≥ 2**
     (discriminate by transcript depth — block only when the request already carries a depth-1 thought; do
     NOT copy `reasoning-search.test.ts:410-489` verbatim — that `BlockingForkProvider` blocks *every* fork
     turn, so depth-1 never settles, depth-2 is never reached, and the abort-at-depth-2 case is unreachable /
     deadlocks). Abort `ctx.signal` while **depth 2** is live; assert every live (depth-2) child got `stop()`
     and the tool returns/rejects promptly (not the stale depth-1 set). Wrap in a timeout so a regression to
     a fixed-array handler fails rather than hangs.
  6. **(test) AC-8 allSettled** — one child's provider throws → its branch is dropped, the search returns the
     best survivor; **all** children throw → a clean `fail`.
  7. **(test) AC-9 off-by-default inert** — loaded-but-not-enabled → `tree_search` unavailable/inert.
  8. **(test) AC-10 parent transcript unmutated** — after `tree_search`, `e.agent.messages` holds only the
     user/assistant/tool-result for the `tree_search` call (no losing-branch internal turns).
  9. **(impl)** implement constants + `clamp` + the `childRegistryFrom` 1-line + `forkFrom` + the `tree_search`
     tool + the status-line mention.
  10. **(verify)** `node --import tsx --test "test/tree-search.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/tree-search.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Exit:** AC-1..AC-11 pass; `npm test` green; typecheck 0; kernel 2186; `BUILTIN_EXTENSIONS` count unchanged.

## 3. Engineering Constraints Index

- CLAUDE.md "House conventions" + "Adding an extension" (this is a new tool in an existing extension): ESM
  NodeNext `.js` specifiers; strict TS (`noUncheckedIndexedAccess` — guard `frontier[i]`, `scored[i]`,
  `settled[i]`, `details[i]` access); zero deps but jiti; offline tests (MockProvider; deterministic
  `longest`/`shortest` for selection, a blocking custom provider for abort); **no kernel change** (composes
  `Agent` + `childScope` + `snapshot`/`restore` + reasoning-search helpers); declares `agent:spawn`; off by
  default (reuses `reasoning-search`'s `enabled` flag + `EAGENT_REASONING_SEARCH=off`). Surgical: do **not**
  alter `best_of_n`'s behavior; no provenance comments (no `// G1`, `// AC-7`, `// per KDD-3`).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` two ways: (a) a **function responder** (`mock.ts:34-37`) keyed on the **whole `req.messages`**
for AC-3's per-depth tree scripting (depth detectable via the prior-thought presence; task-keying alone is
insufficient — siblings share the task); (b) a custom `Provider` for AC-7 that **lets depth-1 complete and
blocks only at depth ≥ 2** (NOT a verbatim copy of `reasoning-search.test.ts:410-489`'s every-turn
`BlockingForkProvider`, which would deadlock at depth-1). A parent `beforeToolCall` guard for AC-6.
Order-invariant `longest`/`shortest` scorers keep AC-3's *winning text* deterministic. Offline; no new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. `best_of_n` untouched (its tests stay green unchanged — the
  external-prune+`forkChild` path is unchanged; `childRegistryFrom` only **adds** `tree_search` to the
  skip-set, which a `best_of_n` child never had anyway).
- The canonical-set host test covers no new registration (no new extension) — `BUILTIN_EXTENSIONS` length
  unchanged; the new tool name `tree_search` must not collide (assert via host canonical-set / a dup-name
  check).
- No kernel change → `kernel-surface.test.ts` unaffected (2186).

## L2 Review Log

- **Round 1** — PASS (zero severe; realizability crux — forkFrom composition, byte-identical best_of_n,
  moving-frontier abort — confirmed) + 1 general (AC-7's cited blocking-provider deadlocks at depth-1; must
  let depth-1 complete + block at depth ≥ 2) + clarifications (AC-3 key on whole `req.messages`; AC-4 provider
  call-counter not the closure `forkFrom`; baseline count). All folded.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**
