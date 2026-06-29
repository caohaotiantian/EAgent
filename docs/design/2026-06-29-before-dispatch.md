# Design — `beforeDispatch` wave-level seam

```
Status: closed
Closing-commit: b0141ec
Closed-on: 2026-06-29
Deferred: deliverable — inject new call ids (RW6a-1); deliverable — share beforeDispatch to children (RW6a-2) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-before-dispatch` · **Wave:** 6 (subsystem 1 of 4) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P2.2

## 1. Background and Purpose

The tool-call **wave** has an observe-only signal (`tool_batch_end`, `agent.ts:274`) but **no
intervene** seam. The per-call seam `beforeToolCall` (`agent.ts` `executeGuarded`) sees one call at a
time; nothing can act on the *whole wave* before dispatch — reorder a cheap validation call ahead of an
expensive one, dedupe an identical call the model emitted twice, or drop a now-redundant call given the
others. Today the loop filters `tool_call` blocks (`agent.ts:253-255`) and goes straight to
`dispatch(calls)` (`agent.ts:270`). The audit's own improvement-ideas flagged a `beforeDispatch` filter;
it is the genuine **sixth** intervene point (after `transformContext`, `transformRequest`,
`beforeToolCall`, `afterToolCall`, `onProviderError`) and is on-bet (deepen a seam, not add a feature).

The hard constraint that shapes the whole design: **the tool_use↔tool_result pairing contract.** The
assistant message (already appended, `agent.ts:250`) contains a `tool_call` block per requested call;
providers (Anthropic especially) **400** if a subsequent turn has an assistant `tool_use` with no
matching `tool_result`, or a `tool_result` with no matching `tool_use`. So a wave seam may **reorder**
execution and **drop** a call, but every *original* call id must still receive *a* result, and no result
may reference an id that was not in the assistant message. (See KDD-1.)

## 2. Deliverables

- [ ] **D1** `beforeDispatch` filter point (`events.ts`): value `ToolCallBlock[]` (the calls to
  dispatch), context `{ turn: number }`. Applied in `run()` **after** the existing `calls.length === 0`
  no-calls check (`agent.ts:257`) — so it runs only when the assistant actually emitted `tool_call`
  blocks (there are committed `tool_use`s to pair). The originally-no-tools case keeps today's path
  untouched.
- [ ] **D2** `run()` honors a **subset/permutation** of the original calls: it dispatches exactly the
  returned calls whose id is among the originals (in returned order; unknown injected ids ignored —
  KDD-2), then **always** assembles a tool message in which **every original call id** gets a
  `tool_result` — a dispatched call's real result, and a **dropped** original id a synthetic neutral
  result (`"(skipped by a beforeDispatch hook)"`, `isError:false`). **Even when the dispatch set is empty
  (drop-all), the tool message of all-synthetic results is still emitted** — it does NOT fall through to
  the no-calls path (that would orphan the committed `tool_use` blocks → provider 400). The loop then
  continues to the next `streamTurn` (the model sees the skip results), exactly as after any normal wave.
- [ ] **D3** Default (no handler) → `apply` returns the calls unchanged → byte-identical to today
  (same order, same results, no synthetic entries).
- [ ] **D4** Tests: reorder changes execution order but results map back by id and the transcript pairs
  1:1; dropping a call yields a synthetic skip-result for its id (pairing preserved, the dropped tool
  does not execute); returning `[]` (drop-all) still emits a tool message of all-synthetic results
  (pairing preserved) and the loop continues; an unknown injected id is ignored; default byte-identity;
  `kernel-surface` green.

## 3. Scope Boundary (NOT in scope)

- **No injection** of brand-new call ids (a result with no matching assistant `tool_use` breaks pairing
  on the next turn; supporting it would require mutating the already-emitted assistant message — deferred).
- **No** drop of a call as a *security veto* — that is `beforeToolCall`'s job (its `block` returns a
  proper error `tool_result`, pairing-safe). `beforeDispatch` is for **wave-shape** (reorder/dedupe/drop
  redundancy), not per-call authorization.
