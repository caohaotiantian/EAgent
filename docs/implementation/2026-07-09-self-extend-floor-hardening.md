# Implementation: `self-extend-floor` hardening

Task slug: `2026-07-09-self-extend-floor-hardening` (matches the design doc).

## 1. Task Index

| Design artifact | Design doc location |
| --- | --- |
| Deliverables (D5 acting-model, D4 exact mode, D3 e2e test, D4/D5 tests, docs) | `docs/design/2026-07-09-self-extend-floor-hardening.md` §2 |
| Scope Boundary (default unchanged; only two modes; no kernel edits) | §3 |
| Key Design Decisions 1–3 (opt-in exact; acting-model; exact semantics) | §4 |
| Dependencies (currentActingAgent import; root-registry cap-lookup invariant) | §5 |
| Acceptance Criteria 1–8 | §7 |
| Risks and Rollback | §8 |

## 2. Phase Breakdown

One Phase: a small, self-contained hardening of `self-extend-floor.ts` + its test — one contiguous Deliverable block that leaves `npm test` green.

### Phase 1 — acting-model resolution, opt-in exact match, and the deferred tests

**Entry condition:** L1 design passed. No prior Phase.

**Design references:** `docs/design/2026-07-09-self-extend-floor-hardening.md` §2, §4 Decisions 1–3, §5, §7 AC 1–8.

**Design shape to implement (restated so a fresh agent needs no session context):**

Current `src/extensions/self-extend-floor.ts`: exported pure `modelAllowed(model, patterns)` (substring, case-insensitive, empty⇒inert at line 52); the `activate` `beforeToolCall` closure reads `e.agent.model` at three sites (match at 69, `warn` at 72, `reason` at 77).

- **D4 — `modelAllowed` gains an opt-in mode:**
  - Signature: `export function modelAllowed(model: string, patterns: string[], mode: "substring" | "exact" = "substring"): boolean`.
  - Body: keep `if (patterns.length === 0) return true;` FIRST (inert, before the mode branch). Then `const m = model.toLowerCase();`. If `mode === "exact"`: `return patterns.some((p) => m === p.toLowerCase());` (lowercase both sides — symmetry with the substring branch). Else (substring, the default and the fallback for any other value): `return patterns.some((p) => m.includes(p.toLowerCase()));` (unchanged from today).
- **D5 — acting-model source + D4 mode read in the guard closure:**
  - Import `currentActingAgent` from `../kernel/agent.js` (add to the existing import line, or a new import).
  - Inside the gated path (after the capability check passes), compute once: `const model = (currentActingAgent() ?? e.agent).model;` and `const mode = e.config.get("selfExtendFloor.match", "substring") === "exact" ? "exact" : "substring";`.
  - Replace `modelAllowed(e.agent.model, patterns)` with `modelAllowed(model, patterns, mode)`.
  - Replace the two `e.agent.model` interpolations in the `warn` (line 72) and `reason` (line 77) with `model` (the acting model).
  - Leave the kill-switch check, the capability lookup `e.agent.tools.get(ctx.call.name)` (stays on the ROOT registry — deliberate, §5), and `parseAllowlist` unchanged.
- **Docstring:** update the module docstring to note (a) the acting model is `currentActingAgent() ?? e.agent`, and (b) the opt-in `selfExtendFloor.match=exact` for strict equality matching (default substring unchanged).
- **README:** update the `self-extend-floor` extension-table row to mention `selfExtendFloor.match` (substring default | exact) and the acting-model semantics.
- **CHANGELOG:** one `### Changed` (or a bullet under the existing self-extend-floor `### Added`) note under `[Unreleased]`: acting-model resolution + opt-in exact match.

**Task list, in TDD order** (extend `test/self-extend-floor.test.ts`; write the new test cases before the source change; each names the invariant it protects):

