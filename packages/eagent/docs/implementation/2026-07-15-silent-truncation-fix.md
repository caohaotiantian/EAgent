# Implementation — Silent turn-termination: surface it, tune it, recover from it

Slug: `2026-07-15-silent-truncation-fix`
Design: `docs/design/2026-07-15-silent-truncation-fix.md`
Status: closed
Closing-commit: `d229845` (phases 1–5, code+docs) + this closeout
Closed-on: 2026-07-15
Deferred: none (see design doc §8 R5/R6 for the documented residuals). All 5 phases
landed round-1/round-3 clean; no L2 rollback occurred, so there is no Deprecated
section to prune.

## 1. Task Index (Deliverable / AC → design location)

All references are to `docs/design/2026-07-15-silent-truncation-fix.md`.

| Item | Design §2 Deliverable | Design §7 AC | Design KDD |
| --- | --- | --- | --- |
| D1 CLI truncation warning | D1 | AC1 | KDD1 |
| D2 output-cap default 8192 | D2 | AC7 | KDD4 |
| D3 kernel `message.stopReason` | D3 | AC2 | KDD2 |
| D4 autocontinue extension | D4 | AC3, AC4, AC5 | KDD3 |
| D5 MockProvider `stopReason` | D5 | AC6 | KDD5 |
| D7 docs (README/CHANGELOG) | D7 | AC8 | — |
| Gates (all phases) | — | AC8 | — |

`<TEST-CMD>` = `npm test` (`node --import tsx --test "test/**/*.test.ts"`, offline).
`<GATES>` = `npm run typecheck` + `npm run typecheck:test` + `npm run eval` + `npm run build`.
Single-file run: `node --import tsx --test test/<file>.test.ts`.

## 2. Phase Breakdown

Five phases, ordered by dependency. `npm test` is fully green at every Phase
boundary. Kernel line ceiling (`test/kernel-surface.test.ts:71`, `< 2265`; measured
2260) is re-checked at every Phase that touches `src/kernel/`.

---

### Phase 1 — Kernel + Mock seams (D3, D5)

The foundation: the `message` event must carry `stopReason` (so D4 can observe a
truncated turn), and `MockProvider` must be able to script a truncated turn (so
D1/D3/D4 are testable offline).

- **Entry condition:** branch `chore/silent-truncation-fix` at the L1-approved
  design state; `npm test` green.
- **Design references:** `docs/design/…-silent-truncation-fix.md` §2 D3+D5, KDD2
  (lines for the seam-timing + payload-safety argument), KDD5 (mock choice), AC2, AC6.
