# Implementation: `drift-probe` — canary reasoning-quality probe as a leading degradation indicator

Slug: `2026-06-22-drift-probe`
Design: [`docs/design/2026-06-22-drift-probe.md`](../design/2026-06-22-drift-probe.md) (Status: PASSED)
Audience: a fresh agent implementing this extension by TDD, from the repo root.

This guide carries **no requirement absent from the design**. Every task traces
to a design Deliverable (Status: closed
Closing-commit: a531f5b
Closed-on: 2026-06-22
Deferred: finding — stale AC wording on the probe-discriminator test mechanism (cosmetic; code+tests consistent)2) and an Acceptance Criterion (§7), cited inline as
`D#` / `AC#`. When this guide and the design disagree, the design wins.

> **BATCH MODE (binding).** Touch only:
> `src/extensions/drift-probe.ts`, `test/drift-probe.test.ts`, and this file.
> Do **NOT** modify `src/host.ts`, `CLAUDE.md`, or `README.md`. `BUILTIN_EXTENSIONS`
> registration (D11) and the `CLAUDE.md`/`README` inventory line (D12) are
> **deferred to a separate batch-integration step** — they are already marked
> "(deferred to batch integration)" in the design. Do **not** bump the README
> extension count. The test loads the extension directly via
> `host.use("drift-probe", activate)` (the `test/recovery.test.ts:118-119`
> pattern) and must **not** depend on the extension being in `BUILTIN_EXTENSIONS`.

---

## 1. Task Index — design → phase tasks

| Design item | What it requires | Phase task(s) |
| ----------- | ---------------- | ------------- |
| **D1** | `turn_start` observer; every-N-turns recursion-safe tool-less canary sub-call; turn-0 baseline; `>= X%` regression → `e.log.warn` + `e.agent.ui.notify`; arm one-shot `transformContext` note | T7, T9, T11, T13, T15, T17 |
| **D2** | Pure helpers `scoreProbe(reply, expected)`, `isRegression(baseline, current, thresholdPct)`; exported `PROBE_POOL` + `pickProbe(index)` | T1–T4 |
| **D3** | `/drift-probe` command `on \| off \| status` (status prints N, X%, turn-0 baseline, last score) | T19 |
| **D4** | Off by default + `EAGENT_DRIFT_PROBE=off` hard kill switch | T5 (config), T13, T15 |
| **D5** | No new capability declared | T21 (asserted in registration delta) |
| **D6** | Dispose loop over every registration (`offTurn`, `offNote`, `offCmd`) that never throws | T21 |
| **D7** | `test/drift-probe.test.ts` offline suite vs scripted `MockProvider`; loads via `host.use`; no `BUILTIN_EXTENSIONS` dependency | all T-tasks |
| **D11** | `host.ts` `BUILTIN_EXTENSIONS` registration | **(deferred to batch integration — do NOT do here)** |
| **D12** | `CLAUDE.md` / `README` inventory line | **(deferred to batch integration — do NOT do here)** |
| **AC1** | Pure scorer: all tokens → `>= 0.9`; missing tokens+cues → `<= 0.4` | T1 |
| **AC2** | `isRegression` boundary at 25%: `(1.0,0.7,25)→true`, `(1.0,0.8,25)→false` | T3 |
| **AC3** | Probe fires exactly every N turns, on expected turn indices | T11 |
| **AC4** | Warn on regression (logger.warn / ui.notify spy, text names "drift") | T13 |
| **AC5** | No warn on steady-good (zero warnings, zero notifies) | T15 |
| **AC6** | One-shot note injected next turn, then disarmed | T17 |
| **AC7** | Note never blocks / never mutates the durable transcript | T17 |
| **AC8** | Off by default: no sub-call, no warning | T7 |
| **AC9** | `EAGENT_DRIFT_PROBE=off` kill switch (saved/restored in `finally`) | T9 |
| **AC10** | Fail open: throw/empty reply → run completes, no warn, `e.log.warn` records degraded probe | T13 (no-baseline branch covered alongside warn path) |
| **AC11** | No self-trigger: canary count `== floor(turns / N)`, not more | T11 |
| **AC12** | Registration delta: +1 `turn_start`, +1 `transformContext`, +1 command, +0 tools; dispose removes all | T21 |
| **AC13** | Command `on\|off\|status` toggles flag, status prints, probe fires only after `on` | T19 |
| **AC14** | `npm run typecheck` exits 0; `npm test` exits 0 | T22 (final gate) |

