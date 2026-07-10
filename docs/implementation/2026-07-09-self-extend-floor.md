# Implementation: `self-extend-floor` extension

```
Status: closed
Closing-commit: aa8700d
Closed-on: 2026-07-09
Deferred: none (finding recorded on the design doc's closure block)
```

Task slug: `2026-07-09-self-extend-floor` (matches `docs/design/2026-07-09-self-extend-floor.md`).

## 1. Task Index

| Design artifact | Design doc location |
| --- | --- |
| Deliverables (extension, host wiring, tests, README/CHANGELOG) | `docs/design/2026-07-09-self-extend-floor.md` §2 |
| Scope Boundary (only self:extend gated; no hardcoded models; no command; e.agent.model root only; no kernel edits) | §3 |
| Key Design Decisions 1–6 (guard extension; capability-scoped; allowlist inert-by-default; e.agent.model; ordering; no capability) | §4 |
| Config/kill-switch mapping | §5 |
| Acceptance Criteria 1–9 | §7 |
| Risks and Rollback | §8 |

## 2. Phase Breakdown

One Phase: a single `beforeToolCall` guard extension + host wiring + doc rows — one contiguous Deliverable block that lands together and keeps `npm test` green.

### Phase 1 — the `self-extend-floor` guard, wired and tested

**Entry condition:** L1 design passed. No prior Phase.

**Design references:** `docs/design/2026-07-09-self-extend-floor.md` §2, §4 Decisions 1–6, §5, §7 AC 1–9.

**Design shape to implement (restated so a fresh agent needs no session context):**
- `src/extensions/self-extend-floor.ts`, default-export `activate(e: ExtensionAPI): () => void` (return a dispose loop that never throws, mirroring `risk-guard.ts` / `memory.ts:674-682`).
- **Gated capability:** the constant `GATED_CAP = "self:extend"`.
- **Pure helpers (exported for unit testing, mirroring `microagents` exporting `injectMicroagents`):**
  - `parseAllowlist(raw: string | undefined): string[]` — split on `,`, trim, lowercase, drop empties.
  - `modelAllowed(model: string, patterns: string[]): boolean` — `true` when `patterns` is empty (inert), else `true` iff `model.toLowerCase()` **includes** at least one pattern. Pure, no I/O.
- **The guard (`activate` closure):** register `e.hook("beforeToolCall", (decision, ctx) => …)`:
  1. If `!e.config.enabled("self-extend-floor", { default: true })` → return `decision` unchanged (kill switch `EAGENT_SELF_EXTEND_FLOOR=off`).
  2. `const caps = e.agent.tools.get(ctx.call.name)?.capabilities ?? []` (mirrors `risk-guard.ts:104`). If `caps` does not include `GATED_CAP` → return `decision` unchanged (capability-scoped; unknown tool → `[]` → pass, AC 7).
  3. `const patterns = parseAllowlist(e.config.get("selfExtendFloor.models", ""))`. If `modelAllowed(e.agent.model, patterns)` → return `decision` unchanged (empty allowlist inert; allowed model passes).
  4. Otherwise BLOCK: `e.log.warn(\`self-extend-floor: blocked ${ctx.call.name} — model "${e.agent.model}" not in floor [${patterns.join(", ")}]\`)` and return `{ ...decision, block: true, reason: \`self-extend-floor: model "${e.agent.model}" is below the configured self:extend floor [${patterns.join(", ")}]\` }`. (The `reason` names both the acting model and the floor — AC 3.)
  - The guard never clears an upstream block (it only runs when `decision.block` is false, since `beforeToolCall` applies with `shouldStop=(d)=>d.block`, `agent.ts:500`) and only ever sets `block: true`.
- **Host wiring:** append `["self-extend-floor", selfExtendFloor]` to `BUILTIN_EXTENSIONS` in `src/host.ts` immediately after the `["self-improve", selfImprove]` line, plus the matching `import selfExtendFloor from "./extensions/self-extend-floor.js";`.
- **Docs:** append one row to the `README.md` extension table (command: none; capability: none; kill switch `EAGENT_SELF_EXTEND_FLOOR=off`; note that `selfExtendFloor.models` patterns are substring-matched — write specific patterns). One `### Added` CHANGELOG entry under `[Unreleased]`.

**Task list, in TDD order** (write `test/self-extend-floor.test.ts` first; each test names the invariant it protects):