- **Task list (TDD order):**
  1. **T1.1 (test, RED)** — create `test/mock.test.ts`. Invariant: `MockProvider`
     yields the scripted terminal reason. Assert: a `MockTurn` with
     `stopReason:"max_tokens"` produces a `done` StreamEvent whose
     `stopReason === "max_tokens"`; a `MockTurn` with **no** `stopReason` field
     yields `"tool_use"` when `toolCalls` are present, else `"end_turn"` (regression
     pin on the existing inference at `mock.ts:103`). Drive the provider's
     `stream()` directly and read the final `done` event.
  2. **T1.2 (test, RED)** — in `test/agent.test.ts`, add: drive one turn with the
     mock scripted to `stopReason:"max_tokens"` (no toolCalls) and assert the
     **assistant** `message` event payload carries `stopReason === "max_tokens"`; a
     normal turn's assistant `message` carries `"end_turn"`; the **user** message
     event carries no `stopReason` (undefined). Invariant: the loop propagates the
     turn's terminal reason on the assistant message so an extension can observe it
     before the loop decides to stop.
  3. **T1.3 (impl, GREEN T1.1)** — D5: add `stopReason?: StopReason` to the
     `MockTurn` interface (`src/providers/mock.ts:27-32`); in the `done` emission use
     `turn.stopReason ?? <existing inference>` (`mock.ts:103` computes the inferred
     value, yielded at `:111`). Absent field ⇒ byte-identical to today.
  4. **T1.4 (impl, GREEN T1.2)** — D3: add `stopReason?: StopReason` to the `message`
     event in `KernelEvents` (`src/kernel/events.ts:35`; `StopReason` already
     imported at `events.ts:11`). At the assistant-message emit **only**
     (`src/kernel/agent.ts:261`) pass it:
     `await this.hooks.emit("message", { message: assistant.message, stopReason: assistant.stopReason });`
     Leave the user emit (`agent.ts:243`) and tool emit (`agent.ts:324`) unchanged.
     **Bare field, no comment block**: kernel is 2260 against the strict `< 2265`
     gate, so at most 4 lines may be added (max passing value 2264); +1–2 fits.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/mock.test.ts`
  - `node --import tsx --test test/agent.test.ts`
  - `npm run typecheck && npm run typecheck:test`
  - `npm test` (full suite green, incl. `test/kernel-surface.test.ts` with kernel
    `< 2265` — if the count reaches 2265, STOP and escalate per design R1)
- **Exit condition:** the mock scripts `stopReason`; the assistant `message` event
  carries `stopReason`; kernel `< 2265`; `npm test` green.

---

### Phase 2 — Provider output-cap default 4096 → 8192 (D2)

Independent of the other phases. Raises the effective default so realistic outputs
stop truncating.

- **Entry condition:** Phase 1 committed; `npm test` green. (No code dependency on
  Phase 1, but sequenced after it.)
- **Design references:** §2 D2, KDD4 (options + the ⚠ conflict resolution), §6 (the
  provider-honesty supersession), AC7, R4.
- **Task list (TDD order):**
  1. **T2.1 (test, RED)** — update the pinned-default assertions to `8192`:
     `test/provider-max-tokens.test.ts` (the no-override default; design cites the
     4096 pins at `:50/:67/:71`) and `test/openai.test.ts` (default `max_tokens` at
     `:187`, `max_completion_tokens` at `:200`; leave the `:201`
     `max_tokens === undefined` shape pin unchanged). **Add** a **Gemini**
     default assertion to `test/provider-max-tokens.test.ts` (set
     `process.env.GEMINI_API_KEY = "test"` first — mirror the sibling
     `ANTHROPIC_API_KEY = "test"` at `:52`, restored in `finally` — else `gemini.ts:56`
     throws before the body is built; build via `buildProviders` with no override;
     assert the captured Gemini request body carries
     `generationConfig.maxOutputTokens === 8192`, per `gemini.ts:58` / `:68-70`) — the
     only mechanical pin on the `gemini.ts:46` change (AC7's Gemini clause, otherwise
     verified only by parity with `host.ts:352`). **Keep** the override-path
     assertion (a
     `providers.<name>.maxTokens` override still wins, e.g. 8000) unchanged — that is
     the regression pin proving the number is a default, not a hardcode. These edits
     go RED against the current 4096 code.
  2. **T2.2 (impl, GREEN)** — change `4096 → 8192` at every **output-cap** site:
     `src/host.ts:342/347/352` (+ the doc comment `:332`), `src/providers/anthropic.ts:55`,
     `src/providers/openai.ts:55`, `src/providers/gemini.ts:46`. **Do NOT touch**
     `gemini.ts:264` (a `thinkingBudget`), `routing.ts:49` (`HARD_TOOL_RESULT_BYTES`,
     bytes), `teams.ts:124` (`BOARD_MAX_NOTE_BYTES`, bytes), or `handoff.ts:487`
     (`resumeMessage` byte budget).
- **Per-task acceptance commands:**
  - `node --import tsx --test test/provider-max-tokens.test.ts`
  - `node --import tsx --test test/openai.test.ts`
  - `npm test`
- **Exit condition:** no-override default is 8192 across all three providers; the
  override path still wins; `npm test` green.

---

### Phase 3 — CLI truncation warning (D1)

- **Entry condition:** Phase 1 committed (the test needs D5 to script `max_tokens`);
  `npm test` green.
- **Design references:** §2 D1, KDD1 (the warn-set `{max_tokens, content_filter,
  refusal}` and why `stop`/`error` are excluded), AC1, R2, §8 R6 (the documented
  `stop`-collapse residual — D1 intentionally does not warn on `stop`).
- **Task list (TDD order):**
  1. **T3.1 (test, RED)** — in `test/cli.test.ts`, add a programmatic test (not the
     subprocess harness): import the exported `wireRendering`, attach it to an
     `Agent` backed by a `MockProvider`, capture `process.stdout.write`. Cases:
     (a) a turn scripted `stopReason:"max_tokens"` (no toolCalls, via D5) prints a
     warning line containing `truncat` and `max_tokens` and a recovery hint naming
     `MAX_TOKENS`; (b) a turn scripted `end_turn` prints **no** warning line;
     (c) a run ending `stop` and one ending `error` print **no** truncation warning.
     Invariant: the REPL surfaces exactly the abnormal-and-otherwise-silent terminal
     reasons and stays quiet on clean/already-signalled ones.
  2. **T3.2 (impl, GREEN)** — in `src/cli.ts`: **(i) make the module import-safe**
     — `cli.ts:465` currently calls `main().catch(…)` **unconditionally** at module
     top level, so importing `cli.ts` runs the whole CLI. Guard it so `main()` runs
     only when `cli.ts` is the process entry point:
     `if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) { main().catch(…) }`
     (import `pathToFileURL` from `node:url`). This keeps `npm run dev` and the
     existing subprocess `test/cli.test.ts` tests firing `main()` (there
     `process.argv[1]` is `cli.ts`), while the new in-process test's `import` does
     not. **(ii) add `export`** to `function wireRendering` (`cli.ts:289`) so the
     test can drive the human render path — with (i) this is the minimal offline seam
     for AC1/D6(a) (the subprocess harness cannot script a `max_tokens` turn); it
     adds no kernel/public-contract surface (`cli.ts` is not a barrel; the
     kernel-surface pins are untouched). **(iii) inside `wireRendering`**, register
     `agent.hooks.on("agent_end", ({ reason }) => { … })` that prints one warning
     line for `reason ∈ {"max_tokens","content_filter","refusal"}` and nothing
     otherwise. Message per reason: `max_tokens` → truncation + "raise
     `*_MAX_TOKENS` or enable `/autocontinue`"; `content_filter` → stopped by the
     provider content filter; `refusal` → the model declined. Use the existing
     `C.yellow`/`C.dim` colour helpers, matching the `⏹ interrupted` style.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/cli.test.ts`
  - `npm run typecheck && npm test`
