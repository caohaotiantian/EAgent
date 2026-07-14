# Implementation — Hardened server profile (Cycle 1)

Slug: `2026-07-11-hardened-server-profile` (matches the design doc)
Status: **closed** (2026-07-11) — L3 Phase 1 (`8f6643e`) + Phase 2 (`a7d9ddc`), each dev→review→accept
via l3-phase.js round 1, PhaseEnd-verified by the main agent; F review passed zero-severe. See the
design doc closure block for the result summary + accepted NITs.

## 1. Task Index

Design: `docs/design/2026-07-11-hardened-server-profile.md`. Deliverables D1–D6 → design §2;
Acceptance AC1–AC8 → design §7; KDD1–KDD4 → §4; precedence model → D2. Two phases: **Phase 1** builds
the `LayeredConfig` preset mechanism (D2 core); **Phase 2** wires `hardened` end-to-end (D1, D3–D6).

`<TEST-CMD>` = `npm test`.

## 2. Phase Breakdown

### Phase 1 — `LayeredConfig` runtime preset layer (fail-secure)

Implements the D2 mechanism in isolation: an in-memory preset that beats the override-store/file but
loses to the env layer, attached after construction. Inert until a preset is set, so `<TEST-CMD>` stays
green with no consumer yet.

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1319 pass / 1 skip;
  kernel 2246).
- **Design references:** §2 D2; §4 KDD3; §7 AC4/AC5/AC8; §5 (precedence facts, `src/config.ts:106-113`
  value order, `:139-156` `enabled()`, `:143` env-veto, `:145` override-store).