1. **TEST** D4 pure-helper: `modelAllowed("gpt-4o-mini", ["gpt-4"], "substring") === true` (the documented over-allow — admitted) and `=== false` under `"exact"`; `modelAllowed("mock", ["mock"], "exact") === true`; `modelAllowed("mock", ["MOCK"], "exact") === true` (case-insensitive both sides); `modelAllowed(m, patterns)` with no mode arg behaves as substring (default unchanged); `modelAllowed("x", [], "exact") === true` (inert). (AC 2, 3, 4, 7-helper)
2. **TEST** D3 end-to-end case-insensitivity: `makeHarness()`, `host.use("self-extend-floor", activate)`, register a `self:extend` probe tool; `h.config.set("selfExtendFloor.models","MOCK")` (uppercase) → `hooks.apply("beforeToolCall", …, {call:probe})` returns `block===false` (acting model `"mock"` matches case-insensitively through the real config path). (AC 1)
3. **TEST** D4 exact-mode integration: acting model `"mock"`; `h.config.set("selfExtendFloor.models","moc")` with `match` unset → `block===false` (substring admits `"mock".includes("moc")`); then `h.config.set("selfExtendFloor.match","exact")` → same call now `block===true` (exact refuses `"mock" !== "moc"`); with `models="mock"` + `match="exact"` → `block===false` (exact id). (AC 2-integration, 3-integration)
4. **TEST** D4 unknown-mode fallback + inert-in-exact: `models="mo"`, `match="weird"` → `block===false` (falls back to substring); `models=""` (empty) + `match="exact"` → `block===false` (inert early-return before the mode branch). (AC 5, 7)
5. **TEST** D5 acting-model is the sub-agent's — use the **`test/acting-agent-seam.test.ts` idiom** (its `makeChild(parent, system, script, tools)` at line 60 builds `new Agent({ model, …, hooks: parent.hooks.childScope() })`; its AC-4 test at line 124 is "the guard acts on the CHILD, never the parent"). Set up: `makeHarness()` root (model `"mock"`), `host.use("self-extend-floor", activate)`, and a child built via `new Agent({ model: "<distinct-model>", hooks: root.agent.hooks.childScope(), tools: <registry containing the self:extend probe>, providers: root.agent.providers, capabilities: root.agent.capabilities, ui, logger })` — the child's model DIFFERS from root, which is the whole point of D5. **CRITICAL — register the `self:extend` probe on the ROOT registry too** (`root.agent.tools.register(probe)`): the guard's capability lookup is `e.agent.tools.get(ctx.call.name)` on the ROOT (`self-extend-floor.ts:64`; `e.agent` is bound at activation), and a hand-built child registry is NOT a subset of root (unlike `childRegistryFrom`). If the probe exists only on the child, `caps` resolves to `[]`, the guard passes untouched, and the block assertion silently goes red / the symmetric pass false-greens. So the probe must live in BOTH: the root registry (for the guard's cap lookup) and the child's tool registry (so the child can call it). Script the child's `MockProvider` to emit the `self:extend` probe tool call so the guard fires in the real dispatch path during `await child.run(...)` (so `currentActingAgent()` is the child). Assert: with `selfExtendFloor.models="mock"` (root on-floor, child off-floor) the child's `self:extend` call is BLOCKED (keyed on the child's `"<distinct-model>"`, not root's `"mock"`); and the symmetric case `models="<distinct-model>"` (child on-floor) → the child's call PASSES. This proves the guard uses `currentActingAgent().model`, not `e.agent.model`. (AC 6)
6. **IMPL** edit `src/extensions/self-extend-floor.ts`: add the `mode` param + exact branch to `modelAllowed`; import `currentActingAgent`; resolve `const model = (currentActingAgent() ?? e.agent).model` + `const mode = …` in the guard; use them in the match/`warn`/`reason`. Update the docstring.
7. **IMPL** update the `README.md` row + `CHANGELOG.md` entry.

**Note on the D5 test harness:** the closest existing idiom is `test/acting-agent-seam.test.ts` (a `childScope()` child whose model is set, driving a guard registered on the parent, asserting the guard resolves the CHILD). Copy its `makeChild` helper shape (`new Agent({ model, hooks: parent.hooks.childScope(), tools, providers, capabilities, ui, logger })`) and give the child a model distinct from the root's `"mock"`. The invariant to prove is "the model the guard matches against is the *acting* agent's, not `e.agent`'s" — a floor set to the root's model must block the child (whose model differs) and vice-versa. The exact harness shape is L3's to finalize provided AC 6's invariant is mechanically asserted; the model-divergence between root and child is mandatory (an all-`"mock"` setup does not exercise D5).

**Per-task acceptance commands** (from repo root):
- Floor suite (tasks 1–5): `node --import tsx --test test/self-extend-floor.test.ts`
- Typecheck (AC 8): `npm run typecheck`
- Full offline suite incl. `test/kernel-surface.test.ts` (AC 8): `npm test`

**Exit condition:** `node --import tsx --test test/self-extend-floor.test.ts` passes (all new + existing assertions green), `npm run typecheck` exits 0, and `npm test` exits 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM + NodeNext `.js` specifiers; strict TS; zero deps; single-file extension; config via `e.config` only; offline `node:test`; no kernel edits (`test/kernel-surface.test.ts` stays green; `currentActingAgent` is an existing export, not a new one).
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** `feat(phase1): …` / `fix(phase1-roundR): <keyword>`; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI/tooling mention.
- **Untypechecked test tree:** `test/` is not type-checked by either gate — verify the new test cases' types separately (the D5 nested-agent setup especially).

## 4. Data and Fixture Dependencies

- Reuse `test/helpers.ts` `makeHarness`, `MockProvider`, `defineTool`, and the existing `test/self-extend-floor.test.ts` scaffolding (probe-tool registration, `hooks.apply` driver, `h.config.set`). For D5, mirror the `childScope()`-child construction in `test/acting-agent-seam.test.ts` (its `makeChild` at line 60 + the "guard acts on the CHILD" test at line 124), giving the child a model distinct from the root. No new fixtures. Do NOT edit `test/helpers.ts`.

## 5. Regression Protection

- `npm test` stays fully green — especially `test/self-extend-floor.test.ts` (all Wave-2 assertions: inert-by-default, kill switch, capability-scoping, unknown-tool, registration/observability) and `test/kernel-surface.test.ts` (surface + ceiling).
- The default path is unchanged: with `selfExtendFloor.match` unset, matching is substring and `modelAllowed` with two args is byte-identical — so no existing behavior shifts. The acting-model change only affects the model *value* read (root when not in a sub-agent run, which is every existing test's context), so existing single-agent assertions are unaffected.
