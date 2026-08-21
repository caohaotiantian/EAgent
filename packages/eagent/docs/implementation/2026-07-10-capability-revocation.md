# Implementation — Capability grant revocation (Cycle E)

Slug: `2026-07-10-capability-revocation` (matches the design doc)
Status: closed
Closing-commit: Cycle E closeout on `chore/production-hardening`
Closed-on: 2026-07-10
Deferred: none (single phase, closed round 1).
Result: kernel 2246/2250; suite 1319 pass / 0 fail / 1 skip; typecheck 0; eval 5/5; build 0. The dev also flipped `test/ask.test.ts`'s "grant survives unload" test (which pinned the bug) to assert revocation.

## 1. Task Index

Design: `docs/design/2026-07-10-capability-revocation.md`. Deliverables D1–D4 → §2; Acceptance
AC1–AC4 → §7; KDD1/KDD2 → §4. This is a single-phase kernel change.

## 2. Phase Breakdown

`<TEST-CMD>` = `npm test`. One phase; tests before implementation.

### Phase 1 — revocable, reference-counted capability grants

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1313 pass / 1 skip;
  kernel 2244/2250).
- **Design references:** §2 D1–D4, §4 KDD1 (multiset + idempotent by-value splice), KDD2 (`track()`),
  §7 AC1–AC4, §8 R1–R3.
- **Task list (TDD order):**
  1. **T1.1 (unit tests)** — add to `test/capabilities.test.ts` (which already exercises
     `new CapabilityManager(...)`). Construct managers with the **default (`ask`) or an explicit
     non-`allow` fallback** so `isGranted` returns `false` for an ungranted cap (an `allow` fallback
     would mask revocation). Protected invariant: *a runtime grant is revocable and
     reference-counted — a shared pattern survives until its last granter disposes, a baseline grant
     is never revoked, and a double-dispose never over-revokes a sibling.* Cases:
     - **single revoke:** `const d = mgr.grant("test:cap")`; `isGranted("test:cap")` true; `d.dispose()`;
       `isGranted("test:cap")` false.
     - **ref-counting (AC2):** `const a = mgr.grant("shared:cap"); const b = mgr.grant("shared:cap");`
       `a.dispose()` → `isGranted("shared:cap")` still true; `b.dispose()` → false.
     - **baseline survives (AC3):** `const mgr = new CapabilityManager({ grant: ["base:cap"] });`
       `const d = mgr.grant("base:cap"); d.dispose();` → `isGranted("base:cap")` still true.
     - **double-dispose idempotent:** `const d = mgr.grant("i:cap"); d.dispose(); const d2 =
       mgr.grant("i:cap"); d.dispose();` (second dispose of `d`) → `isGranted("i:cap")` still true
       (the guard prevents `d`'s second dispose from splicing `d2`'s instance).
     These ERROR/RED pre-fix (`grant` returns `void`, so `d` is `undefined` and `d.dispose()` throws).
  2. **T1.2 (integration test)** — add to `test/extension.test.ts` (which has `host.use`/`host.unload`
     and an `agent`). Protected invariant: *a granted capability is torn down on unload/reload like
     every other registration.* **Construct the harness with `makeHarness({ fallback: "deny" })`** —
     `isGranted` returns `this.#fallback === "allow"` for an ungranted cap (`capabilities.ts:126`), so
     under the default `fallback:"allow"` the "no longer granted" assertion would be `true` even after
     a correct revoke and the test could never go green. Then:
     `await host.use("granter", (e) => { e.grantCapability("ext:cap"); });` →
     `agent.capabilities.isGranted("ext:cap")` true; `await host.unload("granter")` →
     `isGranted("ext:cap")` false. RED pre-fix (grant not tracked → persists). Add a reload variant if
     cheap.
  3. **T1.3 (impl D1)** — `src/kernel/capabilities.ts`: change `grant(pattern: string): void` (`:71-73`)
     to return a `Disposable` per the design's committed form (always push — drop the `includes`
     dedup; `let disposed = false`; return a `disposed`-guarded by-value `indexOf`/`splice` one-liner).
     Extend the import at `:22` to `import type { Disposable, UI } from "./types.js";`.
  4. **T1.4 (impl D2)** — `src/kernel/extension.ts:243`: wrap the grant in the existing `track(...)`:
     `grantCapability: (pattern) => track(host.agent.capabilities.grant(pattern)),`. The
     `ExtensionAPI.grantCapability(pattern): void` signature (`:55`) is unchanged (the value-returning
     impl satisfies the `void` slot).
  5. **T1.5 (verify ceiling)** — `node --import tsx --test test/kernel-surface.test.ts` must pass
     (kernel `< 2250`); the change is +2 net lines → **2246**. If the measured count is ≥ 2250 (a
     design-estimate miss), STOP and escalate — do not bump the ceiling or golf unrelated code without
     the user's decision.
- **Per-task acceptance commands:**
  - `node --import tsx --test test/capabilities.test.ts test/extension.test.ts`
  - `node --import tsx --test test/kernel-surface.test.ts`
- **Exit condition:** those green; `npm test` green (0 fail); `npm run typecheck` 0; `npm run eval`
  5/5; `npm run build` 0. Regression check (R1): confirm no existing `test/capabilities.test.ts`
  assertion depends on `#grant` having no duplicates or on `grant` being idempotent-by-array-identity.

## 3. Engineering Constraints Index

- **Engineering norms** — `CLAUDE.md`: ESM `.js` specifiers; strict TS (`noUncheckedIndexedAccess`);
  zero deps except jiti; capabilities are the security vocabulary; the kernel is under the 2250-line
  ceiling (this change lands at 2246); **kernel change** touches only `src/kernel/capabilities.ts` +
  `src/kernel/extension.ts` + `test/*`; no new kernel export (the pinned surface in
  `test/kernel-surface.test.ts` is unchanged — `grant` is a method, `Disposable` already exported).
- **Four-corner template** — `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):`/`fix(phaseN-roundR): <keyword>`; result trailers; no
  AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse `test/capabilities.test.ts`'s direct `new CapabilityManager(...)` pattern and
  `test/extension.test.ts`'s `host.use`/`host.unload`/`agent.capabilities` harness. No new fixtures.

## 5. Regression Protection

Must stay green:
- `test/capabilities.test.ts` (grant/deny/ask/wildcard/audit/dedup semantics — the multiset must not
  change any observable decision), `test/extension.test.ts` (unload/reload teardown),
  `test/kernel-surface.test.ts` (ceiling + export pin).
- Full suite `npm test`; final gate adds `npm run eval` (5/5) and `npm run build`.
- **Other direct `.grant()` callers** (all ignore the return value and are duplicate-invariant, so the
  return-type change + dropped dedup leave them green — confirm): `test/skills-hardening.test.ts`
  (several `agent.capabilities.grant(...)` calls) and `test/self-improve.test.ts:295`.
