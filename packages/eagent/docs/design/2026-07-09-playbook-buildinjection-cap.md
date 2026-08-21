# Light-Mode brief: playbook `buildInjection` first-bullet byte-cap edge (D2)

Task slug: `2026-07-09-playbook-buildinjection-cap`
Cycle 2 of "finish all deferred tasks". Resolves the D2 deferred finding in
`docs/design/2026-07-09-playbook-extension.md`'s closure block.

## What / why

`buildInjection` (`src/extensions/playbook.ts:107`) documents an invariant: "the
returned text's utf8 byte length is `<= maxBytes`." It reserves the truncation-marker
bytes only *when it includes a bullet*. If even the **first** bullet does not fit
(`lines` stays empty), it still returns `HEADER + "\n" + marker(all)` — whose byte
length can exceed `maxBytes` when `maxBytes` is smaller than that header+marker text
(~74 bytes for the default header). Reachable only under a pathologically small
`playbook.maxBytes` override (or a single bullet larger than `maxBytes`), but it
violates the stated `<= maxBytes` invariant.

**Fix:** after building `out`, add a final guard — if `Buffer.byteLength(out,"utf8")
> maxBytes`, return `undefined` (inject nothing). This only ever triggers in the
empty-`lines` case (when `lines` is non-empty the loop's `used + markerReserve` check
already guarantees `<= maxBytes`), so it restores the invariant with no change to any
non-pathological path. Injecting nothing when not even one bullet fits is also the
right degradation — a content-free "N more not shown" note carries no insight.
`injectPlaybook` already treats an `undefined` note text as "nothing to inject"
(returns `messages` by reference), so no caller change is needed.

## Explicit non-goals

- No change to the fill algorithm, the marker, `MAX_INJECT_BYTES` (8 KB), or the
  per-turn injection behavior for any non-pathological `maxBytes`.
- No partial-bullet truncation (the design's whole-bullet fill decision stands).
- No new config/threshold; the guard uses the existing `maxBytes`.
- Not touching any other extension or the deferred D1/Cycle-1 items.

## >1-option decision surfaced

One considered alternative — when `lines` is empty but `HEADER+marker` *does* fit,
keep returning the marker-only note (current behavior) and only drop to `undefined`
when even that overflows. The chosen final-guard (`byteLength(out) > maxBytes →
undefined`) does exactly this: it preserves the marker-only note whenever the budget
can afford it and returns `undefined` only when it cannot — the minimal change that
restores the invariant. No harder-to-call decision remains (if it did, this would be
Full Mode).

## Measurable acceptance command

`node --import tsx --test test/playbook.test.ts` (new assertion: `buildInjection([oneBullet], tinyMaxBytes)`
where `tinyMaxBytes` < `HEADER+marker` bytes → returns `undefined`; and a case where
`HEADER+marker` fits but the bullet does not → returns a marker-only note whose
`Buffer.byteLength(text,"utf8") <= maxBytes`), plus `npm run typecheck` exit 0 and
`npm test` exit 0.

## Closure note

Status: closed. Light-Mode diff review passed clean (tier gate re-confirmed
Light-valid). `buildInjection` now returns `undefined` when even the header+marker
exceeds `maxBytes`, restoring the documented `<= maxBytes` invariant; the guard
never fires on any non-pathological `maxBytes` (verified: no default-8KB behavior
change). Acceptance: `test/playbook.test.ts` 9/9 (incl. the D2 edge test), `npm run
typecheck` exit 0, `npm test` 1275 pass / 0 fail. Resolves the D2 deferred finding
in `docs/design/2026-07-09-playbook-extension.md`.