There is exactly **one Phase**. It is not genuinely separable: the pure scorers
(D2) are the foundation the live regression behavior (D1) is asserted against,
and they ship in the same file with no intermediate consumer. A single TDD
ordering carries scorers → cadence → regression → note → command → registration.

---

## 2. Phase Breakdown — Phase 1: `drift-probe` extension (the whole feature)

### Entry condition

- Worktree is `/private/tmp/eagent-wt/drift-probe`, branch as provided.
- `npm test` and `npm run typecheck` are green on the untouched tree (establish
  the regression baseline — see §5). If they are not green before you start, stop
  and report; do not build on a red tree.
- The design doc has been read in full.

### Design references

- Sub-call shape (recursion-safe, tool-less, fail-open): `risk-guard.ts:96-137`,
  also `compact.ts:184-202`. Copy the **shape**, not the semantics.
- `textOf(message)` reader: `risk-guard.ts:70-76`.
- Off-by-default + `EAGENT_*=off` config: `risk-guard.ts:80-84`.
- Command + dispose loop shape: `risk-guard.ts:157-194`.
- One-shot `transformContext` note returning a NEW array + `meta.kind`:
  `compact.ts:228-274` (use `meta.kind:"drift-note"`, **not** `"summary"`).
- `turn_start` emission and `transformContext` application points: `agent.ts:174`,
  `agent.ts:247-251`.
