# Design — Turn-loop hardening: per-event cost model + provider watchdog (Cycle 3)

Slug: `2026-07-11-turn-loop-hardening`
Status: **L1 closed** — round 1 (1 severe + generals) → round 2 (zero-severe, general fixed) → round 3
(fully clean). Facts verified; 3a ~+0 kernel lines (< 2250, no bump), 3b zero-kernel. Ready for L2.
L2/L3 implementer notes from round 3: (1) no-op if `providers.get()` is undefined; (2) idempotence
brand must be reload-stable (`Symbol.for`/string key, not a module-local `Symbol`); (3) on race timeout
abort the composed controller (not `it.return()`) + `.catch(()=>{})` the abandoned `next()`.

## 1. Background and Purpose

Two turn-loop correctness/availability gaps:

- **3a — mid-run cost mispricing.** `cost` prices a `usage` event at the model stamped on `agent_start`
  (`src/extensions/cost.ts:176,216`, used at `:224` `priceRow(activeModel, card)`). But the model can
  change mid-run: `routing` re-tiers on `turn_start` (`src/extensions/routing.ts:266,305`), and the
  `onProviderError` retry can **downshift** (`src/kernel/agent.ts:429` `model = decision.downshiftModel`).
  The `usage` event payload carries no model (`agent.ts:436` `{ usage, cumulative }`), so `cost` can't
  see the actual per-event model → wrong price/attribution.
- **3b — a hung provider wedges the turn.** The main `provider.stream(finalReq)` (`agent.ts:406`) has
  only the run-level abort signal; a provider that yields nothing and never throws hangs the `for await`
  forever (the run only breaks on external `stop()`, `agent.ts:171`). Extension sub-calls are bounded
  (`lib/sub-call.ts`), but the main stream is not.

## 2. Deliverables

- [ ] **D1 (kernel, 3a)** — add `model: string` to the `usage` event type (`src/kernel/events.ts:48`) and
      pass the turn-local `model` at the emit (`src/kernel/agent.ts:436`). The `model` local
      (`agent.ts:361`, mutated by a downshift at `:429`) is the exact model the kernel *requested* for the
      committed stream — so it captures both the routing switch and the retry downshift. **Kernel delta
      ≈ +0–2 lines; fits the current headroom (2246; gate `< 2250` ⇒ 3 lines, ≤ 2249) — no ceiling bump.**
- [ ] **D2 (cost, 3a)** — `src/extensions/cost.ts` prices the `usage` event with `p.model` when present:
      `priceRow(p.model ?? activeModel, card)` (and key `perModel` by `p.model ?? activeModel`). Fixes
      routing + downshift mispricing.
- [ ] **D3 (watchdog extension, 3b)** — a new `src/extensions/watchdog.ts` (added to
      `BUILTIN_EXTENSIONS`) that, at activation, captures the **default** provider (`e.agent.providers.get()`)
      and re-registers **under the same name** a wrapper whose `stream(req)` imposes an **idle deadline**.
      **Mechanism — race the iterator against the timeout, do not rely on abort alone** (G2): drive the
      inner stream via its async iterator and, for each step, `Promise.race([iterator.next(),
      idleTimeout])` where `idleTimeout` rejects after `idleMs`; **re-arm** the timeout each step
      (`clearTimeout`+`setTimeout`), `clearTimeout` in `finally`. On timeout, throw
      `"provider idle for <idleMs>ms"` **and** abort an inner `AbortController` composed with `req.signal`
      (to free the underlying fetch — `http.ts:108` honors the signal). The race is what guarantees
      unblocking even a signal-*ignoring* stall; the abort is complementary cleanup. Because the agent
      resolves `providers.get(providerName)` **each turn** (`agent.ts:353`) and the registry registers by
      name (`registry.ts:61`), the wrapper is used automatically. A pre-commit idle (zero events) surfaces
      to the loop's `onProviderError`/retry seam (`agent.ts:419`); a mid-stream idle (≥1 event → committed)
      is rethrown as a fatal turn error (`agent.ts:421`) — correct, since retrying a partial stream would
      double-emit (C6). **Implementer note:** when the timeout wins the race, attach `.catch(() => {})`
      to the abandoned `iterator.next()` promise so a signal-honoring inner stream's later AbortError
      rejection doesn't surface as an `unhandledRejection`.
