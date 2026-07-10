# Design — Capability grant revocation across unload/reload (Cycle E)

Slug: `2026-07-10-capability-revocation`
Status: draft

## 1. Background and Purpose

`grantCapability` is the one `ExtensionAPI` registration NOT tracked as a `Disposable`:
`src/kernel/extension.ts:243` — `grantCapability: (pattern) => host.agent.capabilities.grant(pattern)`
— compare the tracked siblings at `:238-242` (`registerTool`/`Provider`/`Command`/`on`/`hook` all
`track(...)`). `CapabilityManager.grant` (`capabilities.ts:71-73`) pushes onto `#grant` and there is
**no revoke**. So when an extension is unloaded or hot-reloaded, its granted patterns persist on the
shared manager: a later or re-registered tool declaring one runs **without** the capability
ask-prompt a fresh session would require. This is a monotonic privilege leak on the one enforced
security boundary — the boundary the rest of the hardening batch tightens.

The granted patterns leak in practice: `agent:spawn` is granted by six extensions
(`subagents`/`teams`/`subagent-jobs`/`reasoning-search`/`sweep-edit`/`templates`), `fs:read`/`fs:write`
by three (`core-tools`/`journal`/`session`), `mcp:call`/`mcp:read` by `mcp`, `self:read` by `self`,
`workflow:run` by `dynamic-workflow`, `ui:ask` by `ask`, `skill:read` by `skills`.

If we do nothing: unloading any granting extension leaves its authority behind — the trust boundary
is write-only.

## 2. Deliverables

- [ ] **D1** — `CapabilityManager.grant(pattern)` returns a `Disposable` and treats `#grant` as a
      **multiset** (always push; dispose splices out one instance), so a pattern is revoked only when
      its last granter disposes — correct reference counting for shared grants, with no separate
      counter. The dispose is **idempotent** (a `disposed` guard) because it splices *by value*
      (`indexOf(pattern)`), unlike the kernel's other disposables which splice by object identity and
      are self-idempotent — without the guard a double-dispose would splice a sibling holder's
      identical string and over-revoke a live grant. Concrete committed form (packed one-liner, kernel
      dense style, e.g. `capabilities.ts:113`):
      ```ts
      grant(pattern: string): Disposable {
        this.#grant.push(pattern);
        let disposed = false;
        return { dispose: () => { if (disposed) return; disposed = true; const i = this.#grant.indexOf(pattern); if (i >= 0) this.#grant.splice(i, 1); } };
      }
      ```
      Import `Disposable` by extending the existing `import type { UI } from "./types.js"` → `{ Disposable, UI }` (+0 lines).
- [ ] **D2** — `extension.ts:243` wraps the grant in the existing `track(...)` so a granted
      capability disposes on unload/reload exactly like every other registration. The `ExtensionAPI`
      `grantCapability(pattern): void` signature is **unchanged** (the host tracks the Disposable
      internally; extension authors still see `void`).
- [ ] **D3** — Tests: (a) an extension that grants `test:cap`, once unloaded, no longer has it
      (`isGranted` false); (b) **shared-grant ref-counting** — two extensions grant `shared:cap`;
      unloading ONE leaves it granted, unloading BOTH revokes it; (c) a baseline (constructor) grant
      is never revoked. **AC1/AC2 are the behavioral RED-before-fix discriminators** (pre-fix `grant`
      returns `void`, so nothing revokes and the grant persists, failing the "no longer granted"
      assertions). AC3 is a **post-fix correctness pin**, not a behavioral red (pre-fix there is no
      revocation to break — only a structural `TypeError` from `.dispose()` on the `void` return).
- [ ] **D4** — The kernel stays under the 2250-line ceiling (`test/kernel-surface.test.ts`, which
      asserts `lines < 2250`; usable headroom is 5, since 2250 fails). The committed D1 form is **+2
      net lines** in `capabilities.ts` (the current 3-line `grant` body → a 5-line body: signature,
      push, `let disposed`, the packed-one-liner return, close); the import folds into an existing line
      (+0); `extension.ts:243` wraps via `track(...)` on the same line (+0). Expected post-change
      kernel = **2246 < 2250 — no bump, no golfing**. If a later revision of this design ever exceeded
      the ceiling, that is a fresh decision to **escalate to the user**, not an assumed authorization.

