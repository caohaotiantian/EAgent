# Implementation — Type-check the `test/` tree (Cycle 5)

Slug: `2026-07-11-typecheck-tests` (matches the design)
Status: **closed** (2026-07-11) — single phase, implemented directly by the main agent (mechanical,
spike-validated), fresh full-diff review passed zero-severe. See the design closure block for results.

## 1. Task Index

Design: `docs/design/2026-07-11-typecheck-tests.md`. Deliverables D1–D4 → §2; the 8 enumerated errors →
§5; Acceptance AC1–AC5 → §7; KDD1/KDD2 → §4. One phase (config + fixes + CI/docs are one coherent,
independently-committable unit). `<TEST-CMD>` = `npm test`; the new gate is `npm run typecheck:test`.

## 2. Phase Breakdown

### Phase 1 — `tsconfig.test.json` + `typecheck:test` gate + fix the 8 errors + wire CI/docs

- **Entry condition:** branch `chore/production-hardening`, suite green (baseline 1349 pass / 1 skip).
- **Design references:** §2 D1–D4; §4 KDD1/KDD2; §5 (the 8 errors + base tsconfig flags); §7 AC1–AC5.
- **Task list (TDD order — the failing gate first, then make it pass):**
  1. **T1.1 (the RED gate: config + script)** — create `tsconfig.test.json` per D1
     (`{ "extends": "./tsconfig.json", "compilerOptions": { "noEmit": true, "rootDir": ".",
     "declaration": false, "declarationMap": false, "sourceMap": false }, "include": ["src/**/*.ts",
     "test/**/*.ts"], "exclude": ["node_modules", "dist"] }`), and add
     `"typecheck:test": "tsc -p tsconfig.test.json --noEmit"` to `package.json` scripts (near `typecheck`
     at `:54`). **Protected invariant:** *the test tree is held to the same strict bar as `src`.* Verify
     `npm run typecheck:test` **fails with exactly the 8 errors** (RED) — this is the test that D3 makes
     pass. If the count differs from 8 (spike drift), STOP and re-scope (design §5/R2).
  2. **T1.2 (fixes — make the gate GREEN)** — fix each error minimally, behavior-neutral:
     - `test/agent.test.ts:614` + `test/extension.test.ts:120,121,122` (TS2322): the handler
       expression-body returns a value (`Array.push` → `number`) where `void | Promise<void>` is
       required. Give it a **block body** so it returns `void` (e.g. `({text}) => { reasoning.push(text); }`).
       Runtime-identical (the hook bus ignores handler return values).
     - `test/mcp-http.test.ts:265,276` (TS2345): **widen the test-local `publish` helper's param type**
       (`:255`) so a `Harness` satisfies it — do NOT touch `Harness`/`makeHarness` (cross-file, KDD/§4).
     - `test/memory.test.ts:590` (TS2532): `v[dim] += 1` reads `number | undefined` under
       `noUncheckedIndexedAccess`; guard/assert (`v` is `[0,0,0,0]`, `dim ∈ 0..3`, so `v[dim]!` or a
       local non-undefined binding) — behavior-neutral.
     - `test/packages.test.ts:17` (TS5097): change the import specifier ending in `.ts` to `.js` (house
       convention; `helpers` at `:18` already uses `.js`). Leave the `DEFINE_PATH` **string** at `:20`
       (a jiti path, not a static import) untouched.
     After the fixes, `npm run typecheck:test` exits **0** (AC1).
  3. **T1.3 (CI + docs)** — add a `- run: npm run typecheck:test` step to the `build` job in
     `.github/workflows/ci.yml` (after `npm run typecheck`, `:23`). Update CLAUDE.md's note that `test/`
     is untypechecked to name the new `typecheck:test` gate (D4 — the base `typecheck`/`test` scripts
     still don't check `test/`; the new gate does). Add a CHANGELOG entry.
- **Per-task acceptance commands:**
  - `npm run typecheck:test` (exit 0 after T1.2)
  - `npm run typecheck` (src-only, exit 0 — unchanged)
  - `node --import tsx --test test/agent.test.ts test/extension.test.ts test/mcp-http.test.ts test/memory.test.ts test/packages.test.ts` (the 5 touched files still pass at runtime)
- **Exit condition:** `npm run typecheck:test` 0; `npm run typecheck` 0; `npm test` 0 fail;
  `npm run build` 0 (and `dist/` layout unchanged — the test config is `noEmit`, separate);
  `npm run eval` 5/5; `test/kernel-surface.test.ts` green (no `src/` edit → kernel line count unchanged).

## 3. Engineering Constraints Index

- **Engineering norms** — CLAUDE.md: ESM `.js` specifiers (the TS5097 fix enforces this); strict TS
  (the whole point — the test config inherits every strict flag); zero deps except jiti (`tsc`/`tsx`
  already present); **no `src/` change** (fixes are in `test/*`, config/script/CI are tooling), so the
  kernel ceiling is untouched.
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; `<TEST-CMD>` results as
  trailers; no AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- No new fixtures. The change is a config + 8 in-place fixes in existing test files + a CI step + doc
  edits. The `tsc -p tsconfig.test.json` invocation is the gate.

## 5. Regression Protection

Must stay green:
- The 5 touched test files at runtime (`agent`/`extension`/`mcp-http`/`memory`/`packages`) — the fixes
  are behavior-neutral (block body, `.js` extension, an undefined-guard, a widened test-local param type).
- `npm run typecheck` (src-only) — unchanged (the test config is separate). `npm run build` — `dist/`
  layout unchanged (`noEmit`). Full suite `npm test`; final gate adds `npm run eval` (5/5),
  `test/kernel-surface.test.ts`, and the new `npm run typecheck:test` (0).
