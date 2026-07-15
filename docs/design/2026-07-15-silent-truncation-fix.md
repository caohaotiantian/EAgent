# Design — Silent turn-termination: surface it, tune it, recover from it

Slug: `2026-07-15-silent-truncation-fix`
Status: draft

## 1. Background and Purpose

A user running the interactive CLI (`npm run dev`) against an OpenAI-compatible
endpoint reported: the model streams a partial answer, then the run ends
silently — a bare prompt returns, with no error and no explanation. Reconstructed
from on-disk run artifacts (`~/.eagent/state/checkpoint.json` checkpoints 86–97 =
12 `bash` calls ending `2026-07-15T07:06:39Z`; the last offloaded tool result was
an 845-line test-file dump), the run read many files across ~12 turns and then its
final synthesis turn was cut off at the output-token cap.

Three stacked defects produce "terminated halfway with no explanation":

1. **The output cap is low and truncation is the trigger.** The effective
   per-provider output cap defaults to **4096** tokens (`src/host.ts:342/347/352`
   `config.int("providers.<name>.maxTokens", 4096)`; provider constructor fallbacks
   `anthropic.ts:55`, `openai.ts:55`, `gemini.ts:46`). A long final answer hits the
   cap → `finish_reason:"length"` → mapped to the neutral `"max_tokens"`
   (`src/providers/openai.ts:157,253-266`).

2. **The loop ends silently on `max_tokens`.** The agent loop's no-tool-call
   branch adopts the turn's `stopReason` and `break`s with **no error event and no
   continuation** (`src/kernel/agent.ts:267-277`). Contrast `agent.ts:333-339`,
   where hitting `maxTurns` **does** `emit("error", …)`.

3. **The interactive CLI never surfaces the terminal reason.** `wireRendering`
   (`src/cli.ts:289-331`) subscribes to `reasoning_delta`, `text_delta`, `message`,
   `tool_start`, `tool_end`, `error` — but **not** `agent_end`. The run's `reason`
   is surfaced only in `--json` mode (`cli.ts:339`) and by the HTTP server
   (`server.ts:530`). In the REPL it is structurally invisible.

If we do nothing: interactive users keep seeing truncated answers end with zero
signal; there is no way to lengthen a truncated answer; and the terminal-reason
path (`max_tokens`/`content_filter`/`refusal`) stays untested at the loop level
(the sweep confirmed no test asserts loop/`agent_end` behavior on `max_tokens`).

## 2. Deliverables