- Whole-word, case-insensitive token presence idiom: `microagents.ts` (reused in
  `scoreProbe`'s key-token term).
- Test load pattern (`host.use` + `host.unload` teardown):
  `recovery.test.ts:118-119`, `recovery.test.ts:173-192`.
- Listener-count delta assertions: `prune.test.ts:222-233`.
- Seeding the namespaced store from inside a wrapping `activate` + a
  call-counting provider subclass: `risk-guard.test.ts:32-60`.
- `MockProvider` function responder `(req, turnIndex) => MockTurn`:
  `mock.ts:36`, `mock.ts:103-108`. Branch on `req.systemPrompt` (the probe
  prompt) and `req.tools.length === 0` to serve the canary distinctly from main
  turns.
- Harness accepts custom `logger` and `ui` for spies: `helpers.ts:25-46`.

### House facts the implementation depends on (verified against this tree)

- `e.store`: `get<T>(key, fallback)`, `set`, `delete`, `keys()` (`store.ts:12-17`).
  Store is per-extension-namespaced and in-memory under the test harness.
- `e.agent.ui.notify(message)` is the notify channel (`types.ts:227-230`); the
  harness wires it from `opts.ui`. `e.log.warn(...)` is the warn channel.
- `e.agent.providers.get()` returns the default provider; `e.agent.model` is the
  model string to pass into the sub-call.
- `text(role, body)` builds a `Message`; set `msg.meta = { source: "drift-probe",
  kind: "drift-note" }` afterward (`types.ts:87-89`, `compact.ts:228-231`).
- `transformContext` handlers receive `(messages, context)` where `context` is
  `{ turn, model }`, and must **return a new array** — never mutate the input
  (`events.ts:48-53`, `agent.ts:247-251`, contract held by `prune`/`compact`).
- The turn counter increments on `turn_start` and **accumulates across
  `agent.run` calls** — it is NOT reset on `agent_start` (Design 4.1). It lives in
  activation-module scope (and/or `e.store`); reset only on dispose/reload.
- `e.on(...)` and `e.hook(...)` and `e.registerCommand(...)` each return a
  `Disposable` with `.dispose()`.

### Task list (TDD order — every TEST task precedes the impl it protects)

> Each TEST task names the **business invariant** it protects. Write the test,
> watch it fail (the symbol/behavior does not exist yet), then write the minimal
> impl task that makes it pass. Run the per-task acceptance command after each
> impl task. All test cases live in the single `test/drift-probe.test.ts`.

---

#### T0 — scaffold (no behavior)

Create `src/extensions/drift-probe.ts` with a default-exported `activate(e:
ExtensionAPI): () => void` that registers nothing yet and returns a no-op
disposer, plus exported stubs `scoreProbe`, `isRegression`, `pickProbe`,
`PROBE_POOL` so the test file can import them. Create `test/drift-probe.test.ts`
importing them. This exists only so subsequent TEST tasks compile.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` runs (tests may
fail, but the file imports cleanly); `npm run typecheck` exits 0.

---

#### T1 — TEST: scorer maps a strong reply high and a degraded reply low

**Invariant (AC1, D2):** `scoreProbe(reply, expected)` is a pure, deterministic
map into `[0,1]`: a reply containing all `expectedTokens` (plus the exact answer
and verify-cues) scores `>= 0.9`; a reply missing the key tokens and cues scores
`<= 0.4`. This is the foundation every regression assertion stands on — if the
scorer is not deterministic, no live test can assert an exact delta.

Assert on two literal strings drawn from a real `PROBE_POOL[0]` entry (all
tokens + exact answer + a "let me verify" cue → `>= 0.9`; a string with none of
the key tokens and no cue → `<= 0.4`). No model call.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — the T1 case
fails for the right reason (stub returns wrong number).

#### T2 — IMPL: `scoreProbe` + `PROBE_POOL` shape

Implement `scoreProbe(reply, expected)` =
`0.5 * keyTokenFraction + 0.3 * exactMatch + 0.2 * min(verifyCueCount, cap)/cap`
(Design 4.2), with the weights as a documented inline constant. `keyTokenFraction`
uses the whole-word, case-insensitive idiom (`microagents.ts`). Define `PROBE_POOL`
as a small fixed array, each entry carrying `prompt`, `expectedTokens[]`, and
optional `exactAnswer`; define the shared verify-cue list and `cap` constant.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T1 passes);
`npm run typecheck` exits 0.

---

#### T3 — TEST: regression rule has a hard boundary at the threshold

**Invariant (AC2, D2/4.4):** `isRegression(baseline, current, thresholdPct)`
returns `true` iff `current <= baseline * (1 - thresholdPct/100)`. The boundary
is load-bearing: a too-loose rule cries wolf, a too-tight one never warns. Assert
`isRegression(1.0, 0.7, 25) === true` and `isRegression(1.0, 0.8, 25) === false`.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T3 fails.

#### T4 — IMPL: `isRegression` + `pickProbe`

Implement `isRegression` exactly per the inequality above. Implement
`pickProbe(index)` = `PROBE_POOL[index % PROBE_POOL.length]` (Design 4.5
rotation). Add a small TEST assertion (folded into T3's block or a sibling case)
that `pickProbe` rotates: `pickProbe(0)`, `pickProbe(PROBE_POOL.length)` are the
same entry and consecutive indices differ when `PROBE_POOL.length > 1`. This
covers the **probe-pool-rotation** invariant (Design 4.5: no single canary
repeats often enough to be parroted).

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T3 + rotation
pass); `npm run typecheck` exits 0.

---

#### T5 — IMPL: config reader (no test of its own; covered by T7/T9)

Add the `cfg()` reader mirroring `risk-guard.ts:79-84`:
`enabled = process.env.EAGENT_DRIFT_PROBE === "off" ? false : (store "enabled",
false)`; `N = store("n", 8)`; `thresholdPct = store("threshold", 25)`;
`noteOnRegression = store("noteOnRegression", true)`. Off by default (D4). No
capability declared (D5).

Acceptance: `npm run typecheck` exits 0. (Behavior asserted by T7/T9/T11.)

---

#### T6 — TEST: off by default fires no probe

**Invariant (AC8, D4):** the extension ships **off** — without `/drift-probe on`,
running past N turns triggers **no** canary sub-call and **no** warning. A paid
model call must never happen un-opted-in (least-surprise on cost).

Use a call-counting `MockProvider` (subclass that counts `stream` calls whose
`req.tools.length === 0` and whose `req.systemPrompt` is the probe prompt). Run
several turns past N; assert the probe-call count is `0` and no warn/notify fired.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T6 fails.

#### T7 — IMPL: `turn_start` observer + every-N-turns sub-call (gated)

Register `offTurn = e.on("turn_start", ...)`. Increment the module-scoped counter
(accumulating across runs — do **not** reset on `agent_start`). When
`cfg().enabled` and `counter % N === 0`, fire the recursion-safe tool-less
canary sub-call (copy `risk-guard.ts:96-137`: `e.agent.providers.get()`,
`provider.stream({ systemPrompt: <probe.prompt>, messages: [<probe as one user
msg, no prior transcript>], tools: [], model: e.agent.model, signal: new
AbortController().signal })`, read the `done` event via `textOf`). The probe to
ask is `pickProbe(probeCount)`. When disabled, do nothing (early return). Wrap the
whole sub-call to **fail open** (try/catch → `e.log.warn`, no throw escapes).

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T6 passes);
`npm run typecheck` exits 0.

---

#### T8 — TEST: kill switch overrides the enabled flag

**Invariant (AC9, D4):** `EAGENT_DRIFT_PROBE=off` hard-disables the probe even
when `enabled` is set. The absolute override must win over any stored flag.

Save/restore `process.env.EAGENT_DRIFT_PROBE` in `finally`. Set it `"off"`, enable
the extension via the store, run past N; assert probe-call count `0` and no warn.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T8 fails (then
passes once T5's `cfg()` is wired into T7's guard — if it already passes because
T5 landed, that is correct; the test still protects against a future regression).

#### T9 — IMPL: ensure the kill switch is read inside the handler

Confirm `cfg().enabled` (which reads `EAGENT_DRIFT_PROBE` live, `risk-guard.ts:80`)
is evaluated **inside** the `turn_start` handler each time, not captured at
activation. No new code if T7 already calls `cfg()` per fire; otherwise fix.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T8 passes);
`npm run typecheck` exits 0.

---

#### T10 — TEST: probe fires exactly every N turns and does not self-trigger

**Invariant (AC3 + AC11, D1/4.1/4.3):** with N set small (e.g. 2), over a run that
crosses N twice, the canary sub-call fires **exactly twice**, on the expected
turn indices — and **never more**. The exact-equality is the recursion-safety
proof: the tool-less sub-call runs outside `agent.run`, emits no `turn_start`, so
it cannot increment its own counter. Canary count must equal `floor(turns / N)`.

Enable via store (`enabled:true`, `n:2`). Script main turns + a probe responder
that increments a probe counter when `req.tools.length === 0 && req.systemPrompt
=== <probe prompt>`. Run enough turns; assert the probe counter equals the
expected `floor(turns/2)` and the firing turn indices match.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T10 fails.

#### T11 — IMPL: cadence correctness + recursion safety

Make T7's `counter % N === 0` and `pickProbe(probeCount)` advance produce the
exact cadence. Ensure the sub-call carries `tools: []` (the recursion guard) and
that `probeCount` increments only when a probe actually fires. Increment the
counter on every `turn_start`; the sub-call must not route back through
`turn_start` (guaranteed by running outside the loop with no tools).

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T10 passes);
`npm run typecheck` exits 0.

---

#### T12 — TEST: a regressed probe warns and names "drift"

**Invariant (AC4 + AC10, D1/4.4/4.6):** the **first** probe captures the turn-0
baseline; a later probe whose score regresses `>= X%` below baseline emits a
warning on `e.log.warn` **and** `e.agent.ui.notify`, and the warning text names
"drift". A degraded/empty/throwing probe that yields no score must **not** warn
spuriously and must `e.log.warn` the degraded probe instead (fail open, AC10).

Pass a custom `logger` (spy on `warn`) and `ui` (spy on `notify`) into
`makeHarness` (`helpers.ts:25-46`). Script the first probe with a strong answer
(score `~1.0`) and a later probe with a degraded answer (missing key tokens, no
cues → score `<= baseline*(1-X/100)`). Assert exactly one warn fired after the
degraded probe and its text matches `/drift/i`. Add a sibling case: a probe whose
sub-call throws (a stub provider) → `agent.run` completes, no regression warn,
one `e.log.warn` recording the degraded probe.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T12 fails.

#### T13 — IMPL: baseline capture + regression scoring + warn (fail open)

On each fired probe: read the reply via `textOf`, compute
`score = scoreProbe(reply, probe.expected)`. If the sub-call failed or the reply
is empty (no score), `e.log.warn` the degraded probe and **return without
warning** (no baseline established → no regression; AC10). On the first scored
probe of the session, store it as the turn-0 baseline (`e.store`). On a later
scored probe, if `isRegression(baseline, score, thresholdPct)`, then
`e.log.warn("drift-probe: reasoning-quality drift detected ...")` and
`e.agent.ui.notify(...)` (both name "drift"), and **arm the one-shot note flag**.
Store the last score. Never throw, never block.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T12 passes);
`npm run typecheck` exits 0.

---

#### T14 — TEST: steady-good never warns

**Invariant (AC5, D4.4):** scoring the **same** strong answer for every probe
produces **zero** warnings and **zero** notifies across multiple probes — ordinary
phrasing variance must not cross the conservative threshold. A guard that cries
wolf is worse than none.

Enable with small N; script the identical strong answer for every probe; run
across multiple probe fires; assert warn-spy count `0` and notify-spy count `0`.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T14 fails or
passes; if it passes already (no spurious warn path), keep it as a regression
guard. If it fails, the threshold/baseline logic in T13 is wrong — fix T13.

#### T15 — IMPL: confirm steady-good is silent

No new behavior expected beyond T13; if T14 fails, the bug is a baseline/threshold
error in T13 (e.g. comparing against the previous probe instead of turn-0
baseline). Fix in `drift-probe.ts`.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T14 passes);
`npm run typecheck` exits 0.

---

#### T16 — TEST: the one-shot note is injected once, then disarmed, and never enters the transcript

**Invariant (AC6 + AC7, D1/4.6):** after a regression, the **next** turn's
`transformContext` output contains exactly **one** system message with
`meta.kind === "drift-note"`; the flag then disarms so a subsequent non-regressing
turn injects **none**. The note lives **only** in the transformed context array —
`h.agent.messages` (the durable transcript) contains **no** `drift-note` message
(the `prune.ts:75-81` non-mutation contract), and `agent.run` completes normally
with the note armed (never blocks).

Inspect the provider's received `messages` (the canary sub-call sees a clean
list; the **main** turn after a regression sees the note prepended) or apply
`transformContext` and count `drift-note` messages. Assert: exactly one
`drift-note` on the post-regression turn; zero on the following non-regressing
turn; zero `drift-note` in `h.agent.messages`.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T16 fails.

#### T17 — IMPL: `transformContext` one-shot note

Register `offNote = e.hook("transformContext", (messages, _ctx) => { ... })`.
When `cfg().noteOnRegression` and the armed flag is set: **disarm it**, and return
a NEW array `[noteMessage, ...messages]` where `noteMessage = text("system",
"reasoning-quality drift detected; consider /compact or /handoff")` with
`meta = { source: "drift-probe", kind: "drift-note" }`. Otherwise return
`messages` unchanged. Never mutate the input array (return a new reference only
when prepending). The note never enters `this.#messages` because
`transformContext` runs over a fresh copy (`agent.ts:247-251`).

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T16 passes);
`npm run typecheck` exits 0.