- **No** change to `dispatch()` concurrency/order guarantees (it still runs the list it's given,
  honoring `maxConcurrency` and returning results in the order it received them). The kernel does **not**
  dedupe or rewrite the returned list — it dispatches whatever it's given for ids matching the originals
  (a handler that returns the same id twice double-executes; pairing stays 1:1 by id; dedupe/arg-rewrite
  are the handler's choice / `beforeToolCall`'s job).
- **No** new infinite-loop bound: a handler that perpetually drops a re-emitted wave is bounded by the
  existing `maxTurns` (the outer turn loop, `agent.ts:231/299`), exactly like a perpetually-blocking
  `beforeToolCall` — no per-turn counter is needed (unlike `onProviderError`, which loops *within* a turn).
- **No** new `tool_batch_end` change (it stays observe-only). It carries the **actually-dispatched**
  results (executions) — so after a drop/reorder it intentionally differs from the transcript tool message
  (which additionally carries synthetic skip-results for dropped ids, for pairing). Documented as an
  intended divergence (KDD-5): `tool_batch_end` = "what ran"; the transcript = "every original id paired."
- **No** sharing of `beforeDispatch` to sub-agents in this subsystem: it is **not** added to
  `SHARED_FILTER_POINTS` (`hooks.ts:49`), so a `childScope` child's wave runs its own (empty → passthrough)
  `beforeDispatch` chain. Children are already governed on the tool path by the shared `beforeToolCall`;
  wave-shaping is an optimization a parent applies to its own waves. Sharing it is a deferred option
  (KDD-6) if wave-governance-for-children is later wanted.

## 4. Key Design Decisions

### KDD-1 — Preserve tool_use↔tool_result pairing (the central constraint)
*Problem:* a wave seam that changes the dispatched set risks orphaned `tool_call`s/`tool_result`s →
provider 400. *Options:* (a) let handlers return any list and pass results straight through (unsafe —
dropped originals become orphaned `tool_use`s); (b) the kernel reconciles: dispatch the returned subset,
then emit a `tool_result` for **every original id** (real result if dispatched, synthetic neutral
result if dropped), ignoring any returned id not in the originals. *Choice:* **(b)** — it makes
reorder/drop safe by construction and keeps the provider contract exact. *Rejected:* (a) produces
intermittent provider 400s that are hard to debug.

### KDD-2 — Reorder + drop, but NOT inject
*Problem:* the blueprint listed "reorder/dedupe/drop/inject." *Options:* (a) support all four; (b)
reorder + drop only. *Choice:* **(b)** — inject requires a matching assistant `tool_use` for the new id
(else an orphaned `tool_result` next turn), which means mutating the already-appended assistant message
— out of proportion to the value. Dedupe is expressible as *drop the duplicate* (the dropped id gets the
synthetic note; the kept one runs). Inject is deferred to a future design that also handles the
assistant-message side. *Rejected:* (a) couples the seam to transcript mutation.

### KDD-3 — Apply AFTER the no-calls check; empty dispatch ≠ no-calls path; default byte-identical
*Problem:* where to apply, and how does drop-all stay pairing-safe? *Options:* (a) apply *before* the
`calls.length===0` check so `return []` falls through to the no-calls path; (b) apply *after* the no-calls
check (only when the assistant emitted real `tool_call`s), and treat an empty dispatch set as
"all-synthetic tool message," never the no-calls path. *Choice:* **(b)**. (a) is **unsafe** (L1 review
S1): the assistant message with its `tool_use` blocks is already appended (`agent.ts:250`), so routing a
drop-all to the no-calls path (`agent.ts:257-268`, which emits *no* tool message) orphans those
`tool_use`s → provider 400 on the next `streamTurn`. (b) keeps the genuinely-no-tools path
(`originalCalls.length===0`) exactly as today, and for a real-but-fully-dropped wave emits a tool message
of all-synthetic skip-results (pairing intact) then continues. With no handler, `hooks.apply` returns the
list unchanged (`hooks.ts` passthrough): all originals dispatch in order, every result is real, no
synthetics — byte-identical. *Rejected:* (a) is the orphaned-`tool_use` bug.

