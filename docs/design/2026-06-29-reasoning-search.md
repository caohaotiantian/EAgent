# Design — Reasoning-search controller (best-of-N over forked agents)

```
Status: closed
Closing-commit: 3bba4e4
Closed-on: 2026-06-29
Deferred: RW8a-1 (ToT/GoT multi-step tree/graph search) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-reasoning-search` · **Wave:** 8 (subsystem 1 of 2) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P4.1 · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md` §C (LangGraph branching / fork-as-primitive)

## 1. Background and the gap (code as truth)

A Wave-8 surface audit: `search.ts` is `glob`/`grep` (filesystem), **not** reasoning-search — so a
best-of-N / tree-of-thought controller is genuinely missing. The primitives it needs already exist:

- **Fork is already a solved extension pattern.** `subagents.ts` constructs child agents with
  `new Agent({ …, hooks: e.agent.hooks.childScope() })` (`subagents.ts:78-88`) and fans them out with
  `Promise.all` (`subagents.ts:238-246` — note: **unbounded**, child count = number of model-supplied
  prompts), gated by `agent:spawn` (`:50,132`). Crucially, each child gets a **fresh registry copying the
  parent's tools MINUS `spawn_agent`** (`buildChildRegistry`, `subagents.ts:57/473-480`) — its core
  recursion guard. The `Agent` constructor is public and takes `AgentOptions` (`agent.ts:39,115`); it has
  **no `commands` field** and **no concurrency throttle on fan-out** (`maxConcurrency`, `agent.ts:49`, caps
  one agent's *tool-wave* parallelism, not child spawning).
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
- [ ] **D2** A `best_of_n` tool: params `{ task: string, n?: number (default 3), scorer?:
  "judge" | "shortest" | "longest" (default "judge") }`. It (a) `snapshot()`s the current agent,
  (b) forks **N** child agents `new Agent({ providers, capabilities, tools: childRegistry(),
  hooks: e.agent.hooks.childScope() })` — **NO `commands` field** (not in `AgentOptions`) — each
  `restore(snapshot)`-d so each branch inherits the **conversation** (this restore-from-parent-snapshot is
  reasoning-search's own pattern; `subagents` starts children *fresh* — KDD-5 owns the divergence) +
  **governance** (via `childScope`), (c) runs each child via `child.run(task)` (so the child sees
  `[restored conversation] + [task as a new user turn]`, `agent.ts:217`) — fan-out is `Promise.all` over
  the **N-capped** set (N is the bound; see KDD-3 — there is no kernel fan-out throttle to reuse),
  (d) **scores** the N final outputs to a number and takes the **argmax**, (e) returns the **best**
  candidate's text (+ details: per-candidate score). The parent transcript is **not** mutated by losing
  branches (children are separate agents; only the returned text re-enters via the tool result).
  **`childRegistry()` (recursion guard, S1):** a fresh per-child `ToolRegistry` copying the parent's tools
  **MINUS `best_of_n` (and `spawn_agent`)** — exactly `subagents`' `buildChildRegistry` guard
  (`subagents.ts:57`); without it a child running `task` could call `best_of_n` and re-fork exponentially.
  A per-child copy also prevents a child's registrations leaking to the parent/siblings.
- [ ] **D3** Scorers — **every scorer is `candidate → number`; `best_of_n` takes the argmax** (uniform,
  testable). `shortest`/`longest` = `-length`/`length` (deterministic, offline-pinned). `judge` (default) =
  a **per-candidate** score via a recursion-safe tool-less sub-call: `provider.stream({ tools: [], … })`
  (the `evals` pattern, `evals.ts:483-491`) graded with the **exported** `parseJudgeReply` (grammar
  `SCORE <n>/10 …`, `evals.ts:181`) → its `score`. NOTE (C1/C2): this **reimplements** the tool-less
  sub-call and **imports only `parseJudgeReply`** — it does NOT call evals' `judge` *tool* (cross-extension,
  off-by-default) and does NOT reuse a "best-index" grammar (none exists). A malformed/absent judge reply
  scores 0 (fail-soft, never throws); all-zero → fall back to candidate 0.
- [ ] **D4** Governance + bounds: children use `childScope()` (parent **gate filters** govern them —
  Wave 3) + the `childRegistry()` recursion guard (D2). **The bound is the N cap** (`n` clamped to a max,
  default 5) — there is **no** kernel fan-out throttle or `subagents` spawn-budget to reuse (review S2);
  `Promise.all` runs the ≤N children. (If concurrent-child *throttling* is later wanted, a small pool is
  net-new, not a reuse.) Child `usage` is **not** folded into `e.agent.usage` (each agent has private
  `#usage`); rather a `usage` **observer** on the parent bus receives children's `usage` events via the
  shared event (Wave 3, `childScope` doesn't suppress `usage`) — so a cost/budget guard still sees them.
  Declares `agent:spawn`.
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
(b) the extension forks via `new Agent({hooks: childScope()})` (the **constructor** pattern `subagents.ts`
proves) then `.restore(snapshot())` to inherit the conversation. *Choice:* **(b)** — the *construction*
pattern is proven in `subagents`; the *restore-from-parent-snapshot* step is reasoning-search's own
addition (subagents deliberately starts children **fresh**, never `restore`s — `subagents.ts:12-18,111`;
KDD-5 owns this divergence). `restore()` works on a fresh non-running child (`agent.ts:203`). All primitives
(constructor, childScope, snapshot/restore) are public and sufficient; adding a kernel `Agent.fork()`
spends scarce ceiling lines (2187/2200) on a convenience an extension expresses cleanly. *Rejected:*
(a) unnecessary kernel growth against the small-kernel bet.

### KDD-2 — Single-step best-of-N first, not ToT/GoT
*Problem:* P4.1 lists best-of-N/ToT/GoT. *Options:* (a) build a general tree/graph search controller;
(b) ship best-of-N (one fork-set, scored, select) and defer multi-ply search. *Choice:* **(b)** — best-of-N
is the highest-value, lowest-complexity slice; it exercises the fork+score+select spine that ToT/GoT would
reuse, and is fully offline-testable. ToT/GoT add expansion/backtracking/frontier management — a separate,
larger design once best-of-N proves out. *Rejected:* (a) speculative scope-balloon.

### KDD-3 — Governed children via `childScope` + pruned registry; N is the bound (no phantom throttle)
*Problem:* N forked agents could bypass guards, **re-fork recursively**, or blow up cost. *Options:*
(a) raw `new Agent()` with the parent's live registry by reference (fresh bus = the Wave-3 hole; live
registry = recursion + leak); (b) `childScope()` children (gate filters govern every branch) **+ a fresh
`childRegistry()` per child that removes `best_of_n`/`spawn_agent`** (the recursion guard,
`subagents.ts:57`) **+ an N cap** (`n ≤ max`, the *real and only* fan-out bound). *Choice:* **(b)**.
Correction (review S2): there is **no** kernel `maxConcurrency` fan-out throttle and **no** `subagents`
spawn-budget to "mirror" — those claims were false; the bound is the N cap, and `Promise.all` runs the ≤N
children. The recursion guard (pruned registry) is what prevents depth-blowup (the N cap only bounds one
level). Governance: children inherit `beforeToolCall`/`afterToolCall` (Wave 3); `usage` reaches the parent
**bus** as events (D4), not via `agent.usage`. *Rejected:* (a) re-opens the governance hole + allows
recursive re-fork.

