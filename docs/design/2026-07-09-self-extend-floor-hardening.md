# Design: `self-extend-floor` hardening — acting-model resolution, opt-in exact match, end-to-end case test

```
Status: closed
Closing-commit: f7c3072
Closed-on: 2026-07-09
Supersedes: the D3/D4/D5 deferred items of 2026-07-09-self-extend-floor
Deferred: none
```

Task slug: `2026-07-09-self-extend-floor-hardening`
Cycle 1 of "finish all deferred tasks". Supersedes-scope: the three deferred items
in `docs/design/2026-07-09-self-extend-floor.md`'s closure block + §8 residuals.

## 1. Background and Purpose

The Wave-2 `self-extend-floor` extension (a `beforeToolCall` guard blocking
`self:extend` tool calls when the acting model is not on a configured allowlist)
shipped with three items explicitly deferred in its closure block / §8 risks:

- **D3 (test gap):** the case-insensitive matching (AC-6) is asserted only at the
  pure-helper level (`modelAllowed("mock",["MOCK"])`), never end-to-end through
  the real `e.config` path. A regression that broke config-path case-folding would
  not be caught.
- **D4 (over-allow, the safety-relevant gap):** substring matching admits a
  *weaker* variant whose id **contains** an allowlist entry — `gpt-4` matches
  `gpt-4o-mini`. This is exactly the STOP failure mode (a weak model driving
  self-extension) the floor exists to prevent. The "unknown model refused" safety
  property holds only for ids matching *nothing*. Wave-2 kept substring as the
  default deliberately (a single `opus` matches `claude-opus-4-8`) and rejected
  anchoring-by-default, leaving no way for a safety-conscious operator to get
  strict matching.
- **D5 (sub-agent model unresolved):** the guard reads `e.agent.model` (the
  **root** agent). A capable root that spawns a weak `self:extend` sub-agent
  bypasses the floor — the floor keys on the wrong model.

If we do not finish these: the floor has a real safety hole (D4/D5) that
contradicts the STOP lesson it embodies, and an untested behavior (D3).

## 2. Deliverables