- **Exit condition:** the warning appears for the three abnormal reasons and is
  absent for `end_turn`/`tool_use`/`stop`/`error`; existing subprocess cli tests
  still green; `npm test` green.

---

### Phase 4 — autocontinue extension (D4)

- **Entry condition:** Phase 1 committed (needs D3's `message.stopReason` and D5's
  mock scripting); `npm test` green.
- **Design references:** §2 D4, KDD2 (the seam), KDD3 (extension shape, injection,
  nudge, cap=3, acting-agent keying + `agent_start` reset, opt-in off), AC3, AC4,
  AC5, R3.
- **Task list (TDD order):**
  1. **T4.1 (test, RED)** — create `test/autocontinue.test.ts`. AC3 (resume):
     activate the extension, enable it (`/autocontinue on` or the store flag), script
     the mock `[turn1: text + stopReason:"max_tokens", no toolCalls; turn2: text +
     end_turn]`; run; assert final `RunResult.reason === "end_turn"`, both turns'
     text present in the transcript, and that a `role:"user"` follow-up message was
     injected between them. Invariant: a truncated final answer is automatically
     continued to a clean end when enabled.
  2. **T4.2 (test, RED)** — AC4 (cap + per-run reset): script **every** turn
     `stopReason:"max_tokens"` (no toolCalls); enabled; assert exactly **3**
     continuations then `reason === "max_tokens"` (no infinite loop); then call
     `run()` a **second** time on the same agent and assert it again performs 3
     continuations (proving the `agent_start` reset ⇒ per-run, not per-session).
     Invariant: bounded token spend, reset each top-level run.
  3. **T4.3 (test, RED)** — AC5 (inert cases): (a) with the extension **disabled**
     (default), a `max_tokens` turn ends immediately with `reason === "max_tokens"`
     and **no** follow-up; (b) with `EAGENT_AUTOCONTINUE=off` in env, `/autocontinue
     on` does **not** enable it; (c) a `max_tokens` turn that **also** carries a
     `tool_call` injects **no** follow-up (the tool-call path continues the loop).
     Invariant: no auto-spend unless explicitly enabled, and no double-drive on the
     tool-call path.
  4. **T4.4 (impl, GREEN)** — create `src/extensions/autocontinue.ts`. `activate(e)`:
     - Register `e.on("agent_start", …)` → reset the per-agent count for `e.agent`.
     - Register `e.on("message", ({ message, stopReason }) => …)`: return early
       unless `e.config.enabled("autocontinue", { default: false, store: e.store })`;
       require `message.role === "assistant"`, `stopReason === "max_tokens"`, and
       `!message.content.some(b => b.type === "tool_call")`; read the count from a
       `WeakMap<Agent, number>` keyed on `e.agent` (`?? 0`); if `count < 3`,
       increment and inject `e.agent.handle.followUp(text("user", NUDGE))` — import
       `text` from `../kernel/types.js` (matching `budget-cap.ts:51`, not the barrel);
       `e.agent.handle.followUp` matches the `.handle` precedent of
       `output-contract`/`circuit-breaker`/`budget-cap` (the direct `e.agent.followUp`
       also typechecks). `NUDGE` = a constant instructing the model to continue from
       where it stopped without repeating.
     - Register `/autocontinue on|off|status` (mirror `drift-probe.ts:349-360`):
       `on`/`off` set the store enable flag; `status` reports enabled + the cap.
     - Kill switch: `EAGENT_AUTOCONTINUE=off` is honoured by `e.config.enabled`.
     - No `capabilities:` (pure message injection; matches `watchdog`/`recovery`).
  5. **T4.5 (impl, GREEN)** — append `"autocontinue"` (its `activate`) to
     `BUILTIN_EXTENSIONS` in `src/host.ts`, grouped with the opt-in observers (near
     `drift-probe`/`playbook`), after `core-tools`.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/autocontinue.test.ts`
  - `npm run typecheck && npm run typecheck:test && npm test`
- **Exit condition:** enabled ⇒ resumes a truncated run (final `end_turn`); capped
  at 3 with a per-run reset; inert when disabled / kill-switched / on the tool-call
  path; registered in `BUILTIN_EXTENSIONS`; `npm test` green.

---

### Phase 5 — Docs + final gates (D7)

- **Entry condition:** Phases 1–4 committed; `npm test` green.
- **Design references:** §2 D7, AC8.
- **Task list:**
  1. **T5.1** — `README.md`: add the `autocontinue` row to the extension table
     (command `/autocontinue`; capability "none"; "opt-in, ships off"; one-line
     description). Where the README documents provider config / CLI behaviour, note
     the raised `8192` output-cap default and the new interactive truncation warning.
  2. **T5.2** — `CHANGELOG.md`: entries for D1 (CLI surfaces abnormal terminal
     reasons), D2 (default output cap 4096→8192), D4 (`autocontinue` extension), and
     the D3 kernel `message.stopReason` field.
  3. **T5.3** — run the full gate suite; confirm kernel `< 2265`.
- **Per-task acceptance commands (AC8):**
  - `npm test`
  - `npm run typecheck`
  - `npm run typecheck:test`
  - `npm run eval`
  - `npm run build`
- **Exit condition:** README + CHANGELOG updated; every gate exits 0; kernel `< 2265`.

## 3. Engineering Constraints Index

- **Project engineering norms** — CLAUDE.md _House conventions_ role: ESM + NodeNext
  (always `.js` import specifiers, even for `.ts` sources); strict TypeScript
  (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`; no `any`); **zero runtime dependencies except
  `jiti`** (providers use global `fetch`); extensions are capability-gated and ship
  with offline tests + an `EAGENT_<NAME>=off` kill switch when they observe/intervene
  by default; opt-in extensions ship **off**.
