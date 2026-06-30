# Implementation — Graph-of-Thought (`graph_search`)

```
Status: closed
Closing-commit: 575a287
Closed-on: 2026-06-30
Deferred: RW8a-3 (GoO DSL / multi-round refine / cross-tool) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-30-graph-of-thought` (matches design) · **Design:**
[`design/2026-06-30-graph-of-thought.md`](../design/2026-06-30-graph-of-thought.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D6 — the `graph_search` tool (generate→aggregate→refine) + the 1-line recursion guard | design §2 D1-D6, KDD-1..6, AC-1..AC-12 |

One Phase: a new tool + two prompt builders inside `src/extensions/reasoning-search.ts` (no new file, no
`host.ts` edit, no kernel change), plus tests. `best_of_n` and `tree_search` are left **byte-identical**.

## 2. Phase Breakdown

### Phase 1 — `graph_search`

- **Entry condition:** on `feat/graph-of-thought` off `init` (post-`tree_search` merge). Baseline `npm test`
  green (1117 pass / 1118 tests / 1 skipped), kernel 2186.
- **Design refs:** §2 D1-D6; KDD-1 (aggregate+refine), KDD-3 (fork-root+prompt), KDD-4 (fixed branch+2 bound),
  KDD-5 (global best, no regress), KDD-6 (compose, no kernel change); AC-1..AC-12.
- **Files:** `src/extensions/reasoning-search.ts` (extend), `test/graph-of-thought.test.ts` (new).

- **Constants:** `GRAPH_SEARCH = "graph_search"`. Reuse `DEFAULT_BRANCH=3`, `DEFAULT_MAX_BRANCH=4`, `clamp`.

- **D5 recursion guard (1-line):** add `|| name === GRAPH_SEARCH` to `childRegistryFrom`'s skip-set (it
  already skips `BEST_OF_N`/`SPAWN_TOOL`/`TREE_SEARCH`, `:87`). No other change.

