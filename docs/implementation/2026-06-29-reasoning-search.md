# Implementation — Reasoning-search controller (best-of-N)

```
Status: closed
Closing-commit: 3bba4e4
Closed-on: 2026-06-29
Deferred: RW8a-1 (ToT/GoT) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-reasoning-search` (matches design) · **Design:**
[`design/2026-06-29-reasoning-search.md`](../design/2026-06-29-reasoning-search.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D5 the `reasoning-search` extension + host registration | design §2 D1-D5, KDD-1..5, AC-1..AC-8 |

One Phase: a single new off-by-default extension (no kernel change) composing the existing fork primitives
+ one `BUILTIN_EXTENSIONS` line.

## 2. Phase Breakdown

### Phase 1 — The `reasoning-search` extension

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-7 merged). Baseline `npm test` green.
- **Design refs:** §2 D1-D5; KDD-1 (compose fork primitives), KDD-2 (best-of-N first), KDD-3 (pruned
  registry + N cap), KDD-4 (scorer→number argmax), KDD-5 (restore-from-snapshot divergence); AC-1..AC-8.
- **Files:** `src/extensions/reasoning-search.ts` (new), `src/host.ts` (register),
  `test/reasoning-search.test.ts` (new).
- **Data model / helpers (study `subagents.ts` first — it is the proven precedent):**
  - `childRegistry()`: build a fresh `ToolRegistry`, copy every parent tool (`e.agent.tools.list()`)
    **except** `best_of_n` and `spawn_agent` — mirror `subagents.ts`'s `buildChildRegistry`/
    `childRegistryFrom` (`:57/:473-480`), which already does this for `spawn_agent`; extend the skip-set to
    include `best_of_n` (the recursion guard, S1). A fresh per-child registry also prevents a child's
    registrations leaking to the parent/siblings.
  - `forkChild(snapshot)`: `const child = new Agent({ providers: e.agent.providers, capabilities:
    e.agent.capabilities, tools: childRegistry(), hooks: e.agent.hooks.childScope() });` then
    `child.restore(snapshot)`. (NO `commands` — not an `AgentOptions` field.) Mirror `subagents.ts:78-89`
    for the construction; the `restore(snapshot)` is reasoning-search's addition (each branch inherits the
    conversation — KDD-5).
  - `scorers` (all `candidate → number | Promise<number>`; score via `await Promise.all(outcomes.map(
    scorer))` so the async `judge` and sync heuristics are uniform — C3): `longest = (t) => t.length`,
    `shortest = (t) => -t.length`, and `judge = async (t) => <score>` via a recursion-safe **tool-less
    sub-call** mirroring `evals.ts:474-491` — guard `const p = e.agent.providers.get(); if (!p) return 0;`
    then `p.stream({ messages:[…task+candidate…], tools: [], model: e.agent.model, systemPrompt: <a local
    JUDGE prompt pinning "SCORE <n>/10 <PASS|FAIL> <reason>">, signal })` (the `signal` field is
    **required** on `CompletionRequest`, `types.ts:257` — pass `ctx.signal`; the `if (!p)` guard handles
    `providers.get()`'s `Provider | undefined`, C1), collect the `done.message` text, **import only
    `parseJudgeReply`** from `./evals.js` (`evals.ts:181`; `JUDGE_SYSTEM_PROMPT` is module-private, so the
    local prompt) → use `.score`; a malformed/absent reply → `0` (fail-soft, never throws).
- **Task list (TDD order):**
  1. **(test)** `test/reasoning-search.test.ts` — **best-of-N forks + selects** (AC-3): enable the
     extension; MockProvider scripts N distinct child outputs; `best_of_n({ task, n: 3, scorer: "longest"
     })` returns the **longest** candidate's text (deterministic); assert `details` has 3 per-candidate
     scores. (Use the deterministic `longest`/`shortest` scorers — not `judge` — for determinism.)
  2. **(test)** **governed children** (AC-4): register a parent `beforeToolCall` guard that blocks a tool;
     a child attempting that tool has it blocked (childScope governance carries to the forked branch).
  3. **(test)** **bounded + recursion guard + usage** (AC-5): `n` above the cap (default 5) is clamped
     (assert ≤ cap children ran); a child's `childRegistry()` does **not** contain `best_of_n` (assert it
     can't re-fork); a `usage`-event observer on the **parent** bus receives the children's `usage` events
     (NOT `e.agent.usage`).
  4. **(test)** **parent transcript unmutated** (AC-6): after `best_of_n`, `e.agent.messages` has only the
     user/assistant/tool-result for the `best_of_n` call — not the losing branches' internal turns.
  5. **(test)** **off-by-default inert** (AC-8): loaded-but-not-enabled → `best_of_n` inert/unavailable.
  5b. **(test)** **judge fail-soft** (AC-7): with the `judge` scorer and a MockProvider whose `done` message
     is a **non-`SCORE`** reply (or empty), assert `best_of_n` does **not** throw and falls back to
     candidate 0 (the all-zero-scores → argmax-0 path). Pins the documented fail-soft invariant (R3).
  6. **(impl)** `src/extensions/reasoning-search.ts`: default-export `activate(e)`;
     `EAGENT_REASONING_SEARCH === "off"` → no-op. Config: `enabled` (store, default false), `maxN`
     (default 5). Implement `childRegistry`/`forkChild`/scorers (above). Register a `best_of_n` tool
     (`capabilities: ["agent:spawn"]`, params `{task, n?, scorer?}`): guard `enabled`; `const snap =
     e.agent.snapshot();` `const k = Math.min(n ?? 3, maxN);` `const children = Array.from({length:k}, ()
     => forkChild(snap));` `const outcomes = await Promise.all(children.map(async c => finalText(await
     c.run(task))));` — `finalText` extracts the last assistant text from the `RunResult`/child `messages`
     (the `subagents.ts` `finalText` pattern; do NOT import the `test/helpers.ts` `lastText` into `src/`).
     Score each (`await Promise.all(outcomes.map(scorer))`) → argmax → `{ content: best, details:
     outcomes.map((text,i) => ({ text, score })) }`.
     `e.grantCapability("agent:spawn")` (mirror subagents) or rely on host policy. Register a
     `/reasoning-search [on|off|status]` command. Return a teardown.
  7. **(impl)** `src/host.ts`: `import reasoningSearch from "./extensions/reasoning-search.js";` and append
     `["reasoning-search", reasoningSearch]` to `BUILTIN_EXTENSIONS`.
  8. **(verify)** `node --import tsx --test "test/reasoning-search.test.ts" "test/host.test.ts"`;
     `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/reasoning-search.test.ts" "test/host.test.ts"`;
  `npm run typecheck`.
- **Exit:** AC-3..AC-8 pass (incl. AC-7 judge fail-soft); off-by-default inert; host canonical-set green;
  `npm test` green; typecheck 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" + "Adding an extension" — ESM NodeNext `.js`
  specifiers; strict TS (`noUncheckedIndexedAccess` — guard `outcomes[i]`, `.list()` access); zero deps
  but jiti; offline tests (MockProvider + deterministic `longest`/`shortest`); `EAGENT_REASONING_SEARCH=off`
  kill switch; declares `agent:spawn`; append to `BUILTIN_EXTENSIONS`; **no kernel change** (composes
  `Agent` constructor + `childScope` + `snapshot`/`restore` — all public). Study `subagents.ts` for the
  child-construction + `buildChildRegistry` precedent.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` (function responder) to script N distinct child outputs deterministically + a parent turn
that calls `best_of_n`. Reuse `makeHarness`/`lastText` from `test/helpers.ts`. The deterministic
`longest`/`shortest` scorers keep AC-3 offline + deterministic (no judge). A parent `beforeToolCall` guard
+ a `usage`-event observer for AC-4/AC-5. Offline; no new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. Off-by-default keeps the extension inert in the shipped
  config — existing suites (incl. `subagents`) unaffected — the core net.
- The canonical-set host test covers the registration (+1 extension; no dup tool/command names).
- No kernel change → `kernel-surface.test.ts` unaffected (2187). `subagents` is untouched (reasoning-search
  reuses its *pattern*, not its code).

## L2 Review Log

- **Round 1** — **zero severe** + 1 general (the AC-7 judge fail-soft test was dropped from the task list)
  + clarifications (judge stream needs `signal` + provider-undefined guard; an editing artifact; scorer
  async-uniformity). All folded (test 5b added; signal+guard; clean import; `Promise.all` scoring).
- **Round 2 (confirming)** — **zero severe, zero general** (one immaterial `lastText`-in-src note, fixed →
  `finalText` per subagents). Two-generation satisfied. **L2 closed.**