### KDD-4 — `judge` default scorer with deterministic fallbacks
*Problem:* scoring N candidates needs a ranker; an LLM judge isn't deterministic for tests. *Options:*
(a) judge-only; (b) `judge` default + `shortest`/`longest` deterministic scorers for offline tests +
a fail-soft fallback. *Choice:* **(b)** — judge is the realistic ranker (reuses the recursion-safe judge
pattern); the heuristic scorers make the fork/select machinery offline-testable without a live model, and
a malformed judge reply falls back to candidate 0 (never throws). *Rejected:* (a) untestable offline +
brittle on a bad judge reply.

### KDD-5 — Children inherit the conversation (restore-from-snapshot) — owning the subagents divergence
*Problem:* should a best-of-N child see the parent conversation or start fresh? *Options:* (a) fresh
(subagents' model — a child is an isolated sub-task); (b) restore the parent snapshot so each branch
continues *from the current state* (the point of best-of-N: N continuations of the same reasoning).
*Choice:* **(b)** — best-of-N means "N ways forward from here," which requires the shared prior context;
this is a deliberate divergence from subagents (which is fresh-context by design). Cost: each child
`structuredClone`s the transcript on `restore()` (~N+1 clones/call, bounded by N≤max, ephemeral — R1).
*Rejected:* (a) would make the N children solve the sub-task without the conversation, defeating
"continue from here."

## 5. Dependencies and Assumptions

Reuses `subagents.ts`'s child-construction pattern (`new Agent` + `childScope` + bounded `Promise.all`),
Wave 4 `snapshot()`/`restore()`, Wave 3 `childScope()` + usage bubbling, and `evals`'s judge pattern (or a
fresh tool-less child). Assumes the `Agent` constructor is public + accepts shared registries
(`agent.ts:39,115` — it is, and `subagents` proves it). Assumes a scriptable/real provider for the children
(offline tests use MockProvider + the deterministic scorers). `agent:spawn` is the authority (host policy
gates it). No network, no deps.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P4.1; research §C. Composes Wave 3 (childScope governance), Wave 4
(snapshot/restore), and the `subagents` construction + pruned-registry pattern; **reimplements** evals'
tool-less judge sub-call (importing only the exported `parseJudgeReply`, not the cross-extension `judge`
tool — D3). Sibling to the Wave-7a
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
- **AC-5 (bounded + usage via events)** `n` above the cap (default max 5) is clamped; assert no more than
  `cap` children run. Child `usage` reaches the parent **bus**: register a `usage`-event observer on the
  parent and assert it receives the children's `usage` events (NOT `e.agent.usage`, which is the parent's
  own private counter — review G2). Plus the **recursion guard**: a child's `childRegistry()` does **not**
  contain `best_of_n` (assert it can't re-fork).
- **AC-6 (parent transcript unmutated by losers)** After `best_of_n`, the parent `agent.messages` contains
  only the user/assistant/tool-result for the `best_of_n` call itself — **not** the losing branches'
  internal turns (they ran in separate child agents).
- **AC-7 (scorer fallbacks)** `shortest`/`longest` are deterministic (pinned offline); a `judge` scorer
  with a malformed reply falls back to candidate 0 without throwing.
- **AC-8 (off-by-default inert)** With the extension loaded but not enabled, `best_of_n` is unavailable or
  inert; host canonical-set green (`BUILTIN_EXTENSIONS.length` +1, no dup tool/command names); no kernel
  change (`kernel-surface` 2187).

*Quality budget:* N child runs bounded by the **N cap** (default 5) — the only bound (no fan-out
concurrency cap / spawn budget exists to reuse, S2); opt-in. The judge is one extra sub-call per candidate.
Each child `restore()`s a transcript clone (~N+1 `structuredClone`s). Documented; not a hot path. Excluded.

## 8. Risks and Rollback

- **R1 — Fan-out cost blow-up.** *Mitigation:* the **N cap** (`n ≤ max`, default 5) is the bound (there is
  no kernel concurrency throttle / spawn-budget to reuse — review S2); off by default. Each child
  `restore()`s a transcript clone (~N+1 `structuredClone`s/call, bounded by N, ephemeral). *Rollback:*
  `/reasoning-search off` / kill switch.
- **R1b — Recursive re-fork (depth blow-up).** *Mitigation:* each child's `childRegistry()` removes
  `best_of_n`/`spawn_agent` (KDD-3/AC-5) so a child cannot re-fork; the N cap only bounds one level, so
  this guard is essential. *Rollback:* n/a.
- **R2 — Ungoverned children (Wave-3 hole).** *Mitigation:* `childScope()` children (AC-4 pins gate-filter
  inheritance); `usage` events reach the parent bus (not `agent.usage`). *Rollback:* n/a.
- **R3 — Non-deterministic judge breaks tests.** *Mitigation:* `shortest`/`longest` deterministic scorers
  for tests (AC-3/AC-7); judge fail-soft fallback. *Rollback:* n/a.
- **R4 — Parent-transcript contamination from branches.** *Mitigation:* children are separate agents; only
  the winning text returns via the tool result (AC-6). *Rollback:* n/a.
- **R5 — README table/count stale.** *Mitigation:* reconcile at F (56→57).

A single off-by-default extension composing existing fork/score primitives; reverting the registration
removes it cleanly with zero kernel/other-component effect.

## L1 Review Log

- **Round 1** — 2 SEVERE: S1 recursion hole (children got the parent registry by reference incl
  `best_of_n` → exponential re-fork) — fixed with a per-child pruned `childRegistry()` (the
  `subagents.ts:57` guard, extended to drop `best_of_n`); S2 cost-bounding factually wrong (subagents'
  `Promise.all` is unbounded; `maxConcurrency` is a tool-wave cap; no spawn budget exists) — the N cap is
  the only bound. + generals (no `commands` in AgentOptions; usage via parent-bus event; restore-from-
  snapshot is the divergence from subagents) + clarifications (scorer candidate→number+argmax; reimplement
  the tool-less judge + import only `parseJudgeReply`; child input; transcript-copy cost). All fixed.
- **Round 2** — 1 general (the §7 quality-budget footnote still cited the phantom spawn budget). Fixed.
- **Round 3** — **zero severe, zero general** (one immaterial citation drift, fixed).
- **Round 4 (corroborating)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
  (L2 note: the reimplemented judge needs its own system prompt pinning the `SCORE <n>/10 …` grammar —
  `JUDGE_SYSTEM_PROMPT` is module-private.)