- [ ] **D5 — acting-model resolution:** `self-extend-floor.ts` reads the acting model as `(currentActingAgent() ?? e.agent).model` (imported from `../kernel/agent.js`) instead of `e.agent.model`, so the floor checks the model of the agent whose `run()` is on the stack (a sub-agent during its own tool calls; the root otherwise). The block `reason`/`warn` name that same acting model.
- [ ] **D4 — opt-in exact match:** `modelAllowed(model, patterns, mode?)` gains a third `mode: "substring" | "exact"` param (default `"substring"` — unchanged). In `"exact"` mode a model is allowed iff its lowercased id **equals** an allowlist entry (patterns are already lowercased by `parseAllowlist`). The guard reads the mode from `e.config.get("selfExtendFloor.match", "substring")`; any value other than `"exact"` is treated as `"substring"` (fail-safe to the documented default).
- [ ] **D3 — end-to-end case test:** `test/self-extend-floor.test.ts` gains an integration test that sets `h.config.set("selfExtendFloor.models","MOCK")` and asserts a `self:extend` probe call PASSES through the real guard + `LayeredConfig` (case-insensitive via the config path, not just the pure helper).
- [ ] Tests for D4 (exact mode blocks a substring-collision that substring mode admits; exact mode passes an exact id) and D5 (a sub-agent's acting model is what gets floored) in `test/self-extend-floor.test.ts`.
- [ ] Docstring + README row + one `### Added`/`### Changed` CHANGELOG note updated for the new `selfExtendFloor.match` knob and the acting-model semantics.

## 3. Scope Boundary (NOT in scope)

- **Default behavior is unchanged.** With no `selfExtendFloor.match` set, matching stays substring — byte-identical to today. Inert-by-default (empty allowlist ⇒ no gating) is preserved in both modes.
- **No anchoring/word-boundary/regex matching.** Only the two discrete modes `substring` (default) and `exact`. A regex or glob mode is out (Simplicity First; not requested, larger surface).
- **No change to the capability scoping, kill switch, `parseAllowlist`, or the `beforeToolCall`/`risk-guard` mechanism.** Only the acting-model source and the match step change.
- **No new capability, no new command.** Config stays under the centralized `/config` facility (`selfExtendFloor.match`).
- **No kernel edits.** `src/kernel/*` untouched; `currentActingAgent` is an existing export (`agent.ts:76`).
- **Not touching the other deferred cycles** (playbook D2, test-comment D1) — separate cycles.

## 4. Key Design Decisions

### Decision 1 — D4 over-allow: opt-in `exact` mode vs. alternatives
- **Problem:** substring matching over-allows (`gpt-4` ⊃ `gpt-4o-mini`); the safety-conscious operator needs a way to get strict matching, without breaking the ergonomic default.
- **Options:** (a) add an opt-in `selfExtendFloor.match = substring (default) | exact`; (b) switch the default to anchored/word-boundary matching; (c) docs only (status quo).
- **Choice: (a).** A discrete opt-in `exact` mode leaves the default (substring) byte-identical — preserving the deliberate `opus`→`claude-opus-4-8` ergonomics and backward-compat — while giving a safety-conscious operator a one-config-key path to eliminate over-allow entirely by listing full ids. It is the minimal addition that closes the gap without a policy reversal.
- **Why (b) rejected:** Wave-2 *already* considered and rejected anchoring-by-default (it defeats the `opus`→full-id ergonomics and pressures operators toward brittle full-id lists — a stale-defaults risk); changing the default is also a behavior change for existing users. **Why (c) rejected:** the user asked to *finish* the deferred item; docs-only leaves the safety hole open.

### Decision 2 — D5 acting-model: `currentActingAgent() ?? e.agent`
- **Problem:** the floor must key on the model actually driving the `self:extend` call, which for a sub-agent is the sub-agent's model, not the root's.
- **Evidence (verbatim):** `currentActingAgent()` (`agent.ts:76`) returns `actingAgentStore.getStore()`, an `AsyncLocalStorage<Agent>` bound by `run()` (`actingAgentStore.run(this, …)`, `agent.ts:221`) — so during a sub-agent's `run()` it returns the sub-agent, and it is `undefined` outside any `run()`. `childScope()` shares the parent's gate filters (`beforeToolCall`) with children (per `hooks.ts` `SHARED_FILTER_POINTS` + CLAUDE.md "childScope() derives a governed bus … shares gate filters"), so this guard's hook *does* run for a sub-agent's tool calls.
- **Choice:** compute `const model = (currentActingAgent() ?? e.agent).model` once at the top of the gated path and use it for the match, the `reason`, and the `warn`. The `?? e.agent` fallback covers the (rare) case of the hook running outside any `run()` (e.g. a direct test invocation), preserving today's root-model behavior there.
- **Why this is correct and safe:** `risk-guard.ts:166` reads `e.agent.model` for its *classifier sub-call* (a different purpose); a competence **floor** genuinely wants the acting agent, which is exactly what CLAUDE.md says the `currentActingAgent()` seam is for ("so soft-guards act on the acting sub-agent"). It is a pure read of an existing kernel export — no kernel change, no new machinery.

### Decision 3 — `exact` semantics: equality against the lowercased allowlist
- **Problem:** define "exact" precisely.
- **Choice:** in `exact` mode, `modelAllowed` returns `true` iff `model.toLowerCase()` **equals** `p.toLowerCase()` for some `p` in `patterns` — i.e. lowercase **both** sides at match time, mirroring the substring branch's defensive `p.toLowerCase()` (`self-extend-floor.ts:54`), so a direct pure-helper call `modelAllowed("mock",["MOCK"],"exact")` is `true` (not just calls that pre-lowercased via `parseAllowlist`). Still case-insensitive (consistent with substring mode and D3), still inert on an empty allowlist. An unrecognized `selfExtendFloor.match` value falls back to `substring` (the documented default) rather than erroring — consistent with EAgent's tolerant config reads.
- **Trade-off direction of the fallback (acknowledged):** falling back to substring never loosens *below the default*, but it is not unqualified "fail-safe": an operator who opts into `exact` for strict matching and *typos the value* (`exsct`) silently gets the looser substring behavior — reopening the over-allow they meant to close — with no error, only the block-time `warn` as a signal. This is accepted (tolerant-config convention; the alternative — erroring on an unknown value — is a harsher failure mode for a mistyped knob), but it is a real trade-off, not a free lunch.
- **Why:** equality is the unambiguous strict counterpart to substring; case-insensitivity is kept so the two modes differ only in substring-vs-equality, not in case handling.

## 5. Dependencies and Assumptions

- **New import:** `currentActingAgent` from `../kernel/agent.js` (`agent.ts:76`, an existing export). No kernel edit.
- **Capability lookup stays on the root registry (deliberate).** Decision 2 changes only the *model* source to `currentActingAgent()`; the capability lookup stays `e.agent.tools.get(ctx.call.name)` (root). This is correct because a child's registry is a copy-subset of the root's (`childRegistryFrom`, `subagents.ts:470-477`) — any tool name the child can call also exists in the root registry with the same declared capabilities. So the `self:extend` scoping resolves correctly even during a sub-agent call; do NOT "fix" the lookup to `currentActingAgent()?.tools`.
- **Config:** `e.config.get("selfExtendFloor.match", "substring")` (new key; env alias `EAGENT_SELF_EXTEND_FLOOR_MATCH`); existing `selfExtendFloor.models` and `EAGENT_SELF_EXTEND_FLOOR=off` unchanged.
- **Assumption (verified):** `beforeToolCall` is a shared filter under `childScope()` so the guard runs for sub-agent tool calls; `currentActingAgent()` returns the sub-agent during its `run()`. Both confirmed in the Wave-2 design (`agent.ts:75-76,221`; `hooks.ts` shared-filter set).
- **Test harness:** `makeHarness()` (agent model `"mock"`), `host.use`, `agent.tools.register(defineTool({capabilities:["self:extend"]}))`, `agent.hooks.apply("beforeToolCall", …)`, `h.config.set` — all already used by `test/self-extend-floor.test.ts`. For the D5 test, a real nested `child.run()` whose scripted mock calls a `self:extend` probe (mirrors the Wave-3 AC-4 pattern) makes `currentActingAgent()` the child.

## 6. Relationship with Existing Designs

- Extends `docs/design/2026-07-09-self-extend-floor.md` (Wave 2) — this doc `Supersedes:` its three deferred items (D3/D4/D5); the Wave-2 doc's closure-block `Deferred` line is resolved by this cycle. Terminology (allowlist, substring/exact, acting model, inert-by-default) is consistent with it.
- Anchors: `risk-guard.ts` (the `beforeToolCall` guard + `e.agent.model` precedent), `agent.ts:76` (`currentActingAgent`), CLAUDE.md (capabilities vocabulary, the `currentActingAgent()` seam).

## 7. Acceptance Criteria (measurable, automatable — offline `node:test`)

Harness note: `makeHarness()` gives `agent.model === "mock"`; load via `host.use`; register a `self:extend` probe tool; drive `agent.hooks.apply("beforeToolCall", {block:false,arguments:{}}, {call})`.

1. **D3 end-to-end case-insensitivity:** `h.config.set("selfExtendFloor.models","MOCK")` (uppercase) → a `self:extend` probe call returns `block===false` (the acting model `"mock"` matches case-insensitively through the real guard + `LayeredConfig`, not just the pure helper).
2. **D4 exact mode blocks a substring collision:** pure-helper (the documented over-allow case) — `modelAllowed("gpt-4o-mini", ["gpt-4"], "substring") === true` (admitted — the hazard) AND `modelAllowed("gpt-4o-mini", ["gpt-4"], "exact") === false` (strictly refused). Integration — acting model `"mock"`, `models="moc"` (a proper substring of `"mock"`): `match` unset/`"substring"` → `block===false` (substring admits, since `"mock".includes("moc")`), whereas `match="exact"` → `block===true` (exact refuses because `"mock" !== "moc"`).
3. **D4 exact mode passes an exact id:** `modelAllowed("mock", ["mock"], "exact") === true`; and integration: `match="exact"`, `models="mock"` (equals the acting model) → `block===false`.
4. **D4 default unchanged:** `modelAllowed(m, patterns)` (no mode arg) behaves exactly as substring; with `selfExtendFloor.match` unset, the guard uses substring (an integration assertion that `models="mo"` passes model `"mock"` — substring — with no `match` configured).
5. **D4 unknown mode falls back to substring:** `e.config.get` returning `"weird"` → treated as substring (integration: `models="mo"`, `match="weird"`, model `"mock"` → `block===false`).
6. **D5 acting-model is the sub-agent's:** driving `beforeToolCall` from inside a real nested `child.run()` (the Wave-3 AC-4 pattern) whose agent has a model NOT on the floor, while the ROOT model IS on the floor, results in a BLOCK keyed on the child's model (and the symmetric case: root not on floor, child on floor → pass). Confirms `currentActingAgent()` (not `e.agent`) supplies the model. The existing Wave-2 regression assertions still pass.
7. **Inert preserved in exact mode:** empty allowlist + `match="exact"` → `block===false` (the `patterns.length === 0` inert early-return runs before the mode branch, in both modes).
8. **Regression:** the existing `test/self-extend-floor.test.ts` assertions (inert-by-default, kill switch, capability-scoping, unknown-tool, registration/observability) all still pass; `npm run typecheck` exits 0; `npm test` exits 0 (incl. `test/kernel-surface.test.ts` — no kernel growth). Test-file types verified separately.

## 8. Risks and Rollback

- **Risk: D5 changes the floored model for a legitimate sub-agent workflow** (a capable root spawns a weak-but-intended sub-agent that now gets blocked). This is the *intended* behavior of a floor (the acting model is what should be judged); mitigated by inert-by-default (only bites when an allowlist is configured) and the block-time `warn`. Documented as the corrected semantics, not a regression.
- **Risk: `currentActingAgent()` is `undefined` in some call path** → the `?? e.agent` fallback preserves today's root-model behavior; no throw.
- **Risk: new `match` config misread** → any non-`"exact"` value falls back to substring (the safe default); `exact` only ever *tightens*, never loosens, so a misconfiguration cannot admit more than substring would.
- **Risk: kernel-ceiling / surface regression** → no `src/kernel/*` edits; AC 7 runs `test/kernel-surface.test.ts`.
- **Rollback:** runtime — unset `selfExtendFloor.match` (reverts to substring) / `EAGENT_SELF_EXTEND_FLOOR=off`. Permanent — revert the commit; the acting-model read and the `mode` param are additive and self-contained.
