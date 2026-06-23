# Design: `drift-probe` — canary reasoning-quality probe as a leading degradation indicator

Slug: `2026-06-22-drift-probe`
Status: closed
Closing-commit: 186f0dd
Closed-on: 2026-06-22
Deferred: finding — stale AC wording on the probe-discriminator test mechanism (cosmetic; code+tests consistent)

## 1. Background and Purpose

Long agent sessions silently degrade as context accumulates. The model forgets
a safety rule stated at turn 0, stops self-verifying, skips confirmations, or
quietly loses a load-bearing fact buried under a megabyte of tool output. The
only signal EAgent surfaces today for this decay is the **final answer** — and
final-answer accuracy is a **lagging** indicator: by the time a wrong answer
lands, the reasoning was already degraded for some unknown number of prior
turns.

EAgent has three extensions that manage context **size**, and not one of them
measures reasoning **quality**:

- `prune` (`prune.ts:50-82`) truncates the *bytes* of old, oversized
  `tool_result` blocks on `transformContext` — a provider-free size trim.
- `compact` (`compact.ts:244-274`) folds the older transcript prefix into a
  structured summary when an estimated **token** budget is crossed.
- `limits` (`limits.ts`) caps single-output bytes and per-run tool-call/token
  budgets; `microagents` re-injects knowledge; none of these read the model's
  reasoning at all.

Size is the *cause* of pressure; degraded reasoning is the *consequence*. The
missing instrument is a **leading** indicator of that consequence: a fixed
"canary" question with a known-good answer, re-issued every N turns and scored
against a turn-0 baseline. When the canary score regresses, reasoning quality is
measurably slipping **before** the user's real task produces a wrong answer, and
the agent can suggest remediation (`/compact`, `/handoff`) while it still helps.

