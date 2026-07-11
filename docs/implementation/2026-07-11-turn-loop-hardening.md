# Implementation — Turn-loop hardening (Cycle 3)

Slug: `2026-07-11-turn-loop-hardening` (matches the design)
Status: **L2 closed** — round 1 zero-severe (4 general fixed) → round 2 fully clean. Ready for L3.

## 1. Task Index

Design: `docs/design/2026-07-11-turn-loop-hardening.md`. Deliverables D1–D6 → §2; Acceptance AC1–AC7 →
§7; KDD1–KDD5 → §4; the round-3 implementer notes → the design's L1-closed status block. Two phases:
**Phase 1** the +0–2 line kernel `usage.model` field + cost fix (D1/D2); **Phase 2** the watchdog
extension (D3/D4). `<TEST-CMD>` = `npm test`.

## 2. Phase Breakdown

### Phase 1 — 3a: per-event cost model (kernel `usage.model` + cost pricing)

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1339 pass / 1 skip);
  kernel 2246/2250.
- **Design references:** §2 D1/D2; §4 KDD1; §7 AC1/AC2/AC3; §5 (`agent.ts:361/429/436`, `events.ts:48`,
  `cost.ts:176/216/224`).
- **Task list (TDD order):**
  1. **T1.1 (tests, RED)** — in `test/cost.test.ts` (and/or a new `test/usage-model.test.ts`). Protected
     invariant: *the `usage` event reports the model the request actually used, and `cost` prices each
     event at that model — including a mid-run routing switch and a retry downshift.* Cases:
     - **AC1:** drive a turn against a `MockProvider`; assert the observed `usage` event payload has
       `model === <the model on the request>` (subscribe via `e.on("usage", …)` in a tiny test extension
       or the host's hook bus). RED (payload has no `model`).
     - **AC2 (routing switch):** set `e.agent.model` to a different model on `turn_start` (a tiny test
       hook, mirroring `routing`), then assert `cost` attributes the `usage` to the **new** model's price
       (via `/cost` readout or the `perModel` map), not the `agent_start` model. RED.
     - **AC3 (downshift):** register an `onProviderError` filter returning the actual decision shape
       `{ retry: true, downshiftModel: <cheaper>, fail: false }` (confirm the exact `onProviderError`
       decision fields against `agent.ts:427` at L3), driven by a **stateful** bespoke provider that
       throws **pre-commit** (zero events) on the first attempt then succeeds on the retry. Assert the
       post-downshift `usage` is priced at the downshifted model. RED (needs the kernel field —
       `e.agent.model` is stale for a downshift). No existing downshift scaffolding was found to reuse.
  2. **T1.2 (impl D1, KERNEL)** — `src/kernel/events.ts:48`: add `model: string;` to the `usage` event
     type (`usage: { usage: Usage; cumulative: Usage; model: string }`). `src/kernel/agent.ts:436`: pass
     the turn-local `model` in the emit — `emit("usage", { usage, cumulative: { ...this.#usage }, model })`.
     Both are in-place extensions of existing single-line constructs (≈ +0 net kernel lines). **Verify
     `test/kernel-surface.test.ts` stays green (`lines < 2250`); if the measured count is ≥ 2250, STOP and
     escalate — do not bump.**
  3. **T1.3 (impl D2, cost)** — `src/extensions/cost.ts`: the `usage` handler payload type gains
     `model?: string`; price with `priceRow(p.model ?? activeModel, card)` (`:224`) and key `perModel` by
     `p.model ?? activeModel` (`:231/:241`). `activeModel` stays the fallback (older events / no model).
- **Per-task acceptance command:** `node --import tsx --test test/cost.test.ts test/kernel-surface.test.ts`
- **Exit condition:** those green; `npm test` 0 fail; `npm run typecheck` 0; `test/kernel-surface.test.ts`
  green with kernel `< 2250`. (Other `usage`-event consumers — `trace`, `budget-cap`, `limits` — must
  stay green: the field is **additive**, so their destructures ignore it. Confirm in Regression.)

### Phase 2 — 3b: watchdog provider extension

- **Entry condition:** Phase 1 merged.
- **Design references:** §2 D3/D4; §4 KDD2/KDD3/KDD4/KDD5; §7 AC4/AC4b/AC5/AC6; the round-3 implementer
  notes; §5 (`agent.ts:353/401/407/421`, `registry.ts:61/64-70/81`, `extension.ts:239/257`, `http.ts:108`,
  `mock.ts`).
- **Task list (TDD order):**
  1. **T2.1 (tests, RED)** — new `test/watchdog.test.ts`, offline. Protected invariant: *a provider that
     goes silent past `idleMs` is aborted (the turn never hangs), a progressing stream is never aborted,
     and unload restores the original provider.* Cases use a **bespoke `Provider`** (a `MockProvider`
     cannot stall, §5) and a tiny `watchdog.idleMs`:
     - **AC4 (pre-commit hang):** a provider whose `stream` yields **no** event and `await`s a
       never-resolving promise → the wrapped provider's stream rejects after `idleMs` with the idle
       error; the turn does not hang (drive one turn, assert it settles with an error, not a timeout).
     - **AC4b (mid-stream stall):** a provider that yields **one** event then stalls → rejects `idleMs`
       after event 1 (re-arm proof); the turn ends fatal (committed → rethrown), not hung.
     - **AC5 (progressing not aborted):** a provider yielding an event every `< idleMs` (a few, on a
       short `setTimeout`) then `done` → completes normally.
     - **AC5c (inner error propagates cleanly, no timer leak — G2):** a provider that throws a normal
       error **before** `idleMs` → the error propagates to the loop (pre-commit → retry seam; committed →
       fatal), and no `unhandledRejection` from the idle timer occurs (assert via a
       `process.on("unhandledRejection")` guard or that the test completes clean). Exercises the
       per-iteration `finally { clearTimeout }`.
     - **AC6 (restore + off):** after `host.unload("watchdog")` (or the returned disposer),
       `e.agent.providers.get()` is the **original** provider (not a wrapper, not undefined); with
       `EAGENT_WATCHDOG=off`, activation does not wrap (`get()` is the original).
     - **AC6b (reload → no double-wrap — G4):** after a reload (`host.reload("watchdog")` = dispose then
       reactivate), `e.agent.providers.get()` is a **single** wrapper over the original (not a
       wrapper-of-a-wrapper). This confirms the reconciliation of the module-local `WeakSet` idempotence
       with design note (2): reload disposes-then-reactivates (`extension.ts:161-165`), so the original is
       restored before re-activate and no double-wrap arises; the `WeakSet` skip only matters on
       same-module double-activation.
  2. **T2.2 (impl D3/D4)** — new `src/extensions/watchdog.ts`, default-exported `activate(e)`:
     - **Enable/config:** `if (!e.config.enabled("watchdog", { default: true })) return () => {};` (kill
       `EAGENT_WATCHDOG=off`). `const idleMs = e.config.int("watchdog.idleMs", 120000);` (use the config
       int accessor; confirm the method name against `Config` in `src/kernel/store.ts`).
     - **Capture + idempotence + guard:** `const inner = e.agent.providers.get(); if (!inner) return
       () => {};` (undefined guard, note 1). Track wrapped providers in a module-level `WeakSet<Provider>`
       `WRAPPED`; `if (WRAPPED.has(inner)) return () => {};` (idempotent-skip, inert dispose — note 2; a
       module-local set suffices because `reload()` disposes-then-reactivates, `extension.ts:161-165`, so
       the original is restored before re-activate; document this).
     - **Wrap:** `const wrapped: Provider = { name: inner.name, stream: (req) => idleGuard(inner, req,
       idleMs) };` `WRAPPED.add(wrapped);` register via the **raw** registry
       `e.agent.providers.register(wrapped);` (NOT `e.registerProvider` — tracked dispose would delete the
       provider, KDD4).
     - **`idleGuard(inner: Provider, req: CompletionRequest, idleMs: number)`** — an async generator that
       **threads a composed signal into the inner stream** (G1) so an idle abort actually frees the fetch:
       ```ts
       const ctrl = new AbortController();
       const it = inner.stream({ ...req, signal: AbortSignal.any([req.signal, ctrl.signal]) })[Symbol.asyncIterator]();
       for (;;) {
         let timer: ReturnType<typeof setTimeout> | undefined;
         const idle = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`provider idle for ${idleMs}ms`)), idleMs); });
         const step = it.next();
         let r: IteratorResult<StreamEvent>;
         try { r = await Promise.race([step, idle]); }
         catch (err) { ctrl.abort(); step.catch(() => {}); throw err; }   // idle OR inner error → free fetch + swallow abandoned next()
         finally { clearTimeout(timer); }                                 // per-iteration; clears the idle timer no matter how the race settled (G2)
         if (r.done) return;
         yield r.value;
       }
       ```
       `idle` is typed `Promise<never>` so `Promise.race` infers `IteratorResult<StreamEvent>` under
       `strict`. `clearTimeout` in the per-iteration `finally` prevents the idle timer from leaking into an
       `unhandledRejection` when the inner stream throws a real error before `idleMs`. On timeout the race
       rejects → the loop's committed-flag routing applies (pre-commit retry / mid-stream rethrow).
     - **Dispose:** `return () => { e.agent.providers.register(inner); WRAPPED.delete(wrapped); };`
       (restore the original by overwrite; the idempotent-skip / disabled paths return an inert `() => {}`).
  3. **T2.3 (register)** — add `"watchdog"` to `BUILTIN_EXTENSIONS` in `src/host.ts` (order it BEFORE
     `fallback-routing` so `get()` at activation is a real leaf provider, not a composite — though
     wrap-default is composite-safe regardless since fallback registers `{default:false}`).
  4. **T2.4 (docs D6)** — README/CHANGELOG: the `usage` event now carries `model`; the watchdog bounds a
     hung main stream (`watchdog.idleMs` default 120 s, `EAGENT_WATCHDOG=off`), default-on, with the
     documented coverage note + the TTFT-with-large-thinking-budget caveat (raise `idleMs`).
- **Per-task acceptance command:** `node --import tsx --test test/watchdog.test.ts`
- **Exit condition:** green; `npm test` 0 fail; `npm run typecheck` 0; `npm run build` 0; `npm run eval`
  5/5; `test/kernel-surface.test.ts` green (Phase 2 adds no kernel line — new file under `src/extensions/`).

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md: ESM `.js` specifiers; strict TS (`noUncheckedIndexedAccess`; type
  `idle` as `Promise<never>` so `Promise.race` infers `IteratorResult<StreamEvent>`; `req.signal` is
  non-optional — `types.ts:257` — so no guard needed there); zero deps except jiti;
  **Phase 1 is a KERNEL change** (events.ts + agent.ts) held `< 2250` (≈ +0 lines) — if the measured
  count reaches 2250, STOP and escalate; **Phase 2 is a new extension** (zero kernel), capability-free,
  with an `EAGENT_WATCHDOG=off` kill switch, ships on (a safety net).
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; `<TEST-CMD>` results as
  trailers; no AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- Phase 1: reuse `test/cost.test.ts`'s harness + `MockProvider`; a tiny `turn_start` hook to simulate a
  routing switch; an `onProviderError` downshift (reuse existing downshift test scaffolding if present,
  else a provider that throws once pre-first-event). Phase 2: **new bespoke `Provider`s** in
  `test/watchdog.test.ts` — a never-yield staller, a one-then-stall, a steady-progress generator — plus
  the host harness (`makeHost`/`host.use`/`host.unload`). All offline.

## 5. Regression Protection

Must stay green:
- **Phase 1:** every `usage`-event consumer — `test/cost.test.ts`, `test/trace.test.ts`,
  `test/budget-cap.test.ts`, `test/limits.test.ts`, `test/otel-exporter.test.ts`, `test/evals.test.ts`
  (all six subscribers — `cost.ts:221`/`budget-cap.ts:268`/`trace.ts:167`/`limits.ts:210`/
  `otel-exporter.ts:384`/`evals.ts:370`) — the `model` field is additive (their local payload
  destructures ignore it); `test/kernel-surface.test.ts` (kernel `< 2250`, export pin unchanged —
  `usage` is an event payload type, not a public kernel export).
- **Phase 2:** `test/fallback-routing.test.ts` (the composite still resolves + fails over through the
  wrapped default), all provider tests (`test/anthropic.test.ts`/`openai`/`gemini`/`mock` — they run the
  default provider path, now wrapped; the wrapper is a transparent pass-through when no idle occurs),
  `test/host.test.ts` (BUILTIN_EXTENSIONS load), `test/extension.test.ts` (unload/reload restores).
- Full suite `npm test`; final gate adds `npm run eval` (5/5), `npm run build`, `test/kernel-surface.test.ts`.