## 3. Scope Boundary (NOT in scope)

- **No ceiling bump, no unrelated golfing** — the fix is designed to fit the existing slack (2244/2250).
- **No change to the ask/deny/allow decision logic**, the audit log, `matchPattern`, wildcard
  semantics, or the fallback policy — only `grant` gains a revocable, ref-counted form.
- **No new public method on the `ExtensionAPI`** — `grantCapability` stays `void`; revocation is the
  host's internal `track()` teardown. No new kernel export (the pinned surface in
  `test/kernel-surface.test.ts` is unchanged).
- **No `deny`-revocation, no per-source grant attribution, no `/capabilities` command change.**
- **Per-*package* grant revocation is out of scope.** Because `grantCapability` stays `void` (KDD2),
  the host discards the grant-Disposable internally, so the `packages.ts:378` shim cannot route a
  grant through its per-package `record()`/teardown set the way it does tools/hooks/commands. Net:
  `/pkg-remove` of one installed package tears down its tools/hooks/commands but **leaves its
  capability grant in place** until the whole `packages` extension unloads/reloads. Closing this would
  require the return-value change KDD2 rejects; it is a deliberate non-goal here.

## 4. Key Design Decisions

### KDD1 — Reference counting via a multiset `#grant`, not a counter Map
- **Problem:** shared grants (`agent:spawn` from six extensions) mean a naive `ungrant(pattern)` that
  removes the pattern would revoke it for the other five holders — a correctness bug.
- **Options:** (A) treat `#grant` as a **multiset** — `grant` always pushes (dropping the current
  dedup); the returned Disposable splices out exactly one instance; the pattern is gone only when the
  last instance is removed. (B) add a `Map<pattern, count>` alongside `#grant` and add/remove from
  `#grant` on the 0↔1 transitions. (C) simple `ungrant` (over-revokes).
- **Choice: (A).** `matchesAny`/`isGranted` already test membership with `.some()`
  (`capabilities.ts:139`), which is **duplicate-invariant**, so a multiset needs no other code change
  and no extra field — the array itself is the count. It is the smallest correct change (≈+1 kernel
  line), which is exactly why it fits the ceiling. **Reject (B):** a parallel counter Map is more
  state and more lines for identical behaviour. **Reject (C):** over-revokes shared grants — incorrect.
- Dropping the `if (!includes)` dedup is safe: nothing iterates `#grant` expecting uniqueness
  (`matchesAny` `.some()`, `isGranted`, the audit log never reads `#grant` contents); duplicates only
  ever mean "N holders."

### KDD2 — Revocation via `track()`, not a new `ExtensionAPI` method
- **Problem:** how does the extension host revoke a grant on unload/reload?
- **Options:** (A) `grant` returns a `Disposable`, and `extension.ts` wraps it in the **existing**
  `track()` (the same mechanism that disposes tools/hooks/commands on unload). (B) add an
  `ungrantCapability`/`revoke` method to `ExtensionAPI` and call it in the host's unload path.
- **Choice: (A).** It reuses the host's proven registration-tracking (`combine(...disposables)` on
  unload/failed-activation, `extension.ts:229-262`), so a granted capability behaves like every other
  registration with zero new surface — no `ExtensionAPI` change, no kernel export change (the pinned
  surface is unchanged). **Reject (B):** a new public method + a manual unload-path call is more
  surface and a second teardown path to keep in sync; `track()` already handles the partial-activation
  failure case (`extension.ts:262` `combine(...).dispose()`), which a manual method would miss.

## 5. Dependencies and Assumptions

- `Disposable` is `{ dispose(): void }` (`types.ts`); `track<T extends Disposable>(d): T` records `d`
  in the per-activation `disposables[]` (`extension.ts:229-232`) and returns it; on unload/reload/
  failed-activation the host disposes them all.
- `matchesAny(cap, #grant)` uses `.some(p => matchPattern(cap, p))` (`capabilities.ts:138-139`) —
  duplicate-invariant.