- **Task list (TDD order):**
  1. **T1.1 (unit tests)** — add to `test/config.test.ts` (constructs
     `new LayeredConfig({ fileValues, overrideStore: new MemoryStore() })`, `:19`). Protected invariant:
     *a runtime preset is fail-secure — it overrides a persisted override-store value and the file, but
     the env layer overrides it; a config with no preset is byte-identical to today; setting a preset
     never writes to the override store.* Cases (each RED pre-impl — `setPreset` does not exist):
     - **enabled, preset lifts default:** `cfg.setPreset({ "risk-guard": true })`;
       `cfg.enabled("risk-guard", { store: new MemoryStore() })` (design default `false`) → **true**.
     - **enabled, preset beats override-store (AC8):** `over.set("risk-guard", false)` on the override
       store, then `cfg.setPreset({ "risk-guard": true })` → `enabled("risk-guard", {store})` → **true**.
     - **enabled, env-veto beats preset (AC4):** set `process.env.EAGENT_RISK_GUARD = "off"` (restore in
       a `finally`), `cfg.setPreset({ "risk-guard": true })` → `enabled("risk-guard", {store})` → **false**.
     - **string, preset value:** `cfg.setPreset({ "sandbox.tier": "workspace-write" })`;
       `cfg.string("sandbox.tier")` → **"workspace-write"**.
     - **string, preset beats override-store (AC8):** `over.set("sandbox.tier", "off")` then preset
       `"workspace-write"` → `string("sandbox.tier")` → **"workspace-write"**.
     - **string, env beats preset (escape hatch):** `process.env.EAGENT_SANDBOX_TIER = "readonly"`
       (restore in `finally`) + preset `"workspace-write"` → `string("sandbox.tier")` → **"readonly"**.
     - **no preset ⇒ unchanged (AC3 base):** without `setPreset`, `enabled("risk-guard", {store})`
       → false (default) and `string("sandbox.tier")` → undefined — identical to current behavior.
     - **AC5 no persistence:** after `cfg.setPreset({ "risk-guard": true })`, the override store has no
       new key: `assert.equal(over.get("risk-guard"), undefined)` while `enabled(...) === true`.
  2. **T1.2 (impl D2)** — `src/config.ts`: add a private `#preset: Record<string, unknown> | undefined`
     and a `setPreset(map: Record<string, unknown>): void` method (a **post-construction setter**, not a
     constructor arg — `hardened` is read from the already-built config, KDD1). Consult it:
     - in `enabled(id, opts)` (`:139-156`): **after** the env-veto (`:143`) and **before** the
       override-store read (`:145`) — `if (this.#preset && id in this.#preset) return
       Boolean(this.#preset[id]);`.
     - in the value path (`string`/`bool`, which call `#raw`, `:106-113`): for a preset key, resolve
       `env(key) ?? preset(key)` and stop (override/file bypassed). `#raw` returns
       `{ value: string|number|boolean; source } | undefined`, so return that **shape**, not a bare
       scalar: at the top of `#raw`, `if (this.#preset && key in this.#preset) { const e =
       this.#env(key); if (e !== undefined) return { value: e, source: "env" }; return { value:
       this.#preset[key] as string|number|boolean, source: "preset" }; }` (the cast satisfies
       `noUncheckedIndexedAccess`). Adding `"preset"` to `#raw`'s `source` union means widening **both
       coupled sites**: `#raw`'s return type (`:106`) *and* `entries()`, whose element `source` union is
       pinned separately at `:167` and whose `:171` `r?.source ?? "default"` would otherwise fail
       `tsc` (TS2322) — add `"preset"` there too (or map `"preset"→"override"` in `entries()`).
       `entries()` is the only other reader of `r.source`; `get/int/bool/string` read only `r.value`.
       This yields **env > preset** for preset keys while leaving every non-preset key on the existing
       `override > env > file` path (the design's implementer note).
     Do **not** touch the constructor signature (backward-compatible — all 9 existing construction
     sites, e.g. `test/helpers.ts:88`, `src/host.ts:208`, stay inert). No `#over.set` on the preset path
     (AC5).
- **Per-task acceptance command:** `node --import tsx --test test/config.test.ts`
- **Exit condition:** `test/config.test.ts` green; `npm test` 0 fail; `npm run typecheck` 0. Kernel
  untouched (`src/config.ts` is not in `src/kernel/`) — `node --import tsx --test
  test/kernel-surface.test.ts` still green.

### Phase 2 — Wire `hardened` end-to-end + `sandbox-tiers` tier-from-config + docs

- **Entry condition:** Phase 1 merged; `setPreset` available and green.
- **Design references:** §2 D1/D3/D4/D5/D6; §4 KDD1/KDD2/KDD4; §7 AC1/AC2/AC3/AC6/AC7; §8 R1/R2/R5.
- **Task list (TDD order):**
  1. **T2.1 (integration tests)** — new `test/hardened-profile.test.ts`, offline (`MockProvider`).
     Protected invariant: *building a host with `hardened` makes the enforcing guards resolve active
     and confining, without persisting anything; a kill switch still wins; a non-hardened host is
     unchanged.* Build the host via `createAgentHost({ hardened: true, … })` (mirror `test/host.test.ts`
     / `test/host-config.test.ts` construction). Cases:
     - **AC1 (guards resolve enforcing):** `built.config.enabled("risk-guard", { store }) === true`,
       `enabled("provenance", { store }) === true`, `built.config.string("sandbox.tier") ===
       "workspace-write"`.
     - **AC3 (non-hardened unchanged):** a host built with no `hardened` →
       `enabled("risk-guard", {store}) === false` and `string("sandbox.tier") === undefined`.
     - **AC4 (kill switch):** `hardened:true` + `process.env.EAGENT_RISK_GUARD="off"` (restore in
       `finally`) → `enabled("risk-guard", {store}) === false`.
     - **AC2 (behavioral block):** a hardened host + a scripted high-risk classifier verdict + the
       non-interactive UI (`confirm` → false) → a `bash`/`shell:exec` tool call yields a **blocked**
       decision (not executed). **Injection step (name it — a cold agent stalls otherwise):**
       `risk-guard.classify` resolves the **default** provider via the no-arg `e.agent.providers.get()`
       (`src/extensions/risk-guard.ts:115` → `ProviderRegistry.get()` returns `#default`), and
       `createAgentHost` registers a plain `MockProvider`. So after building the hardened host,
       **overwrite the default provider** with a scripted classifier —
       `built.agent.providers.register(new Classifier("<high-risk verdict>"), { default: true })` (the
       `ProviderRegistry` registers by overwrite and promotes `#default`; mirror the `Classifier extends
       MockProvider` in `test/risk-guard.test.ts:53-63`) — then apply `risk-guard`'s
       `beforeToolCall` to a `shell:exec` call and assert `block: true` (block mode blocks directly,
       `:193`; default `ask` mode → `ui.confirm`→false→block, `:194-195`). Invariant: *hardened turns
       risk classification into enforcement on the headless server.*
     - **AC7 (visibility):** the resolved `hardened` state is observable — assert `createAgentHost`
       returns a host whose config reflects the preset (AC1 already covers this) and, if D4 exposes a
       banner, capture it via the injected `logger` and assert it names `risk-guard`/`provenance`/the
       resolved tier.
  2. **T2.2 (impl D1)** — `src/host.ts`: add `hardened?: boolean` to `AgentHostOptions` (`:164-178`).
     After `LayeredConfig` is built (`:208-212`): `const hardened = opts.hardened ?? config.bool(
     "hardened", false); if (hardened) config.setPreset({ "risk-guard": true, "provenance": true,
     "sandbox.tier": "workspace-write" });`. `ServeOptions` inherits `hardened` automatically
     (`src/server.ts:40`).
  3. **T2.3 (impl D3)** — `src/extensions/sandbox-tiers.ts:76`: resolve the tier from config first,
     falling back to the store: `tier: (e.config.string("sandbox.tier") ?? e.store.get<Tier>("tier",
     "off") ?? "off") as Tier`. Mirrors the existing `sandbox.backend` config read (`:83`), including its
     unvalidated `as Tier` cast — acceptable because it is **fail-secure**: only exact `"off"` is the
     pass-through no-op (`:118`), so any non-`TIERS` value flows into `wrapCommand` with `writeTier=false`
     → a readonly-or-stricter sandbox, never a confinement bypass; the preset only ever sets a valid
     `"workspace-write"`. No other logic change.
  4. **T2.4 (impl D4)** — in `createAgentHost`, when `hardened`, log via the host `logger` a one-line
     banner naming the enabled guards + the **resolved** `config.string("sandbox.tier")`, and — when
     `sandbox-tiers`' backend probe finds none — a fail-open warning (R1). (Reuse the existing
     `probeBackend`/`detectBackend` result surface; if not readily available at host scope, log the tier
     and note the backend caveat generically.)
  5. **T2.5 (impl D5)** — docs: SECURITY.md "Recommended deployment" + README server section per design
     D5 (what `EAGENT_HARDENED=1` enables; orthogonal to `yolo:false`; no-backend fail-open; the env-var
     override policy incl. `EAGENT_PROVENANCE=off`/`EAGENT_RISK_GUARD=off`/`EAGENT_SANDBOX_TIER`; CLI
     honors it too). Docs are not gated by `<TEST-CMD>` but are part of the Phase's Deliverables.