---

#### T18 — TEST: the `/drift-probe` command toggles, reports, and gates firing

**Invariant (AC13, D3):** `/drift-probe on` sets the stored flag, `off` clears it,
`status` prints cadence N, threshold X%, the turn-0 baseline, and the last score —
without throwing on any subcommand — and a probe fires **only after** `on`. The
command is the user's sole on/off control in batch mode.

Dispatch the command via `h.commands.get("drift-probe").run({ agent, args,
print })` (the `risk-guard.test.ts:44-50` pattern), collecting printed lines.
Assert: `on` then a run past N fires a probe; `off` then a run past N fires none;
`status` prints lines containing N, the threshold, the baseline, and last score
and does not throw before/after a probe.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T18 fails.

#### T19 — IMPL: the `/drift-probe` command

Register `offCmd = e.registerCommand({ name: "drift-probe", description, run })`
mirroring `risk-guard.ts:157-184`: `on` → `store.set("enabled", true)`; `off` →
`store.set("enabled", false)`; default/`status` → print
`cadence N`, `threshold X%`, `baseline <turn-0 score or "—">`, `last <score or
"—">` from `cfg()` + `e.store`. Never throw on any subcommand.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T18 passes);
`npm run typecheck` exits 0.

---

#### T20 — TEST: registration delta and clean teardown