### KDD-4 — Drop produces a neutral (non-error) synthetic result
*Problem:* what content for a dropped id's synthetic `tool_result`? *Options:* (a) `isError:true`;
(b) `isError:false` neutral note. *Choice:* **(b)** — a drop is a deliberate wave-shaping decision, not
a tool failure; an error result would trip `recovery`/`circuit-breaker`/`limits` error accounting
spuriously. The note keeps the model informed without signaling failure. *Rejected:* (a) pollutes error
metrics.

### KDD-5 — `tool_batch_end` reflects executions; transcript reflects all original ids; tool message keeps ORIGINAL order
*Problem:* under drop/reorder, what does the observe-signal `tool_batch_end` carry, and in what order is
the transcript tool message assembled? *Options:* (a) `tool_batch_end` mirrors the transcript (incl.
synthetics); (b) `tool_batch_end` carries only actual executions, while the transcript tool message
carries a result for every original id in **original** order (pairing is by-id, so order is free on the
wire — `anthropic.ts` matches `tool_use_id`). *Choice:* **(b)** — `tool_batch_end` is "what ran" (a
dropped call did not run, so it is absent; reordered calls appear in execution order); the **transcript**
is "every original id paired," assembled in **original** order for determinism. **The `terminate` guard
(`agent.ts:294`, `results.every(r => r.result.terminate)`) likewise reads the EXECUTED set, not the
all-id reconciled set** — otherwise a synthetic skip-result (whose `terminate` is falsy, KDD-4) would
mask a real `terminate:true` and wrongly continue the loop. So **only the transcript tool message uses
all original ids**; `tool_batch_end` AND the `terminate` check use the executed results. (Edge: if a wave
is fully dropped, the executed set is empty → `[].every(...)` is `true`; guard against an empty executed
set so a drop-all does not spuriously terminate — treat empty-executed as "not terminating", continue.)
*Rejected:* (a) blurs "executed" with "paired-for-protocol" and would make `circuit-breaker`/`limits`
(which observe executions) count synthetic skips and could mis-terminate.

### KDD-6 — `beforeDispatch` is NOT shared to sub-agents (this subsystem)
*Problem:* should a `childScope` child's wave run the parent's `beforeDispatch`? *Options:* (a) add it to
`SHARED_FILTER_POINTS` now; (b) leave it unshared, defer. *Choice:* **(b)** — Wave 3 deliberately shares
only the *gate* filters `{beforeToolCall, afterToolCall}` (security governance); `beforeDispatch` is
wave-shaping/optimization, and children remain governed on the tool path by the shared `beforeToolCall`.
Adding it to `SHARED_FILTER_POINTS` is a one-line follow-up if wave-governance-for-children is wanted;
not bundling it keeps this subsystem from reaching into Wave 3's childScope contract. *Rejected:* (a) is
scope creep across subsystems with no current consumer.

## 5. Dependencies and Assumptions