- **Prompt builders (module-level, distinct markers so a test responder can key on them):**
  - `aggregatePrompt(task, thoughts: string[]): string` →
    `"Combine these candidate answers into one best answer.\nTask: ${task}\n\n" +
     thoughts.map((t, i) => \`Candidate ${i + 1}:\n${t}\`).join("\n\n") +
     "\n\nReturn a single improved answer that combines their strengths."`
  - `refinePrompt(task, answer: string): string` →
    `"Improve this answer.\nTask: ${task}\n\nCurrent answer:\n${answer}\n\nReturn a better version."`
  (The leading "Combine these candidate answers" / "Improve this answer" are the markers AC-3/AC-4's responder
  matches; a generate turn's last user message is the bare `task`.)

- **D1-D4 `graph_search` tool** (`capabilities: ["agent:spawn"]`, params per design D1). `execute(args, ctx)`:
  1. `if (!isEnabled()) return fail("graph_search: disabled — enable with \`/reasoning-search on\`.")`.
  2. `task` = string or `""` → `fail` if empty.
  3. `const branch = clamp(intArg(args.branch, DEFAULT_BRANCH), 1, DEFAULT_MAX_BRANCH);` (reuse the existing
     `intArg` reader, `reasoning-search.ts:125`, exactly as `tree_search` does at `:327` — **not** an `n(...)`
     helper, which does not exist) `const refine = args.refine !== false;` (default true)
     `const scorer = pickScorer(args.scorer, task, ctx);`
  4. `const root = e.agent.snapshot();` `let best: { text: string; score: number } | null = null;`
     `const details: { op: string; score: number; text: string }[] = [];`
  5. **Abort (moving `live` across 3 phases):** `let live: Agent[] = [];`
     `const stopLive = () => { for (const c of live) c.stop(); };`
     `ctx.signal.addEventListener("abort", stopLive);` … `finally { ctx.signal.removeEventListener("abort", stopLive); }`.
  6. A `score+record` helper that **returns** the node — the `best` update stays in the **outer flow**
     (SEVERE: assigning `best` *inside* an `async` closure defeats TS's control-flow narrowing — the outer
     reads of `best` then collapse to `never` and `tsc` fails; mirror `tree_search`'s outer-flow update at
     `reasoning-search.ts:388`):
     `const record = async (op: string, text: string): Promise<{ text: string; score: number }> => { const score = await scorer(text); details.push({ op, score, text: text.slice(0, 120) }); return { text, score }; };`
  7. **GENERATE:** `const gen = Array.from({ length: branch }, () => forkFrom(root)); live = gen;`
     `const settled = await Promise.allSettled(gen.map(async (c) => { await c.run(task); return finalText(c.messages); }));`
     `const thoughts: string[] = [];` then **iterate in the outer flow** — `for (const r of settled) { if (r.status !== "fulfilled") continue; thoughts.push(r.value); const node = await record("generate", r.value); if (!best || node.score > best.score) best = node; }` (the `best =` is in the outer for-loop body → narrowing holds).
  8. **AGGREGATE** (skip if already aborted): `if (!ctx.signal.aborted) { try { const agg = forkFrom(root); live = [agg]; await agg.run(aggregatePrompt(task, thoughts)); const node = await record("aggregate", finalText(agg.messages)); if (!best || node.score > best.score) best = node; } catch { /* dropped — allSettled-equivalent fault isolation */ } }`.
  9. **REFINE** (if `refine` and `best` and not aborted): `if (refine && best && !ctx.signal.aborted) { try { const ref = forkFrom(root); live = [ref]; await ref.run(refinePrompt(task, best.text)); const node = await record("refine", finalText(ref.messages)); if (!best || node.score > best.score) best = node; } catch { /* dropped */ } }`. Refines the **current** post-aggregate global best.
  10. `if (!best) return fail("graph_search: every operation failed.");` `return ok(best.text, details);`
     (flat second arg — matches `best_of_n` `ok(text, candidates)` `:289` and `tree_search` `ok(text, details)`
     `:400`; so `result.details` is the array, not `{ details: array }`. Tests read `result.details`.)
  **The `ctx.signal.aborted` guards (steps 8/9)** prevent launching a sequential op after the one-shot
  `stopLive` listener already fired (an abort during GENERATE would otherwise launch a blocking aggregate
  fork that never receives `stop()` → hang), mirroring `tree_search`'s per-wave `if (ctx.signal.aborted) break`
  (`reasoning-search.ts:355`).

- **D5 register:** at activate (same gate as `best_of_n`/`tree_search`); add `graph_search` to the
  `/reasoning-search status` line. `e.grantCapability("agent:spawn")` already called.

- **Task list (TDD order)** — `test/graph-of-thought.test.ts` (study `test/tree-search.test.ts` first; reuse
  its `makeHarness`/`enable`/`lastUserText`/`done`/`withTimeout`/`toolResults` helper patterns):
  1. **(test) AC-3 aggregate produced + can win** — a responder keyed on the prompt: a **generate** turn
     (`lastUserText === TASK`) returns short texts; the **aggregate** turn (last user message starts with
     "Combine these candidate answers") returns a **longer** text. `graph_search({ task, branch:3,
     scorer:"longest", refine:false })` returns the aggregate text; `details` has an `op:"aggregate"` node.
  2. **(test) AC-4 refine produced + can win** — `refine:true`; the **refine** turn (starts with "Improve
     this answer") returns the longest text overall → `graph_search` returns it; `details` has `op:"refine"`.
  3. **(test) AC-5 global best, no regress** — aggregate + refine turns return **shorter** texts than the
     best generated thought → `graph_search` returns the **generated** best (running global best).
  4. **(test) AC-6 bounded** — a provider call-counter on `lastUserText === TASK` **and** the two op-prompts
     (count every child run) equals `branch + 1 + (refine?1:0)`, under `scorer:"longest"` (no judge sub-call)
     + single-turn responses; `branch:99, refine:true` → 6 runs.
  5. **(test) AC-7 recursion guard** — `childRegistryFrom([graph_search, tree_search, best_of_n, helper])`
     drops all three search tools, keeps `helper`.
  6. **(test) AC-8 governed** — a parent `beforeToolCall` guard blocking a tool also blocks it inside a forked
     op node.
  7. **(test) AC-9 abort + fault** — (a) a **blocking** custom provider that blocks the aggregate turn;
     abort `ctx.signal` while the aggregate fork is live → it gets `stop()` and the tool returns/rejects
     promptly (`withTimeout`); (b) with MockProvider, the aggregate turn throws → dropped, the generated best
     is still returned; every op throws → a clean `fail`.
  8. **(test) AC-10 off-by-default inert** — loaded-but-not-enabled → `graph_search` unavailable/inert.
  9. **(test) AC-11 parent transcript unmutated** — after `graph_search`, `e.agent.messages` holds only the
     user/assistant/tool-result for the `graph_search` call (no op-internal turns leak).
  10. **(impl)** constants + the `childRegistryFrom` 1-line + the two prompt builders + the `graph_search`
      tool + the status-line mention.
  11. **(verify)** `node --import tsx --test "test/graph-of-thought.test.ts" "test/host.test.ts"`;
      `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/graph-of-thought.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Exit:** AC-1..AC-12 pass; `npm test` green; typecheck 0; kernel 2186; `BUILTIN_EXTENSIONS` count unchanged;
  `best_of_n`/`tree_search` byte-identical; the README `reasoning-search` row (`README.md:206`) mentions
  `graph_search` (doc-accuracy reconciliation — a new tool in the existing row, not a new row; done at F).

## 3. Engineering Constraints Index

- CLAUDE.md "House conventions" + "Adding an extension" (a new tool in an existing extension): ESM NodeNext
  `.js` specifiers; strict TS (`noUncheckedIndexedAccess` — guard `details[i]` access; `consider` avoids raw
  indexing); zero deps but jiti; offline tests (MockProvider; deterministic `longest`/`shortest`; a blocking
  custom provider for AC-9); **no kernel change** (composes `forkFrom`/`childScope`/`snapshot`/scorers);
  declares `agent:spawn`; off by default (reuses `reasoning-search`'s `enabled` flag + kill switch). Surgical:
  do **not** alter `best_of_n`/`tree_search`; no provenance comments (no `// G2`, `// AC-5`, `// KDD-3`).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` function responder keyed on the **last user message** (a generate turn = the bare `task`; an
aggregate turn starts with "Combine these candidate answers"; a refine turn starts with "Improve this
answer") to script each op's output; a **blocking** custom `Provider` (blocks the aggregate turn until
`signal` aborts) for AC-9; a parent `beforeToolCall` guard for AC-8. Order-invariant `longest`/`shortest`
scorers keep selection deterministic. Offline; no new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. `best_of_n` + `tree_search` untouched (their tests stay green;
  `childRegistryFrom` only **adds** `graph_search` to the skip-set, which their forks never had).
- The canonical-set host test covers no new registration (no new extension) — `BUILTIN_EXTENSIONS` length
  unchanged; the new tool name `graph_search` must not collide (host canonical-set / dup-name check).
- No kernel change → `kernel-surface.test.ts` unaffected (2186).

## L2 Review Log

- **Round 1** — 1 SEVERE (empirically reproduced): the `consider` helper assigned `best` inside an `async`
  closure → TS strict control-flow narrowing collapsed outer reads of `best` to `never` → `TS2339`, typecheck
  fails (the doc had wrongly reassured "concerns are nil"). + generals (no abort short-circuit before the
  sequential ops → post-abort hang; `n(...)` should be `intArg`; `ok(text, {details})` should be flat
  `ok(text, details)`; README exit). Fixed: a `record`-returns-node helper with the `best` update in the
  **outer flow** (mirrors `tree_search:388`); `if (!ctx.signal.aborted)` guards before aggregate/refine;
  `intArg`; flat `ok`; README reconciliation in exit.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**

## F Closeout Review

- **F end-to-end review** — **pass, zero severe.** Pipeline correct on every axis (cross-op global-best with
  strict `>`, `best` updated only in the outer flow [the L2 compile-trap avoided], the 3-phase moving-`live`
  abort with `if(!aborted)` guards proven no-hang, single-op try/catch fault isolation, all-fail→clean fail);
  `best_of_n`/`tree_search` byte-identical (only the additive guard/teardown/status edits). All ACs met with
  real non-tautological tests (AC-5 genuinely exercises the cross-op max). Consolidation: README row + RW8a-1
  SHIPPED-mark + RW8a-3 registered. Gates: typecheck 0, `npm test` 1128 pass / 1 skip, kernel 2186, ext 58.