**Invariant (AC12 + AC8 + D5/D6):** activating adds **exactly** +1 `turn_start`
listener, +1 `transformContext` listener, +1 command, and **+0 tools** and **+0
capabilities** (no side effect to gate, D5). `host.unload("drift-probe")` removes
all of them, and a subsequent run fires **no** probe (the
`recovery.test.ts:173-192` teardown invariant — no leak across reload).

Snapshot `h.agent.hooks.listenerCount("turn_start")`,
`listenerCount("transformContext")`, `h.commands.list().length`,
`h.agent.tools.list().length` before/after `host.use` (the `prune.test.ts:222-233`
delta style). Then `host.unload`, assert counts return to baseline, and a run past
N (enabled) fires no probe.

Acceptance: `node --import tsx --test test/drift-probe.test.ts` — T20 fails.

#### T21 — IMPL: dispose loop that never throws

Return a disposer iterating `[offTurn, offNote, offCmd]` in `try/catch`
(swallowing teardown errors — `risk-guard.ts:186-194`). Reset the module-scoped
turn counter / probe count on dispose so a reload starts clean. Declare **no**
capability and register **no** tool (D5).

Acceptance: `node --import tsx --test test/drift-probe.test.ts` (T20 passes);
`npm run typecheck` exits 0.

---

