# Implementation — First-class forkable state (snapshot / restore / step ids)

**Slug:** `2026-06-28-forkable-state` (matches design) · **Design:**
[`design/2026-06-28-forkable-state.md`](../design/2026-06-28-forkable-state.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Run from repo root.
Single-file accept: `node --import tsx --test "<file>"`.

## 1. Task Index (design ↔ deliverable map)

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1 snapshot + D2 restore + D3 #step + D4 frozen handle.messages | design §2 D1-D4, KDD-1/3/4/6, AC-3..AC-7, AC-9 |
| 2 | D5 server per-session isolation | design §2 D5, KDD-5, AC-8 |

Two Phases: Phase 1 lands the kernel primitive (snapshot/restore/#step/frozen handle, `AgentState` type)
with unit tests — additive, no existing behavior changes. Phase 2 rewires the HTTP server to store
`AgentState` per session (the named consumer). Each is independently committable; `npm test` green at each.

## 2. Phase Breakdown

### Phase 1 — Kernel: `AgentState`, snapshot/restore, `#step`, frozen handle

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-3 merged). Baseline `npm test` green.
- **Design refs:** §2 D1-D4, KDD-1 (state shape), KDD-3 (#step reset + emit ordering), KDD-4 (shallow
  freeze), KDD-6 (restore-while-running throws); AC-3..AC-7, AC-9.
- **Files:** `src/kernel/types.ts` (the `AgentState` type), `src/kernel/agent.ts` (snapshot/restore/#step/
  frozen handle/clear-resets-step), `src/kernel/events.ts` (additive `step` on turn_end/tool_end/
  tool_batch_end payloads), `src/kernel/index.ts` (export the `AgentState` type), `test/agent.test.ts`.
- **Task list (TDD order):**
  1. **(test)** `test/agent.test.ts` — **snapshot is a deep copy** (AC-3): run a turn; `const s =
     agent.snapshot()`; mutate `s.messages.push(...)` and `s.usage.inputTokens = 9999`; assert
     `agent.messages.length` and `agent.usage.inputTokens` are unchanged.
  2. **(test)** `test/agent.test.ts` — **restore round-trips** (AC-4): run a turn; `s = snapshot()`;
     run more / set `agent.model = "x"`; `agent.restore(s)`; assert `agent.messages`, `agent.usage`,
     `agent.model`, `systemPrompt`, `thinking`, and the restored `step` equal the snapshot.
  3. **(test)** `test/agent.test.ts` — **restore-while-running throws** (AC-5). NOTE: `ctx.agent` is the
     limited `AgentHandle` (no `restore`), so a tool cannot call `restore`. Instead, register a
     `beforeToolCall` (or `turn_start`) handler whose closure captures the **test-created `Agent`** (which
     has `restore`), and inside it do `try { agent.restore(snap) } catch { threw = true }` — the assert
     must be **hoisted out** of the handler: an observer throw is swallowed (`hooks.ts:92-99`) and a
     `beforeToolCall` throw becomes an error result (`agent.ts:371-375`), so a bare `assert.throws` inside
     the handler is false-green. After `await agent.run(...)`, `assert.ok(threw)`. Pin: `restore()` rejects
     when `this.#running`.
  4. **(test)** `test/agent.test.ts` — **frozen handle.messages** (AC-6): a tool reads `ctx.agent.messages`;
     assert `Object.isFrozen(it)` is true, it is a distinct array from `agent.messages` internal, and a
     `push` to it throws (strict mode) / does not change the agent's transcript length.
  5. **(test)** `test/agent.test.ts` — **#step** (AC-7): a fresh agent has step 0 (via `snapshot().step`);
     register a `turn_end` observer recording payload `step`; run a 2-turn scenario; assert step increments
     by 1 per turn and `turn_end` carries the post-increment value; a `tool_end` observer sees the
     call-time step. After `clear()`, `snapshot().step` is 0 again.
  6. **(impl)** `src/kernel/types.ts`: add `export interface AgentState { messages: Message[]; usage: Usage;
     model: string; providerName: string | undefined; systemPrompt: string; thinking: ThinkingLevel;
     step: number }`.
  7. **(impl)** `src/kernel/events.ts`: add `step: number` to the `turn_end`, `tool_end`, and
     `tool_batch_end` event payloads.
  8. **(impl)** `src/kernel/agent.ts`: add `#step = 0`; `snapshot(): AgentState` = `{ messages:
     structuredClone(this.#messages), usage: structuredClone(this.#usage), model, providerName,
     systemPrompt, thinking, step: this.#step }` (raw structuredClone — fail-loud, NOT structuredCloneSafe);
     `restore(state)`: `if (this.#running) throw …`; then `this.#messages.length = 0;
     this.#messages.push(...structuredClone(state.messages))` (**in-place** — `#messages` is `readonly`,
     cannot be reassigned, agent.ts:98), `this.#usage = structuredClone(state.usage)` (not readonly),
     assign the primitives (`model`/`providerName`/`systemPrompt`/`thinking`), and `this.#step = state.step`.
     In `clear()` also set `this.#step = 0`. Increment `this.#step` **once per turn** before the `turn_end`
     emit (there are **three** mutually-exclusive `turn_end` emit sites — agent.ts:213 followup, :217
     no-tools end, :241 post-dispatch — add `step: this.#step` to **all three**), and add `step: this.#step`
     (call-time value) to the `tool_end`/`tool_batch_end` payloads. Make `get handle()` return
     `messages: Object.freeze(this.#messages.slice())` (public `get messages()` stays as-is). Import `AgentState`.
  9. **(impl)** `src/kernel/index.ts`: **no edit needed** — `index.ts` already does `export * from
     "./types.js"` (index.ts:10), so adding `AgentState` to `types.ts` (task 6) re-exports it as a type
     automatically. (Do NOT write `export type { AgentState }` with no `from` clause — it references a
     non-existent local binding and fails to compile.) Type-only → not in `Object.keys(kernel)` → no
     `kernel-surface` `EXPECTED_EXPORTS` change.
- **Per-task accept commands:**
  - `node --import tsx --test "test/agent.test.ts"`
  - `node --import tsx --test "test/kernel-surface.test.ts"`
  - `npm run typecheck`
- **Exit condition:** new snapshot/restore/step/handle tests pass; `kernel-surface` green (`< 2,200`
  lines; export list unchanged); `npm test` green.

### Phase 2 — Server per-session isolation (named consumer)

- **Entry condition:** Phase 1 merged; `npm test` green.
- **Design refs:** §2 D5, KDD-5; AC-8.
- **Files:** `src/server.ts`, `test/server.test.ts`.
- **Task list (TDD order):**
  1. **(test)** `test/server.test.ts` — **per-session usage isolation** (AC-8): start a server slice
     (`createHttpServer`, MockProvider with non-zero usage); run a turn in session A, then a turn in
     session B; assert B's `done.usage` reflects only B's tokens (not A+B); assert a model change applied
     during A's turn does not affect B's turn; assert a brand-new session starts from the initial snapshot
     (empty transcript, zero usage).
  2. **(impl)** `src/server.ts`: capture `const initial = built.agent.snapshot()` after the host build
     (after `createAgentHost` + `session_start`, ~line 108-109); change **all three** `Map<string,
     Message[]>` annotations to `Map<string, AgentState>` (the declaration at server.ts:127 and the
     `sessions` param annotations on `route` ~:166 and `streamRun` ~:271); **thread `initial`** from
     `createHttpServer` down through `route`→`streamRun` as an added `initial: AgentState` param alongside
     `sessions` (both are module-scope functions threaded this way today — `elicit`/`askTimeoutMs` are the
     pattern to mirror; lexical closure is not available there). In `streamRun`, replace `agent.clear()` +
     `agent.load(history)` (~:325-329) with `agent.restore(sessions.get(session) ?? initial)` (sessionless
     `/run` restores `initial`); after `agent.run(input)`, `if (session) sessions.set(session,
     agent.snapshot())`; change the `done` line's `usage` (~:343) to the session's usage (`agent.usage`
     after the turn now equals the session's cumulative because we restored the session's usage). Keep the
     single-flight lock + elicitation logic unchanged. DELETE /sessions still deletes by key. Import
     `AgentState` (type) from `./kernel/agent.js` or `./kernel/types.js`.
  3. **(verify)** `node --import tsx --test "test/server.test.ts"` — existing server tests (health, run,
     answer, delete, 409 busy, disconnect-abort) stay green; update any test asserting lifetime-cumulative
     `done.usage` to the new per-session semantics.
- **Per-task accept commands:**
  - `node --import tsx --test "test/server.test.ts"`
  - `npm run typecheck`
- **Exit condition:** per-session usage/model isolation verified; existing server tests green; `npm test`
  green.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` specifiers; strict TS
  (`noUncheckedIndexedAccess`); zero deps but jiti; offline tests via `node:test`/`tsx`. `types.ts` and
  `agent.ts` are kernel (load-bearing); the CLAUDE.md/README Agent-loop + types descriptions gain
  `snapshot`/`restore`/`AgentState` — reconciled at F.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phaseN):`; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI attribution.

## 4. Data and Fixture Dependencies

Reuse `MockProvider` (its `done` event reports `usage`) for snapshot/restore/step tests and the server
per-session test. The server test uses `createHttpServer` against the mock (offline). No new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at the end of every Phase.
- Phase 1 is additive (no existing run uses snapshot/restore); the `step` event-payload fields are additive
  and Wave-3 `childScope` forwards them harmlessly. `test/kernel-surface.test.ts` green (no export change;
  `< 2,200` lines).
- Phase 2: the existing `test/server.test.ts` suite is the regression net (health/run/answer/delete/409/
  disconnect); only `done.usage` semantics change (lifetime → per-session) — update those assertions
  (verified: no existing server test asserts a cumulative `done.usage` value, so this is a no-op in practice).

## L2 Review Log

- **Round 1** — zero severe + 2 general (restore-while-running test: `ctx.agent` is the handle, no
  `restore` → capture the test Agent + hoist the assert out of the swallowing handler; `index.ts` task-9
  no-edit via `export *`) + clarifications (three turn_end sites; in-place `#messages`; Phase 2 Map
  annotations + thread `initial`). Applied.
- **Round 2** — zero severe + 1 general (cosmetic: "close over it" alternative infeasible — module-scope
  functions). Fixed to param-threading only.
- **Round 3** — **zero severe, zero general** (baseline re-run 39/39, typecheck clean).
- **Round 4 (corroborating)** — **zero severe, zero general.** Cap-convergence
  ([[three-loop-cap-convergence-policy]]) — two-generation satisfied. **L2 closed.**
