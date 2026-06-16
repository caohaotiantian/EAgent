# Light-Mode brief — tool-description-change detection (integrity)

Slug: `2026-06-16-tool-description-change-detection`
Tier: Light (≤3 non-load-bearing files: `src/extensions/integrity.ts` + `test/integrity.test.ts`;
no breaking change; no new external contract; no unresolved >1-option / threshold decision)
Status: closed

## What / why

The `integrity` extension already scans every registered tool's *description* for poisoning patterns
(Wave 3/4). It does not catch a **rug-pull / silent-update poisoning**: a tool whose description was
benign when the operator approved it, then changes to carry hidden instructions on a later
update/reconnect (the documented cross-server / version-swap vector, CVE-2025-54136 class). Add
**description-change detection**: `integrity` persists a per-tool fingerprint of each registered
tool's description and, on `session_start`, warns when a tool's description has changed since the last
recorded baseline; `/integrity` reports current drift on demand. This closes the "approved benign,
swapped malicious" gap with the same observe-and-warn posture, zero kernel change.

## Explicit non-goals

- **Not blocking** — warn/report only, exactly like the existing poisoning sweep (a description
  change can be legitimate; the human reviews).
- **Not** tracking non-description changes (parameters/behavior/capabilities) — only the description
  text the model reads.
- **Not** within-session detection — drift is checked against the persisted baseline, re-baselined on
  `session_start`. (A tool re-registered mid-session is reported by the on-demand `/integrity`.)
- **No new poisoning patterns** — reuse the existing `detectSuspiciousDescription`.
- **No new persistence dependency** — reuse the extension's own `e.store`.
- Not cross-machine / cross-user; the baseline is whatever this extension's store holds.

## >1-option decision surfaced

Fingerprint representation: **store a cheap hash of each description keyed by tool name** (chosen) vs
storing full description strings. Hash chosen — we only need change-detection, not a textual diff, and
a hash keeps the store small and avoids persisting (possibly large/sensitive) description text. Clear
winner, no escalation needed.

## Measurable acceptance command

- `node --import tsx --test --test-name-pattern="description changed" test/integrity.test.ts` → exit 0
  (a tool whose description changes since the recorded baseline is reported by `/integrity`).
- `node --import tsx --test test/integrity.test.ts` → exit 0 (new + existing integrity tests).
- Gates: `npm run typecheck` → 0; `npm test` → 0 (incl. `test/kernel-surface.test.ts`, no kernel
  growth); `npm run build` → 0.

## Closure note

Closed 2026-06-16. Implemented in `src/extensions/integrity.ts` (+ `test/integrity.test.ts`):
per-tool description fingerprint baseline persisted in the extension store; `session_start` warns on
drift then re-baselines; `/integrity` reports drift on demand. Fresh-reviewer diff review **pass**
(zero severe, zero general; Light tier confirmed, all Full-Mode gates negative; tests verified as real
invariant guards by mutation). Gates: `npm test` 207 passed (exit 0), `npm run typecheck` 0,
`npm run build` 0, `test/kernel-surface.test.ts` green (no kernel growth). Deferred: none.
