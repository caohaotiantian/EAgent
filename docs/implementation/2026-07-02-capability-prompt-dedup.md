# L2 Implementation — CapabilityManager in-flight prompt dedup (KERN-1)

Status: draft
Slug: `2026-07-02-capability-prompt-dedup` (matches the design doc).
Design: `docs/design/2026-07-02-capability-prompt-dedup.md`.
Files: `src/kernel/capabilities.ts`, `test/capabilities.test.ts`. **Kernel change** — the hard ceiling
`test/kernel-surface.test.ts` (`< 2200`, split-metric; currently 2199) is a gating acceptance command.
No new dependency, no new exported symbol. `<TEST-CMD>` = `npm test`.

## Phase 1 — in-flight prompt dedup + comment-golf (one cohesive change)

**Scope:** dedup concurrent capability prompts; reclaim the added kernel lines by golfing verbose
comments so the kernel stays `< 2200`.

1. **Field.** Add, next to `#remembered` (`capabilities.ts:63`):
   `readonly #pending = new Map<string, Promise<boolean>>();`
   Merge the `#remembered` comment (`:62`) + the new field into ONE 1-line comment covering both
   (session prompt-answer memo + its in-flight dedup map) to save a line.
2. **Ask block.** Replace the current ask tail (`capabilities.ts:116-119`,
   `const ok = await this.#ui.confirm(...); this.#remembered.set(...); this.record(...); if (!ok) throw`)
   with the shared-promise dedup:
   ```ts
   // Concurrent callers needing the same unremembered cap share ONE confirm.
   let ask = this.#pending.get(capability);
   if (!ask) {
     // Single-line confirm().then() keeps the net add ~+6 (golf budget is tight — headroom 1).
     this.#pending.set(capability, (ask = this.#ui.confirm(`Allow ${source} to use capability "${capability}"?`).then((ok) => (this.#remembered.set(capability, ok), ok))));
     void ask.finally(() => this.#pending.delete(capability));
   }
   const ok = await ask;
   this.record(capability, ok ? "allow" : "deny", source, true);
   if (!ok) throw new CapabilityError(capability, "declined by user");
   ```
   Keep the `#remembered.set` OUT of the per-caller tail (it now lives in the shared `.then`, set once).
   Each caller keeps its own `record` + `throw` (per-caller audit + deny). `prompted: true` for a sharing
   caller is intended (design §4 — human-sourced decision).
3. **Comment-golf ≥ the net added lines** so `test/kernel-surface.test.ts` passes (`< 2200`). **The gate
   metric is `split("\n").length` summed over `src/kernel/*.ts` = 2199 today (slack 1), NOT `wc -l`
   (2187).** So the dedup's ~6 added lines land at ~2205 and golf is MANDATORY — reclaim ≥6 lines (aim
   ≤2199 for a little headroom). Run `node --import tsx --test test/kernel-surface.test.ts` after coding;
   it fails until enough is golfed. Apply the
   design's lossless candidates, header (`:1-20`) OFF-LIMITS. Strongest: compress the `fallback` JSDoc
   (`capabilities.ts:48-51`, 4 lines) to 1-2 without losing "Default ask / allow-for-trusted /
   deny-for-locked-down"; also the two `AuditEntry` field comments (`:36,:38`) and the merged field
   comment (step 1). If `capabilities.ts` alone is short of the target, golf ONE verbose comment in a
   sibling `src/kernel/*.ts` at the same lossless bar (no "why" lost). **Do not** touch the `:1-20`
   header, code logic, or any rule. Run `test/kernel-surface.test.ts` locally to confirm `< 2200`.

**Acceptance (`<ACCEPT-CMD>`):**
- `node --import tsx --test test/capabilities.test.ts` exit 0 with NEW tests using a `DeferredUI` (a
  `UI` whose `confirm` increments a counter and returns a promise the test resolves manually — include
  `notify: () => {}` to satisfy the `UI` type, matching the existing stubs):
  (a) **dedup** — `await Promise.all([mgr.require("net:fetch","a"), mgr.require("net:fetch","b")])` after
  resolving the deferred confirm to `true` → the confirm counter is **1**, both resolve, and the audit
  has **2** entries (one per caller, both `prompted:true`);
  (b) **deny** — same with the confirm resolved `false`, but use `Promise.allSettled([require a, require
  b])` (NOT `Promise.all`, which short-circuits on the first rejection) and assert **both** settled as
  rejected `CapabilityError`, one confirm; and `#remembered` holds `false` (a subsequent
  `require("net:fetch")` throws "previously declined" WITHOUT a new confirm — counter still 1);
  (c) **fresh cap after settle** — a second wave for a DIFFERENT unremembered cap prompts once (memo not
  leaked / not cross-contaminated).
- `node --import tsx --test test/kernel-surface.test.ts` exit 0 (**kernel `< 2200`** — the ceiling gate).
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · no new dependency · the public
  kernel export surface unchanged (kernel-surface pins it).

## Notes

- Existing `test/capabilities.test.ts` sequential paths (allow/deny/remembered/grant/deny-rule/fallback +
  the existing sequential remembered test) must stay green — the change only affects the *concurrent* ask
  path.
- Trace test: every changed line maps to KERN-1's dedup Deliverable or the golf Deliverable. No drive-by
  edits, no workflow/round provenance in comments.

## Closure

Status: closed
Closing-commit: 8455381
Closed-on: 2026-07-02
Deferred: none. See the design doc's closure. L3 closed clean-first-round; F pass; kernel 2198 (< 2200).