#### T22 — Quality gate (AC14)

Run the full suite and typecheck. All `drift-probe` cases plus the entire prior
suite must be green.

Acceptance:
- `node --import tsx --test test/drift-probe.test.ts` — all cases pass.
- `npm run typecheck` — exit 0.
- `npm test` — exit 0 (`# fail 0`, 0 skipped, new suite included).

### Exit condition

- `src/extensions/drift-probe.ts` and `test/drift-probe.test.ts` exist and
  implement D1–D7 (D11/D12 deferred).
- All 14 Acceptance Criteria are asserted in the offline suite and pass.
- `npm test` and `npm run typecheck` both exit 0.
- `src/host.ts`, `CLAUDE.md`, `README.md` are **untouched** (verify with
  `git status --porcelain` — only the three permitted paths plus this doc appear).

---

## 3. Engineering Constraints Index (house rules + commit conventions)

**Code (must hold for typecheck/CI to pass and for review):**

- **ESM + NodeNext.** Use `.js` import specifiers even for `.ts` files (e.g.
  `import type { ExtensionAPI } from "../kernel/extension.js"`). Required by
  `module: NodeNext` + `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. No `any`. Model the
  types. With `noUncheckedIndexedAccess`, `PROBE_POOL[i]` is `T | undefined` —
  narrow it (the `risk-guard.test.ts` `RECOVERY_RULES[0]!` idiom, or an explicit
  guard).
- **Zero runtime dependencies except `jiti`.** Pure Node + global `fetch` only.
  Add no npm package. The scorer is pure string ops; the sub-call reuses
  `e.agent.providers.get()`.
- **Capability-gate side effects; declare none when there are none.** This
  extension performs no filesystem/network side effect — it declares **no
  capability** (D5), the same profile as `risk-guard`/`compact`/`memory`.
- **Kill-switch env var:** `EAGENT_DRIFT_PROBE=off` is the hard override (D4).
- **Dispose loop that never throws** (D6).
- **Offline `node:test` via `tsx`, against the scriptable `MockProvider`.** No
  network, no `ANTHROPIC_API_KEY`. Save/restore any `process.env` mutation in
  `finally` (the `EAGENT_DRIFT_PROBE` toggle — `recovery.test.ts:149-171`,
  `prune.test.ts:208-219`).

**Hook surface (use exactly these; introduce no new event/filter — `KernelEvents`
is closed, `events.ts:11-38`):**

- Events via `e.on`: `turn_start` (the counter). Filters via `e.hook`:
  `transformContext({ value: Message[], context: { turn, model } })` (the note).
  No `beforeToolCall`/`afterToolCall` (drift is not a per-call property, §3).
- `e.agent.providers.get()`, `e.agent.model`, `e.agent.ui.notify`,
  `e.agent.messages`, `e.agent.tools`, `e.agent.hooks` (introspection).
- `e.store` get/set/keys; `e.log.warn`; `e.registerCommand`. No `registerTool`,
  no `grantCapability`.

**Commit conventions:**

- Prefix: `feat(phase1)` for the implementation; `fix(phase1-roundR)` for a
  review-round fix.
- Trailers: include `npm test` and `npm run typecheck` results.
- **No mention of AI / model / tooling** in commit messages (describe the change,
  not how it was produced).
- Branch first if on the default branch; commit/push only when the user asks.

---

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`** — do not hand-roll a harness:
  - `makeHarness({ responder?, ui?, logger? })` builds the agent + `MockProvider`
    + `ExtensionHost` (`helpers.ts:25-46`). Pass a custom `logger` (spy on `warn`)
    and `ui` (spy on `notify`) for AC4/AC5.
  - `silentLogger`, `autoUI(answer)` are the defaults (`helpers.ts:11-22`).
  - `lastText(agent)` reads the last assistant text if needed.
