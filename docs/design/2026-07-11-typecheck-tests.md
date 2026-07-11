# Design — Type-check the `test/` tree (Cycle 5)

Slug: `2026-07-11-typecheck-tests`
Status: **closed** (2026-07-11)
Closing-commit: this cycle's single commit on `chore/production-hardening`.
Result: `typecheck:test` 0 (8 errors fixed, no residual); `typecheck` 0; suite 1349 pass / 0 fail / 1
skip (unchanged — behavior-neutral); build 0; eval 5/5; kernel unchanged (no `src/` edit). L1 fully
clean (empirically corroborated by the reviewer independently reproducing the 8-error spike); implemented
directly by the main agent with a fresh full-diff review (pass, zero-severe/general). The 8 fixes were
7 edit sites (the mcp-http param annotation resolved both `publish` call-site errors).

## 1. Background and Purpose

`tsconfig.json` excludes `test/` (`:23`) and `npm test` runs via `tsx` (transpile-only), so the entire
`test/` tree (112 `.ts` files) is **never type-checked** — the largest body of code in the repo has no
static guarantee. Latent type errors (and any that a future test introduces) go unnoticed until a
runtime failure, and refactors of `src/` types are not validated against test call-sites.

**Spike (measured 2026-07-11, throwaway config deleted):** running `tsc` over `src/**` + `test/**` with
`rootDir` overridden surfaces exactly **8 real type errors across 5 files** — the test authors have
written strictly-typed code even without enforcement. The errors are enumerated in §2/§5.

## 2. Deliverables

- [ ] **D1** — a `tsconfig.test.json` that extends `tsconfig.json` and type-checks `test/` + `src/`:
      `{ extends: "./tsconfig.json", compilerOptions: { noEmit: true, rootDir: ".", declaration: false,
      declarationMap: false, sourceMap: false }, include: ["src/**/*.ts", "test/**/*.ts"], exclude:
      ["node_modules", "dist"] }`. `rootDir: "."` is required because test files live outside `src`
      (the base `rootDir: "src"` otherwise yields 111 spurious TS6059 "not under rootDir"); `noEmit`
      makes it a check-only config so `rootDir`/`declaration` don't affect any build output. It keeps
      **every** strict flag from the base (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
      …) — the whole point is to hold tests to the same bar as `src`.
- [ ] **D2** — a `typecheck:test` npm script (`tsc -p tsconfig.test.json --noEmit`, `--noEmit` on the
      CLI for symmetry with the existing `typecheck` script) and wire it into CI
      (`.github/workflows/ci.yml` build job, after `npm run typecheck`). `npm run typecheck` (src-only)
      is unchanged; `typecheck:test` is the new gate.
- [ ] **D3 — fix the 8 surfaced errors** (each traced in §5), minimally and idiomatically, without
      changing test behavior:
      - **TS2322 ×4** (`agent.test.ts:614`, `extension.test.ts:120-122`): a handler expression-body
        returns a value where `void | Promise<void>` is required — give it a block body / discard the value.
      - **TS2345 ×2** (`mcp-http.test.ts:265,276`): a `Harness` argument doesn't satisfy the narrower
        structural param type of the test-local `publish` helper (`:255`) — widen that **test-local**
        param type (lowest blast radius; do NOT touch `Harness`/`makeHarness`, which are cross-file).
      - **TS2532 ×1** (`memory.test.ts:590`): `noUncheckedIndexedAccess` — guard or assert the access.
      - **TS5097 ×1** (`packages.test.ts:17`): an import path ends in `.ts` — change to `.js` (the
        project's ESM `.js`-specifier convention), **not** `allowImportingTsExtensions` (KDD2).
- [ ] **D4 (docs)** — update CLAUDE.md's note that `test/` is untypechecked (it now IS, via
      `typecheck:test`) and CHANGELOG. CLAUDE.md currently says both `typecheck` and `test` skip
      type-checking `test/`; correct it to name the new `typecheck:test` gate.

## 3. Scope Boundary (NOT in scope)

- **Not changing `npm test`** — it stays `tsx` (transpile-only, fast, offline). Type-checking is a
  **separate** `typecheck:test` gate, not folded into the test runner.
- **Not enabling `allowImportingTsExtensions`** — the one `.ts` import is a convention deviation to fix,
  not a pattern to bless (KDD2).
- **Not refactoring test code** beyond the 8 minimal fixes — no drive-by cleanups, no restructuring.
- **Not type-checking `examples/`** — out of scope (still excluded); this cycle is `test/` only.
- **No `src/` change, no kernel change** — the fixes are in `test/*`, and the config/script/CI are
  tooling.

## 4. Key Design Decisions

### KDD1 — a separate `tsconfig.test.json` + `typecheck:test` script, not folding tests into the base config
- **Problem:** how to type-check `test/` without disturbing the `src`-only build.
- **Options:** (a) add `test/` to the base `tsconfig.json` `include`; (b) a separate `tsconfig.test.json`
  + a new script.
