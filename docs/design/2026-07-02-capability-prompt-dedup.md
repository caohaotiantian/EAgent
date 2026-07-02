# L1 Design — CapabilityManager in-flight prompt dedup (KERN-1)

Status: draft
Slug: `2026-07-02-capability-prompt-dedup`
Wave: 5 of the 2026-07-02 audit-gaps program. Source: `docs/DEFERRED-FOLLOWUPS.md` KERN-1. Branch:
`chore/audit-gaps-3`. **User-directed BUILD** (over the assessment's close recommendation): fix the gap
and comment-golf the kernel to stay under the ceiling.

## 1. Problem / context

`CapabilityManager.require()` (`src/kernel/capabilities.ts:85-120`) is an async check-then-act on the
`ask` path: it passes `#remembered.has(cap)` (`:95`), then `await this.#ui.confirm(...)` (`:116`), then
`#remembered.set(...)` (`:117`). Under concurrent tool dispatch (the agent fans a wave through
`Promise.all`, `maxConcurrency` default `Infinity`, `agent.ts:132,452`, awaiting `require` per call
`:515-516`), **two parallel calls needing the same not-yet-remembered ask-fallback capability** both
pass the `has()` gate → both `confirm` → the human is prompted **twice**, and the two `set`s race
(last-writer-wins). Impact LOW/fail-safe (each call still gets a real human decision; the persisted value
is always one the user typed), but it's a real TOCTOU. Reachable only on the CLI (`fallback:"ask"`), for
a non-pre-granted cap (`shell:exec`/`net:fetch`/…; `fs:*`/`skill:read` are pre-granted), on its *first*
concurrent use.

## 2. Deliverables

1. **In-flight prompt memo**: an `#pending = new Map<string, Promise<boolean>>()`. On the ask path,
   get-or-create a single shared `confirm` promise per capability; concurrent callers **await the same
   promise** instead of each prompting. The shared promise sets `#remembered` once on resolve and
   removes itself from `#pending` on settle. Each caller still records its own audit entry and throws its
   own `CapabilityError` on deny.
2. **Comment-golf** ≥ the added-line count elsewhere in `src/kernel/` so `test/kernel-surface.test.ts`'s
   `< 2200` still holds — compressing **verbose/redundant** comment prose only, **never** the
   load-bearing "why" rationale (esp. the `capabilities.ts:1-20` header explaining the capability
   stance). Net kernel line delta ≤ 0.

## 3. Scope boundary

**In:** `src/kernel/capabilities.ts` (the dedup + local golf), possibly a few golfed comment lines in
another `src/kernel/*.ts`; `test/capabilities.test.ts` (a concurrent-dedup test). **Out:** any change to
the decision policy (grant/deny/ask ordering), the audit format, `isGranted`, or the pre-grant set; the
`maxConcurrency` default; raising the 2200 ceiling (explicitly off — the whole point is to *stay* under
it). No new dependency.

## 4. Design / approach

The ask block (`:111-119`) becomes (illustrative):
```ts
if (!this.#ui) { this.record(capability, "deny", source, false); throw new CapabilityError(capability, "not granted and no UI to prompt"); }
// Concurrent callers needing the same unremembered cap share ONE confirm (dedup).
let ask = this.#pending.get(capability);
if (!ask) {
  this.#pending.set(capability, (ask = this.#ui.confirm(`Allow ${source} to use capability "${capability}"?`).then((ok) => (this.#remembered.set(capability, ok), ok))));
  void ask.finally(() => this.#pending.delete(capability));
}
const ok = await ask;
this.record(capability, ok ? "allow" : "deny", source, true);
if (!ok) throw new CapabilityError(capability, "declined by user");
```
Key properties: (a) `#remembered.set` moves into the shared promise's `.then`, so it's set **once**, not
raced; (b) `#pending.delete` on `.finally` bounds the memo (one entry per in-flight cap, gone when
settled); (c) each caller's own `record`/throw stay outside the shared promise, preserving per-caller
audit + the `deny` throw; (d) a `deny` is still remembered (as `false`) → subsequent calls short-circuit
at `:95` and throw "previously declined", unchanged.

**Audit `prompted` semantics (intended, L1-review note):** a caller that *shares* an in-flight prompt
still records `prompted: true` — the decision it acted on **is** human-sourced (a genuine `confirm`); it
simply wasn't a second UI round-trip. That is the correct reading of the flag ("this decision came from
a human prompt", not "this exact call opened a distinct dialog"), and strictly better than today, where
the flag was `true` on *both* of two real prompts. No audit-format change; L3 preserves this.

**Golf sizing (L1-review note):** ~4-5 lossless lines exist in `capabilities.ts` alone (the `fallback`
JSDoc `:48-51` is the strongest); the remaining 1-2 come from a sibling kernel file's verbose comment at
the same lossless bar (§4 already permits this). ≥6 lossless lines are clearly available kernel-wide with
the `:1-20` header off-limits; the mechanical `< 2200` gate + L3 review enforce it.

**Golf plan (Simplicity/Surgical):** the dedup adds ~6 lines (field + block + 1 comment). Reclaim ≥6 by
tightening genuinely verbose comment prose — candidate sources, each losing **zero** rationale:
- `capabilities.ts:48-51` (the `fallback` JSDoc, 4 lines) → 2 lines (same content, tighter).
- `capabilities.ts:36-39` (two one-line `AuditEntry` field comments) → fold the obvious ones.
- the `#remembered`/`#pending` field comments → one shared 1-line note.
The exact set is finalized in L3; the hard gate is `test/kernel-surface.test.ts` (`< 2200`, split-metric)
+ the L3 reviewer confirming no "why" was lost. If ≥6 lossless lines can't be found in `capabilities.ts`
alone, the dev may golf a verbose comment in a sibling kernel file (same lossless bar).

## 5. Key design decisions (surfaced)

**D1 — dedup mechanism: in-flight promise memo vs a serializing mutex vs folding `#pending` into
`#remembered`.** Chosen: **a separate `#pending` map**. A mutex/queue is more lines and reorders callers;
folding a `Promise` into `#remembered` (`boolean | Promise<boolean>`) is rejected — `isGranted` (`:123-128`)
is **synchronous** and would read a pending promise as truthy ("granted"), a real bug. A separate map
keeps `isGranted` correct and the change local.
**D2 — where to golf.** Chosen: **verbose comment prose, header rationale untouchable.** Alternatives
(raise the ceiling / golf load-bearing "why") are rejected by project doctrine (CLAUDE.md's small-kernel
bet) and the user's build directive (which said golf, not raise). The golf is lossless-or-nothing,
mechanically gated by the kernel-surface test and reviewer-verified.

## 6. Acceptance criteria

- **Dedup**: a concurrent `await Promise.all([mgr.require(cap,"a"), mgr.require(cap,"b")])` with a
  confirm-counting UI (whose `confirm` returns a deferred promise) prompts **exactly once** and both
  resolve; both audit entries are recorded; a denied concurrent pair both reject and remember `false`.
- **No regression**: sequential require (allow/deny/remembered/grant/deny-rule/fallback paths) unchanged
  (existing `test/capabilities.test.ts` green, incl. the existing sequential dedup test).
- **Ceiling**: `test/kernel-surface.test.ts` passes (kernel `< 2200`, split-metric); `npm run typecheck`
  0; `npm test` 0 fail; `npm run eval` 0; no new dependency. The public kernel export surface is
  unchanged (no new exported symbol).

## 7. Risks / non-goals

- **Risk:** the memo leaks if `.finally` doesn't run → it always runs (confirm resolves or rejects; a
  `confirm` that never settles would already hang the original code). **Risk:** golf loses a "why" → the
  lossless-or-nothing bar + L3 review + the header being off-limits mitigate it. **Non-goal:** changing
  `maxConcurrency`, serializing dispatch, or the fail-safe posture; multi-tenant/audit-per-source prompt
  text (the shared prompt names the first caller's `source` — acceptable, the audit still records each).

## 8. Test plan

`test/capabilities.test.ts`: a `DeferredUI` whose `confirm` returns a promise the test resolves manually
+ a call counter; assert `Promise.all([require(cap), require(cap)])` → one `confirm` call, both settle,
one prompt; a deny variant; and that a *second* wave after the first settles short-circuits at
`#remembered` (no new prompt). Plus the kernel-surface + full-suite gates.

## Closure

Status: closed
Closing-commit: 8455381
Closed-on: 2026-07-02
Deferred: none (KERN-1 built). Reopen note is moot — the fix shipped.

`require()` now dedups concurrent prompts via an `#pending` in-flight memo; `#remembered` is set once in
the shared `.then`; per-caller `record`/throw preserved. Comment-golfed **within `capabilities.ts` alone**
(net -1: verbose `fallback` JSDoc + `AuditEntry`/field comments tightened losslessly, `:1-20` header
untouched) → kernel 2199→**2198** (< 2200 holds, +1 headroom recovered). User-directed BUILD (over the
adversarial assessment's close). L1 converged (2-gen zero-severe/zero-general); L2 pass; L3 clean-first-
round; F whole-project review pass. Gates: capabilities +3 tests, kernel-surface (export-pin + `<2200`)
pass, `npm test` 1195 pass / 0 fail / 1 skip, typecheck 0, eval 5/5, no new dependency.