- [ ] **D4 (watchdog lifecycle + config)** — the watchdog **restores** the captured inner provider on
      dispose (re-register the original — the registry has no auto-restore, `registry.ts:64-70`), and is
      **idempotent** (if `get()` already returns a watchdog wrapper — reload — it does not double-wrap).
      Config: `watchdog.idleMs` (default **120000**), kill switch `EAGENT_WATCHDOG=off`. Ships **on** (a
      safety net), inert when the deadline is never reached.
- [ ] **D5 (tests)** — 3a: a `usage` event carries the in-effect model, incl. after a routing switch and
      a downshift; `cost` prices per-event. 3b: a scripted provider that stalls (yields nothing) is
      aborted after `idleMs` with the idle error; a progressing stream (events within `idleMs`) is **not**
      aborted; dispose restores the original provider; `EAGENT_WATCHDOG=off` disables wrapping.
- [ ] **D6 (docs)** — README/CHANGELOG: `usage` event now carries `model` (per-event cost correctness);
      the watchdog bounds a hung main stream (`watchdog.idleMs`), with the documented coverage note (D5/§3).

## 3. Scope Boundary (NOT in scope)

- **3a does NOT fix fallback-routing's provider-internal model.** fallback-routing's composite picks the
  model per chain entry *inside* the provider (`src/extensions/fallback-routing.ts:210`), and the `done`
  StreamEvent carries no model (`src/kernel/types.ts:250`). Reporting that requires a `done`-event
  protocol change — a documented follow-up. 3a fixes what the kernel *can* see (the requested model:
  routing + downshift).