- **Choice: (b).** (a) would drag `test/` into `npm run build`/`typecheck` (the emit build has
  `rootDir: "src"`, `declaration: true` — including tests there breaks output layout and forces
  `rootDir: "."`, changing `dist/` structure). (b) isolates a **check-only** (`noEmit`) config so the
  build is untouched and the test-typecheck is an independent, opt-in-able gate. This mirrors the common
  TS monorepo pattern (a base config + a test/project config).

### KDD2 — fix the `.ts` import to `.js`, not enable `allowImportingTsExtensions`
- **Problem:** `packages.test.ts:17` imports a path ending in `.ts`, which `verbatimModuleSyntax` +
  NodeNext reject (TS5097).
- **Options:** (a) enable `allowImportingTsExtensions: true` (+`noEmit`) in the test config; (b) change
  the import to `.js`.
- **Choice: (b).** The project convention (CLAUDE.md house rules) is ESM `.js` import specifiers
  everywhere, even for `.ts` sources. (a) would bless `.ts` imports across all tests, eroding the
  convention; (b) is a one-line fix that keeps tests consistent with `src`.

## 5. Dependencies and Assumptions

Verbatim (the 8 spike-surfaced errors, to be re-confirmed at L3 against the same `tsc` invocation):
- `test/agent.test.ts(614,51)` TS2322 `Type 'number' is not assignable to type 'void | Promise<void>'`.
- `test/extension.test.ts(120,44)/(121,41)/(122,34)` TS2322 (same shape).
- `test/mcp-http.test.ts(265,13)/(276,13)` TS2345 `Argument of type 'Harness' is not assignable to …
  { agent: { hooks: { on(...) } } }`.
- `test/memory.test.ts(590,32)` TS2532 `Object is possibly 'undefined'`.
- `test/packages.test.ts(17,22)` TS5097 `An import path can only end with a '.ts' extension when
  'allowImportingTsExtensions' is enabled`.
- Base `tsconfig.json` compiler flags (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  NodeNext, `:2-20`), `include`/`exclude` (`:22-23`). CI `ci.yml` build job steps (`:22-26`).
- `tsx` continues to run `npm test` (no type-check); `typecheck:test` is the static gate.
- **Assumption:** the 8 errors are the complete set under the base strict flags (measured via the spike).
  L3 re-runs `tsc -p tsconfig.test.json` and treats **any** residual error as in-scope to fix (the count
  is the acceptance, not a fixed list — a fix that reveals a cascaded error must also be resolved).

## 6. Relationship with Existing Designs

- No prior design conflict. Touches CLAUDE.md (a house-rules doc) only to correct the now-stale
  "`test/` is untypechecked" statement (D4) — a factual reconciliation, not a rule change. Terminology
  anchors: CLAUDE.md house conventions (strict TS, ESM `.js` specifiers).

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (the new gate passes):** `npm run typecheck:test` exits **0** (all 8 errors fixed; no residual).
  RED before D3.
- **AC2 (base build unchanged):** `npm run typecheck` (src-only) exits 0, `npm run build` exits 0, and
  `dist/` layout is unchanged (the test config is `noEmit`, separate). `npm test` still passes
  (0 fail; the 8 fixes are behavior-neutral — L3 re-measures the pass count rather than pinning a literal).
- **AC3 (CI wired):** `ci.yml` runs `typecheck:test` in the build job (a fresh read confirms the step;
  the YAML parses).
- **AC4 (regression):** `npm run eval` 5/5; `test/kernel-surface.test.ts` green; kernel line count
  unchanged (no `src/` edit).
- **AC5 (CLAUDE.md corrected):** the CLAUDE.md line claiming `test/` is untypechecked names the new
  `typecheck:test` gate.

## 8. Risks and Rollback

- **R1 — a fix changes test behavior.** The 8 fixes are type-level (block body, `.js` extension, an
  undefined-guard, a param-type alignment) and must keep the assertion identical. Mitigation: `npm test`
  stays green (AC2); each fix is minimal (§2 D3). Rollback: per-file revert.
- **R2 — the test config surfaces MORE than 8 errors at L3** (spike drift / a fix cascades). Mitigation:
  the acceptance is `typecheck:test` == 0, not a fixed count (§5 assumption) — L3 fixes whatever the
  gate reports. If the volume is materially larger than 8 (e.g. a config flag interaction), STOP and
  re-scope at L2.
- **R3 — `tsconfig.test.json` mis-set** (e.g. loses a strict flag, or `rootDir` wrong) would let real
  errors through or spuriously fail. Mitigation: it `extends` the base (inherits every strict flag) and
  only overrides emit/rootDir; AC1 + AC2 bound it. Rollback: revert the config.
- **Overall rollback:** delete `tsconfig.test.json`, the `typecheck:test` script + CI step, and revert
  the 8 test-file hunks. Independent; branch `chore/production-hardening` (PR #40), not merged.