1. **TEST** `parseAllowlist` + `modelAllowed` (pure): empty/whitespace raw → `[]` and `modelAllowed(m, [])===true` (inert). `modelAllowed("mock", ["mock"])===true`; `modelAllowed("mock", ["opus","sonnet"])===false`; `modelAllowed("mock", ["MOCK"])===true` (case-insensitive); over-allow documented case `modelAllowed("gpt-4o-mini", ["gpt-4"])===true`. Protects Decision 3 matching semantics (AC 2/3/6).
2. **TEST** inert by default (integration): `makeHarness()`, `await host.use("self-extend-floor", activate)`, register a probe tool `defineTool({ name:"probe_extend", description:"test probe", capabilities:["self:extend"], parameters:{type:"object",properties:{}}, execute:async()=>ok("") })` via `h.agent.tools.register(...)`; with NO allowlist configured, `h.agent.hooks.apply("beforeToolCall", { block:false, arguments:{} }, { call })` → `block===false`. (AC 1)
3. **TEST** allowed model passes: set `h.config.set("selfExtendFloor.models", "mock")` (matches `agent.model==="mock"`) → probe call `block===false`. (AC 2)
4. **TEST** below-floor blocked: `h.config.set("selfExtendFloor.models", "opus,sonnet")` → probe call `block===true` and `decision.reason` contains both `"mock"` and the floor text. (AC 3)
5. **TEST** capability-scoped: with the blocking allowlist from (4), a call to a CONTROL tool `defineTool({ name:"plain", parameters:{...}, execute })` (no capabilities) → `block===false`. (AC 4)
6. **TEST** kill switch: with blocking allowlist + `process.env.EAGENT_SELF_EXTEND_FLOOR="off"` set for the block (restore in `finally`), probe call → `block===false`. (AC 5)
7. **TEST** unknown tool tolerated: `hooks.apply("beforeToolCall", …, { call: toolCall("no_such_tool", {}) })` with a blocking allowlist → `block===false`, no throw (`capsOf`→`[]`). (AC 7)
8. **TEST** registration + observability: capture `listenerCount("beforeToolCall")` before/after `host.use` → increases by exactly 1 (AC 8a). And assert the block path (reuse the (4) setup with a capturing logger passed to `makeHarness({ logger })`) emitted a `warn` whose joined args contain `"probe_extend"` and `"mock"` (AC 8b).
9. **IMPL** write `src/extensions/self-extend-floor.ts` to make tasks 1–8 pass.
10. **IMPL** wire `src/host.ts` (import + `BUILTIN_EXTENSIONS` row after `self-improve`) and append the `README.md` row + `CHANGELOG.md` entry.

**Test harness notes (verified against `test/risk-guard.test.ts`):**
- `h.host.use("self-extend-floor", activate)` loads the extension (risk-guard.test.ts:34).
- Probe/control tools via `h.agent.tools.register(defineTool({...}))`; `defineTool` carries `capabilities` (define.ts:36); registry `get(name).capabilities` reads it back (registry.ts:39, risk-guard.ts:104).
- Drive the seam: `h.agent.hooks.apply("beforeToolCall", { block:false, arguments:{} }, { call })` (risk-guard.test.ts:98); build `call` as a `tool_use` `ToolCallBlock` with `{ type:"tool_call", id, name, arguments }` (copy the `toolCall` helper from risk-guard.test.ts).
- `h.config.set(key, value)` sets an override (store.ts:32); `agent.model` is `"mock"` (helpers.ts:61).
- Capturing logger: pass `makeHarness({ logger: { debug(){}, info(){}, warn:(...a)=>warned.push(a.join(" ")), error(){} } })`; `e.log.warn` routes to `logger.warn(tag, ...)` (extension.ts:284).

**Per-task acceptance commands** (from repo root):
- Guard suite (tasks 1–8): `node --import tsx --test test/self-extend-floor.test.ts`
- Typecheck (AC 9): `npm run typecheck`
- Full offline suite incl. `test/kernel-surface.test.ts` (AC 9): `npm test`

**Exit condition:** `node --import tsx --test test/self-extend-floor.test.ts` passes (8 test tasks green), `npm run typecheck` exits 0, and `npm test` exits 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM + NodeNext with `.js` import specifiers; strict TS; zero runtime deps; single-file extension; `EAGENT_<NAME>=off` kill switch; append to `BUILTIN_EXTENSIONS`; offline `node:test`. Kernel untouched (`test/kernel-surface.test.ts` stays green). Reads config only via `e.config`, never `process.env` directly.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1): …` opener; `fix(phase1-roundR): <keyword>`; `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; no AI/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse `test/helpers.ts` `makeHarness` (agent model `"mock"`, `MemoryBackend` store, real `LayeredConfig`) and its `logger` option for the capture test. Reuse `defineTool`/`ok` from `src/kernel/define.js`. Copy the small `toolCall` block-builder from `test/risk-guard.test.ts`. No new fixtures.

## 5. Regression Protection

- `npm test` stays fully green — especially `test/kernel-surface.test.ts` (surface + kernel ceiling) and `test/risk-guard.test.ts` (the other `beforeToolCall` guard; the new guard adds an independent listener and must not perturb it — both run their own capability scope).
- The new `BUILTIN_EXTENSIONS` row must not change existing behavior: the guard is inert unless `selfExtendFloor.models` is configured, so the default-install `beforeToolCall` chain returns identical decisions (assert indirectly via the untouched `risk-guard` suite staying green).