- [ ] **D1 (Fix #1 — CLI visibility, primary repair)** — add an `agent_end`
      handler to `wireRendering` (`src/cli.ts`) that prints one visible warning line
      when `reason ∈ {max_tokens, content_filter, refusal}`, and prints nothing for
      `end_turn`/`tool_use`/`stop`/`error`. The warning names the cause and the
      recovery lever (raise `*_MAX_TOKENS`, or enable auto-continue).
- [ ] **D2 (Fix #2 — raise the default cap)** — change the effective output-cap
      default `4096 → 8192` at every output-cap site: `host.ts:342/347/352` (+ the
      doc comment `:332`), `anthropic.ts:55`, `openai.ts:55`, `gemini.ts:46`. Update
      the tests that pin `4096` (`test/provider-max-tokens.test.ts`,
      `test/openai.test.ts:187,200-201`). Do **not** touch `gemini.ts:264` (a
      `thinkingBudget`, not an output cap) or the byte-cap constants
      (`routing.ts:49`, `teams.ts:124`).
- [ ] **D3 (kernel seam)** — add an optional `stopReason?: StopReason` to the
      `message` KernelEvent (`src/kernel/events.ts:35`) and set it at the
      assistant-message emit only (`src/kernel/agent.ts:261`). `StopReason` is
      already imported at `events.ts:11`, so no import is added. Must ship as a
      **bare field** (no multi-line comment): measured kernel is **2260**, ceiling
      **2265** (`kernel-surface.test.ts:71`), so headroom is **5 lines** — D3's
      +1–2 lines fit, but a comment block would breach it. This is the minimal
      signal that lets an extension observe a truncated turn while a continuation can
      still be injected.
- [ ] **D4 (Fix #3 — auto-continue extension)** — a new
      `src/extensions/autocontinue.ts` (appended to `BUILTIN_EXTENSIONS` in
      `src/host.ts`). It observes the `message` event; when the assistant message has
      `stopReason === "max_tokens"`, carries **no** `tool_call` block, and the
      per-run continuation count is below the cap, it injects a "continue" follow-up
      via the acting agent's `followUp()` (`agent.ts:170`), so the loop's existing
      `#followUps` drain (`agent.ts:268-269`) resumes the run instead of stopping.
      Ships **off** (user decision); enabled via `/autocontinue on` (store flag) and
      hard-disabled by `EAGENT_AUTOCONTINUE=off`. Continuation cap = **3** per run.
- [ ] **D5 (MockProvider test seam)** — add an optional `stopReason?: StopReason`
      to `MockTurn` (`src/providers/mock.ts:27-32`) and yield it from the `done`
      event (`mock.ts:103,111`) when present (default preserves today's
      `tool_use`/`end_turn` inference). Required because the mock cannot currently
      script a truncated turn.
- [ ] **D6 (tests)** — offline tests: (a) `cli` prints the truncation warning on a
      `max_tokens` run and nothing on `end_turn`; (b) the `message` event carries
      `stopReason`; (c) `autocontinue` resumes a `max_tokens` run when enabled (final
      `reason === "end_turn"`), stops after the cap, is inert when disabled, and does
      not fire when the truncated turn has a tool call; (d) D2's 8192 default is
      pinned. Each behavioral test RED before its fix, GREEN after.
- [ ] **D7 (docs)** — README extension table row for `autocontinue` (+ command +
      "no capability"); CHANGELOG entries for D1/D2/D4; note the raised default and
      the new warning.

## 3. Scope Boundary (NOT in scope)

- **No change to the agent loop's control flow.** D3 adds one optional field to an
  existing event payload; it does **not** add a `break`/`continue` branch, reorder
  the loop, or change when `#followUps` is drained. Auto-continue reuses the
  existing drain (`agent.ts:268-269`) unchanged.
- **No new kernel export or `ExtensionAPI` member.** D3 is a type-field + emit-arg
  change only; the kernel-surface runtime pins (`kernel-surface.test.ts:52-60,94-107`)
  are untouched.
- **Fix #1 warns; it does not change termination.** D1 is render-only; it does not
  retry, continue, or alter `reason`. Recovery is D4's job, and only when enabled.
- **`stop` and `error` are not warned by D1.** `stop` already has its own signals
  (Ctrl-C prints `⏹ interrupted` `cli.ts:192`; `maxTurns` emits `error`
  `agent.ts:335`; a `terminate` tool is an intentional final answer); `error` is
  already surfaced by the existing `error` handler (`cli.ts:328`) + `runTurn` catch
  (`cli.ts:348-353`). Warning on them would double-report.
- **No per-request `maxTokens` override / no `CompletionRequest` change.** D2 only
  changes the construction-time default number; the config/env override plumbing
  already exists (`config.ts:47-49`) and is unchanged.
- **No auto-continue for a `max_tokens` cut that lands mid-tool-call.** When the
  truncated turn carries a `tool_call`, the loop already continues via the tool-call
  path (`agent.ts:263-290`); D4 explicitly excludes that case (no follow-up), so it
  never double-drives the loop.
- **No change to the HTTP server or `--json` paths.** They already surface
  `agent_end.reason` (`server.ts:530`, `cli.ts:339`). D1 closes only the interactive
  REPL gap.
- **No prompt-caching, watchdog, routing, or reliability changes.**
- **No latency/throughput budget declared.** D1 adds one `console.log` on
  `agent_end` (no hot path); D2 changes a ceiling constant, not a target. The only
  runtime-cost surface is D4's token spend, which is bounded and measured as the
  quality budget (§7 AC4). No perf/latency budget applies.

## 4. Key Design Decisions

### KDD1 — Fix #1: which reasons warn, and where the handler lives
- **Problem:** the REPL discards `agent_end.reason`. Which terminal reasons deserve
  a warning, and where does the handler attach?
- **Options:** (A) warn on every reason that is not `end_turn`; (B) warn only on the
  "abnormal-and-otherwise-silent" subset `{max_tokens, content_filter, refusal}`;
  (C) print the reason unconditionally (including `end_turn`).
- **Choice: (B), handler added to `wireRendering`.** The `StopReason` union is
  `end_turn | tool_use | max_tokens | stop | error | refusal | content_filter`
  (`types.ts:171-178`). Warn-set production sites (non-dead set): `max_tokens` from
  all three provider mappers (`openai.ts:259`, plus the Anthropic/Gemini `max_tokens`
  cases asserted at `test/anthropic.test.ts:484`/`test/gemini.test.ts:199`),
  `content_filter` (`openai.ts:262`, `gemini.ts:250`), `refusal` (`anthropic.ts:340`).
  `end_turn`/`tool_use` are clean ends; `error` is already surfaced by the error
  handler (`cli.ts:328`) + `runTurn` catch.
- **`stop` is deliberately excluded — with a documented residual (§8 R6).** Two
  distinct paths collapse to `reason="stop"` at `agent_end`: the **three internal**
  assignments (`agent.ts:249/258` abort, `:329` terminate, `:334` maxTurns), which
  already carry their own signals; **and a provider-done `stop`** from the mappers'
  `default → "stop"` fallthrough (`openai.ts:263`, `anthropic.ts:341`,
  `gemini.ts:251`) reaching `agent.ts:274` on a no-tool-call turn, which has **no**
  other signal. Because `agent_end.reason` cannot distinguish the two, D1 cannot warn
  on the provider-done case without double-reporting abort/maxTurns; that residual
  (exotic/unknown finish reasons, incl. some Gemini content-withholding reasons that
  do not map to `content_filter`) is recorded in §8 R6, not silently claimed as
  handled. The reported bug (`max_tokens`) is unaffected — it maps cleanly and is
  warned.
- **Reject (A):** warns on `stop` (double-reporting the internal cases) and on
  `error` (double-reporting the error line). **Reject (C):** a warning on every clean
  `end_turn` is noise that trains the user to ignore the channel. The handler belongs
  in `wireRendering` beside the other lifecycle renderers, mirroring the `--json`
  renderer's existing `agent_end` handler (`cli.ts:339`).
- The `agent_end` event fires once per run (`agent.ts:351`, in `finally`), so D1
  cannot double-warn within a run.

### KDD2 — Fix #3 seam: how an extension observes a truncated turn in time
- **Problem:** to resume a truncated run, an extension must (i) learn the turn's
  `stopReason` and (ii) queue a follow-up **before** the loop's no-tool-call branch
  breaks. No existing event carries the per-turn `stopReason`: `turn_end` has
  `{turn, step}` (`events.ts:32`); `message` has `{message}` (`events.ts:35`);
  `agent_end` carries `reason` but fires in `finally` (`agent.ts:351`), after the
  loop has already broken.
- **Options:** (A) add `stopReason?` to the `message` event, set at the
  assistant-message emit (`agent.ts:261`), which fires **before** the `#followUps`
  check (`agent.ts:268`); (B) a new dedicated event (e.g. `assistant_turn`); (C) add
  `stopReason` to `turn_end`; (D) infer truncation from the `usage` event
  (outputTokens ≈ cap).
- **Choice: (A).** The `message` emit at `agent.ts:261` runs (awaited) before the
  no-tool-call branch computes `calls` (`:263`) and checks `#followUps` (`:268`), so
  a handler that calls `followUp()` there is picked up by the existing drain and the
  loop continues — **no loop-control change needed**. This is the same pattern
  `turn-loop-hardening` KDD1 used: it added `model` to the `usage` event as a
  +0–2-line kernel field rather than an extension-only workaround, precisely because
  no event carried the datum an extension needed. **Reject (B):** a new event is a
  new public contract surface and costs more kernel lines against a **5-line**
  headroom (measured **2260** / ceiling 2265, `kernel-surface.test.ts:71`).
  **Reject (C):**
  `turn_end` fires at `agent.ts:276` in the no-tool-call branch — **after** the
  `#followUps` check and immediately before `break` — too late to inject.
  **Reject (D):** the extension does not know the provider's cap, and
  `outputTokens == cap` is an unreliable proxy (a natural stop can coincide).
- **Payload-shape safety (verbatim):** no test pins the `message`/`turn_end` payload
  shape or `deepEqual`s it — consumers destructure named fields
  (`test/agent.test.ts:843-852` reads `turn_end`'s `{step}`); `KernelEvents` is an
  erased TS type, not a runtime kernel export, so the kernel-surface pin
  (`kernel-surface.test.ts:52-60,94-107`) is unaffected. An **optional** field is
  backward-compatible with every existing observer.

### KDD3 — Fix #3 shape: extension, injection, nudge, cap, default posture
- **Problem:** how the auto-continue behavior is packaged and bounded.
- **Extension, not core (charter):** "new behavior is always an extension, never a
  fork of the core." D4 is a single file gated on a store flag, matching the
  `watchdog`/`drift-probe` precedent. The only kernel touch is D3's shared signal.
- **Injection mechanism:** call the acting agent's `followUp()` (`agent.ts:170`,
  exposed on the AgentHandle `:160`) with a user message
  `{role:"user", content:[{type:"text", text: <nudge>}]}` — the canonical injection
  shape used by `test/routing.test.ts:191-194` and the `steer` callers
  (`output-contract.ts:158`, `circuit-breaker.ts:166`, `budget-cap.ts:321`).
  `followUp` (not `steer`) is correct: `steer` drains at the **top** of the next
  turn (`agent.ts:252`), but a truncated no-tool-call turn is about to break with no
  next turn; `followUp` is the mechanism that specifically resurrects a would-be
  terminal loop (`agent.ts:268-269`).
- **Continuation nudge (options):** (a) a user message "your previous response was
  cut off at the token limit; continue from where you stopped, without repeating";
  (b) an assistant-role prefill continuation. **Choice: (a)** — provider-neutral and
  transcript-honest; assistant-prefill continuation is model/provider-specific and
  not uniformly supported across the three providers.
- **Cap = 3 per top-level run, keyed on the acting agent (user decision + keying
  choice):** bounds runaway token spend; well under `maxTurns` 24 (`agent.ts:135`).
  The count lives in a `WeakMap<Agent, number>` keyed on the **acting** agent
  (`e.agent`), read as `?? 0`, and **reset to 0 on `agent_start`** (emitted at
  `agent.ts:239`, which fires once per top-level `run()`; it is suppressed for
  sub-agents because `agent_start` is in `SUPPRESSED_LIFECYCLE_EVENTS`
  (`hooks.ts:36-42`) which `childScope` applies (`hooks.ts:167`), so a sub-agent's
  child bus has no `agent_start` handlers). The reset is what makes it "3 **per
  run**", not per session: the
  interactive REPL reuses **one** root `Agent` object across every user turn (`cli.ts`
  calls `agent.run(line)` per line; `agent.ts:227` `rootAgentStore.getStore() ?? this`),
  so a counter with **no reset** would silently become per-*session* — it would stop
  helping after 3 truncations anywhere in the session (the round-1 review's finding).
  A fresh sub-agent `Agent` object starts at 0 naturally (WeakMap miss).
- **Keying options:** (i) per acting agent (chosen); (ii) per run-tree root
  (`e.rootAgent`) — one shared budget across the whole tree. **Choice (i)** — each
  agent gets its own budget of 3, the follow-up is injected on that same acting agent
  anyway, and a sub-agent's truncations do not deplete the primary answer's budget.
  **Reject (ii):** a chatty sub-agent could exhaust the root's shared budget and
  starve the primary answer's continuations; the per-agent bound is more predictable
  and matches where the injection goes. On reaching the cap the extension stops
  injecting; the loop breaks with `reason === "max_tokens"`, and D1 surfaces it.
- **Default posture = opt-in, ships off (user decision):** unlike the `watchdog`
  (inert until a stall, so ships on, `turn-loop-hardening` KDD5), auto-continue
  **actively spends extra tokens/turns** when it fires, so it follows the "opt-in
  ships off" house convention. Enable via `/autocontinue on` (store flag, per
  `drift-probe.ts:349-360`); hard-disable via `EAGENT_AUTOCONTINUE=off`; the enable
  state is re-checked at event time via `e.config.enabled("autocontinue",
  {default:false, store:e.store})` so `/autocontinue on` takes effect live.
- **No capability:** the extension performs no privileged side effect (no
  `fs`/`net`/`shell`/`code` access); it only injects a message. Matches `watchdog`
  and `recovery`, which declare none. (Extra token spend is not a capability in
  EAgent's vocabulary — capabilities gate tools, not cost.)

### KDD4 — Fix #2: raise the default to 8192, all providers, both layers
- **Problem:** 4096 truncates realistic agent outputs (the reported bug). What new
  default, and where?
- **Options:** (A) 8192 at every output-cap site (host defaults + the three provider
  constructor fallbacks) for one consistent number; (B) 8192 only at the host
  `buildProviders` defaults, leaving the constructor fallbacks at 4096; (C) leave
  the default and rely on users setting `*_MAX_TOKENS`.
- **Choice: (A).** One number everywhere avoids a confusing split where
  `new OpenAIProvider()` yields 4096 but the host yields 8192; 8192 is a modest,
  widely-supported doubling that covers realistic synthesis turns while staying well
  below provider ceilings. **Reject (B):** leaves an inconsistent secondary default
  that surprises anyone constructing a provider directly (e.g. in tests).
  **Reject (C):** the reported failure is the *default* behavior; requiring every
  user to discover an env var to get a non-truncated answer is the bug, not the fix.
- **⚠ Conflict with a closed design (warning marker):** `provider-honesty`
  (`2026-07-10-provider-honesty.md` D6/KDD4/R3) deliberately **kept the default at
  4096** — but its rationale was "preserve behavior *while adding configurability*"
  (it was introducing the `providers.*.maxTokens` config + `*_MAX_TOKENS` aliases,
  not arguing 4096 is optimal). D2 is a **new, deliberate** decision to raise the
  floor now that 4096 is shown to truncate real runs; it does not contradict that
  doc's reasoning, and it reuses that doc's config/override plumbing unchanged. See
  §6.

### KDD5 — testing a truncated turn offline
- **Problem:** `MockProvider` cannot script a `max_tokens` turn — `MockTurn` has no
  finish-reason field and the mock only yields `"tool_use"`/`"end_turn"`
  (`mock.ts:103,111`). D1/D3/D4 all need a scripted truncated turn.
- **Options:** (A) add an optional `stopReason?` to `MockTurn`, yielded from `done`
  when present; (B) a bespoke `Provider` async-generator per test; (C) the
  hand-written `done()` StreamEvent helper some tests already use
  (`test/reasoning-search.test.ts:421`).
- **Choice: (A).** The mock already computes and yields a `stopReason` — this only
  makes it overridable, a minimal additive change with a default that is
  byte-identical to today (inference preserved when the field is absent). It is
  reusable by every future terminal-reason test and keeps the D6 tests short.
  **Reject (B):** per-test bespoke providers are boilerplate and don't generalize.
  **Reject (C):** the `done()` helper works for a single provider-level turn but is
  awkward for the multi-turn auto-continue sequence (truncate, then complete) that
  D4's test needs; the mock's array/function responder handles multi-turn natively
  (`mock.ts:114-119`).

## 5. Dependencies and Assumptions

- **Agent loop injection points** (verbatim): `followUp(message)` pushes to
  `#followUps` (`agent.ts:170-172`), exposed on the AgentHandle (`agent.ts:160`);
  the no-tool-call branch drains `#followUps` and `continue`s instead of breaking
  when non-empty (`agent.ts:267-277`), and the assistant `message` event is emitted
  (awaited) at `agent.ts:261`, before that branch. `e.agent` resolves to the acting
  agent via the actingAgent ALS set at `agent.ts:229`, so inside a `message` handler
  it is the emitting agent.
- **Opt-in extension pattern** (verbatim): `drift-probe` reads
  `e.config.enabled("drift-probe", {default:false, store:e.store})` (`:235`),
  toggles a store flag from `/drift-probe on|off` (`:349-360`), and is hard-disabled
  by `EAGENT_DRIFT_PROBE=off` (`:23`). D4 mirrors this.
- **Provider terminal-reason mapping** (verbatim): `finish_reason:"length" →
  "max_tokens"` (`openai.ts:259-260`); `stop_reason:"max_tokens"`
  (`anthropic.ts`, asserted `test/anthropic.test.ts:484`); `MAX_TOKENS`
  (`gemini.ts`, asserted `test/gemini.test.ts:199`).
- **Kernel ceiling** (verbatim): `assert.ok(lines < 2265, …)` summing
  `.split("\n").length` over `src/kernel/*.ts` (`kernel-surface.test.ts:71`);
  measured **2260** (agent.ts 571, types.ts 355, extension.ts 318, …); headroom
  **5**. D3 is a bare +1–2-line field (no comment block).
- **MockProvider** (verbatim): `MockTurn = {text?, reasoning?, toolCalls?}`
  (`mock.ts:27-32`); `stopReason` computed at `mock.ts:103`, yielded at `:111`;
  multi-turn via array/function responder indexed by `#turn` (`:114-119`).
- **Assumption:** the OpenAI-compatible endpoint reports `finish_reason:"length"`
  on truncation (the standard field); an endpoint that closes the stream early with
  **no** finish reason yields `end_turn` (default `stopReason`) — that is a separate
  early-close class, out of scope here (D1 still surfaces any warned reason it does
  report; it is documented as a residual in §8).
- **Test harness:** `node:test` via `tsx`, offline through `MockProvider`; CLI
  tests drive `--json` and assert stdout lines (`test/cli.test.ts:47`).
- **Measured baseline (this branch, to confirm at L2):** `npm test`, `npm run
  typecheck`, `npm run typecheck:test`, `npm run eval`, `npm run build` all green
  before changes.

## 6. Relationship with Existing Designs

- **⚠ `docs/design/2026-07-10-provider-honesty.md` (D6/KDD4/R3) — direct value
  conflict on the 4096 default.** That closed batch set `providers.<name>.maxTokens`
  config + `*_MAX_TOKENS` env aliases and **deliberately kept the default 4096**
  ("Default stays 4096, preserving behavior"; AC4 pins the no-override default at
  4096). D2 changes that default to 8192. Resolution: this is a **new deliberate
  decision** (KDD4), not a reversal of that doc's rationale (which was
  behavior-preservation while adding configurability). D2 **reuses** that doc's
  config/env plumbing unchanged and updates the tests that pin 4096
  (`test/provider-max-tokens.test.ts`, `test/openai.test.ts:187,200-201`). Source of
  truth is this doc for the number going forward.
- **`docs/design/2026-07-11-turn-loop-hardening.md` (KDD1, KDD5, AC7) — precedent,
  no conflict.** KDD1 (add `model` to the `usage` event as a +0–2-line kernel field)
  is the exact template for D3 (add `stopReason?` to the `message` event). KDD5
  (watchdog ships on because it is inert until triggered) is the *contrast* that
  justifies D4 shipping **off** (auto-continue is not inert — it spends tokens).
  AC7's ceiling discipline (`< 2265`, STOP-and-escalate if a change breaches it) is
  inherited by D3.
- **`docs/design/2026-07-10-cli-json.md`** — the `--json`/JSONL rendering path D1
  parallels in the human renderer; no conflict (D1 adds the human-mode handler the
  JSON mode already has).
- Terminology anchors: `CLAUDE.md` (kernel primitives, the `agent_end`/`message`
  events, `EAGENT_<NAME>=off` convention, capability vocabulary) and `README.md`
  (the extension table).

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (D1 warns on truncation):** a CLI test drives a run whose final turn has
  `stopReason:"max_tokens"` (via D5) and asserts stdout contains the truncation
  warning naming `max_tokens` and a recovery lever; a second run ending `end_turn`
  asserts **no** warning line is printed. RED before D1. Command:
  `node --import tsx --test test/cli.test.ts`.
- **AC2 (D3 message event carries stopReason):** a test drives one turn and asserts
  the assistant `message` event payload has `stopReason` equal to the turn's stop
  reason; a `tool_use`/`end_turn` turn carries the corresponding value. RED before
  D3. Command: `node --import tsx --test test/agent.test.ts`.
- **AC3 (D4 resumes a truncated run when enabled):** with `autocontinue` enabled,
  a scripted sequence [turn 1 `max_tokens` no-tool-call, turn 2 `end_turn`] runs to
  completion with final `RunResult.reason === "end_turn"` and both turns' text
  present; the injected follow-up is a `role:"user"` message. RED before D4.
- **AC4 (D4 cap — the declared token-spend quality budget):** with every turn
  scripted `max_tokens`, one top-level `run()` performs exactly **3** continuations
  then ends with `reason === "max_tokens"` (cap enforced, no infinite loop); a
  **second** `run()` on the same reused agent again performs 3 continuations, proving
  the `agent_start` reset gives per-run (not per-session) semantics. RED before D4.
- **AC5 (D4 inert when disabled / not triggered):** with `autocontinue` off
  (default), a `max_tokens` turn ends immediately with `reason === "max_tokens"`
  (no follow-up); with `EAGENT_AUTOCONTINUE=off` set, `/autocontinue on` does not
  enable it; a `max_tokens` turn that **also** carries a `tool_call` injects **no**
  follow-up (the tool-call path handles continuation). RED before D4.
- **AC6 (D5 mock scriptability):** a `MockTurn` with `stopReason:"max_tokens"` yields
  a `done` event whose `stopReason` is `"max_tokens"`; a `MockTurn` without the field
  yields today's inferred value (`tool_use` if toolCalls present, else `end_turn`) —
  regression pin. Command: `node --import tsx --test test/mock.test.ts` (or the
  provider test file covering the mock).
- **AC7 (D2 default bump):** `buildProviders` with no override produces request
  bodies carrying `max_tokens: 8192` (OpenAI/Anthropic) / `maxOutputTokens: 8192`
  (Gemini); with a `providers.<name>.maxTokens` override the override wins
  (regression pin). Updates `test/provider-max-tokens.test.ts` and
  `test/openai.test.ts` accordingly. RED before D2.
- **AC8 (gates + kernel ceiling):** `npm test` exits 0 (all prior tests still pass,
  plus new tests green); `npm run typecheck`, `npm run typecheck:test`, `npm run
  build` exit 0; `npm run eval` 5/5; `test/kernel-surface.test.ts` green with kernel
  `< 2265`. If the measured kernel count reaches 2265, **STOP and escalate** — do
  not bump the ceiling without the user (per `turn-loop-hardening` AC7).

## 8. Risks and Rollback

- **R1 — D3 kernel line budget.** Estimated +1–2 lines against **5** of headroom
  (measured 2260 / ceiling 2265); D3 ships as a bare field with no comment block. If
  the measured count reaches 2265, STOP and escalate (do not bump). Rollback: revert
  the `events.ts`/`agent.ts` hunk (the `message` event loses `stopReason`; D4 loses
  its signal and must also be reverted/disabled). Independent of D1/D2.
- **R2 — D1 warning noise or a mis-warned reason.** Mitigated by the tight warn-set
  `{max_tokens, content_filter, refusal}` (KDD1) and the once-per-run `agent_end`
  firing. Rollback: remove the `agent_end` handler (render-only, no behavior
  coupling).
- **R3 — D4 auto-continue loops or over-spends.** Mitigated by: ships **off** by
  default; a hard cap of 3 per acting agent per top-level run (reset on
  `agent_start`); exclusion of the tool-call case; and `maxTurns` (24) as a backstop. Worst case when enabled: 3 extra turns of tokens,
  then D1 surfaces the truncation. Rollback: `EAGENT_AUTOCONTINUE=off`, or delete
  the extension + its `BUILTIN_EXTENSIONS` line.
- **R4 — D2 raises per-request cost/latency ceiling.** 8192 is a modest doubling;
  it is a *ceiling*, not a target (models still stop at `end_turn` naturally), so
  typical cost is unchanged. Operators wanting the old behavior set
  `*_MAX_TOKENS=4096`. Rollback: revert the number (host + constructors + pinned
  tests).
- **R5 — early-stream-close truncation (residual, out of scope).** An
  OpenAI-compatible gateway that closes the SSE stream mid-response with **no**
  finish reason yields `end_turn` (default `stopReason`), which D1 does not warn on
  and D4 does not resume — indistinguishable from a real completion at the loop
  level. Documented as a known residual; the `watchdog` extension bounds a fully
  *stalled* stream, but not a clean early close. Not addressed here.
- **R6 — provider-done `stop` collapse (residual, out of scope to fix here).** The
  three provider mappers fold any unrecognized finish reason to `default → "stop"`
  (`openai.ts:263`, `anthropic.ts:341`, `gemini.ts:251`); on a no-tool-call turn this
  becomes `reason="stop"` at `agent_end` (`agent.ts:274`), indistinguishable from the
  internal abort/terminate/maxTurns `stop`. So an exotic terminal reason (e.g. the
  Gemini finish reasons that fall through the `default` arm — BLOCKLIST,
  PROHIBITED_CONTENT, SPII, OTHER — as opposed to SAFETY/RECITATION, which DO map to
  `content_filter` at `gemini.ts:249-250` and so ARE warned) ends the REPL with no D1
  warning and no other signal. Distinct
  from R5 (a *no-finish-reason* early close → `end_turn`). A clean fix needs an honest
  provider-side terminal reason for those cases, or a way to distinguish provider-done
  `stop` from internal `stop` at `agent_end` — a provider/kernel change out of scope
  for this CLI-visibility fix; recorded as a named follow-up. The reported bug
  (`max_tokens`) is fully covered.
- **Overall rollback:** D1 (cli-only), D2 (host+providers+tests), D3+D4+D5
  (kernel-seam + extension + mock) are independently revertible. Branch
  `chore/silent-truncation-fix`, PR-gated to `init`, not merged without review.