This design adds a new, **off-by-default** `drift-probe` extension: a lifecycle
observer that counts turns, fires a recursion-safe tool-less canary sub-call
every N turns (copying `risk-guard.ts`'s sub-call pattern), scores the reply
against a turn-0 baseline, and on a sufficiently large regression emits a warning
and (optionally) a one-shot `transformContext` system note pointing at `/compact`
or `/handoff`. It never blocks.

What happens if we do not build it: context-pressure-induced quality decay
remains invisible until it manifests as a wrong final answer — the lagging
signal — with no earlier, automatable warning that the session has drifted.

## 2. Deliverables

- [x] `src/extensions/drift-probe.ts` — a `turn_start`/`turn_end` observer that,
      every N turns, fires a recursion-safe tool-less provider sub-call on a
      pinned canary question, scores the reply against a turn-0 baseline, and on
      `>= X%` regression emits a warning (`e.log.warn` + `e.agent.ui.notify`) and
      arms a one-shot `transformContext` system note.
- [x] Pure, directly-unit-testable helpers: `scoreProbe(reply, expected)` and
      `isRegression(baseline, current, thresholdPct)` (no model call, no I/O),
      plus an exported `PROBE_POOL` and `pickProbe(index)` rotation.
- [x] A `/drift-probe` command: `on | off | status` (and `status` prints
      cadence N, threshold X%, the turn-0 baseline score, and the last probe
      score).
- [x] Off-by-default gating: disabled unless explicitly enabled, plus an
      `EAGENT_DRIFT_PROBE=off` hard kill switch (mirrors `risk-guard`/`compact`).
- [x] No new capability declared (it performs no filesystem/network side effect;
      Decision 4.7).
- [x] A dispose loop over every registration (`offTurn`, `offNote`, `offCmd`)
      that never throws (mirrors `risk-guard.ts:186-194`).
- [x] `test/drift-probe.test.ts` — offline `node:test` suite against a scripted
      `MockProvider` that serves **both** the main turns and the canary
      sub-call: probe-fires-every-N, warn-on-regression, no-warn-on-steady-good,
      off-by-default / kill-switch, fail-open, one-shot note, registration delta,
      command, and the pure scorers. Loads the extension via
      `host.use("drift-probe", activate)` (the `test/recovery.test.ts:118-119`
      pattern); does **not** depend on `BUILTIN_EXTENSIONS`.
- [x] `host.ts` registration in `BUILTIN_EXTENSIONS` — **(deferred to batch
      integration)**.
- [x] `CLAUDE.md` / `README` inventory line — **(deferred to batch
      integration)**; reconciled at closeout. (Does not bump the README
      extension count in this change.)

## 3. Scope Boundary (NOT in scope — Simplicity First)

- **Not a benchmark/eval harness.** It scores a single rotating canary, not a
  test suite. (`evals.ts` is the suite runner; this is one in-flight pulse.)
- **No multi-dimensional rubric or LLM-judge scoring.** Scoring is a small,
  offline-deterministic combination of exact-match / key-token presence /
  self-verification-phrase count (Decision 4.2). No second model call judges the
  probe answer.
- **Never blocks, rewrites, or vetoes.** It only observes, warns, and optionally
  injects one advisory system note (Decision 4.6). It registers **no**
  `beforeToolCall`/`afterToolCall` filter — drift is not a per-call property.
- **Does not remediate.** It *points at* `/compact` and `/handoff`; it does not
  trigger compaction or a handoff itself (Decision 4.6, §6 dedup).
- **No persistence across processes.** The turn counter, turn-0 baseline, and
  one-shot note flag live in `e.store` (per-session/in-memory in tests); no disk
  state, no cross-run history database.
- **No adaptive cadence or auto-tuning N/X.** Cadence and threshold are fixed
  defaults, store-overridable via the command. No statistical model, no EWMA.
- **Not on by default.** Each probe is an extra paid model call, so it ships
  disabled (Decision 4.7), exactly like `risk-guard`/`compact`.
- **No new kernel event.** `KernelEvents` is a closed type
  (`events.ts:11-38`); "emit a warning event" is realized as
  `e.log.warn` + `e.agent.ui.notify` (the observable channels every guard uses),
  not a bespoke event.

## 4. Key Design Decisions

### 4.1 Probe cadence — every N turns vs every M tokens

- **Problem**: how often does the canary fire? Too often multiplies cost; too
  rarely misses the drift window.
- **Options**:
  1. Every **N turns** (count `turn_start` emissions across the session).
  2. Every **M accumulated tokens** (sum the `usage` event like
     `limits.ts:206-208` does, fire when a token delta is crossed).
  3. Both (whichever trips first).
- **Choice**: option 1 — **every N turns**, default **N = 8**. Maintain a
  module-scoped counter incremented on `turn_start` (`agent.ts:174`); when
  `counter % N === 0`, fire the probe. The turn counter accumulates **across
  `agent.run` calls** (it is *not* reset on `agent_start`, unlike
  `limits.ts:200-203`), because a "long session" is many runs, and drift is a
  session-level property.
- **Rationale**: A turn is the natural, model-legible unit of conversational
  progress and is **one integer compare** — the simplest possible threshold
  (Simplicity First). N = 8 is deliberately **sparse**: it bounds added cost to
  roughly one extra model call per 8 turns (~12% call overhead in the worst case,
  far less in practice since probes are short), which is cheap enough to leave a
  user's eyes-off run instrumented without a noticeable bill. Option 2 (tokens)
  is a strictly *better* proxy for *context pressure* — but it needs the `usage`
  accumulator *and* a "tokens since last probe" delta, and the whole point of the
  probe is that pressure is already measured by `compact`/`limits`; what is
  *unmeasured* is the *consequence*, and the consequence shows up per *turn* of
  reasoning. Tokens would also fire erratically (one giant tool dump can cross M
  in a single turn, probing the same reasoning state twice). Option 3 doubles the
  config surface and the firing logic for no clear gain. Turns win on simplicity
  and even cadence; rejected token/both for added state and uneven, sometimes
  redundant firing.

### 4.2 Scoring — exact-match vs key-token vs self-verification-phrase count

- **Problem**: how to turn a free-form canary reply into a number comparable to a
  turn-0 baseline, *offline-deterministically* (so a scripted `MockProvider`
  answer yields a known score in tests)?
- **Options**:
  1. **Exact-match** only (reply equals the known-good answer).
  2. **Key-token presence** only (fraction of a small expected-token set present,
     whole-word, case-insensitive — the `microagents.ts` whole-word idiom).
  3. **Self-verification-phrase count** only (how many "let me check / verifying /
     to be sure" cues the reply contains — a proxy for retained rigor).
  4. A **robust weighted combination** of (1)+(2)+(3).
- **Choice**: option 4 — a robust combination. `scoreProbe(reply, expected)`
  returns a number in `[0, 1]` =
  `0.5 * keyTokenFraction + 0.3 * exactMatch + 0.2 * min(verifyCueCount, cap)/cap`,
  where each probe in the pool carries its own `expectedTokens[]`,
  `exactAnswer?`, and the verify-cue list is a fixed shared constant. Pure and
  synchronous — no model call, no I/O — so a scripted reply maps to an exact
  number.
- **Rationale**: Each single signal is brittle. Exact-match alone (option 1) is
  too strict — a correct answer phrased differently scores 0 and floods false
  regressions. Key-token alone (option 2) misses *reasoning*-quality decay where
  the right tokens still appear but the rigor is gone. Verify-cue count alone
  (option 3) is the noisiest (it rewards verbosity). The weighted blend leans
  hardest on key-token presence (the most robust correctness proxy, weight 0.5),
  uses exact-match as a clean bonus (0.3), and folds in verify-cues as the
  reasoning-rigor tie-breaker (0.2) capped so a chatty answer can't game it. The
  blend is *offline-deterministic*: every term is a string operation, so the test
  scripts a strong baseline answer (score ~1.0) and a degraded answer (missing
  key tokens, no cues → score well below it) and asserts the exact regression
  delta. Weights are a tuned constant, not behavioral branching, and are
  documented inline so retuning is a conscious edit. Rejected single-signal
  options for brittleness/noise individually; combination is robust *and* still
  fully scriptable.

### 4.3 The sub-call — recursion-safe tool-less vs a subagent

- **Problem**: how is the canary actually asked of the model?
- **Options**:
  1. A **recursion-safe tool-less provider sub-call** (the `risk-guard.ts`
     pattern): `provider.stream({ systemPrompt, messages:[probe], tools: [], … })`.
  2. A **subagent** (`subagents.ts`) — spin a child agent to answer the canary.
- **Choice**: option 1 — the tool-less provider sub-call, copied verbatim in
  shape from `risk-guard.ts:96-137` (also `compact.ts:184-202`,
  `memory.ts:78-93`): fetch `e.agent.providers.get()`, stream a one-message
  request with `tools: []`, `model: e.agent.model`, a fresh
  `new AbortController().signal`, read the `done` event's assistant text.
- **Rationale**: The probe must measure the **model's current reasoning under the
  accumulated context**, asked in a *controlled, isolated* way that cannot
  perturb the live transcript or recurse. Passing `tools: []` is the exact
  recursion-safety mechanism the three sibling extensions rely on: the sub-call
  emits no tool call, so it never re-enters `beforeToolCall`, and — critically —
  it runs **outside** `agent.run`, so it emits **no** `turn_start`, meaning the
  probe cannot increment its own turn counter and trigger itself (the recursion
  hazard specific to a turn-counting observer). A subagent (option 2) is far
  heavier: it carries its own loop, tools, and capability surface, would itself
  emit `turn_start` events (re-entering the counter), and is the wrong tool for a
  single bounded question. The canary is deliberately context-bearing or
  context-free per Decision 4.5; the sub-call lets us control exactly what context
  the probe sees. Rejected the subagent for weight, capability surface, and the
  self-triggering re-entrancy it would introduce.

### 4.4 Regression threshold X% — how big a drop warns

- **Problem**: a single probe is noisy; how large a drop below baseline counts as
  "drift" rather than phrasing variance?
- **Options**:
  1. A **low** threshold (e.g. any drop, or `>= 5%`) — maximally sensitive.
  2. A **conservative** threshold (default **X = 25%**) — warn only on a clear,
     large regression.
  3. Require **two consecutive** regressed probes before warning.
- **Choice**: option 2 — conservative, default **X = 25%**, measured **against
  the turn-0 baseline**: warn iff `current <= baseline * (1 - X/100)`. The turn-0
  baseline is computed once, on the first probe of the session (the earliest,
  least-degraded reasoning state), and stored in `e.store`.
- **Rationale**: A free-form-answer score *will* jitter turn to turn from
  phrasing alone; a low threshold (option 1) turns that jitter into a stream of
  false warnings, and a warning that cries wolf is worse than none (the
  `limits.ts:14-17` "a guardrail that crashes the run it guards is worse than no
  guardrail" ethos, applied to noise). 25% is large enough that ordinary
  rewording rarely crosses it but real decay — a dropped key token plus lost
  verify-cues — clears it comfortably with the 4.2 weights. Pairing the drop with
  the **turn-0 baseline** (not the previous probe) anchors "drift" to the
  session's best-known reasoning, exactly the leading-indicator framing. Option 3
  (two-in-a-row) halves false positives further but doubles the latency to first
  warning and adds consecutive-state tracking — deferred as a future tightening,
  noted here so it is a conscious later choice; the warn-once behavior (4.6)
  already curbs repeat noise. Rejected low threshold for false-warning floods;
  rejected two-consecutive for added state and delayed warning. X is a tuned
  threshold constant, documented inline.

### 4.5 Probe-pool rotation — so the canary can't be cued/memorized

- **Problem**: a *single* fixed canary, repeated verbatim every N turns, sits in
  the transcript and can be cued (the model pattern-matches the recurring
  question and parrots its own earlier answer), defeating the measurement.
- **Options**:
  1. **One** fixed canary forever.
  2. A **small fixed pool** of probes, rotated deterministically by probe index.
  3. A **model-generated** fresh probe each time.
- **Choice**: option 2 — a small fixed `PROBE_POOL` (a handful of pinned
  questions, each with its own `expectedTokens`/`exactAnswer`), rotated by
  `pickProbe(probeCount)` = `PROBE_POOL[probeCount % PROBE_POOL.length]`. Each
  probe is asked with **no prior transcript** in the sub-call messages (Decision
  4.3 controls the context), so a probe's own past answer is not in front of it.
- **Rationale**: Rotation means no single question repeats often enough to be
  parroted, and asking the probe with a clean message list keeps its earlier
  answer out of view — both close the cueing/memorization hole option 1 leaves
  open. A fixed pool keeps scoring deterministic and offline-testable (each probe
  ships its own known-good expected set, so a scripted reply has a known score).
  Option 3 (model-generated probes) cannot have a *known-good baseline* — you
  cannot score an answer against a question the extension didn't author — and
  adds a second model call per probe; it breaks both determinism and the
  baseline. Rejected single-canary for cueing; rejected model-generated for
  un-scoreability and cost. The pool *content* is a string/format constant (the
  questions and their expected tokens) and self-justifies as non-behavioral; the
  *rotation* and *baseline* are the behavioral decisions argued above.

### 4.6 On regression — warn + an optional one-shot `transformContext` note, never block

- **Problem**: what does a regression *do*?
- **Options**:
  1. **Warn only** (`e.log.warn` + `e.agent.ui.notify`).
  2. Warn **plus** inject a one-shot `transformContext` system note suggesting
     `/compact` or `/handoff`.
  3. **Act** — automatically trigger compaction / handoff.
- **Choice**: option 2 — on the first regression, log a warning, notify the UI,
  and **arm a one-shot flag**; the `transformContext` hook
  (`events.ts:48-53`), on the *next* turn only, prepends one short
  `meta.kind:"drift-note"` system message ("reasoning-quality drift detected;
  consider `/compact` or `/handoff`"), then disarms the flag. The note is
  optional via config (`noteOnRegression`, default on) and is emitted **at most
  once per regression event** (warn-once). It **never** blocks.
- **Rationale**: A leading indicator's job is to *inform a decision*, not make it.
  Warning makes the drift observable on the channels every guard uses; the
  one-shot note carries that signal *into the model's own context* so the model
  can self-correct or surface the remediation to the user — but bounded to a
  single small message so the nudge does not itself add the very context pressure
  it warns about (the §8 over-firing risk). Option 1 alone keeps the signal out of
  the model's view (the user might miss the console line). Option 3 (auto-act)
  crosses from *measuring* to *remediating* and would duplicate
  `compact`/`handoff`, which already own those actions and have their own gates —
  a layering violation and a surprising, possibly destructive auto-behavior.
  Rejected warn-only for keeping the signal out of context; rejected auto-act for
  overreach and duplication. The note is injected via `transformContext` returning
  a NEW array (never mutating the durable transcript), the same contract
  `prune`/`compact` hold (`prune.ts:75-81`, `compact.ts:272-273`).

### 4.7 Default state, capability, and recursion safety

- **Problem**: on by default? Does it need a capability? Can the probe recurse?
- **Choice**: **off by default** — enabled via `/drift-probe on` (store flag),
  hard-disabled by `EAGENT_DRIFT_PROBE=off` regardless of the flag (read inside
  the handler, `risk-guard.ts:80-81` pattern). **No capability** declared. The
  sub-call passes `tools: []` and runs outside the loop, so it emits no
  `turn_start` and cannot self-trigger or re-enter any filter.
- **Rationale**: Every always-on EAgent extension is provider-free; `drift-probe`
  makes a **paid, latency-adding model call** per probe, so — exactly like
  `risk-guard` (`risk-guard.ts:18`) and `compact` (`compact.ts:26-28`) — it ships
  off and opts in explicitly; least-surprise on cost. It performs no
  filesystem/network side effect of its own (it reads tool/transcript metadata,
  calls the model read-only, calls `ui.notify`/`e.log.warn`, and returns a new
  message array on `transformContext`), so it declares no capability — the same
  privilege profile as `memory`/`compact`/`risk-guard`, all capability-free. The
  options here are binary (on/off, capability/none) and the chosen sides are
  argued against their alternatives above (against on-by-default: surprising cost;
  against a capability: no side effect to gate), satisfying the
  no-single-option-behavioral-decision rule.

## 5. Dependencies and Assumptions

- Kernel `turn_start` event (`events.ts:22`, emitted `agent.ts:174`) for the turn
  counter; `transformContext` filter (`events.ts:48-53`, applied
  `agent.ts:247-251`) for the one-shot note. No new event/filter is added.
- `ExtensionAPI`: `e.on`, `e.hook`, `e.registerCommand`, `e.store`
  (`store.ts:13-16` get/set/keys), `e.log`, `e.agent.providers.get`,
  `e.agent.model`, `e.agent.ui.notify` (`types.ts:229-230`). No `registerTool`,
  no `grantCapability`.
- The recursion-safe tool-less sub-call shape from `risk-guard.ts:96-137`
  (`provider.stream({ systemPrompt, messages, tools: [], model, signal })`, read
  the `done` event's message text via a `textOf` helper — `risk-guard.ts:70-76`).
- The turn counter must accumulate across `agent.run` calls (unlike
  `limits.ts:200-203`'s per-run reset); it lives in module scope per activation
  (and/or `e.store`) and resets only on dispose/reload.
- `MockProvider` is scriptable and deterministic (`mock.ts:38-109`); its function
  responder form `(req, turnIndex) => MockTurn` (`mock.ts:36`,
  `mock.ts:103-108`) lets a test branch on `req.systemPrompt` /
  `req.tools.length === 0` to serve the canary sub-call distinctly from the main
  turns. The suite stays offline, no API key (the house rule).
- The scorer's determinism: a given `(reply, expected)` always yields the same
  number, so a scripted reply has a known, asserted score.
- No new npm dependency (jiti-only rule holds); Node built-ins only if any are
  needed (none are expected — pure string ops).

## 6. Relationship with Existing Designs

**First design of a reasoning-*quality* probe in EAgent** — no existing extension
measures the model's reasoning; all prior context extensions measure or manage
*size*. Closest relatives, and why this does not duplicate them:

- `src/extensions/risk-guard.ts` — the **structural template**: the
  recursion-safe, tool-less, fail-open provider sub-call
  (`risk-guard.ts:96-137`), the off-by-default + `EAGENT_*=off` posture
  (`risk-guard.ts:80-81`), the `textOf` reader (`risk-guard.ts:70-76`), and the
  command/dispose shape (`risk-guard.ts:157-194`) are reused verbatim in *form*.
  Different in *purpose*: `risk-guard` judges the *safety of one tool call* on
  `beforeToolCall`; `drift-probe` judges *reasoning quality over the session* on a
  lifecycle observer. No seam overlap, no conflict.
- `src/extensions/prune.ts` and `src/extensions/limits.ts` — manage context
  **size** (byte/token trims and per-run budgets, `prune.ts:50-82`,
  `limits.ts`). `drift-probe` measures the **consequence** of size pressure —
  reasoning quality — which neither reads. The turn/token counters
  (`limits.ts:200-208`) are the *technique* `drift-probe` borrows for its turn
  counter; the *measurement* is new.
- `src/extensions/compact.ts` and the `/handoff` remediation — `compact` *reacts*
  to a token threshold by folding context (`compact.ts:244-274`); the handoff
  hands the session off. `drift-probe` is the **leading indicator** that *points
  at* these remediations (Decision 4.6) instead of duplicating them: it never
  compacts or hands off, it only signals when doing so is warranted. The note's
  `meta.kind:"drift-note"` is a distinct marker; it does **not** reuse or collide
  with `compact`'s `meta.kind:"summary"` (`compact.ts:228-231`) that `prune`
  stops at (`prune.ts:61`).
- `src/extensions/microagents.ts` — supplies the whole-word, case-insensitive
  token-presence idiom reused in `scoreProbe`'s key-token term (Decision 4.2);
  different trigger (keyword injection vs quality probe), no conflict.
- `src/extensions/evals.ts` — runs a *suite* of scored cases as an explicit
  command; `drift-probe` is the always-running, single-pulse, in-flight analogue,
  not a suite runner (§3 non-goal). No overlap.

**Conflicts**: none. New, parallel, observer-only extension; supersedes no prior
design. Terminology anchors: CLAUDE.md "Architecture" (the seven primitives, the
hook surface) and the `risk-guard` design's sub-call/off-by-default vocabulary.

## 7. Acceptance Criteria

All verified offline by `npm test` against a scripted `MockProvider` (no network,
no API key). Each is a runnable assertion in `test/drift-probe.test.ts` unless it
is the typecheck gate. The extension is loaded via
`host.use("drift-probe", activate)` and exercised through `h.agent.run(...)`; the
responder distinguishes the canary sub-call from main turns by `req.systemPrompt`
(the probe prompt) and `req.tools.length === 0`.

1. **Pure scorer — baseline vs regressed**: `scoreProbe(reply, expected)` returns
   a number in `[0,1]`; a reply containing all `expectedTokens` (and exact answer,
   with verify-cues) scores `>= 0.9`; a reply missing the key tokens and cues
   scores `<= 0.4`. Asserted on two literal strings — exact numbers, no model
   call.
2. **Pure regression rule**: `isRegression(baseline, current, X)` returns `true`
   iff `current <= baseline * (1 - X/100)`; assert `isRegression(1.0, 0.7, 25)`
   is `true` and `isRegression(1.0, 0.8, 25)` is `false` (boundary at 25%).
3. **Probe fires every N turns**: with the extension enabled and `N` set small
   (e.g. 2) via the command/store, run enough turns that the turn counter crosses
   N twice; assert the canary sub-call (identified by `req.systemPrompt`/`tools:
   []`) was invoked exactly twice, on the expected turn indices. (A call counter
   incremented in the responder.)
4. **Warn on regression**: script a strong baseline canary answer on the first
   probe and a degraded answer on the second; assert a warning fires after the
   second probe — captured via a custom `logger.warn` spy (the harness accepts a
   `logger`, `helpers.ts:28`) **and/or** a `ui.notify` spy — and that its text
   names "drift".
5. **No warn on steady-good**: script the *same* strong answer for every probe;
   assert **zero** warnings and **zero** notifies fire across multiple probes.
6. **One-shot note, then disarmed**: after a regression, assert exactly **one**
   system message with `meta.kind === "drift-note"` is injected into the context
   the model sees on the *next* turn (inspect the `transformContext` output or the
   provider's received `messages`), and that a subsequent non-regressing turn
   injects **no** further note (the flag disarms).
7. **Note never blocks / never mutates the transcript**: `agent.run` completes
   normally with the note armed, and `h.agent.messages` (the durable transcript)
   contains **no** `drift-note` message — the note exists only in the transformed
   context array (the `prune.ts:75-81` non-mutation contract).
8. **Off by default**: without enabling, run several turns past N; assert the
   canary sub-call is **never** invoked (call counter 0) and no warning fires.
9. **Kill switch**: with `EAGENT_DRIFT_PROBE=off` (saved/restored in `finally`)
   and the extension *enabled*, run past N; assert **no** sub-call and **no**
   warning.
10. **Fail open**: enabled, but the probe sub-call throws / yields an empty reply
    (a stub provider, or the responder returns no probe turn); assert `agent.run`
    completes, no exception escapes, no warning fires from a missing score, and a
    `e.log.warn` records the degraded probe (no baseline established → no
    regression). The session is never bricked.
11. **No self-trigger / no recursion**: assert the probe sub-call does **not**
    itself increment the turn counter (the canary count equals
    `floor(turns / N)`, not more) — i.e. the tool-less sub-call emitted no
    `turn_start`. Verified by the exact call-count equality in criterion 3.
12. **Registration delta**: activating the extension adds exactly **one**
    `turn_start` listener, **one** `transformContext` listener, **one** command,
    and **zero** tools (delta assertions in the style of `prune.test.ts`'s
    listener-count checks); disposing/unloading removes all of them (a subsequent
    run fires no probe — the `recovery.test.ts:173-192` teardown pattern).
13. **Command**: `/drift-probe on|off` toggles the stored flag; `status` prints
    cadence N, threshold X, the turn-0 baseline, and the last score without
    throwing on any subcommand; a probe fires only after `on`.
14. **Quality gate**: `npm run typecheck` exits 0 and the full `npm test` exits 0
    (`# fail 0`, 0 skipped) with the new suite included.

## 8. Risks and Rollback

- **Risk: extra model calls cost money/latency.** *Mitigation*: sparse cadence
  (N = 8, Decision 4.1), **off by default** (4.7), the `EAGENT_DRIFT_PROBE=off`
  absolute override, and a short pinned probe. Offline-testable by scripting the
  `MockProvider` canary answer, so CI pays nothing.
- **Risk: scoring a free-form answer for "regression" is heuristic and noisy.**
  *Mitigation*: the robust 3-signal blend (4.2), the **conservative 25%**
  threshold against the **turn-0 baseline** (4.4), the rotating probe pool (4.5),
  and **warn-only / never-block** (4.6). Acknowledged as a heuristic, not a
  correctness claim — a false warning costs one ignorable nudge, never a blocked
  task.
- **Risk: the regression nudge itself adds context, worsening the pressure it
  warns about.** *Mitigation*: the note is **one small system message, injected at
  most once per regression** (warn-once, 4.6), and is `transformContext`-only —
  it never enters the durable transcript (criterion 7), so it does not compound
  turn over turn.
- **Risk: the probe self-triggers (a turn-counting observer that fires a call
  that counts as a turn).** *Mitigation*: the sub-call passes `tools: []` and runs
  outside `agent.run`, so it emits no `turn_start` and cannot increment its own
  counter or re-enter any filter (4.3/4.7, criterion 11) — the same recursion
  safety `risk-guard`/`compact`/`memory` rely on.
- **Risk: probe cueing/memorization defeats the measurement.** *Mitigation*: the
  rotating pool plus asking each probe with no prior transcript (4.5).
- **Risk: a probe failure bricks the run.** *Mitigation*: the sub-call is wrapped
  to fail **open** with `e.log.warn` (criterion 10), mirroring
  `risk-guard.ts:134-136`; a probe that can't be scored simply doesn't warn.
- **Rollback**: a single self-contained extension plus one deferred
  `BUILTIN_EXTENSIONS` line. `/drift-probe off`, `EAGENT_DRIFT_PROBE=off`,
  removing the (deferred) registration line, or deleting
  `src/extensions/drift-probe.ts` + its test disables/removes it with zero effect
  on other extensions. No capability, no schema/storage/protocol change, no
  durable transcript mutation.
