# Light-Mode brief — graph_search multi-round refine-to-convergence (RW8a-3)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-01
Deferred: the operations-DSL and tree_search→graph_search composition sub-parts of RW8a-3 stay deferred
(speculative generality; the composition entangles the shared recursion-guard registry pruning at
`reasoning-search.ts:89`). This slice ships only the refine-to-convergence sub-part.

**Slug:** `2026-07-01-graph-search-refine-rounds` · **Tier:** Light (`src/extensions/reasoning-search.ts`
+ `test/graph-of-thought.test.ts`; additive optional param, byte-identical when default; off-by-default
tool; no breaking change, no new contract, no migration; one surfaced default). Source:
`docs/DEFERRED-FOLLOWUPS.md` RW8a-3 (the refine-to-convergence part). Branch: `chore/finish-followups-4`.

## What / why

`graph_search` (Graph-of-Thought, off by default) runs a fixed **single** refine pass on the best node
(`reasoning-search.ts:513-523`). RW8a-3's refine-to-convergence: allow **multiple** refine rounds,
stopping early once a round no longer improves the best score. Mirrors the just-shipped `tree_search`
`goalScore` early-stop (RW8a-2).

**Change:** add an optional `refineRounds?: number` (clamped `1..DEFAULT_MAX_BRANCH`, **default 1**).
Replace the single refine block with a loop: for each round, fork from root → `refinePrompt(task,
best.text)` → `record("refine", …)`; **break on the first round that does not improve `best.score`**
(convergence), on abort, or on a failed op. **Default 1 ⇒ exactly one refine pass = current behavior,
byte-identical.**

## Explicit non-goals (Simplicity First)

- Only refine-to-convergence. No operations-DSL, no cross-tool `tree_search→graph_search` composition
  (deferred, see closure block).
- No change to the generate/aggregate phases, the scorer, the `refine` boolean gate (a `refine:false`
  still runs zero refine rounds), the fork/recursion guard, or `best`-tracking (stays in the outer flow
  for TS narrowing, as today).
- No kernel change, no new capability, no new dependency.

## Any >1-option decision surfaced

- **Convergence criterion + default** — (a) `refineRounds` bound + stop-on-first-non-improving round,
  default 1 (**chosen**); (b) a fixed score-delta epsilon threshold (a magic number); (c) always run to
  the bound. **Chosen (a)**: no magic-number threshold (a round either strictly improves `best.score` or
  it doesn't — the global best already never regresses), default-1 keeps the current single-pass
  behavior byte-identical, and it mirrors RW8a-2's additive-optional-param shape. (b) introduces a tuning
  constant; (c) wastes forks past convergence.

## Measurable acceptance command

- `node --import tsx --test test/graph-of-thought.test.ts` exit 0 — a NEW test: `scorer:"longest"`
  (deterministic = text length), script the MockProvider so refine round 1 returns a **longer** answer
  (improves) and round 2 returns an **equal-or-shorter** answer (no gain); call `graph_search` with
  `refineRounds:3`; assert `details` records **two** `refine` ops (round 1 improved, round 2 didn't →
  converged, loop stops before round 3) and the returned text is round 1's. A control with
  `refineRounds` unset (default 1) records exactly **one** refine op (byte-identical).
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-01. `graph_search` gained optional `refineRounds?` (clamp `1..DEFAULT_MAX_BRANCH`,
default 1); the single refine block is now a loop that breaks the first round not improving `best.score`
(convergence), on abort, or on a failed op. Default 1 ⇒ exactly one refine pass, byte-identical to `init`
(reviewer diffed the blocks; the default-control test is green both ways). Light-Mode fresh review
**pass** (clean first round; TS-narrowing safe, `refine:false` still zero rounds, genuine red→green
discriminator). Gates: graph-of-thought 13 pass, `npm test` 1162 pass / 0 fail / 1 skip, typecheck 0,
eval 5/5, `src/kernel/` untouched, no new dependency. (The operations-DSL and tree_search→graph_search
composition sub-parts of RW8a-3 remain CLOSED — speculative generality; see the deferred register.)
