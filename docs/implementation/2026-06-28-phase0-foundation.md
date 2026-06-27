# Implementation — Phase 0 Foundation Pack

**Slug:** `2026-06-28-phase0-foundation` (matches design doc) · **Design:**
[`design/2026-06-28-phase0-foundation.md`](../design/2026-06-28-phase0-foundation.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. All commands run from repo root.
Single-file accept: `node --import tsx --test "<file>"`; name-scoped:
`node --import tsx --test --test-name-pattern="<regex>" "<file>"`.

## 1. Task Index (design ↔ deliverable map)

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | P0.1 CI gate + strict host | design §2 P0.1, §4 (P0.1 in Deliverables), AC-3 |
| 2 | P0.4 validator hardening + single-gate re-validate | design KDD-5, KDD-6; AC-6, AC-7 |
| 3 | P0.5 bounded concurrency mechanism | design KDD-7; AC-8 |
| 4 | P0.2 Usage widening + provider mappings + pricing | design KDD-1/2/3, §5; AC-4, AC-5, AC-11, AC-13 |
| 5 | P0.3 guard `mcp:call` egress/leak fix | design KDD-4; AC-9, AC-12 |

Order rationale: the CI gate lands first so every later Phase is protected; the two `agent.ts`-touching
Phases (validator/re-validate, concurrency) come next; the broad Usage change then the localized guard
fix. `npm test` is green at the end of every Phase.

## 2. Phase Breakdown

### Phase 1 — P0.1 `BUILTIN_EXTENSIONS` CI gate + strict host

- **Entry condition:** none (first Phase). Baseline `npm test` green.
- **Design refs:** `design/2026-06-28-phase0-foundation.md` §1, §2 (P0.1), §7 AC-3.
- **Files:** `src/host.ts`, `test/host.test.ts`.
- **Task list (TDD order):**
  1. **(test)** In `test/host.test.ts`, add a test "loads the full canonical extension set with no
     failures or duplicate names": `const { agent, host, commands, failures } = await createAgentHost({
     provider: "mock", discoverDirs: [] })` — **`discoverDirs: []` is required** for a deterministic
     count (mirrors the existing cases at `test/host.test.ts:71,128`; without it `host.discover()` reads
     `~/.eagent/extensions` and `./.eagent/extensions` and the count becomes env-dependent). Import
     `BUILTIN_EXTENSIONS` from `src/host.ts`; assert `host.list().length === BUILTIN_EXTENSIONS.length`;
     assert `failures` (the new field on the returned object) is empty; build
     `agent.tools.list().map(t=>t.spec.name)` and `commands.list().map(c=>c.name)` and assert each array
     has no duplicate (Set size === length).
     *Invariant protected:* a refactor that silently drops/breaks any built-in, or introduces a
     same-namespace name collision, fails CI (today only `core-tools`/`web` presence is checked).
  2. **(impl)** In `src/host.ts`, change the activation loop (`host.ts:236-242`) to collect
     `{ id, err }` on failure into a local `failures: { id: string; err: unknown }[]`, keep the
     log-and-skip behavior (do **not** throw — runtime resilience preserved), add `failures` to the
     `AgentHost` interface and to the returned object. Do not change discovery of user/project dirs.
  3. **(impl)** Ensure `BUILTIN_EXTENSIONS` and the `AgentHost` type are exported (they already are);
     no new kernel symbol.
- **Per-task accept commands:**
  - Test present & passing: `node --import tsx --test --test-name-pattern="canonical extension set" "test/host.test.ts"`
  - File green: `node --import tsx --test "test/host.test.ts"`
  - Typecheck: `npm run typecheck`
- **Exit condition:** the new test passes; `host.failures` exists on `AgentHost`; `npm test` green.

### Phase 2 — P0.4 validator hardening + single-gate re-validate

- **Entry condition:** Phase 1 merged; `npm test` green.
- **Design refs:** KDD-5 (validator boundary), KDD-6 (re-validate ordering + unified message), AC-6, AC-7.
- **Files:** `src/kernel/validate.ts`, `src/kernel/agent.ts`, `test/validate.test.ts`, `test/agent.test.ts`.
- **Task list (TDD order):**
  1. **(test)** `test/validate.test.ts`: add cases — (a) `{type:"object", properties:{a:{type:"string"}},
     additionalProperties:false}` rejects an input with an extra key `b`, while the same schema **without**
     `additionalProperties` preserves `b` (current behavior unchanged); (b) `{type:"number", maximum:10}`
     rejects `11`, accepts `9`; `{type:"number", minimum:0}` rejects `-1`; (c) `{type:"string", minLength:2}`
     rejects `"a"`; `{type:"string", maxLength:3}` rejects `"abcd"`; `{type:"string", pattern:"^x"}` rejects
     `"yz"`, accepts `"xy"`; (d) `{type:"integer", enum:[1,2,3]}` with input `"2"` returns `ok:true` and
     value `2`. *Invariant:* declared constraints are enforced; undeclared ones stay permissive; numeric
     enums coerce before comparison.
  2. **(test)** `test/agent.test.ts`: add "guard repairs invalid args" — register a tool whose schema
     requires `n:number`; call it with `n:"oops"` (invalid); register a `beforeToolCall` filter that
     rewrites `arguments.n = 7`; assert the tool **executes** with `n===7` (not an invalid-args error).
     Add "invalid args with no repairing guard still error before capability prompt" — a capability-gated
     tool called with invalid args returns an `Invalid arguments` error and the capability UI is **not**
     consulted.
  3. **(impl)** `src/kernel/validate.ts`: move the `enum` membership check to **after** type coercion (so
     a coerced numeric/boolean is compared); add, **only when present on the schema**, `maximum`/`minimum`
     (number/integer), `minLength`/`maxLength`/`pattern` (string), and in `walkObject` reject keys not in
     `properties` when `additionalProperties === false` (otherwise keep preserving them).
  4. **(impl)** `src/kernel/agent.ts` `executeGuarded`: remove the early `if (!ok) return` (`agent.ts:359`);
     run the post-guard `validate(decided.arguments)` **before** the capability `require` loop; on failure
     return the unified message `Invalid arguments for ${name}:\n- ${errs.join("\n- ")}` (drop the
     "(after guards)" variant). Capability checks and execute run only on valid args.
- **Per-task accept commands:**
  - `node --import tsx --test "test/validate.test.ts"`
  - `node --import tsx --test --test-name-pattern="guard repairs invalid args|invalid args" "test/agent.test.ts"`
  - `node --import tsx --test "test/agent.test.ts"`
  - `npm run typecheck`
- **Exit condition:** new validate/agent tests pass; `npm test` green (existing invalid-args assertions
  still hold — unified message equals the prior early-reject text for the no-repair path).

### Phase 3 — P0.5 bounded concurrency mechanism

- **Entry condition:** Phase 2 merged; `npm test` green.
- **Design refs:** KDD-7, AC-8, R5.
- **Files:** `src/kernel/agent.ts`, `test/agent.test.ts`.
- **Task list (TDD order):**
  1. **(test)** `test/agent.test.ts` "maxConcurrency serializes a wave": register 3 `parallel` tools that,
     on execute, increment a shared `inFlight` counter (record max observed) then await a per-call
     released barrier; set `agent.maxConcurrency = 1`; drive a turn whose assistant message calls all 3;
     assert observed max in-flight === 1 and results are in requested order. Add a default-case assertion:
     with `maxConcurrency` unset and the same barrier, max in-flight === 3 (fast-path == `Promise.all`).
     *Invariant:* a finite cap bounds wave concurrency; unset preserves full parallelism + order.
  2. **(impl)** `src/kernel/agent.ts`: add `maxConcurrency?: number` to `AgentOptions` and a public mutable
     `maxConcurrency: number` field (default `Infinity`, set in constructor). In `dispatch`, keep the
     existing `Promise.all(calls.map(runOne))` fast-path when not `sequential` **and**
     `maxConcurrency === Infinity`; otherwise run an index-keyed bounded worker pool that fills results by
     original index (preserving requested order). The `sequential` path is unchanged.
- **Per-task accept commands:**
  - `node --import tsx --test --test-name-pattern="maxConcurrency" "test/agent.test.ts"`
  - `node --import tsx --test "test/agent.test.ts"`
  - `npm run typecheck`
- **Exit condition:** concurrency tests pass; `npm test` green; `kernel-surface.test.ts` still green
  (line ceiling < 2200).

### Phase 4 — P0.2 Usage widening + provider mappings + pricing

- **Entry condition:** Phase 3 merged; `npm test` green.
- **Design refs:** KDD-1, KDD-2, KDD-3, §5; AC-4, AC-5, AC-11, AC-13.
- **Files:** `src/kernel/types.ts`, `src/providers/anthropic.ts`, `src/providers/openai.ts`,
  `src/providers/gemini.ts`, `src/extensions/cost.ts`, `src/extensions/budget-cap.ts`,
  `test/anthropic.test.ts`, `test/openai.test.ts`, `test/gemini.test.ts`, `test/cost.test.ts`,
  `test/budget-cap.test.ts`, and a new `test/usage.test.ts` for the `addUsage`/`totalTokens` unit tasks.
- **Task list (TDD order):**
  1. **(test)** Usage arithmetic (AC-13, AC-4): `addUsage({inputTokens:1,outputTokens:2},
     {inputTokens:3,outputTokens:4})` deep-equals `{inputTokens:4,outputTokens:6}` (no extra keys);
     `addUsage` of two cache/reasoning-bearing usages sums each optional field; `totalTokens` =
     input+cacheRead+cacheWrite+output; assert `reasoningTokens <= outputTokens` for a constructed value.
  2. **(test)** Provider parsing (AC-11): feed each provider a representative usage payload and assert the
     mapped `Usage`: Anthropic `{input_tokens:10, cache_read_input_tokens:90, cache_creation_input_tokens:5,
     output_tokens:7}` → `{inputTokens:10, cacheReadTokens:90, cacheWriteTokens:5, outputTokens:7}`;
     OpenAI `{prompt_tokens:100, prompt_tokens_details:{cached_tokens:40},
     completion_tokens:20, completion_tokens_details:{reasoning_tokens:8}}` →
     `{inputTokens:60, cacheReadTokens:40, outputTokens:20, reasoningTokens:8}`; Gemini
     `{promptTokenCount:100, cachedContentTokenCount:30, candidatesTokenCount:20, thoughtsTokenCount:6}` →
     `{inputTokens:70, cacheReadTokens:30, outputTokens:26, reasoningTokens:6}`. Existing 2-field deepEqual
     assertions (`test/anthropic.test.ts:69`, `test/openai.test.ts:60`, `test/gemini.test.ts:52`) must
     remain valid for payloads without cache/reasoning (omit-invariant).
  3. **(test)** Cost (AC-5): in `test/cost.test.ts`, a turn with N tokens as `cacheReadTokens` costs
     strictly less than the same N as `inputTokens` (cache-read priced at the reduced multiplier).
  4. **(impl)** `src/kernel/types.ts`: add optional `cacheReadTokens?`, `cacheWriteTokens?`,
     `reasoningTokens?` to `Usage`; update `addUsage` to sum each field **only when present in either
     operand** (omit otherwise); `totalTokens` adds cacheRead+cacheWrite (not reasoning).
  5. **(impl)** Providers: Anthropic — stop folding (`anthropic.ts:153-154`): `inputTokens = input_tokens`,
     set `cacheReadTokens`/`cacheWriteTokens` only when the wire reports them. OpenAI —
     `inputTokens = Math.max(0, prompt_tokens - cached)`, `cacheReadTokens = cached` (when present),
     `reasoningTokens = completion_tokens_details.reasoning_tokens` (when present). Gemini —
     `inputTokens = Math.max(0, promptTokenCount - cachedContentTokenCount)`,
     `cacheReadTokens = cachedContentTokenCount`, `outputTokens = candidatesTokenCount + thoughtsTokenCount`,
     `reasoningTokens = thoughtsTokenCount` (each optional field set only when its wire field is present).
  6. **(impl)** `src/extensions/cost.ts`: price `cacheReadTokens` at `inputPerMTok * 0.1` and
     `cacheWriteTokens` at `inputPerMTok * 1.25` (constants, documented as Anthropic-standard
     approximations), added to the existing input/output terms; aggregate the new fields per provider.
  7. **(impl/verify)** `src/extensions/budget-cap.ts`: it **already** budgets on the USD cost via
     `costOf(p.usage, row)` / `costOf(p.cumulative, row)` (`budget-cap.ts:260-261`), not raw
     `inputTokens` — so once task 6 makes `costOf` (`cost.ts:106-108`) cache-aware, budget-cap inherits
     correct cached-turn spend with **zero or trivial** change. The task is to **verify** this (a test or
     a read-through), **not** to substitute a token-count budget (caps are USD, not tokens).
- **Per-task accept commands:**
  - `node --import tsx --test "test/usage.test.ts"`
  - `node --import tsx --test "test/anthropic.test.ts" "test/openai.test.ts" "test/gemini.test.ts"`
  - `node --import tsx --test "test/cost.test.ts" "test/budget-cap.test.ts"`
  - `npm run typecheck`
- **Exit condition:** new Usage/provider/cost tests pass; the three existing provider deepEqual
  assertions still pass (omit-invariant holds); `npm test` green.

### Phase 5 — P0.3 guard `mcp:call` egress/leak fix

- **Entry condition:** Phase 4 merged; `npm test` green.
- **Design refs:** KDD-4, AC-9, AC-12.
- **Files:** `src/extensions/flow-guard.ts`, `src/extensions/secret-guard.ts`,
  `test/flow-guard.test.ts`, `test/secret-guard.test.ts` (and `test/security/*` if they assert sets).
- **Task list (TDD order):**
  1. **(test)** `test/flow-guard.test.ts`: (AC-9) a tool declaring `mcp:call` is treated as egress — after
     a taint, an `mcp:call` egress call is gated; (AC-12) a `shell:exec` tool call (tainting) followed by a
     **second** `shell:exec` call is **not** gated (shell stays source-only, never egress).
  2. **(test)** `test/secret-guard.test.ts`: a tool declaring `mcp:call` is in the leak set — a secret in
     context + a later `mcp:call` tool triggers the guard.
  3. **(impl)** `src/extensions/flow-guard.ts`: `DEFAULT_EGRESS_CAPS = ["net:fetch", "mcp:call"]`
     (`shell:exec` stays only in `DEFAULT_SOURCE_CAPS`). `src/extensions/secret-guard.ts`:
     `DEFAULT_LEAK_CAPS = ["net:fetch", "shell:exec", "mcp:call"]`. No shared constant; each in place.
- **Per-task accept commands:**
  - `node --import tsx --test "test/flow-guard.test.ts" "test/secret-guard.test.ts"`
  - `node --import tsx --test "test/security/flow-guard.test.ts" "test/security/secret-guard.test.ts"`
  - `npm run typecheck`
- **Exit condition:** guard tests pass (incl. AC-12 regression); `npm test` green.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" (ESM + NodeNext: `.js` import specifiers even for
  `.ts`; strict TS — `noUncheckedIndexedAccess` etc.; zero runtime deps but jiti; capabilities are the
  security vocabulary; tests via `node:test` run by `tsx`, must run offline). CLAUDE.md "Adding an
  extension" for any extension touched.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phaseN):`/`fix(phaseN):` opener,
  `fix(phaseN-roundR): <keyword>` within-round; `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; no AI
  attribution (also enforced by CLAUDE.md "No Claude Code artifacts").

## 4. Data and Fixture Dependencies

- Reuse `MockProvider` (`src/providers/mock.ts`) for agent/dispatch tests; it carries `{text, reasoning,
  toolCalls}` per `MockTurn` and emits 2-field Usage — no cache/reasoning, which is exactly what pins the
  omit-invariant. Provider parsing tests construct wire-shaped usage payloads directly (no network), as the
  existing provider tests already do. No new external fixtures required.

## L2 Review Log

- **Round 1** — zero severe (pass) + 2 general (Phase-1 `discoverDirs:[]` determinism; Phase-4 task-7
  budget-cap reframe) + 3 clarifications. All addressed.
- **Round 2** — **zero severe, zero general** (2 non-blocking clarifications). 
- **Round 3 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**

## 5. Regression Protection

- `npm test` (full suite) green at the end of every Phase — the non-negotiable gate.
- `test/kernel-surface.test.ts` (public export pins + `< 2200` line ceiling) green after Phases 2, 3, 4
  (the kernel-touching Phases).
- The three provider `deepEqual` Usage assertions (`test/anthropic.test.ts:69`, `test/openai.test.ts:60`,
  `test/gemini.test.ts:52`) green after Phase 4 (omit-invariant).
- Existing `test/flow-guard.test.ts` / `test/secret-guard.test.ts` / `test/security/*` green after Phase 5.
- Existing invalid-args / capability tests green after Phase 2 (unified error text matches prior).

**Known out-of-scope ripple (acknowledged, not fixed in Wave 1):** the `inputTokens` redefinition (KDD-2)
means consumers that sum `inputTokens + outputTokens` for their own purposes — `limits.ts:207` and any
`trace.ts` token display — will, on a *cached* run, no longer include cache tokens in that sum. The
design's committed cache-aware scope (P0.2) is `cost.ts` + `budget-cap.ts` only; no existing test
exercises a cached run, so nothing breaks. Making `limits`/`trace` cache-aware is a deferred follow-up,
deliberately left out of Wave 1 (Surgical Changes).
