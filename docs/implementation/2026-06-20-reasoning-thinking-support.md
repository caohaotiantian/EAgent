# Implementation: Normalized Reasoning / Thinking Support

- Slug: `2026-06-20-reasoning-thinking-support` (matches the design doc)
- Design doc: `docs/design/2026-06-20-reasoning-thinking-support.md`
- Status: closed
- Closing-commit: 7ab40dc
- Closed-on: 2026-06-20
- Deferred: none
- `<TEST-CMD>`: `npm test` (i.e. `node --import tsx --test "test/**/*.test.ts"`)
- `<ACCEPT-CMD>` (whole task): `npm run typecheck` && `npm run build` && `npm test`

> Provenance & review history: authored as the Full-Mode record after the
> implementation landed in commit `2f0890d`. The change is a single,
> independently-committable Phase that leaves `<TEST-CMD>` green (design §2 is one
> coherent contiguous block on the Provider/agent seam). L2 review — round 1
> general issue on the per-file acceptance command form, fixed; rounds 2 and 3
> clean. Round-by-round detail lives in git history.

## 1. Task Index

| Deliverable (design §2) | Acceptance (design §7) | Where |
|---|---|---|
| D1 ThinkingLevel | AC1 | `src/kernel/types.ts` (`ThinkingLevel`, `CompletionRequest.thinking`) |
| D2 ThinkingBlock | AC1, AC3 | `src/kernel/types.ts` (`ThinkingBlock`, `ContentBlock` union) |
| D3 reasoning_delta event | AC3, AC6 | `src/kernel/types.ts` (`StreamEvent`), `src/kernel/events.ts` |
| D4 agent threads thinking | AC6 | `src/kernel/agent.ts` |
| D5 anthropic | AC2, AC3 | `src/providers/anthropic.ts` |
| D6 openai | AC4 | `src/providers/openai.ts` |
| D7 gemini | AC5 | `src/providers/gemini.ts` |
| D8 mock | AC6 | `src/providers/mock.ts` |
| D9 host/cli | AC7 | `src/host.ts`, `src/cli.ts` |
| D10 tests | AC2–AC7 | `test/anthropic.test.ts`, `test/openai.test.ts`, `test/gemini.test.ts`, `test/agent.test.ts`, `test/host.test.ts` |

## 2. Phase Breakdown

### Phase 1 — Normalized reasoning across the Provider abstraction (single Phase)

- **Entry condition**: clean working tree on the feature branch; `npm test` green
  (baseline 232 tests).
- **Design references**: `docs/design/2026-06-20-reasoning-thinking-support.md`
  §2 (D1–D10), §4 (all decisions), §7 (AC1–AC8).
- **Task list, in TDD order** (tests precede the implementation they pin):
  1. `test/anthropic.test.ts`: add thinking request-mapping, reasoning-delta
     parsing, and signed-block round-trip tests (AC2, AC3).
  2. `test/openai.test.ts`: add `reasoning_effort` mapping + `reasoning_content`
     surfacing tests (AC4).
  3. `test/gemini.test.ts`: add `thinkingConfig` budget + `thought` part tests (AC5).
  4. `test/agent.test.ts`: add the forward-level + re-emit-reasoning test (AC6).
  5. `test/host.test.ts`: add `thinkingFromEnv` + `createAgentHost({thinking})`
     tests (AC7).
  6. `src/kernel/types.ts`: `ThinkingLevel`, `ThinkingBlock`, extend
     `ContentBlock`, `CompletionRequest.thinking`, `StreamEvent.reasoning_delta`
     (D1–D3).
  7. `src/kernel/events.ts`: `reasoning_delta` hook event (D3).
  8. `src/kernel/agent.ts`: `thinking` option/field; thread into request; re-emit
     `reasoning_delta` (D4).
  9. `src/providers/{anthropic,openai,gemini,mock}.ts`: per-provider mapping,
     parsing, and (anthropic) round-trip (D5–D8).
  10. `src/host.ts` (`thinkingFromEnv`, `AgentHostOptions.thinking`, wiring) and
     `src/cli.ts` (`--think`, USAGE, dim reasoning render, `--json` emit) (D9).
- **Per-task acceptance command** (each runnable from repo root). To isolate a
  single test file, invoke the runner directly — the `npm test` *script* hard-codes
  the `test/**/*.test.ts` glob, so `npm test -- test/x.test.ts` would run the whole
  suite, not just that file:
  - `npm run typecheck` → exit 0 (AC1)
  - `node --import tsx --test test/anthropic.test.ts` → exit 0 (AC2, AC3)
  - `node --import tsx --test test/openai.test.ts` → exit 0 (AC4)
  - `node --import tsx --test test/gemini.test.ts` → exit 0 (AC5)
  - `node --import tsx --test test/agent.test.ts` → exit 0 (AC6)
  - `node --import tsx --test test/host.test.ts` → exit 0 (AC7)
  - `npm test` → exit 0 (AC8, full suite, no regression)
  - `npm run build` → exit 0 (AC8)
- **Exit condition**: all acceptance commands exit 0; the new `ContentBlock`
  member is handled or safely ignored at every content-mapping site (verified by
  the F whole-change review).

## 3. Engineering Constraints Index

- **Engineering norms**: CLAUDE.md "House conventions" — ESM + NodeNext with `.js`
  import specifiers even for `.ts`; strict TypeScript (`noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`); no `any` cop-outs; zero
  runtime deps except `jiti`; providers use global `fetch`; every extension/seam is
  capability-gated and ships offline tests. Reasoning support adds no capability
  (it is a request/response shape, not a side effect) — consistent with the
  Provider primitive being unguarded.
- **Four-corner subagent template**: `references/loop-3-development.md`.
- **Commit conventions**: SKILL.md "Commit conventions" (`feat(phaseN):` opener,
  `<TEST-CMD>`/`<ACCEPT-CMD>` trailers, no AI/tooling mentions).

## 4. Data and Fixture Dependencies

- Reuses each provider test's existing SSE-`Response` builder and `req()` helper
  and `collect()` — no new fixtures. Mock reasoning is scripted inline via the new
  `MockTurn.reasoning` field; `MockProvider.lastThinking` is asserted directly. No
  network, no API key.

## 5. Regression Protection

- The pre-existing provider, agent, host, and extension tests (baseline 232) must
  remain green — in particular the existing Anthropic message-mapping, image, and
  caching tests (the `flatMap` rewrite of `toAnthropicMessages` must not change
  their output) and the agent tool-dispatch tests (the new `StreamEvent`/content
  member must not perturb existing flows). Full `npm test` is the gate.
