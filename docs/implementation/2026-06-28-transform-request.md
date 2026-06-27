# Implementation — `transformRequest` keystone seam

```
Status: closed
Closing-commit: 53ad0b2
Closed-on: 2026-06-28
Deferred: none
```

**Slug:** `2026-06-28-transform-request` (matches design) · **Design:**
[`design/2026-06-28-transform-request.md`](../design/2026-06-28-transform-request.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Run from repo root.
Single-file accept: `node --import tsx --test "<file>"`; name-scoped:
`node --import tsx --test --test-name-pattern="<regex>" "<file>"`.

## 1. Task Index (design ↔ deliverable map)

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1 filter point + D2 streamTurn apply + D3 ordering + D4 tests | design §2 (D1-D4), KDD-1..6, AC-1..AC-7 |

One Phase: the change is a single coherent seam addition (one filter-map key + one `apply` call + tests).
It is independently committable and leaves `npm test` green.

## 2. Phase Breakdown

### Phase 1 — Add the `transformRequest` filter point and apply it in `streamTurn`

- **Entry condition:** on branch off the latest `feat/redesign-superpowers` (Wave 1 merged). Baseline
  `npm test` green.
- **Design refs:** design §2 D1-D4; KDD-1 (value shape excl. `signal`), KDD-2 (keep `transformContext`,
  ordered first), KDD-3 (context `{turn, cumulativeUsage}`), KDD-4 (advisory tools), KDD-5 (throw fatal),
  KDD-6 (trusted toolChoice); AC-1..AC-7.
- **Files:** `src/kernel/events.ts`, `src/kernel/agent.ts`, `test/agent.test.ts` (and
  `test/kernel-surface.test.ts` only if the line count or export pin needs an intentional update).
- **Task list (TDD order):** *(Name the new tests so the name-scoped accept regex below matches —
  include the literal substrings `byte-identity`, `transformRequest`, `transformContext before
  transformRequest`, and `cumulativeUsage` in the respective `test("…")` titles.)*
  1. **(test)** `test/agent.test.ts` — **default byte-identity** (AC-4): build an agent with a
     `MockProvider` whose **function responder** `(req) => { captured = req; return {text:"ok"} }`
     captures the `CompletionRequest`; with NO `transformRequest` handler registered, run one turn and
     assert `captured.systemPrompt`, `captured.model`, `captured.tools` (names), `captured.toolChoice`,
     `captured.thinking`, and `captured.messages` equal what the pre-change build would send (the agent's
     systemPrompt/model, the registry tool specs, undefined toolChoice, the configured thinking, the
     transcript). *Invariant:* adding the seam does not perturb the request when unused.
  2. **(test)** `test/agent.test.ts` — **shaping** (AC-3): register a `transformRequest` handler that
     returns a value with `model:"shaped-model"`, `tools` filtered to drop one tool, `systemPrompt`
     appended, `toolChoice:{type:"tool",name:<a registered tool>}`, `thinking:"high"`, and an extra
     message appended to `messages`; run a turn with a capturing responder; assert every one of those
     changes is present in the captured request. *Invariant:* each shapeable field is mutable via the hook
     and reaches the provider.
  3. **(test)** `test/agent.test.ts` — **ordering** (AC-5): register a `transformContext` handler that
     appends message M1 and a `transformRequest` handler that records `value.messages`; assert the
     `transformRequest` handler observed M1 (context ran first). *Invariant:* `transformContext` output
     flows into `transformRequest.messages`.
  4. **(test)** `test/agent.test.ts` — **cumulativeUsage** (AC-6): run two turns (the mock reports
     non-zero usage on turn 1); a `transformRequest` handler on turn 2 records `context.cumulativeUsage`;
     assert it is non-zero and equals the agent's accumulated `usage` after turn 1. *Invariant:* the hook
     sees real running usage for budget-aware shaping.
  5. **(impl)** `src/kernel/events.ts`: import `ToolSpec`, `ToolChoice`, `ThinkingLevel` (already imports
     `Message`, `Usage`) from `./types.js`; add to `KernelFilters`:
     ```
     transformRequest: {
       value: { systemPrompt: string; messages: Message[]; tools: ToolSpec[]; model: string;
                toolChoice?: ToolChoice; thinking?: ThinkingLevel };
       context: { turn: number; cumulativeUsage: Usage };
     };
     ```
  6. **(impl)** `src/kernel/agent.ts` `streamTurn`: after building `req` (the object at ~281-297), apply
     the filter to the shapeable subset and stream the shaped request with the live signal re-attached:
     ```
     const shaped = await this.hooks.apply(
       "transformRequest",
       { systemPrompt: req.systemPrompt, messages: req.messages, tools: req.tools,
         model: req.model, toolChoice: req.toolChoice, thinking: req.thinking },
       { turn, cumulativeUsage: { ...this.#usage } },
     );
     const finalReq = { ...shaped, signal: this.#abort!.signal };
     ```
     then change the stream consumer (`agent.ts:302`) from `provider.stream(req)` to
     `provider.stream(finalReq)`. Pass `cumulativeUsage` as a **defensive copy** (`{ ...this.#usage }`),
     matching the existing convention (`transformContext` over `[...this.#messages]`, `usage` emit over
     `{ ...this.#usage }`) so a handler cannot mutate the kernel's running total. `transformContext` stays
     where it is (applied to messages before `req` is built), so its output is already in `req.messages`
     and flows into the filter value. Keep the existing `forceTool`→`toolChoice` logic that built
     `req.toolChoice` (the hook may override it).
  7. **(verify)** Run `node --import tsx --test "test/kernel-surface.test.ts"`; the `KernelFilters` key is
     type-only (no runtime export change). If the kernel line count crosses 2200 (it will not — ~1914 +
     ~10) or the export pin legitimately changes, update the pin with a one-line justification.
- **Per-task accept commands:**
  - `node --import tsx --test --test-name-pattern="transformRequest|byte-identity|cumulativeUsage|transformContext before" "test/agent.test.ts"`
  - `node --import tsx --test "test/agent.test.ts"`
  - `node --import tsx --test "test/kernel-surface.test.ts"`
  - `npm run typecheck`
- **Exit condition:** AC-3..AC-6 tests pass; default byte-identity holds; `kernel-surface` green;
  `npm test` green; `npm run typecheck` exits 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM NodeNext `.js` import specifiers (import
  `ToolSpec`/`ToolChoice`/`ThinkingLevel` from `"./types.js"`); strict TS (`noUncheckedIndexedAccess`);
  zero runtime deps but jiti; offline tests via `node:test`/`tsx`. CLAUDE.md kernel-primitive section is a
  load-bearing doc — its "three filter hooks" prose (CLAUDE.md:40-42) is reconciled at F (now four).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI attribution.

## 4. Data and Fixture Dependencies

Reuse `MockProvider` (`src/providers/mock.ts`) with its **function responder** form
`new MockProvider((req, turnIndex) => MockTurn)` to capture the `CompletionRequest` — no new fixture. No
network. The mock reports usage per `MockTurn`, enabling the cumulativeUsage test.

## 5. Regression Protection

- `npm test` (full suite, 948 tests) green at Phase end — especially the existing `agent.test.ts`,
  `routing.test.ts`, `templates.test.ts`, `output-contract.test.ts` (these ride mutable `Agent` fields
  and must be unaffected since the new hook is inert without a handler), and the 11 `transformContext`
  extensions' tests (their hook still runs first).
- `test/kernel-surface.test.ts` green (runtime-export pin unchanged; `< 2200` lines).
- Default byte-identity (AC-4) is the core regression guard: the new `apply` call must not change the
  request when no `transformRequest` handler is registered.

## L2 Review Log

- **Round 1** — **zero severe, zero general**; 2 clarifications (pass `cumulativeUsage` as a defensive
  copy; pin test-title substrings for the accept regex). Both applied.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**