- **Per-task acceptance command:** `node --import tsx --test test/hardened-profile.test.ts`
- **Exit condition:** `test/hardened-profile.test.ts` green; `npm test` 0 fail; `npm run typecheck` 0;
  `npm run build` 0; `npm run eval` 5/5; `test/kernel-surface.test.ts` green (kernel line count
  unchanged); a fresh read confirms the non-hardened path is byte-unchanged (AC3 green).

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md: ESM `.js` import specifiers; strict TS
  (`noUncheckedIndexedAccess` — the `#preset` lookup must handle `undefined`); zero deps except jiti;
  capabilities are the security vocabulary; **no kernel edit** (this touches `src/config.ts`,
  `src/host.ts`, `src/server.ts`, `src/extensions/sandbox-tiers.ts` — none under `src/kernel/`), so the
  2250 ceiling is untouched.
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; `<TEST-CMD>` results as
  trailers; no AI/model/tooling mention (CLAUDE.md).

## 4. Data and Fixture Dependencies

- Reuse `test/config.test.ts`'s `LayeredConfig` + `MemoryStore` harness (`:19`) for Phase 1 — no new
  fixture.
- Reuse `test/host.test.ts`/`test/host-config.test.ts` host construction and the `test/risk-guard.test.ts`
  offline classifier-scripting pattern for Phase 2. New file `test/hardened-profile.test.ts`. All
  offline against `MockProvider`; env-var cases set/restore `process.env` in a `finally`.

## 5. Regression Protection

Must stay green:
- `test/config.test.ts` + the other `config-*.test.ts` (the preset is additive; every existing
  `enabled()`/`string()`/`bool()` assertion must be unchanged — AC3/R3), `test/host.test.ts`,
  `test/host-config.test.ts`, `test/server.test.ts`, `test/sandbox-tiers.test.ts` (the tier now reads
  config first — confirm its existing store-driven tests still pass with no `sandbox.tier` config set),
  `test/risk-guard.test.ts`, `test/provenance.test.ts`.
- Full suite `npm test`; final gate adds `npm run eval` (5/5), `npm run build`, and
  `test/kernel-surface.test.ts` (ceiling + export pin unchanged).