- The `ExtensionAPI.grantCapability` type is `(pattern: string): void` (`extension.ts:55`); TS permits
  a value-returning impl to satisfy a `(): void` type, so `grantCapability: (pattern) =>
  track(host.agent.capabilities.grant(pattern))` type-checks (the `void` operator is an optional,
  stylistic explicit-discard, not required).
- Double-dispose safety does **not** rely on a "disposed exactly once" caller contract: the D1
  Disposable is self-idempotent via its `disposed` guard (matching the effect the kernel's other
  disposables get from identity-based splices).
- **Baseline grants** (constructor `opts.grant`, `capabilities.ts:60`) are added once and are **not**
  Disposable — they are the host's standing policy and are never revoked. Only runtime `grant()`
  returns a Disposable.
- **Measured baseline (this branch):** kernel 2244/2250; suite 1313 pass / 0 fail / 1 skip; typecheck 0.

## 6. Relationship with Existing Designs

- Completes the security-boundary hardening of the batch (which fixed the guards, MCP env, and
  recursion) by making the capability layer's one write-only path revocable. No conflict; no other
  design touches `CapabilityManager.grant`.
- `packages.ts:378` re-exposes `grantCapability` to an installed package's `activate`; its
  `(pattern) => e.grantCapability(pattern)` continues to work (it ignores the return). Those grants
  are tracked under the whole `packages` extension's teardown — but **not** per-package (a `/pkg-remove`
  does not revoke the removed package's grant; see the §3 non-goal).

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (revoke on unload):** activate an inline extension that calls `e.grantCapability("test:cap")`;
  assert the manager grants it; unload the extension; assert `isGranted("test:cap")` is now false.
  RED before D2 (grant persists). Command: `node --import tsx --test test/capabilities.test.ts`.
- **AC2 (shared-grant ref-counting):** two inline extensions each grant `shared:cap`; unload ONE →
  `isGranted("shared:cap")` still true; unload the OTHER → false. This proves the multiset/ref-count
  (a simple ungrant would fail the first assertion). Same file (or `test/extension.test.ts`).
- **AC3 (baseline grant survives):** a `CapabilityManager` constructed with `grant:["base:cap"]`, then
  a runtime `grant("base:cap")` **on the same pattern** which is disposed, still keeps
  `isGranted("base:cap")` true — proving a same-string by-value splice removes exactly one instance,
  and since the baseline contributed one that is never disposed, at least one always survives (which
  physical slot `indexOf` removes is immaterial — the instances are fungible under `.some()`).
- **AC4 (ceiling + gates):** `node --import tsx --test test/kernel-surface.test.ts` passes (kernel
  < 2250, measured — no bump); `npm test` green (0 fail); `npm run typecheck` 0; `npm run eval` 5/5;
  `npm run build` 0. Existing `test/capabilities.test.ts` stays green (grant's new return type +
  dropped dedup must not break an assertion — verified at L3).

## 8. Risks and Rollback

- **R1 — dropping the dedup changes `#grant` to allow duplicates.** Safe: `matchesAny` `.some()` is
  duplicate-invariant, and no code reads `#grant` for uniqueness. Regression check (L3): confirm no
  existing test asserts `#grant` has no duplicates or that `grant` is idempotent by array identity.
  Rollback: revert D1.
- **R2 — `grant` return-type change (`void` → `Disposable`).** The only *source* caller of the kernel
  method `CapabilityManager.grant()` is `extension.ts:243` (updated). `packages.ts:378` calls the
  *ExtensionAPI* `grantCapability` (a level up, still `void`) and ignores its return. A few tests call
  `agent.capabilities.grant(...)` directly (`test/skills-hardening.test.ts`, `test/self-improve.test.ts:295`)
  — all ignore the return and are duplicate-invariant, so the change leaves them green. Rollback: revert.
- **R3 — kernel ceiling.** The committed D1 form is +2 net lines → kernel **2246 < 2250**, verified by
  `test/kernel-surface.test.ts` at L3. No bump. Should L3 measure the actual delta over the slack (a
  design-estimate miss), the loop **escalates to the user** for a golf target or an explicit ceiling
  decision — it is not assumed. Rollback: revert both files.
- **Overall:** two kernel files + tests; each independently revertible; branch
  `chore/production-hardening` (PR #40), not merged.
