# Light-Mode brief — secret-guard arg-scan depth bound (GUARD-1)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-02

**Slug:** `2026-07-02-secret-guard-scan-depth` · **Tier:** Light (`src/extensions/secret-guard.ts` +
`test/secret-guard.test.ts`; additive depth bound mirroring an existing sibling constant, no breaking
change, no new contract, no unresolved decision). Source: `docs/DEFERRED-FOLLOWUPS.md` GUARD-1. Branch:
`chore/audit-gaps-2`.

## What / why

`secret-guard` (default **ON**) scans a tool call's args for secret-shaped strings via a recursive
`walk` (`secret-guard.ts:81-91`) that descends arrays/`Object.values` with **no depth bound**, over
model-authored `ctx.call.arguments`. On a pathologically deep payload (~20k nesting) the recursion
overflows the stack → `RangeError`; the module's fail-open catch (`:126-130`) then returns the decision
unchanged, so a co-located plaintext credential reaches an egress/exec tool **unscanned**. The **sibling
guard `provenance` already bounds the identical scan** (`provenance.ts:48,56-65`, `MAX_SCAN_DEPTH = 8`);
secret-guard is the inconsistent one.

**Change:** thread a depth bound through `walk`, mirroring provenance exactly: add `const MAX_SCAN_DEPTH
= 8;` and `walk(v, depth)` — a string leaf is always scanned; below `depth <= 0` the walk stops
descending into arrays/objects; recurse with `depth - 1`. Call `walk(args, MAX_SCAN_DEPTH)`.

## Explicit non-goals (Simplicity First)

- Value `8` is **not a new decision** — it mirrors provenance's existing `MAX_SCAN_DEPTH` (the two guards
  scan the same shape; keeping them equal is the point). No env knob.
- No change to `scanSecrets` (the per-string regex set), the fail-open catch, the default-ON posture, or
  the LLM-confirm flow. `risk-guard`'s separate unbounded `stringLeaves` is OFF by default and out of
  scope (its own item if pursued).
- No new capability, dependency, or kernel change.

## Any >1-option decision surfaced

None. The fix is the provenance pattern applied to the sibling guard; the depth constant is inherited,
not chosen.

## Measurable acceptance command

- `node --import tsx --test test/secret-guard.test.ts` exit 0 — a NEW test: an args object with a secret
  at a shallow key **plus** a ~20 000-deep nested sibling value (a) does **not** throw / the scan returns
  normally, and (b) the shallow secret is still detected (the guard blocks/asks rather than fail-open
  allowing). Reverting the depth bound makes the deep-payload case RangeError → fail-open → the secret is
  NOT surfaced (the discriminator). A control: a normally-nested secret (≤8 deep) is still detected
  (byte-identical behavior for realistic payloads).
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-02. `secret-guard`'s `scanArgs` `walk` is now depth-bounded at `MAX_SCAN_DEPTH = 8`
(mirroring `provenance`), so a pathologically deep arg can't overflow the stack → the fail-open catch →
an unscanned-secret bypass. Byte-identical for realistic (≤8-deep) payloads. Light-Mode fresh review
**pass** (clean first round; reviewer empirically confirmed the revert RangeErrors → genuine
discriminator; provenance-matching semantics, no off-by-one). Gates: secret-guard 20 pass, `npm test`
1183 pass / 0 fail / 1 skip, typecheck 0, eval 5/5, `src/kernel/` untouched, no new dependency.