- **`MockProvider` scripting** (`mock.ts`): use the **function responder**
  `(req, turnIndex) => MockTurn | undefined` (`mock.ts:36`, `mock.ts:103-108`) so
  the test serves the canary sub-call distinctly from main turns by branching on
  `req.systemPrompt === <probe.prompt>` and `req.tools.length === 0`. A
  **call-counting subclass** of `MockProvider` (override `stream`, count probe
  calls, then `yield* super.stream(req)`) is the AC3/AC8/AC11 instrument — the
  `risk-guard.test.ts:54-60` and `prune.test.ts:236-245` pattern.
- **Seed the namespaced store inside a wrapping `activate`** (the
  `risk-guard.test.ts:32-41` idiom): `await h.host.use("drift-probe", (e) => {
  e.store.set("enabled", true); e.store.set("n", 2); return driftProbe(e); })`,
  capturing the `ExtensionAPI` if the test needs it.
- **Probe fixtures are the exported `PROBE_POOL`** (each entry carries its own
  `expectedTokens`/`exactAnswer`/`prompt`), so a scripted reply has a **known**
  score. No external fixture files; everything is in-module and deterministic.
- **No new fixture files, no disk state** (§3: no persistence across processes).

---

## 5. Regression Protection — which prior tests must stay green

- **The whole offline suite must remain green** — final gate is `npm test` exit 0
  (`# fail 0`, 0 skipped). Because this is a brand-new file with **no edits to the
  kernel or to `host.ts`** (batch mode), no existing test should change behavior.
  Treat any newly-red prior test as a real regression in `drift-probe.ts`
  (e.g. a leaked `process.env` mutation or a non-disposed listener) and fix it.
- **Highest-signal neighbors to watch** (run if you suspect interference):
  - `node --import tsx --test test/recovery.test.ts` — the `host.use`/`host.unload`
    teardown pattern this guide mirrors; confirms no-leak conventions still hold.
  - `node --import tsx --test test/risk-guard.test.ts` — the sub-call /
    off-by-default / kill-switch template; a green run confirms the shared
    `MockProvider` sub-call idiom is intact.
  - `node --import tsx --test test/prune.test.ts` and
    `node --import tsx --test test/compact.test.ts` — the `transformContext`
    non-mutation + `meta.kind` neighbors; confirms `drift-note` does not collide
    with `summary`/`pinned` and the new-array contract is respected.
  - `node --import tsx --test test/host.test.ts` — confirms `BUILTIN_EXTENSIONS`
    is **unchanged** (this guide must not have added `drift-probe` to it).
- **`process.env` hygiene:** the only env var this feature touches in tests is
  `EAGENT_DRIFT_PROBE`. Every test that sets it must restore it in `finally`
  (save-before / restore-after), or it will bleed into and break sibling tests —
  the single most likely cross-test regression source.
- **Listener / command / tool counts** must net to zero after every test (each
  test should `host.unload` or rely on per-test fresh harnesses); a leaked
  listener inflates `listenerCount` for later tests.

---

## Appendix — file-shape sketch (non-normative; the tests are the contract)

`src/extensions/drift-probe.ts` exports, at minimum:

- `PROBE_POOL` — fixed array of `{ prompt, expectedTokens, exactAnswer? }`.
- `pickProbe(index)` — `PROBE_POOL[index % PROBE_POOL.length]`.
- `scoreProbe(reply, expected)` — pure `[0,1]` blend (Design 4.2 weights).
- `isRegression(baseline, current, thresholdPct)` — the 4.4 inequality.
- `default activate(e)` — `turn_start` counter + every-N tool-less canary
  sub-call + baseline capture + regression warn + one-shot `transformContext`
  note + `/drift-probe` command; off by default + `EAGENT_DRIFT_PROBE`; dispose
  loop. No capability, no tool.

Module-scoped state (reset on dispose): turn counter, probe count, turn-0
baseline + last score + armed-note flag may live in module scope and/or `e.store`
(§Dependencies allows either; the command reads them for `status`).
</content>
</invoke>
