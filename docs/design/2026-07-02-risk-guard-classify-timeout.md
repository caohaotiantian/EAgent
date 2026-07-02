# Light-Mode brief — risk-guard classifier timeout (GUARD-3)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-02

**Slug:** `2026-07-02-risk-guard-classify-timeout` · **Tier:** Light (`src/extensions/risk-guard.ts` +
`test/risk-guard.test.ts`; a bounded-signal swap + a testability env knob, no breaking change, no new
contract, no unresolved decision). Source: `docs/DEFERRED-FOLLOWUPS.md` GUARD-3. Branch:
`chore/audit-gaps-2`.

## What / why

`risk-guard`'s `classify()` sub-call passes `signal: new AbortController().signal` (`risk-guard.ts:149`)
— a signal that is **never aborted** — inside a **blocking** `beforeToolCall` gate (the hook awaits
`classify` before the tool proceeds). The try/catch fails open only on a *throw*; a provider **hang** is
not a throw and there is no timeout, so a hung classifier blocks the gated tool call **forever**,
contradicting the module's own "never bricks the agent" promise (`risk-guard.ts:18-21`). (The kernel
withholds `#abort` from hook contexts, so `ctx.signal` isn't available here — a bounded
`AbortSignal.timeout` is the fix, exactly as `memory.ts:161` does for its network sub-call.)

**Change:** replace the never-aborting signal with `AbortSignal.timeout(classifyTimeoutMs())`, where
`classifyTimeoutMs()` reads `EAGENT_RISK_GUARD_TIMEOUT_MS` (a positive integer; **default 10000**, the
same bound memory uses). On timeout the provider stream throws → the existing catch returns `undefined`
→ the hook's `verdict === undefined` path warns and **fails open** (allows) — consistent with the
module's documented fail-open-on-classifier-unavailable behavior, now *bounded* instead of infinite.

## Explicit non-goals (Simplicity First)

- Timeout **fails open** (allow), matching the existing classifier-unavailable path — this does NOT
  change to fail-closed even in `mode=block` (that's the module's pre-existing, documented posture).
- Default `10000` mirrors `memory.ts`; the `EAGENT_RISK_GUARD_TIMEOUT_MS` knob exists for operator tuning
  and to make the timeout offline-testable without a 10 s wait — not a surfaced design decision.
- No change to the classifier prompt, `parseVerdict`, the decode-annotation, the sensitive-cap gating,
  or the default-OFF posture. No new capability, dependency, or kernel change.

## Any >1-option decision surfaced

None — the `AbortSignal.timeout` pattern is inherited from `memory.ts`; the default value mirrors it.

## Measurable acceptance command

- `node --import tsx --test test/risk-guard.test.ts` exit 0 — a NEW test (with a short
  `EAGENT_RISK_GUARD_TIMEOUT_MS`, e.g. 50, restored in `finally`, and a per-test timeout so a regression
  fails fast): a classifier provider whose `stream` **hangs until its `signal` aborts** (then throws) is
  used; the gated tool call **still proceeds** (fail-open) within a bounded time — proving the classify
  signal now times out. Reverting to `new AbortController().signal` makes the hang never abort → the test
  exceeds its per-test timeout (the discriminator). A control: a normal (fast) classifier still
  classifies as today (byte-identical when nothing hangs).
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-02. risk-guard's classifier sub-call now uses `AbortSignal.timeout(classifyTimeoutMs())`
(`EAGENT_RISK_GUARD_TIMEOUT_MS`, default 10000) instead of a never-aborting signal, so a hung provider
times out → the existing catch fails open (bounded, not infinite) — consistent with the module's
classifier-unavailable posture. Light-Mode fresh review **pass** (clean first round; fail-open verified
reached before the mode check, parse safe, no security regression, production `req.signal`→`fetch` path
confirmed, deterministic 50ms/3000ms discriminator). Gates: risk-guard 18 pass, `npm test` 1186 pass / 0
fail / 1 skip, typecheck 0, eval 5/5, `src/kernel/` untouched, no new dependency.