- **Kernel discipline** — `src/kernel/` under the `< 2265` line ceiling
  (`test/kernel-surface.test.ts:71`); D3 is the only kernel change (+1–2 lines, bare
  field). Adding a kernel export or `ExtensionAPI` member is out of scope (would trip
  the runtime-surface pins).
- **Four-corner subagent template** — `references/loop-3-development.md`
  (dev → review → accept → fix, each a fresh subagent).
- **Commit conventions** — SKILL.md "Commit conventions": `feat(phaseN):` /
  `fix(phaseN):` openers, `fix(phaseN-roundR): <keyword>` within-round fixes;
  `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; **no AI/model/tooling attribution**
  in any commit (CLAUDE.md _No Claude Code artifacts_ rule — no `Co-Authored-By`, no
  `Claude-Session`, no claude.ai links, no `claude/` branch names).

## 4. Data and Fixture Dependencies

- **Reuse:** `MockProvider` (`src/providers/mock.ts`) — extended by D5 to script
  `stopReason`; its array/function responder (`mock.ts:34,114-119`) drives the
  multi-turn sequences AC3/AC4 need. The `drift-probe` extension
  (`src/extensions/drift-probe.ts:23,235,349-360`) is the copy-from pattern for D4's
  opt-in enable-flag + command + kill switch. The `test/cli.test.ts` subprocess
  harness stays for the existing tests; D1's new test uses the exported
  `wireRendering` programmatically instead.
- **New fixtures/files:** `test/mock.test.ts` (D5), `test/autocontinue.test.ts` (D4),
  `src/extensions/autocontinue.ts` (D4). No external data.

## 5. Regression Protection

- **Every Phase:** `npm test` fully green (the whole offline suite) and, for any
  Phase touching `src/kernel/`, `test/kernel-surface.test.ts` green with kernel
  `< 2265`.
- **Phase 1:** the D5 change must keep the mock's default inference byte-identical
  (T1.1 regression pin: absent `stopReason` ⇒ `tool_use`/`end_turn`); the D3 field is
  optional, so all existing `message`-event observers (journal, renderers, otel,
  hooks tests) must stay green.
- **Phase 2:** the override-path assertion (a `providers.<name>.maxTokens` override
  wins) must remain green — proving 8192 is a default, not a hardcode; no unrelated
  `4096`/`8192` byte-budget constant is changed.
- **Phase 3:** the existing `test/cli.test.ts` subprocess tests (`--json` JSONL
  purity, human-mode echo) must stay green — D1 adds a handler, it does not alter the
  streaming/echo behaviour. The T3.2(i) main-guard must keep `main()` firing when
  `process.argv[1]` is `cli.ts` (subprocess tests + `npm run dev`) while an
  in-process `import` does not — verify both the subprocess tests and the new
  in-process test pass in the same file. `test/jsonl-adoption.test.ts` (reads
  `cli.ts` source; asserts it imports `./jsonl.js` + calls `wireJsonl(` and
  hand-rolls no common-event objects) must also stay green — the main-guard and the
  `agent_end` handler leave both untouched.
- **Phase 4:** the child-scope / sub-agent tests (`test/hooks.test.ts`,
  `test/subagents.test.ts`, `test/governed-subagents.test.ts`) must stay green — D4
  relies on `agent_start` suppression for sub-agents and must not perturb it; the
  `agent_end`-driven extensions (`goal`, `handoff`, `otel-exporter`) must stay green.
- **Phase 5:** docs-only + the full `<GATES>` (`eval` 5/5, `build` 0,
  `typecheck`/`typecheck:test` 0).