- **3b wraps the DEFAULT provider path (documented coverage note).** The watchdog wraps the provider
  returned by `providers.get()` (the default = the selected provider the agent uses via
  `providers.get(providerName)`). Enumerate-and-wrap-all **is** available (`e.agent.providers.list()`
  exists, `registry.ts:81`) but is deliberately NOT chosen (KDD4): it would wrap whatever composite
  happens to be registered before the watchdog activates — wrapping fallback-routing's `"fallback"`
  composite envelope would wrongly bound a whole legitimate failover handoff — and its coverage is
  load-order-dependent. Wrap-default is the simpler, robust choice and it covers the primary path.
  **Favorable interaction (not a gap):** fallback-routing's composite resolves each chain entry via
  `providers.get(entry.name)` (`fallback-routing.ts:208`), so when an entry is the wrapped default it
  **is** watchdog-protected *through* the composite, and a hung head → idle error → the composite fails
  over (its `req.signal` is not aborted). The uncovered residual is only fallback entries whose provider
  is not the default (a degraded path that has fallback-routing's own circuit breaker). Documented, not
  silently incomplete.
- **3b is idle-deadline, not total-turn** (a long-but-progressing generation must not be killed).
- **No kernel change for 3b** (charter: new behavior is an extension). The only kernel change is 3a's
  +0–2 lines, within the existing slack — **no ceiling bump**.

## 4. Key Design Decisions

### KDD1 — 3a as a +0–2 line kernel field, not an extension-only partial
- **Problem:** how to give `cost` the per-event model.
- **Options:** (a) extension-only — `cost` reads `e.agent.model` live on `turn_start`; (b) add `model`
  to the `usage` event (kernel).
- **Choice: (b).** (a) fixes the routing switch (it writes `e.agent.model`) but **misses the downshift**
  — `agent.ts:429` mutates the loop-local `model` and never writes back to `this.model`, so
  `e.agent.model` is stale for a downshifted retry. (b) reports the exact requested model for **both**
  cases in +0–2 kernel lines that fit the current slack. A `usage` event carrying the model it priced
  against is an obvious data-completeness win, broadly useful beyond `cost`.

### KDD2 — 3b as a watchdog provider extension, not a kernel deadline
- **Problem:** where does the main-stream idle deadline live?
- **Options:** (1) inline an idle deadline in the agent loop (~14 kernel lines + ceiling bump); (2) a
  watchdog extension wrapping the provider (zero kernel).
- **Choice: (2)** (user decision 2026-07-11; charter "new behavior is always an extension, never a fork
  of the core"). The agent resolves the provider by name each turn (`agent.ts:353`) and the registry
  overwrites by name (`registry.ts:61`), so an in-place wrapper is picked up with no kernel change. (1)
  is universal (bounds even a raw provider) but costs the core its minimality; (2) protects every real
  deployment (CLI + server run through the loop's default provider) at zero kernel cost. The residual
  (a non-default named provider isn't wrapped) is documented (§3).

### KDD3 — idle deadline (re-armed per event), not total-turn
- **Options:** total-turn (one timer for the whole stream) vs idle (reset on each event).
- **Choice: idle.** Total-turn caps legitimate long generations; idle kills only a stream that emits
  **nothing** for `idleMs` — the actual "hung" condition. Cost: re-arm on each yielded event + a
  `finally clearTimeout`.

### KDD4 — wrap the default in place via the RAW registry; restore on dispose; wrap-default vs wrap-all
- **Problem:** (i) the registry deletes (not restores) on a disposed registration (`registry.ts:64-70`),
  so a **tracked** wrapper registration (`e.registerProvider`, which `track()`s, `extension.ts:239`)
  would delete the provider on unload; (ii) which providers to wrap.
- **Choice — register via the RAW `e.agent.providers.register()` (untracked) and restore manually.** The
  watchdog captures the inner provider at activation, registers the wrapper under the same name via the
  **raw** registry (deliberately not `e.registerProvider`, to avoid the delete-on-unload hazard and any
  double-dispose ordering), and its returned dispose **re-registers the original** (manual restore). It
  is idempotent: if `get()` already returns a watchdog wrapper (reload), it **skips** and returns an
  **inert** dispose (no captured ref to restore, so it can't clobber the registry).
- **Wrap-default vs wrap-all (`list()` DOES exist, `registry.ts:81`):** rejected wrap-all because it
  would wrap whatever composite is registered before activation (wrapping fallback-routing's `"fallback"`
  envelope would bound a whole failover) and is load-order-dependent (§3). Wrap-default is simpler,
  robust, covers the primary path, and — via the composite's per-entry `providers.get(entry.name)` —
  still protects a default head reached through fallback-routing (§3).

### KDD5 — watchdog ships ON (a safety net), with a kill switch
- **Problem:** default on or opt-in?
- **Choice: on.** A hung-provider deadline is a safety net that should protect by default; it is inert
  unless a stream actually stalls past `idleMs` (120 s default — well above any real inter-event gap,
  well below "forever"). `EAGENT_WATCHDOG=off` disables it. Rejected: opt-in (a safety net nobody
  enables protects nobody).

## 5. Dependencies and Assumptions

Verbatim source:
- `usage` emit `await this.hooks.emit("usage", { usage, cumulative: {...this.#usage} })` (`agent.ts:436`);
  type at `events.ts:48` `usage: { usage: Usage; cumulative: Usage }`. Turn-local `model`
  (`agent.ts:361`, downshift `:429`), request model at `:373`, stream at `:406`.
- `cost` pricing: `activeModel` stamped on `agent_start` (`cost.ts:176,216`), priced at `:224`.
- Provider resolution each turn: `agent.ts:353` `this.providers.get(this.providerName)`. Registry
  overwrite-by-name + no-restore: `registry.ts:57-70`; `list()` DOES exist (`registry.ts:81`, used only
  to justify the wrap-default-vs-wrap-all decision, KDD4).
- Related (not a drop-in) timeout code: `lib/sub-call.ts:30-56` shows a ref'd `setTimeout` + manual
  `signal.addEventListener("abort", …)` composition (NOT `AbortSignal.any`) + `clearTimeout` finally +
  a `timedOut` flag — but it is a **single-shot total deadline**, not the watchdog's **re-arming idle**
  timer, and it aborts rather than racing `next()`. The watchdog's idle-reset + `next()`-race is a new
  pattern (`AbortSignal.any` appears nowhere in `src/`; engine is node ≥22, so it is available). Kernel
  signal handling: transformRequest strips signal, loop re-attaches `this.#abort.signal`
  (`agent.ts:387-399`); real providers honor `req.signal` (`http.ts:108`).
- Kernel line count **2246**; the gate is `lines < 2250` (`kernel-surface.test.ts:69`), so headroom is
  **3** lines (≤ 2249) — 3a's +0–2 fits; verify at L3.
- Provider interface + StreamEvent (`src/kernel/types.ts`); `Usage` type. Suite offline. **`MockProvider`
  cannot stall** (it yields synchronously and always completes, `mock.ts:68-112`), so the stalling-stream
  test (AC4/AC4b) needs a **bespoke `Provider`** (an async generator that awaits a controllable
  never/late-resolving promise); a progressing stream can use a bespoke generator that yields on a short
  interval.

## 6. Relationship with Existing Designs

- Builds on the closed hardening cycles; no conflict. 3b is a new extension (like the Cycle-1/2
  additions). 3a is the first kernel change since Cycle E (capability revocation) — also a +0–2 line
  field, within the ceiling. Terminology anchors: CLAUDE.md (kernel primitives, the `usage` event,
  `EAGENT_<NAME>=off` convention) + the provider/registry docstrings.

## 7. Acceptance Criteria (measurable / automatable)

Offline (`MockProvider`), in `test/cost.test.ts` (or a new `test/usage-model.test.ts`) and a new
`test/watchdog.test.ts`.

- **AC1 (usage carries model):** drive a turn; assert the `usage` event payload has `model === <the
  model the request used>`. RED before D1.
- **AC2 (cost prices per-event — routing switch):** with `routing` (or a manual `e.agent.model` change
  on `turn_start`) switching the model mid-run, `cost` attributes the usage to the **new** model's price,
  not the `agent_start` model. RED before D2.
- **AC3 (cost prices per-event — downshift):** an `onProviderError` downshift (`decision.downshiftModel`)
  → the post-downshift `usage` is priced at the downshifted model. RED before D1/D2 (needs the kernel
  field — the extension-only path can't see this).
- **AC4 (watchdog aborts a pre-commit hang):** a **bespoke `Provider`** whose `stream` yields no event
  and awaits a never-resolving promise (a `MockProvider` cannot stall, §5) → the watchdog rejects after a
  tiny test `watchdog.idleMs` with the idle error; the turn does not hang. The `next()`-race (not
  abort-alone) is what makes this terminate even though the stall ignores the signal. RED before D3.
- **AC4b (watchdog aborts a mid-stream stall):** a bespoke provider that yields **one** event then stalls
  → the watchdog re-arms after event 1 and rejects `idleMs` later; the turn ends as a **fatal error**
  (committed → rethrown, not retried, `agent.ts:421`), and does not hang. RED before D3 (verifies the
  timer re-arms).
- **AC5 (watchdog does NOT abort a progressing stream):** a bespoke provider yielding an event every
  `< idleMs` → completes normally, not aborted. Guards against false-abort. RED before D3.
- **AC6 (dispose restores + off switch):** after unload, `e.agent.providers.get()` returns the **original**
  provider (not deleted, not a wrapper); with `EAGENT_WATCHDOG=off`, activation does not wrap. RED before D4.
- **AC7 (gates + no bump):** `npm test` 0 fail; `npm run typecheck` 0; `npm run build` 0; `npm run eval`
  5/5; `test/kernel-surface.test.ts` green with the kernel line count **< 2250** (i.e. ≤ 2249; the gate is
  `lines < 2250`, `kernel-surface.test.ts:69`) — 3a fits the 3-line headroom; if the measured count is
  ≥ 2250, STOP and escalate, do not bump without the user.

## 8. Risks and Rollback

- **R1 — 3a kernel line budget.** If the measured delta pushes kernel > 2250 (design estimate miss), STOP
  and escalate (do not silently bump). Mitigation: the change is a single type field + an in-place emit
  arg (+0–2 lines). Rollback: revert the `events.ts`/`agent.ts` hunk (the `usage` event loses `model`;
  cost falls back to `activeModel`).
- **R2 — watchdog false-abort** on a legitimately slow-but-progressing stream. Mitigated by idle-reset
  (only a *silent* `idleMs` gap trips it) + a generous 120 s default. **The riskiest window is stream
  start → first event** (time-to-first-token), where the watchdog can't distinguish "hung" from long
  server-side reasoning: a `thinking`-heavy request with a very large budget could exceed 120 s before
  the first token → false-abort. 120 s comfortably exceeds normal TTFT even with thinking; an operator
  running very large thinking budgets raises `watchdog.idleMs` (documented, D6). Rollback:
  `EAGENT_WATCHDOG=off`.
- **R3 — watchdog restore/double-wrap.** A botched restore could delete the provider; a botched reload
  could double-wrap. Mitigated by AC6 (dispose restores) + the idempotence tag (KDD4). Rollback: disable.
- **R4 — the wrapper must preserve provider semantics** (name, all StreamEvents passed through, errors
  propagated, `req.signal` honored). The wrapper is a thin pass-through that only adds the idle timer.
  Covered by AC4/AC5 + the full suite (existing provider tests run through the default provider path).
  Rollback: `EAGENT_WATCHDOG=off`.
- **Overall rollback:** revert the `events.ts`/`agent.ts`/`cost.ts` hunks (3a) and delete `watchdog.ts` +
  its `BUILTIN_EXTENSIONS` line (3b); independent. Branch `chore/production-hardening` (PR #40), not merged.