Independent of the other Wave-6 subsystems. Assumes the assistant message's `tool_call` ids are unique
within a wave (they are — provider-generated). Assumes `dispatch()` already maps results back to calls
by position and the kernel re-keys to ids when building the tool message (it does — `agent.ts:280-287`
maps each result to `r.call.id`). The reconciliation (D2) keys the per-original-id results from the
dispatched results by id, then fills synthetics for any original id absent from the dispatched set.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P2.2. Relates to `2026-06-28-governed-subagents.md`: `childScope` shares
**only** `{beforeToolCall, afterToolCall}` (`hooks.ts:49`), so `beforeDispatch` is **not** inherited by a
child's wave (KDD-6) — a child runs its own empty→passthrough chain. Complements
`2026-06-22-tool-batch-end.md` (the observe-only wave signal — this adds the intervene counterpart). No
conflict. CLAUDE.md/README/EXTENSIONS/ARCHITECTURE filter-hook count (now **five** filter points) gains a
**sixth**; reconciled at F.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` exits 0. **AC-2** `npm test` exits 0 (existing + new).
- **AC-3** Reorder: a `beforeDispatch` handler returns the calls in reversed order; assert tools execute
  in the new order (observe via `tool_start` order) AND the tool message pairs each original id to its
  own result (1:1, content correct per id).
- **AC-4** Drop: a handler drops one of three calls; assert the dropped tool does **not** execute, its id
  still gets a `tool_result` with the neutral skip note (`isError` false), and the other two run normally.
- **AC-5** Drop-all (pairing-critical): for an assistant message with N≥1 `tool_call`s, a handler returns
  `[]`; assert (a) no tool executes, (b) a tool message IS emitted containing exactly one `tool_result`
  per original id, each the neutral skip note (`isError:false`), (c) the loop continues to the next
  `streamTurn` (it does NOT take the no-calls/end path), and (d) the next request has no orphaned
  `tool_use` (every `tool_use` has a matching `tool_result`). The genuinely-no-tools case (assistant
  emitted zero `tool_call`s) still takes the unchanged no-calls path and never invokes `beforeDispatch`.
- **AC-6** Inject-ignored: a handler returns an extra call whose id is not in the originals; assert that
  call does **not** execute and no orphan `tool_result` appears.
- **AC-9** Divergence/ordering: after a drop, `tool_batch_end` carries only the executed results (the
  dropped id absent) while the transcript tool message carries every original id (incl. the synthetic
  skip); the transcript tool message is in **original** order regardless of a reordered dispatch.
- **AC-7** Default byte-identity: with **no** handler, three calls dispatch in original order, results map
  1:1, and no synthetic results appear — identical to today.
- **AC-8** `kernel-surface.test.ts`: `src/kernel/` `< 2,200` lines; export list unchanged (the filter key
  is type-only).

*Quality budget:* the seam adds one `apply` over a tiny array + an O(n) id-reconciliation per wave;
negligible. Excluded.

## 8. Risks and Rollback

- **R1 — Pairing break (provider 400).** *Mitigation:* KDD-1 reconciliation guarantees every original id
  gets exactly one result and no orphan ids; AC-3/AC-4/AC-6 pin it. *Rollback:* drop the `apply` call.
- **R2 — Default behavior drift.** *Mitigation:* AC-7 byte-identity; `apply` passthrough with no handler.
  *Rollback:* revert to direct `dispatch(calls)`.
- **R3 — A dropped call's synthetic result confuses an extension that expects a real result.**
  *Mitigation:* the note is clearly marked; `isError:false` keeps error-accounting clean (KDD-4); the
  full suite (AC-2) is the net. *Rollback:* n/a (additive).
- **R4 — Kernel ceiling** (2,144/2,200, 56 lines free). *Mitigation:* the seam + reconciliation is
  ~20-30 lines; AC-8 enforces `< 2,200`. If it would cross, that is the agreed escalation (raise-or-defer),
  not silent bloat. *Rollback:* n/a.
- **R5 — Doc filter-hook count stale.** *Mitigation:* reconcile at F (now six filter points).

One filter point + an id-reconciliation block in `run()`; reverting the `apply` restores prior behavior.

## L1 Review Log

- **Round 1** — 2 SEVERE: S1 drop-all routed to the no-calls path orphans the committed `tool_use` blocks
  → provider 400 (contradicted KDD-1); S2 false childScope claim (beforeDispatch not in
  `SHARED_FILTER_POINTS`). + general (fifth→sixth; tool_batch_end divergence) + clarifications. Fixed:
  apply after the no-calls check; drop-all → all-synthetic tool message; KDD-6 (not shared); KDD-5.
- **Round 2** — zero severe + 1 general (the `terminate` guard + `tool_batch_end` must read the EXECUTED
  set, not the all-id reconciled set; empty-executed must not spuriously terminate). Fixed in KDD-5.
- **Round 3** — **zero severe, zero general** (confirmed `agent.ts:294` already guards `length>0`).
- **Round 4 (corroborating)** — **zero severe, zero general.** Cap-convergence
  ([[three-loop-cap-convergence-policy]]) — two-generation satisfied. **L1 closed.**
